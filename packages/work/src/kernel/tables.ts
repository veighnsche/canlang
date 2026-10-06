/**
 * Lane-04-owned kernel tables (S9b): occurrence/dispatch lifecycle rows
 * written through registered system commands.
 *
 * L3's commit-record tables carry no occurrence/claim lineage (verified
 * against S6: `OutboxIntent` has no origin or claim columns; stage
 * contexts expose domain `load`/`query` only), so the dispatcher owns
 * five narrow tables as `StoredRow` data payloads:
 *
 * - `work.dispatch` (id = intent id): claim lifecycle per staged intent,
 *   mirroring `OutboxItem` + `DispatchClaim` + retry availability.
 * - `work.occurrence` (id = occurrence id): execution receipts, mirroring
 *   `OccurrenceReceipt` put-if-absent.
 * - `work.schedule` (id = occurrence id): keyed schedule lineage, mirroring
 *   `ScheduledOccurrence` with the scope flattened for querying.
 * - `work.every_slot` (id = app/handler/scope/owner tuple): last
 *   admitted `every` slot per fanout scope, backing `admitEveryTick`
 *   coalescing durably. `admitEveryTick` scopes its `previousSlots`
 *   map per (app, handler) call, so the durable id qualifies the
 *   scope key with both; the `scopeKey` field keeps the map key.
 * - `work.supersession` (id = outbox id): superseded delivery intents,
 *   mirroring `SupersessionPort`.
 *
 * Query notes (verified against the memory adapter): data fields address
 * flat by bare name (`FIELD_NAME`, camelCase allowed); nested paths are
 * NOT addressable, hence the flattened scope/claim/error fields. The
 * store ignores `QuerySpec.authority`; commands pass `'owner'` for the
 * privileged path. Stages always re-filter query results exactly.
 *
 * Producers must insert the `work.dispatch` row in the same fenced batch
 * that stages each `OutboxIntent` (see the S9b L3 handoff): linkage is
 * not derivable lane-04-side. Until that write lands, dispatch rows do
 * not exist and claims refuse `not_found` — never invented.
 */
import type {
  ModelName,
  QuerySpec,
  RecordId,
  RecordVersion,
  StoredRow,
} from '../../../contracts/src/state.js';
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
} from '../../../contracts/src/work.js';

/** Fail-closed table errors; stages throw these as plain Errors. */
export class KernelTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KernelTableError';
  }
}

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
   * `classifyFailure`. Only `failed` rows carry one; `requeue` retries
   * transient failures and refuses terminal (or unclassified) ones, so
   * a sweeper can never resurrect a terminal business failure.
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
   * are opaque (`OccurrenceIdPort` promises no ordering), so the head
   * resolves through this backward link — never by id comparison.
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

function checkRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KernelTableError(`${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function checkString(
  record: Record<string, unknown>,
  field: string,
  what: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value === '') {
    throw new KernelTableError(`${what}.${field} must be a non-empty string.`);
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
    throw new KernelTableError(`${what}.${field} must be a string or null.`);
  }
  return value;
}

function checkCount(
  record: Record<string, unknown>,
  field: string,
  what: string,
): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new KernelTableError(`${what}.${field} must be an integer >= 0.`);
  }
  return value;
}

function checkInstant(
  record: Record<string, unknown>,
  field: string,
  what: string,
): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new KernelTableError(`${what}.${field} must be finite epoch ms >= 0.`);
  }
  return value;
}

function checkNullableInstant(
  record: Record<string, unknown>,
  field: string,
  what: string,
): number | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new KernelTableError(`${what}.${field} must be finite epoch ms or null.`);
  }
  return value;
}

/** Deep JSON-safety: row data must survive the store JSON round-trip. */
function checkJsonSafe(value: unknown, what: string): void {
  const seen = new Set<object>();
  const visit = (node: unknown, path: string): void => {
    if (node === null) return;
    switch (typeof node) {
      case 'string':
      case 'boolean':
        return;
      case 'number':
        if (!Number.isFinite(node)) {
          throw new KernelTableError(`${what}${path} must be finite JSON.`);
        }
        return;
      case 'undefined':
      case 'function':
      case 'symbol':
      case 'bigint':
        throw new KernelTableError(`${what}${path} is not JSON-safe.`);
      case 'object': {
        if (seen.has(node)) {
          throw new KernelTableError(`${what}${path} is cyclic.`);
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

/** Read one dispatch row's data, failing closed on any shape drift. */
export function readDispatchRow(row: StoredRow): DispatchRowData {
  const data = checkRecord(row.data, 'work.dispatch data');
  const state = checkString(data, 'state', 'work.dispatch');
  if (!OUTBOX_STATES.has(state)) {
    throw new KernelTableError(`work.dispatch.state is unknown: ${JSON.stringify(state)}.`);
  }
  const guardVerdict = data['guardVerdict'];
  if (guardVerdict !== null && typeof guardVerdict !== 'boolean') {
    throw new KernelTableError('work.dispatch.guardVerdict must be boolean or null.');
  }
  const retryClass = data['retryClass'];
  if (retryClass !== null && retryClass !== 'transient' && retryClass !== 'terminal') {
    throw new KernelTableError(
      'work.dispatch.retryClass must be transient, terminal or null.',
    );
  }
  return {
    intentId: checkString(data, 'intentId', 'work.dispatch'),
    operationId: checkString(data, 'operationId', 'work.dispatch'),
    source: checkString(data, 'source', 'work.dispatch'),
    occurrenceIndex: checkCount(data, 'occurrenceIndex', 'work.dispatch'),
    originOccurrence: checkNullableString(data, 'originOccurrence', 'work.dispatch'),
    state: state as OutboxItemState,
    attempts: checkCount(data, 'attempts', 'work.dispatch'),
    claimId: checkNullableString(data, 'claimId', 'work.dispatch'),
    claimedAtMs: checkNullableInstant(data, 'claimedAtMs', 'work.dispatch'),
    guardVerdict,
    deliveryId: checkNullableString(data, 'deliveryId', 'work.dispatch'),
    errorCode: checkNullableString(data, 'errorCode', 'work.dispatch'),
    errorMessage: checkNullableString(data, 'errorMessage', 'work.dispatch'),
    availableAtMs: checkNullableInstant(data, 'availableAtMs', 'work.dispatch'),
    firstAttemptAtMs: checkNullableInstant(data, 'firstAttemptAtMs', 'work.dispatch'),
    retryClass: retryClass as RetryClass | null,
  };
}

/** Read one occurrence row's data, failing closed on any shape drift. */
export function readOccurrenceRow(row: StoredRow): OccurrenceRowData {
  const data = checkRecord(row.data, 'work.occurrence data');
  const status = data['status'];
  if (status !== 'completed' && status !== 'failed') {
    throw new KernelTableError(
      `work.occurrence.status must be completed or failed, got ${JSON.stringify(status)}.`,
    );
  }
  return {
    occurrenceId: checkString(data, 'occurrenceId', 'work.occurrence'),
    status,
    result: data['result'] ?? null,
    code: checkNullableString(data, 'code', 'work.occurrence'),
    message: checkNullableString(data, 'message', 'work.occurrence'),
    recordedAtMs: checkInstant(data, 'recordedAtMs', 'work.occurrence'),
  };
}

/** Read one schedule row's data, failing closed on any shape drift. */
export function readScheduleRow(row: StoredRow): ScheduleRowData {
  const data = checkRecord(row.data, 'work.schedule data');
  const state = checkString(data, 'state', 'work.schedule');
  if (!SCHEDULE_STATES.has(state)) {
    throw new KernelTableError(`work.schedule.state is unknown: ${JSON.stringify(state)}.`);
  }
  return {
    occurrenceId: checkString(data, 'occurrenceId', 'work.schedule'),
    key: checkString(data, 'key', 'work.schedule'),
    scopeApp: checkString(data, 'scopeApp', 'work.schedule'),
    scopeOwner: checkString(data, 'scopeOwner', 'work.schedule'),
    scopeOwnerPackage: checkString(data, 'scopeOwnerPackage', 'work.schedule'),
    at: checkInstant(data, 'at', 'work.schedule'),
    event: checkString(data, 'event', 'work.schedule'),
    payload: checkRecord(data['payload'], 'work.schedule.payload'),
    replaces: checkNullableString(data, 'replaces', 'work.schedule') as OccurrenceId | null,
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
export function readEverySlotRow(row: StoredRow): EverySlotRowData {
  const data = checkRecord(row.data, 'work.every_slot data');
  const scope = data['scope'];
  if (scope !== 'team' && scope !== 'app') {
    throw new KernelTableError(
      `work.every_slot.scope must be team or app, got ${JSON.stringify(scope)}.`,
    );
  }
  return {
    scopeKey: checkString(data, 'scopeKey', 'work.every_slot'),
    app: checkString(data, 'app', 'work.every_slot'),
    handler: checkString(data, 'handler', 'work.every_slot'),
    scope,
    owner: checkString(data, 'owner', 'work.every_slot'),
    slot: checkCount(data, 'slot', 'work.every_slot'),
  };
}

/** Read one supersession row's data, failing closed on any shape drift. */
export function readSupersessionRow(row: StoredRow): SupersessionRowData {
  const data = checkRecord(row.data, 'work.supersession data');
  return {
    outboxId: checkString(data, 'outboxId', 'work.supersession'),
    byOccurrenceId: checkNullableString(data, 'byOccurrenceId', 'work.supersession'),
    markedAtMs: checkInstant(data, 'markedAtMs', 'work.supersession'),
  };
}

export interface NewRowMeta {
  /** UTC epoch ms for created/updated. */
  readonly nowMs: number;
  /** Actor identity for createdBy/updatedBy. */
  readonly actor: string;
}

function newRow(
  id: string,
  data: Readonly<Record<string, unknown>>,
  meta: NewRowMeta,
  what: string,
): StoredRow {
  if (!Number.isFinite(meta.nowMs) || meta.nowMs < 0) {
    throw new KernelTableError(`${what}: nowMs must be finite epoch ms >= 0.`);
  }
  if (typeof meta.actor !== 'string' || meta.actor === '') {
    throw new KernelTableError(`${what}: actor must be a non-empty string.`);
  }
  checkJsonSafe(data, `${what} data`);
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

/**
 * Replacement row for a conditional update: version + 1 with fresh
 * updated metadata. Callers stage it with `expectedVersion: row.version`.
 */
export function withRowData(
  row: StoredRow,
  data: Readonly<Record<string, unknown>>,
  meta: NewRowMeta,
  what: string,
): StoredRow {
  if (!Number.isFinite(meta.nowMs) || meta.nowMs < 0) {
    throw new KernelTableError(`${what}: nowMs must be finite epoch ms >= 0.`);
  }
  if (typeof meta.actor !== 'string' || meta.actor === '') {
    throw new KernelTableError(`${what}: actor must be a non-empty string.`);
  }
  checkJsonSafe(data, `${what} data`);
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
): StoredRow {
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
  return newRow(input.intentId, data as unknown as Record<string, unknown>, meta, 'work.dispatch');
}

/** Put-if-absent occurrence receipt row. */
export function newOccurrenceRow(
  input: OccurrenceRowData,
  meta: NewRowMeta,
): StoredRow {
  return newRow(
    input.occurrenceId,
    input as unknown as Record<string, unknown>,
    meta,
    'work.occurrence',
  );
}

/** Keyed schedule lineage row (id = occurrence id; key is looked up). */
export function newScheduleRow(
  input: ScheduleRowData,
  meta: NewRowMeta,
): StoredRow {
  return newRow(
    input.occurrenceId,
    input as unknown as Record<string, unknown>,
    meta,
    'work.schedule',
  );
}

/**
 * Durable every-slot tracker id. Qualified by app and handler because
 * `admitEveryTick` coalesces per (app, handler, scope, owner): two
 * handlers sharing a team owner must never share one tracker row.
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
): StoredRow {
  return newRow(
    everySlotRowId(input.app, input.handler, input.scope, input.owner),
    input as unknown as Record<string, unknown>,
    meta,
    'work.every_slot',
  );
}

/** Supersession mark row (id = outbox id). */
export function newSupersessionRow(
  input: SupersessionRowData,
  meta: NewRowMeta,
): StoredRow {
  return newRow(
    input.outboxId,
    input as unknown as Record<string, unknown>,
    meta,
    'work.supersession',
  );
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
 * Schedule rows under one key within one scope. Key-global L3 rows may
 * collide across scopes (open handoff); the flat scope fields disjoin
 * here and stages re-filter exactly.
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

/* -- T34-F2 durable fanout tables (L4 work-kernel slice). -- */

/**
 * Adopted T33-A durable per-child fanout rows, stored as `StoredRow`
 * data payloads on three narrow lane-04-owned tables:
 *
 * - `work.fanout_intent` (id = deterministic cutoff+cohort id): the
 *   committed fanout intent — cutoff marker plus cohort kind plus the
 *   frozen admitted member set. The store primary key enforces
 *   insert-once per cutoff+cohort: a second intent for the same
 *   source-occurrence/handler/cohort is a PK conflict, never a
 *   redefinition of the frozen set.
 * - `work.fanout_checkpoint` (id = fanout id): the durable checkpoint
 *   — completed-child set plus enumeration cursor. Inserted once, then
 *   advanced by conditional update in the same owner transaction as
 *   each child's effects (F5 join owns that atomicity; this file only
 *   shapes the row).
 * - `work.fanout_child` (id = full FanoutChildId encoding): one row
 *   per admitted child, keyed by parent occurrence + handler +
 *   record. The handler component keeps Commitment/Swap (or any two
 *   handlers on one source event) from colliding.
 *
 * Query notes: all join/claim fields are flat (bare `FIELD_NAME`s);
 * only row ids and flat data fields are addressed, never nested
 * paths. Child enumeration is bounded id-sorted paging
 * (`fanoutChildPageQuery` + `fanoutChildPageResult`).
 *
 * Deliberately absent: no quota/capacity field (the adopted contract
 * forbids a fabricated numeric deployment quota), no authoring
 * syntax, no skipping/suppression rule, no dispatch claim, recovery
 * scan, membership, or compiler logic (F3–F6 own those).
 */

/** Lane-04-owned fanout table models (branded casts, mirroring L3 usage). */
export const WORK_FANOUT_INTENT_MODEL = 'work.fanout_intent' as ModelName;
export const WORK_FANOUT_CHECKPOINT_MODEL = 'work.fanout_checkpoint' as ModelName;
export const WORK_FANOUT_CHILD_MODEL = 'work.fanout_child' as ModelName;

/**
 * Committed fanout intent row: cutoff + cohort + frozen members.
 * `fanoutId` is the deterministic cutoff+cohort row id (see
 * `fanoutIntentRowId`): opaque to callers, minted by the runtime as
 * this derivation so the store enforces insert-once.
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

function checkIdComponent(value: string, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new KernelTableError(`${what} must be a non-empty string.`);
  }
  return value;
}

function checkCohort(value: unknown): FanoutCohortKind {
  if (value !== 'model' && value !== 'anchored-collection') {
    throw new KernelTableError(
      `fanout cohort must be model or anchored-collection, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function checkIdentitySet(
  value: unknown,
  what: string,
): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throw new KernelTableError(`${what} must be an array of canonical record ids.`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') {
      throw new KernelTableError(`${what} entries must be non-empty strings.`);
    }
    if (seen.has(entry)) {
      throw new KernelTableError(`${what} contains a duplicate identity: ${JSON.stringify(entry)}.`);
    }
    seen.add(entry);
  }
  return [...seen].sort();
}

