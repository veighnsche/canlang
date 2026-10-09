/**
 * Lane 03 B3-I1 adapter proofs: the retained-intent carry-over plus the
 * recovery intakes run identically on all three StoragePort backends
 * (memory, D1 over local miniflare, Durable Object SQLite over workerd
 * through the generic method proxy). Each backend gets its own isolated
 * store; migration ids are unique per test so the shared DO reset (which
 * predates `migration_failures`) cannot leak audit rows across tests.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type {
  MigrationTransition,
  ModelName,
  OperationId,
  OutboxIntent,
  StoragePort,
  WorkInventoryItem,
} from '@canlang/contracts';
import {
  abortMigration,
  activate,
  computeRetainedCarryover,
  readFailure,
  recordFailure,
  resumeMigration,
  stageNextChunk,
  validateStaged,
  validateTransition,
  type MigrationMapper,
  type ValidatedMigrationPlan,
} from '../../src/migration/index.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { createD1Storage, ensureSchema as ensureD1Schema } from '../../src/storage/d1.js';
import {
  TODO_MODEL,
  asModel,
  asOperation,
  captureStateError,
  fixedClock,
  installSnapshot,
  makeBatch,
  makeInstalled,
  makeTransition,
  oldLocks,
  seedLive,
  todoDirectives,
  todoTables,
} from './fixtures.js';

/* -- Backend setups. -- */

const asOperationId = (s: string): OperationId => s as OperationId;

function priorityMapper(): MigrationMapper {
  return (before, row) => {
    row.set('priority', before.data['done'] === true ? 'low' : 'normal');
  };
}

function todoMappers(): ReadonlyMap<ModelName, MigrationMapper> {
  return new Map([[asModel(TODO_MODEL), priorityMapper()]]);
}

function planFor(migrationId: string): ValidatedMigrationPlan {
  const { oldModels, desiredModels } = todoTables();
  const transition: MigrationTransition = makeTransition({
    migrationId,
    directives: todoDirectives(),
  });
  return validateTransition(makeInstalled(), transition, oldModels, desiredModels);
}

async function seedContractedOutbox(
  store: StoragePort,
  intents: ReadonlyArray<{ readonly intentId: string; readonly handlerContract: string }>,
): Promise<void> {
  const staged: OutboxIntent[] = intents.map((intent, index) => ({
    intentId: intent.intentId,
    operation: asOperation('acme.worker'),
    operationId: asOperationId(`0195${String(index).padStart(28, '0')}`),
    target: 'worker',
    arguments: {},
    occurrenceIndex: index,
    handlerContract: intent.handlerContract,
  }));
  const revision = await store.readRevision();
  await store.commit(makeBatch(revision as number, { outbox: staged }));
}

async function stageAndValidate(store: StoragePort, plan: ValidatedMigrationPlan): Promise<void> {
  const { oldModels, desiredModels } = todoTables();
  for (;;) {
    const result = await stageNextChunk({
      store,
      plan,
      mappers: todoMappers(),
      oldModels,
      desiredModels,
      chunkSize: 10,
    });
    if (result.done) {
      break;
    }
  }
  await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
}

/* D1 (local miniflare database). */

let d1mf: Miniflare | undefined;
let d1db: D1Database;

const D1_TABLES = [
  'records',
  'history',
  'receipts',
  'outbox',
  'schedules',
  'unique_claims',
  'snapshots',
  'migration_staging',
  'migration_progress',
  'migration_outcomes',
  'migration_failures',
];

async function resetD1Local(): Promise<void> {
  await d1db.batch([
    ...D1_TABLES.map((table) => d1db.prepare(`DELETE FROM ${table}`)),
    d1db.prepare('DELETE FROM fence_log'),
    d1db.prepare('UPDATE fence SET revision = 0 WHERE id = 1'),
  ]);
}

/* Durable Object (workerd + generic method proxy). */

const workerPath = fileURLToPath(
  new URL('../../../test/storage/do-test-worker.js', import.meta.url),
);

let doMf: Miniflare | undefined;

