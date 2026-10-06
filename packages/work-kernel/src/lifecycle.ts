// W02.3 — Outbox item lifecycle transitions, extracted from the work
// receipt donor. Pure: type-only contract imports (plus the shared
// retry classifier/policy guard), no clock/RNG/evidence/host calls.
// No consumer adoption: the donor keeps serving callers;
// conformance/fixtures/policy/lifecycle.json holds frozen independent
// originals captured from the live donor.

import type {
  OutboxItem,
  ReceiptError,
  ReceiptStatus,
  RetryClass,
  RetryPolicy,
} from '@canlang/contracts';
import { DEFAULT_RETRY_POLICY, assertPolicy, classifyFailure } from './retry.js';
import type { FailureCause } from './retry.js';

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
