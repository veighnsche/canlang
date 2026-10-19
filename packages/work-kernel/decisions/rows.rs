//! W04.1 — Native ordered rows and identity sets.
//!
//! Data-only Rust port of `src/rows.ts` (frozen at the W02.2 extraction,
//! proven against the same independent TS oracle corpus
//! `conformance/fixtures/rows/`). N03 replaces the standalone rustc test
//! route with an isolated private Cargo project containing exact copies of this
//! file and numeric_text.rs, with ryu-js =1.0.3 (default features off).
//! Original embedded vectors and immutable caller witnesses run there.
//! Official product Cargo/root registration remains pending. Integrator registration
//! (lib.rs assembly + differential execution) is W04.4's; shared shapes
//! stay duplicated here until then.
//!
//! Parity model (verified against donor sources + frozen vectors):
//! - Text is lossless UTF-16 (`U16` code units). Lone surrogates are
//!   preserved data; ordinary conversion to Rust `String` is forbidden
//!   on value paths (only validated-ASCII identifiers cross, and the
//!   encoder below handles the rest code-unit by code-unit).
//! - Identity/set order is UTF-16 code-unit order (bare lexicographic
//!   `u16` comparison — exactly JS default `.sort()`).
//! - Counts/instants are f64 with JS arithmetic; validated counts keep
//!   exact bits (`-0` preserved, never normalized).
//! - Object key enumeration matches JS: canonical integer-like keys
//!   ascending first, then the rest in insertion order. Traversal and
//!   `JSON.stringify` share it, so first-fault order agrees.
//! - `JSON.stringify` for fault messages is V8-compatible (escapes,
//!   number rendering including `1e+21`, key order, separators).
//! - `encodeURIComponent` reproduces the unreserved set and uppercase
//!   hex; lone surrogates fail with engine-variable text under the
//!   pinned `URIError` name (vectors compare the name only).
//! - JSON-safety traversal keeps the donor's never-pruned seen set
//!   over reference identity (`Rc` pointer): DAG-shared references
//!   report cyclic exactly like the TS original (pinned vector).
//! - Unrepresentable inputs have no Rust vector and are documented:
//!   true reference cycles (values are owned trees), function/symbol
//!   values (never cross the value model). Everything else in the TS
//!   corpus ports 1:1 by case id.
//! - Error parity is name/code/message; class identity differs by
//!   module on every backend (same rule as the TS suites).

use super::numeric_text::{json_token as js_json_num, string as js_num};
use super::utf16_json::append as json_escape_into;

use std::collections::HashSet;
use std::rc::Rc;

/// Lossless UTF-16 text. Ordering is bare code-unit order (JS sort).
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct U16(pub Vec<u16>);

impl U16 {
    pub fn from_utf8(s: &str) -> U16 {
        U16(s.encode_utf16().collect())
    }
    pub fn from_vec(v: Vec<u16>) -> U16 {
        U16(v)
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    /// ASCII-only equality against a Rust literal (for fixed field names).
    pub fn eq_ascii(&self, s: &str) -> bool {
        self.0.len() == s.len() && self.0.iter().zip(s.bytes()).all(|(u, b)| *u == b as u16)
    }
    /// Canonical array-index value, if this key is one (JS semantics:
    /// all-ASCII-digits, no leading zero unless the key is `0` itself,
    /// numeric value strictly below 2^32 - 1).
    pub fn array_index(&self) -> Option<u64> {
        if self.0.is_empty() || !self.0.iter().all(|u| matches!(u, 0x30..=0x39)) {
            return None;
        }
        if self.0.len() > 1 && self.0[0] == b'0' as u16 {
            return None;
        }
        let mut v: u64 = 0;
        for u in self.0.iter() {
            v = v.checked_mul(10)?.checked_add((u - b'0' as u16) as u64)?;
        }
        if v < 4_294_967_295 {
            Some(v)
        } else {
            None
        }
    }
    /// Lossy debug rendering (failure messages only, never parity data).
    fn debug_escaped(&self) -> String {
        let mut out = String::from("\"");
        let mut i = 0;
        while i < self.0.len() {
            let u = self.0[i];
            if (0xD800..0xDC00).contains(&u) && i + 1 < self.0.len() {
                let lo = self.0[i + 1];
                if (0xDC00..0xE000).contains(&lo) {
                    let cp = 0x10000 + (((u - 0xD800) as u32) << 10) + (lo - 0xDC00) as u32;
                    out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
                    i += 2;
                    continue;
                }
            }
            out.push(char::from_u32(u as u32).unwrap_or('\u{FFFD}'));
            i += 1;
        }
        out.push('"');
        out
    }
}

impl std::fmt::Debug for U16 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.debug_escaped())
    }
}

/// JS value model. Objects/arrays ride behind `Rc` so DAG-shared
/// references keep their identity for the seen-set traversal. `Undef` and
/// `Func` ride the explicit wire tags (never silent nulls or host traversal
/// refusals); `Opaque` carries donor-unread by-reference positions through
/// decisions that never inspect them; `Ref` marks an unresolvable identity
/// back-reference (a true cycle through the wire), which safety reports as
/// cyclic exactly like the donor.
#[derive(Clone)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(U16),
    Arr(Rc<Vec<Value>>),
    Obj(Rc<Vec<(U16, Value)>>),
    Undef,
    Func,
    Opaque,
    Ref,
}

impl PartialEq for Value {
    fn eq(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Null, Value::Null) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            // Bit equality: distinguishes -0 from +0, equates NaNs.
            (Value::Num(a), Value::Num(b)) => a.to_bits() == b.to_bits(),
            (Value::Str(a), Value::Str(b)) => a == b,
            (Value::Arr(a), Value::Arr(b)) => a == b,
            (Value::Obj(a), Value::Obj(b)) => a == b,
            (Value::Undef, Value::Undef) => true,
            (Value::Func, Value::Func) => true,
            (Value::Opaque, Value::Opaque) => true,
            (Value::Ref, Value::Ref) => true,
            _ => false,
        }
    }
}

impl std::fmt::Debug for Value {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&js_stringify(self))
    }
}

impl Value {
    pub fn deep_clone(&self) -> Value {
        match self {
            Value::Null => Value::Null,
            Value::Bool(b) => Value::Bool(*b),
            Value::Num(n) => Value::Num(*n),
            Value::Str(s) => Value::Str(s.clone()),
            Value::Arr(a) => Value::Arr(Rc::new(a.iter().map(|v| v.deep_clone()).collect())),
            Value::Obj(o) => Value::Obj(Rc::new(
                o.iter().map(|(k, v)| (k.clone(), v.deep_clone())).collect(),
            )),
            Value::Undef => Value::Undef,
            Value::Func => Value::Func,
            Value::Opaque => Value::Opaque,
            Value::Ref => Value::Ref,
        }
    }
    /// Shallow clone: containers share their allocation (preserves
    /// reference identity for pre-traversal staging, like JS spreads).
    pub fn shared_clone(&self) -> Value {
        match self {
            Value::Null => Value::Null,
            Value::Bool(b) => Value::Bool(*b),
            Value::Num(n) => Value::Num(*n),
            Value::Str(s) => Value::Str(s.clone()),
            Value::Arr(a) => Value::Arr(Rc::clone(a)),
            Value::Obj(o) => Value::Obj(Rc::clone(o)),
            Value::Undef => Value::Undef,
            Value::Func => Value::Func,
            Value::Opaque => Value::Opaque,
            Value::Ref => Value::Ref,
        }
    }
    fn as_obj(&self) -> Option<&Vec<(U16, Value)>> {
        match self {
            Value::Obj(o) => Some(o),
            _ => None,
        }
    }
}

