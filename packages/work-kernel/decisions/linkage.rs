//! W04.3 — Native dispatch/fanout/receipt batch-linkage assertions.
//!
//! Data-only Rust port of `src/linkage.ts`, proven against the same
//! independent TS oracle corpus (`conformance/fixtures/receipts/linkage.json`).
//! N03 replaces standalone rustc testing with an isolated private Cargo project
//! containing exact copies of this file and numeric_text.rs; ryu-js =1.0.3,
//! default features off. Run original embedded vectors and immutable witnesses.
//! Official product dependency/root registration remains pending. The fanout state-direction
//! readers are duplicated verbatim from the proven `rows.rs` sibling and
//! the receipt readers from `receipt.rs` (state-only adaptation, `rt_`
//! prefix); W04.4 assembly consolidates them. Row-identity reads preserve
//! the donor's ReceiptTableError-to-StateError wrap.

#[path = "numeric_text.rs"]
mod numeric_text;

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

/// Parity error: name/code/message match the TS donors (`StateError`
/// validation for linkage verdicts, `ReceiptTableError` inside the join
/// readers before the wrap, engine-thrown `URIError` from id derivation).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct LinkageError {
    pub name: String,
    pub code: Option<String>,
    pub message: String,
}

fn state_error(message: String) -> LinkageError {
    LinkageError {
        name: "StateError".to_string(),
        code: Some("validation".to_string()),
        message,
    }
}

fn fail_validation(message: String) -> LinkageError {
    state_error(message)
}

/// Stored current-attempt association rows (structural literal).
pub const RECEIPT_ASSOCIATION_MODEL: &str = "work.receipt_association";

/// Retained receipt rows, one per delivery attempt.
pub const RECEIPT_MODEL: &str = "work.receipt";

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
/// references keep their identity for the seen-set traversal.
#[derive(Clone)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(U16),
    Arr(Rc<Vec<Value>>),
    Obj(Rc<Vec<(U16, Value)>>),
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

/// V8-compatible JSON string escaping for one UTF-16 unit slice.
fn json_escape_into(units: &[u16], out: &mut String) {
    out.push('"');
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        match u {
            0x22 => out.push_str("\\\""),
            0x5C => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x09 => out.push_str("\\t"),
            0x0A => out.push_str("\\n"),
            0x0C => out.push_str("\\f"),
            0x0D => out.push_str("\\r"),
            0x00..=0x1F => {
                out.push_str(&format!("\\u{:04x}", u));
            }
            0xD800..0xDC00 => {
                if i + 1 < units.len() && (0xDC00..0xE000).contains(&units[i + 1]) {
                    let lo = units[i + 1];
                    let cp = 0x10000 + (((u - 0xD800) as u32) << 10) + (lo - 0xDC00) as u32;
                    out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
                    i += 1;
                } else {
                    out.push_str(&format!("\\u{:04x}", u));
                }
            }
            0xDC00..0xE000 => {
                out.push_str(&format!("\\u{:04x}", u));
            }
            _ => {
                out.push(char::from_u32(u as u32).unwrap_or('\u{FFFD}'));
            }
        }
        i += 1;
    }
    out.push('"');
}

/// JS `String(n)` number rendering (also JSON for finite values).
fn js_num(n: f64) -> String {
    numeric_text::string(n)
}

/// `JSON.stringify` number rendering (non-finite becomes null).
fn js_json_num(n: f64) -> String {
    numeric_text::json_token(n)
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
    }
}

fn encode_uri_component(units: &[u16]) -> Result<U16, LinkageError> {
    fn unreserved(b: u16) -> bool {
        matches!(b,
            0x41..=0x5A | 0x61..=0x7A | 0x30..=0x39 |
            0x2D | 0x5F | 0x2E | 0x21 | 0x7E | 0x2A | 0x27 | 0x28 | 0x29)
    }
    fn push_utf8_escaped(cp: u32, out: &mut Vec<u16>) {
        let c = char::from_u32(cp).unwrap_or('\u{FFFD}');
        let mut buf = [0u8; 4];
        for b in c.encode_utf8(&mut buf).bytes() {
            let hex = format!("%{:02X}", b);
            out.extend(hex.encode_utf16());
        }
    }
    let mut out: Vec<u16> = Vec::new();
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        if u < 0x80 && unreserved(u) {
            out.push(u);
            i += 1;
            continue;
        }
        if (0xD800..0xDC00).contains(&u) {
            if i + 1 < units.len() && (0xDC00..0xE000).contains(&units[i + 1]) {
                let cp = 0x10000 + (((u - 0xD800) as u32) << 10) + (units[i + 1] - 0xDC00) as u32;
                push_utf8_escaped(cp, &mut out);
                i += 2;
                continue;
            }
            return Err(LinkageError {
                name: "URIError".to_string(),
                code: None,
                message: "URI malformed".to_string(),
            });
        }
        if (0xDC00..0xE000).contains(&u) {
            return Err(LinkageError {
                name: "URIError".to_string(),
                code: None,
                message: "URI malformed".to_string(),
            });
        }
        push_utf8_escaped(u as u32, &mut out);
        i += 1;
    }
    Ok(U16(out))
}

fn get<'a>(record: &'a [(U16, Value)], field: &str) -> Option<&'a Value> {
    record
        .iter()
        .find(|(k, _)| k.eq_ascii(field))
        .map(|(_, v)| v)
}

fn check_record<'a>(value: &'a Value, what: &str) -> Result<&'a Vec<(U16, Value)>, LinkageError> {
    match value.as_obj() {
        Some(o) => Ok(o),
        None => Err(state_error(format!("{} must be an object.", what))),
    }
}

fn check_string(record: &[(U16, Value)], field: &str, what: &str) -> Result<U16, LinkageError> {
    match get(record, field) {
        Some(Value::Str(s)) if !s.is_empty() => Ok(s.clone()),
        _ => Err(state_error(format!(
            "{what}.{field} must be a non-empty string."
        ))),
    }
}

fn check_nullable_string(
    record: &[(U16, Value)],
    field: &str,
    what: &str,
) -> Result<Option<U16>, LinkageError> {
    match get(record, field) {
        None => Err(state_error(format!(
            "{what}.{field} must be a string or null."
        ))),
        Some(Value::Null) => Ok(None),
        Some(Value::Str(s)) => Ok(Some(s.clone())),
        _ => Err(state_error(format!(
            "{what}.{field} must be a string or null."
        ))),
    }
}

