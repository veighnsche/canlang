//! W04.3 — Native receipt decisions + stored receipt rows.
//!
//! Data-only Rust port of `src/receipt.ts`, proven against the same
//! independent TS oracle corpus (`conformance/fixtures/receipts/receipt.json`).
//! N03 replaces standalone rustc testing with an isolated private Cargo project
//! containing exact copies of this file and numeric_text.rs; ryu-js =1.0.3,
//! default features off. Run original embedded vectors and immutable witnesses.
//! Official product dependency/root registration remains pending. The shared prelude
//! (UTF-16 text, JS value model, JSON rendering, URI encoding,
//! JSON-safety traversal, stored-row shape) is duplicated verbatim
//! from the proven `rows.rs` sibling until W04.4 assembly consolidates
//! it; only the error type and the receipt tables are new.

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
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn eq_ascii(&self, s: &str) -> bool {
        self.0.len() == s.len() && self.0.iter().zip(s.bytes()).all(|(u, b)| *u == b as u16)
    }
    /// Canonical array index (all-ASCII-digits, no leading zero unless
    /// the key is `0` itself, numeric value strictly below 2^32 - 1).
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
    fn push_lossy(&self, out: &mut String) {
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
    }
}

impl std::fmt::Debug for U16 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.debug_escaped())
    }
}

/// JS value model. Objects/arrays ride behind `Rc` so DAG-shared
/// references keep their identity for the seen-set traversal.
/// `Undef`/`Func` cover the frozen `$undef`/`$fn` corpus tags (never
/// JSON-safe; stringify renders them `undefined`, exactly as the
/// donor's template interpolation does).
#[derive(Clone, Debug)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(U16),
    Arr(Rc<Vec<Value>>),
    Obj(Rc<Vec<(U16, Value)>>),
    Undef,
    Func,
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
            _ => false,
        }
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
        // Only reachable inside `${...}` interpolation, where the donor
        // renders the undefined stringify result as `undefined`.
        Value::Undef | Value::Func => "undefined".to_string(),
    }
}

/// `encodeURIComponent` over UTF-16 units (unreserved set + uppercase
/// hex, exactly). Lone surrogates fail under the pinned `URIError` name.
fn encode_uri_component(units: &[u16]) -> Result<U16, ReceiptFailure> {
    super::uri_component::encode(units).map(U16).map_err(|_| ReceiptFailure {
            name: "URIError".to_string(),
            message: "URI malformed".to_string(),
        })
}

/// Parity error: name/message match the TS donor (`ReceiptTableError`,
/// `RangeError`, or engine-thrown `URIError`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ReceiptFailure {
    pub name: String,
    pub message: String,
}

fn table_error(message: String) -> ReceiptFailure {
    ReceiptFailure {
        name: "ReceiptTableError".to_string(),
        message,
    }
}

fn range_error(message: String) -> ReceiptFailure {
    ReceiptFailure {
        name: "RangeError".to_string(),
        message,
    }
}

/// One durable provider-call attempt record.
#[derive(Clone, PartialEq, Debug)]
pub struct OutboxItem {
    pub id: U16,
    pub operation_id: U16,
    pub source: U16,
    pub occurrence_index: f64,
    pub request: Value,
    pub origin_occurrence: Option<U16>,
    pub attempts: f64,
    pub state: U16,
}

/**
 * Dead-letter listing: every `dead` item, in stable id order, for visible
 * operator review. Projection and authorization stay with the owning reads.
 */
