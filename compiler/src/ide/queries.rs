//! Position-based IDE queries over one analyzed document.
//!
//! Every query runs over a [`Snapshot`] (single-document parse plus
//! [`CheckedProgram`] plus [`ResolveTables`]) and returns LSP-ready byte
//! spans; the server converts spans to positions. Queries on
//! unchecked/unknown positions return empty results, never errors and
//! never guesses: a name the analysis did not resolve has no answer
//! here, even when the CST shape looks suggestive.
//!
//! Semantic facts (which declaration a use refers to, which scope is
//! visible, builtin identities) always come from the analysis tables.
//! The CST locates exact tokens and their written receiver/key relationships;
//! checked receiver types and owning declaration tables supply field identities.
//! Written descriptions and annotations are sliced only for display.
//!
//! [`CheckedProgram`]: crate::analysis::CheckedProgram
//! [`ResolveTables`]: crate::analysis::resolve::ResolveTables

use crate::analysis::catalog::{Catalog, CatalogEntry, SigType};
use crate::analysis::resolve::{
    Binding, ModuleId, ResolveTables, ScopeId, SymbolId, SymbolKind, TypeRef, builtin_type_names,
    resolve_program,
};
use crate::analysis::types::ResolvedType;
use crate::analysis::{CheckedProgram, NodeKey, check_program, kids, name_text};
use crate::diagnostic::Diagnostic;
use crate::source::{SourceDb, SourceId, Span};
use crate::syntax::{NodeDetail, SyntaxKind, SyntaxNode};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// One queried document and its selected project analysis.
///
/// [`Snapshot::analyze`] selects one file; [`Snapshot::analyze_files`] selects
/// an isolated project. Per-file query views share immutable checked facts.
pub struct Snapshot<'a> {
    db: &'a SourceDb,
    file: SourceId,
    tree: Arc<SyntaxNode>,
    trees: Arc<Vec<(SourceId, Arc<SyntaxNode>)>>,
    program: Arc<CheckedProgram>,
    tables: Arc<ResolveTables>,
    diagnostics: Arc<Vec<Diagnostic>>,
    locals: Arc<HashMap<NodeKey, (String, LocalKind)>>,
    catalog: Option<&'a Catalog>,
}

/// Hover result: markdown plus the exact name span hovered.
#[derive(Debug, Clone)]
pub struct Hover {
    /// Markdown body.
    pub markdown: String,
    /// Exact name-token span the hover is about.
    pub span: Span,
}

/// One completion candidate.
#[derive(Debug, Clone)]
pub struct Completion {
    /// Label inserted on accept.
    pub label: String,
    /// LSP `CompletionItemKind` name (e.g. `Function`, `Keyword`).
    pub kind: &'static str,
    /// Optional detail shown beside the label.
    pub detail: Option<String>,
}

/// One outline node for document symbols.
#[derive(Debug, Clone)]
pub struct OutlineNode {
    /// Display name.
    pub name: String,
    /// Symbol kind noun (e.g. `model`, `scenario`, `field`).
    pub kind: &'static str,
    /// Declaration-name span.
    pub span: Span,
    /// Enclosing declaration range (the name span when the CST shape is
    /// unexpected).
    pub range: Span,
    /// Nested symbols (fields, parameters, operations).
    pub children: Vec<OutlineNode>,
}

/// Rename result: every span to replace plus a content-hash guard.
#[derive(Debug, Clone)]
pub struct Rename {
    /// Declaration span plus every use span, in source order.
    pub spans: Vec<Span>,
    /// SHA-256 of the analyzed bytes; the rename applies only to text
    /// with this hash.
    pub sha256: String,
}

/// Convert a 0-based LSP position (UTF-16 code units) to a byte offset.
///
/// Returns `None` when the line does not exist. A character past the
/// line end clamps to the line end; a character splitting a scalar
/// clamps back to the scalar start. Mirrors [`LineIndex::to_lsp`]'s
/// CRLF rule: the `\r` of a CRLF break is not an addressable column.
///
/// [`LineIndex::to_lsp`]: crate::source::LineIndex::to_lsp
pub fn offset_at_position(text: &str, line: u32, character: u32) -> Option<u32> {
    let mut offset = 0usize;
    for _ in 0..line {
        let newline = text[offset..].find('\n')?;
        offset += newline + 1;
    }
    let line_end = text[offset..].find('\n').map_or(text.len(), |i| offset + i);
    let mut line_text = &text[offset..line_end];
    if text.as_bytes().get(line_end) == Some(&b'\n') {
        line_text = line_text.strip_suffix('\r').unwrap_or(line_text);
    }
    let mut walked_units = 0u32;
    let mut walked_bytes = 0usize;
    for c in line_text.chars() {
        let units = c.len_utf16() as u32;
        if walked_units + units > character {
            break;
        }
        walked_units += units;
        walked_bytes += c.len_utf8();
    }
    Some((offset + walked_bytes) as u32)
}

/// Local (non-symbol) binding kinds the queries can name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalKind {
    Let,
    QueryAlias,
    ForItem,
    CohortChild,
    CreateAs,
    CallAs,
    SendAs,
    RouteParam,
}

impl LocalKind {
    /// Human noun for hover and completion detail.
    pub fn noun(self) -> &'static str {
        match self {
            LocalKind::Let => "let binding",
            LocalKind::QueryAlias => "query alias",
            LocalKind::ForItem => "for item",
            LocalKind::CohortChild => "cohort child",
            LocalKind::CreateAs => "create binding",
            LocalKind::CallAs => "call binding",
            LocalKind::SendAs => "send binding",
            LocalKind::RouteParam => "route parameter",
        }
    }
}

/// Noun for a symbol kind, used in hover and outline output.
pub fn symbol_noun(kind: &SymbolKind) -> &'static str {
    match kind {
        SymbolKind::Model { .. } => "model",
        SymbolKind::Contract { .. } => "contract",
        SymbolKind::Event { .. } => "event",
        SymbolKind::Role => "role",
        SymbolKind::Capability { .. } => "capability",
        SymbolKind::CapabilityOp { .. } => "capability operation",
        SymbolKind::Message { .. } => "message",
        SymbolKind::Fixture { .. } => "fixture",
        SymbolKind::Scenario { .. } => "scenario",
        SymbolKind::Crud { .. } => "crud",
        SymbolKind::CrudOp { .. } => "crud operation",
        SymbolKind::Field { .. } => "field",
        SymbolKind::Param { .. } => "parameter",
        SymbolKind::DeriveField { .. } => "derived field",
        SymbolKind::DeriveFn { .. } => "derived function",
        SymbolKind::Preferences { .. } => "preferences",
    }
}

/// LSP completion-kind name for a symbol kind.
fn symbol_completion_kind(kind: &SymbolKind) -> &'static str {
    match kind {
        SymbolKind::Model { .. } => "Class",
        SymbolKind::Contract { .. } => "Interface",
        SymbolKind::Event { .. } => "Event",
        SymbolKind::Role => "Enum",
        SymbolKind::Capability { .. } => "Class",
        SymbolKind::CapabilityOp { .. } => "Method",
        SymbolKind::Message { .. } => "Event",
        SymbolKind::Fixture { .. } => "Variable",
        SymbolKind::Scenario { .. } => "Function",
        SymbolKind::Crud { .. } => "Class",
        SymbolKind::CrudOp { .. } => "Method",
        SymbolKind::Field { .. } => "Field",
        SymbolKind::Param { .. } => "Variable",
        SymbolKind::DeriveField { .. } => "Field",
        SymbolKind::DeriveFn { .. } => "Function",
        SymbolKind::Preferences { .. } => "Struct",
    }
}

/// What a query offset resolved to.
enum Target {
    Symbol(SymbolId),
    Local {
        key: NodeKey,
        kind: LocalKind,
        name: String,
        /// Exact name-token span of the declaration, when the CST shape
        /// pinned it down. Rename refuses locals without one.
        decl_span: Option<Span>,
    },
    ImportAlias {
        target: SymbolId,
        declaration: Span,
    },
    Builtin(String),
    Module(ModuleId),
    Scalar(String),
    Predicate,
    Context(String),
    External,
}

/// A resolved query offset plus its exact name span.
struct Resolved {
    target: Target,
    span: Span,
}

impl<'a> Snapshot<'a> {
    /// Analyze one document: parse plus [`check_program`] for diagnostics
    /// and the checked program, plus [`resolve_program`] for the
    /// name/scope tables the position queries read. Never fails: an
    /// unknown file yields empty tables and empty query results.
    pub fn analyze(db: &'a SourceDb, file: SourceId, catalog: Option<&'a Catalog>) -> Self {
        Self::analyze_files(db, file, &[file], catalog)
    }

    /// Analyze the latest version of every source registered in the database.
    pub fn analyze_project(db: &'a SourceDb, file: SourceId, catalog: Option<&'a Catalog>) -> Self {
        let files: Vec<_> = db
            .iter()
            .filter(|(id, source)| db.lookup(&source.path) == Some(*id))
            .map(|(id, _)| id)
            .collect();
        Self::analyze_files(db, file, &files, catalog)
    }

    /// Analyze an explicitly isolated project file set. The requested document
    /// is always included; source identities remain those of the supplied db.
    pub fn analyze_files(
        db: &'a SourceDb,
        file: SourceId,
        files: &[SourceId],
        catalog: Option<&'a Catalog>,
    ) -> Self {
        let mut files = files.to_vec();
        files.push(file);
        files.sort();
        files.dedup();
        let parsed: Vec<_> = files
            .iter()
            .map(|id| (*id, crate::syntax::parse(db, *id).0))
            .collect();
        let (program, diagnostics) = check_program(db, &files, catalog);
        let mut discard = Vec::new();
        let tables = resolve_program(db, &parsed, catalog, &mut discard);
        let locals = index_locals(&tables);
        let trees: Vec<_> = parsed
            .into_iter()
            .map(|(id, tree)| (id, Arc::new(tree)))
            .collect();
        let tree = trees
            .iter()
            .find(|(id, _)| *id == file)
            .expect("requested source included")
            .1
            .clone();
        Self {
            db,
            file,
            tree,
            trees: Arc::new(trees),
            program: Arc::new(program),
            tables: Arc::new(tables),
            diagnostics: Arc::new(diagnostics),
            locals: Arc::new(locals),
            catalog,
        }
    }

    /// Change only the queried document, sharing the immutable project facts.
    fn view(&self, file: SourceId) -> Option<Self> {
        let tree = self.trees.iter().find(|(id, _)| *id == file)?.1.clone();
        Some(Self {
            db: self.db,
            file,
            tree,
            trees: self.trees.clone(),
            program: self.program.clone(),
            tables: self.tables.clone(),
            diagnostics: self.diagnostics.clone(),
            locals: self.locals.clone(),
            catalog: self.catalog,
        })
    }

