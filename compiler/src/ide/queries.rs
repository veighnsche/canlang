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
//! The CST is used only for spans and positions: trimming a use site to
//! its name token, locating a declaration's name token, or slicing the
//! written text of a description or type annotation for display.
//!
//! [`CheckedProgram`]: crate::analysis::CheckedProgram
//! [`ResolveTables`]: crate::analysis::resolve::ResolveTables

use crate::analysis::catalog::Catalog;
use crate::analysis::resolve::{
    Binding, ModuleId, ResolveTables, ScopeId, SymbolId, SymbolKind, TypeRef, builtin_type_names,
    resolve_program,
};
use crate::analysis::types::ResolvedType;
use crate::analysis::{CheckedProgram, NodeKey, check_program};
use crate::diagnostic::Diagnostic;
use crate::source::{SourceDb, SourceId, Span};
use crate::syntax::{NodeDetail, SyntaxKind, SyntaxNode};
use std::collections::{HashMap, HashSet};

/// One analyzed document: everything the queries read.
///
/// Built with [`Snapshot::analyze`]; queries are methods on it. The
/// snapshot borrows the [`SourceDb`] for text and owns its parse tree,
/// checked program and resolution tables.
pub struct Snapshot<'a> {
    db: &'a SourceDb,
    file: SourceId,
    tree: SyntaxNode,
    program: CheckedProgram,
    tables: ResolveTables,
    diagnostics: Vec<Diagnostic>,
    locals: HashMap<NodeKey, (String, LocalKind)>,
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
        let (tree, _) = crate::syntax::parse(db, file);
        let (program, diagnostics) = check_program(db, &[file], catalog);
        let mut discard = Vec::new();
        let tables = resolve_program(db, &[(file, tree.clone())], catalog, &mut discard);
        let locals = index_locals(&tables);
        Self {
            db,
            file,
            tree,
            program,
            tables,
            diagnostics,
            locals,
            catalog,
        }
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
            Target::Symbol(id) => self.symbol_hover(*id),
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
                target: Target::Symbol(id),
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

    /// Scope-aware completion candidates for a byte offset: visible
    /// scope bindings, same-module symbols, catalog builtins and
    /// keywords for the GRAMMAR position. Sorted by label; never fails.
    pub fn completions_at(&self, offset: u32) -> Vec<Completion> {
        let text = self.text();
        if let Some(cases) = self.match_case_completions(offset) {
            return cases;
        }
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
        // Expression scope at the offset, else the module scope.
        let scope = self.scope_at(offset);
        if let Some(scope) = scope {
            let mut bindings: Vec<(&String, _)> = Vec::new();
            let mut current = Some(scope);
            while let Some(id) = current {
                let Some(scope_data) = self.tables.scopes.get(id.0 as usize) else {
                    break;
                };
                for (name, binding) in &scope_data.bindings {
                    bindings.push((name, binding));
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
        // Same-module symbols.
        if let Some(module) = self.module_at(offset) {
            let mut names: Vec<(&String, &crate::analysis::resolve::ScopedName)> = self
                .tables
                .module_scopes
                .get(module.0 as usize)
                .map(|s| s.prod.iter().collect())
                .unwrap_or_default();
            names.sort_by(|a, b| a.0.cmp(b.0));
            for (name, scoped) in names {
                let (kind, detail) = scoped_completion(scoped, &self.tables);
                push(name, kind, detail);
            }
        }
        // Catalog builtins (callable entries only, read-only).
        if let Some(catalog) = self.catalog() {
            for id in catalog.ids() {
                if catalog.is_builtin(id) {
                    push(id, "Function", Some("builtin".to_string()));
                }
            }
        }
        // Keywords for the syntactic position.
        for keyword in keywords_at(&self.tree, text, offset) {
            push(keyword, "Keyword", None);
        }
        out.sort_by(|a, b| a.label.cmp(&b.label));
        out
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
    /// name span. Returns `None` for anything unresolved (unknown
    /// names, member-navigation names and
    /// syntactic positions alike).
    fn resolve_at(&self, offset: u32) -> Option<Resolved> {
        let text = self.text();
        if offset as usize >= text.len() {
            return None;
        }
        let chain = chain_at(&self.tree, offset);
        let deepest = *chain.last()?;
        if deepest.kind == SyntaxKind::Name {
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
            None | Some(Binding::Error) => None,
        }
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
        if let Some(typeref) = self.tables.node_typeref.get(&key) {
            match typeref {
                TypeRef::Symbol(id) => {
                    if here == segments.len() - 1 {
                        return Some(Resolved {
                            target: Target::Symbol(*id),
                            span: segments[here].span,
                        });
                    }
                    return None;
                }
                TypeRef::Scalar(name) => {
                    return Some(Resolved {
                        target: Target::Scalar(name.clone()),
                        span: segments[here].span,
                    });
                }
                TypeRef::External => {
                    return Some(Resolved {
                        target: Target::External,
                        span: segments[here].span,
                    });
                }
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
                    return None;
                }
            }
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
            .get(&entry.alias)?;
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
        chain
            .iter()
            .rev()
            .find_map(|n| self.tables.expr_scope.get(&NodeKey::of(n)).copied())
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
        let text = self.text();
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

    /// Declaration span plus every resolved use span of a symbol.
    fn symbol_uses(&self, id: SymbolId) -> Vec<Span> {
        let mut spans = vec![self.tables.symbols[id.0 as usize].span];
        for node in self.tree.descendants() {
            match node.kind {
                SyntaxKind::NameRef => {
                    if matches!(self.tables.node_binding.get(&NodeKey::of(node)), Some(Binding::Symbol(s)) if *s == id)
                        && let Some(span) = name_child_span(node)
                    {
                        spans.push(span);
                    }
                }
                SyntaxKind::Name => {
                    if matches!(self.tables.node_binding.get(&NodeKey::of(node)), Some(Binding::Symbol(s)) if *s == id)
                    {
                        spans.push(node.span);
                    }
                }
                SyntaxKind::Path => spans.extend(self.path_symbol_spans(node, id)),
                _ => {}
            }
        }
        sort_spans(&mut spans);
        spans
    }

    /// Segments of one `Path` node that denote `id`.
    fn path_symbol_spans(&self, node: &SyntaxNode, id: SymbolId) -> Vec<Span> {
        let mut spans = Vec::new();
        let segments: Vec<&SyntaxNode> = node
            .children
            .iter()
            .filter(|c| c.kind == SyntaxKind::Name)
            .collect();
        if segments.is_empty() {
            return spans;
        }
        let key = NodeKey::of(node);
        if let Some(typeref) = self.tables.node_typeref.get(&key) {
            match typeref {
                TypeRef::Symbol(s) if *s == id => {
                    spans.push(segments[segments.len() - 1].span);
                }
                TypeRef::FieldChain {
                    head,
                    fields,
                    consumed,
                } => {
                    let field_base = consumed.saturating_sub(fields.len());
                    let head_index = field_base.saturating_sub(1);
                    if *head == id && head_index < segments.len() {
                        spans.push(segments[head_index].span);
                    }
                    for (k, field) in fields.iter().enumerate() {
                        if *field == id && field_base + k < segments.len() {
                            spans.push(segments[field_base + k].span);
                        }
                    }
                }
                _ => {}
            }
        }
        if matches!(self.tables.node_symbol.get(&key), Some(s) if *s == id) {
            spans.push(segments[segments.len() - 1].span);
        }
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

// --- Shared CST helpers (local copies: the analysis-internal ones are
// out of scope for this module and may shift under the sibling agent) ---

/// Significant children: skips `Trivia`/`Comment` leaves.
fn kids(node: &SyntaxNode) -> Vec<&SyntaxNode> {
    node.children
        .iter()
        .filter(|c| !matches!(c.kind, SyntaxKind::Trivia | SyntaxKind::Comment))
        .collect()
}

/// Text of a `Name` leaf, if `node` is one.
fn name_text<'t>(node: &SyntaxNode, text: &'t str) -> Option<&'t str> {
    if node.kind == SyntaxKind::Name {
        node.token().map(|t| t.text(text))
    } else {
        None
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
        )
    }) {
        let mut keywords = vec!["enum", "action", "delivery"];
        keywords.extend(builtin_type_names().iter().copied());
        return keywords;
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
    // Section body: declaration introducers for the enclosing section.
    if let Some(marker) = enclosing_section_marker(tree, text, offset) {
        return match marker {
            "Given" => vec![
                "preferences",
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
            "Then" => vec!["page"],
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
