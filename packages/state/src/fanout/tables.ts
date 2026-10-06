/**
 * T34-F5 fanout tables: state-owned structural mirrors of the F2 durable
 * fanout rows (`work.fanout_intent`, `work.fanout_checkpoint`,
 * `work.fanout_child`).
 *
 * LAYERING (T24a/T25-L3 precedent): this file NEVER imports work sources
 * (runtime or types). Every derivation, data shape, and validation rule
 * below re-states the F2 contract field-for-field from the committed F1
 * vocabulary (`@canlang/contracts`), and the fanout tests prove
 * byte-compatibility in BOTH directions against the REAL F2
 * constructors/readers loaded via computed-URL dynamic import (see
 * `work-loader.ts`). A work-side conformance pin (F2 tests reading
 * state-staged rows) is REPORTED as remainder — F5 cannot write work
 * files.
 *
 * Q4 (t34-plan.md open question 4): the owning producer RETAINS the
 * frozen identity set. Membership is the complete sorted canonical
 * identity set frozen at the explicit source-occurrence/handler cutoff
 * and committed in the intent row; no proven-equivalent substitute.
 */

import type {
  ModelName,
  QuerySpec,
  RecordId,
  RecordVersion,
  StoredRow,
} from '@canlang/contracts';
import type {
  FanoutCohortKind,
  FanoutFailedReason,
  FanoutId,
  FanoutSkippedReason,
} from '@canlang/contracts';
import { StateError } from '../errors.js';

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

const FANOUT_CHILD_STATES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'completed',
  'skipped',
  'failed',
]);

const FANOUT_SKIPPED_REASONS: ReadonlySet<string> = new Set(['deleted', 'non-applicable']);

const FANOUT_FAILED_REASONS: ReadonlySet<string> = new Set([
  'business-rejection',
  'terminal',
  'exhausted',
  'missing-record',
  'inaccessible-record',
  'infra-read-failure',
]);

function checkComponent(value: string, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new StateError('validation', `Fanout ${what} must be a non-empty string.`);
  }
  return value;
}

function checkCohort(value: unknown): FanoutCohortKind {
  if (value !== 'model' && value !== 'anchored-collection') {
    throw new StateError(
      'validation',
      `Fanout cohort must be model or anchored-collection, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function checkRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StateError('validation', `${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function checkDataString(
  record: Record<string, unknown>,
  field: string,
  what: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value === '') {
    throw new StateError('validation', `${what}.${field} must be a non-empty string.`);
  }
  return value;
}

function checkNullableString(
  record: Record<string, unknown>,
  field: string,
  what: string,
): string | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new StateError('validation', `${what}.${field} must be a string or null.`);
  }
  return value;
}

function checkCount(record: Record<string, unknown>, field: string, what: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new StateError('validation', `${what}.${field} must be an integer >= 0.`);
  }
  return value;
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
  if (!Array.isArray(value)) {
    throw new StateError('validation', `${what} must be an array of canonical record ids.`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') {
      throw new StateError('validation', `${what} entries must be non-empty strings.`);
    }
    if (seen.has(entry)) {
      throw new StateError(
        'validation',
        `${what} contains a duplicate identity: ${JSON.stringify(entry)}.`,
      );
    }
    seen.add(entry);
  }
  return [...seen].sort();
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
  checkComponent(sourceOccurrence, 'sourceOccurrence');
  checkComponent(handler, 'handler');
  checkCohort(cohort);
  return `fanout/v1/${encodeURIComponent(sourceOccurrence)}/${encodeURIComponent(handler)}/${cohort}`;
}

/** Checkpoint row id: exactly one checkpoint row per fanout id. */
export function fanoutCheckpointRowId(fanoutId: FanoutId): string {
  return checkComponent(fanoutId, 'fanoutId');
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
  checkComponent(parentOccurrence, 'parentOccurrence');
  checkComponent(handler, 'handler');
  checkComponent(recordId, 'recordId');
  return `fanout-child/v1/${encodeURIComponent(parentOccurrence)}/${encodeURIComponent(handler)}/${encodeURIComponent(recordId)}`;
}

function checkMeta(meta: FanoutRowMeta, what: string): void {
  if (!Number.isFinite(meta.nowMs) || meta.nowMs < 0) {
    throw new StateError('validation', `${what}: nowMs must be finite epoch ms >= 0.`);
  }
  if (typeof meta.actor !== 'string' || meta.actor === '') {
    throw new StateError('validation', `${what}: actor must be a non-empty string.`);
  }
}

