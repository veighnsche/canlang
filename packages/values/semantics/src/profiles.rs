//! Versioned structural scaffold entry (V03.5).
//!
//! Thin binding-facing envelope over the V03.2 arena and the V03.4
//! plan registry: `{"v":1,"op":...,"args":{...}}` in, a value or a
//! staged error envelope out. The envelope never duplicates the
//! numeric transport: structural failures carry `{stage, code, check?}`
//! with stages `transport` (version/op/args/length/corrupt gates) and
//! `plan` (registry failures), and every gate runs BEFORE any arena
//! build or registration (never coerce-then-check).
//!
//! Owner tokens stay server-side: `owner.create` mints an opaque u64
//! handle bound to one [`plans::OwnerToken`], and every later op
//! resolves the handle first (forged handles fail as `foreign-owner`,
//! exactly like forged owners). Numbers cross losslessly: f64 as
//! 16-hex-digit bits, text as UTF-16 unit arrays, budgets as u32-range
//! integers. Fixed-width breaches (units element above `u16::MAX`,
//! bits longer than 16 hex digits, budgets above `u32::MAX`) reject
//! with `fixed-width/overflow` before coercion.

use std::collections::HashMap;

use num_bigint::BigInt;
use serde_json::{json, Value};

use crate::input::{Budgets, Frame, InputArena, TransportNode};
use crate::plans::{
    AliasInput, ContractInput, EnumInput, FieldInput, Meta, OperationInput, OwnerToken, PlanCode,
    PlanError, Plans, Provenance, SchemaInput, TypeBase,
};

/// Owned `values/v1` structural interpreter and whole-profile dispatch.
/// Lives under `profiles` so the shared crate assembly (`lib.rs`,
/// shared Cargo manifest) stays single-writer with the Exact lane; the
/// module is `pub` for binding-side consumers through this profile host.
#[path = "validation.rs"]
pub mod validation;

/// Structural scaffold ABI version. Requests must carry `"v": 1`.
pub const STRUCTURAL_ABI: u32 = 1;

/// One live request: its checked arena, owning plan handle and the
/// budgets its traversal runs under. Request ids are server-side u64
/// handles like owner handles: forged, stale or disposed ids fail at
/// the adapter before Rust executes.
#[derive(Debug)]
struct RequestEntry {
    arena: InputArena,
    owner: OwnerToken,
    plan_id: String,
    budgets: Budgets,
}

/// Binding-side host: one plan registry plus the handle tables that
/// keep owner tokens and live requests server-side across binding calls.
#[derive(Debug, Default)]
pub struct ProfileHost {
    plans: Plans,
    handles: HashMap<u64, OwnerToken>,
    next_handle: u64,
    requests: HashMap<u64, RequestEntry>,
    next_request: u64,
}

fn ok(value: Value) -> Value {
    json!({"ok": true, "value": value})
}

fn transport_err(code: &'static str, check: Option<&'static str>) -> Value {
    match check {
        Some(check) => json!({"ok": false, "stage": "transport", "code": code, "check": check}),
        None => json!({"ok": false, "stage": "transport", "code": code}),
    }
}

fn plan_err(error: &PlanError) -> Value {
    json!({"ok": false, "stage": "plan", "code": error.code.as_str()})
}

fn u32_arg(value: Option<&Value>) -> Result<u32, Value> {
    match value.and_then(Value::as_u64) {
        Some(n) if n <= u32::MAX as u64 => Ok(n as u32),
        Some(_) => Err(transport_err("fixed-width/overflow", None)),
        None => Err(transport_err("args/malformed", None)),
    }
}

fn str_arg(value: Option<&Value>) -> Result<&str, Value> {
    value
        .and_then(Value::as_str)
        .ok_or_else(|| transport_err("args/malformed", None))
}

