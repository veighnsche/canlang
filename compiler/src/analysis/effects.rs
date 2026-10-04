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
//!
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
    Binding, ContextVar, CrudOp, ModelOwner, ModuleId, ResolveTables, ScopedName, SymbolId,
    SymbolKind,
};
use crate::analysis::types::{ResolvedType, Scalar, TypeTable};
use crate::diagnostic::Diagnostic;
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
    /// `let` value / `return` value / `cancel` key.
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
}

/// Closed effect vocabulary (DESIGN §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectVerb {
    Let,
    Require,
    Create,
    Set,
    Delete,
    Call,
    Emit,
    Send,
    Schedule,
    Cancel,
    Return,
    If,
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
    /// Whether the field-only required-array `!` marker is present.
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
}

/// Module data: pages, rule refs, migration refs, descriptions (G9).
#[derive(Debug, Clone)]
pub struct ModuleData {
    /// Module id.
    pub module: ModuleId,
    /// Source language tag (module `source=`, default `"en"`).
    pub source_lang: String,
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
    for (file, tree) in trees {
        cx.walk_file(*file, tree);
    }
    cx.walk_calls_and_descriptions(trees);
    cx.finish();
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
    /// Direct data models per scenario (create/set/delete targets plus
    /// query domains).
    scenario_models: HashMap<SymbolId, Vec<SymbolId>>,
    /// Direct `call` targets per scenario (scenarios and CRUD ops).
    scenario_calls: HashMap<SymbolId, Vec<SymbolId>>,
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
            scenario_models: HashMap::new(),
            scenario_calls: HashMap::new(),
            every_handlers: Vec::new(),
            builtins: HashSet::new(),
            descriptions: Vec::new(),
        }
    }

    fn text(&self, file: SourceId) -> &str {
        self.db.get(file).map(|s| s.text.as_str()).unwrap_or("")
    }

    fn finish(&mut self) {
        self.check_app_policies();
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

    fn walk_module(&mut self, file: SourceId, text: &str, node: &SyntaxNode) {
        if has_error(node) {
            return;
        }
        let Some(name) = decl_name(text, node, &["app", "package", "export", "migration"]) else {
            return;
        };
        let Some(module) = self.tables.module_by_name.get(name).copied() else {
            return;
        };
        let source_lang = module_source_lang(text, node);
        self.out
            .modules
            .entry(module)
            .or_insert_with(|| ModuleData {
                module,
                source_lang,
                pages: Vec::new(),
                policies: Vec::new(),
                invariants: Vec::new(),
                uniques: Vec::new(),
                locks: Vec::new(),
                retains: Vec::new(),
                migrations: Vec::new(),
                descriptions: Vec::new(),
            });
        for child in significant_children(node) {
            match child.kind {
                SyntaxKind::Context => self.walk_context(module, text, child),
                SyntaxKind::Section => self.walk_section(file, module, text, child),
                _ => {}
            }
        }
    }

    /// Collect context-declared queue/analytics names for `send` targets.
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
            fields.push(FieldData {
                field,
                node: NodeKey::of(child),
                type_node,
                default: shape.default,
                server: shape.server,
                modifiers: shape.modifiers,
                label: shape.label,
                required_array: shape.required_array,
            });
        }
        fields
    }

    /// Parameters of one signature in source order.
    fn signature_params(
        &self,
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
            out.push(ParamData {
                param,
                node: NodeKey::of(child),
                type_node,
                default: shape.default,
                label: shape.label,
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
        self.out.messages.insert(
            id,
            MessageData {
                message: id,
                module,
                node: NodeKey::of(node),
                params: self.signature_params(text, id, &params, node),
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
        self.out.derives.insert(
            id,
            DeriveData {
                derive: id,
                module,
                node: NodeKey::of(node),
                model,
                params: self.signature_params(text, id, &params, node),
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
                let (fields, fields_node) = selector_paths(text, node, "fields");
                if let (Some(model), true) = (is_model.then_some(target_id), self.checks_on) {
                    self.check_secret_grant(module, text, model, node);
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
        // Direct data models for handler-scope inference (E4051).
        let mut models = Vec::new();
        collect_subtree_models(self.tables, self.types, text, node, &mut models);
        self.scenario_models.insert(id, models);
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
                label: attribute_value(node, "label", text).map(NodeKey::of),
                params: self.signature_params(text, id, &params, node),
                result: result_annotation(text, node).map(NodeKey::of),
                guards,
                effects,
            },
        );
        self.current_hook = prev_hook;
        self.current_scenario = prev_scenario;
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
                dead = dead || effect_returns(&effect);
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
                    }
                }
                effect.args = effect_args(text, node);
                effect.binding = as_binding(text, node);
            }
            SyntaxKind::Set => {
                effect.verb = EffectVerb::Set;
                let path = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied();
                effect.target = path.and_then(|p| self.record_target(module, text, p));
                if self.checks_on
                    && let Some(EffectTarget::Record { model: Some(model) }) = &effect.target
                {
                    self.check_own_mutation(module, text, node, path, *model, "set");
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
                        push_unique(self.scenario_calls.entry(caller).or_default(), callee);
                    }
                }
                if self.checks_on
                    && let Some(target) = target
                {
                    self.check_action_call(module, text, node, target);
                }
                effect.args = effect_args(text, node);
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
            }
            SyntaxKind::Cancel => {
                effect.verb = EffectVerb::Cancel;
                effect.value = parts
                    .iter()
                    .find(|n| is_expression(n.kind))
                    .copied()
                    .map(NodeKey::of);
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
        if node.kind == SyntaxKind::Examples || has_error(node) {
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
                if let Some(direct) = self.scenario_models.get(&current) {
                    for model in direct {
                        push_unique(&mut models, *model);
                    }
                }
                if let Some(callees) = self.scenario_calls.get(&current).cloned() {
                    for callee in callees {
                        match &self.tables.symbols[callee.0 as usize].kind {
                            SymbolKind::Scenario { .. } => stack.push(callee),
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

/// Whether an effect always returns: `return`, or `if` with two
/// always-returning branches (`for` may run zero times).
fn effect_returns(effect: &Effect) -> bool {
    match effect.verb {
        EffectVerb::Return => true,
        EffectVerb::If => {
            !effect.then_effects.is_empty()
                && effect.then_effects.iter().any(effect_returns)
                && !effect.else_effects.is_empty()
                && effect.else_effects.iter().any(effect_returns)
        }
        _ => false,
    }
}

/// Direct data models of one scenario subtree: `create`/`set`/`delete`
/// targets plus query domains (`Examples` excluded).
fn collect_subtree_models(
    tables: &ResolveTables,
    types: &TypeTable,
    text: &str,
    node: &SyntaxNode,
    out: &mut Vec<SymbolId>,
) {
    if node.kind == SyntaxKind::Examples {
        return;
    }
    match node.kind {
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
            }
        }
        SyntaxKind::Set | SyntaxKind::Delete => {
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
        collect_subtree_models(tables, types, text, child, out);
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
/// modifiers, (label = value)]`.
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
        let Some(word) = name_text(part, text) else {
            break;
        };
        match word {
            "trim" | "unique" => {
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
/// value)?]`.
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
    if parts.get(i).is_some_and(|n| is_name(n, text, "label")) {
        shape.label = parts.get(i + 2).copied().map(NodeKey::of);
    }
    shape
}
