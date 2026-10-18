// W02.2 — Ordered row, identity and set TS mechanisms, extracted from
// live donors into the contracts-only leaf. No consumer adoption: the
// donors keep serving callers; this module is proven against frozen
// independent originals (conformance/fixtures/rows/) in BOTH producer
// directions. Behavior contract (verified against donor sources):
// - Eight table shapes: work.dispatch/occurrence/schedule/every_slot/
//   supersession (work-only) + fanout_intent/checkpoint/child (shared).
// - The implicit "which module you imported" profile dimension is now
//   an explicit `direction` argument on every shared function. There is
//   no default: callers state 'work' or 'state'.
// - 'work' direction: KernelTableError failures + JSON-safety traversal
//   before clone (fail-closed on non-finite/function/symbol/bigint/
//   cyclic data). 'state' direction: StateError('validation') failures
//   + clone-only replacement (structuredClone is the only gate).
// - JS counts (integer >= 0), finite epoch instants, UTF-16 code-unit
//   identity/set order (bare `.sort()`), encodeURIComponent id
//   components (lone-surrogate input throws the engine URIError),
//   metadata stamps, and default presence (`??` rules) are verbatim.
// - Error classes carry the donor `.name` per direction
//   ('KernelTableError' / 'StateError' + code 'validation'); class
//   identity differs by module, so conformance compares name/code/
//   message/details and the complete own-key sequence, including the
//   state donor's undefined retryable/fields/conflict validation fields.

import type {
  ConflictCurrent,
  FieldError,
  ModelName,
  QuerySpec,
  RecordId,
  RecordVersion,
  StateErrorCode,
  StoredRow,
} from '@canlang/contracts';
import type {
  ClaimId,
  FanoutChildId,
  FanoutChildState,
  FanoutCohortKind,
  FanoutFailedReason,
  FanoutId,
  FanoutSkippedReason,
  OccurrenceId,
  OutboxId,
  OutboxItemState,
  RecurringScope,
  RetryClass,
  ScheduledOccurrenceState,
  WorkScope,
} from '@canlang/contracts';

/** Minimal global structuredClone shape (Node >= 22 runtime). */
declare const structuredClone: <T>(value: T) => T;

/** Explicit producer direction. No default; no fallthrough. */
export type RowsDirection = 'work' | 'state';

/** Work-direction failure. `.name` matches the work donor. */
export class RowsKernelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KernelTableError';
  }
}

/**
 * Owning error factory. The leaf never catches caller exceptions, so a
 * retained genuine error rethrown through a caller getter/proxy keeps its
 * identity: genuine failures are *constructed* as the owning error at the
 * exact failure site instead. Work passes its `KernelTableError`
 * factory; every other caller (including state) uses the default, which
 * constructs the existing `RowsKernelError`. No ambient error context:
 * the factory threads explicitly through the check/newRow chain.
 */
export interface RowsErrorFactory {
  kernelError(message: string): Error;
}

const defaultRowsErrors: RowsErrorFactory = {
  kernelError: (message: string): Error => new RowsKernelError(message),
};

/** Construct the owning work-direction failure at a genuine leaf site. */
function leafKernelError(message: string, errors: RowsErrorFactory = defaultRowsErrors): never {
  throw errors.kernelError(message);
}

/** State-direction failure. Observed error shape matches the state donor. */
export class RowsStateError extends Error {
  readonly code: StateErrorCode;
  readonly details: unknown;
  readonly retryable?: boolean;
  readonly fields?: FieldError[];
  readonly conflict?: ConflictCurrent;
  constructor(message: string) {
    super(message);
    this.name = 'StateError';
    this.code = 'validation';
    this.details = null;
  }
}

function fail(
  direction: RowsDirection,
  message: string,
  errors: RowsErrorFactory = defaultRowsErrors,
): never {
  if (direction === 'work') {
    throw leafKernelError(message, errors);
  }
  throw new RowsStateError(message);
}

// ---- Shared checkers (verbatim donor logic; direction picks the error) ----

function checkRecord(value: unknown, what: string, direction: RowsDirection, errors: RowsErrorFactory = defaultRowsErrors): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(direction, `${what} must be an object.`, errors);
  }
  return value as Record<string, unknown>;
}

function checkString(
  record: Record<string, unknown>,
  field: string,
  what: string,
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): string {
  const value = record[field];
  if (typeof value !== 'string' || value === '') {
    fail(direction, `${what}.${field} must be a non-empty string.`, errors);
  }
  return value;
}

function checkNullableString(
  record: Record<string, unknown>,
  field: string,
  what: string,
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): string | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== 'string') {
    fail(direction, `${what}.${field} must be a string or null.`, errors);
  }
  return value;
}

function checkCount(
  record: Record<string, unknown>,
  field: string,
  what: string,
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(direction, `${what}.${field} must be an integer >= 0.`, errors);
  }
  return value;
}

function checkInstant(
  record: Record<string, unknown>,
  field: string,
  what: string,
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(direction, `${what}.${field} must be finite epoch ms >= 0.`, errors);
  }
  return value;
}

function checkNullableInstant(
  record: Record<string, unknown>,
  field: string,
  what: string,
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): number | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(direction, `${what}.${field} must be finite epoch ms or null.`, errors);
  }
  return value;
}

