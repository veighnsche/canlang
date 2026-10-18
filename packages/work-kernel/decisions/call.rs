//! Selected-call dispatch shared by the native differential observer and the
//! synchronous Wasm call ABI. This is the registered decision dispatch:
//! the same `observe` entry proves TS parity in
//! `conformance/registered-differential.mjs` and executes inside
//! `rust/work_call_abi.rs`. One dispatch, two transports; no second
//! implementation of any family. Host callbacks (RNG sample, recurrence
//! derive-id) arrive as supplied values, never as invoked host code.

use crate::decisions::{every, lifecycle, linkage, receipt, recovery, retry, rows};
use serde_json::{json, Value as J};
use std::cell::Cell;
use std::rc::Rc;

pub fn text(v: &J) -> Vec<u16> {
    v.as_array()
        .or_else(|| v["$u16"].as_array())
        .expect("UTF16 channel")
        .iter()
        .map(|x| u16::try_from(x.as_u64().unwrap()).unwrap())
        .collect()
}
pub fn ascii(v: &J) -> String {
    String::from_utf16(&text(v)).unwrap()
}
/// Lenient text read for donor `===`-compared state tags: strings decode,
/// anything else reads as empty (never a throw). The donor never throws on
/// exotic states either — strict equality simply misses — so every
/// state-guard branch decides identically on both sides.
pub fn text_lenient(v: &J) -> Vec<u16> {
    match v.get("$u16").and_then(|u| u.as_array()) {
        Some(units) => units
            .iter()
            .map(|x| u16::try_from(x.as_u64().unwrap()).unwrap())
            .collect(),
        None => Vec::new(),
    }
}
pub fn field<'a>(v: &'a J, key: &str) -> &'a J {
    v["$entries"]
        .as_array()
        .expect("ordered entries channel")
        .iter()
        .find(|entry| text(&entry[0]) == key.encode_utf16().collect::<Vec<_>>())
        .map(|entry| &entry[1])
        .unwrap_or(&J::Null)
}
pub fn is_absent(v: &J) -> bool {
    v.is_null() || v.get("$undefined").is_some()
}
/// Selected-call registry: every (leaf, fn) pair the synchronous Wasm ABI
/// routes. Unknown pairs refuse with BAD_REQUEST before `observe` runs, so
/// a host-contract bug fails visibly per call instead of trapping the
/// instance. Keep in sync with the `observe` match arms below; the
/// full-family Wasm differential guards both directions (an exposed arm
/// missing here fails closed, a listed pair missing its arm traps loudly).
pub fn is_selected_call(leaf: &str, fun: &str) -> bool {
    matches!(
        (leaf, fun),
        ("rows", "readDispatchRow")
            | ("rows", "readOccurrenceRow")
            | ("rows", "readScheduleRow")
            | ("rows", "scheduleRowScope")
            | ("rows", "readEverySlotRow")
            | ("rows", "readSupersessionRow")
            | ("rows", "newDispatchRow")
            | ("rows", "newOccurrenceRow")
            | ("rows", "newScheduleRow")
            | ("rows", "newEverySlotRow")
            | ("rows", "newSupersessionRow")
            | ("rows", "dispatchByOriginQuery")
            | ("rows", "dispatchByStateQuery")
            | ("rows", "scheduleByKeyQuery")
            | ("rows", "checkFanoutIdentitySet")
            | ("rows", "fanoutIntentRowId")
            | ("rows", "fanoutCheckpointRowId")
            | ("rows", "fanoutChildRowId")
            | ("rows", "newFanoutIntentRow")
            | ("rows", "newFanoutCheckpointRow")
            | ("rows", "nextFanoutCheckpointData")
            | ("rows", "newFanoutChildRow")
            | ("rows", "readFanoutIntentRow")
            | ("rows", "readFanoutCheckpointRow")
            | ("rows", "readFanoutChildRow")
            | ("rows", "fanoutChildIdOf")
            | ("rows", "fanoutChildPageQuery")
            | ("rows", "fanoutChildPageResult")
            | ("rows", "withRowData")
            | ("rows", "withFanoutRowData")
            | ("rows", "everySlotRowId")
            | ("retry", "classifyFailure")
            | ("retry", "assertPolicy")
            | ("retry", "computeBackoff")
            | ("every", "everyScopeKey")
            | ("every", "computeEverySlot")
            | ("every", "admitEveryTick")
            | ("lifecycle", "recordOutcome")
            | ("lifecycle", "reconcileUncertain")
            | ("receipt", "listDeadLetter")
            | ("receipt", "isConsistentCompletion")
            | ("receipt", "isStoredReceiptPayload")
            | ("receipt", "isTerminalReceiptStatus")
            | ("receipt", "toReceiptObservation")
            | ("receipt", "associationRowId")
            | ("receipt", "readAssociationRow")
            | ("receipt", "readReceiptRow")
            | ("receipt", "newAssociationRow")
            | ("receipt", "newReceiptRow")
            | ("receipt", "withAssociationRowData")
            | ("receipt", "withReceiptRowData")
            | ("recovery", "isClaimStale")
            | ("recovery", "findStaleClaims")
            | ("recovery", "releaseStaleClaims")
            | ("recovery", "buildInventory")
            | ("recovery", "buildWorkInventory")
            | ("recovery", "recordStagingFailure")
            | ("recovery", "isFanoutClaimStale")
            | ("recovery", "isFanoutChildExhausted")
            | ("recovery", "planFanoutRecoveryScan")
            | ("recovery", "assertKnownProgressRelation")
            | ("recovery", "planRelatedProgressResume")
            | ("linkage", "assertDispatchJoin")
            | ("linkage", "assertFanoutChildJoin")
            | ("linkage", "assertReceiptJoin")
    )
}
pub fn number(v: &J) -> f64 {
    f64::from_bits(u64::from_str_radix(v["$bits"].as_str().expect("f64 bit channel"), 16).unwrap())
}
pub fn string(v: &[u16]) -> J {
    json!({"$u16":v})
}
pub fn n(v: f64) -> J {
    json!({"$bits":format!("{:016x}",v.to_bits())})
}
pub fn object(v: Vec<(&str, J)>) -> J {
    json!({"$entries":v.into_iter().map(|(key,value)|json!([key.encode_utf16().collect::<Vec<_>>(),value])).collect::<Vec<_>>()})
}
pub fn ok(v: J) -> J {
    json!({"ok":v})
}
pub fn fault(name: &str, message: &str, code: Option<&str>, scope: Option<&[u16]>) -> J {
    json!({"throw": {"name":string(&name.encode_utf16().collect::<Vec<_>>()),
            "message":string(&(if name=="URIError" {"engine-variable"} else {message}).encode_utf16().collect::<Vec<_>>()),
            "codePresent":code.is_some(),"code":code.map(|x|string(&x.encode_utf16().collect::<Vec<_>>())).unwrap_or(json!({"$undefined":true})),
            "scopePresent":scope.is_some(),"scope":scope.map(string).unwrap_or(json!({"$undefined":true}))}})
}
// Finite data-only observer graph. Its wire parser rejects unsupported
// channels instead of silently materializing exotic original objects.
pub fn rows_value(v: &J) -> rows::Value {
    rows_decode(v, &mut Vec::new())
}

