//! LSP server over the stdio [`transport`](crate::lsp::transport).
//!
//! Handles `initialize`/`initialized`/`shutdown`/`exit`, document sync with
//! version tracking, and `hover`/`completion`/`definition`/`references`/
//! `rename`/`semanticTokens`/`codeAction` driven by the [`LanguageAnalysis`]
//! trait. Depends only on transport plus the shared `diagnostic` and
//! `source` types: it never touches syntax or analysis internals, so the
//! sibling syntax agent's future CST API slots in behind the trait.
//!
//! Version/staleness contract: `didOpen`/`didChange` enqueue one analysis
//! task per document version; [`Server::pump`] publishes diagnostics only
//! for the task whose version still matches the open document and silently
//! cancels stale ones. Diagnostics are therefore never published for an
//! outdated buffer, and never for a closed one.
//!
//! Slice-2a status: [`StubAnalysis`] implements the trait with empty
//! results. All positions use UTF-16 encoding; only full-text sync is
//! honored (incremental `range` edits are ignored and documented).

use crate::diagnostic::{Diagnostic, Severity};
use crate::lsp::transport as t;
use crate::lsp::transport::Json;
use crate::source::{LineIndex, SourceDb, SourceId};
use std::collections::{HashMap, VecDeque};

/// 0-based LSP position (UTF-16 code units).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextPos {
    /// 0-based line.
    pub line: u32,
    /// Character offset in UTF-16 code units.
    pub character: u32,
}

/// 0-based LSP range (UTF-16 code units).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LspRange {
    /// Range start.
    pub start: TextPos,
    /// Range end.
    pub end: TextPos,
}

/// One completion item returned by analysis.
#[derive(Debug, Clone)]
pub struct CompletionItem {
    /// Label shown in the completion list.
    pub label: String,
    /// Optional LSP `CompletionItemKind` name, e.g. `Field`. Serialized
    /// as the spec's integer enum (`completion_kind_number`); unknown
    /// names are omitted from the wire (the member is optional).
    pub kind: Option<String>,
}

/// Map an LSP `CompletionItemKind` name to its integer code (LSP 3.17,
/// `Text`=1 through `TypeParameter`=25). Unknown names map to `None`
/// and are omitted from the response, keeping the serializer path
/// protocol-valid once a real backend returns items.
fn completion_kind_number(name: &str) -> Option<u32> {
    Some(match name {
        "Text" => 1,
        "Method" => 2,
        "Function" => 3,
        "Constructor" => 4,
        "Field" => 5,
        "Variable" => 6,
        "Class" => 7,
        "Interface" => 8,
        "Module" => 9,
        "Property" => 10,
        "Unit" => 11,
        "Value" => 12,
        "Enum" => 13,
        "Keyword" => 14,
        "Snippet" => 15,
        "Color" => 16,
        "File" => 17,
        "Reference" => 18,
        "Folder" => 19,
        "EnumMember" => 20,
        "Constant" => 21,
        "Struct" => 22,
        "Event" => 23,
        "Operator" => 24,
        "TypeParameter" => 25,
        _ => return None,
    })
}

/// A location in a (possibly other) document.
#[derive(Debug, Clone)]
pub struct DocLocation {
    /// Document URI the range belongs to.
    pub uri: String,
    /// Range inside that document.
    pub range: LspRange,
}

/// One rename/text edit.
#[derive(Debug, Clone)]
pub struct TextEdit {
    /// Range to replace.
    pub range: LspRange,
    /// Replacement text.
    pub new_text: String,
}

/// One code action returned by analysis.
#[derive(Debug, Clone)]
pub struct CodeAction {
    /// Human title, e.g. `Fix indentation`.
    pub title: String,
    /// LSP kind, e.g. `quickfix`.
    pub kind: String,
}

/// Language callbacks behind every LSP data request.
///
/// Each method receives the shared [`SourceDb`] plus the [`SourceId`] of the
/// current document text, so future real implementations can run syntax and
/// analysis without the server knowing their types. Positions are UTF-16.
pub trait LanguageAnalysis {
    /// Full-document diagnostics for the current text.
    fn diagnostics(&self, db: &SourceDb, id: SourceId) -> Vec<Diagnostic>;
    /// Hover markdown for a position, if any.
    fn hover(&self, db: &SourceDb, id: SourceId, pos: TextPos) -> Option<String>;
    /// Completion items for a position.
    fn completions(&self, db: &SourceDb, id: SourceId, pos: TextPos) -> Vec<CompletionItem>;
    /// Go-to-definition targets for a position.
    fn definition(&self, db: &SourceDb, id: SourceId, pos: TextPos) -> Vec<DocLocation>;
    /// Reference locations for a position.
    fn references(&self, db: &SourceDb, id: SourceId, pos: TextPos) -> Vec<DocLocation>;
    /// Rename edits for a position and new name.
    fn rename(&self, db: &SourceDb, id: SourceId, pos: TextPos, new_name: &str) -> Vec<TextEdit>;
    /// Raw semantic-token data array (`[line, col, len, type, mods, ...]`).
    fn semantic_tokens(&self, db: &SourceDb, id: SourceId) -> Vec<u32>;
    /// Code actions for a range.
    fn code_actions(&self, db: &SourceDb, id: SourceId, range: LspRange) -> Vec<CodeAction>;
}