function newRow(id: string, data: Readonly<Record<string, unknown>>, meta: FanoutRowMeta): StoredRow {
  checkMeta(meta, 'fanout');
  return {
    id: id as RecordId,
    version: 1 as RecordVersion,
    created: meta.nowMs,
    updated: meta.nowMs,
    createdBy: meta.actor,
    updatedBy: meta.actor,
    archivedAt: null,
    parent: null,
    data: structuredClone(data),
  };
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
  checkMeta(meta, 'fanout');
  return {
    ...row,
    version: (row.version + 1) as RecordVersion,
    updated: meta.nowMs,
    updatedBy: meta.actor,
    data: structuredClone(data),
  };
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
  const members = checkFanoutIdentitySet(input.members, 'work.fanout_intent.members');
  const fanoutId = fanoutIntentRowId(input.sourceOccurrence, input.handler, input.cohort);
  const data: FanoutIntentData = {
    fanoutId,
    sourceOccurrence: input.sourceOccurrence,
    handler: input.handler,
    cohort: input.cohort,
    members,
    memberCount: members.length,
  };
  return newRow(fanoutId, data as unknown as Record<string, unknown>, meta);
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
  const data: FanoutCheckpointData = {
    fanoutId: checkComponent(input.fanoutId, 'fanoutId'),
    completed: checkFanoutIdentitySet(input.completed ?? [], 'work.fanout_checkpoint.completed'),
    cursor: input.cursor ?? null,
  };
  if (data.cursor !== null && data.cursor === '') {
    throw new StateError('validation', 'work.fanout_checkpoint.cursor must be non-empty or null.');
  }
  return newRow(
    fanoutCheckpointRowId(data.fanoutId),
    data as unknown as Record<string, unknown>,
    meta,
  );
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
  if (cursor !== null && cursor === '') {
    throw new StateError('validation', 'work.fanout_checkpoint.cursor must be non-empty or null.');
  }
  for (const entry of addCompleted) {
    if (typeof entry !== 'string' || entry === '') {
      throw new StateError(
        'validation',
        'work.fanout_checkpoint.completed entries must be non-empty strings.',
      );
    }
  }
  return {
    fanoutId: current.fanoutId,
    completed: [...new Set([...current.completed, ...addCompleted])].sort(),
    cursor,
  };
}

function checkChildCause(
  state: string,
  causeKind: 'completed' | 'skipped' | 'failed' | null,
  causeReason: string | null,
): void {
  if (state === 'pending' || state === 'running') {
    if (causeKind !== null || causeReason !== null) {
      throw new StateError(
        'validation',
        `work.fanout_child cause must be null until terminal, got ${JSON.stringify(causeKind)}.`,
      );
    }
    return;
  }
  if (state === 'completed') {
    if (causeKind !== 'completed' || causeReason !== null) {
      throw new StateError(
        'validation',
        'work.fanout_child completed cause must be kind completed with no reason.',
      );
    }
    return;
  }
  if (state === 'skipped') {
    if (causeKind !== 'skipped' || !FANOUT_SKIPPED_REASONS.has(causeReason ?? '')) {
      throw new StateError(
        'validation',
        `work.fanout_child skipped cause needs a closed reason, got ${JSON.stringify(causeReason)}.`,
      );
    }
    return;
  }
  if (causeKind !== 'failed' || !FANOUT_FAILED_REASONS.has(causeReason ?? '')) {
    throw new StateError(
      'validation',
      `work.fanout_child failed cause needs a closed reason, got ${JSON.stringify(causeReason)}.`,
    );
  }
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
  const state = input.state ?? 'pending';
  if (!FANOUT_CHILD_STATES.has(state)) {
    throw new StateError(
      'validation',
      `work.fanout_child.state is unknown: ${JSON.stringify(state)}.`,
    );
  }
  const attempts = input.attempts ?? 0;
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new StateError('validation', 'work.fanout_child.attempts must be an integer >= 0.');
  }
  const causeKind = input.causeKind ?? null;
  const causeReason = (input.causeReason ?? null) as string | null;
  checkChildCause(state, causeKind, causeReason);
  const childId = fanoutChildRowId(input.parentOccurrence, input.handler, input.recordId);
  const data: FanoutChildData = {
    fanoutId: checkComponent(input.fanoutId, 'fanoutId'),
    parentOccurrence: input.parentOccurrence,
    handler: input.handler,
    recordId: input.recordId,
    childId,
    state,
    attempts,
    causeKind,
    causeReason,
  };
  return newRow(childId, data as unknown as Record<string, unknown>, meta);
}

/** Read one fanout intent row's data, failing closed on any shape drift. */
export function readFanoutIntentRow(row: StoredRow): FanoutIntentData {
  const data = checkRecord(row.data, 'work.fanout_intent data');
  const cohort = checkCohort(data['cohort']);
  const members = checkFanoutIdentitySet(data['members'], 'work.fanout_intent.members');
  const memberCount = checkCount(data, 'memberCount', 'work.fanout_intent');
  if (memberCount !== members.length) {
    throw new StateError(
      'validation',
      `work.fanout_intent.memberCount ${memberCount} mismatches members length ${members.length}.`,
    );
  }
  const fanoutId = checkDataString(data, 'fanoutId', 'work.fanout_intent');
  const sourceOccurrence = checkDataString(data, 'sourceOccurrence', 'work.fanout_intent');
  const handler = checkDataString(data, 'handler', 'work.fanout_intent');
  if (fanoutId !== fanoutIntentRowId(sourceOccurrence, handler, cohort)) {
    throw new StateError(
      'validation',
      'work.fanout_intent.fanoutId is not the cutoff+cohort derivation.',
    );
  }
  if (row.id !== fanoutId) {
    throw new StateError('validation', 'work.fanout_intent row id must equal its fanoutId.');
  }
  return { fanoutId, sourceOccurrence, handler, cohort, members, memberCount };
}

