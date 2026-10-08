/** Portable keyed-schedule stages; callers supply the existing system context. */
import type {
  DomainWrite,
  OccurrenceId,
  OperationName,
  OutboxId,
  ScheduleOp,
  RecordId,
  StoredRow,
  WorkScope,
} from '@canlang/contracts';
import type { SystemCommandContext, SystemCommandDef, SystemStaging } from '@canlang/state';
import { freezeRequest } from '../intent/staging.js';
import { argInstant, argRecord, argString, checkArgs } from './arguments.js';
import {
  compareIds,
  markOriginSuperseded,
  updateWrite,
} from './staging-support.js';
import type { StageContext } from './staging-support.js';
import {
  KernelTableError,
  WORK_SCHEDULE_MODEL,
  WORK_OCCURRENCE_MODEL,
  newScheduleRow,
  readScheduleRow,
  readOccurrenceRow,
  scheduleByKeyQuery,
} from './tables.js';
import type { OccurrenceRowData, ScheduleRowData } from './tables.js';

function argScope(
  args: Readonly<Record<string, unknown>>,
  what: string,
): WorkScope {
  const scope = argRecord(args, 'scope', what);
  return {
    app: argString(scope, 'app', `${what}.scope`),
    owner: argString(scope, 'owner', `${what}.scope`),
    ownerPackage: argString(scope, 'ownerPackage', `${what}.scope`),
  };
}

interface KeyedSchedule {
  row: StoredRow;
  data: ScheduleRowData;
}

/**
 * Every lineage entry under one key within one scope, exactly
 * re-filtered. Occurrence ids are opaque, so the head resolves
 * through `replaces` linkage (see `selectScheduleHead`) — never by
 * id comparison.
 */
async function loadKeyedSchedules(
  ctx: StageContext,
  scope: WorkScope,
  key: string,
): Promise<KeyedSchedule[]> {
  const rows = await ctx.query(scheduleByKeyQuery(scope, key));
  const found: KeyedSchedule[] = [];
  for (const row of rows) {
    const data = readScheduleRow(row);
    if (
      data.key !== key ||
      data.scopeApp !== scope.app ||
      data.scopeOwner !== scope.owner ||
      data.scopeOwnerPackage !== scope.ownerPackage
    ) {
      continue;
    }
    found.push({ row, data });
  }
  return found;
}

/**
 * Lineage head: the entry no other entry replaces. Concurrent puts
 * can race twin heads (both observed the same predecessor); the
 * deterministic id tiebreak picks one, and the next put/cancel
 * converges the twins, so no pending entry is ever stranded. The
 * no-head fallback is defensive only: `replaces` always points at a
 * row that predates the insert, so cycles cannot form.
 */
function selectScheduleHead(entries: readonly KeyedSchedule[]): KeyedSchedule | null {
  if (entries.length === 0) return null;
  const replaced = new Set<string>();
  for (const entry of entries) {
    if (entry.data.replaces !== null) replaced.add(entry.data.replaces);
  }
  const heads = entries.filter((entry) => !replaced.has(entry.data.occurrenceId));
  const candidates = heads.length > 0 ? heads : entries;
  let head: KeyedSchedule | null = null;
  for (const entry of candidates) {
    if (head === null || entry.data.occurrenceId > head.data.occurrenceId) {
      head = entry;
    }
  }
  return head;
}

/** Move `first` to the front, keeping the rest id-sorted. */
function headFirst(ids: OccurrenceId[], first: OccurrenceId): OccurrenceId[] {
  return [first, ...ids.filter((id) => id !== first).sort(compareIds)];
}

/** L3 staging bound (`STAGING_MAX_ID_LENGTH`); length is UTF-16 units. */
const SCHEDULE_KEY_MAX_LENGTH = 128;

/**
 * L3-visible schedule key for one scoped key, per the settled L3/L4
 * convention (L3 S9b addendum): slash-joined percent-encoded
 * `app/ownerPackage/owner/key`. L3 stores keys opaquely in a
 * key-global map, so producers embed the scope; lineage rows keep the
 * bare key plus flat scope fields and never decode. Total length over
 * 128 throws fail-closed (never truncate); L1 codegen must apply the
 * identical layout.
 */
function embedScheduleKey(scope: WorkScope, key: string, what: string): string {
  const embedded = [
    encodeURIComponent(scope.app),
    encodeURIComponent(scope.ownerPackage),
    encodeURIComponent(scope.owner),
    encodeURIComponent(key),
  ].join('/');
  if (embedded.length > SCHEDULE_KEY_MAX_LENGTH) {
    throw new KernelTableError(
      `${what}: embedded schedule key exceeds ${SCHEDULE_KEY_MAX_LENGTH} characters.`,
    );
  }
  return embedded;
}

