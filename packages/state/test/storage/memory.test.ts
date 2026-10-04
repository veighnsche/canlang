/**
 * Memory storage conformance: each case gets a fresh instance, so reset is
 * trivial. The test-only memory probe verifies staged history/outbox/schedule
 * state exactly like the D1/DO probes verify theirs.
 */
import {
  storageConformance,
  type ConformanceProbe,
  type ConformanceSetup,
} from './conformance.js';
import { createTestMemoryStorage } from '../../src/storage/memory.js';

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