/** Deep JSON-safety: work-profile rows must survive the store JSON round-trip. */
function checkJsonSafe(value: unknown, what: string, errors: RowsErrorFactory = defaultRowsErrors): void {
  const seen = new Set<object>();
  const visit = (node: unknown, path: string): void => {
    if (node === null) return;
    switch (typeof node) {
      case 'string':
      case 'boolean':
        return;
      case 'number':
        if (!Number.isFinite(node)) {
          throw leafKernelError(`${what}${path} must be finite JSON.`, errors);
        }
        return;
      case 'undefined':
      case 'function':
      case 'symbol':
      case 'bigint':
        throw leafKernelError(`${what}${path} is not JSON-safe.`, errors);
      case 'object': {
        if (seen.has(node)) {
          throw leafKernelError(`${what}${path} is cyclic.`, errors);
        }
        seen.add(node);
        if (Array.isArray(node)) {
          node.forEach((entry, index) => visit(entry, `${path}[${index}]`));
          return;
        }
        for (const [key, entry] of Object.entries(node)) {
          visit(entry, `${path}.${key}`);
        }
        return;
      }
    }
  };
  visit(value, '');
}

function checkIdComponent(value: string, short: string, direction: RowsDirection, errors: RowsErrorFactory = defaultRowsErrors): string {
  if (typeof value !== 'string' || value === '') {
    if (direction === 'work') {
      fail(direction, `fanout ${short} must be a non-empty string.`, errors);
    }
    fail(direction, `Fanout ${short} must be a non-empty string.`, errors);
  }
  return value;
}

function checkCohort(value: unknown, direction: RowsDirection, errors: RowsErrorFactory = defaultRowsErrors): FanoutCohortKind {
  if (value !== 'model' && value !== 'anchored-collection') {
    if (direction === 'work') {
      fail(direction, `fanout cohort must be model or anchored-collection, got ${JSON.stringify(value)}.`, errors);
    }
    fail(direction, `Fanout cohort must be model or anchored-collection, got ${JSON.stringify(value)}.`, errors);
  }
  return value;
}

function checkMeta(
  meta: NewRowMeta,
  what: string,
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): void {
  if (!Number.isFinite(meta.nowMs) || meta.nowMs < 0) {
    fail(direction, `${what}: nowMs must be finite epoch ms >= 0.`, errors);
  }
  if (typeof meta.actor !== 'string' || meta.actor === '') {
    fail(direction, `${what}: actor must be a non-empty string.`, errors);
  }
}

function newRowCore(
  id: string,
  data: Readonly<Record<string, unknown>>,
  meta: NewRowMeta,
  what: string,
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): StoredRow {
  checkMeta(meta, what, direction, errors);
  if (direction === 'work') {
    checkJsonSafe(data, `${what} data`, errors);
  }
  return {
    id: id as RecordId,
    version: 1 as RecordVersion,
    created: meta.nowMs,
    updated: meta.nowMs,
    createdBy: meta.actor,
    updatedBy: meta.actor,
    archivedAt: null,
    parent: null,
    // Deep clone: staged rows must not alias caller-owned nested data.
    data: structuredClone(data),
  };
}

// ---- Kernel tables (work-only; donor-identical signatures) ----

/** Lane-04-owned table models (branded casts, mirroring L3 usage). */
export const WORK_DISPATCH_MODEL = 'work.dispatch' as ModelName;
export const WORK_OCCURRENCE_MODEL = 'work.occurrence' as ModelName;
export const WORK_SCHEDULE_MODEL = 'work.schedule' as ModelName;
export const WORK_EVERY_SLOT_MODEL = 'work.every_slot' as ModelName;
export const WORK_SUPERSESSION_MODEL = 'work.supersession' as ModelName;

/** Claim lifecycle per staged intent. Flat for store querying. */
export interface DispatchRowData {
  readonly intentId: OutboxId;
  readonly operationId: string;
  readonly source: string;
  readonly occurrenceIndex: number;
  readonly originOccurrence: OccurrenceId | null;
  readonly state: OutboxItemState;
  /** Completed provider attempts so far. */
  readonly attempts: number;
  readonly claimId: ClaimId | null;
  /** UTC epoch ms when the current claim was taken, if any. */
  readonly claimedAtMs: number | null;
  /** Last guard verdict; false pins the item undispatched (skipped). */
  readonly guardVerdict: boolean | null;
  readonly deliveryId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** Retry availability (`computeBackoff` notBeforeMs), if deferred. */
  readonly availableAtMs: number | null;
  /** First provider-attempt start (claim time), for horizon checks. */
  readonly firstAttemptAtMs: number | null;
  /**
   * Failure classification from `record-attempt`, mirroring
   * `classifyFailure`. Only `failed` rows carry one.
   */
  readonly retryClass: RetryClass | null;
}

/** Execution receipt per admitted occurrence. */
export interface OccurrenceRowData {
  readonly occurrenceId: OccurrenceId;
  readonly status: 'completed' | 'failed';
  readonly result: unknown;
  readonly code: string | null;
  readonly message: string | null;
  readonly recordedAtMs: number;
}

/** Keyed schedule lineage entry. Scope flattened for querying. */
export interface ScheduleRowData {
  readonly occurrenceId: OccurrenceId;
  readonly key: string;
  readonly scopeApp: string;
  readonly scopeOwner: string;
  readonly scopeOwnerPackage: string;
  readonly at: number;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * Previous lineage head this entry observed, if any. Occurrence ids
   * are opaque, so the head resolves through this backward link —
   * never by id comparison.
   */
  readonly replaces: OccurrenceId | null;
  readonly state: ScheduledOccurrenceState;
}

