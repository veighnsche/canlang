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
 * - `work.every_slot` (id = scope key): last admitted `every` slot per
 *   fanout scope, backing `admitEveryTick` coalescing durably.
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
  OccurrenceId,
  OutboxId,
  OutboxItemState,
  RecurringScope,
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
    data: { ...data },
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
    data: { ...data },
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

/** Every-slot tracker row (id = scope key). */
export function newEverySlotRow(
  input: EverySlotRowData,
  meta: NewRowMeta,
): StoredRow {
  return newRow(
    input.scopeKey,
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
