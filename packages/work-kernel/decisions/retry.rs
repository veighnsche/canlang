//! W04.2 — Native retry policy decisions.
//!
//! Data-only Rust port of `src/retry.ts`, proven against the same
//! independent TS oracle corpus (`conformance/fixtures/policy/retry.json`).
//! Standalone file: compiles and tests with
//! `rustc --edition 2021 --test decisions/retry.rs` — no Cargo
//! membership, no dependencies, no host I/O. The small shared prelude
//! (UTF-16 text, retry policy vocabulary) is duplicated per decisions
//! file until W04.4 assembly consolidates it; each copy is verbatim.
//! Randomness arrives as an explicit supplied sample through
//! `RandomPort`; the kernel never mints it.

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

/// Parity error: name/message match the TS donor.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PolicyError {
    pub name: String,
    pub message: String,
}

fn range_error(message: String) -> PolicyError {
    PolicyError {
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

/// DESIGN section 7 defaults: at most 8 attempts within 24 hours.
pub const DEFAULT_MAX_ATTEMPTS: f64 = 8.0;
pub const DEFAULT_HORIZON_MS: f64 = 86_400_000.0;

/// First nominal backoff delay.
pub const BACKOFF_BASE_DELAY_MS: f64 = 1000.0;

/// Cap on the nominal (pre-jitter) backoff delay.
pub const BACKOFF_MAX_DELAY_MS: f64 = 3_600_000.0;

pub fn default_retry_policy() -> RetryPolicy {
    RetryPolicy {
        max_attempts: DEFAULT_MAX_ATTEMPTS,
        horizon_ms: DEFAULT_HORIZON_MS,
    }
}

/**
 * Explicit supplied-randomness seam. Callers (hosts/tests) supply the
 * unit sample; identical in shape to the TS port seam.
 */
pub trait RandomPort {
    fn next_unit(&self) -> f64;
}

/// Classified failure cause entering the kernel.
#[derive(Clone, PartialEq, Debug)]
pub enum FailureCause {
    /// False authored handler `require`: terminal business failure.
    HandlerRequireFalse { require: U16 },
    /// Permanent provider/adapter error: retries stop.
    Permanent { code: U16, message: U16 },
    /// Transient runtime failure: retry the same occurrence.
    Transient { code: U16, message: U16 },
}

/** A false authored `require` and permanent errors are terminal. */
pub fn classify_failure(cause: &FailureCause) -> U16 {
    match cause {
        FailureCause::Transient { .. } => U16::from_utf8("transient"),
        _ => U16::from_utf8("terminal"),
    }
}

/// Shared retry-policy guard (also used by lifecycle record paths).
pub fn assert_policy(policy: &RetryPolicy) -> Result<(), PolicyError> {
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

pub struct BackoffInput<R> {
    /// Completed attempts so far.
    pub attempt: f64,
    pub first_attempt_at_ms: f64,
    pub now_ms: f64,
    pub policy: Option<RetryPolicy>,
    pub random: R,
}

#[derive(Clone, PartialEq, Debug)]
pub struct BackoffDecision {
    pub exhausted: bool,
    /// Jittered delay in ms; 0 when exhausted.
    pub delay_ms: f64,
    /// Earliest next-attempt instant; `now_ms` when exhausted.
    pub not_before_ms: f64,
}

/// Donor maps every non-finite sample (NaN and both infinities) to 0;
/// `f64::clamp` would propagate NaN, so the manual form is load-bearing.
#[allow(clippy::manual_clamp)]
fn clamp_unit(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    value.min(1.0).max(0.0)
}

/**
 * Pure backoff schedule: exponential delays with equal jitter. The nominal
 * delay doubles per completed attempt from 1s (capped at 1h); the returned
 * delay is always within `[nominal/2, nominal]`. Exhausted when the attempt
 * cap or the horizon is reached. Shift overflow (attempts past f64 range)
 * saturates through infinity into the cap, exactly like `2 ** shift`.
 */
pub fn compute_backoff<R: RandomPort>(
    input: &BackoffInput<R>,
) -> Result<BackoffDecision, PolicyError> {
    if input.attempt.fract() != 0.0 || input.attempt < 0.0 {
        return Err(range_error(
            "computeBackoff: attempt must be a non-negative integer".to_string(),
        ));
    }
    if !input.now_ms.is_finite() || input.now_ms < 0.0 {
        return Err(range_error(
            "computeBackoff: nowMs must be finite and >= 0".to_string(),
        ));
    }
    if !input.first_attempt_at_ms.is_finite() || input.first_attempt_at_ms < 0.0 {
        return Err(range_error(
            "computeBackoff: firstAttemptAtMs must be finite and >= 0".to_string(),
        ));
    }
    let policy = input.policy.clone().unwrap_or_else(default_retry_policy);
    assert_policy(&policy)?;
    if input.attempt >= policy.max_attempts
        || input.now_ms - input.first_attempt_at_ms >= policy.horizon_ms
    {
        return Ok(BackoffDecision {
            exhausted: true,
            delay_ms: 0.0,
            not_before_ms: input.now_ms,
        });
    }
    let shift = (input.attempt - 1.0).max(0.0);
    // `2 ** shift` in f64: exact powers of two through 2^1023, infinity past.
    let nominal = if shift > 1023.0 {
        f64::INFINITY
    } else {
        BACKOFF_BASE_DELAY_MS * 2f64.powi(shift as i32)
    }
    .min(BACKOFF_MAX_DELAY_MS);
    let delay_ms = nominal / 2.0 + clamp_unit(input.random.next_unit()) * (nominal / 2.0);
    Ok(BackoffDecision {
        exhausted: false,
        delay_ms,
        not_before_ms: input.now_ms + delay_ms,
    })
}
// W04.2 vectors: transcribed from conformance/fixtures/policy/retry.json
// (sha256 630bafad41c27b5ffb8023f4d6a6f92f353c80a75f51d079d9b6748275c30018); 23 cases + const pins. The frozen file is the
// oracle: this module is generated, never hand-edited.