fn parse_bits(hex: &str) -> Result<u64, Value> {
    if hex.len() > 16 {
        return Err(transport_err("fixed-width/overflow", None));
    }
    u64::from_str_radix(hex, 16).map_err(|_| transport_err("args/malformed", None))
}

fn parse_units(value: &Value) -> Result<Vec<u16>, Value> {
    let items = value
        .as_array()
        .ok_or_else(|| transport_err("args/malformed", None))?;
    let mut units = Vec::with_capacity(items.len());
    for item in items {
        match item.as_u64() {
            Some(n) if n <= u16::MAX as u64 => units.push(n as u16),
            Some(_) => return Err(transport_err("fixed-width/overflow", None)),
            None => return Err(transport_err("args/malformed", None)),
        }
    }
    Ok(units)
}

/// Builds a host frame from its tagged JSON form. Every numeric
/// conversion is checked: malformed shapes reject, fixed-width
/// breaches overflow, and nothing parses through lossy floats.
fn parse_frame(value: &Value) -> Result<Frame, Value> {
    let tag = value
        .get("t")
        .and_then(Value::as_str)
        .ok_or_else(|| transport_err("args/malformed", None))?;
    match tag {
        "f64" => {
            let bits = parse_bits(str_arg(value.get("bits"))?)?;
            Ok(Frame::F64Bits(bits))
        }
        "text" => Ok(Frame::TextUnits(parse_units(
            value
                .get("units")
                .ok_or_else(|| transport_err("args/malformed", None))?,
        )?)),
        "bool" => {
            let flag = value
                .get("v")
                .and_then(Value::as_bool)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            Ok(Frame::Bool(flag))
        }
        "null" => Ok(Frame::OwnNull),
        "missing" => Ok(Frame::Missing),
        "array" => {
            let items = value
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(parse_frame(item)?);
            }
            Ok(Frame::Array(out))
        }
        "entries" => {
            let items = value
                .get("entries")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let pair = item
                    .as_array()
                    .ok_or_else(|| transport_err("args/malformed", None))?;
                if pair.len() != 2 {
                    return Err(transport_err("args/malformed", None));
                }
                out.push((parse_units(&pair[0])?, parse_frame(&pair[1])?));
            }
            Ok(Frame::Entries(out))
        }
        _ => Err(transport_err("args/malformed", None)),
    }
}

fn hex16(bits: u64) -> String {
    format!("{bits:016x}")
}

/// Echoes one built node as identifying data: bits for f64, units for
/// text, ordered keys for entries, length for arrays, tag otherwise.
/// The echo proves preservation without re-rendering values.
fn digest_node(arena: &InputArena, index: usize) -> Value {
    match arena.node(index) {
        TransportNode::F64 { bits } => json!({"tag": "f64", "bits": hex16(*bits)}),
        TransportNode::Text { units } => json!({"tag": "text", "units": units}),
        TransportNode::Bool(flag) => json!({"tag": "bool", "v": flag}),
        TransportNode::OwnNull => json!({"tag": "own-null"}),
        TransportNode::Missing => json!({"tag": "missing"}),
        TransportNode::Array { items } => json!({"tag": "array", "len": items.len()}),
        TransportNode::Entries { entries } => {
            let keys: Vec<&Vec<u16>> = entries.iter().map(|e| &e.key).collect();
            json!({"tag": "entries", "keys": keys})
        }
        TransportNode::Tagged { .. } => json!({"tag": "tagged"}),
    }
}

/// Maximum default/bound metadata nesting accepted at registration
/// (mirrors the interpreter's conversion cap; deeper owner metadata is
/// malformed, never an unbounded conversion).
const MAX_META_DEPTH: usize = 128;