/** Last admitted `every` slot per fanout scope key. */
export interface EverySlotRowData {
  readonly scopeKey: string;
  readonly app: string;
  readonly handler: string;
  readonly scope: RecurringScope;
  readonly owner: string;
  /** UTC epoch slot in seconds. */
  readonly slot: number;
}

/** Superseded delivery intent with its marking provenance. */
export interface SupersessionRowData {
  readonly outboxId: OutboxId;
  /** Occurrence whose transition marked this id, if known. */
  readonly byOccurrenceId: OccurrenceId | null;
  readonly markedAtMs: number;
}

const OUTBOX_STATES: ReadonlySet<string> = new Set([
  'pending',
  'claimed',
  'delivered',
  'failed',
  'uncertain',
  'dead',
]);

const SCHEDULE_STATES: ReadonlySet<string> = new Set([
  'pending',
  'admitted',
  'superseded',
  'cancelled',
]);

/** Read one dispatch row's data, failing closed on any shape drift. */
export function readDispatchRow(row: StoredRow, errors: RowsErrorFactory = defaultRowsErrors): DispatchRowData {
  const direction: RowsDirection = 'work';
  const data = checkRecord(row.data, 'work.dispatch data', direction, errors);
  const state = checkString(data, 'state', 'work.dispatch', direction, errors);
  if (!OUTBOX_STATES.has(state)) {
    throw leafKernelError(`work.dispatch.state is unknown: ${JSON.stringify(state)}.`, errors);
  }
  const guardVerdict = data['guardVerdict'];
  if (guardVerdict !== null && typeof guardVerdict !== 'boolean') {
    throw leafKernelError('work.dispatch.guardVerdict must be boolean or null.', errors);
  }
  const retryClass = data['retryClass'];
  if (retryClass !== null && retryClass !== 'transient' && retryClass !== 'terminal') {
    throw leafKernelError(
      'work.dispatch.retryClass must be transient, terminal or null.',
     errors);
  }
  return {
    intentId: checkString(data, 'intentId', 'work.dispatch', direction, errors),
    operationId: checkString(data, 'operationId', 'work.dispatch', direction, errors),
    source: checkString(data, 'source', 'work.dispatch', direction, errors),
    occurrenceIndex: checkCount(data, 'occurrenceIndex', 'work.dispatch', direction, errors),
    originOccurrence: checkNullableString(data, 'originOccurrence', 'work.dispatch', direction, errors),
    state: state as OutboxItemState,
    attempts: checkCount(data, 'attempts', 'work.dispatch', direction, errors),
    claimId: checkNullableString(data, 'claimId', 'work.dispatch', direction, errors),
    claimedAtMs: checkNullableInstant(data, 'claimedAtMs', 'work.dispatch', direction, errors),
    guardVerdict,
    deliveryId: checkNullableString(data, 'deliveryId', 'work.dispatch', direction, errors),
    errorCode: checkNullableString(data, 'errorCode', 'work.dispatch', direction, errors),
    errorMessage: checkNullableString(data, 'errorMessage', 'work.dispatch', direction, errors),
    availableAtMs: checkNullableInstant(data, 'availableAtMs', 'work.dispatch', direction, errors),
    firstAttemptAtMs: checkNullableInstant(data, 'firstAttemptAtMs', 'work.dispatch', direction, errors),
    retryClass: retryClass as RetryClass | null,
  };
}

/** Read one occurrence row's data, failing closed on any shape drift. */
export function readOccurrenceRow(row: StoredRow, errors: RowsErrorFactory = defaultRowsErrors): OccurrenceRowData {
  const direction: RowsDirection = 'work';
  const data = checkRecord(row.data, 'work.occurrence data', direction, errors);
  const status = data['status'];
  if (status !== 'completed' && status !== 'failed') {
    throw leafKernelError(
      `work.occurrence.status must be completed or failed, got ${JSON.stringify(status)}.`,
     errors);
  }
  return {
    occurrenceId: checkString(data, 'occurrenceId', 'work.occurrence', direction, errors),
    status,
    result: data['result'] ?? null,
    code: checkNullableString(data, 'code', 'work.occurrence', direction, errors),
    message: checkNullableString(data, 'message', 'work.occurrence', direction, errors),
    recordedAtMs: checkInstant(data, 'recordedAtMs', 'work.occurrence', direction, errors),
  };
}

/** Read one schedule row's data, failing closed on any shape drift. */
export function readScheduleRow(row: StoredRow, errors: RowsErrorFactory = defaultRowsErrors): ScheduleRowData {
  const direction: RowsDirection = 'work';
  const data = checkRecord(row.data, 'work.schedule data', direction, errors);
  const state = checkString(data, 'state', 'work.schedule', direction, errors);
  if (!SCHEDULE_STATES.has(state)) {
    throw leafKernelError(`work.schedule.state is unknown: ${JSON.stringify(state)}.`, errors);
  }
  return {
    occurrenceId: checkString(data, 'occurrenceId', 'work.schedule', direction, errors),
    key: checkString(data, 'key', 'work.schedule', direction, errors),
    scopeApp: checkString(data, 'scopeApp', 'work.schedule', direction, errors),
    scopeOwner: checkString(data, 'scopeOwner', 'work.schedule', direction, errors),
    scopeOwnerPackage: checkString(data, 'scopeOwnerPackage', 'work.schedule', direction, errors),
    at: checkInstant(data, 'at', 'work.schedule', direction, errors),
    event: checkString(data, 'event', 'work.schedule', direction, errors),
    payload: checkRecord(data['payload'], 'work.schedule.payload', direction, errors),
    replaces: checkNullableString(data, 'replaces', 'work.schedule', direction, errors) as OccurrenceId | null,
    state: state as ScheduledOccurrenceState,
  };
}

