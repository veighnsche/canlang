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

use super::source_send_data::{plain_value,send_value,source_only_data_sends,source_only_data_emits};
use crate::analysis::catalog::{StdOperation, nominal_schema, std_capability};
use crate::analysis::resolve::{CrudOp, ModuleKind, SymbolId};
use crate::analysis::types::{ResolvedType, Scalar, canonical_datetime_literal, std_schema_type};
use crate::codegen::ir::{
    CheckedStandardCompletionHandler, IrBinOp, IrCallTarget, IrChoiceValue, IrCohort, IrDefault,
    IrEffectCallTarget, IrEventSource, IrExpr, IrFieldLabel, IrGuard, IrHook, IrInputChoiceBinding,
    IrItem, IrItemKind, IrJudgmentGenerated, IrMessage, IrModule, IrOwner, IrPage, IrProgram,
    IrServer, IrStmt, IrType, IrUi, IrUnOp, IrViewUse, ReferencedBuiltin, ScalarFamily, TypedExpr,
    expr_uses_async, is_structural, scalar_family,
};
use crate::codegen::model_policies::{LocalPolicies, ModelPolicies, collect_local_policies};
use crate::diagnostic::Diagnostic;
use crate::source::Span;
use serde::ser::{SerializeMap, SerializeStruct};
use serde::{Serialize, Serializer};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// Follow nominal field references using the consumed owner schema only.
fn collect_std_nominal_contracts(
    declared: &str,
    published: &mut BTreeSet<String>,
    schemas: &mut Vec<&'static crate::analysis::catalog::StdNominal>,
) {
    let base = declared
        .trim_end_matches('?')
        .trim_end_matches("[]!")
        .trim_end_matches("[]");
    let Some(schema) = nominal_schema(base) else {
        return;
    };
    if !published.insert(schema.name.to_string()) {
        return;
    }
    schemas.push(schema);
    for (_, declared) in schema.fields {
        collect_std_nominal_contracts(declared, published, schemas);
    }
}

/// Canonical Values spelling keeps catalog wrappers and nominal identity.
fn std_value_type_id(declared: &str) -> Option<String> {
    if let Some(inner) = declared.strip_suffix('?') {
        return std_value_type_id(inner).map(|ty| format!("{ty}?"));
    }
    if let Some(inner) = declared.strip_suffix("[]!") {
        return std_value_type_id(inner).map(|ty| format!("{ty}[]!"));
    }
    if let Some(inner) = declared.strip_suffix("[]") {
        return std_value_type_id(inner).map(|ty| format!("{ty}[]"));
    }
    match declared {
        "CanDuration" => Some("duration".to_string()),
        "DatetimeValue" => Some("datetime".to_string()),
        _ if std_schema_type(declared).is_some() || nominal_schema(declared).is_some() => {
            Some(declared.to_string())
        }
        _ => None,
    }
}

fn std_value_base(mut declared: &str) -> &str {
    loop {
        let inner = declared
            .strip_suffix('?')
            .or_else(|| declared.strip_suffix("[]!"))
            .or_else(|| declared.strip_suffix("[]"));
        match inner {
            Some(inner) => declared = inner,
            None => return declared,
        }
    }
}

/// A partial nominal closure cannot supply native completion admission.
fn collect_std_value_contracts(
    declared: &str,
    seen: &mut BTreeSet<String>,
    contracts: &mut Vec<JsNominalResult>,
) -> Option<()> {
    let canonical = std_value_type_id(declared)?;
    let base = std_value_base(&canonical);
    if std_schema_type(base).is_some() {
        return Some(());
    }
    let schema = nominal_schema(base)?;
    if !seen.insert(schema.name.to_string()) {
        return Some(());
    }
    let fields = schema
        .fields
        .iter()
        .map(|(name, declared)| {
            Some(JsNominalLeaf {
                name: (*name).to_string(),
                declared: std_value_type_id(declared)?,
                constraints: JsValueConstraints::default(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    contracts.push(JsNominalResult {
        name: schema.name.to_string(),
        fields,
    });
    for (_, declared) in schema.fields {
        collect_std_value_contracts(declared, seen, contracts)?;
    }
    Some(())
}

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
    /// Declaring source path. Emitted only for multi-source closures, where
    /// the module source map cannot resolve one exact declaring file;
    /// single-source output stays byte-identical.
    pub source: Option<String>,
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
    /// Canonical value contract, distinct from a stored-record reference.
    Nominal {
        name: String,
    },
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
    JudgmentDelivery(JsJudgmentDeliveryDescriptor),
}

/// One T13c nominal result leaf, verbatim (JSON shape of
/// `ArtifactNominalLeaf`).
///
/// `declared` is the T13c transcribed kind spelling (`text?`,
/// `file[]`, `enum(a,b)`, nominal refs — catalog.rs mapping rules),
/// never a re-interpretation: T04b ratifies any structured leaf
/// vocabulary, and verbatim leaves derive it without loss.
#[derive(Debug, Clone, Default, Serialize)]
pub struct JsNominalLeaf {
    /// Leaf field name in producer order.
    pub name: String,
    /// Verbatim T13c declared kind spelling.
    #[serde(rename = "type")]
    pub declared: String,
    #[serde(flatten)]
    pub constraints: JsValueConstraints,
}

/// Finite constraints from a checked owning declaration or its reused field.
#[derive(Debug, Clone, Default, Serialize)]
pub struct JsValueConstraints {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trim: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(rename = "distinctBy", skip_serializing_if = "Option::is_none")]
    pub distinct_by: Option<String>,
    #[serde(rename = "excludedIds", skip_serializing_if = "Vec::is_empty")]
    pub excluded_ids: Vec<String>,
}

impl From<&crate::analysis::resolve::CheckedValueConstraints> for JsValueConstraints {
    fn from(value: &crate::analysis::resolve::CheckedValueConstraints) -> Self {
        Self {
            min: value.min.map(serde_json::Value::from),
            max: value.max.map(serde_json::Value::from),
            trim: None,
            format: value.format.clone(),
            distinct_by: value.distinct_by.clone(),
            excluded_ids: value.excluded_ids.clone(),
        }
    }
}

impl JsNominalLeaf {
    /// Compact JSON in the owning artifact contract's field order.
    pub fn to_json(&self) -> String {
        descriptor_json(self)
    }

    fn schema_json(&self) -> String {
        let mut schema = serde_json::to_value(self).expect("checked schema serializes");
        schema
            .as_object_mut()
            .expect("leaf is an object")
            .remove("name");
        schema.to_string()
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

/// Checked value schemas derived by their owning declarations.
#[derive(Debug, Clone, Default, Serialize)]
pub struct JsValueTypes {
    pub contracts: Vec<JsNominalResult>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub enums: Vec<JsNamedEnum>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<JsValueAlias>,
}

/// Private loader configuration, derived once from the complete checked census.
#[derive(Debug, Clone, Serialize)]
struct JsStandardCompletion {
    source: String,
    event: String,
    binding: String,
    from: String,
    #[serde(rename = "resultType")]
    result_type: Option<String>,
    handlers: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JsValueAlias {
    pub name: String,
    #[serde(rename = "type")]
    pub declared: String,
    #[serde(flatten)]
    pub constraints: JsValueConstraints,
}

#[derive(Debug, Clone, Serialize)]
pub struct JsNamedEnum {
    pub name: String,
    pub cases: Vec<String>,
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

/// Static Judgment delivery uses the exact declaration integer version.
#[derive(Debug, Clone)]
pub struct JsJudgmentDeliveryDescriptor {
    pub capability: String,
    pub operation: String,
    pub version: String,
    pub result: JsNominalResult,
}

impl JsJudgmentDeliveryDescriptor {
    pub fn to_json(&self) -> String {
        descriptor_json(self)
    }
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
                    constraints: JsValueConstraints::default(),
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
    /// Ordinary overridable creation default from the admitted actor.
    ContextActor,
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
/// are a parent path ([`parent_path`]) or the admitted actor. Other computed defaults (a
/// non-parent expression) maps to `None`: the caller keeps
/// `required: false`; owning model defaults or supported ordered scenario
/// handler fills preserve execution. Total and diagnostic-free:
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
        Some(IrDefault::Computed {
            expr,
            has_parent: false,
        }) if matches!(&expr.expr, IrExpr::Member { base, field }
                if field == "actor" && base.ty == ResolvedType::Unknown
                    && base.span == expr.span && matches!(&base.expr, IrExpr::Name(name) if name == "c"))
            && (expr.ty == ResolvedType::Scalar(Scalar::User)
                || expr.ty.nullable_inner() == Some(&ResolvedType::Scalar(Scalar::User))) =>
        {
            Some(JsFieldDefault::ContextActor)
        }
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
        IrExpr::Array(_) | IrExpr::Object(_) => wire_collection_literal(&expr.expr),
        IrExpr::Unary { op, operand } if *op == IrUnOp::Neg => {
            wire_negated_literal(&operand.expr)
        }
        IrExpr::Call { target, args } => wire_call_literal(target, args),
        _ => None,
    }
}

fn wire_collection_literal(expr: &IrExpr) -> Option<WireLiteral> {
    match expr {
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
        _ => None,
    }
}

fn wire_negated_literal(expr: &IrExpr) -> Option<WireLiteral> {
    match expr {
        IrExpr::Int(value) => Some(WireLiteral::String(value.checked_neg()?.to_string())),
        IrExpr::Decimal(spelling) => Some(WireLiteral::String(format!("-{spelling}"))),
        _ => None,
    }
}

fn wire_call_literal(target: &IrCallTarget, args: &[TypedExpr]) -> Option<WireLiteral> {
    let id = match target {
        IrCallTarget::Builtin { id, .. } => id.as_str(),
        IrCallTarget::CapabilityOp(_) | IrCallTarget::DeriveFn(_) => return None,
    };
    match (id, args) {
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
    /// Inclusive reused parameter-array lengths, as exact descriptor numbers.
    pub min: Option<u64>,
    pub max: Option<u64>,
    /// Input name (parameter or flattened model field).
    pub name: String,
    /// Closed typed schema (element kind for array inputs).
    pub field: JsMcpField,
    /// Checked source value identity when the wire kind alone is ambiguous.
    pub value_type: Option<String>,
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
    /// Scenario handler owns this computed default; preserve omission.
    pub computed_default: bool,
    /// Checked description source text, when authored (D03: the one
    /// slot inline/attached/shared/legacy spellings feed; variants
    /// never leave the source — localized MCP is deferred).
    pub description: Option<String>,
    /// Checked operation-owned dependent candidate assistance.
    pub choices: Option<JsInputChoiceBinding>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsInputChoiceBinding {
    pub version: u8,
    pub read_operation: String,
    pub arguments: BTreeMap<String, JsChoiceArgument>,
    pub value: JsChoiceValue,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JsChoiceArgument {
    pub input: String,
    pub path: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum JsChoiceValue {
    Record,
    Field { field: String },
}

impl From<&IrInputChoiceBinding> for JsInputChoiceBinding {
    fn from(binding: &IrInputChoiceBinding) -> Self {
        Self {
            version: 1,
            read_operation: binding.read_operation.clone(),
            arguments: binding
                .arguments
                .iter()
                .map(|(name, argument)| {
                    (
                        name.clone(),
                        JsChoiceArgument {
                            input: argument.input.clone(),
                            path: argument.path.clone(),
                        },
                    )
                })
                .collect(),
            value: match &binding.value {
                IrChoiceValue::Record => JsChoiceValue::Record,
                IrChoiceValue::Field(field) => JsChoiceValue::Field {
                    field: field.clone(),
                },
            },
            labels: binding.labels.clone(),
        }
    }
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
    pub root_authority: Option<crate::analysis::effects::RootAuthority>,
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
    pub result: Option<Cow<'static, str>>,
    /// Native evaluated-return provenance; published only with its capture recipe.
    pub disclosure: Option<serde_json::Value>,
    /// Source/IR-sealed owner query census for an authority-scoped read.
    pub authority_query_sites: Option<serde_json::Value>,
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
    /// Canonical value contract, distinct from a stored-record reference.
    Nominal {
        name: String,
    },
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
    JudgmentDelivery(JsJudgmentDeliveryDescriptor),
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
    pub value_type: Option<String>,
    /// Whether omission rejects at creation.
    pub required: bool,
    /// Whether the field accepts explicit null.
    pub nullable: bool,
    /// Checked normalization claim from the authored stored field.
    pub trim: Option<bool>,
    /// Checked inclusive field bounds, in the artifact wire representation.
    pub min: Option<serde_json::Value>,
    pub max: Option<serde_json::Value>,
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

impl Serialize for JsJudgmentDeliveryDescriptor {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("JudgmentDelivery", 6)?;
        state.serialize_field("kind", "delivery")?;
        state.serialize_field("judgment", &true)?;
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
    Nominal {
        name: &'a str,
    },
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
            Self::Nominal { name } => FieldTag::Nominal { name },
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
            Self::JudgmentDelivery(value) => return value.serialize(serializer),
        };
        tag.serialize(serializer)
    }
}

impl Serialize for JsModelFieldType {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let tag = match self {
            Self::Nominal { name } => FieldTag::Nominal { name },
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
            Self::JudgmentDelivery(value) => return value.serialize(serializer),
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
            Context {
                value: &'static str,
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
            Self::ContextActor => DefaultWire::Context { value: "actor" }.serialize(serializer),
            Self::Server(init) => DefaultWire::Server { init: *init }.serialize(serializer),
            Self::Derived => DefaultWire::Derived.serialize(serializer),
        }
    }
}

#[derive(Serialize)]
struct ArrayMarker {
    required: bool,
}

impl JsOperationField {
    fn serialize_bound_fields<S: SerializeStruct>(
        &self,
        state: &mut S,
    ) -> Result<(), S::Error> {
        if let Some(min) = self.min {
            state.serialize_field("min", &min)?;
        }
        if let Some(max) = self.max {
            state.serialize_field("max", &max)?;
        }
        if let Some(default) = &self.default {
            state.serialize_field("default", default)?;
        }
        if self.computed_default {
            state.serialize_field("computedDefault", &true)?;
        }
        Ok(())
    }
}

impl Serialize for JsOperationField {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct(
            "OperationField",
            3 + usize::from(self.min.is_some())
                + usize::from(self.max.is_some())
                + usize::from(self.nullable)
                + usize::from(self.value_type.is_some())
                + usize::from(self.array_required.is_some())
                + usize::from(self.default.is_some())
                + usize::from(self.computed_default)
                + usize::from(self.description.is_some())
                + usize::from(self.choices.is_some()),
        )?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("field", &self.field)?;
        if let Some(value_type) = &self.value_type {
            state.serialize_field("valueType", value_type)?;
        }
        state.serialize_field("required", &self.required)?;
        if self.nullable {
            state.serialize_field("nullable", &true)?;
        }
        if let Some(required) = self.array_required {
            state.serialize_field("array", &ArrayMarker { required })?;
        }
        self.serialize_bound_fields(&mut state)?;
        if let Some(description) = &self.description {
            state.serialize_field("description", description)?;
        }
        if let Some(choices) = &self.choices {
            state.serialize_field("choices", choices)?;
        }
        state.end()
    }
}

impl JsModelField {
    fn serialize_modifier_fields<S: SerializeStruct>(
        &self,
        state: &mut S,
    ) -> Result<(), S::Error> {
        if let Some(machine) = &self.machine {
            state.serialize_field("machine", machine)?;
        }
        if self.nullable {
            state.serialize_field("nullable", &true)?;
        }
        if let Some(trim) = self.trim {
            state.serialize_field("trim", &trim)?;
        }
        if let Some(min) = &self.min {
            state.serialize_field("min", min)?;
        }
        if let Some(max) = &self.max {
            state.serialize_field("max", max)?;
        }
        if let Some(required) = self.array_required {
            state.serialize_field("array", &ArrayMarker { required })?;
        }
        if let Some(default) = &self.default {
            state.serialize_field("default", default)?;
        }
        Ok(())
    }
}

impl Serialize for JsModelField {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct(
            "ModelField",
            4 + usize::from(self.nullable)
                + usize::from(self.trim.is_some())
                + usize::from(self.min.is_some())
                + usize::from(self.max.is_some())
                + usize::from(self.value_type.is_some())
                + usize::from(self.array_required.is_some())
                + usize::from(self.default.is_some())
                + usize::from(self.description.is_some())
                + usize::from(self.machine.is_some()),
        )?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("field", &self.field)?;
        if let Some(value_type) = &self.value_type {
            state.serialize_field("valueType", value_type)?;
        }
        state.serialize_field("required", &self.required)?;
        state.serialize_field("serverOnly", &self.server_only)?;
        self.serialize_modifier_fields(&mut state)?;
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
        struct ResultType<'a> {
            r#type: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            disclosure: Option<&'a serde_json::Value>,
        }
        let mut state = serializer.serialize_struct(
            "Operation",
            4 + usize::from(self.result.is_some()) + usize::from(self.root_authority.is_some())
                + usize::from(self.authority_query_sites.is_some()),
        )?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("kind", self.kind.as_str())?;
        state.serialize_field("description", &self.description)?;
        state.serialize_field(
            "inputs",
            &Inputs {
                fields: &self.inputs,
            },
        )?;
        if let Some(result) = &self.result {
            state.serialize_field(
                "result",
                &ResultType {
                    r#type: result,
                    disclosure: self.disclosure.as_ref(),
                },
            )?;
        }
        if let Some(authority) = &self.root_authority {
            state.serialize_field("rootAuthority", authority)?;
        }
        if let Some(sites) = &self.authority_query_sites {
            state.serialize_field("authorityQuerySites", sites)?;
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
    /// Lowering diagnostics, including `E6012` for unrepresentable output lines.
    pub diagnostics: Vec<Diagnostic>,
    /// Catalog builtins the lowering references (for `E6007` checks).
    pub referenced_builtins: Vec<ReferencedBuiltin>,
    /// Checked membership occurrences bound to the State producer by this
    /// lowering. Assembly resolves their builtin references to that defining
    /// owner instead of reporting the generic catalog's external marker.
    pub membership_bound: Vec<Span>,
    /// Callable registry entries in source order.
    pub callables: Vec<JsCallable>,
    /// Page descriptors in source order.
    pub pages: Vec<JsPage>,
    /// User-invocable operation descriptors in source order (MCP P1).
    pub operations: Vec<JsOperation>,
    /// One checked inventory shared by artifact claims and app schemas.
    pub value_types: Option<JsValueTypes>,
    /// Complete local checked owner-policy declaration coverage, when supported.
    pub model_policies: Option<Vec<ModelPolicies>>,
    /// Complete checked committed-model source inventory, when present.
    pub committed_changes: Option<Vec<JsCommittedChange>>,
    /// `@canlang/stdlib` imports used by the entrypoint.
    pub stdlib_imports: BTreeSet<String>,
    /// `@canlang/ui` imports used by the entrypoint.
    pub ui_imports: BTreeSet<String>,
}

/// Rust producer mirror of ArtifactCommittedChangeDescriptor; Contracts owns
/// the shared wire interface. Both envelopes reuse this single inventory.
#[derive(Debug, Clone, Serialize)]
pub struct JsCommittedChange {
    pub source: String,
    pub model: String,
    pub change: super::ir::IrCommittedChange,
    pub handlers: Vec<String>,
}

/// Line-oriented writer attributing every emitted line to a source span.
#[derive(Debug, Default)]
pub struct JsWriter {
    buf: String,
    lines: Vec<JsLine>,
    capacity_error: Option<Diagnostic>,
}

impl JsWriter {
    /// Create an empty writer.
    pub fn new() -> Self {
        Self::default()
    }

    /// Push text attributed to `span` (and optionally `name`), followed by
    /// a newline. Each physical output line receives the owning attribution.
    /// An unrepresentable 1-based u32 line number latches `E6012` before
    /// changing output. Subsequent writes are ignored; check [`Self::try_finish`].
    pub fn push(&mut self, span: Span, name: Option<String>, text: &str) {
        if self.capacity_error.is_some() {
            return;
        }
        let Some(last_line) = text
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count()
            .checked_add(1)
            .and_then(|count| self.lines.len().checked_add(count))
            .and_then(|line| u32::try_from(line).ok())
        else {
            self.capacity_error = Some(Self::line_capacity_error(span));
            return;
        };
        let first_line = self.lines.len() + 1;
        self.buf.push_str(text);
        self.buf.push('\n');
        for line in first_line..=last_line as usize {
            self.lines.push(JsLine {
                line: line as u32,
                span,
                name: name.clone(),
            });
        }
    }

    /// Append another writer's lines, renumbering them.
    /// A failed writer or an unrepresentable combined line count latches
    /// `E6012` before changing output. Check [`Self::try_finish`] for failure.
    pub fn append(&mut self, other: &JsWriter) {
        if self.capacity_error.is_some() {
            return;
        }
        if let Some(error) = &other.capacity_error {
            self.capacity_error = Some(error.clone());
            return;
        }
        if self
            .lines
            .len()
            .checked_add(other.lines.len())
            .and_then(|count| u32::try_from(count).ok())
            .is_none()
        {
            // Both writers individually fit. The first appended line beyond
            // u32::MAX retains its owning source span in the diagnostic.
            let first_excess = u32::MAX as usize - self.lines.len();
            self.capacity_error = Some(Self::line_capacity_error(other.lines[first_excess].span));
            return;
        }
        let offset = u32::try_from(self.lines.len()).expect("admitted JavaScript line count");
        self.buf.push_str(&other.buf);
        for line in &other.lines {
            self.lines.push(JsLine {
                line: offset + line.line,
                span: line.span,
                name: line.name.clone(),
            });
        }
    }

    fn line_capacity_error(span: Span) -> Diagnostic {
        Diagnostic::error(
            "E6012",
            "generated JavaScript line number exceeds the u32 range".to_string(),
            span,
        )
    }

    /// Finish into a module, refusing any incomplete prefix after failure.
    pub fn try_finish(&self, path: String) -> Result<JsModule, Diagnostic> {
        if let Some(error) = &self.capacity_error {
            return Err(error.clone());
        }
        Ok(JsModule {
            path,
            js: self.buf.clone(),
            lines: self.lines.clone(),
        })
    }

    /// Compatibility convenience for callers that require representable output.
    ///
    /// # Panics
    /// Panics deterministically when emission latched a capacity diagnostic.
    /// Production emission uses [`Self::try_finish`] to report that diagnostic.
    pub fn finish(&self, path: String) -> JsModule {
        self.try_finish(path)
            .unwrap_or_else(|error| panic!("cannot finish JavaScript module: {}", error.message))
    }
}

/// Lower an [`IrProgram`] to production JS modules.
///
/// Returns the entrypoint module, one module per non-entrypoint package,
/// Lowering diagnostics and the link metadata the artifact assembly needs.
pub fn emit_program(ir: &IrProgram) -> JsOutput {
    emit_program_with_native_receipts(ir, false)
}

pub fn emit_program_with_native_receipts(ir: &IrProgram, native_receipts: bool) -> JsOutput {
    emit_program_with_receipt_sources(ir, native_receipts, None)
}

/// Native call-site preparation needs the same verified source cohort as IR.
/// Hosts without those bytes keep call effects outside the receipt profile.
pub fn emit_program_with_native_source_receipts(
    ir: &IrProgram,
    native_receipts: bool,
    db: &crate::source::SourceDb,
) -> JsOutput {
    emit_program_with_receipt_sources(ir, native_receipts, Some(db))
}

/// Emit nongrant source inventories alongside independently prepared immutable
/// Complete query receipts. Source inventories alone cannot activate capture.
#[derive(Default)]
pub(super) struct EmitDecisionSources<'a> {
    pub source_context: Option<&'a super::scenario_decisions::FreshSourceContext<'a>>,
    pub authority_queries: Option<&'a super::authority_query_sites::PreparedAuthorityQuerySites>,
    pub owner_handlers: Option<&'a HashSet<SymbolId>>,
    pub private_derives: Option<&'a HashSet<String>>,
    pub local_policies: Option<&'a LocalPolicies>,
    pub unique_conditions: Option<&'a [super::model_unique_conditions::CheckedUniqueCondition]>,
    pub model_rule_origins: Option<&'a [serde_json::Value]>,
    pub query_any: Option<&'a BTreeMap<String, serde_json::Value>>,
    pub query_selections: Option<&'a BTreeMap<String, serde_json::Value>>,
    pub transcript_queries:
        Option<&'a BTreeMap<String, super::scenario_receipts::ReceiptDisclosurePlan>>,
    pub membership: Option<&'a super::membership::MembershipSources>,
    pub mailbox_events: Option<&'a super::mailbox_events::PreparedMailboxEvents<'a>>,
    pub payments_changed_events:
        Option<&'a super::payments_events::PreparedPaymentsChangedEvents<'a>>,
    pub standard_terminal_events:
        Option<&'a super::standard_terminal_events::PreparedStandardTerminalEvents<'a>>,
    pub read_predicates: Option<&'a super::read_predicates::PreparedReadPredicates>,
    pub send_guards: Option<&'a super::send_guards::PreparedSendGuards>,
    pub send_guard_gap: Option<&'a super::send_guards::SendGuardGap>,
}

/// A missing executable Rule will receive a precise diagnostic while the
/// SEND body lowers. Omit the earlier owner-wide refusal only when its exact
/// original guarded-SEND census is still present in the executable IR.
fn missing_source_checked_send_rule(
    ir: &IrProgram,
    owner: &IrItem,
    prepared: Option<&HashMap<Span, super::send_guards::PreparedSendGuard>>,
) -> bool {
    fn collect(statements: &[IrStmt], spans: &mut Vec<Span>) {
        for statement in statements {
            match statement {
                IrStmt::Send { when: Some(_), span, .. } => spans.push(*span),
                IrStmt::If { then_branch, else_branch, .. } => {
                    collect(then_branch, spans);
                    collect(else_branch, spans);
                }
                IrStmt::For { body, .. } => collect(body, spans),
                IrStmt::Match { arms, .. } => {
                    for arm in arms { collect(&arm.body, spans); }
                }
                _ => {}
            }
        }
    }
    let IrItemKind::Scenario { guards, effects, hook: None, .. } = &owner.kind else {
        return false;
    };
    let Some(source_sites) = ir.scenario_disclosures.get(&owner.id)
        .and_then(|disclosure| disclosure.source_facts())
        .and_then(|facts| facts.decision_sites.as_ref())
    else { return false; };
    let source_sites: Vec<Span> = source_sites.iter().filter(|site| {
        site.owner == owner.id
            && site.stage == crate::analysis::scenario_disclosure::CheckedDecisionStage::SendDispatch
    }).map(|site| Span::new(site.statement.file, site.statement.start, site.statement.end)).collect();
    if source_sites.is_empty() { return false; }
    let source_unique: HashSet<Span> = source_sites.iter().copied().collect();
    if source_unique.len() != source_sites.len() { return false; }
    let mut executable = Vec::new();
    collect(guards, &mut executable);
    collect(effects, &mut executable);
    let executable_unique: HashSet<Span> = executable.iter().copied().collect();
    executable.len() == source_sites.len()
        && executable_unique == source_unique
        && executable.iter().any(|span| prepared.is_none_or(|guards| !guards.contains_key(span)))
}

// A source-only frame has no saved-result, query, child-call or File
// authority. Its Work effects and scalar DATA consumption require their
// independently installed original owner joins; ordinary CRUD and scalar
// evaluation retain their existing caller grants and mutation pipeline.
fn source_event_payload(ir:&IrProgram,owner:&IrItem,event:&str,payload:&TypedExpr,
        values:&BTreeSet<String>,records:&BTreeMap<String,ResolvedType>,context:Option<&super::scenario_decisions::FreshSourceContext<'_>>)->bool{
        if context.is_none_or(|context|context.same_event_schema(event).is_none()){return false;}
        let Some(declaration)=ir.items.iter().find(|item|item.canonical==event&&item.module==owner.module)else{return false;};
        let IrItemKind::Event{fields}=&declaration.kind else{return false;};
        let IrExpr::Object(entries)=&payload.expr else{return false;};
        if fields.len()!=entries.len()||entries.len()>200{return false;}
        entries.iter().all(|(name,value)|{
            let Some(field)=fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).find(|field|field.name==*name)else{return false;};
            let IrItemKind::Field{ty:IrType::Known(expected),..}=&field.kind else{return false;};
            // An event may retain the exact original admitted model identity,
            // never a stored member, computed reference or copied row carrier.
            let root_reference=matches!((&value.expr,&value.ty,expected),
                (IrExpr::Name(name),ResolvedType::Record{symbol,..},ResolvedType::Record{symbol:target,..})
                    if symbol==target&&records.get(name)==Some(&value.ty));
            send_value(ir,value,values,0)||root_reference
        })
    }

fn source_only_cancels(ir:&IrProgram,owner:&IrItem,context:&super::scenario_decisions::FreshSourceContext<'_>,
    requires:&HashMap<Span,serde_json::Value>,module:&str)->Option<HashMap<Span,serde_json::Value>>{
    let source=requires.values().find(|source|source["owner"]==owner.canonical)?["source"].clone();
    let IrItemKind::Scenario{params,effects,hook:None,read:false,trusted:false,..}=&owner.kind else{return None;};
    context.same_scenario(ir, owner)?;
    let mut roots:BTreeMap<String,SymbolId>=params.iter().filter_map(|id|{let param=ir.items.get(id.0 as usize)?;
        let IrItemKind::Param{ty:IrType::Known(ResolvedType::Record{symbol,stored:true}),..}=&param.kind else{return None;};
        matches!(ir.items.get(symbol.0 as usize)?.kind,IrItemKind::Model{..}).then(||(param.name.clone(),*symbol))}).collect();
    fn walk(ir:&IrProgram,owner:&IrItem,body:&[IrStmt],roots:&mut BTreeMap<String,SymbolId>,source:&serde_json::Value,module:&str,
        output:&mut HashMap<Span,serde_json::Value>){
        for statement in body{match statement{
            IrStmt::Let{name,..}=>{roots.remove(name);},
            IrStmt::Cancel{owner_package,key,span}=>{
                let IrExpr::Member{base,field}=&key.expr else{continue;};let IrExpr::Name(parameter)=&base.expr else{continue;};
                let Some(symbol)=roots.get(parameter)else{continue;};
                if field!="id"||key.ty!=ResolvedType::Scalar(Scalar::Text)||owner.canonical.rsplit_once('.').map(|(package,_)|package)!=Some(owner_package)
                    ||!matches!(&base.ty,ResolvedType::Record{symbol:actual,stored:true}if actual==symbol){continue;}
                output.insert(*span,serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},
                    "owner":owner.canonical,"node":{"start":span.start,"end":span.end},"parameter":parameter,"model":ir.items[symbol.0 as usize].canonical,
                    "ownerPackage":owner_package}));
            },
            IrStmt::If{then_branch,else_branch,..}=>{walk(ir,owner,then_branch,&mut roots.clone(),source,module,output);walk(ir,owner,else_branch,&mut roots.clone(),source,module,output);},
            IrStmt::Match{arms,..}=>for arm in arms{walk(ir,owner,&arm.body,&mut roots.clone(),source,module,output);},
            _=>{},
        }}
    }
    let mut output=HashMap::new();walk(ir,owner,effects,&mut roots,&source,module,&mut output);Some(output)
}

fn source_only_schedules(ir:&IrProgram,owner:&IrItem,context:&super::scenario_decisions::FreshSourceContext<'_>,
    requires:&HashMap<Span,serde_json::Value>,module:&str)->Option<HashMap<Span,serde_json::Value>>{
    let source=requires.values().find(|source|source["owner"]==owner.canonical)?["source"].clone();
    let IrItemKind::Scenario{params,effects,hook:None,read:false,trusted:false,..}=&owner.kind else{return None;};
    fn contains_schedule(body:&[IrStmt])->bool{body.iter().any(|statement|match statement{
        IrStmt::Schedule{..}=>true,IrStmt::If{then_branch,else_branch,..}=>contains_schedule(then_branch)||contains_schedule(else_branch),
        IrStmt::Match{arms,..}=>arms.iter().any(|arm|contains_schedule(&arm.body)),_=>false})}
    if !contains_schedule(effects){return Some(HashMap::new());}
    context.same_scenario(ir, owner)?;
    let mut roots:BTreeMap<String,ResolvedType>=params.iter().filter_map(|id|{let param=ir.items.get(id.0 as usize)?;
        let IrItemKind::Param{ty:IrType::Known(ty@ResolvedType::Record{symbol,stored:true}),..}=&param.kind else{return None;};
        matches!(ir.items.get(symbol.0 as usize)?.kind,IrItemKind::Model{..}).then(||(param.name.clone(),ty.clone()))}).collect();
    let creates=super::source_created_rows::collect(ir,owner,context,&source)?;
    fn id_root<'a>(value:&'a TypedExpr,roots:&BTreeMap<String,ResolvedType>)->Option<&'a str>{
        let IrExpr::Member{base,field}=&value.expr else{return None;};let IrExpr::Name(name)=&base.expr else{return None;};
        (field=="id"&&value.ty==ResolvedType::Scalar(Scalar::Text)&&roots.get(name)==Some(&base.ty)).then_some(name.as_str())
    }
    fn key_root<'a>(value:&'a TypedExpr,roots:&BTreeMap<String,ResolvedType>)->Option<(&'a str,Option<String>)>{
        if let Some(name)=id_root(value,roots){return Some((name,None));}
        let args=match &value.expr{
            IrExpr::Call{target:IrCallTarget::Builtin{id,awaited:false},args}if id=="format"=>args,
            IrExpr::BoundCall{target:IrCallTarget::Builtin{id,awaited:false},args,slots}if id=="format"&&slots.as_slice()==[Some(0),Some(1)]=>args,
            _=>return None,
        };
        let [template,fields]=args.as_slice()else{return None;};
        let IrExpr::Text(template)=&template.expr else{return None;};
        let (prefix,suffix)=template.split_once("{id}")?;
        if value.ty!=ResolvedType::Scalar(Scalar::Text)||template.len()>512||prefix.contains(['{','}'])||suffix.contains(['{','}']){return None;}
        let IrExpr::Object(fields)=&fields.expr else{return None;};let [(field,id)]=fields.as_slice()else{return None;};
        if field!="id"{return None;}Some((id_root(id,roots)?,Some(template.clone())))
    }
    fn original_now(value:&TypedExpr)->bool{
        value.ty==ResolvedType::Scalar(Scalar::Datetime)&&matches!(&value.expr,IrExpr::Member{base,field}
            if field=="now"&&base.ty==ResolvedType::Unknown&&base.span==value.span&&matches!(&base.expr,IrExpr::Name(name)if name=="c"))
    }
    fn source_time(value:&TypedExpr)->Option<serde_json::Value>{
        if original_now(value){return Some(serde_json::json!("now"));}
        let IrExpr::Binary{op:IrBinOp::Add,left,right}=&value.expr else{return None;};
        let IrExpr::DurationMs(offset)=&right.expr else{return None;};
        if !original_now(left)||right.ty!=ResolvedType::Scalar(Scalar::Duration)||value.ty!=ResolvedType::Scalar(Scalar::Datetime)
            ||i64::try_from(*offset).is_err(){return None;}
        Some(serde_json::json!({"offset":offset.to_string()}))
    }
    let mut values:BTreeSet<String>=params.iter().filter_map(|id|{let item=ir.items.get(id.0 as usize)?;
        matches!(&item.kind,IrItemKind::Param{ty:IrType::Known(ty),..}if plain_value(ir,ty,0)).then(||item.name.clone())}).collect();
    fn walk(ir:&IrProgram,owner:&IrItem,body:&[IrStmt],roots:&mut BTreeMap<String,ResolvedType>,values:&mut BTreeSet<String>,source:&serde_json::Value,module:&str,context:&super::scenario_decisions::FreshSourceContext<'_>,creates:&[serde_json::Value],active:&mut BTreeMap<String,serde_json::Value>,output:&mut HashMap<Span,serde_json::Value>){
        for statement in body{match statement{
            IrStmt::Let{name,value,..}=>{let pure=send_value(ir,value,values,0);roots.remove(name);active.remove(name);values.remove(name);if pure{values.insert(name.clone());}},
            IrStmt::Create{model,binding:Some(binding),span,..}=>{
                roots.remove(binding);active.remove(binding);values.remove(binding);
                if let Some(created)=creates.iter().find(|created|created["binding"]==*binding&&created["model"]==*model
                    &&created["node"]["start"]==span.start&&created["node"]["end"]==span.end)
                    &&let Some(target)=ir.items.iter().find(|item|item.canonical==*model){
                    roots.insert(binding.clone(),ResolvedType::Record{symbol:target.id,stored:true});active.insert(binding.clone(),created.clone());
                }
            },
            IrStmt::Schedule{owner_package,key,at,event,payload,span}=>{
                let Some((parameter,template))=key_root(key,roots)else{continue;};
                let Some(ResolvedType::Record{symbol,stored:true})=roots.get(parameter)else{continue;};
                let Some(time)=source_time(at)else{continue;};
                if owner.canonical.rsplit_once('.').map(|(package,_)|package)!=Some(owner_package)
                    ||!source_event_payload(ir,owner,event,payload,values,roots,Some(context)){continue;}
                let mut site=serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},
                    "owner":owner.canonical,"node":{"start":span.start,"end":span.end},"parameter":parameter,"model":ir.items[symbol.0 as usize].canonical,
                    "ownerPackage":owner_package,"event":event,"at":time});
                if let Some(template)=template{site["key"]=serde_json::json!({"template":template});}
                if let Some(created)=active.get(parameter){site["created"]=created.clone();}
                output.insert(*span,site);
            },
            IrStmt::If{then_branch,else_branch,..}=>{walk(ir,owner,then_branch,&mut roots.clone(),&mut values.clone(),source,module,context,creates,&mut active.clone(),output);walk(ir,owner,else_branch,&mut roots.clone(),&mut values.clone(),source,module,context,creates,&mut active.clone(),output);},
            IrStmt::Match{arms,..}=>for arm in arms{walk(ir,owner,&arm.body,&mut roots.clone(),&mut values.clone(),source,module,context,creates,&mut active.clone(),output);},_=>{}
        }}
    }
    let mut output=HashMap::new();walk(ir,owner,effects,&mut roots,&mut values,&source,module,context,&creates,&mut BTreeMap::new(),&mut output);Some(output)
}

fn source_require_only_body_supported(ir: &IrProgram, owner: &IrItem, sources:&HashMap<Span,serde_json::Value>,data_sends:&HashMap<Span,serde_json::Value>,let_data:&HashMap<Span,serde_json::Value>,cancels:&HashMap<Span,serde_json::Value>,schedules:&HashMap<Span,serde_json::Value>,data_emits:&HashMap<Span,serde_json::Value>,loops:&HashMap<String,serde_json::Value>,context:Option<&super::scenario_decisions::FreshSourceContext<'_>>) -> bool {
    fn expression(ir: &IrProgram, value: &TypedExpr, depth: usize) -> bool {
        if depth > 64 { return false; }
        let child = |value: &TypedExpr| expression(ir, value, depth + 1);
        match &value.expr {
            IrExpr::Int(_) | IrExpr::Decimal(_) | IrExpr::Text(_) | IrExpr::Bool(_)
            | IrExpr::Null | IrExpr::Money { .. } | IrExpr::DurationMs(_)
            | IrExpr::Date(_) | IrExpr::Datetime(_) | IrExpr::Name(_) => true,
            IrExpr::Member { base, field } => {
                let mut ty = &base.ty;
                while let ResolvedType::Nullable(inner) = ty { ty = inner; }
                let derived = matches!(ty, ResolvedType::Record { symbol, .. } if
                    ir.items.iter().any(|item| matches!(&item.kind, IrItemKind::DeriveField { model, .. }
                        if model == symbol && item.canonical.rsplit('.').next() == Some(field.as_str()))));
                !derived && child(base)
            }
            IrExpr::Call { target: IrCallTarget::Builtin { awaited: false, .. }, args }
            | IrExpr::BoundCall { target: IrCallTarget::Builtin { awaited: false, .. }, args, .. }
                => args.iter().all(child),
            IrExpr::Binary { left, right, .. } => child(left) && child(right),
            IrExpr::Unary { operand, .. } => child(operand),
            IrExpr::Array(values) => values.iter().all(child),
            IrExpr::Object(fields) => fields.iter().all(|(_, value)| child(value)),
            IrExpr::HasRole { person, .. } => person.as_ref().is_none_or(|value| child(value)),
            _ => false,
        }
    }
    fn statements(ir: &IrProgram,owner:&IrItem, body: &[IrStmt], depth: usize,
        values:&mut BTreeSet<String>,records:&mut BTreeMap<String,ResolvedType>,consumed:&HashSet<Span>,data_sends:&HashMap<Span,serde_json::Value>,let_data:&HashMap<Span,serde_json::Value>,cancels:&HashMap<Span,serde_json::Value>,schedules:&HashMap<Span,serde_json::Value>,data_emits:&HashMap<Span,serde_json::Value>,loops:&HashMap<String,serde_json::Value>,context:Option<&super::scenario_decisions::FreshSourceContext<'_>>) -> bool {
        if depth > 64 { return false; }
        body.iter().all(|statement| match statement {
            IrStmt::For{span,body,..}=>loops.get(&owner.canonical).and_then(|source|source["loops"].as_array()).is_some_and(|entries|
                entries.iter().any(|entry|entry["node"]["start"]==span.start&&entry["node"]["end"]==span.end))
                &&statements(ir,owner,body,depth+1,&mut values.clone(),&mut records.clone(),consumed,data_sends,let_data,cancels,schedules,data_emits,loops,context),
            IrStmt::Let { name,value,span } => {
                let pure=send_value(ir,value,values,0)||let_data.contains_key(span);
                values.remove(name);
                records.remove(name);
                if pure{values.insert(name.clone());}
                expression(ir,value,0)
            },
            IrStmt::Return { value, .. } => value.as_ref().is_none_or(|value| expression(ir, value, 0)),
            IrStmt::Create { input, when: None, .. } => expression(ir, input, 0),
            IrStmt::Send { args, when: None, span,.. } => send_value(ir,args,values,0)||data_sends.contains_key(span),
            IrStmt::Emit { event,payload,span } => data_emits.contains_key(span)||source_event_payload(ir,owner,event,payload,values,records,context),
            IrStmt::Cancel {span,..}=>cancels.contains_key(span),
            IrStmt::Schedule{span,..}=>schedules.contains_key(span),
            IrStmt::Set { record, changes, when: None, .. } => expression(ir, record, 0) && expression(ir, changes, 0),
            IrStmt::Delete { record, .. } | IrStmt::Transition { record, .. } => expression(ir, record, 0),
            IrStmt::Require { cond, .. } => consumed.contains(&cond.span) || expression(ir, cond, 0),
            IrStmt::If { cond, then_branch, else_branch, .. } => (consumed.contains(&cond.span)||expression(ir, cond, 0))
                && statements(ir,owner, then_branch, depth + 1,&mut values.clone(),&mut records.clone(),consumed,data_sends,let_data,cancels,schedules,data_emits,loops,context) && statements(ir,owner, else_branch, depth + 1,&mut values.clone(),&mut records.clone(),consumed,data_sends,let_data,cancels,schedules,data_emits,loops,context),
            IrStmt::Match { subject, arms, .. } => expression(ir, subject, 0)
                && arms.iter().all(|arm| statements(ir,owner, &arm.body, depth + 1,&mut values.clone(),&mut records.clone(),consumed,data_sends,let_data,cancels,schedules,data_emits,loops,context)),
            _ => false,
        })
    }
    let IrItemKind::Scenario{params,guards,effects,hook:None,..}=&owner.kind else{return false;};
    let mut values=params.iter().filter_map(|id|{
        let param=ir.items.get(id.0 as usize)?;
        let IrItemKind::Param{ty:IrType::Known(ty),..}=&param.kind else{return None;};
        plain_value(ir,ty,0).then(||param.name.clone())
    }).collect();
    let consumed=sources.iter().filter_map(|(span,source)|
        (source["owner"]==owner.canonical && source["node"]["start"]==span.start && source["node"]["end"]==span.end).then_some(*span)).collect();
    let mut records=params.iter().filter_map(|id|{
        let param=ir.items.get(id.0 as usize)?;
        let IrItemKind::Param{ty:IrType::Known(ty),..}=&param.kind else{return None;};
        matches!(ty,ResolvedType::Record{symbol,stored:true}
            if ir.items.get(symbol.0 as usize).is_some_and(|item|matches!(item.kind,IrItemKind::Model{..})))
            .then(||(param.name.clone(),ty.clone()))
    }).collect();
    statements(ir,owner,guards,0,&mut values,&mut records,&consumed,data_sends,let_data,cancels,schedules,data_emits,loops,context)
        && statements(ir,owner,effects,0,&mut values,&mut records,&consumed,data_sends,let_data,cancels,schedules,data_emits,loops,context)
}

pub(super) fn emit_program_with_feasible_query_sources(
    ir: &IrProgram,
    native_receipts: bool,
    db: &crate::source::SourceDb,
    queries: &BTreeMap<String, serde_json::Value>,
    query_receipts: &BTreeMap<String, super::scenario_receipts::NativeScenarioReceipt>,
    decisions: EmitDecisionSources<'_>,
    feasibility: Option<&super::scenario_feasibility::PreparedRequireReturns<'_>>,
) -> JsOutput {
    emit_program_with_sources(
        ir,
        native_receipts,
        Some(db),
        Some(queries),
        Some(query_receipts),
        decisions,
        feasibility,
    )
}

fn emit_program_with_receipt_sources(
    ir: &IrProgram,
    native_receipts: bool,
    db: Option<&crate::source::SourceDb>,
) -> JsOutput {
    emit_program_with_sources(
        ir,
        native_receipts,
        db,
        None,
        None,
        EmitDecisionSources::default(),
        None,
    )
}

// --- Saved Then production join ------------------------------------------
// Checked Then descriptors (`then_views`, `css_scope`) joined to
// emitted wrappers: prompted `show` sites call their saved renderer
// through `generatedViewInstance` with compiler-owned instance roots
// and hooks, importing the staged view module. Resolution runs here
// (beside emission, from the driver database) so both the emitter
// and the compile driver share one implementation: emission falls
// back to the ordinary inline expansion when a site does not
// resolve, while the driver diagnoses missing/incompatible inputs
// and packs the consumed stylesheets and view modules.
//
// `GENERATED_VIEW_WIRE_VERSION` is the presentation contract the UI
// factory asserts on the emitted descriptor. Note it differs from
// the compiler-internal `then_views::THEN_VIEW_CONTRACT_VERSION`,
// which names the lowering contract, not the instance wire shape.

/// Presentation wire version carried by emitted view descriptors.
pub(crate) const GENERATED_VIEW_WIRE_VERSION: &str = "canlang.presentation.generated-view/1";

/// One resolved `show` site: the prompted view, its saved renderer
/// unit, and the style unit styling the renderer root, if any.
#[derive(Debug, Clone)]
pub(crate) struct ResolvedShow {
    /// Prompted view name (`TaskTile`).
    pub view_name: String,
    /// Canonical row model (`Owner.Model`).
    pub row_model: String,
    /// Saved view unit id (staged `can.generated/<id>/view.js`).
    pub unit_id: String,
    /// Declared canonical controls in source order.
    pub controls: Vec<super::then_views::ThenControl>,
    pub binding_names: Vec<(Span, String)>,
    /// Style unit id styling the renderer root, when declared.
    pub root_style: Option<String>,
    /// Independent ownership for optional saved renderer CSS.
    pub renderer_style: Option<String>,
}

/// Saved Then inputs resolved for one compilation: renderer plans
/// per `show` site, consumed view/style groups for packing, and
/// coverage failures the driver diagnoses.
#[derive(Debug, Clone, Default)]
pub(crate) struct ThenBuildJoin {
    /// Renderer plans keyed by `show` use span.
    shows: HashMap<Span, ResolvedShow>,
    /// Consumed view units by unit id, for module packing.
    views: HashMap<String, crate::analysis::generation_intake::SavedGroup>,
    /// Consumed style units by unit id, for CSS packing.
    styles: HashMap<String, crate::analysis::generation_intake::SavedGroup>,
    /// Checked ordinary component/page host span to its saved style unit.
    style_hosts: HashMap<Span, String>,
    /// Coverage failures: the use/definition span plus its detail
    /// (missing unit, ambiguous association, incompatible group).
    missing: Vec<(Span, String)>,
}

struct FileThen {
    owner: String,
    descriptors: Vec<crate::analysis::generation::GenerationDescriptor>,
    views: Vec<super::then_views::ThenView>,
    edges: Vec<super::then_views::UseEdge>,
    view_spans: Vec<(String, Span)>,
    show_refs: Vec<(String, Span)>,
    style_hosts: Vec<(Span, Span)>,
}

impl ThenBuildJoin {
    fn collect_then_files(db: &crate::source::SourceDb) -> Vec<FileThen> {
        use crate::analysis::generation::discover_generation;
        let mut files: Vec<FileThen> = Vec::new();
        for (id, source) in db.iter() {
            let (tree, _) = crate::syntax::parse_source(id, &source.text);
            // Keep the existing collection scoped to a logical module, rather
            // than assigning all definitions and uses the file's last owner.
            let modules: Vec<_> = tree
                .children
                .iter()
                .filter(|node| {
                    matches!(
                        node.kind,
                        crate::syntax::SyntaxKind::App | crate::syntax::SyntaxKind::Package
                    )
                })
                .collect();
            let modules = if modules.is_empty() {
                vec![&tree]
            } else {
                modules
            };
            for tree in modules {
                let found = discover_generation(&tree, &source.text);
                let lowering = super::then_views::lower_then_views(&tree, &source.text);
                let edges = super::then_views::walk_generation_uses(
                    &tree,
                    &source.text,
                    &found.descriptors,
                );
                let mut view_spans = Vec::new();
                let mut show_refs = Vec::new();
                let mut style_hosts = Vec::new();
                let mut owner = String::new();
                for node in tree.descendants() {
                    for suffix in node
                        .children
                        .iter()
                        .filter(|child| child.kind == crate::syntax::SyntaxKind::StyleSuffix)
                    {
                        style_hosts.push((suffix.span, node.span));
                    }
                    if matches!(
                        node.kind,
                        crate::syntax::SyntaxKind::App | crate::syntax::SyntaxKind::Package
                    ) {
                        let ns: Vec<String> = node
                            .children
                            .iter()
                            .filter(|c| c.kind == crate::syntax::SyntaxKind::Name)
                            .filter_map(|c| c.token().map(|t| t.text(&source.text).to_string()))
                            .collect();
                        if ns.len() >= 2 {
                            owner = ns[1].clone();
                        }
                    } else if node.kind == crate::syntax::SyntaxKind::View {
                        let name = node
                            .children
                            .iter()
                            .filter(|c| c.kind == crate::syntax::SyntaxKind::Name)
                            .filter_map(|c| c.token().map(|t| t.text(&source.text).to_string()))
                            .nth(1)
                            .unwrap_or_default();
                        view_spans.push((name, node.span));
                    } else if node.kind == crate::syntax::SyntaxKind::Show {
                        let name = node
                            .children
                            .iter()
                            .filter(|c| c.kind == crate::syntax::SyntaxKind::Name)
                            .filter_map(|c| c.token().map(|t| t.text(&source.text).to_string()))
                            .nth(1)
                            .unwrap_or_default();
                        show_refs.push((name, node.span));
                    }
                }
                if owner.is_empty() {
                    owner = found
                        .descriptors
                        .first()
                        .map(|d| d.owner.clone())
                        .unwrap_or_default();
                }
                files.push(FileThen {
                    owner,
                    descriptors: found.descriptors,
                    views: lowering.views,
                    edges,
                    view_spans,
                    show_refs,
                    style_hosts,
                });
            }
        }
        files
    }

    fn collect_consumed_views(files: &[FileThen]) -> std::collections::HashSet<(String, String)> {
        use crate::analysis::generation::GenerationKind;
        let mut consumed_views: std::collections::HashSet<(String, String)> =
            std::collections::HashSet::new();
        for file in files {
            for edge in &file.edges {
                if edge.definition_kind == GenerationKind::ViewDefinition {
                    consumed_views.insert((edge.owner.clone(), edge.definition_label.clone()));
                }
            }
            for (name, _) in &file.show_refs {
                consumed_views.insert((file.owner.clone(), name.clone()));
            }
        }
        consumed_views
    }

    fn inside_unconsumed_view(
        consumed_views: &std::collections::HashSet<(String, String)>,
        file: &FileThen,
        span: &Span,
    ) -> bool {
        file.view_spans.iter().any(|(name, view)| {
            view.file == span.file
                && view.start <= span.start
                && span.end <= view.end
                && (view.start, view.end) != (span.start, span.end)
                && !consumed_views.contains(&(file.owner.clone(), name.clone()))
        })
    }

    fn capture_standalone_snapshot(
        db: &crate::source::SourceDb,
        files: &[FileThen],
    ) -> Option<
        Result<crate::analysis::generation_store::FrozenGeneration, String>,
    > {
        // Library callers get the same snapshot boundary as the CLI. Their
        // already checked source text must agree with the captured filesystem.
        if db.generation.is_none()
            && files.iter().any(|file| {
                file.descriptors
                    .iter()
                    .any(|descriptor| descriptor.has_generation_identity)
            })
        {
            if db
                .iter()
                .any(|(_, source)| !std::path::Path::new(&source.path).is_file())
            {
                Some(Err(
                    "saved generation requires readable owning source files".to_string(),
                ))
            } else {
                let mut roots = Vec::new();
                for (_, source) in db.iter() {
                    if let Some(root) = std::path::Path::new(&source.path).parent() {
                        let root = if root.as_os_str().is_empty() {
                            std::path::PathBuf::from(".")
                        } else {
                            root.to_path_buf()
                        };
                        if !roots.contains(&root) {
                            roots.push(root);
                        }
                    }
                }
                Some(crate::analysis::generation_store::FrozenGeneration::capture(&roots).and_then(|snapshot| {
                if db.iter().any(|(_, source)| snapshot.source(std::path::Path::new(&source.path)) != Some(source.text.as_str())) {
                    Err("checked source changed before saved-code capture; retry the build".into())
                } else { Ok(snapshot) }
            }))
            }
        } else {
            None
        }
    }

    fn claim_staged_unit(
        join: &mut ThenBuildJoin,
        staged_keys: &mut HashMap<String, crate::analysis::generation_intake::AssociationKey>,
        key: &crate::analysis::generation_intake::AssociationKey,
        unit_id: &str,
        span: Span,
        what: &str,
    ) -> bool {
        if let Some(first) = staged_keys.get(unit_id) {
            if first != key {
                join.missing.push((
                    span,
                    format!(
                        "cannot lower {what}: saved unit `{unit_id}` is already staged for another definition; reconcile the association with an explicit bind (action: bind)",
                    ),
                ));
                return false;
            }
            return true;
        }
        staged_keys.insert(unit_id.to_string(), key.clone());
        true
    }

    fn resolve_saved_unit(
        join: &mut ThenBuildJoin,
        snapshot: Option<&crate::analysis::generation_store::FrozenGeneration>,
        standalone: &Option<
            Result<crate::analysis::generation_store::FrozenGeneration, String>,
        >,
        db: &crate::source::SourceDb,
        key: &crate::analysis::generation_intake::AssociationKey,
        span: Span,
        what: &str,
    ) -> Option<(String, crate::analysis::generation_intake::SavedGroup)> {
        match snapshot {
            Some(snapshot) => match snapshot.resolve(db, key, span) {
                Ok(Some(group)) => Some(group),
                Ok(None) => {
                    join.missing.push((span, format!("cannot lower {what}: no saved unit is bound to {}; prepare the unit (action: generate)", key.describe())));
                    None
                }
                Err(detail) => {
                    join.missing.push((
                        span,
                        format!("cannot lower {what}: {detail} (action: bind)"),
                    ));
                    None
                }
            },
            None => {
                let detail = standalone
                    .as_ref()
                    .and_then(|value| value.as_ref().err())
                    .map(String::as_str)
                    .unwrap_or("saved input snapshot unavailable");
                join.missing
                    .push((span, format!("cannot lower {what}: {detail}")));
                None
            }
        }
    }
    /// Renderer plan for one `show` use span, if it resolves to a
    /// prompted view with a usable saved unit.
    pub(crate) fn show_at(&self, span: &Span) -> Option<&ResolvedShow> {
        self.shows.get(span)
    }

    pub(crate) fn style_at(&self, span: &Span) -> Option<&String> {
        self.style_hosts.get(span)
    }

    /// Checked emitted view uses, for derived artifact consumers.
    pub(crate) fn resolved_shows(&self) -> impl Iterator<Item = &ResolvedShow> {
        self.shows.values()
    }

    /// Consumed view units (saved groups by unit id).
    pub(crate) fn views(&self) -> &HashMap<String, crate::analysis::generation_intake::SavedGroup> {
        &self.views
    }

    /// Consumed style units (saved groups by unit id).
    pub(crate) fn styles(
        &self,
    ) -> &HashMap<String, crate::analysis::generation_intake::SavedGroup> {
        &self.styles
    }

    /// Coverage failures: `(span, detail)` pairs the driver reports.
    pub(crate) fn missing(&self) -> &[(Span, String)] {
        &self.missing
    }

    /// Resolve saved Then inputs over every database source: reparse,
    /// lower prompted views, walk use edges, and bind consumed units
    /// to their current saved groups. Consumed means emitted: uses
    /// strictly inside an unconsumed (unshown) view's span resolve
    /// nothing, and unresolvable sites stay absent so emission keeps
    /// its ordinary inline shape.
    fn resolve_view_root_style(
        join: &mut ThenBuildJoin,
        staged_keys: &mut HashMap<String, crate::analysis::generation_intake::AssociationKey>,
        snapshot: Option<&crate::analysis::generation_store::FrozenGeneration>,
        standalone: &Option<Result<crate::analysis::generation_store::FrozenGeneration, String>>,
        db: &crate::source::SourceDb,
        file: &FileThen,
        edge: &super::then_views::UseEdge,
        view: &super::then_views::ThenView,
        what: &str,
    ) -> Option<String> {
        let mut root_style: Option<String> = None;
        if let Some(declared) = view.root_style.as_ref() {
            if let Some(name) = declared.named.as_deref() {
                let style_key = crate::analysis::generation_intake::AssociationKey {
                    owner: edge.owner.clone(),
                    kind: crate::analysis::generation_intake::UnitKind::Style,
                    label: Some(name.to_string()),
                    anchor: format!("{}:style:{name}:", edge.owner),
                };
                if let Some((style_id, style_group)) =
                    Self::resolve_saved_unit(join, snapshot, &standalone, db, &style_key, edge.use_span, &what)
                    && Self::claim_staged_unit(
                        join,
                        staged_keys,
                        &style_key,
                        &style_id,
                        edge.use_span,
                        &what,
                    )
                {
                    join.styles.insert(style_id.clone(), style_group);
                    root_style = Some(style_id);
                }
            } else if declared.inline_prompt.is_some() {
                let style_key = crate::analysis::generation_intake::AssociationKey {
                    owner: edge.owner.clone(),
                    kind: crate::analysis::generation_intake::UnitKind::ViewStyleInline,
                    label: Some(view.name.clone()),
                    anchor: format!(
                        "{}:view-style-inline:{}:{}",
                        edge.owner, view.name, view.name
                    ),
                };
                if let Some((style_id, style_group)) =
                    Self::resolve_saved_unit(join, snapshot, &standalone, db, &style_key, edge.use_span, &what)
                    && Self::claim_staged_unit(
                        join,
                        staged_keys,
                        &style_key,
                        &style_id,
                        edge.use_span,
                        &what,
                    )
                {
                    join.styles.insert(style_id.clone(), style_group);
                    root_style = Some(style_id);
                }
            }
        }
        if root_style.is_none() {
            root_style = file
                .descriptors
                .iter()
                .filter(|d| {
                    matches!(
                        d.kind,
                        crate::analysis::generation::GenerationKind::StyleNamedUse | crate::analysis::generation::GenerationKind::StyleInline
                    ) && d.span.file == edge.use_span.file
                        && d.span.start >= edge.use_span.start
                        && d.span.end <= edge.use_span.end
                })
                .find_map(|d| {
                    let kind = crate::analysis::generation_intake::UnitKind::of_descriptor(d.kind)?;
                    let style_key = crate::analysis::generation_intake::AssociationKey {
                        owner: d.owner.clone(),
                        kind,
                        label: d.label.clone(),
                        anchor: d.anchor.clone(),
                    };
                    let (style_id, style_group) =
                        Self::resolve_saved_unit(join, snapshot, &standalone, db, &style_key, edge.use_span, &what)?;
                    if !Self::claim_staged_unit(
                        join,
                        staged_keys,
                        &style_key,
                        &style_id,
                        edge.use_span,
                        &what,
                    ) {
                        return None;
                    }
                    join.styles.insert(style_id.clone(), style_group);
                    Some(style_id)
                });
        }
        root_style
    }

    fn resolve_view_edge(
        join: &mut ThenBuildJoin,
        staged_keys: &mut HashMap<String, crate::analysis::generation_intake::AssociationKey>,
        snapshot: Option<&crate::analysis::generation_store::FrozenGeneration>,
        standalone: &Option<Result<crate::analysis::generation_store::FrozenGeneration, String>>,
        db: &crate::source::SourceDb,
        consumed_views: &std::collections::HashSet<(String, String)>,
        file: &FileThen,
        edge: &super::then_views::UseEdge,
    ) -> Option<()> {
        if edge.definition_kind != crate::analysis::generation::GenerationKind::ViewDefinition
            || Self::inside_unconsumed_view(&consumed_views, file, &edge.use_span)
        {
            return None;
        }
        let what = format!("view `{}`", edge.definition_label);
        let Some(view) = file
            .views
            .iter()
            .find(|v| v.anchor == edge.definition_anchor)
        else {
            join.missing.push((
                edge.use_span,
                format!(
                    "cannot lower {what}: the prompted view does not lower from the current source; fix the view or reconcile with adopt"
                ),
            ));
            return None;
        };
        let key = crate::analysis::generation_intake::AssociationKey {
            owner: edge.owner.clone(),
            kind: crate::analysis::generation_intake::UnitKind::View,
            label: Some(edge.definition_label.clone()),
            anchor: edge.definition_anchor.clone(),
        };
        let Some((unit_id, group)) = Self::resolve_saved_unit(join, snapshot, &standalone, db, &key, edge.use_span, &what)
        else {
            return None;
        };
        // Adopted legacy views carry the handwritten renderer as
        // `server.js` instead of the v1 `implementation.js` module
        // name; either module satisfies the renderer requirement.
        let has_module = group
            .files
            .iter()
            .find(|f| f.rel_path == "implementation.js")
            .is_some_and(|f| String::from_utf8(f.bytes.clone()).is_ok())
            || (group.record.provenance.origin == crate::analysis::generation_intake::ProvenanceOrigin::Adopted
                && group
                    .files
                    .iter()
                    .find(|f| f.rel_path == "server.js")
                    .is_some_and(|f| String::from_utf8(f.bytes.clone()).is_ok()));
        if !has_module {
            join.missing.push((
                edge.use_span,
                format!(
                    "cannot lower {what}: unit `{unit_id}` `implementation.js` is missing or not valid UTF-8; repair the file or reconcile with adopt"
                ),
            ));
            return None;
        }
        if !Self::claim_staged_unit(
            join,
            staged_keys,
            &key,
            &unit_id,
            edge.use_span,
            &what,
        ) {
            return None;
        }
        let mut root_style = Self::resolve_view_root_style(
            join,
            staged_keys,
            snapshot,
            &standalone,
            db,
            file,
            edge,
            view,
            &what,
        );
        if root_style.is_none() && group.files.iter().any(|f| f.rel_path == "style.css") {
            root_style = Some(unit_id.clone());
        }
        let renderer_style = group
            .files
            .iter()
            .any(|file| file.rel_path == "style.css")
            .then(|| unit_id.clone());
        join.views.insert(unit_id.clone(), group);
        join.shows.insert(
            edge.use_span,
            ResolvedShow {
                view_name: view.name.clone(),
                row_model: format!("{}.{}", edge.owner, view.row_model),
                unit_id,
                controls: view.controls.clone(),
                binding_names: view.binding_names.clone(),
                root_style,
                renderer_style,
            },
        );
        Some(())
    }

    fn pack_style_definitions(
        join: &mut ThenBuildJoin,
        staged_keys: &mut HashMap<String, crate::analysis::generation_intake::AssociationKey>,
        snapshot: Option<&crate::analysis::generation_store::FrozenGeneration>,
        standalone: &Option<Result<crate::analysis::generation_store::FrozenGeneration, String>>,
        db: &crate::source::SourceDb,
        consumed_views: &std::collections::HashSet<(String, String)>,
        files: &[FileThen],
        file: &FileThen,
        descriptor: &crate::analysis::generation::GenerationDescriptor,
    ) -> Option<()> {
        if descriptor.kind != crate::analysis::generation::GenerationKind::StyleDefinition {
            return None;
        }
        let used = files.iter().any(|other| {
            other.edges.iter().any(|edge| {
                matches!(edge.definition_kind, crate::analysis::generation::GenerationKind::StyleDefinition)
                    && edge.definition_anchor == descriptor.anchor
                    && !Self::inside_unconsumed_view(&consumed_views, other, &edge.use_span)
            })
        });
        if !used {
            return None;
        }
        let what = format!(
            "style `{}`",
            descriptor.label.as_deref().unwrap_or_default()
        );
        let key = crate::analysis::generation_intake::AssociationKey {
            owner: descriptor.owner.clone(),
            kind: crate::analysis::generation_intake::UnitKind::Style,
            label: descriptor.label.clone(),
            anchor: descriptor.anchor.clone(),
        };
        let Some((unit_id, group)) = Self::resolve_saved_unit(join, snapshot, &standalone, db, &key, descriptor.span, &what)
        else {
            return None;
        };
        if !Self::claim_staged_unit(
            join,
            staged_keys,
            &key,
            &unit_id,
            descriptor.span,
            &what,
        ) {
            return None;
        }
        join.styles.insert(unit_id, group);
        Some(())
    }

    fn pack_inline_styles(
        join: &mut ThenBuildJoin,
        staged_keys: &mut HashMap<String, crate::analysis::generation_intake::AssociationKey>,
        snapshot: Option<&crate::analysis::generation_store::FrozenGeneration>,
        standalone: &Option<Result<crate::analysis::generation_store::FrozenGeneration, String>>,
        db: &crate::source::SourceDb,
        consumed_views: &std::collections::HashSet<(String, String)>,
        files: &[FileThen],
        file: &FileThen,
        descriptor: &crate::analysis::generation::GenerationDescriptor,
    ) -> Option<()> {
        let consumed = match descriptor.kind {
            crate::analysis::generation::GenerationKind::StyleInline => !Self::inside_unconsumed_view(&consumed_views, file, &descriptor.span),
            crate::analysis::generation::GenerationKind::ViewRootStyleInline => {
                let view = descriptor.label.as_deref().unwrap_or_default();
                consumed_views.contains(&(descriptor.owner.clone(), view.to_string()))
            }
            _ => return None,
        };
        if !consumed {
            return None;
        }
        let what = match descriptor.kind {
            crate::analysis::generation::GenerationKind::ViewRootStyleInline => format!(
                "inline root style of view `{}`",
                descriptor.label.as_deref().unwrap_or_default()
            ),
            _ => "inline style".to_string(),
        };
        let Some(kind) = crate::analysis::generation_intake::UnitKind::of_descriptor(descriptor.kind) else {
            return None;
        };
        let key = crate::analysis::generation_intake::AssociationKey {
            owner: descriptor.owner.clone(),
            kind,
            label: descriptor.label.clone(),
            anchor: descriptor.anchor.clone(),
        };
        let Some((unit_id, group)) = Self::resolve_saved_unit(join, snapshot, &standalone, db, &key, descriptor.span, &what)
        else {
            return None;
        };
        if !Self::claim_staged_unit(
            join,
            staged_keys,
            &key,
            &unit_id,
            descriptor.span,
            &what,
        ) {
            return None;
        }
        join.styles.insert(unit_id, group);
        Some(())
    }

    fn bind_style_hosts(
        join: &mut ThenBuildJoin,
        consumed_views: &std::collections::HashSet<(String, String)>,
        files: &[FileThen],
        snapshot: Option<&crate::analysis::generation_store::FrozenGeneration>,
        db: &crate::source::SourceDb,
        file: &FileThen,
        suffix_span: &crate::source::Span,
        host_span: &crate::source::Span,
    ) -> Option<()> {
        if Self::inside_unconsumed_view(&consumed_views, file, suffix_span) {
            return None;
        }
        let Some(descriptor) = file.descriptors.iter().find(|d| d.span == *suffix_span)
        else {
            return None;
        };
        let (kind, label, anchor) = match descriptor.kind {
            crate::analysis::generation::GenerationKind::StyleNamedUse => {
                let name = descriptor.label.clone().unwrap_or_default();
                (
                    crate::analysis::generation_intake::UnitKind::Style,
                    Some(name.clone()),
                    format!("{}:style:{name}:", descriptor.owner),
                )
            }
            crate::analysis::generation::GenerationKind::StyleInline => (
                crate::analysis::generation_intake::UnitKind::StyleInline,
                descriptor.label.clone(),
                descriptor.anchor.clone(),
            ),
            _ => return None,
        };
        let key = crate::analysis::generation_intake::AssociationKey {
            owner: descriptor.owner.clone(),
            kind,
            label,
            anchor,
        };
        if let Some(snapshot) = snapshot {
            if let Ok(Some((id, _))) = snapshot.resolve(db, &key, descriptor.span) {
                if join.styles.contains_key(&id) {
                    join.style_hosts.insert(*host_span, id);
                }
            }
        } else if let Some((id, _)) = join
            .styles
            .iter()
            .find(|(_, group)| crate::analysis::generation_intake::AssociationKey::of(&group.record.source) == key)
        {
            join.style_hosts.insert(*host_span, id.clone());
        }
        Some(())
    }

    pub(crate) fn resolve(db: &crate::source::SourceDb) -> Self {
        use crate::analysis::generation::{GenerationKind, discover_generation};
        use crate::analysis::generation_intake as intake;
        let files = Self::collect_then_files(db);
        // A view is consumed when some `show` names it (prompted views
        // through their checked edges, unprompted ones through raw
        // references); anything strictly inside an unconsumed view's
        // span emits nothing and consumes nothing.
        let consumed_views = Self::collect_consumed_views(&files);
        let standalone = Self::capture_standalone_snapshot(db, &files);
        let snapshot = db
            .generation
            .as_deref()
            .or_else(|| standalone.as_ref().and_then(|value| value.as_ref().ok()));
        let mut join = ThenBuildJoin::default();
        // Staged identities stay unambiguous: one unit id serves one
        // association key, or the build refuses the skewed staging.
        let mut staged_keys: HashMap<String, intake::AssociationKey> = HashMap::new();
        // Prompted `show` sites resolve to renderer plans.
        for file in &files {
            for edge in &file.edges {
                let _ = Self::resolve_view_edge(
                    &mut join,
                    &mut staged_keys,
                    snapshot,
                    &standalone,
                    db,
                    &consumed_views,
                    file,
                    edge,
                );
            }
        }
        // Consumed style definitions pack their CSS: a definition with
        // at least one emitted named use.
        for file in &files {
            for descriptor in &file.descriptors {
                let _ = Self::pack_style_definitions(&mut join, &mut staged_keys, snapshot, &standalone, db, &consumed_views, &files, file, descriptor);
            }
        }
        // Inline attachments consume their own unit wherever their host
        // emits; definition-owned inline root styles follow their view.
        for file in &files {
            for descriptor in &file.descriptors {
                let _ = Self::pack_inline_styles(&mut join, &mut staged_keys, snapshot, &standalone, db, &consumed_views, &files, file, descriptor);
            }
        }
        // Bind ordinary style attachments to their exact owning CST host.
        // Existing saved intake above is the only source of style unit IDs.
        for file in &files {
            for (suffix_span, host_span) in &file.style_hosts {
                let _ = Self::bind_style_hosts(&mut join, &consumed_views, &files, snapshot, db, file, suffix_span, host_span);
            }
        }
        join
    }
}

fn emit_program_with_sources(
    ir: &IrProgram,
    native_receipts: bool,
    db: Option<&crate::source::SourceDb>,
    queries: Option<&std::collections::BTreeMap<String, serde_json::Value>>,
    query_receipts: Option<
        &std::collections::BTreeMap<String, super::scenario_receipts::NativeScenarioReceipt>,
    >,
    decisions: EmitDecisionSources<'_>,
    feasibility: Option<&super::scenario_feasibility::PreparedRequireReturns<'_>>,
) -> JsOutput {
    let mut emitter = Emitter::new(ir);
    // Saved Then inputs resolve from the database sources: prompted
    // `show` sites emit saved-renderer calls, and the compile driver
    // reuses the same resolution for coverage and packing.
    if let Some(db) = db {
        let join = ThenBuildJoin::resolve(db);
        for (span, detail) in join.missing() {
            emitter.unsupported("saved generation", detail, *span);
        }
        emitter.then_join = Some(join);
        // Multi-source closures need per-declaration provenance: the module
        // source map cannot resolve one exact declaring file for them.
        if db.len() > 1 {
            emitter.source_paths = db.iter().map(|(id, source)| (id, source.path.clone())).collect();
        }
    }
    for original in ir.committed_sources.mailbox_event_handlers() {
        let index = original.id.0 as usize;
        if ir.items.get(index).is_none_or(|handler| {
            decisions
                .mailbox_events
                .is_none_or(|prepared| !prepared.matches(ir, index, handler))
        }) {
            emitter.unsupported("MailboxV1.received source",
                "original bound trigger, complete payload and fresh private handler correspondence unavailable",original.span);
        }
    }
    for (index, handler) in ir.items.iter().enumerate() {
        if !ir.committed_sources.requires_mailbox_event(index)
            && matches!(
                &handler.kind,
                IrItemKind::Scenario {
                    event_source: Some(IrEventSource::MailboxReceived { .. }),
                    ..
                }
            )
        {
            emitter.unsupported(
                "MailboxV1.received source",
                "missing original checked source claim",
                handler.span,
            );
        }
    }
    if ir.standard_completion_sources.is_private_terminal_candidate() {
        let ready = !ir.standard_completion_sources.handlers.is_empty()
            && ir.standard_completion_sources.handlers.iter().all(|original| {
                let index = original.id.0 as usize;
                ir.items.get(index).is_some_and(|handler| decisions.standard_terminal_events
                    .is_some_and(|prepared| prepared.matches(ir, index, handler)))
            });
        emitter.private_terminal_ready = ready;
        if !ready {
            let span = ir.standard_completion_sources.handlers.first().map(|handler|handler.span)
                .or_else(||ir.items.first().map(|item|item.span))
                .unwrap_or(Span::new(crate::source::SourceId(0),0,0));
            emitter.unsupported("standard terminal source",
                "candidate needs its complete original source and independently prepared handler closure",span);
        }
    }
    for original in ir.committed_sources.payments_changed_event_handlers() {
        let index = original.id.0 as usize;
        if ir.items.get(index).is_none_or(|handler| {
            decisions
                .payments_changed_events
                .is_none_or(|prepared| !prepared.matches(ir, index, handler))
        }) {
            emitter.unsupported("PaymentsV1.changed source",
                "original bound trigger, complete payload and fresh private handler correspondence unavailable",original.span);
        }
    }
    for (index, handler) in ir.items.iter().enumerate() {
        if !ir.committed_sources.requires_payments_changed_event(index)
            && matches!(
                &handler.kind,
                IrItemKind::Scenario {
                    event_source: Some(IrEventSource::PaymentsChanged { .. }),
                    ..
                }
            )
        {
            emitter.unsupported(
                "PaymentsV1.changed source",
                "missing original checked source claim",
                handler.span,
            );
        }
    }
    for handler in &ir.items {
        if matches!(
            &handler.kind,
            IrItemKind::Scenario {
                event_source: Some(IrEventSource::TeamsMemberRemoved),
                ..
            }
        ) && db.is_none_or(|db| {
            !ir.committed_sources
                .teams_member_removed_matches(ir, handler, db)
        }) {
            emitter.unsupported(
                "teams.member_removed source",
                "original checked trigger, owner or payload type correspondence unavailable",
                handler.span,
            );
        }
    }
    emitter.native_source_predicates = native_receipts;
    emitter.authority_queries = decisions.authority_queries;
    emitter.owner_handlers = decisions.owner_handlers.cloned().unwrap_or_default();
    emitter.private_derives = decisions.private_derives.cloned().unwrap_or_default();
    if emitter.private_terminal_ready {
        for (index, item) in ir.items.iter().enumerate() {
            if decisions.standard_terminal_events.is_some_and(|prepared|prepared.matches(ir,index,item)) {
                emitter.owner_handlers.insert(item.id);
            }
        }
    }

    emitter.unique_conditions = decisions.unique_conditions.unwrap_or_default().to_vec();
    emitter.model_rule_origins = decisions.model_rule_origins.map(|origins| origins.to_vec());
    emitter.query_selections = decisions.query_selections;
    emitter.query_any = decisions.query_any;
    emitter.send_guard_gap = decisions.send_guard_gap;
    if let Some(membership) = decisions.membership {
        emitter.membership_calls = membership.calls(ir).cloned().unwrap_or_default();
        emitter.membership_sites = Some(&membership.sites);
        emitter.membership_predicates = membership.predicates(ir).cloned().unwrap_or_default();
    }
    if native_receipts {
        emitter.membership_predicates = decisions
            .read_predicates
            .and_then(|source| source.predicates(ir))
            .cloned()
            .unwrap_or_default();
    }
    if native_receipts {
        emitter.source_requires = decisions.read_predicates
            .and_then(|source| source.source_requires(ir)).cloned().unwrap_or_default();
        emitter.boolean_sources = decisions
            .read_predicates
            .and_then(|source| source.booleans(ir))
            .cloned()
            .unwrap_or_default();
        emitter.boolean_derives = decisions
            .read_predicates
            .and_then(|source| source.boolean_derives(ir))
            .cloned()
            .unwrap_or_default();
        emitter.boolean_rules = decisions
            .read_predicates
            .and_then(|source| source.boolean_rules(ir))
            .cloned()
            .unwrap_or_default();
    }
    if native_receipts && let Some(guards) = decisions.send_guards {
        emitter.send_guards = guards.guards(ir);
        emitter.send_guard_owners = guards.by_owner(ir);
    }
    if let Some(db) = db {
        if ir.committed_sources.has_standard_value_inventory_fact() {
            emitter.value_types = emitter.collect_standard_value_inventory(db);
        } else if ir.committed_sources.requires_standard_value_inventory(ir) {
            emitter.value_types = None;
            let span = ir
                .modules
                .first()
                .map_or(Span::new(crate::source::SourceId(0), 0, 0), |module| {
                    module.span
                });
            emitter.unsupported(
                "standard value inventory",
                "selected owning declarations have no original checked source census",
                span,
            );
        }
    }
    if ir.committed_sources.has_empty_value_inventory_fact() {
        // An edited nonempty collector cannot override the sealed absence
        // evidence. Raw emission has no source-backed inventory claim.
        emitter.value_types = None;
        if let Some(db) = db {
            if ir
                .committed_sources
                .has_complete_empty_value_inventory(ir, db)
            {
                emitter.value_types = Some(JsValueTypes::default());
            } else {
                let span = ir
                    .modules
                    .first()
                    .map_or(Span::new(crate::source::SourceId(0), 0, 0), |module| {
                        module.span
                    });
                emitter.diags.push(Diagnostic::error(
                    "E6008",
                    "complete empty value inventory no longer matches its checked source cohort or declaration census".to_string(),
                    span,
                ));
            }
        }
    }
    emitter.committed_changes = emitter.collect_committed_changes(db);
    emitter.standard_completions = emitter.collect_standard_completions(db);
    emitter.validate_model_field_bounds();
    let entry_id = pick_entrypoint(ir);
    let entry_name = entry_id
        .map(|id| ir.module(id).name.clone())
        .unwrap_or_else(|| "index".to_string());
    let entry_span = entry_id.map(|id| ir.module(id).span).unwrap_or(Span::new(
        crate::source::SourceId(0),
        0,
        0,
    ));
    let local_policies = decisions
        .local_policies
        .cloned()
        .or_else(|| collect_local_policies(ir, &module_path(&entry_name)));
    if let Some(queries) = queries {
        for item in &ir.items {
            let Some(plan) = queries.get(&item.canonical) else {
                continue;
            };
            let Some(source) = ir
                .scenario_disclosures
                .get(&item.id)
                .and_then(|fact| fact.source_facts())
            else {
                continue;
            };
            let Some(checked_queries) = source
                .queries
                .as_ref()
                .filter(|queries| {
                    queries.len() <= 3
                        || super::scenario_receipts::checked_scenario_query_influences(source)
                            .is_some_and(|influences| influences.len() == 24)
                })
                .cloned()
            else {
                continue;
            };
            let transcripts = source.transcripts.clone().unwrap_or_default();
            let inline_selections = source.inline_selections.clone().unwrap_or_default();
            if checked_queries.is_empty() && transcripts.is_empty() {
                continue;
            }
            let Some(return_id) = plan["returns"][0]["id"].as_str() else {
                continue;
            };
            emitter.native_query_sources.insert(
                item.id,
                NativeQuerySource {
                    owner: item.canonical.clone(),
                    queries: checked_queries,
                    transcripts,
                    inline_selections,
                    return_id: return_id.into(),
                    plan: plan.clone(),
                },
            );
        }
    }
    if native_receipts {
        let models = emitter.collect_models();
        for (index, item) in ir.items.iter().enumerate() {
            if let Some(recipe) =
                super::scenario_receipts::collect_native_scenario_receipt_with_feasibility(
                    ir,
                    item,
                    &models,
                    &module_path(&entry_name),
                    emitter.value_types.as_ref(),
                    super::scenario_receipts::NativeReceiptSources {
                        source_context: decisions.source_context,
                        db,
                        send_guards: emitter.send_guards,
                        query_plan: query_receipts
                            .and_then(|recipes| recipes.get(&item.canonical))
                            .map(|recipe| &recipe.plan)
                            .or_else(|| decisions.transcript_queries?.get(&item.canonical)),
                    },
                    feasibility,
                )
            {
                if ir.scenario_disclosures.get(&item.id)
                    .and_then(|value| value.source_facts())
                    .and_then(|facts| facts.queries.as_ref())
                    .is_some_and(|queries| queries.iter().any(|query| query.first.as_ref()
                        .is_some_and(|first| first.target_decision_shape && !first.target_consumed)))
                {
                    emitter.unsupported("first decision target",
                        "selected first row has an unproved decision, write target or value sink", item.span);
                    continue;
                }
                let requires = ir.scenario_disclosures.get(&item.id)
                    .and_then(|value| value.source_facts())
                    .and_then(|facts| facts.source_requires.as_deref())
                    .unwrap_or(&[]);
                if requires.iter().any(|site| {
                    !emitter.source_requires.contains_key(&Span::new(
                        site.node.file,
                        site.node.start,
                        site.node.end,
                    ))
                }) {
                    emitter.unsupported(
                        "scenario source requirement",
                        "original source observer correspondence is unavailable",
                        item.span,
                    );
                    continue;
                }
                if item.canonical == "member_terms.term"
                    && recipe.plan.term_decision.is_some()
                    && decisions.source_context.is_some_and(|context|
                        super::term_decisions::latest_capture_private_only(context,item))
                {
                    emitter.private_term_helper_only = true;
                }
                if let Some(inputs) = decisions.source_context.and_then(|context|
                    super::scenario_receipts::constructor_inputs(context,item,&recipe.plan.source)) {
                    emitter.constructor_inputs.insert(item.id,inputs);
                }
                if let Some(counts)=decisions.source_context.and_then(|context|super::scenario_receipts::constructor_counts(context,item,&recipe.plan.source)) {
                    emitter.constructor_counts.insert(item.id,counts);
                }
                emitter.native_receipts.insert(item.id, recipe);
            } else if ir.scenario_disclosures.get(&item.id)
                .and_then(|value| value.source_facts())
                .and_then(|facts| facts.queries.as_ref())
                .is_some_and(|queries| queries.iter().any(|query| query.first.as_ref()
                    .is_some_and(|first| first.target_decision_shape && !first.target_consumed)))
            {
                emitter.unsupported("first decision target",
                    "selected first row has an unproved decision, write target or value sink", item.span);
            } else if ir.scenario_disclosures.get(&item.id)
                .and_then(|value| value.source_facts())
                .is_some_and(|facts| facts.unproved_helper_contained_requires)
            {
                emitter.unsupported("scenario source requirement",
                    "helper collection in Require lacks exact owner-domain correspondence", item.span);
            } else if super::scenario_receipts::has_original_transcript_source(
                ir,
                SymbolId(index as u32),
            ) {
                emitter.diags.push(Diagnostic::error(
                    "E6008",
                    "transcript needs released native query and stored-message correspondence"
                        .into(),
                    item.span,
                ));
            } else if let Some(recipe) = decisions.source_context.zip(decisions.send_guards)
                .and_then(|(context,guards)|super::send_guards::retained_handler_receipt(
                    context,guards,item,&module_path(&entry_name))) {
                emitter.native_receipts.insert(item.id,recipe);
            } else if super::scenario_receipts::has_original_guarded_send(
                ir,
                SymbolId(index as u32),
            ) {
                if item.canonical == "maintain.remind"
                    || !missing_source_checked_send_rule(ir, item, emitter.send_guards) {
                    emitter.diags.push(Diagnostic::error(
                        "E6008",
                        "send dispatch guard needs exact original native receipt and sealed Rule correspondence".into(),
                        item.span,
                    ));
                }
            } else if super::scenario_receipts::has_original_images_source(
                ir,
                SymbolId(index as u32),
            ) {
                emitter.diags.push(Diagnostic::error(
                    "E6008",
                    "images request needs exact original native source correspondence".into(),
                    item.span,
                ));
            } else if super::scenario_receipts::has_original_created_model_result(
                ir,
                SymbolId(index as u32),
            ) {
                emitter.diags.push(Diagnostic::error(
                    "E6008",
                    "created model result needs exact original native source correspondence".into(),
                    item.span,
                ));
            }
        }
        if let Some(query_receipts) = query_receipts {
            for (index, item) in ir.items.iter().enumerate() {
                if super::scenario_receipts::has_original_transcript_source(
                    ir,
                    SymbolId(index as u32),
                ) {
                    continue;
                }
                if let Some(recipe) = query_receipts.get(&item.canonical)
                    && ir
                        .scenario_disclosures
                        .get(&item.id)
                        .and_then(|fact| fact.source_facts())
                        .and_then(|source| source.queries.as_ref())
                        .is_some_and(|queries| {
                            queries
                                .iter()
                                .all(|query| query.first.is_none() && query.count.is_none())
                        })
                {
                    if emitter
                        .query_any
                        .and_then(|owners| owners.get(&item.canonical))
                        .and_then(serde_json::Value::as_array)
                        .is_some_and(|queries| {
                            queries.iter().any(|query| query["kind"] == "predicate")
                        })
                    {
                        // Helper query preparation proves its plan, but its empty
                        // effect/call maps must never replace the complete owner
                        // recipe that captures the actual derive invocation.
                        if !emitter.native_receipts.contains_key(&item.id) {
                            emitter.unsupported(
                                "helper ANY",
                                "complete owning effect and derive-call receipt is unavailable",
                                item.span,
                            );
                        }
                        continue;
                    }
                    emitter.native_receipts.insert(item.id, recipe.clone());
                    emitter.prepared_query_receipts.insert(item.id);
                }
            }
        }
        for item in &ir.items {
            if !emitter.native_receipts.contains_key(&item.id) {
                continue;
            }
            let Some(crate::analysis::scenario_disclosure::ScenarioDisclosure::Complete(checked)) =
                ir.scenario_disclosures.get(&item.id)
            else {
                continue;
            };
            if checked.require_consumptions.is_empty() {
                continue;
            }
            let captures = db.zip(feasibility).and_then(|(db, prepared)| {
                super::scenario_receipts::checked_require_consumptions(ir, item, db, prepared)
            });
            let Some(captures) = captures else {
                emitter.native_receipts.remove(&item.id);
                emitter.unsupported(
                    "Require field consumption",
                    "exact original Require, selected field and first-query correspondence is unavailable",
                    item.span,
                );
                continue;
            };
            let recipe = emitter
                .native_receipts
                .get_mut(&item.id)
                .expect("owning receipt");
            let mut associations = Vec::new();
            for capture in captures {
                let site_entries = recipe.dependencies.entry(capture.site).or_default();
                // DESIGN442 (0411): a decision read already observed through
                // its result dependency must not emit a second identical
                // observation (State once-only execution would refuse the
                // duplicate). The execution association below still records
                // the bound Require consumption for the owner grant.
                if !site_entries
                    .iter()
                    .any(|existing| existing.id == capture.observation.id)
                {
                    site_entries.push(capture.observation);
                }
                associations.push(capture.association);
            }
            if !associations.is_empty() {
                emitter
                    .execution_dependencies
                    .insert(item.canonical.clone(), associations);
            }
        }
    }
    let mut body = JsWriter::new();
    if native_receipts
        && emitter.query_any.is_some_and(|owners| {
            owners.values().any(|metadata| {
                metadata
                    .as_array()
                    .is_some_and(|queries| queries.iter().any(|query| query["kind"] == "predicate"))
            })
        })
    {
        body.push(entry_span, Some("canScenarioQueryPredicateSource".into()),
            "const $can$query$predicates=new WeakMap();function $can$query$issue(marker,context,predicate){$can$query$predicates.set(predicate,{marker,context});return predicate;}export function canScenarioQueryPredicateSource(predicate){const issued=$can$query$predicates.get(predicate);return issued===undefined?null:{marker:JSON.parse(issued.marker),context:issued.context};}");
    }
    if native_receipts && let Some(context)=decisions.source_context {
        for owner in &ir.items {
            if emitter.native_receipts.contains_key(&owner.id) {continue;}
            if let Some(loops)=super::source_loops::collect(ir,owner,context,&emitter.source_requires,&module_path(&entry_name)){emitter.source_body_loops.insert(owner.canonical.clone(),loops);}
            if let Some(loans)=super::source_let_data::collect(ir,owner,context,&emitter.source_requires,&module_path(&entry_name)){emitter.source_let_data.extend(loans);}
            if let Some(sends)=source_only_data_sends(ir,owner,context,&emitter.source_requires,&emitter.source_let_data,&module_path(&entry_name),emitter.source_body_loops.get(&owner.canonical)) {
                emitter.source_data_sends.extend(sends);
            }
            if let Some(emits)=source_only_data_emits(ir,owner,context,&emitter.source_requires,&module_path(&entry_name)){emitter.source_data_emits.extend(emits);}
            if let Some(cancels)=source_only_cancels(ir,owner,context,&emitter.source_requires,&module_path(&entry_name)) {
                emitter.source_cancels.extend(cancels);
            }
            if let Some(schedules)=source_only_schedules(ir,owner,context,&emitter.source_requires,&module_path(&entry_name)){emitter.source_schedules.extend(schedules);}
        }
    }
    if !emitter.source_body_loops.is_empty(){
        let inventory:BTreeMap<_,_>=emitter.source_body_loops.iter().collect();
        let payload=descriptor_json(&descriptor_json(&inventory));
        body.push(entry_span,Some("canScenarioBodyLoopSources".into()),&format!("export function canScenarioBodyLoopSources(){{return JSON.parse({payload});}}"));
    }
    if native_receipts && (!emitter.source_body_loops.is_empty() || emitter.native_receipts.values().any(|receipt|receipt.plan.source_loops.is_some())) {
        body.push(entry_span,Some("canScenarioSourceLoopSource".into()),
            "const $can$loop$sources=new WeakMap();function $can$loop$issue(source,context,predicate){$can$loop$sources.set(predicate,{source,context});return predicate;}export function canScenarioSourceLoopSource(predicate){const issued=$can$loop$sources.get(predicate);return issued===undefined?null:{source:JSON.parse(issued.source),context:issued.context};}");
    }
    if !emitter.source_let_data.is_empty(){
        let mut inventory:BTreeMap<String,Vec<serde_json::Value>>=BTreeMap::new();
        for source in emitter.source_let_data.values(){inventory.entry(source["owner"].as_str().expect("checked LET owner").to_owned()).or_default().push(source.clone());}
        for sources in inventory.values_mut(){sources.sort_by_key(|source|source.to_string());}
        let payload=descriptor_json(&descriptor_json(&inventory));
        body.push(entry_span,Some("canScenarioLetDataSources".into()),&format!("export function canScenarioLetDataSources(){{return JSON.parse({payload});}}"));
    }
    if !emitter.source_schedules.is_empty(){
        let mut inventory:BTreeMap<String,Vec<serde_json::Value>>=BTreeMap::new();
        for source in emitter.source_schedules.values(){inventory.entry(source["owner"].as_str().expect("checked schedule owner").to_owned()).or_default().push(source.clone());}
        for sources in inventory.values_mut(){sources.sort_by_key(|source|source.to_string());}
        let payload=descriptor_json(&descriptor_json(&inventory));
        body.push(entry_span,Some("canScenarioScheduleSources".into()),&format!("export function canScenarioScheduleSources(){{return JSON.parse({payload});}}"));
    }
    if !emitter.source_cancels.is_empty(){
        let mut inventory:BTreeMap<String,Vec<serde_json::Value>>=BTreeMap::new();
        for source in emitter.source_cancels.values(){inventory.entry(source["owner"].as_str().expect("checked cancel owner").to_owned()).or_default().push(source.clone());}
        for sources in inventory.values_mut(){sources.sort_by_key(|source|source.to_string());}
        let payload=descriptor_json(&descriptor_json(&inventory));
        body.push(entry_span,Some("canScenarioCancelSources".into()),&format!("export function canScenarioCancelSources(){{return JSON.parse({payload});}}"));
    }
    if !emitter.source_data_emits.is_empty(){
        body.push(entry_span,Some("canScenarioEmitDataSource".into()),"const $can$emit$data=new WeakMap();function $can$emit$issue(source,context,body){$can$emit$data.set(body,{source,context});return body;}export function canScenarioEmitDataSource(body){const issued=$can$emit$data.get(body);return issued===undefined?null:{source:JSON.parse(issued.source),context:issued.context};}");
        let mut inventory:BTreeMap<String,Vec<serde_json::Value>>=BTreeMap::new();
        for source in emitter.source_data_emits.values(){inventory.entry(source["owner"].as_str().expect("checked EMIT owner").to_owned()).or_default().push(source.clone());}
        for sites in inventory.values_mut(){sites.sort_by_key(|site|site.to_string());}
        let payload=descriptor_json(&descriptor_json(&inventory));
        body.push(entry_span,Some("canScenarioEmitDataSources".into()),&format!("export function canScenarioEmitDataSources(){{return JSON.parse({payload});}}"));
    }
    if !emitter.source_data_sends.is_empty(){
        body.push(entry_span,Some("canScenarioSendDataSource".into()),
            "const $can$send$data=new WeakMap();function $can$send$issue(source,context,body){$can$send$data.set(body,{source,context});return body;}export function canScenarioSendDataSource(body){const issued=$can$send$data.get(body);return issued===undefined?null:{source:JSON.parse(issued.source),context:issued.context};}");
        let mut inventory:BTreeMap<String,Vec<serde_json::Value>>=BTreeMap::new();
        for source in emitter.source_data_sends.values(){inventory.entry(source["owner"].as_str().expect("checked owner").to_owned()).or_default().push(source.clone());}
        for sites in inventory.values_mut(){sites.sort_by_key(|site|site.to_string());}
        let payload=descriptor_json(&descriptor_json(&inventory));
        body.push(entry_span,Some("canScenarioSendDataSources".into()),&format!("export function canScenarioSendDataSources(){{return JSON.parse({payload});}}"));
    }
    if native_receipts && !emitter.source_requires.is_empty() {
        body.push(entry_span,Some("canScenarioRequireSource".into()),
            "const $can$require$sources=new WeakMap();function $can$require$issue(source,predicate){$can$require$sources.set(predicate,source);return predicate;}export function canScenarioRequireSource(predicate){const source=$can$require$sources.get(predicate);return source===undefined?null:JSON.parse(source);}");
        // This source-backed census exists even when no active_member occurs.
        // Its values are the same sealed identities issued to genuine Require
        // closures; the verified loader compares both independently of the
        // membership inventory.
        let mut inventory: BTreeMap<String, Vec<serde_json::Value>> = BTreeMap::new();
        for identity in emitter.source_requires.values() {
            let owner = identity["owner"].as_str().expect("sealed Require owner");
            inventory.entry(owner.to_owned()).or_default().push(identity.clone());
        }
        for sites in inventory.values_mut() {
            sites.sort_by_key(|site| site.to_string());
        }
        let payload = descriptor_json(&descriptor_json(&inventory));
        body.push(entry_span, Some("canScenarioRequireSources".into()),
            &format!("export function canScenarioRequireSources(){{return JSON.parse({payload});}}"));
    }
    if native_receipts && !emitter.membership_predicates.is_empty() {
        body.push(entry_span, Some("canReadPredicateSource".into()),
            "const $can$read$predicates=new WeakMap();function $can$read$issue(source,predicate){$can$read$predicates.set(predicate,source);return predicate;}export function canReadPredicateSource(predicate){const source=$can$read$predicates.get(predicate);return source===undefined?null:JSON.parse(source);}");
    }
    if native_receipts && !emitter.boolean_sources.is_empty() {
        body.push(entry_span, Some("canReadBooleanSource".into()),
            "const $can$boolean$sources=new WeakMap();function $can$boolean$issue(source,predicate){const marker=JSON.parse(source);$can$boolean$sources.set(predicate,source);$can$read$issue(JSON.stringify({source:marker.source,owner:marker.owner,node:marker.node,statement:marker.statement}),predicate);return predicate;}export function canReadBooleanSource(predicate){const source=$can$boolean$sources.get(predicate);return source===undefined?null:JSON.parse(source);}");
        emitter.stdlib.insert("nativeReadBoolean".into());
        for item in &ir.items {
            if let IrItemKind::DeriveField {
                expr: Some(expr), ..
            } = &item.kind
                && let Some(source) = emitter.boolean_sources.get(&expr.span).cloned()
            {
                emitter.boolean_body = true;
                let expression = emitter.lower_business_expr(expr, "Boolean derived field");
                emitter.boolean_body = false;
                body.push(item.span,None,&format!("const $can$boolean${}=$can$boolean$issue({},async(c,row)=>({expression}));",
                    item.id.0,descriptor_json(&descriptor_json(&source))));
            }
        }
    }
    if let Some(membership) = decisions
        .membership
        .filter(|membership| !membership.sites.is_empty())
    {
        let payload = descriptor_json(&descriptor_json(&membership.sites));
        body.push(
            entry_span,
            Some("canMembershipSources".into()),
            &format!("export function canMembershipSources(){{return JSON.parse({payload});}}"),
        );
    }
    let mut source_plans=queries.cloned().unwrap_or_default();
    for (id,recipe) in &emitter.native_receipts {
        if recipe.plan.retained_guarded_handler.is_some() {
            source_plans.insert(ir.items[id.0 as usize].canonical.clone(),serde_json::to_value(&recipe.plan).expect("private source frame"));
        }
    }
    if !source_plans.is_empty() {
        // Return fresh own data: readers cannot mutate another consumer's
        // checked recipe. The verified loader still owns all runtime binding.
        let payload = descriptor_json(&descriptor_json(&source_plans));
        body.push(
            entry_span,
            Some("canScenarioQuerySources".into()),
            &format!("export function canScenarioQuerySources(){{return JSON.parse({payload});}}"),
        );
    }
    // Operation descriptors derive once, up front: the `canApp()`
    // registry and the artifact envelope share them verbatim.
    let mut operations = emitter.collect_operations();
    let call_parents: Vec<_> = ir.items.iter().filter(|item| {
        emitter.native_receipts.contains_key(&item.id)
            && ir.scenario_disclosures.get(&item.id).is_some_and(|plan| {
                matches!(plan, crate::analysis::scenario_disclosure::ScenarioDisclosure::Complete(checked)
                    if checked.effects.iter().any(|effect| matches!(effect.kind,
                        crate::analysis::scenario_disclosure::DisclosureEffectKind::Call { .. })))
            })
    }).collect();
    for item in call_parents {
        let sites = db.and_then(|db| {
            super::scenario_calls::collect_static_scenario_calls_with_feasibility(
                ir,
                item,
                &operations,
                db,
                &module_path(&entry_name),
                (feasibility, Some(&emitter.native_receipts)),
            )
        });
        if let Some(sites) = sites {
            emitter.native_call_sites.insert(item.id, sites);
        } else {
            emitter.native_receipts.remove(&item.id);
            if let Some(operation) = operations
                .iter_mut()
                .find(|operation| operation.name == item.canonical)
            {
                operation.disclosure = None;
            }
        }
    }
    // A source Require executes only inside its defining State receipt.
    // Other supported guards must not make a declined owner's emitted
    // callback look executable when that owner has no runtime frame.
    if native_receipts {
        for item in &ir.items {
            if !emitter.native_receipts.contains_key(&item.id)
                // Public parameter-style source guards bind a decision-only
                // State frame from this verified inventory. Private handlers
                // still need their independently admitted retained frame.
                && !source_require_only_body_supported(ir, item,&emitter.source_requires,&emitter.source_data_sends,&emitter.source_let_data,&emitter.source_cancels,&emitter.source_schedules,&emitter.source_data_emits,&emitter.source_body_loops,decisions.source_context)
                && emitter.source_requires.values().any(|source| source["owner"] == item.canonical)
                && !emitter.diags.iter().any(|diagnostic| diagnostic.primary == item.span
                    && diagnostic.severity == crate::diagnostic::Severity::Error)
            {
                let reason = match ir.scenario_disclosures.get(&item.id) {
                    Some(crate::analysis::scenario_disclosure::ScenarioDisclosure::Declined(decline)) =>
                        format!(": {}", decline.reason),
                    _ => String::new(),
                };
                emitter.unsupported("scenario source requirement",
                    &format!("original checked owner receipt is unavailable for its source guard{reason}"), item.span);
                if let Some(crate::analysis::scenario_disclosure::ScenarioDisclosure::Declined(decline)) =
                    ir.scenario_disclosures.get(&item.id)
                {
                    emitter.diags.last_mut().unwrap().related.push(crate::diagnostic::Related {
                        span: Span::new(decline.node.file, decline.node.start, decline.node.end),
                        message: format!("Unsupported original owner expression: {}", decline.reason),
                    });
                }
            }
        }
    }
    // The event-decision bridge evaluates these original helpers over its
    // tracked record views using ordinary calls. A handler census alone must
    // not suppress those definitions: unlike retained handlers, this receipt
    // does not select a private helper variant.
    if emitter.native_receipts.values().any(|receipt|
        receipt.plan.event_decision.is_some() || receipt.plan.success_renewal_decision.is_some())
    {
        // Standard completion handlers are added to the emitter's dispatch
        // set later; they are outside this original Declared/Every census.
        let private_handlers = decisions.owner_handlers.into_iter().flatten().copied().filter(|id|
            emitter.native_receipts.get(id).is_none_or(|receipt|
                receipt.plan.event_decision.is_none() && receipt.plan.success_renewal_decision.is_none()))
            .collect();
        let ordinary_safe = decisions.source_context.and_then(|context|
            decisions.read_predicates?.private_only_derives(context, &private_handlers))
            .unwrap_or_default();
        emitter.private_derives.retain(|name| ordinary_safe.contains(name));
    }
    emitter.emit_identity_consts(&mut body, entry_id);
    for module in &ir.modules {
        for page in &module.pages {
            emitter.lower_page(page, &mut body);
        }
    }
    emitter.emit_app_definition(&mut body, entry_id);
    emitter.emit_derive_fns(&mut body, false, false, false);
    emitter.emit_can_app(&mut body, entry_id, &operations, local_policies.as_ref());
    emitter.emit_derive_fns(&mut body, true, false, false);
    emitter.emit_derive_fns(&mut body, true, true, false);
    emitter.emit_derive_fns(&mut body, false, false, true);
    // Hook-variant definitions come after the hooks registry that selects
    // them (see `emit_hook_variants`): hook bodies lower inside
    // `emit_can_app`, so only now is the selected set complete.
    emitter.emit_hook_variants(&mut body);
    emitter.emit_equality_schema(&mut body, entry_span);
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
    let entry_path = module_path(&entry_name);
    let entry = out.try_finish(entry_path.clone()).unwrap_or_else(|error| {
        emitter.diags.push(error);
        JsModule {
            path: entry_path,
            js: String::new(),
            lines: Vec::new(),
        }
    });
    let stdlib_imports = emitter.stdlib.clone();
    let ui_imports = emitter.ui.clone();
    let value_types = emitter.value_types.clone();
    let committed_changes = emitter.committed_changes.clone();

    let mut packages = Vec::new();
    for module in &ir.modules {
        if Some(module.id) == entry_id {
            continue;
        }
        packages.push(emitter.emit_package_module(module.id));
    }
    let membership_bound = emitter.membership_bound.clone();
    let (diagnostics, referenced_builtins, callables, pages) = emitter.finish();
    JsOutput {
        entry,
        packages,
        diagnostics,
        referenced_builtins,
        membership_bound,
        callables,
        pages,
        operations,
        value_types,
        model_policies: local_policies.map(|plan| plan.descriptors),
        committed_changes,
        stdlib_imports,
        ui_imports,
    }
}

/// Pick the entrypoint: first composed app, else first implicit app, else
/// first package, else none.
pub(super) fn pick_entrypoint(ir: &IrProgram) -> Option<crate::analysis::resolve::ModuleId> {
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
pub(super) fn module_path(name: &str) -> String {
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

/// Public server factories used by the finite source profiles below.
/// `slot` and tab items are structural IR, never standalone imports.
fn is_ui_factory(factory: &str) -> bool {
    matches!(
        factory,
        "action"
            | "actionMenu"
            | "actionBindings"
            | "renderActionScope"
            | "primaryActions"
            | "actions"
            | "accordion"
            | "alert"
            | "badge"
            | "board"
            | "breadcrumbs"
            | "button"
            | "calendar"
            | "card"
            | "chatBubble"
            | "checkbox"
            | "collapse"
            | "content"
            | "copy"
            | "countdown"
            | "deleteRecord"
            | "diff"
            | "divider"
            | "drawer"
            | "dropdown"
            | "edit"
            | "fab"
            | "fieldset"
            | "form"
            | "fileInput"
            | "filter"
            | "gallery"
            | "footer"
            | "hero"
            | "history"
            | "indicator"
            | "input"
            | "join"
            | "label"
            | "link"
            | "list"
            | "modal"
            | "pagination"
            | "progress"
            | "radialProgress"
            | "range"
            | "renderState"
            | "radio"
            | "select"
            | "stat"
            | "status"
            | "steps"
            | "swap"
            | "table"
            | "tabs"
            | "text"
            | "textarea"
            | "timeline"
            | "title"
            | "toggle"
            | "tooltip"
            | "validator"
    )
}

/// Props consumed by the actual public factory (or the form preparer).
/// Unavailable runtime-carrier profiles are rejected during IR decoding.
fn ui_collection_prop_admitted(factory: &str, key: &str) -> Option<bool> {
    match factory {
        "list" => Some(matches!(
            key,
            "model"
                | "parent"
                | "where"
                | "archived"
                | "limit"
                | "cursor"
                | "empty"
                | "columns"
                | "display"
                | "page"
                | "order"
                | "search"
                | "count"
                | "filter"
                | "defaults"
        )),
        "board" => Some(matches!(
            key,
            "model"
                | "parent"
                | "where"
                | "limit"
                | "cursor"
                | "empty"
                | "columns"
                | "page"
                | "order"
                | "search"
                | "count"
                | "filter"
                | "defaults"
                | "by"
        )),
        "timeline" => Some(matches!(
            key,
            "model" | "parent" | "where" | "order" | "page" | "occurrence"
        )),
        "gallery" => Some(matches!(
            key,
            "model"
                | "parent"
                | "where"
                | "empty"
                | "image"
                | "order"
                | "search"
                | "count"
                | "page"
                | "filter"
                | "defaults"
        )),
        "table" => Some(matches!(
            key,
            "model"
                | "parent"
                | "where"
                | "archived"
                | "limit"
                | "cursor"
                | "empty"
                | "columns"
                | "order"
                | "search"
                | "filter"
                | "defaults"
                | "display"
                | "page"
        )),
        "calendar" => Some(matches!(
            key,
            "field"
                | "kind"
                | "model"
                | "parent"
                | "startField"
                | "endField"
                | "where"
                | "order"
                | "limit"
                | "cursor"
                | "empty"
                | "page"
                | "filter"
                | "defaults"
                | "columns"
        )),
        _ => None,
    }
}

fn ui_form_prop_admitted(factory: &str, key: &str) -> Option<bool> {
    match factory {
        "form" => Some(matches!(
            key,
            "operation"
                | "fields"
                | "arguments"
                | "submit"
                | "controlLabel"
                | "authoredSubmit"
                | "display"
        )),
        "input" | "textarea" | "radio" | "select" => {
            Some(matches!(key, "field" | "tone" | "size" | "variant"))
        }
        "label" => Some(matches!(key, "field" | "caption")),
        "validator" => Some(key == "field"),
        "checkbox" => Some(key == "field"),
        "range" | "fileInput" => Some(key == "field"),
        "fieldset" => Some(matches!(key, "caption" | "id" | "variant")),
        _ => None,
    }
}

fn ui_panel_prop_admitted(factory: &str, key: &str) -> Option<bool> {
    match factory {
        "card" => Some(matches!(key, "title" | "layout")),
        "collapse" => Some(matches!(key, "caption" | "open" | "id" | "variant")),
        "tabs" => Some(matches!(
            key,
            "id" | "size" | "variant" | "binding" | "caption"
        )),
        "title" => Some(matches!(key, "text" | "level")),
        "text" => Some(key == "values"),
        "content" => Some(key == "value"),
        "filter" => Some(matches!(key, "binding" | "caption")),
        "copy" => Some(matches!(key, "value" | "label" | "id")),
        "toggle" => Some(key == "field"),
        _ => None,
    }
}

fn ui_media_prop_admitted(factory: &str, key: &str) -> Option<bool> {
    match factory {
        "swap" => Some(key == "active"),
        "indicator" => Some(matches!(key, "content" | "indicator")),
        "steps" => Some(key == "items"),
        "countdown" => Some(matches!(key, "value" | "caption")),
        "radialProgress" => Some(matches!(key, "value" | "max" | "caption")),
        "progress" => Some(matches!(key, "value" | "max")),
        "renderState" => Some(matches!(key, "kind" | "message")),
        "tooltip" => Some(key == "caption"),
        "history" => Some(matches!(key, "model" | "record")),
        _ => None,
    }
}

fn ui_chrome_prop_admitted(factory: &str, key: &str) -> Option<bool> {
    match factory {
        "hero" | "footer" => Some(key == "caption"),
        "join" => Some(matches!(key, "id" | "orientation" | "variant")),
        "badge" => Some(matches!(
            key,
            "value" | "caption" | "tone" | "size" | "variant"
        )),
        "status" => Some(matches!(key, "value" | "caption" | "tone" | "size")),
        "divider" => Some(matches!(
            key,
            "caption" | "tone" | "orientation" | "variant"
        )),
        "button" => Some(matches!(key, "caption" | "target" | "opens" | "submit")),
        "link" => Some(matches!(key, "caption" | "target" | "tone" | "variant")),
        "modal" | "drawer" => Some(matches!(
            key,
            "caption" | "id" | "variant" | "externalTrigger"
        )),
        "chatBubble" => Some(matches!(key, "side" | "tone" | "variant")),
        "fab" => Some(key == "label"),
        _ => None,
    }
}

fn ui_record_prop_admitted(factory: &str, key: &str) -> Option<bool> {
    match factory {
        "stat" => Some(matches!(
            key,
            "value" | "title" | "description" | "icon" | "orientation" | "id" | "variant"
        )),
        "alert" => Some(matches!(
            key,
            "value" | "tone" | "variant" | "orientation" | "regionId"
        )),
        "deleteRecord" => Some(matches!(
            key,
            "operation"
                | "record"
                | "mode"
                | "action"
                | "operationId"
                | "itemLabel"
                | "controlLabel"
                | "confirm"
                | "idPrefix"
                | "display"
        )),
        _ => None,
    }
}

fn ui_prop_is_admitted(factory: &str, key: &str) -> bool {
    ui_collection_prop_admitted(factory, key)
        .or_else(|| ui_form_prop_admitted(factory, key))
        .or_else(|| ui_panel_prop_admitted(factory, key))
        .or_else(|| ui_media_prop_admitted(factory, key))
        .or_else(|| ui_chrome_prop_admitted(factory, key))
        .or_else(|| ui_record_prop_admitted(factory, key))
        .unwrap_or(false)
}

/// Finite options consumed by the current owning UI appearance contracts.
fn ui_option_words(factory: &str, key: &str) -> Option<&'static [&'static str]> {
    const TONES: &[&str] = &[
        "neutral",
        "primary",
        "secondary",
        "accent",
        "info",
        "success",
        "warning",
        "error",
    ];
    const SIZES: &[&str] = &["xs", "sm", "md", "lg", "xl"];
    match key {
        "tone" if factory == "alert" => Some(&["info", "success", "warning", "error"]),
        "tone"
            if matches!(
                factory,
                "badge"
                    | "status"
                    | "divider"
                    | "chatBubble"
                    | "input"
                    | "textarea"
                    | "radio"
                    | "select"
            ) =>
        {
            Some(TONES)
        }
        "size"
            if matches!(
                factory,
                "badge" | "status" | "tabs" | "input" | "textarea" | "radio" | "select"
            ) =>
        {
            Some(SIZES)
        }
        "variant" => Some(match factory {
            "badge" => &["solid", "outline", "soft", "ghost"],
            "alert" => &["solid", "outline", "soft"],
            "input" | "textarea" | "select" => &["solid", "ghost"],
            _ => &["solid"],
        }),
        "orientation" => Some(&["horizontal", "vertical"]),
        "side" => Some(&["start", "end"]),
        "layout" => Some(&["stack", "columns"]),
        "display" if factory == "form" => Some(&["inline", "drawer", "menu"]),
        "display" if factory == "deleteRecord" => Some(&["inline", "menu"]),
        "display" if matches!(factory, "list" | "table") => Some(&["split"]),
        _ => None,
    }
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

/// B16: validate the standalone saved-preference filter binding against
/// current lowered declarations. The page-body control edits the owning
/// saved preference through the existing page-preference save path (the
/// descriptor's `preferenceFields` over the caller-path POST with CSRF
/// plus compare-and-set version); the sibling collection keeps its own
/// occurrence controls and serving, so no query authority is carried
/// here. Raw or edited UI metadata cannot acquire a preference editor
/// by shape alone: the version chain's module segment resolves the
/// owning module first, then the binding name must resolve to a checked
/// preference field of that module's `Preferences` owner whose checked
/// type is an owned finite-choice (or its nullable form), options must
/// be exactly that choice's cases in order, and the current read must
/// be that preference.
fn saved_preference_binding_parts(node: &IrUi) -> Option<&[(String, TypedExpr)]> {
    let keys: std::collections::HashSet<_> = node.props.iter().map(|(key, _)| key.as_str()).collect();
    if keys.len() != node.props.len() || keys.len() > 2 || !keys.iter().all(|key| matches!(*key, "binding" | "caption")) { return None; }
    let (_, binding) = node.props.iter().find(|(key, _)| key == "binding")?;
    let IrExpr::Object(parts) = &binding.expr else { return None; };
    let expected: &[&str] = if parts.iter().any(|(key, _)| key == "editor") {
        &["name", "options", "current", "version", "postTo", "editor", "nullable"]
    } else { &["name", "options", "current", "version", "postTo"] };
    (parts.len() == expected.len() && expected.iter().all(|key| parts.iter().filter(|(name, _)| name == key).count() == 1)).then_some(parts)
}

fn inline_preference_editor_matches(editor: &TypedExpr, nullable: &TypedExpr, ty: &ResolvedType, values: &[&str]) -> bool {
    let IrExpr::Text(editor) = &editor.expr else { return false; };
    if !matches!(nullable.expr, IrExpr::Bool(value) if value == ty.nullable_inner().is_some()) { return false; }
    match (editor.as_str(), ty.nullable_inner().unwrap_or(ty)) {
        ("bool", ResolvedType::Scalar(Scalar::Bool)) => values == ["true", "false"],
        ("text", ResolvedType::Scalar(Scalar::Text)) | ("int", ResolvedType::Scalar(Scalar::Int)) => values.is_empty(),
        _ => false,
    }
}

fn coalesce_post_target_valid(post_to: &TypedExpr) -> bool {
    let IrExpr::Binary { op, left, right } = &post_to.expr else {
        return false;
    };
    if !matches!(op, IrBinOp::Coalesce) || post_to.ty != ResolvedType::Scalar(Scalar::Text) {
        return false;
    }
    let IrExpr::Member { base, field } = &left.expr else {
        return false;
    };
    if field != "pollUrl" || !matches!(&base.expr, IrExpr::Name(base) if base == "c") {
        return false;
    }
    let IrExpr::Member { base, field } = &right.expr else {
        return false;
    };
    if field != "path" || !matches!(&base.expr, IrExpr::Name(base) if base == "c") {
        return false;
    }
    true
}

fn preference_version_module(version: &TypedExpr, name: &str) -> Option<String> {
    let IrExpr::Member { base, field } = &version.expr else {
        return None;
    };
    if field != name {
        return None;
    }
    let IrExpr::Member { base, field } = &base.expr else {
        return None;
    };
    let module_segment = field.clone();
    if module_segment.is_empty() {
        return None;
    }
    let IrExpr::Member { base, field } = &base.expr else {
        return None;
    };
    if field != "preferenceVersions"
        || !matches!(&base.expr, IrExpr::Name(base) if base == "c")
    {
        return None;
    }
    Some(module_segment)
}

fn standalone_filter_binding_is_valid(ir: &IrProgram, node: &IrUi) -> bool {
    let Some(parts) = saved_preference_binding_parts(node) else { return false; };
    let part = |key: &str| parts.iter().find(|(name, _)| name == key).map(|(_, value)| value);
    let (Some(name), Some(options), Some(current), Some(version), Some(post_to)) = (
        part("name"),
        part("options"),
        part("current"),
        part("version"),
        part("postTo"),
    ) else {
        return false;
    };
    let IrExpr::Text(name) = &name.expr else {
        return false;
    };
    if name.is_empty() {
        return false;
    }
    let IrExpr::Array(options) = &options.expr else {
        return false;
    };
    if options.is_empty() && part("editor").is_none() {
        return false;
    }
    let mut values = Vec::new();
    for option in options {
        let IrExpr::Object(fields) = &option.expr else {
            return false;
        };
        let value = fields
            .iter()
            .find(|(key, _)| key == "value")
            .and_then(|(_, value)| {
                if let IrExpr::Text(value) = &value.expr {
                    Some(value.as_str())
                } else {
                    None
                }
            });
        let Some(value) = value else {
            return false;
        };
        if value.is_empty() || !fields.iter().any(|(key, _)| key == "label") {
            return false;
        }
        values.push(value);
    }
    if values.iter().collect::<std::collections::HashSet<_>>().len() != values.len() {
        return false;
    }
    // The current read is that preference: a direct `preferences.<name>` leaf.
    let IrExpr::Member { base, field } = &current.expr else {
        return false;
    };
    if field != name || !matches!(&base.expr, IrExpr::Name(base) if base == "preferences") {
        return false;
    }
    // The version travels the dispatcher-owned compare-and-set chain for
    // this preference: exactly `c.preferenceVersions.<module>.<name>`.
    // The module segment resolves the owning module BEFORE the field
    // lookup below, so a second app's ordinary same-named preference
    // can never satisfy (or break) this app's binding.
    let Some(module_segment) = preference_version_module(version, name) else {
        return false;
    };
    // The POST target is the actual caller-text coalesce the bound-tabs
    // owner emits (`c.pollUrl ?? c.path`), not any coalesce by shape.
    if !coalesce_post_target_valid(post_to) {
        return false;
    }
    // The binding names a checked preference field of THIS module's
    // `Preferences` owner; options are exactly its owned finite-choice
    // cases in order and the read types as the preference, so an
    // equivalent other-app reuse keeps its own meaning.
    let Some(module) = ir.modules.iter().find(|module| module.name == module_segment) else {
        return false;
    };
    let preference = ir.items.iter().find(|item| {
        item.name == *name
            && item.module == module.id
            && matches!(&item.kind, IrItemKind::Field { owner, .. }
                if ir.items.get(owner.0 as usize).is_some_and(|declared| {
                    declared.module == module.id
                        && matches!(&declared.kind, IrItemKind::Preferences { fields, .. } if fields.contains(&item.id))
                }))
    });
    let Some(preference) = preference else {
        return false;
    };
    let IrItemKind::Field {
        ty: IrType::Known(ty),
        ..
    } = &preference.kind
    else {
        return false;
    };
    if current.ty != *ty {
        return false;
    }
    if let (Some(editor), Some(nullable)) = (part("editor"), part("nullable")) {
        return inline_preference_editor_matches(editor, nullable, ty, &values);
    }
    let expected: &[String] = match ty.nullable_inner().unwrap_or(ty) {
        ResolvedType::Enum {
            owner: Some(_),
            cases,
        } if !cases.is_empty()
            && cases.iter().collect::<std::collections::HashSet<_>>().len() == cases.len() =>
        {
            cases
        }
        ResolvedType::Scalar(Scalar::Bool) => return values == ["true", "false"],
        _ => return false,
    };
    values == expected.iter().map(String::as_str).collect::<Vec<_>>()
}

/// Validate the finite collection carrier against current lowered declarations;
/// raw or edited UI metadata cannot acquire an enum filter by shape alone.
/// Recompute the sealed derived-bool marker from the resolved
/// DeriveField item: the exact (field, expansion) pair for the two
/// sealed CanDesk derives, the owning module name, and the exact
/// declaration span. Any forged, swapped, or edited marker fails.
/// Path/sha256 must be non-empty here; the runtime gate binds them
/// to the artifact sources, which this layer cannot see.
fn derived_bool_source_sealed(
    ir: &IrProgram,
    item: &IrItem,
    field_name: &str,
    expansion: &str,
    parts: &[(String, TypedExpr)],
) -> bool {
    let expected = match (item.canonical.as_str(), field_name, expansion) {
        ("desk.Ticket.unassigned", "unassigned", "unassigned") => true,
        ("desk.Ticket.overdue", "overdue", "overdue") => true,
        _ => false,
    };
    if !expected {
        return false;
    }
    // REVIEW 147: every IrItem is built with `span: symbol.span`
    // (ir.rs:6079), so the marker node compares directly against
    // `item.span`; no separate symbol table exists on IrProgram.
    let Some((_, source)) = parts.iter().find(|(key, _)| key == "source") else {
        return false;
    };
    let IrExpr::Object(entries) = &source.expr else {
        return false;
    };
    if entries.len() != 4
        || entries
            .iter()
            .map(|(key, _)| key.as_str())
            .collect::<std::collections::HashSet<_>>()
            != ["path", "sha256", "module", "node"]
                .iter()
                .copied()
                .collect::<std::collections::HashSet<_>>()
    {
        return false;
    }
    fn text<'a>(entries: &'a [(String, TypedExpr)], key: &str) -> Option<&'a str> {
        entries
            .iter()
            .find(|(name, _)| name == key)
            .and_then(|(_, value)| {
                if let IrExpr::Text(text) = &value.expr {
                    Some(text.as_str())
                } else {
                    None
                }
            })
    }
    let (Some(path), Some(sha), Some(module)) = (
        text(entries, "path"),
        text(entries, "sha256"),
        text(entries, "module"),
    ) else {
        return false;
    };
    // REVIEW 145: bind the marker to the checked source census, not
    // to nonempty text. The (path, sha256) must equal the census
    // entry for the declaration's own source file.
    let census = ir
        .committed_sources
        .sources
        .iter()
        .find(|(id, _, _)| *id == item.span.file)
        .map(|(_, path, sha)| (path.as_str(), sha.as_str()));
    let Some((census_path, census_sha)) = census else {
        return false;
    };
    if path != census_path || sha != census_sha || module.is_empty() {
        return false;
    }
    let Some(module_name) = ir
        .modules
        .iter()
        .find(|module| module.id == item.module)
        .map(|module| module.name.as_str())
    else {
        return false;
    };
    if module != module_name {
        return false;
    }
    let Some((_, node)) = entries.iter().find(|(name, _)| name == "node") else {
        return false;
    };
    let IrExpr::Object(range) = &node.expr else {
        return false;
    };
    if range.len() != 2 {
        return false;
    }
    let at = |key: &str| {
        range.iter().find(|(name, _)| name == key).and_then(
            |(_, value)| {
                if let IrExpr::Int(number) = &value.expr {
                    usize::try_from(*number).ok()
                } else {
                    None
                }
            },
        )
    };
    matches!((at("start"), at("end")), (Some(start), Some(end)) if start == item.span.start as usize && end == item.span.end as usize)
}

fn collection_filter_props_are_valid(ir: &IrProgram, node: &IrUi) -> bool {
    if node
        .props
        .iter()
        .map(|(key, _)| key)
        .collect::<std::collections::HashSet<_>>()
        .len()
        != node.props.len()
    {
        return false;
    }
    let Some(model_name) = form_prop_text(node, "model") else {
        return false;
    };
    let Some(model) = ir.items.iter().find(|item| item.canonical == model_name) else {
        return false;
    };
    let IrItemKind::Model { fields, .. } = &model.kind else {
        return false;
    };
    let field = |name: &str| {
        fields
            .iter()
            .filter_map(|id| ir.items.get(id.0 as usize))
            .find(|item| {
                item.name == name
                    && matches!(item.kind, IrItemKind::Field { owner, .. } if owner == model.id)
            })
    };
    let derived_field = |name: &str| {
        fields
            .iter()
            .filter_map(|id| ir.items.get(id.0 as usize))
            .find(|item| {
                item.name == name
                    && matches!(item.kind, IrItemKind::DeriveField { model: owner, .. } if owner == model.id)
            })
    };
    if node.factory == "gallery" {
        let Some(image) = form_prop_text(node, "image") else {
            return false;
        };
        if !field(&image).is_some_and(|item| {
            matches!(
                &item.kind,
                IrItemKind::Field {
                    ty: IrType::Known(ResolvedType::Scalar(Scalar::File)),
                    ..
                }
            )
        }) || (!node.children.is_empty() && node.row_scope.is_none())
        {
            return false;
        }
    }
    let endpoints: &[&str] = if node.factory == "calendar" {
        &["startField", "endField"]
    } else {
        &[]
    };
    for endpoint in endpoints {
        let Some(name) = form_prop_text(node, endpoint) else {
            return false;
        };
        if !field(&name).is_some_and(|item| {
            matches!(
                &item.kind,
                IrItemKind::Field {
                    ty: IrType::Known(ResolvedType::Scalar(Scalar::Date | Scalar::Datetime)),
                    ..
                }
            )
        }) {
            return false;
        }
    }
    // A parent-bound agenda renders the contained sequence through the
    // shared collection pipeline (CAN18-v1 agenda binding batch,
    // mirroring the accepted timeline bound-sequence contract): the
    // owning UI factory scopes its authorized query to the enclosing
    // row. The date field control (`kind == "field"`) still takes no
    // parent, and every agenda still establishes its row scope.
    if node.factory == "calendar"
        && (node.props.iter().any(|(key, _)| key == "field") || node.row_scope.is_none())
    {
        return false;
    }
    let mut selected = std::collections::HashMap::new();
    if let Some((_, filter)) = node.props.iter().find(|(key, _)| key == "filter") {
        // E5 (CAN18-v1, DESIGN 434/440/975/977): a Lambda `where` is a
        // business restriction that conjoins with typed filter controls
        // (`{op:and,[where,...filters]}` at the query adapter); it is no
        // longer a filter-profile refusal. Column/defaults validation
        // below is unchanged.
        let IrExpr::Array(columns) = &filter.expr else {
            return false;
        };
        if columns.is_empty() {
            return false;
        }
        for column in columns {
            let IrExpr::Object(parts) = &column.expr else {
                return false;
            };
            let keys = parts
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<std::collections::HashSet<_>>();
            // Sealed derived-bool columns carry exactly two extra
            // entries (expansion id + derive declaration source);
            // every other column keeps the exact four-key shape.
            let derived_shape = keys.len() == 6
                && ["field", "label", "type", "valueLabels", "expansion", "source"]
                    .iter()
                    .all(|key| keys.contains(key));
            if keys.len() != parts.len() || (!derived_shape && parts.len() != 4) {
                return false;
            }
            let text = |key: &str| {
                parts
                    .iter()
                    .find(|(name, _)| name == key)
                    .and_then(|(_, value)| {
                        if let IrExpr::Text(text) = &value.expr {
                            Some(text.as_str())
                        } else {
                            None
                        }
                    })
            };
            let Some(name) = text("field") else {
                return false;
            };
            let (item, ty) = if name == "parent" && field("parent").is_none() {
                let IrItemKind::Model { owner: IrOwner::ChildOf(parent), .. } = model.kind else { return false; };
                if field("parent").is_some() { return false; }
                let Some(target) = ir.items.get(parent.0 as usize).filter(|item| matches!(item.kind, IrItemKind::Model { .. })) else { return false; };
                (target, ResolvedType::Record { symbol: parent, stored: true })
            } else if let Some(base) = name.strip_suffix(".currency").filter(|base| !base.contains('.')) {
                let Some(item) = field(base) else { return false; };
                if !matches!(&item.kind, IrItemKind::Field { ty: IrType::Known(ResolvedType::Scalar(Scalar::Money)), .. }) { return false; }
                (item, ResolvedType::Scalar(Scalar::Currency))
            } else if derived_shape {
                // Sealed derived-bool selectors resolve to an owned bool
                // DeriveField whose body the IR layer pinned; their type
                // and expansion are validated below, never inferred here.
                let Some(item) = derived_field(name) else { return false; };
                let IrItemKind::DeriveField { ty: IrType::Known(ty), .. } = &item.kind else { return false; };
                if *ty != ResolvedType::Scalar(Scalar::Bool) {
                    return false;
                }
                (item, ty.clone())
            } else {
                let Some(item) = field(name) else { return false; };
                let IrItemKind::Field { ty: IrType::Known(ty), .. } = &item.kind else { return false; };
                (item, ty.clone())
            };
            // A filter column selects a distinct owned finite-choice model
            // field: an owned enum or a plain bool toggle. Anything else
            // keeps the refusal below.
            let _ = item;
            let expected_cases: Option<&[String]> = match &ty {
                ResolvedType::Enum {
                    owner: Some(owner),
                    cases,
                } if text("type")
                    == ir
                        .items
                        .get(owner.0 as usize)
                        .map(|item| format!("enum:{}", item.canonical))
                        .as_deref() =>
                {
                    Some(cases)
                }
                ResolvedType::Scalar(Scalar::Bool) if text("type") == Some("bool") => None,
                // Sealed derived-bool descriptors carry the pinned
                // expansion id plus the owning derive declaration
                // source; both are rechecked here so a forged or
                // edited descriptor cannot ride the bool path.
                ResolvedType::Scalar(Scalar::Bool)
                    if text("type") == Some("derived-bool")
                        && text("expansion").is_some_and(|expansion| {
                            derived_bool_source_sealed(ir, item, name, expansion, parts)
                        }) =>
                {
                    None
                }
                ResolvedType::Record { symbol, .. }
                    if text("type")
                        == ir
                            .items
                            .get(symbol.0 as usize)
                            .filter(|item| matches!(&item.kind, IrItemKind::Model { .. }))
                            .map(|item| format!("ref:{}", item.canonical))
                            .as_deref() =>
                {
                    None
                }
                ResolvedType::Scalar(Scalar::User) if text("type") == Some("user") => None,
                // E6008 Desk triage profile: the nullable stored `user?`
                // selector lowers with the same opaque `user` descriptor
                // as a non-nullable `user` (DESIGN 977); the host
                // preparer already maps selections to `{id}` identities
                // and clears to no restriction. Nullable `member` keeps
                // the refusal below.
                ResolvedType::Nullable(inner)
                    if inner.as_ref() == &ResolvedType::Scalar(Scalar::User)
                        && text("type") == Some("user") =>
                {
                    None
                }
                ResolvedType::Scalar(Scalar::Member) if text("type") == Some("member") => None,
                // C2 text-equality rule (DESIGN 975 scalar + operator
                // table): a plain `text` column carries no value labels,
                // exactly like a reference. Validated string-likes and
                // every other shape keep the refusal below.
                ResolvedType::Scalar(Scalar::Text) if text("type") == Some("text") => None,
                // C3 civil-date equality rule (DESIGN 1015-1025 operator
                // table): a plain `date` column carries no value labels,
                // exactly like text/a reference. Datetime keeps the
                // refusal below: no symmetry generalization.
                ResolvedType::Scalar(scalar @ (Scalar::Date | Scalar::Int | Scalar::Datetime | Scalar::Currency)) if text("type") == Some(scalar.as_str()) => None,
                _ => return false,
            };
            // A reference column compares by typed opaque identity
            // (DESIGN 977), never enum spellings: its descriptor carries
            // no value labels. A text column carries none either: text
            // is not finite-choice, so the free-text control offers no
            // option inventory. A date column carries none either: civil
            // dates are not finite-choice, so the date control offers no
            // option inventory.
            // E6008 Desk triage profile: the nullable stored `user?`
            // selector carries no value labels, exactly like a
            // non-nullable `user` reference.
            let is_reference = matches!(
                ty,
                ResolvedType::Record { .. } | ResolvedType::Scalar(Scalar::User | Scalar::Member)
            ) || matches!(&ty, ResolvedType::Nullable(inner)
                if inner.as_ref() == &ResolvedType::Scalar(Scalar::User));
            let is_text = matches!(ty, ResolvedType::Scalar(Scalar::Text));
            let is_date = matches!(ty, ResolvedType::Scalar(Scalar::Date | Scalar::Int | Scalar::Datetime | Scalar::Currency));
            if selected.insert(name, ty.clone()).is_some() {
                return false;
            }
            let Some((_, labels)) = parts.iter().find(|(key, _)| key == "valueLabels") else {
                return false;
            };
            let IrExpr::Object(labels) = &labels.expr else {
                return false;
            };
            let labels_match = if is_reference || is_text || is_date {
                labels.is_empty()
            } else {
                match expected_cases {
                    Some(cases) => {
                        labels.iter().map(|(key, _)| key).collect::<Vec<_>>()
                            == cases.iter().collect::<Vec<_>>()
                    }
                    None => {
                        labels
                            .iter()
                            .map(|(key, _)| key.as_str())
                            .collect::<Vec<_>>()
                            == vec!["true", "false"]
                    }
                }
            };
            if !labels_match || !parts.iter().any(|(key, _)| key == "label") {
                return false;
            }
        }
    }
    if let Some((_, defaults)) = node.props.iter().find(|(key, _)| key == "defaults") {
        let IrExpr::Object(entries) = &defaults.expr else {
            return false;
        };
        let mut seen = std::collections::HashSet::new();
        for (name, value) in entries {
            let Some(expected) = selected.get(name.as_str()) else {
                return false;
            };
            if !seen.insert(name) {
                return false;
            }
            let bool_default = matches!(expected, ResolvedType::Scalar(Scalar::Bool));
            // Reference defaults admit only direct saved reads (or null)
            // through the Member arm below: no literal spellings and no
            // computed forms (DESIGN 977).
            let enum_cases = match expected {
                ResolvedType::Enum { cases, .. } => Some(cases),
                ResolvedType::Scalar(Scalar::Bool) => None,
                ResolvedType::Record { .. }
                | ResolvedType::Scalar(Scalar::User | Scalar::Member) => None,
                // C2 text-equality rule: no case inventory (None, like
                // references); other shapes keep the refusal.
                ResolvedType::Scalar(Scalar::Text) => None,
                // C3 civil-date equality rule: no case inventory (None,
                // like text/references); other shapes keep the refusal.
                ResolvedType::Scalar(Scalar::Date | Scalar::Int | Scalar::Datetime | Scalar::Currency) => None,
                _ => return false,
            };
            // C2 text-equality rule (DESIGN 975 scalar): a text-typed
            // literal matches the text control. No computed text form
            // reaches the arms below (both shape checks require bool or
            // enum cases), so only this literal, a direct saved text
            // read, or null lower.
            let text_default = matches!(expected, ResolvedType::Scalar(Scalar::Text));
            // C3 civil-date equality rule (DESIGN 1015-1025): a date
            // literal (`date("...")` call or folded `Date`) matches the
            // date control. No computed date form is admitted: only this
            // literal, a direct saved date read, or null lower.
            let date_default = matches!(expected, ResolvedType::Scalar(Scalar::Date));
            let date_literal = date_default
                && value.ty == *expected
                && (matches!(&value.expr, IrExpr::Date(_))
                    || matches!(&value.expr, IrExpr::Call { target, args }
                        if matches!(&target, IrCallTarget::Builtin { id, .. } if id == "date")
                            && matches!(args.as_slice(), [single] if matches!(single.expr, IrExpr::Text(_)))));
            let valid = match &value.expr {
                IrExpr::Text(case) => {
                    enum_cases.is_some_and(|cases| {
                        cases.contains(case)
                            && (value.ty == *expected
                                || matches!(value.ty, ResolvedType::Scalar(Scalar::Text)))
                    }) || (bool_default
                        && (case == "true" || case == "false")
                        && (value.ty == *expected
                            || matches!(value.ty, ResolvedType::Scalar(Scalar::Text))))
                        || ((text_default || *expected == ResolvedType::Scalar(Scalar::Currency)) && value.ty == *expected)
                }
                IrExpr::Int(_) if *expected == ResolvedType::Scalar(Scalar::Int) && value.ty == *expected => true,
                IrExpr::Datetime(_) if *expected == ResolvedType::Scalar(Scalar::Datetime) && value.ty == *expected => true,
                _ if date_literal => true,
                IrExpr::Bool(_) => bool_default && value.ty == *expected,
                IrExpr::Null => true,
                IrExpr::Member { base, .. } if matches!(&base.expr, IrExpr::Name(name) if name == "preferences") => {
                    value.ty == *expected
                        || matches!(&value.ty, ResolvedType::Nullable(inner) if inner.as_ref() == expected)
                }
                _ if bool_default => bool_filter_default_shape(ir, value),
                // B14: computed enum defaults mirror the bool shape
                // above over owned enum spellings (see
                // `enum_filter_default_shape`).
                _ => enum_cases.is_some_and(|_| enum_filter_default_shape(ir, value, expected)),
            };
            if !valid {
                return false;
            }
        }
    }
    true
}

/// B13: computed bool filter defaults over decoded bool preference
/// reads. The checked type does the work: the root must type exactly
/// `bool`, every `preferences.*` leaf must read a (nullable-)bool
/// preference, and every other node must be a pure value form (a bool
/// literal, a boolean operator, or a checked derive-helper call
/// returning bool). Reads decode at the typed reader above, so operator
/// positions only consume already-boolean values and no sink coercion
/// applies; anything else keeps the refusal in the caller.
fn bool_filter_default_shape(ir: &IrProgram, value: &TypedExpr) -> bool {
    match &value.expr {
        IrExpr::Bool(_) => value.ty == ResolvedType::Scalar(Scalar::Bool),
        IrExpr::Member { base, .. } if matches!(&base.expr, IrExpr::Name(name) if name == "preferences") =>
        {
            matches!(
                value.ty.nullable_inner().unwrap_or(&value.ty),
                ResolvedType::Scalar(Scalar::Bool)
            )
        }
        IrExpr::Binary { left, right, .. } => {
            value.ty == ResolvedType::Scalar(Scalar::Bool)
                && bool_filter_default_shape(ir, left)
                && bool_filter_default_shape(ir, right)
        }
        IrExpr::Unary { operand, .. } => {
            value.ty == ResolvedType::Scalar(Scalar::Bool) && bool_filter_default_shape(ir, operand)
        }
        IrExpr::Call { target, args } => bool_filter_derive_call(ir, target, args, value),
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => {
            slots.iter().all(|slot| slot.is_some())
                && bool_filter_derive_call(ir, target, args, value)
        }
        _ => false,
    }
}

/// A derive-helper call returning bool over admitted arguments. The
/// target must resolve to a checked derive function returning bool;
/// visibility was already scoped by checking.
fn bool_filter_derive_call(
    ir: &IrProgram,
    target: &IrCallTarget,
    args: &[TypedExpr],
    value: &TypedExpr,
) -> bool {
    let IrCallTarget::DeriveFn(canonical) = target else {
        return false;
    };
    value.ty == ResolvedType::Scalar(Scalar::Bool)
        && ir.items.iter().any(|item| {
            item.canonical.as_str() == canonical.as_str()
                && matches!(
                    &item.kind,
                    IrItemKind::DeriveFn {
                        result: IrType::Known(ResolvedType::Scalar(Scalar::Bool)),
                        ..
                    }
                )
        })
        && args.iter().all(|arg| bool_filter_default_shape(ir, arg))
}

/// B14: computed enum filter defaults over owned enum preference
/// reads. The checked type does the work: every node must type as the
/// filter's owned enum or its nullable form, every `preferences.*` leaf
/// must read that enum, and every other node must be a pure value form
/// (a `??` fallback over admitted reads or a checked derive-helper call
/// returning the enum). Reads lower verbatim — cases are already
/// spellings, and the host preparer refuses unknown spellings against
/// the column inventory — so no sink coercion applies; anything else
/// keeps the refusal in the caller.
fn enum_filter_default_shape(ir: &IrProgram, value: &TypedExpr, expected: &ResolvedType) -> bool {
    if !matches!(expected, ResolvedType::Enum { .. }) {
        return false;
    }
    let typed = value.ty == *expected
        || matches!(&value.ty, ResolvedType::Nullable(inner) if inner.as_ref() == expected);
    if !typed {
        return false;
    }
    match &value.expr {
        IrExpr::Member { base, .. } if matches!(&base.expr, IrExpr::Name(name) if name == "preferences") => {
            true
        }
        IrExpr::Binary { left, right, .. } => {
            enum_filter_default_shape(ir, left, expected)
                && enum_filter_default_shape(ir, right, expected)
        }
        IrExpr::Call { target, args } => enum_filter_derive_call(ir, target, args, value, expected),
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => {
            slots.iter().all(|slot| slot.is_some())
                && enum_filter_derive_call(ir, target, args, value, expected)
        }
        _ => false,
    }
}

/// A derive-helper call returning the filter's owned enum (or its
/// nullable form) over admitted arguments. The target must resolve to a
/// checked derive function returning that type; visibility was already
/// scoped by checking.
fn enum_filter_derive_call(
    ir: &IrProgram,
    target: &IrCallTarget,
    args: &[TypedExpr],
    value: &TypedExpr,
    expected: &ResolvedType,
) -> bool {
    let IrCallTarget::DeriveFn(canonical) = target else {
        return false;
    };
    (value.ty == *expected
        || matches!(&value.ty, ResolvedType::Nullable(inner) if inner.as_ref() == expected))
        && ir.items.iter().any(|item| {
            item.canonical.as_str() == canonical.as_str()
                && matches!(
                    &item.kind,
                    IrItemKind::DeriveFn {
                        result: IrType::Known(ty),
                        ..
                    } if ty == &value.ty
                )
        })
        && args
            .iter()
            .all(|arg| enum_filter_default_shape(ir, arg, expected))
}

/// Writable selector controls currently admitted by the source lowering.
/// `toggle` decodes through the same bool-control owner as `checkbox` and
/// carries the identical prepared-field contract.
fn is_form_field_control(factory: &str) -> bool {
    matches!(
        factory,
        "input"
            | "textarea"
            | "radio"
            | "select"
            | "calendar"
            | "checkbox"
            | "toggle"
            | "range"
            | "fileInput"
    )
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

/// Fragments have independent placements and never count as controls.
/// Stop at the same ownership boundaries as the writable control collector.
fn collect_authored_form_fragments(node: &IrUi, factory: &str, out: &mut Vec<String>) {
    if node.factory == "form" || node.row_scope.is_some() {
        return;
    }
    if node.factory == factory
        && let Some(path) = form_prop_text(node, "field")
    {
        out.push(path);
    }
    for child in &node.children {
        collect_authored_form_fragments(child, factory, out);
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

/// Transcribe one role gate to its ordered State `ByPredicate` JSON leaf:
/// built-in actor spellings stay bare strings, declared roles become
/// `{role}` objects. This mirrors the native T16 receiver's legacy
/// (top-level bare strings) versus nested (bare builtins, `{role}`
/// objects) transcription rules; `packages/state/src/policy/roles.ts`
/// stays the authority and is reused read-only.
fn by_role_leaf(id: &str) -> String {
    if matches!(id, "members" | "owner" | "authenticated" | "public") {
        js_string(id)
    } else {
        format!("{{\"role\":{}}}", js_string(id))
    }
}

/// Transcribe one admission guard to its ordered State `ByPredicate` tree,
/// preserving source order for lazy `and`/`or` evaluation. Returns `None`
/// for subject/expression content with no static tree form, so the caller
/// keeps the loud `gated` refusal instead of inventing a spelling.
fn by_predicate_tree(guard: &IrGuard) -> Option<String> {
    match guard {
        IrGuard::Role(id) => Some(by_role_leaf(id)),
        IrGuard::And(_) | IrGuard::Or(_) => {
            let key = if matches!(guard, IrGuard::And(_)) {
                "and"
            } else {
                "or"
            };
            let mut terms = Vec::new();
            flatten_guard_terms(guard, key, &mut terms)?;
            if terms.is_empty() {
                return None;
            }
            Some(format!("{{\"{key}\":[{terms}]}}", terms = terms.join(",")))
        }
        IrGuard::Not(inner) => Some(format!("{{\"not\":{}}}", by_predicate_tree(inner)?)),
        IrGuard::Subject { .. } | IrGuard::Expr(_) => None,
    }
}

/// Splice same-combinator nesting so an authored `a or b or c` chain emits
/// one ordered term list. Flattening is associative with identical
/// left-to-right short-circuit order; mixed operators keep their explicit
/// nesting, and untranscribable content still refuses via `None`.
fn flatten_guard_terms(guard: &IrGuard, key: &str, terms: &mut Vec<String>) -> Option<()> {
    match guard {
        IrGuard::And(inner) if key == "and" => {
            for guard in inner {
                flatten_guard_terms(guard, key, terms)?;
            }
            Some(())
        }
        IrGuard::Or(inner) if key == "or" => {
            for guard in inner {
                flatten_guard_terms(guard, key, terms)?;
            }
            Some(())
        }
        _ => {
            terms.push(by_predicate_tree(guard)?);
            Some(())
        }
    }
}

/// A read grant may expose the same actor role identity as operation
/// admission only when its entire checked predicate is that role gate.
/// Row filters and expression rules retain registry-only metadata, so
/// consumers cannot silently drop part of the predicate.
fn actor_read_role(predicate: &TypedExpr) -> Option<&str> {
    match &predicate.expr {
        IrExpr::HasRole { role, person: None } => Some(role),
        _ => None,
    }
}

/// Only a whole subject gate over this model's direct stored user field
/// can be represented by the row-subject policy descriptor.
fn row_read_role<'a>(
    predicate: &'a TypedExpr,
    model: &IrItem,
    fields: &[SymbolId],
    ir: &IrProgram,
) -> Option<(&'a str, &'a str)> {
    let IrExpr::HasRole {
        role,
        person: Some(person),
    } = &predicate.expr
    else {
        return None;
    };
    let IrExpr::Member { base, field } = &person.expr else {
        return None;
    };
    if !matches!(&base.expr, IrExpr::Name(name) if name == "row")
        || !matches!(&base.ty, ResolvedType::Record { symbol, stored: true } if *symbol == model.id)
        || !matches!(
            person.ty.nullable_inner().unwrap_or(&person.ty),
            ResolvedType::Scalar(Scalar::User)
        )
    {
        return None;
    }
    let mut candidates = fields
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .filter(|item| item.name == *field);
    let declared = candidates.next()?;
    if candidates.next().is_some() || declared.module != model.module {
        return None;
    }
    match &declared.kind {
        IrItemKind::Field {
            owner,
            ty: IrType::Known(ty),
            ..
        } if *owner == model.id && *ty == person.ty => Some((role, field)),
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

/// One `policy.operations` entry with Boolean admission trees. A lone role
/// gate keeps its exact historical `by:["spelling"]` bytes; a pure role-only
/// compound gate emits its ordered `ByPredicate` tree as the single `by`
/// term (the native receiver AND-joins top-level terms, so one term is the
/// tree itself). Subject/expression gates keep the loud `gated:true` marker
/// without an invented tree. `requires`/`when` pass through unchanged: CRUD
/// `when` stays a sealed marker, never inlined data.
fn operation_policy_tree_entry(by: &[IrGuard], requires: usize, has_when: bool) -> Option<String> {
    if let [IrGuard::Role(_)] = by {
        let (spellings, gated) = guard_spellings(by);
        return operation_policy_entry(&spellings, gated, requires, has_when);
    }
    if !by.is_empty() {
        let mut terms = Vec::with_capacity(by.len());
        for guard in by {
            match by_predicate_tree(guard) {
                Some(tree) => terms.push(tree),
                None => {
                    let (spellings, gated) = guard_spellings(by);
                    return operation_policy_entry(&spellings, gated, requires, has_when);
                }
            }
        }
        let mut members = vec![format!("by:[{}]", terms.join(","))];
        if requires > 0 {
            members.push(format!("requires:{requires}"));
        }
        if has_when {
            members.push("when:true".to_string());
        }
        return Some(format!("{{{}}}", members.join(",")));
    }
    let (spellings, gated) = guard_spellings(by);
    operation_policy_entry(&spellings, gated, requires, has_when)
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
    value_types: Option<JsValueTypes>,
    equality_schema: bool,
    committed_changes: Option<Vec<JsCommittedChange>>,
    standard_completions: Option<Vec<JsStandardCompletion>>,
    by_canonical: HashMap<String, usize>,
    stdlib: BTreeSet<String>,
    ui: BTreeSet<String>,
    /// Original projected rows stay separate from business-expression rows.
    original_ui_rows: Vec<OriginalUiRow>,
    relative: BTreeMap<String, BTreeSet<String>>,
    /// Checked derive calls used by this emitter; example modules link them to their real owner.
    derive_calls: BTreeSet<String>,
    /// Derive canonicals selected for parent-loader hook variants (a hook
    /// parent-linkage call site, or a nested linkage call inside a parent
    /// variant body). Only selected canonicals lower an `h$…` variant:
    /// emitting a variant for every stored-record derive would lower
    /// hook-only restrictions over ordinary helpers no hook ever calls,
    /// reporting `E6008` at previously-clean sites. Disjoint from
    /// `hook_variant_reference`: one helper reused across both linkages
    /// lowers one parent variant plus one reference variant (per-use
    /// selection), never one mixed-loader variant.
    hook_variant_parent: BTreeSet<String>,
    /// CAN18-v1 reference variants: canonicals whose selecting call sites
    /// carried reference linkages (file 14 first shape). Disjoint from
    /// `hook_variant_parent`; each kind emits its own loader variant
    /// (`load` vs `loadReference`) at its inherited site.
    hook_variant_reference: std::collections::HashSet<String>,
    diags: Vec<Diagnostic>,
    builtins: Vec<ReferencedBuiltin>,
    callables: Vec<JsCallable>,
    pages: Vec<JsPage>,
    /// Hook lowering state while emitting one hook run function (T31):
    /// `Some` exactly between [`Emitter::enter_hook`] and
    /// [`Emitter::exit_hook`]. Statements and expressions consult it to
    /// stage through the hook context instead of the ambient `c`.
    hook: Option<HookState>,
    /// Event-rooted hook aliases by lexical scope (mirrors `bindings`).
    /// `Some` classifies the binding; `None` shadows an outer alias with a
    /// plain value. Consulted only while hook lowering is active.
    hook_aliases: Vec<HashMap<String, Option<HookAlias>>>,
    /// Explicitly supplied staged-create data fields by source alias.
    /// Native hooks bind each staged alias to a local `{id, ...data}`
    /// object, so reads of exactly these fields observe the same values
    /// the stage call carries (evaluated once). Cleared with the alias
    /// scopes on hook exit and invalidated by staged updates.
    hook_staged_data: HashMap<String, HashSet<String>>,
    /// Closure nesting inside hook lowering (lambdas and query row
    /// closures). Top-level parent-content reads lower via the transitive
    /// parent load (`await` is legal in the async run function); nested
    /// closures keep the loud `E6008` until their async carrier is defined.
    hook_closure_depth: usize,
    /// Decision nesting inside hook lowering (hook firing/guard/decision
    /// expressions per DESIGN §442, including `if` conditions such as
    /// `if event.after.parent.active and not event.after.done`).
    /// Parent loads inside decisions carry mode `'decision'` in the scope
    /// object (recorded bounded owner read, no resulting grant); body/value
    /// copies carry `'value'` (current caller grants retained). Pure helpers
    /// inherit the consuming site (no Boolean-result privilege). Raw loads
    /// without a mode never exist, so body values never gain the guard's
    /// owner authority. The existing `transitive.load(scope,model,id)`
    /// arity and all scope/fence/source checks are preserved; only the
    /// scope object carries the mode.
    hook_decision_depth: usize,
    /// Hook-variant helper emission: record-typed parameter source name to
    /// its declared model (symbol plus canonical) for transitive loads
    /// through `c.transitive` at the inherited site (`$hookSite`). `Some`
    /// exactly while emitting one `h$…` helper body; `None` elsewhere. The
    /// call-site scope object and fence checks are unchanged — only the
    /// context path differs (`c.transitive`, the ambient context the
    /// module-scope helper receives, rather than `$hookCtx.transitive`).
    hook_helper_links: Option<HashMap<String, (SymbolId, String)>>,
    /// True while emitting a reference-variant helper body (see
    /// `hook_variant_reference`): linkage reads lower through
    /// `c.transitive.loadReference` at the inherited site. False (parent
    /// variants) keeps the existing `c.transitive.load`. `None` outside
    /// helper emission mirrors `hook_helper_links`.
    hook_helper_reference: bool,
    /// Bounded-loop sequence: each `for ... limit` binds its own
    /// `$forRowsN` fetch, so sequential loops never redeclare one
    /// binding (source order keeps numbering deterministic).
    loop_seq: usize,
    /// Lexical declaration owners; references resolve inward, like Can scopes.
    bindings: Vec<HashMap<String, String>>,
    binding_seq: usize,
    localized_format: bool,
    checked_message: bool,
    formatted_bindings: Vec<HashMap<String, bool>>,
    formatted_derives: BTreeSet<String>,
    native_receipts: HashMap<SymbolId, super::scenario_receipts::NativeScenarioReceipt>,
    constructor_inputs: HashMap<SymbolId, serde_json::Value>,
    constructor_counts: HashMap<SymbolId, serde_json::Value>,
    private_term_helper_only: bool,
    execution_dependencies:
        BTreeMap<String, Vec<super::scenario_receipts::ReceiptRequireConsumption>>,
    native_call_sites: HashMap<SymbolId, Vec<super::scenario_calls::StaticScenarioCall>>,
    receipt_call_sites: Vec<super::scenario_calls::StaticScenarioCall>,
    receipt_capture: Option<super::scenario_receipts::NativeScenarioReceipt>,
    unique_conditions: Vec<super::model_unique_conditions::CheckedUniqueCondition>,
    model_rule_origins: Option<Vec<serde_json::Value>>,
    current_revision_binding: Option<String>,
    current_policy_rule: Option<super::model_policy_profile::CurrentRevisionRuleProfile>,
    receipt_calls: Vec<Span>,
    native_query_sources: HashMap<SymbolId, NativeQuerySource>,
    /// Independently checked transcript metadata; this grants no capture.
    query_selections: Option<&'a BTreeMap<String, serde_json::Value>>,
    query_any: Option<&'a BTreeMap<String, serde_json::Value>>,
    /// Only the immutable CheckedProgram/fresh-IR producer can populate this.
    prepared_query_receipts: std::collections::HashSet<SymbolId>,
    query_capture: Option<NativeQuerySource>,
    membership_calls: HashMap<Span, serde_json::Value>,
    membership_sites: Option<&'a BTreeMap<String, serde_json::Value>>,
    membership_predicates: HashMap<Span, serde_json::Value>,
    /// Checked membership occurrences this lowering bound to the State
    /// producer (exact checked source + selected call closure). Their
    /// builtin references resolve to that defining owner, never the
    /// generic catalog's external marker.
    membership_bound: Vec<Span>,
    boolean_sources: HashMap<Span, serde_json::Value>,
    source_requires: HashMap<Span, serde_json::Value>,
    source_data_sends: HashMap<Span, serde_json::Value>,
    source_let_data: HashMap<Span, serde_json::Value>,
    source_data_emits: HashMap<Span, serde_json::Value>,
    source_body_loops: HashMap<String, serde_json::Value>,
    source_data_body: bool,
    source_cancels: HashMap<Span, serde_json::Value>,
    source_schedules: HashMap<Span, serde_json::Value>,
    source_require_identity: Option<serde_json::Value>,
    source_require_calls: Vec<serde_json::Value>,
    boolean_derives: HashSet<String>,
    boolean_rules: HashSet<String>,
    owner_handlers: HashSet<SymbolId>,
    private_derives: HashSet<String>,
    owner_handler_body: bool,
    private_terminal_ready: bool,
    owner_handler_derives: HashSet<String>,
    retained_owner_derives: HashSet<String>,
    retained_owner_body: bool,
    boolean_body: bool,
    generic_boolean_body: bool,
    generic_boolean_derives: HashSet<String>,
    source_guard_body: bool,
    source_guard_derive_depth: usize,
    boolean_helper: bool,
    /// A declared ordinary read scenario uses the canonical viewer reader.
    /// Its checked stored-model query may feed pure `first(array)` without
    /// claiming an owner mutation receipt.
    viewer_read_body: bool,
    /// True while lowering a `scope=authority` report body (DESIGN §442
    /// decision mode): helper calls resolve to the decision variant where
    /// dual-emitted, falling back to the emitted variant otherwise.
    /// Viewer lowering never sets this; query authority, bounds and
    /// recursion-freedom come from the host decision boundary, never
    /// from emitted syntax.
    authority_body: bool,
    record_page_render: bool,
    native_source_predicates: bool,
    authority_queries: Option<&'a super::authority_query_sites::PreparedAuthorityQuerySites>,
    send_guards: Option<&'a HashMap<Span, super::send_guards::PreparedSendGuard>>,
    send_guard_owners: Option<&'a BTreeMap<String, serde_json::Value>>,
    send_guard_gap: Option<&'a super::send_guards::SendGuardGap>,
    /// Resolved saved Then inputs (prompted-view renderers, style
    /// units) for `show` emission. `Some` exactly when the driver
    /// passed a source database, so database-free emission keeps its
    /// exact prior posture.
    then_join: Option<ThenBuildJoin>,
    /// Declaring source path by source id, set from the source database.
    /// Present only for multi-source closures, where the module source map
    /// cannot resolve one exact declaring file; single-source output stays
    /// byte-identical.
    source_paths: HashMap<crate::source::SourceId, String>,
}

struct OriginalUiRow {
    name: String,
    model: String,
    binding: Option<String>,
}

#[derive(Clone)]
struct NativeQuerySource {
    owner: String,
    queries: Vec<crate::analysis::scenario_disclosure::DisclosureQuery>,
    transcripts: Vec<crate::analysis::scenario_disclosure::CheckedTranscriptSource>,
    inline_selections: Vec<crate::analysis::scenario_disclosure::CheckedInlineSelectionSource>,
    return_id: String,
    plan: serde_json::Value,
}

/// Hook lowering state: the trigger model. (The staged-id counter lives
/// in the emitted run function itself as `$stagedNext`, resetting per
/// trigger invocation, so the emitter keeps no counter.)
struct HookState {
    /// Trigger model symbol (same-model backstop inside lowering).
    trigger: SymbolId,
    /// Native hooks receive the ambient operation context (`c`) from the
    /// owning engine frame; legacy hooks bind no `c`.
    native: bool,
    /// Checked hook site: the scenario canonical (e.g. `T.h`), embedded
    /// in staged-create ids so distinct hooks on one fire stage distinct
    /// children. Matches the runtime hook name by construction (the
    /// descriptor id is the same canonical).
    site: String,
}

/// Event-rooted alias class for hook bindings. Snapshots carry the full
/// trigger row; parent steps carry the engine's `{model, id}` linkage
/// identity for bare uses, with declared fields loading via the transitive
/// parent load; staged create bindings carry the bound `{id}` identity;
/// other event-derived values (leaf and reference reads) gap on deeper
/// access. Untracked names lower normally.
#[derive(Clone, Copy, PartialEq, Eq)]
enum HookAlias {
    Snapshot,
    Parent,
    Staged,
    Value,
}

/// Event-chain base classes for hook member lowering. Depth-1 snapshot
/// reads, parent-linkage identities and top-level declared parent fields
/// (via the transitive parent load) lower; anything else through them gaps
/// loud instead of reading `undefined` off an identity object.
#[derive(Clone, Copy, PartialEq, Eq)]
enum HookBase {
    Event,
    Root,
    Snapshot,
    Parent,
    Staged,
    Shallow,
    DeepParent,
    DeepStaged,
    DeepRef,
    Plain,
}

/// Record-helper call shape for one derive target: the pure variant
/// (`AsIs`), the hook variant with its verbatim inherited-site expression
/// (`Hook` of emitted function name plus site), or a loud refusal
/// (`Refuse`, reported as `E6008` by the caller).
enum HookDerive {
    AsIs,
    /// Hook variant plus inherited site plus whether the selecting linkage
    /// is a reference edge (file-14 first shape) rather than a parent edge.
    /// Call sites record the kind so one emitted variant never mixes
    /// loaders; mixed uses stay fail-closed.
    Hook((String, String, bool)),
    Refuse,
}

impl<'a> Emitter<'a> {
    /// Create an emitter over `ir`.
    pub fn new(ir: &'a IrProgram) -> Self {
        let mut emitter = Self::with_value_types(ir, None);
        emitter.value_types = emitter.collect_judgment_value_types();
        emitter.seed_completion_error_contract();
        emitter
    }

    /// Declaring source path for `span`. Present only for multi-source
    /// closures, where the module source map cannot resolve one exact
    /// declaring file; single-source output stays byte-identical.
    fn declaration_source(&self, span: Span) -> Option<String> {
        if self.source_paths.len() > 1 {
            self.source_paths.get(&span.file).cloned()
        } else {
            None
        }
    }

    /// Completion handlers admit the DESIGN §8 envelope: the
    /// statically-closed `DeliveryError` nominal must resolve even
    /// when no census roots carry it (deployment-bound capabilities
    /// record no std roots). The closure is static std text leaves,
    /// so no source-backed claim is fabricated. Seeded on the base
    /// inventory so both the base and the census overlay carry it.
    fn seed_completion_error_contract(&mut self) {
        let has_completion = self.ir.items.iter().any(|item| {
            matches!(
                &item.kind,
                IrItemKind::Scenario {
                    event_source: Some(
                        IrEventSource::DeliveryCompleted { .. }
                            | IrEventSource::StandardCompleted { .. }
                    ),
                    ..
                }
            )
        });
        if !has_completion {
            return;
        }
        let inventory = self.value_types.get_or_insert_default();
        if inventory
            .contracts
            .iter()
            .any(|contract| contract.name == "DeliveryError")
        {
            return;
        }
        let mut seen = BTreeSet::new();
        let mut contracts = Vec::new();
        if collect_std_value_contracts("DeliveryError?", &mut seen, &mut contracts).is_none() {
            return;
        }
        inventory.contracts.extend(contracts);
    }

    /// Reuse the already checked inventory when collecting artifact models.
    pub fn with_value_types(ir: &'a IrProgram, value_types: Option<JsValueTypes>) -> Self {
        let by_canonical = ir
            .items
            .iter()
            .enumerate()
            .map(|(i, item)| (item.canonical.clone(), i))
            .collect();
        let mut emitter = Self {
            ir,
            value_types,
            equality_schema: false,
            committed_changes: None,
            standard_completions: None,
            by_canonical,
            stdlib: BTreeSet::new(),
            ui: BTreeSet::new(),
            original_ui_rows: Vec::new(),
            relative: BTreeMap::new(),
            derive_calls: BTreeSet::new(),
            hook_variant_parent: BTreeSet::new(),
            hook_variant_reference: std::collections::HashSet::new(),
            diags: Vec::new(),
            builtins: Vec::new(),
            callables: Vec::new(),
            pages: Vec::new(),
            hook: None,
            hook_aliases: vec![HashMap::new()],
            hook_staged_data: HashMap::new(),
            hook_closure_depth: 0,
            hook_decision_depth: 0,
            hook_helper_links: None,
            hook_helper_reference: false,
            loop_seq: 0,
            bindings: vec![HashMap::new()],
            binding_seq: 0,
            localized_format: false,
            checked_message: false,
            formatted_bindings: vec![HashMap::new()],
            formatted_derives: BTreeSet::new(),
            native_receipts: HashMap::new(),
            constructor_inputs: HashMap::new(),
            constructor_counts: HashMap::new(),
            private_term_helper_only: false,
            execution_dependencies: BTreeMap::new(),
            native_call_sites: HashMap::new(),
            receipt_call_sites: Vec::new(),
            receipt_capture: None,
            unique_conditions: Vec::new(),
            model_rule_origins: None,
            current_revision_binding: None,
            current_policy_rule: None,
            receipt_calls: Vec::new(),
            native_query_sources: HashMap::new(),
            query_selections: None,
            query_any: None,
            prepared_query_receipts: std::collections::HashSet::new(),
            query_capture: None,
            membership_calls: HashMap::new(),
            membership_sites: None,
            membership_predicates: HashMap::new(),
            membership_bound: Vec::new(),
            boolean_sources: HashMap::new(),
            source_requires: HashMap::new(),
            source_data_sends: HashMap::new(),
            source_let_data: HashMap::new(),
            source_data_emits: HashMap::new(),
            source_body_loops: HashMap::new(),
            source_data_body: false,
            source_cancels: HashMap::new(),
            source_schedules: HashMap::new(),
            source_require_identity: None,
            source_require_calls: Vec::new(),
            boolean_derives: HashSet::new(),
            boolean_rules: HashSet::new(),
            owner_handlers: HashSet::new(),
            private_derives: HashSet::new(),
            owner_handler_body: false,
            private_terminal_ready: false,
            owner_handler_derives: HashSet::new(),
            retained_owner_derives: HashSet::new(),
            retained_owner_body: false,
            boolean_body: false,
            generic_boolean_body: false,
            generic_boolean_derives: HashSet::new(),
            source_guard_body: false,
            source_guard_derive_depth: 0,
            boolean_helper: false,
            viewer_read_body: false,
            authority_body: false,
            record_page_render: false,
            native_source_predicates: false,
            authority_queries: None,
            send_guards: None,
            send_guard_owners: None,
            send_guard_gap: None,
            then_join: None,
            source_paths: HashMap::new(),
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

    /// Selected sends and stored receipts publish their complete owning value
    /// closure only against the original checked source/import/declaration census.
    /// The inventory describes values; it grants no provider or File authority.
    pub(super) fn collect_standard_value_inventory(
        &mut self,
        db: &crate::source::SourceDb,
    ) -> Option<JsValueTypes> {
        let span = self
            .ir
            .modules
            .first()
            .map_or(Span::new(crate::source::SourceId(0), 0, 0), |module| {
                module.span
            });
        let Some(roots) = self
            .ir
            .committed_sources
            .standard_value_inventory_roots(self.ir, db)
        else {
            self.unsupported(
                "standard value inventory",
                "original checked source, catalog, import or selected declaration census disagrees",
                span,
            );
            return None;
        };
        let mut seen = BTreeSet::new();
        let mut contracts = Vec::new();
        for (declared, span) in roots {
            if collect_std_value_contracts(declared, &mut seen, &mut contracts).is_none() {
                self.unsupported(
                    "standard value inventory",
                    "selected owning input/result/error has an unresolved nominal closure",
                    *span,
                );
                return None;
            }
        }
        let mut inventory = self.value_types.clone().unwrap_or_default();
        let mut published: BTreeSet<_> = inventory
            .contracts
            .iter()
            .map(|contract| contract.name.clone())
            .collect();
        for contract in contracts {
            if published.insert(contract.name.clone()) {
                inventory.contracts.push(contract);
            }
        }
        Some(inventory)
    }

    fn push_judgment_leaves(
        &mut self,
        item: &IrItem,
        fields: &[SymbolId],
        leaves: &mut Vec<JsNominalLeaf>,
        enums: &mut BTreeMap<String, Vec<String>>,
    ) {
        for id in fields {
            let Some(field) = self.ir.items.get(id.0 as usize).cloned() else {
                self.unsupported(
                    "Judgment value schema",
                    "checked field identity is absent",
                    item.span,
                );
                continue;
            };
            let (ty, required_array) = match &field.kind {
                IrItemKind::Field {
                    ty, required_array, ..
                }
                | IrItemKind::JudgmentGenerated(IrJudgmentGenerated::Field {
                    ty,
                    required_array,
                    ..
                }) => (ty, *required_array),
                _ => {
                    self.unsupported(
                        "Judgment value schema",
                        "checked field payload is absent",
                        field.span,
                    );
                    continue;
                }
            };
            let IrType::Known(ty) = ty else {
                self.unsupported(
                    "Judgment value schema",
                    "checked field type is absent",
                    field.span,
                );
                continue;
            };
            let mut declared = self.symbol_value_type_id(field.id, ty, field.span);
            if required_array {
                declared.push('!');
            }
            leaves.push(JsNominalLeaf {
                name: field.name.clone(),
                declared,
                constraints: self.nominal_field_constraints(&field, ty),
            });
            let mut base = ty;
            while let ResolvedType::Nullable(inner)
            | ResolvedType::Array { element: inner, .. } = base
            {
                base = inner;
            }
            if let ResolvedType::Enum {
                owner: Some(owner),
                cases,
            } = base
            {
                let name = self.ir.items[owner.0 as usize].canonical.clone();
                enums.entry(name).or_insert_with(|| cases.clone());
            }
        }
    }

    fn collect_judgment_value_types(&mut self) -> Option<JsValueTypes> {
        let has_judgment = self
            .ir
            .items
            .iter()
            .any(|item| matches!(item.kind, IrItemKind::Judgment { .. }));
        // Ordinary contracts use the same released inventory, independently
        // of whether a Judgment happens to be present. Admit whole checked
        // closures only. Model leaves refer to the same-load model inventory;
        // their row schemas and authority remain owned by model declarations.
        let model_names: BTreeSet<String> = self
            .collect_models()
            .into_iter()
            .map(|model| model.name)
            .collect();
        fn supported_field(
            ir: &IrProgram,
            ty: &ResolvedType,
            contracts: &[SymbolId],
            model_names: &BTreeSet<String>,
        ) -> bool {
            let outer = match ty {
                ResolvedType::Nullable(inner) => inner.as_ref(),
                ty => ty,
            };
            let base = match outer {
                ResolvedType::Array { element, .. } => element.as_ref(),
                ty => ty,
            };
            match base {
                // The existing Values timezone codec also owns this leaf in
                // complete Contracts; no operation-result profile is widened.
                ResolvedType::Scalar(Scalar::Timezone) => true,
                ResolvedType::Scalar(
                    Scalar::Int
                    | Scalar::Text
                    | Scalar::Bool
                    | Scalar::Decimal
                    | Scalar::Money
                    | Scalar::Date
                    | Scalar::Datetime
                    | Scalar::Duration
                    | Scalar::Currency
                    | Scalar::Email
                    | Scalar::Url
                    | Scalar::User
                    | Scalar::File,
                ) => checked_value_profile(ty).is_some(),
                // Declaration identity distinguishes a contract from a model;
                // reused named-contract field types also carry `stored:true`.
                ResolvedType::Record { symbol, .. } => {
                    contracts.contains(symbol)
                        || ir.items.get(symbol.0 as usize).is_some_and(|item| {
                            item.id == *symbol
                                && matches!(item.kind, IrItemKind::Model { .. })
                                && model_names.contains(&item.canonical)
                        })
                }
                // Values owns tagged nominal unions. Admit only complete
                // ordinary contract arms; stored-model unions retain their
                // separate, unsupported field profile.
                ResolvedType::Union(arms) => {
                    arms.len() >= 2
                        && arms.iter().all(|symbol| {
                            contracts.contains(symbol)
                                && ir.items.get(symbol.0 as usize).is_some_and(|item| {
                                    item.id == *symbol
                                        && matches!(item.kind, IrItemKind::Contract { .. })
                                })
                        })
                }
                // Standard field reuse keeps the original checked inline cases;
                // it has no authored enum owner to publish or fabricate.
                ResolvedType::Enum { owner: None, cases } => !cases.is_empty(),
                ResolvedType::Enum {
                    owner: Some(owner),
                    cases,
                } => {
                    !cases.is_empty()
                        && ir.items.get(owner.0 as usize).is_some_and(|item| {
                            item.id == *owner
                                && matches!(
                                    item.kind,
                                    IrItemKind::Field { .. }
                                        | IrItemKind::JudgmentGenerated(
                                            IrJudgmentGenerated::Field { .. }
                                        )
                                )
                        })
                }
                _ => false,
            }
        }
        let mut ordinary_contracts: Vec<_> = self
            .ir
            .items
            .iter()
            .filter_map(|item| {
                matches!(
                    item.kind,
                    IrItemKind::Judgment { .. }
                        | IrItemKind::JudgmentGenerated(IrJudgmentGenerated::Contract { .. })
                )
                .then_some(item.id)
            })
            .collect();
        loop {
            let before = ordinary_contracts.len();
            for item in &self.ir.items {
                let IrItemKind::Contract { fields, .. } = &item.kind else {
                    continue;
                };
                if ordinary_contracts.contains(&item.id) {
                    continue;
                }
                if fields.iter().all(|id| {
                    self.ir.items.get(id.0 as usize).is_some_and(|field| {
                        field.id == *id
                            && matches!(&field.kind, IrItemKind::Field {
                        owner, ty: IrType::Known(ty), ..
                    } if *owner == item.id && supported_field(self.ir, ty, &ordinary_contracts, &model_names))
                    })
                }) {
                    ordinary_contracts.push(item.id);
                }
            }
            if before == ordinary_contracts.len() {
                break;
            }
        }
        if !has_judgment
            && ordinary_contracts.is_empty()
            && self.ir.standard_completion_sources.handlers.is_empty()
        {
            return None;
        }
        let mut inventory = JsValueTypes::default();
        let mut enums = BTreeMap::new();
        let ir = self.ir;
        for item in &ir.items {
            if let Some(constraints) = self.ir.value_constraints.get(&item.id)
                && constraints.alias == Some(item.id)
            {
                inventory.aliases.push(JsValueAlias {
                    name: item.canonical.clone(),
                    declared: "text".to_string(),
                    constraints: JsValueConstraints::from(constraints),
                });
            }
            let fields = match &item.kind {
                IrItemKind::Judgment { result_fields, .. } => result_fields,
                IrItemKind::JudgmentGenerated(IrJudgmentGenerated::Contract { fields }) => fields,
                IrItemKind::Contract { fields, .. } if ordinary_contracts.contains(&item.id) => {
                    fields
                }
                _ => continue,
            };
            let mut leaves = Vec::new();
            self.push_judgment_leaves(item, fields, &mut leaves, &mut enums);
            inventory.contracts.push(JsNominalResult {
                name: item.canonical.clone(),
                fields: leaves,
            });
        }
        inventory.enums = enums
            .into_iter()
            .map(|(name, cases)| JsNamedEnum { name, cases })
            .collect();
        let mut published: BTreeSet<_> = inventory
            .contracts
            .iter()
            .map(|contract| contract.name.clone())
            .collect();
        for fact in &self.ir.standard_completion_sources.handlers {
            let completion = &fact.completion;
            let Some(op) = std_capability(&completion.capability).and_then(|capability| {
                capability
                    .operations
                    .iter()
                    .find(|op| op.name == completion.op && op.result == completion.result_type)
            }) else {
                self.unsupported(
                    "standard completion value schema",
                    "selected owning operation/result is absent",
                    fact.span,
                );
                continue;
            };
            let mut seen = BTreeSet::new();
            let mut contracts = Vec::new();
            let complete = op
                .inputs
                .iter()
                .map(|(_, declared)| *declared)
                .chain([op.result, "DeliveryError"])
                .all(|declared| {
                    collect_std_value_contracts(declared, &mut seen, &mut contracts).is_some()
                });
            if !complete {
                self.unsupported(
                    "standard completion value schema",
                    "owning input/result/error has an unresolved nominal closure",
                    fact.span,
                );
                continue;
            }
            for contract in contracts {
                if published.insert(contract.name.clone()) {
                    inventory.contracts.push(contract);
                }
            }
        }
        Some(inventory)
    }

    /// Ordinary fields use their owning checked modifiers, including exact
    /// scalar wire bounds. Generated aliases retain their checked constraints.
    fn nominal_field_constraints(
        &mut self,
        field: &IrItem,
        ty: &ResolvedType,
    ) -> JsValueConstraints {
        let mut constraints = self
            .ir
            .value_constraints
            .get(&field.id)
            .map_or_else(JsValueConstraints::default, JsValueConstraints::from);
        let IrItemKind::Field { modifiers, .. } = &field.kind else {
            return constraints;
        };
        if modifiers.trim {
            constraints.trim = Some(true);
        }
        // Reused generated aliases already have receiving bounds intersected
        // by the checker. Authored modifiers must not weaken that result.
        if self.ir.value_constraints.contains_key(&field.id) {
            return constraints;
        }
        let mut base = ty;
        while let ResolvedType::Nullable(inner) = base {
            base = inner;
        }
        let length = matches!(base, ResolvedType::Array { .. })
            || matches!(base, ResolvedType::Scalar(scalar) if scalar.is_string_like());
        for (key, expression) in [("min", &modifiers.min), ("max", &modifiers.max)] {
            let Some(expression) = expression else {
                continue;
            };
            let value = if length {
                match expression.expr {
                    IrExpr::Int(value) if (0..=9_007_199_254_740_991).contains(&value) => {
                        Some(serde_json::Value::from(value as u64))
                    }
                    _ => None,
                }
            } else {
                wire_literal(expression).map(|value| {
                    serde_json::to_value(value).expect("owning wire literal serializes")
                })
            };
            if let Some(value) = value {
                match key {
                    "min" => constraints.min = Some(value),
                    _ => constraints.max = Some(value),
                }
            } else {
                self.unsupported(
                    "nominal value field bound",
                    "checked bound has no exact owning schema representation",
                    expression.span,
                );
            }
        }
        constraints
    }

    /// Nominal claims resolve only through the emitted checked inventory.
    fn nominal_value_type(&self, ty: &ResolvedType) -> Option<String> {
        match ty {
            ResolvedType::StdNominal { .. } => {
                let name = crate::analysis::types::checked_standard_nominal_name(ty)?;
                self.value_types
                    .as_ref()?
                    .contracts
                    .iter()
                    .any(|record| record.name == name)
                    .then(|| name.to_string())
            }
            ResolvedType::Record { symbol, .. }
            | ResolvedType::Enum {
                owner: Some(symbol),
                ..
            } => {
                let name = &self.ir.items.get(symbol.0 as usize)?.canonical;
                let inventory = self.value_types.as_ref()?;
                (inventory
                    .contracts
                    .iter()
                    .any(|record| record.name == *name)
                    || inventory
                        .enums
                        .iter()
                        .any(|enumeration| enumeration.name == *name))
                .then(|| name.clone())
            }
            ResolvedType::Nullable(inner) => self
                .nominal_value_type(inner)
                .map(|name| format!("{name}?")),
            ResolvedType::Array { element, .. } => self
                .nominal_value_type(element)
                .map(|name| format!("{name}[]")),
            _ => None,
        }
    }

    fn operation_input_value_type(&self, ty: &IrType) -> Option<String> {
        if let IrType::Known(resolved) = ty
            && let Some(name) = self.nominal_value_type(resolved)
        {
            return Some(name);
        }
        checked_operation_input_value_type(ty)
    }

    fn model_value_type(&self, ty: &IrType) -> Option<String> {
        if let IrType::Known(resolved) = ty {
            // The exact stored Bool declaration is consumed by the source-owned
            // lazy ANY binder; a legacy tag alone cannot certify that profile.
            if *resolved == ResolvedType::Scalar(Scalar::Bool) {
                return Some("bool".into());
            }
            fn reference_type(ir: &IrProgram, ty: &ResolvedType) -> Option<String> {
                match ty {
                    ResolvedType::Record {
                        symbol,
                        stored: true,
                    } => {
                        let model = ir.items.get(symbol.0 as usize)?;
                        (model.id == *symbol && matches!(model.kind, IrItemKind::Model { .. }))
                            .then(|| model.canonical.clone())
                    }
                    ResolvedType::Nullable(inner) => {
                        reference_type(ir, inner).map(|name| format!("{name}?"))
                    }
                    ResolvedType::Array { element, .. } => {
                        reference_type(ir, element).map(|name| format!("{name}[]"))
                    }
                    _ => None,
                }
            }
            if let Some(name) = self
                .nominal_value_type(resolved)
                .or_else(|| reference_type(self.ir, resolved))
            {
                return Some(name);
            }
            // Exact stringlike context leaves retain their owning Values codec.
            // Their legacy `string` tag alone would discard format identity.
            fn context_scalar_type(ty: &ResolvedType) -> Option<String> {
                match ty {
                    ResolvedType::Scalar(Scalar::Email) => Some("email".to_string()),
                    ResolvedType::Scalar(Scalar::Url) => Some("url".to_string()),
                    ResolvedType::Scalar(Scalar::Timezone) => Some("timezone".to_string()),
                    ResolvedType::Nullable(inner) => {
                        context_scalar_type(inner).map(|name| format!("{name}?"))
                    }
                    ResolvedType::Array { element, .. } => {
                        context_scalar_type(element).map(|name| format!("{name}[]"))
                    }
                    _ => None,
                }
            }
            if let Some(name) = context_scalar_type(resolved) {
                return Some(name);
            }
            // A reused catalog field can have an anonymous checked enum.
            // Retain its exact cases for the owning field/selection codec;
            // no nominal declaration or field identity is invented.
            if matches!(resolved, ResolvedType::Enum { owner: None, .. }) {
                return checked_enum_value_type(resolved);
            }
        }
        checked_string_value_type(ty).map(str::to_string)
    }

    /// Model metadata may retain a source-declared local delivery even when
    /// its nullable slot is absent. This grants no send/result/input profile.
    fn local_model_delivery_descriptor(&self, op: SymbolId) -> Option<JsDeliveryDescriptor> {
        let operation = self.ir.items.get(op.0 as usize)?;
        let IrItemKind::CapabilityOp {result:IrType::Known(result_type),..} = &operation.kind else { return None; };
        let mut capabilities = self.ir.items.iter().filter(|item| matches!(&item.kind,IrItemKind::Capability {ops,..} if ops.contains(&op)));
        let capability = capabilities.next()?;
        let IrItemKind::Capability {version:Some(version),..} = capability.kind else { return None; };
        if capabilities.next().is_some() || operation.canonical != format!("{}.{}",capability.canonical,operation.name) { return None; }
        let version = u32::try_from(version).ok().filter(|version| *version != 0)?;
        let schema = match result_type {
            ResolvedType::Record { symbol, .. } => {
                let result = self.ir.items.get(symbol.0 as usize)?;
                if !matches!(result.kind, IrItemKind::Contract { .. }) { return None; }
                self.value_types.as_ref()?.contracts.iter().find(|schema| schema.name == result.canonical)?.clone()
            }
            ResolvedType::StdNominal { name, .. } => {
                let schema = nominal_schema(name)?;
                JsNominalResult { name: (*name).to_string(), fields: schema.fields.iter()
                    .map(|(name, declared)| JsNominalLeaf {name:(*name).to_string(),
                        declared:(*declared).to_string(), constraints:JsValueConstraints::default()}).collect() }
            }
            _ => return None,
        };
        Some(JsDeliveryDescriptor {capability:capability.canonical.clone(), operation:operation.name.clone(), version, result:schema})
    }

    fn judgment_delivery_descriptor(&self, op: SymbolId) -> Option<JsJudgmentDeliveryDescriptor> {
        let operation = self.ir.items.get(op.0 as usize)?;
        let IrItemKind::JudgmentGenerated(IrJudgmentGenerated::CapabilityOp {
            result: IrType::Known(ResolvedType::Record { symbol, .. }),
            ..
        }) = &operation.kind
        else {
            return None;
        };
        let declaration = self.ir.items.get(symbol.0 as usize)?;
        let IrItemKind::Judgment { version, .. } = declaration.kind else {
            return None;
        };
        if operation.name != "evaluate" {
            return None;
        }
        let result = self
            .value_types
            .as_ref()?
            .contracts
            .iter()
            .find(|record| record.name == declaration.canonical)?
            .clone();
        Some(JsJudgmentDeliveryDescriptor {
            capability: declaration.canonical.clone(),
            operation: operation.name.clone(),
            version: version.to_string(),
            result,
        })
    }

    fn enter_scope(&mut self) {
        self.bindings.push(HashMap::new());
        self.formatted_bindings.push(HashMap::new());
        self.hook_aliases.push(HashMap::new());
    }

    fn exit_scope(&mut self) {
        self.bindings.pop().expect("lexical scope");
        self.formatted_bindings.pop().expect("lexical scope");
        self.hook_aliases.pop().expect("lexical scope");
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

    fn formatted_name_exposed(&self, name: &str, hidden: &HashMap<&str, usize>) -> bool {
        !hidden.contains_key(name)
            && self
                .formatted_bindings
                .iter()
                .rev()
                .find_map(|scope| scope.get(name))
                .copied()
                .unwrap_or(false)
    }

    fn formatted_derive_call(&self, target: &IrCallTarget) -> bool {
        matches!(target, IrCallTarget::DeriveFn(id) if self.formatted_derives.contains(id))
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
        fn track_presentation_binding<'e>(hidden: &mut HashMap<&'e str, usize>, name: &'e str) {
            *hidden.entry(name).or_default() += 1;
        }
        fn untrack_presentation_binding(hidden: &mut HashMap<&str, usize>, name: &str) {
            let count = hidden.get_mut(name).expect("presentation binder scope");
            *count -= 1;
            if *count == 0 {
                hidden.remove(name);
            }
        }
        fn visit_query_work<'e>(
            query: &'e crate::codegen::ir::IrQuery,
            pending: &mut Vec<Work<'e>>,
        ) {
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
            if let Some(order) = &query.value_order {
                pending.push(Restore(alias));
                pending.push(Visit(&order.key));
                pending.push(Bind(alias));
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

        let mut pending = vec![Visit(expr)];
        let mut hidden: HashMap<&str, usize> = HashMap::new();
        while let Some(work) = pending.pop() {
            let expr = match work {
                Bind(name) => {
                    track_presentation_binding(&mut hidden, name);
                    continue;
                }
                Restore(name) => {
                    untrack_presentation_binding(&mut hidden, name);
                    continue;
                }
                Visit(expr) => expr,
            };
            match &expr.expr {
                IrExpr::Format { .. } => return true,
                IrExpr::Name(name) => {
                    if self.formatted_name_exposed(name, &hidden) {
                        return true;
                    }
                }
                IrExpr::Member { base, .. } => pending.push(Visit(base)),
                IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                    if self.formatted_derive_call(target) {
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
                IrExpr::Query(query) => visit_query_work(query, &mut pending),
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

    /// Recorded human/outbound send sinks that admit localized formatted
    /// text (outcome 7): std mail subject/body and the pinned
    /// `catch.AlertsV1.notify(value:Alert)` message path (DESIGN §9.1).
    /// Returned paths are send-args field segments; every other formatted
    /// position keeps refusing, including mail `to` and send guards.
    fn outbound_sink_paths(&self, operation: &str) -> Option<&'static [&'static [&'static str]]> {
        if operation == "std.EmailV1.send" || operation == "std.EmailV1.send_user" {
            return Some(&[&["subject"], &["body"]]);
        }
        if self.pinned_alert_notify(operation) {
            return Some(&[&["value", "message"]]);
        }
        None
    }

    /// The custom adapter classifies the exact human-text path on the pinned
    /// capability signature: `catch.AlertsV1` version 1,
    /// `notify(value:Alert) -> AlertAccepted` with the defining
    /// `Alert {source:text, destination:url, message:text}` schema. Field
    /// name alone is insufficient, so an unrelated same-named capability,
    /// an altered version, or an altered parameter schema keeps refusing.
    fn pinned_alert_notify(&self, operation: &str) -> bool {
        if operation != "catch.AlertsV1.notify" {
            return false;
        }
        let Some(op) = self.ir.items.iter().find(|item| {
            item.canonical == "catch.AlertsV1.notify"
                && matches!(&item.kind, IrItemKind::CapabilityOp { params, .. } if params.len() == 1)
        }) else {
            return false;
        };
        let IrItemKind::CapabilityOp { params, result } = &op.kind else {
            return false;
        };
        let Some(cap) = self.ir.items.iter().find(|item| {
            item.canonical == "catch.AlertsV1"
                && matches!(
                    &item.kind,
                    IrItemKind::Capability {
                        version: Some(1),
                        ..
                    }
                )
        }) else {
            return false;
        };
        let IrItemKind::Capability { ops, .. } = &cap.kind else {
            return false;
        };
        if !ops.contains(&op.id) {
            return false;
        }
        let Some(param) = self.ir.items.get(params[0].0 as usize) else {
            return false;
        };
        if param.name != "value" {
            return false;
        }
        let IrItemKind::Param {
            ty: IrType::Known(ResolvedType::Record { symbol: alert, .. }),
            ..
        } = &param.kind
        else {
            return false;
        };
        let Some(alert_item) = self.ir.items.get(alert.0 as usize) else {
            return false;
        };
        if alert_item.canonical != "catch.Alert" {
            return false;
        }
        let IrType::Known(ResolvedType::Record {
            symbol: accepted, ..
        }) = result
        else {
            return false;
        };
        let Some(accepted_item) = self.ir.items.get(accepted.0 as usize) else {
            return false;
        };
        if accepted_item.canonical != "catch.AlertAccepted" {
            return false;
        }
        let IrItemKind::Contract { fields, .. } = &alert_item.kind else {
            return false;
        };
        let mut actual = Vec::with_capacity(fields.len());
        for id in fields {
            let Some(field) = self.ir.items.get(id.0 as usize) else {
                return false;
            };
            let IrItemKind::Field {
                ty: IrType::Known(ty),
                ..
            } = &field.kind
            else {
                return false;
            };
            let type_id = match ty {
                ResolvedType::Scalar(scalar) => scalar.as_str().to_string(),
                ResolvedType::Nullable(inner) => match inner.as_ref() {
                    ResolvedType::Scalar(scalar) => format!("{}?", scalar.as_str()),
                    _ => return false,
                },
                _ => return false,
            };
            actual.push((field.name.clone(), type_id));
        }
        actual
            == [
                ("source".to_string(), "text".to_string()),
                ("destination".to_string(), "url".to_string()),
                ("message".to_string(), "text".to_string()),
            ]
    }

    /// Field-segment paths of formatted values under `expr`, mirroring
    /// `expr_formatted` conservatively: a tainted shape placed imprecisely
    /// is reported at its own position (fail closed).
    fn formatted_positions(&self, expr: &TypedExpr) -> Vec<(Vec<String>, Span)> {
        let mut out = Vec::new();
        let mut hidden: HashMap<String, usize> = HashMap::new();
        let mut path = Vec::new();
        self.collect_formatted(expr, &mut path, &mut hidden, &mut out);
        out
    }

    fn collect_formatted(
        &self,
        expr: &TypedExpr,
        path: &mut Vec<String>,
        hidden: &mut HashMap<String, usize>,
        out: &mut Vec<(Vec<String>, Span)>,
    ) {
        match &expr.expr {
            IrExpr::Format { .. } => {
                out.push((path.clone(), expr.span));
            }
            IrExpr::Name(name) => {
                if hidden.get(name.as_str()).copied().unwrap_or(0) == 0
                    && self
                        .formatted_bindings
                        .iter()
                        .rev()
                        .find_map(|scope| scope.get(name))
                        .copied()
                        .unwrap_or(false)
                {
                    out.push((path.clone(), expr.span));
                }
            }
            IrExpr::Member { base, .. } => self.collect_formatted(base, path, hidden, out),
            IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                if matches!(target, IrCallTarget::DeriveFn(id) if self.formatted_derives.contains(id))
                {
                    if self.expr_formatted(expr) {
                        out.push((path.clone(), expr.span));
                    }
                } else {
                    for arg in args {
                        self.collect_formatted(arg, path, hidden, out);
                    }
                }
            }
            IrExpr::Binary { left, right, .. } => {
                self.collect_formatted(left, path, hidden, out);
                self.collect_formatted(right, path, hidden, out);
            }
            IrExpr::Unary { operand, .. } => self.collect_formatted(operand, path, hidden, out),
            IrExpr::Array(items) => {
                for item in items {
                    self.collect_formatted(item, path, hidden, out);
                }
            }
            IrExpr::Object(entries) => {
                for (key, value) in entries {
                    path.push(key.clone());
                    self.collect_formatted(value, path, hidden, out);
                    path.pop();
                }
            }
            _ => {
                if self.expr_formatted(expr) {
                    out.push((path.clone(), expr.span));
                }
            }
        }
    }

    fn formatted_refusal(&mut self, sink: &str, span: Span) -> String {
        self.unsupported(sink,
            "localized formatting is presentation-only; this consumer has no admitted presentation sink contract",
            span);
        self.throw_expr("localized formatting has no lowering at this consumer")
    }

    /// Resolve only a reached business-reference receiver. Source reference
    /// equality and argument values retain their original identity.
    fn lower_boolean_record(&mut self, value: &TypedExpr) -> String {
        self.stdlib.insert("nativeReadReference".into());
        let nullable = value.ty.nullable_inner().is_some();
        let value = self.lower_expr(value);
        if nullable {
            format!("(await (async($reference)=>$reference==null?null:nativeReadReference(c,$reference))({value}))")
        } else {
            format!("(await nativeReadReference(c,{value}))")
        }
    }

    fn lower_business_expr(&mut self, expr: &TypedExpr, sink: &str) -> String {
        if self.expr_formatted(expr) {
            self.formatted_refusal(sink, expr.span)
        } else {
            self.lower_expr(expr)
        }
    }

    /// Lower a preference-dispatched `order` object (`{by, default,
    /// cases}`) to a case ternary over the live preference read, so
    /// the query runner still receives a plain string array. Cases
    /// compare against the checked enum spellings; preference values
    /// without an entry fall back to `default`. `None` when `value`
    /// is not the dispatched profile (fixed arrays lower generically).
    fn lower_dispatched_order(&mut self, value: &TypedExpr) -> Option<String> {
        let IrExpr::Object(entries) = &value.expr else {
            return None;
        };
        let find = |key: &str| {
            entries
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, member)| member)
        };
        let (by, default, cases) = (find("by")?, find("default")?, find("cases")?);
        let IrExpr::Object(case_entries) = &cases.expr else {
            return None;
        };
        let read = self.lower_expr(by);
        let mut out = self.lower_expr(default);
        for (case, order) in case_entries.iter().rev() {
            out = format!(
                "({read}==={})?{}:{out}",
                js_string(case),
                self.lower_expr(order)
            );
        }
        Some(out)
    }

    /// Enter hook lowering for one trigger model: statements stage through
    /// `$hookCtx` and ambient-context expressions report `E6008`. The site
    /// is the hook scenario canonical, embedded in staged-create ids.
    pub fn enter_hook(&mut self, trigger: SymbolId, native: bool, site: &str) {
        self.hook = Some(HookState {
            trigger,
            native,
            site: site.to_string(),
        });
    }

    /// Leave hook lowering, restoring scenario lowering.
    pub fn exit_hook(&mut self) {
        self.hook = None;
        self.hook_closure_depth = 0;
        self.hook_decision_depth = 0;
        for scope in &mut self.hook_aliases {
            scope.clear();
        }
        self.hook_staged_data.clear();
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

    /// Model descriptors are static artifact claims. Keep their bounds
    /// source-exact when possible and make an unrepresentable checked
    /// expression a lowering diagnostic instead of silently omitting it.
    fn validate_model_field_bounds(&mut self) {
        let model_fields: Vec<_> = self
            .ir
            .items
            .iter()
            .filter_map(|item| match &item.kind {
                IrItemKind::Model { fields, .. } => Some(fields.clone()),
                _ => None,
            })
            .flatten()
            .collect();
        let mut unsupported_spans = Vec::new();
        for id in model_fields {
            let Some(item) = self.ir.items.get(id.0 as usize) else {
                continue;
            };
            let IrItemKind::Field { ty, modifiers, .. } = &item.kind else {
                continue;
            };
            let length_bound = match ty {
                IrType::Known(ty) => {
                    let mut base = ty;
                    while let ResolvedType::Nullable(inner) = base {
                        base = inner;
                    }
                    matches!(base, ResolvedType::Array { .. })
                        || matches!(base, ResolvedType::Scalar(s) if s.is_string_like())
                }
                IrType::Unknown => false,
            };
            unsupported_spans.extend(
                [&modifiers.min, &modifiers.max]
                    .into_iter()
                    .flatten()
                    .filter(|bound| {
                        if length_bound {
                            !matches!(&bound.expr, IrExpr::Int(value) if (0..=9_007_199_254_740_991).contains(value))
                        } else {
                            literal_json(bound).is_none()
                        }
                    })
                    .map(|bound| bound.span),
            );
        }
        for span in unsupported_spans {
            self.unsupported(
                "model field bound",
                "expression has no exact artifact wire representation",
                span,
            );
        }
    }

    /// Throwing expression placeholder: keeps the module parseable while
    /// failing loudly at runtime.
    fn throw_expr(&self, message: &str) -> String {
        format!("(() => {{ throw new Error({}); }})()", js_string(message))
    }

    /// Source predicates remain equivalent when an expression is extracted
    /// into an async emitted helper. Checked calls select async execution;
    /// installed boolean-read modes also account for their lazy record loads.
    fn async_scoped_predicate(
        &self,
        target: &IrCallTarget,
        args: &[TypedExpr],
        slots: Option<&[Option<usize>]>,
    ) -> bool {
        if !matches!(target, IrCallTarget::Builtin { id, .. } if matches!(id.as_str(), "any" | "all" | "group")) {
            return false;
        }
        let predicate = match slots {
            Some(slots) => slots
                .get(1)
                .copied()
                .flatten()
                .and_then(|index| args.get(index)),
            None => args.get(1),
        };
        let group = matches!(target, IrCallTarget::Builtin { id, .. } if id == "group");
        matches!(predicate, Some(TypedExpr { expr: IrExpr::Lambda { body, .. }, .. })
            if expr_uses_async(body) || self.implicit_expr_uses_async(body)
                || !group && (self.boolean_body || self.boolean_helper
                    || self.leave_decide_async_predicate(body.span)))
    }

    /// Installed reference readers and scoped collections can suspend a
    /// checked synchronous expression. Follow only work evaluated here;
    /// constructing a callback does not evaluate its body. In particular a
    /// pure Values grouping key must remain synchronous.
    fn implicit_expr_uses_async(&self, expression: &TypedExpr) -> bool {
        if !self.retained_owner_body && !self.boolean_body && !self.boolean_helper && !self.source_data_body { return false; }
        let mut pending = vec![expression];
        while let Some(value) = pending.pop() {
            match &value.expr {
                IrExpr::Member { base, field } => {
                    if self.source_data_body && matches!(base.ty,ResolvedType::Record{symbol,..}if
                        self.ir.items.iter().any(|item|item.name==*field&&matches!(item.kind,IrItemKind::DeriveField{model,..}if model==symbol))) {
                        return true;
                    }
                    if (self.boolean_body || self.retained_owner_body && field != "id") && self.is_model_reference(&base.ty) {
                        return true;
                    }
                    pending.push(base);
                }
                IrExpr::Call { target, args } => {
                    if self.async_scoped_predicate(target, args, None) { return true; }
                    pending.extend(args);
                }
                IrExpr::BoundCall { target, args, slots } => {
                    if self.async_scoped_predicate(target, args, Some(slots)) { return true; }
                    pending.extend(args);
                }
                IrExpr::Unary { operand, .. } => pending.push(operand),
                IrExpr::Binary { left, right, .. } => pending.extend([left.as_ref(), right.as_ref()]),
                IrExpr::Array(values) => pending.extend(values),
                IrExpr::Object(values) => pending.extend(values.iter().map(|(_, value)| value)),
                IrExpr::Query(query) => {
                    if let super::ir::IrQueryDomain::Value { base, .. } = &query.domain { pending.push(base); }
                    pending.extend(query.value_order.iter().map(|order| order.key.as_ref()));
                    pending.extend(query.parent.iter().map(|value| value.as_ref()));
                    pending.extend(query.where_pred.iter().map(|value| value.as_ref()));
                    pending.extend(query.limit.iter().map(|value| value.as_ref()));
                    pending.extend(query.archived.iter().map(|value| value.as_ref()));
                    pending.extend(query.select.iter().map(|value| value.as_ref()));
                }
                IrExpr::Message(message) => pending.extend(message.params.iter().map(|param| &param.value)),
                IrExpr::MessageCall { args, params, .. } => {
                    pending.extend(args);
                    pending.extend(params.iter().filter_map(|param| param.default.as_ref()));
                }
                IrExpr::Format { args, .. } => pending.extend(args),
                _ => {},
            }
        }
        false
    }

    fn leave_decide_async_predicate(&self, span: Span) -> bool {
        self.owner_handler_body && self.receipt_capture.as_ref()
            .and_then(|receipt|receipt.plan.leave_decide_decision.as_ref())
            .is_some_and(|decision| {
                let site=&decision["querySites"][1]["predicateSite"];
                site["start"].as_u64()==Some(span.start as u64)
                    && site["end"].as_u64()==Some(span.end as u64)
            })
    }

    /// Whether hook lowering is active.
    fn in_hook(&self) -> bool {
        self.hook.is_some()
    }

    /// Whether nested closures suspend inline transitive loads: inside
    /// hook lowering, and inside hook-variant helper bodies (where
    /// linkage reads lower through `c.transitive` at the top level only).
    fn hook_closure_tracked(&self) -> bool {
        self.in_hook() || self.hook_helper_links.is_some()
    }

    /// Whether hook lowering may consume the ambient operation context.
    /// Only native hooks receive `c`; legacy hooks fail these reads closed.
    fn hook_native(&self) -> bool {
        self.hook.as_ref().is_some_and(|hook| hook.native)
    }

    /// Hook-context gap: `what` needs the ambient operation context, which
    /// hooks never receive. Reports `E6008` and returns the throwing
    /// placeholder.
    fn hook_gap(&mut self, what: &str, why: &str, span: Span) -> String {
        self.unsupported(what, why, span);
        self.throw_expr(&format!("{what} has no lowering"))
    }

    /// Innermost hook-alias classification for a source name: `Some(Some)`
    /// is event-rooted, `Some(None)` shadows an outer alias with a plain
    /// value, `None` was never event-rooted.
    fn hook_alias_lookup(&self, name: &str) -> Option<Option<HookAlias>> {
        self.hook_aliases
            .iter()
            .rev()
            .find_map(|scope| scope.get(name).copied())
    }

    /// Classify an event-chain base inside hooks. Depth-1 snapshot reads
    /// and parent-linkage identities lower; anything through them is a
    /// traversal the engine cannot serve (identities carry `{model, id}`
    /// only, and hook snapshots resolve no reference content).
    fn hook_base_class(&self, expr: &TypedExpr) -> HookBase {
        match &expr.expr {
            IrExpr::Name(name) => {
                if name == "event" {
                    return HookBase::Event;
                }
                match self.hook_alias_lookup(name) {
                    Some(Some(HookAlias::Snapshot)) => HookBase::Snapshot,
                    Some(Some(HookAlias::Parent)) => HookBase::Parent,
                    Some(Some(HookAlias::Staged)) => HookBase::Staged,
                    Some(Some(HookAlias::Value)) | Some(None) | None => {
                        // Event-derived values and plain names expose no
                        // further event content; ordinary lowering owns them.
                        // A `Value` alias read deeper below still gaps.
                        if matches!(
                            self.hook_alias_lookup(name),
                            Some(Some(HookAlias::Value))
                        ) {
                            HookBase::Shallow
                        } else {
                            HookBase::Plain
                        }
                    }
                }
            }
            IrExpr::Member { base, field } => match self.hook_base_class(base) {
                HookBase::Event => {
                    if field == "after" || field == "before" {
                        HookBase::Root
                    } else {
                        HookBase::DeepRef
                    }
                }
                HookBase::Root | HookBase::Snapshot => {
                    if field == "parent" {
                        HookBase::Parent
                    } else {
                        HookBase::Shallow
                    }
                }
                HookBase::Parent => HookBase::DeepParent,
                HookBase::Staged => HookBase::DeepStaged,
                HookBase::Shallow | HookBase::DeepRef => HookBase::DeepRef,
                HookBase::DeepParent => HookBase::DeepParent,
                HookBase::DeepStaged => HookBase::DeepStaged,
                HookBase::Plain => HookBase::Plain,
            },
            _ => HookBase::Plain,
        }
    }

    /// Classify a hook `let` value for alias tracking. Snapshots and
    /// parent steps track; other event-derived values track as `Value` so
    /// deeper reads gap; everything else shadows with `None`.
    fn hook_alias_class(&self, value: &TypedExpr) -> Option<HookAlias> {
        if let IrExpr::Member { base, field } = &value.expr {
            if matches!(&base.expr, IrExpr::Name(name) if name == "event")
                && (field == "after" || field == "before")
            {
                return Some(HookAlias::Snapshot);
            }
            if field == "parent" {
                match self.hook_base_class(base) {
                    HookBase::Root | HookBase::Snapshot | HookBase::Parent => {
                        return Some(HookAlias::Parent);
                    }
                    _ => {}
                }
            }
            if matches!(
                self.hook_base_class(base),
                HookBase::Root | HookBase::Snapshot
            ) {
                return Some(HookAlias::Value);
            }
            return None;
        }
        if let IrExpr::Name(name) = &value.expr {
            return self.hook_alias_lookup(name).flatten();
        }
        None
    }

    /// Declared trigger parent for hook parent-content loads: the trigger
    /// model's `ChildOf` parent in the same module (the existing source
    /// correspondence `event_class` uses). `None` for top-level triggers.
    fn hook_parent_model(&self) -> Option<(SymbolId, String)> {
        let trigger = self.hook.as_ref()?.trigger;
        let trigger_item = self.ir.items.get(trigger.0 as usize)?;
        if trigger_item.id != trigger {
            return None;
        }
        let IrItemKind::Model {
            owner: IrOwner::ChildOf(parent),
            ..
        } = &trigger_item.kind
        else {
            return None;
        };
        let parent_item = self.ir.items.get(parent.0 as usize)?;
        if parent_item.id != *parent || parent_item.module != trigger_item.module {
            return None;
        }
        Some((*parent, parent_item.canonical.clone()))
    }

    /// Declared stored-reference link for direct snapshot reference reads
    /// (CAN18-v1 file 14 `Account.location` first shape): `base` is
    /// `event.after.<ref>` or `event.before.<ref>` (or the same through a
    /// snapshot alias), where `<ref>` is a declared singular stored
    /// reference field on the trigger model. Returns the reference field
    /// name plus the target model (symbol and canonical) for the
    /// transitive reference load. `None` for parent linkages, staged
    /// bindings, deeper chains and non-reference fields — those keep their
    /// existing classification.
    fn hook_reference_link(&self, base: &TypedExpr) -> Option<(String, SymbolId, String)> {
        let crate::codegen::ir::IrExpr::Member { base: root, field: ref_field } = &base.expr else {
            return None;
        };
        if !matches!(
            self.hook_base_class(root),
            HookBase::Root | HookBase::Snapshot
        ) {
            return None;
        }
        let trigger = self.hook.as_ref()?.trigger;
        // A trigger may carry several items with one field name across its
        // model/CRUD surfaces; take the declared singular stored reference
        // (not merely the first name/owner match) so CRUD inclusion never
        // shadows the model edge.
        let mut target_opt: Option<SymbolId> = None;
        for item in self.ir.items.iter() {
            if item.name != *ref_field {
                continue;
            }
            let IrItemKind::Field {
                owner,
                ty: IrType::Known(field_ty),
                ..
            } = &item.kind
            else {
                continue;
            };
            if *owner != trigger {
                continue;
            }
            match field_ty {
                ResolvedType::Record { symbol, stored: true } => {
                    target_opt = Some(*symbol);
                    break;
                }
                ResolvedType::Nullable(inner) => match &**inner {
                    ResolvedType::Record { symbol, stored: true } => {
                        target_opt = Some(*symbol);
                        break;
                    }
                    _ => continue,
                },
                _ => continue,
            }
        }
        let target = target_opt?;
        let target_item = self.ir.items.get(target.0 as usize)?;
        if target_item.id != target {
            return None;
        }
        Some((ref_field.clone(), target, target_item.canonical.clone()))
    }

    /// Whether `field` is a declared readable parent field for the
    /// transitive load: same declared-field correspondence as snapshots
    /// (leaf scalars, carried stored references, arrays thereof), never
    /// machine fields or reserved metadata. Conservative on enums (refuse)
    /// so profile/emission never diverge into a silent wrong value.
    fn hook_parent_field_allowed(
        &self,
        parent: SymbolId,
        field: &str,
        expr_ty: &ResolvedType,
    ) -> bool {
        if matches!(
            field,
            "id" | "model" | "version" | "parent" | "created" | "updated" | "createdBy" | "updatedBy" | "archivedAt"
        ) {
            return false;
        }
        let Some(parent_item) = self.ir.items.get(parent.0 as usize) else {
            return false;
        };
        if parent_item.id != parent {
            return false;
        };
        // Several items may share one field name across model/CRUD
        // surfaces; admit when ANY declared field with this name on the
        // model matches the read type and allowed shape (CRUD inclusion
        // never shadows the model edge).
        for item in self.ir.items.iter() {
            if item.name != field {
                continue;
            }
            let IrItemKind::Field {
                owner,
                ty: IrType::Known(field_ty),
                modifiers,
                ..
            } = &item.kind
            else {
                continue;
            };
            if *owner != parent {
                continue;
            }
            if modifiers.machine || field_ty != expr_ty {
                continue;
            }
            if self.hook_parent_value_allowed(field_ty) {
                return true;
            }
        }
        false
    }

    /// Readable parent value shapes: leaf scalars (nullable included),
    /// carried stored references and arrays thereof. Enums stay refused
    /// (loud) until their same-module correspondence is pinned.
    fn hook_parent_value_allowed(&self, ty: &ResolvedType) -> bool {
        match ty {
            ResolvedType::Scalar(
                crate::analysis::types::Scalar::Int
                | crate::analysis::types::Scalar::Text
                | crate::analysis::types::Scalar::Bool
                | crate::analysis::types::Scalar::User
                | crate::analysis::types::Scalar::Datetime
                | crate::analysis::types::Scalar::Date
                | crate::analysis::types::Scalar::Duration
                | crate::analysis::types::Scalar::Email
                | crate::analysis::types::Scalar::Timezone,
            ) => true,
            ResolvedType::Nullable(inner) => self.hook_parent_value_allowed(inner),
            ResolvedType::Record { symbol, stored } => {
                *stored
                    && self
                        .ir
                        .items
                        .get(symbol.0 as usize)
                        .is_some_and(|item| item.id == *symbol)
            }
            ResolvedType::Array { element, .. } => self.hook_parent_value_allowed(element),
            _ => false,
        }
    }

    /// Metadata belongs to the issued parent row; authored fields keep their
    /// separate declared-type correspondence and cannot shadow that metadata.
    fn hook_parent_read_allowed(&self, parent: SymbolId, field: &str, ty: &ResolvedType) -> bool {
        self.hook_parent_field_allowed(parent, field, ty)
            || field == "version" && *ty == ResolvedType::Scalar(crate::analysis::types::Scalar::Int)
                && !self.ir.items.iter().any(|item| item.name == "version"
                    && matches!(&item.kind, IrItemKind::Field { owner, .. } if *owner == parent))
    }

    fn hook_read_site(&self) -> &'static str {
        if self.hook_decision_depth > 0 { "decision" } else { "value" }
    }

    fn hook_parent_gap(
        &mut self,
        base: &TypedExpr,
        field: &str,
        span: Span,
        expr_ty: &ResolvedType,
    ) -> Option<String> {
        if field == "id" || field == "model" {
            None
        } else if self.hook_closure_depth > 0 {
            Some(self.hook_gap(
                "hook parent content",
                "parent field reads inside hook closures have no hook lowering",
                span,
            ))
        } else if let Some((parent, canonical)) = self.hook_parent_model()
            && self.hook_parent_read_allowed(parent, field, expr_ty)
        {
            // Consuming-site mode rides inside the scope object;
            // `transitive.load(scope,model,id)` arity and all
            // scope/fence/source checks are unchanged. Decisions
            // (hook firing/guard/decision expressions, including
            // `if` conditions; helpers inherit the site) open a
            // `'decision'` scope; body/value copies open `'value'`.
            // Denied/withheld/missing-required reads throw their
            // precise failure before value access; legitimate
            // nullable normalization (`?? null`, which never catches
            // thrown errors) keeps its meaning.
            let site = self.hook_read_site();
            let base_text = self.lower_expr(base);
            let base_text = parenthesize_operand(&base_text, &base.expr);
            let access = if object_key(field) == field {
                format!(".{field}")
            } else {
                format!("[{}]", js_string(field))
            };
            let result = if field == "version" {
                // State's exact provisional parent carrier owns this
                // metadata; it is not a readable data field or grant.
                "BigInt($hookRow.version)".to_string()
            } else { format!("$hookRow.data{access}") };
            let read = format!(
                "(await (async($hookParent)=>{{if($hookParent==null)throw new Error(\"hook parent content missing\");const $hookScope=await $hookCtx.transitive.openScope({});const $hookRow=await $hookCtx.transitive.load($hookScope,{},$hookParent.id);if($hookRow===null)throw new Error(\"hook parent content missing\");return {result};}})({base_text}))",
                js_string(site),
                js_string(&canonical),
            );
            if expr_ty.nullable_inner().is_some() {
                Some(format!("({read} ?? null)"))
            } else {
                Some(read)
            }
        } else {
            Some(self.hook_gap(
                "hook parent content",
                "parent linkage carries identity only (`{model, id}`); undeclared parent field reads have no hook lowering",
                span,
            ))
        }
    }

    /// Deep event-rooted chains (`event.after.parent…`, parent-anchored
    /// references, grandparent tails): resolve every step against declared
    /// models, then emit sequential transitive loads ending in a leaf or
    /// id read. Each load enrolls its row exactly like the single-level
    /// parent load, so per-row authority is unchanged; snapshots resolve
    /// linkage inline and never traverse reference content directly.
    /// Single-level reads keep their existing paths; anything
    /// unresolvable gaps loud with the usual parent-content diagnostic.
    fn hook_chain_gap(
        &mut self,
        base: &TypedExpr,
        field: &str,
        span: Span,
        expr_ty: &ResolvedType,
    ) -> String {
        const GAP_TITLE: &str = "hook parent content";
        const GAP_MESSAGE: &str = "parent linkage carries identity only (`{model, id}`); parent field reads need the transitive load and have no hook lowering";
        if self.hook_closure_depth > 0 {
            return self.hook_gap(
                "hook parent content",
                "parent field reads inside hook closures have no hook lowering",
                span,
            );
        }
        // Collect fields outermost-first, then walk root-outward. Only
        // field names are needed: models resolve symbolically from the
        // root, and emitted texts lower from the root name directly.
        let mut levels: Vec<String> = Vec::new();
        let mut cursor = base;
        loop {
            match &cursor.expr {
                IrExpr::Member {
                    base: inner,
                    field: inner_field,
                } => {
                    levels.push(inner_field.clone());
                    cursor = inner;
                }
                _ => break,
            }
        }
        if levels.len() > 8 {
            return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
        }
        let mut steps: Vec<String> = levels.into_iter().rev().collect();
        steps.push(field.to_string());
        // Resolve the chain root: `event.after|before` or a
        // snapshot/parent alias. Anything else stays refused.
        enum ChainRoot {
            Snapshot,
            Linkage,
        }
        let (text, model, kind) = match &cursor.expr {
            IrExpr::Name(name) if name == "event" => {
                let Some(first) = steps.first() else {
                    return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
                };
                if first != "after" && first != "before" {
                    return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
                }
                let Some(hook) = self.hook.as_ref() else {
                    return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
                };
                let Some(trigger_item) = self.ir.items.get(hook.trigger.0 as usize) else {
                    return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
                };
                if trigger_item.id != hook.trigger {
                    return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
                }
                let first = steps.remove(0);
                (format!("event.{first}"), trigger_item.id, ChainRoot::Snapshot)
            }
            IrExpr::Name(alias_name) => {
                let alias_class = self.hook_alias_lookup(alias_name);
                let ResolvedType::Record { symbol, stored: true } = &cursor.ty else {
                    return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
                };
                match alias_class {
                    Some(Some(HookAlias::Snapshot)) => {
                        (self.lower_expr(cursor), *symbol, ChainRoot::Snapshot)
                    }
                    Some(Some(HookAlias::Parent)) => {
                        (self.lower_expr(cursor), *symbol, ChainRoot::Linkage)
                    }
                    _ => return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span),
                }
            }
            _ => return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span),
        };
        // Validate each step against declared models and collect the
        // load plan: parent steps navigate ChildOf edges, reference
        // steps navigate declared stored references, and only the final
        // step may read a leaf (or id).
        enum Plan {
            Parent { canonical: String },
            Ref { field: String, canonical: String },
        }
        let mut plan: Vec<(String, Plan)> = Vec::new();
        let mut current = model;
        for (index, step_field) in steps.iter().enumerate() {
            let last = index + 1 == steps.len();
            if step_field == "parent" && !last {
                let Some(child_item) = self.ir.items.get(current.0 as usize) else {
                    return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
                };
                if child_item.id != current {
                    return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
                }
                let IrItemKind::Model {
                    owner: IrOwner::ChildOf(parent_symbol),
                    ..
                } = &child_item.kind
                else {
                    return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
                };
                let Some(parent_item) = self.ir.items.get(parent_symbol.0 as usize) else {
                    return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
                };
                if parent_item.id != *parent_symbol {
                    return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
                }
                plan.push((
                    step_field.clone(),
                    Plan::Parent {
                        canonical: parent_item.canonical.clone(),
                    },
                ));
                current = *parent_symbol;
                continue;
            }
            if last {
                break;
            }
            // Intermediate reference step: declared stored reference on
            // the current model.
            let mut target: Option<SymbolId> = None;
            for item in self.ir.items.iter() {
                if item.name != *step_field {
                    continue;
                }
                let IrItemKind::Field {
                    owner,
                    ty: IrType::Known(ty),
                    ..
                } = &item.kind
                else {
                    continue;
                };
                if *owner != current {
                    continue;
                }
                if let ResolvedType::Record { symbol, stored: true } = ty {
                    if self
                        .ir
                        .items
                        .get(symbol.0 as usize)
                        .is_some_and(|t| t.id == *symbol)
                    {
                        target = Some(*symbol);
                        break;
                    }
                }
            }
            let Some(target) = target else {
                return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
            };
            let Some(target_item) = self.ir.items.get(target.0 as usize) else {
                return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
            };
            if target_item.id != target {
                return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
            }
            plan.push((
                step_field.clone(),
                Plan::Ref {
                    field: step_field.clone(),
                    canonical: target_item.canonical.clone(),
                },
            ));
            current = target;
        }

        // Final step: linkage id or a declared leaf on the current model.
        let Some(final_field) = steps.last() else {
            return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
        };
        let leaf_ok = if final_field == "id" {
            true
        } else {
            match expr_ty {
                ResolvedType::Scalar(_) => {
                    self.hook_parent_field_allowed(current, final_field, expr_ty)
                }
                _ => false,
            }
        };
        if final_field == "version" || !leaf_ok {
            return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
        }
        // Emit one fenced scope with sequential loads. Every parent and
        // reference step enrolls its row exactly like the single-level
        // loads, so authority tracking is unchanged.
        let site = self.hook_read_site();
        let mut stmts: Vec<String> = Vec::new();
        stmts.push(
            "if($hookLink==null)throw new Error(\"hook parent content missing\");".to_string(),
        );
        stmts.push(format!(
            "const $hookScope=await $hookCtx.transitive.openScope({});",
            js_string(site)
        ));
        stmts.push("let $hookRow=null;".to_string());
        let mut link = "$hookLink".to_string();
        let mut cur_kind = match kind {
            ChainRoot::Snapshot => "snapshot",
            ChainRoot::Linkage => "linkage",
        };
        // A linkage root carries identity only, so load its row before
        // traversing further.
        if cur_kind == "linkage" {
            let Some(root_item) = self.ir.items.get(model.0 as usize) else {
                return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
            };
            if root_item.id != model {
                return self.hook_gap(GAP_TITLE, GAP_MESSAGE, span);
            }
            stmts.push(format!(
                "$hookRow=await $hookCtx.transitive.load($hookScope,{},$hookLink.id);if($hookRow===null)throw new Error(\"hook parent content missing\");",
                js_string(&root_item.canonical)
            ));
            link = "$hookRow".to_string();
            cur_kind = "row";
        }
        for (step_field, step_plan) in &plan {
            match step_plan {
                Plan::Parent { canonical } => {
                    let _ = step_field;
                    stmts.push(format!(
                        "let $hookParent={link}.parent;if($hookParent==null)throw new Error(\"hook parent content missing\");"
                    ));
                    stmts.push(format!(
                        "$hookRow=await $hookCtx.transitive.load($hookScope,{},$hookParent.id);if($hookRow===null)throw new Error(\"hook parent content missing\");",
                        js_string(canonical)
                    ));
                    link = "$hookRow".to_string();
                    cur_kind = "row";
                }
                Plan::Ref { field, canonical } => {
                    let ref_link = if cur_kind == "snapshot" {
                        format!("{link}.{field}")
                    } else {
                        format!("{link}.data.{field}")
                    };
                    stmts.push(format!(
                        "let $hookRef={ref_link};if($hookRef==null)throw new Error(\"hook reference content missing\");"
                    ));
                    stmts.push(format!(
                        "$hookRow=await $hookCtx.transitive.loadReference($hookScope,{},$hookRef.id);if($hookRow===null)throw new Error(\"hook reference content missing\");",
                        js_string(canonical)
                    ));
                    link = "$hookRow".to_string();
                    cur_kind = "row";
                }
            }
        }
        let access = if object_key(final_field) == *final_field {
            format!(".{final_field}")
        } else {
            format!("[{}]", js_string(final_field))
        };
        let tail = if final_field == "id" {
            format!("{link}.id")
        } else if cur_kind == "snapshot" {
            format!("{link}{access}")
        } else {
            format!("{link}.data{access}")
        };
        let tail = if expr_ty.nullable_inner().is_some() {
            format!("({tail} ?? null)")
        } else {
            tail
        };
        stmts.push(format!("return {tail};"));
        format!(
            "(await (async($hookLink)=>{{{}}}))({text})",
            stmts.join(""),
        )
    }

    /// Traversal guard for hook member reads. Returns the throwing
    /// placeholder (after reporting `E6008`) exactly when the read passes
    /// through event reference content, staged identities, nested closures
    /// or undeclared parent fields, which have no hook lowering. Depth-1
    /// snapshot reads, linkage identities, ordinary names and top-level
    /// declared parent fields (via the transitive parent load) lower as
    /// before; computed derive reads off the trigger snapshot fail closed
    /// (see `hook_derived_field_gap`).
    fn hook_member_gap(
        &mut self,
        base: &TypedExpr,
        field: &str,
        span: Span,
        expr_ty: &ResolvedType,
    ) -> Option<String> {
        // Contextual roots (`c.now`, `c.actor.email`, ...) exist only on
        // native runners, which receive the ambient invocation context.
        // Legacy hooks never receive `c`: gap loud with the usual
        // contextual-binding diagnostic instead of reading `undefined`.
        // The walk reaches through nested members so `c.actor.email`
        // names its contextual root, not the leaf.
        if self.in_hook() && !self.hook_native() {
            let mut root = base;
            let mut top = field;
            while let IrExpr::Member { base: next, field: inner } = &root.expr {
                top = inner;
                root = next;
            }
            if matches!(&root.expr, IrExpr::Name(name) if name == "c") {
                return Some(self.hook_gap(
                    &format!("hook contextual binding `{top}`"),
                    "no complete native owner-policy plan binds the hook context",
                    span,
                ));
            }
        }
        match self.hook_base_class(base) {
            HookBase::Event => {
                if field == "after" || field == "before" {
                    None
                } else {
                    Some(self.hook_gap(
                        "hook event traversal",
                        "the hook event exposes after/before only; deeper event paths need the transitive load and have no hook lowering",
                        span,
                    ))
                }
            }
            HookBase::Root | HookBase::Snapshot => self.hook_derived_field_gap(field, span),
            HookBase::Plain => None,
            HookBase::Parent => self.hook_parent_gap(base, field, span, expr_ty),
            HookBase::Staged => {
                if field == "id" {
                    None
                } else if self.hook_native()
                    && matches!(&base.expr, IrExpr::Name(name)
                        if self
                            .hook_staged_data
                            .get(name)
                            .is_some_and(|fields| fields.contains(field)))
                {
                    // The native stage call paired this alias with its
                    // supplied data, so the field reads exactly what the
                    // hook staged (evaluated once, shared with the call).
                    None
                } else {
                    Some(self.hook_gap(
                        "hook staged content",
                        "staged bindings carry identity only (`{id}`); staged field reads have no hook lowering",
                        span,
                    ))
                }
            }
            HookBase::Shallow => {
                if field == "id" || field == "model" {
                    None
                } else if self.hook_closure_depth > 0 {
                    Some(self.hook_gap(
                        "hook reference content",
                        "reference field reads inside hook closures have no hook lowering",
                        span,
                    ))
                } else if let Some((_ref_field, target, canonical)) = self.hook_reference_link(base)
                    && self.hook_parent_field_allowed(target, field, expr_ty)
                {
                    // CAN18-v1 direct snapshot reference reads (file 14
                    // `Account.location` first shape): same consuming-site
                    // mode/site/arity discipline as parent loads, through
                    // the defining State `loadReference` — never through
                    // `loadParent`'s ancestor fence. Decisions open
                    // `'decision'` scopes; body/value copies open `'value'`
                    // for the host caller projection. Denied/withheld/
                    // missing reads throw before value access; nullable
                    // normalization keeps its meaning.
                    let site = self.hook_read_site();
                    let base_text = self.lower_expr(base);
                    let base_text = parenthesize_operand(&base_text, &base.expr);
                    let access = if object_key(field) == field {
                        format!(".{field}")
                    } else {
                        format!("[{}]", js_string(field))
                    };
                    let read = format!(
                        "(await (async($hookRef)=>{{if($hookRef==null)throw new Error(\"hook reference content missing\");const $hookScope=await $hookCtx.transitive.openScope({});const $hookRow=await $hookCtx.transitive.loadReference($hookScope,{},$hookRef.id);if($hookRow===null)throw new Error(\"hook reference content missing\");return $hookRow.data{access};}})({base_text}))",
                        js_string(site),
                        js_string(&canonical),
                    );
                    if expr_ty.nullable_inner().is_some() {
                        Some(format!("({read} ?? null)"))
                    } else {
                        Some(read)
                    }
                } else {
                    Some(self.hook_gap(
                        "hook reference traversal",
                        "reads through event references need the transitive load and have no hook lowering",
                        span,
                    ))
                }
            }
            HookBase::DeepRef => Some(self.hook_gap(
                "hook reference traversal",
                "reads through event references need the transitive load and have no hook lowering",
                span,
            )),
            HookBase::DeepParent => Some(self.hook_chain_gap(base, field, span, expr_ty)),
            HookBase::DeepStaged => Some(self.hook_gap(
                "hook staged content",
                "staged bindings carry identity only (`{id}`); staged field reads have no hook lowering",
                span,
            )),
        }
    }

    /// Fail closed on computed derive reads off the trigger snapshot.
    /// `event.after`/`event.before` (and their snapshot aliases) carry
    /// only stored candidate data, so a checked model derive would read
    /// `undefined`. Keyed to the exact DeriveField owner+module+field
    /// identity: ordinary stored fields, `id`/`version` and metadata never
    /// match a DeriveField declaration and lower as before. Spelling alone
    /// never suffices: the derive must be owned by the trigger model and
    /// declared in the trigger model's module.
    fn hook_derived_field_gap(&mut self, field: &str, span: Span) -> Option<String> {
        let trigger = self.hook.as_ref()?.trigger;
        let model_item = self.ir.items.get(trigger.0 as usize)?;
        if model_item.id != trigger {
            return None;
        }
        let owned = self.ir.items.iter().any(|item| {
            item.name == field
                && item.module == model_item.module
                && matches!(&item.kind, IrItemKind::DeriveField { model, .. } if *model == trigger)
        });
        if !owned {
            return None;
        }
        Some(self.hook_gap(
            "hook derived field",
            "computed derives are not in the hook candidate snapshot; derive reads have no hook lowering",
            span,
        ))
    }

    /// Whether a call argument carries a hook parent linkage: the trigger's
    /// parent linkage inside hook lowering (aliases included), or a
    /// record-typed helper parameter inside hook-variant emission. The
    /// profile admits the strict subset (direct-parent model, checked
    /// body); anything it refused never reaches native emission, and any
    /// residual mismatch fails loud at the loader's containment bound —
    /// never a silent wrong row.
    fn hook_linkage_arg(&self, arg: &TypedExpr) -> bool {
        if let Some(links) = &self.hook_helper_links {
            if matches!(&arg.expr, IrExpr::Name(name) if links.contains_key(name)) {
                return true;
            }
        }
        if !self.in_hook() {
            return false;
        }
        if self.hook_base_class(arg) == HookBase::Parent {
            return true;
        }
        // CAN18-v1 reference linkages (file 14 `Account.location` first
        // shape): direct snapshot stored-reference edges carry the same
        // linkage meaning as parent linkages for helper selection —
        // identity only, with declared fields loading through the
        // reference loader at the inheriting site.
        if self.hook_base_class(arg) == HookBase::Shallow && self.hook_reference_link(arg).is_some() {
            return true;
        }
        false
    }

    /// Whether a call argument carries a hook REFERENCE linkage (distinct
    /// from a parent linkage): a direct snapshot stored-reference edge for
    /// the file-14 first shape. Used to select the reference loader for
    /// helper variants; parent linkages keep the parent loader.
    fn hook_reference_linkage_arg(&self, arg: &TypedExpr) -> bool {
        if let Some(links) = &self.hook_helper_links {
            // Inside helper bodies, linkage-ness is by param name alone;
            // the loader kind is decided at variant emission from the
            // selecting call sites (see `hook_variant_kind`). Here we only
            // classify hook-body call args.
            if matches!(&arg.expr, IrExpr::Name(name) if links.contains_key(name)) {
                return false;
            }
        }
        self.in_hook()
            && self.hook_base_class(arg) == HookBase::Shallow
            && self.hook_reference_link(arg).is_some()
    }

    /// Record-helper call shape for one derive target: pure (`AsIs`), the
    /// hook variant with its verbatim inherited-site expression (`Hook`),
    /// or a loud refusal (`Refuse`). Callers consult this only for derive
    /// targets inside native hooks (top-level linkage) or hook-variant
    /// bodies (nested linkage, site passed through as `$hookSite`).
    fn hook_derive_call(&self, target: &IrCallTarget, args: &[TypedExpr]) -> HookDerive {
        let helper = self.hook_helper_links.is_some();
        if !((self.in_hook() && self.hook_native()) || helper) {
            return HookDerive::AsIs;
        }
        let IrCallTarget::DeriveFn(canonical) = target else {
            return HookDerive::AsIs;
        };
        if !args.iter().any(|arg| self.hook_linkage_arg(arg)) {
            return HookDerive::AsIs;
        }
        // Linkage inside a nested closure has no async carrier: refuse
        // loud rather than reading `undefined` off the linkage object.
        if self.hook_closure_depth != 0 {
            return HookDerive::Refuse;
        }
        if helper {
            // Nested linkage inside a variant body inherits the outer
            // variant's loader kind (parent vs reference) via
            // `hook_helper_reference` at emission; the inner selection
            // carries that kind forward so each kind emits its own
            // loader variant.
            let is_reference = self.hook_helper_reference;
            let Some(variant) = self.derive_hook_variant(canonical, is_reference) else {
                return HookDerive::Refuse;
            };
            return HookDerive::Hook((variant, "$hookSite".to_string(), is_reference));
        }
        // Top-level hook-body call: classify parent vs reference linkages.
        // Mixed kinds in one call stay fail-closed — one emitted variant
        // never mixes loaders. The same helper reused across calls with
        // different kinds lowers one variant per kind (per-use selection).
        let has_parent = args.iter().any(|arg| {
            self.hook_helper_links.is_none()
                && self.in_hook()
                && self.hook_base_class(arg) == HookBase::Parent
        });
        let has_reference = args.iter().any(|arg| self.hook_reference_linkage_arg(arg));
        if has_parent && has_reference {
            return HookDerive::Refuse;
        }
        let is_reference = has_reference;
        let Some(variant) = self.derive_hook_variant(canonical, is_reference) else {
            return HookDerive::Refuse;
        };
        let site = if self.hook_decision_depth > 0 {
            "\"decision\""
        } else {
            "\"value\""
        };
        HookDerive::Hook((variant, site.to_string(), is_reference))
    }

    /// One stored-record parameter's hook linkage: source name plus the
    /// declared model (symbol and canonical for the transitive load).
    /// Shared exactly by call-site selection (`hook_derive_call`) and
    /// hook-variant emission below, so a selected variant is always
    /// emitted with the same linkage set.
    fn derive_hook_link(&self, param: SymbolId) -> Option<(String, SymbolId, String)> {
        let item = self.ir.items.get(param.0 as usize)?;
        if item.id != param {
            return None;
        }
        let IrItemKind::Param {
            ty: IrType::Known(ResolvedType::Record { symbol, stored: true }),
            ..
        } = &item.kind
        else {
            return None;
        };
        let model = self.ir.items.get(symbol.0 as usize)?;
        if model.id != *symbol {
            return None;
        }
        Some((item.name.clone(), *symbol, model.canonical.clone()))
    }

    /// Hook-variant name for one derive canonical plus loader kind, when it
    /// carries a stored-record parameter. Selection and emission share this
    /// predicate exactly: a selected (canonical, kind) pair is always
    /// emitted. Parent variants keep the existing `hook` domain; reference
    /// variants use the distinct `hookref` domain so one helper reused
    /// across both linkages emits one loader-correct variant per use, each
    /// inheriting its call-site decision/value site.
    fn derive_hook_variant(&self, canonical: &str, is_reference: bool) -> Option<String> {
        let index = self.by_canonical.get(canonical)?;
        let item = self.ir.items.get(*index)?;
        if item.canonical != *canonical {
            return None;
        }
        let IrItemKind::DeriveFn { params, .. } = &item.kind else {
            return None;
        };
        params
            .iter()
            .any(|id| self.derive_hook_link(*id).is_some())
            .then(|| {
                binding_ident(
                    if is_reference { "hookref" } else { "hook" },
                    &item.canonical,
                )
            })
    }

    /// Linkage reads inside hook-variant helper bodies (`loc.field` where
    /// `loc` is a record-typed parameter): identity (`.id`) lowers
    /// ordinarily; declared fields load through `c.transitive` at the
    /// inherited `$hookSite` (same declared-field correspondence and
    /// nullable normalization as inline loads, same arity and fence
    /// checks — only the context path differs, since module-scope helpers
    /// receive `c`, not `$hookCtx`). Parent variants use `load`; reference
    /// variants (file-14 first shape, see `hook_variant_reference`) use
    /// `loadReference` — never through the ancestor fence. Anything else
    /// (closures, undeclared fields) gaps loud with `E6008`.
    fn hook_helper_member(
        &mut self,
        base: &TypedExpr,
        field: &str,
        span: Span,
        expr_ty: &ResolvedType,
    ) -> Option<String> {
        let entry = self
            .hook_helper_links
            .as_ref()?
            .get(match &base.expr {
                IrExpr::Name(name) => name,
                _ => return None,
            })?
            .clone();
        if field == "id" {
            return None;
        }
        if self.hook_closure_depth > 0 {
            return Some(self.hook_gap(
                "hook helper linkage",
                "linkage field reads inside helper closures have no hook lowering",
                span,
            ));
        }
        let (model, canonical) = entry;
        if !self.hook_parent_field_allowed(model, field, expr_ty) {
            return Some(self.hook_gap(
                "hook helper linkage",
                "record helpers read only declared parent fields through the transitive load",
                span,
            ));
        }
        let link = self.reference(match &base.expr {
            IrExpr::Name(name) => name,
            _ => return None,
        });
        let access = if object_key(field) == field {
            format!(".{field}")
        } else {
            format!("[{}]", js_string(field))
        };
        let read = if self.hook_helper_reference {
            format!(
                "(await (async($hookLink)=>{{if($hookLink==null)throw new Error(\"hook reference content missing\");const $hookScope=await c.transitive.openScope($hookSite);const $hookRow=await c.transitive.loadReference($hookScope,{},$hookLink.id);if($hookRow===null)throw new Error(\"hook reference content missing\");return $hookRow.data{access};}})({link}))",
                js_string(&canonical),
            )
        } else {
            format!(
                "(await (async($hookLink)=>{{if($hookLink==null)throw new Error(\"hook parent content missing\");const $hookScope=await c.transitive.openScope($hookSite);const $hookRow=await c.transitive.load($hookScope,{},$hookLink.id);if($hookRow===null)throw new Error(\"hook parent content missing\");return $hookRow.data{access};}})({link}))",
                js_string(&canonical),
            )
        };
        if expr_ty.nullable_inner().is_some() {
            Some(format!("({read} ?? null)"))
        } else {
            Some(read)
        }
    }

    /// Test-only callers reuse the exact production registry functions, whose
    /// defaults and transitive helper references already close in the entry.
    pub(super) fn example_helper_lines(&self) -> Vec<String> {
        if self.derive_calls.is_empty() {
            return Vec::new();
        }
        let Some(entry) = pick_entrypoint(self.ir) else {
            return Vec::new();
        };
        let factory = binding_ident("t", "helperFactory");
        let registry = binding_ident("t", "helperRegistry");
        let path = format!("../{}", module_path(&self.ir.module(entry).name));
        let mut lines = vec![
            format!(
                "import {{ canApp as {factory} }} from {};",
                js_string(&path)
            ),
            format!("const {registry}={factory}();"),
        ];
        for canonical in &self.derive_calls {
            lines.push(format!(
                "const {}={registry}[{}];",
                binding_ident("s", canonical),
                js_string(canonical),
            ));
        }
        lines
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
        let mut lines = Vec::new();
        if self.checked_message {
            lines.push(format!(
                "function {}(source,variants,params,sourceLocale){{\n\
                 const canonical={}(sourceLocale);\n\
                 const descriptor={}(source,variants,params,canonical);\n\
                 if(descriptor?.sourceLocale!==canonical)throw new ValueError(\"invalid-construction\",\"message constructor must preserve checked source locale\");\n\
                 return descriptor;\n\
                 }}",
                binding_ident("h", "checked_message"),
                binding_ident("u", "normalizeTag"),
                binding_ident("u", "message")
            ));
        }
        if self.localized_format {
            lines.push(format!(
            "function {}(c,d,locale,schemas){{\n\
             if(typeof c?.formatting?.appDefault!==\"string\")throw new ValueError(\"invalid-construction\",\"message formatting requires checked selected-app scope\");\n\
             const timeZone=c.team===null?\"UTC\":c.team?.timezone;\n\
             if(typeof timeZone!==\"string\")throw new ValueError(\"invalid-construction\",\"message formatting requires admitted team timezone\");\n\
             if(typeof d!==\"object\"||d===null)throw new ValueError(\"invalid-construction\",\"message formatting requires a descriptor\");\n\
             const alternatives=[],seen=new Map();\n\
             for(const [source,signature] of schemas){{const sourceLang={}(source);const ordered=[...signature].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);const key=JSON.stringify([sourceLang,ordered.map(([name,canonical])=>[name,canonical])]);const mapping=JSON.stringify(ordered);if(seen.has(key)){{if(seen.get(key)!==mapping)throw new ValueError(\"invalid-construction\",\"ambiguous checked message signature\");continue;}}seen.set(key,mapping);alternatives.push([sourceLang,signature]);}}\n\
             const supplied=d.params===undefined?{{}}:d.params;\n\
             if(typeof supplied!==\"object\"||supplied===null||Array.isArray(supplied))throw new ValueError(\"invalid-construction\",\"message parameters differ from checked signature\");\n\
             const entries=Object.getOwnPropertyDescriptors(supplied),names=Reflect.ownKeys(entries);\n\
             const matched=alternatives.find(([sourceLang,signature])=>sourceLang===d.sourceLocale&&names.length===signature.length&&signature.every(([name,canonical])=>{{const entry=entries[name];if(!Object.hasOwn(entries,name)||!Object.hasOwn(entry,\"value\")||typeof entry.value!==\"object\"||entry.value===null)return false;const type=Object.getOwnPropertyDescriptor(entry.value,\"type\");return type!==undefined&&Object.hasOwn(type,\"value\")&&type.value===canonical;}}));\n\
             if(matched===undefined)throw new ValueError(\"invalid-construction\",\"message parameters differ from checked signature\");\n\
             const [sourceLang,signature]=matched;\n\
             const params=Object.create(null);\n\
             for(const [name,,type] of signature){{const value=Object.getOwnPropertyDescriptor(entries[name].value,\"value\");if(value===undefined||!Object.hasOwn(value,\"value\"))throw new ValueError(\"invalid-construction\",\"message parameter differs from checked signature: \"+name);params[name]={{type,value:value.value}};}}\n\
             return format(makeMessageDescriptor(d.source,d.variants,signature.length?params:undefined),{{locale,appDefault:c.formatting.appDefault,sourceLang,timeZone}});\n\
             }}",
            binding_ident("h", "localized_format"),
            binding_ident("u", "normalizeTag")
            ));
        }
        lines
    }

    /// Preserve a checked bounded alias while keeping the ordinary wrappers.
    fn symbol_value_type_id(&mut self, symbol: SymbolId, ty: &ResolvedType, span: Span) -> String {
        fn alias_type(ty: &ResolvedType, alias: &str) -> String {
            match ty {
                ResolvedType::Nullable(inner) => format!("{}?", alias_type(inner, alias)),
                ResolvedType::Array { element, .. } => format!("{}[]", alias_type(element, alias)),
                _ => alias.to_string(),
            }
        }
        if let Some(alias) = self
            .ir
            .value_constraints
            .get(&symbol)
            .and_then(|constraints| constraints.alias)
        {
            return alias_type(ty, &self.ir.items[alias.0 as usize].canonical);
        }
        self.canonical_type_id(ty, span)
    }

    /// Canonical type id for a resolved type (`int`, `user?`, `text[]`,
    /// `expense.Expense.status`, ...). A scalar field resolves to its scalar
    /// type, never a field-specific nominal; nullable/array shape is kept.
    fn std_delivery_type_id(
        &mut self,
        capability: &str,
        op: &crate::analysis::catalog::StdOperation,
        span: Span,
    ) -> String {
        if delivery_descriptor(capability, op).is_some() {
            format!("delivery({capability}.{})", op.name)
        } else {
            self.unsupported("type", "std delivery has no owning descriptor", span);
            self.throw_expr("std delivery type id")
        }
    }

    fn std_nominal_type_id(&mut self, ty: &ResolvedType, span: Span) -> String {
        if let Some(name) = crate::analysis::types::checked_standard_nominal_name(ty) {
            name.to_string()
        } else {
            self.unsupported("type", "standard nominal has no exact owning schema", span);
            self.throw_expr("standard nominal type id")
        }
    }

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
            ResolvedType::Enum { owner: None, cases } => format!("enum({})", cases.join(",")),
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
            ResolvedType::StdDelivery { capability, op } => {
                self.std_delivery_type_id(capability, op, span)
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
            ResolvedType::StdNominal { .. } => self.std_nominal_type_id(ty, span),
            ResolvedType::Object(_) => {
                self.unsupported("type", "object values have no §13 type id", span);
                self.throw_expr("object type id")
            }
            ResolvedType::InlineMessage => {
                self.unsupported(
                    "type",
                    "anonymous descriptors have no business type id",
                    span,
                );
                self.throw_expr("anonymous descriptor type id")
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
            ResolvedType::StdNominal { .. } if self.nominal_value_type(element).is_some() => {
                format!(
                    "type:{}",
                    js_string(&self.nominal_value_type(element).unwrap())
                )
            }
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
        // Static Judgment enums are named types derived by the owning
        // descriptor; fields reference that identity instead of copying cases.
        if self.judgment_enum_type(ty) {
            let mut id = self.canonical_type_id(ty, span);
            if required_array && matches!(ty, ResolvedType::Array { .. }) {
                id.push('!');
            }
            return format!("type:{}", js_string(&id));
        }
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
            ResolvedType::StdNominal { .. } if self.nominal_value_type(ty).is_some() => {
                format!("type:{}", js_string(&self.nominal_value_type(ty).unwrap()))
            }
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
            ResolvedType::StdDelivery { capability, op } => {
                if delivery_descriptor(capability, op).is_some() {
                    format!(
                        "type:\"delivery\",operation:{}",
                        js_string(&format!("{capability}.{}", op.name))
                    )
                } else {
                    self.unsupported(
                        "field schema",
                        "std delivery has no owning descriptor",
                        span,
                    );
                    "type:\"unknown\"".to_string()
                }
            }

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

    fn judgment_enum_type(&self, ty: &ResolvedType) -> bool {
        match ty {
            ResolvedType::Enum {
                owner: Some(id), ..
            } => self
                .ir
                .items
                .get(id.0 as usize)
                .is_some_and(|item| matches!(item.kind, IrItemKind::JudgmentGenerated(_))),
            ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } => {
                self.judgment_enum_type(inner)
            }
            _ => false,
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
    fn receipt_site(&self, span: Span) -> super::scenario_receipts::NativeSite {
        super::scenario_receipts::NativeSite {
            calls: self.receipt_calls.clone(),
            span,
            default_selection: false,
        }
    }

    fn receipt_decision(&self, span: Span) -> bool {
        self.receipt_capture
            .as_ref()
            .is_some_and(|recipe| recipe.decisions.contains_key(&self.receipt_site(span)))
    }

    fn receipt_choice(&self, span: Span, choice: &str) -> String {
        self.receipt_choice_at(self.receipt_site(span), choice)
    }

    fn receipt_choice_at(
        &self,
        site: super::scenario_receipts::NativeSite,
        choice: &str,
    ) -> String {
        if !self
            .receipt_capture
            .as_ref()
            .is_some_and(|recipe| recipe.decisions.contains_key(&site))
        {
            return String::new();
        }
        let Some(key) = self
            .receipt_capture
            .as_ref()
            .and_then(|recipe| recipe.decision_keys.get(&site))
        else {
            return String::new();
        };
        format!(
            "$receiptChoices.set({},{});",
            js_string(key),
            js_string(choice),
        )
    }

    fn receipt_binary_template(&self, op: IrBinOp, span: Span, original: String) -> String {
        let test = match op {
            IrBinOp::And => "$receiptLeft".to_string(),
            IrBinOp::Or => "!$receiptLeft".to_string(),
            IrBinOp::Coalesce => "$receiptLeft===null||$receiptLeft===undefined".to_string(),
            _ => return original,
        };
        let selected = self.receipt_choice(span, "rhs-evaluated");
        let skipped = self.receipt_choice(span, "rhs-skipped");
        format!(
            "(await (async()=>{{const $receiptLeft={BINARY_LEFT};if({test}){{{selected}return {BINARY_RIGHT};}}{skipped}return $receiptLeft;}})())"
        )
    }

    fn admitted_query_source(&self, owner: SymbolId) -> Option<NativeQuerySource> {
        let source = self.native_query_sources.get(&owner)?;
        // collect_operations and call correspondence can withdraw a recipe
        // after source collection. Check the final admitted capture, including
        // every query field and projection, rather than an occurrence ID alone.
        let plan = serde_json::to_value(&self.receipt_capture.as_ref()?.plan).ok()?;
        if plan.get("source") != source.plan.get("source")
            || plan.get("queries") != source.plan.get("queries")
        {
            return None;
        }
        let projected = source.plan.get("returns")?.as_array()?.first()?;
        if !plan.get("returns")?.as_array()?.iter().any(|returned| {
            ["id", "source", "influences", "projection"]
                .iter()
                .all(|key| returned.get(*key) == projected.get(*key))
        }) {
            return None;
        }
        let mut admitted = source.clone();
        // The final collector owns ordinary observations. Query preparation
        // contributes only its domain/influences and cannot replace that plan.
        admitted.plan = plan;
        Some(admitted)
    }

    fn receipt_return_selection(
        &mut self,
        span: Span,
        implicit: bool,
        model_result: bool,
    ) -> Option<String> {
        use crate::analysis::scenario_disclosure::DisclosureChoice;
        let returns: Vec<_> = self
            .receipt_capture
            .as_ref()?
            .returns
            .iter()
            .filter(|returned| returned.implicit == implicit && (implicit || returned.span == span))
            .cloned()
            .collect();
        if returns.is_empty() {
            return None;
        }
        self.stdlib
            .insert("selectScenarioReceiptReturn".to_string());
        let mut selection = "const $receiptReturns=[];".to_string();
        for returned in &returns {
            let tests = returned
                .decisions
                .iter()
                .map(|(anchor, choice)| {
                    let choice = match choice {
                        DisclosureChoice::Then => "then",
                        DisclosureChoice::Else => "else",
                        DisclosureChoice::RhsEvaluated => "rhs-evaluated",
                        DisclosureChoice::RhsSkipped => "rhs-skipped",
                        DisclosureChoice::DefaultEvaluated => "default-evaluated",
                        DisclosureChoice::DefaultProvided => "default-provided",
                        DisclosureChoice::Match(case) => case,
                    };
                    format!(
                        "$receiptChoices.get({})==={}",
                        js_string(anchor),
                        js_string(choice),
                    )
                })
                .collect::<Vec<_>>();
            let condition = if tests.is_empty() {
                "true".to_string()
            } else {
                tests.join("&&")
            };
            selection.push_str(&format!(
                "if({condition}){{$receiptReturns.push({});}}",
                js_string(&returned.id),
            ));
        }
        selection.push_str("if($receiptReturns.length!==1){throw new Error('Scenario return capture is incomplete or ambiguous');}");
        if model_result {
            // The existing native frame captures the genuine once-evaluated
            // owning view. Bind before selection, and return its canonical wire.
            self.stdlib.insert("bindScenarioReceiptModelResult".into());
            if returns
                .iter()
                .any(|returned| returned.reference_result.is_some())
            {
                self.stdlib
                    .insert("readScenarioReceiptStoredReference".into());
                self.stdlib
                    .insert("observeScenarioReceiptDependency".into());
                selection.push_str("let $receiptModelView=$receiptValue;");
                for returned in &returns {
                    if let Some(read) = &returned.reference_result {
                        selection.push_str(&format!(
                            "if($receiptReturns[0]==={}){{",
                            js_string(&returned.id)
                        ));
                        if let Some(source) = &read.source_dependency_id {
                            selection.push_str(&format!(
                                "$receiptModelView=await readScenarioReceiptStoredReference(c,$receiptValue,{},{});",
                                js_string(source), js_string(&read.id),
                            ));
                        }
                        selection.push_str(&format!(
                            "await observeScenarioReceiptDependency(c,{},$receiptModelView,\"id\",{});}}",
                            js_string(&read.model), js_string(&read.id),
                        ));
                    }
                }
                selection.push_str("const $receiptModelResult=await bindScenarioReceiptModelResult(c,$receiptReturns[0],$receiptModelView);");
            } else {
                selection.push_str("const $receiptModelResult=await bindScenarioReceiptModelResult(c,$receiptReturns[0],$receiptValue);");
            }
        }
        selection.push_str("selectScenarioReceiptReturn(c,$receiptReturns[0]);");
        Some(selection)
    }

    fn lower_current_policy_member(&mut self, expr: &TypedExpr) -> Option<String> {
        use super::model_policy_profile::CurrentRevisionRuleKind;
        let profile = self.current_policy_rule.as_ref()?;
        let CurrentRevisionRuleKind::Template { revision, .. } = profile.kind else {
            return None;
        };
        let IrExpr::Member { base, field } = &expr.expr else {
            return None;
        };
        if !matches!(field.as_str(), "parent" | "published") {
            return None;
        }
        let IrExpr::Member {
            base: row,
            field: current,
        } = &base.expr
        else {
            return None;
        };
        if current != "current"
            || !matches!(&row.expr, IrExpr::Name(name) if name == "row")
            || row.ty
                != (ResolvedType::Record {
                    symbol: profile.origin.model,
                    stored: true,
                })
            || base.ty
                != ResolvedType::Nullable(Box::new(ResolvedType::Record {
                    symbol: revision,
                    stored: true,
                }))
        {
            return None;
        }
        let source = self.lower_expr(base);
        Some(format!(
            "(await $readCurrent({source}))[{}]",
            js_string(field)
        ))
    }

    fn lower_published_revision_view(
        &mut self,
        base: &TypedExpr,
        field: &str,
        current: &super::scenario_receipts::NativeCurrentRevision,
    ) -> Option<String> {
        let IrExpr::Member {
            base: source,
            field: source_field,
        } = &base.expr
        else {
            return None;
        };
        if field != "published"
            || source_field != "current"
            || base.span != current.published_source
            || !matches!(&source.expr, IrExpr::Name(name) if name == &current.parameter)
        {
            return None;
        }
        let source = self.lower_expr(source);
        self.stdlib
            .insert("observeScenarioReceiptDependency".into());
        self.stdlib
            .insert("readScenarioReceiptNullableStoredReference".into());
        Some(format!(
            "(await (async($receiptSource)=>{{const $receiptReference=($receiptSource[\"current\"]??null);await observeScenarioReceiptDependency(c,{},$receiptSource,\"current\",{});const $receiptRow=await readScenarioReceiptNullableStoredReference(c,$receiptSource,$receiptReference,{},{});const $receiptValue=$receiptRow[\"published\"];await observeScenarioReceiptDependency(c,{},$receiptRow,\"published\",{});return $receiptValue;}})({source}))",
            js_string(&current.template),
            js_string(&current.published_source_id),
            js_string(&current.published_source_id),
            js_string(&current.published_id),
            js_string(&current.revision),
            js_string(&current.published_id),
        ))
    }

    fn lower_current_revision_expr(&mut self, expr: &TypedExpr) -> Option<String> {
        if !self.receipt_calls.is_empty() {
            return None;
        }
        let current = self.receipt_capture.as_ref()?.current_revision.clone()?;
        if let IrExpr::Name(name) = &expr.expr
            && self.current_revision_binding.as_deref() == Some(self.reference(name).as_str())
        {
            return Some("$receiptCurrentView".into());
        }
        let IrExpr::Member { base, field } = &expr.expr else {
            return None;
        };
        if expr.span == current.published {
            return self.lower_published_revision_view(base, field, &current);
        }
        let (expected_field, dependency, promote, source_data) =
            if expr.span == current.digest_control {
                ("digest", &current.digest_control_id, true, false)
            } else if expr.span == current.digest_data {
                ("digest", &current.digest_data_id, false, true)
            } else if expr.span == current.outputs {
                ("outputs", &current.outputs_id, false, false)
            } else if expr.span == current.duration {
                ("duration", &current.duration_id, false, false)
            } else {
                return None;
            };
        let IrExpr::Name(name) = &base.expr else {
            return None;
        };
        let binding = self.current_revision_binding.as_ref()?.clone();
        if field != expected_field || self.reference(name) != binding {
            return None;
        }
        self.stdlib
            .insert("observeScenarioReceiptDependency".into());
        let prefix = if promote {
            self.stdlib
                .insert("readScenarioReceiptNullableStoredReference".into());
            format!(
                "if($receiptCurrentView===undefined){{$receiptCurrentView=await readScenarioReceiptNullableStoredReference(c,$receiptCurrentSource,{binding},{},{});}}",
                js_string(&current.retained_control_id),
                js_string(&current.digest_control_id)
            )
        } else {
            "if($receiptCurrentView===undefined){throw new Error('Original current view was not promoted at its digest guard');}".into()
        };
        let source_data = if source_data {
            format!(
                "if(!$receiptCurrentData){{await observeScenarioReceiptDependency(c,{},$receiptCurrentSource,\"current\",{});$receiptCurrentData=true;}}",
                js_string(&current.template),
                js_string(&current.retained_data_id)
            )
        } else {
            String::new()
        };
        let getter = if expr.ty.nullable_inner().is_some() {
            format!("($receiptCurrentView[{}]??null)", js_string(field))
        } else {
            format!("$receiptCurrentView[{}]", js_string(field))
        };
        Some(format!(
            "(await (async()=>{{{prefix}{source_data}const $receiptValue={getter};await observeScenarioReceiptDependency(c,{},$receiptCurrentView,{},{});return $receiptValue;}})())",
            js_string(&current.revision),
            js_string(field),
            js_string(dependency)
        ))
    }

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
        if let Some(lowered) = self.lower_current_policy_member(expr) {
            return lowered;
        }
        if let Some(lowered) = self.lower_current_revision_expr(expr) {
            return lowered;
        }
        if let IrExpr::Member { base, field } = &expr.expr
            && let Some(dependency) = self.query_capture.as_ref().and_then(|source| {
                source
                    .queries
                    .iter()
                    .flat_map(|query| &query.dependencies)
                    .chain(
                        source
                            .transcripts
                            .iter()
                            .flat_map(|fact| &fact.query_dependencies),
                    )
                    .find(|dependency| {
                        dependency.node.file == span.file
                            && dependency.node.start == span.start
                            && dependency.node.end == span.end
                            && dependency.field_name == *field
                            && dependency
                                .calls
                                .iter()
                                .map(|call| Span::new(call.file, call.start, call.end))
                                .eq(self.receipt_calls.iter().copied())
                    })
                    .cloned()
            })
        {
            self.stdlib
                .insert("observeScenarioReceiptQueryDependency".into());
            let receiver = self.lower_expr(base);
            let value = if expr.ty.nullable_inner().is_some() {
                format!("($queryRow[{}]??null)", js_string(field))
            } else {
                format!("$queryRow[{}]", js_string(field))
            };
            // Observe immediately after the one original protected read. A
            // synchronous bridge preserves lazy predicates and evaluation order.
            return format!(
                "(($queryRow)=>{{const $queryValue={value};observeScenarioReceiptQueryDependency(c,{},$queryRow,{},{});return $queryValue;}})({receiver})",
                js_string(&dependency.model_name),
                js_string(field),
                js_string(&dependency.id)
            );
        }
        if let IrExpr::Name(name) = &expr.expr
            && let Some(intrinsics) = self
                .receipt_capture
                .as_ref()
                .and_then(|recipe| recipe.intrinsics.get(&self.receipt_site(span)))
                .cloned()
        {
            self.stdlib
                .insert("observeScenarioReceiptIntrinsic".to_string());
            let value = self.reference(name);
            let observations = intrinsics
                .iter()
                .map(|intrinsic| {
                    format!(
                        "await observeScenarioReceiptIntrinsic(c,{},\"admitted-input\",$receiptValue);",
                        js_string(&intrinsic.id),
                    )
                })
                .collect::<String>();
            return format!(
                "(await (async($receiptValue)=>{{{observations}return $receiptValue;}})({value}))"
            );
        }
        if let IrExpr::Member { base, field } = &expr.expr
            && let Some(intrinsics) = self
                .receipt_capture
                .as_ref()
                .and_then(|recipe| recipe.intrinsics.get(&self.receipt_site(span)))
                .cloned()
        {
            self.stdlib
                .insert("observeScenarioReceiptIntrinsic".to_string());
            let receiver = self.lower_expr(base);
            let field_key = js_string(field);
            let observations = intrinsics
                .iter()
                .map(|intrinsic| {
                    let (kind, reference) = match &intrinsic.kind {
                        super::scenario_receipts::NativeIntrinsicKind::OperationId => {
                            ("operation-id", "")
                        }
                        super::scenario_receipts::NativeIntrinsicKind::AdmittedInput { .. } => {
                            ("admitted-input", "")
                        }
                        super::scenario_receipts::NativeIntrinsicKind::AdmittedReferenceVersion {
                            ..
                        } => ("admitted-reference-version", ",$receiptIntrinsic"),
                    };
                    format!(
                        "await observeScenarioReceiptIntrinsic(c,{},{},$receiptValue{reference});",
                        js_string(&intrinsic.id),
                        js_string(kind),
                    )
                })
                .collect::<String>();
            return format!(
                "(await (async($receiptIntrinsic)=>{{const $receiptValue=$receiptIntrinsic[{field_key}];{observations}return $receiptValue;}})({receiver}))"
            );
        }
        if let IrExpr::Member { base, field } = &expr.expr
            && let Some(dependencies) = self
                .receipt_capture
                .as_ref()
                .and_then(|recipe| recipe.dependencies.get(&self.receipt_site(span)))
                .cloned()
        {
            self.stdlib
                .insert("observeScenarioReceiptDependency".to_string());
            let parent_query = self.query_capture.as_ref().and_then(|capture| {
                let [ordinary] = dependencies.as_slice() else {
                    return None;
                };
                capture.queries.iter().find_map(|query| {
                    let count = query.count.as_ref()?;
                    let [first, candidate, _] = count.parent_edges.as_slice() else {
                        return None;
                    };
                    let first_read = query
                        .dependencies
                        .iter()
                        .find(|read| read.node == first.node)?;
                    (field == "parent"
                        && count.contained_parent.is_none()
                        && span.file == candidate.node.file
                        && span.start == candidate.node.start
                        && span.end == candidate.node.end
                        && base.span.file == first.node.file
                        && base.span.start == first.node.start
                        && base.span.end == first.node.end
                        && first_read.field_name == "parent"
                        && first_read.model == query.model
                        && capture.plan["returns"].as_array()?.iter().any(|returned| {
                            returned["dependencies"].as_array().is_some_and(|reads| {
                                reads.iter().any(|read| {
                                    read["id"] == ordinary.id && read["queryId"] == query.id
                                })
                            })
                        }))
                    .then(|| {
                        (
                            query.model_name.clone(),
                            first_read.id.clone(),
                            ordinary.id.clone(),
                        )
                    })
                })
            });
            let receiver = if let Some((model, first_id, parent_id)) = parent_query {
                let IrExpr::Member {
                    base: row,
                    field: first_field,
                } = &base.expr
                else {
                    return self.throw_expr("Original query parent receiver is missing");
                };
                if first_field != "parent" {
                    return self.throw_expr("Original query parent field is missing");
                }
                self.stdlib
                    .insert("observeScenarioReceiptQueryDependency".into());
                self.stdlib.insert("readScenarioReceiptQueryParent".into());
                let row = self.lower_expr(row);
                // The authored first-hop getter and its immediate marker run
                // before the genuine parent bridge. Only the active issued row
                // enters the bridge; the ordinary second hop stays below at
                // its source position, with no hoisted or invented observation.
                format!(
                    "(await (async($queryCandidate)=>{{const $queryParentReference=$queryCandidate[\"parent\"];observeScenarioReceiptQueryDependency(c,{},$queryCandidate,\"parent\",{});return await readScenarioReceiptQueryParent(c,$queryCandidate,{});}})({row}))",
                    js_string(&model),
                    js_string(&first_id),
                    js_string(&parent_id)
                )
            } else {
                self.lower_expr(base)
            };
            let receiver = if dependencies
                .iter()
                .any(|read| read.source_dependency_id.is_some())
            {
                let last_source = self
                    .receipt_capture
                    .as_ref()
                    .and_then(|recipe| recipe.dependencies.get(&self.receipt_site(base.span)))
                    .and_then(|reads| reads.last())
                    .map(|read| read.id.as_str());
                let Some(scalar) = dependencies
                    .iter()
                    .find(|read| read.source_dependency_id.as_deref() == last_source)
                else {
                    return self.throw_expr("Original stored scalar source observation is missing");
                };
                if dependencies.iter().any(|read| {
                    read.source_dependency_id.is_none()
                        || read.model != scalar.model
                        || read.field != scalar.field
                }) {
                    return self
                        .throw_expr("Original stored scalar pairs differ from their one getter");
                }
                let Some(source_id) = &scalar.source_dependency_id else {
                    return self.throw_expr("Original stored scalar source is missing");
                };
                let nullable_source = self.receipt_capture.as_ref().is_some_and(|recipe| {
                    recipe.plan.returns.iter().flat_map(|returned| &returned.dependencies)
                        .any(|read| read.id == *source_id && read.type_id == format!("{}?", scalar.model))
                });
                if nullable_source {
                    let IrExpr::Member { base: source_view, .. } = &base.expr else {
                        return self.throw_expr("Original nullable reference source is missing");
                    };
                    self.stdlib.insert("readScenarioReceiptNullableStoredReference".into());
                    let source_view = self.lower_expr(source_view);
                    format!(
                        "(await readScenarioReceiptNullableStoredReference(c,{source_view},{receiver},{},{}))",
                        js_string(source_id), js_string(&scalar.id)
                    )
                } else {
                    self.stdlib.insert("readScenarioReceiptStoredReference".into());
                    // Recursive lowering has already read the original reference
                    // once and awaited its source marker. Promote that same value
                    // before the one scalar getter and awaited marker below.
                    format!(
                        "(await readScenarioReceiptStoredReference(c,{receiver},{},{}))",
                        js_string(source_id), js_string(&scalar.id)
                    )
                }
            } else {
                receiver
            };
            let field_key = js_string(field);
            let value = if expr.ty.nullable_inner().is_some() {
                format!("($receiptRow[{field_key}]??null)")
            } else {
                format!("$receiptRow[{field_key}]")
            };
            let observations = dependencies
                .iter()
                .map(|dependency| {
                    format!(
                        "await observeScenarioReceiptDependency(c,{},$receiptRow,{},{});",
                        js_string(&dependency.model),
                        js_string(&dependency.field),
                        js_string(&dependency.id),
                    )
                })
                .collect::<String>();
            let absent = if matches!(&base.ty,ResolvedType::Nullable(inner)
                if matches!(inner.as_ref(),ResolvedType::Record{stored:true,..})) {
                // The checked optional FIRST scalar consumer has no getter
                // or DATA observation on its genuine absent-row branch.
                "if($receiptRow==null)return null;"
            }else{""};
            return format!(
                "(await (async($receiptRow)=>{{{absent}const $receiptValue={value};{observations}return $receiptValue;}})({receiver}))"
            );
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
            IrExpr::Name(name) => {
                if name == "row"
                    && self.record_page_render
                    && !self.bindings.iter().any(|scope| scope.contains_key(name))
                {
                    self.unsupported(
                        "record-route render",
                        "authorized route row render binding is unavailable",
                        span,
                    );
                    self.throw_expr("unsupported route row render binding")
                } else {
                    self.reference(name)
                }
            }
            IrExpr::JudgmentSpecification { judgment, options } => {
                if self.in_hook() {
                    return self.hook_gap(
                        "judgment specification",
                        "the pinned invocation declaration is unavailable in this hook",
                        span,
                    );
                }
                self.stdlib.insert("judgmentSpecification".to_string());
                let options = options.as_ref().map_or_else(String::new, |options| {
                    format!(",{}", self.lower_expr(options))
                });
                format!("judgmentSpecification(c,{}{options})", js_string(judgment))
            }
            IrExpr::Member { base, field } => {
                // `group` takes a synchronous key function. The exact leave
                // owner receipt proves Day.year is date_year(row.date), so
                // inline that pure checked body at its original loop site.
                // The ordinary owner-derived-field path below awaits a
                // helper, which is invalid inside this synchronous key.
                if self.owner_handler_body
                    && field == "year"
                    && matches!(&base.expr, IrExpr::Name(name) if name == "day")
                    && matches!(&base.ty, ResolvedType::Record {symbol,stored:true}
                        if self.ir.items.get(symbol.0 as usize)
                            .is_some_and(|item|item.canonical=="leave.Day"))
                    && self.receipt_capture.as_ref().and_then(|receipt|
                        receipt.plan.leave_request_decision.as_ref())
                        .is_some_and(|decision| {
                            let node=&decision["sites"]["yearLoop"]["node"];
                            node["start"].as_u64().is_some_and(|start|start<=span.start as u64)
                                && node["end"].as_u64().is_some_and(|end|span.end as u64<=end)
                        })
                {
                    self.stdlib.insert("date_year".into());
                    let row=self.lower_expr(base);
                    return format!("date_year({row}.date)");
                }
                // A source-owned guard or checked owner rule consumes a derived
                // scalar's original body under the same current-row observer. No stored
                // value is fabricated and no standalone read transaction opens.
                let leave_nullable_allowance = self.owner_handler_body
                    && field=="remaining"
                    && self.receipt_capture.as_ref()
                        .and_then(|receipt|receipt.plan.leave_decide_decision.as_ref())
                        .is_some_and(|decision| {
                            decision["sites"]["portionRequire"]["node"]["start"].as_u64()
                                .is_some_and(|start|start<=span.start as u64)
                            && decision["sites"]["portionRequire"]["node"]["end"].as_u64()
                                .is_some_and(|end|span.end as u64<=end)
                        });
                let derived_model=match &base.ty {
                    ResolvedType::Record{symbol,stored:true}=>Some(*symbol),
                    ResolvedType::Nullable(inner) if leave_nullable_allowance=>match inner.as_ref() {
                        ResolvedType::Record{symbol,stored:true}=>Some(*symbol),
                        _=>None,
                    },
                    _=>None,
                };
                // The exact overdue owner receipt supplies one State-computed,
                // dependency-fenced balance to both its Require and SEND Rule.
                // Recomputing this derived field here would open a second
                // unordered child-query view and break the owner proof.
                if self.owner_handler_body && field == "balance"
                    && matches!(derived_model, Some(model) if self.ir.items.get(model.0 as usize)
                        .is_some_and(|item| item.canonical == "invoice.Invoice"))
                    && self.receipt_capture.as_ref()
                        .and_then(|receipt| receipt.plan.invoice_overdue_decision.as_ref())
                        .is_some_and(|decision| {
                            let header = &decision["sites"]["header"]["node"];
                            header["start"].as_u64().is_some_and(|start| start <= span.start as u64)
                                && header["end"].as_u64().is_some_and(|end| span.end as u64 <= end)
                        })
                {
                    return format!("{}.balance", self.lower_expr(base));
                }
                if (self.source_guard_body || self.owner_handler_body || self.source_data_body)
                    && let Some(model)=derived_model
                    && let Some(derived) = self.ir.items.iter().find_map(|item| match &item.kind {
                        IrItemKind::DeriveField {
                            model: owner,
                            expr: Some(body),
                            ..
                        } if *owner == model && item.name == *field && body.ty == expr.ty => {
                            Some(body.clone())
                        }
                        _ => None,
                    })
                {
                    if self.source_guard_derive_depth >= 16 {
                        self.unsupported(
                            "source guard derive",
                            "derived scalar closure exceeds its source bound",
                            span,
                        );
                        return self.throw_expr("unsupported source guard derive");
                    }
                    let receiver = if self.owner_handler_body || self.source_data_body { self.lower_expr(base) } else { self.lower_boolean_record(base) };
                    self.enter_scope();
                    let row = self.bind("row");
                    self.source_guard_derive_depth += 1;
                    let body = self.lower_business_expr(&derived, "source guard derived scalar");
                    self.source_guard_derive_depth -= 1;
                    self.exit_scope();
                    if leave_nullable_allowance
                        && self.ir.items.get(model.0 as usize)
                            .is_some_and(|item|item.canonical=="leave.Allowance")
                        && let Some(decision)=self.receipt_capture.as_ref()
                            .and_then(|receipt|receipt.plan.leave_decide_decision.as_ref())
                        && decision["sites"]["portionRequire"]["node"]["start"].as_u64()
                            .is_some_and(|start|start<=span.start as u64)
                        && decision["sites"]["portionRequire"]["node"]["end"].as_u64()
                            .is_some_and(|end|span.end as u64<=end)
                    {
                        let descriptor=descriptor_json(decision);
                        self.stdlib.insert("withLeaveDecideAllowance".into());
                        return format!("(await withLeaveDecideAllowance(c,{descriptor},{receiver},async({row})=>({body})))");
                    }
                    return format!("(await (async({row})=>({body}))({receiver}))");
                }
                if let Some(linked) = self.hook_helper_member(base, field, span, &expr.ty) {
                    return linked;
                }
                if self.in_hook()
                    && let Some(gap) = self.hook_member_gap(base, field, span, &expr.ty)
                {
                    return gap;
                }
                // IR context reads synthesize an unknown-typed `c` base.
                // A source parameter named c owns a different, checked value.
                let ambient = matches!(&base.expr, IrExpr::Name(name) if name == "c")
                    && matches!(base.ty, ResolvedType::Unknown)
                    && matches!(field.as_str(), "actor" | "now" | "team" | "operation");
                let base_text = if ambient {
                    "c".to_string()
                } else if (self.boolean_body || self.retained_owner_body && field != "id")
                    && self.is_model_reference(&base.ty)
                {
                    self.lower_boolean_record(base)
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
                let member = if object_key(field) == *field {
                    format!("{base_text}{op}{field}")
                } else {
                    let optional = if op == "?." { "?." } else { "" };
                    format!("{base_text}{optional}[{}]", js_string(field))
                };
                // B13 defining-owner bool decoding: a bool preference read
                // decodes its string-typed store spelling at this checked
                // typed reader, before any bool expression consumes it.
                // Nullable reads stay nullable: null stays null, real
                // booleans pass through, "true"/"false" become booleans,
                // and anything else throws a validation refusal (never
                // truthy, never a silent filter). Non-nullable reads keep
                // their declared absence contract: the strict spelling
                // decoding maps real booleans and "true"/"false" only, so
                // a missing value never becomes a nullable success and
                // malformed spellings still refuse. Non-bool reads lower
                // verbatim.
                let member = if matches!(&base.expr, IrExpr::Name(name) if name == "preferences")
                    && matches!(
                        expr.ty.nullable_inner().unwrap_or(&expr.ty),
                        ResolvedType::Scalar(Scalar::Bool)
                    ) {
                    if expr.ty.nullable_inner().is_some() {
                        format!(
                            "(value=>{{if(value==null)return null;if(value===true)return true;if(value===false)return false;if(value===\"true\")return true;if(value===\"false\")return false;throw{{code:\"validation\",message:\"Invalid bool preference.\"}}}})({member})"
                        )
                    } else {
                        format!(
                            "(value=>{{if(value===true)return true;if(value===false)return false;if(value===\"true\")return true;if(value===\"false\")return false;throw{{code:\"validation\",message:\"Invalid bool preference.\"}}}})({member})"
                        )
                    }
                } else if matches!(&base.expr, IrExpr::Name(name) if name == "preferences")
                    && expr.ty.nullable_inner().unwrap_or(&expr.ty) == &ResolvedType::Scalar(Scalar::Int)
                {
                    self.stdlib.insert("decodeValue".into());
                    self.stdlib.insert("int64".into());
                    let absence = if expr.ty.nullable_inner().is_some() { "if(value==null)return null;" } else { "" };
                    format!("(value=>{{try{{{absence}return typeof value===\"bigint\"?int64(value):decodeValue(\"int\",value);}}catch{{throw{{code:\"validation\",message:\"Invalid int preference.\"}}}}}})({member})")
                } else {
                    member
                };
                if expr.ty.nullable_inner().is_some() {
                    format!("({member} ?? null)")
                } else {
                    member
                }
            }
            IrExpr::Call { target, args } => self.lower_call(target, args, span, &expr.ty),
            IrExpr::BoundCall {
                target,
                args,
                slots,
            } => self.lower_bound_call(target, args, slots, span, &expr.ty),
            IrExpr::Binary { .. } => self.lower_binary_tree(expr),
            IrExpr::Unary { op, operand } => self.lower_unary(*op, operand, span),
            IrExpr::Array(items) => {
                let parts: Vec<String> = items.iter().map(|i| self.lower_expr(i)).collect();
                format!("[{}]", parts.join(","))
            }
            IrExpr::Object(entries) => {
                let mut parts: Vec<String> = entries
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
                if let ResolvedType::StdNominal { fields, .. } = &expr.ty {
                    if crate::analysis::types::checked_standard_nominal_name(&expr.ty).is_none() {
                        self.unsupported(
                            "standard nominal literal",
                            "missing exact owning schema",
                            span,
                        );
                        return self.throw_expr("standard nominal literal schema");
                    }
                    for (name, ty) in fields {
                        if entries.iter().any(|(key, _)| key == name) {
                            continue;
                        }
                        let default = match ty {
                            ResolvedType::Nullable(_) => "null",
                            ResolvedType::Array { .. } => "[]",
                            _ => {
                                self.unsupported(
                                    "standard nominal literal",
                                    "missing required owning field",
                                    span,
                                );
                                return self.throw_expr("standard nominal literal field");
                            }
                        };
                        parts.push(format!("{}:{default}", object_key(name)));
                    }
                }
                // A checked Contract literal can carry either IR record flag
                // at a nested capability-input site. The symbol's actual
                // declaration, not that flag, owns its literal defaults.
                if let ResolvedType::Record { symbol, .. } = &expr.ty {
                    let defaults = self.ir.items.get(symbol.0 as usize).and_then(|item| {
                        let IrItemKind::Contract { fields, .. } = &item.kind else { return None; };
                        Some(fields.iter().filter_map(|id| {
                            let field = self.ir.items.get(id.0 as usize)?;
                            if entries.iter().any(|(name, _)| name == &field.name) { return None; }
                            let IrItemKind::Field { default: Some(IrDefault::Literal(value)), .. } = &field.kind else {
                                return None;
                            };
                            Some((field.name.clone(), value.clone()))
                        }).collect::<Vec<_>>())
                    }).unwrap_or_default();
                    for (name, value) in defaults {
                        parts.push(format!("{}:{}", object_key(&name), self.lower_expr(&value)));
                    }
                }
                format!("{{{}}}", parts.join(","))
            }
            IrExpr::Query(query) => {
                if self.in_hook() && !self.hook_native() {
                    return self.hook_gap(
                        "hook query",
                        "hooks read event.after/event.before; queries have no hook lowering",
                        span,
                    );
                }
                // Native hooks lower contained reads over the event
                // snapshots through the accepted query engine with the
                // trigger's author/clock (`c`); the owner-policy plan
                // admits only event-rooted contained queries. Snapshots
                // stay intact and reads observe committed rows.
                self.lower_query(query, span)
            }
            IrExpr::DeliveryRead {
                record,
                field,
                props,
                callback,
            } => {
                if let Some(callback) = callback {
                    if self.in_hook() || !callback.matches(self.ir, expr, record, field, props) {
                        self.unsupported(
                            "callback diagnostics",
                            "original checked generation association is required",
                            span,
                        );
                        return self.throw_expr("unsupported callback diagnostic source");
                    }
                    self.stdlib
                        .insert("generationCallbackDiagnostics".to_string());
                    let original = match record.ty.nullable_inner().unwrap_or(&record.ty) {
                        ResolvedType::Record {
                            symbol,
                            stored: true,
                        } => self
                            .ir
                            .items
                            .get(symbol.0 as usize)
                            .and_then(|item| self.original_ui_row(record, &item.canonical)),
                        _ => None,
                    };
                    let record = original.unwrap_or_else(|| self.lower_expr(record));
                    return format!(
                        "(await generationCallbackDiagnostics(c,{{record:{record},field:{}}}))",
                        js_string(field)
                    );
                }
                if props.iter().any(|prop| prop == "callback_diagnostics") {
                    self.unsupported(
                        "callback diagnostics",
                        "protected observation has no checked source",
                        span,
                    );
                    return self.throw_expr("unproven callback diagnostics");
                }
                if self.in_hook() && !self.hook_native() {
                    return self.hook_gap(
                        "hook delivery read",
                        "delivery reads need the ambient context, which legacy hooks do not receive",
                        span,
                    );
                }
                self.stdlib.insert("delivery".to_string());
                let original = match record.ty.nullable_inner().unwrap_or(&record.ty) {
                    ResolvedType::Record {
                        symbol,
                        stored: true,
                    } => self
                        .ir
                        .items
                        .get(symbol.0 as usize)
                        .and_then(|item| self.original_ui_row(record, &item.canonical)),
                    _ => None,
                };
                let record_text = original.unwrap_or_else(|| self.lower_expr(record));
                // Error is one authorized receipt leaf. Its closed payload
                // members are projected locally, never new receipt selectors.
                let error_projection =
                    props.first().is_some_and(|prop| prop == "error") && props.len() > 1;
                let selected = js_string(&if error_projection {
                    "error".to_string()
                } else {
                    props.join(".")
                });
                let observed = format!(
                    "(await delivery(c,{{record:{record_text},field:{}}},[{selected}]))",
                    js_string(field)
                );
                let nullable = expr.ty.nullable_inner().is_some();
                let mut projected = if nullable {
                    format!("{observed}?.[{selected}]")
                } else {
                    format!("{observed}[{selected}]")
                };
                if error_projection {
                    for field in &props[1..] {
                        projected.push_str(&format!(
                            "{}[{}]",
                            if nullable { "?." } else { "" },
                            js_string(field)
                        ));
                    }
                }
                if nullable {
                    format!("({projected} ?? null)")
                } else {
                    projected
                }
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
                schemas,
            } => {
                if self.in_hook() && !self.hook_native() {
                    return self.hook_gap(
                        "hook message format",
                        "message formatting needs the ambient context, which legacy hooks do not receive",
                        span,
                    );
                }
                self.stdlib.insert("format".to_string());
                self.stdlib.insert("makeMessageDescriptor".to_string());
                self.stdlib.insert("ValueError".to_string());
                self.ui.insert("normalizeTag".to_string());
                self.localized_format = true;
                let audit=self.receipt_capture.as_ref().and_then(|receipt|receipt.plan.event_notice_audit.as_ref()).and_then(|plan|
                    plan["formats"].as_array()?.iter().find(|site| site["node"]["start"].as_u64()==Some(span.start as u64) && site["node"]["end"].as_u64()==Some(span.end as u64)).map(|site|(plan.clone(),site["field"].as_str().unwrap().to_string())));
                let was_boolean=self.boolean_body;
                if audit.is_some() {self.boolean_body=true;}
                let values: Vec<_> = args.iter().map(|arg| self.lower_expr(arg)).collect();
                self.boolean_body=was_boolean;
                let capture = binding_ident("a", &self.binding_seq.to_string());
                self.binding_seq += 1;
                let schemas = schemas
                    .iter()
                    .map(|schema| {
                        let params = schema
                            .param_types
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
                        format!("[{},[{params}]]", js_string(&schema.source_lang))
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                if let Some((plan,field))=audit {
                    self.stdlib.insert("nativeScenarioEventNoticeFormat".into());
                    let event=self.reference("event");
                    return format!("(await nativeScenarioEventNoticeFormat(c,{},{},async(c,{{event:{event}}})=>(({capture})=>({{descriptor:{capture}[{descriptor_index}],locale:{capture}[{locale_index}],formatted:{}(c,{capture}[{descriptor_index}],{capture}[{locale_index}],[{schemas}])}}))([{}])))",
                        descriptor_json(&plan),js_string(&field),binding_ident("h","localized_format"),values.join(","));
                }
                format!(
                    "(({capture})=>{}(c,{capture}[{descriptor_index}],{capture}[{locale_index}],[{schemas}]))([{}])",
                    binding_ident("h", "localized_format"),
                    values.join(",")
                )
            }
            IrExpr::HasRole { role, person } => {
                if self.in_hook() && !self.hook_native() {
                    return self.hook_gap(
                        "hook role gate",
                        "role gates need the ambient context, which legacy hooks do not receive",
                        span,
                    );
                }
                self.stdlib.insert("hasRole".to_string());
                match person {
                    Some(person) => {
                        let person_text = self.lower_expr(person);
                        self.lower_role_subject(role, person, &person_text)
                    }
                    None => format!("hasRole(c,{})", js_string(role)),
                }
            }
            IrExpr::Lambda { param, body } => {
                self.enter_scope();
                let param = self.bind(param);
                let in_hook = self.hook_closure_tracked();
                if in_hook {
                    self.hook_closure_depth += 1;
                }
                let body_text = self.lower_expr(body);
                if in_hook {
                    self.hook_closure_depth -= 1;
                }
                self.exit_scope();
                if expr_uses_async(body) || self.implicit_expr_uses_async(body)
                    || self.leave_decide_async_predicate(body.span) {
                    format!("async({param})=>{body_text}")
                } else {
                    format!("({param})=>{body_text}")
                }
            }
            IrExpr::PageTimePredicate(_) => {
                self.unsupported(
                    "page time predicate",
                    "only its original checked Table where consumes this carrier",
                    span,
                );
                self.throw_expr("unsupported page time predicate position")
            }
            IrExpr::Unsupported { what, why } => {
                self.unsupported(what, why, span);
                self.throw_expr(&format!("{what} has no lowering"))
            }
        }
    }

    /// Only a fresh-source prepared owning receipt can specialize first. The
    /// original issued query object goes directly to the native frame; generic
    /// first(array) remains the ordinary pure builtin.
    fn first_query_parent_matches(
        &self,
        source: &crate::analysis::scenario_disclosure::DisclosureQuery,
        query: &super::ir::IrQuery,
    ) -> bool {
        match source
            .first
            .as_ref()
            .and_then(|first| first.contained_parent)
        {
            None => query.parent.is_none(),
            Some((receiver, parameter)) => query.parent.as_deref().is_some_and(|parent| {
                let parameter_name = self
                    .ir
                    .items
                    .get(parameter.0 as usize)
                    .map(|item| item.name.as_str());
                parent.span == Span::new(receiver.file, receiver.start, receiver.end)
                    && match &parent.expr {
                        IrExpr::Name(name) => Some(name.as_str()) == parameter_name,
                        IrExpr::Member { base, field } => {
                            field == "parent"
                                && matches!(&base.expr, IrExpr::Name(name) if Some(name.as_str()) == parameter_name)
                        }
                        _ => false,
                    }
            }),
        }
    }

    fn first_query_call_matches(
        &self,
        first: &crate::analysis::scenario_disclosure::DisclosureFirstQuery,
        at: Span,
        target: &IrCallTarget,
        slots: Option<&[Option<usize>]>,
        result: &ResolvedType,
        row: &ResolvedType,
        domain: &TypedExpr,
        array: &ResolvedType,
        fact: &crate::analysis::types::CheckedQuery,
        source: &crate::analysis::scenario_disclosure::DisclosureQuery,
    ) -> bool {
        first.call.file == at.file
            && first.call.start == at.start
            && first.call.end == at.end
            && matches!(target,IrCallTarget::Builtin {id,awaited:false}
                if id=="first")
            && slots.is_none_or(|slots| slots == [Some(0)])
            && *result == ResolvedType::Nullable(Box::new(row.clone()))
            && domain.ty == *array
            && fact.node == source.node
            && fact.domain == source.domain
            && fact.result == *array
    }

    fn first_query_collection_matches(
        &self,
        collection: &crate::analysis::types::CheckedCollectionCall,
        first: &crate::analysis::scenario_disclosure::DisclosureFirstQuery,
        source: &crate::analysis::scenario_disclosure::DisclosureQuery,
        fact: &crate::analysis::types::CheckedQuery,
    ) -> bool {
        collection.node == first.call
            && collection.query == source.node
            && Some(collection.alias) == source.alias
            && collection.model == source.model
            && collection.builtin == "first"
            && collection.overload == first.overload
            && collection.predicate.is_none()
            && source.projection.is_none()
            && source.cardinality_guard.is_none()
            && fact.projection.is_none()
    }

    fn first_query_plan_matches(
        &self,
        query: &super::ir::IrQuery,
        source: &crate::analysis::scenario_disclosure::DisclosureQuery,
        parent_matches: bool,
    ) -> bool {
        query.contract_collection_call.is_none()
            && parent_matches
            && query.select.is_none()
            && query.select_param.is_none()
            && query.limit.is_none()
            && (query.archived.is_none() || source.archived)
            && !query.where_async
            && matches!(&query.domain,super::ir::IrQueryDomain::Model(name) if name==&source.model_name)
            && super::scenario_receipts::checked_first_query_order(source, query).is_some()
    }

    fn native_first_query(
        &self,
        target: &IrCallTarget,
        args: &[TypedExpr],
        slots: Option<&[Option<usize>]>,
        at: Span,
        result: &ResolvedType,
    ) -> bool {
        let Some(source) = self.query_capture.as_ref().and_then(|capture| {
            capture.queries.iter().find(|query| {
                query.first.as_ref().is_some_and(|call| {
                    call.call.file == at.file
                        && call.call.start == at.start
                        && call.call.end == at.end
                })
            })
        }) else {
            return false;
        };
        let Some(first) = source.first.as_ref() else {
            return false;
        };
        let [domain] = args else {
            return false;
        };
        let IrExpr::Query(query) = &domain.expr else {
            return false;
        };
        let Some(fact) = query.source.as_deref() else {
            return false;
        };
        let Some(collection) = query.collection_call.as_deref() else {
            return false;
        };
        let row = ResolvedType::Record {
            symbol: source.model,
            stored: true,
        };
        let array = ResolvedType::Array {
            element: Box::new(row.clone()),
            ordered: true,
            nonempty: false,
        };
        // A contained domain pairs the admitted receiver with the IR parent
        // value; unscoped scans keep no parent on either side. Any other
        // combination keeps the unprepared refusal below.
        let parent_matches = self.first_query_parent_matches(source, query);
        self.first_query_call_matches(first, at, target, slots, result, &row, domain, &array, fact, source)
            && self.first_query_collection_matches(collection, first, source, fact)
            && self.first_query_plan_matches(query, source, parent_matches)
    }

    fn first_query_marker(&self, at: Span) -> String {
        let first = self
            .query_capture
            .as_ref()
            .and_then(|capture| {
                capture
                    .queries
                    .iter()
                    .filter_map(|query| query.first.as_ref())
                    .find(|first| {
                        first.call.file == at.file
                            && first.call.start == at.start
                            && first.call.end == at.end
                    })
            })
            .expect("authenticated first call");
        descriptor_json(
            &serde_json::json!({"node":{"start":first.call.start,"end":first.call.end},"statement":{"start":first.binding.start,"end":first.binding.end}}),
        )
    }

    /// Stored-model first needs its checked native recipe. A value-array
    /// query already produces a supplied ordered array for the pure builtin.
    fn viewer_read_first_query(&self, target: &IrCallTarget, args: &[TypedExpr], span: Span) -> bool {
        if !self.viewer_read_body
            || !matches!(target, IrCallTarget::Builtin { id, awaited: false } if id == "first")
        {
            return false;
        }
        let [domain] = args else { return false; };
        let IrExpr::Query(query) = &domain.expr else { return false; };
        let crate::codegen::ir::IrQueryDomain::Model(_) = &query.domain else { return false; };
        let (Some(source), Some(call)) = (query.source.as_deref(), query.collection_call.as_deref())
        else { return false; };
        call.builtin == "first"
            && call.node.file == span.file
            && call.node.start == span.start
            && call.node.end == span.end
            && call.query == source.node
            && call.predicate.is_none()
            && source.result == domain.ty
            && source.projection.is_none()
            && query.select.is_none()
            && query.limit.is_none()
    }

    fn unprepared_first_query(
        &mut self,
        target: &IrCallTarget,
        args: &[TypedExpr],
        span: Span,
    ) -> Option<String> {
        if self.native_source_predicates
            && !self.boolean_body
            && !self.owner_handler_body
            && !self.viewer_read_first_query(target, args, span)
            && matches!(target, IrCallTarget::Builtin { id, awaited: false } if id == "first")
            && args.iter().any(|argument| {
                matches!(&argument.expr, IrExpr::Query(query)
                    if matches!(query.domain, crate::codegen::ir::IrQueryDomain::Model(_)))
            })
        {
            if matches!(args, [domain] if self.authority_queries
                .is_some_and(|prepared| prepared.matched_first(span, domain))) {
                return None;
            }
            self.unsupported(
                "first query",
                "original native query correspondence is unavailable",
                span,
            );
            return Some(self.throw_expr("first query lacks its checked native source"));
        }
        None
    }

    /// Prepared original counts consume only their genuine issued query array.
    /// A contained Member and the original ancestor guard keep separate seals.
    fn native_count_query(
        &self,
        target: &IrCallTarget,
        args: &[TypedExpr],
        slots: Option<&[Option<usize>]>,
        at: Span,
        result: &ResolvedType,
    ) -> bool {
        let Some(source) = self.query_capture.as_ref().and_then(|capture| {
            capture.queries.iter().find(|query| {
                query.count.as_ref().is_some_and(|call| {
                    call.call.file == at.file
                        && call.call.start == at.start
                        && call.call.end == at.end
                })
            })
        }) else {
            return false;
        };
        let Some(count) = source.count.as_ref() else {
            return false;
        };
        let [domain] = args else {
            return false;
        };
        let IrExpr::Query(query) = &domain.expr else {
            return false;
        };
        if count.contained_parent.is_none() {
            let Some(fact) = query.source.as_deref() else {
                return false;
            };
            let Some(collection) = query.collection_call.as_deref() else {
                return false;
            };
            let [first, candidate, supplied] = count.parent_edges.as_slice() else {
                return false;
            };
            let array = ResolvedType::Array {
                element: Box::new(ResolvedType::Record {
                    symbol: source.model,
                    stored: true,
                }),
                ordered: true,
                nonempty: false,
            };
            return matches!(target,IrCallTarget::Builtin {id,awaited:false} if id == "count")
                && slots.is_none_or(|slots| slots == [Some(0)])
                && count.slots == [Some(0)]
                && *result == ResolvedType::Scalar(Scalar::Int)
                && domain.ty == array
                && fact.node == source.node
                && fact.domain == source.domain
                && fact.result == array
                && fact.projection.is_none()
                && collection.node == count.call
                && collection.builtin == "count"
                && collection.overload == count.overload
                && collection.query == source.node
                && collection.model == source.model
                && Some(collection.alias) == source.alias
                && collection.predicate.is_none()
                && source.first.is_none()
                && source.projection.is_none()
                && source.cardinality_guard.is_none()
                && source.dependencies.len() == 2
                && first.child == source.model
                && first.parent == candidate.child
                && candidate.receiver == first.node
                && supplied.child == candidate.child
                && supplied.parent == candidate.parent
                && query.contract_collection_call.is_none()
                && query.parent.is_none()
                && query.where_pred.as_ref().is_some_and(|predicate| {
                    source.predicate.is_some_and(|node| {
                        predicate.span.file == node.file
                            && predicate.span.start == node.start
                            && predicate.span.end == node.end
                    }) && predicate.ty == ResolvedType::Scalar(Scalar::Bool)
                })
                && !query.where_async
                && query.order.is_empty()
                && query.value_order.is_none()
                && query.limit.is_none()
                && query.archived.is_none()
                && query.select.is_none()
                && query.select_param.is_none()
                && matches!(&query.domain,super::ir::IrQueryDomain::Model(model) if model == &source.model_name);
        }
        let Some((parent_node, parameter)) = count.contained_parent else {
            return false;
        };
        let Some(parent) = query.parent.as_ref() else {
            return false;
        };
        let Some(parameter) = self.ir.items.get(parameter.0 as usize) else {
            return false;
        };
        let array = ResolvedType::Array {
            element: Box::new(ResolvedType::Record {
                symbol: source.model,
                stored: true,
            }),
            ordered: true,
            nonempty: false,
        };
        // The original assign capacity Require is a filtered count before
        // the selected target FIRST. Its final native receipt has already
        // sealed both occurrences and their order; consume this exact issued
        // query through countQuery so State can attest the capacity read.
        if self.query_capture.as_ref().is_some_and(|capture| {
            capture.owner == "member_terms.assign"
                && matches!(capture.queries.as_slice(), [capacity, selected]
                    if capacity.id == source.id && capacity.count.is_some() && selected.first.is_some())
        }) && self.receipt_capture.is_some() {
            let Some(fact) = query.source.as_deref() else { return false; };
            let Some(collection) = query.collection_call.as_deref() else { return false; };
            let Some(predicate) = query.where_pred.as_deref() else { return false; };
            let [active] = source.dependencies.as_slice() else { return false; };
            return count.call.file == at.file
                && count.call.start == at.start
                && count.call.end == at.end
                && matches!(target, IrCallTarget::Builtin {id,awaited:false} if id == "count")
                && slots.is_none_or(|slots| slots == [Some(0)])
                && count.slots == [Some(0)]
                && *result == ResolvedType::Scalar(Scalar::Int)
                && domain.ty == array
                && domain.span == Span::new(source.node.file, source.node.start, source.node.end)
                && parent.span == Span::new(parent_node.file, parent_node.start, parent_node.end)
                && matches!(&parent.expr, IrExpr::Name(name) if name == &parameter.name)
                && matches!(&parameter.kind, IrItemKind::Param {ty:IrType::Known(ty),default:None,..}
                    if ty == &parent.ty && matches!(ty,ResolvedType::Record {stored:true,..}))
                && matches!(&query.domain, super::ir::IrQueryDomain::Model(model)
                    if model == &source.model_name && model == "member_terms.Seat")
                && source.first.is_none()
                && source.projection.is_none()
                && source.alias.is_some()
                && source.predicate.is_some_and(|node| predicate.span == Span::new(node.file,node.start,node.end))
                && source.cardinality_guard.is_none()
                && count.parent_edges.is_empty()
                && fact.node == source.node && fact.domain == source.domain && fact.result == array
                && fact.projection.is_none()
                && collection.node == count.call && collection.builtin == "count"
                && collection.overload == count.overload && collection.query == source.node
                && collection.model == source.model && Some(collection.alias) == source.alias
                && collection.predicate.is_none()
                && query.contract_collection_call.is_none()
                && query.where_param == "row" && !query.where_async
                && matches!(&predicate.expr, IrExpr::Member {base,field}
                    if field == "active" && matches!(&base.expr, IrExpr::Name(name) if name == "row"))
                && active.field_name == "active"
                && active.role == crate::analysis::scenario_disclosure::DependencyRole::Control
                && active.ty == ResolvedType::Scalar(Scalar::Bool)
                && query.order.is_empty() && query.value_order.is_none()
                && query.limit.is_none() && query.archived.is_none()
                && query.select.is_none() && query.select_param.is_none();
        }
        let created_parent=self.query_capture.as_ref().is_some_and(|capture|{
            let Some(owner)=self.ir.items.iter().find(|item|item.canonical==capture.owner) else{return false;};
            let Some(counts)=self.constructor_counts.get(&owner.id).and_then(|value|value.as_array()) else{return false;};
            let Some(marker)=counts.iter().find(|value|value["queryId"]==source.id&&value["createdParent"].is_object()) else{return false;};
            let IrExpr::Member{base,field}=&parent.expr else{return false;};
            let IrExpr::Name(binding)=&base.expr else{return false;};
            field=="parent"&&marker["createdParent"]["parameter"]==parameter.name
                &&self.ir.scenario_disclosures.get(&owner.id).and_then(|value|value.source_facts())
                    .and_then(|facts|facts.creates.as_ref()).is_some_and(|creates|creates.iter().any(|created|
                        created.binding==*binding&&base.ty==ResolvedType::Record{symbol:created.model,stored:true}
                            &&marker["createdParent"]["model"]==created.definition.canonical
                            &&marker["createdParent"]["create"]==serde_json::json!({"start":created.node.start,"end":created.node.end})))
        });
        count.call.file == at.file
            && count.call.start == at.start
            && count.call.end == at.end
            && matches!(target, IrCallTarget::Builtin {id,awaited:false} if id == "count")
            && slots.is_none_or(|slots| slots == [Some(0)])
            && count.slots == [Some(0)]
            && *result == ResolvedType::Scalar(Scalar::Int)
            && domain.ty == array
            && domain.span.file == source.node.file
            && domain.span.start == source.node.start
            && domain.span.end == source.node.end
            && parent.span.file == parent_node.file
            && parent.span.start == parent_node.start
            && parent.span.end == parent_node.end
            && (created_parent || matches!(&parent.expr, IrExpr::Name(name) if name == &parameter.name)
                && matches!(&parameter.kind,IrItemKind::Param{ty:IrType::Known(ty),default:None,..} if ty==&parent.ty && matches!(ty,ResolvedType::Record{stored:true,..}))
                || self.query_capture.as_ref().is_some_and(|capture|
                    self.ir.items.iter().find(|item|item.canonical==capture.owner)
                        .and_then(|item|self.constructor_counts.get(&item.id)).and_then(|counts|counts.as_array())
                        .is_some_and(|counts|counts.iter().any(|value|value["queryId"]==source.id)))
                    && matches!(&parent.expr,IrExpr::Member{base,field} if field=="parent"
                        && matches!(&base.expr,IrExpr::Name(name) if name==&parameter.name)
                        && matches!(&parameter.kind,IrItemKind::Param{ty:IrType::Known(ty),default:None,..} if ty==&base.ty && matches!(ty,ResolvedType::Record{stored:true,..}))))
            && matches!(&query.domain, super::ir::IrQueryDomain::Model(model) if model == &source.model_name)
            && source.first.is_none()
            && source.projection.is_none()
            && source.alias.is_none()
            && source.predicate.is_none()
            && source.cardinality_guard.is_none()
            && count.parent_edges.is_empty()
            && query.source.is_none()
            && query.collection_call.is_none()
            && query.contract_collection_call.is_none()
            && query.where_pred.is_none()
            && !query.where_async
            && query.order.is_empty()
            && query.value_order.is_none()
            && query.limit.is_none()
            && query.archived.is_none()
            && query.select.is_none()
            && query.select_param.is_none()
    }

    /// Only the final admitted query recipe can replace the original scoped
    /// ANY with its short-circuit producer; no completed query array is made.
    /// Navigated parent edge for the composed direct ANY: a `param.parent`
    /// member over the admitted input, spanning the exact recorded receiver.
    /// Source spelling and lineage seals stay with the defining matcher.
    fn navigated_any_parent(
        &self,
        source: &crate::analysis::scenario_disclosure::DisclosureQuery,
        query: &super::ir::IrQuery,
    ) -> bool {
        let [(receiver, parameter_id)] = source.inputs.as_slice() else {
            return false;
        };
        let Some(parameter) = self.ir.items.get(parameter_id.0 as usize) else {
            return false;
        };
        let Some(parent) = query.parent.as_deref() else {
            return false;
        };
        let IrExpr::Member { base, field } = &parent.expr else {
            return false;
        };
        let IrExpr::Name(base_name) = &base.expr else {
            return false;
        };
        field == "parent"
            && base_name == &parameter.name
            && parent.span.file == receiver.file
            && parent.span.start == receiver.start
            && parent.span.end == receiver.end
    }

    /// One recorded Control dependency per authored `and` leaf, in source
    /// order: `param.field == operand` equalities or bare bool reads, with
    /// the operand off any non-alias member base. The emitted callback
    /// tests exactly these leaves.
fn conjunct_dependency_matches<'d>(
    dependency: &'d crate::analysis::scenario_disclosure::DisclosureDependency,
    source: &crate::analysis::scenario_disclosure::DisclosureQuery,
    field_name: &str,
    member_span: Span,
    seen: &mut std::collections::HashSet<&'d String>,
) -> bool {
    dependency.role == crate::analysis::scenario_disclosure::DependencyRole::Control
        && dependency.model == source.model
        && dependency.model_name == source.model_name
        && dependency.field_name == field_name
        && dependency.calls.is_empty()
        && dependency.query_id.is_none()
        && !dependency.id.is_empty()
        && seen.insert(&dependency.id)
        && dependency.source == source.source
        && !dependency.type_id.is_empty()
        && Span::new(
            dependency.node.file,
            dependency.node.start,
            dependency.node.end,
        ) == member_span
}

    fn conjunct_dependencies_match(
        &self,
        source: &crate::analysis::scenario_disclosure::DisclosureQuery,
        body: &TypedExpr,
        param: &str,
    ) -> bool {
        let boolean = ResolvedType::Scalar(Scalar::Bool);
        let mut pending = vec![body];
        let mut leaves: Vec<&TypedExpr> = Vec::new();
        while let Some(node) = pending.pop() {
            if let IrExpr::Binary {
                op: IrBinOp::And,
                left,
                right,
            } = &node.expr
            {
                if node.ty != boolean {
                    return false;
                }
                pending.push(right.as_ref());
                pending.push(left.as_ref());
                continue;
            }
            leaves.push(node);
        }
        if leaves.len() != source.dependencies.len() {
            return false;
        }
        let mut seen = HashSet::new();
        for (leaf, dependency) in leaves.iter().zip(source.dependencies.iter()) {
            let (member, field_name, operand) = match &leaf.expr {
                IrExpr::Binary {
                    op: IrBinOp::Eq,
                    left,
                    right,
                } => {
                    let IrExpr::Member { base, field } = &left.expr else {
                        return false;
                    };
                    let IrExpr::Name(base_name) = &base.expr else {
                        return false;
                    };
                    if base_name != param {
                        return false;
                    }
                    (left.as_ref(), field.as_str(), Some(right.as_ref()))
                }
                IrExpr::Member { base, field } => {
                    let IrExpr::Name(base_name) = &base.expr else {
                        return false;
                    };
                    if base_name != param {
                        return false;
                    }
                    (*leaf, field.as_str(), None)
                }
                _ => return false,
            };
            if leaf.ty != boolean || dependency.ty != member.ty {
                return false;
            }
            match operand {
                Some(operand) => {
                    if operand.ty != member.ty {
                        return false;
                    }
                    let IrExpr::Member { base, .. } = &operand.expr else {
                        return false;
                    };
                    let mut root = base.as_ref();
                    loop {
                        match &root.expr {
                            IrExpr::Name(name) => {
                                if name == param {
                                    return false;
                                }
                                break;
                            }
                            IrExpr::Member { base: next, .. } => {
                                root = next.as_ref();
                            }
                            _ => return false,
                        }
                    }
                }
                None => {
                    if member.ty != boolean {
                        return false;
                    }
                }
            }
            if !Self::conjunct_dependency_matches(dependency, source, field_name, member.span, &mut seen)
            {
                return false;
            }
        }
        true
    }

    fn lower_native_any(
        &mut self,
        target: &IrCallTarget,
        args: &[TypedExpr],
        slots: Option<&[Option<usize>]>,
        at: Span,
        result: &ResolvedType,
    ) -> Option<String> {
        if !matches!(target,IrCallTarget::Builtin {id,awaited:false} if id == "any")
            || slots.is_some_and(|slots| slots != [Some(0), Some(1)])
            || *result != ResolvedType::Scalar(Scalar::Bool)
        {
            return None;
        }
        let [domain, predicate] = args else {
            return None;
        };
        let IrExpr::Query(query) = &domain.expr else {
            return None;
        };
        let IrExpr::Lambda { param, body } = &predicate.expr else {
            return None;
        };
        let collection = query.collection_call.as_deref()?;
        let fact = query.source.as_deref()?;
        let source = self
            .query_capture
            .as_ref()?
            .queries
            .iter()
            .find(|source| {
                source.node == fact.node
                    && source.alias == Some(collection.alias)
                    && source.predicate.is_some()
                    && source.dependencies.iter().all(|read| {
                        read.calls
                            .iter()
                            .map(|call| Span::new(call.file, call.start, call.end))
                            .eq(self.receipt_calls.iter().copied())
                    })
            })?
            .clone();
        if !self.receipt_calls.is_empty() {
            let owner = &self.query_capture.as_ref()?.owner;
            let mut metadata = self
                .query_any
                .and_then(|metadata| metadata.get(owner))
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter(|metadata| {
                    metadata["kind"] == "predicate" && metadata["queryId"] == source.id
                });
            let selected = metadata.next().cloned().unwrap_or(serde_json::Value::Null);
            if selected.is_null()
                || metadata.next().is_some()
                || selected["dependencyIds"]
                    != serde_json::json!(
                        source
                            .dependencies
                            .iter()
                            .map(|read| &read.id)
                            .collect::<Vec<_>>()
                    )
                || selected["sourceCall"]["siteIndex"].as_u64().is_none()
                || selected["sourceCall"]["callIndex"].as_u64().is_none()
                || source.dependencies.is_empty()
                || source.first.is_some()
                || source.count.is_some()
                || source.projection.is_some()
                || source.cardinality_guard.is_some()
                || source.dependencies.iter().any(|read| {
                    read.role != crate::analysis::scenario_disclosure::DependencyRole::Control
                        || read.source != source.source
                        || read.model != source.model
                })
                || collection.builtin != "any"
                || collection.overload != 0
                || Span::new(
                    collection.node.file,
                    collection.node.start,
                    collection.node.end,
                ) != at
                || collection.query != source.node
                || collection.model != source.model
                || collection.predicate.as_ref().is_none_or(|retained| {
                    Some(retained.node) != source.predicate || retained.ty != body.ty
                })
                || predicate.ty != ResolvedType::Scalar(Scalar::Bool)
                || body.ty != predicate.ty
                || query.parent.is_some()
                || query.where_pred.is_some()
                || query.where_async
                || query.select.is_some()
                || query.select_param.is_some()
                || !query.order.is_empty()
                || query.value_order.is_some()
                || query.limit.is_some()
                || query.archived.is_some()
                || query.contract_collection_call.is_some()
            {
                self.unsupported(
                    "helper ANY",
                    "original checked predicate source-call correspondence is unavailable",
                    at,
                );
                return Some(self.throw_expr("helper ANY lacks its original predicate source"));
            }
            let marker = serde_json::json!({"queryId":source.id,
                "siteIndex":selected["sourceCall"]["siteIndex"],
                "callIndex":selected["sourceCall"]["callIndex"]});
            self.enter_scope();
            let param = self.bind(param);
            let predicate = self.lower_expr(body);
            self.exit_scope();
            self.stdlib.insert("executeScenarioReceiptAny".into());
            return Some(format!(
                "(await executeScenarioReceiptAny(c,{},$can$query$issue({},c,async({param})=>{predicate})))",
                js_string(&source.id),
                js_string(&descriptor_json(&marker)),
            ));
        }
        // Direct navigated ANY over the composed any/first shape: the
        // admitted parent edge carries the resolved model, and one Control
        // dependency stands per authored `and` conjunct in source order.
        // The emitted callback tests exactly the recorded leaves; source
        // spelling and lineage seals stay with the defining matcher.
        if source.first.is_none()
            && source.count.is_none()
            && source.projection.is_none()
            && source.cardinality_guard.is_none()
            && !source.dependencies.is_empty()
            && predicate.ty == ResolvedType::Scalar(Scalar::Bool)
            && body.ty == predicate.ty
            && source
                .predicate
                .is_none_or(|node| Span::new(node.file, node.start, node.end) == body.span)
            && query.where_pred.is_none()
            && !query.where_async
            && query.select.is_none()
            && query.select_param.is_none()
            && query.order.is_empty()
            && query.value_order.is_none()
            && query.limit.is_none()
            && query.archived.is_none()
            && query.contract_collection_call.is_none()
            && matches!(&query.domain, super::ir::IrQueryDomain::Model(name) if name == &source.model_name)
            && collection.builtin == "any"
            && collection.overload == 0
            && Span::new(
                collection.node.file,
                collection.node.start,
                collection.node.end,
            ) == at
            && collection.query == source.node
            && collection.model == source.model
            && collection
                .predicate
                .as_ref()
                .is_none_or(|value| Some(value.node) == source.predicate && value.ty == body.ty)
            && self.navigated_any_parent(&source, query)
            && self.conjunct_dependencies_match(&source, body, param)
            && self.receipt_calls.is_empty()
        {
            // The issued callback attests queryId/siteIndex/callIndex with
            // the invocation context, exactly as the helper arm does; the
            // runtime refuses an arbitrary unissued callback.
            let owner = &self.query_capture.as_ref()?.owner;
            let mut metadata = self
                .query_any
                .and_then(|metadata| metadata.get(owner))
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter(|metadata| {
                    metadata["kind"] == "predicate" && metadata["queryId"] == source.id
                });
            let selected = metadata.next().cloned().unwrap_or(serde_json::Value::Null);
            if selected.is_null()
                || metadata.next().is_some()
                || selected["dependencyIds"]
                    != serde_json::json!(
                        source
                            .dependencies
                            .iter()
                            .map(|read| &read.id)
                            .collect::<Vec<_>>()
                    )
                || selected["sourceCall"]["siteIndex"].as_u64().is_none()
                || selected["sourceCall"]["callIndex"].as_u64().is_none()
            {
                return None;
            }
            let marker = serde_json::json!({"queryId":source.id,
                "siteIndex":selected["sourceCall"]["siteIndex"],
                "callIndex":selected["sourceCall"]["callIndex"]});
            self.enter_scope();
            let param = self.bind(param);
            let predicate = self.lower_expr(body);
            self.exit_scope();
            self.stdlib.insert("executeScenarioReceiptAny".into());
            return Some(format!(
                "(await executeScenarioReceiptAny(c,{},$can$query$issue({},c,async({param})=>{predicate})))",
                js_string(&source.id),
                js_string(&descriptor_json(&marker)),
            ));
        }
        let [dependency] = source.dependencies.as_slice() else {
            return None;
        };
        if collection.builtin != "any"
            || collection.overload != 0
            || Span::new(
                collection.node.file,
                collection.node.start,
                collection.node.end,
            ) != at
            || collection.query != source.node
            || collection.model != source.model
            || collection
                .predicate
                .as_ref()
                .is_none_or(|value| Some(value.node) != source.predicate || value.ty != body.ty)
            || source.first.is_some()
            || source.count.is_some()
            || source.projection.is_some()
            || predicate.ty != ResolvedType::Scalar(Scalar::Bool)
            || body.ty != predicate.ty
            || source
                .predicate
                .is_none_or(|node| Span::new(node.file, node.start, node.end) != body.span)
            || query.where_pred.is_some()
            || query.where_async
            || query.select.is_some()
            || query.select_param.is_some()
            || !query.order.is_empty()
            || query.value_order.is_some()
            || query.limit.is_some()
            || query.archived.is_some()
            || query.contract_collection_call.is_some()
            || query.parent.is_none()
            || dependency.field_name != "unfinished"
            || dependency.type_id != "bool"
            || dependency.role != crate::analysis::scenario_disclosure::DependencyRole::Control
            || !matches!(&body.expr,IrExpr::Member {base,field} if field == &dependency.field_name && matches!(&base.expr,IrExpr::Name(name) if name == param))
        {
            return None;
        }
        self.enter_scope();
        let param = self.bind(param);
        let predicate = self.lower_expr(body);
        self.exit_scope();
        self.stdlib.insert("executeScenarioReceiptAny".into());
        Some(format!(
            "(await executeScenarioReceiptAny(c,{},async({param})=>{predicate}))",
            js_string(&source.id)
        ))
    }

    fn lower_purchase_all(&mut self, target: &IrCallTarget, span: Span) -> Option<String> {
        if !matches!(target, IrCallTarget::Builtin { id, awaited: false } if id == "all") { return None; }
        let profile = self.receipt_capture.as_ref()?.plan.purchase_receive_all.as_ref()?;
        if !super::purchase_all::at(profile, span) { return None; }
        let profile = descriptor_json(profile);
        self.stdlib.insert("evaluateScenarioReceiptPurchaseAll".into());
        Some(format!("(await evaluateScenarioReceiptPurchaseAll(c,{profile}))"))
    }

    /// Lower a call: catalog builtins import from `@canlang/stdlib`
    /// (availability-checked at link time); capability operations import
    /// from their owning package module as `await op(c, ...)`.
    fn lower_call(
        &mut self,
        target: &IrCallTarget,
        args: &[TypedExpr],
        span: Span,
        result: &ResolvedType,
    ) -> String {
        if let Some(value) = self.lower_purchase_all(target, span) { return value; }
        if args.iter().any(|arg| self.expr_formatted(arg)) {
            return self.formatted_refusal("formatted call argument", span);
        }
        if let Some(call) = self.lower_native_any(target, args, None, span, result) {
            return call;
        }
        if self.native_first_query(target, args, None, span, result) {
            self.stdlib.insert("firstQuery".into());
            let query = self.lower_expr(&args[0]);
            let marker = self.first_query_marker(span);
            return format!("await firstQuery(c,{query},{marker})");
        }
        if let Some(refusal) = self.unprepared_first_query(target, args, span) {
            return refusal;
        }
        if self.native_count_query(target, args, None, span, result) {
            self.stdlib.insert("countQuery".into());
            let query = self.lower_expr(&args[0]);
            return format!("await countQuery(c,{query})");
        }
        let async_scoped = self.async_scoped_predicate(target, args, None);
        let hook_derive = self.hook_derive_call(target, args);
        let parts: Vec<_> = args.iter().map(|arg| self.lower_expr(arg)).collect();
        self.lower_call_rendered(
            target,
            &parts,
            args.first().map(|arg| &arg.ty),
            span,
            true,
            async_scoped,
            hook_derive,
        )
    }

    /// Source values evaluate left to right outside a synchronous capture.
    /// Await the target result outside that capture; reordering adds no Promise.
    fn lower_bound_call(
        &mut self,
        target: &IrCallTarget,
        args: &[TypedExpr],
        slots: &[Option<usize>],
        span: Span,
        result: &ResolvedType,
    ) -> String {
        if let Some(value) = self.lower_purchase_all(target, span) { return value; }
        if args.iter().any(|arg| self.expr_formatted(arg)) {
            return self.formatted_refusal("formatted call argument", span);
        }
        if let Some(call) = self.lower_native_any(target, args, Some(slots), span, result) {
            return call;
        }
        let native_first = self.native_first_query(target, args, Some(slots), span, result);
        if !native_first && let Some(refusal) = self.unprepared_first_query(target, args, span) {
            return refusal;
        }
        let native_count = self.native_count_query(target, args, Some(slots), span, result);
        let async_scoped = self.async_scoped_predicate(target, args, Some(slots));
        // Bound linkage reordering has no hook lowering: a linkage-carrying
        // bound derive call inside hook lowering refuses loud instead of
        // reading `undefined` off a reordered linkage.
        if !matches!(self.hook_derive_call(target, args), HookDerive::AsIs) {
            self.unsupported(
                "hook derive call",
                "linkage arguments to a bound derive call have no hook lowering",
                span,
            );
            return self.throw_expr("unsupported bound hook derive linkage");
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
        let call = if native_first {
            self.stdlib.insert("firstQuery".into());
            format!(
                "firstQuery(c,{},{})",
                ordered[0],
                self.first_query_marker(span)
            )
        } else if native_count {
            self.stdlib.insert("countQuery".into());
            format!("countQuery(c,{})", ordered[0])
        } else {
            self.lower_call_rendered(target, &ordered, domain_type, span, false, async_scoped, HookDerive::AsIs)
        };
        let awaited = native_first
            || native_count
            || async_scoped
            || matches!(
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

    /// Specialize only an exact native handler call. Arguments were already
    /// lowered in their caller context; defaults/body run in a fresh callee
    /// scope while sharing the actual handler capture and ambient c.
    fn lower_receipt_derive(
        &mut self,
        canonical: &str,
        parts: &[String],
        span: Span,
        await_result: bool,
    ) -> Option<String> {
        let expected = self
            .receipt_capture
            .as_ref()?
            .calls
            .get(&self.receipt_site(span))?;
        if expected != canonical {
            return None;
        }
        let item = self
            .ir
            .items
            .get(*self.by_canonical.get(canonical)?)?
            .clone();
        let IrItemKind::DeriveFn {
            params,
            expr: Some(expr),
            ..
        } = item.kind
        else {
            return None;
        };
        if params.len() != parts.len() || self.receipt_calls.len() >= 64 {
            return None;
        }
        self.enter_scope();
        self.receipt_calls.push(span);
        let names: Vec<_> = params
            .iter()
            .map(|id| self.bind(&self.ir.items[id.0 as usize].name.clone()))
            .collect();
        let mut defaults = String::new();
        for (id, name) in params.iter().zip(&names) {
            if let IrItemKind::Param {
                default: Some(default),
                ..
            } = self.ir.items[id.0 as usize].kind.clone()
            {
                let value = match default {
                    IrDefault::Literal(expr) | IrDefault::Computed { expr, .. } => {
                        self.lower_business_expr(&expr, "formatted derive parameter default")
                    }
                };
                defaults.push_str(&format!("if({name}===undefined){{{name}={value};}}"));
            }
        }
        let body = self.lower_expr(&expr);
        self.receipt_calls.pop();
        self.exit_scope();
        Some(format!(
            "{}(async({})=>{{{defaults}return {body};}})({})",
            if await_result { "await " } else { "" },
            names.join(","),
            parts.join(",")
        ))
    }

    /// Each source-Require invocation keeps its original helper call chain.
    /// Sharing an emitted helper function would lose which of two calls owns
    /// the same physical active_member node in that guard.
    fn lower_source_require_derive(&mut self,canonical:&str,parts:&[String],span:Span,await_result:bool)->Option<String> {
        // Dedicated owner interpreters retain their existing checked helper
        // variants and domain markers. This is the generic observer route.
        if !self.generic_boolean_body {return None;}
        let identity=self.source_require_identity.as_ref()?;
        let calls=identity["sites"].as_array()?.first()?["calls"].as_array()?;
        let mut matching=calls.iter().filter(|call|call["target"]["kind"]=="derive"
            && call["target"]["name"]==canonical && call["node"]["start"].as_u64()==Some(span.start as u64)
            && call["node"]["end"].as_u64()==Some(span.end as u64)
            && call["chain"].as_array()==Some(&self.source_require_calls));
        let call=matching.next()?.clone();
        if matching.next().is_some() || self.source_require_calls.len()>=32 {return None;}
        let item=self.ir.items.get(*self.by_canonical.get(canonical)?)?.clone();
        let IrItemKind::DeriveFn{params,expr:Some(body),..}=item.kind else{return None;};
        if params.len()!=parts.len() || call["slots"].as_array()?.iter().enumerate().any(|(index,slot)|slot.as_u64()!=Some(index as u64))
            || !call["defaults"].as_array()?.is_empty() {return None;}
        self.enter_scope();
        let names=params.iter().map(|id|self.bind(&self.ir.items[id.0 as usize].name.clone())).collect::<Vec<_>>();
        self.source_require_calls.push(serde_json::json!({"source":call["source"],"node":call["node"],"derive":canonical}));
        let expression=self.lower_expr(&body);
        self.source_require_calls.pop();self.exit_scope();
        Some(format!("{}(async({})=>({expression}))({})",if await_result{"await "}else{""},names.join(","),parts.join(",")))
    }

    /// The same physical membership node can occur in two helper invocations.
    /// Reuse the selected query's original owner census and actual derive chain.
    fn helper_membership_source(
        &self,
        at: Span,
        physical: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, ()> {
        if let Some(identity)=&self.source_require_identity {
            let calls=identity["sites"].as_array().and_then(|sites|sites.first()).and_then(|site|site["calls"].as_array()).ok_or(())?;
            let mut matching=calls.iter().enumerate().filter(|(_,call)|call["target"]["kind"]=="builtin"
                && call["target"]["id"]=="active_member" && call["source"]==physical["source"] && call["node"]==physical["node"]
                && call["chain"].as_array()==Some(&self.source_require_calls));
            let (index,_)=matching.next().ok_or(())?;
            if matching.next().is_some() {return Err(());}
            let mut marker=physical.clone();marker["sourceCall"]=serde_json::json!({"siteIndex":0,"callIndex":index});
            return Ok(Some(marker));
        }
        let Some(capture) = &self.query_capture else {
            return Ok(None);
        };
        if self.receipt_calls.is_empty() {
            return Ok(None);
        }
        let mut queries = capture.queries.iter().filter(|query| {
            query.predicate.is_some_and(|node| {
                node.file == at.file && node.start <= at.start && node.end >= at.end
            }) && !query.dependencies.is_empty()
                && query.dependencies.iter().all(|dependency| {
                    dependency
                        .calls
                        .iter()
                        .map(|node| Span::new(node.file, node.start, node.end))
                        .eq(self.receipt_calls.iter().copied())
                })
        });
        let Some(query) = queries.next() else {
            return Ok(None);
        };
        if queries.next().is_some() {
            return Err(());
        }
        let mut metadata = self
            .query_any
            .and_then(|owners| owners.get(&capture.owner))
            .and_then(serde_json::Value::as_array)
            .ok_or(())?
            .iter()
            .filter(|metadata| metadata["kind"] == "predicate" && metadata["queryId"] == query.id);
        let selected = metadata.next().ok_or(())?;
        if metadata.next().is_some() {
            return Err(());
        }
        let site_index = usize::try_from(selected["sourceCall"]["siteIndex"].as_u64().ok_or(())?)
            .map_err(|_| ())?;
        let query_index = usize::try_from(selected["sourceCall"]["callIndex"].as_u64().ok_or(())?)
            .map_err(|_| ())?;
        let site = self
            .membership_sites
            .and_then(|owners| owners.get(&capture.owner))
            .and_then(serde_json::Value::as_array)
            .ok_or(())?
            .iter()
            .filter(|site| {
                !matches!(
                    site["stage"].as_str(),
                    Some("read-policy" | "read-predicate" | "send-dispatch")
                )
            })
            .nth(site_index)
            .ok_or(())?;
        let calls = site["calls"].as_array().ok_or(())?;
        let original_query = calls.get(query_index).ok_or(())?;
        if original_query["target"]["kind"] != "builtin" || original_query["target"]["id"] != "any"
        {
            return Err(());
        }
        let mut members = calls.iter().enumerate().filter(|(_, call)| {
            call["target"]["kind"] == "builtin"
                && call["target"]["id"] == "active_member"
                && call["source"] == physical["source"]
                && call["node"] == physical["node"]
                && call["chain"] == original_query["chain"]
        });
        let (call_index, _) = members.next().ok_or(())?;
        if members.next().is_some() {
            return Err(());
        }
        let mut marker = physical.clone();
        marker["sourceCall"] = serde_json::json!({"siteIndex":site_index,"callIndex":call_index});
        Ok(Some(marker))
    }

    fn lower_active_member_rendered(
        &mut self,
        awaited: bool,
        parts: &mut Vec<String>,
        span: Span,
    ) -> Option<String> {
        let Some(mut source) = self.membership_calls.get(&span).cloned() else {
            self.unsupported(
                "membership observation",
                "active_member lacks its original checked source and selected call closure",
                span,
            );
            return Some(self.throw_expr("unsupported membership source identity"));
        };
        if !awaited || parts.len() != 2 {
            self.unsupported(
                "membership observation",
                "active_member requires its checked user/Team overload",
                span,
            );
            return Some(self.throw_expr("unsupported membership call shape"));
        }
        match self.helper_membership_source(span, &source) {
            Ok(Some(selected)) => source = selected,
            Ok(None) => {}
            Err(()) => {
                self.unsupported(
                    "membership observation",
                    "original helper occurrence selector is unavailable",
                    span,
                );
                return Some(self.throw_expr("unsupported helper membership occurrence"));
            }
        }
        // Bound here: the exact checked source and selected call
        // closure travel with this observation to the State
        // producer, which resolves the defining owner. Only this
        // success path marks the span; every refusal above keeps
        // its exact E6008 and the catalog's external E6007.
        if !self.membership_bound.contains(&span) {
            self.membership_bound.push(span);
        }
        parts.insert(0, "c".to_string());
        parts.push(descriptor_json(&source));
        None
    }

    fn lower_sum_rendered(
        &mut self,
        parts: &mut Vec<String>,
        domain_type: Option<&ResolvedType>,
        span: Span,
    ) -> Option<String> {
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
            return Some(self.throw_expr("sum domain has no static element lowering"));
        };
        // Values requires a static element tag before the optional currency.
        parts.insert(1, js_string(element));
        None
    }

    fn lower_builtin_rendered(
        &mut self,
        id: &String,
        awaited: bool,
        parts: &[String],
        domain_type: Option<&ResolvedType>,
        span: Span,
        await_result: bool,
        async_scoped: bool,
    ) -> String {
        if async_scoped && id == "group" && parts.len() == 2 {
            self.stdlib.insert("ValueError".to_string());
            self.stdlib.insert("equalValue".to_string());
            // Match Values.group's once-only source order, equality and frozen
            // result shape, awaiting only the actual original key callback.
            return format!(
                "{}(async($domain,$keyFn)=>{{if(!Array.isArray($domain))throw new ValueError(\"invalid-construction\",\"group domain must be an array\");if(typeof $keyFn!==\"function\")throw new ValueError(\"invalid-construction\",\"group key function must be a function\");const $groups=[];for(const $item of $domain){{const $key=await $keyFn($item);let $found;for(const $candidate of $groups){{if(equalValue(\"\",$candidate.key,$key)){{$found=$candidate;break;}}}}if($found===undefined)$groups.push({{key:$key,items:[$item]}});else $found.items.push($item);}}return Object.freeze($groups.map($entry=>Object.freeze({{key:$entry.key,items:Object.freeze([...$entry.items])}})));}})({},{})",
                if await_result { "await " } else { "" }, parts[0], parts[1]
            );
        }
        if async_scoped && matches!(id.as_str(), "any" | "all") && parts.len() == 2 {
            self.stdlib.insert("ValueError".to_string());
            let stop = if id == "any" { "true" } else { "false" };
            let end = if id == "any" { "false" } else { "true" };
            return format!(
                "{}(async($domain,$predicate)=>{{if(!Array.isArray($domain))throw new ValueError(\"invalid-construction\",\"{id} domain must be an array\");if(typeof $predicate!==\"function\")throw new ValueError(\"invalid-construction\",\"{id} predicate must be a function\");for(const $item of $domain){{const $verdict=await $predicate($item);if(typeof $verdict!==\"boolean\")throw new ValueError(\"invalid-construction\",\"{id} predicate must return a boolean\");if($verdict==={stop})return {stop};}}return {end};}})({},{})",
                if await_result { "await " } else { "" },
                parts[0],
                parts[1]
            );
        }
        let mut parts = parts.to_vec();
        if id == "active_member" {
            if let Some(done) = self.lower_active_member_rendered(awaited, &mut parts, span) {
                return done;
            }
        }
        if id == "app_url" {
            // Only the resolved builtin receives the trusted host context.
            // Source arguments retain their existing once-only ordering.
            parts.insert(0, "c".to_string());
        }
        if id == "sum" {
            if let Some(done) = self.lower_sum_rendered(&mut parts, domain_type, span) {
                return done;
            }
        }
        self.stdlib.insert(id.clone());
        self.builtins.push(ReferencedBuiltin {
            id: id.clone(),
            span,
        });
        let call = format!("{}({})", id, parts.join(","));
        if awaited && await_result {
            format!("await {call}")
        } else {
            call
        }
    }

    fn lower_derive_field_rendered(
        &mut self,
        canonical: &String,
        parts: &[String],
        span: Span,
        await_result: bool,
    ) -> Option<String> {
        let index = self.by_canonical.get(canonical)?;
        let item = &self.ir.items[*index];
        if let IrItemKind::DeriveField {
            expr: Some(expr), ..
        } = &item.kind
        {
            if parts.len() == 1 && self.boolean_sources.contains_key(&expr.span) {
                self.stdlib.insert("nativeReadBoolean".into());
                return Some(format!(
                    "{}nativeReadBoolean(c,$can$boolean${},{})",
                    if await_result { "await " } else { "" },
                    item.id.0,
                    parts[0]
                ));
            }
            self.unsupported(
                "derived Boolean read",
                "original checked observer unavailable",
                span,
            );
            return Some(self.throw_expr("unsupported Boolean observer"));
        }
        None
    }

    fn lower_capability_op_rendered(
        &mut self,
        canonical: &String,
        parts: &[String],
        span: Span,
        await_result: bool,
    ) -> String {
        if self.in_hook() && !self.hook_native() {
            return self.hook_gap(
                "hook capability call",
                "capability calls need the ambient context, which legacy hooks do not receive",
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

    fn lower_call_rendered(
        &mut self,
        target: &IrCallTarget,
        parts: &[String],
        domain_type: Option<&ResolvedType>,
        span: Span,
        await_result: bool,
        async_scoped: bool,
        hook_derive: HookDerive,
    ) -> String {
        match target {
            IrCallTarget::Builtin { id, awaited } => {
                self.lower_builtin_rendered(id, *awaited, parts, domain_type, span, await_result, async_scoped)
            }
            IrCallTarget::DeriveFn(canonical) => {
                if self.source_data_body {
                    let helper=self.ir.items.iter().find(|item|item.canonical==*canonical).cloned();
                    if let Some(IrItem{kind:IrItemKind::DeriveFn{params,expr:Some(body),..},..})=helper {
                        if params.len()!=parts.len() { self.unsupported("effect DATA helper","original supplied formal census differs",span);return self.throw_expr("effect DATA helper formal mismatch"); }
                        self.enter_scope();
                        let signature=params.iter().map(|id|self.bind(&self.ir.items[id.0 as usize].name.clone())).collect::<Vec<_>>().join(",");
                        let value=self.lower_expr(&body);self.exit_scope();
                        return format!("{}(async({signature})=>({value}))({})",if await_result{"await "}else{""},parts.join(","));
                    }
                }
                if let Some(specialized)=self.lower_source_require_derive(canonical,parts,span,await_result) {return specialized;}
                if let Some(specialized) =
                    self.lower_derive_field_rendered(canonical, parts, span, await_result)
                {
                    return specialized;
                }
                if let Some(specialized) =
                    self.lower_receipt_derive(canonical, parts, span, await_result)
                {
                    return specialized;
                }
                if self.in_hook() && !self.hook_native() {
                    return self.hook_gap(
                        "hook derive call",
                        "derive calls need the ambient context (c), which legacy hooks do not receive",
                        span,
                    );
                }
                match hook_derive {
                    HookDerive::Refuse => {
                        self.unsupported(
                            "hook derive call",
                            "linkage arguments need their record-parameter hook variant",
                            span,
                        );
                        return self.throw_expr("unsupported hook derive linkage");
                    }
                    HookDerive::Hook((variant, site, is_reference)) => {
                        // Per-use variant selection: the same helper reused
                        // across parent and reference linkages records one
                        // loader-correct variant per kind; each emitted
                        // variant never mixes loaders.
                        if is_reference {
                            self.hook_variant_reference.insert(canonical.clone());
                        } else {
                            self.hook_variant_parent.insert(canonical.clone());
                        }
                        // Nested linkage inside a variant body inherits the
                        // outer kind via the `Hook` payload above, so the
                        // per-kind bookkeeping here already carries it —
                        // no extra handling beyond the parent/reference
                        // sets is needed.
                        self.derive_calls.insert(canonical.clone());
                        let mut all = vec!["c".to_string(), site];
                        all.extend(parts.iter().cloned());
                        return format!(
                            "{}{}({})",
                            if await_result { "await " } else { "" },
                            variant,
                            all.join(",")
                        );
                    }
                    HookDerive::AsIs => {}
                }
                if self.generic_boolean_body { self.generic_boolean_derives.insert(canonical.clone()); }
                if self.owner_handler_body {
                    if self.retained_owner_body { self.retained_owner_derives.insert(canonical.clone()); }
                    else { self.owner_handler_derives.insert(canonical.clone()); }
                }
                let name = match self.by_canonical.get(canonical) {
                    Some(index) => binding_ident(
                        if self.generic_boolean_body {
                            "v"
                        } else if self.retained_owner_body {
                            "t"
                        } else if self.owner_handler_body {
                            "o"
                        } else if (self.boolean_body || self.authority_body)
                            && !(self.authority_body && self.authority_queries
                                .is_some_and(|prepared| prepared.reaches(span)))
                            && self.boolean_derives.contains(canonical)
                        {
                            "b"
                        } else {
                            "s"
                        },
                        &self.ir.items[*index].canonical,
                    ),
                    None => {
                        self.unsupported(
                            "derive call",
                            &format!("{canonical} is not a known symbol"),
                            span,
                        );
                        return self.throw_expr(&format!("unknown derive {canonical}"));
                    }
                };
                self.derive_calls.insert(canonical.clone());
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
                self.lower_capability_op_rendered(canonical, parts, span, await_result)
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
                        let template = if self.receipt_decision(current.span) {
                            self.receipt_binary_template(*op, current.span, template)
                        } else {
                            template
                        };
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
        if expr_uses_async(expr) || self.implicit_expr_uses_async(expr) {
            format!("await (async()=>{{{body}return {value};}})()")
        } else {
            format!("(()=>{{{body}return {value};}})()")
        }
    }

    fn is_model_reference(&self, ty: &ResolvedType) -> bool {
        let mut ty = ty;
        while let ResolvedType::Nullable(inner) = ty {
            ty = inner;
        }
        matches!(ty, ResolvedType::Record { symbol, .. }
            if matches!(self.ir.items[symbol.0 as usize].kind, IrItemKind::Model { .. }))
    }

    fn model_reference_comparison(&mut self, nullable: bool, l: &str, r: &str) -> String {
        self.stdlib.insert("same".to_string());
        if nullable {
            // Preserve operand order and evaluate each operand only once.
            format!(
                "(($left,$right)=>$left===null||$right===null?$left===$right:same($left,$right))({l},{r})"
            )
        } else {
            format!("same({l},{r})")
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
                let comparison =
                    if self.is_model_reference(element) && self.is_model_reference(&left.ty) {
                        self.model_reference_comparison(
                            matches!(element.as_ref(), ResolvedType::Nullable(_))
                                || matches!(left.ty, ResolvedType::Nullable(_)),
                            "$member",
                            "$item",
                        )
                    } else {
                        self.stdlib.insert("equalValue".to_string());
                        let type_id = self.canonical_type_id(element, span);
                        self.value_equality_call(element, &type_id, "$member", "$item", span)
                    };
                format!("(($member,$collection)=>$collection.some($item=>{comparison}))({l},{r})")
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

    /// Contract positions use the same checked declaration inventory as the
    /// artifact and native codecs. No runtime shape grants Contract identity.
    fn equality_needs_schema(&self, ty: &ResolvedType) -> bool {
        match ty {
            ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } => {
                self.equality_needs_schema(inner)
            }
            ResolvedType::Record { symbol, .. } => {
                self.ir.items.get(symbol.0 as usize).is_some_and(|item| {
                    matches!(
                        item.kind,
                        IrItemKind::Contract { .. }
                            | IrItemKind::Judgment { .. }
                            | IrItemKind::JudgmentGenerated(IrJudgmentGenerated::Contract { .. })
                    )
                })
            }
            ResolvedType::StdNominal { .. } => true,
            ResolvedType::Union(arms) => arms.iter().any(|symbol| {
                self.equality_needs_schema(&ResolvedType::Record {
                    symbol: *symbol,
                    stored: false,
                })
            }),
            _ => false,
        }
    }

    fn value_equality_call(
        &mut self,
        ty: &ResolvedType,
        id: &str,
        l: &str,
        r: &str,
        span: Span,
    ) -> String {
        if self.equality_needs_schema(ty) {
            let mut base = ty;
            while let ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } =
                base
            {
                base = inner;
            }
            let admitted = match base {
                ResolvedType::Union(arms) => self.value_types.as_ref().is_some_and(|inventory| {
                    arms.iter().all(|symbol| {
                        self.ir.items.get(symbol.0 as usize).is_some_and(|item| {
                            matches!(
                                item.kind,
                                IrItemKind::Model { .. } | IrItemKind::Event { .. }
                            ) || inventory
                                .contracts
                                .iter()
                                .any(|contract| contract.name == item.canonical)
                        })
                    })
                }),
                _ => self.nominal_value_type(base).is_some(),
            };
            if !admitted {
                self.unsupported(
                    "Contract equality schema",
                    "no complete checked owning Contract inventory",
                    span,
                );
                return self.throw_expr("Contract equality schema");
            }
            self.equality_schema = true;
            format!(
                "equalValue({}, {l},{r},undefined,$valueSchema)",
                js_string(id)
            )
        } else {
            let separator = if l == "$member" { "" } else { " " };
            format!("equalValue({},{separator}{l},{r})", js_string(id))
        }
    }

    /// Normalize the existing source-owned inventory once, after declaration
    /// emission. Normal functions and hook closures share this module-local
    /// immutable schema; presentation metadata is not a Values descriptor.
    fn emit_equality_schema(&mut self, out: &mut JsWriter, span: Span) {
        if !self.equality_schema {
            return;
        }
        let Some(inventory) = &self.value_types else {
            self.unsupported(
                "Contract equality schema",
                "no checked owning value inventory",
                span,
            );
            return;
        };
        let contracts = inventory
            .contracts
            .iter()
            .map(|contract| {
                let fields = contract
                    .fields
                    .iter()
                    .map(|field| format!("{}:{}", js_string(&field.name), field.schema_json()))
                    .collect::<Vec<_>>()
                    .join(",");
                format!("{}:{{fields:{{{fields}}}}}", js_string(&contract.name))
            })
            .collect::<Vec<_>>()
            .join(",");
        let enums = inventory
            .enums
            .iter()
            .map(|enumeration| {
                format!(
                    "{}:{{cases:{}}}",
                    js_string(&enumeration.name),
                    descriptor_json(&enumeration.cases)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let aliases = inventory
            .aliases
            .iter()
            .map(|alias| {
                let leaf = JsNominalLeaf {
                    name: alias.name.clone(),
                    declared: alias.declared.clone(),
                    constraints: alias.constraints.clone(),
                };
                format!("{}:{}", js_string(&alias.name), leaf.schema_json())
            })
            .collect::<Vec<_>>()
            .join(",");
        self.stdlib.insert("normalizeSchema".to_string());
        out.push(span, None, &format!(
            "const $valueSchema=normalizeSchema({{contracts:{{{contracts}}},enums:{{{enums}}},aliases:{{{aliases}}}}});"
        ));
    }

fn null_equality(
    left: &TypedExpr,
    right: &TypedExpr,
    l: &str,
    r: &str,
    negate: bool,
) -> Option<String> {
    if !(matches!(left.ty, ResolvedType::Null) || matches!(right.ty, ResolvedType::Null)) {
        return None;
    }
    let js_op = if negate { "!==" } else { "===" };
    Some(format!(
        "{} {js_op} {}",
        parenthesize_operand(l, &left.expr),
        parenthesize_operand(r, &right.expr)
    ))
}

    fn record_identity_equality(
        &mut self,
        left: &TypedExpr,
        right: &TypedExpr,
        l: &str,
        r: &str,
        negate: bool,
    ) -> Option<String> {
        if !(matches!(left.ty, ResolvedType::Record { .. })
            || matches!(right.ty, ResolvedType::Record { .. }))
        {
            return None;
        }
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
        if structural {
            return None;
        }
        self.stdlib.insert("same".to_string());
        Some(negate_call(negate, &format!("same({l},{r})")))
    }

    fn lower_ordered_scalar_equality(
        &mut self,
        l_family: Option<ScalarFamily>,
        r_family: Option<ScalarFamily>,
        left: &TypedExpr,
        right: &TypedExpr,
        span: Span,
        l: &str,
        r: &str,
        negate: bool,
    ) -> String {
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
                format!(
                    "{} {js_op} {}",
                    parenthesize_operand(l, &left.expr),
                    parenthesize_operand(r, &right.expr)
                )
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
        // `null` against any nullable side compares directly. Composite
        // operands keep their own parens: `??`/`&&`/`||` bind looser than
        // `===`, so an unparenthesized `a ?? b === null` would read as
        // `a ?? (b === null)`.
        if let Some(comparison) = Self::null_equality(left, right, l, r, negate) {
            return comparison;
        }
        // Nullable values must apply the owning null rules before a scalar
        // comparator or reference helper sees either operand. Hooks reuse
        // the same null-safe path except where decimal/money keep their
        // existing hook qualification below.
        let decimal_money = [left, right].iter().any(|side| {
            matches!(
                scalar_family(&side.ty),
                Some(ScalarFamily::Decimal | ScalarFamily::Money)
            )
        });
        if (!self.in_hook() || !decimal_money)
            && (matches!(left.ty, ResolvedType::Nullable(_))
                || matches!(right.ty, ResolvedType::Nullable(_)))
        {
            if self.is_model_reference(&left.ty) && self.is_model_reference(&right.ty) {
                let comparison = self.model_reference_comparison(true, l, r);
                return negate_call(negate, &comparison);
            }
            self.stdlib.insert("equalValue".to_string());
            let ty = if matches!(left.ty, ResolvedType::Nullable(_)) {
                &left.ty
            } else {
                &right.ty
            };
            let id = self.canonical_type_id(ty, span);
            let comparison = self.value_equality_call(ty, &id, l, r, span);
            return negate_call(negate, &comparison);
        }
        // Stored rows compare by reference identity; contracts, arrays and
        // objects compare structurally so they are never compared by
        // JavaScript object identity.
        if let Some(comparison) = self.record_identity_equality(left, right, l, r, negate) {
            return comparison;
        }
        if is_structural(&left.ty) || is_structural(&right.ty) {
            // `equalValue` is pure values logic over in-memory snapshot
            // values: it needs no store, carrier, or ambient context, so
            // it lowers identically inside hooks. (Decimal/money scalars
            // keep their own hook refusal below per the T31 pin.)
            self.stdlib.insert("equalValue".to_string());
            let id = self.canonical_type_id(&left.ty, span);
            let comparison = self.value_equality_call(&left.ty, &id, l, r, span);
            return negate_call(negate, &comparison);
        }
        let l_family = scalar_family(&left.ty);
        let r_family = scalar_family(&right.ty);
        match (l_family, r_family) {
            (Some(ScalarFamily::Money), Some(ScalarFamily::Money)) => {
                self.stdlib.insert("equalMoney".to_string());
                negate_call(negate, &format!("equalMoney({l},{r})"))
            }
            (Some(ScalarFamily::Decimal), Some(ScalarFamily::Decimal | ScalarFamily::Int))
            | (Some(ScalarFamily::Int), Some(ScalarFamily::Decimal)) => {
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
            ) => self.lower_ordered_scalar_equality(
                l_family, r_family, left, right, span, l, r, negate,
            ),
            (
                Some(ScalarFamily::Bool | ScalarFamily::Text | ScalarFamily::Enum),
                Some(ScalarFamily::Bool | ScalarFamily::Text | ScalarFamily::Enum),
            ) => {
                // Composite operands keep their own parens: `??`/`&&`/`||`
                // bind looser than `===`, so an unparenthesized
                // `a ?? b === false` would read as `a ?? (b === false)`.
                let js_op = if negate { "!==" } else { "===" };
                format!(
                    "{} {js_op} {}",
                    parenthesize_operand(l, &left.expr),
                    parenthesize_operand(r, &right.expr)
                )
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
    /// against zero for money/decimal/date/datetime/text, direct comparison
    /// for BigInt integers/durations. Mixed int/decimal operands stay exact.
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
            (Some(ScalarFamily::Decimal), Some(ScalarFamily::Decimal))
            | (Some(ScalarFamily::Decimal), Some(ScalarFamily::Int))
            | (Some(ScalarFamily::Int), Some(ScalarFamily::Decimal)) => {
                self.stdlib.insert("compareDecimal".to_string());
                format!("compareDecimal({l},{r}) {js_op} 0")
            }
            (Some(ScalarFamily::Text), Some(ScalarFamily::Text)) => {
                self.stdlib.insert("compareScalar".to_string());
                format!("compareScalar({l},{r}) {js_op} 0")
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
            | (Some(ScalarFamily::Duration), Some(ScalarFamily::Duration)) => {
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
    /// and `subtractDuration`, plus checked duration ratio/remainder/scaling.
    /// Decimal operands mix with `int` exactly (helpers take `int|decimal`);
    /// scalar-first money products normalize to
    /// `multiplyMoney(money, factor)`; a `money`/`money` ratio is
    /// `divideDecimal`. Shapes with no verified helper stay `E6008`.
    fn unsupported_arithmetic(
        &mut self,
        left: &TypedExpr,
        right: &TypedExpr,
        span: Span,
        js_op: &str,
    ) -> String {
        let l_id = self.canonical_type_id(&left.ty, span);
        let r_id = self.canonical_type_id(&right.ty, span);
        self.unsupported(
            "arithmetic",
            &format!("{l_id} {js_op} {r_id} has no §13 lowering"),
            span,
        );
        self.throw_expr("arithmetic has no lowering")
    }

    fn lower_money_arithmetic(
        &mut self,
        l_family: Option<ScalarFamily>,
        r_family: Option<ScalarFamily>,
        op: IrBinOp,
        l: &str,
        r: &str,
        js_op: &str,
        span: Span,
    ) -> Option<String> {
        match (l_family, r_family) {
            (Some(ScalarFamily::Money), Some(ScalarFamily::Money)) => match op {
                IrBinOp::Add | IrBinOp::Sub => {
                    let name = if op == IrBinOp::Add {
                        "addMoney"
                    } else {
                        "subtractMoney"
                    };
                    self.stdlib.insert(name.to_string());
                    Some(format!("{name}({l},{r})"))
                }
                // A money/money ratio has no currency unit and uses decimal
                // rounding: `divideDecimal` documents money operands.
                IrBinOp::Div => {
                    self.stdlib.insert("divideDecimal".to_string());
                    Some(format!("divideDecimal({l},{r})"))
                }
                _ => {
                    self.unsupported(
                        "money arithmetic",
                        &format!("money {js_op} money has no §13 lowering"),
                        span,
                    );
                    Some(self.throw_expr("money arithmetic has no lowering"))
                }
            },
            (Some(ScalarFamily::Money), Some(ScalarFamily::Decimal))
            | (Some(ScalarFamily::Money), Some(ScalarFamily::Int)) => match op {
                IrBinOp::Mul => {
                    self.stdlib.insert("multiplyMoney".to_string());
                    Some(format!("multiplyMoney({l},{r})"))
                }
                IrBinOp::Div => {
                    self.stdlib.insert("divideMoney".to_string());
                    Some(format!("divideMoney({l},{r})"))
                }
                _ => {
                    self.unsupported(
                        "money arithmetic",
                        &format!("money {js_op} factor has no §13 lowering"),
                        span,
                    );
                    Some(self.throw_expr("money arithmetic has no lowering"))
                }
            },
            // Scalar-first money products normalize money-first: lane-02
            // `multiplyMoney(m, factor)` takes the money operand first.
            (Some(ScalarFamily::Decimal), Some(ScalarFamily::Money))
            | (Some(ScalarFamily::Int), Some(ScalarFamily::Money)) => match op {
                IrBinOp::Mul => {
                    self.stdlib.insert("multiplyMoney".to_string());
                    Some(format!("multiplyMoney({r},{l})"))
                }
                _ => {
                    self.unsupported(
                        "money arithmetic",
                        &format!("factor {js_op} money has no §13 lowering"),
                        span,
                    );
                    Some(self.throw_expr("money arithmetic has no lowering"))
                }
            },
            _ => None,
        }
    }

    fn lower_temporal_arithmetic(
        &mut self,
        l_family: Option<ScalarFamily>,
        r_family: Option<ScalarFamily>,
        op: IrBinOp,
        l: &str,
        r: &str,
        js_op: &str,
        span: Span,
    ) -> Option<String> {
        match (l_family, r_family) {
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
                    Some(format!("{name}({l},{r})"))
                }
                _ => {
                    self.unsupported(
                        "decimal arithmetic",
                        &format!("decimal {js_op} decimal has no §13 lowering"),
                        span,
                    );
                    Some(self.throw_expr("decimal arithmetic has no lowering"))
                }
            },
            (Some(ScalarFamily::Datetime), Some(ScalarFamily::Datetime)) => match op {
                IrBinOp::Sub => {
                    self.stdlib.insert("durationBetween".to_string());
                    Some(format!("durationBetween({l},{r})"))
                }
                _ => {
                    self.unsupported(
                        "datetime arithmetic",
                        &format!("datetime {js_op} datetime has no §13 lowering"),
                        span,
                    );
                    Some(self.throw_expr("datetime arithmetic has no lowering"))
                }
            },
            (Some(ScalarFamily::Duration), Some(ScalarFamily::Duration))
                if matches!(op, IrBinOp::Div | IrBinOp::Mod) =>
            {
                let name = if op == IrBinOp::Div {
                    "divideDurationMs"
                } else {
                    "remainderDuration"
                };
                self.stdlib.insert(name.to_string());
                Some(format!("{name}({l},{r})"))
            }
            (Some(ScalarFamily::Int), Some(ScalarFamily::Duration)) if op == IrBinOp::Mul => {
                self.stdlib.insert("multiplyDuration".to_string());
                // Capture authored operands once, left-to-right (including
                // awaits/throws), before normalizing the helper's argument order.
                Some(format!("(($factor,$duration)=>multiplyDuration($duration,$factor))({l},{r})"))
            }
            (Some(ScalarFamily::Datetime), Some(ScalarFamily::Duration))
            | (Some(ScalarFamily::Duration), Some(ScalarFamily::Duration)) => match op {
                IrBinOp::Add | IrBinOp::Sub => {
                    let name = if op == IrBinOp::Add {
                        "addDuration"
                    } else {
                        "subtractDuration"
                    };
                    self.stdlib.insert(name.to_string());
                    Some(format!("{name}({l},{r})"))
                }
                _ => {
                    self.unsupported(
                        "duration arithmetic",
                        &format!("duration {js_op} has no §13 lowering"),
                        span,
                    );
                    Some(self.throw_expr("duration arithmetic has no lowering"))
                }
            },
            _ => None,
        }
    }

    fn lower_arithmetic(
        &mut self,
        op: IrBinOp,
        left: &TypedExpr,
        right: &TypedExpr,
        span: Span,
        l: &str,
        r: &str,
    ) -> String {
        fn supplied_array_element(ty: &ResolvedType) -> bool {
            match ty {
                ResolvedType::Scalar(_)
                | ResolvedType::Enum { .. }
                | ResolvedType::Record { .. } => true,
                ResolvedType::StdNominal { .. } => {
                    crate::analysis::types::checked_standard_nominal_name(ty).is_some()
                }
                ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } => {
                    supplied_array_element(inner)
                }
                _ => false,
            }
        }
        if op == IrBinOp::Add
            && let (
                ResolvedType::Array { element: left, .. },
                ResolvedType::Array { element: right, .. },
            ) = (&left.ty, &right.ty)
            && left == right
            && supplied_array_element(left)
        {
            // The installed Values helper preserves ordered elements and
            // references without mutating either supplied array. JavaScript
            // call arguments retain authored once/left-to-right evaluation.
            self.stdlib.insert("concat".to_string());
            return format!("concat({l},{r})");
        }
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
            (Some(ScalarFamily::Money), _)
            | (_, Some(ScalarFamily::Money)) => self
                .lower_money_arithmetic(
                    scalar_family(&left.ty),
                    scalar_family(&right.ty),
                    op,
                    l,
                    r,
                    js_op,
                    span,
                )
                .unwrap_or_else(|| self.unsupported_arithmetic(left, right, span, js_op)),
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
            _ => self
                .lower_temporal_arithmetic(
                    scalar_family(&left.ty),
                    scalar_family(&right.ty),
                    op,
                    l,
                    r,
                    js_op,
                    span,
                )
                .unwrap_or_else(|| self.unsupported_arithmetic(left, right, span, js_op)),
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

    /// Data-only `where` AST for authority decision bodies (REVIEW-9 gap
    /// 3): decision mode refuses callback predicates, so an authority-body
    /// model query with a data-only filter lowers to the `QueryPredicate`
    /// AST the host passes straight to `decision.query`. Returns `None`
    /// when the predicate is not data-only expressible; the caller keeps
    /// the ordinary callback emission (still refused fail-closed).
    /// Viewer/ordinary bodies never take this path, so their emission is
    /// byte-identical.
    fn lower_authority_where(query: &crate::codegen::ir::IrQuery) -> Option<String> {
        let pred = query.where_pred.as_ref()?;
        Self::data_only_predicate(pred, &query.where_param)
    }

    /// One predicate node to its `QueryPredicate` AST, or `None` when the
    /// shape cannot serve data-only.
    fn data_only_predicate(pred: &TypedExpr, row: &str) -> Option<String> {
        match &pred.expr {
            IrExpr::Binary { op, left, right } => match op {
                IrBinOp::And => Some(format!(
                    "{{op:\"and\",args:[{},{}]}}",
                    Self::data_only_predicate(left, row)?,
                    Self::data_only_predicate(right, row)?
                )),
                IrBinOp::Or => Some(format!(
                    "{{op:\"or\",args:[{},{}]}}",
                    Self::data_only_predicate(left, row)?,
                    Self::data_only_predicate(right, row)?
                )),
                IrBinOp::Eq
                | IrBinOp::Ne
                | IrBinOp::Lt
                | IrBinOp::Le
                | IrBinOp::Gt
                | IrBinOp::Ge => Self::data_only_comparison(*op, left, right, row),
                _ => None,
            },
            IrExpr::Unary {
                op: IrUnOp::Not,
                operand,
            } => Some(format!(
                "{{op:\"not\",arg:{}}}",
                Self::data_only_predicate(operand, row)?
            )),
            // A bare boolean field reads as an equality against true.
            IrExpr::Member { .. } => {
                let (field, ty) = Self::row_field(pred, row)?;
                if !matches!(
                    ty.nullable_inner().unwrap_or(ty),
                    ResolvedType::Scalar(Scalar::Bool)
                ) {
                    return None;
                }
                Some(format!(
                    "{{op:\"eq\",field:{},value:true}}",
                    js_string(field)
                ))
            }
            _ => None,
        }
    }

    /// A single-level `row.field` access over the query parameter with its
    /// checked field type, or `None`.
    fn row_field<'e>(expr: &'e TypedExpr, row: &str) -> Option<(&'e str, &'e ResolvedType)> {
        if let IrExpr::Member { base, field } = &expr.expr
            && let IrExpr::Name(root) = &base.expr
            && root.as_str() == row
        {
            return Some((field.as_str(), &expr.ty));
        }
        None
    }

    /// One field comparison to its AST, or `None`. The field may sit on
    /// either side (`0 < stock` swaps the operator); the other side must
    /// be a side-effect-free literal. Names are never values: a caller
    /// binding would evaluate once instead of per row.
    fn data_only_comparison(
        op: IrBinOp,
        left: &TypedExpr,
        right: &TypedExpr,
        row: &str,
    ) -> Option<String> {
        let (field, ty, value, swapped) =
            match (Self::row_field(left, row), Self::row_field(right, row)) {
                (Some((field, ty)), None) => (field, ty, right, false),
                (None, Some((field, ty))) => (field, ty, left, true),
                _ => return None,
            };
        let nullable = ty.nullable_inner().is_some();
        let scalar = ty.nullable_inner().unwrap_or(ty);
        // Null-literal compares become null tests; only `==`/`!=` admit
        // them, exactly like the SQL adapters.
        if matches!(value.expr, IrExpr::Null) {
            return match op {
                IrBinOp::Eq => Some(format!("{{op:\"is_null\",field:{}}}", js_string(field))),
                IrBinOp::Ne => Some(format!("{{op:\"not_null\",field:{}}}", js_string(field))),
                _ => None,
            };
        }
        let op_name = match op {
            IrBinOp::Eq => "eq",
            IrBinOp::Ne if !nullable => "ne",
            IrBinOp::Lt | IrBinOp::Le | IrBinOp::Gt | IrBinOp::Ge
                if !nullable && matches!(scalar, ResolvedType::Scalar(Scalar::Int)) =>
            {
                match (op, swapped) {
                    (IrBinOp::Lt, false) | (IrBinOp::Gt, true) => "lt",
                    (IrBinOp::Le, false) | (IrBinOp::Ge, true) => "lte",
                    (IrBinOp::Gt, false) | (IrBinOp::Lt, true) => "gt",
                    (IrBinOp::Ge, false) | (IrBinOp::Le, true) => "gte",
                    _ => return None,
                }
            }
            _ => return None,
        };
        if matches!(op, IrBinOp::Eq | IrBinOp::Ne)
            && !matches!(
                scalar,
                ResolvedType::Scalar(Scalar::Text | Scalar::Bool | Scalar::Int)
            )
        {
            return None;
        }
        let value = Self::data_only_value(value)?;
        Some(format!(
            "{{op:\"{op_name}\",field:{},value:{value}}}",
            js_string(field)
        ))
    }

    /// A side-effect-free literal filter value, or `None`. Ints emit the
    /// canonical Values int wire (decimal strings, never JSON numbers and
    /// never `BigInt`: stored ints are int64 decimal strings, so a JSON
    /// number would never match and plain string comparison would
    /// misorder); the host compares them numerically with no `Number`
    /// routing. Out-of-int64-range ints stay on the callback path instead
    /// of losing precision.
    fn data_only_value(value: &TypedExpr) -> Option<String> {
        match &value.expr {
            IrExpr::Int(int) => {
                const MAX: i128 = 9_223_372_036_854_775_807;
                const MIN: i128 = -9_223_372_036_854_775_808;
                if *int < MIN || *int > MAX {
                    return None;
                }
                Some(js_string(&int.to_string()))
            }
            IrExpr::Text(text) => Some(js_string(text)),
            IrExpr::Bool(bool) => Some(bool.to_string()),
            _ => None,
        }
    }

    /// Checked defining-source origin for one scenario item, or `None`.
    /// The owning module must agree with the scenario's declaring file,
    /// and that file must resolve through the checked committed-source
    /// inventory — the emitted path/sha then name the exact bytes the
    /// host cross-checks in `artifact.sources` (same shape as the rule
    /// origins). Anything less is omitted, never guessed.
    fn defining_source_origin(ir: &IrProgram, item: &IrItem) -> Option<serde_json::Value> {
        let owning = ir.modules.get(item.module.0 as usize)?;
        if owning.file != item.span.file {
            return None;
        }
        let (_, path, sha256) = ir
            .committed_sources
            .sources
            .iter()
            .find(|(id, _, _)| *id == item.span.file)?;
        Some(serde_json::json!({"path": path, "sha256": sha256, "module": owning.name}))
    }

    /// Stored-order keys and Value comparator closures have distinct source
    /// domains. Verify their checked correspondence before any query lowering.
    fn query_order_matches_domain(&self, query: &crate::codegen::ir::IrQuery) -> bool {
        !(match &query.domain {
            super::ir::IrQueryDomain::Model(model) => query.value_order.is_some() && (!query.order.is_empty() || !query.source.as_ref().is_some_and(|source| {
                let ty = match &source.domain_type { ResolvedType::Array { element, .. } => element.as_ref(), ty => ty };
                matches!(ty, ResolvedType::Record { symbol, .. } if self.ir.items.get(symbol.0 as usize).is_some_and(|item| item.canonical == *model && matches!(item.kind, IrItemKind::Model { .. })))
            })),
            super::ir::IrQueryDomain::Value { .. } => !query.order.is_empty(),
        })
    }

    /// Lower a query to `await records(c, model, {parent?, where?, order?,
    /// limit?, archived?})`: `records()` returns a promise and viewer read
    /// grants apply before filters and projection.
    fn lower_transcript_selection(
        &mut self,
        query: &crate::codegen::ir::IrQuery,
        capture: &NativeQuerySource,
        span: Span,
    ) -> Option<String> {
        let transcript = capture.transcripts.iter().find(|fact| {
            query
                .source
                .as_ref()
                .is_some_and(|source| source.node == fact.query.node)
                && self.receipt_calls.as_slice()
                    == [Span::new(fact.call.file, fact.call.start, fact.call.end)]
        })?;
        let (Some(projection), Some(param)) =
            (query.select.as_ref(), query.select_param.as_ref())
        else {
            self.unsupported(
                "transcript selection",
                "original checked projection and alias are required",
                span,
            );
            return Some(self.throw_expr("unsupported transcript selection"));
        };
        self.enter_scope();
        let param = self.bind(param);
        let body = self.lower_expr(projection);
        self.exit_scope();
        self.stdlib.insert("executeScenarioReceiptQuery".into());
        self.stdlib
            .insert("bindScenarioReceiptQuerySelection".into());
        // The engine owns position ordering. Read the actual selected
        // views in that order, retaining the whole eager array before
        // the owning receiver binds it; a failure stops the next row.
        Some(format!(
            "(await (async()=>{{const $querySelected=await executeScenarioReceiptQuery(c,{},async()=>true);const $queryMessages=[];for(const {param} of $querySelected){{$queryMessages.push(await ({body}));}}return await bindScenarioReceiptQuerySelection(c,$querySelected,$queryMessages);}})())",
            js_string(&transcript.id)
        ))
    }

    fn lower_inline_selection(
        &mut self,
        query: &crate::codegen::ir::IrQuery,
        capture: &NativeQuerySource,
        span: Span,
    ) -> Option<String> {
        let selection = capture.inline_selections.iter().find(|fact| {
            query
                .source
                .as_ref()
                .is_some_and(|source| source.node == fact.query.node)
                && self.receipt_calls.is_empty()
        })?;
        let (Some(parent), Some(predicate), Some(projection), Some(param)) = (
            query.parent.as_ref(),
            query.where_pred.as_ref(),
            query.select.as_ref(),
            query.select_param.as_ref(),
        ) else {
            self.unsupported(
                "inline selection",
                "original checked domain, predicate and projection are required",
                span,
            );
            return Some(self.throw_expr("unsupported inline selection"));
        };
        // Observe the original stored parent before query admission. The
        // supplied bound remains in the per-candidate predicate.
        let parent = self.lower_expr(parent);
        self.enter_scope();
        let row = self.bind(&query.where_param);
        let predicate = self.lower_expr(predicate);
        self.exit_scope();
        self.enter_scope();
        let param = self.bind(param);
        let projection = self.lower_expr(projection);
        self.exit_scope();
        self.stdlib.insert("executeScenarioReceiptQuery".into());
        self.stdlib
            .insert("bindScenarioReceiptQuerySelection".into());
        Some(format!(
            "(await (async()=>{{await ({parent});const $querySelected=await executeScenarioReceiptQuery(c,{},async({row})=>{predicate});const $queryMessages=[];for(const {param} of $querySelected){{$queryMessages.push(await ({projection}));}}return await bindScenarioReceiptQuerySelection(c,$querySelected,$queryMessages);}})())",
            js_string(&selection.query.id)
        ))
    }

    fn lower_model_where_opt(
        &mut self,
        query: &crate::codegen::ir::IrQuery,
        pred: &TypedExpr,
        opts: &mut Vec<String>,
        source_checked_authority: bool,
    ) {
        // REVIEW-9 gap 3: authority decision bodies lower
        // data-only filters to the predicate AST; anything
        // else keeps the ordinary callback below (still
        // refused fail-closed by decision mode).
        let authority_ast = if self.authority_body && !query.where_async && !source_checked_authority {
            Self::lower_authority_where(query)
        } else {
            None
        };
        if let Some(ast) = authority_ast {
            opts.push(format!("where:{ast}"));
            return;
        }
        self.enter_scope();
        let row = self.bind(&query.where_param);
        let in_hook = self.hook_closure_tracked();
        if in_hook {
            self.hook_closure_depth += 1;
        }
        let body = self.lower_expr(pred);
        if in_hook {
            self.hook_closure_depth -= 1;
        }
        self.exit_scope();
        if self.native_source_predicates {
            let prefix = if query.where_async || self.boolean_body || self.implicit_expr_uses_async(pred) {
                "async"
            } else {
                ""
            };
            let predicate = format!(
                "{prefix}({row},$can$read$c)=>{{const c=$can$read$c;return {body};}}"
            );
            if let Some(source) = self.membership_predicates.get(&pred.span) {
                opts.push(format!(
                    "where:$can$read$issue({},{predicate})",
                    js_string(&descriptor_json(source))
                ));
                opts.push(format!("whereSource:{}", descriptor_json(source)));
            } else {
                opts.push(format!("where:{predicate}"));
            }
        } else if query.where_async || self.boolean_body || self.implicit_expr_uses_async(pred) {
            opts.push(format!("where:async({row})=>{body}"));
        } else {
            opts.push(format!("where:({row})=>{body}"));
        }
    }

    fn lower_value_domain(
        &mut self,
        query: &crate::codegen::ir::IrQuery,
        base: &TypedExpr,
        alias: &str,
    ) -> String {
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
            out = if query.where_async || self.boolean_body || self.implicit_expr_uses_async(pred) {
                format!(
                    "(await (async($items)=>{{const $result=[];for(const {alias} of $items){{if(await ({body}))$result.push({alias});}}return $result;}})({out}))"
                )
            } else {
                format!("{out}.filter(({alias})=>{body})")
            };
        }
        if let Some(order) = &query.value_order {
            self.enter_scope();
            let alias = self.bind(alias);
            let key = self.lower_expr(&order.key);
            self.exit_scope();
            let asynchronous = expr_uses_async(&order.key) || self.boolean_body || self.implicit_expr_uses_async(&order.key);
            let (awaited, asynchronous_fn) = if asynchronous {
                ("await ", "async")
            } else {
                ("", "")
            };
            let compared = self.lower_value_order_comparison(&order.key);
            let direction = if order.descending {
                "-$compared"
            } else {
                "$compared"
            };
            // Decorate once before sorting: authored expressions never run
            // inside a comparator, even for singleton or tied domains.
            out = format!(
                "({awaited} ({asynchronous_fn}($items)=>{{const $keyed=[];for(const {alias} of $items){{$keyed.push({{item:{alias},key:{awaited}({key}),index:$keyed.length}});}}$keyed.sort(($left,$right)=>{{const $a=$left.key,$b=$right.key;const $compared=$a==null?($b==null?0:-1):$b==null?1:({compared});return $compared===0?$left.index-$right.index:{direction};}});return $keyed.map($entry=>$entry.item);}})({out}))"
            );
        }
        self.append_select(&out, false, query)
    }

    fn lower_query(&mut self, query: &crate::codegen::ir::IrQuery, span: Span) -> String {
        if !self.query_order_matches_domain(query) {
            self.unsupported(
                "query order",
                "ordering does not belong to its domain",
                span,
            );
            return self.throw_expr("mismatched query order");
        }
        if let Some(capture) = self.query_capture.clone() {
            if let Some(selected) = self.lower_transcript_selection(query, &capture, span) {
                return selected;
            }
            if let Some(selected) = self.lower_inline_selection(query, &capture, span) {
                return selected;
            }
            for source in &capture.queries {
                let original_scan = query
                    .source
                    .as_ref()
                    .is_some_and(|fact| fact.node == source.node);
                let contained_count = source.count.as_ref().is_some_and(|count| {
                    count.contained_parent.is_some()
                        && source.node.file == span.file
                        && source.node.start == span.start
                        && source.node.end == span.end
                });
                if original_scan || contained_count {
                    self.stdlib.insert("executeScenarioReceiptQuery".into());
                    self.enter_scope();
                    let row = self.bind(&query.where_param);
                    let predicate = query
                        .where_pred
                        .as_ref()
                        .map(|predicate| self.lower_expr(predicate))
                        .unwrap_or_else(|| {
                            // An order-only first carries no predicate: the
                            // receipt order selects the first stored row and
                            // every row admits. Where-queries keep the exact
                            // predicate below.
                            assert!(
                                contained_count
                                    || (source.first.is_some()
                                        && source.predicate.is_none()),
                                "checked source query predicate"
                            );
                            "true".into()
                        });
                    self.exit_scope();
                    return format!(
                        "await executeScenarioReceiptQuery(c,{},async({row})=>{predicate})",
                        js_string(&source.id)
                    );
                }
                if source.projection.as_ref().is_some_and(|projection| {
                    query
                        .source
                        .as_ref()
                        .is_some_and(|fact| fact.node == projection.node)
                }) {
                    let crate::codegen::ir::IrQueryDomain::Value { base, .. } = &query.domain
                    else {
                        unreachable!("checked source local projection domain");
                    };
                    let selected = self.lower_expr(base);
                    let projected = self.append_select("$querySelected", false, query);
                    self.stdlib.insert("bindScenarioReceiptQueryResult".into());
                    // Preserve exact selected-array identity, source-order map and
                    // reference/version values. The owning Return selects once,
                    // after this result binding, in either real runtime lifetime.
                    return format!(
                        "(($querySelected)=>{{const $queryResult={projected};bindScenarioReceiptQueryResult(c,{},$querySelected,$queryResult);return $queryResult;}})({selected})",
                        js_string(&capture.return_id)
                    );
                }
            }
        }
        match &query.domain {
            crate::codegen::ir::IrQueryDomain::Model(model) => {
                if self.source_data_body {
                    let source=self.source_data_emits.values().filter_map(|source|source["queries"].as_array()).flat_map(|queries|queries.iter())
                        .find(|source|source["node"]["file"]==span.file.0&&source["node"]["start"]==span.start&&source["node"]["end"]==span.end).cloned();
                    let Some(source)=source else{self.unsupported("EMIT DATA query","original aggregate domain lacks its independent DATA census",span);return self.throw_expr("unsealed EMIT DATA query");};
                    self.stdlib.insert("nativeScenarioSourceEmitQuery".into());
                    let parent=self.lower_expr(query.parent.as_deref().expect("checked aggregate parent"));
                    let mut fetched=format!("await nativeScenarioSourceEmitQuery(c,{}, {parent})",js_string(source["id"].as_str().expect("checked aggregate id")));
                    if let Some(predicate)=&query.where_pred{
                        self.enter_scope();let row=self.bind(&query.where_param);let predicate=self.lower_expr(predicate);self.exit_scope();
                        fetched=format!("await (async($rows)=>{{const $selected=[];for(const $item of $rows){{if(await (async({row})=>({predicate}))($item))$selected.push($item);}}return Object.freeze($selected);}})({fetched})");
                    }
                    return self.append_select(&fetched,true,query);
                }
                // A private serial owner decision may issue only its checked
                // stored-model occurrences. The marker identifies the exact
                // source call, rather than granting authority by model name.
                let owner_decision = self.receipt_capture.as_ref()
                    .and_then(|receipt|receipt.plan.refer_reject_decision.as_ref()
                        .or(receipt.plan.member_retry_decision.as_ref())
                        .or(receipt.plan.invoice_collect_decision.as_ref())
                        .or(receipt.plan.invoice_issue_decision.as_ref())
                        .or(receipt.plan.observe_venue_decision.as_ref()))
                    .filter(|_|self.owner_handler_body);
                // Source Require lowering temporarily suspends receipt_capture,
                // and imported pure helpers are emitted outside the handler.
                // Their exact checked invoice collection sites still carry the
                // same source marker when called under that owner's lease.
                let owner_site_id = owner_decision.into_iter().chain(
                    self.native_receipts.values().filter(|_| !self.retained_owner_body && !self.generic_boolean_body).flat_map(|receipt| [
                        receipt.plan.invoice_collect_decision.as_ref(),
                        receipt.plan.invoice_issue_decision.as_ref(),
                    ].into_iter().flatten())).filter(|decision| {
                    // Shared helpers can occur in several owner's financial
                    // profiles. A source Require has its exact owner here;
                    // another owner's site must not win HashMap iteration.
                    self.source_require_identity.as_ref()
                        .and_then(|identity| identity["owner"].as_str())
                        .is_none_or(|owner| decision["owner"] == owner)
                }).find_map(|decision| {
                    decision["querySites"].as_array()?.iter().find(|site| {
                        let exact_node=query.source.as_ref().is_some_and(|source| {
                            let node=source.node;
                            (self.source_paths.is_empty() || self.source_paths.get(&node.file)
                                .is_some_and(|path|site["source"]["path"]==path.as_str()))
                                && site["queryNode"]==serde_json::json!({
                                    "start":node.start,"end":node.end,"kind":node.kind
                                })
                        });
                        // Bare `count(invoice.Line)` has a checked builtin and
                        // typed model-member argument, but no checked query fact.
                        // The exact issue source/IR profile binds that one span.
                        let issue_count=query.source.is_none()
                            && decision["owner"]=="invoice.issue"
                            && site["stage"]=="lineCount"
                            && site["queryNode"]["start"]==span.start
                            && site["queryNode"]["end"]==span.end;
                        site["model"]==*model
                            && (exact_node || issue_count)
                    })?["id"].as_str().map(str::to_owned)
                });
                if owner_decision.is_some() && owner_site_id.is_none() {
                    self.unsupported("owner decision query",
                        "stored-model read lacks its exact checked source site",span);
                    return self.throw_expr("unsealed owner decision query");
                }
                let unsealed_authority_query = self.authority_queries.is_some_and(|prepared| {
                    prepared.reaches(span) && prepared.matched_site(span, query, model).is_none()
                });
                if unsealed_authority_query {
                    self.unsupported("authority query", "reachable stored-model read lacks exact checked source correspondence", span);
                    return self.throw_expr("unsealed authority query");
                }
                self.stdlib.insert("records".to_string());
                let mut opts = Vec::new();
                if let Some(id)=owner_site_id {
                    opts.push(format!("ownerDecisionSource:{{id:{}}}",js_string(&id)));
                }
                if let Some(prepared) = self.authority_queries {
                    if let Some(site) = prepared.matched_site(span, query, model) {
                        opts.push(format!("authoritySource:{{id:{}}}", js_string(&site.id)));
                    }
                }
                if self.hook_native() {
                    // Only the checked private hook adapter consumes this
                    // label as its inherited decision/value read site.
                    opts.push(format!("authority:{}", js_string(
                        if self.hook_decision_depth > 0 { "owner" } else { "viewer" }
                    )));
                }
                if let Some(parent) = &query.parent {
                    opts.push(format!("parent:{}", self.lower_expr(parent)));
                }
                if let Some(pred) = &query.where_pred {
                    let source_checked_authority = self.authority_queries
                        .is_some_and(|prepared| prepared.matched_site(span, query, model).is_some());
                    self.lower_model_where_opt(query, pred, &mut opts, source_checked_authority);
                }
                if let Some(order) = &query.value_order {
                    self.enter_scope();
                    let row = self.bind(&query.where_param);
                    let key = self.lower_expr(&order.key);
                    self.exit_scope();
                    let compared = self.lower_value_order_comparison(&order.key);
                    opts.push(format!("order:{{by:async({row})=>{key},compare:($a,$b)=>{compared},direction:{}}}",
                        js_string(if order.descending { "desc" } else { "asc" })));
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
                let projection=self.source_data_sends.values().filter_map(|source|source["queries"].as_array())
                    .flat_map(|queries|queries.iter()).find(|source|source["node"]["file"]==span.file.0
                        &&source["node"]["start"]==span.start&&source["node"]["end"]==span.end).cloned();
                let fetched=if let Some(source)=projection{
                    self.stdlib.insert("nativeScenarioSourceSendQuery".into());
                    let parent=self.lower_expr(query.parent.as_deref().expect("checked direct projection parent"));
                    format!("await nativeScenarioSourceSendQuery(c,{}, {parent},async()=>({fetched}))",js_string(source["id"].as_str().expect("checked projection id")))
                }else{fetched};
                self.append_select(&fetched, true, query)
            }
            crate::codegen::ir::IrQueryDomain::Value { base, alias } => {
                self.lower_value_domain(query, base, alias)
            }
        }
    }

    /// Compare already evaluated keys with their checked Values representation.
    fn lower_value_order_comparison(&mut self, key: &TypedExpr) -> String {
        let scalar = key.ty.nullable_inner().unwrap_or(&key.ty);
        let comparator = match scalar {
            ResolvedType::Scalar(Scalar::Int | Scalar::Duration | Scalar::Bytes) => {
                return "$a===$b?0:$a<$b?-1:1".into();
            }
            ResolvedType::Scalar(Scalar::Decimal) => "compareDecimal",
            ResolvedType::Scalar(Scalar::Money) => "compareMoney",
            ResolvedType::Scalar(Scalar::Date) => "compareDate",
            ResolvedType::Scalar(Scalar::Datetime) => "compareInstant",
            ResolvedType::Scalar(scalar) if scalar.is_string_like() => "compareScalar",
            _ => {
                self.unsupported(
                    "value query order",
                    "an ordered checked scalar key is required",
                    key.span,
                );
                return self.throw_expr("unordered key");
            }
        };
        self.stdlib.insert(comparator.into());
        format!("{comparator}($a,$b)")
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
        let in_hook = self.hook_closure_tracked();
        if in_hook {
            self.hook_closure_depth += 1;
        }
        let body = self.lower_expr(projection);
        if in_hook {
            self.hook_closure_depth -= 1;
        }
        self.exit_scope();
        // A constructed contract/object is an expression, not an arrow's
        // statement block. Keep the same once-only field evaluation order.
        let body = if body.starts_with('{') {
            format!("({body})")
        } else {
            body
        };
        if expr_uses_async(projection) || self.boolean_body || self.implicit_expr_uses_async(projection) {
            return format!(
                "(await (async($items)=>{{const $result=[];for(const {param} of $items){{$result.push(await ({body}));}}return $result;}})({fetched}))"
            );
        }
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

    /// Retain the checked source locale through the owning message factory.
    pub fn lower_message(&mut self, message: &IrMessage) -> String {
        if let Some(param) = message
            .params
            .iter()
            .find(|param| self.expr_formatted(&param.value))
        {
            return self.formatted_refusal("formatted message parameter", param.value.span);
        }
        self.ui.insert("message".to_string());
        self.ui.insert("normalizeTag".to_string());
        self.stdlib.insert("ValueError".to_string());
        self.checked_message = true;
        let mut out = format!(
            "{}({},",
            binding_ident("h", "checked_message"),
            js_string(&message.source)
        );
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
        out.push_str(&format!("{{{variants}}},"));
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
            out.push_str(&format!("{{{params}}}"));
        } else {
            out.push_str("undefined");
        }
        out.push_str(&format!(",{})", js_string(&message.source_lang)));
        out
    }

    /// The installed source closure observes control only at its actual owner stage.
    fn lower_source_condition(&mut self,cond:&TypedExpr)->Option<String> {
        let identity=self.source_requires.get(&cond.span).cloned()?;
        let parameters = identity["parameters"]
            .as_array()
            .expect("sealed Require parameters");
        let names = parameters
            .iter()
            .filter(|parameter| parameter["unread"].as_bool() != Some(true))
            .map(|parameter| {
                parameter["name"]
                    .as_str()
                    .expect("sealed parameter")
                    .to_owned()
            })
            .collect::<Vec<_>>();
        let bindings = names
            .iter()
            .map(|name| format!("{}:{}", object_key(name), self.reference(name)))
            .collect::<Vec<_>>()
            .join(",");
        let previous_boolean = std::mem::replace(&mut self.boolean_body, true);
        let previous_generic = std::mem::replace(&mut self.generic_boolean_body,
            !matches!(identity["owner"].as_str(), Some("invoice.collect" | "invoice.issue")));
        let previous_source_guard =
            std::mem::replace(&mut self.source_guard_body, true);
        let previous_receipt = self.receipt_capture.take();
        let previous_query = self.query_capture.take();
        let previous_require=self.source_require_identity.replace(identity.clone());
        let previous_calls=std::mem::take(&mut self.source_require_calls);
        let expression = self.lower_expr(cond);
        self.source_require_identity=previous_require;
        self.source_require_calls=previous_calls;
        self.boolean_body = previous_boolean;
        self.generic_boolean_body = previous_generic;
        self.source_guard_body = previous_source_guard;
        self.receipt_capture = previous_receipt;
        self.query_capture = previous_query;
        self.stdlib.insert("nativeScenarioRequire".into());
        Some(format!(
            "await nativeScenarioRequire(c,$can$require$issue({},async(c,{{{bindings}}})=>({expression})),{{{bindings}}})",
            descriptor_json(&descriptor_json(&identity))
        ))
    }

    /// Lower one statement in source order, retaining its source span.
    pub fn lower_stmt(&mut self, stmt: &IrStmt, indent: usize) -> Vec<(String, Span)> {
        let pad = "  ".repeat(indent);
        let consumers: Vec<&TypedExpr> = match stmt {
            IrStmt::Let { .. } | IrStmt::Unsupported { .. } => Vec::new(),
            IrStmt::Create { input, .. } => vec![input],
            IrStmt::Set {
                record, changes, ..
            } => vec![record, changes],
            IrStmt::Transition { record, .. } | IrStmt::Delete { record, .. } => vec![record],
            IrStmt::Call { target, inputs, .. } => target
                .operand()
                .into_iter()
                .chain(std::iter::once(inputs))
                .collect(),
            IrStmt::Emit { payload, .. } => vec![payload],
            IrStmt::Send { args, when, .. } => std::iter::once(args).chain(when.iter()).collect(),
            IrStmt::Schedule {
                key, at, payload, ..
            } => vec![key, at, payload],
            IrStmt::Cancel { key, .. } => vec![key],
            IrStmt::Return { value, .. } => value.iter().collect(),
            IrStmt::Require { cond, .. } | IrStmt::If { cond, .. } => vec![cond],
            IrStmt::Match { subject, .. } => vec![subject],
            IrStmt::For { domain, limit, .. } => {
                std::iter::once(domain).chain(limit.iter()).collect()
            }
        };
        // Recorded human/outbound sends admit localized formatted text at
        // their classified human-text paths (lowered inline through the
        // shared formatter, frozen at send construction in authored order).
        // Guards and every other formatted position keep refusing.
        if let IrStmt::Send {
            args,
            when,
            operation,
            ..
        } = stmt
        {
            if let Some(guard) = when.iter().find(|value| self.expr_formatted(value)) {
                let refused = self.formatted_refusal("formatted business statement", guard.span);
                return vec![(format!("{pad}{refused};"), guard.span)];
            }
            let positions = self.formatted_positions(args);
            let admitted = self.outbound_sink_paths(operation).is_some_and(|allowed| {
                positions.iter().all(|(path, _)| {
                    allowed.iter().any(|ok| {
                        ok.len() == path.len() && ok.iter().zip(path).all(|(a, b)| a == b)
                    })
                })
            });
            if !admitted && let Some((_, span)) = positions.first() {
                let refused = self.formatted_refusal("formatted business statement", *span);
                return vec![(format!("{pad}{refused};"), *span)];
            }
        } else if let Some(value) = consumers.iter().find(|value| self.expr_formatted(value)) {
            let notice_sink = match stmt {
                IrStmt::Create { model, input, span, .. }
                    if model == "rent_reservations.Notice" && self.owner_handler_body => {
                    self.receipt_capture.as_ref()
                        .and_then(|receipt| receipt.plan.rent_notice_decision.as_ref())
                        .is_some_and(|decision| {
                            let names = ["confirmationCreate", "cancellationCreate", "reminderCreate"];
                            let positions = self.formatted_positions(input);
                            names.iter().any(|name| {
                                decision["sites"][name]["model"] == "rent_reservations.Notice" &&
                                decision["sites"][name]["statement"]["start"] == span.start &&
                                decision["sites"][name]["statement"]["end"] == span.end
                            }) && !positions.is_empty() && positions.iter().all(|(path, _)|
                                path.as_slice() == ["subject"] || path.as_slice() == ["body"])
                        })
                }
                IrStmt::Create {model,input,span,..} if model == "events.Notice" => {
                    self.receipt_capture.as_ref().and_then(|receipt|receipt.plan.event_notice_audit.as_ref())
                        .is_some_and(|audit| audit["model"] == model.as_str()
                            && audit["create"]["start"] == span.start && audit["create"]["end"] == span.end
                            && {let positions=self.formatted_positions(input); !positions.is_empty()
                                && positions.iter().all(|(path,_)|path.as_slice()==["subject"] || path.as_slice()==["body"])})
                }
                _ => false,
            };
            if notice_sink { /* The complete original handler and values are rechecked by State. */ }
            else {
            let refused = self.formatted_refusal("formatted business statement", value.span);
            return vec![(format!("{pad}{refused};"), value.span)];
            }
        }
        match stmt {
            IrStmt::Let { name, value, span } => {
                if let Some(source)=self.source_let_data.get(span).cloned(){
                    self.stdlib.insert("nativeScenarioSourceLetData".into());
                    let root=self.reference(source["parameter"].as_str().expect("original LET parameter"));
                    let binding=self.bind(name);
                    return vec![(format!("{pad}const {binding}=await nativeScenarioSourceLetData(c,{},{root});",descriptor_json(&source)),*span)];
                }
                let current = self
                    .receipt_capture
                    .as_ref()
                    .and_then(|recipe| recipe.current_revision.as_ref())
                    .filter(|current| {
                        self.receipt_calls.is_empty() && current.retained_source == value.span
                    })
                    .cloned();
                if let Some(current) = current {
                    let IrExpr::Member { base, field } = &value.expr else {
                        return vec![(
                            format!(
                                "{pad}throw new Error('Original current Let getter is missing');"
                            ),
                            *span,
                        )];
                    };
                    if field != "current" {
                        return vec![(
                            format!(
                                "{pad}throw new Error('Original current Let field is missing');"
                            ),
                            *span,
                        )];
                    }
                    let source = self.lower_expr(base);
                    let emitted = self.bind(name);
                    self.current_revision_binding = Some(emitted.clone());
                    self.stdlib
                        .insert("observeScenarioReceiptDependency".into());
                    return vec![(
                        format!(
                            "{pad}const $receiptCurrentSource={source};const {emitted}=($receiptCurrentSource[\"current\"]??null);await observeScenarioReceiptDependency(c,{},$receiptCurrentSource,\"current\",{});let $receiptCurrentView;let $receiptCurrentData=false;",
                            js_string(&current.template),
                            js_string(&current.retained_control_id)
                        ),
                        *span,
                    )];
                }
                let formatted = self.expr_formatted(value);
                let alias = if self.in_hook() {
                    Some(self.hook_alias_class(value))
                } else {
                    None
                };
                let value_text = self.lower_expr(value);
                let emitted = self.bind(name);
                self.formatted_bindings
                    .last_mut()
                    .expect("lexical scope")
                    .insert(name.clone(), formatted);
                if let Some(alias) = alias {
                    if let Some(scope) = self.hook_aliases.last_mut() {
                        scope.insert(name.clone(), alias);
                    }
                }
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
                let record_text = if self.retained_owner_body {
                    self.lower_boolean_record(record)
                } else {
                    self.lower_expr(record)
                };
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
                if let Some(dependencies) = self
                    .receipt_capture
                    .as_ref()
                    .and_then(|recipe| recipe.dependencies.get(&self.receipt_site(*span)))
                    .cloned()
                {
                    self.stdlib
                        .insert("observeScenarioReceiptDependency".to_string());
                    let observations = dependencies
                        .iter()
                        .map(|dependency| {
                            format!(
                                "await observeScenarioReceiptDependency(c,{},$receiptRow,{},{});",
                                js_string(&dependency.model),
                                js_string(&dependency.field),
                                js_string(&dependency.id),
                            )
                        })
                        .collect::<String>();
                    // Match the checked old-state anchor before the genuine
                    // transition through the released State session consumer
                    // attesting intermediate own-write rows.
                    return vec![(
                        format!(
                            "{pad}{{const $receiptRow={record};{observations}await transition(c,{},$receiptRow.id,{},{},{});}}",
                            js_string(model),
                            js_string(field),
                            js_string(from),
                            js_string(to)
                        ),
                        *span,
                    )];
                }
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
                target,
                inputs,
                binding,
                result,
                span,
            } => {
                let operation = target
                    .operations()
                    .iter()
                    .map(|id| self.ir.items[id.0 as usize].canonical.as_str())
                    .collect::<Vec<_>>()
                    .join(",");
                // Admit only the exact active parent's checked static
                // occurrence joined to the native owner-transaction producer.
                if self.receipt_capture.is_some()
                    && self.hook.is_none()
                    && let IrEffectCallTarget::Operation { operation, .. } = target
                {
                    let mut matches = self.receipt_call_sites.iter().filter(|site| {
                        site.span == *span
                            && site.operation == *operation
                            && site.binding == *binding
                            && match (&site.result, result) {
                                (super::scenario_calls::CallResultFact::Void, None) => {
                                    binding.is_none()
                                }
                                (
                                    super::scenario_calls::CallResultFact::Scalar(expected),
                                    Some(actual),
                                ) => binding.is_none() && expected == actual,
                                (
                                    super::scenario_calls::CallResultFact::Model(expected),
                                    Some(actual),
                                ) => expected == actual
                                    && binding.is_some()
                                    && self.ir.items.get(operation.0 as usize).is_some_and(
                                        |child| {
                                            super::scenario_receipts::checked_created_model_result(
                                                self.ir, child,
                                            )
                                            .is_some()
                                        },
                                    ),
                                (
                                    super::scenario_calls::CallResultFact::Opaque(expected),
                                    Some(actual),
                                ) => {
                                    expected == actual
                                        && self.ir.items.get(operation.0 as usize).is_some_and(
                                            |child| {
                                                super::scenario_calls::complete_read_query_child(
                                                    self.ir, child,
                                                )
                                                .is_some()
                                            },
                                        )
                                }
                                _ => false,
                            }
                    });
                    let site = matches.next().cloned();
                    if matches.next().is_none()
                        && let Some(site) = site
                    {
                        self.stdlib.insert("invokeScenarioReceiptCall".to_string());
                        let inputs = self.lower_expr(inputs);
                        let call = format!(
                            "await invokeScenarioReceiptCall(c,{},{},{inputs})",
                            js_string(&site.id),
                            js_string(&site.target)
                        );
                        return vec![(
                            match binding {
                                Some(name) => format!("{pad}const {} = {call};", self.bind(name)),
                                None => format!("{pad}{call};"),
                            },
                            *span,
                        )];
                    }
                }
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
                if self.in_hook() && !self.hook_native() {
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
                // Native hooks emit through the same deferred pipeline as
                // scenarios (`await emit(c, …)` with the ambient context):
                // guards lower ahead in source order, staged writes and
                // timers commit atomically alongside, null payload paths
                // are preserved, and post-commit handlers run in later
                // transactions that never undo the committed source.
                self.stdlib.insert("emit".to_string());
                if let Some(source)=self.source_data_emits.get(span).cloned(){
                    self.stdlib.insert("nativeScenarioSourceEmitData".into());
                    let bindings=source["parameters"].as_array().expect("checked EMIT roots").iter().map(|root|{
                        let name=root["name"].as_str().expect("checked root");format!("{}:{}",object_key(name),self.reference(name))}).collect::<Vec<_>>().join(",");
                    let references=source["references"].as_array().cloned().unwrap_or_default();
                    let mut roots=BTreeSet::new();
                    for reference in &references{roots.insert(reference["parameter"].as_str().expect("original reference"));}
                    let inputs=roots.iter().filter(|name|!source["parameters"].as_array().expect("DATA roots").iter().any(|root|root["name"]==**name))
                        .map(|name|format!("{}:{}",object_key(name),self.reference(name))).collect::<Vec<_>>().join(",");
                    let IrExpr::Object(entries)=&payload.expr else{unreachable!("original event payload");};
                    let previous_data_body=self.source_data_body;self.source_data_body=source.get("queries").is_some()||source["parameters"].as_array().is_some_and(|parameters|parameters.iter().any(|parameter|parameter.get("derived").is_some()));
                    let fields=entries.iter().map(|(field,value)|{
                        let value=if let Some(reference)=references.iter().find(|reference|reference["field"]==*field){
                            format!("$can$emit$refs[{}]",descriptor_json(&reference["parameter"]))
                        }else{self.lower_expr(value)};
                        format!("{}:{value}",object_key(field))
                    }).collect::<Vec<_>>().join(",");
                    self.source_data_body=previous_data_body;
                    return vec![(format!("{pad}await nativeScenarioSourceEmitData(c,$can$emit$issue({},c,async(c,{{{bindings}}},$can$emit$refs)=>emit(c,{},{{{fields}}})),{{{bindings}{}{inputs}}});",descriptor_json(&descriptor_json(&source)),js_string(event),if inputs.is_empty(){""}else{","}),*span)];
                }
                let payload_text=self.lower_expr(payload);
                vec![(
                    format!("{pad}await emit(c,{},{payload_text});", js_string(event)),
                    *span,
                )]
            }
            IrStmt::Send {
                operation,
                deployment_binding,
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
                let prepared = self
                    .send_guards
                    .and_then(|guards| guards.get(span))
                    .cloned();
                if prepared.is_none() && when.is_some() && self.native_source_predicates {
                    // One owner can be refused while another has sealed
                    // guards. Report this SEND even if no owner-wide receipt
                    // was collected, and never use a legacy callback.
                    self.unsupported(
                        "send dispatch guard",
                        "original native SEND guard and frozen lexical transport are unavailable",
                        when.as_ref().expect("checked guarded send").span,
                    );
                    return vec![(
                        format!(
                            "{pad}throw new Error({});",
                            js_string("guarded send has no native source proof")
                        ),
                        *span,
                    )];
                }
                if prepared.is_none()
                    && let Some(condition) = when
                    && super::ir::expr_uses_async(condition)
                {
                    self.unsupported(
                        "send dispatch guard",
                        self.send_guard_gap.map_or("async guard requires the owning live dispatch observer and frozen lexical transport", |gap|gap.reason),
                        self.send_guard_gap.and_then(|gap| gap.span).unwrap_or(condition.span),
                    );
                    return vec![(
                        format!(
                            "{pad}throw new Error({});",
                            js_string("async send guard has no dispatch lowering")
                        ),
                        *span,
                    )];
                }
                self.stdlib.insert("send".to_string());
                let args_text = self.lower_expr(args);
                let mut options = Vec::new();
                if let Some(binding) = deployment_binding {
                    options.push(format!("binding:{}", js_string(binding)));
                }
                if let Some(guard) = prepared {
                    let inputs = guard
                        .inputs
                        .iter()
                        .map(|input| {
                            format!(
                                "{}:{}",
                                object_key(&input.name),
                                self.lower_expr(&input.value)
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(",");
                    options.push(format!(
                        "when:{{rule:{},inputs:{{{inputs}}}}}",
                        js_string(
                            guard.descriptor["rule"]
                                .as_str()
                                .expect("checked SEND rule")
                        )
                    ));
                } else if let Some(cond) = when {
                    options.push(format!("when:()=>{}", self.lower_expr(cond)));
                }
                let options_text = if options.is_empty() {
                    String::new()
                } else {
                    format!(",{{{}}}", options.join(","))
                };
                let call = format!(
                    "await send(c,{}, {args_text}{options_text})",
                    js_string(operation)
                );
                let call=if let Some(source)=self.source_data_sends.get(span).cloned(){
                    self.stdlib.insert("nativeScenarioSourceSendData".into());
                    let bindings=source["parameters"].as_array().expect("checked source roots").iter()
                        .map(|root|{let name=root["name"].as_str().expect("checked root");format!("{}:{}",object_key(name),self.reference(name))}).collect::<Vec<_>>().join(",");
                    format!("await nativeScenarioSourceSendData(c,$can$send$issue({},c,async(c,{{{bindings}}})=>({call})),{{{bindings}}})",descriptor_json(&descriptor_json(&source)))
                }else{call};
                vec![(
                    match binding {
                        Some(name) => format!("{pad}const {} = {call};", self.bind(name)),
                        None => format!("{pad}{call};"),
                    },
                    *span,
                )]
            }
            IrStmt::Schedule {
                owner_package,
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
                if let Some(source)=self.source_schedules.get(span).cloned(){
                    self.stdlib.insert("nativeScenarioSourceSchedule".into());
                    let root=self.reference(source["parameter"].as_str().expect("checked source root"));
                    let key=self.lower_expr(key);let at=self.lower_expr(at);let payload=self.lower_expr(payload);
                    return vec![(format!("{pad}{{const $can$schedule$key={key};await nativeScenarioSourceSchedule(c,{},{root},{at},{payload},$can$schedule$key);}}",descriptor_json(&source)),*span)];
                }
                self.stdlib.insert("schedule".to_string());
                let key_text = self.lower_expr(key);
                let at_text = self.lower_expr(at);
                let payload_text = self.lower_expr(payload);
                vec![(
                    format!(
                        "{pad}await schedule(c,{key_text},{at_text},{},{payload_text},{{ownerPackage:{}}});",
                        js_string(event),
                        js_string(owner_package)
                    ),
                    *span,
                )]
            }
            IrStmt::Cancel {
                owner_package,
                key,
                span,
            } => {
                if self.hook.is_some() {
                    let key_text = self.lower_expr(key);
                    return vec![(format!("{pad}$hookCtx.cancel({key_text});"), *span)];
                }
                if let Some(source)=self.source_cancels.get(span).cloned(){
                    let IrExpr::Member{base,..}=&key.expr else{unreachable!("checked source cancellation");};
                    self.stdlib.insert("nativeScenarioSourceCancel".into());
                    let root=self.lower_expr(base);
                    return vec![(format!("{pad}await nativeScenarioSourceCancel(c,{},{});",descriptor_json(&source),root),*span)];
                }
                self.stdlib.insert("cancel".to_string());
                let key_text = self.lower_expr(key);
                vec![(
                    format!(
                        "{pad}await cancel(c,{key_text},{{ownerPackage:{}}});",
                        js_string(owner_package)
                    ),
                    *span,
                )]
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
                let model_result = value.as_ref().is_some_and(|value| {
                    matches!(value.ty, ResolvedType::Record { stored: true, .. })
                });
                if self.receipt_capture.is_some()
                    && let Some(selection) =
                        self.receipt_return_selection(*span, false, model_result)
                {
                    let identity_observations = value
                        .as_ref()
                        .and_then(|value| {
                            matches!(value.expr, IrExpr::Name(_))
                                .then(|| {
                                    self.receipt_capture
                                        .as_ref()?
                                        .dependencies
                                        .get(&self.receipt_site(value.span))
                                        .cloned()
                                })
                                .flatten()
                        })
                        .unwrap_or_default();
                    let identity_observations = identity_observations
                        .iter()
                        .map(|dependency| {
                            self.stdlib
                                .insert("observeScenarioReceiptDependency".into());
                            format!(
                                "await observeScenarioReceiptDependency(c,{},$receiptValue,{},{});",
                                js_string(&dependency.model),
                                js_string(&dependency.field),
                                js_string(&dependency.id)
                            )
                        })
                        .collect::<String>();
                    let value = value.as_ref().map(|value| self.lower_expr(value));
                    let result = if model_result {
                        "$receiptModelResult"
                    } else {
                        "$receiptValue"
                    };
                    return vec![(
                        match value {
                            Some(value) => format!(
                                "{pad}{{const $receiptValue={value};{identity_observations}{selection}return {result};}}"
                            ),
                            None => format!("{pad}{{{selection}return;}}"),
                        },
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
                // Hook firing/guard/decision expressions (DESIGN §442):
                // parent loads here carry `'decision'` in the scope.
                let in_hook = self.in_hook();
                if in_hook {
                    self.hook_decision_depth += 1;
                }
                let cond_text = self.lower_source_condition(cond).unwrap_or_else(||self.lower_expr(cond));
                if in_hook {
                    self.hook_decision_depth -= 1;
                }
                vec![(format!("{pad}check({cond_text});"), *span)]
            }
            IrStmt::If {
                cond,
                then_branch,
                else_branch,
                span,
            } => {
                // `if` conditions are hook decisions (e.g.
                // `if event.after.parent.active and not event.after.done`);
                // branch bodies stay body/value. Helpers inherit the site.
                let in_hook = self.in_hook();
                if in_hook {
                    self.hook_decision_depth += 1;
                }
                let event_decision = self.receipt_capture.as_ref()
                    .and_then(|receipt| receipt.plan.event_decision.clone());
                let renewal_decision = self.receipt_capture.as_ref()
                    .and_then(|receipt| receipt.plan.success_renewal_decision.clone());
                let cond_text = if let Some(decision) = event_decision {
                    let site = &decision["ifSite"];
                    if site["statement"]["start"].as_u64() != Some(u64::from(span.start))
                        || site["statement"]["end"].as_u64() != Some(u64::from(span.end))
                        || site["node"]["start"].as_u64() != Some(u64::from(cond.span.start))
                        || site["node"]["end"].as_u64() != Some(u64::from(cond.span.end))
                    {
                        self.unsupported("event owner decision",
                            "original IF decision no longer matches its complete event receipt",*span);
                        "false".into()
                    } else {
                        self.enter_scope();
                        let inspection = self.bind("inspection");
                        let event = self.bind("event");
                        let expression = self.lower_expr(cond);
                        self.exit_scope();
                        self.stdlib.insert("nativeScenarioEventDecision".into());
                        format!("await nativeScenarioEventDecision(c,{},async(c,{{eventTerm,eventRevision}})=>{{const {inspection}=eventTerm;const {event}={{inspection:eventTerm,revision:eventRevision}};return {expression};}})",
                            descriptor_json(&decision))
                    }
                } else if let Some(decision) = renewal_decision {
                    let site = &decision["sites"]["if"];
                    if !matches!(decision["owner"].as_str(), Some("success.renewal_due" | "success.remind"))
                        || site["statement"]["start"].as_u64() != Some(u64::from(span.start))
                        || site["statement"]["end"].as_u64() != Some(u64::from(span.end))
                        || site["node"]["start"].as_u64() != Some(u64::from(cond.span.start))
                        || site["node"]["end"].as_u64() != Some(u64::from(cond.span.end))
                    {
                        self.unsupported("renewal owner decision",
                            "original IF decision no longer matches its complete renewal receipt",*span);
                        "false".into()
                    } else {
                        self.enter_scope();
                        let root_field = if decision["owner"] == "success.remind" { "followup" } else { "account" };
                        let account = self.bind(root_field);
                        let event = self.bind("event");
                        let expression = self.lower_expr(cond);
                        self.exit_scope();
                        self.stdlib.insert("nativeScenarioEventDecision".into());
                        format!("await nativeScenarioEventDecision(c,{},async(c,{{eventTerm,eventRevision,eventAccountRevision}})=>{{const {account}=eventTerm;const {event}={{{root_field}:eventTerm,revision:eventRevision,account_revision:eventAccountRevision}};return {expression};}})",
                            descriptor_json(&decision))
                    }
                } else if self.receipt_capture.is_none() {
                    self.lower_source_condition(cond).unwrap_or_else(||self.lower_expr(cond))
                } else {
                    // A complete receipt retains its existing checked query
                    // consumers and branch ledger; source control is a fallback.
                    self.lower_expr(cond)
                };
                if in_hook {
                    self.hook_decision_depth -= 1;
                }
                let mut lines = vec![(format!("{pad}if ({cond_text}) {{"), *span)];
                let then_choice = self.receipt_choice(*span, "then");
                if !then_choice.is_empty() {
                    lines.push((format!("{pad}  {then_choice}"), *span));
                }
                self.enter_scope();
                for stmt in then_branch {
                    lines.extend(self.lower_stmt(stmt, indent + 1));
                }
                self.exit_scope();
                let else_choice = self.receipt_choice(*span, "else");
                if else_branch.is_empty() && else_choice.is_empty() {
                    lines.push((format!("{pad}}}"), *span));
                } else {
                    lines.push((format!("{pad}}} else {{"), *span));
                    if !else_choice.is_empty() {
                        lines.push((format!("{pad}  {else_choice}"), *span));
                    }
                    self.enter_scope();
                    for stmt in else_branch {
                        lines.extend(self.lower_stmt(stmt, indent + 1));
                    }
                    self.exit_scope();
                    lines.push((format!("{pad}}}"), *span));
                }
                lines
            }
            IrStmt::Match {
                subject,
                arms,
                span,
            } => {
                // JavaScript switch evaluates its subject once, including an
                // awaited observation, before any selected arm's effects.
                // A match subject is a decision like `if` conditions.
                let in_hook = self.in_hook();
                if in_hook {
                    self.hook_decision_depth += 1;
                }
                let subject_text = self.lower_expr(subject);
                if in_hook {
                    self.hook_decision_depth -= 1;
                }
                let mut lines = vec![(format!("{pad}switch ({subject_text}) {{"), *span)];
                for arm in arms {
                    lines.push((
                        format!("{pad}  case {}: {{", js_string(&arm.case)),
                        arm.span,
                    ));
                    self.enter_scope();
                    let choice = self.receipt_choice(*span, &arm.case);
                    if !choice.is_empty() {
                        lines.push((format!("{pad}    {choice}"), arm.span));
                    }
                    for statement in &arm.body {
                        lines.extend(self.lower_stmt(statement, indent + 2));
                    }
                    self.exit_scope();
                    lines.push((format!("{pad}    break;"), arm.span));
                    lines.push((format!("{pad}  }}"), arm.span));
                }
                lines.push((format!("{pad}}}"), *span));
                lines
            }
            IrStmt::For {
                item,
                domain,
                limit,
                body,
                span,
            } => {
                let source_loop = self.receipt_capture.as_ref().and_then(|receipt|receipt.plan.source_loops.as_ref().or(receipt.plan.source_emissions.as_ref()))
                    .and_then(|source|source["loops"].as_array().and_then(|loops|loops.iter().find(|loop_|
                        loop_["node"]["start"]==span.start && loop_["node"]["end"]==span.end).map(|loop_|(source.clone(),loop_.clone()))))
                    .or_else(||self.source_body_loops.values().find_map(|source|source["loops"].as_array()?.iter().find(|entry|
                        entry["node"]["start"]==span.start&&entry["node"]["end"]==span.end).map(|entry|(source.clone(),entry.clone()))));
                let body_loop=source_loop.as_ref().filter(|(_,entry)|entry.get("item").is_some()).cloned();
                let copy_loop=source_loop.as_ref().filter(|(_,loop_)|loop_.get("copy").is_some()).cloned();
                let domain_text = if let Some((source,loop_)) = source_loop {
                    let parent = self.reference(loop_["parameter"].as_str().expect("checked loop parameter"));
                    let predicate = if loop_["filtered"].as_bool()==Some(true) {
                        let IrExpr::Query(query) = &domain.expr else { unreachable!("checked original loop query"); };
                        let original = query.where_pred.as_ref().expect("checked original filter");
                        self.enter_scope(); let row = self.bind(&query.where_param);
                        let capture = self.receipt_capture.take();
                        let expression = self.lower_expr(original);
                        self.receipt_capture = capture; self.exit_scope();
                        format!("$can$loop$issue({},c,async({row})=>({expression}))",descriptor_json(&descriptor_json(&serde_json::json!({"source":source["source"],"owner":source["owner"],"loop":loop_}))))
                    } else { "null".into() };
                    self.stdlib.insert("nativeScenarioSourceLoop".into());
                    format!("await nativeScenarioSourceLoop(c,{},{parent},{predicate})",descriptor_json(&loop_["id"]))
                } else { self.lower_expr(domain) };
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
                    if self.receipt_decision(*span) {
                        let empty = self.receipt_choice(*span, "else");
                        let nonempty = self.receipt_choice(*span, "then");
                        lines.push((
                            format!("{pad}if({rows}.length===0){{{empty}}}else{{{nonempty}}}"),
                            *span,
                        ));
                    }
                    rows
                } else {
                    awaited
                };
                self.enter_scope();
                let in_hook = self.in_hook();
                let item_source = item.clone();
                let item = self.bind(item);
                if in_hook {
                    // Loop rows are full stored rows from the lowered domain,
                    // never parent linkage: shadow any outer hook alias.
                    if let Some(scope) = self.hook_aliases.last_mut() {
                        scope.insert(item_source, None);
                    }
                }
                lines.push((format!("{pad}for (const {item} of {over}) {{"), *span));
                if let Some((source,loop_))=body_loop{
                    self.stdlib.insert("nativeScenarioSourceLoopItem".into());
                    let marker=descriptor_json(&descriptor_json(&serde_json::json!({"source":source["source"],"owner":source["owner"],"loop":loop_,"phase":"item"})));
                    lines.push((format!("{pad}  await nativeScenarioSourceLoopItem(c,{},{item},$can$loop$issue({marker},c,async()=>{{",descriptor_json(&loop_["id"])),*span));
                    for stmt in body{lines.extend(self.lower_stmt(stmt,indent+2));}
                    lines.push((format!("{pad}  }}));"),*span));
                }else if let Some((source,loop_))=copy_loop{
                    self.stdlib.insert("nativeScenarioSourceLoopCopy".into());
                    let parent=self.reference(loop_["copy"]["parent"].as_str().expect("checked copy parent"));
                    let marker=descriptor_json(&descriptor_json(&serde_json::json!({"source":source["source"],"owner":source["owner"],"loop":loop_})));
                    lines.push((format!("{pad}  await nativeScenarioSourceLoopCopy(c,{},{item},{parent},$can$loop$issue({marker},c,async()=>{{",descriptor_json(&loop_["id"])),*span));
                    for stmt in body{lines.extend(self.lower_stmt(stmt,indent+2));}
                    lines.push((format!("{pad}  }}));"),*span));
                }else{
                    for stmt in body {lines.extend(self.lower_stmt(stmt, indent + 1));}
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
        let mut data_parts: Vec<String> = Vec::new();
        for (key, value) in &data_entries {
            // Snapshot rows project to linkage for stored-record inputs
            // (the profiler admits exactly these shapes): the staged write
            // carries `{model, id}` like the parent slot. Anything else
            // lowers inline as before.
            let linkage_model = match value.ty.nullable_inner().unwrap_or(&value.ty) {
                ResolvedType::Record { symbol, stored: true } => {
                    match self.hook_base_class(value) {
                        HookBase::Root | HookBase::Snapshot => self
                            .ir
                            .items
                            .get(symbol.0 as usize)
                            .map(|item| item.canonical.clone()),
                        _ => None,
                    }
                }
                _ => None,
            };
            if let Some(link_model) = linkage_model {
                let base = self.lower_expr(value);
                let id = format!(
                    "{}.id",
                    parenthesize_operand(&base, &value.expr)
                );
                let linkage = if matches!(&value.ty, ResolvedType::Record { .. }) {
                    format!("{{model:{},id:{id}}}", js_string(&link_model))
                } else {
                    format!("({base}==null?null:{{model:{},id:{id}}})", js_string(&link_model))
                };
                data_parts.push(format!("{}:{linkage}", object_key(key)));
            } else {
                data_parts.push(format!("{}:{}", object_key(key), self.lower_expr(value)));
            }
        }
        let data = format!("{{{}}}", data_parts.join(","));
        let id_ref = binding.clone().map(|name| self.bind(&name));
        if self.in_hook() {
            // Staged bindings carry the bound `{id}` identity: bare and
            // `.id` uses lower; other field reads gap loud unless the
            // native stage call below paired the id with the supplied
            // data (see hook_member_gap). `id` is never a data field:
            // the staged identity owns it.
            if let Some(source) = binding {
                if let Some(scope) = self.hook_aliases.last_mut() {
                    scope.insert(source.clone(), Some(HookAlias::Staged));
                }
                if self.hook_native() {
                    self.hook_staged_data.insert(
                        source.clone(),
                        data_entries
                            .iter()
                            .map(|(key, _)| key.clone())
                            .filter(|key| key != "id")
                            .collect(),
                    );
                }
            }
        }
        // C22 staged identity: `triggerId/staged/<operationId>/<site>/`
        // `<occurrence>` for the first create of a fire, with `/<counter>`
        // after. The operation id is the owning runtime's immutable
        // invocation identity (`$hookCtx.operationId`, recorded on every
        // history entry), so distinct operations stage distinct children
        // while replaying one operation restages its same ids; the site is
        // this hook's checked canonical, so distinct hooks on one fire
        // stage distinct children; the occurrence is this operation's
        // prior-fire ordinal for the hook (`$hookCtx.hookOccurrence`), so
        // a repeated trigger in one batch never restages an earlier fire.
        // The `??` fallbacks keep hand-built contexts on a stable identity.
        let slot = binding_ident("n", &self.binding_seq.to_string());
        self.binding_seq += 1;
        let site = js_string(
            &self
                .hook
                .as_ref()
                .map(|hook| hook.site.clone())
                .unwrap_or_default(),
        );
        let id_value = format!(
            "$hookCtx.triggerId+\"/staged/\"+(($hookCtx.operationId??\"0\"))+\"/\"+{site}+\"/\"+(($hookCtx.hookOccurrence??0))+({slot}===0?\"\":\"/\"+{slot})"
        );
        if self.hook_native() {
            // With a bound alias, keep the single data evaluation in a
            // local const and pair it with the deterministic staged id, so
            // reads of explicitly supplied fields observe exactly what the
            // stage call carries. The spread comes first so a data `id`
            // could never shadow the staged identity.
            if let Some(name) = id_ref {
                let data_slot = binding_ident("n", &self.binding_seq.to_string());
                self.binding_seq += 1;
                let call = format!("$hookCtx.stage({{op:\"create\",model:{},id:{name}.id{parent_text},data:{data_slot}}})", js_string(model));
                return vec![
                    (format!("{pad}const {slot}=$stagedNext++;"), span),
                    (format!("{pad}const {data_slot}={data};"), span),
                    (
                        format!("{pad}const {name}={{...{data_slot},id:{id_value}}};"),
                        span,
                    ),
                    (format!("{pad}{call};"), span),
                ];
            }
            let call = format!("$hookCtx.stage({{op:\"create\",model:{},id:{id_value}{parent_text},data:{data}}})", js_string(model));
            return vec![
                (format!("{pad}const {slot}=$stagedNext++;"), span),
                (format!("{pad}{call};"), span),
            ];
        }
        let mut lines: Vec<(String, Span)> = match &id_ref {
            Some(name) => {
                vec![
                    (format!("{pad}const {slot}=$stagedNext++;"), span),
                    (format!("{pad}const {name}={{id:{id_value}}};"), span),
                ]
            }
            None => {
                vec![
                    (format!("{pad}const {slot}=$stagedNext++;"), span),
                    (format!("{pad}$pending={{id:{id_value}}};"), span),
                ]
            }
        };
        let id_ref = id_ref.unwrap_or_else(|| "$pending".to_string());
        lines.push((
            format!(
                "{pad}$hookCtx.stage({{op:\"create\",model:{},id:{id_ref}.id{parent_text},data:{data}}});",
                js_string(model)
            ),
            span,
        ));
        lines
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
        // A staged update leaves no local state behind, so a staged
        // alias written here no longer offers its created data to reads.
        if let IrExpr::Name(name) = &record.expr {
            self.hook_staged_data.remove(name);
        }
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
    fn lower_role_subject(&self, role: &str, person: &TypedExpr, value: &str) -> String {
        if person.ty.nullable_inner().is_some() {
            // Absence is false. It never selects the helper's actor overload.
            // The original subject evaluates once before the awaited lookup.
            format!(
                "(await (async($roleSubject)=>$roleSubject==null?false:await hasRole(c,{},$roleSubject))({value}))",
                js_string(role),
            )
        } else {
            format!("await hasRole(c,{},{value})", js_string(role))
        }
    }

    pub fn lower_guard_bool(&mut self, guard: &IrGuard) -> String {
        match guard {
            IrGuard::Role(id) => {
                self.stdlib.insert("hasRole".to_string());
                format!("hasRole(c,{})", js_string(id))
            }
            IrGuard::Subject { role, person } => {
                self.stdlib.insert("hasRole".to_string());
                let person_text = self.lower_business_expr(person, "formatted guard identity");
                self.lower_role_subject(role, person, &person_text)
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
        self.lower_ui_occurrence(node, ctx, &[], None, false)
    }

    fn original_ui_row(&self, value: &TypedExpr, model: &str) -> Option<String> {
        let (
            IrExpr::Name(name),
            ResolvedType::Record {
                symbol,
                stored: true,
            },
        ) = (&value.expr, &value.ty)
        else {
            return None;
        };
        let item = self.ir.items.get(symbol.0 as usize)?;
        if item.id != *symbol
            || item.canonical != model
            || !matches!(item.kind, IrItemKind::Model { .. })
        {
            return None;
        }
        self.original_ui_rows
            .iter()
            .rev()
            .find(|row| row.name == *name)
            .filter(|row| row.model == model)
            .and_then(|row| row.binding.clone())
    }

    /// Static source operation admission can omit a control before any of its
    /// arguments or captions evaluate. Input/subject-dependent rules are not
    /// evaluated with unbound form parameters.
    fn control_role_admission(&mut self, node: &IrUi) -> Option<String> {
        if !matches!(node.factory.as_str(), "form" | "deleteRecord") {
            return None;
        }
        let operation = form_prop_text(node, "operation")?;
        let item = self
            .ir
            .items
            .iter()
            .find(|item| item.canonical == operation)?;
        let by = match &item.kind {
            IrItemKind::Scenario { by, .. } | IrItemKind::CrudOp { by, .. } => by,
            _ => return None,
        };
        fn role_only(guard: &IrGuard) -> bool {
            match guard {
                IrGuard::Role(_) => true,
                IrGuard::And(guards) | IrGuard::Or(guards) => guards.iter().all(role_only),
                IrGuard::Not(inner) => role_only(inner),
                IrGuard::Subject { .. } | IrGuard::Expr(_) => false,
            }
        }
        if by.is_empty() || !by.iter().all(role_only) {
            return None;
        }
        let by = by.clone();
        Some(
            by.iter()
                .map(|guard| format!("({})", self.lower_guard_bool(guard)))
                .collect::<Vec<_>>()
                .join(" && "),
        )
    }

    /// Emit one prompted `show` site as a saved-renderer call: the
    /// declaration children pre-render as named bindings (canonical
    /// control kind or leaf factory in declaration order, repeats
    /// taking a 2-based numeric suffix so names stay unique and
    /// stable), the row still evaluates exactly once, and the
    /// definition gate still omits the whole instance. The descriptor
    /// carries the presentation wire version the UI factory asserts;
    /// the renderer arrives as a relative import of the staged view
    /// module the driver packs.
    #[allow(clippy::too_many_arguments)]
    fn lower_saved_view_instance(
        &mut self,
        node: &IrUi,
        view: &IrViewUse,
        ctx: &str,
        argument: &str,
        row: &str,
        occurrences: &[String],
        original_row: Option<&str>,
        guard: &str,
        lowered: &[String],
        plan: &ResolvedShow,
    ) -> String {
        use super::then_views::ThenControl;
        self.ui.insert("generatedViewInstance".to_string());
        let factory = binding_ident("u", "generatedViewInstance");
        let render = binding_ident("v", &plan.unit_id);
        self.relative
            .entry(format!("./can.generated/{}/view.js", plan.unit_id))
            .or_default()
            .insert(format!("render as {render}"));
        let controls = plan
            .controls
            .iter()
            .map(|control| match control {
                ThenControl::Edit { fields } => format!(
                    "{{kind:{},fields:[{}]}}",
                    js_string("edit"),
                    fields
                        .iter()
                        .map(|f| js_string(f))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
                ThenControl::Delete => format!("{{kind:{}}}", js_string("delete")),
                ThenControl::Form { operation, fields } => format!(
                    "{{kind:{},operation:{},fields:[{}]}}",
                    js_string("form"),
                    js_string(operation),
                    fields
                        .iter()
                        .map(|f| js_string(f))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
                ThenControl::Action { operation } => format!(
                    "{{kind:{},operation:{}}}",
                    js_string("action"),
                    js_string(operation)
                ),
                // The presentation descriptor carries one optional
                // operation per control, so action groups name their
                // kind only; the runtime does not consume controls.
                ThenControl::Actions { .. } => format!("{{kind:{}}}", js_string("actions")),
                ThenControl::Primary => format!("{{kind:{}}}", js_string("primary")),
                ThenControl::Secondary => format!("{{kind:{}}}", js_string("secondary")),
            })
            .collect::<Vec<_>>()
            .join(",");
        let root_style = plan
            .root_style
            .as_deref()
            .map(|style| format!(",rootStyle:{}", js_string(style)))
            .unwrap_or_default();
        let renderer_style = plan
            .renderer_style
            .as_ref()
            .map(|unit| format!(",rendererStyle:{}", js_string(unit)))
            .unwrap_or_default();
        let descriptor = format!(
            "{{version:{},view:{},rowModel:{},controls:[{controls}]{root_style}{renderer_style}}}",
            js_string(GENERATED_VIEW_WIRE_VERSION),
            js_string(&plan.view_name),
            js_string(&plan.row_model),
        );
        let mut counts: HashMap<&str, usize> = HashMap::new();
        let mut bindings = Vec::new();
        let mut has_priorities = false;
        for (child, html) in node.children.iter().zip(lowered.iter()) {
            let source_name = plan
                .binding_names
                .iter()
                .find(|(span, _)| *span == child.span)
                .map(|(_, name)| name.as_str())
                .unwrap_or(child.factory.as_str());
            let priority = matches!(source_name, "primary" | "secondary");
            has_priorities |= priority;
            let count = counts.entry(source_name).or_insert(0);
            *count += 1;
            let name = if *count == 1 || priority {
                source_name.to_string()
            } else {
                format!("{}{}", source_name, *count)
            };
            bindings.push(format!(
                "{{name:{},html:(await ({html}))??\"\"}}",
                js_string(&name)
            ));
        }
        let bindings = bindings.join(",");
        let bindings = if has_priorities {
            self.ui.insert("actionBindings".into());
            let entries = binding_ident("b", "view_entries");
            let grouped = binding_ident("b", "view_actions");
            // Evaluate every original binding in authored order first. Only
            // then combine exact trusted action roots into one opaque binding.
            format!(
                "(({entries})=>{{const {grouped}={}({entries}.filter(value=>value.name===\"primary\"||value.name===\"secondary\").map(value=>value.html));const seen=new Set();return {entries}.flatMap(value=>{{if(value.name!==\"primary\"&&value.name!==\"secondary\")return [value];if(seen.has(value.name))return [];seen.add(value.name);return [{{name:value.name,html:{grouped}[value.name]}}];}});}})([{bindings}])",
                binding_ident("u", "actionBindings")
            )
        } else {
            format!("[{bindings}]")
        };
        format!(
            "await (async({row})=>{{{guard}return await {factory}({{context:{ctx},descriptor:{descriptor},useId:{use_id},row:{presentation_row},bindings:{bindings},render:{render}}});}})({argument})",
            use_id = format!("{}+'-o'+JSON.stringify([{}]).split('').map(value=>value.charCodeAt(0).toString(16).padStart(4,'0')).join('')", js_string(&view.identity), occurrences.join(",")),
            presentation_row = original_row.map(str::to_owned).unwrap_or_else(|| format!("(({{id,version,...fields}})=>({{id,version:version===undefined?undefined:version.toString(),fields}}))({row})")),
        )
    }

    /// Occurrence identities thread through enclosing collection rows so
    /// repeated tabsets never share their radio group or panel identifiers.
    fn lower_ui_occurrence(
        &mut self,
        node: &IrUi,
        ctx: &str,
        occurrences: &[String],
        prepared_form: Option<&str>,
        view_scope: bool,
    ) -> String {
        self.lower_ui_occurrence_admitted(node, ctx, occurrences, prepared_form, view_scope, false)
    }

    #[allow(clippy::too_many_arguments)]
    fn lower_ui_occurrence_admitted(
        &mut self,
        node: &IrUi,
        ctx: &str,
        occurrences: &[String],
        prepared_form: Option<&str>,
        view_scope: bool,
        control_admitted: bool,
    ) -> String {
        let style = self
            .then_join
            .as_ref()
            .and_then(|join| join.style_at(&node.span))
            .cloned();
        let html = self.lower_ui_occurrence_unstyled(
            node,
            ctx,
            occurrences,
            prepared_form,
            view_scope,
            control_admitted,
        );
        if let Some(unit) = style {
            self.ui.insert("styledComponent".to_string());
            let helper = binding_ident("u", "styledComponent");
            let mut identity = js_string(&format!(
                "can-style-f{}-s{}",
                node.span.file.0, node.span.start
            ));
            if !occurrences.is_empty() {
                identity.push_str(&format!(
                    "+encodeURIComponent(JSON.stringify([{}]))",
                    occurrences.join(",")
                ));
            }
            format!("{helper}(({html}),{},{identity})", js_string(&unit))
        } else {
            html
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn lower_ui_occurrence_unstyled(
        &mut self,
        node: &IrUi,
        ctx: &str,
        occurrences: &[String],
        prepared_form: Option<&str>,
        view_scope: bool,
        control_admitted: bool,
    ) -> String {
        // Settle earlier children before later siblings cross a source await.
        let sequence_children = node.children.iter().any(ui_immediate_uses_async)
            || node.factory == "gallery"
            || (view_scope && node.factory == "chatBubble");
        let direct_priorities = node
            .children
            .iter()
            .any(|child| matches!(child.factory.as_str(), "primaryActions" | "actionMenu"));
        let scope_children = if direct_priorities {
            self.ui.insert("renderActionScope".into());
            format!("{}(children)", binding_ident("u", "renderActionScope"))
        } else {
            "children.filter(value=>value!=null).join('')".into()
        };
        if node.factory == "callbackValueCard" {
            if !self.ir.callback_grants.matches_value_list(self.ir, node) {
                self.unsupported(
                    "callback value card",
                    "original checked readonly diagnostic card is required",
                    node.span,
                );
                return self.throw_expr("unsupported callback value card");
            }
            let guard = node
                .gate
                .as_ref()
                .map(|gate| {
                    let value = self.lower_business_expr(gate, "callback value card gate");
                    format!("if(!({value}))return '';")
                })
                .unwrap_or_default();
            let children = node
                .children
                .iter()
                .map(|child| {
                    let value = self.lower_ui_occurrence(child, ctx, occurrences, None, true);
                    format!("children.push(await ({value}));")
                })
                .collect::<Vec<_>>()
                .join("");
            return format!(
                "await (async()=>{{{guard}const children=[];{children}return '<section class=\"card bg-base-100 shadow\"><div class=\"card-body\">'+{scope_children}+'</div></section>';}})()"
            );
        }
        if matches!(
            node.factory.as_str(),
            "callbackValueList" | "inspectionValueList" | "textMessageValueList"
        ) {
            if !self.ir.callback_grants.matches_value_list(self.ir, node) {
                self.unsupported(
                    "callback value list",
                    "original checked readonly diagnostic array is required",
                    node.span,
                );
                return self.throw_expr("unsupported callback value list");
            }
            // The released text sink consumes original File/File[] values.
            // Keep attachment objects untouched: only the admitted host's
            // source-bound presenter can turn those identities into links.
            let values = &node.props[0].1;
            let source = if node.factory == "textMessageValueList" {
                let original = match &values.expr {
                    IrExpr::Member { base, field } => match &base.ty {
                        ResolvedType::Record { symbol, .. } => self
                            .original_ui_row(base, &self.ir.items[symbol.0 as usize].canonical)
                            .map(|original| format!("{original}.fields[{}]", js_string(field))),
                        _ => None,
                    },
                    _ => None,
                };
                let Some(original) = original else {
                    self.unsupported(
                        "copied message source",
                        "the original owning stored RowView is required",
                        values.span,
                    );
                    return self.throw_expr("unsupported copied message source");
                };
                original
            } else {
                self.lower_expr(values)
            };
            let gate = node
                .gate
                .as_ref()
                .map(|gate| self.lower_business_expr(gate, "callback value list gate"));
            let empty = node.props.iter().find(|(name, _)| name == "empty").map(|(_, value)| {
                self.ui.insert("renderState".to_string());
                let message = self.lower_expr(value);
                format!("if(values.length===0)return await {}({{context:{ctx},kind:\"empty\",message:{message}}});", binding_ident("u", "renderState"))
            }).unwrap_or_default();
            self.enter_scope();
            let (alias, _) = node
                .row_scope
                .as_ref()
                .expect("checked callback list alias");
            let row = self.bind(alias);
            let index = binding_ident("r", &format!("callback_index_{}", node.span.start));
            let mut nested = occurrences.to_vec();
            nested.push(index.clone());
            let children = node
                .children
                .iter()
                .map(|child| {
                    let child = self.lower_ui_occurrence(child, ctx, &nested, None, true);
                    format!("children.push(await ({child}));")
                })
                .collect::<Vec<_>>()
                .join("");
            self.exit_scope();
            let guard = gate
                .map(|gate| format!("if(!({gate}))return '';"))
                .unwrap_or_default();
            if matches!(
                node.factory.as_str(),
                "inspectionValueList" | "textMessageValueList"
            ) && node
                .props
                .iter()
                .any(|(name, value)| name == "page" && matches!(value.expr, IrExpr::Bool(true)))
            {
                for helper in ["message", "resolveCaption", "escapeHtml"] {
                    self.ui.insert(helper.to_string());
                }
                let group = format!("can-inspection-f{}-s{}-", node.span.file.0, node.span.start);
                let occurrence = format!(
                    "JSON.stringify([{ctx}.path,{}]).split('').map(value=>value.charCodeAt(0).toString(16).padStart(4,'0')).join('')",
                    occurrences.join(",")
                );
                let message = binding_ident("u", "message");
                let caption = binding_ident("u", "resolveCaption");
                let escape_html = binding_ident("u", "escapeHtml");
                // Paging changes visibility of this complete authorized snapshot.
                // It performs no query and preserves each child's once/order/failure.
                // A nonexistent form owner prevents these presentation radios from
                // adding inputs to any enclosing business form.
                return format!(
                    r#"await (async()=>{{{guard}const values={source};{empty}const rows=[];let {index}=0;for(const {row} of values){{const children=[];{children}rows.push('<li class="list-row">'+{scope_children}+'</li>');{index}++;}}if(rows.length<=25)return '<ul class="list">'+rows.join('')+'</ul>';const id={group}+{occurrence};const pages=Math.ceil(rows.length/25);let controls='',panels='',css='#'+id+'>[data-can-inspection-page]{{display:none}}';for(let page=0;page<pages;page++){{const input=id+'-page-'+page;const label={caption}({message}("Page {{number}}",{{nl:"Pagina {{number}}"}},{{number:{{type:"int",value:BigInt(page+1)}}}}),{ctx});controls+='<input type="radio" class="radio" id="'+input+'" name="'+id+'" form="'+id+'-presentation" aria-controls="'+id+'-panel-'+page+'"'+(page===0?' checked':'')+'><label class="btn btn-sm" for="'+input+'">'+{escape_html}(label)+'</label>';panels+='<ul class="list" id="'+id+'-panel-'+page+'" data-can-inspection-page="'+page+'">'+rows.slice(page*25,(page+1)*25).join('')+'</ul>';css+='#'+input+':checked~[data-can-inspection-page="'+page+'"]{{display:block}}';}}const legend={caption}({message}("Pages",{{nl:"Pagina’s"}}),{ctx});return '<fieldset id="'+id+'"><legend>'+{escape_html}(legend)+'</legend><style>'+css+'</style>'+controls+panels+'</fieldset>';}})()"#,
                    group = js_string(&group)
                );
            }
            // Only constant wrappers are authored here; all business values
            // remain escaped by their existing presentation factories.
            return format!(
                "await (async()=>{{{guard}const values={source};{empty}let output='<ul class=\"list\">';let {index}=0;for(const {row} of values){{const children=[];{children}output+='<li class=\"list-row\">'+{scope_children}+'</li>';{index}++;}}return output+'</ul>';}})()"
            );
        }
        if let Some(view) = &node.view {
            // Evaluate the supplied authorized row once in the caller scope,
            // then shadow it only for this declaration-owned expansion.
            let argument = self.lower_business_expr(&view.argument, "view row argument");
            let model = match &view.argument.ty {
                ResolvedType::Record {
                    symbol,
                    stored: true,
                } => self
                    .ir
                    .items
                    .get(symbol.0 as usize)
                    .map(|item| item.canonical.clone())
                    .unwrap_or_default(),
                _ => String::new(),
            };
            let original = self.original_ui_row(&view.argument, &model);
            self.enter_scope();
            let row = self.bind("row");
            self.original_ui_rows.push(OriginalUiRow {
                name: "row".to_string(),
                model,
                binding: original.clone(),
            });
            let mut nested = occurrences.to_vec();
            nested.push(js_string(&view.identity));
            nested.push(format!("{row}.id"));
            let gate = node
                .gate
                .as_ref()
                .map(|gate| self.lower_business_expr(gate, "view gate"));
            let lowered = node
                .children
                .iter()
                .map(|child| {
                    sequence_ui_child(
                        self.lower_ui_occurrence(child, ctx, &nested, None, true),
                        sequence_children,
                    )
                })
                .collect::<Vec<_>>();
            self.original_ui_rows.pop();
            self.exit_scope();
            let guard = gate
                .map(|gate| format!("if(!({gate}))return '';"))
                .unwrap_or_default();
            // Prompted views with a usable saved unit call their saved
            // renderer; anything else keeps the ordinary declaration
            // expansion (the driver diagnoses missing inputs loudly).
            let plan = self
                .then_join
                .as_ref()
                .and_then(|join| join.show_at(&node.span))
                .cloned();
            if let Some(plan) = plan {
                return self.lower_saved_view_instance(
                    node,
                    view,
                    ctx,
                    &argument,
                    &row,
                    &nested,
                    original.as_deref(),
                    &guard,
                    &lowered,
                    &plan,
                );
            }
            let children = lowered.join(",");
            let rendered =
                format!("(await Promise.all([{children}])).filter(value=>value!=null).join('')");
            return format!("await (async({row})=>{{{guard}return {rendered};}})({argument})");
        }
        if matches!(node.factory.as_str(), "actionMenu" | "primaryActions") {
            self.ui.insert(node.factory.clone());
            let gate = node
                .gate
                .as_ref()
                .map(|gate| self.lower_business_expr(gate, "action menu gate"));
            let admission = if node.children.len() == 1 {
                self.control_role_admission(&node.children[0])
            } else {
                None
            };
            let admitted = admission.is_some();
            let gate = match (gate, admission) {
                (Some(authored), Some(admission)) => Some(format!("({authored}) && ({admission})")),
                (gate, None) => gate,
                (None, admission) => admission,
            };
            let children = node
                .children
                .iter()
                .map(|child| {
                    sequence_ui_child(
                        self.lower_ui_occurrence_admitted(
                            child,
                            ctx,
                            occurrences,
                            prepared_form,
                            view_scope,
                            admitted,
                        ),
                        sequence_children,
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            let id = format!(
                "{}+'-o'+JSON.stringify([{}]).split('').map(value=>value.charCodeAt(0).toString(16).padStart(4,'0')).join('')",
                js_string(&format!(
                    "can-action-menu-f{}-s{}",
                    node.span.file.0, node.span.start
                )),
                occurrences.join(",")
            );
            let identity = if node.factory == "actionMenu" {
                format!(",id:{id}")
            } else {
                String::new()
            };
            let call = format!(
                "await {}({{context:{ctx}{identity},children:[{children}]}})",
                binding_ident("u", &node.factory)
            );
            return match gate {
                Some(gate) => format!("{gate} ? {call} : null"),
                None => call,
            };
        }
        // Checked source action groups contain ordinary protected forms.
        // Their grouping adds no native container or presentation choice.
        if node.factory == "actions" {
            let gate = node
                .gate
                .as_ref()
                .map(|gate| self.lower_business_expr(gate, "action group gate"));
            let children = node
                .children
                .iter()
                .map(|child| {
                    sequence_ui_child(
                        self.lower_ui_occurrence(
                            child,
                            ctx,
                            occurrences,
                            prepared_form,
                            view_scope,
                        ),
                        sequence_children,
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            let call =
                format!("(await Promise.all([{children}])).filter(value=>value!=null).join('')");
            return match gate {
                Some(gate) => format!("{gate} ? {call} : null"),
                None => call,
            };
        }
        if node.factory == "detailsDrawer" {
            let model = form_prop_text(node, "model");
            let record = node
                .props
                .iter()
                .find(|(key, _)| key == "record")
                .map(|(_, value)| value);
            let original = model
                .as_ref()
                .zip(record)
                .and_then(|(model, record)| self.original_ui_row(record, model));
            let caption = node
                .props
                .iter()
                .find(|(key, _)| key == "caption")
                .map(|(_, value)| value);
            if node.props.len() != 3
                || node.children.is_empty()
                || node.row_scope.is_some()
                || original.is_none()
                || caption.is_none()
                || node
                    .props
                    .iter()
                    .any(|(key, _)| !matches!(key.as_str(), "model" | "record" | "caption"))
                || !caption.is_some_and(|value| {
                    matches!(
                        value.ty,
                        ResolvedType::Scalar(Scalar::Text)
                            | ResolvedType::InlineMessage
                            | ResolvedType::Message(_)
                    )
                })
            {
                self.unsupported("details drawer", "the original owning queried RowView, checked caption and lazy body are required", node.span);
                return self.throw_expr("unsupported details drawer profile");
            }
            let record = record.unwrap();
            let IrExpr::Name(row_name) = &record.expr else {
                unreachable!()
            };
            let original = original.unwrap();
            let model = model.unwrap();
            let caption = self.lower_business_expr(caption.unwrap(), "details drawer caption");
            let gate = node
                .gate
                .as_ref()
                .map(|value| self.lower_business_expr(value, "details drawer gate"));
            // Selection names the repeated source site under its enclosing
            // parent occurrences. This row is the selector value, never part
            // of the selector key (one activated row per repeated site).
            let current = format!("{}.id", self.lower_expr(record));
            let enclosing = occurrences
                .iter()
                .filter(|entry| **entry != current)
                .cloned()
                .collect::<Vec<_>>();
            let occurrence = format!(
                "{}+encodeURIComponent(JSON.stringify([{}.path,{},{}]))",
                js_string(&format!(
                    "can-details-f{}-s{}-",
                    node.span.file.0, node.span.start
                )),
                ctx,
                js_string(&model),
                enclosing.join(",")
            );
            self.enter_scope();
            let actual_row = binding_ident(
                "details",
                &format!("{}:{}:row", node.span.file.0, node.span.start),
            );
            let actual_ctx = binding_ident(
                "details",
                &format!("{}:{}:context", node.span.file.0, node.span.start),
            );
            self.original_ui_rows.push(OriginalUiRow {
                name: row_name.clone(),
                model,
                binding: Some(actual_row.clone()),
            });
            let children = node
                .children
                .iter()
                .map(|child| {
                    sequence_ui_child(
                        self.lower_ui_occurrence(
                            child,
                            &actual_ctx,
                            occurrences,
                            prepared_form,
                            view_scope,
                        ),
                        true,
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            self.original_ui_rows.pop();
            self.exit_scope();
            self.ui.insert("detailsDrawer".to_string());
            let call = format!(
                "{}({{context:{ctx},caption:{caption},occurrence:{occurrence},record:{original},renderBody:async({actual_row},{actual_ctx})=>[{children}]}})",
                binding_ident("u", "detailsDrawer")
            );
            return match gate {
                Some(gate) => format!("{gate} ? {call} : null"),
                None => call,
            };
        }
        if node.factory == "breadcrumbs" {
            if !node.props.is_empty() || !node.children.is_empty() || node.row_scope.is_some() {
                self.unsupported(
                    "breadcrumbs",
                    "only the bare admitted-context profile lowers",
                    node.span,
                );
                return self.throw_expr("unsupported breadcrumbs profile");
            }
            self.ui.insert("breadcrumbs".to_string());
            let trail = binding_ident("breadcrumb", "admitted");
            let call = format!(
                "(()=>{{const {trail}={ctx}.breadcrumbs;if({trail}==null)throw new Error(\"breadcrumbs: admitted declared ancestry is unavailable\");return {}({{context:{ctx},label:{trail}.label,ancestry:{trail}.ancestry}});}})()",
                binding_ident("u", "breadcrumbs")
            );
            return match node.gate.as_ref() {
                Some(gate) => {
                    let gate = self.lower_business_expr(gate, "breadcrumbs gate");
                    format!("{gate} ? {call} : null")
                }
                None => call,
            };
        }
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
        if matches!(node.factory.as_str(), "label" | "validator")
            && (prepared_form.is_none()
                || !node.children.is_empty()
                || node.row_scope.is_some()
                || form_prop_text(node, "field").is_none())
        {
            self.unsupported(
                "owned UI fragment",
                "only an owned prepared field label or validation outlet lowers",
                node.span,
            );
            return self.throw_expr("unsupported owned field fragment");
        }
        if matches!(node.factory.as_str(), "checkbox" | "range" | "fileInput")
            && (prepared_form.is_none()
                || !node.children.is_empty()
                || node.gate.is_some()
                || form_prop_text(node, "field").is_none())
        {
            self.unsupported(
                "owned UI control",
                "only an owned prepared field control lowers",
                node.span,
            );
            return self.throw_expr("unsupported owned control profile");
        }
        if node.factory == "calendar"
            && form_prop_text(node, "kind").as_deref() != Some("agenda")
            && (prepared_form.is_none()
                || !node.children.is_empty()
                || form_prop_text(node, "kind").as_deref() != Some("field")
                || form_prop_text(node, "field").is_none()
                || node
                    .props
                    .iter()
                    .any(|(key, _)| !matches!(key.as_str(), "kind" | "field")))
        {
            self.unsupported(
                "calendar UI control",
                "only an owned prepared date field control lowers",
                node.span,
            );
            return self.throw_expr("unsupported calendar profile");
        }
        if node.factory == "calendar"
            && form_prop_text(node, "kind").as_deref() == Some("agenda")
            && !collection_filter_props_are_valid(self.ir, node)
        {
            self.unsupported(
                "calendar agenda",
                "endpoints, enum filters and defaults need matching owned declarations",
                node.span,
            );
            return self.throw_expr("unsupported calendar agenda profile");
        }
        if node.factory == "table"
            && let Some((_, value)) = node.props.iter().find(|(key, _)| key == "where")
            && let IrExpr::PageTimePredicate(predicate) = &value.expr
            && predicate.checked_parts(self.ir, node, value).is_none()
        {
            self.unsupported(
                "table time predicate",
                "the original checked source and owning datetime field are required",
                value.span,
            );
            return self.throw_expr("unsupported table time predicate");
        }
        if node.factory == "table"
            && node
                .props
                .iter()
                .any(|(key, _)| matches!(key.as_str(), "filter" | "defaults"))
            && !collection_filter_props_are_valid(self.ir, node)
        {
            self.unsupported(
                "table filters",
                "enum fields and defaults need matching owned declarations and data-only where",
                node.span,
            );
            return self.throw_expr("unsupported table filter profile");
        }
        if node.factory == "filter" && !standalone_filter_binding_is_valid(self.ir, node) {
            self.unsupported(
                "standalone filter",
                "an owned saved-preference binding with matching cases needs checked preference declarations",
                node.span,
            );
            return self.throw_expr("unsupported standalone filter profile");
        }
        if matches!(node.factory.as_str(), "list" | "board")
            && node
                .props
                .iter()
                .any(|(key, _)| matches!(key.as_str(), "filter" | "defaults"))
            && !collection_filter_props_are_valid(self.ir, node)
        {
            let what = format!("{} filters", node.factory);
            self.unsupported(
                &what,
                "enum fields and defaults need matching owned declarations and data-only where",
                node.span,
            );
            return self.throw_expr("unsupported collection filter profile");
        }
        if node.factory == "gallery" && !collection_filter_props_are_valid(self.ir, node) {
            self.unsupported(
                "gallery",
                "one owning singular File selector and checked row/filter carriers are required",
                node.span,
            );
            return self.throw_expr("unsupported gallery profile");
        }
        for (key, value) in &node.props {
            if !ui_prop_is_admitted(&node.factory, key) {
                self.unsupported(
                    &format!("{} UI option `{key}`", node.factory),
                    "the owning factory profile does not consume this property",
                    value.span,
                );
                return self.throw_expr("unsupported UI option");
            }
            let typed = match key.as_str() {
                "value" if node.factory == "progress" => {
                    value.ty.nullable_inner().unwrap_or(&value.ty)
                        == &ResolvedType::Scalar(Scalar::Int)
                }
                "max" if node.factory == "progress" => {
                    value.ty == ResolvedType::Scalar(Scalar::Int)
                }
                "value" if node.factory == "radialProgress" => {
                    matches!(
                        value.ty.nullable_inner().unwrap_or(&value.ty),
                        ResolvedType::Scalar(Scalar::Int | Scalar::Decimal)
                    )
                }
                "max" if node.factory == "radialProgress" => {
                    value.ty == ResolvedType::Scalar(Scalar::Int)
                }
                "kind" if node.factory == "renderState" => {
                    matches!(&value.expr, IrExpr::Text(kind) if kind == "loading")
                }
                "page"
                    if matches!(
                        node.factory.as_str(),
                        "list" | "table" | "calendar" | "gallery" | "timeline"
                    ) =>
                {
                    matches!(value.expr, IrExpr::Bool(true))
                }
                "field" if node.factory == "checkbox" || node.factory == "toggle" => {
                    matches!(value.ty, ResolvedType::Scalar(Scalar::Text))
                }
                "kind" | "field" if node.factory == "calendar" => {
                    matches!(value.ty, ResolvedType::Scalar(Scalar::Text))
                }
                "open" => matches!(value.ty, ResolvedType::Scalar(Scalar::Bool)),
                "caption" if node.factory == "link" && value.ty == ResolvedType::Scalar(Scalar::Url) => true,
                "caption" | "title" | "text" | "label" | "message" => matches!(
                    value.ty,
                    ResolvedType::Scalar(Scalar::Text)
                        | ResolvedType::InlineMessage
                        | ResolvedType::Message(_)
                ),
                "target" if matches!(node.factory.as_str(), "button" | "link") => {
                    matches!(
                        value.ty,
                        ResolvedType::Scalar(Scalar::Text | Scalar::Url | Scalar::File)
                    ) || matches!(&value.ty, ResolvedType::Nullable(inner)
                            if inner.as_ref() == &ResolvedType::Scalar(Scalar::File)
                                || (node.factory == "link"
                                    && inner.as_ref() == &ResolvedType::Scalar(Scalar::Url)))
                }
                "regionId" | "target" | "opens" => {
                    matches!(value.ty, ResolvedType::Scalar(Scalar::Text))
                }
                "submit" if node.factory == "button" => {
                    matches!(value.expr, IrExpr::Bool(true))
                }
                "submit" => matches!(
                    value.ty,
                    ResolvedType::Scalar(Scalar::Text)
                        | ResolvedType::InlineMessage
                        | ResolvedType::Message(_)
                ),
                _ => true,
            };
            if !typed {
                self.unsupported(
                    &format!("{} UI option `{key}`", node.factory),
                    "value has no checked type for the owning factory property",
                    value.span,
                );
                return self.throw_expr("unsupported UI property type");
            }
            if let Some(words) = ui_option_words(&node.factory, key)
                && !matches!(&value.expr, IrExpr::Text(word) if words.contains(&word.as_str()))
            {
                self.unsupported(
                    &format!("{} UI option `{key}`", node.factory),
                    &format!("only the owning finite words {} lower", words.join(", ")),
                    value.span,
                );
                return self.throw_expr("unsupported UI option value");
            }
        }
        // Omitted collection empty captions use the owning shared UI default.
        // Gated containers omit the whole node when unavailable; the
        // gate reads the same scope the node renders in.
        let gate = node
            .gate
            .as_ref()
            .map(|g| self.lower_business_expr(g, "formatted UI gate"));
        let admission = if control_admitted {
            None
        } else {
            self.control_role_admission(node)
        };
        let gate = match (gate, admission) {
            (Some(authored), Some(admission)) => Some(format!("({authored}) && ({admission})")),
            (gate, None) => gate,
            (None, admission) => admission,
        };
        self.ui.insert(node.factory.clone());
        if node.factory == "form" {
            // Await preparation once before authored children. The request
            // stays in the surrounding scope and preserves source evaluation
            // order; the existing gate encloses preparation as well as render.
            let mut request = Vec::new();
            for (key, value) in &node.props {
                request.push(format!(
                    "{}:{}",
                    object_key(key),
                    self.lower_business_expr(value, "unclassified formatted UI prop")
                ));
            }
            // The declaration, page, action target and enclosing use/row
            // identities name this presentation occurrence. The preparer
            // owns DOM and draft identity; this conveys no mutation grant.
            let operation = form_prop_text(node, "operation").unwrap_or_default();
            request.push(format!(
                "occurrence:{}+encodeURIComponent(JSON.stringify([{}.path,{},{}]))",
                js_string(&format!(
                    "can-form-f{}-s{}-",
                    node.span.file.0, node.span.start
                )),
                ctx,
                js_string(&operation),
                occurrences.join(",")
            ));
            if let Some(labels) = self.form_labels_request(node) {
                request.push(labels);
            }
            let mut authored = Vec::new();
            for child in &node.children {
                collect_authored_form_fields(child, &mut authored);
            }
            let mut placed = std::collections::HashSet::new();
            if authored.iter().any(|field| !placed.insert(field)) {
                self.unsupported(
                    "form authored controls",
                    "each writable input admits only one authored control",
                    node.span,
                );
                return self.throw_expr("duplicate authored form control");
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
            for (factory, property) in [
                ("label", "authoredLabels"),
                ("validator", "authoredValidators"),
            ] {
                let mut fragments = Vec::new();
                for child in &node.children {
                    collect_authored_form_fragments(child, factory, &mut fragments);
                }
                let mut placed = std::collections::HashSet::new();
                if fragments.iter().any(|field| !placed.insert(field)) {
                    self.unsupported(
                        "form authored fragments",
                        &format!("each writable input admits only one authored {factory}"),
                        node.span,
                    );
                    return self.throw_expr("duplicate authored form fragment");
                }
                if !fragments.is_empty() {
                    request.push(format!(
                        "{property}:[{}]",
                        fragments
                            .iter()
                            .map(|path| js_string(path))
                            .collect::<Vec<_>>()
                            .join(",")
                    ));
                }
            }
            self.enter_scope();
            // The IIFE owns this private name; nested forms shadow it in
            // their own IIFE without consuming authored binding identities.
            let prepared = binding_ident("f", "form");
            let children = node
                .children
                .iter()
                .map(|child| {
                    sequence_ui_child(
                        self.lower_ui_occurrence(
                            child,
                            ctx,
                            occurrences,
                            Some(&prepared),
                            view_scope,
                        ),
                        sequence_children,
                    )
                })
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
                "(({prepared})=>{{if({prepared}.status!==\"ready\")return {}({{context:{ctx},values:[{prepared}.message]}});return {}({ready_props});}})(await {ctx}.prepareForm({{{}}}))",
                binding_ident("u", "text"),
                binding_ident("u", "form"),
                request.join(",")
            );
            return match gate {
                Some(cond) => format!("{cond} ? {call} : null"),
                None => call,
            };
        }
        if (is_form_field_control(&node.factory)
            || matches!(node.factory.as_str(), "label" | "validator"))
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
        let panel_tabs = node.factory == "tabs"
            && node.props.iter().any(|(key, _)| key == "id")
            && node.children.iter().all(|child| child.factory == "tabItem");
        let mut props = vec![format!("context:{ctx}")];
        let original_history_row = if node.factory == "history" {
            let original = form_prop_text(node, "model").and_then(|model| {
                node.props
                    .iter()
                    .find(|(key, _)| key == "record")
                    .and_then(|(_, value)| self.original_ui_row(value, &model))
            });
            if original.is_none()
                || node.props.len() != 2
                || !node.children.is_empty()
                || node.row_scope.is_some()
            {
                self.unsupported(
                    "history",
                    "an original queried row and its checked owning model are required",
                    node.span,
                );
                return self.throw_expr("unsupported history row");
            }
            original
        } else {
            None
        };
        if node.factory == "gallery"
            || (node.factory == "calendar"
                && form_prop_text(node, "kind").as_deref() == Some("agenda"))
            || (matches!(node.factory.as_str(), "list" | "table")
                && (form_prop_text(node, "display").as_deref() == Some("split")
                    || node.props.iter().any(|(key, _)| key == "filter")
                    || node.props.iter().any(|(key, value)| {
                        key == "page" && matches!(value.expr, IrExpr::Bool(true))
                    })))
            || (node.factory == "timeline"
                && node.props.iter().any(|(key, value)| {
                    key == "page" && matches!(value.expr, IrExpr::Bool(true))
                }))
            || (node.factory == "board"
                && node.props.iter().any(|(key, value)| {
                    key == "filter" || key == "page" && matches!(value.expr, IrExpr::Bool(true))
                }))
        {
            // A URL locator names this source collection occurrence. The
            // owning factory selects only from its fresh authorized result.
            props.push(format!(
                "occurrence:{}+encodeURIComponent(JSON.stringify([{}.path,{}]))",
                js_string(&format!(
                    "can-collection-f{}-s{}-",
                    node.span.file.0, node.span.start
                )),
                ctx,
                occurrences.join(",")
            ));
        }
        for (key, value) in &node.props {
            let value = if node.factory == "table"
                && key == "where"
                && let IrExpr::PageTimePredicate(predicate) = &value.expr
            {
                let (operation, field, paginated) = predicate
                    .checked_parts(self.ir, node, value)
                    .expect("original table time predicate checked above");
                let query_time = if paginated {
                    "{kind:\"page-query-now\"}".to_string()
                } else {
                    self.stdlib.insert("encodeValue".to_string());
                    "encodeValue(\"datetime\",c.now)".to_string()
                };
                format!(
                    "{{op:{},field:{},value:{query_time}}}",
                    js_string(operation),
                    js_string(field)
                )
            } else if self.native_source_predicates
                && key == "where"
                && let IrExpr::Lambda { param, body } = &value.expr
            {
                self.enter_scope();
                let row = self.bind(param);
                let text = self.lower_expr(body);
                self.exit_scope();
                let prefix = if crate::codegen::ir::expr_uses_async(body) {
                    "async"
                } else {
                    ""
                };
                let predicate =
                    format!("{prefix}({row},$can$read$c)=>{{const c=$can$read$c;return {text};}}");
                if let Some(source) = self.membership_predicates.get(&body.span) {
                    format!(
                        "$can$read$issue({},{predicate})",
                        js_string(&descriptor_json(source))
                    )
                } else {
                    predicate
                }
            } else if node.factory == "progress" || node.factory == "radialProgress" {
                let decimal_value = node.factory == "radialProgress"
                    && key == "value"
                    && matches!(
                        value.ty.nullable_inner().unwrap_or(&value.ty),
                        ResolvedType::Scalar(Scalar::Decimal)
                    );
                if decimal_value {
                    // Recorded decimal completion fraction (50/100): the
                    // wire-canonical exact decimal text (R2a, the same text
                    // decimalToString owns) becomes the finite JS number the
                    // contracts/UI boundary owns; encodeValue is already in
                    // the page runtime. Unconvertible values stay
                    // presentation-invalid (NaN -> role=alert); the int max
                    // throw below still wins over a bad value.
                    self.stdlib.insert("encodeValue".to_string());
                    let expression = self.lower_business_expr(value, "decimal radial progress");
                    format!(
                        "(value=>{{if(value==null)return null;let text;if(typeof value===\"bigint\"){{text=value.toString(10);}}else if(typeof value===\"number\"){{if(!Number.isFinite(value))return NaN;return value;}}else{{try{{text=encodeValue(\"decimal\",value);}}catch(e){{return NaN;}}}}const number=Number(text);if(!Number.isFinite(number))return NaN;return number;}})({expression})"
                    )
                } else {
                    let expression = self.lower_business_expr(value, "integer progress");
                    let invalid = if key == "value" {
                        "return NaN;"
                    } else {
                        "throw new RangeError('progress maximum is not exactly displayable');"
                    };
                    format!(
                        "(value=>{{if(value==null)return null;const number=Number(value);if(!Number.isSafeInteger(number)){{{invalid}}}return number;}})({expression})"
                    )
                }
            } else if node.factory == "history" && key == "record" {
                original_history_row
                    .clone()
                    .expect("history row checked above")
            } else if node.factory == "text" && key == "values" {
                self.lower_expr(value)
            } else if key == "order"
                && matches!(
                    node.factory.as_str(),
                    "list" | "table" | "gallery" | "calendar" | "board"
                )
                && let Some(dispatched) = self.lower_dispatched_order(value)
            {
                dispatched
            } else {
                self.lower_business_expr(value, "unclassified formatted UI prop")
            };
            if self.native_source_predicates
                && key == "where"
                && let IrExpr::Lambda { body, .. } = &node
                    .props
                    .iter()
                    .find(|(name, _)| name == key)
                    .expect("current prop")
                    .1
                    .expr
                && let Some(source) = self.membership_predicates.get(&body.span)
            {
                props.push(format!("whereSource:{}", descriptor_json(source)));
            }
            // Source rows retain native BigInt versions. The delete form owns
            // a wire MutationRef, so capture its row once and encode only the
            // protected identity/version at this presentation boundary.
            let value = if node.factory == "deleteRecord" && key == "record" {
                let record = binding_ident("r", "delete_record");
                format!(
                    "(({record})=>({{id:{record}.id,version:{record}.version.toString(10)}}))({value})"
                )
            } else {
                value
            };
            let value = if node.factory == "deleteRecord"
                && key == "idPrefix"
                && form_prop_text(node, "display").as_deref() == Some("menu")
                && !occurrences.is_empty()
            {
                format!(
                    "{value}+'-o'+JSON.stringify([{}]).split('').map(value=>value.charCodeAt(0).toString(16).padStart(4,'0')).join('')",
                    occurrences.join(",")
                )
            } else if !occurrences.is_empty()
                && ((matches!(node.factory.as_str(), "modal" | "drawer") && key == "id")
                    || (node.factory == "button" && key == "opens"))
            {
                // Activation ids must match the shared ASCII identifier
                // contract. Each row/view chain names both ends identically.
                format!(
                    "{value}+'-o'+JSON.stringify([{}]).split('').map(value=>value.charCodeAt(0).toString(16).padStart(4,'0')).join('')",
                    occurrences.join(",")
                )
            } else if ((panel_tabs && key == "id")
                || (view_scope
                    && (matches!(key.as_str(), "id" | "idPrefix" | "regionId" | "opens")
                        || (key == "target" && node.factory != "button"))))
                && !occurrences.is_empty()
            {
                format!(
                    r#"{value}+"-"+encodeURIComponent(JSON.stringify([{}]))"#,
                    occurrences.join(",")
                )
            } else {
                value
            };
            props.push(format!("{}:{value}", object_key(key)));
        }
        if node.factory == "deleteRecord" {
            // Mint once in the rendered occurrence. The enclosing gate also
            // encloses this call; its hidden value survives form resubmission.
            self.ui.insert("mintOperationId".to_string());
            props.push(format!(
                "operationId:{}()",
                binding_ident("u", "mintOperationId")
            ));
        }
        if node.factory == "link"
            && node.props.iter().any(|(key, value)| {
                key == "target"
                    && matches!(&value.ty, ResolvedType::Nullable(inner)
                        if inner.as_ref() == &ResolvedType::Scalar(Scalar::Url))
            })
        {
            // A statically nullable-URL destination renders the shared
            // unavailable label (not the File caption default) when absent.
            // This static marker carries no evaluation: authored operand
            // order and gate/failure behavior are unchanged.
            props.push("absentUrl:true".to_string());
        }
        match &node.row_scope {
            Some((row, view)) => {
                self.enter_scope();
                let source_row = row.clone();
                let row = self.bind(row);
                let child_ctx = self.bind(view);
                let original_row = node.children.iter().any(ui_uses_original_row);
                let original =
                    binding_ident("rv", &format!("{}:{}", node.span.file.0, node.span.start));
                self.original_ui_rows.push(OriginalUiRow {
                    name: source_row,
                    model: form_prop_text(node, "model").unwrap_or_default(),
                    binding: original_row.then(|| original.clone()),
                });
                let mut child_occurrences = occurrences.to_vec();
                child_occurrences.push(format!("{row}.id"));
                let children = node
                    .children
                    .iter()
                    .map(|c| {
                        sequence_ui_child(
                            self.lower_ui_occurrence(
                                c,
                                &child_ctx,
                                &child_occurrences,
                                None,
                                view_scope,
                            ),
                            sequence_children,
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                // `async` exactly when a row child awaits.
                let prefix = if node.factory == "gallery" || node.children.iter().any(ui_uses_async)
                {
                    "async"
                } else {
                    ""
                };
                self.original_ui_rows.pop();
                let preserve_row = if original_row {
                    format!("const {original}={row};")
                } else {
                    String::new()
                };
                // Gallery fields are read by authored children in order;
                // exposing the row must not evaluate unused getters first.
                let fields = if node.factory == "gallery"
                    || node
                        .children
                        .iter()
                        .any(|child| ui_uses_message_values(child) || ui_uses_details_drawer(child))
                {
                    format!(
                        "Object.defineProperties({{id:{row}.id,version:{row}.version===undefined?undefined:BigInt({row}.version)}},Object.getOwnPropertyDescriptors({row}.fields))"
                    )
                } else {
                    format!(
                        "{{...{row}.fields,id:{row}.id,version:{row}.version===undefined?undefined:BigInt({row}.version)}}"
                    )
                };
                // The private native UI bridge supplies a separate lazy source
                // record. The first argument remains the original wire RowView
                // for history, File binding and generated-view mount transport.
                // Direct generic factories retain their two-argument fallback.
                let native_row =
                    binding_ident("sr", &format!("{}:{}", node.span.file.0, node.span.start));
                props.push(format!(
                    "renderRow:{prefix}({row},{child_ctx},{native_row})=>{{{preserve_row}{row}={native_row}===undefined?{fields}:{native_row};return [{children}];}}"
                ));
                self.exit_scope();
            }
            None => {
                // A2b: `fab` and `chatBubble` take grouped suites,
                // never `children` (their F props have no children
                // slot; shapes validated at decode).
                if panel_tabs {
                    let items =
                        node.children
                            .iter()
                            .map(|item| {
                                let gate = item.gate.as_ref().map(|gate| {
                                    self.lower_business_expr(gate, "formatted UI gate")
                                });
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
                                // Captions and descendants retain source order;
                                // source-await siblings settle before later items.
                                let children = item
                                    .children
                                    .iter()
                                    .map(|child| {
                                        sequence_ui_child(
                                            self.lower_ui_occurrence(
                                                child,
                                                ctx,
                                                occurrences,
                                                prepared_form,
                                                view_scope,
                                            ),
                                            sequence_children,
                                        )
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
                            sequence_ui_child(
                                self.lower_ui_occurrence(
                                    main,
                                    ctx,
                                    occurrences,
                                    prepared_form,
                                    view_scope
                                ),
                                sequence_children
                            )
                        ));
                    }
                    let rest: Vec<String> = kids
                        .map(|c| {
                            sequence_ui_child(
                                self.lower_ui_occurrence(
                                    c,
                                    ctx,
                                    occurrences,
                                    prepared_form,
                                    view_scope,
                                ),
                                sequence_children,
                            )
                        })
                        .collect();
                    props.push(format!("actions:[{}]", rest.join(",")));
                } else if matches!(node.factory.as_str(), "chatBubble" | "modal" | "drawer" | "dropdown" | "indicator" | "swap" | "diff") {
                    // The actual factories consume named slot props, not
                    // children or a standalone slot factory. Keep authored
                    // slot order and evaluate each descendant exactly once.
                    let mut names: Vec<&str> = Vec::new();
                    for child in &node.children {
                        if child.gate.is_some() {
                            self.unsupported(
                                "UI slot gate",
                                "required/optional slot availability has no owning source profile",
                                child.span,
                            );
                            return self.throw_expr("unsupported UI slot gate");
                        }
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
                                group.push(sequence_ui_child(
                                    self.lower_ui_occurrence(
                                        grand,
                                        ctx,
                                        occurrences,
                                        prepared_form,
                                        view_scope,
                                    ),
                                    sequence_children,
                                ));
                            }
                        }
                        props.push(format!("{}:[{}]", object_key(name), group.join(",")));
                    }
                } else if !node.children.is_empty() || node.factory == "card" {
                    let children = node
                        .children
                        .iter()
                        .map(|c| {
                            sequence_ui_child(
                                self.lower_ui_occurrence(
                                    c,
                                    ctx,
                                    occurrences,
                                    prepared_form,
                                    view_scope,
                                ),
                                sequence_children,
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(",");
                    let slot = if node.factory == "tooltip" {
                        "content"
                    } else {
                        "children"
                    };
                    props.push(format!("{slot}:[{children}]"));
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
        let mut has_preferences = false;
        let ir = self.ir;
        for item in &ir.items {
            let module_name = self.ir.module(item.module).name.clone();
            if module_name != owner {
                continue;
            }
            let fields = match &item.kind {
                IrItemKind::Preferences { fields, .. } => {
                    has_preferences = true;
                    fields.clone()
                }
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
                } else if let IrItemKind::Field {
                    owner: field_owner,
                    ty: IrType::Known(ResolvedType::Nullable(inner)),
                    default: None,
                    server: None,
                    ..
                } = &field.kind
                    && *field_owner == item.id
                    && field.id == *field_id
                    && field.module == item.module
                    && field.canonical == format!("{}.{}", item.canonical, field.name)
                    && let ResolvedType::Enum { cases, owner: Some(enum_owner) } = inner.as_ref()
                    && self.ir.items.get(enum_owner.0 as usize).is_some_and(|declaration| {
                        let IrItemKind::Field { ty: IrType::Known(original), .. } = &declaration.kind else { return false; };
                        let original = if let ResolvedType::Nullable(inner) = original { inner.as_ref() } else { original };
                        declaration.id == *enum_owner
                            && matches!(original, ResolvedType::Enum { cases: original, owner: Some(original_owner) }
                                if original == cases && original_owner == enum_owner)
                    })
                {
                    defaults.push((field.name.clone(), TypedExpr::new(IrExpr::Null, ResolvedType::Nullable(inner.clone()), field.span)));
                }
            }
        }
        if defaults.is_empty() {
            if !has_preferences {
                return String::new();
            }
            // The app declares saved preferences but carries no literal or
            // nullable-enum null authoring defaults (CAN18-v1 agenda gap:
            // a reference-only `preferences { location:Location? }` page
            // reading `preferences.location` crashed at render on
            // `bindings.preferences["App"]`). Forward the dispatcher-saved
            // snapshot even with no authoring entries; unsaved reads fall
            // back to null at the existing `?? null` use sites.
            return format!(
                "preferences:{{{app}:{{...(c.preferences?.[{owner_key}]??{{}})}}}},",
                app = object_key(owner),
                owner_key = js_string(owner),
            );
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
            "preferences:{{{app}:{{{entries},...(c.preferences?.[{owner_key}]??{{}})}}}},",
            app = object_key(owner),
            entries = entries.join(","),
            owner_key = js_string(owner),
        )
    }

    /// Lower one page: descriptor const plus the named page function whose
    /// renderer reads the shared descriptor (`renderPage` never dispatches
    /// or re-runs admission).
    pub fn lower_page(&mut self, page: &IrPage, out: &mut JsWriter) {
        let descriptor = page_binding(page, "descriptor");
        let func = page_binding(page, "render");
        let has_direct_priorities = page
            .render
            .iter()
            .any(|node| matches!(node.factory.as_str(), "primaryActions" | "actionMenu"));
        let parts_func = page_binding(page, "render_parts");
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
        if let Some(style) = self
            .then_join
            .as_ref()
            .and_then(|join| join.style_at(&page.span))
        {
            members.push(format!(
                "style:{{unitId:{},useId:{}}}",
                js_string(style),
                js_string(&format!(
                    "can-style-f{}-s{}",
                    page.span.file.0, page.span.start
                ))
            ));
        }
        if !page.preference_fields.is_empty() {
            let fields = page
                .preference_fields
                .iter()
                .map(|field| {
                    let mut labels = String::new();
                    if let Some(caption) = &field.caption {
                        labels.push_str(&format!(",caption:{}", self.lower_message(caption)));
                    }
                    if !field.option_labels.is_empty() {
                        let values = field
                            .option_labels
                            .iter()
                            .map(|(case, caption)| {
                                format!("{}:{}", object_key(case), self.lower_message(caption))
                            })
                            .collect::<Vec<_>>()
                            .join(",");
                        labels.push_str(&format!(",optionLabels:{{{values}}}"));
                    }
                    format!(
                        "{{name:{},options:[{}],defaultValue:{}{}{}{}{}{labels}{editable}}}",
                        js_string(&field.name),
                        field
                            .options
                            .iter()
                            .map(|value| js_string(value))
                            .collect::<Vec<_>>()
                            .join(","),
                        field
                            .default_value
                            .as_ref()
                            .map(|value| js_string(value))
                            .unwrap_or_else(|| "null".to_string()),
                        if field.nullable { ",nullable:true" } else { "" },
                        // A reference preference leaf carries no case
                        // options: the saved identity stays opaque and is
                        // validated as an opaque string downstream.
                        if field.reference { ",reference:true" } else { "" },
                        // C3 civil-date leaf (DESIGN 1015-1025): no case
                        // options; the default/saved values are civil
                        // dates validated downstream.
                        if field.date { ",date:true" } else { "" },
                        field.scalar_type.as_ref().map(|ty| format!(",scalarType:{}", js_string(ty))).unwrap_or_default(),
                        editable = field.editable.as_ref().map(|kind| format!(",editable:{}", js_string(kind))).unwrap_or_default(),
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            members.push(format!("preferenceFields:[{fields}]"));
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
        self.enter_scope();
        let route_lookup = if let Some(route) = &page.record_route {
            self.stdlib.insert("records".into());
            self.bindings
                .last_mut()
                .expect("page scope")
                .insert("row".into(), "(await $can$route$row())".into());
            format!(
                "let $can$route$once;const $can$route$row=()=>($can$route$once??=(async()=>{{const id=routeBindings[{}];if(typeof id!==\"string\"||id.length===0)throw {{code:\"validation\",message:\"Invalid record route.\"}};const rows=await records(c,{},{{where:{{op:\"eq\",field:\"id\",value:id}},archived:\"exclude\",authority:\"viewer\"}});if(rows.length!==1)throw {{code:\"forbidden\",message:\"forbidden\"}};return rows[0];}})());",
                js_string(&route.token),
                js_string(&route.model)
            )
        } else {
            String::new()
        };
        let bindings = self.admit_preferences_js(&page.owner);
        let bindings = if page.record_route.is_some() {
            format!("row:await $can$route$row(),{bindings}")
        } else {
            bindings
        };
        let admit_body = if page.admit.is_empty() {
            format!("async(c,routeBindings={{}})=>{{{route_lookup}return {{{bindings}}};}}")
        } else {
            // Page admission crosses the HTTP BusinessError boundary;
            // scenario guards keep the State-owned check semantics.
            let checks = page
                .admit
                .iter()
                .map(|guard| {
                    let condition = if let IrGuard::Expr(expr) = guard
                        && let Some(source) = self.boolean_sources.get(&expr.span).cloned() {
                        self.stdlib.insert("nativeReadBoolean".into());
                        self.boolean_body = true;
                        // The private Boolean observer supplies its own leased row.
                        // It must never borrow the page's retained render binding.
                        self.enter_scope();
                        self.bindings.last_mut().expect("Boolean scope").insert("row".into(), "row".into());
                        let expression = self.lower_business_expr(expr,"Boolean page requirement");
                        self.exit_scope();
                        self.boolean_body = false;
                        let binding = page.record_route.as_ref().map(|route| route.token.as_str()).unwrap_or("");
                        format!("await nativeReadBoolean(c,$can$boolean$issue({},async(c,row)=>({expression})),routeBindings[{}])",
                            descriptor_json(&descriptor_json(&source)),js_string(binding))
                    } else if let IrGuard::Expr(expr)=guard && self.membership_predicates.contains_key(&expr.span) {
                        self.unsupported("Boolean page requirement","native Boolean observation backend required",expr.span);
                        self.throw_expr("unsupported Boolean observation backend")
                    } else { self.lower_guard_bool(guard) };
                    format!("if(!({condition}))throw {{code:\"forbidden\",message:\"forbidden\"}};")
                })
                .collect::<Vec<_>>()
                .join("");
            format!("async(c,routeBindings={{}})=>{{{route_lookup}{checks}return {{{bindings}}};}}")
        };
        self.exit_scope();
        members.push(format!("admit:{admit_body}"));
        members.push(format!("render:{func}"));
        if has_direct_priorities {
            members.push(format!("renderParts:{parts_func}"));
        }
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
        let sequence_children = page.render.iter().any(ui_immediate_uses_async);
        self.record_page_render = page.path.contains('{');
        self.enter_scope();
        if page.record_route.is_some() {
            self.bindings
                .last_mut()
                .expect("page render scope")
                .insert("row".into(), "bindings.row".into());
        }
        let children = page
            .render
            .iter()
            .map(|n| sequence_ui_child(self.lower_ui(n), sequence_children))
            .collect::<Vec<_>>()
            .join(",");
        self.exit_scope();
        self.record_page_render = false;
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
        let parts = format!("(await Promise.all([{children}])).filter(value=>value!=null)");
        // The HTTP page owner applies the shared shell once. This function
        // renders only admitted content for both full and partial requests.
        let render = if has_direct_priorities {
            format!(
                "export async function {parts_func}(c,bindings){{{preamble}return {parts};}}\nexport async function {func}(c,bindings){{return (await {parts_func}(c,bindings)).join('');}}"
            )
        } else {
            format!(
                "export async function {func}(c,bindings){{{preamble}return {parts}.join('');}}"
            )
        };
        out.push(page.span, Some(format!("page {}", page.path)), &render);
    }
}

/// Await the whole child, including promise-returning factories and gates,
/// when siblings contain a source await. The expression still runs once.
fn sequence_ui_child(value: String, sequence: bool) -> String {
    if sequence {
        format!("await ({value})")
    } else {
        value
    }
}

/// File destinations await the existing source-bound presenter before siblings.
fn ui_has_file_destination(node: &IrUi) -> bool {
    matches!(node.factory.as_str(), "button" | "link") && node.props.iter().any(|(key, value)| key == "target" &&
        (value.ty == ResolvedType::Scalar(Scalar::File) ||
         matches!(&value.ty, ResolvedType::Nullable(inner) if inner.as_ref() == &ResolvedType::Scalar(Scalar::File))))
}

/// Whether rendering this node evaluates an await in the current callback.
/// Form and collection descendants execute under their own deferred callbacks.
fn ui_immediate_uses_async(node: &IrUi) -> bool {
    ui_has_file_destination(node)
        || node.view.is_some()
        || matches!(
            node.factory.as_str(),
            "callbackValueList"
                | "callbackValueCard"
                | "inspectionValueList"
                | "textMessageValueList"
        )
        || node.factory == "form"
        || matches!(node.factory.as_str(), "actionMenu" | "primaryActions")
        || node.factory == "detailsDrawer"
        || node.factory == "gallery"
        || node.factory == "history"
        || node.props.iter().any(|(_, value)| expr_uses_async(value))
        || node.gate.as_ref().is_some_and(expr_uses_async)
        || (node.factory != "form"
            && node.row_scope.is_none()
            && node.children.iter().any(ui_immediate_uses_async))
}

/// Whether a UI subtree awaits (form preparation or state-read calls).
fn ui_uses_async(node: &IrUi) -> bool {
    ui_has_file_destination(node)
        || node.view.is_some()
        || matches!(
            node.factory.as_str(),
            "callbackValueList"
                | "callbackValueCard"
                | "inspectionValueList"
                | "textMessageValueList"
        )
        || node.factory == "form"
        || matches!(node.factory.as_str(), "actionMenu" | "primaryActions")
        || node.factory == "detailsDrawer"
        || node.factory == "gallery"
        || node.factory == "history"
        || node.props.iter().any(|(_, v)| expr_uses_async(v))
        || node.gate.as_ref().is_some_and(expr_uses_async)
        || node.children.iter().any(ui_uses_async)
}

fn ui_uses_message_values(node: &IrUi) -> bool {
    node.factory == "textMessageValueList" || node.children.iter().any(ui_uses_message_values)
}

fn ui_uses_details_drawer(node: &IrUi) -> bool {
    node.factory == "detailsDrawer" || node.children.iter().any(ui_uses_details_drawer)
}

fn ui_uses_original_row(node: &IrUi) -> bool {
    if node.view.is_some() {
        return true;
    }
    fn protected(expr: &TypedExpr) -> bool {
        let mut pending = vec![expr];
        while let Some(current) = pending.pop() {
            match &current.expr {
                IrExpr::DeliveryRead {
                    callback, record, ..
                } => {
                    if callback.is_some() {
                        return true;
                    }
                    pending.push(record);
                }
                IrExpr::Member { base, .. } => pending.push(base),
                IrExpr::Call { args, .. }
                | IrExpr::BoundCall { args, .. }
                | IrExpr::Format { args, .. } => pending.extend(args),
                IrExpr::Binary { left, right, .. } => {
                    pending.push(left);
                    pending.push(right);
                }
                IrExpr::Unary { operand, .. } => pending.push(operand),
                IrExpr::Array(values) => pending.extend(values),
                IrExpr::Object(values) => pending.extend(values.iter().map(|(_, value)| value)),
                IrExpr::Query(query) => {
                    if let crate::codegen::ir::IrQueryDomain::Value { base, .. } = &query.domain {
                        pending.push(base);
                    }
                    pending.extend(query.value_order.iter().map(|order| order.key.as_ref()));
                    pending.extend(query.parent.as_deref());
                    pending.extend(query.where_pred.as_deref());
                    pending.extend(query.limit.as_deref());
                    pending.extend(query.archived.as_deref());
                    pending.extend(query.select.as_deref());
                }
                IrExpr::Message(message) => pending.extend(message.params.iter().map(|p| &p.value)),
                IrExpr::MessageCall {
                    descriptor,
                    args,
                    params,
                } => {
                    pending.extend(descriptor.params.iter().map(|p| &p.value));
                    pending.extend(args);
                    pending.extend(params.iter().filter_map(|p| p.default.as_ref()));
                }
                IrExpr::HasRole { person, .. } => pending.extend(person.as_deref()),
                IrExpr::Lambda { body, .. } => pending.push(body),
                IrExpr::JudgmentSpecification { options, .. } => pending.extend(options.as_deref()),
                _ => {}
            }
        }
        false
    }
    matches!(
        node.factory.as_str(),
        "history" | "inspectionValueList" | "textMessageValueList" | "detailsDrawer"
    ) || node.props.iter().any(|(_, value)| protected(value))
        || node.gate.as_ref().is_some_and(protected)
        || node
            .view
            .as_ref()
            .is_some_and(|view| protected(&view.argument))
        || node.children.iter().any(ui_uses_original_row)
}

/// Whether a page body references the `preferences` record.
fn page_uses_preferences(page: &IrPage) -> bool {
    fn query_uses_preferences(query: &crate::codegen::ir::IrQuery) -> bool {
        let domain_uses = match &query.domain {
            crate::codegen::ir::IrQueryDomain::Model(_) => false,
            crate::codegen::ir::IrQueryDomain::Value { base, .. } => expr_uses(base),
        };
        domain_uses
            || query
                .value_order
                .as_ref()
                .is_some_and(|order| expr_uses(&order.key))
            || query.parent.as_ref().is_some_and(|p| expr_uses(p))
            || query.where_pred.as_ref().is_some_and(|p| expr_uses(p))
            || query.limit.as_ref().is_some_and(|p| expr_uses(p))
            || query.archived.as_ref().is_some_and(|p| expr_uses(p))
            || query.select.as_ref().is_some_and(|p| expr_uses(p))
    }

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
            IrExpr::Query(query) => query_uses_preferences(query),
            IrExpr::DeliveryRead { record, .. } => expr_uses(record),
            IrExpr::Message(message) => message.params.iter().any(|p| expr_uses(&p.value)),
            IrExpr::MessageCall { args, params, .. } => args
                .iter()
                .chain(params.iter().filter_map(|p| p.default.as_ref()))
                .any(expr_uses),
            IrExpr::Format { args, .. } => args.iter().any(expr_uses),
            IrExpr::HasRole { person, .. } => person.as_ref().is_some_and(|p| expr_uses(p)),
            IrExpr::Lambda { body, .. } => expr_uses(body),
            IrExpr::JudgmentSpecification { options, .. } => {
                options.as_deref().is_some_and(expr_uses)
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
            | IrExpr::PageTimePredicate(_)
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
        node.view
            .as_ref()
            .is_some_and(|view| expr_uses(&view.argument))
            || node.props.iter().any(|(_, v)| expr_uses(v))
            || node.children.iter().any(ui_uses)
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
        let ir = self.ir;
        for item in &ir.items {
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
                        ..
                    }
                )
                .then(|| "parameters".to_string()),
                source: self.declaration_source(item.span),
                span: item.span,
            });
            out.push(
                item.span,
                Some(item.canonical.clone()),
                &format!("export const {export}={};", js_string(&item.canonical)),
            );
        }
        if let Some(guards) = self.send_guards {
            let mut guards = guards.values().collect::<Vec<_>>();
            guards.sort_by(|a, b| a.rule.cmp(&b.rule));
            for guard in guards {
                let export = binding_ident("o", &guard.rule);
                self.callables.push(JsCallable {
                    id: guard.rule.clone(),
                    kind: JsCallableKind::Rule,
                    export: export.clone(),
                    member: vec!["sendWhen".into(), guard.rule.clone()],
                    input_style: None,
                    source: self.declaration_source(guard.predicate.span),
                    span: guard.predicate.span,
                });
                out.push(
                    guard.predicate.span,
                    Some(guard.rule.clone()),
                    &format!("export const {export}={};", js_string(&guard.rule)),
                );
            }
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
        members.push(format!(
            "runtimeBindingOwners:{}",
            descriptor_json(&super::runtime_bindings::owners(self.ir, &entry_name))
        ));
        if let Some(locale) = entry
            .map(|id| self.ir.module(id))
            .and_then(|module| module.app_default_locale.as_deref())
        {
            // The exported primitive is an immutable ESM binding. Runtime
            // compares it with the richer, mutable appDefinition metadata
            // before using the selected app's default for private handlers.
            out.push(
                entry_span,
                Some("__canlangAppDefaultLocale".to_string()),
                &format!(
                    "export const __canlangAppDefaultLocale={};",
                    js_string(locale)
                ),
            );
            members.push("appDefaultLocale:__canlangAppDefaultLocale".to_string());
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
                let owners = descriptor_json(&super::runtime_bindings::owners(self.ir, &m.name));
                format!(
                    "{}:{{uses:[{uses}]{locale},runtimeBindingOwners:{owners}}}",
                    js_string(&m.name)
                )
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
        if let Some(origins) = &self.model_rule_origins {
            members.push(format!("modelRuleOrigins:{}", descriptor_json(origins)));
        }
        members.push(self.emit_packages_member(entry));
        members.push(self.emit_bindings_member());
        members.push(format!(
            "runtimeBindings:{}",
            descriptor_json(&super::runtime_bindings::inventory(self.ir))
        ));
        if let Some(judgments) = self.emit_judgments_member() {
            members.push(judgments);
        }
        members.push(self.emit_records_member("contracts", &["Contract"]));
        if let Some(inventory) = &self.value_types {
            let enums = inventory
                .enums
                .iter()
                .map(|enumeration| {
                    format!(
                        "{}:{{cases:{}}}",
                        js_string(&enumeration.name),
                        descriptor_json(&enumeration.cases)
                    )
                })
                .collect::<Vec<_>>();
            members.push(format!("enums:{{{}}}", enums.join(",")));
            if !inventory.aliases.is_empty() {
                let aliases = inventory
                    .aliases
                    .iter()
                    .map(|alias| {
                        let leaf = JsNominalLeaf {
                            name: alias.name.clone(),
                            declared: alias.declared.clone(),
                            constraints: alias.constraints.clone(),
                        };
                        format!("{}:{}", js_string(&alias.name), leaf.schema_json())
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                members.push(format!("aliases:{{{aliases}}}"));
            }
        }
        members.push(self.emit_records_member("events", &["Event"]));
        members.push(self.emit_capabilities_member());
        members.push(self.emit_models_member());
        members.push(self.emit_preferences_member());
        members.push(self.emit_operations_member());
        if let Some(changes) = &self.committed_changes {
            members.push(format!("committedChanges:{}", descriptor_json(changes)));
        }
        if let Some(completions) = &self.standard_completions {
            members.push(format!(
                "standardCompletions:{}",
                descriptor_json(completions)
            ));
        }
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
                    let declaration = format!("{}.{}", import.provider, name);
                    let Some(kind) = super::runtime_bindings::bound_import_kind(
                        self.ir, &import.provider, &name,
                    ) else { continue; };
                    bindings.push(format!(
                        "{}:{{{kind}:{},from:{}}}",
                        js_string(&key),
                        js_string(&declaration),
                        js_string(&from)
                    ));
                }
            }
        }
        format!("bindings:{{{}}}", bindings.join(","))
    }

    /// One source-owned descriptor supplies derived judgment schemas and calls.
    fn emit_judgments_member(&mut self) -> Option<String> {
        let mut declarations = Vec::new();
        let ir = self.ir;
        for item in &ir.items {
            let IrItemKind::Judgment {
                source_language,
                version,
                questions,
                ..
            } = &item.kind
            else {
                continue;
            };
            let mut rendered = Vec::new();
            for question in questions {
                let kind = match question.kind {
                    crate::codegen::ir::IrJudgmentKind::Noul => "noul",
                    crate::codegen::ir::IrJudgmentKind::Choice => "choice",
                    crate::codegen::ir::IrJudgmentKind::Score => "score",
                };
                let mut fields = vec![
                    format!("name:{}", js_string(&question.name)),
                    format!("kind:{}", js_string(kind)),
                    format!(
                        "instructions:{}",
                        self.lower_message(&question.instructions)
                    ),
                ];
                if question.runtime {
                    fields.push("runtime:true".to_string());
                }
                if let Some(yes) = &question.yes {
                    fields.push(format!("yes:{}", self.lower_message(yes)));
                }
                if let Some(no) = &question.no {
                    fields.push(format!("no:{}", self.lower_message(no)));
                }
                for (key, options) in [("options", &question.options), ("levels", &question.levels)]
                {
                    if options.is_empty() {
                        continue;
                    }
                    let options = options
                        .iter()
                        .map(|option| {
                            format!(
                                "{{id:{},description:{}}}",
                                js_string(&option.id),
                                self.lower_message(&option.description),
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(",");
                    fields.push(format!("{key}:[{options}]"));
                }
                rendered.push(format!("{{{}}}", fields.join(",")));
            }
            declarations.push(format!(
                "{}:{{sourceLanguage:{},version:{version}n,questions:[{}]}}",
                js_string(&item.canonical),
                js_string(source_language),
                rendered.join(","),
            ));
        }
        (!declarations.is_empty()).then(|| format!("judgments:{{{}}}", declarations.join(",")))
    }

    /// Emit the `contracts`/`events` member: labels plus full field
    /// schemas.
    fn push_record_schema(
        &mut self,
        item: &IrItem,
        kinds: &[&str],
        records: &mut Vec<String>,
        published: &mut BTreeSet<String>,
    ) {
        let (fields, label) = match &item.kind {
            IrItemKind::Contract { fields, label } if kinds.contains(&"Contract") => {
                (fields.clone(), label.clone())
            }
            IrItemKind::Event { fields } if kinds.contains(&"Event") => (fields.clone(), None),
            _ => return,
        };
        let declared_inputs = if matches!(item.kind, IrItemKind::Event { .. }) {
            let Some(inputs) = self.declared_event_input_fields(item) else {
                self.unsupported(
                    "declared event input fields",
                    "original fields have no complete owning operation-input carrier",
                    item.span,
                );
                return;
            };
            Some(inputs)
        } else {
            None
        };
        let mut members = Vec::new();
        if item.exported {
            members.push("exported:true".to_string());
        }
        if let Some(label) = label {
            members.push(format!("label:{}", self.lower_message(&label)));
        }
        members.push(self.emit_fields_schema(&fields));
        if matches!(item.kind, IrItemKind::Event { .. }) {
            members.push(format!("inputs:{{{}}}", self.emit_event_inputs(&fields)));
            if let Some(inputs) = declared_inputs {
                members.push(format!("inputFields:{}", descriptor_json(&inputs)));
            }
            // Multi-source closures need per-event provenance: the module
            // source map cannot resolve one exact declaring file for them.
            if let Some(source) = self.declaration_source(item.span) {
                members.push(format!("source:{}", js_string(&source)));
            }
        }
        records.push(format!(
            "{}:{{{}}}",
            js_string(&item.canonical),
            members.join(",")
        ));
        published.insert(item.canonical.clone());
    }

    fn push_event_records(
        &mut self,
        records: &mut Vec<String>,
        published: &mut BTreeSet<String>,
    ) {
        let ir = self.ir;
        // A Queue declaration owns its complete typed event profile even
        // when this program has no local handler for the published value.
        for module in &ir.modules {
            for binding in &module.runtime_bindings {
                let super::runtime_bindings::RuntimeBindingDeclaration::Queue {
                    resolved_type, ..
                } = &binding.declaration else { continue };
                let Some(field) = self.queue_event_input(resolved_type) else {
                    self.unsupported("queue event payload", "declared queue type has no supported original event input carrier", module.span);
                    continue;
                };
                let Some(type_id) = field.value_type.as_deref() else { continue };
                records.push(format!("{}:{{inputs:{{value:{{type:{}}}}},inputFields:{}}}",
                    js_string(&binding.binding), js_string(type_id), descriptor_json(&vec![field])));
                published.insert(binding.binding.clone());
            }
        }
        // Owning lifecycle events are checked IR sources, not authored
        // event declarations. Publish their private payload schema once
        // per identity so the existing owning input gate can admit it.
        for item in &self.ir.items {
            let IrItemKind::Scenario {
                event_source: Some(source),
                ..
            } = &item.kind
            else {
                continue;
            };
            let (identity, input_count) = match source {
                IrEventSource::Queue { source, .. } => (source.as_str(), 1),
                IrEventSource::DeliveryProgressed(identity) => (identity.as_str(), 1),
                IrEventSource::StandardCompleted { source, .. } => (source.as_str(), 4),
                IrEventSource::DeliveryCompleted { source, .. } => (source.as_str(), 4),
                IrEventSource::InstrumentationError => ("instrumentation.error", 0),
                IrEventSource::MailboxReceived { source, .. } => (source.as_str(), 1),
                IrEventSource::PaymentsChanged { source, .. } => (source.as_str(), 1),
                IrEventSource::TeamsMemberRemoved => ("teams.member_removed", 3),
                _ => continue,
            };
            if published.contains(identity) {
                continue;
            }
            let Some(invocation) = self.private_event_invocation(item, source) else {
                continue;
            };
            let Some(inputs) = invocation
                .inputs
                .iter()
                .take(input_count)
                .map(|field| {
                    field.value_type.as_deref().map(|type_id| {
                        format!(
                            "{}:{{type:{}}}",
                            object_key(&field.name),
                            js_string(type_id)
                        )
                    })
                })
                .collect::<Option<Vec<_>>>()
            else {
                continue;
            };
            let terminal_fields = if matches!(source, IrEventSource::StandardCompleted { .. }) {
                format!(",inputFields:{}{}", descriptor_json(&invocation.inputs[..input_count]),
                    self.declaration_source(item.span).map(|path|format!(",source:{}",js_string(&path))).unwrap_or_default())
            } else { String::new() };
            records.push(format!(
                "{}:{{inputs:{{{}}}{terminal_fields}}}",
                js_string(identity), inputs.join(",")
            ));
            published.insert(identity.to_string());
        }
    }

    fn emit_records_member(&mut self, member: &str, kinds: &[&str]) -> String {
        let mut records = Vec::new();
        let mut published = BTreeSet::new();
        let ir = self.ir;
        for item in &ir.items {
            self.push_record_schema(item, kinds, &mut records, &mut published);
        }
        if kinds.contains(&"Event") {
            self.push_event_records(&mut records, &mut published);
        }
        if kinds.contains(&"Contract") {
            if let Some(inventory) = &self.value_types {
                for record in &inventory.contracts {
                    if !published.insert(record.name.clone()) {
                        continue;
                    }
                    let fields = record
                        .fields
                        .iter()
                        .map(|field| format!("{}:{}", object_key(&field.name), field.schema_json()))
                        .collect::<Vec<_>>()
                        .join(",");
                    records.push(format!(
                        "{}:{{fields:{{{fields}}}}}",
                        js_string(&record.name)
                    ));
                }
            }
            // Source-backed inventories and private completions publish the
            // same complete selected closure as their installed value schema.
            // Legacy raw imports retain their prior catalog-only descriptors.
            let mut schemas = Vec::new();
            let has_standard_inventory = self.value_types.as_ref().is_some_and(|inventory| {
                inventory
                    .contracts
                    .iter()
                    .any(|contract| nominal_schema(&contract.name).is_some())
            });
            if self.ir.standard_completion_sources.handlers.is_empty() && !has_standard_inventory {
                for module in &self.ir.modules {
                    for import in &module.imports {
                        if import.provider != "std" {
                            continue;
                        }
                        for (name, _, _) in &import.members {
                            if let Some(capability) = std_capability(name) {
                                for op in capability.operations {
                                    for (_, declared) in op.inputs {
                                        collect_std_nominal_contracts(
                                            declared,
                                            &mut published,
                                            &mut schemas,
                                        );
                                    }
                                    collect_std_nominal_contracts(
                                        op.result,
                                        &mut published,
                                        &mut schemas,
                                    );
                                }
                            }
                        }
                    }
                }
            }
            for schema in schemas {
                let fields = schema
                    .fields
                    .iter()
                    .map(|(name, declared)| {
                        // Contracts' CanDuration is bigint milliseconds; Values'
                        // owning canonical type domain calls that leaf duration.
                        let declared = if *declared == "CanDuration" {
                            "duration"
                        } else {
                            declared
                        };
                        format!("{}:{{type:{}}}", object_key(name), js_string(declared))
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                records.push(format!(
                    "{}:{{fields:{{{fields}}}}}",
                    js_string(schema.name)
                ));
            }
        }
        format!("{member}:{{{}}}", records.join(","))
    }

    /// Closed event payload descriptors for the owning Values input facade.
    /// Presentation/record metadata stays in `fields`; no runtime schema
    /// reconstruction from its legacy flags is needed.
    fn emit_event_inputs(&mut self, fields: &[SymbolId]) -> String {
        let mut inputs = Vec::new();
        for id in fields {
            let field = self.ir.items[id.0 as usize].clone();
            let IrItemKind::Field {
                ty,
                required_array,
                default,
                server,
                modifiers,
                ..
            } = &field.kind
            else {
                continue;
            };
            let type_id = match ty {
                // A stored field's enum is not an independent Values enum
                // declaration. Its exact cases are the event wire type; the
                // source field still retains its nominal owning declaration.
                IrType::Known(ResolvedType::Enum{owner:Some(owner),cases}) if matches!(self.ir.items[owner.0 as usize].kind,IrItemKind::Field{..}) => format!("enum({})",cases.join(",")),
                IrType::Known(ty) => self.canonical_type_id(ty, field.span),
                IrType::Unknown => "unknown".to_string(),
            };
            if *required_array {
                self.unsupported(
                    "event input array",
                    "required-array fields have no owning operation-input descriptor",
                    field.span,
                );
            }
            let mut members = vec![format!("type:{}", js_string(&type_id))];
            if modifiers.trim {
                members.push("trim:true".to_string());
            }
            let length_bound = match ty {
                IrType::Known(ty) => {
                    let mut base = ty;
                    while let ResolvedType::Nullable(inner) = base {
                        base = inner;
                    }
                    matches!(base, ResolvedType::Array { .. })
                        || matches!(base, ResolvedType::Scalar(s) if s.is_string_like())
                }
                IrType::Unknown => false,
            };
            for (name, bound) in [("min", &modifiers.min), ("max", &modifiers.max)] {
                if let Some(bound) = bound {
                    if length_bound {
                        if let IrExpr::Int(value) = bound.expr
                            && (0..=9_007_199_254_740_991).contains(&value)
                        {
                            // Values length bounds are descriptor numbers;
                            // value bounds and defaults are encoded wire values.
                            members.push(format!("{name}:{value}"));
                        } else {
                            self.unsupported(
                                "event input length bound",
                                "expression has no exact owning descriptor number",
                                bound.span,
                            );
                        }
                    } else if let Some(value) = wire_literal(bound) {
                        members.push(format!("{name}:{}", descriptor_json(&value)));
                    } else {
                        self.unsupported(
                            "event input bound",
                            "expression has no owning wire representation",
                            bound.span,
                        );
                    }
                }
            }
            if let Some(default) = default {
                if let IrDefault::Literal(expr) = default
                    && let Some(value) = wire_literal(expr)
                {
                    members.push(format!("default:{}", descriptor_json(&value)));
                } else {
                    self.unsupported(
                        "event input default",
                        "expression has no owning wire representation",
                        field.span,
                    );
                }
            }
            if server.is_some() {
                self.unsupported(
                    "event input initializer",
                    "server initializers have no event payload admission contract",
                    field.span,
                );
            }
            inputs.push(format!(
                "{}:{{{}}}",
                object_key(&field.name),
                members.join(",")
            ));
        }
        inputs.join(",")
    }

    /// Emit owning capability versions, operation schemas and events.
    fn emit_capabilities_member(&mut self) -> String {
        let mut capabilities = Vec::new();
        let mut published = BTreeSet::new();
        let ir = self.ir;
        for item in &ir.items {
            let (ops, events, version) = match &item.kind {
                IrItemKind::Capability {
                    ops,
                    events,
                    version,
                } => (ops.clone(), events.clone(), *version),
                _ => continue,
            };
            let mut members = Vec::new();
            if item.exported {
                members.push("exported:true".to_string());
            }
            if let Some(version) = version {
                members.push(format!("version:{version}n"));
            }
            if !ops.is_empty() {
                let mut entries = Vec::new();
                for op_id in &ops {
                    let Some(op) = self.ir.items.get(op_id.0 as usize).cloned() else {
                        continue;
                    };
                    let IrItemKind::CapabilityOp { params, result } = &op.kind else {
                        continue;
                    };
                    let inputs = self.emit_params_schema_profile(params, true, false);
                    let result = match result {
                        IrType::Known(ty) => self.canonical_field_schema(ty, op.span),
                        IrType::Unknown => "{type:\"unknown\"}".to_string(),
                    };
                    let labels = params
                        .iter()
                        .filter_map(|id| {
                            let param = self.ir.items.get(id.0 as usize)?.clone();
                            let IrItemKind::Param {
                                label: Some(label), ..
                            } = &param.kind
                            else {
                                return None;
                            };
                            Some(format!(
                                "{}:{}",
                                object_key(&param.name),
                                self.lower_message(label)
                            ))
                        })
                        .collect::<Vec<_>>();
                    let labels = if labels.is_empty() {
                        String::new()
                    } else {
                        format!(",labels:{{{}}}", labels.join(","))
                    };
                    entries.push(format!(
                        "{}:{{inputs:{{{inputs}}},result:{result}{labels}}}",
                        object_key(&op.name)
                    ));
                }
                members.push(format!("operations:{{{}}}", entries.join(",")));
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
            published.insert(item.canonical.clone());
        }
        // Standard imports are checked external declarations, without IR
        // item rows. Publish their owning catalog schemas through the same
        // field adapter; named references stay nominal and unexpanded.
        for module in &self.ir.modules.clone() {
            for import in &module.imports {
                if import.provider != "std" {
                    continue;
                }
                for (name, _, span) in &import.members {
                    let Some(capability) = std_capability(name) else {
                        continue;
                    };
                    if !published.insert(capability.name.to_string()) {
                        continue;
                    }
                    let operations = capability
                        .operations
                        .iter()
                        .map(|op| {
                            let inputs = op
                                .inputs
                                .iter()
                                .map(|(name, ty)| {
                                    format!(
                                        "{}:{}",
                                        object_key(name),
                                        self.std_capability_field_schema(ty, *span)
                                    )
                                })
                                .collect::<Vec<_>>()
                                .join(",");
                            let result = self.std_capability_field_schema(op.result, *span);
                            let terminal = self.standard_completions.as_ref().is_some_and(|sources|
                                sources.iter().any(|source|source.source == format!("{}.{}",capability.name,op.name)));
                            let terminal_fields = if terminal {
                                match (op.inputs.iter().map(|(name,ty)|self.standard_completion_input(name,ty)).collect::<Option<Vec<_>>>(),
                                    delivery_descriptor(capability.name,op)) {
                                    (Some(fields),Some(delivery)) => format!(",inputFields:{},delivery:{}",descriptor_json(&fields),delivery.to_json()),
                                    _ => String::new(),
                                }
                            } else { String::new() };
                            format!(
                                "{}:{{inputs:{{{inputs}}},result:{result}{terminal_fields}}}",
                                object_key(op.name)
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(",");
                    let mut members = vec![
                        format!("version:{}n", capability.version),
                        format!("operations:{{{operations}}}"),
                    ];
                    if !capability.events.is_empty() {
                        let events = capability
                            .events
                            .iter()
                            .map(|event| {
                                let fields = event
                                    .fields
                                    .iter()
                                    .map(|(name, ty)| {
                                        format!(
                                            "{}:{}",
                                            object_key(name),
                                            self.std_field_schema(ty, *span)
                                        )
                                    })
                                    .collect::<Vec<_>>()
                                    .join(",");
                                format!("{}:{{{fields}}}", object_key(event.name))
                            })
                            .collect::<Vec<_>>()
                            .join(",");
                        members.push(format!("events:{{{events}}}"));
                    }
                    capabilities.push(format!(
                        "{}:{{{}}}",
                        js_string(capability.name),
                        members.join(",")
                    ));
                }
            }
        }
        format!("capabilities:{{{}}}", capabilities.join(","))
    }

    fn std_field_schema(&mut self, declared: &str, span: Span) -> String {
        match std_schema_type(declared) {
            Some(ty) => self.field_schema(&ty, span),
            None => format!("{{type:{}}}", js_string(declared)),
        }
    }

    /// Capability input descriptors enter the owning Values schema facade.
    /// Shape is carried by its canonical type ID, not legacy metadata flags.
    fn canonical_field_schema(&mut self, ty: &ResolvedType, span: Span) -> String {
        format!("{{type:{}}}", js_string(&self.canonical_type_id(ty, span)))
    }

    fn std_capability_field_schema(&mut self, declared: &str, span: Span) -> String {
        match std_schema_type(declared) {
            Some(ty) => self.canonical_field_schema(&ty, span),
            None => format!("{{type:{}}}", js_string(declared)),
        }
    }

    /// Emit the `models` member: ownership, labels, rule references,
    /// retention and full field schemas.
    fn emit_models_member(&mut self) -> String {
        let mut models = Vec::new();
        let ir = self.ir;
        for item in &ir.items {
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
                    {
                        if let Some(role) = actor_read_role(&rule.pred) {
                            grant_members.push(format!("by:[{}]", js_string(role)));
                        } else if let Some((role, field)) =
                            row_read_role(&rule.pred, item, &fields, ir)
                        {
                            grant_members.push(format!(
                                "by:[{{roleSubject:{{role:{},person:{{model:{},field:{}}}}}}}]",
                                js_string(role),
                                js_string(&item.canonical),
                                js_string(field),
                            ));
                        }
                    }
                    format!("{{{}}}", grant_members.join(","))
                })
                .collect();
            members.push(format!("readGrants:[{}]", entries.join(",")));
            if let Some(checked) = ir.callback_grants.iter_checked(ir) {
                let callback_entries = checked
                    .filter(|grant| grant.model() == item.id)
                    .map(|grant| {
                        format!(
                            "{{rule:{},field:{},fields:[]}}",
                            js_string(grant.rule()),
                            js_string(grant.field())
                        )
                    })
                    .collect::<Vec<_>>();
                if !callback_entries.is_empty() {
                    members.push(format!(
                        "callbackReadGrants:[{}]",
                        callback_entries.join(",")
                    ));
                }
            } else {
                self.unsupported(
                    "callback grants",
                    "original checked protected policy and owning generation field are required",
                    item.span,
                );
            }
            if retain.is_some() {
                members.push(format!(
                    "retainUntil:{}",
                    js_string(crate::codegen::ir::ir_model_rule_prefix(ir, item))
                ));
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
                            Some(_) => {
                                let registry = format!("{}.unique.{}", crate::codegen::ir::ir_model_rule_prefix(ir, item), index + 1);
                                let association = self.unique_conditions.iter().find(|fact| {
                                    fact.model == item.id && fact.module == item.module
                                        && fact.canonical_model == item.canonical
                                        && fact.registry_id == registry && fact.fields == unique.fields
                                        && fact.node.file == unique.span.file
                                        && fact.node.start == unique.span.start && fact.node.end == unique.span.end
                                });
                                let metadata = association.map_or_else(String::new, |fact| {
                                    let source = serde_json::json!({"path":fact.source.path,"sha256":fact.source.sha256,"module":fact.source.module});
                                    let declared_at = serde_json::json!({"start":fact.node.start,"end":fact.node.end,
                                        "fields":{"start":fact.fields_node.start,"end":fact.fields_node.end},
                                        "where":{"start":fact.where_node.start,"end":fact.where_node.end}});
                                    format!(",wherePredicate:{},ordinal:{},source:{},declaredAt:{}", descriptor_json(&fact.predicate), fact.ordinal, descriptor_json(&source), descriptor_json(&declared_at))
                                });
                                format!("{{fields:[{fields}],where:{}{metadata}}}", js_string(&registry))
                            },
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
        let ir = self.ir;
        for item in &ir.items {
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
            let ir = self.ir;
            for item in &ir.items {
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
            IrItemKind::DeriveField { ty, label, .. } => {
                (Some(ty.clone()), false, None, None, None, label.clone())
            }
            _ => (None, false, None, None, None, None),
        };
        let inventory_leaf = match &field.kind {
            IrItemKind::Field { owner, .. } => self.value_types.as_ref().and_then(|inventory| {
                let owner = self.ir.items.get(owner.0 as usize)?;
                inventory
                    .contracts
                    .iter()
                    .find(|record| record.name == owner.canonical)?
                    .fields
                    .iter()
                    .find(|leaf| leaf.name == field.name)
                    .cloned()
            }),
            _ => None,
        };
        let checked_constraints = self.ir.value_constraints.get(&field.id).cloned();
        let mut members = if let Some(leaf) = inventory_leaf {
            let json = leaf.schema_json();
            json[1..json.len() - 1].to_string()
        } else if let (Some(constraints), Some(IrType::Known(resolved))) =
            (&checked_constraints, &ty)
        {
            let mut declared = self.symbol_value_type_id(field.id, resolved, field.span);
            if required_array {
                declared.push('!');
            }
            let leaf = JsNominalLeaf {
                name: field.name.clone(),
                declared,
                constraints: JsValueConstraints::from(constraints),
            };
            let json = leaf.schema_json();
            json[1..json.len() - 1].to_string()
        } else {
            match ty {
                Some(IrType::Known(resolved)) => {
                    self.field_schema_object(&resolved, required_array, field.span)
                }
                _ => "type:\"unknown\"".to_string(),
            }
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
            if let Some(min) = &modifiers.min
                && checked_constraints.is_none()
            {
                members.push_str(&format!(
                    ",min:{}",
                    self.lower_business_expr(min, "formatted field bound")
                ));
            }
            if let Some(max) = &modifiers.max
                && checked_constraints.is_none()
            {
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

    fn operation_root_authority(
        &self,
        item: &IrItem,
    ) -> Option<crate::analysis::effects::RootAuthority> {
        match &item.kind {
            IrItemKind::Scenario { root_authority, .. } => root_authority.clone(),
            IrItemKind::CrudOp { model, op, .. } => {
                let original_model = *model;
                let mut model = *model;
                let mut seen = HashSet::new();
                while seen.insert(model) {
                    match self.ir.items.get(model.0 as usize)?.kind {
                        IrItemKind::Model {
                            owner: IrOwner::ChildOf(parent),
                            ..
                        } => model = parent,
                        _ => break,
                    }
                }
                let creates_root = *op == CrudOp::Create && original_model == model;
                let model = &self.ir.items.get(model.0 as usize)?.canonical;
                self.ir
                    .modules
                    .iter()
                    .flat_map(|module| &module.runtime_bindings)
                    .find_map(|binding| match &binding.declaration {
                        super::runtime_bindings::RuntimeBindingDeclaration::DurableObject {
                            key,
                        } if key == model => Some(crate::analysis::effects::RootAuthority {
                            binding: binding.binding.clone(),
                            model: model.clone(),
                            creates_root,
                        }),
                        _ => None,
                    })
            }
            _ => None,
        }
    }

    /// Emit the `operations` member: scenario metadata (handler, `by`,
    /// `read`, inputs, result, captions) and generated CRUD entries
    /// (handler, kind, model, field allowlists, `when`, captions).
    fn emit_operation_authority(
        &mut self,
        item: &IrItem,
        members: &mut Vec<String>,
        scope_authority: bool,
    ) {
        // Family E: the §13 authority-scope marker publishes
        // the checked grant boundary. The `E6008` stays until
        // the host-seam decision-mode runtime boundary lands;
        // the handler below lowers the decision-mode body and
        // MCP advertises the grant.
        if scope_authority {
            members.push("scope:\"authority\"".to_string());
            // REVIEW-9 gap 2: the defining-source origin is a
            // checked fact, never re-derived — the scenario's
            // owning module must agree with its declaring
            // file, and that file must resolve through the
            // checked committed-source inventory. The host
            // verifies this origin against `artifact.sources`
            // before serving; omission keeps the seam refusal
            // fail-closed.
            if let Some(origin) = Self::defining_source_origin(self.ir, item) {
                members.push(format!("source:{}", descriptor_json(&origin)));
            }
            if item.canonical == "rent_reservations.resource_report" {
                if let Some(prepared) = self.authority_queries {
                    members.push(format!("authorityQuerySites:{}", descriptor_json(&prepared.plan)));
                }
            }
        }
        if let Some(authority) = self.operation_root_authority(item) {
            members.push(format!("rootAuthority:{}", descriptor_json(&authority)));
        }
        if let Some(counts)=self.constructor_counts.get(&item.id) {
            members.push(format!("constructorCounts:{}",descriptor_json(counts)));
        }
        if let Some(inputs) = self.constructor_inputs.get(&item.id) {
            members.push(format!("constructorInputs:{}", descriptor_json(inputs)));
        }
        if let Some(dependencies) = self.execution_dependencies.get(&item.canonical) {
            members.push(format!(
                "executionDependencies:{}",
                descriptor_json(dependencies)
            ));
        }
    }

    fn emit_operation_query_first(&mut self, item: &IrItem, members: &mut Vec<String>) {
        if let Some(capture) = self.native_query_sources.get(&item.id) {
            let first: Vec<_> = capture.queries.iter().filter_map(|query| {
                let first = query.first.as_ref()?;
                let source = capture.plan["queries"].as_array()?.iter().find(|value| value["id"].as_str() == Some(query.id.as_str()))?.get("source")?;
                // DESIGN442: carry the checked guard-consumed mark
                // for confined decision slices (hook event plus
                // ordinary require-conjunction skeletons);
                // omission keeps ordinary viewer behavior on
                // every other shape.
                let mut entry = serde_json::json!({"queryId":query.id,"source":source,"query":{"start":query.node.start,"end":query.node.end},"node":{"start":first.call.start,"end":first.call.end},"statement":{"start":first.binding.start,"end":first.binding.end}});
                if first.guard_consumed {
                    entry["guardConsumed"] = serde_json::json!(true);
                }
                if first.presence_consumed {
                    entry["presenceConsumed"] = serde_json::json!(true);
                }
                if first.target_consumed {
                    entry["targetConsumed"] = serde_json::json!(true);
                }
                Some(entry)
            }).collect();
            if !first.is_empty() {
                members.push(format!("queryFirst:{}", descriptor_json(&first)));
            }
        }
        if let Some(metadata) = self
            .query_any
            .and_then(|metadata| metadata.get(&item.canonical))
        {
            members.push(format!("queryAny:{}", descriptor_json(metadata)));
        }
        if let Some(selections) = self
            .query_selections
            .and_then(|selections| selections.get(&item.canonical))
        {
            members.push(format!("querySelections:{}", descriptor_json(selections)));
        }
    }

    fn emit_operation_query_guards(&mut self, item: &IrItem, members: &mut Vec<String>) {
        if let Some(guards) = self
            .send_guard_owners
            .and_then(|owners| owners.get(&item.canonical))
        {
            let mut descriptors = guards.clone();
            let mut complete = true;
            for descriptor in descriptors.as_array_mut().into_iter().flatten() {
                let guard = self.send_guards.and_then(|guards| {
                    guards.values().find(|guard| {
                        Some(guard.rule.as_str()) == descriptor["rule"].as_str()
                    })
                });
                let declaration =
                    guard.and_then(|guard| self.send_input_declaration(guard));
                if let Some(declaration) = declaration {
                    descriptor["inputDeclaration"] = declaration;
                } else {
                    complete = false;
                    break;
                }
            }
            if complete {
                members.push(format!("sendGuards:{}", descriptor_json(&descriptors)));
            } else {
                self.unsupported("send dispatch inputs", "original lexical inputs have no complete owning declaration profile", item.span);
            }
        }
    }

    fn emit_operation_call_sites(&mut self, item: &IrItem, members: &mut Vec<String>) {
        if let Some(sites) = self.native_call_sites.get(&item.id) {
            // Dev resolves names to its actual loaded canonical
            // descriptors; this source carrier duplicates no schema.
            let sites: Vec<_> = sites
                .iter()
                .map(|site| {
                    let mut descriptor = serde_json::json!({
                        "id": site.id,
                        "source": {
                            "path": site.source.path,
                            "sha256": site.source.sha256,
                            "module": site.source.module,
                        },
                        "kind": "operation",
                        "targets": [site.target],
                        "resultType": site.interface.result,
                    });
                    if !site.file_inputs.is_empty() {
                        descriptor["fileInputs"] = serde_json::json!(site.file_inputs);
                    }
                    descriptor
                })
                .collect();
            members.push(format!("callSites:{}", descriptor_json(&sites)));
        }
    }

    fn operation_event_identity(&self, item: &IrItem, event: &IrEventSource) -> Option<String> {
        match event {
            IrEventSource::Declared(identity)
            | IrEventSource::DeliveryProgressed(identity) => Some(identity.clone()),
            IrEventSource::Queue { source, .. } => Some(source.clone()),
            IrEventSource::StandardCompleted { source, .. }
            | IrEventSource::DeliveryCompleted { source, .. }
            | IrEventSource::MailboxReceived { source, .. }
            | IrEventSource::PaymentsChanged { source, .. } => Some(source.clone()),
            IrEventSource::InstrumentationError => {
                Some("instrumentation.error".into())
            }
            IrEventSource::TeamsMemberRemoved => {
                Some("teams.member_removed".into())
            }
            IrEventSource::Committed { model, change } => self
                .ir
                .items
                .get(model.0 as usize)
                .filter(|item| matches!(item.kind, IrItemKind::Model { .. }))
                .map(|model| format!("{}.{}", model.canonical, change.suffix())),
            // Ticks route on their period, not an event
            // identity (DESIGN §6).
            IrEventSource::Every { .. } => None,
        }
    }

    fn emit_operation_event(
        &mut self,
        item: &IrItem,
        members: &mut Vec<String>,
        event_source: &Option<IrEventSource>,
    ) {
        if let Some(event) = event_source {
            let identity = self.operation_event_identity(item, event);
            if let IrEventSource::Every { interval_ms } = event {
                members.push(format!("on:{{every:{interval_ms}n}}"));
            } else if let Some(identity) = identity {
                members.push(format!("event:{}", js_string(&identity)));
            }
            if let Some(invocation) = self.private_event_invocation(item, event) {
                members.push(format!("invocation:{}", invocation.to_json()));
            } else if matches!(event, IrEventSource::Queue { .. }) {
                self.unsupported("queue handler payload", "declared queue type has no supported private invocation input carrier", item.span);
            }
        }
    }

    fn emit_crud_operation(&mut self, item: &IrItem, operations: &mut Vec<String>) {
        let IrItemKind::CrudOp {
            model,
            op,
            by,
            has_when,
            fields,
            label,
            expose_excluded,
            ..
        } = &item.kind
        else {
            return;
        };
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
        if let Some(authority) = self.operation_root_authority(item) {
            members.push(format!("rootAuthority:{}", descriptor_json(&authority)));
        }
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

    fn emit_operations_member(&mut self) -> String {
        let mut operations = Vec::new();
        let ir = self.ir;
        for item in &ir.items {
            match &item.kind {
                // Hooks are reactive, not operations: no servable entry here.
                // They still contribute their private invocation, which the
                // runtime file inventory and opaque file staging demand for
                // every handler callable.
                IrItemKind::Scenario { hook: Some(_), .. } => {
                    if let Some(invocation) = self.private_hook_invocation(item) {
                        operations.push(format!(
                            "{}:{{invocation:{}}}",
                            js_string(&item.canonical),
                            invocation.to_json()
                        ));
                    }
                }
                IrItemKind::Scenario {
                    params,
                    event_source,
                    result,
                    read,
                    scope_authority,
                    trusted,
                    by,
                    label,
                    description,
                    ..
                } => {
                    let inputs = self.emit_params_schema(params, !*trusted);
                    let mut members = vec![
                        format!("handler:{}", js_string(&item.canonical)),
                        format!("inputs:{{{inputs}}}"),
                    ];
                    self.emit_operation_authority(item, &mut members, *scope_authority);
                    self.emit_operation_query_first(item, &mut members);
                    self.emit_operation_query_guards(item, &mut members);
                    self.emit_operation_call_sites(item, &mut members);
                    self.emit_operation_event(item, &mut members, event_source);
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
                IrItemKind::CrudOp { .. } => {
                    self.emit_crud_operation(item, &mut operations);
                }
                _ => {}
            }
        }
        if self.has_receipt_delivery_fields() && self.receipt_read_collision().is_none() {
            operations.push("\"Receipt.read\":{kind:\"read\",read:true,by:\"public\"}".to_string());
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
                    let entry = operation_policy_tree_entry(by, guards.len(), false);
                    if let Some(entry) = entry {
                        operations.push(format!("{}:{entry}", js_string(&item.canonical)));
                    }
                }
                IrItemKind::CrudOp { by, has_when, .. } => {
                    let entry = operation_policy_tree_entry(by, 0, *has_when);
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
    /// lone gate, the ordered State `ByPredicate` tree for a pure role-only
    /// Boolean gate, or a loud `E6008` for subject/expression gates (the
    /// executable handler still enforces the full gate either way).
    fn by_member(&mut self, by: &[IrGuard], span: Span) -> Option<String> {
        if by.is_empty() {
            return None;
        }
        if let [IrGuard::Role(id)] = by {
            return Some(js_string(id));
        }
        let mut terms = Vec::with_capacity(by.len());
        for guard in by {
            match by_predicate_tree(guard) {
                Some(tree) => terms.push(tree),
                None => {
                    self.unsupported(
                        "by admission",
                        if by.len() == 1 {
                            "expression gates have no operations-member lowering"
                        } else {
                            "compound gates have no operations-member lowering"
                        },
                        span,
                    );
                    return None;
                }
            }
        }
        if terms.len() == 1 {
            // The native receiver AND-joins top-level terms, so one term is
            // the tree itself.
            Some(terms.pop().unwrap_or_default())
        } else {
            Some(format!("{{\"and\":[{terms}]}}", terms = terms.join(",")))
        }
    }

    /// Shared omission gate: scalar profiles plus one checked stored-model
    /// copy from an earlier required parameter of this mutation.
    fn scenario_computed_default_supported(&self, param_id: SymbolId) -> bool {
        let Some(param) = self.ir.items.get(param_id.0 as usize) else {
            return false;
        };
        let IrItemKind::Param {
            owner,
            index,
            ty,
            default: Some(IrDefault::Computed { expr, .. }),
            default_copy_source,
            ..
        } = &param.kind
        else {
            return false;
        };
        if scenario_default_omission_supported(ty) {
            return true;
        }
        let IrType::Known(ResolvedType::Record {
            symbol: model,
            stored: true,
        }) = ty
        else {
            return false;
        };
        if !matches!(
            self.ir.items.get(owner.0 as usize).map(|item| &item.kind),
            Some(IrItemKind::Scenario {
                trusted: false,
                read: false,
                hook: None,
                ..
            })
        ) || !matches!(
            self.ir.items.get(model.0 as usize).map(|item| &item.kind),
            Some(IrItemKind::Model { .. })
        ) {
            return false;
        }
        let Some(seed) = default_copy_source.and_then(|id| self.ir.items.get(id.0 as usize)) else {
            return false;
        };
        matches!(
            &seed.kind,
            IrItemKind::Param {
                owner: seed_owner,
                index: seed_index,
                ty: IrType::Known(ResolvedType::Record { symbol: seed_model, stored: true }),
                default: None,
                ..
            } if seed_owner == owner && seed_index < index && seed_model == model
        ) && matches!(&expr.expr, IrExpr::Name(name) if name == &seed.name)
            && matches!(&expr.ty, ResolvedType::Record { symbol, stored: true } if symbol == model)
    }

    /// Emit `name:{schema}` entries for scenario/capability parameters,
    /// with labels and literal defaults.
    fn emit_params_schema(&mut self, params: &[SymbolId], computed_defaults: bool) -> String {
        self.emit_params_schema_profile(params, false, computed_defaults)
    }

    fn emit_params_schema_profile(
        &mut self,
        params: &[SymbolId],
        wire: bool,
        computed_defaults: bool,
    ) -> String {
        let mut parts = Vec::new();
        for param_id in params {
            // Never direct-index: a dangling row (unreachable from the
            // 1:1 IR build) drops the entry instead of panicking.
            let Some(param) = self.ir.items.get(param_id.0 as usize).cloned() else {
                continue;
            };
            if let IrItemKind::Param {
                array_bounds,
                ty,
                default,
                label,
                choices,
                ..
            } = &param.kind
            {
                // Unknown types already carry an `E6006` from the IR
                // build; the placeholder stays silent here. Parameters
                // never carry the field-only `!` (GRAMMAR L183), so
                // their arrays are ordinary (T09).
                let mut members = match ty {
                    IrType::Known(resolved) if wire => {
                        format!(
                            "type:{}",
                            js_string(&self.canonical_type_id(resolved, param.span))
                        )
                    }
                    IrType::Known(resolved) => {
                        self.field_schema_object(resolved, false, param.span)
                    }
                    IrType::Unknown => "type:\"unknown\"".to_string(),
                };
                if let Some(bounds) = array_bounds {
                    if let Some(min) = bounds.min {
                        members.push_str(&format!(",min:{min}"));
                    }
                    if let Some(max) = bounds.max {
                        members.push_str(&format!(",max:{max}"));
                    }
                }
                if let Some(default) = default {
                    self.push_param_default_member(*param_id, param.span, default, wire, computed_defaults, &mut members);
                }
                if !wire && let Some(label) = label {
                    members.push_str(&format!(",label:{}", self.lower_message(label)));
                }
                if !wire && let Some(choices) = choices {
                    members.push_str(&format!(
                        ",choices:{}",
                        descriptor_json(&JsInputChoiceBinding::from(choices))
                    ));
                }
                parts.push(format!("{}:{{{members}}}", object_key(&param.name)));
            }
        }
        parts.join(",")
    }

    fn push_param_default_member(
        &mut self,
        param_id: SymbolId,
        span: Span,
        default: &IrDefault,
        wire: bool,
        computed_defaults: bool,
        members: &mut String,
    ) {
        match default {
            IrDefault::Literal(value) if wire => {
                if let Some(value) = wire_literal(value) {
                    members.push_str(&format!(",default:{}", descriptor_json(&value)));
                } else {
                    self.unsupported(
                        "capability parameter default",
                        "literal has no owning wire representation",
                        span,
                    );
                }
            }
            IrDefault::Literal(_) => {
                members.push_str(&format!(",default:{}", self.lower_default(default)));
            }
            IrDefault::Computed { .. }
                if computed_defaults && self.scenario_computed_default_supported(param_id) =>
            {
                members.push_str(",computedDefault:true");
            }
            IrDefault::Computed { .. } => {
                self.unsupported(
                    "parameter default",
                    "computed parameter defaults have no §13 lowering",
                    span,
                );
            }
        }
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

    /// Publish a complete census only when every checked declaration still
    /// joins its canonical source, private inputs and cohort in this IR.
    fn collect_committed_changes(
        &mut self,
        db: Option<&crate::source::SourceDb>,
    ) -> Option<Vec<JsCommittedChange>> {
        let facts = &self.ir.committed_sources;
        let current: Vec<_> = self
            .ir
            .items
            .iter()
            .filter(|item| {
                matches!(
                    item.kind,
                    IrItemKind::Scenario {
                        event_source: Some(IrEventSource::Committed { .. }),
                        ..
                    }
                )
            })
            .collect();
        if facts.handlers.is_empty() && current.is_empty() {
            return None;
        }
        let valid = db.is_some_and(|db| {
            facts.sources.iter().all(|(id, path, hash)| {
                db.get(*id)
                    .is_some_and(|source| source.path == *path && source.sha256 == *hash)
            })
        }) && !facts.sources.is_empty()
            && current.len() == facts.handlers.len()
            && current.iter().zip(&facts.handlers).all(|(item, fact)| {
                let IrItemKind::Scenario {
                    event_source: Some(source @ IrEventSource::Committed { model, .. }),
                    trusted: true,
                    params,
                    hook: None,
                    cohort,
                    ..
                } = &item.kind
                else {
                    return false;
                };
                item.id == fact.id
                    && item.module == fact.module
                    && item.canonical == fact.canonical
                    && item.span == fact.span
                    && params.is_empty()
                    && source == &fact.source
                    && cohort == &fact.cohort
                    && cohort.as_ref().map(|cohort| {
                        self.ir
                            .items
                            .get(cohort.model.0 as usize)
                            .filter(|item| matches!(item.kind, IrItemKind::Model { .. }))
                            .map(|item| item.canonical.as_str())
                    }) == fact.cohort_model.as_deref().map(Some)
                    && self.ir.items.get(model.0 as usize).is_some_and(|model| {
                        model.canonical == fact.model
                            && matches!(model.kind, IrItemKind::Model { .. })
                    })
                    && self.private_event_invocation(item, source).is_some()
            });
        if !valid {
            let span = facts
                .handlers
                .first()
                .map(|fact| fact.span)
                .or_else(|| current.first().map(|item| item.span))
                .unwrap_or(Span::new(crate::source::SourceId(0), 0, 0));
            self.diags.push(Diagnostic::error("E6008",
                "cannot publish committedChanges: checked source, complete handler inventory or private invocation does not match".to_string(), span));
            return None;
        }
        let mut changes: Vec<JsCommittedChange> = Vec::new();
        for fact in &facts.handlers {
            let IrEventSource::Committed { change, .. } = fact.source else {
                unreachable!()
            };
            let source = format!("{}.{}", fact.model, change.suffix());
            if let Some(entry) = changes.iter_mut().find(|entry| entry.source == source) {
                entry.handlers.push(fact.canonical.clone());
            } else {
                changes.push(JsCommittedChange {
                    source,
                    model: fact.model.clone(),
                    change,
                    handlers: vec![fact.canonical.clone()],
                });
            }
        }
        Some(changes)
    }

    fn standard_completion_item_matches(
        current: &[&IrItem],
        fact: &CheckedStandardCompletionHandler,
        item: &IrItem,
        params_empty: bool,
    ) -> bool {
        item.id == fact.id
            && current
                .iter()
                .filter(|current| current.id == fact.id)
                .count()
                == 1
            && fact.node.file == item.span.file
            && fact.node.start <= item.span.start
            && fact.node.end >= item.span.end
            && fact.on.file == fact.node.file
            && fact.on.start >= fact.node.start
            && fact.on.end <= fact.node.end
            && fact.on.start < fact.on.end
            && item.module == fact.module
            && item.canonical == fact.canonical
            && item.span == fact.span
            && params_empty
    }

    fn standard_completion_payload_matches(
        module: &IrModule,
        fact: &CheckedStandardCompletionHandler,
        completion: &crate::analysis::types::CheckedStdDeliveryCompletion,
        event: &String,
        canonical_operation: &String,
        result_type: &String,
        binding: &String,
        from: &String,
    ) -> bool {
        module.id == fact.module
            && completion.module == fact.module
            && event == &completion.source
            && canonical_operation == &completion.canonical_operation
            && result_type == &completion.result_type
            && completion.binding.as_ref() == Some(binding)
            && completion.from.as_ref() == Some(from)
            && binding == &format!("{}.{}", module.name, completion.alias)
    }

    fn standard_completion_route_matches(
        module: &IrModule,
        completion: &crate::analysis::types::CheckedStdDeliveryCompletion,
        from: &String,
        canonical_operation: &String,
        result_type: &String,
    ) -> bool {
        let imports: Vec<_> = module
            .imports
            .iter()
            .flat_map(|import| {
                import
                    .members
                    .iter()
                    .filter(|(_, alias, _)| *alias == completion.alias)
                    .map(move |member| (import, member))
            })
            .collect();
        imports.len() == 1
            && imports[0].0.provider == "std"
            && imports[0].0.span == completion.import_span
            && imports[0].0.from.as_ref() == Some(from)
            && format!("std.{}", imports[0].1.0) == completion.capability
            && std_capability(&completion.capability).is_some_and(|capability| {
                capability.operations.iter().any(|op| {
                    op.name == completion.op
                        && op.result == *result_type
                        && format!("{}.{}", capability.name, op.name) == *canonical_operation
                })
            })
    }

    fn standard_completion_cohort_matches(
        &self,
        cohort: &Option<IrCohort>,
        fact: &CheckedStandardCompletionHandler,
    ) -> bool {
        cohort == &fact.cohort
            && cohort.as_ref().map(|cohort| {
                self.ir
                    .items
                    .get(cohort.model.0 as usize)
                    .filter(|item| {
                        item.id == cohort.model
                            && matches!(item.kind, IrItemKind::Model { .. })
                    })
                    .map(|item| item.canonical.as_str())
            }) == fact.cohort_model.as_deref().map(Some)
    }

    fn standard_completion_fact_matches(
        &self,
        current: &[&IrItem],
        fact: &CheckedStandardCompletionHandler,
    ) -> bool {
        let completion = &fact.completion;
        let Some(item) = self.ir.items.get(fact.id.0 as usize) else {
            return false;
        };
        let IrItemKind::Scenario {
            params,
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
            cohort,
            ..
        } = &item.kind
        else {
            return false;
        };
        let Some(module) = self.ir.modules.get(fact.module.0 as usize) else {
            return false;
        };
        Self::standard_completion_item_matches(current, fact, item, params.is_empty())
            && Self::standard_completion_payload_matches(
                module,
                fact,
                completion,
                event,
                canonical_operation,
                result_type,
                binding,
                from,
            )
            && Self::standard_completion_route_matches(
                module,
                completion,
                from,
                canonical_operation,
                result_type,
            )
            && self.standard_completion_cohort_matches(cohort, fact)
            && self.private_event_invocation(item, source).is_some()
    }

    fn collect_standard_completions(
        &mut self,
        db: Option<&crate::source::SourceDb>,
    ) -> Option<Vec<JsStandardCompletion>> {
        let facts = &self.ir.standard_completion_sources;
        let current: Vec<_> = self
            .ir
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
            .collect();
        if facts.handlers.is_empty() && current.is_empty() {
            return None;
        }
        let claimed_ids: std::collections::HashSet<_> =
            facts.handlers.iter().map(|fact| fact.id).collect();
        let public_source_valid = !facts.has_public_standard_completion_fact()
            || db.is_some_and(|db| facts.valid_public_standard_completions(self.ir, db));
        let valid = public_source_valid
            && (!self.ir.standard_completion_sources.is_private_terminal_candidate() || self.private_terminal_ready)
            && db.is_some_and(|db| {
                !facts.sources.is_empty()
                    && facts.sources.iter().all(|(id, path, hash)| {
                        db.get(*id)
                            .is_some_and(|source| source.path == *path && source.sha256 == *hash)
                    })
            })
            && current.len() == facts.handlers.len()
            && claimed_ids.len() == facts.handlers.len()
            && current.iter().all(|item| claimed_ids.contains(&item.id))
            && facts
                .handlers
                .iter()
                .all(|fact| self.standard_completion_fact_matches(&current, fact));
        if !valid {
            let span = facts
                .handlers
                .first()
                .map(|fact| fact.span)
                .or_else(|| current.first().map(|item| item.span))
                .unwrap_or(Span::new(crate::source::SourceId(0), 0, 0));
            self.diags.push(Diagnostic::error("E6008",
                "cannot publish standardCompletions: checked source, complete handler inventory, admitted body, import route or private schema does not match".to_string(), span));
            return None;
        }
        let mut completions: Vec<JsStandardCompletion> = Vec::new();
        for fact in &facts.handlers {
            let completion = &fact.completion;
            if let Some(entry) = completions
                .iter_mut()
                .find(|entry| entry.event == completion.source)
            {
                entry.handlers.push(fact.canonical.clone());
            } else {
                completions.push(JsStandardCompletion {
                    source: completion.canonical_operation.clone(),
                    event: completion.source.clone(),
                    binding: completion
                        .binding
                        .clone()
                        .expect("validated bound completion"),
                    from: completion.from.clone().expect("validated completion route"),
                    result_type: Some(completion.result_type.clone()),
                    handlers: vec![fact.canonical.clone()],
                });
            }
        }
        Some(completions)
    }

    /// Completion fields are all required, including nullable result/error.
    /// Native structural values retain their owning nominal identity.
    fn standard_completion_input(&self, name: &str, declared: &str) -> Option<JsOperationField> {
        let value_type = std_value_type_id(declared)?;
        let outer = value_type.strip_suffix('?').unwrap_or(&value_type);
        let base = std_value_base(outer);
        let is_array = outer.ends_with("[]") || outer.ends_with("[]!");
        let field = if nominal_schema(base).is_some() {
            self.value_types
                .as_ref()?
                .contracts
                .iter()
                .find(|contract| contract.name == base)?;
            JsMcpField::Nominal {
                name: base.to_string(),
            }
        } else {
            self.mcp_field_for_type(&IrType::Known(std_schema_type(&value_type)?), false)?
                .0
        };
        Some(JsOperationField {
            min: None,
            max: None,
            name: name.to_string(),
            field,
            value_type: Some(value_type.clone()),
            required: true,
            nullable: value_type.ends_with('?'),
            array_required: is_array.then_some(outer.ends_with("[]!")),
            computed_default: false,
            default: None,
            description: None,
            choices: None,
        })
    }

    /// Invocation input for a user-nominal (contract/message) type
    /// name: resolves through the published value contracts, never the
    /// std-only nominal table. Array and function shapes stay
    /// unsupported: completion results name one value shape.
    fn user_nominal_input(&self, name: &str, declared: &str) -> Option<JsOperationField> {
        let base = declared.strip_suffix('?').unwrap_or(declared);
        if base.ends_with("[]") || base.ends_with("[]!") || base.contains('(') {
            return None;
        }
        self.value_types
            .as_ref()?
            .contracts
            .iter()
            .find(|contract| contract.name == base)?;
        Some(JsOperationField {
            min: None,
            max: None,
            name: name.to_string(),
            field: JsMcpField::Nominal {
                name: base.to_string(),
            },
            value_type: Some(declared.to_string()),
            required: true,
            nullable: declared.ends_with('?'),
            array_required: None,
            computed_default: false,
            default: None,
            description: None,
            choices: None,
        })
    }

    /// Original declaration inputs only: handler/cohort arguments are separate.
    fn declared_event_input_fields(&self, declaration: &IrItem) -> Option<Vec<JsOperationField>> {
        let IrItemKind::Event { fields } = &declaration.kind else {
            return None;
        };
        let mut inputs = Vec::new();
        for id in fields {
            let item = self.ir.items.get(id.0 as usize)?;
            let IrItemKind::Field {
                owner,
                ty,
                default,
                server,
                required_array,
                description,
                modifiers,
                ..
            } = &item.kind
            else {
                return None;
            };
            if item.id != *id
                || *owner != declaration.id
                || item.canonical != format!("{}.{}", declaration.canonical, item.name)
                || server.is_some()
                || *required_array
            {
                return None;
            }
            let (field, is_array) = self.mcp_field_for_type(ty, false)?;
            // The flat reference carrier names an actual stored model only.
            if let JsMcpField::Ref { model, .. } = &field
                && !self.ir.items.iter().any(|item| {
                    item.canonical == *model && matches!(item.kind, IrItemKind::Model { .. })
                })
            {
                return None;
            }
            let nullable = matches!(ty, IrType::Known(ResolvedType::Nullable(_)));
            let mapped_default = js_field_default(default.as_ref(), None);
            if default.is_some() && mapped_default.is_none() {
                return None;
            }
            let array_bound = |bound: &Option<TypedExpr>| -> Option<Option<u64>> {
                if !is_array {
                    return Some(None);
                }
                match bound {
                    None => Some(None),
                    Some(bound) => match bound.expr {
                        IrExpr::Int(value) if (0..=9_007_199_254_740_991).contains(&value) => {
                            Some(Some(value as u64))
                        }
                        _ => None,
                    },
                }
            };
            inputs.push(JsOperationField {
                min: array_bound(&modifiers.min)?,
                max: array_bound(&modifiers.max)?,
                name: item.name.clone(),
                field,
                value_type: self.operation_input_value_type(ty),
                required: default.is_none() && !nullable && !is_array,
                nullable,
                array_required: is_array.then_some(false),
                computed_default: false,
                default: mapped_default,
                description: description.clone(),
                choices: None,
            });
        }
        (!has_duplicate_names(&inputs)).then_some(inputs)
    }

    /// Private trusted admission reuses original event inputs and separately
    /// appends handler-owned cohort arguments to its `{event}` envelope.
    fn queue_event_input(&self, payload: &ResolvedType) -> Option<JsOperationField> {
        let ty = IrType::Known(payload.clone());
        let (field, is_array) = self.mcp_field_for_type(&ty, false)?;
        Some(JsOperationField {
            min: None, max: None, name: "value".into(), field,
            value_type: Some(self.operation_input_value_type(&ty)?), required: true,
            nullable: matches!(payload, ResolvedType::Nullable(_)),
            array_required: is_array.then_some(false), computed_default: false,
            default: None, description: None, choices: None,
        })
    }

    fn private_event_invocation(
        &self,
        handler: &IrItem,
        event: &IrEventSource,
    ) -> Option<JsOperation> {
        let scalar_input = |name: &str, field: JsMcpField, value_type: &str| JsOperationField {
            min: None,
            max: None,
            name: name.to_string(),
            field,
            value_type: Some(value_type.to_string()),
            required: true,
            nullable: false,
            array_required: None,
            computed_default: false,
            default: None,
            description: None,
            choices: None,
        };
        let mut inputs = match event {
            IrEventSource::Committed { .. } => vec![
                scalar_input("id", JsMcpField::String, "text"),
                scalar_input("version", JsMcpField::Integer, "int"),
            ],
            IrEventSource::DeliveryProgressed(_) => {
                vec![scalar_input("delivery_id", JsMcpField::String, "text")]
            }
            IrEventSource::TeamsMemberRemoved => vec![
                scalar_input("team_id", JsMcpField::String, "text"),
                scalar_input("membership_id", JsMcpField::String, "text"),
                scalar_input("user", JsMcpField::User, "user"),
            ],
            IrEventSource::Declared(_) => Vec::new(),
            IrEventSource::Queue { payload, .. } => vec![self.queue_event_input(payload)?],
            IrEventSource::MailboxReceived { .. } => {
                vec![self.standard_completion_input("value", "IncomingEmail")?]
            }
            IrEventSource::PaymentsChanged { .. } => {
                vec![self.standard_completion_input("value", "PaymentState")?]
            }
            IrEventSource::StandardCompleted { result_type, .. } => {
                let result = if result_type.ends_with('?') {
                    result_type.clone()
                } else {
                    format!("{result_type}?")
                };
                vec![
                    scalar_input("delivery_id", JsMcpField::String, "text"),
                    scalar_input(
                        "status",
                        JsMcpField::Enum {
                            values: vec![
                                "succeeded".into(),
                                "failed".into(),
                                "unknown".into(),
                                "skipped".into(),
                            ],
                        },
                        "enum(succeeded,failed,unknown,skipped)",
                    ),
                    self.standard_completion_input("result", &result)?,
                    self.standard_completion_input("error", "DeliveryError?")?,
                ]
            }
            // Adapter completions share the DESIGN §8 four-field shape;
            // the result name may be a user contract outside the
            // std-only nominal table, so fall back to the published
            // value contracts before refusing.
            IrEventSource::DeliveryCompleted { result_type, .. } => {
                let result = if result_type.ends_with('?') {
                    result_type.clone()
                } else {
                    format!("{result_type}?")
                };
                vec![
                    scalar_input("delivery_id", JsMcpField::String, "text"),
                    scalar_input(
                        "status",
                        JsMcpField::Enum {
                            values: vec![
                                "succeeded".into(),
                                "failed".into(),
                                "unknown".into(),
                                "skipped".into(),
                            ],
                        },
                        "enum(succeeded,failed,unknown,skipped)",
                    ),
                    self.standard_completion_input("result", &result)
                        .or_else(|| self.user_nominal_input("result", &result))?,
                    self.standard_completion_input("error", "DeliveryError?")?,
                ]
            }
            // The instrumentation envelope stays opaque (the checker
            // narrows no event fields): the handler receives it whole.
            IrEventSource::InstrumentationError => Vec::new(),
            // Ticks carry no event inputs: the handler infers its scope
            // from owner-bound reads/writes (DESIGN §6).
            IrEventSource::Every { .. } => Vec::new(),
        };
        if let IrEventSource::Declared(identity) = event {
            let declaration = self
                .ir
                .items
                .iter()
                .find(|item| item.canonical == *identity)?;
            inputs.extend(self.declared_event_input_fields(declaration)?);
        }
        let IrItemKind::Scenario {
            description,
            result,
            cohort,
            ..
        } = &handler.kind
        else {
            return None;
        };
        if let Some(cohort) = cohort {
            let model = self.ir.items.get(cohort.model.0 as usize)?;
            if !matches!(model.kind, IrItemKind::Model { .. }) {
                return None;
            }
            inputs.push(JsOperationField {
                min: None,
                max: None,
                name: cohort.bind.clone().unwrap_or_else(|| "$cohort".to_string()),
                field: JsMcpField::Ref {
                    model: model.canonical.clone(),
                    require_version: false,
                },
                value_type: None,
                required: true,
                nullable: false,
                array_required: None,
                computed_default: false,
                default: None,
                description: None,
                choices: None,
            });
        }
        if has_duplicate_names(&inputs) {
            return None;
        }
        // C24 scope-1: an admitted declared-event handler with a native
        // receipt plan carries its exact checked disclosure inside the
        // private invocation only. Public `artifact.operations` still
        // excludes every trusted handler, so no public exposure follows;
        // the due-session host verifies this plan against the module
        // `canScenarioQuerySources` inventory before internal admission.
        let disclosure = self
            .native_receipts
            .get(&handler.id)
            .and_then(|recipe| serde_json::to_value(&recipe.plan).ok());
        Some(JsOperation {
            name: handler.canonical.clone(),
            kind: JsOperationKind::Scenario,
            description: description
                .as_ref()
                .map(|message| message.source.clone())
                .unwrap_or_default(),
            inputs,
            result: checked_scenario_result(result.as_ref()),
            disclosure,
            root_authority: self.operation_root_authority(handler),
            authority_query_sites: None,
        })
    }

    /// Private invocation for hook scenarios (`scenario X on=Model.op`).
    /// Hooks stay out of the servable operations surface, but the runtime
    /// file inventory and opaque file staging demand every handler
    /// callable's private invocation. A hook trigger is a model commit, so
    /// the emitted invocation mirrors the `Committed` event arm exactly
    /// (trigger id+version identity). No handler/inputs/by/event members
    /// are emitted, so serving catalogs and the completion/committed
    /// censuses (which key on `event`) are unaffected.
    fn private_hook_invocation(&self, item: &IrItem) -> Option<JsOperation> {
        let IrItemKind::Scenario {
            hook: Some(_),
            description,
            result,
            ..
        } = &item.kind
        else {
            return None;
        };
        let field = |name: &str, field: JsMcpField, value_type: &str| JsOperationField {
            min: None,
            max: None,
            name: name.to_string(),
            field,
            value_type: Some(value_type.to_string()),
            required: true,
            nullable: false,
            array_required: None,
            computed_default: false,
            default: None,
            description: None,
            choices: None,
        };
        let inputs = vec![
            field("id", JsMcpField::String, "text"),
            field("version", JsMcpField::Integer, "int"),
        ];
        if has_duplicate_names(&inputs) {
            return None;
        }
        let disclosure = self
            .native_receipts
            .get(&item.id)
            .and_then(|recipe| serde_json::to_value(&recipe.plan).ok());
        Some(JsOperation {
            name: item.canonical.clone(),
            kind: JsOperationKind::Scenario,
            description: description
                .as_ref()
                .map(|message| message.source.clone())
                .unwrap_or_default(),
            inputs,
            result: checked_scenario_result(result.as_ref()),
            disclosure,
            root_authority: self.operation_root_authority(item),
            authority_query_sites: None,
        })
    }

    /// The reserved serving route belongs to the existing receipt observer;
    /// only joined singular delivery model fields make it available.
    fn has_receipt_delivery_fields(&self) -> bool {
        self.ir.items.iter().any(|model| {
            let IrItemKind::Model { fields, .. } = &model.kind else {
                return false;
            };
            fields
                .iter()
                .filter_map(|id| self.ir.items.get(id.0 as usize))
                .any(|field| {
                    let descriptor = self.model_field(field);
                    descriptor.array_required.is_none()
                        && matches!(
                            descriptor.field,
                            JsModelFieldType::Delivery(_) | JsModelFieldType::JudgmentDelivery(_)
                        )
                })
        })
    }

    fn receipt_read_collision(&self) -> Option<Span> {
        self.ir
            .items
            .iter()
            .find(|item| {
                item.canonical == "Receipt.read"
                    || (matches!(item.kind, IrItemKind::Model { .. })
                        && item.canonical == "Receipt")
            })
            .map(|item| item.span)
    }

    fn receipt_read_operation() -> JsOperation {
        JsOperation {
            name: "Receipt.read".to_string(),
            kind: JsOperationKind::Read,
            description: String::new(),
            inputs: ["recordId", "field", "selected"]
                .into_iter()
                .map(|name| JsOperationField {
                    min: None,
                    max: None,
                    name: name.to_string(),
                    field: JsMcpField::String,
                    value_type: Some(
                        if name == "selected" { "text[]" } else { "text" }.to_string(),
                    ),
                    required: true,
                    nullable: false,
                    array_required: (name == "selected").then_some(false),
                    computed_default: false,
                    default: None,
                    description: None,
                    choices: None,
                })
                .collect(),
            result: None,
            disclosure: None,
            root_authority: None,
            authority_query_sites: None,
        }
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
    /// Descriptors are fail-closed metadata and never advertise a skewed schema.
    /// Reserved Receipt.read identity collisions refuse compilation. An operation with ANY input
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
    fn checked_operation_result(
        &self,
        result: Option<&ResolvedType>,
        read: bool,
    ) -> Option<Cow<'static, str>> {
        if let Some(result) = result
            && let Some(name) = self.nominal_value_type(result)
        {
            return Some(Cow::Owned(name));
        }
        // A declared stored model result preserves its owning identity for
        // reads and mutations alike; publishing it does not encode the row.
        if let Some(ResolvedType::Record {
            symbol,
            stored: true,
        }) = result
            && let Some(model) = self.ir.items.get(symbol.0 as usize)
            && matches!(model.kind, IrItemKind::Model { .. })
        {
            return Some(Cow::Owned(model.canonical.clone()));
        }
        if read
            && let Some(ResolvedType::Array { element, .. }) = result
            && let ResolvedType::Record {
                symbol,
                stored: true,
            } = element.as_ref()
            && let Some(model) = self.ir.items.get(symbol.0 as usize)
            && matches!(model.kind, IrItemKind::Model { .. })
        {
            return Some(Cow::Owned(format!("{}[]", model.canonical)));
        }
        if let Some(result) = result {
            let outer = match result {
                ResolvedType::Nullable(inner) => inner.as_ref(),
                result => result,
            };
            // Public scenario/read enum results share their checked input
            // case identity; only the released ordinary-array profile joins.
            if !matches!(outer, ResolvedType::Array { nonempty: true, .. })
                && let Some(value_type) = checked_enum_value_type(result)
            {
                return Some(Cow::Owned(value_type));
            }
        }
        checked_scenario_result(result)
    }

    fn collect_model_read(item: &IrItem, has_grants: bool) -> Option<JsOperation> {
        // One no-input read descriptor per policy-bearing
        // model (P4 follow-up): `policy Model read=`
        // publishes `package.Model.read` so denied reads
        // answer denied-not-unknown. Policies carry no
        // caption source, so the description stays empty.
        if !has_grants {
            return None;
        }
        Some(JsOperation {
            name: format!("{}.read", item.canonical),
            kind: JsOperationKind::Read,
            description: String::new(),
            inputs: Vec::new(),
            result: None,
            disclosure: None,
            root_authority: None,
            authority_query_sites: None,
        })
    }

    fn collect_scenario_inputs(
        &mut self,
        item: &IrItem,
        params: &Vec<SymbolId>,
        read: bool,
        hook_none: bool,
    ) -> Option<Vec<JsOperationField>> {
        // Family E: the explicit information grant
        // advertises with its required DESIGN-522
        // description identifying the information exposed
        // (checker-enforced `E3001`, so the grant never
        // publishes undescribed).
        let mut inputs = Vec::new();
        for param_id in params {
            // Never direct-index: a dangling row omits the
            // operation instead of panicking.
            let Some(param) = self.ir.items.get(param_id.0 as usize) else {
                return None;
            };
            let IrItemKind::Param {
                array_bounds,
                ty,
                default,
                description,
                choices,
                ..
            } = &param.kind
            else {
                return None;
            };
            let alias = self
                .ir
                .value_constraints
                .get(param_id)
                .and_then(|constraints| constraints.alias);
            let alias_name = alias.and_then(|alias| {
                self.ir
                    .items
                    .get(alias.0 as usize)
                    .filter(|item| {
                        item.id == alias
                            && self.ir.value_constraints.get(&alias).is_some_and(
                                |constraints| constraints.alias == Some(alias),
                            )
                    })
                    .map(|item| item.canonical.clone())
            });
            if alias.is_some() && alias_name.is_none() {
                return None;
            }
            let nullable = matches!(ty, IrType::Known(ResolvedType::Nullable(_)));
            match self.mcp_field_for_type(ty, !read) {
                // Parameters never carry the field-only `!`
                // (GRAMMAR L183), so parameter arrays are
                // always ordinary: omission fills empty and
                // the marker renders `required: false`.
                Some((field, is_array)) => inputs.push(JsOperationField {
                    min: array_bounds.as_ref().and_then(|bounds| bounds.min),
                    max: array_bounds.as_ref().and_then(|bounds| bounds.max),
                    name: param.name.clone(),
                    field: alias_name
                        .map_or(field, |name| JsMcpField::Nominal { name }),
                    value_type: match ty {
                        IrType::Known(resolved) if alias.is_some() => Some(
                            self.symbol_value_type_id(*param_id, resolved, param.span),
                        ),
                        _ => self.operation_input_value_type(ty).or_else(|| {
                            // Active native receipts and source-only Require
                            // frames retain the exact checked primitive type;
                            // a legacy string tag cannot authenticate email.
                            if !self.native_receipts.contains_key(&item.id)
                                && !self.source_requires.values().any(|source| source["owner"] == item.canonical) {
                                return None;
                            }
                            let IrType::Known(resolved) = ty else {
                                return None;
                            };
                            let scalar = match resolved {
                                ResolvedType::Nullable(inner) => inner.as_ref(),
                                value => value,
                            };
                            if matches!(scalar, ResolvedType::Scalar(
                                Scalar::Text | Scalar::Bool | Scalar::Int | Scalar::Date
                                    | Scalar::Datetime | Scalar::Decimal | Scalar::Money
                                    | Scalar::Duration | Scalar::Currency | Scalar::User
                                    | Scalar::Email | Scalar::Timezone | Scalar::Url))
                            {
                                checked_value_profile(resolved).map(str::to_owned)
                            } else {
                                None
                            }
                        }),
                    },
                    required: default.is_none() && !nullable && !is_array,
                    nullable,
                    array_required: is_array.then_some(false),
                    computed_default: hook_none
                        && matches!(default, Some(IrDefault::Computed { .. }))
                        && self.scenario_computed_default_supported(*param_id),
                    default: match default {
                        Some(IrDefault::Computed { .. }) => None,
                        _ => js_field_default(default.as_ref(), None),
                    },
                    description: description.clone(),
                    choices: choices.as_ref().map(JsInputChoiceBinding::from),
                }),
                None => {
                    return None;
                }
            }
        }
        Some(inputs)
    }

    fn collect_scenario_disclosure(
        &mut self,
        item: &IrItem,
        read: bool,
        published_result: &Option<Cow<'_, str>>,
    ) -> Option<serde_json::Value> {
        let prepared_query = read
            && self.prepared_query_receipts.contains(&item.id)
            && self
                .native_query_sources
                .get(&item.id)
                .is_some_and(|source| {
                    self.native_receipts.get(&item.id).is_some_and(|recipe| {
                        serde_json::to_value(&recipe.plan).ok().as_ref()
                            == Some(&source.plan)
                    })
                });
        if prepared_query
            || super::scenario_receipts::checked_created_model_result(self.ir, item)
                .and_then(|model| self.ir.items.get(model.0 as usize))
                .is_some_and(|model| {
                    published_result.as_deref() == Some(model.canonical.as_str())
                })
            || published_result.as_deref().is_some_and(|type_id| {
                type_id == "void"
                    || super::scenario_receipts::supported_type_id(type_id)
            })
        {
            self.native_receipts.get(&item.id).map(|recipe| {
                serde_json::to_value(&recipe.plan)
                    .expect("native disclosure JSON invariant")
            })
        } else {
            self.native_receipts.remove(&item.id);
            None
        }
    }

    fn collect_crud_fields(
        &mut self,
        model_fields: &[SymbolId],
        allowlist: &Option<BTreeSet<&str>>,
    ) -> Option<Vec<JsOperationField>> {
        let mut flat = Vec::new();
        for field_id in model_fields {
            let Some(field_item) = self.ir.items.get(field_id.0 as usize) else {
                return None;
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
            if let Some(allow) = allowlist
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
                return None;
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
                        min: None,
                        max: None,
                        name: field_item.name.clone(),
                        field,
                        value_type: required_file_array_value_type(
                            self.operation_input_value_type(ty),
                            *required_array,
                        ),
                        required,
                        nullable,
                        array_required,
                        computed_default: false,
                        default: js_field_default(default.as_ref(), None),
                        description: description.clone(),
                        choices: None,
                    });
                }
                None => {
                    return None;
                }
            }
        }
        Some(flat)
    }

    fn collect_crud_inputs(
        &self,
        op: &CrudOp,
        owner: &IrOwner,
        model_item: &IrItem,
        flat: Vec<JsOperationField>,
    ) -> Option<Vec<JsOperationField>> {
        let record = || JsOperationField {
            min: None,
            max: None,
            name: "record".to_string(),
            value_type: None,
            field: JsMcpField::Ref {
                model: model_item.canonical.clone(),
                require_version: true,
            },
            required: true,
            nullable: false,
            array_required: None,
            computed_default: false,
            default: None,
            description: None,
            choices: None,
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
                        min: None,
                        max: None,
                        name: "parent".to_string(),
                        value_type: None,
                        field: JsMcpField::Ref {
                            model: parent_item.canonical.clone(),
                            require_version: false,
                        },
                        required: true,
                        nullable: false,
                        array_required: None,
                        computed_default: false,
                        default: None,
                        description: None,
                        choices: None,
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
            return None;
        }
        Some(inputs)
    }

    fn collect_operations(&mut self) -> Vec<JsOperation> {
        let mut operations = Vec::new();
        if self.has_receipt_delivery_fields() {
            if let Some(span) = self.receipt_read_collision() {
                self.unsupported(
                    "reserved receipt operation",
                    "canonical declaration collides with reserved Receipt.read",
                    span,
                );
            } else {
                operations.push(Self::receipt_read_operation());
            }
        }
        for item in &self.ir.items {
            match &item.kind {
                IrItemKind::Model { grants, .. } => {
                    if let Some(operation) =
                        Self::collect_model_read(item, !grants.is_empty())
                    {
                        operations.push(operation);
                    }
                }
                IrItemKind::Scenario {
                    params,
                    read,
                    trusted,
                    hook,
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
                    let Some(inputs) =
                        self.collect_scenario_inputs(item, params, *read, hook.is_none())
                    else {
                        self.native_receipts.remove(&item.id);
                        continue;
                    };
                    if has_duplicate_names(&inputs) {
                        self.native_receipts.remove(&item.id);
                        continue;
                    }
                    let published_result = self.checked_operation_result(result.as_ref(), *read);
                    let disclosure =
                        self.collect_scenario_disclosure(item, *read, &published_result);
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
                        result: published_result,
                        disclosure,
                        root_authority: self.operation_root_authority(item),
                        authority_query_sites: self.authority_queries
                            .filter(|prepared| prepared.plan["operation"].as_str() == Some(item.canonical.as_str()))
                            .map(|prepared| prepared.plan.clone()),
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
                    let Some(flat) = self.collect_crud_fields(model_fields, &allowlist)
                    else {
                        continue;
                    };
                    let Some(inputs) =
                        self.collect_crud_inputs(op, owner, &model_item, flat)
                    else {
                        continue;
                    };
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
                        disclosure: None,
                        root_authority: self.operation_root_authority(item),
                        authority_query_sites: None,
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
    /// Standard receipts retain their closed provider descriptor. Static
    /// Judgment deliveries join their checked declaration and value inventory;
    /// other local deliveries remain outside this profile.
    fn mcp_field_for_type(&self, ty: &IrType, require_version: bool) -> Option<(JsMcpField, bool)> {
        let resolved = match ty {
            IrType::Known(resolved) => resolved,
            IrType::Unknown => return None,
        };
        self.mcp_field_for_resolved(resolved, require_version)
    }

    /// Frozen lexical inputs keep the original source schema, without rerunning
    /// defaults. This is declaration data; the native loader owns qualification.
    fn send_input_alias_field(&self, symbol: SymbolId) -> Option<Option<JsMcpField>> {
        let Some(alias) = self
            .ir
            .value_constraints
            .get(&symbol)
            .and_then(|constraints| constraints.alias)
        else {
            return Some(None);
        };
        let alias_item = self.ir.items.get(alias.0 as usize)?;
        if alias_item.id != alias
            || self.ir.value_constraints.get(&alias)?.alias != Some(alias)
            || !self
                .value_types
                .as_ref()?
                .aliases
                .iter()
                .any(|value| value.name == alias_item.canonical)
        {
            return None;
        }
        Some(Some(JsMcpField::Nominal {
            name: alias_item.canonical.clone(),
        }))
    }

    fn send_input_shape<'x>(
        &self,
        guard: &super::send_guards::PreparedSendGuard,
        ordinal: usize,
        input: &'x super::send_guards::PreparedSendInput,
    ) -> Option<(
        JsMcpField,
        Option<u64>,
        Option<u64>,
        bool,
        Option<bool>,
        &'x ResolvedType,
    )> {
        let owner = self.ir.items.get(input.owner.0 as usize)?;
        if input.ordinal != ordinal
            || owner.id != input.owner
            || guard.descriptor["owner"].as_str() != Some(owner.canonical.as_str())
            || input.declaration.file != input.value.span.file
        {
            return None;
        }
        let (mut field, is_array) = self.mcp_field_for_resolved(&input.value.ty, true)?;
        let mut min = None;
        let mut max = None;
        if let Some(symbol) = input.symbol {
            let param = self.ir.items.get(symbol.0 as usize)?;
            let IrItemKind::Param {
                owner: declared_owner,
                ty: IrType::Known(ty),
                array_bounds,
                ..
            } = &param.kind
            else {
                return None;
            };
            if param.id != symbol || *declared_owner != input.owner || *ty != input.value.ty {
                return None;
            }
            min = array_bounds.as_ref().and_then(|bounds| bounds.min);
            max = array_bounds.as_ref().and_then(|bounds| bounds.max);
            if let Some(alias_field) = self.send_input_alias_field(symbol)? {
                field = alias_field;
            }
        }
        let nullable = matches!(input.value.ty, ResolvedType::Nullable(_));
        let base = if let ResolvedType::Nullable(inner) = &input.value.ty {
            inner.as_ref()
        } else {
            &input.value.ty
        };
        let array_required = match base {
            ResolvedType::Array { element, .. } if is_array => {
                // The closed input ABI cannot represent nullable elements or nested containers.
                if matches!(
                    element.as_ref(),
                    ResolvedType::Array { .. } | ResolvedType::Nullable(_)
                ) {
                    return None;
                }
                Some(false)
            }
            _ if !is_array => None,
            _ => return None,
        };
        Some((field, min, max, nullable, array_required, base))
    }

    fn send_input_declaration_json(
        field: &JsMcpField,
        type_id: &str,
        nullable: bool,
        array_required: Option<bool>,
        min: Option<u64>,
        max: Option<u64>,
        base: &ResolvedType,
    ) -> Option<serde_json::Value> {
        let field_json = serde_json::to_value(field).ok()?;
        let mut declaration = serde_json::json!({"kind":field_json["kind"]});
        match field {
            JsMcpField::Ref {
                model,
                require_version,
            } => {
                declaration["model"] = serde_json::json!(model);
                declaration["versioned"] = serde_json::json!(require_version);
                if nullable {
                    declaration["nullable"] = serde_json::json!(true);
                }
                if let Some(required) = array_required {
                    declaration["array"] = serde_json::json!({"required":required});
                }
            }
            JsMcpField::Nominal { .. } => {
                declaration["valueType"] = serde_json::json!(type_id)
            }
            JsMcpField::Enum { values } => {
                declaration["valueType"] = serde_json::json!(type_id);
                declaration["enumValues"] = serde_json::json!(values);
            }
            JsMcpField::Delivery(_) | JsMcpField::JudgmentDelivery(_) => return None,
            _ => {
                // Match the released State opaque scalar profile exactly.
                let mut scalar = base;
                if let ResolvedType::Array { element, .. } = scalar {
                    scalar = element;
                }
                if !matches!(
                    scalar,
                    ResolvedType::Scalar(
                        Scalar::Text
                            | Scalar::Int
                            | Scalar::Decimal
                            | Scalar::Money
                            | Scalar::Datetime
                            | Scalar::Duration
                            | Scalar::Currency
                            | Scalar::User
                            | Scalar::Bool
                            | Scalar::File
                            | Scalar::Date
                            | Scalar::Email
                            | Scalar::Timezone
                    )
                ) {
                    return None;
                }
                declaration["valueType"] = serde_json::json!(type_id);
            }
        }
        if let Some(min) = min {
            declaration["min"] = serde_json::json!(min);
        }
        if let Some(max) = max {
            declaration["max"] = serde_json::json!(max);
        }
        Some(declaration)
    }

    fn send_input_declaration(
        &self,
        guard: &super::send_guards::PreparedSendGuard,
    ) -> Option<serde_json::Value> {
        let mut canonical = Vec::new();
        let mut artifact = Vec::new();
        for (ordinal, input) in guard.inputs.iter().enumerate() {
            let (field, min, max, nullable, array_required, base) =
                self.send_input_shape(guard, ordinal, input)?;
            // Frozen captures always have a slot. Nullability and array bounds
            // describe its value; they never permit omitting the lexical binding.
            let required = true;
            let mut declaration = Self::send_input_declaration_json(
                &field,
                &input.type_id,
                nullable,
                array_required,
                min,
                max,
                base,
            )?;
            declaration["name"] = serde_json::json!(input.name);
            declaration["required"] = serde_json::json!(required);
            let source_field = JsOperationField {
                min,
                max,
                name: input.name.clone(),
                field,
                value_type: Some(input.type_id.clone()),
                required,
                nullable,
                array_required,
                default: None,
                computed_default: false,
                description: None,
                choices: None,
            };
            canonical.push(declaration);
            artifact.push(serde_json::to_value(source_field).ok()?);
        }
        Some(serde_json::json!({"kind":"inputs","canonical":canonical,"artifact":artifact}))
    }

    /// Map one scalar input type to its MCP field; `Json`/`Bytes` stay
    /// unmappable (fail-closed, exactly as before).
    fn mcp_scalar_field(scalar: &Scalar) -> Option<JsMcpField> {
        match scalar {
            Scalar::Text
            | Scalar::Email
            | Scalar::Url
            | Scalar::Locale
            | Scalar::Timezone
            | Scalar::Currency
            | Scalar::Secret
            | Scalar::Date
            | Scalar::Member => Some(JsMcpField::String),
            Scalar::Int => Some(JsMcpField::Integer),
            Scalar::Decimal => Some(JsMcpField::Decimal),
            Scalar::Money => Some(JsMcpField::Money),
            Scalar::Datetime => Some(JsMcpField::Datetime),
            Scalar::Duration => Some(JsMcpField::Duration),
            Scalar::User => Some(JsMcpField::User),
            Scalar::Bool => Some(JsMcpField::Boolean),
            Scalar::File => Some(JsMcpField::File),
            Scalar::Json | Scalar::Bytes => None,
        }
    }

    /// Map one resolved input type to its MCP field plus array flag.
    fn mcp_field_for_resolved(
        &self,
        resolved: &ResolvedType,
        require_version: bool,
    ) -> Option<(JsMcpField, bool)> {
        match resolved {
            ResolvedType::Scalar(scalar) => Some((Self::mcp_scalar_field(scalar)?, false)),
            ResolvedType::Record { .. }
            | ResolvedType::Enum { .. }
            | ResolvedType::StdNominal { .. }
                if self.nominal_value_type(resolved).is_some() =>
            {
                Some((
                    JsMcpField::Nominal {
                        name: self.nominal_value_type(resolved)?,
                    },
                    false,
                ))
            }
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
            ResolvedType::Delivery { op } => self
                .judgment_delivery_descriptor(*op)
                .map(|descriptor| (JsMcpField::JudgmentDelivery(descriptor), false)),
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
    pub(super) fn source_models(
        ir: &'a IrProgram,
        db: &crate::source::SourceDb,
    ) -> Option<Vec<JsModel>> {
        let mut emitter = Self::new(ir);
        if ir.committed_sources.has_standard_value_inventory_fact() {
            emitter.value_types = Some(emitter.collect_standard_value_inventory(db)?);
        } else if ir.committed_sources.requires_standard_value_inventory(ir) {
            return None;
        }
        Some(emitter.collect_models())
    }

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
                value_type: self.model_value_type(ty),
                required: false,
                nullable,
                trim: None,
                min: None,
                max: None,
                server_only: true,
                array_required: is_array.then_some(false),
                default: Some(JsFieldDefault::Derived),
                machine: None,
                description: None,
            };
        }
        let (ty, required_array, default, server, description, modifiers) = match &field_item.kind {
            IrItemKind::Field {
                ty,
                required_array,
                default,
                server,
                description,
                modifiers,
                ..
            } => (ty, *required_array, default, server, description, modifiers),
            _ => {
                return JsModelField {
                    name: field_item.name.clone(),
                    value_type: None,
                    field: JsModelFieldType::Other {
                        type_id: "unknown".to_string(),
                    },
                    required: false,
                    nullable: false,
                    trim: None,
                    min: None,
                    max: None,
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
        let length_bound = match ty {
            IrType::Known(ty) => {
                let mut base = ty;
                while let ResolvedType::Nullable(inner) = base {
                    base = inner;
                }
                matches!(base, ResolvedType::Array { .. })
                    || matches!(base, ResolvedType::Scalar(s) if s.is_string_like())
            }
            IrType::Unknown => false,
        };
        let bound = |value: &Option<TypedExpr>| {
            value.as_ref().and_then(|expr| {
                if length_bound {
                    let IrExpr::Int(value) = &expr.expr else {
                        return None;
                    };
                    if !(0..=9_007_199_254_740_991).contains(value) {
                        return None;
                    }
                    Some(serde_json::Value::from(u64::try_from(*value).ok()?))
                } else {
                    serde_json::from_str(&literal_json(expr)?).ok()
                }
            })
        };
        let mut value_type = required_file_array_value_type(self.model_value_type(ty), required_array);
        // The value codec and the explicit array marker must describe the
        // same authored `[]!` declaration, including scalar and nominal
        // arrays. File arrays may already carry the suffix above.
        if required_array && !nullable && let Some(name) = value_type.as_mut()
            && name.ends_with("[]") {
            name.push('!');
        }
        JsModelField {
            name: field_item.name.clone(),
            field,
            value_type,
            required,
            nullable,
            trim: modifiers.trim.then_some(true),
            min: bound(&modifiers.min),
            max: bound(&modifiers.max),
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
                    IrStmt::Match { arms, .. } => {
                        for arm in arms {
                            collect(&arm.body, model, field, operation, out);
                        }
                    }
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
    /// `other` without diagnostics. Static bound admission is checked separately.
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
    /// Standard receipts retain their provider descriptor. Static Judgment
    /// deliveries use the checked declaration version and shared result
    /// inventory; unjoined local deliveries retain their source-exact tag.
    fn scalar_model_tag(scalar: &Scalar) -> JsModelFieldType {
        match scalar {
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
        }
    }

    fn record_model_tag(&self, symbol: &SymbolId) -> JsModelFieldType {
        match self.ir.items.get(symbol.0 as usize) {
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
        }
    }

    fn simple_model_tag(ty: &ResolvedType) -> JsModelFieldType {
        match ty {
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
            ResolvedType::StdNominal { name, .. } => JsModelFieldType::Other {
                type_id: (*name).to_string(),
            },
            _ => JsModelFieldType::Other {
                type_id: "unknown".to_string(),
            },
        }
    }

    fn model_field_tag(&self, ty: &ResolvedType) -> JsModelFieldType {
        if let Some(name) = self.nominal_value_type(ty) {
            return JsModelFieldType::Nominal { name };
        }
        match ty {
            ResolvedType::Scalar(scalar) => Self::scalar_model_tag(scalar),
            ResolvedType::Record { symbol, .. } => self.record_model_tag(symbol),
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
            // Preserve the original local model slot's declared wire schema;
            // only separate owning producers may issue a non-null receipt.
            ResolvedType::Delivery { op } => self
                .judgment_delivery_descriptor(*op)
                .map(JsModelFieldType::JudgmentDelivery)
                .or_else(|| self.local_model_delivery_descriptor(*op).map(JsModelFieldType::Delivery))
                .unwrap_or_else(|| JsModelFieldType::Other {
                    type_id: self
                        .ir
                        .items
                        .get(op.0 as usize)
                        .map(|row| format!("delivery:{}", row.canonical))
                        .unwrap_or_else(|| "delivery".to_string()),
                }),
            // T15b: typed `std` receipts tag closed when both joins
            // resolve; unjoined shapes keep exactly the T14c `other`
            // fallback (fail-closed, T04b ratifies).
            ResolvedType::StdDelivery { capability, op } => delivery_descriptor(capability, op)
                .map(JsModelFieldType::Delivery)
                .unwrap_or_else(|| JsModelFieldType::Other {
                    type_id: format!("delivery:{capability}.{}", op.name),
                }),
            ResolvedType::Action { .. }
            | ResolvedType::Invocation { .. }
            | ResolvedType::Union(_)
            | ResolvedType::Object(_)
            | ResolvedType::StdNominal { .. } => Self::simple_model_tag(ty),
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
            ResolvedType::InlineMessage => JsModelFieldType::Other {
                // Diagnostic-only: this inferred local type cannot be
                // declared as a model field or published value schema.
                type_id: "anonymous message descriptor".to_string(),
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
        local_policies: Option<&LocalPolicies>,
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
        let native_hooks: HashSet<String> = local_policies
            .map(|plan| {
                plan.hook_bindings
                    .iter()
                    .map(|binding| binding.id.clone())
                    .collect()
            })
            .unwrap_or_default();
        if !native_hooks.is_empty() {
            self.emit_hooks_map(out, entry_span, &native_hooks);
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
        if self.standard_completions.is_some() {
            out.push(
                entry_span,
                Some("canApp".to_string()),
                "standardCompletions:appDefinition.standardCompletions,",
            );
        }
        self.emit_rule_map(out, "read", entry_span);
        if let Some(guards) = self.send_guards {
            let mut guards = guards.values().cloned().collect::<Vec<_>>();
            guards.sort_by(|a, b| a.rule.cmp(&b.rule));
            let mut entries = Vec::new();
            for guard in guards {
                self.enter_scope();
                let bindings = guard
                    .inputs
                    .iter()
                    .map(|input| {
                        format!(
                            "const {}=$can$send$inputs[{}];",
                            self.bind(&input.name),
                            js_string(&input.name)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("");
                let event_binding = guard.event_source.as_ref().map_or_else(String::new, |source| {
                    let extra = if guard.descriptor["owner"] == "success.remind" {
                        ",account_revision:$can$send$inputs[\"eventAccountRevision\"]"
                    } else if guard.descriptor["owner"] == "events.attendee_notice" {
                        ",kind:$can$send$inputs[\"eventKind\"]"
                    } else { "" };
                    let event = format!(
                        "const {}={{{}:$can$send$inputs[{}],{}:$can$send$inputs[{}]{extra}}};",
                        self.bind("event"),
                        object_key(&source.model_field), js_string(source.model_slot),
                        object_key(&source.revision_field), js_string(source.revision_slot),
                    );
                    match source.lexical_alias.as_deref() {
                        Some(alias) => format!("{event}const {}=$can$send$inputs[{}];",
                            self.bind(alias),js_string(source.model_slot)),
                        None => event,
                    }
                });
                let retained=self.native_receipts.values().any(|receipt|receipt.plan.retained_guarded_handler.as_ref()
                    .is_some_and(|frame|frame["owner"]==guard.descriptor["owner"]));
                let previous_owner=self.owner_handler_body;
                let previous_retained=self.retained_owner_body;
                self.owner_handler_body=retained;
                self.retained_owner_body=retained;
                let predicate = self.lower_expr(&guard.predicate);
                self.owner_handler_body=previous_owner;
                self.retained_owner_body=previous_retained;
                self.exit_scope();
                entries.push(format!(
                    "{}:async(c,$can$send$inputs)=>{{{bindings}{event_binding}return {predicate};}}",
                    object_key(&guard.rule)
                ));
            }
            out.push(
                entry_span,
                Some("canApp".into()),
                &format!("sendWhen:{{{}}},", entries.join(",")),
            );
        }
        self.emit_rule_map(out, "callbackRead", entry_span);
        self.emit_rule_map(out, "invariants", entry_span);
        self.emit_locks_map(out, entry_span);
        self.emit_retention_map(out, entry_span);
        self.emit_preferences_valid(out, entry_span);
        self.emit_derives_map(out, entry_span);
        if !native_hooks.is_empty() {
            out.push(entry_span, Some("canApp".to_string()), "hooks,");
        } else {
            self.emit_hooks_map(out, entry_span, &native_hooks);
        }
        if let Some(plan) = local_policies {
            self.emit_model_policy_bindings(out, entry_span, plan);
        }
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

    /// Module callbacks consume genuine native `(c,row)` values. The owning
    /// runtime wraps these callbacks before handing State its raw-row ABI.
    fn emit_model_policy_bindings(&mut self, out: &mut JsWriter, span: Span, plan: &LocalPolicies) {
        let module = &plan.descriptors[0].module;
        let mut entries = Vec::new();
        for binding in &plan.bindings {
            if binding.current_revision.as_ref().is_some_and(|profile| {
                profile.origin.model != binding.model || profile.origin.kind != binding.kind
            }) {
                self.unsupported(
                    "current model rule",
                    "original owning predicate binding is missing",
                    span,
                );
                continue;
            }
            let previous_rule = self.current_policy_rule.take();
            self.current_policy_rule = binding.current_revision.clone();
            self.boolean_body = binding.checked_body
                || (binding.kind == crate::codegen::ir::IrModelRuleKind::Invariant
                    && binding.predicate.as_ref().is_some_and(|predicate| {
                        super::model_policy_profile::required_model_rule_fields(
                            self.ir,
                            binding.model,
                            predicate,
                        )
                        .is_some()
                    }));
            // Query policy classification seals the transitive derived bodies
            // against fresh source before this existing inline lowering is used.
            let previous_source_guard = self.source_guard_body;
            self.source_guard_body = binding.checked_body;
            let predicate = binding
                .predicate
                .as_ref()
                .map(|predicate| self.lower_rule_fn(predicate))
                .unwrap_or_else(|| "(c,row)=>true".to_string());
            self.boolean_body = false;
            self.source_guard_body = previous_source_guard;
            self.current_policy_rule = previous_rule;
            let kind = match binding.kind {
                crate::codegen::ir::IrModelRuleKind::Invariant => "invariant",
                crate::codegen::ir::IrModelRuleKind::Lock => "lock",
            };
            let query_models = if binding.query_models.is_empty() {
                String::new()
            } else {
                format!(
                    ",queryModels:[{}]",
                    binding
                        .query_models
                        .iter()
                        .map(|model| js_string(&self.ir.item(*model).canonical))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            };
            entries.push(format!(
                "{{id:{},module:{},ownerPackage:{},model:{},kind:{},evaluate:{predicate}{query_models}}}",
                js_string(&binding.id),
                js_string(module),
                js_string(&binding.owner_package),
                js_string(&self.ir.item(binding.model).canonical),
                js_string(kind)
            ));
        }
        for binding in &plan.dependency_bindings {
            let model = &self.ir.item(binding.model).canonical;
            let changed = &self.ir.item(binding.changed_model).canonical;
            if binding.all_owners {
                let select = format!(
                    "async(views,change)=>{{if(change.model!=={}||typeof change.id!==\"string\"||change.id===\"\"||change.before===null&&change.after===null||change.before!==null&&change.before.id!==change.id||change.after!==null&&change.after.id!==change.id)throw new Error('Query rule dependency changed identity differs');const $rows=await views.final.query({{model:{},authority:\"owner\",archived:\"include\",limit:views.maxRows,order:[{{field:\"id\",direction:\"asc\"}}]}});return $rows.map(row=>{{if(typeof row.id!==\"string\"||row.id===\"\")throw new Error('Query rule dependency lost its row identity');return{{model:{},id:row.id}};}});}}",
                    js_string(changed),
                    js_string(model),
                    js_string(model)
                );
                entries.push(format!(
                    "{{id:{},module:{},ownerPackage:{},model:{},kind:\"dependency\",select:{select}}}",
                    js_string(&binding.id), js_string(module), js_string(&binding.owner_package), js_string(model)
                ));
                continue;
            }
            if !binding.path.is_empty() {
                let mut joins = String::new();
                for (source, field, target) in binding.path.iter().rev() {
                    let source = &self.ir.item(*source).canonical;
                    let target = &self.ir.item(*target).canonical;
                    let selection = if field == "parent" {
                        format!("parent:{{model:{},id:$id}}", js_string(target))
                    } else {
                        format!(
                            "where:{{op:\"eq\",field:{},value:$id}}",
                            js_string(&format!("{field}.id"))
                        )
                    };
                    joins.push_str(&format!(
                        "{{const $next=new Set();for(const $id of $ids){{const $rows=await views.final.query({{model:{},authority:\"owner\",archived:\"include\",limit:views.maxRows,{selection}}});for(const $row of $rows){{if(typeof $row.id!==\"string\"||$row.id===\"\")throw new Error('Required rule dependency lost its row identity');$next.add($row.id);if($next.size>views.maxRows)throw new Error('Required rule dependency exceeds its bound');}}}}$ids=[...$next];}}",
                        js_string(source)
                    ));
                }
                let select = format!(
                    "async(views,change)=>{{if(change.model!=={}||typeof change.id!==\"string\"||change.id===\"\"||change.before===null&&change.after===null||change.before!==null&&change.before.id!==change.id||change.after!==null&&change.after.id!==change.id)throw new Error('Required rule dependency changed identity differs');let $ids=[change.id];{joins}return $ids.map(id=>({{model:{},id}}));}}",
                    js_string(changed),
                    js_string(model)
                );
                entries.push(format!(
                    "{{id:{},module:{},ownerPackage:{},model:{},kind:\"dependency\",select:{select}}}",
                    js_string(&binding.id), js_string(module), js_string(&binding.owner_package), js_string(model)
                ));
                continue;
            }
            let select = format!(
                "(_views,change)=>{{if(change.model!=={}){{throw new Error('Original current dependency changed model differs');}}const before=change.before;const after=change.after;const row=after??before;if(row===null||row.id!==change.id||row.parent===undefined||row.parent===null||row.parent.model!=={}||typeof row.parent.id!==\"string\"||row.parent.id===\"\"||before!==null&&after!==null&&(before.id!==after.id||before.parent===undefined||before.parent===null||before.parent.model!==after.parent.model||before.parent.id!==after.parent.id)){{throw new Error('Original current dependency lost its immutable owning parent');}}return[{{model:{},id:row.parent.id}}];}}",
                js_string(changed),
                js_string(model),
                js_string(model)
            );
            entries.push(format!(
                "{{id:{},module:{},ownerPackage:{},model:{},kind:\"dependency\",select:{select}}}",
                js_string(&binding.id),
                js_string(module),
                js_string(&binding.owner_package),
                js_string(model)
            ));
        }
        for binding in &plan.hook_bindings {
            entries.push(format!(
                "{{id:{},module:{},ownerPackage:{},model:{},kind:\"hook\",run:hooks[{}].run}}",
                js_string(&binding.id),
                js_string(module),
                js_string(&binding.owner_package),
                js_string(&self.ir.item(binding.model).canonical),
                js_string(&binding.operation)
            ));
        }
        out.push(
            span,
            Some("modelPolicyBindings".to_string()),
            &format!("modelPolicyBindings:[{}],", entries.join(",")),
        );
    }

    /// Lower one `(c, row)` rule function, `async` exactly when the body
    /// awaits.
    fn lower_rule_fn(&mut self, body: &TypedExpr) -> String {
        let body_text = self.lower_business_expr(body, "formatted business rule");
        if self.current_policy_rule.as_ref().is_some_and(|profile| {
            matches!(
                profile.kind,
                super::model_policy_profile::CurrentRevisionRuleKind::Template { .. }
            )
        }) {
            format!("async(c,row,$readCurrent)=>{body_text}")
        } else if expr_uses_async(body) || self.boolean_body || self.implicit_expr_uses_async(body) {
            format!("async(c,row)=>{body_text}")
        } else {
            format!("(c,row)=>{body_text}")
        }
    }

    /// Emit one boolean rule map (`read`, `invariants`).
    fn emit_rule_map(&mut self, out: &mut JsWriter, member: &str, span: Span) {
        let rules = match member {
            "read" => self.ir.read_rules.clone(),
            "callbackRead" => self.ir.callback_read_rules.clone(),
            _ => self.ir.invariants.clone(),
        };
        if rules.is_empty() {
            return;
        }
        let entries: Vec<String> = rules
            .iter()
            .map(|rule| {
                self.boolean_body = matches!(member, "read" | "callbackRead")
                    && self.boolean_rules.contains(&rule.id)
                    || member == "invariants"
                        && rule.origin.as_ref().is_some_and(|origin| {
                            super::model_policy_profile::required_model_rule_fields(
                                self.ir,
                                origin.model,
                                &rule.pred,
                            )
                            .is_some()
                        });
                let body = self.lower_rule_fn(&rule.pred);
                self.boolean_body = false;
                format!("{}:{}", js_string(&rule.id), body)
            })
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
        let ir = self.ir;
        for item in &ir.items {
            let IrItemKind::DeriveField { expr, .. } = &item.kind else {
                continue;
            };
            let key = item.canonical.clone();
            self.callables.push(JsCallable {
                id: item.canonical.clone(),
                kind: JsCallableKind::Pure,
                export: key.clone(),
                member: registry_member(self.ir, item),
                input_style: None,
                source: self.declaration_source(item.span),
                span: item.span,
            });
            match expr {
                Some(expr) => {
                    let body_text = if self.boolean_sources.contains_key(&expr.span) {
                        self.stdlib.insert("nativeReadBoolean".into());
                        format!("await nativeReadBoolean(c,$can$boolean${},row)", item.id.0)
                    } else if self.membership_predicates.contains_key(&expr.span) {
                        self.unsupported(
                            "Boolean derived field",
                            "native Boolean observation backend required",
                            expr.span,
                        );
                        self.throw_expr("unsupported Boolean observation backend")
                    } else {
                        self.lower_business_expr(expr, "formatted ordinary derived field")
                    };
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
    /// function binds `($candidate, $hookCtx)` (native also binds `c`),
    /// builds the live `event`
    /// Checked native hooks receive State's original projected snapshots and
    /// owning context; their policy binding reuses this exact callback. Legacy
    /// profiles retain the existing engine convention until their owner joins.
    fn emit_hooks_map(
        &mut self,
        out: &mut JsWriter,
        span: Span,
        native_hooks: &HashSet<String>,
    ) {
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
            // Per-hook profile: a hook the owner-policy plan binds runs
            // native (receives `c`); the rest keep the legacy convention
            // in the same map. The const form is used when any hook is
            // native so the return object can reference the map.
            let hook_native = native_hooks.contains(&item.canonical);
            let prefix = if index == 0 {
                if !native_hooks.is_empty() {
                    "const hooks={"
                } else {
                    "hooks:{"
                }
            } else {
                ""
            };
            let context_arg = if hook_native { ",c" } else { "" };
            out.push(
                item.span,
                Some(item.canonical.clone()),
                &format!(
                    "{prefix}{}:{{name:{},ops:[{}],run:async function {handler}($candidate,$hookCtx{context_arg}){{",
                    js_string(&key),
                    js_string(&item.canonical),
                    js_string(hook_engine_op(hook.op))
                ),
            );
            out.push(
                item.span,
                Some(item.canonical.clone()),
                if hook_native {
                    "const $hookRow=(row)=>{if(row==null)return null;const {data,...meta}=row;return {...data,...meta};};const event={before:$hookRow($hookCtx.before),after:$hookRow($hookCtx.after)};"
                } else {
                    "const event={after:{...$candidate,id:$hookCtx.triggerId,version:($hookCtx.before?$hookCtx.before.version+1:1),parent:($hookCtx.before?$hookCtx.before.parent:null)},before:($hookCtx.before?{...$hookCtx.before.data,id:$hookCtx.before.id,version:$hookCtx.before.version,parent:$hookCtx.before.parent}:null)};"
                },
            );
            out.push(
                item.span,
                Some(item.canonical.clone()),
                "let $stagedNext=0;",
            );
            out.push(item.span, Some(item.canonical.clone()), "let $pending;");
            self.enter_scope();
            self.enter_hook(hook.model, hook_native, &item.canonical);
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
        out.push(
            span,
            Some("canApp".to_string()),
            if !native_hooks.is_empty() { "};" } else { "}," },
        );
    }

    /// Emit derived functions as module-scope named functions
    /// (`{export?}async function name(c,...params){...}` per the
    /// CanChat/CanDiscover draft contract). Bodies reference parameters
    /// by bare name, so the signature carries the declared params in
    /// order (no `row`: derives are pure functions, DESIGN §2). Always
    /// `async`: call sites uniformly `await`. Exported exactly when the
    /// source derive is exported.
    fn emit_derive_fns(&mut self, out: &mut JsWriter, owner_mode: bool, retained_mode: bool, generic_boolean_mode: bool) {
        let ir = self.ir;
        let mut emitted = HashSet::new();
        loop {
        let items: Vec<_> = ir.items.iter().filter(|item| matches!(item.kind, IrItemKind::DeriveFn { .. })
            && (!generic_boolean_mode || self.generic_boolean_derives.contains(&item.canonical))
            && (!owner_mode || if retained_mode { self.retained_owner_derives.contains(&item.canonical) }
                else { self.owner_handler_derives.contains(&item.canonical) })
            && !emitted.contains(&item.id)).cloned().collect();
        if items.is_empty() { break; }
        for item in &items {
            emitted.insert(item.id);
            let IrItemKind::DeriveFn { params, expr, .. } = &item.kind else {
                continue;
            };
            let modes = if generic_boolean_mode { vec![true] } else if !owner_mode && self.private_derives.contains(&item.canonical) {
                if self.boolean_derives.contains(&item.canonical) { vec![true] } else { Vec::new() }
            } else if !owner_mode && self.boolean_derives.contains(&item.canonical) {
                vec![false, true]
            } else {
                vec![false]
            };
            for boolean_body in modes {
                self.owner_handler_body = owner_mode;
                self.retained_owner_body = retained_mode;
                self.boolean_body = boolean_body;
                self.generic_boolean_body = generic_boolean_mode;
                self.source_guard_body = generic_boolean_mode;
                self.boolean_helper = self.boolean_derives.contains(&item.canonical);
                let name = binding_ident(if generic_boolean_mode { "v" } else if retained_mode { "t" } else if owner_mode { "o" } else if boolean_body { "b" } else { "s" }, &item.canonical);
                self.enter_scope();
                let mut signature = vec!["c".to_string()];
                for id in params {
                    signature.push(self.bind(&self.ir.items[id.0 as usize].name.clone()));
                }
                let export = if item.exported && !boolean_body && !owner_mode {
                    "export "
                } else {
                    ""
                };
                match expr {
                    Some(_) if !owner_mode && !boolean_body
                        && item.canonical == "sales_attribution.latest_capture"
                        && self.private_term_helper_only =>
                    {
                        // The exact term profile proves the only checked call
                        // to this helper is inside its private owner callback.
                        // Keep the ordinary export fail-closed; the selected
                        // owner variant below performs the checked FIRST.
                        out.push(item.span,Some(item.canonical.clone()),
                            &format!("{export}async function {name}({}){{throw new Error('latest_capture requires its checked term owner');}}",
                                signature.join(",")));
                    }
                    Some(expr) => {
                        let mut defaults = String::new();
                        for (id, name) in params.iter().zip(signature.iter().skip(1)) {
                            if let IrItemKind::Param {
                                default: Some(default),
                                ..
                            } = &self.ir.items[id.0 as usize].kind.clone()
                            {
                                let value = match default {
                                    IrDefault::Literal(expr) | IrDefault::Computed { expr, .. } => {
                                        self.lower_business_expr(
                                            expr,
                                            "formatted derive parameter default",
                                        )
                                    }
                                };
                                defaults.push_str(&format!(
                                    "if({name}===undefined){{{name}={value};}}"
                                ));
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
                self.boolean_body = false;
                self.generic_boolean_body = false;
                self.source_guard_body = false;
                self.boolean_helper = false;
                self.owner_handler_body = false;
                self.retained_owner_body = false;
            }
        }
        if !owner_mode && !generic_boolean_mode { break; }
        }
    }

    /// Selected hook-variant emission: only derives actually selected by a
    /// hook linkage call site lower `h$…(c,$hookSite,…params)` (parent
    /// loader) or the reference-loader twin (same signature, distinct
    /// `hookref` name). This runs after [`Emitter::emit_can_app`] because
    /// hook bodies (the selecting call sites) lower inside the hooks
    /// registry there, not during page lowering. The worklist then runs to
    /// a fixpoint in source order: nested selections discovered while
    /// emitting variants (transitive required callees) emit exactly once
    /// per (canonical, kind), and ordinary record helpers no hook calls
    /// keep only their pure variant with zero hook diagnostics. Linkage
    /// reads go through `c.transitive` at the inherited site (helpers
    /// inherit the consuming decision/value site); everything else lowers
    /// exactly like the pure variant. Module-internal (hook call sites
    /// share the scope), so never exported. Top-level function
    /// declarations hoist, so definitions here resolve the earlier hook
    /// call sites exactly as when they were interleaved.
    fn emit_hook_variants(&mut self, out: &mut JsWriter) {
        let mut hook_emitted: BTreeSet<(String, bool)> = BTreeSet::new();
        loop {
            let mut next: Option<(usize, bool)> = None;
            for (index, item) in self.ir.items.iter().enumerate() {
                if !matches!(&item.kind, IrItemKind::DeriveFn { .. }) {
                    continue;
                }
                for is_reference in [false, true] {
                    let selected = if is_reference {
                        self.hook_variant_reference.contains(&item.canonical)
                    } else {
                        self.hook_variant_parent.contains(&item.canonical)
                    };
                    if selected
                        && !hook_emitted.contains(&(item.canonical.clone(), is_reference))
                    {
                        next = Some((index, is_reference));
                        break;
                    }
                }
                if next.is_some() {
                    break;
                }
            }
            let Some((index, is_reference)) = next else {
                break;
            };
            hook_emitted.insert((self.ir.items[index].canonical.clone(), is_reference));
            self.emit_hook_variant(out, index, is_reference);
        }
    }

    /// One selected hook-variant body (`h$…(c,$hookSite,…params)` for the
    /// derive at `index` plus loader kind). Selection and emission share
    /// the linkage set exactly, so an emitted variant always carries the
    /// linkage set its call sites selected.
    fn emit_hook_variant(&mut self, out: &mut JsWriter, index: usize, is_reference: bool) {
        let item = &self.ir.items[index];
        let (span, canonical) = (item.span, item.canonical.clone());
        let IrItemKind::DeriveFn {
            params: hook_params,
            expr: Some(hook_body),
            ..
        } = &item.kind.clone()
        else {
            return;
        };
        let Some(name) = self.derive_hook_variant(&canonical, is_reference) else {
            return;
        };
        self.enter_scope();
        let mut signature = vec!["c".to_string(), "$hookSite".to_string()];
        let mut links = HashMap::new();
        for id in hook_params {
            let source = self.ir.items[id.0 as usize].name.clone();
            signature.push(self.bind(&source));
            if let Some((_, symbol, canonical)) = self.derive_hook_link(*id) {
                links.insert(source, (symbol, canonical));
            }
        }
        let mut defaults = String::new();
        for (id, bound) in hook_params.iter().zip(signature.iter().skip(2)) {
            if let IrItemKind::Param {
                default: Some(default),
                ..
            } = &self.ir.items[id.0 as usize].kind.clone()
            {
                let value = match default {
                    IrDefault::Literal(expr) | IrDefault::Computed { expr, .. } => {
                        self.lower_business_expr(expr, "formatted derive parameter default")
                    }
                };
                defaults.push_str(&format!("if({bound}===undefined){{{bound}={value};}}"));
            }
        }
        let prior = self.hook_helper_links.replace(links);
        let prior_ref = std::mem::replace(&mut self.hook_helper_reference, is_reference);
        let body_text = self.lower_expr(hook_body);
        self.hook_helper_links = prior;
        self.hook_helper_reference = prior_ref;
        out.push(
            span,
            Some(canonical),
            &format!(
                "async function {name}({}){{{defaults}return {body_text};}}",
                signature.join(",")
            ),
        );
        self.exit_scope();
    }

    fn emit_crud_op_handler(
        &mut self,
        out: &mut JsWriter,
        item: &IrItem,
        model: &SymbolId,
        op: &CrudOp,
        by: &[crate::codegen::ir::IrGuard],
        has_when: bool,
        delete_mode: &crate::codegen::ir::IrDeleteMode,
    ) {
        let model_item = self.ir.items[model.0 as usize].clone();
        let handler = object_key(&item.canonical);
        let when = if has_when {
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

    fn emit_scenario_param_defaults(
        &mut self,
        out: &mut JsWriter,
        item: &IrItem,
        trusted: &bool,
        params: &[SymbolId],
        default_observer: &Option<String>,
    ) {
        if *trusted {
            return;
        }
        for id in params {
            let param = self.ir.items[id.0 as usize].clone();
            if let IrItemKind::Param {
                default: Some(default),
                default_node,
                ..
            } = &param.kind
            {
                let name = self.reference(&param.name);
                let (IrDefault::Literal(expr) | IrDefault::Computed { expr, .. }) = default;
                let value = self.lower_business_expr(
                    expr,
                    "formatted scenario parameter default",
                );
                let mut default_site = self.receipt_site(
                    default_node
                        .map(|node| Span::new(node.file, node.start, node.end))
                        .unwrap_or(expr.span),
                );
                default_site.default_selection = true;
                let evaluated = self
                    .receipt_choice_at(default_site.clone(), "default-evaluated");
                let provided = self.receipt_choice_at(default_site, "default-provided");
                let supplied_branch = if provided.is_empty() {
                    String::new()
                } else {
                    format!("else{{{provided}}}")
                };
                let report = match (default_observer, default) {
                    (Some(observer), IrDefault::Computed { .. })
                        if self.scenario_computed_default_supported(*id) =>
                    {
                        format!(
                            "{observer}?.({},{});",
                            js_string(&param.name),
                            name
                        )
                    }
                    _ => String::new(),
                };
                out.push(
                    param.span,
                    Some(item.canonical.clone()),
                    &format!("if({name}===undefined){{{evaluated}{name}={value};{report}}}{supplied_branch}"),
                );
            }
        }
    }

    fn emit_scenario_body_stmts(
        &mut self,
        out: &mut JsWriter,
        item: &IrItem,
        guards: &[IrStmt],
        effects: &[IrStmt],
    ) {
        if let Some(decision) = self.receipt_capture.as_ref()
            .and_then(|receipt| receipt.plan.rent_notice_decision.clone())
            && matches!(item.canonical.as_str(),"rent_reservations.correspondence" | "rent_reservations.remind")
        {
            self.emit_rent_notice_decision_body(out,item,guards,effects,&decision);
            return;
        }
        if let Some(decision) = self.receipt_capture.as_ref()
            .and_then(|receipt| receipt.plan.invoice_issue_decision.clone())
            && item.canonical == "invoice.issue"
        {
            self.emit_invoice_issue_decision_body(out,item,guards,effects,&decision);
            return;
        }
        if let Some(decision) = self.receipt_capture.as_ref()
            .and_then(|receipt| receipt.plan.invoice_collect_decision.clone())
            && item.canonical == "invoice.collect"
        {
            self.emit_invoice_collect_decision_body(out,item,guards,effects,&decision);
            return;
        }
        if let Some(decision) = self.receipt_capture.as_ref()
            .and_then(|receipt| receipt.plan.rent_movement_refund_decision.clone())
            && item.canonical == "rent_reservations.refund_movement_credit"
        {
            self.emit_rent_movement_refund_decision_body(out,item,guards,effects,&decision);
            return;
        }
        if let Some(decision) = self.receipt_capture.as_ref()
            .and_then(|receipt| receipt.plan.refer_reject_decision.clone())
            && item.canonical == "refer.reject_source"
        {
            self.emit_refer_reject_decision_body(out,item,guards,effects,&decision);
            return;
        }
        if let Some(decision) = self.receipt_capture.as_ref()
            .and_then(|receipt| receipt.plan.member_retry_decision.clone())
            && item.canonical == "member_terms.retry_collection"
        {
            self.emit_member_retry_decision_body(out,item,guards,effects,&decision);
            return;
        }
        if let Some(decision) = self.receipt_capture.as_ref()
            .and_then(|receipt| receipt.plan.invoice_overdue_decision.clone())
            && item.canonical == "invoice.overdue"
        {
            self.emit_invoice_overdue_decision_body(out,item,guards,effects,&decision);
            return;
        }
        if let Some(decision) = self.receipt_capture.as_ref()
            .and_then(|receipt| receipt.plan.leave_decide_decision.clone())
            && item.canonical == "leave.decide"
        {
            self.emit_leave_decide_decision_body(out,item,guards,effects,&decision);
            return;
        }
        if let Some(decision) = self.receipt_capture.as_ref()
            .and_then(|receipt| receipt.plan.leave_request_decision.clone())
            && item.canonical == "leave.request"
        {
            self.emit_leave_request_decision_body(out,item,guards,effects,&decision);
            return;
        }
        if let Some(decision) = self.receipt_capture.as_ref()
            .and_then(|receipt| receipt.plan.term_decision.clone())
            && item.canonical == "member_terms.term"
        {
            self.emit_term_decision_body(out,item,guards,effects,&decision);
            return;
        }
        if self.receipt_capture.as_ref()
            .and_then(|receipt| receipt.plan.observe_venue_decision.as_ref())
            .is_some_and(|decision| decision["owner"] == "events.observe_venue")
            && item.canonical == "events.observe_venue"
        {
            // The venue scan tag needs the owner-handler lifetime, but the
            // hook body keeps its ordinary shape: no nativeScenario wrapper
            // exists for this decision yet. The tag alone grants nothing;
            // the staged read is authorized only through the State-issued
            // scan lease (prepareObserveVenueScanQuery) and the Cloudflare
            // narrow reader that requires its exact site tag.
            let previous_owner = self.owner_handler_body;
            self.owner_handler_body = true;
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
            self.owner_handler_body = previous_owner;
            return;
        }
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
    }

    fn emit_rent_notice_decision_body(&mut self, out: &mut JsWriter, item: &IrItem,
        guards: &[IrStmt], effects: &[IrStmt], decision: &serde_json::Value) {
        let expected = if item.canonical == "rent_reservations.correspondence" {3} else {4};
        if guards.len()!=1 || effects.len()!=expected {
            self.unsupported("booking notice owner decision",
                "the exact authored event body is missing",item.span);
            return;
        }
        let previous_owner=self.owner_handler_body;
        let previous_query=self.query_capture.take();
        self.owner_handler_body=true;
        self.enter_scope();
        let event=format!("{}:{}",object_key("event"),self.bind("event"));
        self.stdlib.insert("nativeScenarioRentNoticeDecision".into());
        out.push(item.span,Some(item.canonical.clone()),
            &format!("await nativeScenarioRentNoticeDecision(c,{},async(c,{{{event}}})=>{{",
                descriptor_json(decision)));
        for stmt in guards.iter().chain(effects) {
            for (line,span) in self.lower_stmt(stmt,0) {
                out.push(span,Some(item.canonical.clone()),&line);
            }
        }
        out.push(item.span,Some(item.canonical.clone()),"return undefined;});");
        self.exit_scope();
        self.owner_handler_body=previous_owner;
        self.query_capture=previous_query;
    }

    fn emit_invoice_issue_decision_body(&mut self, out: &mut JsWriter, item: &IrItem,
        guards: &[IrStmt], effects: &[IrStmt], decision: &serde_json::Value) {
        if guards.len()!=2 || effects.len()!=7 ||
            !matches!(&effects[0], IrStmt::Let {name,..} if name == "defaults") {
            self.unsupported("invoice issue owner decision",
                "the exact authored defaults stage is missing",item.span);
            return;
        }
        let previous_owner=self.owner_handler_body;
        let previous_query=self.query_capture.take();
        self.owner_handler_body=true;
        self.enter_scope();
        let invoice=format!("{}:{}",object_key("invoice"),self.bind("invoice"));
        let number=format!("{}:{}",object_key("number"),self.bind("number"));
        let first_defaults=self.bind("firstDefaults");
        self.stdlib.insert("nativeScenarioInvoiceIssueDecision".into());
        out.push(item.span,Some(item.canonical.clone()),
            &format!("await nativeScenarioInvoiceIssueDecision(c,{},async(c,{{{invoice},{number},firstDefaults:{first_defaults}}})=>{{",
                descriptor_json(decision)));
        if let IrItemKind::Scenario { by, .. } = &item.kind {
            let admission=self.lower_admission(by);
            out.push(item.span,Some(item.canonical.clone()),&format!("{admission};"));
        }
        for stmt in guards {
            for (line,span) in self.lower_stmt(stmt,0) {
                out.push(span,Some(item.canonical.clone()),&line);
            }
        }
        if let IrStmt::Let {name,span,..}=&effects[0] {
            let bound=self.bind(name);
            out.push(*span,Some(item.canonical.clone()),
                &format!("const {bound}=await {first_defaults}();"));
        }
        for stmt in &effects[1..] {
            for (line,span) in self.lower_stmt(stmt,0) {
                out.push(span,Some(item.canonical.clone()),&line);
            }
        }
        out.push(item.span,Some(item.canonical.clone()),"return undefined;});");
        self.exit_scope();
        self.owner_handler_body=previous_owner;
        self.query_capture=previous_query;
    }

    fn emit_invoice_collect_decision_body(
        &mut self, out: &mut JsWriter, item: &IrItem,
        guards: &[IrStmt], effects: &[IrStmt], decision: &serde_json::Value,
    ) {
        if guards.len()!=2 || effects.len()!=7 {
            self.unsupported("invoice collection owner decision",
                "the exact authored body is missing",item.span);
            return;
        }
        let previous_owner=self.owner_handler_body;
        let previous_query=self.query_capture.take();
        self.owner_handler_body=true;
        self.enter_scope();
        let invoice=format!("{}:{}",object_key("invoice"),self.bind("invoice"));
        self.stdlib.insert("nativeScenarioInvoiceCollectDecision".into());
        out.push(item.span,Some(item.canonical.clone()),
            &format!("await nativeScenarioInvoiceCollectDecision(c,{},async(c,{{{invoice}}})=>{{",
                descriptor_json(decision)));
        if let IrItemKind::Scenario { by, .. } = &item.kind {
            let admission=self.lower_admission(by);
            out.push(item.span,Some(item.canonical.clone()),&format!("{admission};"));
        }
        for stmt in guards.iter().chain(effects) {
            for (line,span) in self.lower_stmt(stmt,0) {
                out.push(span,Some(item.canonical.clone()),&line);
            }
        }
        out.push(item.span,Some(item.canonical.clone()),"return undefined;});");
        self.exit_scope();
        self.owner_handler_body=previous_owner;
        self.query_capture=previous_query;
    }

    fn emit_rent_movement_refund_decision_body(
        &mut self, out: &mut JsWriter, item: &IrItem,
        guards: &[IrStmt], effects: &[IrStmt], decision: &serde_json::Value,
    ) {
        if guards.len()!=2 || effects.len()!=2 {
            self.unsupported("movement-credit refund owner decision",
                "the exact authored body is missing",item.span);
            return;
        }
        let previous_owner=self.owner_handler_body;
        let previous_query=self.query_capture.take();
        self.owner_handler_body=true;
        self.enter_scope();
        let names=["movement","charge_source","amount","reason"].iter()
            .map(|name|format!("{}:{}",object_key(name),self.bind(name)))
            .collect::<Vec<_>>();
        self.stdlib.insert("nativeScenarioRentMovementRefundDecision".into());
        out.push(item.span,Some(item.canonical.clone()),
            &format!("await nativeScenarioRentMovementRefundDecision(c,{},async(c,{{{}}})=>{{",
                descriptor_json(decision),names.join(",")));
        if let IrItemKind::Scenario { by, .. } = &item.kind {
            if !matches!(by.as_slice(), [IrGuard::Role(role)] if role == "rent_reservations.billing") {
                self.unsupported("movement-credit refund owner decision",
                    "the original billing admission is missing", item.span);
                return;
            }
            self.stdlib.insert("check".into());
            self.stdlib.insert("hasRole".into());
            out.push(item.span, Some(item.canonical.clone()),
                "check(await hasRole(c,\"rent_reservations.billing\",c.actor),\"forbidden\");");
        }
        for stmt in guards.iter().chain(effects) {
            for (line,span) in self.lower_stmt(stmt,0) {
                out.push(span,Some(item.canonical.clone()),&line);
            }
        }
        out.push(item.span,Some(item.canonical.clone()),"return undefined;});");
        self.exit_scope();
        self.owner_handler_body=previous_owner;
        self.query_capture=previous_query;
    }

    fn emit_refer_reject_decision_body(
        &mut self, out: &mut JsWriter, item: &IrItem,
        guards: &[IrStmt], effects: &[IrStmt], decision: &serde_json::Value,
    ) {
        if guards.len()!=1 || effects.len()!=3 {
            self.unsupported("referral rejection owner decision",
                "the exact authored body is missing",item.span);
            return;
        }
        let previous_owner=self.owner_handler_body;
        let previous_query=self.query_capture.take();
        self.owner_handler_body=true;
        self.enter_scope();
        let names=["evidence","reason"].iter()
            .map(|name|format!("{}:{}",object_key(name),self.bind(name)))
            .collect::<Vec<_>>();
        self.stdlib.insert("nativeScenarioReferRejectDecision".into());
        out.push(item.span,Some(item.canonical.clone()),
            &format!("await nativeScenarioReferRejectDecision(c,{},async(c,{{{}}})=>{{",
                descriptor_json(decision),names.join(",")));
        if let IrItemKind::Scenario { by, .. } = &item.kind {
            if !matches!(by.as_slice(), [IrGuard::Role(role)] if role == "refer.program_manager") {
                self.unsupported("referral rejection owner decision",
                    "the original role admission is missing", item.span);
                return;
            }
            // State's checked owner lease observes this exact source role at
            // the original pre-query stage. The three-argument form consumes
            // the actor's authenticated subject-role observation.
            self.stdlib.insert("check".into());
            self.stdlib.insert("hasRole".into());
            out.push(item.span, Some(item.canonical.clone()),
                "check(await hasRole(c,\"refer.program_manager\",c.actor),\"forbidden\");");
        }
        for stmt in guards.iter().chain(effects) {
            for (line,span) in self.lower_stmt(stmt,0) {
                out.push(span,Some(item.canonical.clone()),&line);
            }
        }
        out.push(item.span,Some(item.canonical.clone()),"return undefined;});");
        self.exit_scope();
        self.owner_handler_body=previous_owner;
        self.query_capture=previous_query;
    }

    fn emit_invoice_overdue_decision_body(
        &mut self, out: &mut JsWriter, item: &IrItem,
        guards: &[IrStmt], effects: &[IrStmt], decision: &serde_json::Value,
    ) {
        if guards.len()!=1 || effects.len()!=1 {
            self.unsupported("invoice overdue owner decision",
                "the exact authored body is missing",item.span);
            return;
        }
        let previous_owner=self.owner_handler_body;
        let previous_query=self.query_capture.take();
        self.owner_handler_body=true;
        self.enter_scope();
        let event=format!("{}:{}",object_key("event"),self.bind("event"));
        self.stdlib.insert("nativeScenarioInvoiceOverdueDecision".into());
        out.push(item.span,Some(item.canonical.clone()),
            &format!("await nativeScenarioInvoiceOverdueDecision(c,{},async(c,{{{event}}})=>{{",
                descriptor_json(decision)));
        for stmt in guards.iter().chain(effects) {
            for (line,span) in self.lower_stmt(stmt,0) {
                out.push(span,Some(item.canonical.clone()),&line);
            }
        }
        out.push(item.span,Some(item.canonical.clone()),"return undefined;});");
        self.exit_scope();
        self.owner_handler_body=previous_owner;
        self.query_capture=previous_query;
    }

    fn emit_member_retry_decision_body(
        &mut self, out: &mut JsWriter, item: &IrItem,
        guards: &[IrStmt], effects: &[IrStmt], decision: &serde_json::Value,
    ) {
        if guards.len()!=2 || effects.len()!=4 {
            self.unsupported("member retry owner decision",
                "the exact authored body is missing",item.span);
            return;
        }
        let previous_owner=self.owner_handler_body;
        let previous_query=self.query_capture.take();
        self.owner_handler_body=true;
        self.enter_scope();
        let name=format!("{}:{}",object_key("term"),self.bind("term"));
        self.stdlib.insert("nativeScenarioMemberRetryDecision".into());
        out.push(item.span,Some(item.canonical.clone()),
            &format!("await nativeScenarioMemberRetryDecision(c,{},async(c,{{{name}}})=>{{",
                descriptor_json(decision)));
        if let IrItemKind::Scenario{by,..}=&item.kind {
            let admission=self.lower_admission(by);
            out.push(item.span,Some(item.canonical.clone()),&format!("{admission};"));
        }
        for stmt in guards.iter().chain(effects) {
            for (line,span) in self.lower_stmt(stmt,0) {
                out.push(span,Some(item.canonical.clone()),&line);
            }
        }
        out.push(item.span,Some(item.canonical.clone()),"return undefined;});");
        self.exit_scope();
        self.owner_handler_body=previous_owner;
        self.query_capture=previous_query;
    }

    fn emit_leave_decide_decision_body(
        &mut self, out: &mut JsWriter, item: &IrItem,
        guards: &[IrStmt], effects: &[IrStmt], decision: &serde_json::Value,
    ) {
        if guards.len()!=1 || effects.len()!=2 {
            self.unsupported("leave decide owner decision","the exact authored body is missing",item.span);
            return;
        }
        let previous_owner=self.owner_handler_body;
        let previous_query=self.query_capture.take();
        self.owner_handler_body=true;
        self.enter_scope();
        let names=["request","approve","reason"].iter()
            .map(|name|format!("{}:{}",object_key(name),self.bind(name)))
            .collect::<Vec<_>>();
        self.stdlib.insert("nativeScenarioLeaveDecideDecision".into());
        out.push(item.span,Some(item.canonical.clone()),
            &format!("await nativeScenarioLeaveDecideDecision(c,{},async(c,{{{}}})=>{{",
                descriptor_json(decision),names.join(",")));
        for stmt in guards.iter().chain(effects) {
            for (line,span) in self.lower_stmt(stmt,0) {
                out.push(span,Some(item.canonical.clone()),&line);
            }
        }
        out.push(item.span,Some(item.canonical.clone()),"return undefined;});");
        self.exit_scope();
        self.owner_handler_body=previous_owner;
        self.query_capture=previous_query;
    }

    fn emit_leave_request_decision_body(
        &mut self, out: &mut JsWriter, item: &IrItem,
        guards: &[IrStmt], effects: &[IrStmt], decision: &serde_json::Value,
    ) {
        if guards.len()!=3 || effects.len()!=6 {
            self.unsupported("leave request owner decision","the exact authored body is missing",item.span);
            return;
        }
        let previous_owner=self.owner_handler_body;
        let previous_query=self.query_capture.take();
        self.owner_handler_body=true;
        self.enter_scope();
        let names=["calendar","from","until","bucket","reason","reviewer"]
            .iter().map(|name|format!("{}:{}",object_key(name),self.bind(name))).collect::<Vec<_>>();
        self.stdlib.insert("nativeScenarioLeaveRequestDecision".into());
        out.push(item.span,Some(item.canonical.clone()),
            &format!("await nativeScenarioLeaveRequestDecision(c,{},async(c,{{{}}})=>{{",
                descriptor_json(decision),names.join(",")));
        for stmt in guards.iter().chain(effects) {
            for (line,span) in self.lower_stmt(stmt,0) {
                out.push(span,Some(item.canonical.clone()),&line);
            }
        }
        out.push(item.span,Some(item.canonical.clone()),"return undefined;});");
        self.exit_scope();
        self.owner_handler_body=previous_owner;
        self.query_capture=previous_query;
    }

    fn emit_term_decision_body(
        &mut self, out: &mut JsWriter, item: &IrItem,
        guards: &[IrStmt], effects: &[IrStmt], decision: &serde_json::Value,
    ) {
        let [capture_branch,previous_let,previous_require,create_branch] = effects else {
            self.unsupported("term owner decision","the exact authored body is missing",item.span);
            return;
        };
        let previous_owner = self.owner_handler_body;
        let previous_query = self.query_capture.take();
        self.owner_handler_body = true;
        self.enter_scope();
        let membership = self.bind("membership");
        let cycle = self.bind("cycle");
        let capture = self.bind("capture");
        self.stdlib.insert("nativeScenarioTermDecision".into());
        out.push(item.span,Some(item.canonical.clone()),
            &format!("const $termPrevious=await nativeScenarioTermDecision(c,{},async(c,{{membership:{membership},cycle:{cycle},capture:{capture}}})=>{{",
                descriptor_json(decision)));
        // This exact admitted decision owns and observes its whole original
        // prefix over private State-issued views. A second source Require
        // frame would incorrectly treat those views as public input slots.
        let source_requires = std::mem::take(&mut self.source_requires);
        for guard in guards {
            for (line,span) in self.lower_stmt(guard,0) {
                out.push(span,Some(item.canonical.clone()),&line);
            }
        }
        for effect in [capture_branch,previous_let,previous_require] {
            for (line,span) in self.lower_stmt(effect,0) {
                out.push(span,Some(item.canonical.clone()),&line);
            }
        }
        let selected = self.reference("previous");
        out.push(item.span,Some(item.canonical.clone()),&format!("return {selected};}});"));
        self.exit_scope();
        self.source_requires = source_requires;
        self.owner_handler_body = previous_owner;
        self.query_capture = previous_query;
        let previous = self.bind("previous");
        out.push(item.span,Some(item.canonical.clone()),
            &format!("const {previous}=$termPrevious;"));
        for (line,span) in self.lower_stmt(create_branch,0) {
            out.push(span,Some(item.canonical.clone()),&line);
        }
    }

    fn emit_handler_fns(&mut self, out: &mut JsWriter) {
        let ir = self.ir;
        for item in &ir.items {
            match &item.kind {
                IrItemKind::Scenario {
                    params,
                    trusted,
                    read,
                    scope_authority,
                    hook,
                    cohort,
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
                    if self.ir.standard_completion_sources.is_private_terminal_candidate()
                        && !self.private_terminal_ready
                        && matches!(&item.kind, IrItemKind::Scenario {event_source:Some(IrEventSource::StandardCompleted {..}),..}) {
                        out.push(item.span, Some(item.canonical.clone()),
                            &format!("async {handler}(){{throw new Error(\"unprepared standard terminal source\");}},"));
                        continue;
                    }
                    self.enter_scope();
                    let observes_defaults = !*trusted
                        && !*read
                        && params
                            .iter()
                            .any(|id| self.scenario_computed_default_supported(*id));
                    let mut default_observer = None;
                    let signature = if *trusted {
                        // The private input gate admits PaymentState through
                        // its named value carrier. The authored changed event
                        // is the nominal itself, unlike Mailbox's {value}
                        // event. Unwrap only this checked provider source.
                        let event = self.bind("event");
                        let event = if matches!(&item.kind, IrItemKind::Scenario {
                            event_source: Some(IrEventSource::PaymentsChanged { .. }), ..
                        }) { format!("{{value:{event}}}") } else { event };
                        let mut bindings = vec![format!("event:{event}")];
                        if let Some(bind) = cohort.as_ref().and_then(|cohort| cohort.bind.as_ref())
                        {
                            bindings.push(format!("{}:{}", object_key(bind), self.bind(bind)));
                        }
                        format!("c,{{{}}}", bindings.join(","))
                    } else {
                        let names: Vec<String> = params
                            .iter()
                            .map(|id| {
                                let name = self.ir.items[id.0 as usize].name.clone();
                                format!("{}:{}", object_key(&name), self.bind(&name))
                            })
                            .collect();
                        let signature = format!("c,{{{}}}", names.join(","));
                        if observes_defaults {
                            let observer = self.bind("$resolvedDefault");
                            default_observer = Some(observer.clone());
                            format!("{signature},{observer}")
                        } else {
                            signature
                        }
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
                    // Family E: an authority report lowers its real body
                    // for decision-mode evaluation at the host boundary
                    // (DESIGN §442: helpers keep decision mode only when
                    // consumed by the decision). The checked
                    // `scope_authority` fact selects this; nothing is
                    // re-derived here. Query authority, bounds and
                    // recursion-freedom come from the host decision
                    // boundary, never from emitted syntax (§13), so body
                    // queries keep their ordinary shape. `E6008` stays
                    // until the host seam adopts the boundary.
                    let previous_authority_body =
                        std::mem::replace(&mut self.authority_body, *scope_authority);
                    self.receipt_calls.clear();
                    self.current_revision_binding = None;
                    self.receipt_capture = self.native_receipts.get(&item.id).filter(|recipe| recipe.plan.retained_guarded_handler.is_none()).cloned();
                    // Source inventories remain useful for declined scenarios,
                    // but only a published, whole-owner receipt can enter the
                    // owning query lifetime. Dev dispatches the actual public
                    // viewer lifetime or private child State frame.
                    self.query_capture = self.admitted_query_source(item.id);
                    self.owner_handler_body = self.receipt_capture.is_none() && self.owner_handlers.contains(&item.id);
                    // Generic retained handlers use the host's complete owner
                    // session, independently of closed public receipt profiles.
                    // Their shared derives must not borrow another owner's
                    // invoice collection/issue query markers.
                    self.retained_owner_body = self.owner_handler_body;
                    self.receipt_call_sites = self
                        .native_call_sites
                        .get(&item.id)
                        .cloned()
                        .unwrap_or_default();
                    out.push(
                        item.span,
                        Some(item.canonical.clone()),
                        &format!("async {handler}({signature}){{"),
                    );
                    if self.receipt_capture.is_some() {
                        out.push(
                            item.span,
                            Some(item.canonical.clone()),
                            "const $receiptChoices=new Map();",
                        );
                    }
                    // This source-stamped owner decision observes its original
                    // role admission inside the same serial lease as the
                    // header, query and effects. Other scenarios keep their
                    // existing pre-body admission stage.
                    if !((item.canonical == "refer.reject_source"
                        && self.receipt_capture.as_ref().is_some_and(|receipt|
                            receipt.plan.refer_reject_decision.is_some()))
                        || (item.canonical == "member_terms.retry_collection"
                        && self.receipt_capture.as_ref().is_some_and(|receipt|
                            receipt.plan.member_retry_decision.is_some()))
                        || (item.canonical == "invoice.collect"
                            && self.receipt_capture.as_ref().is_some_and(|receipt|
                            receipt.plan.invoice_collect_decision.is_some()))) {
                        self.emit_admission_check(out, by, item.span);
                    }
                    self.emit_scenario_param_defaults(out, item, trusted, params, &default_observer);
                    self.viewer_read_body = *read && !*trusted && !*scope_authority;
                    self.emit_scenario_body_stmts(out, item, guards, effects);
                    if let Some(selection) = self.receipt_return_selection(item.span, true, false) {
                        out.push(
                            item.span,
                            Some(item.canonical.clone()),
                            &format!("{{{selection}}}"),
                        );
                    }
                    self.owner_handler_body = false;
                    self.retained_owner_body = false;
                    self.viewer_read_body = false;
                    self.receipt_capture = None;
                    self.current_revision_binding = None;
                    self.query_capture = None;
                    self.receipt_call_sites.clear();
                    self.receipt_calls.clear();
                    self.authority_body = previous_authority_body;
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
                } => self.emit_crud_op_handler(
                    out, item, model, op, by, *has_when, delete_mode,
                ),
                IrItemKind::DeriveFn { .. } => {
                    if self.private_derives.contains(&item.canonical) { continue; }
                    let name = binding_ident("s", &item.canonical);
                    self.callables.push(JsCallable {
                        id: item.canonical.clone(),
                        kind: JsCallableKind::Pure,
                        export: name.clone(),
                        member: registry_member(self.ir, item),
                        input_style: None,
                        source: self.declaration_source(item.span),
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
        let mut emitter = Emitter::new(self.ir);
        emitter.source_paths = self.source_paths.clone();
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
        let path = module_path(&module_data.name);
        out.try_finish(path.clone()).unwrap_or_else(|error| {
            self.diags.push(error);
            JsModule {
                path,
                js: String::new(),
                lines: Vec::new(),
            }
        })
    }
}

/// Omission must survive native admission before a handler can fill a default.
fn scenario_default_omission_supported(ty: &IrType) -> bool {
    let IrType::Known(base) = ty else {
        return false;
    };
    let mut base = base;
    if let ResolvedType::Nullable(inner) = base {
        base = inner.as_ref();
    }
    let mut ordinary_array = true;
    if let ResolvedType::Array {
        element, nonempty, ..
    } = base
    {
        ordinary_array = !nonempty;
        base = element.as_ref();
    }
    // Only joined native input domains carry the checked omission claim.
    // Element nullability, nested arrays and collapsed aliases remain unqualified.
    if matches!(base, ResolvedType::Enum { .. }) {
        return ordinary_array;
    }
    matches!(
        base,
        ResolvedType::Scalar(
            Scalar::Bool
                | Scalar::Int
                | Scalar::Decimal
                | Scalar::Text
                | Scalar::Date
                | Scalar::Datetime
                | Scalar::Duration
                | Scalar::Money
                | Scalar::Currency
                | Scalar::User
        )
    )
}

/// Closed checked scalar result profile; other shapes stay unknown.
fn checked_scenario_result(result: Option<&ResolvedType>) -> Option<Cow<'static, str>> {
    // Only successful checked Scenario signatures establish no result.
    let Some(result) = result else {
        return Some(Cow::Borrowed("void"));
    };
    checked_value_profile(result).map(Cow::Borrowed)
}

/// The released File consumer carries field-only omission in its array type ID.
/// Ordinary value/return types and other element profiles retain their spelling.
fn required_file_array_value_type(
    value_type: Option<String>,
    required_array: bool,
) -> Option<String> {
    value_type.map(|value_type| {
        if required_array && value_type == "file[]" {
            "file[]!".to_string()
        } else {
            value_type
        }
    })
}

/// Operation enum claims name the ordered checked cases and their supported
/// wrappers explicitly; other inputs retain their existing scalar claims.
fn checked_operation_input_value_type(ty: &IrType) -> Option<String> {
    let IrType::Known(resolved) = ty else {
        return None;
    };
    checked_enum_value_type(resolved).or_else(|| checked_string_value_type(ty).map(str::to_string))
}

/// Shared enum identity for public checked inputs and admitted enum results.
fn checked_enum_value_type(resolved: &ResolvedType) -> Option<String> {
    let (base, nullable) = match resolved {
        ResolvedType::Nullable(inner) => (inner.as_ref(), true),
        base => (base, false),
    };
    let (base, array) = match base {
        ResolvedType::Array { element, .. } => (element.as_ref(), true),
        base => (base, false),
    };
    if let ResolvedType::Enum { cases, .. } = base {
        return Some(format!(
            "enum({}){}{}",
            cases.join(","),
            if array { "[]" } else { "" },
            if nullable { "?" } else { "" },
        ));
    }
    None
}

fn checked_string_value_type(ty: &IrType) -> Option<&'static str> {
    let IrType::Known(ty) = ty else {
        return None;
    };
    checked_value_profile(ty).filter(|value| {
        matches!(
            *value,
            "text"
                | "text?"
                | "text[]"
                | "text[]?"
                | "date"
                | "date?"
                | "date[]"
                | "date[]?"
                | "currency"
                | "currency?"
                | "currency[]"
                | "currency[]?"
                | "timezone"
                | "timezone?"
                | "timezone[]"
                | "timezone[]?"
                | "file"
                | "file?"
                | "file[]"
                | "file[]?"
        )
    })
}

fn numeric_scalar_profile(scalar: &Scalar, array: bool, nullable: bool) -> Option<&'static str> {
    match (scalar, array, nullable) {
        (Scalar::Int, false, false) => Some("int"),
        (Scalar::Int, false, true) => Some("int?"),
        (Scalar::Int, true, false) => Some("int[]"),
        (Scalar::Int, true, true) => Some("int[]?"),
        (Scalar::Decimal, false, false) => Some("decimal"),
        (Scalar::Decimal, false, true) => Some("decimal?"),
        (Scalar::Decimal, true, false) => Some("decimal[]"),
        (Scalar::Decimal, true, true) => Some("decimal[]?"),
        (Scalar::Money, false, false) => Some("money"),
        (Scalar::Money, false, true) => Some("money?"),
        (Scalar::Money, true, false) => Some("money[]"),
        (Scalar::Money, true, true) => Some("money[]?"),
        _ => None,
    }
}

fn text_scalar_profile(scalar: &Scalar, array: bool, nullable: bool) -> Option<&'static str> {
    match (scalar, array, nullable) {
        (Scalar::Url, false, false) => Some("url"),
        (Scalar::Url, false, true) => Some("url?"),
        (Scalar::Url, true, false) => Some("url[]"),
        (Scalar::Url, true, true) => Some("url[]?"),
        (Scalar::Text, false, false) => Some("text"),
        (Scalar::Text, false, true) => Some("text?"),
        (Scalar::Text, true, false) => Some("text[]"),
        (Scalar::Text, true, true) => Some("text[]?"),
        _ => None,
    }
}

fn flag_scalar_profile(scalar: &Scalar, array: bool, nullable: bool) -> Option<&'static str> {
    match (scalar, array, nullable) {
        (Scalar::Bool, false, false) => Some("bool"),
        (Scalar::Bool, false, true) => Some("bool?"),
        (Scalar::Bool, true, false) => Some("bool[]"),
        (Scalar::Bool, true, true) => Some("bool[]?"),
        (Scalar::Email, false, false) => Some("email"),
        (Scalar::Email, false, true) => Some("email?"),
        (Scalar::Email, true, false) => Some("email[]"),
        (Scalar::Email, true, true) => Some("email[]?"),
        _ => None,
    }
}

fn temporal_scalar_profile(scalar: &Scalar, array: bool, nullable: bool) -> Option<&'static str> {
    match (scalar, array, nullable) {
        (Scalar::Datetime, false, false) => Some("datetime"),
        (Scalar::Datetime, false, true) => Some("datetime?"),
        (Scalar::Datetime, true, false) => Some("datetime[]"),
        (Scalar::Datetime, true, true) => Some("datetime[]?"),
        (Scalar::Date, false, false) => Some("date"),
        (Scalar::Date, false, true) => Some("date?"),
        (Scalar::Date, true, false) => Some("date[]"),
        (Scalar::Date, true, true) => Some("date[]?"),
        (Scalar::Duration, false, false) => Some("duration"),
        (Scalar::Duration, false, true) => Some("duration?"),
        (Scalar::Duration, true, false) => Some("duration[]"),
        (Scalar::Duration, true, true) => Some("duration[]?"),
        (Scalar::Timezone, false, false) => Some("timezone"),
        (Scalar::Timezone, false, true) => Some("timezone?"),
        (Scalar::Timezone, true, false) => Some("timezone[]"),
        (Scalar::Timezone, true, true) => Some("timezone[]?"),
        _ => None,
    }
}

fn entity_scalar_profile(scalar: &Scalar, array: bool, nullable: bool) -> Option<&'static str> {
    match (scalar, array, nullable) {
        (Scalar::Currency, false, false) => Some("currency"),
        (Scalar::Currency, false, true) => Some("currency?"),
        (Scalar::Currency, true, false) => Some("currency[]"),
        (Scalar::Currency, true, true) => Some("currency[]?"),
        (Scalar::User, false, false) => Some("user"),
        (Scalar::User, false, true) => Some("user?"),
        (Scalar::User, true, false) => Some("user[]"),
        (Scalar::User, true, true) => Some("user[]?"),
        (Scalar::File, false, false) => Some("file"),
        (Scalar::File, false, true) => Some("file?"),
        (Scalar::File, true, false) => Some("file[]"),
        (Scalar::File, true, true) => Some("file[]?"),
        _ => None,
    }
}

pub(super) fn checked_value_profile(result: &ResolvedType) -> Option<&'static str> {
    let (value, nullable) = match result {
        ResolvedType::Nullable(value) => (value.as_ref(), true),
        value => (value, false),
    };
    let (scalar, array) = match value {
        ResolvedType::Array { element, .. } => (element.as_ref(), true),
        value => (value, false),
    };
    let ResolvedType::Scalar(scalar) = scalar else {
        return None;
    };
    numeric_scalar_profile(scalar, array, nullable)
        .or_else(|| text_scalar_profile(scalar, array, nullable))
        .or_else(|| flag_scalar_profile(scalar, array, nullable))
        .or_else(|| temporal_scalar_profile(scalar, array, nullable))
        .or_else(|| entity_scalar_profile(scalar, array, nullable))
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

