//! LSP server over the stdio [`transport`](crate::lsp::transport).
//!
//! Handles `initialize`/`initialized`/`shutdown`/`exit`, document sync with
//! version tracking, and `hover`/`completion`/`definition`/`references`/
//! `rename`/`semanticTokens`/`codeAction` driven by the [`LanguageAnalysis`]
//! trait. [`RealAnalysis`] implements the trait over the shared syntax,
//! analysis, lint and IDE-query crates; [`StubAnalysis`] keeps the
//! lifecycle tests hermetic with empty results.
//!
//! Version/staleness contract: `didOpen`/`didChange` enqueue one analysis
//! task per document version; [`Server::pump`] publishes diagnostics only
//! for the task whose version still matches the open document and silently
//! cancels stale ones. Diagnostics are therefore never published for an
//! outdated buffer, and never for a closed one.
//!
//! All positions use UTF-16 encoding; only full-text sync is honored
//! (incremental `range` edits are ignored and documented).

use crate::analysis::catalog::{CATALOG_ENV_VAR, Catalog, CatalogRequest, load_catalog};
use crate::diagnostic::{Diagnostic, Severity};
use crate::ide::{fixes, queries, tokens};
use crate::lint::{DeprecatedSet, LintConfig, RuleSet, collect_fixes, lint_program};
use crate::lsp::transport as t;
use crate::lsp::transport::Json;
use crate::source::{LineIndex, SourceDb, SourceId, Span};
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

/// One file edit within a code action.
#[derive(Debug, Clone)]
pub struct FileEdit {
    /// Document URI the range belongs to.
    pub uri: String,
    /// Range to replace.
    pub range: LspRange,
    /// Replacement text.
    pub new_text: String,
}

/// One code action returned by analysis.
#[derive(Debug, Clone)]
pub struct CodeAction {
    /// Human title, e.g. "Replace redundant markers".
    pub title: String,
    /// LSP kind, e.g. `quickfix`.
    pub kind: String,
    /// File edits applied atomically; empty for actions without edits.
    pub edits: Vec<FileEdit>,
}

/// Language callbacks behind every LSP data request.
///
/// Each method receives the shared [`SourceDb`] plus the [`SourceId`] of the
/// current document text, so backends run syntax and analysis without the
/// server knowing their types. Positions are UTF-16. Location-returning
/// methods also take the requesting document URI so single-file backends
/// can attribute same-file spans without reversing the URI mapping.
pub trait LanguageAnalysis {
    /// Full-document diagnostics for the current text.
    fn diagnostics(&self, db: &SourceDb, id: SourceId) -> Vec<Diagnostic>;
    /// Hover markdown for a position, if any.
    fn hover(&self, db: &SourceDb, id: SourceId, pos: TextPos) -> Option<String>;
    /// Completion items for a position.
    fn completions(&self, db: &SourceDb, id: SourceId, pos: TextPos) -> Vec<CompletionItem>;
    /// Go-to-definition targets for a position.
    fn definition(&self, db: &SourceDb, id: SourceId, uri: &str, pos: TextPos) -> Vec<DocLocation>;
    /// Reference locations for a position.
    fn references(&self, db: &SourceDb, id: SourceId, uri: &str, pos: TextPos) -> Vec<DocLocation>;
    /// Rename edits for a position and new name.
    fn rename(&self, db: &SourceDb, id: SourceId, pos: TextPos, new_name: &str) -> Vec<TextEdit>;
    /// Raw semantic-token data array (`[line, col, len, type, mods, ...]`).
    fn semantic_tokens(&self, db: &SourceDb, id: SourceId) -> Vec<u32>;
    /// Code actions for a range.
    fn code_actions(
        &self,
        db: &SourceDb,
        id: SourceId,
        uri: &str,
        range: LspRange,
    ) -> Vec<CodeAction>;
}