pub fn list_dead_letter(items: &[OutboxItem]) -> Vec<OutboxItem> {
    let mut out: Vec<OutboxItem> = items
        .iter()
        .filter(|item| item.state.eq_ascii("dead"))
        .cloned()
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn is_closed_error_shape(error: &Value) -> bool {
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

/// Missing (`undefined`) payload keys read as null; anything else must match.
fn payload_or_null(v: &Value) -> &Value {
    match v {
        Value::Undef => &NULL_VALUE,
        _ => v,
    }
}

const NULL_VALUE: Value = Value::Null;

/**
 * A completion envelope is consistent when its status and payload agree.
 * Never throws: completions arrive from callback paths and may be
 * arbitrarily shaped, so every check is a predicate.
 */
pub fn is_consistent_completion(status: &Value, result: &Value, error: &Value) -> bool {
    let payload = payload_or_null(result);
    let failure = payload_or_null(error);
    if let Value::Str(s) = status {
        if s.eq_ascii("succeeded") {
            return *failure == Value::Null;
        }
        if s.eq_ascii("failed") {
            return *payload == Value::Null && is_closed_error_shape(failure);
        }
        if s.eq_ascii("unknown") {
            return *payload == Value::Null
                && (*failure == Value::Null || is_closed_error_shape(failure));
        }
        if s.eq_ascii("skipped") {
            return *payload == Value::Null && *failure == Value::Null;
        }
    }
    false
}

/**
 * Stored receipt-payload consistency (DESIGN section 8.0): a structural
 * mirror of the work-side completion check, EXTENDED with the pending
 * receipt rule. Never throws: predicate over stored/caller input.
 */
pub fn is_stored_receipt_payload(status: &Value, result: &Value, error: &Value) -> bool {
    let payload = payload_or_null(result);
    let failure = payload_or_null(error);
    if let Value::Str(s) = status {
        if s.eq_ascii("pending") {
            return *payload == Value::Null && *failure == Value::Null;
        }
        if s.eq_ascii("succeeded") {
            return *failure == Value::Null;
        }
        if s.eq_ascii("failed") {
            return *payload == Value::Null && is_closed_error_shape(failure);
        }
        if s.eq_ascii("unknown") {
            return *payload == Value::Null
                && (*failure == Value::Null || is_closed_error_shape(failure));
        }
        if s.eq_ascii("skipped") {
            return *payload == Value::Null && *failure == Value::Null;
        }
    }
    false
}

/** True exactly for the terminal receipt states. */
pub fn is_terminal_receipt_status(status: &U16) -> bool {
    status.eq_ascii("succeeded") || status.eq_ascii("failed") || status.eq_ascii("skipped")
}

/// Closed `{code, message}` string pair.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ReceiptError {
    pub code: U16,
    pub message: U16,
}

pub struct RecordedReceiptFields {
    pub status: U16,
    pub result: Value,
    pub error: Option<ReceiptError>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct ReceiptObservation {
    pub id: U16,
    pub revision: f64,
    pub status: U16,
    pub result: Value,
    pub error: Option<ReceiptError>,
}

/**
 * Assemble an authorized receipt observation from recorded fields. Result
 * and error pass through by host reference (cloned handles here).
 */
pub fn to_receipt_observation(
    delivery_id: &U16,
    revision: f64,
    recorded: &RecordedReceiptFields,
) -> Result<ReceiptObservation, ReceiptFailure> {
    if delivery_id.is_empty() {
        return Err(range_error(
            "toReceiptObservation: deliveryId must be a non-empty string".to_string(),
        ));
    }
    if revision.fract() != 0.0 || revision < 0.0 {
        return Err(range_error(
            "toReceiptObservation: revision must be a non-negative integer".to_string(),
        ));
    }
    Ok(ReceiptObservation {
        id: delivery_id.clone(),
        revision,
        status: recorded.status.clone(),
        result: recorded.result.clone(),
        error: recorded.error.clone(),
    })
}

/* -- Stored association/receipt rows (state direction). -- */

/// Stored current-attempt association rows (structural literal).
pub const RECEIPT_ASSOCIATION_MODEL: &str = "work.receipt_association";

/// Retained receipt rows, one per delivery attempt.
pub const RECEIPT_MODEL: &str = "work.receipt";

/// Current-attempt association for one (record, delivery field). Flat.
pub struct AssociationRowData {
    pub record_model: U16,
    pub record_id: U16,
    pub field: U16,
    /// Current attempt's delivery id; completions carry it as `delivery_id`.
    pub delivery_id: U16,
    /// Canonical source identity (declaration/binding of the send).
    pub source: U16,
    /// Owner checkpoint revision of the latest applied receipt progress.
    pub revision: f64,
}

/// Retained receipt row: the `AssociatedReceipt` plus result retention.
pub struct ReceiptRowData {
    pub delivery_id: U16,
    pub revision: f64,
    pub status: U16,
    pub result: Value,
    pub error: Option<ReceiptError>,
    pub content_ref: Option<U16>,
    pub result_expires_at_ms: Option<f64>,
}

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
 * Deterministic association row id under owner model + record + field.
 * Components are encoded so `/` separators stay unambiguous.
 */
pub fn association_row_id(
    model: &U16,
    record_id: &U16,
    field: &U16,
) -> Result<U16, ReceiptFailure> {
    if model.is_empty() || record_id.is_empty() || field.is_empty() {
        return Err(table_error(
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

fn get<'a>(record: &'a [(U16, Value)], field: &str) -> Option<&'a Value> {
    record
        .iter()
        .find(|(k, _)| k.eq_ascii(field))
        .map(|(_, v)| v)
}

fn check_record<'a>(value: &'a Value, what: &str) -> Result<&'a Vec<(U16, Value)>, ReceiptFailure> {
    match value.as_obj() {
        Some(o) => Ok(o),
        None => Err(table_error(format!("{what} must be an object."))),
    }
}

fn check_string(record: &[(U16, Value)], field: &str, what: &str) -> Result<U16, ReceiptFailure> {
    match get(record, field) {
        Some(Value::Str(s)) if !s.is_empty() => Ok(s.clone()),
        _ => Err(table_error(format!(
            "{what}.{field} must be a non-empty string."
        ))),
    }
}

fn check_revision(record: &[(U16, Value)], field: &str, what: &str) -> Result<f64, ReceiptFailure> {
    match get(record, field) {
        Some(Value::Num(n)) if n.fract() == 0.0 && *n >= 0.0 => Ok(*n),
        _ => Err(table_error(format!(
            "{what}.{field} must be an integer >= 0."
        ))),
    }
}

fn check_status(record: &[(U16, Value)]) -> Result<U16, ReceiptFailure> {
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
        other => Err(table_error(format!(
            "work.receipt.status is unknown: {}.",
            js_stringify(other.unwrap_or(&Value::Undef))
        ))),
    }
}

fn check_nullable_content_ref(record: &[(U16, Value)]) -> Result<Option<U16>, ReceiptFailure> {
    match get(record, "contentRef") {
        Some(Value::Null) => Ok(None),
        Some(Value::Str(s)) if !s.is_empty() => Ok(Some(s.clone())),
        _ => Err(table_error(
            "work.receipt.contentRef must be a non-empty string or null.".to_string(),
        )),
    }
}

fn check_nullable_expiry(record: &[(U16, Value)]) -> Result<Option<f64>, ReceiptFailure> {
    match get(record, "resultExpiresAtMs") {
        Some(Value::Null) => Ok(None),
        Some(Value::Num(n)) if n.is_finite() && *n >= 0.0 => Ok(Some(*n)),
        _ => Err(table_error(
            "work.receipt.resultExpiresAtMs must be finite epoch ms or null.".to_string(),
        )),
    }
}

/// Deep JSON-safety: row data must survive the store JSON round-trip.
/// The seen set never prunes (donor-verbatim): DAG-shared references
/// report cyclic exactly like true cycles.
fn check_json_safe(value: &Value, what: &str) -> Result<(), ReceiptFailure> {
    fn visit(
        node: &Value,
        path: &mut String,
        seen: &mut HashSet<usize>,
        what: &str,
    ) -> Result<(), ReceiptFailure> {
        match node {
            Value::Null | Value::Bool(_) | Value::Str(_) => Ok(()),
            Value::Num(n) => {
                if n.is_finite() {
                    Ok(())
                } else {
                    Err(table_error(format!("{what}{path} must be finite JSON.")))
                }
            }
            Value::Undef | Value::Func => {
                Err(table_error(format!("{what}{path} is not JSON-safe.")))
            }
            Value::Arr(a) => {
                let id = Rc::as_ptr(a) as usize;
                if !seen.insert(id) {
                    return Err(table_error(format!("{what}{path} is cyclic.")));
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
                    return Err(table_error(format!("{what}{path} is cyclic.")));
                }
                for (k, e) in enum_entries(o).iter() {
                    let base = path.len();
                    path.push('.');
                    k.push_lossy(path);
                    visit(e, path, seen, what)?;
                    path.truncate(base);
                }
                Ok(())
            }
        }
    }
    visit(value, &mut String::new(), &mut HashSet::new(), what)
}

/// Read one association row's data, failing closed on any shape drift.
pub fn read_association_row(row: &StoredRow) -> Result<ReceiptAssociation, ReceiptFailure> {
    let data = check_record(&row.data, "work.receipt_association data")?;
    let record_model = check_string(data, "recordModel", "work.receipt_association")?;
    let record_id = check_string(data, "recordId", "work.receipt_association")?;
    let field = check_string(data, "field", "work.receipt_association")?;
    let delivery_id = check_string(data, "deliveryId", "work.receipt_association")?;
    let source = check_string(data, "source", "work.receipt_association")?;
    let revision = check_revision(data, "revision", "work.receipt_association")?;
    if row.id != association_row_id(&record_model, &record_id, &field)? {
        return Err(table_error(
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

#[derive(Clone, PartialEq, Debug)]
pub struct ReceiptLocator {
    pub record_id: U16,
    pub field: U16,
}

#[derive(Clone, PartialEq, Debug)]
pub struct ReceiptAssociation {
    pub locator: ReceiptLocator,
    pub delivery_id: U16,
    pub source: U16,
    pub revision: f64,
}

#[derive(Clone, PartialEq, Debug)]
pub struct AssociatedReceipt {
    pub delivery_id: U16,
    pub revision: f64,
    pub status: U16,
    pub result: Value,
    pub error: Option<ReceiptError>,
}

/// One receipt row's data: the retained receipt plus its retention binding.
#[derive(Clone, PartialEq, Debug)]
pub struct StoredReceiptRow {
    pub receipt: AssociatedReceipt,
    pub content_ref: Option<U16>,
    pub result_expires_at_ms: Option<f64>,
}

/// Read one receipt row's data, failing closed on any shape drift.
pub fn read_receipt_row(row: &StoredRow) -> Result<StoredReceiptRow, ReceiptFailure> {
    let data = check_record(&row.data, "work.receipt data")?;
    let delivery_id = check_string(data, "deliveryId", "work.receipt")?;
    let revision = check_revision(data, "revision", "work.receipt")?;
    let status = check_status(data)?;
    let result = get(data, "result").unwrap_or(&Value::Null).clone();
    let error_value = get(data, "error").unwrap_or(&Value::Null).clone();
    // Missing payload keys read as null (transport serialization drops them).
    let result = if result == Value::Undef {
        Value::Null
    } else {
        result
    };
    let error_value = if error_value == Value::Undef {
        Value::Null
    } else {
        error_value
    };
    if !is_stored_receipt_payload(&Value::Str(status.clone()), &result, &error_value) {
        return Err(table_error(format!(
            "work.receipt payload is inconsistent for status {}.",
            js_stringify(&Value::Str(status))
        )));
    }
    if row.id != delivery_id {
        return Err(table_error(
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
        content_ref: check_nullable_content_ref(data)?,
        result_expires_at_ms: check_nullable_expiry(data)?,
    })
}

fn check_meta(meta: &NewRowMeta, what: &str) -> Result<(), ReceiptFailure> {
    if !meta.now_ms.is_finite() || meta.now_ms < 0.0 {
        return Err(table_error(format!(
            "{what}: nowMs must be finite epoch ms >= 0."
        )));
    }
    if meta.actor.is_empty() {
        return Err(table_error(format!(
            "{what}: actor must be a non-empty string."
        )));
    }
    Ok(())
}

fn data_value_for_association(input: &AssociationRowData) -> Value {
    // Donor field order (insertion order survives the clone).
    Value::Obj(Rc::new(vec![
        (
            U16::from_utf8("recordModel"),
            Value::Str(input.record_model.clone()),
        ),
        (
            U16::from_utf8("recordId"),
            Value::Str(input.record_id.clone()),
        ),
        (U16::from_utf8("field"), Value::Str(input.field.clone())),
        (
            U16::from_utf8("deliveryId"),
            Value::Str(input.delivery_id.clone()),
        ),
        (U16::from_utf8("source"), Value::Str(input.source.clone())),
        (U16::from_utf8("revision"), Value::Num(input.revision)),
    ]))
}

fn data_value_for_receipt(input: &ReceiptRowData) -> Value {
    let error = match &input.error {
        None => Value::Null,
        Some(e) => Value::Obj(Rc::new(vec![
            (U16::from_utf8("code"), Value::Str(e.code.clone())),
            (U16::from_utf8("message"), Value::Str(e.message.clone())),
        ])),
    };
    Value::Obj(Rc::new(vec![
        (
            U16::from_utf8("deliveryId"),
            Value::Str(input.delivery_id.clone()),
        ),
        (U16::from_utf8("revision"), Value::Num(input.revision)),
        (U16::from_utf8("status"), Value::Str(input.status.clone())),
        (U16::from_utf8("result"), input.result.clone()),
        (U16::from_utf8("error"), error),
        (
            U16::from_utf8("contentRef"),
            input
                .content_ref
                .clone()
                .map(Value::Str)
                .unwrap_or(Value::Null),
        ),
        (
            U16::from_utf8("resultExpiresAtMs"),
            input
                .result_expires_at_ms
                .map(Value::Num)
                .unwrap_or(Value::Null),
        ),
    ]))
}

fn new_row(
    id: U16,
    data: &Value,
    meta: &NewRowMeta,
    what: &str,
) -> Result<StoredRow, ReceiptFailure> {
    check_meta(meta, what)?;
    check_json_safe(data, &format!("{what} data"))?;
    Ok(StoredRow {
        id,
        version: 1.0,
        created: meta.now_ms,
        updated: meta.now_ms,
        created_by: meta.actor.clone(),
        updated_by: meta.actor.clone(),
        archived_at: Value::Null,
        parent: Value::Null,
        // Deep clone: staged rows must not alias caller-owned nested data.
        data: data.deep_clone(),
    })
}

/**
 * Replacement row for a conditional update: version + 1 with fresh
 * updated metadata. The observation revision must advance
 * monotonically (equal revisions are idempotent replays); a decreased
 * revision is stale progress and refused here, before the store.
 */
fn with_row_data(
    row: &StoredRow,
    data: &Value,
    revision: f64,
    meta: &NewRowMeta,
    what: &str,
) -> Result<StoredRow, ReceiptFailure> {
    check_meta(meta, what)?;
    if let Value::Obj(o) = &row.data {
        if let Some(Value::Num(current)) = get(o, "revision") {
            if revision < *current {
                return Err(table_error(format!(
                    "{what}: stale revision {} under current {}.",
                    js_num(revision),
                    js_num(*current)
                )));
            }
        }
    }
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
        // Deep clone: staged rows must not alias caller-owned nested data.
        data: data.deep_clone(),
    })
}

/// Producer-side insert: the current-attempt association for one locator.
pub fn new_association_row(
    input: &AssociationRowData,
    meta: &NewRowMeta,
) -> Result<StoredRow, ReceiptFailure> {
    let row = new_row(
        association_row_id(&input.record_model, &input.record_id, &input.field)?,
        &data_value_for_association(input),
        meta,
        "work.receipt_association",
    )?;
    // The constructor validates shape, never linkage: fail fast here so a
    // malformed association never stages.
    read_association_row(&row)?;
    Ok(row)
}

/// Producer-side insert: the retained receipt row for one delivery attempt.
pub fn new_receipt_row(
    input: &ReceiptRowData,
    meta: &NewRowMeta,
) -> Result<StoredRow, ReceiptFailure> {
    let row = new_row(
        input.delivery_id.clone(),
        &data_value_for_receipt(input),
        meta,
        "work.receipt",
    )?;
    read_receipt_row(&row)?;
    Ok(row)
}

/// Conditional-update replacement for one association row (see `with_row_data`).
pub fn with_association_row_data(
    row: &StoredRow,
    data: &AssociationRowData,
    meta: &NewRowMeta,
) -> Result<StoredRow, ReceiptFailure> {
    let next = with_row_data(
        row,
        &data_value_for_association(data),
        data.revision,
        meta,
        "work.receipt_association",
    )?;
    read_association_row(&next)?;
    Ok(next)
}

/// Conditional-update replacement for one receipt row (see `with_row_data`).
pub fn with_receipt_row_data(
    row: &StoredRow,
    data: &ReceiptRowData,
    meta: &NewRowMeta,
) -> Result<StoredRow, ReceiptFailure> {
    let next = with_row_data(
        row,
        &data_value_for_receipt(data),
        data.revision,
        meta,
        "work.receipt",
    )?;
    read_receipt_row(&next)?;
    Ok(next)
} // W04.3 vectors: transcribed from conformance/fixtures/receipts/receipt.json
  // (sha256 b18cf4101947da95942a212223d9517ab3629543b6c73642457cc07e6eb44751); 57 cases. The frozen file is the
  // oracle: this module is generated, never hand-edited.
#[cfg(test)]
mod vectors_receipt {
    use super::*;
    #[test]
    fn v_dead_letter_sorted() {
        assert_eq!(
            list_dead_letter(&[
                OutboxItem {
                    id: U16::from_utf8("b"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(Rc::new(vec![])),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("dead")
                },
                OutboxItem {
                    id: U16::from_utf8("a"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(Rc::new(vec![])),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("dead")
                },
                OutboxItem {
                    id: U16::from_utf8("c"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(Rc::new(vec![])),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("pending")
                },
                OutboxItem {
                    id: U16::from_utf8("d"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(Rc::new(vec![])),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("failed")
                }
            ]),
            vec![
                OutboxItem {
                    id: U16::from_utf8("a"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(Rc::new(vec![])),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("dead")
                },
                OutboxItem {
                    id: U16::from_utf8("b"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(Rc::new(vec![])),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("dead")
                }
            ]
        );
    }
    #[test]
    fn v_dead_letter_empty() {
        assert_eq!(
            list_dead_letter(&[OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(Rc::new(vec![])),
                origin_occurrence: None,
                attempts: 0.0,
                state: U16::from_utf8("pending")
            }]),
            vec![]
        );
    }
    #[test]
    fn v_consistent_succeeded() {
        assert!(is_consistent_completion(
            &Value::Str(U16::from_utf8("succeeded")),
            &Value::Obj(Rc::new(vec![(U16::from_utf8("v"), Value::Num(1.0))])),
            &Value::Null
        ));
    }
    #[test]
    fn v_consistent_succeeded_err() {
        assert!(!is_consistent_completion(
            &Value::Str(U16::from_utf8("succeeded")),
            &Value::Null,
            &Value::Obj(Rc::new(vec![
                (U16::from_utf8("code"), Value::Str(U16::from_utf8("E"))),
                (U16::from_utf8("message"), Value::Str(U16::from_utf8("m")))
            ]))
        ));
    }
    #[test]
    fn v_consistent_failed() {
        assert!(is_consistent_completion(
            &Value::Str(U16::from_utf8("failed")),
            &Value::Null,
            &Value::Obj(Rc::new(vec![
                (U16::from_utf8("code"), Value::Str(U16::from_utf8("E"))),
                (U16::from_utf8("message"), Value::Str(U16::from_utf8("m")))
            ]))
        ));
    }
    #[test]
    fn v_consistent_failed_result() {
        assert!(!is_consistent_completion(
            &Value::Str(U16::from_utf8("failed")),
            &Value::Num(1.0),
            &Value::Obj(Rc::new(vec![
                (U16::from_utf8("code"), Value::Str(U16::from_utf8("E"))),
                (U16::from_utf8("message"), Value::Str(U16::from_utf8("m")))
            ]))
        ));
    }
    #[test]
    fn v_consistent_failed_extras() {
        assert!(!is_consistent_completion(
            &Value::Str(U16::from_utf8("failed")),
            &Value::Null,
            &Value::Obj(Rc::new(vec![
                (U16::from_utf8("code"), Value::Str(U16::from_utf8("E"))),
                (U16::from_utf8("message"), Value::Str(U16::from_utf8("m"))),
                (U16::from_utf8("x"), Value::Num(1.0))
            ]))
        ));
    }
    #[test]
    fn v_consistent_unknown_nulls() {
        assert!(is_consistent_completion(
            &Value::Str(U16::from_utf8("unknown")),
            &Value::Null,
            &Value::Null
        ));
    }
    #[test]
    fn v_consistent_unknown_diag() {
        assert!(is_consistent_completion(
            &Value::Str(U16::from_utf8("unknown")),
            &Value::Null,
            &Value::Obj(Rc::new(vec![
                (U16::from_utf8("code"), Value::Str(U16::from_utf8("E"))),
                (U16::from_utf8("message"), Value::Str(U16::from_utf8("m")))
            ]))
        ));
    }
    #[test]
    fn v_consistent_unknown_result() {
        assert!(!is_consistent_completion(
            &Value::Str(U16::from_utf8("unknown")),
            &Value::Num(1.0),
            &Value::Null
        ));
    }
    #[test]
    fn v_consistent_skipped() {
        assert!(is_consistent_completion(
            &Value::Str(U16::from_utf8("skipped")),
            &Value::Null,
            &Value::Null
        ));
    }
    #[test]
    fn v_consistent_skipped_result() {
        assert!(!is_consistent_completion(
            &Value::Str(U16::from_utf8("skipped")),
            &Value::Num(1.0),
            &Value::Null
        ));
    }
    #[test]
    fn v_consistent_pending() {
        assert!(!is_consistent_completion(
            &Value::Str(U16::from_utf8("pending")),
            &Value::Null,
            &Value::Null
        ));
    }
    #[test]
    fn v_consistent_bogus() {
        assert!(!is_consistent_completion(
            &Value::Str(U16::from_utf8("nope")),
            &Value::Null,
            &Value::Null
        ));
    }
    #[test]
    fn v_consistent_undefined_payload() {
        assert!(is_consistent_completion(
            &Value::Str(U16::from_utf8("succeeded")),
            &Value::Undef,
            &Value::Undef
        ));
    }
    #[test]
    fn v_terminal_pending() {
        assert!(!is_terminal_receipt_status(&U16::from_utf8("pending")));
    }
    #[test]
    fn v_terminal_succeeded() {
        assert!(is_terminal_receipt_status(&U16::from_utf8("succeeded")));
    }
    #[test]
    fn v_terminal_failed() {
        assert!(is_terminal_receipt_status(&U16::from_utf8("failed")));
    }
    #[test]
    fn v_terminal_unknown() {
        assert!(!is_terminal_receipt_status(&U16::from_utf8("unknown")));
    }
    #[test]
    fn v_terminal_skipped() {
        assert!(is_terminal_receipt_status(&U16::from_utf8("skipped")));
    }
    #[test]
    fn v_terminal_bogus() {
        assert!(!is_terminal_receipt_status(&U16::from_utf8("bogus")));
    }
    #[test]
    fn v_observation_ok() {
        let recorded = RecordedReceiptFields {
            status: U16::from_utf8("succeeded"),
            result: Value::Obj(Rc::new(vec![(U16::from_utf8("r"), Value::Num(1.0))])),
            error: None,
        };
        assert_eq!(
            to_receipt_observation(&U16::from_utf8("d-1"), 3.0, &recorded),
            Ok(ReceiptObservation {
                id: U16::from_utf8("d-1"),
                revision: 3.0,
                status: U16::from_utf8("succeeded"),
                result: Value::Obj(Rc::new(vec![(U16::from_utf8("r"), Value::Num(1.0))])),
                error: None
            })
        );
    }
    #[test]
    fn v_observation_bad_id() {
        let recorded = RecordedReceiptFields {
            status: U16::from_utf8("succeeded"),
            result: Value::Null,
            error: None,
        };
        assert_eq!(
            to_receipt_observation(&U16::from_utf8(""), 3.0, &recorded),
            Err(ReceiptFailure {
                name: "RangeError".to_string(),
                message: "toReceiptObservation: deliveryId must be a non-empty string".to_string()
            })
        );
    }
    #[test]
    fn v_observation_bad_rev() {
        let recorded = RecordedReceiptFields {
            status: U16::from_utf8("succeeded"),
            result: Value::Null,
            error: None,
        };
        assert_eq!(
            to_receipt_observation(&U16::from_utf8("d-1"), 1.5, &recorded),
            Err(ReceiptFailure {
                name: "RangeError".to_string(),
                message: "toReceiptObservation: revision must be a non-negative integer"
                    .to_string()
            })
        );
    }
    #[test]
    fn v_observation_neg_rev() {
        let recorded = RecordedReceiptFields {
            status: U16::from_utf8("succeeded"),
            result: Value::Null,
            error: None,
        };
        assert_eq!(
            to_receipt_observation(&U16::from_utf8("d-1"), -1.0, &recorded),
            Err(ReceiptFailure {
                name: "RangeError".to_string(),
                message: "toReceiptObservation: revision must be a non-negative integer"
                    .to_string()
            })
        );
    }
    #[test]
    fn v_assoc_id() {
        assert_eq!(
            association_row_id(
                &U16::from_utf8("m"),
                &U16::from_utf8("r/1"),
                &U16::from_utf8("f f")
            ),
            Ok(U16::from_utf8("receipt-assoc/v1/m/r%2F1/f%20f"))
        );
    }
    #[test]
    fn v_assoc_id_empty() {
        assert_eq!(
            association_row_id(
                &U16::from_utf8("m"),
                &U16::from_utf8(""),
                &U16::from_utf8("f")
            ),
            Err(ReceiptFailure {
                name: "ReceiptTableError".to_string(),
                message: "associationRowId needs a non-empty model, recordId and field."
                    .to_string()
            })
        );
    }
    #[test]
    fn v_stored_pending_nulls() {
        assert!(is_stored_receipt_payload(
            &Value::Str(U16::from_utf8("pending")),
            &Value::Null,
            &Value::Null
        ));
    }
    #[test]
    fn v_stored_pending_result() {
        assert!(!is_stored_receipt_payload(
            &Value::Str(U16::from_utf8("pending")),
            &Value::Num(1.0),
            &Value::Null
        ));
    }
    #[test]
    fn v_stored_pending_err() {
        assert!(!is_stored_receipt_payload(
            &Value::Str(U16::from_utf8("pending")),
            &Value::Null,
            &Value::Obj(Rc::new(vec![
                (U16::from_utf8("code"), Value::Str(U16::from_utf8("E"))),
                (U16::from_utf8("message"), Value::Str(U16::from_utf8("m")))
            ]))
        ));
    }
    #[test]
    fn v_stored_succeeded() {
        assert!(is_stored_receipt_payload(
            &Value::Str(U16::from_utf8("succeeded")),
            &Value::Obj(Rc::new(vec![(U16::from_utf8("a"), Value::Num(1.0))])),
            &Value::Null
        ));
    }
    #[test]
    fn v_stored_failed() {
        assert!(is_stored_receipt_payload(
            &Value::Str(U16::from_utf8("failed")),
            &Value::Null,
            &Value::Obj(Rc::new(vec![
                (U16::from_utf8("code"), Value::Str(U16::from_utf8("E"))),
                (U16::from_utf8("message"), Value::Str(U16::from_utf8("m")))
            ]))
        ));
    }
    #[test]
    fn v_stored_unknown_diag() {
        assert!(is_stored_receipt_payload(
            &Value::Str(U16::from_utf8("unknown")),
            &Value::Null,
            &Value::Obj(Rc::new(vec![
                (U16::from_utf8("code"), Value::Str(U16::from_utf8("E"))),
                (U16::from_utf8("message"), Value::Str(U16::from_utf8("m")))
            ]))
        ));
    }
    #[test]
    fn v_stored_skipped() {
        assert!(is_stored_receipt_payload(
            &Value::Str(U16::from_utf8("skipped")),
            &Value::Null,
            &Value::Null
        ));
    }
    #[test]
    fn v_stored_bogus() {
        assert!(!is_stored_receipt_payload(
            &Value::Str(U16::from_utf8("nope")),
            &Value::Null,
            &Value::Null
        ));
    }
    #[test]
    fn v_new_assoc_row() {
        assert_eq!(
            new_association_row(
                &AssociationRowData {
                    record_model: U16::from_utf8("mod"),
                    record_id: U16::from_utf8("rec"),
                    field: U16::from_utf8("fld"),
                    delivery_id: U16::from_utf8("d-1"),
                    source: U16::from_utf8("src"),
                    revision: 2.0
                },
                &NewRowMeta {
                    now_ms: 2000.0,
                    actor: U16::from_utf8("w02.4-freeze")
                }
            ),
            Ok(StoredRow {
                id: U16::from_utf8("receipt-assoc/v1/mod/rec/fld"),
                version: 1.0,
                created: 2000.0,
                updated: 2000.0,
                created_by: U16::from_utf8("w02.4-freeze"),
                updated_by: U16::from_utf8("w02.4-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("recordModel"),
                        Value::Str(U16::from_utf8("mod"))
                    ),
                    (
                        U16::from_utf8("recordId"),
                        Value::Str(U16::from_utf8("rec"))
                    ),
                    (U16::from_utf8("field"), Value::Str(U16::from_utf8("fld"))),
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-1"))
                    ),
                    (U16::from_utf8("source"), Value::Str(U16::from_utf8("src"))),
                    (U16::from_utf8("revision"), Value::Num(2.0))
                ]))
            })
        );
    }
    #[test]
    fn v_new_assoc_malformed() {
        assert_eq!(
            new_association_row(
                &AssociationRowData {
                    record_model: U16::from_utf8("mod"),
                    record_id: U16::from_utf8("rec"),
                    field: U16::from_utf8(""),
                    delivery_id: U16::from_utf8("d-1"),
                    source: U16::from_utf8("src"),
                    revision: 2.0
                },
                &NewRowMeta {
                    now_ms: 2000.0,
                    actor: U16::from_utf8("w02.4-freeze")
                }
            ),
            Err(ReceiptFailure {
                name: "ReceiptTableError".to_string(),
                message: "associationRowId needs a non-empty model, recordId and field."
                    .to_string()
            })
        );
    }
    #[test]
    fn v_read_assoc_row() {
        assert_eq!(
            read_association_row(&StoredRow {
                id: U16::from_utf8("receipt-assoc/v1/mod/rec/fld"),
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
                        Value::Str(U16::from_utf8("mod"))
                    ),
                    (
                        U16::from_utf8("recordId"),
                        Value::Str(U16::from_utf8("rec"))
                    ),
                    (U16::from_utf8("field"), Value::Str(U16::from_utf8("fld"))),
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-1"))
                    ),
                    (U16::from_utf8("source"), Value::Str(U16::from_utf8("src"))),
                    (U16::from_utf8("revision"), Value::Num(2.0))
                ]))
            }),
            Ok(ReceiptAssociation {
                locator: ReceiptLocator {
                    record_id: U16::from_utf8("rec"),
                    field: U16::from_utf8("fld")
                },
                delivery_id: U16::from_utf8("d-1"),
                source: U16::from_utf8("src"),
                revision: 2.0
            })
        );
    }
    #[test]
    fn v_read_assoc_id_mismatch() {
        assert_eq!(
            read_association_row(&StoredRow {
                id: U16::from_utf8("wrong"),
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
                        Value::Str(U16::from_utf8("mod"))
                    ),
                    (
                        U16::from_utf8("recordId"),
                        Value::Str(U16::from_utf8("rec"))
                    ),
                    (U16::from_utf8("field"), Value::Str(U16::from_utf8("fld"))),
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-1"))
                    ),
                    (U16::from_utf8("source"), Value::Str(U16::from_utf8("src"))),
                    (U16::from_utf8("revision"), Value::Num(2.0))
                ]))
            }),
            Err(ReceiptFailure {
                name: "ReceiptTableError".to_string(),
                message:
                    "work.receipt_association row id must equal its model/record/field derivation."
                        .to_string()
            })
        );
    }
    #[test]
    fn v_read_assoc_bad_rev() {
        assert_eq!(
            read_association_row(&StoredRow {
                id: U16::from_utf8("receipt-assoc/v1/mod/rec/fld"),
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
                        Value::Str(U16::from_utf8("mod"))
                    ),
                    (
                        U16::from_utf8("recordId"),
                        Value::Str(U16::from_utf8("rec"))
                    ),
                    (U16::from_utf8("field"), Value::Str(U16::from_utf8("fld"))),
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-1"))
                    ),
                    (U16::from_utf8("source"), Value::Str(U16::from_utf8("src"))),
                    (U16::from_utf8("revision"), Value::Num(2.5))
                ]))
            }),
            Err(ReceiptFailure {
                name: "ReceiptTableError".to_string(),
                message: "work.receipt_association.revision must be an integer >= 0.".to_string()
            })
        );
    }
    #[test]
    fn v_new_receipt_pending() {
        assert_eq!(
            new_receipt_row(
                &ReceiptRowData {
                    delivery_id: U16::from_utf8("d-1"),
                    revision: 0.0,
                    status: U16::from_utf8("pending"),
                    result: Value::Null,
                    error: None,
                    content_ref: None,
                    result_expires_at_ms: None
                },
                &NewRowMeta {
                    now_ms: 2000.0,
                    actor: U16::from_utf8("w02.4-freeze")
                }
            ),
            Ok(StoredRow {
                id: U16::from_utf8("d-1"),
                version: 1.0,
                created: 2000.0,
                updated: 2000.0,
                created_by: U16::from_utf8("w02.4-freeze"),
                updated_by: U16::from_utf8("w02.4-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-1"))
                    ),
                    (U16::from_utf8("revision"), Value::Num(0.0)),
                    (
                        U16::from_utf8("status"),
                        Value::Str(U16::from_utf8("pending"))
                    ),
                    (U16::from_utf8("result"), Value::Null),
                    (U16::from_utf8("error"), Value::Null),
                    (U16::from_utf8("contentRef"), Value::Null),
                    (U16::from_utf8("resultExpiresAtMs"), Value::Null)
                ]))
            })
        );
    }
    #[test]
    fn v_new_receipt_ok() {
        assert_eq!(
            new_receipt_row(
                &ReceiptRowData {
                    delivery_id: U16::from_utf8("d-2"),
                    revision: 4.0,
                    status: U16::from_utf8("succeeded"),
                    result: Value::Obj(Rc::new(vec![(
                        U16::from_utf8("v"),
                        Value::Arr(Rc::new(vec![Value::Num(1.0)]))
                    )])),
                    error: None,
                    content_ref: Some(U16::from_utf8("c9")),
                    result_expires_at_ms: Some(999.0)
                },
                &NewRowMeta {
                    now_ms: 2000.0,
                    actor: U16::from_utf8("w02.4-freeze")
                }
            ),
            Ok(StoredRow {
                id: U16::from_utf8("d-2"),
                version: 1.0,
                created: 2000.0,
                updated: 2000.0,
                created_by: U16::from_utf8("w02.4-freeze"),
                updated_by: U16::from_utf8("w02.4-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-2"))
                    ),
                    (U16::from_utf8("revision"), Value::Num(4.0)),
                    (
                        U16::from_utf8("status"),
                        Value::Str(U16::from_utf8("succeeded"))
                    ),
                    (
                        U16::from_utf8("result"),
                        Value::Obj(Rc::new(vec![(
                            U16::from_utf8("v"),
                            Value::Arr(Rc::new(vec![Value::Num(1.0)]))
                        )]))
                    ),
                    (U16::from_utf8("error"), Value::Null),
                    (
                        U16::from_utf8("contentRef"),
                        Value::Str(U16::from_utf8("c9"))
                    ),
                    (U16::from_utf8("resultExpiresAtMs"), Value::Num(999.0))
                ]))
            })
        );
    }
    #[test]
    fn v_new_receipt_inconsistent() {
        assert_eq!(
            new_receipt_row(
                &ReceiptRowData {
                    delivery_id: U16::from_utf8("d-2"),
                    revision: 4.0,
                    status: U16::from_utf8("failed"),
                    result: Value::Obj(Rc::new(vec![(
                        U16::from_utf8("v"),
                        Value::Arr(Rc::new(vec![Value::Num(1.0)]))
                    )])),
                    error: None,
                    content_ref: Some(U16::from_utf8("c9")),
                    result_expires_at_ms: Some(999.0)
                },
                &NewRowMeta {
                    now_ms: 2000.0,
                    actor: U16::from_utf8("w02.4-freeze")
                }
            ),
            Err(ReceiptFailure {
                name: "ReceiptTableError".to_string(),
                message: "work.receipt payload is inconsistent for status \"failed\".".to_string()
            })
        );
    }
    #[test]
    fn v_new_receipt_fn_result() {
        assert_eq!(
            new_receipt_row(
                &ReceiptRowData {
                    delivery_id: U16::from_utf8("d-2"),
                    revision: 4.0,
                    status: U16::from_utf8("succeeded"),
                    result: Value::Func,
                    error: None,
                    content_ref: Some(U16::from_utf8("c9")),
                    result_expires_at_ms: Some(999.0)
                },
                &NewRowMeta {
                    now_ms: 2000.0,
                    actor: U16::from_utf8("w02.4-freeze")
                }
            ),
            Err(ReceiptFailure {
                name: "ReceiptTableError".to_string(),
                message: "work.receipt data.result is not JSON-safe.".to_string()
            })
        );
    }
    #[test]
    fn v_new_receipt_failed() {
        assert_eq!(
            new_receipt_row(
                &ReceiptRowData {
                    delivery_id: U16::from_utf8("d-3"),
                    revision: 1.0,
                    status: U16::from_utf8("failed"),
                    result: Value::Null,
                    error: Some(ReceiptError {
                        code: U16::from_utf8("E9"),
                        message: U16::from_utf8("boom")
                    }),
                    content_ref: None,
                    result_expires_at_ms: None
                },
                &NewRowMeta {
                    now_ms: 2000.0,
                    actor: U16::from_utf8("w02.4-freeze")
                }
            ),
            Ok(StoredRow {
                id: U16::from_utf8("d-3"),
                version: 1.0,
                created: 2000.0,
                updated: 2000.0,
                created_by: U16::from_utf8("w02.4-freeze"),
                updated_by: U16::from_utf8("w02.4-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-3"))
                    ),
                    (U16::from_utf8("revision"), Value::Num(1.0)),
                    (
                        U16::from_utf8("status"),
                        Value::Str(U16::from_utf8("failed"))
                    ),
                    (U16::from_utf8("result"), Value::Null),
                    (
                        U16::from_utf8("error"),
                        Value::Obj(Rc::new(vec![
                            (U16::from_utf8("code"), Value::Str(U16::from_utf8("E9"))),
                            (
                                U16::from_utf8("message"),
                                Value::Str(U16::from_utf8("boom"))
                            )
                        ]))
                    ),
                    (U16::from_utf8("contentRef"), Value::Null),
                    (U16::from_utf8("resultExpiresAtMs"), Value::Null)
                ]))
            })
        );
    }
    #[test]
    fn v_read_receipt_failed() {
        assert_eq!(
            read_receipt_row(&StoredRow {
                id: U16::from_utf8("d-3"),
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
                        Value::Str(U16::from_utf8("d-3"))
                    ),
                    (U16::from_utf8("revision"), Value::Num(1.0)),
                    (
                        U16::from_utf8("status"),
                        Value::Str(U16::from_utf8("failed"))
                    ),
                    (U16::from_utf8("result"), Value::Null),
                    (
                        U16::from_utf8("error"),
                        Value::Obj(Rc::new(vec![
                            (U16::from_utf8("code"), Value::Str(U16::from_utf8("E9"))),
                            (
                                U16::from_utf8("message"),
                                Value::Str(U16::from_utf8("boom"))
                            )
                        ]))
                    ),
                    (U16::from_utf8("contentRef"), Value::Null),
                    (U16::from_utf8("resultExpiresAtMs"), Value::Null)
                ]))
            }),
            Ok(StoredReceiptRow {
                receipt: AssociatedReceipt {
                    delivery_id: U16::from_utf8("d-3"),
                    revision: 1.0,
                    status: U16::from_utf8("failed"),
                    result: Value::Null,
                    error: Some(ReceiptError {
                        code: U16::from_utf8("E9"),
                        message: U16::from_utf8("boom")
                    })
                },
                content_ref: None,
                result_expires_at_ms: None
            })
        );
    }
    #[test]
    fn v_read_receipt_row() {
        assert_eq!(
            read_receipt_row(&StoredRow {
                id: U16::from_utf8("d-2"),
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
                        Value::Str(U16::from_utf8("d-2"))
                    ),
                    (U16::from_utf8("revision"), Value::Num(4.0)),
                    (
                        U16::from_utf8("status"),
                        Value::Str(U16::from_utf8("succeeded"))
                    ),
                    (
                        U16::from_utf8("result"),
                        Value::Obj(Rc::new(vec![(
                            U16::from_utf8("v"),
                            Value::Arr(Rc::new(vec![Value::Num(1.0)]))
                        )]))
                    ),
                    (U16::from_utf8("error"), Value::Null),
                    (
                        U16::from_utf8("contentRef"),
                        Value::Str(U16::from_utf8("c9"))
                    ),
                    (U16::from_utf8("resultExpiresAtMs"), Value::Num(999.0))
                ]))
            }),
            Ok(StoredReceiptRow {
                receipt: AssociatedReceipt {
                    delivery_id: U16::from_utf8("d-2"),
                    revision: 4.0,
                    status: U16::from_utf8("succeeded"),
                    result: Value::Obj(Rc::new(vec![(
                        U16::from_utf8("v"),
                        Value::Arr(Rc::new(vec![Value::Num(1.0)]))
                    )])),
                    error: None
                },
                content_ref: Some(U16::from_utf8("c9")),
                result_expires_at_ms: Some(999.0)
            })
        );
    }
    #[test]
    fn v_read_receipt_undefined_payload() {
        assert_eq!(
            read_receipt_row(&StoredRow {
                id: U16::from_utf8("d-2"),
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
                        Value::Str(U16::from_utf8("d-2"))
                    ),
                    (U16::from_utf8("revision"), Value::Num(4.0)),
                    (
                        U16::from_utf8("status"),
                        Value::Str(U16::from_utf8("succeeded"))
                    ),
                    (U16::from_utf8("contentRef"), Value::Null),
                    (U16::from_utf8("resultExpiresAtMs"), Value::Null)
                ]))
            }),
            Ok(StoredReceiptRow {
                receipt: AssociatedReceipt {
                    delivery_id: U16::from_utf8("d-2"),
                    revision: 4.0,
                    status: U16::from_utf8("succeeded"),
                    result: Value::Null,
                    error: None
                },
                content_ref: None,
                result_expires_at_ms: None
            })
        );
    }
    #[test]
    fn v_read_receipt_bad_status() {
        assert_eq!(
            read_receipt_row(&StoredRow {
                id: U16::from_utf8("d-2"),
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
                        Value::Str(U16::from_utf8("d-2"))
                    ),
                    (U16::from_utf8("revision"), Value::Num(4.0)),
                    (U16::from_utf8("status"), Value::Str(U16::from_utf8("held"))),
                    (
                        U16::from_utf8("result"),
                        Value::Obj(Rc::new(vec![(
                            U16::from_utf8("v"),
                            Value::Arr(Rc::new(vec![Value::Num(1.0)]))
                        )]))
                    ),
                    (U16::from_utf8("error"), Value::Null),
                    (
                        U16::from_utf8("contentRef"),
                        Value::Str(U16::from_utf8("c9"))
                    ),
                    (U16::from_utf8("resultExpiresAtMs"), Value::Num(999.0))
                ]))
            }),
            Err(ReceiptFailure {
                name: "ReceiptTableError".to_string(),
                message: "work.receipt.status is unknown: \"held\".".to_string()
            })
        );
    }
    #[test]
    fn v_read_receipt_bad_contentref() {
        assert_eq!(
            read_receipt_row(&StoredRow {
                id: U16::from_utf8("d-2"),
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
                        Value::Str(U16::from_utf8("d-2"))
                    ),
                    (U16::from_utf8("revision"), Value::Num(4.0)),
                    (
                        U16::from_utf8("status"),
                        Value::Str(U16::from_utf8("succeeded"))
                    ),
                    (
                        U16::from_utf8("result"),
                        Value::Obj(Rc::new(vec![(
                            U16::from_utf8("v"),
                            Value::Arr(Rc::new(vec![Value::Num(1.0)]))
                        )]))
                    ),
                    (U16::from_utf8("error"), Value::Null),
                    (U16::from_utf8("contentRef"), Value::Str(U16::from_utf8(""))),
                    (U16::from_utf8("resultExpiresAtMs"), Value::Num(999.0))
                ]))
            }),
            Err(ReceiptFailure {
                name: "ReceiptTableError".to_string(),
                message: "work.receipt.contentRef must be a non-empty string or null.".to_string()
            })
        );
    }
    #[test]
    fn v_read_receipt_bad_expiry() {
        assert_eq!(
            read_receipt_row(&StoredRow {
                id: U16::from_utf8("d-2"),
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
                        Value::Str(U16::from_utf8("d-2"))
                    ),
                    (U16::from_utf8("revision"), Value::Num(4.0)),
                    (
                        U16::from_utf8("status"),
                        Value::Str(U16::from_utf8("succeeded"))
                    ),
                    (
                        U16::from_utf8("result"),
                        Value::Obj(Rc::new(vec![(
                            U16::from_utf8("v"),
                            Value::Arr(Rc::new(vec![Value::Num(1.0)]))
                        )]))
                    ),
                    (U16::from_utf8("error"), Value::Null),
                    (
                        U16::from_utf8("contentRef"),
                        Value::Str(U16::from_utf8("c9"))
                    ),
                    (U16::from_utf8("resultExpiresAtMs"), Value::Num(f64::NAN))
                ]))
            }),
            Err(ReceiptFailure {
                name: "ReceiptTableError".to_string(),
                message: "work.receipt.resultExpiresAtMs must be finite epoch ms or null."
                    .to_string()
            })
        );
    }
    #[test]
    fn v_read_receipt_id_mismatch() {
        assert_eq!(
            read_receipt_row(&StoredRow {
                id: U16::from_utf8("other"),
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
                        Value::Str(U16::from_utf8("d-2"))
                    ),
                    (U16::from_utf8("revision"), Value::Num(4.0)),
                    (
                        U16::from_utf8("status"),
                        Value::Str(U16::from_utf8("succeeded"))
                    ),
                    (
                        U16::from_utf8("result"),
                        Value::Obj(Rc::new(vec![(
                            U16::from_utf8("v"),
                            Value::Arr(Rc::new(vec![Value::Num(1.0)]))
                        )]))
                    ),
                    (U16::from_utf8("error"), Value::Null),
                    (
                        U16::from_utf8("contentRef"),
                        Value::Str(U16::from_utf8("c9"))
                    ),
                    (U16::from_utf8("resultExpiresAtMs"), Value::Num(999.0))
                ]))
            }),
            Err(ReceiptFailure {
                name: "ReceiptTableError".to_string(),
                message: "work.receipt row id must equal its deliveryId.".to_string()
            })
        );
    }
    #[test]
    fn v_with_assoc_ok() {
        assert_eq!(
            with_association_row_data(
                &StoredRow {
                    id: U16::from_utf8("receipt-assoc/v1/mod/rec/fld"),
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
                            Value::Str(U16::from_utf8("mod"))
                        ),
                        (
                            U16::from_utf8("recordId"),
                            Value::Str(U16::from_utf8("rec"))
                        ),
                        (U16::from_utf8("field"), Value::Str(U16::from_utf8("fld"))),
                        (
                            U16::from_utf8("deliveryId"),
                            Value::Str(U16::from_utf8("d-1"))
                        ),
                        (U16::from_utf8("source"), Value::Str(U16::from_utf8("src"))),
                        (U16::from_utf8("revision"), Value::Num(2.0))
                    ]))
                },
                &AssociationRowData {
                    record_model: U16::from_utf8("mod"),
                    record_id: U16::from_utf8("rec"),
                    field: U16::from_utf8("fld"),
                    delivery_id: U16::from_utf8("d-1"),
                    source: U16::from_utf8("src"),
                    revision: 3.0
                },
                &NewRowMeta {
                    now_ms: 2000.0,
                    actor: U16::from_utf8("w02.4-freeze")
                }
            ),
            Ok(StoredRow {
                id: U16::from_utf8("receipt-assoc/v1/mod/rec/fld"),
                version: 2.0,
                created: 1000.0,
                updated: 2000.0,
                created_by: U16::from_utf8("fz"),
                updated_by: U16::from_utf8("w02.4-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("recordModel"),
                        Value::Str(U16::from_utf8("mod"))
                    ),
                    (
                        U16::from_utf8("recordId"),
                        Value::Str(U16::from_utf8("rec"))
                    ),
                    (U16::from_utf8("field"), Value::Str(U16::from_utf8("fld"))),
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-1"))
                    ),
                    (U16::from_utf8("source"), Value::Str(U16::from_utf8("src"))),
                    (U16::from_utf8("revision"), Value::Num(3.0))
                ]))
            })
        );
    }
    #[test]
    fn v_with_assoc_stale() {
        assert_eq!(
            with_association_row_data(
                &StoredRow {
                    id: U16::from_utf8("receipt-assoc/v1/mod/rec/fld"),
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
                            Value::Str(U16::from_utf8("mod"))
                        ),
                        (
                            U16::from_utf8("recordId"),
                            Value::Str(U16::from_utf8("rec"))
                        ),
                        (U16::from_utf8("field"), Value::Str(U16::from_utf8("fld"))),
                        (
                            U16::from_utf8("deliveryId"),
                            Value::Str(U16::from_utf8("d-1"))
                        ),
                        (U16::from_utf8("source"), Value::Str(U16::from_utf8("src"))),
                        (U16::from_utf8("revision"), Value::Num(2.0))
                    ]))
                },
                &AssociationRowData {
                    record_model: U16::from_utf8("mod"),
                    record_id: U16::from_utf8("rec"),
                    field: U16::from_utf8("fld"),
                    delivery_id: U16::from_utf8("d-1"),
                    source: U16::from_utf8("src"),
                    revision: 1.0
                },
                &NewRowMeta {
                    now_ms: 2000.0,
                    actor: U16::from_utf8("w02.4-freeze")
                }
            ),
            Err(ReceiptFailure {
                name: "ReceiptTableError".to_string(),
                message: "work.receipt_association: stale revision 1 under current 2.".to_string()
            })
        );
    }
    #[test]
    fn v_with_assoc_same_rev() {
        assert_eq!(
            with_association_row_data(
                &StoredRow {
                    id: U16::from_utf8("receipt-assoc/v1/mod/rec/fld"),
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
                            Value::Str(U16::from_utf8("mod"))
                        ),
                        (
                            U16::from_utf8("recordId"),
                            Value::Str(U16::from_utf8("rec"))
                        ),
                        (U16::from_utf8("field"), Value::Str(U16::from_utf8("fld"))),
                        (
                            U16::from_utf8("deliveryId"),
                            Value::Str(U16::from_utf8("d-1"))
                        ),
                        (U16::from_utf8("source"), Value::Str(U16::from_utf8("src"))),
                        (U16::from_utf8("revision"), Value::Num(2.0))
                    ]))
                },
                &AssociationRowData {
                    record_model: U16::from_utf8("mod"),
                    record_id: U16::from_utf8("rec"),
                    field: U16::from_utf8("fld"),
                    delivery_id: U16::from_utf8("d-1"),
                    source: U16::from_utf8("src"),
                    revision: 2.0
                },
                &NewRowMeta {
                    now_ms: 2000.0,
                    actor: U16::from_utf8("w02.4-freeze")
                }
            ),
            Ok(StoredRow {
                id: U16::from_utf8("receipt-assoc/v1/mod/rec/fld"),
                version: 2.0,
                created: 1000.0,
                updated: 2000.0,
                created_by: U16::from_utf8("fz"),
                updated_by: U16::from_utf8("w02.4-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("recordModel"),
                        Value::Str(U16::from_utf8("mod"))
                    ),
                    (
                        U16::from_utf8("recordId"),
                        Value::Str(U16::from_utf8("rec"))
                    ),
                    (U16::from_utf8("field"), Value::Str(U16::from_utf8("fld"))),
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-1"))
                    ),
                    (U16::from_utf8("source"), Value::Str(U16::from_utf8("src"))),
                    (U16::from_utf8("revision"), Value::Num(2.0))
                ]))
            })
        );
    }
    #[test]
    fn v_with_receipt_ok() {
        assert_eq!(
            with_receipt_row_data(
                &StoredRow {
                    id: U16::from_utf8("d-2"),
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
                            Value::Str(U16::from_utf8("d-2"))
                        ),
                        (U16::from_utf8("revision"), Value::Num(4.0)),
                        (
                            U16::from_utf8("status"),
                            Value::Str(U16::from_utf8("succeeded"))
                        ),
                        (
                            U16::from_utf8("result"),
                            Value::Obj(Rc::new(vec![(
                                U16::from_utf8("v"),
                                Value::Arr(Rc::new(vec![Value::Num(1.0)]))
                            )]))
                        ),
                        (U16::from_utf8("error"), Value::Null),
                        (
                            U16::from_utf8("contentRef"),
                            Value::Str(U16::from_utf8("c9"))
                        ),
                        (U16::from_utf8("resultExpiresAtMs"), Value::Num(999.0))
                    ]))
                },
                &ReceiptRowData {
                    delivery_id: U16::from_utf8("d-2"),
                    revision: 5.0,
                    status: U16::from_utf8("succeeded"),
                    result: Value::Obj(Rc::new(vec![(
                        U16::from_utf8("v"),
                        Value::Arr(Rc::new(vec![Value::Num(1.0)]))
                    )])),
                    error: None,
                    content_ref: Some(U16::from_utf8("c9")),
                    result_expires_at_ms: Some(999.0)
                },
                &NewRowMeta {
                    now_ms: 2000.0,
                    actor: U16::from_utf8("w02.4-freeze")
                }
            ),
            Ok(StoredRow {
                id: U16::from_utf8("d-2"),
                version: 2.0,
                created: 1000.0,
                updated: 2000.0,
                created_by: U16::from_utf8("fz"),
                updated_by: U16::from_utf8("w02.4-freeze"),
                archived_at: Value::Null,
                parent: Value::Null,
                data: Value::Obj(Rc::new(vec![
                    (
                        U16::from_utf8("deliveryId"),
                        Value::Str(U16::from_utf8("d-2"))
                    ),
                    (U16::from_utf8("revision"), Value::Num(5.0)),
                    (
                        U16::from_utf8("status"),
                        Value::Str(U16::from_utf8("succeeded"))
                    ),
                    (
                        U16::from_utf8("result"),
                        Value::Obj(Rc::new(vec![(
                            U16::from_utf8("v"),
                            Value::Arr(Rc::new(vec![Value::Num(1.0)]))
                        )]))
                    ),
                    (U16::from_utf8("error"), Value::Null),
                    (
                        U16::from_utf8("contentRef"),
                        Value::Str(U16::from_utf8("c9"))
                    ),
                    (U16::from_utf8("resultExpiresAtMs"), Value::Num(999.0))
                ]))
            })
        );
    }
    #[test]
    fn v_with_receipt_stale() {
        assert_eq!(
            with_receipt_row_data(
                &StoredRow {
                    id: U16::from_utf8("d-2"),
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
                            Value::Str(U16::from_utf8("d-2"))
                        ),
                        (U16::from_utf8("revision"), Value::Num(4.0)),
                        (
                            U16::from_utf8("status"),
                            Value::Str(U16::from_utf8("succeeded"))
                        ),
                        (
                            U16::from_utf8("result"),
                            Value::Obj(Rc::new(vec![(
                                U16::from_utf8("v"),
                                Value::Arr(Rc::new(vec![Value::Num(1.0)]))
                            )]))
                        ),
                        (U16::from_utf8("error"), Value::Null),
                        (
                            U16::from_utf8("contentRef"),
                            Value::Str(U16::from_utf8("c9"))
                        ),
                        (U16::from_utf8("resultExpiresAtMs"), Value::Num(999.0))
                    ]))
                },
                &ReceiptRowData {
                    delivery_id: U16::from_utf8("d-2"),
                    revision: 3.0,
                    status: U16::from_utf8("succeeded"),
                    result: Value::Obj(Rc::new(vec![(
                        U16::from_utf8("v"),
                        Value::Arr(Rc::new(vec![Value::Num(1.0)]))
                    )])),
                    error: None,
                    content_ref: Some(U16::from_utf8("c9")),
                    result_expires_at_ms: Some(999.0)
                },
                &NewRowMeta {
                    now_ms: 2000.0,
                    actor: U16::from_utf8("w02.4-freeze")
                }
            ),
            Err(ReceiptFailure {
                name: "ReceiptTableError".to_string(),
                message: "work.receipt: stale revision 3 under current 4.".to_string()
            })
        );
    }
    #[test]
    fn v_receipt_models() {
        assert_eq!(RECEIPT_ASSOCIATION_MODEL, "work.receipt_association");
        assert_eq!(RECEIPT_MODEL, "work.receipt");
    }
}

