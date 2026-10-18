//! Owned `values/v1` structural interpreter (native execution slice).
//!
//! Executes whole-profile validation over an [`InputArena`] against a
//! registered [`Plan`]: nested contracts/unions/arrays, presence and
//! omission rules (required/default/engine markers), trim after decode
//! and before bounds, inclusive length bounds, carried
//! format/distinctBy/excludedIds duties, enum and model-ref shapes,
//! secret refusal and ordered accumulated violations.
//!
//! The interpreter covers the structural leaves natively (`text`,
//! `bool`, enums, unions, contracts, arrays, model-ref shapes, secret
//! refusal). Leaves owned by other lanes or the host — exact numeric
//! and temporal scalars (Exact lane codec release), host-mediated
//! stringlike predicates (URL/Intl/ICU), and user/member/file/json/
//! action/invocation/delivery carriers — are classified **before**
//! execution: a target that reaches one returns a declared `deferred`
//! outcome naming its owner, and the host keeps the legacy TS path via
//! preselected compatibility routing. A deferred outcome is never a
//! silent drop and never a false native claim.
//!
//! Text crosses as lossless UTF-16 units end to end (lone surrogates
//! kept); diagnostic rendering reuses JS `JSON.stringify`/`String`
//! rules. Traversal is depth- and visit-budgeted: breaches return the
//! documented new-path `limit` outcome, never a trap or a legacy-cycle
//! `RangeError` equivalent.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::input::{InputArena, TransportNode};
use crate::plans::{
    is_name_units, scalar_len_units, AliasPlan, ContractPlan, FieldPlan, Meta, OperationPlan,
    Plan, TypeBase,
};

/// Pinned UTF-16 length bound for record ids (mirrors `refs.ts`).
pub const MAX_ID_UNITS: usize = 256;

/// Traversal budgets for one execution (explicit caller inputs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecBudgets {
    pub max_nodes: usize,
    pub max_depth: usize,
}

/// One violation path segment: object key (lossless units) or index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathSeg {
    Key(Vec<u16>),
    Index(usize),
}

/// One ordered violation record: closed diagnostic template plus
/// ordered lossless arguments (host formats over owned data only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub path: Vec<PathSeg>,
    pub code: &'static str,
    pub message: String,
    pub expected: Option<String>,
    pub actual: Option<String>,
}

impl Violation {
    fn new(
        path: &[PathSeg],
        code: &'static str,
        message: String,
        expected: Option<String>,
        actual: Option<String>,
    ) -> Self {
        Violation {
            path: path.to_vec(),
            code,
            message,
            expected,
            actual,
        }
    }
}

/// Deferred-leaf owner: who must release the codec before native
/// execution can cover the leaf.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeafOwner {
    /// Exact lane numeric/temporal scalar codec release.
    ExactCodec,
    /// Host-mediated URL/Intl/ICU predicate.
    HostPredicate,
    /// Owning carrier codec (user/member/file/json/action/
    /// invocation/delivery).
    WireCodec,
}

impl LeafOwner {
    pub fn reason(self) -> &'static str {
        match self {
            LeafOwner::ExactCodec => "exact-codec",
            LeafOwner::HostPredicate => "host-predicate",
            LeafOwner::WireCodec => "wire-codec",
        }
    }
}

/// Structural leaf class resolved from a field base.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeafClass {
    Text,
    Bool,
    /// Secret leaves refuse every client value natively.
    Secret,
    /// Covered by another owner; carries the release it waits on.
    Deferred(LeafOwner),
}

/// Execution outcome: valid normalized frame tree, ordered violations,
/// a declared deferral, or a traversal-limit refusal.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Valid(OutNode),
    Invalid(Vec<Violation>),
    Deferred {
        owner: LeafOwner,
        detail: String,
    },
    Limit {
        code: &'static str,
        check: &'static str,
    },
}

/// Normalized output node. Text stays UTF-16 units; markers carry
/// registry identity for host materialization.
#[derive(Debug, Clone, PartialEq)]
pub enum OutNode {
    Null,
    Bool(bool),
    Text(Vec<u16>),
    /// Explicit-undefined default fill (own presence, undefined value).
    Undef,
    /// Model reference shape: model name, id units, version decimal.
    Ref {
        model: String,
        id: Vec<u16>,
        version: Option<String>,
    },
    Enum(String),
    Array(Vec<OutNode>),
    Entries(Vec<(Vec<u16>, OutNode)>),
    Union {
        arm: String,
        value: Box<OutNode>,
    },
    /// Registry default resolved by key at materialization (stable host
    /// identity through the shared default registry).
    DefaultRef(String),
    /// Shared implicit empty array (host `emptyArray` identity).
    EmptyArray,
    /// Update-mode omission marker (resolves to the existing symbol).
    UpdateOmitted,
}

// ---------------------------------------------------------------------------
// UTF-16 text utilities (host-parity implementations).
// ---------------------------------------------------------------------------

/// Unicode `White_Space` code points (stable property set): trims the
/// same pinned set as the host `trim` (`/^\p{White_Space}+|\p{White_Space}+$/gu`).
fn is_white_space(code: u32) -> bool {
    matches!(
        code,
        0x0009
            | 0x000A
            | 0x000B
            | 0x000C
            | 0x000D
            | 0x0020
            | 0x0085
            | 0x00A0
            | 0x1680
            | 0x2000
            | 0x2001
            | 0x2002
            | 0x2003
            | 0x2004
            | 0x2005
            | 0x2006
            | 0x2007
            | 0x2008
            | 0x2009
            | 0x200A
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
    )
}

/// Decodes one scalar value from UTF-16 units: surrogate pair or single
/// unit (lone surrogates decode to themselves, matching iteration).
fn decode_scalar_at(units: &[u16], index: usize) -> (u32, usize) {
    let unit = units[index];
    if (0xD800..0xDC00).contains(&unit) {
        if let Some(trail) = units.get(index + 1) {
            if (0xDC00..0xE000).contains(trail) {
                let high = (unit as u32) - 0xD800;
                let low = (*trail as u32) - 0xDC00;
                return (0x10000 + (high << 10) + low, 2);
            }
        }
    }
    (unit as u32, 1)
}

/// Trims pinned `White_Space` at both ends over UTF-16 units.
pub fn trim_units(units: &[u16]) -> Vec<u16> {
    let mut start = 0;
    while start < units.len() {
        let (code, _) = decode_scalar_at(units, start);
        if !is_white_space(code) {
            break;
        }
        start += 1;
    }
    let mut end = units.len();
    while end > start {
        // Step back over a trail surrogate that belongs to a pair.
        let mut back = end - 1;
        if (0xDC00..0xE000).contains(&units[back]) && back > start {
            if (0xD800..0xDC00).contains(&units[back - 1]) {
                back -= 1;
            }
        }
        let (code, _) = decode_scalar_at(units, back);
        if !is_white_space(code) {
            break;
        }
        end = back;
    }
    units[start..end].to_vec()
}

/// Renders UTF-16 units with JS `JSON.stringify` string rules: quotes,
/// short escapes, `\u00xx` for other controls, `\uxxxx` (lowercase)
/// for lone surrogates, astral pairs literal.
pub fn stringify_units(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len() + 2);
    out.push('"');
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        match unit {
            0x22 => out.push_str("\\\""),
            0x5C => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x09 => out.push_str("\\t"),
            0x0A => out.push_str("\\n"),
            0x0C => out.push_str("\\f"),
            0x0D => out.push_str("\\r"),
            0x00..=0x1F => {
                out.push_str(&format!("\\u{unit:04x}"));
            }
            0xD800..=0xDFFF => {
                if (0xD800..0xDC00).contains(&unit) {
                    if let Some(trail) = units.get(index + 1) {
                        if (0xDC00..0xE000).contains(trail) {
                            let high = (unit as u32) - 0xD800;
                            let low = (*trail as u32) - 0xDC00;
                            let code = 0x10000 + (high << 10) + low;
                            if let Some(ch) = char::from_u32(code) {
                                out.push(ch);
                            }
                            index += 2;
                            continue;
                        }
                    }
                }
                out.push_str(&format!("\\u{unit:04x}"));
            }
            _ => {
                if let Some(ch) = char::from_u32(unit as u32) {
                    out.push(ch);
                }
            }
        }
        index += 1;
    }
    out.push('"');
    out
}