    fn candidate_db(&self, edits: &[Span], new_text: &str) -> SourceDb {
        let mut db = SourceDb::new();
        for (file, source) in self.db.iter() {
            let mut text = source.text.clone();
            for span in edits.iter().rev().filter(|span| span.file == file) {
                text.replace_range(span.start as usize..span.end as usize, new_text);
            }
            let candidate_file = db.add(source.path.clone(), text);
            debug_assert_eq!(candidate_file, file);
        }
        db
    }

    fn candidate_snapshot<'b>(&self, db: &'b SourceDb) -> Snapshot<'b>
    where
        'a: 'b,
    {
        let files: Vec<_> = self.trees.iter().map(|(file, _)| *file).collect();
        Snapshot::analyze_files(db, self.file, &files, self.catalog)
    }

    /// Analyzed file identity.
    pub fn file(&self) -> SourceId {
        self.file
    }

    /// Analyzed source text (`""` for an unknown file).
    pub fn text(&self) -> &'a str {
        self.db.get(self.file).map_or("", |s| s.text.as_str())
    }

    /// SHA-256 of the analyzed bytes (`""` for an unknown file).
    pub fn sha256(&self) -> &str {
        self.db.get(self.file).map_or("", |s| s.sha256.as_str())
    }

    /// Parse tree of the analyzed text.
    pub fn tree(&self) -> &SyntaxNode {
        &self.tree
    }

    /// Checked program (modules, symbols, types).
    pub fn program(&self) -> &CheckedProgram {
        &self.program
    }

    /// Resolution tables (bindings, scopes, type references).
    pub fn tables(&self) -> &ResolveTables {
        &self.tables
    }

    /// Analysis diagnostics for the document.
    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    /// Local binding indexed under a construct key, if any.
    pub(crate) fn local_at(&self, key: &NodeKey) -> Option<&(String, LocalKind)> {
        self.locals.get(key)
    }

    /// Hover markdown for a byte offset, if the offset names something
    /// the analysis resolved.
    pub fn hover_at(&self, offset: u32) -> Option<Hover> {
        let resolved = self.resolve_at(offset)?;
        let markdown = match &resolved.target {
            Target::Symbol(id) | Target::ImportAlias { target: id, .. } => self.symbol_hover(*id),
            Target::Local { kind, name, .. } => {
                let mut body = format!("**{name}** — {}", kind.noun());
                if let Some(ty) = self.type_at_offset(offset) {
                    body.push_str(&format!("\n\ntype: `{ty}`"));
                }
                body
            }
            Target::Builtin(id) => self.builtin_hover(id),
            Target::Module(mid) => {
                let module = &self.tables.modules[mid.0 as usize];
                let noun = match module.kind {
                    crate::analysis::resolve::ModuleKind::Package => "package",
                    _ => "app",
                };
                let mut body = format!("**{}** — {noun}", module.name);
                if let Some(doc) = self.description_of(module.name_span) {
                    body.push_str(&format!("\n\n{doc}"));
                }
                body
            }
            Target::Scalar(name) => format!("**{name}** — builtin scalar type"),
            Target::Predicate => {
                "actor predicate (`members`, `owner`, `authenticated`, `public`)".to_string()
            }
            Target::Context(noun) => format!("contextual fact ({noun})"),
            Target::External => {
                "bound import from an external provider (opaque to analysis)".to_string()
            }
        };
        Some(Hover {
            markdown,
            span: resolved.span,
        })
    }

    /// Go-to-definition spans for a byte offset (empty when unresolved).
    pub fn definition_at(&self, offset: u32) -> Vec<Span> {
        match self.resolve_at(offset) {
            Some(Resolved {
                target: Target::Symbol(id) | Target::ImportAlias { target: id, .. },
                ..
            }) => vec![self.tables.symbols[id.0 as usize].span],
            Some(Resolved {
                target: Target::Local { key, decl_span, .. },
                ..
            }) => vec![decl_span.unwrap_or_else(|| Span::new(key.file, key.start, key.end))],
            Some(Resolved {
                target: Target::Module(mid),
                ..
            }) => vec![self.tables.modules[mid.0 as usize].name_span],
            _ => Vec::new(),
        }
    }

    /// Reference spans (declaration plus every use, in source order) for
    /// a byte offset (empty when unresolved).
    pub fn references_at(&self, offset: u32) -> Vec<Span> {
        match self.resolve_at(offset) {
            Some(Resolved {
                target: Target::Symbol(id),
                ..
            }) => self.symbol_uses(id),
            Some(Resolved {
                target: Target::ImportAlias { declaration, .. },
                ..
            }) => self.alias_uses(declaration),
            Some(Resolved {
                target: Target::Local { key, decl_span, .. },
                ..
            }) => {
                let mut spans = decl_span.into_iter().collect::<Vec<_>>();
                spans.extend(self.local_uses(&key));
                sort_spans(&mut spans);
                spans
            }
            _ => Vec::new(),
        }
    }

    /// Rename spans plus the content-hash guard, or `None` when the
    /// offset names nothing renamable (unresolved names, builtins,
    /// contextual facts, modules and external references are refused).
    pub fn rename_at(&self, offset: u32) -> Option<Rename> {
        let spans = match self.resolve_at(offset)? {
            Resolved {
                target: Target::Symbol(id),
                ..
            } => self.symbol_uses(id),
            Resolved {
                target: Target::ImportAlias { declaration, .. },
                ..
            } => self.alias_uses(declaration),
            Resolved {
                target: Target::Local { key, decl_span, .. },
                ..
            } => {
                let decl_span = decl_span?;
                let mut spans = vec![decl_span];
                spans.extend(self.local_uses(&key));
                sort_spans(&mut spans);
                spans
            }
            _ => return None,
        };
        if spans.is_empty() {
            return None;
        }
        Some(Rename {
            spans,
            sha256: self.sha256().to_string(),
        })
    }

    /// Validate a rename against a freshly analyzed candidate. Every existing
    /// resolved name must keep its declaration identity, including names outside
    /// the edit set. This catches duplicate declarations and silent capture.
    /// Existing unrelated partial-buffer diagnostics may remain unchanged.
    fn check_rename_diagnostics(
        &self,
        candidate: &Snapshot<'_>,
        translate: &impl Fn(SourceId, u32) -> u32,
    ) -> bool {
        let mut remaining: HashMap<_, usize> = HashMap::new();
        for diagnostic in self.diagnostics.iter() {
            *remaining
                .entry((
                    diagnostic.code,
                    diagnostic.primary.file,
                    translate(diagnostic.primary.file, diagnostic.primary.start),
                ))
                .or_default() += 1;
        }
        for diagnostic in candidate.diagnostics.iter() {
            let Some(count) = remaining.get_mut(&(
                diagnostic.code,
                diagnostic.primary.file,
                diagnostic.primary.start,
            )) else {
                return false;
            };
            if *count == 0 {
                return false;
            }
            *count -= 1;
        }
        true
    }

    fn check_rename_identities(
        &self,
        candidate: &Snapshot<'_>,
        _rename: &Rename,
        translate: &impl Fn(SourceId, u32) -> u32,
        original_name: &str,
    ) -> bool {
        for (file, tree) in self.trees.iter() {
            let Some(before_view) = self.view(*file) else {
                return false;
            };
            let Some(after_view) = candidate.view(*file) else {
                return false;
            };
            for node in tree.descendants().filter(|n| n.kind == SyntaxKind::Name) {
                let before = before_view.resolve_at(node.span.start);
                let after = after_view.resolve_at(translate(*file, node.span.start));
                match (before, after) {
                    (Some(before), Some(after)) => {
                        if self.target_identity(&before.target, translate)
                            != candidate.target_identity(&after.target, &|_, n| n)
                        {
                            return false;
                        }
                    }
                    (None, None) => {
                        // Same-spelled unclaimed tokens may be incomplete member
                        // or selector uses; their identity cannot be certified.
                        if name_text(node, before_view.text()) == Some(original_name) {
                            return false;
                        }
                    }
                    _ => return false,
                }
            }
        }
        true
    }

    fn check_rename_spans(
        candidate: &Snapshot<'_>,
        rename: &Rename,
        translate: &impl Fn(SourceId, u32) -> u32,
        new_name: &str,
    ) -> bool {
        // Each edit must remain exactly one name token (reject punctuation,
        // whitespace, keywords, and lexer-invalid names even in partial input).
        for span in &rename.spans {
            let start = translate(span.file, span.start);
            let Some(view) = candidate.view(span.file) else {
                return false;
            };
            if !view.tree.descendants().any(|node| {
                node.kind == SyntaxKind::Name
                    && node.span.start == start
                    && node.span.end == start + new_name.len() as u32
            }) {
                return false;
            }
        }
        true
    }

    pub fn safe_rename_at(&self, offset: u32, new_name: &str) -> Option<Rename> {
        // The parser is the authority on identifiers and reserved words.
        let rename = self.rename_at(offset)?;
        let original = rename.spans.first()?;
        let original_name = self
            .db
            .get(original.file)?
            .text
            .get(original.start as usize..original.end as usize)?;
        let db = self.candidate_db(&rename.spans, new_name);
        let candidate = self.candidate_snapshot(&db);
        let translate = |file: SourceId, offset: u32| {
            translated_offset(file, offset, &rename.spans, new_name.len())
        };
        // Duplicate/poisoned source declarations cannot provide a complete set.
        if self
            .diagnostics
            .iter()
            .any(|d| matches!(d.code, "E2002" | "E2012"))
        {
            return None;
        }
        if !self.check_rename_diagnostics(&candidate, &translate) {
            return None;
        }
        if !self.check_rename_identities(&candidate, &rename, &translate, original_name) {
            return None;
        }
        // Each edit must remain exactly one name token (reject punctuation,
        // whitespace, keywords, and lexer-invalid names even in partial input).
        if !Self::check_rename_spans(&candidate, &rename, &translate, new_name) {
            return None;
        }
        Some(rename)
    }

    fn target_identity(
        &self,
        target: &Target,
        translate: &impl Fn(SourceId, u32) -> u32,
    ) -> String {
        let location = |kind: &str, span: Span| {
            format!(
                "{kind}:{}:{}",
                span.file.0,
                translate(span.file, span.start)
            )
        };
        match target {
            Target::Symbol(id) => {
                let symbol = &self.tables.symbols[id.0 as usize];
                format!(
                    "{}:{}:{}",
                    location("symbol", symbol.span),
                    id.0,
                    symbol_noun(&symbol.kind)
                )
            }
            Target::ImportAlias { declaration, .. } => location("alias", *declaration),
            Target::Local {
                decl_span: Some(span),
                ..
            } => location("local", *span),
            Target::Local { key, .. } => {
                location("local-node", Span::new(key.file, key.start, key.end))
            }
            Target::Module(id) => location("module", self.tables.modules[id.0 as usize].name_span),
            Target::Builtin(id) => format!("builtin:{id}"),
            Target::Scalar(name) => format!("scalar:{name}"),
            Target::Context(name) => format!("context:{name}"),
            Target::Predicate => "predicate".to_string(),
            Target::External => "external".to_string(),
        }
    }

    /// Scope-aware completion candidates for a byte offset: visible
    /// scope bindings, same-module symbols, catalog builtins and
    /// keywords for the GRAMMAR position. Sorted by label; never fails.
    fn collect_scope_completions(
        &self,
        offset: u32,
        type_position: bool,
        push: &mut dyn FnMut(&str, &'static str, Option<String>),
    ) {
        // Expression scope at the offset, else the module scope.
        let Some(scope) = self.scope_at(offset) else {
            return;
        };
        let mut bindings: Vec<(&String, _)> = Vec::new();
        let mut current = Some(scope);
        while let Some(id) = current {
            let Some(scope_data) = self.tables.scopes.get(id.0 as usize) else {
                break;
            };
            for (name, binding) in &scope_data.bindings {
                if !type_position && self.binding_visible_at(binding, offset) {
                    bindings.push((name, binding));
                }
            }
            current = scope_data.parent;
        }
        bindings.sort_by(|a, b| a.0.cmp(b.0));
        bindings.dedup_by(|a, b| a.0 == b.0);
        for (name, binding) in bindings {
            push(
                name,
                binding_completion_kind(binding, &self.tables),
                binding_detail(binding, &self.tables),
            );
        }
    }

    fn collect_module_completions(
        &self,
        offset: u32,
        type_position: bool,
        push: &mut dyn FnMut(&str, &'static str, Option<String>),
    ) {
        // Same-module symbols.
        let Some(module) = self.module_at(offset) else {
            return;
        };
        let mut names: Vec<(&String, &crate::analysis::resolve::ScopedName)> = self
            .tables
            .module_scopes
            .get(module.0 as usize)
            .map(|s| s.prod.iter().collect())
            .unwrap_or_default();
        names.sort_by(|a, b| a.0.cmp(b.0));
        for (name, scoped) in names {
            if type_position && !self.scoped_type_candidate(scoped) {
                continue;
            }
            let (kind, detail) = scoped_completion(scoped, &self.tables);
            push(name, kind, detail);
        }
    }

    fn collect_catalog_completions(
        &self,
        type_position: bool,
        push: &mut dyn FnMut(&str, &'static str, Option<String>),
    ) {
        // Catalog builtins (callable entries only, read-only).
        if type_position {
            return;
        }
        let Some(catalog) = self.catalog() else {
            return;
        };
        for id in catalog.ids() {
            if catalog.is_builtin(id)
                && let Some(entry) = catalog.lookup(id)
            {
                push(id, "Function", Some(builtin_signatures(entry).join("; ")));
            }
        }
    }

    pub fn completions_at(&self, offset: u32) -> Vec<Completion> {
        let text = self.text();
        if offset as usize > text.len() || !text.is_char_boundary(offset as usize) {
            return Vec::new();
        }
        if self.non_code_completion_position(offset) {
            return Vec::new();
        }
        if let Some(items) = self.empty_annotation_completions(offset) {
            return items;
        }
        if let Some(fields) = self.member_completions(offset) {
            return fields;
        }
        if let Some(items) = self.blank_statement_completions(offset) {
            return items;
        }
        if let Some(cases) = self.match_case_completions(offset) {
            return cases;
        }
        let type_position = named_type_position(&self.tree, text, offset);
        let mut out: Vec<Completion> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut push = |label: &str, kind: &'static str, detail: Option<String>| {
            if seen.insert(label.to_string()) {
                out.push(Completion {
                    label: label.to_string(),
                    kind,
                    detail,
                });
            }
        };
        self.collect_scope_completions(offset, type_position, &mut push);
        self.collect_module_completions(offset, type_position, &mut push);
        self.collect_catalog_completions(type_position, &mut push);
        // Keywords for the syntactic position.
        let keywords = if type_position {
            type_keywords()
        } else {
            keywords_at(&self.tree, text, offset)
        };
        for keyword in keywords {
            push(keyword, "Keyword", None);
        }
        out.sort_by(|a, b| a.label.cmp(&b.label));
        out
    }

    /// Completion edits code. Prose and literal content never enter recovery,
    /// even when the text happens to end in a receiver-like `name.`.
    fn non_code_completion_position(&self, offset: u32) -> bool {
        let leaf = chain_at(&self.tree, offset).last().copied();
        if leaf.is_some_and(|node| {
            matches!(
                node.kind,
                SyntaxKind::Comment | SyntaxKind::Description | SyntaxKind::String
            )
        }) {
            return true;
        }
        let Some(previous) = offset
            .checked_sub(1)
            .and_then(|previous| chain_at(&self.tree, previous).last().copied())
        else {
            return false;
        };
        if previous.span.end != offset {
            return false;
        }
        match previous.kind {
            SyntaxKind::Comment | SyntaxKind::Description => true,
            SyntaxKind::String => {
                matches!(&previous.detail, NodeDetail::Token(token) if token.string_value.is_none())
            }
            _ => false,
        }
    }

    /// Match the types pass's bare-symbol admission, including generated
    /// judgment records and opaque imports whose schemas belong to providers.
    fn scoped_type_candidate(&self, scoped: &crate::analysis::resolve::ScopedName) -> bool {
        use crate::analysis::resolve::ScopedName;
        let id = match scoped {
            ScopedName::Local(id) | ScopedName::Imported { target: id, .. } => *id,
            ScopedName::External { .. } => return true,
        };
        self.tables.judgment_generated_symbols.contains(&id)
            || matches!(
                self.tables.symbols[id.0 as usize].kind,
                SymbolKind::Model { .. }
                    | SymbolKind::Contract { .. }
                    | SymbolKind::Event { .. }
                    | SymbolKind::Preferences { .. }
                    | SymbolKind::Message { .. }
            )
    }

    /// Failed field/parameter parsing retains tokens under Error, without
    /// type wrappers. Recover one missing type after an actual colon token;
    /// the reparsed CST must certify its role before offering type candidates.
    fn empty_annotation_completions(&self, offset: u32) -> Option<Vec<Completion>> {
        let before = self.text().get(..offset as usize)?.trim_end();
        let colon_offset = before.len().checked_sub(1)? as u32;
        let chain = chain_at(&self.tree, colon_offset);
        let colon = chain.last()?.token()?;
        if !colon.is_punct(crate::syntax::Punct::Colon) {
            return None;
        }
        let edit = Span::new(self.file, offset, offset);
        let db = self.candidate_db(&[edit], "text");
        let recovered = self.candidate_snapshot(&db);
        if !named_type_position(&recovered.tree, recovered.text(), offset) {
            return None;
        }
        Some(recovered.completions_at(offset + 1))
    }

    /// Recover an unfinished selector by checking the written receiver on its
    /// own. The resulting fields still come exclusively from its checked type.
    fn member_completions(&self, offset: u32) -> Option<Vec<Completion>> {
        let prefix = self.text().get(..offset as usize)?;
        let selector_start = prefix
            .trim_end()
            .rfind(|c: char| !(c.is_alphanumeric() || c == '_'))?;
        if prefix.as_bytes().get(selector_start) != Some(&b'.') {
            return None;
        }
        let dot_start = if prefix[..selector_start].ends_with('?') {
            selector_start - 1
        } else {
            selector_start
        };
        let chain = chain_at(&self.tree, selector_start as u32);
        if let Some(ty) = chain
            .iter()
            .rev()
            .filter(|n| n.kind == SyntaxKind::Member)
            .find_map(|node| {
                let parts = kids(node);
                if parts.get(1)?.span.start != dot_start as u32 {
                    return None;
                }
                self.program
                    .types
                    .node_types
                    .get(&NodeKey::of(parts.first()?))
            })
        {
            return Some(self.field_completions(ty));
        }
        let selector_end = offset as usize
            + self.text()[offset as usize..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .map(char::len_utf8)
                .sum::<usize>();
        let edit = Span::new(self.file, dot_start as u32, selector_end as u32);
        let db = self.candidate_db(&[edit], "");
        let recovered = self.candidate_snapshot(&db);
        let chain = chain_at(&recovered.tree, dot_start.checked_sub(1)? as u32);
        let ty = chain
            .iter()
            .rev()
            .find_map(|n| recovered.program.types.node_types.get(&NodeKey::of(n)));
        let Some(ty) = ty else {
            return Some(Vec::new());
        };
        Some(recovered.field_completions(ty))
    }

    fn field_completions(&self, ty: &ResolvedType) -> Vec<Completion> {
        let mut out: Vec<_> = self
            .fields_for_type(ty)
            .into_iter()
            .map(|id| {
                let symbol = &self.tables.symbols[id.0 as usize];
                Completion {
                    label: symbol.name.clone(),
                    kind: "Field",
                    detail: self
                        .program
                        .types
                        .symbol_types
                        .get(&id)
                        .map(|ty| ty.display(&self.tables, symbol.module)),
                }
            })
            .collect();
        out.sort_by(|a, b| a.label.cmp(&b.label));
        out
    }

    /// Trailing trivia lies outside the CST block span. Recover an empty
    /// statement only when the blank line directly continues a written do block.
    fn blank_statement_completions(&self, offset: u32) -> Option<Vec<Completion>> {
        let text = self.text();
        let before = text.get(..offset as usize)?;
        let line_start = before.rfind('\n').map_or(0, |i| i + 1);
        let line_end = text[offset as usize..]
            .find('\n')
            .map_or(text.len(), |i| offset as usize + i);
        let line = &text[line_start..line_end];
        if !line.trim().is_empty() {
            return None;
        }
        let block = self
            .tree
            .descendants()
            .filter(|n| {
                n.kind == SyntaxKind::DoBlock
                    && n.span.end <= offset
                    && text[n.span.end as usize..offset as usize].trim().is_empty()
            })
            .max_by_key(|n| n.span.end)?;
        let block_line = text[..block.span.start as usize]
            .rfind('\n')
            .map_or(0, |i| i + 1);
        let block_indent = text[block_line..]
            .chars()
            .take_while(|c| *c == ' ' || *c == '\t')
            .count();
        let line_indent = line.chars().take_while(|c| *c == ' ' || *c == '\t').count();
        if line_indent <= block_indent {
            return None;
        }
        let insertion = line_start
            + line
                .chars()
                .take_while(|c| *c == ' ' || *c == '\t')
                .map(char::len_utf8)
                .sum::<usize>();
        let statement = "let __can_completion=0";
        let edit = Span::new(self.file, insertion as u32, insertion as u32);
        let db = self.candidate_db(&[edit], statement);
        let recovered = self.candidate_snapshot(&db);
        Some(recovered.completions_at((insertion + statement.len() - 1) as u32))
    }

    fn fields_for_type(&self, ty: &ResolvedType) -> Vec<SymbolId> {
        match ty {
            ResolvedType::Nullable(inner) => self.fields_for_type(inner),
            ResolvedType::Record { symbol, .. } => {
                self.tables.symbols[symbol.0 as usize].fields_of().to_vec()
            }
            _ => Vec::new(),
        }
    }

    fn field_named(&self, ty: &ResolvedType, name: &str) -> Option<SymbolId> {
        let mut fields = self
            .fields_for_type(ty)
            .into_iter()
            .filter(|id| self.tables.symbols[id.0 as usize].name == name);
        let field = fields.next()?;
        if fields.next().is_some() {
            return None;
        }
        Some(field)
    }

    /// Associate exact member and object-key tokens with declared fields using
    /// checked receiver/target types, never a global same-spelled name lookup.
    fn typed_member_field(
        &self,
        parent: &SyntaxNode,
        name: &SyntaxNode,
        word: &str,
    ) -> Option<SymbolId> {
        let parts = kids(parent);
        if parts.get(2)?.span != name.span {
            return None;
        }
        let receiver = parts.first()?;
        let ty = self.program.types.node_types.get(&NodeKey::of(receiver))?;
        self.field_named(ty, word)
    }

    fn typed_path_field(&self, parent: &SyntaxNode, name: &SyntaxNode) -> Option<SymbolId> {
        let segments: Vec<_> = parent
            .children
            .iter()
            .filter(|n| n.kind == SyntaxKind::Name)
            .collect();
        let index = segments.iter().position(|n| n.span == name.span)?;
        if index == 0 {
            return None;
        }
        let binding = self.tables.node_binding.get(&NodeKey::of(segments[0]))?;
        let mut ty = self.binding_value_type(binding)?;
        for segment in segments.iter().take(index + 1).skip(1) {
            let field = self.field_named(&ty, name_text(segment, self.text())?)?;
            if segment.span == name.span {
                return Some(field);
            }
            ty = self.program.types.symbol_types.get(&field)?.clone();
        }
        None
    }

    fn entry_owner_type(&self, owner: &SyntaxNode) -> Option<ResolvedType> {
        match owner.kind {
            SyntaxKind::Set => {
                let path = kids(owner)
                    .into_iter()
                    .find(|n| n.kind == SyntaxKind::Path)?;
                Some(
                    self.program
                        .types
                        .node_types
                        .get(&NodeKey::of(path))?
                        .clone(),
                )
            }
            SyntaxKind::Create => {
                let path = kids(owner)
                    .into_iter()
                    .find(|n| n.kind == SyntaxKind::Path)?;
                Some(ResolvedType::Record {
                    symbol: *self.tables.node_symbol.get(&NodeKey::of(path))?,
                    stored: true,
                })
            }
            SyntaxKind::Construct => Some(
                self.program
                    .types
                    .node_types
                    .get(&NodeKey::of(owner))?
                    .clone(),
            ),
            _ => None,
        }
    }

    fn typed_entry_field(
        &self,
        chain: &[&SyntaxNode],
        parent: &SyntaxNode,
        name: &SyntaxNode,
        word: &str,
    ) -> Option<SymbolId> {
        let parts = kids(parent);
        // Shorthand keys also denote a value binding. A one-token edit
        // cannot rename those two identities independently.
        if parts.len() < 3 || parts.first()?.span != name.span {
            return None;
        }
        let owner = *chain.get(chain.len().checked_sub(4)?)?;
        let ty = self.entry_owner_type(owner)?;
        self.field_named(&ty, word)
    }

    fn typed_field_at(&self, name: &SyntaxNode) -> Option<SymbolId> {
        let chain = chain_at(&self.tree, name.span.start);
        let parent = *chain.get(chain.len().checked_sub(2)?)?;
        let word = name_text(name, self.text())?;
        match parent.kind {
            SyntaxKind::Member => self.typed_member_field(parent, name, word),
            SyntaxKind::Path => self.typed_path_field(parent, name),
            SyntaxKind::ObjectEntry => self.typed_entry_field(&chain, parent, name, word),
            _ => None,
        }
    }

    fn binding_value_type(&self, binding: &Binding) -> Option<ResolvedType> {
        if let Binding::Symbol(id) = binding {
            return self.program.types.symbol_types.get(id).cloned();
        }
        let key = local_binding_key(binding)?;
        if matches!(binding, Binding::Let { .. }) {
            let node = find_node(&self.tree, &key)?;
            return kids(node)
                .into_iter()
                .rev()
                .find_map(|n| self.program.types.node_types.get(&NodeKey::of(n)).cloned());
        }
        self.tables
            .node_binding
            .iter()
            .filter(|(_, other)| local_binding_key(other) == Some(key))
            .filter_map(|(node, _)| {
                self.program
                    .types
                    .node_types
                    .get(node)
                    .map(|ty| (node.start, ty))
            })
            .min_by_key(|(start, _)| *start)
            .map(|(_, ty)| ty.clone())
    }

    fn binding_visible_at(&self, binding: &Binding, offset: u32) -> bool {
        let Some(key) = local_binding_key(binding) else {
            return true;
        };
        let Some((_, kind)) = self.locals.get(&key) else {
            return false;
        };
        let Some(node) = find_node(&self.tree, &key) else {
            return false;
        };
        if matches!(
            kind,
            LocalKind::Let | LocalKind::CreateAs | LocalKind::CallAs | LocalKind::SendAs
        ) {
            return node.span.end <= offset;
        }
        local_name_span(node, *kind, self.text()).is_some_and(|span| span.end <= offset)
    }

    /// Explicit import aliases are local identities. The provider member token
    /// belongs to the exported declaration; changing it must leave aliases intact.
    fn import_alias_at(&self, id: SymbolId, span: Span) -> Option<Span> {
        let module = self.module_at(span.start)?;
        let word = self.text().get(span.start as usize..span.end as usize)?;
        for member in self.tables.modules[module.0 as usize]
            .imports
            .iter()
            .flat_map(|i| &i.members)
        {
            if member.alias != word {
                continue;
            }
            let node = self
                .tree
                .descendants()
                .find(|n| n.kind == SyntaxKind::ImportMember && n.span == member.span)?;
            let parts = kids(node);
            let Some(alias) = parts.get(2) else {
                continue;
            };
            if parts[0].span == span {
                continue;
            }
            let scoped = self.tables.module_scopes[module.0 as usize]
                .prod
                .get(&member.alias)
                .or_else(|| {
                    self.tables.module_scopes[module.0 as usize]
                        .test
                        .get(&member.alias)
                })?;
            if matches!(scoped, crate::analysis::resolve::ScopedName::Imported { target, .. } if *target == id)
            {
                return Some(alias.span);
            }
        }
        None
    }

    /// A case header names the checked subject domain, not lexical bindings.
    fn match_case_completions(&self, offset: u32) -> Option<Vec<Completion>> {
        let chain = chain_at(&self.tree, offset);
        let arm = chain
            .iter()
            .rev()
            .find(|node| node.kind == SyntaxKind::MatchArm)?;
        let parts = kids(arm);
        let (head, label) = (parts.first()?, parts.get(1)?);
        if head.span.start <= offset && offset < head.span.end {
            return Some(vec![Completion {
                label: "case".to_string(),
                kind: "Keyword",
                detail: None,
            }]);
        }
        if offset < head.span.end || offset > label.span.end {
            return None;
        }
        let subject_match = chain
            .iter()
            .rev()
            .find(|node| node.kind == SyntaxKind::Match)?;
        let subject = *kids(subject_match).get(1)?;
        let Some(ResolvedType::Enum { cases, .. }) =
            self.program.types.node_types.get(&NodeKey::of(subject))
        else {
            return Some(Vec::new());
        };
        let occupied: HashSet<_> = kids(subject_match)
            .into_iter()
            .filter(|other| other.kind == SyntaxKind::MatchArm && other.span != arm.span)
            .filter_map(|other| {
                kids(other)
                    .get(1)
                    .and_then(|label| name_text(label, self.text()))
            })
            .collect();
        let mut result: Vec<_> = cases
            .iter()
            .filter(|case| !occupied.contains(case.as_str()))
            .map(|case| Completion {
                label: case.clone(),
                kind: "EnumMember",
                detail: Some("case of the checked match subject".to_string()),
            })
            .collect();
        result.sort_by(|a, b| a.label.cmp(&b.label));
        Some(result)
    }

    /// Document outline: one node per module with its top-level symbols
    /// nested (fields, parameters, operations as children).
    pub fn document_symbols(&self) -> Vec<OutlineNode> {
        let mut roots: Vec<OutlineNode> = Vec::new();
        let mut nested: HashSet<SymbolId> = HashSet::new();
        for symbol in &self.tables.symbols {
            for child in symbol_children(&symbol.kind) {
                nested.insert(child);
            }
        }
        for module in &self.tables.modules {
            if module.file != self.file {
                continue;
            }
            let mut children: Vec<OutlineNode> = Vec::new();
            for symbol in &self.tables.symbols {
                if symbol.module == module.id && !nested.contains(&symbol.id) {
                    children.push(self.outline_symbol(symbol.id));
                }
            }
            children.sort_by_key(|n| (n.span.start, n.span.end));
            roots.push(OutlineNode {
                name: module.name.clone(),
                kind: match module.kind {
                    crate::analysis::resolve::ModuleKind::Package => "package",
                    _ => "app",
                },
                span: module.name_span,
                range: module.span,
                children,
            });
        }
        roots.sort_by_key(|n| (n.span.start, n.span.end));
        roots
    }

    /// Catalog consulted by this snapshot, if any.
    fn catalog(&self) -> Option<&Catalog> {
        self.catalog
    }

    /// Resolve an offset to an analysis-backed target plus its exact
    /// name span. Unchecked names and syntactic positions return `None`;
    /// member/key identities require their checked receiver or target type.
    fn resolve_at(&self, offset: u32) -> Option<Resolved> {
        let mut resolved = self.resolve_at_raw(offset)?;
        if let Target::Symbol(id) = resolved.target
            && let Some(declaration) = self.import_alias_at(id, resolved.span)
        {
            resolved.target = Target::ImportAlias {
                target: id,
                declaration,
            };
        }
        Some(resolved)
    }

    fn resolve_at_raw(&self, offset: u32) -> Option<Resolved> {
        let text = self.text();
        if offset as usize >= text.len() {
            return None;
        }
        let chain = chain_at(&self.tree, offset);
        let deepest = *chain.last()?;
        if deepest.kind == SyntaxKind::Name {
            if let Some(id) = self.typed_field_at(deepest) {
                return Some(Resolved {
                    target: Target::Symbol(id),
                    span: deepest.span,
                });
            }
            if let Some(id) = self.symbol_with_span(deepest.span) {
                return Some(Resolved {
                    target: Target::Symbol(id),
                    span: deepest.span,
                });
            }
            if let Some(mid) = self.module_with_name_span(deepest.span) {
                return Some(Resolved {
                    target: Target::Module(mid),
                    span: deepest.span,
                });
            }
            if let Some(imported) = self.import_member_at(deepest) {
                return Some(imported);
            }
        }
        for node in chain.iter().rev() {
            match node.kind {
                SyntaxKind::NameRef => {
                    let name_span = name_child_span(node).unwrap_or(node.span);
                    return self.binding_target(node, name_span);
                }
                SyntaxKind::Path => return self.path_target(node, offset),
                _ => {}
            }
        }
        if deepest.kind == SyntaxKind::Name {
            // Object shorthand (`{title}`) carries the binding on the
            // `Name` leaf itself rather than on a `NameRef`.
            if let Some(target) = self.binding_target(deepest, deepest.span) {
                return Some(target);
            }
        }
        // Local declaration position (`let n`, `for n in`, `as n`, ...).
        for node in chain.iter().rev() {
            if let Some((name, kind)) = self.locals.get(&NodeKey::of(node)) {
                let decl_span = local_name_span(node, *kind, text);
                match decl_span {
                    Some(span) if span.start <= offset && offset < span.end => {
                        return Some(Resolved {
                            target: Target::Local {
                                key: NodeKey::of(node),
                                kind: *kind,
                                name: name.clone(),
                                decl_span,
                            },
                            span,
                        });
                    }
                    _ => return None,
                }
            }
        }
        None
    }

    /// Target for a `NameRef` (or shorthand `Name`) carrying a binding.
    fn binding_target(&self, node: &SyntaxNode, name_span: Span) -> Option<Resolved> {
        let key = NodeKey::of(node);
        match self.tables.node_binding.get(&key) {
            Some(Binding::Symbol(id)) => Some(Resolved {
                target: Target::Symbol(*id),
                span: name_span,
            }),
            Some(Binding::Builtin { id }) => Some(Resolved {
                target: Target::Builtin(id.clone()),
                span: name_span,
            }),
            Some(Binding::Predicate) => Some(Resolved {
                target: Target::Predicate,
                span: name_span,
            }),
            Some(Binding::Context(var)) => Some(Resolved {
                target: Target::Context(context_noun(var)),
                span: name_span,
            }),
            Some(Binding::External { .. }) => Some(Resolved {
                target: Target::External,
                span: name_span,
            }),
            Some(
                binding @ (Binding::Let { .. }
                | Binding::QueryAlias { .. }
                | Binding::ForItem { .. }
                | Binding::CohortChild { .. }
                | Binding::CreateAs { .. }
                | Binding::CallAs { .. }
                | Binding::SendAs { .. }
                | Binding::RouteParam { .. }),
            ) => {
                let local_key = local_binding_key(binding)?;
                let (name, kind) = self.locals.get(&local_key)?.clone();
                let decl_span = find_node(&self.tree, &local_key)
                    .and_then(|decl| local_name_span(decl, kind, self.text()));
                Some(Resolved {
                    target: Target::Local {
                        key: local_key,
                        kind,
                        name,
                        decl_span,
                    },
                    span: name_span,
                })
            }
            None => {
                let id = match self.tables.node_typeref.get(&key) {
                    Some(TypeRef::Symbol(id)) => Some(*id),
                    _ => self.tables.node_symbol.get(&key).copied(),
                }?;
                Some(Resolved {
                    target: Target::Symbol(id),
                    span: name_span,
                })
            }
            Some(Binding::Error) => None,
        }
    }

    fn path_head_target(
        &self,
        segments: &[&SyntaxNode],
        seg_text: &[&str],
        here: usize,
    ) -> Option<Resolved> {
        // Mutation targets carry the statement-time binding on their
        // head token. The remaining path segments are field selectors.
        if here == 0
            && let Some(target) = self.binding_target(segments[0], segments[0].span)
        {
            return Some(target);
        }
        // A leading package name denotes the module itself.
        if here == 0
            && segments.len() > 1
            && let Some(first) = seg_text.first()
            && let Some(mid) = self.tables.module_by_name.get(*first)
        {
            return Some(Resolved {
                target: Target::Module(*mid),
                span: segments[0].span,
            });
        }
        None
    }

    fn typeref_target(
        typeref: &TypeRef,
        segments: &[&SyntaxNode],
        here: usize,
    ) -> Option<Resolved> {
        match typeref {
            TypeRef::Symbol(id) => {
                if here == segments.len() - 1 {
                    return Some(Resolved {
                        target: Target::Symbol(*id),
                        span: segments[here].span,
                    });
                }
                None
            }
            TypeRef::Scalar(name) => Some(Resolved {
                target: Target::Scalar(name.clone()),
                span: segments[here].span,
            }),
            TypeRef::External => Some(Resolved {
                target: Target::External,
                span: segments[here].span,
            }),
            TypeRef::FieldChain {
                head,
                fields,
                consumed,
            } => {
                let field_base = consumed.saturating_sub(fields.len());
                let head_index = field_base.saturating_sub(1);
                if here == head_index {
                    return Some(Resolved {
                        target: Target::Symbol(*head),
                        span: segments[here].span,
                    });
                }
                if here >= field_base && here < *consumed {
                    let field = fields[here - field_base];
                    return Some(Resolved {
                        target: Target::Symbol(field),
                        span: segments[here].span,
                    });
                }
                None
            }
        }
    }

    fn lone_module_target(&self, segments: &[&SyntaxNode], seg_text: &[&str]) -> Option<Resolved> {
        // A lone package name misused outside a qualified path still
        // denotes the module (the E2001 explains the misuse).
        if segments.len() == 1
            && let Some(only) = seg_text.first()
            && let Some(mid) = self.tables.module_by_name.get(*only)
        {
            return Some(Resolved {
                target: Target::Module(*mid),
                span: segments[0].span,
            });
        }
        None
    }

    /// Target for a `Path` node: type references, declaration paths and
    /// module-qualified segments, mapped per segment.
    fn path_target(&self, node: &SyntaxNode, offset: u32) -> Option<Resolved> {
        let text = self.text();
        let segments: Vec<&SyntaxNode> = node
            .children
            .iter()
            .filter(|c| c.kind == SyntaxKind::Name)
            .collect();
        let here = segments
            .iter()
            .position(|s| s.span.start <= offset && offset < s.span.end)?;
        let key = NodeKey::of(node);
        let seg_text: Vec<&str> = segments.iter().filter_map(|s| name_text(s, text)).collect();
        if let Some(target) = self.path_head_target(&segments, &seg_text, here) {
            return Some(target);
        }
        if let Some(typeref) = self.tables.node_typeref.get(&key) {
            return Self::typeref_target(typeref, &segments, here);
        }
        if let Some(id) = self.tables.node_symbol.get(&key) {
            // Declaration and operation paths denote their symbol in the
            // last segment (`policy Todo`, `Mail.send`, `Pkg.msg`).
            if here == segments.len() - 1 {
                return Some(Resolved {
                    target: Target::Symbol(*id),
                    span: segments[here].span,
                });
            }
            return None;
        }
        self.lone_module_target(&segments, &seg_text)
    }

    /// Resolve an import-member name to its imported symbol via the
    /// resolver's module scopes (span-matched against the recorded
    /// imports, never re-derived).
    fn import_member_at(&self, name: &SyntaxNode) -> Option<Resolved> {
        // Find the enclosing member through the ancestor chain:
        // `ImportMember` nodes carry no resolution entries of their own.
        let chain = chain_at(&self.tree, name.span.start);
        let member_node = chain
            .iter()
            .rev()
            .find(|n| n.kind == SyntaxKind::ImportMember)?;
        let parts = kids(member_node);
        if parts.first().is_none_or(|n| n.span != name.span)
            && parts.get(2).is_none_or(|n| n.span != name.span)
        {
            return None;
        }
        let module = self.module_at(name.span.start)?;
        let entry = self
            .tables
            .modules
            .get(module.0 as usize)?
            .imports
            .iter()
            .flat_map(|import| import.members.iter())
            .find(|m| m.span == member_node.span)?;
        let scoped = self
            .tables
            .module_scopes
            .get(module.0 as usize)?
            .prod
            .get(&entry.alias)
            .or_else(|| {
                self.tables
                    .module_scopes
                    .get(module.0 as usize)?
                    .test
                    .get(&entry.alias)
            })?;
        match scoped {
            crate::analysis::resolve::ScopedName::Local(id)
            | crate::analysis::resolve::ScopedName::Imported { target: id, .. } => Some(Resolved {
                target: Target::Symbol(*id),
                span: name.span,
            }),
            crate::analysis::resolve::ScopedName::External { .. } => Some(Resolved {
                target: Target::External,
                span: name.span,
            }),
        }
    }

    /// Symbol declared exactly at `span`, if any.
    fn symbol_with_span(&self, span: Span) -> Option<SymbolId> {
        self.tables
            .symbols
            .iter()
            .find(|s| s.span == span)
            .map(|s| s.id)
    }

    /// Module named exactly at `span`, if any.
    fn module_with_name_span(&self, span: Span) -> Option<ModuleId> {
        self.tables
            .modules
            .iter()
            .find(|m| m.name_span == span)
            .map(|m| m.id)
    }

    /// Module whose declaration contains `offset`, if any.
    fn module_at(&self, offset: u32) -> Option<ModuleId> {
        self.tables
            .modules
            .iter()
            .filter(|m| m.file == self.file)
            .find(|m| m.span.start <= offset && offset < m.span.end)
            .map(|m| m.id)
    }

    /// Innermost expression scope containing `offset`, if any.
    fn scope_at(&self, offset: u32) -> Option<ScopeId> {
        let chain = chain_at(&self.tree, offset);
        if let Some(scope) = chain
            .iter()
            .rev()
            .find_map(|n| self.tables.expr_scope.get(&NodeKey::of(n)).copied())
        {
            return Some(scope);
        }
        // Whitespace and statement keywords have no expression entry. Borrow
        // the closest expression in the same execution region, then filter its
        // completed bindings by their actual declaration position.
        let region = chain.iter().rev().find(|n| {
            matches!(
                n.kind,
                SyntaxKind::DoBlock
                    | SyntaxKind::MatchArm
                    | SyntaxKind::Scenario
                    | SyntaxKind::View
            )
        })?;
        let region_key = NodeKey::of(region);
        region
            .descendants()
            .filter_map(|node| {
                let scope = self.tables.expr_scope.get(&NodeKey::of(node)).copied()?;
                let ancestors = chain_at(&self.tree, node.span.start);
                let nearest = ancestors.iter().rev().find(|n| {
                    matches!(
                        n.kind,
                        SyntaxKind::DoBlock
                            | SyntaxKind::MatchArm
                            | SyntaxKind::Scenario
                            | SyntaxKind::View
                    )
                })?;
                if NodeKey::of(nearest) != region_key {
                    return None;
                }
                Some((node.span.start.abs_diff(offset), scope))
            })
            .min_by_key(|(distance, _)| *distance)
            .map(|(_, scope)| scope)
    }

    /// Displayed resolved type of the innermost typed node at `offset`.
    fn type_at_offset(&self, offset: u32) -> Option<String> {
        let module = self.module_at(offset)?;
        let chain = chain_at(&self.tree, offset);
        chain.iter().rev().find_map(|n| {
            self.program
                .types
                .node_types
                .get(&NodeKey::of(n))
                .map(|ty| ty.display(&self.tables, module))
        })
    }

    /// Hover body for a symbol: canonical identity, kind noun, written
    /// annotation for typed declarations, and attached description.
    fn symbol_hover(&self, id: SymbolId) -> String {
        let symbol = &self.tables.symbols[id.0 as usize];
        let mut body = format!("**{}** — {}", symbol.canonical, symbol_noun(&symbol.kind));
        if let Some(annotation) = self.declared_annotation(id) {
            body.push_str(&format!("\n\ndeclared: `{annotation}`"));
        }
        if let Some(doc) = self.description_of(symbol.span) {
            body.push_str(&format!("\n\n{doc}"));
        }
        body
    }

    /// Written type annotation of a field/parameter-like symbol, sliced
    /// from source for display (never a resolved type claim).
    fn declared_annotation(&self, id: SymbolId) -> Option<String> {
        let symbol = &self.tables.symbols[id.0 as usize];
        let key = match &symbol.kind {
            SymbolKind::Field { type_node, .. }
            | SymbolKind::Param { type_node, .. }
            | SymbolKind::DeriveField { type_node, .. } => *type_node,
            _ => return None,
        };
        let text = &self.db.get(key.file)?.text;
        let slice = text.get(key.start as usize..key.end as usize)?.trim();
        if slice.is_empty() {
            None
        } else {
            Some(slice.to_string())
        }
    }

    /// Hover body for a catalog builtin (read-only catalog facts).
    fn builtin_hover(&self, id: &str) -> String {
        let mut body = format!("**{id}** — builtin");
        if let Some(catalog) = self.catalog
            && let Some(entry) = catalog.lookup(id)
        {
            for signature in builtin_signatures(entry) {
                body.push_str(&format!("\n\n`{signature}`"));
            }
            body.push_str(&format!("\n\ncatalog `{}`", catalog.version()));
            body.push_str(&format!("\n\neffects: {}", effects_noun(entry.effects)));
            body.push_str(&format!(
                "\navailability: {}",
                availability_noun(entry.availability)
            ));
            if let Some(note) = catalog.deprecation(id) {
                body.push_str(&format!("\n\ndeprecated: {note}"));
            }
        }
        body
    }

    /// Hover description for the declaration named at `span`.
    ///
    /// The checked description slot wins: inline `desc=`, attached `#`,
    /// the legacy `@{desc}` spelling and static message references all
    /// resolve to actual source-language wording there (source language
    /// only; no locale selection). When the slot is absent — an
    /// undescribed declaration, a declaration kind outside the slot, or
    /// a description the checker rejected — fall back to slicing
    /// attached `#` prose from the CST, which keeps shared `see path`
    /// display unchanged outside the slot.
    fn description_of(&self, span: Span) -> Option<String> {
        if span.file != self.file {
            return self.view(span.file)?.description_of(span);
        }
        let chain = chain_at(&self.tree, span.start);
        // The declaration node is the parent of the matched `Name` leaf;
        // the chain runs root-first, so the parent precedes it.
        let name_pos = chain
            .iter()
            .rposition(|n| n.kind == SyntaxKind::Name && n.span == span)?;
        let decl = chain.get(name_pos.checked_sub(1)?)?;
        // D06: the one checked slot carries actual source wording for
        // every spelling, with static references already resolved to
        // their message text. Authored-empty text displays as absent,
        // like blank attached prose below.
        if let Some(source) = self.program.effects.description_source(&NodeKey::of(decl)) {
            return if source.trim().is_empty() {
                None
            } else {
                Some(source.to_string())
            };
        }
        let parent = name_pos
            .checked_sub(2)
            .and_then(|i| chain.get(i))
            .copied()
            .unwrap_or(&self.tree);
        // The attached description is a preceding sibling with only
        // trivia/comments between it and the declaration.
        let mut doc: Option<String> = None;
        for sibling in &parent.children {
            if sibling.span.start >= decl.span.start {
                break;
            }
            match sibling.kind {
                SyntaxKind::Description => {
                    if let NodeDetail::Description { data, .. } = &sibling.detail {
                        doc = Some(description_text(data));
                    }
                }
                SyntaxKind::Trivia | SyntaxKind::Comment => {}
                _ => doc = None,
            }
        }
        doc.filter(|d| !d.trim().is_empty())
    }

    /// Include import source tokens and typed member/key occurrences, while
    /// explicit aliases retain their independent local binding identity.
    fn symbol_uses(&self, id: SymbolId) -> Vec<Span> {
        let mut spans = Vec::new();
        for (file, tree) in self.trees.iter() {
            let Some(view) = self.view(*file) else {
                continue;
            };
            spans.extend(
                tree.descendants()
                    .filter(|n| n.kind == SyntaxKind::Name)
                    .filter_map(|n| match view.resolve_at(n.span.start) {
                        Some(Resolved {
                            target: Target::Symbol(found),
                            span,
                        }) if found == id => Some(span),
                        _ => None,
                    }),
            );
        }
        sort_spans(&mut spans);
        spans
    }

    fn alias_uses(&self, declaration: Span) -> Vec<Span> {
        let mut spans: Vec<_> = self
            .tree
            .descendants()
            .filter(|n| n.kind == SyntaxKind::Name)
            .filter_map(|n| match self.resolve_at(n.span.start) {
                Some(Resolved {
                    target:
                        Target::ImportAlias {
                            declaration: found, ..
                        },
                    span,
                }) if found == declaration => Some(span),
                _ => None,
            })
            .collect();
        sort_spans(&mut spans);
        spans
    }

    /// Every use span of a local binding (shorthand names included).
    fn local_uses(&self, key: &NodeKey) -> Vec<Span> {
        let mut spans = Vec::new();
        for node in self.tree.descendants() {
            let found = match node.kind {
                SyntaxKind::NameRef => self
                    .tables
                    .node_binding
                    .get(&NodeKey::of(node))
                    .and_then(local_binding_key)
                    .is_some_and(|k| &k == key),
                SyntaxKind::Name => self
                    .tables
                    .node_binding
                    .get(&NodeKey::of(node))
                    .and_then(local_binding_key)
                    .is_some_and(|k| &k == key),
                _ => false,
            };
            if found {
                match node.kind {
                    SyntaxKind::NameRef => {
                        if let Some(span) = name_child_span(node) {
                            spans.push(span);
                        }
                    }
                    _ => spans.push(node.span),
                }
            }
        }
        spans
    }

    /// Outline subtree for one symbol.
    fn outline_symbol(&self, id: SymbolId) -> OutlineNode {
        let symbol = &self.tables.symbols[id.0 as usize];
        let mut children: Vec<OutlineNode> = symbol_children(&symbol.kind)
            .iter()
            .map(|child| self.outline_symbol(*child))
            .collect();
        children.sort_by_key(|n| (n.span.start, n.span.end));
        OutlineNode {
            name: symbol.name.clone(),
            kind: symbol_noun(&symbol.kind),
            span: symbol.span,
            range: self.symbol_decl_range(symbol),
            children,
        }
    }

    /// Enclosing declaration range for a symbol (the CST declaration
    /// node when its shape is as expected, else the name span).
    fn symbol_decl_range(&self, symbol: &crate::analysis::resolve::Symbol) -> Span {
        let chain = chain_at(&self.tree, symbol.span.start);
        let kinds = decl_node_kinds(&symbol.kind);
        chain
            .iter()
            .rev()
            .find(|n| {
                kinds.contains(&n.kind)
                    && n.span.start <= symbol.span.start
                    && symbol.span.end <= n.span.end
            })
            .map(|n| n.span)
            .unwrap_or(symbol.span)
    }
}

/// Span of the first `Name` child (trims trivia-carrying wrappers such
/// as `NameRef` and `Path` down to the spelled name).
fn name_child_span(node: &SyntaxNode) -> Option<Span> {
    node.children
        .iter()
        .find(|c| c.kind == SyntaxKind::Name)
        .map(|c| c.span)
}

/// Path from the root to the deepest node covering `offset`.
fn chain_at(tree: &SyntaxNode, offset: u32) -> Vec<&SyntaxNode> {
    let mut chain = vec![tree];
    let mut current = tree;
    loop {
        let next = current
            .children
            .iter()
            .find(|c| c.span.start <= offset && offset < c.span.end);
        match next {
            Some(node) => {
                chain.push(node);
                current = node;
            }
            None => break,
        }
    }
    chain
}

/// Find the CST node with `key`, if present in this tree.
fn find_node<'t>(tree: &'t SyntaxNode, key: &NodeKey) -> Option<&'t SyntaxNode> {
    tree.descendants().find(|n| NodeKey::of(n) == *key)
}