// N03 immutable witnesses: private Cargo route, not standalone rustc.

#[cfg(test)]
mod quote_contract {
    use super::*;

    #[test]
    fn raw_utf16_payload_and_identity_bytes() {
        let raw = U16(vec![0xD800, 0xD83D, 0xDE00, 0xDC00, 0x22, 0x0A]);
        let text = Value::Str(raw.clone());
        let payload = Value::Obj(Rc::new(vec![(raw.clone(), text.clone())]));
        assert_eq!(js_stringify(&payload), "{\"\\ud800😀\\udc00\\\"\\n\":\"\\ud800😀\\udc00\\\"\\n\"}");
        let row = StoredRow {
            id: U16::from_utf8("d"), version: 1.0, created: 0.0, updated: 0.0,
            created_by: U16::from_utf8("a"), updated_by: U16::from_utf8("a"),
            archived_at: Value::Null, parent: Value::Null,
            data: Value::Obj(Rc::new(vec![
                (U16::from_utf8("deliveryId"), Value::Str(U16::from_utf8("d"))),
                (U16::from_utf8("revision"), Value::Num(1.0)),
                (U16::from_utf8("status"), text),
            ])),
        };
        let error = read_receipt_row(&row).unwrap_err();
        assert_eq!(error.message, "work.receipt.status is unknown: \"\\ud800😀\\udc00\\\"\\n\".");
        assert_eq!(encode_uri_component(&raw.0).unwrap_err().name, "URIError");
        let valid = U16(vec![0xD83D, 0xDE00]);
        let id = association_row_id(&valid, &U16::from_utf8("r"), &U16::from_utf8("f/x")).unwrap();
        assert_eq!(id, U16::from_utf8("receipt-assoc/v1/%F0%9F%98%80/r/f%2Fx"));
        assert_eq!(association_row_id(&raw, &valid, &valid).unwrap_err().name, "URIError");
    }
}
