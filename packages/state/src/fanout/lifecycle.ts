/**
 * T34-F5 child lifecycle: current-state lookup classifying one frozen
 * member as present/deleted/moved/unknown (structural mirror of F4's
 * `FanoutChildLifecycle`, consumed read-only by the recovery scan).
 *
 * Mapping (adopted §C7):
 * - `present`: the record loads live under current state (and, for
 *   anchored cohorts, still under the pinned parent).
 * - `deleted`: DEMONSTRABLE deletion only — an archived tombstone
 *   (`archivedAt` set) or a history-recorded remove/archive. Records
 *   skipped/deleted, never failed.
 * - `moved`: the record loads live but its current parent linkage left
 *   the cohort anchor (anchored cohorts only; whole-model cohorts never
 *   move). Re-evaluated against the current body guard — never auto-kept
 *   or auto-cut.
 * - `unknown`: a null load with no disposal history (`missing-record`),
 *   an authority failure at claim (`inaccessible-record`, mapped by the
 *   admission join — never by this read), or an infrastructure read
 *   failure (`infra-read-failure`). Unknown NEVER masquerades as
 *   deletion: it records failed, stays distinct, and stays visible.
 */

import type {
  ModelName,
  RecordId,
  StoragePort,
} from '@canlang/contracts';
import type { FanoutFailedReason } from '@canlang/contracts';
import { StateError } from '../errors.js';

/**
 * Current lifecycle lookup for one admitted child (structural mirror of
 * F4's `FanoutChildLifecycle`).
 */
export type FanoutChildLifecycle =
  | { readonly status: 'present' }
  | { readonly status: 'deleted' }
  | { readonly status: 'moved' }
  | {
      readonly status: 'unknown';
      readonly reason: Extract<
        FanoutFailedReason,
        'missing-record' | 'inaccessible-record' | 'infra-read-failure'
      >;
    };

/** One lifecycle lookup against current owner state. */
export interface ClassifyFanoutChildInput {
  readonly store: StoragePort;
  readonly model: string;
  readonly recordId: string;
  /**
   * Pinned anchor for anchored-collection cohorts. When present, a live
   * record whose current parent linkage left the anchor classifies as
   * `moved`. Whole-model cohorts pass none (their members never move).
   */
  readonly anchor?: { readonly model: string; readonly id: string };
}

/**
 * Classify one frozen member against CURRENT owner state. Owner reads
 * only — authority is decided at claim by the T32 fence, never here,
 * so this read produces `missing-record`/`infra-read-failure` unknowns
 * only; `inaccessible-record` comes from `refusedFanoutLifecycle`.
 */
export async function classifyFanoutChildLifecycle(
  input: ClassifyFanoutChildInput,
): Promise<FanoutChildLifecycle> {
  if (typeof input.model !== 'string' || input.model === '') {
    throw new StateError('validation', 'Fanout lifecycle needs a non-empty model.');
  }
  if (typeof input.recordId !== 'string' || input.recordId === '') {
    throw new StateError('validation', 'Fanout lifecycle needs a non-empty record id.');
  }
  let row: Awaited<ReturnType<StoragePort['load']>>;
  try {
    row = await input.store.load(
      input.model as ModelName,
      input.recordId as RecordId,
    );
  } catch {
    return { status: 'unknown', reason: 'infra-read-failure' };
  }
  if (row === null) {
    let history: Awaited<ReturnType<StoragePort['historyFor']>>;
    try {
      history = await input.store.historyFor(
        input.model as ModelName,
        input.recordId as RecordId,
      );
    } catch {
      return { status: 'unknown', reason: 'infra-read-failure' };
    }
    for (const entry of history) {
      if (entry.change === 'remove' || entry.change === 'archive') {
        return { status: 'deleted' };
      }
    }
    return { status: 'unknown', reason: 'missing-record' };
  }
  if (row.archivedAt !== null) {
    return { status: 'deleted' };
  }
  if (input.anchor !== undefined) {
    const parent = row.parent ?? null;
    if (
      parent === null ||
      (parent.model as string) !== input.anchor.model ||
      (parent.id as string) !== input.anchor.id
    ) {
      return { status: 'moved' };
    }
  }
  return { status: 'present' };
}

/**
 * Lifecycle for a claim-time T32 fence refusal (inherited-scope or
 * revoked authority): the record may exist, but current authority does
 * not admit this child. Maps to `unknown`/`inaccessible-record` —
 * recorded failed, never deleted, never retried. The admission join
 * (driver) applies this mapping when `invoke` refuses `forbidden`; the
 * state read above never produces it.
 */
export function refusedFanoutLifecycle(): FanoutChildLifecycle {
  return { status: 'unknown', reason: 'inaccessible-record' };
}
