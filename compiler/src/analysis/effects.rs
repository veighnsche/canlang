//! Effect/owner/disclosure analysis + EMIT rule/body tables (lane-01, PR5A).
//!
//! This pass runs after [`check_program`](crate::analysis::check_program)
//! (resolve `E2xxx` + types `E3xxx`) and owns the `E4xxx` range: guard/effect
//! order, ownership, disclosure/secret handling, role gates, trusted-handler
//! scope, call/send locality and argument validation, and hook semantics.
//! It also builds [`EffectTables`], the codegen emission input for Given
//! rules and When bodies (contract G1–G9, G13).
//!
//! ## `E4xxx` codes
//!
//! - `E4001` cross-package mutation: `create`/`set`/`delete` targets a model
//!   owned by another package; other packages mutate only through `call`
//!   (DESIGN §1, §5).
//! - `E4002` cross-package rule: a policy/invariant/unique/lock/retain
//!   targets another package's model (DESIGN §1).
//! - `E4003` cross-package crud: a `crud` declaration targets another
//!   package's model (DESIGN §1, §5).
//! - `E4004` app scope needs policy: `Model in app` without a same-package
//!   policy (DESIGN §2).
//! - `E4010` secret field grant: a policy `fields=` selector resolves to a
//!   `secret`-typed leaf; grants never include secrets (DESIGN §4).
//! - `E4011` secret return: a `return` value of `secret` type; secrets are
//!   server-only and never client-readable (DESIGN §2, §5).
//! - `E4012` leaf grant through reference: a policy `fields=` selector
//!   or UI table `columns=`/`search=`/`filter=` selector traverses a
//!   `user`/`member` reference; leaf grants descend only through
//!   singular embedded typed values, never references
//!   (DESIGN §4, T25-L1; UI contexts A5/S4).
//! - `E4020` redundant actor subject: `Role(actor)`; the bare role is the
//!   canonical literal-actor spelling (DESIGN §4).
//! - `E4030` unreachable after return: a statement following an
//!   always-returning statement in the same list never runs (DESIGN §5).
//! - `E4040` call remote target: `call` stays in one owner transaction, so
//!   its target must not be a bound-imported (remote) operation; remote
//!   targets use `send` (DESIGN §2.1, §8.1). Generated CRUD operations are
//!   exempt: `send` does not accept them, so flagging them would leave no
//!   valid invocation path.
//! - `E4041` heterogeneous action call: a `call` on an action value supplies
//!   a value that does not fit every target's input of the same name
//!   (DESIGN §2.1).
//! - `E4042` delete disabled: a `delete` statement on a model whose `crud`
//!   declaration sets `delete=none` (DESIGN §5).
//! - `E4050` hook on disabled op: an `on=Model.create/update/delete` hook
//!   whose `crud` declaration disables that operation (DESIGN §5, §6).
//! - `E4051` mixed handler scope: an `on=every(...)` handler whose
//!   owner-bound queries, writes and local-call dependencies span both
//!   app-scoped and team-scoped models (DESIGN §6).
//! - `E4052` same-model staging: a hook stages `create`/`set` of its own
//!   trigger model (T31 Rule A NARROW bar: all same-model CRUD barred,
//!   matching the engine; the pending-record adjustment is not staging).
//! - `E4053` staged delete: a `delete` inside a hook body (T31 Rule A:
//!   hooks stage create/set only).
//! - `E4054` delete-hook staging: a `create`/`set`/`schedule`/`cancel`
//!   inside a delete hook (T31 Rule A: delete hooks reject by throwing,
//!   never stage).
//! - `E4055` invalid cohort: an `each=` fanout cohort outside the adopted
//!   T33-A contract — unknown model/collection, cross-package (cross-owner)
//!   cohort, `each=` without `on=`, or any other unsupported cohort shape
//!   (T34-F6; §C9/M10 keep such forms diagnosed, never silently admitted).
//!
//! Each staging ban reports once per statement and stands down when an
//! earlier finding already covers the statement (fix-and-reveal); the
//! types pass keeps its pending-record and snapshot messages (`E3009`),
//! which these bans never duplicate.
//! Trusted-handler shape rules (`by`/`on` exclusivity, no client parameters,
//! no export/label/read attributes) are the parser's (`E12xx`); handler
//! source validation, duplicate hooks, pending-record rules and hook
//! callbacks are the types pass's (`E3005`/`E3009`/`E3010`). Example cells,
//! sequences and UI shape rules belong to later passes; this pass skips
//! `Examples` subtrees everywhere.
//!
//! ## Wiring note
//!
//! This file is written against the crate's public API only so it compiles
//! both as `analysis::effects` (add `pub mod effects;` plus a re-export to
//! `analysis/mod.rs`) and as a `#[path]`-included test module. The
//! coordinator owns that wiring; the entry point and table shapes below are
//! the stable contract.

use crate::analysis::NodeKey;
use crate::analysis::catalog::{Availability, Catalog};
use crate::analysis::resolve::{
    Binding, ContextVar, CrudOp, ModelOwner, ModuleId, ModuleKind, ResolveTables, ScopedName,
    SymbolId, SymbolKind,
};
use crate::analysis::types::{
    CheckedInputChoice, ResolvedType, Scalar, SelectedCallTarget, TypeTable,
};
use crate::diagnostic::{Diagnostic, Related};
use crate::source::{SourceDb, SourceId, Span};
use crate::syntax::{SyntaxKind, SyntaxNode, decode_json_string};
use std::collections::{HashMap, HashSet};

// --- Emission tables (contract G1-G9, G13) ---------------------------------

/// Rule/body tables: the codegen emission input for Given rules and When
/// bodies plus the referenced declarations they need.
///
/// Keyed by [`SymbolId`]/[`ModuleId`] for declarations and [`NodeKey`] for
/// CST positions. Vectors preserve source order. Tables are built
/// best-effort even when diagnostics fire; codegen runs on clean programs.
#[derive(Debug, Clone, Default)]
pub struct EffectTables {
    /// Scenario bodies by scenario symbol (G1).
    pub scenarios: HashMap<SymbolId, ScenarioData>,
    /// CRUD declarations by `Crud` symbol (G2).
    pub cruds: HashMap<SymbolId, CrudData>,
    /// Generated CRUD operations by `CrudOp` symbol (G2).
    pub crud_ops: HashMap<SymbolId, CrudOpData>,
    /// Models with their rules by model symbol (G3).
    pub models: HashMap<SymbolId, ModelData>,
    /// Contracts, events and preferences records (G4; capability events
    /// included).
    pub records: HashMap<SymbolId, RecordData>,
    /// Roles with their labels (G5).
    pub roles: HashMap<SymbolId, RoleData>,
    /// Capabilities with versions and availability (G6).
    pub capabilities: HashMap<SymbolId, CapabilityData>,
    /// Messages with text, locales and parameters (G7).
    pub messages: HashMap<SymbolId, MessageData>,
    /// Derived fields and functions with their expressions (G8).
    pub derives: HashMap<SymbolId, DeriveData>,
    /// Module data: pages, rule refs, migration refs, descriptions (G9).
    pub modules: HashMap<ModuleId, ModuleData>,
    /// Migrations in source order (G9).
    pub migrations: Vec<MigrationData>,
    /// Builtin ids referenced from checked call positions, sorted and
    /// deduped (G13). Seeded from every expression `Call` outside
    /// `Examples` subtrees whose callee resolves to a catalog builtin:
    /// rule predicates, guards, bodies, defaults, page expressions and
    /// migration backfills.
    pub referenced_builtins: Vec<String>,
    /// Checked field/parameter descriptions by owner declaration node
    /// (D02b seam): one logical slot per declaration; absent entry
    /// means undescribed. See [`CheckedDescription`].
    pub checked_descriptions: HashMap<NodeKey, CheckedDescription>,
}

impl EffectTables {
    /// D03 lowering: source-language text of the checked description
    /// owning `owner`, when the field/parameter declaration carries one.
    ///
    /// Inline `desc=`, legacy `@{desc}`, attached `#` and shared message
    /// references all feed this one slot (see [`CheckedDescription`]);
    /// this projection is the existing MCP source-string path — IR and
    /// operation descriptors render exactly this text, with no locale
    /// resolution. Variants, the owning source language and the authored
    /// location stay in the seam for the reference extractor (D04b) and
    /// IDE hover (D06); localized MCP is explicitly deferred, so no
    /// variant is selected here. Absence (`None`) is undescribed;
    /// `Some("")` is authored-empty text and stays present downstream.
    pub fn description_source(&self, owner: &NodeKey) -> Option<&str> {
        self.checked_descriptions
            .get(owner)
            .map(|checked| checked.source.as_str())
    }
}

/// Scenario body: guards plus effects with labels and parameters (G1).
#[derive(Debug, Clone)]
pub struct ScenarioData {
    /// Scenario symbol.
    pub scenario: SymbolId,
    /// Declaring module.
    pub module: ModuleId,
    /// Scenario declaration node.
    pub node: NodeKey,
    /// `by=` gate expression (user scenarios).
    pub by: Option<NodeKey>,
    /// `on=` trusted source (handlers).
    pub on: Option<HandlerSource>,
    /// `on=` value node.
    pub on_node: Option<NodeKey>,
    /// Whether `read=true` was declared.
    pub read: bool,
    /// Whether `scope=authority` was declared.
    pub scope_authority: bool,
    /// Whether `expose=none` was declared (excluded from publication;
    /// omission exposes the operation). The checker owns the closed
    /// set; future publication surfaces (http/mcp) would widen this
    /// to a word list like [`CrudData::expose`].
    pub expose_none: bool,
    /// `label=` value node.
    pub label: Option<NodeKey>,
    /// Parameters in signature order.
    pub params: Vec<ParamData>,
    /// `->` result annotation node.
    pub result: Option<NodeKey>,
    /// Leading `require` guards in written order (`Effect` with
    /// [`EffectVerb::Require`).
    pub guards: Vec<Effect>,
    /// `do` body statements in written order.
    pub effects: Vec<Effect>,
    /// Checked `each=` fanout cohort (T34-F6): `Some` exactly when the
    /// scenario declares an `each=` cohort inside the adopted contract
    /// (bare model or parent-anchored collection); `None` when `each=`
    /// is absent or fails the check (an `E4055` is reported then and
    /// codegen emits no descriptor — fail-closed, never silently admitted).
    pub cohort: Option<CohortData>,
}

/// Checked `each=` fanout cohort: the codegen emission input (T34-F6).
#[derive(Debug, Clone)]
pub struct CohortData {
    /// Cohort spelling: whole-model enumeration or one parent's
    /// contained reverse collection (mirrors F1 `FanoutCohortKind`).
    pub kind: CohortKind,
    /// Enumerated model (bare spelling) or child model (anchored spelling).
    pub model: SymbolId,
    /// `as` child binding, when the header declares one.
    pub bind: Option<String>,
    /// Anchored spelling only: the event-rooted parent path segments
    /// (`["event", "opportunity"]` for `each=event.opportunity.Signup`).
    pub parent_path: Vec<String>,
    /// `each=` value node.
    pub node: NodeKey,
}

/// Adopted `each=` cohort spellings (T34-F6; F1 `FanoutCohortKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CohortKind {
    /// Bare-model enumeration (`each=Signup`).
    Model,
    /// Parent-anchored reverse collection (`each=event.opportunity.Signup`).
    AnchoredCollection,
}

/// Trusted `on=` source of a handler scenario (DESIGN §6).
#[derive(Debug, Clone)]
pub enum HandlerSource {
    /// Pre-commit hook: `on=Model.create/update/delete`.
    Hook { model: SymbolId, op: CrudOp },
    /// Committed change event: `on=Model.created/updated/deleted`
    /// (`event` is the source spelling).
    Committed { model: SymbolId, event: String },
    /// Declared event: `on=EventName`.
    Event(SymbolId),
    /// Declared queue: `on=QueueName`.
    Queue { name: String },
    /// Recurring tick: `on=every(duration)` (`duration` is the raw source
    /// slice of the duration literal).
    Every { duration: String },
    /// `on=teams.member_removed`.
    TeamsMemberRemoved,
    /// `on=instrumentation.error`.
    InstrumentationError,
    /// Capability event: `on=Cap.event`.
    CapabilityEvent {
        capability: SymbolId,
        event: SymbolId,
    },
    /// Exported-scenario completion: `on=Scenario.completed`.
    ScenarioCompleted { scenario: SymbolId },
    /// Delivery completion: `on=Cap.op.completed`.
    DeliveryCompleted { capability: SymbolId, op: SymbolId },
    /// Checked original-operation progress: `on=Cap.op.progressed`.
    DeliveryProgressed { source: String },
    /// Unresolved or invalid source (`source` is the trimmed source slice;
    /// an earlier pass diagnosed it).
    Unknown { source: String },
}

/// One guard/effect statement: a [`NodeKey`] plus structured op data.
#[derive(Debug, Clone)]
pub struct Effect {
    /// Statement node.
    pub node: NodeKey,
    /// Effect verb.
    pub verb: EffectVerb,
    /// Resolved target, when the statement has one.
    pub target: Option<EffectTarget>,
    /// `let` name or `as` binding (`create`/`call`/`send`).
    pub binding: Option<String>,
    /// `for` item name.
    pub item: Option<String>,
    /// Object entries: `create`/`set` fields, `emit` payload, `call`/`send`
    /// arguments, `schedule` event payload.
    pub args: Vec<EffectArg>,
    /// `send` dispatch guard (`when=`).
    pub when: Option<NodeKey>,
    /// `require` diagnostic (`message=`).
    pub message: Option<NodeKey>,
    /// `require` predicate / `if` condition.
    pub cond: Option<NodeKey>,
    /// `let` value / `return` value / `cancel` key / `match` subject.
    pub value: Option<NodeKey>,
    /// `schedule` key expression.
    pub key: Option<NodeKey>,
    /// `schedule` instant (`at=`).
    pub at: Option<NodeKey>,
    /// `for` domain query.
    pub domain: Option<NodeKey>,
    /// `for` bound (`limit=`).
    pub limit: Option<NodeKey>,
    /// `if` then-branch / `for` body.
    pub then_effects: Vec<Effect>,
    /// `if` else-branch.
    pub else_effects: Vec<Effect>,
    /// Ordered finite-enum branches with type-checked subject-domain cases.
    pub match_arms: Vec<EffectMatchArm>,
}

/// One finite-enum branch; absent case authority cannot be reconstructed.
#[derive(Debug, Clone)]
pub struct EffectMatchArm {
    pub node: NodeKey,
    pub case: Option<String>,
    pub effects: Vec<Effect>,
}

/// Closed effect vocabulary (DESIGN §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectVerb {
    Let,
    Require,
    Create,
    Set,
    Transition,
    Delete,
    Call,
    Emit,
    Send,
    Schedule,
    Cancel,
    Return,
    If,
    Match,
    For,
}

/// Resolved target of an effect statement.
#[derive(Debug, Clone)]
pub enum EffectTarget {
    /// `create` model.
    Model(SymbolId),
    /// `emit` / `schedule` event.
    Event(SymbolId),
    /// `call`/`send` operation (scenario, capability op or CRUD op).
    Operation(SymbolId),
    /// `call` on an action value (all declared targets).
    Action(Vec<SymbolId>),
    /// `call` on an invocation value (all declared targets; arguments are
    /// complete at construction).
    Invocation(Vec<SymbolId>),
    /// `set`/`delete` record (`model` is `None` when untyped).
    Record { model: Option<SymbolId> },
    /// `set event.after`: the pending record of a create/update hook.
    PendingRecord { model: SymbolId },
    /// `send` to a context-declared queue (`Queue.op`).
    Queue { queue: String, op: String },
    /// `send` to a context-declared analytics sink (`Sink.op`).
    Analytics { sink: String, op: String },
}

/// One object entry of an effect: key plus optional value node (`None` for
/// shorthand entries, whose value is the in-scope binding of the key).
#[derive(Debug, Clone)]
pub struct EffectArg {
    /// Entry key.
    pub key: String,
    /// Key token node.
    pub key_node: NodeKey,
    /// Value expression node, when written.
    pub value: Option<NodeKey>,
}

/// CRUD declaration: guards, field allowlists and labels (G2).
#[derive(Debug, Clone)]
pub struct CrudData {
    /// `Crud` symbol.
    pub crud: SymbolId,
    /// Target model.
    pub model: SymbolId,
    /// Declaring module.
    pub module: ModuleId,
    /// `crud` declaration node.
    pub node: NodeKey,
    /// `by=` gate expression.
    pub by: Option<NodeKey>,
    /// `when=` admission predicate.
    pub when: Option<NodeKey>,
    /// Update (and default create) field allowlist, dotted paths.
    pub fields: Vec<String>,
    /// `fields=` selectors node.
    pub fields_node: Option<NodeKey>,
    /// Narrowed create allowlist (`create_fields=`), dotted paths.
    pub create_fields: Vec<String>,
    /// `create_fields=` selectors node.
    pub create_fields_node: Option<NodeKey>,
    /// Whether `create` is enabled (absent `create=none`).
    pub create: bool,
    /// Whether `update` is enabled (absent `update=none`).
    pub update: bool,
    /// Whether `delete` is enabled (absent `delete=none`).
    pub delete: bool,
    /// Declared deletion mode (`remove`, else the `archive` default).
    pub delete_mode: DeleteMode,
    /// `expose=` operation names in written order (empty when absent).
    pub expose: Vec<String>,
    /// `expose=` selectors node.
    pub expose_node: Option<NodeKey>,
    /// Per-operation captions.
    pub labels: Vec<CrudLabel>,
    /// `label=` value node.
    pub labels_node: Option<NodeKey>,
    /// Generated `CrudOp` symbols (enabled operations only).
    pub ops: Vec<SymbolId>,
}

/// One generated CRUD operation: its guard, allowlist and label (G2).
#[derive(Debug, Clone)]
pub struct CrudOpData {
    /// `CrudOp` symbol.
    pub op: SymbolId,
    /// Owning `Crud` declaration symbol.
    pub crud_decl: SymbolId,
    /// Target model.
    pub model: SymbolId,
    /// Declaring module.
    pub module: ModuleId,
    /// Which generated operation this is.
    pub operation: CrudOp,
    /// `crud` declaration node.
    pub node: NodeKey,
    /// `by=` gate expression.
    pub by: Option<NodeKey>,
    /// `when=` admission predicate.
    pub when: Option<NodeKey>,
    /// Field allowlist for this operation: create uses `create_fields`
    /// when declared else `fields`; update uses `fields`; delete takes no
    /// fields.
    pub fields: Vec<String>,
    /// Deletion mode (delete operations; `Archive` otherwise).
    pub delete_mode: DeleteMode,
    /// Caption for this operation, when the declaration labels it.
    pub label: Option<NodeKey>,
}

/// Declared deletion mode: `archive` (the default) or `remove`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DeleteMode {
    /// Archive on delete (default; `delete=archive` is not repeated).
    #[default]
    Archive,
    /// Permanent removal (`delete=remove`).
    Remove,
}

/// One `crud` operation caption (`{create=..., update=..., delete=...}`).
#[derive(Debug, Clone)]
pub struct CrudLabel {
    /// Operation name (`create`, `update` or `delete`).
    pub op: String,
    /// Caption value node.
    pub caption: NodeKey,
}

/// Model with its label, fields and rules (G3).
#[derive(Debug, Clone)]
pub struct ModelData {
    /// Model symbol.
    pub model: SymbolId,
    /// Declaring module.
    pub module: ModuleId,
    /// Model declaration node.
    pub node: NodeKey,
    /// Declaration `label=` value node.
    pub label: Option<NodeKey>,
    /// Storage ownership (team default, child link or app scope).
    pub owner: ModelOwner,
    /// Stored fields in declaration order (derived fields live in
    /// [`EffectTables::derives`]).
    pub fields: Vec<FieldData>,
    /// Read-grant policies in source order.
    pub policies: Vec<PolicyRule>,
    /// Invariants in source order.
    pub invariants: Vec<InvariantRule>,
    /// Uniqueness constraints in source order.
    pub uniques: Vec<UniqueRule>,
    /// Field locks in source order.
    pub locks: Vec<LockRule>,
    /// Lifetime declaration (at most one on clean programs).
    pub retains: Vec<RetainRule>,
}

/// Stored field with its type, initializer, modifiers and label.
#[derive(Debug, Clone)]
pub struct FieldData {
    /// Field symbol.
    pub field: SymbolId,
    /// Field declaration node.
    pub node: NodeKey,
    /// Declared type node.
    pub type_node: NodeKey,
    /// `=` default expression.
    pub default: Option<NodeKey>,
    /// `server=` initializer expression.
    pub server: Option<NodeKey>,
    /// `trim`/`min=`/`max=`/`unique` modifiers in written order.
    pub modifiers: Vec<ModifierData>,
    /// `label=` value node.
    pub label: Option<NodeKey>,
    /// Trailing `@{desc="..."}` literal text, when authored.
    pub description: Option<String>,
    /// T09 array-omission marker: true exactly when the field-only
    /// required-array `!` spelling is present (`field_type = type ["!"]`,
    /// GRAMMAR L177; only `T[]!` is valid, GRAMMAR L192). Set from the
    /// spelling alone, never from nullability: a nullable array is always
    /// ordinary (omitted `T[]?` yields null). Maps to the frozen T09-TS
    /// `ArrayOmission` (`true` = `"required"`, `false` = `"ordinary"`,
    /// omit-to-`[]`); IR and descriptors thread it unchanged.
    pub required_array: bool,
}

/// One stored-field modifier: `trim`, `unique`, or a `min=`/`max=` bound.
#[derive(Debug, Clone)]
pub struct ModifierData {
    /// Modifier spelling (`trim`, `min`, `max` or `unique`).
    pub name: String,
    /// Modifier name node.
    pub node: NodeKey,
    /// Bound expression (`min=`/`max=` only).
    pub value: Option<NodeKey>,
}

/// Read-grant policy: `policy Model read=... [where=...] [fields=...]`.
#[derive(Debug, Clone)]
pub struct PolicyRule {
    /// Global rule ordinal across all models and kinds.
    pub id: u32,
    /// Declaring module.
    pub module: ModuleId,
    /// Policy declaration node.
    pub node: NodeKey,
    /// `read=` grant predicate.
    pub read: Option<NodeKey>,
    /// `where=` row predicate.
    pub where_predicate: Option<NodeKey>,
    /// Field grants as dotted selector paths (empty when `fields=` is
    /// absent, which grants ordinary fields and safe metadata).
    pub fields: Vec<String>,
    /// `fields=` selectors node.
    pub fields_node: Option<NodeKey>,
}

