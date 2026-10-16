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
use crate::analysis::effects::{CapabilityData, EffectVerb, PolicyRule};
use crate::analysis::migrate_check::{self, OwnerModelView};
use crate::analysis::resolve::{
    CheckedJudgmentKind, CheckedValueConstraints, CrudOp, FixtureTarget, ModelOwner, ModuleId,
    ModuleKind, SymbolId, SymbolKind,
};
use crate::analysis::types::{
    CheckedGenerationCallbackObservation, CheckedGenerationCallbackSource, CheckedQuery,
    CheckedQueryClauseKind, CheckedQueryProjectionMapping, ResolvedType, Scalar, SelectedCall,
    SelectedCallTarget, completion_envelope,
};
use crate::analysis::{CheckedProgram, NodeKey};
use crate::codegen::bdd::BddSuite;
use crate::diagnostic::Diagnostic;
use crate::source::{SourceDb, SourceId, Span, sha256_hex};
use crate::syntax::{SyntaxKind, SyntaxNode};
use std::collections::{HashMap, HashSet};

/// Composed models with the same local name need distinct rule registry keys.
/// Preserve existing keys for models whose local name has one checked owner.
pub(crate) fn model_rule_prefix<'a>(
    program: &CheckedProgram,
    symbol: &'a crate::analysis::resolve::Symbol,
) -> &'a str {
    if program.symbols.iter().any(|other| {
        other.id != symbol.id
            && other.name == symbol.name
            && matches!(other.kind, SymbolKind::Model { .. })
    }) {
        &symbol.canonical
    } else {
        &symbol.name
    }
}

pub(crate) fn ir_model_rule_prefix<'a>(ir: &IrProgram, item: &'a IrItem) -> &'a str {
    if ir.items.iter().any(|other| {
        other.id != item.id
            && other.name == item.name
            && matches!(other.kind, IrItemKind::Model { .. })
    }) {
        &item.canonical
    } else {
        &item.name
    }
}

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
    pub runtime_bindings: Vec<super::runtime_bindings::RuntimeBinding>,
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
    /// One checked static declaration owns all derived Judgment shapes.
    Judgment {
        source_language: String,
        version: i64,
        questions: Vec<IrJudgmentQuestion>,
        result_fields: Vec<SymbolId>,
    },
    /// Preserve symbol index identity without emitting derived authored schemas.
    JudgmentGenerated(IrJudgmentGenerated),
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
        root_authority: Option<crate::analysis::effects::RootAuthority>,
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
        /// Whether `scope=authority` was declared (outcome 9 family E):
        /// the checked source fact, carried so the §13 operations
        /// marker and the fail-closed handler stub agree with analysis.
        /// Ordinary reads leave this false and emit byte-identical output.
        scope_authority: bool,
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
        /// Borrowed array lengths only; the field-only required marker is excluded.
        array_bounds: Option<IrParameterArrayBounds>,
        /// `=` default, when one is authored (G1/G6/G7).
        default: Option<IrDefault>,
        /// Checked source anchor before grouping is erased by expression lowering.
        default_node: Option<crate::analysis::NodeKey>,
        /// Exact parameter identity of an authored bare-name default.
        default_copy_source: Option<SymbolId>,
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

/// A source-owned protected grant; only the checked builder constructs entries.
#[derive(Debug, Clone)]
pub struct CheckedCallbackGrant {
    source: CheckedGenerationCallbackSource,
    selector: NodeKey,
    policy: NodeKey,
    rule: String,
    field: String,
}

impl CheckedCallbackGrant {
    pub fn model(&self) -> SymbolId {
        self.source.model
    }
    pub fn field(&self) -> &str {
        &self.field
    }
    pub fn rule(&self) -> &str {
        &self.rule
    }
    pub fn fields(&self) -> &[String] {
        &[]
    }
}

/// Immutable checked correspondence for protected policies and reads.
/// Default contains no authority and cannot validate a protected observation.
#[derive(Debug, Clone, Default)]
pub struct CheckedCallbackGrants {
    entries: Vec<CheckedCallbackGrant>,
    reads: Vec<String>,
    value_lists: Vec<String>,
    modules: Vec<(ModuleId, String)>,
    rules: Option<String>,
}

impl CheckedCallbackGrants {
    fn matches(&self, ir: &IrProgram) -> bool {
        self.modules.len() == ir.modules.len()
            && ir
                .items
                .iter()
                .all(|item| ir.modules.iter().any(|module| module.id == item.module))
            && self
                .rules
                .as_ref()
                .is_some_and(|rules| *rules == callback_rule_snapshot(ir))
            && self.entries.iter().all(|entry| {
                entry.selector.file == entry.policy.file
                    && entry.selector.start >= entry.policy.start
                    && entry.selector.end <= entry.policy.end
            })
            && self.modules.iter().all(|(module, snapshot)| {
                ir.modules.get(module.0 as usize).is_some()
                    && *snapshot == callback_module_snapshot(ir, *module)
            })
    }

    /// Admit only original checked copied-value lists and diagnostic display cards.
    pub fn matches_value_list(&self, ir: &IrProgram, node: &IrUi) -> bool {
        let shape = match node.factory.as_str() {
            "callbackValueList" => node
                .props
                .iter()
                .all(|(name, _)| matches!(name.as_str(), "values" | "empty")),
            "inspectionValueList" | "textMessageValueList" => node
                .props
                .iter()
                .all(|(name, _)| matches!(name.as_str(), "values" | "empty" | "page")),
            "callbackValueCard" => node.props.is_empty() && node.row_scope.is_none(),
            _ => false,
        };
        shape && self.matches(ir) && self.value_lists.contains(&format!("{node:?}"))
    }

    /// Emit only original source grants whose lowered owner closure is intact.
    pub fn iter_checked<'a>(
        &'a self,
        ir: &IrProgram,
    ) -> Option<impl Iterator<Item = &'a CheckedCallbackGrant>> {
        if self.entries.is_empty() && self.reads.is_empty() && self.value_lists.is_empty() {
            return Some(self.entries.iter());
        }
        self.matches(ir).then(|| self.entries.iter())
    }
}

fn callback_rule_snapshot(ir: &IrProgram) -> String {
    format!("{:?}\n{:?}", ir.read_rules, ir.callback_read_rules)
}

fn callback_module_snapshot(ir: &IrProgram, module: ModuleId) -> String {
    format!(
        "{:?}\n{:?}",
        ir.modules.get(module.0 as usize),
        ir.items
            .iter()
            .filter(|item| item.module == module)
            .collect::<Vec<_>>()
    )
}

/// Exact checked observation. The result is read whole; arm projection stays local.
#[derive(Debug, Clone)]
pub struct CheckedGenerationCallbackRead {
    observation: CheckedGenerationCallbackObservation,
    record: String,
    ty: ResolvedType,
    span: Span,
}

impl CheckedGenerationCallbackRead {
    pub fn matches(
        &self,
        ir: &IrProgram,
        expr: &TypedExpr,
        record: &TypedExpr,
        field: &str,
        props: &[String],
    ) -> bool {
        ir.callback_grants.matches(ir)
            && ir.callback_grants.reads.contains(&format!("{self:?}"))
            && self.record == format!("{record:?}")
            && self.ty == expr.ty
            && self.span == expr.span
            && props == ["callback_diagnostics"]
            && ir
                .items
                .get(self.observation.source.field.0 as usize)
                .is_some_and(|item| item.name == field)
            && matches!(&expr.expr, IrExpr::DeliveryRead { callback: Some(current), .. }
                if format!("{current:?}") == format!("{self:?}"))
    }
}

fn callback_value_array(ty: &ResolvedType) -> bool {
    matches!(ty, ResolvedType::Array { element, .. }
        if matches!(element.nullable_inner().unwrap_or(element), ResolvedType::StdNominal {
            name: "GenerationCallbackDiagnosticResult" | "GenerationCallbackDiagnosticComplete" | "GenerationCallbackDiagnosticUnsupported" | "GenerationCallbackFailure", .. }))
}

fn ordinary_read_policy(policy: &PolicyRule) -> bool {
    policy.fields_node.is_none() || !policy.fields.is_empty() || policy.callback_fields.is_empty()
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

/// Exact descriptor-number length bounds retained for reused array inputs.
#[derive(Debug, Clone, Default)]
pub struct IrParameterArrayBounds {
    pub min: Option<u64>,
    pub max: Option<u64>,
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

/// Authored label parts before an inherited field caption is resolved.
struct DecodedFieldLabel {
    text: Option<IrMessage>,
    values: Vec<(String, IrMessage)>,
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

/// Declared model policy kind, distinct from neighboring callable registries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IrModelRuleKind {
    Invariant,
    Lock,
}

/// Owning declaration facts for a model invariant or field lock.
/// Registry sharing with read/unique predicates does not establish rule kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IrModelRuleOrigin {
    pub model: SymbolId,
    pub module: ModuleId,
    /// Global Effects ordinal across models and rule kinds.
    pub ordinal: u32,
    pub node: NodeKey,
    pub span: Span,
    pub kind: IrModelRuleKind,
    /// Checked callable registry identity, qualified when model names collide.
    pub registry_id: String,
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
    /// Present only for a declared model invariant, never read/unique rules.
    pub origin: Option<IrModelRuleOrigin>,
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
    pub origin: IrModelRuleOrigin,
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
    /// Checked declaration and field-reuse constraints, keyed by owning symbol.
    pub value_constraints: HashMap<SymbolId, CheckedValueConstraints>,
    /// Checked return-specific source closure. Runtime publication additionally
    /// requires actual evaluated-read and return capture at every selected site.
    pub scenario_disclosures:
        HashMap<SymbolId, crate::analysis::scenario_disclosure::ScenarioDisclosure>,
    /// Declaration census retained by the checked builder, never a wire claim.
    pub committed_sources: CheckedCommittedSources,
    pub standard_completion_sources: CheckedStandardCompletionSources,
    /// `catalog_version` consulted by analysis, or empty when none was.
    pub catalog_version: String,
    /// Builtin references observed while decoding checked call positions
    /// (true call-site spans), plus G13 ids from positions the build does
    /// not decode, with a fallback origin span.
    pub referenced_builtins: Vec<ReferencedBuiltin>,
    /// `read` registry rules in source order (G3).
    pub read_rules: Vec<IrRuleFn>,
    /// Protected generation callback predicates, retaining original policy ordinals.
    pub callback_read_rules: Vec<IrRuleFn>,
    /// Private source-to-IR correspondence for protected grants and observations.
    pub callback_grants: CheckedCallbackGrants,
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
    if !program.mailbox_handlers().is_empty() {
        // Original Mailbox claims are private and survive edits to public tables.
        // Refuse before general lowering can index a withdrawn/corrupt handler owner.
        let mailbox = Cx::new(program, db, catalog);
        let mailbox_diagnostics = program.mailbox_handlers().iter().filter(|handler|
            mailbox.mailbox_received_source(handler.id).is_none()).map(|handler|
            Diagnostic::error("E6008", "MailboxV1.received source: original bound trigger and complete payload correspondence unavailable".into(), handler.span)
        ).collect::<Vec<_>>();
        if !mailbox_diagnostics.is_empty() {
            let mut ir = empty_program(&program.catalog_version);
            ir.committed_sources.mailbox_event_handlers = program.mailbox_handlers().to_vec();
            return (ir, mailbox_diagnostics);
        }
    }
    if !program.standard_completion_handlers.is_empty() {
        let mut candidate = Cx::new(program, db, catalog);
        candidate.native_standard_completion = true;
        let has_hooks = program.effects.scenarios.values().any(|scenario| {
            matches!(
                scenario.on,
                Some(crate::analysis::effects::HandlerSource::Hook { .. })
            )
        });
        candidate.native_hook_context = has_hooks;
        let (ir, diagnostics) = candidate.build_program();
        let entry = super::js::pick_entrypoint(&ir)
            .map(|id| ir.module(id).name.as_str())
            .unwrap_or("index");
        let hooks_supported = !has_hooks
            || super::model_policies::collect_local_policies(&ir, &super::js::module_path(entry))
                .is_some_and(|policies| !policies.hook_bindings.is_empty());
        if hooks_supported
            && ir
                .standard_completion_sources
                .valid_public_standard_completions(&ir, db)
        {
            return (ir, diagnostics);
        }
    }
    if program.effects.scenarios.values().any(|scenario| {
        matches!(
            &scenario.on,
            Some(crate::analysis::effects::HandlerSource::Hook { .. })
        )
    }) {
        // Decode a genuine source candidate before asking the existing whole
        // owner-policy classifier whether every native callback can be bound.
        // Unsupported/partial plans are rebuilt in refusal mode; no candidate
        // contextual expression leaks into legacy two-argument hooks.
        let mut candidate = Cx::new(program, db, catalog);
        candidate.native_hook_context = true;
        let (ir, diagnostics) = candidate.build_program();
        let entry = super::js::pick_entrypoint(&ir)
            .map(|id| ir.module(id).name.as_str())
            .unwrap_or("index");
        if super::model_policies::collect_local_policies(&ir, &super::js::module_path(entry))
            .is_some_and(|policies| !policies.hook_bindings.is_empty())
        {
            return (ir, diagnostics);
        }
    }
    let mut cx = Cx::new(program, db, catalog);
    cx.build_program()
}

fn empty_program(catalog_version: &str) -> IrProgram {
    IrProgram {
        modules: Vec::new(),
        items: Vec::new(),
        value_constraints: HashMap::new(),
        scenario_disclosures: HashMap::new(),
        committed_sources: CheckedCommittedSources::default(),
        standard_completion_sources: CheckedStandardCompletionSources::default(),
        catalog_version: catalog_version.to_string(),
        referenced_builtins: Vec::new(),
        read_rules: Vec::new(),
        callback_read_rules: Vec::new(),
        callback_grants: CheckedCallbackGrants::default(),
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

/// Whether `name` is a provisioned example account (live evaluation context).
fn is_test_account(name: &str) -> bool {
    matches!(name, "self" | "other" | "outsider")
}

/// Duration literal slice (`5s`, `300ms`, ...) to milliseconds.
pub(super) fn duration_millis(slice: &str) -> Option<i128> {
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
    /// `(module, name)` to direct module declaration, excluding nested owners.
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
    /// Collected while decoding one page's bound tabs.
    page_preference_fields: Vec<IrPreferenceField>,
    /// Private candidate permission; build returns this decoding only after the
    /// complete existing owner-policy plan qualifies native callback binding.
    native_hook_context: bool,
    native_standard_completion: bool,
    callback_entries: Vec<CheckedCallbackGrant>,
    callback_reads: Vec<String>,
    callback_value_lists: Vec<String>,
    callback_sources: Vec<CheckedGenerationCallbackSource>,
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
            // Nested fields/parameters/operations have their own lexical owner.
            // They must not overwrite a module role, model or scenario with the
            // same spelling. Capability events also share Event's kind, so
            // require the exact direct-module canonical identity as well.
            if !matches!(
                symbol.kind,
                SymbolKind::Field { .. }
                    | SymbolKind::Param { .. }
                    | SymbolKind::DeriveField { .. }
                    | SymbolKind::Crud { .. }
                    | SymbolKind::CrudOp { .. }
                    | SymbolKind::CapabilityOp { .. }
            ) && program
                .modules
                .get(symbol.module.0 as usize)
                .is_some_and(|module| {
                    symbol.canonical == format!("{}.{}", module.name, symbol.name)
                })
            {
                by_name.insert((symbol.module, symbol.name.clone()), symbol.id);
            }
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
            page_preference_fields: Vec::new(),
            native_hook_context: false,
            native_standard_completion: false,
            callback_entries: Vec::new(),
            callback_reads: Vec::new(),
            callback_value_lists: Vec::new(),
            callback_sources: Vec::new(),
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
        | ResolvedType::StdNominal { .. }
        | ResolvedType::Operation(_)
        | ResolvedType::InlineMessage
        | ResolvedType::Opaque(_) => None,
    }
}

/// Whether values of this type compare structurally with
/// `equalValue(c, canonicalTypeId, a, b)` (arrays and contracts/records by
/// value rather than JavaScript object identity).
pub fn is_structural(ty: &ResolvedType) -> bool {
    match ty {
        ResolvedType::Nullable(inner) => is_structural(inner),
        ResolvedType::Array { .. }
        | ResolvedType::Record { .. }
        | ResolvedType::Object(_)
        | ResolvedType::StdNominal { .. } => true,
        ResolvedType::Error
        | ResolvedType::Unknown
        | ResolvedType::Null
        | ResolvedType::Scalar(_)
        | ResolvedType::Team
        | ResolvedType::OperationContext
        | ResolvedType::Enum { .. }
        | ResolvedType::Message(_)
        | ResolvedType::InlineMessage
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
    /// Checked static specification asset, resolved by owning declaration.
    JudgmentSpecification {
        judgment: String,
        options: Option<Box<TypedExpr>>,
    },
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
        /// Checked access chain; error members project from the authorized
        /// `error` leaf locally rather than naming additional receipt leaves.
        props: Vec<String>,
        /// Present only for an original checked protected observation.
        callback: Option<Box<CheckedGenerationCallbackRead>>,
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
        /// Finite checked leaf schemas; the evaluated descriptor selects one.
        schemas: Vec<IrFormatSchema>,
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
    /// Checked Table comparison against its source-owned query time.
    /// Private construction retains the owning source/field; this is consumed
    /// only as the Table's data-only `where`, never as a business expression.
    PageTimePredicate(CheckedPageTimePredicate),
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

/// A finite source-to-existing-query join for `row.datetime >= now` / `< now`.
/// Editable objects or lambdas cannot acquire the native time codec by shape.
#[derive(Debug, Clone)]
pub struct CheckedPageTimePredicate {
    model: SymbolId,
    model_name: String,
    field: SymbolId,
    field_name: String,
    field_span: Span,
    operation: IrBinOp,
    collection_span: Span,
    predicate_span: Span,
    /// The original bare marker owns this exact emitted prop occurrence.
    pagination: Option<(Span, usize)>,
    /// Authored cursor/page headers and malformed markers cannot gain this
    /// profile by dropping their editable IR props after source lowering.
    source_paging_supported: bool,
}

impl CheckedPageTimePredicate {
    /// Exact checked correspondence for the render seal: every recorded
    /// part must match, so two predicates correspond only when they name
    /// the same model field, comparison, source spans, and paging support.
    /// The ambient `now` instant itself is bound at render time, never
    /// sealed here.
    pub(crate) fn corresponds(&self, other: &Self) -> bool {
        self.model == other.model
            && self.model_name == other.model_name
            && self.field == other.field
            && self.field_name == other.field_name
            && self.field_span == other.field_span
            && self.operation == other.operation
            && self.collection_span == other.collection_span
            && self.predicate_span == other.predicate_span
            && self.pagination == other.pagination
            && self.source_paging_supported == other.source_paging_supported
    }
    pub(crate) fn checked_parts<'a>(
        &'a self,
        ir: &IrProgram,
        node: &IrUi,
        value: &TypedExpr,
    ) -> Option<(&'a str, &'a str, bool)> {
        if node.factory != "table"
            || node.span != self.collection_span
            || value.span != self.predicate_span
            || value.ty != ResolvedType::Unknown
            || !self.source_paging_supported
            || node.props.iter().any(|(key, _)| key == "cursor")
        {
            return None;
        }
        let mut model_props = node.props.iter().filter(|(key, _)| key == "model");
        let (_, original_model) = model_props.next()?;
        if model_props.next().is_some()
            || original_model.ty != ResolvedType::Scalar(Scalar::Text)
            || !matches!(&original_model.expr, IrExpr::Text(name) if name == &self.model_name)
        {
            return None;
        }
        let mut where_props = node.props.iter().filter(|(key, _)| key == "where");
        let (_, original_where) = where_props.next()?;
        if where_props.next().is_some()
            || !std::ptr::eq(original_where, value)
            || original_where.span != self.predicate_span
            || original_where.ty != ResolvedType::Unknown
            || !matches!(&original_where.expr, IrExpr::PageTimePredicate(predicate)
                if std::ptr::eq(predicate, self))
        {
            return None;
        }
        let mut page_props = node
            .props
            .iter()
            .enumerate()
            .filter(|(_, (key, _))| key == "page");
        let paginated = match (self.pagination, page_props.next()) {
            (None, None) => false,
            (Some((span, position)), Some((actual_position, (_, page))))
                if actual_position == position
                    && page.span == span
                    && page.ty == ResolvedType::Scalar(Scalar::Bool)
                    && matches!(page.expr, IrExpr::Bool(true))
                    && page_props.next().is_none() =>
            {
                true
            }
            _ => return None,
        };
        let model = ir.items.get(self.model.0 as usize)?;
        let IrItemKind::Model { fields, .. } = &model.kind else {
            return None;
        };
        let field = ir.items.get(self.field.0 as usize)?;
        if model.id != self.model
            || model.canonical != self.model_name
            || !fields.contains(&self.field)
            || field.id != self.field
            || field.name != self.field_name
            || field.canonical != format!("{}.{}", self.model_name, self.field_name)
            || field.span != self.field_span
            || !matches!(field.kind, IrItemKind::Field {
                owner,
                ty: IrType::Known(ResolvedType::Scalar(Scalar::Datetime)),
                ..
            } if owner == self.model)
        {
            return None;
        }
        let operation = match self.operation {
            IrBinOp::Ge => "gte",
            IrBinOp::Lt => "lt",
            _ => return None,
        };
        Some((operation, &self.field_name, paginated))
    }
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

/// One checked, alias-scoped supplied-array ordering expression.
#[derive(Debug, Clone)]
pub struct IrValueOrder {
    pub key: Box<TypedExpr>,
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
    /// Actual checked authored query, before lexical clause identities are erased.
    /// Synthetic and example-only queries do not acquire a source proof.
    pub source: Option<Box<CheckedQuery>>,
    /// Exact selected collection call, joined to this query and its external predicate.
    /// This is source correspondence, not native query admission.
    pub collection_call: Option<Box<crate::analysis::types::CheckedCollectionCall>>,
    /// Separate immutable value-domain contract alias proof; never a model scan.
    pub contract_collection_call:
        Option<Box<crate::analysis::types::CheckedContractCollectionCall>>,
    /// Query domain.
    pub domain: IrQueryDomain,
    /// Containment parent value, if any (model domains only).
    pub parent: Option<Box<TypedExpr>>,
    /// Lexical parameter of the query predicate, preserving outer `row`.
    pub where_param: String,
    /// Row predicate over the query parameter, if any.
    pub where_pred: Option<Box<TypedExpr>>,
    /// Whether the predicate needs `async` (delivery reads, service calls).
    pub where_async: bool,
    /// Order entries in source order (model domains only).
    pub order: Vec<IrOrder>,
    /// Supplied-array key; model domains retain their existing field recipes.
    pub value_order: Option<IrValueOrder>,
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
// Checked expressions stay inline in the once-built IR, as with IrStep below.
// Boxing here would change its public representation and add allocations.
#[derive(Debug, Clone)]
#[allow(clippy::large_enum_variant)]
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
#[derive(Debug, Clone, PartialEq)]
pub enum IrEventSource {
    Declared(String),
    Queue {
        source: String,
        payload: ResolvedType,
    },
    DeliveryProgressed(String),
    /// Original removed-account payload, separate from removing attribution.
    TeamsMemberRemoved,
    /// Checked bound MailboxV1.received source. This is not ingress authority.
    MailboxReceived {
        source: String,
        binding: String,
        from: String,
    },
    Committed {
        model: SymbolId,
        change: IrCommittedChange,
    },
    StandardCompleted {
        source: String,
        canonical_operation: String,
        result_type: String,
        binding: String,
        from: String,
    },
    /// Typed adapter completion `on=Cap.op.completed` (DESIGN §8):
    /// `{delivery_id, status, result:R?, error}` with the op's
    /// declared result type name for the invocation descriptor.
    DeliveryCompleted {
        source: String,
        result_type: String,
    },
    /// Recurring tick `on=every(duration)` (DESIGN §6): UTC-epoch
    /// aligned period in integer milliseconds. The handler infers its
    /// data scope from owner-bound reads/writes; the tick itself
    /// carries no event inputs.
    Every {
        interval_ms: i128,
    },
    /// Fixed `on=instrumentation.error` source. The checker narrows
    /// no event fields for it, so the payload stays opaque and the
    /// invocation carries no inputs.
    InstrumentationError,
}

/// Final stored-change vocabulary shared with the defining artifact contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IrCommittedChange {
    Create,
    Update,
    Delete,
}

impl IrCommittedChange {
    pub fn suffix(self) -> &'static str {
        match self {
            Self::Create => "created",
            Self::Update => "updated",
            Self::Delete => "deleted",
        }
    }
}

/// Immutable source census prevents a partial or edited IR from claiming a
/// complete trigger inventory. Raw IR fixtures can only construct the empty
/// default. No runtime authority or extra public artifact DTO is introduced.
#[derive(Debug, Clone, Default)]
pub struct CheckedCommittedSources {
    pub(crate) sources: Vec<(crate::source::SourceId, String, String)>,
    pub(crate) handlers: Vec<CheckedCommittedHandler>,
    // Source-cohort schema absence, independent of committed handler/event authority.
    empty_value_inventory: Option<CheckedEmptyValueInventory>,
    standard_value_inventory: Option<CheckedStandardValueInventory>,
    // Nongrant native refusal requirement, retained when editable disclosure
    // facts or operation IDs are withdrawn after checked lowering.
    native_model_result_indices: std::collections::HashSet<usize>,
    mailbox_event_handlers: Vec<crate::analysis::CheckedMailboxHandler>,
}

/// Selected schema roots are source evidence, not native event authority.
#[derive(Debug, Clone)]
struct CheckedStandardValueInventory {
    catalog_version: String,
    census: StandardValueCensus,
}

#[derive(Debug, Clone, PartialEq)]
struct StandardValueModule {
    id: ModuleId,
    name: String,
    kind: ModuleKind,
    file: SourceId,
    span: Span,
    imports: Vec<StandardValueImport>,
}

#[derive(Debug, Clone, PartialEq)]
struct StandardValueImport {
    provider: String,
    provider_span: Span,
    members: Vec<(String, String, Span)>,
    from: Option<String>,
    span: Span,
}

#[derive(Debug, Clone, PartialEq)]
struct StandardValueSelection {
    item: Option<SymbolId>,
    module: ModuleId,
    position: String,
    identity: String,
    binding: Option<String>,
    span: Span,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct StandardValueCensus {
    modules: Vec<StandardValueModule>,
    selections: Vec<StandardValueSelection>,
    declarations: Vec<EmptyValueItem>,
    constraints: HashMap<SymbolId, CheckedValueConstraints>,
    roots: Vec<(String, Span)>,
}

impl StandardValueCensus {
    fn operation(
        &mut self,
        capability: &str,
        op: &'static crate::analysis::catalog::StdOperation,
        span: Span,
    ) -> Option<()> {
        let selected = crate::analysis::catalog::std_operation(capability, op.name)?;
        if !std::ptr::eq(selected, op) {
            return None;
        }
        self.roots
            .extend(op.inputs.iter().map(|(_, ty)| ((*ty).to_string(), span)));
        self.roots.push((op.result.to_string(), span));
        self.roots.push(("DeliveryError".to_string(), span));
        Some(())
    }

    fn declared(&mut self, item: &IrItem, ty: &ResolvedType, path: &str) -> Option<()> {
        match ty {
            ResolvedType::StdNominal { .. } => {
                let name = crate::analysis::types::checked_standard_nominal_name(ty)?;
                self.roots.push((name.to_string(), item.span));
                self.selections.push(StandardValueSelection {
                    item: Some(item.id),
                    module: item.module,
                    position: format!("{}:{path}", item.canonical),
                    identity: name.to_string(),
                    binding: None,
                    span: item.span,
                });
            }
            ResolvedType::StdDelivery { capability, op } => {
                self.operation(capability, op, item.span)?;
                self.selections.push(StandardValueSelection {
                    item: Some(item.id),
                    module: item.module,
                    position: format!("{}:{path}", item.canonical),
                    identity: format!("{capability}.{}", op.name),
                    binding: None,
                    span: item.span,
                });
            }
            ResolvedType::Nullable(inner) => self.declared(item, inner, &format!("{path}?"))?,
            ResolvedType::Array { element, .. } => {
                self.declared(item, element, &format!("{path}[]"))?
            }
            ResolvedType::Object(fields) => {
                for (name, ty) in fields {
                    self.declared(item, ty, &format!("{path}.{name}"))?;
                }
            }
            _ => {}
        }
        Some(())
    }

    fn progressed(&mut self, ir: &IrProgram, item: &IrItem, source: &str) -> Option<()> {
        let module = ir.modules.get(item.module.0 as usize)?;
        if module.id != item.module {
            return None;
        }
        let authored = source.strip_prefix(&format!("{}.", module.name))?;
        let segments: Vec<_> = authored.split('.').collect();
        if segments.len() != 3 || segments[2] != "progressed" {
            return None;
        }
        let authored_alias = segments[0];
        let matches: Vec<_> = module
            .imports
            .iter()
            .flat_map(|import| {
                import
                    .members
                    .iter()
                    .filter(move |(_, alias, _)| alias == authored_alias)
                    .map(move |member| (import, member))
            })
            .collect();
        if matches.len() != 1 {
            return None;
        }
        let (import, (name, alias, _)) = matches[0];
        if import.provider != "std" {
            return None;
        }
        let capability = std_capability(name)?;
        // Same original-operation allowlist as checked on=...progressed;
        // cancellation/reconciliation observations are not progress triggers.
        if !matches!(
            (capability.name, segments[1]),
            ("std.TextGenerationV1", "generate") | ("std.ImagesV1", "submit")
        ) {
            return None;
        }
        let op = crate::analysis::catalog::std_operation(capability.name, segments[1])?;
        if source != format!("{}.{}.{}.progressed", module.name, alias, op.name) {
            return None;
        }
        self.operation(capability.name, op, item.span)?;
        self.selections.push(StandardValueSelection {
            item: Some(item.id),
            module: item.module,
            position: format!("{}:progressed", item.canonical),
            identity: source.to_string(),
            binding: Some(format!("{}.{}", module.name, alias)),
            span: item.span,
        });
        Some(())
    }

    fn statements(&mut self, ir: &IrProgram, item: &IrItem, statements: &[IrStmt]) -> Option<()> {
        for statement in statements {
            match statement {
                IrStmt::Send {
                    operation,
                    deployment_binding,
                    span,
                    ..
                } if operation.starts_with("std.") => {
                    let (capability, name) = operation.rsplit_once('.')?;
                    let op = crate::analysis::catalog::std_operation(capability, name)?;
                    let module = ir.modules.get(item.module.0 as usize)?;
                    if module.id != item.module {
                        return None;
                    }
                    let binding = deployment_binding.as_ref()?;
                    let alias = binding.strip_prefix(&format!("{}.", module.name))?;
                    let matches: Vec<_> = module
                        .imports
                        .iter()
                        .flat_map(|import| {
                            import
                                .members
                                .iter()
                                .filter(move |(_, authored, _)| authored == alias)
                                .map(move |member| (import, member))
                        })
                        .collect();
                    if matches.len() != 1 {
                        return None;
                    }
                    let (import, (imported, _, _)) = matches[0];
                    if import.provider != "std"
                        || import.from.is_none()
                        || std_capability(imported)?.name != capability
                    {
                        return None;
                    }
                    self.operation(capability, op, *span)?;
                    self.selections.push(StandardValueSelection {
                        item: Some(item.id),
                        module: item.module,
                        position: format!("{}:send", item.canonical),
                        identity: operation.clone(),
                        binding: Some(binding.clone()),
                        span: *span,
                    });
                }
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    self.statements(ir, item, then_branch)?;
                    self.statements(ir, item, else_branch)?;
                }
                IrStmt::Match { arms, .. } => {
                    for arm in arms {
                        self.statements(ir, item, &arm.body)?;
                    }
                }
                IrStmt::For { body, .. } => self.statements(ir, item, body)?,
                _ => {}
            }
        }
        Some(())
    }

    fn declaration(item: &IrItem) -> EmptyValueItem {
        let mut row = EmptyValueItem {
            id: item.id,
            canonical: item.canonical.clone(),
            name: item.name.clone(),
            module: item.module,
            span: item.span,
            exported: item.exported,
            kind: std::mem::discriminant(&item.kind),
            links: Vec::new(),
            types: Vec::new(),
            owner: None,
            required_array: false,
            flags: Vec::new(),
            names: Vec::new(),
            event_field: None,
        };
        fn declared(row: &mut EmptyValueItem, ty: &IrType) {
            // Preserve both declared presence and whether analysis supplied it.
            row.flags.push(matches!(ty, IrType::Known(_)));
            if let IrType::Known(ty) = ty {
                row.types.push(ty.clone());
            }
        }
        match &item.kind {
            IrItemKind::Model {
                fields,
                owner,
                crud,
                ..
            } => {
                row.links = fields.clone();
                row.names.push(fields.len().to_string());
                row.flags.push(crud.is_some());
                row.links.extend(crud);
                row.owner = Some(*owner);
            }
            IrItemKind::Contract { fields, .. }
            | IrItemKind::Event { fields }
            | IrItemKind::Preferences { fields, .. } => row.links = fields.clone(),
            IrItemKind::Judgment {
                result_fields,
                version,
                source_language,
                ..
            } => {
                row.links = result_fields.clone();
                row.names = vec![source_language.clone(), version.to_string()];
            }
            IrItemKind::Capability {
                ops,
                events,
                version,
            } => {
                row.links = ops.clone();
                row.names.push(ops.len().to_string());
                row.links.extend(events);
                row.names.extend(version.map(|version| version.to_string()));
            }
            IrItemKind::CapabilityOp { params, result }
            | IrItemKind::DeriveFn { params, result, .. } => {
                row.links = params.clone();
                declared(&mut row, result);
            }
            IrItemKind::Message { params, .. } => row.links = params.clone(),
            IrItemKind::Fixture { target, .. } => match target {
                FixtureTarget::Model(model) => {
                    row.names.push("model".to_string());
                    row.links.push(*model);
                }
                FixtureTarget::Operation(operation) => {
                    row.names.push("operation".to_string());
                    row.flags.push(operation.is_some());
                    row.links.extend(operation);
                }
                FixtureTarget::User => row.names.push("user".to_string()),
                FixtureTarget::File => row.names.push("file".to_string()),
                FixtureTarget::Unknown => row.names.push("unknown".to_string()),
            },
            IrItemKind::Scenario { params, result, .. } => {
                row.links = params.clone();
                row.flags.push(result.is_some());
                row.types.extend(result.clone());
            }
            IrItemKind::Field {
                owner,
                ty,
                required_array,
                ..
            } => {
                row.links.push(*owner);
                row.required_array = *required_array;
                declared(&mut row, ty);
            }
            IrItemKind::Param {
                owner, index, ty, ..
            } => {
                row.links.push(*owner);
                row.names.push(index.to_string());
                declared(&mut row, ty);
            }
            IrItemKind::DeriveField { model, ty, .. } => {
                row.links.push(*model);
                declared(&mut row, ty);
            }
            IrItemKind::Crud {
                model,
                create,
                update,
                delete,
                ..
            } => {
                row.links.push(*model);
                row.flags = vec![*create, *update, *delete];
            }
            IrItemKind::CrudOp { model, fields, .. } => {
                row.links.push(*model);
                row.names = fields.clone();
            }
            IrItemKind::JudgmentGenerated(generated) => match generated {
                IrJudgmentGenerated::Contract { fields } => {
                    row.names.push("contract".to_string());
                    row.links = fields.clone();
                }
                IrJudgmentGenerated::Field {
                    owner,
                    ty,
                    required_array,
                } => {
                    row.names.push("field".to_string());
                    row.links.push(*owner);
                    row.required_array = *required_array;
                    declared(&mut row, ty);
                }
                IrJudgmentGenerated::Param { owner, index, ty } => {
                    row.names = vec!["param".to_string(), index.to_string()];
                    row.links.push(*owner);
                    declared(&mut row, ty);
                }
                IrJudgmentGenerated::CapabilityOp { params, result }
                | IrJudgmentGenerated::Specification { params, result } => {
                    row.names.push(
                        if matches!(generated, IrJudgmentGenerated::CapabilityOp { .. }) {
                            "operation"
                        } else {
                            "specification"
                        }
                        .to_string(),
                    );
                    row.links = params.clone();
                    declared(&mut row, result);
                }
                IrJudgmentGenerated::Unsupported => row.names.push("unsupported".to_string()),
            },
            _ => {}
        }
        row
    }

    fn collect(ir: &IrProgram) -> Option<Self> {
        let mut census = Self {
            declarations: ir.items.iter().map(Self::declaration).collect(),
            constraints: ir.value_constraints.clone(),
            ..Self::default()
        };
        for module in &ir.modules {
            census.modules.push(StandardValueModule {
                id: module.id,
                name: module.name.clone(),
                kind: module.kind,
                file: module.file,
                span: module.span,
                imports: module
                    .imports
                    .iter()
                    .map(|import| StandardValueImport {
                        provider: import.provider.clone(),
                        provider_span: import.provider_span,
                        members: import.members.clone(),
                        from: import.from.clone(),
                        span: import.span,
                    })
                    .collect(),
            });
            for import in &module.imports {
                if import.provider == "std" {
                    for (name, alias, span) in &import.members {
                        if let Some(schema) = crate::analysis::catalog::nominal_schema(name) {
                            census.roots.push((schema.name.to_string(), *span));
                            census.selections.push(StandardValueSelection {
                                item: None,
                                module: module.id,
                                position: "import".to_string(),
                                identity: name.clone(),
                                binding: Some(alias.clone()),
                                span: *span,
                            });
                        }
                    }
                }
            }
        }
        for item in &ir.items {
            match &item.kind {
                IrItemKind::Scenario {
                    result,
                    guards,
                    effects,
                    event_source,
                    ..
                } => {
                    if let Some(IrEventSource::DeliveryProgressed(source)) = event_source {
                        census.progressed(ir, item, source)?;
                    }
                    if let Some(IrEventSource::MailboxReceived {
                        source, binding, ..
                    }) = event_source
                    {
                        census.roots.push(("IncomingEmail".into(), item.span));
                        census.selections.push(StandardValueSelection {
                            item: Some(item.id),
                            module: item.module,
                            position: format!("{}:mailbox-received", item.canonical),
                            identity: source.clone(),
                            binding: Some(binding.clone()),
                            span: item.span,
                        });
                    }
                    if let Some(ty) = result {
                        census.declared(item, ty, "result")?;
                    }
                    census.statements(ir, item, guards)?;
                    census.statements(ir, item, effects)?;
                }
                IrItemKind::Field { ty, .. }
                | IrItemKind::Param { ty, .. }
                | IrItemKind::DeriveField { ty, .. }
                | IrItemKind::CapabilityOp { result: ty, .. }
                | IrItemKind::DeriveFn { result: ty, .. }
                | IrItemKind::JudgmentGenerated(
                    IrJudgmentGenerated::Field { ty, .. }
                    | IrJudgmentGenerated::Param { ty, .. }
                    | IrJudgmentGenerated::CapabilityOp { result: ty, .. }
                    | IrJudgmentGenerated::Specification { result: ty, .. },
                ) => {
                    if let IrType::Known(ty) = ty {
                        census.declared(item, ty, "declaration")?;
                    }
                }
                _ => {}
            }
        }
        Some(census)
    }
}

/// Private evidence for the bounded no-import File-model source cohort. The
/// original CST establishes absence; the census prevents an edited IR from
/// borrowing that evidence. This carries no handler or runtime authority.
#[derive(Debug, Clone)]
struct CheckedEmptyValueInventory {
    catalog_version: String,
    roots: Vec<NodeKey>,
    modules: Vec<EmptyValueModule>,
    items: Vec<EmptyValueItem>,
    constraints: HashMap<SymbolId, CheckedValueConstraints>,
}

#[derive(Debug, Clone, PartialEq)]
struct EmptyValueModule {
    id: ModuleId,
    name: String,
    kind: ModuleKind,
    file: SourceId,
    span: Span,
    locale: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct EmptyValueItem {
    id: SymbolId,
    canonical: String,
    name: String,
    module: ModuleId,
    span: Span,
    exported: bool,
    kind: std::mem::Discriminant<IrItemKind>,
    links: Vec<SymbolId>,
    types: Vec<ResolvedType>,
    owner: Option<IrOwner>,
    required_array: bool,
    flags: Vec<bool>,
    names: Vec<String>,
    event_field: Option<EmptyEventField>,
}

/// Retain the actual event schema facts beside its existing declaration census.
/// This is metadata correspondence; it does not admit or execute an event.
#[derive(Debug, Clone, PartialEq)]
struct EmptyEventField {
    default: Option<EmptyEventLiteral>,
    trim: bool,
    min: Option<EmptyEventLiteral>,
    max: Option<EmptyEventLiteral>,
    unique: bool,
    machine: bool,
    label: Option<(EmptyEventMessage, Vec<(String, EmptyEventMessage)>)>,
    description: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct EmptyEventMessage {
    source: String,
    source_lang: String,
    variants: Vec<(String, Option<String>)>,
    params: Vec<(String, String, EmptyEventLiteral)>,
}

impl EmptyEventMessage {
    fn capture(message: &IrMessage) -> Option<Self> {
        Some(Self {
            source: message.source.clone(),
            source_lang: message.source_lang.clone(),
            variants: message.variants.clone(),
            params: message
                .params
                .iter()
                .map(|param| {
                    Some((
                        param.name.clone(),
                        param.type_id.clone(),
                        EmptyEventLiteral::capture(&param.value)?,
                    ))
                })
                .collect::<Option<_>>()?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
struct EmptyEventLiteral {
    ty: ResolvedType,
    span: Span,
    value: EmptyEventValue,
}

#[derive(Debug, Clone, PartialEq)]
enum EmptyEventValue {
    Int(i128),
    Decimal(String),
    Text(String),
    Bool(bool),
    Null,
    Money(i128, String),
    Duration(i128),
    Date(String),
    Datetime(String),
    Array(Vec<EmptyEventLiteral>),
    Object(Vec<(String, EmptyEventLiteral)>),
}

impl EmptyEventLiteral {
    fn capture(expr: &TypedExpr) -> Option<Self> {
        let value = match &expr.expr {
            IrExpr::Int(value) => EmptyEventValue::Int(*value),
            IrExpr::Decimal(value) => EmptyEventValue::Decimal(value.clone()),
            IrExpr::Text(value) => EmptyEventValue::Text(value.clone()),
            IrExpr::Bool(value) => EmptyEventValue::Bool(*value),
            IrExpr::Null => EmptyEventValue::Null,
            IrExpr::Money { minor, currency } => EmptyEventValue::Money(*minor, currency.clone()),
            IrExpr::DurationMs(value) => EmptyEventValue::Duration(*value),
            IrExpr::Date(value) => EmptyEventValue::Date(value.clone()),
            IrExpr::Datetime(value) => EmptyEventValue::Datetime(value.clone()),
            IrExpr::Array(values) => {
                EmptyEventValue::Array(values.iter().map(Self::capture).collect::<Option<_>>()?)
            }
            IrExpr::Object(values) => EmptyEventValue::Object(
                values
                    .iter()
                    .map(|(name, value)| Some((name.clone(), Self::capture(value)?)))
                    .collect::<Option<_>>()?,
            ),
            _ => return None,
        };
        Some(Self {
            ty: expr.ty.clone(),
            span: expr.span,
            value,
        })
    }
}

impl CheckedEmptyValueInventory {
    fn census(ir: &IrProgram) -> Option<(Vec<EmptyValueModule>, Vec<EmptyValueItem>)> {
        if ir.modules.is_empty()
            || ir.modules.iter().any(|module| {
                !module.imports.is_empty()
                    || !module.uses.is_empty()
                    || !module.uses_resolved.is_empty()
            })
            || ir
                .value_constraints
                .values()
                .any(|constraint| constraint.alias.is_some())
        {
            return None;
        }
        let modules = ir
            .modules
            .iter()
            .map(|module| EmptyValueModule {
                id: module.id,
                name: module.name.clone(),
                kind: module.kind,
                file: module.file,
                span: module.span,
                locale: module.app_default_locale.clone(),
            })
            .collect();
        let mut has_file_model = false;
        let mut items = Vec::with_capacity(ir.items.len());
        fn file_type(ty: &ResolvedType) -> bool {
            match ty {
                ResolvedType::Scalar(Scalar::File) => true,
                ResolvedType::Nullable(inner) => file_type(inner),
                ResolvedType::Array { element, .. } => file_type(element),
                _ => false,
            }
        }
        fn known(ty: &IrType) -> Option<ResolvedType> {
            match ty {
                IrType::Known(ty) if !matches!(ty, ResolvedType::Error | ResolvedType::Unknown) => {
                    Some(ty.clone())
                }
                _ => None,
            }
        }
        for item in &ir.items {
            let mut row = EmptyValueItem {
                id: item.id,
                canonical: item.canonical.clone(),
                name: item.name.clone(),
                module: item.module,
                span: item.span,
                exported: item.exported,
                kind: std::mem::discriminant(&item.kind),
                links: Vec::new(),
                types: Vec::new(),
                owner: None,
                required_array: false,
                flags: Vec::new(),
                names: Vec::new(),
                event_field: None,
            };
            match &item.kind {
                IrItemKind::Contract { .. }
                | IrItemKind::Judgment { .. }
                | IrItemKind::JudgmentGenerated(_)
                | IrItemKind::Capability { .. }
                | IrItemKind::CapabilityOp { .. }
                | IrItemKind::Preferences { .. } => return None,
                IrItemKind::Event { fields } => {
                    row.links = fields.clone();
                    let mut seen = HashSet::new();
                    for id in fields {
                        let field = ir.items.get(id.0 as usize)?;
                        if field.id != *id
                            || field.module != item.module
                            || !seen.insert(id)
                            || field.canonical != format!("{}.{}", item.canonical, field.name)
                            || !matches!(field.kind,IrItemKind::Field { owner, .. } if owner == item.id)
                        {
                            return None;
                        }
                    }
                }
                IrItemKind::Model {
                    fields,
                    owner,
                    crud,
                    ..
                } => {
                    row.links = fields.clone();
                    row.links.extend(crud);
                    row.owner = Some(*owner);
                    for field in fields {
                        let field = ir.items.iter().find(|candidate| candidate.id == *field)?;
                        let IrItemKind::Field { owner, ty, .. } = &field.kind else {
                            return None;
                        };
                        if *owner != item.id {
                            return None;
                        }
                        has_file_model |= file_type(&known(ty)?);
                    }
                }
                IrItemKind::Field {
                    owner,
                    ty,
                    required_array,
                    default,
                    server,
                    modifiers,
                    label,
                    description,
                    ..
                } => {
                    row.links.push(*owner);
                    row.types.push(known(ty)?);
                    row.required_array = *required_array;
                    if matches!(
                        ir.items.get(owner.0 as usize)?.kind,
                        IrItemKind::Event { .. }
                    ) {
                        if server.is_some() {
                            return None;
                        }
                        let literal =
                            |value: &Option<TypedExpr>| -> Option<Option<EmptyEventLiteral>> {
                                match value {
                                    None => Some(None),
                                    Some(value) => Some(Some(EmptyEventLiteral::capture(value)?)),
                                }
                            };
                        let default = match default {
                            None => None,
                            Some(IrDefault::Literal(value)) => {
                                Some(EmptyEventLiteral::capture(value)?)
                            }
                            _ => return None,
                        };
                        row.event_field = Some(EmptyEventField {
                            default,
                            trim: modifiers.trim,
                            min: literal(&modifiers.min)?,
                            max: literal(&modifiers.max)?,
                            unique: modifiers.unique,
                            machine: modifiers.machine,
                            label: match label {
                                None => None,
                                Some(label) => Some((
                                    EmptyEventMessage::capture(&label.text)?,
                                    label
                                        .values
                                        .iter()
                                        .map(|(name, message)| {
                                            Some((
                                                name.clone(),
                                                EmptyEventMessage::capture(message)?,
                                            ))
                                        })
                                        .collect::<Option<_>>()?,
                                )),
                            },
                            description: description.clone(),
                        });
                    }
                }
                IrItemKind::Param {
                    owner, index, ty, ..
                } => {
                    row.links.push(*owner);
                    // Parameter order is part of the owning declaration census.
                    if ir
                        .items
                        .iter()
                        .find(|candidate| candidate.id == *owner)
                        .and_then(|owner| match &owner.kind {
                            IrItemKind::Scenario { params, .. }
                            | IrItemKind::DeriveFn { params, .. }
                            | IrItemKind::Message { params, .. } => params.get(*index),
                            _ => None,
                        })
                        != Some(&item.id)
                    {
                        return None;
                    }
                    row.types.push(known(ty)?);
                }
                IrItemKind::Scenario { params, result, .. } => {
                    row.links = params.clone();
                    row.types.extend(result.clone());
                }
                IrItemKind::DeriveField { model, ty, .. } => {
                    row.links.push(*model);
                    row.types.push(known(ty)?);
                }
                IrItemKind::DeriveFn { params, result, .. } => {
                    row.links = params.clone();
                    row.types.push(known(result)?);
                }
                IrItemKind::Message { params, .. } => row.links = params.clone(),
                IrItemKind::Crud {
                    model,
                    create,
                    update,
                    delete,
                    ..
                } => {
                    row.links.push(*model);
                    row.flags = vec![*create, *update, *delete];
                }
                IrItemKind::CrudOp { model, fields, .. } => {
                    row.links.push(*model);
                    row.names = fields.clone();
                }
                _ => {}
            }
            items.push(row);
        }
        has_file_model.then_some((modules, items))
    }
}

impl CheckedCommittedSources {
    pub(crate) fn requires_mailbox_event(&self, index: usize) -> bool {
        self.mailbox_event_handlers
            .iter()
            .any(|handler| handler.id.0 as usize == index)
    }
    pub(crate) fn mailbox_event_handlers(&self) -> &[crate::analysis::CheckedMailboxHandler] {
        &self.mailbox_event_handlers
    }
    pub(crate) fn requires_native_model_result(&self, index: usize) -> bool {
        self.native_model_result_indices.contains(&index)
    }
    /// Reuse original source ownership for the fixed removal payload. This is
    /// compiler correspondence only; it authenticates no Identity occurrence.
    pub(crate) fn teams_member_removed_matches(
        &self,
        ir: &IrProgram,
        handler: &IrItem,
        db: &SourceDb,
    ) -> bool {
        let IrItemKind::Scenario {
            trusted: true,
            event_source: Some(IrEventSource::TeamsMemberRemoved),
            hook: None,
            guards,
            effects,
            ..
        } = &handler.kind
        else {
            return false;
        };
        let Some(module) = ir.modules.get(handler.module.0 as usize) else {
            return false;
        };
        if module.id != handler.module
            || module.file != handler.span.file
            || handler.canonical != format!("{}.{}", module.name, handler.name)
            || ir
                .items
                .get(handler.id.0 as usize)
                .is_none_or(|item| item.span != handler.span)
            || self.sources.is_empty()
        {
            return false;
        }
        let mut trees = Vec::new();
        for (id, path, hash) in &self.sources {
            let Some(source) = db.get(*id) else {
                return false;
            };
            if source.path != *path
                || source.sha256 != *hash
                || sha256_hex(source.text.as_bytes()) != *hash
            {
                return false;
            }
            let (tree, diagnostics) = crate::syntax::parse_source(*id, &source.text);
            if !diagnostics.is_empty() {
                return false;
            }
            trees.push((*id, tree));
        }
        let Some(tree) = trees
            .iter()
            .find(|(id, _)| *id == module.file)
            .map(|(_, tree)| tree)
        else {
            return false;
        };
        let Some(source) = db.get(module.file) else {
            return false;
        };
        let Some(declaration) = tree.descendants().find(|node| {
            node.kind == SyntaxKind::Scenario
                && kids(node).iter().any(|part| {
                    part.kind == SyntaxKind::Name
                        && part.span == handler.span
                        && name_text(db, part).as_deref() == Some(handler.name.as_str())
                })
        }) else {
            return false;
        };
        let Some(on) = crate::analysis::attribute_value(declaration, "on", &source.text) else {
            return false;
        };
        if on.kind != SyntaxKind::Path
            || crate::analysis::path_segments(on, &source.text) != ["teams", "member_removed"]
        {
            return false;
        }
        // Lexical resolution supplies only contextual identity here. Builtin
        // availability and payload admission remain their existing owners.
        let mut diagnostics = Vec::new();
        let Ok(resolved) =
            crate::analysis::resolve::try_resolve_program(db, &trees, None, &mut diagnostics)
        else {
            return false;
        };
        let payload = ResolvedType::Object(vec![
            ("team_id".into(), ResolvedType::Scalar(Scalar::Text)),
            ("membership_id".into(), ResolvedType::Scalar(Scalar::Text)),
            ("user".into(), ResolvedType::Scalar(Scalar::User)),
        ]);
        let contextual = |value: &TypedExpr| {
            matches!(
                resolved.node_binding.get(&NodeKey {
                    file: value.span.file,
                    start: value.span.start,
                    end: value.span.end,
                    kind: SyntaxKind::NameRef as u8
                }),
                Some(crate::analysis::resolve::Binding::Context(
                    crate::analysis::resolve::ContextVar::Event
                ))
            )
        };
        fn event_type(
            value: &TypedExpr,
            contextual: &impl Fn(&TypedExpr) -> bool,
            payload: &ResolvedType,
            depth: usize,
        ) -> Result<Option<ResolvedType>, ()> {
            if depth > 64 {
                return Err(());
            }
            if contextual(value) {
                return Ok(Some(payload.clone()));
            }
            if let IrExpr::Member { base, field } = &value.expr {
                let Some(base_type) = event_type(base, contextual, payload, depth + 1)? else {
                    return Ok(None);
                };
                return match base_type {
                    ResolvedType::Object(fields) => fields
                        .into_iter()
                        .find(|(name, _)| name == field)
                        .map(|(_, ty)| Some(ty))
                        .ok_or(()),
                    ResolvedType::Scalar(Scalar::User) if field == "id" => {
                        Ok(Some(ResolvedType::Scalar(Scalar::Text)))
                    }
                    _ => Err(()),
                };
            }
            Ok(None)
        }
        let mut statements = guards
            .iter()
            .chain(effects)
            .map(|statement| (statement, 0usize))
            .collect::<Vec<_>>();
        let mut expressions = Vec::new();
        let mut count = 0usize;
        while let Some((statement, depth)) = statements.pop() {
            count += 1;
            if count > 20000 || depth > 64 {
                return false;
            }
            let mut add = |value| expressions.push((value, depth));
            match statement {
                IrStmt::Let { value, .. } => add(value),
                IrStmt::Create { input, .. } => add(input),
                IrStmt::Set {
                    record, changes, ..
                } => {
                    add(record);
                    add(changes);
                }
                IrStmt::Transition { record, .. } | IrStmt::Delete { record, .. } => add(record),
                IrStmt::Call { target, inputs, .. } => {
                    add(inputs);
                    if let Some(value) = target.operand() {
                        add(value);
                    }
                }
                IrStmt::Emit { payload, .. } => add(payload),
                IrStmt::Send { args, when, .. } => {
                    add(args);
                    if let Some(value) = when {
                        add(value);
                    }
                }
                IrStmt::Schedule {
                    key, at, payload, ..
                } => {
                    add(key);
                    add(at);
                    add(payload);
                }
                IrStmt::Cancel { key, .. } => add(key),
                IrStmt::Return { value, .. } => {
                    if let Some(value) = value {
                        add(value);
                    }
                }
                IrStmt::Require { cond, .. } => add(cond),
                IrStmt::If {
                    cond,
                    then_branch,
                    else_branch,
                    ..
                } => {
                    add(cond);
                    statements.extend(
                        then_branch
                            .iter()
                            .chain(else_branch)
                            .map(|value| (value, depth + 1)),
                    );
                }
                IrStmt::Match { subject, arms, .. } => {
                    add(subject);
                    for arm in arms {
                        statements.extend(arm.body.iter().map(|value| (value, depth + 1)));
                    }
                }
                IrStmt::For {
                    domain,
                    limit,
                    body,
                    ..
                } => {
                    add(domain);
                    if let Some(value) = limit {
                        add(value);
                    }
                    statements.extend(body.iter().map(|value| (value, depth + 1)));
                }
                IrStmt::Unsupported { .. } => {}
            }
        }
        while let Some((value, depth)) = expressions.pop() {
            count += 1;
            if count > 20000 || depth > 64 {
                return false;
            }
            if contextual(value)
                && (!matches!(&value.expr, IrExpr::Name(name) if name == "event")
                    || value.ty != payload)
            {
                return false;
            }
            let Ok(expected) = event_type(value, &contextual, &payload, 0) else {
                return false;
            };
            if let Some(expected) = expected {
                if value.ty != expected {
                    return false;
                }
                if let IrExpr::Member { field, .. } = &value.expr {
                    let Some(original) = declaration
                        .descendants()
                        .find(|node| node.kind == SyntaxKind::Member && node.span == value.span)
                    else {
                        return false;
                    };
                    if kids(original)
                        .iter()
                        .rfind(|node| node.kind == SyntaxKind::Name)
                        .and_then(|node| name_text(db, node))
                        .as_deref()
                        != Some(field.as_str())
                    {
                        return false;
                    }
                }
            }
            let mut add = |child| expressions.push((child, depth + 1));
            match &value.expr {
                IrExpr::Member { base, .. }
                | IrExpr::Unary { operand: base, .. }
                | IrExpr::Lambda { body: base, .. }
                | IrExpr::DeliveryRead { record: base, .. } => add(base),
                IrExpr::Binary { left, right, .. } => {
                    add(left);
                    add(right);
                }
                IrExpr::Call { args, .. }
                | IrExpr::BoundCall { args, .. }
                | IrExpr::Array(args)
                | IrExpr::Format { args, .. } => {
                    for value in args {
                        add(value);
                    }
                }
                IrExpr::Object(fields) => {
                    for (_, value) in fields {
                        add(value);
                    }
                }
                IrExpr::Query(query) => {
                    if let IrQueryDomain::Value { base, .. } = &query.domain {
                        add(base);
                    }
                    if let Some(order) = &query.value_order {
                        add(&order.key);
                    }
                    for value in [
                        &query.parent,
                        &query.where_pred,
                        &query.limit,
                        &query.archived,
                        &query.select,
                    ]
                    .into_iter()
                    .flatten()
                    {
                        add(value);
                    }
                }
                IrExpr::HasRole {
                    person: Some(value),
                    ..
                }
                | IrExpr::JudgmentSpecification {
                    options: Some(value),
                    ..
                } => add(value),
                IrExpr::Message(message)
                | IrExpr::MessageCall {
                    descriptor: message,
                    ..
                } => {
                    for param in &message.params {
                        add(&param.value);
                    }
                    if let IrExpr::MessageCall { args, .. } = &value.expr {
                        for value in args {
                            add(value);
                        }
                    }
                }
                _ => {}
            }
        }
        true
    }

    pub(crate) fn has_standard_value_inventory_fact(&self) -> bool {
        self.standard_value_inventory.is_some()
    }

    pub(crate) fn requires_standard_value_inventory(&self, ir: &IrProgram) -> bool {
        StandardValueCensus::collect(ir).is_some_and(|census| !census.roots.is_empty())
    }

    pub(crate) fn standard_value_inventory_roots<'a>(
        &'a self,
        ir: &IrProgram,
        db: &SourceDb,
    ) -> Option<&'a [(String, Span)]> {
        let fact = self.standard_value_inventory.as_ref()?;
        if self.sources.is_empty()
            || ir.catalog_version != fact.catalog_version
            || !self.sources.iter().all(|(id, path, hash)| {
                db.get(*id).is_some_and(|source| {
                    source.path == *path
                        && source.sha256 == *hash
                        && sha256_hex(source.text.as_bytes()) == *hash
                })
            })
            || StandardValueCensus::collect(ir)? != fact.census
        {
            return None;
        }
        Some(&fact.census.roots)
    }

    pub(crate) fn has_empty_value_inventory_fact(&self) -> bool {
        self.empty_value_inventory.is_some()
    }

    /// Validate the private complete-empty schema census against the same
    /// original sources and current IR. Raw, stale or edited cohorts have no
    /// certificate; this is independent of any committed event admission.
    pub(crate) fn has_complete_empty_value_inventory(&self, ir: &IrProgram, db: &SourceDb) -> bool {
        let Some(fact) = &self.empty_value_inventory else {
            return false;
        };
        if self.sources.is_empty()
            || fact.roots.len() != self.sources.len()
            || !self
                .sources
                .iter()
                .zip(&fact.roots)
                .all(|((id, path, hash), root)| {
                    root.file == *id
                        && db.get(*id).is_some_and(|source| {
                            source.path == *path
                                && source.sha256 == *hash
                                && sha256_hex(source.text.as_bytes()) == *hash
                                && root.start == 0
                                && root.end as usize == source.text.len()
                        })
                })
            || ir.catalog_version != fact.catalog_version
            || ir.value_constraints != fact.constraints
        {
            return false;
        }
        CheckedEmptyValueInventory::census(ir)
            .is_some_and(|(modules, items)| modules == fact.modules && items == fact.items)
    }
}

#[derive(Debug, Clone, Default)]
pub struct CheckedStandardCompletionSources {
    pub(crate) sources: Vec<(crate::source::SourceId, String, String)>,
    pub(crate) handlers: Vec<CheckedStandardCompletionHandler>,
    public_admission: Option<PublicStandardCompletionAdmission>,
}

#[derive(Debug, Clone)]
struct PublicStandardCompletionAdmission {
    catalog_version: String,
    declarations: StandardValueCensus,
    handlers: Vec<PublicCompletionBody>,
}

#[derive(Debug, Clone, PartialEq)]
struct PublicCompletionBody {
    id: SymbolId,
    module: ModuleId,
    canonical: String,
    span: Span,
    source: IrEventSource,
    cohort: Option<IrCohort>,
    payload: ResolvedType,
    read: bool,
    expose_excluded: bool,
    guards: Vec<PublicCompletionStatement>,
    effects: Vec<PublicCompletionStatement>,
}

#[derive(Debug, Clone, PartialEq)]
struct PublicCompletionExpression {
    ty: ResolvedType,
    span: Span,
    value: PublicCompletionValue,
}

#[derive(Debug, Clone, PartialEq)]
enum PublicCompletionValue {
    Int(i128),
    Text(String),
    Bool(bool),
    Null,
    Array(Vec<PublicCompletionExpression>),
    Name(String),
    Member(Box<PublicCompletionExpression>, String),
    Binary(
        IrBinOp,
        Box<PublicCompletionExpression>,
        Box<PublicCompletionExpression>,
    ),
    Unary(IrUnOp, Box<PublicCompletionExpression>),
    Object(Vec<(String, PublicCompletionExpression)>),
}

#[derive(Debug, Clone, PartialEq)]
enum PublicCompletionStatement {
    Let(String, PublicCompletionExpression, Span),
    Require(PublicCompletionExpression, Span),
    Create(String, PublicCompletionExpression, Option<String>, Span),
    Set(PublicCompletionExpression, PublicCompletionExpression, Span),
    If(
        PublicCompletionExpression,
        Vec<PublicCompletionStatement>,
        Vec<PublicCompletionStatement>,
        Span,
    ),
    For {
        item: String,
        model: String,
        pred: PublicCompletionExpression,
        body: Vec<PublicCompletionStatement>,
        span: Span,
    },
    Emit(String, PublicCompletionExpression, Span),
}

struct PublicCompletionProfile<'a> {
    ir: &'a IrProgram,
    module: ModuleId,
    payload: &'a ResolvedType,
    cohort: Option<&'a IrCohort>,
    locals: HashMap<String, ResolvedType>,
    /// `for`-bound stored rows in scope (`item` and `where` alias).
    rows: HashMap<String, SymbolId>,
}

impl PublicCompletionProfile<'_> {
    fn scalar(&self, ty: &ResolvedType) -> bool {
        match ty {
            ResolvedType::Scalar(Scalar::Int | Scalar::Text | Scalar::Bool) => true,
            ResolvedType::Nullable(inner) => self.scalar(inner),
            ResolvedType::Enum { owner: Some(owner), cases } => !cases.is_empty() && self.ir.items.get(owner.0 as usize).is_some_and(|field| field.id == *owner && field.module == self.module && matches!(&field.kind, IrItemKind::Field { ty: IrType::Known(own), .. } if own == ty)),
            _ => false,
        }
    }

    fn model(&self, canonical: &str) -> Option<&IrItem> {
        let model = self
            .ir
            .items
            .iter()
            .find(|item| item.canonical == canonical && item.module == self.module)?;
        let IrItemKind::Model { fields, .. } = &model.kind else {
            return None;
        };
        if !fields.iter().all(|id| self.ir.items.get(id.0 as usize).is_some_and(|field| matches!(&field.kind,
            IrItemKind::Field { owner, ty: IrType::Known(ty), .. } if field.id == *id && *owner == model.id && self.scalar(ty)))) { return None; }
        Some(model)
    }

    /// Stored model bound to a `for` row name, if any. A `let` local
    /// shadows the row (mirroring checker scoping); the `for` arm itself
    /// refuses shadowed bindings, so this is a fail-closed backstop.
    fn row_binding(&self, name: &str) -> Option<SymbolId> {
        if name == "event" || self.locals.contains_key(name) {
            return None;
        }
        self.rows.get(name).copied()
    }

    /// One-level stored-row leaf (`row.delivery`): the base must be a
    /// bound row and the field a checked leaf of its model with the exact
    /// decoded type. Model-reference chains (`attempt.parent.state`)
    /// stay out of the bounded profile.
    fn row_leaf(&self, base: &TypedExpr, field: &str) -> Option<&ResolvedType> {
        let IrExpr::Name(name) = &base.expr else {
            return None;
        };
        let model = self.row_binding(name)?;
        let item = self.ir.items.get(model.0 as usize)?;
        if item.id != model || item.module != self.module {
            return None;
        }
        let IrItemKind::Model { fields, .. } = &item.kind else {
            return None;
        };
        let decl = fields
            .iter()
            .filter_map(|id| self.ir.items.get(id.0 as usize))
            .find(|decl| decl.name == *field)?;
        let IrItemKind::Field {
            owner,
            ty: IrType::Known(ty),
            server,
            modifiers,
            ..
        } = &decl.kind
        else {
            return None;
        };
        if *owner != model
            || server.is_some()
            || modifiers.machine
            || !matches!(
                ty,
                ResolvedType::Scalar(_) | ResolvedType::Nullable(_) | ResolvedType::Enum { .. }
            )
        {
            return None;
        }
        Some(ty)
    }

    /// Whether a witnessed expression reads the completion envelope.
    /// Delivery-correlation queries must mention `event`; uncorrelated
    /// scans stay out of the bounded profile.
    fn mentions_event(expr: &PublicCompletionExpression) -> bool {
        match &expr.value {
            PublicCompletionValue::Name(name) => name == "event",
            PublicCompletionValue::Member(base, _) => Self::mentions_event(base),
            PublicCompletionValue::Binary(_, left, right) => {
                Self::mentions_event(left) || Self::mentions_event(right)
            }
            PublicCompletionValue::Unary(_, operand) => Self::mentions_event(operand),
            PublicCompletionValue::Object(entries) => {
                entries.iter().any(|(_, value)| Self::mentions_event(value))
            }
            PublicCompletionValue::Array(items) => items.iter().any(Self::mentions_event),
            PublicCompletionValue::Int(_)
            | PublicCompletionValue::Text(_)
            | PublicCompletionValue::Bool(_)
            | PublicCompletionValue::Null => false,
        }
    }

    /// Per-field exact-type row changes for a `for`-bound stored row.
    /// Unlike [`Self::input`], this does not require every model field to
    /// be scalar: only the changed leaves are witnessed, each against its
    /// declared field type, and only scalar/enum leaves are admittable.
    fn row_input(
        &mut self,
        model: SymbolId,
        input: &TypedExpr,
    ) -> Option<PublicCompletionExpression> {
        let IrExpr::Object(entries) = &input.expr else {
            return None;
        };
        let item = self.ir.items.get(model.0 as usize)?;
        if item.id != model || item.module != self.module {
            return None;
        }
        let IrItemKind::Model { fields, .. } = &item.kind else {
            return None;
        };
        let fields = fields.clone();
        let mut names = HashSet::new();
        let mut values = Vec::new();
        for (name, value) in entries {
            if !names.insert(name) || matches!(name.as_str(), "id" | "version" | "parent" | "team")
            {
                return None;
            }
            let field = fields
                .iter()
                .filter_map(|id| self.ir.items.get(id.0 as usize))
                .find(|field| field.name == *name)?;
            let IrItemKind::Field {
                owner,
                ty: IrType::Known(ty),
                server,
                modifiers,
                ..
            } = &field.kind
            else {
                return None;
            };
            if *owner != model
                || server.is_some()
                || modifiers.machine
                || (&value.ty != ty
                    && !(value.ty == ResolvedType::Null && ty.nullable_inner().is_some()))
                || (value.ty != ResolvedType::Null
                    && !matches!(
                        &value.ty,
                        ResolvedType::Scalar(_)
                            | ResolvedType::Nullable(_)
                            | ResolvedType::Enum { .. }
                    ))
            {
                return None;
            }
            values.push((name.clone(), self.expression(value)?));
        }
        Some(PublicCompletionExpression {
            ty: input.ty.clone(),
            span: input.span,
            value: PublicCompletionValue::Object(values),
        })
    }

    fn envelope_type<'a>(&'a self, expr: &TypedExpr) -> Option<&'a ResolvedType> {
        match &expr.expr {
            IrExpr::Name(name) if name == "event" && !self.locals.contains_key(name) => {
                Some(self.payload)
            }
            IrExpr::Member { base, field } => {
                let ty = self.envelope_type(base)?;
                let ty = ty.nullable_inner().unwrap_or(ty);
                // Standard nominal results (PaymentState, EmailAccepted,
                // ...) expose the same checked leaf table as envelope
                // objects; anything else stays unadmitted.
                let fields = match ty {
                    ResolvedType::Object(fields) => fields,
                    ResolvedType::StdNominal { fields, .. } => fields,
                    _ => return None,
                };
                fields
                    .iter()
                    .find(|(name, _)| name == field)
                    .map(|(_, ty)| ty)
            }
            _ => None,
        }
    }

    fn expression(&mut self, expr: &TypedExpr) -> Option<PublicCompletionExpression> {
        self.expression_node(expr, false)
    }

    fn expression_node(
        &mut self,
        expr: &TypedExpr,
        envelope_shell: bool,
    ) -> Option<PublicCompletionExpression> {
        if let Some(expected) = self.envelope_type(expr) {
            // Anchored member lowering retains untyped intermediate objects;
            // only a checked leaf's exact owning envelope path can use them.
            let shell = envelope_shell
                && expr.ty == ResolvedType::Unknown
                && matches!(
                    expected.nullable_inner().unwrap_or(expected),
                    ResolvedType::Object(_)
                );
            if !shell && &expr.ty != expected && expected.nullable_inner() != Some(&expr.ty) {
                return None;
            }
        }
        let value = match &expr.expr {
            IrExpr::Int(value) if expr.ty == ResolvedType::Scalar(Scalar::Int) => {
                PublicCompletionValue::Int(*value)
            }
            IrExpr::Text(value)
                if expr.ty == ResolvedType::Scalar(Scalar::Text)
                    || matches!(&expr.ty, ResolvedType::Enum { cases, .. } if cases.contains(value)) =>
            {
                PublicCompletionValue::Text(value.clone())
            }
            IrExpr::Bool(value) if expr.ty == ResolvedType::Scalar(Scalar::Bool) => {
                PublicCompletionValue::Bool(*value)
            }
            IrExpr::Null if expr.ty == ResolvedType::Null => PublicCompletionValue::Null,
            IrExpr::Array(items) => PublicCompletionValue::Array(
                items
                    .iter()
                    .map(|item| self.expression(item))
                    .collect::<Option<Vec<_>>>()?,
            ),
            IrExpr::Object(entries) => PublicCompletionValue::Object(
                entries
                    .iter()
                    .map(|(name, value)| Some((name.clone(), self.expression(value)?)))
                    .collect::<Option<Vec<_>>>()?,
            ),
            IrExpr::Name(name)
                if self.locals.get(name) == Some(&expr.ty)
                    || self.envelope_type(expr).is_some()
                    || self.row_binding(name).is_some_and(|model| {
                        expr.ty
                            == (ResolvedType::Record {
                                symbol: model,
                                stored: true,
                            })
                    })
                    || matches!(&expr.ty, ResolvedType::Enum { cases, .. } if cases.contains(name)) =>
            {
                PublicCompletionValue::Name(name.clone())
            }
            IrExpr::Member { base, field } if self.envelope_type(expr).is_some() => {
                PublicCompletionValue::Member(
                    Box::new(self.expression_node(base, true)?),
                    field.clone(),
                )
            }
            IrExpr::Member { base, field } if self.row_leaf(base, field) == Some(&expr.ty) => {
                PublicCompletionValue::Member(Box::new(self.expression(base)?), field.clone())
            }
            IrExpr::Binary { op, left, right } => {
                let null_test = (left.ty == ResolvedType::Null
                    && right.ty.nullable_inner().is_some())
                    || (right.ty == ResolvedType::Null && left.ty.nullable_inner().is_some());
                let same_comparable = left.ty == right.ty
                    && matches!(
                        &left.ty,
                        ResolvedType::Scalar(Scalar::Int | Scalar::Text | Scalar::Bool)
                            | ResolvedType::Enum { .. }
                    );
                let allowed = match op {
                    IrBinOp::Eq | IrBinOp::Ne => {
                        expr.ty == ResolvedType::Scalar(Scalar::Bool)
                            && (null_test || same_comparable)
                    }
                    IrBinOp::And | IrBinOp::Or => {
                        expr.ty == ResolvedType::Scalar(Scalar::Bool)
                            && left.ty == expr.ty
                            && right.ty == expr.ty
                    }
                    IrBinOp::Lt | IrBinOp::Le | IrBinOp::Gt | IrBinOp::Ge => {
                        expr.ty == ResolvedType::Scalar(Scalar::Bool)
                            && left.ty == ResolvedType::Scalar(Scalar::Int)
                            && right.ty == left.ty
                    }
                    IrBinOp::Add | IrBinOp::Sub | IrBinOp::Mul => {
                        expr.ty == ResolvedType::Scalar(Scalar::Int)
                            && left.ty == expr.ty
                            && right.ty == expr.ty
                    }
                    IrBinOp::In => {
                        expr.ty == ResolvedType::Scalar(Scalar::Bool)
                            && matches!(&right.expr, IrExpr::Array(_))
                    }
                    _ => false,
                };
                if !allowed {
                    return None;
                }
                PublicCompletionValue::Binary(
                    *op,
                    Box::new(self.expression(left)?),
                    Box::new(self.expression(right)?),
                )
            }
            IrExpr::Unary { op, operand }
                if operand.ty == expr.ty
                    && ((matches!(op, IrUnOp::Not)
                        && expr.ty == ResolvedType::Scalar(Scalar::Bool))
                        || (matches!(op, IrUnOp::Neg)
                            && expr.ty == ResolvedType::Scalar(Scalar::Int))) =>
            {
                PublicCompletionValue::Unary(*op, Box::new(self.expression(operand)?))
            }
            _ => return None,
        };
        Some(PublicCompletionExpression {
            ty: expr.ty.clone(),
            span: expr.span,
            value,
        })
    }

    fn input(&mut self, model: SymbolId, input: &TypedExpr) -> Option<PublicCompletionExpression> {
        let IrExpr::Object(entries) = &input.expr else {
            return None;
        };
        let IrItemKind::Model { fields, .. } = &self.ir.items.get(model.0 as usize)?.kind else {
            return None;
        };
        let fields = fields.clone();
        let mut names = HashSet::new();
        let mut values = Vec::new();
        for (name, value) in entries {
            if !names.insert(name) || matches!(name.as_str(), "id" | "version" | "parent" | "team")
            {
                return None;
            }
            let field = fields
                .iter()
                .filter_map(|id| self.ir.items.get(id.0 as usize))
                .find(|field| field.name == *name)?;
            let IrItemKind::Field {
                owner,
                ty: IrType::Known(ty),
                server,
                modifiers,
                ..
            } = &field.kind
            else {
                return None;
            };
            if *owner != model
                || server.is_some()
                || modifiers.machine
                || (&value.ty != ty
                    && !(value.ty == ResolvedType::Null && ty.nullable_inner().is_some()))
            {
                return None;
            }
            values.push((name.clone(), self.expression(value)?));
        }
        Some(PublicCompletionExpression {
            ty: input.ty.clone(),
            span: input.span,
            value: PublicCompletionValue::Object(values),
        })
    }

    fn statements(&mut self, statements: &[IrStmt]) -> Option<Vec<PublicCompletionStatement>> {
        let mut output = Vec::new();
        for statement in statements {
            let value = match statement {
                IrStmt::Let { name, value, span } => {
                    let value_snapshot = self.expression(value)?;
                    self.locals.insert(name.clone(), value.ty.clone());
                    PublicCompletionStatement::Let(name.clone(), value_snapshot, *span)
                }
                IrStmt::Require { cond, span } if cond.ty == ResolvedType::Scalar(Scalar::Bool) => {
                    PublicCompletionStatement::Require(self.expression(cond)?, *span)
                }
                IrStmt::Create {
                    model,
                    input,
                    when: None,
                    binding,
                    span,
                } => {
                    let model_id = self.model(model)?.id;
                    PublicCompletionStatement::Create(
                        model.clone(),
                        self.input(model_id, input)?,
                        binding.clone(),
                        *span,
                    )
                }
                IrStmt::Set {
                    record,
                    changes,
                    when: None,
                    span,
                } => {
                    let IrExpr::Name(name) = &record.expr else {
                        return None;
                    };
                    if self.locals.contains_key(name) {
                        return None;
                    }
                    let record_snapshot = PublicCompletionExpression {
                        ty: record.ty.clone(),
                        span: record.span,
                        value: PublicCompletionValue::Name(name.clone()),
                    };
                    if let Some(cohort) = self.cohort {
                        if cohort.bind.as_ref() != Some(name)
                            || record.ty
                                != (ResolvedType::Record {
                                    symbol: cohort.model,
                                    stored: true,
                                })
                        {
                            return None;
                        }
                        let model = self.ir.items.get(cohort.model.0 as usize)?;
                        self.model(&model.canonical)?;
                        PublicCompletionStatement::Set(
                            record_snapshot,
                            self.input(cohort.model, changes)?,
                            *span,
                        )
                    } else {
                        // Non-cohort write to a `for`-bound stored row.
                        let model = self.row_binding(name)?;
                        if record.ty
                            != (ResolvedType::Record {
                                symbol: model,
                                stored: true,
                            })
                        {
                            return None;
                        }
                        PublicCompletionStatement::Set(
                            record_snapshot,
                            self.row_input(model, changes)?,
                            *span,
                        )
                    }
                }
                IrStmt::If {
                    cond,
                    then_branch,
                    else_branch,
                    span,
                } if cond.ty == ResolvedType::Scalar(Scalar::Bool) => {
                    let cond_snapshot = self.expression(cond)?;
                    // Branch bindings stay branch-local.
                    let saved_locals = self.locals.clone();
                    let saved_rows = self.rows.clone();
                    let then_body = self.statements(then_branch)?;
                    self.locals = saved_locals.clone();
                    self.rows = saved_rows.clone();
                    let else_body = self.statements(else_branch)?;
                    self.locals = saved_locals;
                    self.rows = saved_rows;
                    PublicCompletionStatement::If(cond_snapshot, then_body, else_body, *span)
                }
                IrStmt::For {
                    item,
                    domain,
                    limit,
                    body,
                    span,
                } => {
                    // Bounded delivery-correlation query: one stored-model
                    // scan with a checked event-correlated predicate and a
                    // fail-closed `limit=1`.
                    if item == "event"
                        || self.locals.contains_key(item)
                        || self.rows.contains_key(item)
                    {
                        return None;
                    }
                    let Some(limit) = limit else {
                        return None;
                    };
                    if !matches!(&limit.expr, IrExpr::Int(1)) {
                        return None;
                    }
                    let IrExpr::Query(query) = &domain.expr else {
                        return None;
                    };
                    if query.source.is_none()
                        || query.collection_call.is_some()
                        || query.contract_collection_call.is_some()
                        || query.parent.is_some()
                        || query.select.is_some()
                        || !query.order.is_empty()
                        || query.value_order.is_some()
                        || query.archived.is_some()
                        || query.limit.is_some()
                        || query.where_async
                    {
                        return None;
                    }
                    let IrQueryDomain::Model(canonical) = &query.domain else {
                        return None;
                    };
                    // Resolve the stored model without the all-scalar
                    // gate: only the correlated leaves are witnessed.
                    let model = self
                        .ir
                        .items
                        .iter()
                        .find(|item| item.canonical == *canonical && item.module == self.module)
                        .filter(|item| matches!(item.kind, IrItemKind::Model { .. }))?
                        .id;
                    if query.where_param == "event"
                        || self.locals.contains_key(&query.where_param)
                        || self.rows.contains_key(&query.where_param)
                    {
                        return None;
                    }
                    let Some(pred) = &query.where_pred else {
                        return None;
                    };
                    self.rows.insert(item.clone(), model);
                    self.rows.insert(query.where_param.clone(), model);
                    let pred_snapshot = self.expression(pred)?;
                    if !Self::mentions_event(&pred_snapshot) {
                        return None;
                    }
                    let body_snapshots = self.statements(body)?;
                    self.rows.remove(item);
                    self.rows.remove(&query.where_param);
                    PublicCompletionStatement::For {
                        item: item.clone(),
                        model: canonical.clone(),
                        pred: pred_snapshot,
                        body: body_snapshots,
                        span: *span,
                    }
                }
                IrStmt::Emit {
                    event,
                    payload,
                    span,
                } => {
                    // Typed completion-feed emissions only; the receipt
                    // itself stays Lane C territory (reused, never rebuilt).
                    let owner = self
                        .ir
                        .modules
                        .iter()
                        .find(|module| module.id == self.module)?;
                    if *event != format!("{}.ProviderReceipt", owner.name)
                        && *event != format!("{}.InvoiceSettlement", owner.name)
                    {
                        return None;
                    }
                    let payload_snapshot = self.expression(payload)?;
                    if !matches!(payload_snapshot.value, PublicCompletionValue::Object(_)) {
                        return None;
                    }
                    PublicCompletionStatement::Emit(event.clone(), payload_snapshot, *span)
                }
                _ => return None,
            };
            output.push(value);
        }
        Some(output)
    }
}

impl PublicCompletionBody {
    fn collect(ir: &IrProgram) -> Option<Vec<Self>> {
        let facts = &ir.standard_completion_sources.handlers;
        if facts.is_empty() {
            return None;
        }
        let current = ir
            .items
            .iter()
            .filter(|item| {
                matches!(
                    item.kind,
                    IrItemKind::Scenario {
                        event_source: Some(IrEventSource::StandardCompleted { .. }),
                        ..
                    }
                )
            })
            .count();
        if current != facts.len() {
            return None;
        }
        let mut ids = HashSet::new();
        let mut bodies = Vec::new();
        for fact in facts {
            if !ids.insert(fact.id) {
                return None;
            }
            let item = ir.items.get(fact.id.0 as usize)?;
            let IrItemKind::Scenario {
                params,
                trusted: true,
                event_source:
                    Some(
                        source @ IrEventSource::StandardCompleted {
                            source: event,
                            canonical_operation,
                            result_type,
                            binding,
                            from,
                        },
                    ),
                hook: None,
                result: None,
                by,
                cohort,
                guards,
                effects,
                read,
                expose_excluded,
                ..
            } = &item.kind
            else {
                return None;
            };
            let completion = &fact.completion;
            // Bounded public profile covers the standard terminal carriers:
            // Email send plus the four PaymentsV1 terminal operations. The
            // pinned (capability, op, result) triple must name the
            // operation's declared contract result; the checker already
            // enforces table correspondence, so a renamed result cannot
            // ride the admission.
            let terminal = matches!(
                (
                    completion.capability.as_str(),
                    completion.op.as_str(),
                    completion.result_type.as_str(),
                ),
                ("std.EmailV1", "send", "EmailAccepted")
                    | ("std.PaymentsV1", "collect", "PaymentState")
                    | ("std.PaymentsV1", "refund", "PaymentState")
                    | ("std.PaymentsV1", "cancel", "PaymentState")
                    | ("std.PaymentsV1", "reconcile", "PaymentState")
            );
            if item.id != fact.id
                || item.module != fact.module
                || item.canonical != fact.canonical
                || item.span != fact.span
                || !params.is_empty()
                || !by.is_empty()
                || *read
                || !terminal
                || event != &completion.source
                || canonical_operation != &format!("{}.{}", completion.capability, completion.op)
                || result_type != &completion.result_type
                || completion.binding.as_ref() != Some(binding)
                || completion.from.as_ref() != Some(from)
                || cohort != &fact.cohort
            {
                return None;
            }
            if let Some(cohort) = cohort
                && (cohort.kind != IrCohortKind::Model
                    || cohort.parent.is_some()
                    || !ir.items.get(cohort.model.0 as usize).is_some_and(|model| {
                        model.id == cohort.model
                            && model.module == item.module
                            && matches!(model.kind, IrItemKind::Model { .. })
                    }))
            {
                return None;
            }
            let mut profile = PublicCompletionProfile {
                ir,
                module: item.module,
                payload: &completion.payload,
                cohort: cohort.as_ref(),
                locals: HashMap::new(),
                rows: HashMap::new(),
            };
            let guards = profile.statements(guards)?;
            let effects = profile.statements(effects)?;
            bodies.push(Self {
                id: item.id,
                module: item.module,
                canonical: item.canonical.clone(),
                span: item.span,
                source: source.clone(),
                cohort: cohort.clone(),
                payload: completion.payload.clone(),
                read: *read,
                expose_excluded: *expose_excluded,
                guards,
                effects,
            });
        }
        Some(bodies)
    }
}

impl CheckedStandardCompletionSources {
    pub(crate) fn has_public_standard_completion_fact(&self) -> bool {
        self.public_admission.is_some()
    }

    pub(crate) fn valid_public_standard_completions(&self, ir: &IrProgram, db: &SourceDb) -> bool {
        let Some(fact) = &self.public_admission else {
            return false;
        };
        !self.sources.is_empty()
            && ir.catalog_version == fact.catalog_version
            && self.sources.iter().all(|(id, path, hash)| {
                db.get(*id).is_some_and(|source| {
                    source.path == *path
                        && source.sha256 == *hash
                        && sha256_hex(source.text.as_bytes()) == *hash
                })
            })
            && StandardValueCensus::collect(ir).is_some_and(|census| census == fact.declarations)
            && PublicCompletionBody::collect(ir).is_some_and(|handlers| handlers == fact.handlers)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CheckedStandardCompletionHandler {
    pub id: SymbolId,
    pub module: ModuleId,
    pub canonical: String,
    pub node: NodeKey,
    pub on: NodeKey,
    pub completion: crate::analysis::types::CheckedStdDeliveryCompletion,
    pub cohort: Option<IrCohort>,
    pub cohort_model: Option<String>,
    pub span: Span,
}

#[derive(Debug, Clone)]
pub(crate) struct CheckedCommittedHandler {
    pub id: SymbolId,
    pub module: ModuleId,
    pub canonical: String,
    pub source: IrEventSource,
    pub model: String,
    pub cohort: Option<IrCohort>,
    pub cohort_model: Option<String>,
    pub span: Span,
}

impl From<&crate::analysis::effects::CohortData> for IrCohort {
    fn from(cohort: &crate::analysis::effects::CohortData) -> Self {
        Self {
            kind: match cohort.kind {
                crate::analysis::effects::CohortKind::Model => IrCohortKind::Model,
                crate::analysis::effects::CohortKind::AnchoredCollection => {
                    IrCohortKind::AnchoredCollection
                }
            },
            model: cohort.model,
            bind: cohort.bind.clone(),
            parent: (!cohort.parent_path.is_empty()).then(|| cohort.parent_path.join(".")),
            span: Span::new(cohort.node.file, cohort.node.start, cohort.node.end),
        }
    }
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

/// A checked production call operand and its owning declarations. Symbol IDs
/// index `IrProgram.items`, retaining owner-derived input/result schemas.
#[derive(Debug, Clone)]
pub enum IrEffectCallTarget {
    Operation {
        /// A static declaration reference has no executable value operand.
        source: Span,
        operation: SymbolId,
    },
    Invocation {
        operand: TypedExpr,
        targets: Vec<SymbolId>,
    },
    Action {
        operand: TypedExpr,
        targets: Vec<SymbolId>,
    },
}

impl IrEffectCallTarget {
    pub fn operand(&self) -> Option<&TypedExpr> {
        match self {
            Self::Operation { .. } => None,
            Self::Invocation { operand, .. } | Self::Action { operand, .. } => Some(operand),
        }
    }

    pub fn operations(&self) -> &[SymbolId] {
        match self {
            Self::Operation { operation, .. } => std::slice::from_ref(operation),
            Self::Invocation { targets, .. } | Self::Action { targets, .. } => targets,
        }
    }
}

/// Checked effect/handler statements in source order.
// Statement payloads stay inline in the once-built IR; changing their public
// representation solely for variant size would add allocations, as with IrStep.
#[derive(Debug, Clone)]
#[allow(clippy::large_enum_variant)]
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
    /// `call target {...}`. Preserve the actual checked operand and its
    /// declaring operations; execution awaits the owner transaction consumer.
    Call {
        target: IrEffectCallTarget,
        inputs: TypedExpr,
        binding: Option<String>,
        /// Checked statement result, including opaque heterogeneous results.
        /// `None` means void; target declarations own their schemas.
        result: Option<ResolvedType>,
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

/// One allowed localized-format schema, derived solely from a checked leaf.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IrFormatSchema {
    pub source_lang: String,
    /// (parameter name, canonical checked type, Values presentation tag).
    pub param_types: Vec<(String, String, String)>,
}

/// Display message with its checked owning source locale and typed parameters.
#[derive(Debug, Clone)]
pub struct IrMessage {
    /// Source-language text.
    pub source: String,
    /// Source language retained from the checked owning declaration.
    pub source_lang: String,
    /// `(locale, translation)` pairs; `None` renders `null`.
    pub variants: Vec<(String, Option<String>)>,
    /// Typed parameters in source order.
    pub params: Vec<IrMessageParam>,
}

/// Static Judgment captions retain the ordinary localized message descriptor.
#[derive(Debug, Clone)]
pub struct IrJudgmentQuestion {
    pub name: String,
    pub kind: IrJudgmentKind,
    pub runtime: bool,
    pub instructions: IrMessage,
    pub yes: Option<IrMessage>,
    pub no: Option<IrMessage>,
    pub options: Vec<IrJudgmentOption>,
    pub levels: Vec<IrJudgmentOption>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IrJudgmentKind {
    Noul,
    Choice,
    Score,
}

#[derive(Debug, Clone)]
pub struct IrJudgmentOption {
    pub id: String,
    pub description: IrMessage,
}

/// Checked derived schemas remain distinct from authored emission items.
#[derive(Debug, Clone)]
pub enum IrJudgmentGenerated {
    Contract {
        fields: Vec<SymbolId>,
    },
    Field {
        owner: SymbolId,
        ty: IrType,
        required_array: bool,
    },
    CapabilityOp {
        params: Vec<SymbolId>,
        result: IrType,
    },
    Specification {
        params: Vec<SymbolId>,
        result: IrType,
    },
    Param {
        owner: SymbolId,
        index: usize,
        ty: IrType,
    },
    /// Failing shell after an explicit missing-carrier diagnostic.
    Unsupported,
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
    /// Checked source-only view expansion; no public factory is emitted.
    pub view: Option<IrViewUse>,
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

/// A checked app-local presentation use. Its row argument is evaluated once;
/// descendants retain declaration ownership while identities include this use.
#[derive(Debug, Clone)]
pub struct IrViewUse {
    pub argument: TypedExpr,
    pub identity: String,
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
    /// Exact checked Model and authored route token; absent for static/scalar routes.
    pub record_route: Option<IrRecordRoute>,
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
    /// Source-owned enum selectors saved through this page's POST route.
    pub preference_fields: Vec<IrPreferenceField>,
    /// Render body: UI factory nodes in source order.
    pub render: Vec<IrUi>,
    /// Page function name.
    pub fn_name: String,
    /// Descriptor binding name.
    pub descriptor_name: String,
    /// Declaration span.
    pub span: Span,
}

#[derive(Debug, Clone)]
pub struct IrRecordRoute {
    pub model: String,
    pub token: String,
}

#[derive(Debug, Clone)]
pub struct IrPreferenceField {
    pub name: String,
    pub options: Vec<String>,
    pub default_value: Option<String>,
    pub nullable: bool,
    pub caption: Option<IrMessage>,
    pub option_labels: Vec<(String, IrMessage)>,
    /// A reference preference leaf behind a filter default (DESIGN 977):
    /// no case options, no literal default; the saved identity stays
    /// opaque end to end and is validated as an opaque string downstream.
    pub reference: bool,
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
    /// Source-checked channels, aligned with selectors; absent only on legacy IR.
    pub selector_channels: Option<Vec<crate::analysis::examples::SelectorChannel>>,
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
    fn mailbox_received_source(&self, id: SymbolId) -> Option<IrEventSource> {
        let mut originals = self
            .program
            .mailbox_handlers()
            .iter()
            .filter(|handler| handler.id == id);
        let original = originals.next()?;
        if originals.next().is_some() {
            return None;
        }
        let symbol = self.program.symbols.get(id.0 as usize)?;
        let SymbolKind::Scenario {
            params,
            trusted: true,
            ..
        } = &symbol.kind
        else {
            return None;
        };
        let data = self.program.effects.scenarios.get(&id)?;
        let on = data.on_node?;
        let fact = self.program.types.std_capability_event_handlers.get(&on)?;
        let module = self.program.modules.get(symbol.module.0 as usize)?;
        let owner = self.node(&data.node)?;
        let source = self.db.get(module.file)?;
        let header = self.node(&on)?;
        let path = crate::analysis::path_segments(header, &source.text);
        let [alias, event] = path.as_slice() else {
            return None;
        };
        let ResolvedType::Object(fields) = &fact.payload else {
            return None;
        };
        let [(value, email)] = fields.as_slice() else {
            return None;
        };
        if symbol.id != original.id
            || symbol.module != original.module
            || symbol.name != original.name
            || symbol.span != original.span
            || symbol.canonical != original.canonical
            || data.node != original.node
            || on != original.on
            || module.id != original.module
            || module.name != original.module_name
            || module.file != original.file
            || module.span != original.module_span
            || fact.capability != original.event.capability
            || fact.event != original.event.event
            || fact.source != original.event.source
            || fact.payload != original.event.payload
            || symbol.id != id
            || symbol.module != data.module
            || data.scenario != id
            || symbol.canonical != format!("{}.{}", module.name, symbol.name)
            || !params.is_empty()
            || !data.params.is_empty()
            || data.by.is_some()
            || data.read
            || data.scope_authority
            || data.cohort.is_some()
            || owner.kind != SyntaxKind::Scenario
            || header.kind != SyntaxKind::Path
            || on.file != module.file
            || data.node.file != module.file
            || !owner.children.iter().any(|node| {
                node.kind == SyntaxKind::Name
                    && node.span == symbol.span
                    && node
                        .token()
                        .is_some_and(|token| token.text(&source.text) == symbol.name)
            })
            || crate::analysis::attribute_value(owner, "on", &source.text).map(NodeKey::of)
                != Some(on)
            || *event != "received"
            || fact.capability != "std.MailboxV1"
            || fact.event != "received"
            || fact.source != format!("{}.{}.received", module.name, alias)
            || value != "value"
            || crate::analysis::types::checked_standard_nominal_name(email) != Some("IncomingEmail")
            || !matches!(&data.on, Some(crate::analysis::effects::HandlerSource::StdCapabilityEvent {capability,event,source})
                if capability == &fact.capability && event == &fact.event && source == &fact.source)
        {
            return None;
        }
        let mut routes = module.imports.iter().flat_map(|import| {
            import
                .members
                .iter()
                .filter(move |member| member.alias == *alias)
                .map(move |member| (import, member))
        });
        let (import, member) = routes.next()?;
        let from = import.from.as_ref()?;
        let import_node = self.node(&NodeKey {
            file: import.span.file,
            start: import.span.start,
            end: import.span.end,
            kind: SyntaxKind::Import as u8,
        })?;
        let from_node = crate::analysis::attribute_value(import_node, "from", &source.text)?;
        let member_node = self.node(&NodeKey {
            file: member.span.file,
            start: member.span.start,
            end: member.span.end,
            kind: SyntaxKind::ImportMember as u8,
        })?;
        let names: Vec<_> = kids(member_node)
            .iter()
            .filter_map(|node| crate::analysis::name_text(node, &source.text))
            .collect();
        let original_alias = match names.as_slice() {
            ["MailboxV1"] => "MailboxV1",
            ["MailboxV1", "as", alias] => *alias,
            _ => return None,
        };
        if routes.next().is_some()
            || import.provider != "std"
            || member.name != "MailboxV1"
            || original_alias != *alias
            || from.is_empty()
            || source
                .text
                .get(import.provider_span.start as usize..import.provider_span.end as usize)
                != Some("std")
            || from_node.kind != SyntaxKind::Path
            || crate::analysis::path_segments(from_node, &source.text)
                .first()
                .copied()
                != Some("deployment")
            || source
                .text
                .get(from_node.span.start as usize..from_node.span.end as usize)?
                .trim()
                != from
            || std_capability(&member.name)?.name != fact.capability
        {
            return None;
        }
        Some(IrEventSource::MailboxReceived {
            source: fact.source.clone(),
            binding: format!("{}.{}", module.name, alias),
            from: from.clone(),
        })
    }

    fn standard_completion_source(&self, id: SymbolId) -> Option<IrEventSource> {
        let count = self.program.standard_completion_handlers.len();
        if count != self.program.types.std_delivery_completion_handlers.len()
            || count
                != self
                    .program
                    .effects
                    .scenarios
                    .values()
                    .filter(|data| {
                        matches!(
                            data.on,
                            Some(
                                crate::analysis::effects::HandlerSource::StdDeliveryCompleted { .. }
                            )
                        )
                    })
                    .count()
        {
            return None;
        }
        let fact = self
            .program
            .standard_completion_handlers
            .iter()
            .find(|fact| fact.id == id)?;
        let symbol = self.program.symbols.get(id.0 as usize)?;
        let module = self.program.modules.get(fact.module.0 as usize)?;
        let data = self.program.effects.scenarios.get(&id)?;
        if symbol.id != id
            || symbol.module != fact.module
            || symbol.canonical != fact.canonical
            || symbol.span != fact.span
            || !matches!(symbol.kind, SymbolKind::Scenario { trusted: true, .. })
            || data.scenario != id
            || data.module != fact.module
            || data.node != fact.node
            || data.on_node.as_ref() != Some(&fact.on)
            || data.cohort.as_ref().map(IrCohort::from) != fact.cohort.as_ref().map(IrCohort::from)
            || data
                .cohort
                .as_ref()
                .and_then(|cohort| self.program.symbols.get(cohort.model.0 as usize))
                .filter(|symbol| matches!(symbol.kind, SymbolKind::Model { .. }))
                .map(|symbol| symbol.canonical.as_str())
                != fact.cohort_model.as_deref()
        {
            return None;
        }
        let expected = &fact.completion;
        let current = self
            .program
            .types
            .std_delivery_completion_handlers
            .get(&fact.on)?;
        if current.capability != expected.capability
            || current.op != expected.op
            || current.source != expected.source
            || current.canonical_operation != expected.canonical_operation
            || current.result_type != expected.result_type
            || current.module != expected.module
            || current.alias != expected.alias
            || current.import_span != expected.import_span
            || current.binding != expected.binding
            || current.from != expected.from
            || current.payload != expected.payload
        {
            return None;
        }
        if !matches!(&data.on, Some(crate::analysis::effects::HandlerSource::StdDeliveryCompleted { capability, op, source })
            if capability == &expected.capability && op == &expected.op && source == &expected.source)
        {
            return None;
        }
        let header = self.node(&fact.on)?;
        let owner = self.node(&data.node)?;
        if owner.kind != SyntaxKind::Scenario
            || NodeKey::of(owner) != fact.node
            || crate::analysis::attribute_value(owner, "on", &self.db.get(fact.on.file)?.text)
                .map(NodeKey::of)
                .as_ref()
                != Some(&fact.on)
        {
            return None;
        }
        let path = crate::analysis::path_segments(header, &self.db.get(fact.on.file)?.text);
        if header.kind != SyntaxKind::Path
            || path != [expected.alias.as_str(), expected.op.as_str(), "completed"]
        {
            return None;
        }
        let mut routes = module.imports.iter().flat_map(|import| {
            import
                .members
                .iter()
                .filter(move |member| member.alias == expected.alias)
                .map(move |member| (import, member))
        });
        let (import, member) = routes.next()?;
        if routes.next().is_some()
            || import.provider != "std"
            || import.span != expected.import_span
            || import.from != expected.from
            || expected.module != fact.module
            || expected.source
                != format!(
                    "{}.{}.{}.completed",
                    module.name, expected.alias, expected.op
                )
        {
            return None;
        }
        let operation = std_capability(&member.name)?
            .operations
            .iter()
            .find(|op| op.name == expected.op)?;
        let capability = std_capability(&member.name)?;
        if capability.name != expected.capability
            || expected.canonical_operation != format!("{}.{}", capability.name, operation.name)
            || operation.result != expected.result_type
        {
            return None;
        }
        let binding = expected.binding.as_ref()?;
        let from = expected.from.as_ref()?;
        if binding != &format!("{}.{}", module.name, member.alias) {
            return None;
        }
        Some(IrEventSource::StandardCompleted {
            source: expected.source.clone(),
            canonical_operation: expected.canonical_operation.clone(),
            result_type: expected.result_type.clone(),
            binding: binding.clone(),
            from: from.clone(),
        })
    }

    fn check_standard_completion_census(&mut self) {
        let expected = self.program.standard_completion_handlers.len();
        let actual = self
            .program
            .effects
            .scenarios
            .values()
            .filter(|data| {
                matches!(
                    data.on,
                    Some(crate::analysis::effects::HandlerSource::StdDeliveryCompleted { .. })
                )
            })
            .count();
        let valid = expected == actual
            && expected == self.program.types.std_delivery_completion_handlers.len()
            && self
                .program
                .standard_completion_handlers
                .iter()
                .all(|fact| self.standard_completion_source(fact.id).is_some());
        if !valid {
            let span = self
                .program
                .standard_completion_handlers
                .first()
                .map(|fact| fact.span)
                .or_else(|| self.program.modules.first().map(|module| module.span));
            if let Some(span) = span {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "standard completion handler triggers disagree with checked source census or bound import".to_string(),
                    span,
                ));
            }
        }
    }

    /// The original executable SEND census is independent of the effect list
    /// being lowered. Reuse the checked target/import join, never re-resolve.
    fn standard_value_sends_match(&self, census: &StandardValueCensus) -> bool {
        fn scenarios<'a>(node: &'a SyntaxNode, span: Span, found: &mut Vec<&'a SyntaxNode>) {
            if node.kind == SyntaxKind::Scenario
                && node
                    .children
                    .iter()
                    .any(|child| child.kind == SyntaxKind::Name && child.span == span)
            {
                found.push(node);
                return;
            }
            for child in &node.children {
                scenarios(child, span, found);
            }
        }
        fn sends<'a>(node: &'a SyntaxNode, found: &mut Vec<&'a SyntaxNode>) {
            if node.kind == SyntaxKind::Send {
                found.push(node);
                return;
            }
            for child in &node.children {
                sends(child, found);
            }
        }
        let mut original = Vec::new();
        for symbol in &self.program.symbols {
            if !matches!(symbol.kind, SymbolKind::Scenario { .. }) {
                continue;
            }
            let Some((_, tree)) = self.trees.iter().find(|(id, _)| *id == symbol.span.file) else {
                return false;
            };
            let mut owning = Vec::new();
            scenarios(tree, symbol.span, &mut owning);
            if owning.len() != 1 {
                return false;
            }
            let mut authored = Vec::new();
            for block in &owning[0].children {
                if block.kind == SyntaxKind::DoBlock {
                    sends(block, &mut authored);
                }
            }
            for send in authored {
                let Some(target) = kids(send)
                    .into_iter()
                    .find(|child| is_expression(child.kind))
                else {
                    return false;
                };
                let mut head = target;
                while head.kind == SyntaxKind::Member {
                    let Some(base) = kids(head)
                        .into_iter()
                        .find(|child| is_expression(child.kind))
                    else {
                        return false;
                    };
                    head = base;
                }
                if !matches!(self.program.types.target_bindings.get(&NodeKey::of(head)),
                    Some(crate::analysis::resolve::Binding::External { provider, .. }) if provider == "std")
                {
                    // Local/provider-unknown sends retain their existing decoder;
                    // they cannot select an owning standard schema here.
                    continue;
                }
                let selected = self
                    .program
                    .types
                    .node_types
                    .get(&NodeKey::of(target))
                    .and_then(|ty| match ty {
                        ResolvedType::Operation(id) => Some(self.canonical(*id)),
                        _ => None,
                    });
                let Ok((operation, binding)) =
                    self.send_target_provenance(&Scope::module(symbol.module), target, selected)
                else {
                    return false;
                };
                if operation.starts_with("std.") {
                    original.push(StandardValueSelection {
                        item: Some(symbol.id),
                        module: symbol.module,
                        position: format!("{}:send", symbol.canonical),
                        identity: operation,
                        binding,
                        span: send.span,
                    });
                }
            }
        }
        let lowered: Vec<_> = census
            .selections
            .iter()
            .filter(|selection| selection.position.ends_with(":send"))
            .cloned()
            .collect();
        original == lowered
    }

    fn public_completion_bodies_match(&self, bodies: &[PublicCompletionBody]) -> bool {
        for body in bodies {
            let Some(fact) = self
                .program
                .standard_completion_handlers
                .iter()
                .find(|fact| fact.id == body.id)
            else {
                return false;
            };
            if self.standard_completion_source(body.id).is_none() {
                return false;
            }
            let Some(node) = self.node(&fact.node) else {
                return false;
            };
            let authored: Vec<_> = kids(node)
                .into_iter()
                .filter(|node| node.kind == SyntaxKind::DoBlock)
                .flat_map(kids)
                .filter(|node| {
                    node.kind != SyntaxKind::Description
                        && !(node.children.is_empty()
                            && ((node.kind == SyntaxKind::Name && self.text(node.span) == "do")
                                || (node.kind == SyntaxKind::Punct && self.text(node.span) == ";")))
                })
                .map(|node| (node.kind, node.span))
                .collect();
            let lowered: Vec<_> = body
                .guards
                .iter()
                .chain(&body.effects)
                .map(|statement| match statement {
                    PublicCompletionStatement::Let(_, _, span) => (SyntaxKind::Let, *span),
                    PublicCompletionStatement::Require(_, span) => (SyntaxKind::Require, *span),
                    PublicCompletionStatement::Create(_, _, _, span) => (SyntaxKind::Create, *span),
                    PublicCompletionStatement::Set(_, _, span) => (SyntaxKind::Set, *span),
                    PublicCompletionStatement::If(_, _, _, span) => (SyntaxKind::If, *span),
                    PublicCompletionStatement::For { span, .. } => (SyntaxKind::For, *span),
                    PublicCompletionStatement::Emit(_, _, span) => (SyntaxKind::Emit, *span),
                })
                .collect();
            if authored != lowered {
                return false;
            }
        }
        true
    }

    /// Metadata may remain complete when an unrelated executable has no lowering.
    /// Recheck its whole existing census against the original checked source;
    /// never turn a partial executable into an inventory authority.
    fn standard_value_census_matches_source(&self, census: &StandardValueCensus) -> bool {
        if self.program.validate_cohort(self.db, self.catalog).is_err() {
            return false;
        }
        let (original, diagnostics) = crate::analysis::check_program_with_given(
            self.db,
            self.program.checked_files(),
            self.catalog,
            self.program.original_given(),
        );
        if diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
        {
            return false;
        }
        let mut fresh = Cx::new(&original, self.db, self.catalog);
        fresh.native_hook_context = self.native_hook_context;
        fresh.native_standard_completion = self.native_standard_completion;
        fresh.check_standard_completion_census();
        let mut projection = empty_program(&original.catalog_version);
        projection.modules = fresh.build_modules();
        fresh.build_rule_maps(
            &mut projection.read_rules,
            &mut projection.callback_read_rules,
            &mut projection.invariants,
            &mut projection.locks,
            &mut projection.retention,
            &mut projection.crud_when,
            &mut projection.preferences_valid,
        );
        projection.items = fresh.build_items();
        projection.value_constraints = original.types.value_constraints.clone();
        StandardValueCensus::collect(&projection).as_ref() == Some(census)
            && fresh.standard_value_sends_match(census)
    }

    /// Build the program: modules, rule maps, items, suites.
    fn build_program(&mut self) -> (IrProgram, Vec<Diagnostic>) {
        self.check_standard_completion_census();
        let modules = self.build_modules();
        // Rule maps first: preferences items read their validator names.
        let mut read_rules = Vec::new();
        let mut callback_read_rules = Vec::new();
        let mut invariants = Vec::new();
        let mut locks = Vec::new();
        let mut retention = Vec::new();
        let mut crud_when = Vec::new();
        let mut preferences_valid = Vec::new();
        self.build_rule_maps(
            &mut read_rules,
            &mut callback_read_rules,
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
        let committed_sources = CheckedCommittedSources {
            empty_value_inventory: None,
            native_model_result_indices: std::collections::HashSet::new(),
            mailbox_event_handlers: self.program.mailbox_handlers().to_vec(),
            standard_value_inventory: None,
            sources: self
                .program
                .checked_files()
                .iter()
                .filter_map(|id| {
                    self.db
                        .get(*id)
                        .map(|source| (*id, source.path.clone(), source.sha256.clone()))
                })
                .collect(),
            handlers: self
                .program
                .committed_handlers
                .iter()
                .map(|fact| {
                    let change = match fact.event.as_str() {
                        "created" => IrCommittedChange::Create,
                        "updated" => IrCommittedChange::Update,
                        "deleted" => IrCommittedChange::Delete,
                        _ => unreachable!("checked committed source"),
                    };
                    CheckedCommittedHandler {
                        id: fact.id,
                        module: fact.module,
                        canonical: fact.canonical.clone(),
                        source: IrEventSource::Committed {
                            model: fact.model,
                            change,
                        },
                        model: fact.model_canonical.clone(),
                        cohort: fact.cohort.as_ref().map(IrCohort::from),
                        cohort_model: fact.cohort_model.clone(),
                        span: fact.span,
                    }
                })
                .collect(),
        };
        let standard_completion_sources = CheckedStandardCompletionSources {
            public_admission: None,
            sources: committed_sources.sources.clone(),
            handlers: self
                .program
                .standard_completion_handlers
                .iter()
                .map(|fact| CheckedStandardCompletionHandler {
                    id: fact.id,
                    module: fact.module,
                    canonical: fact.canonical.clone(),
                    node: fact.node,
                    on: fact.on,
                    completion: fact.completion.clone(),
                    cohort: fact.cohort.as_ref().map(IrCohort::from),
                    cohort_model: fact.cohort_model.clone(),
                    span: fact.span,
                })
                .collect(),
        };
        let mut program = IrProgram {
            modules,
            items,
            value_constraints: self.program.types.value_constraints.clone(),
            scenario_disclosures: self.program.scenario_disclosures().clone(),
            committed_sources,
            standard_completion_sources,
            catalog_version: self.program.catalog_version.clone(),
            referenced_builtins,
            read_rules,
            callback_read_rules,
            callback_grants: CheckedCallbackGrants::default(),
            invariants,
            locks,
            retention,
            crud_when,
            preferences_valid,
            suites,
            migrations,
        };
        program.callback_grants = self.seal_callback_grants(&program);
        // Establish absence from the owning original CST, never from a raw or
        // partial IR. Imported/catalog and declared structural closures remain
        // owned by the existing nonempty collector.
        if self
            .catalog
            .is_some_and(|catalog| self.program.catalog_version == catalog.version())
            && let Some(census) = StandardValueCensus::collect(&program)
            && self.standard_value_sends_match(&census)
            && !census.roots.is_empty()
            && (self.diags.is_empty() || self.standard_value_census_matches_source(&census))
        {
            program.committed_sources.standard_value_inventory =
                Some(CheckedStandardValueInventory {
                    catalog_version: program.catalog_version.clone(),
                    census,
                });
        }
        if self.native_standard_completion
            && self.diags.is_empty()
            && self
                .catalog
                .is_some_and(|catalog| self.program.catalog_version == catalog.version())
            && let Some(declarations) = StandardValueCensus::collect(&program)
            && let Some(handlers) = PublicCompletionBody::collect(&program)
            && self.public_completion_bodies_match(&handlers)
        {
            program.standard_completion_sources.public_admission =
                Some(PublicStandardCompletionAdmission {
                    catalog_version: program.catalog_version.clone(),
                    declarations,
                    handlers,
                });
        }
        fn empty_schema_source<'n>(node: &'n SyntaxNode, events: &mut Vec<&'n SyntaxNode>) -> bool {
            if node.kind == SyntaxKind::Event {
                events.push(node);
            }
            !matches!(
                node.kind,
                SyntaxKind::Import
                    | SyntaxKind::Contract
                    | SyntaxKind::Judgment
                    | SyntaxKind::Capability
                    | SyntaxKind::Preferences
                    | SyntaxKind::Error
                    | SyntaxKind::BadToken
            ) && node
                .children
                .iter()
                .all(|child| empty_schema_source(child, events))
        }
        let mut source_events = Vec::new();
        let empty_source = !self.trees.is_empty()
            && self
                .trees
                .iter()
                .all(|(_, tree)| empty_schema_source(tree, &mut source_events));
        let events_match = self.empty_inventory_events_match_source(&program, &source_events);
        if self.diags.is_empty() && empty_source && !events_match {
            self.diags.push(Diagnostic::error(
                "E6008",
                "complete empty value inventory requires the original checked event fields"
                    .to_string(),
                source_events
                    .first()
                    .map_or(self.trees[0].1.span, |node| node.span),
            ));
        } else if self.diags.is_empty()
            && empty_source
            && events_match
            && let Some((modules, items)) = CheckedEmptyValueInventory::census(&program)
        {
            program.committed_sources.empty_value_inventory = Some(CheckedEmptyValueInventory {
                catalog_version: program.catalog_version.clone(),
                roots: self
                    .trees
                    .iter()
                    .map(|(_, tree)| NodeKey::of(tree))
                    .collect(),
                modules,
                items,
                constraints: program.value_constraints.clone(),
            });
        }
        program.committed_sources.native_model_result_indices = program
            .items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                super::scenario_receipts::has_original_created_model_result(&program, item.id)
                    .then_some(index)
            })
            .collect();
        (program, std::mem::take(&mut self.diags))
    }

    /// Match every original event and ordered field before allowing that
    /// declaration in the existing complete-empty contract census.
    fn empty_inventory_events_match_source(&self, ir: &IrProgram, nodes: &[&SyntaxNode]) -> bool {
        if ir
            .items
            .iter()
            .filter(|item| matches!(item.kind, IrItemKind::Event { .. }))
            .count()
            != nodes.len()
        {
            return false;
        }
        let mut seen = HashSet::new();
        for node in nodes {
            let matches: Vec<_> = self
                .program
                .effects
                .records
                .values()
                .filter(|record| record.node == NodeKey::of(node))
                .collect();
            let [record] = matches.as_slice() else {
                return false;
            };
            if !self
                .program
                .effects
                .event_fields_match_checked(record, &self.program.types)
            {
                return false;
            }
            let Some(item) = ir.items.get(record.record.0 as usize) else {
                return false;
            };
            let IrItemKind::Event { fields } = &item.kind else {
                return false;
            };
            let Some(module) = ir.modules.get(item.module.0 as usize) else {
                return false;
            };
            let name = kids(node).into_iter().find_map(|part| {
                name_text(self.db, part)
                    .filter(|name| !matches!(name.as_str(), "export" | "event"))
                    .map(|name| (name, part.span))
            });
            if item.id != record.record
                || item.module != record.module
                || module.id != item.module
                || module.file != node.span.file
                || !seen.insert(item.id)
                || name.as_ref() != Some(&(item.name.clone(), item.span))
                || item.canonical != format!("{}.{}", module.name, item.name)
                || fields
                    != &record
                        .fields
                        .iter()
                        .map(|field| field.field)
                        .collect::<Vec<_>>()
            {
                return false;
            }
            let source_fields: Vec<_> = node
                .children
                .iter()
                .filter(|node| node.kind == SyntaxKind::Field)
                .collect();
            if source_fields.len() != fields.len() {
                return false;
            }
            for ((source, data), id) in source_fields.iter().zip(&record.fields).zip(fields) {
                let Some(field) = ir.items.get(id.0 as usize) else {
                    return false;
                };
                let Some(symbol) = self.program.symbols.get(id.0 as usize) else {
                    return false;
                };
                let (
                    IrItemKind::Field {
                        owner,
                        ty: IrType::Known(ty),
                        ..
                    },
                    SymbolKind::Field {
                        owner: checked_owner,
                        type_node,
                    },
                ) = (&field.kind, &symbol.kind)
                else {
                    return false;
                };
                let name = kids(source)
                    .into_iter()
                    .find_map(|part| name_text(self.db, part).map(|name| (name, part.span)));
                if field.id != *id
                    || symbol.id != *id
                    || *owner != item.id
                    || *checked_owner != item.id
                    || field.module != item.module
                    || symbol.module != item.module
                    || field.canonical != format!("{}.{}", item.canonical, field.name)
                    || name.as_ref() != Some(&(field.name.clone(), field.span))
                    || data.node != NodeKey::of(source)
                    || data.field != *id
                    || data.type_node != *type_node
                    || type_node.file != source.span.file
                    || type_node.start < source.span.start
                    || type_node.end > source.span.end
                    || self.node(type_node).is_none()
                    || self.program.types.symbol_types.get(id) != Some(ty)
                {
                    return false;
                }
            }
        }
        true
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
                runtime_bindings: self.program.types.runtime_bindings.get(&m.id).into_iter().flatten().map(|declaration| {
                    use crate::analysis::types::CheckedRuntimeBinding as Checked;
                    use super::runtime_bindings::{RuntimeBinding, RuntimeBindingDeclaration as Decl, RuntimeBindingField};
                    let (name, declaration) = match declaration {
                        Checked::DurableObject { name, key } => (name.clone(), Decl::DurableObject { key: self.canonical(*key) }),
                        Checked::Queue { name, payload } => (name.clone(), Decl::Queue { r#type: self.type_id(payload), resolved_type: payload.clone(), handlers: self.program.symbols.iter().filter(|symbol| symbol.module == m.id && self.program.effects.scenarios.get(&symbol.id).is_some_and(|scenario| matches!(&scenario.on, Some(crate::analysis::effects::HandlerSource::Queue { name: queue }) if queue == name))).map(|symbol| symbol.canonical.clone()).collect() }),
                        Checked::Cache { ttl_milliseconds } => ("KV".to_string(), Decl::Cache { ttl_milliseconds: ttl_milliseconds.to_string() }),
                        Checked::Analytics { name, fields } => (name.clone(), Decl::Analytics { schema: fields.iter().map(|(name, ty)| RuntimeBindingField { name: name.clone(), r#type: self.type_id(ty) }).collect() }),
                    };
                    RuntimeBinding { owner: m.name.clone(), binding: format!("{}.{}", m.name, name), name, declaration }
                }).collect(),
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
    fn decode_judgment_generated(
        &mut self,
        symbol: &crate::analysis::resolve::Symbol,
    ) -> IrJudgmentGenerated {
        match &symbol.kind {
            SymbolKind::Contract { fields } => IrJudgmentGenerated::Contract {
                fields: fields.clone(),
            },
            SymbolKind::Field { owner, .. } => IrJudgmentGenerated::Field {
                owner: *owner,
                ty: lookup_symbol_type(
                    self.program,
                    symbol,
                    "generated field type",
                    &mut self.diags,
                ),
                required_array: self
                    .program
                    .types
                    .judgment_required_arrays
                    .contains(&symbol.id),
            },
            SymbolKind::CapabilityOp { params, .. } => {
                let result = match self.program.types.symbol_results.get(&symbol.id) {
                    Some(Some(ty)) => IrType::Known(ty.clone()),
                    _ => {
                        self.gap(
                            format!(
                                "judgment operation {}: checked generated result type is missing",
                                symbol.canonical
                            ),
                            symbol.span,
                        );
                        IrType::Unknown
                    }
                };
                IrJudgmentGenerated::CapabilityOp {
                    params: params.clone(),
                    result,
                }
            }
            SymbolKind::DeriveFn { params, .. } => IrJudgmentGenerated::Specification {
                params: params.clone(),
                result: self
                    .program
                    .types
                    .symbol_results
                    .get(&symbol.id)
                    .and_then(|result| result.as_ref())
                    .map_or(IrType::Unknown, |ty| IrType::Known(ty.clone())),
            },
            SymbolKind::Param { owner, index, .. } => IrJudgmentGenerated::Param {
                owner: *owner,
                index: *index,
                ty: lookup_symbol_type(
                    self.program,
                    symbol,
                    "generated parameter type",
                    &mut self.diags,
                ),
            },
            _ => {
                self.gap(
                    format!(
                        "judgment generated symbol {}: checked kind has no derived schema carrier",
                        symbol.canonical
                    ),
                    symbol.span,
                );
                IrJudgmentGenerated::Unsupported
            }
        }
    }

    /// Decode one symbol's item kind plus its PR5 payload.
    #[allow(clippy::too_many_lines)]
    fn build_item_kind(&mut self, symbol: &crate::analysis::resolve::Symbol) -> IrItemKind {
        if let Some(judgment) = self.program.types.judgments.get(&symbol.id).cloned() {
            let Some(source_language) = self
                .program
                .effects
                .modules
                .get(&symbol.module)
                .map(|module| module.source_lang.clone())
            else {
                self.gap(
                    format!(
                        "judgment {}: checked owning module source language is missing",
                        symbol.canonical
                    ),
                    symbol.span,
                );
                return IrItemKind::JudgmentGenerated(self.decode_judgment_generated(symbol));
            };
            let mut questions = Vec::with_capacity(judgment.questions.len());
            for question in judgment.questions {
                let Some(instructions) =
                    self.decode_message_value(symbol.module, &question.instructions)
                else {
                    self.gap(
                        format!(
                            "judgment {}: checked instructions have no static message descriptor",
                            symbol.canonical
                        ),
                        symbol.span,
                    );
                    continue;
                };
                let yes = question
                    .yes
                    .as_ref()
                    .and_then(|key| self.decode_message_value(symbol.module, key));
                let no = question
                    .no
                    .as_ref()
                    .and_then(|key| self.decode_message_value(symbol.module, key));
                if yes.is_some() != question.yes.is_some() || no.is_some() != question.no.is_some()
                {
                    self.gap(
                        format!(
                            "judgment {}: checked NOUL criterion has no static message descriptor",
                            symbol.canonical
                        ),
                        symbol.span,
                    );
                }
                let mut decode_options = |options: Vec<
                    crate::analysis::resolve::CheckedJudgmentOption,
                >| {
                    options.into_iter().filter_map(|option| {
                        match self.decode_message_value(symbol.module, &option.description) {
                            Some(description) => Some(IrJudgmentOption { id: option.id, description }),
                            None => {
                                self.gap(format!("judgment {}: checked option has no static message descriptor", symbol.canonical), symbol.span);
                                None
                            }
                        }
                    }).collect()
                };
                let options = decode_options(question.options);
                let levels = decode_options(question.levels);
                questions.push(IrJudgmentQuestion {
                    name: question.name,
                    runtime: question.runtime,
                    kind: match question.kind {
                        CheckedJudgmentKind::Noul => IrJudgmentKind::Noul,
                        CheckedJudgmentKind::Choice => IrJudgmentKind::Choice,
                        CheckedJudgmentKind::Score => IrJudgmentKind::Score,
                    },
                    instructions,
                    yes,
                    no,
                    options,
                    levels,
                });
            }
            return IrItemKind::Judgment {
                source_language,
                version: judgment.version,
                questions,
                result_fields: match &symbol.kind {
                    SymbolKind::Contract { fields } => fields.clone(),
                    _ => {
                        self.gap(
                            format!(
                                "judgment {}: checked result owner is not a contract",
                                symbol.canonical
                            ),
                            symbol.span,
                        );
                        Vec::new()
                    }
                },
            };
        }
        if self
            .program
            .types
            .judgment_generated_symbols
            .contains(&symbol.id)
        {
            return IrItemKind::JudgmentGenerated(self.decode_judgment_generated(symbol));
        }
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
                    scope_authority,
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
                    root_authority: self
                        .program
                        .effects
                        .scenarios
                        .get(&symbol.id)
                        .and_then(|scenario| scenario.root_authority.clone()),
                    params: params.clone(),
                    trusted: *trusted,
                    event_source,
                    hook,
                    cohort,
                    result,
                    read,
                    scope_authority,
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
                let (default, default_copy_source, label, description) =
                    self.decode_param(symbol, *owner);
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
                let array_bounds = self.decode_parameter_array_bounds(symbol);
                IrItemKind::Param {
                    array_bounds,
                    owner: *owner,
                    index: *index,
                    ty: lookup_symbol_type(self.program, symbol, "declared type", &mut self.diags),
                    default,
                    default_node: self
                        .param_data(*owner, symbol.id)
                        .and_then(|param| param.default),
                    default_copy_source,
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
/// fixture they are bound to. `row_rewrite` tracks lexical row aliases
/// inside one anchored expression. `example_values` selects the
/// example-cell name fallback (unresolvable bare names are enum-case
/// text, never dangling identifiers).
#[derive(Debug, Clone)]
struct Scope {
    module: ModuleId,
    bindings: HashMap<String, SymbolId>,
    row_rewrite: HashMap<String, String>,
    /// Distinct lexical queried records, including shadowed ancestors. Aliases
    /// of the same row occupy one entry; forms may infer only a unique model.
    enclosing_records: Vec<(SymbolId, String)>,
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
    /// Aliases introduced by an original checked diagnostic copied-value list.
    callback_values: HashSet<String>,
    /// Whether UI decoding sits inside a field owner (`form`/`edit`):
    /// field-placement controls need one. Collections reset it (their
    /// scope ends field placement unless nested under another owner).
    in_field_owner: bool,
    /// Exact operation and selected input names of the enclosing prepared form.
    field_operation: Option<SymbolId>,
    form_fields: Option<Vec<String>>,
    /// Exact authored argument names; unknown argument shape grants no placement.
    form_bound_fields: Option<HashSet<String>>,
    /// Whether decoding sits inside a pre-commit hook body (T31 Rule A).
    /// Contextual values lower only in the private native candidate pass,
    /// which is returned after the complete owner-policy profile qualifies.
    in_hook: bool,
}

impl Scope {
    fn module(module: ModuleId) -> Self {
        Self {
            module,
            bindings: HashMap::new(),
            row_rewrite: HashMap::new(),
            enclosing_records: Vec::new(),
            example_values: false,
            result_ty: None,
            sequence_lets: HashSet::new(),
            name_types: HashMap::new(),
            callback_values: HashSet::new(),
            in_field_owner: false,
            field_operation: None,
            form_fields: None,
            form_bound_fields: None,
            in_hook: false,
        }
    }
}

impl<'a> Cx<'a> {
    /// Retain a caption's checked source language; missing ownership blocks emission.
    fn checked_message_source_lang(&mut self, module: ModuleId, span: Span) -> String {
        if let Some(owner) = self.program.effects.modules.get(&module) {
            return owner.source_lang.clone();
        }
        self.gap(
            "message source language: checked owning module is missing".to_string(),
            span,
        );
        String::new()
    }

    /// Message descriptor for a `MessageData` row (G7).
    fn decode_message_data(&self, data: &crate::analysis::effects::MessageData) -> IrMessage {
        IrMessage {
            source: data.source.clone(),
            source_lang: data.source_lang.clone(),
            variants: data
                .variants
                .iter()
                .map(|v| (v.locale.clone(), v.value.clone()))
                .collect(),
            params: Vec::new(),
        }
    }

    /// Decode a label/message value node: `MessageValue` text plus
    /// variants, or a resolved zero-parameter message reference (inlined).
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
                source_lang: self.checked_message_source_lang(module, node.span),
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
                    source_lang: self.checked_message_source_lang(module, node.span),
                    variants,
                    params: Vec::new(),
                })
            }
            SyntaxKind::Path | SyntaxKind::NameRef => {
                let name = path_text(self.db, node);
                match self.resolve_member(module, &name) {
                    Some((id, _))
                        if matches!(
                            self.program.symbols.get(id.0 as usize).map(|s| &s.kind),
                            Some(SymbolKind::Message { params }) if params.is_empty()
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
        let label = self.decode_field_label_parts(module, key)?;
        Some(IrFieldLabel {
            text: label.text?,
            values: label.values,
        })
    }

    fn decode_field_label_parts(
        &mut self,
        module: ModuleId,
        key: &NodeKey,
    ) -> Option<DecodedFieldLabel> {
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
                Some(DecodedFieldLabel { text, values })
            }
            SyntaxKind::Literal | SyntaxKind::MessageValue | SyntaxKind::Path => self
                .decode_message_node(module, &node)
                .map(|text| DecodedFieldLabel {
                    text: Some(text),
                    values: Vec::new(),
                }),
            _ => None,
        }
    }

    /// A generated literal caption uses the receiving logical source's locale
    /// and the same message/field-label carrier as an authored caption.
    fn decode_given_field_label(
        &mut self,
        symbol: &crate::analysis::resolve::Symbol,
    ) -> Option<IrFieldLabel> {
        let source = self
            .program
            .types
            .given_fields
            .get(&symbol.id)?
            .label
            .clone()?;
        Some(IrFieldLabel {
            text: IrMessage {
                source,
                source_lang: self.checked_message_source_lang(symbol.module, symbol.span),
                variants: Vec::new(),
                params: Vec::new(),
            },
            values: Vec::new(),
        })
    }

    fn decode_declared_field_label_parts(
        &mut self,
        symbol: &crate::analysis::resolve::Symbol,
        owner: SymbolId,
    ) -> Option<DecodedFieldLabel> {
        if let Some(label) = self.decode_given_field_label(symbol) {
            return Some(DecodedFieldLabel {
                text: Some(label.text),
                values: label.values,
            });
        }
        let key =
            self.program
                .effects
                .models
                .get(&owner)
                .and_then(|model| model.fields.iter().find(|field| field.field == symbol.id))
                .or_else(|| {
                    self.program.effects.records.get(&owner).and_then(|record| {
                        record.fields.iter().find(|field| field.field == symbol.id)
                    })
                })
                .and_then(|field| field.label)?;
        self.decode_field_label_parts(symbol.module, &key)
    }

    /// Reused fields inherit the immediately referenced declaration first.
    /// Case overrides compose through the checked chain; text captions only
    /// cross a reuse edge when both fields keep the same name.
    fn decode_reused_field_label_parts(
        &mut self,
        symbol: &crate::analysis::resolve::Symbol,
    ) -> Option<DecodedFieldLabel> {
        let mut chain = Vec::new();
        let mut current = symbol.clone();
        let mut seen = HashSet::new();
        while seen.insert(current.id) {
            let SymbolKind::Field { owner, .. } = &current.kind else {
                break;
            };
            chain.push((
                current.name.clone(),
                self.decode_declared_field_label_parts(&current, *owner),
            ));
            let next = self
                .program
                .types
                .field_reuse_sources
                .get(&current.id)
                .copied();
            let Some(next) = next
                .and_then(|id| self.program.symbols.get(id.0 as usize))
                .cloned()
            else {
                break;
            };
            current = next;
        }
        let mut inherited: Option<(String, DecodedFieldLabel)> = None;
        for (name, declared) in chain.into_iter().rev() {
            let mut label = declared.unwrap_or(DecodedFieldLabel {
                text: None,
                values: Vec::new(),
            });
            if let Some((source_name, source)) = inherited {
                if label.text.is_none() && name == source_name {
                    label.text = source.text;
                }
                for (case, caption) in source.values {
                    if !label.values.iter().any(|(declared, _)| declared == &case) {
                        label.values.push((case, caption));
                    }
                }
            }
            inherited = Some((name, label));
        }
        inherited.map(|(_, label)| label)
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
        if let Some(call) = self
            .program
            .types
            .judgment_specification_calls
            .get(&NodeKey::of(node))
            .cloned()
        {
            let options =
                self.decode_anchored(scope, &call.options, "judgment specification options");
            return TypedExpr::new(
                IrExpr::JudgmentSpecification {
                    judgment: self.canonical(call.judgment),
                    options: Some(Box::new(options)),
                },
                ty,
                span,
            );
        }
        if let Some(judgment) = self
            .program
            .types
            .judgment_specifications
            .get(&NodeKey::of(node))
        {
            return TypedExpr::new(
                IrExpr::JudgmentSpecification {
                    judgment: self.canonical(*judgment),
                    options: None,
                },
                ty,
                span,
            );
        }
        // Scope-bound names (query aliases, sequence bindings, test
        // accounts) carry their type when no table anchors the node.
        // The lookup follows the alias rewrite, so a rewritten alias
        // reads its lambda parameter's type.
        if node.kind == SyntaxKind::NameRef
            && let Some(name) = kids(node).iter().find_map(|n| name_text(self.db, n))
        {
            let target = scope.row_rewrite.get(&name).unwrap_or(&name);
            let contextual_event = matches!(
                self.program
                    .types
                    .contextual_references
                    .get(&NodeKey::of(node)),
                Some(crate::analysis::resolve::ContextVar::Event)
            );
            if let Some(bound) = scope.name_types.get(target)
                && (target != "event" || contextual_event)
                && (matches!(ty, ResolvedType::Unknown)
                    || contextual_event
                        && matches!(ty, ResolvedType::Opaque("trusted event payload"))
                    || scope.callback_values.contains(target)
                        && crate::analysis::types::checked_standard_nominal_name(bound)
                            == Some("TextMessage"))
            {
                ty = bound.clone();
            }
        }
        let expr = match node.kind {
            SyntaxKind::Literal => self.decode_literal(node),
            SyntaxKind::MessageValue => self
                .decode_message_node(scope.module, node)
                .map(IrExpr::Message)
                .unwrap_or_else(|| IrExpr::Unsupported {
                    what: "inline message descriptor".to_string(),
                    why: "authored descriptor text is unavailable".to_string(),
                }),
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
                if self
                    .program
                    .types
                    .cohort_child_references
                    .contains_key(&NodeKey::of(node))
                    || self
                        .program
                        .types
                        .lexical_value_references
                        .contains(&NodeKey::of(node))
                    || kids(node)
                        .into_iter()
                        .find(|head| head.kind == SyntaxKind::Name)
                        .is_some_and(|head| {
                            self.program
                                .types
                                .lexical_value_references
                                .contains(&NodeKey::of(head))
                        })
                {
                    // Mutation targets use Path syntax, but retain the same
                    // checked lexical owner as ordinary NameRef values.
                    IrExpr::Name(name)
                } else {
                    self.decode_bare_name(scope, &name, &ty, span)
                }
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
        self.program
            .symbols
            .iter()
            .find(|symbol| {
                matches!(symbol.kind, SymbolKind::Fixture { .. }) && symbol.canonical == name
            })
            .map(|symbol| symbol.id)
            .or_else(|| self.fixture_in_scope(scope.module, name))
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
                        "parent" => {
                            if let Some(SymbolKind::Model {
                                owner: ModelOwner::ChildOf(parent),
                                ..
                            }) = self
                                .program
                                .symbols
                                .get(symbol.0 as usize)
                                .map(|symbol| &symbol.kind)
                                && self
                                    .program
                                    .effects
                                    .models
                                    .get(symbol)
                                    .is_some_and(|model| {
                                        model.owner == ModelOwner::ChildOf(*parent)
                                    })
                            {
                                return ResolvedType::Record {
                                    symbol: *parent,
                                    stored: true,
                                };
                            }
                        }
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
            ResolvedType::Object(fields) | ResolvedType::StdNominal { fields, .. } => fields
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
        if self
            .program
            .types
            .cohort_child_references
            .contains_key(&key)
        {
            return IrExpr::Name(name);
        }
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
            let fixture_name = self.canonical(*fixture);
            return member_of("s", &fixture_name, &self.fixture_type(*fixture), node.span);
        }
        // These reads refer to checked immutable descriptor lets. Keep their
        // captured value even when a module message/fixture shares the name.
        if self
            .program
            .types
            .message_descriptor_references
            .contains_key(&key)
        {
            return IrExpr::Name(name);
        }
        // Checked lexical shadows remain values. Spelling alone must never
        // turn an authored hook local into a native contextual root.
        if scope.in_hook
            && matches!(name.as_str(), "actor" | "now" | "team" | "operation")
            && self.program.types.bound_names.contains(&key)
            && !self.program.types.contextual_references.contains_key(&key)
        {
            return IrExpr::Name(name);
        }
        if is_enum_ty(ty) && self.program.types.bound_names.contains(&key) {
            return IrExpr::Name(name);
        }
        // Keep the original resolver's local value identity. Fixture lookup
        // below is for actual fixture references, including example channels;
        // it must not substitute `s.budget` for an owning `let budget`.
        if self.program.types.lexical_value_references.contains(&key) {
            return IrExpr::Name(name);
        }
        // Fixture references resolve through the example tables.
        if let Some(id) = self.fixture_in_scope(scope.module, &name) {
            let fixture_name = self.canonical(id);
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
            // Only a complete native owner-policy plan can return contextual
            // hook decoding. The refusal rebuild preserves exact source spans.
            "actor" | "now" | "team" | "operation"
                if scope.in_hook && !self.native_hook_context =>
            {
                let why = "no complete native owner-policy plan binds the hook context";
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
            return member_of("c", name, &ResolvedType::Scalar(Scalar::User), span);
        }
        if is_predicate_spelling(name) && matches!(ty, ResolvedType::Scalar(Scalar::Bool)) {
            // Checked actor predicates keep the same canonical snapshot test
            // in boolean expressions as in admission guards. Lexical shadows
            // were consumed by decode_name_ref before this fallback.
            return IrExpr::HasRole {
                role: name.to_string(),
                person: None,
            };
        }
        if let Some((id, _)) = self.resolve_member(scope.module, name) {
            let symbol = self.program.symbols.get(id.0 as usize).cloned();
            match symbol.as_ref().map(|s| &s.kind) {
                Some(SymbolKind::Model { .. }) => {
                    // A bare model domain lowers through the shared
                    // query contract with no clauses.
                    return IrExpr::Query(IrQuery {
                        source: None,
                        collection_call: None,
                        contract_collection_call: None,
                        domain: IrQueryDomain::Model(self.canonical(id)),
                        parent: None,
                        where_param: "row".to_string(),
                        where_pred: None,
                        where_async: false,
                        order: Vec::new(),
                        value_order: None,
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
        // Fixture lookup is kind-specific; actual lexical locals were handled
        // before lookup. Recipes use their test scope, including import aliases.
        let local = |module, name: &str| {
            self.program
                .symbols
                .iter()
                .find(|symbol| {
                    symbol.module == module
                        && symbol.name == name
                        && matches!(symbol.kind, SymbolKind::Fixture { .. })
                })
                .map(|symbol| symbol.id)
        };
        if let Some(id) = local(module, name) {
            return Some(id);
        }
        for import in &self.program.modules.get(module.0 as usize)?.imports {
            for member in &import.members {
                if member.alias == name
                    && let Some(provider) = self.modules_by_name.get(&import.provider)
                    && let Some(id) = local(*provider, &member.name)
                {
                    return Some(id);
                }
            }
        }
        None
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
            | SyntaxKind::MessageValue
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
                    let anchor = NodeKey::of(parts[0]);
                    self.shorthand_value(&key, anchor)
                });
            entries.push((key, value));
        }
        IrExpr::Object(entries)
    }

    /// Preserve the lexical type checked at an actual shorthand key. The
    /// owning type pass supplies this fact; field expectations are not a
    /// substitute for the value's binding type.
    fn shorthand_value(&self, name: &str, key: NodeKey) -> TypedExpr {
        let ty = self
            .program
            .types
            .node_types
            .get(&key)
            .cloned()
            .unwrap_or(ResolvedType::Unknown);
        TypedExpr::new(
            IrExpr::Name(name.to_string()),
            ty,
            Span::new(key.file, key.start, key.end),
        )
    }

    /// Decode member access, wrapping delivery-typed bases in the sole
    /// observation helper shape (`DeliveryRead`).
    fn decode_member(&mut self, scope: &Scope, node: &SyntaxNode, ty: &ResolvedType) -> TypedExpr {
        if self
            .program
            .types
            .resolved_cases
            .contains(&NodeKey::of(node))
            && is_enum_ty(ty)
        {
            let name = kids(node)
                .get(2)
                .and_then(|part| name_text(self.db, part))
                .expect("checked qualified enum case");
            return TypedExpr::new(IrExpr::Text(name), ty.clone(), node.span);
        }
        if let Some(observation) = self
            .program
            .types
            .callback_diagnostic_reads()
            .get(&NodeKey::of(node))
            .cloned()
        {
            return self.decode_callback_read(scope, node, ty, observation);
        }
        let parts = kids(node);
        if let Some(base) = parts.iter().find(|part| is_expression(part.kind)).copied() {
            let mut current = base;
            while current.kind == SyntaxKind::Member {
                if self
                    .program
                    .types
                    .callback_diagnostic_reads()
                    .contains_key(&NodeKey::of(current))
                {
                    let field = parts
                        .iter()
                        .rev()
                        .find_map(|part| name_text(self.db, part))
                        .unwrap_or_default();
                    return TypedExpr::new(
                        IrExpr::Member {
                            base: Box::new(self.decode_expr(scope, base)),
                            field,
                        },
                        ty.clone(),
                        node.span,
                    );
                }
                let nested = kids(current);
                let Some(next) = nested.iter().find(|part| is_expression(part.kind)).copied()
                else {
                    break;
                };
                current = next;
            }
        }
        if let Some((child, parent)) = self.contained_collection_head(node) {
            let parent = self.decode_expr(scope, parent);
            return TypedExpr::new(
                IrExpr::Query(IrQuery {
                    source: None,
                    collection_call: None,
                    contract_collection_call: None,
                    domain: IrQueryDomain::Model(self.canonical(child)),
                    parent: Some(Box::new(parent)),
                    where_param: "row".to_string(),
                    where_pred: None,
                    where_async: false,
                    order: Vec::new(),
                    value_order: None,
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
        let mut field_spans = Vec::new();
        let mut current = node;
        loop {
            let parts = kids(current);
            let field = parts
                .iter()
                .rev()
                .find_map(|n| name_text(self.db, n))
                .unwrap_or_default();
            fields.push(field);
            field_spans.push(current.span);
            let Some(base) = parts.iter().find(|n| is_expression(n.kind)) else {
                break;
            };
            if base.kind != SyntaxKind::Member {
                // A delivery-typed non-member base has no provenance to
                // resolve (only `record.field` crossings lower) — except a
                // bare receipt local (`send ... as delivery`): the runtime
                // receipt is already bound, so the checked `.id`/`.status`
                // members read as ordinary members below.
                let base_ty = self.node_type(base);
                if is_delivery_ty(&base_ty) && base.kind != SyntaxKind::NameRef {
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
                if (!scope.in_hook || self.native_hook_context)
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
                    if scope.in_hook {
                        // This private facts container is not the native User
                        // value whose checked read selected the projection.
                        expr.ty = ResolvedType::Unknown;
                    }
                }
                let copied_message_member = fields.len() == 1
                    && matches!(&expr.expr, IrExpr::Name(name) if scope.callback_values.contains(name))
                    && crate::analysis::types::checked_standard_nominal_name(&expr.ty)
                        == Some("TextMessage");
                for (index, (field, field_span)) in fields
                    .iter()
                    .rev()
                    .zip(field_spans.iter().rev())
                    .enumerate()
                {
                    let inferred = self.member_ty(&expr.ty, field);
                    let outermost = index + 1 == fields.len();
                    let field_ty = if copied_message_member {
                        inferred
                    } else if outermost && !matches!(ty, ResolvedType::Unknown) {
                        ty.clone()
                    } else if !matches!(inferred, ResolvedType::Unknown) {
                        inferred
                    } else if outermost {
                        ty.clone()
                    } else {
                        ResolvedType::Unknown
                    };
                    let derived = if let ResolvedType::Record {
                        symbol,
                        stored: true,
                    } = &expr.ty
                    {
                        self.fields.get(&(*symbol, field.clone())).copied().filter(|id| {
                            self.program.effects.derives.get(id).is_some_and(|data| data.model.is_some()
                                && data.expr.is_some_and(|key| crate::analysis::scenario_disclosure::expression_reads_membership(
                                    &self.program.types, &self.program.effects, key)))
                                && field_ty == ResolvedType::Scalar(Scalar::Bool)
                        })
                    } else {
                        None
                    };
                    expr = TypedExpr::new(
                        if let Some(id) = derived {
                            IrExpr::Call {
                                target: IrCallTarget::DeriveFn(self.canonical(id)),
                                args: vec![expr],
                            }
                        } else {
                            IrExpr::Member {
                                base: Box::new(expr),
                                field: field.clone(),
                            }
                        },
                        field_ty,
                        *field_span,
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

    /// Join the actual selected overload and authored predicate to its lowered
    /// query. An absent fact leaves ordinary lowering unchanged, without proof.
    fn join_collection_call(
        &self,
        node: &SyntaxNode,
        id: &str,
        overload: usize,
        selected: &SelectedCall,
        args: &mut [TypedExpr],
    ) -> bool {
        let Some(fact) = self
            .program
            .types
            .checked_collection_calls
            .get(&NodeKey::of(node))
        else {
            return true;
        };
        let has_predicate = matches!(id, "any" | "all");
        let arity = if has_predicate { 2 } else { 1 };
        if fact.node != NodeKey::of(node)
            || fact.builtin != id
            || fact.overload != overload
            || (!has_predicate && !matches!(id, "count" | "first"))
            || selected.slots.len() != arity
            || args.len() != arity
        {
            return false;
        }
        let Some(domain_slot) = selected.slots.first().copied().flatten() else {
            return false;
        };
        // Keep the owning query refusal when its source profile cannot lower.
        // No query proof or modules can be published from this unsupported node.
        if args
            .get(domain_slot)
            .is_some_and(|domain| matches!(domain.expr, IrExpr::Unsupported { .. }))
        {
            return true;
        }
        let Some(TypedExpr {
            expr: IrExpr::Query(query),
            ty,
            ..
        }) = args.get(domain_slot)
        else {
            return false;
        };
        let Some(source) = query.source.as_deref() else {
            return false;
        };
        let Some(alias) = source
            .clauses
            .iter()
            .find(|clause| matches!(clause.kind, CheckedQueryClauseKind::As { .. }))
        else {
            return false;
        };
        let CheckedQueryClauseKind::As { name } = &alias.kind else {
            return false;
        };
        if !self
            .program
            .symbols
            .get(fact.model.0 as usize)
            .is_some_and(|symbol| matches!(symbol.kind, SymbolKind::Model { .. }))
        {
            return false;
        }
        let row = ResolvedType::Record {
            symbol: fact.model,
            stored: true,
        };
        let domain_matches = match &query.domain {
            IrQueryDomain::Model(model) => *model == self.canonical(fact.model),
            IrQueryDomain::Value { base, alias } => {
                *alias == *name && query_element_ty(&base.ty) == row
            }
        };
        if source.node != fact.query
            || alias.node != fact.alias
            || *ty != source.result
            || query_element_ty(&source.result) != row
            || query_element_ty(&source.domain_type) != row
            || !domain_matches
        {
            return false;
        }
        if has_predicate {
            let Some(predicate) = fact.predicate.as_ref() else {
                return false;
            };
            let Some(slot) = selected.slots.get(1).copied().flatten() else {
                return false;
            };
            // An async/unsupported predicate keeps its own source-profile
            // refusal; it cannot publish a collection correspondence proof.
            if args
                .get(slot)
                .is_some_and(|predicate| matches!(predicate.expr, IrExpr::Unsupported { .. }))
            {
                return true;
            }
            let Some(TypedExpr {
                expr: IrExpr::Lambda { param, body },
                ty,
                ..
            }) = args.get(slot)
            else {
                return false;
            };
            let Some(mut predicate_node) = self.node(&predicate.node) else {
                return false;
            };
            for depth in 0..=64 {
                if predicate_node.kind != SyntaxKind::Group {
                    break;
                }
                if depth == 64 {
                    return false;
                }
                let Some(inner) = kids(predicate_node)
                    .into_iter()
                    .find(|child| is_expression(child.kind))
                else {
                    return false;
                };
                predicate_node = inner;
            }
            let boolean = ResolvedType::Scalar(Scalar::Bool);
            if selected.arguments.get(slot) != Some(&predicate.node)
                || self.program.types.node_types.get(&predicate.node) != Some(&boolean)
                || predicate.ty != boolean
                || *ty != boolean
                || body.ty != boolean
                || body.span != predicate_node.span
                || param != name
            {
                return false;
            }
        } else if fact.predicate.is_some() {
            return false;
        }
        let IrExpr::Query(query) = &mut args[domain_slot].expr else {
            return false;
        };
        query.collection_call = Some(Box::new(fact.clone()));
        true
    }

    /// Keep contract collection attribution separate from model-query facts.
    /// Ordinary generic calls without this finite proof lower as before.
    fn join_contract_collection_call(
        &self,
        node: &SyntaxNode,
        id: &str,
        overload: usize,
        selected: &SelectedCall,
        args: &mut [TypedExpr],
    ) -> bool {
        let Some(fact) = self
            .program
            .types
            .checked_contract_collection_calls
            .get(&NodeKey::of(node))
        else {
            return true;
        };
        if fact.node != NodeKey::of(node)
            || fact.builtin != id
            || fact.overload != overload
            || !matches!(id, "any" | "all")
            || selected.arguments != fact.arguments
            || selected.slots.as_slice() != [Some(fact.slots[0]), Some(fact.slots[1])]
            || args.len() != 2
            || fact.slots[0] == fact.slots[1]
            || !self
                .program
                .symbols
                .get(fact.contract.0 as usize)
                .is_some_and(|symbol| matches!(symbol.kind, SymbolKind::Contract { .. }))
        {
            return false;
        }
        let Some(TypedExpr {
            expr: IrExpr::Query(query),
            ty,
            ..
        }) = args.get(fact.slots[0])
        else {
            // Preserve the original refusal if source lowering already failed.
            return args
                .get(fact.slots[0])
                .is_some_and(|arg| matches!(arg.expr, IrExpr::Unsupported { .. }));
        };
        let Some(source) = query.source.as_deref() else {
            return false;
        };
        let [alias] = source.clauses.as_slice() else {
            return false;
        };
        let CheckedQueryClauseKind::As { name } = &alias.kind else {
            return false;
        };
        let IrQueryDomain::Value {
            base,
            alias: live_alias,
        } = &query.domain
        else {
            return false;
        };
        fn grouped(mut current: &SyntaxNode) -> Option<&SyntaxNode> {
            for _ in 0..64 {
                if current.kind != SyntaxKind::Group {
                    return Some(current);
                }
                let mut children = current
                    .children
                    .iter()
                    .filter(|child| is_expression(child.kind));
                current = children.next()?;
                if children.next().is_some() {
                    return None;
                }
            }
            None
        }
        let Some(domain_node) = self.node(&fact.domain).and_then(grouped) else {
            return false;
        };
        let domain_name = kids(domain_node)
            .into_iter()
            .find_map(|child| name_text(self.db, child));
        let domain_matches = match fact.call {
            Some(call) => {
                domain_node.kind == SyntaxKind::NameRef
                    && matches!(&base.expr, IrExpr::Name(actual) if Some(actual) == domain_name.as_ref())
                    && self
                        .program
                        .types
                        .effect_call_results
                        .get(&call)
                        .and_then(Option::as_ref)
                        == Some(&source.domain_type)
            }
            None => {
                let parts = kids(domain_node);
                if domain_node.kind != SyntaxKind::Member || parts.len() != 3 {
                    return false;
                }
                let Some(text) = self
                    .db
                    .get(domain_node.span.file)
                    .map(|source| source.text.as_str())
                else {
                    return false;
                };
                if text.get(parts[1].span.start as usize..parts[1].span.end as usize) != Some(".") {
                    return false;
                }
                let Some(ResolvedType::Record { symbol: owner, .. }) =
                    self.program.types.node_types.get(&NodeKey::of(parts[0]))
                else {
                    return false;
                };
                let Some(SymbolKind::Contract { fields }) = self
                    .program
                    .symbols
                    .get(owner.0 as usize)
                    .map(|symbol| &symbol.kind)
                else {
                    return false;
                };
                let Some(name) = name_text(self.db, parts[2]) else {
                    return false;
                };
                let Some(field) = fields.iter().find(|field| {
                    self.program
                        .symbols
                        .get(field.0 as usize)
                        .is_some_and(|symbol| symbol.name == name)
                }) else {
                    return false;
                };
                matches!(self.program.symbols.get(field.0 as usize).map(|symbol| &symbol.kind),
                    Some(SymbolKind::Field {owner: field_owner, ..}) if field_owner == owner)
                    && self.program.types.symbol_types.get(field) == Some(&source.domain_type)
                    && self.contract_collection_member_matches(domain_node, base)
            }
        };
        if source.node != fact.query
            || source.domain != fact.domain
            || alias.node != fact.alias
            || !alias.expressions.is_empty()
            || source.domain_type != source.result
            || *ty != source.result
            || base.ty != source.domain_type
            || live_alias != name
            || query.collection_call.is_some()
            || source.projection.is_some()
            || query.parent.is_some()
            || query.where_pred.is_some()
            || query.where_async
            || !query.order.is_empty()
            || query.value_order.is_some()
            || query.limit.is_some()
            || query.archived.is_some()
            || query.select.is_some()
            || query.select_param.is_some()
            || base.span != domain_node.span
            || !domain_matches
            || self.program.types.node_types.get(&fact.domain) != Some(&source.domain_type)
            || !matches!(query_element_ty(&source.result), ResolvedType::Record {symbol,..} if symbol == fact.contract)
            || self.program.types.checked_queries.get(&fact.query) != Some(source)
        {
            return false;
        }
        let Some(TypedExpr {
            expr: IrExpr::Lambda { param, body },
            ty,
            ..
        }) = args.get(fact.slots[1])
        else {
            return args
                .get(fact.slots[1])
                .is_some_and(|arg| matches!(arg.expr, IrExpr::Unsupported { .. }));
        };
        let Some(predicate_node) = self.node(&fact.predicate.node).and_then(grouped) else {
            return false;
        };
        let boolean = ResolvedType::Scalar(Scalar::Bool);
        if selected.arguments.get(fact.slots[1]) != Some(&fact.predicate.node)
            || fact.predicate.ty != boolean
            || *ty != boolean
            || body.ty != boolean
            || body.span != predicate_node.span
            || param != name
            || expr_uses_async(body)
            || !self.contract_collection_predicate_is_finite(body)
            || self.program.types.node_types.get(&fact.predicate.node) != Some(&boolean)
        {
            return false;
        }
        let IrExpr::Query(query) = &mut args[fact.slots[0]].expr else {
            return false;
        };
        query.contract_collection_call = Some(Box::new(fact.clone()));
        true
    }

    /// Match the actual member value against its checked source chain. Nested
    /// member spans may cover the whole chain, so use node types and structure.
    fn contract_collection_member_matches(&self, node: &SyntaxNode, value: &TypedExpr) -> bool {
        let mut pending = vec![(node, value)];
        let mut visits = 0;
        while let Some((node, value)) = pending.pop() {
            visits += 1;
            if visits > 4096
                || self.program.types.node_types.get(&NodeKey::of(node)) != Some(&value.ty)
            {
                return false;
            }
            match node.kind {
                SyntaxKind::Group => {
                    let children: Vec<_> = kids(node)
                        .into_iter()
                        .filter(|child| is_expression(child.kind))
                        .collect();
                    let [inner] = children.as_slice() else {
                        return false;
                    };
                    pending.push((*inner, value));
                }
                SyntaxKind::NameRef => {
                    let name = kids(node)
                        .into_iter()
                        .find_map(|child| name_text(self.db, child));
                    if !matches!(&value.expr, IrExpr::Name(actual) if Some(actual) == name.as_ref())
                    {
                        return false;
                    }
                }
                SyntaxKind::Member => {
                    let parts = kids(node);
                    let IrExpr::Member { base, field } = &value.expr else {
                        return false;
                    };
                    let Some(text) = self
                        .db
                        .get(node.span.file)
                        .map(|source| source.text.as_str())
                    else {
                        return false;
                    };
                    if parts.len() != 3
                        || text.get(parts[1].span.start as usize..parts[1].span.end as usize)
                            != Some(".")
                        || name_text(self.db, parts[2]).as_ref() != Some(field)
                    {
                        return false;
                    }
                    pending.push((parts[0], base));
                }
                _ => return false,
            }
        }
        true
    }

    /// Only genuine checked nested any/all calls extend the finite synchronous
    /// predicate profile. Their query and lambda retain their own source joins.
    fn contract_collection_predicate_is_finite(&self, body: &TypedExpr) -> bool {
        let boolean = ResolvedType::Scalar(Scalar::Bool);
        let mut pending = vec![body];
        let mut visits = 0;
        while let Some(value) = pending.pop() {
            visits += 1;
            if visits > 4096 {
                return false;
            }
            match &value.expr {
                IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                    let IrCallTarget::Builtin { id, awaited: false } = target else {
                        return false;
                    };
                    if !matches!(id.as_str(), "any" | "all")
                        || value.ty != boolean
                        || args.len() != 2
                    {
                        return false;
                    }
                    let Some(query) = args.iter().find_map(|arg| match &arg.expr {
                        IrExpr::Query(query) => Some(query),
                        _ => None,
                    }) else {
                        return false;
                    };
                    let Some(fact) = query.contract_collection_call.as_deref() else {
                        return false;
                    };
                    let Some(selected) = self.program.types.selected_calls.get(&fact.node) else {
                        return false;
                    };
                    let slots_match = match &value.expr {
                        IrExpr::BoundCall { slots, .. } => {
                            slots.as_slice() == [Some(fact.slots[0]), Some(fact.slots[1])]
                        }
                        IrExpr::Call { .. } => fact.slots == [0, 1],
                        _ => false,
                    };
                    let Some(domain) = args.get(fact.slots[0]) else {
                        return false;
                    };
                    let Some(predicate) = args.get(fact.slots[1]) else {
                        return false;
                    };
                    let IrExpr::Query(actual_query) = &domain.expr else {
                        return false;
                    };
                    let IrExpr::Lambda { param, body } = &predicate.expr else {
                        return false;
                    };
                    let Some(source) = actual_query.source.as_deref() else {
                        return false;
                    };
                    let [alias] = source.clauses.as_slice() else {
                        return false;
                    };
                    if !slots_match
                        || fact.builtin != *id
                        || fact.slots[0] == fact.slots[1]
                        || fact.arguments != selected.arguments
                        || selected.slots.as_slice() != [Some(fact.slots[0]), Some(fact.slots[1])]
                        || !matches!(&selected.target, SelectedCallTarget::Builtin { id: actual, overload }
                            if actual == id && *overload == fact.overload)
                        || self
                            .program
                            .types
                            .checked_contract_collection_calls
                            .get(&fact.node)
                            != Some(fact)
                        || self.program.types.node_types.get(&fact.node) != Some(&boolean)
                        || self
                            .node(&fact.node)
                            .is_none_or(|node| node.span != value.span)
                        || actual_query.contract_collection_call.as_deref() != Some(fact)
                        || self.program.types.checked_queries.get(&fact.query) != Some(source)
                        || source.node != fact.query
                        || source.domain != fact.domain
                        || alias.node != fact.alias
                        || !matches!(&alias.kind, CheckedQueryClauseKind::As { name } if name == param)
                        || predicate.ty != boolean
                        || body.ty != boolean
                        || fact.predicate.ty != boolean
                        || self.program.types.node_types.get(&fact.predicate.node) != Some(&boolean)
                    {
                        return false;
                    }
                    let IrQueryDomain::Value { base, .. } = &actual_query.domain else {
                        return false;
                    };
                    pending.push(base);
                    pending.push(body);
                }
                IrExpr::Member { base, .. } => pending.push(base),
                IrExpr::Binary { left, right, .. } => {
                    pending.push(left);
                    pending.push(right);
                }
                IrExpr::Unary { operand, .. } => pending.push(operand),
                IrExpr::Name(_)
                | IrExpr::Int(_)
                | IrExpr::Decimal(_)
                | IrExpr::Text(_)
                | IrExpr::Bool(_)
                | IrExpr::Null
                | IrExpr::Money { .. }
                | IrExpr::DurationMs(_)
                | IrExpr::Date(_)
                | IrExpr::Datetime(_) => {}
                _ => return false,
            }
        }
        true
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
        if outer_fields
            .iter()
            .any(|field| field == "callback_diagnostics")
        {
            return IrExpr::Unsupported {
                what: "generation callback diagnostics".to_string(),
                why: "protected observation lacks its exact checked source fact".to_string(),
            };
        }
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
            callback: None,
        }
    }

    /// Consume the checker-selected target and slots. CST supplies content,
    /// never a second overload choice or argument-name binding.
    fn decode_call(&mut self, scope: &Scope, node: &SyntaxNode, _ty: &ResolvedType) -> IrExpr {
        if let Some(binding) = self
            .program
            .types
            .anonymous_messages
            .get(&NodeKey::of(node))
            .cloned()
        {
            let Some(mut descriptor) = self.decode_message_value(scope.module, &binding.descriptor)
            else {
                return IrExpr::Unsupported {
                    what: "anonymous message".to_string(),
                    why: "checked descriptor anchor is unavailable".to_string(),
                };
            };
            for (name, argument, ty) in binding.arguments {
                descriptor.params.push(IrMessageParam {
                    name,
                    type_id: self.type_id(&ty),
                    value: self.decode_anchored(scope, &argument, "anonymous message argument"),
                });
            }
            return IrExpr::Message(descriptor);
        }
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
        match selected.target.clone() {
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
                let mut args: Vec<TypedExpr> = selected
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
                            // Async predicates lower to an awaited loop at
                            // emission on the await-safe call path; the
                            // lambda lowering already marks them async.
                            let expr = IrExpr::Lambda {
                                param,
                                body: Box::new(body),
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
                if !self.join_collection_call(node, &id, overload, &selected, &mut args)
                    || !self
                        .join_contract_collection_call(node, &id, overload, &selected, &mut args)
                {
                    return IrExpr::Unsupported {
                        what: "collection call source facts".into(),
                        why:
                            "checked query, alias or external predicate disagrees with lowered call"
                                .into(),
                    };
                }
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
        // Resolve only schema provenance. The argument below still lowers the
        // authored local read, retaining its already evaluated descriptor.
        let descriptor_key = NodeKey::of(&descriptor_node);
        let origin = self
            .program
            .types
            .message_descriptor_references
            .get(&descriptor_key)
            .copied()
            .unwrap_or(descriptor_key);
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
        let schemas = match &args[descriptor_index].ty {
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
                vec![IrFormatSchema {
                    source_lang: data.source_lang.clone(),
                    param_types: params,
                }]
            }
            ResolvedType::InlineMessage => {
                let Some(module) = self.program.effects.modules.get(&scope.module) else {
                    return unsupported("checked inline descriptor module is unavailable");
                };
                let source_lang = module.source_lang.clone();
                let leaves = self
                    .program
                    .types
                    .anonymous_message_choices
                    .get(&origin)
                    .cloned()
                    .unwrap_or_else(|| vec![origin]);
                let mut schemas = Vec::new();
                for leaf in leaves {
                    let mut params = Vec::new();
                    if let Some(binding) = self.program.types.anonymous_messages.get(&leaf) {
                        for (name, _, ty) in &binding.arguments {
                            let Some(tag) = Self::format_param_tag(ty) else {
                                return unsupported(
                                    "checked anonymous argument has no Values presentation tag",
                                );
                            };
                            params.push((name.clone(), self.type_id(ty), tag.to_string()));
                        }
                    } else if !self
                        .node(&leaf)
                        .is_some_and(|node| node.kind == SyntaxKind::MessageValue)
                    {
                        return unsupported("descriptor leaf has no checked inline schema");
                    }
                    let schema = IrFormatSchema {
                        source_lang: source_lang.clone(),
                        param_types: params,
                    };
                    if !schemas.contains(&schema) {
                        schemas.push(schema);
                    }
                }
                schemas
            }
            _ => return unsupported("descriptor has no checked message owner or inline schema"),
        };
        IrExpr::Format {
            args,
            descriptor_index,
            locale_index,
            schemas,
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
            ResolvedType::Enum { .. } => Some("enum"),
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
            ResolvedType::Enum { owner: None, cases } => format!("enum({})", cases.join(",")),
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
        let checked = self
            .program
            .types
            .checked_queries
            .get(&NodeKey::of(node))
            .cloned();
        if let Some(fact) = &checked {
            let clauses: Vec<_> = parts
                .iter()
                .filter(|part| part.kind == SyntaxKind::QueryClause)
                .collect();
            if fact.node != NodeKey::of(node)
                || fact.domain != NodeKey::of(head)
                || fact.result != *ty
                || self.program.types.node_types.get(&fact.domain) != Some(&fact.domain_type)
                || fact.clauses.len() != clauses.len()
                || fact.clauses.iter().zip(&clauses).any(|(fact, clause)| {
                    let parts = kids(clause);
                    let keyword = parts
                        .iter()
                        .find_map(|part| name_text(self.db, part))
                        .unwrap_or_default();
                    let kind_matches = match &fact.kind {
                        CheckedQueryClauseKind::As { name } => {
                            keyword == "as"
                                && parts
                                    .iter()
                                    .rev()
                                    .find_map(|part| name_text(self.db, part))
                                    .as_ref()
                                    == Some(name)
                        }
                        CheckedQueryClauseKind::Where => keyword == "where",
                        CheckedQueryClauseKind::Order => keyword == "order",
                        CheckedQueryClauseKind::Limit => keyword == "limit",
                        CheckedQueryClauseKind::Archived => keyword == "archived",
                        CheckedQueryClauseKind::Select => keyword == "select",
                    };
                    !kind_matches
                        || fact.node != NodeKey::of(clause)
                        || fact.expressions
                            != kids(clause)
                                .iter()
                                .filter(|part| is_expression(part.kind))
                                .map(|part| NodeKey::of(part))
                                .collect::<Vec<_>>()
                })
            {
                return IrExpr::Unsupported {
                    what: "query source facts".into(),
                    why: "checked domain, result or ordered clauses disagree with source".into(),
                };
            }
        }
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
        for (index, clause) in clauses.iter().enumerate() {
            let clause_parts = kids(clause);
            let keyword = clause_parts
                .iter()
                .find_map(|n| name_text(self.db, n))
                .unwrap_or_default();
            if keyword == "as" {
                alias = match checked.as_ref().and_then(|fact| fact.clauses.get(index)) {
                    Some(crate::analysis::types::CheckedQueryClause {
                        kind: CheckedQueryClauseKind::As { name },
                        ..
                    }) => Some(name.clone()),
                    Some(_) => {
                        return IrExpr::Unsupported {
                            what: "query alias".into(),
                            why: "checked clause kind disagrees with source".into(),
                        };
                    }
                    None => clause_parts
                        .iter()
                        .rev()
                        .find_map(|n| name_text(self.db, n)),
                };
            }
        }
        let mut where_pred = None;
        let mut where_async = false;
        let mut order = Vec::new();
        let mut value_order = None;
        let mut limit = None;
        let mut archived = None;
        let mut select = None;
        let mut select_param = None;
        let value_domain = model.is_none();
        // Existing native source correspondence uses `row` for model query
        // parameters. Keep that shape unless it would capture an authored
        // outer `row`; the checked explicit alias then needs its own binding.
        fn captures_normalized_row(
            db: &SourceDb,
            node: &SyntaxNode,
            scope: &Scope,
            bound: &HashSet<String>,
        ) -> bool {
            let parts = kids(node);
            if node.kind == SyntaxKind::NameRef {
                return parts
                    .iter()
                    .find_map(|part| name_text(db, part))
                    .is_some_and(|name| {
                        !bound.contains(&name)
                            && scope.row_rewrite.get(&name).unwrap_or(&name) == "row"
                    });
            }
            let query_alias = (node.kind == SyntaxKind::Query).then(|| {
                parts
                    .iter()
                    .filter(|part| part.kind == SyntaxKind::QueryClause)
                    .find_map(|part| {
                        let names: Vec<_> = kids(part)
                            .iter()
                            .filter_map(|name| name_text(db, name))
                            .collect();
                        (names.first().map(String::as_str) == Some("as"))
                            .then(|| names.get(1).cloned())
                            .flatten()
                    })
                    .unwrap_or_else(|| "row".to_string())
            });
            parts.iter().any(|part| {
                if let Some(alias) = &query_alias
                    && part.kind == SyntaxKind::QueryClause
                {
                    let keyword = kids(part).iter().find_map(|name| name_text(db, name));
                    if matches!(keyword.as_deref(), Some("where" | "order" | "select")) {
                        let mut nested = bound.clone();
                        nested.insert(alias.clone());
                        return captures_normalized_row(db, part, scope, &nested);
                    }
                }
                captures_normalized_row(db, part, scope, bound)
            })
        }
        // An omitted value alias creates no source binding. Keep the generated
        // loop parameter out of the source namespace, including outer `row`.
        let authored_param = alias.clone().unwrap_or_else(|| {
            if value_domain {
                format!("$query$value${}", node.span.start)
            } else {
                "row".to_string()
            }
        });
        let bound = HashSet::from([authored_param.clone()]);
        let captures_row = !value_domain
            && clauses.iter().any(|clause| {
                let parts = kids(clause);
                parts
                    .iter()
                    .find_map(|part| name_text(self.db, part))
                    .as_deref()
                    == Some("where")
                    && parts
                        .iter()
                        .filter(|part| is_expression(part.kind))
                        .any(|part| captures_normalized_row(self.db, part, scope, &bound))
            });
        let where_param = if value_domain {
            authored_param.clone()
        } else if captures_row && authored_param == "row" {
            format!("$query$row${}", node.span.start)
        } else if captures_row {
            authored_param.clone()
        } else {
            "row".to_string()
        };
        let mut inner = scope.clone();
        if let Some(alias) = &alias {
            let target = where_param.clone();
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
            inner
                .row_rewrite
                .insert("row".to_string(), where_param.clone());
            inner.name_types.insert(
                where_param.clone(),
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
                        where_async = expr_uses_async(&pred);
                        where_pred = Some(Box::new(pred));
                    }
                }
                "order" => {
                    if value_domain {
                        let Some(value) = clause_parts.iter().find(|n| is_expression(n.kind))
                        else {
                            return IrExpr::Unsupported {
                                what: "value query order".into(),
                                why: "checked ordering expression is required".into(),
                            };
                        };
                        let descending = value.kind == SyntaxKind::Unary
                            && kids(value).iter().any(|part| {
                                part.kind == SyntaxKind::Punct && self.text(part.span) == "-"
                            });
                        let key_node = if descending {
                            kids(value)
                                .into_iter()
                                .find(|part| is_expression(part.kind))
                                .unwrap_or(value)
                        } else {
                            value
                        };
                        let key = self.decode_expr(&inner, key_node);
                        if !matches!(key.ty.nullable_inner().unwrap_or(&key.ty), ResolvedType::Scalar(scalar) if scalar.is_ordered())
                        {
                            return IrExpr::Unsupported {
                                what: "value query order".into(),
                                why: "an ordered checked scalar key is required".into(),
                            };
                        }
                        value_order = Some(IrValueOrder {
                            key: Box::new(key),
                            descending,
                        });
                        continue;
                    }
                    if let Some(value) = clause_parts.iter().find(|n| is_expression(n.kind)) {
                        let term = model_id.zip(alias.as_deref()).and_then(|(model, alias)| {
                            self.decode_query_field_order(value, model, alias)
                        });
                        match term {
                            Some(term) => order.push(term),
                            None => {
                                return IrExpr::Unsupported {
                                    what: "expression query order".to_string(),
                                    why: "no §13 lowering exists".to_string(),
                                };
                            }
                        }
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
                    select_param = Some(alias.clone().unwrap_or_else(|| {
                        if value_domain {
                            where_param.clone()
                        } else {
                            "row".to_string()
                        }
                    }));
                    select = Some(Box::new(projection));
                }
                _ => {}
            }
        }
        if checked.as_ref().is_some_and(|fact| {
            fact.projection.is_some()
                && !self.query_projection_matches(fact, select.as_deref(), select_param.as_deref())
        }) {
            return IrExpr::Unsupported {
                what: "query projection source facts".into(),
                why: "checked owning fields or row mappings disagree with lowered projection"
                    .into(),
            };
        }
        let _ = ty;
        let domain = match model {
            Some(model) => IrQueryDomain::Model(model),
            None => IrQueryDomain::Value {
                base: Box::new(value_base.expect("value domain decodes its head")),
                alias: alias.unwrap_or_else(|| where_param.clone()),
            },
        };
        IrExpr::Query(IrQuery {
            source: checked.map(Box::new),
            collection_call: None,
            contract_collection_call: None,
            domain,
            parent,
            where_param,
            where_pred,
            where_async,
            order,
            value_order,
            limit,
            archived,
            select,
            select_param,
        })
    }

    /// Checked nominal row mappings must match the actual typed select body.
    /// Merely carrying a projection-shaped fact is not a correspondence proof.
    fn query_projection_matches(
        &self,
        query: &CheckedQuery,
        projection: Option<&TypedExpr>,
        parameter: Option<&str>,
    ) -> bool {
        let valid = (|| {
            let proof = query.projection.as_ref()?;
            let projection = projection?;
            let parameter = parameter?;
            let mut active_alias = None;
            let mut projection_alias = None;
            for clause in &query.clauses {
                match &clause.kind {
                    CheckedQueryClauseKind::As { .. } => active_alias = Some(clause),
                    CheckedQueryClauseKind::Select => {
                        if projection_alias.is_some() {
                            return None;
                        }
                        projection_alias = Some(active_alias?);
                    }
                    _ => {}
                }
            }
            let alias = projection_alias?;
            if alias.node != proof.alias
                || !matches!(&alias.kind, CheckedQueryClauseKind::As {name} if name == parameter)
                || projection.span != Span::new(proof.node.file, proof.node.start, proof.node.end)
                || projection.ty
                    != (ResolvedType::Record {
                        symbol: proof.contract,
                        stored: false,
                    })
            {
                return None;
            }
            let ResolvedType::Array { element, .. } = &query.domain_type else {
                return None;
            };
            let row_type = ResolvedType::Record {
                symbol: proof.model,
                stored: true,
            };
            if **element != row_type {
                return None;
            }
            let model = self.program.symbols.get(proof.model.0 as usize)?;
            if !matches!(model.kind, SymbolKind::Model { .. }) {
                return None;
            }
            let contract = self.program.symbols.get(proof.contract.0 as usize)?;
            let SymbolKind::Contract { fields: declared } = &contract.kind else {
                return None;
            };
            let IrExpr::Object(entries) = &projection.expr else {
                return None;
            };
            if entries.len() != proof.fields.len()
                || entries.len() != declared.len()
                || entries.len() > 200
            {
                return None;
            }
            let is_row = |value: &TypedExpr| {
                value.ty == row_type
                    && matches!(&value.expr, IrExpr::Name(name) if name == parameter)
            };
            let mut seen = HashSet::new();
            for ((name, value), field) in entries.iter().zip(&proof.fields) {
                let owner = self.program.symbols.get(field.field.0 as usize)?;
                if !seen.insert(field.field)
                    || !declared.contains(&field.field)
                    || owner.name != *name
                    || !matches!(owner.kind, SymbolKind::Field {owner, ..} if owner == proof.contract)
                    || value.ty != field.ty
                    || self.program.types.node_types.get(&field.node) != Some(&field.ty)
                {
                    return None;
                }
                // Group lowering erases wrappers; shorthand retains its actual
                // checked key-token anchor rather than an invented expression.
                let mut node = self.node(&field.node)?;
                let mut depth = 0;
                while node.kind == SyntaxKind::Group {
                    depth += 1;
                    if depth > 64 {
                        return None;
                    }
                    node = kids(node)
                        .into_iter()
                        .find(|child| is_expression(child.kind))?;
                }
                if node.span != value.span {
                    return None;
                }
                match &field.mapping {
                    CheckedQueryProjectionMapping::StoredReference if is_row(value) => {}
                    CheckedQueryProjectionMapping::Version => {
                        if !matches!(&value.expr, IrExpr::Member {base,field} if field == "version" && is_row(base))
                            || value.ty != ResolvedType::Scalar(Scalar::Int)
                        {
                            return None;
                        }
                    }
                    CheckedQueryProjectionMapping::DirectField { field: source } => {
                        let source = self.program.symbols.get(source.0 as usize)?;
                        if !matches!(source.kind, SymbolKind::Field {owner, ..} if owner == proof.model)
                            || !model.fields_of().contains(&source.id)
                            || !matches!(&value.expr, IrExpr::Member {base,field} if field == &source.name && is_row(base))
                        {
                            return None;
                        }
                    }
                    _ => return None,
                }
            }
            Some(())
        })();
        valid.is_some()
    }

    /// The native mutation query contract orders direct stored fields and
    /// the checked stored row's `id`. It does not evaluate arbitrary keys.
    fn decode_query_field_order(
        &self,
        node: &SyntaxNode,
        model: SymbolId,
        alias: &str,
    ) -> Option<IrOrder> {
        let (member, descending) = if node.kind == SyntaxKind::Unary {
            let parts = kids(node);
            let op = parts.iter().find(|n| n.kind == SyntaxKind::Punct)?;
            if self.text(op.span) != "-" {
                return None;
            }
            (*parts.iter().find(|n| is_expression(n.kind))?, true)
        } else {
            (node, false)
        };
        if member.kind != SyntaxKind::Member {
            return None;
        }
        let parts = kids(member);
        let base = *parts.iter().find(|n| is_expression(n.kind))?;
        if base.kind != SyntaxKind::NameRef
            || self.text(base.span) != alias
            || self.node_type(base)
                != (ResolvedType::Record {
                    symbol: model,
                    stored: true,
                })
        {
            return None;
        }
        let field = parts.iter().rev().find_map(|n| name_text(self.db, n))?;
        let ty = self.node_type(member);
        if let Some(symbol) = self.fields.get(&(model, field.clone())) {
            if !matches!(self.program.symbols[symbol.0 as usize].kind,
                SymbolKind::Field { owner, .. } if owner == model)
            {
                return None;
            }
        } else if !matches!(
            (field.as_str(), &ty),
            ("id", ResolvedType::Scalar(Scalar::Text))
                | ("created", ResolvedType::Scalar(Scalar::Datetime))
        ) || !matches!(
            self.program.symbols.get(model.0 as usize)?.kind,
            SymbolKind::Model { .. }
        ) {
            return None;
        } else {
            // Both metadata keys already belong to the native record order
            // contract. Other metadata remains outside this checked profile.
            return Some(IrOrder { field, descending });
        }
        let ty = ty.nullable_inner().unwrap_or(&ty);
        if !matches!(
            ty,
            ResolvedType::Scalar(
                Scalar::Text
                    | Scalar::Bool
                    | Scalar::Int
                    | Scalar::Decimal
                    | Scalar::Money
                    | Scalar::Date
                    | Scalar::Datetime
            )
        ) {
            return None;
        }
        Some(IrOrder { field, descending })
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
                work.extend(query.value_order.iter().map(|order| order.key.as_ref()));
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
            IrExpr::HasRole {
                person: Some(_), ..
            } => return true,
            IrExpr::HasRole { person: None, .. } => {}
            IrExpr::Lambda { body, .. } => work.push(body),
            IrExpr::JudgmentSpecification { options, .. } => work.extend(options.as_deref()),
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
            | IrExpr::PageTimePredicate(_)
            | IrExpr::Unsupported { .. } => {}
        }
    }
    false
}

/// Whether `expr` uses `async` only through awaited builtins (never
/// through derive or capability calls).
///
/// Awaited builtins lower self-contained given the ambient context, so
/// async predicates built only from them can lower to an awaited inline
/// loop. Derive and capability calls need helper linkage and
/// receipt/closure context that inline lambdas do not reliably provide,
/// so predicates using them keep the synchronous-predicate boundary.
pub fn expr_async_without_derives(expr: &TypedExpr) -> bool {
    let mut found_async = false;
    let mut work = vec![expr];
    while let Some(current) = work.pop() {
        match &current.expr {
            IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                if matches!(
                    target,
                    IrCallTarget::CapabilityOp(_) | IrCallTarget::DeriveFn(_)
                ) {
                    return false;
                }
                if matches!(target, IrCallTarget::Builtin { awaited: true, .. }) {
                    found_async = true;
                }
                work.extend(args);
            }
            IrExpr::DeliveryRead { .. } => found_async = true,
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
                    IrQueryDomain::Model(_) => found_async = true,
                    IrQueryDomain::Value { base, .. } => work.push(base),
                }
                work.extend(query.value_order.iter().map(|order| order.key.as_ref()));
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
            IrExpr::HasRole {
                person: Some(_), ..
            } => found_async = true,
            IrExpr::HasRole { person: None, .. } => {}
            IrExpr::Lambda { body, .. } => work.push(body),
            IrExpr::JudgmentSpecification { options, .. } => work.extend(options.as_deref()),
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
            | IrExpr::PageTimePredicate(_)
            | IrExpr::Unsupported { .. } => {}
        }
    }
    found_async
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
            EffectVerb::Call => self.decode_effect_call(scope, effect, span),
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
            // Only generated CRUD wrappers own CRUD candidate admission.
            // Authored effects retain their explicit guards and native rules.
            when: None,
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
        let _ = what;
        IrStmt::Set {
            record,
            changes: self.effect_args_object(scope, effect),
            when: None,
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

    /// Decode a `send` effect through the existing staged outbox ABI.
    fn decode_send(
        &mut self,
        scope: &Scope,
        effect: &crate::analysis::effects::Effect,
        what: &str,
        span: Span,
    ) -> IrStmt {
        let sink = match &effect.target {
            Some(crate::analysis::effects::EffectTarget::Queue { queue, op })
                if op == "publish" =>
            {
                Some((queue, op))
            }
            Some(crate::analysis::effects::EffectTarget::Analytics { sink, op })
                if op == "write" =>
            {
                Some((sink, op))
            }
            _ => None,
        };
        if let Some((name, op)) = sink {
            let owner = &self.program.modules[scope.module.0 as usize].name;
            return IrStmt::Send {
                operation: format!("{owner}.{name}.{op}"),
                deployment_binding: Some(format!("{owner}.{name}")),
                args: self.effect_args_object(scope, effect),
                when: effect
                    .when
                    .as_ref()
                    .map(|key| self.decode_anchored(scope, key, &format!("{what} send guard"))),
                binding: effect.binding.clone(),
                span,
            };
        }
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

    /// Join the checked operand, possible declaring operations, authored
    /// arguments and result without replacing dynamic values by spellings.
    fn decode_effect_call(
        &mut self,
        scope: &Scope,
        effect: &crate::analysis::effects::Effect,
        span: Span,
    ) -> IrStmt {
        use crate::analysis::effects::EffectTarget;
        let (Some(node), Some(result)) = (
            effect.target_node,
            self.program.types.effect_call_results.get(&effect.node),
        ) else {
            return unsupported_stmt(
                "call statement",
                "checked target or result facts are unavailable",
                span,
            );
        };
        let result = result.clone();
        let checked = self.program.types.node_types.get(&node).cloned();
        let target = match (&effect.target, checked.as_ref()) {
            (Some(EffectTarget::Operation(operation)), Some(ResolvedType::Operation(checked)))
                if operation == checked =>
            {
                IrEffectCallTarget::Operation {
                    source: Span::new(node.file, node.start, node.end),
                    operation: *operation,
                }
            }
            (
                Some(EffectTarget::Invocation(targets)),
                Some(ResolvedType::Invocation { targets: checked }),
            ) if targets == checked && !targets.is_empty() => IrEffectCallTarget::Invocation {
                operand: self.decode_anchored(scope, &node, "invocation call target"),
                targets: targets.clone(),
            },
            (
                Some(EffectTarget::Action(targets)),
                Some(ResolvedType::Action {
                    targets: checked, ..
                }),
            ) if targets == checked && !targets.is_empty() => IrEffectCallTarget::Action {
                operand: self.decode_anchored(scope, &node, "action call target"),
                targets: targets.clone(),
            },
            _ => {
                return unsupported_stmt(
                    "call statement",
                    "checked operand and declaring targets disagree",
                    span,
                );
            }
        };
        IrStmt::Call {
            target,
            inputs: self.effect_args_object(scope, effect),
            binding: effect.binding.clone(),
            result,
            span,
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
                let value = value.unwrap_or_else(|| self.shorthand_value(&arg.key, arg.key_node));
                (arg.key.clone(), value)
            })
            .collect();
        TypedExpr::new(IrExpr::Object(entries), ResolvedType::Unknown, span)
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
            .filter(|(_, policy)| ordinary_read_policy(policy))
            .map(|(index, policy)| {
                let public = self.is_explicit_public_read(policy);
                IrGrant {
                    rule: format!(
                        "{}.read.{}",
                        model_rule_prefix(self.program, symbol),
                        index + 1
                    ),
                    fields: policy.fields.clone(),
                    public,
                }
            })
            .collect();
        let invariants = data
            .invariants
            .iter()
            .enumerate()
            .map(|(index, _)| {
                format!(
                    "{}.require.{}",
                    model_rule_prefix(self.program, symbol),
                    index + 1
                )
            })
            .collect();
        let locks = data
            .locks
            .iter()
            .enumerate()
            .map(|(index, _)| {
                format!(
                    "{}.lock.{}",
                    model_rule_prefix(self.program, symbol),
                    index + 1
                )
            })
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
    /// Lower `on=Cap.op.completed` to its typed completion source
    /// (DESIGN §8).
    ///
    /// The identity is the canonical `capability.op` path; the result
    /// name renders the op's declared result for the invocation
    /// descriptor (records by canonical name, std nominals by name,
    /// scalars and enums by declared spelling, nullable results by
    /// their inner shape — the §8 envelope already marks the result
    /// nullable and the JS carrier re-applies the `?`). Anything else
    /// yields `None` and keeps the §13 refusal: the completion payload
    /// would be unnameable.
    fn delivery_completion_source(
        &self,
        capability: SymbolId,
        op: SymbolId,
    ) -> Option<IrEventSource> {
        let cap = self.program.symbols.get(capability.0 as usize)?;
        let op_symbol = self.program.symbols.get(op.0 as usize)?;
        let SymbolKind::CapabilityOp { .. } = &op_symbol.kind else {
            return None;
        };
        let result = self.completion_result_type(op)?;
        let mut result = &result;
        while let ResolvedType::Nullable(inner) = result {
            result = inner;
        }
        let result_type = match result {
            ResolvedType::Record { symbol, .. } => self
                .program
                .symbols
                .get(symbol.0 as usize)?
                .canonical
                .clone(),
            ResolvedType::StdNominal { name, .. } => name.to_string(),
            ResolvedType::Scalar(scalar) => scalar.as_str().to_string(),
            ResolvedType::Enum { cases, .. } => format!("enum({})", cases.join(",")),
            _ => return None,
        };
        Some(IrEventSource::DeliveryCompleted {
            source: format!("{}.{}", cap.canonical, op_symbol.name),
            result_type,
        })
    }

    /// Checked `event` payload for `on=Cap.op.completed`: the DESIGN
    /// §8 envelope with the op's declared result, mirroring the
    /// checker's [`crate::analysis::types`] completion typing.
    fn delivery_completion_payload(&self, op: SymbolId) -> Option<ResolvedType> {
        let result = self.completion_result_type(op)?;
        Some(completion_envelope(Some(result)))
    }

    /// Declared result type of a capability op, from the published
    /// symbol results (the op's `result_node` carries no node type).
    fn completion_result_type(&self, op: SymbolId) -> Option<ResolvedType> {
        let op_symbol = self.program.symbols.get(op.0 as usize)?;
        if !matches!(op_symbol.kind, SymbolKind::CapabilityOp { .. }) {
            return None;
        }
        self.program
            .types
            .symbol_results
            .get(&op)
            .cloned()
            .flatten()
    }

    #[allow(clippy::type_complexity)]
    fn decode_scenario(
        &mut self,
        symbol: &crate::analysis::resolve::Symbol,
    ) -> (
        bool,
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
        if matches!(
            data.on,
            Some(crate::analysis::effects::HandlerSource::TeamsMemberRemoved)
        ) {
            // This fixed owning source has a checked payload even when the
            // member checker does not retain its contextual receiver node.
            scope.name_types.insert(
                "event".into(),
                ResolvedType::Object(vec![
                    ("team_id".into(), ResolvedType::Scalar(Scalar::Text)),
                    ("membership_id".into(), ResolvedType::Scalar(Scalar::Text)),
                    ("user".into(), ResolvedType::Scalar(Scalar::User)),
                ]),
            );
        }
        if self.mailbox_received_source(symbol.id).is_some()
            && let Some(on) = data.on_node
            && let Some(fact) = self.program.types.std_capability_event_handlers.get(&on)
        {
            scope
                .name_types
                .insert("event".into(), fact.payload.clone());
        }
        if let Some(crate::analysis::effects::HandlerSource::Queue { name }) = &data.on {
            if let Some(payload) = self
                .program
                .types
                .runtime_bindings
                .get(&symbol.module)
                .into_iter()
                .flatten()
                .find_map(|binding| match binding {
                    crate::analysis::types::CheckedRuntimeBinding::Queue {
                        name: declared,
                        payload,
                    } if declared == name => Some(payload.clone()),
                    _ => None,
                })
            {
                scope.name_types.insert("event".into(), payload);
            }
        }
        // Adapter completions carry the DESIGN §8 envelope even when the
        // member checker does not retain a contextual receiver node.
        if let Some(crate::analysis::effects::HandlerSource::DeliveryCompleted { op, .. }) =
            &data.on
            && let Some(payload) = self.delivery_completion_payload(*op)
        {
            scope.name_types.insert("event".into(), payload);
        }
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
        // Family E: `scope=authority` reports lower without `E6008`: the
        // decision-mode runtime boundary landed (State decision mode +
        // host read seam + helper-consumer proof), so emission carries
        // the §13 marker, the decision-mode body and the grant
        // advertisement with host evaluation.
        // Pre-commit hooks use the engine context. Ordinary declared events
        // retain their checked identity and existing `{event}` handler ABI.
        let event_source = match &data.on {
            Some(crate::analysis::effects::HandlerSource::StdDeliveryCompleted { .. }) => {
                // Only the complete source-backed Email candidate can release
                // this bounded native profile; all other graphs rebuild refused.
                if !self.native_standard_completion {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        format!("cannot lower scenario {}: standard handler triggers await the native terminal carrier", symbol.canonical),
                        symbol.span,
                    ));
                }
                self.standard_completion_source(symbol.id)
            }
            Some(crate::analysis::effects::HandlerSource::Queue { name }) => self
                .program
                .types
                .runtime_bindings
                .get(&symbol.module)
                .into_iter()
                .flatten()
                .find_map(|binding| match binding {
                    crate::analysis::types::CheckedRuntimeBinding::Queue {
                        name: declared,
                        payload,
                    } if declared == name => Some(IrEventSource::Queue {
                        source: format!(
                            "{}.{}",
                            self.program.modules[symbol.module.0 as usize].name, name
                        ),
                        payload: payload.clone(),
                    }),
                    _ => None,
                }),
            Some(crate::analysis::effects::HandlerSource::Event(event)) => {
                if let Some(bind) = data.cohort.as_ref().and_then(|cohort| cohort.bind.as_ref())
                    && let SymbolKind::Event { fields } =
                        &self.program.symbols[event.0 as usize].kind
                    && fields
                        .iter()
                        .any(|field| self.program.symbols[field.0 as usize].name == *bind)
                {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        format!("cannot lower scenario {}: cohort child binding `{bind}` conflicts with an event input", symbol.canonical),
                        symbol.span,
                    ));
                }
                Some(IrEventSource::Declared(self.canonical(*event)))
            }
            Some(crate::analysis::effects::HandlerSource::DeliveryProgressed { source })
                if data.cohort.is_none() =>
            {
                Some(IrEventSource::DeliveryProgressed(source.clone()))
            }
            Some(crate::analysis::effects::HandlerSource::TeamsMemberRemoved) => {
                Some(IrEventSource::TeamsMemberRemoved)
            }
            Some(crate::analysis::effects::HandlerSource::StdCapabilityEvent {
                capability,
                event,
                ..
            }) if capability == "std.MailboxV1" && event == "received" => {
                self.mailbox_received_source(symbol.id)
            }
            // Provider capability events carry the same checked field
            // payload as declared events (both lower to `Event` items);
            // the `owner.Cap.event` identity preserves the §13.4
            // provider-routed form for ingress enrollment downstream.
            Some(crate::analysis::effects::HandlerSource::CapabilityEvent {
                event,
                ..
            }) => Some(IrEventSource::Declared(self.canonical(*event))),
            Some(crate::analysis::effects::HandlerSource::Committed { model, event }) => {
                let change = match event.as_str() {
                    "created" => Some(IrCommittedChange::Create),
                    "updated" => Some(IrCommittedChange::Update),
                    "deleted" => Some(IrCommittedChange::Delete),
                    _ => None,
                };
                change.map(|change| IrEventSource::Committed {
                    model: *model,
                    change,
                })
            }
            Some(crate::analysis::effects::HandlerSource::DeliveryCompleted { capability, op }) => {
                self.delivery_completion_source(*capability, *op)
            }
            // Recurring ticks keep their checked period; an unparseable
            // duration keeps the §13 refusal (the checker already
            // requires a duration literal at E3010).
            Some(crate::analysis::effects::HandlerSource::Every { duration }) => {
                duration_millis(duration).map(|interval_ms| IrEventSource::Every { interval_ms })
            }
            Some(crate::analysis::effects::HandlerSource::InstrumentationError) => {
                Some(IrEventSource::InstrumentationError)
            }
            _ => None,
        };
        let hook = match &data.on {
            Some(crate::analysis::effects::HandlerSource::Hook { model, op })
                if data.cohort.is_none() =>
            {
                Some(IrHook {
                    model: *model,
                    op: *op,
                })
            }
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
        if let Some(cohort) = &data.cohort
            && let Some(bind) = &cohort.bind
        {
            scope.name_types.insert(
                bind.clone(),
                ResolvedType::Record {
                    symbol: cohort.model,
                    stored: true,
                },
            );
        }
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
        let cohort = data.cohort.as_ref().map(IrCohort::from);
        // Family E: the marker is the checked analysis fact read from
        // the actual `scope` attribute node — never re-derived here —
        // so IR, §13 emission and the checker agree on one source fact.
        (
            data.read,
            data.scope_authority,
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
        if let Some(field) = self.program.types.given_fields.get(&symbol.id) {
            let ty = self
                .program
                .types
                .symbol_types
                .get(&symbol.id)
                .cloned()
                .unwrap_or(ResolvedType::Error);
            let default = field
                .default
                .as_ref()
                .map(|value| IrDefault::Literal(given_constant_expr(value, &ty, symbol.span)));
            let bound_ty = given_bound_type(&ty);
            let modifiers = IrModifiers {
                trim: field.trim,
                min: field
                    .min
                    .as_ref()
                    .map(|value| given_constant_expr(value, &bound_ty, symbol.span)),
                max: field
                    .max
                    .as_ref()
                    .map(|value| given_constant_expr(value, &bound_ty, symbol.span)),
                ..IrModifiers::default()
            };
            let label = self.decode_given_field_label(symbol);
            return (false, default, None, modifiers, label, None);
        }
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
        let mut default = data.default.as_ref().map(|key| {
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
        self.inherit_field_modifiers(symbol, &mut modifiers);
        self.apply_given_field_constraints(symbol.id, &mut modifiers);
        if default.is_none() {
            default = self
                .program
                .types
                .given_constraints
                .get(&symbol.id)
                .and_then(|constraints| constraints.iter().find_map(|field| field.default.as_ref()))
                .map(|value| {
                    IrDefault::Literal(given_constant_expr(
                        value,
                        &self.program.types.symbol_types[&symbol.id],
                        symbol.span,
                    ))
                });
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

    fn apply_given_field_constraints(&self, field: SymbolId, modifiers: &mut IrModifiers) {
        let Some(constraints) = self.program.types.given_constraints.get(&field) else {
            return;
        };
        let symbol = &self.program.symbols[field.0 as usize];
        let ty = self
            .program
            .types
            .symbol_types
            .get(&field)
            .map(given_bound_type)
            .unwrap_or(ResolvedType::Scalar(crate::analysis::types::Scalar::Int));
        apply_given_field_constraints_to(modifiers, &ty, symbol.span, constraints);
    }

    /// Fold only representation normalization and value bounds through the
    /// checked immediate reuse chain. Declaration behavior remains receiving-owned.
    fn inherit_field_modifiers(
        &mut self,
        receiving: &crate::analysis::resolve::Symbol,
        modifiers: &mut IrModifiers,
    ) {
        if !self
            .program
            .types
            .field_reuse_sources
            .contains_key(&receiving.id)
        {
            return;
        }
        let mut chain = Vec::new();
        let mut current = match receiving.kind {
            SymbolKind::Param { .. } => self.program.types.field_reuse_sources[&receiving.id],
            _ => receiving.id,
        };
        let mut seen = HashSet::new();
        loop {
            if !seen.insert(current) || chain.len() >= 128 {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower reused field modifiers: cyclic or oversized checked reuse chain"
                        .to_string(),
                    receiving.span,
                ));
                return;
            }
            let Some(symbol) = self.program.symbols.get(current.0 as usize) else {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower reused field modifiers: missing checked field".to_string(),
                    receiving.span,
                ));
                return;
            };
            let SymbolKind::Field { owner, .. } = symbol.kind else {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower reused field modifiers: source is not a declared field"
                        .to_string(),
                    receiving.span,
                ));
                return;
            };
            if matches!(receiving.kind, SymbolKind::Param { .. }) {
                // A scalar field wrapped in [] retains element identity, not
                // outer cardinality. Stop at that exact checked layer boundary.
                let array_element = |ty: &ResolvedType| {
                    let ty = match ty {
                        ResolvedType::Nullable(inner) => inner.as_ref(),
                        _ => ty,
                    };
                    match ty {
                        ResolvedType::Array { element, .. } => Some(element.as_ref().clone()),
                        _ => None,
                    }
                };
                let receiving_element = self
                    .program
                    .types
                    .symbol_types
                    .get(&receiving.id)
                    .and_then(array_element);
                let source_element = self
                    .program
                    .types
                    .symbol_types
                    .get(&current)
                    .and_then(array_element);
                if receiving_element.is_none() || receiving_element != source_element {
                    break;
                }
            }
            let data = self
                .program
                .effects
                .models
                .get(&owner)
                .and_then(|model| model.fields.iter().find(|field| field.field == current))
                .or_else(|| {
                    self.program.effects.records.get(&owner).and_then(|record| {
                        record.fields.iter().find(|field| field.field == current)
                    })
                });
            let Some(data) = data else {
                if self
                    .program
                    .types
                    .judgment_generated_symbols
                    .contains(&current)
                    && self.program.types.symbol_types.contains_key(&current)
                {
                    // Generated fields have no authored modifiers. Their
                    // owning checked constraints and receiving intersections
                    // remain in value_constraints, never invented CST nodes.
                    break;
                }
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower reused field modifiers: missing owning declaration modifiers"
                        .to_string(),
                    receiving.span,
                ));
                return;
            };
            chain.push((symbol.id, symbol.module, data.modifiers.clone()));
            let Some(next) = self
                .program
                .types
                .field_reuse_sources
                .get(&current)
                .copied()
            else {
                break;
            };
            current = next;
        }
        let mut effective = IrModifiers::default();
        let mut min_owner = None;
        let mut max_owner = None;
        for (field, module, declared) in chain.into_iter().rev() {
            let scope = Scope::module(module);
            for modifier in declared {
                if modifier.name == "trim" {
                    effective.trim = true;
                }
                let slot = match modifier.name.as_str() {
                    "min" => &mut effective.min,
                    "max" => &mut effective.max,
                    _ => continue,
                };
                let Some(key) = modifier.value else { continue };
                let value = self.decode_anchored(&scope, &key, "reused field bound");
                if let Some(inherited) = slot.as_ref() {
                    let valid = compare_literal_bounds(&value, inherited).is_some_and(|order| {
                        if modifier.name == "min" {
                            order != std::cmp::Ordering::Less
                        } else {
                            order != std::cmp::Ordering::Greater
                        }
                    });
                    if !valid {
                        self.diags.push(Diagnostic::error("E6008", "cannot lower reused field bound: receiving bound must provably narrow its inherited literal bound".to_string(), value.span));
                        return;
                    }
                }
                *slot = Some(value);
                if modifier.name == "min" {
                    min_owner = Some(field);
                } else {
                    max_owner = Some(field);
                }
            }
            self.apply_given_field_constraints(field, &mut effective);
        }
        if let (Some(min), Some(max)) = (&effective.min, &effective.max) {
            let order = compare_literal_bounds(min, max);
            if order == Some(std::cmp::Ordering::Greater)
                || (min_owner != max_owner && order.is_none())
            {
                self.diags.push(Diagnostic::error("E6008", "cannot lower reused field bounds: inherited and receiving bounds need a provably compatible literal range".to_string(), receiving.span));
                return;
            }
        }
        modifiers.trim = effective.trim;
        modifiers.min = effective.min;
        modifiers.max = effective.max;
    }

    fn decode_parameter_array_bounds(
        &mut self,
        symbol: &crate::analysis::resolve::Symbol,
    ) -> Option<IrParameterArrayBounds> {
        let SymbolKind::Param { owner, .. } = symbol.kind else {
            return None;
        };
        if !matches!(
            self.program
                .symbols
                .get(owner.0 as usize)
                .map(|symbol| &symbol.kind),
            Some(SymbolKind::Scenario { .. } | SymbolKind::CapabilityOp { .. })
        ) {
            return None;
        }
        let mut ty = self.program.types.symbol_types.get(&symbol.id)?;
        if let ResolvedType::Nullable(inner) = ty {
            ty = inner;
        }
        if !matches!(ty, ResolvedType::Array { .. }) {
            return None;
        }
        let mut modifiers = IrModifiers::default();
        self.inherit_field_modifiers(symbol, &mut modifiers);
        let mut bounds = IrParameterArrayBounds::default();
        // Generated array aliases retain their already checked intersections.
        // No normalization, distinctness or required-input claim is projected.
        if let Some(checked) = self.program.types.value_constraints.get(&symbol.id) {
            for (minimum, value) in [(true, checked.min), (false, checked.max)] {
                if let Some(value) = value {
                    if !(0..=9_007_199_254_740_991).contains(&value) {
                        self.diags.push(Diagnostic::error("E6008", "cannot lower parameter array length: checked bound has no safe descriptor number".to_string(), symbol.span));
                        return None;
                    }
                    if minimum {
                        bounds.min = Some(value as u64);
                    } else {
                        bounds.max = Some(value as u64);
                    }
                }
            }
        }
        for (minimum, expression) in [(true, modifiers.min), (false, modifiers.max)] {
            let Some(expression) = expression else {
                continue;
            };
            let IrExpr::Int(value) = expression.expr else {
                self.diags.push(Diagnostic::error("E6008", "cannot lower parameter array length: bound must be a nonnegative safe integer literal".to_string(), expression.span));
                return None;
            };
            if !(0..=9_007_199_254_740_991).contains(&value) {
                self.diags.push(Diagnostic::error("E6008", "cannot lower parameter array length: bound must be a nonnegative safe integer literal".to_string(), expression.span));
                return None;
            }
            let value = value as u64;
            if minimum {
                bounds.min = Some(bounds.min.map_or(value, |prior| prior.max(value)));
            } else {
                bounds.max = Some(bounds.max.map_or(value, |prior| prior.min(value)));
            }
        }
        if matches!((bounds.min,bounds.max),(Some(min),Some(max)) if min>max) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower parameter array length: inherited range is empty".to_string(),
                symbol.span,
            ));
            return None;
        }
        (bounds.min.is_some() || bounds.max.is_some()).then_some(bounds)
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
    ) -> (
        Option<IrDefault>,
        Option<SymbolId>,
        Option<IrMessage>,
        Option<String>,
    ) {
        let data = self.param_data(owner, symbol.id);
        let Some(data) = data else {
            return (None, None, None, None);
        };
        let default_copy_source = data.default.as_ref().and_then(|key| {
            let node = self.node(key)?;
            if node.kind != SyntaxKind::NameRef {
                return None;
            }
            let seed = self
                .program
                .types
                .param_default_copy_sources
                .get(&symbol.id)?;
            matches!(
                self.program.symbols[seed.0 as usize].kind,
                SymbolKind::Param { .. }
            )
            .then_some(*seed)
        });
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
        (default, default_copy_source, label, description)
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

/// Apply the original checked Given normalization/bounds intersection.
pub(super) fn apply_given_field_constraints_to(
    modifiers: &mut IrModifiers,
    ty: &ResolvedType,
    at: Span,
    constraints: &[crate::analysis::types::GivenContributedField],
) {
    for constraint in constraints {
        modifiers.trim |= constraint.trim;
        for (slot, value, minimum) in [
            (&mut modifiers.min, &constraint.min, true),
            (&mut modifiers.max, &constraint.max, false),
        ] {
            if let Some(value) = value {
                let bound = given_constant_expr(value, ty, at);
                if slot.as_ref().is_none_or(|old| {
                    compare_literal_bounds(&bound, old).is_some_and(|order| {
                        if minimum {
                            order == std::cmp::Ordering::Greater
                        } else {
                            order == std::cmp::Ordering::Less
                        }
                    })
                }) {
                    *slot = Some(bound);
                }
            }
        }
    }
}

/// Exact bounded literal comparison; no floating point rounding or symbolic
/// evaluation can establish that an override narrows inherited constraints.
pub(super) fn compare_literal_bounds(
    left: &TypedExpr,
    right: &TypedExpr,
) -> Option<std::cmp::Ordering> {
    fn numeric(mut value: &TypedExpr) -> Option<String> {
        let mut negative = false;
        for _ in 0..64 {
            match &value.expr {
                IrExpr::Unary {
                    op: IrUnOp::Neg,
                    operand,
                } => {
                    negative = !negative;
                    value = operand;
                }
                IrExpr::Int(number) => {
                    let text = number.to_string();
                    return Some(if negative {
                        if let Some(positive) = text.strip_prefix('-') {
                            positive.to_owned()
                        } else {
                            format!("-{text}")
                        }
                    } else {
                        text
                    });
                }
                IrExpr::Decimal(text) if text.len() <= 128 => {
                    let text = text.replace('_', "");
                    return Some(if negative { format!("-{text}") } else { text });
                }
                _ => return None,
            }
        }
        None
    }
    fn parts(value: &str) -> Option<(bool, String, String)> {
        let negative = value.starts_with('-');
        let value = value.strip_prefix('-').unwrap_or(value);
        let mut halves = value.split('.');
        let integer = halves.next()?;
        let fraction = halves.next().unwrap_or("");
        if halves.next().is_some()
            || integer.is_empty()
            || !integer.bytes().all(|byte| byte.is_ascii_digit())
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        let integer = integer.trim_start_matches('0');
        let fraction = fraction.trim_end_matches('0');
        Some((
            negative && !(integer.is_empty() && fraction.is_empty()),
            integer.into(),
            fraction.into(),
        ))
    }
    if let (
        IrExpr::Money {
            minor: left,
            currency: lc,
        },
        IrExpr::Money {
            minor: right,
            currency: rc,
        },
    ) = (&left.expr, &right.expr)
    {
        return (lc == rc).then(|| left.cmp(right));
    }
    let (ln, li, mut lf) = parts(&numeric(left)?)?;
    let (rn, ri, mut rf) = parts(&numeric(right)?)?;
    if ln != rn {
        return Some(if ln {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        });
    }
    let length = lf.len().max(rf.len());
    lf.extend(std::iter::repeat_n('0', length - lf.len()));
    rf.extend(std::iter::repeat_n('0', length - rf.len()));
    let order = li
        .len()
        .cmp(&ri.len())
        .then_with(|| li.cmp(&ri))
        .then_with(|| lf.cmp(&rf));
    Some(if ln { order.reverse() } else { order })
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
    /// Rejoin immutable type facts to their original declaration and every handler.
    fn callback_source_matches(&self, source: &CheckedGenerationCallbackSource) -> bool {
        if !source.matches(self.program) {
            return false;
        }
        let Some(field) = self.program.symbols.get(source.field.0 as usize) else {
            return false;
        };
        let Some(model) = self.program.symbols.get(source.model.0 as usize) else {
            return false;
        };
        let Some(module) = self.program.modules.get(source.module.0 as usize) else {
            return false;
        };
        if field.module != source.module
            || model.module != source.module
            || !matches!(field.kind, SymbolKind::Field { owner, type_node }
                if owner == source.model && type_node == source.type_node)
            || !matches!(model.kind, SymbolKind::Model { .. })
        {
            return false;
        }
        let Some(ty) = self.program.types.symbol_types.get(&source.field) else {
            return false;
        };
        let ResolvedType::StdDelivery { capability, op } = ty.nullable_inner().unwrap_or(ty) else {
            return false;
        };
        if format!("{capability}.{}", op.name) != source.canonical_operation
            || !matches!(
                (*capability, op.name),
                ("std.ImagesV1", "submit") | ("std.TextGenerationV1", "generate")
            )
        {
            return false;
        }
        let Some(mut syntax) = self.node(&source.type_node) else {
            return false;
        };
        if syntax.kind == SyntaxKind::NullableType {
            let Some(inner) = kids(syntax)
                .into_iter()
                .find(|node| node.kind == SyntaxKind::DeliveryType)
            else {
                return false;
            };
            syntax = inner;
        }
        if syntax.kind != SyntaxKind::DeliveryType {
            return false;
        }
        let paths = kids(syntax)
            .into_iter()
            .filter(|node| node.kind == SyntaxKind::Path)
            .collect::<Vec<_>>();
        let [path] = paths.as_slice() else {
            return false;
        };
        let Some(text) = self.db.get(path.span.file).map(|file| file.text.as_str()) else {
            return false;
        };
        let segments = crate::analysis::path_segments(path, text);
        let [alias, operation] = segments.as_slice() else {
            return false;
        };
        if *operation != op.name
            || source.binding != format!("{}.{}", module.name, alias)
            || source.event != format!("{}.{}.{}.progressed", module.name, alias, operation)
        {
            return false;
        }
        let routes = module
            .imports
            .iter()
            .flat_map(|import| {
                import
                    .members
                    .iter()
                    .filter(|member| member.alias == *alias)
                    .map(move |member| (import, member))
            })
            .collect::<Vec<_>>();
        let [(import, member)] = routes.as_slice() else {
            return false;
        };
        if import.span != source.import_span
            || import.provider != "std"
            || import.from.as_deref() != Some(source.from.as_str())
            || std_capability(&member.name).is_none_or(|cap| cap.name != *capability)
        {
            return false;
        }
        let mut census = Vec::new();
        for (file, tree) in &self.trees {
            if *file != module.file {
                continue;
            }
            let mut pending = vec![tree];
            while let Some(node) = pending.pop() {
                let children = kids(node);
                pending.extend(children.into_iter().rev());
                if node.kind != SyntaxKind::Scenario
                    || node.span.start < module.span.start
                    || node.span.end > module.span.end
                {
                    continue;
                }
                let Some(on) = crate::analysis::attribute_value(node, "on", text) else {
                    continue;
                };
                if crate::analysis::path_segments(on, text) != [*alias, *operation, "progressed"] {
                    continue;
                }
                let Some(handler) = self.program.symbols.iter().find(|symbol| {
                    symbol.module == source.module
                        && matches!(symbol.kind, SymbolKind::Scenario { trusted: true, .. })
                        && symbol.span.file == node.span.file
                        && symbol.span.start >= node.span.start
                        && symbol.span.end <= node.span.end
                }) else {
                    return false;
                };
                let Some(data) = self.program.effects.scenarios.get(&handler.id) else {
                    return false;
                };
                if data.node != NodeKey::of(node)
                    || data.on_node != Some(NodeKey::of(on))
                    || data.cohort.is_some()
                    || !matches!(&data.on, Some(crate::analysis::effects::HandlerSource::DeliveryProgressed { source: event }) if event == &source.event)
                    || self
                        .program
                        .types
                        .delivery_progress_handlers
                        .get(&NodeKey::of(on))
                        != Some(&source.event)
                {
                    return false;
                }
                census.push((handler.id, NodeKey::of(on), handler.canonical.clone()));
            }
        }
        census == source.handlers
            && self.program.effects.scenarios.iter().filter(|(_, data)| data.module == source.module
                && matches!(&data.on, Some(crate::analysis::effects::HandlerSource::DeliveryProgressed { source: event }) if event == &source.event))
                .count() == census.len()
    }

    fn checked_callback_policy(
        &self,
        model: &crate::analysis::resolve::Symbol,
        policy: &PolicyRule,
        rule: &str,
    ) -> Option<Vec<CheckedCallbackGrant>> {
        if policy.module != model.module {
            return None;
        }
        let module = self.program.modules.get(model.module.0 as usize)?;
        let mut authored = Vec::new();
        for (file, tree) in &self.trees {
            if *file != module.file {
                continue;
            }
            let mut pending = vec![tree];
            while let Some(node) = pending.pop() {
                pending.extend(kids(node).into_iter().rev());
                if node.kind != SyntaxKind::Policy
                    || node.span.start < module.span.start
                    || node.span.end > module.span.end
                {
                    continue;
                }
                let Some(target) = kids(node)
                    .into_iter()
                    .find(|child| child.kind == SyntaxKind::Path)
                else {
                    continue;
                };
                if self
                    .resolve_member(model.module, &path_text(self.db, target))
                    .is_some_and(|(id, _)| id == model.id)
                {
                    authored.push(NodeKey::of(node));
                }
            }
        }
        if authored
            != self
                .program
                .effects
                .models
                .get(&model.id)?
                .policies
                .iter()
                .map(|policy| policy.node)
                .collect::<Vec<_>>()
        {
            return None;
        }
        let node = self.node(&policy.node)?;
        let text = self.db.get(node.span.file)?.text.as_str();
        let selectors = crate::analysis::attribute_value(node, "fields", text)?;
        if node.kind != SyntaxKind::Policy
            || policy.fields_node != Some(NodeKey::of(selectors))
            || policy.read != crate::analysis::attribute_value(node, "read", text).map(NodeKey::of)
            || policy.where_predicate
                != crate::analysis::attribute_value(node, "where", text).map(NodeKey::of)
        {
            return None;
        }
        let target = kids(node)
            .into_iter()
            .find(|child| child.kind == SyntaxKind::Path)?;
        if self
            .resolve_member(model.module, &path_text(self.db, target))?
            .0
            != model.id
        {
            return None;
        }
        let mut entries = Vec::new();
        let mut ordinary = Vec::new();
        for path in kids(selectors)
            .into_iter()
            .filter(|path| path.kind == SyntaxKind::Path)
        {
            let key = NodeKey::of(path);
            if let Some(observation) = self.program.types.callback_diagnostic_selectors().get(&key)
            {
                let field = self
                    .program
                    .symbols
                    .get(observation.source.field.0 as usize)?;
                if observation.node != key
                    || observation.source.model != model.id
                    || !observation.matches(self.program)
                    || !self.callback_source_matches(&observation.source)
                    || path_text(self.db, path) != observation.path
                    || observation.path != format!("{}.callback_diagnostics", field.name)
                {
                    return None;
                }
                entries.push(CheckedCallbackGrant {
                    source: observation.source.clone(),
                    selector: key,
                    policy: policy.node,
                    rule: rule.to_string(),
                    field: field.name.clone(),
                });
            } else {
                ordinary.push(
                    self.program
                        .types
                        .delivery_selectors
                        .get(&key)
                        .cloned()
                        .unwrap_or_else(|| path_text(self.db, path)),
                );
            }
        }
        let paths = entries
            .iter()
            .map(|entry| format!("{}.callback_diagnostics", entry.field))
            .collect::<Vec<_>>();
        if paths != policy.callback_fields || ordinary != policy.fields {
            return None;
        }
        Some(entries)
    }

    fn decode_callback_read(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        ty: &ResolvedType,
        observation: CheckedGenerationCallbackObservation,
    ) -> TypedExpr {
        let parts = kids(node);
        let receipt = parts.iter().find(|part| is_expression(part.kind)).copied();
        let Some(receipt) = receipt.filter(|part| part.kind == SyntaxKind::Member) else {
            return self.unsupported_expr(
                "generation callback diagnostics",
                "checked receipt source is unavailable",
                ty.clone(),
                node.span,
            );
        };
        let receipt_parts = kids(receipt);
        let record_node = receipt_parts
            .iter()
            .find(|part| is_expression(part.kind))
            .copied();
        let field = receipt_parts
            .iter()
            .rev()
            .find_map(|part| name_text(self.db, part))
            .unwrap_or_default();
        let Some(record_node) = record_node else {
            return self.unsupported_expr(
                "generation callback diagnostics",
                "checked record source is unavailable",
                ty.clone(),
                node.span,
            );
        };
        let record_type = self.node_type(record_node);
        if observation.node != NodeKey::of(node)
            || !observation.matches(self.program)
            || !self.callback_source_matches(&observation.source)
            || !matches!(record_type.nullable_inner().unwrap_or(&record_type), ResolvedType::Record { symbol, stored: true } if *symbol == observation.source.model)
            || parts
                .iter()
                .rev()
                .find_map(|part| name_text(self.db, part))
                .as_deref()
                != Some("callback_diagnostics")
            || observation.path != format!("{field}.callback_diagnostics")
            || self
                .program
                .symbols
                .get(observation.source.field.0 as usize)
                .is_none_or(|symbol| symbol.name != field)
        {
            return self.unsupported_expr(
                "generation callback diagnostics",
                "observation differs from its checked owning source",
                ty.clone(),
                node.span,
            );
        }
        let record = self.decode_expr(scope, record_node);
        let callback = CheckedGenerationCallbackRead {
            observation,
            record: format!("{record:?}"),
            ty: ty.clone(),
            span: node.span,
        };
        self.callback_sources
            .push(callback.observation.source.clone());
        self.callback_reads.push(format!("{callback:?}"));
        TypedExpr::new(
            IrExpr::DeliveryRead {
                record: Box::new(record),
                field,
                props: vec!["callback_diagnostics".to_string()],
                callback: Some(Box::new(callback)),
            },
            ty.clone(),
            node.span,
        )
    }

    fn seal_callback_grants(&mut self, ir: &IrProgram) -> CheckedCallbackGrants {
        if self.callback_entries.is_empty()
            && self.callback_reads.is_empty()
            && self.callback_value_lists.is_empty()
        {
            return CheckedCallbackGrants::default();
        }
        for source in &self.callback_sources {
            let field = ir.items.get(source.field.0 as usize);
            let model = ir.items.get(source.model.0 as usize);
            let source_module = ir.modules.get(source.module.0 as usize);
            let field_matches = field.is_some_and(|field| field.module == source.module
                && matches!(&field.kind, IrItemKind::Field { owner, ty: IrType::Known(ty), .. }
                    if *owner == source.model && self.program.types.symbol_types.get(&source.field) == Some(ty)));
            let handler_matches = source.handlers.iter().all(|(id, _, canonical)| {
                ir.items.get(id.0 as usize).is_some_and(|item| item.module == source.module && item.canonical == *canonical
                    && matches!(&item.kind, IrItemKind::Scenario { trusted: true, event_source: Some(IrEventSource::DeliveryProgressed(event)), hook: None, cohort: None, .. }
                        if event == &source.event))
            }) && ir.items.iter().filter(|item| item.module == source.module
                && matches!(&item.kind, IrItemKind::Scenario { event_source: Some(IrEventSource::DeliveryProgressed(event)), .. } if event == &source.event)).count() == source.handlers.len();
            if !field_matches
                || !handler_matches
                || source_module.is_none()
                || model.is_none_or(|model| {
                    model.module != source.module || !matches!(model.kind, IrItemKind::Model { .. })
                })
            {
                self.gap(
                    "protected callback owner differs from its original checked IR closure"
                        .to_string(),
                    field.map(|field| field.span).unwrap_or(source.import_span),
                );
                return CheckedCallbackGrants::default();
            }
        }
        CheckedCallbackGrants {
            entries: self.callback_entries.clone(),
            reads: self.callback_reads.clone(),
            value_lists: self.callback_value_lists.clone(),
            modules: ir
                .modules
                .iter()
                .map(|module| (module.id, callback_module_snapshot(ir, module.id)))
                .collect(),
            rules: Some(callback_rule_snapshot(ir)),
        }
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
        callback_read_rules: &mut Vec<IrRuleFn>,
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
                    if ordinary_read_policy(policy) {
                        read_rules.push(IrRuleFn {
                            id: format!(
                                "{}.read.{}",
                                model_rule_prefix(self.program, &symbol),
                                index + 1
                            ),
                            pred: pred.clone(),
                            span,
                            origin: None,
                        });
                    }
                    if !policy.callback_fields.is_empty() {
                        let id = format!(
                            "{}.callbackRead.{}",
                            model_rule_prefix(self.program, &symbol),
                            index + 1
                        );
                        if let Some(entries) = self.checked_callback_policy(&symbol, policy, &id) {
                            for entry in &entries {
                                self.callback_sources.push(entry.source.clone());
                            }
                            self.callback_entries.extend(entries);
                            callback_read_rules.push(IrRuleFn {
                                id,
                                pred,
                                span,
                                origin: None,
                            });
                        } else {
                            self.gap(format!("callback policy on {} does not match its original checked source", symbol.canonical), span);
                        }
                    }
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
                        id: format!(
                            "{}.require.{}",
                            model_rule_prefix(self.program, &symbol),
                            index + 1
                        ),
                        pred,
                        span,
                        origin: Some(IrModelRuleOrigin {
                            model: invariant.target,
                            module: invariant.module,
                            ordinal: invariant.id,
                            node: invariant.node,
                            span,
                            kind: IrModelRuleKind::Invariant,
                            registry_id: format!(
                                "{}.require.{}",
                                model_rule_prefix(self.program, &symbol),
                                index + 1
                            ),
                        }),
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
                        id: format!(
                            "{}.unique.{}",
                            model_rule_prefix(self.program, &symbol),
                            index + 1
                        ),
                        pred: self.decode_anchored(
                            &scope,
                            key,
                            &format!("unique constraint on {}", symbol.canonical),
                        ),
                        span,
                        origin: None,
                    });
                }
                for (index, lock) in data.locks.iter().enumerate() {
                    let span = Span::new(lock.node.file, lock.node.start, lock.node.end);
                    locks.push(IrLockFn {
                        id: format!(
                            "{}.lock.{}",
                            model_rule_prefix(self.program, &symbol),
                            index + 1
                        ),
                        fields: lock.fields.clone(),
                        when: lock.when.as_ref().map(|key| {
                            self.decode_anchored(
                                &scope,
                                key,
                                &format!("lock on {}", symbol.canonical),
                            )
                        }),
                        span,
                        origin: IrModelRuleOrigin {
                            model: symbol.id,
                            module: lock.module,
                            ordinal: lock.id,
                            node: lock.node,
                            span,
                            kind: IrModelRuleKind::Lock,
                            registry_id: format!(
                                "{}.lock.{}",
                                model_rule_prefix(self.program, &symbol),
                                index + 1
                            ),
                        },
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
                            name: model_rule_prefix(self.program, &symbol).to_string(),
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
    ///
    /// A bound capability whose owning checked declaration pins an integer
    /// `version=` is its own producer contract: bound imports resolve
    /// through the compiler-derived index and deployment binds the adapter
    /// from that versioned interface, so no lane-02 catalog entry exists to
    /// consult. Only an unversioned declaration keeps the `None` refusal.
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
                    let (availability, noun, versioned) = match symbol.as_ref().map(|s| &s.kind) {
                        Some(SymbolKind::Capability { .. }) => {
                            let data = self.program.effects.capabilities.get(&target);
                            (
                                data.and_then(|data| data.availability),
                                "capability",
                                data.and_then(|data| data.version),
                            )
                        }
                        Some(SymbolKind::CapabilityOp { .. }) => (
                            self.op_availability(target),
                            "capability operation",
                            self.capability_of_op(target).and_then(|data| data.version),
                        ),
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
                        // A checked versioned declaration is the producer
                        // contract; only an unversioned one cannot be pinned.
                        None if versioned.is_some() => {}
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

    /// Owning checked capability declaration of one capability operation.
    fn capability_of_op(&self, op: SymbolId) -> Option<&CapabilityData> {
        self.program
            .effects
            .capabilities
            .values()
            .find(|capability| capability.ops.iter().any(|data| data.op == op))
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
            source_lang: self.checked_message_source_lang(
                module,
                Span::new(entry.node.file, entry.node.start, entry.node.end),
            ),
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
        let source_lang = self.checked_message_source_lang(module, span);
        let scope = Scope::module(module);
        let node = self.node(&page.node).cloned();
        let title = page.title.as_ref().and_then(|key| {
            // Titles include checked references to zero-parameter messages.
            let title_node = self.node(key)?.clone();
            self.decode_message_node(module, &title_node)
        });
        let title = title.unwrap_or_else(|| {
            self.gap(
                "page title is not published in the analysis tables; emitting an empty caption"
                    .to_string(),
                span,
            );
            IrMessage {
                source: String::new(),
                source_lang: source_lang.clone(),
                variants: Vec::new(),
                params: Vec::new(),
            }
        });
        let description = self.owner_description(module, &page.node);
        let record_route = node
            .as_ref()
            .and_then(|node| self.decode_record_route(module, node));
        let (path, order, group, nav_none, poll, refresh) = node
            .as_ref()
            .map(|n| self.decode_page_head(module, n, record_route.is_some()))
            .unwrap_or_else(|| ("/".to_string(), None, None, false, None, None));
        let mut admit = Vec::new();
        let mut render = Vec::new();
        self.page_preference_fields.clear();
        if let Some(node) = node.as_ref() {
            for child in kids(node) {
                match child.kind {
                    SyntaxKind::Require => {
                        if let Some(pred) =
                            kids(child).iter().find(|n| is_expression(n.kind)).copied()
                        {
                            admit.push(if crate::analysis::scenario_disclosure::expression_reads_membership(
                                &self.program.types, &self.program.effects, NodeKey::of(pred)) {
                                IrGuard::Expr(self.decode_expr(&scope, pred))
                            } else { self.decode_guard_node(&scope, pred) });
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
                            admit.push(if crate::analysis::scenario_disclosure::expression_reads_membership(
                                &self.program.types, &self.program.effects, NodeKey::of(pred)) {
                                IrGuard::Expr(self.decode_expr(&scope, pred))
                            } else { self.decode_guard_node(&scope, pred) });
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
        bind_external_panel_triggers(&mut render);
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
            record_route,
            title,
            description,
            order,
            group,
            nav_none,
            poll,
            refresh,
            admit,
            preference_fields: std::mem::take(&mut self.page_preference_fields),
            render,
            fn_name,
            descriptor_name,
            span,
        }
    }

    fn decode_record_route(
        &mut self,
        module: ModuleId,
        page: &SyntaxNode,
    ) -> Option<IrRecordRoute> {
        let route = kids(page)
            .into_iter()
            .find(|part| part.kind == SyntaxKind::Route)?;
        let parts = kids(route);
        let records: Vec<_> = parts
            .iter()
            .filter(|part| part.kind == SyntaxKind::RouteRecord)
            .copied()
            .collect();
        if records.len() != 1
            || parts
                .iter()
                .any(|part| part.kind == SyntaxKind::RouteScalar)
        {
            return None;
        }
        let record = records[0];
        let Some(ResolvedType::Record {
            symbol,
            stored: true,
        }) = self.program.types.node_types.get(&NodeKey::of(record))
        else {
            self.gap(
                "record route lacks its checked stored Model association".into(),
                record.span,
            );
            return None;
        };
        if !matches!(
            self.program
                .symbols
                .get(symbol.0 as usize)
                .map(|symbol| &symbol.kind),
            Some(SymbolKind::Model { .. })
        ) {
            self.gap(
                "record route type does not name its owning Model declaration".into(),
                record.span,
            );
            return None;
        }
        let symbol = *symbol;
        let model = self.canonical(symbol);
        let path = kids(record)
            .into_iter()
            .find(|part| part.kind == SyntaxKind::Path)?;
        let source = self.db.get(path.span.file)?;
        let segments = crate::analysis::path_segments(path, &source.text);
        if segments.len() != 2
            || segments[1] != "id"
            || self.resolve_member(module, segments[0]).map(|(id, _)| id) != Some(symbol)
        {
            self.gap(
                "record route type disagrees with its checked owning declaration".into(),
                record.span,
            );
            return None;
        }
        Some(IrRecordRoute {
            model,
            token: self.text(path.span).to_string(),
        })
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
        record_route: bool,
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
                    path = self.decode_route(child, node.span, record_route);
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
                                .and_then(|v| opens_spelling(self.db, v))
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

    /// Static and checked singular record routes retain their authored token.
    /// Other dynamic profiles remain explicit lowering refusals.
    fn decode_route(&mut self, route: &SyntaxNode, span: Span, membership_record: bool) -> String {
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
        if dynamic && !membership_record {
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
            SyntaxKind::Show => self.decode_view_use(scope, node),
            SyntaxKind::Card => {
                let callback_scope = scope.callback_values.iter().any(|alias| {
                    scope.name_types.get(alias).is_some_and(|ty| {
                        matches!(
                            ty.nullable_inner().unwrap_or(ty),
                            ResolvedType::StdNominal {
                                name: "GenerationCallbackDiagnosticResult"
                                    | "GenerationCallbackDiagnosticComplete"
                                    | "GenerationCallbackDiagnosticUnsupported",
                                ..
                            }
                        )
                    })
                });
                let bare = !kids(node).into_iter().any(|child| {
                    is_expression(child.kind) || child.kind == SyntaxKind::MessageValue
                });
                if callback_scope
                    && bare
                    && ui_attributes(self.db, node).is_empty()
                    && kids(node)
                        .into_iter()
                        .any(|child| is_gate_leaf(self.db, child))
                {
                    let children = self.decode_ui_children(scope, node, row_ctx);
                    let gate = self.decode_gate(scope, node);
                    if gate
                        .as_ref()
                        .is_some_and(|predicate| predicate.ty == ResolvedType::Scalar(Scalar::Bool))
                    {
                        let ui = IrUi {
                            view: None,
                            factory: "callbackValueCard".to_string(),
                            props: Vec::new(),
                            children,
                            row_scope: None,
                            gate,
                            span: node.span,
                        };
                        self.callback_value_lists.push(format!("{ui:?}"));
                        return Some(ui);
                    }
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        "diagnostic display card requires its original checked boolean gate"
                            .to_string(),
                        node.span,
                    ));
                    return None;
                }
                self.check_ui_attributes(node, "card", &["layout"]);
                let mut props = Vec::new();
                if kids(node).into_iter().any(|child| {
                    is_expression(child.kind) || child.kind == SyntaxKind::MessageValue
                }) && let Some(caption) = self.decode_single_ui_caption(scope, node, "card")
                {
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
                    view: None,
                    factory: "card".to_string(),
                    props,
                    children: self.decode_ui_children(scope, node, row_ctx),
                    row_scope: None,
                    gate: self.decode_gate(scope, node),
                    span: node.span,
                })
            }
            SyntaxKind::Details => self.decode_disclosure(scope, node, "details", row_ctx),
            SyntaxKind::Form if matches!(word.as_str(), "primary" | "secondary") => {
                self.decode_contextual_actions(scope, node, row_ctx)
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
                let bound_target = kids(node)
                    .iter()
                    .find(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
                    .copied();
                let bound_panels =
                    bound_target.is_some() && kids(node).iter().any(|n| n.kind == SyntaxKind::Tab);
                if bound_panels && !self.validate_bound_panels(scope, node) {
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
                let mut bound_options = None;
                if let Some(target) = bound_target {
                    let (binding, caption) = self.decode_bound_tabs(scope, target)?;
                    if bound_panels {
                        bound_options = Some(binding.clone());
                    }
                    props.push(("binding".to_string(), binding));
                    if let Some(caption) = caption {
                        props.push(("caption".to_string(), caption));
                    }
                }
                let children = if let Some(binding) = bound_options {
                    self.decode_bound_panels(scope, node, &binding, row_ctx.clone())?
                } else {
                    kids(node)
                        .iter()
                        .filter(|child| child.kind == SyntaxKind::Tab)
                        .enumerate()
                        .map(|(ordinal, child)| {
                            self.decode_transient_tab(scope, child, ordinal, row_ctx.clone())
                        })
                        .collect()
                };
                let gate = self.decode_gate(scope, node);
                Some(IrUi {
                    view: None,
                    factory: "tabs".to_string(),
                    props,
                    children,
                    row_scope: None,
                    gate,
                    span: node.span,
                })
            }
            SyntaxKind::Edit => self.decode_bound_edit(scope, node, row_ctx),
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
        let value = if node.kind == SyntaxKind::MessageValue
            && let Some(message) = self.decode_message_node(scope.module, node)
        {
            TypedExpr::new(
                IrExpr::Message(message),
                ResolvedType::InlineMessage,
                node.span,
            )
        } else {
            self.decode_expr(scope, node)
        };
        self.check_ui_message_parameter_profile(node, &value);
        value
    }

    /// UI and Values own different parameter profiles. Check only the owning
    /// schema here; descriptor construction and captured argument reads remain
    /// in their original expression and evaluation order.
    fn check_ui_message_parameter_profile(&mut self, node: &SyntaxNode, value: &TypedExpr) {
        let problem = match value.ty.nullable_inner().unwrap_or(&value.ty) {
            ResolvedType::Message(id) => match self.program.effects.messages.get(id) {
                Some(message) => message.params.iter().find_map(|param| {
                    match self.program.types.symbol_types.get(&param.param) {
                        Some(ty) => {
                            matches!(ty, ResolvedType::Enum { owner: None, .. }).then(|| {
                                format!(
                                    "message parameter '{}' uses unsupported UI type {}",
                                    self.local_name(param.param),
                                    self.type_id(ty)
                                )
                            })
                        }
                        None => Some(format!(
                            "message parameter '{}' has no checked UI type",
                            self.local_name(param.param)
                        )),
                    }
                }),
                None => Some("named message has no checked UI parameter schema".to_string()),
            },
            ResolvedType::InlineMessage => {
                let mut reference = node;
                while reference.kind == SyntaxKind::Group {
                    let Some(inner) = kids(reference).into_iter().find(|n| is_expression(n.kind))
                    else {
                        break;
                    };
                    reference = inner;
                }
                let key = NodeKey::of(reference);
                let origin = self
                    .program
                    .types
                    .message_descriptor_references
                    .get(&key)
                    .copied()
                    .unwrap_or(key);
                if let Some(binding) = self.program.types.anonymous_messages.get(&origin) {
                    binding.arguments.iter().find_map(|(name, _, ty)| {
                        matches!(ty, ResolvedType::Enum { owner: None, .. }).then(|| {
                            format!(
                                "message parameter '{name}' uses unsupported UI type {}",
                                self.type_id(ty)
                            )
                        })
                    })
                } else if self
                    .node(&origin)
                    .is_some_and(|node| node.kind == SyntaxKind::MessageValue)
                {
                    None
                } else {
                    Some("inline message has no checked UI parameter schema".to_string())
                }
            }
            _ => None,
        };
        if let Some(problem) = problem {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot render UI descriptor: {problem}"),
                node.span,
            ));
        }
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
        self.check_ui_message_parameter_profile(header, &value);
        if let ResolvedType::Message(id) = &value.ty
            && self
                .program
                .effects
                .messages
                .get(id)
                .is_some_and(|message| !message.params.is_empty())
        {
            // Immutable aliases retain the checked initializer anchor. Inspect
            // a bare origin's IR only to classify its binding; never emit or
            // reevaluate that origin in place of the captured caption value.
            let mut reference = *header;
            while reference.kind == SyntaxKind::Group {
                let Some(inner) = kids(reference).into_iter().find(|n| is_expression(n.kind))
                else {
                    break;
                };
                reference = inner;
            }
            let bare_origin = self
                .program
                .types
                .message_descriptor_references
                .get(&NodeKey::of(reference))
                .and_then(|key| self.node(key))
                .filter(|node| matches!(node.kind, SyntaxKind::NameRef | SyntaxKind::Path))
                .cloned();
            let unbound = if let Some(origin) = bare_origin {
                matches!(self.decode_expr(scope, &origin).expr, IrExpr::Message(message) if message.params.is_empty())
            } else {
                matches!(&value.expr, IrExpr::Message(message) if message.params.is_empty())
            };
            if unbound {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    format!("cannot lower {word}: parameterized message caption needs a checked call binding"),
                    header.span,
                ));
                return None;
            }
        }
        if !matches!(
            value.ty,
            ResolvedType::Scalar(Scalar::Text)
                | ResolvedType::InlineMessage
                | ResolvedType::Message(_)
        ) {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower {word}: caption has no checked text profile"),
                header.span,
            ));
            return None;
        }
        Some(value)
    }

    /// Join the private source correspondence before decoding editable tables.
    fn validate_bound_panels(&mut self, scope: &Scope, node: &SyntaxNode) -> bool {
        let valid = self
            .program
            .types
            .bound_tabs(&NodeKey::of(node))
            .is_some_and(|fact| {
                if fact.module != scope.module || !fact.matches(self.program) {
                    return false;
                }
                let tabs: Vec<_> = kids(node)
                    .into_iter()
                    .filter(|child| child.kind == SyntaxKind::Tab)
                    .collect();
                if tabs.len() != fact.panels.len() {
                    return false;
                }
                tabs.iter()
                    .zip(&fact.panels)
                    .all(|(tab, (original, header, value))| {
                        if NodeKey::of(tab) != *original {
                            return false;
                        }
                        let Some(mut authored) = kids(tab)
                            .into_iter()
                            .find(|child| is_expression(child.kind))
                        else {
                            return false;
                        };
                        while authored.kind == SyntaxKind::Group {
                            let Some(inner) = kids(authored)
                                .into_iter()
                                .find(|child| is_expression(child.kind))
                            else {
                                return false;
                            };
                            authored = inner;
                        }
                        authored.kind == SyntaxKind::NameRef
                            && NodeKey::of(authored) == *header
                            && kids(authored)
                                .iter()
                                .find_map(|child| name_text(self.db, child))
                                .as_deref()
                                == Some(value.as_str())
                    })
            });
        if !valid {
            self.diags.push(Diagnostic::error(
                "E6008",
                "bound tab panels have no matching original checked selector/header correspondence"
                    .to_string(),
                node.span,
            ));
            return false;
        }
        if kids(node)
            .into_iter()
            .filter(|child| child.kind == SyntaxKind::Tab)
            .any(|tab| {
                kids(tab)
                    .into_iter()
                    .any(|child| is_gate_leaf(self.db, child))
            })
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower bound tabs with a direct tab gate".to_string(),
                node.span,
            ));
            return false;
        }
        true
    }

    fn decode_bound_panels(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        binding: &TypedExpr,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<Vec<IrUi>> {
        let fact = self.program.types.bound_tabs(&NodeKey::of(node))?.clone();
        let options =
            match &binding.expr {
                IrExpr::Object(fields) => fields
                    .iter()
                    .find(|(name, _)| name == "options")
                    .and_then(|(_, value)| {
                        if let IrExpr::Array(options) = &value.expr {
                            Some(options)
                        } else {
                            None
                        }
                    }),
                _ => None,
            };
        let ResolvedType::Enum { cases, .. } = &fact.ty else {
            return None;
        };
        let Some(options) = options.filter(|options| options.len() == cases.len()) else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "bound tab options do not match their original checked enum".to_string(),
                node.span,
            ));
            return None;
        };
        let mut captions = std::collections::HashMap::new();
        for (option, case) in options.iter().zip(cases) {
            let IrExpr::Object(fields) = &option.expr else {
                return None;
            };
            let value = fields
                .iter()
                .find(|(key, _)| key == "value")
                .map(|(_, value)| &value.expr);
            let caption = fields
                .iter()
                .find(|(key, _)| key == "label")
                .map(|(_, value)| value.clone());
            if !matches!(value, Some(IrExpr::Text(value)) if value == case) || caption.is_none() {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "bound tab options do not match their original checked enum".to_string(),
                    node.span,
                ));
                return None;
            }
            captions.insert(case.clone(), caption.expect("checked option caption"));
        }
        let mut panels = Vec::new();
        for (tab, (_, _, case)) in kids(node)
            .into_iter()
            .filter(|child| child.kind == SyntaxKind::Tab)
            .zip(&fact.panels)
        {
            self.check_ui_attributes(tab, "tab", &[]);
            let caption = captions.get(case)?.clone();
            panels.push(IrUi {
                view: None,
                factory: "tabItem".to_string(),
                props: vec![
                    (
                        "value".to_string(),
                        TypedExpr::new(
                            IrExpr::Text(case.clone()),
                            ResolvedType::Scalar(Scalar::Text),
                            tab.span,
                        ),
                    ),
                    ("caption".to_string(), caption),
                ],
                children: self.decode_ui_children(scope, tab, row_ctx.clone()),
                row_scope: None,
                gate: None,
                span: tab.span,
            });
        }
        Some(panels)
    }

    /// Existing owned preference binding shared by selector leaves and panels.
    fn decode_bound_tabs(
        &mut self,
        scope: &Scope,
        target: &SyntaxNode,
    ) -> Option<(TypedExpr, Option<TypedExpr>)> {
        let current = self.decode_expr(scope, target);
        let cases = match &current.ty {
            ResolvedType::Enum {
                cases,
                owner: Some(_),
            } => cases.clone(),
            _ => {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "bound tabs needs a checked owned enum preference".to_string(),
                    target.span,
                ));
                return None;
            }
        };
        let mut identity_target = target;
        while identity_target.kind == SyntaxKind::Group {
            let Some(inner) = kids(identity_target)
                .into_iter()
                .find(|node| is_expression(node.kind))
            else {
                break;
            };
            identity_target = inner;
        }
        let Some(field_id) = self
            .program
            .types
            .preference_field_references
            .get(&NodeKey::of(identity_target))
            .copied()
        else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "bound tabs field has no checked preference identity".to_string(),
                target.span,
            ));
            return None;
        };
        let IrExpr::Member { base, field } = &current.expr else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "bound tabs needs a direct preferences field".to_string(),
                target.span,
            ));
            return None;
        };
        if !matches!(&base.expr, IrExpr::Name(name) if name == "preferences") {
            self.diags.push(Diagnostic::error(
                "E6008",
                "bound tabs needs a direct preferences field".to_string(),
                target.span,
            ));
            return None;
        }
        let Some(symbol) = self.program.symbols.get(field_id.0 as usize).cloned() else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "bound tabs field has no checked declaration".to_string(),
                target.span,
            ));
            return None;
        };
        let SymbolKind::Field { owner, .. } = &symbol.kind else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "bound tabs field has no preference owner".to_string(),
                target.span,
            ));
            return None;
        };
        if symbol.module != scope.module
            || symbol.name != *field
            || !matches!(
                self.program
                    .symbols
                    .get(owner.0 as usize)
                    .map(|item| &item.kind),
                Some(SymbolKind::Preferences { .. })
            )
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "bound tabs field has no local preference owner".to_string(),
                target.span,
            ));
            return None;
        }
        let (_, default, _, _, _, _) = self.decode_field(&symbol, *owner);
        let label = self.decode_reused_field_label_parts(&symbol);
        let Some(IrDefault::Literal(default)) = default else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "bound tabs preference needs a literal enum default".to_string(),
                target.span,
            ));
            return None;
        };
        let IrExpr::Text(default_value) = default.expr else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "bound tabs preference default must be an enum case".to_string(),
                target.span,
            ));
            return None;
        };
        if cases.is_empty() || !cases.contains(&default_value) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "bound tabs preference default is not a listed case".to_string(),
                target.span,
            ));
            return None;
        }
        if !self
            .page_preference_fields
            .iter()
            .any(|item| item.name == symbol.name)
        {
            self.page_preference_fields.push(IrPreferenceField {
                name: symbol.name.clone(),
                options: cases.clone(),
                default_value: Some(default_value),
                nullable: false,
                caption: label.as_ref().and_then(|label| label.text.clone()),
                option_labels: label
                    .as_ref()
                    .map(|label| label.values.clone())
                    .unwrap_or_default(),
                reference: false,
            });
        }
        let text = |value: String| {
            TypedExpr::new(
                IrExpr::Text(value),
                ResolvedType::Scalar(Scalar::Text),
                target.span,
            )
        };
        let options = cases
            .into_iter()
            .map(|case| {
                let caption = label
                    .as_ref()
                    .and_then(|label| label.values.iter().find(|(value, _)| value == &case))
                    .map(|(_, caption)| {
                        TypedExpr::new(
                            IrExpr::Message(caption.clone()),
                            ResolvedType::Scalar(Scalar::Text),
                            target.span,
                        )
                    })
                    .unwrap_or_else(|| text(case.clone()));
                TypedExpr::new(
                    IrExpr::Object(vec![
                        ("value".to_string(), text(case)),
                        ("label".to_string(), caption),
                    ]),
                    ResolvedType::Unknown,
                    target.span,
                )
            })
            .collect();
        let ctx = TypedExpr::new(
            IrExpr::Name("c".to_string()),
            ResolvedType::Unknown,
            target.span,
        );
        let member = |base: TypedExpr, field: String| {
            TypedExpr::new(
                IrExpr::Member {
                    base: Box::new(base),
                    field,
                },
                ResolvedType::Unknown,
                target.span,
            )
        };
        let module_name = self
            .program
            .modules
            .iter()
            .find(|module| module.id == scope.module)?
            .name
            .clone();
        let version = member(
            member(
                member(ctx.clone(), "preferenceVersions".to_string()),
                module_name,
            ),
            symbol.name.clone(),
        );
        let post_to = TypedExpr::new(
            IrExpr::Binary {
                op: IrBinOp::Coalesce,
                left: Box::new(member(ctx.clone(), "pollUrl".to_string())),
                right: Box::new(member(ctx, "path".to_string())),
            },
            ResolvedType::Scalar(Scalar::Text),
            target.span,
        );
        let binding = TypedExpr::new(
            IrExpr::Object(vec![
                ("name".to_string(), text(symbol.name.clone())),
                (
                    "options".to_string(),
                    TypedExpr::new(IrExpr::Array(options), ResolvedType::Unknown, target.span),
                ),
                ("current".to_string(), current),
                ("version".to_string(), version),
                ("postTo".to_string(), post_to),
            ]),
            ResolvedType::Unknown,
            target.span,
        );
        let caption = label.and_then(|label| label.text);
        let caption = caption.map(|caption| {
            TypedExpr::new(
                IrExpr::Message(caption),
                ResolvedType::Scalar(Scalar::Text),
                target.span,
            )
        });
        Some((binding, caption))
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
            view: None,
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

    /// Both authored disclosure spellings share the existing Details contract.
    fn decode_disclosure(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        word: &str,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        if word == "details"
            && ui_attributes(self.db, node)
                .iter()
                .any(|(name, _)| name == "display")
        {
            return self.decode_details_drawer(scope, node, row_ctx);
        }
        self.check_ui_attributes(node, word, &["open", "id"]);
        if kids(node)
            .into_iter()
            .any(|child| child.kind == SyntaxKind::Slot)
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower {word}: disclosure content does not admit authored slots"),
                node.span,
            ));
            return None;
        }
        let mut props = Vec::new();
        if let Some(caption) = self.decode_single_ui_caption(scope, node, word) {
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
                format!("cannot lower {word}: collapse needs a nonempty content suite"),
                node.span,
            ));
        }
        Some(IrUi {
            view: None,
            factory: "collapse".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    /// Decode a slotted group with a closed slot schema (`dropdown`,
    /// `diff`): no header, no attributes, exactly the required slots once
    /// each, no other children. Slots dissolve into named props at emission.
    fn decode_slotted_group(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
        word: &str,
        required: &[&str],
        optional: &[&str],
    ) -> Option<IrUi> {
        self.decode_slotted_group_inner(scope, node, row_ctx, word, required, optional, false)
    }

    /// Shared slotted-group shape; `header` permits the caller-decoded
    /// selection header (`swap` selects on a bool).
    fn decode_slotted_group_inner(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
        word: &str,
        required: &[&str],
        optional: &[&str],
        header: bool,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, word, &[]);
        if !header
            && kids(node)
                .into_iter()
                .any(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower {word}: {word} takes no header"),
                node.span,
            ));
            return None;
        }
        if !ui_attributes(self.db, node).is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower {word}: {word} takes no options"),
                node.span,
            ));
            return None;
        }
        let mut seen: Vec<String> = Vec::new();
        for child in kids(node).into_iter().filter(|n| is_ui_node(n.kind)) {
            if child.kind != SyntaxKind::Slot {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    format!("cannot lower {word}: {word} takes only its named slots"),
                    child.span,
                ));
                return None;
            }
            match slot_name(self.db, child) {
                Some(name)
                    if (required.contains(&name.as_str())
                        || optional.contains(&name.as_str()))
                        && !seen.contains(&name) =>
                {
                    seen.push(name)
                }
                _ => {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        format!("cannot lower {word}: {word} takes only its named slots"),
                        child.span,
                    ));
                    return None;
                }
            }
        }
        for slot in required {
            if !seen.iter().any(|name| name == slot) {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    format!("cannot lower {word}: {word} needs its {slot} slot"),
                    node.span,
                ));
                return None;
            }
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        Some(IrUi {
            view: None,
            factory: word.to_string(),
            props: Vec::new(),
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    /// Decode a `swap`: one bool header selecting the `off`/`on` slots.
    fn decode_swap(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        let headers: Vec<&SyntaxNode> = kids(node)
            .into_iter()
            .filter(|n| is_expression(n.kind))
            .collect();
        let [header] = headers.as_slice() else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower swap: swap takes one bool header".to_string(),
                node.span,
            ));
            return None;
        };
        let state = self.decode_expr(scope, header);
        if state.ty != ResolvedType::Scalar(Scalar::Bool) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower swap: swap selects on a bool".to_string(),
                header.span,
            ));
            return None;
        }
        let mut group = self.decode_slotted_group_inner(scope, node, row_ctx, "swap", &["off", "on"], &[], true)?;
        group.props.push(("active".to_string(), state));
        Some(group)
    }

    /// Decode `steps`: one or more `item` slots, each a single text stage.
    /// Stages carry labels only (tones/markers have no source spelling).
    fn decode_steps(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, "steps", &[]);
        if kids(node)
            .into_iter()
            .any(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower steps: steps take no header".to_string(),
                node.span,
            ));
            return None;
        }
        if !ui_attributes(self.db, node).is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower steps: steps take no options".to_string(),
                node.span,
            ));
            return None;
        }
        let slots: Vec<&SyntaxNode> = kids(node)
            .into_iter()
            .filter(|n| {
                n.kind == SyntaxKind::Slot && slot_name(self.db, n).as_deref() == Some("item")
            })
            .collect();
        if slots.is_empty()
            || kids(node)
                .into_iter()
                .filter(|n| is_ui_node(n.kind))
                .any(|n| n.kind != SyntaxKind::Slot || slot_name(self.db, n).as_deref() != Some("item"))
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower steps: steps take one or more item slots".to_string(),
                node.span,
            ));
            return None;
        }
        let mut items = Vec::new();
        for slot in slots {
            let texts: Vec<&SyntaxNode> = kids(slot)
                .into_iter()
                .filter(|n| {
                    (n.kind == SyntaxKind::UiLeaf && ui_word(self.db, n) == "text")
                        || ((n.kind == SyntaxKind::UiLeaf || n.kind == SyntaxKind::CatalogItem)
                            && ui_word(self.db, n) == "status")
                        || n.kind == SyntaxKind::MessageValue
                })
                .collect();
            if texts.len() != 1 {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower steps: each item slot takes one text stage".to_string(),
                    slot.span,
                ));
                return None;
            }
            let label = if texts[0].kind == SyntaxKind::MessageValue {
                self.decode_ui_header_value(scope, texts[0])
            } else if ui_word(self.db, texts[0]) == "status" {
                // A recorded lifecycle stage shows its live flag beside the
                // frozen record: the owning status profile supplies the
                // text-bearing value, with no stage options or suite.
                if !ui_attributes(self.db, texts[0]).is_empty() {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        "cannot lower steps: each item slot takes one text stage".to_string(),
                        texts[0].span,
                    ));
                    return None;
                }
                let Some(stage) = self.decode_status(scope, texts[0], row_ctx.clone()) else {
                    return None;
                };
                if stage.gate.is_some() {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        "cannot lower steps: each item slot takes one text stage".to_string(),
                        texts[0].span,
                    ));
                    return None;
                }
                let Some((_, value)) = stage.props.into_iter().find(|(key, _)| key == "value") else {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        "cannot lower steps: each item slot takes one text stage".to_string(),
                        texts[0].span,
                    ));
                    return None;
                };
                value
            } else {
                let headers: Vec<&SyntaxNode> = kids(texts[0])
                    .into_iter()
                    .filter(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
                    .collect();
                if headers.len() != 1 {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        "cannot lower steps: each item slot takes one text stage".to_string(),
                        texts[0].span,
                    ));
                    return None;
                }
                self.decode_ui_header_value(scope, headers[0])
            };
            items.push(TypedExpr::new(
                IrExpr::Object(vec![("label".to_string(), label)]),
                ResolvedType::Unknown,
                slot.span,
            ));
        }
        Some(IrUi {
            view: None,
            factory: "steps".to_string(),
            props: vec![(
                "items".to_string(),
                TypedExpr::new(IrExpr::Array(items), ResolvedType::Unknown, node.span),
            )],
            children: Vec::new(),
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    /// Decode an `accordion`: a suite of collapse children only.
    fn decode_accordion(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, "accordion", &[]);
        if kids(node)
            .into_iter()
            .any(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower accordion: accordion takes no header".to_string(),
                node.span,
            ));
            return None;
        }
        if !ui_attributes(self.db, node).is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower accordion: accordion takes no options".to_string(),
                node.span,
            ));
            return None;
        }
        if kids(node).into_iter().filter(|n| is_ui_node(n.kind)).any(|n| {
            n.kind != SyntaxKind::CatalogItem || ui_word(self.db, n) != "collapse"
        }) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower accordion: accordion takes collapse children only".to_string(),
                node.span,
            ));
            return None;
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        if children.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower accordion: accordion takes collapse children only".to_string(),
                node.span,
            ));
            return None;
        }
        Some(IrUi {
            view: None,
            factory: "accordion".to_string(),
            props: Vec::new(),
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    /// Decode a `countdown`: one numeric header (view-only remaining time)
    /// with an optional caption for its accessible name.
    fn decode_countdown(&mut self, scope: &Scope, node: &SyntaxNode) -> Option<IrUi> {
        self.check_ui_attributes(node, "countdown", &["caption"]);
        let headers: Vec<&SyntaxNode> = kids(node)
            .into_iter()
            .filter(|n| is_expression(n.kind))
            .collect();
        let [header] = headers.as_slice() else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower countdown: countdown takes one numeric header".to_string(),
                node.span,
            ));
            return None;
        };
        let mut props = Vec::new();
        for (name, value) in ui_attributes(self.db, node) {
            if name != "caption" {
                continue;
            }
            let Some(value) = value else {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower countdown: countdown caption takes a value".to_string(),
                    node.span,
                ));
                return None;
            };
            props.push(("caption".to_string(), self.decode_ui_header_value(scope, value)));
        }
        if kids(node).into_iter().any(|n| is_ui_node(n.kind)) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower countdown: countdown takes no content suite".to_string(),
                node.span,
            ));
            return None;
        }
        let value = self.decode_expr(scope, header);
        if !matches!(
            value.ty.nullable_inner().unwrap_or(&value.ty),
            ResolvedType::Scalar(Scalar::Int | Scalar::Decimal | Scalar::Duration)
        ) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower countdown: countdown takes a numeric header".to_string(),
                header.span,
            ));
            return None;
        }
        props.push(("value".to_string(), value));
        Some(IrUi {
            view: None,
            factory: "countdown".to_string(),
            props,
            children: Vec::new(),
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    /// Decode a `radial_progress`: one integer header with a required max,
    /// sharing the progress value contract in circular presentation.
    fn decode_radial_progress(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, "radial_progress", &["max"]);
        let headers: Vec<&SyntaxNode> = kids(node)
            .into_iter()
            .filter(|n| is_expression(n.kind))
            .collect();
        let maxima: Vec<(String, Option<&SyntaxNode>)> = ui_attributes(self.db, node)
            .into_iter()
            .filter(|(name, _)| name == "max")
            .collect();
        let ([header], [(_, Some(maximum))]) = (headers.as_slice(), maxima.as_slice()) else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower radial_progress: radial_progress needs one integer value and one explicit max".to_string(),
                node.span,
            ));
            return None;
        };
        let value = self.decode_expr(scope, header);
        let maximum = self.decode_expr(scope, maximum);
        // Progress renders a number: an int, or a decimal fraction such as
        // the recorded completion percentage. The explicit max stays an
        // int; other types keep the refusal below.
        let numeric = matches!(
            value.ty.nullable_inner().unwrap_or(&value.ty),
            ResolvedType::Scalar(Scalar::Int | Scalar::Decimal)
        );
        if !numeric
            || maximum.ty != ResolvedType::Scalar(Scalar::Int)
            || !self.decode_ui_children(scope, node, row_ctx).is_empty()
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower radial_progress: radial_progress needs body-free compatible integer values".to_string(),
                node.span,
            ));
            return None;
        }
        Some(IrUi {
            view: None,
            factory: "radialProgress".to_string(),
            props: vec![("value".into(), value), ("max".into(), maximum)],
            children: Vec::new(),
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    /// Original record details use the released activated-body contract.
    /// A selector conveys no grant: only the enclosing queried RowView owns
    /// this body and its current row/parent aliases.
    fn decode_details_drawer(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, "details drawer", &["display"]);
        let attributes = ui_attributes(self.db, node);
        let owning = row_ctx.filter(|(model, row)| {
            !scope.in_field_owner
                && matches!(
                    self.program
                        .symbols
                        .get(model.0 as usize)
                        .map(|symbol| &symbol.kind),
                    Some(SymbolKind::Model { .. })
                )
                && scope.name_types.get(row)
                    == Some(&ResolvedType::Record {
                        symbol: *model,
                        stored: true,
                    })
                && scope.row_rewrite.get(row) == Some(row)
        });
        if owning.is_none()
            || attributes.len() != 1
            || !attributes.iter().all(|(name, value)| {
                name == "display"
                    && value.is_some_and(|value| display_text(self.db, value) == "drawer")
            })
            || kids(node)
                .into_iter()
                .any(|child| child.kind == SyntaxKind::Slot)
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower details drawer: needs an owning queried record, only display=drawer and an ordinary body".to_string(),
                node.span,
            ));
            return None;
        }
        let (model, row) = owning?;
        let caption = self.decode_single_ui_caption(scope, node, "details drawer")?;
        let children = self.decode_ui_children(scope, node, Some((model, row.clone())));
        if children.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower details drawer: needs a nonempty body".to_string(),
                node.span,
            ));
            return None;
        }
        Some(IrUi {
            view: None,
            factory: "detailsDrawer".to_string(),
            props: vec![
                ("caption".to_string(), caption),
                (
                    "model".to_string(),
                    TypedExpr::new(
                        IrExpr::Text(self.canonical(model)),
                        ResolvedType::Scalar(Scalar::Text),
                        node.span,
                    ),
                ),
                (
                    "record".to_string(),
                    TypedExpr::new(
                        IrExpr::Name(row),
                        ResolvedType::Record {
                            symbol: model,
                            stored: true,
                        },
                        node.span,
                    ),
                ),
            ],
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
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
            "label" | "validator" => self.decode_field_fragment(scope, node, word),
            "checkbox" => self.decode_bool_checkbox(scope, node, row_ctx),
            "toggle" => self.decode_bool_control(scope, node, "toggle", row_ctx),
            "range" | "file_input" => self.decode_owned_control(scope, node, word, row_ctx),
            "progress" => self.decode_integer_progress(scope, node, row_ctx),
            "loading" => self.decode_loading(scope, node),
            "tooltip" => self.decode_tooltip(scope, node, row_ctx),
            "calendar"
                if ui_attributes(self.db, node)
                    .iter()
                    .any(|(name, _)| matches!(name.as_str(), "start" | "end")) =>
            {
                self.decode_collection(scope, node, word)
            }
            // A bound timeline renders its bound sequence through the shared
            // collection pipeline: one sequence header, an optional order,
            // and exactly one item template. The owning UI factory serves
            // this collection mode (model/query/renderRow); the former
            // items-only factory gap (REVIEW-21) is closed by the timeline
            // collection adapter, so the shape lowers instead of refusing.
            "timeline" => self.decode_collection(scope, node, word),
            "calendar" => self.decode_date_calendar(scope, node, row_ctx),
            "collapse" => self.decode_disclosure(scope, node, word, row_ctx),
            "dropdown" => self.decode_slotted_group(scope, node, row_ctx, "dropdown", &["trigger", "content"], &[]),
            "filter" => self.decode_standalone_filter(scope, node, word),
            "indicator" => self.decode_slotted_group(scope, node, row_ctx, "indicator", &["content", "indicator"], &[]),
            "swap" => self.decode_swap(scope, node, row_ctx),
            "diff" => self.decode_slotted_group(scope, node, row_ctx, "diff", &["before", "after"], &[]),
            "steps" => self.decode_steps(scope, node, row_ctx),
            "accordion" => self.decode_accordion(scope, node, row_ctx),
            "countdown" => self.decode_countdown(scope, node),
            "radial_progress" => self.decode_radial_progress(scope, node, row_ctx),
            "hero" => self.decode_compact_hero(scope, node, row_ctx),
            "footer" => self.decode_compact_footer(scope, node, row_ctx),
            "fieldset" => Some(self.decode_fieldset(scope, node, row_ctx)),
            "fab" => Some(self.decode_fab(scope, node, row_ctx)),
            "chat_bubble" => Some(self.decode_chat_bubble(scope, node, row_ctx)),
            "button"
                if ui_attributes(self.db, node)
                    .iter()
                    .any(|(name, _)| name == "action") =>
            {
                self.decode_action_button(scope, node, row_ctx)
            }
            "button" => Some(self.decode_button(scope, node, row_ctx)),
            "link" => Some(self.decode_link(scope, node, row_ctx)),
            "modal" | "drawer" => Some(self.decode_modal(scope, node, word, row_ctx)),
            "divider" => Some(self.decode_divider(scope, node, row_ctx)),
            "badge" => Some(self.decode_badge(scope, node, row_ctx)),
            "status" => self.decode_status(scope, node, row_ctx),
            "breadcrumbs" => Some(self.decode_breadcrumbs(scope, node, row_ctx)),
            "pagination" => Some(self.decode_pagination(scope, node, row_ctx)),
            "stat" => self.decode_stat(scope, node, row_ctx),
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

    /// Released integer progress is a presentation conversion, never a
    /// business arithmetic or settlement operation. Null stays unavailable.
    fn decode_integer_progress(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, "progress", &["max"]);
        let headers: Vec<_> = kids(node)
            .into_iter()
            .filter(|n| is_expression(n.kind))
            .collect();
        let attributes = ui_attributes(self.db, node);
        let maxima: Vec<_> = attributes
            .iter()
            .filter(|(name, _)| name == "max")
            .collect();
        let ([header], [(_, Some(maximum))]) = (headers.as_slice(), maxima.as_slice()) else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower progress: needs one integer value and one explicit max".to_string(),
                node.span,
            ));
            return None;
        };
        let value = self.decode_expr(scope, header);
        let maximum = self.decode_expr(scope, maximum);
        if value.ty.nullable_inner().unwrap_or(&value.ty) != &ResolvedType::Scalar(Scalar::Int)
            || maximum.ty != ResolvedType::Scalar(Scalar::Int)
            || !self.decode_ui_children(scope, node, row_ctx).is_empty()
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower progress: needs body-free compatible integer values".to_string(),
                node.span,
            ));
            return None;
        }
        Some(IrUi {
            view: None,
            factory: "progress".into(),
            props: vec![("value".into(), value), ("max".into(), maximum)],
            children: Vec::new(),
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    /// A readable bool selects actual loading feedback; omission is an
    /// authored placeholder. Neither form implies provider progress.
    fn decode_loading(&mut self, scope: &Scope, node: &SyntaxNode) -> Option<IrUi> {
        self.check_ui_attributes(node, "loading", &[]);
        let headers: Vec<_> = kids(node)
            .into_iter()
            .filter(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
            .collect();
        let mut gate = self.decode_gate(scope, node);
        match headers.as_slice() {
            [] => {}
            [header] => {
                let state = self.decode_expr(scope, header);
                if state.ty != ResolvedType::Scalar(Scalar::Bool) {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        "cannot lower loading: state needs a checked boolean".to_string(),
                        header.span,
                    ));
                    return None;
                }
                gate = Some(match gate {
                    Some(guard) => TypedExpr::new(
                        IrExpr::Binary {
                            op: IrBinOp::And,
                            left: Box::new(guard),
                            right: Box::new(state),
                        },
                        ResolvedType::Scalar(Scalar::Bool),
                        node.span,
                    ),
                    None => state,
                });
            }
            _ => {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower loading: takes at most one readable state".to_string(),
                    node.span,
                ));
                return None;
            }
        }
        if kids(node)
            .into_iter()
            .any(|n| is_ui_node(n.kind) && !is_gate_leaf(self.db, n))
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower loading: takes no content suite".to_string(),
                node.span,
            ));
            return None;
        }
        let message = IrMessage {
            source: "Loading".into(),
            variants: vec![("nl".into(), Some("Laden".into()))],
            params: Vec::new(),
            source_lang: "en".into(),
        };
        Some(IrUi {
            view: None,
            factory: "renderState".into(),
            props: vec![
                (
                    "kind".into(),
                    TypedExpr::new(
                        IrExpr::Text("loading".into()),
                        ResolvedType::Scalar(Scalar::Text),
                        node.span,
                    ),
                ),
                (
                    "message".into(),
                    TypedExpr::new(
                        IrExpr::Message(message),
                        ResolvedType::Scalar(Scalar::Text),
                        node.span,
                    ),
                ),
            ],
            children: Vec::new(),
            row_scope: None,
            gate,
            span: node.span,
        })
    }

    fn decode_tooltip(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, "tooltip", &[]);
        let caption = self.decode_single_ui_caption(scope, node, "tooltip")?;
        let children = self.decode_ui_children(scope, node, row_ctx);
        if children.is_empty() || kids(node).into_iter().any(|n| n.kind == SyntaxKind::Slot) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower tooltip: needs one nonempty ordinary content suite".to_string(),
                node.span,
            ));
            return None;
        }
        fn contains_priority(node: &IrUi) -> bool {
            matches!(node.factory.as_str(), "primaryActions" | "actionMenu")
                || node.children.iter().any(contains_priority)
        }
        if children.iter().any(contains_priority) {
            self.diags.push(Diagnostic::error("E6008", "cannot lower tooltip: tooltip is noninteractive and cannot contain priority actions, including expanded views".into(), node.span));
            return None;
        }
        Some(IrUi {
            view: None,
            factory: "tooltip".into(),
            props: vec![("caption".into(), caption)],
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    /// Bare selectors reuse the owning preparer's checked input schema and
    /// preserve its generated transport, bounds, labels and error identity.
    fn decode_owned_control(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        word: &str,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, word, &[]);
        let headers: Vec<_> = kids(node)
            .into_iter()
            .filter(|n| is_expression(n.kind))
            .collect();
        let selector = match headers.as_slice() {
            [header] => selector_spelling(self.db, header),
            _ => None,
        };
        let owned = selector.as_ref().is_some_and(|selector| {
            if !scope.in_field_owner
                || !scope
                    .form_fields
                    .as_ref()
                    .is_some_and(|fields| fields.contains(selector))
                || !scope
                    .form_bound_fields
                    .as_ref()
                    .is_some_and(|fields| !fields.contains(selector))
            {
                return false;
            }
            let Some(operation) = scope.field_operation else {
                return false;
            };
            let input = if let Some(scenario) = self.program.effects.scenarios.get(&operation) {
                if scenario.on.is_some() || scenario.read || scenario.expose_none {
                    return false;
                }
                scenario
                    .params
                    .iter()
                    .map(|param| param.param)
                    .find(|param| self.program.symbols[param.0 as usize].name == *selector)
            } else if let Some(crud) = self.program.effects.crud_ops.get(&operation) {
                if !matches!(crud.operation, CrudOp::Create | CrudOp::Update)
                    || !self
                        .default_form_fields(operation)
                        .is_some_and(|fields| fields.contains(selector))
                {
                    return false;
                }
                self.fields.get(&(crud.model, selector.clone())).copied()
            } else {
                None
            };
            input
                .and_then(|id| self.program.types.symbol_types.get(&id))
                .is_some_and(|ty| match word {
                    // Sliders cover whole and fractional owning numerics;
                    // the runtime renders exact values without guessing bounds.
                    "range" => matches!(
                        ty,
                        ResolvedType::Scalar(Scalar::Int | Scalar::Decimal)
                    ),
                    // An optional file input stays empty when no file is
                    // chosen; nullability is not a separate control.
                    "file_input" => {
                        *ty == ResolvedType::Scalar(Scalar::File)
                            || matches!(
                                ty,
                                ResolvedType::Nullable(inner) if inner.as_ref() == &ResolvedType::Scalar(Scalar::File)
                            )
                    }
                    _ => false,
                })
        });
        if !owned
            || !ui_attributes(self.db, node).is_empty()
            || kids(node)
                .into_iter()
                .any(|n| is_ui_node(n.kind) || n.kind == SyntaxKind::MessageValue)
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!(
                    "cannot lower {word}: needs one body-free owning writable input with no options"
                ),
                node.span,
            ));
            return None;
        }
        let mut control = self.decode_field_control(scope, node, word, row_ctx);
        if word == "file_input" {
            control.factory = "fileInput".into();
        }
        Some(control)
    }

    /// The compact footer is a scope-transparent group. Authored slots need
    /// their separate owning producer and must never flatten into children.
    fn decode_compact_footer(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, "footer", &[]);
        if !ui_attributes(self.db, node).is_empty() {
            return None;
        }
        if kids(node)
            .into_iter()
            .any(|child| child.kind == SyntaxKind::Slot)
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower compact footer: authored slots need a separate factory profile"
                    .to_string(),
                node.span,
            ));
            return None;
        }
        let mut props = Vec::new();
        if kids(node)
            .into_iter()
            .any(|child| is_expression(child.kind) || child.kind == SyntaxKind::MessageValue)
        {
            let caption = self.decode_single_ui_caption(scope, node, "footer")?;
            props.push(("caption".to_string(), caption));
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        if children.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower compact footer: needs a nonempty content suite".to_string(),
                node.span,
            ));
            return None;
        }
        Some(IrUi {
            view: None,
            factory: "footer".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    /// The compact hero is a scope-transparent group. Authored slots need
    /// their separate owning producer and must never flatten into children.
    fn decode_compact_hero(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, "hero", &[]);
        if !ui_attributes(self.db, node).is_empty() {
            return None;
        }
        if kids(node)
            .into_iter()
            .any(|child| child.kind == SyntaxKind::Slot)
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower compact hero: authored slots need a separate factory profile"
                    .to_string(),
                node.span,
            ));
            return None;
        }
        let mut props = Vec::new();
        if kids(node)
            .into_iter()
            .any(|child| is_expression(child.kind) || child.kind == SyntaxKind::MessageValue)
        {
            let caption = self.decode_single_ui_caption(scope, node, "hero")?;
            props.push(("caption".to_string(), caption));
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        if children.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower compact hero: needs a nonempty content suite".to_string(),
                node.span,
            ));
            return None;
        }
        Some(IrUi {
            view: None,
            factory: "hero".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    /// Expand only the checked local declaration in its owning module scope.
    /// Caller aliases and page bindings are never captured by the definition.
    fn decode_view_use(&mut self, scope: &Scope, node: &SyntaxNode) -> Option<IrUi> {
        let key = NodeKey::of(node);
        let Some(definition) = self.program.types.view_uses.get(&key).copied() else {
            self.gap(
                "show has no checked local view binding".to_string(),
                node.span,
            );
            return None;
        };
        let Some(model) = self.program.types.view_models.get(&definition).copied() else {
            self.gap(
                "view has no checked stored-model row".to_string(),
                node.span,
            );
            return None;
        };
        let declaration = self.node(&definition)?.clone();
        let object = kids(node)
            .into_iter()
            .find(|n| n.kind == SyntaxKind::Object)?;
        let entry = kids(object)
            .into_iter()
            .find(|n| n.kind == SyntaxKind::ObjectEntry)?;
        let value = kids(entry).into_iter().find(|n| is_expression(n.kind))?;
        let argument = self.decode_expr(scope, value);
        // The checked link is same-module; model ownership may be imported.
        let mut owned = Scope::module(scope.module);
        owned.name_types.insert(
            "row".to_string(),
            ResolvedType::Record {
                symbol: model,
                stored: true,
            },
        );
        owned.row_rewrite.insert("row".into(), "row".into());
        owned.enclosing_records.push((model, "row".into()));
        let children =
            self.decode_ui_children(&owned, &declaration, Some((model, "row".to_string())));
        // A definition-level require gates its whole expansion using the bound row.
        let gate = self.decode_gate(&owned, &declaration);
        Some(IrUi {
            view: Some(IrViewUse {
                argument,
                identity: format!(
                    "can-view-m{}-f{}-s{}",
                    scope.module.0, node.span.file.0, node.span.start
                ),
            }),
            factory: String::new(),
            props: Vec::new(),
            children,
            row_scope: None,
            gate,
            span: node.span,
        })
    }

    /// Decode a field-placement control (`input`/`textarea`): the header
    /// selector names an existing writable input of the nearest owning
    /// form, so it lowers to a `field` selector string, never a value.
    /// Controls outside a field owner stay loud `E6008`.
    /// Only the original form-owned date field production, never an agenda.
    fn decode_date_calendar(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, "calendar", &[]);
        let headers: Vec<_> = kids(node)
            .into_iter()
            .filter(|child| is_expression(child.kind))
            .collect();
        let selector = match headers.as_slice() {
            [header] => selector_spelling(self.db, header),
            _ => None,
        };
        let owned_date = selector.as_ref().is_some_and(|selector| {
            if !scope.in_field_owner || !scope.form_fields.as_ref().is_some_and(|fields| fields.contains(selector)) {
                return false;
            }
            if !scope.form_bound_fields.as_ref().is_some_and(|bound| !bound.contains(selector)) {
                return false;
            }
            let Some(op) = scope.field_operation else { return false; };
            if let Some(symbol) = self.program.symbols.get(op.0 as usize)
                && let SymbolKind::Scenario { params, trusted: false, .. } = &symbol.kind
            {
                let Some(data) = self.program.effects.scenarios.get(&op) else { return false; };
                if symbol.id != op || data.scenario != op || data.module != symbol.module
                    || data.on.is_some() || data.read || data.expose_none
                    || !params.iter().copied().eq(data.params.iter().map(|param| param.param)) { return false; }
                return data.params.iter().enumerate().any(|(index, param)| {
                    self.program.symbols.get(param.param.0 as usize).is_some_and(|input| {
                        input.id == param.param && input.module == symbol.module && input.name == *selector
                            && matches!(&input.kind, SymbolKind::Param { owner, index: position, type_node }
                                if *owner == op && *position == index && *type_node == param.type_node)
                            && self.program.types.symbol_types.get(&input.id).is_some_and(|ty| {
                                ty == &ResolvedType::Scalar(Scalar::Date)
                                    || matches!(
                                        ty,
                                        ResolvedType::Nullable(inner) if inner.as_ref() == &ResolvedType::Scalar(Scalar::Date)
                                    )
                            })
                    })
                });
            }
            let Some(data) = self.program.effects.crud_ops.get(&op) else { return false; };
            if data.op != op || !matches!(data.operation, CrudOp::Create | CrudOp::Update)
                || !self.program.effects.cruds.get(&data.crud_decl).is_some_and(|crud| {
                    crud.crud == data.crud_decl && crud.model == data.model && crud.ops.contains(&op)
                        && match data.operation { CrudOp::Create => crud.create, CrudOp::Update => crud.update, CrudOp::Delete => false }
                })
                || !matches!(self.program.symbols.get(op.0 as usize).map(|symbol| &symbol.kind), Some(SymbolKind::CrudOp { model, op: operation }) if *model == data.model && *operation == data.operation)
                || !self.default_form_fields(op).is_some_and(|fields| fields.contains(selector)) {
                return false;
            }
            self.program.effects.models.get(&data.model).is_some_and(|model| model.fields.iter().any(|field| {
                self.program.symbols.get(field.field.0 as usize).is_some_and(|symbol| {
                    symbol.name == *selector && matches!(symbol.kind, SymbolKind::Field { owner, .. } if owner == data.model)
                        && self.program.types.symbol_types.get(&symbol.id).is_some_and(|ty| {
                            ty == &ResolvedType::Scalar(Scalar::Date)
                                || matches!(
                                    ty,
                                    ResolvedType::Nullable(inner) if inner.as_ref() == &ResolvedType::Scalar(Scalar::Date)
                                )
                        })
                })
            }))
        });
        if !owned_date
            || !ui_attributes(self.db, node).is_empty()
            || kids(node)
                .into_iter()
                .any(|child| is_ui_node(child.kind) || child.kind == SyntaxKind::MessageValue)
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower calendar: only a body-free owned date input with no options is supported".to_string(),
                node.span,
            ));
            return None;
        }
        let mut control = self.decode_field_control(scope, node, "calendar", row_ctx);
        control.props.push((
            "kind".to_string(),
            TypedExpr::new(
                IrExpr::Text("field".to_string()),
                ResolvedType::Scalar(Scalar::Text),
                node.span,
            ),
        ));
        Some(control)
    }

    /// A checkbox places one existing writable nonnullable bool input.
    fn decode_bool_checkbox(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.decode_bool_control(scope, node, "checkbox", row_ctx)
    }

    /// Decode a body-free owned writable bool input (`checkbox`, `toggle`)
    /// with no options. Ownership and the bool type resolve exactly as the
    /// existing checkbox profile; only the factory word differs.
    fn decode_bool_control(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        word: &str,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, word, &[]);
        let headers: Vec<_> = kids(node)
            .into_iter()
            .filter(|child| is_expression(child.kind))
            .collect();
        let selector = match headers.as_slice() {
            [header] => selector_spelling(self.db, header),
            _ => None,
        };
        let owned_bool = selector.as_ref().is_some_and(|selector| {
            if !scope.in_field_owner || !scope.form_fields.as_ref().is_some_and(|fields| fields.contains(selector)) { return false; }
            if !scope.form_bound_fields.as_ref().is_some_and(|bound| !bound.contains(selector)) { return false; }
            let Some(op) = scope.field_operation else { return false; };
            if let Some(symbol) = self.program.symbols.get(op.0 as usize)
                && let SymbolKind::Scenario { params, trusted: false, .. } = &symbol.kind
            {
                let Some(data) = self.program.effects.scenarios.get(&op) else { return false; };
                if symbol.id != op || data.scenario != op || data.module != symbol.module
                    || data.on.is_some() || data.read || data.expose_none
                    || !params.iter().copied().eq(data.params.iter().map(|param| param.param)) { return false; }
                return data.params.iter().enumerate().any(|(index, param)| {
                    self.program.symbols.get(param.param.0 as usize).is_some_and(|input| {
                        input.id == param.param && input.module == symbol.module && input.name == *selector
                            && matches!(&input.kind, SymbolKind::Param { owner, index: position, type_node }
                                if *owner == op && *position == index && *type_node == param.type_node)
                            && self.program.types.symbol_types.get(&input.id) == Some(&ResolvedType::Scalar(Scalar::Bool))
                    })
                });
            }
            let Some(data) = self.program.effects.crud_ops.get(&op) else { return false; };
            if data.op != op || !matches!(data.operation, CrudOp::Create | CrudOp::Update)
                || !self.program.effects.cruds.get(&data.crud_decl).is_some_and(|crud| {
                    crud.crud == data.crud_decl && crud.model == data.model && crud.ops.contains(&op)
                        && match data.operation { CrudOp::Create => crud.create, CrudOp::Update => crud.update, CrudOp::Delete => false }
                })
                || !matches!(self.program.symbols.get(op.0 as usize).map(|symbol| &symbol.kind), Some(SymbolKind::CrudOp { model, op: operation }) if *model == data.model && *operation == data.operation)
                || !self.default_form_fields(op).is_some_and(|fields| fields.contains(selector)) { return false; }
            self.program.effects.models.get(&data.model).is_some_and(|model| model.fields.iter().any(|field| {
                self.program.symbols.get(field.field.0 as usize).is_some_and(|symbol| {
                    symbol.name == *selector && matches!(symbol.kind, SymbolKind::Field { owner, .. } if owner == data.model)
                        && self.program.types.symbol_types.get(&symbol.id) == Some(&ResolvedType::Scalar(Scalar::Bool))
                })
            }))
        });
        if !owned_bool
            || !ui_attributes(self.db, node).is_empty()
            || kids(node)
                .into_iter()
                .any(|child| is_ui_node(child.kind) || child.kind == SyntaxKind::MessageValue)
        {
            self.diags.push(Diagnostic::error("E6008", format!("cannot lower {word}: only a body-free owned writable bool input with no options is supported"), node.span));
            return None;
        }
        Some(self.decode_field_control(scope, node, word, row_ctx))
    }

    /// Label and feedback placements consume the same selected writable
    /// prepared field as its control; they do not introduce another input.
    fn decode_field_fragment(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        word: &str,
    ) -> Option<IrUi> {
        let admitted = if word == "label" {
            &["caption"][..]
        } else {
            &[][..]
        };
        self.check_ui_attributes(node, word, admitted);
        let headers: Vec<_> = kids(node)
            .into_iter()
            .filter(|child| is_expression(child.kind))
            .collect();
        let selector = match headers.as_slice() {
            [header] => selector_spelling(self.db, header),
            _ => None,
        };
        let owned = selector.as_ref().is_some_and(|selector| {
            scope.in_field_owner
                && scope
                    .form_fields
                    .as_ref()
                    .is_some_and(|fields| fields.contains(selector))
                && scope
                    .form_bound_fields
                    .as_ref()
                    .is_some_and(|fields| !fields.contains(selector))
                && scope.field_operation.is_some_and(|operation| {
                    self.default_form_fields(operation)
                        .is_some_and(|fields| fields.contains(selector))
                })
        });
        let attributes = ui_attributes(self.db, node);
        if !owned
            || attributes.len() > admitted.len()
            || attributes
                .iter()
                .any(|(name, value)| !admitted.contains(&name.as_str()) || value.is_none())
            || kids(node).into_iter().any(|child| {
                (is_ui_node(child.kind) && !is_gate_leaf(self.db, child))
                    || child.kind == SyntaxKind::MessageValue
            })
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower {word}: needs one body-free selected owning writable field"),
                node.span,
            ));
            return None;
        }
        let mut props = vec![(
            "field".to_string(),
            TypedExpr::new(
                IrExpr::Text(selector?),
                ResolvedType::Scalar(Scalar::Text),
                headers[0].span,
            ),
        )];
        for (name, value) in attributes {
            props.push((name, self.decode_ui_header_value(scope, value?)));
        }
        Some(IrUi {
            view: None,
            factory: word.to_string(),
            props,
            children: Vec::new(),
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

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
            view: None,
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
            view: None,
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
            view: None,
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
            view: None,
            factory: "chatBubble".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Only checked ordinary mutation scenarios have the protected form profile.
    fn action_scenario(
        &mut self,
        module: ModuleId,
        target: &SyntaxNode,
    ) -> Option<(SymbolId, Vec<SymbolId>)> {
        let selected = self
            .resolve_operation_target(module, target)
            .and_then(|id| {
                let symbol = self.program.symbols.get(id.0 as usize)?;
                let SymbolKind::Scenario {
                    params,
                    trusted: false,
                    ..
                } = &symbol.kind
                else {
                    return None;
                };
                let data = self.program.effects.scenarios.get(&id)?;
                (!data.read && !data.expose_none && data.on.is_none()).then(|| (id, params.clone()))
            });
        if selected.is_none() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower action: target has no published ordinary mutation form profile"
                    .to_string(),
                target.span,
            ));
        }
        selected
    }

    /// Reuse the native preparer's unbound fields, protected arguments and display.
    fn protected_action_form(
        &mut self,
        operation: SymbolId,
        arguments: TypedExpr,
        span: Span,
    ) -> IrUi {
        let mut props = vec![
            (
                "operation".to_string(),
                TypedExpr::new(
                    IrExpr::Text(self.canonical(operation)),
                    ResolvedType::Scalar(Scalar::Text),
                    span,
                ),
            ),
            ("arguments".to_string(), arguments),
        ];
        if let Some(data) = self.program.effects.scenarios.get(&operation).cloned()
            && let Some(label) = data.label
            && let Some(message) = self.decode_message_value(data.module, &label)
        {
            props.push((
                "submit".to_string(),
                TypedExpr::new(
                    IrExpr::Message(message),
                    ResolvedType::Scalar(Scalar::Text),
                    span,
                ),
            ));
        }
        IrUi {
            view: None,
            factory: "form".to_string(),
            props,
            children: Vec::new(),
            row_scope: None,
            gate: None,
            span,
        }
    }

    /// Each priority primitive owns one canonical control. Owner factories
    /// arrange the resulting opaque bindings without changing evaluation scope.
    fn decode_contextual_actions(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        let priority = ui_word(self.db, node);
        let headers: Vec<_> = kids(node)
            .into_iter()
            .filter(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
            .collect();
        let caption = headers.first().copied()?;
        let caption = self.decode_ui_header_value(scope, caption);
        if let Some(child) = node.descendants().find(|child| {
            is_ui_node(child.kind)
                && !std::ptr::eq(*child, node)
                && !matches!(
                    ui_word(self.db, child).as_str(),
                    "input"
                        | "textarea"
                        | "select"
                        | "checkbox"
                        | "toggle"
                        | "radio"
                        | "range"
                        | "file_input"
                        | "calendar"
                        | "label"
                        | "validator"
                        | "fieldset"
                        | "require"
                )
        }) {
            self.diags.push(Diagnostic::error("E6008", "action primitive suites accept authored inputs and require guards, never nested controls".into(), child.span));
            return None;
        }
        let mut control = if node.kind == SyntaxKind::Form {
            let target = ui_attributes(self.db, node)
                .into_iter()
                .find(|(name, _)| name == "action")
                .and_then(|(_, value)| value)?;
            let operation = self.resolve_operation_target(scope.module, target)?;
            if let SymbolKind::CrudOp {
                model,
                op: CrudOp::Delete,
            } = self.program.symbols.get(operation.0 as usize)?.kind
            {
                let arguments = ui_attributes(self.db, node)
                    .into_iter()
                    .find(|(name, _)| name == "arguments")
                    .and_then(|(_, value)| value)?;
                let arguments = self.decode_expr(scope, arguments);
                let IrExpr::Object(entries) = arguments.expr else {
                    return None;
                };
                let record = entries
                    .into_iter()
                    .find(|(name, _)| name == "record")
                    .map(|(_, value)| value)?;
                let mut delete = self.decode_delete_leaf(scope, node, Some((model, "row".into())));
                delete
                    .props
                    .retain(|(key, _)| key != "record" && key != "idPrefix");
                delete.props.push(("record".into(), record));
                delete.props.push((
                    "idPrefix".into(),
                    TypedExpr::new(
                        IrExpr::Text(format!(
                            "can-delete-f{}-s{}",
                            node.span.file.0, node.span.start
                        )),
                        ResolvedType::Scalar(Scalar::Text),
                        node.span,
                    ),
                ));
                delete
            } else {
                let mut form = self.decode_form(scope, node, row_ctx)?;
                form.props.retain(|(key, _)| key != "submit");
                form.props.push(("submit".into(), caption.clone()));
                form
            }
        } else {
            let mut props = vec![("caption".into(), caption.clone())];
            for (name, value) in ui_attributes(self.db, node) {
                let Some(value) = value else {
                    continue;
                };
                let decoded = if name == "opens" {
                    TypedExpr::new(
                        IrExpr::Text(opens_spelling(self.db, value)?),
                        ResolvedType::Scalar(Scalar::Text),
                        value.span,
                    )
                } else {
                    self.decode_expr(scope, value)
                };
                props.push((name, decoded));
            }
            IrUi {
                view: None,
                factory: "button".into(),
                props,
                children: Vec::new(),
                row_scope: None,
                gate: None,
                span: node.span,
            }
        };
        if control.factory != "button" {
            control.props.push(("controlLabel".into(), caption));
            control.props.push((
                "display".into(),
                TypedExpr::new(
                    IrExpr::Text("menu".into()),
                    ResolvedType::Scalar(Scalar::Text),
                    node.span,
                ),
            ));
        }
        // The primitive's guard encloses preparation and admission once.
        control.gate = None;
        Some(IrUi {
            view: None,
            factory: if priority == "primary" {
                "primaryActions"
            } else {
                "actionMenu"
            }
            .into(),
            props: Vec::new(),
            children: vec![control],
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    /// `actions` is a private grouping of ordinary protected operation forms.
    fn decode_actions(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, "actions", &[]);
        if kids(node)
            .iter()
            .any(|child| is_ui_node(child.kind) && !is_gate_leaf(self.db, child))
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower actions: protected controls take no content suite".to_string(),
                node.span,
            ));
            return None;
        }
        let Some((model, row)) = row_ctx else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower actions: an owning stored row is required".to_string(),
                node.span,
            ));
            return None;
        };
        let targets: Vec<_> = kids(node)
            .into_iter()
            .filter(|n| is_expression(n.kind))
            .collect();
        let mut operations = HashSet::new();
        let mut children = Vec::new();
        for target in targets {
            let (operation, params) = self.action_scenario(scope.module, target)?;
            if !operations.insert(operation) {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower actions: duplicate canonical operation".to_string(),
                    target.span,
                ));
                return None;
            }
            let host_ty = ResolvedType::Record {
                symbol: model,
                stored: true,
            };
            let matching: Vec<_> = params
                .into_iter()
                .filter(|id| self.program.types.symbol_types.get(id) == Some(&host_ty))
                .collect();
            let [param] = matching.as_slice() else {
                self.diags.push(Diagnostic::error("E6008", "cannot lower actions: operation needs exactly one parameter matching the owning row model".to_string(), target.span));
                return None;
            };
            let name = self.program.symbols.get(param.0 as usize)?.name.clone();
            let argument = TypedExpr::new(IrExpr::Name(row.clone()), host_ty, target.span);
            let arguments = TypedExpr::new(
                IrExpr::Object(vec![(name, argument)]),
                ResolvedType::Unknown,
                target.span,
            );
            children.push(self.protected_action_form(operation, arguments, target.span));
        }
        if children.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower actions: at least one operation is required".to_string(),
                node.span,
            ));
            return None;
        }
        Some(IrUi {
            view: None,
            factory: "actions".to_string(),
            props: Vec::new(),
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    /// Singular row actions bind the one protected record to its owning row.
    fn decode_row_action(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, "action", &[]);
        let targets: Vec<_> = kids(node)
            .into_iter()
            .filter(|child| is_expression(child.kind))
            .collect();
        let [target] = targets.as_slice() else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower action: exactly one ordinary operation is required".to_string(),
                node.span,
            ));
            return None;
        };
        if kids(node)
            .into_iter()
            .any(|child| is_ui_node(child.kind) && !is_gate_leaf(self.db, child))
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower action: protected controls take no content suite".to_string(),
                node.span,
            ));
            return None;
        }
        let Some((model, row)) = row_ctx else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower action: an owning stored row is required".to_string(),
                node.span,
            ));
            return None;
        };
        let (operation, params) = self.action_scenario(scope.module, target)?;
        let host_ty = ResolvedType::Record {
            symbol: model,
            stored: true,
        };
        let records: Vec<_> = params
            .into_iter()
            .filter(|param| {
                self.program
                    .types
                    .symbol_types
                    .get(param)
                    .is_some_and(|ty| {
                        matches!(
                            ty.nullable_inner().unwrap_or(ty),
                            ResolvedType::Record { stored: true, .. }
                        )
                    })
            })
            .collect();
        let [param] = records.as_slice() else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower action: exactly one protected record input must match the owning row"
                    .to_string(),
                target.span,
            ));
            return None;
        };
        if self.program.types.symbol_types.get(param) != Some(&host_ty) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower action: protected record input does not match the owning row"
                    .to_string(),
                target.span,
            ));
            return None;
        }
        let name = self.program.symbols.get(param.0 as usize)?.name.clone();
        let argument = TypedExpr::new(IrExpr::Name(row), host_ty, target.span);
        let arguments = TypedExpr::new(
            IrExpr::Object(vec![(name, argument)]),
            ResolvedType::Unknown,
            target.span,
        );
        let mut form = self.protected_action_form(operation, arguments, node.span);
        form.gate = self.decode_gate(scope, node);
        Some(form)
    }

    /// Bind the owning row for an argument-less action button: exactly one
    /// singular stored-record scenario input must match the owning row
    /// type, mirroring the `action` leaf. Anything else keeps the explicit
    /// `arguments=` requirement loud.
    fn implicit_row_arguments(
        &mut self,
        node: &SyntaxNode,
        target: &SyntaxNode,
        params: &[SymbolId],
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<TypedExpr> {
        let Some((model, row)) = row_ctx else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower button action: explicit protected record arguments are required"
                    .to_string(),
                node.span,
            ));
            return None;
        };
        let host_ty = ResolvedType::Record {
            symbol: model,
            stored: true,
        };
        let records: Vec<_> = params
            .iter()
            .filter(|&param| {
                self.program
                    .types
                    .symbol_types
                    .get(param)
                    .is_some_and(|ty| {
                        matches!(
                            ty.nullable_inner().unwrap_or(ty),
                            ResolvedType::Record { stored: true, .. }
                        )
                    })
            })
            .collect();
        if records.len() != 1 {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower button action: explicit protected record arguments are required"
                    .to_string(),
                node.span,
            ));
            return None;
        }
        let param = records[0];
        if self.program.types.symbol_types.get(&param) != Some(&host_ty) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower button action: protected record input does not match the owning row"
                    .to_string(),
                target.span,
            ));
            return None;
        }
        let name = self.program.symbols.get(param.0 as usize)?.name.clone();
        let argument = TypedExpr::new(IrExpr::Name(row), host_ty, target.span);
        Some(TypedExpr::new(
            IrExpr::Object(vec![(name, argument)]),
            ResolvedType::Unknown,
            target.span,
        ))
    }

    /// Explicit bound buttons reuse the same protected form with authored refs.
    /// Without `arguments=`, a button in row scope binds its one owning row,
    /// exactly like the sibling `action` leaf: the single stored-record
    /// scenario input must match the owning row type, and anything
    /// ambiguous keeps requiring explicit arguments.
    fn decode_action_button(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, "button action", &["action", "arguments"]);
        if kids(node).iter().any(|n| is_expression(n.kind)) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower button action: protected controls take no positional header"
                    .to_string(),
                node.span,
            ));
            return None;
        }
        let attributes = ui_attributes(self.db, node);
        let target = attributes
            .iter()
            .find(|(name, _)| name == "action")
            .and_then(|(_, value)| *value)?;
        let (operation, params) = self.action_scenario(scope.module, target)?;
        let object = attributes
            .iter()
            .find(|(name, _)| name == "arguments")
            .and_then(|(_, value)| *value);
        let arguments = match object.filter(|node| node.kind == SyntaxKind::Object) {
            Some(object) => self.decode_expr(scope, object),
            None => self.implicit_row_arguments(node, target, &params, row_ctx)?,
        };
        let IrExpr::Object(entries) = &arguments.expr else {
            return None;
        };
        let mut names = HashSet::new();
        let supported = !entries.is_empty()
            && entries.iter().all(|(name, value)| {
                names.insert(name.clone())
                    && params.iter().any(|id| {
                        self.program
                            .symbols
                            .get(id.0 as usize)
                            .is_some_and(|param| param.name == *name)
                            && matches!(
                                self.program.types.symbol_types.get(id),
                                Some(ResolvedType::Record { stored: true, .. })
                            )
                            && self.program.types.symbol_types.get(id) == Some(&value.ty)
                    })
            });
        if !supported || !self.decode_ui_children(scope, node, None).is_empty() {
            self.diags.push(Diagnostic::error("E6008", "cannot lower button action: only declared singular stored-record bindings without a content suite are supported".to_string(), node.span));
            return None;
        }
        let mut form = self.protected_action_form(operation, arguments, node.span);
        form.gate = self.decode_gate(scope, node);
        Some(form)
    }

    fn decode_button(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        let destination = ui_attributes(self.db, node)
            .iter()
            .any(|(name, _)| name == "target");
        if destination {
            self.check_ui_attributes(node, "button destination", &["target", "caption"]);
        }
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
                let decoded = if name == "caption" {
                    self.decode_ui_header_value(scope, value)
                } else {
                    self.decode_expr(scope, value)
                };
                props.push((name.clone(), decoded));
            }
        }
        if destination && bindings != 1 {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower button destination: exactly one binding is required".to_string(),
                node.span,
            ));
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
            view: None,
            factory: "button".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// A checked destination shares the existing URL/File presentation boundary.
    fn decode_link(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        self.check_ui_attributes(node, "link", &["target", "caption", "tone", "variant"]);
        let mut props = Vec::new();
        if kids(node).iter().any(|child| is_expression(child.kind)) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower link: destinations take no positional header".to_string(),
                node.span,
            ));
        }
        for (name, value) in ui_attributes(self.db, node) {
            if let Some(value) = value {
                let decoded = if name == "caption" {
                    self.decode_ui_header_value(scope, value)
                } else if matches!(name.as_str(), "tone" | "variant") {
                    self.decode_word_attr(scope, &name, value)
                } else {
                    self.decode_expr(scope, value)
                };
                props.push((name, decoded));
            }
        }
        if props.iter().filter(|(name, _)| name == "target").count() != 1 {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower link: exactly one target is required".to_string(),
                node.span,
            ));
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        if !children.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower link: destinations take no content suite".to_string(),
                node.span,
            ));
        }
        IrUi {
            view: None,
            factory: "link".to_string(),
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
            view: None,
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
            view: None,
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
            view: None,
            factory: "divider".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode the owning status leaf's primitive/message TextValue profile.
    fn decode_status(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, "status", &["caption", "tone", "size"]);
        let headers: Vec<_> = kids(node)
            .into_iter()
            .filter(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
            .collect();
        let [header] = headers.as_slice() else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower status: status takes one readable value".to_string(),
                node.span,
            ));
            return None;
        };
        let value = self.decode_ui_header_value(scope, header);
        if !matches!(
            value.ty.nullable_inner().unwrap_or(&value.ty),
            ResolvedType::Scalar(Scalar::Bool | Scalar::Text | Scalar::Int)
                | ResolvedType::Enum { .. }
                | ResolvedType::Message(_)
                | ResolvedType::InlineMessage
                | ResolvedType::Null
        ) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower status: value has no admitted primitive/message TextValue carrier"
                    .to_string(),
                header.span,
            ));
            return None;
        }
        let mut props = vec![("value".to_string(), value)];
        for (name, value) in ui_attributes(self.db, node) {
            if let Some(value) = value {
                let value = if name == "caption" {
                    self.decode_ui_header_value(scope, value)
                } else {
                    self.decode_word_attr(scope, &name, value)
                };
                props.push((name, value));
            }
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        if !children.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower status: status takes no content suite".to_string(),
                node.span,
            ));
            return None;
        }
        Some(IrUi {
            view: None,
            factory: "status".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
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
            view: None,
            factory: "badge".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Decode bare `breadcrumbs`: the derived-ancestry leaf consumes the
    /// current declared destination ancestry from its trusted render context.
    /// This finite profile accepts no authored substitute or selector.
    fn decode_breadcrumbs(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> IrUi {
        self.check_ui_attributes(node, "breadcrumbs", &[]);
        if kids(node)
            .iter()
            .any(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower breadcrumbs: derived-ancestry leaves take no header".to_string(),
                node.span,
            ));
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
            view: None,
            factory: "breadcrumbs".to_string(),
            props: Vec::new(),
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
            "cannot lower pagination: the bare marker must belong directly to a list or table"
                .to_string(),
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
            view: None,
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
    ) -> Option<IrUi> {
        let mut props = Vec::new();
        let headers: Vec<&SyntaxNode> = kids(node)
            .iter()
            .filter(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
            .copied()
            .collect();
        let slotted = kids(node).iter().any(|n| n.kind == SyntaxKind::Slot);
        if slotted {
            if !headers.is_empty() {
                self.diags.push(Diagnostic::error("E6008", "cannot lower stat: a slotted stat takes no value header".to_string(), node.span));
                return None;
            }
            if let Some(value) = self.decode_stat_slot(scope, node, "value", row_ctx.clone()) {
                props.push(("value".to_string(), value));
            } else {
                return None;
            }
            for slot in ["title", "description"] {
                if let Some(caption) = self.decode_stat_slot(scope, node, slot, row_ctx.clone()) {
                    props.push((slot.to_string(), caption));
                }
            }
            if kids(node).iter().any(|n| {
                n.kind == SyntaxKind::Slot
                    && slot_name(self.db, n).is_some_and(|name| !matches!(name.as_str(), "value" | "title" | "description"))
            }) {
                self.diags.push(Diagnostic::error("E6008", "cannot lower stat: stat admits only value, title and description slots".to_string(), node.span));
                return None;
            }
            if kids(node)
                .iter()
                .filter(|n| is_ui_node(n.kind))
                .any(|n| n.kind != SyntaxKind::Slot || slot_name(self.db, n).is_none())
            {
                self.diags.push(Diagnostic::error("E6008", "cannot lower stat: a slotted stat takes only its named slots".to_string(), node.span));
                return None;
            }
            return Some(IrUi {
                view: None,
                factory: "stat".to_string(),
                props,
                children: Vec::new(),
                row_scope: None,
                gate: self.decode_gate(scope, node),
                span: node.span,
            });
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        match headers.as_slice() {
            [header] if children.is_empty() => props.push(("value".to_string(), self.decode_ui_header_value(scope, header))),
            // `stat a,b,...` shares the metrics visual-join contract: each
            // value header lowers through the single-value stat profile.
            // Money is excluded: the owning stat factory renders TextValue
            // only, and a raw money row value throws in renderTextValue
            // (REVIEW-21 family execution proof), so money headers keep the
            // exact refusal instead of compiling to a runtime throw.
            [_, _, ..] if children.is_empty() && ui_attributes(self.db, node).is_empty() => {
                let gate = self.decode_gate(scope, node);
                let mut stats = Vec::new();
                for header in headers {
                    let value = self.decode_ui_header_value(scope, header);
                    if matches!(
                        value.ty.nullable_inner().unwrap_or(&value.ty),
                        ResolvedType::Scalar(Scalar::Money)
                    ) {
                        self.diags.push(Diagnostic::error("E6008", "cannot lower stat: only one value header without a slotted suite has an owning factory profile".to_string(), node.span));
                        return None;
                    }
                    stats.push(IrUi {
                        view: None,
                        factory: "stat".to_string(),
                        props: vec![("value".to_string(), value)],
                        children: Vec::new(),
                        row_scope: None,
                        gate: None,
                        span: header.span,
                    });
                }
                return Some(IrUi {
                    view: None,
                    factory: "join".to_string(),
                    props: Vec::new(),
                    children: stats,
                    row_scope: None,
                    gate,
                    span: node.span,
                });
            }
            _ => {
                self.diags.push(Diagnostic::error("E6008", "cannot lower stat: only one value header without a slotted suite has an owning factory profile".to_string(), node.span));
                return None;
            }
        }
        for (name, value) in ui_attributes(self.db, node) {
            if let Some(value) = value {
                let decoded = if name == "description" {
                    let attribute = kids(node).into_iter().find(|child| {
                        child.kind == SyntaxKind::Attribute
                            && kids(child)
                                .first()
                                .and_then(|part| name_text(self.db, part))
                                .as_deref()
                                == Some("description")
                    });
                    let Some(decoded) = attribute.and_then(|attribute| {
                        self.decode_single_ui_caption(scope, attribute, "stat description")
                    }) else {
                        continue;
                    };
                    decoded
                } else {
                    self.decode_word_attr(scope, &name, value)
                };
                props.push((name.clone(), decoded));
            }
        }
        Some(IrUi {
            view: None,
            factory: "stat".to_string(),
            props,
            children,
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    /// Extract one named stat slot's single text value (`value`, `title`
    /// or `description`). `None` when the slot is absent; loud `E6008`
    /// when present but not a single text value.
    fn decode_stat_slot(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        slot: &str,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<TypedExpr> {
        let _ = row_ctx;
        let mut found = kids(node).into_iter().filter(|n| {
            n.kind == SyntaxKind::Slot && slot_name(self.db, n).as_deref() == Some(slot)
        });
        let slot_node = found.next()?;
        if found.next().is_some() {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower stat: duplicate {slot} slot"),
                node.span,
            ));
            return None;
        }
        let texts: Vec<&SyntaxNode> = kids(slot_node)
            .into_iter()
            .filter(|n| {
                (n.kind == SyntaxKind::UiLeaf && ui_word(self.db, n) == "text")
                    || n.kind == SyntaxKind::MessageValue
            })
            .collect();
        let text_keys: Vec<NodeKey> = texts.iter().map(|n| NodeKey::of(n)).collect();
        let foreign = kids(slot_node)
            .into_iter()
            .filter(|n| is_ui_node(n.kind))
            .any(|n| !text_keys.contains(&NodeKey::of(n)));
        if texts.len() != 1 || foreign {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower stat: {slot} slot takes one text value"),
                slot_node.span,
            ));
            return None;
        }
        let text_node = texts[0];
        if text_node.kind == SyntaxKind::MessageValue {
            return Some(self.decode_ui_header_value(scope, text_node));
        }
        let headers: Vec<&SyntaxNode> = kids(text_node)
            .into_iter()
            .filter(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
            .collect();
        if headers.len() != 1 {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!("cannot lower stat: {slot} slot takes one text value"),
                text_node.span,
            ));
            return None;
        }
        Some(self.decode_ui_header_value(scope, headers[0]))
    }

    /// Decode a `content` leaf: one text value or message, preserving
    /// plain-text paragraphs. A null value renders as empty (no invented
    /// absent wording); other types keep their existing refusal.
    fn decode_content_value(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
    ) -> Option<TypedExpr> {
        let headers: Vec<&SyntaxNode> = kids(node)
            .into_iter()
            .filter(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
            .collect();
        let [header] = headers.as_slice() else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower content: content takes one text value".to_string(),
                node.span,
            ));
            return None;
        };
        // Probe the checked type without decoding (decoding twice would
        // duplicate diagnostics); only nullable text takes the new path.
        let nullable_text = matches!(
            self.node_type(header),
            ResolvedType::Nullable(inner) if inner.as_ref() == &ResolvedType::Scalar(Scalar::Text)
        );
        if !nullable_text {
            // Non-null values keep the existing caption contract exactly,
            // including the parameterized-message binding refusal.
            return self.decode_single_ui_caption(scope, node, "content");
        }
        let value = self.decode_ui_header_value(scope, header);
        Some(TypedExpr::new(
            IrExpr::Binary {
                op: IrBinOp::Coalesce,
                left: Box::new(value),
                right: Box::new(TypedExpr::new(
                    IrExpr::Text(String::new()),
                    ResolvedType::Scalar(Scalar::Text),
                    header.span,
                )),
            },
            ResolvedType::Scalar(Scalar::Text),
            header.span,
        ))
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
            view: None,
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
            view: None,
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
        let decoded = self.decode_expr(scope, value);
        if matches!(name, "caption" | "title" | "text" | "label" | "submit") {
            self.check_ui_message_parameter_profile(value, &decoded);
        }
        decoded
    }

    /// Decode a `form` node: operation plus display/arguments/fields/submit.
    /// Bound row edits reuse the protected operation form and its native defaults.
    fn decode_bound_edit(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, "edit", &["fields"]);
        let attributes = ui_attributes(self.db, node);
        if attributes.len() > 1
            || attributes
                .first()
                .is_some_and(|(name, value)| name != "fields" || value.is_none())
            || kids(node).iter().any(|child| {
                is_expression(child.kind)
                    || matches!(child.kind, SyntaxKind::Path | SyntaxKind::MessageValue)
                    || is_gate_leaf(self.db, child)
            })
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower edit: only bound row edits with optional fields and no header or direct gate are supported"
                    .to_string(),
                node.span,
            ));
            return None;
        }
        let Some((model, row)) = row_ctx.filter(|(model, _)| {
            matches!(
                self.program
                    .symbols
                    .get(model.0 as usize)
                    .map(|symbol| &symbol.kind),
                Some(SymbolKind::Model { .. })
            )
        }) else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower edit: a checked stored model row is required".to_string(),
                node.span,
            ));
            return None;
        };
        let operation = self
            .crud_for_model(model)
            .and_then(|crud| self.program.effects.cruds.get(&crud))
            .filter(|crud| crud.update && crud.model == model)
            .and_then(|crud| {
                crud.ops.iter().find_map(|op| {
                    self.program.effects.crud_ops.get(op).filter(|data| {
                        data.crud_decl == crud.crud
                            && data.model == model
                            && data.operation == CrudOp::Update
                    })
                })
            })
            .cloned();
        let Some(operation) = operation else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower edit: the row model has no checked enabled update operation"
                    .to_string(),
                node.span,
            ));
            return None;
        };
        let allowed = self.default_form_fields(operation.op).unwrap_or_default();
        let explicit_fields = attributes.first();
        let fields = match explicit_fields {
            Some((_, Some(value))) => selector_strings(self.db, value),
            None => allowed.clone(),
            Some((_, None)) => return None,
        };
        let mut seen = HashSet::new();
        if fields.is_empty()
            || fields.iter().any(|field| {
                field.contains('.')
                    || !seen.insert(field.clone())
                    || !allowed.contains(field)
                    || (explicit_fields.is_some()
                        && !operation.fields.is_empty()
                        && !operation.fields.contains(field))
            })
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower edit: fields must be unique simple checked writable update inputs"
                    .to_string(),
                node.span,
            ));
            return None;
        }
        let mut owned = scope.clone();
        owned.in_field_owner = true;
        owned.field_operation = Some(operation.op);
        owned.form_fields = Some(fields.clone());
        owned.form_bound_fields = Some(HashSet::from(["record".to_string()]));
        let children = self.decode_ui_children(&owned, node, Some((model, row.clone())));
        let mut placed = HashSet::new();
        let mut pending: Vec<_> = children.iter().collect();
        while let Some(child) = pending.pop() {
            if child.gate.is_some() {
                self.diags.push(Diagnostic::error("E6008", "cannot lower edit: gated authored content has no supported field-placement profile".to_string(), child.span));
                return None;
            }
            if child.factory == "form" || child.row_scope.is_some() {
                continue;
            }
            if matches!(
                child.factory.as_str(),
                "input" | "textarea" | "radio" | "select" | "calendar" | "checkbox"
            ) {
                let selector = child
                    .props
                    .iter()
                    .find(|(name, _)| name == "field")
                    .and_then(|(_, value)| {
                        if let IrExpr::Text(selector) = &value.expr {
                            Some(selector)
                        } else {
                            None
                        }
                    });
                if !selector.is_some_and(|selector| {
                    fields.contains(selector) && placed.insert(selector.clone())
                }) {
                    self.diags.push(Diagnostic::error("E6008", "cannot lower edit: authored controls must name unique selected writable inputs".to_string(), child.span));
                    return None;
                }
            }
            pending.extend(child.children.iter());
        }
        let record = TypedExpr::new(
            IrExpr::Name(row),
            ResolvedType::Record {
                symbol: model,
                stored: true,
            },
            node.span,
        );
        let arguments = TypedExpr::new(
            IrExpr::Object(vec![("record".to_string(), record)]),
            ResolvedType::Unknown,
            node.span,
        );
        let mut form = self.protected_action_form(operation.op, arguments, node.span);
        form.children = children;
        if ui_owns_submit(self.db, node) {
            form.props.push((
                "authoredSubmit".into(),
                TypedExpr::new(
                    IrExpr::Bool(true),
                    ResolvedType::Scalar(Scalar::Bool),
                    node.span,
                ),
            ));
        }

        form.props.push((
            "fields".to_string(),
            TypedExpr::new(
                IrExpr::Array(
                    fields
                        .into_iter()
                        .map(|field| {
                            TypedExpr::new(
                                IrExpr::Text(field),
                                ResolvedType::Scalar(Scalar::Text),
                                node.span,
                            )
                        })
                        .collect(),
                ),
                ResolvedType::Unknown,
                node.span,
            ),
        ));
        if let Some(label) = operation.label
            && let Some(message) = self.decode_message_value(operation.module, &label)
        {
            form.props.push((
                "submit".to_string(),
                TypedExpr::new(
                    IrExpr::Message(message),
                    ResolvedType::Scalar(Scalar::Text),
                    node.span,
                ),
            ));
        }
        Some(form)
    }

    fn decode_form(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        let mut props = Vec::new();
        let target = ui_attributes(self.db, node)
            .into_iter()
            .find(|(name, _)| name == "action")
            .and_then(|(_, value)| value)
            .or_else(|| {
                kids(node)
                    .iter()
                    .find(|n| {
                        matches!(
                            n.kind,
                            SyntaxKind::Member | SyntaxKind::Path | SyntaxKind::NameRef
                        )
                    })
                    .copied()
            });
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
        let attributes = ui_attributes(self.db, node);
        let has_submit = attributes.iter().any(|(name, _)| name == "submit");
        for (name, value) in attributes {
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
                        let decoded = self.decode_expr(scope, value);
                        if name == "submit" {
                            self.check_ui_message_parameter_profile(value, &decoded);
                        }
                        props.push((name, decoded));
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
        if let Some(op) = operation_target {
            self.bind_form_records(scope, op, node.span, &mut props);
        }
        if !has_submit
            && let Some(operation) = operation_target
                .and_then(|op| self.program.effects.crud_ops.get(&op))
                .cloned()
            && let Some(label) = operation.label
            && let Some(message) = self.decode_message_value(operation.module, &label)
        {
            props.push((
                "submit".to_string(),
                TypedExpr::new(
                    IrExpr::Message(message),
                    ResolvedType::Scalar(Scalar::Text),
                    node.span,
                ),
            ));
        }
        let bound_fields: Option<HashSet<String>> =
            match props.iter().find(|(name, _)| name == "arguments") {
                None => Some(HashSet::new()),
                Some((_, arguments)) => match &arguments.expr {
                    IrExpr::Object(fields) => {
                        Some(fields.iter().map(|(name, _)| name.clone()).collect())
                    }
                    _ => None,
                },
            };
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
                            .filter(|field| {
                                !bound_fields
                                    .as_ref()
                                    .is_some_and(|bound| bound.contains(*field))
                            })
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
        owned.field_operation = operation_target;
        owned.form_bound_fields = bound_fields;
        owned.form_fields =
            props
                .iter()
                .find(|(name, _)| name == "fields")
                .and_then(|(_, fields)| {
                    let IrExpr::Array(fields) = &fields.expr else {
                        return None;
                    };
                    fields
                        .iter()
                        .map(|field| match &field.expr {
                            IrExpr::Text(name) => Some(name.clone()),
                            _ => None,
                        })
                        .collect()
                });
        if ui_owns_submit(self.db, node) {
            props.push((
                "authoredSubmit".into(),
                TypedExpr::new(
                    IrExpr::Bool(true),
                    ResolvedType::Scalar(Scalar::Bool),
                    node.span,
                ),
            ));
        }
        let children = self.decode_ui_children(&owned, node, row_ctx);
        let gate = self.decode_gate(scope, node);
        Some(IrUi {
            view: None,
            factory: "form".to_string(),
            props,
            children,
            row_scope: None,
            gate,
            span: node.span,
        })
    }

    /// DESIGN's enclosing-record rule is lexical: no queries, name preference,
    /// or nearest-row fallback resolve an ambiguous model. Authored arguments
    /// win independently for each input, and unknown object shapes stay loud.
    fn bind_form_records(
        &self,
        scope: &Scope,
        op: SymbolId,
        span: Span,
        props: &mut Vec<(String, TypedExpr)>,
    ) {
        let mut expected = Vec::new();
        match &self.program.symbols[op.0 as usize].kind {
            SymbolKind::Scenario { params, .. } | SymbolKind::CapabilityOp { params, .. } => {
                for param in params {
                    if let Some(ty) = self.program.types.symbol_types.get(param)
                        && let ResolvedType::Record {
                            symbol,
                            stored: true,
                        } = ty.nullable_inner().unwrap_or(ty)
                    {
                        expected
                            .push((self.program.symbols[param.0 as usize].name.clone(), *symbol));
                    }
                }
            }
            SymbolKind::CrudOp { model, op } => match op {
                CrudOp::Update | CrudOp::Delete => expected.push(("record".into(), *model)),
                CrudOp::Create => {
                    if let SymbolKind::Model {
                        owner: ModelOwner::ChildOf(parent),
                        ..
                    } = self.program.symbols[model.0 as usize].kind
                    {
                        expected.push(("parent".into(), parent));
                    }
                }
            },
            _ => return,
        }
        let authored = props.iter().position(|(name, _)| name == "arguments");
        let mut arguments = match authored {
            Some(index) => match &props[index].1.expr {
                IrExpr::Object(fields) => fields.clone(),
                _ => return,
            },
            None => Vec::new(),
        };
        let authored_count = arguments.len();
        for (name, model) in expected {
            if arguments.iter().any(|(bound, _)| bound == &name) {
                continue;
            }
            let mut matches = scope
                .enclosing_records
                .iter()
                .filter(|(id, _)| *id == model);
            if let Some((_, row)) = matches.next()
                && matches.next().is_none()
            {
                arguments.push((
                    name,
                    TypedExpr::new(
                        IrExpr::Name(row.clone()),
                        ResolvedType::Record {
                            symbol: model,
                            stored: true,
                        },
                        span,
                    ),
                ));
            }
        }
        if arguments.len() == authored_count {
            return;
        }
        let value = TypedExpr::new(IrExpr::Object(arguments), ResolvedType::Unknown, span);
        match authored {
            Some(index) => props[index].1 = value,
            None => props.push(("arguments".into(), value)),
        }
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

    /// The collection filter is an enum-field declaration, not a query parser
    /// or an authorization grant. Its receiving preference remains page-owned.
    /// Decode a board's `by=` enum grouping: one owned enum field whose
    /// case names partition rows into groups.
    fn decode_board_grouping(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        model: SymbolId,
    ) -> Option<TypedExpr> {
        let mut fail = || {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower board: board groups by one owned enum field".to_string(),
                node.span,
            ));
        };
        let group = ui_attributes(self.db, node)
            .into_iter()
            .find(|(name, _)| name == "by")
            .and_then(|(_, value)| value);
        let Some(group) = group else {
            fail();
            return None;
        };
        let paths: Vec<&SyntaxNode> = if group.kind == SyntaxKind::Selectors {
            kids(group).into_iter().collect()
        } else {
            vec![group]
        };
        let [path] = paths.as_slice() else {
            fail();
            return None;
        };
        let names = selector_strings(self.db, path);
        let name = names
            .first()
            .filter(|_| names.len() == 1 && path.kind == SyntaxKind::Path)
            .cloned();
        let field_id =
            name.as_ref()
                .and_then(|name| self.fields.get(&(model, name.clone())).copied());
        let owned = name.as_ref().is_some_and(|name| {
            field_id.is_some_and(|field_id| {
                self.program.symbols.get(field_id.0 as usize).is_some_and(|symbol| {
                    symbol.id == field_id
                        && symbol.name == *name
                        && symbol.module == scope.module
                        && matches!(&symbol.kind, SymbolKind::Field { owner, .. } if *owner == model)
                        && self.program.symbols.get(model.0 as usize).is_some_and(|item| {
                            matches!(&item.kind, SymbolKind::Model { fields, .. } if fields.contains(&field_id))
                        })
                }) && self.program.types.symbol_types.get(&field_id).is_some_and(|ty| {
                    matches!(ty, ResolvedType::Enum { cases, .. } if !cases.is_empty())
                })
            })
        });
        if !owned {
            fail();
            return None;
        }
        Some(TypedExpr::new(
            IrExpr::Text(name.unwrap_or_default()),
            ResolvedType::Scalar(Scalar::Text),
            path.span,
        ))
    }

    /// B13: own one bool preference leaf behind a computed filter
    /// default. The leaf must name an owned bool preference field of this
    /// module whose checked read type is exactly the leaf type: plain
    /// `bool` or nullable bool. Both read spellings decode at the checked
    /// typed reader, so both may enter operator positions.
    fn owned_bool_preference(
        &self,
        scope: &Scope,
        field: &str,
        ty: &ResolvedType,
    ) -> Option<(SymbolId, SymbolId)> {
        let inner = ty.nullable_inner().unwrap_or(ty);
        if inner != &ResolvedType::Scalar(Scalar::Bool) {
            return None;
        }
        let found = self.program.symbols.iter().find(|symbol| {
            symbol.name.as_str() == field
                && symbol.module == scope.module
                && matches!(&symbol.kind, SymbolKind::Field { owner, .. }
                    if self.program.symbols.get(owner.0 as usize).is_some_and(|item| {
                        item.module == scope.module
                            && matches!(&item.kind, SymbolKind::Preferences { fields } if fields.contains(&symbol.id))
                    }))
        })?;
        if self.program.types.symbol_types.get(&found.id) != Some(ty) {
            return None;
        }
        let SymbolKind::Field { owner, .. } = &found.kind else {
            return None;
        };
        Some((found.id, *owner))
    }

    /// B13: admit one derive-helper call returning bool over admitted
    /// arguments. The target must resolve to a checked derive function;
    /// call-site visibility was already scoped by checking, so imported
    /// and local helpers agree here.
    fn bool_preference_call(
        &self,
        scope: &Scope,
        target: &IrCallTarget,
        args: &[TypedExpr],
        expr: &TypedExpr,
        out: &mut Vec<(SymbolId, SymbolId, bool)>,
    ) -> bool {
        let IrCallTarget::DeriveFn(canonical) = target else {
            return false;
        };
        expr.ty == ResolvedType::Scalar(Scalar::Bool)
            && self.program.symbols.iter().any(|symbol| {
                symbol.canonical.as_str() == canonical.as_str()
                    && matches!(&symbol.kind, SymbolKind::DeriveFn { .. })
            })
            && args
                .iter()
                .all(|arg| self.collect_bool_preference_leaves(scope, arg, out))
    }

    /// B13: admit one computed bool filter default, collecting the owned
    /// bool preference leaves it reads. The checked type does the work:
    /// the root must type exactly `bool`, every `preferences.*` leaf must
    /// read an owned (nullable-)bool preference field of this module, and
    /// every other node must be a pure value form (a bool literal, a
    /// boolean operator, or a checked derive-helper call returning bool).
    /// Reads decode at the checked typed reader, so operator positions
    /// only consume already-boolean values; anything else keeps the
    /// refusal in the caller. `out` is only read when this returns true.
    fn collect_bool_preference_leaves(
        &self,
        scope: &Scope,
        expr: &TypedExpr,
        out: &mut Vec<(SymbolId, SymbolId, bool)>,
    ) -> bool {
        match &expr.expr {
            IrExpr::Bool(_) => expr.ty == ResolvedType::Scalar(Scalar::Bool),
            IrExpr::Member { base, field } => {
                if !matches!(&base.expr, IrExpr::Name(name) if name == "preferences") {
                    return false;
                }
                let nullable = match &expr.ty {
                    ResolvedType::Scalar(Scalar::Bool) => false,
                    ResolvedType::Nullable(inner)
                        if inner.as_ref() == &ResolvedType::Scalar(Scalar::Bool) =>
                    {
                        true
                    }
                    _ => return false,
                };
                let Some((field_id, owner)) = self.owned_bool_preference(scope, field, &expr.ty)
                else {
                    return false;
                };
                out.push((field_id, owner, nullable));
                true
            }
            IrExpr::Binary { left, right, .. } => {
                expr.ty == ResolvedType::Scalar(Scalar::Bool)
                    && self.collect_bool_preference_leaves(scope, left, out)
                    && self.collect_bool_preference_leaves(scope, right, out)
            }
            IrExpr::Unary { operand, .. } => {
                expr.ty == ResolvedType::Scalar(Scalar::Bool)
                    && self.collect_bool_preference_leaves(scope, operand, out)
            }
            IrExpr::Call { target, args } => {
                self.bool_preference_call(scope, target, args, expr, out)
            }
            IrExpr::BoundCall {
                target,
                args,
                slots,
            } => {
                slots.iter().all(|slot| slot.is_some())
                    && self.bool_preference_call(scope, target, args, expr, out)
            }
            _ => false,
        }
    }

    /// B13: register one owned bool preference leaf behind a filter
    /// default, sharing the direct-read descriptor contract: the entry is
    /// nullable exactly when the leaf read is, carries the bool-case
    /// options, and records the declared literal default. A missing
    /// field, a server-owned field, a missing non-nullable default, or a
    /// non-literal default keeps the refusal in the caller.
    fn register_bool_filter_preference(
        &mut self,
        word: &str,
        field_id: SymbolId,
        owner: SymbolId,
        nullable: bool,
        options: &[String],
        span: Span,
    ) -> Option<()> {
        let refuse = || {
            Diagnostic::error(
                "E6008",
                format!(
                    "{word} filters need distinct checked owned enum fields and matching defaults"
                ),
                span,
            )
        };
        let Some(symbol) = self.program.symbols.get(field_id.0 as usize).cloned() else {
            self.diags.push(refuse());
            return None;
        };
        let (_, default, server, _, _, _) = self.decode_field(&symbol, owner);
        let default_value = match default {
            Some(IrDefault::Literal(value)) => match value.expr {
                IrExpr::Bool(selected) => Some(selected.to_string()),
                IrExpr::Null if nullable => None,
                _ => {
                    self.diags.push(refuse());
                    return None;
                }
            },
            None if nullable => None,
            _ => {
                self.diags.push(refuse());
                return None;
            }
        };
        if server.is_some() {
            self.diags.push(refuse());
            return None;
        }
        if !self
            .page_preference_fields
            .iter()
            .any(|field| field.name == symbol.name)
        {
            let label = self.decode_reused_field_label_parts(&symbol);
            self.page_preference_fields.push(IrPreferenceField {
                name: symbol.name,
                options: options.to_vec(),
                default_value,
                nullable,
                caption: label.as_ref().and_then(|label| label.text.clone()),
                option_labels: label.map(|label| label.values).unwrap_or_default(),
                reference: false,
            });
        }
        Some(())
    }

    /// B14: own one enum preference leaf behind a computed filter
    /// default. The leaf must name an owned enum preference field of this
    /// module whose checked read type is the filter's owned enum or its
    /// nullable form. Saved enum values are already case spellings, so
    /// reads lower verbatim and the host preparer refuses unknown
    /// spellings against the column inventory; no decoding wrapper and
    /// no truthiness apply.
    fn owned_enum_preference(
        &self,
        scope: &Scope,
        field: &str,
        ty: &ResolvedType,
        expected: &ResolvedType,
    ) -> Option<(SymbolId, SymbolId)> {
        if !matches!(expected, ResolvedType::Enum { .. }) {
            return None;
        }
        let leaf = ty == expected
            || matches!(ty, ResolvedType::Nullable(inner) if inner.as_ref() == expected);
        if !leaf {
            return None;
        }
        let found = self.program.symbols.iter().find(|symbol| {
            symbol.name.as_str() == field
                && symbol.module == scope.module
                && matches!(&symbol.kind, SymbolKind::Field { owner, .. }
                    if self.program.symbols.get(owner.0 as usize).is_some_and(|item| {
                        item.module == scope.module
                            && matches!(&item.kind, SymbolKind::Preferences { fields } if fields.contains(&symbol.id))
                    }))
        })?;
        if self.program.types.symbol_types.get(&found.id) != Some(ty) {
            return None;
        }
        let SymbolKind::Field { owner, .. } = &found.kind else {
            return None;
        };
        Some((found.id, *owner))
    }

    /// B14: admit one derive-helper call returning the filter's owned
    /// enum (or its nullable form) over admitted arguments. The target
    /// must resolve to a checked derive function; call-site visibility
    /// was already scoped by checking, so imported and local helpers
    /// agree here.
    fn enum_preference_call(
        &self,
        scope: &Scope,
        target: &IrCallTarget,
        args: &[TypedExpr],
        expr: &TypedExpr,
        expected: &ResolvedType,
        out: &mut Vec<(SymbolId, SymbolId, bool)>,
    ) -> bool {
        let IrCallTarget::DeriveFn(canonical) = target else {
            return false;
        };
        (expr.ty == *expected
            || matches!(&expr.ty, ResolvedType::Nullable(inner) if inner.as_ref() == expected))
            && self.program.symbols.iter().any(|symbol| {
                symbol.canonical.as_str() == canonical.as_str()
                    && matches!(&symbol.kind, SymbolKind::DeriveFn { .. })
            })
            && args
                .iter()
                .all(|arg| self.collect_enum_preference_leaves(scope, arg, expected, out))
    }

    /// B14: admit one computed enum filter default, collecting the owned
    /// enum preference leaves it reads. The checked type does the work:
    /// every node must type as the filter's owned enum or its nullable
    /// form, every `preferences.*` leaf must read an owned preference
    /// field of that enum of this module, and every other node must be a
    /// pure value form (a `??` fallback over admitted reads or a checked
    /// derive-helper call returning the enum). Enum has no non-null
    /// literal spelling, so computed defaults over nullable saved reads
    /// stay nullable-typed; null stays absent at the host preparer
    /// exactly like a cleared saved read, never a case. Anything else
    /// keeps the refusal in the caller. `out` is only read when this
    /// returns true.
    fn collect_enum_preference_leaves(
        &self,
        scope: &Scope,
        expr: &TypedExpr,
        expected: &ResolvedType,
        out: &mut Vec<(SymbolId, SymbolId, bool)>,
    ) -> bool {
        if !matches!(expected, ResolvedType::Enum { .. }) {
            return false;
        }
        let typed = expr.ty == *expected
            || matches!(&expr.ty, ResolvedType::Nullable(inner) if inner.as_ref() == expected);
        if !typed {
            return false;
        }
        match &expr.expr {
            IrExpr::Member { base, field } => {
                if !matches!(&base.expr, IrExpr::Name(name) if name == "preferences") {
                    return false;
                }
                let nullable = expr.ty != *expected;
                let Some((field_id, owner)) =
                    self.owned_enum_preference(scope, field, &expr.ty, expected)
                else {
                    return false;
                };
                out.push((field_id, owner, nullable));
                true
            }
            IrExpr::Binary { left, right, .. } => {
                self.collect_enum_preference_leaves(scope, left, expected, out)
                    && self.collect_enum_preference_leaves(scope, right, expected, out)
            }
            IrExpr::Call { target, args } => {
                self.enum_preference_call(scope, target, args, expr, expected, out)
            }
            IrExpr::BoundCall {
                target,
                args,
                slots,
            } => {
                slots.iter().all(|slot| slot.is_some())
                    && self.enum_preference_call(scope, target, args, expr, expected, out)
            }
            _ => false,
        }
    }

    /// B14: register one owned enum preference leaf behind a filter
    /// default, sharing the direct-read descriptor contract: the entry is
    /// nullable exactly when the leaf read is, carries the enum-case
    /// options, and records the declared literal default. A missing
    /// field, a server-owned field, a missing non-nullable default, or a
    /// non-literal default keeps the refusal in the caller.
    fn register_enum_filter_preference(
        &mut self,
        word: &str,
        field_id: SymbolId,
        owner: SymbolId,
        nullable: bool,
        options: &[String],
        span: Span,
    ) -> Option<()> {
        let refuse = || {
            Diagnostic::error(
                "E6008",
                format!(
                    "{word} filters need distinct checked owned enum fields and matching defaults"
                ),
                span,
            )
        };
        let Some(symbol) = self.program.symbols.get(field_id.0 as usize).cloned() else {
            self.diags.push(refuse());
            return None;
        };
        let (_, default, server, _, _, _) = self.decode_field(&symbol, owner);
        let default_value = match default {
            Some(IrDefault::Literal(value)) => match value.expr {
                IrExpr::Text(case) if options.contains(&case) => Some(case),
                IrExpr::Null if nullable => None,
                _ => {
                    self.diags.push(refuse());
                    return None;
                }
            },
            None if nullable => None,
            _ => {
                self.diags.push(refuse());
                return None;
            }
        };
        if server.is_some() {
            self.diags.push(refuse());
            return None;
        }
        if !self
            .page_preference_fields
            .iter()
            .any(|field| field.name == symbol.name)
        {
            let label = self.decode_reused_field_label_parts(&symbol);
            self.page_preference_fields.push(IrPreferenceField {
                name: symbol.name,
                options: options.to_vec(),
                default_value,
                nullable,
                caption: label.as_ref().and_then(|label| label.text.clone()),
                option_labels: label.map(|label| label.values).unwrap_or_default(),
                reference: false,
            });
        }
        Some(())
    }

    /// Register one owned reference preference leaf behind a filter
    /// default, sharing the direct-read descriptor contract with no
    /// spellings: the entry carries no case options and no literal
    /// default, is nullable exactly when the leaf read is, and records a
    /// server-owned field, a missing non-nullable default, or a
    /// non-literal default as a refusal in the caller. The saved
    /// identity stays opaque end to end (DESIGN 977): it is never an
    /// enum spelling.
    fn register_reference_filter_preference(
        &mut self,
        word: &str,
        field_id: SymbolId,
        owner: SymbolId,
        nullable: bool,
        span: Span,
    ) -> Option<()> {
        let refuse = || {
            Diagnostic::error(
                "E6008",
                format!(
                    "{word} filters need distinct checked owned enum fields and matching defaults"
                ),
                span,
            )
        };
        let Some(symbol) = self.program.symbols.get(field_id.0 as usize).cloned() else {
            self.diags.push(refuse());
            return None;
        };
        let (_, default, server, _, _, _) = self.decode_field(&symbol, owner);
        let default_value = match default {
            Some(IrDefault::Literal(value)) => match value.expr {
                IrExpr::Null if nullable => None,
                _ => {
                    self.diags.push(refuse());
                    return None;
                }
            },
            None if nullable => None,
            _ => {
                self.diags.push(refuse());
                return None;
            }
        };
        if server.is_some() {
            self.diags.push(refuse());
            return None;
        }
        if !self
            .page_preference_fields
            .iter()
            .any(|field| field.name == symbol.name)
        {
            let label = self.decode_reused_field_label_parts(&symbol);
            self.page_preference_fields.push(IrPreferenceField {
                name: symbol.name,
                options: Vec::new(),
                default_value,
                nullable,
                caption: label.as_ref().and_then(|label| label.text.clone()),
                option_labels: label.map(|label| label.values).unwrap_or_default(),
                reference: true,
            });
        }
        Some(())
    }

    fn decode_collection_filters(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        model: SymbolId,
        word: &str,
    ) -> Option<Vec<(String, TypedExpr)>> {
        let attrs = ui_attributes(self.db, node);
        let filter = attrs
            .iter()
            .find(|(name, _)| name == "filter")
            .and_then(|(_, value)| *value);
        let defaults = attrs
            .iter()
            .find(|(name, _)| name == "defaults")
            .and_then(|(_, value)| *value);
        if filter.is_none() && defaults.is_none() {
            return Some(Vec::new());
        }
        let fail = |this: &mut Self, span: Span| {
            this.diags.push(Diagnostic::error(
                "E6008",
                format!(
                    "{word} filters need distinct checked owned enum fields and matching defaults"
                ),
                span,
            ));
        };
        let Some(filter) = filter.filter(|value| value.kind == SyntaxKind::Selectors) else {
            fail(self, node.span);
            return None;
        };
        let text = |value: String, span: Span| {
            TypedExpr::new(
                IrExpr::Text(value),
                ResolvedType::Scalar(Scalar::Text),
                span,
            )
        };
        let mut selected = HashMap::new();
        let mut columns = Vec::new();
        for path in kids(filter) {
            if path.kind == SyntaxKind::Punct && slice(self.db, path.span) == "," {
                continue;
            }
            let names = selector_strings(self.db, path);
            let Some(name) = names
                .first()
                .filter(|_| names.len() == 1 && path.kind == SyntaxKind::Path)
            else {
                fail(self, path.span);
                return None;
            };
            let Some(field_id) = self.fields.get(&(model, name.clone())).copied() else {
                fail(self, path.span);
                return None;
            };
            let Some(symbol) = self.program.symbols.get(field_id.0 as usize).cloned() else {
                fail(self, path.span);
                return None;
            };
            let Some(ty) = self.program.types.symbol_types.get(&field_id).cloned() else {
                fail(self, path.span);
                return None;
            };
            // A filter selector is a distinct owned finite-choice field: an
            // owned enum, a plain bool (the recorded `active`/`done`
            // toggle shapes), or a user/member/model reference compared by
            // typed opaque identity (DESIGN 977: reference equality is not
            // an enum spelling, so no case inventory applies). Anything
            // else keeps the exact E6008 below.
            let (type_text, cases) = match &ty {
                ResolvedType::Enum {
                    cases,
                    owner: Some(enum_owner),
                } if !cases.is_empty()
                    && cases.iter().collect::<HashSet<_>>().len() == cases.len()
                    && self.program.types.symbol_types.get(enum_owner) == Some(&ty) =>
                {
                    (format!("enum:{}", self.type_id(&ty)), cases.clone())
                }
                ResolvedType::Scalar(Scalar::Bool) => (
                    "bool".to_string(),
                    vec!["true".to_string(), "false".to_string()],
                ),
                ResolvedType::Record { symbol, .. }
                    if self.program.symbols.get(symbol.0 as usize).is_some_and(|item| {
                        matches!(&item.kind, SymbolKind::Model { .. })
                    }) =>
                {
                    (format!("ref:{}", self.type_id(&ty)), Vec::new())
                }
                ResolvedType::Scalar(Scalar::User) => ("user".to_string(), Vec::new()),
                ResolvedType::Scalar(Scalar::Member) => ("member".to_string(), Vec::new()),
                _ => {
                    fail(self, path.span);
                    return None;
                }
            };
            if symbol.id != field_id || symbol.name != *name
                || !matches!(symbol.kind, SymbolKind::Field { owner, .. } if owner == model)
                || !self.program.symbols.get(model.0 as usize).is_some_and(|item| item.module == symbol.module && matches!(&item.kind, SymbolKind::Model { fields, .. } if fields.contains(&field_id)))
                || selected
                    .insert(name.clone(), (ty.clone(), cases.clone()))
                    .is_some()
            { fail(self,path.span); return None; }
            let label = self.decode_reused_field_label_parts(&symbol);
            let caption = label
                .as_ref()
                .and_then(|label| label.text.as_ref())
                .map(|caption| {
                    TypedExpr::new(
                        IrExpr::Message(caption.clone()),
                        ResolvedType::Scalar(Scalar::Text),
                        path.span,
                    )
                })
                .unwrap_or_else(|| text(name.clone(), path.span));
            let value_labels = cases
                .iter()
                .map(|case| {
                    let caption = label
                        .as_ref()
                        .and_then(|label| label.values.iter().find(|(value, _)| value == case))
                        .map(|(_, caption)| {
                            TypedExpr::new(
                                IrExpr::Message(caption.clone()),
                                ResolvedType::Scalar(Scalar::Text),
                                path.span,
                            )
                        })
                        .unwrap_or_else(|| text(case.clone(), path.span));
                    (case.clone(), caption)
                })
                .collect();
            columns.push(TypedExpr::new(
                IrExpr::Object(vec![
                    ("field".to_string(), text(name.clone(), path.span)),
                    ("label".to_string(), caption),
                    ("type".to_string(), text(type_text, path.span)),
                    (
                        "valueLabels".to_string(),
                        TypedExpr::new(
                            IrExpr::Object(value_labels),
                            ResolvedType::Unknown,
                            path.span,
                        ),
                    ),
                ]),
                ResolvedType::Unknown,
                path.span,
            ));
        }
        if columns.is_empty() {
            fail(self, filter.span);
            return None;
        }
        let mut props = vec![(
            "filter".to_string(),
            TypedExpr::new(IrExpr::Array(columns), ResolvedType::Unknown, filter.span),
        )];
        if let Some(defaults) = defaults {
            if defaults.kind != SyntaxKind::Object {
                fail(self, defaults.span);
                return None;
            }
            let mut seen = HashSet::new();
            let mut entries = Vec::new();
            for entry in kids(defaults)
                .into_iter()
                .filter(|entry| entry.kind == SyntaxKind::ObjectEntry)
            {
                let parts = kids(entry);
                let name = parts.first().and_then(|part| name_text(self.db, part));
                let value = parts
                    .iter()
                    .find(|part| is_expression(part.kind) && part.kind != SyntaxKind::Argument)
                    .copied();
                let Some((name, value)) = name.zip(value) else {
                    fail(self, entry.span);
                    return None;
                };
                let Some((expected, field_cases)) = selected.get(&name) else {
                    fail(self, entry.span);
                    return None;
                };
                if !seen.insert(name.clone()) {
                    fail(self, entry.span);
                    return None;
                }
                let decoded = self.decode_expr(scope, value);
                let bool_filter = matches!(expected, ResolvedType::Scalar(Scalar::Bool));
                // A reference filter compares by typed opaque identity
                // (DESIGN 977), never enum spellings: no literal or
                // computed default forms apply, only a direct saved
                // reference read (or null) below.
                let ref_filter = matches!(
                    expected,
                    ResolvedType::Record { .. }
                        | ResolvedType::Scalar(Scalar::User | Scalar::Member)
                );
                let enum_cases = match expected {
                    ResolvedType::Enum { cases, .. } => Some(cases),
                    ResolvedType::Scalar(Scalar::Bool) => None,
                    ResolvedType::Record { .. }
                    | ResolvedType::Scalar(Scalar::User | Scalar::Member) => None,
                    _ => return None,
                };
                let literal = enum_cases.is_some_and(|cases| {
                    matches!(&decoded.expr, IrExpr::Text(case) if cases.contains(case) && (decoded.ty == *expected || matches!(decoded.ty, ResolvedType::Scalar(Scalar::Text))))
                }) || (bool_filter
                    && matches!(&decoded.expr, IrExpr::Bool(_))
                    && decoded.ty == *expected)
                    || matches!(
                        (&decoded.expr, &decoded.ty),
                        (IrExpr::Null, ResolvedType::Null)
                    );
                // B13: a computed bool default over decoded bool
                // preference reads (see `collect_bool_preference_leaves`).
                // Leaf registration below runs only when every leaf
                // resolved, sharing the direct-read descriptor contract.
                let mut nested = Vec::new();
                let computed = bool_filter
                    && !literal
                    && self.collect_bool_preference_leaves(scope, &decoded, &mut nested);
                if computed {
                    for (field_id, owner, nullable) in nested {
                        self.register_bool_filter_preference(
                            word,
                            field_id,
                            owner,
                            nullable,
                            field_cases,
                            value.span,
                        )?;
                    }
                }
                // B14: a computed enum default over owned enum
                // preference reads (see
                // `collect_enum_preference_leaves`). Leaf registration
                // below runs only when every leaf resolved, sharing the
                // direct-read descriptor contract.
                let mut enum_nested = Vec::new();
                let enum_computed = !bool_filter
                    && !literal
                    && self.collect_enum_preference_leaves(
                        scope,
                        &decoded,
                        expected,
                        &mut enum_nested,
                    );
                if enum_computed {
                    for (field_id, owner, nullable) in enum_nested {
                        self.register_enum_filter_preference(
                            word,
                            field_id,
                            owner,
                            nullable,
                            field_cases,
                            value.span,
                        )?;
                    }
                }
                if !literal && !computed && !enum_computed {
                    let mut identity = value;
                    while identity.kind == SyntaxKind::Group {
                        let Some(inner) = kids(identity)
                            .into_iter()
                            .find(|inner| is_expression(inner.kind))
                        else {
                            break;
                        };
                        identity = inner;
                    }
                    let Some(field_id) = self
                        .program
                        .types
                        .preference_field_references
                        .get(&NodeKey::of(identity))
                        .copied()
                    else {
                        fail(self, value.span);
                        return None;
                    };
                    let Some(symbol) = self.program.symbols.get(field_id.0 as usize).cloned()
                    else {
                        fail(self, value.span);
                        return None;
                    };
                    let SymbolKind::Field { owner, .. } = symbol.kind else {
                        fail(self, value.span);
                        return None;
                    };
                    let nullable = matches!(&decoded.ty, ResolvedType::Nullable(inner) if inner.as_ref() == expected);
                    if symbol.id != field_id || symbol.module != scope.module
                        || !matches!(&decoded.expr, IrExpr::Member { base,field } if field == &symbol.name && matches!(&base.expr,IrExpr::Name(name) if name == "preferences"))
                        || !(decoded.ty == *expected || nullable)
                        || self.program.types.symbol_types.get(&field_id) != Some(&decoded.ty)
                        || !self.program.symbols.get(owner.0 as usize).is_some_and(|item| matches!(&item.kind,SymbolKind::Preferences { fields } if fields.contains(&field_id)))
                    { fail(self,value.span); return None; }
                    if bool_filter {
                        // Direct bool reads share the computed-leaf
                        // descriptor contract exactly.
                        self.register_bool_filter_preference(
                            word,
                            field_id,
                            owner,
                            nullable,
                            field_cases,
                            value.span,
                        )?;
                    } else if ref_filter {
                        // Direct reference reads share the direct-read
                        // descriptor contract with no spellings: the saved
                        // identity stays opaque end to end.
                        self.register_reference_filter_preference(
                            word,
                            field_id,
                            owner,
                            nullable,
                            value.span,
                        )?;
                    } else {
                        let (_, default, server, _, _, _) = self.decode_field(&symbol, owner);
                        let default_value = match default {
                            Some(IrDefault::Literal(value)) => match value.expr {
                                IrExpr::Text(case)
                                    if enum_cases.is_some_and(|known| known.contains(&case)) =>
                                {
                                    Some(case)
                                }
                                IrExpr::Null if nullable => None,
                                _ => {
                                    fail(self, value.span);
                                    return None;
                                }
                            },
                            None if nullable => None,
                            _ => {
                                fail(self, value.span);
                                return None;
                            }
                        };
                        if server.is_some() {
                            fail(self, value.span);
                            return None;
                        }
                        if !self
                            .page_preference_fields
                            .iter()
                            .any(|field| field.name == symbol.name)
                        {
                            let label = self.decode_reused_field_label_parts(&symbol);
                            self.page_preference_fields.push(IrPreferenceField {
                                name: symbol.name,
                                options: field_cases.clone(),
                                default_value,
                                nullable,
                                caption: label.as_ref().and_then(|label| label.text.clone()),
                                option_labels: label.map(|label| label.values).unwrap_or_default(),
                reference: false,
            });
                        }
                    }
                }
                entries.push((name, decoded));
            }
            props.push((
                "defaults".to_string(),
                TypedExpr::new(
                    IrExpr::Object(entries),
                    ResolvedType::Unknown,
                    defaults.span,
                ),
            ));
        }
        Some(props)
    }

    /// Decode a standalone saved-preference control. It reuses the owned
    /// finite-choice declaration and the current page's versioned save
    /// binding; sibling collections retain independent request selectors.
    /// Unsupported declarations keep the exact E6008 below.
    fn decode_standalone_filter(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        word: &str,
    ) -> Option<IrUi> {
        self.check_ui_attributes(node, word, &[]);
        let fail = |this: &mut Self, span: Span| {
            this.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower filter: filter takes one saved finite-choice preference".to_string(),
                span,
            ));
        };
        let headers: Vec<&SyntaxNode> = kids(node)
            .iter()
            .filter(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
            .copied()
            .collect();
        let [header] = headers.as_slice() else {
            fail(self, node.span);
            return None;
        };
        if !ui_attributes(self.db, node).is_empty()
            || kids(node).iter().any(|n| is_ui_node(n.kind))
        {
            fail(self, node.span);
            return None;
        }
        let mut identity = *header;
        while identity.kind == SyntaxKind::Group {
            let Some(inner) = kids(identity)
                .into_iter()
                .find(|inner| is_expression(inner.kind))
            else {
                break;
            };
            identity = inner;
        }
        let decoded = self.decode_expr(scope, identity);
        let Some(pref_id) = self
            .program
            .types
            .preference_field_references
            .get(&NodeKey::of(identity))
            .copied()
        else {
            fail(self, header.span);
            return None;
        };
        let Some(pref_symbol) = self.program.symbols.get(pref_id.0 as usize).cloned() else {
            fail(self, header.span);
            return None;
        };
        let SymbolKind::Field { owner: pref_owner, .. } = pref_symbol.kind else {
            fail(self, header.span);
            return None;
        };
        if pref_symbol.id != pref_id || pref_symbol.module != scope.module
            || !matches!(&decoded.expr, IrExpr::Member { base, field } if field == &pref_symbol.name && matches!(&base.expr, IrExpr::Name(name) if name == "preferences"))
            || !self.program.symbols.get(pref_owner.0 as usize).is_some_and(|item| matches!(&item.kind, SymbolKind::Preferences { fields } if fields.contains(&pref_id)))
        {
            fail(self, header.span);
            return None;
        }
        // The preference reuses one owned model field; that field owns the
        // finite-choice column exactly as a collection filter selector does.
        let Some(model_field_id) = self
            .program
            .types
            .field_reuse_sources
            .get(&pref_id)
            .copied()
        else {
            fail(self, header.span);
            return None;
        };
        let Some(model_symbol) = self.program.symbols.get(model_field_id.0 as usize).cloned()
        else {
            fail(self, header.span);
            return None;
        };
        let SymbolKind::Field { owner: model, .. } = model_symbol.kind else {
            fail(self, header.span);
            return None;
        };
        let Some(model_ty) = self.program.types.symbol_types.get(&model_field_id).cloned()
        else {
            fail(self, header.span);
            return None;
        };
        let nullable = matches!(&decoded.ty, ResolvedType::Nullable(inner) if inner.as_ref() == &model_ty);
        if model_symbol.id != model_field_id || decoded.ty != model_ty && !nullable
            || !matches!(model_symbol.kind, SymbolKind::Field { owner, .. } if owner == model)
            || !self.program.symbols.get(model.0 as usize).is_some_and(|item| item.module == model_symbol.module && matches!(&item.kind, SymbolKind::Model { fields, .. } if fields.contains(&model_field_id)))
        {
            fail(self, header.span);
            return None;
        }
        let text = |value: String, span: Span| {
            TypedExpr::new(
                IrExpr::Text(value),
                ResolvedType::Scalar(Scalar::Text),
                span,
            )
        };
        let cases = match &model_ty {
            ResolvedType::Enum {
                cases,
                owner: Some(enum_owner),
            } if !cases.is_empty()
                && cases.iter().collect::<HashSet<_>>().len() == cases.len()
                && self.program.types.symbol_types.get(enum_owner) == Some(&model_ty) =>
            {
                cases.clone()
            }
            ResolvedType::Scalar(Scalar::Bool) => {
                vec!["true".to_string(), "false".to_string()]
            }
            _ => {
                fail(self, header.span);
                return None;
            }
        };
        // B16: option labels come from the edited preference's own label
        // parts (the reuse chain already inherits the owned model field's
        // captions), the same source the page preference descriptor below
        // carries, so the control and the settings panel caption agree.
        let pref_label = self.decode_reused_field_label_parts(&pref_symbol);
        let options = cases
            .iter()
            .map(|case| {
                let caption = pref_label
                    .as_ref()
                    .and_then(|label| label.values.iter().find(|(value, _)| value == case))
                    .map(|(_, caption)| {
                        TypedExpr::new(
                            IrExpr::Message(caption.clone()),
                            ResolvedType::Scalar(Scalar::Text),
                            header.span,
                        )
                    })
                    .unwrap_or_else(|| text(case.clone(), header.span));
                TypedExpr::new(
                    IrExpr::Object(vec![
                        ("value".to_string(), text(case.clone(), header.span)),
                        ("label".to_string(), caption),
                    ]),
                    ResolvedType::Unknown,
                    header.span,
                )
            })
            .collect::<Vec<_>>();
        let binding_caption = pref_label.as_ref().and_then(|label| label.text.clone()).map(|caption| {
            TypedExpr::new(
                IrExpr::Message(caption),
                ResolvedType::Scalar(Scalar::Text),
                header.span,
            )
        });
        // The saved default registers the owning page preference exactly as
        // a collection default does; the shell renders both from the same
        // preference fields.
        let (_, default, server, _, _, _) = self.decode_field(&pref_symbol, pref_owner);
        let bool_filter = matches!(model_ty, ResolvedType::Scalar(Scalar::Bool));
        let enum_cases = match &model_ty {
            ResolvedType::Enum { cases, .. } => Some(cases),
            ResolvedType::Scalar(Scalar::Bool) => None,
            _ => None,
        };
        let default_value = match default {
            Some(IrDefault::Literal(value)) => match value.expr {
                IrExpr::Text(case)
                    if enum_cases.is_some_and(|known| known.contains(&case)) =>
                {
                    Some(case)
                }
                IrExpr::Bool(selected) if bool_filter => Some(selected.to_string()),
                IrExpr::Null if nullable => None,
                _ => {
                    fail(self, header.span);
                    return None;
                }
            },
            None if nullable => None,
            _ => {
                fail(self, header.span);
                return None;
            }
        };
        if server.is_some() {
            fail(self, header.span);
            return None;
        }
        if !self
            .page_preference_fields
            .iter()
            .any(|field| field.name == pref_symbol.name)
        {
            self.page_preference_fields.push(IrPreferenceField {
                name: pref_symbol.name.clone(),
                options: cases.clone(),
                default_value,
                nullable,
                caption: pref_label.as_ref().and_then(|label| label.text.clone()),
                option_labels: pref_label.map(|label| label.values).unwrap_or_default(),
                reference: false,
            });
        }
        // B16: the control edits the owning saved preference through the
        // existing page-preference save path (the descriptor entry above),
        // so it carries the bound-tabs binding shape — name, owned
        // finite-choice options, the saved read, its compare-and-set
        // version and the caller POST target — never the collection
        // descriptor the field-owner `filter()` control cannot consume.
        let ctx = TypedExpr::new(
            IrExpr::Name("c".to_string()),
            ResolvedType::Unknown,
            header.span,
        );
        let member = |base: TypedExpr, field: String| {
            TypedExpr::new(
                IrExpr::Member {
                    base: Box::new(base),
                    field,
                },
                ResolvedType::Unknown,
                header.span,
            )
        };
        let module_name = self
            .program
            .modules
            .iter()
            .find(|module| module.id == scope.module)?
            .name
            .clone();
        let version = member(
            member(
                member(ctx.clone(), "preferenceVersions".to_string()),
                module_name,
            ),
            pref_symbol.name.clone(),
        );
        let post_to = TypedExpr::new(
            IrExpr::Binary {
                op: IrBinOp::Coalesce,
                left: Box::new(member(ctx.clone(), "pollUrl".to_string())),
                right: Box::new(member(ctx, "path".to_string())),
            },
            ResolvedType::Scalar(Scalar::Text),
            header.span,
        );
        let binding = TypedExpr::new(
            IrExpr::Object(vec![
                ("name".to_string(), text(pref_symbol.name.clone(), header.span)),
                (
                    "options".to_string(),
                    TypedExpr::new(IrExpr::Array(options), ResolvedType::Unknown, header.span),
                ),
                ("current".to_string(), decoded),
                ("version".to_string(), version),
                ("postTo".to_string(), post_to),
            ]),
            ResolvedType::Unknown,
            header.span,
        );
        let mut props = vec![("binding".to_string(), binding)];
        if let Some(caption) = binding_caption {
            props.push(("caption".to_string(), caption));
        }
        Some(IrUi {
            view: None,
            factory: "filter".to_string(),
            props,
            children: Vec::new(),
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    fn decode_calendar_endpoint(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        model: SymbolId,
        name: &str,
    ) -> Option<TypedExpr> {
        let value = ui_attributes(self.db, node)
            .into_iter()
            .find(|(key, _)| key == name)
            .and_then(|(_, value)| value);
        let fact =
            value.and_then(|value| self.program.types.calendar_endpoint(&NodeKey::of(value)));
        let valid = fact.zip(value).is_some_and(|(fact, value)| {
            let paths: Vec<_> = kids(value).into_iter().filter(|path| path.kind == SyntaxKind::Path).collect();
            fact.collection == NodeKey::of(node) && fact.value == NodeKey::of(value)
                && paths.len() == 1 && fact.path == NodeKey::of(paths[0])
                && fact.module == scope.module && fact.model == model
                && selector_strings(self.db, value) == vec![fact.relative_path.clone()]
                && matches!(fact.ty, ResolvedType::Scalar(Scalar::Date | Scalar::Datetime))
                && self.program.types.symbol_types.get(&fact.field) == Some(&fact.ty)
                && self.program.symbols.get(model.0 as usize).is_some_and(|owner| {
                    owner.id == model && matches!(&owner.kind, SymbolKind::Model { fields, .. } if fields.contains(&fact.field))
                        && self.program.symbols.get(fact.field.0 as usize).is_some_and(|field| {
                            field.id == fact.field && field.module == owner.module && field.name == fact.relative_path
                                && matches!(field.kind, SymbolKind::Field { owner, .. } if owner == model)
                        })
                })
        });
        if !valid {
            self.diags.push(Diagnostic::error("E6008", format!("cannot lower calendar {name}: no matching checked nonnullable date/datetime model field"), value.map_or(node.span, |value| value.span)));
            return None;
        }
        let fact = fact?;
        Some(TypedExpr::new(
            IrExpr::Text(fact.relative_path.clone()),
            ResolvedType::Scalar(Scalar::Text),
            value?.span,
        ))
    }

    /// A paged owning Bool field is already the complete stable data filter.
    /// Resolve the actual stored declaration; no derive, path traversal,
    /// nullable field, captured expression or caller predicate enters it.
    fn checked_page_bool_predicate(
        &self,
        model: SymbolId,
        alias: &str,
        body: &TypedExpr,
    ) -> Option<IrExpr> {
        let IrExpr::Member { base, field } = &body.expr else {
            return None;
        };
        if body.ty != ResolvedType::Scalar(Scalar::Bool)
            || !matches!(&base.expr, IrExpr::Name(name) if name == alias)
            || !matches!(&base.ty, ResolvedType::Record { symbol, stored: true } if *symbol == model)
        {
            return None;
        }
        let field_id = *self.fields.get(&(model, field.clone()))?;
        let owner = self.program.symbols.get(model.0 as usize)?;
        let declaration = self.program.symbols.get(field_id.0 as usize)?;
        if !matches!(&owner.kind, SymbolKind::Model { fields, .. } if fields.contains(&field_id))
            || !matches!(declaration.kind, SymbolKind::Field { owner, .. } if owner == model)
            || declaration.module != owner.module
            || declaration.name != *field
            || self.program.types.symbol_types.get(&field_id)
                != Some(&ResolvedType::Scalar(Scalar::Bool))
        {
            return None;
        }
        Some(IrExpr::Object(vec![
            (
                "op".into(),
                TypedExpr::new(
                    IrExpr::Text("eq".into()),
                    ResolvedType::Scalar(Scalar::Text),
                    body.span,
                ),
            ),
            (
                "field".into(),
                TypedExpr::new(
                    IrExpr::Text(field.clone()),
                    ResolvedType::Scalar(Scalar::Text),
                    body.span,
                ),
            ),
            (
                "value".into(),
                TypedExpr::new(
                    IrExpr::Bool(true),
                    ResolvedType::Scalar(Scalar::Bool),
                    body.span,
                ),
            ),
        ]))
    }

    fn checked_page_time_predicate(
        &self,
        model: SymbolId,
        collection: &SyntaxNode,
        alias: &str,
        body: &TypedExpr,
    ) -> Option<CheckedPageTimePredicate> {
        let IrExpr::Binary { op, left, right } = &body.expr else {
            return None;
        };
        if !matches!(op, IrBinOp::Ge | IrBinOp::Lt)
            || body.ty != ResolvedType::Scalar(Scalar::Bool)
            || left.ty != ResolvedType::Scalar(Scalar::Datetime)
            || right.ty != ResolvedType::Scalar(Scalar::Datetime)
        {
            return None;
        }
        let IrExpr::Member { base, field } = &left.expr else {
            return None;
        };
        if !matches!(&base.expr, IrExpr::Name(name) if name == alias)
            || !matches!(&right.expr, IrExpr::Member { base, field }
                if field == "now" && matches!(&base.expr, IrExpr::Name(name) if name == "c"))
        {
            return None;
        }
        let field_id = *self.fields.get(&(model, field.clone()))?;
        let symbol = self.program.symbols.get(field_id.0 as usize)?;
        if !matches!(symbol.kind, SymbolKind::Field { owner, .. } if owner == model)
            || self.program.types.symbol_types.get(&field_id)
                != Some(&ResolvedType::Scalar(Scalar::Datetime))
        {
            return None;
        }
        Some(CheckedPageTimePredicate {
            model,
            model_name: self.canonical(model),
            field: field_id,
            field_name: field.clone(),
            field_span: symbol.span,
            operation: *op,
            collection_span: collection.span,
            predicate_span: body.span,
            pagination: None,
            source_paging_supported: !ui_attributes(self.db, collection)
                .iter()
                .any(|(name, _)| matches!(name.as_str(), "page" | "cursor")),
        })
    }

    /// Only a stored owning standard receipt supplies a copied inspection list.
    /// Shape-compatible parameters and constructed arrays confer no such fact.
    fn inspection_value_source(&mut self, scope: &Scope, head: &SyntaxNode) -> Option<TypedExpr> {
        let values = self.decode_expr(scope, head);
        let read = match &values.expr {
            IrExpr::Binary {
                op: IrBinOp::Coalesce,
                left,
                right,
            } if matches!(&right.expr, IrExpr::Array(items) if items.is_empty())
                && matches!(&right.ty, ResolvedType::Array { .. })
                && left.ty.nullable_inner() == Some(&right.ty)
                && values.ty == right.ty =>
            {
                left.as_ref()
            }
            IrExpr::DeliveryRead { .. } => &values,
            _ => return None,
        };
        let IrExpr::DeliveryRead {
            record,
            field,
            props,
            callback: None,
        } = &read.expr
        else {
            return None;
        };
        if props != &["result", "fields"] {
            return None;
        }
        let ResolvedType::Record {
            symbol: model,
            stored: true,
        } = &record.ty
        else {
            return None;
        };
        let IrExpr::Name(alias) = &record.expr else {
            return None;
        };
        if scope.name_types.get(alias) != Some(&record.ty)
            || scope.row_rewrite.get(alias) != Some(alias)
            || scope.in_field_owner
        {
            return None;
        }
        let field_id = self.fields.get(&(*model, field.clone()))?;
        let owning = self.program.symbols.get(field_id.0 as usize)?;
        if !matches!(owning.kind, SymbolKind::Field { owner, .. } if owner == *model)
            || !matches!(
                self.program.symbols.get(model.0 as usize)?.kind,
                SymbolKind::Model { .. }
            )
        {
            return None;
        }
        let field_type = self.program.types.symbol_types.get(field_id)?;
        let ResolvedType::StdDelivery { capability, op } =
            field_type.nullable_inner().unwrap_or(field_type)
        else {
            return None;
        };
        if op.result != "WorkflowInspection"
            || !std::ptr::eq(
                crate::analysis::catalog::std_operation(capability, op.name)?,
                *op,
            )
            || !matches!(&values.ty, ResolvedType::Array { .. })
        {
            return None;
        }
        Some(values)
    }

    /// A copied transcript retains the exact owning stored field and the
    /// released standard message schema, rather than admitting array shapes.
    fn text_message_value_source(&mut self, scope: &Scope, head: &SyntaxNode) -> Option<TypedExpr> {
        let values = self.decode_expr(scope, head);
        let ResolvedType::Array { element, .. } = &values.ty else {
            return None;
        };
        if crate::analysis::types::checked_standard_nominal_name(element) != Some("TextMessage") {
            return None;
        }
        let IrExpr::Member { base, field } = &values.expr else {
            return None;
        };
        let (
            IrExpr::Name(alias),
            ResolvedType::Record {
                symbol: model,
                stored: true,
            },
        ) = (&base.expr, &base.ty)
        else {
            return None;
        };
        if scope.in_field_owner
            || scope.name_types.get(alias) != Some(&base.ty)
            || scope.row_rewrite.get(alias) != Some(alias)
        {
            return None;
        }
        let field_id = self.fields.get(&(*model, field.clone()))?;
        let owner = self.program.symbols.get(model.0 as usize)?;
        let stored = self.program.symbols.get(field_id.0 as usize)?;
        if !matches!(&owner.kind, SymbolKind::Model { fields, .. } if fields.contains(field_id))
            || !matches!(stored.kind, SymbolKind::Field { owner, .. } if owner == *model)
            || stored.module != owner.module
            || self.program.types.symbol_types.get(field_id) != Some(&values.ty)
        {
            return None;
        }
        Some(values)
    }

    /// Bounded copied lists keep authored alias, gates and readonly children.
    fn decode_callback_value_list(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        head: &SyntaxNode,
        query: Option<&SyntaxNode>,
        inspection_values: Option<TypedExpr>,
    ) -> Option<IrUi> {
        let inspection = inspection_values.is_some();
        let messages = inspection_values.as_ref().is_some_and(|values| {
            matches!(&values.ty, ResolvedType::Array { element, .. }
                if crate::analysis::types::checked_standard_nominal_name(element) == Some("TextMessage"))
        });
        self.check_ui_attributes(node, "diagnostic list", &["empty"]);
        if ui_attributes(self.db, node)
            .iter()
            .any(|(name, value)| name != "empty" || value.is_none())
            || kids(node)
                .into_iter()
                .filter(|child| is_expression(child.kind))
                .count()
                != 1
        {
            self.diags.push(Diagnostic::error("E6008", "diagnostic value list requires one copied array and only its supported empty caption".to_string(), node.span));
            return None;
        }
        let ty = self.node_type(head);
        let ResolvedType::Array { element, .. } = &ty else {
            return None;
        };
        let source_owned = if inspection {
            true
        } else if head.kind == SyntaxKind::Array {
            let values = kids(head)
                .into_iter()
                .filter(|child| is_expression(child.kind))
                .collect::<Vec<_>>();
            !values.is_empty()
                && values.iter().all(|value| {
                    self.program
                        .types
                        .callback_diagnostic_reads()
                        .get(&NodeKey::of(value))
                        .is_some_and(|read| {
                            read.matches(self.program) && self.callback_source_matches(&read.source)
                        })
                })
        } else if head.kind == SyntaxKind::Member {
            let parts = kids(head);
            let base = parts
                .iter()
                .find(|child| is_expression(child.kind))
                .copied();
            parts
                .iter()
                .rev()
                .find_map(|part| name_text(self.db, part))
                .as_deref()
                == Some("failures")
                && base
                    .filter(|base| base.kind == SyntaxKind::NameRef)
                    .and_then(|base| {
                        kids(base)
                            .into_iter()
                            .find_map(|part| name_text(self.db, part))
                    })
                    .is_some_and(|name| scope.callback_values.contains(&name))
                && matches!(
                    element.nullable_inner().unwrap_or(element),
                    ResolvedType::StdNominal {
                        name: "GenerationCallbackFailure",
                        ..
                    }
                )
        } else {
            false
        };
        if !source_owned {
            self.diags.push(Diagnostic::error("E6008", "diagnostic value list lacks its original checked observation or copied failure alias".to_string(), head.span));
            return None;
        }
        let mut alias = "row".to_string();
        if let Some(query) = query {
            for clause in kids(query)
                .into_iter()
                .filter(|child| child.kind == SyntaxKind::QueryClause)
            {
                let parts = kids(clause);
                let word = parts
                    .iter()
                    .find_map(|part| name_text(self.db, part))
                    .unwrap_or_default();
                if word != "as" {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        "diagnostic value lists support only their authored as alias".to_string(),
                        clause.span,
                    ));
                    return None;
                }
                alias = parts
                    .iter()
                    .rev()
                    .find_map(|part| name_text(self.db, part))?;
            }
        }
        let pagination = kids(node)
            .into_iter()
            .filter(|child| is_ui_node(child.kind) && ui_word(self.db, child) == "pagination")
            .collect::<Vec<_>>();
        if inspection
            && (pagination.len() > 1
                || pagination.iter().any(|marker| {
                    !ui_attributes(self.db, marker).is_empty()
                        || kids(marker)
                            .into_iter()
                            .any(|child| is_expression(child.kind) || is_ui_node(child.kind))
                }))
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "inspection list requires at most one bare direct pagination marker".to_string(),
                node.span,
            ));
            return None;
        }
        let mut pending = kids(node);
        while let Some(child) = pending.pop() {
            if inspection && pagination.iter().any(|marker| marker.span == child.span) {
                continue;
            }
            if inspection
                && is_ui_node(child.kind)
                && !is_gate_leaf(self.db, child)
                && !matches!(
                    ui_word(self.db, child).as_str(),
                    "text" | "title" | "content" | "alert" | "card"
                )
                && !(messages && matches!(ui_word(self.db, child).as_str(), "chat_bubble" | "slot"))
            {
                self.diags.push(Diagnostic::error("E6008", "inspection value list children require an owning readonly presentation profile".to_string(), child.span));
                return None;
            }
            if is_ui_node(child.kind)
                && (matches!(
                    ui_word(self.db, child).as_str(),
                    "form"
                        | "edit"
                        | "actions"
                        | "delete"
                        | "table"
                        | "calendar"
                        | "gallery"
                        | "pagination"
                        | "count"
                ) || inspection
                    && matches!(
                        ui_word(self.db, child).as_str(),
                        "action" | "button" | "board" | "list"
                    ))
            {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "diagnostic value list children have no model or mutation profile".to_string(),
                    child.span,
                ));
                return None;
            }
            pending.extend(kids(child));
        }
        let mut inner = scope.clone();
        inner.in_field_owner = false;
        inner.field_operation = None;
        inner.form_fields = None;
        inner.form_bound_fields = None;
        inner.name_types.insert(alias.clone(), (**element).clone());
        inner.row_rewrite.insert(alias.clone(), alias.clone());
        if messages
            || matches!(
                element.nullable_inner().unwrap_or(element),
                ResolvedType::StdNominal {
                    name: "GenerationCallbackDiagnosticResult"
                        | "GenerationCallbackDiagnosticComplete"
                        | "GenerationCallbackDiagnosticUnsupported",
                    ..
                }
            )
        {
            inner.callback_values.insert(alias.clone());
        }
        let values = inspection_values.unwrap_or_else(|| self.decode_expr(scope, head));
        let mut props = vec![("values".to_string(), values)];
        if let Some((_, empty)) = ui_attributes(self.db, node)
            .into_iter()
            .find(|(name, _)| name == "empty")
        {
            if !inspection
                && !matches!(
                    element.nullable_inner().unwrap_or(element),
                    ResolvedType::StdNominal {
                        name: "GenerationCallbackFailure",
                        ..
                    }
                )
            {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "only the copied failure list owns an empty caption".to_string(),
                    node.span,
                ));
                return None;
            }
            let empty = empty?;
            let Some(message) = self.decode_message_node(scope.module, empty) else {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "diagnostic list empty caption needs its original message descriptor"
                        .to_string(),
                    empty.span,
                ));
                return None;
            };
            props.push((
                "empty".to_string(),
                TypedExpr::new(
                    IrExpr::Message(message),
                    ResolvedType::Scalar(Scalar::Text),
                    empty.span,
                ),
            ));
        }
        if let Some(marker) = pagination.first().filter(|_| inspection) {
            props.push((
                "page".to_string(),
                TypedExpr::new(
                    IrExpr::Bool(true),
                    ResolvedType::Scalar(Scalar::Bool),
                    marker.span,
                ),
            ));
        }
        let children = kids(node)
            .into_iter()
            .filter(|child| is_ui_node(child.kind) && !is_gate_leaf(self.db, child))
            .filter(|child| {
                !inspection || !pagination.iter().any(|marker| marker.span == child.span)
            })
            .filter_map(|child| self.decode_ui(&inner, child, None))
            .collect();
        let gate = self.decode_gate(scope, node);
        let ui = IrUi {
            view: None,
            factory: if messages {
                "textMessageValueList"
            } else if inspection {
                "inspectionValueList"
            } else {
                "callbackValueList"
            }
            .to_string(),
            props,
            children,
            row_scope: Some((alias, "view".to_string())),
            gate,
            span: node.span,
        };
        self.callback_value_lists.push(format!("{ui:?}"));
        Some(ui)
    }

    /// Canonical order strings for one preference-order `OrderList`,
    /// through the checker's `ui_order_selectors` rows (the same
    /// canonicalization as fixed ordering). A missing row is a
    /// lowering gap (`E6008`): the dispatch must never silently run a
    /// partial order.
    fn preference_order_strings(&mut self, list: &SyntaxNode) -> Option<Vec<String>> {
        let inner = if list.kind == SyntaxKind::OrderList {
            kids(list)
                .into_iter()
                .find(|part| part.kind == SyntaxKind::Selectors)
                .unwrap_or(list)
        } else {
            list
        };
        let mut strings = Vec::new();
        for path in kids(inner)
            .into_iter()
            .filter(|part| matches!(part.kind, SyntaxKind::Path | SyntaxKind::Descending))
        {
            let key = if path.kind == SyntaxKind::Descending {
                kids(path)
                    .into_iter()
                    .find(|child| child.kind == SyntaxKind::Path)
            } else {
                Some(path)
            };
            let Some(canonical) = key
                .and_then(|key| self.program.types.ui_order_selectors.get(&NodeKey::of(key)))
                .cloned()
            else {
                self.gap(
                    "preference order selector has no checked field-relative path".to_string(),
                    path.span,
                );
                return None;
            };
            strings.push(canonical);
        }
        Some(strings)
    }

    /// Lower a checked preference-dispatched `order=` to the `order`
    /// object profile (`{by, default, cases}`): `by` is the
    /// `preferences.<name>` member read, `default` the fallback
    /// canonical order, and `cases` the per-case canonical orders. The
    /// checker owns `by`/key/selector validation; lowering trusts the
    /// checked tables and gaps (`E6008`) on anything unpublished.
    fn decode_preference_order(&mut self, scope: &Scope, order: &SyntaxNode) -> Option<TypedExpr> {
        let refuse = |decoder: &mut Self, message: String| {
            decoder
                .diags
                .push(Diagnostic::error("E6008", message, order.span));
        };
        let members = ui_attributes(self.db, order);
        let find = |key: &str| {
            members
                .iter()
                .find(|(name, _)| name == key)
                .and_then(|(_, value)| *value)
        };
        let (Some(by), Some(default), Some(case_map)) =
            (find("by"), find("default"), find("cases"))
        else {
            refuse(
                self,
                "preference order needs by=, default= and cases=".to_string(),
            );
            return None;
        };
        let segments: Vec<String> = kids(by)
            .into_iter()
            .filter(|part| part.kind == SyntaxKind::Name)
            .filter_map(|part| name_text(self.db, part))
            .collect();
        if segments.len() != 2 || segments[0] != "preferences" {
            refuse(
                self,
                "preference order by= must name a preference (preferences.<name>)".to_string(),
            );
            return None;
        }
        let pref = segments[1].clone();
        let mut preference: Option<(SymbolId, ResolvedType)> = None;
        for symbol in self.program.symbols.iter() {
            if symbol.module != scope.module {
                continue;
            }
            if let SymbolKind::Preferences { fields } = &symbol.kind {
                for field in fields {
                    if self
                        .program
                        .symbols
                        .get(field.0 as usize)
                        .is_some_and(|item| item.name == pref)
                        && let Some(ty) = self.program.types.symbol_types.get(field)
                    {
                        preference = Some((symbol.id, ty.clone()));
                    }
                }
            }
        }
        let Some((prefs_id, enum_ty)) = preference else {
            refuse(
                self,
                format!("preference order by= names an unpublished preference `{pref}`"),
            );
            return None;
        };
        let by_expr = TypedExpr::new(
            IrExpr::Member {
                base: Box::new(TypedExpr::new(
                    IrExpr::Name("preferences".to_string()),
                    ResolvedType::Record {
                        symbol: prefs_id,
                        stored: true,
                    },
                    by.span,
                )),
                field: pref,
            },
            enum_ty,
            by.span,
        );
        let text_array = |strings: Vec<String>, span: Span| {
            TypedExpr::new(
                IrExpr::Array(
                    strings
                        .into_iter()
                        .map(|canonical| {
                            TypedExpr::new(
                                IrExpr::Text(canonical),
                                ResolvedType::Scalar(Scalar::Text),
                                span,
                            )
                        })
                        .collect(),
                ),
                ResolvedType::Unknown,
                span,
            )
        };
        let Some(default_order) = self.preference_order_strings(default) else {
            return None;
        };
        let mut cases = Vec::new();
        for case in kids(case_map)
            .into_iter()
            .filter(|kid| kid.kind == SyntaxKind::OrderCase)
        {
            let parts = kids(case);
            let key = parts
                .iter()
                .find(|part| part.kind == SyntaxKind::Name)
                .and_then(|part| name_text(self.db, part));
            let list = parts
                .iter()
                .find(|part| part.kind == SyntaxKind::OrderList)
                .copied();
            let (Some(key), Some(list)) = (key, list) else {
                refuse(
                    self,
                    "preference order case needs a name and [...] list".to_string(),
                );
                return None;
            };
            let Some(strings) = self.preference_order_strings(list) else {
                return None;
            };
            cases.push((key, text_array(strings, list.span)));
        }
        Some(TypedExpr::new(
            IrExpr::Object(vec![
                ("by".to_string(), by_expr),
                (
                    "default".to_string(),
                    text_array(default_order, default.span),
                ),
                (
                    "cases".to_string(),
                    TypedExpr::new(IrExpr::Object(cases), ResolvedType::Unknown, case_map.span),
                ),
            ]),
            ResolvedType::Unknown,
            order.span,
        ))
    }

    /// Decode a collection (`list`/`table`/`gallery`): model, query
    /// props, presentation props, and row children under `renderRow`.
    fn decode_collection(&mut self, scope: &Scope, node: &SyntaxNode, word: &str) -> Option<IrUi> {
        let mut props = Vec::new();
        if word == "list" {
            let query = kids(node)
                .into_iter()
                .find(|child| child.kind == SyntaxKind::Query);
            let head = query
                .and_then(|query| {
                    kids(query)
                        .into_iter()
                        .find(|child| is_expression(child.kind))
                })
                .or_else(|| {
                    kids(node)
                        .into_iter()
                        .find(|child| is_expression(child.kind))
                });
            if let Some(head) = head {
                let ty = self.node_type(head);
                if callback_value_array(&ty) {
                    return self.decode_callback_value_list(scope, node, head, query, None);
                }
                if matches!(ty, ResolvedType::Array { .. })
                    && let Some(values) = self.inspection_value_source(scope, head)
                {
                    return self.decode_callback_value_list(scope, node, head, query, Some(values));
                }
                if matches!(ty, ResolvedType::Array { .. })
                    && let Some(values) = self.text_message_value_source(scope, head)
                {
                    return self.decode_callback_value_list(scope, node, head, query, Some(values));
                }
            }
        }
        if !matches!(word, "list" | "table" | "calendar" | "gallery" | "board" | "timeline") {
            self.diags.push(Diagnostic::error(
                "E6008",
                format!(
                    "cannot lower {word}: collection has no supported source-to-factory profile"
                ),
                node.span,
            ));
            return None;
        }
        // Agenda `columns=` names owned row fields the calendarAgenda
        // factory renders beside each endpoint line (CAN18-v1 agenda
        // columns batch): the option decodes to canonical selector
        // strings below and the UI owner validates them against the
        // authorized result metadata, so unowned names stay loud there.
        let admitted: &[&str] = if word == "timeline" {
            &["parent", "order"]
        } else if word == "calendar" {
            &[
                "parent", "empty", "limit", "cursor", "start", "end", "filter", "defaults",
                "order", "columns",
            ]
        } else if word == "gallery" {
            &[
                "parent", "empty", "image", "order", "search", "filter", "defaults",
            ]
        } else if word == "table" {
            &[
                "parent", "empty", "limit", "cursor", "columns", "order", "search", "display",
                "filter", "defaults",
            ]
        } else if word == "board" {
            &[
                "parent", "empty", "limit", "cursor", "by", "columns", "order", "search",
                "filter", "defaults",
            ]
        } else {
            &[
                "parent", "empty", "limit", "cursor", "columns", "order", "search", "display",
                "filter", "defaults",
            ]
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
                    .find(|n| is_expression(n.kind) || n.kind == SyntaxKind::Path)
                    .copied()
            });
        let containment = head.and_then(|head| self.contained_collection_head(head));
        let model_id = head
            .and_then(|head| self.collection_head_model(scope.module, head))
            .or(containment.map(|(child, _)| child));
        if let Some((_, parent)) = containment {
            if ui_attributes(self.db, node)
                .iter()
                .any(|(name, _)| name == "parent")
            {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "contained collection already owns its parent binding".to_string(),
                    node.span,
                ));
                return None;
            }
            props.push(("parent".to_string(), self.decode_expr(scope, parent)));
        }
        let Some(id) = model_id else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "collection domain must be a checked stored model or contained child".to_string(),
                head.map(|head| head.span).unwrap_or(node.span),
            ));
            return None;
        };
        if word == "gallery" {
            let images: Vec<_> = ui_attributes(self.db, node)
                .into_iter()
                .filter(|(name, _)| name == "image")
                .collect();
            let image = images.first().and_then(|(_, value)| *value);
            let paths = image.map(|value| selector_strings(self.db, value));
            let field = paths
                .as_ref()
                .and_then(|paths| (paths.len() == 1).then(|| paths[0].clone()));
            let valid = images.len() == 1 && field.as_ref().is_some_and(|name| {
                self.fields.get(&(id, name.clone())).is_some_and(|field| {
                    self.program.types.symbol_types.get(field)
                        == Some(&ResolvedType::Scalar(Scalar::File))
                        && self.program.symbols.get(id.0 as usize).is_some_and(|model| {
                            matches!(&model.kind, SymbolKind::Model { fields, .. } if fields.contains(field))
                                && self.program.symbols.get(field.0 as usize).is_some_and(|symbol| {
                                    symbol.module == model.module && symbol.name == *name
                                        && matches!(symbol.kind, SymbolKind::Field { owner, .. } if owner == id)
                                })
                        })
                })
            });
            if !valid {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower gallery image: one owning nonnullable singular File field is required".to_string(),
                    image.map_or(node.span, |value| value.span),
                ));
                return None;
            }
            props.push((
                "image".to_string(),
                TypedExpr::new(
                    IrExpr::Text(field?),
                    ResolvedType::Scalar(Scalar::Text),
                    image?.span,
                ),
            ));
        }
        if word == "calendar" {
            let start = self.decode_calendar_endpoint(scope, node, id, "start")?;
            let end = self.decode_calendar_endpoint(scope, node, id, "end")?;
            props.push((
                "kind".to_string(),
                TypedExpr::new(
                    IrExpr::Text("agenda".to_string()),
                    ResolvedType::Scalar(Scalar::Text),
                    node.span,
                ),
            ));
            props.push(("startField".to_string(), start));
            props.push(("endField".to_string(), end));
        }
        if matches!(word, "calendar" | "table" | "gallery" | "list" | "board") {
            if let Some(filters) = self.decode_collection_filters(scope, node, id, word) {
                props.extend(filters);
            } else if matches!(word, "table" | "list" | "board") {
                // Retain the original authored table/body in raw IR while
                // making the unsupported filter impossible to publish.
                props.push((
                    "filter".to_string(),
                    TypedExpr::new(
                        IrExpr::Unsupported {
                            what: format!("{word} filters"),
                            why: "no matching owned enum/default profile".to_string(),
                        },
                        ResolvedType::Unknown,
                        node.span,
                    ),
                ));
            } else {
                return None;
            }
        }
        if word == "board" {
            let Some(group) = self.decode_board_grouping(scope, node, id) else {
                return None;
            };
            props.push(("by".to_string(), group));
        }
        if let Some(head) = head {
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
                            let predicate = if word == "table" {
                                self.checked_page_time_predicate(id, node, &param, &body)
                            } else {
                                None
                            };
                            props.push((
                                "where".to_string(),
                                TypedExpr::new(
                                    predicate.map(IrExpr::PageTimePredicate).unwrap_or_else(|| IrExpr::Lambda {
                                        param,
                                        body: Box::new(body),
                                    }),
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
            match name.as_str() {
                "filter" | "defaults" if matches!(word, "calendar" | "table" | "gallery" | "list" | "board") => {}
                "order" | "search" | "filter" | "columns" => {
                    if name == "order" && value.kind == SyntaxKind::PreferenceOrder {
                        if let Some(prop) = self.decode_preference_order(scope, value) {
                            props.push(("order".to_string(), prop));
                        }
                        continue;
                    }
                    if name == "order" && value.kind != SyntaxKind::Selectors {
                        // Timelines author one plain field order as an
                        // expression (the catalog item shape carries no
                        // Selectors wrapper); resolve the field against the
                        // bound model. Anything else keeps the refusal below.
                        if word == "timeline" {
                            let mut key_node = value.clone();
                            let mut descending = false;
                            if key_node.kind == SyntaxKind::Unary
                                && kids(&key_node).iter().any(|part| {
                                    part.kind == SyntaxKind::Punct && self.text(part.span) == "-"
                                })
                            {
                                let parts = kids(&key_node);
                                if let Some(operand) = parts
                                    .iter()
                                    .find(|part| is_expression(part.kind))
                                    .map(|part| (*part).clone())
                                {
                                    descending = true;
                                    key_node = operand;
                                }
                            }
                            let field = if key_node.kind == SyntaxKind::Path {
                                path_text(self.db, &key_node)
                            } else if key_node.kind == SyntaxKind::NameRef {
                                self.text(key_node.span).to_string()
                            } else {
                                String::new()
                            };
                            if !field.is_empty()
                                && self.fields.get(&(id, field.clone())).is_some()
                            {
                                let order =
                                    format!("{}{}", if descending { "-" } else { "" }, field);
                                let span = value.span;
                                props.push((
                                    name,
                                    TypedExpr::new(
                                        IrExpr::Array(vec![TypedExpr::new(
                                            IrExpr::Text(order),
                                            ResolvedType::Scalar(Scalar::Text),
                                            span,
                                        )]),
                                        ResolvedType::Unknown,
                                        span,
                                    ),
                                ));
                                continue;
                            }
                        }
                        self.diags.push(Diagnostic::error(
                            "E6008",
                            "cannot lower collection order: preference-dispatched ordering has no query profile".to_string(),
                            value.span,
                        ));
                        continue;
                    }
                    let strings = if value.kind == SyntaxKind::Selectors {
                        kids(value)
                            .iter()
                            .filter(|path| name != "order" || matches!(path.kind, SyntaxKind::Path | SyntaxKind::Descending))
                            .flat_map(|path| {
                                if name == "order" {
                                    let key = if path.kind == SyntaxKind::Descending {
                                        kids(path)
                                            .into_iter()
                                            .find(|child| child.kind == SyntaxKind::Path)
                                    } else {
                                        Some(*path)
                                    };
                                    return key
                                        .and_then(|key| {
                                            self.program
                                                .types
                                                .ui_order_selectors
                                                .get(&NodeKey::of(key))
                                        })
                                        .cloned()
                                        .map(|canonical| vec![canonical])
                                        .unwrap_or_else(|| {
                                            self.gap(
                                                "UI order selector has no checked field-relative path".to_string(),
                                                path.span,
                                            );
                                            Vec::new()
                                        });
                                }
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
                "start" | "end" if word == "calendar" => {}
                "parent" | "limit" | "cursor" => {
                    props.push((name, self.decode_expr(scope, value)));
                }
                "image" if word == "gallery" => {}
                _ => {}
            }
        }
        // The collection owns one current row while retaining its named
        // alias for descendants that establish another current row.
        let mut child_nodes: Vec<&SyntaxNode> = kids(node)
            .iter()
            .filter(|n| is_ui_node(n.kind))
            .copied()
            .collect();
        if word == "timeline" {
            // The timeline template is the single item slot's suite; other
            // suites and bare children have no timeline profile.
            let template = child_nodes
                .iter()
                .copied()
                .filter(|child| {
                    child.kind == SyntaxKind::Slot
                        && slot_name(self.db, child).as_deref() == Some("item")
                })
                .collect::<Vec<_>>();
            if template.len() != 1 || child_nodes.len() != 1 {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower timeline: timeline takes one item slot template".to_string(),
                    node.span,
                ));
                return None;
            }
            child_nodes = kids(template[0])
                .iter()
                .filter(|n| is_ui_node(n.kind))
                .copied()
                .collect();
        }
        let counts: Vec<_> = child_nodes
            .iter()
            .copied()
            .filter(|child| ui_word(self.db, child) == "count")
            .collect();
        if let Some(count) = counts.first() {
            let attributes = ui_attributes(self.db, count);
            let label = attributes
                .iter()
                .find(|(name, _)| name == "label")
                .and_then(|(_, value)| *value);
            if counts.len() > 1
                || attributes.len() != 1
                || label.is_none()
                || kids(count)
                    .iter()
                    .any(|child| is_expression(child.kind) || is_ui_node(child.kind))
            {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower count: one list-level count with a static label and no body is supported".to_string(),
                    count.span,
                ));
            } else if !matches!(word, "list" | "gallery") {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower count: count belongs to a list or gallery".to_string(),
                    count.span,
                ));
            } else if let Some(label) = label {
                if let Some(message) = self.decode_message_node(scope.module, label) {
                    props.push((
                        "count".to_string(),
                        TypedExpr::new(
                            IrExpr::Object(vec![(
                                "label".to_string(),
                                TypedExpr::new(
                                    IrExpr::Message(message),
                                    ResolvedType::Scalar(Scalar::Text),
                                    label.span,
                                ),
                            )]),
                            ResolvedType::Unknown,
                            count.span,
                        ),
                    ));
                } else {
                    self.diags.push(Diagnostic::error(
                        "E6008",
                        "cannot lower count: label must be static text or a context-free message"
                            .to_string(),
                        label.span,
                    ));
                }
            }
        }
        child_nodes.retain(|child| ui_word(self.db, child) != "count");
        let pagination: Vec<_> = child_nodes
            .iter()
            .copied()
            .filter(|child| ui_word(self.db, child) == "pagination")
            .collect();
        for marker in &pagination {
            self.check_ui_attributes(marker, "pagination", &[]);
            if kids(marker)
                .iter()
                .any(|child| is_expression(child.kind) || is_ui_node(child.kind))
            {
                self.diags.push(Diagnostic::error(
                    "E6008",
                    "cannot lower pagination: the collection marker takes no header or content suite"
                        .to_string(),
                    marker.span,
                ));
            }
        }
        if let Some(marker) = pagination.first() {
            let position = props.len();
            props.push((
                "page".to_string(),
                TypedExpr::new(
                    IrExpr::Bool(true),
                    ResolvedType::Scalar(Scalar::Bool),
                    marker.span,
                ),
            ));
            let source_marker_supported = pagination.len() == 1
                && ui_attributes(self.db, marker).is_empty()
                && !kids(marker)
                    .iter()
                    .any(|child| is_expression(child.kind) || is_ui_node(child.kind));
            let source_alias = as_name.as_deref().unwrap_or("row");
            for (key, value) in &mut props {
                if source_marker_supported
                    && key == "where"
                    && let Some(model) = model_id
                    && let IrExpr::Lambda { param, body } = &value.expr
                    && param == source_alias
                    && let Some(predicate) =
                        self.checked_page_bool_predicate(model, source_alias, body)
                {
                    value.expr = predicate;
                }
                if key == "where"
                    && let IrExpr::PageTimePredicate(predicate) = &mut value.expr
                {
                    predicate.source_paging_supported &= source_marker_supported;
                    predicate.pagination = Some((marker.span, position));
                }
            }
        }
        if pagination.len() > 1 {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower pagination: a collection takes one page marker".to_string(),
                pagination[1].span,
            ));
        }
        child_nodes.retain(|child| ui_word(self.db, child) != "pagination");
        let split = props.iter().any(|(name, value)| {
            name == "display" && matches!(&value.expr, IrExpr::Text(display) if display == "split")
        });
        // Both source spellings refer to this checked row. Use a named
        // query alias as the actual binding so nested `row` shadowing cannot
        // erase the enclosing explicit alias.
        let source_row = as_name.clone().unwrap_or_else(|| "row".to_string());
        // Preserve a shadowed ancestor's actual lexical binding for automatic
        // form arguments. The private name cannot collide with source names.
        let row_name = if scope.row_rewrite.contains_key(&source_row) {
            format!("$row:{}:{}", node.span.file.0, node.span.start)
        } else {
            source_row.clone()
        };
        let row_ctx = model_id.map(|id| (id, row_name.clone()));
        // A collection scope ends field placement unless a nested owner
        // re-establishes it.
        let mut unowned = scope.clone();
        unowned.in_field_owner = false;
        unowned.field_operation = None;
        unowned.form_fields = None;
        unowned.form_bound_fields = None;
        if let Some(model) = model_id {
            // The collection's checked element owns this lexical row slot;
            // a surrounding view's host type must not leak into its children.
            unowned.name_types.insert(
                row_name.clone(),
                ResolvedType::Record {
                    symbol: model,
                    stored: true,
                },
            );
            unowned
                .row_rewrite
                .insert(row_name.clone(), row_name.clone());
            unowned.row_rewrite.insert(source_row, row_name.clone());
            unowned
                .row_rewrite
                .insert("row".to_string(), row_name.clone());
            unowned.enclosing_records.push((model, row_name.clone()));
        }
        let children: Vec<IrUi> = child_nodes
            .iter()
            .filter(|n| !is_gate_leaf(self.db, n))
            .filter_map(|n| self.decode_ui(&unowned, n, row_ctx.clone()))
            .collect();
        let gate = self.decode_gate(scope, node);
        let row_scope = (matches!(word, "list" | "calendar" | "timeline")
            || ((matches!(word, "table" | "gallery" | "board") || split) && !children.is_empty()))
        .then_some((row_name, "rowView".to_string()));
        Some(IrUi {
            view: None,
            factory: word.to_string(),
            props,
            children,
            row_scope,
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
                view: None,
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
                view: None,
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
            view: None,
            factory: "deleteRecord".to_string(),
            props,
            children: Vec::new(),
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        }
    }

    /// Bare history names the owning collection row; the admitted dispatcher
    /// supplies the current-authorized reader, never a generated store lookup.
    fn decode_row_history(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        let Some((model, row)) = row_ctx else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower history: bare history needs an owning collection row".to_string(),
                node.span,
            ));
            return None;
        };
        let symbol = self.program.symbols.get(model.0 as usize)?;
        if symbol.id != model
            || !matches!(symbol.kind, SymbolKind::Model { .. })
            || !self.program.effects.models.contains_key(&model)
            || kids(node)
                .iter()
                .skip(1)
                .any(|part| part.kind != SyntaxKind::Require)
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower history: only bare checked owning row history has a reader profile"
                    .to_string(),
                node.span,
            ));
            return None;
        }
        Some(IrUi {
            view: None,
            factory: "history".to_string(),
            props: vec![
                (
                    "model".to_string(),
                    TypedExpr::new(
                        IrExpr::Text(symbol.canonical.clone()),
                        ResolvedType::Scalar(Scalar::Text),
                        node.span,
                    ),
                ),
                (
                    "record".to_string(),
                    TypedExpr::new(
                        IrExpr::Name(row),
                        ResolvedType::Record {
                            symbol: model,
                            stored: true,
                        },
                        node.span,
                    ),
                ),
            ],
            children: Vec::new(),
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    /// Decode a `UiLeaf` (`text`, `history`, `metrics`, `actions`, ...).
    fn decode_leaf(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        word: &str,
        row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        if matches!(word, "primary" | "secondary") {
            return self.decode_contextual_actions(scope, node, row_ctx);
        }
        if word == "actions" {
            return self.decode_actions(scope, node, row_ctx);
        }
        if word == "history" {
            return self.decode_row_history(scope, node, row_ctx);
        }
        if word == "action" {
            return self.decode_row_action(scope, node, row_ctx);
        }
        if word == "copy" {
            return self.decode_copy(scope, node);
        }
        if word == "metrics" {
            return self.decode_metrics(scope, node, row_ctx);
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
            "content" => {
                if let Some(value) = self.decode_content_value(scope, node) {
                    props.push(("value".to_string(), value));
                }
            }
            "title" => {
                if let Some(value) = self.decode_single_ui_caption(scope, node, word) {
                    props.push(("text".to_string(), value));
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
                let decoded = self.decode_expr(scope, value);
                if matches!(
                    name.as_str(),
                    "caption" | "title" | "text" | "label" | "submit"
                ) {
                    self.check_ui_message_parameter_profile(value, &decoded);
                }
                props.push((name, decoded));
            }
        }
        let children = self.decode_ui_children(scope, node, row_ctx);
        let gate = self.decode_gate(scope, node);
        Some(IrUi {
            view: None,
            factory: word.to_string(),
            props,
            children,
            row_scope: None,
            gate,
            span: node.span,
        })
    }

    /// Decode a `copy` leaf: one text expression header, no content suite.
    /// A null value renders as empty (nothing to copy); the accessible
    /// label defaults to the value at the UI factory, so no wording is
    /// invented here.
    fn decode_copy(&mut self, scope: &Scope, node: &SyntaxNode) -> Option<IrUi> {
        let headers: Vec<&SyntaxNode> = kids(node)
            .iter()
            .filter(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
            .copied()
            .collect();
        let [header] = headers.as_slice() else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower copy: copy takes one value expression".to_string(),
                node.span,
            ));
            return None;
        };
        let value = self.decode_ui_header_value(scope, header);
        // Copy renders a string-carried value: text, or a URL (the recorded
        // `app_url(...)` shapes), each plain or nullable.
        let plain_text = matches!(
            value.ty,
            ResolvedType::Scalar(Scalar::Text | Scalar::Url)
        );
        let nullable_text = matches!(
            &value.ty,
            ResolvedType::Nullable(inner)
                if matches!(inner.as_ref(), ResolvedType::Scalar(Scalar::Text | Scalar::Url))
        );
        if !plain_text && !nullable_text {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower copy: copy takes text values".to_string(),
                header.span,
            ));
            return None;
        }
        let nullable = nullable_text;
        let value = if nullable {
            TypedExpr::new(
                IrExpr::Binary {
                    op: IrBinOp::Coalesce,
                    left: Box::new(value),
                    right: Box::new(TypedExpr::new(
                        IrExpr::Text(String::new()),
                        ResolvedType::Scalar(Scalar::Text),
                        header.span,
                    )),
                },
                ResolvedType::Scalar(Scalar::Text),
                header.span,
            )
        } else {
            value
        };
        if kids(node).iter().any(|n| is_ui_node(n.kind)) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower copy: copy takes no content suite".to_string(),
                node.span,
            ));
            return None;
        }
        Some(IrUi {
            view: None,
            factory: "copy".to_string(),
            props: vec![("value".to_string(), value)],
            children: Vec::new(),
            row_scope: None,
            gate: self.decode_gate(scope, node),
            span: node.span,
        })
    }

    /// Decode a `metrics` leaf: one typed scalar per expression through the
    /// shared stat contract (a single stat, or a visual join of stats).
    fn decode_metrics(
        &mut self,
        scope: &Scope,
        node: &SyntaxNode,
        _row_ctx: Option<(SymbolId, String)>,
    ) -> Option<IrUi> {
        let headers: Vec<&SyntaxNode> = kids(node)
            .iter()
            .filter(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
            .copied()
            .collect();
        if headers.is_empty() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower metrics: metrics takes value expressions".to_string(),
                node.span,
            ));
            return None;
        }
        if kids(node).iter().any(|n| is_ui_node(n.kind)) {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cannot lower metrics: metrics takes no content suite".to_string(),
                node.span,
            ));
            return None;
        }
        let mut stats = Vec::new();
        for header in headers {
            let value = self.decode_ui_header_value(scope, header);
            stats.push(IrUi {
                view: None,
                factory: "stat".to_string(),
                props: vec![("value".to_string(), value)],
                children: Vec::new(),
                row_scope: None,
                gate: None,
                span: header.span,
            });
        }
        let gate = self.decode_gate(scope, node);
        if stats.len() == 1 {
            let mut stat = stats.pop().expect("single metric");
            stat.gate = gate;
            return Some(stat);
        }
        Some(IrUi {
            view: None,
            factory: "join".to_string(),
            props: Vec::new(),
            children: stats,
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
        SyntaxKind::Show
            | SyntaxKind::Card
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
/// Derive external panel openers from canonical bindings in the same
/// declaration/result/row scope. This changes no gate or evaluation order.
fn bind_external_panel_triggers(nodes: &mut [IrUi]) {
    fn private_scope(node: &IrUi) -> bool {
        node.view.is_some() || node.row_scope.is_some() || node.factory == "form"
    }
    fn collect(nodes: &[IrUi], targets: &mut HashSet<String>) {
        for node in nodes {
            if private_scope(node) {
                continue;
            }
            if node.factory == "button" {
                if let Some((_, value)) = node.props.iter().find(|(key, _)| key == "opens") {
                    if let IrExpr::Text(target) = &value.expr {
                        targets.insert(target.clone());
                    }
                }
            }
            collect(&node.children, targets);
        }
    }
    fn mark(nodes: &mut [IrUi], targets: &HashSet<String>) {
        for node in nodes {
            if private_scope(node) {
                bind_external_panel_triggers(&mut node.children);
                continue;
            }
            if matches!(node.factory.as_str(), "modal" | "drawer")
                && node.props.iter().any(|(key, value)| {
                    key == "id" && matches!(&value.expr, IrExpr::Text(id) if targets.contains(id))
                })
                && !node
                    .children
                    .iter()
                    .any(|child| ui_slot_name(child) == Some("trigger"))
            {
                node.props.push((
                    "externalTrigger".into(),
                    TypedExpr::new(
                        IrExpr::Bool(true),
                        ResolvedType::Scalar(Scalar::Bool),
                        node.span,
                    ),
                ));
            }
            mark(&mut node.children, targets);
        }
    }
    let mut targets = HashSet::new();
    collect(nodes, &mut targets);
    mark(nodes, &targets);
}

fn ui_owns_submit(db: &SourceDb, node: &SyntaxNode) -> bool {
    kids(node).into_iter().any(|child| {
        if matches!(child.kind, SyntaxKind::Form | SyntaxKind::Edit) {
            return false;
        }
        if child.kind == SyntaxKind::UiLeaf
            && matches!(ui_word(db, child).as_str(), "primary" | "secondary")
            && ui_attributes(db, child)
                .iter()
                .any(|(name, _)| name == "submit")
        {
            return true;
        }
        is_ui_node(child.kind) && ui_owns_submit(db, child)
    })
}

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
        let dependencies: Vec<String> = recipe.seeds.iter().map(|id| self.canonical(*id)).collect();
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
            name: symbol.canonical.clone(),
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
        // Every checked declaration owns one recipe-only provider. Operations
        // link those exact canonical objects, including same-module fixtures;
        // aliases never create a second setup/provisioning identity.
        let import = |id: SymbolId| {
            let symbol = self.program.symbols.get(id.0 as usize)?;
            let provider = self.program.modules.get(symbol.module.0 as usize)?;
            Some(crate::codegen::bdd::IrExampleImport {
                provider: provider.name.clone(),
                member: symbol.name.clone(),
                alias: symbol.canonical.clone(),
            })
        };
        let mut suites = Vec::new();
        for (operation, tables, sequences, refs) in &by_operation {
            let imported = self
                .fixture_closure(refs)
                .into_iter()
                .filter_map(import)
                .collect();
            suites.push(BddSuite {
                scope: self.canonical(*operation),
                fixtures: Vec::new(),
                imported,
                tables: tables.clone(),
                sequences: sequences.clone(),
                span: self
                    .program
                    .symbols
                    .get(operation.0 as usize)
                    .map(|symbol| symbol.span)
                    .unwrap_or(Span::new(SourceId(0), 0, 0)),
            });
        }
        let mut providers: Vec<_> = recipes.keys().copied().collect();
        providers.sort_by_key(|id| id.0);
        for id in providers {
            let recipe = &recipes[&id];
            let mut seen = HashSet::new();
            let imported = self
                .program
                .examples
                .fixtures
                .iter()
                .find(|fixture| fixture.symbol == id)
                .into_iter()
                .flat_map(|fixture| &fixture.seeds)
                .copied()
                .filter(|id| seen.insert(*id))
                .filter_map(import)
                .collect();
            suites.push(BddSuite {
                scope: recipe.canonical.clone(),
                fixtures: vec![recipe.clone()],
                imported,
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
            .map(|id| self.canonical(*id))
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
    /// scope slot, provisioned accounts use the live context, roles lower to their
    /// canonical identity, anything else stays a spelling.
    fn decode_caller(&mut self, module: ModuleId, name: &str, span: Span) -> TypedExpr {
        if let Some(id) = self.fixture_in_scope(module, name) {
            let fixture_name = self.canonical(id);
            let ty = self.fixture_type(id);
            return TypedExpr::new(member_of("s", &fixture_name, &ty, span), ty, span);
        }
        if is_test_account(name) {
            return TypedExpr::new(
                member_of("c", name, &ResolvedType::Scalar(Scalar::User), span),
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
        let Some(selector_channels) = table.selector_channels().map(|channels| channels.to_vec())
        else {
            self.diags.push(Diagnostic::error(
                "E6008",
                "example selector channels disagree with checked source ownership".to_string(),
                table.span,
            ));
            return None;
        };
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
            let decoded = self.decode_expr(&scope, value);
            // Nested common values need their actual checked fixtures just as
            // direct fixture bindings do; these inputs execute for every row.
            binding_fixtures.extend(self.s_refs(module, &decoded));
            input_entries.push((name, decoded));
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
        if table.inputs
            != header_inputs
                .iter()
                .map(|cell| self.text(cell.span).trim().to_string())
                .collect::<Vec<_>>()
        {
            self.diags.push(Diagnostic::error(
                "E6008",
                "example selector channels disagree with source header".to_string(),
                table.span,
            ));
            return None;
        }
        let mut observations = Vec::new();
        let mut refs: Vec<SymbolId> = table.seeds.clone();
        refs.extend(binding_fixtures.iter().copied());
        // Only fixtures actually seeded for every row are table dependencies.
        // `refs` below also collects observations and earlier rows for module
        // recipe availability; that union cannot provision a later row.
        let table_deps: HashSet<SymbolId> = table
            .seeds
            .iter()
            .chain(binding_fixtures.iter())
            .copied()
            .collect();
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
            let dependencies: Vec<String> = {
                let mut names: Vec<String> = row_refs
                    .iter()
                    .filter(|id| !table_deps.contains(id))
                    .map(|id| self.canonical(*id))
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
            table.seeds.iter().map(|id| self.canonical(*id)).collect();
        for id in &binding_fixtures {
            let name = self.canonical(*id);
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
                selector_channels: Some(selector_channels),
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
        if cell.kind == SyntaxKind::Array {
            let values = kids(cell)
                .iter()
                .filter(|node| is_expression(node.kind))
                .map(|node| self.decode_as_role_cell(module, node))
                .collect();
            return TypedExpr::new(IrExpr::Array(values), ResolvedType::Unknown, span);
        }
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
            let fixture_name = self.canonical(id);
            let ty = self.fixture_type(id);
            return TypedExpr::new(member_of("s", &fixture_name, &ty, span), ty, span);
        }
        if is_test_account(&name) {
            return TypedExpr::new(
                member_of("c", &name, &ResolvedType::Scalar(Scalar::User), span),
                ResolvedType::Scalar(Scalar::User),
                span,
            );
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

    /// Role arrays belong only to the checked example caller position. Their
    /// static members never enter general executable role-value lowering.
    fn decode_as_role_cell(&mut self, module: ModuleId, cell: &SyntaxNode) -> TypedExpr {
        let name = (cell.kind == SyntaxKind::NameRef)
            .then(|| kids(cell).iter().find_map(|node| name_text(self.db, node)))
            .flatten();
        if let Some(name) = name {
            let role = if matches!(name.as_str(), "owner" | "members") {
                Some(name)
            } else {
                self.resolve_member(module, &name).and_then(|(id, _)| {
                    matches!(
                        self.program
                            .symbols
                            .get(id.0 as usize)
                            .map(|symbol| &symbol.kind),
                        Some(SymbolKind::Role)
                    )
                    .then(|| self.canonical(id))
                })
            };
            if let Some(role) = role {
                return TypedExpr::new(
                    IrExpr::Text(role),
                    ResolvedType::Scalar(Scalar::Text),
                    cell.span,
                );
            }
        }
        self.unsupported_expr(
            "example role array",
            "caller members require their actual declared role or owner/members identity",
            ResolvedType::Unknown,
            cell.span,
        )
    }

    /// Fixture references of one decoded expression (`s` slots).
    fn s_refs(&self, module: ModuleId, expr: &TypedExpr) -> Vec<SymbolId> {
        let mut names = Vec::new();
        collect_s_refs(&expr.expr, &mut names);
        names.sort();
        names.dedup();
        names
            .iter()
            .filter_map(|name| {
                // Decoding has already resolved source visibility and writes
                // canonical s-slot keys, including imported aliases. Rejoin
                // that exact declaration instead of resolving the key as a
                // second source-level spelling in the consumer module.
                self.program.symbols.iter().find_map(|symbol| {
                    (matches!(symbol.kind, SymbolKind::Fixture { .. })
                        && self.canonical(symbol.id) == *name)
                        .then_some(symbol.id)
                }).or_else(|| self.fixture_in_scope(module, name))
            })
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
            if let Some(order) = &query.value_order {
                collect_s_refs(&order.key.expr, out);
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
        IrExpr::JudgmentSpecification { options, .. } => {
            if let Some(options) = options {
                collect_s_refs(&options.expr, out);
            }
        }
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
        | IrExpr::PageTimePredicate(_)
        | IrExpr::Unsupported { .. } => {}
    }
}

// --- BGI-07 Given contract lowering ----------------------------------------
// Lower checked Given contracts ([`crate::analysis::types::GivenContractTables`])
// to per-application emission records: trait instantiations (the saved
// template at each target) and keyword rules (the wrapper-join record
// binding each standalone application to its saved implementation and
// owner-versioned producer). Instances keep explicit source order and
// compiler-owned identities; lowering is total over checked tables and
// reports no diagnostics. Standalone by lane design: the BGI-11/12 join
// wires it into `build`/`emit` once saved intake feeds this layer.

/// One lowered trait instantiation: a saved template applied at one
/// target, sharing its definition's saved unit with every sibling
/// application.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GivenTraitInstanceIr {
    /// Compiler-owned instantiation identity:
    /// `{target}#{trait}` for named traits,
    /// `{target}#inline-trait@{unit}` for one-off attachments.
    pub id: String,
    /// Owning module.
    pub owner: String,
    /// Trait name (`None` for inline attachments).
    pub trait_name: Option<String>,
    /// Whether this instance owns a one-off inline attachment.
    pub inline: bool,
    /// Definition anchor (the stable association key).
    pub anchor: String,
    /// Saved unit this instance reuses.
    pub unit_id: String,
    /// Canonical target identity (`Owner.Model[.field]`).
    pub target: String,
    /// Instantiated template fields (a single constraint template for
    /// field attachments: no new field, compatible default/bounds).
    pub fields: Vec<GivenContractFieldIr>,
    /// SHA-256 over the contributions carrier bytes.
    pub fingerprint: String,
    /// Source order among the definition's applications.
    pub order: usize,
    /// Application span.
    pub span: Span,
    /// Exact optional field-check implementation closure.
    pub validation_fingerprint: Option<String>,
}

/// One lowered contributed field: the typed leaf a trait adds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GivenContractFieldIr {
    /// Field name.
    pub name: String,
    /// Checked type text.
    pub type_name: String,
    /// Checked default constant (source text), when the template
    /// carries one (field-constraint templates may omit it).
    pub default: Option<String>,
    /// Contributed `trim` normalization.
    pub trim: bool,
    /// Contributed `min=` bound (source text), when given.
    pub min: Option<String>,
    /// Contributed `max=` bound (source text), when given.
    pub max: Option<String>,
}

/// One lowered keyword rule: a standalone application bound to its
/// saved implementation through the checked owner-producer descriptor
/// (the wrapper-join record the runtime seam consumes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GivenKeywordRuleIr {
    /// Compiler-owned rule identity
    /// (`Owner.Model.field#keyword`).
    pub rule_id: String,
    /// Owning module.
    pub owner: String,
    /// Keyword name (the standalone declaration form).
    pub keyword: String,
    /// Definition anchor (the stable association key).
    pub anchor: String,
    /// Saved unit this rule reuses.
    pub unit_id: String,
    /// Bound owner-versioned producer (compiler-known).
    pub producer: String,
    /// Fixed producer semantics id (compiler-owned).
    pub semantics: String,
    /// Producer lifecycle binding (compiler-owned).
    pub lifecycle: String,
    /// Saved export implementing the behavior.
    pub export: String,
    /// Typed input binding name.
    pub input_name: String,
    /// Typed input schema (producer/definition derived).
    pub input_type: String,
    /// Typed result schema (producer-fixed).
    pub result_type: String,
    /// Admitted reads (empty for pure producers).
    pub reads: Vec<String>,
    /// Admitted effects (empty for pure producers).
    pub effects: Vec<String>,
    /// Admitted authority (empty: canonical owners admit bindings).
    pub authority: Vec<String>,
    /// Canonical value dependencies (the bound fields).
    pub dependencies: Vec<String>,
    /// SHA-256 over the saved implementation closure bytes.
    pub fingerprint: String,
    /// Canonical target model identity.
    pub target_model: String,
    /// Canonical target field identity.
    pub target_field: String,
    /// Resolved arguments (references canonical, constants verbatim).
    pub args: Vec<(String, String)>,
    /// Source order among the definition's applications.
    pub order: usize,
    /// Application span.
    pub span: Span,
}

/// Lowered Given contracts in global source order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GivenContractIr {
    /// Trait instantiations in global source order.
    pub traits: Vec<GivenTraitInstanceIr>,
    /// Keyword rules in global source order.
    pub keywords: Vec<GivenKeywordRuleIr>,
}

pub(super) fn given_bound_type(ty: &ResolvedType) -> ResolvedType {
    use crate::analysis::types::Scalar;
    match ty {
        ResolvedType::Nullable(inner) => given_bound_type(inner),
        ResolvedType::Scalar(scalar) if !scalar.is_string_like() => ty.clone(),
        _ => ResolvedType::Scalar(Scalar::Int),
    }
}

/// Decode a constant already admitted by the Given field owner checker.
pub(super) fn given_constant_expr(value: &str, ty: &ResolvedType, span: Span) -> TypedExpr {
    use crate::analysis::types::Scalar;
    let text = value.trim();
    let expr = if text == "null" {
        IrExpr::Null
    } else {
        match ty {
            ResolvedType::Nullable(inner) => return given_constant_expr(text, inner, span),
            ResolvedType::Array { element, .. } => {
                let body = text
                    .strip_prefix('[')
                    .and_then(|v| v.strip_suffix(']'))
                    .unwrap_or("");
                IrExpr::Array(
                    crate::analysis::types::split_given_consts(body)
                        .iter()
                        .filter(|v| !v.is_empty())
                        .map(|v| given_constant_expr(v, element, span))
                        .collect(),
                )
            }
            ResolvedType::Scalar(Scalar::Bool) => IrExpr::Bool(text == "true"),
            ResolvedType::Scalar(Scalar::Int) => {
                IrExpr::Int(text.parse().expect("checked Given integer"))
            }
            ResolvedType::Scalar(Scalar::Decimal) => IrExpr::Decimal(text.to_string()),
            ResolvedType::Scalar(Scalar::Duration) => {
                IrExpr::DurationMs(duration_millis(text).expect("checked Given duration"))
            }
            ResolvedType::Scalar(Scalar::Date) => {
                IrExpr::Date(serde_json::from_str(text).unwrap_or_else(|_| text.to_string()))
            }
            ResolvedType::Scalar(Scalar::Datetime) => {
                IrExpr::Datetime(serde_json::from_str(text).unwrap_or_else(|_| text.to_string()))
            }
            _ => IrExpr::Text(serde_json::from_str(text).unwrap_or_else(|_| text.to_string())),
        }
    };
    TypedExpr::new(expr, ty.clone(), span)
}

/// Lower checked Given contracts to per-application emission records.
/// Trait definitions flatten to one instance per application (all
/// sharing the saved unit); keyword definitions flatten to one rule
/// per application (all sharing the saved implementation and producer
/// binding). Both lists end in global source order.
pub fn lower_given_contracts(
    tables: &crate::analysis::types::GivenContractTables,
) -> GivenContractIr {
    let mut out = GivenContractIr::default();
    for contract in &tables.traits {
        let fields: Vec<GivenContractFieldIr> = contract
            .contributed_fields
            .iter()
            .map(|f| GivenContractFieldIr {
                name: f.name.clone(),
                type_name: f.type_name.clone(),
                default: f.default.clone(),
                trim: f.trim,
                min: f.min.clone(),
                max: f.max.clone(),
            })
            .collect();
        for app in &contract.applications {
            let owner = app
                .target_canonical
                .split('.')
                .next()
                .unwrap_or_default()
                .to_string();
            let id = match &contract.name {
                Some(name) => format!("{}#{name}", app.target_canonical),
                None => format!("{}#inline-trait@{}", app.target_canonical, contract.unit_id),
            };
            out.traits.push(GivenTraitInstanceIr {
                id,
                owner,
                trait_name: contract.name.clone(),
                inline: contract.inline,
                anchor: contract.anchor.clone(),
                unit_id: contract.unit_id.clone(),
                target: app.target_canonical.clone(),
                fields: fields
                    .iter()
                    .cloned()
                    .map(|mut field| {
                        if let Some(target) = &app.target_field {
                            field.name = target.clone();
                        }
                        field
                    })
                    .collect(),
                fingerprint: contract.fingerprint.clone(),
                validation_fingerprint: contract.validation_fingerprint.clone(),
                order: app.order,
                span: app.span,
            });
        }
    }
    for contract in &tables.keywords {
        for app in &contract.applications {
            let owner = app
                .target_model
                .split('.')
                .next()
                .unwrap_or_default()
                .to_string();
            out.keywords.push(GivenKeywordRuleIr {
                rule_id: app.rule_id.clone(),
                owner,
                keyword: contract.name.clone(),
                anchor: contract.anchor.clone(),
                unit_id: contract.unit_id.clone(),
                producer: contract.producer.clone(),
                semantics: contract.semantics.clone(),
                lifecycle: contract.lifecycle.clone(),
                export: contract.export.clone(),
                input_name: contract.input.name.clone(),
                input_type: contract.input.type_name.clone(),
                result_type: contract.result.clone(),
                reads: contract.reads.clone(),
                effects: contract.effects.clone(),
                authority: contract.authority.clone(),
                dependencies: contract.dependencies.clone(),
                fingerprint: contract.fingerprint.clone(),
                target_model: app.target_model.clone(),
                target_field: app.target_field.clone(),
                args: app.args.clone(),
                order: app.order,
                span: app.span,
            });
        }
    }
    out.traits.sort_by_key(|i| (i.span.file.0, i.span.start));
    out.keywords.sort_by_key(|i| (i.span.file.0, i.span.start));
    out
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
