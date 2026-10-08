//! Checked intermediate representation (lane-01 codegen, PR6).
//!
//! [`IrProgram`] is a pure transformation of
//! [`CheckedProgram`](crate::analysis::CheckedProgram): modules, canonical
//! symbol identities, resolved types, guard/effect order carriers and
//! operation/fixture descriptors. It never re-derives semantics from the
//! CST (spans come from [`CheckedProgram`] symbol/module spans only) and
//! never invents meaning analysis did not check.
//!
//! Anything analysis left unchecked is an `E6006` naming the gap (see
//! [`build`]); anything checked but without a DESIGN §13 lowering is an
//! `E6008` raised by the lowering stages ([`crate::codegen::js`],
//! [`crate::codegen::bdd`], [`IrExpr::Unsupported`]/[`IrStmt::Unsupported`]
//! flowing there from this build).
//!
//! [`build`] consumes the PR5 tables: [`TypeTable`](crate::analysis::types::TypeTable)
//! (`symbol_types`/`symbol_results` plus `node_types`),
//! [`EffectTables`](crate::analysis::effects::EffectTables) (G1-G9, G13)
//! and [`ExampleTables`](crate::analysis::examples::ExampleTables) (G10).
//! Those tables anchor expressions by [`NodeKey`](crate::analysis::NodeKey),
//! so the build re-parses the sources it is given and decodes the anchored
//! CST subtrees. This is a deliberate, documented exception to the
//! never-re-derive principle: spans supply literal content and syntactic
//! structure only, while every semantic choice (what a name denotes, what
//! type an expression has, which operation a call targets) comes from the
//! tables — symbol/type/effect/example tables and the producer catalog —
//! or from closed language rules (`c`/`actor`/`now`/`self`/`other` context
//! spellings, `members`/`owner`/`authenticated`/`public` predicate
//! spellings, `s`/`b` example scopes). The build never re-runs
//! resolve/types/effects inference from the CST, except the closed
//! sequence-step value-type rules (literals, comparisons, `b`/`s`
//! slots, member chains, `first`/`count`) that assertion type ids need.
//! Positions no table serves stay loud `E6006` and are omitted
//! fail-closed. Parser-admitted Corpus declarations have no semantic or
//! runtime owner; module admission reports `E6008` at the authored declaration
//! instead of silently dropping them. This does not check their attributes.
//!
//! Index parity: `items[i]` corresponds to `CheckedProgram.symbols[i]` and
//! `modules[i]` to `CheckedProgram.modules[i]`, so [`SymbolId`] and
//! [`ModuleId`] index both tables.

use crate::analysis::catalog::{Availability, Catalog, Effects, SigType, std_capability};
use crate::analysis::effects::{EffectVerb, PolicyRule};
use crate::analysis::migrate_check::{self, OwnerModelView};
use crate::analysis::resolve::{
    CrudOp, FixtureTarget, ModelOwner, ModuleId, ModuleKind, SymbolId, SymbolKind,
};
use crate::analysis::types::{ResolvedType, Scalar, SelectedCallTarget};
use crate::analysis::{CheckedProgram, NodeKey};
use crate::codegen::bdd::BddSuite;
use crate::diagnostic::Diagnostic;
use crate::source::{SourceDb, SourceId, Span, sha256_hex};
use crate::syntax::{SyntaxKind, SyntaxNode};
use std::collections::{HashMap, HashSet};

/// One `use provider {members} [from=binding]` group, verbatim.
#[derive(Debug, Clone)]
pub struct IrImport {
    /// Provider package/app name.
    pub provider: String,
    /// Provider-path span.
    pub provider_span: Span,
    /// Imported members as `(name, alias, span)`.
    pub members: Vec<(String, String, Span)>,
    /// Deployment binding for bound imports.
    pub from: Option<String>,
    /// Whole-declaration span.
    pub span: Span,
}

/// One `app`/`package` declaration: identity, imports and ownership.
#[derive(Debug, Clone)]
pub struct IrModule {
    /// Table index (parity with [`CheckedProgram::modules`]).
    pub id: ModuleId,
    /// Canonical name (shared app/package namespace).
    pub name: String,
    /// Implicit app, composed app or package.
    pub kind: ModuleKind,
    /// Declaring source.
    pub file: SourceId,
    /// Whole-declaration span.
    pub span: Span,
    /// `use` imports in source order.
    pub imports: Vec<IrImport>,
    /// Composed-app `uses` member names in source order.
    pub uses: Vec<String>,
    /// Resolved `uses` member names in source order.
    pub uses_resolved: Vec<String>,
    /// Checked app context locale, including the pinned fallback after
    /// composition. Packages have no app default.
    pub app_default_locale: Option<String>,
    /// Pages in source order (G9; empty when the module has none or its
    /// analysis row is absent).
    pub pages: Vec<IrPage>,
    /// Module `#` description, when one is attached (G9).
    pub description: Option<IrMessage>,
}

/// Storage ownership of a stored model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IrOwner {
    /// Omitted ownership: team scope (the pinned default).
    Team,
    /// `Model in Parent`: child of `Parent`.
    ChildOf(SymbolId),
    /// `Model in app`: app-scoped data.
    App,
}

/// A declared type position: known when the analysis [`TypeTable`](crate::analysis::types::TypeTable)
/// resolved it, unknown otherwise (an `E6006` is recorded at build time).
#[derive(Debug, Clone)]
pub enum IrType {
    /// Resolved declared type.
    Known(ResolvedType),
    /// Unresolved declared type; lowering must refuse with `E6008`.
    Unknown,
}

/// One canonical package-qualified item (parity with `CheckedProgram.symbols`).
#[derive(Debug, Clone)]
pub struct IrItem {
    /// Table index (parity with [`CheckedProgram::symbols`]).
    pub id: SymbolId,
    /// Canonical identity (`Package.Name`, `Package.Model.field`, ...).
    pub canonical: String,
    /// Local name.
    pub name: String,
    /// Owning module.
    pub module: ModuleId,
    /// Declaration-name span.
    pub span: Span,
    /// Whether `export` was written.
    pub exported: bool,
    /// Declaration shape with resolved types attached.
    pub kind: IrItemKind,
}

/// Item payload: declaration shape plus child item links.
///
/// The bridged variants are intentionally heterogeneous (models carry
/// full rule payloads, roles carry one caption); the IR is built once
/// per compilation, so boxing for size buys nothing.
#[derive(Debug, Clone)]
#[allow(clippy::large_enum_variant)]
pub enum IrItemKind {
    Model {
        fields: Vec<SymbolId>,
        owner: IrOwner,
        crud: Option<SymbolId>,
        /// Declaration `label=` caption (G3).
        label: Option<IrMessage>,
        /// Read grants in source order (G3).
        grants: Vec<IrGrant>,
        /// Invariant registry ids in source order (G3).
        invariants: Vec<String>,
        /// Lock registry ids in source order (G3).
        locks: Vec<String>,
        /// Composite uniqueness constraints in source order (G3; the
        /// lowering reports each as `E6008`: no §13 member shape exists).
        uniques: Vec<IrUnique>,
        /// Lifetime declaration, when one is authored (G3).
        retain: Option<IrRetain>,
    },
    Contract {
        fields: Vec<SymbolId>,
        /// Declaration `label=` caption (G4).
        label: Option<IrMessage>,
    },
    Event {
        fields: Vec<SymbolId>,
    },
    Role {
        /// `label=` caption (G5).
        label: Option<IrMessage>,
    },
    Capability {
        ops: Vec<SymbolId>,
        events: Vec<SymbolId>,
        /// Authored `version=` metadata (G6; emits as an exact BigInt).
        version: Option<i64>,
    },
    CapabilityOp {
        params: Vec<SymbolId>,
        result: IrType,
    },
    Message {
        params: Vec<SymbolId>,
        /// Source text plus locale variants (G7; call sites add values).
        descriptor: Option<IrMessage>,
    },
    Fixture {
        target: FixtureTarget,
        /// Lowered recipe (G10; `None` keeps the failing shell plus `E6006`).
        recipe: Option<IrFixture>,
    },
    Scenario {
        params: Vec<SymbolId>,
        trusted: bool,
        /// Checked declared event identity for the ordinary trusted handler.
        event_source: Option<IrEventSource>,
        /// Pre-commit hook trigger, when `on=Model.create/update/delete`
        /// (T31 Rule A); declared events use the ordinary trusted handler.
        hook: Option<IrHook>,
        /// Checked `each=` fanout cohort (T34-F6): `Some` exactly when
        /// analysis accepted the cohort; absent/invalid cohorts carry no
        /// descriptor (fail-closed, never silently admitted).
        cohort: Option<IrCohort>,
        result: Option<ResolvedType>,
        /// Whether `read=true` was declared (G1).
        read: bool,
        /// `by=` admission gate (G1; empty when absent).
        by: Vec<IrGuard>,
        /// `label=` caption (G1).
        label: Option<IrMessage>,
        /// Attached `#` description (G9).
        description: Option<IrMessage>,
        /// Whether `expose=none` excludes this operation from
        /// publication (P4; mirrors the `CrudOp` allowlist rule).
        expose_excluded: bool,
        /// Leading `require` guards in written order (G1).
        guards: Vec<IrStmt>,
        /// `do` body statements in written order (G1).
        effects: Vec<IrStmt>,
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
        /// `by=` admission gate (G2; empty when absent).
        by: Vec<IrGuard>,
        /// Whether the declaration carries a `when=` admission predicate
        /// (G2; the predicate itself lives in the shared `crudWhen` map).
        has_when: bool,
        /// Field allowlist for this operation, dotted paths (G2).
        fields: Vec<String>,
        /// Caption for this operation, when the declaration labels it (G2).
        label: Option<IrMessage>,
        /// Whether this entry is excluded by the owner's `expose`
        /// allowlist (G2; emits `expose:false`).
        expose_excluded: bool,
        /// Declared deletion mode (G2; meaningful for delete operations).
        delete_mode: IrDeleteMode,
    },
    Field {
        owner: SymbolId,
        ty: IrType,
        /// T09 array-omission marker from the effects `FieldData`
        /// (`!` spelling, never nullability): true emits
        /// `requiredArray:true` (omission rejects), false emits a bare
        /// `array:true` (omitted ordinary arrays evaluate to an
        /// equal-empty array). Maps to the frozen T09-TS `ArrayOmission`.
        required_array: bool,
        /// Creation default, when one is authored (G3/G4).
        default: Option<IrDefault>,
        /// Server initializer, when one is authored (G3/G4).
        server: Option<IrServer>,
        /// `trim`/`min=`/`max=`/`unique` modifiers (G3/G4).
        modifiers: IrModifiers,
        /// Label caption, with case values for enum/bool captions (G3/G4).
        label: Option<IrFieldLabel>,
        /// Checked description source text, when authored (D03: the one
        /// slot inline/attached/shared/legacy spellings feed; MCP
        /// renders this source string, variants stay in analysis).
        description: Option<String>,
    },
    Param {
        owner: SymbolId,
        index: usize,
        ty: IrType,
        /// `=` default, when one is authored (G1/G6/G7).
        default: Option<IrDefault>,
        /// `label=` caption (G1/G6/G7).
        label: Option<IrMessage>,
        /// Checked description source text, when authored (D03: the one
        /// slot inline/attached/shared/legacy spellings feed; MCP
        /// renders this source string, variants stay in analysis).
        description: Option<String>,
        /// Optional checked assistance, derived from owning read/input symbols.
        choices: Option<IrInputChoiceBinding>,
    },
    DeriveField {
        model: SymbolId,
        ty: IrType,
        /// Derived value expression (G8).
        expr: Option<TypedExpr>,
        /// `label=` caption (G8).
        label: Option<IrFieldLabel>,
    },
    DeriveFn {
        params: Vec<SymbolId>,
        result: IrType,
        /// Derived value expression (G8).
        expr: Option<TypedExpr>,
    },
    Preferences {
        fields: Vec<SymbolId>,
        /// Registry validator name, when preferences carry invariants.
        validate: Option<String>,
    },
}

/// One read-grant policy: registry rule plus optional field grants.
#[derive(Debug, Clone)]
pub struct IrGrant {
    /// Registry id (`Model.read.N`).
    pub rule: String,
    /// Field grants as dotted selector paths (empty omits `fields`).
    pub fields: Vec<String>,
    /// Explicit-public provenance (B7 phase-1): true iff `read=` is
    /// exactly the `public` spelling with no `where=`, so serve may
    /// honor the grant without rule-fn evaluation.
    pub public: bool,
}

/// One composite uniqueness constraint: sparse `uniques` member on
/// the model entry, with a conditional predicate registered as
/// `Model.unique.N` beside the invariants (A2b).
#[derive(Debug, Clone)]
pub struct IrUnique {
    /// Constrained fields as dotted selector paths.
    pub fields: Vec<String>,
    /// `where=` predicate (nulls participate only when included).
    pub where_predicate: Option<TypedExpr>,
    /// Declaration span.
    pub span: Span,
}

/// One model lifetime declaration: `retainUntil` plus the registry rule.
#[derive(Debug, Clone)]
pub struct IrRetain {
    /// `until=` deadline expression.
    pub until: TypedExpr,
    /// Declaration span.
    pub span: Span,
}

/// Stored-field modifiers: `trim`, `min=`/`max=` bounds, field `unique`.
#[derive(Debug, Clone, Default)]
pub struct IrModifiers {
    /// Whether `trim` was written.
    pub trim: bool,
    /// `min=` bound, when one is written.
    pub min: Option<TypedExpr>,
    /// `max=` bound, when one is written.
    pub max: Option<TypedExpr>,
    /// Whether field-level `unique` was written.
    pub unique: bool,
    /// Stored enum lifecycle opt-in.
    pub machine: bool,
}

/// One field caption: plain message, or `text` plus per-case values for
/// enum/bool captions.
#[derive(Debug, Clone)]
pub struct IrFieldLabel {
    /// Caption text.
    pub text: IrMessage,
    /// `(case, caption)` pairs in written order (empty for plain labels).
    pub values: Vec<(String, IrMessage)>,
}

/// One catalog-builtin reference needing an availability check at link time.
///
/// PR5 seeds this from checked call positions; the JS lowering appends the
/// builtins it actually lowers (see [`crate::codegen::js`]). Entries whose
/// catalog record is missing, `planned` or `external` become `E6007`.
#[derive(Debug, Clone)]
pub struct ReferencedBuiltin {
    /// Catalog entry id.
    pub id: String,
    /// Call-site span.
    pub span: Span,
}

/// One boolean rule function for the `canApp()` registry (`read` and
/// `invariants` maps).
#[derive(Debug, Clone)]
pub struct IrRuleFn {
    /// Registry id (`Model.read.N`, `Model.require.N`).
    pub id: String,
    /// Rule predicate over `(c, row)`.
    pub pred: TypedExpr,
    /// Declaration span.
    pub span: Span,
}

/// One lock entry for the `canApp()` registry `locks` map.
#[derive(Debug, Clone)]
pub struct IrLockFn {
    /// Registry id (`Model.lock.N`).
    pub id: String,
    /// Locked fields as dotted selector paths.
    pub fields: Vec<String>,
    /// `when=` predicate (`None` means always locked).
    pub when: Option<TypedExpr>,
    /// Declaration span.
    pub span: Span,
}

/// One named rule function for the `canApp()` registry (`crudWhen`,
/// `retention`, `preferencesValid`).
#[derive(Debug, Clone)]
pub struct IrNamedFn {
    /// Registry key (model-local name, or `preferencesValid[...]`).
    pub name: String,
    /// Function body over `(c, row)`.
    pub body: TypedExpr,
    /// Declaration span.
    pub span: Span,
}

/// One lowered migration directive in interim-intake vocabulary
/// (`packages/contracts/src/state.ts` `MigrationDirective`): model names
/// are owner-qualified (`Owner.Model`), field names are model-local.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IrMigrationDirective {
    /// Bare `rename owner` (the installed old name is deployment-bound:
    /// `from` travels empty for L1 to fill from the installed snapshot).
    RenameOwner {
        /// Installed old owner name (empty until deployment binds it).
        from: String,
    },
    /// Bare `drop owner`.
    DropOwner,
    /// `rename before.Model to Target`.
    RenameModel {
        /// Old model (`Owner.Model`).
        from: String,
        /// Desired model (`Owner.Model`).
        to: String,
    },
    /// `rename before.Model.field to target`.
    RenameField {
        /// Old model (`Owner.Model`).
        model: String,
        /// Old field (model-local).
        from: String,
        /// Desired field (model-local).
        to: String,
    },
    /// `drop before.Model`.
    DropModel {
        /// Dropped model (`Owner.Model`).
        model: String,
    },
    /// `drop before.Model.field`.
    DropField {
        /// Old model (`Owner.Model`).
        model: String,
        /// Dropped field (model-local).
        field: String,
    },
    /// `backfill Model` (desired namespace).
    Backfill {
        /// Desired model (`Owner.Model`).
        model: String,
    },
    /// `invalidate before.handler`.
    Invalidate {
        /// Handler contract (`before.` stripped).
        handler: String,
    },
}

impl IrMigrationDirective {
    /// Canonical encoding feeding the migration body digest (stable
    /// across runs: source order, `|`-free shapes only).
    fn canonical(&self) -> String {
        match self {
            IrMigrationDirective::RenameOwner { from } => format!("renameOwner:{from}"),
            IrMigrationDirective::DropOwner => "dropOwner".to_string(),
            IrMigrationDirective::RenameModel { from, to } => {
                format!("renameModel:{from}->{to}")
            }
            IrMigrationDirective::RenameField { model, from, to } => {
                format!("renameField:{model}.{from}->{to}")
            }
            IrMigrationDirective::DropModel { model } => format!("dropModel:{model}"),
            IrMigrationDirective::DropField { model, field } => {
                format!("dropField:{model}.{field}")
            }
            IrMigrationDirective::Backfill { model } => format!("backfill:{model}"),
            IrMigrationDirective::Invalidate { handler } => format!("invalidate:{handler}"),
        }
    }
}

/// One lowered per-owner migration transition (B3-I1): the structural
/// half of the interim `MigrationTransition` intake. Snapshot-identity
/// completion (`toSnapshotId`, digests beyond the body) is
/// deployment/L1-bound: the compiler proves structure and predecessor,
/// never content hashes of schemas it cannot see.
#[derive(Debug, Clone)]
pub struct IrMigration {
    /// Owner name as written (`migration Owner`).
    pub owner: String,
    /// Stable migration id (`{owner}@{from}`).
    pub migration_id: String,
    /// Decoded `from=` predecessor snapshot id.
    pub from_snapshot: String,
    /// Lowered directives in source order.
    pub directives: Vec<IrMigrationDirective>,
    /// Lowercase hex SHA-256 over the canonical directive encoding.
    pub body_digest: String,
    /// Declaration span.
    pub span: Span,
}

/// Checked program in emission order: modules and items plus link metadata.
#[derive(Debug, Clone)]
pub struct IrProgram {
    /// Modules in `(file, span.start)` order (parity with analysis).
    pub modules: Vec<IrModule>,
    /// Items in declaration order (parity with analysis symbols).
    pub items: Vec<IrItem>,
    /// `catalog_version` consulted by analysis, or empty when none was.
    pub catalog_version: String,
    /// Builtin references observed while decoding checked call positions
    /// (true call-site spans), plus G13 ids from positions the build does
    /// not decode, with a fallback origin span.
    pub referenced_builtins: Vec<ReferencedBuiltin>,
    /// `read` registry rules in source order (G3).
    pub read_rules: Vec<IrRuleFn>,
    /// `invariants` registry rules in source order (G3).
    pub invariants: Vec<IrRuleFn>,
    /// `locks` registry entries in source order (G3).
    pub locks: Vec<IrLockFn>,
    /// `retention` registry entries in source order (G3).
    pub retention: Vec<IrNamedFn>,
    /// Shared `crudWhen` admission map entries in source order (G2).
    pub crud_when: Vec<IrNamedFn>,
    /// `preferencesValid` validators in source order (G4).
    pub preferences_valid: Vec<IrNamedFn>,
    /// Test suites in operation declaration order, orphans last (G10).
    pub suites: Vec<BddSuite>,
    /// Lowered migration transitions in source order (B3-I1). Only
    /// migrations that pass [`migrate_check`](crate::analysis::migrate_check)
    /// lower; invalid ones carry `E6009`/`E6010` and lower nothing.
    pub migrations: Vec<IrMigration>,
}

impl IrProgram {
    /// Look up an item by id.
    pub fn item(&self, id: SymbolId) -> &IrItem {
        &self.items[id.0 as usize]
    }

    /// Look up a module by id.
    pub fn module(&self, id: ModuleId) -> &IrModule {
        &self.modules[id.0 as usize]
    }

    /// Items owned by `module` in declaration order.
    pub fn items_of(&self, module: ModuleId) -> impl Iterator<Item = &IrItem> {
        self.items.iter().filter(move |item| item.module == module)
    }
}

/// Build the checked IR from `program`.
///
/// Pure transformation: copies modules/symbols, attaches resolved types
/// from `symbol_types`/`symbol_results`, and decodes the PR5
/// effects/examples tables anchored by [`NodeKey`] into the CST of `db`
/// (see the module docs for the span-anchored re-read contract). `catalog`
/// drives the G12 awaited rule and builtin classification. A different
/// source/catalog owner returns empty IR and `E6011` before parsing.
/// This low-level builder has no analysis-completeness/shipping gate:
/// absent table rows are `E6006`, unlowerable checked positions become
/// [`IrExpr::Unsupported`]/[`IrStmt::Unsupported`] for loud `E6008` at the
/// lowering stages.
pub fn build(
    program: &CheckedProgram,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> (IrProgram, Vec<Diagnostic>) {
    if let Err(diagnostic) = program.validate_cohort(db, catalog) {
        return (empty_program(&program.catalog_version), vec![diagnostic]);
    }
    let mut cx = Cx::new(program, db, catalog);
    cx.build_program()
}

fn empty_program(catalog_version: &str) -> IrProgram {
    IrProgram {
        modules: Vec::new(),
        items: Vec::new(),
        catalog_version: catalog_version.to_string(),
        referenced_builtins: Vec::new(),
        read_rules: Vec::new(),
        invariants: Vec::new(),
        locks: Vec::new(),
        retention: Vec::new(),
        crud_when: Vec::new(),
        preferences_valid: Vec::new(),
        suites: Vec::new(),
        migrations: Vec::new(),
    }
}

/// Resolve a declared symbol type, recording an `E6006` when the analysis
/// type table does not publish it (C3: `symbol_types`, populated by the
/// types pass).
fn lookup_symbol_type(
    program: &CheckedProgram,
    symbol: &crate::analysis::resolve::Symbol,
    what: &str,
    diags: &mut Vec<Diagnostic>,
) -> IrType {
    match program.types.symbol_types.get(&symbol.id) {
        Some(ty) => IrType::Known(ty.clone()),
        None => {
            diags.push(Diagnostic::error(
                "E6006",
                format!(
                    "{} {}: {what} is not published in the analysis type table; emitting a placeholder schema",
                    kind_noun(&symbol.kind),
                    symbol.canonical,
                ),
                symbol.span,
            ));
            IrType::Unknown
        }
    }
}

/// Resolve a declared operation result, recording an `E6006` when the
/// analysis type table does not publish it (C3: `symbol_results`).
/// `declared` is whether the source declares a result at all: undeclared
/// (void) results resolve to `None` with no diagnostic.
fn lookup_symbol_result(
    program: &CheckedProgram,
    symbol: &crate::analysis::resolve::Symbol,
    declared: bool,
    diags: &mut Vec<Diagnostic>,
) -> Option<ResolvedType> {
    match program.types.symbol_results.get(&symbol.id) {
        Some(result) => result.clone(),
        None if !declared => None,
        None => {
            diags.push(Diagnostic::error(
                "E6006",
                format!(
                    "{} {}: declared result type is not published in the analysis type table; omitting the result schema",
                    kind_noun(&symbol.kind),
                    symbol.canonical,
                ),
                symbol.span,
            ));
            None
        }
    }
}

/// Short noun for an item kind, for diagnostics.
fn kind_noun(kind: &SymbolKind) -> &'static str {
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

/// Significant children: everything except whitespace gaps and `##`
/// comments.
fn kids(node: &SyntaxNode) -> Vec<&SyntaxNode> {
    node.children
        .iter()
        .filter(|n| !matches!(n.kind, SyntaxKind::Trivia | SyntaxKind::Comment))
        .collect()
}

/// Slice source text for `span` (empty when out of range; total).
fn slice(db: &SourceDb, span: Span) -> &str {
    db.get(span.file)
        .and_then(|s| s.text.get(span.start as usize..span.end as usize))
        .unwrap_or("")
}

/// Find the CST node for `key` by span plus kind discriminant (total).
fn find_node<'t>(tree: &'t SyntaxNode, key: &NodeKey) -> Option<&'t SyntaxNode> {
    if tree.span.start == key.start && tree.span.end == key.end && tree.kind as u8 == key.kind {
        return Some(tree);
    }
    tree.children
        .iter()
        .filter_map(|child| find_node(child, key))
        .next()
}

/// Whether `name` is a `by`/`read` predicate spelling (kept verbatim).
fn is_predicate_spelling(name: &str) -> bool {
    matches!(name, "members" | "owner" | "authenticated" | "public")
}

/// Whether `name` is a provisioned example account (factory parameter).
fn is_test_account(name: &str) -> bool {
    matches!(name, "self" | "other")
}

/// Duration literal slice (`5s`, `300ms`, ...) to milliseconds.
fn duration_millis(slice: &str) -> Option<i128> {
    let (digits, factor) = ["ms", "s", "m", "h", "d"].iter().find_map(|suffix| {
        slice
            .strip_suffix(suffix)
            .filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
            .map(|d| {
                (
                    d,
                    match *suffix {
                        "ms" => 1i128,
                        "s" => 1_000,
                        "m" => 60_000,
                        "h" => 3_600_000,
                        _ => 86_400_000,
                    },
                )
            })
    })?;
    digits.parse::<i128>().ok()?.checked_mul(factor)
}

/// Bridge build context: tables plus re-parsed sources and indexes.
struct Cx<'a> {
    program: &'a CheckedProgram,
    db: &'a SourceDb,
    catalog: Option<&'a Catalog>,
    /// Re-parsed trees per source, in [`SourceDb`] order.
    trees: Vec<(SourceId, SyntaxNode)>,
    /// `(module, name)` to member symbol.
    by_name: HashMap<(ModuleId, String), SymbolId>,
    /// `(owner, name)` to field symbol (model/contract/event/preferences
    /// fields plus derived fields).
    fields: HashMap<(SymbolId, String), SymbolId>,
    /// Module id by canonical module name.
    modules_by_name: HashMap<String, ModuleId>,
    /// Builtins observed while decoding calls (true call-site spans).
    builtins_seen: Vec<ReferencedBuiltin>,
    /// G13 ids already observed (the rest seed with a fallback span).
    g13_seen: HashSet<String>,
    /// Taken page function names (dedup).
    page_fns: HashSet<String>,
    /// Preferences validator name per module (filled by rule maps).
    preference_validators: HashMap<ModuleId, String>,
    diags: Vec<Diagnostic>,
}

impl<'a> Cx<'a> {
    fn new(program: &'a CheckedProgram, db: &'a SourceDb, catalog: Option<&'a Catalog>) -> Self {
        let mut trees = Vec::new();
        for &id in program.checked_files() {
            let (tree, _) = crate::syntax::parse(db, id);
            trees.push((id, tree));
        }
        let mut by_name = HashMap::new();
        let mut fields = HashMap::new();
        for symbol in &program.symbols {
            by_name.insert((symbol.module, symbol.name.clone()), symbol.id);
            match &symbol.kind {
                SymbolKind::Field { owner, .. } | SymbolKind::DeriveField { model: owner, .. } => {
                    fields.insert((*owner, symbol.name.clone()), symbol.id);
                }
                _ => {}
            }
        }
        let modules_by_name = program
            .modules
            .iter()
            .map(|m| (m.name.clone(), m.id))
            .collect();
        Self {
            program,
            db,
            catalog,
            trees,
            by_name,
            fields,
            modules_by_name,
            builtins_seen: Vec::new(),
            g13_seen: HashSet::new(),
            page_fns: HashSet::new(),
            preference_validators: HashMap::new(),
            diags: Vec::new(),
        }
    }

    /// Source text for `span` (total).
    fn text(&self, span: Span) -> &str {
        slice(self.db, span)
    }

    /// CST node for `key` (total).
    fn node(&self, key: &NodeKey) -> Option<&SyntaxNode> {
        self.trees
            .iter()
            .find(|(id, _)| *id == key.file)
            .and_then(|(_, tree)| find_node(tree, key))
    }

    /// Record an `E6006` gap diagnostic.
    fn gap(&mut self, message: String, span: Span) {
        self.diags.push(Diagnostic::error("E6006", message, span));
    }

    /// Resolve a member name in `module`, following `use` aliases.
    /// Returns the symbol plus whether it came through an import.
    fn resolve_member(&self, module: ModuleId, name: &str) -> Option<(SymbolId, bool)> {
        if let Some(id) = self.by_name.get(&(module, name.to_string())) {
            return Some((*id, false));
        }
        let host = self.program.modules.get(module.0 as usize)?;
        for import in &host.imports {
            for member in &import.members {
                if member.alias == name
                    && let Some(provider) = self.modules_by_name.get(&import.provider)
                    && let Some(id) = self.by_name.get(&(*provider, member.name.clone()))
                {
                    return Some((*id, true));
                }
            }
        }
        None
    }

    /// Canonical identity of `id` (total over symbol ids).
    fn canonical(&self, id: SymbolId) -> String {
        self.program
            .symbols
            .get(id.0 as usize)
            .map(|s| s.canonical.clone())
            .unwrap_or_else(|| format!("symbol{}", id.0))
    }

    /// Local name of `id` (total over symbol ids).
    fn local_name(&self, id: SymbolId) -> String {
        self.program
            .symbols
            .get(id.0 as usize)
            .map(|s| s.name.clone())
            .unwrap_or_else(|| format!("symbol{}", id.0))
    }
}

// --- Scalar classification -------------------------------------------------
//
// The §13 scalar lowering dispatches on the checked operand type. These
// helpers classify [`ResolvedType`] so [`crate::codegen::js`] picks one
// import name per operation.

/// Scalar families with distinct §13 lowering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScalarFamily {
    Int,
    Decimal,
    Money,
    Duration,
    Date,
    Datetime,
    Bool,
    Text,
    Enum,
    Reference,
    Secret,
}

/// Classify a checked type into its §13 scalar family, if it is one.
///
/// `Nullable` unwraps one layer; `Null` matches any nullable side during
/// comparison lowering and classifies as nothing here.
pub fn scalar_family(ty: &ResolvedType) -> Option<ScalarFamily> {
    match ty {
        ResolvedType::Nullable(inner) => scalar_family(inner),
        ResolvedType::Scalar(scalar) => Some(match scalar {
            Scalar::Int => ScalarFamily::Int,
            Scalar::Decimal => ScalarFamily::Decimal,
            Scalar::Money => ScalarFamily::Money,
            Scalar::Duration => ScalarFamily::Duration,
            Scalar::Date => ScalarFamily::Date,
            Scalar::Datetime => ScalarFamily::Datetime,
            Scalar::Bool => ScalarFamily::Bool,
            Scalar::Text
            | Scalar::Email
            | Scalar::Url
            | Scalar::Locale
            | Scalar::Timezone
            | Scalar::Currency => ScalarFamily::Text,
            Scalar::User | Scalar::Member | Scalar::File | Scalar::Json | Scalar::Bytes => {
                ScalarFamily::Reference
            }
            Scalar::Secret => ScalarFamily::Secret,
        }),
        ResolvedType::Enum { .. } => Some(ScalarFamily::Enum),
        ResolvedType::Record { .. }
        | ResolvedType::Message(_)
        | ResolvedType::Team
        | ResolvedType::OperationContext => Some(ScalarFamily::Reference),
        ResolvedType::Error
        | ResolvedType::Unknown
        | ResolvedType::Null
        | ResolvedType::Action { .. }
        | ResolvedType::Invocation { .. }
        | ResolvedType::Delivery { .. }
        | ResolvedType::StdDelivery { .. }
        | ResolvedType::Array { .. }
        | ResolvedType::Union(_)
        | ResolvedType::Object(_)
        | ResolvedType::Operation(_)
        | ResolvedType::Opaque(_) => None,
    }
}

/// Whether values of this type compare structurally with
/// `equalValue(c, canonicalTypeId, a, b)` (arrays and contracts/records by
/// value rather than JavaScript object identity).
pub fn is_structural(ty: &ResolvedType) -> bool {
    match ty {
        ResolvedType::Nullable(inner) => is_structural(inner),
        ResolvedType::Array { .. } | ResolvedType::Record { .. } | ResolvedType::Object(_) => true,
        ResolvedType::Error
        | ResolvedType::Unknown
        | ResolvedType::Null
        | ResolvedType::Scalar(_)
        | ResolvedType::Team
        | ResolvedType::OperationContext
        | ResolvedType::Enum { .. }
        | ResolvedType::Message(_)
        | ResolvedType::Action { .. }
        | ResolvedType::Invocation { .. }
        | ResolvedType::Delivery { .. }
        | ResolvedType::StdDelivery { .. }
        | ResolvedType::Union(_)
        | ResolvedType::Operation(_)
        | ResolvedType::Opaque(_) => false,
    }
}

// --- Checked expressions (PR5 contract) ------------------------------------
//
// PR5 will produce these from checked expression positions (guards, effects,
// defaults, queries, example cells). Today they are built by fixture tests
// to pin the §13 lowering per construct.

/// One checked expression with its resolved type and source span.
#[derive(Debug, Clone)]
pub struct TypedExpr {
    /// Expression shape.
    pub expr: IrExpr,
    /// Checked type (drives scalar-dispatch in lowering).
    pub ty: ResolvedType,
    /// Source span (source-map attribution).
    pub span: Span,
}

impl TypedExpr {
    /// Attach a type and span to a shape.
    pub fn new(expr: IrExpr, ty: ResolvedType, span: Span) -> Self {
        Self { expr, ty, span }
    }
}

/// Checked expression shapes with a §13 lowering.
#[derive(Debug, Clone)]
pub enum IrExpr {
    /// Exact integer literal → BigInt (`5n`).
    Int(i128),
    /// Exact decimal literal, canonical source spelling (`"1.50"`).
    Decimal(String),
    /// Text literal.
    Text(String),
    /// Boolean literal.
    Bool(bool),
    /// `null` literal.
    Null,
    /// `money(minor, "CUR")` construct → `money(25n,"EUR")`.
    Money { minor: i128, currency: String },
    /// Duration constant in milliseconds → BigInt (`300000n`).
    DurationMs(i128),
    /// `date("2026-10-01")` construct.
    Date(String),
    /// `datetime("...Z")` construct.
    Datetime(String),
    /// Lexical reference (`c`, `row`, `s`, `b`, `result`, locals).
    Name(String),
    /// Field access (`row.status`, `c.actor`).
    Member { base: Box<TypedExpr>, field: String },
    /// Call to a source-callable target.
    Call {
        target: IrCallTarget,
        args: Vec<TypedExpr>,
    },
    /// Supplied expressions in source order, with the checked target slots.
    /// The emitter captures only when slots reorder or omit arguments.
    BoundCall {
        target: IrCallTarget,
        args: Vec<TypedExpr>,
        slots: Vec<Option<usize>>,
    },
    /// Binary operator (scalar-dispatched in lowering).
    Binary {
        op: IrBinOp,
        left: Box<TypedExpr>,
        right: Box<TypedExpr>,
    },
    /// Unary operator.
    Unary { op: IrUnOp, operand: Box<TypedExpr> },
    /// Array literal.
    Array(Vec<TypedExpr>),
    /// Object literal.
    Object(Vec<(String, TypedExpr)>),
    /// Query domain → `records(c, model, {...})`.
    Query(IrQuery),
    /// Stored delivery observation →
    /// `await delivery(c, {record, field}, ["status"])`.
    DeliveryRead {
        record: Box<TypedExpr>,
        field: String,
        props: Vec<String>,
    },
    /// Inline message descriptor → `message(...)`.
    Message(IrMessage),
    /// A named message whose checked slots reorder or use defaults.
    MessageCall {
        descriptor: IrMessage,
        args: Vec<TypedExpr>,
        params: Vec<IrMessageCallParam>,
    },
    /// Localized formatting through the checked descriptor/runtime adapter.
    Format {
        /// Explicit arguments in written evaluation order, each visited once.
        args: Vec<TypedExpr>,
        /// Checked formal-to-source bindings, never reconstructed from names.
        descriptor_index: usize,
        locale_index: usize,
        /// Source language of the descriptor's owning declaration/module.
        source_lang: String,
        /// (parameter name, canonical checked type, Values presentation tag).
        param_types: Vec<(String, String, String)>,
    },
    /// Role gate in expression position (subject predicate or bare gate
    /// over the caller) → `hasRole(c, role)` / `hasRole(c, role, person)`.
    HasRole {
        /// Canonical role identity.
        role: String,
        /// Subject person, when the source passes one.
        person: Option<Box<TypedExpr>>,
    },
    /// One predicate lambda for collection `where` props:
    /// `(param) => body`.
    Lambda {
        /// Parameter name (the source `as` name, else `row`).
        param: String,
        /// Predicate body.
        body: Box<TypedExpr>,
    },
    /// Checked expression with no §13 lowering. The lowering stages
    /// report `E6008` naming the position and emit a throwing
    /// placeholder; the build never invents a meaning instead.
    Unsupported {
        /// What could not be lowered (`select query`, ...).
        what: String,
        /// Why there is no lowering.
        why: String,
    },
}