/// Hermetic analysis for lifecycle tests: empty results.
///
/// Every method returns "no data" (empty vec / `None`); the server treats
/// these as legitimate empty answers, never as errors. Production serving
/// uses [`RealAnalysis`].
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
    fn definition(
        &self,
        _db: &SourceDb,
        _id: SourceId,
        _uri: &str,
        _pos: TextPos,
    ) -> Vec<DocLocation> {
        Vec::new()
    }
    fn references(
        &self,
        _db: &SourceDb,
        _id: SourceId,
        _uri: &str,
        _pos: TextPos,
    ) -> Vec<DocLocation> {
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
    fn code_actions(
        &self,
        _db: &SourceDb,
        _id: SourceId,
        _uri: &str,
        _range: LspRange,
    ) -> Vec<CodeAction> {
        Vec::new()
    }
}

/// Production analysis: parse plus name/type analysis, lint findings and
/// IDE queries over the current document text.
///
/// Diagnostics merge analysis errors with lint warnings/information for
/// the requested document only (the lint driver scans the whole session
/// database, so other files' findings are filtered out). Queries run on
/// a single-document [`queries::Snapshot`]; cross-file references are
/// not tracked.
#[derive(Debug, Default)]
pub struct RealAnalysis {
    catalog: Option<Catalog>,
    /// Catalog load diagnostics, re-anchored to each document on read.
    catalog_diags: Vec<Diagnostic>,
}

impl RealAnalysis {
    /// Backend with an explicit catalog (`None` means builtins do not
    /// resolve; each use is `E2001`).
    pub fn new(catalog: Option<Catalog>) -> Self {
        Self {
            catalog,
            catalog_diags: Vec::new(),
        }
    }

    /// Backend loading the producer catalog from process state (the
    /// `CAN_CATALOG` value plus the `./` candidates, as in the CLI). A
    /// load failure is reported per document as the loader's diagnostic,
    /// re-anchored to that document's start.
    pub fn from_process() -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let request = CatalogRequest {
            flag: None,
            env: std::env::var(CATALOG_ENV_VAR).ok(),
            cwd: &cwd,
            primary: Span::new(SourceId(0), 0, 0),
        };
        let (catalog, catalog_diags) = load_catalog(&request);
        Self {
            catalog,
            catalog_diags,
        }
    }

    /// Analyze one document.
    fn snapshot<'a>(&'a self, db: &'a SourceDb, id: SourceId) -> queries::Snapshot<'a> {
        queries::Snapshot::analyze(db, id, self.catalog.as_ref())
    }

    /// Lint configuration: recommended rules with catalog deprecation
    /// data when a catalog is available.
    fn lint_config(&self, fix: bool) -> LintConfig {
        LintConfig {
            enabled: RuleSet::recommended(),
            fix,
            deprecated: self.catalog.as_ref().map(DeprecatedSet::from_catalog),
        }
    }
}

impl LanguageAnalysis for RealAnalysis {
    fn diagnostics(&self, db: &SourceDb, id: SourceId) -> Vec<Diagnostic> {
        // Deliberate divergence from `can lint`: the CLI suppresses
        // lint findings while analysis errors report (one signal per
        // run), but an editor buffer is always mid-edit, so the server
        // merges both — errors and lint findings side by side.
        let snapshot = self.snapshot(db, id);
        let mut diagnostics: Vec<Diagnostic> = snapshot.diagnostics().to_vec();
        for mut diagnostic in self.catalog_diags.clone() {
            diagnostic.primary.file = id;
            diagnostics.push(diagnostic);
        }
        diagnostics.extend(
            lint_program(snapshot.program(), db, &self.lint_config(false))
                .into_iter()
                .filter(|d| d.primary.file == id),
        );
        diagnostics.sort_by(|a, b| {
            (
                a.primary.file,
                a.primary.start,
                a.primary.end,
                a.code,
                &a.message,
            )
                .cmp(&(
                    b.primary.file,
                    b.primary.start,
                    b.primary.end,
                    b.code,
                    &b.message,
                ))
        });
        diagnostics
    }

    fn hover(&self, db: &SourceDb, id: SourceId, pos: TextPos) -> Option<String> {
        let snapshot = self.snapshot(db, id);
        let offset = queries::offset_at_position(snapshot.text(), pos.line, pos.character)?;
        snapshot.hover_at(offset).map(|h| h.markdown)
    }