/** Rebuild the contract scope from a schedule row's flat fields. */
export function scheduleRowScope(row: ScheduleRowData): WorkScope {
  return {
    app: row.scopeApp,
    owner: row.scopeOwner,
    ownerPackage: row.scopeOwnerPackage,
  };
}

/** Read one every-slot row's data, failing closed on any shape drift. */
export function readEverySlotRow(row: StoredRow, errors: RowsErrorFactory = defaultRowsErrors): EverySlotRowData {
  const direction: RowsDirection = 'work';
  const data = checkRecord(row.data, 'work.every_slot data', direction, errors);
  const scope = data['scope'];
  if (scope !== 'team' && scope !== 'app') {
    throw leafKernelError(
      `work.every_slot.scope must be team or app, got ${JSON.stringify(scope)}.`,
     errors);
  }
  return {
    scopeKey: checkString(data, 'scopeKey', 'work.every_slot', direction, errors),
    app: checkString(data, 'app', 'work.every_slot', direction, errors),
    handler: checkString(data, 'handler', 'work.every_slot', direction, errors),
    scope,
    owner: checkString(data, 'owner', 'work.every_slot', direction, errors),
    slot: checkCount(data, 'slot', 'work.every_slot', direction, errors),
  };
}

/** Read one supersession row's data, failing closed on any shape drift. */
export function readSupersessionRow(row: StoredRow, errors: RowsErrorFactory = defaultRowsErrors): SupersessionRowData {
  const direction: RowsDirection = 'work';
  const data = checkRecord(row.data, 'work.supersession data', direction, errors);
  return {
    outboxId: checkString(data, 'outboxId', 'work.supersession', direction, errors),
    byOccurrenceId: checkNullableString(data, 'byOccurrenceId', 'work.supersession', direction, errors),
    markedAtMs: checkInstant(data, 'markedAtMs', 'work.supersession', direction, errors),
  };
}

export interface NewRowMeta {
  /** UTC epoch ms for created/updated. */
  readonly nowMs: number;
  /** Actor identity for createdBy/updatedBy. */
  readonly actor: string;
}

/** State donor's identical meta shape. */
export type FanoutRowMeta = NewRowMeta;

/**
 * Replacement row for a conditional update: version + 1 with fresh
 * updated metadata. Callers stage it with `expectedVersion: row.version`.
 */
export function withRowData(
  row: StoredRow,
  data: Readonly<Record<string, unknown>>,
  meta: NewRowMeta,
  what: string,

  errors: RowsErrorFactory = defaultRowsErrors): StoredRow {
  const direction: RowsDirection = 'work';
  checkMeta(meta, what, direction, errors);
  checkJsonSafe(data, `${what} data`, errors);
  return {
    ...row,
    version: (row.version + 1) as RecordVersion,
    updated: meta.nowMs,
    updatedBy: meta.actor,
    // Deep clone: staged rows must not alias caller-owned nested data.
    data: structuredClone(data),
  };
}

/** Producer-side insert: the pending dispatch row for one staged intent. */
export function newDispatchRow(
  input: Pick<
    DispatchRowData,
    'intentId' | 'operationId' | 'source' | 'occurrenceIndex' | 'originOccurrence'
  >,
  meta: NewRowMeta,

  errors: RowsErrorFactory = defaultRowsErrors): StoredRow {
  const data: DispatchRowData = {
    ...input,
    state: 'pending',
    attempts: 0,
    claimId: null,
    claimedAtMs: null,
    guardVerdict: null,
    deliveryId: null,
    errorCode: null,
    errorMessage: null,
    availableAtMs: null,
    firstAttemptAtMs: null,
    retryClass: null,
  };
  return newRowCore(input.intentId, data as unknown as Record<string, unknown>, meta, 'work.dispatch', 'work', errors);
}

/** Put-if-absent occurrence receipt row. */
export function newOccurrenceRow(
  input: OccurrenceRowData,
  meta: NewRowMeta,

  errors: RowsErrorFactory = defaultRowsErrors): StoredRow {
  return newRowCore(
    input.occurrenceId,
    input as unknown as Record<string, unknown>,
    meta,
    'work.occurrence',
    'work',
   errors);
}

/** Keyed schedule lineage row (id = occurrence id; key is looked up). */
export function newScheduleRow(
  input: ScheduleRowData,
  meta: NewRowMeta,

  errors: RowsErrorFactory = defaultRowsErrors): StoredRow {
  return newRowCore(
    input.occurrenceId,
    input as unknown as Record<string, unknown>,
    meta,
    'work.schedule',
    'work',
   errors);
}

/**
 * Durable every-slot tracker id. Qualified by app and handler because
 * `admitEveryTick` coalesces per (app, handler, scope, owner).
 * Components are encoded so `/` separators stay unambiguous.
 */
export function everySlotRowId(
  app: string,
  handler: string,
  scope: RecurringScope,
  owner: string,
): string {
  return `every/v1/${encodeURIComponent(app)}/${encodeURIComponent(handler)}/${scope}/${encodeURIComponent(owner)}`;
}