/// Best-effort display of units for diagnostics (exact when well-formed;
/// `U+FFFD` per ill-formed unit, matching `from_utf16_lossy`).
fn display_units(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// JS `String(number)` rendering for f64 bounds in messages.
fn js_number(value: f64) -> String {
    let mut buffer = ryu_js::Buffer::new();
    buffer.format(value).to_string()
}

// ---------------------------------------------------------------------------
// Wire rendering (`actual` diagnostics mirror `actualWire`).
// ---------------------------------------------------------------------------

/// Renders one arena node with `actualWire` rules: strings quoted (60
/// UTF-16 units then `...`), numbers as `number <String(n)>`, arrays as
/// `array of length n`, entries as `object with keys [...]`.
fn actual_node(arena: &InputArena, index: usize) -> String {
    match arena.node(index) {
        TransportNode::F64 { bits } => format!("number {}", js_number(f64::from_bits(*bits))),
        TransportNode::Text { units } => {
            if units.len() > 60 {
                format!("{}...", stringify_units(&units[..60]))
            } else {
                stringify_units(units)
            }
        }
        TransportNode::Bool(true) => "true".to_string(),
        TransportNode::Bool(false) => "false".to_string(),
        TransportNode::OwnNull => "null".to_string(),
        TransportNode::Missing => "undefined".to_string(),
        TransportNode::Array { items } => format!("array of length {}", items.len()),
        TransportNode::Entries { entries } => {
            let keys: Vec<String> = entries
                .iter()
                .take(5)
                .map(|entry| display_units(&entry.key))
                .collect();
            format!("object with keys [{}]", keys.join(", "))
        }
        TransportNode::Tagged { .. } => "tagged".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Leaf classification and target coverage.
// ---------------------------------------------------------------------------

/// Resolves the structural class of one scalar leaf name.
fn scalar_class(name: &str) -> LeafClass {
    match name {
        "text" => LeafClass::Text,
        "bool" => LeafClass::Bool,
        "int" | "decimal" | "money" | "date" | "datetime" | "duration" => {
            LeafClass::Deferred(LeafOwner::ExactCodec)
        }
        _ => LeafClass::Deferred(LeafOwner::WireCodec),
    }
}

/// Resolves the structural class of one field base.
fn base_class(base: &TypeBase) -> LeafClass {
    match base {
        TypeBase::Scalar { name } => scalar_class(name),
        TypeBase::Stringlike { .. } => LeafClass::Deferred(LeafOwner::HostPredicate),
        TypeBase::User | TypeBase::Member | TypeBase::File | TypeBase::Json => {
            LeafClass::Deferred(LeafOwner::WireCodec)
        }
        TypeBase::Secret => LeafClass::Secret,
        TypeBase::Action { .. } | TypeBase::Invocation { .. } | TypeBase::Delivery { .. } => {
            LeafClass::Deferred(LeafOwner::WireCodec)
        }
        TypeBase::Nominal { .. } | TypeBase::Enum { .. } | TypeBase::Union { .. } => {
            // Structural dispatch resolved by the caller against the plan.
            LeafClass::Text
        }
    }
}

/// Coverage walk over one field type: finds the first leaf owned by
/// another lane or the host, before any input is executed. Returns the
/// dotted plan path of the deferral for the declared outcome.
pub fn coverage_gap(
    plan: &Plan,
    owner_path: &str,
    base: &TypeBase,
    visiting: &mut Vec<String>,
) -> Option<(LeafOwner, String)> {
    match base {
        TypeBase::Scalar { .. }
        | TypeBase::Stringlike { .. }
        | TypeBase::User
        | TypeBase::Member
        | TypeBase::File
        | TypeBase::Secret
        | TypeBase::Json
        | TypeBase::Action { .. }
        | TypeBase::Invocation { .. }
        | TypeBase::Delivery { .. } => match base_class(base) {
            LeafClass::Deferred(owner) => Some((owner, owner_path.to_string())),
            _ => None,
        },
        TypeBase::Enum { .. } => None,
        TypeBase::Nominal { path } => {
            if plan.aliases.iter().any(|alias| alias.name == *path) {
                return None;
            }
            if plan.contracts.iter().any(|contract| contract.name == *path) {
                if visiting.iter().any(|name| name == path) {
                    return None;
                }
                visiting.push(path.clone());
                let contract = plan
                    .contracts
                    .iter()
                    .find(|contract| contract.name == *path)
                    .expect("contract located above");
                for field in &contract.fields {
                    let nested = format!("{owner_path}.{}", field.name);
                    if let Some(gap) = coverage_gap(plan, &nested, &field.base, visiting) {
                        return Some(gap);
                    }
                }
                visiting.pop();
                return None;
            }
            if plan.enums.iter().any(|enum_def| enum_def.name == *path) {
                return None;
            }
            // Undeclared nominals are model references: native shape check.
            None
        }
        TypeBase::Union { arms } => {
            for arm in arms {
                if let Some(gap) = coverage_gap_arm(plan, owner_path, arm, visiting) {
                    return Some(gap);
                }
            }
            None
        }
    }
}

/// Coverage walk over one union arm name: scalar leaves, aliases,
/// contracts, enums and model refs resolve as above; anything else
/// waits on its owning codec.
fn coverage_gap_arm(
    plan: &Plan,
    owner_path: &str,
    arm: &str,
    visiting: &mut Vec<String>,
) -> Option<(LeafOwner, String)> {
    let nested = format!("{owner_path}<{arm}>");
    match arm {
        "text" | "bool" => None,
        "int" | "decimal" | "money" | "date" | "datetime" | "duration" => {
            Some((LeafOwner::ExactCodec, nested))
        }
        _ => {
            if plan.aliases.iter().any(|alias| alias.name == arm) {
                return None;
            }
            if let Some(contract) = plan.contracts.iter().find(|contract| contract.name == arm) {
                if visiting.iter().any(|name| name == arm) {
                    return None;
                }
                visiting.push(arm.to_string());
                for field in &contract.fields {
                    let deeper = format!("{nested}.{}", field.name);
                    if let Some(gap) = coverage_gap(plan, &deeper, &field.base, visiting) {
                        return Some(gap);
                    }
                }
                visiting.pop();
                return None;
            }
            if plan.enums.iter().any(|enum_def| enum_def.name == arm) {
                return None;
            }
            // Bare model/enum-inline arms resolve as model-ref shapes when
            // they name no scalar, alias, contract or enum: still native.
            if arm.contains('(') || arm.contains('[') || arm.contains('|') || arm.contains('<') {
                return Some((LeafOwner::WireCodec, nested));
            }
            None
        }
    }
}

/// Whole-target coverage: every field of the target contract or
/// operation must be natively executable, else the declared deferral.
pub fn target_gap(
    plan: &Plan,
    target: &Target,
    resolve: &dyn Fn(&str) -> Option<Meta>,
) -> Option<(LeafOwner, String)> {
    let mut visiting: Vec<String> = Vec::new();
    match target {
        Target::Contract { name, .. } => {
            let contract = plan.contracts.iter().find(|contract| contract.name == *name)?;
            for field in &contract.fields {
                let path = format!("contracts.{name}.fields.{}", field.name);
                if let Some(gap) = coverage_gap(plan, &path, &field.base, &mut visiting) {
                    return Some(gap);
                }
                if let Some(gap) = default_gap(&format!("{path}#default"), field, resolve) {
                    return Some(gap);
                }
            }
            None
        }
        Target::Operation { name } => {
            let operation = plan
                .operations
                .iter()
                .find(|operation| operation.name == *name)?;
            for input in &operation.inputs {
                let path = format!("operations.{name}.inputs.{}", input.name);
                if let Some(gap) = coverage_gap(plan, &path, &input.base, &mut visiting) {
                    return Some(gap);
                }
                if let Some(gap) = default_gap(&format!("{path}#default"), input, resolve) {
                    return Some(gap);
                }
            }
            None
        }
    }
}

/// Default coverage: registry defaults on natively covered leaves are
/// plain data; exact-carrier defaults wait on the Exact codec release.
fn default_gap(
    owner_path: &str,
    field: &FieldPlan,
    resolve: &dyn Fn(&str) -> Option<Meta>,
) -> Option<(LeafOwner, String)> {
    let reference = field.default_ref.as_ref()?;
    let meta = resolve(&reference.key)?;
    if meta_to_out(&meta).is_none() {
        return Some((LeafOwner::ExactCodec, owner_path.to_string()));
    }
    None
}

/// Execution target: a contract value in a mode, or an operation call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Contract { name: String, mode: Mode },
    Operation { name: String },
}

/// Validation nesting: create fills, update omits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Create,
    Update,
}

/// Omission outcome for one absent field.
enum Omit {
    /// A violation was recorded.
    Fail,
    /// Engine-resolved marker: the key drops from the output.
    Drop,
    UpdateOmitted,
    Out(OutNode),
}

/// Live execution state: borrowed arena and plan plus accumulators.
/// Defaults stay registry references; only coverage resolves them.
struct Cx<'a> {
    arena: &'a InputArena,
    plan: &'a Plan,
    violations: Vec<Violation>,
    visited: usize,
    budgets: ExecBudgets,
}

