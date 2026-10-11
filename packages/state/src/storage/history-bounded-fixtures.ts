import assert from 'node:assert/strict';
import type { HistoryEntry, StoragePort } from '@canlang/contracts';
import { StateError } from '../errors.js';
import { FenceConflictError } from './port.js';
import { asModel, asId, asVersion, asOperation, asOperationId, makeBatch } from '../../test/invocation/fixtures.js';

/** The same real-port boundary assertions run against memory and both native adapters. */
export async function exerciseBoundedHistory(store: StoragePort, reopen: () => StoragePort): Promise<void> {
  assert.ok(store.historyReadBounded);
  const model = asModel('History.Bounded'); const recordId = asId('record');
  const entry = (index: number, after: Record<string, unknown> | null = { index }): HistoryEntry => ({
    model, recordId, version: asVersion(index < 2 ? 1 : index), operation: asOperation('History.update'),
    operationId: asOperationId(`history-${index}`), actor: 'actor', at: index,
    change: 'update', before: null, after,
    ...(index === 1 ? { auditProjection: { created: 0, createdBy: 'creator', secretFields: ['originalSecret'] } } : {}),
  });
  await store.commit(makeBatch(await store.readRevision(), { history: Array.from({ length: 100 }, (_, i) => entry(i)) }));
  const revision = await store.readRevision();
  const other = reopen(); assert.ok(other.historyReadBounded);
  const result = await other.historyReadBounded({ model, recordId, expectedRevision: revision, limit: 100 });
  assert.equal(result.length, 100);
  assert.deepEqual(result.slice(0, 2).map(row => row.operationId), ['history-0', 'history-1']);
  assert.equal(result[0]?.before, null);
  assert.equal(Object.hasOwn(result[0]!, 'auditProjection'), false);
  assert.deepEqual(result[1]?.auditProjection, { created: 0, createdBy: 'creator', secretFields: ['originalSecret'] });
  assert.deepEqual((await other.historyFor(model, recordId))[1]?.auditProjection, result[1]?.auditProjection);
  assert.deepEqual(result[99]?.after, { index: 99 });
  await store.commit(makeBatch(revision, { history: [entry(100)] }));
  await assert.rejects(() => other.historyReadBounded!({ model, recordId, expectedRevision: revision, limit: 100 }), FenceConflictError);
  await assert.rejects(() => other.historyReadBounded!({ model, recordId, expectedRevision: revision + 1 as typeof revision, limit: 100 }),
    error => error instanceof StateError && error.code === 'validation');
  const largeId = asId('large');
  await store.commit(makeBatch(await store.readRevision(), { history: [{ ...entry(101, { text: 'x'.repeat(2_000_001) }), recordId: largeId }] }));
  await assert.rejects(() => other.historyReadBounded!({ model, recordId: largeId, expectedRevision: revision + 2 as typeof revision, limit: 100 }),
    error => error instanceof StateError && error.code === 'limit' && error.retryable === false);
  await assert.rejects(() => other.historyReadBounded!({ model, recordId, expectedRevision: revision + 2 as typeof revision, limit: 101 }),
    error => error instanceof StateError && error.code === 'validation');
  // Exceed the SQL raw-column gate itself, not just the later JSON text cap.
  // The native driver must return the refusal sentinel without this payload.
  const rawId = asId('raw-bytes');
  // Each row fits the substrate's individual SQLite value ceiling; their
  // complete result exceeds our aggregate pre-materialization ceiling.
  await store.commit(makeBatch(await store.readRevision(), { history: Array.from({ length: 7 }, (_, index) =>
    ({ ...entry(102 + index, { text: 'x'.repeat(1_900_000) }), recordId: rawId })) }));
  await assert.rejects(() => other.historyReadBounded!({ model, recordId: rawId,
    expectedRevision: revision + 3 as typeof revision, limit: 100 }),
  error => error instanceof StateError && error.code === 'limit' && error.retryable === false);
}
