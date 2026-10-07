//! W04.3 — Native recovery decisions.
//!
//! Data-only Rust port of `src/recovery.ts`, proven against the same
//! independent TS oracle corpus (`conformance/fixtures/receipts/recovery.json`).
//! N03 replaces standalone rustc testing with an isolated private Cargo project
//! containing exact copies of this file and numeric_text.rs; ryu-js =1.0.3,
//! default features off. Run original embedded vectors and immutable witnesses.
//! Official product dependency/root registration remains pending. The small shared prelude
//! (UTF-16 text, passthrough data values, retry policy vocabulary,
//! JSON string quoting) is duplicated per decisions file until W04.4
//! assembly consolidates it. Suppliers, resolvers and evidence lookups
//! arrive injected; scans decide purely from them and write nothing.

use super::numeric_text::string as js_num;

use std::collections::HashMap;

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
}

impl std::fmt::Debug for U16 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("\"")?;
        for u in self.0.iter() {
            f.write_str(&char::from_u32(*u as u32).unwrap_or('\u{FFFD}').to_string())?;
        }
        f.write_str("\"")
    }
}

/// Passthrough data: compared structurally, never inspected.
#[derive(Clone, Debug)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(U16),
    Arr(Vec<Value>),
    Obj(Vec<(U16, Value)>),
}

impl PartialEq for Value {
    fn eq(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Null, Value::Null) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::Num(a), Value::Num(b)) => a.to_bits() == b.to_bits(),
            (Value::Str(a), Value::Str(b)) => a == b,
            (Value::Arr(a), Value::Arr(b)) => a == b,
            (Value::Obj(a), Value::Obj(b)) => a == b,
            _ => false,
        }
    }
}

/// `JSON.stringify` for the string sites the donor interpolates into
/// failure text (ids, states, lifecycle tags, relations). Corpus pins
/// strings only; the full value renderer consolidates at W04.4.
fn js_quote(units: &[u16]) -> String {
    let mut out = String::from("\"");
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
            0x00..=0x1F => out.push_str(&format!("\\u{:04x}", u)),
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
            0xDC00..0xE000 => out.push_str(&format!("\\u{:04x}", u)),
            _ => out.push(char::from_u32(u as u32).unwrap_or('\u{FFFD}')),
        }
        i += 1;
    }
    out.push('"');
    out
}

/// Parity error: name/message match the TS donor.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RecoveryError {
    pub name: String,
    pub message: String,
}

fn plain_error(message: String) -> RecoveryError {
    RecoveryError {
        name: "Error".to_string(),
        message,
    }
}

fn range_error(message: String) -> RecoveryError {
    RecoveryError {
        name: "RangeError".to_string(),
        message,
    }
}

/// Retry budget: attempt cap plus horizon in milliseconds.
#[derive(Clone, PartialEq, Debug)]
pub struct RetryPolicy {
    pub max_attempts: f64,
    pub horizon_ms: f64,
}

pub const DEFAULT_MAX_ATTEMPTS: f64 = 8.0;
pub const DEFAULT_HORIZON_MS: f64 = 86_400_000.0;

pub fn default_retry_policy() -> RetryPolicy {
    RetryPolicy {
        max_attempts: DEFAULT_MAX_ATTEMPTS,
        horizon_ms: DEFAULT_HORIZON_MS,
    }
}

/// Classified failure cause entering the kernel.
#[derive(Clone, PartialEq, Debug)]
pub enum FailureCause {
    HandlerRequireFalse { require: U16 },
    Permanent { code: U16, message: U16 },
    Transient { code: U16, message: U16 },
}

/** A false authored `require` and permanent errors are terminal. */
pub fn classify_failure(cause: &FailureCause) -> U16 {
    match cause {
        FailureCause::Transient { .. } => U16::from_utf8("transient"),
        _ => U16::from_utf8("terminal"),
    }
}

/// Policy guard with the donor's per-callsite `what` prefix.
pub fn assert_retry_policy(policy: &RetryPolicy, what: &str) -> Result<(), RecoveryError> {
    if policy.max_attempts.fract() != 0.0 || policy.max_attempts < 1.0 {
        return Err(range_error(format!(
            "{what}: policy.maxAttempts must be an integer >= 1"
        )));
    }
    if !policy.horizon_ms.is_finite() || policy.horizon_ms <= 0.0 {
        return Err(range_error(format!(
            "{what}: policy.horizonMs must be finite and > 0"
        )));
    }
    Ok(())
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

/// Proof of what the provider did for an uncertain item.
#[derive(Clone, PartialEq, Debug)]
pub enum ReconcileEvidence {
    Delivered { result: Value },
    Failed { code: U16, message: U16 },
    NotFound,
}

/** True exactly for the terminal receipt states. */
pub fn is_terminal_receipt_status(status: &U16) -> bool {
    status.eq_ascii("succeeded") || status.eq_ascii("failed") || status.eq_ascii("skipped")
}

pub struct InventoryInput<'a> {
    pub outbox_items: &'a [OutboxItem],
    pub due_occurrences: &'a [Value],
    /** Commit instant (UTC epoch ms) per outbox id; null when unknown. */
    pub committed_at_ms: &'a dyn Fn(&U16) -> Option<f64>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct PendingWorkInventory {
    pub outbox_pending: f64,
    pub outbox_claimed: f64,
    pub outbox_uncertain: f64,
    pub outbox_dead: f64,
    pub due_occurrences: f64,
    pub oldest_uncertain_at: Option<f64>,
}

