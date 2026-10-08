/** Shared internal helpers for fenced kernel command stages. */
import type {
  DomainWrite,
  ModelName,
  OccurrenceId,
  OutboxId,
  RecordId,
  StoredRow,
} from '@canlang/contracts';
import type { SystemCommandContext } from '@canlang/state';
import {
  WORK_SUPERSESSION_MODEL,
  dispatchByOriginQuery,
  newSupersessionRow,
  readDispatchRow,
  withRowData,
} from './tables.js';

export type StageContext = Pick<SystemCommandContext, 'actor' | 'now' | 'load' | 'query'>;

export function updateWrite(
  row: StoredRow,
  data: Readonly<Record<string, unknown>>,
  ctx: StageContext,
  model: ModelName,
  what: string,
): DomainWrite {
  return {
    kind: 'update',
    model,
    id: row.id,
    expectedVersion: row.version,
    row: withRowData(row, data, { nowMs: ctx.now, actor: ctx.actor }, what),
  };
}

/**
 * Insert supersession marks for undispatched intents of one origin,
 * skipping already-marked ids (idempotent). Mirrors
 * `collectUndispatchedIntents`: pending rows only, exact origin match.
 */
export async function markOriginSuperseded(
  ctx: StageContext,
  originOccurrence: string,
  byOccurrenceId: OccurrenceId | null,
  what: string,
): Promise<{ writes: DomainWrite[]; superseded: OutboxId[] }> {
  const rows = await ctx.query(dispatchByOriginQuery(originOccurrence as OccurrenceId));
  const writes: DomainWrite[] = [];
  const superseded: OutboxId[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const data = readDispatchRow(row);
    // Exact re-filter: origin match, pending state, first sighting.
    if (data.originOccurrence !== originOccurrence || data.state !== 'pending') {
      continue;
    }
    if (seen.has(data.intentId)) continue;
    seen.add(data.intentId);
    const existing = await ctx.load(WORK_SUPERSESSION_MODEL, data.intentId as RecordId);
    if (existing !== null) continue;
    writes.push({
      kind: 'insert',
      model: WORK_SUPERSESSION_MODEL,
      row: newSupersessionRow(
        {
          outboxId: data.intentId,
          byOccurrenceId,
          markedAtMs: ctx.now,
        },
        { nowMs: ctx.now, actor: ctx.actor },
      ),
    });
    superseded.push(data.intentId);
  }
  superseded.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { writes, superseded };
}

export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