/// Slice-2a analysis: empty results, documented as unimplemented.
///
/// Every method returns "no data" (empty vec / `None`); real analysis lands
/// in later slices. The server treats these as legitimate empty answers,
/// never as errors.
#[derive(Debug, Default)]
pub struct StubAnalysis;

impl LanguageAnalysis for StubAnalysis {
    fn diagnostics(&self, _db: &SourceDb, _id: SourceId) -> Vec<Diagnostic> {
        Vec::new()
    }
    fn hover(&self, _db: &SourceDb, _id: SourceId, _pos: TextPos) -> Option<String> {
        None
    }
    fn completions(&self, _db: &SourceDb, _id: SourceId, _pos: TextPos) -> Vec<CompletionItem> {
        Vec::new()
    }
    fn definition(&self, _db: &SourceDb, _id: SourceId, _pos: TextPos) -> Vec<DocLocation> {
        Vec::new()
    }
    fn references(&self, _db: &SourceDb, _id: SourceId, _pos: TextPos) -> Vec<DocLocation> {
        Vec::new()
    }
    fn rename(
        &self,
        _db: &SourceDb,
        _id: SourceId,
        _pos: TextPos,
        _new_name: &str,
    ) -> Vec<TextEdit> {
        Vec::new()
    }
    fn semantic_tokens(&self, _db: &SourceDb, _id: SourceId) -> Vec<u32> {
        Vec::new()
    }
    fn code_actions(&self, _db: &SourceDb, _id: SourceId, _range: LspRange) -> Vec<CodeAction> {
        Vec::new()
    }
}

#[derive(Debug, Clone)]
struct OpenDoc {
    version: i32,
    text: String,
    id: SourceId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lifecycle {
    PreInit,
    Ready,
    Shutdown,
}

/// Stateful LSP session parameterized over its analysis backend.
pub struct Server<A: LanguageAnalysis> {
    analysis: A,
    db: SourceDb,
    docs: HashMap<String, OpenDoc>,
    pending: VecDeque<(String, i32)>,
    lifecycle: Lifecycle,
    exited: bool,
    exit_code: i32,
}

impl<A: LanguageAnalysis> Server<A> {
    /// Create a session with the given analysis backend.
    pub fn new(analysis: A) -> Self {
        Self {
            analysis,
            db: SourceDb::new(),
            docs: HashMap::new(),
            pending: VecDeque::new(),
            lifecycle: Lifecycle::PreInit,
            exited: false,
            exit_code: 0,
        }
    }

    /// Whether `exit` has been received (the stdio loop must stop).
    pub fn exited(&self) -> bool {
        self.exited
    }

    /// Exit code selected by the `shutdown`/`exit` sequence.
    pub fn exit_code(&self) -> i32 {
        self.exit_code
    }

    /// Number of document versions awaiting [`Server::pump`].
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    /// Handle one parsed message body, returning raw JSON response and
    /// notification bodies to send. Diagnostics for document sync are not
    /// returned here; drain them with [`Server::pump`].
    pub fn handle_json(&mut self, message: &Json) -> Vec<String> {
        let Some(call) = t::parse_call(message) else {
            // Not a call at all; only answer if an id is present to echo.
            if let Some(id) = message.get("id") {
                return vec![t::response_err(
                    Some(id),
                    t::error_code::INVALID_REQUEST,
                    "not a JSON-RPC call",
                )];
            }
            return Vec::new();
        };
        match call.id {
            Some(id) => self.handle_request(&id, &call.method, &call.params),
            None => {
                self.handle_notification(&call.method, &call.params);
                Vec::new()
            }
        }
    }