/** Read one fanout checkpoint row's data, failing closed on any shape drift. */
export function readFanoutCheckpointRow(row: StoredRow): FanoutCheckpointData {
  const data = checkRecord(row.data, 'work.fanout_checkpoint data');
  const fanoutId = checkDataString(data, 'fanoutId', 'work.fanout_checkpoint');
  const completed = checkFanoutIdentitySet(data['completed'], 'work.fanout_checkpoint.completed');
  const cursor = checkNullableString(data, 'cursor', 'work.fanout_checkpoint');
  if (cursor !== null && cursor === '') {
    throw new StateError('validation', 'work.fanout_checkpoint.cursor must be non-empty or null.');
  }
  if (row.id !== fanoutId) {
    throw new StateError('validation', 'work.fanout_checkpoint row id must equal its fanoutId.');
  }
  return { fanoutId, completed, cursor };
}

/** Read one fanout child row's data, failing closed on any shape drift. */
export function readFanoutChildRow(row: StoredRow): FanoutChildData {
  const data = checkRecord(row.data, 'work.fanout_child data');
  const state = checkDataString(data, 'state', 'work.fanout_child');
  if (!FANOUT_CHILD_STATES.has(state)) {
    throw new StateError(
      'validation',
      `work.fanout_child.state is unknown: ${JSON.stringify(state)}.`,
    );
  }
  const causeKind = data['causeKind'];
  if (causeKind !== null && causeKind !== 'completed' && causeKind !== 'skipped' && causeKind !== 'failed') {
    throw new StateError(
      'validation',
      `work.fanout_child.causeKind is unknown: ${JSON.stringify(causeKind)}.`,
    );
  }
  const typedState = state as FanoutChildData['state'];
  const causeReason = checkNullableString(data, 'causeReason', 'work.fanout_child');
  checkChildCause(typedState, causeKind, causeReason);
  const fanoutId = checkDataString(data, 'fanoutId', 'work.fanout_child');
  const parentOccurrence = checkDataString(data, 'parentOccurrence', 'work.fanout_child');
  const handler = checkDataString(data, 'handler', 'work.fanout_child');
  const recordId = checkDataString(data, 'recordId', 'work.fanout_child');
  const childId = checkDataString(data, 'childId', 'work.fanout_child');
  if (childId !== fanoutChildRowId(parentOccurrence, handler, recordId)) {
    throw new StateError(
      'validation',
      'work.fanout_child.childId is not the parent+handler+record derivation.',
    );
  }
  if (row.id !== childId) {
    throw new StateError('validation', 'work.fanout_child row id must equal its childId.');
  }
  return {
    fanoutId,
    parentOccurrence,
    handler,
    recordId,
    childId,
    state: typedState,
    attempts: checkCount(data, 'attempts', 'work.fanout_child'),
    causeKind,
    causeReason,
  };
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
  checkComponent(fanoutId, 'fanoutId');
  if (opts.cursor !== null && opts.cursor === '') {
    throw new StateError('validation', 'Fanout page cursor must be non-empty or null.');
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1) {
    throw new StateError('validation', 'Fanout page limit must be an integer >= 1.');
  }
  return {
    model: FANOUT_CHILD_MODEL as ModelName,
    where:
      opts.cursor === null
        ? { op: 'eq', field: 'fanoutId', value: fanoutId }
        : {
            op: 'and',
            args: [
              { op: 'eq', field: 'fanoutId', value: fanoutId },
              { op: 'gt', field: 'id', value: opts.cursor },
            ],
          },
    order: [{ field: 'id', direction: 'asc' }],
    limit: opts.limit,
    authority: 'owner',
  };
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
  if (!Number.isInteger(limit) || limit < 1) {
    throw new StateError('validation', 'Fanout page limit must be an integer >= 1.');
  }
  if (rows.length > limit) {
    throw new StateError(
      'validation',
      `Fanout page returned ${rows.length} rows past limit ${limit}.`,
    );
  }
  if (rows.length < limit) {
    return { rows, done: true, cursor: null };
  }
  const last = rows[rows.length - 1];
  if (last === undefined) {
    throw new StateError('validation', 'Fanout page is unreachable: full page has no last row.');
  }
  return { rows, done: false, cursor: last.id as string };
}
