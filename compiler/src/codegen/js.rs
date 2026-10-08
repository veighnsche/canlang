//! Direct JavaScript emission per DESIGN §13 (lane-01 codegen, PR6).
//!
//! [`emit_program`] lowers an [`IrProgram`] to one entrypoint module plus
//! one module per non-entrypoint package. The entrypoint holds the
//! `appDefinition` shape, the single `canApp()` callable-registry factory
//! (handlers/rules only, no metadata spread), named page functions and page
//! descriptors in source order. Package modules export canonical identity
//! constants plus capability-operation stubs. Lowering is total: anything
//! checked but without a §13 lowering is an `E6008` naming the position,
//! and the emitted placeholder throws loudly — never a silent wrong value.
//!
//! Imports come only from `@canlang/stdlib`, `@canlang/ui`, owning-package
//! relative modules (`./<pkg>.mjs`) and declared bindings. UI uses
//! lowercase server factories with one props object plus `children` arrays;
//! there is no `h`, native-element expansion, hydration or browser
//! business-state store.
//!
//! Scalar lowering uses one import name per operation (`addMoney`,
//! `compareMoney` with relational compare against zero, ...), BigInt exact
//! integers/durations, `int64` checked arithmetic, `same` reference
//! identity and `equalValue(canonicalTypeId, a, b)` structural equality.
//! Guards lower `by` to `check(hasRole(...), 'forbidden')`; effects lower
//! `deleteRecord` modes, bound `send`, `schedule` with `on:{every}` and
//! CRUD `create`/`set` with `when`.

use crate::analysis::catalog::{StdOperation, nominal_schema, std_capability};
use crate::analysis::resolve::{CrudOp, ModuleKind, SymbolId};
use crate::analysis::types::{ResolvedType, Scalar, canonical_datetime_literal};
use crate::codegen::ir::{
    IrBinOp, IrCallTarget, IrDefault, IrExpr, IrFieldLabel, IrGuard, IrHook, IrItem, IrItemKind,
    IrMessage, IrOwner, IrPage, IrProgram, IrServer, IrStmt, IrType, IrUi, IrUnOp,
    ReferencedBuiltin, ScalarFamily, TypedExpr, expr_uses_async, is_structural, scalar_family,
};
use crate::diagnostic::Diagnostic;
use crate::source::Span;
use serde::ser::{SerializeMap, SerializeStruct};
use serde::{Serialize, Serializer};
use std::collections::{BTreeMap, BTreeSet, HashMap};

fn invocation_base(ty: &ResolvedType) -> bool {
    match ty {
        ResolvedType::Invocation { .. } => true,
        ResolvedType::Array { element, .. } | ResolvedType::Nullable(element) => {
            invocation_base(element)
        }
        _ => false,
    }
}

fn descriptor_json(value: &(impl Serialize + ?Sized)) -> String {
    crate::json::to_compact_string(value).expect("descriptor JSON serialization invariant")
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// One emitted line and the `.can` span it maps to.
#[derive(Debug, Clone)]
pub struct JsLine {
    /// 1-based emitted line number.
    pub line: u32,
    /// Source span the line maps to.
    pub span: Span,
    /// Optional source-map name (symbol or handler identity).
    pub name: Option<String>,
}

/// One emitted JavaScript module with its line map.
#[derive(Debug, Clone)]
pub struct JsModule {
    /// Output path relative to the artifact root (`<pkg>.mjs`).
    pub path: String,
    /// Compiled JavaScript.
    pub js: String,
    /// One entry per emitted line, in order.
    pub lines: Vec<JsLine>,
}

/// Callable registry entry lowered into `canApp()`.
#[derive(Debug, Clone)]
pub struct JsCallable {
    /// Canonical qualified identity.
    pub id: String,
    /// Registry kind.
    pub kind: JsCallableKind,
    /// Registry member / export name.
    pub export: String,
    /// Path segments into the module's `canApp()` registry object.
    pub member: Vec<String>,
    /// Generated scenario parameters, as opposed to the legacy runtime envelope.
    pub input_style: Option<String>,
    /// Declaration span.
    pub span: Span,
}

/// Callable kinds of the `canApp()` registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsCallableKind {
    Operation,
    Pure,
    Rule,
    Handler,
    Migration,
}

impl JsCallableKind {
    /// Artifact `kind` spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            JsCallableKind::Operation => "operation",
            JsCallableKind::Pure => "pure",
            JsCallableKind::Rule => "rule",
            JsCallableKind::Handler => "handler",
            JsCallableKind::Migration => "migration",
        }
    }
}

/// Page descriptor reference lowered into `appDefinition.pages`.
#[derive(Debug, Clone)]
pub struct JsPage {
    /// Canonical declaring package.
    pub owner: String,
    /// Normalized route pattern.
    pub path: String,
    /// Descriptor binding name.
    pub export: String,
}

/// MCP operation kind of one user-invocable operation (the `.can`
/// subset of `McpOperationKind`: `list`/`team` have no `.can` source).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsOperationKind {
    Read,
    Create,
    Update,
    Delete,
    Scenario,
}

impl JsOperationKind {
    /// Artifact `kind` spelling (matches `McpOperationKind`).
    pub fn as_str(self) -> &'static str {
        match self {
            JsOperationKind::Read => "read",
            JsOperationKind::Create => "create",
            JsOperationKind::Update => "update",
            JsOperationKind::Delete => "delete",
            JsOperationKind::Scenario => "scenario",
        }
    }
}

/// One closed typed input field (JSON shape of `McpSchemaField`).
#[derive(Debug, Clone)]
pub enum JsMcpField {
    /// Stored-record reference: canonical model + version requirement.
    Ref {
        model: String,
        require_version: bool,
    },
    String,
    Integer,
    Decimal,
    Money,
    Datetime,
    Duration,
    User,
    Boolean,
    File,
    /// Anonymous enum: case spellings in declaration order.
    Enum {
        values: Vec<String>,
    },
    /// T15b provider delivery: a T14c typed `std` receipt. Closed
    /// identity (capability + operation + frozen contract version)
    /// plus the T13c result nominal; shared shape with
    /// [`JsModelFieldType::Delivery`] (one renderer, no drift).
    Delivery(JsDeliveryDescriptor),
}

/// One T13c nominal result leaf, verbatim (JSON shape of
/// `ArtifactNominalLeaf`).
///
/// `declared` is the T13c transcribed kind spelling (`text?`,
/// `file[]`, `enum(a,b)`, nominal refs — catalog.rs mapping rules),
/// never a re-interpretation: T04b ratifies any structured leaf
/// vocabulary, and verbatim leaves derive it without loss.
#[derive(Debug, Clone, Serialize)]
pub struct JsNominalLeaf {
    /// Leaf field name in producer order.
    pub name: String,
    /// Verbatim T13c declared kind spelling.
    #[serde(rename = "type")]
    pub declared: String,
}

impl JsNominalLeaf {
    /// Compact JSON in the owning artifact contract's field order.
    pub fn to_json(&self) -> String {
        descriptor_json(self)
    }
}

/// One T13 provider-result nominal with its T13c leaves (JSON shape
/// of `ArtifactNominalResult`).
#[derive(Debug, Clone, Serialize)]
pub struct JsNominalResult {
    /// Source nominal name (T13c source spelling, e.g. `ImageRun` —
    /// never a TS wire alias).
    pub name: String,
    /// Leaves in T13c producer order.
    pub fields: Vec<JsNominalLeaf>,
}

impl JsNominalResult {
    /// Compact JSON in the owning artifact contract's field order.
    pub fn to_json(&self) -> String {
        descriptor_json(self)
    }
}

/// One T15b provider delivery descriptor (JSON shape of
/// `ArtifactDeliveryDescriptor`).
///
/// Closed T04b-preview kind for T14c typed `std` receipts: the
/// capability + operation identity plus the frozen capability
/// contract version (T04a §7 version fencing) and the T13c result
/// nominal. Old consumers precisely reject the unknown `delivery`
/// kind per T04a §3/§7 (additive-only); T04b ratifies the shape.
#[derive(Debug, Clone)]
pub struct JsDeliveryDescriptor {
    /// Qualified capability contract, e.g. `std.EmailV1`.
    pub capability: String,
    /// Consumed operation name, e.g. `send`.
    pub operation: String,
    /// Frozen capability contract version (`STD_*_VERSION`).
    pub version: u32,
    /// Declared provider result with its T13c leaves.
    pub result: JsNominalResult,
}

impl JsDeliveryDescriptor {
    /// Compact JSON in the owning artifact contract's field order.
    pub fn to_json(&self) -> String {
        descriptor_json(self)
    }
}

/// Build the provider delivery descriptor for one consumed T13 `std`
/// operation, or `None` when either join fails (fail-closed: callers
/// keep exactly today's omit/`other` behavior; T04b owns ratification
/// and nothing is fabricated).
///
/// The capability version comes from the frozen consume layer
/// ([`std_capability`]) and the result leaves from the T13c
/// transcription ([`nominal_schema`]) in producer order.
pub fn delivery_descriptor(capability: &str, op: &StdOperation) -> Option<JsDeliveryDescriptor> {
    let version = std_capability(capability)?.version;
    let schema = nominal_schema(op.result)?;
    Some(JsDeliveryDescriptor {
        capability: capability.to_string(),
        operation: op.name.to_string(),
        version,
        result: JsNominalResult {
            name: op.result.to_string(),
            fields: schema
                .fields
                .iter()
                .map(|(name, declared)| JsNominalLeaf {
                    name: (*name).to_string(),
                    declared: (*declared).to_string(),
                })
                .collect(),
        },
    })
}

impl JsMcpField {
    /// Compact JSON in the owning artifact contract's field order.
    pub fn to_json(&self) -> String {
        descriptor_json(self)
    }
}

/// One T18 closed-set server initializer (JSON shape of
/// `artifact.ts` `ArtifactServerInit`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JsServerInit {
    /// `server=actor`: the invoking actor as a wire `{id}` user value.
    Actor,
    /// `server=now`: the frozen invocation clock as RFC 3339 millis.
    Now,
    /// `server=random_secret()`: fresh opaque hex material per execution.
    RandomSecret,
    /// Any other `server=` expression (e.g. `server=now+1h`): the L3
    /// loader rejects such sets fail-closed (T04b vocabulary).
    Computed,
}

impl JsServerInit {
    /// Compact JSON token per `artifact.ts` `ArtifactServerInit`.
    pub fn to_json(self) -> &'static str {
        match self {
            JsServerInit::Actor => "\"actor\"",
            JsServerInit::Now => "\"now\"",
            JsServerInit::RandomSecret => "\"random_secret\"",
            JsServerInit::Computed => "\"computed\"",
        }
    }
}

/// One source-derived field default (JSON shape of `ArtifactFieldDefault`,
/// mirroring L3 `CanonicalFieldDefault`).
#[derive(Debug, Clone)]
pub enum JsFieldDefault {
    /// Wire-encoded literal value (pre-rendered compact JSON, never a JS
    /// Number: ints/decimals/durations are canonical decimal strings,
    /// money is `{minor, currency}`).
    Literal(String),
    /// Dot path off the loaded parent row (create only; leading `parent.`
    /// stripped, e.g. `parent.parent.user` renders `"parent.user"`).
    Parent { path: String },
    /// Engine-resolved server initializer (T18 closed `init` vocabulary).
    Server(JsServerInit),
    /// Derived value marker (derived fields only; T18 executes).
    Derived,
}

impl JsFieldDefault {
    /// Compact JSON in the owning artifact contract's field order.
    pub fn to_json(&self) -> String {
        descriptor_json(self)
    }
}

/// True for exactly `random_secret()` (no arguments): the one computed
/// `server=` spelling the T18 closed set executes.
fn is_random_secret_call(expr: &TypedExpr) -> bool {
    match &expr.expr {
        IrExpr::Call { target, args } => {
            matches!(target, IrCallTarget::Builtin { id, .. } if id == "random_secret")
                && args.is_empty()
        }
        _ => false,
    }
}

/// Map one server initializer to the T18 closed `init` vocabulary.
/// Total: non-closed computed expressions map to `Computed` (the L3
/// loader rejects them fail-closed); descriptors never fail compilation.
pub fn js_server_init(server: &IrServer) -> JsServerInit {
    match server {
        IrServer::Actor => JsServerInit::Actor,
        IrServer::Now => JsServerInit::Now,
        IrServer::Computed(expr) if is_random_secret_call(expr) => JsServerInit::RandomSecret,
        IrServer::Computed(_) => JsServerInit::Computed,
    }
}

/// Map one field/parameter default plus server initializer to its
/// descriptor form, or `None` when the default has no T04a vocabulary.
///
/// `server=` (any spelling) wins as `{kind:"server",init:...}` (T18
/// closed vocabulary via [`js_server_init`]) and literal defaults
/// encode via [`literal_json`]; computed defaults map only when they
/// are a parent path ([`parent_path`]). Any other computed default (a
/// non-parent expression) maps to `None`: the caller keeps
/// `required: false` and the emitted `default(c)` callable preserves
/// execution — T04b grows the vocabulary. Total and diagnostic-free:
/// descriptors never fail compilation.
pub fn js_field_default(
    default: Option<&IrDefault>,
    server: Option<&IrServer>,
) -> Option<JsFieldDefault> {
    if let Some(server) = server {
        return Some(JsFieldDefault::Server(js_server_init(server)));
    }
    match default {
        None => None,
        Some(IrDefault::Literal(value)) => literal_json(value).map(JsFieldDefault::Literal),
        Some(IrDefault::Computed { expr, .. }) => {
            parent_path(expr).map(|path| JsFieldDefault::Parent { path })
        }
    }
}

/// Encode one literal expression as wire-compatible compact JSON, or
/// `None` when the expression is not an exact literal.
///
/// Integers, decimals (authored spelling verbatim, so scale survives:
/// `"1.50"` stays `"1.50"`) and durations render as canonical decimal
/// strings; money renders as `{minor, currency}` with a decimal-string
/// minor; dates/datetimes render verbatim; arrays and structural
/// objects recurse (T10 slice). Unary minus over int/decimal literals
/// and the `money`/`date`/`datetime` construct calls (all-literal
/// arguments) are recognized; anything else — names, member access,
/// general calls, queries — is not a literal. Mirrors the L2 wire
/// encoding (`packages/values/src/wire.ts`); T18 decodes with it.
pub fn literal_json(expr: &TypedExpr) -> Option<String> {
    wire_literal(expr).map(|value| descriptor_json(&value))
}

// This tree never introduces binary floating point or sorts authored object keys.
enum WireLiteral {
    String(String),
    Bool(bool),
    Null,
    Money { minor: String, currency: String },
    Array(Vec<WireLiteral>),
    Object(Vec<(String, WireLiteral)>),
}

impl Serialize for WireLiteral {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::String(value) => value.serialize(serializer),
            Self::Bool(value) => value.serialize(serializer),
            Self::Null => serializer.serialize_unit(),
            Self::Money { minor, currency } => {
                let mut state = serializer.serialize_struct("Money", 2)?;
                state.serialize_field("minor", minor)?;
                state.serialize_field("currency", currency)?;
                state.end()
            }
            Self::Array(items) => items.serialize(serializer),
            Self::Object(entries) => {
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (key, value) in entries {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

fn wire_literal(expr: &TypedExpr) -> Option<WireLiteral> {
    if let Some(value) = super::defaults::money_default_wire(expr) {
        return Some(owner_wire_literal(value));
    }
    match &expr.expr {
        IrExpr::Int(value) => Some(WireLiteral::String(value.to_string())),
        IrExpr::Decimal(spelling) => Some(WireLiteral::String(spelling.clone())),
        IrExpr::Text(value) => Some(WireLiteral::String(value.clone())),
        IrExpr::Bool(value) => Some(WireLiteral::Bool(*value)),
        IrExpr::Null => Some(WireLiteral::Null),
        IrExpr::Money { minor, currency } => Some(WireLiteral::Money {
            minor: minor.to_string(),
            currency: currency.clone(),
        }),
        IrExpr::DurationMs(ms) => Some(WireLiteral::String(ms.to_string())),
        IrExpr::Date(value) => Some(WireLiteral::String(value.clone())),
        IrExpr::Datetime(value) => {
            Some(WireLiteral::String(canonical_datetime_literal(value).ok()?))
        }
        IrExpr::Array(items) => {
            let mut parts = Vec::with_capacity(items.len());
            for item in items {
                parts.push(wire_literal(item)?);
            }
            Some(WireLiteral::Array(parts))
        }
        IrExpr::Object(entries) => {
            let mut parts = Vec::with_capacity(entries.len());
            for (key, value) in entries {
                parts.push((key.clone(), wire_literal(value)?));
            }
            Some(WireLiteral::Object(parts))
        }
        IrExpr::Unary { op, operand } if *op == IrUnOp::Neg => match &operand.expr {
            IrExpr::Int(value) => Some(WireLiteral::String(value.checked_neg()?.to_string())),
            IrExpr::Decimal(spelling) => Some(WireLiteral::String(format!("-{spelling}"))),
            _ => None,
        },
        IrExpr::Call { target, args } => {
            let id = match target {
                IrCallTarget::Builtin { id, .. } => id.as_str(),
                IrCallTarget::CapabilityOp(_) | IrCallTarget::DeriveFn(_) => return None,
            };
            match (id, args.as_slice()) {
                ("date", [single]) if matches!(single.expr, IrExpr::Text(_)) => {
                    let IrExpr::Text(value) = &single.expr else {
                        return None;
                    };
                    Some(WireLiteral::String(value.clone()))
                }
                ("datetime", [single]) if matches!(single.expr, IrExpr::Text(_)) => {
                    let IrExpr::Text(value) = &single.expr else {
                        return None;
                    };
                    Some(WireLiteral::String(canonical_datetime_literal(value).ok()?))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// Adapt the owner's canonical output tree without owning its encoding rules.
fn owner_wire_literal(value: values_semantics::codecs::numeric::WireValue) -> WireLiteral {
    use values_semantics::codecs::numeric::WireValue;
    match value {
        WireValue::Text(value) => WireLiteral::String(value),
        WireValue::Object(entries) => WireLiteral::Object(
            entries
                .into_iter()
                .map(|(key, value)| (key, owner_wire_literal(value)))
                .collect(),
        ),
    }
}

/// Extract the dot path of a parent default: a `Member` chain rooted at
/// the bare `parent` creation-context name, with the leading `parent.`
/// stripped (`parent.parent.user` renders `"parent.user"`). Bare
/// `parent` (no path) and non-parent roots map to `None`. Raw field
/// names (never JS-sanitized): T18 resolves against row data.
pub fn parent_path(expr: &TypedExpr) -> Option<String> {
    let mut segments = Vec::new();
    let mut current = expr;
    loop {
        match &current.expr {
            IrExpr::Member { base, field } => {
                segments.push(field.clone());
                current = base;
            }
            IrExpr::Name(name) if name == "parent" && !segments.is_empty() => {
                segments.reverse();
                return Some(segments.join("."));
            }
            _ => return None,
        }
    }
}

/// One named operation input (JSON shape of `McpNamedField`).
#[derive(Debug, Clone)]
pub struct JsOperationField {
    /// Input name (parameter or flattened model field).
    pub name: String,
    /// Closed typed schema (element kind for array inputs).
    pub field: JsMcpField,
    /// Checked source value identity when the wire kind alone is ambiguous.
    pub value_type: Option<&'static str>,
    /// Whether the caller must supply the member.
    pub required: bool,
    /// Whether the input accepts explicit null (T15a additive).
    pub nullable: bool,
    /// T09 array marker for array inputs: `Some(required)` where
    /// `required` is the field-only `!` spelling (scenario parameters
    /// are always ordinary); `None` for singular inputs.
    pub array_required: Option<bool>,
    /// Source-declared default, when representable (T15a additive;
    /// never present on update changes, which are partial).
    pub default: Option<JsFieldDefault>,
    /// Checked description source text, when authored (D03: the one
    /// slot inline/attached/shared/legacy spellings feed; variants
    /// never leave the source — localized MCP is deferred).
    pub description: Option<String>,
}

impl JsOperationField {
    /// Compact JSON in the owning artifact contract's field order.
    pub fn to_json(&self) -> String {
        descriptor_json(self)
    }
}

/// One user-invocable operation descriptor (JSON shape of
/// `OperationDescriptor`: `{name, kind, description, inputs, result?}`).
#[derive(Debug, Clone)]
pub struct JsOperation {
    /// Canonical operation identity (`Shop.approve`, `Shop.Gadget.create`).
    pub name: String,
    /// MCP operation kind.
    pub kind: JsOperationKind,
    /// Verbatim `#` description source text (`""` when absent).
    pub description: String,
    /// Closed typed inputs in signature order.
    pub inputs: Vec<JsOperationField>,
    /// Checked scenario result type in the bounded publication profile.
    /// Absent means unknown; generated reads and CRUD do not claim void.
    pub result: Option<&'static str>,
}

impl JsOperation {
    /// Compact JSON in the owning artifact contract's field order.
    pub fn to_json(&self) -> String {
        descriptor_json(self)
    }
}

/// Whether an input list repeats a name. A repeated name (e.g. a model
/// field literally named `record` beside the synthesized `record` ref)
/// is an unmappable collision: the descriptors omit the operation
/// rather than advertise an ambiguous closed schema.
fn has_duplicate_names(inputs: &[JsOperationField]) -> bool {
    let mut seen = BTreeSet::new();
    inputs.iter().any(|input| !seen.insert(input.name.as_str()))
}

/// Compact JSON array of operation descriptors, shared by the artifact
/// envelope and the `canApp()` registry literal (one renderer, no drift).
pub fn operations_json(operations: &[JsOperation]) -> String {
    descriptor_json(operations)
}

/// One stored-model field type tag (JSON shape of `ArtifactModelFieldType`).
///
/// The `Ref`/scalar/`Enum`/`Delivery` members mirror [`JsMcpField`]
/// (minus `require_version`, meaningless for stored rows); the
/// `Date`..`Bytes` members are additive T04b-preview tags and `Other`
/// is the honest fallback for bound-local deliveries, actions,
/// unions, contracts and unknown shapes. T15b (provider join) refines
/// T14c typed `std` receipts into `Delivery` here — never in a second
/// format; unjoined shapes keep the `other` fallback.
#[derive(Debug, Clone)]
pub enum JsModelFieldType {
    /// Stored-record reference: canonical target model.
    Ref {
        model: String,
    },
    String,
    Integer,
    Decimal,
    Money,
    Datetime,
    Boolean,
    File,
    /// Anonymous enum: case spellings in declaration order.
    Enum {
        values: Vec<String>,
    },
    /// T15b provider delivery: a T14c typed `std` receipt (shared
    /// [`JsDeliveryDescriptor`] shape with [`JsMcpField::Delivery`]).
    Delivery(JsDeliveryDescriptor),
    /// T04b-preview additive tags (source-exact; T04a intake ignores).
    Date,
    Duration,
    Secret,
    User,
    Member,
    Json,
    Bytes,
    /// Honest fallback: `type_id` is the source type id.
    Other {
        type_id: String,
    },
}

impl JsModelFieldType {
    /// Compact JSON in the owning artifact contract's field order.
    pub fn to_json(&self) -> String {
        descriptor_json(self)
    }
}

/// One stored (or derived) model field (JSON shape of `ArtifactModelField`).
#[derive(Debug, Clone)]
pub struct JsModelField {
    /// Field name (model-local).
    pub name: String,
    /// Element type tag (arrays add the `array` marker).
    pub field: JsModelFieldType,
    /// Checked source value identity when the wire kind alone is ambiguous.
    pub value_type: Option<&'static str>,
    /// Whether omission rejects at creation.
    pub required: bool,
    /// Whether the field accepts explicit null.
    pub nullable: bool,
    /// Whether caller-supplied values are rejected.
    pub server_only: bool,
    /// T09 array marker for array fields (`!` spelling); `None` singular.
    pub array_required: Option<bool>,
    /// Source-declared default, when representable.
    pub default: Option<JsFieldDefault>,
    /// Optional field-owned lifecycle metadata.
    pub machine: Option<JsMachine>,
    /// Checked description source text, when authored.
    pub description: Option<String>,
}

impl JsModelField {
    /// Compact JSON in the owning artifact contract's field order.
    pub fn to_json(&self) -> String {
        descriptor_json(self)
    }
}

/// One field-owned flat lifecycle, derived from checked transition sites.
#[derive(Debug, Clone, Serialize)]
pub struct JsMachine {
    pub initial: String,
    pub states: Vec<String>,
    pub transitions: Vec<JsMachineTransition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JsMachineTransition {
    pub from: String,
    pub to: String,
    pub operation: String,
}

/// One stored model descriptor (JSON shape of `ArtifactModel`).
#[derive(Debug, Clone, Serialize)]
pub struct JsModel {
    /// Canonical model identity.
    pub name: String,
    /// Stored then derived fields in source order.
    pub fields: Vec<JsModelField>,
    /// What a caller-asked remove does: `archive` (default), `remove`
    /// (declared) or `none` (no enabled delete operation).
    #[serde(rename = "deleteMode")]
    pub delete_mode: String,
    /// Unique keys in source order (empty omits the member).
    #[serde(rename = "uniqueKeys", skip_serializing_if = "Vec::is_empty")]
    pub unique_keys: Vec<String>,
    /// Canonical parent model, for `in Parent` children.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Whether the model is app-scoped (`in app`).
    #[serde(
        rename = "scope",
        skip_serializing_if = "is_false",
        serialize_with = "serialize_app_scope"
    )]
    pub scope_app: bool,
}

impl JsModel {
    /// Compact JSON in the owning artifact contract's field order.
    pub fn to_json(&self) -> String {
        descriptor_json(self)
    }
}

/// Compact JSON array of model descriptors, rendered only by the artifact
/// envelope (the runtime reads the richer `appDefinition.models` member;
/// descriptors stay one format).
pub fn models_json(models: &[JsModel]) -> String {
    descriptor_json(models)
}

impl Serialize for JsDeliveryDescriptor {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("Delivery", 5)?;
        state.serialize_field("kind", "delivery")?;
        state.serialize_field("capability", &self.capability)?;
        state.serialize_field("operation", &self.operation)?;
        state.serialize_field("version", &self.version)?;
        state.serialize_field("result", &self.result)?;
        state.end()
    }
}

// Borrowed wire adapters keep descriptor tags and member order explicit.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum FieldTag<'a> {
    Ref {
        model: &'a str,
        #[serde(rename = "requireVersion", skip_serializing_if = "Option::is_none")]
        require_version: Option<bool>,
    },
    String,
    Integer,
    Decimal,
    Money,
    Datetime,
    Boolean,
    File,
    Enum {
        values: &'a [String],
    },
    Date,
    Duration,
    Secret,
    User,
    Member,
    Json,
    Bytes,
    Other {
        #[serde(rename = "type")]
        type_id: &'a str,
    },
}

impl Serialize for JsMcpField {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let tag = match self {
            Self::Ref {
                model,
                require_version,
            } => FieldTag::Ref {
                model,
                require_version: Some(*require_version),
            },
            Self::String => FieldTag::String,
            Self::Integer => FieldTag::Integer,
            Self::Decimal => FieldTag::Decimal,
            Self::Money => FieldTag::Money,
            Self::Datetime => FieldTag::Datetime,
            Self::Duration => FieldTag::Duration,
            Self::User => FieldTag::User,
            Self::Boolean => FieldTag::Boolean,
            Self::File => FieldTag::File,
            Self::Enum { values } => FieldTag::Enum { values },
            Self::Delivery(value) => return value.serialize(serializer),
        };
        tag.serialize(serializer)
    }
}

impl Serialize for JsModelFieldType {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let tag = match self {
            Self::Ref { model } => FieldTag::Ref {
                model,
                require_version: None,
            },
            Self::String => FieldTag::String,
            Self::Integer => FieldTag::Integer,
            Self::Decimal => FieldTag::Decimal,
            Self::Money => FieldTag::Money,
            Self::Datetime => FieldTag::Datetime,
            Self::Boolean => FieldTag::Boolean,
            Self::File => FieldTag::File,
            Self::Enum { values } => FieldTag::Enum { values },
            Self::Date => FieldTag::Date,
            Self::Duration => FieldTag::Duration,
            Self::Secret => FieldTag::Secret,
            Self::User => FieldTag::User,
            Self::Member => FieldTag::Member,
            Self::Json => FieldTag::Json,
            Self::Bytes => FieldTag::Bytes,
            Self::Other { type_id } => FieldTag::Other { type_id },
            Self::Delivery(value) => return value.serialize(serializer),
        };
        tag.serialize(serializer)
    }
}

impl Serialize for JsFieldDefault {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(tag = "kind", rename_all = "lowercase")]
        enum DefaultWire<'a> {
            Literal {
                value: &'a serde_json::value::RawValue,
            },
            Parent {
                path: &'a str,
            },
            Server {
                init: JsServerInit,
            },
            Derived,
        }
        match self {
            Self::Literal(json) => {
                let raw = serde_json::from_str::<&serde_json::value::RawValue>(json)
                    .map_err(serde::ser::Error::custom)?;
                DefaultWire::Literal { value: raw }.serialize(serializer)
            }
            Self::Parent { path } => DefaultWire::Parent { path }.serialize(serializer),
            Self::Server(init) => DefaultWire::Server { init: *init }.serialize(serializer),
            Self::Derived => DefaultWire::Derived.serialize(serializer),
        }
    }
}

