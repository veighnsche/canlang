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
//! identity and `equalValue(c, canonicalTypeId, a, b)` structural equality.
//! Guards lower `by` to `check(hasRole(...), 'forbidden')`; effects lower
//! `deleteRecord` modes, bound `send`, `schedule` with `on:{every}` and
//! CRUD `create`/`set` with `when`.

use crate::analysis::resolve::{CrudOp, ModuleKind};
use crate::analysis::types::{ResolvedType, Scalar};
use crate::codegen::ir::{
    IrBinOp, IrCallTarget, IrDefault, IrExpr, IrFieldLabel, IrGuard, IrItem, IrItemKind, IrMessage,
    IrOwner, IrPage, IrProgram, IrServer, IrStmt, IrType, IrUi, IrUnOp, ReferencedBuiltin,
    ScalarFamily, TypedExpr, expr_uses_async, is_structural, scalar_family,
};
use crate::diagnostic::Diagnostic;
use crate::source::Span;
use std::collections::{BTreeMap, BTreeSet, HashMap};

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
    Boolean,
    File,
    /// Anonymous enum: case spellings in declaration order.
    Enum {
        values: Vec<String>,
    },
}

impl JsMcpField {
    /// Compact JSON per `artifact.ts` `ArtifactOperationField`.
    pub fn to_json(&self) -> String {
        match self {
            JsMcpField::Ref {
                model,
                require_version,
            } => format!(
                "{{\"kind\":\"ref\",\"model\":{},\"requireVersion\":{}}}",
                js_string(model),
                require_version
            ),
            JsMcpField::String => "{\"kind\":\"string\"}".to_string(),
            JsMcpField::Integer => "{\"kind\":\"integer\"}".to_string(),
            JsMcpField::Decimal => "{\"kind\":\"decimal\"}".to_string(),
            JsMcpField::Money => "{\"kind\":\"money\"}".to_string(),
            JsMcpField::Datetime => "{\"kind\":\"datetime\"}".to_string(),
            JsMcpField::Boolean => "{\"kind\":\"boolean\"}".to_string(),
            JsMcpField::File => "{\"kind\":\"file\"}".to_string(),
            JsMcpField::Enum { values } => format!(
                "{{\"kind\":\"enum\",\"values\":[{}]}}",
                values
                    .iter()
                    .map(|v| js_string(v))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
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
    /// Engine-resolved server initializer (any `server=` spelling).
    Server,
    /// Derived value marker (derived fields only; T18 executes).
    Derived,
}

impl JsFieldDefault {
    /// Compact JSON per `artifact.ts` `ArtifactFieldDefault`.
    pub fn to_json(&self) -> String {
        match self {
            JsFieldDefault::Literal(json) => format!("{{\"kind\":\"literal\",\"value\":{json}}}"),
            JsFieldDefault::Parent { path } => {
                format!("{{\"kind\":\"parent\",\"path\":{}}}", js_string(path))
            }
            JsFieldDefault::Server => "{\"kind\":\"server\"}".to_string(),
            JsFieldDefault::Derived => "{\"kind\":\"derived\"}".to_string(),
        }
    }
}

/// Map one field/parameter default plus server initializer to its
/// descriptor form, or `None` when the default has no T04a vocabulary.
///
/// `server=` (any spelling) wins as `{kind:"server"}` and literal
/// defaults encode via [`literal_json`]; computed defaults map only
/// when they are a parent path ([`parent_path`]). Any other computed
/// default (a non-parent expression) maps to `None`: the caller keeps
/// `required: false` and the emitted `default(c)` callable preserves
/// execution — T04b grows the vocabulary. Total and diagnostic-free:
/// descriptors never fail compilation.
pub fn js_field_default(
    default: Option<&IrDefault>,
    server: Option<&IrServer>,
) -> Option<JsFieldDefault> {
    if server.is_some() {
        return Some(JsFieldDefault::Server);
    }
    match default {
        None => None,
        Some(IrDefault::Literal(value)) => literal_json(value).map(JsFieldDefault::Literal),
        Some(IrDefault::Computed { expr, .. }) => parent_path(expr).map(|path| JsFieldDefault::Parent {
            path,
        }),
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
    match &expr.expr {
        IrExpr::Int(value) => Some(js_string(&value.to_string())),
        IrExpr::Decimal(spelling) => Some(js_string(spelling)),
        IrExpr::Text(value) => Some(js_string(value)),
        IrExpr::Bool(value) => Some(value.to_string()),
        IrExpr::Null => Some("null".to_string()),
        IrExpr::Money { minor, currency } => Some(format!(
            "{{\"minor\":{},\"currency\":{}}}",
            js_string(&minor.to_string()),
            js_string(currency)
        )),
        IrExpr::DurationMs(ms) => Some(js_string(&ms.to_string())),
        IrExpr::Date(value) | IrExpr::Datetime(value) => Some(js_string(value)),
        IrExpr::Array(items) => {
            let mut parts = Vec::with_capacity(items.len());
            for item in items {
                parts.push(literal_json(item)?);
            }
            Some(format!("[{}]", parts.join(",")))
        }
        IrExpr::Object(entries) => {
            let mut parts = Vec::with_capacity(entries.len());
            for (key, value) in entries {
                parts.push(format!("{}:{}", js_string(key), literal_json(value)?));
            }
            Some(format!("{{{}}}", parts.join(",")))
        }
        IrExpr::Unary { op, operand } if *op == IrUnOp::Neg => match &operand.expr {
            IrExpr::Int(value) => Some(js_string(&value.checked_neg()?.to_string())),
            IrExpr::Decimal(spelling) => Some(js_string(&format!("-{spelling}"))),
            _ => None,
        },
        IrExpr::Call { target, args } => {
            let id = match target {
                IrCallTarget::Builtin { id, .. } => id.as_str(),
                IrCallTarget::CapabilityOp(_) => return None,
            };
            match (id, args.as_slice()) {
                ("money", [minor, currency])
                    if matches!(minor.expr, IrExpr::Int(_))
                        && matches!(currency.expr, IrExpr::Text(_)) =>
                {
                    let (IrExpr::Int(m), IrExpr::Text(c)) = (&minor.expr, &currency.expr) else {
                        return None;
                    };
                    Some(format!(
                        "{{\"minor\":{},\"currency\":{}}}",
                        js_string(&m.to_string()),
                        js_string(c)
                    ))
                }
                ("date" | "datetime", [single]) if matches!(single.expr, IrExpr::Text(_)) => {
                    let IrExpr::Text(value) = &single.expr else {
                        return None;
                    };
                    Some(js_string(value))
                }
                _ => None,
            }
        }
        _ => None,
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
    /// Compact JSON per `artifact.ts` `ArtifactOperationInput`. The
    /// `nullable`/`array`/`default`/`description` members render only
    /// when meaningful (additive: singular non-nullable default-less
    /// undescribed inputs are byte-identical to P1/D03).
    pub fn to_json(&self) -> String {
        let mut out = format!(
            "{{\"name\":{},\"field\":{},\"required\":{}",
            js_string(&self.name),
            self.field.to_json(),
            self.required
        );
        if self.nullable {
            out.push_str(",\"nullable\":true");
        }
        if let Some(required) = self.array_required {
            out.push_str(&format!(",\"array\":{{\"required\":{required}}}"));
        }
        if let Some(default) = &self.default {
            out.push_str(",\"default\":");
            out.push_str(&default.to_json());
        }
        if let Some(description) = &self.description {
            out.push_str(",\"description\":");
            out.push_str(&js_string(description));
        }
        out.push('}');
        out
    }
}

/// One user-invocable operation descriptor (JSON shape of
/// `OperationDescriptor`: `{name, kind, description, inputs}`).
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
}

impl JsOperation {
    /// Compact JSON per `artifact.ts` `ArtifactOperation`.
    pub fn to_json(&self) -> String {
        format!(
            "{{\"name\":{},\"kind\":\"{}\",\"description\":{},\"inputs\":{{\"fields\":[{}]}}}}",
            js_string(&self.name),
            self.kind.as_str(),
            js_string(&self.description),
            self.inputs
                .iter()
                .map(JsOperationField::to_json)
                .collect::<Vec<_>>()
                .join(",")
        )
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
    format!(
        "[{}]",
        operations
            .iter()
            .map(JsOperation::to_json)
            .collect::<Vec<_>>()
            .join(",")
    )
}

/// One stored-model field type tag (JSON shape of `ArtifactModelFieldType`).
///
/// The `Ref`/scalar/`Enum` members mirror [`JsMcpField`] (minus
/// `require_version`, meaningless for stored rows); the `Date`..`Bytes`
/// members are additive T04b-preview tags and `Other` is the honest
/// fallback for delivery/action/union/contract and unknown shapes.
/// T15b (provider join) refines `Other` delivery shapes here — never in
/// a second format.
#[derive(Debug, Clone)]
pub enum JsModelFieldType {
    /// Stored-record reference: canonical target model.
    Ref { model: String },
    String,
    Integer,
    Decimal,
    Money,
    Datetime,
    Boolean,
    File,
    /// Anonymous enum: case spellings in declaration order.
    Enum { values: Vec<String> },
    /// T04b-preview additive tags (source-exact; T04a intake ignores).
    Date,
    Duration,
    Secret,
    User,
    Member,
    Json,
    Bytes,
    /// Honest fallback: `type_id` is the source type id.
    Other { type_id: String },
}

impl JsModelFieldType {
    /// Compact JSON per `artifact.ts` `ArtifactModelFieldType`.
    pub fn to_json(&self) -> String {
        match self {
            JsModelFieldType::Ref { model } => {
                format!("{{\"kind\":\"ref\",\"model\":{}}}", js_string(model))
            }
            JsModelFieldType::String => "{\"kind\":\"string\"}".to_string(),
            JsModelFieldType::Integer => "{\"kind\":\"integer\"}".to_string(),
            JsModelFieldType::Decimal => "{\"kind\":\"decimal\"}".to_string(),
            JsModelFieldType::Money => "{\"kind\":\"money\"}".to_string(),
            JsModelFieldType::Datetime => "{\"kind\":\"datetime\"}".to_string(),
            JsModelFieldType::Boolean => "{\"kind\":\"boolean\"}".to_string(),
            JsModelFieldType::File => "{\"kind\":\"file\"}".to_string(),
            JsModelFieldType::Enum { values } => format!(
                "{{\"kind\":\"enum\",\"values\":[{}]}}",
                values
                    .iter()
                    .map(|v| js_string(v))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            JsModelFieldType::Date => "{\"kind\":\"date\"}".to_string(),
            JsModelFieldType::Duration => "{\"kind\":\"duration\"}".to_string(),
            JsModelFieldType::Secret => "{\"kind\":\"secret\"}".to_string(),
            JsModelFieldType::User => "{\"kind\":\"user\"}".to_string(),
            JsModelFieldType::Member => "{\"kind\":\"member\"}".to_string(),
            JsModelFieldType::Json => "{\"kind\":\"json\"}".to_string(),
            JsModelFieldType::Bytes => "{\"kind\":\"bytes\"}".to_string(),
            JsModelFieldType::Other { type_id } => format!(
                "{{\"kind\":\"other\",\"type\":{}}}",
                js_string(type_id)
            ),
        }
    }
}

/// One stored (or derived) model field (JSON shape of `ArtifactModelField`).
#[derive(Debug, Clone)]
pub struct JsModelField {
    /// Field name (model-local).
    pub name: String,
    /// Element type tag (arrays add the `array` marker).
    pub field: JsModelFieldType,
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
    /// Checked description source text, when authored.
    pub description: Option<String>,
}

impl JsModelField {
    /// Compact JSON per `artifact.ts` `ArtifactModelField`. `required`
    /// and `serverOnly` always render (L3-mirrored); `nullable`/`array`/
    /// `default`/`description` render only when meaningful.
    pub fn to_json(&self) -> String {
        let mut out = format!(
            "{{\"name\":{},\"field\":{},\"required\":{},\"serverOnly\":{}",
            js_string(&self.name),
            self.field.to_json(),
            self.required,
            self.server_only
        );
        if self.nullable {
            out.push_str(",\"nullable\":true");
        }
        if let Some(required) = self.array_required {
            out.push_str(&format!(",\"array\":{{\"required\":{required}}}"));
        }
        if let Some(default) = &self.default {
            out.push_str(",\"default\":");
            out.push_str(&default.to_json());
        }
        if let Some(description) = &self.description {
            out.push_str(",\"description\":");
            out.push_str(&js_string(description));
        }
        out.push('}');
        out
    }
}

/// One stored model descriptor (JSON shape of `ArtifactModel`).
#[derive(Debug, Clone)]
pub struct JsModel {
    /// Canonical model identity.
    pub name: String,
    /// Stored then derived fields in source order.
    pub fields: Vec<JsModelField>,
    /// What a caller-asked remove does: `archive` (default), `remove`
    /// (declared) or `none` (no enabled delete operation).
    pub delete_mode: String,
    /// Unique keys in source order (empty omits the member).
    pub unique_keys: Vec<String>,
    /// Canonical parent model, for `in Parent` children.
    pub parent: Option<String>,
    /// Whether the model is app-scoped (`in app`).
    pub scope_app: bool,
}

impl JsModel {
    /// Compact JSON per `artifact.ts` `ArtifactModel`.
    pub fn to_json(&self) -> String {
        let mut out = format!(
            "{{\"name\":{},\"fields\":[{}],\"deleteMode\":{}",
            js_string(&self.name),
            self.fields
                .iter()
                .map(JsModelField::to_json)
                .collect::<Vec<_>>()
                .join(","),
            js_string(&self.delete_mode)
        );
        if !self.unique_keys.is_empty() {
            out.push_str(&format!(
                ",\"uniqueKeys\":[{}]",
                self.unique_keys
                    .iter()
                    .map(|k| js_string(k))
                    .collect::<Vec<_>>()
                    .join(",")
            ));
        }
        if let Some(parent) = &self.parent {
            out.push_str(",\"parent\":");
            out.push_str(&js_string(parent));
        }
        if self.scope_app {
            out.push_str(",\"scope\":\"app\"");
        }
        out.push('}');
        out
    }
}

/// Compact JSON array of model descriptors, rendered only by the artifact
/// envelope (the runtime reads the richer `appDefinition.models` member;
/// descriptors stay one format).
pub fn models_json(models: &[JsModel]) -> String {
    format!(
        "[{}]",
        models
            .iter()
            .map(JsModel::to_json)
            .collect::<Vec<_>>()
            .join(",")
    )
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

/// Output path for a module: lowercase `<name>.mjs`.
fn module_path(name: &str) -> String {
    format!("{}.mjs", name.to_lowercase())
}

/// Sanitize a Can name into a JS identifier (Can names are already
/// identifier-safe; anything else becomes `_`, with a leading digit fixed).
fn sanitize_ident(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for (i, c) in name.chars().enumerate() {
        let ok = c.is_ascii_alphanumeric() || c == '_' || c == '$';
        if i == 0 && c.is_ascii_digit() {
            out.push('_');
        }
        out.push(if ok { c } else { '_' });
    }
    if out.is_empty() {
        out.push('_');
    }
    out
}

/// Render a JS double-quoted string literal with minimal escapes.
fn js_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
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
            | "content"
            | "copy"
            | "details"
            | "divider"
            | "edit"
            | "form"
            | "history"
            | "input"
            | "join"
            | "list"
            | "metrics"
            | "modal"
            | "pagination"
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
        Self {
            ir,
            by_canonical,
            stdlib: BTreeSet::new(),
            ui: BTreeSet::new(),
            relative: BTreeMap::new(),
            diags: Vec::new(),
            builtins: Vec::new(),
            callables: Vec::new(),
            pages: Vec::new(),
        }
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
                names.join(", ")
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
            ResolvedType::Invocation { .. } => {
                self.unsupported("type", "invocation values have no §13 type id", span);
                self.throw_expr("invocation type id")
            }
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
    /// identity and `equalValue(c, canonicalTypeId, a, b)` structural
    /// equality. Unlowerable combinations are `E6008` plus a throwing
    /// placeholder.
    pub fn lower_expr(&mut self, expr: &TypedExpr) -> String {
        let span = expr.span;
        match &expr.expr {
            IrExpr::Int(value) => format!("{value}n"),
            IrExpr::Decimal(_) => {
                self.unsupported(
                    "decimal literal",
                    "no §13 lowering and no catalog constructor exist",
                    span,
                );
                self.throw_expr("decimal literal has no lowering")
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
            IrExpr::Name(name) => sanitize_ident(name),
            IrExpr::Member { base, field } => {
                let base_text = self.lower_expr(base);
                let base_text = parenthesize_operand(&base_text, &base.expr);
                // Nullable bases use optional chaining (delivery reads
                // resolve to one immutable object or null).
                let op = if matches!(base.ty, ResolvedType::Nullable(_)) {
                    "?."
                } else {
                    "."
                };
                format!("{base_text}{op}{}", sanitize_ident(field))
            }
            IrExpr::Call { target, args } => self.lower_call(target, args, span),
            IrExpr::Binary { op, left, right } => self.lower_binary(*op, left, right, span),
            IrExpr::Unary { op, operand } => self.lower_unary(*op, operand, span),
            IrExpr::Array(items) => {
                let parts: Vec<String> = items.iter().map(|i| self.lower_expr(i)).collect();
                format!("[{}]", parts.join(","))
            }
            IrExpr::Object(entries) => {
                let parts: Vec<String> = entries
                    .iter()
                    .map(|(k, v)| {
                        // Shorthand when the value is the key's own
                        // binding (`{meeting}`, per the oracle corpus).
                        let shorthand = object_key(k) == *k
                            && matches!(&v.expr, IrExpr::Name(name) if name == k);
                        if shorthand {
                            sanitize_ident(k)
                        } else {
                            format!("{}:{}", object_key(k), self.lower_expr(v))
                        }
                    })
                    .collect();
                format!("{{{}}}", parts.join(","))
            }
            IrExpr::Query(query) => self.lower_query(query, span),
            IrExpr::DeliveryRead {
                record,
                field,
                props,
            } => {
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
            IrExpr::Format { descriptor, locale } => {
                self.stdlib.insert("format".to_string());
                let descriptor_text = self.lower_expr(descriptor);
                let locale_text = match locale {
                    Some(tag) => js_string(tag),
                    None => "null".to_string(),
                };
                format!("format(c,{descriptor_text},{{locale:{locale_text}}})")
            }
            IrExpr::HasRole { role, person } => {
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
                let body_text = self.lower_expr(body);
                if expr_uses_async(body) {
                    format!("async({})=>{body_text}", sanitize_ident(param))
                } else {
                    format!("({})=>{body_text}", sanitize_ident(param))
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
    /// from their owning package module as `await op(c, ...)`. `trim/1`
    /// lowers to the `<arg>.trim()` method per the oracle corpus.
    fn lower_call(&mut self, target: &IrCallTarget, args: &[TypedExpr], span: Span) -> String {
        match target {
            IrCallTarget::Builtin { id, awaited } => {
                // `trim(value)` is the one method-shaped builtin in the
                // oracle corpus (`x.trim()`); every other builtin is a
                // plain function call.
                if id == "trim" && args.len() == 1 {
                    let arg = self.lower_expr(&args[0]);
                    return format!("{}.trim()", parenthesize_operand(&arg, &args[0].expr));
                }
                self.stdlib.insert(id.clone());
                self.builtins.push(ReferencedBuiltin {
                    id: id.clone(),
                    span,
                });
                let parts: Vec<String> = args.iter().map(|a| self.lower_expr(a)).collect();
                let call = format!("{}({})", sanitize_ident(id), parts.join(","));
                if *awaited {
                    format!("await {call}")
                } else {
                    call
                }
            }
            IrCallTarget::CapabilityOp(canonical) => {
                let (local, module) = match self.by_canonical.get(canonical) {
                    Some(index) => {
                        let item = &self.ir.items[*index];
                        (item.name.clone(), self.ir.module(item.module).name.clone())
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
                self.relative
                    .entry(path)
                    .or_default()
                    .insert(sanitize_ident(&local));
                let parts: Vec<String> = args.iter().map(|a| self.lower_expr(a)).collect();
                let mut all = vec!["c".to_string()];
                all.extend(parts);
                format!("await {}({})", sanitize_ident(&local), all.join(","))
            }
        }
    }

    /// Lower a binary operator by checked operand families.
    fn lower_binary(
        &mut self,
        op: IrBinOp,
        left: &TypedExpr,
        right: &TypedExpr,
        span: Span,
    ) -> String {
        match op {
            IrBinOp::And | IrBinOp::Or => {
                let js_op = if op == IrBinOp::And { "&&" } else { "||" };
                let l = self.lower_expr(left);
                let r = self.lower_expr(right);
                format!(
                    "{} {js_op} {}",
                    parenthesize_logic(&l, &left.expr, op),
                    parenthesize_logic(&r, &right.expr, op)
                )
            }
            IrBinOp::Coalesce => {
                let l = self.lower_expr(left);
                let r = self.lower_expr(right);
                format!(
                    "{} ?? {}",
                    parenthesize_operand(&l, &left.expr),
                    parenthesize_operand(&r, &right.expr)
                )
            }
            IrBinOp::In => {
                if !matches!(right.ty, ResolvedType::Array { .. }) {
                    let id = self.canonical_type_id(&right.ty, span);
                    self.unsupported(
                        "in membership",
                        &format!("right-hand {id} is not a collection"),
                        span,
                    );
                    return self.throw_expr("in over non-collection");
                }
                let l = self.lower_expr(left);
                let r = self.lower_expr(right);
                format!("{}.includes({l})", parenthesize_operand(&r, &right.expr))
            }
            IrBinOp::Eq | IrBinOp::Ne => self.lower_equality(op, left, right, span),
            IrBinOp::Lt | IrBinOp::Le | IrBinOp::Gt | IrBinOp::Ge => {
                self.lower_relational(op, left, right, span)
            }
            IrBinOp::Add | IrBinOp::Sub | IrBinOp::Mul | IrBinOp::Div | IrBinOp::Mod => {
                self.lower_arithmetic(op, left, right, span)
            }
        }
    }

    /// Lower `==`/`!=`: `null` compares directly, money uses `equalMoney`,
    /// decimals and structural values use `equalValue(c, typeId, a, b)`,
    /// references use `same`, secrets use `secretEqual`, ordered scalars
    /// compare directly.
    fn lower_equality(
        &mut self,
        op: IrBinOp,
        left: &TypedExpr,
        right: &TypedExpr,
        span: Span,
    ) -> String {
        let negate = op == IrBinOp::Ne;
        // `null` against any nullable side compares directly.
        if matches!(left.ty, ResolvedType::Null) || matches!(right.ty, ResolvedType::Null) {
            let l = self.lower_expr(left);
            let r = self.lower_expr(right);
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
                let l = self.lower_expr(left);
                let r = self.lower_expr(right);
                return negate_call(negate, &format!("same({l},{r})"));
            }
        }
        if is_structural(&left.ty) || is_structural(&right.ty) {
            self.stdlib.insert("equalValue".to_string());
            let id = self.canonical_type_id(&left.ty, span);
            let l = self.lower_expr(left);
            let r = self.lower_expr(right);
            return negate_call(
                negate,
                &format!("equalValue(c,{}, {l},{r})", js_string(&id)),
            );
        }
        let l_family = scalar_family(&left.ty);
        let r_family = scalar_family(&right.ty);
        match (l_family, r_family) {
            (Some(ScalarFamily::Money), Some(ScalarFamily::Money)) => {
                self.stdlib.insert("equalMoney".to_string());
                let l = self.lower_expr(left);
                let r = self.lower_expr(right);
                negate_call(negate, &format!("equalMoney({l},{r})"))
            }
            (Some(ScalarFamily::Decimal), Some(ScalarFamily::Decimal)) => {
                self.stdlib.insert("equalValue".to_string());
                let l = self.lower_expr(left);
                let r = self.lower_expr(right);
                negate_call(negate, &format!("equalValue(c,\"decimal\",{l},{r})"))
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
                        let l = self.lower_expr(left);
                        let r = self.lower_expr(right);
                        let js_op = if negate { "!==" } else { "===" };
                        format!("compareDate({l},{r}) {js_op} 0")
                    }
                    Some(ScalarFamily::Datetime) => {
                        self.stdlib.insert("compareInstant".to_string());
                        let l = self.lower_expr(left);
                        let r = self.lower_expr(right);
                        let js_op = if negate { "!==" } else { "===" };
                        format!("compareInstant({l},{r}) {js_op} 0")
                    }
                    _ => {
                        let l = self.lower_expr(left);
                        let r = self.lower_expr(right);
                        let js_op = if negate { "!==" } else { "===" };
                        format!("{l} {js_op} {r}")
                    }
                }
            }
            (
                Some(ScalarFamily::Bool | ScalarFamily::Text | ScalarFamily::Enum),
                Some(ScalarFamily::Bool | ScalarFamily::Text | ScalarFamily::Enum),
            ) => {
                let l = self.lower_expr(left);
                let r = self.lower_expr(right);
                let js_op = if negate { "!==" } else { "===" };
                format!("{l} {js_op} {r}")
            }
            (Some(ScalarFamily::Reference), Some(ScalarFamily::Reference)) => {
                self.stdlib.insert("same".to_string());
                let l = self.lower_expr(left);
                let r = self.lower_expr(right);
                negate_call(negate, &format!("same({l},{r})"))
            }
            (Some(ScalarFamily::Secret), Some(ScalarFamily::Secret)) => {
                self.stdlib.insert("secretEqual".to_string());
                let l = self.lower_expr(left);
                let r = self.lower_expr(right);
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
                let l = self.lower_expr(left);
                let r = self.lower_expr(right);
                format!("compareMoney({l},{r}) {js_op} 0")
            }
            (Some(ScalarFamily::Decimal), Some(ScalarFamily::Decimal)) => {
                self.stdlib.insert("compareDecimal".to_string());
                let l = self.lower_expr(left);
                let r = self.lower_expr(right);
                format!("compareDecimal({l},{r}) {js_op} 0")
            }
            (Some(ScalarFamily::Date), Some(ScalarFamily::Date)) => {
                self.stdlib.insert("compareDate".to_string());
                let l = self.lower_expr(left);
                let r = self.lower_expr(right);
                format!("compareDate({l},{r}) {js_op} 0")
            }
            (Some(ScalarFamily::Datetime), Some(ScalarFamily::Datetime)) => {
                self.stdlib.insert("compareInstant".to_string());
                let l = self.lower_expr(left);
                let r = self.lower_expr(right);
                format!("compareInstant({l},{r}) {js_op} 0")
            }
            (Some(ScalarFamily::Int), Some(ScalarFamily::Int))
            | (Some(ScalarFamily::Duration), Some(ScalarFamily::Duration))
            | (Some(ScalarFamily::Text), Some(ScalarFamily::Text)) => {
                let l = self.lower_expr(left);
                let r = self.lower_expr(right);
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
                let l = self.lower_expr(left);
                let r = self.lower_expr(right);
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
                    let l = self.lower_expr(left);
                    let r = self.lower_expr(right);
                    format!("{name}({l},{r})")
                }
                // A money/money ratio has no currency unit and uses decimal
                // rounding: `divideDecimal` documents money operands.
                IrBinOp::Div => {
                    self.stdlib.insert("divideDecimal".to_string());
                    let l = self.lower_expr(left);
                    let r = self.lower_expr(right);
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
                    let l = self.lower_expr(left);
                    let r = self.lower_expr(right);
                    format!("multiplyMoney({l},{r})")
                }
                IrBinOp::Div => {
                    self.stdlib.insert("divideMoney".to_string());
                    let l = self.lower_expr(left);
                    let r = self.lower_expr(right);
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
                    let l = self.lower_expr(left);
                    let r = self.lower_expr(right);
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
                    let l = self.lower_expr(left);
                    let r = self.lower_expr(right);
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
                    let l = self.lower_expr(left);
                    let r = self.lower_expr(right);
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
                    let l = self.lower_expr(left);
                    let r = self.lower_expr(right);
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
                    let l = self.lower_expr(left);
                    let r = self.lower_expr(right);
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
                    let body = self.lower_expr(pred);
                    if query.where_async {
                        opts.push(format!("where:async(row)=>{body}"));
                    } else {
                        opts.push(format!("where:(row)=>{body}"));
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
                    let body = self.lower_expr(pred);
                    out = format!("{out}.filter(({})=>{body})", sanitize_ident(alias));
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
        let body = self.lower_expr(projection);
        let map = format!(".map(({})=>{body})", sanitize_ident(param));
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
            IrDefault::Literal(value) => self.lower_expr(value),
            IrDefault::Computed { expr, has_parent } => {
                let body = self.lower_expr(expr);
                let prefix = if expr_uses_async(expr) { "async" } else { "" };
                if *has_parent {
                    format!("{prefix}(c,{{parent}})=>{body}")
                } else {
                    format!("{prefix}(c)=>{body}")
                }
            }
        }
    }

    /// Lower a server initializer: fixed `actor`/`now` or a callable.
    fn lower_server(&mut self, server: &IrServer) -> String {
        match server {
            IrServer::Actor => "\"actor\"".to_string(),
            IrServer::Now => "\"now\"".to_string(),
            IrServer::Computed(expr) => {
                let body = self.lower_expr(expr);
                let prefix = if expr_uses_async(expr) { "async" } else { "" };
                format!("{prefix}(c)=>{body}")
            }
        }
    }

    /// Lower a display message: `message(source, {locales})`, or the
    /// three-argument parameterized form preserving typed parameters.
    pub fn lower_message(&mut self, message: &IrMessage) -> String {
        self.ui.insert("message".to_string());
        let mut out = format!("message({}", js_string(&message.source));
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
                    sanitize_ident(locale),
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
                        sanitize_ident(&p.name),
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
        match stmt {
            IrStmt::Let { name, value, span } => {
                let value_text = self.lower_expr(value);
                vec![(
                    format!("{pad}const {} = {value_text};", sanitize_ident(name)),
                    *span,
                )]
            }
            IrStmt::Create {
                model,
                input,
                when,
                binding,
                span,
            } => {
                self.stdlib.insert("create".to_string());
                let input_text = self.lower_expr(input);
                let when_text = when
                    .as_ref()
                    .map(|key| format!(",{{when:crudWhen.{}}}", sanitize_ident(key)))
                    .unwrap_or_default();
                let call = format!(
                    "await create(c,{},{input_text}{when_text})",
                    js_string(model)
                );
                vec![(
                    match binding {
                        Some(name) => format!("{pad}const {} = {call};", sanitize_ident(name)),
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
                self.stdlib.insert("set".to_string());
                let record_text = self.lower_expr(record);
                let changes_text = self.lower_expr(changes);
                let when_text = when
                    .as_ref()
                    .map(|key| format!(",{{when:crudWhen.{}}}", sanitize_ident(key)))
                    .unwrap_or_default();
                vec![(
                    format!("{pad}await set(c,{record_text},{changes_text}{when_text});"),
                    *span,
                )]
            }
            IrStmt::Delete { record, mode, span } => {
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
                        Some(name) => format!("{pad}const {} = {call};", sanitize_ident(name)),
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
                self.stdlib.insert("cancel".to_string());
                let key_text = self.lower_expr(key);
                vec![(format!("{pad}await cancel(c,{key_text});"), *span)]
            }
            IrStmt::Return { value, span } => vec![(
                match value {
                    Some(v) => format!("{pad}return {};", self.lower_expr(v)),
                    None => format!("{pad}return;"),
                },
                *span,
            )],
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
                for stmt in then_branch {
                    lines.extend(self.lower_stmt(stmt, indent + 1));
                }
                if else_branch.is_empty() {
                    lines.push((format!("{pad}}}"), *span));
                } else {
                    lines.push((format!("{pad}}} else {{"), *span));
                    for stmt in else_branch {
                        lines.extend(self.lower_stmt(stmt, indent + 1));
                    }
                    lines.push((format!("{pad}}}"), *span));
                }
                lines
            }
            IrStmt::For {
                item,
                domain,
                body,
                span,
            } => {
                let domain_text = self.lower_expr(domain);
                let mut lines = vec![(
                    format!(
                        "{pad}for (const {} of await {domain_text}) {{",
                        sanitize_ident(item)
                    ),
                    *span,
                )];
                for stmt in body {
                    lines.extend(self.lower_stmt(stmt, indent + 1));
                }
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
                let person_text = self.lower_expr(person);
                format!("hasRole(c,{},{person_text})", js_string(role))
            }
            IrGuard::Expr(expr) => {
                let text = self.lower_expr(expr);
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
        // Gated containers omit the whole node when unavailable; the
        // gate reads the same scope the node renders in.
        let gate = node.gate.as_ref().map(|g| self.lower_expr(g));
        self.ui.insert(node.factory.clone());
        let mut props = vec![format!("context:{ctx}")];
        for (key, value) in &node.props {
            props.push(format!("{}:{}", object_key(key), self.lower_expr(value)));
        }
        match &node.row_scope {
            Some((row, view)) => {
                let child_ctx = sanitize_ident(view);
                let children = node
                    .children
                    .iter()
                    .map(|c| self.lower_ui_ctx(c, &child_ctx))
                    .collect::<Vec<_>>()
                    .join(",");
                // `async` exactly when a row child awaits.
                let prefix = if node.children.iter().any(ui_uses_async) {
                    "async"
                } else {
                    ""
                };
                props.push(format!(
                    "renderRow:{prefix}({},{})=>[{children}]",
                    sanitize_ident(row),
                    child_ctx
                ));
            }
            None => {
                if !node.children.is_empty() {
                    let children = node
                        .children
                        .iter()
                        .map(|c| self.lower_ui_ctx(c, ctx))
                        .collect::<Vec<_>>()
                        .join(",");
                    props.push(format!("children:[{children}]"));
                }
            }
        }
        let call = format!("{}({{{}}})", node.factory, props.join(","));
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
            entries.push(format!("{name}:{}", self.lower_expr(expr)));
        }
        format!(
            "preferences:{{{app}:{{{entries}}}}},",
            app = sanitize_ident(owner),
            entries = entries.join(",")
        )
    }

    /// Lower one page: descriptor const plus the named page function whose
    /// renderer reads the shared descriptor (`renderPage` never dispatches
    /// or re-runs admission).
    pub fn lower_page(&mut self, page: &IrPage, out: &mut JsWriter) {
        self.ui.insert("renderPage".to_string());
        let descriptor = sanitize_ident(&page.descriptor_name);
        let func = sanitize_ident(&page.fn_name);
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
        let bindings = self.admit_preferences_js(&page.owner);
        let admit_body = if page.admit.is_empty() {
            format!("async(c,routeBindings={{}})=>{{return {{{bindings}}};}}")
        } else {
            let check_text = self.lower_admission(&page.admit);
            format!("async(c,routeBindings={{}})=>{{{check_text};return {{{bindings}}};}}")
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
            // Sanitized like the emitted binding above: the envelope
            // cross-ref must name exactly what `export const` declares.
            export: sanitize_ident(&page.descriptor_name),
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
                "const preferences=bindings.preferences.{};",
                sanitize_ident(&page.owner)
            )
        } else {
            String::new()
        };
        // The body builder is `async` exactly when a child awaits
        // (state-read calls inside render values).
        let builder = if page.render.iter().any(ui_uses_async) {
            "async()=>"
        } else {
            "()=>"
        };
        out.push(
            page.span,
            Some(format!("page {}", page.path)),
            &format!("export async function {func}(c,bindings){{{preamble}return renderPage(c,{descriptor},{builder}[{children}]);}}"),
        );
    }
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
            IrExpr::Call { args, .. } => args.iter().any(expr_uses),
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
            IrExpr::Format { descriptor, .. } => expr_uses(descriptor),
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
        | IrExpr::Call { .. } => format!("({text})"),
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

/// Handler name for a CRUD operation: `createModel`, `updateModel`,
/// `deleteModel`.
fn crud_handler_name(model_local: &str, op: CrudOp) -> String {
    let prefix = match op {
        CrudOp::Create => "create",
        CrudOp::Update => "update",
        CrudOp::Delete => "delete",
    };
    format!("{prefix}{model_local}")
}

/// Sanitized `crudWhen` registry key, if the operation carries admission.
fn crud_when_key(when: Option<&String>) -> Option<String> {
    when.map(|key| sanitize_ident(key))
}

/// Registry path segments into the module's `canApp()` return object for
/// one callable item (explicit linkage: the runtime walks these, it never
/// re-derives handler names). Scenarios and derived functions address
/// their top-level handler, CRUD ops their generated handler, derived
/// fields their `derives` map entry. Segments stay an array because keys
/// contain dots (`Todo.total`), so no joined string is unambiguous.
fn registry_member(ir: &IrProgram, item: &IrItem) -> Vec<String> {
    match &item.kind {
        IrItemKind::Scenario { .. } | IrItemKind::DeriveFn { .. } => {
            vec![sanitize_ident(&item.name)]
        }
        IrItemKind::CrudOp { model, op, .. } => {
            let model_name = &ir.items[model.0 as usize].name;
            vec![crud_handler_name(model_name, *op)]
        }
        IrItemKind::DeriveField { model, .. } => {
            let model_name = &ir.items[model.0 as usize].name;
            vec!["derives".to_string(), format!("{model_name}.{}", item.name)]
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
        entry: Option<crate::analysis::resolve::ModuleId>,
    ) {
        let mut taken: BTreeSet<String> = BTreeSet::new();
        for item in &self.ir.items.clone() {
            let is_callable = matches!(
                item.kind,
                IrItemKind::Scenario { .. } | IrItemKind::CrudOp { .. }
            );
            if !is_callable {
                continue;
            }
            let mut export = sanitize_ident(&item.name);
            if item.module != entry.unwrap_or(item.module) || !taken.insert(export.clone()) {
                let module = self.ir.module(item.module).name.clone();
                export = sanitize_ident(&format!("{module}_{}", item.name));
                let mut n = 2;
                while !taken.insert(export.clone()) {
                    export = sanitize_ident(&format!("{module}_{}_{n}", item.name));
                    n += 1;
                }
            }
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
                format!("{}:{{uses:[{uses}]}}", js_string(&m.name))
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
                    format!("{}:{{{role}}}", sanitize_ident(&item.name))
                })
                .collect();
            members.push(format!("roles:{{{}}}", roles.join(",")));
            packages.push(format!(
                "{}:{{{}}}",
                sanitize_ident(&module.name),
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
                        sanitize_ident(&event.name),
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
                    if grant.fields.is_empty() {
                        format!("{{rule:{}}}", js_string(&grant.rule))
                    } else {
                        format!(
                            "{{rule:{},fields:[{}]}}",
                            js_string(&grant.rule),
                            grant
                                .fields
                                .iter()
                                .map(|f| js_string(f))
                                .collect::<Vec<_>>()
                                .join(",")
                        )
                    }
                })
                .collect();
            members.push(format!("readGrants:[{}]", entries.join(",")));
            if retain.is_some() {
                members.push(format!("retainUntil:{}", js_string(&item.name)));
            }
            for unique in &uniques {
                // Composite uniques are checked but have no §13 member
                // shape: loud `E6008`, omitted from the member.
                self.unsupported(
                    "unique constraint",
                    "composite unique constraints have no §13 lowering",
                    unique.span,
                );
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
            entries.push(format!("{}:{{{members}}}", sanitize_ident(&item.name)));
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
                    sanitize_ident(&module.name),
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
            if modifiers.unique {
                members.push_str(",unique:true");
            }
            if let Some(min) = &modifiers.min {
                members.push_str(&format!(",min:{}", self.lower_expr(min)));
            }
            if let Some(max) = &modifiers.max {
                members.push_str(&format!(",max:{}", self.lower_expr(max)));
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
        format!("{}:{{{members}}}", sanitize_ident(&field.name))
    }

    /// Emit the `operations` member: scenario metadata (handler, `by`,
    /// `read`, inputs, result, captions) and generated CRUD entries
    /// (handler, kind, model, field allowlists, `when`, captions).
    fn emit_operations_member(&mut self) -> String {
        let mut operations = Vec::new();
        for item in &self.ir.items.clone() {
            match &item.kind {
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
                        format!("handler:{}", js_string(&sanitize_ident(&item.name))),
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
                    let handler = crud_handler_name(&model_item.name, *op);
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
                parts.push(format!("{}:{{{members}}}", sanitize_ident(&param.name)));
            }
        }
        parts.join(",")
    }

    /// Emit the `pages` member: descriptor references in source order.
    fn emit_pages_member(&self) -> String {
        let mut pages = Vec::new();
        for module in &self.ir.modules {
            for page in &module.pages {
                pages.push(sanitize_ident(&page.descriptor_name));
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
                    });
                }
                IrItemKind::Scenario {
                    params,
                    read,
                    trusted,
                    description,
                    expose_excluded,
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
                                required: default.is_none()
                                    && !nullable
                                    && !is_array,
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
                        CrudOp::Create => flat,
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
    /// T15b seam (provider join): bound-send recipe/delivery shapes plug
    /// in here — `Delivery` currently falls into the `_ => None` arm
    /// (operations taking deliveries omit, fail-closed). T15b adds the
    /// T04b-agreed delivery/recipe kinds to `JsMcpField` and maps them
    /// here alongside the model-tag twin
    /// [`Emitter::model_field_tag`].
    fn mcp_field_for_type(
        &self,
        ty: &IrType,
        require_version: bool,
    ) -> Option<(JsMcpField, bool)> {
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
                    | Scalar::User
                    | Scalar::Member => JsMcpField::String,
                    Scalar::Int => JsMcpField::Integer,
                    Scalar::Decimal => JsMcpField::Decimal,
                    Scalar::Money => JsMcpField::Money,
                    Scalar::Datetime => JsMcpField::Datetime,
                    Scalar::Bool => JsMcpField::Boolean,
                    Scalar::File => JsMcpField::File,
                    Scalar::Duration | Scalar::Json | Scalar::Bytes => return None,
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
            let IrItemKind::Model {
                fields,
                owner,
                uniques,
                ..
            } = &item.kind
            else {
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
            // Unique keys in source order: field-level `unique` names
            // first (field order), then one comma-joined entry per
            // composite unique (declaration order).
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
            for unique in uniques {
                unique_keys.push(unique.fields.join(","));
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
    fn model_delete_mode(
        &self,
        model: crate::analysis::resolve::SymbolId,
    ) -> String {
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
                required: false,
                nullable,
                server_only: true,
                array_required: is_array.then_some(false),
                default: Some(JsFieldDefault::Derived),
                description: None,
            };
        }
        let (
            ty,
            required_array,
            default,
            server,
            description,
        ) = match &field_item.kind {
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
                    field: JsModelFieldType::Other {
                        type_id: "unknown".to_string(),
                    },
                    required: false,
                    nullable: false,
                    server_only: false,
                    array_required: None,
                    default: None,
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
            required,
            nullable,
            server_only: server.is_some(),
            array_required: is_array.then_some(required_array),
            default: js_field_default(default.as_ref(), server.as_ref()),
            description: description.clone(),
        }
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
    /// T15b seam (provider join): bound-send recipe/delivery shapes plug
    /// in here — `Delivery` currently maps to `other` (see the arm
    /// below). T15b adds the T04b-agreed delivery/recipe tags to
    /// `JsModelFieldType` and maps them here alongside the operation
    /// twin [`Emitter::mcp_field_for_type`].
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
            // T15b provider-join arm: bound delivery handles stay `other`
            // until T04b agrees their descriptor shape (T14b owns the
            // schemas; this slice must not guess them).
            ResolvedType::Delivery { op } => JsModelFieldType::Other {
                type_id: self
                    .ir
                    .items
                    .get(op.0 as usize)
                    .map(|row| format!("delivery:{}", row.canonical))
                    .unwrap_or_else(|| "delivery".to_string()),
            },
            // T14c: typed `std` receipts tag like bound deliveries
            // (the T15b provider join owns any richer descriptor).
            ResolvedType::StdDelivery { capability, op } => JsModelFieldType::Other {
                type_id: format!("delivery:{capability}.{}", op.name),
            },
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
        self.emit_handler_fns(out);
        out.push(entry_span, Some("canApp".to_string()), "};}");
    }

    /// Lower one `(c, row)` rule function, `async` exactly when the body
    /// awaits.
    fn lower_rule_fn(&mut self, body: &TypedExpr) -> String {
        let body_text = self.lower_expr(body);
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
                    sanitize_ident(&validator.name),
                    self.lower_rule_fn(&validator.body)
                ),
            );
        }
    }

    /// Emit the `derives` map for derived fields (derived functions stay
    /// named functions below).
    fn emit_derives_map(&mut self, out: &mut JsWriter, span: Span) {
        // Derived fields share one `derives` map keyed by local
        // `Model.field` per the oracle corpus.
        let mut derives = Vec::new();
        for item in self.ir.items.clone() {
            let IrItemKind::DeriveField { model, expr, .. } = &item.kind else {
                continue;
            };
            let key = format!(
                "{}.{}",
                self.ir.items[model.0 as usize].name.clone(),
                item.name
            );
            self.callables.push(JsCallable {
                id: item.canonical.clone(),
                kind: JsCallableKind::Pure,
                export: key.clone(),
                member: registry_member(self.ir, &item),
                span: item.span,
            });
            match expr {
                Some(expr) => {
                    let body_text = self.lower_expr(expr);
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
    fn emit_handler_fns(&mut self, out: &mut JsWriter) {
        for item in &self.ir.items.clone() {
            match &item.kind {
                IrItemKind::Scenario {
                    params,
                    trusted,
                    by,
                    guards,
                    effects,
                    ..
                } => {
                    let handler = sanitize_ident(&item.name);
                    let signature = if *trusted {
                        "c,{event}".to_string()
                    } else {
                        let names: Vec<String> = params
                            .iter()
                            .map(|id| sanitize_ident(&self.ir.items[id.0 as usize].name.clone()))
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
                    let handler = crud_handler_name(&model_item.name, *op);
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
                            &format!("check(await crudWhen.{key}(c,record));"),
                        );
                    }
                    for (line, span) in self.lower_stmt(&core, 0) {
                        out.push(span, Some(item.canonical.clone()), &line);
                    }
                    out.push(item.span, Some(item.canonical.clone()), "},");
                }
                IrItemKind::DeriveFn { expr, .. } => {
                    let name = sanitize_ident(&item.name);
                    self.callables.push(JsCallable {
                        id: item.canonical.clone(),
                        kind: JsCallableKind::Pure,
                        export: name.clone(),
                        member: registry_member(self.ir, item),
                        span: item.span,
                    });
                    match expr {
                        Some(expr) => {
                            let body_text = self.lower_expr(expr);
                            out.push(
                                item.span,
                                Some(item.canonical.clone()),
                                &format!("async {name}(c,row){{return {body_text};}},"),
                            );
                        }
                        None => {
                            out.push(
                                item.span,
                                Some(item.canonical.clone()),
                                &format!(
                                    "async {name}(c,row){{throw new Error({});}},",
                                    js_string(&format!("unchecked derive: {}", item.canonical))
                                ),
                            );
                        }
                    }
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
                            sanitize_ident(&item.name),
                            js_string(&item.canonical)
                        ),
                    );
                }
                IrItemKind::CapabilityOp { params, .. } => {
                    let name = sanitize_ident(&item.name);
                    let args: Vec<String> = params
                        .iter()
                        .map(|id| sanitize_ident(&self.ir.items[id.0 as usize].name.clone()))
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
        out.append(&body);
        let (mut diags, mut builtins, callables, pages) = emitter.finish();
        self.diags.append(&mut diags);
        self.builtins.append(&mut builtins);
        self.callables.extend(callables);
        self.pages.extend(pages);
        out.finish(module_path(&module_data.name))
    }
}

/// Object key: bare identifier when safe, quoted otherwise.
fn object_key(key: &str) -> String {
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