/// Translate source positions across the ordered replacement set. Positions
/// inside a renamed token map to its corresponding candidate token boundary.
fn translated_offset(file: SourceId, offset: u32, spans: &[Span], replacement_len: usize) -> u32 {
    let mut delta = 0i64;
    for span in spans.iter().filter(|span| span.file == file) {
        if offset < span.end {
            break;
        }
        delta += replacement_len as i64 - i64::from(span.end - span.start);
    }
    (i64::from(offset) + delta) as u32
}

/// Sort spans into source order, deduplicated.
fn sort_spans(spans: &mut Vec<Span>) {
    spans.sort_by_key(|s| (s.file, s.start, s.end));
    spans.dedup();
}

// --- Local bindings ---

/// Index every local binding in the scopes by its construct key.
fn index_locals(tables: &ResolveTables) -> HashMap<NodeKey, (String, LocalKind)> {
    let mut locals = HashMap::new();
    for scope in &tables.scopes {
        for (name, binding) in &scope.bindings {
            let (key, kind) = match binding {
                Binding::Let { node } => (*node, LocalKind::Let),
                Binding::QueryAlias { node } => (*node, LocalKind::QueryAlias),
                Binding::ForItem { node } => (*node, LocalKind::ForItem),
                Binding::CohortChild { node, .. } => (*node, LocalKind::CohortChild),
                Binding::CreateAs { node } => (*node, LocalKind::CreateAs),
                Binding::CallAs { node } => (*node, LocalKind::CallAs),
                Binding::SendAs { node } => (*node, LocalKind::SendAs),
                Binding::RouteParam { node } => (*node, LocalKind::RouteParam),
                _ => continue,
            };
            locals.insert(key, (name.clone(), kind));
        }
    }
    locals
}