    /// Publish diagnostics for every enqueued document version that is still
    /// current. Stale versions (superseded by a newer change, or closed)
    /// are cancelled: no notification is emitted for them, ever.
    pub fn pump(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        while let Some((uri, version)) = self.pending.pop_front() {
            let current = self.docs.get(&uri).filter(|doc| doc.version == version);
            let Some(doc) = current else {
                continue; // Stale or closed: cancelled.
            };
            let diagnostics = self.analysis.diagnostics(&self.db, doc.id);
            out.push(publish_diagnostics(&uri, version, &doc.text, &diagnostics));
        }
        out
    }

    fn handle_request(&mut self, id: &Json, method: &str, params: &Json) -> Vec<String> {
        if method == "initialize" {
            return match self.lifecycle {
                Lifecycle::PreInit => {
                    self.lifecycle = Lifecycle::Ready;
                    vec![t::response_ok(id, capabilities())]
                }
                _ => vec![t::response_err(
                    Some(id),
                    t::error_code::INVALID_REQUEST,
                    "already initialized",
                )],
            };
        }
        if self.lifecycle == Lifecycle::PreInit {
            return vec![t::response_err(
                Some(id),
                t::error_code::SERVER_NOT_INITIALIZED,
                "initialize first",
            )];
        }
        if self.lifecycle == Lifecycle::Shutdown {
            return vec![t::response_err(
                Some(id),
                t::error_code::INVALID_REQUEST,
                "server is shut down",
            )];
        }
        let response = match method {
            "shutdown" => {
                self.lifecycle = Lifecycle::Shutdown;
                t::response_ok(id, Json::Null)
            }
            "textDocument/hover" => self.with_pos(params, id, |server, doc_id, pos| {
                let markdown = server.analysis.hover(&server.db, doc_id, pos);
                match markdown {
                    Some(text) => Json::Obj(vec![(
                        "contents".to_string(),
                        Json::Obj(vec![
                            ("kind".to_string(), Json::Str("markdown".to_string())),
                            ("value".to_string(), Json::Str(text)),
                        ]),
                    )]),
                    None => Json::Null,
                }
            }),
            "textDocument/completion" => self.with_pos(params, id, |server, doc_id, pos| {
                let items: Vec<Json> = server
                    .analysis
                    .completions(&server.db, doc_id, pos)
                    .into_iter()
                    .map(|item| {
                        let mut members = vec![("label".to_string(), Json::Str(item.label))];
                        if let Some(number) = item.kind.as_deref().and_then(completion_kind_number)
                        {
                            members.push(("kind".to_string(), Json::Num(number.to_string())));
                        }
                        Json::Obj(members)
                    })
                    .collect();
                Json::Arr(items)
            }),
            "textDocument/definition" => self.with_pos(params, id, |server, doc_id, pos| {
                Json::Arr(
                    server
                        .analysis
                        .definition(&server.db, doc_id, pos)
                        .into_iter()
                        .map(location_json)
                        .collect(),
                )
            }),
            "textDocument/references" => self.with_pos(params, id, |server, doc_id, pos| {
                Json::Arr(
                    server
                        .analysis
                        .references(&server.db, doc_id, pos)
                        .into_iter()
                        .map(location_json)
                        .collect(),
                )
            }),
            "textDocument/rename" => {
                let rename = parse_pos_request(params).and_then(|(_, pos)| {
                    params
                        .get("newName")
                        .and_then(Json::as_str)
                        .map(|name| (pos, name.to_string()))
                });
                match rename.and_then(|(pos, name)| {
                    doc_of(params).and_then(|uri| self.doc_id(&uri).map(|doc| (doc, pos, name)))
                }) {
                    Some((doc_id, pos, name)) => {
                        let edits: Vec<Json> = self
                            .analysis
                            .rename(&self.db, doc_id, pos, &name)
                            .into_iter()
                            .map(|edit| {
                                Json::Obj(vec![
                                    ("range".to_string(), range_json(edit.range)),
                                    ("newText".to_string(), Json::Str(edit.new_text)),
                                ])
                            })
                            .collect();
                        // LSP WorkspaceEdit with documentChanges for the one file.
                        t::response_ok(
                            id,
                            Json::Obj(vec![(
                                "documentChanges".to_string(),
                                Json::Arr(vec![Json::Obj(vec![
                                    (
                                        "textDocument".to_string(),
                                        Json::Obj(vec![(
                                            "uri".to_string(),
                                            Json::Str(doc_of(params).unwrap_or_default()),
                                        )]),
                                    ),
                                    ("edits".to_string(), Json::Arr(edits)),
                                ])]),
                            )]),
                        )
                    }
                    None => t::response_ok(id, Json::Null),
                }
            }
            "textDocument/semanticTokens/full" => {
                match doc_of(params).and_then(|uri| self.doc_id(&uri)) {
                    Some(doc_id) => {
                        let data: Vec<Json> = self
                            .analysis
                            .semantic_tokens(&self.db, doc_id)
                            .into_iter()
                            .map(|n| Json::Num(n.to_string()))
                            .collect();
                        t::response_ok(id, Json::Obj(vec![("data".to_string(), Json::Arr(data))]))
                    }
                    None => {
                        t::response_err(Some(id), t::error_code::INVALID_PARAMS, "unknown document")
                    }
                }
            }
            "textDocument/codeAction" => {
                match doc_of(params).and_then(|uri| {
                    let doc_id = self.doc_id(&uri)?;
                    let range = params.get("range").and_then(parse_range)?;
                    Some((doc_id, range))
                }) {
                    Some((doc_id, range)) => {
                        let actions: Vec<Json> = self
                            .analysis
                            .code_actions(&self.db, doc_id, range)
                            .into_iter()
                            .map(|action| {
                                Json::Obj(vec![
                                    ("title".to_string(), Json::Str(action.title)),
                                    ("kind".to_string(), Json::Str(action.kind)),
                                ])
                            })
                            .collect();
                        t::response_ok(id, Json::Arr(actions))
                    }
                    None => t::response_err(
                        Some(id),
                        t::error_code::INVALID_PARAMS,
                        "unknown document or bad range",
                    ),
                }
            }
            _ => t::response_err(
                Some(id),
                t::error_code::METHOD_NOT_FOUND,
                &format!("unknown method '{method}'"),
            ),
        };
        vec![response]
    }