/// Source-callable call targets.
#[derive(Debug, Clone)]
pub enum IrCallTarget {
    /// Catalog builtin id (`count`, `first`, `any`, ...): imported from
    /// `@canlang/stdlib`, availability-checked against the catalog (`E6007`).
    /// `awaited` marks builtins the target awaits (`count`, `first`,
    /// `any`, ...); PR5 derives it from catalog effects (exact rule TBD).
    Builtin { id: String, awaited: bool },
    /// Capability operation by canonical id: imported from its owning
    /// package module and invoked as `await op(c, ...)`.
    CapabilityOp(String),
    /// Derived function by canonical id: emitted as a module-scope
    /// named function and invoked as `await name(c, ...)` (always
    /// awaited: emitted derives are `async`).
    DeriveFn(String),
}

/// Binary operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IrBinOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
    Coalesce,
    In,
}

/// Unary operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IrUnOp {
    Neg,
    Not,
}

/// One `order` entry of a query: `field` or `-field`.
#[derive(Debug, Clone)]
pub struct IrOrder {
    /// Field name.
    pub field: String,
    /// Whether descending (`-field`).
    pub descending: bool,
}

/// Query domain: a stored model (server `records()`) or an in-memory
/// value (array combinators over the decoded base).
#[derive(Debug, Clone)]
pub enum IrQueryDomain {
    /// Canonical model identity.
    Model(String),
    /// Value base plus the concrete item alias (`as` name, else `row`).
    Value { base: Box<TypedExpr>, alias: String },
}

/// Checked query → `records(c, model, {parent?, where?, order?, limit?, archived?})`
/// for model domains, array combinators for value domains.
#[derive(Debug, Clone)]
pub struct IrQuery {
    /// Query domain.
    pub domain: IrQueryDomain,
    /// Containment parent value, if any (model domains only).
    pub parent: Option<Box<TypedExpr>>,
    /// Row predicate over `row` (model domains) or the value alias
    /// (value domains), if any.
    pub where_pred: Option<Box<TypedExpr>>,
    /// Whether the predicate needs `async` (delivery reads, service calls).
    pub where_async: bool,
    /// Order entries in source order (model domains only).
    pub order: Vec<IrOrder>,
    /// Limit value, if any (excess fails, never truncates silently).
    pub limit: Option<Box<TypedExpr>>,
    /// Archived selector, if any (model domains only).
    pub archived: Option<Box<TypedExpr>>,
    /// `select` projection body, alias-scoped, if any.
    pub select: Option<Box<TypedExpr>>,
    /// `select` lambda parameter (concrete exactly when `select` is set).
    pub select_param: Option<String>,
}

// --- Guards, effects, pages, UI (PR5 contract) -----------------------------

/// Checked admission guard: `by` clauses, `require` conditions, page guards.
#[derive(Debug, Clone)]
pub enum IrGuard {
    /// Role gate (canonical role, or a predicate spelling `members`, `owner`,
    /// `authenticated`, `public`) → `hasRole(c, id)`.
    Role(String),
    /// Subject predicate `role(person)` → `hasRole(c, id, person)`.
    Subject {
        role: String,
        person: Box<TypedExpr>,
    },
    /// Arbitrary checked boolean expression.
    Expr(TypedExpr),
    /// Conjunction in source order.
    And(Vec<IrGuard>),
    /// Disjunction in source order.
    Or(Vec<IrGuard>),
    /// Negation.
    Not(Box<IrGuard>),
}

/// Deletion mode: `deleteRecord(c, row, {mode:'archive'|'remove'})`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IrDeleteMode {
    Archive,
    Remove,
}

impl IrDeleteMode {
    /// Wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            IrDeleteMode::Archive => "archive",
            IrDeleteMode::Remove => "remove",
        }
    }
}

/// Checked trusted handler identity and finite payload authority.
#[derive(Debug, Clone)]
pub enum IrEventSource {
    Declared(String),
    DeliveryProgressed(String),
}

/// Pre-commit hook trigger (T31 Rule A): the hooked model plus the
/// triggering operation. Emission registers one run function per trigger
/// under the source trigger key (`Model.delete` for deletes) with the
/// engine op spelling (`remove`) in the descriptor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IrHook {
    /// Hooked (triggering) model.
    pub model: SymbolId,
    /// Triggering operation.
    pub op: CrudOp,
}

/// Checked `each=` fanout cohort (T34-F6): the static descriptor the
/// F7 runtime join reads to freeze membership (F1 `FanoutCohortKind`
/// vocabulary; the runtime resolves owner + parent id at trigger time
/// into an F5 `FanoutCohortSpec`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IrCohort {
    /// Cohort spelling: whole-model enumeration or one parent's
    /// contained reverse collection.
    pub kind: IrCohortKind,
    /// Enumerated model (bare spelling) or child model (anchored spelling).
    pub model: SymbolId,
    /// `as` child binding, when the header declares one.
    pub bind: Option<String>,
    /// Anchored spelling only: the event-rooted dotted parent path
    /// (`event.opportunity` for `each=event.opportunity.Signup`).
    pub parent: Option<String>,
    /// `each=` value span.
    pub span: Span,
}

/// Adopted `each=` cohort spellings (T34-F6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IrCohortKind {
    /// Bare-model enumeration (`each=Signup`).
    Model,
    /// Parent-anchored reverse collection (`each=event.opportunity.Signup`).
    AnchoredCollection,
}

impl IrCohortKind {
    /// Descriptor `kind` spelling (matches F1 `FanoutCohortKind`).
    pub fn as_str(self) -> &'static str {
        match self {
            IrCohortKind::Model => "model",
            IrCohortKind::AnchoredCollection => "anchored-collection",
        }
    }
}

/// Static choice assistance; no annotation expression executes at runtime.
#[derive(Debug, Clone)]
pub struct IrInputChoiceBinding {
    pub read_operation: String,
    pub arguments: Vec<(String, IrChoiceArgument)>,
    pub value: IrChoiceValue,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct IrChoiceArgument {
    pub input: String,
    pub path: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum IrChoiceValue {
    Record,
    Field(String),
}

/// One arm of a checked exhaustive enum statement.
#[derive(Debug, Clone)]
pub struct IrMatchArm {
    /// Case label admitted in the checked subject's enum domain.
    pub case: String,
    /// Ordered effects in this arm's own lexical scope.
    pub body: Vec<IrStmt>,
    pub span: Span,
}

/// Checked effect/handler statements in source order.
#[derive(Debug, Clone)]
pub enum IrStmt {
    /// `let name = value`.
    Let {
        name: String,
        value: TypedExpr,
        span: Span,
    },
    /// `create Model {...}` → `create(c, model, input, {when})`.
    Create {
        model: String,
        input: TypedExpr,
        when: Option<String>,
        binding: Option<String>,
        span: Span,
    },
    /// `set record {...}` → `set(c, record, changes, {when})`.
    Set {
        record: TypedExpr,
        changes: TypedExpr,
        when: Option<String>,
        span: Span,
    },
    /// Explicit ordered transition of one managed enum field.
    Transition {
        model: String,
        record: TypedExpr,
        field: String,
        from: String,
        to: String,
        span: Span,
    },
    /// `delete record` with its authored mode.
    Delete {
        record: TypedExpr,
        mode: IrDeleteMode,
        span: Span,
    },
    /// `call operation {...}`. Cross-operation canonical invocation has no
    /// §13 lowering; the JS stage raises `E6008` naming the operation.
    Call {
        operation: String,
        inputs: TypedExpr,
        binding: Option<String>,
        span: Span,
    },
    /// `emit Event {...}` → `emit(c, identity, payload)`.
    Emit {
        event: String,
        payload: TypedExpr,
        span: Span,
    },
    /// `send op {...}` → `send(c, identity, args, {when?})`.
    Send {
        operation: String,
        args: TypedExpr,
        when: Option<TypedExpr>,
        binding: Option<String>,
        /// Exact importing module/alias key in appDefinition.bindings.
        deployment_binding: Option<String>,
        span: Span,
    },
    /// `schedule key at=... event=... {...}`.
    Schedule {
        /// Checked declaring package; schedule keys are independent of the
        /// operation that originally admitted the shared runtime context.
        owner_package: String,
        key: TypedExpr,
        at: TypedExpr,
        event: String,
        payload: TypedExpr,
        span: Span,
    },
    /// `cancel key` addresses the declaring package's scoped key.
    Cancel {
        owner_package: String,
        key: TypedExpr,
        span: Span,
    },
    /// `return value?`.
    Return {
        value: Option<TypedExpr>,
        span: Span,
    },
    /// `require cond` → `check(cond)`.
    Require { cond: TypedExpr, span: Span },
    /// `if` with optional else branch.
    If {
        cond: TypedExpr,
        then_branch: Vec<IrStmt>,
        else_branch: Vec<IrStmt>,
        span: Span,
    },
    /// Exhaustive single-case enum arms, with one evaluation of the subject.
    Match {
        subject: TypedExpr,
        arms: Vec<IrMatchArm>,
        span: Span,
    },
    /// `for item in domain` → `for (const item of await domain)`.
    /// `limit` is the fail-closed bound (DESIGN §5 table): fail the
    /// operation when more than N items would be processed.
    For {
        item: String,
        domain: TypedExpr,
        limit: Option<TypedExpr>,
        body: Vec<IrStmt>,
        span: Span,
    },
    /// Checked statement with no §13 lowering. The lowering stages
    /// report `E6008` naming the position and emit a throwing
    /// placeholder; the build never invents a meaning instead.
    Unsupported {
        /// What could not be lowered (`for limit`, ...).
        what: String,
        /// Why there is no lowering.
        why: String,
        /// Statement span.
        span: Span,
    },
}

/// Parameterized display message → `message(source, {locales}, {params})`.
/// Static messages omit the third argument.
#[derive(Debug, Clone)]
pub struct IrMessage {
    /// Source-language text.
    pub source: String,
    /// `(locale, translation)` pairs; `None` renders `null`.
    pub variants: Vec<(String, Option<String>)>,
    /// Typed parameters in source order.
    pub params: Vec<IrMessageParam>,
}

#[derive(Debug, Clone)]
pub struct IrMessageCallParam {
    pub name: String,
    pub type_id: String,
    pub source: Option<usize>,
    /// Only omitted defaults are decoded/evaluated at this call.
    pub default: Option<TypedExpr>,
}

/// Field creation default (PR5 contract): literal defaults stay literal
/// `default` values; nonliteral defaults lower to a typed
/// `default(c,{parent})` callable over creation context only (the second
/// argument carries just the resolved parent when containment exists).
#[derive(Debug, Clone)]
pub enum IrDefault {
    /// Literal default value.
    Literal(TypedExpr),
    /// Computed default over creation context.
    Computed { expr: TypedExpr, has_parent: bool },
}

/// Server initializer (PR5 contract): the fixed `actor`/`now` metadata or
/// a callable in the same convention, always excluding caller input.
#[derive(Debug, Clone)]
pub enum IrServer {
    Actor,
    Now,
    Computed(Box<TypedExpr>),
}

/// One typed message parameter.
#[derive(Debug, Clone)]
pub struct IrMessageParam {
    /// Parameter name.
    pub name: String,
    /// Canonical type id (`int`, `expense.Expense.status`, ...).
    pub type_id: String,
    /// Value expression.
    pub value: TypedExpr,
}

/// One UI factory node: lowercase server factory, one props object plus
/// `children` arrays. Never `h`, native-element expansion, hydration or
/// browser business-state stores.
#[derive(Debug, Clone)]
pub struct IrUi {
    /// Factory name (`card`, `text`, `table`, `list`, `form`, ...).
    pub factory: String,
    /// Props in source order.
    pub props: Vec<(String, TypedExpr)>,
    /// Child nodes.
    pub children: Vec<IrUi>,
    /// Row scope for collections: `(row, view)` names rendering
    /// `renderRow:(row,view)=>[children]` instead of `children`.
    pub row_scope: Option<(String, String)>,
    /// Presentation gate: direct `require` children conjoin into one
    /// boolean lowering as `cond ? node : null`.
    pub gate: Option<TypedExpr>,
    /// Source span.
    pub span: Span,
}

/// One page → named page function plus page descriptor
/// `{owner, path, title, description?, order?, group?, nav?, admit, render}`
/// in source order.
#[derive(Debug, Clone)]
pub struct IrPage {
    /// Canonical declaring package.
    pub owner: String,
    /// Normalized route pattern.
    pub path: String,
    /// Static caption.
    pub title: IrMessage,
    /// Static description, if authored.
    pub description: Option<IrMessage>,
    /// Exact authored order, if any → BigInt.
    pub order: Option<i128>,
    /// Page group, if authored.
    pub group: Option<String>,
    /// Whether `nav:"none"` was authored.
    pub nav_none: bool,
    /// `poll=` cadence in millis, if authored → BigInt.
    pub poll: Option<i128>,
    /// `refresh=` canonical user mutation, if authored.
    pub refresh: Option<String>,
    /// Admission guards in source order.
    pub admit: Vec<IrGuard>,
    /// Render body: UI factory nodes in source order.
    pub render: Vec<IrUi>,
    /// Page function name.
    pub fn_name: String,
    /// Descriptor binding name.
    pub descriptor_name: String,
    /// Declaration span.
    pub span: Span,
}

// --- Test artifacts (PR5 contract, lowered by `bdd`) -----------------------

/// Fixture recipe kind. Model/user/file/delivery kinds are mutually
/// exclusive; provisioned scope values are protected isolated handles.
#[derive(Debug, Clone)]
pub enum IrFixtureKind {
    /// `{model, dependencies, value: async (c, s) => fields}`.
    Model { model: String, fields: TypedExpr },
    /// `{dependencies: [], user: async (c, s) => ({roles})}` with canonical
    /// role identities.
    User { roles: Vec<String> },
    /// `{dependencies, file: async (c, s) => fields}`.
    File { fields: TypedExpr },
    /// `{delivery, values: async (c, s) => ({request, status?, result?, error?})}`.
    /// `operation` is the local canonical op name, or — for T15b
    /// `std` joins — the qualified T13 send target
    /// (`std.EmailV1.send` vocabulary).
    Delivery {
        operation: String,
        request: Box<TypedExpr>,
        status: Option<Box<TypedExpr>>,
        result: Option<Box<TypedExpr>>,
        error: Option<Box<TypedExpr>>,
    },
}

/// One fixture recipe.
#[derive(Debug, Clone)]
pub struct IrFixture {
    /// Recipe binding name.
    pub name: String,
    /// Canonical fixture identity.
    pub canonical: String,
    /// Recipe kind.
    pub kind: IrFixtureKind,
    /// Baseline dependency recipe names.
    pub dependencies: Vec<String>,
    /// Source span.
    pub span: Span,
}

/// One table row: own dependencies, cells, and either expected values or an
/// exact error code.
#[derive(Debug, Clone)]
pub struct IrTableRow {
    /// Row dependency recipe names.
    pub dependencies: Vec<String>,
    /// Cell values in selector order.
    pub values: TypedExpr,
    /// Expected observation values, if the row passes.
    pub expected: Option<TypedExpr>,
    /// Exact error code, if the row fails.
    pub error: Option<String>,
    /// Source span.
    pub span: Span,
}

/// One behavior table.
#[derive(Debug, Clone)]
pub struct IrTable {
    /// Attaching operation identity.
    pub operation: String,
    /// Common baseline dependency recipe names.
    pub dependencies: Vec<String>,
    /// Common inputs callback value.
    pub inputs: TypedExpr,
    /// Selector path metadata in source order.
    pub selectors: Vec<String>,
    /// Observation callbacks in source order.
    pub observations: Vec<TypedExpr>,
    /// Selected rows in source order.
    pub rows: Vec<IrTableRow>,
    /// Source span.
    pub span: Span,
}

/// One sequence step: call, binding or assertion (distinct required keys
/// discriminate the shapes; no Can strings are interpreted).
///
/// Call steps legitimately dwarf bindings; the IR is built once per
/// compilation, so boxing for size buys nothing.
#[derive(Debug, Clone)]
#[allow(clippy::large_enum_variant)]
pub enum IrStep {
    /// `{operation, by, inputs, request?, bind?, error?}`. The outer
    /// operation identifies the attaching scenario; it causes no implicit
    /// call. Exact-error steps cannot also bind.
    Call {
        operation: String,
        by: TypedExpr,
        inputs: TypedExpr,
        request: Option<TypedExpr>,
        bind: Option<String>,
        error: Option<String>,
    },
    /// `{let, value}`.
    Binding { name: String, value: TypedExpr },
    /// `{observations, expected, types}` with canonical type ids.
    Assertion {
        observations: TypedExpr,
        expected: TypedExpr,
        types: Vec<String>,
    },
}

/// One causal sequence.
#[derive(Debug, Clone)]
pub struct IrSequence {
    /// Attaching operation identity.
    pub operation: String,
    /// Dependency recipe names, provisioned once before the first step.
    pub dependencies: Vec<String>,
    /// Steps in source order.
    pub steps: Vec<IrStep>,
    /// Source span.
    pub span: Span,
}

// --- Bridge build ---------------------------------------------------------

impl<'a> Cx<'a> {
    /// Build the program: modules, rule maps, items, suites.
    fn build_program(&mut self) -> (IrProgram, Vec<Diagnostic>) {
        let modules = self.build_modules();
        // Rule maps first: preferences items read their validator names.
        let mut read_rules = Vec::new();
        let mut invariants = Vec::new();
        let mut locks = Vec::new();
        let mut retention = Vec::new();
        let mut crud_when = Vec::new();
        let mut preferences_valid = Vec::new();
        self.build_rule_maps(
            &mut read_rules,
            &mut invariants,
            &mut locks,
            &mut retention,
            &mut crud_when,
            &mut preferences_valid,
        );
        let items = self.build_items();
        self.check_bound_capabilities();
        let migrations = self.build_migrations();
        let suites = self.build_suites(&items);
        let referenced_builtins = self.build_referenced_builtins();
        let program = IrProgram {
            modules,
            items,
            catalog_version: self.program.catalog_version.clone(),
            referenced_builtins,
            read_rules,
            invariants,
            locks,
            retention,
            crud_when,
            preferences_valid,
            suites,
            migrations,
        };
        (program, std::mem::take(&mut self.diags))
    }

    /// Copy modules, decoding pages and descriptions (G9).
    fn build_modules(&mut self) -> Vec<IrModule> {
        let mut out = Vec::with_capacity(self.program.modules.len());
        for m in self.program.modules.clone() {
            // Corpus has no checked symbol or descriptor to lower. Inspect only
            // the owning module's Given leaves, without interpreting attributes
            // or inventing a generated interface from the source spelling.
            if let Some((_, tree)) = self.trees.iter().find(|(file, _)| *file == m.file)
                && let Some(module) = tree.children.iter().find(|node| {
                    matches!(node.kind, SyntaxKind::App | SyntaxKind::Package)
                        && node.span == m.span
                })
            {
                for corpus in module
                    .children
                    .iter()
                    .filter(|node| node.kind == SyntaxKind::Section)
                    .flat_map(|section| section.children.iter())
                    .filter(|node| node.kind == SyntaxKind::Corpus)
                {
                    let parts = kids(corpus);
                    let span = Span::new(
                        corpus.span.file,
                        parts
                            .first()
                            .map_or(corpus.span.start, |node| node.span.start),
                        parts.last().map_or(corpus.span.end, |node| node.span.end),
                    );
                    let name = parts
                        .iter()
                        .filter(|node| node.kind == SyntaxKind::Name)
                        .nth(1)
                        .map(|node| self.text(node.span))
                        .unwrap_or("?");
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        format!(
                            "corpus {}.{name}: corpus declarations have no supported emission; generated interfaces and runtime ownership are not implemented",
                            m.name,
                        ),
                        span,
                    ));
                }
            }
            let module_data = self.program.effects.modules.get(&m.id).cloned();
            if module_data.is_none() && !matches!(m.kind, ModuleKind::ComposedApp) {
                self.gap(
                    format!(
                        "module {}: policies, pages, examples, migrations and descriptions have no analysis row (PR5); omitting them from emission",
                        m.name,
                    ),
                    m.span,
                );
            }
            let mut pages = Vec::new();
            let mut description = None;
            if let Some(data) = &module_data {
                for page in &data.pages {
                    pages.push(self.decode_page(m.id, &m.name, page));
                }
                description = self.module_description(m.id, data);
            }
            out.push(IrModule {
                id: m.id,
                name: m.name.clone(),
                kind: m.kind,
                file: m.file,
                span: m.span,
                imports: m
                    .imports
                    .iter()
                    .map(|i| IrImport {
                        provider: i.provider.clone(),
                        provider_span: i.provider_span,
                        members: i
                            .members
                            .iter()
                            .map(|mem| (mem.name.clone(), mem.alias.clone(), mem.span))
                            .collect(),
                        from: i.from.clone(),
                        span: i.span,
                    })
                    .collect(),
                uses: m.uses.clone(),
                uses_resolved: m
                    .uses_resolved
                    .iter()
                    .map(|id| {
                        self.program
                            .modules
                            .get(id.0 as usize)
                            .map_or_else(|| format!("module{}", id.0), |target| target.name.clone())
                    })
                    .collect(),
                app_default_locale: module_data.and_then(|data| data.app_default_locale),
                pages,
                description,
            });
        }
        out
    }

    /// Copy symbols, decoding per-item PR5 data (G1-G8).
    fn build_items(&mut self) -> Vec<IrItem> {
        let mut out = Vec::with_capacity(self.program.symbols.len());
        for symbol in self.program.symbols.clone() {
            let kind = self.build_item_kind(&symbol);
            out.push(IrItem {
                id: symbol.id,
                canonical: symbol.canonical.clone(),
                name: symbol.name.clone(),
                module: symbol.module,
                span: symbol.span,
                exported: symbol.exported,
                kind,
            });
        }
        out
    }

    /// Decode one symbol's item kind plus its PR5 payload.
    #[allow(clippy::too_many_lines)]
    fn build_item_kind(&mut self, symbol: &crate::analysis::resolve::Symbol) -> IrItemKind {
        match &symbol.kind {
            SymbolKind::Model {
                fields,
                owner,
                crud,
            } => {
                let (label, grants, invariants, locks, uniques, retain) = self.decode_model(symbol);
                IrItemKind::Model {
                    fields: fields.clone(),
                    owner: match owner {
                        ModelOwner::Team => IrOwner::Team,
                        ModelOwner::ChildOf(parent) => IrOwner::ChildOf(*parent),
                        ModelOwner::App => IrOwner::App,
                    },
                    crud: *crud,
                    label,
                    grants,
                    invariants,
                    locks,
                    uniques,
                    retain,
                }
            }
            SymbolKind::Contract { fields } => {
                let label = self.decode_record_label(symbol, "contract");
                IrItemKind::Contract {
                    fields: fields.clone(),
                    label,
                }
            }
            SymbolKind::Event { fields } => {
                if !self.program.effects.records.contains_key(&symbol.id) {
                    self.gap(
                        format!(
                            "event {}: field modifiers/defaults are not in the analysis tables (PR5 labels); emitting the typed schema without them",
                            symbol.canonical,
                        ),
                        symbol.span,
                    );
                }
                IrItemKind::Event {
                    fields: fields.clone(),
                }
            }
            SymbolKind::Role => {
                let label = self
                    .program
                    .effects
                    .roles
                    .get(&symbol.id)
                    .and_then(|data| data.label)
                    .and_then(|key| self.decode_message_value(symbol.module, &key));
                if !self.program.effects.roles.contains_key(&symbol.id) {
                    self.gap(
                        format!(
                            "role {}: label is not in the analysis tables (PR5 labels); emitting the identity without it",
                            symbol.canonical,
                        ),
                        symbol.span,
                    );
                }
                IrItemKind::Role { label }
            }
            SymbolKind::Capability { ops, events } => {
                let version = self
                    .program
                    .effects
                    .capabilities
                    .get(&symbol.id)
                    .and_then(|data| data.version);
                if !self.program.effects.capabilities.contains_key(&symbol.id) {
                    self.gap(
                        format!(
                            "capability {}: version, events and operation signatures are not in the analysis tables (PR5 effects); emitting the signature without them",
                            symbol.canonical,
                        ),
                        symbol.span,
                    );
                }
                IrItemKind::Capability {
                    ops: ops.clone(),
                    events: events.clone(),
                    version,
                }
            }
            SymbolKind::CapabilityOp { params, .. } => {
                // Capability-op results are always declared; a missing
                // `symbol_results` row is a gap.
                let result = match self.program.types.symbol_results.get(&symbol.id) {
                    Some(Some(ty)) => IrType::Known(ty.clone()),
                    Some(None) => IrType::Known(ResolvedType::Unknown),
                    None => {
                        self.gap(
                            format!(
                                "capability operation {}: result type is not published in the analysis type table; emitting a placeholder schema",
                                symbol.canonical,
                            ),
                            symbol.span,
                        );
                        IrType::Unknown
                    }
                };
                IrItemKind::CapabilityOp {
                    params: params.clone(),
                    result,
                }
            }
            SymbolKind::Message { params } => {
                let descriptor = self
                    .program
                    .effects
                    .messages
                    .get(&symbol.id)
                    .map(|data| self.decode_message_data(data));
                if descriptor.is_none() {
                    self.gap(
                        format!(
                            "message {}: source text, locale variants and parameter labels/defaults are not in the analysis tables (PR5 labels); omitting the descriptor",
                            symbol.canonical,
                        ),
                        symbol.span,
                    );
                }
                IrItemKind::Message {
                    params: params.clone(),
                    descriptor,
                }
            }
            SymbolKind::Fixture { target } => {
                let recipe = self.decode_fixture(symbol, target);
                IrItemKind::Fixture {
                    target: *target,
                    recipe,
                }
            }
            SymbolKind::Scenario {
                params,
                trusted,
                result_node,
            } => {
                let result = lookup_symbol_result(
                    self.program,
                    symbol,
                    result_node.is_some(),
                    &mut self.diags,
                );
                let (
                    read,
                    by,
                    label,
                    description,
                    expose_excluded,
                    guards,
                    effects,
                    hook,
                    cohort,
                    event_source,
                ) = self.decode_scenario(symbol);
                IrItemKind::Scenario {
                    params: params.clone(),
                    trusted: *trusted,
                    event_source,
                    hook,
                    cohort,
                    result,
                    read,
                    by,
                    label,
                    description,
                    expose_excluded,
                    guards,
                    effects,
                }
            }
            SymbolKind::Crud {
                model,
                create,
                update,
                delete,
            } => IrItemKind::Crud {
                model: *model,
                create: *create,
                update: *update,
                delete: *delete,
            },
            SymbolKind::CrudOp { model, op } => {
                let (by, has_when, fields, label, expose_excluded, delete_mode) =
                    self.decode_crud_op(symbol, *model, *op);
                IrItemKind::CrudOp {
                    model: *model,
                    op: *op,
                    by,
                    has_when,
                    fields,
                    label,
                    expose_excluded,
                    delete_mode,
                }
            }
            SymbolKind::Field { owner, .. } => {
                let (required_array, default, server, modifiers, label, description) =
                    self.decode_field(symbol, *owner);
                IrItemKind::Field {
                    owner: *owner,
                    ty: lookup_symbol_type(self.program, symbol, "declared type", &mut self.diags),
                    required_array,
                    default,
                    server,
                    modifiers,
                    label,
                    description,
                }
            }
            SymbolKind::Param { owner, index, .. } => {
                let (default, label, description) = self.decode_param(symbol, *owner);
                let choices = self
                    .program
                    .types
                    .input_choices
                    .get(&symbol.id)
                    .map(|choice| IrInputChoiceBinding {
                        read_operation: self.canonical(choice.read_operation),
                        arguments: choice
                            .arguments
                            .iter()
                            .map(|argument| {
                                (
                                    self.program.symbols[argument.parameter.0 as usize]
                                        .name
                                        .clone(),
                                    IrChoiceArgument {
                                        input: self.program.symbols[argument.input.0 as usize]
                                            .name
                                            .clone(),
                                        path: argument.path.clone(),
                                    },
                                )
                            })
                            .collect(),
                        value: match &choice.value {
                            crate::analysis::types::CheckedChoiceValue::Record => {
                                IrChoiceValue::Record
                            }
                            crate::analysis::types::CheckedChoiceValue::Field(field) => {
                                IrChoiceValue::Field(field.clone())
                            }
                        },
                        labels: choice.labels.clone(),
                    });
                IrItemKind::Param {
                    owner: *owner,
                    index: *index,
                    ty: lookup_symbol_type(self.program, symbol, "declared type", &mut self.diags),
                    default,
                    label,
                    description,
                    choices,
                }
            }
            SymbolKind::DeriveField { model, .. } => {
                let (expr, label) = self.decode_derive(symbol);
                IrItemKind::DeriveField {
                    model: *model,
                    ty: lookup_symbol_type(self.program, symbol, "declared type", &mut self.diags),
                    expr,
                    label,
                }
            }
            SymbolKind::DeriveFn { params, .. } => {
                let (expr, _) = self.decode_derive(symbol);
                // Derived-function results live in `symbol_results`
                // (declared `: type` spells the result); a missing row
                // is a gap.
                let result = match self.program.types.symbol_results.get(&symbol.id) {
                    Some(Some(ty)) => IrType::Known(ty.clone()),
                    Some(None) => IrType::Known(ResolvedType::Unknown),
                    None => {
                        self.gap(
                            format!(
                                "derived function {}: result type is not published in the analysis type table; emitting a placeholder schema",
                                symbol.canonical,
                            ),
                            symbol.span,
                        );
                        IrType::Unknown
                    }
                };
                IrItemKind::DeriveFn {
                    params: params.clone(),
                    result,
                    expr,
                }
            }
            SymbolKind::Preferences { fields } => {
                if !self.program.effects.records.contains_key(&symbol.id) {
                    self.gap(
                        format!(
                            "preferences {}: fields and invariants are not in the analysis tables (PR5 effects); emitting the typed schema without them",
                            symbol.canonical,
                        ),
                        symbol.span,
                    );
                }
                IrItemKind::Preferences {
                    fields: fields.clone(),
                    validate: self.preference_validators.get(&symbol.module).cloned(),
                }
            }
        }
    }
}

/// Decode scope: module plus example bindings.
///
/// `bindings` maps example input names (`record`, `expense`, ...) to the
/// fixture they are bound to. `row_rewrite` maps a query `as` alias to
/// `row` inside one anchored expression. `example_values` selects the
/// example-cell name fallback (unresolvable bare names are enum-case
/// text, never dangling identifiers).
#[derive(Debug, Clone)]
struct Scope {
    module: ModuleId,
    bindings: HashMap<String, SymbolId>,
    row_rewrite: HashMap<String, String>,
    example_values: bool,
    /// Declared operation result type, for `result` roots in tables.
    result_ty: Option<ResolvedType>,
    /// Sequence `let`/`as` bindings decoded so far: step content reads
    /// them from the immutable `b` scope (`b.name`).
    sequence_lets: HashSet<String>,
    /// Resolved types for scope-bound names the types pass never visits
    /// (query aliases, sequence bindings, test accounts). Consulted only
    /// when no published node type exists.
    name_types: HashMap<String, ResolvedType>,
    /// Whether UI decoding sits inside a field owner (`form`/`edit`):
    /// field-placement controls need one. Collections reset it (their
    /// scope ends field placement unless nested under another owner).
    in_field_owner: bool,
    /// Whether decoding sits inside a pre-commit hook body (T31 Rule A).
    /// Hooks do not receive the ambient operation context (`c`), and
    /// contextual values need an owning hook contract before lowering.
    in_hook: bool,
}

impl Scope {
    fn module(module: ModuleId) -> Self {
        Self {
            module,
            bindings: HashMap::new(),
            row_rewrite: HashMap::new(),
            example_values: false,
            result_ty: None,
            sequence_lets: HashSet::new(),
            name_types: HashMap::new(),
            in_field_owner: false,
            in_hook: false,
        }
    }
}

impl<'a> Cx<'a> {
    /// Message descriptor for a `MessageData` row (G7).
    fn decode_message_data(&self, data: &crate::analysis::effects::MessageData) -> IrMessage {
        IrMessage {
            source: data.source.clone(),
            variants: data
                .variants
                .iter()
                .map(|v| (v.locale.clone(), v.value.clone()))
                .collect(),
            params: Vec::new(),
        }
    }

    /// Decode a label/message value node: `MessageValue` text plus
    /// variants, or a `Path` message reference (inlined).
    fn decode_message_value(&mut self, module: ModuleId, key: &NodeKey) -> Option<IrMessage> {
        let node = self.node(key)?.clone();
        self.decode_message_node(module, &node)
    }

