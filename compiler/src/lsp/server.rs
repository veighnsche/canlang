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
//! for the task whose source snapshot and version still match the open
//! document, while the session is ready. Close cancels its queued work and
//! publishes an empty diagnostic set; shutdown cancels all queued work.
//!
//! All positions use UTF-16 encoding; only full-text sync is honored
//! (incremental `range` edits are ignored and documented).

use crate::analysis::catalog::{CATALOG_ENV_VAR, Catalog, CatalogRequest, load_catalog};
use crate::diagnostic::{Diagnostic, Severity};
use crate::ide::{fixes, queries, structure, tokens};
use crate::lint::{DeprecatedSet, LintConfig, RuleSet, collect_fixes, lint_program};
use crate::lsp::output;
use crate::lsp::transport as t;
use crate::lsp::transport::Json;
use crate::source::{LineIndex, SourceDb, SourceId, Span};
use lsp_types as lsp;
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};

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
    /// as the spec's integer enum (`completion_kind`); unknown
    /// names are omitted from the wire (the member is optional).
    pub kind: Option<String>,
    /// Type or binding information displayed beside the label.
    pub detail: Option<String>,
}

/// Map an LSP `CompletionItemKind` name to its integer code (LSP 3.17,
/// `Text`=1 through `TypeParameter`=25). Unknown names map to `None`
/// and are omitted from the response, keeping the serializer path
/// protocol-valid once a real backend returns items.
fn completion_kind_head(name: &str) -> Option<lsp::CompletionItemKind> {
    Some(match name {
        "Text" => lsp::CompletionItemKind::TEXT,
        "Method" => lsp::CompletionItemKind::METHOD,
        "Function" => lsp::CompletionItemKind::FUNCTION,
        "Constructor" => lsp::CompletionItemKind::CONSTRUCTOR,
        "Field" => lsp::CompletionItemKind::FIELD,
        "Variable" => lsp::CompletionItemKind::VARIABLE,
        "Class" => lsp::CompletionItemKind::CLASS,
        "Interface" => lsp::CompletionItemKind::INTERFACE,
        "Module" => lsp::CompletionItemKind::MODULE,
        "Property" => lsp::CompletionItemKind::PROPERTY,
        "Unit" => lsp::CompletionItemKind::UNIT,
        "Value" => lsp::CompletionItemKind::VALUE,
        "Enum" => lsp::CompletionItemKind::ENUM,
        "Keyword" => lsp::CompletionItemKind::KEYWORD,
        _ => return None,
    })
}

