/**
 * T34-F5 child outcome staging: pure builders for the fanout halves of
 * the atomic child unit (terminal child-outcome update + checkpoint
 * advance). The child body appends these writes to its execution
 * effects; `invoke` commits them in the same owner transaction as the
 * child's domain/history/replay/outbox/schedule effects, and the
 * child-join port asserts the linkage (see `ports/transact.ts`).
 *
 * Record semantics mirror F3 exactly (attempts increment for executed
 * attempts only — completed, failed, transient — never for skips;
 * exhaustion derives from the explicit per-call policy + anchors, never
 * supplied): the outcome tests cross-check every staged row against the
 * REAL F3 record path loaded via dynamic import.
 */

import type {
  DomainWrite,
  ModelName,
  RecordId,
  StoredRow,
} from '../../../contracts/src/state.js';
import type {
  FanoutFailedReason,
  FanoutSkippedReason,
  RetryPolicy,
} from '../../../contracts/src/work.js';
import { StateError } from '../errors.js';
import { stageFanoutChildOutcome } from '../effects/staging.js';
import {
  FANOUT_CHECKPOINT_MODEL,
  FANOUT_CHILD_MODEL,
  nextFanoutCheckpointData,
  readFanoutCheckpointRow,
  readFanoutChildRow,
  withFanoutRowData,
  type FanoutRowMeta,
} from './tables.js';

/**
 * State-owned T32-refusal mapping (mirrors F3
 * `FANOUT_T32_REFUSAL_REASON`, cross-checked in tests): inherited-scope
 * and revoked-authority refusals at fanout claim are authority failures
 * — the record may exist, but current authority does not admit this
 * child — recorded terminal as `inaccessible-record`, never retried,
 * never deletion.
 */
export const FANOUT_T32_REFUSAL_REASON: FanoutFailedReason = 'inaccessible-record';

/**
 * One executed attempt result entering record (structural mirror of
 * F3's `FanoutChildAttemptResult`). `exhausted` is never supplied: the
 * horizon derives it from attempts/time. Transient carries no provider
 * details (closed, detail-free).
 */
export type FanoutChildAttemptResult =
  | { readonly kind: 'completed' }
  | { readonly kind: 'skipped'; readonly reason: FanoutSkippedReason }
  | { readonly kind: 'failed'; readonly reason: Exclude<FanoutFailedReason, 'exhausted'> }
  | { readonly kind: 'transient' };

/** One record request against a running (claimed) child row. */
export interface StageFanoutOutcomeInput {
  /** CURRENT child row (the claim the driver holds). */
  readonly row: StoredRow;
  readonly result: FanoutChildAttemptResult;
  /** Claim/record instant as UTC epoch ms (also anchors the horizon check). */
  readonly nowMs: number;
  /** UTC epoch ms of the first attempt, anchoring the retry horizon. */
  readonly firstAttemptAtMs: number;
  /** Explicit per-call bounds (no default, no quota field). */
  readonly policy: RetryPolicy;
  readonly meta: FanoutRowMeta;
}

/** One staged record: the conditional child-row update plus its terminality. */
export interface StagedFanoutOutcome {
  /** Conditional update on the child row (`expectedVersion: row.version`). */
  readonly write: DomainWrite & { readonly kind: 'update' };
  /** True for terminal records (completed/skipped/failed incl. exhausted). */
  readonly terminal: boolean;
  /** The child's canonical record id (for the checkpoint advance). */
  readonly recordId: string;
  /** The staged row (for assertions; identical to `write.row`). */
  readonly row: StoredRow;
}

function checkAttemptResult(result: FanoutChildAttemptResult): void {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new StateError('validation', 'Fanout attempt result must be an object.');
  }
  if (
    result.kind !== 'completed' &&
    result.kind !== 'skipped' &&
    result.kind !== 'failed' &&
    result.kind !== 'transient'
  ) {
    throw new StateError(
      'validation',
      `Fanout attempt kind is unknown: ${JSON.stringify((result as { readonly kind?: unknown }).kind)}.`,
    );
  }
}

function checkHorizon(policy: RetryPolicy, nowMs: number, firstAttemptAtMs: number): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new StateError('validation', 'Fanout policy.maxAttempts must be an integer >= 1.');
  }
  if (!Number.isFinite(policy.horizonMs) || policy.horizonMs <= 0) {
    throw new StateError('validation', 'Fanout policy.horizonMs must be finite and > 0.');
  }
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new StateError('validation', 'Fanout record nowMs must be finite epoch ms >= 0.');
  }
  if (!Number.isFinite(firstAttemptAtMs) || firstAttemptAtMs < 0) {
    throw new StateError(
      'validation',
      'Fanout record firstAttemptAtMs must be finite epoch ms >= 0.',
    );
  }
}