    /// Decode one message node (see [`Cx::decode_message_value`]).
    fn decode_message_node(&mut self, module: ModuleId, node: &SyntaxNode) -> Option<IrMessage> {
        match node.kind {
            // A bare literal is a valid authored caption (checker
            // accepts it), so it decodes to source-only text instead
            // of silently dropping the label.
            SyntaxKind::Literal => Some(IrMessage {
                source: literal_string(self.db, node)?,
                variants: Vec::new(),
                params: Vec::new(),
            }),
            SyntaxKind::MessageValue => {
                let mut source = None;
                let mut variants = Vec::new();
                for child in kids(node) {
                    match child.kind {
                        SyntaxKind::Literal => {
                            if source.is_none() {
                                source = Some(literal_string(self.db, child)?);
                            }
                        }
                        SyntaxKind::MessageVariant => {
                            if let Some((locale, value)) = self.decode_variant(child) {
                                variants.push((locale, value));
                            }
                        }
                        _ => {}
                    }
                }
                Some(IrMessage {
                    source: source?,
                    variants,
                    params: Vec::new(),
                })
            }
            SyntaxKind::Path => {
                let name = path_text(self.db, node);
                match self.resolve_member(module, &name) {
                    Some((id, _))
                        if matches!(
                            self.program.symbols.get(id.0 as usize).map(|s| &s.kind),
                            Some(SymbolKind::Message { .. })
                        ) =>
                    {
                        self.program
                            .effects
                            .messages
                            .get(&id)
                            .map(|data| self.decode_message_data(data))
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    }

    /// Decode one `locale=STRING|null` variant.
    fn decode_variant(&self, node: &SyntaxNode) -> Option<(String, Option<String>)> {
        let parts = kids(node);
        let locale = parts.first().and_then(|n| name_text(self.db, n))?;
        let literal = parts.iter().find(|n| n.kind == SyntaxKind::Literal)?;
        let value = literal_string_opt(self.db, literal)?;
        Some((locale, value))
    }

    /// Decode a field-label value: plain message or `{text, values}`.
    fn decode_field_label(&mut self, module: ModuleId, key: &NodeKey) -> Option<IrFieldLabel> {
        let node = self.node(key)?.clone();
        match node.kind {
            SyntaxKind::Label => {
                let mut text = None;
                let mut values = Vec::new();
                for child in kids(&node) {
                    match child.kind {
                        SyntaxKind::Literal | SyntaxKind::MessageValue | SyntaxKind::Path => {
                            if text.is_none() {
                                text = self.decode_message_node(module, child);
                            }
                        }
                        SyntaxKind::LabelCase => {
                            if let Some((case, caption)) = self.decode_label_case(module, child) {
                                values.push((case, caption));
                            }
                        }
                        _ => {}
                    }
                }
                text.map(|text| IrFieldLabel { text, values })
            }
            SyntaxKind::Literal | SyntaxKind::MessageValue | SyntaxKind::Path => self
                .decode_message_node(module, &node)
                .map(|text| IrFieldLabel {
                    text,
                    values: Vec::new(),
                }),
            _ => None,
        }
    }

    /// Decode one `case=caption` label case.
    fn decode_label_case(
        &mut self,
        module: ModuleId,
        node: &SyntaxNode,
    ) -> Option<(String, IrMessage)> {
        let parts = kids(node);
        let case = parts.first().and_then(|n| name_text(self.db, n))?;
        let caption = parts
            .iter()
            .find_map(|n| self.decode_message_node(module, n))?;
        Some((case, caption))
    }

    /// Checked type of an anchored node, from `node_types` (total).
    fn node_type(&self, node: &SyntaxNode) -> ResolvedType {
        let key = NodeKey::of(node);
        self.program
            .types
            .node_types
            .get(&key)
            .cloned()
            .unwrap_or(ResolvedType::Unknown)
    }

    /// Decode an anchored expression (total: missing anchors are `E6006`
    /// plus an unsupported placeholder).
    fn decode_anchored(&mut self, scope: &Scope, key: &NodeKey, what: &str) -> TypedExpr {
        let span = Span::new(key.file, key.start, key.end);
        match self.node(key).cloned() {
            Some(node) => self.decode_expr(scope, &node),
            None => {
                self.gap(
                    format!("{what} is not published in the analysis tables; emitting a throwing placeholder"),
                    span,
                );
                TypedExpr::new(
                    IrExpr::Unsupported {
                        what: what.to_string(),
                        why: "analysis did not publish the anchored node".to_string(),
                    },
                    ResolvedType::Unknown,
                    span,
                )
            }
        }
    }

    /// Decode one expression node (total).
    fn decode_expr(&mut self, scope: &Scope, node: &SyntaxNode) -> TypedExpr {
        let span = node.span;
        let mut ty = self.node_type(node);
        // Scope-bound names (query aliases, sequence bindings, test
        // accounts) carry their type when no table anchors the node.
        // The lookup follows the alias rewrite, so a rewritten alias
        // reads its lambda parameter's type.
        if matches!(ty, ResolvedType::Unknown)
            && node.kind == SyntaxKind::NameRef
            && let Some(name) = kids(node).iter().find_map(|n| name_text(self.db, n))
        {
            let target = scope.row_rewrite.get(&name).unwrap_or(&name);
            if let Some(bound) = scope.name_types.get(target) {
                ty = bound.clone();
            }
        }
        let expr = match node.kind {
            SyntaxKind::Literal => self.decode_literal(node),
            SyntaxKind::NameRef => self.decode_name_ref(scope, node, &ty),
            SyntaxKind::Group => {
                return match kids(node).iter().find(|n| is_expression(n.kind)) {
                    Some(inner) => self.decode_expr(scope, inner),
                    None => self.unsupported_expr("empty group", "no inner expression", ty, span),
                };
            }
            SyntaxKind::Array => IrExpr::Array(
                kids(node)
                    .iter()
                    .filter(|n| is_expression(n.kind))
                    .map(|n| self.decode_expr(scope, n))
                    .collect(),
            ),
            SyntaxKind::Object => self.decode_object(scope, node),
            SyntaxKind::Construct => self.decode_object(scope, node),
            SyntaxKind::Member => {
                return self.decode_member(scope, node, &ty);
            }
            SyntaxKind::Call => self.decode_call(scope, node, &ty),
            SyntaxKind::Unary => self.decode_unary(scope, node, &ty),
            SyntaxKind::Binary => self.decode_binary(scope, node, &ty),
            SyntaxKind::Query => self.decode_query(scope, node, &ty),
            SyntaxKind::Path => {
                // Paths in value position are single names (set/delete
                // targets, `by=` spellings handled by guards).
                let name = path_text(self.db, node);
                self.decode_bare_name(scope, &name, &ty, span)
            }
            _ => IrExpr::Unsupported {
                what: format!("{:?} expression", node.kind),
                why: "no §13 lowering exists".to_string(),
            },
        };
        // Table-derived types for scope slots the types pass never sees
        // (runner-typed example cells): `s` fixture slots take their
        // recipe target type.
        if matches!(ty, ResolvedType::Unknown)
            && let IrExpr::Member { base, field } = &expr
            && matches!(base.expr, IrExpr::Name(ref name) if name == "s")
            && let Some(id) = self.resolve_scope_fixture(scope, field)
        {
            ty = self.fixture_type(id);
        }
        if matches!(ty, ResolvedType::Unknown)
            && matches!(&expr, IrExpr::Name(name) if name == "result")
            && let Some(result) = scope.result_ty.clone()
        {
            ty = result;
        }
        // Closed literal rules when no table anchors the node (`Text`
        // stays untyped: string literals and enum spellings share it).
        if matches!(ty, ResolvedType::Unknown) {
            ty = match &expr {
                IrExpr::Int(_) => ResolvedType::Scalar(Scalar::Int),
                IrExpr::Decimal(_) => ResolvedType::Scalar(Scalar::Decimal),
                IrExpr::Bool(_) => ResolvedType::Scalar(Scalar::Bool),
                IrExpr::Null => ResolvedType::Null,
                IrExpr::Money { .. } => ResolvedType::Scalar(Scalar::Money),
                IrExpr::DurationMs(_) => ResolvedType::Scalar(Scalar::Duration),
                IrExpr::Date(_) => ResolvedType::Scalar(Scalar::Date),
                IrExpr::Datetime(_) => ResolvedType::Scalar(Scalar::Datetime),
                _ => ty,
            };
        }
        TypedExpr::new(expr, ty, span)
    }

    /// Resolve an `s` scope slot to its fixture (bindings first, then
    /// module fixtures).
    fn resolve_scope_fixture(&self, scope: &Scope, name: &str) -> Option<SymbolId> {
        if let Some(id) = scope
            .bindings
            .values()
            .find(|id| self.local_name(**id) == name)
        {
            return Some(*id);
        }
        self.fixture_in_scope(scope.module, name)
    }

    /// Inferred member type from a base type plus field: declared
    /// fields, reserved stored-row metadata (`id`/`version`/timestamps
    /// per the types pass), closed-object fields, and money parts.
    /// `Unknown` when no table serves the access.
    fn member_ty(&self, base: &ResolvedType, field: &str) -> ResolvedType {
        let mut ty = base;
        while let ResolvedType::Nullable(inner) = ty {
            ty = inner;
        }
        match ty {
            ResolvedType::Record { symbol, stored } => {
                if let Some(ty) = self
                    .fields
                    .get(&(*symbol, field.to_string()))
                    .and_then(|id| self.program.types.symbol_types.get(id))
                    .cloned()
                {
                    return ty;
                }
                let is_model = matches!(
                    self.program.symbols.get(symbol.0 as usize).map(|s| &s.kind),
                    Some(SymbolKind::Model { .. })
                );
                if is_model && *stored {
                    match field {
                        "id" => return ResolvedType::Scalar(Scalar::Text),
                        "version" => return ResolvedType::Scalar(Scalar::Int),
                        "created" | "updated" => {
                            return ResolvedType::Scalar(Scalar::Datetime);
                        }
                        "created_by" | "updated_by" => {
                            return ResolvedType::Scalar(Scalar::User);
                        }
                        "archived_at" => {
                            return ResolvedType::Nullable(Box::new(ResolvedType::Scalar(
                                Scalar::Datetime,
                            )));
                        }
                        _ => {}
                    }
                }
                ResolvedType::Unknown
            }
            ResolvedType::Object(fields) => fields
                .iter()
                .find(|(name, _)| name == field)
                .map(|(_, ty)| ty.clone())
                .unwrap_or(ResolvedType::Unknown),
            ResolvedType::Scalar(Scalar::Money) => match field {
                "minor" => ResolvedType::Scalar(Scalar::Int),
                "currency" => ResolvedType::Scalar(Scalar::Currency),
                _ => ResolvedType::Unknown,
            },
            _ => ResolvedType::Unknown,
        }
    }

    /// Placeholder expression plus its span (the lowering reports `E6008`).
    fn unsupported_expr(&self, what: &str, why: &str, ty: ResolvedType, span: Span) -> TypedExpr {
        TypedExpr::new(
            IrExpr::Unsupported {
                what: what.to_string(),
                why: why.to_string(),
            },
            ty,
            span,
        )
    }

    /// Decode a literal: int/decimal/text/bool/null/duration/bytes.
    fn decode_literal(&self, node: &SyntaxNode) -> IrExpr {
        let leaf = kids(node).into_iter().next();
        let Some(leaf) = leaf else {
            return IrExpr::Unsupported {
                what: "empty literal".to_string(),
                why: "no token".to_string(),
            };
        };
        let text = self.text(leaf.span);
        match leaf.kind {
            SyntaxKind::Integer => match text.parse::<i128>() {
                Ok(value) => IrExpr::Int(value),
                Err(_) => IrExpr::Unsupported {
                    what: "integer literal".to_string(),
                    why: format!("{text} does not parse as an integer"),
                },
            },
            SyntaxKind::Decimal => IrExpr::Decimal(text.to_string()),
            SyntaxKind::String => match leaf.token().and_then(|token| token.string_value.clone()) {
                Some(value) => IrExpr::Text(value),
                None => IrExpr::Unsupported {
                    what: "string literal".to_string(),
                    why: "no valid lexer payload".to_string(),
                },
            },
            SyntaxKind::Duration => match duration_millis(text) {
                Some(ms) => IrExpr::DurationMs(ms),
                None => IrExpr::Unsupported {
                    what: "duration literal".to_string(),
                    why: format!("{text} is not a duration"),
                },
            },
            SyntaxKind::Bytes => IrExpr::Unsupported {
                what: "byte literal".to_string(),
                why: "no §13 value lowering exists".to_string(),
            },
            SyntaxKind::Name => match text {
                "true" => IrExpr::Bool(true),
                "false" => IrExpr::Bool(false),
                "null" => IrExpr::Null,
                _ => IrExpr::Text(text.to_string()),
            },
            _ => IrExpr::Unsupported {
                what: "literal".to_string(),
                why: format!("{:?} has no lowering", leaf.kind),
            },
        }
    }

    /// Decode a `NameRef`: locals, context vars, table-resolved symbols,
    /// type-driven enum cases, or the scope fallback.
    fn decode_name_ref(&mut self, scope: &Scope, node: &SyntaxNode, ty: &ResolvedType) -> IrExpr {
        let name = kids(node)
            .iter()
            .find_map(|n| name_text(self.db, n))
            .unwrap_or_default();
        // Analysis owns enum-case claims, including spellings also used
        // by unrelated fields or fixed scope slots such as `b`.
        let key = NodeKey::of(node);
        if let Some(role) = self.program.types.role_references.get(&key) {
            return IrExpr::HasRole {
                role: self.canonical(*role),
                person: None,
            };
        }
        if self.program.types.resolved_cases.contains(&key) && is_enum_ty(ty) {
            return IrExpr::Text(name);
        }
        // Query-alias rewrite inside one anchored expression.
        if let Some(row) = scope.row_rewrite.get(&name) {
            return IrExpr::Name(row.clone());
        }
        // Sequence lets read the immutable `b` scope; the alias above
        // shadows them inside one query predicate.
        if scope.sequence_lets.contains(&name) {
            return member_of("b", &name, ty, node.span);
        }
        // Example input bindings rewrite to their fixture scope slot.
        if let Some(fixture) = scope.bindings.get(&name) {
            let fixture_name = self.local_name(*fixture);
            return member_of("s", &fixture_name, &self.fixture_type(*fixture), node.span);
        }
        if is_enum_ty(ty) && self.program.types.bound_names.contains(&key) {
            return IrExpr::Name(name);
        }
        // Fixture references resolve through the example tables.
        if let Some(id) = self.fixture_in_scope(scope.module, &name) {
            let fixture_name = self.local_name(id);
            return member_of("s", &fixture_name, &self.fixture_type(id), node.span);
        }
        // A checked lexical bool remains a value even when a module role
        // shares its spelling. Genuine role references were consumed above.
        if self.program.types.bound_names.contains(&key)
            && matches!(ty, ResolvedType::Scalar(Scalar::Bool))
        {
            return IrExpr::Name(name);
        }
        self.decode_bare_name(scope, &name, ty, node.span)
    }

    /// Decode a bare name after scope rewrites: context vars, symbols,
    /// enum cases, or the scope fallback.
    fn decode_bare_name(
        &mut self,
        scope: &Scope,
        name: &str,
        ty: &ResolvedType,
        span: Span,
    ) -> IrExpr {
        match name {
            "c" | "row" | "event" | "result" | "parent" | "preferences" | "s" | "b" => {
                return IrExpr::Name(name.to_string());
            }
            // The hook carrier does not implement the checked native
            // actor/now/team/operation types. Refuse these reads until
            // an owning contract supplies them; never emit unbound names
            // or reinterpret raw carrier strings/numbers as native values.
            "actor" | "now" | "team" | "operation" if scope.in_hook => {
                let why = "no owning hook context contract supplies the checked value";
                self.diags.push(Diagnostic::error(
                    "E6008",
                    format!("cannot lower hook contextual binding `{name}`: {why}"),
                    span,
                ));
                return IrExpr::Unsupported {
                    what: format!("hook contextual binding `{name}`"),
                    why: why.to_string(),
                };
            }
            "actor" => return member_of("c", "actor", ty, span),
            "now" => return member_of("c", "now", ty, span),
            "team" => return member_of("c", "team", ty, span),
            "operation" => return member_of("c", "operation", ty, span),
            _ => {}
        }
        if is_test_account(name) {
            return IrExpr::Name(name.to_string());
        }
        if is_predicate_spelling(name) {
            return IrExpr::Unsupported {
                what: format!("predicate spelling `{name}`"),
                why: "predicate spellings gate guards, they are not values".to_string(),
            };
        }
        if let Some((id, _)) = self.resolve_member(scope.module, name) {
            let symbol = self.program.symbols.get(id.0 as usize).cloned();
            match symbol.as_ref().map(|s| &s.kind) {
                Some(SymbolKind::Model { .. }) => {
                    // A bare model domain lowers through the shared
                    // query contract with no clauses.
                    return IrExpr::Query(IrQuery {
                        domain: IrQueryDomain::Model(self.canonical(id)),
                        parent: None,
                        where_pred: None,
                        where_async: false,
                        order: Vec::new(),
                        limit: None,
                        archived: None,
                        select: None,
                        select_param: None,
                    });
                }
                Some(SymbolKind::Message { .. }) => {
                    if let Some(data) = self.program.effects.messages.get(&id) {
                        return IrExpr::Message(self.decode_message_data(data));
                    }
                }
                Some(SymbolKind::Param { .. })
                | Some(SymbolKind::Field { .. })
                | Some(SymbolKind::DeriveField { .. })
                | Some(SymbolKind::Fixture { .. }) => {
                    return IrExpr::Name(name.to_string());
                }
                Some(_) => {
                    return IrExpr::Unsupported {
                        what: format!("reference to `{name}`"),
                        why: "no §13 value lowering exists".to_string(),
                    };
                }
                None => {}
            }
        }
        // Type-driven enum cases (typed regions): the checked type says
        // what the spelling denotes.
        if is_enum_ty(ty) {
            return IrExpr::Text(name.to_string());
        }
        if scope.example_values {
            // Runner-typed cells: unresolvable bare names are enum-case
            // spellings (analysis owns typos via `E5xxx`).
            return IrExpr::Text(name.to_string());
        }
        IrExpr::Name(name.to_string())
    }

    /// Fixture symbol for `name` visible in `module` (tables only).
    fn fixture_in_scope(&self, module: ModuleId, name: &str) -> Option<SymbolId> {
        let (id, _) = self.resolve_member(module, name)?;
        match self.program.symbols.get(id.0 as usize).map(|s| &s.kind) {
            Some(SymbolKind::Fixture { .. }) => Some(id),
            _ => None,
        }
    }

    /// Declared type of a fixture reference, from its recipe target.
    fn fixture_type(&self, id: SymbolId) -> ResolvedType {
        let target = self
            .program
            .symbols
            .get(id.0 as usize)
            .and_then(|s| match &s.kind {
                SymbolKind::Fixture { target } => Some(*target),
                _ => None,
            });
        match target {
            Some(FixtureTarget::Model(model)) => ResolvedType::Record {
                symbol: model,
                stored: true,
            },
            Some(FixtureTarget::User) => ResolvedType::Scalar(Scalar::User),
            Some(FixtureTarget::File) => ResolvedType::Scalar(Scalar::File),
            _ => ResolvedType::Unknown,
        }
    }
}

/// `base.field` member expression with `ty`.
fn member_of(base: &str, field: &str, _ty: &ResolvedType, span: Span) -> IrExpr {
    IrExpr::Member {
        base: Box::new(TypedExpr::new(
            IrExpr::Name(base.to_string()),
            ResolvedType::Unknown,
            span,
        )),
        field: field.to_string(),
    }
}

/// Whether `ty` is a delivery handle (possibly nullable): bound
/// local operations and T14c typed `std` receipts alike.
fn is_delivery_ty(ty: &ResolvedType) -> bool {
    match ty {
        ResolvedType::Delivery { .. } | ResolvedType::StdDelivery { .. } => true,
        ResolvedType::Nullable(inner) => is_delivery_ty(inner),
        _ => false,
    }
}

/// Whether `ty` is an enum (possibly nullable).
fn is_enum_ty(ty: &ResolvedType) -> bool {
    match ty {
        ResolvedType::Enum { .. } => true,
        ResolvedType::Nullable(inner) => is_enum_ty(inner),
        _ => false,
    }
}

/// Only static identifier paths may become constructor target data.
/// Operation-typed composites retain ordinary lowering so value computation
/// (including throwing predicates and object members) is never discarded.
fn static_operation_reference(node: &SyntaxNode) -> bool {
    match node.kind {
        SyntaxKind::NameRef => true,
        SyntaxKind::Member => {
            let expressions: Vec<_> = kids(node)
                .into_iter()
                .filter(|child| is_expression(child.kind))
                .collect();
            expressions.len() == 1 && static_operation_reference(expressions[0])
        }
        _ => false,
    }
}

/// Whether `kind` can appear as an expression child.
fn is_expression(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::Literal
            | SyntaxKind::NameRef
            | SyntaxKind::Group
            | SyntaxKind::Array
            | SyntaxKind::Object
            | SyntaxKind::Construct
            | SyntaxKind::Member
            | SyntaxKind::Argument
            | SyntaxKind::Unary
            | SyntaxKind::Binary
            | SyntaxKind::Query
            | SyntaxKind::Call
            | SyntaxKind::Path
    )
}

/// Significant `Name` leaf text.
fn name_text(db: &SourceDb, node: &SyntaxNode) -> Option<String> {
    if node.kind == SyntaxKind::Name {
        Some(slice(db, node.span).to_string())
    } else {
        None
    }
}

/// Dotted path spelling (`a`, `a.b`).
fn path_text(db: &SourceDb, node: &SyntaxNode) -> String {
    kids(node)
        .iter()
        .filter_map(|n| name_text(db, n))
        .collect::<Vec<_>>()
        .join(".")
}

/// Lexer-owned string value: `Some(None)` is authored `null`, while
/// missing/invalid payloads and non-string literals return `None`.
fn literal_string_opt(db: &SourceDb, node: &SyntaxNode) -> Option<Option<String>> {
    if node.kind != SyntaxKind::Literal {
        return None;
    }
    let leaf = kids(node).into_iter().next()?;
    match leaf.kind {
        SyntaxKind::String => leaf.token()?.string_value.clone().map(Some),
        SyntaxKind::Name if slice(db, leaf.span) == "null" => Some(None),
        _ => None,
    }
}

/// String value of a `Literal` string (total: non-strings yield `None`).
fn literal_string(db: &SourceDb, node: &SyntaxNode) -> Option<String> {
    literal_string_opt(db, node).flatten()
}

impl<'a> Cx<'a> {
    /// Decode an object/construct value: entries in source order
    /// (shorthand entries read the in-scope binding of the key).
    /// Constructs wrap their entries in a nested `Object` node.
    fn decode_object(&mut self, scope: &Scope, node: &SyntaxNode) -> IrExpr {
        let mut entries = Vec::new();
        if node.kind == SyntaxKind::Construct
            && let Some(object) = kids(node).iter().find(|n| n.kind == SyntaxKind::Object)
        {
            return self.decode_object(scope, object);
        }
        for child in kids(node) {
            if child.kind != SyntaxKind::ObjectEntry {
                continue;
            }
            let parts = kids(child);
            let Some(key) = parts.first().and_then(|n| name_text(self.db, n)) else {
                continue;
            };
            let value = parts
                .iter()
                .find(|n| is_expression(n.kind) && n.kind != SyntaxKind::Argument)
                .map(|n| self.decode_expr(scope, n))
                .unwrap_or_else(|| {
                    TypedExpr::new(IrExpr::Name(key.clone()), ResolvedType::Unknown, child.span)
                });
            entries.push((key, value));
        }
        IrExpr::Object(entries)
    }

    /// Decode member access, wrapping delivery-typed bases in the sole
    /// observation helper shape (`DeliveryRead`).
    fn decode_member(&mut self, scope: &Scope, node: &SyntaxNode, ty: &ResolvedType) -> TypedExpr {
        if let Some((child, parent)) = self.contained_collection_head(node) {
            let parent = self.decode_expr(scope, parent);
            return TypedExpr::new(
                IrExpr::Query(IrQuery {
                    domain: IrQueryDomain::Model(self.canonical(child)),
                    parent: Some(Box::new(parent)),
                    where_pred: None,
                    where_async: false,
                    order: Vec::new(),
                    limit: None,
                    archived: None,
                    select: None,
                    select_param: None,
                }),
                ty.clone(),
                node.span,
            );
        }
        // Collect the outer chain: `a.b.c` decodes inside-out, but a
        // delivery crossing wraps once with the full static prop list.
        // Returns the typed expression: the checked type wins, table
        // inference fills gaps the types pass never sees.
        let mut fields = Vec::new();
        let mut current = node;
        loop {
            let parts = kids(current);
            let field = parts
                .iter()
                .rev()
                .find_map(|n| name_text(self.db, n))
                .unwrap_or_default();
            fields.push(field);
            let Some(base) = parts.iter().find(|n| is_expression(n.kind)) else {
                break;
            };
            if base.kind != SyntaxKind::Member {
                // A delivery-typed non-member base has no provenance to
                // resolve (only `record.field` crossings lower).
                let base_ty = self.node_type(base);
                if is_delivery_ty(&base_ty) {
                    return self.unsupported_expr(
                        "delivery read",
                        "owning record/field provenance is not resolvable",
                        ty.clone(),
                        node.span,
                    );
                }
                let mut expr = self.decode_expr(scope, base);
                // Only checked contextual actor facts use the private
                // facts carrier. Ordinary user values and aliases retain
                // their native identity shape and checker restrictions.
                // Group decoding preserves the same contextual IR root;
                // its synthetic `c` has Unknown type, unlike a typed local.
                if !scope.in_hook
                    && fields.len() == 1
                    && matches!(
                        (fields[0].as_str(), ty),
                        ("email", ResolvedType::Scalar(Scalar::Email))
                            | ("email_verified", ResolvedType::Scalar(Scalar::Bool))
                    )
                    && matches!(&expr.expr,
                        IrExpr::Member { base, field }
                            if field == "actor"
                                && matches!(&base.expr, IrExpr::Name(name) if name == "c")
                                && matches!(base.ty, ResolvedType::Unknown))
                {
                    expr.expr = member_of("c", "actorFacts", &ResolvedType::Unknown, base.span);
                }
                for field in fields.iter().rev() {
                    let inferred = self.member_ty(&expr.ty, field);
                    let field_ty = if *field == fields[0] && !matches!(ty, ResolvedType::Unknown) {
                        ty.clone()
                    } else if !matches!(inferred, ResolvedType::Unknown) {
                        inferred
                    } else if *field == fields[0] {
                        ty.clone()
                    } else {
                        ResolvedType::Unknown
                    };
                    expr = TypedExpr::new(
                        IrExpr::Member {
                            base: Box::new(expr),
                            field: field.clone(),
                        },
                        field_ty,
                        node.span,
                    );
                }
                return expr;
            }
            // Nested member: is the inner member delivery-typed?
            let inner_ty = self.node_type(base);
            if is_delivery_ty(&inner_ty) {
                if crate::analysis::types::delivery_progress_alias(&inner_ty)
                    && fields.last().is_some_and(|field| field == "progress")
                {
                    let observed = TypedExpr::new(
                        self.decode_delivery_read(scope, base, fields, node.span),
                        ty.clone(),
                        node.span,
                    );
                    let observed = if ty.nullable_inner().is_some() {
                        TypedExpr::new(
                            IrExpr::Binary {
                                op: IrBinOp::Coalesce,
                                left: Box::new(observed),
                                right: Box::new(TypedExpr::new(
                                    IrExpr::Null,
                                    ResolvedType::Null,
                                    node.span,
                                )),
                            },
                            ty.clone(),
                            node.span,
                        )
                    } else {
                        observed
                    };
                    return observed;
                }
                return TypedExpr::new(
                    self.decode_delivery_read(scope, base, fields, node.span),
                    ty.clone(),
                    node.span,
                );
            }
            current = base;
        }
        self.unsupported_expr("member access", "no base expression", ty.clone(), node.span)
    }

    /// Decode a delivery observation: `record.field.props...` with
    /// compiler-resolved provenance plus the static prop list.
    fn decode_delivery_read(
        &mut self,
        scope: &Scope,
        base: &SyntaxNode,
        mut outer_fields: Vec<String>,
        span: Span,
    ) -> IrExpr {
        // `base` is `record.field` with a delivery-typed value.
        let parts = kids(base);
        let field = parts
            .iter()
            .rev()
            .find_map(|n| name_text(self.db, n))
            .unwrap_or_default();
        let record = parts
            .iter()
            .find(|n| is_expression(n.kind))
            .map(|n| self.decode_expr(scope, n))
            .unwrap_or_else(|| {
                TypedExpr::new(IrExpr::Name("row".to_string()), ResolvedType::Unknown, span)
            });
        outer_fields.reverse();
        if super::super::analysis::types::delivery_progress_alias(&self.node_type(base))
            && outer_fields
                .first()
                .is_some_and(|field| field == "progress")
        {
            outer_fields[0] = "result".to_string();
        }
        IrExpr::DeliveryRead {
            record: Box::new(record),
            field,
            props: outer_fields,
        }
    }

    /// Consume the checker-selected target and slots. CST supplies content,
    /// never a second overload choice or argument-name binding.
    fn decode_call(&mut self, scope: &Scope, node: &SyntaxNode, _ty: &ResolvedType) -> IrExpr {
        let Some(selected) = self
            .program
            .types
            .selected_calls
            .get(&NodeKey::of(node))
            .cloned()
        else {
            return IrExpr::Unsupported {
                what: "call".to_string(),
                why: "checked selected-call binding is not published".to_string(),
            };
        };
        let bad_binding = || IrExpr::Unsupported {
            what: "call".to_string(),
            why: "checked selected-call slots do not match their owning target".to_string(),
        };
        let supplied: Vec<_> = selected.slots.iter().flatten().copied().collect();
        if supplied.len() != selected.arguments.len()
            || supplied
                .iter()
                .any(|&slot| slot >= selected.arguments.len())
            || supplied.iter().copied().collect::<HashSet<_>>().len() != supplied.len()
            || selected
                .arguments
                .iter()
                .any(|key| self.node(key).is_none())
        {
            return bad_binding();
        }
        match selected.target {
            SelectedCallTarget::Builtin { id, overload } => {
                let Some(entry) = self.catalog.and_then(|catalog| catalog.lookup(&id)) else {
                    return bad_binding();
                };
                let Some(signature) = self
                    .catalog
                    .and_then(|catalog| catalog.overloads(&id))
                    .and_then(|overloads| overloads.get(overload))
                else {
                    return bad_binding();
                };
                if signature.params.len() != selected.slots.len()
                    || selected.slots.iter().any(Option::is_none)
                {
                    return bad_binding();
                }
                if id == "format"
                    && signature
                        .params
                        .first()
                        .is_some_and(|p| p.name == "descriptor")
                {
                    if signature.params.len() != 2 || signature.params[1].name != "locale" {
                        return IrExpr::Unsupported {
                            what: "localized format call".to_string(),
                            why: "checked signature must supply descriptor and locale".to_string(),
                        };
                    }
                    return self.decode_format_call(
                        scope,
                        &selected.arguments,
                        selected.slots[0].expect("checked supplied descriptor"),
                        selected.slots[1].expect("checked supplied locale"),
                        node.span,
                    );
                }
                let awaited = entry.effects == Some(Effects::StateRead);
                self.builtins_seen.push(ReferencedBuiltin {
                    id: id.clone(),
                    span: node.span,
                });
                self.g13_seen.insert(id.clone());
                let args = selected
                    .arguments
                    .iter()
                    .enumerate()
                    .map(|(source, key)| {
                        if matches!(id.as_str(), "any" | "all")
                            && let Some(marker) = signature
                                .params
                                .iter()
                                .zip(&selected.slots)
                                .find(|(_, slot)| **slot == Some(source))
                                .and_then(|(param, _)| param.in_scope.as_ref())
                        {
                            let Some(domain) = signature
                                .params
                                .iter()
                                .zip(&selected.slots)
                                .find(|(param, _)| param.alias.as_ref() == Some(marker))
                                .and_then(|(_, slot)| *slot)
                                .and_then(|slot| self.node(&selected.arguments[slot]))
                            else {
                                return TypedExpr::new(
                                    IrExpr::Unsupported {
                                        what: "scoped predicate".to_string(),
                                        why: "checked predicate domain is missing".to_string(),
                                    },
                                    ResolvedType::Unknown,
                                    Span::new(key.file, key.start, key.end),
                                );
                            };
                            let alias = call_domain_alias(self.db, domain);
                            let param = alias.clone().unwrap_or_else(|| "row".to_string());
                            let mut inner = scope.clone();
                            if let Some(alias) = alias {
                                inner.row_rewrite.insert(alias.clone(), alias.clone());
                                inner
                                    .name_types
                                    .insert(alias, query_element_ty(&self.node_type(domain)));
                            }
                            let body = self.decode_anchored(&inner, key, "scoped predicate");
                            let ty = body.ty.clone();
                            let span = body.span;
                            let expr = if expr_uses_async(&body) {
                                IrExpr::Unsupported {
                                    what: "scoped predicate".to_string(),
                                    why: "Values any/all require a synchronous predicate"
                                        .to_string(),
                                }
                            } else {
                                IrExpr::Lambda {
                                    param,
                                    body: Box::new(body),
                                }
                            };
                            return TypedExpr::new(expr, ty, span);
                        }
                        // Operation identities are constructor data only at the
                        // checked action/invocation target formal. Keep source
                        // order and the checker's named-argument slot mapping;
                        // other positions retain ordinary value lowering.
                        let target =
                            matches!(id.as_str(), "action" | "invocation")
                                && signature.params.iter().zip(&selected.slots).any(
                                    |(param, slot)| {
                                        matches!(param.ty, SigType::ActionTarget)
                                            && *slot == Some(source)
                                    },
                                );
                        if target
                            && let Some(ResolvedType::Operation(operation)) =
                                self.program.types.node_types.get(key)
                            && self.node(key).is_some_and(static_operation_reference)
                            && let Some(symbol) = self.program.symbols.get(operation.0 as usize)
                        {
                            return TypedExpr::new(
                                IrExpr::Text(symbol.canonical.clone()),
                                ResolvedType::Scalar(Scalar::Text),
                                Span::new(key.file, key.start, key.end),
                            );
                        }
                        self.decode_anchored(scope, key, "call argument")
                    })
                    .collect();
                Self::selected_call_expr(
                    IrCallTarget::Builtin { id, awaited },
                    args,
                    selected.slots,
                )
            }
            SelectedCallTarget::DeriveFn(id) => {
                let Some(SymbolKind::DeriveFn { params, .. }) =
                    self.program.symbols.get(id.0 as usize).map(|s| &s.kind)
                else {
                    return bad_binding();
                };
                if params.len() != selected.slots.len() {
                    return bad_binding();
                }
                for (param, slot) in params.iter().zip(&selected.slots) {
                    if slot.is_none()
                        && self
                            .param_data(id, *param)
                            .and_then(|p| p.default)
                            .is_none()
                    {
                        return bad_binding();
                    }
                }
                let args = selected
                    .arguments
                    .iter()
                    .map(|key| self.decode_anchored(scope, key, "call argument"))
                    .collect();
                Self::selected_call_expr(
                    IrCallTarget::DeriveFn(self.canonical(id)),
                    args,
                    selected.slots,
                )
            }
            SelectedCallTarget::Message(id) => {
                let Some(data) = self.program.effects.messages.get(&id).cloned() else {
                    return bad_binding();
                };
                if data.params.len() != selected.slots.len() {
                    return bad_binding();
                }
                let args: Vec<_> = selected
                    .arguments
                    .iter()
                    .map(|key| self.decode_anchored(scope, key, "message argument"))
                    .collect();
                let mut descriptor = self.decode_message_data(&data);
                let direct = selected
                    .slots
                    .iter()
                    .enumerate()
                    .all(|(i, slot)| *slot == Some(i));
                let mut params = Vec::new();
                for (param, source) in data.params.iter().zip(selected.slots) {
                    let name = self.local_name(param.param);
                    let type_id = self
                        .program
                        .types
                        .symbol_types
                        .get(&param.param)
                        .map(|ty| self.type_id(ty))
                        .unwrap_or_else(|| "unknown".to_string());
                    let default = if source.is_none() {
                        let Some(key) = &param.default else {
                            return bad_binding();
                        };
                        Some(self.decode_anchored(
                            &Scope::module(data.module),
                            key,
                            "message parameter default",
                        ))
                    } else {
                        None
                    };
                    if direct {
                        descriptor.params.push(IrMessageParam {
                            name,
                            type_id,
                            value: args[source.expect("direct slots")].clone(),
                        });
                    } else {
                        params.push(IrMessageCallParam {
                            name,
                            type_id,
                            source,
                            default,
                        });
                    }
                }
                if direct {
                    IrExpr::Message(descriptor)
                } else {
                    IrExpr::MessageCall {
                        descriptor,
                        args,
                        params,
                    }
                }
            }
            SelectedCallTarget::Role(id) => {
                if !matches!(
                    self.program.symbols.get(id.0 as usize).map(|s| &s.kind),
                    Some(SymbolKind::Role)
                ) || selected.slots != [Some(0)]
                {
                    return bad_binding();
                }
                IrExpr::HasRole {
                    role: self.canonical(id),
                    person: Some(Box::new(self.decode_anchored(
                        scope,
                        &selected.arguments[0],
                        "role argument",
                    ))),
                }
            }
        }
    }

    fn selected_call_expr(
        target: IrCallTarget,
        args: Vec<TypedExpr>,
        slots: Vec<Option<usize>>,
    ) -> IrExpr {
        if slots.len() == args.len() && slots.iter().enumerate().all(|(i, slot)| *slot == Some(i)) {
            IrExpr::Call { target, args }
        } else {
            IrExpr::BoundCall {
                target,
                args,
                slots,
            }
        }
    }

    /// Consume the localized overload's checked slots and descriptor owner.
    fn decode_format_call(
        &mut self,
        scope: &Scope,
        arguments: &[NodeKey],
        descriptor_index: usize,
        locale_index: usize,
        span: Span,
    ) -> IrExpr {
        self.builtins_seen.push(ReferencedBuiltin {
            id: "format".to_string(),
            span,
        });
        self.g13_seen.insert("format".to_string());
        let unsupported = |why: &str| IrExpr::Unsupported {
            what: "localized format call".to_string(),
            why: why.to_string(),
        };
        let Some(mut descriptor_node) = self.node(&arguments[descriptor_index]).cloned() else {
            return unsupported("checked descriptor anchor is unavailable");
        };
        while descriptor_node.kind == SyntaxKind::Group {
            let Some(inner) = kids(&descriptor_node)
                .iter()
                .find(|n| is_expression(n.kind))
                .map(|n| (**n).clone())
            else {
                return unsupported("checked descriptor group has no value");
            };
            descriptor_node = inner;
        }
        // Inline descriptors have no declared parameters. Their syntax supplies
        // text only; the owning checked module supplies source language.
        let inline = descriptor_node.kind == SyntaxKind::MessageValue;
        let args: Vec<_> = arguments
            .iter()
            .enumerate()
            .map(|(index, key)| {
                if index == descriptor_index && inline {
                    let expr = self
                        .decode_message_node(scope.module, &descriptor_node)
                        .map(IrExpr::Message)
                        .unwrap_or_else(|| unsupported("inline descriptor text is unavailable"));
                    TypedExpr::new(expr, self.node_type(&descriptor_node), descriptor_node.span)
                } else {
                    self.decode_anchored(scope, key, "format argument")
                }
            })
            .collect();
        let (source_lang, param_types) = match &args[descriptor_index].ty {
            ResolvedType::Message(id) => {
                let Some(data) = self.program.effects.messages.get(id) else {
                    return unsupported("checked message owner is unavailable");
                };
                let mut params = Vec::new();
                for param in &data.params {
                    let Some(ty) = self.program.types.symbol_types.get(&param.param) else {
                        return unsupported("checked message parameter type is unavailable");
                    };
                    let Some(tag) = Self::format_param_tag(ty) else {
                        return unsupported(
                            "checked message parameter type has no Values presentation tag",
                        );
                    };
                    params.push((
                        self.local_name(param.param),
                        self.type_id(ty),
                        tag.to_string(),
                    ));
                }
                (data.source_lang.clone(), params)
            }
            ResolvedType::Scalar(Scalar::Text) if inline => {
                let Some(module) = self.program.effects.modules.get(&scope.module) else {
                    return unsupported("checked inline descriptor module is unavailable");
                };
                (module.source_lang.clone(), Vec::new())
            }
            _ => return unsupported("descriptor has no checked message owner or inline schema"),
        };
        IrExpr::Format {
            args,
            descriptor_index,
            locale_index,
            source_lang,
            param_types,
        }
    }

    /// Mechanical presentation mapping from checked types; nullable and
    /// structural shapes remain unsupported rather than guessing a tag.
    fn format_param_tag(ty: &ResolvedType) -> Option<&'static str> {
        match ty {
            ResolvedType::Scalar(
                Scalar::Text
                | Scalar::Email
                | Scalar::Url
                | Scalar::Locale
                | Scalar::Timezone
                | Scalar::Currency,
            ) => Some("text"),
            ResolvedType::Scalar(Scalar::Bool) => Some("bool"),
            ResolvedType::Enum { owner: Some(_), .. } => Some("enum"),
            ResolvedType::Scalar(Scalar::Int) => Some("int"),
            ResolvedType::Scalar(Scalar::Decimal) => Some("decimal"),
            ResolvedType::Scalar(Scalar::Money) => Some("money"),
            ResolvedType::Scalar(Scalar::Date) => Some("date"),
            ResolvedType::Scalar(Scalar::Datetime) => Some("datetime"),
            _ => None,
        }
    }

    /// Canonical type id for a resolved type (best-effort, total: unknown
    /// shapes yield `unknown` rather than failing the build).
    fn type_id(&self, ty: &ResolvedType) -> String {
        match ty {
            ResolvedType::Scalar(scalar) => scalar.as_str().to_string(),
            ResolvedType::Team => "Team".to_string(),
            ResolvedType::OperationContext => "OperationContext".to_string(),
            ResolvedType::Null => "null".to_string(),
            ResolvedType::Enum {
                owner: Some(id), ..
            } => self.canonical(*id),
            ResolvedType::Record { symbol, .. }
            | ResolvedType::Message(symbol)
            | ResolvedType::Operation(symbol) => self.canonical(*symbol),
            ResolvedType::Array { element, .. } => format!("{}[]", self.type_id(element)),
            ResolvedType::Nullable(inner) => format!("{}?", self.type_id(inner)),
            ResolvedType::Union(arms) => arms
                .iter()
                .map(|id| self.canonical(*id))
                .collect::<Vec<_>>()
                .join("|"),
            _ => "unknown".to_string(),
        }
    }

    /// Decode a unary operator (`not`, `-`).
    fn decode_unary(&mut self, scope: &Scope, node: &SyntaxNode, ty: &ResolvedType) -> IrExpr {
        let parts = kids(node);
        let op = parts.iter().find_map(|n| match n.kind {
            SyntaxKind::Name | SyntaxKind::Punct => Some(self.text(n.span)),
            _ => None,
        });
        let operand = parts.iter().find(|n| is_expression(n.kind));
        let (Some(op), Some(operand)) = (op, operand) else {
            return IrExpr::Unsupported {
                what: "unary operator".to_string(),
                why: "missing operator or operand".to_string(),
            };
        };
        let op = match op {
            "not" => IrUnOp::Not,
            "-" => IrUnOp::Neg,
            _ => {
                return IrExpr::Unsupported {
                    what: format!("unary operator `{op}`"),
                    why: "no §13 lowering exists".to_string(),
                };
            }
        };
        let _ = ty;
        IrExpr::Unary {
            op,
            operand: Box::new(self.decode_expr(scope, operand)),
        }
    }

    /// Decode a binary operator (comparison, logic, arithmetic, `in`).
    fn decode_binary(&mut self, scope: &Scope, node: &SyntaxNode, _ty: &ResolvedType) -> IrExpr {
        enum Work<'n> {
            Eval(&'n SyntaxNode),
            Finish(&'n SyntaxNode, IrBinOp),
        }
        let mut work = vec![Work::Eval(node)];
        let mut values = Vec::new();
        while let Some(step) = work.pop() {
            let current = match step {
                Work::Finish(current, op) => {
                    let right = values.pop().expect("binary right operand");
                    let left = values.pop().expect("binary left operand");
                    values.push(TypedExpr::new(
                        IrExpr::Binary {
                            op,
                            left: Box::new(left),
                            right: Box::new(right),
                        },
                        self.node_type(current),
                        current.span,
                    ));
                    continue;
                }
                Work::Eval(current) => current,
            };
            if current.kind != SyntaxKind::Binary {
                values.push(self.decode_expr(scope, current));
                continue;
            }
            let parts = kids(current);
            let mut operands = parts.iter().filter(|n| is_expression(n.kind));
            let (left, right) = (operands.next(), operands.next());
            let op = parts.iter().find_map(|n| match n.kind {
                SyntaxKind::Name | SyntaxKind::Punct => Some(self.text(n.span)),
                _ => None,
            });
            let (Some(left), Some(right), Some(op)) = (left, right, op) else {
                values.push(self.unsupported_expr(
                    "binary operator",
                    "missing operands or operator",
                    self.node_type(current),
                    current.span,
                ));
                continue;
            };
            let op = match op {
                "+" => IrBinOp::Add,
                "-" => IrBinOp::Sub,
                "*" => IrBinOp::Mul,
                "/" => IrBinOp::Div,
                "%" => IrBinOp::Mod,
                "==" => IrBinOp::Eq,
                "!=" => IrBinOp::Ne,
                "<" => IrBinOp::Lt,
                "<=" => IrBinOp::Le,
                ">" => IrBinOp::Gt,
                ">=" => IrBinOp::Ge,
                "and" => IrBinOp::And,
                "or" => IrBinOp::Or,
                "??" => IrBinOp::Coalesce,
                "in" => IrBinOp::In,
                _ => {
                    values.push(TypedExpr::new(
                        IrExpr::Unsupported {
                            what: format!("binary operator `{op}`"),
                            why: "no §13 lowering exists".to_string(),
                        },
                        self.node_type(current),
                        current.span,
                    ));
                    continue;
                }
            };
            work.push(Work::Finish(current, op));
            work.push(Work::Eval(right));
            work.push(Work::Eval(left));
        }
        values.pop().expect("binary expression result").expr
    }

    /// Decode a query: model domains lower through `records()` with
    /// `as`/`where`/`order`/`limit`/`archived` clauses; value domains
    /// lower through array combinators (`.filter`/`.map`) with `as`/
    /// `where`/`select`. `select` projections append one alias-scoped
    /// `.map` on either domain. Value `order`/`limit`/`archived` and
    /// async value predicates/projections have no lowering and stay loud.
    fn decode_query(&mut self, scope: &Scope, node: &SyntaxNode, ty: &ResolvedType) -> IrExpr {
        let parts = kids(node);
        let head = parts.iter().find(|n| is_expression(n.kind)).copied();
        let Some(head) = head else {
            return IrExpr::Unsupported {
                what: "query".to_string(),
                why: "no domain".to_string(),
            };
        };
        // A model head lowers through `records(c, model, ...)`; any other
        // head lowers as an in-memory value.
        let containment = self.contained_collection_head(head);
        let parent = containment.map(|(_, base)| Box::new(self.decode_expr(scope, base)));
        let model_id = self
            .collection_head_model(scope.module, head)
            .or(containment.map(|(child, _)| child));
        let model = model_id.map(|id| self.canonical(id));
        let value_base = if model.is_none() {
            Some(self.decode_expr(scope, head))
        } else {
            None
        };
        let clauses: Vec<&SyntaxNode> = parts
            .iter()
            .filter(|n| n.kind == SyntaxKind::QueryClause)
            .copied()
            .collect();
        // The `as` alias binds every clause scope, wherever it appears.
        let mut alias: Option<String> = None;
        for clause in &clauses {
            let clause_parts = kids(clause);
            let keyword = clause_parts
                .iter()
                .find_map(|n| name_text(self.db, n))
                .unwrap_or_default();
            if keyword == "as" {
                alias = clause_parts
                    .iter()
                    .rev()
                    .find_map(|n| name_text(self.db, n));
            }
        }
        let mut where_pred = None;
        let mut where_async = false;
        let mut order = Vec::new();
        let mut limit = None;
        let mut archived = None;
        let mut select = None;
        let mut select_param = None;
        let value_domain = model.is_none();
        // Alias scope: model predicates rewrite the alias to `row` (the
        // `records()` lambda parameter); value lambdas bind the alias
        // itself, shadowing same-named fixtures/symbols either way. The
        // lambda parameter carries the item type for clause lowering.
        let mut inner = scope.clone();
        if let Some(alias) = &alias {
            let target = if value_domain {
                alias.clone()
            } else {
                "row".to_string()
            };
            inner.row_rewrite.insert(alias.clone(), target.clone());
            if value_domain {
                let element = value_base
                    .as_ref()
                    .map(|base| query_element_ty(&base.ty))
                    .unwrap_or(ResolvedType::Unknown);
                inner.name_types.insert(target, element);
            } else if let Some(id) = model_id {
                inner.name_types.insert(
                    target,
                    ResolvedType::Record {
                        symbol: id,
                        stored: true,
                    },
                );
            }
        } else if let Some(id) = model_id {
            // Clauses without `as` still read the default `row`.
            inner.name_types.insert(
                "row".to_string(),
                ResolvedType::Record {
                    symbol: id,
                    stored: true,
                },
            );
        }
        for clause in &clauses {
            let clause_parts = kids(clause);
            let keyword = clause_parts
                .iter()
                .find_map(|n| name_text(self.db, n))
                .unwrap_or_default();
            match keyword.as_str() {
                "as" => {}
                "where" => {
                    let pred_node = clause_parts.iter().find(|n| is_expression(n.kind)).copied();
                    if let Some(pred_node) = pred_node {
                        let pred = self.decode_expr(&inner, pred_node);
                        if value_domain && expr_uses_async(&pred) {
                            return IrExpr::Unsupported {
                                what: "value query predicate".to_string(),
                                why: "async predicates have no array lowering".to_string(),
                            };
                        }
                        where_async = expr_uses_async(&pred);
                        where_pred = Some(Box::new(pred));
                    }
                }
                "order" => {
                    if value_domain {
                        return IrExpr::Unsupported {
                            what: "value query order".to_string(),
                            why: "ordering has no array lowering".to_string(),
                        };
                    }
                    // Selector order only (`order=-created`); expression
                    // keys have no lowering.
                    let unsupported = clause_parts.iter().any(|n| {
                        matches!(
                            n.kind,
                            SyntaxKind::Binary
                                | SyntaxKind::Unary
                                | SyntaxKind::Call
                                | SyntaxKind::Member
                        )
                    });
                    if unsupported {
                        return IrExpr::Unsupported {
                            what: "expression query order".to_string(),
                            why: "no §13 lowering exists".to_string(),
                        };
                    }
                    for selector in clause_parts.iter().filter(|n| {
                        matches!(
                            n.kind,
                            SyntaxKind::Selectors | SyntaxKind::Path | SyntaxKind::Descending
                        )
                    }) {
                        order.extend(decode_order_selectors(self.db, selector));
                    }
                }
                "limit" => {
                    if value_domain {
                        return IrExpr::Unsupported {
                            what: "value query limit".to_string(),
                            why: "limits have no array lowering".to_string(),
                        };
                    }
                    if let Some(limit_node) =
                        clause_parts.iter().find(|n| is_expression(n.kind)).copied()
                    {
                        limit = Some(Box::new(self.decode_expr(scope, limit_node)));
                    }
                }
                "archived" => {
                    if value_domain {
                        return IrExpr::Unsupported {
                            what: "value query archived".to_string(),
                            why: "archived selectors have no array lowering".to_string(),
                        };
                    }
                    if let Some(archived_node) =
                        clause_parts.iter().find(|n| is_expression(n.kind)).copied()
                    {
                        archived = Some(Box::new(self.decode_expr(scope, archived_node)));
                    }
                }
                "select" => {
                    let proj_node = clause_parts.iter().find(|n| is_expression(n.kind)).copied();
                    let Some(proj_node) = proj_node else {
                        continue;
                    };
                    // The projection binds the alias itself (the `.map`
                    // parameter), never the model `row` rewrite that
                    // `where` clauses use.
                    let mut select_inner = scope.clone();
                    if let Some(alias) = &alias {
                        select_inner
                            .row_rewrite
                            .insert(alias.clone(), alias.clone());
                        if let Some(element) = select_element_ty(model_id, &value_base) {
                            select_inner.name_types.insert(alias.clone(), element);
                        }
                    }
                    let projection = self.decode_expr(&select_inner, proj_node);
                    if value_domain && expr_uses_async(&projection) {
                        return IrExpr::Unsupported {
                            what: "value query projection".to_string(),
                            why: "async projections have no array lowering".to_string(),
                        };
                    }
                    if !value_domain && expr_uses_async(&projection) {
                        return IrExpr::Unsupported {
                            what: "select query".to_string(),
                            why: "async projections have no records() lowering".to_string(),
                        };
                    }
                    select_param = Some(alias.clone().unwrap_or_else(|| "row".to_string()));
                    select = Some(Box::new(projection));
                }
                _ => {}
            }
        }
        let _ = ty;
        let domain = match model {
            Some(model) => IrQueryDomain::Model(model),
            None => IrQueryDomain::Value {
                base: Box::new(value_base.expect("value domain decodes its head")),
                alias: alias.unwrap_or_else(|| "row".to_string()),
            },
        };
        IrExpr::Query(IrQuery {
            domain,
            parent,
            where_pred,
            where_async,
            order,
            limit,
            archived,
            select,
            select_param,
        })
    }
}

/// Item type behind a `select` alias: the model record for model
/// domains, the base element for value domains.
fn select_element_ty(
    model_id: Option<SymbolId>,
    value_base: &Option<TypedExpr>,
) -> Option<ResolvedType> {
    if let Some(id) = model_id {
        return Some(ResolvedType::Record {
            symbol: id,
            stored: true,
        });
    }
    value_base.as_ref().map(|base| query_element_ty(&base.ty))
}

/// Item type of a value-query base: the array element, unwrapping
/// nullability; `Unknown` for anything else.
fn query_element_ty(ty: &ResolvedType) -> ResolvedType {
    let mut ty = ty;
    while let ResolvedType::Nullable(inner) = ty {
        ty = inner;
    }
    match ty {
        ResolvedType::Array { element, .. } => (**element).clone(),
        _ => ResolvedType::Unknown,
    }
}

/// The same top-level domain alias whose declaration scopes a checked predicate.
fn call_domain_alias(db: &SourceDb, node: &SyntaxNode) -> Option<String> {
    let mut current = node;
    loop {
        match current.kind {
            SyntaxKind::Group => {
                current = kids(current).iter().find(|node| is_expression(node.kind))?;
            }
            SyntaxKind::Query => {
                return kids(current)
                    .into_iter()
                    .filter(|node| node.kind == SyntaxKind::QueryClause)
                    .find_map(|clause| {
                        let parts = kids(clause);
                        if parts
                            .first()
                            .and_then(|node| name_text(db, node))
                            .as_deref()
                            == Some("as")
                        {
                            parts.get(1).and_then(|node| name_text(db, node))
                        } else {
                            None
                        }
                    });
            }
            _ => return None,
        }
    }
}

/// Callee spelling of a call node (plain names only).
fn callee_name(db: &SourceDb, callee: &SyntaxNode) -> Option<String> {
    if callee.kind != SyntaxKind::NameRef {
        return None;
    }
    kids(callee).iter().find_map(|n| name_text(db, n))
}

/// Whether an expression awaits (state-read builtins, capability calls,
/// delivery reads): rule functions wrap `async` exactly then.
pub fn expr_uses_async(expr: &TypedExpr) -> bool {
    let mut work = vec![expr];
    while let Some(current) = work.pop() {
        match &current.expr {
            IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                if matches!(
                    target,
                    IrCallTarget::Builtin { awaited: true, .. }
                        | IrCallTarget::CapabilityOp(_)
                        | IrCallTarget::DeriveFn(_)
                ) {
                    return true;
                }
                work.extend(args);
            }
            IrExpr::DeliveryRead { .. } => return true,
            IrExpr::Member { base, .. } => work.push(base),
            IrExpr::Binary { left, right, .. } => {
                work.push(right);
                work.push(left);
            }
            IrExpr::Unary { operand, .. } => work.push(operand),
            IrExpr::Array(items) => work.extend(items),
            IrExpr::Object(entries) => work.extend(entries.iter().map(|(_, value)| value)),
            IrExpr::Query(query) => {
                match &query.domain {
                    IrQueryDomain::Model(_) => return true,
                    IrQueryDomain::Value { base, .. } => work.push(base),
                }
                work.extend(query.parent.iter().map(|v| v.as_ref()));
                work.extend(query.where_pred.iter().map(|v| v.as_ref()));
                work.extend(query.limit.iter().map(|v| v.as_ref()));
                work.extend(query.archived.iter().map(|v| v.as_ref()));
                work.extend(query.select.iter().map(|v| v.as_ref()));
            }
            IrExpr::Message(message) => work.extend(message.params.iter().map(|p| &p.value)),
            IrExpr::MessageCall { args, params, .. } => {
                work.extend(args);
                work.extend(params.iter().filter_map(|param| param.default.as_ref()));
            }
            IrExpr::Format { args, .. } => work.extend(args),
            IrExpr::HasRole { person, .. } => work.extend(person.iter().map(|v| v.as_ref())),
            IrExpr::Lambda { body, .. } => work.push(body),
            IrExpr::Int(_)
            | IrExpr::Decimal(_)
            | IrExpr::Text(_)
            | IrExpr::Bool(_)
            | IrExpr::Null
            | IrExpr::Money { .. }
            | IrExpr::DurationMs(_)
            | IrExpr::Date(_)
            | IrExpr::Datetime(_)
            | IrExpr::Name(_)
            | IrExpr::Unsupported { .. } => {}
        }
    }
    false
}

/// Decode a guard: role gates (canonical or predicate spelling),
/// subject predicates, boolean combinations, or an arbitrary checked
/// boolean expression.
impl<'a> Cx<'a> {
    /// Explicit-public read provenance (B7 phase-1): true iff the grant
    /// reads exactly `public` with no `where=`. Serve honors such grants
    /// without rule-fn evaluation (rejected) or T04b-class evaluation
    /// (deferred); predicated `read=public where=` stays fail-closed.
    /// Pure: no diagnostics, safe to call during decode.
    fn is_explicit_public_read(&self, policy: &PolicyRule) -> bool {
        if policy.where_predicate.is_some() {
            return false;
        }
        let Some(key) = policy.read.as_ref() else {
            return false;
        };
        let Some(node) = self.node(key) else {
            return false;
        };
        if node.kind != SyntaxKind::NameRef {
            return false;
        }
        kids(node)
            .iter()
            .any(|n| name_text(self.db, n).as_deref() == Some("public"))
    }

    fn decode_guard(&mut self, scope: &Scope, key: &NodeKey) -> IrGuard {
        let Some(node) = self.node(key).cloned() else {
            let span = Span::new(key.file, key.start, key.end);
            self.gap(
                "guard expression is not published in the analysis tables; emitting a throwing placeholder"
                    .to_string(),
                span,
            );
            return IrGuard::Expr(TypedExpr::new(
                IrExpr::Unsupported {
                    what: "guard".to_string(),
                    why: "analysis did not publish the anchored node".to_string(),
                },
                ResolvedType::Scalar(Scalar::Bool),
                span,
            ));
        };
        self.decode_guard_node(scope, &node)
    }

    /// Decode one guard node (see [`Cx::decode_guard`]).
    fn decode_guard_node(&mut self, scope: &Scope, node: &SyntaxNode) -> IrGuard {
        match node.kind {
            SyntaxKind::NameRef => {
                let name = kids(node)
                    .iter()
                    .find_map(|n| name_text(self.db, n))
                    .unwrap_or_default();
                if is_predicate_spelling(&name) {
                    return IrGuard::Role(name);
                }
                if let Some((id, _)) = self.resolve_member(scope.module, &name)
                    && matches!(
                        self.program.symbols.get(id.0 as usize).map(|s| &s.kind),
                        Some(SymbolKind::Role)
                    )
                {
                    return IrGuard::Role(self.canonical(id));
                }
                IrGuard::Expr(self.decode_expr(scope, node))
            }
            SyntaxKind::Call => {
                // A subject predicate `role(person)` in guard position.
                let parts = kids(node);
                let callee = parts.iter().find(|n| is_expression(n.kind));
                let name = callee.and_then(|c| callee_name(self.db, c));
                if let Some(name) = name
                    && let Some((id, _)) = self.resolve_member(scope.module, &name)
                    && matches!(
                        self.program.symbols.get(id.0 as usize).map(|s| &s.kind),
                        Some(SymbolKind::Role)
                    )
                {
                    let person = parts
                        .iter()
                        .filter(|n| n.kind == SyntaxKind::Argument)
                        .filter_map(|arg| kids(arg).iter().find(|n| is_expression(n.kind)).copied())
                        .next()
                        .map(|value| Box::new(self.decode_expr(scope, value)));
                    return match person {
                        Some(person) => IrGuard::Subject {
                            role: self.canonical(id),
                            person,
                        },
                        None => IrGuard::Role(self.canonical(id)),
                    };
                }
                IrGuard::Expr(self.decode_expr(scope, node))
            }
            SyntaxKind::Binary => {
                let parts = kids(node);
                let op = parts
                    .iter()
                    .find_map(|n| match n.kind {
                        SyntaxKind::Name | SyntaxKind::Punct => Some(self.text(n.span)),
                        _ => None,
                    })
                    .unwrap_or("");
                let mut operands = parts.iter().filter(|n| is_expression(n.kind));
                match (op, operands.next(), operands.next()) {
                    ("and", Some(left), Some(right)) => IrGuard::And(vec![
                        self.decode_guard_node(scope, left),
                        self.decode_guard_node(scope, right),
                    ]),
                    ("or", Some(left), Some(right)) => IrGuard::Or(vec![
                        self.decode_guard_node(scope, left),
                        self.decode_guard_node(scope, right),
                    ]),
                    _ => IrGuard::Expr(self.decode_expr(scope, node)),
                }
            }
            SyntaxKind::Unary => {
                let parts = kids(node);
                let op = parts
                    .iter()
                    .find_map(|n| match n.kind {
                        SyntaxKind::Name | SyntaxKind::Punct => Some(self.text(n.span)),
                        _ => None,
                    })
                    .unwrap_or("");
                let operand = parts.iter().find(|n| is_expression(n.kind)).copied();
                match (op, operand) {
                    ("not", Some(operand)) => {
                        IrGuard::Not(Box::new(self.decode_guard_node(scope, operand)))
                    }
                    _ => IrGuard::Expr(self.decode_expr(scope, node)),
                }
            }
            SyntaxKind::Group => match kids(node).iter().find(|n| is_expression(n.kind)).copied() {
                Some(inner) => self.decode_guard_node(scope, inner),
                None => IrGuard::Expr(self.decode_expr(scope, node)),
            },
            _ => IrGuard::Expr(self.decode_expr(scope, node)),
        }
    }

    /// Decode one effect statement (total).
    fn decode_effect(
        &mut self,
        scope: &Scope,
        effect: &crate::analysis::effects::Effect,
        what: &str,
    ) -> IrStmt {
        let span = Span::new(effect.node.file, effect.node.start, effect.node.end);
        match effect.verb {
            EffectVerb::Let => {
                let name = effect.binding.clone().unwrap_or_default();
                let value = effect.value.as_ref().map(|key| {
                    let mut inner = scope.clone();
                    inner.bindings.remove(&name);
                    self.decode_anchored(&inner, key, &format!("{what} let value"))
                });
                match value {
                    Some(value) => IrStmt::Let { name, value, span },
                    None => unsupported_stmt("let statement", "no value is published", span),
                }
            }
            EffectVerb::Require => {
                if effect.message.is_some() {
                    // `require` diagnostics have no statement slot.
                    return unsupported_stmt(
                        "require message",
                        "require diagnostics have no §13 lowering",
                        span,
                    );
                }
                match effect.cond.as_ref() {
                    Some(key) => IrStmt::Require {
                        cond: self.decode_anchored(scope, key, &format!("{what} require")),
                        span,
                    },
                    None => {
                        unsupported_stmt("require statement", "no predicate is published", span)
                    }
                }
            }
            EffectVerb::Create => self.decode_create(scope, effect, what, span),
            EffectVerb::Set => self.decode_set(scope, effect, what, span),
            EffectVerb::Transition => {
                let Some(stmt) = self.node(&effect.node).cloned() else {
                    return unsupported_stmt("transition", "missing statement", span);
                };
                let parts = kids(&stmt);
                let Some(path) = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied() else {
                    return unsupported_stmt("transition", "missing record", span);
                };
                let names: Vec<_> = parts
                    .iter()
                    .filter(|n| n.kind == SyntaxKind::Name)
                    .map(|n| {
                        self.db
                            .get(n.span.file)
                            .map(|s| &s.text[n.span.start as usize..n.span.end as usize])
                            .unwrap_or("")
                            .to_string()
                    })
                    .collect();
                let model = match effect.target {
                    Some(crate::analysis::effects::EffectTarget::Record { model: Some(id) }) => {
                        self.canonical(id)
                    }
                    _ => return unsupported_stmt("transition", "missing stored owner", span),
                };
                if names.len() != 4 {
                    return unsupported_stmt("transition", "missing states", span);
                }
                IrStmt::Transition {
                    model,
                    record: self.decode_record_path(scope, path),
                    field: names[1].clone(),
                    from: names[2].clone(),
                    to: names[3].clone(),
                    span,
                }
            }
            EffectVerb::Delete => self.decode_delete(scope, effect, what, span),
            EffectVerb::Call => {
                let operation = self.effect_operation(effect);
                let inputs = self.effect_args_object(scope, effect);
                IrStmt::Call {
                    operation,
                    inputs,
                    binding: effect.binding.clone(),
                    span,
                }
            }
            EffectVerb::Emit => {
                let event = match &effect.target {
                    Some(crate::analysis::effects::EffectTarget::Event(id)) => self.canonical(*id),
                    _ => String::new(),
                };
                if event.is_empty() {
                    return unsupported_stmt(
                        "emit statement",
                        "no event target is published",
                        span,
                    );
                }
                IrStmt::Emit {
                    event,
                    payload: self.effect_args_object(scope, effect),
                    span,
                }
            }
            EffectVerb::Send => self.decode_send(scope, effect, what, span),
            EffectVerb::Schedule => {
                let Some(owner) = self.program.modules.get(scope.module.0 as usize) else {
                    return unsupported_stmt(
                        "schedule statement",
                        "checked declaring package is unavailable",
                        span,
                    );
                };
                let owner_package = owner.name.clone();
                let (Some(key), Some(at)) = (effect.key.as_ref(), effect.at.as_ref()) else {
                    return unsupported_stmt(
                        "schedule statement",
                        "key or instant is not published",
                        span,
                    );
                };
                let event = match &effect.target {
                    Some(crate::analysis::effects::EffectTarget::Event(id)) => self.canonical(*id),
                    _ => String::new(),
                };
                if event.is_empty() {
                    return unsupported_stmt(
                        "schedule statement",
                        "no event target is published",
                        span,
                    );
                }
                // The payload is the schedule object's entries (T31: the
                // value slot was never published for schedules, so every
                // schedule read as unlowered before this).
                IrStmt::Schedule {
                    owner_package,
                    key: self.decode_anchored(scope, key, &format!("{what} schedule key")),
                    at: self.decode_anchored(scope, at, &format!("{what} schedule instant")),
                    event,
                    payload: self.effect_args_object(scope, effect),
                    span,
                }
            }
            EffectVerb::Cancel => match (
                self.program.modules.get(scope.module.0 as usize),
                effect.value.as_ref(),
            ) {
                (Some(owner), Some(key)) => IrStmt::Cancel {
                    owner_package: owner.name.clone(),
                    key: self.decode_anchored(scope, key, &format!("{what} cancel key")),
                    span,
                },
                (None, _) => unsupported_stmt(
                    "cancel statement",
                    "checked declaring package is unavailable",
                    span,
                ),
                (_, None) => unsupported_stmt("cancel statement", "no key is published", span),
            },
            EffectVerb::Return => IrStmt::Return {
                value: effect
                    .value
                    .as_ref()
                    .map(|key| self.decode_anchored(scope, key, &format!("{what} return value"))),
                span,
            },
            EffectVerb::If => {
                let cond = effect
                    .cond
                    .as_ref()
                    .map(|key| self.decode_anchored(scope, key, &format!("{what} condition")));
                let Some(cond) = cond else {
                    return unsupported_stmt("if statement", "no condition is published", span);
                };
                IrStmt::If {
                    cond,
                    then_branch: effect
                        .then_effects
                        .iter()
                        .map(|e| self.decode_effect(scope, e, what))
                        .collect(),
                    else_branch: effect
                        .else_effects
                        .iter()
                        .map(|e| self.decode_effect(scope, e, what))
                        .collect(),
                    span,
                }
            }
            EffectVerb::Match => {
                if !self.program.types.exhaustive_matches.contains(&effect.node) {
                    return unsupported_stmt(
                        "match statement",
                        "no checked exhaustive enum coverage is published",
                        span,
                    );
                }
                let Some(subject) = effect
                    .value
                    .as_ref()
                    .map(|key| self.decode_anchored(scope, key, &format!("{what} match subject")))
                else {
                    return unsupported_stmt("match statement", "no subject is published", span);
                };
                let mut arms = Vec::new();
                for arm in &effect.match_arms {
                    let Some(case) = &arm.case else {
                        return unsupported_stmt(
                            "match case",
                            "no checked owning enum case is published",
                            Span::new(arm.node.file, arm.node.start, arm.node.end),
                        );
                    };
                    arms.push(IrMatchArm {
                        case: case.clone(),
                        body: arm
                            .effects
                            .iter()
                            .map(|effect| self.decode_effect(scope, effect, what))
                            .collect(),
                        span: Span::new(arm.node.file, arm.node.start, arm.node.end),
                    });
                }
                IrStmt::Match {
                    subject,
                    arms,
                    span,
                }
            }
            EffectVerb::For => {
                let item = effect.item.clone().unwrap_or_default();
                let domain = effect
                    .domain
                    .as_ref()
                    .map(|key| self.decode_anchored(scope, key, &format!("{what} domain")));
                // The bound stays fail-closed: the emitter fetches the
                // domain, then fails the operation past N items (DESIGN
                // §5 `for item in query limit=N`).
                let limit = effect
                    .limit
                    .as_ref()
                    .map(|key| self.decode_anchored(scope, key, &format!("{what} limit")));
                match domain {
                    Some(domain) => IrStmt::For {
                        item,
                        domain,
                        limit,
                        body: effect
                            .then_effects
                            .iter()
                            .map(|e| self.decode_effect(scope, e, what))
                            .collect(),
                        span,
                    },
                    None => unsupported_stmt("for statement", "no domain is published", span),
                }
            }
        }
    }

    /// Decode a `create` effect.
    fn decode_create(
        &mut self,
        scope: &Scope,
        effect: &crate::analysis::effects::Effect,
        what: &str,
        span: Span,
    ) -> IrStmt {
        let model = match &effect.target {
            Some(crate::analysis::effects::EffectTarget::Model(id)) => Some(*id),
            _ => None,
        };
        let Some(model) = model else {
            return unsupported_stmt("create statement", "no model target is published", span);
        };
        let _ = what;
        IrStmt::Create {
            model: self.canonical(model),
            input: self.effect_args_object(scope, effect),
            when: self.crud_when_key(model),
            binding: effect.binding.clone(),
            span,
        }
    }

    /// Decode a `set`/`delete` record path: single names decode as values;
    /// multi-segment paths (`event.after.parent`) decode as member chains
    /// (T31: the flat value decode fused them into one mushy identifier).
    /// Only the outermost link carries the checked target type; inner links
    /// are untyped member navigation.
    fn decode_record_path(&mut self, scope: &Scope, node: &SyntaxNode) -> TypedExpr {
        if node.kind == SyntaxKind::Path {
            let text = path_text(self.db, node);
            let segments: Vec<&str> = text.split('.').collect();
            if segments.len() > 1 {
                let span = node.span;
                let mut expr = TypedExpr::new(
                    IrExpr::Name(segments[0].to_string()),
                    ResolvedType::Unknown,
                    span,
                );
                for (index, field) in segments.iter().skip(1).enumerate() {
                    let last = index + 1 == segments.len() - 1;
                    expr = TypedExpr::new(
                        IrExpr::Member {
                            base: Box::new(expr),
                            field: (*field).to_string(),
                        },
                        if last {
                            self.node_type(node)
                        } else {
                            ResolvedType::Unknown
                        },
                        span,
                    );
                }
                return expr;
            }
        }
        self.decode_expr(scope, node)
    }

    /// Decode a `set` effect (record path re-read from the anchored node).
    fn decode_set(
        &mut self,
        scope: &Scope,
        effect: &crate::analysis::effects::Effect,
        what: &str,
        span: Span,
    ) -> IrStmt {
        let record_node = self.node(&effect.node).cloned().and_then(|stmt| {
            kids(&stmt)
                .iter()
                .find(|n| matches!(n.kind, SyntaxKind::Path | SyntaxKind::Member))
                .copied()
                .cloned()
        });
        let Some(record_node) = record_node else {
            return unsupported_stmt("set statement", "no record path is published", span);
        };
        let record = self.decode_record_path(scope, &record_node);
        let model = match &effect.target {
            Some(crate::analysis::effects::EffectTarget::Record { model }) => *model,
            Some(crate::analysis::effects::EffectTarget::PendingRecord { model }) => Some(*model),
            _ => None,
        };
        let _ = what;
        IrStmt::Set {
            record,
            changes: self.effect_args_object(scope, effect),
            when: model.and_then(|id| self.crud_when_key(id)),
            span,
        }
    }

    /// Decode a `delete` effect (mode from the model's `crud` row).
    fn decode_delete(
        &mut self,
        scope: &Scope,
        effect: &crate::analysis::effects::Effect,
        what: &str,
        span: Span,
    ) -> IrStmt {
        let record_node = self.node(&effect.node).cloned().and_then(|stmt| {
            kids(&stmt)
                .iter()
                .find(|n| matches!(n.kind, SyntaxKind::Path | SyntaxKind::Member))
                .copied()
                .cloned()
        });
        let Some(record_node) = record_node else {
            return unsupported_stmt("delete statement", "no record path is published", span);
        };
        let record = self.decode_record_path(scope, &record_node);
        let model = match &effect.target {
            Some(crate::analysis::effects::EffectTarget::Record { model }) => *model,
            _ => None,
        };
        let _ = what;
        let mode = model
            .and_then(|id| self.crud_for_model(id))
            .and_then(|crud| self.program.effects.cruds.get(&crud))
            .map(|data| delete_mode(&data.delete_mode))
            .unwrap_or(IrDeleteMode::Archive);
        IrStmt::Delete { record, mode, span }
    }

    /// Decode a `send` effect (queue/analytics targets have no lowering).
    fn decode_send(
        &mut self,
        scope: &Scope,
        effect: &crate::analysis::effects::Effect,
        what: &str,
        span: Span,
    ) -> IrStmt {
        let operation = match &effect.target {
            Some(crate::analysis::effects::EffectTarget::Operation(id)) => {
                Some(self.canonical(*id))
            }
            Some(
                crate::analysis::effects::EffectTarget::Queue { .. }
                | crate::analysis::effects::EffectTarget::Analytics { .. },
            ) => {
                return unsupported_stmt(
                    "send to a queue or analytics sink",
                    "no §13 operation identity exists",
                    span,
                );
            }
            _ => None,
        };
        let Some(target) = self.node(&effect.node).and_then(|node| {
            kids(node)
                .into_iter()
                .find(|child| is_expression(child.kind))
        }) else {
            return unsupported_stmt(
                "send statement",
                "checked target source is unavailable",
                span,
            );
        };
        let (operation, deployment_binding) =
            match self.send_target_provenance(scope, target, operation) {
                Ok(target) => target,
                Err(reason) => return unsupported_stmt("send statement", reason, span),
            };
        IrStmt::Send {
            operation,
            args: self.effect_args_object(scope, effect),
            when: effect
                .when
                .as_ref()
                .map(|key| self.decode_anchored(scope, key, &format!("{what} send guard"))),
            binding: effect.binding.clone(),
            deployment_binding,
            span,
        }
    }

    /// Join the authored target head to checked import provenance, never
    /// choosing a deployment alias from a canonical operation alone.
    fn send_target_provenance(
        &self,
        scope: &Scope,
        mut target: &SyntaxNode,
        selected: Option<String>,
    ) -> Result<(String, Option<String>), &'static str> {
        while target.kind == SyntaxKind::Group {
            target = kids(target)
                .into_iter()
                .find(|n| is_expression(n.kind))
                .ok_or("grouped target source is unavailable")?;
        }
        let parts = kids(target);
        let (head, member) = if target.kind == SyntaxKind::Member && parts.len() == 3 {
            (parts[0], name_text(self.db, parts[2]))
        } else if target.kind == SyntaxKind::NameRef {
            (target, None)
        } else {
            return Err("checked target import provenance is unavailable");
        };
        if head.kind != SyntaxKind::NameRef {
            return Err("checked target import head is unavailable");
        }
        let alias = kids(head)
            .into_iter()
            .find_map(|n| name_text(self.db, n))
            .ok_or("checked target alias is unavailable")?;
        let host = self
            .program
            .modules
            .get(scope.module.0 as usize)
            .ok_or("target importing module is unavailable")?;
        let imports: Vec<_> = host
            .imports
            .iter()
            .flat_map(|import| {
                import
                    .members
                    .iter()
                    .filter(|m| m.alias == alias)
                    .map(move |m| (import, m))
            })
            .collect();
        if imports.len() > 1 {
            return Err("target import provenance is ambiguous");
        }
        let external = self.program.types.target_bindings.get(&NodeKey::of(head));
        if let Some(crate::analysis::resolve::Binding::External { provider, name }) = external {
            let (import, imported) = imports
                .first()
                .copied()
                .ok_or("checked external target import is unavailable")?;
            if &import.provider != provider || &imported.name != name || import.from.is_none() {
                return Err("checked external target import provenance disagrees");
            }
            let cap = (provider == "std")
                .then(|| std_capability(name))
                .flatten()
                .ok_or("external target has no owning operation schema")?;
            let op = member
                .as_deref()
                .and_then(|name| crate::analysis::catalog::std_operation(cap.name, name))
                .ok_or("external target has no checked owning operation")?;
            let canonical = format!("{}.{}", cap.name, op.name);
            if selected
                .as_ref()
                .is_some_and(|selected| selected != &canonical)
            {
                return Err("selected operation disagrees with checked external target");
            }
            return Ok((canonical, Some(format!("{}.{}", host.name, alias))));
        }
        let operation = selected.ok_or("no operation target is published")?;
        if let Some((import, imported)) = imports.first().copied() {
            let Some(crate::analysis::resolve::Binding::Symbol(head_symbol)) =
                self.program.types.target_bindings.get(&NodeKey::of(head))
            else {
                // Lexical values can shadow an import; spelling never selects it.
                return Ok((operation, None));
            };
            if self.canonical(*head_symbol) != format!("{}.{}", import.provider, imported.name) {
                return Err("checked target declaration disagrees with authored import");
            }
            let expected = match member {
                Some(member) => format!("{}.{}.{}", import.provider, imported.name, member),
                None => format!("{}.{}", import.provider, imported.name),
            };
            if expected != operation {
                return Err("selected operation disagrees with authored import target");
            }
            if import.from.is_some() {
                return Ok((operation, Some(format!("{}.{}", host.name, alias))));
            }
        }
        Ok((operation, None))
    }

    /// Operation identity of a `call` effect (total over targets).
    fn effect_operation(&self, effect: &crate::analysis::effects::Effect) -> String {
        match &effect.target {
            Some(crate::analysis::effects::EffectTarget::Operation(id)) => self.canonical(*id),
            Some(crate::analysis::effects::EffectTarget::Action(ids))
            | Some(crate::analysis::effects::EffectTarget::Invocation(ids)) => ids
                .iter()
                .map(|id| self.canonical(*id))
                .collect::<Vec<_>>()
                .join(","),
            _ => String::new(),
        }
    }

    /// Effect object entries as one object expression.
    fn effect_args_object(
        &mut self,
        scope: &Scope,
        effect: &crate::analysis::effects::Effect,
    ) -> TypedExpr {
        let span = Span::new(effect.node.file, effect.node.start, effect.node.end);
        let entries = effect
            .args
            .iter()
            .map(|arg| {
                let value = arg
                    .value
                    .as_ref()
                    .map(|key| self.decode_anchored(scope, key, "effect argument"));
                let value = value.unwrap_or_else(|| {
                    TypedExpr::new(IrExpr::Name(arg.key.clone()), ResolvedType::Unknown, span)
                });
                (arg.key.clone(), value)
            })
            .collect();
        TypedExpr::new(IrExpr::Object(entries), ResolvedType::Unknown, span)
    }

    /// `crudWhen` registry key for `model` (its local name), when the
    /// model's `crud` row carries a `when=` predicate.
    fn crud_when_key(&self, model: SymbolId) -> Option<String> {
        let crud = self.crud_for_model(model)?;
        let data = self.program.effects.cruds.get(&crud)?;
        data.when.as_ref()?;
        Some(self.local_name(model))
    }

    /// `Crud` symbol for `model`, if one is declared.
    fn crud_for_model(&self, model: SymbolId) -> Option<SymbolId> {
        match self.program.symbols.get(model.0 as usize).map(|s| &s.kind) {
            Some(SymbolKind::Model { crud, .. }) => *crud,
            _ => None,
        }
    }
}

/// Convert a decoded guard to its boolean expression (rule
/// predicates share the guard contract: roles become `hasRole`).
fn guard_to_expr(guard: &IrGuard, span: Span) -> TypedExpr {
    let bool_ty = ResolvedType::Scalar(Scalar::Bool);
    let expr = match guard {
        IrGuard::Role(id) => IrExpr::HasRole {
            role: id.clone(),
            person: None,
        },
        IrGuard::Subject { role, person } => IrExpr::HasRole {
            role: role.clone(),
            person: Some(person.clone()),
        },
        IrGuard::Expr(expr) => return expr.clone(),
        IrGuard::And(guards) => return fold_guard(guards, IrBinOp::And, bool_ty, span),
        IrGuard::Or(guards) => return fold_guard(guards, IrBinOp::Or, bool_ty, span),
        IrGuard::Not(inner) => IrExpr::Unary {
            op: IrUnOp::Not,
            operand: Box::new(guard_to_expr(inner, span)),
        },
    };
    TypedExpr::new(expr, bool_ty, span)
}

/// Fold guard conjunctions/disjunctions into left-nested binaries.
fn fold_guard(guards: &[IrGuard], op: IrBinOp, ty: ResolvedType, span: Span) -> TypedExpr {
    let mut iter = guards.iter().map(|guard| guard_to_expr(guard, span));
    let Some(first) = iter.next() else {
        return TypedExpr::new(IrExpr::Bool(true), ty, span);
    };
    iter.fold(first, |acc, next| {
        TypedExpr::new(
            IrExpr::Binary {
                op,
                left: Box::new(acc),
                right: Box::new(next),
            },
            ty.clone(),
            span,
        )
    })
}

/// Throwing statement placeholder (the lowering reports `E6008`).
fn unsupported_stmt(what: &str, why: &str, span: Span) -> IrStmt {
    IrStmt::Unsupported {
        what: what.to_string(),
        why: why.to_string(),
        span,
    }
}

/// [`DeleteMode`](crate::analysis::effects::DeleteMode) to [`IrDeleteMode`].
fn delete_mode(mode: &crate::analysis::effects::DeleteMode) -> IrDeleteMode {
    match mode {
        crate::analysis::effects::DeleteMode::Archive => IrDeleteMode::Archive,
        crate::analysis::effects::DeleteMode::Remove => IrDeleteMode::Remove,
    }
}

/// Decode `order` selector lists (`field`, `-field`).
fn decode_order_selectors(db: &SourceDb, node: &SyntaxNode) -> Vec<IrOrder> {
    let mut out = Vec::new();
    match node.kind {
        SyntaxKind::Descending => {
            let field = kids(node)
                .iter()
                .find_map(|n| {
                    if n.kind == SyntaxKind::Path {
                        Some(path_text(db, n))
                    } else {
                        None
                    }
                })
                .unwrap_or_default();
            out.push(IrOrder {
                field,
                descending: true,
            });
        }
        SyntaxKind::Path => {
            out.push(IrOrder {
                field: path_text(db, node),
                descending: false,
            });
        }
        SyntaxKind::Selectors => {
            for child in kids(node) {
                out.extend(decode_order_selectors(db, child));
            }
        }
        _ => {}
    }
    out
}

impl<'a> Cx<'a> {
    /// Decode a model row (G3): label plus rule references. Rule bodies
    /// decode once in [`Cx::build_rule_maps`]; the ids here must match.
    #[allow(clippy::type_complexity)]
    fn decode_model(
        &mut self,
        symbol: &crate::analysis::resolve::Symbol,
    ) -> (
        Option<IrMessage>,
        Vec<IrGrant>,
        Vec<String>,
        Vec<String>,
        Vec<IrUnique>,
        Option<IrRetain>,
    ) {
        let empty = (None, Vec::new(), Vec::new(), Vec::new(), Vec::new(), None);
        let data = self.program.effects.models.get(&symbol.id).cloned();
        let Some(data) = data else {
            self.gap(
                format!(
                    "model {}: read grants, invariants, locks, unique constraints, label and field modifiers/defaults are not in the analysis tables (PR5 rules/labels); emitting the typed schema without them",
                    symbol.canonical,
                ),
                symbol.span,
            );
            return empty;
        };
        let label = data
            .label
            .as_ref()
            .and_then(|key| self.decode_message_value(symbol.module, key));
        let grants = data
            .policies
            .iter()
            .enumerate()
            .map(|(index, policy)| {
                let public = self.is_explicit_public_read(policy);
                IrGrant {
                    rule: format!("{}.read.{}", symbol.name, index + 1),
                    fields: policy.fields.clone(),
                    public,
                }
            })
            .collect();
        let invariants = data
            .invariants
            .iter()
            .enumerate()
            .map(|(index, _)| format!("{}.require.{}", symbol.name, index + 1))
            .collect();
        let locks = data
            .locks
            .iter()
            .enumerate()
            .map(|(index, _)| format!("{}.lock.{}", symbol.name, index + 1))
            .collect();
        let scope = Scope::module(symbol.module);
        let uniques = data
            .uniques
            .iter()
            .map(|unique| IrUnique {
                fields: unique.fields.clone(),
                where_predicate: unique.where_predicate.as_ref().map(|key| {
                    self.decode_anchored(
                        &scope,
                        key,
                        &format!("unique constraint on {}", symbol.canonical),
                    )
                }),
                span: Span::new(unique.node.file, unique.node.start, unique.node.end),
            })
            .collect();
        let mut retains = data.retains.iter();
        // Clean programs carry at most one lifetime; extras have no slot.
        if retains.len() > 1 {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!(
                    "cannot lower model {}: additional retain declarations have no §13 lowering",
                    symbol.canonical,
                ),
                symbol.span,
            ));
        }
        let retain = retains.next().map(|retain| IrRetain {
            until: retain
                .until
                .as_ref()
                .map(|key| {
                    self.decode_anchored(&scope, key, &format!("retain on {}", symbol.canonical))
                })
                .unwrap_or_else(|| {
                    TypedExpr::new(
                        IrExpr::Unsupported {
                            what: format!("retain on {}", symbol.canonical),
                            why: "no deadline is published".to_string(),
                        },
                        ResolvedType::Unknown,
                        Span::new(retain.node.file, retain.node.start, retain.node.end),
                    )
                }),
            span: Span::new(retain.node.file, retain.node.start, retain.node.end),
        });
        (label, grants, invariants, locks, uniques, retain)
    }

    /// Decode a contract/record label (G4).
    fn decode_record_label(
        &mut self,
        symbol: &crate::analysis::resolve::Symbol,
        noun: &str,
    ) -> Option<IrMessage> {
        let data = self.program.effects.records.get(&symbol.id);
        let Some(data) = data else {
            self.gap(
                format!(
                    "{noun} {}: label and field modifiers/defaults are not in the analysis tables (PR5 labels); emitting the typed schema without them",
                    symbol.canonical,
                ),
                symbol.span,
            );
            return None;
        };
        data.label
            .as_ref()
            .and_then(|key| self.decode_message_value(symbol.module, key))
    }

    /// Decode a scenario row (G1): admission, guards, effects, captions.
    #[allow(clippy::type_complexity)]
    #[allow(clippy::type_complexity)]
    fn decode_scenario(
        &mut self,
        symbol: &crate::analysis::resolve::Symbol,
    ) -> (
        bool,
        Vec<IrGuard>,
        Option<IrMessage>,
        Option<IrMessage>,
        bool,
        Vec<IrStmt>,
        Vec<IrStmt>,
        Option<IrHook>,
        Option<IrCohort>,
        Option<IrEventSource>,
    ) {
        let empty = (
            false,
            Vec::new(),
            None,
            None,
            false,
            Vec::new(),
            Vec::new(),
            None,
            None,
            None,
        );
        let data = self.program.effects.scenarios.get(&symbol.id).cloned();
        let Some(data) = data else {
            self.gap(
                format!(
                    "scenario {}: guards, effects, body, labels and parameter labels/defaults are not in the analysis tables (PR5 effects); emitting metadata plus a failing handler stub",
                    symbol.canonical,
                ),
                symbol.span,
            );
            return empty;
        };
        let mut scope = Scope::module(symbol.module);
        let by = data
            .by
            .as_ref()
            .map(|key| self.decode_guard(&scope, key))
            .into_iter()
            .collect();
        let label = data
            .label
            .as_ref()
            .and_then(|key| self.decode_message_value(symbol.module, key));
        let description = self.owner_description(symbol.module, &data.node);
        if data.scope_authority {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!(
                    "cannot lower scenario {}: scope=authority has no §13 emission",
                    symbol.canonical,
                ),
                symbol.span,
            ));
        }
        // Pre-commit hooks use the engine context. Ordinary declared events
        // retain their checked identity and existing `{event}` handler ABI.
        let event_source = match &data.on {
            Some(crate::analysis::effects::HandlerSource::Event(event))
                if data.cohort.is_none() =>
            {
                Some(IrEventSource::Declared(self.canonical(*event)))
            }
            Some(crate::analysis::effects::HandlerSource::DeliveryProgressed { source })
                if data.cohort.is_none() =>
            {
                Some(IrEventSource::DeliveryProgressed(source.clone()))
            }
            _ => None,
        };
        let hook = match &data.on {
            Some(crate::analysis::effects::HandlerSource::Hook { model, op }) => Some(IrHook {
                model: *model,
                op: *op,
            }),
            Some(_) if event_source.is_some() => None,
            Some(_) => {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    format!(
                        "cannot lower scenario {}: handler triggers have no §13 member lowering",
                        symbol.canonical,
                    ),
                    symbol.span,
                ));
                None
            }
            None => None,
        };
        scope.in_hook = hook.is_some();
        let what = symbol.canonical.clone();
        let guards = data
            .guards
            .iter()
            .map(|effect| self.decode_effect(&scope, effect, &what))
            .collect();
        let effects = data
            .effects
            .iter()
            .map(|effect| self.decode_effect(&scope, effect, &what))
            .collect();
        // T34-F6: the checked `each=` cohort decodes verbatim (analysis
        // owns the contract; the IR never re-derives it).
        let cohort = data.cohort.as_ref().map(|cohort| IrCohort {
            kind: match cohort.kind {
                crate::analysis::effects::CohortKind::Model => IrCohortKind::Model,
                crate::analysis::effects::CohortKind::AnchoredCollection => {
                    IrCohortKind::AnchoredCollection
                }
            },
            model: cohort.model,
            bind: cohort.bind.clone(),
            parent: if cohort.parent_path.is_empty() {
                None
            } else {
                Some(cohort.parent_path.join("."))
            },
            span: Span::new(cohort.node.file, cohort.node.start, cohort.node.end),
        });
        (
            data.read,
            by,
            label,
            description,
            data.expose_none,
            guards,
            effects,
            hook,
            cohort,
            event_source,
        )
    }

    /// Decode a generated CRUD operation row (G2).
    #[allow(clippy::type_complexity)]
    fn decode_crud_op(
        &mut self,
        symbol: &crate::analysis::resolve::Symbol,
        model: SymbolId,
        op: CrudOp,
    ) -> (
        Vec<IrGuard>,
        bool,
        Vec<String>,
        Option<IrMessage>,
        bool,
        IrDeleteMode,
    ) {
        let empty = (
            Vec::new(),
            false,
            Vec::new(),
            None,
            false,
            IrDeleteMode::Archive,
        );
        let data = self.program.effects.crud_ops.get(&symbol.id).cloned();
        let Some(data) = data else {
            self.gap(
                format!(
                    "crud operation {}: guard, field allowlist and labels are not in the analysis tables (PR5 effects); emitting metadata plus a failing handler stub",
                    symbol.canonical,
                ),
                symbol.span,
            );
            return empty;
        };
        let scope = Scope::module(symbol.module);
        let by = data
            .by
            .as_ref()
            .map(|key| self.decode_guard(&scope, key))
            .into_iter()
            .collect();
        let label = data
            .label
            .as_ref()
            .and_then(|key| self.decode_message_value(symbol.module, key));
        let op_name = match op {
            CrudOp::Create => "create",
            CrudOp::Update => "update",
            CrudOp::Delete => "delete",
        };
        let expose_excluded = self
            .program
            .effects
            .cruds
            .get(&data.crud_decl)
            .map(|crud| !crud.expose.is_empty() && !crud.expose.iter().any(|name| name == op_name))
            .unwrap_or(false);
        let _ = model;
        (
            by,
            data.when.is_some(),
            data.fields.clone(),
            label,
            expose_excluded,
            delete_mode(&data.delete_mode),
        )
    }

    /// Decode a stored field row (G3/G4): T09 omission marker,
    /// default, server, modifiers, label, checked description source.
    #[allow(clippy::type_complexity)]
    fn decode_field(
        &mut self,
        symbol: &crate::analysis::resolve::Symbol,
        owner: SymbolId,
    ) -> (
        bool,
        Option<IrDefault>,
        Option<IrServer>,
        IrModifiers,
        Option<IrFieldLabel>,
        Option<String>,
    ) {
        let empty = (false, None, None, IrModifiers::default(), None, None);
        let data = self
            .program
            .effects
            .models
            .get(&owner)
            .and_then(|model| model.fields.iter().find(|f| f.field == symbol.id))
            .cloned()
            .or_else(|| {
                self.program
                    .effects
                    .records
                    .get(&owner)
                    .and_then(|record| record.fields.iter().find(|f| f.field == symbol.id))
                    .cloned()
            });
        let Some(data) = data else { return empty };
        let scope = Scope::module(symbol.module);
        let default = data.default.as_ref().map(|key| {
            let expr = self.decode_anchored(&scope, key, "field default");
            if is_literal_default(&expr) {
                IrDefault::Literal(expr)
            } else {
                IrDefault::Computed {
                    expr,
                    has_parent: self.model_has_parent(owner),
                }
            }
        });
        let server = data.server.as_ref().and_then(|key| {
            let node = self.node(key)?.clone();
            if node.kind == SyntaxKind::NameRef
                && let Some(name) = kids(&node).iter().find_map(|n| name_text(self.db, n))
            {
                match name.as_str() {
                    "actor" => return Some(IrServer::Actor),
                    "now" => return Some(IrServer::Now),
                    _ => {}
                }
            }
            // T18: server initializers execute in the L3 engine, never in
            // the emitted JS — builtin references decoded here are not
            // link-time `E6007` dependencies (the engine owns
            // `random_secret`, not the stdlib). Truncate exactly the
            // entries this decode appended (positional, so builtins also
            // used in linked positions keep their true-span entries);
            // `g13_seen` still suppresses the effects fallback for these
            // ids, which is precisely the engine-executed posture.
            let seen = self.builtins_seen.len();
            let lowered = self.decode_expr(&scope, &node);
            self.builtins_seen.truncate(seen);
            Some(IrServer::Computed(Box::new(lowered)))
        });
        let mut modifiers = IrModifiers::default();
        for modifier in &data.modifiers {
            match modifier.name.as_str() {
                "trim" => modifiers.trim = true,
                "unique" => modifiers.unique = true,
                "machine" => modifiers.machine = true,
                "min" => {
                    modifiers.min = modifier
                        .value
                        .as_ref()
                        .map(|key| self.decode_anchored(&scope, key, "min bound"));
                }
                "max" => {
                    modifiers.max = modifier
                        .value
                        .as_ref()
                        .map(|key| self.decode_anchored(&scope, key, "max bound"));
                }
                _ => {}
            }
        }
        let label = data
            .label
            .as_ref()
            .and_then(|key| self.decode_field_label(symbol.module, key));
        // D03: the checked description slot (inline/attached/shared/
        // legacy spellings feed one value) projects its source text
        // into the existing MCP source-string path. The legacy
        // annotation text is only a best-effort fallback: on clean
        // programs the checked slot already subsumes it.
        let description = self
            .program
            .effects
            .description_source(&data.node)
            .map(str::to_string)
            .or(data.description.clone());
        (
            data.required_array,
            default,
            server,
            modifiers,
            label,
            description,
        )
    }

    /// Whether `owner` is a child model (computed defaults take `{parent}`).
    fn model_has_parent(&self, owner: SymbolId) -> bool {
        matches!(
            self.program.symbols.get(owner.0 as usize).map(|s| &s.kind),
            Some(SymbolKind::Model {
                owner: ModelOwner::ChildOf(_),
                ..
            })
        )
    }

    /// Decode a signature parameter row (G1/G6/G7): default, label,
    /// checked description source.
    fn decode_param(
        &mut self,
        symbol: &crate::analysis::resolve::Symbol,
        owner: SymbolId,
    ) -> (Option<IrDefault>, Option<IrMessage>, Option<String>) {
        let data = self.param_data(owner, symbol.id);
        let Some(data) = data else {
            return (None, None, None);
        };
        let scope = Scope::module(symbol.module);
        let default = data.default.as_ref().map(|key| {
            let expr = self.decode_anchored(&scope, key, "parameter default");
            if is_literal_default(&expr) {
                IrDefault::Literal(expr)
            } else {
                IrDefault::Computed {
                    expr,
                    has_parent: false,
                }
            }
        });
        let label = data
            .label
            .as_ref()
            .and_then(|key| self.decode_message_value(symbol.module, key));
        // D03: checked-first like `decode_field` above; the legacy
        // annotation text survives only as a best-effort fallback.
        let description = self
            .program
            .effects
            .description_source(&data.node)
            .map(str::to_string)
            .or(data.description.clone());
        (default, label, description)
    }

    /// `ParamData` for `param` of `owner` (scenario, capability op,
    /// message or derived function).
    fn param_data(
        &self,
        owner: SymbolId,
        param: SymbolId,
    ) -> Option<crate::analysis::effects::ParamData> {
        if let Some(scenario) = self.program.effects.scenarios.get(&owner)
            && let Some(data) = scenario.params.iter().find(|p| p.param == param)
        {
            return Some(data.clone());
        }
        for capability in self.program.effects.capabilities.values() {
            for op in &capability.ops {
                if let Some(data) = op.params.iter().find(|p| p.param == param) {
                    return Some(data.clone());
                }
            }
        }
        if let Some(message) = self.program.effects.messages.get(&owner)
            && let Some(data) = message.params.iter().find(|p| p.param == param)
        {
            return Some(data.clone());
        }
        if let Some(derive) = self.program.effects.derives.get(&owner)
            && let Some(data) = derive.params.iter().find(|p| p.param == param)
        {
            return Some(data.clone());
        }
        None
    }

    /// Decode a derive row (G8): value expression plus field label.
    fn decode_derive(
        &mut self,
        symbol: &crate::analysis::resolve::Symbol,
    ) -> (Option<TypedExpr>, Option<IrFieldLabel>) {
        let data = self.program.effects.derives.get(&symbol.id).cloned();
        let Some(data) = data else {
            self.gap(
                format!(
                    "derive {}: expression is not in the analysis tables (PR5 effects); emitting a failing stub",
                    symbol.canonical,
                ),
                symbol.span,
            );
            return (None, None);
        };
        let scope = Scope::module(symbol.module);
        let expr = data
            .expr
            .as_ref()
            .map(|key| self.decode_anchored(&scope, key, &format!("derive {}", symbol.canonical)));
        let label = data
            .label
            .as_ref()
            .and_then(|key| self.decode_field_label(symbol.module, key));
        (expr, label)
    }
}