/// Row invariant: `invariant Model: predicate`.
#[derive(Debug, Clone)]
pub struct InvariantRule {
    /// Global rule ordinal across all models and kinds.
    pub id: u32,
    /// Declaring module.
    pub module: ModuleId,
    /// Invariant declaration node.
    pub node: NodeKey,
    /// Target symbol (a model, or module preferences for
    /// `invariant preferences:`).
    pub target: SymbolId,
    /// Invariant predicate.
    pub predicate: Option<NodeKey>,
}

/// Composite uniqueness: `unique Model fields=... [where=...]`.
#[derive(Debug, Clone)]
pub struct UniqueRule {
    /// Global rule ordinal across all models and kinds.
    pub id: u32,
    /// Declaring module.
    pub module: ModuleId,
    /// Unique declaration node.
    pub node: NodeKey,
    /// Constrained fields as dotted selector paths.
    pub fields: Vec<String>,
    /// `fields=` selectors node.
    pub fields_node: Option<NodeKey>,
    /// `where=` predicate (nulls participate only when included).
    pub where_predicate: Option<NodeKey>,
}

/// Pre-state field lock: `lock Model fields=... [when=...]`.
#[derive(Debug, Clone)]
pub struct LockRule {
    /// Global rule ordinal across all models and kinds.
    pub id: u32,
    /// Declaring module.
    pub module: ModuleId,
    /// Lock declaration node.
    pub node: NodeKey,
    /// Locked fields as dotted selector paths.
    pub fields: Vec<String>,
    /// `fields=` selectors node.
    pub fields_node: Option<NodeKey>,
    /// `when=` predicate (`None` means always locked).
    pub when: Option<NodeKey>,
}

/// Model lifetime: `retain Model until=...`.
#[derive(Debug, Clone)]
pub struct RetainRule {
    /// Global rule ordinal across all models and kinds.
    pub id: u32,
    /// Declaring module.
    pub module: ModuleId,
    /// Retain declaration node.
    pub node: NodeKey,
    /// `until=` deadline expression.
    pub until: Option<NodeKey>,
}

/// Module-level reference to one per-model rule (G9).
#[derive(Debug, Clone)]
pub struct RuleRef {
    /// Target symbol (a model, or preferences for its invariant).
    pub model: SymbolId,
    /// Rule kind.
    pub kind: RuleKind,
    /// Index into the kind's vector on the target's data.
    pub index: usize,
    /// Rule declaration node.
    pub node: NodeKey,
}

/// Rule kinds addressable by [`RuleRef`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleKind {
    Policy,
    Invariant,
    Unique,
    Lock,
    Retain,
}

/// Contract, event or preferences record with labels and fields (G4).
#[derive(Debug, Clone)]
pub struct RecordData {
    /// Record symbol.
    pub record: SymbolId,
    /// Declaring module.
    pub module: ModuleId,
    /// Declaration node.
    pub node: NodeKey,
    /// Declaration `label=` value node (`None` for events, which take no
    /// declaration attributes).
    pub label: Option<NodeKey>,
    /// Fields in declaration order.
    pub fields: Vec<FieldData>,
    /// Invariants on module preferences (`invariant preferences:`; other
    /// records never carry any).
    pub invariants: Vec<InvariantRule>,
}

/// Role with its label (G5).
#[derive(Debug, Clone)]
pub struct RoleData {
    /// Role symbol.
    pub role: SymbolId,
    /// Declaring module.
    pub module: ModuleId,
    /// Role declaration node.
    pub node: NodeKey,
    /// `label=` value node.
    pub label: Option<NodeKey>,
}

/// Capability with its version, availability and members (G6).
#[derive(Debug, Clone)]
pub struct CapabilityData {
    /// Capability symbol.
    pub capability: SymbolId,
    /// Declaring module.
    pub module: ModuleId,
    /// Capability declaration node.
    pub node: NodeKey,
    /// Decoded `version=` int literal, when the declaration pins one
    /// (`None` with `version_node` set means the literal was
    /// unparseable, e.g. overflow).
    pub version: Option<i64>,
    /// `version=` value node.
    pub version_node: Option<NodeKey>,
    /// Operations in declaration order.
    pub ops: Vec<CapabilityOpData>,
    /// Declared event symbols in declaration order (payloads live in
    /// [`EffectTables::records`]).
    pub events: Vec<SymbolId>,
    /// Producer-catalog version consulted (`""` when no catalog was
    /// available).
    pub catalog_version: String,
    /// Best-effort catalog availability by capability name (`None` when
    /// the catalog has no such entry; deployment bindings in
    /// [`Module`](crate::analysis::resolve::Module) imports join the rest).
    pub availability: Option<Availability>,
}

/// One capability operation with its signature and availability (G6).
#[derive(Debug, Clone)]
pub struct CapabilityOpData {
    /// Capability-op symbol.
    pub op: SymbolId,
    /// Operation declaration node.
    pub node: NodeKey,
    /// Parameters in signature order.
    pub params: Vec<ParamData>,
    /// `->` result annotation node.
    pub result: Option<NodeKey>,
    /// Best-effort catalog availability by `Capability.op`, else by op
    /// name (`None` when the catalog has no such entry).
    pub availability: Option<Availability>,
}

/// Named message with its text, locales and parameters (G7).
#[derive(Debug, Clone)]
pub struct MessageData {
    /// Message symbol.
    pub message: SymbolId,
    /// Declaring module.
    pub module: ModuleId,
    /// Message declaration node.
    pub node: NodeKey,
    /// Parameters in signature order.
    pub params: Vec<ParamData>,
    /// Decoded source-language text.
    pub source: String,
    /// Source language tag (module `source=`, default `"en"`).
    pub source_lang: String,
    /// `@{...}` variants in written order.
    pub variants: Vec<MessageVariant>,
}

/// One message/description locale variant: `locale=STRING|null`.
#[derive(Debug, Clone)]
pub struct MessageVariant {
    /// Locale tag as written.
    pub locale: String,
    /// Decoded text (`None` for `null`).
    pub value: Option<String>,
}

/// Derived field or function with its expression (G8).
#[derive(Debug, Clone)]
pub struct DeriveData {
    /// `DeriveField` or `DeriveFn` symbol.
    pub derive: SymbolId,
    /// Declaring module.
    pub module: ModuleId,
    /// Derive declaration node.
    pub node: NodeKey,
    /// Target model (derived fields only).
    pub model: Option<SymbolId>,
    /// Parameters in signature order (derived functions only).
    pub params: Vec<ParamData>,
    /// Declared result type node (derived functions) or field type node.
    pub result: Option<NodeKey>,
    /// Derived value expression.
    pub expr: Option<NodeKey>,
    /// `label=` value node (derived fields only).
    pub label: Option<NodeKey>,
}

/// Signature parameter with its type, default and label.
#[derive(Debug, Clone)]
pub struct ParamData {
    /// Checked optional input assistance; never an executable initializer.
    pub choices: Option<CheckedInputChoice>,
    /// Parameter symbol.
    pub param: SymbolId,
    /// Parameter declaration node.
    pub node: NodeKey,
    /// Declared type node.
    pub type_node: NodeKey,
    /// `=` default expression.
    pub default: Option<NodeKey>,
    /// `label=` value node.
    pub label: Option<NodeKey>,
    /// Trailing `@{desc="..."}` literal text, when authored.
    pub description: Option<String>,
}

/// Module data: pages, rule refs, migration refs, descriptions (G9).
#[derive(Debug, Clone)]
pub struct ModuleData {
    /// Module id.
    pub module: ModuleId,
    /// Source language tag (module `source=`, default `"en"`).
    pub source_lang: String,
    /// Checked deployment default locale (`context` / `locale default=`);
    /// `None` when the module declares no explicit default (the pinned
    /// `"en"` then applies downstream). Tag validity is the checker's
    /// (`types.rs` BCP 47 validation); this publishes the located value,
    /// mirroring `source_lang`.
    pub locale_default: Option<String>,
    /// Explicit locale declaration span, retained for composition conflicts.
    pub locale_default_span: Option<Span>,
    /// App-only explicit composition fold, followed by the pinned `"en"`
    /// default. Absent for packages or an incompatible composition.
    pub app_default_locale: Option<String>,
    /// Pages in source order.
    pub pages: Vec<PageData>,
    /// Policies declared in this module, in source order.
    pub policies: Vec<RuleRef>,
    /// Invariants declared in this module, in source order.
    pub invariants: Vec<RuleRef>,
    /// Uniques declared in this module, in source order.
    pub uniques: Vec<RuleRef>,
    /// Locks declared in this module, in source order.
    pub locks: Vec<RuleRef>,
    /// Retains declared in this module, in source order.
    pub retains: Vec<RuleRef>,
    /// Indices into [`EffectTables::migrations`] owned by this module.
    pub migrations: Vec<usize>,
    /// Attached `#` descriptions in this module's subtrees, in source order.
    pub descriptions: Vec<DescriptionEntry>,
}

/// Page AST refs: the page root plus its header slots.
#[derive(Debug, Clone)]
pub struct PageData {
    /// Page declaration node.
    pub node: NodeKey,
    /// Route node (`Route` with static/record/scalar segments).
    pub route: Option<NodeKey>,
    /// `title=` value node.
    pub title: Option<NodeKey>,
    /// `data=` value node.
    pub data: Option<NodeKey>,
}

/// One attached `#` description set with its owning declaration.
#[derive(Debug, Clone)]
pub struct DescriptionEntry {
    /// Description leaf node.
    pub node: NodeKey,
    /// Owned declaration node (the sibling the set precedes).
    pub owner: NodeKey,
    /// Joined prose text (empty for a lone `#=` reference).
    pub text: String,
    /// `@{...}` variants in written order.
    pub variants: Vec<MessageVariant>,
    /// Referenced message path for a lone `#= path` set.
    pub reference: Option<String>,
}

/// Checked description value: the D02b checked-description seam.
///
/// One logical slot per field/parameter declaration, however spelled:
/// inline `desc=` (a literal, a descriptor with variants, or a static
/// message path), the legacy `@{desc="..."}` annotation, or an attached
/// `#` set. The parser rejects every spelling combination (`E1202`), so
/// at most one is ever present; this value is the resolved form of
/// whichever one. Declaration-level `#` sets stay in
/// [`ModuleData::descriptions`]; this map covers only field/parameter
/// slots, where the new spellings live.
///
/// Frozen representation (`implementation/DESCRIPTION-REFERENCE-PLAN.md`):
/// `source` prose plus the owning `source_lang`, ordered `variants`,
/// and the authored-value `location` (`node` span; the file is the
/// span's source id). Absence — no entry in
/// [`EffectTables::checked_descriptions`] — is distinct from
/// authored-empty text (`source == ""`, kept, never collapsed to
/// absent); a `None` variant value is a `null` (absent) translation,
/// never empty text. Descriptions carry no parameters: static message
/// references resolve to wording (under the referenced message's
/// owning source language) while this value is built, and literal
/// braces in prose are never placeholder syntax.
///
/// Consumers: D03 lowers `source` into the existing MCP source-string
/// path and keeps `variants`; D04b extracts `ReferenceDescriptionValue`
/// (`source`, `sourceLang`, ordered `variants`, `location`); D06 hovers
/// the `source` wording in the source language.
#[derive(Debug, Clone)]
pub struct CheckedDescription {
    /// Owning field/parameter declaration node (the map key).
    pub owner: NodeKey,
    /// Authored description value node: the `DescriptionValue`, the
    /// legacy `Annotation`, or the attached `#` leaf. Its span is the
    /// checked value's `location`.
    pub node: NodeKey,
    /// Decoded source-language prose; `""` is authored-empty text.
    pub source: String,
    /// Owning source language tag: the authoring module's `source=`
    /// (default `"en"`), or the referenced message's owning module tag
    /// for message references.
    pub source_lang: String,
    /// `@{...}` variants in written order.
    pub variants: Vec<MessageVariant>,
    /// Referenced message symbol, for `desc= path` / `#= path`
    /// spellings (`None` for literal/descriptor spellings).
    pub message: Option<SymbolId>,
}

/// Migration with its owner, predecessor and directives (G9).
#[derive(Debug, Clone)]
pub struct MigrationData {
    /// Migration declaration node.
    pub node: NodeKey,
    /// Owner name as written (`migration Owner`).
    pub owner: String,
    /// Resolved owner module, when the name identifies one.
    pub module: Option<ModuleId>,
    /// Decoded `from=` predecessor snapshot id.
    pub from: Option<String>,
    /// `from=` value node.
    pub from_node: Option<NodeKey>,
    /// Directives in source order.
    pub directives: Vec<MigrationDirective>,
    /// Attached `#` descriptions in this migration's subtree.
    pub descriptions: Vec<DescriptionEntry>,
}

/// One migration directive: rename/drop/invalidate/backfill.
#[derive(Debug, Clone)]
pub enum MigrationDirective {
    /// `rename before.X to Y` (or bare `rename owner`).
    Rename {
        /// Directive node.
        node: NodeKey,
        /// Source path (`before.Model[.field]`, empty for bare owner).
        from: String,
        /// Target path (model or field).
        to: Option<String>,
        /// Whether this is the bare `rename owner` form.
        owner_only: bool,
    },
    /// `drop before.X` (or bare `drop owner`).
    Drop {
        /// Directive node.
        node: NodeKey,
        /// Dropped path (`before.Model[.field]`).
        target: Option<String>,
        /// Whether this is the bare `drop owner` form.
        owner_only: bool,
    },
    /// `invalidate before.handler`.
    Invalidate {
        /// Directive node.
        node: NodeKey,
        /// Handler path (`before.handler`).
        handler: String,
    },
    /// `backfill Model` with its guard/effect suite.
    Backfill {
        /// Directive node.
        node: NodeKey,
        /// Model name as written.
        model: String,
        /// Resolved model in the owner module, when unambiguous.
        resolved: Option<SymbolId>,
        /// Suite `require` guards in written order.
        guards: Vec<Effect>,
        /// Suite `do` effects in written order.
        effects: Vec<Effect>,
    },
}

// --- Entry point --------------------------------------------------------

/// Run effect/owner/disclosure analysis over `trees` and build the
/// emission tables.
///
/// Consumes the resolve and type tables plus the optional producer catalog;
/// appends `E4xxx` diagnostics to `diags` and returns the tables. Tables
/// are built best-effort: declarations that earlier passes rejected are
/// skipped, but one bad declaration never blocks the rest.
pub fn check_effects(
    db: &SourceDb,
    trees: &[(SourceId, SyntaxNode)],
    tables: &ResolveTables,
    types: &TypeTable,
    catalog: Option<&Catalog>,
    diags: &mut Vec<Diagnostic>,
) -> EffectTables {
    let mut cx = Cx::new(db, tables, types, catalog, diags);
    cx.walk_message_prepass(trees);
    for (file, tree) in trees {
        cx.walk_file(*file, tree);
    }
    cx.walk_calls_and_descriptions(trees);
    cx.finish(trees);
    cx.out.referenced_builtins.sort();
    cx.out.referenced_builtins.dedup();
    cx.out
}

/// Pass state: inputs, outputs and cross-declaration facts.
struct Cx<'a> {
    db: &'a SourceDb,
    tables: &'a ResolveTables,
    types: &'a TypeTable,
    catalog: Option<&'a Catalog>,
    diags: &'a mut Vec<Diagnostic>,
    out: EffectTables,
    /// Next global rule ordinal.
    next_rule_id: u32,
    /// Hook context while walking a hook body: (model, op).
    current_hook: Option<(SymbolId, CrudOp)>,
    /// Scenario currently walked (call-edge source).
    current_scenario: Option<SymbolId>,
    /// Whether `E4xxx` checks run in the current body (off for migration
    /// backfill suites, which belong to a later pass).
    checks_on: bool,
    /// Symbols already recorded (later duplicates are `E2002` elsewhere).
    recorded: HashSet<SymbolId>,
    /// Context-declared queue names per module.
    queues: HashMap<ModuleId, Vec<String>>,
    /// Context-declared analytics sink names per module.
    analytics: HashMap<ModuleId, Vec<String>>,
    /// Direct data models per scenario/derive (write targets and query domains).
    callable_models: HashMap<SymbolId, Vec<SymbolId>>,
    /// Bound local calls per scenario/derive (scenarios, derives and CRUD ops).
    callable_calls: HashMap<SymbolId, Vec<SymbolId>>,
    /// Executed create targets and supplied fields per callable.
    callable_creates: HashMap<SymbolId, Vec<(SymbolId, Vec<String>)>>,
    /// Checked expression calls whose omitted defaults execute in each callable.
    callable_default_calls: HashMap<SymbolId, Vec<NodeKey>>,
    /// Fixed scenario calls and their supplied argument names.
    callable_scenario_inputs: HashMap<SymbolId, Vec<(SymbolId, Vec<String>)>>,
    /// `on=every` handlers: (scenario, `on=` value span).
    every_handlers: Vec<(SymbolId, Span)>,
    /// Builtin ids referenced from checked call positions.
    builtins: HashSet<String>,
    /// Descriptions with their attribution context.
    descriptions: Vec<(DescCtx, DescriptionEntry)>,
}

/// Attribution of one description set.
#[derive(Debug, Clone)]
enum DescCtx {
    Module(ModuleId),
    Migration(NodeKey),
    Orphan,
}

impl<'a> Cx<'a> {
    fn new(
        db: &'a SourceDb,
        tables: &'a ResolveTables,
        types: &'a TypeTable,
        catalog: Option<&'a Catalog>,
        diags: &'a mut Vec<Diagnostic>,
    ) -> Self {
        Self {
            db,
            tables,
            types,
            catalog,
            diags,
            out: EffectTables::default(),
            next_rule_id: 0,
            current_hook: None,
            current_scenario: None,
            checks_on: true,
            recorded: HashSet::new(),
            queues: HashMap::new(),
            analytics: HashMap::new(),
            callable_models: HashMap::new(),
            callable_calls: HashMap::new(),
            callable_creates: HashMap::new(),
            callable_default_calls: HashMap::new(),
            callable_scenario_inputs: HashMap::new(),
            every_handlers: Vec::new(),
            builtins: HashSet::new(),
            descriptions: Vec::new(),
        }
    }

    fn text(&self, file: SourceId) -> &str {
        self.db.get(file).map(|s| s.text.as_str()).unwrap_or("")
    }

    fn finish(&mut self, trees: &[(SourceId, SyntaxNode)]) {
        self.check_app_locales();
        self.check_app_policies();
        self.record_creation_dependencies(trees);
        self.check_every_scopes();
        self.out.referenced_builtins = self.builtins.iter().cloned().collect();
        let descriptions = std::mem::take(&mut self.descriptions);
        for (ctx, entry) in descriptions {
            match ctx {
                DescCtx::Module(module) => {
                    if let Some(data) = self.out.modules.get_mut(&module) {
                        data.descriptions.push(entry);
                    }
                }
                DescCtx::Migration(node) => {
                    if let Some(data) = self.out.migrations.iter_mut().find(|m| m.node == node) {
                        data.descriptions.push(entry);
                    }
                }
                DescCtx::Orphan => {}
            }
        }
    }

    /// Fold explicit app contexts along resolved product membership only.
    /// Child defaults and symbol imports never participate in this fold.
    fn check_app_locales(&mut self) {
        for app in &self.tables.modules {
            if app.kind == ModuleKind::Package {
                continue;
            }
            let mut pending = vec![app.id];
            let mut seen = HashSet::new();
            let mut explicit: Option<(String, Span)> = None;
            let mut conflict = false;
            while let Some(id) = pending.pop() {
                if !seen.insert(id) {
                    continue;
                }
                let module = &self.tables.modules[id.0 as usize];
                if module.kind == ModuleKind::Package {
                    continue;
                }
                pending.extend(module.uses_resolved.iter().rev().copied());
                let Some(data) = self.out.modules.get(&id) else {
                    continue;
                };
                let Some(tag) = &data.locale_default else {
                    continue;
                };
                let span = data.locale_default_span.unwrap_or(module.name_span);
                if let Some((first, first_span)) = &explicit {
                    if !first.eq_ignore_ascii_case(tag) {
                        conflict = true;
                        let mut diagnostic = Diagnostic::error(
                            "E2002",
                            format!(
                                "app '{}' has incompatible explicit locale defaults '{first}' and '{tag}'",
                                app.name,
                            ),
                            span,
                        );
                        diagnostic.related.push(Related {
                            span: *first_span,
                            message: format!("first explicit locale default '{first}'"),
                        });
                        self.diags.push(diagnostic);
                    }
                } else {
                    explicit = Some((tag.clone(), span));
                }
            }
            if !conflict && let Some(data) = self.out.modules.get_mut(&app.id) {
                data.app_default_locale =
                    Some(explicit.map_or_else(|| "en".into(), |(tag, _)| tag));
            }
        }
    }

    // --- Files, modules, sections ----------------------------------------

    fn walk_file(&mut self, file: SourceId, tree: &SyntaxNode) {
        let text = self.text(file).to_string();
        for child in significant_children(tree) {
            match child.kind {
                SyntaxKind::App | SyntaxKind::Package => self.walk_module(file, &text, child),
                SyntaxKind::Migration => self.walk_migration(file, &text, child),
                _ => {}
            }
        }
    }

    /// Pre-walk every module's messages so field/parameter description
    /// references resolve to wording regardless of declaration order:
    /// message wording must be complete before any record/signature walk
    /// builds the checked-description seam. Reuses [`Cx::walk_message`],
    /// which is idempotent via [`Cx::take_record`], so the main walk
    /// skips pre-recorded messages without behavior change.
    fn walk_message_prepass(&mut self, trees: &[(SourceId, SyntaxNode)]) {
        for (file, tree) in trees {
            let text = self.text(*file).to_string();
            for child in significant_children(tree) {
                if !matches!(child.kind, SyntaxKind::App | SyntaxKind::Package) {
                    continue;
                }
                let Some(module) = self.ensure_module(&text, child) else {
                    continue;
                };
                for section in significant_children(child) {
                    if section.kind != SyntaxKind::Section {
                        continue;
                    }
                    let marker = significant_children(section)
                        .iter()
                        .find_map(|n| name_text(n, &text))
                        .unwrap_or("");
                    if marker != "Given" {
                        continue;
                    }
                    for item in significant_children(section) {
                        if item.kind == SyntaxKind::Message && !has_error(item) {
                            self.walk_message(*file, module, &text, item);
                        }
                    }
                }
            }
        }
    }

    /// Insert this module's [`ModuleData`] (with its `source=` tag)
    /// unless already present; returns the module id.
    fn ensure_module(&mut self, text: &str, node: &SyntaxNode) -> Option<ModuleId> {
        let name = decl_name(text, node, &["app", "package", "export", "migration"])?;
        let module = self.tables.module_by_name.get(name).copied()?;
        let source_lang = module_source_lang(text, node);
        self.out
            .modules
            .entry(module)
            .or_insert_with(|| ModuleData {
                module,
                source_lang,
                locale_default: None,
                locale_default_span: None,
                app_default_locale: None,
                pages: Vec::new(),
                policies: Vec::new(),
                invariants: Vec::new(),
                uniques: Vec::new(),
                locks: Vec::new(),
                retains: Vec::new(),
                migrations: Vec::new(),
                descriptions: Vec::new(),
            });
        Some(module)
    }