/// Identity-graph decoder: `$id` marks a repeated container, `$ref` points
/// back at one. Backward references resolve to the shared allocation so the
/// safety seen-set observes the same sharing the host saw (shared data
/// refuses as cyclic, exactly like the donor); forward/cycle references
/// decode to `Ref`, which safety likewise reports as cyclic. Each top-level
/// argument decodes with a fresh table: host id spaces are per-argument.
fn rows_decode(v: &J, table: &mut Vec<Option<rows::Value>>) -> rows::Value {
    if v.is_null() {
        return rows::Value::Null;
    }
    if let Some(b) = v.as_bool() {
        return rows::Value::Bool(b);
    }
    if v.get("$bits").is_some() {
        return rows::Value::Num(number(v));
    }
    if v.get("$u16").is_some() {
        return rows::Value::Str(rows::U16(text(v)));
    }
    if v.get("$undefined").is_some() {
        return rows::Value::Undef;
    }
    if v.get("$fn").is_some() || v.get("$sym").is_some() || v.get("$bigint").is_some() {
        return rows::Value::Func;
    }
    if v.get("$opaque").is_some() {
        return rows::Value::Opaque;
    }
    if let Some(id) = v.get("$ref").and_then(|n| n.as_u64()) {
        let id = id as usize;
        if let Some(hit) = table.get(id).and_then(|slot| slot.clone()) {
            return hit;
        }
        return rows::Value::Ref;
    }
    if let Some(id) = v.get("$id").and_then(|n| n.as_u64()) {
        let id = id as usize;
        let value = if let Some(items) = v.get("$items").and_then(|a| a.as_array()) {
            rows::Value::Arr(Rc::new(items.iter().map(|e| rows_decode(e, table)).collect()))
        } else {
            rows::Value::Obj(Rc::new(
                v["$entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| (rows::U16(text(&e[0])), rows_decode(&e[1], table)))
                    .collect(),
            ))
        };
        if table.len() <= id {
            table.resize(id + 1, None);
        }
        table[id] = Some(value.clone());
        return value;
    }
    if let Some(items) = v.get("$items").and_then(|a| a.as_array()) {
        return rows::Value::Arr(Rc::new(items.iter().map(|e| rows_decode(e, table)).collect()));
    }
    if let Some(a) = v.as_array() {
        return rows::Value::Arr(Rc::new(a.iter().map(|e| rows_decode(e, table)).collect()));
    }
    rows::Value::Obj(Rc::new(
        v["$entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (rows::U16(text(&e[0])), rows_decode(&e[1], table)))
            .collect(),
    ))
}
pub fn receipt_value(v: &J) -> receipt::Value {
    receipt_decode(v, &mut Vec::new())
}

/// Identity-graph decoder for receipt values: same `$id`/`$ref` contract as
/// rows (shared data refuses as cyclic under row safety, exactly like the
/// donor). `$fn` tags ride the existing `Func` variant; `$opaque` rides
/// `Opaque` for host-restored by-reference positions.
fn receipt_decode(v: &J, table: &mut Vec<Option<receipt::Value>>) -> receipt::Value {
    if v.get("$undefined").is_some() {
        return receipt::Value::Undef;
    }
    if v.is_null() {
        return receipt::Value::Null;
    }
    if let Some(b) = v.as_bool() {
        return receipt::Value::Bool(b);
    }
    if v.get("$bits").is_some() {
        return receipt::Value::Num(number(v));
    }
    if v.get("$u16").is_some() {
        return receipt::Value::Str(receipt::U16(text(v)));
    }
    if v.get("$fn").is_some() || v.get("$sym").is_some() || v.get("$bigint").is_some() {
        return receipt::Value::Func;
    }
    if v.get("$opaque").is_some() {
        return receipt::Value::Opaque;
    }
    if let Some(id) = v.get("$ref").and_then(|n| n.as_u64()) {
        let id = id as usize;
        if let Some(hit) = table.get(id).and_then(|slot| slot.clone()) {
            return hit;
        }
        return receipt::Value::Ref;
    }
    if let Some(id) = v.get("$id").and_then(|n| n.as_u64()) {
        let id = id as usize;
        let value = if let Some(items) = v.get("$items").and_then(|a| a.as_array()) {
            receipt::Value::Arr(Rc::new(items.iter().map(|e| receipt_decode(e, table)).collect()))
        } else {
            receipt::Value::Obj(Rc::new(
                v["$entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| (receipt::U16(text(&e[0])), receipt_decode(&e[1], table)))
                    .collect(),
            ))
        };
        if table.len() <= id {
            table.resize(id + 1, None);
        }
        table[id] = Some(value.clone());
        return value;
    }
    if let Some(items) = v.get("$items").and_then(|a| a.as_array()) {
        return receipt::Value::Arr(Rc::new(
            items.iter().map(|e| receipt_decode(e, table)).collect(),
        ));
    }
    if let Some(a) = v.as_array() {
        return receipt::Value::Arr(Rc::new(a.iter().map(|e| receipt_decode(e, table)).collect()));
    }
    receipt::Value::Obj(Rc::new(
        v["$entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (receipt::U16(text(&e[0])), receipt_decode(&e[1], table)))
            .collect(),
    ))
}
pub fn linkage_value(v: &J) -> linkage::Value {
    if v.is_null() {
        return linkage::Value::Null;
    }
    if let Some(b) = v.as_bool() {
        return linkage::Value::Bool(b);
    }
    if v.get("$bits").is_some() {
        return linkage::Value::Num(number(v));
    }
    if v.get("$u16").is_some() {
        return linkage::Value::Str(linkage::U16(text(v)));
    }
    if let Some(a) = v.as_array() {
        return linkage::Value::Arr(Rc::new(a.iter().map(linkage_value).collect()));
    }
    linkage::Value::Obj(Rc::new(
        v["$entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (linkage::U16(text(&e[0])), linkage_value(&e[1])))
            .collect(),
    ))
}
pub fn lifecycle_value(v: &J) -> lifecycle::Value {
    if v.is_null() {
        return lifecycle::Value::Null;
    }
    if let Some(b) = v.as_bool() {
        return lifecycle::Value::Bool(b);
    }
    if v.get("$bits").is_some() {
        return lifecycle::Value::Num(number(v));
    }
    if v.get("$u16").is_some() {
        return lifecycle::Value::Str(lifecycle::U16(text(v)));
    }
    if v.get("$opaque").is_some() {
        return lifecycle::Value::Opaque;
    }
    if let Some(a) = v.as_array() {
        return lifecycle::Value::Arr(a.iter().map(lifecycle_value).collect());
    }
    lifecycle::Value::Obj(
        v["$entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (lifecycle::U16(text(&e[0])), lifecycle_value(&e[1])))
            .collect(),
    )
}
pub fn lifecycle_observe(v: &lifecycle::Value) -> J {
    match v {
        lifecycle::Value::Null => J::Null,
        lifecycle::Value::Bool(b) => json!(b),
        lifecycle::Value::Num(x) => n(*x),
        lifecycle::Value::Str(s) => string(&s.0),
        lifecycle::Value::Arr(a) => json!(a.iter().map(lifecycle_observe).collect::<Vec<_>>()),
        lifecycle::Value::Obj(o) => {
            json!({"$entries":o.iter().map(|(k,v)|json!([k.0,lifecycle_observe(v)])).collect::<Vec<_>>() })
        }
        // Opaque carriers echo for host positional restore; the wrappers
        // overwrite every echo site with its call-local reference.
        lifecycle::Value::Opaque => json!({"$opaque": true}),
        lifecycle::Value::Map(_) | lifecycle::Value::Set(_) => {
            panic!("unsupported sample output channel")
        }
    }
}
pub fn lifecycle_item(v: &J) -> lifecycle::OutboxItem {
    lifecycle::OutboxItem {
        id: lifecycle::U16(text(field(v, "id"))),
        operation_id: lifecycle::U16(text(field(v, "operationId"))),
        source: lifecycle::U16(text(field(v, "source"))),
        occurrence_index: number(field(v, "occurrenceIndex")),
        request: lifecycle_value(field(v, "request")),
        origin_occurrence: (!field(v, "originOccurrence").is_null())
            .then(|| lifecycle::U16(text(field(v, "originOccurrence")))),
        attempts: number(field(v, "attempts")),
        state: lifecycle::U16(text_lenient(field(v, "state"))),
    }
}
pub fn item_observe(v: &lifecycle::OutboxItem) -> J {
    object(vec![
        ("id", string(&v.id.0)),
        ("operationId", string(&v.operation_id.0)),
        ("source", string(&v.source.0)),
        ("occurrenceIndex", n(v.occurrence_index)),
        ("request", lifecycle_observe(&v.request)),
        (
            "originOccurrence",
            v.origin_occurrence
                .as_ref()
                .map(|x| string(&x.0))
                .unwrap_or(J::Null),
        ),
        ("attempts", n(v.attempts)),
        ("state", string(&v.state.0)),
    ])
}
pub fn error_observe(v: &Option<lifecycle::ReceiptError>) -> J {
    v.as_ref()
        .map(|x| {
            object(vec![
                ("code", string(&x.code.0)),
                ("message", string(&x.message.0)),
            ])
        })
        .unwrap_or(J::Null)
}
pub fn rows_row(v: &J) -> rows::StoredRow {
    rows::StoredRow {
        id: rows::U16(text(field(v, "id"))),
        version: number(field(v, "version")),
        created: number(field(v, "created")),
        updated: number(field(v, "updated")),
        created_by: rows::U16(text(field(v, "createdBy"))),
        updated_by: rows::U16(text(field(v, "updatedBy"))),
        archived_at: rows_value(field(v, "archivedAt")),
        parent: rows_value(field(v, "parent")),
        data: rows_value(field(v, "data")),
    }
}
pub fn rows_observe(v: &rows::Value) -> J {
    match v {
        rows::Value::Null => J::Null,
        rows::Value::Bool(b) => json!(b),
        rows::Value::Num(x) => n(*x),
        rows::Value::Str(s) => string(&s.0),
        rows::Value::Arr(a) => json!(a.iter().map(rows_observe).collect::<Vec<_>>()),
        rows::Value::Obj(o) => {
            json!({"$entries":o.iter().map(|(k,v)|json!([k.0,rows_observe(v)])).collect::<Vec<_>>()})
        }
        // Opaque carriers echo for host positional restore (occurrence
        // results ride opaque and are restored by the wrapper); the rest is
        // unreachable post-safety (work-profile safety refuses exotics
        // before any observe, and state clone-only data never crosses).
        rows::Value::Opaque => json!({"$opaque": true}),
        rows::Value::Undef | rows::Value::Func | rows::Value::Ref => {
            panic!("unobservable exotic value reached rows observe")
        }
    }
}
pub fn receipt_observe(v: &receipt::Value) -> J {
    match v {
        receipt::Value::Null => J::Null,
        receipt::Value::Bool(b) => json!(b),
        receipt::Value::Num(x) => n(*x),
        receipt::Value::Str(s) => string(&s.0),
        receipt::Value::Arr(a) => json!(a.iter().map(receipt_observe).collect::<Vec<_>>()),
        receipt::Value::Obj(o) => {
            json!({"$entries":o.iter().map(|(k,v)|json!([k.0,receipt_observe(v)])).collect::<Vec<_>>()})
        }
        receipt::Value::Undef => json!({"$undefined":true}),
        // Opaque carriers echo for host positional restore; the wrappers
        // overwrite every echo site with its call-local reference.
        receipt::Value::Opaque => json!({"$opaque": true}),
        receipt::Value::Func => panic!("unsupported sample output channel"),
        receipt::Value::Ref => panic!("unresolvable identity reached receipt observe"),
    }
}
pub fn linkage_observe(v: &linkage::Value) -> J {
    match v {
        linkage::Value::Null => J::Null,
        linkage::Value::Bool(b) => json!(b),
        linkage::Value::Num(x) => n(*x),
        linkage::Value::Str(s) => string(&s.0),
        linkage::Value::Arr(a) => json!(a.iter().map(linkage_observe).collect::<Vec<_>>()),
        linkage::Value::Obj(o) => {
            json!({"$entries":o.iter().map(|(k,v)|json!([k.0,linkage_observe(v)])).collect::<Vec<_>>()})
        }
    }
}
pub fn recovery_value(v: &J) -> recovery::Value {
    if v.is_null() {
        return recovery::Value::Null;
    }
    if let Some(b) = v.as_bool() {
        return recovery::Value::Bool(b);
    }
    if v.get("$bits").is_some() {
        return recovery::Value::Num(number(v));
    }
    if v.get("$u16").is_some() {
        return recovery::Value::Str(recovery::U16(text(v)));
    }
    if v.get("$opaque").is_some() {
        return recovery::Value::Opaque;
    }
    if let Some(a) = v.as_array() {
        return recovery::Value::Arr(a.iter().map(recovery_value).collect());
    }
    recovery::Value::Obj(
        v["$entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (recovery::U16(text(&e[0])), recovery_value(&e[1])))
            .collect(),
    )
}
pub fn recovery_observe(v: &recovery::Value) -> J {
    match v {
        recovery::Value::Null => J::Null,
        recovery::Value::Bool(b) => json!(b),
        recovery::Value::Num(x) => n(*x),
        recovery::Value::Str(s) => string(&s.0),
        recovery::Value::Arr(a) => json!(a.iter().map(recovery_observe).collect::<Vec<_>>()),
        recovery::Value::Obj(o) => {
            json!({"$entries":o.iter().map(|(k,v)|json!([k.0,recovery_observe(v)])).collect::<Vec<_>>()})
        }
        // Opaque carriers echo for host positional restore; the wrappers
        // overwrite every echo site with its call-local reference.
        recovery::Value::Opaque => json!({"$opaque": true}),
    }
}
pub fn rows_direction(v: &J) -> rows::Direction {
    if ascii(v) == "work" {
        rows::Direction::Work
    } else {
        rows::Direction::State
    }
}
pub fn rows_meta(v: &J) -> rows::NewRowMeta {
    rows::NewRowMeta {
        now_ms: number(field(v, "nowMs")),
        actor: rows::U16(text(field(v, "actor"))),
    }
}
pub fn receipt_meta(v: &J) -> receipt::NewRowMeta {
    receipt::NewRowMeta {
        now_ms: number(field(v, "nowMs")),
        actor: receipt::U16(text(field(v, "actor"))),
    }
}
pub fn rows_stored_observe(v: &rows::StoredRow) -> J {
    object(vec![
        ("id", string(&v.id.0)),
        ("version", n(v.version)),
        ("created", n(v.created)),
        ("updated", n(v.updated)),
        ("createdBy", string(&v.created_by.0)),
        ("updatedBy", string(&v.updated_by.0)),
        ("archivedAt", rows_observe(&v.archived_at)),
        ("parent", rows_observe(&v.parent)),
        ("data", rows_observe(&v.data)),
    ])
}
pub fn receipt_item(v: &J) -> receipt::OutboxItem {
    receipt::OutboxItem {
        id: receipt::U16(text(field(v, "id"))),
        operation_id: receipt::U16(text(field(v, "operationId"))),
        source: receipt::U16(text(field(v, "source"))),
        occurrence_index: number(field(v, "occurrenceIndex")),
        request: receipt_value(field(v, "request")),
        origin_occurrence: (!field(v, "originOccurrence").is_null())
            .then(|| receipt::U16(text(field(v, "originOccurrence")))),
        attempts: number(field(v, "attempts")),
        state: receipt::U16(text_lenient(field(v, "state"))),
    }
}
pub fn receipt_item_observe(v: &receipt::OutboxItem) -> J {
    object(vec![
        ("id", string(&v.id.0)),
        ("operationId", string(&v.operation_id.0)),
        ("source", string(&v.source.0)),
        ("occurrenceIndex", n(v.occurrence_index)),
        ("request", receipt_observe(&v.request)),
        (
            "originOccurrence",
            v.origin_occurrence
                .as_ref()
                .map(|x| string(&x.0))
                .unwrap_or(J::Null),
        ),
        ("attempts", n(v.attempts)),
        ("state", string(&v.state.0)),
    ])
}
pub fn recovery_item(v: &J) -> recovery::OutboxItem {
    recovery::OutboxItem {
        id: recovery::U16(text(field(v, "id"))),
        operation_id: recovery::U16(text(field(v, "operationId"))),
        source: recovery::U16(text(field(v, "source"))),
        occurrence_index: number(field(v, "occurrenceIndex")),
        request: recovery_value(field(v, "request")),
        origin_occurrence: (!field(v, "originOccurrence").is_null())
            .then(|| recovery::U16(text(field(v, "originOccurrence")))),
        attempts: number(field(v, "attempts")),
        state: recovery::U16(text_lenient(field(v, "state"))),
    }
}
pub fn recovery_item_observe(v: &recovery::OutboxItem) -> J {
    object(vec![
        ("id", string(&v.id.0)),
        ("operationId", string(&v.operation_id.0)),
        ("source", string(&v.source.0)),
        ("occurrenceIndex", n(v.occurrence_index)),
        ("request", recovery_observe(&v.request)),
        (
            "originOccurrence",
            v.origin_occurrence
                .as_ref()
                .map(|x| string(&x.0))
                .unwrap_or(J::Null),
        ),
        ("attempts", n(v.attempts)),
        ("state", string(&v.state.0)),
    ])
}
pub fn recovery_claim(v: &J) -> recovery::DispatchClaim {
    recovery::DispatchClaim {
        outbox_id: recovery::U16(text(field(v, "outboxId"))),
        claim_id: recovery::U16(text(field(v, "claimId"))),
        claimed_at: number(field(v, "claimedAt")),
    }
}
pub fn recovery_claim_observe(v: &recovery::DispatchClaim) -> J {
    object(vec![
        ("outboxId", string(&v.outbox_id.0)),
        ("claimId", string(&v.claim_id.0)),
        ("claimedAt", n(v.claimed_at)),
    ])
}
pub fn recovery_policy(v: &J) -> Option<recovery::RetryPolicy> {
    (!is_absent(v)).then(|| recovery::RetryPolicy {
        max_attempts: number(field(v, "maxAttempts")),
        horizon_ms: number(field(v, "horizonMs")),
    })
}
pub fn receipt_assoc_data(v: &J) -> receipt::AssociationRowData {
    receipt::AssociationRowData {
        record_model: receipt::U16(text(field(v, "recordModel"))),
        record_id: receipt::U16(text(field(v, "recordId"))),
        field: receipt::U16(text(field(v, "field"))),
        delivery_id: receipt::U16(text(field(v, "deliveryId"))),
        source: receipt::U16(text(field(v, "source"))),
        revision: number(field(v, "revision")),
    }
}
pub fn receipt_receipt_data(v: &J) -> receipt::ReceiptRowData {
    let error = field(v, "error");
    receipt::ReceiptRowData {
        delivery_id: receipt::U16(text(field(v, "deliveryId"))),
        revision: number(field(v, "revision")),
        status: receipt::U16(text(field(v, "status"))),
        result: receipt_value(field(v, "result")),
        error: (!error.is_null()).then(|| receipt::ReceiptError {
            code: receipt::U16(text(field(error, "code"))),
            message: receipt::U16(text(field(error, "message"))),
        }),
        content_ref: opt_receipt_text(field(v, "contentRef")),
        result_expires_at_ms: opt_receipt_num(field(v, "resultExpiresAtMs")),
    }
}
pub fn receipt_stored_row(v: &J) -> receipt::StoredRow {
    receipt::StoredRow {
        id: receipt::U16(text(field(v, "id"))),
        version: number(field(v, "version")),
        created: number(field(v, "created")),
        updated: number(field(v, "updated")),
        created_by: receipt::U16(text(field(v, "createdBy"))),
        updated_by: receipt::U16(text(field(v, "updatedBy"))),
        archived_at: receipt_value(field(v, "archivedAt")),
        parent: receipt_value(field(v, "parent")),
        data: receipt_value(field(v, "data")),
    }
}
pub fn receipt_stored_observe(v: &receipt::StoredRow) -> J {
    object(vec![
        ("id", string(&v.id.0)),
        ("version", n(v.version)),
        ("created", n(v.created)),
        ("updated", n(v.updated)),
        ("createdBy", string(&v.created_by.0)),
        ("updatedBy", string(&v.updated_by.0)),
        ("archivedAt", receipt_observe(&v.archived_at)),
        ("parent", receipt_observe(&v.parent)),
        ("data", receipt_observe(&v.data)),
    ])
}
pub fn opt_receipt_text(v: &J) -> Option<receipt::U16> {
    if v.is_null() {
        None
    } else {
        Some(receipt::U16(text(v)))
    }
}
pub fn opt_receipt_num(v: &J) -> Option<f64> {
    if v.is_null() {
        None
    } else {
        Some(number(v))
    }
}
pub fn linkage_batch(v: &J) -> linkage::CommitBatch {
    // Claim/recovery batches carry no outbox intents: missing reads as
    // empty, like the donor's `?? []`.
    let outbox = field(v, "outbox");
    linkage::CommitBatch {
        outbox: if outbox.is_null() {
            Vec::new()
        } else {
            outbox
                .as_array()
                .unwrap()
                .iter()
                .map(|x| linkage::OutboxIntent {
                    intent_id: linkage::U16(text(field(x, "intentId"))),
                })
                .collect()
        },
        writes: field(v, "writes")
            .as_array()
            .unwrap()
            .iter()
            .map(|x| linkage::DomainWrite {
                kind: match ascii(field(x, "kind")).as_str() {
                    "insert" => linkage::WriteKind::Insert,
                    "update" => linkage::WriteKind::Update,
                    "remove" => linkage::WriteKind::Remove,
                    _ => panic!("unknown write kind"),
                },
                model: linkage::U16(text(field(x, "model"))),
                row: linkage_row(field(x, "row")),
                id: (!field(x, "id").is_null()).then(|| linkage::U16(text(field(x, "id")))),
            })
            .collect(),
    }
}
pub fn linkage_row(v: &J) -> linkage::StoredRow {
    linkage::StoredRow {
        id: linkage::U16(text(field(v, "id"))),
        version: number(field(v, "version")),
        created: number(field(v, "created")),
        updated: number(field(v, "updated")),
        created_by: linkage::U16(text(field(v, "createdBy"))),
        updated_by: linkage::U16(text(field(v, "updatedBy"))),
        archived_at: linkage_value(field(v, "archivedAt")),
        parent: linkage_value(field(v, "parent")),
        data: linkage_value(field(v, "data")),
    }
}
struct Fixed {
    sample: f64,
    calls: Rc<Cell<u64>>,
}
impl retry::RandomPort for Fixed {
    fn next_unit(&self) -> f64 {
        self.calls.set(self.calls.get() + 1);
        self.sample
    }
}

pub fn opt_text(v: &J) -> Option<rows::U16> {
    if v.is_null() {
        None
    } else {
        Some(rows::U16(text(v)))
    }
}
pub fn opt_num(v: &J) -> Option<f64> {
    if v.is_null() {
        None
    } else {
        Some(number(v))
    }
}
pub fn opt_bool(v: &J) -> Option<bool> {
    if v.is_null() {
        None
    } else {
        Some(v.as_bool().unwrap())
    }
}
pub fn rows_child_data(v: &J) -> rows::FanoutChildRowData {
    rows::FanoutChildRowData {
        fanout_id: rows::U16(text(field(v, "fanoutId"))),
        parent_occurrence: rows::U16(text(field(v, "parentOccurrence"))),
        handler: rows::U16(text(field(v, "handler"))),
        record_id: rows::U16(text(field(v, "recordId"))),
        child_id: rows::U16(text(field(v, "childId"))),
        state: rows::U16(text(field(v, "state"))),
        attempts: number(field(v, "attempts")),
        cause_kind: {
            let f = field(v, "causeKind");
            if f.is_null() {
                None
            } else {
                Some(rows::U16(text(f)))
            }
        },
        cause_reason: {
            let f = field(v, "causeReason");
            if f.is_null() {
                None
            } else {
                Some(rows::U16(text(f)))
            }
        },
    }
}
pub fn observe(c: &J) -> J {
    let args = c["args"].as_array().unwrap();
    let calls = Rc::new(Cell::new(0));
    let outcome = match (c["leaf"].as_str().unwrap(), c["fn"].as_str().unwrap()) {
        ("rows", "readSupersessionRow") => match rows::read_supersession_row(&rows_row(&args[0])) {
            Ok(v) => ok(object(vec![
                ("outboxId", string(&v.outbox_id.0)),
                (
                    "byOccurrenceId",
                    v.by_occurrence_id
                        .as_ref()
                        .map(|s| string(&s.0))
                        .unwrap_or(J::Null),
                ),
                ("markedAtMs", n(v.marked_at_ms)),
            ])),
            Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
        },
        ("rows", "everySlotRowId") => match rows::every_slot_row_id(
            &rows::U16(text(&args[0])),
            &rows::U16(text(&args[1])),
            &rows::U16(text(&args[2])),
            &rows::U16(text(&args[3])),
        ) {
            Ok(v) => ok(string(&v.0)),
            Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
        },
        ("retry", "computeBackoff") => {
            let v = &args[0];
            let policy = field(v, "policy");
            let input = retry::BackoffInput {
                attempt: number(field(v, "attempt")),
                first_attempt_at_ms: number(field(v, "firstAttemptAtMs")),
                now_ms: number(field(v, "nowMs")),
                policy: (!is_absent(policy)).then(|| retry::RetryPolicy {
                    max_attempts: number(field(policy, "maxAttempts")),
                    horizon_ms: number(field(policy, "horizonMs")),
                }),
                random: Fixed {
                    sample: number(field(field(v, "random"), "$randomSample")),
                    calls: calls.clone(),
                },
            };
            match retry::compute_backoff(&input) {
                Ok(v) => ok(object(vec![
                    ("exhausted", json!(v.exhausted)),
                    ("delayMs", n(v.delay_ms)),
                    ("notBeforeMs", n(v.not_before_ms)),
                ])),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("every", "computeEverySlot") => {
            match every::compute_every_slot(number(&args[0]), number(&args[1])) {
                Ok(v) => ok(object(vec![
                    ("slot", n(v.slot)),
                    ("slotStartMs", n(v.slot_start_ms)),
                ])),
                Err(e) => fault(
                    &e.name,
                    &e.message,
                    e.code.as_deref(),
                    e.scope.as_ref().map(|s| s.0.as_slice()),
                ),
            }
        }
        ("lifecycle", "reconcileUncertain") => {
            let item = lifecycle_item(&args[0]);
            let v = &args[1];
            let evidence = if v.is_null() {
                None
            } else {
                // Unknown kinds reconcile as not-found (pending), exactly
                // like the donor's fallthrough; non-string kinds the same.
                let kind_node = field(v, "kind");
                let kind = if kind_node.get("$u16").is_some() {
                    ascii(kind_node)
                } else {
                    String::new()
                };
                Some(match kind.as_str() {
                    "delivered" => lifecycle::ReconcileEvidence::Delivered {
                        result: lifecycle_value(field(v, "result")),
                    },
                    "failed" => lifecycle::ReconcileEvidence::Failed {
                        code: lifecycle::U16(text(field(v, "code"))),
                        message: lifecycle::U16(text(field(v, "message"))),
                    },
                    _ => lifecycle::ReconcileEvidence::NotFound,
                })
            };
            let v = lifecycle::reconcile_uncertain(&item, &evidence);
            ok(object(vec![
                ("item", item_observe(&v.item)),
                ("changed", json!(v.changed)),
                (
                    "status",
                    v.status.as_ref().map(|s| string(&s.0)).unwrap_or(J::Null),
                ),
                ("result", lifecycle_observe(&v.result)),
                ("error", error_observe(&v.error)),
            ]))
        }
        ("lifecycle", "recordOutcome") => {
            let v = &args[0];
            let raw = field(v, "outcome");
            let policy = field(v, "policy");
            // Any kind outside delivered/uncertain runs the failed branch,
            // exactly like the donor; non-string kinds the same way.
            let outcome_kind_node = field(raw, "kind");
            let outcome_kind = if outcome_kind_node.get("$u16").is_some() {
                ascii(outcome_kind_node)
            } else {
                String::from("failed")
            };
            let outcome = match outcome_kind.as_str() {
                "delivered" => lifecycle::ProviderOutcome::Delivered {
                    result: lifecycle_value(field(raw, "result")),
                },
                "uncertain" => lifecycle::ProviderOutcome::Uncertain,
                _ => {
                    let cause = field(raw, "cause");
                    // Unknown kinds classify terminal with the carried
                    // code/message, exactly like the donor (only
                    // `transient` is transient; the payload is passthrough).
                    // Non-string kinds decide the same way (never a throw).
                    let kind_node = field(cause, "kind");
                    let kind = if kind_node.get("$u16").is_some() {
                        ascii(kind_node)
                    } else {
                        String::new()
                    };
                    lifecycle::ProviderOutcome::Failed {
                        cause: match kind.as_str() {
                            "handler-require-false" => {
                                lifecycle::FailureCause::HandlerRequireFalse {
                                    require: lifecycle::U16(text(field(cause, "require"))),
                                }
                            }
                            "transient" => lifecycle::FailureCause::Transient {
                                code: lifecycle::U16(text(field(cause, "code"))),
                                message: lifecycle::U16(text(field(cause, "message"))),
                            },
                            _ => lifecycle::FailureCause::Permanent {
                                code: lifecycle::U16(text(field(cause, "code"))),
                                message: lifecycle::U16(text(field(cause, "message"))),
                            },
                        },
                    }
                }
            };
            let input = lifecycle::RecordOutcomeInput {
                item: lifecycle_item(field(v, "item")),
                outcome,
                now_ms: number(field(v, "nowMs")),
                first_attempt_at_ms: number(field(v, "firstAttemptAtMs")),
                policy: (!is_absent(policy)).then(|| lifecycle::RetryPolicy {
                    max_attempts: number(field(policy, "maxAttempts")),
                    horizon_ms: number(field(policy, "horizonMs")),
                }),
            };
            match lifecycle::record_outcome(&input) {
                Ok(v) => ok(object(vec![
                    ("item", item_observe(&v.item)),
                    ("status", string(&v.status.0)),
                    ("result", lifecycle_observe(&v.result)),
                    ("error", error_observe(&v.error)),
                    (
                        "retryClass",
                        v.retry_class
                            .as_ref()
                            .map(|s| string(&s.0))
                            .unwrap_or(J::Null),
                    ),
                    ("retryable", json!(v.retryable)),
                ])),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("receipt", "isConsistentCompletion") => ok(json!(receipt::is_consistent_completion(
            &receipt_value(&args[0]),
            &receipt_value(&args[1]),
            &receipt_value(&args[2])
        ))),
        ("receipt", "isStoredReceiptPayload") => ok(json!(receipt::is_stored_receipt_payload(
            &receipt_value(&args[0]),
            &receipt_value(&args[1]),
            &receipt_value(&args[2])
        ))),
        // Non-string statuses decide false, exactly like the donor's
        // strict comparisons (never a throw).
        ("receipt", "isTerminalReceiptStatus") => match args[0].get("$u16") {
            Some(_) => ok(json!(receipt::is_terminal_receipt_status(
                &receipt::U16(text(&args[0]))
            ))),
            None => ok(json!(false)),
        },
        ("recovery", "isClaimStale") => {
            let v = &args[0];
            let claim = recovery::DispatchClaim {
                outbox_id: recovery::U16(text(field(v, "outboxId"))),
                claim_id: recovery::U16(text(field(v, "claimId"))),
                claimed_at: number(field(v, "claimedAt")),
            };
            match recovery::is_claim_stale(&claim, number(&args[1]), number(&args[2])) {
                Ok(v) => ok(json!(v)),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("linkage", "assertDispatchJoin") => {
            match linkage::assert_dispatch_join(&linkage_batch(&args[0])) {
                Ok(()) => ok(json!({"$undefined":true})),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "readDispatchRow") => match rows::read_dispatch_row(&rows_row(&args[0])) {
            Ok(v) => ok(object(vec![
                ("intentId", string(&v.intent_id.0)),
                ("operationId", string(&v.operation_id.0)),
                ("source", string(&v.source.0)),
                ("occurrenceIndex", n(v.occurrence_index)),
                (
                    "originOccurrence",
                    v.origin_occurrence
                        .as_ref()
                        .map(|x| string(&x.0))
                        .unwrap_or(J::Null),
                ),
                ("state", string(&v.state.0)),
                ("attempts", n(v.attempts)),
                (
                    "claimId",
                    v.claim_id.as_ref().map(|x| string(&x.0)).unwrap_or(J::Null),
                ),
                ("claimedAtMs", v.claimed_at_ms.map(n).unwrap_or(J::Null)),
                (
                    "guardVerdict",
                    v.guard_verdict.map(|b| json!(b)).unwrap_or(J::Null),
                ),
                (
                    "deliveryId",
                    v.delivery_id
                        .as_ref()
                        .map(|x| string(&x.0))
                        .unwrap_or(J::Null),
                ),
                (
                    "errorCode",
                    v.error_code
                        .as_ref()
                        .map(|x| string(&x.0))
                        .unwrap_or(J::Null),
                ),
                (
                    "errorMessage",
                    v.error_message
                        .as_ref()
                        .map(|x| string(&x.0))
                        .unwrap_or(J::Null),
                ),
                ("availableAtMs", v.available_at_ms.map(n).unwrap_or(J::Null)),
                (
                    "firstAttemptAtMs",
                    v.first_attempt_at_ms.map(n).unwrap_or(J::Null),
                ),
                (
                    "retryClass",
                    v.retry_class
                        .as_ref()
                        .map(|x| string(&x.0))
                        .unwrap_or(J::Null),
                ),
            ])),
            Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
        },
        ("rows", "readOccurrenceRow") => match rows::read_occurrence_row(&rows_row(&args[0])) {
            Ok(v) => ok(object(vec![
                ("occurrenceId", string(&v.occurrence_id.0)),
                ("status", string(&v.status.0)),
                ("result", rows_observe(&v.result)),
                (
                    "code",
                    v.code.as_ref().map(|x| string(&x.0)).unwrap_or(J::Null),
                ),
                (
                    "message",
                    v.message.as_ref().map(|x| string(&x.0)).unwrap_or(J::Null),
                ),
                ("recordedAtMs", n(v.recorded_at_ms)),
            ])),
            Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
        },
        ("rows", "readScheduleRow") => match rows::read_schedule_row(&rows_row(&args[0])) {
            Ok(v) => ok(object(vec![
                ("occurrenceId", string(&v.occurrence_id.0)),
                ("key", string(&v.key.0)),
                ("scopeApp", string(&v.scope_app.0)),
                ("scopeOwner", string(&v.scope_owner.0)),
                ("scopeOwnerPackage", string(&v.scope_owner_package.0)),
                ("at", n(v.at)),
                ("event", string(&v.event.0)),
                ("payload", rows_observe(&v.payload)),
                (
                    "replaces",
                    v.replaces.as_ref().map(|x| string(&x.0)).unwrap_or(J::Null),
                ),
                ("state", string(&v.state.0)),
            ])),
            Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
        },
        ("rows", "scheduleRowScope") => {
            let v = &args[0];
            let row = rows::ScheduleRowData {
                occurrence_id: rows::U16(text(field(v, "occurrenceId"))),
                key: rows::U16(text(field(v, "key"))),
                scope_app: rows::U16(text(field(v, "scopeApp"))),
                scope_owner: rows::U16(text(field(v, "scopeOwner"))),
                scope_owner_package: rows::U16(text(field(v, "scopeOwnerPackage"))),
                at: number(field(v, "at")),
                event: rows::U16(text(field(v, "event"))),
                payload: rows_value(field(v, "payload")),
                replaces: opt_text(field(v, "replaces")),
                state: rows::U16(text(field(v, "state"))),
            };
            let scope = rows::schedule_row_scope(&row);
            ok(object(vec![
                ("app", string(&scope.app.0)),
                ("owner", string(&scope.owner.0)),
                ("ownerPackage", string(&scope.owner_package.0)),
            ]))
        }
        ("rows", "readEverySlotRow") => match rows::read_every_slot_row(&rows_row(&args[0])) {
            Ok(v) => ok(object(vec![
                ("scopeKey", string(&v.scope_key.0)),
                ("app", string(&v.app.0)),
                ("handler", string(&v.handler.0)),
                ("scope", string(&v.scope.0)),
                ("owner", string(&v.owner.0)),
                ("slot", n(v.slot)),
            ])),
            Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
        },
        ("rows", "dispatchByOriginQuery") => ok(rows_observe(&rows::dispatch_by_origin_query(
            &rows::U16(text(&args[0])),
        ))),
        ("rows", "dispatchByStateQuery") => ok(rows_observe(&rows::dispatch_by_state_query(
            &rows::U16(text(&args[0])),
        ))),
        ("rows", "scheduleByKeyQuery") => {
            let v = &args[0];
            let scope = rows::Scope3 {
                app: rows::U16(text(field(v, "app"))),
                owner: rows::U16(text(field(v, "owner"))),
                owner_package: rows::U16(text(field(v, "ownerPackage"))),
            };
            ok(rows_observe(&rows::schedule_by_key_query(
                &scope,
                &rows::U16(text(&args[1])),
            )))
        }
        ("rows", "newDispatchRow") => {
            let v = &args[0];
            let input = rows::NewDispatchInput {
                intent_id: rows::U16(text(field(v, "intentId"))),
                operation_id: rows::U16(text(field(v, "operationId"))),
                source: rows::U16(text(field(v, "source"))),
                occurrence_index: number(field(v, "occurrenceIndex")),
                origin_occurrence: opt_text(field(v, "originOccurrence")),
            };
            match rows::new_dispatch_row(&input, &rows_meta(&args[1])) {
                Ok(v) => ok(rows_stored_observe(&v)),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "newOccurrenceRow") => {
            let v = &args[0];
            let input = rows::OccurrenceRowData {
                occurrence_id: rows::U16(text(field(v, "occurrenceId"))),
                status: rows::U16(text(field(v, "status"))),
                result: rows_value(field(v, "result")),
                code: opt_text(field(v, "code")),
                message: opt_text(field(v, "message")),
                recorded_at_ms: number(field(v, "recordedAtMs")),
            };
            match rows::new_occurrence_row(&input, &rows_meta(&args[1])) {
                Ok(v) => ok(rows_stored_observe(&v)),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "newScheduleRow") => {
            let v = &args[0];
            let input = rows::ScheduleRowData {
                occurrence_id: rows::U16(text(field(v, "occurrenceId"))),
                key: rows::U16(text(field(v, "key"))),
                scope_app: rows::U16(text(field(v, "scopeApp"))),
                scope_owner: rows::U16(text(field(v, "scopeOwner"))),
                scope_owner_package: rows::U16(text(field(v, "scopeOwnerPackage"))),
                at: number(field(v, "at")),
                event: rows::U16(text(field(v, "event"))),
                payload: rows_value(field(v, "payload")),
                replaces: opt_text(field(v, "replaces")),
                state: rows::U16(text(field(v, "state"))),
            };
            match rows::new_schedule_row(&input, &rows_meta(&args[1])) {
                Ok(v) => ok(rows_stored_observe(&v)),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "newEverySlotRow") => {
            let v = &args[0];
            let input = rows::EverySlotRowData {
                scope_key: rows::U16(text(field(v, "scopeKey"))),
                app: rows::U16(text(field(v, "app"))),
                handler: rows::U16(text(field(v, "handler"))),
                scope: rows::U16(text(field(v, "scope"))),
                owner: rows::U16(text(field(v, "owner"))),
                slot: number(field(v, "slot")),
            };
            match rows::new_every_slot_row(&input, &rows_meta(&args[1])) {
                Ok(v) => ok(rows_stored_observe(&v)),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "newSupersessionRow") => {
            let v = &args[0];
            let input = rows::SupersessionRowData {
                outbox_id: rows::U16(text(field(v, "outboxId"))),
                by_occurrence_id: opt_text(field(v, "byOccurrenceId")),
                marked_at_ms: number(field(v, "markedAtMs")),
            };
            match rows::new_supersession_row(&input, &rows_meta(&args[1])) {
                Ok(v) => ok(rows_stored_observe(&v)),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "checkFanoutIdentitySet") => {
            match rows::check_fanout_identity_set(
                &rows_value(&args[0]),
                &ascii(&args[1]),
                rows_direction(&args[2]),
            ) {
                Ok(v) => ok(json!(v.iter().map(|x| string(&x.0)).collect::<Vec<_>>())),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "fanoutIntentRowId") => {
            match rows::fanout_intent_row_id(
                &rows::U16(text(&args[0])),
                &rows::U16(text(&args[1])),
                &rows::U16(text(&args[2])),
                rows_direction(&args[3]),
            ) {
                Ok(v) => ok(string(&v.0)),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "fanoutCheckpointRowId") => {
            match rows::fanout_checkpoint_row_id(
                &rows::U16(text(&args[0])),
                rows_direction(&args[1]),
            ) {
                Ok(v) => ok(string(&v.0)),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "fanoutChildRowId") => {
            match rows::fanout_child_row_id(
                &rows::U16(text(&args[0])),
                &rows::U16(text(&args[1])),
                &rows::U16(text(&args[2])),
                rows_direction(&args[3]),
            ) {
                Ok(v) => ok(string(&v.0)),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "newFanoutIntentRow") => {
            let v = &args[0];
            let input = rows::NewIntentInput {
                source_occurrence: rows::U16(text(field(v, "sourceOccurrence"))),
                handler: rows::U16(text(field(v, "handler"))),
                cohort: rows::U16(text(field(v, "cohort"))),
                members: rows_value(field(v, "members")),
            };
            match rows::new_fanout_intent_row(
                &input,
                &rows_meta(&args[1]),
                rows_direction(&args[2]),
            ) {
                Ok(v) => ok(rows_stored_observe(&v)),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "newFanoutCheckpointRow") => {
            let v = &args[0];
            let completed = field(v, "completed");
            let input = rows::NewCheckpointInput {
                fanout_id: rows::U16(text(field(v, "fanoutId"))),
                completed: if completed.is_null() {
                    rows::Value::Arr(std::rc::Rc::new(vec![]))
                } else {
                    rows_value(completed)
                },
                cursor: opt_text(field(v, "cursor")),
            };
            match rows::new_fanout_checkpoint_row(
                &input,
                &rows_meta(&args[1]),
                rows_direction(&args[2]),
            ) {
                Ok(v) => ok(rows_stored_observe(&v)),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "nextFanoutCheckpointData") => {
            // Entries ride generic values; the decision validates them.
            let added: Vec<rows::Value> =
                args[1].as_array().unwrap().iter().map(rows_value).collect();
            let current = rows::FanoutCheckpointRowData {
                fanout_id: rows::U16(text(field(&args[0], "fanoutId"))),
                completed: field(&args[0], "completed")
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| rows::U16(text(x)))
                    .collect(),
                cursor: opt_text(field(&args[0], "cursor")),
            };
            match rows::next_fanout_checkpoint_data(
                &current,
                &added,
                opt_text(&args[2]),
                rows_direction(&args[3]),
            ) {
                Ok(v) => ok(object(vec![
                    ("fanoutId", string(&v.fanout_id.0)),
                    (
                        "completed",
                        json!(v.completed.iter().map(|x| string(&x.0)).collect::<Vec<_>>()),
                    ),
                    (
                        "cursor",
                        v.cursor.as_ref().map(|x| string(&x.0)).unwrap_or(J::Null),
                    ),
                ])),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "newFanoutChildRow") => {
            let v = &args[0];
            let input = rows::NewChildInput {
                fanout_id: rows::U16(text(field(v, "fanoutId"))),
                parent_occurrence: rows::U16(text(field(v, "parentOccurrence"))),
                handler: rows::U16(text(field(v, "handler"))),
                record_id: rows::U16(text(field(v, "recordId"))),
                state: opt_text(field(v, "state")),
                attempts: opt_num(field(v, "attempts")),
                cause_kind: opt_text(field(v, "causeKind")),
                cause_reason: opt_text(field(v, "causeReason")),
            };
            match rows::new_fanout_child_row(&input, &rows_meta(&args[1]), rows_direction(&args[2]))
            {
                Ok(v) => ok(rows_stored_observe(&v)),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "readFanoutIntentRow") => {
            match rows::read_fanout_intent_row(&rows_row(&args[0]), rows_direction(&args[1])) {
                Ok(v) => ok(object(vec![
                    ("fanoutId", string(&v.fanout_id.0)),
                    ("sourceOccurrence", string(&v.source_occurrence.0)),
                    ("handler", string(&v.handler.0)),
                    ("cohort", string(&v.cohort.0)),
                    (
                        "members",
                        json!(v.members.iter().map(|x| string(&x.0)).collect::<Vec<_>>()),
                    ),
                    ("memberCount", n(v.member_count)),
                ])),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "readFanoutCheckpointRow") => {
            match rows::read_fanout_checkpoint_row(&rows_row(&args[0]), rows_direction(&args[1])) {
                Ok(v) => ok(object(vec![
                    ("fanoutId", string(&v.fanout_id.0)),
                    (
                        "completed",
                        json!(v.completed.iter().map(|x| string(&x.0)).collect::<Vec<_>>()),
                    ),
                    (
                        "cursor",
                        v.cursor.as_ref().map(|x| string(&x.0)).unwrap_or(J::Null),
                    ),
                ])),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "readFanoutChildRow") => {
            match rows::read_fanout_child_row(&rows_row(&args[0]), rows_direction(&args[1])) {
                Ok(v) => ok(object(vec![
                    ("fanoutId", string(&v.fanout_id.0)),
                    ("parentOccurrence", string(&v.parent_occurrence.0)),
                    ("handler", string(&v.handler.0)),
                    ("recordId", string(&v.record_id.0)),
                    ("childId", string(&v.child_id.0)),
                    ("state", string(&v.state.0)),
                    ("attempts", n(v.attempts)),
                    (
                        "causeKind",
                        v.cause_kind
                            .as_ref()
                            .map(|x| string(&x.0))
                            .unwrap_or(J::Null),
                    ),
                    (
                        "causeReason",
                        v.cause_reason
                            .as_ref()
                            .map(|x| string(&x.0))
                            .unwrap_or(J::Null),
                    ),
                ])),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "fanoutChildIdOf") => {
            let v = rows_child_data(&args[0]);
            let id = rows::fanout_child_id_of(&v);
            ok(object(vec![
                ("parentOccurrence", string(&id.parent_occurrence.0)),
                ("handler", string(&id.handler.0)),
                ("recordId", string(&id.record_id.0)),
            ]))
        }
        ("rows", "fanoutChildPageQuery") => {
            let opts = rows::PageOpts {
                cursor: opt_text(field(&args[1], "cursor")),
                limit: number(field(&args[1], "limit")),
            };
            match rows::fanout_child_page_query(
                &rows::U16(text(&args[0])),
                &opts,
                rows_direction(&args[2]),
            ) {
                Ok(v) => ok(rows_observe(&v)),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "fanoutChildPageResult") => {
            let rows_in: Vec<rows::StoredRow> =
                args[0].as_array().unwrap().iter().map(rows_row).collect();
            match rows::fanout_child_page_result(
                &rows_in,
                number(&args[1]),
                rows_direction(&args[2]),
            ) {
                Ok(v) => ok(object(vec![
                    (
                        "rows",
                        json!(v.rows.iter().map(rows_stored_observe).collect::<Vec<_>>()),
                    ),
                    ("done", json!(v.done)),
                    (
                        "cursor",
                        v.cursor.as_ref().map(|x| string(&x.0)).unwrap_or(J::Null),
                    ),
                ])),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("retry", "classifyFailure") => {
            // Total like the donor: only `transient` is transient; the
            // code/message payload never affects classification.
            let kind = field(&args[0], "kind");
            let kind = if kind.get("$u16").is_some() || kind.as_array().is_some() {
                ascii(kind)
            } else {
                String::new()
            };
            let cause = match kind.as_str() {
                "transient" => retry::FailureCause::Transient {
                    code: retry::U16(vec![]),
                    message: retry::U16(vec![]),
                },
                _ => retry::FailureCause::HandlerRequireFalse {
                    require: retry::U16(vec![]),
                },
            };
            ok(string(&retry::classify_failure(&cause).0))
        }
        ("retry", "assertPolicy") => {
            let v = &args[0];
            let policy = retry::RetryPolicy {
                max_attempts: number(field(v, "maxAttempts")),
                horizon_ms: number(field(v, "horizonMs")),
            };
            match retry::assert_policy(&policy) {
                Ok(()) => ok(json!({"$undefined":true})),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("every", "everyScopeKey") => ok(string(
            &every::every_scope_key(&every::U16(text(&args[0])), &every::U16(text(&args[1]))).0,
        )),
        ("receipt", "listDeadLetter") => {
            let items: Vec<receipt::OutboxItem> = args[0]
                .as_array()
                .unwrap()
                .iter()
                .map(receipt_item)
                .collect();
            ok(json!(receipt::list_dead_letter(&items)
                .iter()
                .map(receipt_item_observe)
                .collect::<Vec<_>>()))
        }
        ("receipt", "toReceiptObservation") => {
            // Donor read order: deliveryId, revision, then the recorded
            // fields. Locator refusal faults here (RangeError, donor text);
            // result/error are donor-unread passthroughs carried opaquely
            // for host restore, and status rides only when it is a string.
            let revision_ok = match args[1].get("$bits") {
                Some(_) => {
                    let revision = number(&args[1]);
                    revision.fract() == 0.0 && revision >= 0.0
                }
                None => false,
            };
            // DeliveryId refuses before revision, exactly like the donor.
            let refusal: Option<J> =
                if !args[0].get("$u16").and_then(|u| u.as_array()).is_some()
                    || text(&args[0]).is_empty()
                {
                    Some(fault(
                        "RangeError",
                        "toReceiptObservation: deliveryId must be a non-empty string",
                        None,
                        None,
                    ))
                } else if !revision_ok {
                    Some(fault(
                        "RangeError",
                        "toReceiptObservation: revision must be a non-negative integer",
                        None,
                        None,
                    ))
                } else {
                    None
                };
            match refusal {
                Some(outcome) => outcome,
                None => {
                    let recorded = &args[2];
                    let status = match field(recorded, "status").get("$u16") {
                        Some(_) => text(field(recorded, "status")),
                        None => Vec::new(),
                    };
                    let input = receipt::RecordedReceiptFields {
                        status: receipt::U16(status),
                        result: receipt_value(field(recorded, "result")),
                        error: None,
                    };
                    match receipt::to_receipt_observation(
                        &receipt::U16(text(&args[0])),
                        number(&args[1]),
                        &input,
                    ) {
                Ok(v) => ok(object(vec![
                    ("id", string(&v.id.0)),
                    ("revision", n(v.revision)),
                    ("status", string(&v.status.0)),
                    ("result", receipt_observe(&v.result)),
                    (
                        "error",
                        v.error
                            .as_ref()
                            .map(|x| {
                                object(vec![
                                    ("code", string(&x.code.0)),
                                    ("message", string(&x.message.0)),
                                ])
                            })
                            .unwrap_or(J::Null),
                    ),
                ])),
                Err(e) => fault(&e.name, &e.message, None, None),
                    }
                }
            }
        }
        ("receipt", "associationRowId") => {
            match receipt::association_row_id(
                &receipt::U16(text(&args[0])),
                &receipt::U16(text(&args[1])),
                &receipt::U16(text(&args[2])),
            ) {
                Ok(v) => ok(string(&v.0)),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("receipt", "readAssociationRow") => {
            match receipt::read_association_row(&receipt_stored_row(&args[0])) {
                Ok(v) => ok(object(vec![
                    (
                        "locator",
                        object(vec![
                            ("recordId", string(&v.locator.record_id.0)),
                            ("field", string(&v.locator.field.0)),
                        ]),
                    ),
                    ("deliveryId", string(&v.delivery_id.0)),
                    ("source", string(&v.source.0)),
                    ("revision", n(v.revision)),
                ])),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("receipt", "readReceiptRow") => {
            match receipt::read_receipt_row(&receipt_stored_row(&args[0])) {
                Ok(v) => ok(object(vec![
                    (
                        "receipt",
                        object(vec![
                            ("deliveryId", string(&v.receipt.delivery_id.0)),
                            ("revision", n(v.receipt.revision)),
                            ("status", string(&v.receipt.status.0)),
                            ("result", receipt_observe(&v.receipt.result)),
                            (
                                "error",
                                v.receipt
                                    .error
                                    .as_ref()
                                    .map(|x| {
                                        object(vec![
                                            ("code", string(&x.code.0)),
                                            ("message", string(&x.message.0)),
                                        ])
                                    })
                                    .unwrap_or(J::Null),
                            ),
                        ]),
                    ),
                    (
                        "contentRef",
                        v.content_ref
                            .as_ref()
                            .map(|x| string(&x.0))
                            .unwrap_or(J::Null),
                    ),
                    (
                        "resultExpiresAtMs",
                        v.result_expires_at_ms.map(n).unwrap_or(J::Null),
                    ),
                ])),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("receipt", "newAssociationRow") => {
            let input = receipt_assoc_data(&args[0]);
            match receipt::new_association_row(&input, &receipt_meta(&args[1])) {
                Ok(v) => ok(receipt_stored_observe(&v)),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("receipt", "newReceiptRow") => {
            let input = receipt_receipt_data(&args[0]);
            match receipt::new_receipt_row(&input, &receipt_meta(&args[1])) {
                Ok(v) => ok(receipt_stored_observe(&v)),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("receipt", "withAssociationRowData") => {
            let input = receipt_assoc_data(&args[1]);
            match receipt::with_association_row_data(
                &receipt_stored_row(&args[0]),
                &input,
                &receipt_meta(&args[2]),
            ) {
                Ok(v) => ok(receipt_stored_observe(&v)),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("receipt", "withReceiptRowData") => {
            let input = receipt_receipt_data(&args[1]);
            match receipt::with_receipt_row_data(
                &receipt_stored_row(&args[0]),
                &input,
                &receipt_meta(&args[2]),
            ) {
                Ok(v) => ok(receipt_stored_observe(&v)),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("recovery", "findStaleClaims") => {
            let claims: Vec<recovery::DispatchClaim> = args[0]
                .as_array()
                .unwrap()
                .iter()
                .map(recovery_claim)
                .collect();
            match recovery::find_stale_claims(&claims, number(&args[1]), number(&args[2])) {
                Ok(v) => ok(json!(v
                    .iter()
                    .map(recovery_claim_observe)
                    .collect::<Vec<_>>())),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("recovery", "releaseStaleClaims") => {
            let items: Vec<recovery::OutboxItem> = args[0]
                .as_array()
                .unwrap()
                .iter()
                .map(recovery_item)
                .collect();
            let claims: Vec<recovery::DispatchClaim> = args[1]
                .as_array()
                .unwrap()
                .iter()
                .map(recovery_claim)
                .collect();
            match recovery::release_stale_claims(
                &items,
                &claims,
                number(&args[2]),
                number(&args[3]),
            ) {
                Ok(v) => ok(object(vec![
                    (
                        "items",
                        json!(v
                            .items
                            .iter()
                            .map(recovery_item_observe)
                            .collect::<Vec<_>>()),
                    ),
                    (
                        "releasedIds",
                        json!(v
                            .released_ids
                            .iter()
                            .map(|x| string(&x.0))
                            .collect::<Vec<_>>()),
                    ),
                ])),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("recovery", "buildInventory") => {
            let v = &args[0];
            let items: Vec<recovery::OutboxItem> = field(v, "outboxItems")
                .as_array()
                .unwrap()
                .iter()
                .map(recovery_item)
                .collect();
            let due: Vec<recovery::Value> = field(v, "dueOccurrences")
                .as_array()
                .unwrap()
                .iter()
                .map(recovery_value)
                .collect();
            // Per-occurrence reply list in donor consultation order: each
            // uncertain item consumes the next reply, so duplicate ids keep
            // their own replies and the minimum retains the oldest. Unknown
            // commits stay unknown, exactly like the donor's guard.
            let replies: Vec<Option<f64>> = field(v, "committedList")
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| {
                    if entry.get("$bits").is_none() {
                        None
                    } else {
                        Some(number(entry))
                    }
                })
                .collect();
            let cursor = Cell::new(0usize);
            let input = recovery::InventoryInput {
                outbox_items: &items,
                due_occurrences: &due,
                committed_at_ms: &|_id: &recovery::U16| {
                    let index = cursor.get();
                    cursor.set(index + 1);
                    match replies.get(index) {
                        Some(reply) => *reply,
                        None => {
                            panic!("committed reply list skew: fewer replies than uncertain items")
                        }
                    }
                },
            };
            let got = recovery::build_inventory(&input);
            ok(object(vec![
                ("outboxPending", n(got.outbox_pending)),
                ("outboxClaimed", n(got.outbox_claimed)),
                ("outboxUncertain", n(got.outbox_uncertain)),
                ("outboxDead", n(got.outbox_dead)),
                ("dueOccurrences", n(got.due_occurrences)),
                (
                    "oldestUncertainAt",
                    got.oldest_uncertain_at.map(n).unwrap_or(J::Null),
                ),
            ]))
        }
        ("recovery", "buildWorkInventory") => {
            let v = &args[0];
            let items: Vec<recovery::OutboxItem> = field(v, "outboxItems")
                .as_array()
                .unwrap()
                .iter()
                .map(recovery_item)
                .collect();
            // Per-occurrence reply list in donor consultation order: each
            // consulted (non-settled, pre-refusal) occurrence consumes the
            // next reply, duplicates included. Null and non-text replies
            // land unmapped exactly like the donor's guard. An unknown-state
            // item refuses before consuming, exactly like the donor.
            let replies: Vec<Option<Vec<u16>>> = field(v, "contractsList")
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| {
                    if entry.get("$u16").is_none() {
                        None
                    } else {
                        let contract = text(entry);
                        (!contract.is_empty()).then(|| contract)
                    }
                })
                .collect();
            let cursor = Cell::new(0usize);
            let input = recovery::WorkInventoryInput {
                outbox_items: &items,
                handler_contract_for: &|_item: &recovery::OutboxItem| {
                    let index = cursor.get();
                    cursor.set(index + 1);
                    match replies.get(index) {
                        Some(reply) => reply.clone().map(recovery::U16),
                        None => {
                            panic!("contract reply list skew: fewer replies than consulted items")
                        }
                    }
                },
            };
            match recovery::build_work_inventory(&input) {
                Ok(list) => ok(json!(list
                    .iter()
                    .map(|x| object(vec![
                        ("intentId", string(&x.intent_id.0)),
                        ("handlerContract", string(&x.handler_contract.0)),
                        ("state", string(&x.state.0)),
                    ]))
                    .collect::<Vec<_>>())),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("recovery", "recordStagingFailure") => {
            let v = &args[0];
            let raw = field(v, "cause");
            // Staging classifies on kind alone (no error is synthesized):
            // unknown and non-string kinds classify terminal, exactly like
            // the donor. Payload dummies ride only for parsing.
            let cause_kind_node = field(raw, "kind");
            let cause_kind = if cause_kind_node.get("$u16").is_some() {
                ascii(cause_kind_node)
            } else {
                String::new()
            };
            let cause = match cause_kind.as_str() {
                "handler-require-false" => recovery::FailureCause::HandlerRequireFalse {
                    require: recovery::U16(text(field(raw, "require"))),
                },
                "transient" => recovery::FailureCause::Transient {
                    code: recovery::U16(text(field(raw, "code"))),
                    message: recovery::U16(text(field(raw, "message"))),
                },
                _ => recovery::FailureCause::Permanent {
                    code: recovery::U16(text(field(raw, "code"))),
                    message: recovery::U16(text(field(raw, "message"))),
                },
            };
            let input = recovery::RecordStagingFailureInput {
                item: recovery_item(field(v, "item")),
                cause,
                now_ms: number(field(v, "nowMs")),
                first_attempt_at_ms: number(field(v, "firstAttemptAtMs")),
                policy: recovery_policy(field(v, "policy")),
            };
            match recovery::record_staging_failure(&input) {
                Ok(got) => ok(object(vec![
                    ("item", recovery_item_observe(&got.item)),
                    ("disposition", string(&got.disposition.0)),
                    ("retryClass", string(&got.retry_class.0)),
                    ("retryable", json!(got.retryable)),
                ])),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("recovery", "isFanoutClaimStale") => {
            match recovery::is_fanout_claim_stale(
                number(&args[0]),
                number(&args[1]),
                number(&args[2]),
            ) {
                Ok(v) => ok(json!(v)),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("recovery", "isFanoutChildExhausted") => {
            match recovery::is_fanout_child_exhausted(
                number(&args[0]),
                opt_num(&args[1]),
                number(&args[2]),
                &recovery::RetryPolicy {
                    max_attempts: number(field(&args[3], "maxAttempts")),
                    horizon_ms: number(field(&args[3], "horizonMs")),
                },
            ) {
                Ok(v) => ok(json!(v)),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("recovery", "planFanoutRecoveryScan") => {
            let v = &args[0];
            let intent_in = field(v, "intent");
            let checkpoint_in = field(v, "checkpoint");
            let intent = recovery::FanoutIntentRowData {
                fanout_id: recovery::U16(text(field(intent_in, "fanoutId"))),
                members: field(intent_in, "members")
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| recovery::U16(text(x)))
                    .collect(),
            };
            let checkpoint = recovery::FanoutCheckpointRowData {
                fanout_id: recovery::U16(text(field(checkpoint_in, "fanoutId"))),
                completed: field(checkpoint_in, "completed")
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| recovery::U16(text(x)))
                    .collect(),
                cursor: {
                    let f = field(checkpoint_in, "cursor");
                    if f.is_null() {
                        None
                    } else {
                        Some(recovery::U16(text(f)))
                    }
                },
            };
            let rows_in: Vec<recovery::FanoutRecoverableRow> = field(v, "rows")
                .as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    let child = field(r, "child");
                    let lifecycle_in = field(r, "lifecycle");
                    recovery::FanoutRecoverableRow {
                        child: recovery::FanoutChildRowData {
                            fanout_id: recovery::U16(text(field(child, "fanoutId"))),
                            child_id: recovery::U16(text(field(child, "childId"))),
                            record_id: recovery::U16(text(field(child, "recordId"))),
                            state: recovery::U16(text(field(child, "state"))),
                            attempts: number(field(child, "attempts")),
                        },
                        claimed_at_ms: opt_num(field(r, "claimedAtMs")),
                        guard_verdict: opt_bool(field(r, "guardVerdict")),
                        first_attempt_at_ms: opt_num(field(r, "firstAttemptAtMs")),
                        lifecycle: recovery::FanoutChildLifecycle {
                            status: recovery::U16(text(field(lifecycle_in, "status"))),
                            reason: {
                                let f = field(lifecycle_in, "reason");
                                if f.is_null() {
                                    None
                                } else {
                                    Some(recovery::U16(text(f)))
                                }
                            },
                        },
                    }
                })
                .collect();
            let input = recovery::FanoutRecoveryScanInput {
                fanout_id: recovery::U16(text(field(v, "fanoutId"))),
                intent,
                checkpoint,
                rows: rows_in,
                now_ms: number(field(v, "nowMs")),
                max_claim_age_ms: number(field(v, "maxClaimAgeMs")),
                policy: recovery_policy(field(v, "policy")),
            };
            match recovery::plan_fanout_recovery_scan(&input) {
                Ok(plan) => ok(object(vec![
                    (
                        "resume",
                        json!(plan.resume.iter().map(|x| string(&x.0)).collect::<Vec<_>>()),
                    ),
                    (
                        "skipped",
                        json!(plan
                            .skipped
                            .iter()
                            .map(|x| object(vec![
                                ("childId", string(&x.child_id.0)),
                                ("reason", string(&x.reason.0)),
                            ]))
                            .collect::<Vec<_>>()),
                    ),
                    (
                        "dead",
                        json!(plan.dead.iter().map(|x| string(&x.0)).collect::<Vec<_>>()),
                    ),
                    (
                        "failed",
                        json!(plan
                            .failed
                            .iter()
                            .map(|x| object(vec![
                                ("childId", string(&x.child_id.0)),
                                ("reason", string(&x.reason.0)),
                            ]))
                            .collect::<Vec<_>>()),
                    ),
                    (
                        "admit",
                        json!(plan.admit.iter().map(|x| string(&x.0)).collect::<Vec<_>>()),
                    ),
                    (
                        "uncertain",
                        json!(plan
                            .uncertain
                            .iter()
                            .map(|x| string(&x.0))
                            .collect::<Vec<_>>()),
                    ),
                    (
                        "phantoms",
                        json!(plan
                            .phantoms
                            .iter()
                            .map(|x| string(&x.0))
                            .collect::<Vec<_>>()),
                    ),
                    (
                        "checkpointGaps",
                        json!(plan
                            .checkpoint_gaps
                            .iter()
                            .map(|x| string(&x.0))
                            .collect::<Vec<_>>()),
                    ),
                    ("finishEnumeration", json!(plan.finish_enumeration)),
                ])),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("recovery", "assertKnownProgressRelation") => {
            let caller = ascii(&args[1]);
            if args[0].get("$u16").is_some() {
                match recovery::assert_known_progress_relation(
                    &recovery::U16(text(&args[0])),
                    &caller,
                ) {
                    Ok(v) => ok(string(&v.0)),
                    Err(e) => fault(&e.name, &e.message, None, None),
                }
            } else {
                // Non-text relation: the donor refuses before any lookup.
                fault(
                    "TypeError",
                    &format!(
                        "{caller}: relation must be a non-empty T13 delivery-observable target"
                    ),
                    None,
                    None,
                )
            }
        }
        ("recovery", "planRelatedProgressResume") => {
            let v = &args[0];
            let rows_in: Vec<recovery::RelatedProgressRowView> = field(v, "rows")
                .as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    let association = field(r, "association");
                    let receipt_in = field(r, "receipt");
                    recovery::RelatedProgressRowView {
                        relation: recovery::U16(text(field(r, "relation"))),
                        association: recovery::ResumeAssociation {
                            delivery_id: recovery::U16(text(field(association, "deliveryId"))),
                            revision: number(field(association, "revision")),
                        },
                        receipt: recovery::ResumeReceipt {
                            delivery_id: recovery::U16(text(field(receipt_in, "deliveryId"))),
                            revision: number(field(receipt_in, "revision")),
                            status: recovery::U16(text(field(receipt_in, "status"))),
                        },
                    }
                })
                .collect();
            let input = recovery::RelatedProgressResumeInput {
                relation: recovery::U16(text(field(v, "relation"))),
                rows: rows_in,
            };
            match recovery::plan_related_progress_resume(&input) {
                Ok(plan) => ok(object(vec![
                    ("relation", string(&plan.relation.0)),
                    (
                        "resume",
                        json!(plan.resume.iter().map(|x| string(&x.0)).collect::<Vec<_>>()),
                    ),
                    (
                        "settled",
                        json!(plan
                            .settled
                            .iter()
                            .map(|x| string(&x.0))
                            .collect::<Vec<_>>()),
                    ),
                ])),
                Err(e) => fault(&e.name, &e.message, None, None),
            }
        }
        ("rows", "withRowData") => {
            match rows::with_row_data(
                &rows_row(&args[0]),
                &rows_value(&args[1]),
                &rows_meta(&args[2]),
                &ascii(&args[3]),
            ) {
                Ok(v) => ok(rows_stored_observe(&v)),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("rows", "withFanoutRowData") => {
            match rows::with_fanout_row_data(
                &rows_row(&args[0]),
                &rows_value(&args[1]),
                &rows_meta(&args[2]),
            ) {
                Ok(v) => ok(rows_stored_observe(&v)),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("linkage", "assertFanoutChildJoin") => {
            match linkage::assert_fanout_child_join(&linkage_batch(&args[0])) {
                Ok(()) => ok(json!({"$undefined":true})),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        ("linkage", "assertReceiptJoin") => {
            match linkage::assert_receipt_join(&linkage_batch(&args[0])) {
                Ok(()) => ok(json!({"$undefined":true})),
                Err(e) => fault(&e.name, &e.message, e.code.as_deref(), None),
            }
        }
        _ => panic!("unregistered finite observer case"),
    };
    json!({"key":c["key"],"outcome":outcome,"randomCalls":calls.get()})
}