async function doPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  if (doMf === undefined) {
    throw new Error('miniflare is not started');
  }
  const response = await doMf.dispatchFetch(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

async function doCall<T>(method: string, ...args: ReadonlyArray<unknown>): Promise<T> {
  const data = await doPost('/call', { method, args });
  if (data['ok'] !== true) {
    const error = data['error'] as { name?: string; message?: string };
    const rebuilt = new Error(error.message ?? String(method));
    rebuilt.name = error.name ?? 'Error';
    throw rebuilt;
  }
  return data['value'] as T;
}

function doProxy(): StoragePort {
  return {
    readRevision: () => doCall('readRevision'),
    load: (model, id) => doCall('load', model, id),
    query: (spec) => doCall('query', spec),
    commit: (batch) => doCall('commit', batch),
    readReceipt: (identity) => doCall('readReceipt', identity),
    outboxPending: () => doCall('outboxPending'),
    outboxGet: (intentId) => doCall('outboxGet', intentId),
    scheduleGet: (key) => doCall('scheduleGet', key),
    schedulesDue: (now, limit) => doCall('schedulesDue', now, limit),
    historyFor: (model, recordId) => doCall('historyFor', model, recordId),
    readInstalledSnapshot: (owner) => doCall('readInstalledSnapshot', owner),
    readMigrationProgress: (migrationId) => doCall('readMigrationProgress', migrationId),
    readStagedRows: (migrationId, cursor, limit) =>
      doCall('readStagedRows', migrationId, cursor, limit),
    stageMigrationRows: (input) => doCall('stageMigrationRows', input),
    publishMigrationChunk: (input) => doCall('publishMigrationChunk', input),
    flipInstalledSnapshot: (input) => doCall('flipInstalledSnapshot', input),
    readMigrationOutcomes: (migrationId) => doCall('readMigrationOutcomes', migrationId),
    recordMigrationFailure: (input) => doCall('recordMigrationFailure', input),
    discardStagedRows: (input) => doCall('discardStagedRows', input),
    readMigrationFailure: (migrationId) => doCall('readMigrationFailure', migrationId),
  };
}

async function resetDOLocal(): Promise<void> {
  const data = await doPost('/reset', {});
  if (data['ok'] !== true) {
    throw new Error(`DO reset failed: ${JSON.stringify(data['error'])}`);
  }
}

before(async () => {
  d1mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: ['DB'],
  });
  d1db = await d1mf.getD1Database('DB');
  await ensureD1Schema(d1db);

  doMf = new Miniflare({
    modules: true,
    scriptPath: workerPath,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2025-01-01',
    durableObjects: {
      TEST_DO: { className: 'TestDO', useSQLite: true, unsafePreventEviction: true },
    },
  });
  await resetDOLocal();
});

after(async () => {
  if (d1mf !== undefined) {
    await d1mf.dispose();
    d1mf = undefined;
  }
  if (doMf !== undefined) {
    await doMf.dispose();
    doMf = undefined;
  }
});

interface Backend {
  readonly name: string;
  readonly setup: () => Promise<StoragePort>;
}

const backends: ReadonlyArray<Backend> = [
  { name: 'memory', setup: async () => createMemoryStorage() },
  {
    name: 'd1',
    setup: async () => {
      await resetD1Local();
      return createD1Storage(d1db);
    },
  },
  {
    name: 'do',
    setup: async () => {
      await resetDOLocal();
      return doProxy();
    },
  },
];

/* -- The per-backend proofs. -- */

