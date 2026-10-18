/**
 * T34-F5 fanout tables: state-owned structural mirrors of the F2 durable
 * fanout rows (`work.fanout_intent`, `work.fanout_checkpoint`,
 * `work.fanout_child`).
 *
 * LAYERING: this file NEVER imports work sources (runtime or types).
 * All row mechanics live in the contracts-only shared leaf
 * (`@canlang/work-kernel/rows`, invoked with the explicit 'state'
 * direction); this facade only projects leaf `RowsStateError` failures
 * onto the owning `StateError` class so `instanceof StateError` and the
 * `(code, message)` shape keep working. Non-leaf thrown values (engine
 * URIError, DataCloneError) propagate untouched.
 *
 * Q4 (t34-plan.md open question 4): the owning producer RETAINS the
 * frozen identity set. Membership is the complete sorted canonical
 * identity set frozen at the explicit source-occurrence/handler cutoff
 * and committed in the intent row; no proven-equivalent substitute.
 */

import type {
  FanoutCohortKind,
  FanoutFailedReason,
  FanoutId,
  FanoutSkippedReason,
  QuerySpec,
  StoredRow,
} from '@canlang/contracts';
import { StateError } from '../errors.js';
import {
  checkFanoutIdentitySet as leafCheckFanoutIdentitySet,
  fanoutCheckpointRowId as leafFanoutCheckpointRowId,
  fanoutChildIdOf as leafFanoutChildIdOf,
  fanoutChildPageQuery as leafFanoutChildPageQuery,
  fanoutChildPageResult as leafFanoutChildPageResult,
  fanoutChildRowId as leafFanoutChildRowId,
  fanoutIntentRowId as leafFanoutIntentRowId,
  newFanoutCheckpointRow as leafNewFanoutCheckpointRow,
  newFanoutChildRow as leafNewFanoutChildRow,
  newFanoutIntentRow as leafNewFanoutIntentRow,
  nextFanoutCheckpointData as leafNextFanoutCheckpointData,
  readFanoutCheckpointRow as leafReadFanoutCheckpointRow,
  readFanoutChildRow as leafReadFanoutChildRow,
  readFanoutIntentRow as leafReadFanoutIntentRow,
  RowsStateError,
  withFanoutRowData as leafWithFanoutRowData,
} from '@canlang/work-kernel/rows';

/** State-owned fanout table models (structural literals, cf. F2 constants). */
export const FANOUT_INTENT_MODEL = 'work.fanout_intent';
export const FANOUT_CHECKPOINT_MODEL = 'work.fanout_checkpoint';
export const FANOUT_CHILD_MODEL = 'work.fanout_child';

/** Committed fanout intent data: cutoff + cohort + frozen members. */
export interface FanoutIntentData {
  readonly fanoutId: FanoutId;
  readonly sourceOccurrence: string;
  readonly handler: string;
  readonly cohort: FanoutCohortKind;
  /** Frozen canonical admitted record identities in sorted canonical order. */
  readonly members: ReadonlyArray<string>;
  /** Flat duplicate of `members.length` for querying. */
  readonly memberCount: number;
}

/** Durable fanout checkpoint data: completed-child set plus cursor. */
export interface FanoutCheckpointData {
  readonly fanoutId: FanoutId;
  /** Completed record ids in sorted canonical order (deduped set). */
  readonly completed: ReadonlyArray<string>;
  /**
   * Opaque enumeration cursor; null only when enumeration is fully
   * admitted. A non-null cursor means resume, never silent truncation.
   */
  readonly cursor: string | null;
}

/** Per-child row data. Cause fields are flat: null until terminal. */
export interface FanoutChildData {
  readonly fanoutId: FanoutId;
  readonly parentOccurrence: string;
  readonly handler: string;
  readonly recordId: string;
  readonly childId: string;
  readonly state: 'pending' | 'running' | 'completed' | 'skipped' | 'failed';
  /** Committed child attempts so far. */
  readonly attempts: number;
  readonly causeKind: 'completed' | 'skipped' | 'failed' | null;
  readonly causeReason: string | null;
}

/** Row metadata stamp for staged fanout rows. */
export interface FanoutRowMeta {
  /** UTC epoch ms for created/updated. */
  readonly nowMs: number;
  /** Actor identity for createdBy/updatedBy. */
  readonly actor: string;
}

/**
 * Run one leaf call in the state direction, projecting leaf state
 * failures onto the owning StateError class. Every other thrown value
 * propagates as-is.
 */
function own<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof RowsStateError) {
      throw new StateError('validation', error.message);
    }
    throw error;
  }
}

/**
 * Validate one frozen identity set: an array of non-empty canonical
 * record ids, deduped, returned in sorted canonical order. Duplicates
 * fail closed (a frozen set with a duplicate is store disagreement,
 * never silently deduped at commit).
 */
export function checkFanoutIdentitySet(
  value: unknown,
  what: string,
): ReadonlyArray<string> {
  return own(() => leafCheckFanoutIdentitySet(value, what, 'state'));
}

/**
 * Deterministic fanout intent row id under FanoutCutoff + cohort.
 * Byte-identical derivation to F2 (`fanoutIntentRowId`): components are
 * encoded so `/` separators stay unambiguous. A second insert for the
 * same source-occurrence/handler/cohort collides on the store primary
 * key — the insert-once rule that keeps the frozen set unredefinable.
 */
export function fanoutIntentRowId(
  sourceOccurrence: string,
  handler: string,
  cohort: FanoutCohortKind,
): FanoutId {
  return own(() => leafFanoutIntentRowId(sourceOccurrence, handler, cohort, 'state'));
}

