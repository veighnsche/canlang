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
  readFanoutChildRow,
  readFanoutIntentRow,
} from './tables.js';

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
  if (typeof input.fanoutId !== 'string' || input.fanoutId === '') {
    throw new StateError('validation', 'Fanout progress needs a non-empty fanout id.');
  }
  if (!Number.isInteger(input.pageLimit) || input.pageLimit < 1) {
    throw new StateError('validation', 'Fanout progress pageLimit must be an integer >= 1.');
  }
  const intentRow = await input.store.load(
    FANOUT_INTENT_MODEL as ModelName,
    input.fanoutId as RecordId,
  );
  if (intentRow === null) {
    throw new StateError('not_found', 'Fanout intent not found.');
  }
  const intent = readFanoutIntentRow(intentRow);
  let pending = 0;
  let running = 0;
  let completed = 0;
  let skipped = 0;
  let failed = 0;
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const rows = await input.store.query({
      model: FANOUT_CHILD_MODEL as ModelName,
      where:
        cursor === null
          ? { op: 'eq', field: 'fanoutId', value: input.fanoutId }
          : {
              op: 'and',
              args: [
                { op: 'eq', field: 'fanoutId', value: input.fanoutId },
                { op: 'gt', field: 'id', value: cursor },
              ],
            },
      order: [{ field: 'id', direction: 'asc' }],
      limit: input.pageLimit,
      authority: 'owner',
    });
    if (rows.length > input.pageLimit) {
      throw new StateError(
        'validation',
        `Fanout progress returned ${rows.length} rows past limit ${input.pageLimit}.`,
      );
    }
    for (const row of rows) {
      const child = readFanoutChildRow(row);
      if (child.fanoutId !== input.fanoutId) {
        continue;
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
    if (rows.length < input.pageLimit) {
      break;
    }
    const last = rows[rows.length - 1];
    if (last === undefined) {
      throw new StateError('validation', 'Fanout progress hit an unreachable empty full page.');
    }
    cursor = last.id as string;
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
    fanoutId: input.fanoutId,
    pending,
    running,
    completed,
    skipped,
    failed,
    terminal,
    attention: terminal && failed > 0,
  };
}