/// Whether a default expression stays a literal `default` value.
fn is_literal_default(expr: &TypedExpr) -> bool {
    if super::defaults::money_default_wire(expr).is_some() {
        return true;
    }
    match &expr.expr {
        IrExpr::Int(_)
        | IrExpr::Decimal(_)
        | IrExpr::Text(_)
        | IrExpr::Bool(_)
        | IrExpr::Null
        | IrExpr::Money { .. }
        | IrExpr::DurationMs(_)
        | IrExpr::Date(_)
        | IrExpr::Datetime(_) => true,
        IrExpr::Call {
            target: IrCallTarget::Builtin { id, awaited: false },
            args,
        } if matches!(id.as_str(), "date" | "datetime") => {
            matches!(args.as_slice(), [value] if matches!(value.expr, IrExpr::Text(_)))
        }
        IrExpr::Array(items) => items.iter().all(is_literal_default),
        IrExpr::Object(entries) => entries.iter().all(|(_, v)| is_literal_default(v)),
        _ => false,
    }
}

impl<'a> Cx<'a> {
    /// Decode rule bodies once (G2/G3/G4): read rules, invariants, locks,
    /// retention, `crudWhen` and preferences validators. Ids must match
    /// the references decoded in [`Cx::decode_model`].
    #[allow(clippy::too_many_arguments)]
    fn build_rule_maps(
        &mut self,
        read_rules: &mut Vec<IrRuleFn>,
        invariants: &mut Vec<IrRuleFn>,
        locks: &mut Vec<IrLockFn>,
        retention: &mut Vec<IrNamedFn>,
        crud_when: &mut Vec<IrNamedFn>,
        preferences_valid: &mut Vec<IrNamedFn>,
    ) {
        let mut preference_modules: Vec<ModuleId> = Vec::new();
        for symbol in self.program.symbols.clone() {
            if let SymbolKind::Model { .. } = &symbol.kind
                && let Some(data) = self.program.effects.models.get(&symbol.id).cloned()
            {
                let scope = Scope::module(symbol.module);
                for (index, policy) in data.policies.iter().enumerate() {
                    let span = Span::new(policy.node.file, policy.node.start, policy.node.end);
                    let read = match policy.read.as_ref() {
                        Some(key) => {
                            let guard = self.decode_guard(&scope, key);
                            guard_to_expr(&guard, span)
                        }
                        // Fail-closed: an unpublished grant predicate
                        // denies rather than broadens, loudly.
                        None => {
                            self.gap(
                                format!(
                                    "policy on {}: read grant predicate is not in the analysis tables; denying",
                                    symbol.canonical,
                                ),
                                span,
                            );
                            TypedExpr::new(
                                IrExpr::Bool(false),
                                ResolvedType::Scalar(Scalar::Bool),
                                span,
                            )
                        }
                    };
                    let pred = match policy.where_predicate.as_ref() {
                        Some(key) => {
                            let where_pred = self.decode_anchored(
                                &scope,
                                key,
                                &format!("policy on {}", symbol.canonical),
                            );
                            TypedExpr::new(
                                IrExpr::Binary {
                                    op: IrBinOp::And,
                                    left: Box::new(read),
                                    right: Box::new(where_pred),
                                },
                                ResolvedType::Scalar(Scalar::Bool),
                                span,
                            )
                        }
                        None => read,
                    };
                    read_rules.push(IrRuleFn {
                        id: format!("{}.read.{}", symbol.name, index + 1),
                        pred,
                        span,
                    });
                }
                for (index, invariant) in data.invariants.iter().enumerate() {
                    let span = Span::new(
                        invariant.node.file,
                        invariant.node.start,
                        invariant.node.end,
                    );
                    let pred = invariant.predicate.as_ref().map(|key| {
                        self.decode_anchored(
                            &scope,
                            key,
                            &format!("invariant on {}", symbol.canonical),
                        )
                    });
                    let Some(pred) = pred else {
                        self.gap(
                            format!(
                                "invariant on {}: predicate is not in the analysis tables; omitting the rule",
                                symbol.canonical,
                            ),
                            span,
                        );
                        continue;
                    };
                    invariants.push(IrRuleFn {
                        id: format!("{}.require.{}", symbol.name, index + 1),
                        pred,
                        span,
                    });
                }
                for (index, unique) in data.uniques.iter().enumerate() {
                    // A2b: conditional uniques register their `where=`
                    // predicate beside the invariants
                    // (`Model.unique.N`); the model entry references
                    // the id from its `uniques` member, never from
                    // its `invariants` list (not a row invariant).
                    let Some(key) = unique.where_predicate.as_ref() else {
                        continue;
                    };
                    let span = Span::new(unique.node.file, unique.node.start, unique.node.end);
                    invariants.push(IrRuleFn {
                        id: format!("{}.unique.{}", symbol.name, index + 1),
                        pred: self.decode_anchored(
                            &scope,
                            key,
                            &format!("unique constraint on {}", symbol.canonical),
                        ),
                        span,
                    });
                }
                for (index, lock) in data.locks.iter().enumerate() {
                    let span = Span::new(lock.node.file, lock.node.start, lock.node.end);
                    locks.push(IrLockFn {
                        id: format!("{}.lock.{}", symbol.name, index + 1),
                        fields: lock.fields.clone(),
                        when: lock.when.as_ref().map(|key| {
                            self.decode_anchored(
                                &scope,
                                key,
                                &format!("lock on {}", symbol.canonical),
                            )
                        }),
                        span,
                    });
                }
                if let Some(retain) = data.retains.first() {
                    let span = Span::new(retain.node.file, retain.node.start, retain.node.end);
                    let body = retain.until.as_ref().map(|key| {
                        self.decode_anchored(
                            &scope,
                            key,
                            &format!("retain on {}", symbol.canonical),
                        )
                    });
                    if let Some(body) = body {
                        retention.push(IrNamedFn {
                            name: symbol.name.clone(),
                            body,
                            span,
                        });
                    }
                }
            }
            if matches!(
                &symbol.kind,
                SymbolKind::Preferences { .. }
                    | SymbolKind::Contract { .. }
                    | SymbolKind::Event { .. }
            ) && let Some(data) = self.program.effects.records.get(&symbol.id).cloned()
                && !data.invariants.is_empty()
            {
                let scope = Scope::module(symbol.module);
                let mut combined: Option<TypedExpr> = None;
                for invariant in &data.invariants {
                    let span = Span::new(
                        invariant.node.file,
                        invariant.node.start,
                        invariant.node.end,
                    );
                    let pred = invariant.predicate.as_ref().map(|key| {
                        self.decode_anchored(
                            &scope,
                            key,
                            &format!("invariant on {}", symbol.canonical),
                        )
                    });
                    let Some(pred) = pred else {
                        self.gap(
                            format!(
                                "invariant on {}: predicate is not in the analysis tables; omitting the rule",
                                symbol.canonical,
                            ),
                            span,
                        );
                        continue;
                    };
                    combined = Some(match combined {
                        Some(acc) => TypedExpr::new(
                            IrExpr::Binary {
                                op: IrBinOp::And,
                                left: Box::new(acc),
                                right: Box::new(pred),
                            },
                            ResolvedType::Scalar(Scalar::Bool),
                            span,
                        ),
                        None => pred,
                    });
                }
                if let Some(body) = combined {
                    preferences_valid.push(IrNamedFn {
                        name: String::new(),
                        body,
                        span: symbol.span,
                    });
                    preference_modules.push(symbol.module);
                }
            }
        }
        // Shared `crudWhen` admission, keyed by model-local name, in
        // declaration order.
        let mut cruds: Vec<_> = self.program.effects.cruds.values().collect();
        cruds.sort_by_key(|crud| crud.crud.0);
        for crud in cruds {
            let Some(when) = crud.when.as_ref() else {
                continue;
            };
            let module = self
                .program
                .symbols
                .get(crud.model.0 as usize)
                .map(|s| s.module)
                .unwrap_or(ModuleId(0));
            let scope = Scope::module(module);
            let span = Span::new(when.file, when.start, when.end);
            crud_when.push(IrNamedFn {
                name: self.local_name(crud.model),
                body: self.decode_anchored(&scope, when, "crud admission"),
                span,
            });
        }
        // One `preferencesValid` name per module when several modules
        // validate preferences; a lone validator keeps the plain name.
        if preferences_valid.len() > 1 {
            for (validator, module) in preferences_valid.iter_mut().zip(preference_modules.iter()) {
                let module_name = self
                    .program
                    .modules
                    .get(module.0 as usize)
                    .map(|m| m.name.clone())
                    .unwrap_or_default();
                validator.name = format!("preferencesValid_{module_name}");
                self.preference_validators
                    .insert(*module, validator.name.clone());
            }
        } else if preferences_valid.len() == 1 {
            preferences_valid[0].name = "preferencesValid".to_string();
            if let Some(module) = preference_modules.first() {
                self.preference_validators
                    .insert(*module, "preferencesValid".to_string());
            }
        }
    }

