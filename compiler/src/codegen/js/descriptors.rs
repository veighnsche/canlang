//! Artifact descriptor shapes and their canonical wire serialization.
//!
//! Inputs are already checked IR, types and catalog facts. Source admission
//! and stateful JavaScript emission remain with their owning collectors.

use crate::analysis::catalog::{StdOperation, nominal_schema, std_capability};
use crate::analysis::types::{ResolvedType, Scalar, canonical_datetime_literal};
use crate::codegen::ir::{
    IrCallTarget, IrChoiceValue, IrDefault, IrExpr, IrInputChoiceBinding, IrServer,
    IrUnOp, TypedExpr,
};
use crate::source::Span;
use serde::ser::{SerializeMap, SerializeStruct};
use serde::{Serialize, Serializer};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn descriptor_json(value: &(impl Serialize + ?Sized)) -> String {
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

    pub(super) fn schema_json(&self) -> String {
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
pub(super) fn is_random_secret_call(expr: &TypedExpr) -> bool {
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
pub(super) enum WireLiteral {
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

pub(super) fn wire_literal(expr: &TypedExpr) -> Option<WireLiteral> {
    if let Some(value) = crate::codegen::defaults::money_default_wire(expr) {
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
pub(super) fn has_duplicate_names(inputs: &[JsOperationField]) -> bool {
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

