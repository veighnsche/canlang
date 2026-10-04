/**
 * Receipts: outcome recording, retry classification, backoff and reconcile.
 *
 * - A false authored handler `require` is a terminal business failure; a
 *   transient runtime failure retries the SAME occurrence (same outbox id).
 *   Neither outcome proves that no remote effect occurred (DESIGN 6-8).
 * - Delivery uses exponential backoff with jitter, at most 8 attempts within
 *   24 hours by default. Permanent errors stop retries.
 * - Provider uncertainty stays uncertain until reconcile evidence arrives;
 *   retries reuse the original provider identity.
 * - Dead-letter items are listed visibly for authorized operators.
 *
 * Interpretation notes (DESIGN is silent here): backoff starts at 1s,
 * doubles per completed attempt and caps at 1h; jitter halves downward
 * (`delay` in `[nominal/2, nominal]`); exhaustion is checked as
 * `attempts >= maxAttempts` or `now - firstAttemptAt >= horizon`.
 */
import type {
  OutboxItem,
  ReceiptError,
  ReceiptObservation,
  ReceiptStatus,
  RetryClass,
  RetryPolicy,
} from '../../../contracts/src/work.js';
import type { RandomPort } from '../ports.ts';

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

/** Definitive-or-ambiguous outcome of one provider-call attempt. */
export type ProviderOutcome =
  | { kind: 'delivered'; result: unknown }
  | { kind: 'failed'; cause: FailureCause }
  /** Timeout or missing evidence: the provider may have acted. */
  | { kind: 'uncertain' };

export interface RecordOutcomeInput {
  /** Live item (`pending` or `claimed`); anything else throws. */
  item: OutboxItem;
  outcome: ProviderOutcome;
  nowMs: number;
  /** UTC epoch ms of the first attempt, anchoring the retry horizon. */
  firstAttemptAtMs: number;
  policy?: RetryPolicy;
}

export interface RecordedOutcome {
  item: OutboxItem;
  status: ReceiptStatus;
  result: unknown;
  error: ReceiptError | null;
  retryClass: RetryClass | null;
  retryable: boolean;
}

function assertPolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('receipt: policy.maxAttempts must be an integer >= 1');
  }
  if (!Number.isFinite(policy.horizonMs) || policy.horizonMs <= 0) {
    throw new RangeError('receipt: policy.horizonMs must be finite and > 0');
  }
}

function closedErrorForCause(cause: FailureCause): ReceiptError {
  if (cause.kind === 'handler-require-false') {
    return { code: 'require-false', message: 'handler requirement rejected the occurrence' };
  }
  return { code: cause.code, message: cause.message };
}

/**
 * Record one attempt outcome, returning the updated item plus its receipt
 * fields. Transient failures keep the item `pending` under the SAME
 * occurrence id until the attempt cap or horizon moves it to `dead`;
 * terminal failures move it to `failed`; ambiguity moves it to `uncertain`.
 * Terminal and uncertain items never pass through here again: uncertain
 * resolves only via `reconcileUncertain`, terminal states are final.
 */