/** Every-slot tracker row (id = app/handler/scope/owner tuple). */
export function newEverySlotRow(
  input: EverySlotRowData,
  meta: NewRowMeta,

  errors: RowsErrorFactory = defaultRowsErrors): StoredRow {
  return newRowCore(
    everySlotRowId(input.app, input.handler, input.scope, input.owner),
    input as unknown as Record<string, unknown>,
    meta,
    'work.every_slot',
    'work',
   errors);
}

/** Supersession mark row (id = outbox id). */
export function newSupersessionRow(
  input: SupersessionRowData,
  meta: NewRowMeta,

  errors: RowsErrorFactory = defaultRowsErrors): StoredRow {
  return newRowCore(
    input.outboxId,
    input as unknown as Record<string, unknown>,
    meta,
    'work.supersession',
    'work',
   errors);
}

/**
 * Dispatch rows stamped with one origin occurrence. Stages re-filter
 * exactly; the predicate only narrows the scan.
 */
export function dispatchByOriginQuery(originOccurrence: OccurrenceId): QuerySpec {
  return {
    model: WORK_DISPATCH_MODEL,
    where: { op: 'eq', field: 'originOccurrence', value: originOccurrence },
    authority: 'owner',
  };
}

/** Dispatch rows in one lifecycle state. Stages re-filter exactly. */
export function dispatchByStateQuery(state: OutboxItemState): QuerySpec {
  return {
    model: WORK_DISPATCH_MODEL,
    where: { op: 'eq', field: 'state', value: state },
    authority: 'owner',
  };
}

/**
 * Schedule rows under one key within one scope. The flat scope fields
 * disjoin here and stages re-filter exactly.
 */
export function scheduleByKeyQuery(scope: WorkScope, key: string): QuerySpec {
  return {
    model: WORK_SCHEDULE_MODEL,
    where: {
      op: 'and',
      args: [
        { op: 'eq', field: 'key', value: key },
        { op: 'eq', field: 'scopeApp', value: scope.app },
        { op: 'eq', field: 'scopeOwner', value: scope.owner },
        { op: 'eq', field: 'scopeOwnerPackage', value: scope.ownerPackage },
      ],
    },
    authority: 'owner',
  };
}

/* -- Durable fanout tables (shared work + state directions). -- */

/** Lane-04-owned fanout table models (branded casts, mirroring L3 usage). */
export const WORK_FANOUT_INTENT_MODEL = 'work.fanout_intent' as ModelName;
export const WORK_FANOUT_CHECKPOINT_MODEL = 'work.fanout_checkpoint' as ModelName;
export const WORK_FANOUT_CHILD_MODEL = 'work.fanout_child' as ModelName;

/** State-owned fanout table models (structural literals, same strings). */
export const FANOUT_INTENT_MODEL = 'work.fanout_intent';
export const FANOUT_CHECKPOINT_MODEL = 'work.fanout_checkpoint';
export const FANOUT_CHILD_MODEL = 'work.fanout_child';

/**
 * Committed fanout intent row: cutoff + cohort + frozen members.
 * `fanoutId` is the deterministic cutoff+cohort row id: opaque to
 * callers, minted by the runtime as this derivation so the store
 * enforces insert-once.
 */
export interface FanoutIntentRowData {
  readonly fanoutId: FanoutId;
  readonly sourceOccurrence: OccurrenceId;
  readonly handler: string;
  readonly cohort: FanoutCohortKind;
  /**
   * Frozen canonical admitted record identities in sorted canonical
   * order. The complete set for this occurrence: never truncated,
   * never extended by late inserts.
   */
  readonly members: ReadonlyArray<string>;
  /** Flat duplicate of `members.length` for querying. */
  readonly memberCount: number;
}

/** State donor's structurally identical intent data. */
export type FanoutIntentData = FanoutIntentRowData;

/**
 * Durable fanout checkpoint row: completed-child set plus enumeration
 * cursor. `completed` holds canonical record ids with a recorded
 * terminal child outcome, scoped by `fanoutId`.
 */
export interface FanoutCheckpointRowData {
  readonly fanoutId: FanoutId;
  /** Completed record ids in sorted canonical order (deduped set). */
  readonly completed: ReadonlyArray<string>;
  /**
   * Opaque enumeration cursor; null only when enumeration is fully
   * admitted. A non-null cursor means resume, never silent truncation.
   */
  readonly cursor: string | null;
}

/** State donor's structurally identical checkpoint data. */
export type FanoutCheckpointData = FanoutCheckpointRowData;

/**
 * Per-child row. `childId` duplicates the row id (the full
 * FanoutChildId encoding) as a flat field; `fanoutId` scopes the
 * bounded page scans. Cause fields are flat (nested cause records
 * are not store-addressable): null until the child is terminal.
 */
export interface FanoutChildRowData {
  readonly fanoutId: FanoutId;
  readonly parentOccurrence: OccurrenceId;
  readonly handler: string;
  readonly recordId: string;
  readonly childId: string;
  readonly state: FanoutChildState;
  /** Committed child attempts so far. */
  readonly attempts: number;
  readonly causeKind: 'completed' | 'skipped' | 'failed' | null;
  readonly causeReason: string | null;
}

/** State donor's structurally identical child data. */
export type FanoutChildData = FanoutChildRowData;

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