fn check_count(record: &[(U16, Value)], field: &str, what: &str) -> Result<f64, LinkageError> {
    match get(record, field) {
        Some(Value::Num(n)) if n.fract() == 0.0 && *n >= 0.0 => Ok(*n),
        _ => Err(state_error(format!(
            "{what}.{field} must be an integer >= 0."
        ))),
    }
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

pub fn check_fanout_identity_set(value: &Value, what: &str) -> Result<Vec<U16>, LinkageError> {
    let arr = match value {
        Value::Arr(a) => a,
        _ => {
            return Err(state_error(format!(
                "{what} must be an array of canonical record ids."
            )));
        }
    };
    let mut seen: Vec<U16> = Vec::new();
    for entry in arr.iter() {
        let s = match entry {
            Value::Str(s) if !s.is_empty() => s,
            _ => {
                return Err(state_error(format!(
                    "{what} entries must be non-empty strings."
                )));
            }
        };
        if seen.contains(s) {
            return Err(state_error(format!(
                "{what} contains a duplicate identity: {}.",
                js_stringify(entry)
            )));
        }
        seen.push(s.clone());
    }
    seen.sort();
    Ok(seen)
}

pub fn fanout_intent_row_id(
    source_occurrence: &U16,
    handler: &U16,
    cohort: &U16,
) -> Result<U16, LinkageError> {
    check_id_component(source_occurrence, "sourceOccurrence")?;
    check_id_component(handler, "handler")?;
    check_cohort(Some(&Value::Str(cohort.clone())))?;
    let mut out = U16::from_utf8("fanout/v1/").0;
    out.extend(encode_uri_component(&source_occurrence.0)?.0);
    out.push(b'/' as u16);
    out.extend(encode_uri_component(&handler.0)?.0);
    out.push(b'/' as u16);
    out.extend(cohort.0.iter().copied());
    Ok(U16(out))
}

pub fn fanout_child_row_id(
    parent_occurrence: &U16,
    handler: &U16,
    record_id: &U16,
) -> Result<U16, LinkageError> {
    check_id_component(parent_occurrence, "parentOccurrence")?;
    check_id_component(handler, "handler")?;
    check_id_component(record_id, "recordId")?;
    let mut out = U16::from_utf8("fanout-child/v1/").0;
    out.extend(encode_uri_component(&parent_occurrence.0)?.0);
    out.push(b'/' as u16);
    out.extend(encode_uri_component(&handler.0)?.0);
    out.push(b'/' as u16);
    out.extend(encode_uri_component(&record_id.0)?.0);
    Ok(U16(out))
}

fn check_child_cause(
    state: &U16,
    cause_kind: &Option<U16>,
    cause_reason: &Option<U16>,
) -> Result<(), LinkageError> {
    let pending = state.eq_ascii("pending");
    let running = state.eq_ascii("running");
    if pending || running {
        if cause_kind.is_some() || cause_reason.is_some() {
            let kind = cause_kind.clone().map(Value::Str).unwrap_or(Value::Null);
            return Err(state_error(format!(
                "work.fanout_child cause must be null until terminal, got {}.",
                js_stringify(&kind)
            )));
        }
        return Ok(());
    }
    if state.eq_ascii("completed") {
        let ok_kind = matches!(cause_kind, Some(k) if k.eq_ascii("completed"));
        if !ok_kind || cause_reason.is_some() {
            return Err(state_error(
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
            return Err(state_error(format!(
                "work.fanout_child skipped cause needs a closed reason, got {}.",
                js_stringify(&reason)
            )));
        }
        return Ok(());
    }
    let ok_kind = matches!(cause_kind, Some(k) if k.eq_ascii("failed"));
    let ok_reason = matches!(cause_reason, Some(r) if is_failed_reason(r));
    if !ok_kind || !ok_reason {
        let reason = cause_reason.clone().map(Value::Str).unwrap_or(Value::Null);
        return Err(state_error(format!(
            "work.fanout_child failed cause needs a closed reason, got {}.",
            js_stringify(&reason)
        )));
    }
    Ok(())
}

pub fn read_fanout_intent_row(row: &StoredRow) -> Result<FanoutIntentRowData, LinkageError> {
    let data = check_record(&row.data, "work.fanout_intent data")?;
    let cohort = check_cohort(get(data, "cohort"))?;
    let members_value = get(data, "members").cloned().unwrap_or(Value::Null);
    let members = check_fanout_identity_set(&members_value, "work.fanout_intent.members")?;
    let member_count = check_count(data, "memberCount", "work.fanout_intent")?;
    if member_count != members.len() as f64 {
        return Err(state_error(format!(
            "work.fanout_intent.memberCount {} mismatches members length {}.",
            js_num(member_count),
            members.len()
        )));
    }
    let fanout_id = check_string(data, "fanoutId", "work.fanout_intent")?;
    let source_occurrence = check_string(data, "sourceOccurrence", "work.fanout_intent")?;
    let handler = check_string(data, "handler", "work.fanout_intent")?;
    if fanout_id != fanout_intent_row_id(&source_occurrence, &handler, &cohort)? {
        return Err(state_error(
            "work.fanout_intent.fanoutId is not the cutoff+cohort derivation.".to_string(),
        ));
    }
    if row.id != fanout_id {
        return Err(state_error(
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

pub fn read_fanout_checkpoint_row(
    row: &StoredRow,
) -> Result<FanoutCheckpointRowData, LinkageError> {
    let data = check_record(&row.data, "work.fanout_checkpoint data")?;
    let fanout_id = check_string(data, "fanoutId", "work.fanout_checkpoint")?;
    let completed_value = get(data, "completed").cloned().unwrap_or(Value::Null);
    let completed =
        check_fanout_identity_set(&completed_value, "work.fanout_checkpoint.completed")?;
    let cursor = check_nullable_string(data, "cursor", "work.fanout_checkpoint")?;
    if matches!(&cursor, Some(c) if c.is_empty()) {
        return Err(state_error(
            "work.fanout_checkpoint.cursor must be non-empty or null.".to_string(),
        ));
    }
    if row.id != fanout_id {
        return Err(state_error(
            "work.fanout_checkpoint row id must equal its fanoutId.".to_string(),
        ));
    }
    Ok(FanoutCheckpointRowData {
        fanout_id,
        completed,
        cursor,
    })
}

pub fn read_fanout_child_row(row: &StoredRow) -> Result<FanoutChildRowData, LinkageError> {
    let data = check_record(&row.data, "work.fanout_child data")?;
    let state = check_string(data, "state", "work.fanout_child")?;
    if !is_fanout_child_state(&state) {
        return Err(state_error(format!(
            "work.fanout_child.state is unknown: {}.",
            js_stringify(&Value::Str(state))
        )));
    }
    let cause_kind = match get(data, "causeKind") {
        None => {
            let shown = "undefined";
            return Err(state_error(format!(
                "work.fanout_child.causeKind is unknown: {shown}."
            )));
        }
        Some(Value::Null) => None,
        Some(Value::Str(s))
            if s.eq_ascii("completed") || s.eq_ascii("skipped") || s.eq_ascii("failed") =>
        {
            Some(s.clone())
        }
        Some(other) => {
            return Err(state_error(format!(
                "work.fanout_child.causeKind is unknown: {}.",
                js_stringify(other)
            )));
        }
    };
    let cause_reason = check_nullable_string(data, "causeReason", "work.fanout_child")?;
    check_child_cause(&state, &cause_kind, &cause_reason)?;
    let fanout_id = check_string(data, "fanoutId", "work.fanout_child")?;
    let parent_occurrence = check_string(data, "parentOccurrence", "work.fanout_child")?;
    let handler = check_string(data, "handler", "work.fanout_child")?;
    let record_id = check_string(data, "recordId", "work.fanout_child")?;
    let child_id = check_string(data, "childId", "work.fanout_child")?;
    if child_id != fanout_child_row_id(&parent_occurrence, &handler, &record_id)? {
        return Err(state_error(
            "work.fanout_child.childId is not the parent+handler+record derivation.".to_string(),
        ));
    }
    if row.id != child_id {
        return Err(state_error(
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
        attempts: check_count(data, "attempts", "work.fanout_child")?,
        cause_kind,
        cause_reason,
    })
}

fn check_id_component(value: &U16, short: &str) -> Result<U16, LinkageError> {
    if value.is_empty() {
        return Err(state_error(format!(
            "Fanout {short} must be a non-empty string."
        )));
    }
    Ok(value.clone())
}

fn check_cohort(value: Option<&Value>) -> Result<U16, LinkageError> {
    match value {
        Some(Value::Str(s)) if s.eq_ascii("model") || s.eq_ascii("anchored-collection") => {
            Ok(s.clone())
        }
        _ => {
            let shown = value
                .map(js_stringify)
                .unwrap_or_else(|| "undefined".to_string());
            Err(state_error(format!(
                "Fanout cohort must be model or anchored-collection, got {shown}."
            )))
        }
    }
}

fn rt_table_error(message: String) -> LinkageError {
    LinkageError {
        name: "ReceiptTableError".to_string(),
        code: None,
        message,
    }
}

fn rt_is_closed_error_shape(error: &Value) -> bool {
    match error {
        Value::Obj(o) => {
            if o.len() != 2 {
                return false;
            }
            let code = o.iter().find(|(k, _)| k.eq_ascii("code")).map(|(_, v)| v);
            let message = o
                .iter()
                .find(|(k, _)| k.eq_ascii("message"))
                .map(|(_, v)| v);
            matches!((code, message), (Some(Value::Str(_)), Some(Value::Str(_))))
        }
        // Arrays carry index keys: `code`/`message` never resolve.
        _ => false,
    }
}

pub fn rt_is_stored_receipt_payload(status: &Value, result: &Value, error: &Value) -> bool {
    // Callers normalize missing payload keys to null; the linkage value
    // model carries no `undefined` (unreachable through batch writes).
    let payload = result;
    let failure = error;
    if let Value::Str(s) = status {
        if s.eq_ascii("pending") {
            return *payload == Value::Null && *failure == Value::Null;
        }
        if s.eq_ascii("succeeded") {
            return *failure == Value::Null;
        }
        if s.eq_ascii("failed") {
            return *payload == Value::Null && rt_is_closed_error_shape(failure);
        }
        if s.eq_ascii("unknown") {
            return *payload == Value::Null
                && (*failure == Value::Null || rt_is_closed_error_shape(failure));
        }
        if s.eq_ascii("skipped") {
            return *payload == Value::Null && *failure == Value::Null;
        }
    }
    false
}

pub struct ReceiptError {
    pub code: U16,
    pub message: U16,
}

pub fn rt_association_row_id(
    model: &U16,
    record_id: &U16,
    field: &U16,
) -> Result<U16, LinkageError> {
    if model.is_empty() || record_id.is_empty() || field.is_empty() {
        return Err(rt_table_error(
            "associationRowId needs a non-empty model, recordId and field.".to_string(),
        ));
    }
    let mut out = U16::from_utf8("receipt-assoc/v1/").0;
    out.extend(encode_uri_component(&model.0)?.0);
    out.push(b'/' as u16);
    out.extend(encode_uri_component(&record_id.0)?.0);
    out.push(b'/' as u16);
    out.extend(encode_uri_component(&field.0)?.0);
    Ok(U16(out))
}

fn rt_check_record<'a>(
    value: &'a Value,
    what: &str,
) -> Result<&'a Vec<(U16, Value)>, LinkageError> {
    match value.as_obj() {
        Some(o) => Ok(o),
        None => Err(rt_table_error(format!("{what} must be an object."))),
    }
}

fn rt_check_string(record: &[(U16, Value)], field: &str, what: &str) -> Result<U16, LinkageError> {
    match get(record, field) {
        Some(Value::Str(s)) if !s.is_empty() => Ok(s.clone()),
        _ => Err(rt_table_error(format!(
            "{what}.{field} must be a non-empty string."
        ))),
    }
}

fn rt_check_revision(
    record: &[(U16, Value)],
    field: &str,
    what: &str,
) -> Result<f64, LinkageError> {
    match get(record, field) {
        Some(Value::Num(n)) if n.fract() == 0.0 && *n >= 0.0 => Ok(*n),
        _ => Err(rt_table_error(format!(
            "{what}.{field} must be an integer >= 0."
        ))),
    }
}

fn rt_check_status(record: &[(U16, Value)]) -> Result<U16, LinkageError> {
    match get(record, "status") {
        Some(Value::Str(s))
            if s.eq_ascii("pending")
                || s.eq_ascii("succeeded")
                || s.eq_ascii("failed")
                || s.eq_ascii("unknown")
                || s.eq_ascii("skipped") =>
        {
            Ok(s.clone())
        }
        other => {
            let shown = match other {
                Some(v) => js_stringify(v),
                None => "undefined".to_string(),
            };
            Err(rt_table_error(format!(
                "work.receipt.status is unknown: {shown}."
            )))
        }
    }
}

fn rt_check_nullable_content_ref(record: &[(U16, Value)]) -> Result<Option<U16>, LinkageError> {
    match get(record, "contentRef") {
        Some(Value::Null) => Ok(None),
        Some(Value::Str(s)) if !s.is_empty() => Ok(Some(s.clone())),
        _ => Err(rt_table_error(
            "work.receipt.contentRef must be a non-empty string or null.".to_string(),
        )),
    }
}

fn rt_check_nullable_expiry(record: &[(U16, Value)]) -> Result<Option<f64>, LinkageError> {
    match get(record, "resultExpiresAtMs") {
        Some(Value::Null) => Ok(None),
        Some(Value::Num(n)) if n.is_finite() && *n >= 0.0 => Ok(Some(*n)),
        _ => Err(rt_table_error(
            "work.receipt.resultExpiresAtMs must be finite epoch ms or null.".to_string(),
        )),
    }
}

pub fn rt_read_association_row(row: &StoredRow) -> Result<ReceiptAssociation, LinkageError> {
    let data = rt_check_record(&row.data, "work.receipt_association data")?;
    let record_model = rt_check_string(data, "recordModel", "work.receipt_association")?;
    let record_id = rt_check_string(data, "recordId", "work.receipt_association")?;
    let field = rt_check_string(data, "field", "work.receipt_association")?;
    let delivery_id = rt_check_string(data, "deliveryId", "work.receipt_association")?;
    let source = rt_check_string(data, "source", "work.receipt_association")?;
    let revision = rt_check_revision(data, "revision", "work.receipt_association")?;
    if row.id != rt_association_row_id(&record_model, &record_id, &field)? {
        return Err(rt_table_error(
            "work.receipt_association row id must equal its model/record/field derivation."
                .to_string(),
        ));
    }
    Ok(ReceiptAssociation {
        locator: ReceiptLocator { record_id, field },
        delivery_id,
        source,
        revision,
    })
}

pub struct ReceiptLocator {
    pub record_id: U16,
    pub field: U16,
}

pub struct ReceiptAssociation {
    pub locator: ReceiptLocator,
    pub delivery_id: U16,
    pub source: U16,
    pub revision: f64,
}

pub struct AssociatedReceipt {
    pub delivery_id: U16,
    pub revision: f64,
    pub status: U16,
    pub result: Value,
    pub error: Option<ReceiptError>,
}

pub struct StoredReceiptRow {
    pub receipt: AssociatedReceipt,
    pub content_ref: Option<U16>,
    pub result_expires_at_ms: Option<f64>,
}

pub fn rt_read_receipt_row(row: &StoredRow) -> Result<StoredReceiptRow, LinkageError> {
    let data = rt_check_record(&row.data, "work.receipt data")?;
    let delivery_id = rt_check_string(data, "deliveryId", "work.receipt")?;
    let revision = rt_check_revision(data, "revision", "work.receipt")?;
    let status = rt_check_status(data)?;
    // Missing payload keys read as null (transport serialization drops them).
    let result = get(data, "result").unwrap_or(&Value::Null).clone();
    let error_value = get(data, "error").unwrap_or(&Value::Null).clone();
    if !rt_is_stored_receipt_payload(&Value::Str(status.clone()), &result, &error_value) {
        return Err(rt_table_error(format!(
            "work.receipt payload is inconsistent for status {}.",
            js_stringify(&Value::Str(status))
        )));
    }
    if row.id != delivery_id {
        return Err(rt_table_error(
            "work.receipt row id must equal its deliveryId.".to_string(),
        ));
    }
    let error = match &error_value {
        Value::Null => None,
        Value::Obj(o) => {
            let code = o.iter().find(|(k, _)| k.eq_ascii("code"));
            let message = o.iter().find(|(k, _)| k.eq_ascii("message"));
            match (code, message) {
                (Some((_, Value::Str(c))), Some((_, Value::Str(m)))) => Some(ReceiptError {
                    code: c.clone(),
                    message: m.clone(),
                }),
                _ => None,
            }
        }
        _ => None,
    };
    Ok(StoredReceiptRow {
        receipt: AssociatedReceipt {
            delivery_id,
            revision,
            status,
            result,
            error,
        },
        content_ref: rt_check_nullable_content_ref(data)?,
        result_expires_at_ms: rt_check_nullable_expiry(data)?,
    })
}

/* -- Batch linkage assertions. -- */

pub const DISPATCH_JOIN_MODEL: &str = "work.dispatch";

/// One staged outbox intent (the assertion reads its id only).
#[derive(Clone, PartialEq, Debug)]
pub struct OutboxIntent {
    pub intent_id: U16,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WriteKind {
    Insert,
    Update,
    Remove,
}

/// One staged domain write (the assertion reads kind/model/row/id).
#[derive(Clone, PartialEq, Debug)]
pub struct DomainWrite {
    pub kind: WriteKind,
    pub model: U16,
    pub row: StoredRow,
    pub id: Option<U16>,
}

/// One commit batch under assertion (outbox intents plus staged writes).
pub struct CommitBatch {
    pub outbox: Vec<OutboxIntent>,
    pub writes: Vec<DomainWrite>,
}

/**
 * One dispatch-row insert participating in the join: the row id plus the
 * linkage fields the assertion reads structurally.
 */
pub struct DispatchJoinRow {
    pub id: U16,
    pub intent_id: U16,
    /** Pinned stage-time guard verdict; false marks a recorded skip. */
    pub guard_verdict: Option<bool>,
}

fn read_dispatch_join_row(write: &DomainWrite) -> Result<DispatchJoinRow, LinkageError> {
    let data = write.row.data.as_obj();
    let intent_id = data.and_then(|o| get(o, "intentId"));
    let guard_verdict = data.and_then(|o| get(o, "guardVerdict"));
    let intent_id = match intent_id {
        Some(Value::Str(s)) if !s.is_empty() => s.clone(),
        _ => {
            return Err(fail_validation(
                "Dispatch join: work.dispatch inserts must carry a non-empty data.intentId."
                    .to_string(),
            ));
        }
    };
    let guard_verdict = match guard_verdict {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        _ => {
            return Err(fail_validation(
                "Dispatch join: work.dispatch data.guardVerdict must be boolean or null."
                    .to_string(),
            ));
        }
    };
    Ok(DispatchJoinRow {
        id: write.row.id.clone(),
        intent_id,
        guard_verdict,
    })
}

/**
 * Assert the dispatch-join linkage for one commit batch BEFORE it
 * touches the store (fail closed, `StateError` validation). Claim
 * batches (conditional updates) and ordinary batches pass trivially.
 */
pub fn assert_dispatch_join(batch: &CommitBatch) -> Result<(), LinkageError> {
    let mut intent_ids: HashSet<U16> = HashSet::new();
    for intent in batch.outbox.iter() {
        if !intent_ids.insert(intent.intent_id.clone()) {
            return Err(fail_validation(format!(
                "Dispatch join: duplicate outbox intent id {}.",
                js_stringify(&Value::Str(intent.intent_id.clone()))
            )));
        }
    }
    let mut row_by_intent: HashMap<U16, DispatchJoinRow> = HashMap::new();
    // Donor checks row-before-intent in staged order; the map below
    // preserves first-seen order for the trailing no-intent scan.
    let mut staged_order: Vec<U16> = Vec::new();
    for write in batch.writes.iter() {
        if write.kind != WriteKind::Insert || !write.model.eq_ascii(DISPATCH_JOIN_MODEL) {
            continue;
        }
        let row = read_dispatch_join_row(write)?;
        if row.id != row.intent_id {
            return Err(fail_validation(format!(
                "Dispatch join: work.dispatch row id {} must equal its data.intentId {}.",
                js_stringify(&Value::Str(row.id.clone())),
                js_stringify(&Value::Str(row.intent_id.clone()))
            )));
        }
        if row_by_intent.contains_key(&row.intent_id) {
            return Err(fail_validation(format!(
                "Dispatch join: duplicate work.dispatch row for {}.",
                js_stringify(&Value::Str(row.intent_id.clone()))
            )));
        }
        staged_order.push(row.intent_id.clone());
        row_by_intent.insert(row.intent_id.clone(), row);
    }
    // Donor iterates intent ids in first-seen order; HashSet order is
    // unstable, so re-derive insertion order for deterministic errors.
    let mut seen_order: Vec<U16> = Vec::new();
    for intent in batch.outbox.iter() {
        if !seen_order.contains(&intent.intent_id) {
            seen_order.push(intent.intent_id.clone());
        }
    }
    for intent_id in seen_order.iter() {
        if !row_by_intent.contains_key(intent_id) {
            return Err(fail_validation(format!(
                "Dispatch join: outbox intent {} has no work.dispatch row in this batch.",
                js_stringify(&Value::Str(intent_id.clone()))
            )));
        }
    }
    for intent_id in staged_order.iter() {
        let row = &row_by_intent[intent_id];
        if row.guard_verdict != Some(false) && !intent_ids.contains(&row.intent_id) {
            return Err(fail_validation(format!(
                "Dispatch join: work.dispatch row {} has no outbox intent in this batch \
                 (only guard-false skips stage row-only).",
                js_stringify(&Value::Str(row.intent_id.clone()))
            )));
        }
    }
    Ok(())
}

/**
 * One terminal child outcome update participating in the join: the
 * staged row's fanout scope plus its terminal record identity.
 */
pub struct FanoutChildJoinOutcome {
    pub fanout_id: U16,
    pub record_id: U16,
}

/**
 * Assert the fanout child-unit linkage for one commit batch BEFORE it
 * touches the store (fail closed, `StateError` validation). The child
 * unit commits in ONE owner transaction; this assertion pins the
 * fanout halves together. Batches with no fanout writes pass trivially.
 */
pub fn assert_fanout_child_join(batch: &CommitBatch) -> Result<(), LinkageError> {
    let mut child_ids: HashSet<U16> = HashSet::new();
    let mut checkpoint_ids: HashSet<U16> = HashSet::new();
    let mut terminal_outcomes: Vec<FanoutChildJoinOutcome> = Vec::new();
    let mut checkpoint_covers: HashMap<U16, HashSet<U16>> = HashMap::new();
    for write in batch.writes.iter() {
        if write.model.eq_ascii(FANOUT_INTENT_MODEL) {
            if write.kind != WriteKind::Insert {
                return Err(fail_validation(
                    "Fanout child join: work.fanout_intent rows are insert-only \
                     (the frozen set is never redefined)."
                        .to_string(),
                ));
            }
            read_fanout_intent_row(&write.row)?;
            continue;
        }
        if write.model.eq_ascii(FANOUT_CHILD_MODEL) {
            if write.kind == WriteKind::Remove {
                return Err(fail_validation(
                    "Fanout child join: work.fanout_child rows are never removed \
                     (terminal records stand)."
                        .to_string(),
                ));
            }
            if write.kind == WriteKind::Insert {
                let data = read_fanout_child_row(&write.row)?;
                if !data.state.eq_ascii("pending") || data.attempts != 0.0 {
                    return Err(fail_validation(
                        "Fanout child join: work.fanout_child inserts stage pending with zero \
                         attempts (no fabricated claims or outcomes)."
                            .to_string(),
                    ));
                }
                if !child_ids.insert(data.child_id.clone()) {
                    return Err(fail_validation(format!(
                        "Fanout child join: duplicate work.fanout_child row {}.",
                        js_stringify(&Value::Str(data.child_id.clone()))
                    )));
                }
                continue;
            }
            let data = read_fanout_child_row(&write.row)?;
            if !child_ids.insert(data.child_id.clone()) {
                return Err(fail_validation(format!(
                    "Fanout child join: duplicate work.fanout_child row {}.",
                    js_stringify(&Value::Str(data.child_id.clone()))
                )));
            }
            if data.state.eq_ascii("completed")
                || data.state.eq_ascii("skipped")
                || data.state.eq_ascii("failed")
            {
                terminal_outcomes.push(FanoutChildJoinOutcome {
                    fanout_id: data.fanout_id.clone(),
                    record_id: data.record_id.clone(),
                });
            }
            continue;
        }
        if write.model.eq_ascii(FANOUT_CHECKPOINT_MODEL) {
            if write.kind == WriteKind::Remove {
                return Err(fail_validation(
                    "Fanout child join: work.fanout_checkpoint rows are never removed.".to_string(),
                ));
            }
            if write.kind == WriteKind::Insert {
                let data = read_fanout_checkpoint_row(&write.row)?;
                if !data.completed.is_empty() {
                    return Err(fail_validation(
                        "Fanout child join: work.fanout_checkpoint inserts carry an empty \
                         completed set (no fabricated completion)."
                            .to_string(),
                    ));
                }
                if !checkpoint_ids.insert(data.fanout_id.clone()) {
                    return Err(fail_validation(format!(
                        "Fanout child join: duplicate work.fanout_checkpoint row {}.",
                        js_stringify(&Value::Str(data.fanout_id.clone()))
                    )));
                }
                continue;
            }
            let data = read_fanout_checkpoint_row(&write.row)?;
            if !checkpoint_ids.insert(data.fanout_id.clone()) {
                return Err(fail_validation(format!(
                    "Fanout child join: duplicate work.fanout_checkpoint row {}.",
                    js_stringify(&Value::Str(data.fanout_id.clone()))
                )));
            }
            let mut cover: HashSet<U16> = HashSet::new();
            for record in data.completed.iter() {
                cover.insert(record.clone());
            }
            checkpoint_covers.insert(data.fanout_id.clone(), cover);
            continue;
        }
    }
    for outcome in terminal_outcomes.iter() {
        let covered = checkpoint_covers
            .get(&outcome.fanout_id)
            .map(|cover| cover.contains(&outcome.record_id))
            .unwrap_or(false);
        if !covered {
            return Err(fail_validation(format!(
                "Fanout child join: terminal outcome for {} has no same-fanout \
                 checkpoint cover in this batch.",
                js_stringify(&Value::Str(outcome.record_id.clone()))
            )));
        }
    }
    if !checkpoint_covers.is_empty() && terminal_outcomes.is_empty() {
        return Err(fail_validation(
            "Fanout child join: checkpoint updates carry no terminal outcome in this batch \
             (cursor-only maintenance uses the plain store port)."
                .to_string(),
        ));
    }
    Ok(())
}

struct JoinWrite {
    delivery_id: U16,
    revision: f64,
}

fn read_join_write(
    model: &U16,
    row: &StoredRow,
    update_id: Option<&U16>,
    is_update: bool,
) -> Result<JoinWrite, LinkageError> {
    if is_update {
        let matches = update_id.map(|id| *id == row.id).unwrap_or(false);
        if !matches {
            let shown = update_id
                .map(|id| js_stringify(&Value::Str(id.clone())))
                .unwrap_or_else(|| "undefined".to_string());
            return Err(fail_validation(format!(
                "Receipt join: {} update id {} must equal its row id {}.",
                js_lossy(model),
                shown,
                js_stringify(&Value::Str(row.id.clone()))
            )));
        }
    }
    let model_text = js_lossy(model);
    if model.eq_ascii(RECEIPT_ASSOCIATION_MODEL) {
        match rt_read_association_row(row) {
            Ok(association) => {
                return Ok(JoinWrite {
                    delivery_id: association.delivery_id,
                    revision: association.revision,
                });
            }
            Err(error) => {
                if error.name == "ReceiptTableError" {
                    return Err(fail_validation(format!("Receipt join: {}", error.message)));
                }
                return Err(error);
            }
        }
    }
    debug_assert!(model_text == RECEIPT_MODEL);
    match rt_read_receipt_row(row) {
        Ok(stored) => Ok(JoinWrite {
            delivery_id: stored.receipt.delivery_id,
            revision: stored.receipt.revision,
        }),
        Err(error) => {
            if error.name == "ReceiptTableError" {
                return Err(fail_validation(format!("Receipt join: {}", error.message)));
            }
            Err(error)
        }
    }
}

/// Lossy model-name rendering for the update-id message (failure text only).
fn js_lossy(units: &U16) -> String {
    units
        .0
        .iter()
        .map(|u| char::from_u32(*u as u32).unwrap_or('\u{FFFD}'))
        .collect()
}

/**
 * Assert the receipt-join linkage for one commit batch BEFORE it touches
 * the store (fail closed, `StateError` validation). Receipt-only writes
 * are allowed; ordinary batches with neither half pass trivially.
 */
pub fn assert_receipt_join(batch: &CommitBatch) -> Result<(), LinkageError> {
    let mut associations: HashMap<U16, JoinWrite> = HashMap::new();
    let mut receipts: HashMap<U16, JoinWrite> = HashMap::new();
    // Donor iterates associations in first-seen order for deterministic
    // errors; the map below preserves it.
    let mut association_order: Vec<U16> = Vec::new();
    let mut seen: HashSet<(U16, U16)> = HashSet::new();
    for write in batch.writes.iter() {
        if !write.model.eq_ascii(RECEIPT_ASSOCIATION_MODEL) && !write.model.eq_ascii(RECEIPT_MODEL)
        {
            continue;
        }
        if write.kind == WriteKind::Remove {
            continue;
        }
        let row_id = match write.kind {
            WriteKind::Insert => write.row.id.clone(),
            _ => write
                .id
                .clone()
                .unwrap_or_else(|| U16::from_utf8("undefined")),
        };
        if !seen.insert((write.model.clone(), row_id.clone())) {
            let model_text = js_lossy(&write.model);
            return Err(fail_validation(format!(
                "Receipt join: duplicate {model_text} write for {}.",
                js_stringify(&Value::Str(row_id))
            )));
        }
        let join = match write.kind {
            WriteKind::Insert => read_join_write(&write.model, &write.row, None, false)?,
            _ => read_join_write(&write.model, &write.row, write.id.as_ref(), true)?,
        };
        if write.model.eq_ascii(RECEIPT_ASSOCIATION_MODEL) {
            association_order.push(join.delivery_id.clone());
            associations.insert(join.delivery_id.clone(), join);
        } else {
            receipts.insert(join.delivery_id.clone(), join);
        }
    }
    for delivery_id in association_order.iter() {
        let association = &associations[delivery_id];
        match receipts.get(&association.delivery_id) {
            None => {
                return Err(fail_validation(format!(
                    "Receipt join: association for {} has no receipt row in this batch.",
                    js_stringify(&Value::Str(association.delivery_id.clone()))
                )));
            }
            Some(receipt) => {
                if receipt.revision != association.revision {
                    return Err(fail_validation(format!(
                        "Receipt join: receipt revision {} disagrees with association \
                         revision {} for {}.",
                        js_num(receipt.revision),
                        js_num(association.revision),
                        js_stringify(&Value::Str(association.delivery_id.clone()))
                    )));
                }
            }
        }
    }
    Ok(())
} // W04.3 vectors: transcribed from conformance/fixtures/receipts/linkage.json
  // (sha256 f5d2c38ef5ba3d72796343d42874de1587fdb08cace9d0d16330d31d9259dccd); 32 cases. The frozen file is the
  // oracle: this module is generated, never hand-edited.
#[cfg(test)]
mod vectors_linkage {
    use super::*;
    #[test]
    fn v_dispatch_valid() {
        let batch = CommitBatch {
            outbox: vec![OutboxIntent {
                intent_id: U16::from_utf8("i1"),
            }],
            writes: vec![DomainWrite {
                kind: WriteKind::Insert,
                model: U16::from_utf8("work.dispatch"),
                row: StoredRow {
                    id: U16::from_utf8("i1"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (U16::from_utf8("intentId"), Value::Str(U16::from_utf8("i1"))),
                        (U16::from_utf8("guardVerdict"), Value::Null),
                    ])),
                },
                id: None,
            }],
        };
        assert_eq!(assert_dispatch_join(&batch), Ok(()));
    }
    #[test]
    fn v_dispatch_duplicate_intent() {
        let batch = CommitBatch {
            outbox: vec![
                OutboxIntent {
                    intent_id: U16::from_utf8("i1"),
                },
                OutboxIntent {
                    intent_id: U16::from_utf8("i1"),
                },
            ],
            writes: vec![],
        };
        assert_eq!(
            assert_dispatch_join(&batch),
            Err(LinkageError {
                name: "StateError".to_string(),
                code: Some("validation".to_string()),
                message: "Dispatch join: duplicate outbox intent id \"i1\".".to_string()
            })
        );
    }
    #[test]
    fn v_dispatch_id_mismatch() {
        let batch = CommitBatch {
            outbox: vec![OutboxIntent {
                intent_id: U16::from_utf8("i1"),
            }],
            writes: vec![DomainWrite {
                kind: WriteKind::Insert,
                model: U16::from_utf8("work.dispatch"),
                row: StoredRow {
                    id: U16::from_utf8("other"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (U16::from_utf8("intentId"), Value::Str(U16::from_utf8("i1"))),
                        (U16::from_utf8("guardVerdict"), Value::Null),
                    ])),
                },
                id: None,
            }],
        };
        assert_eq!(assert_dispatch_join(&batch), Err(LinkageError { name: "StateError".to_string(), code: Some("validation".to_string()), message: "Dispatch join: work.dispatch row id \"other\" must equal its data.intentId \"i1\".".to_string() }));
    }
    #[test]
    fn v_dispatch_duplicate_row() {
        let batch = CommitBatch {
            outbox: vec![OutboxIntent {
                intent_id: U16::from_utf8("i1"),
            }],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.dispatch"),
                    row: StoredRow {
                        id: U16::from_utf8("i1"),
                        version: 1.0,
                        created: 1000.0,
                        updated: 1000.0,
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (U16::from_utf8("intentId"), Value::Str(U16::from_utf8("i1"))),
                            (U16::from_utf8("guardVerdict"), Value::Null),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.dispatch"),
                    row: StoredRow {
                        id: U16::from_utf8("i1"),
                        version: 1.0,
                        created: 1000.0,
                        updated: 1000.0,
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (U16::from_utf8("intentId"), Value::Str(U16::from_utf8("i1"))),
                            (U16::from_utf8("guardVerdict"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        };
        assert_eq!(
            assert_dispatch_join(&batch),
            Err(LinkageError {
                name: "StateError".to_string(),
                code: Some("validation".to_string()),
                message: "Dispatch join: duplicate work.dispatch row for \"i1\".".to_string()
            })
        );
    }
    #[test]
    fn v_dispatch_intent_without_row() {
        let batch = CommitBatch {
            outbox: vec![OutboxIntent {
                intent_id: U16::from_utf8("i1"),
            }],
            writes: vec![],
        };
        assert_eq!(
            assert_dispatch_join(&batch),
            Err(LinkageError {
                name: "StateError".to_string(),
                code: Some("validation".to_string()),
                message:
                    "Dispatch join: outbox intent \"i1\" has no work.dispatch row in this batch."
                        .to_string()
            })
        );
    }
    #[test]
    fn v_dispatch_row_without_intent() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Insert,
                model: U16::from_utf8("work.dispatch"),
                row: StoredRow {
                    id: U16::from_utf8("i9"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (U16::from_utf8("intentId"), Value::Str(U16::from_utf8("i9"))),
                        (U16::from_utf8("guardVerdict"), Value::Null),
                    ])),
                },
                id: None,
            }],
        };
        assert_eq!(assert_dispatch_join(&batch), Err(LinkageError { name: "StateError".to_string(), code: Some("validation".to_string()), message: "Dispatch join: work.dispatch row \"i9\" has no outbox intent in this batch (only guard-false skips stage row-only).".to_string() }));
    }
    #[test]
    fn v_dispatch_guard_false_row_only() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Insert,
                model: U16::from_utf8("work.dispatch"),
                row: StoredRow {
                    id: U16::from_utf8("sk"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (U16::from_utf8("intentId"), Value::Str(U16::from_utf8("sk"))),
                        (U16::from_utf8("guardVerdict"), Value::Bool(false)),
                    ])),
                },
                id: None,
            }],
        };
        assert_eq!(assert_dispatch_join(&batch), Ok(()));
    }
    #[test]
    fn v_dispatch_updates_pass() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Update,
                model: U16::from_utf8("work.dispatch"),
                row: StoredRow {
                    id: U16::from_utf8("i1"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (U16::from_utf8("intentId"), Value::Str(U16::from_utf8("i1"))),
                        (U16::from_utf8("guardVerdict"), Value::Null),
                    ])),
                },
                id: Some(U16::from_utf8("i1")),
            }],
        };
        assert_eq!(assert_dispatch_join(&batch), Ok(()));
    }
    #[test]
    fn v_dispatch_empty() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![],
        };
        assert_eq!(assert_dispatch_join(&batch), Ok(()));
    }
    #[test]
    fn v_dispatch_other_model() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Insert,
                model: U16::from_utf8("work.other"),
                row: StoredRow {
                    id: U16::from_utf8("x"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![])),
                },
                id: None,
            }],
        };
        assert_eq!(assert_dispatch_join(&batch), Ok(()));
    }
    #[test]
    fn v_dispatch_bad_intent_id() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Insert,
                model: U16::from_utf8("work.dispatch"),
                row: StoredRow {
                    id: U16::from_utf8("x"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (U16::from_utf8("intentId"), Value::Str(U16::from_utf8(""))),
                        (U16::from_utf8("guardVerdict"), Value::Null),
                    ])),
                },
                id: None,
            }],
        };
        assert_eq!(
            assert_dispatch_join(&batch),
            Err(LinkageError {
                name: "StateError".to_string(),
                code: Some("validation".to_string()),
                message:
                    "Dispatch join: work.dispatch inserts must carry a non-empty data.intentId."
                        .to_string()
            })
        );
    }
    #[test]
    fn v_fanout_valid_unit() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Update,
                    model: U16::from_utf8("work.fanout_child"),
                    row: StoredRow {
                        id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                        version: 1.0,
                        created: 1000.0,
                        updated: 1000.0,
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("fanoutId"),
                                Value::Str(U16::from_utf8("fanout/v1/o/h/model")),
                            ),
                            (
                                U16::from_utf8("parentOccurrence"),
                                Value::Str(U16::from_utf8("o")),
                            ),
                            (U16::from_utf8("handler"), Value::Str(U16::from_utf8("h"))),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r1"))),
                            (
                                U16::from_utf8("childId"),
                                Value::Str(U16::from_utf8("fanout-child/v1/o/h/r1")),
                            ),
                            (
                                U16::from_utf8("state"),
                                Value::Str(U16::from_utf8("completed")),
                            ),
                            (U16::from_utf8("attempts"), Value::Num(1.0)),
                            (
                                U16::from_utf8("causeKind"),
                                Value::Str(U16::from_utf8("completed")),
                            ),
                            (U16::from_utf8("causeReason"), Value::Null),
                        ])),
                    },
                    id: Some(U16::from_utf8("fanout-child/v1/o/h/r1")),
                },
                DomainWrite {
                    kind: WriteKind::Update,
                    model: U16::from_utf8("work.fanout_checkpoint"),
                    row: StoredRow {
                        id: U16::from_utf8("fanout/v1/o/h/model"),
                        version: 1.0,
                        created: 1000.0,
                        updated: 1000.0,
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("fanoutId"),
                                Value::Str(U16::from_utf8("fanout/v1/o/h/model")),
                            ),
                            (
                                U16::from_utf8("completed"),
                                Value::Arr(Rc::new(vec![Value::Str(U16::from_utf8("r1"))])),
                            ),
                            (U16::from_utf8("cursor"), Value::Null),
                        ])),
                    },
                    id: Some(U16::from_utf8("fanout/v1/o/h/model")),
                },
            ],
        };
        assert_eq!(assert_fanout_child_join(&batch), Ok(()));
    }
    #[test]
    fn v_fanout_intent_update() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Update,
                model: U16::from_utf8("work.fanout_intent"),
                row: StoredRow {
                    id: U16::from_utf8("fanout/v1/o/h/model"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (
                            U16::from_utf8("fanoutId"),
                            Value::Str(U16::from_utf8("fanout/v1/o/h/model")),
                        ),
                        (
                            U16::from_utf8("sourceOccurrence"),
                            Value::Str(U16::from_utf8("o")),
                        ),
                        (U16::from_utf8("handler"), Value::Str(U16::from_utf8("h"))),
                        (
                            U16::from_utf8("cohort"),
                            Value::Str(U16::from_utf8("model")),
                        ),
                        (
                            U16::from_utf8("members"),
                            Value::Arr(Rc::new(vec![Value::Str(U16::from_utf8("r1"))])),
                        ),
                        (U16::from_utf8("memberCount"), Value::Num(1.0)),
                    ])),
                },
                id: Some(U16::from_utf8("fanout/v1/o/h/model")),
            }],
        };
        assert_eq!(assert_fanout_child_join(&batch), Err(LinkageError { name: "StateError".to_string(), code: Some("validation".to_string()), message: "Fanout child join: work.fanout_intent rows are insert-only (the frozen set is never redefined).".to_string() }));
    }
    #[test]
    fn v_fanout_child_remove() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Remove,
                model: U16::from_utf8("work.fanout_child"),
                row: StoredRow {
                    id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (
                            U16::from_utf8("fanoutId"),
                            Value::Str(U16::from_utf8("fanout/v1/o/h/model")),
                        ),
                        (
                            U16::from_utf8("parentOccurrence"),
                            Value::Str(U16::from_utf8("o")),
                        ),
                        (U16::from_utf8("handler"), Value::Str(U16::from_utf8("h"))),
                        (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r1"))),
                        (
                            U16::from_utf8("childId"),
                            Value::Str(U16::from_utf8("fanout-child/v1/o/h/r1")),
                        ),
                        (
                            U16::from_utf8("state"),
                            Value::Str(U16::from_utf8("completed")),
                        ),
                        (U16::from_utf8("attempts"), Value::Num(1.0)),
                        (
                            U16::from_utf8("causeKind"),
                            Value::Str(U16::from_utf8("completed")),
                        ),
                        (U16::from_utf8("causeReason"), Value::Null),
                    ])),
                },
                id: Some(U16::from_utf8("fanout-child/v1/o/h/r1")),
            }],
        };
        assert_eq!(assert_fanout_child_join(&batch), Err(LinkageError { name: "StateError".to_string(), code: Some("validation".to_string()), message: "Fanout child join: work.fanout_child rows are never removed (terminal records stand).".to_string() }));
    }
    #[test]
    fn v_fanout_child_insert_live() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Insert,
                model: U16::from_utf8("work.fanout_child"),
                row: StoredRow {
                    id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (
                            U16::from_utf8("fanoutId"),
                            Value::Str(U16::from_utf8("fanout/v1/o/h/model")),
                        ),
                        (
                            U16::from_utf8("parentOccurrence"),
                            Value::Str(U16::from_utf8("o")),
                        ),
                        (U16::from_utf8("handler"), Value::Str(U16::from_utf8("h"))),
                        (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r1"))),
                        (
                            U16::from_utf8("childId"),
                            Value::Str(U16::from_utf8("fanout-child/v1/o/h/r1")),
                        ),
                        (
                            U16::from_utf8("state"),
                            Value::Str(U16::from_utf8("completed")),
                        ),
                        (U16::from_utf8("attempts"), Value::Num(1.0)),
                        (
                            U16::from_utf8("causeKind"),
                            Value::Str(U16::from_utf8("completed")),
                        ),
                        (U16::from_utf8("causeReason"), Value::Null),
                    ])),
                },
                id: None,
            }],
        };
        assert_eq!(assert_fanout_child_join(&batch), Err(LinkageError { name: "StateError".to_string(), code: Some("validation".to_string()), message: "Fanout child join: work.fanout_child inserts stage pending with zero attempts (no fabricated claims or outcomes).".to_string() }));
    }
    #[test]
    fn v_fanout_child_insert_dup() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.fanout_child"),
                    row: StoredRow {
                        id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                        version: 1.0,
                        created: 1000.0,
                        updated: 1000.0,
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("fanoutId"),
                                Value::Str(U16::from_utf8("fanout/v1/o/h/model")),
                            ),
                            (
                                U16::from_utf8("parentOccurrence"),
                                Value::Str(U16::from_utf8("o")),
                            ),
                            (U16::from_utf8("handler"), Value::Str(U16::from_utf8("h"))),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r1"))),
                            (
                                U16::from_utf8("childId"),
                                Value::Str(U16::from_utf8("fanout-child/v1/o/h/r1")),
                            ),
                            (
                                U16::from_utf8("state"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("attempts"), Value::Num(0.0)),
                            (U16::from_utf8("causeKind"), Value::Null),
                            (U16::from_utf8("causeReason"), Value::Null),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.fanout_child"),
                    row: StoredRow {
                        id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                        version: 1.0,
                        created: 1000.0,
                        updated: 1000.0,
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("fanoutId"),
                                Value::Str(U16::from_utf8("fanout/v1/o/h/model")),
                            ),
                            (
                                U16::from_utf8("parentOccurrence"),
                                Value::Str(U16::from_utf8("o")),
                            ),
                            (U16::from_utf8("handler"), Value::Str(U16::from_utf8("h"))),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r1"))),
                            (
                                U16::from_utf8("childId"),
                                Value::Str(U16::from_utf8("fanout-child/v1/o/h/r1")),
                            ),
                            (
                                U16::from_utf8("state"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("attempts"), Value::Num(0.0)),
                            (U16::from_utf8("causeKind"), Value::Null),
                            (U16::from_utf8("causeReason"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        };
        assert_eq!(
            assert_fanout_child_join(&batch),
            Err(LinkageError {
                name: "StateError".to_string(),
                code: Some("validation".to_string()),
                message:
                    "Fanout child join: duplicate work.fanout_child row \"fanout-child/v1/o/h/r1\"."
                        .to_string()
            })
        );
    }
    #[test]
    fn v_fanout_checkpoint_insert_full() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Insert,
                model: U16::from_utf8("work.fanout_checkpoint"),
                row: StoredRow {
                    id: U16::from_utf8("fanout/v1/o/h/model"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (
                            U16::from_utf8("fanoutId"),
                            Value::Str(U16::from_utf8("fanout/v1/o/h/model")),
                        ),
                        (
                            U16::from_utf8("completed"),
                            Value::Arr(Rc::new(vec![Value::Str(U16::from_utf8("r1"))])),
                        ),
                        (U16::from_utf8("cursor"), Value::Null),
                    ])),
                },
                id: None,
            }],
        };
        assert_eq!(assert_fanout_child_join(&batch), Err(LinkageError { name: "StateError".to_string(), code: Some("validation".to_string()), message: "Fanout child join: work.fanout_checkpoint inserts carry an empty completed set (no fabricated completion).".to_string() }));
    }
    #[test]
    fn v_fanout_checkpoint_dup() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Update,
                    model: U16::from_utf8("work.fanout_checkpoint"),
                    row: StoredRow {
                        id: U16::from_utf8("fanout/v1/o/h/model"),
                        version: 1.0,
                        created: 1000.0,
                        updated: 1000.0,
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("fanoutId"),
                                Value::Str(U16::from_utf8("fanout/v1/o/h/model")),
                            ),
                            (
                                U16::from_utf8("completed"),
                                Value::Arr(Rc::new(vec![Value::Str(U16::from_utf8("r1"))])),
                            ),
                            (U16::from_utf8("cursor"), Value::Null),
                        ])),
                    },
                    id: Some(U16::from_utf8("fanout/v1/o/h/model")),
                },
                DomainWrite {
                    kind: WriteKind::Update,
                    model: U16::from_utf8("work.fanout_checkpoint"),
                    row: StoredRow {
                        id: U16::from_utf8("fanout/v1/o/h/model"),
                        version: 1.0,
                        created: 1000.0,
                        updated: 1000.0,
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("fanoutId"),
                                Value::Str(U16::from_utf8("fanout/v1/o/h/model")),
                            ),
                            (
                                U16::from_utf8("completed"),
                                Value::Arr(Rc::new(vec![Value::Str(U16::from_utf8("r1"))])),
                            ),
                            (U16::from_utf8("cursor"), Value::Null),
                        ])),
                    },
                    id: Some(U16::from_utf8("fanout/v1/o/h/model")),
                },
            ],
        };
        assert_eq!(assert_fanout_child_join(&batch), Err(LinkageError { name: "StateError".to_string(), code: Some("validation".to_string()), message: "Fanout child join: duplicate work.fanout_checkpoint row \"fanout/v1/o/h/model\".".to_string() }));
    }
    #[test]
    fn v_fanout_outcome_without_cover() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Update,
                model: U16::from_utf8("work.fanout_child"),
                row: StoredRow {
                    id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (
                            U16::from_utf8("fanoutId"),
                            Value::Str(U16::from_utf8("fanout/v1/o/h/model")),
                        ),
                        (
                            U16::from_utf8("parentOccurrence"),
                            Value::Str(U16::from_utf8("o")),
                        ),
                        (U16::from_utf8("handler"), Value::Str(U16::from_utf8("h"))),
                        (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r1"))),
                        (
                            U16::from_utf8("childId"),
                            Value::Str(U16::from_utf8("fanout-child/v1/o/h/r1")),
                        ),
                        (
                            U16::from_utf8("state"),
                            Value::Str(U16::from_utf8("completed")),
                        ),
                        (U16::from_utf8("attempts"), Value::Num(1.0)),
                        (
                            U16::from_utf8("causeKind"),
                            Value::Str(U16::from_utf8("completed")),
                        ),
                        (U16::from_utf8("causeReason"), Value::Null),
                    ])),
                },
                id: Some(U16::from_utf8("fanout-child/v1/o/h/r1")),
            }],
        };
        assert_eq!(assert_fanout_child_join(&batch), Err(LinkageError { name: "StateError".to_string(), code: Some("validation".to_string()), message: "Fanout child join: terminal outcome for \"r1\" has no same-fanout checkpoint cover in this batch.".to_string() }));
    }
    #[test]
    fn v_fanout_cover_without_outcome() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Update,
                model: U16::from_utf8("work.fanout_checkpoint"),
                row: StoredRow {
                    id: U16::from_utf8("fanout/v1/o/h/model"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (
                            U16::from_utf8("fanoutId"),
                            Value::Str(U16::from_utf8("fanout/v1/o/h/model")),
                        ),
                        (
                            U16::from_utf8("completed"),
                            Value::Arr(Rc::new(vec![Value::Str(U16::from_utf8("r1"))])),
                        ),
                        (U16::from_utf8("cursor"), Value::Null),
                    ])),
                },
                id: Some(U16::from_utf8("fanout/v1/o/h/model")),
            }],
        };
        assert_eq!(assert_fanout_child_join(&batch), Err(LinkageError { name: "StateError".to_string(), code: Some("validation".to_string()), message: "Fanout child join: checkpoint updates carry no terminal outcome in this batch (cursor-only maintenance uses the plain store port).".to_string() }));
    }
    #[test]
    fn v_fanout_nonterminal_passes() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Update,
                model: U16::from_utf8("work.fanout_child"),
                row: StoredRow {
                    id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (
                            U16::from_utf8("fanoutId"),
                            Value::Str(U16::from_utf8("fanout/v1/o/h/model")),
                        ),
                        (
                            U16::from_utf8("parentOccurrence"),
                            Value::Str(U16::from_utf8("o")),
                        ),
                        (U16::from_utf8("handler"), Value::Str(U16::from_utf8("h"))),
                        (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r1"))),
                        (
                            U16::from_utf8("childId"),
                            Value::Str(U16::from_utf8("fanout-child/v1/o/h/r1")),
                        ),
                        (
                            U16::from_utf8("state"),
                            Value::Str(U16::from_utf8("running")),
                        ),
                        (U16::from_utf8("attempts"), Value::Num(0.0)),
                        (U16::from_utf8("causeKind"), Value::Null),
                        (U16::from_utf8("causeReason"), Value::Null),
                    ])),
                },
                id: Some(U16::from_utf8("fanout-child/v1/o/h/r1")),
            }],
        };
        assert_eq!(assert_fanout_child_join(&batch), Ok(()));
    }
    #[test]
    fn v_fanout_empty() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![],
        };
        assert_eq!(assert_fanout_child_join(&batch), Ok(()));
    }
    #[test]
    fn v_fanout_intent_insert_ok() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Insert,
                model: U16::from_utf8("work.fanout_intent"),
                row: StoredRow {
                    id: U16::from_utf8("fanout/v1/o/h/model"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (
                            U16::from_utf8("fanoutId"),
                            Value::Str(U16::from_utf8("fanout/v1/o/h/model")),
                        ),
                        (
                            U16::from_utf8("sourceOccurrence"),
                            Value::Str(U16::from_utf8("o")),
                        ),
                        (U16::from_utf8("handler"), Value::Str(U16::from_utf8("h"))),
                        (
                            U16::from_utf8("cohort"),
                            Value::Str(U16::from_utf8("model")),
                        ),
                        (
                            U16::from_utf8("members"),
                            Value::Arr(Rc::new(vec![
                                Value::Str(U16::from_utf8("a")),
                                Value::Str(U16::from_utf8("b")),
                            ])),
                        ),
                        (U16::from_utf8("memberCount"), Value::Num(2.0)),
                    ])),
                },
                id: None,
            }],
        };
        assert_eq!(assert_fanout_child_join(&batch), Ok(()));
    }
    #[test]
    fn v_receipt_valid_pair() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt_association"),
                    row: StoredRow {
                        id: U16::from_utf8("receipt-assoc/v1/m/r/f"),
                        version: 1.0,
                        created: 1000.0,
                        updated: 1000.0,
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("recordModel"),
                                Value::Str(U16::from_utf8("m")),
                            ),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r"))),
                            (U16::from_utf8("field"), Value::Str(U16::from_utf8("f"))),
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("source"), Value::Str(U16::from_utf8("s"))),
                            (U16::from_utf8("revision"), Value::Num(2.0)),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt"),
                    row: StoredRow {
                        id: U16::from_utf8("d-1"),
                        version: 1.0,
                        created: 1000.0,
                        updated: 1000.0,
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("revision"), Value::Num(2.0)),
                            (
                                U16::from_utf8("status"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("result"), Value::Null),
                            (U16::from_utf8("error"), Value::Null),
                            (U16::from_utf8("contentRef"), Value::Null),
                            (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        };
        assert_eq!(assert_receipt_join(&batch), Ok(()));
    }
    #[test]
    fn v_receipt_only_allowed() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Insert,
                model: U16::from_utf8("work.receipt"),
                row: StoredRow {
                    id: U16::from_utf8("d-9"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (
                            U16::from_utf8("deliveryId"),
                            Value::Str(U16::from_utf8("d-9")),
                        ),
                        (U16::from_utf8("revision"), Value::Num(0.0)),
                        (
                            U16::from_utf8("status"),
                            Value::Str(U16::from_utf8("pending")),
                        ),
                        (U16::from_utf8("result"), Value::Null),
                        (U16::from_utf8("error"), Value::Null),
                        (U16::from_utf8("contentRef"), Value::Null),
                        (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                    ])),
                },
                id: None,
            }],
        };
        assert_eq!(assert_receipt_join(&batch), Ok(()));
    }
    #[test]
    fn v_receipt_assoc_without_receipt() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Insert,
                model: U16::from_utf8("work.receipt_association"),
                row: StoredRow {
                    id: U16::from_utf8("receipt-assoc/v1/m/r/f"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (
                            U16::from_utf8("recordModel"),
                            Value::Str(U16::from_utf8("m")),
                        ),
                        (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r"))),
                        (U16::from_utf8("field"), Value::Str(U16::from_utf8("f"))),
                        (
                            U16::from_utf8("deliveryId"),
                            Value::Str(U16::from_utf8("d-1")),
                        ),
                        (U16::from_utf8("source"), Value::Str(U16::from_utf8("s"))),
                        (U16::from_utf8("revision"), Value::Num(2.0)),
                    ])),
                },
                id: None,
            }],
        };
        assert_eq!(
            assert_receipt_join(&batch),
            Err(LinkageError {
                name: "StateError".to_string(),
                code: Some("validation".to_string()),
                message: "Receipt join: association for \"d-1\" has no receipt row in this batch."
                    .to_string()
            })
        );
    }
    #[test]
    fn v_receipt_revision_skew() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt_association"),
                    row: StoredRow {
                        id: U16::from_utf8("receipt-assoc/v1/m/r/f"),
                        version: 1.0,
                        created: 1000.0,
                        updated: 1000.0,
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("recordModel"),
                                Value::Str(U16::from_utf8("m")),
                            ),
                            (U16::from_utf8("recordId"), Value::Str(U16::from_utf8("r"))),
                            (U16::from_utf8("field"), Value::Str(U16::from_utf8("f"))),
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("source"), Value::Str(U16::from_utf8("s"))),
                            (U16::from_utf8("revision"), Value::Num(2.0)),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt"),
                    row: StoredRow {
                        id: U16::from_utf8("d-1"),
                        version: 1.0,
                        created: 1000.0,
                        updated: 1000.0,
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("revision"), Value::Num(3.0)),
                            (
                                U16::from_utf8("status"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("result"), Value::Null),
                            (U16::from_utf8("error"), Value::Null),
                            (U16::from_utf8("contentRef"), Value::Null),
                            (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        };
        assert_eq!(assert_receipt_join(&batch), Err(LinkageError { name: "StateError".to_string(), code: Some("validation".to_string()), message: "Receipt join: receipt revision 3 disagrees with association revision 2 for \"d-1\".".to_string() }));
    }
    #[test]
    fn v_receipt_duplicate_write() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt"),
                    row: StoredRow {
                        id: U16::from_utf8("d-1"),
                        version: 1.0,
                        created: 1000.0,
                        updated: 1000.0,
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("revision"), Value::Num(0.0)),
                            (
                                U16::from_utf8("status"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("result"), Value::Null),
                            (U16::from_utf8("error"), Value::Null),
                            (U16::from_utf8("contentRef"), Value::Null),
                            (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                        ])),
                    },
                    id: None,
                },
                DomainWrite {
                    kind: WriteKind::Insert,
                    model: U16::from_utf8("work.receipt"),
                    row: StoredRow {
                        id: U16::from_utf8("d-1"),
                        version: 1.0,
                        created: 1000.0,
                        updated: 1000.0,
                        created_by: U16::from_utf8("fz"),
                        updated_by: U16::from_utf8("fz"),
                        archived_at: Value::Null,
                        parent: Value::Null,
                        data: Value::Obj(Rc::new(vec![
                            (
                                U16::from_utf8("deliveryId"),
                                Value::Str(U16::from_utf8("d-1")),
                            ),
                            (U16::from_utf8("revision"), Value::Num(0.0)),
                            (
                                U16::from_utf8("status"),
                                Value::Str(U16::from_utf8("pending")),
                            ),
                            (U16::from_utf8("result"), Value::Null),
                            (U16::from_utf8("error"), Value::Null),
                            (U16::from_utf8("contentRef"), Value::Null),
                            (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                        ])),
                    },
                    id: None,
                },
            ],
        };
        assert_eq!(
            assert_receipt_join(&batch),
            Err(LinkageError {
                name: "StateError".to_string(),
                code: Some("validation".to_string()),
                message: "Receipt join: duplicate work.receipt write for \"d-1\".".to_string()
            })
        );
    }
    #[test]
    fn v_receipt_update_id_mismatch() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Update,
                model: U16::from_utf8("work.receipt"),
                row: StoredRow {
                    id: U16::from_utf8("d-1"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (
                            U16::from_utf8("deliveryId"),
                            Value::Str(U16::from_utf8("d-1")),
                        ),
                        (U16::from_utf8("revision"), Value::Num(0.0)),
                        (
                            U16::from_utf8("status"),
                            Value::Str(U16::from_utf8("pending")),
                        ),
                        (U16::from_utf8("result"), Value::Null),
                        (U16::from_utf8("error"), Value::Null),
                        (U16::from_utf8("contentRef"), Value::Null),
                        (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                    ])),
                },
                id: Some(U16::from_utf8("nope")),
            }],
        };
        assert_eq!(
            assert_receipt_join(&batch),
            Err(LinkageError {
                name: "StateError".to_string(),
                code: Some("validation".to_string()),
                message:
                    "Receipt join: work.receipt update id \"nope\" must equal its row id \"d-1\"."
                        .to_string()
            })
        );
    }
    #[test]
    fn v_receipt_corrupt_row() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Update,
                model: U16::from_utf8("work.receipt"),
                row: StoredRow {
                    id: U16::from_utf8("d-1"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (
                            U16::from_utf8("deliveryId"),
                            Value::Str(U16::from_utf8("d-1")),
                        ),
                        (U16::from_utf8("revision"), Value::Num(-2.0)),
                        (
                            U16::from_utf8("status"),
                            Value::Str(U16::from_utf8("pending")),
                        ),
                        (U16::from_utf8("result"), Value::Null),
                        (U16::from_utf8("error"), Value::Null),
                        (U16::from_utf8("contentRef"), Value::Null),
                        (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                    ])),
                },
                id: Some(U16::from_utf8("d-1")),
            }],
        };
        assert_eq!(
            assert_receipt_join(&batch),
            Err(LinkageError {
                name: "StateError".to_string(),
                code: Some("validation".to_string()),
                message: "Receipt join: work.receipt.revision must be an integer >= 0.".to_string()
            })
        );
    }
    #[test]
    fn v_receipt_remove_ignored() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![DomainWrite {
                kind: WriteKind::Remove,
                model: U16::from_utf8("work.receipt"),
                row: StoredRow {
                    id: U16::from_utf8("d-1"),
                    version: 1.0,
                    created: 1000.0,
                    updated: 1000.0,
                    created_by: U16::from_utf8("fz"),
                    updated_by: U16::from_utf8("fz"),
                    archived_at: Value::Null,
                    parent: Value::Null,
                    data: Value::Obj(Rc::new(vec![
                        (
                            U16::from_utf8("deliveryId"),
                            Value::Str(U16::from_utf8("d-1")),
                        ),
                        (U16::from_utf8("revision"), Value::Num(0.0)),
                        (
                            U16::from_utf8("status"),
                            Value::Str(U16::from_utf8("pending")),
                        ),
                        (U16::from_utf8("result"), Value::Null),
                        (U16::from_utf8("error"), Value::Null),
                        (U16::from_utf8("contentRef"), Value::Null),
                        (U16::from_utf8("resultExpiresAtMs"), Value::Null),
                    ])),
                },
                id: Some(U16::from_utf8("d-1")),
            }],
        };
        assert_eq!(assert_receipt_join(&batch), Ok(()));
    }
    #[test]
    fn v_receipt_empty() {
        let batch = CommitBatch {
            outbox: vec![],
            writes: vec![],
        };
        assert_eq!(assert_receipt_join(&batch), Ok(()));
    }
    #[test]
    fn v_join_models() {
        assert_eq!(DISPATCH_JOIN_MODEL, "work.dispatch");
        assert_eq!(FANOUT_INTENT_MODEL, "work.fanout_intent");
        assert_eq!(FANOUT_CHILD_MODEL, "work.fanout_child");
        assert_eq!(FANOUT_CHECKPOINT_MODEL, "work.fanout_checkpoint");
        assert_eq!(RECEIPT_ASSOCIATION_MODEL, "work.receipt_association");
        assert_eq!(RECEIPT_MODEL, "work.receipt");
    }
}

// N03 immutable witnesses: private Cargo route, not standalone rustc.
#[cfg(test)]
#[path = "../conformance/native-numeric-text.rs"]
mod n03_numeric_tests;