fn parse_meta(value: &Value, depth: usize) -> Result<Meta, Value> {
    if depth > MAX_META_DEPTH {
        return Err(plan_err(&PlanError {
            code: PlanCode::MalformedSchema,
            message: "default metadata is too deeply nested".to_string(),
        }));
    }
    let tag = value
        .get("t")
        .and_then(Value::as_str)
        .ok_or_else(|| transport_err("args/malformed", None))?;
    match tag {
        "null" => Ok(Meta::Null),
        "bool" => Ok(Meta::Bool(
            value
                .get("v")
                .and_then(Value::as_bool)
                .ok_or_else(|| transport_err("args/malformed", None))?,
        )),
        "bits" => Ok(Meta::NumBits(parse_bits(str_arg(value.get("bits"))?)?)),
        "text" => Ok(Meta::Text(parse_units(
            value
                .get("units")
                .ok_or_else(|| transport_err("args/malformed", None))?,
        )?)),
        "bigint" => {
            let digits = str_arg(value.get("digits"))?;
            BigInt::parse_bytes(digits.as_bytes(), 10)
                .map(Meta::Bigint)
                .ok_or_else(|| transport_err("args/malformed", None))
        }
        "array" => {
            let items = value
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(parse_meta(item, depth + 1)?);
            }
            Ok(Meta::Array(out))
        }
        "object" => {
            let items = value
                .get("entries")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let pair = item
                    .as_array()
                    .ok_or_else(|| transport_err("args/malformed", None))?;
                if pair.len() != 2 {
                    return Err(transport_err("args/malformed", None));
                }
                out.push((
                    str_arg(Some(&pair[0]))?.to_string(),
                    parse_meta(&pair[1], depth + 1)?,
                ));
            }
            Ok(Meta::Object(out))
        }
        "undef" => Ok(Meta::Undefined),
        _ => Err(transport_err("args/malformed", None)),
    }
}

fn opt_meta(value: &Value, key: &str) -> Result<Option<Meta>, Value> {
    match value.get(key) {
        None => Ok(None),
        Some(item) => parse_meta(item, 0).map(Some),
    }
}

fn opt_f64(value: &Value, key: &str) -> Result<Option<f64>, Value> {
    match value.get(key) {
        None => Ok(None),
        Some(item) => item
            .as_f64()
            .map(Some)
            .ok_or_else(|| transport_err("args/malformed", None)),
    }
}

fn opt_bool(value: &Value, key: &str) -> Result<Option<bool>, Value> {
    match value.get(key) {
        None => Ok(None),
        Some(item) => item
            .as_bool()
            .map(Some)
            .ok_or_else(|| transport_err("args/malformed", None)),
    }
}

fn parse_base(value: &Value) -> Result<TypeBase, Value> {
    let tag = value
        .get("t")
        .and_then(Value::as_str)
        .ok_or_else(|| transport_err("args/malformed", None))?;
    match tag {
        "scalar" => Ok(TypeBase::Scalar {
            name: str_arg(value.get("name"))?.to_string(),
        }),
        "stringlike" => Ok(TypeBase::Stringlike {
            name: str_arg(value.get("name"))?.to_string(),
        }),
        "user" => Ok(TypeBase::User),
        "member" => Ok(TypeBase::Member),
        "file" => Ok(TypeBase::File),
        "secret" => Ok(TypeBase::Secret),
        "json" => Ok(TypeBase::Json),
        "nominal" => Ok(TypeBase::Nominal {
            path: str_arg(value.get("path"))?.to_string(),
        }),
        "action" | "invocation" => {
            let targets = match value.get("targets") {
                None => None,
                Some(items) => {
                    let list = items
                        .as_array()
                        .ok_or_else(|| transport_err("args/malformed", None))?;
                    let mut out = Vec::with_capacity(list.len());
                    for item in list {
                        out.push(str_arg(Some(item))?.to_string());
                    }
                    Some(out)
                }
            };
            if tag == "action" {
                Ok(TypeBase::Action { targets })
            } else {
                Ok(TypeBase::Invocation { targets })
            }
        }
        "delivery" => {
            let operation = match value.get("operation") {
                None => None,
                Some(item) => Some(str_arg(Some(item))?.to_string()),
            };
            Ok(TypeBase::Delivery { operation })
        }
        "enum" => {
            let list = value
                .get("cases")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut cases = Vec::with_capacity(list.len());
            for item in list {
                cases.push(str_arg(Some(item))?.to_string());
            }
            Ok(TypeBase::Enum { cases })
        }
        "union" => {
            let list = value
                .get("arms")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut arms = Vec::with_capacity(list.len());
            for item in list {
                arms.push(str_arg(Some(item))?.to_string());
            }
            Ok(TypeBase::Union { arms })
        }
        _ => Err(transport_err("args/malformed", None)),
    }
}

