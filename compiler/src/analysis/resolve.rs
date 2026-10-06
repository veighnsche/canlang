//! Name resolution: CST to resolved modules, imports, symbols and scopes.
//!
//! Owns every `E2xxx` diagnostic: unknown symbols (`E2001`, one per use
//! site), duplicates (`E2002`), import visibility (`E2003`–`E2005`),
//! helper misuse (`E2006`), composition cycles (`E2007`), ownership
//! (`E2008`), composed-app imports (`E2009`), empty `uses` (`E2010`),
//! contextual shadowing (`E2012`), unknown members (`E2013`), derive
//! targets (`E2014`) and reference cycles (`E2017`–`E2018`). See
//! `can explain` for the per-code allocation.
//!
//! Two passes: [`resolve_program`] builds modules, symbols, imports,
//! scopes and all non-expression resolutions; [`emit_unresolved`] runs
//! after [`super::types`] so unbound names with a unique expected enum
//! type resolve to cases (DESIGN §3: lexical binding precedes enum
//! expectation) instead of erroring. Expression member resolution also
//! needs types, so the types pass records member failures and this
//! module emits them as `E2013`.
//!
//! Cascade suppression: an expression rooted at an unknown name is
//! poisoned — the types pass returns `Error` for it and emits nothing
//! further. `Error`/`BadToken` subtrees (already `E1xxx`) are never
//! re-diagnosed. Deferred to PR5: handler sources, effect arguments,
//! example cells/sequences, UI shape rules, migrations.

use super::catalog::{Catalog, is_t13a_nominal, is_t13b_nominal, std_capability};
use super::{
    NodeKey, attribute_parts, attribute_value, file_text, is_name, is_punct, kids, name_text,
    path_segments,
};
use crate::diagnostic::{Diagnostic, Related};
use crate::source::{SourceDb, SourceId, Span};
use crate::syntax::{Punct, SyntaxKind, SyntaxNode, TokenKind};
use std::collections::{HashMap, HashSet};

/// Index into [`ResolveTables::modules`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ModuleId(pub u32);

/// Index into [`ResolveTables::symbols`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SymbolId(pub u32);

/// Index into [`ResolveTables::scopes`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ScopeId(pub u32);

/// What an `app`/`package` declaration contributes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleKind {
    /// `app Name` with an implicit Given/When/Then body (also its owning
    /// package, identified by the same name).
    ImplicitApp,
    /// `app Name uses=[...]`: selection only, no body.
    ComposedApp,
    /// `package Name` with one Given/When/Then body.
    Package,
}

/// One `app`/`package` declaration: identity, imports and ownership.
#[derive(Debug, Clone)]
pub struct Module {
    /// Table index.
    pub id: ModuleId,
    /// Canonical name (shared app/package namespace).
    pub name: String,
    /// Implicit app, composed app or package.
    pub kind: ModuleKind,
    /// Declaring source.
    pub file: SourceId,
    /// Whole-declaration span.
    pub span: Span,
    /// Name-token span.
    pub name_span: Span,
    /// `use` imports in source order.
    pub imports: Vec<Import>,
    /// Composed-app `uses` member names in source order.
    pub uses: Vec<String>,
    /// Resolved `uses` members (unknown members omitted with `E2005`).
    pub uses_resolved: Vec<ModuleId>,
}

/// One `use provider {members} [from=deployment.binding]` group.
#[derive(Debug, Clone)]
pub struct Import {
    /// Provider package/app name.
    pub provider: String,
    /// Provider-path span.
    pub provider_span: Span,
    /// Imported members.
    pub members: Vec<ImportMember>,
    /// Deployment binding for bound imports.
    pub from: Option<String>,
    /// Whole-declaration span.
    pub span: Span,
}

/// One `Name [as Alias]` import member.
#[derive(Debug, Clone)]
pub struct ImportMember {
    /// Provider-side name.
    pub name: String,
    /// Consumer-side name (`name` without an alias).
    pub alias: String,
    /// Member span.
    pub span: Span,
}

/// Storage ownership of a stored model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelOwner {
    /// Omitted ownership: team scope (the pinned default).
    Team,
    /// `Model in Parent`: child of `Parent` with inherited team/storage.
    ChildOf(SymbolId),
    /// `Model in app`: app-scoped data.
    App,
}

/// Generated CRUD operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CrudOp {
    Create,
    Update,
    Delete,
}

impl CrudOp {
    /// Source spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            CrudOp::Create => "create",
            CrudOp::Update => "update",
            CrudOp::Delete => "delete",
        }
    }
}

/// Fixture recipe target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixtureTarget {
    /// `fixture n=Model {...}`.
    Model(SymbolId),
    /// `fixture n=user {...}`.
    User,
    /// `fixture n=file {...}`.
    File,
    /// Operation-resolved delivery recipe (`None` = bound-external/opaque).
    Operation(Option<SymbolId>),
    /// Unresolved head (`E2001` already reported).
    Unknown,
}

/// Symbol payload: declaration shape plus child symbol links.
#[derive(Debug, Clone)]
pub enum SymbolKind {
    Model {
        fields: Vec<SymbolId>,
        owner: ModelOwner,
        crud: Option<SymbolId>,
    },
    Contract {
        fields: Vec<SymbolId>,
    },
    Event {
        fields: Vec<SymbolId>,
    },
    Role,
    Capability {
        ops: Vec<SymbolId>,
        events: Vec<SymbolId>,
    },
    CapabilityOp {
        params: Vec<SymbolId>,
        result_node: NodeKey,
    },
    Message {
        params: Vec<SymbolId>,
    },
    Fixture {
        target: FixtureTarget,
    },
    Scenario {
        params: Vec<SymbolId>,
        trusted: bool,
        result_node: Option<NodeKey>,
    },
    Crud {
        model: SymbolId,
        create: bool,
        update: bool,
        delete: bool,
    },
    CrudOp {
        model: SymbolId,
        op: CrudOp,
    },
    Field {
        owner: SymbolId,
        type_node: NodeKey,
    },
    Param {
        owner: SymbolId,
        index: usize,
        type_node: NodeKey,
    },
    DeriveField {
        model: SymbolId,
        type_node: NodeKey,
    },
    DeriveFn {
        params: Vec<SymbolId>,
        result_node: NodeKey,
    },
    Preferences {
        fields: Vec<SymbolId>,
    },
}

/// One canonical package-qualified symbol.
#[derive(Debug, Clone)]
pub struct Symbol {
    /// Table index.
    pub id: SymbolId,
    /// Canonical identity (`Package.Name`, `Package.Model.field`,
    /// `Package.Model.create`, ...).
    pub canonical: String,
    /// Local name.
    pub name: String,
    /// Declaration shape.
    pub kind: SymbolKind,
    /// Owning module.
    pub module: ModuleId,
    /// Declaration-name span (`export` excluded).
    pub span: Span,
    /// Whether `export` was written.
    pub exported: bool,
}

/// How `actor` types in one scope: nullable before authorization,
/// non-null after member/role authorization, null in trusted handlers,
/// non-null in creation initializers (a trusted null actor is rejected
/// at runtime per DESIGN §2, so initializers see an authenticated
/// creator).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActorKind {
    Nullable,
    NonNull,
    Null,
}

/// Test-only account references (`fixture` recipes, example headers).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TestAccount {
    Slf,
    Other,
    Outsider,
}

/// Fixed or contextual facts (never globally reserved spellings).
#[derive(Debug, Clone)]
pub enum ContextVar {
    Actor(ActorKind),
    Team,
    Now,
    Operation,
    /// Trusted-handler event payload (opaque in PR4: handler sources
    /// resolve in PR5).
    Event,
    /// `row: Model` in policy/invariant/derive/lock/retain.
    RowModel(SymbolId),
    /// Collection/query `row` (the types pass computes the element type).
    RowQuery {
        node: NodeKey,
    },
    /// Contained-creation `parent` binding.
    Parent {
        model: SymbolId,
    },
    /// Page/UI `preferences` record of one module.
    Preferences {
        module: ModuleId,
    },
    /// Form/page-data `result`: declared scenario result, or opaque for
    /// generated CRUD results (PR5 schemas them).
    Result {
        scenario: Option<SymbolId>,
        crud_op: Option<(SymbolId, CrudOp)>,
    },
    TestAccount(TestAccount),
}

/// One lexical name binding.
#[derive(Debug, Clone)]
pub enum Binding {
    /// Declared or imported symbol.
    Symbol(SymbolId),
    /// `let` statement (the types pass types the initializer).
    Let { node: NodeKey },
    /// Query `as` alias (the types pass types the domain element).
    QueryAlias { node: NodeKey },
    /// `for` item (the types pass types the domain element).
    ForItem { node: NodeKey },
    /// `create ... as name` (record of the resolved model).
    CreateAs { node: NodeKey },
    /// Effect `call ... as name` (declared result or opaque).
    CallAs { node: NodeKey },
    /// `send ... as name` (delivery receipt or opaque).
    SendAs { node: NodeKey },
    /// Scalar route parameter.
    RouteParam { node: NodeKey },
    /// Fixed/contextual fact.
    Context(ContextVar),
    /// Catalog builtin id.
    Builtin { id: String },
    /// Actor predicates (`members`, `owner`, `authenticated`, `public`).
    Predicate,
    /// Bound import from an unknown (external) provider: opaque in PR4.
    External { provider: String, name: String },
    /// Poisoned binding: resolution already failed, uses stay silent.
    Error,
}

/// One lexical scope.
#[derive(Debug, Clone)]
pub struct Scope {
    /// Enclosing scope, if any.
    pub parent: Option<ScopeId>,
    /// Bindings introduced in this scope.
    pub bindings: HashMap<String, Binding>,
}

/// A module member name: local declaration or import alias.
#[derive(Debug, Clone)]
pub enum ScopedName {
    Local(SymbolId),
    Imported { target: SymbolId, bound: bool },
    External { provider: String, name: String },
}

/// Per-module namespaces: production names plus test-only fixture names.
#[derive(Debug, Clone, Default)]
pub struct ModuleScopes {
    /// Local declarations plus imported members.
    pub prod: HashMap<String, ScopedName>,
    /// Local plus imported fixtures (fixture recipes, example headers).
    pub test: HashMap<String, ScopedName>,
}

/// Resolved meaning of a type-position path.
#[derive(Debug, Clone)]
pub enum TypeRef {
    /// Builtin scalar name (`int`, `bytes`, `Team`, ...).
    Scalar(String),
    /// Named type symbol (model/contract/event).
    Symbol(SymbolId),
    /// `Model.field...` reuse chain (head plus validated field symbols;
    /// `consumed` counts the path segments covered so the types pass can
    /// continue deeper navigation with resolved field types).
    FieldChain {
        head: SymbolId,
        fields: Vec<SymbolId>,
        consumed: usize,
    },
    /// Bound import from an external provider: opaque structural type.
    External,
}

/// Member failure recorded for pass-2 `E2013`.
#[derive(Debug, Clone)]
pub struct UnresolvedMember {
    /// Member-name node key.
    pub node: NodeKey,
    /// Member-name span.
    pub span: Span,
    /// Base description for the message (`model Todo`, ...).
    pub base: String,
    /// Member name sought.
    pub name: String,
}

/// Output of [`resolve_program`]: modules, symbols, imports, scopes and
/// every resolution the types pass and PR5 consume.
#[derive(Debug, Clone, Default)]
pub struct ResolveTables {
    /// Modules in `(file, span)` order.
    pub modules: Vec<Module>,
    /// Symbols in declaration order.
    pub symbols: Vec<Symbol>,
    /// Canonical identity to symbol.
    pub by_canonical: HashMap<String, SymbolId>,
    /// App/package name to module.
    pub module_by_name: HashMap<String, ModuleId>,
    /// Namespaces per module (indexed by [`ModuleId`]).
    pub module_scopes: Vec<ModuleScopes>,
    /// Lexical scopes (indexed by [`ScopeId`]).
    pub scopes: Vec<Scope>,
    /// Scope visible at each expression node.
    pub expr_scope: HashMap<NodeKey, ScopeId>,
    /// Resolved declaration/type paths.
    pub node_symbol: HashMap<NodeKey, SymbolId>,
    /// Resolved expression names.
    pub node_binding: HashMap<NodeKey, Binding>,
    /// Resolved type-position paths.
    pub node_typeref: HashMap<NodeKey, TypeRef>,
    /// Unbound expression names (pass 2 reports `E2001` unless the types
    /// pass claimed them as enum cases).
    pub unresolved_names: Vec<NodeKey>,
    /// Member failures from resolve-owned positions (pass 2 `E2013`).
    pub unresolved_members: Vec<UnresolvedMember>,
    /// CRUD declaration per model.
    pub crud_of_model: HashMap<SymbolId, SymbolId>,
    /// Contained children per model.
    pub children_of: HashMap<SymbolId, Vec<SymbolId>>,
    /// Fixture reference edges (fixture id to referenced fixture ids).
    pub fixture_edges: HashMap<SymbolId, Vec<SymbolId>>,
    /// `judgment` declarations: registered as fieldless contracts so
    /// the name resolves package-wide, while every use position maps
    /// to the silent opaque treatment (the derived evaluate/result
    /// interface is unimplemented, DESIGN:897).
    pub judgments: HashSet<SymbolId>,
}

impl ResolveTables {
    /// Look up a name in a scope chain, then builtins/predicates.
    pub fn resolve_name(
        &self,
        scope: ScopeId,
        name: &str,
        catalog: Option<&Catalog>,
    ) -> Option<Binding> {
        let mut current = Some(scope);
        while let Some(id) = current {
            if let Some(binding) = self.scopes.get(id.0 as usize)?.bindings.get(name) {
                return Some(binding.clone());
            }
            current = self.scopes.get(id.0 as usize)?.parent;
        }
        if matches!(name, "members" | "owner" | "authenticated" | "public") {
            return Some(Binding::Predicate);
        }
        if let Some(catalog) = catalog {
            if catalog.is_builtin(name) {
                return Some(Binding::Builtin {
                    id: name.to_string(),
                });
            }
            if catalog.is_helper(name) {
                return None;
            }
        }
        None
    }
}

/// Builtin scalar and context type names resolvable in type position
/// (DESIGN §2 table plus `bytes` from the §3 ordered-scalar list and
/// `Team`/`OperationContext` from the §3 contextual typing).
pub fn builtin_type_names() -> &'static [&'static str] {
    &[
        "text",
        "bool",
        "int",
        "decimal",
        "email",
        "url",
        "locale",
        "date",
        "datetime",
        "duration",
        "timezone",
        "currency",
        "money",
        "user",
        "member",
        "file",
        "secret",
        "json",
        "bytes",
        "Team",
        "OperationContext",
    ]
}

/// Whether `name` is a builtin type name.
pub fn is_builtin_type(name: &str) -> bool {
    builtin_type_names().contains(&name)
}

/// Resolve declarations, imports, ownership, type paths and lexical
/// scopes. Expression names resolve lexically; unbound ones are recorded
/// for [`emit_unresolved`].
pub fn resolve_program(
    db: &SourceDb,
    trees: &[(SourceId, SyntaxNode)],
    catalog: Option<&Catalog>,
    diags: &mut Vec<Diagnostic>,
) -> ResolveTables {
    let mut resolver = Resolver::new(db, catalog);
    resolver.index_modules(trees, diags);
    resolver.index_declarations(trees, diags);
    resolver.resolve_imports(diags);
    resolver.resolve_ownership(diags);
    resolver.resolve_declarations(trees, diags);
    resolver.finish(trees, diags)
}

/// Emit `E2001` for unbound names the types pass did not claim as enum
/// cases, and `E2013` for recorded member failures.
pub fn emit_unresolved(
    db: &SourceDb,
    tables: &ResolveTables,
    types: &super::types::TypeTable,
    diags: &mut Vec<Diagnostic>,
) {
    let mut seen_names: HashSet<NodeKey> = HashSet::new();
    for key in tables
        .unresolved_names
        .iter()
        .chain(types.unresolved_names.iter())
    {
        if !seen_names.insert(*key) || types.resolved_cases.contains(key) {
            continue;
        }
        let (name, span) =
            trimmed_slice(db, key).unwrap_or(("?", Span::new(key.file, key.start, key.end)));
        let mut message = format!("unresolved name '{name}'");
        if let Some(hint) = import_hint(tables, name) {
            message.push_str(&hint);
        }
        diags.push(Diagnostic::error("E2001", message, span));
    }
    let mut seen_members: HashSet<(NodeKey, String)> = HashSet::new();
    for member in tables
        .unresolved_members
        .iter()
        .chain(types.unresolved_members.iter())
    {
        if !seen_members.insert((member.node, member.name.clone())) {
            continue;
        }
        diags.push(Diagnostic::error(
            "E2013",
            format!("unknown member '{}' on {}", member.name, member.base),
            member.span,
        ));
    }
}

/// Slice source text for a node key.
fn source_slice<'a>(db: &'a SourceDb, key: &NodeKey) -> Option<&'a str> {
    let text = file_text(db, key.file)?;
    text.get(key.start as usize..key.end as usize)
}

/// Source slice plus span of a node key with surrounding trivia trimmed.
///
/// Interior CST nodes union their children's spans, so a `NameRef` after
/// a space can cover `" trim"`; diagnostics point at the name itself.
/// `str::trim` splits on char boundaries, so the span stays valid.
fn trimmed_slice<'a>(db: &'a SourceDb, key: &NodeKey) -> Option<(&'a str, Span)> {
    let raw = source_slice(db, key)?;
    let leading = raw.len() - raw.trim_start().len();
    let trimmed = raw.trim();
    let start = key.start + leading as u32;
    let span = Span::new(key.file, start, start + trimmed.len() as u32);
    Some((trimmed, span))
}

/// Import hint for an unresolved name: names an exporting module when the
/// name matches exactly one visible exported symbol elsewhere.
fn import_hint(tables: &ResolveTables, name: &str) -> Option<String> {
    let mut providers: Vec<&str> = Vec::new();
    for symbol in &tables.symbols {
        if symbol.name == name && symbol.exported {
            let module = &tables.modules[symbol.module.0 as usize];
            if !providers.contains(&module.name.as_str()) {
                providers.push(module.name.as_str());
            }
        }
    }
    match providers.len() {
        1 => Some(format!(
            "; import it with `use {} {{{name}}}`",
            providers[0]
        )),
        _ => None,
    }
}

struct Resolver<'a> {
    db: &'a SourceDb,
    catalog: Option<&'a Catalog>,
    tables: ResolveTables,
    /// Module id per declaration subtree root while indexing.
    current_module: Option<ModuleId>,
    /// Pending `in Parent` links: (model, parent path segments, span).
    pending_parents: Vec<(SymbolId, Vec<String>, Span)>,
}

impl<'a> Resolver<'a> {
    fn new(db: &'a SourceDb, catalog: Option<&'a Catalog>) -> Self {
        Self {
            db,
            catalog,
            tables: ResolveTables::default(),
            current_module: None,
            pending_parents: Vec::new(),
        }
    }

