//! Typed wire payloads; the ordered JSON input and transport stay independent.

use super::server::{CodeAction, DocLocation, FileEdit, LspRange, TextEdit};
use super::transport::{self as t, Json};
use lsp_types as lsp;
use serde::{Serialize, Serializer, ser::SerializeMap};
use serde_json::value::RawValue;

/// The ID alone uses the admitted raw JSON representation, so exponent and
/// negative-zero spellings survive. Payloads serialize directly from DTOs.
pub(super) fn response<T: Serialize>(id: &Json, result: T) -> String {
    #[derive(Serialize)]
    struct Response<'a, T> {
        jsonrpc: &'static str,
        id: &'a RawValue,
        result: T,
    }
    let id = RawValue::from_string(t::render(id)).expect("admitted JSON-RPC ID must be JSON");
    compact(&Response {
        jsonrpc: "2.0",
        id: &id,
        result,
    })
}

pub(super) fn notification<T: Serialize>(method: &str, params: T) -> String {
    #[derive(Serialize)]
    struct Notification<'a, T> {
        jsonrpc: &'static str,
        method: &'a str,
        params: T,
    }
    compact(&Notification {
        jsonrpc: "2.0",
        method,
        params,
    })
}

fn compact<T: Serialize>(value: &T) -> String {
    crate::json::to_compact_string(value).expect("closed LSP DTO must serialize")
}

pub(super) fn range(range: LspRange) -> lsp::Range {
    lsp::Range::new(
        lsp::Position::new(range.start.line, range.start.character),
        lsp::Position::new(range.end.line, range.end.character),
    )
}

/// Project URI-bearing envelopes with the server's authored String identity;
/// library types own the remaining fields without restricting URI admission.
#[derive(Serialize)]
pub(super) struct Location {
    uri: String,
    range: lsp::Range,
}

pub(super) fn location(location: DocLocation) -> Location {
    Location {
        uri: location.uri,
        range: range(location.range),
    }
}

#[derive(Serialize)]
pub(super) struct Diagnostics {
    uri: String,
    diagnostics: Vec<lsp::Diagnostic>,
    version: Option<i32>,
}