impl<'a> Cx<'a> {
    /// Counts one visited node before use; breaches refuse with the
    /// documented new-path `limit` outcome.
    fn visit(&mut self) -> Result<(), Outcome> {
        self.visited += 1;
        if self.visited > self.budgets.max_nodes {
            return Err(Outcome::Limit {
                code: "length/oversized",
                check: "nodes",
            });
        }
        Ok(())
    }

    /// Checks traversal depth before descending.
    fn descend(&self, depth: usize) -> Result<(), Outcome> {
        if depth > self.budgets.max_depth {
            return Err(Outcome::Limit {
                code: "length/bound-exceeded",
                check: "depth",
            });
        }
        Ok(())
    }

    fn push(
        &mut self,
        path: &[PathSeg],
        code: &'static str,
        message: String,
        expected: Option<String>,
        actual: Option<String>,
    ) {
        self.violations
            .push(Violation::new(path, code, message, expected, actual));
    }
}

/// Canonical type-id rendering for diagnostics (mirrors `printTypeId`).
fn print_type_id(base: &TypeBase, array: bool, required_array: bool, nullable: bool) -> String {
    let mut out = print_base(base);
    if array {
        out.push_str("[]");
    }
    if required_array {
        out.push('!');
    } else if nullable {
        out.push('?');
    }
    out
}

/// Canonical base rendering (mirrors `printTypeBase`).
fn print_base(base: &TypeBase) -> String {
    match base {
        TypeBase::Scalar { name } | TypeBase::Stringlike { name } => name.clone(),
        TypeBase::User => "user".to_string(),
        TypeBase::Member => "member".to_string(),
        TypeBase::File => "file".to_string(),
        TypeBase::Secret => "secret".to_string(),
        TypeBase::Json => "json".to_string(),
        TypeBase::Nominal { path } => path.clone(),
        TypeBase::Action { targets } => match targets {
            None => "action".to_string(),
            Some(names) => format!("action({})", names.join(",")),
        },
        TypeBase::Invocation { targets } => match targets {
            None => "invocation".to_string(),
            Some(names) => format!("invocation({})", names.join(",")),
        },
        TypeBase::Delivery { operation } => match operation {
            None => "delivery".to_string(),
            Some(name) => format!("delivery({name})"),
        },
        TypeBase::Enum { cases } => format!("enum({})", cases.join(",")),
        TypeBase::Union { arms } => arms.join("|"),
    }
}

/// Field type-id rendering for diagnostics.
fn field_type_id(field: &FieldPlan) -> String {
    print_type_id(&field.base, field.array, field.required_array, field.nullable)
}

/// Deduplicates entries: last value wins, first position kept (mirrors
/// host `JSON.parse` duplicate-key semantics over preserved entries).
fn dedupe_entries<'e>(entries: &'e [crate::input::Entry]) -> Vec<(&'e Vec<u16>, usize)> {
    let mut order: Vec<(&'e Vec<u16>, usize)> = Vec::with_capacity(entries.len());
    let mut positions: HashMap<&[u16], usize> = HashMap::new();
    for entry in entries {
        if let Some(position) = positions.get(entry.key.as_slice()) {
            order[*position].1 = entry.node;
        } else {
            positions.insert(entry.key.as_slice(), order.len());
            order.push((&entry.key, entry.node));
        }
    }
    order
}

/// Maximum Meta nesting converted by one default expansion (plan data
/// converts under a fixed cap, never unbounded recursion).
const MAX_META_DEPTH: usize = 128;

/// Converts a registry default Meta to its output node. Exact-carrier
/// defaults are coverage-deferred, so only plain data converts here.
/// Recursion is depth-capped; deeper plan data refuses as a limit.
fn meta_to_out(meta: &Meta) -> Option<OutNode> {
    meta_to_out_at(meta, 0)
}

fn meta_to_out_at(meta: &Meta, depth: usize) -> Option<OutNode> {
    if depth > MAX_META_DEPTH {
        return None;
    }
    match meta {
        Meta::Null => Some(OutNode::Null),
        Meta::Bool(flag) => Some(OutNode::Bool(*flag)),
        Meta::Text(units) => Some(OutNode::Text(units.clone())),
        Meta::Undefined => Some(OutNode::Undef),
        Meta::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(meta_to_out_at(item, depth + 1)?);
            }
            Some(OutNode::Array(out))
        }
        Meta::Object(entries) => {
            let mut out = Vec::with_capacity(entries.len());
            for (key, value) in entries {
                out.push((
                    key.encode_utf16().collect(),
                    meta_to_out_at(value, depth + 1)?,
                ));
            }
            Some(OutNode::Entries(out))
        }
        Meta::NumBits(_) | Meta::Bigint(_) => None,
    }
}

// ---------------------------------------------------------------------------
// Omission.
// ---------------------------------------------------------------------------

/// Absent-field handling (mirrors `omittedField` for create/update
/// nesting; explicit nesting never arises from whole-profile targets).
fn omitted(cx: &mut Cx, field: &FieldPlan, path: &[PathSeg], mode: Mode) -> Result<Omit, Outcome> {
    if mode == Mode::Update {
        return Ok(Omit::UpdateOmitted);
    }
    if field.required {
        cx.push(
            path,
            "required",
            "missing required field".to_string(),
            Some(field_type_id(field)),
            None,
        );
        return Ok(Omit::Fail);
    }
    if field.has_default {
        // Defaults resolve through the plan owner's shared frozen
        // registry at materialization: the frame carries the reference
        // key (stable host identity), never an eager copy. Registration
        // guarantees the reference exists; coverage checks its carrier.
        let reference = field.default_ref.as_ref().ok_or(Outcome::Deferred {
            owner: LeafOwner::WireCodec,
            detail: "field claims a default the registry cannot resolve".to_string(),
        })?;
        return Ok(Omit::Out(OutNode::DefaultRef(reference.key.clone())));
    }
    if field.default_origin.as_deref() == Some("server")
        || field.default_origin.as_deref() == Some("derived")
    {
        return Ok(Omit::Drop);
    }
    if field.nullable {
        return Ok(Omit::Out(OutNode::Null));
    }
    // The implicit `[]` must satisfy length bounds like an explicit one.
    let before = cx.violations.len();
    check_bounds(cx, field, &OutNode::Array(Vec::new()), path);
    if cx.violations.len() != before {
        return Ok(Omit::Fail);
    }
    Ok(Omit::Out(OutNode::EmptyArray))
}

// ---------------------------------------------------------------------------
// Bounds (run after normalization; mirrors `checkBounds`).
// ---------------------------------------------------------------------------