    /// `E6007` for deployment-bound capabilities that are not available
    /// (G6): missing, `planned` or `external` catalog entries, or no
    /// catalog to verify against. Never a silent emit.
    fn check_bound_capabilities(&mut self) {
        for module in self.program.modules.clone() {
            for import in &module.imports {
                let Some(from) = import.from.clone() else {
                    continue;
                };
                let _ = from;
                for member in &import.members {
                    let provider = self.modules_by_name.get(&import.provider).copied();
                    let target = provider
                        .and_then(|id| self.by_name.get(&(id, member.name.clone())).copied());
                    let Some(target) = target else { continue };
                    let symbol = self.program.symbols.get(target.0 as usize).cloned();
                    let (availability, noun) = match symbol.as_ref().map(|s| &s.kind) {
                        Some(SymbolKind::Capability { .. }) => (
                            self.program
                                .effects
                                .capabilities
                                .get(&target)
                                .and_then(|data| data.availability),
                            "capability",
                        ),
                        Some(SymbolKind::CapabilityOp { .. }) => {
                            (self.op_availability(target), "capability operation")
                        }
                        _ => continue,
                    };
                    let canonical = self.canonical(target);
                    match availability {
                        Some(Availability::Implemented) => {}
                        Some(Availability::Planned) => {
                            self.diags.push(Diagnostic::error(
                                "E6007",
                                format!(
                                    "bound {noun} '{canonical}' is planned: no implementation to link"
                                ),
                                member.span,
                            ));
                        }
                        Some(Availability::External) => {
                            self.diags.push(Diagnostic::error(
                                "E6007",
                                format!(
                                    "bound {noun} '{canonical}' is external: implemented by another lane, unavailable here"
                                ),
                                member.span,
                            ));
                        }
                        None => {
                            self.diags.push(Diagnostic::error(
                                "E6007",
                                format!(
                                    "cannot verify bound {noun} '{canonical}': no producer catalog entry was consulted"
                                ),
                                member.span,
                            ));
                        }
                    }
                }
            }
        }
    }

    /// Catalog availability of one capability operation, if published.
    fn op_availability(&self, op: SymbolId) -> Option<Availability> {
        self.program
            .effects
            .capabilities
            .values()
            .flat_map(|capability| capability.ops.iter())
            .find(|data| data.op == op)
            .and_then(|data| data.availability)
    }

    /// Lower checked migrations to interim-intake transitions (B3-I1).
    /// Each migration passes
    /// [`migrate_check`](crate::analysis::migrate_check) first
    /// (directive consistency `E6009`, predecessor `E6010`); valid ones
    /// lower with zero diagnostics, invalid ones lower nothing. Absent
    /// migrations emit nothing. Never `E6008`: migrations have a §13
    /// lowering now (the transition registry).
    fn build_migrations(&mut self) -> Vec<IrMigration> {
        let mut out = Vec::new();
        let mut prior: Vec<(String, String)> = Vec::new();
        for migration in self.program.effects.migrations.clone() {
            let view = migration.module.map(|module| self.owner_model_view(module));
            let issues = migrate_check::check_migration(&migration, view.as_deref(), &prior);
            if let Some(from) = &migration.from
                && !from.is_empty()
            {
                prior.push((migration.owner.clone(), from.clone()));
            }
            if !issues.is_empty() {
                self.diags.extend(issues);
                continue;
            }
            let Some(from) = migration.from.clone().filter(|f| !f.is_empty()) else {
                continue;
            };
            let span = Span::new(
                migration.node.file,
                migration.node.start,
                migration.node.end,
            );
            let directives = migration
                .directives
                .iter()
                .map(|directive| Self::lower_migration_directive(&migration.owner, directive))
                .collect::<Vec<_>>();
            let canonical = directives
                .iter()
                .map(IrMigrationDirective::canonical)
                .collect::<Vec<_>>()
                .join("\n");
            out.push(IrMigration {
                owner: migration.owner.clone(),
                migration_id: format!("{}@{from}", migration.owner),
                from_snapshot: from,
                directives,
                body_digest: sha256_hex(canonical.as_bytes()),
                span,
            });
        }
        out
    }

    /// Declared models + fields of one owner module for migration
    /// target-existence checks (desired namespace, local names).
    fn owner_model_view(&self, module: ModuleId) -> Vec<OwnerModelView> {
        let mut view = Vec::new();
        for symbol in &self.program.symbols {
            if symbol.module != module {
                continue;
            }
            let SymbolKind::Model { fields, .. } = &symbol.kind else {
                continue;
            };
            view.push(OwnerModelView {
                name: symbol.name.clone(),
                fields: fields
                    .iter()
                    .filter_map(|id| self.program.symbols.get(id.0 as usize))
                    .map(|field| field.name.clone())
                    .collect(),
            });
        }
        view.sort_by(|a, b| a.name.cmp(&b.name));
        view
    }

    /// Lower one checked directive (the checker proved the shapes, so
    /// fallbacks below are unreachable-but-total, never silent).
    fn lower_migration_directive(
        owner: &str,
        directive: &crate::analysis::effects::MigrationDirective,
    ) -> IrMigrationDirective {
        use crate::analysis::effects::MigrationDirective as Directive;
        let qualified = |model: &str| format!("{owner}.{model}");
        match directive {
            Directive::Rename {
                from,
                to,
                owner_only,
                ..
            } => {
                if *owner_only {
                    return IrMigrationDirective::RenameOwner {
                        from: String::new(),
                    };
                }
                let rest = from.strip_prefix("before.").unwrap_or(from.as_str());
                let mut segments = rest.split('.');
                let model = segments.next().unwrap_or("").to_string();
                let field = segments.next().map(str::to_string);
                let to = to.clone().unwrap_or_default();
                match field {
                    // Field targets spell `Model.field`; the intake
                    // carries the field half only.
                    Some(field) => IrMigrationDirective::RenameField {
                        model: qualified(&model),
                        from: field,
                        to: to.split('.').next_back().unwrap_or("").to_string(),
                    },
                    None => IrMigrationDirective::RenameModel {
                        from: qualified(&model),
                        to: qualified(&to),
                    },
                }
            }
            Directive::Drop {
                target, owner_only, ..
            } => {
                if *owner_only {
                    return IrMigrationDirective::DropOwner;
                }
                let rest = target
                    .as_deref()
                    .unwrap_or("")
                    .strip_prefix("before.")
                    .unwrap_or("");
                let mut segments = rest.split('.');
                let model = segments.next().unwrap_or("").to_string();
                let field = segments.next().map(str::to_string);
                match field {
                    Some(field) => IrMigrationDirective::DropField {
                        model: qualified(&model),
                        field,
                    },
                    None => IrMigrationDirective::DropModel {
                        model: qualified(&model),
                    },
                }
            }
            Directive::Invalidate { handler, .. } => IrMigrationDirective::Invalidate {
                handler: handler
                    .strip_prefix("before.")
                    .unwrap_or(handler.as_str())
                    .to_string(),
            },
            Directive::Backfill { model, .. } => IrMigrationDirective::Backfill {
                model: qualified(model),
            },
        }
    }

