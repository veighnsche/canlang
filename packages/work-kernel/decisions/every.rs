//! W04.2 — Native recurring `every(duration)` admission.
//!
//! Data-only Rust port of `src/every.ts`, proven against the same
//! independent TS oracle corpus (`conformance/fixtures/policy/every.json`).
//! Standalone file: compiles and tests with
//! `rustc --edition 2021 --test decisions/every.rs` — no Cargo
//! membership, no dependencies, no host I/O. The small shared prelude
//! (UTF-16 text) is duplicated per decisions file until W04.4 assembly
//! consolidates it. Hashing and the exact recurrence id bytes stay
//! host-owned: admission takes a supplied `derive_id` callback.

use std::collections::HashSet;

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

/// Parity error: name/code/scope/message match the TS donor.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EveryError {
    pub name: String,
    pub code: Option<String>,
    pub scope: Option<U16>,
    pub message: String,
}

fn range_error(message: String) -> EveryError {
    EveryError {
        name: "RangeError".to_string(),
        code: None,
        scope: None,
        message,
    }
}

/**
 * Host-owned occurrence-identity derivation. The kernel admits the set;
 * the host mints each id.
 */
pub type DeriveId = dyn Fn(&U16, &U16, &U16, &U16, f64) -> U16;

/// One eligible fanout scope for this tick. `scope` is validated at admission.
#[derive(Clone, PartialEq, Debug)]
pub struct EveryScopeInput {
    pub scope: U16,
    /// Concrete verified owner key (team id or app marker).
    pub owner: U16,
}

pub struct EveryTickInput {
    /// Current time as UTC epoch milliseconds.
    pub now_ms: f64,
    /// Recurrence period in milliseconds; must be a positive multiple of 1000.
    pub period_ms: f64,
    /// Selected app name.
    pub app: U16,
    /// Canonical handler contract identity.
    pub handler: U16,
    /// Currently eligible scopes.
    pub scopes: Vec<EveryScopeInput>,
    /// Last admitted slot (seconds) per scope key, for known scopes.
    /// Non-number values refuse (donor `Number.isInteger` check).
    pub previous_slots: Vec<(U16, PrevSlot)>,
}

/// A previous-slot entry: seconds, or a non-number refusal trigger.
#[derive(Clone, PartialEq, Debug)]
pub enum PrevSlot {
    Num(f64),
    Other,
}

#[derive(Clone, PartialEq, Debug)]
pub struct RecurringOccurrence {
    pub occurrence_id: U16,
    pub app: U16,
    pub handler: U16,
    pub scope: U16,
    pub owner: U16,
    pub slot: f64,
}

#[derive(Clone, PartialEq, Debug)]
pub struct EveryTickResult {
    /// Current UTC epoch slot in seconds.
    pub slot: f64,
    /// Current slot start as UTC epoch milliseconds.
    pub slot_start_ms: f64,
    /// Admitted occurrences, in stable (scope, owner) order.
    pub admitted: Vec<RecurringOccurrence>,
}

/// Map key joining one fanout scope to its last admitted slot.
pub fn every_scope_key(scope: &U16, owner: &U16) -> U16 {
    let mut out = scope.0.clone();
    out.push(b':' as u16);
    out.extend(owner.0.iter().copied());
    U16(out)
}

#[derive(Clone, PartialEq, Debug)]
pub struct EverySlot {
    pub slot: f64,
    pub slot_start_ms: f64,
}

/// UTC-epoch aligned slot containing `now_ms`. Pure.
pub fn compute_every_slot(now_ms: f64, period_ms: f64) -> Result<EverySlot, EveryError> {
    if !now_ms.is_finite() || now_ms < 0.0 {
        return Err(range_error(
            "computeEverySlot: nowMs must be finite UTC epoch ms >= 0".to_string(),
        ));
    }
    if period_ms.fract() != 0.0 || period_ms <= 0.0 || period_ms % 1000.0 != 0.0 {
        return Err(range_error(
            "computeEverySlot: periodMs must be a positive integer multiple of 1000".to_string(),
        ));
    }
    let slot_start_ms = (now_ms / period_ms).floor() * period_ms;
    Ok(EverySlot {
        slot: slot_start_ms / 1000.0,
        slot_start_ms,
    })
}

