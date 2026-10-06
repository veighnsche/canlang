/**
 * Lane 03 B3: migration recovery (durable failure, operator abort/retry).
 *
 * FAILURE TAXONOMY (loud — pinned by the S7 suite, extended here):
 * - `StateError` (validation/busy/conflict/limit/...): deterministic engine
 *   outcomes. The phase is PRESERVED for cursor retry and NO failure row is
 *   written — the S7 tests pin phase preservation on every one of these.
 *   Only the `resumeMigration`/`activate` orchestrators record failures,
 *   and only for the next class.
 * - Non-`StateError` throws (mapper bugs, adapter bugs, unexpected
 *   internals): the orchestrators record `failed` plus a durable
 *   `MigrationFailure` (leg + prior phase + cursors + message) through
 *   `recordFailure`, then rethrow the ORIGINAL error untouched (a
 *   recording failure attaches as `cause`, never masks the root cause).
 *   Resume then demands an operator decision: `retry` restores the prior
 *   phase from the failure record and continues, `abort` discards staged
 *   rows pre-flip.
 *
 * NO AUTOMATIC DESTRUCTIVE ROLLBACK (deployment.ts promise stands):
 * nothing here moves live rows backwards. Abort only discards SHADOW
 * staged rows plus the progress row, and only pre-flip (staging, staged,
 * or a staging-leg failure). Active, publishing, and activation-leg
 * failures are forward-only: retry/resume or operator surgery.
 */

import type {
  MigrationFailure,
  MigrationFailureLeg,
  MigrationPhase,
  MigrationProgress,
  Revision,
  StoragePort,
} from '@canlang/contracts';
import { StateError } from '../errors.js';

/**
 * Operator decision for a `failed` migration: `retry` restores the prior
 * phase from the failure record and continues; `abort` discards staged
 * rows pre-flip (refused past publish — forward-only).
 */
export type FailedDecision =
  | { readonly decision: 'retry' }
  | { readonly decision: 'abort' };