    /// Builtin references: decoder-observed call sites (true spans) plus
    /// G13 ids from positions the build does not decode (fallback span).
    fn build_referenced_builtins(&self) -> Vec<ReferencedBuiltin> {
        let mut out = self.builtins_seen.clone();
        let fallback = self
            .db
            .iter()
            .next()
            .map(|(id, _)| Span::new(id, 0, 0))
            .unwrap_or(Span::new(SourceId(0), 0, 0));
        for id in &self.program.effects.referenced_builtins {
            if !self.g13_seen.contains(id) {
                out.push(ReferencedBuiltin {
                    id: id.clone(),
                    span: fallback,
                });
            }
        }
        out.sort_by(|a, b| {
            (a.span.file, a.span.start, a.span.end, a.id.clone()).cmp(&(
                b.span.file,
                b.span.start,
                b.span.end,
                b.id.clone(),
            ))
        });
        out
    }

    /// Module `#` description: the set whose owner is the module node.
    fn module_description(
        &mut self,
        module: ModuleId,
        data: &crate::analysis::effects::ModuleData,
    ) -> Option<IrMessage> {
        let app_kind = SyntaxKind::App as u8;
        let package_kind = SyntaxKind::Package as u8;
        let mut candidates = data
            .descriptions
            .iter()
            .filter(|entry| entry.owner.kind == app_kind || entry.owner.kind == package_kind);
        let first = candidates.next()?;
        if candidates.next().is_some() {
            let span = Span::new(first.node.file, first.node.start, first.node.end);
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower module: additional descriptions have no §13 lowering".to_string(),
                span,
            ));
        }
        self.decode_description(module, first)
    }

    /// Attached `#` description for one declaration node (scenario, page).
    fn owner_description(&mut self, module: ModuleId, owner: &NodeKey) -> Option<IrMessage> {
        let data = self.program.effects.modules.get(&module)?;
        let mut candidates = data
            .descriptions
            .iter()
            .filter(|entry| entry.owner == *owner);
        let first = candidates.next()?;
        if candidates.next().is_some() {
            let span = Span::new(first.node.file, first.node.start, first.node.end);
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower declaration: additional descriptions have no §13 lowering"
                    .to_string(),
                span,
            ));
        }
        self.decode_description(module, first)
    }

    /// Decode one description set: prose plus variants, or a lone
    /// `#= path` message reference.
    fn decode_description(
        &mut self,
        module: ModuleId,
        entry: &crate::analysis::effects::DescriptionEntry,
    ) -> Option<IrMessage> {
        if let Some(reference) = &entry.reference {
            let span = Span::new(entry.node.file, entry.node.start, entry.node.end);
            match self.resolve_member(module, reference) {
                Some((id, _))
                    if matches!(
                        self.program.symbols.get(id.0 as usize).map(|s| &s.kind),
                        Some(SymbolKind::Message { .. })
                    ) =>
                {
                    return self
                        .program
                        .effects
                        .messages
                        .get(&id)
                        .map(|data| self.decode_message_data(data));
                }
                _ => {
                    self.gap(
                        format!(
                            "description reference `{reference}` is not published in the analysis tables; omitting the description"
                        ),
                        span,
                    );
                    return None;
                }
            }
        }
        if entry.text.is_empty() {
            return None;
        }
        Some(IrMessage {
            source: entry.text.clone(),
            variants: entry
                .variants
                .iter()
                .map(|v| (v.locale.clone(), v.value.clone()))
                .collect(),
            params: Vec::new(),
        })
    }
}

impl<'a> Cx<'a> {
    /// Decode one page (G9): route, captions, admission, render body.
    fn decode_page(
        &mut self,
        module: ModuleId,
        module_name: &str,
        page: &crate::analysis::effects::PageData,
    ) -> IrPage {
        let span = Span::new(page.node.file, page.node.start, page.node.end);
        let scope = Scope::module(module);
        let node = self.node(&page.node).cloned();
        let title = page.title.as_ref().and_then(|key| {
            // Titles are static captions or context-free message values.
            let title_node = self.node(key)?.clone();
            if title_node.kind == SyntaxKind::MessageValue {
                self.decode_message_node(module, &title_node)
            } else if title_node.kind == SyntaxKind::Literal {
                literal_string(self.db, &title_node).map(|source| IrMessage {
                    source,
                    variants: Vec::new(),
                    params: Vec::new(),
                })
            } else {
                None
            }
        });
        let title = title.unwrap_or_else(|| {
            self.gap(
                "page title is not published in the analysis tables; emitting an empty caption"
                    .to_string(),
                span,
            );
            IrMessage {
                source: String::new(),
                variants: Vec::new(),
                params: Vec::new(),
            }
        });
        let description = self.owner_description(module, &page.node);
        let (path, order, group, nav_none, poll, refresh) = node
            .as_ref()
            .map(|n| self.decode_page_head(module, n))
            .unwrap_or_else(|| ("/".to_string(), None, None, false, None, None));
        let mut admit = Vec::new();
        let mut render = Vec::new();
        if let Some(node) = node.as_ref() {
            for child in kids(node) {
                match child.kind {
                    SyntaxKind::Require => {
                        if let Some(pred) =
                            kids(child).iter().find(|n| is_expression(n.kind)).copied()
                        {
                            admit.push(self.decode_guard_node(&scope, pred));
                        }
                    }
                    // A2b: page-level `require` parses as a `UiLeaf`
                    // (not `Require`); it gates admission, never
                    // renders. Nested container `require` keeps its
                    // gate via `decode_gate`.
                    SyntaxKind::UiLeaf if is_gate_leaf(self.db, child) => {
                        if let Some(pred) =
                            kids(child).iter().find(|n| is_expression(n.kind)).copied()
                        {
                            admit.push(self.decode_guard_node(&scope, pred));
                        }
                    }
                    _ => {
                        if !is_ui_node(child.kind) {
                            continue;
                        }
                        if let Some(ui) = self.decode_ui(&scope, child, None) {
                            render.push(ui);
                        }
                    }
                }
            }
        }
        if page.data.is_some() {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower page {path}: page data has no §13 lowering"),
                span,
            ));
        }
        let fn_name = self.page_fn_name(module_name, &path);
        let descriptor_name = format!("{fn_name}Descriptor");
        IrPage {
            owner: module_name.to_string(),
            path,
            title,
            description,
            order,
            group,
            nav_none,
            poll,
            refresh,
            admit,
            render,
            fn_name,
            descriptor_name,
            span,
        }
    }

    /// Decode the page head: route pattern plus `order`/`group`/`nav`.
    /// `data` has no lowering and stays loud `E6008`. `poll` decodes
    /// the checked constant duration to millis; `refresh` resolves the
    /// named canonical user mutation (DESIGN §9; `refresh` requires
    /// `poll`, checked in types).
    fn decode_page_head(
        &mut self,
        module: ModuleId,
        node: &SyntaxNode,
    ) -> (
        String,
        Option<i128>,
        Option<String>,
        bool,
        Option<i128>,
        Option<String>,
    ) {
        let mut path = "/".to_string();
        let mut order = None;
        let mut group = None;
        let mut nav_none = false;
        let mut poll = None;
        let mut refresh = None;
        for child in kids(node) {
            match child.kind {
                SyntaxKind::Route => {
                    path = self.decode_route(child, node.span);
                }
                SyntaxKind::Attribute => {
                    let parts = kids(child);
                    let name = parts
                        .first()
                        .and_then(|n| name_text(self.db, n))
                        .unwrap_or_default();
                    let value = parts
                        .iter()
                        .find(|n| !matches!(n.kind, SyntaxKind::Name | SyntaxKind::Punct));
                    match name.as_str() {
                        "order" => {
                            if let Some(value) = value
                                && value.kind == SyntaxKind::Literal
                                && let Some(leaf) = kids(value).into_iter().next()
                                && leaf.kind == SyntaxKind::Integer
                                && let Ok(number) = self.text(leaf.span).parse::<i128>()
                            {
                                order = Some(number);
                            } else if let Some(value) = value {
                                self.diags.push(Diagnostic::error(
                                    "E6008",
                                    "cannot lower page order: only constant integers lower"
                                        .to_string(),
                                    value.span,
                                ));
                            }
                        }
                        "group" => {
                            if let Some(value) = value
                                && let Some(text) = static_text(self.db, value)
                            {
                                group = Some(text);
                            } else if let Some(value) = value {
                                self.diags.push(Diagnostic::error(
                                    "E6008",
                                    "cannot lower page group: only static text lowers".to_string(),
                                    value.span,
                                ));
                            }
                        }
                        "nav" => {
                            let spelling = value
                                .and_then(|v| name_text(self.db, v))
                                .unwrap_or_default();
                            if spelling == "none" {
                                nav_none = true;
                            } else if let Some(value) = value {
                                self.diags.push(Diagnostic::error(
                                    "E6008",
                                    format!(
                                        "cannot lower page nav `{spelling}`: only nav=none lowers"
                                    ),
                                    value.span,
                                ));
                            }
                        }
                        "poll" => {
                            // The checker proves a context-free constant
                            // duration (1s..1h); decode the same literal
                            // to millis (shared suffix table above).
                            let duration = value.and_then(|v| match v.kind {
                                SyntaxKind::Duration => Some(*v),
                                SyntaxKind::Literal => {
                                    kids(v).into_iter().find(|l| l.kind == SyntaxKind::Duration)
                                }
                                _ => None,
                            });
                            match duration.and_then(|d| duration_millis(self.text(d.span))) {
                                Some(ms) => poll = Some(ms),
                                None => {
                                    let at = value.map(|v| v.span).unwrap_or(child.span);
                                    self.diags.push(Diagnostic::error(
                                        "E6008",
                                        "cannot lower page poll: only constant durations lower"
                                            .to_string(),
                                        at,
                                    ));
                                }
                            }
                        }
                        "refresh" => {
                            match value.and_then(|v| self.resolve_operation_target(module, v)) {
                                Some(op) => refresh = Some(self.canonical(op)),
                                None => {
                                    let at = value.map(|v| v.span).unwrap_or(child.span);
                                    self.diags.push(Diagnostic::error(
                                        "E6008",
                                        "cannot lower page refresh: only a canonical user mutation lowers"
                                            .to_string(),
                                        at,
                                    ));
                                }
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        (path, order, group, nav_none, poll, refresh)
    }

    /// Normalize a route pattern. Static segments concatenate; dynamic
    /// (record/scalar) segments have no normalized lowering, so the
    /// source spelling is kept loudly (`E6008`).
    fn decode_route(&mut self, route: &SyntaxNode, span: Span) -> String {
        let mut out = String::new();
        let mut dynamic = false;
        for child in kids(route) {
            match child.kind {
                SyntaxKind::Punct => out.push_str(self.text(child.span)),
                SyntaxKind::Name => out.push_str(self.text(child.span)),
                SyntaxKind::RouteStatic => {
                    for part in kids(child) {
                        out.push_str(self.text(part.span));
                    }
                }
                SyntaxKind::RouteRecord | SyntaxKind::RouteScalar => {
                    dynamic = true;
                    out.push_str(self.text(child.span));
                }
                _ => {}
            }
        }
        if out.is_empty() {
            out.push('/');
        }
        if dynamic {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower route {out}: dynamic segments have no normalized §13 lowering; keeping the source spelling"),
                span,
            ));
        }
        out
    }

    /// Deterministic page function name from owner plus path segments.
    fn page_fn_name(&mut self, module: &str, path: &str) -> String {
        let mut name: String = module
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect();
        for segment in path.split('/').filter(|s| !s.is_empty()) {
            let clean: String = segment
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect();
            let mut chars = clean.chars();
            if let Some(first) = chars.next() {
                name.push(first.to_ascii_uppercase());
                name.push_str(chars.as_str());
            }
        }
        if name.is_empty() {
            name.push_str("page");
        }
        name.push_str("Page");
        let mut candidate = name.clone();
        let mut n = 2;
        while !self.page_fns.insert(candidate.clone()) {
            candidate = format!("{name}{n}");
            n += 1;
        }
        candidate
    }

    /// Decode one UI node. `row_ctx` carries the enclosing collection's
    /// `(model, row name)` for bare `edit`/`history` inference.
    fn decode_ui(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        let word = ui_word(self.db, node);
        match node.kind {
            SyntaxKind::Card => {
                self.check_ui_attributes(node, "card", &["layout"]);
                let mut props = Vec::new();
                if let Some(caption) = self.decode_single_ui_caption(scope, node, "card") {
                    props.push(("title".to_string(), caption));
                }
                for (name, value) in ui_attributes(self.db, node) {
                    if name == "layout"
                        && let Some(value) = value
                    {
                        match opens_spelling(self.db, value) {
                            Some(layout) if matches!(layout.as_str(), "stack" | "columns") => props
                                .push((
                                    name,
                                    TypedExpr::new(
                                        IrExpr::Text(layout),
                                        ResolvedType::Scalar(Scalar::Text),
                                        value.span,
                                    ),
                                )),
                            _ => self.diags.push(Diagnostic::error(
                                "E6008",
                                "cannot lower card: layout must be stack or columns".to_string(),
                                value.span,
                            )),
                        }
                    }
                }
                Some(IrUi {
                    factory: "card".to_string(),
                    props,
                    children: self.decode_ui_children(scope, node, row_ctx),
                    row_scope: None,
                    gate: self.decode_gate(scope, node),
                    span: node.span,
                })
            }
            SyntaxKind::Details => {
                self.check_ui_attributes(node, "details", &["open", "id"]);
                let mut props = Vec::new();
                if let Some(caption) = self.decode_single_ui_caption(scope, node, "details") {
                    props.push(("caption".to_string(), caption));
                }
                for (name, value) in ui_attributes(self.db, node) {
                    if matches!(name.as_str(), "open" | "id")
                        && let Some(value) = value
                    {
                        props.push((
                            name.clone(),
                            if name == "id" {
                                match opens_spelling(self.db, value) {
                                    Some(id) => TypedExpr::new(
                                        IrExpr::Text(id),
                                        ResolvedType::Scalar(Scalar::Text),
                                        value.span,
                                    ),
                                    None => self.decode_expr(scope, value),
                                }
                            } else {
                                self.decode_expr(scope, value)
                            },
                        ));
                    }
                }
                let children = self.decode_ui_children(scope, node, row_ctx);
                if children.is_empty() {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        "cannot lower details: collapse needs a nonempty content suite".to_string(),
                        node.span,
                    ));
                }
                Some(IrUi {
                    factory: "collapse".to_string(),
                    props,
                    children,
                    row_scope: None,
                    gate: self.decode_gate(scope, node),
                    span: node.span,
                })
            }
            SyntaxKind::Form => self.decode_form(scope, node, row_ctx),
            SyntaxKind::Collection => self.decode_collection(scope, node, &word),
            SyntaxKind::Tabs => {
                self.check_ui_attributes(node, "tabs", &["size", "variant"]);
                for child in kids(node)
                    .into_iter()
                    .filter(|child| is_ui_node(child.kind) && !is_gate_leaf(self.db, child))
                {
                    if child.kind != SyntaxKind::Tab {
                        self.diags.push(Diagnostic::error("E6008", "cannot lower tabs: only tab item children have an owning factory profile".to_string(), child.span));
                    }
                }
                if let Some(target) = kids(node)
                    .iter()
                    .find(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
                {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        "cannot lower bound tabs: canonical owned preference binding and save lifecycle are not implemented".to_string(),
                        target.span,
                    ));
                    return None;
                }
                // Transient panel identity is independent of its localized
                // caption. These children are structural items, not factories.
                let mut props = vec![(
                    "id".to_string(),
                    TypedExpr::new(
                        IrExpr::Text(format!(
                            "can-tabs-m{}-f{}-s{}",
                            scope.module.0, node.span.file.0, node.span.start
                        )),
                        ResolvedType::Scalar(Scalar::Text),
                        node.span,
                    ),
                )];
                for (name, value) in ui_attributes(self.db, node) {
                    if matches!(name.as_str(), "size" | "variant")
                        && let Some(value) = value
                    {
                        props.push((name.clone(), self.decode_word_attr(scope, &name, value)));
                    }
                }
                let children = kids(node)
                    .iter()
                    .filter(|child| child.kind == SyntaxKind::Tab)
                    .enumerate()
                    .map(|(ordinal, child)| {
                        self.decode_transient_tab(scope, child, ordinal, row_ctx.clone())
                    })
                    .collect();
                let gate = self.decode_gate(scope, node);
                Some(IrUi {
                    factory: "tabs".to_string(),
                    props,
                    children,
                    row_scope: None,
                    gate,
                    span: node.span,
                })
            }
            SyntaxKind::Edit => {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower edit: the bound edit profile has no complete owning form props"
                        .to_string(),
                    node.span,
                ));
                None
            }
            SyntaxKind::UiLeaf => self.decode_leaf(scope, node, &word, row_ctx),
            SyntaxKind::Slot => Some(self.decode_slot(scope, node, row_ctx)),
            SyntaxKind::CatalogItem => self.decode_catalog(scope, node, &word, row_ctx),
            _ => {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    format!(
                        "cannot lower {word}: component has no supported source-to-factory profile"
                    ),
                    node.span,
                ));
                None
            }
        }
    }

    /// Every option must reach its owning factory or fail at the authored option.
    fn check_ui_attributes(&mut self, node: &SyntaxNode, word: &str, admitted: &[&str]) {
        for attr in kids(node)
            .iter()
            .filter(|child| child.kind == SyntaxKind::Attribute)
        {
            let name = kids(attr)
                .first()
                .and_then(|part| name_text(self.db, part))
                .unwrap_or_default();
            let value = ui_attributes(self.db, node)
                .into_iter()
                .find(|(key, _)| key == &name)
                .and_then(|(_, value)| value);
            if !admitted.contains(&name.as_str()) {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    format!("cannot lower {word}: option {name} has no consumed factory profile"),
                    attr.span,
                ));
            } else if value.is_none() {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    format!("cannot lower {word}: option {name} needs an explicit value"),
                    attr.span,
                ));
            }
        }
    }

    fn decode_ui_header_value(&mut self, scope: &Scope, node: &SyntaxNode) -> TypedExpr {
        if node.kind == SyntaxKind::MessageValue
            && let Some(message) = self.decode_message_node(scope.module, node)
        {
            return TypedExpr::new(
                IrExpr::Message(message),
                ResolvedType::Scalar(Scalar::Text),
                node.span,
            );
        }
        self.decode_expr(scope, node)
    }

    /// Captioned factories consume exactly one checked text/message header.
    fn decode_single_ui_caption(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        word: &str,
    ) -> Option<TypedExpr> {
        let headers: Vec<&SyntaxNode> = kids(node)
            .into_iter()
            .filter(|child| is_expression(child.kind) || child.kind == SyntaxKind::MessageValue)
            .collect();
        let [header] = headers.as_slice() else {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower {word}: component needs exactly one text caption"),
                node.span,
            ));
            return None;
        };
        if let Some(message) = self.decode_message_node(scope.module, header) {
            return Some(TypedExpr::new(
                IrExpr::Message(message),
                ResolvedType::Scalar(Scalar::Text),
                header.span,
            ));
        }
        let value = self.decode_expr(scope, header);
        if !matches!(value.ty, ResolvedType::Scalar(Scalar::Text)) {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower {word}: caption has no checked text profile"),
                header.span,
            ));
            return None;
        }
        Some(value)
    }

    /// One transient panel payload consumed only by its owning `tabs`.
    fn decode_transient_tab(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        ordinal: usize,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        self.check_ui_attributes(node, "tab", &[]);
        let caption = self
            .decode_single_ui_caption(scope, node, "tab")
            .unwrap_or_else(|| {
                TypedExpr::new(
                    IrExpr::Unsupported {
                        what: "tab caption".to_string(),
                        why: "missing checked text caption".to_string(),
                    },
                    ResolvedType::Unknown,
                    node.span,
                )
            });
        IrUi {
            factory: "tabItem".to_string(),
            props: vec![
                (
                    "value".to_string(),
                    TypedExpr::new(
                        IrExpr::Text(ordinal.to_string()),
                        ResolvedType::Scalar(Scalar::Text),
                        node.span,
                    ),
                ),
                ("caption".to_string(), caption),
            ],
            children: self.decode_ui_children(scope, node, row_ctx),
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode child UI nodes, skipping captions/attributes/queries.
    /// Gate leaves (`require`) are consumed by [`Cx::decode_gate`], never
    /// rendered as children.
    fn decode_ui_children(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Vec<IrUi> {
        kids(node)
            .iter()
            .filter(|n| is_ui_node(n.kind))
            .filter(|n| !is_gate_leaf(self.db, n))
            .filter_map(|n| self.decode_ui(scope, n, row_ctx.clone()))
            .collect()
    }

    /// Decode the presentation gate of one UI node: direct `require`
    /// leaves conjoin (source order) into the boolean that omits the
    /// gated container when unavailable. `None` when no gate is authored.
    fn decode_gate(&mut self, scope: &Scope, node: &SyntaxNode) -> Option<TypedExpr> {
        let mut gate: Option<TypedExpr> = None;
        for child in kids(node) {
            if !is_gate_leaf(self.db, child) {
                continue;
            }
            let Some(pred) = kids(child).iter().find(|n| is_expression(n.kind)).copied() else {
                continue;
            };
            let next = self.decode_expr(scope, pred);
            gate = Some(match gate {
                None => next,
                Some(done) => {
                    let span = done.span;
                    TypedExpr::new(
                        IrExpr::Binary {
                            op: IrBinOp::And,
                            left: Box::new(done),
                            right: Box::new(next),
                        },
                        ResolvedType::Scalar(Scalar::Bool),
                        span,
                    )
                }
            });
        }
        gate
    }

    /// Decode a catalog component by factory word: profile-shaped
    /// props per the approved component catalog (selectors stay selector
    /// strings, captions stay messages, slots stay named suites).
    /// Factories without a profile keep the generic shape and stay loud
    /// `E6008` at the lowering stage.
    fn decode_catalog(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        word: &str,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        match word {
            "input" | "textarea" | "radio" | "select" => {
                Some(self.decode_field_control(scope, node, word, row_ctx))
            }
            "fieldset" => Some(self.decode_fieldset(scope, node, row_ctx)),
            "fab" => Some(self.decode_fab(scope, node, row_ctx)),
            "chat_bubble" => Some(self.decode_chat_bubble(scope, node, row_ctx)),
            "button" => Some(self.decode_button(scope, node, row_ctx)),
            "modal" | "drawer" => Some(self.decode_modal(scope, node, word, row_ctx)),
            "divider" => Some(self.decode_divider(scope, node, row_ctx)),
            "badge" => Some(self.decode_badge(scope, node, row_ctx)),
            "breadcrumbs" => Some(self.decode_breadcrumbs(scope, node, row_ctx)),
            "pagination" => Some(self.decode_pagination(scope, node, row_ctx)),
            "stat" => Some(self.decode_stat(scope, node, row_ctx)),
            "alert" => Some(self.decode_alert(scope, node, row_ctx)),
            "join" => Some(self.decode_join(scope, node, row_ctx)),
            _ => {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    format!(
                        "cannot lower {word}: component has no supported source-to-factory profile"
                    ),
                    node.span,
                ));
                None
            }
        }
    }

    /// Decode a field-placement control (`input`/`textarea`): the header
    /// selector names an existing writable input of the nearest owning
    /// form, so it lowers to a `field` selector string, never a value.
    /// Controls outside a field owner stay loud `E6008`.
    fn decode_field_control(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        word: &str,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        if !scope.in_field_owner {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower {word}: field controls need an owning form"),
                node.span,
            ));
        }
        let mut props = Vec::new();
        let headers: Vec<&SyntaxNode> = kids(node)
            .iter()
            .filter(|n| is_expression(n.kind))
            .copied()
            .collect();
        match headers.as_slice() {
            [header] => match selector_spelling(self.db, header) {
                Some(selector) => props.push((
                    "field".to_string(),
                    TypedExpr::new(
                        IrExpr::Text(selector),
                        ResolvedType::Scalar(Scalar::Text),
                        header.span,
                    ),
                )),
                None => self.diags.push(Diagnostic::error(
                    "E6008",
                    format!("cannot lower {word}: field controls take an input selector"),
                    header.span,
                )),
            },
            [] => self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower {word}: field controls take an input selector"),
                node.span,
            )),
            _ => self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower {word}: field controls take one input selector"),
                node.span,
            )),
        }
        for (name, value) in ui_attributes(self.db, node) {
            if let Some(value) = value {
                // A2b: radio/select admit tone+size only (F catalog);
                // input/textarea keep the pass-through.
                if (word == "radio" || word == "select")
                    && is_appearance_attr(&name)
                    && !ui_appearance_admitted(word, &name)
                {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        format!("cannot lower {word}: appearance admits tone and size only"),
                        value.span,
                    ));
                    continue;
                }
                props.push((name.clone(), self.decode_word_attr(scope, &name, value)));
            }
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        if !children.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower {word}: field controls take no content suite"),
                node.span,
            ));
        }
        IrUi {
            factory: word.to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode a bound `button`: exactly one binding attribute (`action`,
    /// `submit`, `target`, `opens`). `opens` names a declared local panel,
    /// so it lowers to a string, never a value reference.
    /// Decode a `fieldset`: a captioned group over existing form
    /// fields (A2b). Appearance admits nothing (F catalog).
    fn decode_fieldset(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        let mut props = Vec::new();
        if kids(node)
            .iter()
            .any(|child| is_expression(child.kind) || child.kind == SyntaxKind::MessageValue)
            && let Some(caption) = self.decode_single_ui_caption(scope, node, "fieldset")
        {
            props.push(("caption".to_string(), caption));
        }
        for (name, value) in ui_attributes(self.db, node) {
            if let Some(value) = value {
                if is_appearance_attr(&name) {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        "cannot lower fieldset: appearance admits nothing".to_string(),
                        value.span,
                    ));
                    continue;
                }
                props.push((name.clone(), self.decode_word_attr(scope, &name, value)));
            }
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        if children.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower fieldset: fieldset needs grouped fields".to_string(),
                node.span,
            ));
        }
        IrUi {
            factory: "fieldset".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode a `fab`: buttons only (a compiler-side constraint; F
    /// renders any `PageChildren`). The first button is the main
    /// trigger, the rest are the action suite — emission groups
    /// them as `main`/`actions` (A2b). Appearance admits nothing.
    fn decode_fab(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        let mut props = Vec::new();
        if kids(node).iter().any(|n| is_expression(n.kind)) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower fab: fab takes no positional header".to_string(),
                node.span,
            ));
        }
        for (name, value) in ui_attributes(self.db, node) {
            if let Some(value) = value {
                if is_appearance_attr(&name) {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        "cannot lower fab: appearance admits nothing".to_string(),
                        value.span,
                    ));
                    continue;
                }
                props.push((name.clone(), self.decode_word_attr(scope, &name, value)));
            }
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        for child in &children {
            if child.factory != "button" {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    format!(
                        "cannot lower fab: fab takes buttons only, found {}",
                        child.factory
                    ),
                    child.span,
                ));
            }
        }
        if children.len() < 2 {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower fab: fab needs a main trigger plus action items".to_string(),
                node.span,
            ));
        }
        IrUi {
            factory: "fab".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode a `chat_bubble`: `slot <name>` children group into the
    /// catalog slot props (`content` required, `header`/`avatar`/
    /// `footer` optional); emission dissolves the wrappers (A2b).
    /// Appearance admits tone only (F catalog).
    fn decode_chat_bubble(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        let mut props = Vec::new();
        if kids(node).iter().any(|n| is_expression(n.kind)) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower chat_bubble: chat_bubble takes slot children, not a header"
                    .to_string(),
                node.span,
            ));
        }
        for (name, value) in ui_attributes(self.db, node) {
            if let Some(value) = value {
                if is_appearance_attr(&name) && !ui_appearance_admitted("chat_bubble", &name) {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        "cannot lower chat_bubble: appearance admits tone only".to_string(),
                        value.span,
                    ));
                    continue;
                }
                props.push((name.clone(), self.decode_word_attr(scope, &name, value)));
            }
        }
        let mut children = Vec::new();
        let mut seen_slots = HashSet::new();
        for child in kids(node) {
            if !is_ui_node(child.kind) || is_gate_leaf(self.db, child) {
                continue;
            }
            if child.kind != SyntaxKind::Slot {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower chat_bubble: chat_bubble takes slot children only".to_string(),
                    child.span,
                ));
                continue;
            }
            match slot_name(self.db, child).as_deref() {
                Some("content" | "header" | "avatar" | "footer") => {
                    let name = slot_name(self.db, child).unwrap();
                    if !seen_slots.insert(name.clone()) {
                        self.diags.push(Diagnostic::error(
                            "E6008",
                            format!("cannot lower chat_bubble: duplicate slot {name}"),
                            child.span,
                        ));
                        continue;
                    }
                    if let Some(ui) = self.decode_ui(scope, child, row_ctx.clone()) {
                        children.push(ui);
                    }
                }
                _ => {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        "cannot lower chat_bubble: unknown slot (content, header, avatar, footer)"
                            .to_string(),
                        child.span,
                    ));
                }
            }
        }
        if !children.iter().any(|c| ui_slot_name(c) == Some("content")) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower chat_bubble: chat_bubble needs a content slot".to_string(),
                node.span,
            ));
        }
        IrUi {
            factory: "chatBubble".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    fn decode_button(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        let mut props = Vec::new();
        if kids(node).iter().any(|n| is_expression(n.kind)) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower button: bound controls take no positional header".to_string(),
                node.span,
            ));
        }
        let mut bindings = 0;
        for (name, value) in ui_attributes(self.db, node) {
            let Some(value) = value else { continue };
            match name.as_str() {
                "action" | "submit" | "target" | "opens" => bindings += 1,
                _ => {}
            }
            if name == "opens" {
                match opens_spelling(self.db, value) {
                    Some(target) => props.push((
                        "opens".to_string(),
                        TypedExpr::new(
                            IrExpr::Text(target),
                            ResolvedType::Scalar(Scalar::Text),
                            value.span,
                        ),
                    )),
                    None => self.diags.push(Diagnostic::error(
                        "E6008",
                        "cannot lower button: opens= names a declared local panel".to_string(),
                        value.span,
                    )),
                }
            } else {
                props.push((name.clone(), self.decode_expr(scope, value)));
            }
        }
        if bindings == 0 {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower button: bound controls need one binding".to_string(),
                node.span,
            ));
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        if !children.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower button: bound controls take no content suite".to_string(),
                node.span,
            ));
        }
        IrUi {
            factory: "button".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode an activated `modal`/`drawer`: required caption, optional
    /// `id`, and the closed `content`/`trigger`/`actions` slot schema.
    /// Non-slot suites and missing `content` stay loud `E6008`.
    fn decode_modal(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        word: &str,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        let mut props = Vec::new();
        if let Some(caption) = self.decode_single_ui_caption(scope, node, word) {
            props.push(("caption".to_string(), caption));
        }
        for (name, value) in ui_attributes(self.db, node) {
            let Some(value) = value else { continue };
            if name == "id" {
                match opens_spelling(self.db, value) {
                    Some(id) => props.push((
                        "id".to_string(),
                        TypedExpr::new(
                            IrExpr::Text(id),
                            ResolvedType::Scalar(Scalar::Text),
                            value.span,
                        ),
                    )),
                    None => self.diags.push(Diagnostic::error(
                        "E6008",
                        format!("cannot lower {word}: id= names the activation identity"),
                        value.span,
                    )),
                }
            } else {
                props.push((name.clone(), self.decode_word_attr(scope, &name, value)));
            }
        }
        let mut children = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        for child in kids(node) {
            if !is_ui_node(child.kind) || is_gate_leaf(self.db, child) {
                continue;
            }
            if child.kind != SyntaxKind::Slot {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    format!("cannot lower {word}: activated panels take slot children only"),
                    child.span,
                ));
                continue;
            }
            let Some(name) = slot_name(self.db, child) else {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    format!("cannot lower {word}: slot without a name"),
                    child.span,
                ));
                continue;
            };
            if !matches!(name.as_str(), "content" | "trigger" | "actions") {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    format!("cannot lower {word}: unknown slot `{name}`"),
                    child.span,
                ));
                continue;
            }
            if seen.contains(&name) {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    format!("cannot lower {word}: duplicate slot `{name}`"),
                    child.span,
                ));
                continue;
            }
            seen.push(name);
            children.push(self.decode_slot(scope, child, row_ctx.clone()));
        }
        if !seen.contains(&"content".to_string()) {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower {word}: activated panels need a content slot"),
                node.span,
            ));
        }
        IrUi {
            factory: word.to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode one `slot NAME` suite: the §13 `slot` factory carries its
    /// name plus children; the slotted parent owns schema validation.
    fn decode_slot(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        let mut props = Vec::new();
        self.check_ui_attributes(node, "slot", &[]);
        if kids(node).iter().any(|child| is_expression(child.kind)) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower slot: extra headers have no consumed slot profile".to_string(),
                node.span,
            ));
        }
        match slot_name(self.db, node) {
            Some(name) => props.push((
                "name".to_string(),
                TypedExpr::new(
                    IrExpr::Text(name),
                    ResolvedType::Scalar(Scalar::Text),
                    node.span,
                ),
            )),
            None => self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower slot: slot without a name".to_string(),
                node.span,
            )),
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        IrUi {
            factory: "slot".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode a `divider`: an optional authored caption, never a value.
    fn decode_divider(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        let mut props = Vec::new();
        if kids(node)
            .iter()
            .any(|child| is_expression(child.kind) || child.kind == SyntaxKind::MessageValue)
            && let Some(caption) = self.decode_single_ui_caption(scope, node, "divider")
        {
            props.push(("caption".to_string(), caption));
        }
        for (name, value) in ui_attributes(self.db, node) {
            if let Some(value) = value {
                props.push((name.clone(), self.decode_word_attr(scope, &name, value)));
            }
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        if !children.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower divider: dividers take no content suite".to_string(),
                node.span,
            ));
        }
        IrUi {
            factory: "divider".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode a `badge`: exactly one readable typed value.
    fn decode_badge(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        let mut props = Vec::new();
        let headers: Vec<&SyntaxNode> = kids(node)
            .iter()
            .filter(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
            .copied()
            .collect();
        match headers.as_slice() {
            [header] => props.push((
                "value".to_string(),
                self.decode_ui_header_value(scope, header),
            )),
            _ => self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower badge: badges take one readable value".to_string(),
                node.span,
            )),
        }
        for (name, value) in ui_attributes(self.db, node) {
            if let Some(value) = value {
                props.push((name.clone(), self.decode_word_attr(scope, &name, value)));
            }
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        if !children.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower badge: badges take no content suite".to_string(),
                node.span,
            ));
        }
        IrUi {
            factory: "badge".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode bare `breadcrumbs`: the derived-ancestry leaf consumes the
    /// current declared destination ancestry from its render context, so
    /// no authored ancestry is lowered. `pages=` stays a checked route
    /// selector decoded generically.
    fn decode_breadcrumbs(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        self.diags.push(Diagnostic::error(
            "E6008",
            "cannot lower breadcrumbs: ancestry and label carriers are not implemented".to_string(),
            node.span,
        ));
        let mut props = Vec::new();
        if kids(node).iter().any(|n| is_expression(n.kind)) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower breadcrumbs: derived-ancestry leaves take no header".to_string(),
                node.span,
            ));
        }
        for (name, value) in ui_attributes(self.db, node) {
            if let Some(value) = value {
                props.push((name.clone(), self.decode_expr(scope, value)));
            }
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        if !children.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower breadcrumbs: derived-ancestry leaves take no content suite"
                    .to_string(),
                node.span,
            ));
        }
        IrUi {
            factory: "breadcrumbs".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode bare `pagination`: the shared control consumes its
    /// enclosing collection's admitted cursor/filter/order state, so it
    /// is an error outside a collection context.
    fn decode_pagination(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        self.diags.push(Diagnostic::error(
            "E6008",
            "cannot lower pagination: cursor and label carriers are not implemented".to_string(),
            node.span,
        ));
        let props = Vec::new();
        self.check_ui_attributes(node, "pagination", &[]);
        if kids(node).iter().any(|n| is_expression(n.kind)) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower pagination: the shared control takes no header".to_string(),
                node.span,
            ));
        }
        if row_ctx.is_none() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower pagination: pagination is valid only inside a collection".to_string(),
                node.span,
            ));
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        if !children.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower pagination: the shared control takes no content suite".to_string(),
                node.span,
            ));
        }
        IrUi {
            factory: "pagination".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode `stat expr,...`: the typed metric leaf shares the `values`
    /// array contract with `metrics`. Slotted suites stay loud `E6008`.
    fn decode_stat(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        let mut props = Vec::new();
        let headers: Vec<&SyntaxNode> = kids(node)
            .iter()
            .filter(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
            .copied()
            .collect();
        let children = self.decode_ui_children(scope, node, row_ctx);
        match headers.as_slice() {
            [header] if children.is_empty() => props.push(("value".to_string(), self.decode_ui_header_value(scope, header))),
            _ => self.diags.push(Diagnostic::error("E6008", "cannot lower stat: only one value header without a slotted suite has an owning factory profile".to_string(), node.span)),
        }
        for (name, value) in ui_attributes(self.db, node) {
            if let Some(value) = value {
                props.push((name.clone(), self.decode_word_attr(scope, &name, value)));
            }
        }
        IrUi {
            factory: "stat".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode `alert`: an expression-only leaf or a readable-content
    /// suite (never both); gates omit the notice when unavailable.
    fn decode_alert(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        let mut props = Vec::new();
        let headers: Vec<&SyntaxNode> = kids(node)
            .iter()
            .filter(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
            .copied()
            .collect();
        let children = self.decode_ui_children(scope, node, row_ctx);
        match (headers.as_slice(), children.is_empty()) {
            ([header], true) => props.push((
                "value".to_string(),
                self.decode_ui_header_value(scope, header),
            )),
            ([], true) => self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower alert: alerts need a notice value or a content suite".to_string(),
                node.span,
            )),
            (_, false) if !headers.is_empty() => self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower alert: alerts take a notice value or a suite, not both".to_string(),
                node.span,
            )),
            (_, true) => self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower alert: alerts take exactly one notice value".to_string(),
                node.span,
            )),
            _ => {}
        }
        for (name, value) in ui_attributes(self.db, node) {
            if let Some(value) = value {
                props.push((name.clone(), self.decode_word_attr(scope, &name, value)));
            }
        }
        IrUi {
            factory: "alert".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode `join`: the scope-transparent group owns a nonempty content
    /// suite and creates no business scope.
    fn decode_join(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        let props = Vec::new();
        self.check_ui_attributes(node, "join", &[]);
        if kids(node).iter().any(|n| is_expression(n.kind)) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower join: groups take no header".to_string(),
                node.span,
            ));
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        if children.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower join: groups need a nonempty content suite".to_string(),
                node.span,
            ));
        }
        IrUi {
            factory: "join".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode one catalog attribute value: finite word options
    /// (`tone`/`size`/`variant`/`orientation`) lower to their spelling
    /// strings; every other attribute decodes as an expression.
    fn decode_word_attr(&mut self, scope: &Scope, name: &str, value: &SyntaxNode) -> TypedExpr {
        if matches!(name, "tone" | "size" | "variant" | "orientation")
            && let Some(word) = opens_spelling(self.db, value)
        {
            return TypedExpr::new(
                IrExpr::Text(word),
                ResolvedType::Scalar(Scalar::Text),
                value.span,
            );
        }
        self.decode_expr(scope, value)
    }

    /// Decode a `form` node: operation plus display/arguments/fields/submit.
    fn decode_form(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        let mut props = Vec::new();
        let target = kids(node)
            .iter()
            .find(|n| {
                matches!(
                    n.kind,
                    SyntaxKind::Member | SyntaxKind::Path | SyntaxKind::NameRef
                )
            })
            .copied();
        let mut operation_target: Option<SymbolId> = None;
        if let Some(target) = target
            && let Some(op) = self.resolve_operation_target(scope.module, target)
        {
            operation_target = Some(op);
            props.push((
                "operation".to_string(),
                TypedExpr::new(
                    IrExpr::Text(self.canonical(op)),
                    ResolvedType::Scalar(Scalar::Text),
                    target.span,
                ),
            ));
        }
        for (name, value) in ui_attributes(self.db, node) {
            match name.as_str() {
                "display" => {
                    if let Some(value) = value {
                        let text = display_text(self.db, value);
                        props.push((
                            "display".to_string(),
                            TypedExpr::new(
                                IrExpr::Text(text),
                                ResolvedType::Scalar(Scalar::Text),
                                value.span,
                            ),
                        ));
                    }
                }
                "arguments" | "submit" => {
                    if let Some(value) = value {
                        props.push((name, self.decode_expr(scope, value)));
                    }
                }
                "fields" => {
                    if let Some(value) = value {
                        let fields = selector_strings(self.db, value);
                        let span = value.span;
                        props.push((
                            "fields".to_string(),
                            TypedExpr::new(
                                IrExpr::Array(
                                    fields
                                        .iter()
                                        .map(|f| {
                                            TypedExpr::new(
                                                IrExpr::Text(f.clone()),
                                                ResolvedType::Scalar(Scalar::Text),
                                                span,
                                            )
                                        })
                                        .collect(),
                                ),
                                ResolvedType::Unknown,
                                span,
                            ),
                        ));
                    }
                }
                _ => {}
            }
        }
        // Absent `fields=` defaults from the resolved target op (explicit
        // wins; unresolvable targets keep no prop and stay loud in ui).
        let has_fields = props.iter().any(|(name, _)| name == "fields");
        if !has_fields
            && let Some(op) = operation_target
            && let Some(defaults) = self.default_form_fields(op)
            && !defaults.is_empty()
        {
            let span = target.map(|t| t.span).unwrap_or(node.span);
            props.push((
                "fields".to_string(),
                TypedExpr::new(
                    IrExpr::Array(
                        defaults
                            .iter()
                            .map(|f| {
                                TypedExpr::new(
                                    IrExpr::Text(f.clone()),
                                    ResolvedType::Scalar(Scalar::Text),
                                    span,
                                )
                            })
                            .collect(),
                    ),
                    ResolvedType::Unknown,
                    span,
                ),
            ));
        }
        // The form owns field placement for its suite.
        let mut owned = scope.clone();
        owned.in_field_owner = true;
        let children = self.decode_ui_children(&owned, node, row_ctx);
        let gate = self.decode_gate(scope, node);
        Some(IrUi {
            factory: "form".to_string(),
            props,
            children,
            row_scope: None,
            gate,
            span: node.span,
        })
    }

    /// Resolve a `Model.op`/`scenario` operation reference to its
    /// canonical identity (total).
    fn decode_operation_ref(&mut self, module: ModuleId, node: &SyntaxNode) -> Option<String> {
        self.resolve_operation_target(module, node)
            .map(|id| self.canonical(id))
    }

    /// Resolve a `Model.op`/`scenario`/`Cap.op` operation reference to
    /// its target symbol (`None` when unresolvable).
    fn resolve_operation_target(&self, module: ModuleId, node: &SyntaxNode) -> Option<SymbolId> {
        match node.kind {
            SyntaxKind::Member => {
                let parts = kids(node);
                let base = parts.iter().find(|n| is_expression(n.kind)).copied()?;
                let op = parts.iter().rev().find_map(|n| name_text(self.db, n))?;
                let base_name = match base.kind {
                    SyntaxKind::NameRef => kids(base).iter().find_map(|n| name_text(self.db, n))?,
                    _ => return None,
                };
                let (model, _) = self.resolve_member(module, &base_name)?;
                let crud_op = match op.as_str() {
                    "create" => CrudOp::Create,
                    "update" => CrudOp::Update,
                    "delete" => CrudOp::Delete,
                    _ => {
                        // Capability operations (`Cap.op`).
                        return self.capability_op(module, &base_name, &op);
                    }
                };
                self.program.symbols.iter().find_map(|s| match &s.kind {
                    SymbolKind::CrudOp { model: m, op: o } if *m == model && *o == crud_op => {
                        Some(s.id)
                    }
                    _ => None,
                })
            }
            SyntaxKind::NameRef | SyntaxKind::Path => {
                let name = match node.kind {
                    SyntaxKind::Path => path_text(self.db, node),
                    _ => kids(node).iter().find_map(|n| name_text(self.db, n))?,
                };
                let (id, _) = self.resolve_member(module, &name)?;
                match self.program.symbols.get(id.0 as usize).map(|s| &s.kind) {
                    Some(SymbolKind::Scenario { .. }) => Some(id),
                    _ => None,
                }
            }
            _ => None,
        }
    }

    /// Default `fields` for a form whose `fields=` attribute is absent:
    /// create/update CRUD ops default to their checked writable stored
    /// fields in schema order (derived and server fields are never inputs);
    /// scenarios with inputs default to their parameter names. Delete ops,
    /// capability ops and unknown targets stay loud (no default).
    fn default_form_fields(&self, op: SymbolId) -> Option<Vec<String>> {
        match &self.program.symbols.get(op.0 as usize)?.kind {
            SymbolKind::CrudOp {
                model,
                op: operation,
            } => match operation {
                CrudOp::Create | CrudOp::Update => {
                    let operation = self.program.effects.crud_ops.get(&op)?;
                    let model = self.program.effects.models.get(model)?;
                    Some(
                        model
                            .fields
                            .iter()
                            .filter_map(|data| {
                                if data.server.is_some() {
                                    return None;
                                }
                                let field = self.program.symbols.get(data.field.0 as usize)?;
                                // Match operation publication: dotted selectors
                                // admit their top-level field; an empty allowlist
                                // admits every caller-writable stored field.
                                (operation.fields.is_empty()
                                    || operation.fields.iter().any(|path| {
                                        path.split('.').next() == Some(field.name.as_str())
                                    }))
                                .then(|| field.name.clone())
                            })
                            .collect(),
                    )
                }
                CrudOp::Delete => None,
            },
            SymbolKind::Scenario { params, .. } => {
                if params.is_empty() {
                    return None;
                }
                Some(
                    params
                        .iter()
                        .filter_map(|id| {
                            self.program
                                .symbols
                                .get(id.0 as usize)
                                .map(|symbol| symbol.name.clone())
                        })
                        .collect(),
                )
            }
            _ => None,
        }
    }

    /// Capability-op symbol for `Cap.op` in `module` (total).
    fn capability_op(&self, module: ModuleId, cap: &str, op: &str) -> Option<SymbolId> {
        let (id, _) = self.resolve_member(module, cap)?;
        let symbol = self.program.symbols.get(id.0 as usize)?;
        match &symbol.kind {
            SymbolKind::Capability { ops, .. } => ops.iter().find_map(|op_id| {
                let op_symbol = self.program.symbols.get(op_id.0 as usize)?;
                if op_symbol.name == *op {
                    Some(*op_id)
                } else {
                    None
                }
            }),
            _ => None,
        }
    }

    /// Resolve a collection/query domain head to its model.
    fn collection_head_model(&self, module: ModuleId, head: &SyntaxNode) -> Option<SymbolId> {
        let name = match head.kind {
            SyntaxKind::NameRef => kids(head).iter().find_map(|n| name_text(self.db, n))?,
            SyntaxKind::Path => path_text(self.db, head),
            _ => return None,
        };
        let (id, _) = self.resolve_member(module, &name)?;
        match self.program.symbols.get(id.0 as usize).map(|s| &s.kind) {
            Some(SymbolKind::Model { .. }) => Some(id),
            _ => None,
        }
    }

    /// Stored child navigation is a query, while declared fields remain values.
    fn contained_collection_head<'n>(
        &self,
        head: &'n SyntaxNode,
    ) -> Option<(SymbolId, &'n SyntaxNode)> {
        if head.kind != SyntaxKind::Member {
            return None;
        }
        let parts = kids(head);
        let base = *parts.iter().find(|node| is_expression(node.kind))?;
        let field = parts
            .iter()
            .rev()
            .find_map(|node| name_text(self.db, node))?;
        let ResolvedType::Record {
            symbol: parent,
            stored: true,
        } = self.node_type(base)
        else {
            return None;
        };
        if self.fields.contains_key(&(parent, field.clone())) {
            return None;
        }
        let ResolvedType::Array { element, .. } = self.node_type(head) else {
            return None;
        };
        let ResolvedType::Record {
            symbol: child,
            stored: true,
        } = element.as_ref()
        else {
            return None;
        };
        let candidate = self.program.symbols.get(child.0 as usize)?;
        if candidate.name == field
            && matches!(candidate.kind, SymbolKind::Model { owner: ModelOwner::ChildOf(owner), .. } if owner == parent)
        {
            Some((*child, base))
        } else {
            None
        }
    }

    /// Decode a collection (`list`/`table`/`gallery`): model, query
    /// props, presentation props, and row children under `renderRow`.
    fn decode_collection(&mut self, scope: &Scope, node: &SyntaxNode, word: &str) -> Option<IrUi> {
        let mut props = Vec::new();
        if !matches!(word, "list" | "table") {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!(
                    "cannot lower {word}: collection has no supported source-to-factory profile"
                ),
                node.span,
            ));
            return None;
        }
        let admitted: &[&str] = if word == "table" {
            &["parent", "empty", "limit", "cursor", "columns", "order"]
        } else {
            &["parent", "empty", "limit", "cursor", "order"]
        };
        self.check_ui_attributes(node, word, admitted);
        if kids(node)
            .iter()
            .filter(|child| is_expression(child.kind))
            .count()
            > 1
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!(
                    "cannot lower {word}: extra collection headers have no consumed factory profile"
                ),
                node.span,
            ));
        }
        let query = kids(node)
            .iter()
            .find(|n| n.kind == SyntaxKind::Query)
            .copied();
        // Clauses-less collections carry a bare model head instead of a
        // query node.
        let head = query
            .and_then(|query| kids(query).iter().find(|n| is_expression(n.kind)).copied())
            .or_else(|| {
                kids(node)
                    .iter()
                    .find(|n| matches!(n.kind, SyntaxKind::NameRef | SyntaxKind::Path))
                    .copied()
            });
        let mut model_id = None;
        if let Some(head) = head
            && let Some(id) = self.collection_head_model(scope.module, head)
        {
            model_id = Some(id);
            props.push((
                "model".to_string(),
                TypedExpr::new(
                    IrExpr::Text(self.canonical(id)),
                    ResolvedType::Scalar(Scalar::Text),
                    head.span,
                ),
            ));
        }
        let mut as_name: Option<String> = None;
        if let Some(query) = query {
            let parts = kids(query);
            for clause in parts.iter().filter(|n| n.kind == SyntaxKind::QueryClause) {
                let clause_parts = kids(clause);
                let keyword = clause_parts
                    .iter()
                    .find_map(|n| name_text(self.db, n))
                    .unwrap_or_default();
                match keyword.as_str() {
                    "as" => {
                        as_name = clause_parts
                            .iter()
                            .rev()
                            .find_map(|n| name_text(self.db, n));
                    }
                    "where" => {
                        if let Some(pred) =
                            clause_parts.iter().find(|n| is_expression(n.kind)).copied()
                        {
                            let param = as_name.clone().unwrap_or_else(|| "row".to_string());
                            // The alias shadows fixtures inside the
                            // predicate (it binds the lambda parameter).
                            let mut inner = scope.clone();
                            inner.row_rewrite.insert(param.clone(), param.clone());
                            let body = self.decode_expr(&inner, pred);
                            props.push((
                                "where".to_string(),
                                TypedExpr::new(
                                    IrExpr::Lambda {
                                        param,
                                        body: Box::new(body),
                                    },
                                    ResolvedType::Unknown,
                                    pred.span,
                                ),
                            ));
                        }
                    }
                    _ => self.diags.push(Diagnostic::error("E6008", format!("cannot lower collection: query clause {keyword} has no consumed factory profile"), clause.span)),
                }
            }
        }
        for (name, value) in ui_attributes(self.db, node) {
            let Some(value) = value else { continue };
            if !admitted.contains(&name.as_str()) {
                continue;
            }
            if name == "order" {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower collection order: the owning query profile does not forward authored ordering".to_string(),
                    value.span,
                ));
                continue;
            }
            match name.as_str() {
                "search" | "filter" | "columns" => {
                    let strings = if value.kind == SyntaxKind::Selectors {
                        kids(value)
                            .iter()
                            .flat_map(|path| {
                                self.program
                                    .types
                                    .delivery_selectors
                                    .get(&NodeKey::of(path))
                                    .map(|canonical| vec![canonical.clone()])
                                    .unwrap_or_else(|| selector_strings(self.db, path))
                            })
                            .collect()
                    } else {
                        selector_strings(self.db, value)
                    };
                    let span = value.span;
                    props.push((
                        name,
                        TypedExpr::new(
                            IrExpr::Array(
                                strings
                                    .iter()
                                    .map(|s| {
                                        TypedExpr::new(
                                            IrExpr::Text(s.clone()),
                                            ResolvedType::Scalar(Scalar::Text),
                                            span,
                                        )
                                    })
                                    .collect(),
                            ),
                            ResolvedType::Unknown,
                            span,
                        ),
                    ));
                }
                "empty" => {
                    if let Some(message) = self.decode_message_node(scope.module, value) {
                        props.push((
                            "empty".to_string(),
                            TypedExpr::new(
                                IrExpr::Message(message),
                                ResolvedType::Scalar(Scalar::Text),
                                value.span,
                            ),
                        ));
                    }
                }
                "display" => {
                    props.push((
                        "display".to_string(),
                        TypedExpr::new(
                            IrExpr::Text(display_text(self.db, value)),
                            ResolvedType::Scalar(Scalar::Text),
                            value.span,
                        ),
                    ));
                }
                "parent" | "limit" | "cursor" => {
                    props.push((name, self.decode_expr(scope, value)));
                }
                "image" => {
                    if let Some(field) = name_text(self.db, value).or_else(|| {
                        if value.kind == SyntaxKind::Path {
                            Some(path_text(self.db, value))
                        } else {
                            None
                        }
                    }) {
                        props.push((
                            "image".to_string(),
                            TypedExpr::new(
                                IrExpr::Text(field),
                                ResolvedType::Scalar(Scalar::Text),
                                value.span,
                            ),
                        ));
                    }
                }
                _ => {}
            }
        }
        // Row scope: the name the row children actually use (the `as`
        // name when referenced, else `row`); mixed scopes stay loud.
        let child_nodes: Vec<&SyntaxNode> = kids(node)
            .iter()
            .filter(|n| is_ui_node(n.kind))
            .copied()
            .collect();
        if word == "table" && !child_nodes.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower table: authored row children have no owning renderRow profile"
                    .to_string(),
                child_nodes[0].span,
            ));
        }
        let mut uses_as = false;
        let mut uses_row = false;
        for child in &child_nodes {
            let (child_as, child_row) = ui_row_refs(self.db, child, as_name.as_deref());
            uses_as = uses_as || child_as;
            uses_row = uses_row || child_row;
        }
        let row_name = match (as_name.clone(), uses_as, uses_row) {
            (Some(alias), true, true) => {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower collection: row children mix the query alias with `row`"
                        .to_string(),
                    node.span,
                ));
                alias
            }
            (Some(alias), true, false) => alias,
            _ => "row".to_string(),
        };
        let row_ctx = model_id.map(|id| (id, row_name.clone()));
        // A collection scope ends field placement unless a nested owner
        // re-establishes it.
        let mut unowned = scope.clone();
        unowned.in_field_owner = false;
        let children = child_nodes
            .iter()
            .filter(|n| !is_gate_leaf(self.db, n))
            .filter_map(|n| self.decode_ui(&unowned, n, row_ctx.clone()))
            .collect();
        let gate = self.decode_gate(scope, node);
        Some(IrUi {
            factory: word.to_string(),
            props,
            children,
            row_scope: (word == "list").then_some((row_name, "rowView".to_string())),
            gate,
            span: node.span,
        })
    }

    /// Decode a bare `delete` leaf to the `deleteRecord`
    /// confirmation card (A2b). The row record and delete operation
    /// mirror bare `edit`; the compiler supplies every required
    /// `DeleteProps` member (F verdict): `action` posts to the
    /// canonical operation endpoint, `operationId` is the operation
    /// seed (the runtime owns intent minting), `mode` is `archive`
    /// for bare deletes (no remove spelling exists in grammar),
    /// `itemLabel` is the model label (or name), and `idPrefix` is
    /// a per-model slug.
    fn decode_delete_leaf(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        let mut props = Vec::new();
        let Some((model, row)) = row_ctx else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower delete: delete needs a row record".to_string(),
                node.span,
            ));
            return IrUi {
                factory: "deleteRecord".to_string(),
                props,
                children: Vec::new(),
                row_scope: None,
                gate: self.decode_gate(scope, node),
                span: node.span,
            };
        };
        let op = self.program.symbols.iter().find_map(|s| match &s.kind {
            SymbolKind::CrudOp { model: m, op } if *m == model && *op == CrudOp::Delete => {
                Some(s.id)
            }
            _ => None,
        });
        let Some(op) = op else {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!(
                    "cannot lower delete: {} has no delete operation",
                    self.local_name(model)
                ),
                node.span,
            ));
            return IrUi {
                factory: "deleteRecord".to_string(),
                props,
                children: Vec::new(),
                row_scope: None,
                gate: self.decode_gate(scope, node),
                span: node.span,
            };
        };
        let canonical = self.canonical(op);
        let model_canonical = self.canonical(model);
        let name = self.local_name(model);
        let text = |value: String| {
            TypedExpr::new(
                IrExpr::Text(value),
                ResolvedType::Scalar(Scalar::Text),
                node.span,
            )
        };
        props.push(("operation".to_string(), text(canonical.clone())));
        props.push((
            "record".to_string(),
            TypedExpr::new(IrExpr::Name(row), ResolvedType::Unknown, node.span),
        ));
        props.push(("mode".to_string(), text("archive".to_string())));
        props.push((
            "action".to_string(),
            text(format!("/api/operations/{canonical}")),
        ));
        props.push(("operationId".to_string(), text(canonical.clone())));
        let label_key = self
            .program
            .effects
            .models
            .get(&model)
            .and_then(|data| data.label);
        let label = label_key
            .as_ref()
            .and_then(|key| self.decode_message_value(scope.module, key));
        match label {
            Some(caption) => props.push((
                "itemLabel".to_string(),
                TypedExpr::new(
                    IrExpr::Message(caption),
                    ResolvedType::Scalar(Scalar::Text),
                    node.span,
                ),
            )),
            None => props.push(("itemLabel".to_string(), text(name.clone()))),
        }
        props.push(("confirm".to_string(), text(format!("Archive this {name}?"))));
        props.push((
            "idPrefix".to_string(),
            text(format!("delete-{}", model_canonical.replace('.', "-"))),
        ));
        IrUi {
            factory: "deleteRecord".to_string(),
            props,
            children: Vec::new(),
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode a `UiLeaf` (`text`, `history`, `metrics`, `actions`, ...).
    fn decode_leaf(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        word: &str,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        if matches!(word, "metrics" | "copy" | "action" | "actions" | "history") {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!(
                    "cannot lower {word}: the source profile has no complete owning factory payload"
                ),
                node.span,
            ));
            return None;
        }
        // A2b: `delete` maps to the `deleteRecord` js name with
        // inferred props; every other leaf keeps its word.
        if word == "delete" {
            return Some(self.decode_delete_leaf(scope, node, row_ctx));
        }
        let mut props = Vec::new();
        match word {
            "text" => {
                let values: Vec<TypedExpr> = kids(node)
                    .iter()
                    .filter(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
                    .map(|n| self.decode_ui_header_value(scope, n))
                    .collect();
                props.push((
                    "values".to_string(),
                    TypedExpr::new(IrExpr::Array(values), ResolvedType::Unknown, node.span),
                ));
            }
            "history" => {
                if let Some((_, row)) = &row_ctx {
                    props.push((
                        "record".to_string(),
                        TypedExpr::new(IrExpr::Name(row.clone()), ResolvedType::Unknown, node.span),
                    ));
                }
            }
            "metrics" => {
                // `metrics result.count,result.total`: the value roots
                // select the rendered record.
                let exprs: Vec<TypedExpr> = kids(node)
                    .iter()
                    .filter(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
                    .map(|n| self.decode_ui_header_value(scope, n))
                    .collect();
                props.push((
                    "values".to_string(),
                    TypedExpr::new(IrExpr::Array(exprs), ResolvedType::Unknown, node.span),
                ));
            }
            "actions" | "action" => {
                let operations: Vec<String> = kids(node)
                    .iter()
                    .filter(|n| {
                        matches!(
                            n.kind,
                            SyntaxKind::Member | SyntaxKind::NameRef | SyntaxKind::Path
                        )
                    })
                    .filter_map(|n| self.decode_operation_ref(scope.module, n))
                    .collect();
                let span = node.span;
                props.push((
                    "operations".to_string(),
                    TypedExpr::new(
                        IrExpr::Array(
                            operations
                                .iter()
                                .map(|op| {
                                    TypedExpr::new(
                                        IrExpr::Text(op.clone()),
                                        ResolvedType::Scalar(Scalar::Text),
                                        span,
                                    )
                                })
                                .collect(),
                        ),
                        ResolvedType::Unknown,
                        span,
                    ),
                ));
                if let Some((_, row)) = &row_ctx {
                    // The row record binds the actions; shorthand keeps
                    // the source binding name.
                    props.push((
                        "boundArgs".to_string(),
                        TypedExpr::new(
                            IrExpr::Object(vec![(
                                row.clone(),
                                TypedExpr::new(
                                    IrExpr::Name(row.clone()),
                                    ResolvedType::Unknown,
                                    span,
                                ),
                            )]),
                            ResolvedType::Unknown,
                            span,
                        ),
                    ));
                }
            }
            "content" | "title" => {
                let key = if word == "title" { "text" } else { "value" };
                if let Some(value) = self.decode_single_ui_caption(scope, node, word) {
                    props.push((key.to_string(), value));
                }
            }
            _ => {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    format!(
                        "cannot lower {word}: component has no supported source-to-factory profile"
                    ),
                    node.span,
                ));
                return None;
            }
        }
        for (name, value) in ui_attributes(self.db, node) {
            if let Some(value) = value {
                props.push((name, self.decode_expr(scope, value)));
            }
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        let gate = self.decode_gate(scope, node);
        Some(IrUi {
            factory: word.to_string(),
            props,
            children,
            row_scope: None,
            gate,
            span: node.span,
        })
    }
}