/**
 * Validate one frozen identity set: an array of non-empty canonical
 * record ids, deduped, returned in sorted canonical order (UTF-16
 * code-unit order via bare `.sort()`). Duplicates fail closed.
 */
export function checkFanoutIdentitySet(
  value: unknown,
  what: string,
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    fail(direction, `${what} must be an array of canonical record ids.`, errors);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') {
      fail(direction, `${what} entries must be non-empty strings.`, errors);
    }
    if (seen.has(entry)) {
      fail(direction, `${what} contains a duplicate identity: ${JSON.stringify(entry)}.`, errors);
    }
    seen.add(entry);
  }
  return [...seen].sort();
}

/**
 * Deterministic fanout intent row id under FanoutCutoff + cohort.
 * Components are encoded so `/` separators stay unambiguous. A second
 * insert for the same source-occurrence/handler/cohort collides on the
 * store primary key — the insert-once rule.
 */
export function fanoutIntentRowId(
  sourceOccurrence: string,
  handler: string,
  cohort: FanoutCohortKind,
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): FanoutId {
  checkIdComponent(sourceOccurrence, 'sourceOccurrence', direction, errors);
  checkIdComponent(handler, 'handler', direction, errors);
  checkCohort(cohort, direction, errors);
  return `fanout/v1/${encodeURIComponent(sourceOccurrence)}/${encodeURIComponent(handler)}/${cohort}`;
}

/** Checkpoint row id: exactly one checkpoint row per fanout id. */
export function fanoutCheckpointRowId(fanoutId: FanoutId, direction: RowsDirection, errors: RowsErrorFactory = defaultRowsErrors): string {
  return checkIdComponent(fanoutId, 'fanoutId', direction, errors);
}

/**
 * Per-child row id: the full FanoutChildId (parent occurrence +
 * handler + record), encoded so `/` separators stay unambiguous.
 * Same parent+record under different handlers yields different ids;
 * the same triple always yields the same id, so retries reuse the
 * row and duplicate deliveries replay instead of minting.
 */
export function fanoutChildRowId(
  parentOccurrence: string,
  handler: string,
  recordId: string,
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): string {
  checkIdComponent(parentOccurrence, 'parentOccurrence', direction, errors);
  checkIdComponent(handler, 'handler', direction, errors);
  checkIdComponent(recordId, 'recordId', direction, errors);
  return `fanout-child/v1/${encodeURIComponent(parentOccurrence)}/${encodeURIComponent(handler)}/${encodeURIComponent(recordId)}`;
}

/** Producer-side insert: the committed fanout intent row. */
export function newFanoutIntentRow(
  input: {
    readonly sourceOccurrence: string;
    readonly handler: string;
    readonly cohort: FanoutCohortKind;
    readonly members: ReadonlyArray<string>;
  },
  meta: NewRowMeta,
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): StoredRow {
  const members = checkFanoutIdentitySet(input.members, 'work.fanout_intent.members', direction, errors);
  const fanoutId = fanoutIntentRowId(input.sourceOccurrence, input.handler, input.cohort, direction, errors);
  const data: FanoutIntentRowData = {
    fanoutId,
    sourceOccurrence: input.sourceOccurrence,
    handler: input.handler,
    cohort: input.cohort,
    members,
    memberCount: members.length,
  };
  return newRowCore(fanoutId, data as unknown as Record<string, unknown>, meta, 'work.fanout_intent', direction, errors);
}

/** Producer-side insert: the initial checkpoint row (empty set, null cursor). */
export function newFanoutCheckpointRow(
  input: {
    readonly fanoutId: FanoutId;
    readonly completed?: ReadonlyArray<string>;
    readonly cursor?: string | null;
  },
  meta: NewRowMeta,
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): StoredRow {
  const data: FanoutCheckpointRowData = {
    fanoutId: checkIdComponent(input.fanoutId, 'fanoutId', direction, errors),
    completed: checkFanoutIdentitySet(input.completed ?? [], 'work.fanout_checkpoint.completed', direction, errors),
    cursor: input.cursor ?? null,
  };
  if (data.cursor !== null && data.cursor === '') {
    fail(direction, 'work.fanout_checkpoint.cursor must be non-empty or null.', errors);
  }
  return newRowCore(
    fanoutCheckpointRowId(data.fanoutId, direction, errors),
    data as unknown as Record<string, unknown>,
    meta,
    'work.fanout_checkpoint',
    direction,
   errors);
}

/**
 * Pure checkpoint advance for the conditional-update upsert: unions
 * newly completed record ids into the completed set (deduped, sorted
 * canonical order) and carries the next cursor. Re-adding an
 * already-completed identity is an idempotent no-op, never a
 * duplicate error. Callers stage the result with `withRowData` /
 * `withFanoutRowData` under `expectedVersion: row.version`, so
 * concurrent advances serialize on the store fence.
 */