/** One-line rendering of a thrown value for the failure record. */
function renderThrown(error: unknown): string {
  if (error instanceof StateError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    const name = error.name === '' || error.name === 'Error' ? 'Error' : error.name;
    return error.message === '' ? name : `${name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error === '' ? '(empty thrown string)' : error;
  }
  try {
    const rendered = JSON.stringify(error);
    return rendered === undefined ? String(error) : rendered;
  } catch {
    return String(error);
  }
}

/**
 * Record a durable failure for one migration: mark progress `failed`
 * (preserving the leg's cursors) plus the failure row, one fenced write.
 * `priorPhase`/cursors come from current progress (absent progress reads
 * as a staging-leg start). Recording over `active` is a caller error.
 */
export async function recordFailure(
  store: StoragePort,
  migrationId: string,
  leg: MigrationFailureLeg,
  error: unknown,
  at: number,
): Promise<MigrationFailure> {
  if (typeof migrationId !== 'string' || migrationId === '') {
    throw new StateError('validation', 'Migration failure needs a non-empty migration id.');
  }
  if (leg !== 'staging' && leg !== 'activation') {
    throw new StateError('validation', 'Migration failure leg must be staging or activation.');
  }
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
    throw new StateError('validation', 'Migration failure time must be finite and >= 0.');
  }
  const progress = await store.readMigrationProgress(migrationId);
  const priorPhase: MigrationPhase = progress?.phase ?? 'staging';
  if (priorPhase === 'active') {
    throw new StateError('validation', 'Cannot record failure for an active migration.');
  }
  const revision = await store.readRevision();
  const rendered = renderThrown(error);
  await store.recordMigrationFailure({
    expectedRevision: revision,
    migrationId,
    leg,
    priorPhase,
    stagedCursor: progress?.stagedCursor ?? null,
    publishCursor: progress?.publishCursor ?? null,
    error: rendered,
    at,
  });
  return {
    migrationId,
    leg,
    priorPhase,
    stagedCursor: progress?.stagedCursor ?? null,
    publishCursor: progress?.publishCursor ?? null,
    error: rendered,
    at,
    revision: ((revision as number) + 1) as Revision,
  };
}

/**
 * Orchestrator hook: record `failed` for unexpected (non-`StateError`)
 * leg failures, then let the caller rethrow the original. `StateError`
 * passes through unrecorded (phase preserved for cursor retry). A
 * recording failure attaches as `cause`, never masks the root cause.
 */
export async function noteUnexpectedFailure(
  store: StoragePort,
  migrationId: string,
  leg: MigrationFailureLeg,
  error: unknown,
  at: number,
): Promise<void> {
  if (error instanceof StateError) {
    return;
  }
  try {
    await recordFailure(store, migrationId, leg, error, at);
  } catch (recordError) {
    if (error instanceof Error) {
      try {
        if (error.cause === undefined) {
          error.cause = recordError;
        }
      } catch {
        // A frozen thrown error keeps no cause; the original still throws.
      }
    }
  }
}

/** Read one migration's durable failure record (null when never failed). */
export async function readFailure(
  store: StoragePort,
  migrationId: string,
): Promise<MigrationFailure | null> {
  return store.readMigrationFailure(migrationId);
}

/**
 * Discard one migration's staged rows plus its progress row (one fenced
 * write). The failure record (when any) survives as audit. Raw primitive:
 * prefer `abortMigration`, which enforces the pre-flip policy.
 */
export async function discardStaged(store: StoragePort, migrationId: string): Promise<void> {
  if (typeof migrationId !== 'string' || migrationId === '') {
    throw new StateError('validation', 'Migration discard needs a non-empty migration id.');
  }
  const revision = await store.readRevision();
  await store.discardStagedRows({ expectedRevision: revision, migrationId });
}

/** Operator abort outcome: progress is always null after an abort. */
export interface AbortMigrationResult {
  readonly migrationId: string;
  readonly aborted: boolean;
  readonly progress: MigrationProgress | null;
}

/**
 * Operator abort: discard staged rows plus the progress row so a retry
 * restages from scratch. Allowed pre-flip only — staging, staged, or a
 * staging-leg failure. Refuses (validation, nothing discarded):
 * - `active`: the flip committed; no destructive rollback past it.
 * - `publishing`: rows may have moved; forward-only resume.
 * - `failed` with an activation leg: publish may have moved rows;
 *   forward-only retry.
 * - no progress at all: nothing to abort.
 * The installed snapshot pointer is untouched (the prior snapshot stays
 * active) and the failure record survives as audit.
 */
export async function abortMigration(
  store: StoragePort,
  migrationId: string,
): Promise<AbortMigrationResult> {
  if (typeof migrationId !== 'string' || migrationId === '') {
    throw new StateError('validation', 'Migration abort needs a non-empty migration id.');
  }
  const progress = await store.readMigrationProgress(migrationId);
  if (progress === null) {
    throw new StateError(
      'validation',
      `Migration ${JSON.stringify(migrationId)} has no staged state to abort.`,
    );
  }
  switch (progress.phase) {
    case 'staging':
    case 'staged':
      break;
    case 'failed': {
      const failure = await store.readMigrationFailure(migrationId);
      if (failure === null) {
        throw new StateError(
          'validation',
          `Migration ${JSON.stringify(migrationId)} is failed without a failure record; ` +
            `an operator decision is required before retry.`,
        );
      }
      if (failure.leg !== 'staging') {
        throw new StateError(
          'validation',
          `Migration ${JSON.stringify(migrationId)} failed during activation; ` +
            `abort is refused past publish (forward-only retry).`,
        );
      }
      break;
    }
    case 'active':
      throw new StateError(
        'validation',
        `Migration ${JSON.stringify(migrationId)} is already active; ` +
          `abort is refused past the flip (no destructive rollback).`,
      );
    case 'publishing':
      throw new StateError(
        'validation',
        `Migration ${JSON.stringify(migrationId)} is publishing; ` +
          `abort is refused mid-publish (forward-only resume).`,
      );
    default: {
      const phase = (progress as MigrationProgress).phase;
      throw new StateError('validation', `Unknown migration phase: ${JSON.stringify(phase)}.`);
    }
  }
  await discardStaged(store, migrationId);
  return { migrationId, aborted: true, progress: null };
}

/**
 * Operator retry: restore the failed phase from the failure record (one
 * fenced empty stage write — cursors included, so resume continues at the
 * exact position) and return the restored progress. Fails loud without a
 * failure record, or when the stored prior phase is terminal.
 */
export async function retryFailedMigration(
  store: StoragePort,
  migrationId: string,
): Promise<MigrationProgress> {
  if (typeof migrationId !== 'string' || migrationId === '') {
    throw new StateError('validation', 'Migration retry needs a non-empty migration id.');
  }
  const progress = await store.readMigrationProgress(migrationId);
  if (progress === null || progress.phase !== 'failed') {
    throw new StateError(
      'validation',
      `Migration ${JSON.stringify(migrationId)} is not failed; retry needs a failed migration.`,
    );
  }
  const failure = await store.readMigrationFailure(migrationId);
  if (failure === null) {
    throw new StateError(
      'validation',
      `Migration ${JSON.stringify(migrationId)} has no failure record; ` +
        `an operator decision is required before retry.`,
    );
  }
  if (
    failure.priorPhase !== 'staging' &&
    failure.priorPhase !== 'staged' &&
    failure.priorPhase !== 'publishing'
  ) {
    throw new StateError(
      'validation',
      `Migration ${JSON.stringify(migrationId)} failed from terminal phase ` +
        `${JSON.stringify(failure.priorPhase)}; retry is refused.`,
    );
  }
  const revision = await store.readRevision();
  const restored: MigrationProgress = {
    migrationId,
    phase: failure.priorPhase,
    stagedCursor: failure.stagedCursor,
    publishCursor: failure.publishCursor,
    updatedRevision: ((revision as number) + 1) as Revision,
  };
  await store.stageMigrationRows({ expectedRevision: revision, migrationId, rows: [], progress: restored });
  return restored;
}