/** Build the pending-work inventory: counts plus oldest uncertain commit. */
pub fn build_inventory(input: &InventoryInput) -> PendingWorkInventory {
    let mut outbox_pending = 0.0;
    let mut outbox_claimed = 0.0;
    let mut outbox_uncertain = 0.0;
    let mut outbox_dead = 0.0;
    let mut oldest_uncertain_at: Option<f64> = None;
    for item in input.outbox_items.iter() {
        if item.state.eq_ascii("pending") {
            outbox_pending += 1.0;
        } else if item.state.eq_ascii("claimed") {
            outbox_claimed += 1.0;
        } else if item.state.eq_ascii("uncertain") {
            outbox_uncertain += 1.0;
            if let Some(committed) = (input.committed_at_ms)(&item.id) {
                if committed.is_finite()
                    && oldest_uncertain_at.map(|o| committed < o).unwrap_or(true)
                {
                    oldest_uncertain_at = Some(committed);
                }
            }
        } else if item.state.eq_ascii("dead") {
            outbox_dead += 1.0;
        }
    }
    PendingWorkInventory {
        outbox_pending,
        outbox_claimed,
        outbox_uncertain,
        outbox_dead,
        due_occurrences: input.due_occurrences.len() as f64,
        oldest_uncertain_at,
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct WorkInventoryItem {
    pub intent_id: U16,
    pub handler_contract: U16,
    pub state: U16,
}

pub struct WorkInventoryInput<'a> {
    /** Live outbox snapshot; terminal items are omitted, never reported. */
    pub outbox_items: &'a [OutboxItem],
    /**
     * Handler-contract vocabulary for the deployment: must return the same
     * strings the migration plan pins in `invalidate` directives.
     */
    pub handler_contract_for: &'a dyn Fn(&OutboxItem) -> Option<U16>,
}

/**
 * Enumerate live outbox work as L3 `WorkInventoryItem`s for the
 * upgrade-orchestrator inventory gate. Output is intent-id sorted for
 * stable evidence. This builder never emits `accepted`.
 */
pub fn build_work_inventory(
    input: &WorkInventoryInput,
) -> Result<Vec<WorkInventoryItem>, RecoveryError> {
    let mut items: Vec<WorkInventoryItem> = Vec::new();
    let mut unmapped: Vec<U16> = Vec::new();
    for item in input.outbox_items.iter() {
        if item.state.eq_ascii("delivered")
            || item.state.eq_ascii("failed")
            || item.state.eq_ascii("dead")
        {
            continue;
        }
        let state = if item.state.eq_ascii("pending") {
            U16::from_utf8("undispatched")
        } else if item.state.eq_ascii("claimed") {
            U16::from_utf8("inflight")
        } else if item.state.eq_ascii("uncertain") {
            U16::from_utf8("uncertain")
        } else {
            return Err(plain_error(format!(
                "buildWorkInventory: item {} has unknown state {}.",
                js_quote(&item.id.0),
                js_quote(&item.state.0)
            )));
        };
        match (input.handler_contract_for)(item) {
            Some(contract) if !contract.is_empty() => {
                items.push(WorkInventoryItem {
                    intent_id: item.id.clone(),
                    handler_contract: contract,
                    state,
                });
            }
            _ => unmapped.push(item.id.clone()),
        }
    }
    if !unmapped.is_empty() {
        unmapped.sort();
        let ids = unmapped
            .iter()
            .map(|id| js_quote(&id.0))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(plain_error(format!(
            "buildWorkInventory: no handler-contract mapping for {ids} \
             (the assembly must supply the deployment vocabulary)."
        )));
    }
    items.sort_by(|a, b| a.intent_id.cmp(&b.intent_id));
    Ok(items)
}

/** One supplier page: rows plus the opaque resume cursor, if more remain. */
#[derive(Clone, PartialEq, Debug)]
pub struct DueScanPage<T> {
    pub rows: Vec<T>,
    pub next_cursor: Option<U16>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct DueScanResult<T> {
    pub rows: Vec<T>,
    pub next_cursor: Option<U16>,
    /** False means unreturned rows remain: resume with `next_cursor`. */
    pub done: bool,
}

/**
 * Fetch one bounded due-work batch. Over-delivery (more rows than the limit)
 * throws loudly; a missing cursor with remaining rows is a supplier contract
 * violation the caller cannot detect, so suppliers must always set it.
 */
pub fn scan_due_batch<T: Clone>(
    supplier: &dyn Fn(Option<&U16>, f64) -> DueScanPage<T>,
    cursor: Option<&U16>,
    limit: f64,
) -> Result<DueScanResult<T>, RecoveryError> {
    if limit.fract() != 0.0 || limit < 1.0 {
        return Err(range_error(
            "scanDueBatch: limit must be an integer >= 1".to_string(),
        ));
    }
    let page = supplier(cursor, limit);
    if (page.rows.len() as f64) > limit {
        return Err(range_error(format!(
            "scanDueBatch: supplier over-delivered {} rows for limit {}",
            page.rows.len(),
            limit as i64
        )));
    }
    let next_cursor = page.next_cursor.clone();
    let done = next_cursor.is_none();
    Ok(DueScanResult {
        rows: page.rows.clone(),
        next_cursor,
        done,
    })
}

#[derive(Clone, PartialEq, Debug)]
pub struct DrainDueScanResult<T> {
    pub rows: Vec<T>,
    pub next_cursor: Option<U16>,
    pub done: bool,
    pub batches: f64,
}

/**
 * Drain due rows up to `max_batches` batches. Never silently truncates: when
 * the cap stops the drain, `done` is false and `next_cursor` resumes exactly
 * where it stopped.
 */
pub fn drain_due_scan<T: Clone>(
    supplier: &dyn Fn(Option<&U16>, f64) -> DueScanPage<T>,
    limit: f64,
    max_batches: f64,
    start_cursor: Option<U16>,
) -> Result<DrainDueScanResult<T>, RecoveryError> {
    if max_batches.fract() != 0.0 || max_batches < 1.0 {
        return Err(range_error(
            "drainDueScan: maxBatches must be an integer >= 1".to_string(),
        ));
    }
    let mut rows: Vec<T> = Vec::new();
    let mut cursor: Option<U16> = start_cursor;
    let mut batches = 0.0;
    loop {
        let page = scan_due_batch(supplier, cursor.as_ref(), limit)?;
        batches += 1.0;
        rows.extend(page.rows.iter().cloned());
        cursor = page.next_cursor.clone();
        if page.done || batches >= max_batches {
            return Ok(DrainDueScanResult {
                rows,
                next_cursor: cursor,
                done: page.done,
                batches,
            });
        }
    }
}

/// One recorded dispatch claim.
#[derive(Clone, PartialEq, Debug)]
pub struct DispatchClaim {
    pub outbox_id: U16,
    pub claim_id: U16,
    pub claimed_at: f64,
}

/** A claim is stale once its age reaches the max age (boundary inclusive). */
pub fn is_claim_stale(
    claim: &DispatchClaim,
    now_ms: f64,
    max_claim_age_ms: f64,
) -> Result<bool, RecoveryError> {
    if !now_ms.is_finite() || now_ms < 0.0 {
        return Err(range_error(
            "isClaimStale: nowMs must be finite and >= 0".to_string(),
        ));
    }
    if !max_claim_age_ms.is_finite() || max_claim_age_ms < 0.0 {
        return Err(range_error(
            "isClaimStale: maxClaimAgeMs must be finite and >= 0".to_string(),
        ));
    }
    Ok(claim.claimed_at + max_claim_age_ms <= now_ms)
}

/** Stale claims in stable claim-id order. */
pub fn find_stale_claims(
    claims: &[DispatchClaim],
    now_ms: f64,
    max_claim_age_ms: f64,
) -> Result<Vec<DispatchClaim>, RecoveryError> {
    let mut out: Vec<DispatchClaim> = Vec::new();
    for claim in claims.iter() {
        if is_claim_stale(claim, now_ms, max_claim_age_ms)? {
            out.push(claim.clone());
        }
    }
    out.sort_by(|a, b| a.claim_id.cmp(&b.claim_id));
    Ok(out)
}

#[derive(Clone, PartialEq, Debug)]
pub struct ReleaseStaleResult {
    /** Items with stale-claim releases applied (`claimed` -> `pending`). */
    pub items: Vec<OutboxItem>,
    /** Released item ids in stable order. */
    pub released_ids: Vec<U16>,
}

/**
 * Release claimed items whose recorded claim is stale back to `pending` so
 * recovery can re-drive them. Items without a recorded claim stay claimed;
 * non-claimed items are untouched. Duplicate claims resolve last-wins.
 */
pub fn release_stale_claims(
    outbox_items: &[OutboxItem],
    claims: &[DispatchClaim],
    now_ms: f64,
    max_claim_age_ms: f64,
) -> Result<ReleaseStaleResult, RecoveryError> {
    let mut by_outbox: HashMap<&U16, &DispatchClaim> = HashMap::new();
    for claim in claims.iter() {
        by_outbox.insert(&claim.outbox_id, claim);
    }
    let mut items: Vec<OutboxItem> = Vec::new();
    let mut released_ids: Vec<U16> = Vec::new();
    for item in outbox_items.iter() {
        let claim = if item.state.eq_ascii("claimed") {
            by_outbox.get(&item.id).copied()
        } else {
            None
        };
        match claim {
            Some(c) if is_claim_stale(c, now_ms, max_claim_age_ms)? => {
                let mut next = item.clone();
                next.state = U16::from_utf8("pending");
                items.push(next);
                released_ids.push(item.id.clone());
            }
            _ => items.push(item.clone()),
        }
    }
    released_ids.sort();
    Ok(ReleaseStaleResult {
        items,
        released_ids,
    })
}

/// Staging-layer disposition for one recorded failure.
pub type StagingDisposition = U16;

pub struct RecordStagingFailureInput {
    /** Live item (`pending` or `claimed`); anything else throws. */
    pub item: OutboxItem,
    pub cause: FailureCause,
    pub now_ms: f64,
    pub first_attempt_at_ms: f64,
    pub policy: Option<RetryPolicy>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct RecordedStagingFailure {
    pub item: OutboxItem,
    pub disposition: StagingDisposition,
    pub retry_class: U16,
    pub retryable: bool,
}

pub fn record_staging_failure(
    input: &RecordStagingFailureInput,
) -> Result<RecordedStagingFailure, RecoveryError> {
    if !input.item.state.eq_ascii("pending") && !input.item.state.eq_ascii("claimed") {
        let mut message = String::from("recordStagingFailure: item ");
        for u in input.item.id.0.iter() {
            message.push(char::from_u32(*u as u32).unwrap_or('\u{FFFD}'));
        }
        message.push_str(" is ");
        for u in input.item.state.0.iter() {
            message.push(char::from_u32(*u as u32).unwrap_or('\u{FFFD}'));
        }
        message.push_str("; failures apply to pending/claimed items only");
        return Err(plain_error(message));
    }
    if !input.now_ms.is_finite() || input.now_ms < 0.0 {
        return Err(range_error(
            "recordStagingFailure: nowMs must be finite and >= 0".to_string(),
        ));
    }
    if !input.first_attempt_at_ms.is_finite() || input.first_attempt_at_ms < 0.0 {
        return Err(range_error(
            "recordStagingFailure: firstAttemptAtMs must be finite and >= 0".to_string(),
        ));
    }
    let policy = input.policy.clone().unwrap_or_else(default_retry_policy);
    assert_retry_policy(&policy, "recordStagingFailure")?;
    let retry_class = classify_failure(&input.cause);
    let attempts = input.item.attempts + 1.0;
    if retry_class.eq_ascii("terminal") {
        let mut item = input.item.clone();
        item.attempts = attempts;
        item.state = U16::from_utf8("failed");
        return Ok(RecordedStagingFailure {
            item,
            disposition: U16::from_utf8("terminal"),
            retry_class,
            retryable: false,
        });
    }
    if attempts >= policy.max_attempts
        || input.now_ms - input.first_attempt_at_ms >= policy.horizon_ms
    {
        let mut item = input.item.clone();
        item.attempts = attempts;
        item.state = U16::from_utf8("dead");
        return Ok(RecordedStagingFailure {
            item,
            disposition: U16::from_utf8("dead"),
            retry_class,
            retryable: false,
        });
    }
    let mut item = input.item.clone();
    item.attempts = attempts;
    item.state = U16::from_utf8("pending");
    Ok(RecordedStagingFailure {
        item,
        disposition: U16::from_utf8("retry"),
        retry_class,
        retryable: true,
    })
}

/**
 * One row entering the recovery scan: the outbox item plus the
 * dispatch-row fields the scan decides on.
 */
pub struct RecoverableRow {
    pub item: OutboxItem,
    /** Last guard verdict; false pins the item undispatched (skipped). */
    pub guard_verdict: Option<bool>,
    /** First provider-attempt start, if any attempt has run. */
    pub first_attempt_at_ms: Option<f64>,
    /** Recorded classification; only `failed` rows carry one. */
    pub retry_class: Option<U16>,
}

pub struct RecoveryScanInput<'a> {
    pub rows: &'a [RecoverableRow],
    /** Recorded claims by outbox id (the rows' current claim, if any). */
    pub claims: &'a [DispatchClaim],
    /**
     * Reconcile evidence lookup for uncertain rows: proof of what the
     * provider did, or null when unknown (unknown stays unknown).
     */
    pub evidence: &'a dyn Fn(&U16) -> Option<ReconcileEvidence>,
    pub now_ms: f64,
    pub max_claim_age_ms: f64,
    pub policy: Option<RetryPolicy>,
}

/**
 * Recovery plan: every actionable row lands in exactly one list; rows
 * needing no action appear in none. All lists are id-sorted.
 */
#[derive(Clone, PartialEq, Debug)]
pub struct RecoveryPlan {
    /** Stale-claim rows to release back to `pending` for re-drive. */
    pub resume: Vec<U16>,
    /** Retryable rows: failed-transient within budget, uncertain not-found. */
    pub retry: Vec<U16>,
    /** Uncertain rows with decisive delivered/failed evidence to reconcile. */
    pub reconcile: Vec<U16>,
    /** Uncertain rows without evidence: untouched until evidence arrives. */
    pub awaiting: Vec<U16>,
    /** Guard-false pinned rows: never dispatched, listed never silent. */
    pub skipped: Vec<U16>,
    /** Failed-terminal (or unclassified) rows: final, never retried. */
    pub terminal: Vec<U16>,
    /** Failed-transient rows past budget: dead-letter via requeue. */
    pub dead: Vec<U16>,
}

/** Plan one bounded recovery scan over dispatch-row views. */
pub fn plan_recovery_scan(input: &RecoveryScanInput) -> Result<RecoveryPlan, RecoveryError> {
    if !input.now_ms.is_finite() || input.now_ms < 0.0 {
        return Err(range_error(
            "planRecoveryScan: nowMs must be finite and >= 0".to_string(),
        ));
    }
    if !input.max_claim_age_ms.is_finite() || input.max_claim_age_ms < 0.0 {
        return Err(range_error(
            "planRecoveryScan: maxClaimAgeMs must be finite and >= 0".to_string(),
        ));
    }
    let policy = input.policy.clone().unwrap_or_else(default_retry_policy);
    assert_retry_policy(&policy, "planRecoveryScan")?;
    let mut by_outbox: HashMap<&U16, &DispatchClaim> = HashMap::new();
    for claim in input.claims.iter() {
        by_outbox.insert(&claim.outbox_id, claim);
    }
    let mut resume: Vec<U16> = Vec::new();
    let mut retry: Vec<U16> = Vec::new();
    let mut reconcile: Vec<U16> = Vec::new();
    let mut awaiting: Vec<U16> = Vec::new();
    let mut skipped: Vec<U16> = Vec::new();
    let mut terminal: Vec<U16> = Vec::new();
    let mut dead: Vec<U16> = Vec::new();
    for row in input.rows.iter() {
        let item = &row.item;
        if item.state.eq_ascii("pending") {
            if row.guard_verdict == Some(false) {
                skipped.push(item.id.clone());
            }
        } else if item.state.eq_ascii("claimed") {
            if let Some(claim) = by_outbox.get(&item.id) {
                if is_claim_stale(claim, input.now_ms, input.max_claim_age_ms)? {
                    resume.push(item.id.clone());
                }
            }
        } else if item.state.eq_ascii("failed") {
            match &row.retry_class {
                Some(c) if c.eq_ascii("transient") => {
                    let horizon_exceeded = row
                        .first_attempt_at_ms
                        .map(|first| input.now_ms - first >= policy.horizon_ms)
                        .unwrap_or(false);
                    if item.attempts >= policy.max_attempts || horizon_exceeded {
                        dead.push(item.id.clone());
                    } else {
                        retry.push(item.id.clone());
                    }
                }
                _ => terminal.push(item.id.clone()),
            }
        } else if item.state.eq_ascii("uncertain") {
            match (input.evidence)(&item.id) {
                None => awaiting.push(item.id.clone()),
                Some(ReconcileEvidence::NotFound) => retry.push(item.id.clone()),
                Some(_) => reconcile.push(item.id.clone()),
            }
        }
    }
    resume.sort();
    retry.sort();
    reconcile.sort();
    awaiting.sort();
    skipped.sort();
    terminal.sort();
    dead.sort();
    Ok(RecoveryPlan {
        resume,
        retry,
        reconcile,
        awaiting,
        skipped,
        terminal,
        dead,
    })
}

/* -- Fanout recovery + enumeration resume. -- */

/**
 * Current lifecycle lookup for one admitted child. `deleted` is
 * DEMONSTRABLE deletion only; `unknown` carries its closed failed
 * reason and can never masquerade as deletion. The status stays an
 * open string so unknown lookups fail loudly with the pinned text.
 */
#[derive(Clone, PartialEq, Debug)]
pub struct FanoutChildLifecycle {
    pub status: U16,
    pub reason: Option<U16>,
}

/// The scan's view of one child row (the five fields the scan reads).
#[derive(Clone, PartialEq, Debug)]
pub struct FanoutChildRowData {
    pub fanout_id: U16,
    pub child_id: U16,
    pub record_id: U16,
    pub state: U16,
    pub attempts: f64,
}

/// The scan's view of one intent row (identity plus the frozen set).
#[derive(Clone, PartialEq, Debug)]
pub struct FanoutIntentRowData {
    pub fanout_id: U16,
    pub members: Vec<U16>,
}

/// The scan's view of one checkpoint row (identity, cover, cursor).
#[derive(Clone, PartialEq, Debug)]
pub struct FanoutCheckpointRowData {
    pub fanout_id: U16,
    pub completed: Vec<U16>,
    pub cursor: Option<U16>,
}

/** One child row entering the fanout recovery scan. */
pub struct FanoutRecoverableRow {
    /** Child row data (caller reads via `readFanoutChildRow`). */
    pub child: FanoutChildRowData,
    /**
     * Claim instant (UTC epoch ms): the running row's `updated` stamp.
     * Null when unclaimed or unknown.
     */
    pub claimed_at_ms: Option<f64>,
    /**
     * Current guard re-evaluation against current state; false pins the
     * child undispatched (skipped/non-applicable).
     */
    pub guard_verdict: Option<bool>,
    /** First-attempt anchor for the retry horizon; null when none ran. */
    pub first_attempt_at_ms: Option<f64>,
    /** Current lifecycle lookup (read-only membership-producer view). */
    pub lifecycle: FanoutChildLifecycle,
}

pub struct FanoutRecoveryScanInput {
    /** Fanout under recovery; intent, checkpoint and rows must carry it. */
    pub fanout_id: U16,
    pub intent: FanoutIntentRowData,
    pub checkpoint: FanoutCheckpointRowData,
    /** Drained child-row views for this fanout. */
    pub rows: Vec<FanoutRecoverableRow>,
    pub now_ms: f64,
    pub max_claim_age_ms: f64,
    pub policy: Option<RetryPolicy>,
}

/** Record terminal `skipped` with its closed reason (attempts unchanged). */
#[derive(Clone, PartialEq, Debug)]
pub struct FanoutSkippedAction {
    pub child_id: U16,
    pub reason: U16,
}

/** Record terminal `failed` with its closed reason (attempts + 1). */
#[derive(Clone, PartialEq, Debug)]
pub struct FanoutFailedAction {
    pub child_id: U16,
    pub reason: U16,
}

/**
 * Fanout recovery plan: every actionable row lands in exactly one
 * action list. Terminal child rows NEVER appear in any action list.
 */
#[derive(Clone, PartialEq, Debug)]
pub struct FanoutRecoveryPlan {
    /** Running + stale within budget: release to pending for re-drive. */
    pub resume: Vec<U16>,
    /** Deleted / guard-false: record terminal skipped (attempts unchanged). */
    pub skipped: Vec<FanoutSkippedAction>,
    /** Running + stale + exhausted: record terminal failed/exhausted. */
    pub dead: Vec<U16>,
    /** Unknown lookup/authority: record terminal failed (never deleted). */
    pub failed: Vec<FanoutFailedAction>,
    /** Frozen members with no child row and no completion: admit. */
    pub admit: Vec<U16>,
    /** Running + fresh/unproven claim: observed read-only, never touched. */
    pub uncertain: Vec<U16>,
    /** Rows outside the frozen member set: attention, never driven. */
    pub phantoms: Vec<U16>,
    /** Completions without a terminal row: attention, never re-touched. */
    pub checkpoint_gaps: Vec<U16>,
    /**
     * True only when the cursor is non-null yet enumeration is provably
     * complete (nothing to admit, no gaps).
     */
    pub finish_enumeration: bool,
}

/** A fanout claim is stale once its age reaches the max age (boundary inclusive). */
pub fn is_fanout_claim_stale(
    claimed_at_ms: f64,
    now_ms: f64,
    max_claim_age_ms: f64,
) -> Result<bool, RecoveryError> {
    if !claimed_at_ms.is_finite() || claimed_at_ms < 0.0 {
        return Err(range_error(
            "isFanoutClaimStale: claimedAtMs must be finite and >= 0".to_string(),
        ));
    }
    if !now_ms.is_finite() || now_ms < 0.0 {
        return Err(range_error(
            "isFanoutClaimStale: nowMs must be finite and >= 0".to_string(),
        ));
    }
    if !max_claim_age_ms.is_finite() || max_claim_age_ms < 0.0 {
        return Err(range_error(
            "isFanoutClaimStale: maxClaimAgeMs must be finite and >= 0".to_string(),
        ));
    }
    Ok(claimed_at_ms + max_claim_age_ms <= now_ms)
}

/**
 * Exhaustion on RECORDED attempts: the cap is reached, or the anchored
 * horizon elapsed. A null first-attempt anchor checks attempts only
 * (the horizon never started).
 */
pub fn is_fanout_child_exhausted(
    attempts: f64,
    first_attempt_at_ms: Option<f64>,
    now_ms: f64,
    policy: &RetryPolicy,
) -> Result<bool, RecoveryError> {
    if attempts.fract() != 0.0 || attempts < 0.0 {
        return Err(range_error(
            "isFanoutChildExhausted: attempts must be an integer >= 0".to_string(),
        ));
    }
    match first_attempt_at_ms {
        Some(first) if !first.is_finite() || first < 0.0 => {
            return Err(range_error(
                "isFanoutChildExhausted: firstAttemptAtMs must be finite and >= 0".to_string(),
            ));
        }
        _ => (),
    }
    if !now_ms.is_finite() || now_ms < 0.0 {
        return Err(range_error(
            "isFanoutChildExhausted: nowMs must be finite and >= 0".to_string(),
        ));
    }
    assert_retry_policy(policy, "isFanoutChildExhausted")?;
    Ok(attempts >= policy.max_attempts
        || first_attempt_at_ms
            .map(|first| now_ms - first >= policy.horizon_ms)
            .unwrap_or(false))
}

/** Plan one recovery scan over a drained fanout row set. One fanout per call. */
pub fn plan_fanout_recovery_scan(
    input: &FanoutRecoveryScanInput,
) -> Result<FanoutRecoveryPlan, RecoveryError> {
    if input.fanout_id.is_empty() {
        return Err(plain_error(
            "planFanoutRecoveryScan: fanoutId must be a non-empty string.".to_string(),
        ));
    }
    if input.intent.fanout_id != input.fanout_id {
        return Err(plain_error(
            "planFanoutRecoveryScan: intent carries a different fanoutId.".to_string(),
        ));
    }
    if input.checkpoint.fanout_id != input.fanout_id {
        return Err(plain_error(
            "planFanoutRecoveryScan: checkpoint carries a different fanoutId.".to_string(),
        ));
    }
    if !input.now_ms.is_finite() || input.now_ms < 0.0 {
        return Err(range_error(
            "planFanoutRecoveryScan: nowMs must be finite and >= 0".to_string(),
        ));
    }
    if !input.max_claim_age_ms.is_finite() || input.max_claim_age_ms < 0.0 {
        return Err(range_error(
            "planFanoutRecoveryScan: maxClaimAgeMs must be finite and >= 0".to_string(),
        ));
    }
    let policy = input.policy.clone().unwrap_or_else(default_retry_policy);
    assert_retry_policy(&policy, "planFanoutRecoveryScan")?;
    let mut resume: Vec<U16> = Vec::new();
    let mut skipped: Vec<FanoutSkippedAction> = Vec::new();
    let mut dead: Vec<U16> = Vec::new();
    let mut failed: Vec<FanoutFailedAction> = Vec::new();
    let mut uncertain: Vec<U16> = Vec::new();
    let mut phantoms: Vec<U16> = Vec::new();
    let mut member_set: HashMap<&U16, ()> = HashMap::new();
    for member in input.intent.members.iter() {
        member_set.insert(member, ());
    }
    let mut completed_set: HashMap<&U16, ()> = HashMap::new();
    for record in input.checkpoint.completed.iter() {
        completed_set.insert(record, ());
    }
    let mut row_record_ids: HashMap<&U16, ()> = HashMap::new();
    let mut terminal_record_ids: HashMap<&U16, ()> = HashMap::new();
    for row in input.rows.iter() {
        let child = &row.child;
        if child.fanout_id != input.fanout_id {
            return Err(plain_error(
                "planFanoutRecoveryScan: child row carries a different fanoutId.".to_string(),
            ));
        }
        if !child.state.eq_ascii("pending")
            && !child.state.eq_ascii("running")
            && !child.state.eq_ascii("completed")
            && !child.state.eq_ascii("skipped")
            && !child.state.eq_ascii("failed")
        {
            return Err(plain_error(format!(
                "planFanoutRecoveryScan: child {} has unknown state {}.",
                js_quote(&child.child_id.0),
                js_quote(&child.state.0)
            )));
        }
        match row.claimed_at_ms {
            Some(claimed) if !claimed.is_finite() || claimed < 0.0 => {
                return Err(range_error(
                    "planFanoutRecoveryScan: claimedAtMs must be finite and >= 0".to_string(),
                ));
            }
            _ => (),
        }
        match row.first_attempt_at_ms {
            Some(first) if !first.is_finite() || first < 0.0 => {
                return Err(range_error(
                    "planFanoutRecoveryScan: firstAttemptAtMs must be finite and >= 0".to_string(),
                ));
            }
            _ => (),
        }
        let lifecycle = &row.lifecycle.status;
        if !lifecycle.eq_ascii("present")
            && !lifecycle.eq_ascii("deleted")
            && !lifecycle.eq_ascii("moved")
            && !lifecycle.eq_ascii("unknown")
        {
            return Err(plain_error(format!(
                "planFanoutRecoveryScan: child {} has unknown lifecycle {}.",
                js_quote(&child.child_id.0),
                js_quote(&lifecycle.0)
            )));
        }
        if row.lifecycle.status.eq_ascii("unknown")
            && !matches!(&row.lifecycle.reason, Some(r)
                if r.eq_ascii("missing-record")
                    || r.eq_ascii("inaccessible-record")
                    || r.eq_ascii("infra-read-failure"))
        {
            let shown = row.lifecycle.reason.as_ref().map(|r| js_quote(&r.0));
            return Err(plain_error(format!(
                "planFanoutRecoveryScan: child {} has unknown lifecycle reason {}.",
                js_quote(&child.child_id.0),
                shown.unwrap_or_else(|| "undefined".to_string())
            )));
        }
        row_record_ids.insert(&child.record_id, ());
        if !member_set.contains_key(&child.record_id) {
            phantoms.push(child.child_id.clone());
        }
        if child.state.eq_ascii("completed")
            || child.state.eq_ascii("skipped")
            || child.state.eq_ascii("failed")
        {
            terminal_record_ids.insert(&child.record_id, ());
            continue;
        }
        if child.state.eq_ascii("running") {
            let stale = match row.claimed_at_ms {
                Some(claimed) => {
                    is_fanout_claim_stale(claimed, input.now_ms, input.max_claim_age_ms)?
                }
                None => false,
            };
            if !stale {
                uncertain.push(child.child_id.clone());
                continue;
            }
        }
        if row.lifecycle.status.eq_ascii("deleted") {
            skipped.push(FanoutSkippedAction {
                child_id: child.child_id.clone(),
                reason: U16::from_utf8("deleted"),
            });
            continue;
        }
        if row.lifecycle.status.eq_ascii("unknown") {
            // Validated above: the reason is a known closed reason here.
            failed.push(FanoutFailedAction {
                child_id: child.child_id.clone(),
                reason: row.lifecycle.reason.clone().unwrap(),
            });
            continue;
        }
        if row.guard_verdict == Some(false) {
            skipped.push(FanoutSkippedAction {
                child_id: child.child_id.clone(),
                reason: U16::from_utf8("non-applicable"),
            });
            continue;
        }
        if child.state.eq_ascii("pending") {
            continue;
        }
        if is_fanout_child_exhausted(
            child.attempts,
            row.first_attempt_at_ms,
            input.now_ms,
            &policy,
        )? {
            dead.push(child.child_id.clone());
        } else {
            resume.push(child.child_id.clone());
        }
    }
    let mut admit: Vec<U16> = input
        .intent
        .members
        .iter()
        .filter(|member| {
            !row_record_ids.contains_key(*member) && !completed_set.contains_key(*member)
        })
        .cloned()
        .collect();
    let mut checkpoint_gaps: Vec<U16> = input
        .checkpoint
        .completed
        .iter()
        .filter(|record| !terminal_record_ids.contains_key(*record))
        .cloned()
        .collect();
    resume.sort();
    skipped.sort_by(|a, b| a.child_id.cmp(&b.child_id));
    dead.sort();
    failed.sort_by(|a, b| a.child_id.cmp(&b.child_id));
    admit.sort();
    uncertain.sort();
    phantoms.sort();
    checkpoint_gaps.sort();
    let finish_enumeration =
        input.checkpoint.cursor.is_some() && admit.is_empty() && checkpoint_gaps.is_empty();
    Ok(FanoutRecoveryPlan {
        resume,
        skipped,
        dead,
        failed,
        admit,
        uncertain,
        phantoms,
        checkpoint_gaps,
        finish_enumeration,
    })
}

/* -- Related-progress resume. -- */

/**
 * Known T26 progress-relation targets (T13a common + T13b rich
 * delivery-observable targets, in T13 declaration order).
 */
pub const T26_KNOWN_RELATION_TARGETS: [&str; 16] = [
    "std.EmailV1.send",
    "std.ErrorsV1.report",
    "std.PaymentsV1.collect",
    "std.PaymentsV1.refund",
    "std.PaymentsV1.cancel",
    "std.PaymentsV1.reconcile",
    "std.TextGenerationV1.generate",
    "std.TextGenerationV1.cancel",
    "std.TextGenerationV1.reconcile",
    "std.ImagesV1.inspect",
    "std.ImagesV1.validate",
    "std.ImagesV1.submit",
    "std.ImagesV1.cancel",
    "std.ImagesV1.reconcile",
    "std.MailboxV1.reply",
    "std.MailboxV1.reconcile",
];

/**
 * Assert a trusted relation binding: the runtime's declaration-side
 * relation for the association under correlation. Unknown relations
 * are a declaration/store bug and throw loudly.
 */
pub fn assert_known_progress_relation(relation: &U16, caller: &str) -> Result<U16, RecoveryError> {
    if relation.is_empty() {
        return Err(RecoveryError {
            name: "TypeError".to_string(),
            message: format!(
                "{caller}: relation must be a non-empty T13 delivery-observable target"
            ),
        });
    }
    if !T26_KNOWN_RELATION_TARGETS
        .iter()
        .any(|t| relation.eq_ascii(t))
    {
        return Err(range_error(format!(
            "{caller}: unknown progress relation {}",
            js_quote(&relation.0)
        )));
    }
    Ok(relation.clone())
}

/// The scan's view of one association (delivery binding + revision).
#[derive(Clone, PartialEq, Debug)]
pub struct ResumeAssociation {
    pub delivery_id: U16,
    pub revision: f64,
}

/// The scan's view of one receipt (delivery binding + status).
#[derive(Clone, PartialEq, Debug)]
pub struct ResumeReceipt {
    pub delivery_id: U16,
    pub revision: f64,
    pub status: U16,
}

/** One retained association pair entering the resume scan. */
pub struct RelatedProgressRowView {
    /** Trusted relation binding persisted with the pair. */
    pub relation: U16,
    pub association: ResumeAssociation,
    pub receipt: ResumeReceipt,
}

pub struct RelatedProgressResumeInput {
    /** Relation under resume; every row must carry it (no cross-relation scan). */
    pub relation: U16,
    pub rows: Vec<RelatedProgressRowView>,
}

/**
 * Resume plan for one relation: unfinished attempts to re-drive from
 * durable truth, terminal attempts to leave untouched.
 */
#[derive(Clone, PartialEq, Debug)]
pub struct RelatedProgressResumePlan {
    pub relation: U16,
    /** `pending`/`unknown` attempts: re-drive from durable truth. */
    pub resume: Vec<U16>,
    /** Terminal attempts: retained, never re-driven. */
    pub settled: Vec<U16>,
}

/**
 * Plan one relation's resume from retained rows. Corrupt rows (unknown
 * relation, unknown status, foreign receipt, revision skew) throw
 * loudly instead of planning around them. The scan writes nothing.
 */
pub fn plan_related_progress_resume(
    input: &RelatedProgressResumeInput,
) -> Result<RelatedProgressResumePlan, RecoveryError> {
    let caller = "planRelatedProgressResume";
    let bound = assert_known_progress_relation(&input.relation, caller)?;
    let mut resume: Vec<U16> = Vec::new();
    let mut settled: Vec<U16> = Vec::new();
    for row in input.rows.iter() {
        assert_known_progress_relation(&row.relation, caller)?;
        if row.relation != bound {
            return Err(plain_error(format!(
                "{caller}: row for {} carries relation {}, expected {}.",
                js_quote(&row.association.delivery_id.0),
                js_quote(&row.relation.0),
                js_quote(&bound.0)
            )));
        }
        let status = &row.receipt.status;
        if !status.eq_ascii("pending")
            && !status.eq_ascii("succeeded")
            && !status.eq_ascii("failed")
            && !status.eq_ascii("unknown")
            && !status.eq_ascii("skipped")
        {
            return Err(plain_error(format!(
                "{caller}: row for {} has unknown status {}.",
                js_quote(&row.association.delivery_id.0),
                js_quote(&status.0)
            )));
        }
        if row.association.delivery_id != row.receipt.delivery_id {
            return Err(plain_error(format!(
                "{caller}: receipt {} does not belong to association {}.",
                js_quote(&row.receipt.delivery_id.0),
                js_quote(&row.association.delivery_id.0)
            )));
        }
        if row.association.revision != row.receipt.revision {
            return Err(plain_error(format!(
                "{caller}: association revision {} disagrees with receipt revision {}.",
                js_num(row.association.revision),
                js_num(row.receipt.revision)
            )));
        }
        if is_terminal_receipt_status(status) {
            settled.push(row.association.delivery_id.clone());
        } else {
            resume.push(row.association.delivery_id.clone());
        }
    }
    resume.sort();
    settled.sort();
    Ok(RelatedProgressResumePlan {
        relation: bound,
        resume,
        settled,
    })
}

// W04.3 vectors: transcribed from conformance/fixtures/receipts/recovery.json
  // (sha256 b5b64fda283461e245230a668c31afb42021e0ff99b37ace58efa1e0cc897d8c); 65 cases. `$resolver`/`$supplierPages` tags
  // revive to stub lookups/suppliers in each test. The frozen file is the
  // oracle: this module is generated, never hand-edited.
#[cfg(test)]
mod vectors_recovery {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    #[test]
    fn v_inventory_mixed() {
        let committed_at_ms = |id: &U16| -> Option<f64> {
            if *id == U16::from_utf8("u1") {
                return Some(500.0);
            }
            if *id == U16::from_utf8("u2") {
                return Some(100.0);
            }
            None
        };
        let input = InventoryInput {
            outbox_items: &[
                OutboxItem {
                    id: U16::from_utf8("u1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("uncertain"),
                },
                OutboxItem {
                    id: U16::from_utf8("u2"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("uncertain"),
                },
                OutboxItem {
                    id: U16::from_utf8("p1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("pending"),
                },
                OutboxItem {
                    id: U16::from_utf8("c1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("claimed"),
                },
                OutboxItem {
                    id: U16::from_utf8("d1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("dead"),
                },
                OutboxItem {
                    id: U16::from_utf8("x1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("delivered"),
                },
            ],
            due_occurrences: &[Value::Obj(vec![]), Value::Obj(vec![])],
            committed_at_ms: &committed_at_ms,
        };
        assert_eq!(
            build_inventory(&input),
            PendingWorkInventory {
                outbox_pending: 1.0,
                outbox_claimed: 1.0,
                outbox_uncertain: 2.0,
                outbox_dead: 1.0,
                due_occurrences: 2.0,
                oldest_uncertain_at: Some(100.0)
            }
        );
    }
    #[test]
    fn v_inventory_unknown_commits() {
        let committed_at_ms = |id: &U16| -> Option<f64> {
            if *id == U16::from_utf8("u1") {
                return Some(f64::NAN);
            }
            if *id == U16::from_utf8("u2") {
                return None;
            }
            None
        };
        let input = InventoryInput {
            outbox_items: &[
                OutboxItem {
                    id: U16::from_utf8("u1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("uncertain"),
                },
                OutboxItem {
                    id: U16::from_utf8("u2"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("uncertain"),
                },
            ],
            due_occurrences: &[],
            committed_at_ms: &committed_at_ms,
        };
        assert_eq!(
            build_inventory(&input),
            PendingWorkInventory {
                outbox_pending: 0.0,
                outbox_claimed: 0.0,
                outbox_uncertain: 2.0,
                outbox_dead: 0.0,
                due_occurrences: 0.0,
                oldest_uncertain_at: None
            }
        );
    }
    #[test]
    fn v_inventory_empty() {
        let committed_at_ms = |_: &U16| -> Option<f64> { None };
        let input = InventoryInput {
            outbox_items: &[],
            due_occurrences: &[],
            committed_at_ms: &committed_at_ms,
        };
        assert_eq!(
            build_inventory(&input),
            PendingWorkInventory {
                outbox_pending: 0.0,
                outbox_claimed: 0.0,
                outbox_uncertain: 0.0,
                outbox_dead: 0.0,
                due_occurrences: 0.0,
                oldest_uncertain_at: None
            }
        );
    }
    #[test]
    fn v_work_inventory_mixed() {
        let contracts = |it: &OutboxItem| -> Option<U16> {
            if it.id == U16::from_utf8("a") {
                return Some(U16::from_utf8("ca"));
            }
            if it.id == U16::from_utf8("b") {
                return Some(U16::from_utf8("cb"));
            }
            if it.id == U16::from_utf8("u") {
                return Some(U16::from_utf8("cu"));
            }
            None
        };
        let input = WorkInventoryInput {
            outbox_items: &[
                OutboxItem {
                    id: U16::from_utf8("b"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("claimed"),
                },
                OutboxItem {
                    id: U16::from_utf8("a"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("pending"),
                },
                OutboxItem {
                    id: U16::from_utf8("u"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("uncertain"),
                },
                OutboxItem {
                    id: U16::from_utf8("s"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("delivered"),
                },
                OutboxItem {
                    id: U16::from_utf8("f"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("failed"),
                },
                OutboxItem {
                    id: U16::from_utf8("d"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("dead"),
                },
            ],
            handler_contract_for: &contracts,
        };
        assert_eq!(
            build_work_inventory(&input),
            Ok(vec![
                WorkInventoryItem {
                    intent_id: U16::from_utf8("a"),
                    handler_contract: U16::from_utf8("ca"),
                    state: U16::from_utf8("undispatched")
                },
                WorkInventoryItem {
                    intent_id: U16::from_utf8("b"),
                    handler_contract: U16::from_utf8("cb"),
                    state: U16::from_utf8("inflight")
                },
                WorkInventoryItem {
                    intent_id: U16::from_utf8("u"),
                    handler_contract: U16::from_utf8("cu"),
                    state: U16::from_utf8("uncertain")
                }
            ])
        );
    }
    #[test]
    fn v_work_inventory_unmapped() {
        let contracts = |it: &OutboxItem| -> Option<U16> {
            if it.id == U16::from_utf8("a") {
                return Some(U16::from_utf8(""));
            }
            None
        };
        let input = WorkInventoryInput {
            outbox_items: &[OutboxItem {
                id: U16::from_utf8("a"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 0.0,
                state: U16::from_utf8("pending"),
            }],
            handler_contract_for: &contracts,
        };
        assert_eq!(build_work_inventory(&input), Err(RecoveryError { name: "Error".to_string(), message: "buildWorkInventory: no handler-contract mapping for \"a\" (the assembly must supply the deployment vocabulary).".to_string() }));
    }
    #[test]
    fn v_work_inventory_unknown_state() {
        let contracts = |it: &OutboxItem| -> Option<U16> {
            if it.id == U16::from_utf8("a") {
                return Some(U16::from_utf8("c"));
            }
            None
        };
        let input = WorkInventoryInput {
            outbox_items: &[OutboxItem {
                id: U16::from_utf8("a"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 0.0,
                state: U16::from_utf8("bogus"),
            }],
            handler_contract_for: &contracts,
        };
        assert_eq!(
            build_work_inventory(&input),
            Err(RecoveryError {
                name: "Error".to_string(),
                message: "buildWorkInventory: item \"a\" has unknown state \"bogus\".".to_string()
            })
        );
    }
    #[test]
    fn v_scan_one_page() {
        let pages: Vec<DueScanPage<Value>> = vec![DueScanPage {
            rows: vec![Value::Obj(vec![(U16::from_utf8("r"), Value::Num(1.0))])],
            next_cursor: None,
        }];
        let at: Rc<RefCell<usize>> = Rc::new(RefCell::new(0));
        let seen = Rc::clone(&at);
        let supplier = move |_: Option<&U16>, _: f64| {
            let i = *seen.borrow();
            *seen.borrow_mut() += 1;
            pages[i].clone()
        };
        assert_eq!(
            scan_due_batch(&supplier, None, 5.0),
            Ok(DueScanResult {
                rows: vec![Value::Obj(vec![(U16::from_utf8("r"), Value::Num(1.0))])],
                next_cursor: None,
                done: true
            })
        );
    }
    #[test]
    fn v_scan_has_more() {
        let pages: Vec<DueScanPage<Value>> = vec![DueScanPage {
            rows: vec![
                Value::Obj(vec![(U16::from_utf8("r"), Value::Num(1.0))]),
                Value::Obj(vec![(U16::from_utf8("r"), Value::Num(2.0))]),
            ],
            next_cursor: Some(U16::from_utf8("c1")),
        }];
        let at: Rc<RefCell<usize>> = Rc::new(RefCell::new(0));
        let seen = Rc::clone(&at);
        let supplier = move |_: Option<&U16>, _: f64| {
            let i = *seen.borrow();
            *seen.borrow_mut() += 1;
            pages[i].clone()
        };
        assert_eq!(
            scan_due_batch(&supplier, None, 2.0),
            Ok(DueScanResult {
                rows: vec![
                    Value::Obj(vec![(U16::from_utf8("r"), Value::Num(1.0))]),
                    Value::Obj(vec![(U16::from_utf8("r"), Value::Num(2.0))])
                ],
                next_cursor: Some(U16::from_utf8("c1")),
                done: false
            })
        );
    }
    #[test]
    fn v_scan_over_delivery() {
        let pages: Vec<DueScanPage<Value>> = vec![DueScanPage {
            rows: vec![
                Value::Obj(vec![(U16::from_utf8("r"), Value::Num(1.0))]),
                Value::Obj(vec![(U16::from_utf8("r"), Value::Num(2.0))]),
                Value::Obj(vec![(U16::from_utf8("r"), Value::Num(3.0))]),
            ],
            next_cursor: None,
        }];
        let at: Rc<RefCell<usize>> = Rc::new(RefCell::new(0));
        let seen = Rc::clone(&at);
        let supplier = move |_: Option<&U16>, _: f64| {
            let i = *seen.borrow();
            *seen.borrow_mut() += 1;
            pages[i].clone()
        };
        assert_eq!(
            scan_due_batch::<Value>(&supplier, None, 2.0),
            Err(RecoveryError {
                name: "RangeError".to_string(),
                message: "scanDueBatch: supplier over-delivered 3 rows for limit 2".to_string()
            })
        );
    }
    #[test]
    fn v_scan_bad_limit() {
        let pages: Vec<DueScanPage<Value>> = vec![];
        let at: Rc<RefCell<usize>> = Rc::new(RefCell::new(0));
        let seen = Rc::clone(&at);
        let supplier = move |_: Option<&U16>, _: f64| {
            let i = *seen.borrow();
            *seen.borrow_mut() += 1;
            pages[i].clone()
        };
        assert_eq!(
            scan_due_batch::<Value>(&supplier, None, 0.0),
            Err(RecoveryError {
                name: "RangeError".to_string(),
                message: "scanDueBatch: limit must be an integer >= 1".to_string()
            })
        );
    }
    #[test]
    fn v_drain_two_pages() {
        let pages: Vec<DueScanPage<Value>> = vec![
            DueScanPage {
                rows: vec![Value::Obj(vec![(U16::from_utf8("r"), Value::Num(1.0))])],
                next_cursor: Some(U16::from_utf8("c1")),
            },
            DueScanPage {
                rows: vec![Value::Obj(vec![(U16::from_utf8("r"), Value::Num(2.0))])],
                next_cursor: None,
            },
        ];
        let at: Rc<RefCell<usize>> = Rc::new(RefCell::new(0));
        let seen = Rc::clone(&at);
        let supplier = move |_: Option<&U16>, _: f64| {
            let i = *seen.borrow();
            *seen.borrow_mut() += 1;
            pages[i].clone()
        };
        assert_eq!(
            drain_due_scan(&supplier, 5.0, 5.0, None),
            Ok(DrainDueScanResult {
                rows: vec![
                    Value::Obj(vec![(U16::from_utf8("r"), Value::Num(1.0))]),
                    Value::Obj(vec![(U16::from_utf8("r"), Value::Num(2.0))])
                ],
                next_cursor: None,
                done: true,
                batches: 2.0
            })
        );
    }
    #[test]
    fn v_drain_capped() {
        let pages: Vec<DueScanPage<Value>> = vec![
            DueScanPage {
                rows: vec![Value::Obj(vec![(U16::from_utf8("r"), Value::Num(1.0))])],
                next_cursor: Some(U16::from_utf8("c1")),
            },
            DueScanPage {
                rows: vec![Value::Obj(vec![(U16::from_utf8("r"), Value::Num(2.0))])],
                next_cursor: Some(U16::from_utf8("c2")),
            },
            DueScanPage {
                rows: vec![Value::Obj(vec![(U16::from_utf8("r"), Value::Num(3.0))])],
                next_cursor: None,
            },
        ];
        let at: Rc<RefCell<usize>> = Rc::new(RefCell::new(0));
        let seen = Rc::clone(&at);
        let supplier = move |_: Option<&U16>, _: f64| {
            let i = *seen.borrow();
            *seen.borrow_mut() += 1;
            pages[i].clone()
        };
        assert_eq!(
            drain_due_scan(&supplier, 5.0, 2.0, None),
            Ok(DrainDueScanResult {
                rows: vec![
                    Value::Obj(vec![(U16::from_utf8("r"), Value::Num(1.0))]),
                    Value::Obj(vec![(U16::from_utf8("r"), Value::Num(2.0))])
                ],
                next_cursor: Some(U16::from_utf8("c2")),
                done: false,
                batches: 2.0
            })
        );
    }
    #[test]
    fn v_drain_bad_cap() {
        let pages: Vec<DueScanPage<Value>> = vec![];
        let at: Rc<RefCell<usize>> = Rc::new(RefCell::new(0));
        let seen = Rc::clone(&at);
        let supplier = move |_: Option<&U16>, _: f64| {
            let i = *seen.borrow();
            *seen.borrow_mut() += 1;
            pages[i].clone()
        };
        assert_eq!(
            drain_due_scan::<Value>(&supplier, 5.0, 0.0, None),
            Err(RecoveryError {
                name: "RangeError".to_string(),
                message: "drainDueScan: maxBatches must be an integer >= 1".to_string()
            })
        );
    }
    #[test]
    fn v_claim_stale_boundary() {
        assert_eq!(
            is_claim_stale(
                &DispatchClaim {
                    outbox_id: U16::from_utf8("o"),
                    claim_id: U16::from_utf8("c"),
                    claimed_at: 100.0
                },
                150.0,
                50.0
            ),
            Ok(true)
        );
    }
    #[test]
    fn v_claim_fresh() {
        assert_eq!(
            is_claim_stale(
                &DispatchClaim {
                    outbox_id: U16::from_utf8("o"),
                    claim_id: U16::from_utf8("c"),
                    claimed_at: 101.0
                },
                150.0,
                50.0
            ),
            Ok(false)
        );
    }
    #[test]
    fn v_claim_bad_now() {
        assert_eq!(
            is_claim_stale(
                &DispatchClaim {
                    outbox_id: U16::from_utf8("o"),
                    claim_id: U16::from_utf8("c"),
                    claimed_at: 1.0
                },
                -1.0,
                50.0
            ),
            Err(RecoveryError {
                name: "RangeError".to_string(),
                message: "isClaimStale: nowMs must be finite and >= 0".to_string()
            })
        );
    }
    #[test]
    fn v_claim_bad_maxage() {
        assert_eq!(
            is_claim_stale(
                &DispatchClaim {
                    outbox_id: U16::from_utf8("o"),
                    claim_id: U16::from_utf8("c"),
                    claimed_at: 1.0
                },
                50.0,
                f64::NAN
            ),
            Err(RecoveryError {
                name: "RangeError".to_string(),
                message: "isClaimStale: maxClaimAgeMs must be finite and >= 0".to_string()
            })
        );
    }
    #[test]
    fn v_find_stale_sorted() {
        assert_eq!(
            find_stale_claims(
                &[
                    DispatchClaim {
                        outbox_id: U16::from_utf8("b"),
                        claim_id: U16::from_utf8("cb"),
                        claimed_at: 1.0
                    },
                    DispatchClaim {
                        outbox_id: U16::from_utf8("a"),
                        claim_id: U16::from_utf8("ca"),
                        claimed_at: 1.0
                    },
                    DispatchClaim {
                        outbox_id: U16::from_utf8("f"),
                        claim_id: U16::from_utf8("cf"),
                        claimed_at: 1000.0
                    }
                ],
                500.0,
                100.0
            ),
            Ok(vec![
                DispatchClaim {
                    outbox_id: U16::from_utf8("a"),
                    claim_id: U16::from_utf8("ca"),
                    claimed_at: 1.0
                },
                DispatchClaim {
                    outbox_id: U16::from_utf8("b"),
                    claim_id: U16::from_utf8("cb"),
                    claimed_at: 1.0
                }
            ])
        );
    }
    #[test]
    fn v_release_stale() {
        assert_eq!(
            release_stale_claims(
                &[
                    OutboxItem {
                        id: U16::from_utf8("s1"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("claimed")
                    },
                    OutboxItem {
                        id: U16::from_utf8("s2"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("claimed")
                    },
                    OutboxItem {
                        id: U16::from_utf8("live"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("claimed")
                    },
                    OutboxItem {
                        id: U16::from_utf8("p"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("pending")
                    }
                ],
                &[
                    DispatchClaim {
                        outbox_id: U16::from_utf8("s2"),
                        claim_id: U16::from_utf8("c2"),
                        claimed_at: 1.0
                    },
                    DispatchClaim {
                        outbox_id: U16::from_utf8("s1"),
                        claim_id: U16::from_utf8("c1"),
                        claimed_at: 1.0
                    },
                    DispatchClaim {
                        outbox_id: U16::from_utf8("live"),
                        claim_id: U16::from_utf8("c3"),
                        claimed_at: 900.0
                    }
                ],
                500.0,
                100.0
            ),
            Ok(ReleaseStaleResult {
                items: vec![
                    OutboxItem {
                        id: U16::from_utf8("s1"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("pending")
                    },
                    OutboxItem {
                        id: U16::from_utf8("s2"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("pending")
                    },
                    OutboxItem {
                        id: U16::from_utf8("live"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("claimed")
                    },
                    OutboxItem {
                        id: U16::from_utf8("p"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("pending")
                    }
                ],
                released_ids: vec![U16::from_utf8("s1"), U16::from_utf8("s2")]
            })
        );
    }
    #[test]
    fn v_release_last_claim_wins() {
        assert_eq!(
            release_stale_claims(
                &[OutboxItem {
                    id: U16::from_utf8("d"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("claimed")
                }],
                &[
                    DispatchClaim {
                        outbox_id: U16::from_utf8("d"),
                        claim_id: U16::from_utf8("old"),
                        claimed_at: 1.0
                    },
                    DispatchClaim {
                        outbox_id: U16::from_utf8("d"),
                        claim_id: U16::from_utf8("new"),
                        claimed_at: 900.0
                    }
                ],
                500.0,
                100.0
            ),
            Ok(ReleaseStaleResult {
                items: vec![OutboxItem {
                    id: U16::from_utf8("d"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("claimed")
                }],
                released_ids: vec![]
            })
        );
    }
    #[test]
    fn v_staging_retry() {
        let input = RecordStagingFailureInput {
            item: OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 2.0,
                state: U16::from_utf8("pending"),
            },
            cause: FailureCause::Transient {
                code: U16::from_utf8("E"),
                message: U16::from_utf8("m"),
            },
            now_ms: 5000.0,
            first_attempt_at_ms: 10.0,
            policy: None,
        };
        assert_eq!(
            record_staging_failure(&input),
            Ok(RecordedStagingFailure {
                item: OutboxItem {
                    id: U16::from_utf8("obx-1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 3.0,
                    state: U16::from_utf8("pending")
                },
                disposition: U16::from_utf8("retry"),
                retry_class: U16::from_utf8("transient"),
                retryable: true
            })
        );
    }
    #[test]
    fn v_staging_dead() {
        let input = RecordStagingFailureInput {
            item: OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 7.0,
                state: U16::from_utf8("pending"),
            },
            cause: FailureCause::Transient {
                code: U16::from_utf8("E"),
                message: U16::from_utf8("m"),
            },
            now_ms: 5000.0,
            first_attempt_at_ms: 10.0,
            policy: None,
        };
        assert_eq!(
            record_staging_failure(&input),
            Ok(RecordedStagingFailure {
                item: OutboxItem {
                    id: U16::from_utf8("obx-1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 8.0,
                    state: U16::from_utf8("dead")
                },
                disposition: U16::from_utf8("dead"),
                retry_class: U16::from_utf8("transient"),
                retryable: false
            })
        );
    }
    #[test]
    fn v_staging_terminal() {
        let input = RecordStagingFailureInput {
            item: OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 0.0,
                state: U16::from_utf8("pending"),
            },
            cause: FailureCause::Permanent {
                code: U16::from_utf8("E"),
                message: U16::from_utf8("m"),
            },
            now_ms: 50.0,
            first_attempt_at_ms: 10.0,
            policy: None,
        };
        assert_eq!(
            record_staging_failure(&input),
            Ok(RecordedStagingFailure {
                item: OutboxItem {
                    id: U16::from_utf8("obx-1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 1.0,
                    state: U16::from_utf8("failed")
                },
                disposition: U16::from_utf8("terminal"),
                retry_class: U16::from_utf8("terminal"),
                retryable: false
            })
        );
    }
    #[test]
    fn v_staging_bad_state() {
        let input = RecordStagingFailureInput {
            item: OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 0.0,
                state: U16::from_utf8("dead"),
            },
            cause: FailureCause::Transient {
                code: U16::from_utf8("E"),
                message: U16::from_utf8("m"),
            },
            now_ms: 50.0,
            first_attempt_at_ms: 10.0,
            policy: None,
        };
        assert_eq!(record_staging_failure(&input), Err(RecoveryError { name: "Error".to_string(), message: "recordStagingFailure: item obx-1 is dead; failures apply to pending/claimed items only".to_string() }));
    }
    #[test]
    fn v_staging_bad_policy() {
        let input = RecordStagingFailureInput {
            item: OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 0.0,
                state: U16::from_utf8("pending"),
            },
            cause: FailureCause::Transient {
                code: U16::from_utf8("E"),
                message: U16::from_utf8("m"),
            },
            now_ms: 50.0,
            first_attempt_at_ms: 10.0,
            policy: Some(RetryPolicy {
                max_attempts: 1.0,
                horizon_ms: -5.0,
            }),
        };
        assert_eq!(
            record_staging_failure(&input),
            Err(RecoveryError {
                name: "RangeError".to_string(),
                message: "recordStagingFailure: policy.horizonMs must be finite and > 0"
                    .to_string()
            })
        );
    }
    #[test]
    fn v_plan_mixed() {
        let ev = |id: &U16| -> Option<ReconcileEvidence> {
            if *id == U16::from_utf8("ry") {
                return Some(ReconcileEvidence::NotFound);
            }
            if *id == U16::from_utf8("rc") {
                return Some(ReconcileEvidence::Failed {
                    code: U16::from_utf8("E"),
                    message: U16::from_utf8("m"),
                });
            }
            None
        };
        let input = RecoveryScanInput {
            rows: &[
                RecoverableRow {
                    item: OutboxItem {
                        id: U16::from_utf8("sk"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("pending"),
                    },
                    guard_verdict: Some(false),
                    first_attempt_at_ms: None,
                    retry_class: None,
                },
                RecoverableRow {
                    item: OutboxItem {
                        id: U16::from_utf8("pn"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("pending"),
                    },
                    guard_verdict: None,
                    first_attempt_at_ms: None,
                    retry_class: None,
                },
                RecoverableRow {
                    item: OutboxItem {
                        id: U16::from_utf8("rs"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("claimed"),
                    },
                    guard_verdict: None,
                    first_attempt_at_ms: None,
                    retry_class: None,
                },
                RecoverableRow {
                    item: OutboxItem {
                        id: U16::from_utf8("fr"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("claimed"),
                    },
                    guard_verdict: None,
                    first_attempt_at_ms: None,
                    retry_class: None,
                },
                RecoverableRow {
                    item: OutboxItem {
                        id: U16::from_utf8("rt"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 2.0,
                        state: U16::from_utf8("failed"),
                    },
                    guard_verdict: None,
                    first_attempt_at_ms: Some(100.0),
                    retry_class: Some(U16::from_utf8("transient")),
                },
                RecoverableRow {
                    item: OutboxItem {
                        id: U16::from_utf8("dd"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 8.0,
                        state: U16::from_utf8("failed"),
                    },
                    guard_verdict: None,
                    first_attempt_at_ms: Some(100.0),
                    retry_class: Some(U16::from_utf8("transient")),
                },
                RecoverableRow {
                    item: OutboxItem {
                        id: U16::from_utf8("tm"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 1.0,
                        state: U16::from_utf8("failed"),
                    },
                    guard_verdict: None,
                    first_attempt_at_ms: Some(100.0),
                    retry_class: Some(U16::from_utf8("terminal")),
                },
                RecoverableRow {
                    item: OutboxItem {
                        id: U16::from_utf8("un"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 1.0,
                        state: U16::from_utf8("failed"),
                    },
                    guard_verdict: None,
                    first_attempt_at_ms: Some(100.0),
                    retry_class: None,
                },
                RecoverableRow {
                    item: OutboxItem {
                        id: U16::from_utf8("aw"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("uncertain"),
                    },
                    guard_verdict: None,
                    first_attempt_at_ms: None,
                    retry_class: None,
                },
                RecoverableRow {
                    item: OutboxItem {
                        id: U16::from_utf8("ry"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("uncertain"),
                    },
                    guard_verdict: None,
                    first_attempt_at_ms: None,
                    retry_class: None,
                },
                RecoverableRow {
                    item: OutboxItem {
                        id: U16::from_utf8("rc"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("uncertain"),
                    },
                    guard_verdict: None,
                    first_attempt_at_ms: None,
                    retry_class: None,
                },
                RecoverableRow {
                    item: OutboxItem {
                        id: U16::from_utf8("dv"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("delivered"),
                    },
                    guard_verdict: None,
                    first_attempt_at_ms: None,
                    retry_class: None,
                },
                RecoverableRow {
                    item: OutboxItem {
                        id: U16::from_utf8("de"),
                        operation_id: U16::from_utf8("op-1"),
                        source: U16::from_utf8("emit"),
                        occurrence_index: 0.0,
                        request: Value::Obj(vec![]),
                        origin_occurrence: None,
                        attempts: 0.0,
                        state: U16::from_utf8("dead"),
                    },
                    guard_verdict: None,
                    first_attempt_at_ms: None,
                    retry_class: None,
                },
            ],
            claims: &[
                DispatchClaim {
                    outbox_id: U16::from_utf8("rs"),
                    claim_id: U16::from_utf8("c1"),
                    claimed_at: 1.0,
                },
                DispatchClaim {
                    outbox_id: U16::from_utf8("fr"),
                    claim_id: U16::from_utf8("c2"),
                    claimed_at: 900.0,
                },
            ],
            evidence: &ev,
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_recovery_scan(&input),
            Ok(RecoveryPlan {
                resume: vec![U16::from_utf8("rs")],
                retry: vec![U16::from_utf8("rt"), U16::from_utf8("ry")],
                reconcile: vec![U16::from_utf8("rc")],
                awaiting: vec![U16::from_utf8("aw")],
                skipped: vec![U16::from_utf8("sk")],
                terminal: vec![U16::from_utf8("tm"), U16::from_utf8("un")],
                dead: vec![U16::from_utf8("dd")]
            })
        );
    }
    #[test]
    fn v_plan_null_anchor() {
        let ev = |_: &U16| -> Option<ReconcileEvidence> { None };
        let input = RecoveryScanInput {
            rows: &[RecoverableRow {
                item: OutboxItem {
                    id: U16::from_utf8("h"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 1.0,
                    state: U16::from_utf8("failed"),
                },
                guard_verdict: None,
                first_attempt_at_ms: None,
                retry_class: Some(U16::from_utf8("transient")),
            }],
            claims: &[],
            evidence: &ev,
            now_ms: 99999999.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_recovery_scan(&input),
            Ok(RecoveryPlan {
                resume: vec![],
                retry: vec![U16::from_utf8("h")],
                reconcile: vec![],
                awaiting: vec![],
                skipped: vec![],
                terminal: vec![],
                dead: vec![]
            })
        );
    }
    #[test]
    fn v_plan_bad_now() {
        let ev = |_: &U16| -> Option<ReconcileEvidence> { None };
        let input = RecoveryScanInput {
            rows: &[],
            claims: &[],
            evidence: &ev,
            now_ms: -1.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_recovery_scan(&input),
            Err(RecoveryError {
                name: "RangeError".to_string(),
                message: "planRecoveryScan: nowMs must be finite and >= 0".to_string()
            })
        );
    }
    #[test]
    fn v_plan_bad_policy() {
        let ev = |_: &U16| -> Option<ReconcileEvidence> { None };
        let input = RecoveryScanInput {
            rows: &[],
            claims: &[],
            evidence: &ev,
            now_ms: 5.0,
            max_claim_age_ms: 100.0,
            policy: Some(RetryPolicy {
                max_attempts: 0.0,
                horizon_ms: 5.0,
            }),
        };
        assert_eq!(
            plan_recovery_scan(&input),
            Err(RecoveryError {
                name: "RangeError".to_string(),
                message: "planRecoveryScan: policy.maxAttempts must be an integer >= 1".to_string()
            })
        );
    }
    #[test]
    fn v_fanout_stale_boundary() {
        assert_eq!(is_fanout_claim_stale(100.0, 150.0, 50.0), Ok(true));
    }
    #[test]
    fn v_fanout_fresh() {
        assert_eq!(is_fanout_claim_stale(101.0, 150.0, 50.0), Ok(false));
    }
    #[test]
    fn v_fanout_stale_bad() {
        assert_eq!(
            is_fanout_claim_stale(-1.0, 150.0, 50.0),
            Err(RecoveryError {
                name: "RangeError".to_string(),
                message: "isFanoutClaimStale: claimedAtMs must be finite and >= 0".to_string()
            })
        );
    }
    #[test]
    fn v_fanout_exhausted_attempts() {
        assert_eq!(
            is_fanout_child_exhausted(
                8.0,
                Some(100.0),
                500.0,
                &RetryPolicy {
                    max_attempts: 8.0,
                    horizon_ms: 1000.0
                }
            ),
            Ok(true)
        );
    }
    #[test]
    fn v_fanout_exhausted_horizon() {
        assert_eq!(
            is_fanout_child_exhausted(
                1.0,
                Some(100.0),
                1200.0,
                &RetryPolicy {
                    max_attempts: 8.0,
                    horizon_ms: 1000.0
                }
            ),
            Ok(true)
        );
    }
    #[test]
    fn v_fanout_null_anchor() {
        assert_eq!(
            is_fanout_child_exhausted(
                1.0,
                None,
                999999.0,
                &RetryPolicy {
                    max_attempts: 8.0,
                    horizon_ms: 1000.0
                }
            ),
            Ok(false)
        );
    }
    #[test]
    fn v_fanout_within_budget() {
        assert_eq!(
            is_fanout_child_exhausted(
                1.0,
                Some(100.0),
                500.0,
                &RetryPolicy {
                    max_attempts: 8.0,
                    horizon_ms: 1000.0
                }
            ),
            Ok(false)
        );
    }
    #[test]
    fn v_fanout_exhausted_bad_policy() {
        assert_eq!(
            is_fanout_child_exhausted(
                1.0,
                Some(100.0),
                500.0,
                &RetryPolicy {
                    max_attempts: 8.0,
                    horizon_ms: 0.0
                }
            ),
            Err(RecoveryError {
                name: "RangeError".to_string(),
                message: "isFanoutChildExhausted: policy.horizonMs must be finite and > 0"
                    .to_string()
            })
        );
    }
    #[test]
    fn v_fanout_plan_resume() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("running"),
                    attempts: 0.0,
                },
                claimed_at_ms: Some(1.0),
                guard_verdict: Some(true),
                first_attempt_at_ms: Some(400.0),
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("present"),
                    reason: None,
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Ok(FanoutRecoveryPlan {
                resume: vec![U16::from_utf8("fanout-child/v1/o/h/r1")],
                skipped: vec![],
                dead: vec![],
                failed: vec![],
                admit: vec![],
                uncertain: vec![],
                phantoms: vec![],
                checkpoint_gaps: vec![],
                finish_enumeration: false
            })
        );
    }
    #[test]
    fn v_fanout_plan_uncertain_fresh() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("running"),
                    attempts: 0.0,
                },
                claimed_at_ms: Some(450.0),
                guard_verdict: Some(true),
                first_attempt_at_ms: Some(400.0),
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("present"),
                    reason: None,
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Ok(FanoutRecoveryPlan {
                resume: vec![],
                skipped: vec![],
                dead: vec![],
                failed: vec![],
                admit: vec![],
                uncertain: vec![U16::from_utf8("fanout-child/v1/o/h/r1")],
                phantoms: vec![],
                checkpoint_gaps: vec![],
                finish_enumeration: false
            })
        );
    }
    #[test]
    fn v_fanout_plan_uncertain_null() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("running"),
                    attempts: 0.0,
                },
                claimed_at_ms: None,
                guard_verdict: Some(true),
                first_attempt_at_ms: None,
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("present"),
                    reason: None,
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Ok(FanoutRecoveryPlan {
                resume: vec![],
                skipped: vec![],
                dead: vec![],
                failed: vec![],
                admit: vec![],
                uncertain: vec![U16::from_utf8("fanout-child/v1/o/h/r1")],
                phantoms: vec![],
                checkpoint_gaps: vec![],
                finish_enumeration: false
            })
        );
    }
    #[test]
    fn v_fanout_plan_skipped_deleted() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("running"),
                    attempts: 0.0,
                },
                claimed_at_ms: Some(1.0),
                guard_verdict: Some(true),
                first_attempt_at_ms: Some(400.0),
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("deleted"),
                    reason: None,
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Ok(FanoutRecoveryPlan {
                resume: vec![],
                skipped: vec![FanoutSkippedAction {
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    reason: U16::from_utf8("deleted")
                }],
                dead: vec![],
                failed: vec![],
                admit: vec![],
                uncertain: vec![],
                phantoms: vec![],
                checkpoint_gaps: vec![],
                finish_enumeration: false
            })
        );
    }
    #[test]
    fn v_fanout_plan_failed_unknown() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("running"),
                    attempts: 0.0,
                },
                claimed_at_ms: Some(1.0),
                guard_verdict: Some(true),
                first_attempt_at_ms: Some(400.0),
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("unknown"),
                    reason: Some(U16::from_utf8("missing-record")),
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Ok(FanoutRecoveryPlan {
                resume: vec![],
                skipped: vec![],
                dead: vec![],
                failed: vec![FanoutFailedAction {
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    reason: U16::from_utf8("missing-record")
                }],
                admit: vec![],
                uncertain: vec![],
                phantoms: vec![],
                checkpoint_gaps: vec![],
                finish_enumeration: false
            })
        );
    }
    #[test]
    fn v_fanout_plan_skipped_guard() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("running"),
                    attempts: 0.0,
                },
                claimed_at_ms: Some(1.0),
                guard_verdict: Some(false),
                first_attempt_at_ms: Some(400.0),
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("present"),
                    reason: None,
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Ok(FanoutRecoveryPlan {
                resume: vec![],
                skipped: vec![FanoutSkippedAction {
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    reason: U16::from_utf8("non-applicable")
                }],
                dead: vec![],
                failed: vec![],
                admit: vec![],
                uncertain: vec![],
                phantoms: vec![],
                checkpoint_gaps: vec![],
                finish_enumeration: false
            })
        );
    }
    #[test]
    fn v_fanout_plan_dead() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("running"),
                    attempts: 8.0,
                },
                claimed_at_ms: Some(1.0),
                guard_verdict: Some(true),
                first_attempt_at_ms: Some(400.0),
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("present"),
                    reason: None,
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Ok(FanoutRecoveryPlan {
                resume: vec![],
                skipped: vec![],
                dead: vec![U16::from_utf8("fanout-child/v1/o/h/r1")],
                failed: vec![],
                admit: vec![],
                uncertain: vec![],
                phantoms: vec![],
                checkpoint_gaps: vec![],
                finish_enumeration: false
            })
        );
    }
    #[test]
    fn v_fanout_plan_pending_deleted() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("pending"),
                    attempts: 0.0,
                },
                claimed_at_ms: None,
                guard_verdict: None,
                first_attempt_at_ms: None,
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("deleted"),
                    reason: None,
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Ok(FanoutRecoveryPlan {
                resume: vec![],
                skipped: vec![FanoutSkippedAction {
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    reason: U16::from_utf8("deleted")
                }],
                dead: vec![],
                failed: vec![],
                admit: vec![],
                uncertain: vec![],
                phantoms: vec![],
                checkpoint_gaps: vec![],
                finish_enumeration: false
            })
        );
    }
    #[test]
    fn v_fanout_plan_pending_quiet() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("pending"),
                    attempts: 0.0,
                },
                claimed_at_ms: None,
                guard_verdict: Some(true),
                first_attempt_at_ms: None,
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("present"),
                    reason: None,
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Ok(FanoutRecoveryPlan {
                resume: vec![],
                skipped: vec![],
                dead: vec![],
                failed: vec![],
                admit: vec![],
                uncertain: vec![],
                phantoms: vec![],
                checkpoint_gaps: vec![],
                finish_enumeration: false
            })
        );
    }
    #[test]
    fn v_fanout_plan_terminal_stands() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("failed"),
                    attempts: 2.0,
                },
                claimed_at_ms: Some(1.0),
                guard_verdict: Some(false),
                first_attempt_at_ms: Some(400.0),
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("present"),
                    reason: None,
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Ok(FanoutRecoveryPlan {
                resume: vec![],
                skipped: vec![],
                dead: vec![],
                failed: vec![],
                admit: vec![],
                uncertain: vec![],
                phantoms: vec![],
                checkpoint_gaps: vec![],
                finish_enumeration: false
            })
        );
    }
    #[test]
    fn v_fanout_plan_admit() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("rx")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Ok(FanoutRecoveryPlan {
                resume: vec![],
                skipped: vec![],
                dead: vec![],
                failed: vec![],
                admit: vec![U16::from_utf8("rx")],
                uncertain: vec![],
                phantoms: vec![],
                checkpoint_gaps: vec![],
                finish_enumeration: false
            })
        );
    }
    #[test]
    fn v_fanout_plan_phantom() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/ghost"),
                    record_id: U16::from_utf8("ghost"),
                    state: U16::from_utf8("pending"),
                    attempts: 0.0,
                },
                claimed_at_ms: None,
                guard_verdict: None,
                first_attempt_at_ms: None,
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("present"),
                    reason: None,
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Ok(FanoutRecoveryPlan {
                resume: vec![],
                skipped: vec![],
                dead: vec![],
                failed: vec![],
                admit: vec![U16::from_utf8("r1")],
                uncertain: vec![],
                phantoms: vec![U16::from_utf8("fanout-child/v1/o/h/ghost")],
                checkpoint_gaps: vec![],
                finish_enumeration: false
            })
        );
    }
    #[test]
    fn v_fanout_plan_gap() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![U16::from_utf8("done1")],
                cursor: None,
            },
            rows: vec![],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Ok(FanoutRecoveryPlan {
                resume: vec![],
                skipped: vec![],
                dead: vec![],
                failed: vec![],
                admit: vec![U16::from_utf8("r1")],
                uncertain: vec![],
                phantoms: vec![],
                checkpoint_gaps: vec![U16::from_utf8("done1")],
                finish_enumeration: false
            })
        );
    }
    #[test]
    fn v_fanout_plan_finish() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![U16::from_utf8("r1")],
                cursor: Some(U16::from_utf8("cur")),
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("completed"),
                    attempts: 0.0,
                },
                claimed_at_ms: None,
                guard_verdict: None,
                first_attempt_at_ms: None,
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("present"),
                    reason: None,
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Ok(FanoutRecoveryPlan {
                resume: vec![],
                skipped: vec![],
                dead: vec![],
                failed: vec![],
                admit: vec![],
                uncertain: vec![],
                phantoms: vec![],
                checkpoint_gaps: vec![],
                finish_enumeration: true
            })
        );
    }
    #[test]
    fn v_fanout_plan_intent_mismatch() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("other"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Err(RecoveryError {
                name: "Error".to_string(),
                message: "planFanoutRecoveryScan: intent carries a different fanoutId.".to_string()
            })
        );
    }
    #[test]
    fn v_fanout_plan_child_mismatch() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("other"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("pending"),
                    attempts: 0.0,
                },
                claimed_at_ms: None,
                guard_verdict: None,
                first_attempt_at_ms: None,
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("present"),
                    reason: None,
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Err(RecoveryError {
                name: "Error".to_string(),
                message: "planFanoutRecoveryScan: child row carries a different fanoutId."
                    .to_string()
            })
        );
    }
    #[test]
    fn v_fanout_plan_unknown_state() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("held"),
                    attempts: 0.0,
                },
                claimed_at_ms: None,
                guard_verdict: None,
                first_attempt_at_ms: None,
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("present"),
                    reason: None,
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(plan_fanout_recovery_scan(&input), Err(RecoveryError { name: "Error".to_string(), message: "planFanoutRecoveryScan: child \"fanout-child/v1/o/h/r1\" has unknown state \"held\".".to_string() }));
    }
    #[test]
    fn v_fanout_plan_unknown_lifecycle() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("pending"),
                    attempts: 0.0,
                },
                claimed_at_ms: None,
                guard_verdict: None,
                first_attempt_at_ms: None,
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("weird"),
                    reason: None,
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(plan_fanout_recovery_scan(&input), Err(RecoveryError { name: "Error".to_string(), message: "planFanoutRecoveryScan: child \"fanout-child/v1/o/h/r1\" has unknown lifecycle \"weird\".".to_string() }));
    }
    #[test]
    fn v_fanout_plan_unknown_reason() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("pending"),
                    attempts: 0.0,
                },
                claimed_at_ms: None,
                guard_verdict: None,
                first_attempt_at_ms: None,
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("unknown"),
                    reason: Some(U16::from_utf8("bogus")),
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(plan_fanout_recovery_scan(&input), Err(RecoveryError { name: "Error".to_string(), message: "planFanoutRecoveryScan: child \"fanout-child/v1/o/h/r1\" has unknown lifecycle reason \"bogus\".".to_string() }));
    }
    #[test]
    fn v_fanout_plan_bad_claimed() {
        let input = FanoutRecoveryScanInput {
            fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
            intent: FanoutIntentRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                members: vec![U16::from_utf8("r1")],
            },
            checkpoint: FanoutCheckpointRowData {
                fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                completed: vec![],
                cursor: None,
            },
            rows: vec![FanoutRecoverableRow {
                child: FanoutChildRowData {
                    fanout_id: U16::from_utf8("fanout/v1/o/h/model"),
                    child_id: U16::from_utf8("fanout-child/v1/o/h/r1"),
                    record_id: U16::from_utf8("r1"),
                    state: U16::from_utf8("pending"),
                    attempts: 0.0,
                },
                claimed_at_ms: Some(-5.0),
                guard_verdict: None,
                first_attempt_at_ms: None,
                lifecycle: FanoutChildLifecycle {
                    status: U16::from_utf8("present"),
                    reason: None,
                },
            }],
            now_ms: 500.0,
            max_claim_age_ms: 100.0,
            policy: None,
        };
        assert_eq!(
            plan_fanout_recovery_scan(&input),
            Err(RecoveryError {
                name: "RangeError".to_string(),
                message: "planFanoutRecoveryScan: claimedAtMs must be finite and >= 0".to_string()
            })
        );
    }
    #[test]
    fn v_resume_mixed() {
        let input = RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![
                RelatedProgressRowView {
                    relation: U16::from_utf8("std.EmailV1.send"),
                    association: ResumeAssociation {
                        delivery_id: U16::from_utf8("b"),
                        revision: 1.0,
                    },
                    receipt: ResumeReceipt {
                        delivery_id: U16::from_utf8("b"),
                        revision: 1.0,
                        status: U16::from_utf8("pending"),
                    },
                },
                RelatedProgressRowView {
                    relation: U16::from_utf8("std.EmailV1.send"),
                    association: ResumeAssociation {
                        delivery_id: U16::from_utf8("a"),
                        revision: 2.0,
                    },
                    receipt: ResumeReceipt {
                        delivery_id: U16::from_utf8("a"),
                        revision: 2.0,
                        status: U16::from_utf8("unknown"),
                    },
                },
                RelatedProgressRowView {
                    relation: U16::from_utf8("std.EmailV1.send"),
                    association: ResumeAssociation {
                        delivery_id: U16::from_utf8("d"),
                        revision: 1.0,
                    },
                    receipt: ResumeReceipt {
                        delivery_id: U16::from_utf8("d"),
                        revision: 1.0,
                        status: U16::from_utf8("succeeded"),
                    },
                },
                RelatedProgressRowView {
                    relation: U16::from_utf8("std.EmailV1.send"),
                    association: ResumeAssociation {
                        delivery_id: U16::from_utf8("c"),
                        revision: 3.0,
                    },
                    receipt: ResumeReceipt {
                        delivery_id: U16::from_utf8("c"),
                        revision: 3.0,
                        status: U16::from_utf8("failed"),
                    },
                },
                RelatedProgressRowView {
                    relation: U16::from_utf8("std.EmailV1.send"),
                    association: ResumeAssociation {
                        delivery_id: U16::from_utf8("e"),
                        revision: 0.0,
                    },
                    receipt: ResumeReceipt {
                        delivery_id: U16::from_utf8("e"),
                        revision: 0.0,
                        status: U16::from_utf8("skipped"),
                    },
                },
            ],
        };
        assert_eq!(
            plan_related_progress_resume(&input),
            Ok(RelatedProgressResumePlan {
                relation: U16::from_utf8("std.EmailV1.send"),
                resume: vec![U16::from_utf8("a"), U16::from_utf8("b")],
                settled: vec![
                    U16::from_utf8("c"),
                    U16::from_utf8("d"),
                    U16::from_utf8("e")
                ]
            })
        );
    }
    #[test]
    fn v_resume_relation_mismatch() {
        let input = RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.MailboxV1.reply"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: 1.0,
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("a"),
                    revision: 1.0,
                    status: U16::from_utf8("pending"),
                },
            }],
        };
        assert_eq!(plan_related_progress_resume(&input), Err(RecoveryError { name: "Error".to_string(), message: "planRelatedProgressResume: row for \"a\" carries relation \"std.MailboxV1.reply\", expected \"std.EmailV1.send\".".to_string() }));
    }
    #[test]
    fn v_resume_unknown_relation() {
        let input = RelatedProgressResumeInput {
            relation: U16::from_utf8("std.NopeV1.x"),
            rows: vec![],
        };
        assert_eq!(
            plan_related_progress_resume(&input),
            Err(RecoveryError {
                name: "RangeError".to_string(),
                message: "planRelatedProgressResume: unknown progress relation \"std.NopeV1.x\""
                    .to_string()
            })
        );
    }
    #[test]
    fn v_resume_empty_relation() {
        let input = RelatedProgressResumeInput {
            relation: U16::from_utf8(""),
            rows: vec![],
        };
        assert_eq!(plan_related_progress_resume(&input), Err(RecoveryError { name: "TypeError".to_string(), message: "planRelatedProgressResume: relation must be a non-empty T13 delivery-observable target".to_string() }));
    }
    #[test]
    fn v_resume_unknown_status() {
        let input = RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.EmailV1.send"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: 1.0,
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("a"),
                    revision: 1.0,
                    status: U16::from_utf8("held"),
                },
            }],
        };
        assert_eq!(
            plan_related_progress_resume(&input),
            Err(RecoveryError {
                name: "Error".to_string(),
                message: "planRelatedProgressResume: row for \"a\" has unknown status \"held\"."
                    .to_string()
            })
        );
    }
    #[test]
    fn v_resume_delivery_skew() {
        let input = RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.EmailV1.send"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: 1.0,
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("b"),
                    revision: 1.0,
                    status: U16::from_utf8("pending"),
                },
            }],
        };
        assert_eq!(
            plan_related_progress_resume(&input),
            Err(RecoveryError {
                name: "Error".to_string(),
                message:
                    "planRelatedProgressResume: receipt \"b\" does not belong to association \"a\"."
                        .to_string()
            })
        );
    }
    #[test]
    fn v_resume_revision_skew() {
        let input = RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![RelatedProgressRowView {
                relation: U16::from_utf8("std.EmailV1.send"),
                association: ResumeAssociation {
                    delivery_id: U16::from_utf8("a"),
                    revision: 1.0,
                },
                receipt: ResumeReceipt {
                    delivery_id: U16::from_utf8("a"),
                    revision: 2.0,
                    status: U16::from_utf8("pending"),
                },
            }],
        };
        assert_eq!(plan_related_progress_resume(&input), Err(RecoveryError { name: "Error".to_string(), message: "planRelatedProgressResume: association revision 1 disagrees with receipt revision 2.".to_string() }));
    }
    #[test]
    fn v_resume_empty() {
        let input = RelatedProgressResumeInput {
            relation: U16::from_utf8("std.EmailV1.send"),
            rows: vec![],
        };
        assert_eq!(
            plan_related_progress_resume(&input),
            Ok(RelatedProgressResumePlan {
                relation: U16::from_utf8("std.EmailV1.send"),
                resume: vec![],
                settled: vec![]
            })
        );
    }
    #[test]
    fn v_t26_relations() {
        assert_eq!(T26_KNOWN_RELATION_TARGETS.len(), 16);
        assert_eq!(T26_KNOWN_RELATION_TARGETS[0], "std.EmailV1.send");
        assert_eq!(T26_KNOWN_RELATION_TARGETS[15], "std.MailboxV1.reconcile");
        assert_eq!(
            assert_known_progress_relation(&U16::from_utf8("std.EmailV1.send"), "probe"),
            Ok(U16::from_utf8("std.EmailV1.send"))
        );
    }
}

// N03 immutable witnesses: private Cargo route, not standalone rustc.