/// Whether `kind` is a render-body UI node.
fn is_ui_node(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::Card
            | SyntaxKind::Details
            | SyntaxKind::Tabs
            | SyntaxKind::Tab
            | SyntaxKind::Collection
            | SyntaxKind::Form
            | SyntaxKind::Edit
            | SyntaxKind::CatalogItem
            | SyntaxKind::Slot
            | SyntaxKind::PreferencePanel
            | SyntaxKind::UiLeaf
            | SyntaxKind::PreferenceOrder
            | SyntaxKind::OrderList
            | SyntaxKind::OrderCases
            | SyntaxKind::OrderCase
    )
}

/// Whether `node` is a presentation gate: a `require` leaf gating its
/// enclosing render container (page-level `Require` nodes gate admission
/// instead and are decoded by the page, never here).
fn is_gate_leaf(db: &SourceDb, node: &SyntaxNode) -> bool {
    node.kind == SyntaxKind::UiLeaf && ui_word(db, node) == "require"
}

/// Slot name of a decoded `slot` node (`None` for anything else),
/// for grouping slotted suites at emission (A2b `chatBubble`).
pub fn ui_slot_name(node: &IrUi) -> Option<&str> {
    if node.factory != "slot" {
        return None;
    }
    node.props.iter().find_map(|(key, value)| {
        if key == "name" {
            match &value.expr {
                IrExpr::Text(name) => Some(name.as_str()),
                _ => None,
            }
        } else {
            None
        }
    })
}

/// Whether an appearance attribute is admitted on an A2b UI node
/// (F catalog rule: absent appearance admits nothing — radio/select
/// take tone+size, chat_bubble tone only, the rest nothing).
fn ui_appearance_admitted(word: &str, name: &str) -> bool {
    match word {
        "radio" | "select" => matches!(name, "tone" | "size"),
        "chat_bubble" => name == "tone",
        _ => false,
    }
}

/// Whether an attribute name is an appearance knob (the closed set
/// `decode_word_attr` lowers to spelling strings).
fn is_appearance_attr(name: &str) -> bool {
    matches!(name, "tone" | "size" | "variant" | "orientation")
}

/// Input-selector spelling of a field-control header (`NameRef` or
/// `Path`); structural input paths keep their dots.
fn selector_spelling(db: &SourceDb, node: &SyntaxNode) -> Option<String> {
    match node.kind {
        SyntaxKind::NameRef => kids(node).iter().find_map(|n| name_text(db, n)),
        SyntaxKind::Path => Some(path_text(db, node)),
        _ => None,
    }
}

/// Panel/activation-name spelling of an `opens=`/`id=`/word-option
/// value: a bare name/path or a string literal.
fn opens_spelling(db: &SourceDb, node: &SyntaxNode) -> Option<String> {
    match node.kind {
        SyntaxKind::NameRef => kids(node).iter().find_map(|n| name_text(db, n)),
        SyntaxKind::Path => Some(path_text(db, node)),
        SyntaxKind::Literal => literal_string(db, node),
        _ => None,
    }
}

/// Slot name of a `slot NAME` node (the name after the `slot` head).
fn slot_name(db: &SourceDb, node: &SyntaxNode) -> Option<String> {
    let mut names = kids(node).into_iter().filter_map(|n| name_text(db, n));
    names.next()?;
    names.next()
}

/// Factory word of a UI node (the leading name, lowercased).
fn ui_word(db: &SourceDb, node: &SyntaxNode) -> String {
    kids(node)
        .iter()
        .find_map(|n| name_text(db, n))
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// `(name, value)` pairs of attribute children.
fn ui_attributes<'n>(db: &SourceDb, node: &'n SyntaxNode) -> Vec<(String, Option<&'n SyntaxNode>)> {
    kids(node)
        .iter()
        .filter(|n| n.kind == SyntaxKind::Attribute)
        .map(|attr| {
            let parts = kids(attr);
            let name = parts
                .first()
                .and_then(|n| name_text(db, n))
                .unwrap_or_default();
            let value = parts
                .iter()
                .find(|n| !matches!(n.kind, SyntaxKind::Name | SyntaxKind::Punct))
                .copied();
            (name, value)
        })
        .collect()
}

/// Scan a row-child subtree for references to the query alias vs
/// `row`. Nested collections bind their own row scope, so the scan
/// descends into their queries/attributes but not their render children.
fn ui_row_refs(db: &SourceDb, node: &SyntaxNode, alias: Option<&str>) -> (bool, bool) {
    let mut uses_as = false;
    let mut uses_row = false;
    ui_row_refs_into(db, node, alias, true, &mut uses_as, &mut uses_row);
    (uses_as, uses_row)
}

/// Recursive worker for [`ui_row_refs`].
fn ui_row_refs_into(
    db: &SourceDb,
    node: &SyntaxNode,
    alias: Option<&str>,
    nested: bool,
    uses_as: &mut bool,
    uses_row: &mut bool,
) {
    match node.kind {
        SyntaxKind::NameRef => {
            if let Some(name) = kids(node).iter().find_map(|n| name_text(db, n)) {
                if Some(name.as_str()) == alias {
                    *uses_as = true;
                }
                if name == "row" {
                    *uses_row = true;
                }
            }
            return;
        }
        SyntaxKind::Member => {
            // Only the base can be a row reference; fields are names.
            if let Some(base) = kids(node).iter().find(|n| is_expression(n.kind)) {
                ui_row_refs_into(db, base, alias, false, uses_as, uses_row);
            }
            return;
        }
        SyntaxKind::Collection if nested => {
            // Own row scope: scan the query and attributes only.
            for child in kids(node) {
                if matches!(
                    child.kind,
                    SyntaxKind::Query | SyntaxKind::Attribute | SyntaxKind::MessageValue
                ) {
                    ui_row_refs_into(db, child, alias, false, uses_as, uses_row);
                }
            }
            return;
        }
        _ => {}
    }
    for child in kids(node) {
        ui_row_refs_into(db, child, alias, true, uses_as, uses_row);
    }
}

/// Selector spellings of a `Selectors` value (`-field` keeps its minus).
fn selector_strings(db: &SourceDb, node: &SyntaxNode) -> Vec<String> {
    match node.kind {
        SyntaxKind::Selectors => kids(node)
            .iter()
            .flat_map(|n| selector_strings(db, n))
            .collect(),
        SyntaxKind::Descending => {
            let field = kids(node)
                .iter()
                .find_map(|n| {
                    if n.kind == SyntaxKind::Path {
                        Some(path_text(db, n))
                    } else {
                        None
                    }
                })
                .unwrap_or_default();
            vec![format!("-{field}")]
        }
        SyntaxKind::Path => vec![path_text(db, node)],
        _ => Vec::new(),
    }
}

/// Static text of a caption-ish value (message value or string literal).
fn static_text(db: &SourceDb, node: &SyntaxNode) -> Option<String> {
    match node.kind {
        SyntaxKind::MessageValue => kids(node).iter().find_map(|n| {
            if n.kind == SyntaxKind::Literal {
                literal_string(db, n)
            } else {
                None
            }
        }),
        SyntaxKind::Literal => literal_string(db, node),
        _ => None,
    }
}

/// Display word of a `display=` value.
fn display_text(db: &SourceDb, node: &SyntaxNode) -> String {
    match node.kind {
        SyntaxKind::NameRef => kids(node)
            .iter()
            .find_map(|n| name_text(db, n))
            .unwrap_or_default(),
        _ => static_text(db, node).unwrap_or_default(),
    }
}