    fn walk_module(&mut self, file: SourceId, text: &str, node: &SyntaxNode) {
        let Some(module) = self.ensure_module(text, node) else {
            return;
        };
        for child in significant_children(node) {
            match child.kind {
                SyntaxKind::Context => self.walk_context(module, text, child),
                SyntaxKind::Section => self.walk_section(file, module, text, child),
                _ => {}
            }
        }
    }

    /// Collect context-declared queue/analytics names for `send` targets
    /// and publish the checked `locale default=` tag (if any) on this
    /// module's [`ModuleData`]. Duplicate `locale` declarations are the
    /// checker's (`E2002`); the last located value wins here, mirroring
    /// the single-writer contract of the other context collectors.
    fn walk_context(&mut self, module: ModuleId, text: &str, node: &SyntaxNode) {
        for decl in significant_children(node) {
            if decl.kind != SyntaxKind::ContextDecl || has_error(decl) {
                continue;
            }
            let names: Vec<&str> = significant_children(decl)
                .iter()
                .filter_map(|n| name_text(n, text))
                .collect();
            match names.as_slice() {
                ["queue", name, ..] => {
                    push_unique(self.queues.entry(module).or_default(), (*name).to_string())
                }
                ["analytics", name, ..] => push_unique(
                    self.analytics.entry(module).or_default(),
                    (*name).to_string(),
                ),
                ["locale", ..] => {
                    let Some(tag) = attribute_value(decl, "default", text)
                        .and_then(|v| literal_string(text, v))
                    else {
                        continue;
                    };
                    if let Some(data) = self.out.modules.get_mut(&module) {
                        data.locale_default = Some(tag);
                        data.locale_default_span = Some(decl.span);
                    }
                }
                _ => {}
            }
        }
    }

    fn walk_section(&mut self, file: SourceId, module: ModuleId, text: &str, node: &SyntaxNode) {
        let marker = significant_children(node)
            .iter()
            .find_map(|n| name_text(n, text))
            .unwrap_or("");
        for item in significant_children(node) {
            if has_error(item) {
                continue;
            }
            match (marker, item.kind) {
                ("Given", SyntaxKind::Model) => self.walk_model(file, module, text, item),
                ("Given", SyntaxKind::Contract | SyntaxKind::Event) => {
                    self.walk_record(file, module, text, item);
                }
                ("Given", SyntaxKind::Preferences) => {
                    self.walk_preferences(file, module, text, item)
                }
                ("Given", SyntaxKind::Role) => self.walk_role(file, module, text, item),
                ("Given", SyntaxKind::Capability) => self.walk_capability(file, module, text, item),
                ("Given", SyntaxKind::Message) => self.walk_message(file, module, text, item),
                ("Given", SyntaxKind::Derive) => self.walk_derive(file, module, text, item),
                (
                    "Given",
                    SyntaxKind::Policy
                    | SyntaxKind::Invariant
                    | SyntaxKind::Unique
                    | SyntaxKind::Lock
                    | SyntaxKind::Retain,
                ) => self.walk_rule(file, module, text, item),
                ("When", SyntaxKind::Scenario) => self.walk_scenario(file, module, text, item),
                ("When", SyntaxKind::Crud) => self.walk_crud(file, module, text, item),
                ("Then", SyntaxKind::Page) => self.walk_page(module, text, item),
                _ => {}
            }
        }
    }

    // --- Symbol lookup -----------------------------------------------------

    /// Production symbol declared by `node` (locals only; imports never
    /// redeclare).
    fn decl_symbol(
        &self,
        module: ModuleId,
        text: &str,
        node: &SyntaxNode,
        heads: &[&str],
    ) -> Option<SymbolId> {
        let name = decl_name(text, node, heads)?;
        match self.tables.module_scopes[module.0 as usize].prod.get(name) {
            Some(ScopedName::Local(id)) => Some(*id),
            _ => None,
        }
    }

    /// Production or imported symbol named `name` in `module`.
    fn prod_or_imported(&self, module: ModuleId, name: &str) -> Option<SymbolId> {
        match self.tables.module_scopes[module.0 as usize].prod.get(name) {
            Some(ScopedName::Local(id) | ScopedName::Imported { target: id, .. }) => Some(*id),
            _ => None,
        }
    }

    /// Whether `id` reaches `module` through a bound (`from=`) import.
    fn is_bound_import(&self, module: ModuleId, id: SymbolId) -> bool {
        self.tables.module_scopes[module.0 as usize]
            .prod
            .values()
            .any(|entry| matches!(entry, ScopedName::Imported { target, bound: true } if *target == id))
    }

    /// Stored field of `owner` named `name`.
    fn field_named(&self, owner: SymbolId, name: &str) -> Option<SymbolId> {
        self.tables.symbols[owner.0 as usize]
            .fields_of()
            .iter()
            .copied()
            .find(|f| {
                self.tables.symbols[f.0 as usize].name == name
                    && matches!(
                        self.tables.symbols[f.0 as usize].kind,
                        SymbolKind::Field { .. }
                    )
            })
    }

    /// Any record field (stored or derived) of `owner` named `name`.
    fn record_field_named(&self, owner: SymbolId, name: &str) -> Option<SymbolId> {
        self.tables.symbols[owner.0 as usize]
            .fields_of()
            .iter()
            .copied()
            .find(|f| self.tables.symbols[f.0 as usize].name == name)
    }

    /// Short (same-module) or canonical symbol name for diagnostics.
    fn show(&self, module: ModuleId, id: SymbolId) -> String {
        let symbol = &self.tables.symbols[id.0 as usize];
        if symbol.module == module {
            symbol.name.clone()
        } else {
            symbol.canonical.clone()
        }
    }

    /// Whether `id` was already recorded (duplicates are `E2002`).
    fn take_record(&mut self, id: SymbolId) -> bool {
        self.recorded.insert(id)
    }

    // --- Given: models, records, roles, capabilities, messages, derives ----