    fn completions(&self, db: &SourceDb, id: SourceId, pos: TextPos) -> Vec<CompletionItem> {
        let snapshot = self.snapshot(db, id);
        let Some(offset) = queries::offset_at_position(snapshot.text(), pos.line, pos.character)
        else {
            return Vec::new();
        };
        snapshot
            .completions_at(offset)
            .into_iter()
            .map(|item| CompletionItem {
                label: item.label,
                kind: Some(item.kind.to_string()),
            })
            .collect()
    }

    fn definition(&self, db: &SourceDb, id: SourceId, uri: &str, pos: TextPos) -> Vec<DocLocation> {
        let snapshot = self.snapshot(db, id);
        let text = snapshot.text();
        let index = LineIndex::new(text);
        let Some(offset) = queries::offset_at_position(text, pos.line, pos.character) else {
            return Vec::new();
        };
        snapshot
            .definition_at(offset)
            .into_iter()
            .filter(|span| span.file == id)
            .map(|span| DocLocation {
                uri: uri.to_string(),
                range: span_to_range(&index, text, span),
            })
            .collect()
    }

    fn references(&self, db: &SourceDb, id: SourceId, uri: &str, pos: TextPos) -> Vec<DocLocation> {
        let snapshot = self.snapshot(db, id);
        let text = snapshot.text();
        let index = LineIndex::new(text);
        let Some(offset) = queries::offset_at_position(text, pos.line, pos.character) else {
            return Vec::new();
        };
        snapshot
            .references_at(offset)
            .into_iter()
            .filter(|span| span.file == id)
            .map(|span| DocLocation {
                uri: uri.to_string(),
                range: span_to_range(&index, text, span),
            })
            .collect()
    }

    fn rename(&self, db: &SourceDb, id: SourceId, pos: TextPos, new_name: &str) -> Vec<TextEdit> {
        if !is_valid_name(new_name) {
            return Vec::new();
        }
        let snapshot = self.snapshot(db, id);
        let text = snapshot.text();
        let Some(offset) = queries::offset_at_position(text, pos.line, pos.character) else {
            return Vec::new();
        };
        let Some(rename) = snapshot.rename_at(offset) else {
            return Vec::new();
        };
        if rename.sha256 != snapshot.sha256() {
            return Vec::new();
        }
        let index = LineIndex::new(text);
        rename
            .spans
            .into_iter()
            .filter(|span| span.file == id)
            .map(|span| TextEdit {
                range: span_to_range(&index, text, span),
                new_text: new_name.to_string(),
            })
            .collect()
    }

    fn semantic_tokens(&self, db: &SourceDb, id: SourceId) -> Vec<u32> {
        let snapshot = self.snapshot(db, id);
        tokens::semantic_tokens(&snapshot)
    }

    fn code_actions(
        &self,
        db: &SourceDb,
        id: SourceId,
        uri: &str,
        range: LspRange,
    ) -> Vec<CodeAction> {
        let snapshot = self.snapshot(db, id);
        let text = snapshot.text();
        let Some(start) =
            queries::offset_at_position(text, range.start.line, range.start.character)
        else {
            return Vec::new();
        };
        let Some(end) = queries::offset_at_position(text, range.end.line, range.end.character)
        else {
            return Vec::new();
        };
        let index = LineIndex::new(text);
        let sha = snapshot.sha256().to_string();
        let mut actions = Vec::new();
        // Analysis-diagnostic fixes (none ship today; the mapping stays
        // so the first real one flows without server changes).
        for diagnostic in snapshot.diagnostics() {
            if diagnostic.primary.file != id || !span_overlaps(diagnostic.primary, start, end) {
                continue;
            }
            for fix in fixes::fixes_for(diagnostic, &sha) {
                actions.push(diagnostic_fix_to_action(uri, &index, text, &fix));
            }
        }
        // Lint safe fixes overlapping the range.
        for lint_fix in collect_fixes(snapshot.program(), db, &self.lint_config(true)) {
            if lint_fix.file != id
                || lint_fix.expected_sha256 != sha
                || !span_overlaps(lint_fix.span, start, end)
            {
                continue;
            }
            let fix = fixes::from_lint_fix(&lint_fix);
            actions.push(diagnostic_fix_to_action(uri, &index, text, &fix));
        }
        actions
    }
}