/// JS enumeration order: canonical integer-like keys ascending first,
/// then the rest in insertion order. Shared by traversal and stringify.
fn enum_entries(pairs: &[(U16, Value)]) -> Vec<&(U16, Value)> {
    let mut indexed: Vec<(u64, usize, &(U16, Value))> = Vec::new();
    let mut rest: Vec<&(U16, Value)> = Vec::new();
    for (i, pair) in pairs.iter().enumerate() {
        match pair.0.array_index() {
            Some(n) => indexed.push((n, i, pair)),
            None => rest.push(pair),
        }
    }
    indexed.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut out: Vec<&(U16, Value)> = indexed.into_iter().map(|(_, _, p)| p).collect();
    out.extend(rest);
    out
}

/// V8-compatible `JSON.stringify` for the value model.
fn js_stringify(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::Num(n) => js_json_num(*n),
        Value::Str(s) => {
            let mut out = String::new();
            json_escape_into(&s.0, &mut out);
            out
        }
        Value::Arr(a) => {
            let mut out = String::from("[");
            for (i, e) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&js_stringify(e));
            }
            out.push(']');
            out
        }
        Value::Obj(o) => {
            let mut out = String::from("{");
            for (i, (k, e)) in enum_entries(o).iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                json_escape_into(&k.0, &mut out);
                out.push(':');
                out.push_str(&js_stringify(e));
            }
            out.push('}');
            out
        }
        // Only reachable inside `${...}` interpolation of exotic wire tags,
        // where the donor renders the undefined stringify result.
        Value::Undef | Value::Func | Value::Opaque | Value::Ref => "undefined".to_string(),
    }
}

/// `encodeURIComponent` over UTF-16 units (unreserved set + uppercase
/// hex, exactly). Lone surrogates fail under the pinned `URIError`
/// name with engine-variable text (vectors compare the name only).
fn encode_uri_component(units: &[u16]) -> Result<U16, RowsError> {
    super::uri_component::encode(units).map(U16).map_err(|_| RowsError {
            name: "URIError".to_string(),
            code: None,
            message: "URI malformed".to_string(),
        })
}

/// Explicit producer direction. No default; no fallthrough.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Direction {
    Work,
    State,
}

/// Parity error: name/code/message match the TS donors per direction.
/// (`URIError` text is engine-variable; compare the name only.)
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RowsError {
    pub name: String,
    pub code: Option<String>,
    pub message: String,
}

fn fail(direction: Direction, message: String) -> RowsError {
    match direction {
        Direction::Work => RowsError {
            name: "KernelTableError".to_string(),
            code: None,
            message,
        },
        Direction::State => RowsError {
            name: "StateError".to_string(),
            code: Some("validation".to_string()),
            message,
        },
    }
}

fn get<'a>(record: &'a [(U16, Value)], field: &str) -> Option<&'a Value> {
    record
        .iter()
        .find(|(k, _)| k.eq_ascii(field))
        .map(|(_, v)| v)
}

fn check_record<'a>(
    value: &'a Value,
    what: &str,
    direction: Direction,
) -> Result<&'a Vec<(U16, Value)>, RowsError> {
    match value.as_obj() {
        Some(o) => Ok(o),
        None => Err(fail(direction, format!("{} must be an object.", what))),
    }
}

fn check_string(
    record: &[(U16, Value)],
    field: &str,
    what: &str,
    direction: Direction,
) -> Result<U16, RowsError> {
    match get(record, field) {
        Some(Value::Str(s)) if !s.is_empty() => Ok(s.clone()),
        _ => Err(fail(
            direction,
            format!("{what}.{field} must be a non-empty string."),
        )),
    }
}

fn check_nullable_string(
    record: &[(U16, Value)],
    field: &str,
    what: &str,
    direction: Direction,
) -> Result<Option<U16>, RowsError> {
    match get(record, field) {
        None => Err(fail(
            direction,
            format!("{what}.{field} must be a string or null."),
        )),
        Some(Value::Null) => Ok(None),
        Some(Value::Str(s)) => Ok(Some(s.clone())),
        _ => Err(fail(
            direction,
            format!("{what}.{field} must be a string or null."),
        )),
    }
}

fn check_count(
    record: &[(U16, Value)],
    field: &str,
    what: &str,
    direction: Direction,
) -> Result<f64, RowsError> {
    match get(record, field) {
        Some(Value::Num(n)) if n.fract() == 0.0 && *n >= 0.0 => Ok(*n),
        _ => Err(fail(
            direction,
            format!("{what}.{field} must be an integer >= 0."),
        )),
    }
}

fn check_instant(
    record: &[(U16, Value)],
    field: &str,
    what: &str,
    direction: Direction,
) -> Result<f64, RowsError> {
    match get(record, field) {
        Some(Value::Num(n)) if n.is_finite() && *n >= 0.0 => Ok(*n),
        _ => Err(fail(
            direction,
            format!("{what}.{field} must be finite epoch ms >= 0."),
        )),
    }
}

fn check_nullable_instant(
    record: &[(U16, Value)],
    field: &str,
    what: &str,
    direction: Direction,
) -> Result<Option<f64>, RowsError> {
    match get(record, field) {
        None => Err(fail(
            direction,
            format!("{what}.{field} must be finite epoch ms or null."),
        )),
        Some(Value::Null) => Ok(None),
        Some(Value::Num(n)) if n.is_finite() && *n >= 0.0 => Ok(Some(*n)),
        _ => Err(fail(
            direction,
            format!("{what}.{field} must be finite epoch ms or null."),
        )),
    }
}

/// Deep JSON-safety: work-profile rows must survive the store JSON
/// round-trip. The seen set never prunes (donor-verbatim): DAG-shared
/// references report cyclic exactly like true cycles.
fn check_json_safe(value: &Value, what: &str) -> Result<(), RowsError> {
    fn visit(
        node: &Value,
        path: &mut String,
        seen: &mut HashSet<usize>,
        what: &str,
    ) -> Result<(), RowsError> {
        match node {
            Value::Null | Value::Bool(_) => Ok(()),
            Value::Str(_) => Ok(()),
            Value::Num(n) => {
                if n.is_finite() {
                    Ok(())
                } else {
                    Err(RowsError {
                        name: "KernelTableError".to_string(),
                        code: None,
                        message: format!("{what}{path} must be finite JSON."),
                    })
                }
            }
            Value::Undef | Value::Func | Value::Opaque => Err(RowsError {
                name: "KernelTableError".to_string(),
                code: None,
                message: format!("{what}{path} is not JSON-safe."),
            }),
            Value::Ref => Err(RowsError {
                name: "KernelTableError".to_string(),
                code: None,
                message: format!("{what}{path} is cyclic."),
            }),
            Value::Arr(a) => {
                let id = Rc::as_ptr(a) as usize;
                if !seen.insert(id) {
                    return Err(RowsError {
                        name: "KernelTableError".to_string(),
                        code: None,
                        message: format!("{what}{path} is cyclic."),
                    });
                }
                for (i, e) in a.iter().enumerate() {
                    let base = path.len();
                    path.push_str(&format!("[{i}]"));
                    visit(e, path, seen, what)?;
                    path.truncate(base);
                }
                Ok(())
            }
            Value::Obj(o) => {
                let id = Rc::as_ptr(o) as usize;
                if !seen.insert(id) {
                    return Err(RowsError {
                        name: "KernelTableError".to_string(),
                        code: None,
                        message: format!("{what}{path} is cyclic."),
                    });
                }
                for (k, e) in enum_entries(o).iter() {
                    let base = path.len();
                    path.push('.');
                    // Path segments render lossy (failure text only).
                    for u in k.0.iter() {
                        path.push(char::from_u32(*u as u32).unwrap_or('\u{FFFD}'));
                    }
                    visit(e, path, seen, what)?;
                    path.truncate(base);
                }
                Ok(())
            }
        }
    }
    visit(value, &mut String::new(), &mut HashSet::new(), what)
}

fn check_id_component(value: &U16, short: &str, direction: Direction) -> Result<U16, RowsError> {
    if value.is_empty() {
        return Err(match direction {
            Direction::Work => fail(
                direction,
                format!("fanout {short} must be a non-empty string."),
            ),
            Direction::State => fail(
                direction,
                format!("Fanout {short} must be a non-empty string."),
            ),
        });
    }
    Ok(value.clone())
}

