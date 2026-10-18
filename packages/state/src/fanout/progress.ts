/**
 * T34-F5 operator progress: data-minimized fanout projection (F1
 * `FanoutProgress` — retained per-state counts plus the aggregate
 * attention input; fully terminal with failures means attention, never
 * success).
 *
 * Data minimization (§C7) is structural: the returned value carries
 * counts only — no child rows, no record data, no identities beyond the
 * fanout id. Terminality is evaluated against the FROZEN intent set
 * (every admitted identity terminally accounted), so missing child rows
 * read as non-terminal (resume), never as silently complete.
 */

import type { FanoutProgress } from '@canlang/contracts';
import type {
  ModelName,
  RecordId,
  Revision,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import { StateError } from '../errors.js';
import {
  FANOUT_CHILD_MODEL,
  FANOUT_INTENT_MODEL,
  fanoutChildRowId,
  type FanoutIntentData,
} from './tables.js';
import {
  PRIVATE_FANOUT_LIMITS,
  checkPrivateFanoutIdentity,
  checkPrivateFanoutIdOrder,
  comparePrivateFanoutIds,
  readPrivateFanoutChildRow,
  readPrivateFanoutIntentRow,
} from './membership.js';

/** One progress read over the owning store. */
export interface ReadFanoutProgressInput {
  readonly store: StoragePort;
  readonly fanoutId: string;
  /** Bounded page transport bound (chunk size, never cohort size). */
  readonly pageLimit: number;
}

/**
 * Read one fanout's operator progress. Drains the intent row plus
 * bounded id-sorted child pages and folds them into counts. A missing
 * intent row is a caller `not_found` (no invented progress); members
 * with no child row count as pending (admission outstanding — the
 * recovery `admit` posture, never silently complete).
 */
function checkProgressPageLimit(input: ReadFanoutProgressInput): number {
  const configured = Object.getOwnPropertyDescriptor(input, 'pageLimit');
  if (configured === undefined || !configured.enumerable || !('value' in configured)) {
    throw new StateError('validation', 'Fanout progress pageLimit must be an own-data value.');
  }
  const configuredLimit: unknown = configured.value;
  if (typeof configuredLimit !== 'number' || !Number.isInteger(configuredLimit) || configuredLimit < 1) {
    throw new StateError('validation', 'Fanout progress pageLimit must be an integer >= 1.');
  }
  if (configuredLimit > PRIVATE_FANOUT_LIMITS.page) {
    throw new StateError('limit', 'Fanout progress pageLimit exceeds the private page bound.', null,
      { retryable: false });
  }
  return configuredLimit;
}

async function loadProgressIntent(
  store: StoragePort,
  fanoutId: string,
  expectedRevision: Revision,
): Promise<FanoutIntentData> {
  const intentRow = await store.cohortLoad({
    model: FANOUT_INTENT_MODEL as ModelName,
    id: fanoutId as RecordId,
    expectedRevision,
  });
  if (intentRow === null) {
    throw new StateError('not_found', 'Fanout intent not found.');
  }
  const intent = readPrivateFanoutIntentRow(intentRow);
  if (intent.fanoutId !== fanoutId) {
    throw new StateError('validation', 'Fanout progress loaded a different intent.');
  }
  return intent;
}

interface ProgressTally {
  pending: number;
  running: number;
  completed: number;
  skipped: number;
  failed: number;
  readonly seen: Set<string>;
  observed: number;
  cursor: RecordId | null;
}

function countProgressState(tally: ProgressTally, state: string): void {
  switch (state) {
    case 'pending':
      tally.pending += 1;
      break;
    case 'running':
      tally.running += 1;
      break;
    case 'completed':
      tally.completed += 1;
      break;
    case 'skipped':
      tally.skipped += 1;
      break;
    case 'failed':
      tally.failed += 1;
      break;
  }
}

function foldProgressRow(
  row: StoredRow,
  fanoutId: string,
  intent: FanoutIntentData,
  members: ReadonlySet<string>,
  order: 'utf16' | 'utf8-binary',
  tally: ProgressTally,
): void {
  if (tally.observed === PRIVATE_FANOUT_LIMITS.members) {
    throw new StateError('limit', 'Fanout progress exceeds the private child row bound.', null,
      { retryable: false });
  }
  tally.observed += 1;
  const rowId = checkPrivateFanoutIdentity(row.id, true);
  if (tally.cursor !== null && comparePrivateFanoutIds(rowId, tally.cursor, order) <= 0) {
    throw new StateError('validation', 'Fanout progress child pages must advance in ascending id order.');
  }
  tally.cursor = row.id;
  const child = readPrivateFanoutChildRow(row);
  if (child.fanoutId !== fanoutId) {
    return;
  }
  if (child.parentOccurrence !== intent.sourceOccurrence || child.handler !== intent.handler ||
    !members.has(child.recordId) ||
    child.childId !== fanoutChildRowId(intent.sourceOccurrence, intent.handler, child.recordId)) {
    throw new StateError('validation', 'Fanout progress child does not belong to the frozen intent.');
  }
  if (tally.seen.has(child.recordId)) {
    throw new StateError(
      'validation',
      `Fanout progress saw a duplicate child identity: ${JSON.stringify(child.recordId)}.`,
    );
  }
  tally.seen.add(child.recordId);
  countProgressState(tally, child.state);
}

async function drainProgressChildren(
  store: StoragePort,
  fanoutId: string,
  intent: FanoutIntentData,
  members: ReadonlySet<string>,
  order: 'utf16' | 'utf8-binary',
  configuredLimit: number,
  expectedRevision: Revision,
  tally: ProgressTally,
): Promise<void> {
  for (;;) {
    const pageLimit = tally.observed === PRIVATE_FANOUT_LIMITS.members ? 1
      : Math.min(configuredLimit, PRIVATE_FANOUT_LIMITS.members - tally.observed);
    const rows = await store.cohortRowPage({
      model: FANOUT_CHILD_MODEL as ModelName,
      fanoutId,
      after: tally.cursor,
      limit: pageLimit,
      expectedRevision,
    });
    if (rows.length > pageLimit) {
      throw new StateError(
        'validation',
        `Fanout progress returned ${rows.length} rows past limit ${pageLimit}.`,
      );
    }
    for (const row of rows) {
      foldProgressRow(row, fanoutId, intent, members, order, tally);
    }
    if (rows.length < pageLimit) {
      break;
    }
  }
}

export async function readFanoutProgress(input: ReadFanoutProgressInput): Promise<FanoutProgress> {
  const fanoutId = checkPrivateFanoutIdentity(input.fanoutId, true);
  const configuredLimit = checkProgressPageLimit(input);
  const order = checkPrivateFanoutIdOrder(input.store.cohortIdOrder);
  const expectedRevision = await input.store.readRevision();
  const intent = await loadProgressIntent(input.store, fanoutId, expectedRevision);
  const members = new Set(intent.members);
  const tally: ProgressTally = { pending: 0, running: 0, completed: 0, skipped: 0, failed: 0,
    seen: new Set<string>(), observed: 0, cursor: null };
  await drainProgressChildren(input.store, fanoutId, intent, members, order,
    configuredLimit, expectedRevision, tally);
  // Members with no child row are admission outstanding: pending, never
  // silently complete.
  for (const recordId of intent.members) {
    if (!tally.seen.has(recordId)) {
      tally.pending += 1;
    }
  }
  const terminal = tally.pending === 0 && tally.running === 0 &&
    tally.completed + tally.skipped + tally.failed === intent.members.length;
  return {
    fanoutId,
    pending: tally.pending,
    running: tally.running,
    completed: tally.completed,
    skipped: tally.skipped,
    failed: tally.failed,
    terminal,
    attention: terminal && tally.failed > 0,
  };
}