/// Inclusive length/format/distinct checks. Value bounds only order
/// exact carriers (`compareBound` is null for text/bool), so they are a
/// native no-op here; exact-carrier fields are coverage-deferred.
fn check_bounds(cx: &mut Cx, field: &FieldPlan, value: &OutNode, path: &[PathSeg]) {
    if field.format.as_deref() == Some("name") {
        if let OutNode::Text(units) = value {
            if !is_name_units(units) {
                cx.push(
                    path,
                    "format",
                    "text must match Can NAME".to_string(),
                    Some("letter/underscore followed by letters, digits or underscores".to_string()),
                    Some(stringify_units(units)),
                );
            }
        }
    }
    if field.distinct_by {
        if let OutNode::Array(items) = value {
            let mut seen: Vec<Vec<u16>> = Vec::new();
            let excluded: Vec<&Vec<u16>> = field.excluded_ids.iter().collect();
            for (index, item) in items.iter().enumerate() {
                let mut id_path = path.to_vec();
                id_path.push(PathSeg::Index(index));
                id_path.push(PathSeg::Key("id".encode_utf16().collect()));
                let id_units = match item {
                    OutNode::Entries(entries) => entries
                        .iter()
                        .find(|(key, _)| key == &"id".encode_utf16().collect::<Vec<u16>>())
                        .and_then(|(_, node)| match node {
                            OutNode::Text(units) => Some(units),
                            _ => None,
                        }),
                    _ => None,
                };
                let Some(id_units) = id_units else {
                    cx.push(
                        &id_path,
                        "format",
                        "array ids must be text".to_string(),
                        Some("text id".to_string()),
                        Some(match item {
                            OutNode::Entries(entries) => entries
                                .iter()
                                .find(|(key, _)| {
                                    key == &"id".encode_utf16().collect::<Vec<u16>>()
                                })
                                .map(|(_, node)| describe_out(node))
                                .unwrap_or_else(|| "undefined".to_string()),
                            _ => describe_out(item),
                        }),
                    );
                    continue;
                };
                if seen.contains(id_units) {
                    cx.push(
                        &id_path,
                        "format",
                        "array repeats an id".to_string(),
                        Some("distinct ids".to_string()),
                        Some(stringify_units(id_units)),
                    );
                }
                if excluded.contains(&id_units) {
                    cx.push(
                        &id_path,
                        "format",
                        "array id collides with an authored id".to_string(),
                        Some("id outside excludedIds".to_string()),
                        Some(stringify_units(id_units)),
                    );
                }
                seen.push(id_units.clone());
            }
        }
    }
    let length: Option<f64> = match value {
        OutNode::Text(units) => Some(scalar_len_units(units) as f64),
        OutNode::Array(items) => Some(items.len() as f64),
        // The implicit empty array carries length 0 like an explicit one.
        OutNode::EmptyArray => Some(0.0),
        _ => None,
    };
    if let Some(length) = length {
        if let Some(min) = field.length_min {
            if length < min {
                cx.push(
                    path,
                    "bound",
                    format!("length {length} is below the minimum of {}", js_number(min)),
                    Some(format!("length >= {}", js_number(min))),
                    Some(format!("length {length}")),
                );
            }
        }
        if let Some(max) = field.length_max {
            if length > max {
                cx.push(
                    path,
                    "bound",
                    format!("length {length} is above the maximum of {}", js_number(max)),
                    Some(format!("length <= {}", js_number(max))),
                    Some(format!("length {length}")),
                );
            }
        }
    }
}

/// One-line shape description of a normalized node for diagnostics.
fn describe_out(node: &OutNode) -> String {
    match node {
        OutNode::Null => "null".to_string(),
        OutNode::Bool(true) => "true".to_string(),
        OutNode::Bool(false) => "false".to_string(),
        OutNode::Text(units) => stringify_units(units),
        OutNode::Undef => "undefined".to_string(),
        OutNode::Ref { .. } => "ref".to_string(),
        OutNode::Enum(case) => format!("{case:?}"),
        OutNode::Array(items) => format!("array of length {}", items.len()),
        OutNode::Entries(entries) => {
            let keys: Vec<String> = entries
                .iter()
                .take(5)
                .map(|(key, _)| display_units(key))
                .collect();
            format!("object with keys [{}]", keys.join(", "))
        }
        OutNode::Union { .. } => "union".to_string(),
        OutNode::DefaultRef(_) => "default".to_string(),
        OutNode::EmptyArray => "array of length 0".to_string(),
        OutNode::UpdateOmitted => "omitted".to_string(),
    }
}

/// Whether bounds apply to a stored field value (mirrors `hasBounds`).
fn has_bounds(field: &FieldPlan) -> bool {
    field.length_min.is_some()
        || field.length_max.is_some()
        || field.value_min.is_some()
        || field.value_max.is_some()
        || field.format.is_some()
        || field.distinct_by
}

// ---------------------------------------------------------------------------
// Node validation (mirrors `validateNode`).
// ---------------------------------------------------------------------------

/// Validates one present field value: null, array and base dispatch.
/// Returns `None` after recording a violation; `UPDATE_OMITTED` never
/// arises from present values.
fn validate_node(
    cx: &mut Cx,
    field: &FieldPlan,
    node: usize,
    path: &[PathSeg],
    mode: Mode,
    require_version: bool,
    receiving_trim: bool,
    depth: usize,
) -> Result<Option<OutNode>, Outcome> {
    cx.visit()?;
    match cx.arena.node(node) {
        TransportNode::OwnNull => {
            if field.nullable {
                return Ok(Some(OutNode::Null));
            }
            cx.push(
                path,
                "type",
                "null for a non-nullable type".to_string(),
                Some(format!("non-null {}", field_type_id(field))),
                Some("null".to_string()),
            );
            return Ok(None);
        }
        TransportNode::Missing => {
            cx.push(
                path,
                "type",
                "missing value".to_string(),
                Some(field_type_id(field)),
                Some("undefined".to_string()),
            );
            return Ok(None);
        }
        _ => {}
    }
    if field.array {
        let items = match cx.arena.node(node) {
            TransportNode::Array { items } => items.clone(),
            _ => {
                cx.push(
                    path,
                    "type",
                    "expected an array".to_string(),
                    Some(field_type_id(field)),
                    Some(actual_node(cx.arena, node)),
                );
                return Ok(None);
            }
        };
        // Array elements are complete values even in update partials.
        let mut out = Vec::with_capacity(items.len());
        let mut ok = true;
        for (index, item) in items.iter().enumerate() {
            cx.descend(depth + 1)?;
            let mut item_path = path.to_vec();
            item_path.push(PathSeg::Index(index));
            let element = FieldPlan {
                array: false,
                nullable: false,
                required_array: false,
                ..plan_field_clone(field)
            };
            match validate_base_node(
                cx,
                &element,
                *item,
                &item_path,
                Mode::Create,
                require_version,
                false,
                depth + 1,
            )? {
                Some(OutNode::UpdateOmitted) | None => {
                    ok = false;
                }
                Some(node) => out.push(node),
            }
        }
        if !ok {
            return Ok(None);
        }
        return Ok(Some(OutNode::Array(out)));
    }
    validate_base_node(
        cx,
        field,
        node,
        path,
        mode,
        require_version,
        receiving_trim,
        depth,
    )
}

/// Clones the structural (non-identity) half of a field plan for array
/// element validation: same base, non-array, non-nullable.
fn plan_field_clone(field: &FieldPlan) -> FieldPlan {
    FieldPlan {
        name: field.name.clone(),
        type_id: field.type_id.clone(),
        base: field.base.clone(),
        array: false,
        nullable: false,
        required_array: false,
        required: field.required,
        has_default: false,
        default_ref: None,
        length_min: None,
        length_max: None,
        value_min: None,
        value_max: None,
        trim: None,
        server_only: field.server_only,
        default_origin: field.default_origin.clone(),
        refs: field.refs.clone(),
        format: None,
        distinct_by: false,
        excluded_ids: Vec::new(),
    }
}

/// Deferred-leaf owner for the skew guard (mirrors `base_class`).
fn owner_of(base: &TypeBase) -> LeafOwner {
    match base_class(base) {
        LeafClass::Deferred(owner) => owner,
        _ => LeafOwner::WireCodec,
    }
}