/// Construct key of a local binding, if it is one.
fn local_binding_key(binding: &Binding) -> Option<NodeKey> {
    match binding {
        Binding::Let { node }
        | Binding::QueryAlias { node }
        | Binding::ForItem { node }
        | Binding::CohortChild { node, .. }
        | Binding::CreateAs { node }
        | Binding::CallAs { node }
        | Binding::SendAs { node }
        | Binding::RouteParam { node } => Some(*node),
        _ => None,
    }
}

/// Exact name-token span of a local declaration construct.
fn local_name_span(node: &SyntaxNode, kind: LocalKind, text: &str) -> Option<Span> {
    let parts = kids(node);
    match kind {
        // `let NAME = ...`
        LocalKind::Let => name_after(&parts, text, "let"),
        // `... as NAME ...` (query clause or first-arg alias clause)
        LocalKind::QueryAlias => name_after(&parts, text, "as"),
        // `for NAME in ...`
        LocalKind::ForItem => name_after(&parts, text, "for"),
        LocalKind::CohortChild => Some(node.span),
        // `create|call ... as NAME`, `send ... as NAME`
        LocalKind::CreateAs | LocalKind::CallAs | LocalKind::SendAs => {
            name_after(&parts, text, "as")
        }
        // `{NAME:type}` route parameter
        LocalKind::RouteParam => parts.iter().find_map(|n| {
            if n.kind == SyntaxKind::Name {
                Some(n.span)
            } else {
                None
            }
        }),
    }
}

