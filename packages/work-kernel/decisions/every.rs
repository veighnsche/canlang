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
#[cfg(test)]
mod vectors_every {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    type DeriveCall = (U16, U16, U16, U16, f64);
    fn lossy(u: &U16) -> String {
        u.0.iter()
            .map(|c| char::from_u32(*c as u32).unwrap_or('\u{FFFD}'))
            .collect()
    }
    fn stub(app: &U16, handler: &U16, scope: &U16, owner: &U16, slot: f64) -> U16 {
        U16::from_utf8(&format!(
            "stub:{}:{}:{}:{}:{}",
            lossy(app),
            lossy(handler),
            lossy(scope),
            lossy(owner),
            slot
        ))
    }
    #[test]
    fn v_slot_zero() {
        assert_eq!(
            compute_every_slot(0.0, 1000.0),
            Ok(EverySlot {
                slot: 0.0,
                slot_start_ms: 0.0
            })
        );
    }
    #[test]
    fn v_slot_mid() {
        assert_eq!(
            compute_every_slot(1500.0, 1000.0),
            Ok(EverySlot {
                slot: 1.0,
                slot_start_ms: 1000.0
            })
        );
    }
    #[test]
    fn v_slot_exact_boundary() {
        assert_eq!(
            compute_every_slot(2000.0, 1000.0),
            Ok(EverySlot {
                slot: 2.0,
                slot_start_ms: 2000.0
            })
        );
    }
    #[test]
    fn v_slot_fractional_now() {
        assert_eq!(
            compute_every_slot(1500.9, 1000.0),
            Ok(EverySlot {
                slot: 1.0,
                slot_start_ms: 1000.0
            })
        );
    }
    #[test]
    fn v_slot_minute_period() {
        assert_eq!(
            compute_every_slot(91500.0, 60000.0),
            Ok(EverySlot {
                slot: 60.0,
                slot_start_ms: 60000.0
            })
        );
    }
    #[test]
    fn v_slot_bad_now() {
        assert_eq!(
            compute_every_slot(-1.0, 1000.0),
            Err(EveryError {
                name: "RangeError".to_string(),
                code: None,
                scope: None,
                message: "computeEverySlot: nowMs must be finite UTC epoch ms >= 0".to_string()
            })
        );
    }
    #[test]
    fn v_slot_nan_now() {
        assert_eq!(
            compute_every_slot(f64::NAN, 1000.0),
            Err(EveryError {
                name: "RangeError".to_string(),
                code: None,
                scope: None,
                message: "computeEverySlot: nowMs must be finite UTC epoch ms >= 0".to_string()
            })
        );
    }
    #[test]
    fn v_slot_zero_period() {
        assert_eq!(
            compute_every_slot(1000.0, 0.0),
            Err(EveryError {
                name: "RangeError".to_string(),
                code: None,
                scope: None,
                message: "computeEverySlot: periodMs must be a positive integer multiple of 1000"
                    .to_string()
            })
        );
    }
    #[test]
    fn v_slot_nonmultiple_period() {
        assert_eq!(
            compute_every_slot(1000.0, 1500.0),
            Err(EveryError {
                name: "RangeError".to_string(),
                code: None,
                scope: None,
                message: "computeEverySlot: periodMs must be a positive integer multiple of 1000"
                    .to_string()
            })
        );
    }
    #[test]
    fn v_slot_fractional_period() {
        assert_eq!(
            compute_every_slot(1000.0, 2500.5),
            Err(EveryError {
                name: "RangeError".to_string(),
                code: None,
                scope: None,
                message: "computeEverySlot: periodMs must be a positive integer multiple of 1000"
                    .to_string()
            })
        );
    }
    #[test]
    fn v_scope_key() {
        assert_eq!(
            every_scope_key(&U16::from_utf8("team"), &U16::from_utf8("o1")),
            U16::from_utf8("team:o1")
        );
    }
    #[test]
    fn v_tick_empty_scopes() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![],
            previous_slots: vec![],
        };
        let calls: Rc<RefCell<Vec<DeriveCall>>> = Rc::new(RefCell::new(Vec::new()));
        let seen = Rc::clone(&calls);
        let derive = move |a: &U16, h: &U16, s: &U16, ow: &U16, slot: f64| {
            seen.borrow_mut()
                .push((a.clone(), h.clone(), s.clone(), ow.clone(), slot));
            stub(a, h, s, ow, slot)
        };
        let got = admit_every_tick(&input, &derive).expect("tick admits");
        assert_eq!(got.slot, 5.0);
        assert_eq!(got.slot_start_ms, 5000.0);
        assert_eq!(got.admitted.len(), 0);
        let mut want: Vec<DeriveCall> = vec![];
        let mut have = calls.borrow().clone();
        want.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        have.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        assert_eq!(have, want);
    }
    #[test]
    fn v_tick_admit_one() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![EveryScopeInput {
                scope: U16::from_utf8("team"),
                owner: U16::from_utf8("t1"),
            }],
            previous_slots: vec![(U16::from_utf8("team:t1"), PrevSlot::Num(3.0))],
        };
        let calls: Rc<RefCell<Vec<DeriveCall>>> = Rc::new(RefCell::new(Vec::new()));
        let seen = Rc::clone(&calls);
        let derive = move |a: &U16, h: &U16, s: &U16, ow: &U16, slot: f64| {
            seen.borrow_mut()
                .push((a.clone(), h.clone(), s.clone(), ow.clone(), slot));
            stub(a, h, s, ow, slot)
        };
        let got = admit_every_tick(&input, &derive).expect("tick admits");
        assert_eq!(got.slot, 5.0);
        assert_eq!(got.slot_start_ms, 5000.0);
        assert_eq!(got.admitted.len(), 1);
        assert_eq!(got.admitted[0].app, U16::from_utf8("a"));
        assert_eq!(got.admitted[0].handler, U16::from_utf8("h"));
        assert_eq!(got.admitted[0].scope, U16::from_utf8("team"));
        assert_eq!(got.admitted[0].owner, U16::from_utf8("t1"));
        assert_eq!(got.admitted[0].slot, 5.0);
        assert_eq!(
            got.admitted[0].occurrence_id,
            stub(
                &U16::from_utf8("a"),
                &U16::from_utf8("h"),
                &U16::from_utf8("team"),
                &U16::from_utf8("t1"),
                5.0
            )
        );
        let mut want: Vec<DeriveCall> = vec![(
            U16::from_utf8("a"),
            U16::from_utf8("h"),
            U16::from_utf8("team"),
            U16::from_utf8("t1"),
            5.0,
        )];
        let mut have = calls.borrow().clone();
        want.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        have.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        assert_eq!(have, want);
    }
    #[test]
    fn v_tick_new_scope() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![EveryScopeInput {
                scope: U16::from_utf8("app"),
                owner: U16::from_utf8("n1"),
            }],
            previous_slots: vec![],
        };
        let calls: Rc<RefCell<Vec<DeriveCall>>> = Rc::new(RefCell::new(Vec::new()));
        let seen = Rc::clone(&calls);
        let derive = move |a: &U16, h: &U16, s: &U16, ow: &U16, slot: f64| {
            seen.borrow_mut()
                .push((a.clone(), h.clone(), s.clone(), ow.clone(), slot));
            stub(a, h, s, ow, slot)
        };
        let got = admit_every_tick(&input, &derive).expect("tick admits");
        assert_eq!(got.slot, 5.0);
        assert_eq!(got.slot_start_ms, 5000.0);
        assert_eq!(got.admitted.len(), 0);
        let mut want: Vec<DeriveCall> = vec![];
        let mut have = calls.borrow().clone();
        want.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        have.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        assert_eq!(have, want);
    }
    #[test]
    fn v_tick_removed_scope() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![],
            previous_slots: vec![(U16::from_utf8("team:gone"), PrevSlot::Num(1.0))],
        };
        let calls: Rc<RefCell<Vec<DeriveCall>>> = Rc::new(RefCell::new(Vec::new()));
        let seen = Rc::clone(&calls);
        let derive = move |a: &U16, h: &U16, s: &U16, ow: &U16, slot: f64| {
            seen.borrow_mut()
                .push((a.clone(), h.clone(), s.clone(), ow.clone(), slot));
            stub(a, h, s, ow, slot)
        };
        let got = admit_every_tick(&input, &derive).expect("tick admits");
        assert_eq!(got.slot, 5.0);
        assert_eq!(got.slot_start_ms, 5000.0);
        assert_eq!(got.admitted.len(), 0);
        let mut want: Vec<DeriveCall> = vec![];
        let mut have = calls.borrow().clone();
        want.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        have.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        assert_eq!(have, want);
    }
    #[test]
    fn v_tick_previous_eq_slot() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![EveryScopeInput {
                scope: U16::from_utf8("team"),
                owner: U16::from_utf8("t1"),
            }],
            previous_slots: vec![(U16::from_utf8("team:t1"), PrevSlot::Num(5.0))],
        };
        let calls: Rc<RefCell<Vec<DeriveCall>>> = Rc::new(RefCell::new(Vec::new()));
        let seen = Rc::clone(&calls);
        let derive = move |a: &U16, h: &U16, s: &U16, ow: &U16, slot: f64| {
            seen.borrow_mut()
                .push((a.clone(), h.clone(), s.clone(), ow.clone(), slot));
            stub(a, h, s, ow, slot)
        };
        let got = admit_every_tick(&input, &derive).expect("tick admits");
        assert_eq!(got.slot, 5.0);
        assert_eq!(got.slot_start_ms, 5000.0);
        assert_eq!(got.admitted.len(), 0);
        let mut want: Vec<DeriveCall> = vec![];
        let mut have = calls.borrow().clone();
        want.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        have.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        assert_eq!(have, want);
    }
    #[test]
    fn v_tick_previous_gt_slot() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![EveryScopeInput {
                scope: U16::from_utf8("team"),
                owner: U16::from_utf8("t1"),
            }],
            previous_slots: vec![(U16::from_utf8("team:t1"), PrevSlot::Num(9.0))],
        };
        let calls: Rc<RefCell<Vec<DeriveCall>>> = Rc::new(RefCell::new(Vec::new()));
        let seen = Rc::clone(&calls);
        let derive = move |a: &U16, h: &U16, s: &U16, ow: &U16, slot: f64| {
            seen.borrow_mut()
                .push((a.clone(), h.clone(), s.clone(), ow.clone(), slot));
            stub(a, h, s, ow, slot)
        };
        let got = admit_every_tick(&input, &derive).expect("tick admits");
        assert_eq!(got.slot, 5.0);
        assert_eq!(got.slot_start_ms, 5000.0);
        assert_eq!(got.admitted.len(), 0);
        let mut want: Vec<DeriveCall> = vec![];
        let mut have = calls.borrow().clone();
        want.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        have.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        assert_eq!(have, want);
    }
    #[test]
    fn v_tick_duplicate_scopes() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![
                EveryScopeInput {
                    scope: U16::from_utf8("team"),
                    owner: U16::from_utf8("t1"),
                },
                EveryScopeInput {
                    scope: U16::from_utf8("team"),
                    owner: U16::from_utf8("t1"),
                },
            ],
            previous_slots: vec![(U16::from_utf8("team:t1"), PrevSlot::Num(0.0))],
        };
        let calls: Rc<RefCell<Vec<DeriveCall>>> = Rc::new(RefCell::new(Vec::new()));
        let seen = Rc::clone(&calls);
        let derive = move |a: &U16, h: &U16, s: &U16, ow: &U16, slot: f64| {
            seen.borrow_mut()
                .push((a.clone(), h.clone(), s.clone(), ow.clone(), slot));
            stub(a, h, s, ow, slot)
        };
        let got = admit_every_tick(&input, &derive).expect("tick admits");
        assert_eq!(got.slot, 5.0);
        assert_eq!(got.slot_start_ms, 5000.0);
        assert_eq!(got.admitted.len(), 1);
        assert_eq!(got.admitted[0].app, U16::from_utf8("a"));
        assert_eq!(got.admitted[0].handler, U16::from_utf8("h"));
        assert_eq!(got.admitted[0].scope, U16::from_utf8("team"));
        assert_eq!(got.admitted[0].owner, U16::from_utf8("t1"));
        assert_eq!(got.admitted[0].slot, 5.0);
        assert_eq!(
            got.admitted[0].occurrence_id,
            stub(
                &U16::from_utf8("a"),
                &U16::from_utf8("h"),
                &U16::from_utf8("team"),
                &U16::from_utf8("t1"),
                5.0
            )
        );
        let mut want: Vec<DeriveCall> = vec![(
            U16::from_utf8("a"),
            U16::from_utf8("h"),
            U16::from_utf8("team"),
            U16::from_utf8("t1"),
            5.0,
        )];
        let mut have = calls.borrow().clone();
        want.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        have.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        assert_eq!(have, want);
    }
    #[test]
    fn v_tick_sorted() {
        let input = EveryTickInput {
            now_ms: 61000.0,
            period_ms: 60000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![
                EveryScopeInput {
                    scope: U16::from_utf8("team"),
                    owner: U16::from_utf8("b"),
                },
                EveryScopeInput {
                    scope: U16::from_utf8("app"),
                    owner: U16::from_utf8("a"),
                },
                EveryScopeInput {
                    scope: U16::from_utf8("team"),
                    owner: U16::from_utf8("a"),
                },
            ],
            previous_slots: vec![
                (U16::from_utf8("team:b"), PrevSlot::Num(0.0)),
                (U16::from_utf8("app:a"), PrevSlot::Num(0.0)),
                (U16::from_utf8("team:a"), PrevSlot::Num(0.0)),
            ],
        };
        let calls: Rc<RefCell<Vec<DeriveCall>>> = Rc::new(RefCell::new(Vec::new()));
        let seen = Rc::clone(&calls);
        let derive = move |a: &U16, h: &U16, s: &U16, ow: &U16, slot: f64| {
            seen.borrow_mut()
                .push((a.clone(), h.clone(), s.clone(), ow.clone(), slot));
            stub(a, h, s, ow, slot)
        };
        let got = admit_every_tick(&input, &derive).expect("tick admits");
        assert_eq!(got.slot, 60.0);
        assert_eq!(got.slot_start_ms, 60000.0);
        assert_eq!(got.admitted.len(), 3);
        assert_eq!(got.admitted[0].app, U16::from_utf8("a"));
        assert_eq!(got.admitted[0].handler, U16::from_utf8("h"));
        assert_eq!(got.admitted[0].scope, U16::from_utf8("app"));
        assert_eq!(got.admitted[0].owner, U16::from_utf8("a"));
        assert_eq!(got.admitted[0].slot, 60.0);
        assert_eq!(
            got.admitted[0].occurrence_id,
            stub(
                &U16::from_utf8("a"),
                &U16::from_utf8("h"),
                &U16::from_utf8("app"),
                &U16::from_utf8("a"),
                60.0
            )
        );
        assert_eq!(got.admitted[1].app, U16::from_utf8("a"));
        assert_eq!(got.admitted[1].handler, U16::from_utf8("h"));
        assert_eq!(got.admitted[1].scope, U16::from_utf8("team"));
        assert_eq!(got.admitted[1].owner, U16::from_utf8("a"));
        assert_eq!(got.admitted[1].slot, 60.0);
        assert_eq!(
            got.admitted[1].occurrence_id,
            stub(
                &U16::from_utf8("a"),
                &U16::from_utf8("h"),
                &U16::from_utf8("team"),
                &U16::from_utf8("a"),
                60.0
            )
        );
        assert_eq!(got.admitted[2].app, U16::from_utf8("a"));
        assert_eq!(got.admitted[2].handler, U16::from_utf8("h"));
        assert_eq!(got.admitted[2].scope, U16::from_utf8("team"));
        assert_eq!(got.admitted[2].owner, U16::from_utf8("b"));
        assert_eq!(got.admitted[2].slot, 60.0);
        assert_eq!(
            got.admitted[2].occurrence_id,
            stub(
                &U16::from_utf8("a"),
                &U16::from_utf8("h"),
                &U16::from_utf8("team"),
                &U16::from_utf8("b"),
                60.0
            )
        );
        let mut want: Vec<DeriveCall> = vec![
            (
                U16::from_utf8("a"),
                U16::from_utf8("h"),
                U16::from_utf8("app"),
                U16::from_utf8("a"),
                60.0,
            ),
            (
                U16::from_utf8("a"),
                U16::from_utf8("h"),
                U16::from_utf8("team"),
                U16::from_utf8("a"),
                60.0,
            ),
            (
                U16::from_utf8("a"),
                U16::from_utf8("h"),
                U16::from_utf8("team"),
                U16::from_utf8("b"),
                60.0,
            ),
        ];
        let mut have = calls.borrow().clone();
        want.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        have.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        assert_eq!(have, want);
    }
    #[test]
    fn v_tick_coalesce() {
        let input = EveryTickInput {
            now_ms: 500000.0,
            period_ms: 1000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![EveryScopeInput {
                scope: U16::from_utf8("team"),
                owner: U16::from_utf8("t1"),
            }],
            previous_slots: vec![(U16::from_utf8("team:t1"), PrevSlot::Num(2.0))],
        };
        let calls: Rc<RefCell<Vec<DeriveCall>>> = Rc::new(RefCell::new(Vec::new()));
        let seen = Rc::clone(&calls);
        let derive = move |a: &U16, h: &U16, s: &U16, ow: &U16, slot: f64| {
            seen.borrow_mut()
                .push((a.clone(), h.clone(), s.clone(), ow.clone(), slot));
            stub(a, h, s, ow, slot)
        };
        let got = admit_every_tick(&input, &derive).expect("tick admits");
        assert_eq!(got.slot, 500.0);
        assert_eq!(got.slot_start_ms, 500000.0);
        assert_eq!(got.admitted.len(), 1);
        assert_eq!(got.admitted[0].app, U16::from_utf8("a"));
        assert_eq!(got.admitted[0].handler, U16::from_utf8("h"));
        assert_eq!(got.admitted[0].scope, U16::from_utf8("team"));
        assert_eq!(got.admitted[0].owner, U16::from_utf8("t1"));
        assert_eq!(got.admitted[0].slot, 500.0);
        assert_eq!(
            got.admitted[0].occurrence_id,
            stub(
                &U16::from_utf8("a"),
                &U16::from_utf8("h"),
                &U16::from_utf8("team"),
                &U16::from_utf8("t1"),
                500.0
            )
        );
        let mut want: Vec<DeriveCall> = vec![(
            U16::from_utf8("a"),
            U16::from_utf8("h"),
            U16::from_utf8("team"),
            U16::from_utf8("t1"),
            500.0,
        )];
        let mut have = calls.borrow().clone();
        want.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        have.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        assert_eq!(have, want);
    }
    #[test]
    fn v_tick_colon_owner() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![EveryScopeInput {
                scope: U16::from_utf8("team"),
                owner: U16::from_utf8("a:b"),
            }],
            previous_slots: vec![(U16::from_utf8("team:a:b"), PrevSlot::Num(1.0))],
        };
        let calls: Rc<RefCell<Vec<DeriveCall>>> = Rc::new(RefCell::new(Vec::new()));
        let seen = Rc::clone(&calls);
        let derive = move |a: &U16, h: &U16, s: &U16, ow: &U16, slot: f64| {
            seen.borrow_mut()
                .push((a.clone(), h.clone(), s.clone(), ow.clone(), slot));
            stub(a, h, s, ow, slot)
        };
        let got = admit_every_tick(&input, &derive).expect("tick admits");
        assert_eq!(got.slot, 5.0);
        assert_eq!(got.slot_start_ms, 5000.0);
        assert_eq!(got.admitted.len(), 1);
        assert_eq!(got.admitted[0].app, U16::from_utf8("a"));
        assert_eq!(got.admitted[0].handler, U16::from_utf8("h"));
        assert_eq!(got.admitted[0].scope, U16::from_utf8("team"));
        assert_eq!(got.admitted[0].owner, U16::from_utf8("a:b"));
        assert_eq!(got.admitted[0].slot, 5.0);
        assert_eq!(
            got.admitted[0].occurrence_id,
            stub(
                &U16::from_utf8("a"),
                &U16::from_utf8("h"),
                &U16::from_utf8("team"),
                &U16::from_utf8("a:b"),
                5.0
            )
        );
        let mut want: Vec<DeriveCall> = vec![(
            U16::from_utf8("a"),
            U16::from_utf8("h"),
            U16::from_utf8("team"),
            U16::from_utf8("a:b"),
            5.0,
        )];
        let mut have = calls.borrow().clone();
        want.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        have.sort_by(|x, y| {
            (
                x.0.clone(),
                x.1.clone(),
                x.2.clone(),
                x.3.clone(),
                x.4.to_bits(),
            )
                .cmp(&(
                    y.0.clone(),
                    y.1.clone(),
                    y.2.clone(),
                    y.3.clone(),
                    y.4.to_bits(),
                ))
        });
        assert_eq!(have, want);
    }
    #[test]
    fn v_tick_root_scope() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![EveryScopeInput {
                scope: U16::from_utf8("root"),
                owner: U16::from_utf8("r"),
            }],
            previous_slots: vec![],
        };
        let derive = |_: &U16, _: &U16, _: &U16, _: &U16, _: f64| U16::from_utf8("unused");
        assert_eq!(admit_every_tick(&input, &derive), Err(EveryError { name: "RootRecurrenceNotSupportedError".to_string(), code: Some("ROOT_RECURRING_UNSUPPORTED".to_string()), scope: Some(U16::from_utf8("root")), message: "work: recurring every() fanout covers team/app scopes only; rejected scope 'root' (root recurrence uses explicit record-bound schedule)".to_string() }));
    }
    #[test]
    fn v_tick_empty_owner() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![EveryScopeInput {
                scope: U16::from_utf8("team"),
                owner: U16::from_utf8(""),
            }],
            previous_slots: vec![],
        };
        let derive = |_: &U16, _: &U16, _: &U16, _: &U16, _: f64| U16::from_utf8("unused");
        assert_eq!(
            admit_every_tick(&input, &derive),
            Err(EveryError {
                name: "RangeError".to_string(),
                code: None,
                scope: None,
                message: "admitEveryTick: scope owner must be a non-empty string".to_string()
            })
        );
    }
    #[test]
    fn v_tick_empty_app() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1000.0,
            app: U16::from_utf8(""),
            handler: U16::from_utf8("h"),
            scopes: vec![],
            previous_slots: vec![],
        };
        let derive = |_: &U16, _: &U16, _: &U16, _: &U16, _: f64| U16::from_utf8("unused");
        assert_eq!(
            admit_every_tick(&input, &derive),
            Err(EveryError {
                name: "RangeError".to_string(),
                code: None,
                scope: None,
                message: "admitEveryTick: app must be a non-empty string".to_string()
            })
        );
    }
    #[test]
    fn v_tick_empty_handler() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8(""),
            scopes: vec![],
            previous_slots: vec![],
        };
        let derive = |_: &U16, _: &U16, _: &U16, _: &U16, _: f64| U16::from_utf8("unused");
        assert_eq!(
            admit_every_tick(&input, &derive),
            Err(EveryError {
                name: "RangeError".to_string(),
                code: None,
                scope: None,
                message: "admitEveryTick: handler must be a non-empty string".to_string()
            })
        );
    }
    #[test]
    fn v_tick_bad_previous_fraction() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![EveryScopeInput {
                scope: U16::from_utf8("team"),
                owner: U16::from_utf8("t1"),
            }],
            previous_slots: vec![(U16::from_utf8("team:t1"), PrevSlot::Num(1.5))],
        };
        let derive = |_: &U16, _: &U16, _: &U16, _: &U16, _: f64| U16::from_utf8("unused");
        assert_eq!(
            admit_every_tick(&input, &derive),
            Err(EveryError {
                name: "RangeError".to_string(),
                code: None,
                scope: None,
                message: "admitEveryTick: previous slot for team:t1 must be a non-negative integer"
                    .to_string()
            })
        );
    }
    #[test]
    fn v_tick_bad_previous_negative() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![EveryScopeInput {
                scope: U16::from_utf8("team"),
                owner: U16::from_utf8("t1"),
            }],
            previous_slots: vec![(U16::from_utf8("team:t1"), PrevSlot::Num(-2.0))],
        };
        let derive = |_: &U16, _: &U16, _: &U16, _: &U16, _: f64| U16::from_utf8("unused");
        assert_eq!(
            admit_every_tick(&input, &derive),
            Err(EveryError {
                name: "RangeError".to_string(),
                code: None,
                scope: None,
                message: "admitEveryTick: previous slot for team:t1 must be a non-negative integer"
                    .to_string()
            })
        );
    }
    #[test]
    fn v_tick_bad_previous_type() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1000.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![EveryScopeInput {
                scope: U16::from_utf8("team"),
                owner: U16::from_utf8("t1"),
            }],
            previous_slots: vec![(U16::from_utf8("team:t1"), PrevSlot::Other)],
        };
        let derive = |_: &U16, _: &U16, _: &U16, _: &U16, _: f64| U16::from_utf8("unused");
        assert_eq!(
            admit_every_tick(&input, &derive),
            Err(EveryError {
                name: "RangeError".to_string(),
                code: None,
                scope: None,
                message: "admitEveryTick: previous slot for team:t1 must be a non-negative integer"
                    .to_string()
            })
        );
    }
    #[test]
    fn v_tick_bad_period() {
        let input = EveryTickInput {
            now_ms: 5000.0,
            period_ms: 1500.0,
            app: U16::from_utf8("a"),
            handler: U16::from_utf8("h"),
            scopes: vec![],
            previous_slots: vec![],
        };
        let derive = |_: &U16, _: &U16, _: &U16, _: &U16, _: f64| U16::from_utf8("unused");
        assert_eq!(
            admit_every_tick(&input, &derive),
            Err(EveryError {
                name: "RangeError".to_string(),
                code: None,
                scope: None,
                message: "computeEverySlot: periodMs must be a positive integer multiple of 1000"
                    .to_string()
            })
        );
    }
}
