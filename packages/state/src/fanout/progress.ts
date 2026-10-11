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
  StoragePort,
} from '@canlang/contracts';
import { StateError } from '../errors.js';
import {
  FANOUT_CHILD_MODEL,
  FANOUT_INTENT_MODEL,
  fanoutChildRowId,
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
export async function readFanoutProgress(input: ReadFanoutProgressInput): Promise<FanoutProgress> {
  const fanoutId = checkPrivateFanoutIdentity(input.fanoutId, true);
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
  const order = checkPrivateFanoutIdOrder(input.store.cohortIdOrder);
  const expectedRevision = await input.store.readRevision();
  const intentRow = await input.store.cohortLoad({
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
  const members = new Set(intent.members);
  let pending = 0;
  let running = 0;
  let completed = 0;
  let skipped = 0;
  let failed = 0;
  const seen = new Set<string>();
  let cursor: RecordId | null = null;
  let observed = 0;
  for (;;) {
    const pageLimit = observed === PRIVATE_FANOUT_LIMITS.members ? 1
      : Math.min(configuredLimit, PRIVATE_FANOUT_LIMITS.members - observed);
    const rows = await input.store.cohortRowPage({
      model: FANOUT_CHILD_MODEL as ModelName,
      fanoutId,
      after: cursor,
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
      if (observed === PRIVATE_FANOUT_LIMITS.members) {
        throw new StateError('limit', 'Fanout progress exceeds the private child row bound.', null,
          { retryable: false });
      }
      observed += 1;
      const rowId = checkPrivateFanoutIdentity(row.id, true);
      if (cursor !== null && comparePrivateFanoutIds(rowId, cursor, order) <= 0) {
        throw new StateError('validation', 'Fanout progress child pages must advance in ascending id order.');
      }
      cursor = row.id;
      const child = readPrivateFanoutChildRow(row);
      if (child.fanoutId !== fanoutId) {
        continue;
      }
      if (child.parentOccurrence !== intent.sourceOccurrence || child.handler !== intent.handler ||
          !members.has(child.recordId) ||
          child.childId !== fanoutChildRowId(intent.sourceOccurrence, intent.handler, child.recordId)) {
        throw new StateError('validation', 'Fanout progress child does not belong to the frozen intent.');
      }
      if (seen.has(child.recordId)) {
        throw new StateError(
          'validation',
          `Fanout progress saw a duplicate child identity: ${JSON.stringify(child.recordId)}.`,
        );
      }
      seen.add(child.recordId);
      switch (child.state) {
        case 'pending':
          pending += 1;
          break;
        case 'running':
          running += 1;
          break;
        case 'completed':
          completed += 1;
          break;
        case 'skipped':
          skipped += 1;
          break;
        case 'failed':
          failed += 1;
          break;
      }
    }
    if (rows.length < pageLimit) {
      break;
    }
  }
  // Members with no child row are admission outstanding: pending, never
  // silently complete.
  for (const recordId of intent.members) {
    if (!seen.has(recordId)) {
      pending += 1;
    }
  }
  const terminal =
    pending === 0 && running === 0 && completed + skipped + failed === intent.members.length;
  return {
    fanoutId,
    pending,
    running,
    completed,
    skipped,
    failed,
    terminal,
    attention: terminal && failed > 0,
  };
}