/** Checkpoint row id: exactly one checkpoint row per fanout id. */
export function fanoutCheckpointRowId(fanoutId: FanoutId): string {
  return own(() => leafFanoutCheckpointRowId(fanoutId, 'state'));
}

/**
 * Per-child row id: the full FanoutChildId (parent occurrence + handler
 * + record), encoded so `/` separators stay unambiguous. Byte-identical
 * to F2 (`fanoutChildRowId`): same parent+record under different
 * handlers yields different ids; the same triple always yields the same
 * id, so retries reuse the row and duplicate deliveries replay.
 */
export function fanoutChildRowId(
  parentOccurrence: string,
  handler: string,
  recordId: string,
): string {
  return own(() => leafFanoutChildRowId(parentOccurrence, handler, recordId, 'state'));
}

/**
 * Replacement row for a conditional update: version + 1 with fresh
 * updated metadata. Callers stage it with `expectedVersion: row.version`.
 */
export function withFanoutRowData(
  row: StoredRow,
  data: Readonly<Record<string, unknown>>,
  meta: FanoutRowMeta,
): StoredRow {
  return own(() => leafWithFanoutRowData(row, data, meta));
}

/** Producer-side insert: the committed fanout intent row. */
export function newFanoutIntentRow(
  input: {
    readonly sourceOccurrence: string;
    readonly handler: string;
    readonly cohort: FanoutCohortKind;
    readonly members: ReadonlyArray<string>;
  },
  meta: FanoutRowMeta,
): StoredRow {
  return own(() => leafNewFanoutIntentRow(input, meta, 'state'));
}

/** Producer-side insert: the checkpoint row (explicit completed + cursor). */
export function newFanoutCheckpointRow(
  input: {
    readonly fanoutId: FanoutId;
    readonly completed?: ReadonlyArray<string>;
    readonly cursor?: string | null;
  },
  meta: FanoutRowMeta,
): StoredRow {
  return own(() => leafNewFanoutCheckpointRow(input, meta, 'state'));
}

/**
 * Pure checkpoint advance: unions newly completed record ids into the
 * completed set (deduped, sorted canonical order) and carries the next
 * cursor. Re-adding an already-completed identity is an idempotent
 * no-op: crash recovery replays at most the un-checkpointed child and
 * must be able to re-advance over an overlapping set.
 */
export function nextFanoutCheckpointData(
  current: FanoutCheckpointData,
  addCompleted: ReadonlyArray<string>,
  cursor: string | null,
): FanoutCheckpointData {
  return own(() => leafNextFanoutCheckpointData(current, addCompleted, cursor, 'state'));
}

/** Producer-side insert: one admitted child row (default pending, zero attempts). */
export function newFanoutChildRow(
  input: {
    readonly fanoutId: FanoutId;
    readonly parentOccurrence: string;
    readonly handler: string;
    readonly recordId: string;
    readonly state?: 'pending' | 'running' | 'completed' | 'skipped' | 'failed';
    readonly attempts?: number;
    readonly causeKind?: 'completed' | 'skipped' | 'failed' | null;
    readonly causeReason?: FanoutSkippedReason | FanoutFailedReason | null;
  },
  meta: FanoutRowMeta,
): StoredRow {
  return own(() => leafNewFanoutChildRow(input, meta, 'state'));
}

/** Read one fanout intent row's data, failing closed on any shape drift. */
export function readFanoutIntentRow(row: StoredRow): FanoutIntentData {
  return own(() => leafReadFanoutIntentRow(row, 'state'));
}

/** Read one fanout checkpoint row's data, failing closed on any shape drift. */
export function readFanoutCheckpointRow(row: StoredRow): FanoutCheckpointData {
  return own(() => leafReadFanoutCheckpointRow(row, 'state'));
}

/** Read one fanout child row's data, failing closed on any shape drift. */
export function readFanoutChildRow(row: StoredRow): FanoutChildData {
  return own(() => leafReadFanoutChildRow(row, 'state'));
}

/** Rebuild the contract child identity from a child row's flat fields. */
export function fanoutChildIdOf(row: FanoutChildData) {
  return leafFanoutChildIdOf(row);
}

/**
 * Bounded id-sorted child page query for one fanout. `cursor` is the
 * last-seen child row id (exclusive lower bound); `limit` bounds one
 * transport round-trip only (chunk size is not cohort size — §C9).
 */
export function fanoutChildPageQuery(
  fanoutId: FanoutId,
  opts: { readonly cursor: string | null; readonly limit: number },
): QuerySpec {
  return own(() => leafFanoutChildPageQuery(fanoutId, opts, 'state'));
}

/** One bounded child page: rows plus the honest resume signal. */
export interface FanoutChildPage {
  /** Id-sorted rows of this page (at most the requested limit). */
  readonly rows: ReadonlyArray<StoredRow>;
  /**
   * True only when the store returned fewer rows than the limit. False
   * means the caller MUST resume with `cursor` — never silent
   * truncation, never a complete label.
   */
  readonly done: boolean;
  /** Resume cursor (last row id) when done:false; null when done:true. */
  readonly cursor: string | null;
}

/** Fold one store page into the resume signal. Fails closed on over-return. */
export function fanoutChildPageResult(
  rows: ReadonlyArray<StoredRow>,
  limit: number,
): FanoutChildPage {
  return own(() => leafFanoutChildPageResult(rows, limit, 'state'));
}