/**
 * Deterministic fanout intent row id under FanoutCutoff + cohort.
 * Components are encoded so `/` separators stay unambiguous (the
 * `everySlotRowId` precedent). A second insert for the same
 * source-occurrence/handler/cohort collides on the store primary key,
 * which is exactly the insert-once rule: the frozen member set can
 * never be redefined for an admitted cutoff.
 */
export function fanoutIntentRowId(
  sourceOccurrence: OccurrenceId,
  handler: string,
  cohort: FanoutCohortKind,
): FanoutId {
  checkIdComponent(sourceOccurrence, 'fanout sourceOccurrence');
  checkIdComponent(handler, 'fanout handler');
  checkCohort(cohort);
  return `fanout/v1/${encodeURIComponent(sourceOccurrence)}/${encodeURIComponent(handler)}/${cohort}`;
}

/** Checkpoint row id: exactly one checkpoint row per fanout id. */
export function fanoutCheckpointRowId(fanoutId: FanoutId): string {
  return checkIdComponent(fanoutId, 'fanout fanoutId');
}

/**
 * Per-child row id: the full FanoutChildId (parent occurrence +
 * handler + record), encoded so `/` separators stay unambiguous.
 * Same parent+record under different handlers yields different ids;
 * the same triple always yields the same id, so retries reuse the
 * row and duplicate deliveries replay instead of minting.
 */