/// Span of the `Name` leaf following the `marker` name among siblings.
fn name_after(parts: &[&SyntaxNode], text: &str, marker: &str) -> Option<Span> {
    let mut seen = false;
    for part in parts {
        if seen && part.kind == SyntaxKind::Name {
            return Some(part.span);
        }
        if name_text(part, text) == Some(marker) {
            seen = true;
        }
    }
    None
}

/// Human noun for a contextual binding.
fn context_noun(var: &crate::analysis::resolve::ContextVar) -> String {
    use crate::analysis::resolve::ContextVar;
    match var {
        ContextVar::Actor(_) => "actor".to_string(),
        ContextVar::Team => "team".to_string(),
        ContextVar::Now => "now".to_string(),
        ContextVar::Operation => "operation".to_string(),
        ContextVar::Event => "event payload".to_string(),
        ContextVar::RowModel(_) => "row".to_string(),
        ContextVar::RowQuery { .. } => "query row".to_string(),
        ContextVar::Parent { .. } => "parent".to_string(),
        ContextVar::Preferences { .. } => "preferences".to_string(),
        ContextVar::Result { .. } => "result".to_string(),
        ContextVar::TestAccount(_) => "test account".to_string(),
    }
}

/// Human noun for a catalog effect class.
fn effects_noun(effects: Option<crate::analysis::catalog::Effects>) -> &'static str {
    use crate::analysis::catalog::Effects;
    match effects {
        Some(Effects::Pure) => "pure",
        Some(Effects::ServerDefaultOnly) => "server-default-only",
        Some(Effects::StateRead) => "state-read",
        None => "none",
    }
}