/**
 * Stage one record against a live child row. Two shapes, mirroring F3:
 *
 * - Record against a `running` (claimed) row: completed/failed count
 *   this attempt (attempts++); transient within budget returns to
 *   pending with attempts++; transient past the attempt cap or time
 *   horizon records terminal failed/exhausted (dead-letter visible in
 *   progress counts); skips keep attempts (never executed).
 * - Claim-time pin against a `pending` row (F3 claim pins, F4 recovery
 *   pins): skipped/failed record terminally with attempts UNCHANGED —
 *   nothing executed. Completed and transient pins are refused (both
 *   require an executed attempt, which requires a claim).
 *
 * Recording against a terminal row is a caller bug, refused loudly —
 * replay is the driver's job (it checks the row before staging).
 * Terminal records carry closed causes (validated through the staging
 * join).
 */
export function stageFanoutChildOutcomeWrite(input: StageFanoutOutcomeInput): StagedFanoutOutcome {
  checkAttemptResult(input.result);
  checkHorizon(input.policy, input.nowMs, input.firstAttemptAtMs);
  const data = readFanoutChildRow(input.row);
  if (data.state !== 'running' && data.state !== 'pending') {
    throw new StateError(
      'validation',
      `Fanout record needs a live child row, got ${JSON.stringify(data.state)}.`,
    );
  }
  if (data.state === 'pending' && input.result.kind !== 'skipped' && input.result.kind !== 'failed') {
    throw new StateError(
      'validation',
      `Fanout record against a pending child pins skipped/failed only, got ${JSON.stringify(input.result.kind)}.`,
    );
  }
  const attempts = data.state === 'pending' ? data.attempts : data.attempts + 1;
  if (input.result.kind === 'transient') {
    const exhausted =
      attempts >= input.policy.maxAttempts ||
      input.nowMs - input.firstAttemptAtMs >= input.policy.horizonMs;
    if (exhausted) {
      const staged = stageFanoutChildOutcome({
        state: 'failed',
        causeKind: 'failed',
        causeReason: 'exhausted',
        attempts,
      });
      const row = withFanoutRowData(input.row, { ...data, ...staged }, input.meta);
      return {
        write: {
          kind: 'update',
          model: FANOUT_CHILD_MODEL as ModelName,
          id: input.row.id as RecordId,
          expectedVersion: input.row.version,
          row,
        },
        terminal: true,
        recordId: data.recordId,
        row,
      };
    }
    const row = withFanoutRowData(
      input.row,
      { ...data, state: 'pending', attempts, causeKind: null, causeReason: null },
      input.meta,
    );
    return {
      write: {
        kind: 'update',
        model: FANOUT_CHILD_MODEL as ModelName,
        id: input.row.id as RecordId,
        expectedVersion: input.row.version,
        row,
      },
      terminal: false,
      recordId: data.recordId,
      row,
    };
  }
  // Terminal records: skips keep attempts (never executed), as do
  // pending-row pins; running-row completed/failed count this attempt.
  const staged =
    input.result.kind === 'skipped'
      ? stageFanoutChildOutcome({
          state: 'skipped',
          causeKind: 'skipped',
          causeReason: input.result.reason,
          attempts: data.attempts,
        })
      : input.result.kind === 'completed'
        ? stageFanoutChildOutcome({
            state: 'completed',
            causeKind: 'completed',
            causeReason: null,
            attempts,
          })
        : stageFanoutChildOutcome({
            state: 'failed',
            causeKind: 'failed',
            causeReason: input.result.reason,
            attempts,
          });
  const row = withFanoutRowData(input.row, { ...data, ...staged }, input.meta);
  return {
    write: {
      kind: 'update',
      model: FANOUT_CHILD_MODEL as ModelName,
      id: input.row.id as RecordId,
      expectedVersion: input.row.version,
      row,
    },
    terminal: true,
    recordId: data.recordId,
    row,
  };
}

/** One checkpoint-advance request for a terminal child record. */
export interface StageFanoutCheckpointAdvanceInput {
  /** CURRENT checkpoint row for the fanout. */
  readonly row: StoredRow;
  /** The terminally recorded child's canonical record id. */
  readonly recordId: string;
  /**
   * Next enumeration cursor (carried through; normally the row's
   * current cursor — checkpoint advance never invents enumeration
   * state).
   */
  readonly cursor?: string | null;
  readonly meta: FanoutRowMeta;
}

/**
 * Stage the checkpoint advance covering one terminal child: unions the
 * record id into the completed set (idempotent re-add) and carries the
 * cursor. Commits in the SAME owner transaction as the outcome update
 * (the child-join port asserts the pair); never advances alone.
 */
export function stageFanoutCheckpointAdvanceWrite(
  input: StageFanoutCheckpointAdvanceInput,
): DomainWrite & { readonly kind: 'update' } {
  const data = readFanoutCheckpointRow(input.row);
  if (typeof input.recordId !== 'string' || input.recordId === '') {
    throw new StateError('validation', 'Fanout checkpoint advance needs a non-empty record id.');
  }
  const cursor = input.cursor === undefined ? data.cursor : input.cursor;
  const next = nextFanoutCheckpointData(data, [input.recordId], cursor);
  const row = withFanoutRowData(input.row, { ...data, ...next }, input.meta);
  return {
    kind: 'update',
    model: FANOUT_CHECKPOINT_MODEL as ModelName,
    id: input.row.id as RecordId,
    expectedVersion: input.row.version,
    row,
  };
}
