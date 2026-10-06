//! W04.2 — Native outbox item lifecycle transitions.
//!
//! Data-only Rust port of `src/lifecycle.ts`, proven against the same
//! independent TS oracle corpus (`conformance/fixtures/policy/lifecycle.json`).
//! Standalone file: compiles and tests with
//! `rustc --edition 2021 --test decisions/lifecycle.rs` — no Cargo
//! membership, no dependencies, no host I/O. The small shared prelude
//! (UTF-16 text, passthrough data values, retry policy vocabulary) is
//! duplicated per decisions file until W04.4 assembly consolidates it.

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
    fn push_lossy(&self, out: &mut String) {
        for u in self.0.iter() {
            out.push(char::from_u32(*u as u32).unwrap_or('\u{FFFD}'));
        }
    }
}

impl std::fmt::Debug for U16 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("\"")?;
        let mut s = String::new();
        self.push_lossy(&mut s);
        f.write_str(&s)?;
        f.write_str("\"")
    }
}

/// Passthrough provider data: compared structurally, never inspected.
#[derive(Clone, Debug)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(U16),
    Arr(Vec<Value>),
    Obj(Vec<(U16, Value)>),
    Map(Rc<Vec<(Value, Value)>>),
    Set(Rc<Vec<Value>>),
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
            (Value::Map(a), Value::Map(b)) => a == b,
            (Value::Set(a), Value::Set(b)) => a == b,
            _ => false,
        }
    }
}

/// Parity error: name/message match the TS donor.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct LifecycleError {
    pub name: String,
    pub message: String,
}