/// Parses one carried `excludedIds` entry as lossless UTF-16 units.
/// Names crossing as JSON text stay exact for well-formed text; the
/// id check itself runs over units, never lossy strings.
fn parse_excluded_ids(value: &Value) -> Result<Vec<Vec<u16>>, Value> {
    let mut out = Vec::new();
    for key in ["excludedIds", "excluded_ids"] {
        if let Some(list) = value.get(key) {
            let items = list
                .as_array()
                .ok_or_else(|| transport_err("args/malformed", None))?;
            for item in items {
                out.push(parse_units(item)?);
            }
        }
    }
    Ok(out)
}

fn parse_field(value: &Value) -> Result<FieldInput, Value> {
    let flag =
        |key: &str| Ok::<bool, Value>(value.get(key).and_then(Value::as_bool).unwrap_or(false));
    // Carried duties (never silently dropped): `format` only "name",
    // `distinctBy` only "id"; deeper shape gates run in `check_schema`.
    let format = match value.get("format") {
        None => None,
        Some(item) => Some(str_arg(Some(item))?.to_string()),
    };
    let mut distinct_by = flag("distinct_by")?;
    if let Some(raw) = value.get("distinctBy") {
        let text = str_arg(Some(raw))?;
        if text != "id" {
            return Err(plan_err(&PlanError {
                code: PlanCode::MalformedSchema,
                message: "distinctBy must be \"id\"".to_string(),
            }));
        }
        distinct_by = true;
    }
    Ok(FieldInput {
        name: str_arg(value.get("name"))?.to_string(),
        type_id: str_arg(value.get("type_id"))?.to_string(),
        base: parse_base(
            value
                .get("base")
                .ok_or_else(|| transport_err("args/malformed", None))?,
        )?,
        array: flag("array")?,
        nullable: flag("nullable")?,
        required_array: flag("required_array")?,
        required: flag("required")?,
        has_default: flag("has_default")?,
        default: opt_meta(value, "default")?,
        length_min: opt_f64(value, "length_min")?,
        length_max: opt_f64(value, "length_max")?,
        value_min: opt_meta(value, "value_min")?,
        value_max: opt_meta(value, "value_max")?,
        trim: opt_bool(value, "trim")?,
        server_only: flag("server_only")?,
        default_origin: match value.get("default_origin") {
            None => None,
            Some(item) => Some(str_arg(Some(item))?.to_string()),
        },
        format,
        distinct_by,
        excluded_ids: parse_excluded_ids(value)?,
    })
}

/// Parses one carried text alias: bounded text with NAME format (`type`
/// must be `"text"`, `format` must be `"name"`; only bounds are stored).
fn parse_alias(value: &Value) -> Result<AliasInput, Value> {
    if str_arg(value.get("type"))? != "text" || str_arg(value.get("format"))? != "name" {
        return Err(plan_err(&PlanError {
            code: PlanCode::MalformedSchema,
            message: "text aliases require bounded text with NAME format".to_string(),
        }));
    }
    let min = value
        .get("min")
        .and_then(Value::as_f64)
        .ok_or_else(|| transport_err("args/malformed", None))?;
    let max = value
        .get("max")
        .and_then(Value::as_f64)
        .ok_or_else(|| transport_err("args/malformed", None))?;
    Ok(AliasInput {
        name: str_arg(value.get("name"))?.to_string(),
        length_min: min,
        length_max: max,
    })
}