fn check_cohort(value: Option<&Value>, direction: Direction) -> Result<U16, RowsError> {
    match value {
        Some(Value::Str(s)) if s.eq_ascii("model") || s.eq_ascii("anchored-collection") => {
            Ok(s.clone())
        }
        _ => {
            let shown = value
                .map(js_stringify)
                .unwrap_or_else(|| "undefined".to_string());
            Err(match direction {
                Direction::Work => fail(
                    direction,
                    format!("fanout cohort must be model or anchored-collection, got {shown}."),
                ),
                Direction::State => fail(
                    direction,
                    format!("Fanout cohort must be model or anchored-collection, got {shown}."),
                ),
            })
        }
    }
}

fn check_meta(meta: &NewRowMeta, what: &str, direction: Direction) -> Result<(), RowsError> {
    if !meta.now_ms.is_finite() || meta.now_ms < 0.0 {
        return Err(fail(
            direction,
            format!("{what}: nowMs must be finite epoch ms >= 0."),
        ));
    }
    if meta.actor.is_empty() {
        return Err(fail(
            direction,
            format!("{what}: actor must be a non-empty string."),
        ));
    }
    Ok(())
}

fn new_row_core(
    id: U16,
    data: &Value,
    meta: &NewRowMeta,
    what: &str,
    direction: Direction,
) -> Result<StoredRow, RowsError> {
    check_meta(meta, what, direction)?;
    if direction == Direction::Work {
        check_json_safe(data, &format!("{what} data"))?;
    }
    Ok(StoredRow {
        id,
        version: 1.0,
        created: meta.now_ms,
        updated: meta.now_ms,
        created_by: meta.actor.clone(),
        updated_by: meta.actor.clone(),
        archived_at: Value::Null,
        parent: Value::Null,
        data: data.deep_clone(),
    })
}

/* -- Kernel tables (work-only). -- */

pub const WORK_DISPATCH_MODEL: &str = "work.dispatch";
pub const WORK_OCCURRENCE_MODEL: &str = "work.occurrence";
pub const WORK_SCHEDULE_MODEL: &str = "work.schedule";
pub const WORK_EVERY_SLOT_MODEL: &str = "work.every_slot";
pub const WORK_SUPERSESSION_MODEL: &str = "work.supersession";