/// Base dispatch for one non-array value.
#[allow(clippy::too_many_arguments)]
fn validate_base_node(
    cx: &mut Cx,
    field: &FieldPlan,
    node: usize,
    path: &[PathSeg],
    mode: Mode,
    require_version: bool,
    receiving_trim: bool,
    depth: usize,
) -> Result<Option<OutNode>, Outcome> {
    match &field.base {
        TypeBase::Scalar { name } if name == "text" => {
            match cx.arena.node(node) {
                TransportNode::Text { units } => Ok(Some(OutNode::Text(units.clone()))),
                _ => {
                    cx.push(
                        path,
                        "type",
                        "text has the wrong wire type".to_string(),
                        Some("text".to_string()),
                        Some(actual_node(cx.arena, node)),
                    );
                    Ok(None)
                }
            }
        }
        TypeBase::Scalar { name } if name == "bool" => match cx.arena.node(node) {
            TransportNode::Bool(flag) => Ok(Some(OutNode::Bool(*flag))),
            _ => {
                cx.push(
                    path,
                    "type",
                    "bool has the wrong wire type".to_string(),
                    Some("boolean".to_string()),
                    Some(actual_node(cx.arena, node)),
                );
                Ok(None)
            }
        },
        TypeBase::Secret => {
            cx.push(
                path,
                "type",
                "secret values have no wire form".to_string(),
                Some("no wire form (secrets are never serialized)".to_string()),
                Some(actual_node(cx.arena, node)),
            );
            Ok(None)
        }
        TypeBase::Enum { cases } => validate_inline_enum(cx, cases, node, path),
        TypeBase::Union { arms } => validate_union(cx, arms, node, path, require_version, depth),
        TypeBase::Nominal { path: nominal } => {
            if let Some(alias) = cx.plan.aliases.iter().find(|alias| alias.name == *nominal) {
                let bounds = (alias.length_min, alias.length_max);
                return validate_alias_text(cx, bounds, node, path, receiving_trim);
            }
            if let Some(contract) = cx
                .plan
                .contracts
                .iter()
                .find(|contract| contract.name == *nominal)
            {
                let contract = contract.clone();
                return validate_contract_value(cx, &contract, node, path, mode, require_version, depth);
            }
            if let Some(enum_def) = cx
                .plan
                .enums
                .iter()
                .find(|enum_def| enum_def.name == *nominal)
            {
                let cases = enum_def.cases.clone();
                return validate_declared_enum(cx, nominal, &cases, node, path);
            }
            validate_model_ref(cx, nominal, node, path, require_version)
        }
        // Covered targets never reach deferred leaves; reaching one is a
        // coverage/execution skew, reported as an explicit deferral.
        other => Err(Outcome::Deferred {
            owner: owner_of(other),
            detail: format!("uncovered leaf at {}", print_base(other)),
        }),
    }
}

/// Inline enum base (mirrors the wire-codec enum messages: the
/// validation path only reaches these for inline enum descriptors).
fn validate_inline_enum(
    cx: &mut Cx,
    cases: &[String],
    node: usize,
    path: &[PathSeg],
) -> Result<Option<OutNode>, Outcome> {
    let expected = format!("one of: {}", cases.join(", "));
    match cx.arena.node(node) {
        TransportNode::Text { units } => {
            let spelled = display_units(units);
            if cases.iter().any(|case| *case == spelled)
                && units == &spelled.encode_utf16().collect::<Vec<u16>>()
            {
                return Ok(Some(OutNode::Enum(spelled)));
            }
            cx.push(
                path,
                "format",
                "enum is malformed".to_string(),
                Some(expected),
                Some(actual_node(cx.arena, node)),
            );
            Ok(None)
        }
        _ => {
            cx.push(
                path,
                "type",
                "enum has the wrong wire type".to_string(),
                Some("a case name".to_string()),
                Some(actual_node(cx.arena, node)),
            );
            Ok(None)
        }
    }
}

/// Declared-enum value through a nominal path (mirrors
/// `validateEnumValue`).
fn validate_declared_enum(
    cx: &mut Cx,
    name: &str,
    cases: &[String],
    node: usize,
    path: &[PathSeg],
) -> Result<Option<OutNode>, Outcome> {
    let expected = format!("one of: {}", cases.join(", "));
    match cx.arena.node(node) {
        TransportNode::Text { units } => {
            let spelled = display_units(units);
            if cases.iter().any(|case| *case == spelled)
                && units == &spelled.encode_utf16().collect::<Vec<u16>>()
            {
                return Ok(Some(OutNode::Enum(spelled)));
            }
            cx.push(
                path,
                "format",
                format!("unknown case {} for enum {name}", stringify_units(units)),
                Some(expected),
                Some(actual_node(cx.arena, node)),
            );
            Ok(None)
        }
        _ => {
            cx.push(
                path,
                "type",
                format!("enum {name} expects a case name"),
                Some(expected),
                Some(actual_node(cx.arena, node)),
            );
            Ok(None)
        }
    }
}

/// Alias-nominal text: decode the text leaf, apply the receiving trim,
/// then enforce the declared alias bounds (mirrors the alias branch).
fn validate_alias_text(
    cx: &mut Cx,
    bounds: (f64, f64),
    node: usize,
    path: &[PathSeg],
    receiving_trim: bool,
) -> Result<Option<OutNode>, Outcome> {
    let units = match cx.arena.node(node) {
        TransportNode::Text { units } => units.clone(),
        _ => {
            cx.push(
                path,
                "type",
                "text has the wrong wire type".to_string(),
                Some("text".to_string()),
                Some(actual_node(cx.arena, node)),
            );
            return Ok(None);
        }
    };
    let stored = if receiving_trim { trim_units(&units) } else { units };
    let before = cx.violations.len();
    let length = scalar_len_units(&stored) as f64;
    if length < bounds.0 {
        cx.push(
            path,
            "bound",
            format!(
                "length {length} is below the minimum of {}",
                js_number(bounds.0)
            ),
            Some(format!("length >= {}", js_number(bounds.0))),
            Some(format!("length {length}")),
        );
    }
    if length > bounds.1 {
        cx.push(
            path,
            "bound",
            format!(
                "length {length} is above the maximum of {}",
                js_number(bounds.1)
            ),
            Some(format!("length <= {}", js_number(bounds.1))),
            Some(format!("length {length}")),
        );
    }
    if cx.violations.len() != before {
        return Ok(None);
    }
    Ok(Some(OutNode::Text(stored)))
}

// ---------------------------------------------------------------------------
// Unions (mirrors `validateUnionValue`).
// ---------------------------------------------------------------------------

/// Resolves one union arm to a field plan for branch validation. Arms
/// name scalars, aliases, contracts, enums or model refs, with optional
/// `[]`/`?` suffixes; anything else stays a declared deferral.
fn arm_field(cx: &Cx, arm: &str) -> Result<FieldPlan, Outcome> {
    let (bare, array, nullable) = parse_arm_suffixes(arm);
    let base = match bare {
        "text" => TypeBase::Scalar {
            name: "text".to_string(),
        },
        "bool" => TypeBase::Scalar {
            name: "bool".to_string(),
        },
        "int" | "decimal" | "money" | "date" | "datetime" | "duration" => {
            return Err(Outcome::Deferred {
                owner: LeafOwner::ExactCodec,
                detail: format!("union arm {arm} waits on the Exact codec release"),
            });
        }
        _ => {
            if cx.plan.aliases.iter().any(|alias| alias.name == bare) {
                TypeBase::Nominal {
                    path: bare.to_string(),
                }
            } else if cx.plan.contracts.iter().any(|contract| contract.name == bare) {
                TypeBase::Nominal {
                    path: bare.to_string(),
                }
            } else if cx.plan.enums.iter().any(|enum_def| enum_def.name == bare) {
                TypeBase::Nominal {
                    path: bare.to_string(),
                }
            } else if bare.contains('(') || bare.contains('|') || bare.contains('<') {
                return Err(Outcome::Deferred {
                    owner: LeafOwner::WireCodec,
                    detail: format!("union arm {arm} waits on its owning codec"),
                });
            } else {
                // Bare model names resolve as model-ref shapes.
                TypeBase::Nominal {
                    path: bare.to_string(),
                }
            }
        }
    };
    Ok(FieldPlan {
        name: arm.to_string(),
        type_id: arm.to_string(),
        base,
        array,
        nullable,
        required_array: false,
        required: false,
        has_default: false,
        default_ref: None,
        length_min: None,
        length_max: None,
        value_min: None,
        value_max: None,
        trim: None,
        server_only: false,
        default_origin: None,
        refs: Vec::new(),
        format: None,
        distinct_by: false,
        excluded_ids: Vec::new(),
    })
}

/// Splits trailing `[]`/`?` arm suffixes (mirrors type-id suffixes).
fn parse_arm_suffixes(arm: &str) -> (&str, bool, bool) {
    let mut bare = arm;
    let mut array = false;
    let mut nullable = false;
    loop {
        if let Some(rest) = bare.strip_suffix("[]") {
            array = true;
            bare = rest;
        } else if let Some(rest) = bare.strip_suffix('?') {
            nullable = true;
            bare = rest;
        } else {
            break;
        }
    }
    (bare, array, nullable)
}