export function recordOutcome(input: RecordOutcomeInput): RecordedOutcome {
  const { item, outcome } = input;
  if (item.state !== 'pending' && item.state !== 'claimed') {
    throw new Error(
      `recordOutcome: item ${item.id} is ${item.state}; outcomes apply to pending/claimed items only`,
    );
  }
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) {
    throw new RangeError('recordOutcome: nowMs must be finite and >= 0');
  }
  if (!Number.isFinite(input.firstAttemptAtMs) || input.firstAttemptAtMs < 0) {
    throw new RangeError('recordOutcome: firstAttemptAtMs must be finite and >= 0');
  }
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  assertPolicy(policy);
  const attempts = item.attempts + 1;

  if (outcome.kind === 'delivered') {
    return {
      item: { ...item, attempts, state: 'delivered' },
      status: 'succeeded',
      result: outcome.result,
      error: null,
      retryClass: null,
      retryable: false,
    };
  }
  if (outcome.kind === 'uncertain') {
    return {
      item: { ...item, attempts, state: 'uncertain' },
      status: 'unknown',
      result: null,
      error: null,
      retryClass: null,
      retryable: false,
    };
  }
  const retryClass = classifyFailure(outcome.cause);
  if (retryClass === 'terminal') {
    return {
      item: { ...item, attempts, state: 'failed' },
      status: 'failed',
      result: null,
      error: closedErrorForCause(outcome.cause),
      retryClass,
      retryable: false,
    };
  }
  const attemptsExhausted = attempts >= policy.maxAttempts;
  const horizonExceeded = input.nowMs - input.firstAttemptAtMs >= policy.horizonMs;
  if (attemptsExhausted || horizonExceeded) {
    return {
      item: { ...item, attempts, state: 'dead' },
      status: 'failed',
      result: null,
      error: attemptsExhausted
        ? { code: 'retry-exhausted', message: 'retry attempt budget exhausted' }
        : { code: 'retry-horizon-exceeded', message: 'retry horizon exceeded' },
      retryClass,
      retryable: false,
    };
  }
  return {
    item: { ...item, attempts, state: 'pending' },
    status: 'pending',
    result: null,
    error: null,
    retryClass,
    retryable: true,
  };
}

/**
 * Reconcile evidence for an uncertain item: proof of what the provider did.
 * `not-found` proves the provider never saw the original provider identity,
 * so the same occurrence may safely retry.
 */
export type ReconcileEvidence =
  | { kind: 'delivered'; result: unknown }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'not-found' };

export interface ReconcileResult {
  item: OutboxItem;
  changed: boolean;
  /** Receipt fields for the transition; all null when unchanged. */
  status: ReceiptStatus | null;
  result: unknown;
  error: ReceiptError | null;
}

/**
 * Reconcile an uncertain item against evidence. Unknown stays unknown until
 * evidence arrives (`null` is a no-op), and non-uncertain items are never
 * touched through this path.
 */
export function reconcileUncertain(
  item: OutboxItem,
  evidence: ReconcileEvidence | null,
): ReconcileResult {
  if (item.state !== 'uncertain' || evidence === null) {
    return { item, changed: false, status: null, result: null, error: null };
  }
  if (evidence.kind === 'delivered') {
    return {
      item: { ...item, state: 'delivered' },
      changed: true,
      status: 'succeeded',
      result: evidence.result,
      error: null,
    };
  }
  if (evidence.kind === 'failed') {
    return {
      item: { ...item, state: 'failed' },
      changed: true,
      status: 'failed',
      result: null,
      error: { code: evidence.code, message: evidence.message },
    };
  }
  return {
    item: { ...item, state: 'pending' },
    changed: true,
    status: 'pending',
    result: null,
    error: null,
  };
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
 * cap or the horizon is reached.
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

/**
 * Dead-letter listing: every `dead` item, in stable id order, for visible
 * operator review. Projection and authorization stay with the owning reads.
 */
export function listDeadLetter(items: readonly OutboxItem[]): OutboxItem[] {
  return items
    .filter((item) => item.state === 'dead')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface RecordedReceiptFields {
  status: ReceiptStatus;
  result: unknown;
  error: ReceiptError | null;
}

/**
 * Assemble an authorized receipt observation from recorded fields. The
 * delivery association id and owner-checkpoint revision come from the
 * committing store; this kernel never mints them.
 */
export function toReceiptObservation(
  deliveryId: string,
  revision: number,
  recorded: RecordedReceiptFields,
): ReceiptObservation {
  if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
    throw new RangeError('toReceiptObservation: deliveryId must be a non-empty string');
  }
  if (!Number.isInteger(revision) || revision < 0) {
    throw new RangeError('toReceiptObservation: revision must be a non-negative integer');
  }
  return {
    id: deliveryId,
    revision,
    status: recorded.status,
    result: recorded.result,
    error: recorded.error,
  };
}
