//! Typed wire payloads; the ordered JSON input and transport stay independent.

use super::server::{CodeAction, DocLocation, FileEdit, LspRange};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<i32>,
}

pub(super) fn diagnostics_version(
    uri: &str,
    version: Option<i32>,
    diagnostics: Vec<lsp::Diagnostic>,
) -> Diagnostics {
    Diagnostics {
        uri: uri.to_string(),
        diagnostics,
        version,
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

/// File-qualified renames retain the live version of every affected buffer.
pub(super) fn rename_files(
    edits: Vec<FileEdit>,
    version: impl Fn(&str) -> Option<i32>,
    document_changes: bool,
) -> WorkspaceEdit {
    let mut groups: Vec<(String, Option<i32>, Vec<lsp::TextEdit>)> = Vec::new();
    for edit in edits {
        let wire = lsp::TextEdit {
            range: range(edit.range),
            new_text: edit.new_text,
        };
        if let Some((_, _, group)) = groups.iter_mut().find(|(uri, _, _)| uri == &edit.uri) {
            group.push(wire);
        } else {
            let current = version(&edit.uri);
            groups.push((edit.uri, current, vec![wire]));
        }
    }
    workspace_edit(groups, document_changes)
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