    fn walk_model(&mut self, _file: SourceId, module: ModuleId, text: &str, node: &SyntaxNode) {
        let Some(id) = self.decl_symbol(module, text, node, &["export"]) else {
            return;
        };
        if !matches!(
            self.tables.symbols[id.0 as usize].kind,
            SymbolKind::Model { .. }
        ) || !self.take_record(id)
        {
            return;
        }
        let owner = match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::Model { owner, .. } => *owner,
            _ => ModelOwner::Team,
        };
        let data = ModelData {
            model: id,
            module,
            node: NodeKey::of(node),
            label: attribute_value(node, "label", text).map(NodeKey::of),
            owner,
            fields: self.record_fields(text, id, node),
            policies: Vec::new(),
            invariants: Vec::new(),
            uniques: Vec::new(),
            locks: Vec::new(),
            retains: Vec::new(),
        };
        self.out.models.insert(id, data);
    }

    fn walk_record(&mut self, _file: SourceId, module: ModuleId, text: &str, node: &SyntaxNode) {
        let head = if node.kind == SyntaxKind::Contract {
            "contract"
        } else {
            "event"
        };
        let Some(id) = self.decl_symbol(module, text, node, &["export", head]) else {
            return;
        };
        if !matches!(
            self.tables.symbols[id.0 as usize].kind,
            SymbolKind::Contract { .. } | SymbolKind::Event { .. }
        ) || !self.take_record(id)
        {
            return;
        }
        let data = RecordData {
            record: id,
            module,
            node: NodeKey::of(node),
            label: attribute_value(node, "label", text).map(NodeKey::of),
            fields: self.record_fields(text, id, node),
            invariants: Vec::new(),
        };
        self.out.records.insert(id, data);
    }

    fn walk_preferences(
        &mut self,
        _file: SourceId,
        module: ModuleId,
        text: &str,
        node: &SyntaxNode,
    ) {
        let prefs = self
            .tables
            .symbols
            .iter()
            .find(|s| s.module == module && matches!(s.kind, SymbolKind::Preferences { .. }))
            .map(|s| s.id);
        let Some(id) = prefs else { return };
        if !self.take_record(id) {
            return;
        }
        let data = RecordData {
            record: id,
            module,
            node: NodeKey::of(node),
            label: attribute_value(node, "label", text).map(NodeKey::of),
            fields: self.record_fields(text, id, node),
            invariants: Vec::new(),
        };
        self.out.records.insert(id, data);
    }

    /// Stored fields of one record declaration in source order.
    fn record_fields(&mut self, text: &str, owner: SymbolId, node: &SyntaxNode) -> Vec<FieldData> {
        let mut fields = Vec::new();
        let mut seen: HashSet<SymbolId> = HashSet::new();
        for child in node.children.iter().filter(|c| c.kind == SyntaxKind::Field) {
            if has_error(child) {
                continue;
            }
            let name = significant_children(child)
                .first()
                .filter(|n| n.kind == SyntaxKind::Name)
                .and_then(|n| name_text(n, text));
            let Some(field) = name.and_then(|n| self.field_named(owner, n)) else {
                continue;
            };
            if !seen.insert(field) {
                continue;
            }
            let type_node = match &self.tables.symbols[field.0 as usize].kind {
                SymbolKind::Field { type_node, .. } => *type_node,
                _ => NodeKey::of(child),
            };
            let shape = field_shape(text, child);
            let owner_module = self.tables.symbols[owner.0 as usize].module;
            if let Some(checked) = checked_description(
                self.tables,
                &self.out.messages,
                &self.out.modules,
                owner_module,
                text,
                node,
                child,
            ) {
                self.out
                    .checked_descriptions
                    .insert(NodeKey::of(child), checked);
            }
            fields.push(FieldData {
                field,
                node: NodeKey::of(child),
                type_node,
                default: shape.default,
                server: shape.server,
                modifiers: shape.modifiers,
                label: shape.label,
                description: annotation_desc(text, child),
                required_array: shape.required_array,
            });
        }
        fields
    }

    /// Parameters of one signature in source order.
    fn signature_params(
        &mut self,
        text: &str,
        owner: SymbolId,
        params: &[SymbolId],
        node: &SyntaxNode,
    ) -> Vec<ParamData> {
        let mut out = Vec::new();
        let mut seen: HashSet<SymbolId> = HashSet::new();
        for child in node
            .children
            .iter()
            .filter(|c| c.kind == SyntaxKind::Parameter)
        {
            if has_error(child) {
                continue;
            }
            let name = significant_children(child)
                .first()
                .filter(|n| n.kind == SyntaxKind::Name)
                .and_then(|n| name_text(n, text));
            let param = name.and_then(|n| {
                params.iter().copied().find(|p| {
                    self.tables.symbols[p.0 as usize].name == n
                        && matches!(
                            self.tables.symbols[p.0 as usize].kind,
                            SymbolKind::Param { owner: o, .. } if o == owner
                        )
                })
            });
            let Some(param) = param else { continue };
            if !seen.insert(param) {
                continue;
            }
            let type_node = match &self.tables.symbols[param.0 as usize].kind {
                SymbolKind::Param { type_node, .. } => *type_node,
                _ => NodeKey::of(child),
            };
            let shape = param_shape(text, child);
            let owner_module = self.tables.symbols[owner.0 as usize].module;
            if let Some(checked) = checked_description(
                self.tables,
                &self.out.messages,
                &self.out.modules,
                owner_module,
                text,
                node,
                child,
            ) {
                self.out
                    .checked_descriptions
                    .insert(NodeKey::of(child), checked);
            }
            out.push(ParamData {
                choices: self.types.input_choices.get(&param).cloned(),
                param,
                node: NodeKey::of(child),
                type_node,
                default: shape.default,
                label: shape.label,
                description: annotation_desc(text, child),
            });
        }
        out
    }

    fn walk_role(&mut self, _file: SourceId, module: ModuleId, text: &str, node: &SyntaxNode) {
        let Some(id) = self.decl_symbol(module, text, node, &["export", "role"]) else {
            return;
        };
        if !matches!(self.tables.symbols[id.0 as usize].kind, SymbolKind::Role)
            || !self.take_record(id)
        {
            return;
        }
        self.out.roles.insert(
            id,
            RoleData {
                role: id,
                module,
                node: NodeKey::of(node),
                label: attribute_value(node, "label", text).map(NodeKey::of),
            },
        );
    }

    fn walk_capability(
        &mut self,
        _file: SourceId,
        module: ModuleId,
        text: &str,
        node: &SyntaxNode,
    ) {
        let Some(id) = self.decl_symbol(module, text, node, &["export", "capability"]) else {
            return;
        };
        let (ops, events) = match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::Capability { ops, events } => (ops.clone(), events.clone()),
            _ => return,
        };
        if !self.take_record(id) {
            return;
        }
        let version_node = attribute_value(node, "version", text).map(NodeKey::of);
        let version = attribute_value(node, "version", text).and_then(|v| int_literal(text, v));
        let cap_name = self.tables.symbols[id.0 as usize].name.clone();
        let mut op_data = Vec::new();
        let mut event_ids = Vec::new();
        for child in node.children.iter().filter(|c| {
            matches!(c.kind, SyntaxKind::CapabilityOp | SyntaxKind::Event) && !has_error(c)
        }) {
            let op_name = significant_children(child).iter().find_map(|n| {
                let word = name_text(n, text)?;
                (word != "event").then_some(word.to_string())
            });
            let Some(op_name) = op_name else { continue };
            if child.kind == SyntaxKind::CapabilityOp {
                let op = ops.iter().copied().find(|o| {
                    self.tables.symbols[o.0 as usize].name == op_name
                        && matches!(
                            self.tables.symbols[o.0 as usize].kind,
                            SymbolKind::CapabilityOp { .. }
                        )
                });
                let Some(op) = op else { continue };
                if !self.take_record(op) {
                    continue;
                }
                let params = match &self.tables.symbols[op.0 as usize].kind {
                    SymbolKind::CapabilityOp { params, .. } => params.clone(),
                    _ => Vec::new(),
                };
                let qualified = format!("{cap_name}.{op_name}");
                op_data.push(CapabilityOpData {
                    op,
                    node: NodeKey::of(child),
                    params: self.signature_params(text, op, &params, child),
                    result: result_annotation(text, child).map(NodeKey::of),
                    availability: self
                        .catalog
                        .and_then(|c| c.availability(&qualified))
                        .or_else(|| self.catalog.and_then(|c| c.availability(&op_name))),
                });
            } else {
                let event = events.iter().copied().find(|e| {
                    self.tables.symbols[e.0 as usize].name == op_name
                        && matches!(
                            self.tables.symbols[e.0 as usize].kind,
                            SymbolKind::Event { .. }
                        )
                });
                let Some(event) = event else { continue };
                if !self.take_record(event) {
                    continue;
                }
                let fields = self.record_fields(text, event, child);
                self.out.records.insert(
                    event,
                    RecordData {
                        record: event,
                        module,
                        node: NodeKey::of(child),
                        label: None,
                        fields,
                        invariants: Vec::new(),
                    },
                );
                event_ids.push(event);
            }
        }
        self.out.capabilities.insert(
            id,
            CapabilityData {
                capability: id,
                module,
                node: NodeKey::of(node),
                version,
                version_node,
                ops: op_data,
                events: event_ids,
                catalog_version: self
                    .catalog
                    .map_or_else(String::new, |c| c.version().to_string()),
                availability: self.catalog.and_then(|c| c.availability(&cap_name)),
            },
        );
    }

    fn walk_message(&mut self, _file: SourceId, module: ModuleId, text: &str, node: &SyntaxNode) {
        let Some(id) = self.decl_symbol(module, text, node, &["export", "message"]) else {
            return;
        };
        let params = match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::Message { params } => params.clone(),
            _ => return,
        };
        if !self.take_record(id) {
            return;
        }
        let value = significant_children(node)
            .iter()
            .find(|n| n.kind == SyntaxKind::MessageValue)
            .copied();
        let (source, variants) = value.map(|v| message_text(text, v)).unwrap_or_default();
        let source_lang = self
            .out
            .modules
            .get(&module)
            .map(|m| m.source_lang.clone())
            .unwrap_or_else(|| "en".to_string());
        let signature = self.signature_params(text, id, &params, node);
        self.out.messages.insert(
            id,
            MessageData {
                message: id,
                module,
                node: NodeKey::of(node),
                params: signature,
                source,
                source_lang,
                variants,
            },
        );
    }

    fn walk_derive(&mut self, _file: SourceId, module: ModuleId, text: &str, node: &SyntaxNode) {
        let parts = significant_children(node);
        let path = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied();
        let Some(path) = path else { return };
        let segments = path_segments(path, text);
        let is_function = parts.iter().any(|n| is_punct(n, text, "("));
        let (id, model, params) = if is_function {
            if segments.len() != 1 {
                return;
            }
            let Some(id) = self.prod_or_imported(module, segments[0]) else {
                return;
            };
            let params = match &self.tables.symbols[id.0 as usize].kind {
                SymbolKind::DeriveFn { params, .. } => params.clone(),
                _ => return,
            };
            (id, None, params)
        } else {
            if segments.len() != 2 {
                return;
            }
            let Some(owner) = self.prod_or_imported(module, segments[0]) else {
                return;
            };
            if !matches!(
                self.tables.symbols[owner.0 as usize].kind,
                SymbolKind::Model { .. }
            ) {
                return;
            }
            let field = self.tables.symbols[owner.0 as usize]
                .fields_of()
                .iter()
                .copied()
                .find(|f| {
                    self.tables.symbols[f.0 as usize].name == segments[1]
                        && matches!(
                            self.tables.symbols[f.0 as usize].kind,
                            SymbolKind::DeriveField { .. }
                        )
                });
            let Some(field) = field else { return };
            (field, Some(owner), Vec::new())
        };
        if !self.take_record(id) {
            return;
        }
        let expr = parts.iter().find(|n| is_expression(n.kind)).copied();
        let result = parts.iter().find(|n| is_type_node(n.kind)).copied();
        let signature = self.signature_params(text, id, &params, node);
        if let Some(expr) = expr {
            self.record_data_dependencies(id, text, expr);
        }
        self.out.derives.insert(
            id,
            DeriveData {
                derive: id,
                module,
                node: NodeKey::of(node),
                model,
                params: signature,
                result: result.map(NodeKey::of),
                expr: expr.map(NodeKey::of),
                label: bare_slot_value(node, "label", text).map(NodeKey::of),
            },
        );
    }

    // --- Given: rules ------------------------------------------------------

    fn walk_rule(&mut self, _file: SourceId, module: ModuleId, text: &str, node: &SyntaxNode) {
        let parts = significant_children(node);
        let target = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied();
        let target_id = target.and_then(|t| self.tables.node_symbol.get(&NodeKey::of(t)).copied());
        let Some(target_id) = target_id else { return };
        let is_model = matches!(
            self.tables.symbols[target_id.0 as usize].kind,
            SymbolKind::Model { .. }
        );
        let is_prefs = node.kind == SyntaxKind::Invariant
            && matches!(
                self.tables.symbols[target_id.0 as usize].kind,
                SymbolKind::Preferences { .. }
            );
        if !is_model && !is_prefs {
            return;
        }
        // E4002: rules belong to the model's own package.
        if self.tables.symbols[target_id.0 as usize].module != module
            && let Some(target) = target
        {
            self.diags.push(Diagnostic::error(
                "E4002",
                format!(
                    "{} targets '{}', which belongs to another package; other packages cannot extend its {}",
                    rule_noun(node.kind),
                    self.show(module, target_id),
                    rule_noun(node.kind),
                ),
                tight_span(text, target),
            ));
        }
        let id = self.next_rule_id;
        self.next_rule_id += 1;
        match node.kind {
            SyntaxKind::Policy => {
                let (mut fields, fields_node) = selector_paths(text, node, "fields");
                if let Some(selectors) = attribute_value(node, "fields", text) {
                    fields = significant_children(selectors)
                        .iter()
                        .filter(|path| path.kind == SyntaxKind::Path)
                        .map(|path| {
                            self.types
                                .delivery_selectors
                                .get(&NodeKey::of(path))
                                .cloned()
                                .unwrap_or_else(|| path_segments(path, text).join("."))
                        })
                        .collect();
                }
                if let (Some(model), true) = (is_model.then_some(target_id), self.checks_on) {
                    self.check_secret_grant(module, text, model, node);
                    self.check_leaf_grant_reference(text, model, node);
                }
                let index = self
                    .out
                    .models
                    .get(&target_id)
                    .map(|m| m.policies.len())
                    .unwrap_or(0);
                let rule = PolicyRule {
                    id,
                    module,
                    node: NodeKey::of(node),
                    read: attribute_value(node, "read", text).map(NodeKey::of),
                    where_predicate: attribute_value(node, "where", text).map(NodeKey::of),
                    fields,
                    fields_node,
                };
                if let Some(data) = self.out.models.get_mut(&target_id) {
                    data.policies.push(rule);
                }
                self.push_rule_ref(
                    module,
                    RuleRef {
                        model: target_id,
                        kind: RuleKind::Policy,
                        index,
                        node: NodeKey::of(node),
                    },
                );
            }
            SyntaxKind::Invariant => {
                let predicate = parts.iter().find(|n| is_expression(n.kind)).copied();
                let rule = InvariantRule {
                    id,
                    module,
                    node: NodeKey::of(node),
                    target: target_id,
                    predicate: predicate.map(NodeKey::of),
                };
                let index = if is_model {
                    let index = self
                        .out
                        .models
                        .get(&target_id)
                        .map(|m| m.invariants.len())
                        .unwrap_or(0);
                    if let Some(data) = self.out.models.get_mut(&target_id) {
                        data.invariants.push(rule);
                    }
                    index
                } else {
                    let index = self
                        .out
                        .records
                        .get(&target_id)
                        .map(|r| r.invariants.len())
                        .unwrap_or(0);
                    if let Some(data) = self.out.records.get_mut(&target_id) {
                        data.invariants.push(rule);
                    }
                    index
                };
                self.push_rule_ref(
                    module,
                    RuleRef {
                        model: target_id,
                        kind: RuleKind::Invariant,
                        index,
                        node: NodeKey::of(node),
                    },
                );
            }
            SyntaxKind::Unique => {
                let (fields, fields_node) = selector_paths(text, node, "fields");
                let index = self
                    .out
                    .models
                    .get(&target_id)
                    .map(|m| m.uniques.len())
                    .unwrap_or(0);
                let rule = UniqueRule {
                    id,
                    module,
                    node: NodeKey::of(node),
                    fields,
                    fields_node,
                    where_predicate: attribute_value(node, "where", text).map(NodeKey::of),
                };
                if let Some(data) = self.out.models.get_mut(&target_id) {
                    data.uniques.push(rule);
                }
                self.push_rule_ref(
                    module,
                    RuleRef {
                        model: target_id,
                        kind: RuleKind::Unique,
                        index,
                        node: NodeKey::of(node),
                    },
                );
            }
            SyntaxKind::Lock => {
                let (fields, fields_node) = selector_paths(text, node, "fields");
                let index = self
                    .out
                    .models
                    .get(&target_id)
                    .map(|m| m.locks.len())
                    .unwrap_or(0);
                let rule = LockRule {
                    id,
                    module,
                    node: NodeKey::of(node),
                    fields,
                    fields_node,
                    when: attribute_value(node, "when", text).map(NodeKey::of),
                };
                if let Some(data) = self.out.models.get_mut(&target_id) {
                    data.locks.push(rule);
                }
                self.push_rule_ref(
                    module,
                    RuleRef {
                        model: target_id,
                        kind: RuleKind::Lock,
                        index,
                        node: NodeKey::of(node),
                    },
                );
            }
            SyntaxKind::Retain => {
                let index = self
                    .out
                    .models
                    .get(&target_id)
                    .map(|m| m.retains.len())
                    .unwrap_or(0);
                let rule = RetainRule {
                    id,
                    module,
                    node: NodeKey::of(node),
                    until: attribute_value(node, "until", text).map(NodeKey::of),
                };
                if let Some(data) = self.out.models.get_mut(&target_id) {
                    data.retains.push(rule);
                }
                self.push_rule_ref(
                    module,
                    RuleRef {
                        model: target_id,
                        kind: RuleKind::Retain,
                        index,
                        node: NodeKey::of(node),
                    },
                );
            }
            _ => {}
        }
    }

    fn push_rule_ref(&mut self, module: ModuleId, rule: RuleRef) {
        // Skip refs with no stored rule behind them: on dirty programs
        // the target's model/record data can be missing (the rule push
        // was skipped), and index 0 would dangle.
        let anchored = match rule.kind {
            RuleKind::Policy => self
                .out
                .models
                .get(&rule.model)
                .is_some_and(|m| rule.index < m.policies.len()),
            RuleKind::Invariant => {
                self.out
                    .models
                    .get(&rule.model)
                    .is_some_and(|m| rule.index < m.invariants.len())
                    || self
                        .out
                        .records
                        .get(&rule.model)
                        .is_some_and(|r| rule.index < r.invariants.len())
            }
            RuleKind::Unique => self
                .out
                .models
                .get(&rule.model)
                .is_some_and(|m| rule.index < m.uniques.len()),
            RuleKind::Lock => self
                .out
                .models
                .get(&rule.model)
                .is_some_and(|m| rule.index < m.locks.len()),
            RuleKind::Retain => self
                .out
                .models
                .get(&rule.model)
                .is_some_and(|m| rule.index < m.retains.len()),
        };
        if !anchored {
            return;
        }
        let Some(data) = self.out.modules.get_mut(&module) else {
            return;
        };
        match rule.kind {
            RuleKind::Policy => data.policies.push(rule),
            RuleKind::Invariant => data.invariants.push(rule),
            RuleKind::Unique => data.uniques.push(rule),
            RuleKind::Lock => data.locks.push(rule),
            RuleKind::Retain => data.retains.push(rule),
        }
    }

    /// E4010: a policy `fields=` grant resolving to a `secret` leaf.
    fn check_secret_grant(
        &mut self,
        _module: ModuleId,
        text: &str,
        model: SymbolId,
        node: &SyntaxNode,
    ) {
        let Some(selectors) = attribute_value(node, "fields", text) else {
            return;
        };
        if selectors.kind != SyntaxKind::Selectors {
            return;
        }
        for child in significant_children(selectors) {
            if child.kind != SyntaxKind::Path {
                continue;
            }
            let segments = path_segments(child, text);
            if self.selector_is_secret(model, &segments) {
                self.diags.push(Diagnostic::error(
                    "E4010",
                    format!(
                        "policy grants secret field '{}'; grants never include secrets",
                        segments.join("."),
                    ),
                    tight_span(text, child),
                ));
            }
        }
    }

    /// Whether a `fields=` selector path resolves to a `secret` leaf:
    /// the head must be a field of `model`; descent continues only
    /// through contract/event records. Nullable layers never hide a
    /// secret: both intermediates and the leaf unwrap one `Nullable`
    /// (the types pass never nests them).
    fn selector_is_secret(&self, model: SymbolId, segments: &[&str]) -> bool {
        let [head, rest @ ..] = segments else {
            return false;
        };
        let Some(field) = self.record_field_named(model, head) else {
            return false;
        };
        let mut ty = self.types.symbol_types.get(&field).cloned();
        for segment in rest {
            if let Some(ResolvedType::Nullable(inner)) = ty {
                ty = Some(*inner);
            }
            let Some(ResolvedType::Record { symbol, .. }) = ty else {
                return false;
            };
            if !matches!(
                self.tables.symbols[symbol.0 as usize].kind,
                SymbolKind::Contract { .. } | SymbolKind::Event { .. }
            ) {
                return false;
            }
            let Some(next) = self.record_field_named(symbol, segment) else {
                return false;
            };
            ty = self.types.symbol_types.get(&next).cloned();
        }
        if let Some(ResolvedType::Nullable(inner)) = ty {
            ty = Some(*inner);
        }
        matches!(ty, Some(ResolvedType::Scalar(Scalar::Secret)))
    }

    /// E4012: a policy `fields=` leaf grant traversing a `user`/`member`
    /// reference (UI table selector lists share the core check, A5/S4).
    ///
    /// Leaf-grant interiors must be singular embedded typed values
    /// (contract/event record descent with nullable unwrap, expression
    /// value leaves, terminal delivery observations); they are never
    /// model/user/member references, arrays, JSON, files, secrets or
    /// actions (DESIGN §4, T25-L1). Unknown paths and every other
    /// unsupported traversal already fail in the types pass (`E2013`);
    /// secret leaves are `E4010`. This check owns only the gap the types
    /// pass accepts: member chains through `user`/`member` references,
    /// which would otherwise infer directory authority from a field
    /// grant. It stays silent unless the whole path resolves exactly as
    /// the types pass accepts it, so one bad path reports exactly one
    /// diagnostic.
    fn check_leaf_grant_reference(&mut self, text: &str, model: SymbolId, node: &SyntaxNode) {
        self.check_leaf_grant_reference_in(text, model, node, "fields", "policy grants leaf");
    }

    /// E4012 core over one selector list: report every `attr=` selector
    /// traversing a `user`/`member` reference. `head` names the list in
    /// the message, keeping policy and UI table contexts distinct
    /// (A5/S4).
    fn check_leaf_grant_reference_in(
        &mut self,
        text: &str,
        model: SymbolId,
        node: &SyntaxNode,
        attr: &str,
        head: &str,
    ) {
        let Some(selectors) = attribute_value(node, attr, text) else {
            return;
        };
        if selectors.kind != SyntaxKind::Selectors {
            return;
        }
        for child in significant_children(selectors) {
            if child.kind != SyntaxKind::Path {
                continue;
            }
            let segments = path_segments(child, text);
            if let Some(noun) = self.selector_traverses_reference(model, &segments) {
                self.diags.push(Diagnostic::error(
                    "E4012",
                    format!(
                        "{head} '{}' through a {} reference; leaf grants never traverse references",
                        segments.join("."),
                        noun,
                    ),
                    tight_span(text, child),
                ));
            }
        }
    }

    /// Whether a policy `fields=` selector traverses a `user`/`member`
    /// reference: the first traversed reference noun when the whole path
    /// resolves exactly as the types pass accepts it, else `None`.
    ///
    /// Whole-field (single-segment) grants keep their existing meaning
    /// and never report here. Non-contract/event record interiors,
    /// unknown segments, non-terminal delivery descent, arrays, JSON,
    /// secrets, files, actions and every other types-rejected shape
    /// return `None` (`E2013`, or `E4010` for secret leaves, already owns
    /// them). Poisoned (`Error`/`Unknown`) and unavailable-schema
    /// (`Opaque`) bases stay silent, mirroring selector cascade
    /// suppression; money/team/operation value leaves resolve as in
    /// expressions and never report.
    fn selector_traverses_reference(
        &self,
        model: SymbolId,
        segments: &[&str],
    ) -> Option<&'static str> {
        if segments.len() < 2 {
            return None;
        }
        let mut current = if let Some(field) = self.record_field_named(model, segments[0]) {
            self.types.symbol_types.get(&field).cloned()?
        } else {
            // Reserved record metadata heads: policy grants are a read
            // context, mirroring selector navigation. `parent` and
            // unknown heads are the types pass's (`E2013`).
            match segments[0] {
                "created_by" | "updated_by" => ResolvedType::Scalar(Scalar::User),
                "id" => ResolvedType::Scalar(Scalar::Text),
                "version" => ResolvedType::Scalar(Scalar::Int),
                "created" | "updated" => ResolvedType::Scalar(Scalar::Datetime),
                "archived_at" => {
                    ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Datetime)))
                }
                _ => return None,
            }
        };
        let mut traversed: Option<&'static str> = None;
        let rest = &segments[1..];
        for (i, segment) in rest.iter().enumerate() {
            let last = i == rest.len() - 1;
            if let ResolvedType::Nullable(inner) = current {
                current = *inner;
            }
            match current {
                ResolvedType::Error | ResolvedType::Unknown | ResolvedType::Opaque(_) => {
                    return None;
                }
                ResolvedType::Record { symbol, .. } => {
                    if !matches!(
                        self.tables.symbols[symbol.0 as usize].kind,
                        SymbolKind::Contract { .. } | SymbolKind::Event { .. }
                    ) {
                        return None;
                    }
                    let next = self.record_field_named(symbol, segment)?;
                    current = self.types.symbol_types.get(&next).cloned()?;
                }
                ResolvedType::StdDelivery { op, .. }
                    if *segment == "result"
                        || (*segment == "progress"
                            && super::types::delivery_progress_alias(&current)) =>
                {
                    if last {
                        return traversed;
                    }
                    current = super::types::std_delivery_result_type(op);
                }
                ResolvedType::Object(fields) => {
                    current = fields.iter().find(|(name, _)| name == segment)?.1.clone();
                }
                ResolvedType::Delivery { .. } | ResolvedType::StdDelivery { .. } => {
                    if !last || !matches!(*segment, "id" | "status" | "error" | "result") {
                        return None;
                    }
                    return traversed;
                }
                ResolvedType::Scalar(Scalar::User) => {
                    if *segment != "id" {
                        return None;
                    }
                    if traversed.is_none() {
                        traversed = Some("user");
                    }
                    current = ResolvedType::Scalar(Scalar::Text);
                }
                ResolvedType::Scalar(Scalar::Member) => {
                    match *segment {
                        "id" => current = ResolvedType::Scalar(Scalar::Text),
                        "user" => current = ResolvedType::Scalar(Scalar::User),
                        "team" => current = ResolvedType::Team,
                        _ => return None,
                    }
                    if traversed.is_none() {
                        traversed = Some("member");
                    }
                }
                ResolvedType::Scalar(Scalar::Money) => match *segment {
                    "minor" => current = ResolvedType::Scalar(Scalar::Int),
                    "currency" => current = ResolvedType::Scalar(Scalar::Currency),
                    _ => return None,
                },
                ResolvedType::Team => match *segment {
                    "id" => current = ResolvedType::Scalar(Scalar::Text),
                    "timezone" => current = ResolvedType::Scalar(Scalar::Timezone),
                    _ => return None,
                },
                ResolvedType::OperationContext => match *segment {
                    "id" | "source" => current = ResolvedType::Scalar(Scalar::Text),
                    _ => return None,
                },
                _ => return None,
            }
        }
        traversed
    }

    // --- When: crud --------------------------------------------------------

    fn walk_crud(&mut self, _file: SourceId, module: ModuleId, text: &str, node: &SyntaxNode) {
        let parts = significant_children(node);
        let target = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied();
        let model = target.and_then(|t| self.tables.node_symbol.get(&NodeKey::of(t)).copied());
        let Some(model) = model else { return };
        if !matches!(
            self.tables.symbols[model.0 as usize].kind,
            SymbolKind::Model { .. }
        ) {
            return;
        }
        // E4003: canonical CRUD belongs to the model's own package. The
        // resolver indexes only package-local targets, so a foreign target
        // has no `Crud` symbol at all.
        if self.tables.symbols[model.0 as usize].module != module
            && let Some(target) = target
        {
            self.diags.push(Diagnostic::error(
                "E4003",
                format!(
                    "crud targets '{}', which belongs to another package; its canonical crud belongs to that package",
                    self.show(module, model),
                ),
                tight_span(text, target),
            ));
            return;
        }
        let Some(crud) = self.tables.crud_of_model.get(&model).copied() else {
            return;
        };
        if !self.take_record(crud) {
            return;
        }
        let (create, update, delete) = match &self.tables.symbols[crud.0 as usize].kind {
            SymbolKind::Crud {
                create,
                update,
                delete,
                ..
            } => (*create, *update, *delete),
            _ => return,
        };
        let delete_mode =
            match attribute_value(node, "delete", text).and_then(|v| nameref_word(text, v)) {
                Some("remove") => DeleteMode::Remove,
                _ => DeleteMode::Archive,
            };
        let (fields, fields_node) = selector_paths(text, node, "fields");
        let (create_fields, create_fields_node) = selector_paths(text, node, "create_fields");
        let (expose, expose_node) = selector_words(text, node, "expose");
        let (labels, labels_node) = crud_labels(text, node);
        let ops: Vec<SymbolId> = self
            .tables
            .symbols
            .iter()
            .filter_map(|s| match &s.kind {
                SymbolKind::CrudOp { model: m, .. } if *m == model => Some(s.id),
                _ => None,
            })
            .collect();
        let data = CrudData {
            crud,
            model,
            module,
            node: NodeKey::of(node),
            by: attribute_value(node, "by", text).map(NodeKey::of),
            when: attribute_value(node, "when", text).map(NodeKey::of),
            fields: fields.clone(),
            fields_node,
            create_fields: create_fields.clone(),
            create_fields_node,
            create,
            update,
            delete,
            delete_mode,
            expose,
            expose_node,
            labels: labels.clone(),
            labels_node,
            ops: ops.clone(),
        };
        self.out.cruds.insert(crud, data);
        for op in ops {
            let operation = match &self.tables.symbols[op.0 as usize].kind {
                SymbolKind::CrudOp { op, .. } => *op,
                _ => continue,
            };
            if !self.take_record(op) {
                continue;
            }
            let op_fields = match operation {
                CrudOp::Create if !create_fields.is_empty() => create_fields.clone(),
                CrudOp::Create | CrudOp::Update => fields.clone(),
                CrudOp::Delete => Vec::new(),
            };
            let label = labels
                .iter()
                .find(|l| l.op == operation.as_str())
                .map(|l| l.caption);
            self.out.crud_ops.insert(
                op,
                CrudOpData {
                    op,
                    crud_decl: crud,
                    model,
                    module,
                    operation,
                    node: NodeKey::of(node),
                    by: attribute_value(node, "by", text).map(NodeKey::of),
                    when: attribute_value(node, "when", text).map(NodeKey::of),
                    fields: op_fields,
                    delete_mode,
                    label,
                },
            );
        }
    }

    // --- When: scenarios ---------------------------------------------------

    fn walk_scenario(&mut self, _file: SourceId, module: ModuleId, text: &str, node: &SyntaxNode) {
        let Some(id) = self.decl_symbol(module, text, node, &["export", "scenario"]) else {
            return;
        };
        let params = match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::Scenario { params, .. } => params.clone(),
            _ => return,
        };
        if !self.take_record(id) {
            return;
        }
        let on_value = attribute_value(node, "on", text);
        let on = on_value.map(|v| self.decode_on(module, text, v));
        // E4050: a hook on a `crud`-disabled operation has no lifecycle.
        if let (Some(HandlerSource::Hook { model, op }), Some(on_value)) = (&on, on_value)
            && self.crud_disables(*model, *op)
        {
            self.diags.push(Diagnostic::error(
                "E4050",
                format!(
                    "hook on {}.{} is disabled by its crud declaration ({}=none)",
                    self.show(module, *model),
                    op.as_str(),
                    op.as_str(),
                ),
                tight_span(text, on_value),
            ));
        }
        if let (Some(HandlerSource::Every { .. }), Some(on_value)) = (&on, on_value) {
            self.every_handlers.push((id, tight_span(text, on_value)));
        }
        let cohort = self.check_each(module, text, node, on.as_ref());
        let prev_hook = self.current_hook;
        let prev_scenario = self.current_scenario.replace(id);
        if let Some(HandlerSource::Hook { model, op }) = &on {
            self.current_hook = Some((*model, *op));
        }
        let mut guards = Vec::new();
        let mut effects = Vec::new();
        for child in significant_children(node) {
            match child.kind {
                SyntaxKind::Require => {
                    if let Some(effect) = self.walk_effect(module, text, child) {
                        guards.push(effect);
                    }
                }
                SyntaxKind::DoBlock => {
                    effects = self.walk_stmt_list(module, text, &significant_children(child));
                }
                _ => {}
            }
        }
        for child in significant_children(node) {
            if matches!(child.kind, SyntaxKind::Require | SyntaxKind::DoBlock) {
                self.record_data_dependencies(id, text, child);
            }
        }
        let (expose_words, _) = selector_words(text, node, "expose");
        let signature = self.signature_params(text, id, &params, node);
        self.out.scenarios.insert(
            id,
            ScenarioData {
                scenario: id,
                module,
                node: NodeKey::of(node),
                by: attribute_value(node, "by", text).map(NodeKey::of),
                on,
                on_node: on_value.map(NodeKey::of),
                read: attribute_value(node, "read", text).is_some(),
                scope_authority: attribute_value(node, "scope", text).is_some(),
                expose_none: matches!(expose_words.as_slice(), [word] if word.as_str() == "none"),
                label: attribute_value(node, "label", text).map(NodeKey::of),
                params: signature,
                result: result_annotation(text, node).map(NodeKey::of),
                guards,
                effects,
                cohort,
            },
        );
        self.current_hook = prev_hook;
        self.current_scenario = prev_scenario;
    }

    /// T34-F6 `each=` cohort check (`E4055`): validate the fanout cohort
    /// against the adopted contract and return its descriptor.
    ///
    /// Accepted: bare-model (`each=Signup`) and parent-anchored reverse
    /// collection (`each=event.opportunity.Signup`) spellings over
    /// same-package models, on a scenario with a decoded `on=` trigger.
    /// Anything else reports one precise `E4055` and yields `None`
    /// (fail-closed: codegen emits no descriptor, never silently admits).
    /// Positions an earlier pass already diagnosed (undecoded `on=`,
    /// poisoned or untyped hops) stay silent (fix-and-reveal).
    ///
    /// Scope notes: the enumerated/child model must be same-package (the
    /// `E4001` ownership rule: children write their records, and other
    /// packages mutate only through `call`); the anchored parent path may
    /// traverse imported payload shapes (reads, not writes). App/team
    /// scope mixing is NOT rejected here — no adopted rule pins it as
    /// cross-owner, so an unservable mix stays the membership producer's
    /// `membership-unavailable` diagnosis (F5), never a checker invention.
    fn check_each(
        &mut self,
        module: ModuleId,
        text: &str,
        node: &SyntaxNode,
        on: Option<&HandlerSource>,
    ) -> Option<CohortData> {
        let value = attribute_value(node, "each", text)?;
        if value.kind != SyntaxKind::Path {
            return None;
        }
        let span = tight_span(text, value);
        let segments = path_segments(value, text);
        let bind = each_binding(node, text);
        // `each=` needs a trigger: the frozen cohort hangs off an explicit
        // source-occurrence/handler cutoff (§C1). An undecoded `on=` is an
        // earlier pass's finding; stay silent (fix-and-reveal).
        let Some(on) = on else {
            self.diags.push(Diagnostic::error(
                "E4055",
                "each= needs an on= trigger: fanout cohorts freeze under a source-occurrence/handler cutoff"
                    .to_string(),
                span,
            ));
            return None;
        };
        if matches!(on, HandlerSource::Unknown { .. }) {
            return None;
        }
        if segments.len() == 1 {
            if segments[0] == "event" {
                self.diags.push(Diagnostic::error(
                    "E4055",
                    "each=event is not a cohort: use a bare model (each=Signup) or an event-anchored collection (each=event.opportunity.Signup)"
                        .to_string(),
                    span,
                ));
                return None;
            }
            let model = self.cohort_model(module, text, value, segments[0])?;
            return Some(CohortData {
                kind: CohortKind::Model,
                model,
                bind,
                parent_path: Vec::new(),
                node: NodeKey::of(value),
            });
        }
        if segments.first() != Some(&"event") {
            self.diags.push(Diagnostic::error(
                "E4055",
                format!(
                    "unsupported each= cohort `{}`: multi-segment cohorts root at event (each=event.opportunity.Signup)",
                    segments.join("."),
                ),
                span,
            ));
            return None;
        }
        // Parent-anchored reverse collection: `event.<path>.<Child>`. The
        // parent path resolves through the trigger event payload to one
        // pinned parent record; the child model must be contained in it.
        let HandlerSource::Event(event) = on else {
            self.diags.push(Diagnostic::error(
                "E4055",
                "unsupported each= cohort: anchored collections need on=DeclaredEvent carrying the parent record"
                    .to_string(),
                span,
            ));
            return None;
        };
        let last = segments[segments.len() - 1];
        let model = self.cohort_model(module, text, value, last)?;
        let mut current = ResolvedType::Record {
            symbol: *event,
            stored: false,
        };
        for hop in &segments[1..segments.len() - 1] {
            current = self.cohort_hop(module, text, value, &current, hop)?;
        }
        let parent = match &current {
            ResolvedType::Record { symbol, .. } => *symbol,
            ResolvedType::Nullable(_) => {
                self.diags.push(Diagnostic::error(
                    "E4055",
                    format!(
                        "unsupported each= cohort: parent `{}` is nullable, anchored cohorts need one pinned parent record",
                        segments[..segments.len() - 1].join("."),
                    ),
                    span,
                ));
                return None;
            }
            ResolvedType::Array { .. } => {
                self.diags.push(Diagnostic::error(
                    "E4055",
                    format!(
                        "unsupported each= cohort: parent `{}` is a collection, anchored cohorts enumerate one parent's contained collection",
                        segments[..segments.len() - 1].join("."),
                    ),
                    span,
                ));
                return None;
            }
            // Poisoned, opaque, unknown or null parents stand down (an
            // earlier finding owns them); any other concrete shape is
            // unsupported — never silently admitted.
            _ => {
                if matches!(
                    current,
                    ResolvedType::Opaque(_)
                        | ResolvedType::Unknown
                        | ResolvedType::Error
                        | ResolvedType::Null
                ) {
                    return None;
                }
                self.diags.push(Diagnostic::error(
                    "E4055",
                    format!(
                        "unsupported each= cohort: parent `{}` is not a record",
                        segments[..segments.len() - 1].join("."),
                    ),
                    span,
                ));
                return None;
            }
        };
        match &self.tables.symbols[model.0 as usize].kind {
            SymbolKind::Model {
                owner: ModelOwner::ChildOf(expected),
                ..
            } if *expected == parent => {}
            _ => {
                self.diags.push(Diagnostic::error(
                    "E4055",
                    format!(
                        "unknown collection `{last}` on '{}': anchored each= cohorts enumerate a contained child collection",
                        self.show(module, parent),
                    ),
                    span,
                ));
                return None;
            }
        }
        Some(CohortData {
            kind: CohortKind::AnchoredCollection,
            model,
            bind,
            parent_path: segments[..segments.len() - 1]
                .iter()
                .map(ToString::to_string)
                .collect(),
            node: NodeKey::of(value),
        })
    }

    /// Resolve one cohort model name: a declared same-package model.
    /// Unknown names, non-models and cross-package (cross-owner) models
    /// each report their precise `E4055`; `None` yields nothing further.
    fn cohort_model(
        &mut self,
        module: ModuleId,
        text: &str,
        value: &SyntaxNode,
        name: &str,
    ) -> Option<SymbolId> {
        let span = tight_span(text, value);
        let Some(id) = self.prod_or_imported(module, name) else {
            self.diags.push(Diagnostic::error(
                "E4055",
                format!("unknown model `{name}` in each= cohort"),
                span,
            ));
            return None;
        };
        if !matches!(
            self.tables.symbols[id.0 as usize].kind,
            SymbolKind::Model { .. }
        ) {
            self.diags.push(Diagnostic::error(
                "E4055",
                format!(
                    "unsupported each= cohort `{}`: cohorts enumerate models",
                    self.show(module, id),
                ),
                span,
            ));
            return None;
        }
        if self.tables.symbols[id.0 as usize].module != module {
            self.diags.push(Diagnostic::error(
                "E4055",
                format!(
                    "cross-owner each= cohort '{}': cohorts enumerate same-package models (cross-package mutation uses call)",
                    self.show(module, id),
                ),
                span,
            ));
            return None;
        }
        Some(id)
    }

    /// One anchored-cohort parent hop: `current` must be a singular
    /// record carrying field `hop`. Nullable/array hops and hops through
    /// non-records are unsupported (`E4055`); poisoned, opaque, unknown
    /// or untyped positions stand down silently (an earlier finding owns
    /// them); unknown fields are `E4055`.
    fn cohort_hop(
        &mut self,
        module: ModuleId,
        text: &str,
        value: &SyntaxNode,
        current: &ResolvedType,
        hop: &str,
    ) -> Option<ResolvedType> {
        let span = tight_span(text, value);
        match current {
            ResolvedType::Nullable(_) => {
                self.diags.push(Diagnostic::error(
                    "E4055",
                    format!(
                        "unsupported each= cohort: `{hop}` is nullable, anchored cohorts need one pinned parent record",
                    ),
                    span,
                ));
                None
            }
            ResolvedType::Array { .. } => {
                self.diags.push(Diagnostic::error(
                    "E4055",
                    "unsupported each= cohort: the parent path cannot traverse a collection"
                        .to_string(),
                    span,
                ));
                None
            }
            ResolvedType::Record { symbol, .. } => {
                let Some(field) = self.record_field_named(*symbol, hop) else {
                    self.diags.push(Diagnostic::error(
                        "E4055",
                        format!(
                            "unknown collection `{hop}` on '{}' in each= cohort",
                            self.show(module, *symbol),
                        ),
                        span,
                    ));
                    return None;
                };
                match self.types.symbol_types.get(&field).cloned() {
                    None => None,
                    Some(ty) if ty.is_error() => None,
                    Some(ty) => Some(ty),
                }
            }
            _ => {
                if matches!(
                    current,
                    ResolvedType::Opaque(_)
                        | ResolvedType::Unknown
                        | ResolvedType::Error
                        | ResolvedType::Null
                ) {
                    None
                } else {
                    self.diags.push(Diagnostic::error(
                        "E4055",
                        format!("unsupported each= cohort: `{hop}` is not a record member",),
                        span,
                    ));
                    None
                }
            }
        }
    }

    /// Whether `model` has a `crud` declaration disabling `op`. Models
    /// without a declaration use the default lifecycle (all enabled).
    fn crud_disables(&self, model: SymbolId, op: CrudOp) -> bool {
        let crud = match &self.tables.symbols[model.0 as usize].kind {
            SymbolKind::Model {
                crud: Some(crud), ..
            } => *crud,
            SymbolKind::Model { crud: None, .. } => return false,
            _ => return false,
        };
        match &self.tables.symbols[crud.0 as usize].kind {
            SymbolKind::Crud {
                create,
                update,
                delete,
                ..
            } => match op {
                CrudOp::Create => !create,
                CrudOp::Update => !update,
                CrudOp::Delete => !delete,
            },
            _ => false,
        }
    }

    /// Decode an `on=` handler source (DESIGN §6 table).
    fn decode_on(&self, module: ModuleId, text: &str, on: &SyntaxNode) -> HandlerSource {
        if on.kind == SyntaxKind::Call {
            return self.decode_on_every(text, on);
        }
        if on.kind != SyntaxKind::Path {
            return HandlerSource::Unknown {
                source: slice_trimmed(text, on),
            };
        }
        if let Some(source) = self.types.delivery_progress_handlers.get(&NodeKey::of(on)) {
            return HandlerSource::DeliveryProgressed {
                source: source.clone(),
            };
        }
        let segments = path_segments(on, text);
        match segments.len() {
            1 => {
                if let Some(id) = self.prod_or_imported(module, segments[0]) {
                    if matches!(
                        self.tables.symbols[id.0 as usize].kind,
                        SymbolKind::Event { .. }
                    ) {
                        return HandlerSource::Event(id);
                    }
                } else if self
                    .queues
                    .get(&module)
                    .is_some_and(|names| names.iter().any(|n| n == segments[0]))
                {
                    return HandlerSource::Queue {
                        name: segments[0].to_string(),
                    };
                }
                HandlerSource::Unknown {
                    source: segments.join("."),
                }
            }
            2 => self.decode_on_two(module, &segments),
            3 => {
                if segments[2] != "completed" {
                    return HandlerSource::Unknown {
                        source: segments.join("."),
                    };
                }
                let head = self.prod_or_imported(module, segments[0]);
                let (ops, cap) = match head {
                    Some(cap) => match &self.tables.symbols[cap.0 as usize].kind {
                        SymbolKind::Capability { ops, .. } => (ops.clone(), cap),
                        _ => {
                            return HandlerSource::Unknown {
                                source: segments.join("."),
                            };
                        }
                    },
                    None => {
                        return HandlerSource::Unknown {
                            source: segments.join("."),
                        };
                    }
                };
                let op = ops
                    .iter()
                    .copied()
                    .find(|o| self.tables.symbols[o.0 as usize].name == segments[1]);
                match op {
                    Some(op) => HandlerSource::DeliveryCompleted {
                        capability: cap,
                        op,
                    },
                    None => HandlerSource::Unknown {
                        source: segments.join("."),
                    },
                }
            }
            _ => HandlerSource::Unknown {
                source: segments.join("."),
            },
        }
    }

    fn decode_on_every(&self, text: &str, on: &SyntaxNode) -> HandlerSource {
        let parts = significant_children(on);
        let head = parts.iter().find(|n| is_expression(n.kind)).and_then(|n| {
            significant_children(n)
                .iter()
                .find_map(|m| name_text(m, text))
        });
        if head != Some("every") {
            return HandlerSource::Unknown {
                source: slice_trimmed(text, on),
            };
        }
        let arg = parts
            .iter()
            .filter(|n| n.kind == SyntaxKind::Argument)
            .filter_map(|a| {
                significant_children(a)
                    .iter()
                    .find(|n| is_expression(n.kind))
                    .copied()
            })
            .next();
        HandlerSource::Every {
            duration: arg.map(|a| slice_trimmed(text, a)).unwrap_or_default(),
        }
    }

    fn decode_on_two(&self, module: ModuleId, segments: &[&str]) -> HandlerSource {
        if segments == ["teams", "member_removed"] {
            return HandlerSource::TeamsMemberRemoved;
        }
        if segments == ["instrumentation", "error"] {
            return HandlerSource::InstrumentationError;
        }
        if segments[1] == "completed" {
            return match self.prod_or_imported(module, segments[0]) {
                Some(id) => match &self.tables.symbols[id.0 as usize].kind {
                    SymbolKind::Scenario { trusted: false, .. } => {
                        HandlerSource::ScenarioCompleted { scenario: id }
                    }
                    _ => HandlerSource::Unknown {
                        source: segments.join("."),
                    },
                },
                None => HandlerSource::Unknown {
                    source: segments.join("."),
                },
            };
        }
        let Some(head) = self.prod_or_imported(module, segments[0]) else {
            return HandlerSource::Unknown {
                source: segments.join("."),
            };
        };
        match &self.tables.symbols[head.0 as usize].kind {
            SymbolKind::Model { .. } => match segments[1] {
                "create" => HandlerSource::Hook {
                    model: head,
                    op: CrudOp::Create,
                },
                "update" => HandlerSource::Hook {
                    model: head,
                    op: CrudOp::Update,
                },
                "delete" => HandlerSource::Hook {
                    model: head,
                    op: CrudOp::Delete,
                },
                "created" | "updated" | "deleted" => HandlerSource::Committed {
                    model: head,
                    event: segments[1].to_string(),
                },
                _ => HandlerSource::Unknown {
                    source: segments.join("."),
                },
            },
            SymbolKind::Capability { events, .. } => {
                let event = events
                    .iter()
                    .copied()
                    .find(|e| self.tables.symbols[e.0 as usize].name == segments[1]);
                match event {
                    Some(event) => HandlerSource::CapabilityEvent {
                        capability: head,
                        event,
                    },
                    None => HandlerSource::Unknown {
                        source: segments.join("."),
                    },
                }
            }
            _ => HandlerSource::Unknown {
                source: segments.join("."),
            },
        }
    }

    // --- Effects -----------------------------------------------------------

    /// Walk one statement list, flagging statements after an
    /// always-returning one (E4030).
    fn walk_stmt_list(
        &mut self,
        module: ModuleId,
        text: &str,
        stmts: &[&SyntaxNode],
    ) -> Vec<Effect> {
        let mut out = Vec::new();
        let mut dead = false;
        for stmt in stmts {
            if matches!(stmt.kind, SyntaxKind::Name | SyntaxKind::Punct) {
                continue;
            }
            if dead && self.checks_on {
                self.diags.push(Diagnostic::error(
                    "E4030",
                    "unreachable statement after return".to_string(),
                    tight_span(text, stmt),
                ));
            }
            if let Some(effect) = self.walk_effect(module, text, stmt) {
                dead = dead || effect_returns(&effect, self.types);
                out.push(effect);
            }
        }
        out
    }

    /// Walk one guard/effect statement.
    fn walk_effect(&mut self, module: ModuleId, text: &str, node: &SyntaxNode) -> Option<Effect> {
        if has_error(node) {
            return None;
        }
        let mut effect = Effect {
            node: NodeKey::of(node),
            verb: EffectVerb::Let,
            target: None,
            binding: None,
            item: None,
            args: Vec::new(),
            when: None,
            message: None,
            cond: None,
            value: None,
            key: None,
            at: None,
            domain: None,
            limit: None,
            then_effects: Vec::new(),
            else_effects: Vec::new(),
            match_arms: Vec::new(),
        };
        let parts = significant_children(node);
        match node.kind {
            SyntaxKind::Let => {
                effect.verb = EffectVerb::Let;
                effect.binding = parts.iter().find_map(|n| {
                    let word = name_text(n, text)?;
                    (word != "let").then(|| word.to_string())
                });
                effect.value = parts
                    .iter()
                    .find(|n| is_expression(n.kind))
                    .copied()
                    .map(NodeKey::of);
            }
            SyntaxKind::Require => {
                effect.verb = EffectVerb::Require;
                effect.cond = parts
                    .iter()
                    .find(|n| is_expression(n.kind))
                    .copied()
                    .map(NodeKey::of);
                effect.message = attribute_value(node, "message", text).map(NodeKey::of);
            }
            SyntaxKind::Create => {
                effect.verb = EffectVerb::Create;
                let path = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied();
                let model =
                    path.and_then(|p| self.tables.node_symbol.get(&NodeKey::of(p)).copied());
                if let Some(model) = model
                    && matches!(
                        self.tables.symbols[model.0 as usize].kind,
                        SymbolKind::Model { .. }
                    )
                {
                    effect.target = Some(EffectTarget::Model(model));
                    if self.checks_on {
                        self.check_own_mutation(module, text, node, path, model, "create");
                        self.check_hook_staging_create(module, text, node, model);
                    }
                }
                effect.args = effect_args(text, node);
                effect.binding = as_binding(text, node);
            }
            SyntaxKind::Set | SyntaxKind::Transition => {
                effect.verb = if node.kind == SyntaxKind::Transition {
                    EffectVerb::Transition
                } else {
                    EffectVerb::Set
                };
                let path = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied();
                effect.target = path.and_then(|p| self.record_target(module, text, p));
                if self.checks_on
                    && let Some(EffectTarget::Record { model: Some(model) }) = &effect.target
                {
                    self.check_own_mutation(module, text, node, path, *model, "set");
                }
                if self.checks_on {
                    let target = effect.target.clone();
                    self.check_hook_staging_set(module, text, node, &target);
                }
                effect.args = effect_args(text, node);
            }
            SyntaxKind::Delete => {
                effect.verb = EffectVerb::Delete;
                let path = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied();
                effect.target = path.and_then(|p| self.record_target(module, text, p));
                if self.checks_on
                    && let Some(EffectTarget::Record { model: Some(model) }) = &effect.target
                {
                    self.check_own_mutation(module, text, node, path, *model, "delete");
                    if self.crud_disables(*model, CrudOp::Delete) {
                        self.diags.push(Diagnostic::error(
                            "E4042",
                            format!(
                                "delete is disabled for '{}' (delete=none)",
                                self.show(module, *model),
                            ),
                            tight_span(text, path.unwrap_or(node)),
                        ));
                    }
                }
                if self.checks_on {
                    let target = effect.target.clone();
                    self.check_hook_staging_delete(module, text, node, &target);
                }
            }
            SyntaxKind::Call => {
                effect.verb = EffectVerb::Call;
                let target = parts.iter().find(|n| is_expression(n.kind)).copied();
                effect.target = target.and_then(|t| self.operation_target(module, text, t));
                if self.checks_on
                    && let Some(target) = target
                    && let Some(op) = operation_id(self.types, target)
                {
                    self.check_call_local(module, text, target, op);
                }
                if let (Some(target), Some(caller)) = (target, self.current_scenario) {
                    for callee in callee_ids(self.types, target) {
                        push_unique(self.callable_calls.entry(caller).or_default(), callee);
                    }
                }
                if self.checks_on
                    && let Some(target) = target
                {
                    self.check_action_call(module, text, node, target);
                }
                effect.args = effect_args(text, node);
                if let (Some(EffectTarget::Operation(callee)), Some(caller)) =
                    (&effect.target, self.current_scenario)
                {
                    let supplied = effect.args.iter().map(|arg| arg.key.clone()).collect();
                    match self.tables.symbols[callee.0 as usize].kind {
                        SymbolKind::Scenario { .. } => self
                            .callable_scenario_inputs
                            .entry(caller)
                            .or_default()
                            .push((*callee, supplied)),
                        SymbolKind::CrudOp {
                            model,
                            op: CrudOp::Create,
                        } => self
                            .callable_creates
                            .entry(caller)
                            .or_default()
                            .push((model, supplied)),
                        _ => {}
                    }
                }
                effect.binding = as_binding(text, node);
            }
            SyntaxKind::Emit => {
                effect.verb = EffectVerb::Emit;
                let path = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied();
                let event =
                    path.and_then(|p| self.tables.node_symbol.get(&NodeKey::of(p)).copied());
                if let Some(event) = event
                    && matches!(
                        self.tables.symbols[event.0 as usize].kind,
                        SymbolKind::Event { .. }
                    )
                {
                    effect.target = Some(EffectTarget::Event(event));
                }
                effect.args = effect_args(text, node);
            }
            SyntaxKind::Send => {
                effect.verb = EffectVerb::Send;
                let target = parts.iter().find(|n| is_expression(n.kind)).copied();
                effect.target = target.and_then(|t| self.operation_target(module, text, t));
                effect.when = bare_keyword_value(node, "when", text).map(NodeKey::of);
                effect.args = effect_args(text, node);
                effect.binding = as_binding(text, node);
            }
            SyntaxKind::Schedule => {
                effect.verb = EffectVerb::Schedule;
                effect.key = parts
                    .iter()
                    .find(|n| is_expression(n.kind))
                    .copied()
                    .map(NodeKey::of);
                effect.at = bare_keyword_value(node, "at", text).map(NodeKey::of);
                let mut event_path = None;
                for (i, part) in parts.iter().enumerate() {
                    if is_name(part, text, "event") {
                        event_path = parts.get(i + 2).copied();
                    }
                }
                let event =
                    event_path.and_then(|p| self.tables.node_symbol.get(&NodeKey::of(p)).copied());
                if let Some(event) = event
                    && matches!(
                        self.tables.symbols[event.0 as usize].kind,
                        SymbolKind::Event { .. }
                    )
                {
                    effect.target = Some(EffectTarget::Event(event));
                }
                effect.args = effect_args(text, node);
                if self.checks_on {
                    self.check_hook_staging_timer(module, text, node);
                }
            }
            SyntaxKind::Cancel => {
                effect.verb = EffectVerb::Cancel;
                effect.value = parts
                    .iter()
                    .find(|n| is_expression(n.kind))
                    .copied()
                    .map(NodeKey::of);
                if self.checks_on {
                    self.check_hook_staging_timer(module, text, node);
                }
            }
            SyntaxKind::Return => {
                effect.verb = EffectVerb::Return;
                let value = parts.iter().find(|n| is_expression(n.kind)).copied();
                effect.value = value.map(NodeKey::of);
                if self.checks_on
                    && let Some(value) = value
                {
                    self.check_secret_return(text, value);
                }
            }
            SyntaxKind::If => {
                effect.verb = EffectVerb::If;
                let mut else_at = None;
                for (i, part) in parts.iter().enumerate() {
                    if is_name(part, text, "else") {
                        else_at = Some(i);
                    }
                }
                let cond = parts.iter().find(|n| is_expression(n.kind)).copied();
                effect.cond = cond.map(NodeKey::of);
                let mut then_parts = Vec::new();
                let mut else_parts = Vec::new();
                for (i, part) in parts.iter().enumerate() {
                    if part.kind == SyntaxKind::Name || cond.is_some_and(|c| std::ptr::eq(*part, c))
                    {
                        continue;
                    }
                    if else_at.is_some_and(|at| i > at) {
                        else_parts.push(*part);
                    } else {
                        then_parts.push(*part);
                    }
                }
                effect.then_effects = self.walk_stmt_list(module, text, &then_parts);
                effect.else_effects = self.walk_stmt_list(module, text, &else_parts);
            }
            SyntaxKind::Match => {
                effect.verb = EffectVerb::Match;
                effect.value = parts
                    .iter()
                    .find(|n| is_expression(n.kind))
                    .copied()
                    .map(NodeKey::of);
                for arm in parts.iter().filter(|n| n.kind == SyntaxKind::MatchArm) {
                    let statements: Vec<_> = significant_children(arm)
                        .into_iter()
                        .filter(|n| !matches!(n.kind, SyntaxKind::Name | SyntaxKind::Punct))
                        .collect();
                    let node = NodeKey::of(arm);
                    let case = self.types.enum_match_cases.get(&node).cloned();
                    let effects = self.walk_stmt_list(module, text, &statements);
                    effect.match_arms.push(EffectMatchArm {
                        node,
                        case,
                        effects,
                    });
                }
            }
            SyntaxKind::For => {
                effect.verb = EffectVerb::For;
                let mut limit_at = None;
                for (i, part) in parts.iter().enumerate() {
                    if is_name(part, text, "for")
                        && let Some(name) = parts.get(i + 1).and_then(|n| name_text(n, text))
                    {
                        effect.item = Some(name.to_string());
                    }
                    if is_name(part, text, "limit") {
                        limit_at = Some(i);
                    }
                }
                let mut domain = None;
                let mut limit = None;
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
                        if domain.is_none() {
                            domain = Some(*part);
                        } else {
                            limit = Some(*part);
                        }
                        header_end = i;
                    }
                }
                effect.domain = domain.map(NodeKey::of);
                effect.limit = limit.map(NodeKey::of);
                let body: Vec<&SyntaxNode> = parts.iter().skip(header_end + 1).copied().collect();
                effect.then_effects = self.walk_stmt_list(module, text, &body);
            }
            _ => return None,
        }
        Some(effect)
    }

    /// Resolve a `set`/`delete` path target: the pending hook record or a
    /// typed stored record.
    fn record_target(
        &self,
        _module: ModuleId,
        text: &str,
        target: &SyntaxNode,
    ) -> Option<EffectTarget> {
        let segments = path_segments(target, text);
        if segments.first() == Some(&"event") {
            if segments == ["event", "after"]
                && let Some((model, _)) = self.current_hook
            {
                return Some(EffectTarget::PendingRecord { model });
            }
            return Some(EffectTarget::Record { model: None });
        }
        Some(EffectTarget::Record {
            model: self.path_record_model(target, &segments),
        })
    }

    /// Model of a `set`/`delete` path: typed member paths record their
    /// type directly; bare paths resolve through their scope head (the
    /// types pass types paths on the fly without recording them).
    fn path_record_model(&self, target: &SyntaxNode, segments: &[&str]) -> Option<SymbolId> {
        if let Some(ty) = self.types.node_types.get(&NodeKey::of(target)) {
            return match ty {
                ResolvedType::Record { symbol, .. }
                    if matches!(
                        self.tables.symbols[symbol.0 as usize].kind,
                        SymbolKind::Model { .. }
                    ) =>
                {
                    Some(*symbol)
                }
                _ => None,
            };
        }
        if segments.len() != 1 {
            return None;
        }
        let scope = self.tables.expr_scope.get(&NodeKey::of(target)).copied()?;
        let binding = self.tables.resolve_name(scope, segments[0], self.catalog)?;
        let ty = match &binding {
            Binding::CohortChild { model, .. } => return Some(*model),
            Binding::Symbol(id) => {
                if matches!(
                    self.tables.symbols[id.0 as usize].kind,
                    SymbolKind::Model { .. }
                ) {
                    return Some(*id);
                }
                self.types.symbol_types.get(id).cloned()?
            }
            Binding::Let { node } => self.types.node_types.get(node).cloned()?,
            _ => return None,
        };
        match ty {
            ResolvedType::Record { symbol, .. }
                if matches!(
                    self.tables.symbols[symbol.0 as usize].kind,
                    SymbolKind::Model { .. }
                ) =>
            {
                Some(symbol)
            }
            _ => None,
        }
    }

    /// Resolve a `call`/`send` target expression: an operation, an action
    /// value, or a context-declared queue/analytics sink.
    fn operation_target(
        &self,
        module: ModuleId,
        text: &str,
        target: &SyntaxNode,
    ) -> Option<EffectTarget> {
        match self.types.node_types.get(&NodeKey::of(target)) {
            Some(ResolvedType::Operation(id)) => return Some(EffectTarget::Operation(*id)),
            Some(ResolvedType::Action { targets, .. }) => {
                return Some(EffectTarget::Action(targets.clone()));
            }
            Some(ResolvedType::Invocation { targets }) => {
                return Some(EffectTarget::Invocation(targets.clone()));
            }
            _ => {}
        }
        // Context-declared sinks are not symbols; match `Name.member`
        // against the module's queue/analytics names.
        if target.kind == SyntaxKind::Member {
            let parts = significant_children(target);
            let base = parts.iter().find(|n| is_expression(n.kind)).copied();
            let member = parts.iter().rev().find_map(|n| name_text(n, text));
            if let (Some(base), Some(member)) = (base, member)
                && base.kind == SyntaxKind::NameRef
            {
                let head = significant_children(base)
                    .iter()
                    .find_map(|n| name_text(n, text))
                    .unwrap_or("");
                if self
                    .queues
                    .get(&module)
                    .is_some_and(|names| names.iter().any(|n| n == head))
                {
                    return Some(EffectTarget::Queue {
                        queue: head.to_string(),
                        op: member.to_string(),
                    });
                }
                if self
                    .analytics
                    .get(&module)
                    .is_some_and(|names| names.iter().any(|n| n == head))
                {
                    return Some(EffectTarget::Analytics {
                        sink: head.to_string(),
                        op: member.to_string(),
                    });
                }
            }
        }
        None
    }

    /// E4001: `create`/`set`/`delete` of another package's model.
    fn check_own_mutation(
        &mut self,
        module: ModuleId,
        text: &str,
        node: &SyntaxNode,
        path: Option<&SyntaxNode>,
        model: SymbolId,
        verb: &str,
    ) {
        if self.tables.symbols[model.0 as usize].module == module {
            return;
        }
        self.diags.push(Diagnostic::error(
            "E4001",
            format!(
                "{verb} targets '{}', which belongs to another package; cross-package mutation uses call",
                self.show(module, model),
            ),
            tight_span(text, path.unwrap_or(node)),
        ));
    }

    /// Whether `span` already carries a finding: an earlier pass's
    /// diagnostic inside this statement, or an own-pass finding on it.
    /// The staging bans stand down then, so each statement reports once
    /// and deeper findings surface fix-and-reveal after the blocker clears.
    fn prior_finding_inside(&self, span: Span) -> bool {
        self.diags.iter().any(|d| {
            d.primary.file == span.file
                && d.primary.start >= span.start
                && d.primary.end <= span.end
        })
    }

    /// E4054/E4052: a `create` inside a hook. Delete hooks ban every
    /// target (E4054); create/update hooks ban their own trigger model
    /// (E4052, the NARROW bar: op-agnostic, matching the engine).
    fn check_hook_staging_create(
        &mut self,
        module: ModuleId,
        text: &str,
        node: &SyntaxNode,
        model: SymbolId,
    ) {
        let Some((trigger, op)) = self.current_hook else {
            return;
        };
        let span = tight_span(text, node);
        if self.prior_finding_inside(span) {
            return;
        }
        if op == CrudOp::Delete {
            self.diags.push(Diagnostic::error(
                "E4054",
                format!(
                    "hook on {}.{} runs on a delete and cannot stage secondary writes; only create/update hooks stage",
                    self.show(module, trigger),
                    op.as_str(),
                ),
                span,
            ));
            return;
        }
        if model != trigger {
            return;
        }
        self.diags.push(Diagnostic::error(
            "E4052",
            format!(
                "hook on {}.{} cannot stage create of its own model '{}'; same-model writes are barred (triggering-path recursion)",
                self.show(module, trigger),
                op.as_str(),
                self.show(module, model),
            ),
            span,
        ));
    }

    /// E4054/E4052: a `set` inside a hook. The pending-record adjustment
    /// (`set event.after`) is always legal here — the types pass owns its
    /// delete-hook message — and untyped targets already reported upstream.
    fn check_hook_staging_set(
        &mut self,
        module: ModuleId,
        text: &str,
        node: &SyntaxNode,
        target: &Option<EffectTarget>,
    ) {
        let Some((trigger, op)) = self.current_hook else {
            return;
        };
        let Some(EffectTarget::Record { model: Some(model) }) = target else {
            return;
        };
        let span = tight_span(text, node);
        if self.prior_finding_inside(span) {
            return;
        }
        if op == CrudOp::Delete {
            self.diags.push(Diagnostic::error(
                "E4054",
                format!(
                    "hook on {}.{} runs on a delete and cannot stage secondary writes; only create/update hooks stage",
                    self.show(module, trigger),
                    op.as_str(),
                ),
                span,
            ));
            return;
        }
        if *model != trigger {
            return;
        }
        self.diags.push(Diagnostic::error(
            "E4052",
            format!(
                "hook on {}.{} cannot stage set of its own model '{}'; same-model writes are barred (triggering-path recursion)",
                self.show(module, trigger),
                op.as_str(),
                self.show(module, *model),
            ),
            span,
        ));
    }

    /// E4053: a `delete` inside a hook (any op). Pending and untyped
    /// targets keep their types-pass messages (`E3009`/`E3001`); only a
    /// typed stored row bans here.
    fn check_hook_staging_delete(
        &mut self,
        module: ModuleId,
        text: &str,
        node: &SyntaxNode,
        target: &Option<EffectTarget>,
    ) {
        let Some((trigger, op)) = self.current_hook else {
            return;
        };
        let Some(EffectTarget::Record { model: Some(_) }) = target else {
            return;
        };
        let span = tight_span(text, node);
        if self.prior_finding_inside(span) {
            return;
        }
        self.diags.push(Diagnostic::error(
            "E4053",
            format!(
                "hook on {}.{} cannot delete; hooks stage create/set only (staged deletes are barred)",
                self.show(module, trigger),
                op.as_str(),
            ),
            span,
        ));
    }

    /// E4054: a `schedule`/`cancel` inside a delete hook. Create/update
    /// hooks stage timers freely; only the delete op bans here.
    fn check_hook_staging_timer(&mut self, module: ModuleId, text: &str, node: &SyntaxNode) {
        let Some((trigger, op)) = self.current_hook else {
            return;
        };
        if op != CrudOp::Delete {
            return;
        }
        let span = tight_span(text, node);
        if self.prior_finding_inside(span) {
            return;
        }
        self.diags.push(Diagnostic::error(
            "E4054",
            format!(
                "hook on {}.{} runs on a delete and cannot stage timers; only create/update hooks stage",
                self.show(module, trigger),
                op.as_str(),
            ),
            span,
        ));
    }

    /// E4040: `call` to a bound-imported (remote) operation.
    fn check_call_local(
        &mut self,
        module: ModuleId,
        text: &str,
        target: &SyntaxNode,
        op: SymbolId,
    ) {
        let kind = &self.tables.symbols[op.0 as usize].kind;
        if !matches!(
            kind,
            SymbolKind::Scenario { .. } | SymbolKind::CapabilityOp { .. }
        ) {
            return;
        }
        if self.tables.symbols[op.0 as usize].module == module {
            return;
        }
        if !self.is_bound_import(module, op) {
            return;
        }
        self.diags.push(Diagnostic::error(
            "E4040",
            format!(
                "call to bound remote operation '{}' stays in no owner transaction; use send for remote targets",
                self.show(module, op),
            ),
            tight_span(text, target),
        ));
    }

    /// E4041: a `call` on an action value whose explicit value fits
    /// the first target but not another sharing the input name. The
    /// types pass owns the first target (`E3001`); remaining targets
    /// are checked here.
    fn check_action_call(
        &mut self,
        module: ModuleId,
        text: &str,
        node: &SyntaxNode,
        target: &SyntaxNode,
    ) {
        let Some(ResolvedType::Action { targets, .. }) =
            self.types.node_types.get(&NodeKey::of(target)).cloned()
        else {
            return;
        };
        if targets.len() < 2 {
            return;
        }
        let object = significant_children(node)
            .iter()
            .find(|n| n.kind == SyntaxKind::Object)
            .copied();
        let Some(object) = object else { return };
        for (key, _key_node, value) in object_entries(object, text) {
            let Some(value) = value else { continue };
            let mut expected: Vec<(SymbolId, ResolvedType)> = Vec::new();
            let mut unknown = false;
            for op in targets.iter().skip(1) {
                let params = match &self.tables.symbols[op.0 as usize].kind {
                    SymbolKind::Scenario { params, .. }
                    | SymbolKind::CapabilityOp { params, .. } => params.clone(),
                    _ => {
                        unknown = true;
                        break;
                    }
                };
                let param = params
                    .iter()
                    .copied()
                    .find(|p| self.tables.symbols[p.0 as usize].name == key);
                let Some(param) = param else {
                    // The types pass reports keys missing on some target.
                    unknown = true;
                    break;
                };
                let Some(ty) = self.types.symbol_types.get(&param).cloned() else {
                    unknown = true;
                    break;
                };
                expected.push((*op, ty));
            }
            if unknown {
                continue;
            }
            let Some(actual) = self.types.node_types.get(&NodeKey::of(value)).cloned() else {
                continue;
            };
            if matches!(
                actual,
                ResolvedType::Error | ResolvedType::Unknown | ResolvedType::Opaque(_)
            ) {
                continue;
            }
            for (op, want) in &expected {
                if !fits_type(&actual, want) {
                    self.diags.push(Diagnostic::error(
                        "E4041",
                        format!(
                            "'{key}': expected {}, found {} for action target '{}'",
                            want.display(self.tables, module),
                            actual.display(self.tables, module),
                            self.show(module, *op),
                        ),
                        tight_span(text, value),
                    ));
                    break;
                }
            }
        }
    }

    /// E4011: a `return` value of `secret` type.
    fn check_secret_return(&mut self, text: &str, value: &SyntaxNode) {
        let ty = self.types.node_types.get(&NodeKey::of(value));
        let is_secret = match ty {
            Some(ResolvedType::Scalar(Scalar::Secret)) => true,
            Some(ResolvedType::Nullable(inner)) => {
                matches!(inner.as_ref(), ResolvedType::Scalar(Scalar::Secret))
            }
            _ => false,
        };
        if is_secret {
            self.diags.push(Diagnostic::error(
                "E4011",
                "return value has secret type; secrets are server-only and never returned"
                    .to_string(),
                tight_span(text, value),
            ));
        }
    }

    // --- Then: pages -------------------------------------------------------

    fn walk_page(&mut self, module: ModuleId, text: &str, node: &SyntaxNode) {
        let page = PageData {
            node: NodeKey::of(node),
            route: significant_children(node)
                .iter()
                .find(|n| n.kind == SyntaxKind::Route)
                .copied()
                .map(NodeKey::of),
            title: attribute_value(node, "title", text).map(NodeKey::of),
            data: attribute_value(node, "data", text).map(NodeKey::of),
        };
        if let Some(data) = self.out.modules.get_mut(&module) {
            data.pages.push(page);
        }
        // A5/S4: E4012 also visits UI table selector lists.
        if self.checks_on {
            self.walk_ui_leaf_grants(text, node);
        }
    }

    /// Recurse a page subtree for `Collection` widgets, running the
    /// E4012 reference check over their `columns=`/`search=`/`filter=`
    /// lists against the domain model (A5/S4 parity with policy
    /// `fields=`). Skips `Examples` subtrees like every other walk.
    fn walk_ui_leaf_grants(&mut self, text: &str, node: &SyntaxNode) {
        for child in significant_children(node) {
            if child.kind == SyntaxKind::Examples {
                continue;
            }
            if child.kind == SyntaxKind::Collection {
                self.check_collection_leaf_grants(text, child);
            }
            self.walk_ui_leaf_grants(text, child);
        }
    }

    /// E4012 over one collection widget's selector lists, mirroring
    /// the types pass `columns=`/`search=`/`filter=` loop. The domain
    /// model mirrors `walk_ui_page` + `model_of_type`: the first
    /// expression child's recorded type, unwrapping arrays to the
    /// model record. Unresolvable domains stay silent (the types
    /// pass owns those diagnostics).
    fn check_collection_leaf_grants(&mut self, text: &str, node: &SyntaxNode) {
        let domain = significant_children(node)
            .iter()
            .find(|n| is_expression(n.kind))
            .copied();
        let Some(domain) = domain else {
            return;
        };
        let Some(model) = self.collection_domain_model(domain) else {
            return;
        };
        let head_word = significant_children(node)
            .iter()
            .find_map(|n| name_text(n, text))
            .unwrap_or("table");
        for attr in ["columns", "search", "filter"] {
            if attribute_value(node, attr, text).is_some() {
                let head = format!("{head_word} `{attr}=` lists leaf");
                self.check_leaf_grant_reference_in(text, model, node, attr, &head);
            }
        }
    }

    /// Domain model of a collection widget from the types pass node
    /// types, mirroring `model_of_type`.
    fn collection_domain_model(&self, domain: &SyntaxNode) -> Option<SymbolId> {
        self.model_of_record(self.types.node_types.get(&NodeKey::of(domain))?)
    }

    /// Model behind a domain type: the model record itself,
    /// unwrapping arrays (query domains) to the element.
    fn model_of_record(&self, ty: &ResolvedType) -> Option<SymbolId> {
        match ty {
            ResolvedType::Record { symbol, .. } => matches!(
                self.tables.symbols[symbol.0 as usize].kind,
                SymbolKind::Model { .. }
            )
            .then_some(*symbol),
            ResolvedType::Array { element, .. } => self.model_of_record(element),
            _ => None,
        }
    }

    // --- Migrations --------------------------------------------------------

    fn walk_migration(&mut self, _file: SourceId, text: &str, node: &SyntaxNode) {
        if has_error(node) {
            return;
        }
        let parts = significant_children(node);
        let mut names = parts.iter().filter_map(|n| name_text(n, text));
        let _head = names.next();
        let owner = names.next().unwrap_or("").to_string();
        let module = self.tables.module_by_name.get(&owner).copied();
        let from_node = attribute_value(node, "from", text);
        let mut data = MigrationData {
            node: NodeKey::of(node),
            owner,
            module,
            from: from_node.and_then(|v| literal_string(text, v)),
            from_node: from_node.map(NodeKey::of),
            directives: Vec::new(),
            descriptions: Vec::new(),
        };
        let prev_checks = self.checks_on;
        // NOTE (E4030/W1001 boundary): checks stay off for migration
        // bodies, so after-`return` in a backfill is diagnosed nowhere
        // (E4030 off here, W1001 stands down after `return`
        // everywhere). Pre-existing; narrowing it is follow-up work.
        self.checks_on = false;
        for child in parts {
            match child.kind {
                SyntaxKind::Rename | SyntaxKind::Drop => {
                    data.directives.push(migration_move(text, child));
                }
                SyntaxKind::Invalidate => {
                    let handler = significant_children(child)
                        .iter()
                        .find(|n| n.kind == SyntaxKind::Path)
                        .map(|p| path_segments(p, text).join("."))
                        .unwrap_or_default();
                    data.directives.push(MigrationDirective::Invalidate {
                        node: NodeKey::of(child),
                        handler,
                    });
                }
                SyntaxKind::Backfill => {
                    data.directives
                        .push(self.migration_backfill(text, module, child));
                }
                _ => {}
            }
        }
        self.checks_on = prev_checks;
        let index = self.out.migrations.len();
        if let Some(module) = module
            && let Some(modules) = self.out.modules.get_mut(&module)
        {
            modules.migrations.push(index);
        }
        self.out.migrations.push(data);
    }

    fn migration_backfill(
        &mut self,
        text: &str,
        module: Option<ModuleId>,
        node: &SyntaxNode,
    ) -> MigrationDirective {
        let parts = significant_children(node);
        let path = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied();
        let model = path
            .map(|p| path_segments(p, text).join("."))
            .unwrap_or_default();
        let resolved = match (module, path) {
            (Some(module), Some(path)) => {
                let segments = path_segments(path, text);
                if segments.len() == 1 {
                    self.prod_or_imported(module, segments[0]).filter(|id| {
                        matches!(
                            self.tables.symbols[id.0 as usize].kind,
                            SymbolKind::Model { .. }
                        )
                    })
                } else {
                    None
                }
            }
            _ => None,
        };
        let mut guards = Vec::new();
        let mut effects = Vec::new();
        // Checks stay off: migration semantics belong to a later pass.
        let module = module.unwrap_or(ModuleId(u32::MAX));
        for child in parts {
            match child.kind {
                SyntaxKind::Require => {
                    if let Some(effect) = self.walk_effect(module, text, child) {
                        guards.push(effect);
                    }
                }
                SyntaxKind::DoBlock => {
                    effects = self.walk_stmt_list(module, text, &significant_children(child));
                }
                _ => {}
            }
        }
        MigrationDirective::Backfill {
            node: NodeKey::of(node),
            model,
            resolved,
            guards,
            effects,
        }
    }

    // --- Whole-tree passes: builtins, role gates, descriptions -------------

    /// Walk every tree once for position-independent facts: referenced
    /// builtins (G13), redundant `Role(actor)` subjects (E4020) and
    /// description attachment. `Examples` subtrees belong to the examples
    /// pass; error subtrees were already diagnosed.
    fn walk_calls_and_descriptions(&mut self, trees: &[(SourceId, SyntaxNode)]) {
        for (file, tree) in trees {
            let text = self.text(*file).to_string();
            let ctx = DescCtx::Orphan;
            self.walk_tree_calls(&text, tree, &ctx);
        }
    }

    fn walk_tree_calls(&mut self, text: &str, node: &SyntaxNode, ctx: &DescCtx) {
        if matches!(
            node.kind,
            SyntaxKind::Examples | SyntaxKind::Error | SyntaxKind::BadToken
        ) || (!matches!(
            node.kind,
            SyntaxKind::File
                | SyntaxKind::App
                | SyntaxKind::Package
                | SyntaxKind::Section
                | SyntaxKind::Context
        ) && has_error(node))
        {
            return;
        }
        // Descriptions attach to the following significant sibling.
        let kids = significant_children(node);
        for (i, child) in kids.iter().enumerate() {
            if child.kind == SyntaxKind::Description
                && let Some(owner) = kids.get(i + 1)
            {
                let entry = description_entry(text, child, owner);
                let entry_ctx = match ctx {
                    DescCtx::Module(_) | DescCtx::Migration(_) => ctx.clone(),
                    DescCtx::Orphan => self.orphan_ctx(text, owner),
                };
                self.descriptions.push((entry_ctx, entry));
            }
        }
        match node.kind {
            SyntaxKind::Call if !is_statement_call(node) => self.check_expression_call(text, node),
            SyntaxKind::App | SyntaxKind::Package => {
                let name = decl_name(text, node, &["app", "package", "export", "migration"]);
                let module = name.and_then(|n| self.tables.module_by_name.get(n).copied());
                let ctx = module.map(DescCtx::Module).unwrap_or(DescCtx::Orphan);
                for child in &node.children {
                    self.walk_tree_calls(text, child, &ctx);
                }
                return;
            }
            SyntaxKind::Migration => {
                let ctx = DescCtx::Migration(NodeKey::of(node));
                for child in &node.children {
                    self.walk_tree_calls(text, child, &ctx);
                }
                return;
            }
            _ => {}
        }
        for child in &node.children {
            self.walk_tree_calls(text, child, ctx);
        }
    }

    /// Attribute a file-level description to its owner's module or
    /// migration.
    fn orphan_ctx(&self, text: &str, owner: &SyntaxNode) -> DescCtx {
        match owner.kind {
            SyntaxKind::Migration => DescCtx::Migration(NodeKey::of(owner)),
            SyntaxKind::App | SyntaxKind::Package => {
                let name = decl_name(text, owner, &["app", "package", "export", "migration"]);
                name.and_then(|n| self.tables.module_by_name.get(n).copied())
                    .map(DescCtx::Module)
                    .unwrap_or(DescCtx::Orphan)
            }
            _ => DescCtx::Orphan,
        }
    }

    /// One expression `Call`: record builtin callees (G13) and flag
    /// redundant `Role(actor)` subjects (E4020).
    fn check_expression_call(&mut self, text: &str, node: &SyntaxNode) {
        let parts = significant_children(node);
        let callee = parts.iter().find(|n| is_expression(n.kind)).copied();
        let Some(callee) = callee else { return };
        let mut target = callee;
        while target.kind == SyntaxKind::Group {
            let Some(inner) = significant_children(target)
                .iter()
                .find(|n| is_expression(n.kind))
                .copied()
            else {
                return;
            };
            target = inner;
        }
        if target.kind != SyntaxKind::NameRef {
            return;
        }
        let binding = self.tables.node_binding.get(&NodeKey::of(target)).cloned();
        match binding {
            Some(Binding::Builtin { id }) => {
                self.builtins.insert(id);
            }
            Some(Binding::Symbol(role))
                if matches!(self.tables.symbols[role.0 as usize].kind, SymbolKind::Role) =>
            {
                self.check_redundant_actor(text, node, role);
            }
            _ => {}
        }
    }

    /// E4020: `Role(actor)` is redundant; the bare role is the canonical
    /// literal-actor spelling.
    fn check_redundant_actor(&mut self, text: &str, node: &SyntaxNode, role: SymbolId) {
        let args: Vec<&SyntaxNode> = significant_children(node)
            .iter()
            .filter(|n| n.kind == SyntaxKind::Argument)
            .copied()
            .collect();
        if args.len() != 1 {
            return;
        }
        let arg_parts = significant_children(args[0]);
        if arg_parts.len() >= 3
            && arg_parts[0].kind == SyntaxKind::Name
            && is_punct(arg_parts[1], text, "=")
        {
            // Named arguments are the types pass's arity error.
            return;
        }
        let value = arg_parts.iter().find(|n| is_expression(n.kind)).copied();
        let Some(value) = value else { return };
        let mut target = value;
        while target.kind == SyntaxKind::Group {
            let Some(inner) = significant_children(target)
                .iter()
                .find(|n| is_expression(n.kind))
                .copied()
            else {
                return;
            };
            target = inner;
        }
        if target.kind != SyntaxKind::NameRef {
            return;
        }
        let name = significant_children(target)
            .iter()
            .find_map(|n| name_text(n, text))
            .unwrap_or("");
        if name != "actor" {
            return;
        }
        let is_actor = matches!(
            self.tables.node_binding.get(&NodeKey::of(target)),
            Some(Binding::Context(ContextVar::Actor(_)))
        );
        if !is_actor {
            return;
        }
        let module = self.tables.symbols[role.0 as usize].module;
        self.diags.push(Diagnostic::error(
            "E4020",
            format!(
                "role predicate '{}' with explicit actor is redundant; use bare '{}'",
                self.show(module, role),
                self.show(module, role),
            ),
            tight_span(text, value),
        ));
    }

    // --- Cross-declaration checks ------------------------------------------

    /// E4004: every `Model in app` needs a same-package policy.
    fn check_app_policies(&mut self) {
        for symbol in &self.tables.symbols {
            let SymbolKind::Model { owner, .. } = &symbol.kind else {
                continue;
            };
            if !matches!(owner, ModelOwner::App) {
                continue;
            }
            let has_policy = self
                .out
                .models
                .get(&symbol.id)
                .is_some_and(|data| data.policies.iter().any(|p| p.module == symbol.module));
            if !has_policy {
                self.diags.push(Diagnostic::error(
                    "E4004",
                    format!(
                        "app-scoped model '{}' requires at least one policy",
                        symbol.name,
                    ),
                    symbol.span,
                ));
            }
        }
    }

    /// Owner-bound reads/writes and derived calls share the same scope closure.
    fn record_data_dependencies(&mut self, id: SymbolId, text: &str, node: &SyntaxNode) {
        collect_selected_calls(
            node,
            self.types,
            self.callable_default_calls.entry(id).or_default(),
        );
        collect_subtree_models(
            self.tables,
            self.types,
            text,
            node,
            self.callable_models.entry(id).or_default(),
            self.callable_calls.entry(id).or_default(),
            self.callable_creates.entry(id).or_default(),
        );
    }

    /// Follow only executed owning initializer anchors after declaration collection.
    fn record_creation_dependencies(&mut self, trees: &[(SourceId, SyntaxNode)]) {
        let mut pending = Vec::new();
        for (caller, calls) in &self.callable_default_calls {
            for call in calls {
                pending.extend(
                    self.selected_defaults(call)
                        .into_iter()
                        .map(|key| (*caller, key)),
                );
            }
        }
        for (caller, calls) in &self.callable_scenario_inputs {
            for (callee, supplied) in calls {
                if let Some(data) = self.out.scenarios.get(callee) {
                    for param in &data.params {
                        let name = &self.tables.symbols[param.param.0 as usize].name;
                        if !supplied.contains(name)
                            && let Some(key) = param.default
                        {
                            pending.push((*caller, key));
                        }
                    }
                }
            }
        }
        for (caller, creates) in &self.callable_creates {
            for (model, supplied) in creates {
                if let Some(data) = self.out.models.get(model) {
                    for field in &data.fields {
                        let name = &self.tables.symbols[field.field.0 as usize].name;
                        if let Some(key) = field.server.or_else(|| {
                            (!supplied.contains(name))
                                .then_some(field.default)
                                .flatten()
                        }) {
                            pending.push((*caller, key));
                        }
                    }
                }
            }
        }
        let mut visited = HashSet::new();
        while let Some((caller, key)) = pending.pop() {
            if !visited.insert((caller, key)) {
                continue;
            }
            let Some(node) = trees
                .iter()
                .find(|(file, _)| *file == key.file)
                .and_then(|(_, tree)| dependency_node(tree, &key))
            else {
                continue;
            };
            let mut nested_creates = Vec::new();
            collect_subtree_models(
                self.tables,
                self.types,
                self.db
                    .get(key.file)
                    .map(|source| source.text.as_str())
                    .unwrap_or(""),
                node,
                self.callable_models.entry(caller).or_default(),
                self.callable_calls.entry(caller).or_default(),
                &mut nested_creates,
            );
            let mut calls = Vec::new();
            collect_selected_calls(node, self.types, &mut calls);
            for call in calls {
                pending.extend(
                    self.selected_defaults(&call)
                        .into_iter()
                        .map(|key| (caller, key)),
                );
            }
        }
    }

    fn selected_defaults(&self, call: &NodeKey) -> Vec<NodeKey> {
        let Some(selected) = self.types.selected_calls.get(call) else {
            return Vec::new();
        };
        let params = match selected.target {
            SelectedCallTarget::DeriveFn(id) => self.out.derives.get(&id).map(|data| &data.params),
            SelectedCallTarget::Message(id) => self.out.messages.get(&id).map(|data| &data.params),
            _ => None,
        };
        params
            .into_iter()
            .flatten()
            .zip(&selected.slots)
            .filter_map(|(param, slot)| slot.is_none().then_some(param.default).flatten())
            .collect()
    }

    /// E4051: an `on=every` handler must not mix app-scoped and team-scoped
    /// data across its owner-bound queries, writes and local calls.
    fn check_every_scopes(&mut self) {
        let handlers = std::mem::take(&mut self.every_handlers);
        for (handler, span) in handlers {
            let mut models: Vec<SymbolId> = Vec::new();
            let mut visited: HashSet<SymbolId> = HashSet::new();
            let mut stack = vec![handler];
            while let Some(current) = stack.pop() {
                if !visited.insert(current) {
                    continue;
                }
                if let Some(direct) = self.callable_models.get(&current) {
                    for model in direct {
                        push_unique(&mut models, *model);
                    }
                }
                if let Some(callees) = self.callable_calls.get(&current).cloned() {
                    for callee in callees {
                        match &self.tables.symbols[callee.0 as usize].kind {
                            SymbolKind::Scenario { .. } | SymbolKind::DeriveFn { .. } => {
                                stack.push(callee)
                            }
                            SymbolKind::CrudOp { model, .. } => push_unique(&mut models, *model),
                            _ => {}
                        }
                    }
                }
            }
            let mut app: Option<SymbolId> = None;
            let mut team: Option<SymbolId> = None;
            for model in &models {
                if self.scope_is_app(*model) {
                    app = app.or(Some(*model));
                } else {
                    team = team.or(Some(*model));
                }
            }
            if let (Some(app), Some(team)) = (app, team) {
                let module = self.tables.symbols[handler.0 as usize].module;
                self.diags.push(Diagnostic::error(
                    "E4051",
                    format!(
                        "recurring handler mixes app-scoped '{}' and team-scoped '{}' data",
                        self.show(module, app),
                        self.show(module, team),
                    ),
                    span,
                ));
            }
        }
    }

    /// Whether a model's scope root is app scope (`in app`); children
    /// inherit their root ancestor's scope. Resolve reports containment
    /// cycles (`E2008`) but leaves the links intact, so the walk carries
    /// a visited set and treats a revisited model as team scope (the
    /// program is already invalid; the scope answer is moot).
    fn scope_is_app(&self, mut model: SymbolId) -> bool {
        let mut seen = HashSet::new();
        seen.insert(model);
        loop {
            match &self.tables.symbols[model.0 as usize].kind {
                SymbolKind::Model {
                    owner: ModelOwner::ChildOf(parent),
                    ..
                } => {
                    if !seen.insert(*parent) {
                        return false;
                    }
                    model = *parent;
                }
                SymbolKind::Model {
                    owner: ModelOwner::App,
                    ..
                } => return true,
                _ => return false,
            }
        }
    }
}