export function fanoutChildRowId(
  parentOccurrence: OccurrenceId,
  handler: string,
  recordId: string,
): string {
  checkIdComponent(parentOccurrence, 'fanout parentOccurrence');
  checkIdComponent(handler, 'fanout handler');
  checkIdComponent(recordId, 'fanout recordId');
  return `fanout-child/v1/${encodeURIComponent(parentOccurrence)}/${encodeURIComponent(handler)}/${encodeURIComponent(recordId)}`;
}

/** Producer-side insert: the committed fanout intent row. */
export function newFanoutIntentRow(
  input: {
    readonly sourceOccurrence: OccurrenceId;
    readonly handler: string;
    readonly cohort: FanoutCohortKind;
    readonly members: ReadonlyArray<string>;
  },
  meta: NewRowMeta,
): StoredRow {
  const members = checkIdentitySet(input.members, 'work.fanout_intent.members');
  const fanoutId = fanoutIntentRowId(input.sourceOccurrence, input.handler, input.cohort);
  const data: FanoutIntentRowData = {
    fanoutId,
    sourceOccurrence: input.sourceOccurrence,
    handler: input.handler,
    cohort: input.cohort,
    members,
    memberCount: members.length,
  };
  return newRow(fanoutId, data as unknown as Record<string, unknown>, meta, 'work.fanout_intent');
}