export function nextFanoutCheckpointData(
  current: FanoutCheckpointRowData,
  addCompleted: ReadonlyArray<string>,
  cursor: string | null,
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): FanoutCheckpointRowData {
  if (cursor !== null && cursor === '') {
    fail(direction, 'work.fanout_checkpoint.cursor must be non-empty or null.', errors);
  }
  for (const entry of addCompleted) {
    if (typeof entry !== 'string' || entry === '') {
      fail(direction, 'work.fanout_checkpoint.completed entries must be non-empty strings.', errors);
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
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): void {
  if (state === 'pending' || state === 'running') {
    if (causeKind !== null || causeReason !== null) {
      fail(direction, `work.fanout_child cause must be null until terminal, got ${JSON.stringify(causeKind)}.`, errors);
    }
    return;
  }
  if (state === 'completed') {
    if (causeKind !== 'completed' || causeReason !== null) {
      fail(direction, 'work.fanout_child completed cause must be kind completed with no reason.', errors);
    }
    return;
  }
  if (state === 'skipped') {
    if (causeKind !== 'skipped' || !FANOUT_SKIPPED_REASONS.has(causeReason ?? '')) {
      fail(direction, `work.fanout_child skipped cause needs a closed reason, got ${JSON.stringify(causeReason)}.`, errors);
    }
    return;
  }
  if (causeKind !== 'failed' || !FANOUT_FAILED_REASONS.has(causeReason ?? '')) {
    fail(direction, `work.fanout_child failed cause needs a closed reason, got ${JSON.stringify(causeReason)}.`, errors);
  }
}

/** Producer-side insert: one admitted child row (default pending, zero attempts). */
export function newFanoutChildRow(
  input: {
    readonly fanoutId: FanoutId;
    readonly parentOccurrence: string;
    readonly handler: string;
    readonly recordId: string;
    readonly state?: FanoutChildState;
    readonly attempts?: number;
    readonly causeKind?: 'completed' | 'skipped' | 'failed' | null;
    readonly causeReason?: FanoutSkippedReason | FanoutFailedReason | null;
  },
  meta: NewRowMeta,
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): StoredRow {
  const state = input.state ?? 'pending';
  if (!FANOUT_CHILD_STATES.has(state)) {
    fail(direction, `work.fanout_child.state is unknown: ${JSON.stringify(state)}.`, errors);
  }
  const attempts = input.attempts ?? 0;
  if (!Number.isInteger(attempts) || attempts < 0) {
    fail(direction, 'work.fanout_child.attempts must be an integer >= 0.', errors);
  }
  const causeKind = input.causeKind ?? null;
  const causeReason = (input.causeReason ?? null) as string | null;
  checkChildCause(state, causeKind, causeReason, direction, errors);
  const childId = fanoutChildRowId(input.parentOccurrence, input.handler, input.recordId, direction, errors);
  const data: FanoutChildRowData = {
    fanoutId: checkIdComponent(input.fanoutId, 'fanoutId', direction, errors),
    parentOccurrence: input.parentOccurrence,
    handler: input.handler,
    recordId: input.recordId,
    childId,
    state,
    attempts,
    causeKind,
    causeReason,
  };
  return newRowCore(childId, data as unknown as Record<string, unknown>, meta, 'work.fanout_child', direction, errors);
}

/** Read one fanout intent row's data, failing closed on any shape drift. */
export function readFanoutIntentRow(row: StoredRow, direction: RowsDirection, errors: RowsErrorFactory = defaultRowsErrors): FanoutIntentRowData {
  const data = checkRecord(row.data, 'work.fanout_intent data', direction, errors);
  const cohort = checkCohort(data['cohort'], direction, errors);
  const members = checkFanoutIdentitySet(data['members'], 'work.fanout_intent.members', direction, errors);
  const memberCount = checkCount(data, 'memberCount', 'work.fanout_intent', direction, errors);
  if (memberCount !== members.length) {
    fail(direction, `work.fanout_intent.memberCount ${memberCount} mismatches members length ${members.length}.`, errors);
  }
  const fanoutId = checkString(data, 'fanoutId', 'work.fanout_intent', direction, errors);
  const sourceOccurrence = checkString(data, 'sourceOccurrence', 'work.fanout_intent', direction, errors);
  const handler = checkString(data, 'handler', 'work.fanout_intent', direction, errors);
  if (fanoutId !== fanoutIntentRowId(sourceOccurrence, handler, cohort, direction, errors)) {
    fail(direction, 'work.fanout_intent.fanoutId is not the cutoff+cohort derivation.', errors);
  }
  if (row.id !== fanoutId) {
    fail(direction, 'work.fanout_intent row id must equal its fanoutId.', errors);
  }
  return { fanoutId, sourceOccurrence, handler, cohort, members, memberCount };
}

/** Read one fanout checkpoint row's data, failing closed on any shape drift. */
export function readFanoutCheckpointRow(row: StoredRow, direction: RowsDirection, errors: RowsErrorFactory = defaultRowsErrors): FanoutCheckpointRowData {
  const data = checkRecord(row.data, 'work.fanout_checkpoint data', direction, errors);
  const fanoutId = checkString(data, 'fanoutId', 'work.fanout_checkpoint', direction, errors);
  const completed = checkFanoutIdentitySet(data['completed'], 'work.fanout_checkpoint.completed', direction, errors);
  const cursor = checkNullableString(data, 'cursor', 'work.fanout_checkpoint', direction, errors);
  if (cursor !== null && cursor === '') {
    fail(direction, 'work.fanout_checkpoint.cursor must be non-empty or null.', errors);
  }
  if (row.id !== fanoutId) {
    fail(direction, 'work.fanout_checkpoint row id must equal its fanoutId.', errors);
  }
  return { fanoutId, completed, cursor };
}

/** Read one fanout child row's data, failing closed on any shape drift. */
export function readFanoutChildRow(row: StoredRow, direction: RowsDirection, errors: RowsErrorFactory = defaultRowsErrors): FanoutChildRowData {
  const data = checkRecord(row.data, 'work.fanout_child data', direction, errors);
  const state = checkString(data, 'state', 'work.fanout_child', direction, errors);
  if (!FANOUT_CHILD_STATES.has(state)) {
    fail(direction, `work.fanout_child.state is unknown: ${JSON.stringify(state)}.`, errors);
  }
  const causeKind = data['causeKind'];
  if (causeKind !== null && causeKind !== 'completed' && causeKind !== 'skipped' && causeKind !== 'failed') {
    fail(direction, `work.fanout_child.causeKind is unknown: ${JSON.stringify(causeKind)}.`, errors);
  }
  const typedState = state as FanoutChildState;
  const causeReason = checkNullableString(data, 'causeReason', 'work.fanout_child', direction, errors);
  checkChildCause(typedState, causeKind, causeReason, direction, errors);
  const fanoutId = checkString(data, 'fanoutId', 'work.fanout_child', direction, errors);
  const parentOccurrence = checkString(data, 'parentOccurrence', 'work.fanout_child', direction, errors);
  const handler = checkString(data, 'handler', 'work.fanout_child', direction, errors);
  const recordId = checkString(data, 'recordId', 'work.fanout_child', direction, errors);
  const childId = checkString(data, 'childId', 'work.fanout_child', direction, errors);
  if (childId !== fanoutChildRowId(parentOccurrence, handler, recordId, direction, errors)) {
    fail(direction, 'work.fanout_child.childId is not the parent+handler+record derivation.', errors);
  }
  if (row.id !== childId) {
    fail(direction, 'work.fanout_child row id must equal its childId.', errors);
  }
  return {
    fanoutId,
    parentOccurrence,
    handler,
    recordId,
    childId,
    state: typedState,
    attempts: checkCount(data, 'attempts', 'work.fanout_child', direction, errors),
    causeKind,
    causeReason,
  };
}

/**
 * State-direction replacement row for a conditional update: version + 1
 * with fresh updated metadata. Clone-only (no JSON-safety traversal);
 * meta scope is fixed to 'fanout'.
 */
export function withFanoutRowData(
  row: StoredRow,
  data: Readonly<Record<string, unknown>>,
  meta: FanoutRowMeta,

  errors: RowsErrorFactory = defaultRowsErrors): StoredRow {
  checkMeta(meta, 'fanout', 'state', errors);
  return {
    ...row,
    version: (row.version + 1) as RecordVersion,
    updated: meta.nowMs,
    updatedBy: meta.actor,
    data: structuredClone(data),
  };
}

/** Rebuild the contract child identity from a child row's flat fields. */
export function fanoutChildIdOf(row: FanoutChildRowData): FanoutChildId {
  return {
    parentOccurrence: row.parentOccurrence,
    handler: row.handler,
    recordId: row.recordId,
  };
}

/**
 * Bounded id-sorted child page query for one fanout. `cursor` is the
 * last-seen child row id (exclusive lower bound); `limit` is the page
 * transport bound (>= 1). Chunk size is not cohort size: the page
 * `limit` bounds one transport round-trip only.
 */
export function fanoutChildPageQuery(
  fanoutId: FanoutId,
  opts: { readonly cursor: string | null; readonly limit: number },
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): QuerySpec {
  checkIdComponent(fanoutId, 'fanoutId', direction, errors);
  if (opts.cursor !== null && opts.cursor === '') {
    if (direction === 'work') {
      fail(direction, 'fanout page cursor must be non-empty or null.', errors);
    }
    fail(direction, 'Fanout page cursor must be non-empty or null.', errors);
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1) {
    if (direction === 'work') {
      fail(direction, 'fanout page limit must be an integer >= 1.', errors);
    }
    fail(direction, 'Fanout page limit must be an integer >= 1.', errors);
  }
  return {
    model: WORK_FANOUT_CHILD_MODEL,
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
   * True only when the store returned fewer rows than the limit, i.e.
   * no further page can exist. False means the caller MUST resume
   * with `cursor` — never silent truncation, never a complete label.
   */
  readonly done: boolean;
  /** Resume cursor (last row id) when done:false; null when done:true. */
  readonly cursor: string | null;
}

/**
 * Fold one store page into the resume signal. Fails closed when the
 * store over-returns past the limit.
 */
export function fanoutChildPageResult(
  rows: ReadonlyArray<StoredRow>,
  limit: number,
  direction: RowsDirection,

  errors: RowsErrorFactory = defaultRowsErrors): FanoutChildPage {
  if (!Number.isInteger(limit) || limit < 1) {
    if (direction === 'work') {
      fail(direction, 'fanout page limit must be an integer >= 1.', errors);
    }
    fail(direction, 'Fanout page limit must be an integer >= 1.', errors);
  }
  if (rows.length > limit) {
    if (direction === 'work') {
      fail(direction, `fanout page returned ${rows.length} rows past limit ${limit}.`, errors);
    }
    fail(direction, `Fanout page returned ${rows.length} rows past limit ${limit}.`, errors);
  }
  if (rows.length < limit) {
    return { rows, done: true, cursor: null };
  }
  const last = rows[rows.length - 1];
  if (last === undefined) {
    if (direction === 'work') {
      fail(direction, 'fanout page is unreachable: full page has no last row.', errors);
    }
    fail(direction, 'Fanout page is unreachable: full page has no last row.', errors);
  }
  return { rows, done: false, cursor: last.id as string };
}