// --- Local CST helpers ---------------------------------------------------
// These mirror the in-crate shared helpers (which are `pub(crate)` and so
// unavailable here by design); the coordinator can switch them over when
// wiring this module into `analysis`.

/// Significant children: skips `Trivia`/`Comment` leaves.
fn significant_children(node: &SyntaxNode) -> Vec<&SyntaxNode> {
    node.children
        .iter()
        .filter(|c| !matches!(c.kind, SyntaxKind::Trivia | SyntaxKind::Comment))
        .collect()
}

/// Text of a `Name` leaf, if `node` is one.
fn name_text<'a>(node: &SyntaxNode, text: &'a str) -> Option<&'a str> {
    if node.kind == SyntaxKind::Name {
        node.token().map(|t| t.text(text))
    } else {
        None
    }
}

/// Whether `node` is a `Name` leaf with spelling `word`.
fn is_name(node: &SyntaxNode, text: &str, word: &str) -> bool {
    name_text(node, text) == Some(word)
}

/// Whether `node` is a `Punct` leaf with spelling `spell`.
fn is_punct(node: &SyntaxNode, text: &str, spell: &str) -> bool {
    node.kind == SyntaxKind::Punct && node.token().is_some_and(|t| t.text(text) == spell)
}

/// Dotted segments of a `Path` node.
fn path_segments<'a>(node: &SyntaxNode, text: &'a str) -> Vec<&'a str> {
    node.children
        .iter()
        .filter(|c| c.kind == SyntaxKind::Name)
        .filter_map(|c| c.token().map(|t| t.text(text)))
        .collect()
}