fn validate_union(
    cx: &mut Cx,
    arms: &[String],
    node: usize,
    path: &[PathSeg],
    require_version: bool,
    depth: usize,
) -> Result<Option<OutNode>, Outcome> {
    let entries = match cx.arena.node(node) {
        TransportNode::Entries { entries } => entries.clone(),
        _ => {
            cx.push(
                path,
                "type",
                "union expects an object".to_string(),
                Some("union {type, value}".to_string()),
                Some(actual_node(cx.arena, node)),
            );
            return Ok(None);
        }
    };
    let ordered = dedupe_entries(&entries);
    let mut lookup: HashMap<&[u16], usize> = HashMap::new();
    for (key, target) in &ordered {
        lookup.insert(key.as_slice(), *target);
    }
    let type_key: Vec<u16> = "type".encode_utf16().collect();
    let value_key: Vec<u16> = "value".encode_utf16().collect();
    let mut ok = true;
    for key in ["type", "value"] {
        let units: Vec<u16> = key.encode_utf16().collect();
        if !lookup.contains_key(units.as_slice()) {
            ok = false;
            let mut missing = path.to_vec();
            missing.push(PathSeg::Key(units));
            cx.push(
                &missing,
                "required",
                format!("union is missing {key:?}"),
                Some("union {type, value}".to_string()),
                None,
            );
        }
    }
    for (key, target) in &ordered {
        if key.as_slice() != type_key.as_slice() && key.as_slice() != value_key.as_slice() {
            ok = false;
            let mut extra = path.to_vec();
            extra.push(PathSeg::Key((*key).clone()));
            cx.push(
                &extra,
                "unknown-field",
                format!("union has no field {}", stringify_units(key)),
                Some("union {type, value}".to_string()),
                Some(actual_node(cx.arena, *target)),
            );
        }
    }
    let mut arm: Option<String> = None;
    if let Some(raw) = lookup.get(type_key.as_slice()) {
        let mut discriminator = path.to_vec();
        discriminator.push(PathSeg::Key(type_key.clone()));
        match cx.arena.node(*raw) {
            TransportNode::Text { units } => {
                let name = display_units(units);
                if arms.iter().any(|declared| *declared == name)
                    && units == &name.encode_utf16().collect::<Vec<u16>>()
                {
                    arm = Some(name);
                } else {
                    ok = false;
                    cx.push(
                        &discriminator,
                        "type",
                        "union discriminator names no declared arm".to_string(),
                        Some(format!("one of: {}", arms.join(", "))),
                        Some(actual_node(cx.arena, *raw)),
                    );
                }
            }
            _ => {
                ok = false;
                cx.push(
                    &discriminator,
                    "type",
                    "union discriminator must be text".to_string(),
                    Some("a declared arm name".to_string()),
                    Some(actual_node(cx.arena, *raw)),
                );
            }
        }
    }
    // Union branches are complete values even in update partials.
    let mut inner: Option<OutNode> = None;
    if let (Some(raw), Some(name)) = (lookup.get(value_key.as_slice()), arm.clone()) {
        let branch = arm_field(cx, &name)?;
        let mut value_path = path.to_vec();
        value_path.push(PathSeg::Key(value_key.clone()));
        cx.descend(depth + 1)?;
        match validate_node(cx, &branch, *raw, &value_path, Mode::Create, require_version, false, depth + 1)? {
            Some(OutNode::UpdateOmitted) | None => {
                ok = false;
            }
            Some(value) => {
                inner = Some(value);
            }
        }
    }
    if !ok {
        return Ok(None);
    }
    match (arm, inner) {
        (Some(name), Some(value)) => Ok(Some(OutNode::Union {
            arm: name,
            value: Box::new(value),
        })),
        _ => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Model references (shape check; loads stay host-owned).
// ---------------------------------------------------------------------------

/// Canonical int64 range for ref versions (mirrors `decodeInt64`).
const INT64_MIN: i128 = -9_223_372_036_854_775_808;
const INT64_MAX: i128 = 9_223_372_036_854_775_807;

/// Parses a canonical int64 decimal string (`INT_TEXT` plus range).
fn parse_int64_decimal(units: &[u16]) -> Option<String> {
    if units.is_empty() {
        return None;
    }
    let mut chars = units.iter();
    let negative = *chars.next().unwrap() == b'-' as u16;
    let digits: Vec<u16> = if negative {
        chars.cloned().collect()
    } else {
        units.to_vec()
    };
    if digits.is_empty() || !digits.iter().all(|unit| (*unit >= b'0' as u16) && (*unit <= b'9' as u16)) {
        return None;
    }
    let mut value: i128 = 0;
    for digit in &digits {
        value = value
            .checked_mul(10)?
            .checked_add((digit - b'0' as u16) as i128)?;
    }
    if negative {
        value = -value;
    }
    if value < INT64_MIN || value > INT64_MAX {
        return None;
    }
    Some(value.to_string())
}

/// Model-ref shape validation (mirrors `validateModelRef` over the
/// codec's nominal/model-ref messages; ref loads stay host-owned).
fn validate_model_ref(
    cx: &mut Cx,
    model: &str,
    node: usize,
    path: &[PathSeg],
    require_version: bool,
) -> Result<Option<OutNode>, Outcome> {
    // Bare text is not a record reference (the codec would decode the
    // nominal string, then the record check refuses it).
    if matches!(cx.arena.node(node), TransportNode::Text { .. }) {
        cx.push(
            path,
            "type",
            format!("model {model} expects a record reference"),
            Some(format!("ref {model} ({{id}} or {{id, version}})")),
            Some(actual_node(cx.arena, node)),
        );
        return Ok(None);
    }
    let entries = match cx.arena.node(node) {
        TransportNode::Entries { entries } => entries.clone(),
        _ => {
            cx.push(
                path,
                "type",
                format!("nominal {model} has the wrong wire type"),
                Some(format!(
                    "ref {model} ({{id}} or {{id, version}}), a contract object, or an enum spelling"
                )),
                Some(actual_node(cx.arena, node)),
            );
            return Ok(None);
        }
    };
    // Objects without `id` are dynamic values, never record references.
    let ordered = dedupe_entries(&entries);
    let mut lookup: HashMap<&[u16], usize> = HashMap::new();
    for (key, target) in &ordered {
        lookup.insert(key.as_slice(), *target);
    }
    let id_key: Vec<u16> = "id".encode_utf16().collect();
    let version_key: Vec<u16> = "version".encode_utf16().collect();
    let Some(id_node) = lookup.get(id_key.as_slice()) else {
        cx.push(
            path,
            "type",
            format!("model {model} expects a record reference"),
            Some(format!("ref {model} ({{id}} or {{id, version}})")),
            Some(actual_node(cx.arena, node)),
        );
        return Ok(None);
    };
    let mut ok = true;
    let mut id_path = path.to_vec();
    id_path.push(PathSeg::Key(id_key.clone()));
    let id_units = match cx.arena.node(*id_node) {
        TransportNode::Text { units } if !units.is_empty() => units.clone(),
        TransportNode::Text { .. } => {
            ok = false;
            cx.push(
                &id_path,
                "format",
                format!("ref {model}.id is malformed"),
                Some("non-empty text".to_string()),
                Some(actual_node(cx.arena, *id_node)),
            );
            Vec::new()
        }
        _ => {
            ok = false;
            cx.push(
                &id_path,
                "type",
                format!("ref {model}.id has the wrong wire type"),
                Some("non-empty text".to_string()),
                Some(actual_node(cx.arena, *id_node)),
            );
            Vec::new()
        }
    };
    let mut version: Option<String> = None;
    if let Some(raw) = lookup.get(version_key.as_slice()) {
        let mut version_path = path.to_vec();
        version_path.push(PathSeg::Key(version_key.clone()));
        let what = format!("ref {model} version");
        match cx.arena.node(*raw) {
            TransportNode::Text { units } => match parse_int64_decimal(units) {
                Some(decimal) => {
                    version = Some(decimal);
                }
                None => {
                    ok = false;
                    // Distinguish malformed text from out-of-range digits:
                    // `INT_TEXT` is exactly /^-?\d+$/.
                    let digits_only = {
                        let body = if units.first() == Some(&(b'-' as u16)) {
                            &units[1..]
                        } else {
                            units.as_slice()
                        };
                        !body.is_empty()
                            && body
                                .iter()
                                .all(|unit| (*unit >= b'0' as u16) && (*unit <= b'9' as u16))
                    };
                    if digits_only {
                        cx.push(
                            &version_path,
                            "bound",
                            format!("{what} is out of range"),
                            Some("int in [-9223372036854775808, 9223372036854775807]".to_string()),
                            Some(actual_node(cx.arena, *raw)),
                        );
                    } else {
                        cx.push(
                            &version_path,
                            "format",
                            format!("{what} is malformed"),
                            Some("canonical int64 string".to_string()),
                            Some(actual_node(cx.arena, *raw)),
                        );
                    }
                }
            },
            _ => {
                ok = false;
                cx.push(
                    &version_path,
                    "type",
                    format!("{what} has the wrong wire type"),
                    Some("canonical int64 string".to_string()),
                    Some(actual_node(cx.arena, *raw)),
                );
            }
        }
    }
    // `{id, version}` is the mutation shape; anything beyond it is unknown.
    for (key, target) in &ordered {
        if key.as_slice() != id_key.as_slice() && key.as_slice() != version_key.as_slice() {
            ok = false;
            let mut extra = path.to_vec();
            extra.push(PathSeg::Key((*key).clone()));
            cx.push(
                &extra,
                "unknown-field",
                format!("ref {model} has no field {}", stringify_units(key)),
                Some(format!("ref {model} {{id}} or {{id, version}}")),
                Some(actual_node(cx.arena, *target)),
            );
        }
    }
    if !ok {
        return Ok(None);
    }
    if require_version && version.is_none() {
        let mut version_path = path.to_vec();
        version_path.push(PathSeg::Key(version_key.clone()));
        cx.push(
            &version_path,
            "required",
            format!("mutation input ref to {model} requires an expected version"),
            Some(format!("ref {model} {{id, version}}")),
            None,
        );
        return Ok(None);
    }
    Ok(Some(OutNode::Ref {
        model: model.to_string(),
        id: id_units,
        version,
    }))
}

// ---------------------------------------------------------------------------
// Contracts and operations (mirror `validateContractValue` /
// operation input validation).
// ---------------------------------------------------------------------------

/// Validates one contract object: unknown fields first (deduped entry
/// order), then declared fields in plan order with trim-then-bounds.
fn validate_contract_value(
    cx: &mut Cx,
    contract: &ContractPlan,
    node: usize,
    path: &[PathSeg],
    mode: Mode,
    require_version: bool,
    depth: usize,
) -> Result<Option<OutNode>, Outcome> {
    let entries = match cx.arena.node(node) {
        TransportNode::Entries { entries } => entries.clone(),
        _ => {
            cx.push(
                path,
                "type",
                format!("contract {} expects an object", contract.name),
                Some(format!("contract {}", contract.name)),
                Some(actual_node(cx.arena, node)),
            );
            return Ok(None);
        }
    };
    let ordered = dedupe_entries(&entries);
    let mut lookup: HashMap<&[u16], usize> = HashMap::new();
    for (key, target) in &ordered {
        lookup.insert(key.as_slice(), *target);
    }
    let known: Vec<Vec<u16>> = contract
        .fields
        .iter()
        .map(|field| field.name.encode_utf16().collect())
        .collect();
    let mut ok = true;
    for (key, target) in &ordered {
        if !known.iter().any(|declared| declared == *key) {
            ok = false;
            let mut extra = path.to_vec();
            extra.push(PathSeg::Key((*key).clone()));
            let expected = if known.is_empty() {
                "no declared fields".to_string()
            } else {
                format!(
                    "one of: {}",
                    contract
                        .fields
                        .iter()
                        .map(|field| field.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            cx.push(
                &extra,
                "unknown-field",
                format!(
                    "contract {} has no field {}",
                    contract.name,
                    stringify_units(key)
                ),
                Some(expected),
                Some(actual_node(cx.arena, *target)),
            );
        }
    }
    let mut out: Vec<(Vec<u16>, OutNode)> = Vec::with_capacity(contract.fields.len());
    for field in &contract.fields {
        let key: Vec<u16> = field.name.encode_utf16().collect();
        let mut field_path = path.to_vec();
        field_path.push(PathSeg::Key(key.clone()));
        match lookup.get(key.as_slice()) {
            None => match omitted(cx, field, &field_path, mode)? {
                Omit::Fail => {
                    ok = false;
                }
                Omit::Drop => {}
                Omit::UpdateOmitted => {
                    out.push((key, OutNode::UpdateOmitted));
                }
                Omit::Out(node) => {
                    out.push((key, node));
                }
            },
            Some(target) => {
                let before = cx.violations.len();
                match validate_node(
                    cx,
                    field,
                    *target,
                    &field_path,
                    mode,
                    require_version,
                    field.trim == Some(true),
                    depth,
                )? {
                    None => {
                        ok = false;
                    }
                    Some(decoded) => {
                        // Normalization runs before constraints; trim
                        // fields hold plain strings, never partials.
                        let stored = match &decoded {
                            OutNode::Text(units) if field.trim == Some(true) => {
                                OutNode::Text(trim_units(units))
                            }
                            _ => decoded,
                        };
                        let stored_is_plain = !matches!(
                            stored,
                            OutNode::UpdateOmitted | OutNode::Null
                        );
                        out.push((key, stored.clone()));
                        if has_bounds(field)
                            && cx.violations.len() == before
                            && stored_is_plain
                            && !matches!(stored, OutNode::UpdateOmitted)
                        {
                            check_bounds(cx, field, &stored, &field_path);
                            if cx.violations.len() != before {
                                ok = false;
                            }
                        }
                        // A failed bound drops the stored key: the whole
                        // value fails, so no partial output publishes.
                        if cx.violations.len() != before {
                            out.pop();
                        }
                    }
                }
            }
        }
    }
    if !ok {
        return Ok(None);
    }
    Ok(Some(OutNode::Entries(out)))
}

/// Validates one operation call: `operation_id` stays unknown for
/// queries; mutations require a non-empty text id after the inputs.
#[allow(clippy::too_many_arguments)]
fn validate_operation_value(
    cx: &mut Cx,
    operation: &OperationPlan,
    op_name: &str,
    node: usize,
    path: &[PathSeg],
    depth: usize,
) -> Result<Option<OutNode>, Outcome> {
    let entries = match cx.arena.node(node) {
        TransportNode::Entries { entries } => entries.clone(),
        _ => {
            cx.push(
                path,
                "type",
                format!("operation {op_name} expects an argument object"),
                Some(format!("inputs for {op_name}")),
                Some(actual_node(cx.arena, node)),
            );
            return Ok(None);
        }
    };
    let ordered = dedupe_entries(&entries);
    let mut lookup: HashMap<&[u16], usize> = HashMap::new();
    for (key, target) in &ordered {
        lookup.insert(key.as_slice(), *target);
    }
    let declared: Vec<&str> = operation
        .inputs
        .iter()
        .map(|input| input.name.as_str())
        .collect();
    let expected_args = if declared.is_empty() && !operation.mutation {
        "no declared arguments".to_string()
    } else {
        let mut names: Vec<&str> = declared.clone();
        if operation.mutation {
            names.push("operation_id");
        }
        format!("one of: {}", names.join(", "))
    };
    let operation_id_key: Vec<u16> = "operation_id".encode_utf16().collect();
    let mut ok = true;
    for (key, target) in &ordered {
        if key.as_slice() == operation_id_key.as_slice() && operation.mutation {
            continue;
        }
        if !declared.iter().any(|name| *name == display_units(key)) {
            ok = false;
            let mut extra = path.to_vec();
            extra.push(PathSeg::Key((*key).clone()));
            cx.push(
                &extra,
                "unknown-argument",
                format!(
                    "operation {op_name} has no argument {}",
                    stringify_units(key)
                ),
                Some(expected_args.clone()),
                Some(actual_node(cx.arena, *target)),
            );
        }
    }
    // Selected mode is fixed before evaluation: operations always run
    // create nesting with mutation-driven version requirements.
    let options_mode = Mode::Create;
    let require_version = operation.mutation;
    let mut out: Vec<(Vec<u16>, OutNode)> = Vec::with_capacity(operation.inputs.len() + 1);
    for input in &operation.inputs {
        let key: Vec<u16> = input.name.encode_utf16().collect();
        let mut input_path = path.to_vec();
        input_path.push(PathSeg::Key(key.clone()));
        match lookup.get(key.as_slice()) {
            None => match omitted(cx, input, &input_path, options_mode)? {
                Omit::Fail => {
                    ok = false;
                }
                Omit::Drop => {}
                Omit::UpdateOmitted => {
                    out.push((key, OutNode::UpdateOmitted));
                }
                Omit::Out(node) => {
                    out.push((key, node));
                }
            },
            Some(target) => {
                let before = cx.violations.len();
                match validate_node(
                    cx,
                    input,
                    *target,
                    &input_path,
                    options_mode,
                    require_version,
                    input.trim == Some(true),
                    depth,
                )? {
                    None => {
                        ok = false;
                    }
                    Some(decoded) => {
                        let stored = match &decoded {
                            OutNode::Text(units) if input.trim == Some(true) => {
                                OutNode::Text(trim_units(units))
                            }
                            _ => decoded,
                        };
                        out.push((key, stored.clone()));
                        if has_bounds(input)
                            && cx.violations.len() == before
                            && !matches!(stored, OutNode::Null)
                        {
                            check_bounds(cx, input, &stored, &input_path);
                        }
                        if cx.violations.len() != before {
                            ok = false;
                            out.pop();
                        }
                    }
                }
            }
        }
    }
    if operation.mutation {
        let mut id_path = path.to_vec();
        id_path.push(PathSeg::Key(operation_id_key.clone()));
        match lookup.get(operation_id_key.as_slice()) {
            None => {
                ok = false;
                cx.push(
                    &id_path,
                    "required",
                    format!("mutation {op_name} requires operation_id"),
                    Some("non-empty text".to_string()),
                    None,
                );
            }
            Some(raw) => match cx.arena.node(*raw) {
                TransportNode::Text { units } if !units.is_empty() => {
                    out.push((operation_id_key, OutNode::Text(units.clone())));
                }
                TransportNode::Text { .. } => {
                    ok = false;
                    cx.push(
                        &id_path,
                        "format",
                        "operation_id must be non-empty".to_string(),
                        Some("non-empty text".to_string()),
                        Some(actual_node(cx.arena, *raw)),
                    );
                }
                _ => {
                    ok = false;
                    cx.push(
                        &id_path,
                        "type",
                        "operation_id must be text".to_string(),
                        Some("non-empty text".to_string()),
                        Some(actual_node(cx.arena, *raw)),
                    );
                }
            },
        }
    }
    if !ok || !cx.violations.is_empty() {
        return Ok(None);
    }
    Ok(Some(OutNode::Entries(out)))
}

// ---------------------------------------------------------------------------
// Whole-profile entry.
// ---------------------------------------------------------------------------

/// Runs one whole `values/v1` profile action: coverage first (declared
/// deferral before any traversal), then ordered validation with
/// accumulated violations. Failures never publish partial values.
pub fn execute(
    arena: &InputArena,
    plan: &Plan,
    resolve: &dyn Fn(&str) -> Option<Meta>,
    target: &Target,
    budgets: ExecBudgets,
) -> Outcome {
    if let Some((owner, path)) = target_gap(plan, target, resolve) {
        return Outcome::Deferred {
            owner,
            detail: format!("target reaches a leaf owned by {} at {path}", owner.reason()),
        };
    }
    let mut cx = Cx {
        arena,
        plan,
        violations: Vec::new(),
        visited: 0,
        budgets,
    };
    let root = arena.root();
    let result = match target {
        Target::Contract { name, mode } => {
            let Some(contract) = plan.contracts.iter().find(|contract| contract.name == *name)
            else {
                return Outcome::Deferred {
                    owner: LeafOwner::WireCodec,
                    detail: format!("unknown contract target {name}"),
                };
            };
            let contract = contract.clone();
            match validate_contract_value(&mut cx, &contract, root, &[], *mode, false, 0) {
                Ok(node) => node,
                Err(outcome) => return outcome,
            }
        }
        Target::Operation { name } => {
            let Some(operation) = plan
                .operations
                .iter()
                .find(|operation| operation.name == *name)
            else {
                return Outcome::Deferred {
                    owner: LeafOwner::WireCodec,
                    detail: format!("unknown operation target {name}"),
                };
            };
            let operation = operation.clone();
            match validate_operation_value(&mut cx, &operation, name, root, &[], 0) {
                Ok(node) => node,
                Err(outcome) => return outcome,
            }
        }
    };
    match result {
        Some(node) => {
            debug_assert!(cx.violations.is_empty());
            if cx.violations.is_empty() {
                Outcome::Valid(node)
            } else {
                Outcome::Invalid(std::mem::take(&mut cx.violations))
            }
        }
        None => Outcome::Invalid(std::mem::take(&mut cx.violations)),
    }
}

// ---------------------------------------------------------------------------
// JSON output (frame trees and violation records for the host seam).
// ---------------------------------------------------------------------------

/// Serializes one normalized node to frame JSON: the retained-result
/// encoding consumed at the real materialization seam.
pub fn out_to_json(node: &OutNode) -> Value {
    match node {
        OutNode::Null => json!({"t": "null"}),
        OutNode::Bool(flag) => json!({"t": "bool", "v": flag}),
        OutNode::Text(units) => json!({"t": "text", "units": units}),
        OutNode::Undef => json!({"t": "undef"}),
        OutNode::Ref { model, id, version } => {
            let mut value = json!({"t": "ref", "model": model, "id": id});
            if let Some(decimal) = version {
                value["version"] = Value::String(decimal.clone());
            }
            value
        }
        OutNode::Enum(case) => json!({"t": "enum", "case": case}),
        OutNode::Array(items) => {
            json!({"t": "array", "items": items.iter().map(out_to_json).collect::<Vec<_>>()})
        }
        OutNode::Entries(entries) => {
            json!({"t": "entries", "entries": entries.iter().map(|(key, value)| json!([key, out_to_json(value)])).collect::<Vec<_>>()})
        }
        OutNode::Union { arm, value } => {
            json!({"t": "union", "arm": arm, "value": out_to_json(value)})
        }
        OutNode::DefaultRef(key) => json!({"t": "default-ref", "key": key}),
        OutNode::EmptyArray => json!({"t": "empty-array"}),
        OutNode::UpdateOmitted => json!({"t": "update-omitted"}),
    }
}

fn path_to_json(path: &[PathSeg]) -> Value {
    Value::Array(
        path.iter()
            .map(|segment| match segment {
                PathSeg::Key(units) => json!({"k": units}),
                PathSeg::Index(index) => json!({"i": index}),
            })
            .collect(),
    )
}

fn violation_to_json(violation: &Violation) -> Value {
    let mut value = json!({
        "path": path_to_json(&violation.path),
        "code": violation.code,
        "message": violation.message,
    });
    if let Some(expected) = &violation.expected {
        value["expected"] = Value::String(expected.clone());
    }
    if let Some(actual) = &violation.actual {
        value["actual"] = Value::String(actual.clone());
    }
    value
}

/// Serializes one outcome for the envelope: valid frames, ordered
/// violations, declared deferrals and limit refusals.
pub fn outcome_to_json(outcome: &Outcome) -> Value {
    match outcome {
        Outcome::Valid(node) => json!({"outcome": "valid", "value": out_to_json(node)}),
        Outcome::Invalid(violations) => json!({
            "outcome": "invalid",
            "violations": violations.iter().map(violation_to_json).collect::<Vec<_>>(),
        }),
        Outcome::Deferred { owner, detail } => json!({
            "outcome": "deferred",
            "reason": owner.reason(),
            "detail": detail,
        }),
        Outcome::Limit { code, check } => json!({
            "outcome": "limit",
            "code": code,
            "check": check,
        }),
    }
}

/// Alias bounds lookup for host-side registration parity checks.
pub fn alias_bounds(plan: &Plan, name: &str) -> Option<(f64, f64)> {
    plan.aliases
        .iter()
        .find(|alias| alias.name == name)
        .map(|alias| (alias.length_min, alias.length_max))
}

/// Carried-duty summary for plan introspection.
pub fn field_duties(field: &FieldPlan) -> Value {
    json!({
        "format": field.format,
        "distinct_by": field.distinct_by,
        "excluded_ids": field.excluded_ids,
    })
}

/// Keeps `AliasPlan` linked into this module's duty surface.
pub fn _alias_plan_kind(_alias: &AliasPlan) -> &'static str {
    "text-name"
}