/// Human noun for a catalog availability.
fn availability_noun(availability: crate::analysis::catalog::Availability) -> &'static str {
    use crate::analysis::catalog::Availability;
    match availability {
        Availability::Planned => "planned",
        Availability::Implemented => "implemented",
        Availability::External => "external",
    }
}

/// Decoded description prose for hover display.
fn description_text(data: &crate::syntax::DescriptionData) -> String {
    use crate::syntax::DescriptionData;
    match data {
        DescriptionData::Prose { text, .. } => text.clone(),
        DescriptionData::Reference { path } => format!("see {}", path.join(".")),
    }
}

// --- Outline ---

/// Child symbols nested under a symbol in the outline.
fn symbol_children(kind: &SymbolKind) -> Vec<SymbolId> {
    match kind {
        SymbolKind::Model { fields, .. }
        | SymbolKind::Contract { fields }
        | SymbolKind::Event { fields }
        | SymbolKind::Preferences { fields } => fields.clone(),
        SymbolKind::Capability { ops, events } => {
            let mut children = ops.clone();
            children.extend(events.iter().copied());
            children
        }
        SymbolKind::CapabilityOp { params, .. }
        | SymbolKind::Message { params }
        | SymbolKind::Scenario { params, .. }
        | SymbolKind::DeriveFn { params, .. } => params.clone(),
        // CRUD ops carry only their model link, so they surface as
        // module roots; nothing else nests children.
        _ => Vec::new(),
    }
}

