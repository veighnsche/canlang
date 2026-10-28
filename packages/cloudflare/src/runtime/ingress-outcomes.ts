/** Durable ingress outcome store over D1. */
import type { D1Database } from '@cloudflare/workers-types';
import type { IngressOutcomeRecord, IngressOutcomeStore } from '@canlang/interfaces';

/**
 * D1-backed `IngressOutcomeStore`: one committed outcome row per
 * `(namespace, producer_event_id)`, put-if-absent so replays return
 * the original record bytes across restarts. Stored rows are
 * re-validated closed on read; a corrupt row fails loud rather than
 * associating a forged outcome.
 */
export async function createD1IngressOutcomeStore({ db }: { readonly db: D1Database }): Promise<IngressOutcomeStore> {
  if (typeof db?.prepare !== 'function') throw new Error('Ingress outcomes require their real D1 binding.');
  await db.prepare('CREATE TABLE IF NOT EXISTS can_ingress_outcomes (ns TEXT NOT NULL, producer_event_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(ns,producer_event_id))').run();
  const checked = (value: unknown): IngressOutcomeRecord => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Ingress outcomes lost their committed shape.');
    const row = value as Record<string, unknown>;
    const keys = Reflect.ownKeys(row);
    if (keys.length !== 6 || !['producerEventId', 'namespace', 'operationKind', 'requestDigest', 'event', 'committedAt'].every(key => Object.hasOwn(row, key))) throw new Error('Ingress outcomes lost their committed shape.');
    const text = (name: string, allowEmpty: boolean): string => {
      const field = row[name];
      if (typeof field !== 'string' || (!allowEmpty && field === '')) throw new Error('Ingress outcomes lost their committed shape.');
      return field;
    };
    const event = row['event'];
    if (typeof event !== 'object' || event === null || Array.isArray(event)) throw new Error('Ingress outcomes lost their committed shape.');
    const committedAt = text('committedAt', false);
    if (!Number.isFinite(Date.parse(committedAt))) throw new Error('Ingress outcomes lost their committed shape.');
    return { producerEventId: text('producerEventId', false), namespace: text('namespace', false),
      operationKind: text('operationKind', false), requestDigest: text('requestDigest', true),
      event: { ...(event as Record<string, unknown>) }, committedAt };
  };
  const read = async (namespace: string, producerEventId: string): Promise<IngressOutcomeRecord | null> => {
    const found = await db.prepare('SELECT json FROM can_ingress_outcomes WHERE ns=? AND producer_event_id=?')
      .bind(namespace, producerEventId).first<{ json: string }>();
    return found === null ? null : checked(JSON.parse(found.json));
  };
  return {
    async record(outcome: IngressOutcomeRecord): Promise<IngressOutcomeRecord> {
      const stored = checked(outcome);
      await db.prepare('INSERT OR IGNORE INTO can_ingress_outcomes(ns,producer_event_id,json) VALUES (?,?,?)')
        .bind(stored.namespace, stored.producerEventId, JSON.stringify(stored)).run();
      const current = await read(stored.namespace, stored.producerEventId);
      if (current === null) throw new Error('Ingress outcomes lost their committed write.');
      return current;
    },
    async findByProducerEventId(producerEventId: string): Promise<IngressOutcomeRecord | null> {
      // The memory store answers null for unknown ids (including '');
      // match it without querying on degenerate input.
      if (typeof producerEventId !== 'string' || producerEventId === '') return null;
      const found = await db.prepare('SELECT json FROM can_ingress_outcomes WHERE producer_event_id=? ORDER BY ns LIMIT 1')
        .bind(producerEventId).first<{ json: string }>();
      return found === null ? null : checked(JSON.parse(found.json));
    },
  };
}
