/**
 * Keyed dynamic schedules: put/replace/cancel with supersession.
 *
 * A schedule key is unique within app/owner/package and independent of the
 * calling operation, so booking, rescheduling and cancellation address the
 * same key (DESIGN section 6). Replacement and cancellation commit with
 * business changes; handler guards run again when due.
 *
 * Supersession rules implemented here:
 *
 * - Replacing a *pending* occurrence supersedes it and returns its id.
 * - Already admitted work and provider-accepted messages may complete: only
 *   `pending` outbox items are undispatched delivery intents. Claimed,
 *   uncertain, delivered, failed and dead items are never touched.
 * - A superseded/cancelled occurrence supersedes its undispatched delivery
 *   intents: their ids are marked in the supersession registry (which dispatch
 *   checks first) and returned to the caller.
 *
 * Identity note: every stored record carries a runtime-minted `occurrenceId`
 * (a replacement mints a new one; the superseded record keeps its own).
 * Delivery intents join to their occurrence by exact `originOccurrence`
 * match — never by event path, so same-event keys stay isolated and
 * capability-sourced sends join correctly.
 */
import type {
  OccurrenceId,
  OutboxId,
  OutboxItem,
  ScheduledOccurrence,
  WorkScope,
} from '../../../contracts/src/work.js';
import type {
  OccurrenceIdPort,
  OutboxStorePort,
  ScheduleStorePort,
  SupersessionPort,
} from '../ports.ts';
import { freezeRequest } from '../intent/index.ts';

export interface ScheduleDeps {
  schedules: ScheduleStorePort;
  outbox: OutboxStorePort;
  supersessions: SupersessionPort;
  ids: OccurrenceIdPort;
}

/** Caller-supplied fields for a new pending entry; the id is minted at put. */
export type NewScheduledOccurrence = Omit<ScheduledOccurrence, 'occurrenceId'>;

export interface PutScheduleResult {
  /** The newly stored pending entry, with its minted occurrence id. */
  admitted: ScheduledOccurrence;
  /** Previous pending entry now marked superseded, if any. */
  superseded: ScheduledOccurrence | null;
  /** Occurrence id of the superseded record, if any. */
  supersededId: OccurrenceId | null;
  /** Undispatched delivery intents now superseded, in stable id order. */
  affectedOutboxIds: OutboxId[];
}

export interface CancelScheduleResult {
  /** Entry now marked cancelled; null when the key never existed. */
  cancelled: ScheduledOccurrence | null;
  /** Undispatched delivery intents now superseded, in stable id order. */
  affectedOutboxIds: OutboxId[];
}

function assertPendingEntry(entry: NewScheduledOccurrence): void {
  if (typeof entry.key !== 'string' || entry.key.length === 0) {
    throw new RangeError('schedule: entry.key must be a non-empty string');
  }
  if (typeof entry.event !== 'string' || entry.event.length === 0) {
    throw new RangeError('schedule: entry.event must be a non-empty string');
  }
  if (!Number.isFinite(entry.at) || entry.at < 0) {
    throw new RangeError('schedule: entry.at must be finite UTC epoch ms >= 0');
  }
  if (entry.state !== 'pending') {
    throw new RangeError('schedule: only pending entries can be put; got ' + entry.state);
  }
}

/**
 * Undispatched delivery intents for one occurrence: outbox items stamped
 * with its occurrence id that are still `pending`. Anything claimed,
 * uncertain or settled is provider-accepted or finished work and is never
 * touched. Intents of other occurrences — even under the same event path —
 * never match.
 */
export function collectUndispatchedIntents(
  outbox: OutboxStorePort,
  occurrenceId: OccurrenceId,
): OutboxItem[] {
  return outbox
    .listByOriginOccurrence(occurrenceId)
    .filter((item) => item.state === 'pending')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function supersedeIntents(deps: ScheduleDeps, occurrenceId: OccurrenceId): OutboxId[] {
  const undispatched = collectUndispatchedIntents(deps.outbox, occurrenceId);
  const ids = undispatched.map((item) => item.id);
  deps.supersessions.markSuperseded(ids);
  return ids;
}

function upsertKeyedSchedule(
  deps: ScheduleDeps,
  entry: NewScheduledOccurrence,
): PutScheduleResult {
  assertPendingEntry(entry);
  // Freeze first through the same record-only gate as staged outbox
  // requests (lane-3 `ScheduleOp.replace.payload` is record-typed):
  // every throw precedes any store mutation, so a rejected
  // replacement leaves the previous entry — and its undispatched
  // intents — untouched.
  const payload = freezeRequest(entry.payload);
  const previous = deps.schedules.get(entry.scope, entry.key);
  let superseded: ScheduledOccurrence | null = null;
  let supersededId: OccurrenceId | null = null;
  let affectedOutboxIds: OutboxId[] = [];
  if (previous !== null && previous.state === 'pending') {
    superseded = { ...previous, state: 'superseded' };
    deps.schedules.put(superseded);
    supersededId = previous.occurrenceId;
    affectedOutboxIds = supersedeIntents(deps, previous.occurrenceId);
  }
  // A non-pending predecessor (admitted work in flight, or a terminal entry)
  // is not superseded: its in-flight work may complete while the key now
  // addresses the fresh pending entry.
  const admitted: ScheduledOccurrence = {
    ...entry,
    state: 'pending',
    occurrenceId: deps.ids.nextOccurrenceId(),
    payload,
  };
  deps.schedules.put(admitted);
  return { admitted, superseded, supersededId, affectedOutboxIds };
}

/**
 * Insert a pending occurrence under its key. When the key already holds a
 * pending occurrence this is a replace: the previous occurrence is superseded
 * and its id returned with the affected delivery intents.
 */
export function putSchedule(
  deps: ScheduleDeps,
  entry: NewScheduledOccurrence,
): PutScheduleResult {
  return upsertKeyedSchedule(deps, entry);
}

/**
 * Replace the pending occurrence under a key, superseding it. Behaves as an
 * insert when the key holds no pending occurrence; `supersededId` reports
 * which case applied.
 */
export function replaceSchedule(
  deps: ScheduleDeps,
  entry: NewScheduledOccurrence,
): PutScheduleResult {
  return upsertKeyedSchedule(deps, entry);
}

/**
 * Cancel the occurrence under a key. Pending and admitted entries are marked
 * cancelled and their undispatched delivery intents superseded; in-flight
 * admitted work and provider-accepted messages may still complete. Cancelling
 * a missing, superseded or already-cancelled key is an idempotent no-op.
 */
export function cancelSchedule(
  deps: ScheduleDeps,
  scope: WorkScope,
  key: string,
): CancelScheduleResult {
  if (typeof key !== 'string' || key.length === 0) {
    throw new RangeError('cancelSchedule: key must be a non-empty string');
  }
  const previous = deps.schedules.get(scope, key);
  if (previous === null) {
    return { cancelled: null, affectedOutboxIds: [] };
  }
  if (previous.state === 'superseded' || previous.state === 'cancelled') {
    return { cancelled: previous, affectedOutboxIds: [] };
  }
  const cancelled: ScheduledOccurrence = { ...previous, state: 'cancelled' };
  deps.schedules.put(cancelled);
  const affectedOutboxIds = supersedeIntents(deps, previous.occurrenceId);
  return { cancelled, affectedOutboxIds };
}