/// `(key, value)` of an `Attribute` node (`key = value`).
fn attribute_parts(node: &SyntaxNode) -> Option<(&SyntaxNode, &SyntaxNode)> {
    let parts = significant_children(node);
    if parts.len() == 3 && parts[1].kind == SyntaxKind::Punct {
        Some((parts[0], parts[2]))
    } else {
        None
    }
}

/// Attribute value node for `key` among the direct `Attribute` children.
fn attribute_value<'a>(node: &'a SyntaxNode, key: &str, text: &str) -> Option<&'a SyntaxNode> {
    node.children
        .iter()
        .filter(|c| c.kind == SyntaxKind::Attribute)
        .find_map(|attr| {
            let (name, value) = attribute_parts(attr)?;
            if is_name(name, text, key) {
                Some(value)
            } else {
                None
            }
        })
}

/// `as` child binding beside an `each=` attribute (T34-F6): the parser
/// keeps the standard three-child `Attribute` and puts the `as` binding
/// beside it as direct `Scenario` children, mirroring `send`/`create`
/// aliases. Body `as` uses sit inside `DoBlock`/`Require` subtrees, so
/// only direct `Name` children are scanned.
fn each_binding(node: &SyntaxNode, text: &str) -> Option<String> {
    for pair in significant_children(node).windows(2) {
        if is_name(pair[0], text, "as")
            && let Some(name) = name_text(pair[1], text)
        {
            return Some(name.to_string());
        }
    }
    None
}

