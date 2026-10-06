// W02.3 — Retry policy decisions, extracted from the work receipt donor.
// Pure: type-only contract imports, no clock/RNG/evidence/host calls.
// Randomness arrives as an explicit supplied sample through RandomPort;
// the kernel never mints it. No consumer adoption: the donor keeps
// serving callers; conformance/fixtures/policy/retry.json holds frozen
// independent originals captured from the live donor.

import type { RetryClass, RetryPolicy } from '@canlang/contracts';

/** DESIGN section 7 defaults: at most 8 attempts within 24 hours. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 8,
  horizonMs: 86_400_000,
});

/** First nominal backoff delay. */
export const BACKOFF_BASE_DELAY_MS = 1000;

/** Cap on the nominal (pre-jitter) backoff delay. */
export const BACKOFF_MAX_DELAY_MS = 3_600_000;

/**
 * Explicit supplied-randomness seam. Callers (hosts/tests) supply the
 * unit sample; identical in shape to the work ports seam, restated
 * here so the leaf never imports work sources.
 */
export interface RandomPort {
  nextUnit(): number;
}

/**
 * Classified failure cause entering the kernel. Adapters must supply
 * already-closed (safe, detail-free) codes and messages; the kernel never
 * invents error details.
 */
export type FailureCause =
  /** False authored handler `require`: terminal business failure. */
  | { kind: 'handler-require-false'; require: string }
  /** Permanent provider/adapter error: retries stop. */
  | { kind: 'permanent'; code: string; message: string }
  /** Transient runtime failure: retry the same occurrence. */
  | { kind: 'transient'; code: string; message: string };

/** A false authored `require` and permanent errors are terminal. */
export function classifyFailure(cause: FailureCause): RetryClass {
  return cause.kind === 'transient' ? 'transient' : 'terminal';
}

/** Shared retry-policy guard (also used by lifecycle recordOutcome). */
export function assertPolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('receipt: policy.maxAttempts must be an integer >= 1');
  }
  if (!Number.isFinite(policy.horizonMs) || policy.horizonMs <= 0) {
    throw new RangeError('receipt: policy.horizonMs must be finite and > 0');
  }
}

export interface BackoffInput {
  /** Completed attempts so far. */
  attempt: number;
  firstAttemptAtMs: number;
  nowMs: number;
  policy?: RetryPolicy;
  random: RandomPort;
}

export interface BackoffDecision {
  exhausted: boolean;
  /** Jittered delay in ms; 0 when exhausted. */
  delayMs: number;
  /** Earliest next-attempt instant; `nowMs` when exhausted. */
  notBeforeMs: number;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Pure backoff schedule: exponential delays with equal jitter. The nominal
 * delay doubles per completed attempt from 1s (capped at 1h); the returned
 * delay is always within `[nominal/2, nominal]`. Exhausted when the attempt
 * cap or the horizon is reached. Times stay fractional where supplied;
 * counts use Number integer arithmetic.
 */
export function computeBackoff(input: BackoffInput): BackoffDecision {
  if (!Number.isInteger(input.attempt) || input.attempt < 0) {
    throw new RangeError('computeBackoff: attempt must be a non-negative integer');
  }
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) {
    throw new RangeError('computeBackoff: nowMs must be finite and >= 0');
  }
  if (!Number.isFinite(input.firstAttemptAtMs) || input.firstAttemptAtMs < 0) {
    throw new RangeError('computeBackoff: firstAttemptAtMs must be finite and >= 0');
  }
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  assertPolicy(policy);
  if (
    input.attempt >= policy.maxAttempts ||
    input.nowMs - input.firstAttemptAtMs >= policy.horizonMs
  ) {
    return { exhausted: true, delayMs: 0, notBeforeMs: input.nowMs };
  }
  const shift = Math.max(0, input.attempt - 1);
  const nominal = Math.min(BACKOFF_MAX_DELAY_MS, BACKOFF_BASE_DELAY_MS * 2 ** shift);
  const delayMs = nominal / 2 + clampUnit(input.random.nextUnit()) * (nominal / 2);
  return { exhausted: false, delayMs, notBeforeMs: input.nowMs + delayMs };
}