    /// Run a position-request callback, answering `null`/`[]`-style empty
    /// results via the callback when the document is unknown.
    fn with_pos(
        &mut self,
        params: &Json,
        id: &Json,
        produce: impl FnOnce(&Self, SourceId, TextPos) -> Json,
    ) -> String {
        match parse_pos_request(params).and_then(|(uri, pos)| self.doc_id(&uri).map(|d| (d, pos))) {
            Some((doc_id, pos)) => t::response_ok(id, produce(self, doc_id, pos)),
            None => t::response_err(
                Some(id),
                t::error_code::INVALID_PARAMS,
                "unknown document or bad position",
            ),
        }
    }

    fn doc_id(&self, uri: &str) -> Option<SourceId> {
        self.docs.get(uri).map(|doc| doc.id)
    }

    fn handle_notification(&mut self, method: &str, params: &Json) {
        match method {
            "initialized" => {}
            // `$/cancelRequest` is a no-op by design: every request is
            // answered synchronously, so nothing is ever in flight to cancel.
            "$/cancelRequest" => {}
            "exit" => {
                self.exited = true;
                self.exit_code = if self.lifecycle == Lifecycle::Shutdown {
                    0
                } else {
                    1
                };
            }
            "textDocument/didOpen" => {
                let Some(doc) = params.get("textDocument") else {
                    return;
                };
                let (Some(uri), version, Some(text)) = (
                    doc.get("uri").and_then(Json::as_str),
                    doc.get("version").and_then(Json::as_i64).unwrap_or(0),
                    doc.get("text").and_then(Json::as_str),
                ) else {
                    return;
                };
                // No-op open (same text already tracked): reuse the live
                // SourceId instead of appending a duplicate snapshot.
                // Residual: SourceDb is append-only, so every *distinct*
                // version still retains a snapshot; true compaction needs
                // a compaction API in a later slice.
                let id = match self.docs.get(uri) {
                    Some(open) if open.text == text => open.id,
                    _ => self.db.add(uri_to_path(uri), text.to_string()),
                };
                let version = version.clamp(i32::MIN as i64, i32::MAX as i64) as i32;
                self.docs.insert(
                    uri.to_string(),
                    OpenDoc {
                        version,
                        text: text.to_string(),
                        id,
                    },
                );
                self.pending.push_back((uri.to_string(), version));
            }
            "textDocument/didChange" => {
                let (Some(selector), version) = (
                    params.get("textDocument"),
                    params
                        .get("textDocument")
                        .and_then(|d| d.get("version"))
                        .and_then(Json::as_i64),
                ) else {
                    return;
                };
                let Some(uri) = selector.get("uri").and_then(Json::as_str) else {
                    return;
                };
                let Some(open) = self.docs.get(uri) else {
                    return;
                };
                // Full-text sync only: last change without a `range` wins.
                // Incremental edits are ignored (documented limitation).
                let mut full: Option<&str> = None;
                if let Some(changes) = params.get("contentChanges").and_then(Json::as_arr) {
                    for change in changes {
                        if change.get("range").is_none()
                            && let Some(text) = change.get("text").and_then(Json::as_str)
                        {
                            full = Some(text);
                        }
                    }
                }
                let Some(full) = full else {
                    return;
                };
                let version = version
                    .unwrap_or(open.version as i64 + 1)
                    .clamp(i32::MIN as i64, i32::MAX as i64) as i32;
                // No-op change (identical text): reuse the live SourceId so
                // a keystroke that nets no new text never grows the
                // append-only SourceDb. Versions still advance and the new
                // version is still published; only the snapshot is shared.
                // Residual: distinct versions still accumulate until a
                // SourceDb compaction API lands in a later slice.
                let id = if full == open.text {
                    open.id
                } else {
                    self.db.add(uri_to_path(uri), full.to_string())
                };
                self.docs.insert(
                    uri.to_string(),
                    OpenDoc {
                        version,
                        text: full.to_string(),
                        id,
                    },
                );
                self.pending.push_back((uri.to_string(), version));
            }
            "textDocument/didClose" => {
                if let Some(uri) = params
                    .get("textDocument")
                    .and_then(|d| d.get("uri"))
                    .and_then(Json::as_str)
                {
                    self.docs.remove(uri);
                    // Pending tasks for it go stale and are cancelled in pump.
                }
            }
            _ => {}
        }
    }
}

fn capabilities() -> Json {
    Json::Obj(vec![
        (
            "capabilities".to_string(),
            Json::Obj(vec![
                (
                    "positionEncoding".to_string(),
                    Json::Str("utf-16".to_string()),
                ),
                ("textDocumentSync".to_string(), Json::Num("1".to_string())),
                ("hoverProvider".to_string(), Json::Bool(true)),
                ("completionProvider".to_string(), Json::Obj(vec![])),
                ("definitionProvider".to_string(), Json::Bool(true)),
                ("referencesProvider".to_string(), Json::Bool(true)),
                ("renameProvider".to_string(), Json::Bool(true)),
                (
                    "semanticTokensProvider".to_string(),
                    Json::Obj(vec![
                        (
                            "legend".to_string(),
                            Json::Obj(vec![
                                ("tokenTypes".to_string(), Json::Arr(vec![])),
                                ("tokenModifiers".to_string(), Json::Arr(vec![])),
                            ]),
                        ),
                        ("full".to_string(), Json::Bool(true)),
                    ]),
                ),
                ("codeActionProvider".to_string(), Json::Bool(true)),
            ]),
        ),
        (
            "serverInfo".to_string(),
            Json::Obj(vec![
                ("name".to_string(), Json::Str("can".to_string())),
                (
                    "version".to_string(),
                    Json::Str(env!("CARGO_PKG_VERSION").to_string()),
                ),
            ]),
        ),
    ])
}

fn publish_diagnostics(uri: &str, version: i32, text: &str, diagnostics: &[Diagnostic]) -> String {
    let index = LineIndex::new(text);
    let items: Vec<Json> = diagnostics
        .iter()
        .map(|d| {
            let (start_line, start_char) = index.to_lsp(text, d.primary.start, true);
            let (end_line, end_char) = index.to_lsp(text, d.primary.end, true);
            Json::Obj(vec![
                (
                    "range".to_string(),
                    Json::Obj(vec![
                        (
                            "start".to_string(),
                            Json::Obj(vec![
                                ("line".to_string(), Json::Num(start_line.to_string())),
                                ("character".to_string(), Json::Num(start_char.to_string())),
                            ]),
                        ),
                        (
                            "end".to_string(),
                            Json::Obj(vec![
                                ("line".to_string(), Json::Num(end_line.to_string())),
                                ("character".to_string(), Json::Num(end_char.to_string())),
                            ]),
                        ),
                    ]),
                ),
                (
                    "severity".to_string(),
                    Json::Num(severity_number(d.severity).to_string()),
                ),
                ("code".to_string(), Json::Str(d.code.to_string())),
                ("source".to_string(), Json::Str("can".to_string())),
                ("message".to_string(), Json::Str(d.message.clone())),
            ])
        })
        .collect();
    t::notification(
        "textDocument/publishDiagnostics",
        Json::Obj(vec![
            ("uri".to_string(), Json::Str(uri.to_string())),
            ("version".to_string(), Json::Num(version.to_string())),
            ("diagnostics".to_string(), Json::Arr(items)),
        ]),
    )
}

fn severity_number(severity: Severity) -> u32 {
    match severity {
        Severity::Error => 1,
        Severity::Warning => 2,
        Severity::Info => 3,
    }
}

fn range_json(range: LspRange) -> Json {
    Json::Obj(vec![
        (
            "start".to_string(),
            Json::Obj(vec![
                ("line".to_string(), Json::Num(range.start.line.to_string())),
                (
                    "character".to_string(),
                    Json::Num(range.start.character.to_string()),
                ),
            ]),
        ),
        (
            "end".to_string(),
            Json::Obj(vec![
                ("line".to_string(), Json::Num(range.end.line.to_string())),
                (
                    "character".to_string(),
                    Json::Num(range.end.character.to_string()),
                ),
            ]),
        ),
    ])
}

fn location_json(location: DocLocation) -> Json {
    Json::Obj(vec![
        ("uri".to_string(), Json::Str(location.uri)),
        ("range".to_string(), range_json(location.range)),
    ])
}

fn doc_of(params: &Json) -> Option<String> {
    params
        .get("textDocument")
        .and_then(|d| d.get("uri"))
        .and_then(Json::as_str)
        .map(str::to_string)
}

/// Narrow one wire coordinate to `u32`, rejecting negatives and
/// over-`u32::MAX` values (which a bare `as u32` would wrap) so callers
/// answer `INVALID_PARAMS` instead of operating on a wrapped position.
fn parse_coord(value: Option<i64>) -> Option<u32> {
    let n = value?;
    if n < 0 || n > u32::MAX as i64 {
        return None;
    }
    Some(n as u32)
}

fn parse_pos(params: &Json) -> Option<TextPos> {
    let pos = params.get("position")?;
    Some(TextPos {
        line: parse_coord(pos.get("line")?.as_i64())?,
        character: parse_coord(pos.get("character")?.as_i64())?,
    })
}

fn parse_range(value: &Json) -> Option<LspRange> {
    let start = value.get("start")?;
    let end = value.get("end")?;
    Some(LspRange {
        start: TextPos {
            line: parse_coord(start.get("line")?.as_i64())?,
            character: parse_coord(start.get("character")?.as_i64())?,
        },
        end: TextPos {
            line: parse_coord(end.get("line")?.as_i64())?,
            character: parse_coord(end.get("character")?.as_i64())?,
        },
    })
}

fn parse_pos_request(params: &Json) -> Option<(String, TextPos)> {
    Some((doc_of(params)?, parse_pos(params)?))
}

/// Map a document URI to a [`SourceDb`] display path.
///
/// `file://` URIs lose their scheme and get minimal `%XX` decoding; any
/// other URI is used verbatim.
pub fn uri_to_path(uri: &str) -> String {
    let path = uri.strip_prefix("file://").unwrap_or(uri);
    let bytes = path.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let (Some(a), Some(b)) = (bytes.get(i + 1), bytes.get(i + 2))
            && let (Some(h), Some(l)) = (hex_val(*a), hex_val(*b))
        {
            out.push(h * 16 + l);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Serve LSP over stdio with stub analysis until the real backend lands.
pub fn run_stdio() -> i32 {
    use std::io::{BufReader, BufWriter};

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    let mut server = Server::new(StubAnalysis);

    loop {
        let body = match t::read_message(&mut reader) {
            Ok(Some(body)) => body,
            Ok(None) => return server.exit_code(),
            Err(_) => {
                // Framing errors carry no request id to answer; drop the
                // connection state and keep serving further messages.
                continue;
            }
        };
        let text = String::from_utf8_lossy(&body);
        let responses = match t::parse(&text) {
            Ok(message) => server.handle_json(&message),
            Err(_) => vec![t::response_err(None, t::error_code::PARSE, "invalid JSON")],
        };
        for response in responses {
            if t::write_message(&mut writer, response.as_bytes()).is_err() {
                return server.exit_code();
            }
        }
        for note in server.pump() {
            if t::write_message(&mut writer, note.as_bytes()).is_err() {
                return server.exit_code();
            }
        }
        if server.exited() {
            return server.exit_code();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str, method: &str, params: &str) -> Json {
        t::parse(&format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"{method}\",\"params\":{params}}}"
        ))
        .unwrap()
    }

    fn notify(method: &str, params: &str) -> Json {
        t::parse(&format!(
            "{{\"jsonrpc\":\"2.0\",\"method\":\"{method}\",\"params\":{params}}}"
        ))
        .unwrap()
    }

    fn initialized_server() -> Server<StubAnalysis> {
        let mut server = Server::new(StubAnalysis);
        let responses = server.handle_json(&request("1", "initialize", "{}"));
        assert_eq!(responses.len(), 1);
        assert!(responses[0].contains("capabilities"));
        server.handle_json(&notify("initialized", "{}"));
        server
    }

    #[test]
    fn lifecycle_gates_requests_and_exit_codes() {
        let mut server = Server::new(StubAnalysis);
        let gated = server.handle_json(&request("1", "textDocument/hover", "{}"));
        assert!(gated[0].contains("-32002"));
        let mut server = initialized_server();
        let shutdown = server.handle_json(&request("2", "shutdown", "{}"));
        assert!(shutdown[0].contains("\"result\":null"));
        server.handle_json(&notify("exit", "{}"));
        assert!(server.exited());
        assert_eq!(server.exit_code(), 0);
    }

    #[test]
    fn exit_without_shutdown_is_an_error() {
        let mut server = Server::new(StubAnalysis);
        server.handle_json(&notify("exit", "{}"));
        assert_eq!(server.exit_code(), 1);
    }

    #[test]
    fn stub_requests_answer_empty() {
        let mut server = initialized_server();
        server.handle_json(&notify(
            "textDocument/didOpen",
            r#"{"textDocument":{"uri":"file:///a.can","version":1,"text":"app A\n"}}"#,
        ));
        let hover = server.handle_json(&request(
            "2",
            "textDocument/hover",
            r#"{"textDocument":{"uri":"file:///a.can"},"position":{"line":0,"character":0}}"#,
        ));
        assert!(hover[0].contains("\"result\":null"));
        let tokens = server.handle_json(&request(
            "3",
            "textDocument/semanticTokens/full",
            r#"{"textDocument":{"uri":"file:///a.can"}}"#,
        ));
        assert!(tokens[0].contains("\"data\":[]"));
        let unknown = server.handle_json(&request("4", "nope/method", "{}"));
        assert!(unknown[0].contains("-32601"));
    }

    #[test]
    fn uri_to_path_decodes_file_uris() {
        assert_eq!(uri_to_path("file:///a%20b.can"), "/a b.can");
        assert_eq!(uri_to_path("untitled:1"), "untitled:1");
        assert_eq!(uri_to_path("file:///100%.can"), "/100%.can");
    }

    #[test]
    fn completion_kind_names_map_to_lsp_integers() {
        let expected = [
            ("Text", 1),
            ("Method", 2),
            ("Function", 3),
            ("Constructor", 4),
            ("Field", 5),
            ("Variable", 6),
            ("Class", 7),
            ("Interface", 8),
            ("Module", 9),
            ("Property", 10),
            ("Unit", 11),
            ("Value", 12),
            ("Enum", 13),
            ("Keyword", 14),
            ("Snippet", 15),
            ("Color", 16),
            ("File", 17),
            ("Reference", 18),
            ("Folder", 19),
            ("EnumMember", 20),
            ("Constant", 21),
            ("Struct", 22),
            ("Event", 23),
            ("Operator", 24),
            ("TypeParameter", 25),
        ];
        for (name, number) in expected {
            assert_eq!(completion_kind_number(name), Some(number), "{name}");
        }
        // Unknown and wrong-case names are omitted from the wire, never
        // emitted as strings.
        assert_eq!(completion_kind_number("Bogus"), None);
        assert_eq!(completion_kind_number("field"), None);
        assert_eq!(completion_kind_number(""), None);
    }

    /// Backend returning completion items so the serializer path (integer
    /// `kind`) is exercised even though the stub returns none.
    struct KindsAnalysis;

    impl LanguageAnalysis for KindsAnalysis {
        fn diagnostics(&self, _db: &SourceDb, _id: SourceId) -> Vec<Diagnostic> {
            Vec::new()
        }
        fn hover(&self, _db: &SourceDb, _id: SourceId, _pos: TextPos) -> Option<String> {
            None
        }
        fn completions(&self, _db: &SourceDb, _id: SourceId, _pos: TextPos) -> Vec<CompletionItem> {
            vec![
                CompletionItem {
                    label: "a".to_string(),
                    kind: Some("Field".to_string()),
                },
                CompletionItem {
                    label: "b".to_string(),
                    kind: Some("Bogus".to_string()),
                },
                CompletionItem {
                    label: "c".to_string(),
                    kind: None,
                },
            ]
        }
        fn definition(&self, _db: &SourceDb, _id: SourceId, _pos: TextPos) -> Vec<DocLocation> {
            Vec::new()
        }
        fn references(&self, _db: &SourceDb, _id: SourceId, _pos: TextPos) -> Vec<DocLocation> {
            Vec::new()
        }
        fn rename(
            &self,
            _db: &SourceDb,
            _id: SourceId,
            _pos: TextPos,
            _new_name: &str,
        ) -> Vec<TextEdit> {
            Vec::new()
        }
        fn semantic_tokens(&self, _db: &SourceDb, _id: SourceId) -> Vec<u32> {
            Vec::new()
        }
        fn code_actions(&self, _db: &SourceDb, _id: SourceId, _range: LspRange) -> Vec<CodeAction> {
            Vec::new()
        }
    }

    #[test]
    fn completion_response_carries_integer_kinds() {
        let mut server = Server::new(KindsAnalysis);
        server.handle_json(&request("1", "initialize", "{}"));
        server.handle_json(&notify(
            "textDocument/didOpen",
            r#"{"textDocument":{"uri":"file:///a.can","version":1,"text":"app A\n"}}"#,
        ));
        let responses = server.handle_json(&request(
            "2",
            "textDocument/completion",
            r#"{"textDocument":{"uri":"file:///a.can"},"position":{"line":0,"character":0}}"#,
        ));
        assert_eq!(responses.len(), 1);
        assert!(responses[0].contains(r#""label":"a""#), "{}", responses[0]);
        assert!(responses[0].contains(r#""kind":5"#), "{}", responses[0]);
        assert!(!responses[0].contains("Field"), "{}", responses[0]);
        assert!(!responses[0].contains("Bogus"), "{}", responses[0]);
    }

    #[test]
    fn out_of_range_positions_are_invalid_params() {
        let mut server = initialized_server();
        server.handle_json(&notify(
            "textDocument/didOpen",
            r#"{"textDocument":{"uri":"file:///a.can","version":1,"text":"app A\n"}}"#,
        ));
        // 2^32 would wrap to 0 with a bare `as u32`; it must reject.
        let wrapped = server.handle_json(&request(
            "2",
            "textDocument/hover",
            r#"{"textDocument":{"uri":"file:///a.can"},"position":{"line":4294967296,"character":0}}"#,
        ));
        assert!(wrapped[0].contains("-32602"), "{}", wrapped[0]);
        let negative = server.handle_json(&request(
            "3",
            "textDocument/hover",
            r#"{"textDocument":{"uri":"file:///a.can"},"position":{"line":-1,"character":0}}"#,
        ));
        assert!(negative[0].contains("-32602"), "{}", negative[0]);
        let bad_range = server.handle_json(&request(
            "4",
            "textDocument/codeAction",
            r#"{"textDocument":{"uri":"file:///a.can"},"range":{"start":{"line":0,"character":0},"end":{"line":9999999999,"character":0}}}"#,
        ));
        assert!(bad_range[0].contains("-32602"), "{}", bad_range[0]);
        // u32::MAX itself is representable and still parses (stub hover
        // answers null, not INVALID_PARAMS).
        let boundary = server.handle_json(&request(
            "5",
            "textDocument/hover",
            r#"{"textDocument":{"uri":"file:///a.can"},"position":{"line":4294967295,"character":0}}"#,
        ));
        assert!(boundary[0].contains("\"result\":null"), "{}", boundary[0]);
    }

    #[test]
    fn requests_after_shutdown_are_invalid() {
        let mut server = initialized_server();
        server.handle_json(&request("2", "shutdown", "{}"));
        let hover = server.handle_json(&request("3", "textDocument/hover", "{}"));
        assert!(hover[0].contains("-32600"), "{}", hover[0]);
        // A second shutdown is likewise InvalidRequest once shut down.
        let again = server.handle_json(&request("4", "shutdown", "{}"));
        assert!(again[0].contains("-32600"), "{}", again[0]);
    }

    #[test]
    fn identical_content_change_keeps_version_semantics() {
        // The M3 fix (no-op changes reuse the live SourceId instead of
        // appending a duplicate snapshot) is internal state; what is
        // observable is that versions still advance and each version is
        // still published exactly once.
        let mut server = initialized_server();
        server.handle_json(&notify(
            "textDocument/didOpen",
            r#"{"textDocument":{"uri":"file:///a.can","version":1,"text":"app A\n"}}"#,
        ));
        server.handle_json(&notify(
            "textDocument/didChange",
            r#"{"textDocument":{"uri":"file:///a.can","version":2},"contentChanges":[{"text":"app A\n"}]}"#,
        ));
        assert_eq!(server.pending_count(), 2);
        let notes = server.pump();
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(notes[0].contains("\"version\":2"), "{}", notes[0]);
        // A follow-up real change still applies on top of the shared snapshot.
        server.handle_json(&notify(
            "textDocument/didChange",
            r#"{"textDocument":{"uri":"file:///a.can","version":3},"contentChanges":[{"text":"app A\nGiven\n"}]}"#,
        ));
        let notes = server.pump();
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(notes[0].contains("\"version\":3"), "{}", notes[0]);
    }
}