/// Declaration head name: first `Name` child that is not a head word.
fn decl_name<'a>(text: &'a str, node: &SyntaxNode, heads: &[&str]) -> Option<&'a str> {
    significant_children(node).iter().find_map(|n| {
        let word = name_text(n, text)?;
        (!heads.contains(&word)).then_some(word)
    })
}

/// Tight span of `node`: leading/trailing trivia trimmed.
fn tight_span(text: &str, node: &SyntaxNode) -> Span {
    let raw = text
        .get(node.span.start as usize..node.span.end as usize)
        .unwrap_or("");
    let leading = raw.len() - raw.trim_start().len();
    let trimmed = raw.trim();
    let start = node.span.start + leading as u32;
    Span::new(node.span.file, start, start + trimmed.len() as u32)
}

/// Trimmed source slice of `node`.
fn slice_trimmed(text: &str, node: &SyntaxNode) -> String {
    text.get(node.span.start as usize..node.span.end as usize)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Whether the subtree holds a syntax error marker.
fn has_error(node: &SyntaxNode) -> bool {
    node.descendants()
        .any(|n| matches!(n.kind, SyntaxKind::Error | SyntaxKind::BadToken))
}

/// Whether this CST kind is a value-expression node.
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
            | SyntaxKind::Call
            | SyntaxKind::Unary
            | SyntaxKind::Binary
            | SyntaxKind::Query
            | SyntaxKind::MessageValue
    )
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

/// Whether a `Call` node is a statement-level `call` (it carries its
/// argument object directly; expression calls nest objects in arguments).
fn is_statement_call(node: &SyntaxNode) -> bool {
    node.kind == SyntaxKind::Call && node.children.iter().any(|c| c.kind == SyntaxKind::Object)
}

/// Entries of an `Object` node: `(key, key node, value)`.
fn object_entries<'a>(
    object: &'a SyntaxNode,
    text: &'a str,
) -> Vec<(&'a str, &'a SyntaxNode, Option<&'a SyntaxNode>)> {
    let mut entries = Vec::new();
    for entry in object
        .children
        .iter()
        .filter(|c| c.kind == SyntaxKind::ObjectEntry)
    {
        let parts = significant_children(entry);
        let Some(key_node) = parts
            .first()
            .copied()
            .filter(|n| n.kind == SyntaxKind::Name)
        else {
            continue;
        };
        let Some(key) = name_text(key_node, text) else {
            continue;
        };
        let value = parts.iter().find(|n| is_expression(n.kind)).copied();
        entries.push((key, key_node, value));
    }
    entries
}

/// Effect argument entries of the first `Object` child.
fn effect_args(text: &str, node: &SyntaxNode) -> Vec<EffectArg> {
    let object = significant_children(node)
        .iter()
        .find(|n| n.kind == SyntaxKind::Object)
        .copied();
    let Some(object) = object else {
        return Vec::new();
    };
    object_entries(object, text)
        .into_iter()
        .map(|(key, key_node, value)| EffectArg {
            key: key.to_string(),
            key_node: NodeKey::of(key_node),
            value: value.map(NodeKey::of),
        })
        .collect()
}

/// `as NAME` binding of an effect node.
fn as_binding(text: &str, node: &SyntaxNode) -> Option<String> {
    let parts = significant_children(node);
    for i in 0..parts.len() {
        if is_name(parts[i], text, "as") {
            return parts
                .get(i + 1)
                .and_then(|n| name_text(n, text))
                .map(str::to_string);
        }
    }
    None
}

/// Value of a bare `key = expr` triple among `node`'s parts.
fn bare_keyword_value<'a>(node: &'a SyntaxNode, key: &str, text: &str) -> Option<&'a SyntaxNode> {
    let parts = significant_children(node);
    for (i, part) in parts.iter().enumerate() {
        if is_name(part, text, key) {
            return parts.get(i + 2).copied().filter(|n| is_expression(n.kind));
        }
    }
    None
}

/// Value of a bare `key = value` triple of any value kind.
fn bare_slot_value<'a>(node: &'a SyntaxNode, key: &str, text: &str) -> Option<&'a SyntaxNode> {
    let parts = significant_children(node);
    for (i, part) in parts.iter().enumerate() {
        if is_name(part, text, key) {
            return parts.get(i + 2).copied();
        }
    }
    None
}

/// Word of a `NameRef` node.
fn nameref_word<'a>(text: &'a str, node: &SyntaxNode) -> Option<&'a str> {
    if node.kind != SyntaxKind::NameRef {
        return None;
    }
    significant_children(node)
        .iter()
        .find_map(|n| name_text(n, text))
}

/// `-> type` result annotation following parameters/attributes.
fn result_annotation<'a>(text: &str, node: &'a SyntaxNode) -> Option<&'a SyntaxNode> {
    let parts = significant_children(node);
    for i in 0..parts.len() {
        if is_punct(parts[i], text, "->") {
            return parts.get(i + 1).copied().filter(|n| is_type_node(n.kind));
        }
    }
    None
}

/// Dotted selector paths of a `Selectors` attribute value.
fn selector_paths(text: &str, node: &SyntaxNode, key: &str) -> (Vec<String>, Option<NodeKey>) {
    let value = attribute_value(node, key, text);
    let Some(value) = value else {
        return (Vec::new(), None);
    };
    if value.kind != SyntaxKind::Selectors {
        return (Vec::new(), Some(NodeKey::of(value)));
    }
    let paths = significant_children(value)
        .iter()
        .filter(|n| n.kind == SyntaxKind::Path)
        .map(|p| path_segments(p, text).join("."))
        .collect();
    (paths, Some(NodeKey::of(value)))
}

/// Single-segment words of a `Selectors` attribute value (`expose=`).
fn selector_words(text: &str, node: &SyntaxNode, key: &str) -> (Vec<String>, Option<NodeKey>) {
    let value = attribute_value(node, key, text);
    let Some(value) = value else {
        return (Vec::new(), None);
    };
    if value.kind != SyntaxKind::Selectors {
        return (Vec::new(), Some(NodeKey::of(value)));
    }
    let words = significant_children(value)
        .iter()
        .filter(|n| n.kind == SyntaxKind::Path)
        .filter_map(|p| {
            let segments = path_segments(p, text);
            (segments.len() == 1).then(|| segments[0].to_string())
        })
        .collect();
    (words, Some(NodeKey::of(value)))
}

/// CRUD operation captions paired positionally with their keys.
fn crud_labels(text: &str, node: &SyntaxNode) -> (Vec<CrudLabel>, Option<NodeKey>) {
    let value = attribute_value(node, "label", text);
    let Some(value) = value else {
        return (Vec::new(), None);
    };
    if value.kind != SyntaxKind::CrudLabels {
        return (Vec::new(), Some(NodeKey::of(value)));
    }
    let keys: Vec<&str> = significant_children(value)
        .iter()
        .filter_map(|n| {
            if n.kind == SyntaxKind::Name {
                name_text(n, text)
            } else {
                None
            }
        })
        .collect();
    let captions: Vec<NodeKey> = significant_children(value)
        .into_iter()
        .filter(|n| {
            matches!(
                n.kind,
                SyntaxKind::Literal | SyntaxKind::MessageValue | SyntaxKind::Path
            )
        })
        .map(NodeKey::of)
        .collect();
    let labels = keys
        .into_iter()
        .zip(captions)
        .map(|(op, caption)| CrudLabel {
            op: op.to_string(),
            caption,
        })
        .collect();
    (labels, Some(NodeKey::of(value)))
}

/// Human noun for a rule declaration kind.
fn rule_noun(kind: SyntaxKind) -> &'static str {
    match kind {
        SyntaxKind::Policy => "policy",
        SyntaxKind::Invariant => "invariant",
        SyntaxKind::Unique => "unique",
        SyntaxKind::Lock => "lock",
        SyntaxKind::Retain => "retain",
        _ => "rule",
    }
}

/// Checked description for one field/parameter declaration, if any
/// spelling is authored: inline `desc=` (a literal, a descriptor with
/// variants, or a static message path), the legacy `@{desc}`
/// annotation, or the attached `#` set preceding the declaration.
/// Message references resolve to wording here; anything earlier passes
/// rejected (unresolved, non-message, or parameterized) yields no entry
/// — best-effort, since diagnostics already fired. `owner_module` is
/// the authoring module (source-language owner); `parent` holds the
/// declaration's preceding sibling for attached sets. The search order
/// below is not precedence: the parser rejects every spelling
/// combination (`E1202`), so at most one is ever present.
#[allow(clippy::too_many_arguments)]
fn checked_description(
    tables: &ResolveTables,
    messages: &HashMap<SymbolId, MessageData>,
    modules: &HashMap<ModuleId, ModuleData>,
    owner_module: ModuleId,
    text: &str,
    parent: &SyntaxNode,
    node: &SyntaxNode,
) -> Option<CheckedDescription> {
    let owner = NodeKey::of(node);
    let author_lang = modules
        .get(&owner_module)
        .map(|m| m.source_lang.clone())
        .unwrap_or_else(|| "en".to_string());
    if let Some(desc) = node
        .children
        .iter()
        .find(|c| c.kind == SyntaxKind::DescriptionValue)
    {
        let value = significant_children(desc).into_iter().find(|n| {
            matches!(
                n.kind,
                SyntaxKind::Literal | SyntaxKind::MessageValue | SyntaxKind::Path
            )
        })?;
        match value.kind {
            SyntaxKind::Literal => {
                return Some(CheckedDescription {
                    owner,
                    node: NodeKey::of(desc),
                    source: literal_string(text, value).unwrap_or_default(),
                    source_lang: author_lang,
                    variants: Vec::new(),
                    message: None,
                });
            }
            SyntaxKind::MessageValue => {
                let (source, variants) = message_text(text, value);
                return Some(CheckedDescription {
                    owner,
                    node: NodeKey::of(desc),
                    source,
                    source_lang: author_lang,
                    variants,
                    message: None,
                });
            }
            SyntaxKind::Path => {
                let (id, source, source_lang, variants) =
                    description_message_wording(tables, messages, value)?;
                return Some(CheckedDescription {
                    owner,
                    node: NodeKey::of(desc),
                    source,
                    source_lang,
                    variants,
                    message: Some(id),
                });
            }
            _ => return None,
        }
    }
    if let Some(annotation) = node
        .children
        .iter()
        .find(|c| c.kind == SyntaxKind::Annotation)
    {
        let source = significant_children(annotation)
            .iter()
            .find(|n| n.kind == SyntaxKind::Literal)
            .copied()
            .and_then(|literal| literal_string(text, literal))
            .unwrap_or_default();
        return Some(CheckedDescription {
            owner,
            node: NodeKey::of(annotation),
            source,
            source_lang: author_lang,
            variants: Vec::new(),
            message: None,
        });
    }
    let leaf = preceding_description(parent, node)?;
    let entry = description_entry(text, leaf, node);
    if let Some(reference) = entry.reference {
        let (id, source, source_lang, variants) =
            attached_message_wording(tables, messages, owner_module, &reference)?;
        return Some(CheckedDescription {
            owner,
            node: NodeKey::of(leaf),
            source,
            source_lang,
            variants,
            message: Some(id),
        });
    }
    Some(CheckedDescription {
        owner,
        node: NodeKey::of(leaf),
        source: entry.text,
        source_lang: author_lang,
        variants: entry.variants,
        message: None,
    })
}

/// Wording of a `desc= path` reference: the recorded symbol must be a
/// static zero-parameter message with decoded wording. Anything else
/// (unresolved, non-message, parameterized) was already diagnosed and
/// yields no wording.
fn description_message_wording(
    tables: &ResolveTables,
    messages: &HashMap<SymbolId, MessageData>,
    path: &SyntaxNode,
) -> Option<(SymbolId, String, String, Vec<MessageVariant>)> {
    let id = tables.node_symbol.get(&NodeKey::of(path)).copied()?;
    let SymbolKind::Message { params } = &tables.symbols[id.0 as usize].kind else {
        return None;
    };
    if !params.is_empty() {
        return None;
    }
    let data = messages.get(&id)?;
    Some((
        id,
        data.source.clone(),
        data.source_lang.clone(),
        data.variants.clone(),
    ))
}