/// Decode one fixture recipe (G10): values re-read span-anchored
/// from the recipe node, classified by tables (fixture targets, model
/// field types) and closed language rules only.
impl<'a> Cx<'a> {
    fn decode_fixture(
        &mut self,
        symbol: &crate::analysis::resolve::Symbol,
        target: &FixtureTarget,
    ) -> Option<IrFixture> {
        let recipe = self
            .program
            .examples
            .fixtures
            .iter()
            .find(|r| r.symbol == symbol.id)
            .cloned();
        let Some(recipe) = recipe else {
            self.gap(
                format!(
                    "fixture {}: recipe values are not in the analysis tables (PR5 examples); emitting a failing recipe shell",
                    symbol.canonical,
                ),
                symbol.span,
            );
            return None;
        };
        let node = self.node(&recipe.node).cloned();
        let object = node.as_ref().and_then(|n| {
            kids(n)
                .iter()
                .find(|c| c.kind == SyntaxKind::Object)
                .copied()
                .cloned()
        });
        let mut scope = Scope::module(symbol.module);
        scope.example_values = true;
        let dependencies: Vec<String> =
            recipe.seeds.iter().map(|id| self.local_name(*id)).collect();
        let kind = match target {
            FixtureTarget::Model(model) => {
                let fields = object
                    .as_ref()
                    .map(|obj| self.decode_recipe_object(&scope, *model, obj));
                let Some(fields) = fields else {
                    self.gap(
                        format!(
                            "fixture {}: recipe values are not in the analysis tables (PR5 examples); emitting a failing recipe shell",
                            symbol.canonical,
                        ),
                        symbol.span,
                    );
                    return None;
                };
                IrFixtureKind::Model {
                    model: self.canonical(*model),
                    fields,
                }
            }
            FixtureTarget::User => {
                let mut roles = Vec::new();
                if let Some(obj) = object.as_ref() {
                    for child in kids(obj) {
                        if child.kind != SyntaxKind::ObjectEntry {
                            continue;
                        }
                        let parts = kids(child);
                        let key = parts.first().and_then(|n| name_text(self.db, n));
                        if key.as_deref() != Some("roles") {
                            continue;
                        }
                        if let Some(array) =
                            parts.iter().find(|n| n.kind == SyntaxKind::Array).copied()
                        {
                            for entry in kids(array) {
                                if entry.kind != SyntaxKind::NameRef {
                                    continue;
                                }
                                let name = kids(entry)
                                    .iter()
                                    .find_map(|n| name_text(self.db, n))
                                    .unwrap_or_default();
                                match self.resolve_member(symbol.module, &name) {
                                    Some((id, _))
                                        if matches!(
                                            self.program
                                                .symbols
                                                .get(id.0 as usize)
                                                .map(|s| &s.kind),
                                            Some(SymbolKind::Role)
                                        ) =>
                                    {
                                        roles.push(self.canonical(id));
                                    }
                                    _ => {
                                        self.gap(
                                            format!(
                                                "fixture {}: role `{name}` is not published in the analysis tables; omitting it",
                                                symbol.canonical,
                                            ),
                                            entry.span,
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
                IrFixtureKind::User { roles }
            }
            FixtureTarget::File => {
                let fields = object.as_ref().map(|obj| {
                    let entries = kids(obj)
                        .iter()
                        .filter(|c| c.kind == SyntaxKind::ObjectEntry)
                        .filter_map(|entry| {
                            let parts = kids(entry);
                            let key = parts.first().and_then(|n| name_text(self.db, n))?;
                            let value = parts
                                .iter()
                                .find(|n| is_expression(n.kind))
                                .map(|n| self.decode_expr(&scope, n))
                                .unwrap_or_else(|| {
                                    TypedExpr::new(
                                        IrExpr::Name(key.clone()),
                                        ResolvedType::Unknown,
                                        entry.span,
                                    )
                                });
                            Some((key, value))
                        })
                        .collect();
                    TypedExpr::new(IrExpr::Object(entries), ResolvedType::Unknown, obj.span)
                });
                let Some(fields) = fields else {
                    self.gap(
                        format!(
                            "fixture {}: recipe values are not in the analysis tables (PR5 examples); emitting a failing recipe shell",
                            symbol.canonical,
                        ),
                        symbol.span,
                    );
                    return None;
                };
                IrFixtureKind::File { fields }
            }
            FixtureTarget::Operation(op) => {
                let operation = op.map(|id| self.canonical(id)).unwrap_or_else(|| {
                    self.gap(
                        format!(
                            "fixture {}: operation target is not published in the analysis tables; emitting a best-effort recipe shell",
                            symbol.canonical,
                        ),
                        symbol.span,
                    );
                    symbol.canonical.clone()
                });
                self.decode_delivery_recipe(&scope, symbol, &object, operation)?
            }
            FixtureTarget::Unknown => {
                // T15b provider join (seam 5): a fixture head over a
                // `std` import (checker-validated against the consumed
                // owner schema, but unpublished as a fixture target)
                // joins the structured delivery path under its
                // qualified T13 send target. Any miss keeps the
                // failing shell below (fail-closed; Handbook,
                // non-`std` providers and wrong ops never join).
                let std_operation = node.as_ref().and_then(|decl| {
                    kids(decl)
                        .iter()
                        .find(|c| c.kind == SyntaxKind::Path)
                        .and_then(|head| {
                            let segments: Vec<String> = kids(head)
                                .iter()
                                .filter_map(|n| name_text(self.db, n))
                                .collect();
                            self.std_send_target(symbol.module, &segments)
                        })
                });
                let Some(std_operation) = std_operation else {
                    self.gap(
                        format!(
                            "fixture {}: unresolved fixture target; emitting a failing recipe shell",
                            symbol.canonical,
                        ),
                        symbol.span,
                    );
                    return None;
                };
                self.decode_delivery_recipe(&scope, symbol, &object, std_operation)?
            }
        };
        Some(IrFixture {
            name: symbol.name.clone(),
            canonical: symbol.canonical.clone(),
            kind,
            dependencies,
            span: symbol.span,
        })
    }

    /// Decode one delivery recipe body (`request` + optional
    /// `status`/`result`/`error`) under an already-resolved operation
    /// identity: a local canonical name or a T15b qualified `std`
    /// send target. Shared by the `Operation` and recovered-`std`
    /// `Unknown` arms (one constructor, no drift); a missing request
    /// keeps the failing shell plus `E6006`.
    fn decode_delivery_recipe(
        &mut self,
        scope: &Scope,
        symbol: &crate::analysis::resolve::Symbol,
        object: &Option<SyntaxNode>,
        operation: String,
    ) -> Option<IrFixtureKind> {
        let mut request = None;
        let mut status = None;
        let mut result = None;
        let mut error = None;
        if let Some(obj) = object {
            for child in kids(obj) {
                if child.kind != SyntaxKind::ObjectEntry {
                    continue;
                }
                let parts = kids(child);
                let key = parts.first().and_then(|n| name_text(self.db, n));
                let value = parts
                    .iter()
                    .find(|n| is_expression(n.kind))
                    .map(|n| self.decode_expr(scope, n));
                match (key.as_deref(), value) {
                    (Some("request"), Some(value)) => request = Some(Box::new(value)),
                    (Some("status"), Some(value)) => status = Some(Box::new(value)),
                    (Some("result"), Some(value)) => result = Some(Box::new(value)),
                    (Some("error"), Some(value)) => error = Some(Box::new(value)),
                    _ => {}
                }
            }
        }
        let Some(request) = request else {
            self.gap(
                format!(
                    "fixture {}: delivery request is not in the analysis tables (PR5 examples); emitting a failing recipe shell",
                    symbol.canonical,
                ),
                symbol.span,
            );
            return None;
        };
        Some(IrFixtureKind::Delivery {
            operation,
            request,
            status,
            result,
            error,
        })
    }

    /// Resolve fixture-head segments to a qualified T13 send target
    /// (`std.EmailV1.send`), or `None` when the head is not a
    /// two-segment `Alias.op` over a `std` provider import with a
    /// consumed capability schema containing that operation.
    ///
    /// Mirrors the checker's `resolve_std_recipe_head` (types.rs):
    /// the same two-segment rule, the same `std`-provider rule (read
    /// from the published module imports — the source of the scope
    /// bindings the checker reads, since `CheckedProgram` does not
    /// publish scopes), and the same frozen consume-layer lookups.
    /// Table-grounded, not re-derived: the head spelling is
    /// syntactic structure re-read from the anchored recipe node
    /// (the module-doc exception) while provider/member/op identity
    /// comes from published tables plus the T13 catalog. Any miss —
    /// including Handbook, non-`std` providers and wrong ops —
    /// returns `None` and the caller keeps the failing shell.
    fn std_send_target(&self, module: ModuleId, segments: &[String]) -> Option<String> {
        if segments.len() != 2 {
            return None;
        }
        let host = self.program.modules.get(module.0 as usize)?;
        let member = host
            .imports
            .iter()
            .filter(|import| import.provider == "std")
            .flat_map(|import| &import.members)
            .find(|member| member.alias == segments[0])?;
        let cap = std_capability(&member.name)?;
        let op = cap
            .operations
            .iter()
            .find(|operation| operation.name == segments[1])?;
        Some(format!("{}.{}", cap.name, op.name))
    }

    /// Decode a model recipe object: values with model-field-type context
    /// for enum-case cells.
    fn decode_recipe_object(
        &mut self,
        scope: &Scope,
        model: SymbolId,
        node: &SyntaxNode,
    ) -> TypedExpr {
        let entries = kids(node)
            .iter()
            .filter(|c| c.kind == SyntaxKind::ObjectEntry)
            .filter_map(|entry| {
                let parts = kids(entry);
                let key = parts.first().and_then(|n| name_text(self.db, n))?;
                let value = parts
                    .iter()
                    .find(|n| is_expression(n.kind))
                    .map(|n| self.decode_cell_with_field(scope, model, &key, n))
                    .unwrap_or_else(|| {
                        TypedExpr::new(IrExpr::Name(key.clone()), ResolvedType::Unknown, entry.span)
                    });
                Some((key, value))
            })
            .collect();
        TypedExpr::new(IrExpr::Object(entries), ResolvedType::Unknown, node.span)
    }

    /// Decode one example value with model-field-type context: bare names
    /// matching an enum field's cases lower as that case text with the
    /// field's type (tables classify, spans supply the spelling).
    fn decode_cell_with_field(
        &mut self,
        scope: &Scope,
        model: SymbolId,
        field: &str,
        node: &SyntaxNode,
    ) -> TypedExpr {
        let mut expr = self.decode_expr(scope, node);
        if node.kind == SyntaxKind::NameRef
            && let Some(field_id) = self.fields.get(&(model, field.to_string()))
            && let Some(ty) = self.program.types.symbol_types.get(field_id)
            && matches!(&expr.expr, IrExpr::Text(_))
        {
            expr.ty = ty.clone();
        }
        expr
    }
}

/// Suite assembly (G10): one suite per operation with tables and
/// sequences, plus orphan recipes. Tables and sequences whose steps the
/// bridge cannot decode omit atomically with `E6006`.
impl<'a> Cx<'a> {
    fn build_suites(&mut self, items: &[IrItem]) -> Vec<BddSuite> {
        // Decode tables and sequences grouped by operation, in source
        // order. Sequence `let` bindings resolve step content through
        // the immutable `b` scope.
        type OpExamples = (SymbolId, Vec<IrTable>, Vec<IrSequence>, Vec<SymbolId>);
        let mut by_operation: Vec<OpExamples> = Vec::new();
        for table in self.program.examples.tables.clone() {
            let Some(operation) = table.operation else {
                let span = Span::new(table.node.file, table.node.start, table.node.end);
                self.gap(
                    "example table is not attached to a published operation; omitting it"
                        .to_string(),
                    span,
                );
                continue;
            };
            match self.decode_table(&table, operation) {
                Some((ir_table, refs)) => {
                    match by_operation
                        .iter_mut()
                        .find(|(op, _, _, _)| *op == operation)
                    {
                        Some((_, tables, _, all_refs)) => {
                            tables.push(ir_table);
                            all_refs.extend(refs);
                        }
                        None => by_operation.push((operation, vec![ir_table], Vec::new(), refs)),
                    }
                }
                None => {
                    let span = Span::new(table.node.file, table.node.start, table.node.end);
                    self.gap(
                        format!(
                            "example table for {}: cells are not in the analysis tables (PR5 examples); omitting it",
                            self.canonical(operation),
                        ),
                        span,
                    );
                }
            }
        }
        for sequence in self.program.examples.sequences.clone() {
            let span = Span::new(sequence.node.file, sequence.node.start, sequence.node.end);
            let Some(operation) = sequence.operation else {
                self.gap(
                    "example sequence is not attached to a published operation; omitting it"
                        .to_string(),
                    span,
                );
                continue;
            };
            match self.decode_sequence(&sequence, operation) {
                Some((ir_sequence, refs)) => {
                    match by_operation
                        .iter_mut()
                        .find(|(op, _, _, _)| *op == operation)
                    {
                        Some((_, _, sequences, all_refs)) => {
                            sequences.push(ir_sequence);
                            all_refs.extend(refs);
                        }
                        None => {
                            by_operation.push((operation, Vec::new(), vec![ir_sequence], refs));
                        }
                    }
                }
                None => {
                    self.gap(
                        format!(
                            "sequence for {}: step content is not in the analysis tables (PR5 examples); omitting it from emission",
                            self.canonical(operation),
                        ),
                        span,
                    );
                }
            }
        }
        // Order suites by operation declaration.
        by_operation.sort_by_key(|(op, _, _, _)| op.0);
        // Fixture recipes by symbol (decoded with the items above).
        let mut recipes: HashMap<SymbolId, IrFixture> = HashMap::new();
        for item in items {
            if let IrItemKind::Fixture {
                recipe: Some(recipe),
                ..
            } = &item.kind
            {
                recipes.insert(item.id, recipe.clone());
            }
        }
        let mut claimed: HashSet<SymbolId> = HashSet::new();
        let mut suites = Vec::new();
        for (operation, tables, sequences, refs) in &by_operation {
            let operation_module = self
                .program
                .symbols
                .get(operation.0 as usize)
                .map(|s| s.module)
                .unwrap_or(ModuleId(0));
            let closure = self.fixture_closure(refs);
            let mut fixtures = Vec::new();
            let mut imported = Vec::new();
            for id in closure {
                let Some(recipe) = recipes.get(&id) else {
                    continue;
                };
                let home = self
                    .program
                    .symbols
                    .get(id.0 as usize)
                    .map(|s| s.module)
                    .unwrap_or(ModuleId(0));
                if home != operation_module {
                    let provider = self
                        .program
                        .modules
                        .get(home.0 as usize)
                        .map(|m| m.name.clone())
                        .unwrap_or_default();
                    imported.push(crate::codegen::bdd::IrExampleImport {
                        provider,
                        member: recipe.name.clone(),
                        alias: recipe.name.clone(),
                    });
                    continue;
                }
                claimed.insert(id);
                fixtures.push(recipe.clone());
            }
            suites.push(BddSuite {
                scope: self.canonical(*operation),
                fixtures,
                imported,
                tables: tables.clone(),
                sequences: sequences.clone(),
                span: self
                    .program
                    .symbols
                    .get(operation.0 as usize)
                    .map(|s| s.span)
                    .unwrap_or(Span::new(SourceId(0), 0, 0)),
            });
        }
        // Orphan recipes: fixtures no same-module suite claims.
        let mut orphans: Vec<SymbolId> = recipes
            .keys()
            .copied()
            .filter(|id| !claimed.contains(id))
            .collect();
        orphans.sort_by_key(|id| id.0);
        for id in orphans {
            let Some(recipe) = recipes.get(&id) else {
                continue;
            };
            suites.push(BddSuite {
                scope: recipe.canonical.clone(),
                fixtures: vec![recipe.clone()],
                imported: Vec::new(),
                tables: Vec::new(),
                sequences: Vec::new(),
                span: recipe.span,
            });
        }
        suites
    }

    /// Transitive fixture closure over recipe seeds, in declaration order.
    fn fixture_closure(&self, refs: &[SymbolId]) -> Vec<SymbolId> {
        let mut seen: HashSet<SymbolId> = HashSet::new();
        let mut stack: Vec<SymbolId> = refs.to_vec();
        while let Some(id) = stack.pop() {
            if !seen.insert(id) {
                continue;
            }
            if let Some(recipe) = self
                .program
                .examples
                .fixtures
                .iter()
                .find(|r| r.symbol == id)
            {
                stack.extend(recipe.seeds.iter().copied());
            }
        }
        let mut out: Vec<SymbolId> = seen.into_iter().collect();
        out.sort_by_key(|id| id.0);
        out
    }

    /// Decode one causal sequence: `call`/`let`/assertion steps in
    /// source order. `let`/`as` bindings publish progressively into the
    /// `b` scope, so each step reads exactly the bindings before it.
    /// Returns the sequence plus every fixture it references.
    fn decode_sequence(
        &mut self,
        sequence: &crate::analysis::examples::ExampleSequence,
        operation: SymbolId,
    ) -> Option<(IrSequence, Vec<SymbolId>)> {
        let node = self.node(&sequence.node).cloned()?;
        let module = self
            .program
            .symbols
            .get(operation.0 as usize)
            .map(|s| s.module)?;
        let body = kids(&node)
            .iter()
            .find(|n| n.kind == SyntaxKind::DoBlock)
            .copied()?;
        let mut scope = Scope::module(module);
        scope.example_values = true;
        // Inferred `b` binding types for clause lowering and assertion
        // type ids (the types pass never visits sequence steps).
        let mut lets: HashMap<String, ResolvedType> = HashMap::new();
        scope
            .name_types
            .insert("self".to_string(), ResolvedType::Scalar(Scalar::User));
        scope
            .name_types
            .insert("other".to_string(), ResolvedType::Scalar(Scalar::User));
        let mut steps = Vec::new();
        let mut refs: Vec<SymbolId> = sequence.seeds.clone();
        for step in kids(body) {
            match step.kind {
                SyntaxKind::Let => {
                    let (name, value_node) = sequence_let_parts(self.db, step)?;
                    let value = self.decode_expr(&scope, value_node);
                    lets.insert(name.clone(), self.sequence_value_ty(&value, &lets, module));
                    refs.extend(self.s_refs(module, &value));
                    scope.sequence_lets.insert(name.clone());
                    publish_lets(&mut scope, &lets);
                    steps.push(IrStep::Binding { name, value });
                }
                SyntaxKind::ExampleCall => {
                    let step_ir = self.decode_sequence_call(module, &scope, step)?;
                    if let IrStep::Call {
                        operation,
                        by,
                        inputs,
                        request,
                        bind,
                        ..
                    } = &step_ir
                    {
                        refs.extend(self.s_refs(module, by));
                        refs.extend(self.s_refs(module, inputs));
                        if let Some(request) = request {
                            refs.extend(self.s_refs(module, request));
                        }
                        if let Some(bind) = bind {
                            // `as` bindings carry the call's declared
                            // result type for later member chains.
                            let result = self
                                .program
                                .symbols
                                .iter()
                                .find(|s| &s.canonical == operation)
                                .and_then(|s| self.program.types.symbol_results.get(&s.id))
                                .and_then(|result| result.clone())
                                .unwrap_or(ResolvedType::Unknown);
                            lets.insert(bind.clone(), result);
                            scope.sequence_lets.insert(bind.clone());
                            publish_lets(&mut scope, &lets);
                        }
                    }
                    steps.push(step_ir);
                }
                SyntaxKind::ExampleAssert => {
                    let (obs_nodes, expected_nodes) = split_row(self.db, step);
                    if obs_nodes.is_empty() || obs_nodes.len() != expected_nodes.len() {
                        return None;
                    }
                    let mut types = Vec::new();
                    for obs_node in &obs_nodes {
                        let obs = self.decode_expr(&scope, obs_node);
                        refs.extend(self.s_refs(module, &obs));
                        let ty = self.sequence_value_ty(&obs, &lets, module);
                        let id = self.type_id(&ty);
                        if id == "unknown" {
                            self.diags.push(Diagnostic::error(
                                "E6008",
                                "cannot lower sequence assertion: observation type is not resolvable"
                                    .to_string(),
                                obs_node.span,
                            ));
                        }
                        types.push(id);
                    }
                    let observations: Vec<TypedExpr> = obs_nodes
                        .iter()
                        .map(|n| self.decode_expr(&scope, n))
                        .collect();
                    let expected: Vec<TypedExpr> = expected_nodes
                        .iter()
                        .map(|n| self.decode_expr(&scope, n))
                        .collect();
                    for cell in expected.iter() {
                        refs.extend(self.s_refs(module, cell));
                    }
                    steps.push(IrStep::Assertion {
                        observations: TypedExpr::new(
                            IrExpr::Array(observations),
                            ResolvedType::Unknown,
                            step.span,
                        ),
                        expected: TypedExpr::new(
                            IrExpr::Array(expected),
                            ResolvedType::Unknown,
                            step.span,
                        ),
                        types,
                    });
                }
                _ => {}
            }
        }
        let dependencies: Vec<String> = sequence
            .seeds
            .iter()
            .map(|id| self.local_name(*id))
            .collect();
        Some((
            IrSequence {
                operation: self.canonical(operation),
                dependencies,
                steps,
                span: Span::new(sequence.node.file, sequence.node.start, sequence.node.end),
            },
            refs,
        ))
    }

    /// Decode one sequence `call` step: canonical target, caller, inputs,
    /// optional request overrides, optional `as` binding, optional exact
    /// error. `None` when the target or caller does not resolve.
    fn decode_sequence_call(
        &mut self,
        module: ModuleId,
        scope: &Scope,
        node: &SyntaxNode,
    ) -> Option<IrStep> {
        let parts = kids(node);
        let target = parts.iter().find(|n| is_expression(n.kind)).copied()?;
        let target_id = self.resolve_operation_target(module, target)?;
        let objects: Vec<&SyntaxNode> = parts
            .iter()
            .filter(|n| n.kind == SyntaxKind::Object)
            .copied()
            .collect();
        let inputs = self.decode_expr(scope, objects.first().copied()?);
        let request = objects
            .get(1)
            .map(|overrides| self.decode_expr(scope, overrides));
        let caller = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied()?;
        let caller_name = path_text(self.db, caller);
        if caller_name.contains('.') {
            return None;
        }
        let by = self.decode_caller(module, &caller_name, caller.span);
        let bind = sequence_as_binding(self.db, node);
        let error = parts
            .iter()
            .find(|n| n.kind == SyntaxKind::ExpectedError)
            .map(|cell| expected_error_code(self.db, cell));
        Some(IrStep::Call {
            operation: self.canonical(target_id),
            by,
            inputs,
            request,
            bind,
            error,
        })
    }

    /// Decode a sequence `by=` caller: fixtures resolve to their `s`
    /// scope slot, provisioned accounts stay bare, roles lower to their
    /// canonical identity, anything else stays a spelling.
    fn decode_caller(&mut self, module: ModuleId, name: &str, span: Span) -> TypedExpr {
        if let Some(id) = self.fixture_in_scope(module, name) {
            let fixture_name = self.local_name(id);
            let ty = self.fixture_type(id);
            return TypedExpr::new(member_of("s", &fixture_name, &ty, span), ty, span);
        }
        if is_test_account(name) {
            return TypedExpr::new(
                IrExpr::Name(name.to_string()),
                ResolvedType::Scalar(Scalar::User),
                span,
            );
        }
        if let Some((id, _)) = self.resolve_member(module, name)
            && matches!(
                self.program.symbols.get(id.0 as usize).map(|s| &s.kind),
                Some(SymbolKind::Role)
            )
        {
            return TypedExpr::new(
                IrExpr::Text(self.canonical(id)),
                ResolvedType::Scalar(Scalar::Text),
                span,
            );
        }
        TypedExpr::new(
            IrExpr::Text(name.to_string()),
            ResolvedType::Scalar(Scalar::Text),
            span,
        )
    }

    /// Resolved value type of one decoded sequence expression for
    /// assertion type ids. Sequence steps carry no published types, so
    /// this infers structurally: literals, comparisons, `b`/`s` slots,
    /// member chains, and `first`/`count` calls. Anything else is
    /// `Unknown` (the assertion stays loud `E6008`, never `unknown`).
    fn sequence_value_ty(
        &self,
        expr: &TypedExpr,
        lets: &HashMap<String, ResolvedType>,
        module: ModuleId,
    ) -> ResolvedType {
        if !matches!(expr.ty, ResolvedType::Unknown) {
            return expr.ty.clone();
        }
        match &expr.expr {
            IrExpr::Int(_) => ResolvedType::Scalar(Scalar::Int),
            IrExpr::Decimal(_) => ResolvedType::Scalar(Scalar::Decimal),
            IrExpr::Text(_) => ResolvedType::Scalar(Scalar::Text),
            IrExpr::Bool(_) => ResolvedType::Scalar(Scalar::Bool),
            IrExpr::Null => ResolvedType::Null,
            IrExpr::Money { .. } => ResolvedType::Scalar(Scalar::Money),
            IrExpr::DurationMs(_) => ResolvedType::Scalar(Scalar::Duration),
            IrExpr::Date(_) => ResolvedType::Scalar(Scalar::Date),
            IrExpr::Datetime(_) => ResolvedType::Scalar(Scalar::Datetime),
            IrExpr::Binary { op, left, .. } => match op {
                IrBinOp::Eq
                | IrBinOp::Ne
                | IrBinOp::Lt
                | IrBinOp::Le
                | IrBinOp::Gt
                | IrBinOp::Ge
                | IrBinOp::And
                | IrBinOp::Or
                | IrBinOp::In => ResolvedType::Scalar(Scalar::Bool),
                IrBinOp::Coalesce => self.sequence_value_ty(left, lets, module),
                IrBinOp::Add | IrBinOp::Sub | IrBinOp::Mul | IrBinOp::Div | IrBinOp::Mod => {
                    ResolvedType::Unknown
                }
            },
            IrExpr::Unary { op, operand } => match op {
                IrUnOp::Not => ResolvedType::Scalar(Scalar::Bool),
                IrUnOp::Neg => self.sequence_value_ty(operand, lets, module),
            },
            IrExpr::Name(name) => {
                if is_test_account(name) {
                    return ResolvedType::Scalar(Scalar::User);
                }
                lets.get(name).cloned().unwrap_or(ResolvedType::Unknown)
            }
            IrExpr::Member { base, field } => {
                if matches!(base.expr, IrExpr::Name(ref scope) if scope == "b") {
                    let base_ty = lets.get(field).cloned().unwrap_or(ResolvedType::Unknown);
                    return base_ty;
                }
                if matches!(base.expr, IrExpr::Name(ref scope) if scope == "s")
                    && let Some(id) = self.fixture_in_scope(module, field)
                {
                    return self.fixture_type(id);
                }
                let base_ty = self.sequence_value_ty(base, lets, module);
                self.member_ty(&base_ty, field)
            }
            IrExpr::Call { target, args } => {
                let id = match target {
                    IrCallTarget::Builtin { id, .. } => id.as_str(),
                    IrCallTarget::CapabilityOp(_) | IrCallTarget::DeriveFn(_) => {
                        return ResolvedType::Unknown;
                    }
                };
                match id {
                    "count" => ResolvedType::Scalar(Scalar::Int),
                    "first" => {
                        let Some(domain) = args.first() else {
                            return ResolvedType::Unknown;
                        };
                        let element = match &domain.expr {
                            IrExpr::Query(query) => match &query.domain {
                                IrQueryDomain::Model(model) => self
                                    .program
                                    .symbols
                                    .iter()
                                    .find(|s| s.canonical == *model)
                                    .map(|s| ResolvedType::Record {
                                        symbol: s.id,
                                        stored: true,
                                    }),
                                IrQueryDomain::Value { base, .. } => {
                                    match self.sequence_value_ty(base, lets, module) {
                                        ResolvedType::Array { element, .. } => Some(*element),
                                        other => Some(other),
                                    }
                                }
                            },
                            IrExpr::Array(items) => items
                                .first()
                                .map(|item| self.sequence_value_ty(item, lets, module)),
                            _ => None,
                        };
                        element
                            .map(|ty| ResolvedType::Nullable(Box::new(ty)))
                            .unwrap_or(ResolvedType::Unknown)
                    }
                    _ => ResolvedType::Unknown,
                }
            }
            IrExpr::Query(query) => match &query.domain {
                IrQueryDomain::Model(model) => self
                    .program
                    .symbols
                    .iter()
                    .find(|s| s.canonical == *model)
                    .map(|s| ResolvedType::Array {
                        element: Box::new(ResolvedType::Record {
                            symbol: s.id,
                            stored: true,
                        }),
                        ordered: true,
                        nonempty: false,
                    })
                    .unwrap_or(ResolvedType::Unknown),
                IrQueryDomain::Value { base, .. } => self.sequence_value_ty(base, lets, module),
            },
            _ => ResolvedType::Unknown,
        }
    }

    /// Decode one behavior table: common inputs, selector metadata,
    /// observation callbacks and rows. Returns the table plus every
    /// fixture it references.
    fn decode_table(
        &mut self,
        table: &crate::analysis::examples::BehaviorTable,
        operation: SymbolId,
    ) -> Option<(IrTable, Vec<SymbolId>)> {
        let node = self.node(&table.node).cloned()?;
        let module = self
            .program
            .symbols
            .get(operation.0 as usize)
            .map(|s| s.module)?;
        let mut scope = Scope::module(module);
        scope.example_values = true;
        scope.result_ty = self
            .program
            .types
            .symbol_results
            .get(&operation)
            .and_then(|result| result.clone());
        // Common bindings: `name=value` attributes other than `seed`.
        let mut input_entries: Vec<(String, TypedExpr)> = Vec::new();
        let mut binding_fixtures: Vec<SymbolId> = Vec::new();
        for child in kids(&node) {
            if child.kind != SyntaxKind::Attribute {
                continue;
            }
            let parts = kids(child);
            let name = parts.first().and_then(|n| name_text(self.db, n))?;
            if name == "seed" {
                continue;
            }
            let value = parts.iter().find(|n| is_expression(n.kind)).copied();
            let Some(value) = value else { continue };
            // Fixture-bound inputs rewrite observation roots to `s`.
            if value.kind == SyntaxKind::NameRef
                && let Some(binding) = kids(value).iter().find_map(|n| name_text(self.db, n))
                && let Some(id) = self.fixture_in_scope(module, &binding)
            {
                scope.bindings.insert(name.clone(), id);
                binding_fixtures.push(id);
            }
            input_entries.push((name, self.decode_expr(&scope, value)));
        }
        let inputs = TypedExpr::new(
            IrExpr::Object(input_entries),
            ResolvedType::Unknown,
            node.span,
        );
        // Header row plus data rows.
        let rows: Vec<&SyntaxNode> = kids(&node)
            .iter()
            .filter(|n| n.kind == SyntaxKind::ExampleRow)
            .copied()
            .collect();
        let (header, data_rows) = rows.split_first()?;
        let (header_inputs, header_obs) = split_row(self.db, header);
        let mut observations = Vec::new();
        let mut refs: Vec<SymbolId> = table.seeds.clone();
        refs.extend(binding_fixtures.iter().copied());
        for cell in header_obs {
            let expr = self.decode_expr(&scope, cell);
            refs.extend(self.s_refs(module, &expr));
            observations.push(expr);
        }
        let mut ir_rows = Vec::new();
        for row in data_rows {
            let (input_cells, expected_cells) = split_row(self.db, row);
            let mut values = Vec::new();
            let mut row_refs = Vec::new();
            for (index, cell) in input_cells.iter().enumerate() {
                let selector = table.inputs.get(index).map(String::as_str).unwrap_or("");
                let value = if selector == "as" {
                    self.decode_as_cell(module, cell)
                } else {
                    self.decode_expr(&scope, cell)
                };
                row_refs.extend(self.s_refs(module, &value));
                values.push(value);
            }
            let error = expected_cells.iter().find_map(|cell| {
                if cell.kind == SyntaxKind::ExpectedError {
                    Some(expected_error_code(self.db, cell))
                } else {
                    None
                }
            });
            let expected = if error.is_some() {
                None
            } else {
                let cells: Vec<TypedExpr> = expected_cells
                    .iter()
                    .map(|cell| self.decode_expr(&scope, cell))
                    .collect();
                for cell in &cells {
                    row_refs.extend(self.s_refs(module, cell));
                }
                Some(TypedExpr::new(
                    IrExpr::Array(cells),
                    ResolvedType::Unknown,
                    row.span,
                ))
            };
            // Row dependencies are fixtures beyond the table level.
            let table_deps: HashSet<SymbolId> = refs.iter().copied().collect();
            let dependencies: Vec<String> = {
                let mut names: Vec<String> = row_refs
                    .iter()
                    .filter(|id| !table_deps.contains(id))
                    .map(|id| self.local_name(*id))
                    .collect();
                names.sort();
                names.dedup();
                names
            };
            refs.extend(row_refs);
            ir_rows.push(IrTableRow {
                dependencies,
                values: TypedExpr::new(IrExpr::Array(values), ResolvedType::Unknown, row.span),
                expected,
                error,
                span: row.span,
            });
        }
        let _ = header_inputs;
        // Table dependencies: explicit seeds plus common baseline
        // fixtures, deduplicated, seeds first.
        let mut dependencies: Vec<String> =
            table.seeds.iter().map(|id| self.local_name(*id)).collect();
        for id in &binding_fixtures {
            let name = self.local_name(*id);
            if !dependencies.contains(&name) {
                dependencies.push(name);
            }
        }
        Some((
            IrTable {
                operation: self.canonical(operation),
                dependencies,
                inputs,
                selectors: table.inputs.clone(),
                observations,
                rows: ir_rows,
                span: Span::new(table.node.file, table.node.start, table.node.end),
            },
            refs,
        ))
    }

    /// Decode an `as` caller cell: fixtures and provisioned accounts by
    /// reference, roles canonically, spellings as text.
    fn decode_as_cell(&mut self, module: ModuleId, cell: &SyntaxNode) -> TypedExpr {
        let span = cell.span;
        let name = match cell.kind {
            SyntaxKind::NameRef => kids(cell).iter().find_map(|n| name_text(self.db, n)),
            _ => None,
        };
        let Some(name) = name else {
            let mut scope = Scope::module(module);
            scope.example_values = true;
            return self.decode_expr(&scope, cell);
        };
        if let Some(id) = self.fixture_in_scope(module, &name) {
            let fixture_name = self.local_name(id);
            let ty = self.fixture_type(id);
            return TypedExpr::new(member_of("s", &fixture_name, &ty, span), ty, span);
        }
        if is_test_account(&name) {
            return TypedExpr::new(IrExpr::Name(name), ResolvedType::Scalar(Scalar::User), span);
        }
        if let Some((id, _)) = self.resolve_member(module, &name)
            && matches!(
                self.program.symbols.get(id.0 as usize).map(|s| &s.kind),
                Some(SymbolKind::Role)
            )
        {
            return TypedExpr::new(
                IrExpr::Text(self.canonical(id)),
                ResolvedType::Scalar(Scalar::Text),
                span,
            );
        }
        TypedExpr::new(IrExpr::Text(name), ResolvedType::Scalar(Scalar::Text), span)
    }

    /// Fixture references of one decoded expression (`s` slots).
    fn s_refs(&self, module: ModuleId, expr: &TypedExpr) -> Vec<SymbolId> {
        let mut names = Vec::new();
        collect_s_refs(&expr.expr, &mut names);
        names.sort();
        names.dedup();
        names
            .iter()
            .filter_map(|name| self.fixture_in_scope(module, name))
            .collect()
    }
}

/// Binding name plus value node of a sequence `let` step.
fn sequence_let_parts<'n>(db: &SourceDb, node: &'n SyntaxNode) -> Option<(String, &'n SyntaxNode)> {
    let mut name = None;
    let mut value = None;
    for part in kids(node) {
        if name.is_none()
            && let Some(word) = name_text(db, part)
            && word != "let"
        {
            name = Some(word);
        } else if value.is_none() && is_expression(part.kind) {
            value = Some(part);
        }
    }
    name.zip(value)
}

/// Publish inferred `let` types: each binding name reads its type
/// directly (source `name` lowers to `b.name`), and `b` itself reads as
/// the closed bindings object for member chains.
fn publish_lets(scope: &mut Scope, lets: &HashMap<String, ResolvedType>) {
    let mut fields: Vec<(String, ResolvedType)> = Vec::new();
    for (name, ty) in lets {
        scope.name_types.insert(name.clone(), ty.clone());
        fields.push((name.clone(), ty.clone()));
    }
    fields.sort_by(|a, b| a.0.cmp(&b.0));
    scope
        .name_types
        .insert("b".to_string(), ResolvedType::Object(fields));
}

/// `as` binding of a sequence `call` step, if any.
fn sequence_as_binding(db: &SourceDb, node: &SyntaxNode) -> Option<String> {
    let mut names = kids(node).into_iter().filter_map(|n| name_text(db, n));
    for word in names.by_ref() {
        if word == "as" {
            return names.next();
        }
    }
    None
}

/// Split an example row at `->` into input and expected cells.
fn split_row<'n>(db: &SourceDb, row: &'n SyntaxNode) -> (Vec<&'n SyntaxNode>, Vec<&'n SyntaxNode>) {
    let mut inputs = Vec::new();
    let mut expected = Vec::new();
    let mut after_arrow = false;
    for child in kids(row) {
        if child.kind == SyntaxKind::Punct && slice(db, child.span) == "->" {
            after_arrow = true;
            continue;
        }
        if child.kind == SyntaxKind::Punct {
            continue;
        }
        if after_arrow {
            expected.push(child);
        } else {
            inputs.push(child);
        }
    }
    (inputs, expected)
}

/// Exact error code of an `ExpectedError` cell.
fn expected_error_code(db: &SourceDb, node: &SyntaxNode) -> String {
    fn visit(db: &SourceDb, node: &SyntaxNode, out: &mut Option<String>) {
        if node.kind == SyntaxKind::NameRef
            && out.is_none()
            && let Some(name) = kids(node).iter().find_map(|n| name_text(db, n))
            && name != "error"
        {
            *out = Some(name);
            return;
        }
        for child in kids(node) {
            visit(db, child, out);
        }
    }
    let mut code = None;
    visit(db, node, &mut code);
    code.unwrap_or_default()
}

/// Collect `s` scope slot names of one decoded expression.
fn collect_s_refs(expr: &IrExpr, out: &mut Vec<String>) {
    match expr {
        IrExpr::Member { base, field } => {
            if matches!(base.expr, IrExpr::Name(ref name) if name == "s") {
                out.push(field.clone());
            } else {
                collect_s_refs(&base.expr, out);
            }
        }
        IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } => {
            for arg in args {
                collect_s_refs(&arg.expr, out);
            }
        }
        IrExpr::Binary { left, right, .. } => {
            collect_s_refs(&left.expr, out);
            collect_s_refs(&right.expr, out);
        }
        IrExpr::Unary { operand, .. } => collect_s_refs(&operand.expr, out),
        IrExpr::Array(items) => {
            for item in items {
                collect_s_refs(&item.expr, out);
            }
        }
        IrExpr::Object(entries) => {
            for (_, value) in entries {
                collect_s_refs(&value.expr, out);
            }
        }
        IrExpr::Query(query) => {
            if let IrQueryDomain::Value { base, .. } = &query.domain {
                collect_s_refs(&base.expr, out);
            }
            for part in query
                .parent
                .iter()
                .chain(query.where_pred.iter())
                .chain(query.limit.iter())
                .chain(query.archived.iter())
                .chain(query.select.iter())
            {
                collect_s_refs(&part.expr, out);
            }
        }
        IrExpr::DeliveryRead { record, .. } => collect_s_refs(&record.expr, out),
        IrExpr::MessageCall { args, params, .. } => {
            for value in args
                .iter()
                .chain(params.iter().filter_map(|param| param.default.as_ref()))
            {
                collect_s_refs(&value.expr, out);
            }
        }
        IrExpr::Message(message) => {
            for param in &message.params {
                collect_s_refs(&param.value.expr, out);
            }
        }
        IrExpr::Format { args, .. } => {
            for arg in args {
                collect_s_refs(&arg.expr, out);
            }
        }
        IrExpr::HasRole { person, .. } => {
            if let Some(person) = person {
                collect_s_refs(&person.expr, out);
            }
        }
        IrExpr::Lambda { body, .. } => collect_s_refs(&body.expr, out),
        IrExpr::Int(_)
        | IrExpr::Decimal(_)
        | IrExpr::Text(_)
        | IrExpr::Bool(_)
        | IrExpr::Null
        | IrExpr::Money { .. }
        | IrExpr::DurationMs(_)
        | IrExpr::Date(_)
        | IrExpr::Datetime(_)
        | IrExpr::Name(_)
        | IrExpr::Unsupported { .. } => {}
    }
}

#[cfg(test)]
mod string_payload_tests {
    use super::*;
    use crate::syntax::lexer::{Token, TokenKind};

    /// Synthetic CST recovery boundary: raw source must never substitute
    /// for an absent lexer payload, even when its spelling looks valid.
    #[test]
    fn c01_literal_string_distinguishes_empty_null_and_missing_payload() {
        let mut db = SourceDb::new();
        let file = db.add("payload.can".to_string(), "\"\" null".to_string());
        let literal = |kind, span, string_value| {
            SyntaxNode::enclosing(
                SyntaxKind::Literal,
                vec![SyntaxNode::token_leaf(Token {
                    kind,
                    span,
                    string_value,
                })],
            )
        };
        let empty = literal(
            TokenKind::String,
            Span::new(file, 0, 2),
            Some(String::new()),
        );
        let missing = literal(TokenKind::String, Span::new(file, 0, 2), None);
        let null = literal(TokenKind::Name, Span::new(file, 3, 7), None);
        assert_eq!(literal_string_opt(&db, &empty), Some(Some(String::new())));
        assert_eq!(literal_string_opt(&db, &missing), None);
        assert_eq!(literal_string_opt(&db, &null), Some(None));
    }
}