#[derive(Serialize)]
struct ArrayMarker {
    required: bool,
}

impl Serialize for JsOperationField {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct(
            "OperationField",
            3 + usize::from(self.nullable)
                + usize::from(self.value_type.is_some())
                + usize::from(self.array_required.is_some())
                + usize::from(self.default.is_some())
                + usize::from(self.description.is_some()),
        )?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("field", &self.field)?;
        if let Some(value_type) = self.value_type {
            state.serialize_field("valueType", value_type)?;
        }
        state.serialize_field("required", &self.required)?;
        if self.nullable {
            state.serialize_field("nullable", &true)?;
        }
        if let Some(required) = self.array_required {
            state.serialize_field("array", &ArrayMarker { required })?;
        }
        if let Some(default) = &self.default {
            state.serialize_field("default", default)?;
        }
        if let Some(description) = &self.description {
            state.serialize_field("description", description)?;
        }
        state.end()
    }
}

impl Serialize for JsModelField {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct(
            "ModelField",
            4 + usize::from(self.nullable)
                + usize::from(self.value_type.is_some())
                + usize::from(self.array_required.is_some())
                + usize::from(self.default.is_some())
                + usize::from(self.description.is_some())
                + usize::from(self.machine.is_some()),
        )?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("field", &self.field)?;
        if let Some(value_type) = self.value_type {
            state.serialize_field("valueType", value_type)?;
        }
        state.serialize_field("required", &self.required)?;
        state.serialize_field("serverOnly", &self.server_only)?;
        if let Some(machine) = &self.machine {
            state.serialize_field("machine", machine)?;
        }
        if self.nullable {
            state.serialize_field("nullable", &true)?;
        }
        if let Some(required) = self.array_required {
            state.serialize_field("array", &ArrayMarker { required })?;
        }
        if let Some(default) = &self.default {
            state.serialize_field("default", default)?;
        }
        if let Some(description) = &self.description {
            state.serialize_field("description", description)?;
        }
        state.end()
    }
}

impl Serialize for JsOperation {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Inputs<'a> {
            fields: &'a [JsOperationField],
        }
        #[derive(Serialize)]
        struct ResultType {
            r#type: &'static str,
        }
        let mut state =
            serializer.serialize_struct("Operation", 4 + usize::from(self.result.is_some()))?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("kind", self.kind.as_str())?;
        state.serialize_field("description", &self.description)?;
        state.serialize_field(
            "inputs",
            &Inputs {
                fields: &self.inputs,
            },
        )?;
        if let Some(result) = self.result {
            state.serialize_field("result", &ResultType { r#type: result })?;
        }
        state.end()
    }
}

fn serialize_app_scope<S: Serializer>(_: &bool, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str("app")
}

/// Production modules plus link metadata.
#[derive(Debug, Clone)]
pub struct JsOutput {
    /// Program entrypoint module (first in the artifact).
    pub entry: JsModule,
    /// One module per non-entrypoint package, in source order.
    pub packages: Vec<JsModule>,
    /// `E6008` diagnostics for checked-but-unlowerable positions.
    pub diagnostics: Vec<Diagnostic>,
    /// Catalog builtins the lowering references (for `E6007` checks).
    pub referenced_builtins: Vec<ReferencedBuiltin>,
    /// Callable registry entries in source order.
    pub callables: Vec<JsCallable>,
    /// Page descriptors in source order.
    pub pages: Vec<JsPage>,
    /// User-invocable operation descriptors in source order (MCP P1).
    pub operations: Vec<JsOperation>,
    /// `@canlang/stdlib` imports used by the entrypoint.
    pub stdlib_imports: BTreeSet<String>,
    /// `@canlang/ui` imports used by the entrypoint.
    pub ui_imports: BTreeSet<String>,
}

/// Line-oriented writer attributing every emitted line to a source span.
#[derive(Debug, Default)]
pub struct JsWriter {
    buf: String,
    lines: Vec<JsLine>,
}

impl JsWriter {
    /// Create an empty writer.
    pub fn new() -> Self {
        Self::default()
    }

    /// Push one line attributed to `span` (and optionally `name`).
    pub fn push(&mut self, span: Span, name: Option<String>, text: &str) {
        self.buf.push_str(text);
        self.buf.push('\n');
        self.lines.push(JsLine {
            line: self.lines.len() as u32 + 1,
            span,
            name,
        });
    }

    /// Append another writer's lines, renumbering them.
    pub fn append(&mut self, other: &JsWriter) {
        self.buf.push_str(&other.buf);
        for line in &other.lines {
            self.lines.push(JsLine {
                line: self.lines.len() as u32 + 1,
                span: line.span,
                name: line.name.clone(),
            });
        }
    }

    /// Finish into a module.
    pub fn finish(&self, path: String) -> JsModule {
        JsModule {
            path,
            js: self.buf.clone(),
            lines: self.lines.clone(),
        }
    }
}

/// Lower an [`IrProgram`] to production JS modules.
///
/// Returns the entrypoint module, one module per non-entrypoint package,
/// `E6008` diagnostics and the link metadata the artifact assembly needs.
pub fn emit_program(ir: &IrProgram) -> JsOutput {
    let mut emitter = Emitter::new(ir);
    let entry_id = pick_entrypoint(ir);
    let entry_name = entry_id
        .map(|id| ir.module(id).name.clone())
        .unwrap_or_else(|| "index".to_string());
    let entry_span = entry_id.map(|id| ir.module(id).span).unwrap_or(Span::new(
        crate::source::SourceId(0),
        0,
        0,
    ));
    let mut body = JsWriter::new();
    // Operation descriptors derive once, up front: the `canApp()`
    // registry and the artifact envelope share them verbatim.
    let operations = emitter.collect_operations();
    emitter.emit_identity_consts(&mut body, entry_id);
    for module in &ir.modules {
        for page in &module.pages {
            emitter.lower_page(page, &mut body);
        }
    }
    emitter.emit_app_definition(&mut body, entry_id);
    emitter.emit_derive_fns(&mut body);
    emitter.emit_can_app(&mut body, entry_id, &operations);
    let mut out = JsWriter::new();
    out.push(
        entry_span,
        None,
        &format!("// Generated by can compile from {entry_name}; do not edit."),
    );
    for line in emitter.import_lines() {
        out.push(entry_span, None, &line);
    }
    for line in emitter.support_lines() {
        out.push(entry_span, None, &line);
    }
    out.append(&body);
    let entry = out.finish(module_path(&entry_name));
    let stdlib_imports = emitter.stdlib.clone();
    let ui_imports = emitter.ui.clone();

    let mut packages = Vec::new();
    for module in &ir.modules {
        if Some(module.id) == entry_id {
            continue;
        }
        packages.push(emitter.emit_package_module(module.id));
    }
    let (diagnostics, referenced_builtins, callables, pages) = emitter.finish();
    JsOutput {
        entry,
        packages,
        diagnostics,
        referenced_builtins,
        callables,
        pages,
        operations,
        stdlib_imports,
        ui_imports,
    }
}

/// Pick the entrypoint: first composed app, else first implicit app, else
/// first package, else none.
fn pick_entrypoint(ir: &IrProgram) -> Option<crate::analysis::resolve::ModuleId> {
    ir.modules
        .iter()
        .find(|m| m.kind == ModuleKind::ComposedApp)
        .or_else(|| {
            ir.modules
                .iter()
                .find(|m| m.kind == ModuleKind::ImplicitApp)
        })
        .or_else(|| ir.modules.first())
        .map(|m| m.id)
}

/// Portable, injective owning-module path; consumers use artifact paths.
fn module_path(name: &str) -> String {
    format!("{}.mjs", binding_ident("m", name))
}

/// Injective implementation identity, disjoint from ambient imports/context/temps.
/// UTF-8 hex preserves every source spelling without JS reserved-word assumptions.
pub(super) fn binding_ident(domain: &str, identity: &str) -> String {
    let encoded: String = identity.bytes().map(|byte| format!("{byte:02x}")).collect();
    format!("$can${domain}${encoded}")
}

fn page_binding(page: &IrPage, kind: &str) -> String {
    binding_ident("p", &format!("{}:{kind}:{}", page.owner, page.path))
}

/// Quote string values through the shared byte-compatible JSON adapter.
/// Expressions, identifiers and HTML embedding have separate owners.
pub(super) fn js_string(value: &str) -> String {
    crate::json::to_compact_string(value).expect("JS string JSON serialization invariant")
}

/// Lowercase server factories allowed in UI positions (oracle corpus).
fn is_ui_factory(factory: &str) -> bool {
    matches!(
        factory,
        "action"
            | "actions"
            | "alert"
            | "badge"
            | "breadcrumbs"
            | "button"
            | "card"
            | "chatBubble"
            | "content"
            | "copy"
            | "deleteRecord"
            | "details"
            | "divider"
            | "edit"
            | "fab"
            | "fieldset"
            | "form"
            | "history"
            | "input"
            | "join"
            | "list"
            | "metrics"
            | "modal"
            | "pagination"
            | "radio"
            | "select"
            | "slot"
            | "stat"
            | "tab"
            | "table"
            | "tabs"
            | "text"
            | "textarea"
            | "title"
    )
}

/// One page `form` usage collected for the `forms` member.
struct FormUsage {
    page: String,
    operation: String,
    fields: Vec<String>,
    display: Option<String>,
}

/// Static text of a form prop, when the prop lowers to one.
fn form_prop_text(node: &IrUi, name: &str) -> Option<String> {
    node.props.iter().find_map(|(key, value)| {
        if key != name {
            return None;
        }
        match &value.expr {
            IrExpr::Text(text) => Some(text.clone()),
            _ => None,
        }
    })
}

/// Static field names of a form prop, when the prop lowers to a text array.
fn form_prop_fields(node: &IrUi, name: &str) -> Vec<String> {
    node.props
        .iter()
        .find(|(key, _)| key == name)
        .and_then(|(_, value)| match &value.expr {
            IrExpr::Array(items) => Some(
                items
                    .iter()
                    .filter_map(|item| match &item.expr {
                        IrExpr::Text(text) => Some(text.clone()),
                        _ => None,
                    })
                    .collect(),
            ),
            _ => None,
        })
        .unwrap_or_default()
}

/// Collect `form` factory nodes in source order. Forms without a resolved
/// `operation` prop are skipped (loud in the page lowering already).
fn collect_form_usages(node: &IrUi, page: &str, out: &mut Vec<FormUsage>) {
    if node.factory == "form"
        && let Some(operation) = form_prop_text(node, "operation")
    {
        out.push(FormUsage {
            page: page.to_string(),
            operation,
            fields: form_prop_fields(node, "fields"),
            display: form_prop_text(node, "display"),
        });
    }
    for child in &node.children {
        collect_form_usages(child, page, out);
    }
}

/// Writable selector controls currently admitted by the source lowering.
fn is_form_field_control(factory: &str) -> bool {
    matches!(factory, "input" | "textarea" | "radio" | "select")
}

/// Collect actual controls owned by this form, preserving authored traversal.
/// Nested forms establish their own binding; collections end inherited ownership.
fn collect_authored_form_fields(node: &IrUi, out: &mut Vec<String>) {
    if node.factory == "form" || node.row_scope.is_some() {
        return;
    }
    if is_form_field_control(&node.factory)
        && let Some(path) = form_prop_text(node, "field")
    {
        out.push(path);
    }
    for child in &node.children {
        collect_authored_form_fields(child, out);
    }
}

/// Render one admission gate as manifest spellings: direct role gates
/// list their spelling; anything else (subject/expression/compound
/// gates) sets `gated` so the manifest marks enforcement without
/// inventing a spelling. Total and silent by design.
fn guard_spellings(by: &[IrGuard]) -> (Vec<String>, bool) {
    let mut spellings = Vec::new();
    let mut gated = false;
    for guard in by {
        match guard {
            IrGuard::Role(id) => spellings.push(id.clone()),
            _ => gated = true,
        }
    }
    (spellings, gated)
}

/// A read grant may expose the same actor role identity as operation
/// admission only when its entire checked predicate is that role gate.
/// Row filters, subject gates and expression rules retain registry-only
/// metadata, so consumers cannot silently drop part of the predicate.
fn actor_read_role(predicate: &TypedExpr) -> Option<&str> {
    match &predicate.expr {
        IrExpr::HasRole { role, person: None } => Some(role),
        _ => None,
    }
}

/// One `policy.operations` entry: role-gate spellings, `require` count,
/// crud `when` presence, and the `gated` marker. `None` when the
/// operation carries no admission content at all.
fn operation_policy_entry(
    spellings: &[String],
    gated: bool,
    requires: usize,
    has_when: bool,
) -> Option<String> {
    if spellings.is_empty() && !gated && requires == 0 && !has_when {
        return None;
    }
    let mut members = Vec::new();
    if !spellings.is_empty() {
        let list = spellings
            .iter()
            .map(|s| js_string(s))
            .collect::<Vec<_>>()
            .join(",");
        members.push(format!("by:[{list}]"));
    }
    if requires > 0 {
        members.push(format!("requires:{requires}"));
    }
    if has_when {
        members.push("when:true".to_string());
    }
    if gated {
        members.push("gated:true".to_string());
    }
    Some(format!("{{{}}}", members.join(",")))
}

// These private markers are never emitted. Binary-family validation and
// import/diagnostic effects run once, before deciding whether operands are
// needed; filling the resulting fragment happens after ordered traversal.
// Source string controls are escaped by js_string, so they cannot collide.
const BINARY_LEFT: &str = "\0binary-left\0";
const BINARY_RIGHT: &str = "\0binary-right\0";

fn fill_binary_template(template: String, left: &str, right: &str) -> String {
    template
        .replace(BINARY_LEFT, left)
        .replace(BINARY_RIGHT, right)
}

/// Emission context: import tracking, diagnostics and link metadata.
pub struct Emitter<'a> {
    ir: &'a IrProgram,
    by_canonical: HashMap<String, usize>,
    stdlib: BTreeSet<String>,
    ui: BTreeSet<String>,
    relative: BTreeMap<String, BTreeSet<String>>,
    diags: Vec<Diagnostic>,
    builtins: Vec<ReferencedBuiltin>,
    callables: Vec<JsCallable>,
    pages: Vec<JsPage>,
    /// Hook lowering state while emitting one hook run function (T31):
    /// `Some` exactly between [`Emitter::enter_hook`] and
    /// [`Emitter::exit_hook`]. Statements and expressions consult it to
    /// stage through the hook context instead of the ambient `c`.
    hook: Option<HookState>,
    /// Bounded-loop sequence: each `for ... limit` binds its own
    /// `$forRowsN` fetch, so sequential loops never redeclare one
    /// binding (source order keeps numbering deterministic).
    loop_seq: usize,
    /// Lexical declaration owners; references resolve inward, like Can scopes.
    bindings: Vec<HashMap<String, String>>,
    binding_seq: usize,
    localized_format: bool,
    formatted_bindings: Vec<HashMap<String, bool>>,
    formatted_derives: BTreeSet<String>,
}

/// Hook lowering state: the trigger model. (The staged-id counter lives
/// in the emitted run function itself as `$stagedNext`, resetting per
/// trigger invocation, so the emitter keeps no counter.)
struct HookState {
    /// Trigger model symbol (same-model backstop inside lowering).
    trigger: SymbolId,
}

impl<'a> Emitter<'a> {
    /// Create an emitter over `ir`.
    pub fn new(ir: &'a IrProgram) -> Self {
        let by_canonical = ir
            .items
            .iter()
            .enumerate()
            .map(|(i, item)| (item.canonical.clone(), i))
            .collect();
        let mut emitter = Self {
            ir,
            by_canonical,
            stdlib: BTreeSet::new(),
            ui: BTreeSet::new(),
            relative: BTreeMap::new(),
            diags: Vec::new(),
            builtins: Vec::new(),
            callables: Vec::new(),
            pages: Vec::new(),
            hook: None,
            loop_seq: 0,
            bindings: vec![HashMap::new()],
            binding_seq: 0,
            localized_format: false,
            formatted_bindings: vec![HashMap::new()],
            formatted_derives: BTreeSet::new(),
        };
        // Derive outputs retain presentation provenance across shared calls,
        // including wrappers declared before the formatting owner.
        loop {
            let owners: Vec<_> = ir
                .items
                .iter()
                .filter_map(|item| match &item.kind {
                    IrItemKind::DeriveFn {
                        expr: Some(expr), ..
                    } if emitter.expr_formatted(expr) => Some(item.canonical.clone()),
                    _ => None,
                })
                .collect();
            let before = emitter.formatted_derives.len();
            emitter.formatted_derives.extend(owners);
            if emitter.formatted_derives.len() == before {
                break;
            }
        }
        emitter
    }

    fn enter_scope(&mut self) {
        self.bindings.push(HashMap::new());
        self.formatted_bindings.push(HashMap::new());
    }

    fn exit_scope(&mut self) {
        self.bindings.pop().expect("lexical scope");
        self.formatted_bindings.pop().expect("lexical scope");
    }

    fn bind(&mut self, name: &str) -> String {
        self.formatted_bindings
            .last_mut()
            .expect("lexical scope")
            .insert(name.to_string(), false);
        let emitted = binding_ident("l", &format!("{}:{name}", self.binding_seq));
        self.binding_seq += 1;
        self.bindings
            .last_mut()
            .expect("lexical scope")
            .insert(name.to_string(), emitted.clone());
        emitted
    }

    fn reference(&self, name: &str) -> String {
        self.bindings
            .iter()
            .rev()
            .find_map(|scope| scope.get(name))
            .cloned()
            // Ambient IR names (c, row, s, b) belong to the calling closure.
            .unwrap_or_else(|| name.to_string())
    }