/// Wording of an attached `#= name` reference: the lone segment names a
/// static zero-parameter message reachable in the authoring module.
/// Anything else (unresolved, qualified, non-message, parameterized)
/// was already diagnosed and yields no wording.
fn attached_message_wording(
    tables: &ResolveTables,
    messages: &HashMap<SymbolId, MessageData>,
    module: ModuleId,
    reference: &str,
) -> Option<(SymbolId, String, String, Vec<MessageVariant>)> {
    if reference.is_empty() || reference.contains('.') {
        return None;
    }
    let id = match tables
        .module_scopes
        .get(module.0 as usize)?
        .prod
        .get(reference)?
    {
        ScopedName::Local(id) | ScopedName::Imported { target: id, .. } => *id,
        ScopedName::External { .. } => return None,
    };
    let SymbolKind::Message { params } = &tables.symbols[id.0 as usize].kind else {
        return None;
    };
    if !params.is_empty() {
        return None;
    }
    let data = messages.get(&id)?;
    Some((
        id,
        data.source.clone(),
        data.source_lang.clone(),
        data.variants.clone(),
    ))
}

/// Attached `#` set immediately preceding `node` among `parent`'s
/// significant children, if any.
fn preceding_description<'n>(parent: &'n SyntaxNode, node: &SyntaxNode) -> Option<&'n SyntaxNode> {
    let kids = significant_children(parent);
    for (i, kid) in kids.iter().enumerate() {
        if std::ptr::eq(*kid, node) {
            return (i > 0)
                .then(|| kids[i - 1])
                .filter(|n| n.kind == SyntaxKind::Description);
        }
    }
    None
}

/// Verbatim text of a trailing `@{desc="..."}` annotation on a field
/// or parameter, when one is authored. The parser pins the closed
/// `desc` key and literal-only values (`E1214`); this just decodes
/// the string.
fn annotation_desc(text: &str, node: &SyntaxNode) -> Option<String> {
    node.children
        .iter()
        .filter(|c| c.kind == SyntaxKind::Annotation)
        .find_map(|annotation| {
            significant_children(annotation)
                .iter()
                .find(|n| n.kind == SyntaxKind::Literal)
                .copied()
                .and_then(|literal| literal_string(text, literal))
        })
}

/// Decoded text of a string literal node (`Literal` over one `String`
/// leaf, or the leaf itself).
fn literal_string(text: &str, node: &SyntaxNode) -> Option<String> {
    let leaf = if node.kind == SyntaxKind::String {
        Some(node)
    } else {
        significant_children(node)
            .iter()
            .find(|n| n.kind == SyntaxKind::String)
            .copied()
    };
    leaf.and_then(|n| n.token()).map(|t| {
        t.string_value.clone().unwrap_or_else(|| {
            t.text(text)
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .unwrap_or_else(|| t.text(text))
                .to_string()
        })
    })
}

/// Decoded value of an int literal node (self or first `Integer`
/// child, unwrapping one `Group`).
fn int_literal(text: &str, node: &SyntaxNode) -> Option<i64> {
    let mut current = node;
    loop {
        if current.kind == SyntaxKind::Integer {
            return current.token()?.text(text).parse::<i64>().ok();
        }
        let leaf = significant_children(current)
            .iter()
            .find(|n| n.kind == SyntaxKind::Integer)
            .copied();
        if let Some(leaf) = leaf {
            return leaf.token()?.text(text).parse::<i64>().ok();
        }
        if current.kind == SyntaxKind::Group {
            let inner = significant_children(current)
                .iter()
                .find(|n| is_expression(n.kind))
                .copied()?;
            current = inner;
        } else {
            return None;
        }
    }
}

/// Decoded source text plus variants of a `MessageValue` node.
fn message_text(text: &str, value: &SyntaxNode) -> (String, Vec<MessageVariant>) {
    let source = significant_children(value)
        .iter()
        .find(|n| n.kind == SyntaxKind::Literal)
        .and_then(|n| literal_string(text, n))
        .unwrap_or_default();
    let mut variants = Vec::new();
    for child in significant_children(value) {
        if child.kind != SyntaxKind::MessageVariant {
            continue;
        }
        let parts = significant_children(child);
        let key = parts.first().copied();
        let locale = key
            .and_then(|k| match k.kind {
                SyntaxKind::Name => name_text(k, text).map(str::to_string),
                SyntaxKind::String => k.token().map(|t| {
                    t.string_value.clone().unwrap_or_else(|| {
                        t.text(text)
                            .strip_prefix('"')
                            .and_then(|s| s.strip_suffix('"'))
                            .unwrap_or_else(|| t.text(text))
                            .to_string()
                    })
                }),
                _ => None,
            })
            .unwrap_or_default();
        let literal = parts
            .iter()
            .find(|n| n.kind == SyntaxKind::Literal)
            .copied();
        let val = match literal.and_then(|l| {
            significant_children(l)
                .iter()
                .find(|n| matches!(n.kind, SyntaxKind::String | SyntaxKind::Name))
                .copied()
        }) {
            Some(n) if n.kind == SyntaxKind::String => {
                literal_string(text, n).or_else(|| Some(String::new()))
            }
            _ => None,
        };
        variants.push(MessageVariant { locale, value: val });
    }
    (source, variants)
}

/// One description set attached to its owning declaration.
fn description_entry(text: &str, leaf: &SyntaxNode, owner: &SyntaxNode) -> DescriptionEntry {
    let raw = text
        .get(leaf.span.start as usize..leaf.span.end as usize)
        .unwrap_or("");
    let (prose, variants, reference) =
        decode_description_slice(leaf.span.file, raw, leaf.span.start);
    DescriptionEntry {
        node: NodeKey::of(leaf),
        owner: NodeKey::of(owner),
        text: prose,
        variants,
        reference,
    }
}

/// Decode one `#` description set from its source slice (GRAMMAR §1):
/// consecutive prose lines joined with `\n` (marker consumed, one optional
/// space after it removed, `\@{` unquoted), an optional `@{...}` suffix on
/// the final line, or a lone `#= path` reference. Layout owns malformed
/// sets (`E112x`); decoding here is best-effort.
fn decode_description_slice(
    file: SourceId,
    raw: &str,
    base: u32,
) -> (String, Vec<MessageVariant>, Option<String>) {
    let lines: Vec<&str> = raw.split('\n').collect();
    // Absolute offsets of each line's `#` marker plus its body bytes.
    let mut bodies: Vec<(u32, &str)> = Vec::new();
    let mut offset = base;
    for line in &lines {
        let stripped = line.trim_start();
        let hash_at = offset + (line.len() - stripped.len()) as u32;
        bodies.push((hash_at, stripped.strip_prefix('#').unwrap_or(stripped)));
        offset += line.len() as u32 + 1;
    }
    if bodies.iter().any(|(_, b)| b.starts_with('=')) {
        let path = bodies[0]
            .1
            .strip_prefix('=')
            .unwrap_or("")
            .split('.')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(".");
        return (String::new(), Vec::new(), Some(path));
    }
    let mut out: Vec<String> = Vec::new();
    let mut variants = Vec::new();
    for (index, (hash_at, body)) in bodies.iter().enumerate() {
        let content = body.strip_prefix(' ').unwrap_or(body);
        let content_base = hash_at + 1 + (body.len() - content.len()) as u32;
        let mut line = String::new();
        let mut position = 0usize;
        let mut suffix_at = None;
        while position < content.len() {
            if content[position..].starts_with("\\@{") {
                line.push_str("@{");
                position += 3;
            } else if content[position..].starts_with("@{") {
                if index == bodies.len() - 1 {
                    if line.ends_with(' ') {
                        line.pop();
                    }
                    suffix_at = Some(position);
                    break;
                }
                line.push_str("@{");
                position += 2;
            } else {
                let ch = content[position..].chars().next().expect("char boundary");
                line.push(ch);
                position += ch.len_utf8();
            }
        }
        out.push(line);
        if let Some(at) = suffix_at {
            variants = decode_description_suffix(file, &content[at..], content_base + at as u32);
        }
    }
    (out.join("\n"), variants, None)
}

/// Decode an `@{locale=STRING|null, ...}` suffix into variants.
fn decode_description_suffix(file: SourceId, fragment: &str, base: u32) -> Vec<MessageVariant> {
    let mut variants = Vec::new();
    let bytes = fragment.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'@' || bytes[1] != b'{' {
        return variants;
    }
    let mut i = 2usize;
    let skip_ws = |i: &mut usize| {
        while *i < bytes.len() && bytes[*i].is_ascii_whitespace() {
            *i += 1;
        }
    };
    loop {
        skip_ws(&mut i);
        if i < bytes.len() && bytes[i] == b'}' {
            break;
        }
        // Key: identifier or quoted tag.
        let key = if i < bytes.len() && bytes[i] == b'"' {
            let start = i;
            if !scan_quoted(bytes, &mut i) {
                break;
            }
            decode_json_string(&fragment[start..i], base + start as u32, file)
                .ok()
                .unwrap_or_default()
        } else {
            let start = i;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'_' | b'-' | b'.'))
            {
                i += 1;
            }
            if start == i {
                break;
            }
            fragment[start..i].to_string()
        };
        skip_ws(&mut i);
        if i >= bytes.len() || bytes[i] != b'=' {
            break;
        }
        i += 1;
        skip_ws(&mut i);
        // Value: JSON string or null.
        let value = if i < bytes.len() && bytes[i] == b'"' {
            let start = i;
            if !scan_quoted(bytes, &mut i) {
                break;
            }
            decode_json_string(&fragment[start..i], base + start as u32, file).ok()
        } else if fragment[i..].starts_with("null") {
            i += 4;
            None
        } else {
            break;
        };
        variants.push(MessageVariant { locale: key, value });
        skip_ws(&mut i);
        if i < bytes.len() && bytes[i] == b',' {
            i += 1;
            continue;
        }
        if i < bytes.len() && bytes[i] == b'}' {
            break;
        }
        break;
    }
    variants
}

/// Advance `i` past one quoted string starting at the opening quote;
/// `false` when unterminated.
fn scan_quoted(bytes: &[u8], i: &mut usize) -> bool {
    debug_assert_eq!(bytes[*i], b'"');
    *i += 1;
    let mut escaped = false;
    while *i < bytes.len() {
        let byte = bytes[*i];
        *i += 1;
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == b'"' {
            return true;
        }
    }
    false
}

/// A `rename`/`drop` migration directive.
fn migration_move(text: &str, node: &SyntaxNode) -> MigrationDirective {
    let parts = significant_children(node);
    let paths: Vec<&&SyntaxNode> = parts
        .iter()
        .filter(|n| n.kind == SyntaxKind::Path)
        .collect();
    let owner_only = paths.is_empty() && parts.get(1).is_some_and(|n| is_name(n, text, "owner"));
    let from = paths.first().map(|p| path_segments(p, text).join("."));
    let to = paths.get(1).map(|p| path_segments(p, text).join("."));
    if node.kind == SyntaxKind::Rename {
        MigrationDirective::Rename {
            node: NodeKey::of(node),
            from: from.unwrap_or_default(),
            to,
            owner_only,
        }
    } else {
        MigrationDirective::Drop {
            node: NodeKey::of(node),
            target: from,
            owner_only,
        }
    }
}

/// Module `source=` language tag, default `"en"`.
fn module_source_lang(text: &str, node: &SyntaxNode) -> String {
    attribute_value(node, "source", text)
        .and_then(|v| literal_string(text, v))
        .unwrap_or_else(|| "en".to_string())
}

/// Push unless already present.
fn push_unique<T: PartialEq>(vec: &mut Vec<T>, item: T) {
    if !vec.contains(&item) {
        vec.push(item);
    }
}

/// Operation id of a `call` target expression.
fn operation_id(types: &TypeTable, target: &SyntaxNode) -> Option<SymbolId> {
    match types.node_types.get(&NodeKey::of(target)) {
        Some(ResolvedType::Operation(id)) => Some(*id),
        _ => None,
    }
}

/// All statically known callees of a `call` target expression: the
/// operation itself, or every action/invocation target.
fn callee_ids(types: &TypeTable, target: &SyntaxNode) -> Vec<SymbolId> {
    match types.node_types.get(&NodeKey::of(target)) {
        Some(ResolvedType::Operation(id)) => vec![*id],
        Some(ResolvedType::Action { targets, .. } | ResolvedType::Invocation { targets }) => {
            targets.clone()
        }
        _ => Vec::new(),
    }
}

/// Whether an argument value fits a declared input type: exact match, or
/// a non-null value against a nullable input. Callers skip
/// error/unknown/opaque values.
// Known gap (post-2am item): narrower than the types pass's
// `types_compatible` (no Array/Union/Object recursion, Record
// stored-nuance, or Action/Invocation subset rules).
fn fits_type(actual: &ResolvedType, expected: &ResolvedType) -> bool {
    if actual == expected {
        return true;
    }
    if matches!(actual, ResolvedType::Null) {
        return matches!(expected, ResolvedType::Nullable(_));
    }
    match expected {
        ResolvedType::Nullable(inner) => fits_type(actual, inner),
        _ => false,
    }
}

/// Whether an effect always returns: `return`, `if` with two returning
/// branches, or a checked exhaustive match whose arms all return.
/// `for` may run zero times.
fn effect_returns(effect: &Effect, types: &TypeTable) -> bool {
    match effect.verb {
        EffectVerb::Return => true,
        EffectVerb::If => {
            !effect.then_effects.is_empty()
                && effect
                    .then_effects
                    .iter()
                    .any(|effect| effect_returns(effect, types))
                && !effect.else_effects.is_empty()
                && effect
                    .else_effects
                    .iter()
                    .any(|effect| effect_returns(effect, types))
        }
        EffectVerb::Match => {
            types.exhaustive_matches.contains(&effect.node)
                && !effect.match_arms.is_empty()
                && effect.match_arms.iter().all(|arm| {
                    arm.case.is_some()
                        && arm
                            .effects
                            .iter()
                            .any(|effect| effect_returns(effect, types))
                })
        }
        _ => false,
    }
}

/// Locate an existing checked initializer anchor, without resolving its source.
fn dependency_node<'a>(node: &'a SyntaxNode, key: &NodeKey) -> Option<&'a SyntaxNode> {
    if NodeKey::of(node) == *key {
        return Some(node);
    }
    node.children
        .iter()
        .find_map(|child| dependency_node(child, key))
}

/// Direct owner-bound model dependencies and bound derived-function calls.
/// Examples and malformed local statements/expressions are excluded.
fn collect_selected_calls(node: &SyntaxNode, types: &TypeTable, calls: &mut Vec<NodeKey>) {
    if matches!(
        node.kind,
        SyntaxKind::Examples | SyntaxKind::Error | SyntaxKind::BadToken
    ) {
        return;
    }
    let key = NodeKey::of(node);
    if types.selected_calls.contains_key(&key) {
        calls.push(key);
    }
    for child in significant_children(node) {
        collect_selected_calls(child, types, calls);
    }
}

fn collect_subtree_models(
    tables: &ResolveTables,
    types: &TypeTable,
    text: &str,
    node: &SyntaxNode,
    out: &mut Vec<SymbolId>,
    calls: &mut Vec<SymbolId>,
    creates: &mut Vec<(SymbolId, Vec<String>)>,
) {
    if matches!(
        node.kind,
        SyntaxKind::Examples | SyntaxKind::Error | SyntaxKind::BadToken
    ) {
        return;
    }
    match node.kind {
        SyntaxKind::Call if !is_statement_call(node) && !has_error(node) => {
            let mut callee = significant_children(node)
                .into_iter()
                .find(|n| is_expression(n.kind));
            while let Some(group) = callee.filter(|n| n.kind == SyntaxKind::Group) {
                callee = significant_children(group)
                    .into_iter()
                    .find(|n| is_expression(n.kind));
            }
            if let Some(Binding::Symbol(id)) =
                callee.and_then(|n| tables.node_binding.get(&NodeKey::of(n)))
                && matches!(
                    tables.symbols[id.0 as usize].kind,
                    SymbolKind::DeriveFn { .. }
                )
            {
                push_unique(calls, *id);
            }
        }
        SyntaxKind::Create => {
            let path = significant_children(node)
                .iter()
                .find(|n| n.kind == SyntaxKind::Path)
                .copied();
            if let Some(model) = path.and_then(|p| tables.node_symbol.get(&NodeKey::of(p)).copied())
                && matches!(
                    tables.symbols[model.0 as usize].kind,
                    SymbolKind::Model { .. }
                )
            {
                push_unique(out, model);
                let supplied = significant_children(node)
                    .into_iter()
                    .find(|n| n.kind == SyntaxKind::Object)
                    .map(|object| {
                        object_entries(object, text)
                            .into_iter()
                            .map(|(key, _, _)| key.to_string())
                            .collect()
                    })
                    .unwrap_or_default();
                creates.push((model, supplied));
            }
        }
        SyntaxKind::Set | SyntaxKind::Transition | SyntaxKind::Delete => {
            let path = significant_children(node)
                .iter()
                .find(|n| n.kind == SyntaxKind::Path)
                .copied();
            if let Some(path) = path
                && path_segments(path, text).first() != Some(&"event")
                && let Some(ResolvedType::Record { symbol, .. }) =
                    types.node_types.get(&NodeKey::of(path))
                && matches!(
                    tables.symbols[symbol.0 as usize].kind,
                    SymbolKind::Model { .. }
                )
            {
                push_unique(out, *symbol);
            }
        }
        SyntaxKind::NameRef => {
            // Bare model domains (`count(Todo)`) are owner-bound reads.
            if let Some(Binding::Symbol(id)) = tables.node_binding.get(&NodeKey::of(node))
                && matches!(tables.symbols[id.0 as usize].kind, SymbolKind::Model { .. })
            {
                push_unique(out, *id);
            }
        }
        SyntaxKind::Query => {
            let base = significant_children(node)
                .iter()
                .find(|n| is_expression(n.kind))
                .copied();
            if let Some(base) = base {
                let mut pushed = false;
                if base.kind == SyntaxKind::NameRef
                    && let Some(Binding::Symbol(id)) = tables.node_binding.get(&NodeKey::of(base))
                    && matches!(tables.symbols[id.0 as usize].kind, SymbolKind::Model { .. })
                {
                    push_unique(out, *id);
                    pushed = true;
                }
                if !pushed
                    && let Some(ResolvedType::Array { element, .. }) =
                        types.node_types.get(&NodeKey::of(base))
                    && let ResolvedType::Record { symbol, .. } = element.as_ref()
                    && matches!(
                        tables.symbols[symbol.0 as usize].kind,
                        SymbolKind::Model { .. }
                    )
                {
                    push_unique(out, *symbol);
                }
            }
        }
        _ => {}
    }
    for child in &node.children {
        collect_subtree_models(tables, types, text, child, out, calls, creates);
    }
}

/// Decoded shape of a stored-field declaration.
struct FieldShape {
    default: Option<NodeKey>,
    server: Option<NodeKey>,
    modifiers: Vec<ModifierData>,
    label: Option<NodeKey>,
    required_array: bool,
}

/// Decode a `Field` node: `[Name, :, Type, [!], (= default | server = init),
/// modifiers, (label = value), (@{desc} annotation)?]`.
fn field_shape(text: &str, field: &SyntaxNode) -> FieldShape {
    let mut shape = FieldShape {
        default: None,
        server: None,
        modifiers: Vec::new(),
        label: None,
        required_array: false,
    };
    let parts = significant_children(field);
    let Some(type_at) = parts.iter().position(|n| is_type_node(n.kind)) else {
        return shape;
    };
    let mut i = type_at + 1;
    // T09: the omission marker comes from the `!` spelling alone, never
    // from nullability (a `?` never sets it).
    if parts.get(i).is_some_and(|n| is_punct(n, text, "!")) {
        shape.required_array = true;
        i += 1;
    }
    if parts.get(i).is_some_and(|n| is_punct(n, text, "=")) {
        shape.default = parts
            .get(i + 1)
            .filter(|n| is_expression(n.kind))
            .copied()
            .map(NodeKey::of);
        i += 2;
    } else if parts.get(i).is_some_and(|n| is_name(n, text, "server")) {
        shape.server = parts
            .get(i + 2)
            .filter(|n| is_expression(n.kind))
            .copied()
            .map(NodeKey::of);
        i += 3;
    }
    while let Some(part) = parts.get(i) {
        // Description spellings sit between modifiers and `label=`
        // (`desc=` first, the legacy annotation trailing); neither is a
        // modifier, so both are skipped, never decoded here.
        if matches!(
            part.kind,
            SyntaxKind::DescriptionValue | SyntaxKind::Annotation
        ) {
            i += 1;
            continue;
        }
        let Some(word) = name_text(part, text) else {
            break;
        };
        match word {
            "trim" | "unique" | "machine" => {
                shape.modifiers.push(ModifierData {
                    name: word.to_string(),
                    node: NodeKey::of(part),
                    value: None,
                });
                i += 1;
            }
            "min" | "max" => {
                let value = parts
                    .get(i + 2)
                    .filter(|n| is_expression(n.kind))
                    .copied()
                    .map(NodeKey::of);
                shape.modifiers.push(ModifierData {
                    name: word.to_string(),
                    node: NodeKey::of(part),
                    value,
                });
                i += 3;
            }
            "label" => {
                shape.label = parts.get(i + 2).copied().map(NodeKey::of);
                break;
            }
            _ => break,
        }
    }
    shape
}

/// Decoded shape of a `Parameter` node.
struct ParamShape {
    default: Option<NodeKey>,
    label: Option<NodeKey>,
}

/// Decode a `Parameter` node: `[Name, :, Type, (= default)?, (label =
/// value)?, (@{desc} annotation)?]`.
fn param_shape(text: &str, param: &SyntaxNode) -> ParamShape {
    let mut shape = ParamShape {
        default: None,
        label: None,
    };
    let parts = significant_children(param);
    let Some(type_at) = parts.iter().position(|n| is_type_node(n.kind)) else {
        return shape;
    };
    let mut i = type_at + 1;
    if parts.get(i).is_some_and(|n| is_punct(n, text, "=")) {
        shape.default = parts
            .get(i + 1)
            .filter(|n| is_expression(n.kind))
            .copied()
            .map(NodeKey::of);
        i += 2;
    }
    // Choice metadata is nonexecutable and does not replace the default.
    if parts.get(i).is_some_and(|n| is_name(n, text, "choices")) {
        i += 3;
    }
    // A `desc=` spelling sits between the default and `label=`
    // (the legacy annotation trails); skip it so `label=` still decodes.
    if parts
        .get(i)
        .is_some_and(|n| n.kind == SyntaxKind::DescriptionValue)
    {
        i += 1;
    }
    if parts.get(i).is_some_and(|n| is_name(n, text, "label")) {
        shape.label = parts.get(i + 2).copied().map(NodeKey::of);
    }
    shape
}