fn parse_schema(value: &Value) -> Result<SchemaInput, Value> {
    let tag = value
        .get("t")
        .and_then(Value::as_str)
        .ok_or_else(|| transport_err("args/malformed", None))?;
    match tag {
        "legacy" => Ok(SchemaInput::LegacyWrapper(
            str_arg(value.get("text"))?.to_string(),
        )),
        "normalized" => {
            let raw_aliases = match value.get("aliases") {
                None => Vec::new(),
                Some(list) => list
                    .as_array()
                    .ok_or_else(|| transport_err("args/malformed", None))?
                    .clone(),
            };
            let mut aliases = Vec::with_capacity(raw_aliases.len());
            for alias in &raw_aliases {
                aliases.push(parse_alias(alias)?);
            }
            let contracts = value
                .get("contracts")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut out_contracts = Vec::with_capacity(contracts.len());
            for contract in contracts {
                let fields = contract
                    .get("fields")
                    .and_then(Value::as_array)
                    .ok_or_else(|| transport_err("args/malformed", None))?;
                let mut out_fields = Vec::with_capacity(fields.len());
                for field in fields {
                    out_fields.push(parse_field(field)?);
                }
                out_contracts.push(ContractInput {
                    name: str_arg(contract.get("name"))?.to_string(),
                    fields: out_fields,
                });
            }
            let enums = value
                .get("enums")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut out_enums = Vec::with_capacity(enums.len());
            for enum_def in enums {
                let cases = enum_def
                    .get("cases")
                    .and_then(Value::as_array)
                    .ok_or_else(|| transport_err("args/malformed", None))?;
                let mut out_cases = Vec::with_capacity(cases.len());
                for case in cases {
                    out_cases.push(str_arg(Some(case))?.to_string());
                }
                out_enums.push(EnumInput {
                    name: str_arg(enum_def.get("name"))?.to_string(),
                    cases: out_cases,
                });
            }
            let operations = value
                .get("operations")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut out_operations = Vec::with_capacity(operations.len());
            for operation in operations {
                let inputs = operation
                    .get("inputs")
                    .and_then(Value::as_array)
                    .ok_or_else(|| transport_err("args/malformed", None))?;
                let mut out_inputs = Vec::with_capacity(inputs.len());
                for input in inputs {
                    out_inputs.push(parse_field(input)?);
                }
                out_operations.push(OperationInput {
                    name: str_arg(operation.get("name"))?.to_string(),
                    inputs: out_inputs,
                    mutation: operation
                        .get("mutation")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                });
            }
            Ok(SchemaInput::Normalized {
                contracts: out_contracts,
                enums: out_enums,
                operations: out_operations,
                aliases,
            })
        }
        _ => Err(transport_err("args/malformed", None)),
    }
}

impl ProfileHost {
    fn owner_of(&self, args: &Value) -> Result<OwnerToken, Value> {
        let handle = args
            .get("owner")
            .and_then(Value::as_u64)
            .ok_or_else(|| transport_err("args/malformed", None))?;
        self.handles
            .get(&handle)
            .copied()
            .ok_or_else(|| json!({"ok": false, "stage": "plan", "code": "foreign-owner"}))
    }