/// Convert a byte span to an LSP range (UTF-16).
fn span_to_range(index: &LineIndex, text: &str, span: Span) -> LspRange {
    let (start_line, start_char) = index.to_lsp(text, span.start, true);
    let (end_line, end_char) = index.to_lsp(text, span.end, true);
    LspRange {
        start: TextPos {
            line: start_line,
            character: start_char,
        },
        end: TextPos {
            line: end_line,
            character: end_char,
        },
    }
}

/// Whether a byte span overlaps `[start, end)` (or contains the cursor
/// when the range is empty).
fn span_overlaps(span: Span, start: u32, end: u32) -> bool {
    if start >= end {
        span.start <= start && start < span.end
    } else {
        span.start < end && start < span.end
    }
}

/// Whether `name` is a valid Can identifier (ASCII `NAME` token).
fn is_valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Map one IDE fix to a wire code action (edits verified against the
/// live text hash before responding).
fn diagnostic_fix_to_action(
    uri: &str,
    index: &LineIndex,
    text: &str,
    fix: &fixes::DiagnosticFix,
) -> CodeAction {
    // `SourceId(0)` below discards the edit's file id: safe only
    // because callers pre-filter fixes to this same file. Multi-file
    // fixes must thread the real id through instead.
    let edits = if crate::source::sha256_hex(text.as_bytes()) == fix.expected_sha256 {
        fix.edits
            .iter()
            .map(|edit| FileEdit {
                uri: uri.to_string(),
                range: span_to_range(index, text, Span::new(SourceId(0), edit.start, edit.end)),
                new_text: edit.new_text.clone(),
            })
            .collect()
    } else {
        Vec::new()
    };
    CodeAction {
        title: fix.title.clone(),
        kind: fix.kind.to_string(),
        edits,
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
            "textDocument/definition" => {
                let target = parse_pos_request(params)
                    .and_then(|(uri, pos)| self.doc_id(&uri).map(|doc| (uri, doc, pos)));
                match target {
                    Some((uri, doc_id, pos)) => {
                        let locations: Vec<Json> = self
                            .analysis
                            .definition(&self.db, doc_id, &uri, pos)
                            .into_iter()
                            .map(location_json)
                            .collect();
                        t::response_ok(id, Json::Arr(locations))
                    }
                    None => t::response_err(
                        Some(id),
                        t::error_code::INVALID_PARAMS,
                        "unknown document or bad position",
                    ),
                }
            }
            "textDocument/references" => {
                let target = parse_pos_request(params)
                    .and_then(|(uri, pos)| self.doc_id(&uri).map(|doc| (uri, doc, pos)));
                match target {
                    Some((uri, doc_id, pos)) => {
                        let locations: Vec<Json> = self
                            .analysis
                            .references(&self.db, doc_id, &uri, pos)
                            .into_iter()
                            .map(location_json)
                            .collect();
                        t::response_ok(id, Json::Arr(locations))
                    }
                    None => t::response_err(
                        Some(id),
                        t::error_code::INVALID_PARAMS,
                        "unknown document or bad position",
                    ),
                }
            }
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
                    Some((uri, doc_id, range))
                }) {
                    Some((uri, doc_id, range)) => {
                        let actions: Vec<Json> = self
                            .analysis
                            .code_actions(&self.db, doc_id, &uri, range)
                            .into_iter()
                            .map(code_action_json)
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
    // The semantic-tokens legend is the single source of truth in
    // `ide::tokens`; every other provider below is backed by a passing
    // capability test in `tests/ide.rs`.
    let (token_types, token_modifiers) = tokens::legend();
    let token_types: Vec<Json> = token_types.into_iter().map(Json::Str).collect();
    let token_modifiers: Vec<Json> = token_modifiers.into_iter().map(Json::Str).collect();
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
                                ("tokenTypes".to_string(), Json::Arr(token_types)),
                                ("tokenModifiers".to_string(), Json::Arr(token_modifiers)),
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

/// Serialize one code action, with a `documentChanges` edit when the
/// action carries edits.
fn code_action_json(action: CodeAction) -> Json {
    let mut members = vec![
        ("title".to_string(), Json::Str(action.title)),
        ("kind".to_string(), Json::Str(action.kind)),
    ];
    if !action.edits.is_empty() {
        // Edits group by URI so one action can touch several files.
        let mut by_uri: Vec<(String, Vec<&FileEdit>)> = Vec::new();
        for edit in &action.edits {
            match by_uri.iter_mut().find(|(uri, _)| *uri == edit.uri) {
                Some((_, edits)) => edits.push(edit),
                None => by_uri.push((edit.uri.clone(), vec![edit])),
            }
        }
        let changes: Vec<Json> = by_uri
            .into_iter()
            .map(|(uri, edits)| {
                let file_edits: Vec<Json> = edits
                    .into_iter()
                    .map(|edit| {
                        Json::Obj(vec![
                            ("range".to_string(), range_json(edit.range)),
                            ("newText".to_string(), Json::Str(edit.new_text.clone())),
                        ])
                    })
                    .collect();
                Json::Obj(vec![
                    (
                        "textDocument".to_string(),
                        Json::Obj(vec![("uri".to_string(), Json::Str(uri))]),
                    ),
                    ("edits".to_string(), Json::Arr(file_edits)),
                ])
            })
            .collect();
        members.push((
            "edit".to_string(),
            Json::Obj(vec![("documentChanges".to_string(), Json::Arr(changes))]),
        ));
    }
    Json::Obj(members)
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

/// Serve LSP over stdio with the production analysis backend.
///
/// Shutdown is graceful on every std-visible signal: stdin EOF returns
/// the lifecycle exit code after flushing pending output, a mid-message
/// client disconnect (`UnexpectedEof`) does the same, and the
/// `shutdown`/`exit` handshake exits through [`Server::exited`]. Truly
/// catching Ctrl-C (SIGINT) needs a signal handler, which stable `std`
/// cannot install dependency-free — so SIGINT keeps its default
/// terminate disposition; editors shutting down cleanly close stdin or
/// send `exit`, both of which flush and exit below.
pub fn run_stdio() -> i32 {
    use std::io::{BufReader, BufWriter, Write};

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    let mut server = Server::new(RealAnalysis::from_process());

    // Flush best-effort, then report the lifecycle exit code.
    macro_rules! shutdown {
        () => {{
            let _ = writer.flush();
            return server.exit_code();
        }};
    }

    loop {
        let body = match t::read_message(&mut reader) {
            Ok(Some(body)) => body,
            // Clean EOF: the client went away; flush and report.
            Ok(None) => shutdown!(),
            Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => {
                // EOF inside headers/body: a torn disconnect, not a
                // transient framing slip — shut down, don't spin.
                shutdown!()
            }
            Err(_) => {
                // Framing errors carry no request id to answer; drop the
                // connection state and keep serving further messages.
                continue;
            }
        };
        let responses = match std::str::from_utf8(&body) {
            Ok(text) => match t::parse(text) {
                Ok(message) => server.handle_json(&message),
                Err(_) => vec![t::response_err(None, t::error_code::PARSE, "invalid JSON")],
            },
            Err(_) => vec![t::response_err(None, t::error_code::PARSE, "invalid UTF-8")],
        };
        for response in responses {
            if t::write_message(&mut writer, response.as_bytes()).is_err() {
                // The client is gone; nothing left to flush to.
                return server.exit_code();
            }
        }
        for note in server.pump() {
            if t::write_message(&mut writer, note.as_bytes()).is_err() {
                return server.exit_code();
            }
        }
        if server.exited() {
            shutdown!()
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
        fn definition(
            &self,
            _db: &SourceDb,
            _id: SourceId,
            _uri: &str,
            _pos: TextPos,
        ) -> Vec<DocLocation> {
            Vec::new()
        }
        fn references(
            &self,
            _db: &SourceDb,
            _id: SourceId,
            _uri: &str,
            _pos: TextPos,
        ) -> Vec<DocLocation> {
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
        fn code_actions(
            &self,
            _db: &SourceDb,
            _id: SourceId,
            _uri: &str,
            _range: LspRange,
        ) -> Vec<CodeAction> {
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