fn completion_kind(name: &str) -> Option<lsp::CompletionItemKind> {
    if let Some(kind) = completion_kind_head(name) {
        return Some(kind);
    }
    Some(match name {
        "Snippet" => lsp::CompletionItemKind::SNIPPET,
        "Color" => lsp::CompletionItemKind::COLOR,
        "File" => lsp::CompletionItemKind::FILE,
        "Reference" => lsp::CompletionItemKind::REFERENCE,
        "Folder" => lsp::CompletionItemKind::FOLDER,
        "EnumMember" => lsp::CompletionItemKind::ENUM_MEMBER,
        "Constant" => lsp::CompletionItemKind::CONSTANT,
        "Struct" => lsp::CompletionItemKind::STRUCT,
        "Event" => lsp::CompletionItemKind::EVENT,
        "Operator" => lsp::CompletionItemKind::OPERATOR,
        "TypeParameter" => lsp::CompletionItemKind::TYPE_PARAMETER,
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
/// The database contains the live documents and may be replaced between
/// callbacks. Source IDs belong to the supplied database owner; a retained
/// checked program must be rechecked before use with a later owner.
pub trait LanguageAnalysis {
    /// Sources in the active declaration/import/composition project.
    fn project_sources(&self, _db: &SourceDb, id: SourceId) -> Vec<SourceId> {
        vec![id]
    }
    /// Configure the local declaration and catalog boundaries for this session.
    fn workspace_roots(&mut self, _roots: &[PathBuf]) {}
    /// File-qualified rename edits. Legacy backends retain their one-file seam.
    fn rename_files(
        &self,
        db: &SourceDb,
        id: SourceId,
        uri: &str,
        pos: TextPos,
        new_name: &str,
    ) -> Vec<FileEdit> {
        self.rename(db, id, pos, new_name)
            .into_iter()
            .map(|edit| FileEdit {
                uri: uri.to_string(),
                range: edit.range,
                new_text: edit.new_text,
            })
            .collect()
    }

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
    /// Hierarchical outline of the current document.
    fn document_symbols(&self, _db: &SourceDb, _id: SourceId) -> Vec<lsp::DocumentSymbol> {
        Vec::new()
    }
    /// Canonical formatting edits; unparseable input is left untouched.
    fn formatting(&self, _db: &SourceDb, _id: SourceId) -> Vec<TextEdit> {
        Vec::new()
    }
    /// Multiline source blocks for editor folding.
    fn folding_ranges(&self, _db: &SourceDb, _id: SourceId) -> Vec<lsp::FoldingRange> {
        Vec::new()
    }
    /// Expanding syntax selections, one per requested position.
    fn selection_ranges(
        &self,
        _db: &SourceDb,
        _id: SourceId,
        _positions: &[lsp::Position],
    ) -> Vec<lsp::SelectionRange> {
        Vec::new()
    }
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
/// a workspace-filtered [`queries::Snapshot`]; detached documents keep
/// single-file analysis.
#[derive(Debug, Default)]
pub struct RealAnalysis {
    catalog: Option<Catalog>,
    /// Catalog load diagnostics, re-anchored to each document on read.
    catalog_diags: Vec<Diagnostic>,
    process_catalog: bool,
    roots: Vec<(PathBuf, Option<Catalog>, Vec<Diagnostic>)>,
    metadata: RefCell<HashMap<(String, String), Vec<ModuleMetadata>>>,
}

impl RealAnalysis {
    /// Backend with an explicit catalog (`None` means builtins do not
    /// resolve; each use is `E2001`).
    pub fn new(catalog: Option<Catalog>) -> Self {
        Self {
            catalog,
            catalog_diags: Vec::new(),
            process_catalog: false,
            roots: Vec::new(),
            metadata: RefCell::new(HashMap::new()),
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
            process_catalog: true,
            roots: Vec::new(),
            metadata: RefCell::new(HashMap::new()),
        }
    }

    fn owner(&self, path: &str) -> Option<usize> {
        owning_root(
            &self
                .roots
                .iter()
                .map(|(root, _, _)| root.clone())
                .collect::<Vec<_>>(),
            Path::new(path),
        )
    }

    fn catalog_for(&self, db: &SourceDb, id: SourceId) -> (Option<&Catalog>, &[Diagnostic]) {
        if self.process_catalog
            && let Some(owner) = db.get(id).and_then(|source| self.owner(&source.path))
        {
            let (_, catalog, diagnostics) = &self.roots[owner];
            return (catalog.as_ref(), diagnostics);
        }
        (self.catalog.as_ref(), &self.catalog_diags)
    }

    /// Analyze the current workspace using the ordinary multi-source pipeline.
    fn snapshot<'a>(&'a self, db: &'a SourceDb, id: SourceId) -> queries::Snapshot<'a> {
        let catalog = self.catalog_for(db, id).0;
        let owner = db.get(id).and_then(|source| self.owner(&source.path));
        let Some(owner) = owner else {
            return queries::Snapshot::analyze(db, id, catalog);
        };
        let candidates = db
            .iter()
            .filter(|(file, source)| {
                db.lookup(&source.path) == Some(*file) && self.owner(&source.path) == Some(owner)
            })
            .map(|(file, _)| file)
            .collect::<Vec<_>>();
        let files = project_files(db, id, &candidates, &self.metadata).0;
        queries::Snapshot::analyze_files(db, id, &files, catalog)
    }

    fn project_diagnostics(&self, db: &SourceDb, id: SourceId) -> Vec<Diagnostic> {
        let Some(owner) = db.get(id).and_then(|source| self.owner(&source.path)) else {
            return Vec::new();
        };
        let candidates = db
            .iter()
            .filter(|(file, source)| {
                db.lookup(&source.path) == Some(*file) && self.owner(&source.path) == Some(owner)
            })
            .map(|(file, _)| file)
            .collect::<Vec<_>>();
        project_files(db, id, &candidates, &self.metadata).1
    }

    /// Lint configuration: recommended rules with catalog deprecation
    /// data when a catalog is available.
    fn lint_config(&self, catalog: Option<&Catalog>, fix: bool) -> LintConfig {
        LintConfig {
            enabled: RuleSet::recommended(),
            fix,
            deprecated: catalog.map(DeprecatedSet::from_catalog),
        }
    }
}

impl LanguageAnalysis for RealAnalysis {
    fn project_sources(&self, db: &SourceDb, id: SourceId) -> Vec<SourceId> {
        let Some(owner) = db.get(id).and_then(|source| self.owner(&source.path)) else {
            return vec![id];
        };
        let candidates = db
            .iter()
            .filter(|(file, source)| {
                db.lookup(&source.path) == Some(*file) && self.owner(&source.path) == Some(owner)
            })
            .map(|(file, _)| file)
            .collect::<Vec<_>>();
        project_files(db, id, &candidates, &self.metadata).0
    }

    fn workspace_roots(&mut self, roots: &[PathBuf]) {
        self.roots = roots
            .iter()
            .map(|root| {
                let (catalog, diagnostics) = if self.process_catalog {
                    load_catalog(&CatalogRequest {
                        flag: None,
                        env: std::env::var(CATALOG_ENV_VAR).ok(),
                        cwd: root,
                        primary: Span::new(SourceId(0), 0, 0),
                    })
                } else {
                    (None, Vec::new())
                };
                (root.clone(), catalog, diagnostics)
            })
            .collect();
    }

    fn rename_files(
        &self,
        db: &SourceDb,
        id: SourceId,
        uri: &str,
        pos: TextPos,
        new_name: &str,
    ) -> Vec<FileEdit> {
        if !is_valid_name(new_name) || !self.project_diagnostics(db, id).is_empty() {
            return Vec::new();
        }
        let snapshot = self.snapshot(db, id);
        let Some(offset) = queries::offset_at_position(snapshot.text(), pos.line, pos.character)
        else {
            return Vec::new();
        };
        let Some(rename) = snapshot.safe_rename_at(offset, new_name) else {
            return Vec::new();
        };
        if rename.sha256 != snapshot.sha256() {
            return Vec::new();
        }
        rename
            .spans
            .into_iter()
            .filter_map(|span| {
                let location = source_location(db, id, uri, span)?;
                Some(FileEdit {
                    uri: location.uri,
                    range: location.range,
                    new_text: new_name.to_string(),
                })
            })
            .collect()
    }

    fn diagnostics(&self, db: &SourceDb, id: SourceId) -> Vec<Diagnostic> {
        // Deliberate divergence from `can lint`: the CLI suppresses
        // lint findings while analysis errors report (one signal per
        // run), but an editor buffer is always mid-edit, so the server
        // merges both — errors and lint findings side by side.
        let snapshot = self.snapshot(db, id);
        let mut diagnostics: Vec<Diagnostic> = snapshot
            .diagnostics()
            .iter()
            .filter(|d| d.primary.file == id)
            .cloned()
            .collect();
        diagnostics.extend(self.project_diagnostics(db, id));
        for mut diagnostic in self.catalog_for(db, id).1.to_vec() {
            diagnostic.primary.file = id;
            diagnostics.push(diagnostic);
        }
        diagnostics.extend(
            lint_program(
                snapshot.program(),
                db,
                &self.lint_config(self.catalog_for(db, id).0, false),
            )
            .into_iter()
            .filter(|d| d.primary.file == id),
        );
        diagnostics.sort_by(Diagnostic::canonical_cmp);
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
                detail: item.detail,
            })
            .collect()
    }

    fn definition(&self, db: &SourceDb, id: SourceId, uri: &str, pos: TextPos) -> Vec<DocLocation> {
        let snapshot = self.snapshot(db, id);
        let text = snapshot.text();
        let Some(offset) = queries::offset_at_position(text, pos.line, pos.character) else {
            return Vec::new();
        };
        snapshot
            .definition_at(offset)
            .into_iter()
            .filter_map(|span| source_location(db, id, uri, span))
            .collect()
    }

    fn references(&self, db: &SourceDb, id: SourceId, uri: &str, pos: TextPos) -> Vec<DocLocation> {
        let snapshot = self.snapshot(db, id);
        let text = snapshot.text();
        let Some(offset) = queries::offset_at_position(text, pos.line, pos.character) else {
            return Vec::new();
        };
        snapshot
            .references_at(offset)
            .into_iter()
            .filter_map(|span| source_location(db, id, uri, span))
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
        let Some(rename) = snapshot.safe_rename_at(offset, new_name) else {
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

    fn document_symbols(&self, db: &SourceDb, id: SourceId) -> Vec<lsp::DocumentSymbol> {
        let snapshot = self.snapshot(db, id);
        let text = snapshot.text();
        let index = LineIndex::new(text);
        snapshot
            .document_symbols()
            .into_iter()
            .map(|node| outline_symbol(node, &index, text))
            .collect()
    }

    fn folding_ranges(&self, db: &SourceDb, id: SourceId) -> Vec<lsp::FoldingRange> {
        structure::folding_ranges(&self.snapshot(db, id))
    }

    fn selection_ranges(
        &self,
        db: &SourceDb,
        id: SourceId,
        positions: &[lsp::Position],
    ) -> Vec<lsp::SelectionRange> {
        structure::selection_ranges(&self.snapshot(db, id), positions)
    }

    fn formatting(&self, db: &SourceDb, id: SourceId) -> Vec<TextEdit> {
        let Some(source) = db.get(id) else {
            return Vec::new();
        };
        let Ok(formatted) = crate::format::format_source(id, &source.text) else {
            return Vec::new();
        };
        if !formatted.changed {
            return Vec::new();
        }
        vec![TextEdit {
            range: span_to_range(
                &LineIndex::new(&source.text),
                &source.text,
                Span::new(id, 0, source.text.len() as u32),
            ),
            new_text: formatted.text,
        }]
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
        for lint_fix in collect_fixes(
            snapshot.program(),
            db,
            &self.lint_config(self.catalog_for(db, id).0, true),
        ) {
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

/// Keep declaration nesting and exact name selection ranges in the editor outline.
#[allow(deprecated)]
fn outline_symbol(
    node: queries::OutlineNode,
    index: &LineIndex,
    text: &str,
) -> lsp::DocumentSymbol {
    let kind = match node.kind {
        "app" | "package" => lsp::SymbolKind::MODULE,
        "model" | "capability" | "crud" => lsp::SymbolKind::CLASS,
        "contract" => lsp::SymbolKind::INTERFACE,
        "event" | "message" => lsp::SymbolKind::EVENT,
        "role" => lsp::SymbolKind::ENUM,
        "scenario" | "derived function" => lsp::SymbolKind::FUNCTION,
        "capability operation" | "crud operation" => lsp::SymbolKind::METHOD,
        "field" | "derived field" => lsp::SymbolKind::FIELD,
        "preferences" => lsp::SymbolKind::STRUCT,
        _ => lsp::SymbolKind::VARIABLE,
    };
    lsp::DocumentSymbol {
        name: node.name,
        detail: Some(node.kind.to_string()),
        kind,
        tags: None,
        deprecated: None,
        range: output::range(span_to_range(index, text, node.range)),
        selection_range: output::range(span_to_range(index, text, node.span)),
        children: Some(
            node.children
                .into_iter()
                .map(|child| outline_symbol(child, index, text))
                .collect(),
        ),
    }
}

/// Source grouping follows owning declarations. Forward dependencies and
/// reverse consumers form one connected project; unrelated app examples do
/// not enter the checked program solely because they share a workspace.
#[derive(Debug, Clone)]
struct ModuleMetadata {
    name: String,
    name_start: u32,
    name_end: u32,
    dependencies: Vec<(String, u32, u32)>,
}

fn project_files(
    db: &SourceDb,
    requesting: SourceId,
    candidates: &[SourceId],
    cache: &RefCell<HashMap<(String, String), Vec<ModuleMetadata>>>,
) -> (Vec<SourceId>, Vec<Diagnostic>) {
    use crate::analysis::resolve::resolve_program;
    // Metadata contains byte coordinates and names, never retained SourceIds
    // or checked programs. Identical immutable bytes can be reused after a
    // SourceDb owner/ID rebuild; every returned span uses the current ID.
    let mut cache = cache.borrow_mut();
    cache.retain(|(path, hash), _| {
        db.lookup(path)
            .and_then(|file| db.get(file))
            .is_some_and(|source| source.sha256 == *hash)
    });
    let mut modules = Vec::new();
    for file in candidates {
        let Some(source) = db.get(*file) else {
            continue;
        };
        let key = (source.path.clone(), source.sha256.clone());
        let metadata = cache.entry(key).or_insert_with(|| {
            let (tree, _) = crate::syntax::parse(db, *file);
            let tables = resolve_program(db, &[(*file, tree)], None, &mut Vec::new());
            tables
                .modules
                .into_iter()
                .map(|module| ModuleMetadata {
                    name: module.name,
                    name_start: module.name_span.start,
                    name_end: module.name_span.end,
                    dependencies: module
                        .imports
                        .into_iter()
                        .filter(|import| import.from.is_none())
                        .map(|import| {
                            (
                                import.provider,
                                import.provider_span.start,
                                import.provider_span.end,
                            )
                        })
                        .chain(
                            module
                                .uses
                                .into_iter()
                                .map(|name| (name, module.name_span.start, module.name_span.end)),
                        )
                        .collect(),
                })
                .collect()
        });
        modules.extend(metadata.iter().cloned().map(|module| (*file, module)));
    }
    let mut providers: HashMap<String, Vec<SourceId>> = HashMap::new();
    for (file, module) in &modules {
        providers
            .entry(module.name.clone())
            .or_default()
            .push(*file);
    }
    let mut selected = std::collections::HashSet::from([requesting]);
    loop {
        let before = selected.len();
        for (file, module) in &modules {
            for (provider, _, _) in &module.dependencies {
                if let Some(files) = providers.get(provider)
                    && files.len() == 1
                {
                    let target = files[0];
                    if selected.contains(file) || selected.contains(&target) {
                        selected.insert(*file);
                        selected.insert(target);
                    }
                }
            }
        }
        if before == selected.len() {
            break;
        }
    }
    let mut diagnostics = Vec::new();
    for (file, module) in modules.iter().filter(|(file, _)| *file == requesting) {
        for (provider, start, end) in &module.dependencies {
            if providers.get(provider).is_some_and(|files| files.len() > 1) {
                diagnostics.push(Diagnostic::error("E2002", format!("workspace import provider '{provider}' has multiple declarations; select an unambiguous workspace"), Span::new(*file, *start, *end)));
            }
        }
        // An ambiguous provider cannot safely rename its exports across consumers.
        if providers
            .get(&module.name)
            .is_some_and(|files| files.len() > 1)
            && modules.iter().any(|(_, consumer)| {
                consumer
                    .dependencies
                    .iter()
                    .any(|(name, _, _)| *name == module.name)
            })
        {
            diagnostics.push(Diagnostic::error(
                "E2002",
                format!(
                    "workspace provider '{}' is ambiguous to its consumers",
                    module.name
                ),
                Span::new(*file, module.name_start, module.name_end),
            ));
        }
    }
    let mut files: Vec<_> = selected.into_iter().collect();
    files.sort();
    (files, diagnostics)
}

fn source_location(
    db: &SourceDb,
    requesting: SourceId,
    uri: &str,
    span: Span,
) -> Option<DocLocation> {
    let source = db.get(span.file)?;
    let uri = if span.file == requesting {
        uri.to_string()
    } else {
        url::Url::from_file_path(&source.path).ok()?.to_string()
    };
    Some(DocLocation {
        uri,
        range: span_to_range(&LineIndex::new(&source.text), &source.text, span),
    })
}

fn local_path(uri: &str) -> Option<PathBuf> {
    url::Url::parse(uri).ok()?.to_file_path().ok()
}

fn owning_root(roots: &[PathBuf], path: &Path) -> Option<usize> {
    roots
        .iter()
        .enumerate()
        .filter(|(_, root)| path.starts_with(root))
        .max_by_key(|(_, root)| root.components().count())
        .map(|(index, _)| index)
}

fn folder_paths(value: Option<&Json>) -> Vec<PathBuf> {
    value
        .and_then(Json::as_arr)
        .into_iter()
        .flatten()
        .filter_map(|folder| local_path(folder.get("uri")?.as_str()?))
        .collect()
}

fn initialize_roots(params: &Json) -> Vec<PathBuf> {
    let mut roots = if params
        .get("workspaceFolders")
        .and_then(Json::as_arr)
        .is_some()
    {
        folder_paths(params.get("workspaceFolders"))
    } else {
        params
            .get("rootUri")
            .and_then(Json::as_str)
            .and_then(local_path)
            .into_iter()
            .collect()
    };
    roots.sort();
    roots.dedup();
    roots
}

/// Project intake excludes hidden directories, dependencies and
/// generated output; explicit workspace roots themselves remain permitted.
/// Symlinks are never traversed, keeping source ownership inside local roots.
fn discover_sources(root: &Path) -> Result<HashMap<String, String>, String> {
    const MAX_FILES: usize = 4096;
    const MAX_DIRECTORIES: usize = 16384;
    const MAX_BYTES: u64 = 64 * 1024 * 1024;
    let mut sources = HashMap::new();
    let mut pending = vec![root.to_path_buf()];
    let mut directories = 0;
    let mut bytes = 0u64;
    while let Some(directory) = pending.pop() {
        directories += 1;
        if directories > MAX_DIRECTORIES {
            return Err(format!(
                "workspace source discovery exceeds {MAX_DIRECTORIES} directories; choose a smaller workspace root"
            ));
        }
        let entries = std::fs::read_dir(&directory).map_err(|error| {
            format!(
                "cannot discover workspace sources in '{}': {error}",
                directory.display()
            )
        })?;
        let mut entries = entries.collect::<Result<Vec<_>, _>>().map_err(|error| {
            format!(
                "cannot read workspace directory '{}': {error}",
                directory.display()
            )
        })?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let kind = entry.file_type().map_err(|error| {
                format!(
                    "cannot inspect workspace source '{}': {error}",
                    entry.path().display()
                )
            })?;
            let path = entry.path();
            if kind.is_dir() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with('.')
                    && !matches!(
                        name.as_ref(),
                        "vendor" | "node_modules" | "target" | "dist" | "build"
                    )
                {
                    pending.push(path);
                }
            } else if kind.is_file() && path.extension().is_some_and(|extension| extension == "can")
            {
                if sources.len() >= MAX_FILES {
                    return Err(format!(
                        "workspace source discovery exceeds {MAX_FILES} .can files; choose a smaller workspace root"
                    ));
                }
                let length = entry
                    .metadata()
                    .map_err(|error| {
                        format!(
                            "cannot inspect workspace source '{}': {error}",
                            path.display()
                        )
                    })?
                    .len();
                bytes = bytes.saturating_add(length);
                if bytes > MAX_BYTES {
                    return Err("workspace source discovery exceeds 64 MiB; choose a smaller workspace root".into());
                }
                // Bound the actual read too: a concurrently grown file cannot
                // bypass the metadata admission above.
                use std::io::Read;
                let mut text = String::new();
                std::fs::File::open(&path)
                    .and_then(|file| {
                        file.take(MAX_BYTES - (bytes - length) + 1)
                            .read_to_string(&mut text)
                    })
                    .map_err(|error| {
                        format!("cannot read workspace source '{}': {error}", path.display())
                    })?;
                bytes = (bytes - length).saturating_add(text.len() as u64);
                if bytes > MAX_BYTES {
                    return Err("workspace source discovery exceeds 64 MiB; choose a smaller workspace root".into());
                }
                let uri = url::Url::from_file_path(&path).map_err(|_| {
                    format!("cannot represent workspace source URI '{}'", path.display())
                })?;
                sources.insert(uri.to_string(), text);
            }
        }
    }
    Ok(sources)
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
    roots: Vec<PathBuf>,
    disk: HashMap<String, String>,
    intake_errors: HashMap<PathBuf, String>,
    closed_diagnostics: HashMap<String, String>,
    project_dirty: bool,
    pending: VecDeque<(String, i32, SourceId)>,
    document_changes: bool,
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
            roots: Vec::new(),
            disk: HashMap::new(),
            intake_errors: HashMap::new(),
            closed_diagnostics: HashMap::new(),
            project_dirty: false,
            pending: VecDeque::new(),
            document_changes: false,
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
    /// notification bodies to send, including the clear on document close.
    /// Drain queued open/change diagnostics with [`Server::pump`].
    pub fn handle_json(&mut self, message: &Json) -> Vec<String> {
        let call = match t::parse_call(message) {
            Ok(call) => call,
            Err(error) => {
                return vec![t::response_err(
                    error.id.as_ref(),
                    t::error_code::INVALID_REQUEST,
                    "not a JSON-RPC call",
                )];
            }
        };
        match call.id {
            Some(id) => self.handle_request(&id, &call.method, call.params.as_ref()),
            None => self.handle_notification(&call.method, call.params.as_ref()),
        }
    }

    /// Publish diagnostics for every enqueued document version that is still
    /// current. Stale versions (superseded by a newer change, or closed)
    /// are cancelled: no notification is emitted for them, ever.
    pub fn pump(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        if self.lifecycle != Lifecycle::Ready || self.exited {
            self.pending.clear();
            return out;
        }
        while let Some((uri, version, source)) = self.pending.pop_front() {
            let current = self
                .docs
                .get(&uri)
                .filter(|doc| doc.version == version && doc.id == source);
            let Some(doc) = current else {
                continue; // Stale or closed: cancelled.
            };
            let mut diagnostics = self.analysis.diagnostics(&self.db, doc.id);
            if let Some(owner) = self
                .db
                .get(doc.id)
                .and_then(|source| owning_root(&self.roots, Path::new(&source.path)))
                && let Some(message) = self.intake_errors.get(&self.roots[owner])
            {
                diagnostics.push(Diagnostic::error(
                    "E7002",
                    message.clone(),
                    Span::new(doc.id, 0, 0),
                ));
            }
            out.push(publish_diagnostics(&uri, version, &doc.text, &diagnostics));
        }
        if self.project_dirty {
            self.project_dirty = false;
            let files: std::collections::HashSet<_> = self
                .docs
                .values()
                .flat_map(|doc| self.analysis.project_sources(&self.db, doc.id))
                .collect();
            let mut current = HashMap::new();
            for file in files {
                let Some(source) = self.db.get(file) else {
                    continue;
                };
                let Ok(uri) = url::Url::from_file_path(&source.path) else {
                    continue;
                };
                let uri = uri.to_string();
                if self.open_uri(&uri).is_some() {
                    continue;
                }
                let diagnostics = self.analysis.diagnostics(&self.db, file);
                let notification =
                    publish_diagnostics_version(&uri, None, &source.text, &diagnostics);
                if self.closed_diagnostics.get(&uri) != Some(&notification) {
                    out.push(notification.clone());
                }
                current.insert(uri, notification);
            }
            for uri in self.closed_diagnostics.keys() {
                if !current.contains_key(uri) && self.open_uri(uri).is_none() {
                    out.push(publish_diagnostics_version(uri, None, "", &[]));
                }
            }
            self.closed_diagnostics = current;
        }
        out
    }

    fn respond_initialize(&mut self, id: &Json, params: Option<&Json>) -> Vec<String> {
        if !valid_params("initialize", params) {
            return vec![t::response_err(
                Some(id),
                t::error_code::INVALID_PARAMS,
                "bad initialize parameters",
            )];
        }
        self.document_changes = params
            .and_then(|p| p.get("capabilities"))
            .and_then(|p| p.get("workspace"))
            .and_then(|p| p.get("workspaceEdit"))
            .and_then(|p| p.get("documentChanges"))
            == Some(&Json::Bool(true));
        self.roots = initialize_roots(params.expect("validated initialize"));
        self.refresh_workspace();
        self.lifecycle = Lifecycle::Ready;
        vec![output::response(id, capabilities())]
    }

    fn check_server_ready(
        &self,
        id: &Json,
        method: &str,
        params: Option<&Json>,
    ) -> Option<Vec<String>> {
        if self.lifecycle == Lifecycle::PreInit {
            return Some(vec![t::response_err(
                Some(id),
                t::error_code::SERVER_NOT_INITIALIZED,
                "initialize first",
            )]);
        }
        if self.lifecycle == Lifecycle::Shutdown {
            return Some(vec![t::response_err(
                Some(id),
                t::error_code::INVALID_REQUEST,
                "server is shut down",
            )]);
        }
        if known_request(method) && !valid_params(method, params) {
            return Some(vec![t::response_err(
                Some(id),
                t::error_code::INVALID_PARAMS,
                "bad method parameters",
            )]);
        }
        None
    }

    fn respond_definition(&self, id: &Json, params: &Json) -> String {
        let target = parse_pos_request(params)
            .and_then(|(uri, pos)| self.doc_id(&uri).map(|doc| (uri, doc, pos)));
        match target {
            Some((uri, doc_id, pos)) => {
                let locations: Vec<_> = self
                    .analysis
                    .definition(&self.db, doc_id, &uri, pos)
                    .into_iter()
                    .map(|mut location| {
                        if let Some(uri) = self.open_uri(&location.uri) {
                            location.uri = uri.to_string();
                        }
                        output::location(location)
                    })
                    .collect();
                output::response(id, locations)
            }
            None => t::response_err(
                Some(id),
                t::error_code::INVALID_PARAMS,
                "unknown document or bad position",
            ),
        }
    }

    fn respond_references(&self, id: &Json, params: &Json) -> String {
        let target = parse_pos_request(params)
            .and_then(|(uri, pos)| self.doc_id(&uri).map(|doc| (uri, doc, pos)));
        match target {
            Some((uri, doc_id, pos)) => {
                let mut references = self.analysis.references(&self.db, doc_id, &uri, pos);
                if params
                    .get("context")
                    .and_then(|c| c.get("includeDeclaration"))
                    == Some(&Json::Bool(false))
                {
                    let declarations = self.analysis.definition(&self.db, doc_id, &uri, pos);
                    references.retain(|reference| {
                        !declarations.iter().any(|declaration| {
                            declaration.uri == reference.uri && declaration.range == reference.range
                        })
                    });
                }
                let locations: Vec<_> = references.into_iter().map(output::location).collect();
                output::response(id, locations)
            }
            None => t::response_err(
                Some(id),
                t::error_code::INVALID_PARAMS,
                "unknown document or bad position",
            ),
        }
    }

    fn rename_refused(&self, uri: &str, doc_id: SourceId, edits: &[FileEdit]) -> bool {
        // Closed sources have no LSP version guard. The editor opens
        // reference targets before requesting rename; refuse atomically
        // if that preflight missed any target or the client cannot guard.
        edits.is_empty()
            || self
                .db
                .get(doc_id)
                .and_then(|source| owning_root(&self.roots, Path::new(&source.path)))
                .is_some_and(|owner| self.intake_errors.contains_key(&self.roots[owner]))
            || (edits.iter().any(|edit| self.open_uri(&edit.uri).is_none()))
            || (edits
                .iter()
                .any(|edit| self.open_uri(&edit.uri) != Some(uri))
                && !self.document_changes)
    }

    fn respond_rename(&self, id: &Json, params: &Json) -> String {
        let target = parse_pos_request(params).and_then(|(uri, pos)| {
            let doc = self.docs.get(&uri)?;
            let name = params.get("newName")?.as_str()?;
            Some((uri, doc.id, doc.version, pos, name))
        });
        match target {
            Some((uri, doc_id, _version, pos, name)) => {
                let edits = self
                    .analysis
                    .rename_files(&self.db, doc_id, &uri, pos, name);
                if self.rename_refused(&uri, doc_id, &edits) {
                    t::response_ok(id, Json::Null)
                } else {
                    output::response(
                        id,
                        output::rename_files(
                            edits
                                .into_iter()
                                .map(|mut edit| {
                                    edit.uri = self
                                        .open_uri(&edit.uri)
                                        .expect("checked rename target")
                                        .to_string();
                                    edit
                                })
                                .collect(),
                            |uri| self.docs.get(uri).map(|doc| doc.version),
                            self.document_changes,
                        ),
                    )
                }
            }
            None => t::response_ok(id, Json::Null),
        }
    }

    fn respond_doc_method(&self, id: &Json, method: &str, params: &Json) -> String {
        match method {
            "textDocument/foldingRange" => match doc_of(params).and_then(|uri| self.doc_id(&uri)) {
                Some(doc_id) => {
                    output::response(id, self.analysis.folding_ranges(&self.db, doc_id))
                }
                None => {
                    t::response_err(Some(id), t::error_code::INVALID_PARAMS, "unknown document")
                }
            },
            "textDocument/selectionRange" => {
                match doc_of(params).and_then(|uri| self.doc_id(&uri)) {
                    Some(doc_id) => output::response(
                        id,
                        self.analysis.selection_ranges(
                            &self.db,
                            doc_id,
                            &parse_selection_positions(params)
                                .expect("validated selection positions"),
                        ),
                    ),
                    None => {
                        t::response_err(Some(id), t::error_code::INVALID_PARAMS, "unknown document")
                    }
                }
            }
            "textDocument/documentSymbol" => {
                match doc_of(params).and_then(|uri| self.doc_id(&uri)) {
                    Some(doc_id) => {
                        output::response(id, self.analysis.document_symbols(&self.db, doc_id))
                    }
                    None => {
                        t::response_err(Some(id), t::error_code::INVALID_PARAMS, "unknown document")
                    }
                }
            }
            "textDocument/formatting" => match doc_of(params).and_then(|uri| self.doc_id(&uri)) {
                Some(doc_id) => {
                    let edits: Vec<_> = self
                        .analysis
                        .formatting(&self.db, doc_id)
                        .into_iter()
                        .map(|edit| lsp::TextEdit {
                            range: output::range(edit.range),
                            new_text: edit.new_text,
                        })
                        .collect();
                    output::response(id, edits)
                }
                None => {
                    t::response_err(Some(id), t::error_code::INVALID_PARAMS, "unknown document")
                }
            },
            "textDocument/semanticTokens/full" => {
                match doc_of(params).and_then(|uri| self.doc_id(&uri)) {
                    Some(doc_id) => output::response(
                        id,
                        output::SemanticTokens {
                            data: self.analysis.semantic_tokens(&self.db, doc_id),
                        },
                    ),
                    None => {
                        t::response_err(Some(id), t::error_code::INVALID_PARAMS, "unknown document")
                    }
                }
            }
            _ => match doc_of(params).and_then(|uri| {
                let doc_id = self.doc_id(&uri)?;
                let range = params.get("range").and_then(parse_range)?;
                Some((uri, doc_id, range))
            }) {
                Some((uri, doc_id, range)) => {
                    let actions: Vec<_> = self
                        .analysis
                        .code_actions(&self.db, doc_id, &uri, range)
                        .into_iter()
                        .map(|action| {
                            output::action(
                                action,
                                |uri| self.docs.get(uri).map(|doc| doc.version),
                                self.document_changes,
                            )
                        })
                        .collect();
                    output::response(id, actions)
                }
                None => t::response_err(
                    Some(id),
                    t::error_code::INVALID_PARAMS,
                    "unknown document or bad range",
                ),
            },
        }
    }

    fn handle_request(&mut self, id: &Json, method: &str, params: Option<&Json>) -> Vec<String> {
        if method == "initialize" {
            return match self.lifecycle {
                Lifecycle::PreInit => self.respond_initialize(id, params),
                _ => vec![t::response_err(
                    Some(id),
                    t::error_code::INVALID_REQUEST,
                    "already initialized",
                )],
            };
        }
        if let Some(early) = self.check_server_ready(id, method, params) {
            return early;
        }
        let absent = Json::Null;
        let params = params.unwrap_or(&absent);
        let response = match method {
            "shutdown" => {
                self.lifecycle = Lifecycle::Shutdown;
                self.pending.clear();
                t::response_ok(id, Json::Null)
            }
            "textDocument/hover" => self.with_pos(params, id, |server, doc_id, pos| {
                server
                    .analysis
                    .hover(&server.db, doc_id, pos)
                    .map(|text| lsp::Hover {
                        contents: lsp::HoverContents::Markup(lsp::MarkupContent {
                            kind: lsp::MarkupKind::Markdown,
                            value: text,
                        }),
                        range: None,
                    })
            }),
            "textDocument/completion" => self.with_pos(params, id, |server, doc_id, pos| {
                server
                    .analysis
                    .completions(&server.db, doc_id, pos)
                    .into_iter()
                    .map(|item| lsp::CompletionItem {
                        kind: item.kind.as_deref().and_then(completion_kind),
                        label: item.label,
                        detail: item.detail,
                        ..Default::default()
                    })
                    .collect::<Vec<_>>()
            }),
            "textDocument/definition" => self.respond_definition(id, params),
            "textDocument/references" => self.respond_references(id, params),
            "textDocument/rename" => self.respond_rename(id, params),
            "textDocument/foldingRange"
            | "textDocument/selectionRange"
            | "textDocument/documentSymbol"
            | "textDocument/formatting"
            | "textDocument/semanticTokens/full"
            | "textDocument/codeAction" => self.respond_doc_method(id, method, params),
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
    fn with_pos<T: serde::Serialize>(
        &mut self,
        params: &Json,
        id: &Json,
        produce: impl FnOnce(&Self, SourceId, TextPos) -> T,
    ) -> String {
        match parse_pos_request(params).and_then(|(uri, pos)| self.doc_id(&uri).map(|d| (d, pos))) {
            Some((doc_id, pos)) => output::response(id, produce(self, doc_id, pos)),
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

    /// Release session history by replacing the private owner with live texts.
    /// Cancel stale work before remapping IDs so a reused numeric ID cannot
    /// revive a superseded task. Existing source owners remain immutable.
    fn retain_live_sources(&mut self) {
        self.pending.retain(|(uri, version, id)| {
            self.docs
                .get(uri)
                .is_some_and(|doc| doc.version == *version && doc.id == *id)
        });
        // Preserve the append order of current snapshots, including the
        // latest-live entry for URI aliases with the same display path.
        let mut ordered: Vec<_> = self.docs.iter_mut().collect();
        ordered.sort_by(|(a_uri, a), (b_uri, b)| (a.id, a_uri).cmp(&(b.id, b_uri)));
        let mut live = SourceDb::new();
        let open_paths: std::collections::HashSet<_> =
            ordered.iter().map(|(uri, _)| uri_to_path(uri)).collect();
        let mut disk: Vec<_> = self.disk.iter().collect();
        disk.sort_by_key(|(uri, _)| *uri);
        for (uri, text) in disk {
            let path = uri_to_path(uri);
            if !open_paths.contains(&path) {
                let _ = live.try_add(path, text.clone());
            }
        }
        for (uri, doc) in ordered {
            // Each text was admitted already, and this fresh owner contains
            // no more sources than the previous admitted owner.
            doc.id = live
                .try_add(uri_to_path(uri), doc.text.clone())
                .expect("live sources retain their admitted text and ID capacity");
        }
        for (uri, _, id) in &mut self.pending {
            *id = self.docs[uri].id;
        }
        self.db = live;
    }

    fn open_uri(&self, uri: &str) -> Option<&str> {
        if let Some((key, _)) = self.docs.get_key_value(uri) {
            return Some(key);
        }
        let path = uri_to_path(uri);
        self.docs
            .iter()
            .find(|(key, _)| uri_to_path(key) == path)
            .map(|(key, _)| key.as_str())
    }

    /// A bounded scan supplies closed sources; overlays always win on rebuild.
    fn refresh_workspace(&mut self) {
        self.project_dirty = true;
        self.disk.clear();
        self.intake_errors.clear();
        for root in &self.roots {
            match discover_sources(root) {
                Ok(sources) => self.disk.extend(sources),
                Err(message) => {
                    self.intake_errors.insert(root.clone(), message);
                }
            }
        }
        self.analysis.workspace_roots(&self.roots);
        self.retain_live_sources();
        self.pending.clear();
        self.pending.extend(
            self.docs
                .iter()
                .map(|(uri, doc)| (uri.clone(), doc.version, doc.id)),
        );
    }

    fn queue_workspace_diagnostics(&mut self) {
        if self.roots.is_empty() {
            return;
        }
        self.project_dirty = true;
        self.pending.clear();
        let mut docs: Vec<_> = self.docs.iter().collect();
        docs.sort_by_key(|(uri, _)| *uri);
        self.pending.extend(
            docs.into_iter()
                .map(|(uri, doc)| (uri.clone(), doc.version, doc.id)),
        );
    }

    fn apply_workspace_folders(&mut self, params: &Json) {
        let Some(event) = params.get("event") else {
            return;
        };
        for root in folder_paths(event.get("removed")) {
            self.roots.retain(|candidate| candidate != &root);
        }
        for root in folder_paths(event.get("added")) {
            if !self.roots.contains(&root) {
                self.roots.push(root);
            }
        }
        self.refresh_workspace();
    }

    fn apply_did_open(&mut self, params: &Json) -> Option<Vec<String>> {
        let doc = params.get("textDocument")?;
        let (Some(uri), Some(version), Some(text)) = (
            doc.get("uri").and_then(Json::as_str),
            doc.get("version").and_then(t::integer_value),
            doc.get("text").and_then(Json::as_str),
        ) else {
            return Some(Vec::new());
        };
        // No-op open (same text already tracked): reuse the live
        // SourceId instead of appending a duplicate snapshot.
        let changed = self.docs.get(uri).is_none_or(|open| open.text != text);
        let id = match self.docs.get(uri) {
            Some(open) if open.text == text => open.id,
            _ => match self.db.try_add(uri_to_path(uri), text.to_string()) {
                Ok(id) => id,
                Err(error) => {
                    return Some(vec![output::notification(
                        "window/logMessage",
                        lsp::LogMessageParams {
                            typ: lsp::MessageType::ERROR,
                            message: error.to_string(),
                        },
                    )]);
                }
            },
        };
        self.docs.insert(
            uri.to_string(),
            OpenDoc {
                version,
                text: text.to_string(),
                id,
            },
        );
        self.pending.push_back((uri.to_string(), version, id));
        if changed {
            self.retain_live_sources();
            self.queue_workspace_diagnostics();
        }
        None
    }

    fn apply_did_change(&mut self, params: &Json) -> Option<Vec<String>> {
        let (Some(selector), Some(version)) = (
            params.get("textDocument"),
            params
                .get("textDocument")
                .and_then(|d| d.get("version"))
                .and_then(t::integer_value),
        ) else {
            return Some(Vec::new());
        };
        let Some(uri) = selector.get("uri").and_then(Json::as_str) else {
            return Some(Vec::new());
        };
        let Some(open) = self.docs.get(uri) else {
            return Some(Vec::new());
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
            return Some(Vec::new());
        };
        // No-op change (identical text): reuse the live SourceId so
        // a keystroke that nets no new text never grows the
        // append-only SourceDb. Versions still advance and the new
        // version is still published; only the snapshot is shared.
        let changed = full != open.text;
        let id = if !changed {
            open.id
        } else {
            match self.db.try_add(uri_to_path(uri), full.to_string()) {
                Ok(id) => id,
                Err(error) => {
                    return Some(vec![output::notification(
                        "window/logMessage",
                        lsp::LogMessageParams {
                            typ: lsp::MessageType::ERROR,
                            message: error.to_string(),
                        },
                    )]);
                }
            }
        };
        self.docs.insert(
            uri.to_string(),
            OpenDoc {
                version,
                text: full.to_string(),
                id,
            },
        );
        self.pending.push_back((uri.to_string(), version, id));
        if changed {
            self.retain_live_sources();
            self.queue_workspace_diagnostics();
        }
        None
    }

    fn apply_did_close(&mut self, params: &Json) -> Vec<String> {
        if let Some(uri) = params
            .get("textDocument")
            .and_then(|d| d.get("uri"))
            .and_then(Json::as_str)
        {
            self.pending.retain(|(queued_uri, _, _)| queued_uri != uri);
            if let Some(doc) = self.docs.remove(uri) {
                if self.roots.is_empty() {
                    self.retain_live_sources();
                } else {
                    self.refresh_workspace();
                }
                return vec![publish_diagnostics(uri, doc.version, &doc.text, &[])];
            }
        }
        Vec::new()
    }

    fn handle_notification(&mut self, method: &str, params: Option<&Json>) -> Vec<String> {
        if method != "exit" && self.lifecycle != Lifecycle::Ready {
            return Vec::new();
        }
        if !valid_params(method, params) {
            return Vec::new();
        }
        let absent = Json::Null;
        let params = params.unwrap_or(&absent);
        match method {
            "initialized" => {}
            "workspace/didChangeWorkspaceFolders" => {
                self.apply_workspace_folders(params);
            }
            "workspace/didChangeWatchedFiles" => {
                if params
                    .get("changes")
                    .and_then(Json::as_arr)
                    .is_some_and(|changes| {
                        changes.iter().any(|change| {
                            change
                                .get("uri")
                                .and_then(Json::as_str)
                                .and_then(local_path)
                                .is_some_and(|path| owning_root(&self.roots, &path).is_some())
                        })
                    })
                {
                    self.refresh_workspace();
                }
            }
            "textDocument/didSave" => {
                if doc_of(params)
                    .and_then(|uri| local_path(&uri))
                    .is_some_and(|path| owning_root(&self.roots, &path).is_some())
                {
                    self.refresh_workspace();
                }
            }
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
                if let Some(out) = self.apply_did_open(params) {
                    return out;
                }
            }
            "textDocument/didChange" => {
                if let Some(out) = self.apply_did_change(params) {
                    return out;
                }
            }
            "textDocument/didClose" => {
                return self.apply_did_close(params);
            }
            _ => {}
        }
        Vec::new()
    }
}

fn capabilities() -> lsp::InitializeResult {
    // The semantic-tokens owner supplies the ordered shared legend.
    let (token_types, token_modifiers) = tokens::legend();
    lsp::InitializeResult {
        capabilities: lsp::ServerCapabilities {
            workspace: Some(lsp::WorkspaceServerCapabilities {
                workspace_folders: Some(lsp::WorkspaceFoldersServerCapabilities {
                    supported: Some(true),
                    change_notifications: Some(lsp::OneOf::Left(true)),
                }),
                file_operations: None,
            }),
            position_encoding: Some(lsp::PositionEncodingKind::UTF16),
            text_document_sync: Some(lsp::TextDocumentSyncCapability::Kind(
                lsp::TextDocumentSyncKind::FULL,
            )),
            hover_provider: Some(lsp::HoverProviderCapability::Simple(true)),
            completion_provider: Some(lsp::CompletionOptions {
                trigger_characters: Some(vec![".".to_string()]),
                ..Default::default()
            }),
            document_symbol_provider: Some(lsp::OneOf::Left(true)),
            document_formatting_provider: Some(lsp::OneOf::Left(true)),
            folding_range_provider: Some(lsp::FoldingRangeProviderCapability::Simple(true)),
            selection_range_provider: Some(lsp::SelectionRangeProviderCapability::Simple(true)),
            definition_provider: Some(lsp::OneOf::Left(true)),
            references_provider: Some(lsp::OneOf::Left(true)),
            rename_provider: Some(lsp::OneOf::Left(true)),
            semantic_tokens_provider: Some(
                lsp::SemanticTokensServerCapabilities::SemanticTokensOptions(
                    lsp::SemanticTokensOptions {
                        legend: lsp::SemanticTokensLegend {
                            token_types: token_types
                                .into_iter()
                                .map(lsp::SemanticTokenType::from)
                                .collect(),
                            token_modifiers: token_modifiers
                                .into_iter()
                                .map(lsp::SemanticTokenModifier::from)
                                .collect(),
                        },
                        full: Some(lsp::SemanticTokensFullOptions::Bool(true)),
                        ..Default::default()
                    },
                ),
            ),
            code_action_provider: Some(lsp::CodeActionProviderCapability::Simple(true)),
            ..Default::default()
        },
        server_info: Some(lsp::ServerInfo {
            name: "can".to_string(),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
        }),
    }
}

fn publish_diagnostics(uri: &str, version: i32, text: &str, diagnostics: &[Diagnostic]) -> String {
    publish_diagnostics_version(uri, Some(version), text, diagnostics)
}

fn publish_diagnostics_version(
    uri: &str,
    version: Option<i32>,
    text: &str,
    diagnostics: &[Diagnostic],
) -> String {
    let index = LineIndex::new(text);
    let diagnostics = diagnostics
        .iter()
        .map(|diagnostic| lsp::Diagnostic {
            range: output::range(span_to_range(&index, text, diagnostic.primary)),
            severity: Some(match diagnostic.severity {
                Severity::Error => lsp::DiagnosticSeverity::ERROR,
                Severity::Warning => lsp::DiagnosticSeverity::WARNING,
                Severity::Info => lsp::DiagnosticSeverity::INFORMATION,
            }),
            code: Some(lsp::NumberOrString::String(diagnostic.code.to_string())),
            source: Some("can".to_string()),
            message: diagnostic.message.clone(),
            ..Default::default()
        })
        .collect();
    output::notification(
        "textDocument/publishDiagnostics",
        output::diagnostics_version(uri, version, diagnostics),
    )
}

fn known_request(method: &str) -> bool {
    matches!(
        method,
        "initialize"
            | "shutdown"
            | "textDocument/hover"
            | "textDocument/completion"
            | "textDocument/definition"
            | "textDocument/references"
            | "textDocument/rename"
            | "textDocument/semanticTokens/full"
            | "textDocument/codeAction"
            | "textDocument/documentSymbol"
            | "textDocument/formatting"
            | "textDocument/foldingRange"
            | "textDocument/selectionRange"
    )
}

fn no_params(params: Option<&Json>) -> bool {
    matches!(params, None | Some(Json::Null))
        || matches!(params, Some(Json::Obj(fields)) if fields.is_empty())
}

fn valid_pos_params(method: &str, params: &Json) -> bool {
    match method {
        "textDocument/hover" | "textDocument/completion" | "textDocument/definition" => {
            parse_pos_request(params).is_some()
        }
        "textDocument/references" => {
            parse_pos_request(params).is_some()
                && matches!(
                    params
                        .get("context")
                        .and_then(|c| c.get("includeDeclaration")),
                    Some(Json::Bool(_))
                )
        }
        "textDocument/rename" => {
            parse_pos_request(params).is_some()
                && params.get("newName").and_then(Json::as_str).is_some()
        }
        _ => false,
    }
}

fn valid_doc_params(method: &str, params: &Json) -> bool {
    match method {
        "textDocument/semanticTokens/full"
        | "textDocument/didClose"
        | "textDocument/foldingRange"
        | "textDocument/documentSymbol" => doc_of(params).is_some(),
        "textDocument/selectionRange" => {
            doc_of(params).is_some() && parse_selection_positions(params).is_some()
        }
        "textDocument/formatting" => {
            doc_of(params).is_some()
                && params.get("options").is_some_and(|options| {
                    options
                        .get("tabSize")
                        .and_then(t::integer_value)
                        .is_some_and(|size| size > 0)
                        && matches!(options.get("insertSpaces"), Some(Json::Bool(_)))
                })
        }
        "textDocument/codeAction" => {
            doc_of(params).is_some()
                && params.get("range").and_then(parse_range).is_some()
                && params
                    .get("context")
                    .and_then(|c| c.get("diagnostics"))
                    .and_then(Json::as_arr)
                    .is_some()
        }
        _ => false,
    }
}

fn valid_sync_params(method: &str, params: &Json) -> bool {
    match method {
        "textDocument/didOpen" => {
            doc_of(params).is_some()
                && params.get("textDocument").is_some_and(|doc| {
                    doc.get("languageId").and_then(Json::as_str).is_some()
                        && doc.get("version").and_then(t::integer_value).is_some()
                        && doc.get("text").and_then(Json::as_str).is_some()
                })
        }
        "textDocument/didChange" => {
            doc_of(params).is_some()
                && params
                    .get("textDocument")
                    .and_then(|doc| doc.get("version"))
                    .and_then(t::integer_value)
                    .is_some()
                && params
                    .get("contentChanges")
                    .and_then(Json::as_arr)
                    .is_some_and(|changes| {
                        changes.iter().all(|change| {
                            matches!(change, Json::Obj(_))
                                && change.get("text").and_then(Json::as_str).is_some()
                                && change
                                    .get("range")
                                    .is_none_or(|range| parse_range(range).is_some())
                                && change.get("rangeLength").is_none_or(|length| {
                                    parse_coord(t::integer_value(length)).is_some()
                                })
                        })
                    })
        }
        _ => false,
    }
}

/// Validate only fields consumed or required by supported methods. Extensions
/// and ignored optional client schemas remain forward-compatible.
fn valid_params(method: &str, params: Option<&Json>) -> bool {
    if matches!(method, "shutdown" | "exit") {
        return no_params(params);
    }
    let Some(params @ Json::Obj(_)) = params else {
        return false;
    };
    match method {
        "initialize" => {
            (matches!(params.get("processId"), Some(Json::Null))
                || params.get("processId").and_then(t::integer_value).is_some())
                && matches!(params.get("rootUri"), Some(Json::Null | Json::Str(_)))
                && matches!(params.get("capabilities"), Some(Json::Obj(_)))
        }
        "initialized" => true,
        "$/cancelRequest" => params.get("id").is_some_and(t::valid_id),
        "textDocument/hover"
        | "textDocument/completion"
        | "textDocument/definition"
        | "textDocument/references"
        | "textDocument/rename" => valid_pos_params(method, params),
        "textDocument/semanticTokens/full"
        | "textDocument/didClose"
        | "textDocument/foldingRange"
        | "textDocument/documentSymbol"
        | "textDocument/selectionRange"
        | "textDocument/formatting"
        | "textDocument/codeAction" => valid_doc_params(method, params),
        "textDocument/didOpen" | "textDocument/didChange" => valid_sync_params(method, params),
        _ => true,
    }
}

fn doc_of(params: &Json) -> Option<String> {
    params
        .get("textDocument")
        .and_then(|d| d.get("uri"))
        .and_then(Json::as_str)
        .map(str::to_string)
}

/// LSP uinteger is nonnegative and bounded by signed 32-bit MAX.
fn parse_coord(value: Option<i32>) -> Option<u32> {
    u32::try_from(value?).ok()
}

fn parse_pos(params: &Json) -> Option<TextPos> {
    let pos = params.get("position")?;
    Some(TextPos {
        line: parse_coord(pos.get("line").and_then(t::integer_value))?,
        character: parse_coord(pos.get("character").and_then(t::integer_value))?,
    })
}

fn parse_range(value: &Json) -> Option<LspRange> {
    let start = value.get("start")?;
    let end = value.get("end")?;
    Some(LspRange {
        start: TextPos {
            line: parse_coord(start.get("line").and_then(t::integer_value))?,
            character: parse_coord(start.get("character").and_then(t::integer_value))?,
        },
        end: TextPos {
            line: parse_coord(end.get("line").and_then(t::integer_value))?,
            character: parse_coord(end.get("character").and_then(t::integer_value))?,
        },
    })
}

fn parse_pos_request(params: &Json) -> Option<(String, TextPos)> {
    Some((doc_of(params)?, parse_pos(params)?))
}

fn parse_selection_positions(params: &Json) -> Option<Vec<lsp::Position>> {
    params
        .get("positions")?
        .as_arr()?
        .iter()
        .map(|position| {
            Some(lsp::Position {
                line: parse_coord(position.get("line").and_then(t::integer_value))?,
                character: parse_coord(position.get("character").and_then(t::integer_value))?,
            })
        })
        .collect()
}

/// Map a document URI to a [`SourceDb`] display path.
///
/// Explicit `file://` forms use native conversion when it yields an exact,
/// usable UTF-8 path. Other forms and unsupported authorities stay verbatim.
/// Document routing and outgoing URI identities never use this display path.
pub fn uri_to_path(uri: &str) -> String {
    super::uri::display_path(uri)
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
/// Framing/admission or other input I/O failures flush prior output and exit
/// with status 1; the stream has no supported resynchronization. Invalid
/// UTF-8/JSON in a complete frame instead receives a parse error and continues.
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
                // Without a trustworthy body boundary, subsequent bytes
                // cannot safely be interpreted as another frame. Flush
                // prior responses and close with a transport failure.
                let _ = writer.flush();
                return 1;
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