    fn op_input_digest(&self, args: &Value) -> Value {
        let frame = match args
            .get("frame")
            .ok_or_else(|| transport_err("args/malformed", None))
            .and_then(parse_frame)
        {
            Ok(frame) => frame,
            Err(response) => return response,
        };
        let budgets_value = args
            .get("budgets")
            .ok_or_else(|| transport_err("args/malformed", None));
        let budgets_value = match budgets_value {
            Ok(value) => value,
            Err(response) => return response,
        };
        let nodes = match u32_arg(budgets_value.get("nodes")) {
            Ok(n) => n,
            Err(response) => return response,
        };
        let depth = match u32_arg(budgets_value.get("depth")) {
            Ok(n) => n,
            Err(response) => return response,
        };
        let text = match u32_arg(budgets_value.get("text")) {
            Ok(n) => n,
            Err(response) => return response,
        };
        let entries = match u32_arg(budgets_value.get("entries")) {
            Ok(n) => n,
            Err(response) => return response,
        };
        let budgets = Budgets {
            max_nodes: nodes as usize,
            max_depth: depth as usize,
            max_text_units: text as usize,
            max_entries: entries as usize,
        };
        match InputArena::build(&frame, &budgets) {
            Ok(arena) => {
                let root = arena.root();
                ok(json!({"nodes": arena.len(), "root": digest_node(&arena, root)}))
            }
            Err(error) => transport_err(error.code, error.check),
        }
    }

    fn op_owner_create(&mut self, args: &Value) -> Value {
        let get = |key: &str| str_arg(args.get(key));
        let (abi, profile, backend, owner_rev) =
            match (get("abi"), get("profile"), get("backend"), get("owner_rev")) {
                (Ok(abi), Ok(profile), Ok(backend), Ok(owner_rev)) => {
                    (abi, profile, backend, owner_rev)
                }
                _ => return transport_err("args/malformed", None),
            };
        let bound = match u32_arg(args.get("bound")) {
            Ok(bound) => bound,
            Err(response) => return response,
        };
        let scope = crate::plans::OwnerScope {
            abi: abi.to_string(),
            profile: profile.to_string(),
            backend: backend.to_string(),
            owner_rev: owner_rev.to_string(),
        };
        match self.plans.create_owner(scope, bound as usize) {
            Ok(token) => {
                let handle = self.next_handle;
                self.next_handle += 1;
                self.handles.insert(handle, token);
                ok(json!({"owner": handle}))
            }
            Err(error) => plan_err(&error),
        }
    }

    fn op_plan_register(&mut self, args: &Value) -> Value {
        let owner = match self.owner_of(args) {
            Ok(owner) => owner,
            Err(response) => return response,
        };
        let profile = match str_arg(args.get("profile")) {
            Ok(profile) => profile,
            Err(response) => return response,
        };
        let schema = match args
            .get("schema")
            .ok_or_else(|| transport_err("args/malformed", None))
            .and_then(parse_schema)
        {
            Ok(schema) => schema,
            Err(response) => return response,
        };
        let provenance = match args.get("provenance") {
            None => None,
            Some(item) => {
                let factory = match str_arg(item.get("factory")) {
                    Ok(factory) => factory,
                    Err(response) => return response,
                };
                let owner_rev = match str_arg(item.get("owner_rev")) {
                    Ok(owner_rev) => owner_rev,
                    Err(response) => return response,
                };
                Some(Provenance {
                    factory: factory.to_string(),
                    owner_rev: owner_rev.to_string(),
                })
            }
        };
        match self
            .plans
            .register(&owner, profile, &schema, provenance.as_ref())
        {
            Ok(id) => ok(json!({"id": id})),
            Err(error) => plan_err(&error),
        }
    }

    fn op_plan_get(&self, args: &Value) -> Value {
        let owner = match self.owner_of(args) {
            Ok(owner) => owner,
            Err(response) => return response,
        };
        let id = match str_arg(args.get("id")) {
            Ok(id) => id,
            Err(response) => return response,
        };
        match self.plans.get(&owner, id) {
            Ok(plan) => ok(json!({
                "id": plan.id,
                "profile": plan.profile,
                "generation": plan.generation,
                "sequence": plan.sequence,
                "contracts": plan.contract_order,
                "enums": plan.enum_order,
                "operations": plan.operation_order,
                "aliases": plan.alias_order,
                "dispatch": plan.dispatch.iter().map(|(path, arms)| json!({"path": path, "arms": arms})).collect::<Vec<_>>(),
            })),
            Err(error) => plan_err(&error),
        }
    }