    fn text(&self, file: SourceId) -> &'a str {
        file_text(self.db, file).unwrap_or("")
    }

    fn finish(
        mut self,
        trees: &[(SourceId, SyntaxNode)],
        diags: &mut Vec<Diagnostic>,
    ) -> ResolveTables {
        self.check_fixture_cycles(trees, diags);
        self.check_derive_cycles(trees, diags);
        self.tables
    }

    // --- Pass 1: modules ------------------------------------------------

    /// Index every `app`/`package` across files; duplicates are `E2002`.
    fn index_modules(&mut self, trees: &[(SourceId, SyntaxNode)], diags: &mut Vec<Diagnostic>) {
        for (file, tree) in trees {
            let text = self.text(*file);
            for child in kids(tree) {
                match child.kind {
                    SyntaxKind::App | SyntaxKind::Package => {
                        self.index_module(*file, text, child, diags);
                    }
                    SyntaxKind::Migration | SyntaxKind::Error => {}
                    _ => {}
                }
            }
        }
    }

    fn index_module(
        &mut self,
        file: SourceId,
        text: &str,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        if has_error(node) {
            return;
        }
        let parts = kids(node);
        let name_node = parts.iter().find(|n| {
            n.kind == SyntaxKind::Name
                && !matches!(
                    name_text(n, text),
                    Some("app" | "package" | "export" | "migration")
                )
        });
        let Some(name_node) = name_node else {
            return;
        };
        let name = name_node
            .token()
            .map(|t| t.text(text).to_string())
            .unwrap_or_default();
        let name_span = name_node.span;
        let kind = if node.kind == SyntaxKind::Package {
            ModuleKind::Package
        } else if node.children.iter().any(|c| {
            c.kind == SyntaxKind::Attribute
                && attribute_parts(c).is_some_and(|(k, _)| is_name(k, text, "uses"))
        }) {
            ModuleKind::ComposedApp
        } else {
            ModuleKind::ImplicitApp
        };
        if let Some(&first) = self.tables.module_by_name.get(&name) {
            let mut diagnostic = Diagnostic::error(
                "E2002",
                format!("duplicate app/package identity '{name}'"),
                name_span,
            );
            diagnostic.related.push(Related {
                span: self.tables.modules[first.0 as usize].name_span,
                message: "first declared here".to_string(),
            });
            diags.push(diagnostic);
            return;
        }
        let id = ModuleId(self.tables.modules.len() as u32);
        let mut module = Module {
            id,
            name: name.clone(),
            kind,
            file,
            span: node.span,
            name_span,
            imports: Vec::new(),
            uses: Vec::new(),
            uses_resolved: Vec::new(),
        };
        for child in &node.children {
            match child.kind {
                SyntaxKind::Import => {
                    if let Some(import) = self.read_import(text, child) {
                        module.imports.push(import);
                    }
                }
                SyntaxKind::Attribute => {
                    if let Some((key, value)) = attribute_parts(child)
                        && is_name(key, text, "uses")
                        && value.kind == SyntaxKind::Array
                    {
                        for element in kids(value) {
                            if element.kind == SyntaxKind::NameRef
                                && let Some(member) = element
                                    .children
                                    .iter()
                                    .find_map(|c| c.token().map(|t| t.text(text).to_string()))
                            {
                                module.uses.push(member);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if kind == ModuleKind::ComposedApp && module.uses.is_empty() {
            diags.push(Diagnostic::error(
                "E2010",
                format!("app '{name}' has an empty uses=[] group; select at least one member"),
                name_span,
            ));
        }
        self.tables.module_by_name.insert(name, id);
        self.tables.modules.push(module);
        self.tables.module_scopes.push(ModuleScopes::default());
    }

    /// Read one `Import` node (shape errors are already `E1xxx`).
    fn read_import(&self, text: &str, node: &SyntaxNode) -> Option<Import> {
        let parts = kids(node);
        let mut provider = None;
        let mut provider_span = node.span;
        let mut members = Vec::new();
        let mut from = None;
        for part in parts {
            match part.kind {
                SyntaxKind::Path if provider.is_none() => {
                    let segments = path_segments(part, text);
                    if segments.len() == 1 {
                        provider = Some(segments[0].to_string());
                        // The segment's own span: `Path` interiors can
                        // include surrounding trivia.
                        provider_span = segment_span(part, text, 0);
                    }
                }
                SyntaxKind::ImportMember => {
                    let bits = kids(part);
                    let name = bits.first().and_then(|n| name_text(n, text));
                    let alias = if bits.len() >= 3 {
                        name_text(bits[2], text)
                    } else {
                        name
                    };
                    if let (Some(name), Some(alias)) = (name, alias) {
                        members.push(ImportMember {
                            name: name.to_string(),
                            alias: alias.to_string(),
                            span: part.span,
                        });
                    }
                }
                SyntaxKind::Attribute => {
                    if let Some((key, value)) = attribute_parts(part)
                        && is_name(key, text, "from")
                        && value.kind == SyntaxKind::Path
                    {
                        from = Some(path_segments(value, text).join("."));
                    }
                }
                _ => {}
            }
        }
        Some(Import {
            provider: provider?,
            provider_span,
            members,
            from,
            span: node.span,
        })
    }
}

pub(crate) fn has_error(node: &SyntaxNode) -> bool {
    node.descendants()
        .any(|n| matches!(n.kind, SyntaxKind::Error | SyntaxKind::BadToken))
}

/// Whether this CST kind is a type node.
fn is_type_node(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::NamedType
            | SyntaxKind::UnionType
            | SyntaxKind::ArrayType
            | SyntaxKind::NullableType
            | SyntaxKind::EnumType
            | SyntaxKind::ActionType
            | SyntaxKind::DeliveryType
            | SyntaxKind::InvocationType
    )
}

/// `-> type` result annotation following parameters/attributes.
fn result_annotation(node: &SyntaxNode) -> Option<&SyntaxNode> {
    let parts = kids(node);
    for i in 0..parts.len() {
        let is_arrow = parts[i]
            .token()
            .is_some_and(|t| t.kind == TokenKind::Punct(Punct::Arrow));
        if is_arrow {
            return parts.get(i + 1).copied().filter(|n| is_type_node(n.kind));
        }
    }
    None
}

impl Symbol {
    /// Field symbols of a model/contract/event/preferences symbol.
    pub fn fields_of(&self) -> &[SymbolId] {
        match &self.kind {
            SymbolKind::Model { fields, .. }
            | SymbolKind::Contract { fields }
            | SymbolKind::Event { fields }
            | SymbolKind::Preferences { fields } => fields,
            _ => &[],
        }
    }
}

impl<'a> Resolver<'a> {
    // --- Pass 2: declarations -------------------------------------------

    /// Index every declaration symbol; same-scope duplicates are `E2002`
    /// (package scope is shared across declaration kinds, including
    /// fixtures; closed builtin names cannot be redeclared).
    fn index_declarations(
        &mut self,
        trees: &[(SourceId, SyntaxNode)],
        diags: &mut Vec<Diagnostic>,
    ) {
        for (file, tree) in trees {
            let text = self.text(*file);
            for child in kids(tree) {
                if !matches!(child.kind, SyntaxKind::App | SyntaxKind::Package) {
                    continue;
                }
                let Some(module) = self.module_of(text, child) else {
                    continue;
                };
                self.current_module = Some(module);
                for section in kids(child) {
                    if section.kind != SyntaxKind::Section {
                        continue;
                    }
                    let marker = kids(section)
                        .iter()
                        .find_map(|n| name_text(n, text))
                        .unwrap_or("");
                    for item in kids(section) {
                        match marker {
                            "Given" => self.index_given(*file, text, module, item, diags),
                            "When" => self.index_when(*file, text, module, item, diags),
                            _ => {}
                        }
                    }
                }
            }
        }
        self.current_module = None;
    }

    fn module_of(&self, text: &str, node: &SyntaxNode) -> Option<ModuleId> {
        let name = kids(node).iter().find_map(|n| {
            let word = name_text(n, text)?;
            (!matches!(word, "app" | "package" | "export" | "migration")).then_some(word)
        })?;
        self.tables.module_by_name.get(name).copied()
    }

    fn index_given(
        &mut self,
        _file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        if has_error(node) {
            return;
        }
        match node.kind {
            SyntaxKind::Preferences => self.index_preferences(text, module, node, diags),
            SyntaxKind::Model => self.index_model(text, module, node, diags),
            SyntaxKind::Contract => self.index_schema_symbol(
                text,
                module,
                node,
                SymbolKind::Contract { fields: Vec::new() },
                "contract",
                diags,
            ),
            SyntaxKind::Event => self.index_schema_symbol(
                text,
                module,
                node,
                SymbolKind::Event { fields: Vec::new() },
                "event",
                diags,
            ),
            SyntaxKind::Role => {
                self.index_named(text, module, node, "role", SymbolKind::Role, diags);
            }
            SyntaxKind::Derive => self.index_derive(text, module, node, diags),
            SyntaxKind::Fixture => self.index_fixture(text, module, node, diags),
            SyntaxKind::Capability => self.index_capability(text, module, node, diags),
            SyntaxKind::Judgment => {
                if let Some(id) = self.index_named(
                    text,
                    module,
                    node,
                    "judgment",
                    SymbolKind::Contract { fields: Vec::new() },
                    diags,
                ) {
                    self.tables.judgments.insert(id);
                }
            }
            SyntaxKind::Message => self.index_message(text, module, node, diags),
            SyntaxKind::Policy
            | SyntaxKind::Invariant
            | SyntaxKind::Unique
            | SyntaxKind::Lock
            | SyntaxKind::Retain => {}
            _ => {}
        }
    }

    fn index_when(
        &mut self,
        _file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        if has_error(node) {
            return;
        }
        match node.kind {
            SyntaxKind::Crud => self.index_crud(text, module, node, diags),
            SyntaxKind::Scenario => self.index_scenario(text, module, node, diags),
            _ => {}
        }
    }

    /// Declare a package-scope name; duplicates (including closed builtin
    /// names and fixture/production collisions) are `E2002`.
    #[allow(clippy::too_many_arguments)]
    fn declare(
        &mut self,
        module: ModuleId,
        name: &str,
        span: Span,
        kind: SymbolKind,
        exported: bool,
        what: &str,
        diags: &mut Vec<Diagnostic>,
    ) -> Option<SymbolId> {
        if self.is_closed_source_name(name) {
            diags.push(Diagnostic::error(
                "E2002",
                format!("{what} '{name}' redeclares the closed builtin name '{name}'"),
                span,
            ));
            return None;
        }
        let scopes = &self.tables.module_scopes[module.0 as usize];
        if scopes.prod.contains_key(name) || scopes.test.contains_key(name) {
            let mut diagnostic = Diagnostic::error(
                "E2002",
                format!("duplicate definition of '{name}' in one scope"),
                span,
            );
            if let Some(first) = self.first_decl_span(module, name) {
                diagnostic.related.push(Related {
                    span: first,
                    message: "first declared here".to_string(),
                });
            }
            diags.push(diagnostic);
            return None;
        }
        let id = SymbolId(self.tables.symbols.len() as u32);
        let module_name = self.tables.modules[module.0 as usize].name.clone();
        let symbol = Symbol {
            id,
            canonical: format!("{module_name}.{name}"),
            name: name.to_string(),
            kind,
            module,
            span,
            exported,
        };
        self.tables
            .by_canonical
            .insert(symbol.canonical.clone(), id);
        self.tables.symbols.push(symbol);
        self.tables.module_scopes[module.0 as usize]
            .prod
            .insert(name.to_string(), ScopedName::Local(id));
        Some(id)
    }

    /// Whether a package-scope declaration may not take this name.
    fn is_closed_source_name(&self, name: &str) -> bool {
        self.catalog.is_some_and(|c| c.is_builtin(name))
    }

    fn first_decl_span(&self, module: ModuleId, name: &str) -> Option<Span> {
        let scopes = &self.tables.module_scopes[module.0 as usize];
        let target = scopes.prod.get(name).or_else(|| scopes.test.get(name))?;
        match target {
            ScopedName::Local(id) => Some(self.tables.symbols[id.0 as usize].span),
            _ => None,
        }
    }

    /// Whether `export` prefixes this declaration node.
    fn is_exported(text: &str, node: &SyntaxNode) -> bool {
        kids(node)
            .first()
            .is_some_and(|first| is_name(first, text, "export"))
    }

    /// Declaration head name: first `Name` child that is not a head word.
    fn decl_name(text: &str, node: &SyntaxNode, heads: &[&str]) -> Option<(String, Span)> {
        kids(node).iter().find_map(|n| {
            let word = name_text(n, text)?;
            (!heads.contains(&word)).then(|| (word.to_string(), n.span))
        })
    }

    fn index_named(
        &mut self,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        head: &'static str,
        kind: SymbolKind,
        diags: &mut Vec<Diagnostic>,
    ) -> Option<SymbolId> {
        let (name, span) = Self::decl_name(text, node, &["export", head])?;
        let exported = Self::is_exported(text, node);
        self.declare(module, &name, span, kind, exported, head, diags)
    }

    fn index_preferences(
        &mut self,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        if self
            .tables
            .symbols
            .iter()
            .any(|s| s.module == module && matches!(s.kind, SymbolKind::Preferences { .. }))
        {
            diags.push(Diagnostic::error(
                "E2002",
                "duplicate preferences schema in one owner".to_string(),
                node.span,
            ));
            return;
        }
        let id = SymbolId(self.tables.symbols.len() as u32);
        let module_name = self.tables.modules[module.0 as usize].name.clone();
        self.tables
            .by_canonical
            .insert(format!("{module_name}.preferences"), id);
        self.tables.symbols.push(Symbol {
            id,
            canonical: format!("{module_name}.preferences"),
            name: "preferences".to_string(),
            kind: SymbolKind::Preferences { fields: Vec::new() },
            module,
            span: node.span,
            exported: false,
        });
        let fields = self.index_fields(text, id, node, "preferences", "preference", diags);
        if let SymbolKind::Preferences { fields: slot } =
            &mut self.tables.symbols[id.0 as usize].kind
        {
            *slot = fields;
        }
    }

    fn index_model(
        &mut self,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        let Some((name, span)) = Self::decl_name(text, node, &["export"]) else {
            return;
        };
        let exported = Self::is_exported(text, node);
        let Some(id) = self.declare(
            module,
            &name,
            span,
            SymbolKind::Model {
                fields: Vec::new(),
                owner: ModelOwner::Team,
                crud: None,
            },
            exported,
            "model",
            diags,
        ) else {
            return;
        };
        let fields = self.index_fields(text, id, node, &name, "field", diags);
        if let SymbolKind::Model { fields: slot, .. } = &mut self.tables.symbols[id.0 as usize].kind
        {
            *slot = fields;
        }
        let parts = kids(node);
        let mut i = 0;
        while i < parts.len() {
            if is_name(parts[i], text, "in")
                && let Some(path) = parts.get(i + 1).filter(|p| p.kind == SyntaxKind::Path)
            {
                let segments: Vec<String> = path_segments(path, text)
                    .into_iter()
                    .map(str::to_string)
                    .collect();
                if segments.len() != 1 || segments[0] != "app" {
                    self.pending_parents.push((id, segments, path.span));
                } else if let SymbolKind::Model { owner, .. } =
                    &mut self.tables.symbols[id.0 as usize].kind
                {
                    *owner = ModelOwner::App;
                }
            }
            i += 1;
        }
    }

    fn index_schema_symbol(
        &mut self,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        kind: SymbolKind,
        what: &'static str,
        diags: &mut Vec<Diagnostic>,
    ) {
        let Some((name, span)) = Self::decl_name(text, node, &["export", what]) else {
            return;
        };
        let exported = Self::is_exported(text, node);
        let Some(id) = self.declare(module, &name, span, kind, exported, what, diags) else {
            return;
        };
        let fields = self.index_fields(text, id, node, &name, "field", diags);
        match &mut self.tables.symbols[id.0 as usize].kind {
            SymbolKind::Contract { fields: slot } | SymbolKind::Event { fields: slot } => {
                *slot = fields;
            }
            _ => {}
        }
    }

    /// Index `Field` children; duplicates in one schema are `E2002`.
    fn index_fields(
        &mut self,
        text: &str,
        owner: SymbolId,
        node: &SyntaxNode,
        owner_name: &str,
        what: &str,
        diags: &mut Vec<Diagnostic>,
    ) -> Vec<SymbolId> {
        let mut fields = Vec::new();
        let mut seen: HashMap<String, Span> = HashMap::new();
        for child in node.children.iter().filter(|c| c.kind == SyntaxKind::Field) {
            let parts = kids(child);
            let Some(name_node) = parts.first().filter(|n| n.kind == SyntaxKind::Name) else {
                continue;
            };
            let name = name_node
                .token()
                .map(|t| t.text(text).to_string())
                .unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            if let Some(first) = seen.get(&name) {
                let mut diagnostic = Diagnostic::error(
                    "E2002",
                    format!("duplicate {what} '{name}' in {owner_name}"),
                    name_node.span,
                );
                diagnostic.related.push(Related {
                    span: *first,
                    message: "first declared here".to_string(),
                });
                diags.push(diagnostic);
                continue;
            }
            seen.insert(name.clone(), name_node.span);
            let type_node = parts
                .iter()
                .find(|n| is_type_node(n.kind))
                .map(|n| NodeKey::of(n))
                .unwrap_or_else(|| NodeKey::of(child));
            let id = SymbolId(self.tables.symbols.len() as u32);
            let module = self.tables.symbols[owner.0 as usize].module;
            let module_name = self.tables.modules[module.0 as usize].name.clone();
            self.tables
                .by_canonical
                .insert(format!("{module_name}.{owner_name}.{name}"), id);
            self.tables.symbols.push(Symbol {
                id,
                canonical: format!("{module_name}.{owner_name}.{name}"),
                name: name.clone(),
                kind: SymbolKind::Field { owner, type_node },
                module,
                span: name_node.span,
                exported: false,
            });
            fields.push(id);
        }
        fields
    }

    fn index_derive(
        &mut self,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        let parts = kids(node);
        let path = parts.iter().find(|n| n.kind == SyntaxKind::Path);
        let Some(path) = path else {
            return;
        };
        let segments = path_segments(path, text);
        let is_function = parts.iter().any(|n| is_punct(n, text, "("));
        if is_function {
            if segments.len() != 1 {
                diags.push(Diagnostic::error(
                    "E2014",
                    format!(
                        "derived function '{}' must declare a package-local name; a path is not an automatic cross-package extension",
                        segments.join(".")
                    ),
                    path.span,
                ));
                return;
            }
            let name = segments[0].to_string();
            let Some(id) = self.declare(
                module,
                &name,
                path.span,
                SymbolKind::DeriveFn {
                    params: Vec::new(),
                    result_node: NodeKey::of(node),
                },
                Self::is_exported(text, node),
                "derived function",
                diags,
            ) else {
                return;
            };
            let (params, _) = self.index_params(text, id, node, diags);
            let result_node = result_annotation(node).map(NodeKey::of);
            if let SymbolKind::DeriveFn {
                params: slot,
                result_node: rslot,
            } = &mut self.tables.symbols[id.0 as usize].kind
            {
                *slot = params;
                if let Some(result) = result_node {
                    *rslot = result;
                }
            }
        } else {
            if segments.len() != 2 {
                diags.push(Diagnostic::error(
                    "E2014",
                    format!(
                        "derived field '{}' must resolve to Model.field",
                        segments.join(".")
                    ),
                    path.span,
                ));
                return;
            }
            let model_name = segments[0].to_string();
            let field_name = segments[1].to_string();
            let model = self.lookup_prod(module, &model_name);
            let model_id = match model {
                Some(ScopedName::Local(id))
                    if matches!(
                        self.tables.symbols[id.0 as usize].kind,
                        SymbolKind::Model { .. }
                    ) =>
                {
                    id
                }
                Some(ScopedName::Local(_)) => {
                    diags.push(Diagnostic::error(
                        "E2014",
                        format!("derived field target '{model_name}' is not a stored model"),
                        path.span,
                    ));
                    return;
                }
                Some(ScopedName::Imported { .. }) | Some(ScopedName::External { .. }) => {
                    diags.push(Diagnostic::error(
                        "E2014",
                        format!(
                            "derived field target '{model_name}' is imported; a path is not an automatic cross-package extension"
                        ),
                        path.span,
                    ));
                    return;
                }
                None => {
                    diags.push(Diagnostic::error(
                        "E2001",
                        format!("unresolved name '{model_name}'"),
                        path.span,
                    ));
                    return;
                }
            };
            if self.tables.symbols[model_id.0 as usize]
                .fields_of()
                .iter()
                .any(|f| self.tables.symbols[f.0 as usize].name == field_name)
            {
                diags.push(Diagnostic::error(
                    "E2002",
                    format!("duplicate definition of '{model_name}.{field_name}' in one scope"),
                    path.span,
                ));
                return;
            }
            let type_node = parts
                .iter()
                .find(|n| is_type_node(n.kind))
                .map(|n| NodeKey::of(n))
                .unwrap_or_else(|| NodeKey::of(node));
            let id = SymbolId(self.tables.symbols.len() as u32);
            let module_name = self.tables.modules[module.0 as usize].name.clone();
            self.tables
                .by_canonical
                .insert(format!("{module_name}.{model_name}.{field_name}"), id);
            self.tables.symbols.push(Symbol {
                id,
                canonical: format!("{module_name}.{model_name}.{field_name}"),
                name: field_name,
                kind: SymbolKind::DeriveField {
                    model: model_id,
                    type_node,
                },
                module,
                span: path.span,
                exported: false,
            });
            if let SymbolKind::Model { fields, .. } =
                &mut self.tables.symbols[model_id.0 as usize].kind
            {
                fields.push(id);
            }
        }
    }

    /// Index `Parameter` children; duplicates in one signature are `E2002`.
    fn index_params(
        &mut self,
        text: &str,
        owner: SymbolId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) -> (Vec<SymbolId>, Vec<Span>) {
        let mut params = Vec::new();
        let mut spans = Vec::new();
        let mut seen: HashMap<String, Span> = HashMap::new();
        for child in node
            .children
            .iter()
            .filter(|c| c.kind == SyntaxKind::Parameter)
        {
            let parts = kids(child);
            let Some(name_node) = parts.first().filter(|n| n.kind == SyntaxKind::Name) else {
                continue;
            };
            let name = name_node
                .token()
                .map(|t| t.text(text).to_string())
                .unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            if let Some(first) = seen.get(&name) {
                let mut diagnostic = Diagnostic::error(
                    "E2002",
                    format!("duplicate parameter '{name}' in one signature"),
                    name_node.span,
                );
                diagnostic.related.push(Related {
                    span: *first,
                    message: "first declared here".to_string(),
                });
                diags.push(diagnostic);
                continue;
            }
            seen.insert(name.clone(), name_node.span);
            let type_node = parts
                .iter()
                .find(|n| is_type_node(n.kind))
                .map(|n| NodeKey::of(n))
                .unwrap_or_else(|| NodeKey::of(child));
            let id = SymbolId(self.tables.symbols.len() as u32);
            let module = self.tables.symbols[owner.0 as usize].module;
            self.tables.symbols.push(Symbol {
                id,
                canonical: format!(
                    "{}.{}.{}",
                    self.tables.modules[module.0 as usize].name,
                    self.tables.symbols[owner.0 as usize].name,
                    name
                ),
                name: name.clone(),
                kind: SymbolKind::Param {
                    owner,
                    index: params.len(),
                    type_node,
                },
                module,
                span: name_node.span,
                exported: false,
            });
            spans.push(name_node.span);
            params.push(id);
        }
        (params, spans)
    }

    fn index_fixture(
        &mut self,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        let Some((name, span)) = Self::decl_name(text, node, &["export", "fixture"]) else {
            return;
        };
        if self.is_closed_source_name(&name) {
            diags.push(Diagnostic::error(
                "E2002",
                format!("fixture '{name}' redeclares the closed builtin name '{name}'"),
                span,
            ));
            return;
        }
        let scopes = &self.tables.module_scopes[module.0 as usize];
        if scopes.prod.contains_key(&name) || scopes.test.contains_key(&name) {
            diags.push(Diagnostic::error(
                "E2002",
                format!("duplicate definition of '{name}' in one scope"),
                span,
            ));
            return;
        }
        let id = SymbolId(self.tables.symbols.len() as u32);
        let module_name = self.tables.modules[module.0 as usize].name.clone();
        self.tables
            .by_canonical
            .insert(format!("{module_name}.{name}"), id);
        self.tables.symbols.push(Symbol {
            id,
            canonical: format!("{module_name}.{name}"),
            name: name.clone(),
            kind: SymbolKind::Fixture {
                target: FixtureTarget::Unknown,
            },
            module,
            span,
            exported: Self::is_exported(text, node),
        });
        self.tables.module_scopes[module.0 as usize]
            .test
            .insert(name, ScopedName::Local(id));
    }

    fn index_capability(
        &mut self,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        let Some((name, span)) = Self::decl_name(text, node, &["export", "capability"]) else {
            return;
        };
        let exported = Self::is_exported(text, node);
        let Some(id) = self.declare(
            module,
            &name,
            span,
            SymbolKind::Capability {
                ops: Vec::new(),
                events: Vec::new(),
            },
            exported,
            "capability",
            diags,
        ) else {
            return;
        };
        let mut ops = Vec::new();
        let mut events = Vec::new();
        let mut seen: HashMap<String, Span> = HashMap::new();
        for child in node.children.iter().filter(|c| {
            matches!(c.kind, SyntaxKind::CapabilityOp | SyntaxKind::Event) && !has_error(c)
        }) {
            let op_name = kids(child).iter().find_map(|n| {
                let word = name_text(n, text)?;
                (word != "event").then(|| (word.to_string(), n.span))
            });
            let Some((op_name, op_span)) = op_name else {
                continue;
            };
            if let Some(first) = seen.get(&op_name) {
                let mut diagnostic = Diagnostic::error(
                    "E2002",
                    format!("duplicate capability member '{op_name}' in {name}"),
                    op_span,
                );
                diagnostic.related.push(Related {
                    span: *first,
                    message: "first declared here".to_string(),
                });
                diags.push(diagnostic);
                continue;
            }
            seen.insert(op_name.clone(), op_span);
            let member_id = SymbolId(self.tables.symbols.len() as u32);
            let module_name = self.tables.modules[module.0 as usize].name.clone();
            self.tables
                .by_canonical
                .insert(format!("{module_name}.{name}.{op_name}"), member_id);
            if child.kind == SyntaxKind::CapabilityOp {
                // Push the owner before indexing its parameters (the
                // parameter indexer reads the owner's module).
                let result_node = result_annotation(child).map(NodeKey::of);
                self.tables.symbols.push(Symbol {
                    id: member_id,
                    canonical: format!("{module_name}.{name}.{op_name}"),
                    name: op_name.clone(),
                    kind: SymbolKind::CapabilityOp {
                        params: Vec::new(),
                        result_node: result_node.unwrap_or_else(|| NodeKey::of(child)),
                    },
                    module,
                    span: op_span,
                    exported: false,
                });
                let (params, _) = self.index_params(text, member_id, child, diags);
                if let SymbolKind::CapabilityOp { params: slot, .. } =
                    &mut self.tables.symbols[member_id.0 as usize].kind
                {
                    *slot = params;
                }
                ops.push(member_id);
            } else {
                self.tables.symbols.push(Symbol {
                    id: member_id,
                    canonical: format!("{module_name}.{name}.{op_name}"),
                    name: op_name,
                    kind: SymbolKind::Event { fields: Vec::new() },
                    module,
                    span: op_span,
                    exported: false,
                });
                let fields = self.index_fields(text, member_id, child, &name, "field", diags);
                if let SymbolKind::Event { fields: slot } =
                    &mut self.tables.symbols[member_id.0 as usize].kind
                {
                    *slot = fields;
                }
                events.push(member_id);
            }
        }
        if let SymbolKind::Capability {
            ops: oslot,
            events: eslot,
        } = &mut self.tables.symbols[id.0 as usize].kind
        {
            *oslot = ops;
            *eslot = events;
        }
    }

    fn index_message(
        &mut self,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        let Some((name, span)) = Self::decl_name(text, node, &["export", "message"]) else {
            return;
        };
        let exported = Self::is_exported(text, node);
        let Some(id) = self.declare(
            module,
            &name,
            span,
            SymbolKind::Message { params: Vec::new() },
            exported,
            "message",
            diags,
        ) else {
            return;
        };
        let (params, _) = self.index_params(text, id, node, diags);
        if let SymbolKind::Message { params: slot } = &mut self.tables.symbols[id.0 as usize].kind {
            *slot = params;
        }
    }

    fn index_crud(
        &mut self,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        let parts = kids(node);
        let target = parts.iter().find(|n| n.kind == SyntaxKind::Path);
        let model_name = target
            .map(|p| path_segments(p, text).join("."))
            .unwrap_or_default();
        if model_name.contains('.') || model_name.is_empty() {
            return;
        }
        let model_id = match self.lookup_prod(module, &model_name) {
            Some(ScopedName::Local(id))
                if matches!(
                    self.tables.symbols[id.0 as usize].kind,
                    SymbolKind::Model { .. }
                ) =>
            {
                id
            }
            _ => return,
        };
        if let Some(first) = self.tables.crud_of_model.get(&model_id) {
            let mut diagnostic = Diagnostic::error(
                "E2002",
                format!(
                    "duplicate crud declaration for model '{}'",
                    self.tables.symbols[model_id.0 as usize].name
                ),
                node.span,
            );
            diagnostic.related.push(Related {
                span: self.tables.symbols[first.0 as usize].span,
                message: "first declared here".to_string(),
            });
            diags.push(diagnostic);
            return;
        }
        let enabled = |attr: &str| {
            attribute_value(node, attr, text).is_none_or(|v| {
                v.kind != SyntaxKind::NameRef
                    || v.children
                        .iter()
                        .find_map(|c| c.token().map(|t| t.text(text)))
                        != Some("none")
            })
        };
        let create = enabled("create");
        let update = enabled("update");
        let delete = enabled("delete");
        let id = SymbolId(self.tables.symbols.len() as u32);
        let module_name = self.tables.modules[module.0 as usize].name.clone();
        let model_name = self.tables.symbols[model_id.0 as usize].name.clone();
        self.tables
            .by_canonical
            .insert(format!("{module_name}.{model_name}.crud"), id);
        self.tables.symbols.push(Symbol {
            id,
            canonical: format!("{module_name}.{model_name}.crud"),
            name: format!("{model_name}.crud"),
            kind: SymbolKind::Crud {
                model: model_id,
                create,
                update,
                delete,
            },
            module,
            span: node.span,
            exported: false,
        });
        self.tables.crud_of_model.insert(model_id, id);
        if let SymbolKind::Model { crud, .. } = &mut self.tables.symbols[model_id.0 as usize].kind {
            *crud = Some(id);
        }
        for (op, is_enabled) in [
            (CrudOp::Create, create),
            (CrudOp::Update, update),
            (CrudOp::Delete, delete),
        ] {
            if !is_enabled {
                continue;
            }
            let op_id = SymbolId(self.tables.symbols.len() as u32);
            self.tables
                .by_canonical
                .insert(format!("{module_name}.{model_name}.{}", op.as_str()), op_id);
            self.tables.symbols.push(Symbol {
                id: op_id,
                canonical: format!("{module_name}.{model_name}.{}", op.as_str()),
                name: op.as_str().to_string(),
                kind: SymbolKind::CrudOp {
                    model: model_id,
                    op,
                },
                module,
                span: node.span,
                exported: false,
            });
        }
    }

    fn index_scenario(
        &mut self,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        let Some((name, span)) = Self::decl_name(text, node, &["export", "scenario"]) else {
            return;
        };
        let trusted = node.children.iter().any(|c| {
            c.kind == SyntaxKind::Attribute
                && attribute_parts(c).is_some_and(|(k, _)| is_name(k, text, "on"))
        });
        let Some(id) = self.declare(
            module,
            &name,
            span,
            SymbolKind::Scenario {
                params: Vec::new(),
                trusted,
                result_node: None,
            },
            Self::is_exported(text, node),
            "scenario",
            diags,
        ) else {
            return;
        };
        let (params, _) = self.index_params(text, id, node, diags);
        let result_node = result_annotation(node).map(NodeKey::of);
        if let SymbolKind::Scenario {
            params: slot,
            result_node: rslot,
            ..
        } = &mut self.tables.symbols[id.0 as usize].kind
        {
            *slot = params;
            *rslot = result_node;
        }
    }

    /// Whether this symbol is a `judgment` declaration (registered as
    /// a fieldless contract; use positions treat it as opaque).
    fn is_judgment(&self, id: SymbolId) -> bool {
        self.tables.judgments.contains(&id)
    }

    /// Production-scope lookup (locals at index time; imports are added by
    /// [`Resolver::resolve_imports`]).
    fn lookup_prod(&self, module: ModuleId, name: &str) -> Option<ScopedName> {
        self.tables.module_scopes[module.0 as usize]
            .prod
            .get(name)
            .cloned()
    }

    // --- Pass 3: imports --------------------------------------------------

    /// Resolve every import group: provider must exist (`E2005`), members
    /// must be declared (`E2004`) and exported (`E2003`); duplicate local
    /// names are `E2002`. Bound imports (`from=deployment.binding`) of
    /// unknown providers are external interfaces: opaque, never an error.
    /// `std` is compiler-known (T14b/B1): unbound known members bind
    /// external, unknown members are `E2004`.
    fn resolve_imports(&mut self, diags: &mut Vec<Diagnostic>) {
        let modules: Vec<Module> = self.tables.modules.clone();
        for module in &modules {
            for import in &module.imports {
                self.resolve_import(module, import, diags);
            }
        }
        self.resolve_composition(diags);
        self.resolve_imported_crud_aliases();
    }

    /// Alias enabled CRUD operations of plain-imported models into the
    /// importer's namespace (T35/R23: plain imports resolve to the
    /// canonical owner's exported operations). The examples pass looks
    /// generated CRUD operations up by call-site-qualified canonical
    /// (`{Caller}.{Model}.{op}`); for a model imported from its owner
    /// that key misses the owner's `{Owner}.{Model}.{op}`
    /// registration, so enabled imported operations wrongly report
    /// `E5006`. Register `{Importer}.{Model}.{op}` aliases pointing at
    /// the owner's operation symbols — presence-gated on the owner's
    /// own registration, so disabled operations (never registered)
    /// stay unavailable. Bound (`from=`) imports are remote and get no
    /// alias; ambiguous names (one importer, same model name from two
    /// owners) keep today's `E5006`, since the call-site key cannot
    /// express which owner a call means. Existing keys are never
    /// overwritten.
    fn resolve_imported_crud_aliases(&mut self) {
        for module_id in 0..self.tables.modules.len() {
            let importer = self.tables.modules[module_id].name.clone();
            // Distinct imported models by owner-side model name; the
            // call-site lookup spells the resolved symbol's name, so
            // import aliases do not affect the key.
            let mut by_name: HashMap<String, SymbolId> = HashMap::new();
            let mut ambiguous: HashSet<String> = HashSet::new();
            for binding in self.tables.module_scopes[module_id].prod.values() {
                let (target, bound) = match binding {
                    ScopedName::Imported { target, bound } => (*target, *bound),
                    _ => continue,
                };
                if bound {
                    continue;
                }
                let symbol = &self.tables.symbols[target.0 as usize];
                if !matches!(symbol.kind, SymbolKind::Model { .. }) || !symbol.exported {
                    continue;
                }
                let name = symbol.name.clone();
                match by_name.get(&name) {
                    None => {
                        by_name.insert(name, target);
                    }
                    Some(seen) if *seen != target => {
                        ambiguous.insert(name);
                    }
                    _ => {}
                }
            }
            for (name, target) in &by_name {
                if ambiguous.contains(name) {
                    continue;
                }
                let owner = self.tables.modules
                    [self.tables.symbols[target.0 as usize].module.0 as usize]
                    .name
                    .clone();
                for op in [CrudOp::Create, CrudOp::Update, CrudOp::Delete] {
                    let owner_key = format!("{owner}.{name}.{}", op.as_str());
                    let Some(&op_id) = self.tables.by_canonical.get(&owner_key) else {
                        continue;
                    };
                    let alias_key = format!("{importer}.{name}.{}", op.as_str());
                    self.tables.by_canonical.entry(alias_key).or_insert(op_id);
                }
            }
        }
    }

    fn resolve_import(&mut self, module: &Module, import: &Import, diags: &mut Vec<Diagnostic>) {
        let bound = import.from.is_some();
        if let Some(from) = &import.from {
            let head = from.split('.').next().unwrap_or("");
            if head != "deployment" || from.split('.').count() != 2 {
                diags.push(Diagnostic::error(
                    "E2001",
                    format!(
                        "import binding '{from}' must have the supported deployment-binding form deployment.NAME"
                    ),
                    import.span,
                ));
                return;
            }
        }
        let provider = self.tables.module_by_name.get(&import.provider).copied();
        let Some(provider) = provider else {
            if bound {
                for member in &import.members {
                    self.bind_import_alias(
                        module.id,
                        &member.alias,
                        member.span,
                        ScopedName::External {
                            provider: import.provider.clone(),
                            name: member.name.clone(),
                        },
                        diags,
                    );
                }
                return;
            }
            // T14b/B1: `std` is a compiler-known provider fed by the
            // consumed T13 schemas: unbound known members (capabilities
            // and nominal value types alike) bind as externals, so
            // nominal type positions resolve instead of failing `E2005`
            // with `E2001` follow-ons. Unknown members are `E2004`
            // (the provider is known; the member is not declared).
            // Bound imports keep the deployment-slot rule above
            // (unknown members stay opaque externals, never an error);
            // B11 normalizes bound nominals to this same `External`
            // binding: `from=` on a value type carries no binding
            // meaning, so both forms resolve identically.
            if import.provider == "std" {
                for member in &import.members {
                    if std_capability(&member.name).is_some()
                        || is_t13a_nominal(&member.name)
                        || is_t13b_nominal(&member.name)
                    {
                        self.bind_import_alias(
                            module.id,
                            &member.alias,
                            member.span,
                            ScopedName::External {
                                provider: import.provider.clone(),
                                name: member.name.clone(),
                            },
                            diags,
                        );
                    } else {
                        diags.push(Diagnostic::error(
                            "E2004",
                            format!(
                                "import member '{}' is not declared in 'std'",
                                member.name
                            ),
                            member.span,
                        ));
                    }
                }
                return;
            }
            diags.push(Diagnostic::error(
                "E2005",
                format!(
                    "import provider '{}' names no known app or package",
                    import.provider
                ),
                import.provider_span,
            ));
            return;
        };
        let composed_only_messages =
            self.tables.modules[module.id.0 as usize].kind == ModuleKind::ComposedApp;
        for member in &import.members {
            let target = self.tables.module_scopes[provider.0 as usize]
                .prod
                .get(&member.name)
                .cloned()
                .or_else(|| {
                    self.tables.module_scopes[provider.0 as usize]
                        .test
                        .get(&member.name)
                        .cloned()
                });
            let Some(target) = target else {
                diags.push(Diagnostic::error(
                    "E2004",
                    format!(
                        "import member '{}' is not declared in '{}'",
                        member.name, import.provider
                    ),
                    member.span,
                ));
                continue;
            };
            let target_id = match &target {
                ScopedName::Local(id) => *id,
                ScopedName::Imported { .. } | ScopedName::External { .. } => {
                    diags.push(Diagnostic::error(
                        "E2004",
                        format!(
                            "import member '{}' of '{}' is itself an import; name the owning package",
                            member.name, import.provider
                        ),
                        member.span,
                    ));
                    continue;
                }
            };
            if !self.tables.symbols[target_id.0 as usize].exported {
                diags.push(Diagnostic::error(
                    "E2003",
                    format!(
                        "import member '{}' of '{}' is not exported",
                        member.name, import.provider
                    ),
                    member.span,
                ));
                continue;
            }
            if composed_only_messages
                && !matches!(
                    self.tables.symbols[target_id.0 as usize].kind,
                    SymbolKind::Message { .. }
                )
            {
                diags.push(Diagnostic::error(
                    "E2009",
                    format!(
                        "composed app '{}' imports only messages; '{}' is not a message",
                        self.tables.modules[module.id.0 as usize].name, member.name
                    ),
                    member.span,
                ));
                continue;
            }
            let is_fixture = matches!(
                self.tables.symbols[target_id.0 as usize].kind,
                SymbolKind::Fixture { .. }
            );
            let binding = ScopedName::Imported {
                target: target_id,
                bound,
            };
            if is_fixture {
                self.bind_import_fixture(module.id, &member.alias, member.span, binding, diags);
            } else {
                self.bind_import_alias(module.id, &member.alias, member.span, binding, diags);
            }
        }
    }

    /// Bind an import alias in production scope; collisions and closed
    /// builtin names are `E2002`.
    fn bind_import_alias(
        &mut self,
        module: ModuleId,
        alias: &str,
        span: Span,
        binding: ScopedName,
        diags: &mut Vec<Diagnostic>,
    ) {
        if self.is_closed_source_name(alias) {
            diags.push(Diagnostic::error(
                "E2002",
                format!("import alias '{alias}' redeclares the closed builtin name '{alias}'"),
                span,
            ));
            return;
        }
        let scopes = &mut self.tables.module_scopes[module.0 as usize];
        if scopes.prod.contains_key(alias) || scopes.test.contains_key(alias) {
            diags.push(Diagnostic::error(
                "E2002",
                format!("duplicate imported member '{alias}' in one scope"),
                span,
            ));
            return;
        }
        scopes.prod.insert(alias.to_string(), binding);
    }

    fn bind_import_fixture(
        &mut self,
        module: ModuleId,
        alias: &str,
        span: Span,
        binding: ScopedName,
        diags: &mut Vec<Diagnostic>,
    ) {
        let scopes = &mut self.tables.module_scopes[module.0 as usize];
        if scopes.prod.contains_key(alias) || scopes.test.contains_key(alias) {
            diags.push(Diagnostic::error(
                "E2002",
                format!("duplicate imported member '{alias}' in one scope"),
                span,
            ));
            return;
        }
        scopes.test.insert(alias.to_string(), binding);
    }

    // --- Pass 4: composition and ownership --------------------------------

    /// Resolve composed-app `uses` members (`E2005`), reject composition
    /// cycles (`E2007`) and resolve `in Parent` links (`E2001`/`E2008`).
    fn resolve_composition(&mut self, diags: &mut Vec<Diagnostic>) {
        let modules: Vec<Module> = self.tables.modules.clone();
        for module in &modules {
            if module.kind != ModuleKind::ComposedApp {
                continue;
            }
            for member in &module.uses {
                match self.tables.module_by_name.get(member) {
                    Some(&id) => {
                        self.tables.modules[module.id.0 as usize]
                            .uses_resolved
                            .push(id);
                    }
                    None => {
                        diags.push(Diagnostic::error(
                            "E2005",
                            format!("app '{}' selects unknown member '{member}'", module.name),
                            module.name_span,
                        ));
                    }
                }
            }
        }
        for module in &modules {
            if module.kind != ModuleKind::ComposedApp {
                continue;
            }
            let mut stack = vec![module.id];
            let mut visiting: HashSet<ModuleId> = HashSet::new();
            visiting.insert(module.id);
            while let Some(current) = stack.pop() {
                let members = self.tables.modules[current.0 as usize]
                    .uses_resolved
                    .clone();
                for member in members {
                    if member == module.id {
                        let name = self.tables.modules[module.id.0 as usize].name.clone();
                        diags.push(Diagnostic::error(
                            "E2007",
                            format!("app composition cycle through '{name}'"),
                            self.tables.modules[module.id.0 as usize].name_span,
                        ));
                    } else if visiting.insert(member)
                        && self.tables.modules[member.0 as usize].kind == ModuleKind::ComposedApp
                    {
                        stack.push(member);
                    }
                }
            }
        }
    }

    /// Resolve `in Parent` containment links and reject containment cycles.
    fn resolve_ownership(&mut self, diags: &mut Vec<Diagnostic>) {
        let pending = std::mem::take(&mut self.pending_parents);
        for (model, segments, span) in pending {
            if segments.len() != 1 {
                diags.push(Diagnostic::error(
                    "E2008",
                    format!(
                        "containment '{}' must name one model in scope",
                        segments.join(".")
                    ),
                    span,
                ));
                continue;
            }
            let module = self.tables.symbols[model.0 as usize].module;
            let parent = match self.lookup_prod(module, &segments[0]) {
                Some(ScopedName::Local(id))
                    if matches!(
                        self.tables.symbols[id.0 as usize].kind,
                        SymbolKind::Model { .. }
                    ) =>
                {
                    id
                }
                Some(ScopedName::Local(_)) => {
                    diags.push(Diagnostic::error(
                        "E2008",
                        format!("containment target '{}' is not a stored model", segments[0]),
                        span,
                    ));
                    continue;
                }
                Some(ScopedName::Imported { target, bound }) => {
                    // T28-A (plain_import_containment): a plain-imported
                    // stored model contains exactly like a local one;
                    // bound (from=) parents stay rejected (remote:
                    // reference field instead).
                    if bound {
                        diags.push(Diagnostic::error(
                            "E2008",
                            format!(
                                "containment target '{}' is a bound (from=) import; containment needs a plain-imported or package-local parent",
                                segments[0]
                            ),
                            span,
                        ));
                        continue;
                    }
                    if !matches!(
                        self.tables.symbols[target.0 as usize].kind,
                        SymbolKind::Model { .. }
                    ) {
                        diags.push(Diagnostic::error(
                            "E2008",
                            format!("containment target '{}' is not a stored model", segments[0]),
                            span,
                        ));
                        continue;
                    }
                    target
                }
                Some(ScopedName::External { .. }) => {
                    diags.push(Diagnostic::error(
                        "E2008",
                        format!(
                            "containment target '{}' is external; containment needs a plain-imported or package-local parent",
                            segments[0]
                        ),
                        span,
                    ));
                    continue;
                }
                None => {
                    let mut diagnostic = Diagnostic::error(
                        "E2001",
                        format!("unresolved name '{}'", segments[0]),
                        span,
                    );
                    if segments[0] == "team" {
                        diagnostic.message = "omit redundant in team ownership".to_string();
                    }
                    diags.push(diagnostic);
                    continue;
                }
            };
            if parent == model {
                diags.push(Diagnostic::error(
                    "E2008",
                    "a model cannot contain itself".to_string(),
                    span,
                ));
                continue;
            }
            if let SymbolKind::Model { owner, .. } = &mut self.tables.symbols[model.0 as usize].kind
            {
                *owner = ModelOwner::ChildOf(parent);
            }
            self.tables
                .children_of
                .entry(parent)
                .or_default()
                .push(model);
        }
        let models: Vec<SymbolId> = self
            .tables
            .symbols
            .iter()
            .filter(|s| matches!(s.kind, SymbolKind::Model { .. }))
            .map(|s| s.id)
            .collect();
        for model in models {
            let mut current = model;
            let mut seen: HashSet<SymbolId> = HashSet::new();
            seen.insert(model);
            while let SymbolKind::Model {
                owner: ModelOwner::ChildOf(parent),
                ..
            } = &self.tables.symbols[current.0 as usize].kind
            {
                let parent = *parent;
                if !seen.insert(parent) {
                    let name = self.tables.symbols[model.0 as usize].name.clone();
                    diags.push(Diagnostic::error(
                        "E2008",
                        format!("containment cycle through model '{name}'"),
                        self.tables.symbols[model.0 as usize].span,
                    ));
                    break;
                }
                current = parent;
            }
        }
    }
}

impl<'a> Resolver<'a> {
    // --- Pass 5: scopes and paths -----------------------------------------

    /// Create a fresh scope with an optional parent.
    fn new_scope(&mut self, parent: Option<ScopeId>) -> ScopeId {
        let id = ScopeId(self.tables.scopes.len() as u32);
        self.tables.scopes.push(Scope {
            parent,
            bindings: HashMap::new(),
        });
        id
    }

    /// Introduce an authored binding; same-scope authored duplicates are
    /// `E2002`, hiding an active contextual fact is `E2012`.
    fn bind_authored(
        &mut self,
        scope: ScopeId,
        name: &str,
        binding: Binding,
        span: Span,
        what: &str,
        diags: &mut Vec<Diagnostic>,
    ) {
        let scopes = &self.tables.scopes;
        if let Some(existing) = scopes[scope.0 as usize].bindings.get(name) {
            if matches!(existing, Binding::Context(_)) {
                diags.push(Diagnostic::error(
                    "E2012",
                    format!("{what} '{name}' hides the active contextual fact '{name}'"),
                    span,
                ));
            } else {
                diags.push(Diagnostic::error(
                    "E2002",
                    format!("duplicate definition of '{name}' in one scope"),
                    span,
                ));
            }
            return;
        }
        let mut current = scopes[scope.0 as usize].parent;
        while let Some(id) = current {
            if let Some(existing) = scopes[id.0 as usize].bindings.get(name) {
                if matches!(existing, Binding::Context(_)) {
                    diags.push(Diagnostic::error(
                        "E2012",
                        format!("{what} '{name}' hides the active contextual fact '{name}'"),
                        span,
                    ));
                    return;
                }
                break;
            }
            current = scopes[id.0 as usize].parent;
        }
        self.tables.scopes[scope.0 as usize]
            .bindings
            .insert(name.to_string(), binding);
    }

    /// Module root scope: production names as symbol/external bindings.
    fn module_root(&mut self, module: ModuleId) -> ScopeId {
        let scope = self.new_scope(None);
        let names: Vec<(String, ScopedName)> = self.tables.module_scopes[module.0 as usize]
            .prod
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (name, scoped) in names {
            let binding = match scoped {
                ScopedName::Local(id) | ScopedName::Imported { target: id, .. } => {
                    if self.is_judgment(id) {
                        // Judgment names resolve, but their derived
                        // evaluate/result interface is untyped
                        // (DESIGN:897): poison the binding so uses
                        // stay silent instead of erroring as values.
                        Binding::Error
                    } else {
                        Binding::Symbol(id)
                    }
                }
                ScopedName::External { provider, name } => Binding::External { provider, name },
            };
            self.tables.scopes[scope.0 as usize]
                .bindings
                .insert(name, binding);
        }
        scope
    }

    /// Test root scope: module root plus fixture names and test accounts.
    fn test_root(&mut self, module: ModuleId, prod_root: ScopeId) -> ScopeId {
        let scope = self.new_scope(Some(prod_root));
        let names: Vec<(String, ScopedName)> = self.tables.module_scopes[module.0 as usize]
            .test
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (name, scoped) in names {
            let binding = match scoped {
                ScopedName::Local(id) | ScopedName::Imported { target: id, .. } => {
                    Binding::Symbol(id)
                }
                ScopedName::External { provider, name } => Binding::External { provider, name },
            };
            self.tables.scopes[scope.0 as usize]
                .bindings
                .insert(name, binding);
        }
        for (name, account) in [
            ("self", TestAccount::Slf),
            ("other", TestAccount::Other),
            ("outsider", TestAccount::Outsider),
        ] {
            self.tables.scopes[scope.0 as usize].bindings.insert(
                name.to_string(),
                Binding::Context(ContextVar::TestAccount(account)),
            );
        }
        scope
    }

    /// Child scope with fixed facts (actor mode, team, now, operation).
    fn with_facts(
        &mut self,
        parent: ScopeId,
        actor: ActorKind,
        team: bool,
        operation: bool,
    ) -> ScopeId {
        let scope = self.new_scope(Some(parent));
        let bindings = &mut self.tables.scopes[scope.0 as usize].bindings;
        bindings.insert(
            "actor".to_string(),
            Binding::Context(ContextVar::Actor(actor)),
        );
        if team {
            bindings.insert("team".to_string(), Binding::Context(ContextVar::Team));
        }
        bindings.insert("now".to_string(), Binding::Context(ContextVar::Now));
        if operation {
            bindings.insert(
                "operation".to_string(),
                Binding::Context(ContextVar::Operation),
            );
        }
        scope
    }

    /// Walk every declaration: resolve type paths, target paths, label
    /// paths and description references, and build expression scopes.
    fn resolve_declarations(
        &mut self,
        trees: &[(SourceId, SyntaxNode)],
        diags: &mut Vec<Diagnostic>,
    ) {
        for (file, tree) in trees {
            let text = self.text(*file);
            for child in kids(tree) {
                if !matches!(child.kind, SyntaxKind::App | SyntaxKind::Package) {
                    continue;
                }
                let Some(module) = self.module_of(text, child) else {
                    continue;
                };
                self.resolve_module(*file, text, module, child, diags);
            }
        }
    }

    fn resolve_module(
        &mut self,
        file: SourceId,
        text: &'a str,
        module: ModuleId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        let root = self.module_root(module);
        self.resolve_description_refs(text, module, node, diags);
        for child in kids(node) {
            match child.kind {
                SyntaxKind::Attribute => {
                    if let Some((key, value)) = attribute_parts(child)
                        && is_name(key, text, "label")
                    {
                        self.resolve_caption(text, module, value, diags);
                    }
                }
                SyntaxKind::Context => self.resolve_context(file, text, module, root, child, diags),
                SyntaxKind::Section => {
                    let marker = kids(child)
                        .iter()
                        .find_map(|n| name_text(n, text))
                        .unwrap_or("");
                    for item in kids(child) {
                        match marker {
                            "Given" => self.resolve_given(file, text, module, root, item, diags),
                            "When" => self.resolve_when(file, text, module, root, item, diags),
                            "Then" => self.resolve_then(file, text, module, root, item, diags),
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// Resolve `#= path` description references to messages.
    fn resolve_description_refs(
        &mut self,
        _text: &'a str,
        module: ModuleId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        for desc in node
            .descendants()
            .filter(|n| n.kind == SyntaxKind::Description)
        {
            let crate::syntax::NodeDetail::Description { tokens, data } = &desc.detail else {
                continue;
            };
            let crate::syntax::DescriptionData::Reference { path } = data else {
                continue;
            };
            if path.is_empty() {
                continue;
            }
            let span = tokens.first().map(|t| t.span).unwrap_or(desc.span);
            if self.lookup_prod(module, &path[0]).is_none()
                && !self.tables.module_by_name.contains_key(&path[0])
            {
                diags.push(Diagnostic::error(
                    "E2001",
                    format!("unresolved name '{}'", path[0]),
                    span,
                ));
            } else if path.len() > 1 {
                self.tables.unresolved_members.push(UnresolvedMember {
                    node: NodeKey::of(desc),
                    span,
                    base: format!("message '{}'", path[0]),
                    name: path[1].clone(),
                });
            }
        }
    }

    /// Resolve a label caption path to a message symbol. Multi-segment
    /// navigation past a message is `E2013` (messages have no members);
    /// the message-ness and zero-parameter checks are the types pass
    /// (`E3016`).
    fn resolve_caption(
        &mut self,
        text: &'a str,
        module: ModuleId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        match node.kind {
            SyntaxKind::Path => {
                let segments: Vec<String> = path_segments(node, text)
                    .into_iter()
                    .map(str::to_string)
                    .collect();
                let _ = self.resolve_label_segments(module, &segments, node, text, diags);
            }
            SyntaxKind::Label | SyntaxKind::CrudLabels => {
                for child in &node.children {
                    match child.kind {
                        SyntaxKind::LabelCase => {
                            for caption in &child.children {
                                if matches!(
                                    caption.kind,
                                    SyntaxKind::Path
                                        | SyntaxKind::Literal
                                        | SyntaxKind::MessageValue
                                ) {
                                    self.resolve_caption(text, module, caption, diags);
                                }
                            }
                        }
                        SyntaxKind::Path | SyntaxKind::Literal | SyntaxKind::MessageValue => {
                            self.resolve_caption(text, module, child, diags);
                        }
                        _ => {}
                    }
                }
            }
            SyntaxKind::Literal | SyntaxKind::MessageValue => {}
            _ => {}
        }
    }

    /// Resolve an inline `desc=` value on a field or parameter: a
    /// static message path resolves like a caption path (head via
    /// module scope, `E2001`/`E2013` on failure, final symbol recorded
    /// for the types pass); string literals and inline descriptors need
    /// no resolution. The message-ness and zero-parameter checks are the
    /// types pass (`E3016`). Error subtrees were already diagnosed.
    fn resolve_description_value(
        &mut self,
        text: &'a str,
        module: ModuleId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        if has_error(node) {
            return;
        }
        let value = kids(node).into_iter().find(|n| {
            matches!(
                n.kind,
                SyntaxKind::Literal | SyntaxKind::MessageValue | SyntaxKind::Path
            )
        });
        if let Some(SyntaxKind::Path) = value.map(|n| n.kind) {
            self.resolve_caption(text, module, value.expect("matched path"), diags);
        }
    }

    /// Navigate a label/`#=` path: head via module scope, then field
    /// navigation; records the final symbol for the types pass.
    fn resolve_label_segments(
        &mut self,
        module: ModuleId,
        segments: &[String],
        node: &SyntaxNode,
        text: &str,
        diags: &mut Vec<Diagnostic>,
    ) -> Option<SymbolId> {
        if segments.is_empty() {
            return None;
        }
        let head = self.lookup_prod(module, &segments[0]);
        let mut current = match head {
            Some(ScopedName::Local(id) | ScopedName::Imported { target: id, .. }) => id,
            Some(ScopedName::External { .. }) => return None,
            None => {
                if self.tables.module_by_name.contains_key(&segments[0]) {
                    return self.resolve_qualified_label(module, segments, node, text, diags);
                }
                diags.push(Diagnostic::error(
                    "E2001",
                    format!("unresolved name '{}'", segments[0]),
                    segment_span(node, text, 0),
                ));
                return None;
            }
        };
        if self.is_judgment(current) {
            // Caption paths rooted at a judgment resolve the name but
            // stay opaque (derived members are untyped, DESIGN:897).
            return None;
        }
        for (i, segment) in segments.iter().enumerate().skip(1) {
            let found = self.tables.symbols[current.0 as usize]
                .fields_of()
                .iter()
                .find(|f| self.tables.symbols[f.0 as usize].name == *segment)
                .copied();
            match found {
                Some(field) => current = field,
                None => {
                    let base = self.tables.symbols[current.0 as usize].name.clone();
                    self.tables.unresolved_members.push(UnresolvedMember {
                        node: NodeKey::of(node),
                        span: segment_span(node, text, i),
                        base,
                        name: segment.clone(),
                    });
                    return None;
                }
            }
        }
        self.tables.node_symbol.insert(NodeKey::of(node), current);
        Some(current)
    }

    /// Resolve a package-qualified label path (`Pkg.msg`).
    fn resolve_qualified_label(
        &mut self,
        module: ModuleId,
        segments: &[String],
        node: &SyntaxNode,
        text: &str,
        diags: &mut Vec<Diagnostic>,
    ) -> Option<SymbolId> {
        if segments.len() != 2 {
            self.tables.unresolved_members.push(UnresolvedMember {
                node: NodeKey::of(node),
                span: segment_span(node, text, 1),
                base: format!("package {}", segments[0]),
                name: segments.get(1).cloned().unwrap_or_default(),
            });
            return None;
        }
        let provider = self.tables.module_by_name[segments[0].as_str()];
        let imported = self.tables.modules[module.0 as usize]
            .imports
            .iter()
            .any(|import| {
                import.provider == segments[0]
                    && import.members.iter().any(|m| m.name == segments[1])
            });
        if !imported {
            diags.push(Diagnostic::error(
                "E2001",
                format!(
                    "unresolved name '{}'; without a use, a cross-package reference is an error",
                    segments.join(".")
                ),
                node.span,
            ));
            return None;
        }
        match self.tables.module_scopes[provider.0 as usize]
            .prod
            .get(&segments[1])
        {
            Some(ScopedName::Local(id)) => {
                self.tables.node_symbol.insert(NodeKey::of(node), *id);
                Some(*id)
            }
            _ => {
                diags.push(Diagnostic::error(
                    "E2001",
                    format!("unresolved name '{}'", segments.join(".")),
                    node.span,
                ));
                None
            }
        }
    }

    fn resolve_context(
        &mut self,
        _file: SourceId,
        text: &'a str,
        module: ModuleId,
        root: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        for child in kids(node) {
            if child.kind != SyntaxKind::ContextDecl || has_error(child) {
                continue;
            }
            let head = kids(child)
                .iter()
                .find_map(|n| name_text(n, text))
                .unwrap_or("");
            match head {
                "queue" => {
                    if let Some(ty) = attribute_value(child, "type", text) {
                        self.resolve_type(text, module, ty, diags);
                    }
                }
                "binding" => {
                    if let Some(key) = attribute_value(child, "key", text)
                        && key.kind == SyntaxKind::Path
                    {
                        self.resolve_key_path(module, key, text, diags);
                    }
                }
                "cache" => {
                    if let Some(ttl) = attribute_value(child, "ttl", text) {
                        self.walk_expr(module, root, ttl, text, ExprCtx::bare(), diags);
                    }
                }
                "files" => {
                    if let Some(max) = attribute_value(child, "max", text) {
                        self.walk_expr(module, root, max, text, ExprCtx::bare(), diags);
                    }
                }
                "analytics" => {
                    for field in child
                        .children
                        .iter()
                        .filter(|c| c.kind == SyntaxKind::Field)
                    {
                        self.resolve_field_parts(text, module, root, None, field, true, diags);
                    }
                }
                _ => {}
            }
        }
    }

    /// Resolve a binding `key=` path: fully qualified package model names
    /// need no import; otherwise module scope.
    fn resolve_key_path(
        &mut self,
        module: ModuleId,
        node: &SyntaxNode,
        text: &str,
        diags: &mut Vec<Diagnostic>,
    ) {
        let segments = path_segments(node, text);
        if segments.is_empty() {
            return;
        }
        if segments.len() == 2 && self.tables.module_by_name.contains_key(segments[0]) {
            let provider = self.tables.module_by_name[segments[0]];
            if let Some(ScopedName::Local(id)) = self.tables.module_scopes[provider.0 as usize]
                .prod
                .get(segments[1])
            {
                self.tables.node_symbol.insert(NodeKey::of(node), *id);
                return;
            }
            diags.push(Diagnostic::error(
                "E2001",
                format!("unresolved name '{}'", segments.join(".")),
                node.span,
            ));
            return;
        }
        self.resolve_model_path(module, &segments, node, text, diags);
    }
}

impl<'a> Resolver<'a> {
    #[allow(clippy::too_many_arguments)]
    fn resolve_given(
        &mut self,
        file: SourceId,
        text: &'a str,
        module: ModuleId,
        root: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        if has_error(node) {
            return;
        }
        match node.kind {
            SyntaxKind::Preferences => {
                for field in node.children.iter().filter(|c| c.kind == SyntaxKind::Field) {
                    self.resolve_field_parts(text, module, root, None, field, true, diags);
                }
                if let Some(label) = attribute_value(node, "label", text) {
                    self.resolve_caption(text, module, label, diags);
                }
            }
            SyntaxKind::Model => {
                let name = Self::decl_name(text, node, &["export"]).map(|(n, _)| n);
                let model = name.as_deref().and_then(|n| self.lookup_prod(module, n));
                let parent = match model {
                    Some(ScopedName::Local(id)) => match &self.tables.symbols[id.0 as usize].kind {
                        SymbolKind::Model {
                            owner: ModelOwner::ChildOf(p),
                            ..
                        } => Some(*p),
                        _ => None,
                    },
                    _ => None,
                };
                let scope = match parent {
                    Some(model) => {
                        let scope = self.with_facts(root, ActorKind::NonNull, true, true);
                        self.tables.scopes[scope.0 as usize].bindings.insert(
                            "parent".to_string(),
                            Binding::Context(ContextVar::Parent { model }),
                        );
                        scope
                    }
                    None => self.with_facts(root, ActorKind::NonNull, true, true),
                };
                for field in node.children.iter().filter(|c| c.kind == SyntaxKind::Field) {
                    self.resolve_field_parts(text, module, scope, None, field, false, diags);
                }
                if let Some(label) = attribute_value(node, "label", text) {
                    self.resolve_caption(text, module, label, diags);
                }
            }
            SyntaxKind::Contract | SyntaxKind::Event => {
                let scope = self.with_facts(root, ActorKind::NonNull, true, true);
                for field in node.children.iter().filter(|c| c.kind == SyntaxKind::Field) {
                    self.resolve_field_parts(text, module, scope, None, field, false, diags);
                }
                if let Some(label) = attribute_value(node, "label", text) {
                    self.resolve_caption(text, module, label, diags);
                }
            }
            SyntaxKind::Role => {
                if let Some(label) = attribute_value(node, "label", text) {
                    self.resolve_caption(text, module, label, diags);
                }
            }
            SyntaxKind::Derive => self.resolve_derive_body(file, text, module, root, node, diags),
            SyntaxKind::Fixture => self.resolve_fixture(text, module, root, node, diags),
            SyntaxKind::Capability => self.resolve_capability(text, module, root, node, diags),
            SyntaxKind::Message => self.resolve_message(text, module, root, node, diags),
            SyntaxKind::Policy | SyntaxKind::Unique | SyntaxKind::Lock | SyntaxKind::Retain => {
                self.resolve_rule(text, module, root, node, diags);
            }
            SyntaxKind::Invariant => {
                let inv_parts = kids(node);
                let target = inv_parts.iter().find(|n| n.kind == SyntaxKind::Path);
                let mut row_scope = self.with_facts(root, ActorKind::Nullable, true, true);
                if let Some(target) = target {
                    let segments = path_segments(target, text);
                    // `invariant preferences:` validates the owner's
                    // preferences row (DESIGN §9); preferences live
                    // outside the production namespace.
                    let prefs = if segments == ["preferences"] {
                        self.tables
                            .symbols
                            .iter()
                            .find(|s| {
                                s.module == module
                                    && matches!(s.kind, SymbolKind::Preferences { .. })
                            })
                            .map(|s| s.id)
                    } else {
                        None
                    };
                    if let Some(prefs) = prefs {
                        self.tables.node_symbol.insert(NodeKey::of(target), prefs);
                        row_scope = self.with_row(row_scope, prefs);
                    } else if let Some(model) =
                        self.resolve_model_path(module, &segments, target, text, diags)
                    {
                        row_scope = self.with_row(row_scope, model);
                    }
                }
                for child in kids(node) {
                    if is_expression(child.kind) {
                        self.walk_expr(module, row_scope, child, text, ExprCtx::bare(), diags);
                    }
                }
            }
            _ => {}
        }
    }

    /// Scope with a `row: Model` binding.
    fn with_row(&mut self, parent: ScopeId, model: SymbolId) -> ScopeId {
        let scope = self.new_scope(Some(parent));
        self.tables.scopes[scope.0 as usize].bindings.insert(
            "row".to_string(),
            Binding::Context(ContextVar::RowModel(model)),
        );
        scope
    }

    /// Resolve a field/parameter type, label and value expressions.
    #[allow(clippy::too_many_arguments)]
    fn resolve_field_parts(
        &mut self,
        text: &'a str,
        module: ModuleId,
        scope: ScopeId,
        _owner: Option<SymbolId>,
        field: &SyntaxNode,
        _constant: bool,
        diags: &mut Vec<Diagnostic>,
    ) {
        let parts = kids(field);
        let mut i = 0;
        while i < parts.len() {
            let part = parts[i];
            if is_type_node(part.kind) {
                self.resolve_type(text, module, part, diags);
            } else if is_name(part, text, "label") {
                if let Some(caption) = parts.get(i + 2) {
                    self.resolve_caption(text, module, caption, diags);
                }
            } else if part.kind == SyntaxKind::DescriptionValue {
                self.resolve_description_value(text, module, part, diags);
            } else if is_expression(part.kind)
                && !is_name(
                    parts.get(i.saturating_sub(1)).copied().unwrap_or(part),
                    text,
                    "label",
                )
            {
                self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
            }
            i += 1;
        }
    }

    fn resolve_derive_body(
        &mut self,
        _file: SourceId,
        text: &'a str,
        module: ModuleId,
        root: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        let parts = kids(node);
        let is_function = parts.iter().any(|n| is_punct(n, text, "("));
        for part in &parts {
            if is_type_node(part.kind) {
                self.resolve_type(text, module, part, diags);
            }
        }
        if is_function {
            let name = parts
                .iter()
                .find(|n| n.kind == SyntaxKind::Path)
                .map(|p| path_segments(p, text).join("."))
                .unwrap_or_default();
            let params = match self.lookup_prod(module, &name) {
                Some(ScopedName::Local(id)) => match &self.tables.symbols[id.0 as usize].kind {
                    SymbolKind::DeriveFn { params, .. } => params.clone(),
                    _ => Vec::new(),
                },
                _ => Vec::new(),
            };
            self.resolve_param_defaults(text, module, root, node, &params, diags);
            let mut scope = self.with_facts(root, ActorKind::Nullable, true, true);
            for param in &params {
                let name = self.tables.symbols[param.0 as usize].name.clone();
                let span = self.tables.symbols[param.0 as usize].span;
                if self.param_hides_contextual(scope, &name) {
                    diags.push(Diagnostic::error(
                        "E2012",
                        format!("parameter '{name}' hides the active contextual fact '{name}'"),
                        span,
                    ));
                } else {
                    self.tables.scopes[scope.0 as usize]
                        .bindings
                        .insert(name, Binding::Symbol(*param));
                }
                let _ = &mut scope;
            }
            for part in parts {
                if is_expression(part.kind) {
                    self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
                }
            }
        } else {
            let path = parts.iter().find(|n| n.kind == SyntaxKind::Path);
            let model = path.and_then(|p| {
                let segments = path_segments(p, text);
                if segments.len() == 2 {
                    match self.lookup_prod(module, segments[0]) {
                        Some(ScopedName::Local(id)) => Some(id),
                        _ => None,
                    }
                } else {
                    None
                }
            });
            let mut scope = self.with_facts(root, ActorKind::Nullable, true, true);
            if let Some(model) = model {
                scope = self.with_row(scope, model);
            }
            for part in parts {
                if is_type_node(part.kind) {
                    continue;
                }
                if is_expression(part.kind) {
                    self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
                } else if is_name(part, text, "label") {
                    continue;
                }
            }
            for (i, part) in kids(node).iter().enumerate() {
                if is_name(part, text, "label")
                    && let Some(caption) = kids(node).get(i + 2)
                {
                    self.resolve_caption(text, module, caption, diags);
                }
            }
        }
    }

    /// Whether a parameter name collides with a contextual fact in `scope`.
    fn param_hides_contextual(&self, scope: ScopeId, name: &str) -> bool {
        let mut current = Some(scope);
        while let Some(id) = current {
            let scope_ref = &self.tables.scopes[id.0 as usize];
            if let Some(existing) = scope_ref.bindings.get(name) {
                return matches!(existing, Binding::Context(_));
            }
            current = scope_ref.parent;
        }
        false
    }

    /// Resolve parameter defaults left to right (each sees earlier params).
    fn resolve_param_defaults(
        &mut self,
        text: &'a str,
        module: ModuleId,
        root: ScopeId,
        node: &SyntaxNode,
        params: &[SymbolId],
        diags: &mut Vec<Diagnostic>,
    ) {
        let param_nodes: Vec<&SyntaxNode> = node
            .children
            .iter()
            .filter(|c| c.kind == SyntaxKind::Parameter)
            .collect();
        for (i, param_node) in param_nodes.iter().enumerate() {
            let parts = kids(param_node);
            for part in &parts {
                if is_type_node(part.kind) {
                    self.resolve_type(text, module, part, diags);
                }
            }
            let mut scope = self.with_facts(root, ActorKind::Nullable, false, true);
            for param in params.iter().take(i) {
                let name = self.tables.symbols[param.0 as usize].name.clone();
                self.tables.scopes[scope.0 as usize]
                    .bindings
                    .insert(name, Binding::Symbol(*param));
            }
            let _ = &mut scope;
            let mut seen_eq = false;
            for part in parts {
                if part.kind == SyntaxKind::Punct {
                    seen_eq = true;
                    continue;
                }
                if seen_eq && is_expression(part.kind) {
                    self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
                } else if part.kind == SyntaxKind::DescriptionValue {
                    self.resolve_description_value(text, module, part, diags);
                } else if is_name(part, text, "label") {
                    break;
                }
            }
            for (j, part) in kids(param_node).iter().enumerate() {
                if is_name(part, text, "label")
                    && let Some(caption) = kids(param_node).get(j + 2)
                {
                    self.resolve_caption(text, module, caption, diags);
                }
            }
        }
    }

    fn resolve_fixture(
        &mut self,
        text: &'a str,
        module: ModuleId,
        root: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        let parts = kids(node);
        let name = Self::decl_name(text, node, &["export", "fixture"]).map(|(n, _)| n);
        let head = parts.iter().find(|n| n.kind == SyntaxKind::Path);
        let object = parts.iter().find(|n| n.kind == SyntaxKind::Object);
        let test_root = self.test_root(module, root);
        let scope = self.with_facts(test_root, ActorKind::NonNull, true, false);
        if let (Some(name), Some(head)) = (&name, head) {
            let segments = path_segments(head, text);
            let target = self.resolve_fixture_head(module, &segments, head, text, diags);
            if let Some(ScopedName::Local(id) | ScopedName::Imported { target: id, .. }) =
                self.tables.module_scopes[module.0 as usize]
                    .test
                    .get(name)
                    .cloned()
                && let SymbolKind::Fixture { target: slot } =
                    &mut self.tables.symbols[id.0 as usize].kind
            {
                *slot = target;
            }
            let _ = &segments;
        }
        if let Some(object) = object {
            self.walk_object_values(module, scope, object, text, diags);
        }
    }

    /// Resolve a fixture recipe head: `user`/`file` keywords, a model, or
    /// an operation (delivery recipe).
    fn resolve_fixture_head(
        &mut self,
        module: ModuleId,
        segments: &[&str],
        node: &SyntaxNode,
        text: &str,
        diags: &mut Vec<Diagnostic>,
    ) -> FixtureTarget {
        if segments == ["user"] {
            return FixtureTarget::User;
        }
        if segments == ["file"] {
            return FixtureTarget::File;
        }
        if segments.len() == 1 {
            match self.lookup_prod(module, segments[0]) {
                Some(ScopedName::Local(id) | ScopedName::Imported { target: id, .. }) => {
                    self.tables.node_symbol.insert(NodeKey::of(node), id);
                    return match &self.tables.symbols[id.0 as usize].kind {
                        SymbolKind::Model { .. } => FixtureTarget::Model(id),
                        SymbolKind::Scenario { .. }
                        | SymbolKind::Capability { .. }
                        | SymbolKind::CapabilityOp { .. }
                        | SymbolKind::CrudOp { .. } => FixtureTarget::Operation(Some(id)),
                        _ => FixtureTarget::Unknown,
                    };
                }
                Some(ScopedName::External { .. }) => return FixtureTarget::Operation(None),
                None => {}
            }
        }
        if segments.len() == 2 {
            if let Some(op) = self.resolve_op_path(module, segments, node, text, diags) {
                self.tables.node_symbol.insert(NodeKey::of(node), op);
                return FixtureTarget::Operation(Some(op));
            }
            return FixtureTarget::Unknown;
        }
        diags.push(Diagnostic::error(
            "E2001",
            format!("unresolved name '{}'", segments.join(".")),
            node.span,
        ));
        FixtureTarget::Unknown
    }

    fn resolve_capability(
        &mut self,
        text: &'a str,
        module: ModuleId,
        root: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        if let Some(version) = attribute_value(node, "version", text) {
            self.walk_expr(module, root, version, text, ExprCtx::bare(), diags);
        }
        if let Some(label) = attribute_value(node, "label", text) {
            self.resolve_caption(text, module, label, diags);
        }
        let name = Self::decl_name(text, node, &["export", "capability"]).map(|(n, _)| n);
        let cap = name.as_deref().and_then(|n| self.lookup_prod(module, n));
        let (ops, events) = match cap {
            Some(ScopedName::Local(id)) => match &self.tables.symbols[id.0 as usize].kind {
                SymbolKind::Capability { ops, events } => (ops.clone(), events.clone()),
                _ => (Vec::new(), Vec::new()),
            },
            _ => (Vec::new(), Vec::new()),
        };
        for child in node.children.iter().filter(|c| {
            matches!(c.kind, SyntaxKind::CapabilityOp | SyntaxKind::Event) && !has_error(c)
        }) {
            if child.kind == SyntaxKind::CapabilityOp {
                let op_name = kids(child)
                    .iter()
                    .find_map(|n| name_text(n, text))
                    .unwrap_or("");
                let params = ops
                    .iter()
                    .find(|id| self.tables.symbols[id.0 as usize].name == op_name)
                    .and_then(|id| match &self.tables.symbols[id.0 as usize].kind {
                        SymbolKind::CapabilityOp { params, .. } => Some(params.clone()),
                        _ => None,
                    })
                    .unwrap_or_default();
                self.resolve_param_defaults(text, module, root, child, &params, diags);
                for part in kids(child) {
                    if is_type_node(part.kind) {
                        self.resolve_type(text, module, part, diags);
                    }
                }
            } else {
                let _ = &events;
                let scope = self.with_facts(root, ActorKind::NonNull, true, true);
                for field in child
                    .children
                    .iter()
                    .filter(|c| c.kind == SyntaxKind::Field)
                {
                    self.resolve_field_parts(text, module, scope, None, field, false, diags);
                }
            }
        }
    }

    fn resolve_message(
        &mut self,
        text: &'a str,
        module: ModuleId,
        root: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        let name = Self::decl_name(text, node, &["export", "message"]).map(|(n, _)| n);
        let params = match name.as_deref().and_then(|n| self.lookup_prod(module, n)) {
            Some(ScopedName::Local(id)) => match &self.tables.symbols[id.0 as usize].kind {
                SymbolKind::Message { params } => params.clone(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        };
        self.resolve_param_defaults(text, module, root, node, &params, diags);
    }

    fn resolve_rule(
        &mut self,
        text: &'a str,
        module: ModuleId,
        root: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        let parts = kids(node);
        let target = parts.iter().find(|n| n.kind == SyntaxKind::Path);
        let mut scope = self.with_facts(root, ActorKind::Nullable, true, true);
        if let Some(target) = target {
            let segments = path_segments(target, text);
            if let Some(model) = self.resolve_model_path(module, &segments, target, text, diags) {
                scope = self.with_row(scope, model);
            }
        }
        for child in kids(node) {
            if child.kind != SyntaxKind::Attribute {
                continue;
            }
            let Some((key, value)) = attribute_parts(child) else {
                continue;
            };
            let word = name_text(key, text).unwrap_or("");
            if matches!(word, "read" | "where" | "when" | "until") {
                self.walk_expr(module, scope, value, text, ExprCtx::bare(), diags);
            }
        }
    }

    /// Resolve a single-segment model path in module scope.
    fn resolve_model_path(
        &mut self,
        module: ModuleId,
        segments: &[&str],
        node: &SyntaxNode,
        text: &str,
        diags: &mut Vec<Diagnostic>,
    ) -> Option<SymbolId> {
        if segments.len() != 1 {
            diags.push(Diagnostic::error(
                "E2001",
                format!("unresolved name '{}'", segments.join(".")),
                node.span,
            ));
            return None;
        }
        match self.lookup_prod(module, segments[0]) {
            Some(ScopedName::Local(id) | ScopedName::Imported { target: id, .. }) => {
                self.tables.node_symbol.insert(NodeKey::of(node), id);
                Some(id)
            }
            Some(ScopedName::External { .. }) => None,
            None => {
                diags.push(Diagnostic::error(
                    "E2001",
                    format!("unresolved name '{}'", segments[0]),
                    segment_span(node, text, 0),
                ));
                None
            }
        }
    }

    /// Resolve an operation path: `scenario`, `Model.create`, `Cap.op`.
    fn resolve_op_path(
        &mut self,
        module: ModuleId,
        segments: &[&str],
        node: &SyntaxNode,
        text: &str,
        diags: &mut Vec<Diagnostic>,
    ) -> Option<SymbolId> {
        if segments.is_empty() {
            return None;
        }
        let head = match self.lookup_prod(module, segments[0]) {
            Some(ScopedName::Local(id) | ScopedName::Imported { target: id, .. }) => id,
            Some(ScopedName::External { .. }) => return None,
            None => {
                diags.push(Diagnostic::error(
                    "E2001",
                    format!("unresolved name '{}'", segments[0]),
                    segment_span(node, text, 0),
                ));
                return None;
            }
        };
        if self.is_judgment(head) {
            // `Judge.evaluate` names the derived evaluate operation:
            // resolved but opaque (delivery/send/fixture consumers
            // treat the missing symbol as an untypable-but-valid
            // target, like an external operation).
            return None;
        }
        if segments.len() == 1 {
            return Some(head);
        }
        if segments.len() == 2 {
            let (ops, kind_name) = match &self.tables.symbols[head.0 as usize].kind {
                SymbolKind::Capability { ops, .. } => (ops.clone(), "capability"),
                SymbolKind::Model { .. } => {
                    return self.resolve_crud_op(module, head, segments[1], node, text, diags);
                }
                _ => {
                    self.tables.unresolved_members.push(UnresolvedMember {
                        node: NodeKey::of(node),
                        span: segment_span(node, text, 1),
                        base: self.tables.symbols[head.0 as usize].name.clone(),
                        name: segments[1].to_string(),
                    });
                    return None;
                }
            };
            let _ = kind_name;
            for op in ops {
                if self.tables.symbols[op.0 as usize].name == segments[1] {
                    return Some(op);
                }
            }
            let base = self.tables.symbols[head.0 as usize].name.clone();
            self.tables.unresolved_members.push(UnresolvedMember {
                node: NodeKey::of(node),
                span: segment_span(node, text, 1),
                base,
                name: segments[1].to_string(),
            });
            return None;
        }
        self.tables.unresolved_members.push(UnresolvedMember {
            node: NodeKey::of(node),
            span: segment_span(node, text, 1),
            base: self.tables.symbols[head.0 as usize].name.clone(),
            name: segments[1].to_string(),
        });
        None
    }

    /// Resolve `Model.op` to a generated CRUD operation symbol.
    fn resolve_crud_op(
        &mut self,
        _module: ModuleId,
        model: SymbolId,
        op: &str,
        node: &SyntaxNode,
        text: &str,
        _diags: &mut Vec<Diagnostic>,
    ) -> Option<SymbolId> {
        let crud_op = match op {
            "create" => CrudOp::Create,
            "update" => CrudOp::Update,
            "delete" => CrudOp::Delete,
            _ => {
                let base = self.tables.symbols[model.0 as usize].name.clone();
                self.tables.unresolved_members.push(UnresolvedMember {
                    node: NodeKey::of(node),
                    span: segment_span(node, text, 1),
                    base,
                    name: op.to_string(),
                });
                return None;
            }
        };
        let canonical = format!(
            "{}.{}.{}",
            self.tables.modules[self.tables.symbols[model.0 as usize].module.0 as usize].name,
            self.tables.symbols[model.0 as usize].name,
            op
        );
        if let Some(&id) = self.tables.by_canonical.get(&canonical) {
            return Some(id);
        }
        let base = self.tables.symbols[model.0 as usize].name.clone();
        self.tables.unresolved_members.push(UnresolvedMember {
            node: NodeKey::of(node),
            span: segment_span(node, text, 1),
            base,
            name: format!("{op} (disabled or no crud declaration)"),
        });
        let _ = crud_op;
        None
    }
}

/// Byte span of the `i`-th segment of a `Path` node.
fn segment_span(node: &SyntaxNode, _text: &str, index: usize) -> Span {
    let names: Vec<&SyntaxNode> = node
        .children
        .iter()
        .filter(|c| c.kind == SyntaxKind::Name)
        .collect();
    names.get(index).map(|n| n.span).unwrap_or(node.span)
}

/// Expression-walk context: which names the position may use.
///
/// Positions differ by their scope alone today; the parameter keeps the
/// call shape stable for later context-sensitive rules.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ExprCtx;

impl ExprCtx {
    pub fn bare() -> Self {
        Self
    }
}

/// Whether this CST kind is a value-expression node.
pub(crate) fn is_expression(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::Literal
            | SyntaxKind::NameRef
            | SyntaxKind::Group
            | SyntaxKind::Array
            | SyntaxKind::Object
            | SyntaxKind::Construct
            | SyntaxKind::Member
            | SyntaxKind::Call
            | SyntaxKind::Unary
            | SyntaxKind::Binary
            | SyntaxKind::Query
            | SyntaxKind::MessageValue
    )
}

impl<'a> Resolver<'a> {
    // --- Pass 5b: type paths ----------------------------------------------

    /// Resolve a type node: named paths, union arms, suffixes (structure
    /// only; representation rules are the types pass), inline-enum
    /// duplicates (`E2002`) and action/delivery targets.
    fn resolve_type(
        &mut self,
        text: &'a str,
        module: ModuleId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        if has_error(node) {
            return;
        }
        match node.kind {
            SyntaxKind::NamedType => {
                if let Some(path) = kids(node).iter().find(|n| n.kind == SyntaxKind::Path) {
                    let segments = path_segments(path, text);
                    self.resolve_type_path(module, &segments, path, text, diags);
                }
            }
            SyntaxKind::UnionType => {
                for child in kids(node) {
                    if child.kind == SyntaxKind::Path {
                        let segments = path_segments(child, text);
                        self.resolve_type_path(module, &segments, child, text, diags);
                    }
                }
            }
            SyntaxKind::ArrayType | SyntaxKind::NullableType => {
                for child in kids(node) {
                    if is_type_node(child.kind) {
                        self.resolve_type(text, module, child, diags);
                    }
                }
            }
            SyntaxKind::EnumType => {
                let mut seen: HashSet<String> = HashSet::new();
                for child in kids(node) {
                    if child.kind != SyntaxKind::Path {
                        continue;
                    }
                    for case in path_segments(child, text) {
                        if !seen.insert(case.to_string()) {
                            diags.push(Diagnostic::error(
                                "E2002",
                                format!("duplicate enum case '{case}'"),
                                child.span,
                            ));
                        }
                    }
                }
            }
            SyntaxKind::ActionType | SyntaxKind::DeliveryType | SyntaxKind::InvocationType => {
                for child in kids(node) {
                    if child.kind != SyntaxKind::Path {
                        continue;
                    }
                    let segments = path_segments(child, text);
                    if let Some(op) = self.resolve_op_path(module, &segments, child, text, diags) {
                        self.tables.node_symbol.insert(NodeKey::of(child), op);
                    }
                }
            }
            _ => {}
        }
    }

    /// Resolve a type-position path: builtin scalar, named type symbol,
    /// or `Model.field` reuse (deeper chains continue in the types pass
    /// with resolved field types).
    fn resolve_type_path(
        &mut self,
        module: ModuleId,
        segments: &[&str],
        node: &SyntaxNode,
        text: &str,
        diags: &mut Vec<Diagnostic>,
    ) -> Option<TypeRef> {
        if segments.is_empty() {
            return None;
        }
        if segments.len() == 1 {
            if is_builtin_type(segments[0]) {
                let typeref = TypeRef::Scalar(segments[0].to_string());
                self.tables
                    .node_typeref
                    .insert(NodeKey::of(node), typeref.clone());
                return Some(typeref);
            }
            match self.lookup_prod(module, segments[0]) {
                Some(ScopedName::Local(id) | ScopedName::Imported { target: id, .. })
                    if self.is_judgment(id) =>
                {
                    // A judgment in type position resolves the name but
                    // stays opaque: no `TypeRef`, so the types pass
                    // treats the shape as unknowable (like an external
                    // import) while the derived interface is
                    // unimplemented (DESIGN:897).
                    self.tables.node_symbol.insert(NodeKey::of(node), id);
                    return None;
                }
                Some(ScopedName::Local(id) | ScopedName::Imported { target: id, .. }) => {
                    self.tables.node_symbol.insert(NodeKey::of(node), id);
                    let typeref = TypeRef::Symbol(id);
                    self.tables
                        .node_typeref
                        .insert(NodeKey::of(node), typeref.clone());
                    return Some(typeref);
                }
                Some(ScopedName::External { .. }) => {
                    let typeref = TypeRef::External;
                    self.tables
                        .node_typeref
                        .insert(NodeKey::of(node), typeref.clone());
                    return Some(typeref);
                }
                None => {}
            }
            if self.tables.module_by_name.contains_key(segments[0]) {
                diags.push(Diagnostic::error(
                    "E2001",
                    format!(
                        "unresolved name '{}'; a package name is not a type",
                        segments[0]
                    ),
                    segment_span(node, text, 0),
                ));
                return None;
            }
            diags.push(Diagnostic::error(
                "E2001",
                format!("unresolved name '{}'", segments[0]),
                segment_span(node, text, 0),
            ));
            return None;
        }
        if self.tables.module_by_name.contains_key(segments[0]) {
            return self.resolve_qualified_type(module, segments, node, text, diags);
        }
        let head = self.resolve_type_head(module, segments, node, text, diags)?;
        if self.is_judgment(head) {
            // `Judgment.question.aspect` paths name derived-interface
            // members: resolved but opaque (see the single-segment
            // arm above).
            return None;
        }
        let mut fields = Vec::new();
        if let Some(field) = self.tables.symbols[head.0 as usize]
            .fields_of()
            .iter()
            .find(|f| self.tables.symbols[f.0 as usize].name == segments[1])
            .copied()
        {
            fields.push(field);
        } else {
            let base = self.tables.symbols[head.0 as usize].name.clone();
            self.tables.unresolved_members.push(UnresolvedMember {
                node: NodeKey::of(node),
                span: segment_span(node, text, 1),
                base,
                name: segments[1].to_string(),
            });
            return None;
        }
        let typeref = TypeRef::FieldChain {
            head,
            fields,
            consumed: 2,
        };
        self.tables
            .node_typeref
            .insert(NodeKey::of(node), typeref.clone());
        Some(typeref)
    }

    /// Resolve a package-qualified type path (`Pkg.Type[.field...]`):
    /// the member must be imported, then field navigation.
    fn resolve_qualified_type(
        &mut self,
        module: ModuleId,
        segments: &[&str],
        node: &SyntaxNode,
        text: &str,
        diags: &mut Vec<Diagnostic>,
    ) -> Option<TypeRef> {
        let provider = self.tables.module_by_name[segments[0]];
        let imported = self.tables.modules[module.0 as usize]
            .imports
            .iter()
            .any(|import| {
                import.provider == segments[0]
                    && import.members.iter().any(|m| m.name == segments[1])
            });
        if !imported {
            diags.push(Diagnostic::error(
                "E2001",
                format!(
                    "unresolved name '{}'; without a use, a cross-package reference is an error",
                    segments[0..2].join(".")
                ),
                node.span,
            ));
            return None;
        }
        let head = match self.tables.module_scopes[provider.0 as usize]
            .prod
            .get(segments[1])
        {
            Some(ScopedName::Local(id)) => *id,
            _ => {
                diags.push(Diagnostic::error(
                    "E2001",
                    format!("unresolved name '{}'", segments[0..2].join(".")),
                    node.span,
                ));
                return None;
            }
        };
        if self.is_judgment(head) {
            // Package-qualified judgment paths resolve the name but
            // stay opaque (see `resolve_type_path`).
            self.tables.node_symbol.insert(NodeKey::of(node), head);
            return None;
        }
        if segments.len() == 2 {
            self.tables.node_symbol.insert(NodeKey::of(node), head);
            let typeref = TypeRef::Symbol(head);
            self.tables
                .node_typeref
                .insert(NodeKey::of(node), typeref.clone());
            return Some(typeref);
        }
        let mut fields = Vec::new();
        if let Some(field) = self.tables.symbols[head.0 as usize]
            .fields_of()
            .iter()
            .find(|f| self.tables.symbols[f.0 as usize].name == segments[2])
            .copied()
        {
            fields.push(field);
        } else {
            let base = self.tables.symbols[head.0 as usize].name.clone();
            self.tables.unresolved_members.push(UnresolvedMember {
                node: NodeKey::of(node),
                span: segment_span(node, text, 2),
                base,
                name: segments[2].to_string(),
            });
            return None;
        }
        let typeref = TypeRef::FieldChain {
            head,
            fields,
            consumed: 3,
        };
        self.tables
            .node_typeref
            .insert(NodeKey::of(node), typeref.clone());
        Some(typeref)
    }

    /// Resolve the head of a multi-segment type path (scope or qualified).
    fn resolve_type_head(
        &mut self,
        module: ModuleId,
        segments: &[&str],
        node: &SyntaxNode,
        text: &str,
        diags: &mut Vec<Diagnostic>,
    ) -> Option<SymbolId> {
        if is_builtin_type(segments[0]) {
            self.tables.unresolved_members.push(UnresolvedMember {
                node: NodeKey::of(node),
                span: segment_span(node, text, 1),
                base: segments[0].to_string(),
                name: segments[1].to_string(),
            });
            return None;
        }
        match self.lookup_prod(module, segments[0]) {
            Some(ScopedName::Local(id) | ScopedName::Imported { target: id, .. }) => Some(id),
            Some(ScopedName::External { .. }) => None,
            None => {
                diags.push(Diagnostic::error(
                    "E2001",
                    format!("unresolved name '{}'", segments[0]),
                    segment_span(node, text, 0),
                ));
                None
            }
        }
    }
}

impl<'a> Resolver<'a> {
    // --- Pass 5c: When ------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    fn resolve_when(
        &mut self,
        _file: SourceId,
        text: &'a str,
        module: ModuleId,
        root: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        if has_error(node) {
            return;
        }
        match node.kind {
            SyntaxKind::Crud => self.resolve_crud_body(text, module, root, node, diags),
            SyntaxKind::Scenario => self.resolve_scenario(text, module, root, node, diags),
            _ => {}
        }
    }

    fn resolve_crud_body(
        &mut self,
        text: &'a str,
        module: ModuleId,
        root: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        let parts = kids(node);
        let target = parts.iter().find(|n| n.kind == SyntaxKind::Path);
        let mut row_scope = self.with_facts(root, ActorKind::Nullable, true, true);
        if let Some(target) = target {
            let segments = path_segments(target, text);
            if let Some(model) = self.resolve_model_path(module, &segments, target, text, diags) {
                row_scope = self.with_row(row_scope, model);
            }
        }
        if let Some(by) = attribute_value(node, "by", text) {
            let scope = self.with_facts(root, ActorKind::Nullable, false, true);
            self.walk_expr(module, scope, by, text, ExprCtx::bare(), diags);
        }
        if let Some(when) = attribute_value(node, "when", text) {
            self.walk_expr(module, row_scope, when, text, ExprCtx::bare(), diags);
        }
        if let Some(label) = attribute_value(node, "label", text) {
            self.resolve_caption(text, module, label, diags);
        }
        for child in kids(node) {
            if child.kind == SyntaxKind::Examples {
                self.resolve_example_headers(text, module, root, child, diags);
            }
        }
    }

    fn resolve_scenario(
        &mut self,
        text: &'a str,
        module: ModuleId,
        root: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        let name = Self::decl_name(text, node, &["export", "scenario"]).map(|(n, _)| n);
        // A handler whose declaration failed (duplicate or closed
        // builtin name, `E2002`) has no symbol; its body still
        // resolves as trusted when the node carries `on=` (mirrors
        // the index-time predicate) so injected `event` stays
        // visible instead of cascading `E2001`.
        let cst_trusted = node.children.iter().any(|c| {
            c.kind == SyntaxKind::Attribute
                && attribute_parts(c).is_some_and(|(k, _)| is_name(k, text, "on"))
        });
        let (params, trusted) = match name.as_deref().and_then(|n| self.lookup_prod(module, n)) {
            Some(ScopedName::Local(id)) => match &self.tables.symbols[id.0 as usize].kind {
                SymbolKind::Scenario {
                    params, trusted, ..
                } => (params.clone(), *trusted),
                _ => (Vec::new(), cst_trusted),
            },
            _ => (Vec::new(), cst_trusted),
        };
        self.resolve_param_defaults(text, module, root, node, &params, diags);
        if let Some(result) = result_annotation(node) {
            self.resolve_type(text, module, result, diags);
        }
        for child in kids(node) {
            if child.kind != SyntaxKind::Attribute {
                continue;
            }
            let Some((key, value)) = attribute_parts(child) else {
                continue;
            };
            if is_name(key, text, "label") {
                self.resolve_caption(text, module, value, diags);
            }
        }
        if trusted {
            let mut scope = self.with_facts(root, ActorKind::Null, true, true);
            self.tables.scopes[scope.0 as usize]
                .bindings
                .insert("event".to_string(), Binding::Context(ContextVar::Event));
            let _ = &mut scope;
            self.resolve_execution(text, module, scope, node, diags);
        } else {
            if let Some(by) = node.children.iter().find_map(|c| {
                if c.kind == SyntaxKind::Attribute {
                    attribute_parts(c).and_then(|(k, v)| is_name(k, text, "by").then_some(v))
                } else {
                    None
                }
            }) {
                let mut scope = self.with_facts(root, ActorKind::Nullable, false, true);
                for param in &params {
                    let name = self.tables.symbols[param.0 as usize].name.clone();
                    self.tables.scopes[scope.0 as usize]
                        .bindings
                        .insert(name, Binding::Symbol(*param));
                }
                let _ = &mut scope;
                self.walk_expr(module, scope, by, text, ExprCtx::bare(), diags);
            }
            let actor = if node.children.iter().any(|c| {
                c.kind == SyntaxKind::Attribute
                    && attribute_parts(c)
                        .is_some_and(|(k, v)| is_name(k, text, "by") && self.proves_auth(v, text))
            }) {
                ActorKind::NonNull
            } else {
                ActorKind::Nullable
            };
            let mut scope = self.with_facts(root, actor, true, true);
            for param in &params {
                let name = self.tables.symbols[param.0 as usize].name.clone();
                let span = self.tables.symbols[param.0 as usize].span;
                if self.param_hides_contextual(scope, &name) {
                    diags.push(Diagnostic::error(
                        "E2012",
                        format!("parameter '{name}' hides the active contextual fact '{name}'"),
                        span,
                    ));
                } else {
                    self.tables.scopes[scope.0 as usize]
                        .bindings
                        .insert(name, Binding::Symbol(*param));
                }
            }
            let _ = &mut scope;
            self.resolve_execution(text, module, scope, node, diags);
        }
        for child in kids(node) {
            if child.kind == SyntaxKind::Examples {
                self.resolve_example_headers(text, module, root, child, diags);
            }
        }
    }

    /// Resolve `examples` header bindings (fixture/name resolution only;
    /// table cells and sequences are PR5).
    fn resolve_example_headers(
        &mut self,
        text: &'a str,
        module: ModuleId,
        root: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        if has_error(node) {
            return;
        }
        let test_root = self.test_root(module, root);
        let scope = self.with_facts(test_root, ActorKind::NonNull, true, false);
        for child in kids(node) {
            if child.kind == SyntaxKind::Attribute
                && let Some((_, value)) = attribute_parts(child)
            {
                self.walk_expr(module, scope, value, text, ExprCtx::bare(), diags);
            }
        }
    }

    /// Walk leading guards and the `do` body with `scope`.
    fn resolve_execution(
        &mut self,
        text: &'a str,
        module: ModuleId,
        scope: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        for child in kids(node) {
            match child.kind {
                SyntaxKind::Require => self.walk_guard(text, module, scope, child, diags),
                SyntaxKind::DoBlock => {
                    let block = self.new_scope(Some(scope));
                    for stmt in kids(child) {
                        self.walk_statement(text, module, block, stmt, diags);
                    }
                }
                _ => {}
            }
        }
    }

    /// Walk one `require` guard (predicate plus optional message).
    fn walk_guard(
        &mut self,
        text: &'a str,
        module: ModuleId,
        scope: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        if has_error(node) {
            return;
        }
        for part in kids(node) {
            if is_expression(part.kind) {
                self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
            }
        }
    }

    /// Walk one execution statement, introducing bindings into `scope`.
    fn walk_statement(
        &mut self,
        text: &'a str,
        module: ModuleId,
        scope: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        if has_error(node) {
            return;
        }
        match node.kind {
            SyntaxKind::Require => self.walk_guard(text, module, scope, node, diags),
            SyntaxKind::Let => {
                let parts = kids(node);
                let name = parts.iter().find_map(|n| {
                    let word = name_text(n, text)?;
                    (word != "let").then(|| (word.to_string(), n.span))
                });
                for part in &parts {
                    if is_expression(part.kind) {
                        self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
                    }
                }
                if let Some((name, span)) = name {
                    self.bind_authored(
                        scope,
                        &name,
                        Binding::Let {
                            node: NodeKey::of(node),
                        },
                        span,
                        "let",
                        diags,
                    );
                }
            }
            SyntaxKind::Create => {
                let parts = kids(node);
                if let Some(path) = parts.iter().find(|n| n.kind == SyntaxKind::Path) {
                    let segments = path_segments(path, text);
                    self.resolve_model_path(module, &segments, path, text, diags);
                }
                if let Some(object) = parts.iter().find(|n| n.kind == SyntaxKind::Object) {
                    self.walk_object_values(module, scope, object, text, diags);
                }
                if let Some(binding) = as_binding(node, text) {
                    self.bind_authored(
                        scope,
                        &binding.0,
                        Binding::CreateAs {
                            node: NodeKey::of(node),
                        },
                        binding.1,
                        "create binding",
                        diags,
                    );
                }
            }
            SyntaxKind::Set => {
                let parts = kids(node);
                if let Some(target) = parts.iter().find(|n| n.kind == SyntaxKind::Path) {
                    self.tables.expr_scope.insert(NodeKey::of(target), scope);
                }
                if let Some(object) = parts.iter().find(|n| n.kind == SyntaxKind::Object) {
                    self.walk_object_values(module, scope, object, text, diags);
                }
            }
            SyntaxKind::Delete => {
                let parts = kids(node);
                if let Some(target) = parts.iter().find(|n| n.kind == SyntaxKind::Path) {
                    self.tables.expr_scope.insert(NodeKey::of(target), scope);
                }
            }
            SyntaxKind::Call => {
                let parts = kids(node);
                for part in &parts {
                    if is_expression(part.kind) {
                        self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
                    } else if part.kind == SyntaxKind::Object {
                        self.walk_object_values(module, scope, part, text, diags);
                    }
                }
                if let Some(binding) = as_binding(node, text) {
                    self.bind_authored(
                        scope,
                        &binding.0,
                        Binding::CallAs {
                            node: NodeKey::of(node),
                        },
                        binding.1,
                        "call binding",
                        diags,
                    );
                }
            }
            SyntaxKind::Emit => {
                let parts = kids(node);
                if let Some(path) = parts.iter().find(|n| n.kind == SyntaxKind::Path) {
                    let segments = path_segments(path, text);
                    self.resolve_model_path(module, &segments, path, text, diags);
                }
                if let Some(object) = parts.iter().find(|n| n.kind == SyntaxKind::Object) {
                    self.walk_object_values(module, scope, object, text, diags);
                }
            }
            SyntaxKind::Send => {
                for part in kids(node) {
                    if is_expression(part.kind) {
                        self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
                    } else if part.kind == SyntaxKind::Object {
                        self.walk_object_values(module, scope, part, text, diags);
                    }
                }
                if let Some(binding) = as_binding(node, text) {
                    self.bind_authored(
                        scope,
                        &binding.0,
                        Binding::SendAs {
                            node: NodeKey::of(node),
                        },
                        binding.1,
                        "send binding",
                        diags,
                    );
                }
            }
            SyntaxKind::Schedule => {
                let parts = kids(node);
                let mut event_path = None;
                for (i, part) in parts.iter().enumerate() {
                    if is_name(part, text, "event") {
                        event_path = parts.get(i + 2).copied();
                    }
                }
                for part in &parts {
                    if is_expression(part.kind) {
                        self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
                    } else if part.kind == SyntaxKind::Path
                        && event_path.is_some_and(|e| std::ptr::eq(*part, e))
                    {
                        let segments = path_segments(part, text);
                        self.resolve_model_path(module, &segments, part, text, diags);
                    } else if part.kind == SyntaxKind::Object {
                        self.walk_object_values(module, scope, part, text, diags);
                    }
                }
            }
            SyntaxKind::Cancel | SyntaxKind::Return => {
                for part in kids(node) {
                    if is_expression(part.kind) {
                        self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
                    }
                }
            }
            SyntaxKind::If => {
                let parts = kids(node);
                let mut else_at = None;
                for (i, part) in parts.iter().enumerate() {
                    if is_name(part, text, "else") {
                        else_at = Some(i);
                    }
                }
                let mut cond_done = false;
                let then_scope = self.new_scope(Some(scope));
                let else_scope = self.new_scope(Some(scope));
                for (i, part) in parts.iter().enumerate() {
                    if is_name(part, text, "if") || is_name(part, text, "else") {
                        continue;
                    }
                    if !cond_done && is_expression(part.kind) {
                        self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
                        cond_done = true;
                    } else if cond_done
                        && !matches!(part.kind, SyntaxKind::Punct | SyntaxKind::Name)
                    {
                        // Any post-condition expression is a body `call`
                        // statement; anything else here is a body
                        // statement too.
                        let target = if else_at.is_some_and(|at| i > at) {
                            else_scope
                        } else {
                            then_scope
                        };
                        self.walk_statement(text, module, target, part, diags);
                    }
                }
            }
            SyntaxKind::For => {
                let parts = kids(node);
                let mut item: Option<(String, Span)> = None;
                let mut limit_at = None;
                for (i, part) in parts.iter().enumerate() {
                    if is_name(part, text, "for")
                        && let Some(name) = parts.get(i + 1).and_then(|n| name_text(n, text))
                    {
                        item = Some((name.to_string(), parts[i + 1].span));
                    }
                    if is_name(part, text, "limit") {
                        limit_at = Some(i);
                    }
                }
                // Header expressions (domain, then the `limit =` value)
                // resolve in the outer scope; the body resolves in the
                // item scope. Positions past the header are body
                // statements, including `call` (an expression kind).
                let mut header_end = 0;
                let mut seen_domain = false;
                for (i, part) in parts.iter().enumerate() {
                    if !is_expression(part.kind) {
                        continue;
                    }
                    let is_header = if !seen_domain {
                        seen_domain = true;
                        true
                    } else {
                        limit_at.is_some_and(|at| i == at + 2)
                    };
                    if is_header {
                        self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
                        header_end = i;
                    }
                }
                let body = self.new_scope(Some(scope));
                if let Some((name, span)) = item {
                    self.bind_authored(
                        body,
                        &name,
                        Binding::ForItem {
                            node: NodeKey::of(node),
                        },
                        span,
                        "for item",
                        diags,
                    );
                }
                for part in parts.iter().skip(header_end + 1) {
                    self.walk_statement(text, module, body, part, diags);
                }
            }
            _ => {}
        }
    }
}

/// `as NAME` binding of an effect node.
fn as_binding(node: &SyntaxNode, text: &str) -> Option<(String, Span)> {
    let parts = kids(node);
    for i in 0..parts.len() {
        if is_name(parts[i], text, "as") {
            return parts.get(i + 1).and_then(|n| name_text(n, text)).map(|n| {
                let span = parts[i + 1].span;
                (n.to_string(), span)
            });
        }
    }
    None
}

impl<'a> Resolver<'a> {
    /// Whether a `by` expression proves member/role authorization
    /// when TRUE (and so narrows `actor` to non-null): bare
    /// non-public predicates and their `and`-combinations; `or`
    /// needs both sides, `not` flips to the false polarity. A call
    /// admits only when it tests a declared role on the literal
    /// caller (T06 no-leak, mirroring the checker's
    /// `auth_proves_actor`); anything else proves nothing.
    fn proves_auth(&self, node: &SyntaxNode, text: &str) -> bool {
        match node.kind {
            SyntaxKind::NameRef => {
                let word = kids(node)
                    .iter()
                    .find_map(|n| name_text(n, text))
                    .unwrap_or("");
                matches!(word, "members" | "owner" | "authenticated")
            }
            SyntaxKind::Call => self.role_call_on_caller(node, text),
            SyntaxKind::Member => false,
            SyntaxKind::Group => kids(node)
                .iter()
                .filter(|c| c.kind != SyntaxKind::Punct)
                .any(|c| self.proves_auth(c, text)),
            SyntaxKind::Binary => {
                let parts = kids(node);
                if parts.len() != 3 {
                    return false;
                }
                let op = super::op_text(node, text).unwrap_or("");
                match op {
                    "and" => self.proves_auth(parts[0], text) || self.proves_auth(parts[2], text),
                    "or" => self.proves_auth(parts[0], text) && self.proves_auth(parts[2], text),
                    _ => false,
                }
            }
            SyntaxKind::Unary => {
                let parts = kids(node);
                let is_not = parts.first().is_some_and(|n| is_name(n, text, "not"));
                parts
                    .iter()
                    .find(|n| is_expression(n.kind))
                    .is_some_and(|operand| is_not && self.proves_auth_when_false(operand, text))
            }
            _ => false,
        }
    }

    /// Whether a `by` expression proves an authenticated caller when
    /// FALSE (T06, mirroring the checker): only a failing `public`
    /// test admits; `not` flips to the true polarity, `and`-false
    /// needs both sides, `or`-false needs either.
    fn proves_auth_when_false(&self, node: &SyntaxNode, text: &str) -> bool {
        match node.kind {
            SyntaxKind::NameRef => kids(node)
                .iter()
                .find_map(|n| name_text(n, text))
                .is_some_and(|word| word == "public"),
            SyntaxKind::Group => kids(node)
                .iter()
                .filter(|c| c.kind != SyntaxKind::Punct)
                .any(|c| self.proves_auth_when_false(c, text)),
            SyntaxKind::Binary => {
                let parts = kids(node);
                if parts.len() != 3 {
                    return false;
                }
                let op = super::op_text(node, text).unwrap_or("");
                match op {
                    "and" => {
                        self.proves_auth_when_false(parts[0], text)
                            && self.proves_auth_when_false(parts[2], text)
                    }
                    "or" => {
                        self.proves_auth_when_false(parts[0], text)
                            || self.proves_auth_when_false(parts[2], text)
                    }
                    _ => false,
                }
            }
            SyntaxKind::Unary => {
                let parts = kids(node);
                let is_not = parts.first().is_some_and(|n| is_name(n, text, "not"));
                parts
                    .iter()
                    .find(|n| is_expression(n.kind))
                    .is_some_and(|operand| is_not && self.proves_auth(operand, text))
            }
            _ => false,
        }
    }

    /// Whether `node` is a declared role tested on the literal
    /// caller (T06, mirroring the checker): `r(actor)` where `r`
    /// resolves to a `Role` symbol and the single unnamed subject
    /// resolves to the `actor` contextual fact. The `by=` subtree
    /// is already walked at the call site, so both bindings are
    /// available.
    fn role_call_on_caller(&self, node: &SyntaxNode, text: &str) -> bool {
        let parts = kids(node);
        let Some(callee) = parts.iter().find(|n| is_expression(n.kind)) else {
            return false;
        };
        if Self::ungrouped(callee).kind != SyntaxKind::NameRef {
            return false;
        }
        let is_role = matches!(
            self.tables.node_binding.get(&NodeKey::of(Self::ungrouped(callee))),
            Some(Binding::Symbol(id))
                if matches!(self.tables.symbols[id.0 as usize].kind, SymbolKind::Role)
        );
        if !is_role {
            return false;
        }
        let mut args = parts.iter().filter(|n| n.kind == SyntaxKind::Argument);
        let (Some(arg), None) = (args.next(), args.next()) else {
            return false;
        };
        let arg_parts = kids(arg);
        if arg_parts.len() >= 3
            && arg_parts[0].kind == SyntaxKind::Name
            && is_punct(arg_parts[1], text, "=")
        {
            return false;
        }
        let Some(value) = arg_parts.iter().find(|n| is_expression(n.kind)) else {
            return false;
        };
        let value = Self::ungrouped(value);
        value.kind == SyntaxKind::NameRef
            && matches!(
                self.tables.node_binding.get(&NodeKey::of(value)),
                Some(Binding::Context(ContextVar::Actor(_)))
            )
    }

    /// Unwrap `Group` nodes to the inner expression.
    fn ungrouped(mut node: &SyntaxNode) -> &SyntaxNode {
        loop {
            if node.kind == SyntaxKind::Group
                && let Some(inner) = kids(node).iter().find(|n| is_expression(n.kind))
            {
                node = inner;
            } else {
                return node;
            }
        }
    }
}

impl<'a> Resolver<'a> {
    // --- Pass 5d: Then ------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    fn resolve_then(
        &mut self,
        _file: SourceId,
        text: &'a str,
        module: ModuleId,
        root: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        if has_error(node) || node.kind != SyntaxKind::Page {
            return;
        }
        let mut scope = self.with_facts(root, ActorKind::Nullable, true, true);
        if self
            .tables
            .symbols
            .iter()
            .any(|s| s.module == module && matches!(s.kind, SymbolKind::Preferences { .. }))
        {
            self.tables.scopes[scope.0 as usize].bindings.insert(
                "preferences".to_string(),
                Binding::Context(ContextVar::Preferences { module }),
            );
        }
        for child in kids(node) {
            if child.kind == SyntaxKind::Route {
                self.resolve_route(text, module, &mut scope, child, diags);
            }
        }
        for child in kids(node) {
            if child.kind != SyntaxKind::Attribute {
                continue;
            }
            let Some((key, value)) = attribute_parts(child) else {
                continue;
            };
            let word = name_text(key, text).unwrap_or("");
            if matches!(word, "title" | "data" | "order" | "group" | "poll") {
                self.walk_expr(module, scope, value, text, ExprCtx::bare(), diags);
            } else if word == "refresh" && value.kind == SyntaxKind::Path {
                let segments = path_segments(value, text);
                if let Some(op) = self.resolve_op_path(module, &segments, value, text, diags) {
                    self.tables.node_symbol.insert(NodeKey::of(value), op);
                }
            }
        }
        if let Some(data) = attribute_value(node, "data", text) {
            self.bind_result(module, text, scope, data);
        }
        for child in kids(node) {
            if !matches!(child.kind, SyntaxKind::Route | SyntaxKind::Attribute) {
                self.walk_ui(text, module, scope, child, diags);
            }
        }
    }

    /// Resolve a page route: record routes bind `row`, scalar routes bind
    /// their named typed parameter.
    fn resolve_route(
        &mut self,
        text: &'a str,
        module: ModuleId,
        scope: &mut ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        for child in kids(node) {
            match child.kind {
                SyntaxKind::RouteRecord => {
                    let child_parts = kids(child);
                    let path = child_parts.iter().find(|n| n.kind == SyntaxKind::Path);
                    if let Some(path) = path {
                        let segments = path_segments(path, text);
                        let model_segments: Vec<&str> = segments
                            .iter()
                            .take(segments.len().saturating_sub(1))
                            .copied()
                            .collect();
                        if let Some(model) =
                            self.resolve_model_path(module, &model_segments, path, text, diags)
                        {
                            let row_scope = self.with_row(*scope, model);
                            *scope = row_scope;
                        }
                    }
                }
                SyntaxKind::RouteScalar => {
                    let mut name: Option<(String, Span)> = None;
                    for part in kids(child) {
                        if part.kind == SyntaxKind::Path && name.is_none() {
                            let segments = path_segments(part, text);
                            if segments.len() == 1 {
                                name = Some((segments[0].to_string(), part.span));
                            }
                        } else if is_type_node(part.kind) {
                            self.resolve_type(text, module, part, diags);
                        }
                    }
                    if let Some((name, span)) = name {
                        self.bind_authored(
                            *scope,
                            &name,
                            Binding::RouteParam {
                                node: NodeKey::of(child),
                            },
                            span,
                            "route parameter",
                            diags,
                        );
                    }
                }
                _ => {}
            }
        }
    }

    /// Bind `result` for a form/data operation target (declared scenario
    /// result, generated CRUD result, or error-bound when unresolvable).
    fn bind_result(
        &mut self,
        module: ModuleId,
        text: &'a str,
        scope: ScopeId,
        target: &SyntaxNode,
    ) {
        let op = self.operation_of_target(module, text, target);
        let binding = match op {
            Some(OpTarget::Scenario(id)) => Binding::Context(ContextVar::Result {
                scenario: Some(id),
                crud_op: None,
            }),
            Some(OpTarget::CrudOp(model, op)) => Binding::Context(ContextVar::Result {
                scenario: None,
                crud_op: Some((model, op)),
            }),
            Some(OpTarget::Opaque) | None => Binding::Error,
        };
        self.tables.scopes[scope.0 as usize]
            .bindings
            .insert("result".to_string(), binding);
    }

    /// Classify a form/data `result` target expression.
    fn operation_of_target(
        &self,
        _module: ModuleId,
        text: &str,
        target: &SyntaxNode,
    ) -> Option<OpTarget> {
        let mut current = target;
        loop {
            match current.kind {
                SyntaxKind::Group => {
                    current = kids(current).iter().find(|n| is_expression(n.kind))?;
                }
                SyntaxKind::Call => {
                    let callee = kids(current).into_iter().find(|n| is_expression(n.kind))?;
                    return self.operation_of_target(_module, text, callee);
                }
                SyntaxKind::NameRef => {
                    return match self.tables.node_binding.get(&NodeKey::of(current)) {
                        Some(Binding::Symbol(id)) => {
                            match &self.tables.symbols[id.0 as usize].kind {
                                SymbolKind::Scenario { .. } => Some(OpTarget::Scenario(*id)),
                                _ => Some(OpTarget::Opaque),
                            }
                        }
                        Some(Binding::Error) | None => None,
                        _ => Some(OpTarget::Opaque),
                    };
                }
                SyntaxKind::Member => {
                    let parts = kids(current);
                    if parts.len() < 3 {
                        return Some(OpTarget::Opaque);
                    }
                    let base = self.member_base_symbol(parts[0], text)?;
                    let member = name_text(parts[2], text)?;
                    let crud_op = match member {
                        "create" => CrudOp::Create,
                        "update" => CrudOp::Update,
                        "delete" => CrudOp::Delete,
                        _ => return Some(OpTarget::Opaque),
                    };
                    if matches!(
                        self.tables.symbols[base.0 as usize].kind,
                        SymbolKind::Model { .. }
                    ) {
                        return Some(OpTarget::CrudOp(base, crud_op));
                    }
                    return Some(OpTarget::Opaque);
                }
                _ => return Some(OpTarget::Opaque),
            }
        }
    }

    /// Base symbol of a member chain (`Todo` in `Todo.create`).
    fn member_base_symbol(&self, node: &SyntaxNode, _text: &str) -> Option<SymbolId> {
        let mut current = node;
        loop {
            match current.kind {
                SyntaxKind::NameRef => {
                    return match self.tables.node_binding.get(&NodeKey::of(current)) {
                        Some(Binding::Symbol(id)) => Some(*id),
                        _ => None,
                    };
                }
                SyntaxKind::Member => {
                    current = kids(current).into_iter().find(|n| is_expression(n.kind))?;
                }
                SyntaxKind::Group => {
                    current = kids(current).iter().find(|n| is_expression(n.kind))?;
                }
                _ => return None,
            }
        }
    }

    /// Walk one presentation node with the current row/alias scope.
    fn walk_ui(
        &mut self,
        text: &'a str,
        module: ModuleId,
        scope: ScopeId,
        node: &SyntaxNode,
        diags: &mut Vec<Diagnostic>,
    ) {
        if has_error(node) {
            return;
        }
        match node.kind {
            SyntaxKind::Card | SyntaxKind::Details => {
                for child in kids(node) {
                    if is_expression(child.kind) {
                        self.walk_expr(module, scope, child, text, ExprCtx::bare(), diags);
                    } else if child.kind == SyntaxKind::Attribute {
                        if let Some((key, value)) = attribute_parts(child)
                            && is_name(key, text, "open")
                        {
                            self.walk_expr(module, scope, value, text, ExprCtx::bare(), diags);
                        }
                    } else if is_ui_child(child.kind) {
                        self.walk_ui(text, module, scope, child, diags);
                    }
                }
            }
            SyntaxKind::Tabs => {
                for child in kids(node) {
                    if is_expression(child.kind) {
                        self.walk_expr(module, scope, child, text, ExprCtx::bare(), diags);
                    } else if child.kind == SyntaxKind::Tab {
                        self.walk_ui(text, module, scope, child, diags);
                    }
                }
            }
            SyntaxKind::Tab => {
                for child in kids(node) {
                    if is_expression(child.kind) {
                        self.walk_expr(module, scope, child, text, ExprCtx::bare(), diags);
                    } else if is_ui_child(child.kind) {
                        self.walk_ui(text, module, scope, child, diags);
                    }
                }
            }
            SyntaxKind::Collection => {
                let mut child_scope = self.new_scope(Some(scope));
                for child in kids(node) {
                    if is_expression(child.kind) {
                        self.walk_expr(module, scope, child, text, ExprCtx::bare(), diags);
                        if let Some((alias, clause)) = top_alias(child, text) {
                            self.bind_authored(
                                child_scope,
                                &alias,
                                Binding::QueryAlias {
                                    node: NodeKey::of(clause),
                                },
                                clause.span,
                                "query alias",
                                diags,
                            );
                        }
                        self.tables.scopes[child_scope.0 as usize].bindings.insert(
                            "row".to_string(),
                            Binding::Context(ContextVar::RowQuery {
                                node: NodeKey::of(child),
                            }),
                        );
                    } else if child.kind == SyntaxKind::Attribute {
                        if let Some((key, value)) = attribute_parts(child) {
                            let word = name_text(key, text).unwrap_or("");
                            if word == "empty" {
                                self.walk_expr(module, scope, value, text, ExprCtx::bare(), diags);
                            } else if word == "defaults" && value.kind == SyntaxKind::Object {
                                self.walk_object_values(module, scope, value, text, diags);
                            }
                        }
                    } else if is_ui_child(child.kind) {
                        self.walk_ui(text, module, child_scope, child, diags);
                    }
                }
                let _ = &mut child_scope;
            }
            SyntaxKind::Form => {
                for child in kids(node) {
                    if is_expression(child.kind) {
                        self.walk_expr(module, scope, child, text, ExprCtx::bare(), diags);
                    }
                }
                let mut form_scope = self.new_scope(Some(scope));
                let target = kids(node).into_iter().find(|n| is_expression(n.kind));
                if let Some(target) = target {
                    self.bind_result(module, text, form_scope, target);
                }
                let _ = &mut form_scope;
                for child in kids(node) {
                    if child.kind == SyntaxKind::Attribute {
                        if let Some((key, value)) = attribute_parts(child) {
                            let word = name_text(key, text).unwrap_or("");
                            if word == "submit" {
                                self.walk_expr(module, scope, value, text, ExprCtx::bare(), diags);
                            } else if word == "arguments" && value.kind == SyntaxKind::Object {
                                self.walk_object_values(module, scope, value, text, diags);
                            } else if word == "review" && value.kind == SyntaxKind::Path {
                                let segments = path_segments(value, text);
                                if let Some(op) =
                                    self.resolve_op_path(module, &segments, value, text, diags)
                                {
                                    self.tables.node_symbol.insert(NodeKey::of(value), op);
                                }
                            }
                        }
                    } else if is_ui_child(child.kind) {
                        self.walk_ui(text, module, form_scope, child, diags);
                    }
                }
            }
            SyntaxKind::Edit | SyntaxKind::UiLeaf => {
                for child in kids(node) {
                    if is_expression(child.kind) {
                        self.walk_expr(module, scope, child, text, ExprCtx::bare(), diags);
                    }
                }
            }
            // Slots and preference panels are transparent structural
            // groups: their children resolve in the current scope.
            SyntaxKind::Slot | SyntaxKind::PreferencePanel => {
                for child in kids(node) {
                    if is_ui_child(child.kind) {
                        self.walk_ui(text, module, scope, child, diags);
                    }
                }
            }
            SyntaxKind::CatalogItem => {
                for child in kids(node) {
                    if is_expression(child.kind) {
                        // M6 extension (PR6): a bare-word header position
                        // (`input title`) is catalog vocabulary — a field
                        // selector against the component's record — not a
                        // name reference. Binding it needs per-component
                        // header profiles, and no producer UI catalog
                        // exists yet, so it stays silent like `NAME=word`
                        // options (recorded hole, see module docs).
                        // Complex expressions (calls, member paths) still
                        // resolve: only single names are vocabulary.
                        if child.kind == SyntaxKind::NameRef {
                            continue;
                        }
                        self.walk_expr(module, scope, child, text, ExprCtx::bare(), diags);
                    } else if is_ui_child(child.kind) {
                        self.walk_ui(text, module, scope, child, diags);
                    }
                    // `NAME=word` options are catalog vocabulary, not
                    // name references; membership is PR5 (M6 record).
                }
            }
            _ => {}
        }
    }

    // --- Pass 5e: expressions -----------------------------------------------

    /// Walk one value expression: record its scope, resolve bare names
    /// lexically (helpers are `E2006`, anything else unbound is recorded
    /// for pass 2) and open alias scopes.
    fn walk_expr(
        &mut self,
        module: ModuleId,
        scope: ScopeId,
        node: &SyntaxNode,
        text: &'a str,
        _ctx: ExprCtx,
        diags: &mut Vec<Diagnostic>,
    ) {
        if has_error(node) {
            return;
        }
        self.tables.expr_scope.insert(NodeKey::of(node), scope);
        match node.kind {
            SyntaxKind::Literal | SyntaxKind::MessageValue => {}
            SyntaxKind::NameRef => {
                let name = kids(node)
                    .iter()
                    .find_map(|n| name_text(n, text))
                    .unwrap_or("");
                if name.is_empty() {
                    return;
                }
                match self.tables.resolve_name(scope, name, self.catalog) {
                    Some(binding) => {
                        self.tables.node_binding.insert(NodeKey::of(node), binding);
                    }
                    None => {
                        if self.catalog.is_some_and(|c| c.is_helper(name)) {
                            // Trimmed like `E2001`: `NameRef` spans can
                            // include leading trivia.
                            let span = trimmed_slice(self.db, &NodeKey::of(node))
                                .map(|(_, span)| span)
                                .unwrap_or(node.span);
                            diags.push(Diagnostic::error(
                                "E2006",
                                format!(
                                    "helper '{name}' is codegen-only and cannot be called from source"
                                ),
                                span,
                            ));
                            self.tables
                                .node_binding
                                .insert(NodeKey::of(node), Binding::Error);
                        } else if !self.tables.module_by_name.contains_key(name) {
                            self.tables.unresolved_names.push(NodeKey::of(node));
                        }
                    }
                }
            }
            SyntaxKind::Member => {
                let parts = kids(node);
                if let Some(receiver) = parts.first() {
                    self.walk_expr(module, scope, receiver, text, ExprCtx::bare(), diags);
                }
            }
            SyntaxKind::Call => {
                let parts = kids(node);
                let callee = parts.iter().find(|n| is_expression(n.kind));
                if let Some(callee) = callee {
                    self.walk_expr(module, scope, callee, text, ExprCtx::bare(), diags);
                }
                let args: Vec<&SyntaxNode> = parts
                    .iter()
                    .filter(|n| n.kind == SyntaxKind::Argument)
                    .copied()
                    .collect();
                let mut arg_scope = scope;
                if callee.is_some_and(|c| self.is_alias_builtin(c))
                    && let Some(first) = args.first()
                    && let Some(value) = kids(first).iter().find(|n| is_expression(n.kind))
                    && let Some((alias, clause)) = top_alias(value, text)
                {
                    let extended = self.new_scope(Some(scope));
                    self.bind_authored(
                        extended,
                        &alias,
                        Binding::QueryAlias {
                            node: NodeKey::of(clause),
                        },
                        clause.span,
                        "query alias",
                        diags,
                    );
                    arg_scope = extended;
                }
                for (i, arg) in args.iter().enumerate() {
                    for value in kids(arg) {
                        if is_expression(value.kind) {
                            let scope = if i == 0 { scope } else { arg_scope };
                            self.walk_expr(module, scope, value, text, ExprCtx::bare(), diags);
                        }
                    }
                }
            }
            SyntaxKind::Query => {
                let parts = kids(node);
                let mut extended = scope;
                let mut first = true;
                for part in parts {
                    if part.kind == SyntaxKind::QueryClause {
                        let head = kids(part)
                            .iter()
                            .find_map(|n| name_text(n, text))
                            .unwrap_or("");
                        if head == "as" {
                            if let Some((alias, _)) = clause_alias(part, text) {
                                let scope = self.new_scope(Some(extended));
                                self.bind_authored(
                                    scope,
                                    &alias,
                                    Binding::QueryAlias {
                                        node: NodeKey::of(part),
                                    },
                                    part.span,
                                    "query alias",
                                    diags,
                                );
                                extended = scope;
                            }
                        } else if head == "archived" {
                            continue;
                        } else {
                            for value in kids(part) {
                                if is_expression(value.kind) {
                                    self.walk_expr(
                                        module,
                                        extended,
                                        value,
                                        text,
                                        ExprCtx::bare(),
                                        diags,
                                    );
                                }
                            }
                        }
                    } else if is_expression(part.kind) && first {
                        self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
                        first = false;
                    }
                }
            }
            SyntaxKind::Binary => {
                let parts = kids(node);
                if parts.len() == 3 {
                    let op = super::op_text(node, text).unwrap_or("");
                    if op == "is" {
                        self.walk_expr(module, scope, parts[0], text, ExprCtx::bare(), diags);
                        self.resolve_is_target(module, parts[2], text, diags);
                    } else {
                        self.walk_expr(module, scope, parts[0], text, ExprCtx::bare(), diags);
                        self.walk_expr(module, scope, parts[2], text, ExprCtx::bare(), diags);
                    }
                }
            }
            SyntaxKind::Unary | SyntaxKind::Group => {
                for part in kids(node) {
                    if is_expression(part.kind) {
                        self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
                    }
                }
            }
            SyntaxKind::Array => {
                for part in kids(node) {
                    if is_expression(part.kind) {
                        self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
                    }
                }
            }
            SyntaxKind::Object => {
                self.walk_object_values(module, scope, node, text, diags);
            }
            SyntaxKind::Construct => {
                let parts = kids(node);
                if let Some(head) = parts.iter().find(|n| is_expression(n.kind)) {
                    self.resolve_construct_head(module, head, text, diags);
                    self.tables.expr_scope.insert(NodeKey::of(head), scope);
                }
                if let Some(object) = parts.iter().find(|n| n.kind == SyntaxKind::Object) {
                    self.walk_object_values(module, scope, object, text, diags);
                }
            }
            _ => {}
        }
    }

    /// Whether a call callee is the `any`/`all`/`group` builtin (whose
    /// first-argument alias scopes the remaining arguments).
    fn is_alias_builtin(&self, callee: &SyntaxNode) -> bool {
        let mut current = callee;
        loop {
            match current.kind {
                SyntaxKind::NameRef => {
                    return matches!(
                        self.tables.node_binding.get(&NodeKey::of(current)),
                        Some(Binding::Builtin { id })
                            if id == "any" || id == "all" || id == "group"
                    );
                }
                SyntaxKind::Group => {
                    let group_parts = kids(current);
                    let Some(inner) = group_parts.iter().find(|n| is_expression(n.kind)) else {
                        return false;
                    };
                    current = *inner;
                }
                _ => return false,
            }
        }
    }

    /// Resolve an `is` right operand as a type-test target (a type path,
    /// not a value reference).
    fn resolve_is_target(
        &mut self,
        module: ModuleId,
        node: &SyntaxNode,
        text: &str,
        diags: &mut Vec<Diagnostic>,
    ) {
        let segments = expr_path_segments(node, text);
        if segments.is_empty() {
            self.tables.unresolved_names.push(NodeKey::of(node));
            return;
        }
        self.resolve_type_path(module, &segments, node, text, diags);
    }

    /// Resolve a construct head as a type path (not a value reference).
    fn resolve_construct_head(
        &mut self,
        module: ModuleId,
        head: &SyntaxNode,
        text: &str,
        diags: &mut Vec<Diagnostic>,
    ) {
        let segments = expr_path_segments(head, text);
        if segments.is_empty() {
            self.tables.unresolved_names.push(NodeKey::of(head));
            return;
        }
        self.resolve_type_path(module, &segments, head, text, diags);
    }

    /// Walk object entry values (shorthand names resolve as references).
    fn walk_object_values(
        &mut self,
        module: ModuleId,
        scope: ScopeId,
        node: &SyntaxNode,
        text: &'a str,
        diags: &mut Vec<Diagnostic>,
    ) {
        self.tables.expr_scope.insert(NodeKey::of(node), scope);
        for entry in node
            .children
            .iter()
            .filter(|c| c.kind == SyntaxKind::ObjectEntry)
        {
            self.tables.expr_scope.insert(NodeKey::of(entry), scope);
            let parts = kids(entry);
            let mut value_walked = false;
            for part in &parts {
                if is_expression(part.kind) {
                    self.walk_expr(module, scope, part, text, ExprCtx::bare(), diags);
                    value_walked = true;
                }
            }
            if !value_walked
                && let Some(name_node) = parts.first().filter(|n| n.kind == SyntaxKind::Name)
            {
                let name = name_node.token().map(|t| t.text(text)).unwrap_or("");
                match self.tables.resolve_name(scope, name, self.catalog) {
                    Some(binding) => {
                        self.tables
                            .node_binding
                            .insert(NodeKey::of(name_node), binding);
                    }
                    None => {
                        if self.catalog.is_some_and(|c| c.is_helper(name)) {
                            diags.push(Diagnostic::error(
                                    "E2006",
                                    format!(
                                        "helper '{name}' is codegen-only and cannot be called from source"
                                    ),
                                    name_node.span,
                                ));
                            self.tables
                                .node_binding
                                .insert(NodeKey::of(name_node), Binding::Error);
                        } else {
                            self.tables.unresolved_names.push(NodeKey::of(name_node));
                        }
                    }
                }
            }
        }
    }

    // --- Pass 6: reference cycles -------------------------------------------

    /// Fixture reference cycles are `E2017`.
    fn check_fixture_cycles(
        &mut self,
        trees: &[(SourceId, SyntaxNode)],
        diags: &mut Vec<Diagnostic>,
    ) {
        let mut edges: HashMap<SymbolId, Vec<SymbolId>> = HashMap::new();
        for (file, tree) in trees {
            let text = self.text(*file);
            for module_node in kids(tree) {
                if !matches!(module_node.kind, SyntaxKind::App | SyntaxKind::Package) {
                    continue;
                }
                let Some(module) = self.module_of(text, module_node) else {
                    continue;
                };
                for fixture in module_node
                    .descendants()
                    .filter(|n| n.kind == SyntaxKind::Fixture && !has_error(n))
                {
                    let Some((name, _)) = Self::decl_name(text, fixture, &["export", "fixture"])
                    else {
                        continue;
                    };
                    let owner = match self.tables.module_scopes[module.0 as usize].test.get(&name) {
                        Some(ScopedName::Local(id)) => *id,
                        _ => continue,
                    };
                    let mut refs = Vec::new();
                    for name_ref in fixture
                        .descendants()
                        .filter(|n| n.kind == SyntaxKind::NameRef || n.kind == SyntaxKind::Name)
                    {
                        if let Some(Binding::Symbol(id)) =
                            self.tables.node_binding.get(&NodeKey::of(name_ref))
                            && matches!(
                                self.tables.symbols[id.0 as usize].kind,
                                SymbolKind::Fixture { .. }
                            )
                            && !refs.contains(id)
                        {
                            refs.push(*id);
                        }
                    }
                    edges.insert(owner, refs);
                }
            }
        }
        self.tables.fixture_edges = edges.clone();
        let mut reported: HashSet<SymbolId> = HashSet::new();
        for fixture in edges.keys() {
            let mut stack = vec![*fixture];
            let mut seen: HashSet<SymbolId> = HashSet::new();
            seen.insert(*fixture);
            while let Some(current) = stack.pop() {
                if let Some(nexts) = edges.get(&current) {
                    for next in nexts {
                        if *next == *fixture && reported.insert(*fixture) {
                            let name = self.tables.symbols[fixture.0 as usize].name.clone();
                            diags.push(Diagnostic::error(
                                "E2017",
                                format!("fixture reference cycle through '{name}'"),
                                self.tables.symbols[fixture.0 as usize].span,
                            ));
                        } else if seen.insert(*next) {
                            stack.push(*next);
                        }
                    }
                }
            }
        }
    }

    /// Derived-value cycles (including self-recursion) are `E2018`.
    fn check_derive_cycles(
        &mut self,
        trees: &[(SourceId, SyntaxNode)],
        diags: &mut Vec<Diagnostic>,
    ) {
        let mut edges: HashMap<SymbolId, Vec<SymbolId>> = HashMap::new();
        for (file, tree) in trees {
            let text = self.text(*file);
            for module_node in kids(tree) {
                if !matches!(module_node.kind, SyntaxKind::App | SyntaxKind::Package) {
                    continue;
                }
                let Some(module) = self.module_of(text, module_node) else {
                    continue;
                };
                for derive in module_node
                    .descendants()
                    .filter(|n| n.kind == SyntaxKind::Derive && !has_error(n))
                {
                    let owner = self.derive_owner(module, text, derive);
                    let Some(owner) = owner else {
                        continue;
                    };
                    let mut refs = Vec::new();
                    for name_ref in derive
                        .descendants()
                        .filter(|n| n.kind == SyntaxKind::NameRef || n.kind == SyntaxKind::Name)
                    {
                        if let Some(Binding::Symbol(id)) =
                            self.tables.node_binding.get(&NodeKey::of(name_ref))
                            && matches!(
                                self.tables.symbols[id.0 as usize].kind,
                                SymbolKind::DeriveFn { .. }
                            )
                            && !refs.contains(id)
                        {
                            refs.push(*id);
                        }
                    }
                    edges.insert(owner, refs);
                }
            }
        }
        let mut reported: HashSet<SymbolId> = HashSet::new();
        for derive in edges.keys() {
            let mut stack = vec![*derive];
            let mut seen: HashSet<SymbolId> = HashSet::new();
            seen.insert(*derive);
            while let Some(current) = stack.pop() {
                if let Some(nexts) = edges.get(&current) {
                    for next in nexts {
                        if *next == *derive && reported.insert(*derive) {
                            let name = self.tables.symbols[derive.0 as usize].name.clone();
                            diags.push(Diagnostic::error(
                                "E2018",
                                format!("derived-value cycle through '{name}'"),
                                self.tables.symbols[derive.0 as usize].span,
                            ));
                        } else if seen.insert(*next) {
                            stack.push(*next);
                        }
                    }
                }
            }
        }
    }

    /// Owning symbol of one `Derive` node (function, or model for fields).
    fn derive_owner(&self, module: ModuleId, text: &str, node: &SyntaxNode) -> Option<SymbolId> {
        let parts = kids(node);
        let path = parts.iter().find(|n| n.kind == SyntaxKind::Path)?;
        let segments = path_segments(path, text);
        let is_function = parts.iter().any(|n| is_punct(n, text, "("));
        if is_function && segments.len() == 1 {
            match self.tables.module_scopes[module.0 as usize]
                .prod
                .get(segments[0])
            {
                Some(ScopedName::Local(id)) => Some(*id),
                _ => None,
            }
        } else {
            None
        }
    }
}

/// Operation target classification for `result` bindings.
#[derive(Debug, Clone, Copy)]
enum OpTarget {
    Scenario(SymbolId),
    CrudOp(SymbolId, CrudOp),
    Opaque,
}

/// Whether this CST kind is a nested presentation child.
fn is_ui_child(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::Card
            | SyntaxKind::Details
            | SyntaxKind::Tabs
            | SyntaxKind::Tab
            | SyntaxKind::Collection
            | SyntaxKind::Form
            | SyntaxKind::Edit
            | SyntaxKind::UiLeaf
            | SyntaxKind::Slot
            | SyntaxKind::PreferencePanel
            | SyntaxKind::CatalogItem
    )
}

/// Top-level `as` alias of a query/domain expression, if any.
fn top_alias<'a>(node: &'a SyntaxNode, text: &str) -> Option<(String, &'a SyntaxNode)> {
    let mut current = node;
    loop {
        match current.kind {
            SyntaxKind::Query => {
                for part in kids(current) {
                    if part.kind == SyntaxKind::QueryClause
                        && let Some(alias) = clause_alias(part, text)
                    {
                        return Some((alias.0, part));
                    }
                }
                return None;
            }
            SyntaxKind::Group => {
                current = kids(current).iter().find(|n| is_expression(n.kind))?;
            }
            _ => return None,
        }
    }
}

/// Alias name of an `as` query clause.
fn clause_alias(node: &SyntaxNode, text: &str) -> Option<(String, Span)> {
    let parts = kids(node);
    if parts.len() >= 2 && is_name(parts[0], text, "as") {
        name_text(parts[1], text).map(|n| (n.to_string(), parts[1].span))
    } else {
        None
    }
}

/// Dotted path segments of a NameRef/Member type-position expression.
fn expr_path_segments<'a>(node: &SyntaxNode, text: &'a str) -> Vec<&'a str> {
    let mut segments = Vec::new();
    let mut current = node;
    loop {
        match current.kind {
            SyntaxKind::NameRef => {
                if let Some(name) = kids(current).iter().find_map(|n| name_text(n, text)) {
                    segments.push(name);
                }
                segments.reverse();
                return segments;
            }
            SyntaxKind::Member => {
                let parts = kids(current);
                if parts.len() < 3 {
                    return Vec::new();
                }
                if !is_punct(parts[1], text, ".") {
                    return Vec::new();
                }
                let Some(name) = name_text(parts[2], text) else {
                    return Vec::new();
                };
                segments.push(name);
                current = parts[0];
            }
            SyntaxKind::Group => {
                let group_parts = kids(current);
                let Some(inner) = group_parts.iter().find(|n| is_expression(n.kind)) else {
                    return Vec::new();
                };
                current = *inner;
            }
            _ => return Vec::new(),
        }
    }
}