fn range_error(message: String) -> LifecycleError {
    LifecycleError {
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

pub fn classify_failure(cause: &FailureCause) -> U16 {
    match cause {
        FailureCause::Transient { .. } => U16::from_utf8("transient"),
        _ => U16::from_utf8("terminal"),
    }
}

/// Shared retry-policy guard (also used by backoff schedule paths).
pub fn assert_policy(policy: &RetryPolicy) -> Result<(), LifecycleError> {
    if policy.max_attempts.fract() != 0.0 || policy.max_attempts < 1.0 {
        return Err(range_error(
            "receipt: policy.maxAttempts must be an integer >= 1".to_string(),
        ));
    }
    if !policy.horizon_ms.is_finite() || policy.horizon_ms <= 0.0 {
        return Err(range_error(
            "receipt: policy.horizonMs must be finite and > 0".to_string(),
        ));
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

/// Definitive-or-ambiguous outcome of one provider-call attempt.
#[derive(Clone, PartialEq, Debug)]
pub enum ProviderOutcome {
    Delivered {
        result: Value,
    },
    Failed {
        cause: FailureCause,
    },
    /// Timeout or missing evidence: the provider may have acted.
    Uncertain,
}

pub struct RecordOutcomeInput {
    /// Live item (`pending` or `claimed`); anything else throws.
    pub item: OutboxItem,
    pub outcome: ProviderOutcome,
    pub now_ms: f64,
    pub first_attempt_at_ms: f64,
    pub policy: Option<RetryPolicy>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct ReceiptError {
    pub code: U16,
    pub message: U16,
}

#[derive(Clone, PartialEq, Debug)]
pub struct RecordedOutcome {
    pub item: OutboxItem,
    pub status: U16,
    pub result: Value,
    pub error: Option<ReceiptError>,
    pub retry_class: Option<U16>,
    pub retryable: bool,
}

fn closed_error_for_cause(cause: &FailureCause) -> ReceiptError {
    match cause {
        FailureCause::HandlerRequireFalse { .. } => ReceiptError {
            code: U16::from_utf8("require-false"),
            message: U16::from_utf8("handler requirement rejected the occurrence"),
        },
        FailureCause::Permanent { code, message } | FailureCause::Transient { code, message } => {
            ReceiptError {
                code: code.clone(),
                message: message.clone(),
            }
        }
    }
}

/**
 * Record one attempt outcome. Transient failures keep the item `pending`
 * under the SAME occurrence id until the attempt cap or horizon moves it
 * to `dead`; terminal failures move it to `failed`; ambiguity moves it to
 * `uncertain`. Terminal and uncertain items never pass through here again.
 */
pub fn record_outcome(input: &RecordOutcomeInput) -> Result<RecordedOutcome, LifecycleError> {
    if !input.item.state.eq_ascii("pending") && !input.item.state.eq_ascii("claimed") {
        let mut message = "recordOutcome: item ".to_string();
        input.item.id.push_lossy(&mut message);
        message.push_str(" is ");
        input.item.state.push_lossy(&mut message);
        message.push_str("; outcomes apply to pending/claimed items only");
        return Err(LifecycleError {
            name: "Error".to_string(),
            message,
        });
    }
    if !input.now_ms.is_finite() || input.now_ms < 0.0 {
        return Err(range_error(
            "recordOutcome: nowMs must be finite and >= 0".to_string(),
        ));
    }
    if !input.first_attempt_at_ms.is_finite() || input.first_attempt_at_ms < 0.0 {
        return Err(range_error(
            "recordOutcome: firstAttemptAtMs must be finite and >= 0".to_string(),
        ));
    }
    let policy = input.policy.clone().unwrap_or_else(default_retry_policy);
    assert_policy(&policy)?;
    let attempts = input.item.attempts + 1.0;

    match &input.outcome {
        ProviderOutcome::Delivered { result } => {
            let mut item = input.item.clone();
            item.attempts = attempts;
            item.state = U16::from_utf8("delivered");
            Ok(RecordedOutcome {
                item,
                status: U16::from_utf8("succeeded"),
                result: result.clone(),
                error: None,
                retry_class: None,
                retryable: false,
            })
        }
        ProviderOutcome::Uncertain => {
            let mut item = input.item.clone();
            item.attempts = attempts;
            item.state = U16::from_utf8("uncertain");
            Ok(RecordedOutcome {
                item,
                status: U16::from_utf8("unknown"),
                result: Value::Null,
                error: None,
                retry_class: None,
                retryable: false,
            })
        }
        ProviderOutcome::Failed { cause } => {
            let retry_class = classify_failure(cause);
            if retry_class.eq_ascii("terminal") {
                let mut item = input.item.clone();
                item.attempts = attempts;
                item.state = U16::from_utf8("failed");
                return Ok(RecordedOutcome {
                    item,
                    status: U16::from_utf8("failed"),
                    result: Value::Null,
                    error: Some(closed_error_for_cause(cause)),
                    retry_class: Some(retry_class),
                    retryable: false,
                });
            }
            let attempts_exhausted = attempts >= policy.max_attempts;
            let horizon_exceeded = input.now_ms - input.first_attempt_at_ms >= policy.horizon_ms;
            if attempts_exhausted || horizon_exceeded {
                let mut item = input.item.clone();
                item.attempts = attempts;
                item.state = U16::from_utf8("dead");
                let error = if attempts_exhausted {
                    ReceiptError {
                        code: U16::from_utf8("retry-exhausted"),
                        message: U16::from_utf8("retry attempt budget exhausted"),
                    }
                } else {
                    ReceiptError {
                        code: U16::from_utf8("retry-horizon-exceeded"),
                        message: U16::from_utf8("retry horizon exceeded"),
                    }
                };
                return Ok(RecordedOutcome {
                    item,
                    status: U16::from_utf8("failed"),
                    result: Value::Null,
                    error: Some(error),
                    retry_class: Some(retry_class),
                    retryable: false,
                });
            }
            let mut item = input.item.clone();
            item.attempts = attempts;
            item.state = U16::from_utf8("pending");
            Ok(RecordedOutcome {
                item,
                status: U16::from_utf8("pending"),
                result: Value::Null,
                error: None,
                retry_class: Some(retry_class),
                retryable: true,
            })
        }
    }
}

/// Proof of what the provider did for an uncertain item.
#[derive(Clone, PartialEq, Debug)]
pub enum ReconcileEvidence {
    Delivered { result: Value },
    Failed { code: U16, message: U16 },
    NotFound,
}

#[derive(Clone, PartialEq, Debug)]
pub struct ReconcileResult {
    pub item: OutboxItem,
    pub changed: bool,
    /// Receipt fields for the transition; all null when unchanged.
    pub status: Option<U16>,
    pub result: Value,
    pub error: Option<ReceiptError>,
}

/**
 * Reconcile an uncertain item against evidence. Unknown stays unknown
 * until evidence arrives (`None` is a no-op), and non-uncertain items
 * are never touched through this path.
 */
pub fn reconcile_uncertain(
    item: &OutboxItem,
    evidence: &Option<ReconcileEvidence>,
) -> ReconcileResult {
    if !item.state.eq_ascii("uncertain") || evidence.is_none() {
        return ReconcileResult {
            item: item.clone(),
            changed: false,
            status: None,
            result: Value::Null,
            error: None,
        };
    }
    match evidence.as_ref().unwrap() {
        ReconcileEvidence::Delivered { result } => {
            let mut item = item.clone();
            item.state = U16::from_utf8("delivered");
            ReconcileResult {
                item,
                changed: true,
                status: Some(U16::from_utf8("succeeded")),
                result: result.clone(),
                error: None,
            }
        }
        ReconcileEvidence::Failed { code, message } => {
            let mut item = item.clone();
            item.state = U16::from_utf8("failed");
            ReconcileResult {
                item,
                changed: true,
                status: Some(U16::from_utf8("failed")),
                result: Value::Null,
                error: Some(ReceiptError {
                    code: code.clone(),
                    message: message.clone(),
                }),
            }
        }
        ReconcileEvidence::NotFound => {
            let mut item = item.clone();
            item.state = U16::from_utf8("pending");
            ReconcileResult {
                item,
                changed: true,
                status: Some(U16::from_utf8("pending")),
                result: Value::Null,
                error: None,
            }
        }
    }
}
// W04.2 vectors: transcribed from conformance/fixtures/policy/lifecycle.json
// (sha256 a78374dcd84bc3be4077cbba57e2012aebf9fb16628c8f93cd05803221fe9751); 18 cases. The frozen file is the
// oracle: this module is generated, never hand-edited.
#[cfg(test)]
mod vectors_lifecycle {
    use super::*;
    #[test]
    fn v_record_delivered() {
        let input = RecordOutcomeInput {
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
            outcome: ProviderOutcome::Delivered {
                result: Value::Obj(vec![(
                    U16::from_utf8("v"),
                    Value::Arr(vec![Value::Num(1.0), Value::Str(U16::from_utf8("a"))]),
                )]),
            },
            now_ms: 50.0,
            first_attempt_at_ms: 10.0,
            policy: None,
        };
        assert_eq!(
            record_outcome(&input),
            Ok(RecordedOutcome {
                item: OutboxItem {
                    id: U16::from_utf8("obx-1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 1.0,
                    state: U16::from_utf8("delivered")
                },
                status: U16::from_utf8("succeeded"),
                result: Value::Obj(vec![(
                    U16::from_utf8("v"),
                    Value::Arr(vec![Value::Num(1.0), Value::Str(U16::from_utf8("a"))])
                )]),
                error: None,
                retry_class: None,
                retryable: false
            })
        );
    }
    #[test]
    fn v_record_delivered_claimed() {
        let input = RecordOutcomeInput {
            item: OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 2.0,
                state: U16::from_utf8("claimed"),
            },
            outcome: ProviderOutcome::Delivered {
                result: Value::Null,
            },
            now_ms: 60.0,
            first_attempt_at_ms: 10.0,
            policy: None,
        };
        assert_eq!(
            record_outcome(&input),
            Ok(RecordedOutcome {
                item: OutboxItem {
                    id: U16::from_utf8("obx-1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 3.0,
                    state: U16::from_utf8("delivered")
                },
                status: U16::from_utf8("succeeded"),
                result: Value::Null,
                error: None,
                retry_class: None,
                retryable: false
            })
        );
    }
    #[test]
    fn v_record_uncertain() {
        let input = RecordOutcomeInput {
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
            outcome: ProviderOutcome::Uncertain,
            now_ms: 50.0,
            first_attempt_at_ms: 10.0,
            policy: None,
        };
        assert_eq!(
            record_outcome(&input),
            Ok(RecordedOutcome {
                item: OutboxItem {
                    id: U16::from_utf8("obx-1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 1.0,
                    state: U16::from_utf8("uncertain")
                },
                status: U16::from_utf8("unknown"),
                result: Value::Null,
                error: None,
                retry_class: None,
                retryable: false
            })
        );
    }
    #[test]
    fn v_record_transient_retryable() {
        let input = RecordOutcomeInput {
            item: OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 3.0,
                state: U16::from_utf8("pending"),
            },
            outcome: ProviderOutcome::Failed {
                cause: FailureCause::Transient {
                    code: U16::from_utf8("EIO"),
                    message: U16::from_utf8("io"),
                },
            },
            now_ms: 5000.0,
            first_attempt_at_ms: 10.0,
            policy: None,
        };
        assert_eq!(
            record_outcome(&input),
            Ok(RecordedOutcome {
                item: OutboxItem {
                    id: U16::from_utf8("obx-1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 4.0,
                    state: U16::from_utf8("pending")
                },
                status: U16::from_utf8("pending"),
                result: Value::Null,
                error: None,
                retry_class: Some(U16::from_utf8("transient")),
                retryable: true
            })
        );
    }
    #[test]
    fn v_record_transient_exhausted_attempts() {
        let input = RecordOutcomeInput {
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
            outcome: ProviderOutcome::Failed {
                cause: FailureCause::Transient {
                    code: U16::from_utf8("E"),
                    message: U16::from_utf8("m"),
                },
            },
            now_ms: 5000.0,
            first_attempt_at_ms: 10.0,
            policy: None,
        };
        assert_eq!(
            record_outcome(&input),
            Ok(RecordedOutcome {
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
                status: U16::from_utf8("failed"),
                result: Value::Null,
                error: Some(ReceiptError {
                    code: U16::from_utf8("retry-exhausted"),
                    message: U16::from_utf8("retry attempt budget exhausted")
                }),
                retry_class: Some(U16::from_utf8("transient")),
                retryable: false
            })
        );
    }
    #[test]
    fn v_record_transient_horizon() {
        let input = RecordOutcomeInput {
            item: OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 1.0,
                state: U16::from_utf8("pending"),
            },
            outcome: ProviderOutcome::Failed {
                cause: FailureCause::Transient {
                    code: U16::from_utf8("E"),
                    message: U16::from_utf8("m"),
                },
            },
            now_ms: 86400010.0,
            first_attempt_at_ms: 10.0,
            policy: None,
        };
        assert_eq!(
            record_outcome(&input),
            Ok(RecordedOutcome {
                item: OutboxItem {
                    id: U16::from_utf8("obx-1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 2.0,
                    state: U16::from_utf8("dead")
                },
                status: U16::from_utf8("failed"),
                result: Value::Null,
                error: Some(ReceiptError {
                    code: U16::from_utf8("retry-horizon-exceeded"),
                    message: U16::from_utf8("retry horizon exceeded")
                }),
                retry_class: Some(U16::from_utf8("transient")),
                retryable: false
            })
        );
    }
    #[test]
    fn v_record_transient_both_exhausted() {
        let input = RecordOutcomeInput {
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
            outcome: ProviderOutcome::Failed {
                cause: FailureCause::Transient {
                    code: U16::from_utf8("E"),
                    message: U16::from_utf8("m"),
                },
            },
            now_ms: 86400010.0,
            first_attempt_at_ms: 10.0,
            policy: None,
        };
        assert_eq!(
            record_outcome(&input),
            Ok(RecordedOutcome {
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
                status: U16::from_utf8("failed"),
                result: Value::Null,
                error: Some(ReceiptError {
                    code: U16::from_utf8("retry-exhausted"),
                    message: U16::from_utf8("retry attempt budget exhausted")
                }),
                retry_class: Some(U16::from_utf8("transient")),
                retryable: false
            })
        );
    }
    #[test]
    fn v_record_permanent() {
        let input = RecordOutcomeInput {
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
            outcome: ProviderOutcome::Failed {
                cause: FailureCause::Permanent {
                    code: U16::from_utf8("EPERM"),
                    message: U16::from_utf8("no"),
                },
            },
            now_ms: 50.0,
            first_attempt_at_ms: 10.0,
            policy: None,
        };
        assert_eq!(
            record_outcome(&input),
            Ok(RecordedOutcome {
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
                status: U16::from_utf8("failed"),
                result: Value::Null,
                error: Some(ReceiptError {
                    code: U16::from_utf8("EPERM"),
                    message: U16::from_utf8("no")
                }),
                retry_class: Some(U16::from_utf8("terminal")),
                retryable: false
            })
        );
    }
    #[test]
    fn v_record_require_false() {
        let input = RecordOutcomeInput {
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
            outcome: ProviderOutcome::Failed {
                cause: FailureCause::HandlerRequireFalse {
                    require: U16::from_utf8("r1"),
                },
            },
            now_ms: 50.0,
            first_attempt_at_ms: 10.0,
            policy: None,
        };
        assert_eq!(
            record_outcome(&input),
            Ok(RecordedOutcome {
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
                status: U16::from_utf8("failed"),
                result: Value::Null,
                error: Some(ReceiptError {
                    code: U16::from_utf8("require-false"),
                    message: U16::from_utf8("handler requirement rejected the occurrence")
                }),
                retry_class: Some(U16::from_utf8("terminal")),
                retryable: false
            })
        );
    }
    #[test]
    fn v_record_bad_state() {
        let input = RecordOutcomeInput {
            item: OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 0.0,
                state: U16::from_utf8("delivered"),
            },
            outcome: ProviderOutcome::Delivered {
                result: Value::Num(1.0),
            },
            now_ms: 50.0,
            first_attempt_at_ms: 10.0,
            policy: None,
        };
        assert_eq!(record_outcome(&input), Err(LifecycleError { name: "Error".to_string(), message: "recordOutcome: item obx-1 is delivered; outcomes apply to pending/claimed items only".to_string() }));
    }
    #[test]
    fn v_record_bad_now() {
        let input = RecordOutcomeInput {
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
            outcome: ProviderOutcome::Uncertain,
            now_ms: f64::NAN,
            first_attempt_at_ms: 10.0,
            policy: None,
        };
        assert_eq!(
            record_outcome(&input),
            Err(LifecycleError {
                name: "RangeError".to_string(),
                message: "recordOutcome: nowMs must be finite and >= 0".to_string()
            })
        );
    }
    #[test]
    fn v_record_bad_first() {
        let input = RecordOutcomeInput {
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
            outcome: ProviderOutcome::Uncertain,
            now_ms: 50.0,
            first_attempt_at_ms: -1.0,
            policy: None,
        };
        assert_eq!(
            record_outcome(&input),
            Err(LifecycleError {
                name: "RangeError".to_string(),
                message: "recordOutcome: firstAttemptAtMs must be finite and >= 0".to_string()
            })
        );
    }
    #[test]
    fn v_record_custom_policy() {
        let input = RecordOutcomeInput {
            item: OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 1.0,
                state: U16::from_utf8("pending"),
            },
            outcome: ProviderOutcome::Failed {
                cause: FailureCause::Transient {
                    code: U16::from_utf8("E"),
                    message: U16::from_utf8("m"),
                },
            },
            now_ms: 500.0,
            first_attempt_at_ms: 10.0,
            policy: Some(RetryPolicy {
                max_attempts: 2.0,
                horizon_ms: 1000.0,
            }),
        };
        assert_eq!(
            record_outcome(&input),
            Ok(RecordedOutcome {
                item: OutboxItem {
                    id: U16::from_utf8("obx-1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 2.0,
                    state: U16::from_utf8("dead")
                },
                status: U16::from_utf8("failed"),
                result: Value::Null,
                error: Some(ReceiptError {
                    code: U16::from_utf8("retry-exhausted"),
                    message: U16::from_utf8("retry attempt budget exhausted")
                }),
                retry_class: Some(U16::from_utf8("transient")),
                retryable: false
            })
        );
    }
    #[test]
    fn v_reconcile_non_uncertain() {
        let got = reconcile_uncertain(
            &OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 0.0,
                state: U16::from_utf8("dead"),
            },
            &Some(ReconcileEvidence::Delivered {
                result: Value::Num(1.0),
            }),
        );
        assert_eq!(
            got,
            ReconcileResult {
                item: OutboxItem {
                    id: U16::from_utf8("obx-1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("dead")
                },
                changed: false,
                status: None,
                result: Value::Null,
                error: None
            }
        );
    }
    #[test]
    fn v_reconcile_null_evidence() {
        let got = reconcile_uncertain(
            &OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 0.0,
                state: U16::from_utf8("uncertain"),
            },
            &None,
        );
        assert_eq!(
            got,
            ReconcileResult {
                item: OutboxItem {
                    id: U16::from_utf8("obx-1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("uncertain")
                },
                changed: false,
                status: None,
                result: Value::Null,
                error: None
            }
        );
    }
    #[test]
    fn v_reconcile_delivered() {
        let got = reconcile_uncertain(
            &OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 2.0,
                state: U16::from_utf8("uncertain"),
            },
            &Some(ReconcileEvidence::Delivered {
                result: Value::Obj(vec![(U16::from_utf8("ok"), Value::Bool(true))]),
            }),
        );
        assert_eq!(
            got,
            ReconcileResult {
                item: OutboxItem {
                    id: U16::from_utf8("obx-1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 2.0,
                    state: U16::from_utf8("delivered")
                },
                changed: true,
                status: Some(U16::from_utf8("succeeded")),
                result: Value::Obj(vec![(U16::from_utf8("ok"), Value::Bool(true))]),
                error: None
            }
        );
    }
    #[test]
    fn v_reconcile_failed() {
        let got = reconcile_uncertain(
            &OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 0.0,
                state: U16::from_utf8("uncertain"),
            },
            &Some(ReconcileEvidence::Failed {
                code: U16::from_utf8("E9"),
                message: U16::from_utf8("bad"),
            }),
        );
        assert_eq!(
            got,
            ReconcileResult {
                item: OutboxItem {
                    id: U16::from_utf8("obx-1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 0.0,
                    state: U16::from_utf8("failed")
                },
                changed: true,
                status: Some(U16::from_utf8("failed")),
                result: Value::Null,
                error: Some(ReceiptError {
                    code: U16::from_utf8("E9"),
                    message: U16::from_utf8("bad")
                })
            }
        );
    }
    #[test]
    fn v_reconcile_not_found() {
        let got = reconcile_uncertain(
            &OutboxItem {
                id: U16::from_utf8("obx-1"),
                operation_id: U16::from_utf8("op-1"),
                source: U16::from_utf8("emit"),
                occurrence_index: 0.0,
                request: Value::Obj(vec![]),
                origin_occurrence: None,
                attempts: 2.0,
                state: U16::from_utf8("uncertain"),
            },
            &Some(ReconcileEvidence::NotFound),
        );
        assert_eq!(
            got,
            ReconcileResult {
                item: OutboxItem {
                    id: U16::from_utf8("obx-1"),
                    operation_id: U16::from_utf8("op-1"),
                    source: U16::from_utf8("emit"),
                    occurrence_index: 0.0,
                    request: Value::Obj(vec![]),
                    origin_occurrence: None,
                    attempts: 2.0,
                    state: U16::from_utf8("pending")
                },
                changed: true,
                status: Some(U16::from_utf8("pending")),
                result: Value::Null,
                error: None
            }
        );
    }
}