    fn op_plan_release(&mut self, args: &Value) -> Value {
        let owner = match self.owner_of(args) {
            Ok(owner) => owner,
            Err(response) => return response,
        };
        let id = match str_arg(args.get("id")) {
            Ok(id) => id,
            Err(response) => return response,
        };
        self.plans.release(&owner, id);
        ok(Value::Null)
    }

    fn op_owner_retire(&mut self, args: &Value) -> Value {
        let owner = match self.owner_of(args) {
            Ok(owner) => owner,
            Err(response) => return response,
        };
        match self.plans.retire_generation(&owner) {
            Ok(generation) => ok(json!({"generation": generation})),
            Err(error) => plan_err(&error),
        }
    }

    /// Parses shared traversal budgets: explicit caller inputs, never
    /// defaults that could change the owned contract.
    fn parse_budgets(args: &Value) -> Result<Budgets, Value> {
        let budgets = args
            .get("budgets")
            .ok_or_else(|| transport_err("args/malformed", None))?;
        Ok(Budgets {
            max_nodes: u32_arg(budgets.get("nodes"))? as usize,
            max_depth: u32_arg(budgets.get("depth"))? as usize,
            max_text_units: u32_arg(budgets.get("text"))? as usize,
            max_entries: u32_arg(budgets.get("entries"))? as usize,
        })
    }

    /// Begins one owned request: gates owner and plan handles, builds
    /// the checked arena, and retains it server-side under a fresh
    /// request id. Parser-token creation records ownership without
    /// traversal; conversion starts here, at the validation point.
    fn op_request_begin(&mut self, args: &Value) -> Value {
        let owner = match self.owner_of(args) {
            Ok(owner) => owner,
            Err(response) => return response,
        };
        let plan_id = match str_arg(args.get("plan")) {
            Ok(plan_id) => plan_id.to_string(),
            Err(response) => return response,
        };
        if self.plans.get(&owner, &plan_id).is_err() {
            // Unknown, released or retired-generation handles fail here,
            // before any arena is built or retained.
            let error = self
                .plans
                .get(&owner, &plan_id)
                .expect_err("checked above");
            return plan_err(&error);
        }
        let frame = match args
            .get("frame")
            .ok_or_else(|| transport_err("args/malformed", None))
            .and_then(parse_frame)
        {
            Ok(frame) => frame,
            Err(response) => return response,
        };
        let budgets = match Self::parse_budgets(args) {
            Ok(budgets) => budgets,
            Err(response) => return response,
        };
        match InputArena::build(&frame, &budgets) {
            Ok(arena) => {
                let id = self.next_request;
                self.next_request += 1;
                self.requests.insert(
                    id,
                    RequestEntry {
                        arena,
                        owner,
                        plan_id,
                        budgets,
                    },
                );
                ok(json!({"request": id}))
            }
            Err(error) => transport_err(error.code, error.check),
        }
    }

    /// Parses one whole-profile execution target.
    fn parse_target(args: &Value) -> Result<validation::Target, Value> {
        let target = args
            .get("target")
            .ok_or_else(|| transport_err("args/malformed", None))?;
        match target.get("kind").and_then(Value::as_str) {
            Some("contract") => {
                let name = str_arg(target.get("name"))?.to_string();
                let mode = match target.get("mode").and_then(Value::as_str) {
                    Some("create") => validation::Mode::Create,
                    Some("update") => validation::Mode::Update,
                    _ => return Err(transport_err("args/malformed", None)),
                };
                Ok(validation::Target::Contract { name, mode })
            }
            Some("operation") => Ok(validation::Target::Operation {
                name: str_arg(target.get("name"))?.to_string(),
            }),
            _ => Err(transport_err("args/malformed", None)),
        }
    }