#[derive(Clone, PartialEq, Debug)]
pub struct DispatchRowData {
    pub intent_id: U16,
    pub operation_id: U16,
    pub source: U16,
    pub occurrence_index: f64,
    pub origin_occurrence: Option<U16>,
    pub state: U16,
    pub attempts: f64,
    pub claim_id: Option<U16>,
    pub claimed_at_ms: Option<f64>,
    pub guard_verdict: Option<bool>,
    pub delivery_id: Option<U16>,
    pub error_code: Option<U16>,
    pub error_message: Option<U16>,
    pub available_at_ms: Option<f64>,
    pub first_attempt_at_ms: Option<f64>,
    pub retry_class: Option<U16>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct OccurrenceRowData {
    pub occurrence_id: U16,
    pub status: U16,
    pub result: Value,
    pub code: Option<U16>,
    pub message: Option<U16>,
    pub recorded_at_ms: f64,
}

#[derive(Clone, PartialEq, Debug)]
pub struct ScheduleRowData {
    pub occurrence_id: U16,
    pub key: U16,
    pub scope_app: U16,
    pub scope_owner: U16,
    pub scope_owner_package: U16,
    pub at: f64,
    pub event: U16,
    pub payload: Value,
    pub replaces: Option<U16>,
    pub state: U16,
}

#[derive(Clone, PartialEq, Debug)]
pub struct EverySlotRowData {
    pub scope_key: U16,
    pub app: U16,
    pub handler: U16,
    pub scope: U16,
    pub owner: U16,
    pub slot: f64,
}

#[derive(Clone, PartialEq, Debug)]
pub struct SupersessionRowData {
    pub outbox_id: U16,
    pub by_occurrence_id: Option<U16>,
    pub marked_at_ms: f64,
}

fn is_outbox_state(s: &U16) -> bool {
    s.eq_ascii("pending")
        || s.eq_ascii("claimed")
        || s.eq_ascii("delivered")
        || s.eq_ascii("failed")
        || s.eq_ascii("uncertain")
        || s.eq_ascii("dead")
}

fn is_schedule_state(s: &U16) -> bool {
    s.eq_ascii("pending")
        || s.eq_ascii("admitted")
        || s.eq_ascii("superseded")
        || s.eq_ascii("cancelled")
}

/// Read one dispatch row's data, failing closed on any shape drift.
pub fn read_dispatch_row(row: &StoredRow) -> Result<DispatchRowData, RowsError> {
    let d = Direction::Work;
    let data = check_record(&row.data, "work.dispatch data", d)?;
    let state = check_string(data, "state", "work.dispatch", d)?;
    if !is_outbox_state(&state) {
        return Err(fail(
            d,
            format!(
                "work.dispatch.state is unknown: {}.",
                js_stringify(&Value::Str(state))
            ),
        ));
    }
    let guard_verdict = match get(data, "guardVerdict") {
        None => {
            return Err(fail(
                d,
                "work.dispatch.guardVerdict must be boolean or null.".to_string(),
            ));
        }
        Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        _ => {
            return Err(fail(
                d,
                "work.dispatch.guardVerdict must be boolean or null.".to_string(),
            ));
        }
    };
    let retry_class = match get(data, "retryClass") {
        None => {
            return Err(fail(
                d,
                "work.dispatch.retryClass must be transient, terminal or null.".to_string(),
            ));
        }
        Some(Value::Null) => None,
        Some(Value::Str(s)) if s.eq_ascii("transient") || s.eq_ascii("terminal") => Some(s.clone()),
        _ => {
            return Err(fail(
                d,
                "work.dispatch.retryClass must be transient, terminal or null.".to_string(),
            ));
        }
    };
    Ok(DispatchRowData {
        intent_id: check_string(data, "intentId", "work.dispatch", d)?,
        operation_id: check_string(data, "operationId", "work.dispatch", d)?,
        source: check_string(data, "source", "work.dispatch", d)?,
        occurrence_index: check_count(data, "occurrenceIndex", "work.dispatch", d)?,
        origin_occurrence: check_nullable_string(data, "originOccurrence", "work.dispatch", d)?,
        state,
        attempts: check_count(data, "attempts", "work.dispatch", d)?,
        claim_id: check_nullable_string(data, "claimId", "work.dispatch", d)?,
        claimed_at_ms: check_nullable_instant(data, "claimedAtMs", "work.dispatch", d)?,
        guard_verdict,
        delivery_id: check_nullable_string(data, "deliveryId", "work.dispatch", d)?,
        error_code: check_nullable_string(data, "errorCode", "work.dispatch", d)?,
        error_message: check_nullable_string(data, "errorMessage", "work.dispatch", d)?,
        available_at_ms: check_nullable_instant(data, "availableAtMs", "work.dispatch", d)?,
        first_attempt_at_ms: check_nullable_instant(data, "firstAttemptAtMs", "work.dispatch", d)?,
        retry_class,
    })
}

/// Read one occurrence row's data, failing closed on any shape drift.
pub fn read_occurrence_row(row: &StoredRow) -> Result<OccurrenceRowData, RowsError> {
    let d = Direction::Work;
    let data = check_record(&row.data, "work.occurrence data", d)?;
    let status = match get(data, "status") {
        Some(Value::Str(s)) if s.eq_ascii("completed") || s.eq_ascii("failed") => s.clone(),
        other => {
            // Missing reads as undefined; `${JSON.stringify(undefined)}` renders `undefined`.
            let shown = other
                .map(js_stringify)
                .unwrap_or_else(|| "undefined".to_string());
            return Err(fail(
                d,
                format!("work.occurrence.status must be completed or failed, got {shown}."),
            ));
        }
    };
    Ok(OccurrenceRowData {
        occurrence_id: check_string(data, "occurrenceId", "work.occurrence", d)?,
        status,
        result: get(data, "result").cloned().unwrap_or(Value::Null),
        code: check_nullable_string(data, "code", "work.occurrence", d)?,
        message: check_nullable_string(data, "message", "work.occurrence", d)?,
        recorded_at_ms: check_instant(data, "recordedAtMs", "work.occurrence", d)?,
    })
}

/// Read one schedule row's data, failing closed on any shape drift.
pub fn read_schedule_row(row: &StoredRow) -> Result<ScheduleRowData, RowsError> {
    let d = Direction::Work;
    let data = check_record(&row.data, "work.schedule data", d)?;
    let state = check_string(data, "state", "work.schedule", d)?;
    if !is_schedule_state(&state) {
        return Err(fail(
            d,
            format!(
                "work.schedule.state is unknown: {}.",
                js_stringify(&Value::Str(state))
            ),
        ));
    }
    Ok(ScheduleRowData {
        occurrence_id: check_string(data, "occurrenceId", "work.schedule", d)?,
        key: check_string(data, "key", "work.schedule", d)?,
        scope_app: check_string(data, "scopeApp", "work.schedule", d)?,
        scope_owner: check_string(data, "scopeOwner", "work.schedule", d)?,
        scope_owner_package: check_string(data, "scopeOwnerPackage", "work.schedule", d)?,
        at: check_instant(data, "at", "work.schedule", d)?,
        event: check_string(data, "event", "work.schedule", d)?,
        payload: check_record(
            get(data, "payload").unwrap_or(&Value::Null),
            "work.schedule.payload",
            d,
        )
        .map(|_| get(data, "payload").cloned().unwrap_or(Value::Null))?,
        replaces: check_nullable_string(data, "replaces", "work.schedule", d)?,
        state,
    })
}

/// Rebuild the contract scope from a schedule row's flat fields.
pub fn schedule_row_scope(row: &ScheduleRowData) -> Scope3 {
    Scope3 {
        app: row.scope_app.clone(),
        owner: row.scope_owner.clone(),
        owner_package: row.scope_owner_package.clone(),
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct Scope3 {
    pub app: U16,
    pub owner: U16,
    pub owner_package: U16,
}

/// Read one every-slot row's data, failing closed on any shape drift.
pub fn read_every_slot_row(row: &StoredRow) -> Result<EverySlotRowData, RowsError> {
    let d = Direction::Work;
    let data = check_record(&row.data, "work.every_slot data", d)?;
    let scope = match get(data, "scope") {
        Some(Value::Str(s)) if s.eq_ascii("team") || s.eq_ascii("app") => s.clone(),
        other => {
            let shown = other
                .map(js_stringify)
                .unwrap_or_else(|| "undefined".to_string());
            return Err(fail(
                d,
                format!("work.every_slot.scope must be team or app, got {shown}."),
            ));
        }
    };
    Ok(EverySlotRowData {
        scope_key: check_string(data, "scopeKey", "work.every_slot", d)?,
        app: check_string(data, "app", "work.every_slot", d)?,
        handler: check_string(data, "handler", "work.every_slot", d)?,
        scope,
        owner: check_string(data, "owner", "work.every_slot", d)?,
        slot: check_count(data, "slot", "work.every_slot", d)?,
    })
}

/// Read one supersession row's data, failing closed on any shape drift.
pub fn read_supersession_row(row: &StoredRow) -> Result<SupersessionRowData, RowsError> {
    let d = Direction::Work;
    let data = check_record(&row.data, "work.supersession data", d)?;
    Ok(SupersessionRowData {
        outbox_id: check_string(data, "outboxId", "work.supersession", d)?,
        by_occurrence_id: check_nullable_string(data, "byOccurrenceId", "work.supersession", d)?,
        marked_at_ms: check_instant(data, "markedAtMs", "work.supersession", d)?,
    })
}

#[derive(Clone, PartialEq, Debug)]
pub struct NewRowMeta {
    pub now_ms: f64,
    pub actor: U16,
}

#[derive(Clone, PartialEq, Debug)]
pub struct StoredRow {
    pub id: U16,
    pub version: f64,
    pub created: f64,
    pub updated: f64,
    pub created_by: U16,
    pub updated_by: U16,
    pub archived_at: Value,
    pub parent: Value,
    pub data: Value,
}

/**
 * Replacement row for a conditional update: version + 1 with fresh
 * updated metadata. Work direction (JSON-safety traversal).
 */
pub fn with_row_data(
    row: &StoredRow,
    data: &Value,
    meta: &NewRowMeta,
    what: &str,
) -> Result<StoredRow, RowsError> {
    let d = Direction::Work;
    check_meta(meta, what, d)?;
    check_json_safe(data, &format!("{what} data"))?;
    Ok(StoredRow {
        id: row.id.clone(),
        version: row.version + 1.0,
        created: row.created,
        updated: meta.now_ms,
        created_by: row.created_by.clone(),
        updated_by: meta.actor.clone(),
        archived_at: row.archived_at.clone(),
        parent: row.parent.clone(),
        data: data.deep_clone(),
    })
}

#[derive(Clone, PartialEq, Debug)]
pub struct NewDispatchInput {
    pub intent_id: U16,
    pub operation_id: U16,
    pub source: U16,
    pub occurrence_index: f64,
    pub origin_occurrence: Option<U16>,
}

/// Producer-side insert: the pending dispatch row for one staged intent.
pub fn new_dispatch_row(
    input: &NewDispatchInput,
    meta: &NewRowMeta,
) -> Result<StoredRow, RowsError> {
    let data = Value::Obj(Rc::new(vec![
        (
            U16::from_utf8("intentId"),
            Value::Str(input.intent_id.clone()),
        ),
        (
            U16::from_utf8("operationId"),
            Value::Str(input.operation_id.clone()),
        ),
        (U16::from_utf8("source"), Value::Str(input.source.clone())),
        (
            U16::from_utf8("occurrenceIndex"),
            Value::Num(input.occurrence_index),
        ),
        (
            U16::from_utf8("originOccurrence"),
            input
                .origin_occurrence
                .clone()
                .map(Value::Str)
                .unwrap_or(Value::Null),
        ),
        (
            U16::from_utf8("state"),
            Value::Str(U16::from_utf8("pending")),
        ),
        (U16::from_utf8("attempts"), Value::Num(0.0)),
        (U16::from_utf8("claimId"), Value::Null),
        (U16::from_utf8("claimedAtMs"), Value::Null),
        (U16::from_utf8("guardVerdict"), Value::Null),
        (U16::from_utf8("deliveryId"), Value::Null),
        (U16::from_utf8("errorCode"), Value::Null),
        (U16::from_utf8("errorMessage"), Value::Null),
        (U16::from_utf8("availableAtMs"), Value::Null),
        (U16::from_utf8("firstAttemptAtMs"), Value::Null),
        (U16::from_utf8("retryClass"), Value::Null),
    ]));
    new_row_core(
        input.intent_id.clone(),
        &data,
        meta,
        "work.dispatch",
        Direction::Work,
    )
}

/// Put-if-absent occurrence receipt row.
pub fn new_occurrence_row(
    input: &OccurrenceRowData,
    meta: &NewRowMeta,
) -> Result<StoredRow, RowsError> {
    let data = Value::Obj(Rc::new(vec![
        (
            U16::from_utf8("occurrenceId"),
            Value::Str(input.occurrence_id.clone()),
        ),
        (U16::from_utf8("status"), Value::Str(input.status.clone())),
        (U16::from_utf8("result"), input.result.shared_clone()),
        (
            U16::from_utf8("code"),
            input.code.clone().map(Value::Str).unwrap_or(Value::Null),
        ),
        (
            U16::from_utf8("message"),
            input.message.clone().map(Value::Str).unwrap_or(Value::Null),
        ),
        (
            U16::from_utf8("recordedAtMs"),
            Value::Num(input.recorded_at_ms),
        ),
    ]));
    new_row_core(
        input.occurrence_id.clone(),
        &data,
        meta,
        "work.occurrence",
        Direction::Work,
    )
}

/// Keyed schedule lineage row (id = occurrence id; key is looked up).
pub fn new_schedule_row(
    input: &ScheduleRowData,
    meta: &NewRowMeta,
) -> Result<StoredRow, RowsError> {
    let data = Value::Obj(Rc::new(vec![
        (
            U16::from_utf8("occurrenceId"),
            Value::Str(input.occurrence_id.clone()),
        ),
        (U16::from_utf8("key"), Value::Str(input.key.clone())),
        (
            U16::from_utf8("scopeApp"),
            Value::Str(input.scope_app.clone()),
        ),
        (
            U16::from_utf8("scopeOwner"),
            Value::Str(input.scope_owner.clone()),
        ),
        (
            U16::from_utf8("scopeOwnerPackage"),
            Value::Str(input.scope_owner_package.clone()),
        ),
        (U16::from_utf8("at"), Value::Num(input.at)),
        (U16::from_utf8("event"), Value::Str(input.event.clone())),
        (U16::from_utf8("payload"), input.payload.shared_clone()),
        (
            U16::from_utf8("replaces"),
            input
                .replaces
                .clone()
                .map(Value::Str)
                .unwrap_or(Value::Null),
        ),
        (U16::from_utf8("state"), Value::Str(input.state.clone())),
    ]));
    new_row_core(
        input.occurrence_id.clone(),
        &data,
        meta,
        "work.schedule",
        Direction::Work,
    )
}

/// Durable every-slot tracker id (components encoded, separators plain).
pub fn every_slot_row_id(
    app: &U16,
    handler: &U16,
    scope: &U16,
    owner: &U16,
) -> Result<U16, RowsError> {
    let mut out = U16::from_utf8("every/v1/").0;
    out.extend(encode_uri_component(&app.0)?.0);
    out.push(b'/' as u16);
    out.extend(encode_uri_component(&handler.0)?.0);
    out.push(b'/' as u16);
    out.extend(scope.0.iter().copied());
    out.push(b'/' as u16);
    out.extend(encode_uri_component(&owner.0)?.0);
    Ok(U16(out))
}

/// Every-slot tracker row (id = app/handler/scope/owner tuple).
pub fn new_every_slot_row(
    input: &EverySlotRowData,
    meta: &NewRowMeta,
) -> Result<StoredRow, RowsError> {
    let data = Value::Obj(Rc::new(vec![
        (
            U16::from_utf8("scopeKey"),
            Value::Str(input.scope_key.clone()),
        ),
        (U16::from_utf8("app"), Value::Str(input.app.clone())),
        (U16::from_utf8("handler"), Value::Str(input.handler.clone())),
        (U16::from_utf8("scope"), Value::Str(input.scope.clone())),
        (U16::from_utf8("owner"), Value::Str(input.owner.clone())),
        (U16::from_utf8("slot"), Value::Num(input.slot)),
    ]));
    let id = every_slot_row_id(&input.app, &input.handler, &input.scope, &input.owner)?;
    new_row_core(id, &data, meta, "work.every_slot", Direction::Work)
}

/// Supersession mark row (id = outbox id).
pub fn new_supersession_row(
    input: &SupersessionRowData,
    meta: &NewRowMeta,
) -> Result<StoredRow, RowsError> {
    let data = Value::Obj(Rc::new(vec![
        (
            U16::from_utf8("outboxId"),
            Value::Str(input.outbox_id.clone()),
        ),
        (
            U16::from_utf8("byOccurrenceId"),
            input
                .by_occurrence_id
                .clone()
                .map(Value::Str)
                .unwrap_or(Value::Null),
        ),
        (U16::from_utf8("markedAtMs"), Value::Num(input.marked_at_ms)),
    ]));
    new_row_core(
        input.outbox_id.clone(),
        &data,
        meta,
        "work.supersession",
        Direction::Work,
    )
}

fn eq_predicate(field: &str, value: Value) -> Value {
    Value::Obj(Rc::new(vec![
        (U16::from_utf8("op"), Value::Str(U16::from_utf8("eq"))),
        (U16::from_utf8("field"), Value::Str(U16::from_utf8(field))),
        (U16::from_utf8("value"), value),
    ]))
}

/// Dispatch rows stamped with one origin occurrence.
pub fn dispatch_by_origin_query(origin_occurrence: &U16) -> Value {
    Value::Obj(Rc::new(vec![
        (
            U16::from_utf8("model"),
            Value::Str(U16::from_utf8(WORK_DISPATCH_MODEL)),
        ),
        (
            U16::from_utf8("where"),
            eq_predicate("originOccurrence", Value::Str(origin_occurrence.clone())),
        ),
        (
            U16::from_utf8("authority"),
            Value::Str(U16::from_utf8("owner")),
        ),
    ]))
}

/// Dispatch rows in one lifecycle state.
pub fn dispatch_by_state_query(state: &U16) -> Value {
    Value::Obj(Rc::new(vec![
        (
            U16::from_utf8("model"),
            Value::Str(U16::from_utf8(WORK_DISPATCH_MODEL)),
        ),
        (
            U16::from_utf8("where"),
            eq_predicate("state", Value::Str(state.clone())),
        ),
        (
            U16::from_utf8("authority"),
            Value::Str(U16::from_utf8("owner")),
        ),
    ]))
}

/// Schedule rows under one key within one scope.
pub fn schedule_by_key_query(scope: &Scope3, key: &U16) -> Value {
    Value::Obj(Rc::new(vec![
        (
            U16::from_utf8("model"),
            Value::Str(U16::from_utf8(WORK_SCHEDULE_MODEL)),
        ),
        (
            U16::from_utf8("where"),
            Value::Obj(Rc::new(vec![
                (U16::from_utf8("op"), Value::Str(U16::from_utf8("and"))),
                (
                    U16::from_utf8("args"),
                    Value::Arr(Rc::new(vec![
                        eq_predicate("key", Value::Str(key.clone())),
                        eq_predicate("scopeApp", Value::Str(scope.app.clone())),
                        eq_predicate("scopeOwner", Value::Str(scope.owner.clone())),
                        eq_predicate("scopeOwnerPackage", Value::Str(scope.owner_package.clone())),
                    ])),
                ),
            ])),
        ),
        (
            U16::from_utf8("authority"),
            Value::Str(U16::from_utf8("owner")),
        ),
    ]))
}

/* -- Durable fanout tables (shared work + state directions). -- */

pub const WORK_FANOUT_INTENT_MODEL: &str = "work.fanout_intent";
pub const WORK_FANOUT_CHECKPOINT_MODEL: &str = "work.fanout_checkpoint";
pub const WORK_FANOUT_CHILD_MODEL: &str = "work.fanout_child";
pub const FANOUT_INTENT_MODEL: &str = "work.fanout_intent";
pub const FANOUT_CHECKPOINT_MODEL: &str = "work.fanout_checkpoint";
pub const FANOUT_CHILD_MODEL: &str = "work.fanout_child";

#[derive(Clone, PartialEq, Debug)]
pub struct FanoutIntentRowData {
    pub fanout_id: U16,
    pub source_occurrence: U16,
    pub handler: U16,
    pub cohort: U16,
    pub members: Vec<U16>,
    pub member_count: f64,
}

#[derive(Clone, PartialEq, Debug)]
pub struct FanoutCheckpointRowData {
    pub fanout_id: U16,
    pub completed: Vec<U16>,
    pub cursor: Option<U16>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct FanoutChildRowData {
    pub fanout_id: U16,
    pub parent_occurrence: U16,
    pub handler: U16,
    pub record_id: U16,
    pub child_id: U16,
    pub state: U16,
    pub attempts: f64,
    pub cause_kind: Option<U16>,
    pub cause_reason: Option<U16>,
}

fn is_fanout_child_state(s: &U16) -> bool {
    s.eq_ascii("pending")
        || s.eq_ascii("running")
        || s.eq_ascii("completed")
        || s.eq_ascii("skipped")
        || s.eq_ascii("failed")
}

fn is_skipped_reason(s: &U16) -> bool {
    s.eq_ascii("deleted") || s.eq_ascii("non-applicable")
}

fn is_failed_reason(s: &U16) -> bool {
    s.eq_ascii("business-rejection")
        || s.eq_ascii("terminal")
        || s.eq_ascii("exhausted")
        || s.eq_ascii("missing-record")
        || s.eq_ascii("inaccessible-record")
        || s.eq_ascii("infra-read-failure")
}

/// Validate one frozen identity set: non-empty canonical record ids,
/// deduped, returned in sorted canonical order. Duplicates fail closed.
pub fn check_fanout_identity_set(
    value: &Value,
    what: &str,
    direction: Direction,
) -> Result<Vec<U16>, RowsError> {
    let arr = match value {
        Value::Arr(a) => a,
        _ => {
            return Err(fail(
                direction,
                format!("{what} must be an array of canonical record ids."),
            ));
        }
    };
    let mut seen: Vec<U16> = Vec::new();
    for entry in arr.iter() {
        let s = match entry {
            Value::Str(s) if !s.is_empty() => s,
            _ => {
                return Err(fail(
                    direction,
                    format!("{what} entries must be non-empty strings."),
                ));
            }
        };
        if seen.contains(s) {
            return Err(fail(
                direction,
                format!(
                    "{what} contains a duplicate identity: {}.",
                    js_stringify(entry)
                ),
            ));
        }
        seen.push(s.clone());
    }
    seen.sort();
    Ok(seen)
}

/// Deterministic fanout intent row id under cutoff + cohort.
pub fn fanout_intent_row_id(
    source_occurrence: &U16,
    handler: &U16,
    cohort: &U16,
    direction: Direction,
) -> Result<U16, RowsError> {
    check_id_component(source_occurrence, "sourceOccurrence", direction)?;
    check_id_component(handler, "handler", direction)?;
    check_cohort(Some(&Value::Str(cohort.clone())), direction)?;
    let mut out = U16::from_utf8("fanout/v1/").0;
    out.extend(encode_uri_component(&source_occurrence.0)?.0);
    out.push(b'/' as u16);
    out.extend(encode_uri_component(&handler.0)?.0);
    out.push(b'/' as u16);
    out.extend(cohort.0.iter().copied());
    Ok(U16(out))
}

/// Checkpoint row id: exactly one checkpoint row per fanout id.
pub fn fanout_checkpoint_row_id(fanout_id: &U16, direction: Direction) -> Result<U16, RowsError> {
    check_id_component(fanout_id, "fanoutId", direction)
}

/// Per-child row id: the full child identity, components encoded.
pub fn fanout_child_row_id(
    parent_occurrence: &U16,
    handler: &U16,
    record_id: &U16,
    direction: Direction,
) -> Result<U16, RowsError> {
    check_id_component(parent_occurrence, "parentOccurrence", direction)?;
    check_id_component(handler, "handler", direction)?;
    check_id_component(record_id, "recordId", direction)?;
    let mut out = U16::from_utf8("fanout-child/v1/").0;
    out.extend(encode_uri_component(&parent_occurrence.0)?.0);
    out.push(b'/' as u16);
    out.extend(encode_uri_component(&handler.0)?.0);
    out.push(b'/' as u16);
    out.extend(encode_uri_component(&record_id.0)?.0);
    Ok(U16(out))
}

#[derive(Clone, PartialEq, Debug)]
pub struct NewIntentInput {
    pub source_occurrence: U16,
    pub handler: U16,
    pub cohort: U16,
    /// Raw members value (validated at runtime: non-arrays refuse).
    pub members: Value,
}

/// Producer-side insert: the committed fanout intent row.
pub fn new_fanout_intent_row(
    input: &NewIntentInput,
    meta: &NewRowMeta,
    direction: Direction,
) -> Result<StoredRow, RowsError> {
    let members =
        check_fanout_identity_set(&input.members, "work.fanout_intent.members", direction)?;
    let fanout_id = fanout_intent_row_id(
        &input.source_occurrence,
        &input.handler,
        &input.cohort,
        direction,
    )?;
    let data = Value::Obj(Rc::new(vec![
        (U16::from_utf8("fanoutId"), Value::Str(fanout_id.clone())),
        (
            U16::from_utf8("sourceOccurrence"),
            Value::Str(input.source_occurrence.clone()),
        ),
        (U16::from_utf8("handler"), Value::Str(input.handler.clone())),
        (U16::from_utf8("cohort"), Value::Str(input.cohort.clone())),
        (
            U16::from_utf8("members"),
            Value::Arr(Rc::new(
                members.iter().map(|m| Value::Str(m.clone())).collect(),
            )),
        ),
        (
            U16::from_utf8("memberCount"),
            Value::Num(members.len() as f64),
        ),
    ]));
    new_row_core(fanout_id, &data, meta, "work.fanout_intent", direction)
}

#[derive(Clone, PartialEq, Debug)]
pub struct NewCheckpointInput {
    pub fanout_id: U16,
    /// Raw completed value (validated at runtime; omitted reads as `[]`).
    pub completed: Value,
    pub cursor: Option<U16>,
}

/// Producer-side insert: the initial checkpoint row.
pub fn new_fanout_checkpoint_row(
    input: &NewCheckpointInput,
    meta: &NewRowMeta,
    direction: Direction,
) -> Result<StoredRow, RowsError> {
    let fanout_id = check_id_component(&input.fanout_id, "fanoutId", direction)?;
    let completed = check_fanout_identity_set(
        &input.completed,
        "work.fanout_checkpoint.completed",
        direction,
    )?;
    if matches!(&input.cursor, Some(c) if c.is_empty()) {
        return Err(fail(
            direction,
            "work.fanout_checkpoint.cursor must be non-empty or null.".to_string(),
        ));
    }
    let data = Value::Obj(Rc::new(vec![
        (U16::from_utf8("fanoutId"), Value::Str(fanout_id.clone())),
        (
            U16::from_utf8("completed"),
            Value::Arr(Rc::new(
                completed.iter().map(|m| Value::Str(m.clone())).collect(),
            )),
        ),
        (
            U16::from_utf8("cursor"),
            input.cursor.clone().map(Value::Str).unwrap_or(Value::Null),
        ),
    ]));
    let id = fanout_checkpoint_row_id(&fanout_id, direction)?;
    new_row_core(id, &data, meta, "work.fanout_checkpoint", direction)
}

/// Pure checkpoint advance for the conditional-update upsert.
pub fn next_fanout_checkpoint_data(
    current: &FanoutCheckpointRowData,
    add_completed: &[Value],
    cursor: Option<U16>,
    direction: Direction,
) -> Result<FanoutCheckpointRowData, RowsError> {
    if matches!(&cursor, Some(c) if c.is_empty()) {
        return Err(fail(
            direction,
            "work.fanout_checkpoint.cursor must be non-empty or null.".to_string(),
        ));
    }
    let mut validated: Vec<U16> = Vec::new();
    for entry in add_completed.iter() {
        match entry {
            Value::Str(s) if !s.is_empty() => validated.push(s.clone()),
            _ => {
                return Err(fail(
                    direction,
                    "work.fanout_checkpoint.completed entries must be non-empty strings."
                        .to_string(),
                ));
            }
        }
    }
    let mut completed = current.completed.clone();
    for entry in validated.iter() {
        if !completed.contains(entry) {
            completed.push(entry.clone());
        }
    }
    completed.sort();
    Ok(FanoutCheckpointRowData {
        fanout_id: current.fanout_id.clone(),
        completed,
        cursor,
    })
}

fn check_child_cause(
    state: &U16,
    cause_kind: &Option<U16>,
    cause_reason: &Option<U16>,
    direction: Direction,
) -> Result<(), RowsError> {
    let pending = state.eq_ascii("pending");
    let running = state.eq_ascii("running");
    if pending || running {
        if cause_kind.is_some() || cause_reason.is_some() {
            let kind = cause_kind.clone().map(Value::Str).unwrap_or(Value::Null);
            return Err(fail(
                direction,
                format!(
                    "work.fanout_child cause must be null until terminal, got {}.",
                    js_stringify(&kind)
                ),
            ));
        }
        return Ok(());
    }
    if state.eq_ascii("completed") {
        let ok_kind = matches!(cause_kind, Some(k) if k.eq_ascii("completed"));
        if !ok_kind || cause_reason.is_some() {
            return Err(fail(
                direction,
                "work.fanout_child completed cause must be kind completed with no reason."
                    .to_string(),
            ));
        }
        return Ok(());
    }
    if state.eq_ascii("skipped") {
        let ok_kind = matches!(cause_kind, Some(k) if k.eq_ascii("skipped"));
        let ok_reason = matches!(cause_reason, Some(r) if is_skipped_reason(r));
        if !ok_kind || !ok_reason {
            let reason = cause_reason.clone().map(Value::Str).unwrap_or(Value::Null);
            return Err(fail(
                direction,
                format!(
                    "work.fanout_child skipped cause needs a closed reason, got {}.",
                    js_stringify(&reason)
                ),
            ));
        }
        return Ok(());
    }
    let ok_kind = matches!(cause_kind, Some(k) if k.eq_ascii("failed"));
    let ok_reason = matches!(cause_reason, Some(r) if is_failed_reason(r));
    if !ok_kind || !ok_reason {
        let reason = cause_reason.clone().map(Value::Str).unwrap_or(Value::Null);
        return Err(fail(
            direction,
            format!(
                "work.fanout_child failed cause needs a closed reason, got {}.",
                js_stringify(&reason)
            ),
        ));
    }
    Ok(())
}

#[derive(Clone, PartialEq, Debug)]
pub struct NewChildInput {
    pub fanout_id: U16,
    pub parent_occurrence: U16,
    pub handler: U16,
    pub record_id: U16,
    pub state: Option<U16>,
    pub attempts: Option<f64>,
    pub cause_kind: Option<U16>,
    pub cause_reason: Option<U16>,
}

/// Producer-side insert: one admitted child row.
pub fn new_fanout_child_row(
    input: &NewChildInput,
    meta: &NewRowMeta,
    direction: Direction,
) -> Result<StoredRow, RowsError> {
    let state = input
        .state
        .clone()
        .unwrap_or_else(|| U16::from_utf8("pending"));
    if !is_fanout_child_state(&state) {
        return Err(fail(
            direction,
            format!(
                "work.fanout_child.state is unknown: {}.",
                js_stringify(&Value::Str(state))
            ),
        ));
    }
    let attempts = input.attempts.unwrap_or(0.0);
    if attempts.fract() != 0.0 || attempts < 0.0 {
        return Err(fail(
            direction,
            "work.fanout_child.attempts must be an integer >= 0.".to_string(),
        ));
    }
    check_child_cause(&state, &input.cause_kind, &input.cause_reason, direction)?;
    let child_id = fanout_child_row_id(
        &input.parent_occurrence,
        &input.handler,
        &input.record_id,
        direction,
    )?;
    let fanout_id = check_id_component(&input.fanout_id, "fanoutId", direction)?;
    let data = Value::Obj(Rc::new(vec![
        (U16::from_utf8("fanoutId"), Value::Str(fanout_id)),
        (
            U16::from_utf8("parentOccurrence"),
            Value::Str(input.parent_occurrence.clone()),
        ),
        (U16::from_utf8("handler"), Value::Str(input.handler.clone())),
        (
            U16::from_utf8("recordId"),
            Value::Str(input.record_id.clone()),
        ),
        (U16::from_utf8("childId"), Value::Str(child_id.clone())),
        (U16::from_utf8("state"), Value::Str(state)),
        (U16::from_utf8("attempts"), Value::Num(attempts)),
        (
            U16::from_utf8("causeKind"),
            input
                .cause_kind
                .clone()
                .map(Value::Str)
                .unwrap_or(Value::Null),
        ),
        (
            U16::from_utf8("causeReason"),
            input
                .cause_reason
                .clone()
                .map(Value::Str)
                .unwrap_or(Value::Null),
        ),
    ]));
    new_row_core(child_id, &data, meta, "work.fanout_child", direction)
}

/// Read one fanout intent row's data, failing closed on any shape drift.
pub fn read_fanout_intent_row(
    row: &StoredRow,
    direction: Direction,
) -> Result<FanoutIntentRowData, RowsError> {
    let data = check_record(&row.data, "work.fanout_intent data", direction)?;
    let cohort = check_cohort(get(data, "cohort"), direction)?;
    let members_value = get(data, "members").cloned().unwrap_or(Value::Null);
    let members =
        check_fanout_identity_set(&members_value, "work.fanout_intent.members", direction)?;
    let member_count = check_count(data, "memberCount", "work.fanout_intent", direction)?;
    if member_count != members.len() as f64 {
        return Err(fail(
            direction,
            format!(
                "work.fanout_intent.memberCount {} mismatches members length {}.",
                js_num(member_count),
                members.len()
            ),
        ));
    }
    let fanout_id = check_string(data, "fanoutId", "work.fanout_intent", direction)?;
    let source_occurrence =
        check_string(data, "sourceOccurrence", "work.fanout_intent", direction)?;
    let handler = check_string(data, "handler", "work.fanout_intent", direction)?;
    if fanout_id != fanout_intent_row_id(&source_occurrence, &handler, &cohort, direction)? {
        return Err(fail(
            direction,
            "work.fanout_intent.fanoutId is not the cutoff+cohort derivation.".to_string(),
        ));
    }
    if row.id != fanout_id {
        return Err(fail(
            direction,
            "work.fanout_intent row id must equal its fanoutId.".to_string(),
        ));
    }
    Ok(FanoutIntentRowData {
        fanout_id,
        source_occurrence,
        handler,
        cohort,
        members,
        member_count,
    })
}

/// Read one fanout checkpoint row's data, failing closed on any shape drift.
pub fn read_fanout_checkpoint_row(
    row: &StoredRow,
    direction: Direction,
) -> Result<FanoutCheckpointRowData, RowsError> {
    let data = check_record(&row.data, "work.fanout_checkpoint data", direction)?;
    let fanout_id = check_string(data, "fanoutId", "work.fanout_checkpoint", direction)?;
    let completed_value = get(data, "completed").cloned().unwrap_or(Value::Null);
    let completed = check_fanout_identity_set(
        &completed_value,
        "work.fanout_checkpoint.completed",
        direction,
    )?;
    let cursor = check_nullable_string(data, "cursor", "work.fanout_checkpoint", direction)?;
    if matches!(&cursor, Some(c) if c.is_empty()) {
        return Err(fail(
            direction,
            "work.fanout_checkpoint.cursor must be non-empty or null.".to_string(),
        ));
    }
    if row.id != fanout_id {
        return Err(fail(
            direction,
            "work.fanout_checkpoint row id must equal its fanoutId.".to_string(),
        ));
    }
    Ok(FanoutCheckpointRowData {
        fanout_id,
        completed,
        cursor,
    })
}

/// Read one fanout child row's data, failing closed on any shape drift.
pub fn read_fanout_child_row(
    row: &StoredRow,
    direction: Direction,
) -> Result<FanoutChildRowData, RowsError> {
    let data = check_record(&row.data, "work.fanout_child data", direction)?;
    let state = check_string(data, "state", "work.fanout_child", direction)?;
    if !is_fanout_child_state(&state) {
        return Err(fail(
            direction,
            format!(
                "work.fanout_child.state is unknown: {}.",
                js_stringify(&Value::Str(state))
            ),
        ));
    }
    let cause_kind = match get(data, "causeKind") {
        None => {
            let shown = "undefined";
            return Err(fail(
                direction,
                format!("work.fanout_child.causeKind is unknown: {shown}."),
            ));
        }
        Some(Value::Null) => None,
        Some(Value::Str(s))
            if s.eq_ascii("completed") || s.eq_ascii("skipped") || s.eq_ascii("failed") =>
        {
            Some(s.clone())
        }
        Some(other) => {
            return Err(fail(
                direction,
                format!(
                    "work.fanout_child.causeKind is unknown: {}.",
                    js_stringify(other)
                ),
            ));
        }
    };
    let cause_reason = check_nullable_string(data, "causeReason", "work.fanout_child", direction)?;
    check_child_cause(&state, &cause_kind, &cause_reason, direction)?;
    let fanout_id = check_string(data, "fanoutId", "work.fanout_child", direction)?;
    let parent_occurrence = check_string(data, "parentOccurrence", "work.fanout_child", direction)?;
    let handler = check_string(data, "handler", "work.fanout_child", direction)?;
    let record_id = check_string(data, "recordId", "work.fanout_child", direction)?;
    let child_id = check_string(data, "childId", "work.fanout_child", direction)?;
    if child_id != fanout_child_row_id(&parent_occurrence, &handler, &record_id, direction)? {
        return Err(fail(
            direction,
            "work.fanout_child.childId is not the parent+handler+record derivation.".to_string(),
        ));
    }
    if row.id != child_id {
        return Err(fail(
            direction,
            "work.fanout_child row id must equal its childId.".to_string(),
        ));
    }
    Ok(FanoutChildRowData {
        fanout_id,
        parent_occurrence,
        handler,
        record_id,
        child_id,
        state,
        attempts: check_count(data, "attempts", "work.fanout_child", direction)?,
        cause_kind,
        cause_reason,
    })
}

/**
 * State-direction replacement row for a conditional update: version + 1
 * with fresh updated metadata. Clone-only (no JSON-safety traversal);
 * meta scope is fixed to `fanout`.
 */
pub fn with_fanout_row_data(
    row: &StoredRow,
    data: &Value,
    meta: &NewRowMeta,
) -> Result<StoredRow, RowsError> {
    check_meta(meta, "fanout", Direction::State)?;
    Ok(StoredRow {
        id: row.id.clone(),
        version: row.version + 1.0,
        created: row.created,
        updated: meta.now_ms,
        updated_by: meta.actor.clone(),
        created_by: row.created_by.clone(),
        archived_at: row.archived_at.clone(),
        parent: row.parent.clone(),
        // Shared clone: preserves reference identity like structuredClone.
        data: data.shared_clone(),
    })
}

/// Rebuild the contract child identity from a child row's flat fields.
pub fn fanout_child_id_of(row: &FanoutChildRowData) -> ChildId3 {
    ChildId3 {
        parent_occurrence: row.parent_occurrence.clone(),
        handler: row.handler.clone(),
        record_id: row.record_id.clone(),
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct ChildId3 {
    pub parent_occurrence: U16,
    pub handler: U16,
    pub record_id: U16,
}

#[derive(Clone, PartialEq, Debug)]
pub struct PageOpts {
    pub cursor: Option<U16>,
    pub limit: f64,
}

/// Bounded id-sorted child page query for one fanout.
pub fn fanout_child_page_query(
    fanout_id: &U16,
    opts: &PageOpts,
    direction: Direction,
) -> Result<Value, RowsError> {
    check_id_component(fanout_id, "fanoutId", direction)?;
    if matches!(&opts.cursor, Some(c) if c.is_empty()) {
        return Err(match direction {
            Direction::Work => fail(
                direction,
                "fanout page cursor must be non-empty or null.".to_string(),
            ),
            Direction::State => fail(
                direction,
                "Fanout page cursor must be non-empty or null.".to_string(),
            ),
        });
    }
    if opts.limit.fract() != 0.0 || opts.limit < 1.0 {
        return Err(match direction {
            Direction::Work => fail(
                direction,
                "fanout page limit must be an integer >= 1.".to_string(),
            ),
            Direction::State => fail(
                direction,
                "Fanout page limit must be an integer >= 1.".to_string(),
            ),
        });
    }
    let fanout_eq = eq_predicate("fanoutId", Value::Str(fanout_id.clone()));
    let where_value = match &opts.cursor {
        None => fanout_eq,
        Some(cursor) => Value::Obj(Rc::new(vec![
            (U16::from_utf8("op"), Value::Str(U16::from_utf8("and"))),
            (
                U16::from_utf8("args"),
                Value::Arr(Rc::new(vec![
                    fanout_eq,
                    Value::Obj(Rc::new(vec![
                        (U16::from_utf8("op"), Value::Str(U16::from_utf8("gt"))),
                        (U16::from_utf8("field"), Value::Str(U16::from_utf8("id"))),
                        (U16::from_utf8("value"), Value::Str(cursor.clone())),
                    ])),
                ])),
            ),
        ])),
    };
    Ok(Value::Obj(Rc::new(vec![
        (
            U16::from_utf8("model"),
            Value::Str(U16::from_utf8(WORK_FANOUT_CHILD_MODEL)),
        ),
        (U16::from_utf8("where"), where_value),
        (
            U16::from_utf8("order"),
            Value::Arr(Rc::new(vec![Value::Obj(Rc::new(vec![
                (U16::from_utf8("field"), Value::Str(U16::from_utf8("id"))),
                (
                    U16::from_utf8("direction"),
                    Value::Str(U16::from_utf8("asc")),
                ),
            ]))])),
        ),
        (U16::from_utf8("limit"), Value::Num(opts.limit)),
        (
            U16::from_utf8("authority"),
            Value::Str(U16::from_utf8("owner")),
        ),
    ])))
}

/// One bounded child page: rows plus the honest resume signal.
#[derive(Clone, PartialEq, Debug)]
pub struct FanoutChildPage {
    pub rows: Vec<StoredRow>,
    pub done: bool,
    pub cursor: Option<U16>,
}

/// Fold one store page into the resume signal.
pub fn fanout_child_page_result(
    rows: &[StoredRow],
    limit: f64,
    direction: Direction,
) -> Result<FanoutChildPage, RowsError> {
    if limit.fract() != 0.0 || limit < 1.0 {
        return Err(match direction {
            Direction::Work => fail(
                direction,
                "fanout page limit must be an integer >= 1.".to_string(),
            ),
            Direction::State => fail(
                direction,
                "Fanout page limit must be an integer >= 1.".to_string(),
            ),
        });
    }
    if (rows.len() as f64) > limit {
        return Err(match direction {
            Direction::Work => fail(
                direction,
                format!(
                    "fanout page returned {} rows past limit {}.",
                    rows.len(),
                    js_num(limit)
                ),
            ),
            Direction::State => fail(
                direction,
                format!(
                    "Fanout page returned {} rows past limit {}.",
                    rows.len(),
                    js_num(limit)
                ),
            ),
        });
    }
    if (rows.len() as f64) < limit {
        return Ok(FanoutChildPage {
            rows: rows.to_vec(),
            done: true,
            cursor: None,
        });
    }
    match rows.last() {
        None => Err(match direction {
            Direction::Work => fail(
                direction,
                "fanout page is unreachable: full page has no last row.".to_string(),
            ),
            Direction::State => fail(
                direction,
                "Fanout page is unreachable: full page has no last row.".to_string(),
            ),
        }),
        Some(last) => Ok(FanoutChildPage {
            rows: rows.to_vec(),
            done: false,
            cursor: Some(last.id.clone()),
        }),
    }
}

// N03 immutable witnesses: private Cargo route, not standalone rustc.

