/**
 * Memory storage conformance: each case gets a fresh instance, so reset is
 * trivial. The test-only memory probe verifies staged history/outbox/schedule
 * state exactly like the D1/DO probes verify theirs.
 */
import {
  storageConformance,
  asId, asModel, makeBatch, makeRow, uniqueClaim,
  type ConformanceProbe,
  type ConformanceSetup,
} from './conformance.js';
import { createTestMemoryStorage } from '../../src/storage/memory.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

async function memorySetup(): Promise<ConformanceSetup> {
  const { store, probe } = createTestMemoryStorage();
  const conformanceProbe: ConformanceProbe = {
    historyFor: async (model, recordId) => probe.historyFor(model, recordId),
    outboxAll: async () => probe.outboxAll(),
    scheduleGet: async (key) =>
      probe.scheduleGet(key) as unknown as Awaited<
        ReturnType<ConformanceProbe['scheduleGet']>
      >,
  };
  return { store, reset: async () => {}, probe: conformanceProbe };
}

storageConformance('memory', memorySetup);

test('uniqueOwner keeps independent memory owner stores isolated', async () => {
  const a = createTestMemoryStorage().store, b = createTestMemoryStorage().store;
  for (const [store, id] of [[a, 'owner-a'], [b, 'owner-b']] as const) {
    assert.equal(await store.uniqueOwner!(asModel('t.User'), 'code', 'Alpha'), null);
    await store.commit(makeBatch(0, {
      writes: [{ kind: 'insert', model: asModel('t.User'), row: makeRow({ id }) }],
      uniqueClaims: [uniqueClaim('t.User', id, 'code', 'Alpha')],
    }));
  }
  assert.equal(await a.uniqueOwner!(asModel('t.User'), 'code', 'Alpha'), asId('owner-a'));
  assert.equal(await b.uniqueOwner!(asModel('t.User'), 'code', 'Alpha'), asId('owner-b'));
});