/// CST node kinds that can declare a symbol of `kind`.
fn decl_node_kinds(kind: &SymbolKind) -> Vec<SyntaxKind> {
    match kind {
        SymbolKind::Model { .. } => vec![SyntaxKind::Model],
        SymbolKind::Contract { .. } => vec![SyntaxKind::Contract],
        SymbolKind::Event { .. } => vec![SyntaxKind::Event],
        SymbolKind::Role => vec![SyntaxKind::Role],
        SymbolKind::Capability { .. } => vec![SyntaxKind::Capability],
        SymbolKind::CapabilityOp { .. } => vec![SyntaxKind::CapabilityOp],
        SymbolKind::Message { .. } => vec![SyntaxKind::Message],
        SymbolKind::Fixture { .. } => vec![SyntaxKind::Fixture],
        SymbolKind::Scenario { .. } => vec![SyntaxKind::Scenario],
        SymbolKind::Crud { .. } => vec![SyntaxKind::Crud],
        SymbolKind::CrudOp { .. } => vec![SyntaxKind::Crud],
        SymbolKind::Field { .. } => vec![SyntaxKind::Field],
        SymbolKind::Param { .. } => vec![SyntaxKind::Parameter],
        SymbolKind::DeriveField { .. } | SymbolKind::DeriveFn { .. } => vec![SyntaxKind::Derive],
        SymbolKind::Preferences { .. } => vec![SyntaxKind::Preferences],
    }
}

// --- Completion ---

/// An ordinary type name or reuse path, rather than enum labels or operation
/// targets inside `action(...)`, `delivery(...)` and `invocation(...)`.
fn named_type_position(tree: &SyntaxNode, text: &str, offset: u32) -> bool {
    let in_type = |chain: Vec<&SyntaxNode>| {
        chain
            .iter()
            .any(|node| matches!(node.kind, SyntaxKind::NamedType | SyntaxKind::UnionType))
            && !chain.iter().any(|node| {
                matches!(
                    node.kind,
                    SyntaxKind::EnumType
                        | SyntaxKind::ActionType
                        | SyntaxKind::DeliveryType
                        | SyntaxKind::InvocationType
                )
            })
    };
    in_type(chain_at(tree, offset))
        || (text
            .get(..offset as usize)
            .and_then(|before| before.chars().next_back())
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
            && offset
                .checked_sub(1)
                .is_some_and(|previous| in_type(chain_at(tree, previous))))
}

fn type_keywords() -> Vec<&'static str> {
    let mut keywords = vec!["enum", "action", "delivery", "invocation"];
    keywords.extend(builtin_type_names().iter().copied());
    keywords
}

/// Render the validated catalog schema, including alias and scope suffixes.
/// These are catalog signatures, not reconstructed source annotations.
fn builtin_signatures(entry: &CatalogEntry) -> Vec<String> {
    entry
        .overloads
        .iter()
        .map(|overload| {
            let params = overload
                .params
                .iter()
                .map(|param| {
                    let mut rendered = format!("{}:{}", param.name, signature_type(&param.ty));
                    if let Some(alias) = &param.alias {
                        rendered.push_str(&format!(" as {alias}"));
                    }
                    if let Some(scope) = &param.in_scope {
                        rendered.push_str(&format!(" in {scope} scope"));
                    }
                    rendered
                })
                .collect::<Vec<_>>()
                .join(",");
            format!(
                "{}({params})->{}",
                entry.id,
                signature_type(&overload.result)
            )
        })
        .collect()
}

fn signature_collection_type(ty: &SigType) -> Option<String> {
    match ty {
        SigType::Collection(inner) => Some(format!("C<{}>", signature_type(inner))),
        SigType::NonemptyCollection(inner) => {
            Some(format!("nonempty C<{}>", signature_type(inner)))
        }
        SigType::OrderedCollection(inner) => Some(format!("ordered C<{}>", signature_type(inner))),
        SigType::Nullable(inner) | SigType::Array(inner) => {
            let rendered = signature_type(inner);
            let rendered = if matches!(**inner, SigType::Union(_)) {
                format!("({rendered})")
            } else {
                rendered
            };
            Some(format!(
                "{rendered}{}",
                if matches!(ty, SigType::Nullable(_)) {
                    "?"
                } else {
                    "[]"
                }
            ))
        }
        _ => None,
    }
}