    /// Conservative presentation provenance, separate from the current
    /// scalar result type. No consumer may erase it through a shared derive,
    /// aggregate, or local alias before presentation sink contracts exist.
    fn expr_formatted(&self, expr: &TypedExpr) -> bool {
        enum Work<'e> {
            Visit(&'e TypedExpr),
            Bind(&'e str),
            Restore(&'e str),
        }
        use Work::{Bind, Restore, Visit};
        let mut pending = vec![Visit(expr)];
        let mut hidden: HashMap<&str, usize> = HashMap::new();
        while let Some(work) = pending.pop() {
            let expr = match work {
                Bind(name) => {
                    *hidden.entry(name).or_default() += 1;
                    continue;
                }
                Restore(name) => {
                    let count = hidden.get_mut(name).expect("presentation binder scope");
                    *count -= 1;
                    if *count == 0 {
                        hidden.remove(name);
                    }
                    continue;
                }
                Visit(expr) => expr,
            };
            match &expr.expr {
                IrExpr::Format { .. } => return true,
                IrExpr::Name(name) => {
                    if !hidden.contains_key(name.as_str())
                        && self
                            .formatted_bindings
                            .iter()
                            .rev()
                            .find_map(|scope| scope.get(name))
                            .copied()
                            .unwrap_or(false)
                    {
                        return true;
                    }
                }
                IrExpr::Member { base, .. } => pending.push(Visit(base)),
                IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                    if matches!(target, IrCallTarget::DeriveFn(id) if self.formatted_derives.contains(id))
                    {
                        return true;
                    }
                    pending.extend(args.iter().map(Visit));
                }
                IrExpr::Binary { left, right, .. } => {
                    pending.push(Visit(left));
                    pending.push(Visit(right));
                }
                IrExpr::Unary { operand, .. } => pending.push(Visit(operand)),
                IrExpr::Array(items) => pending.extend(items.iter().map(Visit)),
                IrExpr::Object(entries) => {
                    pending.extend(entries.iter().map(|(_, value)| Visit(value)))
                }
                IrExpr::Query(query) => {
                    let alias = match &query.domain {
                        crate::codegen::ir::IrQueryDomain::Value { base, alias } => {
                            pending.push(Visit(base));
                            alias.as_str()
                        }
                        crate::codegen::ir::IrQueryDomain::Model(_) => "row",
                    };
                    for value in [&query.parent, &query.limit, &query.archived]
                        .into_iter()
                        .flatten()
                    {
                        pending.push(Visit(value));
                    }
                    if let Some(value) = &query.where_pred {
                        pending.push(Restore(alias));
                        pending.push(Visit(value));
                        pending.push(Bind(alias));
                    }
                    if let Some(value) = &query.select {
                        if let Some(param) = &query.select_param {
                            pending.push(Restore(param));
                            pending.push(Visit(value));
                            pending.push(Bind(param));
                        } else {
                            pending.push(Visit(value));
                        }
                    }
                }
                IrExpr::DeliveryRead { record, .. } => pending.push(Visit(record)),
                IrExpr::Message(message) => {
                    pending.extend(message.params.iter().map(|param| Visit(&param.value)))
                }
                IrExpr::MessageCall {
                    descriptor,
                    args,
                    params,
                } => {
                    pending.extend(descriptor.params.iter().map(|param| Visit(&param.value)));
                    pending.extend(args.iter().map(Visit));
                    pending.extend(
                        params
                            .iter()
                            .filter_map(|param| param.default.as_ref())
                            .map(Visit),
                    );
                }
                IrExpr::HasRole {
                    person: Some(person),
                    ..
                } => pending.push(Visit(person)),
                IrExpr::Lambda { param, body } => {
                    pending.push(Restore(param));
                    pending.push(Visit(body));
                    pending.push(Bind(param));
                }
                _ => {}
            }
        }
        false
    }

    fn formatted_refusal(&mut self, sink: &str, span: Span) -> String {
        self.unsupported(sink,
            "localized formatting is presentation-only; this consumer has no admitted presentation sink contract",
            span);
        self.throw_expr("localized formatting has no lowering at this consumer")
    }

    fn lower_business_expr(&mut self, expr: &TypedExpr, sink: &str) -> String {
        if self.expr_formatted(expr) {
            self.formatted_refusal(sink, expr.span)
        } else {
            self.lower_expr(expr)
        }
    }

    /// Enter hook lowering for one trigger model: statements stage through
    /// `$hookCtx` and ambient-context expressions report `E6008`.
    pub fn enter_hook(&mut self, trigger: SymbolId) {
        self.hook = Some(HookState { trigger });
    }

    /// Leave hook lowering, restoring scenario lowering.
    pub fn exit_hook(&mut self) {
        self.hook = None;
    }

    /// Drain diagnostics, builtin references, callables and pages.
    pub fn finish(
        self,
    ) -> (
        Vec<Diagnostic>,
        Vec<ReferencedBuiltin>,
        Vec<JsCallable>,
        Vec<JsPage>,
    ) {
        (self.diags, self.builtins, self.callables, self.pages)
    }

    /// Record an `E6008` for a checked-but-unlowerable position.
    fn unsupported(&mut self, what: &str, why: &str, span: Span) {
        self.diags.push(Diagnostic::error(
            "E6008",
            format!("cannot lower {what}: {why}"),
            span,
        ));
    }

    /// Throwing expression placeholder: keeps the module parseable while
    /// failing loudly at runtime.
    fn throw_expr(&self, message: &str) -> String {
        format!("(() => {{ throw new Error({}); }})()", js_string(message))
    }

    /// Whether hook lowering is active.
    fn in_hook(&self) -> bool {
        self.hook.is_some()
    }

    /// Hook-context gap: `what` needs the ambient operation context, which
    /// hooks never receive. Reports `E6008` and returns the throwing
    /// placeholder.
    fn hook_gap(&mut self, what: &str, why: &str, span: Span) -> String {
        self.unsupported(what, why, span);
        self.throw_expr(&format!("{what} has no lowering"))
    }

    /// Import lines in deterministic order: stdlib, UI, then relative
    /// owning-package modules. Shared by production and test modules:
    /// production modules never import from `tests/`.
    pub fn import_lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        if !self.stdlib.is_empty() {
            let mut names: Vec<&str> = self.stdlib.iter().map(String::as_str).collect();
            names.sort_unstable();
            let rendered: Vec<String> = names
                .iter()
                .map(|n| {
                    if *n == "check" {
                        "require as check".to_string()
                    } else {
                        (*n).to_string()
                    }
                })
                .collect();
            lines.push(format!(
                "import {{ {} }} from \"@canlang/stdlib\";",
                rendered.join(", ")
            ));
        }
        if !self.ui.is_empty() {
            let mut names: Vec<&str> = self.ui.iter().map(String::as_str).collect();
            names.sort_unstable();
            lines.push(format!(
                "import {{ {} }} from \"@canlang/ui\";",
                names
                    .iter()
                    .map(|name| format!("{name} as {}", binding_ident("u", name)))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        for (path, names) in &self.relative {
            lines.push(format!(
                "import {{ {} }} from {};",
                names.iter().cloned().collect::<Vec<_>>().join(", "),
                js_string(path)
            ));
        }
        lines
    }

    /// Shared generated adapters for owning runtime contracts. Keep this
    /// separate from imports so test-only modules use the same adapter.
    pub fn support_lines(&self) -> Vec<String> {
        if !self.localized_format {
            return Vec::new();
        }
        vec![format!(
            "function {}(c,d,locale,sourceLang,signature){{\n\
             if(typeof c?.formatting?.appDefault!==\"string\")throw new ValueError(\"invalid-construction\",\"message formatting requires checked selected-app scope\");\n\
             const timeZone=c.team===null?\"UTC\":c.team?.timezone;\n\
             if(typeof timeZone!==\"string\")throw new ValueError(\"invalid-construction\",\"message formatting requires admitted team timezone\");\n\
             if(typeof d!==\"object\"||d===null)throw new ValueError(\"invalid-construction\",\"message formatting requires a descriptor\");\n\
             const params=Object.create(null);\n\
             for(const [name,canonical,type] of signature){{const p=d.params?.[name];if(p?.type!==canonical)throw new ValueError(\"invalid-construction\",\"message parameter differs from checked signature: \"+name);params[name]={{type,value:p.value}};}}\n\
             if(Object.keys(d.params??{{}}).length!==signature.length)throw new ValueError(\"invalid-construction\",\"message parameters differ from checked signature\");\n\
             return format(makeMessageDescriptor(d.source,d.variants,signature.length?params:undefined),{{locale,appDefault:c.formatting.appDefault,sourceLang,timeZone}});\n\
             }}",
            binding_ident("h", "localized_format")
        )]
    }

    /// Canonical type id for a resolved type (`int`, `user?`, `text[]`,
    /// `expense.Expense.status`, ...). A scalar field resolves to its scalar
    /// type, never a field-specific nominal; nullable/array shape is kept.
    pub fn canonical_type_id(&mut self, ty: &ResolvedType, span: Span) -> String {
        match ty {
            ResolvedType::Error => {
                self.unsupported("type", "poisoned by an analysis error", span);
                self.throw_expr("poisoned type")
            }
            ResolvedType::Unknown => {
                self.unsupported("type", "unknown element type has no §13 type id", span);
                self.throw_expr("unknown type id")
            }
            ResolvedType::Null => "null".to_string(),
            ResolvedType::Scalar(scalar) => scalar.as_str().to_string(),
            ResolvedType::Team => "Team".to_string(),
            ResolvedType::OperationContext => "OperationContext".to_string(),
            ResolvedType::Enum {
                owner: Some(id), ..
            } => self.ir.items[id.0 as usize].canonical.clone(),
            ResolvedType::Enum { owner: None, .. } => {
                self.unsupported("type", "ownerless enum has no §13 type id", span);
                self.throw_expr("ownerless enum type id")
            }
            ResolvedType::Record { symbol, .. }
            | ResolvedType::Message(symbol)
            | ResolvedType::Operation(symbol) => self.ir.items[symbol.0 as usize].canonical.clone(),
            ResolvedType::Action { .. } => {
                self.unsupported("type", "action values have no §13 type id", span);
                self.throw_expr("action type id")
            }
            ResolvedType::Invocation { targets } => format!(
                "invocation({})",
                targets
                    .iter()
                    .map(|symbol| self.ir.items[symbol.0 as usize].canonical.clone())
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            ResolvedType::Delivery { .. } => {
                self.unsupported(
                    "type",
                    "delivery values have no §13 structural type id",
                    span,
                );
                self.throw_expr("delivery type id")
            }
            // T14c: typed `std` receipts have no §13 type id either;
            // fail closed exactly like bound deliveries.
            ResolvedType::StdDelivery { .. } => {
                self.unsupported(
                    "type",
                    "std delivery values have no §13 structural type id",
                    span,
                );
                self.throw_expr("std delivery type id")
            }
            ResolvedType::Array { element, .. } => {
                format!("{}[]", self.canonical_type_id(element, span))
            }
            ResolvedType::Nullable(inner) => {
                format!("{}?", self.canonical_type_id(inner, span))
            }
            ResolvedType::Union(arms) => arms
                .iter()
                .map(|id| self.ir.items[id.0 as usize].canonical.clone())
                .collect::<Vec<_>>()
                .join("|"),
            ResolvedType::Object(_) => {
                self.unsupported("type", "object values have no §13 type id", span);
                self.throw_expr("object type id")
            }
            ResolvedType::Opaque(_) => {
                self.unsupported("type", "opaque deferred type has no §13 type id", span);
                self.throw_expr("opaque type id")
            }
        }
    }

    /// Field schema object for a resolved type: base `type` plus `array`,
    /// `nullable` or `requiredArray` only for actual differences, `cases`
    /// for enums, `operation` for delivery fields.
    ///
    /// T09: the omission marker defaults to ordinary here. This entry
    /// point serves positions that never carry the field-only `!`
    /// (results, derived fields, parameters), so arrays emit a bare
    /// `array:true`; stored-field emission passes its own marker via
    /// [`Emitter::field_schema_marked`].
    pub fn field_schema(&mut self, ty: &ResolvedType, span: Span) -> String {
        self.field_schema_marked(ty, false, span)
    }

    /// Field schema object with an explicit T09 omission marker: a
    /// non-null array emits `requiredArray:true` exactly when
    /// `required_array` (the `!` spelling) is set; an ordinary array
    /// emits a bare `array:true` (omitted values evaluate to an
    /// equal-empty array). Nullable arrays always emit `nullable:true`
    /// without `requiredArray` (nullability wins; GRAMMAR L192 forbids
    /// `!` beside `?`, so the marker never arrives set there).
    pub fn field_schema_marked(
        &mut self,
        ty: &ResolvedType,
        required_array: bool,
        span: Span,
    ) -> String {
        format!("{{{}}}", self.field_schema_object(ty, required_array, span))
    }

    /// Base schema members for an array element (scalar, record or enum).
    fn array_element_schema(&mut self, element: &ResolvedType, span: Span) -> String {
        match element {
            ResolvedType::Scalar(scalar) => format!("type:{}", js_string(scalar.as_str())),
            ResolvedType::Record { symbol, .. } => format!(
                "type:{}",
                js_string(&self.ir.items[symbol.0 as usize].canonical.clone())
            ),
            ResolvedType::Enum { cases, .. } => format!(
                "type:\"enum\",cases:[{}]",
                cases
                    .iter()
                    .map(|c| js_string(c))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            other => {
                let id = self.canonical_type_id(other, span);
                self.unsupported(
                    "array element type",
                    &format!("{id} has no §13 array-element lowering"),
                    span,
                );
                format!("type:{}", js_string(&id))
            }
        }
    }

    /// Inner schema members without the nullable wrapper. T09:
    /// `required_array` is the field-only `!` marker (never
    /// nullability); only non-null arrays consult it.
    fn field_schema_object(
        &mut self,
        ty: &ResolvedType,
        required_array: bool,
        span: Span,
    ) -> String {
        // The implemented Values FieldDescriptor owns shape in its canonical
        // type string. Invocation has no legacy structural descriptor keys.
        if invocation_base(ty) {
            let mut id = self.canonical_type_id(ty, span);
            if required_array && matches!(ty, ResolvedType::Array { .. }) {
                id.push('!');
            }
            return format!("type:{}", js_string(&id));
        }
        match ty {
            ResolvedType::Scalar(scalar) => format!("type:{}", js_string(scalar.as_str())),
            ResolvedType::Record { symbol, .. } => format!(
                "type:{}",
                js_string(&self.ir.items[symbol.0 as usize].canonical.clone())
            ),
            ResolvedType::Enum { cases, .. } => format!(
                "type:\"enum\",cases:[{}]",
                cases
                    .iter()
                    .map(|c| js_string(c))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            ResolvedType::Array { element, .. } => {
                let element = element.as_ref().clone();
                let base = self.array_element_schema(&element, span);
                if required_array {
                    format!("{base},array:true,requiredArray:true")
                } else {
                    format!("{base},array:true")
                }
            }
            ResolvedType::Delivery { op } => format!(
                "type:\"delivery\",operation:{}",
                js_string(&self.ir.items[op.0 as usize].canonical.clone())
            ),
            ResolvedType::Nullable(inner) => match inner.as_ref() {
                // Nullable arrays omit `requiredArray`: nullability wins
                // (an omitted `T[]?` yields null), and GRAMMAR L192
                // forbids `!` beside `?`, so the marker never applies
                // here even if one arrives set.
                ResolvedType::Array { element, .. } => {
                    let base = self.array_element_schema(element, span);
                    format!("{base},array:true,nullable:true")
                }
                _ => {
                    let mut inner_schema = self.field_schema_object(inner, false, span);
                    inner_schema.push_str(",nullable:true");
                    inner_schema
                }
            },
            ResolvedType::Action {
                targets, external, ..
            } => {
                // `{type:"action",targets:[canonical...]}` per the
                // CanBoard/CanMaintain draft contract field schemas.
                // Locals keep source order, then externals (mixed
                // interleavings are not preserved).
                let mut names: Vec<String> = targets
                    .iter()
                    .map(|s| self.ir.items[s.0 as usize].canonical.clone())
                    .collect();
                names.extend(external.iter().cloned());
                format!(
                    "type:\"action\",targets:[{}]",
                    names
                        .iter()
                        .map(|n| js_string(n))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            }
            other => {
                let id = self.canonical_type_id(other, span);
                self.unsupported(
                    "field type",
                    &format!("{id} has no §13 field-schema lowering"),
                    span,
                );
                format!("type:{}", js_string(&id))
            }
        }
    }

    /// Lower a checked expression to JavaScript.
    ///
    /// Scalar dispatch follows §13 exactly: one import name per operation,
    /// comparators returning -1/0/1 compared against zero, BigInt exact
    /// integers/durations, `int64` checked arithmetic, `same` reference
    /// identity and `equalValue(canonicalTypeId, a, b)` structural
    /// equality. Unlowerable combinations are `E6008` plus a throwing
    /// placeholder.
    pub fn lower_expr(&mut self, expr: &TypedExpr) -> String {
        let span = expr.span;
        let forbidden = match &expr.expr {
            IrExpr::Member { .. } => Some("formatted member access"),
            IrExpr::Binary { .. } | IrExpr::Unary { .. } => Some("formatted scalar operation"),
            IrExpr::Query(_) => Some("formatted business query"),
            IrExpr::DeliveryRead { .. } | IrExpr::HasRole { .. } => Some("formatted identity"),
            IrExpr::Lambda { .. } => Some("formatted predicate"),
            IrExpr::Message(_) | IrExpr::MessageCall { .. } => Some("formatted message parameter"),
            _ => None,
        };
        if let Some(sink) = forbidden
            && self.expr_formatted(expr)
        {
            return self.formatted_refusal(sink, span);
        }
        if let IrExpr::Format { args, .. } = &expr.expr
            && args.iter().any(|arg| self.expr_formatted(arg))
        {
            return self.formatted_refusal("formatted formatting argument", span);
        }
        match &expr.expr {
            IrExpr::Int(value) if scalar_family(&expr.ty) == Some(ScalarFamily::Decimal) => {
                self.stdlib.insert("parseDecimal".to_string());
                format!("parseDecimal({})", js_string(&value.to_string()))
            }
            IrExpr::Int(value) => format!("{value}n"),
            IrExpr::Decimal(spelling) => {
                // Construct directly from source spelling: wire encoding normalizes scale.
                self.stdlib.insert("parseDecimal".to_string());
                format!("parseDecimal({})", js_string(spelling))
            }
            IrExpr::Text(value) => js_string(value),
            IrExpr::Bool(value) => value.to_string(),
            IrExpr::Null => "null".to_string(),
            IrExpr::Money { minor, currency } => {
                self.stdlib.insert("money".to_string());
                format!("money({minor}n,{})", js_string(currency))
            }
            IrExpr::DurationMs(ms) => format!("{ms}n"),
            IrExpr::Date(value) => {
                self.stdlib.insert("date".to_string());
                format!("date({})", js_string(value))
            }
            IrExpr::Datetime(value) => {
                self.stdlib.insert("datetime".to_string());
                format!("datetime({})", js_string(value))
            }
            IrExpr::Name(name) => self.reference(name),
            IrExpr::Member { base, field } => {
                // IR context reads synthesize an unknown-typed `c` base.
                // A source parameter named c owns a different, checked value.
                let ambient = matches!(&base.expr, IrExpr::Name(name) if name == "c")
                    && matches!(base.ty, ResolvedType::Unknown)
                    && matches!(field.as_str(), "actor" | "now" | "team" | "operation");
                let base_text = if ambient {
                    "c".to_string()
                } else {
                    self.lower_expr(base)
                };
                let base_text = parenthesize_operand(&base_text, &base.expr);
                // Nullable bases use optional chaining (delivery reads
                // resolve to one immutable object or null).
                let op = if matches!(base.ty, ResolvedType::Nullable(_)) {
                    "?."
                } else {
                    "."
                };
                if object_key(field) == *field {
                    format!("{base_text}{op}{field}")
                } else {
                    let optional = if op == "?." { "?." } else { "" };
                    format!("{base_text}{optional}[{}]", js_string(field))
                }
            }
            IrExpr::Call { target, args } => self.lower_call(target, args, span),
            IrExpr::BoundCall {
                target,
                args,
                slots,
            } => self.lower_bound_call(target, args, slots, span),
            IrExpr::Binary { .. } => self.lower_binary_tree(expr),
            IrExpr::Unary { op, operand } => self.lower_unary(*op, operand, span),
            IrExpr::Array(items) => {
                let parts: Vec<String> = items.iter().map(|i| self.lower_expr(i)).collect();
                format!("[{}]", parts.join(","))
            }
            IrExpr::Object(entries) => {
                let parts: Vec<String> = entries
                    .iter()
                    .map(|(k, v)| {
                        let value = self.lower_expr(v);
                        if object_key(k) == *k && value == *k {
                            k.clone()
                        } else {
                            format!("{}:{value}", object_key(k))
                        }
                    })
                    .collect();
                format!("{{{}}}", parts.join(","))
            }
            IrExpr::Query(query) => {
                if self.in_hook() {
                    return self.hook_gap(
                        "hook query",
                        "hooks read event.after/event.before; queries have no hook lowering",
                        span,
                    );
                }
                self.lower_query(query, span)
            }
            IrExpr::DeliveryRead {
                record,
                field,
                props,
            } => {
                if self.in_hook() {
                    return self.hook_gap(
                        "hook delivery read",
                        "delivery reads need the ambient context, which hooks do not receive",
                        span,
                    );
                }
                self.stdlib.insert("delivery".to_string());
                let record_text = self.lower_expr(record);
                let props_text = props
                    .iter()
                    .map(|p| js_string(p))
                    .collect::<Vec<_>>()
                    .join(",");
                format!(
                    "await delivery(c,{{record:{record_text},field:{}}},[{props_text}])",
                    js_string(field)
                )
            }
            IrExpr::Message(message) => self.lower_message(message),
            IrExpr::MessageCall {
                descriptor,
                args,
                params,
            } => self.lower_message_call(descriptor, args, params),
            IrExpr::Format {
                args,
                descriptor_index,
                locale_index,
                source_lang,
                param_types,
            } => {
                if self.in_hook() {
                    return self.hook_gap(
                        "hook message format",
                        "message formatting needs the ambient context, which hooks do not receive",
                        span,
                    );
                }
                self.stdlib.insert("format".to_string());
                self.stdlib.insert("makeMessageDescriptor".to_string());
                self.stdlib.insert("ValueError".to_string());
                self.localized_format = true;
                let values: Vec<_> = args.iter().map(|arg| self.lower_expr(arg)).collect();
                let capture = binding_ident("a", &self.binding_seq.to_string());
                self.binding_seq += 1;
                let schema = param_types
                    .iter()
                    .map(|(name, canonical, presentation)| {
                        format!(
                            "[{},{},{}]",
                            js_string(name),
                            js_string(canonical),
                            js_string(presentation)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                format!(
                    "(({capture})=>{}(c,{capture}[{descriptor_index}],{capture}[{locale_index}],{},[{schema}]))([{}])",
                    binding_ident("h", "localized_format"),
                    js_string(source_lang),
                    values.join(",")
                )
            }
            IrExpr::HasRole { role, person } => {
                if self.in_hook() {
                    return self.hook_gap(
                        "hook role gate",
                        "role gates need the ambient context, which hooks do not receive",
                        span,
                    );
                }
                self.stdlib.insert("hasRole".to_string());
                match person {
                    Some(person) => {
                        let person_text = self.lower_expr(person);
                        format!("hasRole(c,{},{person_text})", js_string(role))
                    }
                    None => format!("hasRole(c,{})", js_string(role)),
                }
            }
            IrExpr::Lambda { param, body } => {
                self.enter_scope();
                let param = self.bind(param);
                let body_text = self.lower_expr(body);
                self.exit_scope();
                if expr_uses_async(body) {
                    format!("async({param})=>{body_text}")
                } else {
                    format!("({param})=>{body_text}")
                }
            }
            IrExpr::Unsupported { what, why } => {
                self.unsupported(what, why, span);
                self.throw_expr(&format!("{what} has no lowering"))
            }
        }
    }

    /// Lower a call: catalog builtins import from `@canlang/stdlib`
    /// (availability-checked at link time); capability operations import
    /// from their owning package module as `await op(c, ...)`.
    fn lower_call(&mut self, target: &IrCallTarget, args: &[TypedExpr], span: Span) -> String {
        if args.iter().any(|arg| self.expr_formatted(arg)) {
            return self.formatted_refusal("formatted call argument", span);
        }
        let parts: Vec<_> = args.iter().map(|arg| self.lower_expr(arg)).collect();
        self.lower_call_rendered(target, &parts, args.first().map(|arg| &arg.ty), span, true)
    }

    /// Source values evaluate left to right outside a synchronous capture.
    /// Await the target result outside that capture; reordering adds no Promise.
    fn lower_bound_call(
        &mut self,
        target: &IrCallTarget,
        args: &[TypedExpr],
        slots: &[Option<usize>],
        span: Span,
    ) -> String {
        if args.iter().any(|arg| self.expr_formatted(arg)) {
            return self.formatted_refusal("formatted call argument", span);
        }
        let values: Vec<_> = args.iter().map(|arg| self.lower_expr(arg)).collect();
        let capture = binding_ident("a", &self.binding_seq.to_string());
        self.binding_seq += 1;
        let ordered: Vec<_> = slots
            .iter()
            .map(|slot| match slot {
                Some(index) => format!("{capture}[{index}]"),
                None => "void 0".to_string(),
            })
            .collect();
        let domain_type = slots
            .first()
            .copied()
            .flatten()
            .and_then(|index| args.get(index))
            .map(|arg| &arg.ty);
        let call = self.lower_call_rendered(target, &ordered, domain_type, span, false);
        let awaited = matches!(
            target,
            IrCallTarget::Builtin { awaited: true, .. }
                | IrCallTarget::DeriveFn(_)
                | IrCallTarget::CapabilityOp(_)
        );
        format!(
            "{}(({capture})=>{call})([{}])",
            if awaited { "await " } else { "" },
            values.join(",")
        )
    }

    fn lower_call_rendered(
        &mut self,
        target: &IrCallTarget,
        parts: &[String],
        domain_type: Option<&ResolvedType>,
        span: Span,
        await_result: bool,
    ) -> String {
        match target {
            IrCallTarget::Builtin { id, awaited } => {
                let mut parts = parts.to_vec();
                if id == "sum" {
                    let element = match domain_type {
                        Some(ResolvedType::Array { element, .. }) => match element.as_ref() {
                            ResolvedType::Scalar(Scalar::Int) => Some("int"),
                            ResolvedType::Scalar(Scalar::Decimal) => Some("decimal"),
                            ResolvedType::Scalar(Scalar::Money) => Some("money"),
                            ResolvedType::Scalar(Scalar::Duration) => Some("duration"),
                            _ => None,
                        },
                        _ => None,
                    };
                    let Some(element) = element.filter(|_| !parts.is_empty()) else {
                        self.unsupported(
                            "sum domain",
                            "sum requires a checked int[], decimal[], money[], or duration[] domain",
                            span,
                        );
                        return self.throw_expr("sum domain has no static element lowering");
                    };
                    // Values requires a static element tag before the optional currency.
                    parts.insert(1, js_string(element));
                }
                self.stdlib.insert(id.clone());
                self.builtins.push(ReferencedBuiltin {
                    id: id.clone(),
                    span,
                });
                let call = format!("{}({})", id, parts.join(","));
                if *awaited && await_result {
                    format!("await {call}")
                } else {
                    call
                }
            }
            IrCallTarget::DeriveFn(canonical) => {
                if self.in_hook() {
                    return self.hook_gap(
                        "hook derive call",
                        "derive calls need the ambient context (c), which hooks do not receive",
                        span,
                    );
                }
                let name = match self.by_canonical.get(canonical) {
                    Some(index) => binding_ident("s", &self.ir.items[*index].canonical),
                    None => {
                        self.unsupported(
                            "derive call",
                            &format!("{canonical} is not a known symbol"),
                            span,
                        );
                        return self.throw_expr(&format!("unknown derive {canonical}"));
                    }
                };
                let parts = parts.to_vec();
                let mut all = vec!["c".to_string()];
                all.extend(parts);
                format!(
                    "{}{}({})",
                    if await_result { "await " } else { "" },
                    name,
                    all.join(",")
                )
            }
            IrCallTarget::CapabilityOp(canonical) => {
                if self.in_hook() {
                    return self.hook_gap(
                        "hook capability call",
                        "capability calls need the ambient context, which hooks do not receive",
                        span,
                    );
                }
                let (local, module) = match self.by_canonical.get(canonical) {
                    Some(index) => {
                        let item = &self.ir.items[*index];
                        (
                            binding_ident("s", &item.canonical),
                            self.ir.module(item.module).name.clone(),
                        )
                    }
                    None => {
                        self.unsupported(
                            "capability operation call",
                            &format!("{canonical} is not a known symbol"),
                            span,
                        );
                        return self.throw_expr(&format!("unknown capability op {canonical}"));
                    }
                };
                let path = format!("./{}", module_path(&module));
                self.relative.entry(path).or_default().insert(local.clone());
                let parts = parts.to_vec();
                let mut all = vec!["c".to_string()];
                all.extend(parts);
                format!(
                    "{}{}({})",
                    if await_result { "await " } else { "" },
                    local,
                    all.join(",")
                )
            }
        }
    }

    /// Lower a complete binary tree in source order without native recursion.
    fn lower_binary_tree(&mut self, expr: &TypedExpr) -> String {
        // This is an output strategy threshold, never an admission limit.
        // Beyond it, nested helper calls can overflow a supported JS parser.
        let mut depths = vec![(expr, 0usize)];
        while let Some((current, depth)) = depths.pop() {
            if let IrExpr::Binary { left, right, .. } = &current.expr {
                if depth == 64 {
                    return self.lower_flat_binary(expr);
                }
                depths.push((right, depth + 1));
                depths.push((left, depth + 1));
            }
        }
        enum Work<'e> {
            Eval(&'e TypedExpr),
            Finish(String),
        }
        let mut work = vec![Work::Eval(expr)];
        let mut values: Vec<String> = Vec::new();
        while let Some(step) = work.pop() {
            match step {
                Work::Eval(current) => {
                    if let IrExpr::Binary { op, left, right } = &current.expr {
                        let template = self.lower_binary(
                            *op,
                            left,
                            right,
                            current.span,
                            BINARY_LEFT,
                            BINARY_RIGHT,
                        );
                        if template.contains(BINARY_LEFT) || template.contains(BINARY_RIGHT) {
                            work.push(Work::Finish(template));
                            work.push(Work::Eval(right));
                            work.push(Work::Eval(left));
                        } else {
                            // Unsupported combinations retain their throwing placeholder
                            // without visiting operands the old consumer skipped.
                            values.push(template);
                        }
                    } else {
                        values.push(self.lower_expr(current));
                    }
                }
                Work::Finish(template) => {
                    let right = values.pop().expect("binary right output");
                    let left = values.pop().expect("binary left output");
                    values.push(fill_binary_template(template, &left, &right));
                }
            }
        }
        values.pop().expect("binary output")
    }

    /// A statement sequence retains every checked operation and avoids
    /// deeply nested helper calls. Conditional frames keep RHS effects lazy.
    fn lower_flat_binary(&mut self, expr: &TypedExpr) -> String {
        enum Work<'e> {
            Eval(&'e TypedExpr),
            Left(&'e TypedExpr, String),
            Right(String, String),
            Conditional(String),
        }
        let mut work = vec![Work::Eval(expr)];
        let mut values: Vec<String> = Vec::new();
        let mut body = String::new();
        let mut sequence = 0;
        while let Some(step) = work.pop() {
            let temp = format!("$binary{sequence}");
            match step {
                Work::Eval(current) => {
                    if let IrExpr::Binary { op, left, right } = &current.expr {
                        let template = self.lower_binary(
                            *op,
                            left,
                            right,
                            current.span,
                            BINARY_LEFT,
                            BINARY_RIGHT,
                        );
                        if template.contains(BINARY_LEFT) || template.contains(BINARY_RIGHT) {
                            work.push(Work::Left(current, template));
                            work.push(Work::Eval(left));
                        } else {
                            body.push_str(&format!("const {temp}={template};"));
                            sequence += 1;
                            values.push(temp);
                        }
                    } else {
                        let value = self.lower_expr(current);
                        body.push_str(&format!("const {temp}={value};"));
                        sequence += 1;
                        values.push(temp);
                    }
                }
                Work::Left(current, template) => {
                    let IrExpr::Binary { op, right, .. } = &current.expr else {
                        unreachable!()
                    };
                    let left = values.pop().expect("flat binary left output");
                    if matches!(op, IrBinOp::And | IrBinOp::Or | IrBinOp::Coalesce) {
                        let test = match op {
                            IrBinOp::And => temp.clone(),
                            IrBinOp::Or => format!("!{temp}"),
                            _ => format!("{temp}===null||{temp}===undefined"),
                        };
                        body.push_str(&format!("let {temp}={left};if({test}){{"));
                        sequence += 1;
                        work.push(Work::Conditional(temp));
                    } else {
                        work.push(Work::Right(template, left));
                    }
                    work.push(Work::Eval(right));
                }
                Work::Right(template, left_text) => {
                    let right_text = values.pop().expect("flat binary right output");
                    let value = fill_binary_template(template, &left_text, &right_text);
                    body.push_str(&format!("const {temp}={value};"));
                    sequence += 1;
                    values.push(temp);
                }
                Work::Conditional(temp) => {
                    let right = values.pop().expect("flat conditional right output");
                    body.push_str(&format!("{temp}={right};}}"));
                    values.push(temp);
                }
            }
        }
        let value = values.pop().expect("flat binary result");
        if expr_uses_async(expr) {
            format!("await (async()=>{{{body}return {value};}})()")
        } else {
            format!("(()=>{{{body}return {value};}})()")
        }
    }

    /// Lower a binary operator by checked operand families.
    fn lower_binary(
        &mut self,
        op: IrBinOp,
        left: &TypedExpr,
        right: &TypedExpr,
        span: Span,
        l: &str,
        r: &str,
    ) -> String {
        match op {
            IrBinOp::And | IrBinOp::Or => {
                let js_op = if op == IrBinOp::And { "&&" } else { "||" };
                format!(
                    "{} {js_op} {}",
                    parenthesize_logic(l, &left.expr, op),
                    parenthesize_logic(r, &right.expr, op)
                )
            }
            IrBinOp::Coalesce => {
                format!(
                    "{} ?? {}",
                    parenthesize_operand(l, &left.expr),
                    parenthesize_operand(r, &right.expr)
                )
            }
            IrBinOp::In => {
                let ResolvedType::Array { element, .. } = &right.ty else {
                    let id = self.canonical_type_id(&right.ty, span);
                    self.unsupported(
                        "in membership",
                        &format!("right-hand {id} is not a collection"),
                        span,
                    );
                    return self.throw_expr("in over non-collection");
                };
                // Call arguments evaluate once in authored left-to-right
                // order, including awaits. The lambda's parameters cannot
                // capture either operand and introduce no Promise turn.
                self.stdlib.insert("equalValue".to_string());
                let type_id = self.canonical_type_id(element, span);
                format!(
                    "(($member,$collection)=>$collection.some($item=>equalValue({},$member,$item)))({l},{r})",
                    js_string(&type_id)
                )
            }
            IrBinOp::Eq | IrBinOp::Ne => self.lower_equality(op, left, right, span, l, r),
            IrBinOp::Lt | IrBinOp::Le | IrBinOp::Gt | IrBinOp::Ge => {
                self.lower_relational(op, left, right, span, l, r)
            }
            IrBinOp::Add | IrBinOp::Sub | IrBinOp::Mul | IrBinOp::Div | IrBinOp::Mod => {
                self.lower_arithmetic(op, left, right, span, l, r)
            }
        }
    }

    /// Lower `==`/`!=`: `null` compares directly, money uses `equalMoney`,
    /// decimals and structural values use `equalValue(typeId, a, b)`,
    /// references use `same`, secrets use `secretEqual`, ordered scalars
    /// compare directly.
    fn lower_equality(
        &mut self,
        op: IrBinOp,
        left: &TypedExpr,
        right: &TypedExpr,
        span: Span,
        l: &str,
        r: &str,
    ) -> String {
        let negate = op == IrBinOp::Ne;
        // `null` against any nullable side compares directly.
        if matches!(left.ty, ResolvedType::Null) || matches!(right.ty, ResolvedType::Null) {
            let js_op = if negate { "!==" } else { "===" };
            return format!("{l} {js_op} {r}");
        }
        // Stored rows compare by reference identity; contracts, arrays and
        // objects compare structurally so they are never compared by
        // JavaScript object identity.
        if matches!(left.ty, ResolvedType::Record { .. })
            || matches!(right.ty, ResolvedType::Record { .. })
        {
            let structural = [left, right].iter().any(|side| {
                let mut ty = &side.ty;
                while let ResolvedType::Nullable(inner) = ty {
                    ty = inner;
                }
                match ty {
                    ResolvedType::Record { symbol, .. } => !matches!(
                        self.ir.items[symbol.0 as usize].kind,
                        IrItemKind::Model { .. }
                    ),
                    _ => is_structural(ty),
                }
            });
            if !structural {
                self.stdlib.insert("same".to_string());
                return negate_call(negate, &format!("same({l},{r})"));
            }
        }
        if is_structural(&left.ty) || is_structural(&right.ty) {
            if self.in_hook() {
                return self.hook_gap(
                    "hook equality",
                    "structural equality has no qualified native hook carrier profile",
                    span,
                );
            }
            self.stdlib.insert("equalValue".to_string());
            let id = self.canonical_type_id(&left.ty, span);
            return negate_call(negate, &format!("equalValue({}, {l},{r})", js_string(&id)));
        }
        let l_family = scalar_family(&left.ty);
        let r_family = scalar_family(&right.ty);
        match (l_family, r_family) {
            (Some(ScalarFamily::Money), Some(ScalarFamily::Money)) => {
                self.stdlib.insert("equalMoney".to_string());
                negate_call(negate, &format!("equalMoney({l},{r})"))
            }
            (Some(ScalarFamily::Decimal), Some(ScalarFamily::Decimal)) => {
                if self.in_hook() {
                    return self.hook_gap(
                        "hook equality",
                        "decimal equality has no qualified native hook carrier profile",
                        span,
                    );
                }
                self.stdlib.insert("equalValue".to_string());
                negate_call(negate, &format!("equalValue(\"decimal\",{l},{r})"))
            }
            (
                Some(
                    ScalarFamily::Int
                    | ScalarFamily::Duration
                    | ScalarFamily::Date
                    | ScalarFamily::Datetime,
                ),
                _,
            )
            | (
                _,
                Some(
                    ScalarFamily::Int
                    | ScalarFamily::Duration
                    | ScalarFamily::Date
                    | ScalarFamily::Datetime,
                ),
            ) => {
                // BigInt durations/integers compare by value; dates and
                // datetimes compare through their §13 comparators.
                let family = l_family.or(r_family);
                if !matches!(l_family, Some(f) if Some(f) == r_family) {
                    let l_id = self.canonical_type_id(&left.ty, span);
                    let r_id = self.canonical_type_id(&right.ty, span);
                    self.unsupported(
                        "equality",
                        &format!("mismatched operands {l_id} and {r_id}"),
                        span,
                    );
                    return self.throw_expr("mismatched equality");
                }
                match family {
                    Some(ScalarFamily::Date) => {
                        self.stdlib.insert("compareDate".to_string());
                        let js_op = if negate { "!==" } else { "===" };
                        format!("compareDate({l},{r}) {js_op} 0")
                    }
                    Some(ScalarFamily::Datetime) => {
                        self.stdlib.insert("compareInstant".to_string());
                        let js_op = if negate { "!==" } else { "===" };
                        format!("compareInstant({l},{r}) {js_op} 0")
                    }
                    _ => {
                        let js_op = if negate { "!==" } else { "===" };
                        format!("{l} {js_op} {r}")
                    }
                }
            }
            (
                Some(ScalarFamily::Bool | ScalarFamily::Text | ScalarFamily::Enum),
                Some(ScalarFamily::Bool | ScalarFamily::Text | ScalarFamily::Enum),
            ) => {
                let js_op = if negate { "!==" } else { "===" };
                format!("{l} {js_op} {r}")
            }
            (Some(ScalarFamily::Reference), Some(ScalarFamily::Reference)) => {
                self.stdlib.insert("same".to_string());
                negate_call(negate, &format!("same({l},{r})"))
            }
            (Some(ScalarFamily::Secret), Some(ScalarFamily::Secret)) => {
                self.stdlib.insert("secretEqual".to_string());
                negate_call(negate, &format!("secretEqual({l},{r})"))
            }
            _ => {
                let l_id = self.canonical_type_id(&left.ty, span);
                let r_id = self.canonical_type_id(&right.ty, span);
                self.unsupported(
                    "equality",
                    &format!("mismatched or unlowerable operands {l_id} and {r_id}"),
                    span,
                );
                self.throw_expr("mismatched equality")
            }
        }
    }

    /// Lower relational operators: comparators returning -1/0/1 compared
    /// against zero for money/decimal/date/datetime, direct comparison for
    /// BigInt integers/durations and text.
    fn lower_relational(
        &mut self,
        op: IrBinOp,
        left: &TypedExpr,
        right: &TypedExpr,
        span: Span,
        l: &str,
        r: &str,
    ) -> String {
        let js_op = match op {
            IrBinOp::Lt => "<",
            IrBinOp::Le => "<=",
            IrBinOp::Gt => ">",
            IrBinOp::Ge => ">=",
            _ => unreachable!("relational dispatch"),
        };
        match (scalar_family(&left.ty), scalar_family(&right.ty)) {
            (Some(ScalarFamily::Money), Some(ScalarFamily::Money)) => {
                self.stdlib.insert("compareMoney".to_string());
                format!("compareMoney({l},{r}) {js_op} 0")
            }
            (Some(ScalarFamily::Decimal), Some(ScalarFamily::Decimal)) => {
                self.stdlib.insert("compareDecimal".to_string());
                format!("compareDecimal({l},{r}) {js_op} 0")
            }
            (Some(ScalarFamily::Date), Some(ScalarFamily::Date)) => {
                self.stdlib.insert("compareDate".to_string());
                format!("compareDate({l},{r}) {js_op} 0")
            }
            (Some(ScalarFamily::Datetime), Some(ScalarFamily::Datetime)) => {
                self.stdlib.insert("compareInstant".to_string());
                format!("compareInstant({l},{r}) {js_op} 0")
            }
            (Some(ScalarFamily::Int), Some(ScalarFamily::Int))
            | (Some(ScalarFamily::Duration), Some(ScalarFamily::Duration))
            | (Some(ScalarFamily::Text), Some(ScalarFamily::Text)) => {
                format!("{l} {js_op} {r}")
            }
            _ => {
                let l_id = self.canonical_type_id(&left.ty, span);
                let r_id = self.canonical_type_id(&right.ty, span);
                self.unsupported(
                    "relational comparison",
                    &format!("mismatched or unordered operands {l_id} and {r_id}"),
                    span,
                );
                self.throw_expr("unordered comparison")
            }
        }
    }

    /// Lower arithmetic: `int64` checked integer arithmetic, the money
    /// helpers (`addMoney`, `subtractMoney`, `multiplyMoney`, `divideMoney`),
    /// the decimal helpers (`addDecimal`, `subtractDecimal`,
    /// `multiplyDecimal`, `divideDecimal`), `durationBetween`, `addDuration`
    /// and `subtractDuration`. Decimal operands mix with `int` exactly (the
    /// helpers take `int|decimal`); scalar-first money products normalize to
    /// `multiplyMoney(money, factor)`; a `money`/`money` ratio is
    /// `divideDecimal`. Shapes with no verified helper stay `E6008`.
    fn lower_arithmetic(
        &mut self,
        op: IrBinOp,
        left: &TypedExpr,
        right: &TypedExpr,
        span: Span,
        l: &str,
        r: &str,
    ) -> String {
        let js_op = match op {
            IrBinOp::Add => "+",
            IrBinOp::Sub => "-",
            IrBinOp::Mul => "*",
            IrBinOp::Div => "/",
            IrBinOp::Mod => "%",
            _ => unreachable!("arithmetic dispatch"),
        };
        match (scalar_family(&left.ty), scalar_family(&right.ty)) {
            (Some(ScalarFamily::Int), Some(ScalarFamily::Int)) => {
                self.stdlib.insert("int64".to_string());
                format!("int64({l} {js_op} {r})")
            }
            (Some(ScalarFamily::Money), Some(ScalarFamily::Money)) => match op {
                IrBinOp::Add | IrBinOp::Sub => {
                    let name = if op == IrBinOp::Add {
                        "addMoney"
                    } else {
                        "subtractMoney"
                    };
                    self.stdlib.insert(name.to_string());
                    format!("{name}({l},{r})")
                }
                // A money/money ratio has no currency unit and uses decimal
                // rounding: `divideDecimal` documents money operands.
                IrBinOp::Div => {
                    self.stdlib.insert("divideDecimal".to_string());
                    format!("divideDecimal({l},{r})")
                }
                _ => {
                    self.unsupported(
                        "money arithmetic",
                        &format!("money {js_op} money has no §13 lowering"),
                        span,
                    );
                    self.throw_expr("money arithmetic has no lowering")
                }
            },
            (Some(ScalarFamily::Money), Some(ScalarFamily::Decimal))
            | (Some(ScalarFamily::Money), Some(ScalarFamily::Int)) => match op {
                IrBinOp::Mul => {
                    self.stdlib.insert("multiplyMoney".to_string());
                    format!("multiplyMoney({l},{r})")
                }
                IrBinOp::Div => {
                    self.stdlib.insert("divideMoney".to_string());
                    format!("divideMoney({l},{r})")
                }
                _ => {
                    self.unsupported(
                        "money arithmetic",
                        &format!("money {js_op} factor has no §13 lowering"),
                        span,
                    );
                    self.throw_expr("money arithmetic has no lowering")
                }
            },
            // Scalar-first money products normalize money-first: lane-02
            // `multiplyMoney(m, factor)` takes the money operand first.
            (Some(ScalarFamily::Decimal), Some(ScalarFamily::Money))
            | (Some(ScalarFamily::Int), Some(ScalarFamily::Money)) => match op {
                IrBinOp::Mul => {
                    self.stdlib.insert("multiplyMoney".to_string());
                    format!("multiplyMoney({r},{l})")
                }
                _ => {
                    self.unsupported(
                        "money arithmetic",
                        &format!("factor {js_op} money has no §13 lowering"),
                        span,
                    );
                    self.throw_expr("money arithmetic has no lowering")
                }
            },
            (Some(ScalarFamily::Decimal), Some(ScalarFamily::Decimal))
            | (Some(ScalarFamily::Decimal), Some(ScalarFamily::Int))
            | (Some(ScalarFamily::Int), Some(ScalarFamily::Decimal)) => match op {
                IrBinOp::Add | IrBinOp::Sub | IrBinOp::Mul | IrBinOp::Div => {
                    let name = match op {
                        IrBinOp::Add => "addDecimal",
                        IrBinOp::Sub => "subtractDecimal",
                        IrBinOp::Mul => "multiplyDecimal",
                        _ => "divideDecimal",
                    };
                    self.stdlib.insert(name.to_string());
                    format!("{name}({l},{r})")
                }
                _ => {
                    self.unsupported(
                        "decimal arithmetic",
                        &format!("decimal {js_op} decimal has no §13 lowering"),
                        span,
                    );
                    self.throw_expr("decimal arithmetic has no lowering")
                }
            },
            (Some(ScalarFamily::Datetime), Some(ScalarFamily::Datetime)) => match op {
                IrBinOp::Sub => {
                    self.stdlib.insert("durationBetween".to_string());
                    format!("durationBetween({l},{r})")
                }
                _ => {
                    self.unsupported(
                        "datetime arithmetic",
                        &format!("datetime {js_op} datetime has no §13 lowering"),
                        span,
                    );
                    self.throw_expr("datetime arithmetic has no lowering")
                }
            },
            (Some(ScalarFamily::Datetime), Some(ScalarFamily::Duration))
            | (Some(ScalarFamily::Duration), Some(ScalarFamily::Duration)) => match op {
                IrBinOp::Add | IrBinOp::Sub => {
                    let name = if op == IrBinOp::Add {
                        "addDuration"
                    } else {
                        "subtractDuration"
                    };
                    self.stdlib.insert(name.to_string());
                    format!("{name}({l},{r})")
                }
                _ => {
                    self.unsupported(
                        "duration arithmetic",
                        &format!("duration {js_op} has no §13 lowering"),
                        span,
                    );
                    self.throw_expr("duration arithmetic has no lowering")
                }
            },
            (Some(ScalarFamily::Text), Some(ScalarFamily::Text)) => match op {
                IrBinOp::Add => {
                    format!("{l} + {r}")
                }
                _ => {
                    self.unsupported(
                        "text arithmetic",
                        &format!("text {js_op} text has no §13 lowering"),
                        span,
                    );
                    self.throw_expr("text arithmetic has no lowering")
                }
            },
            _ => {
                let l_id = self.canonical_type_id(&left.ty, span);
                let r_id = self.canonical_type_id(&right.ty, span);
                self.unsupported(
                    "arithmetic",
                    &format!("{l_id} {js_op} {r_id} has no §13 lowering"),
                    span,
                );
                self.throw_expr("arithmetic has no lowering")
            }
        }
    }

    /// Lower unary operators: `int64(-x)`, `negateMoney(x)`,
    /// `negateDecimal(x)`, `!x`.
    fn lower_unary(&mut self, op: IrUnOp, operand: &TypedExpr, span: Span) -> String {
        match op {
            IrUnOp::Not => {
                let inner = self.lower_expr(operand);
                format!("!{}", parenthesize_operand(&inner, &operand.expr))
            }
            IrUnOp::Neg => match scalar_family(&operand.ty) {
                Some(ScalarFamily::Int) => {
                    self.stdlib.insert("int64".to_string());
                    let inner = self.lower_expr(operand);
                    format!("int64(-{})", parenthesize_operand(&inner, &operand.expr))
                }
                Some(ScalarFamily::Money) => {
                    self.stdlib.insert("negateMoney".to_string());
                    let inner = self.lower_expr(operand);
                    format!("negateMoney({inner})")
                }
                Some(ScalarFamily::Decimal) => {
                    self.stdlib.insert("negateDecimal".to_string());
                    let inner = self.lower_expr(operand);
                    format!("negateDecimal({inner})")
                }
                _ => {
                    let id = self.canonical_type_id(&operand.ty, span);
                    self.unsupported("negation", &format!("-{id} has no §13 lowering"), span);
                    self.throw_expr("negation has no lowering")
                }
            },
        }
    }

    /// Lower a query to `await records(c, model, {parent?, where?, order?,
    /// limit?, archived?})`: `records()` returns a promise and viewer read
    /// grants apply before filters and projection.
    fn lower_query(&mut self, query: &crate::codegen::ir::IrQuery, _span: Span) -> String {
        match &query.domain {
            crate::codegen::ir::IrQueryDomain::Model(model) => {
                self.stdlib.insert("records".to_string());
                let mut opts = Vec::new();
                if let Some(parent) = &query.parent {
                    opts.push(format!("parent:{}", self.lower_expr(parent)));
                }
                if let Some(pred) = &query.where_pred {
                    self.enter_scope();
                    let row = self.bind("row");
                    let body = self.lower_expr(pred);
                    self.exit_scope();
                    if query.where_async {
                        opts.push(format!("where:async({row})=>{body}"));
                    } else {
                        opts.push(format!("where:({row})=>{body}"));
                    }
                }
                if !query.order.is_empty() {
                    let order = query
                        .order
                        .iter()
                        .map(|o| {
                            if o.descending {
                                js_string(&format!("-{}", o.field))
                            } else {
                                js_string(&o.field)
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(",");
                    opts.push(format!("order:[{order}]"));
                }
                if let Some(limit) = &query.limit {
                    opts.push(format!("limit:{}", self.lower_expr(limit)));
                }
                if let Some(archived) = &query.archived {
                    opts.push(format!("archived:{}", self.lower_expr(archived)));
                }
                let fetched = format!(
                    "await records(c,{},{{{}}})",
                    js_string(model),
                    opts.join(",")
                );
                self.append_select(&fetched, true, query)
            }
            crate::codegen::ir::IrQueryDomain::Value { base, alias } => {
                let base_text = self.lower_expr(base);
                // The receiver needs parens exactly when its lowering is
                // not already receiver-shaped (an awaited fetch, a call,
                // or a compound expression).
                let mut out = match &base.expr {
                    IrExpr::Query(_) | IrExpr::Lambda { .. } => format!("({base_text})"),
                    _ => parenthesize_operand(&base_text, &base.expr),
                };
                if let Some(pred) = &query.where_pred {
                    self.enter_scope();
                    let alias = self.bind(alias);
                    let body = self.lower_expr(pred);
                    self.exit_scope();
                    out = format!("{out}.filter(({alias})=>{body})");
                }
                self.append_select(&out, false, query)
            }
        }
    }

    /// Append a `select` projection `.map` to a lowered domain fetch.
    /// Model fetches are awaited, so the map wraps the awaited result.
    fn append_select(
        &mut self,
        fetched: &str,
        awaited: bool,
        query: &crate::codegen::ir::IrQuery,
    ) -> String {
        let (Some(projection), Some(param)) = (query.select.as_ref(), query.select_param.as_ref())
        else {
            return fetched.to_string();
        };
        self.enter_scope();
        let param = self.bind(param);
        let body = self.lower_expr(projection);
        self.exit_scope();
        let map = format!(".map(({param})=>{body})");
        if awaited {
            format!("({fetched}){map}")
        } else {
            format!("{fetched}{map}")
        }
    }

    /// Lower a full field schema: base schema plus `default` and
    /// `server` slots (PR5 populates them; see [`IrDefault`], [`IrServer`]).
    /// T09: `required_array` is the field-only `!` marker (never
    /// nullability); only non-null arrays consult it.
    pub fn lower_field_full(
        &mut self,
        ty: &ResolvedType,
        required_array: bool,
        default: Option<&IrDefault>,
        server: Option<&IrServer>,
        span: Span,
    ) -> String {
        let mut members = self.field_schema_object(ty, required_array, span);
        if let Some(default) = default {
            members.push_str(&format!(",default:{}", self.lower_default(default)));
        }
        if let Some(server) = server {
            members.push_str(&format!(",server:{}", self.lower_server(server)));
        }
        format!("{{{members}}}")
    }

    /// Lower a creation default: literal stays literal, computed becomes
    /// a typed callable over creation context.
    fn lower_default(&mut self, default: &IrDefault) -> String {
        match default {
            IrDefault::Literal(value) => self.lower_business_expr(value, "formatted field default"),
            IrDefault::Computed { expr, has_parent } => {
                let body = self.lower_business_expr(expr, "formatted field default");
                let prefix = if expr_uses_async(expr) { "async" } else { "" };
                if *has_parent {
                    format!("{prefix}(c,{{parent}})=>{body}")
                } else {
                    format!("{prefix}(c)=>{body}")
                }
            }
        }
    }

    /// Lower a server initializer: fixed `actor`/`now`/`random_secret`
    /// markers or a callable. `random_secret()` is engine-executed (T18:
    /// never JS-linked — the catalog marks it external and
    /// non-client-callable), so it lowers to a link-free marker like
    /// `actor`/`now` rather than a callable over an unlinked import.
    fn lower_server(&mut self, server: &IrServer) -> String {
        match server {
            IrServer::Actor => "\"actor\"".to_string(),
            IrServer::Now => "\"now\"".to_string(),
            IrServer::Computed(expr) if is_random_secret_call(expr) => {
                "\"random_secret\"".to_string()
            }
            IrServer::Computed(expr) => {
                let body = self.lower_business_expr(expr, "formatted server initializer");
                let prefix = if expr_uses_async(expr) { "async" } else { "" };
                format!("{prefix}(c)=>{body}")
            }
        }
    }

    fn lower_message_call(
        &mut self,
        descriptor: &IrMessage,
        args: &[TypedExpr],
        params: &[crate::codegen::ir::IrMessageCallParam],
    ) -> String {
        let values: Vec<_> = args.iter().map(|arg| self.lower_expr(arg)).collect();
        let capture = binding_ident("a", &self.binding_seq.to_string());
        self.binding_seq += 1;
        self.enter_scope();
        let mut declarations = String::new();
        let mut bound = descriptor.clone();
        let mut awaited = false;
        for param in params {
            let value = match param.source {
                Some(index) => format!("{capture}[{index}]"),
                None => {
                    let default = param.default.as_ref().expect("checked omitted default");
                    awaited |= expr_uses_async(default);
                    self.lower_expr(default)
                }
            };
            let name = self.bind(&param.name);
            declarations.push_str(&format!("const {name}={value};"));
            bound.params.push(crate::codegen::ir::IrMessageParam {
                name: param.name.clone(),
                type_id: param.type_id.clone(),
                value: TypedExpr::new(
                    IrExpr::Name(name),
                    ResolvedType::Unknown,
                    args.first()
                        .map(|arg| arg.span)
                        .or_else(|| param.default.as_ref().map(|value| value.span))
                        .unwrap_or(Span::new(crate::source::SourceId(0), 0, 0)),
                ),
            });
        }
        let body = self.lower_message(&bound);
        self.exit_scope();
        format!(
            "{}({}({capture})=>{{{declarations}return {body};}})([{}])",
            if awaited { "await " } else { "" },
            if awaited { "async" } else { "" },
            values.join(",")
        )
    }

    /// Lower a display message: `message(source, {locales})`, or the
    /// three-argument parameterized form preserving typed parameters.
    pub fn lower_message(&mut self, message: &IrMessage) -> String {
        if let Some(param) = message
            .params
            .iter()
            .find(|param| self.expr_formatted(&param.value))
        {
            return self.formatted_refusal("formatted message parameter", param.value.span);
        }
        self.ui.insert("message".to_string());
        let mut out = format!(
            "{}({}",
            binding_ident("u", "message"),
            js_string(&message.source)
        );
        if message.variants.is_empty() && message.params.is_empty() {
            out.push(')');
            return out;
        }
        let variants = message
            .variants
            .iter()
            .map(|(locale, text)| {
                format!(
                    "{}:{}",
                    object_key(locale),
                    text.as_deref()
                        .map(js_string)
                        .unwrap_or_else(|| "null".to_string())
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        out.push_str(&format!(",{{{variants}}}"));
        if !message.params.is_empty() {
            let params = message
                .params
                .iter()
                .map(|p| {
                    format!(
                        "{}:{{type:{},value:{}}}",
                        object_key(&p.name),
                        js_string(&p.type_id),
                        self.lower_expr(&p.value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            out.push_str(&format!(",{{{params}}}"));
        }
        out.push(')');
        out
    }

    /// Lower one statement to lines at `indent` (two spaces per level),
    /// preserving source order. Every arm attributes its lines to the
    /// statement span via the returned `(text, span)` pairs.
    pub fn lower_stmt(&mut self, stmt: &IrStmt, indent: usize) -> Vec<(String, Span)> {
        let pad = "  ".repeat(indent);
        let consumers: Vec<&TypedExpr> = match stmt {
            IrStmt::Let { .. } | IrStmt::Unsupported { .. } => Vec::new(),
            IrStmt::Create { input, .. } => vec![input],
            IrStmt::Set {
                record, changes, ..
            } => vec![record, changes],
            IrStmt::Transition { record, .. } | IrStmt::Delete { record, .. } => vec![record],
            IrStmt::Call { inputs, .. } => vec![inputs],
            IrStmt::Emit { payload, .. } => vec![payload],
            IrStmt::Send { args, when, .. } => std::iter::once(args).chain(when.iter()).collect(),
            IrStmt::Schedule {
                key, at, payload, ..
            } => vec![key, at, payload],
            IrStmt::Cancel { key, .. } => vec![key],
            IrStmt::Return { value, .. } => value.iter().collect(),
            IrStmt::Require { cond, .. } | IrStmt::If { cond, .. } => vec![cond],
            IrStmt::For { domain, limit, .. } => {
                std::iter::once(domain).chain(limit.iter()).collect()
            }
        };
        if let Some(value) = consumers.iter().find(|value| self.expr_formatted(value)) {
            let refused = self.formatted_refusal("formatted business statement", value.span);
            return vec![(format!("{pad}{refused};"), value.span)];
        }
        match stmt {
            IrStmt::Let { name, value, span } => {
                let formatted = self.expr_formatted(value);
                let value_text = self.lower_expr(value);
                let emitted = self.bind(name);
                self.formatted_bindings
                    .last_mut()
                    .expect("lexical scope")
                    .insert(name.clone(), formatted);
                vec![(format!("{pad}const {emitted} = {value_text};"), *span)]
            }
            IrStmt::Create {
                model,
                input,
                when,
                binding,
                span,
            } => {
                if self.hook.is_some() {
                    return self.lower_hook_create(model, input, binding, *span, &pad);
                }
                self.stdlib.insert("create".to_string());
                let input_text = self.lower_expr(input);
                let when_text = when
                    .as_ref()
                    .map(|key| format!(",{{when:crudWhen[{}]}}", js_string(key)))
                    .unwrap_or_default();
                let call = format!(
                    "await create(c,{},{input_text}{when_text})",
                    js_string(model)
                );
                vec![(
                    match binding {
                        Some(name) => format!("{pad}const {} = {call};", self.bind(name)),
                        None => format!("{pad}{call};"),
                    },
                    *span,
                )]
            }
            IrStmt::Set {
                record,
                changes,
                when,
                span,
            } => {
                if self.hook.is_some() {
                    return self.lower_hook_set(record, changes, *span, &pad);
                }
                self.stdlib.insert("set".to_string());
                let record_text = self.lower_expr(record);
                let changes_text = self.lower_expr(changes);
                let when_text = when
                    .as_ref()
                    .map(|key| format!(",{{when:crudWhen[{}]}}", js_string(key)))
                    .unwrap_or_default();
                vec![(
                    format!("{pad}await set(c,{record_text},{changes_text}{when_text});"),
                    *span,
                )]
            }
            IrStmt::Transition {
                model,
                record,
                field,
                from,
                to,
                span,
            } => {
                if self.hook.is_some() {
                    self.unsupported(
                        "transition",
                        "hooks cannot transition machine fields",
                        *span,
                    );
                    return vec![(
                        format!("{pad}throw new Error('transition in hook');"),
                        *span,
                    )];
                }
                self.stdlib.insert("transition".to_string());
                let record = self.lower_expr(record);
                vec![(
                    format!(
                        "{pad}await transition(c,{},({record}).id,{},{},{});",
                        js_string(model),
                        js_string(field),
                        js_string(from),
                        js_string(to)
                    ),
                    *span,
                )]
            }
            IrStmt::Delete { record, mode, span } => {
                if self.hook.is_some() {
                    self.unsupported(
                        "delete effect",
                        "hooks stage create/set only; deletes have no hook lowering",
                        *span,
                    );
                    return vec![(
                        format!(
                            "{pad}throw new Error({});",
                            js_string("delete in hooks has no lowering")
                        ),
                        *span,
                    )];
                }
                self.stdlib.insert("deleteRecord".to_string());
                let record_text = self.lower_expr(record);
                vec![(
                    format!(
                        "{pad}await deleteRecord(c,{record_text},{{mode:'{}'}});",
                        mode.as_str()
                    ),
                    *span,
                )]
            }
            IrStmt::Call {
                operation,
                inputs: _,
                binding: _,
                span,
            } => {
                self.unsupported(
                    "call effect",
                    &format!(
                        "canonical cross-operation invocation of {operation} has no §13 lowering"
                    ),
                    *span,
                );
                vec![(
                    format!(
                        "{pad}throw new Error({});",
                        js_string(&format!("call {operation} has no lowering"))
                    ),
                    *span,
                )]
            }
            IrStmt::Emit {
                event,
                payload,
                span,
            } => {
                if self.hook.is_some() {
                    self.unsupported(
                        "emit effect",
                        "Rule A stages no outbox writes from hooks; emit has no hook lowering",
                        *span,
                    );
                    return vec![(
                        format!(
                            "{pad}throw new Error({});",
                            js_string("emit in hooks has no lowering")
                        ),
                        *span,
                    )];
                }
                self.stdlib.insert("emit".to_string());
                let payload_text = self.lower_expr(payload);
                vec![(
                    format!("{pad}await emit(c,{},{payload_text});", js_string(event)),
                    *span,
                )]
            }
            IrStmt::Send {
                operation,
                args,
                when,
                binding,
                span,
            } => {
                if self.hook.is_some() {
                    self.unsupported(
                        "send effect",
                        "Rule A stages no outbox writes from hooks; send has no hook lowering",
                        *span,
                    );
                    return vec![(
                        format!(
                            "{pad}throw new Error({});",
                            js_string("send in hooks has no lowering")
                        ),
                        *span,
                    )];
                }
                self.stdlib.insert("send".to_string());
                let args_text = self.lower_expr(args);
                let when_text = when
                    .as_ref()
                    .map(|cond| {
                        let cond_text = self.lower_expr(cond);
                        format!(",{{when:()=>{cond_text}}}")
                    })
                    .unwrap_or_default();
                let call = format!(
                    "await send(c,{}, {args_text}{when_text})",
                    js_string(operation)
                );
                vec![(
                    match binding {
                        Some(name) => format!("{pad}const {} = {call};", self.bind(name)),
                        None => format!("{pad}{call};"),
                    },
                    *span,
                )]
            }
            IrStmt::Schedule {
                key,
                at,
                event,
                payload,
                span,
            } => {
                if self.hook.is_some() {
                    let key_text = self.lower_expr(key);
                    let at_text = self.lower_expr(at);
                    let payload_text = self.lower_expr(payload);
                    return vec![(
                        format!(
                            "{pad}$hookCtx.schedule({{key:{key_text},at:{at_text},event:{},payload:{payload_text}}});",
                            js_string(event)
                        ),
                        *span,
                    )];
                }
                self.stdlib.insert("schedule".to_string());
                let key_text = self.lower_expr(key);
                let at_text = self.lower_expr(at);
                let payload_text = self.lower_expr(payload);
                vec![(
                    format!(
                        "{pad}await schedule(c,{key_text},{at_text},{},{payload_text});",
                        js_string(event)
                    ),
                    *span,
                )]
            }
            IrStmt::Cancel { key, span } => {
                if self.hook.is_some() {
                    let key_text = self.lower_expr(key);
                    return vec![(format!("{pad}$hookCtx.cancel({key_text});"), *span)];
                }
                self.stdlib.insert("cancel".to_string());
                let key_text = self.lower_expr(key);
                vec![(format!("{pad}await cancel(c,{key_text});"), *span)]
            }
            IrStmt::Return { value, span } => {
                if self.hook.is_some() {
                    if value.is_none() {
                        return vec![(format!("{pad}return $candidate;"), *span)];
                    }
                    self.unsupported(
                        "return value",
                        "hooks return the pending candidate; return values have no hook lowering",
                        *span,
                    );
                    return vec![(
                        format!(
                            "{pad}throw new Error({});",
                            js_string("return value in hooks has no lowering")
                        ),
                        *span,
                    )];
                }
                vec![(
                    match value {
                        Some(v) => format!("{pad}return {};", self.lower_expr(v)),
                        None => format!("{pad}return;"),
                    },
                    *span,
                )]
            }
            IrStmt::Require { cond, span } => {
                self.stdlib.insert("check".to_string());
                let cond_text = self.lower_expr(cond);
                vec![(format!("{pad}check({cond_text});"), *span)]
            }
            IrStmt::If {
                cond,
                then_branch,
                else_branch,
                span,
            } => {
                let cond_text = self.lower_expr(cond);
                let mut lines = vec![(format!("{pad}if ({cond_text}) {{"), *span)];
                self.enter_scope();
                for stmt in then_branch {
                    lines.extend(self.lower_stmt(stmt, indent + 1));
                }
                self.exit_scope();
                if else_branch.is_empty() {
                    lines.push((format!("{pad}}}"), *span));
                } else {
                    lines.push((format!("{pad}}} else {{"), *span));
                    self.enter_scope();
                    for stmt in else_branch {
                        lines.extend(self.lower_stmt(stmt, indent + 1));
                    }
                    self.exit_scope();
                    lines.push((format!("{pad}}}"), *span));
                }
                lines
            }
            IrStmt::For {
                item,
                domain,
                limit,
                body,
                span,
            } => {
                let domain_text = self.lower_expr(domain);
                // Model queries arrive already awaited (`await
                // records(...)`); await any other domain exactly once
                // (`await` on a plain array is harmless).
                let awaited = match &domain.expr {
                    IrExpr::Query(query)
                        if matches!(query.domain, crate::codegen::ir::IrQueryDomain::Model(_)) =>
                    {
                        domain_text.clone()
                    }
                    _ => format!("await {domain_text}"),
                };
                let mut lines = Vec::new();
                // A bound loop fetches once, then fails past N items
                // (DESIGN §5; `check(rows.length<=N,"limit")` per the
                // CanCreative/CanDiscover draft bound checks). Each loop
                // binds its own `$forRowsN` fetch.
                let over = if let Some(bound) = limit {
                    self.stdlib.insert("check".to_string());
                    let rows = format!("$forRows{}", self.loop_seq);
                    self.loop_seq += 1;
                    let mut bound_text = self.lower_expr(bound);
                    if expr_uses_async(bound) {
                        bound_text = format!("await {bound_text}");
                    }
                    lines.push((format!("{pad}const {rows} = {awaited};"), *span));
                    lines.push((
                        format!("{pad}check({rows}.length<={bound_text},\"limit\");"),
                        *span,
                    ));
                    rows
                } else {
                    awaited
                };
                self.enter_scope();
                let item = self.bind(item);
                lines.push((format!("{pad}for (const {item} of {over}) {{"), *span));
                for stmt in body {
                    lines.extend(self.lower_stmt(stmt, indent + 1));
                }
                self.exit_scope();
                lines.push((format!("{pad}}}"), *span));
                lines
            }
            IrStmt::Unsupported { what, why, span } => {
                self.unsupported(what, why, *span);
                vec![(
                    format!(
                        "{pad}throw new Error({});",
                        js_string(&format!("{what} has no lowering"))
                    ),
                    *span,
                )]
            }
        }
    }

    /// Canonical identity of the hook trigger, if the row resolves.
    fn hook_trigger_canonical(&self) -> Option<String> {
        let trigger = self.hook.as_ref()?.trigger;
        self.ir
            .items
            .get(trigger.0 as usize)
            .map(|item| item.canonical.clone())
    }

    /// Lower a `create` inside a hook: bind a deterministic trigger-derived
    /// id, then stage `{op, model, id, parent?, data}` through the hook
    /// context. The `parent` linkage splits off the data object as
    /// `{model, id}`; `parent=event.after` resolves through the live after
    /// view to the pending record the engine provisionalizes.
    fn lower_hook_create(
        &mut self,
        model: &str,
        input: &TypedExpr,
        binding: &Option<String>,
        span: Span,
        pad: &str,
    ) -> Vec<(String, Span)> {
        // Same-model backstop (unreachable on clean programs: E4052 owns it).
        if self.hook_trigger_canonical().as_deref() == Some(model) {
            self.unsupported(
                "hook create",
                "a hook cannot stage its own trigger model",
                span,
            );
            return vec![(
                format!(
                    "{pad}throw new Error({});",
                    js_string("hook create of its own model has no lowering")
                ),
                span,
            )];
        }
        let IrExpr::Object(entries) = &input.expr else {
            self.unsupported("hook create", "staged input is not an object", span);
            return vec![(
                format!(
                    "{pad}throw new Error({});",
                    js_string("hook create input has no lowering")
                ),
                span,
            )];
        };
        let mut parent_text = String::new();
        let mut data_entries: Vec<(String, TypedExpr)> = Vec::new();
        for (key, value) in entries {
            if key != "parent" {
                data_entries.push((key.clone(), value.clone()));
                continue;
            }
            let ResolvedType::Record { symbol, .. } = &value.ty else {
                self.unsupported("hook create parent", "staged parent is not a record", span);
                return vec![(
                    format!(
                        "{pad}throw new Error({});",
                        js_string("hook create parent has no lowering")
                    ),
                    span,
                )];
            };
            let Some(parent_model) = self
                .ir
                .items
                .get(symbol.0 as usize)
                .map(|item| item.canonical.clone())
            else {
                self.unsupported(
                    "hook create parent",
                    "staged parent model does not resolve",
                    span,
                );
                return vec![(
                    format!(
                        "{pad}throw new Error({});",
                        js_string("hook create parent has no lowering")
                    ),
                    span,
                )];
            };
            let base = self.lower_expr(value);
            parent_text = format!(
                ",parent:{{model:{},id:{}.id}}",
                js_string(&parent_model),
                parenthesize_operand(&base, &value.expr)
            );
        }
        let data = self.lower_expr(&TypedExpr::new(
            IrExpr::Object(data_entries),
            ResolvedType::Unknown,
            span,
        ));
        let id_ref = binding.clone().map(|name| self.bind(&name));
        let bind_line = match &id_ref {
            Some(name) => {
                format!("{pad}const {name}={{id:$hookCtx.triggerId+\"/staged/\"+($stagedNext++)}};")
            }
            None => {
                format!("{pad}$pending={{id:$hookCtx.triggerId+\"/staged/\"+($stagedNext++)}};")
            }
        };
        let id_ref = id_ref.unwrap_or_else(|| "$pending".to_string());
        let stage_line = format!(
            "{pad}$hookCtx.stage({{op:\"create\",model:{},id:{id_ref}.id{parent_text},data:{data}}});",
            js_string(model)
        );
        vec![(bind_line, span), (stage_line, span)]
    }

    /// Lower a `set` inside a hook: `set event.after` assigns the same
    /// changes to both the candidate the engine commits and the live after
    /// view; any other stored row stages an update addressed by model plus
    /// record id (staged writes carry no admission predicate).
    fn lower_hook_set(
        &mut self,
        record: &TypedExpr,
        changes: &TypedExpr,
        span: Span,
        pad: &str,
    ) -> Vec<(String, Span)> {
        if matches!(&record.expr, IrExpr::Member { base, field }
            if field == "after" && matches!(&base.expr, IrExpr::Name(name) if name == "event"))
        {
            let changes_text = self.lower_expr(changes);
            return vec![(
                format!(
                    "{pad}$pending={changes_text};Object.assign($candidate,$pending);Object.assign(event.after,$pending);"
                ),
                span,
            )];
        }
        let ResolvedType::Record { symbol, .. } = &record.ty else {
            self.unsupported("hook set", "staged set target is not a stored record", span);
            return vec![(
                format!(
                    "{pad}throw new Error({});",
                    js_string("hook set target has no lowering")
                ),
                span,
            )];
        };
        // Same-model backstop, including let-aliased trigger rows
        // (unreachable on clean programs: E4052 owns them).
        if self
            .hook
            .as_ref()
            .is_some_and(|hook| hook.trigger == *symbol)
        {
            self.unsupported(
                "hook set",
                "a hook cannot stage its own trigger model",
                span,
            );
            return vec![(
                format!(
                    "{pad}throw new Error({});",
                    js_string("hook set of its own model has no lowering")
                ),
                span,
            )];
        }
        let Some(target_model) = self
            .ir
            .items
            .get(symbol.0 as usize)
            .map(|item| item.canonical.clone())
        else {
            self.unsupported("hook set", "staged set target model does not resolve", span);
            return vec![(
                format!(
                    "{pad}throw new Error({});",
                    js_string("hook set target has no lowering")
                ),
                span,
            )];
        };
        let base = self.lower_expr(record);
        let changes_text = self.lower_expr(changes);
        vec![(
            format!(
                "{pad}$hookCtx.stage({{op:\"update\",model:{},id:{}.id,data:{changes_text}}});",
                js_string(&target_model),
                parenthesize_operand(&base, &record.expr)
            ),
            span,
        )]
    }

    /// Lower a guard to its boolean expression. A source `by` lowers to
    /// `check(hasRole(c, ...) || ..., 'forbidden')`; subject predicates
    /// pass the person as the third `hasRole` argument.
    pub fn lower_guard_bool(&mut self, guard: &IrGuard) -> String {
        match guard {
            IrGuard::Role(id) => {
                self.stdlib.insert("hasRole".to_string());
                format!("hasRole(c,{})", js_string(id))
            }
            IrGuard::Subject { role, person } => {
                self.stdlib.insert("hasRole".to_string());
                let person_text = self.lower_business_expr(person, "formatted guard identity");
                format!("hasRole(c,{},{person_text})", js_string(role))
            }
            IrGuard::Expr(expr) => {
                let text = self.lower_business_expr(expr, "formatted admission guard");
                parenthesize_operand(&text, &expr.expr)
            }
            IrGuard::And(guards) => guards
                .iter()
                .map(|g| match g {
                    IrGuard::Or(_) => format!("({})", self.lower_guard_bool(g)),
                    _ => self.lower_guard_bool(g),
                })
                .collect::<Vec<_>>()
                .join(" && "),
            IrGuard::Or(guards) => guards
                .iter()
                .map(|g| self.lower_guard_bool(g))
                .collect::<Vec<_>>()
                .join(" || "),
            IrGuard::Not(inner) => format!("!({})", self.lower_guard_bool(inner)),
        }
    }

    /// Lower an admission check: `check(<guards>, "forbidden")`.
    pub fn lower_admission(&mut self, guards: &[IrGuard]) -> String {
        self.stdlib.insert("check".to_string());
        let bool_text = guards
            .iter()
            .map(|g| self.lower_guard_bool(g))
            .collect::<Vec<_>>()
            .join(" && ");
        format!("check({bool_text},\"forbidden\")")
    }

    /// Source-authored captions for the actual published inputs of this form.
    /// Reuse the operation collector's writable names; declaration labels remain
    /// the sole caption authority, without a second schema or identifier fallback.
    fn form_labels_request(&mut self, node: &IrUi) -> Option<String> {
        let canonical = form_prop_text(node, "operation")?;
        let operation = self
            .ir
            .items
            .iter()
            .find(|item| item.canonical == canonical)?;
        let (owner, declarations) = match &operation.kind {
            IrItemKind::CrudOp { model, .. } => {
                let model_item = self.ir.items.get(model.0 as usize)?;
                let IrItemKind::Model { fields, .. } = &model_item.kind else {
                    return None;
                };
                (*model, fields.clone())
            }
            IrItemKind::Scenario { params, .. } => (operation.id, params.clone()),
            _ => return None,
        };
        let published = self
            .collect_operations()
            .into_iter()
            .find(|input_operation| input_operation.name == canonical)?;
        let names: BTreeSet<&str> = published
            .inputs
            .iter()
            .map(|input| input.name.as_str())
            .collect();
        let selected = node
            .props
            .iter()
            .any(|(name, _)| name == "fields")
            .then(|| {
                form_prop_fields(node, "fields")
                    .into_iter()
                    .collect::<BTreeSet<_>>()
            });
        let labels: Vec<(String, IrMessage)> = declarations
            .iter()
            .filter_map(|id| {
                let item = self.ir.items.get(id.0 as usize)?;
                if !names.contains(item.name.as_str())
                    || selected
                        .as_ref()
                        .is_some_and(|fields| !fields.contains(&item.name))
                {
                    return None;
                }
                let caption = match &item.kind {
                    IrItemKind::Field {
                        owner: field_owner,
                        label: Some(label),
                        ..
                    } if *field_owner == owner => &label.text,
                    IrItemKind::Param {
                        owner: param_owner,
                        label: Some(label),
                        ..
                    } if *param_owner == owner => label,
                    _ => return None,
                };
                Some((item.name.clone(), caption.clone()))
            })
            .collect();
        if labels.is_empty() {
            return None;
        }
        Some(format!(
            "labels:{{{}}}",
            labels
                .iter()
                .map(|(name, caption)| format!(
                    "{}:{}",
                    object_key(name),
                    self.lower_message(caption)
                ))
                .collect::<Vec<_>>()
                .join(",")
        ))
    }

    /// Lower one UI factory node: lowercase server factory, one props
    /// object (with `context`) plus a `children` array when non-empty,
    /// or `renderRow:(row,view)=>[children]` for row-scoped collections.
    /// Gated nodes lower as `cond ? node : null`.
    pub fn lower_ui(&mut self, node: &IrUi) -> String {
        self.lower_ui_ctx(node, "c")
    }

    /// Lower one UI node under an explicit context expression. Children
    /// inherit the context; row scopes thread their view name instead.
    pub fn lower_ui_ctx(&mut self, node: &IrUi, ctx: &str) -> String {
        self.lower_ui_occurrence(node, ctx, &[], None)
    }

    /// Occurrence identities thread through enclosing collection rows so
    /// repeated tabsets never share their radio group or panel identifiers.
    fn lower_ui_occurrence(
        &mut self,
        node: &IrUi,
        ctx: &str,
        occurrences: &[String],
        prepared_form: Option<&str>,
    ) -> String {
        if !is_ui_factory(&node.factory) {
            self.unsupported(
                "UI node",
                &format!(
                    "{} is not a §13 server factory (no h, native elements, hydration or stores)",
                    node.factory
                ),
                node.span,
            );
            return self.throw_expr(&format!("unknown UI factory {}", node.factory));
        }
        // The actual list factory requires an owning empty-state message.
        // Bare lists remain a language-default gap; do not invent copy or
        // publish a factory payload that fails on an authorized empty query.
        if node.factory == "list" && !node.props.iter().any(|(key, _)| key == "empty") {
            self.unsupported(
                "list UI profile",
                "ListProps.empty requires an authored empty= message; the bare-list shared default is not implemented",
                node.span,
            );
            return self.throw_expr("unsupported list UI profile: missing empty message");
        }
        // Gated containers omit the whole node when unavailable; the
        // gate reads the same scope the node renders in.
        let gate = node
            .gate
            .as_ref()
            .map(|g| self.lower_business_expr(g, "formatted UI gate"));
        self.ui.insert(node.factory.clone());
        if node.factory == "form" {
            // Preparation is synchronous. Its request expression remains in the
            // surrounding page scope so any authored awaits stay legal and ordered.
            let mut request = Vec::new();
            for (key, value) in &node.props {
                request.push(format!(
                    "{}:{}",
                    object_key(key),
                    self.lower_business_expr(value, "unclassified formatted UI prop")
                ));
            }
            if let Some(labels) = self.form_labels_request(node) {
                request.push(labels);
            }
            let mut authored = Vec::new();
            for child in &node.children {
                collect_authored_form_fields(child, &mut authored);
            }
            if !node.children.is_empty() {
                request.push(format!(
                    "authoredFields:[{}]",
                    authored
                        .iter()
                        .map(|path| js_string(path))
                        .collect::<Vec<_>>()
                        .join(",")
                ));
            }
            self.enter_scope();
            // The IIFE owns this private name; nested forms shadow it in
            // their own IIFE without consuming authored binding identities.
            let prepared = binding_ident("f", "form");
            let children = node
                .children
                .iter()
                .map(|child| self.lower_ui_occurrence(child, ctx, occurrences, Some(&prepared)))
                .collect::<Vec<_>>()
                .join(",");
            let body = if node.children.is_empty() {
                String::new()
            } else {
                let prefix = if node.children.iter().any(ui_immediate_uses_async) {
                    "async"
                } else {
                    ""
                };
                format!(",children:{prefix}()=>[{children}]")
            };
            self.exit_scope();
            self.ui.insert("text".to_string());
            let ready_props = if node.children.is_empty() {
                format!("{prepared}.props")
            } else {
                format!("{{...{prepared}.props{body}}}")
            };
            let call = format!(
                "(({prepared})=>{{if({prepared}.status!==\"ready\")return {}({{context:{ctx},values:[{prepared}.message]}});return {}({ready_props});}})({ctx}.prepareForm({{{}}}))",
                binding_ident("u", "text"),
                binding_ident("u", "form"),
                request.join(",")
            );
            return match gate {
                Some(cond) => format!("{cond} ? {call} : null"),
                None => call,
            };
        }
        if is_form_field_control(&node.factory)
            && let Some(prepared) = prepared_form
            && let Some((_, field)) = node.props.iter().find(|(key, _)| key == "field")
        {
            let mut props = vec![format!(
                "...{prepared}.field({})",
                self.lower_business_expr(field, "form input selector")
            )];
            for (key, value) in &node.props {
                if key == "field" {
                    continue;
                }
                props.push(format!(
                    "{}:{}",
                    object_key(key),
                    self.lower_business_expr(value, "unclassified formatted UI prop")
                ));
            }
            let call = format!(
                "{}({{{}}})",
                binding_ident("u", &node.factory),
                props.join(",")
            );
            return match gate {
                Some(cond) => format!("{cond} ? {call} : null"),
                None => call,
            };
        }
        let transient_tabs = node.factory == "tabs"
            && node.props.iter().any(|(key, _)| key == "id")
            && node.children.iter().all(|child| child.factory == "tabItem");
        let mut props = vec![format!("context:{ctx}")];
        for (key, value) in &node.props {
            let value = self.lower_business_expr(value, "unclassified formatted UI prop");
            let value = if transient_tabs && key == "id" && !occurrences.is_empty() {
                format!(
                    r#"{value}+"-"+encodeURIComponent(JSON.stringify([{}]))"#,
                    occurrences.join(",")
                )
            } else {
                value
            };
            props.push(format!("{}:{value}", object_key(key)));
        }
        match &node.row_scope {
            Some((row, view)) => {
                self.enter_scope();
                let row = self.bind(row);
                let child_ctx = self.bind(view);
                let mut child_occurrences = occurrences.to_vec();
                child_occurrences.push(format!("{row}.id"));
                let children = node
                    .children
                    .iter()
                    .map(|c| self.lower_ui_occurrence(c, &child_ctx, &child_occurrences, None))
                    .collect::<Vec<_>>()
                    .join(",");
                // `async` exactly when a row child awaits.
                let prefix = if node.children.iter().any(ui_uses_async) {
                    "async"
                } else {
                    ""
                };
                props.push(format!(
                    "renderRow:{prefix}({row},{child_ctx})=>{{{row}={{...{row}.fields,id:{row}.id,version:{row}.version===undefined?undefined:BigInt({row}.version)}};return [{children}];}}"
                ));
                self.exit_scope();
            }
            None => {
                // A2b: `fab` and `chatBubble` take grouped suites,
                // never `children` (their F props have no children
                // slot; shapes validated at decode).
                if transient_tabs {
                    let items = node
                        .children
                        .iter()
                        .map(|item| {
                            let gate = item
                                .gate
                                .as_ref()
                                .map(|gate| self.lower_business_expr(gate, "formatted UI gate"));
                            let mut fields = Vec::new();
                            for (key, value) in &item.props {
                                fields.push(format!(
                                    "{}:{}",
                                    object_key(key),
                                    self.lower_business_expr(
                                        value,
                                        "unclassified formatted UI prop"
                                    )
                                ));
                            }
                            // Eager arrays preserve authored depth-first evaluation:
                            // each caption then its descendants, exactly once.
                            let children = item
                                .children
                                .iter()
                                .map(|child| {
                                    self.lower_ui_occurrence(child, ctx, occurrences, prepared_form)
                                })
                                .collect::<Vec<_>>()
                                .join(",");
                            fields.push(format!("children:[{children}]"));
                            let item = format!("({{{}}})", fields.join(","));
                            match gate {
                                Some(gate) => format!("{gate}?{item}:null"),
                                None => item,
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(",");
                    props.push(format!("items:[{items}].filter(item=>item!=null)"));
                } else if node.factory == "fab" {
                    let mut kids = node.children.iter();
                    if let Some(main) = kids.next() {
                        props.push(format!(
                            "main:[{}]",
                            self.lower_ui_occurrence(main, ctx, occurrences, prepared_form)
                        ));
                    }
                    let rest: Vec<String> = kids
                        .map(|c| self.lower_ui_occurrence(c, ctx, occurrences, prepared_form))
                        .collect();
                    props.push(format!("actions:[{}]", rest.join(",")));
                } else if node.factory == "chatBubble" {
                    // Slot children group by slot name in
                    // first-seen order; non-slot children were
                    // rejected at decode and are skipped (total).
                    let mut names: Vec<&str> = Vec::new();
                    for child in &node.children {
                        if let Some(name) = crate::codegen::ir::ui_slot_name(child)
                            && !names.contains(&name)
                        {
                            names.push(name);
                        }
                    }
                    for name in names {
                        // Slots dissolve: F takes the grouped
                        // children, not `slot()` wrappers.
                        let mut group: Vec<String> = Vec::new();
                        for child in node
                            .children
                            .iter()
                            .filter(|c| crate::codegen::ir::ui_slot_name(c) == Some(name))
                        {
                            for grand in &child.children {
                                group.push(self.lower_ui_occurrence(
                                    grand,
                                    ctx,
                                    occurrences,
                                    prepared_form,
                                ));
                            }
                        }
                        props.push(format!("{}:[{}]", object_key(name), group.join(",")));
                    }
                } else if !node.children.is_empty() {
                    let children = node
                        .children
                        .iter()
                        .map(|c| self.lower_ui_occurrence(c, ctx, occurrences, prepared_form))
                        .collect::<Vec<_>>()
                        .join(",");
                    props.push(format!("children:[{children}]"));
                }
            }
        }
        let call = format!(
            "{}({{{}}})",
            binding_ident("u", &node.factory),
            props.join(",")
        );
        match gate {
            Some(cond) => format!("{cond} ? {call} : null"),
            None => call,
        }
    }

    /// Admit-bindings `preferences` member for one owning app: authoring
    /// defaults as literal JS (`preferences:{"App":{key:value}}`), or ""
    /// when the app declares no preferences with literal defaults.
    /// Computed defaults are omitted (admit returns data, never
    /// functions); pages that read an omitted key fail loud at render,
    /// exactly as pages with no preferences declaration do.
    fn admit_preferences_js(&mut self, owner: &str) -> String {
        let mut defaults = Vec::new();
        for item in &self.ir.items.clone() {
            let module_name = self.ir.module(item.module).name.clone();
            if module_name != owner {
                continue;
            }
            let fields = match &item.kind {
                IrItemKind::Preferences { fields, .. } => fields.clone(),
                _ => continue,
            };
            for field_id in &fields {
                let field = self.ir.items[field_id.0 as usize].clone();
                if let IrItemKind::Field {
                    default: Some(IrDefault::Literal(expr)),
                    ..
                } = &field.kind
                {
                    defaults.push((field.name.clone(), expr.clone()));
                }
            }
        }
        if defaults.is_empty() {
            return String::new();
        }
        let mut entries = Vec::new();
        for (name, expr) in &defaults {
            entries.push(format!(
                "{}:{}",
                object_key(name),
                self.lower_business_expr(expr, "formatted preference default")
            ));
        }
        format!(
            "preferences:{{{app}:{{{entries}}}}},",
            app = object_key(owner),
            entries = entries.join(",")
        )
    }

    /// Lower one page: descriptor const plus the named page function whose
    /// renderer reads the shared descriptor (`renderPage` never dispatches
    /// or re-runs admission).
    pub fn lower_page(&mut self, page: &IrPage, out: &mut JsWriter) {
        let descriptor = page_binding(page, "descriptor");
        let func = page_binding(page, "render");
        let mut members = vec![
            format!("owner:{}", js_string(&page.owner)),
            format!("path:{}", js_string(&page.path)),
            format!("title:{}", self.lower_message(&page.title)),
        ];
        if let Some(description) = &page.description {
            members.push(format!("description:{}", self.lower_message(description)));
        }
        if let Some(order) = page.order {
            members.push(format!("order:{order}n"));
        }
        if let Some(group) = &page.group {
            members.push(format!("group:{}", js_string(group)));
        }
        if page.nav_none {
            members.push("nav:\"none\"".to_string());
        }
        // `poll=`/`refresh=` (DESIGN §9): the cadence as exact-BigInt
        // millis plus the canonical refresh mutation. Sparse like the
        // other optional members; `admit`/`render` stay last per §13.
        if let Some(poll) = page.poll {
            members.push(format!("poll:{poll}n"));
        }
        if let Some(refresh) = &page.refresh {
            members.push(format!("refresh:{}", js_string(refresh)));
        }
        let bindings = self.admit_preferences_js(&page.owner);
        let admit_body = if page.admit.is_empty() {
            format!("async(c,routeBindings={{}})=>{{return {{{bindings}}};}}")
        } else {
            // Page admission crosses the HTTP BusinessError boundary;
            // scenario guards keep the State-owned check semantics.
            let checks = page
                .admit
                .iter()
                .map(|guard| {
                    let condition = self.lower_guard_bool(guard);
                    format!("if(!({condition}))throw {{code:\"forbidden\",message:\"forbidden\"}};")
                })
                .collect::<Vec<_>>()
                .join("");
            format!("async(c,routeBindings={{}})=>{{{checks}return {{{bindings}}};}}")
        };
        members.push(format!("admit:{admit_body}"));
        members.push(format!("render:{func}"));
        out.push(
            page.span,
            Some(format!("page {}", page.path)),
            // Exported: `artifact.pages[].export` names this binding as
            // the importable page descriptor (artifact.ts contract).
            &format!("export const {descriptor}={{{}}};", members.join(",")),
        );
        self.pages.push(JsPage {
            owner: page.owner.clone(),
            path: page.path.clone(),
            // Encoded like the emitted binding above: the envelope
            // cross-ref must name exactly what `export const` declares.
            export: page_binding(page, "descriptor"),
        });
        let children = page
            .render
            .iter()
            .map(|n| self.lower_ui(n))
            .collect::<Vec<_>>()
            .join(",");
        // Pages reading `preferences` bind the admit() record first: the
        // checkpoint returns per-app prefs inside `bindings` (never pctx).
        let preamble = if page_uses_preferences(page) {
            format!(
                "const preferences=bindings.preferences[{}];",
                js_string(&page.owner)
            )
        } else {
            String::new()
        };
        // The HTTP page owner applies the shared shell once. This function
        // renders only admitted content for both full and partial requests.
        out.push(
            page.span,
            Some(format!("page {}", page.path)),
            &format!("export async function {func}(c,bindings){{{preamble}return (await Promise.all([{children}])).filter(value=>value!=null).join('');}}"),
        );
    }
}

/// Whether rendering this node evaluates an await in the current callback.
/// Form and collection descendants execute under their own deferred callbacks.
fn ui_immediate_uses_async(node: &IrUi) -> bool {
    node.props.iter().any(|(_, value)| expr_uses_async(value))
        || node.gate.as_ref().is_some_and(expr_uses_async)
        || (node.factory != "form"
            && node.row_scope.is_none()
            && node.children.iter().any(ui_immediate_uses_async))
}

/// Whether a UI subtree awaits (state-read calls in prop values).
fn ui_uses_async(node: &IrUi) -> bool {
    node.props.iter().any(|(_, v)| expr_uses_async(v))
        || node.gate.as_ref().is_some_and(expr_uses_async)
        || node.children.iter().any(ui_uses_async)
}

/// Whether a page body references the `preferences` record.
fn page_uses_preferences(page: &IrPage) -> bool {
    fn expr_uses(expr: &TypedExpr) -> bool {
        match &expr.expr {
            IrExpr::Name(name) => name == "preferences",
            IrExpr::Member { base, .. } => expr_uses(base),
            IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } => {
                args.iter().any(expr_uses)
            }
            IrExpr::Binary { left, right, .. } => expr_uses(left) || expr_uses(right),
            IrExpr::Unary { operand, .. } => expr_uses(operand),
            IrExpr::Array(items) => items.iter().any(expr_uses),
            IrExpr::Object(entries) => entries.iter().any(|(_, v)| expr_uses(v)),
            IrExpr::Query(query) => {
                let domain_uses = match &query.domain {
                    crate::codegen::ir::IrQueryDomain::Model(_) => false,
                    crate::codegen::ir::IrQueryDomain::Value { base, .. } => expr_uses(base),
                };
                domain_uses
                    || query.parent.as_ref().is_some_and(|p| expr_uses(p))
                    || query.where_pred.as_ref().is_some_and(|p| expr_uses(p))
                    || query.limit.as_ref().is_some_and(|p| expr_uses(p))
                    || query.archived.as_ref().is_some_and(|p| expr_uses(p))
                    || query.select.as_ref().is_some_and(|p| expr_uses(p))
            }
            IrExpr::DeliveryRead { record, .. } => expr_uses(record),
            IrExpr::Message(message) => message.params.iter().any(|p| expr_uses(&p.value)),
            IrExpr::MessageCall { args, params, .. } => args
                .iter()
                .chain(params.iter().filter_map(|p| p.default.as_ref()))
                .any(expr_uses),
            IrExpr::Format { args, .. } => args.iter().any(expr_uses),
            IrExpr::HasRole { person, .. } => person.as_ref().is_some_and(|p| expr_uses(p)),
            IrExpr::Lambda { body, .. } => expr_uses(body),
            IrExpr::Int(_)
            | IrExpr::Decimal(_)
            | IrExpr::Text(_)
            | IrExpr::Bool(_)
            | IrExpr::Null
            | IrExpr::Money { .. }
            | IrExpr::DurationMs(_)
            | IrExpr::Date(_)
            | IrExpr::Datetime(_)
            | IrExpr::Unsupported { .. } => false,
        }
    }
    fn guard_uses(guard: &IrGuard) -> bool {
        match guard {
            IrGuard::Role(_) => false,
            IrGuard::Subject { person, .. } => expr_uses(person),
            IrGuard::Expr(expr) => expr_uses(expr),
            IrGuard::And(guards) | IrGuard::Or(guards) => guards.iter().any(guard_uses),
            IrGuard::Not(inner) => guard_uses(inner),
        }
    }
    fn ui_uses(node: &IrUi) -> bool {
        node.props.iter().any(|(_, v)| expr_uses(v)) || node.children.iter().any(ui_uses)
    }
    page.admit.iter().any(guard_uses) || page.render.iter().any(ui_uses)
}

/// Negate a boolean call for `!=` (`!equalMoney(a,b)`).
fn negate_call(negate: bool, call: &str) -> String {
    if negate {
        format!("!{call}")
    } else {
        call.to_string()
    }
}

/// Parenthesize an operand when it is a compound expression.
fn parenthesize_operand(text: &str, expr: &IrExpr) -> String {
    match expr {
        IrExpr::Binary { .. }
        | IrExpr::Unary { .. }
        | IrExpr::DeliveryRead { .. }
        | IrExpr::Call { .. }
        | IrExpr::BoundCall { .. } => format!("({text})"),
        _ => text.to_string(),
    }
}

/// Parenthesize `&&`/`||` operands: `||` under `&&` and any logic under a
/// different logic operator need parens.
fn parenthesize_logic(text: &str, expr: &IrExpr, parent: IrBinOp) -> String {
    match expr {
        IrExpr::Binary { op, .. } if *op == IrBinOp::Coalesce => format!("({text})"),
        IrExpr::Binary { op, .. } if *op != parent => format!("({text})"),
        IrExpr::Unary { .. } | IrExpr::DeliveryRead { .. } => format!("({text})"),
        _ => text.to_string(),
    }
}

/// Authored `crudWhen` registry key, if the operation carries admission.
fn crud_when_key(when: Option<&String>) -> Option<String> {
    when.cloned()
}

/// Registry key for one hook: the source trigger spelling
/// (`Model.delete` for deletes), unique by construction (at most one hook
/// per model/operation).
fn hook_trigger_key(ir: &IrProgram, hook: &IrHook) -> String {
    let model = ir
        .items
        .get(hook.model.0 as usize)
        .map(|item| item.canonical.clone())
        .unwrap_or_else(|| "unknown".to_string());
    format!("{model}.{}", hook.op.as_str())
}

/// Engine op spelling for one hook trigger op (`remove` for deletes).
fn hook_engine_op(op: CrudOp) -> &'static str {
    match op {
        CrudOp::Create => "create",
        CrudOp::Update => "update",
        CrudOp::Delete => "remove",
    }
}

/// Registry path segments into the module's `canApp()` return object for
/// one callable item (explicit linkage: the runtime walks these, it never
/// re-derives handler names). Scenarios and derived functions address
/// their top-level handler, hooks their `hooks` registry entry, CRUD ops
/// their generated handler, derived fields their `derives` map entry.
/// Segments stay an array because keys contain dots (`Todo.total`), so no
/// joined string is unambiguous.
fn registry_member(ir: &IrProgram, item: &IrItem) -> Vec<String> {
    match &item.kind {
        IrItemKind::Scenario { hook, .. } => {
            if let Some(hook) = hook {
                return vec![
                    "hooks".to_string(),
                    hook_trigger_key(ir, hook),
                    "run".to_string(),
                ];
            }
            vec![item.canonical.clone()]
        }
        IrItemKind::DeriveFn { .. } => {
            vec![item.canonical.clone()]
        }
        IrItemKind::CrudOp { .. } => vec![item.canonical.clone()],
        IrItemKind::DeriveField { .. } => {
            vec!["derives".to_string(), item.canonical.clone()]
        }
        _ => unreachable!("registry_member: not a callable item"),
    }
}

impl<'a> Emitter<'a> {
    /// Emit canonical user-operation identity constants: the registry
    /// holds implementations, the module exports qualified identities.
    fn emit_identity_consts(
        &mut self,
        out: &mut JsWriter,
        _entry: Option<crate::analysis::resolve::ModuleId>,
    ) {
        for item in &self.ir.items.clone() {
            let is_callable = matches!(
                item.kind,
                IrItemKind::Scenario { .. } | IrItemKind::CrudOp { .. }
            );
            if !is_callable {
                continue;
            }
            let export = binding_ident("o", &item.canonical);
            let kind = match &item.kind {
                IrItemKind::Scenario { trusted, .. } => {
                    if *trusted {
                        JsCallableKind::Handler
                    } else {
                        JsCallableKind::Operation
                    }
                }
                IrItemKind::CrudOp { .. } => JsCallableKind::Operation,
                _ => unreachable!("callable filter"),
            };
            self.callables.push(JsCallable {
                id: item.canonical.clone(),
                kind,
                export: export.clone(),
                member: registry_member(self.ir, item),
                input_style: matches!(
                    &item.kind,
                    IrItemKind::Scenario {
                        trusted: false,
                        hook: None,
                        read: false,
                        ..
                    }
                )
                .then(|| "parameters".to_string()),
                span: item.span,
            });
            out.push(
                item.span,
                Some(item.canonical.clone()),
                &format!("export const {export}={};", js_string(&item.canonical)),
            );
        }
    }

    /// Emit the `appDefinition` shape: id, uses, compositions, packages,
    /// bindings, contracts, events, models, preferences, operations, pages,
    /// disabled.
    fn emit_app_definition(
        &mut self,
        out: &mut JsWriter,
        entry: Option<crate::analysis::resolve::ModuleId>,
    ) {
        let entry_name = entry
            .map(|id| self.ir.module(id).name.clone())
            .unwrap_or_default();
        let entry_span = entry.map(|id| self.ir.module(id).span).unwrap_or(Span::new(
            crate::source::SourceId(0),
            0,
            0,
        ));
        let mut members = vec![
            format!("id:{}", js_string(&entry_name)),
            format!(
                "uses:[{}]",
                entry
                    .map(|id| self.ir.module(id).uses_resolved.clone())
                    .unwrap_or_default()
                    .iter()
                    .map(|u| js_string(u))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        ];
        if let Some(locale) = entry
            .map(|id| self.ir.module(id))
            .and_then(|module| module.app_default_locale.as_deref())
        {
            members.push(format!("appDefaultLocale:{}", js_string(locale)));
        }
        // Alternative authored app assemblies, keyed by declared identity.
        let compositions: Vec<String> = self
            .ir
            .modules
            .iter()
            .filter(|m| {
                Some(m.id) != entry
                    && matches!(m.kind, ModuleKind::ImplicitApp | ModuleKind::ComposedApp)
            })
            .map(|m| {
                let uses = m
                    .uses_resolved
                    .iter()
                    .map(|u| js_string(u))
                    .collect::<Vec<_>>()
                    .join(",");
                let locale = m
                    .app_default_locale
                    .as_deref()
                    .map_or_else(String::new, |locale| {
                        format!(",appDefaultLocale:{}", js_string(locale))
                    });
                format!("{}:{{uses:[{uses}]{locale}}}", js_string(&m.name))
            })
            .collect();
        if !compositions.is_empty() {
            members.push(format!("compositions:{{{}}}", compositions.join(",")));
        }
        if let Some(description) = entry
            .map(|id| self.ir.module(id))
            .and_then(|module| module.description.clone())
        {
            members.push(format!("description:{}", self.lower_message(&description)));
        }
        members.push(self.emit_packages_member(entry));
        members.push(self.emit_bindings_member());
        members.push(self.emit_records_member("contracts", &["Contract"]));
        members.push(self.emit_records_member("events", &["Event"]));
        members.push(self.emit_capabilities_member());
        members.push(self.emit_models_member());
        members.push(self.emit_preferences_member());
        members.push(self.emit_operations_member());
        // T34-F6: fanout cohort descriptors alongside operations. The
        // member is omitted when empty, so sources without a checked
        // `each=` cohort emit byte-identical output.
        if let Some(cohorts) = self.emit_cohorts_member() {
            members.push(cohorts);
        }
        // B3-I5: form descriptors + policy manifest alongside grants. Both
        // members are omitted when empty, so sources without page forms or
        // policy content emit byte-identical output.
        if let Some(forms) = self.emit_forms_member() {
            members.push(forms);
        }
        if let Some(policy) = self.emit_policy_member() {
            members.push(policy);
        }
        members.push(self.emit_pages_member());
        members.push(self.emit_disabled_member());
        out.push(
            entry_span,
            Some("appDefinition".to_string()),
            &format!("export const appDefinition={{{}}};", members.join(",")),
        );
    }

    /// Emit the `packages` member: descriptions plus roles with canonical
    /// ids and labels.
    fn emit_packages_member(
        &mut self,
        entry: Option<crate::analysis::resolve::ModuleId>,
    ) -> String {
        let mut packages = Vec::new();
        for module in &self.ir.modules.clone() {
            let mut members = Vec::new();
            // The entry module's description is the app description; other
            // modules carry theirs in the packages member.
            if Some(module.id) != entry
                && let Some(description) = module.description.clone()
            {
                members.push(format!("description:{}", self.lower_message(&description)));
            }
            let role_items: Vec<_> = self
                .ir
                .items
                .iter()
                .filter(|item| {
                    item.module == module.id && matches!(item.kind, IrItemKind::Role { .. })
                })
                .cloned()
                .collect();
            let roles: Vec<String> = role_items
                .iter()
                .map(|item| {
                    let mut role = format!("id:{}", js_string(&item.canonical));
                    if let IrItemKind::Role { label: Some(label) } = &item.kind {
                        role.push_str(&format!(",label:{}", self.lower_message(label)));
                    }
                    if item.exported {
                        role.push_str(",exported:true");
                    }
                    format!("{}:{{{role}}}", object_key(&item.name))
                })
                .collect();
            members.push(format!("roles:{{{}}}", roles.join(",")));
            packages.push(format!(
                "{}:{{{}}}",
                object_key(&module.name),
                members.join(",")
            ));
        }
        format!("packages:{{{}}}", packages.join(","))
    }

    /// Emit the `bindings` member from bound imports: the binding records
    /// capability and deployment source without copying operation lists.
    fn emit_bindings_member(&self) -> String {
        let mut bindings = Vec::new();
        for module in &self.ir.modules.clone() {
            for import in &module.imports.clone() {
                let Some(from) = import.from.clone() else {
                    continue;
                };
                for (name, alias, _span) in import.members.clone() {
                    let key = format!("{}.{}", module.name, alias);
                    bindings.push(format!(
                        "{}:{{capability:{},from:{}}}",
                        js_string(&key),
                        js_string(&format!("{}.{}", import.provider, name)),
                        js_string(&from)
                    ));
                }
            }
        }
        format!("bindings:{{{}}}", bindings.join(","))
    }

    /// Emit the `contracts`/`events` member: labels plus full field
    /// schemas.
    fn emit_records_member(&mut self, member: &str, kinds: &[&str]) -> String {
        let mut records = Vec::new();
        for item in &self.ir.items.clone() {
            let (fields, label) = match &item.kind {
                IrItemKind::Contract { fields, label } if kinds.contains(&"Contract") => {
                    (fields.clone(), label.clone())
                }
                IrItemKind::Event { fields } if kinds.contains(&"Event") => (fields.clone(), None),
                _ => continue,
            };
            let mut members = Vec::new();
            if item.exported {
                members.push("exported:true".to_string());
            }
            if let Some(label) = label {
                members.push(format!("label:{}", self.lower_message(&label)));
            }
            members.push(self.emit_fields_schema(&fields));
            records.push(format!(
                "{}:{{{}}}",
                js_string(&item.canonical),
                members.join(",")
            ));
        }
        format!("{member}:{{{}}}", records.join(","))
    }

    /// Emit the `capabilities` member: versions plus declared events.
    fn emit_capabilities_member(&mut self) -> String {
        let mut capabilities = Vec::new();
        for item in &self.ir.items.clone() {
            let (events, version) = match &item.kind {
                IrItemKind::Capability {
                    events, version, ..
                } => (events.clone(), *version),
                _ => continue,
            };
            let mut members = Vec::new();
            if item.exported {
                members.push("exported:true".to_string());
            }
            if let Some(version) = version {
                members.push(format!("version:{version}n"));
            }
            if !events.is_empty() {
                let mut entries = Vec::new();
                for event_id in &events {
                    let event = self.ir.items[event_id.0 as usize].clone();
                    let fields = match &event.kind {
                        IrItemKind::Event { fields } => fields.clone(),
                        _ => continue,
                    };
                    entries.push(format!(
                        "{}:{{{}}}",
                        object_key(&event.name),
                        self.emit_fields_schema(&fields)
                    ));
                }
                members.push(format!("events:{{{}}}", entries.join(",")));
            }
            capabilities.push(format!(
                "{}:{{{}}}",
                js_string(&item.canonical),
                members.join(",")
            ));
        }
        format!("capabilities:{{{}}}", capabilities.join(","))
    }

    /// Emit the `models` member: ownership, labels, rule references,
    /// retention and full field schemas.
    fn emit_models_member(&mut self) -> String {
        let mut models = Vec::new();
        for item in &self.ir.items.clone() {
            let (fields, owner, label, grants, invariants, locks, uniques, retain) =
                match &item.kind {
                    IrItemKind::Model {
                        fields,
                        owner,
                        label,
                        grants,
                        invariants,
                        locks,
                        uniques,
                        retain,
                        ..
                    } => (
                        fields.clone(),
                        *owner,
                        label.clone(),
                        grants.clone(),
                        invariants.clone(),
                        locks.clone(),
                        uniques.clone(),
                        retain.clone(),
                    ),
                    _ => continue,
                };
            let mut members = Vec::new();
            if item.exported {
                members.push("exported:true".to_string());
            }
            match owner {
                crate::codegen::ir::IrOwner::Team => {}
                crate::codegen::ir::IrOwner::ChildOf(parent) => {
                    members.push(format!(
                        "parent:{}",
                        js_string(&self.ir.items[parent.0 as usize].canonical.clone())
                    ));
                }
                crate::codegen::ir::IrOwner::App => {
                    members.push("scope:\"app\"".to_string());
                }
            }
            if let Some(label) = label {
                members.push(format!("label:{}", self.lower_message(&label)));
            }
            if !invariants.is_empty() {
                members.push(format!(
                    "invariants:[{}]",
                    invariants
                        .iter()
                        .map(|id| js_string(id))
                        .collect::<Vec<_>>()
                        .join(",")
                ));
            }
            if !locks.is_empty() {
                members.push(format!(
                    "locks:[{}]",
                    locks
                        .iter()
                        .map(|id| js_string(id))
                        .collect::<Vec<_>>()
                        .join(",")
                ));
            }
            // Always present: no grant broadens silently.
            let entries: Vec<String> = grants
                .iter()
                .map(|grant| {
                    let mut grant_members = vec![format!("rule:{}", js_string(&grant.rule))];
                    if !grant.fields.is_empty() {
                        grant_members.push(format!(
                            "fields:[{}]",
                            grant
                                .fields
                                .iter()
                                .map(|f| js_string(f))
                                .collect::<Vec<_>>()
                                .join(",")
                        ));
                    }
                    let mut rules = self
                        .ir
                        .read_rules
                        .iter()
                        .filter(|rule| rule.id == grant.rule);
                    // Legacy rule ids use the bare model name. Ambiguous
                    // ids cannot establish which checked predicate owns
                    // this grant, so keep them registry-only as well.
                    if let Some(rule) = rules.next()
                        && rules.next().is_none()
                        && let Some(role) = actor_read_role(&rule.pred)
                    {
                        grant_members.push(format!("by:[{}]", js_string(role)));
                    }
                    format!("{{{}}}", grant_members.join(","))
                })
                .collect();
            members.push(format!("readGrants:[{}]", entries.join(",")));
            if retain.is_some() {
                members.push(format!("retainUntil:{}", js_string(&item.name)));
            }
            // A2b: sparse `uniques` member; each entry inherits the
            // enclosing model entry scope (explicit `parent`/`app`
            // or the default team scope — no scope tag). The
            // `where` id references the `Model.unique.N` rule
            // registered beside the invariants.
            if !uniques.is_empty() {
                let entries: Vec<String> = uniques
                    .iter()
                    .enumerate()
                    .map(|(index, unique)| {
                        let fields = unique
                            .fields
                            .iter()
                            .map(|f| js_string(f))
                            .collect::<Vec<_>>()
                            .join(",");
                        match unique.where_predicate {
                            Some(_) => format!(
                                "{{fields:[{fields}],where:{}}}",
                                js_string(&format!("{}.unique.{}", item.name, index + 1))
                            ),
                            None => format!("{{fields:[{fields}]}}"),
                        }
                    })
                    .collect();
                members.push(format!("uniques:[{}]", entries.join(",")));
            }
            for field_id in &fields {
                let Some(field) = self.ir.items.get(field_id.0 as usize) else {
                    continue;
                };
                if let IrItemKind::Field {
                    ty: IrType::Known(ty),
                    default: Some(default @ IrDefault::Computed { .. }),
                    ..
                } = &field.kind
                    && matches!(
                        checked_value_profile(ty),
                        Some("money" | "money?" | "money[]" | "money[]?")
                    )
                    && js_field_default(Some(default), None).is_none()
                {
                    self.unsupported(
                        "money model default",
                        "computed money defaults have no artifact wire lowering; the declared default cannot be omitted",
                        field.span,
                    );
                }
            }
            members.push(self.emit_fields_schema(&fields));
            let derived = self.emit_derived_member(item.id);
            if let Some(derived) = derived {
                members.push(derived);
            }
            models.push(format!(
                "{}:{{{}}}",
                js_string(&item.canonical),
                members.join(",")
            ));
        }
        format!("models:{{{}}}", models.join(","))
    }

    /// Emit the `derived:{...}` member for one model's derived fields, if
    /// it has any.
    fn emit_derived_member(&mut self, model: crate::analysis::resolve::SymbolId) -> Option<String> {
        let mut entries = Vec::new();
        for item in &self.ir.items.clone() {
            let (ty, label) = match &item.kind {
                IrItemKind::DeriveField {
                    model: m,
                    ty,
                    label,
                    ..
                } if *m == model => (ty.clone(), label.clone()),
                _ => continue,
            };
            // Derived fields never carry the field-only `!` (T09):
            // their arrays are ordinary.
            let mut members = match ty {
                IrType::Known(resolved) => self.field_schema_object(&resolved, false, item.span),
                IrType::Unknown => "type:\"unknown\"".to_string(),
            };
            members.push_str(&format!(
                ",handler:{}",
                js_string(&format!(
                    "{}.{}",
                    self.ir.items[model.0 as usize].name.clone(),
                    item.name
                ))
            ));
            if let Some(label) = label {
                members.push_str(&format!(",label:{}", self.lower_field_label(&label)));
            }
            entries.push(format!("{}:{{{members}}}", object_key(&item.name)));
        }
        if entries.is_empty() {
            None
        } else {
            Some(format!("derived:{{{}}}", entries.join(",")))
        }
    }

    /// Emit `fields:{...}` for one record owner: base schemas plus
    /// modifiers, defaults, server initializers and labels.
    ///
    /// Unknown types already carry an `E6006` from the IR build; the
    /// placeholder stays silent here to avoid a cascade.
    fn emit_fields_schema(&mut self, fields: &[crate::analysis::resolve::SymbolId]) -> String {
        let mut parts = Vec::new();
        for field_id in fields {
            let field = self.ir.items[field_id.0 as usize].clone();
            parts.push(self.emit_one_field_schema(&field));
        }
        format!("fields:{{{}}}", parts.join(","))
    }

    /// Lower a field caption: a plain message, or `{text, values}` for
    /// enum/bool case captions.
    fn lower_field_label(&mut self, label: &IrFieldLabel) -> String {
        if label.values.is_empty() {
            return self.lower_message(&label.text);
        }
        let values = label
            .values
            .iter()
            .map(|(case, caption)| format!("{}:{}", object_key(case), self.lower_message(caption)))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{text:{},values:{{{values}}}}}",
            self.lower_message(&label.text)
        )
    }

    /// Emit the `preferences` member: per-package preference schemas
    /// plus validators.
    fn emit_preferences_member(&mut self) -> String {
        let mut packages = Vec::new();
        for module in &self.ir.modules.clone() {
            let mut fields = Vec::new();
            let mut validate = None;
            for item in &self.ir.items.clone() {
                let (pref_fields, pref_validate) = match &item.kind {
                    IrItemKind::Preferences { fields, validate } if item.module == module.id => {
                        (fields.clone(), validate.clone())
                    }
                    _ => continue,
                };
                if pref_validate.is_some() {
                    validate = pref_validate;
                }
                for field_id in &pref_fields {
                    let field = self.ir.items[field_id.0 as usize].clone();
                    if let IrItemKind::Field { .. } = &field.kind {
                        fields.push(self.emit_one_field_schema(&field));
                    }
                }
            }
            if !fields.is_empty() {
                let mut members = Vec::new();
                if let Some(validate) = validate {
                    members.push(format!("validate:{}", js_string(&validate)));
                }
                members.push(format!("fields:{{{}}}", fields.join(",")));
                packages.push(format!(
                    "{}:{{{}}}",
                    object_key(&module.name),
                    members.join(",")
                ));
            }
        }
        format!("preferences:{{{}}}", packages.join(","))
    }

    /// Emit one `name:{schema}` field entry with full slots.
    fn emit_one_field_schema(&mut self, field: &crate::codegen::ir::IrItem) -> String {
        let (ty, required_array, default, server, modifiers, label) = match &field.kind {
            IrItemKind::Field {
                ty,
                required_array,
                default,
                server,
                modifiers,
                label,
                ..
            } => (
                Some(ty.clone()),
                *required_array,
                default.clone(),
                server.clone(),
                Some(modifiers.clone()),
                label.clone(),
            ),
            _ => (None, false, None, None, None, None),
        };
        let mut members = match ty {
            Some(IrType::Known(resolved)) => {
                self.field_schema_object(&resolved, required_array, field.span)
            }
            _ => "type:\"unknown\"".to_string(),
        };
        if let Some(modifiers) = modifiers {
            if modifiers.trim {
                members.push_str(",trim:true");
            }
            if modifiers.machine
                && let Some(machine) = self.machine_for(field)
            {
                members.push_str(&format!(",machine:{}", descriptor_json(&machine)));
            }
            if modifiers.unique {
                members.push_str(",unique:true");
            }
            if let Some(min) = &modifiers.min {
                members.push_str(&format!(
                    ",min:{}",
                    self.lower_business_expr(min, "formatted field bound")
                ));
            }
            if let Some(max) = &modifiers.max {
                members.push_str(&format!(
                    ",max:{}",
                    self.lower_business_expr(max, "formatted field bound")
                ));
            }
        }
        if let Some(default) = &default {
            members.push_str(&format!(",default:{}", self.lower_default(default)));
        }
        if let Some(server) = &server {
            members.push_str(&format!(",server:{}", self.lower_server(server)));
        }
        if let Some(label) = &label {
            members.push_str(&format!(",label:{}", self.lower_field_label(label)));
        }
        format!("{}:{{{members}}}", object_key(&field.name))
    }

    /// Emit the `operations` member: scenario metadata (handler, `by`,
    /// `read`, inputs, result, captions) and generated CRUD entries
    /// (handler, kind, model, field allowlists, `when`, captions).
    fn emit_operations_member(&mut self) -> String {
        let mut operations = Vec::new();
        for item in &self.ir.items.clone() {
            match &item.kind {
                // Hooks are reactive, not operations: their descriptor lives
                // in the `hooks` registry, so they contribute no entry here.
                IrItemKind::Scenario { hook: Some(_), .. } => {}
                IrItemKind::Scenario {
                    params,
                    result,
                    read,
                    by,
                    label,
                    description,
                    ..
                } => {
                    let inputs = self.emit_params_schema(params);
                    let mut members = vec![
                        format!("handler:{}", js_string(&item.canonical)),
                        format!("inputs:{{{inputs}}}"),
                    ];
                    if let Some(by) = self.by_member(by, item.span) {
                        members.push(format!("by:{by}"));
                    }
                    members.push(format!("read:{}", if *read { "true" } else { "false" }));
                    if let Some(result) = result {
                        members.push(format!("result:{}", self.field_schema(result, item.span)));
                    }
                    if let Some(label) = label {
                        members.push(format!("label:{}", self.lower_message(label)));
                    }
                    if let Some(description) = description {
                        members.push(format!("description:{}", self.lower_message(description)));
                    }
                    if item.exported {
                        members.push("exported:true".to_string());
                    }
                    operations.push(format!(
                        "{}:{{{}}}",
                        js_string(&item.canonical),
                        members.join(",")
                    ));
                }
                IrItemKind::CrudOp {
                    model,
                    op,
                    by,
                    has_when,
                    fields,
                    label,
                    expose_excluded,
                    ..
                } => {
                    let model_item = self.ir.items[model.0 as usize].clone();
                    let handler = item.canonical.clone();
                    let kind = match op {
                        CrudOp::Create => "create",
                        CrudOp::Update => "update",
                        CrudOp::Delete => "delete",
                    };
                    let allowlist = fields
                        .iter()
                        .map(|f| js_string(f))
                        .collect::<Vec<_>>()
                        .join(",");
                    let inputs = match op {
                        CrudOp::Create => format!("fields:[{allowlist}]"),
                        CrudOp::Update => format!(
                            "record:{{type:{}}},changes:{{fields:[{allowlist}]}}",
                            js_string(&model_item.canonical)
                        ),
                        CrudOp::Delete => {
                            format!("record:{{type:{}}}", js_string(&model_item.canonical))
                        }
                    };
                    let mut members = vec![
                        format!("handler:{}", js_string(&handler)),
                        format!("kind:{kind}", kind = js_string(kind)),
                        format!("model:{}", js_string(&model_item.canonical)),
                        "read:false".to_string(),
                        format!("inputs:{{{inputs}}}"),
                    ];
                    if let Some(by) = self.by_member(by, item.span) {
                        members.push(format!("by:{by}"));
                    }
                    if *has_when {
                        members.push(format!("when:{}", js_string(&model_item.name)));
                    }
                    if let Some(label) = label {
                        members.push(format!("label:{}", self.lower_message(label)));
                    }
                    if *expose_excluded {
                        members.push("expose:false".to_string());
                    }
                    if item.exported {
                        members.push("exported:true".to_string());
                    }
                    operations.push(format!(
                        "{}:{{{}}}",
                        js_string(&item.canonical),
                        members.join(",")
                    ));
                }
                _ => {}
            }
        }
        format!("operations:{{{}}}", operations.join(","))
    }

    /// Emit the `cohorts` member (T34-F6): one static fanout cohort
    /// descriptor per scenario with a checked `each=` cohort, keyed by
    /// canonical handler identity in source order. `kind`/`model` mirror
    /// F1 `FanoutCohortKind` plus the canonical model; anchored cohorts
    /// add the event-rooted `parent` path; `bind` is the `as` child
    /// binding (`null` when the header omits it). The F7 runtime join
    /// resolves owner + parent id at trigger time into an F5
    /// `FanoutCohortSpec`. `None` when no checked cohort exists, so
    /// sources without fanout emit byte-identical output.
    fn emit_cohorts_member(&self) -> Option<String> {
        let mut cohorts = Vec::new();
        for item in &self.ir.items {
            let IrItemKind::Scenario {
                cohort: Some(cohort),
                ..
            } = &item.kind
            else {
                continue;
            };
            let model = &self.ir.items[cohort.model.0 as usize];
            let mut members = vec![
                format!("kind:{}", js_string(cohort.kind.as_str())),
                format!("model:{}", js_string(&model.canonical)),
            ];
            if let Some(parent) = &cohort.parent {
                members.push(format!("parent:{}", js_string(parent)));
            }
            match &cohort.bind {
                Some(bind) => members.push(format!("bind:{}", js_string(bind))),
                None => members.push("bind:null".to_string()),
            }
            cohorts.push(format!(
                "{}:{{{}}}",
                js_string(&item.canonical),
                members.join(",")
            ));
        }
        if cohorts.is_empty() {
            return None;
        }
        Some(format!("cohorts:{{{}}}", cohorts.join(",")))
    }

    /// Emit the `forms` member: one descriptor per page `form` node in
    /// source order (`page`, `operation`, `fields`, `display?`). Field
    /// entries are input names; types/labels join from the `operations`
    /// input schemas at runtime. `None` when no page form resolves to an
    /// operation (unresolvable targets stay loud in the page lowering,
    /// never guessed here).
    fn emit_forms_member(&self) -> Option<String> {
        let mut usages = Vec::new();
        for module in &self.ir.modules {
            for page in &module.pages {
                for node in &page.render {
                    collect_form_usages(node, &page.path, &mut usages);
                }
            }
        }
        if usages.is_empty() {
            return None;
        }
        let entries: Vec<String> = usages
            .iter()
            .map(|usage| {
                let fields = usage
                    .fields
                    .iter()
                    .map(|f| js_string(f))
                    .collect::<Vec<_>>()
                    .join(",");
                let mut members = vec![
                    format!("page:{}", js_string(&usage.page)),
                    format!("operation:{}", js_string(&usage.operation)),
                    format!("fields:[{fields}]"),
                ];
                if let Some(display) = &usage.display {
                    members.push(format!("display:{}", js_string(display)));
                }
                format!("{{{}}}", members.join(","))
            })
            .collect();
        Some(format!("forms:[{}]", entries.join(",")))
    }

    /// Emit the `policy` member: the introspection-friendly policy
    /// manifest alongside grants — declared roles, per-model rule
    /// registries, and per-operation admission summaries. `None` when no
    /// policy content exists (no roles, grants, invariants, locks, or
    /// operation gates).
    fn emit_policy_member(&self) -> Option<String> {
        let roles: Vec<String> = self
            .ir
            .items
            .iter()
            .filter(|item| matches!(item.kind, IrItemKind::Role { .. }))
            .map(|item| js_string(&item.canonical))
            .collect();
        let mut models = Vec::new();
        for item in &self.ir.items {
            let IrItemKind::Model {
                grants,
                invariants,
                locks,
                ..
            } = &item.kind
            else {
                continue;
            };
            if grants.is_empty() && invariants.is_empty() && locks.is_empty() {
                continue;
            }
            let mut members = Vec::new();
            if !grants.is_empty() {
                let rules = grants
                    .iter()
                    .map(|grant| js_string(&grant.rule))
                    .collect::<Vec<_>>()
                    .join(",");
                members.push(format!("read:[{rules}]"));
                // B7 phase-1: explicit-public provenance, sparse like
                // `read` (omitted when no grant is unconditionally
                // public, so existing output is byte-identical).
                let public = grants
                    .iter()
                    .filter(|grant| grant.public)
                    .map(|grant| js_string(&grant.rule))
                    .collect::<Vec<_>>();
                if !public.is_empty() {
                    members.push(format!("public:[{}]", public.join(",")));
                }
            }
            if !invariants.is_empty() {
                let ids = invariants
                    .iter()
                    .map(|id| js_string(id))
                    .collect::<Vec<_>>()
                    .join(",");
                members.push(format!("invariants:[{ids}]"));
            }
            if !locks.is_empty() {
                let ids = locks
                    .iter()
                    .map(|id| js_string(id))
                    .collect::<Vec<_>>()
                    .join(",");
                members.push(format!("locks:[{ids}]"));
            }
            models.push(format!(
                "{}:{{{}}}",
                js_string(&item.canonical),
                members.join(",")
            ));
        }
        let mut operations = Vec::new();
        for item in &self.ir.items {
            match &item.kind {
                IrItemKind::Scenario { by, guards, .. } => {
                    let (spellings, gated) = guard_spellings(by);
                    let entry = operation_policy_entry(&spellings, gated, guards.len(), false);
                    if let Some(entry) = entry {
                        operations.push(format!("{}:{entry}", js_string(&item.canonical)));
                    }
                }
                IrItemKind::CrudOp { by, has_when, .. } => {
                    let (spellings, gated) = guard_spellings(by);
                    let entry = operation_policy_entry(&spellings, gated, 0, *has_when);
                    if let Some(entry) = entry {
                        operations.push(format!("{}:{entry}", js_string(&item.canonical)));
                    }
                }
                _ => {}
            }
        }
        if roles.is_empty() && models.is_empty() && operations.is_empty() {
            return None;
        }
        Some(format!(
            "policy:{{roles:[{}],models:{{{}}},operations:{{{}}}}}",
            roles.join(","),
            models.join(","),
            operations.join(",")
        ))
    }

    /// The `by:` member for one admission gate: the role spelling for a
    /// single gate, or a loud `E6008` (the handler still enforces the
    /// full gate).
    fn by_member(&mut self, by: &[IrGuard], span: Span) -> Option<String> {
        let [guard] = by else {
            if by.is_empty() {
                return None;
            }
            self.unsupported(
                "by admission",
                "compound gates have no operations-member lowering",
                span,
            );
            return None;
        };
        match guard {
            IrGuard::Role(id) => Some(js_string(id)),
            _ => {
                self.unsupported(
                    "by admission",
                    "expression gates have no operations-member lowering",
                    span,
                );
                None
            }
        }
    }

    /// Emit `name:{schema}` entries for scenario/capability parameters,
    /// with labels and literal defaults.
    fn emit_params_schema(&mut self, params: &[crate::analysis::resolve::SymbolId]) -> String {
        let mut parts = Vec::new();
        for param_id in params {
            // Never direct-index: a dangling row (unreachable from the
            // 1:1 IR build) drops the entry instead of panicking.
            let Some(param) = self.ir.items.get(param_id.0 as usize).cloned() else {
                continue;
            };
            if let IrItemKind::Param {
                ty, default, label, ..
            } = &param.kind
            {
                // Unknown types already carry an `E6006` from the IR
                // build; the placeholder stays silent here. Parameters
                // never carry the field-only `!` (GRAMMAR L183), so
                // their arrays are ordinary (T09).
                let mut members = match ty {
                    IrType::Known(resolved) => {
                        self.field_schema_object(resolved, false, param.span)
                    }
                    IrType::Unknown => "type:\"unknown\"".to_string(),
                };
                if let Some(default) = default {
                    match default {
                        IrDefault::Literal(_) => {
                            members.push_str(&format!(",default:{}", self.lower_default(default)));
                        }
                        IrDefault::Computed { .. } => {
                            self.unsupported(
                                "parameter default",
                                "computed parameter defaults have no §13 lowering",
                                param.span,
                            );
                        }
                    }
                }
                if let Some(label) = label {
                    members.push_str(&format!(",label:{}", self.lower_message(label)));
                }
                parts.push(format!("{}:{{{members}}}", object_key(&param.name)));
            }
        }
        parts.join(",")
    }

    /// Emit the `pages` member: descriptor references in source order.
    fn emit_pages_member(&self) -> String {
        let mut pages = Vec::new();
        for module in &self.ir.modules {
            for page in &module.pages {
                pages.push(page_binding(page, "descriptor"));
            }
        }
        format!("pages:[{}]", pages.join(","))
    }

    /// Emit the `disabled` member: every `Model.create/update/delete`
    /// identity without a generated operation, in declaration order.
    fn emit_disabled_member(&self) -> String {
        let mut generated = BTreeSet::new();
        for item in &self.ir.items {
            if matches!(item.kind, IrItemKind::CrudOp { .. }) {
                generated.insert(item.canonical.clone());
            }
        }
        let mut disabled = Vec::new();
        for item in &self.ir.items {
            if !matches!(item.kind, IrItemKind::Model { .. }) {
                continue;
            }
            for op in ["create", "update", "delete"] {
                let identity = format!("{}.{}", item.canonical, op);
                if !generated.contains(&identity) {
                    disabled.push(js_string(&identity));
                }
            }
        }
        format!("disabled:[{}]", disabled.join(","))
    }

    /// Emit the `canApp()` callable-registry factory: the shared
    /// `crudWhen` admission map, rule registries (`read`, `invariants`,
    /// `locks`, `retention`, `preferencesValid`), derives and operation
    /// handlers. Operation handlers without a decoded body keep a failing
    /// stub (`E6006` covers each); named pure derives stay named
    /// functions.
    /// Collect user-invocable operation descriptors in IR item order:
    /// untrusted scenarios plus generated CRUD ops. Trusted scenarios are
    /// event handlers (the `{event}` signature), not user operations, so
    /// they are skipped.
    ///
    /// Descriptors are fail-closed metadata: they never block compilation
    /// and never advertise a skewed schema. An operation with ANY input
    /// that has no MCP mapping (compound values, `duration`, `json`,
    /// `bytes`, nested arrays, or a dangling IR row) — or whose inputs
    /// would repeat a name — is omitted from the descriptors entirely: no
    /// diagnostic, no partial entry. A partial entry would advertise a
    /// closed schema that rejects valid calls; absence simply leaves the
    /// operation off the MCP tool list while HTTP/browser invocation is
    /// unaffected.
    ///
    /// T15a carries the full T04a pilot scope: array inputs map to their
    /// element kind plus the T09 `array` marker (T09 omission agreement:
    /// a defaulted input fills its default, a nullable input fills null,
    /// an ordinary array fills empty; only a non-nullable singular input
    /// without a default — or a required `!` array without one — is
    /// caller-required). Inputs also carry `nullable` and the
    /// representable source `default` (update changes stay partial and
    /// default-less: omission means unchanged).
    ///
    /// Input descriptions are the checked description source text (D03):
    /// inline/attached/shared/legacy spellings feed one slot and MCP
    /// renders its source string on this same path; variants stay out
    /// of the descriptors (localized MCP is deferred).
    fn collect_operations(&self) -> Vec<JsOperation> {
        let mut operations = Vec::new();
        for item in &self.ir.items {
            match &item.kind {
                IrItemKind::Model { grants, .. } => {
                    // One no-input read descriptor per policy-bearing
                    // model (P4 follow-up): `policy Model read=`
                    // publishes `package.Model.read` so denied reads
                    // answer denied-not-unknown. Policies carry no
                    // caption source, so the description stays empty.
                    if grants.is_empty() {
                        continue;
                    }
                    operations.push(JsOperation {
                        name: format!("{}.read", item.canonical),
                        kind: JsOperationKind::Read,
                        description: String::new(),
                        inputs: Vec::new(),
                        result: None,
                    });
                }
                IrItemKind::Scenario {
                    params,
                    read,
                    trusted,
                    description,
                    expose_excluded,
                    result,
                    ..
                } => {
                    if *trusted {
                        continue;
                    }
                    // `expose=none` excludes the operation from
                    // publication (P4); omission exposes it.
                    if *expose_excluded {
                        continue;
                    }
                    let mut inputs = Vec::new();
                    let mut mappable = true;
                    for param_id in params {
                        // Never direct-index: a dangling row omits the
                        // operation instead of panicking.
                        let Some(param) = self.ir.items.get(param_id.0 as usize) else {
                            mappable = false;
                            break;
                        };
                        let IrItemKind::Param {
                            ty,
                            default,
                            description,
                            ..
                        } = &param.kind
                        else {
                            mappable = false;
                            break;
                        };
                        let nullable = matches!(ty, IrType::Known(ResolvedType::Nullable(_)));
                        match self.mcp_field_for_type(ty, !*read) {
                            // Parameters never carry the field-only `!`
                            // (GRAMMAR L183), so parameter arrays are
                            // always ordinary: omission fills empty and
                            // the marker renders `required: false`.
                            Some((field, is_array)) => inputs.push(JsOperationField {
                                name: param.name.clone(),
                                field,
                                value_type: checked_string_value_type(ty),
                                required: default.is_none() && !nullable && !is_array,
                                nullable,
                                array_required: is_array.then_some(false),
                                default: js_field_default(default.as_ref(), None),
                                description: description.clone(),
                            }),
                            None => {
                                mappable = false;
                                break;
                            }
                        }
                    }
                    if !mappable || has_duplicate_names(&inputs) {
                        continue;
                    }
                    operations.push(JsOperation {
                        name: item.canonical.clone(),
                        kind: if *read {
                            JsOperationKind::Read
                        } else {
                            JsOperationKind::Scenario
                        },
                        description: description
                            .as_ref()
                            .map(|message| message.source.clone())
                            .unwrap_or_default(),
                        inputs,
                        result: checked_scenario_result(result.as_ref()),
                    });
                }
                IrItemKind::CrudOp {
                    model,
                    op,
                    fields,
                    label,
                    expose_excluded,
                    ..
                } => {
                    // The owner's `expose=` allowlist excludes unlisted
                    // operations from publication (P4 follow-up);
                    // omission permits all enabled operations.
                    if *expose_excluded {
                        continue;
                    }
                    let kind = match op {
                        CrudOp::Create => JsOperationKind::Create,
                        CrudOp::Update => JsOperationKind::Update,
                        CrudOp::Delete => JsOperationKind::Delete,
                    };
                    let Some(model_item) = self.ir.items.get(model.0 as usize) else {
                        continue;
                    };
                    let IrItemKind::Model {
                        fields: model_fields,
                        owner,
                        ..
                    } = &model_item.kind
                    else {
                        continue;
                    };
                    // The allowlist holds dotted paths; top-level inputs
                    // match on the first segment. An empty allowlist means
                    // every caller-provided field (defensive: analysis
                    // requires `fields=`).
                    let allowlist: Option<BTreeSet<&str>> = if fields.is_empty() {
                        None
                    } else {
                        Some(
                            fields
                                .iter()
                                .map(|path| path.split('.').next().unwrap_or(""))
                                .collect(),
                        )
                    };
                    let mut flat = Vec::new();
                    let mut mappable = true;
                    for field_id in model_fields {
                        let Some(field_item) = self.ir.items.get(field_id.0 as usize) else {
                            mappable = false;
                            break;
                        };
                        // Derived fields ride the model's field list
                        // (resolve) but are never caller-provided: always
                        // skip, even under an empty allowlist. (T15a
                        // repair: the old match-first order omitted EVERY
                        // CRUD operation — including delete, whose gate is
                        // shared — for any model carrying a derive.)
                        if matches!(field_item.kind, IrItemKind::DeriveField { .. }) {
                            continue;
                        }
                        if let Some(allow) = &allowlist
                            && !allow.contains(field_item.name.as_str())
                        {
                            continue;
                        }
                        let IrItemKind::Field {
                            ty,
                            required_array,
                            default,
                            server,
                            description,
                            ..
                        } = &field_item.kind
                        else {
                            mappable = false;
                            break;
                        };
                        // `server=`-owned fields are never caller-provided
                        // (analysis E3009 also bars them from allowlists).
                        if server.is_some() {
                            continue;
                        }
                        let nullable = matches!(ty, IrType::Known(ResolvedType::Nullable(_)));
                        match self.mcp_field_for_type(ty, true) {
                            Some((field, is_array)) => {
                                // The T09 marker is the spelling alone:
                                // ordinary arrays omit to empty (never
                                // caller-required), required `!` arrays
                                // reject omission when no default fills
                                // it. (Derived fields never reach here:
                                // they are separate IR items, not model
                                // fields.)
                                let array_required = is_array.then_some(*required_array);
                                let required = default.is_none()
                                    && !nullable
                                    && !(is_array && !required_array);
                                flat.push(JsOperationField {
                                    name: field_item.name.clone(),
                                    field,
                                    value_type: checked_string_value_type(ty),
                                    required,
                                    nullable,
                                    array_required,
                                    default: js_field_default(default.as_ref(), None),
                                    description: description.clone(),
                                });
                            }
                            None => {
                                mappable = false;
                                break;
                            }
                        }
                    }
                    if !mappable {
                        continue;
                    }
                    let record = || JsOperationField {
                        name: "record".to_string(),
                        value_type: None,
                        field: JsMcpField::Ref {
                            model: model_item.canonical.clone(),
                            require_version: true,
                        },
                        required: true,
                        nullable: false,
                        array_required: None,
                        default: None,
                        description: None,
                    };
                    let inputs = match op {
                        CrudOp::Create => {
                            // T18: child-model creates synthesize the
                            // caller-required unversioned `parent` linkage
                            // input (source mandates `parent=` on child
                            // creates; the L3 executor consumes it as
                            // linkage, never field data). A dangling owner
                            // row omits the input (never a panic); a model
                            // field literally named `parent` trips the
                            // duplicate-name guard below and omits the op.
                            let mut inputs = flat;
                            if let IrOwner::ChildOf(parent_id) = owner
                                && let Some(parent_item) = self.ir.items.get(parent_id.0 as usize)
                            {
                                inputs.push(JsOperationField {
                                    name: "parent".to_string(),
                                    value_type: None,
                                    field: JsMcpField::Ref {
                                        model: parent_item.canonical.clone(),
                                        require_version: false,
                                    },
                                    required: true,
                                    nullable: false,
                                    array_required: None,
                                    default: None,
                                    description: None,
                                });
                            }
                            inputs
                        }
                        CrudOp::Update => {
                            // Changes are partial: every flattened field is
                            // optional beside the versioned record, and
                            // defaults never apply (omission means
                            // unchanged, never default-filled). Array
                            // markers and nullability stay: they describe
                            // the accepted value shape.
                            let mut inputs = vec![record()];
                            for mut field in flat {
                                field.required = false;
                                field.default = None;
                                inputs.push(field);
                            }
                            inputs
                        }
                        CrudOp::Delete => vec![record()],
                    };
                    // A model field literally named `record` collides with
                    // the synthesized ref on update/delete: omit rather
                    // than advertise an ambiguous schema.
                    if has_duplicate_names(&inputs) {
                        continue;
                    }
                    operations.push(JsOperation {
                        name: item.canonical.clone(),
                        kind,
                        // Generated operations inherit their `label=`
                        // caption when the declaration captions them,
                        // else carry no description (P4 follow-up;
                        // locale variants never leave the source).
                        description: label
                            .as_ref()
                            .map(|message| message.source.clone())
                            .unwrap_or_default(),
                        inputs,
                        result: None,
                    });
                }
                _ => {}
            }
        }
        operations
    }

    /// Map one input type to its MCP field plus whether it is an array,
    /// or `None` when the type has no MCP mapping. `require_version`
    /// marks record references that must carry a version (mutations);
    /// reads take versionless refs. Nullability unwraps here; the caller
    /// clears `required` and sets `nullable`. Nested arrays have no
    /// mapping (the element position takes one tag only).
    ///
    /// T15b provider join (landed): T14c typed `std` receipts map to
    /// the closed [`JsMcpField::Delivery`] kind below; bound-local
    /// `Delivery` still falls into the `_ => None` arm (operations
    /// taking local deliveries omit, fail-closed) alongside the
    /// model-tag twin [`Emitter::model_field_tag`]. T04b ratifies the
    /// delivery shape.
    fn mcp_field_for_type(&self, ty: &IrType, require_version: bool) -> Option<(JsMcpField, bool)> {
        let resolved = match ty {
            IrType::Known(resolved) => resolved,
            IrType::Unknown => return None,
        };
        self.mcp_field_for_resolved(resolved, require_version)
    }

    /// Map one resolved input type to its MCP field plus array flag.
    fn mcp_field_for_resolved(
        &self,
        resolved: &ResolvedType,
        require_version: bool,
    ) -> Option<(JsMcpField, bool)> {
        match resolved {
            ResolvedType::Scalar(scalar) => Some((
                match scalar {
                    Scalar::Text
                    | Scalar::Email
                    | Scalar::Url
                    | Scalar::Locale
                    | Scalar::Timezone
                    | Scalar::Currency
                    | Scalar::Secret
                    | Scalar::Date
                    | Scalar::Member => JsMcpField::String,
                    Scalar::Int => JsMcpField::Integer,
                    Scalar::Decimal => JsMcpField::Decimal,
                    Scalar::Money => JsMcpField::Money,
                    Scalar::Datetime => JsMcpField::Datetime,
                    Scalar::Duration => JsMcpField::Duration,
                    Scalar::User => JsMcpField::User,
                    Scalar::Bool => JsMcpField::Boolean,
                    Scalar::File => JsMcpField::File,
                    Scalar::Json | Scalar::Bytes => return None,
                },
                false,
            )),
            ResolvedType::Record { symbol, .. } => Some((
                JsMcpField::Ref {
                    model: self.ir.items.get(symbol.0 as usize)?.canonical.clone(),
                    require_version,
                },
                false,
            )),
            ResolvedType::Enum { cases, .. } => Some((
                JsMcpField::Enum {
                    values: cases.clone(),
                },
                false,
            )),
            ResolvedType::Array { element, .. } => {
                // Nested arrays have no mapping; element nullability
                // unwraps for the tag (element-level null acceptance is
                // T04b admission detail).
                if matches!(element.as_ref(), ResolvedType::Array { .. }) {
                    return None;
                }
                let (field, _) = self.mcp_field_for_resolved(element, require_version)?;
                Some((field, true))
            }
            ResolvedType::Nullable(inner) => self.mcp_field_for_resolved(inner, require_version),
            // T15b: T14c typed `std` receipts map to the closed
            // delivery kind when both joins resolve; unjoined shapes
            // keep the omit (fail-closed, exactly as before).
            ResolvedType::StdDelivery { capability, op } => delivery_descriptor(capability, op)
                .map(|descriptor| (JsMcpField::Delivery(descriptor), false)),
            _ => None,
        }
    }

    /// Collect stored model descriptors in IR item order (T15a, T04a §3
    /// intake plus additive ownership).
    ///
    /// Unlike operations (which omit on unmappable inputs), models are
    /// complete: EVERY model emits with EVERY field, because T16
    /// admission needs the whole schema. Field types outside the T04a
    /// pilot set use the source-exact T04b-preview tags or the honest
    /// `other` fallback — never omitted, never skewed. References use
    /// canonical names, so recursive and mutually recursive models
    /// resolve by name without expansion. Total and diagnostic-free:
    /// descriptors never fail compilation; dangling rows degrade to
    /// `other` (unreachable on clean programs).
    ///
    /// Called from artifact assembly (JSON envelope only): the runtime
    /// keeps reading the richer `appDefinition.models` member, so models
    /// — unlike operations — are not embedded in `canApp()`.
    pub fn collect_models(&self) -> Vec<JsModel> {
        let mut models = Vec::new();
        for item in &self.ir.items {
            let IrItemKind::Model { fields, owner, .. } = &item.kind else {
                continue;
            };
            // Stored fields in listed order plus this model's derived
            // fields, merged by source position for true source order.
            let mut ordered: Vec<(u32, u32, usize)> = Vec::new();
            for field_id in fields {
                if let Some(field) = self.ir.items.get(field_id.0 as usize) {
                    ordered.push((field.span.start, field.span.end, field_id.0 as usize));
                }
            }
            for (index, other) in self.ir.items.iter().enumerate() {
                if let IrItemKind::DeriveField { model, .. } = &other.kind
                    && *model == item.id
                {
                    ordered.push((other.span.start, other.span.end, index));
                }
            }
            ordered.sort();
            // The same item can arrive via both paths (resolve lists
            // derive ids on the model): identical tuples dedupe.
            ordered.dedup();
            let mut out_fields = Vec::new();
            for (_, _, index) in ordered {
                let Some(field_item) = self.ir.items.get(index) else {
                    continue;
                };
                out_fields.push(self.model_field(field_item));
            }
            // Unique keys in source order: field-level `unique`
            // names only (field order). Composite uniques live on
            // the `uniques` member of `appDefinition.models`
            // (A2b); the old comma-joined fold is shed (B verdict:
            // actively false, load-bearing for T16/T17).
            let mut unique_keys = Vec::new();
            for field_id in fields {
                let Some(field_item) = self.ir.items.get(field_id.0 as usize) else {
                    continue;
                };
                if let IrItemKind::Field { modifiers, .. } = &field_item.kind
                    && modifiers.unique
                {
                    unique_keys.push(field_item.name.clone());
                }
            }
            models.push(JsModel {
                name: item.canonical.clone(),
                fields: out_fields,
                delete_mode: self.model_delete_mode(item.id),
                unique_keys,
                parent: match owner {
                    IrOwner::ChildOf(parent) => self
                        .ir
                        .items
                        .get(parent.0 as usize)
                        .map(|row| row.canonical.clone()),
                    IrOwner::Team | IrOwner::App => None,
                },
                scope_app: matches!(owner, IrOwner::App),
            });
        }
        models
    }

    /// What a caller-asked remove does for `model`: the enabled delete
    /// operation's declared mode (`archive` default, `remove`), or
    /// `none` when the model has no enabled delete operation (disabled
    /// or no `crud` declaration at all).
    fn model_delete_mode(&self, model: crate::analysis::resolve::SymbolId) -> String {
        for row in &self.ir.items {
            if let IrItemKind::CrudOp {
                model: target,
                op: CrudOp::Delete,
                delete_mode,
                ..
            } = &row.kind
                && *target == model
            {
                return delete_mode.as_str().to_string();
            }
        }
        "none".to_string()
    }

    /// One model field descriptor: stored fields carry their T09
    /// requiredness/omission/default/server distinctions; derived fields
    /// render with the `derived` marker and `serverOnly: true` (never
    /// caller-writable, never operation inputs).
    fn model_field(&self, field_item: &IrItem) -> JsModelField {
        if let IrItemKind::DeriveField { ty, .. } = &field_item.kind {
            let (field, nullable, is_array) = self.model_field_parts(ty);
            return JsModelField {
                name: field_item.name.clone(),
                field,
                value_type: checked_string_value_type(ty),
                required: false,
                nullable,
                server_only: true,
                array_required: is_array.then_some(false),
                default: Some(JsFieldDefault::Derived),
                machine: None,
                description: None,
            };
        }
        let (ty, required_array, default, server, description) = match &field_item.kind {
            IrItemKind::Field {
                ty,
                required_array,
                default,
                server,
                description,
                ..
            } => (ty, *required_array, default, server, description),
            _ => {
                return JsModelField {
                    name: field_item.name.clone(),
                    value_type: None,
                    field: JsModelFieldType::Other {
                        type_id: "unknown".to_string(),
                    },
                    required: false,
                    nullable: false,
                    server_only: false,
                    array_required: None,
                    default: None,
                    machine: None,
                    description: None,
                };
            }
        };
        let (field, nullable, is_array) = self.model_field_parts(ty);
        // Omission-rejects at creation: nullable, server-owned and
        // defaulted fields never require the caller; ordinary arrays
        // omit to empty; only non-nullable singular fields without a
        // default — and required `!` arrays without one — are required.
        // Unknown types (already `E6006` from the IR build) stay
        // non-required: descriptors never introduce new rejections.
        let required = !nullable
            && server.is_none()
            && default.is_none()
            && (!is_array || required_array)
            && !matches!(ty, IrType::Unknown);
        JsModelField {
            name: field_item.name.clone(),
            field,
            value_type: checked_string_value_type(ty),
            required,
            nullable,
            server_only: server.is_some(),
            array_required: is_array.then_some(required_array),
            default: js_field_default(default.as_ref(), server.as_ref()),
            machine: self.machine_for(field_item),
            description: description.clone(),
        }
    }

    fn machine_for(&self, field: &IrItem) -> Option<JsMachine> {
        let IrItemKind::Field {
            owner,
            ty: IrType::Known(ResolvedType::Enum { cases, .. }),
            default,
            modifiers,
            ..
        } = &field.kind
        else {
            return None;
        };
        if !modifiers.machine {
            return None;
        }
        let Some(JsFieldDefault::Literal(initial_json)) = js_field_default(default.as_ref(), None)
        else {
            return None;
        };
        let Ok(initial) = serde_json::from_str::<String>(&initial_json) else {
            return None;
        };
        let model = &self.ir.item(*owner).canonical;
        let mut transitions = Vec::new();
        fn collect(
            body: &[IrStmt],
            model: &str,
            field: &str,
            operation: &str,
            out: &mut Vec<JsMachineTransition>,
        ) {
            for stmt in body {
                match stmt {
                    IrStmt::Transition {
                        model: target,
                        field: name,
                        from,
                        to,
                        ..
                    } if target == model && name == field => {
                        let edge = JsMachineTransition {
                            from: from.clone(),
                            to: to.clone(),
                            operation: operation.to_string(),
                        };
                        if !out.contains(&edge) {
                            out.push(edge);
                        }
                    }
                    IrStmt::If {
                        then_branch,
                        else_branch,
                        ..
                    } => {
                        collect(then_branch, model, field, operation, out);
                        collect(else_branch, model, field, operation, out);
                    }
                    IrStmt::For { body, .. } => collect(body, model, field, operation, out),
                    _ => {}
                }
            }
        }
        for operation in &self.ir.items {
            if let IrItemKind::Scenario { effects, .. } = &operation.kind {
                collect(
                    effects,
                    model,
                    &field.name,
                    &operation.canonical,
                    &mut transitions,
                );
            }
        }
        Some(JsMachine {
            initial,
            states: cases.clone(),
            transitions,
        })
    }

    /// Split one field type into its element tag, top-level nullability
    /// and array flag. Total: unknown and dangling rows degrade to
    /// `other` without diagnostics (descriptors never fail compilation).
    fn model_field_parts(&self, ty: &IrType) -> (JsModelFieldType, bool, bool) {
        let resolved = match ty {
            IrType::Known(resolved) => resolved,
            IrType::Unknown => {
                return (
                    JsModelFieldType::Other {
                        type_id: "unknown".to_string(),
                    },
                    false,
                    false,
                );
            }
        };
        match resolved {
            ResolvedType::Nullable(inner) => {
                let (tag, _, is_array) = self.model_field_parts(&IrType::Known((**inner).clone()));
                (tag, true, is_array)
            }
            ResolvedType::Array { element, .. } => {
                let tag = self.model_field_tag(element);
                (tag, false, true)
            }
            other => (self.model_field_tag(other), false, false),
        }
    }

    /// Tag one element type (never an array/nullable wrapper: callers
    /// unwrap first). Pilot scalars use the T04a spellings; text-like
    /// specializations collapse to `string` (wire-identical); models map
    /// to `ref` by canonical name; everything else is source-exact
    /// T04b-preview or the honest `other` fallback carrying the source
    /// type id. Total and diagnostic-free.
    ///
    /// T15b provider join (landed): T14c typed `std` receipts map to
    /// the closed [`JsModelFieldType::Delivery`] tag below when both
    /// joins resolve; bound-local `Delivery` keeps the source-exact
    /// `other` tag (see the arm below), as do unjoined `std` shapes.
    /// Twin of the operation mapping [`Emitter::mcp_field_for_type`];
    /// T04b ratifies the delivery shape.
    fn model_field_tag(&self, ty: &ResolvedType) -> JsModelFieldType {
        match ty {
            ResolvedType::Scalar(scalar) => match scalar {
                Scalar::Text
                | Scalar::Email
                | Scalar::Url
                | Scalar::Locale
                | Scalar::Timezone
                | Scalar::Currency => JsModelFieldType::String,
                Scalar::Int => JsModelFieldType::Integer,
                Scalar::Decimal => JsModelFieldType::Decimal,
                Scalar::Money => JsModelFieldType::Money,
                Scalar::Datetime => JsModelFieldType::Datetime,
                Scalar::Bool => JsModelFieldType::Boolean,
                Scalar::File => JsModelFieldType::File,
                Scalar::Date => JsModelFieldType::Date,
                Scalar::Duration => JsModelFieldType::Duration,
                Scalar::Secret => JsModelFieldType::Secret,
                Scalar::User => JsModelFieldType::User,
                Scalar::Member => JsModelFieldType::Member,
                Scalar::Json => JsModelFieldType::Json,
                Scalar::Bytes => JsModelFieldType::Bytes,
            },
            ResolvedType::Record { symbol, .. } => match self.ir.items.get(symbol.0 as usize) {
                Some(row) if matches!(row.kind, IrItemKind::Model { .. }) => {
                    JsModelFieldType::Ref {
                        model: row.canonical.clone(),
                    }
                }
                Some(row) => JsModelFieldType::Other {
                    type_id: row.canonical.clone(),
                },
                None => JsModelFieldType::Other {
                    type_id: "unknown".to_string(),
                },
            },
            ResolvedType::Enum { cases, .. } => JsModelFieldType::Enum {
                values: cases.clone(),
            },
            ResolvedType::Message(symbol) => JsModelFieldType::Other {
                type_id: self
                    .ir
                    .items
                    .get(symbol.0 as usize)
                    .map(|row| row.canonical.clone())
                    .unwrap_or_else(|| "message".to_string()),
            },
            // Bound-local delivery handles stay `other`: T15b scopes
            // closed descriptors to T14c typed `std` receipts (local
            // capabilities have no T13 contract identity to join).
            ResolvedType::Delivery { op } => JsModelFieldType::Other {
                type_id: self
                    .ir
                    .items
                    .get(op.0 as usize)
                    .map(|row| format!("delivery:{}", row.canonical))
                    .unwrap_or_else(|| "delivery".to_string()),
            },
            // T15b: typed `std` receipts tag closed when both joins
            // resolve; unjoined shapes keep exactly the T14c `other`
            // fallback (fail-closed, T04b ratifies).
            ResolvedType::StdDelivery { capability, op } => delivery_descriptor(capability, op)
                .map(JsModelFieldType::Delivery)
                .unwrap_or_else(|| JsModelFieldType::Other {
                    type_id: format!("delivery:{capability}.{}", op.name),
                }),
            ResolvedType::Action { .. } => JsModelFieldType::Other {
                type_id: "action".to_string(),
            },
            ResolvedType::Invocation { .. } => JsModelFieldType::Other {
                type_id: "invocation".to_string(),
            },
            ResolvedType::Union(_) => JsModelFieldType::Other {
                type_id: "union".to_string(),
            },
            ResolvedType::Object(_) => JsModelFieldType::Other {
                type_id: "object".to_string(),
            },
            ResolvedType::Operation(symbol) => JsModelFieldType::Other {
                type_id: self
                    .ir
                    .items
                    .get(symbol.0 as usize)
                    .map(|row| row.canonical.clone())
                    .unwrap_or_else(|| "operation".to_string()),
            },
            ResolvedType::Opaque(id) => JsModelFieldType::Other {
                type_id: id.to_string(),
            },
            ResolvedType::Team => JsModelFieldType::Other {
                type_id: "Team".to_string(),
            },
            ResolvedType::OperationContext => JsModelFieldType::Other {
                type_id: "OperationContext".to_string(),
            },
            ResolvedType::Error => JsModelFieldType::Other {
                type_id: "error".to_string(),
            },
            ResolvedType::Unknown | ResolvedType::Null => JsModelFieldType::Other {
                type_id: "unknown".to_string(),
            },
            // Element-nullable arrays (`(T?)[]`) tag the element
            // (element-level null acceptance is T04b admission detail);
            // nested arrays have no element tag.
            ResolvedType::Nullable(inner) => self.model_field_tag(inner),
            ResolvedType::Array { .. } => JsModelFieldType::Other {
                type_id: "array".to_string(),
            },
        }
    }

    fn emit_can_app(
        &mut self,
        out: &mut JsWriter,
        entry: Option<crate::analysis::resolve::ModuleId>,
        operations: &[JsOperation],
    ) {
        let entry_span = entry.map(|id| self.ir.module(id).span).unwrap_or(Span::new(
            crate::source::SourceId(0),
            0,
            0,
        ));
        out.push(
            entry_span,
            Some("canApp".to_string()),
            "export function canApp(){",
        );
        if !self.ir.crud_when.is_empty() {
            let entries: Vec<String> = self
                .ir
                .crud_when
                .clone()
                .iter()
                .map(|rule| {
                    format!(
                        "{}:{}",
                        object_key(&rule.name),
                        self.lower_rule_fn(&rule.body)
                    )
                })
                .collect();
            out.push(
                entry_span,
                Some("canApp".to_string()),
                &format!("const crudWhen={{{}}};", entries.join(",")),
            );
        }
        out.push(entry_span, Some("canApp".to_string()), "return {");
        if !self.ir.crud_when.is_empty() {
            out.push(entry_span, Some("canApp".to_string()), "crudWhen,");
        }
        // Operation descriptors: the same `{name, kind, description,
        // inputs}` objects the artifact envelope carries (MCP P1).
        // Sparse like every other `canApp()` member: omitted when the
        // program has no operations.
        if !operations.is_empty() {
            out.push(
                entry_span,
                Some("canApp".to_string()),
                &format!("operations:{},", operations_json(operations)),
            );
        }
        self.emit_rule_map(out, "read", entry_span);
        self.emit_rule_map(out, "invariants", entry_span);
        self.emit_locks_map(out, entry_span);
        self.emit_retention_map(out, entry_span);
        self.emit_preferences_valid(out, entry_span);
        self.emit_derives_map(out, entry_span);
        self.emit_hooks_map(out, entry_span);
        self.emit_handler_fns(out);
        // B7 phase-1: the policy manifest inside `canApp()`, from the
        // same builder as `appDefinition`, so the serve loader sees
        // provenance without a second source. Sparse: omitted when the
        // program has no policy content (byte-identical otherwise).
        if let Some(policy) = self.emit_policy_member() {
            out.push(
                entry_span,
                Some("canApp".to_string()),
                &format!("{policy},"),
            );
        }
        out.push(entry_span, Some("canApp".to_string()), "};}");
    }

    /// Lower one `(c, row)` rule function, `async` exactly when the body
    /// awaits.
    fn lower_rule_fn(&mut self, body: &TypedExpr) -> String {
        let body_text = self.lower_business_expr(body, "formatted business rule");
        if expr_uses_async(body) {
            format!("async(c,row)=>{body_text}")
        } else {
            format!("(c,row)=>{body_text}")
        }
    }

    /// Emit one boolean rule map (`read`, `invariants`).
    fn emit_rule_map(&mut self, out: &mut JsWriter, member: &str, span: Span) {
        let rules = match member {
            "read" => self.ir.read_rules.clone(),
            _ => self.ir.invariants.clone(),
        };
        if rules.is_empty() {
            return;
        }
        let entries: Vec<String> = rules
            .iter()
            .map(|rule| format!("{}:{}", js_string(&rule.id), self.lower_rule_fn(&rule.pred)))
            .collect();
        out.push(
            span,
            Some("canApp".to_string()),
            &format!("{member}:{{{}}},", entries.join(",")),
        );
    }

    /// Emit the `locks` map: `{fields, when?}` entries by registry id.
    fn emit_locks_map(&mut self, out: &mut JsWriter, span: Span) {
        if self.ir.locks.is_empty() {
            return;
        }
        let entries: Vec<String> = self
            .ir
            .locks
            .clone()
            .iter()
            .map(|lock| {
                let mut members = format!(
                    "fields:[{}]",
                    lock.fields
                        .iter()
                        .map(|f| js_string(f))
                        .collect::<Vec<_>>()
                        .join(",")
                );
                if let Some(when) = &lock.when {
                    members.push_str(&format!(",when:{}", self.lower_rule_fn(when)));
                }
                format!("{}:{{{members}}}", js_string(&lock.id))
            })
            .collect();
        out.push(
            span,
            Some("canApp".to_string()),
            &format!("locks:{{{}}},", entries.join(",")),
        );
    }

    /// Emit the `retention` map: model-local keys to deadline rules.
    fn emit_retention_map(&mut self, out: &mut JsWriter, span: Span) {
        if self.ir.retention.is_empty() {
            return;
        }
        let entries: Vec<String> = self
            .ir
            .retention
            .clone()
            .iter()
            .map(|rule| {
                format!(
                    "{}:{}",
                    object_key(&rule.name),
                    self.lower_rule_fn(&rule.body)
                )
            })
            .collect();
        out.push(
            span,
            Some("canApp".to_string()),
            &format!("retention:{{{}}},", entries.join(",")),
        );
    }

    /// Emit `preferencesValid` validators (one registry key each).
    fn emit_preferences_valid(&mut self, out: &mut JsWriter, span: Span) {
        for validator in &self.ir.preferences_valid.clone() {
            out.push(
                span,
                Some("canApp".to_string()),
                &format!(
                    "{}:{},",
                    object_key(&validator.name),
                    self.lower_rule_fn(&validator.body)
                ),
            );
        }
    }

    /// Emit the `derives` map for derived fields (derived functions stay
    /// named functions below).
    fn emit_derives_map(&mut self, out: &mut JsWriter, span: Span) {
        // Derived fields share one map keyed by canonical owning identity.
        let mut derives = Vec::new();
        for item in self.ir.items.clone() {
            let IrItemKind::DeriveField { expr, .. } = &item.kind else {
                continue;
            };
            let key = item.canonical.clone();
            self.callables.push(JsCallable {
                id: item.canonical.clone(),
                kind: JsCallableKind::Pure,
                export: key.clone(),
                member: registry_member(self.ir, &item),
                input_style: None,
                span: item.span,
            });
            match expr {
                Some(expr) => {
                    let body_text =
                        self.lower_business_expr(expr, "formatted ordinary derived field");
                    derives.push(format!("{}:async(c,row)=>{body_text}", js_string(&key)));
                }
                None => {
                    derives.push(format!(
                        "{}:async(c,row)=>{{throw new Error({});}}",
                        js_string(&key),
                        js_string(&format!("unchecked derive: {}", item.canonical))
                    ));
                }
            }
        }
        if !derives.is_empty() {
            out.push(
                span,
                Some("derives".to_string()),
                &format!("derives:{{{}}},", derives.join(",")),
            );
        }
    }

    /// Emit operation handlers (scenarios, generated CRUD) and derived
    /// functions with their decoded bodies.
    /// Emit the `hooks` map: one engine-shaped `{name, ops, run}`
    /// descriptor per pre-commit hook, keyed by source trigger. The run
    /// function binds `($candidate, $hookCtx)`, builds the live `event`
    /// views over the candidate plus trigger identity, stages through the
    /// hook context, and returns the pending candidate. Sparse like every
    /// other `canApp()` member: omitted when the program declares no hooks.
    fn emit_hooks_map(&mut self, out: &mut JsWriter, span: Span) {
        let hooks: Vec<IrItem> = self
            .ir
            .items
            .iter()
            .filter(|item| matches!(&item.kind, IrItemKind::Scenario { hook: Some(_), .. }))
            .cloned()
            .collect();
        if hooks.is_empty() {
            return;
        }
        for (index, item) in hooks.iter().enumerate() {
            let IrItemKind::Scenario {
                hook: Some(hook),
                guards,
                effects,
                ..
            } = &item.kind
            else {
                continue;
            };
            let hook = *hook;
            let handler = binding_ident("s", &item.canonical);
            let key = hook_trigger_key(self.ir, &hook);
            let prefix = if index == 0 { "hooks:{" } else { "" };
            out.push(
                item.span,
                Some(item.canonical.clone()),
                &format!(
                    "{prefix}{}:{{name:{},ops:[{}],run:async function {handler}($candidate,$hookCtx){{",
                    js_string(&key),
                    js_string(&item.canonical),
                    js_string(hook_engine_op(hook.op))
                ),
            );
            out.push(
                item.span,
                Some(item.canonical.clone()),
                "const event={after:{...$candidate,id:$hookCtx.triggerId,version:($hookCtx.before?$hookCtx.before.version+1:1),parent:($hookCtx.before?$hookCtx.before.parent:null)},before:($hookCtx.before?{...$hookCtx.before.data,id:$hookCtx.before.id,version:$hookCtx.before.version,parent:$hookCtx.before.parent}:null)};",
            );
            out.push(
                item.span,
                Some(item.canonical.clone()),
                "let $stagedNext=0;",
            );
            out.push(item.span, Some(item.canonical.clone()), "let $pending;");
            self.enter_scope();
            self.enter_hook(hook.model);
            for guard in guards {
                for (line, span) in self.lower_stmt(guard, 0) {
                    out.push(span, Some(item.canonical.clone()), &line);
                }
            }
            for effect in effects {
                for (line, span) in self.lower_stmt(effect, 0) {
                    out.push(span, Some(item.canonical.clone()), &line);
                }
            }
            self.exit_hook();
            self.exit_scope();
            out.push(
                item.span,
                Some(item.canonical.clone()),
                "return $candidate;",
            );
            let sep = if index + 1 == hooks.len() { "" } else { "," };
            let mut close = "}}".to_string();
            close.push_str(sep);
            out.push(item.span, Some(item.canonical.clone()), &close);
        }
        out.push(span, Some("canApp".to_string()), "},");
    }

    /// Emit derived functions as module-scope named functions
    /// (`{export?}async function name(c,...params){...}` per the
    /// CanChat/CanDiscover draft contract). Bodies reference parameters
    /// by bare name, so the signature carries the declared params in
    /// order (no `row`: derives are pure functions, DESIGN §2). Always
    /// `async`: call sites uniformly `await`. Exported exactly when the
    /// source derive is exported.
    fn emit_derive_fns(&mut self, out: &mut JsWriter) {
        for item in self.ir.items.clone() {
            let IrItemKind::DeriveFn { params, expr, .. } = &item.kind else {
                continue;
            };
            let name = binding_ident("s", &item.canonical);
            self.enter_scope();
            let mut signature = vec!["c".to_string()];
            for id in params {
                signature.push(self.bind(&self.ir.items[id.0 as usize].name.clone()));
            }
            let export = if item.exported { "export " } else { "" };
            match expr {
                Some(expr) => {
                    let mut defaults = String::new();
                    for (id, name) in params.iter().zip(signature.iter().skip(1)) {
                        if let IrItemKind::Param {
                            default: Some(default),
                            ..
                        } = &self.ir.items[id.0 as usize].kind.clone()
                        {
                            let value = match default {
                                IrDefault::Literal(expr) | IrDefault::Computed { expr, .. } => self
                                    .lower_business_expr(
                                        expr,
                                        "formatted derive parameter default",
                                    ),
                            };
                            defaults
                                .push_str(&format!("if({name}===undefined){{{name}={value};}}"));
                        }
                    }
                    let body_text = self.lower_expr(expr);
                    out.push(
                        item.span,
                        Some(item.canonical.clone()),
                        &format!(
                            "{export}async function {name}({}){{{defaults}return {body_text};}}",
                            signature.join(",")
                        ),
                    );
                }
                None => {
                    out.push(
                        item.span,
                        Some(item.canonical.clone()),
                        &format!(
                            "{export}async function {name}({}){{throw new Error({});}}",
                            signature.join(","),
                            js_string(&format!("unchecked derive: {}", item.canonical))
                        ),
                    );
                }
            }
            self.exit_scope();
        }
    }

    fn emit_handler_fns(&mut self, out: &mut JsWriter) {
        for item in &self.ir.items.clone() {
            match &item.kind {
                IrItemKind::Scenario {
                    params,
                    trusted,
                    hook,
                    by,
                    guards,
                    effects,
                    ..
                } => {
                    // Hooks emit as inline run functions in the `hooks`
                    // registry, never as top-level handler methods.
                    if hook.is_some() {
                        continue;
                    }
                    let handler = object_key(&item.canonical);
                    self.enter_scope();
                    let signature = if *trusted {
                        format!("c,{{event:{}}}", self.bind("event"))
                    } else {
                        let names: Vec<String> = params
                            .iter()
                            .map(|id| {
                                let name = self.ir.items[id.0 as usize].name.clone();
                                format!("{}:{}", object_key(&name), self.bind(&name))
                            })
                            .collect();
                        format!("c,{{{}}}", names.join(","))
                    };
                    // Scenarios without any decoded body keep the failing
                    // stub (the IR build reports the `E6006`).
                    let has_body = !guards.is_empty() || !effects.is_empty();
                    if !has_body && by.is_empty() {
                        out.push(
                            item.span,
                            Some(item.canonical.clone()),
                            &format!(
                                "async {handler}({signature}){{throw new Error({});}},",
                                js_string(&format!("unchecked scenario body: {}", item.canonical))
                            ),
                        );
                        self.exit_scope();
                        continue;
                    }
                    out.push(
                        item.span,
                        Some(item.canonical.clone()),
                        &format!("async {handler}({signature}){{"),
                    );
                    self.emit_admission_check(out, by, item.span);
                    for guard in guards {
                        for (line, span) in self.lower_stmt(guard, 0) {
                            out.push(span, Some(item.canonical.clone()), &line);
                        }
                    }
                    for effect in effects {
                        for (line, span) in self.lower_stmt(effect, 0) {
                            out.push(span, Some(item.canonical.clone()), &line);
                        }
                    }
                    out.push(item.span, Some(item.canonical.clone()), "},");
                    self.exit_scope();
                }
                IrItemKind::CrudOp {
                    model,
                    op,
                    by,
                    has_when,
                    delete_mode,
                    ..
                } => {
                    let model_item = self.ir.items[model.0 as usize].clone();
                    let handler = object_key(&item.canonical);
                    let when = if *has_when {
                        Some(model_item.name.clone())
                    } else {
                        None
                    };
                    let (signature, core) = match op {
                        CrudOp::Create => (
                            "c,input".to_string(),
                            IrStmt::Create {
                                model: model_item.canonical.clone(),
                                input: TypedExpr::new(
                                    IrExpr::Name("input".to_string()),
                                    ResolvedType::Unknown,
                                    item.span,
                                ),
                                when: when.clone(),
                                binding: None,
                                span: item.span,
                            },
                        ),
                        CrudOp::Update => (
                            "c,{record,changes}".to_string(),
                            IrStmt::Set {
                                record: TypedExpr::new(
                                    IrExpr::Name("record".to_string()),
                                    ResolvedType::Unknown,
                                    item.span,
                                ),
                                changes: TypedExpr::new(
                                    IrExpr::Name("changes".to_string()),
                                    ResolvedType::Unknown,
                                    item.span,
                                ),
                                when: when.clone(),
                                span: item.span,
                            },
                        ),
                        CrudOp::Delete => (
                            "c,{record}".to_string(),
                            IrStmt::Delete {
                                record: TypedExpr::new(
                                    IrExpr::Name("record".to_string()),
                                    ResolvedType::Unknown,
                                    item.span,
                                ),
                                mode: *delete_mode,
                                span: item.span,
                            },
                        ),
                    };
                    out.push(
                        item.span,
                        Some(item.canonical.clone()),
                        &format!("async {handler}({signature}){{"),
                    );
                    self.emit_admission_check(out, by, item.span);
                    // Deletes check row admission explicitly; creates and
                    // updates thread it through the helper call.
                    if *op == CrudOp::Delete
                        && let Some(key) = crud_when_key(when.as_ref())
                    {
                        self.stdlib.insert("check".to_string());
                        out.push(
                            item.span,
                            Some(item.canonical.clone()),
                            &format!("check(await crudWhen[{}](c,record));", js_string(&key)),
                        );
                    }
                    for (line, span) in self.lower_stmt(&core, 0) {
                        out.push(span, Some(item.canonical.clone()), &line);
                    }
                    out.push(item.span, Some(item.canonical.clone()), "},");
                }
                IrItemKind::DeriveFn { .. } => {
                    let name = binding_ident("s", &item.canonical);
                    self.callables.push(JsCallable {
                        id: item.canonical.clone(),
                        kind: JsCallableKind::Pure,
                        export: name.clone(),
                        member: registry_member(self.ir, item),
                        input_style: None,
                        span: item.span,
                    });
                    // The implementation lives at module scope
                    // (`emit_derive_fns`); the registry holds the
                    // canonical key pointing to its implementation binding.
                    out.push(
                        item.span,
                        Some(item.canonical.clone()),
                        &format!("{}:{name},", object_key(&item.canonical)),
                    );
                }
                IrItemKind::DeriveField { .. } => {}
                _ => {}
            }
        }
    }

    /// Emit the `by` admission check for one handler, if it has a gate.
    fn emit_admission_check(
        &mut self,
        out: &mut JsWriter,
        by: &[crate::codegen::ir::IrGuard],
        span: Span,
    ) {
        if by.is_empty() {
            return;
        }
        let admission = self.lower_admission(by);
        out.push(span, Some("canApp".to_string()), &format!("{admission};"));
    }

    /// Emit one non-entrypoint package module: canonical identity
    /// constants for exported nominals plus capability-operation stubs
    /// (external implementations bind at deployment).
    fn emit_package_module(&mut self, module: crate::analysis::resolve::ModuleId) -> JsModule {
        let module_data = self.ir.module(module).clone();
        // A fresh emitter keeps package imports independent; diagnostics
        // merge back into this emitter.
        let emitter = Emitter::new(self.ir);
        let mut body = JsWriter::new();
        for item in self.ir.items_of(module).cloned().collect::<Vec<_>>() {
            match &item.kind {
                IrItemKind::Model { .. }
                | IrItemKind::Contract { .. }
                | IrItemKind::Event { .. }
                | IrItemKind::Role { .. }
                | IrItemKind::Message { .. } => {
                    if !item.exported {
                        continue;
                    }
                    body.push(
                        item.span,
                        Some(item.canonical.clone()),
                        &format!(
                            "export const {}={};",
                            binding_ident("s", &item.canonical),
                            js_string(&item.canonical)
                        ),
                    );
                }
                IrItemKind::CapabilityOp { params, .. } => {
                    let name = binding_ident("s", &item.canonical);
                    let args: Vec<String> = params
                        .iter()
                        .map(|id| binding_ident("l", &self.ir.items[id.0 as usize].canonical))
                        .collect();
                    body.push(
                        item.span,
                        Some(item.canonical.clone()),
                        &format!(
                            "export async function {name}(c,{}){{throw new Error({});}}",
                            args.join(","),
                            js_string(&format!(
                                "external capability operation {} binds at deployment",
                                item.canonical
                            ))
                        ),
                    );
                }
                _ => {}
            }
        }
        let mut out = JsWriter::new();
        out.push(
            module_data.span,
            None,
            &format!(
                "// Generated by can compile from {}; do not edit.",
                module_data.name
            ),
        );
        for line in emitter.import_lines() {
            out.push(module_data.span, None, &line);
        }
        for line in emitter.support_lines() {
            out.push(module_data.span, None, &line);
        }
        out.append(&body);
        let (mut diags, mut builtins, callables, pages) = emitter.finish();
        self.diags.append(&mut diags);
        self.builtins.append(&mut builtins);
        self.callables.extend(callables);
        self.pages.extend(pages);
        out.finish(module_path(&module_data.name))
    }
}

/// Closed checked scalar result profile; other shapes stay unknown.
fn checked_scenario_result(result: Option<&ResolvedType>) -> Option<&'static str> {
    // Only successful checked Scenario signatures establish no result.
    let Some(result) = result else {
        return Some("void");
    };
    checked_value_profile(result)
}

fn checked_string_value_type(ty: &IrType) -> Option<&'static str> {
    let IrType::Known(ty) = ty else {
        return None;
    };
    checked_value_profile(ty).filter(|value| {
        matches!(
            *value,
            "text" | "text?" | "text[]" | "text[]?" | "date" | "date?" | "date[]" | "date[]?"
        )
    })
}

fn checked_value_profile(result: &ResolvedType) -> Option<&'static str> {
    let (value, nullable) = match result {
        ResolvedType::Nullable(value) => (value.as_ref(), true),
        value => (value, false),
    };
    let (scalar, array) = match value {
        ResolvedType::Array { element, .. } => (element.as_ref(), true),
        value => (value, false),
    };
    match (scalar, array, nullable) {
        (ResolvedType::Scalar(Scalar::Int), false, false) => Some("int"),
        (ResolvedType::Scalar(Scalar::Datetime), false, false) => Some("datetime"),
        (ResolvedType::Scalar(Scalar::Int), false, true) => Some("int?"),
        (ResolvedType::Scalar(Scalar::Datetime), false, true) => Some("datetime?"),
        (ResolvedType::Scalar(Scalar::Int), true, false) => Some("int[]"),
        (ResolvedType::Scalar(Scalar::Datetime), true, false) => Some("datetime[]"),
        (ResolvedType::Scalar(Scalar::Int), true, true) => Some("int[]?"),
        (ResolvedType::Scalar(Scalar::Datetime), true, true) => Some("datetime[]?"),
        (ResolvedType::Scalar(Scalar::Text), false, false) => Some("text"),
        (ResolvedType::Scalar(Scalar::Text), false, true) => Some("text?"),
        (ResolvedType::Scalar(Scalar::Text), true, false) => Some("text[]"),
        (ResolvedType::Scalar(Scalar::Text), true, true) => Some("text[]?"),
        (ResolvedType::Scalar(Scalar::Bool), false, false) => Some("bool"),
        (ResolvedType::Scalar(Scalar::Bool), false, true) => Some("bool?"),
        (ResolvedType::Scalar(Scalar::Bool), true, false) => Some("bool[]"),
        (ResolvedType::Scalar(Scalar::Bool), true, true) => Some("bool[]?"),
        (ResolvedType::Scalar(Scalar::Decimal), false, false) => Some("decimal"),
        (ResolvedType::Scalar(Scalar::Decimal), false, true) => Some("decimal?"),
        (ResolvedType::Scalar(Scalar::Decimal), true, false) => Some("decimal[]"),
        (ResolvedType::Scalar(Scalar::Decimal), true, true) => Some("decimal[]?"),
        (ResolvedType::Scalar(Scalar::Money), false, false) => Some("money"),
        (ResolvedType::Scalar(Scalar::Money), false, true) => Some("money?"),
        (ResolvedType::Scalar(Scalar::Money), true, false) => Some("money[]"),
        (ResolvedType::Scalar(Scalar::Money), true, true) => Some("money[]?"),
        (ResolvedType::Scalar(Scalar::Date), false, false) => Some("date"),
        (ResolvedType::Scalar(Scalar::Date), false, true) => Some("date?"),
        (ResolvedType::Scalar(Scalar::Date), true, false) => Some("date[]"),
        (ResolvedType::Scalar(Scalar::Date), true, true) => Some("date[]?"),
        (ResolvedType::Scalar(Scalar::Duration), false, false) => Some("duration"),
        (ResolvedType::Scalar(Scalar::Duration), false, true) => Some("duration?"),
        (ResolvedType::Scalar(Scalar::Duration), true, false) => Some("duration[]"),
        (ResolvedType::Scalar(Scalar::Duration), true, true) => Some("duration[]?"),
        (ResolvedType::Scalar(Scalar::User), false, false) => Some("user"),
        (ResolvedType::Scalar(Scalar::User), false, true) => Some("user?"),
        (ResolvedType::Scalar(Scalar::User), true, false) => Some("user[]"),
        (ResolvedType::Scalar(Scalar::User), true, true) => Some("user[]?"),
        _ => None,
    }
}

/// Object key: bare identifier when safe, quoted otherwise.
fn object_key(key: &str) -> String {
    if key == "__proto__" {
        return format!("[{}]", js_string(key));
    }
    let safe = !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
        && !key.chars().next().is_some_and(|c| c.is_ascii_digit());
    if safe {
        key.to_string()
    } else {
        js_string(key)
    }
}

#[cfg(test)]
mod string_tests {
    use super::js_string;

    #[test]
    fn fixed_string_bytes_cover_every_control_unicode_and_quotes() {
        let controls: String = (0u8..32).map(char::from).collect();
        assert_eq!(
            js_string(&controls),
            r#""\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\t\n\u000b\u000c\r\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f""#,
        );
        assert_eq!(js_string(""), r#""""#);
        assert_eq!(
            js_string("'\"\\/é😀\u{7f}\u{2028}\u{2029}"),
            "\"'\\\"\\\\/é😀\u{7f}\u{2028}\u{2029}\"",
        );
    }
}