export interface DueScheduleInput {
  readonly key: string;
  readonly scope: WorkScope;
  readonly occurrenceId: string;
  readonly event: string;
  readonly at: number;
}

export type DueScheduleResult =
  | { status: 'ready'; occurrence: ScheduleRowData; effects: SystemStaging }
  | { status: 'replayed'; receipt: OccurrenceRowData }
  | { status: 'refused'; reason: string };

/**
 * Stage first delivery of one authoritative due head inside the caller's
 * existing owner revision fence. The runtime qualifies input/context/schema;
 * this helper grants no authority and executes or commits nothing. The caller
 * combines ready effects, handler effects and the terminal occurrence receipt
 * in that same fence. Transient failures discard all effects; terminal authored
 * refusals retain admission/consumption and a failed receipt, without business
 * changes. Already-admitted work without a receipt has no first-delivery path.
 */
export async function stageDueSchedule(
  input: DueScheduleInput,
  ctx: SystemCommandContext,
): Promise<DueScheduleResult> {
  const what = 'stageDueSchedule';
  // Keep the existing argument checks and scoped-key encoding used by put/cancel.
  const args = input as unknown as Readonly<Record<string, unknown>>;
  checkArgs(args, what);
  const key = argString(args, 'key', what);
  const scope = argScope(args, what);
  const at = argInstant(args, 'at', what);
  const event = argString(args, 'event', what);
  const occurrenceId = argString(args, 'occurrenceId', what);
  const l3Key = embedScheduleKey(scope, key, what);
  const row = await ctx.load(WORK_SCHEDULE_MODEL, occurrenceId as RecordId);
  if (row === null) return { status: 'refused', reason: 'missing' };
  const data = readScheduleRow(row);
  if (
    row.id !== data.occurrenceId ||
    data.occurrenceId !== occurrenceId ||
    data.key !== key ||
    data.scopeApp !== scope.app ||
    data.scopeOwner !== scope.owner ||
    data.scopeOwnerPackage !== scope.ownerPackage ||
    data.event !== event ||
    data.at !== at
  ) {
    return { status: 'refused', reason: 'mismatched' };
  }
  // Retain the authoritative stored payload, never a delivery-supplied snapshot.
  const occurrence = Object.freeze({ ...data, payload: freezeRequest(data.payload) });
  const receiptRow = await ctx.load(WORK_OCCURRENCE_MODEL, occurrenceId as RecordId);
  if (receiptRow !== null) {
    const receipt = readOccurrenceRow(receiptRow);
    if (receiptRow.id !== occurrenceId || receipt.occurrenceId !== occurrenceId) {
      return { status: 'refused', reason: 'mismatched-receipt' };
    }
    // Original receipts replay even after a replacement became the current head.
    return { status: 'replayed', receipt };
  }
  if (occurrence.state !== 'pending') {
    return { status: 'refused', reason: occurrence.state };
  }
  if (occurrence.at > ctx.now) return { status: 'refused', reason: 'future' };
  const entries = await loadKeyedSchedules(ctx, scope, key);
  const head = selectScheduleHead(entries);
  if (
    head === null ||
    head.row.id !== occurrenceId ||
    head.data.occurrenceId !== occurrenceId ||
    head.row.version !== row.version ||
    head.data.state !== 'pending' ||
    head.data.event !== event ||
    head.data.at !== at
  ) {
    return { status: 'refused', reason: 'stale' };
  }
  return {
    status: 'ready',
    occurrence,
    effects: {
      writes: [
        updateWrite(row, { ...occurrence, state: 'admitted' }, ctx, WORK_SCHEDULE_MODEL, what),
      ],
      schedules: [{ op: 'cancel', key: l3Key }],
    },
  };
}

/**
 * `work.schedule.put {key, scope, at, event, payload, occurrenceId}`:
 * insert-or-replace one keyed occurrence. Mirrors `putSchedule`: a
 * pending predecessor is superseded with its undispatched intents;
 * anything else stays to complete while the key moves on. Every
 * still-pending entry is superseded, not just the head, so racing
 * twin heads converge here instead of stranding a twin. Stages the
 * lineage row AND the L3 `ScheduleOp` in one fenced batch.
 */