pub(super) fn diagnostics(
    uri: &str,
    version: i32,
    diagnostics: Vec<lsp::Diagnostic>,
) -> Diagnostics {
    Diagnostics {
        uri: uri.to_string(),
        diagnostics,
        version: Some(version),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentEdit {
    text_document: DocumentIdentifier,
    edits: Vec<lsp::TextEdit>,
}

#[derive(Serialize)]
struct DocumentIdentifier {
    uri: String,
    // This field is required; None deliberately serializes as null.
    version: Option<i32>,
}

#[derive(Serialize)]
#[serde(transparent)]
pub(super) struct WorkspaceEdit(WorkspaceEditWire);

#[derive(Serialize)]
#[serde(untagged)]
enum WorkspaceEditWire {
    #[serde(rename_all = "camelCase")]
    Versioned {
        document_changes: Vec<DocumentEdit>,
    },
    Plain {
        changes: Changes,
    },
}

// Object member order follows first URI occurrence, just as documentChanges.
// URI keys retain their authored String identity rather than URL normalization.
struct Changes(Vec<(String, Vec<lsp::TextEdit>)>);

impl Serialize for Changes {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (uri, edits) in &self.0 {
            map.serialize_entry(uri, edits)?;
        }
        map.end()
    }
}

fn workspace_edit(
    groups: Vec<(String, Option<i32>, Vec<lsp::TextEdit>)>,
    document_changes: bool,
) -> WorkspaceEdit {
    WorkspaceEdit(if document_changes {
        WorkspaceEditWire::Versioned {
            document_changes: groups
                .into_iter()
                .map(|(uri, version, edits)| DocumentEdit {
                    text_document: DocumentIdentifier { uri, version },
                    edits,
                })
                .collect(),
        }
    } else {
        WorkspaceEditWire::Plain {
            changes: Changes(
                groups
                    .into_iter()
                    .map(|(uri, _, edits)| (uri, edits))
                    .collect(),
            ),
        }
    })
}

pub(super) fn rename(
    uri: String,
    version: i32,
    edits: Vec<TextEdit>,
    document_changes: bool,
) -> WorkspaceEdit {
    workspace_edit(
        vec![(
            uri,
            Some(version),
            edits
                .into_iter()
                .map(|edit| lsp::TextEdit {
                    range: range(edit.range),
                    new_text: edit.new_text,
                })
                .collect(),
        )],
        document_changes,
    )
}

#[derive(Serialize)]
pub(super) struct Action {
    #[serde(flatten)]
    action: lsp::CodeAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    edit: Option<WorkspaceEdit>,
}

pub(super) fn action(
    action: CodeAction,
    version: impl Fn(&str) -> Option<i32>,
    document_changes: bool,
) -> Action {
    let typed = lsp::CodeAction {
        title: action.title,
        kind: Some(lsp::CodeActionKind::from(action.kind)),
        ..Default::default()
    };
    if action.edits.is_empty() {
        return Action {
            action: typed,
            edit: None,
        };
    }
    let mut by_uri: Vec<(String, Vec<FileEdit>)> = Vec::new();
    for edit in action.edits {
        match by_uri.iter_mut().find(|(uri, _)| *uri == edit.uri) {
            Some((_, edits)) => edits.push(edit),
            None => by_uri.push((edit.uri.clone(), vec![edit])),
        }
    }
    let groups = by_uri
        .into_iter()
        .map(|(uri, edits)| {
            let current = version(&uri);
            let edits = edits
                .into_iter()
                .map(|edit| lsp::TextEdit {
                    range: range(edit.range),
                    new_text: edit.new_text,
                })
                .collect();
            (uri, current, edits)
        })
        .collect();
    Action {
        action: typed,
        edit: Some(workspace_edit(groups, document_changes)),
    }
}

/// Keep the public backend's complete raw vector, including any incomplete
/// final quintuple; the standard DTO would require reshaping that contract.
#[derive(Serialize)]
pub(super) struct SemanticTokens {
    pub data: Vec<u32>,
}

#[cfg(test)]
mod tests {
    use super::super::server::TextPos;
    use super::*;

    fn sample_range() -> LspRange {
        LspRange {
            start: TextPos {
                line: 1,
                character: 2,
            },
            end: TextPos {
                line: 3,
                character: 4,
            },
        }
    }

    #[test]
    fn uri_outputs_keep_original_spelling_on_both_paths() {
        for uri in [
            "FILE:///a%2fb.can",
            "untitled:1",
            "file:///é😀.can",
            "file:///100%.can",
            "",
            "/a.can",
        ] {
            let location = location(DocLocation {
                uri: uri.to_string(),
                range: sample_range(),
            });
            let wire = compact(&location);
            let value = t::parse(&wire).unwrap();
            assert_eq!(value.get("uri").and_then(Json::as_str), Some(uri));
            assert!(
                wire.ends_with(
                    r#""range":{"start":{"line":1,"character":2},"end":{"line":3,"character":4}}}"#
                ),
                "{wire}"
            );
            let wire = compact(&diagnostics(uri, 7, Vec::new()));
            let value = t::parse(&wire).unwrap();
            assert_eq!(value.get("uri").and_then(Json::as_str), Some(uri));
            assert_eq!(value.get("version"), Some(&Json::Num("7".to_string())));
        }
    }

    #[test]
    fn action_groups_keep_versions_order_and_optional_edits() {
        for last_uri in ["file:///closed.can", "file:///é😀%.can"] {
            let action = action(
                CodeAction {
                    title: "fix".to_string(),
                    kind: "quickfix".to_string(),
                    edits: vec![
                        FileEdit {
                            uri: "file:///b.can".to_string(),
                            range: sample_range(),
                            new_text: "first".to_string(),
                        },
                        FileEdit {
                            uri: last_uri.to_string(),
                            range: sample_range(),
                            new_text: "second".to_string(),
                        },
                        FileEdit {
                            uri: "file:///b.can".to_string(),
                            range: sample_range(),
                            new_text: "third".to_string(),
                        },
                    ],
                },
                |uri| (uri == "file:///b.can").then_some(19),
                true,
            );
            let wire = compact(&action);
            let value = t::parse(&wire).unwrap();
            let changes = value
                .get("edit")
                .unwrap()
                .get("documentChanges")
                .unwrap()
                .as_arr()
                .unwrap();
            assert_eq!(changes.len(), 2);
            assert_eq!(
                changes[0].get("textDocument").unwrap().get("version"),
                Some(&Json::Num("19".to_string()))
            );
            assert_eq!(
                changes[1].get("textDocument").unwrap().get("version"),
                Some(&Json::Null)
            );
            assert_eq!(
                changes[1]
                    .get("textDocument")
                    .unwrap()
                    .get("uri")
                    .and_then(Json::as_str),
                Some(last_uri)
            );
            let edits = changes[0].get("edits").unwrap().as_arr().unwrap();
            assert_eq!(
                edits[0].get("newText").and_then(Json::as_str),
                Some("first")
            );
            assert_eq!(
                edits[1].get("newText").and_then(Json::as_str),
                Some("third")
            );
        }
        let wire = compact(&action(
            CodeAction {
                title: "no edits".to_string(),
                kind: "custom".to_string(),
                edits: Vec::new(),
            },
            |_| None,
            true,
        ));
        assert_eq!(wire, r#"{"title":"no edits","kind":"custom"}"#);
        let wire = compact(&rename("file:///a.can".to_string(), -4, Vec::new(), true));
        assert_eq!(
            wire,
            r#"{"documentChanges":[{"textDocument":{"uri":"file:///a.can","version":-4},"edits":[]}]}"#
        );
    }

    #[test]
    fn plain_edit_keeps_authored_uri_and_group_order() {
        let first = "file:///z%2fé😀.can";
        let second = "file:///a%2F.can";
        let edit = workspace_edit(
            vec![
                (
                    first.to_string(),
                    Some(3),
                    vec![lsp::TextEdit {
                        range: range(sample_range()),
                        new_text: "first".to_string(),
                    }],
                ),
                (
                    second.to_string(),
                    None,
                    vec![lsp::TextEdit {
                        range: range(sample_range()),
                        new_text: "second".to_string(),
                    }],
                ),
            ],
            false,
        );
        let wire = compact(&edit);
        assert!(
            wire.starts_with(r#"{"changes":{"file:///z%2fé😀.can":"#),
            "{wire}"
        );
        assert!(wire.find(first).unwrap() < wire.find(second).unwrap());
        let parsed = t::parse(&wire).unwrap();
        assert!(parsed.get("documentChanges").is_none());
        for (uri, text) in [(first, "first"), (second, "second")] {
            let edits = parsed
                .get("changes")
                .unwrap()
                .get(uri)
                .unwrap()
                .as_arr()
                .unwrap();
            assert_eq!(edits.len(), 1);
            assert_eq!(edits[0].get("newText").and_then(Json::as_str), Some(text));
        }
    }

    #[test]
    fn typed_envelope_keeps_id_and_all_control_escapes() {
        let controls: String = (0u8..32).map(char::from).collect();
        let item = lsp::CompletionItem {
            label: format!("{controls}é😀\\\""),
            ..Default::default()
        };
        for spelling in ["-0", "1e0", "2.147483647e9"] {
            let id = Json::Num(spelling.to_string());
            let wire = response(&id, vec![item.clone()]);
            assert!(
                wire.starts_with(&format!(
                    r#"{{"jsonrpc":"2.0","id":{spelling},"result":[{{"label":""#
                )),
                "{wire}"
            );
            assert!(wire.contains(r"\u0008"), "{wire}");
            assert!(wire.contains(r"\u000c"), "{wire}");
            let value = t::parse(&wire).unwrap();
            assert_eq!(
                value.get("result").unwrap().as_arr().unwrap()[0]
                    .get("label")
                    .and_then(Json::as_str),
                Some(item.label.as_str())
            );
        }
        assert_eq!(
            response(
                &Json::Num("1".to_string()),
                SemanticTokens {
                    data: vec![1, 2, 3]
                }
            ),
            r#"{"jsonrpc":"2.0","id":1,"result":{"data":[1,2,3]}}"#
        );
    }
}
