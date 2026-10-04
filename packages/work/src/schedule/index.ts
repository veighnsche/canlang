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
 * Identity note: `ScheduledOccurrence` carries no occurrence id in contracts,
 * so the occurrence identity is the qualified schedule key
 * (`formatScheduleId`). Delivery intents join to their occurrence by exact
 * `source === event` match — the only linkage the contracts provide.
 */
import type {
  OutboxId,
  OutboxItem,
  ScheduledOccurrence,
  WorkScope,
} from '../../../contracts/src/work.js';
import type { OutboxStorePort, ScheduleStorePort, SupersessionPort } from '../ports.ts';

export interface ScheduleDeps {
  schedules: ScheduleStorePort;
  outbox: OutboxStorePort;
  supersessions: SupersessionPort;
}

/**
 * Canonical identity of one keyed occurrence: app, owner, owning package and
 * key. Stable across releases.
 */
export function formatScheduleId(scope: WorkScope, key: string): string {
  return `${scope.app}|${scope.owner}|${scope.ownerPackage}|${key}`;
}

export interface PutScheduleResult {
  /** The newly stored pending entry. */
  admitted: ScheduledOccurrence;
  /** Previous pending entry now marked superseded, if any. */
  superseded: ScheduledOccurrence | null;
  /** Qualified id of the superseded occurrence, if any. */
  supersededId: string | null;
  /** Undispatched delivery intents now superseded, in stable id order. */
  affectedOutboxIds: OutboxId[];
}

export interface CancelScheduleResult {
  /** Entry now marked cancelled; null when the key never existed. */
  cancelled: ScheduledOccurrence | null;
  /** Undispatched delivery intents now superseded, in stable id order. */
  affectedOutboxIds: OutboxId[];
}

function assertPendingEntry(entry: ScheduledOccurrence): void {
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
 * Undispatched delivery intents for one occurrence: outbox items declared by
 * its event source that are still `pending`. Anything claimed, uncertain or
 * settled is provider-accepted or finished work and is never touched.
 */
export function collectUndispatchedIntents(
  outbox: OutboxStorePort,
  source: string,
): OutboxItem[] {
  return outbox
    .listBySource(source)
    .filter((item) => item.state === 'pending')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function supersedeIntents(deps: ScheduleDeps, source: string): OutboxId[] {
  const undispatched = collectUndispatchedIntents(deps.outbox, source);
  const ids = undispatched.map((item) => item.id);
  deps.supersessions.markSuperseded(ids);
  return ids;
}

function upsertKeyedSchedule(deps: ScheduleDeps, entry: ScheduledOccurrence): PutScheduleResult {
  assertPendingEntry(entry);
  const previous = deps.schedules.get(entry.scope, entry.key);
  let superseded: ScheduledOccurrence | null = null;
  let supersededId: string | null = null;
  let affectedOutboxIds: OutboxId[] = [];
  if (previous !== null && previous.state === 'pending') {
    superseded = { ...previous, state: 'superseded' };
    deps.schedules.put(superseded);
    supersededId = formatScheduleId(previous.scope, previous.key);
    affectedOutboxIds = supersedeIntents(deps, previous.event);
  }
  // A non-pending predecessor (admitted work in flight, or a terminal entry)
  // is not superseded: its in-flight work may complete while the key now
  // addresses the fresh pending entry.
  const admitted: ScheduledOccurrence = { ...entry, state: 'pending' };
  deps.schedules.put(admitted);
  return { admitted, superseded, supersededId, affectedOutboxIds };
}

/**
 * Insert a pending occurrence under its key. When the key already holds a
 * pending occurrence this is a replace: the previous occurrence is superseded
 * and its id returned with the affected delivery intents.
 */
export function putSchedule(deps: ScheduleDeps, entry: ScheduledOccurrence): PutScheduleResult {
  return upsertKeyedSchedule(deps, entry);
}

/**
 * Replace the pending occurrence under a key, superseding it. Behaves as an
 * insert when the key holds no pending occurrence; `supersededId` reports
 * which case applied.
 */
export function replaceSchedule(
  deps: ScheduleDeps,
  entry: ScheduledOccurrence,
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
  const affectedOutboxIds = supersedeIntents(deps, previous.event);
  return { cancelled, affectedOutboxIds };
}