for (const backend of backends) {
  describe(`b3 migration on ${backend.name}`, () => {
    it('retained in-flight intent survives the flip and dispatches after', async () => {
      const store = await backend.setup();
      const migrationId = `mig-retain-${backend.name}`;
      await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
      await installSnapshot(store, makeInstalled(), `mig-seed-${backend.name}`);
      const intentId = `w-keep-${backend.name}`;
      await seedContractedOutbox(store, [{ intentId, handlerContract: 'acme.cleanup' }]);
      // The stored contract survives the adapter round-trip.
      const pendingContracts = (await store.outboxPending()).map((intent) => intent.handlerContract);
      assert.deepEqual(pendingContracts, ['acme.cleanup']);
      const plan = planFor(migrationId);
      const inventory: WorkInventoryItem[] = [
        { intentId, handlerContract: 'acme.cleanup', state: 'inflight' },
      ];
      const carryover = computeRetainedCarryover({
        plan,
        inventory,
        pending: await store.outboxPending(),
      });
      assert.deepEqual([...carryover.retained.ids], [intentId]);
      await stageAndValidate(store, plan);
      const { oldModels, desiredModels } = todoTables();
      const flip = await activate({
        store,
        plan,
        inventory,
        retained: carryover.retained,
        oldModels,
        desiredModels,
        chunkSize: 10,
        clock: fixedClock(),
      });
      assert.equal(flip.flipped, true);
      assert.equal((await store.readMigrationProgress(migrationId))?.phase, 'active');
      assert.deepEqual(
        (await store.outboxPending()).map((intent) => intent.intentId),
        [intentId],
      );
      const revision = await store.readRevision();
      await store.commit({ ...makeBatch(revision as number), outboxAck: [intentId] });
      assert.deepEqual(await store.outboxPending(), []);
    });

    it('failure records, retry resumes, and abort discards', async () => {
      const store = await backend.setup();
      const migrationId = `mig-recover-${backend.name}`;
      await seedLive(store, TODO_MODEL, [
        { id: 'a', data: { label: 'a', done: true } },
        { id: 'b', data: { label: 'b', done: false } },
      ]);
      await installSnapshot(store, makeInstalled(), `mig-seed2-${backend.name}`);
      const plan = planFor(migrationId);
      const { oldModels, desiredModels } = todoTables();
      // Failure intake round-trip (cursor-preserving mark).
      const recorded = await recordFailure(store, migrationId, 'staging', new Error('kaput'), 42);
      assert.equal(recorded.leg, 'staging');
      assert.match(recorded.error, /kaput/);
      assert.equal((await store.readMigrationProgress(migrationId))?.phase, 'failed');
      assert.deepEqual(await readFailure(store, migrationId), recorded);
      // Retry restores the prior phase and the run completes.
      const retried = await resumeMigration({
        store,
        plan,
        mappers: todoMappers(),
        oldModels,
        desiredModels,
        oldLocks: oldLocks([]),
        inventory: [],
        failedDecision: { decision: 'retry' },
        chunkSize: 10,
        clock: fixedClock(),
      });
      // Retry restored staging, the leg restaged and validated to staged.
      assert.equal(retried.progress?.phase, 'staged');
      // Pre-flip abort discards; the prior snapshot stays active.
      const aborted = await abortMigration(store, migrationId);
      assert.equal(aborted.aborted, true);
      assert.deepEqual(await store.readStagedRows(migrationId, null, 100), []);
      assert.equal((await store.readInstalledSnapshot('acme'))?.snapshotId, 'snap-1');
      // The failure record survives the abort as audit.
      assert.ok((await readFailure(store, migrationId)) !== null);
    });

    it('unpinned undispatched still blocks without a retained set', async () => {
      const store = await backend.setup();
      const migrationId = `mig-block-${backend.name}`;
      await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
      await installSnapshot(store, makeInstalled(), `mig-seed3-${backend.name}`);
      const intentId = `w-block-${backend.name}`;
      await seedContractedOutbox(store, [{ intentId, handlerContract: 'acme.cleanup' }]);
      const plan = planFor(migrationId);
      await stageAndValidate(store, plan);
      const { oldModels, desiredModels } = todoTables();
      // The DO proxy rehydrates engine errors as plain Errors (no
      // StateError class over fetch), so match the message either way.
      let message = '';
      try {
        await activate({
          store,
          plan,
          inventory: [{ intentId, handlerContract: 'acme.cleanup', state: 'undispatched' }],
          oldModels,
          desiredModels,
          chunkSize: 10,
          clock: fixedClock(),
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.match(message, /no pinned invalidate contract/);
      // Memory/D1 raise typed StateError; assert the code where typed.
      if (backend.name !== 'do') {
        const typed = await captureStateError(() =>
          activate({
            store,
            plan,
            inventory: [{ intentId, handlerContract: 'acme.cleanup', state: 'undispatched' }],
            oldModels,
            desiredModels,
            chunkSize: 10,
            clock: fixedClock(),
          }),
        );
        assert.equal(typed.code, 'validation');
      }
      assert.equal((await store.readMigrationProgress(migrationId))?.phase, 'staged');
    });
  });
}