fn assert_scope(input: &EveryScopeInput) -> Result<U16, EveryError> {
    if !input.scope.eq_ascii("team") && !input.scope.eq_ascii("app") {
        let mut message =
            "work: recurring every() fanout covers team/app scopes only; rejected scope '"
                .to_string();
        for u in input.scope.0.iter() {
            message.push(char::from_u32(*u as u32).unwrap_or('\u{FFFD}'));
        }
        message.push_str("' (root recurrence uses explicit record-bound schedule)");
        return Err(EveryError {
            name: "RootRecurrenceNotSupportedError".to_string(),
            code: Some("ROOT_RECURRING_UNSUPPORTED".to_string()),
            scope: Some(input.scope.clone()),
            message,
        });
    }
    if input.owner.is_empty() {
        return Err(range_error(
            "admitEveryTick: scope owner must be a non-empty string".to_string(),
        ));
    }
    Ok(input.scope.clone())
}

/**
 * Admit one `every` tick. Returns the current slot and the coalesced
 * occurrence set: at most one occurrence per eligible pre-existing scope at
 * the current slot. Each admitted occurrence's id comes from the supplied
 * host `derive_id`.
 */
pub fn admit_every_tick(
    input: &EveryTickInput,
    derive_id: &DeriveId,
) -> Result<EveryTickResult, EveryError> {
    if input.app.is_empty() {
        return Err(range_error(
            "admitEveryTick: app must be a non-empty string".to_string(),
        ));
    }
    if input.handler.is_empty() {
        return Err(range_error(
            "admitEveryTick: handler must be a non-empty string".to_string(),
        ));
    }
    let slot_info = compute_every_slot(input.now_ms, input.period_ms)?;
    let (slot, slot_start_ms) = (slot_info.slot, slot_info.slot_start_ms);
    let mut seen: HashSet<Vec<u16>> = HashSet::new();
    let mut admitted: Vec<RecurringOccurrence> = Vec::new();
    for scope_input in input.scopes.iter() {
        let scope = assert_scope(scope_input)?;
        let key = every_scope_key(&scope, &scope_input.owner);
        if !seen.insert(key.0.clone()) {
            continue;
        }
        let previous = input
            .previous_slots
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v);
        match previous {
            // New scope: no admission until the staging path registers a slot.
            None => continue,
            Some(PrevSlot::Num(p)) if p.fract() == 0.0 && *p >= 0.0 && *p < slot => (),
            Some(PrevSlot::Num(p)) if p.fract() == 0.0 && *p >= 0.0 => continue,
            _ => {
                let mut key_text = String::new();
                for u in key.0.iter() {
                    key_text.push(char::from_u32(*u as u32).unwrap_or('\u{FFFD}'));
                }
                return Err(range_error(format!(
                    "admitEveryTick: previous slot for {key_text} must be a non-negative integer"
                )));
            }
        }
        admitted.push(RecurringOccurrence {
            occurrence_id: derive_id(&input.app, &input.handler, &scope, &scope_input.owner, slot),
            app: input.app.clone(),
            handler: input.handler.clone(),
            scope,
            owner: scope_input.owner.clone(),
            slot,
        });
    }
    admitted.sort_by(|a, b| a.scope.cmp(&b.scope).then(a.owner.cmp(&b.owner)));
    Ok(EveryTickResult {
        slot,
        slot_start_ms,
        admitted,
    })
}
// W04.2 vectors: transcribed from conformance/fixtures/policy/every.json
// (sha256 48d193bc044174293e2f19f2cea0826b22b22fce6d106dc9f503168e46b3deab); 29 cases. Frozen occurrenceId bytes are
// host-owned: tick vectors pin fields + derive-call multiset + order,
// and the kernel wiring of the supplied stub id. Generated, never hand-edited.