export const workSchedulePutCommand: SystemCommandDef = {
  name: 'work.schedule.put',
  stage: async (args, ctx) => {
    const what = 'work.schedule.put';
    checkArgs(args, what);
    const key = argString(args, 'key', what);
    const scope = argScope(args, what);
    const at = argInstant(args, 'at', what);
    const event = argString(args, 'event', what);
    const payloadInput = argRecord(args, 'payload', what);
    const occurrenceId = argString(args, 'occurrenceId', what);
    const l3Key = embedScheduleKey(scope, key, what);
    // Capture after validation and before querying so caller mutations during
    // staging cannot change the lineage row or the L3 schedule operation.
    const payload = freezeRequest(payloadInput);
    const entries = await loadKeyedSchedules(ctx, scope, key);
    const previous = selectScheduleHead(entries);
    const writes: DomainWrite[] = [];
    let affectedOutboxIds: OutboxId[] = [];
    let supersededIds: OccurrenceId[] = [];
    const pending = entries
      .filter((entry) => entry.data.state === 'pending')
      .sort((a, b) => compareIds(a.data.occurrenceId, b.data.occurrenceId));
    for (const entry of pending) {
      writes.push(
        updateWrite(
          entry.row,
          { ...entry.data, state: 'superseded' },
          ctx,
          WORK_SCHEDULE_MODEL,
          what,
        ),
      );
      const marked = await markOriginSuperseded(
        ctx,
        entry.data.occurrenceId,
        occurrenceId as OccurrenceId,
        what,
      );
      writes.push(...marked.writes);
      affectedOutboxIds = affectedOutboxIds.concat(marked.superseded);
      supersededIds.push(entry.data.occurrenceId);
    }
    affectedOutboxIds.sort(compareIds);
    const supersededId =
      previous !== null && previous.data.state === 'pending'
        ? previous.data.occurrenceId
        : null;
    if (supersededId !== null) {
      supersededIds = headFirst(supersededIds, supersededId);
    }
    writes.push({
      kind: 'insert',
      model: WORK_SCHEDULE_MODEL,
      row: newScheduleRow(
        {
          occurrenceId: occurrenceId as OccurrenceId,
          key,
          scopeApp: scope.app,
          scopeOwner: scope.owner,
          scopeOwnerPackage: scope.ownerPackage,
          at,
          event,
          payload,
          replaces: previous?.data.occurrenceId ?? null,
          state: 'pending',
        },
        { nowMs: ctx.now, actor: ctx.actor },
      ),
    });
    // The L3 op carries the scope-embedded key (settled convention);
    // the lineage row above keeps the bare key plus flat scope fields.
    const replace: ScheduleOp = {
      op: 'replace',
      key: l3Key,
      at,
      event: event as OperationName,
      payload,
    };
    return {
      writes,
      schedules: [replace],
      result: { admitted: occurrenceId, supersededId, supersededIds, affectedOutboxIds },
    };
  },
};

/**
 * `work.schedule.cancel {key, scope}`: cancel the keyed occurrence.
 * Mirrors `cancelSchedule`: pending/admitted entries cancel with their
 * undispatched intents superseded; missing/terminal keys no-op. Every
 * live entry cancels, not just the head, so racing twin heads
 * converge here instead of stranding a twin.
 */
export const workScheduleCancelCommand: SystemCommandDef = {
  name: 'work.schedule.cancel',
  stage: async (args, ctx) => {
    const what = 'work.schedule.cancel';
    checkArgs(args, what);
    const key = argString(args, 'key', what);
    const scope = argScope(args, what);
    const l3Key = embedScheduleKey(scope, key, what);
    const entries = await loadKeyedSchedules(ctx, scope, key);
    const previous = selectScheduleHead(entries);
    const live = entries
      .filter(
        (entry) =>
          entry.data.state === 'pending' || entry.data.state === 'admitted',
      )
      .sort((a, b) => compareIds(a.data.occurrenceId, b.data.occurrenceId));
    if (live.length === 0) {
      return {
        result: {
          cancelled: previous?.data.occurrenceId ?? null,
          cancelledIds: [],
          affectedOutboxIds: [],
        },
      };
    }
    const writes: DomainWrite[] = [];
    let affectedOutboxIds: OutboxId[] = [];
    let cancelledIds: OccurrenceId[] = [];
    for (const entry of live) {
      writes.push(
        updateWrite(
          entry.row,
          { ...entry.data, state: 'cancelled' },
          ctx,
          WORK_SCHEDULE_MODEL,
          what,
        ),
      );
      const marked = await markOriginSuperseded(
        ctx,
        entry.data.occurrenceId,
        null,
        what,
      );
      writes.push(...marked.writes);
      affectedOutboxIds = affectedOutboxIds.concat(marked.superseded);
      cancelledIds.push(entry.data.occurrenceId);
    }
    affectedOutboxIds.sort(compareIds);
    const cancelled =
      previous !== null &&
      (previous.data.state === 'pending' || previous.data.state === 'admitted')
        ? previous.data.occurrenceId
        : null;
    if (cancelled !== null) {
      cancelledIds = headFirst(cancelledIds, cancelled);
    }
    const cancel: ScheduleOp = { op: 'cancel', key: l3Key };
    return {
      writes,
      schedules: [cancel],
      result: { cancelled, cancelledIds, affectedOutboxIds },
    };
  },
};