/** Producer-side insert: the initial checkpoint row (empty set, null cursor). */
export function newFanoutCheckpointRow(
  input: {
    readonly fanoutId: FanoutId;
    readonly completed?: ReadonlyArray<string>;
    readonly cursor?: string | null;
  },
  meta: NewRowMeta,
): StoredRow {
  const data: FanoutCheckpointRowData = {
    fanoutId: checkIdComponent(input.fanoutId, 'fanout fanoutId'),
    completed: checkIdentitySet(input.completed ?? [], 'work.fanout_checkpoint.completed'),
    cursor: input.cursor ?? null,
  };
  if (data.cursor !== null && data.cursor === '') {
    throw new KernelTableError('work.fanout_checkpoint.cursor must be non-empty or null.');
  }
  return newRow(
    fanoutCheckpointRowId(data.fanoutId),
    data as unknown as Record<string, unknown>,
    meta,
    'work.fanout_checkpoint',
  );
}

/**
 * Pure checkpoint advance for the conditional-update upsert: unions
 * newly completed record ids into the completed set (deduped, sorted
 * canonical order) and carries the next cursor. Re-adding an
 * already-completed identity is an idempotent no-op, never a
 * duplicate error: crash recovery replays at most the
 * un-checkpointed child and must be able to re-advance over an
 * overlapping set. Callers stage the result with `withRowData`
 * under `expectedVersion: row.version`, so concurrent advances
 * serialize on the store fence instead of silently merging.
 */