fn signature_type(ty: &SigType) -> String {
    if let Some(rendered) = signature_collection_type(ty) {
        return rendered;
    }
    match ty {
        SigType::Any => "T".into(),
        SigType::Named(name) => name.clone(),
        SigType::Ordered => "O".into(),
        SigType::StringLike => "S".into(),
        SigType::GroupKey => "K".into(),
        SigType::Display => "Display".into(),
        SigType::Union(arms) => arms
            .iter()
            .map(signature_type)
            .collect::<Vec<_>>()
            .join("|"),
        SigType::EnumCases(cases) => format!("enum({})", cases.join(",")),
        SigType::Object(fields) => format!(
            "{{{}}}",
            fields
                .iter()
                .map(|(name, ty)| format!("{name}:{}", signature_type(ty)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        SigType::ClosedDisplayObject => "closed object of Display".into(),
        SigType::Message => "message".into(),
        SigType::ActionTarget => "canonical user mutation".into(),
        SigType::ActionBindings => "closed object of every record parameter".into(),
        SigType::ActionResult => "singleton action(target)".into(),
        SigType::InvocationArgs => "complete owning input object".into(),
        SigType::InvocationResult => "singleton invocation(target)".into(),
        _ => unreachable!("signature_collection_type covers the remaining variants"),
    }
}

/// LSP completion-kind name for a scope binding.
fn binding_completion_kind(binding: &Binding, tables: &ResolveTables) -> &'static str {
    match binding {
        Binding::Symbol(id) => tables
            .symbols
            .get(id.0 as usize)
            .map_or("Variable", |s| symbol_completion_kind(&s.kind)),
        Binding::Builtin { .. } => "Function",
        Binding::Predicate => "Keyword",
        Binding::Context(_) => "Variable",
        Binding::External { .. } => "Variable",
        Binding::Error => "Variable",
        Binding::Let { .. }
        | Binding::QueryAlias { .. }
        | Binding::ForItem { .. }
        | Binding::CohortChild { .. }
        | Binding::CreateAs { .. }
        | Binding::CallAs { .. }
        | Binding::SendAs { .. }
        | Binding::RouteParam { .. } => "Variable",
    }
}

/// Detail string for a scope binding.
fn binding_detail(binding: &Binding, tables: &ResolveTables) -> Option<String> {
    match binding {
        Binding::Symbol(id) => tables
            .symbols
            .get(id.0 as usize)
            .map(|s| s.canonical.clone()),
        Binding::Builtin { .. } => Some("builtin".to_string()),
        Binding::Predicate => Some("predicate".to_string()),
        Binding::Context(var) => Some(context_noun(var)),
        Binding::External { provider, .. } => Some(format!("external ({provider})")),
        Binding::Error => None,
        Binding::Let { .. } => Some(LocalKind::Let.noun().to_string()),
        Binding::QueryAlias { .. } => Some(LocalKind::QueryAlias.noun().to_string()),
        Binding::ForItem { .. } => Some(LocalKind::ForItem.noun().to_string()),
        Binding::CohortChild { .. } => Some(LocalKind::CohortChild.noun().to_string()),
        Binding::CreateAs { .. } => Some(LocalKind::CreateAs.noun().to_string()),
        Binding::CallAs { .. } => Some(LocalKind::CallAs.noun().to_string()),
        Binding::SendAs { .. } => Some(LocalKind::SendAs.noun().to_string()),
        Binding::RouteParam { .. } => Some(LocalKind::RouteParam.noun().to_string()),
    }
}

/// Completion kind and detail for a module-scope name.
fn scoped_completion(
    scoped: &crate::analysis::resolve::ScopedName,
    tables: &ResolveTables,
) -> (&'static str, Option<String>) {
    use crate::analysis::resolve::ScopedName;
    match scoped {
        ScopedName::Local(id) => {
            let symbol = &tables.symbols[id.0 as usize];
            (
                symbol_completion_kind(&symbol.kind),
                Some(symbol.canonical.clone()),
            )
        }
        ScopedName::Imported { target, .. } => {
            let symbol = &tables.symbols[target.0 as usize];
            (
                symbol_completion_kind(&symbol.kind),
                Some(format!("{} (imported)", symbol.canonical)),
            )
        }
        ScopedName::External { provider, .. } => {
            ("Variable", Some(format!("external ({provider})")))
        }
    }
}

/// Keywords valid at the syntactic position of `offset` (GRAMMAR roles).
fn statement_introducer_at(chain: &[&SyntaxNode], text: &str, offset: u32) -> bool {
    // Statement nodes also enclose their expressions. At the written
    // introducer, offer statements; its RHS keeps expression completion.
    chain.iter().any(|node| node.kind == SyntaxKind::DoBlock)
        && chain.iter().any(|node| {
            if !matches!(
                node.kind,
                SyntaxKind::Let
                    | SyntaxKind::Create
                    | SyntaxKind::Set
                    | SyntaxKind::Transition
                    | SyntaxKind::Delete
                    | SyntaxKind::Call
                    | SyntaxKind::Emit
                    | SyntaxKind::Send
                    | SyntaxKind::Schedule
                    | SyntaxKind::Cancel
                    | SyntaxKind::Return
                    | SyntaxKind::Require
                    | SyntaxKind::If
                    | SyntaxKind::For
                    | SyntaxKind::Match
            ) {
                return false;
            }
            kids(node).first().is_some_and(|head| {
                head.kind == SyntaxKind::Name
                    && head.span.start <= offset
                    && offset <= head.span.end
                    && name_text(head, text).is_some_and(|word| effect_keywords().contains(&word))
            })
        })
}

fn action_group_keywords(
    chain: &[&SyntaxNode],
    text: &str,
    offset: u32,
) -> Option<Vec<&'static str>> {
    // Contextual action groups are child introducers, never attribute,
    // field, expression or nested-control vocabulary.
    let before = &text[..offset.min(text.len() as u32) as usize];
    let line_head = before.rsplit('\n').next().unwrap_or("").trim_start();
    if !line_head
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        return None;
    }
    let host = chain.iter().rev().find(|node| {
        matches!(
            node.kind,
            SyntaxKind::Page
                | SyntaxKind::View
                | SyntaxKind::Card
                | SyntaxKind::Details
                | SyntaxKind::Collection
                | SyntaxKind::Form
                | SyntaxKind::Edit
                | SyntaxKind::UiLeaf
                | SyntaxKind::CatalogItem
                | SyntaxKind::Slot
                | SyntaxKind::Tabs
                | SyntaxKind::Tab
                | SyntaxKind::Show
        ) && !kids(node).first().is_some_and(|head| {
            head.kind == SyntaxKind::Name && head.span.start <= offset && offset <= head.span.end
        })
    });
    let word = |node: &SyntaxNode| {
        kids(node)
            .into_iter()
            .find_map(|child| name_text(child, text))
            .unwrap_or("")
    };
    let active_form = chain.iter().any(|node| {
        node.kind == SyntaxKind::Edit || (node.kind == SyntaxKind::Form && word(node) == "form")
    });
    let host = host?;
    if active_form {
        if host.kind == SyntaxKind::Edit || (host.kind == SyntaxKind::Form && word(host) == "form")
        {
            return Some(vec!["primary"]);
        }
        return Some(Vec::new());
    }
    let drawer_details = host.kind == SyntaxKind::Details
        && kids(host).into_iter().any(|attr| {
            attr.kind == SyntaxKind::Attribute
                && word(attr) == "display"
                && kids(attr).into_iter().any(|value| {
                    value.kind == SyntaxKind::NameRef
                        && text[value.span.start as usize..value.span.end as usize].trim()
                            == "drawer"
                })
        });
    let panel_actions = host.kind == SyntaxKind::Slot
        && kids(host)
            .into_iter()
            .filter_map(|child| name_text(child, text))
            .nth(1)
            == Some("actions")
        && chain
            .iter()
            .position(|node| std::ptr::eq(*node, *host))
            .and_then(|index| index.checked_sub(1))
            .and_then(|index| chain.get(index))
            .is_some_and(|parent| {
                parent.kind == SyntaxKind::CatalogItem && matches!(word(parent), "modal" | "drawer")
            });
    if matches!(host.kind, SyntaxKind::Page | SyntaxKind::Card)
        || (host.kind == SyntaxKind::Collection && matches!(word(host), "list" | "table"))
        || drawer_details
        || panel_actions
    {
        return Some(vec!["primary", "secondary"]);
    }
    None
}

fn keywords_at(tree: &SyntaxNode, text: &str, offset: u32) -> Vec<&'static str> {
    let chain = chain_at(tree, offset.min(text.len() as u32));
    // Type position: annotation keywords plus builtin type names.
    if chain.iter().any(|n| {
        matches!(
            n.kind,
            SyntaxKind::NamedType
                | SyntaxKind::UnionType
                | SyntaxKind::ArrayType
                | SyntaxKind::NullableType
                | SyntaxKind::EnumType
                | SyntaxKind::ActionType
                | SyntaxKind::DeliveryType
                | SyntaxKind::InvocationType
        )
    }) {
        return type_keywords();
    }
    if statement_introducer_at(&chain, text, offset) {
        return effect_keywords();
    }
    // Expression position: operators, literals and query clauses.
    if chain.iter().any(|n| {
        matches!(
            n.kind,
            SyntaxKind::NameRef
                | SyntaxKind::Member
                | SyntaxKind::Binary
                | SyntaxKind::Unary
                | SyntaxKind::Query
                | SyntaxKind::QueryClause
                | SyntaxKind::Group
                | SyntaxKind::Array
                | SyntaxKind::Object
                | SyntaxKind::ObjectEntry
                | SyntaxKind::Construct
                | SyntaxKind::Literal
                | SyntaxKind::Argument
                | SyntaxKind::Let
                | SyntaxKind::Return
                | SyntaxKind::Require
                | SyntaxKind::If
                | SyntaxKind::For
        )
    }) {
        return vec![
            "and", "or", "not", "in", "is", "true", "false", "null", "as", "where", "select",
            "order", "archived", "include",
        ];
    }
    // A statement slot inside a do body takes precedence over its section.
    if chain.iter().any(|node| node.kind == SyntaxKind::DoBlock) {
        return effect_keywords();
    }
    // Contextual action groups are child introducers, never attribute,
    // field, expression or nested-control vocabulary.
    if let Some(group) = action_group_keywords(&chain, text, offset) {
        return group;
    }
    // Section body: declaration introducers for the enclosing section.
    if let Some(marker) = enclosing_section_marker(tree, text, offset) {
        return match marker {
            "Given" => vec![
                "contract",
                "event",
                "role",
                "derive",
                "policy",
                "invariant",
                "unique",
                "lock",
                "retain",
                "fixture",
                "capability",
                "message",
                "export",
            ],
            "When" => vec!["scenario", "crud", "export"],
            "Then" => vec!["preferences", "page"],
            _ => Vec::new(),
        };
    }
    // Effect body or unknown position: effect introducers plus the
    // expression keywords (a superset is honest here: every listed word
    // is a real GRAMMAR word for some nearby slot).
    effect_keywords()
}

fn effect_keywords() -> Vec<&'static str> {
    vec![
        "let", "do", "require", "if", "else", "for", "match", "create", "set", "delete", "call",
        "emit", "send", "schedule", "cancel", "return", "in", "limit", "and", "or", "not", "is",
        "true", "false", "null",
    ]
}

/// Section marker (`Given`/`When`/`Then`) enclosing `offset`, if any.
fn enclosing_section_marker<'t>(tree: &SyntaxNode, text: &'t str, offset: u32) -> Option<&'t str> {
    let chain = chain_at(tree, offset.min(text.len() as u32));
    let section = chain.iter().rev().find(|n| n.kind == SyntaxKind::Section)?;
    kids(section).iter().find_map(|n| name_text(n, text))
}