    /// Executes one whole profile action against a live request: the
    /// plan resolves fresh (retirement between begin and execute fails
    /// closed), coverage defers before traversal, and failures never
    /// publish partial values. No semantic operation is retried here.
    fn op_values_execute(&mut self, args: &Value) -> Value {
        let request = match args.get("request").and_then(Value::as_u64) {
            Some(request) => request,
            None => return transport_err("args/malformed", None),
        };
        let profile = match str_arg(args.get("profile")) {
            Ok(profile) => profile,
            Err(response) => return response,
        };
        let target = match Self::parse_target(args) {
            Ok(target) => target,
            Err(response) => return response,
        };
        let entry = match self.requests.get(&request) {
            Some(entry) => entry,
            // Forged, stale or disposed handles fail at the adapter,
            // before Rust executes.
            None => return transport_err("request/unknown", None),
        };
        let plan = match self.plans.get(&entry.owner, &entry.plan_id) {
            Ok(plan) => plan.clone(),
            Err(error) => return plan_err(&error),
        };
        if profile != plan.profile {
            return plan_err(&PlanError {
                code: PlanCode::InvalidProfile,
                message: "execution profile does not match the registered plan profile".to_string(),
            });
        }
        let known = match &target {
            validation::Target::Contract { name, .. } => {
                plan.contracts.iter().any(|contract| contract.name == *name)
            }
            validation::Target::Operation { name } => plan
                .operations
                .iter()
                .any(|operation| operation.name == *name),
        };
        if !known {
            return plan_err(&PlanError {
                code: PlanCode::UnknownTarget,
                message: "execution target names no declared contract or operation".to_string(),
            });
        }
        let resolve = |key: &str| {
            self.plans
                .resolve_default(
                    &entry.owner,
                    &crate::plans::DefaultRef {
                        key: key.to_string(),
                    },
                )
                .ok()
                .cloned()
        };
        let outcome = validation::execute(
            &entry.arena,
            &plan,
            &resolve,
            &target,
            validation::ExecBudgets {
                max_nodes: entry.budgets.max_nodes,
                max_depth: entry.budgets.max_depth,
            },
        );
        ok(validation::outcome_to_json(&outcome))
    }

    /// Disposes one request: idempotent success/error/cancel release at
    /// the request seam. Unknown ids are silent no-ops like plan
    /// release; every request runs under `try/finally` host-side.
    fn op_request_dispose(&mut self, args: &Value) -> Value {
        match args.get("request").and_then(Value::as_u64) {
            Some(request) => {
                self.requests.remove(&request);
                ok(Value::Null)
            }
            None => transport_err("args/malformed", None),
        }
    }

    /// Runs one versioned scaffold request. Version, op and args gates
    /// run before any arena build or registration.
    pub fn handle_line(&mut self, line: &str) -> Value {
        let request: Value = match serde_json::from_str(line) {
            Ok(request) => request,
            Err(_) => return transport_err("args/malformed", None),
        };
        match request.get("v").and_then(Value::as_u64) {
            Some(version) if version == STRUCTURAL_ABI as u64 => {}
            Some(_) => return transport_err("version/unsupported", None),
            None => return transport_err("version/malformed", None),
        }
        let op = match request.get("op").and_then(Value::as_str) {
            Some(op) => op,
            None => return transport_err("op/unknown", None),
        };
        let args = match request.get("args") {
            Some(args) if args.is_object() => args,
            _ => return transport_err("args/malformed", None),
        };
        match op {
            "input.digest" => self.op_input_digest(args),
            "owner.create" => self.op_owner_create(args),
            "plan.register" => self.op_plan_register(args),
            "plan.get" => self.op_plan_get(args),
            "plan.release" => self.op_plan_release(args),
            "owner.retire" => self.op_owner_retire(args),
            "request.begin" => self.op_request_begin(args),
            "values.execute" => self.op_values_execute(args),
            "request.dispose" => self.op_request_dispose(args),
            _ => transport_err("op/unknown", None),
        }
    }
}