export function nextFanoutCheckpointData(
  current: FanoutCheckpointRowData,
  addCompleted: ReadonlyArray<string>,
  cursor: string | null,
): FanoutCheckpointRowData {
  if (cursor !== null && cursor === '') {
    throw new KernelTableError('work.fanout_checkpoint.cursor must be non-empty or null.');
  }
  for (const entry of addCompleted) {
    if (typeof entry !== 'string' || entry === '') {
      throw new KernelTableError(
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
  state: FanoutChildState,
  causeKind: 'completed' | 'skipped' | 'failed' | null,
  causeReason: string | null,
): void {
  if (state === 'pending' || state === 'running') {
    if (causeKind !== null || causeReason !== null) {
      throw new KernelTableError(
        `work.fanout_child cause must be null until terminal, got ${JSON.stringify(causeKind)}.`,
      );
    }
    return;
  }
  if (state === 'completed') {
    if (causeKind !== 'completed' || causeReason !== null) {
      throw new KernelTableError(
        'work.fanout_child completed cause must be kind completed with no reason.',
      );
    }
    return;
  }
  if (state === 'skipped') {
    if (causeKind !== 'skipped' || !FANOUT_SKIPPED_REASONS.has(causeReason ?? '')) {
      throw new KernelTableError(
        `work.fanout_child skipped cause needs a closed reason, got ${JSON.stringify(causeReason)}.`,
      );
    }
    return;
  }
  if (causeKind !== 'failed' || !FANOUT_FAILED_REASONS.has(causeReason ?? '')) {
    throw new KernelTableError(
      `work.fanout_child failed cause needs a closed reason, got ${JSON.stringify(causeReason)}.`,
    );
  }
}

/** Producer-side insert: one admitted child row (default pending, zero attempts). */
export function newFanoutChildRow(
  input: {
    readonly fanoutId: FanoutId;
    readonly parentOccurrence: OccurrenceId;
    readonly handler: string;
    readonly recordId: string;
    readonly state?: FanoutChildState;
    readonly attempts?: number;
    readonly causeKind?: 'completed' | 'skipped' | 'failed' | null;
    readonly causeReason?: FanoutSkippedReason | FanoutFailedReason | null;
  },
  meta: NewRowMeta,
): StoredRow {
  const state = input.state ?? 'pending';
  if (!FANOUT_CHILD_STATES.has(state)) {
    throw new KernelTableError(`work.fanout_child.state is unknown: ${JSON.stringify(state)}.`);
  }
  const attempts = input.attempts ?? 0;
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new KernelTableError('work.fanout_child.attempts must be an integer >= 0.');
  }
  const causeKind = input.causeKind ?? null;
  const causeReason = (input.causeReason ?? null) as string | null;
  checkChildCause(state, causeKind, causeReason);
  const childId = fanoutChildRowId(input.parentOccurrence, input.handler, input.recordId);
  const data: FanoutChildRowData = {
    fanoutId: checkIdComponent(input.fanoutId, 'fanout fanoutId'),
    parentOccurrence: input.parentOccurrence,
    handler: input.handler,
    recordId: input.recordId,
    childId,
    state,
    attempts,
    causeKind,
    causeReason,
  };
  return newRow(childId, data as unknown as Record<string, unknown>, meta, 'work.fanout_child');
}

/** Read one fanout intent row's data, failing closed on any shape drift. */
export function readFanoutIntentRow(row: StoredRow): FanoutIntentRowData {
  const data = checkRecord(row.data, 'work.fanout_intent data');
  const cohort = checkCohort(data['cohort']);
  const members = checkIdentitySet(data['members'], 'work.fanout_intent.members');
  const memberCount = checkCount(data, 'memberCount', 'work.fanout_intent');
  if (memberCount !== members.length) {
    throw new KernelTableError(
      `work.fanout_intent.memberCount ${memberCount} mismatches members length ${members.length}.`,
    );
  }
  const fanoutId = checkString(data, 'fanoutId', 'work.fanout_intent');
  const sourceOccurrence = checkString(data, 'sourceOccurrence', 'work.fanout_intent');
  const handler = checkString(data, 'handler', 'work.fanout_intent');
  if (fanoutId !== fanoutIntentRowId(sourceOccurrence, handler, cohort)) {
    throw new KernelTableError('work.fanout_intent.fanoutId is not the cutoff+cohort derivation.');
  }
  if (row.id !== fanoutId) {
    throw new KernelTableError('work.fanout_intent row id must equal its fanoutId.');
  }
  return { fanoutId, sourceOccurrence, handler, cohort, members, memberCount };
}

/** Read one fanout checkpoint row's data, failing closed on any shape drift. */
export function readFanoutCheckpointRow(row: StoredRow): FanoutCheckpointRowData {
  const data = checkRecord(row.data, 'work.fanout_checkpoint data');
  const fanoutId = checkString(data, 'fanoutId', 'work.fanout_checkpoint');
  const completed = checkIdentitySet(data['completed'], 'work.fanout_checkpoint.completed');
  const cursor = checkNullableString(data, 'cursor', 'work.fanout_checkpoint');
  if (cursor !== null && cursor === '') {
    throw new KernelTableError('work.fanout_checkpoint.cursor must be non-empty or null.');
  }
  if (row.id !== fanoutId) {
    throw new KernelTableError('work.fanout_checkpoint row id must equal its fanoutId.');
  }
  return { fanoutId, completed, cursor };
}

/** Read one fanout child row's data, failing closed on any shape drift. */
export function readFanoutChildRow(row: StoredRow): FanoutChildRowData {
  const data = checkRecord(row.data, 'work.fanout_child data');
  const state = checkString(data, 'state', 'work.fanout_child');
  if (!FANOUT_CHILD_STATES.has(state)) {
    throw new KernelTableError(`work.fanout_child.state is unknown: ${JSON.stringify(state)}.`);
  }
  const causeKind = data['causeKind'];
  if (causeKind !== null && causeKind !== 'completed' && causeKind !== 'skipped' && causeKind !== 'failed') {
    throw new KernelTableError(
      `work.fanout_child.causeKind is unknown: ${JSON.stringify(causeKind)}.`,
    );
  }
  const typedState = state as FanoutChildState;
  const causeReason = checkNullableString(data, 'causeReason', 'work.fanout_child');
  checkChildCause(typedState, causeKind, causeReason);
  const fanoutId = checkString(data, 'fanoutId', 'work.fanout_child');
  const parentOccurrence = checkString(data, 'parentOccurrence', 'work.fanout_child');
  const handler = checkString(data, 'handler', 'work.fanout_child');
  const recordId = checkString(data, 'recordId', 'work.fanout_child');
  const childId = checkString(data, 'childId', 'work.fanout_child');
  if (childId !== fanoutChildRowId(parentOccurrence, handler, recordId)) {
    throw new KernelTableError('work.fanout_child.childId is not the parent+handler+record derivation.');
  }
  if (row.id !== childId) {
    throw new KernelTableError('work.fanout_child row id must equal its childId.');
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
 * transport bound (>= 1, the `schedulesDue` precedent: a page must
 * return at least one row to make sense).
 *
 * §C9 — chunk size is not cohort size. The page `limit` bounds one
 * transport round-trip only; the admitted cohort is the frozen intent
 * member set, and varying the chunk size never changes which
 * identities are visited. There is intentionally no cohort-size or
 * capacity field anywhere in these rows: resource admission stays an
 * explicit pre-admission decision (F7), never a silent truncation.
 */
export function fanoutChildPageQuery(
  fanoutId: FanoutId,
  opts: { readonly cursor: string | null; readonly limit: number },
): QuerySpec {
  checkIdComponent(fanoutId, 'fanout fanoutId');
  if (opts.cursor !== null && opts.cursor === '') {
    throw new KernelTableError('fanout page cursor must be non-empty or null.');
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1) {
    throw new KernelTableError('fanout page limit must be an integer >= 1.');
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
   * (An exact-multiple cohort ends with one full page at done:false
   * followed by an empty page at done:true; the empty page is the
   * honest completion signal, not a wasted round-trip to optimize
   * away by guessing.)
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
): FanoutChildPage {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new KernelTableError('fanout page limit must be an integer >= 1.');
  }
  if (rows.length > limit) {
    throw new KernelTableError(
      `fanout page returned ${rows.length} rows past limit ${limit}.`,
    );
  }
  if (rows.length < limit) {
    return { rows, done: true, cursor: null };
  }
  const last = rows[rows.length - 1];
  if (last === undefined) {
    throw new KernelTableError('fanout page is unreachable: full page has no last row.');
  }
  return { rows, done: false, cursor: last.id as string };
}
