/**
 * Lane 03 B3-I1 recovery tests: unexpected leg failures record durable
 * `failed` state (StateError validation still preserves phase for cursor
 * retry — see the taxonomy pin below), retry restores the prior phase,
 * and pre-flip abort discards staged rows while the prior snapshot stays
 * active. Post-flip and mid-publish aborts refuse (forward-only, no
 * destructive rollback). Memory StoragePort.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelName, StoragePort, StoredRow } from '@canlang/contracts';
import {
  activate,
  publishStagedAndDrops,
  resumeMigration,
  stageNextChunk,
  validateStaged,
  type MigrationMapper,
  type ResumeMigrationInput,
  type ValidatedMigrationPlan,
} from '../../src/migration/index.js';
import {
  abortMigration,
  readFailure,
  recordFailure,
} from '../../src/migration/recover.js';
import {
  FIXED_NOW,
  TODO_MODEL,
  asModel,
  captureStateError,
  fixedClock,
  installSnapshot,
  makeInstalled,
  oldLocks,
  seedLive,
  setupMigrationWorld,
  todoPlan,
  todoTables,
} from './fixtures.js';

function priorityMapper(): MigrationMapper {
  return (before, row) => {
    row.set('priority', before.data['done'] === true ? 'low' : 'normal');
  };
}

function resumeBag(
  store: StoragePort,
  plan: ValidatedMigrationPlan,
  mappers?: ReadonlyMap<ModelName, MigrationMapper>,
): ResumeMigrationInput {
  const { oldModels, desiredModels } = todoTables();
  return {
    store,
    plan,
    mappers: mappers ?? new Map([[asModel(TODO_MODEL), priorityMapper()]]),
    oldModels,
    desiredModels,
    oldLocks: oldLocks([]),
    inventory: [],
    chunkSize: 10,
    clock: fixedClock(),
  };
}

async function stageAll(
  store: StoragePort,
  plan: ValidatedMigrationPlan,
  mappers?: ReadonlyMap<ModelName, MigrationMapper>,
): Promise<void> {
  const { oldModels, desiredModels } = todoTables();
  const wired = mappers ?? new Map([[asModel(TODO_MODEL), priorityMapper()]]);
  for (;;) {
    const result = await stageNextChunk({ store, plan, mappers: wired, oldModels, desiredModels, chunkSize: 10 });
    if (result.done) {
      break;
    }
  }
  await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
}

describe('recovery: failure recording', () => {
  it('records failed on staging failure and resume retries to staged', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [
      { id: 'a', data: { label: 'a', done: true } },
      { id: 'b', data: { label: 'b', done: false } },
    ]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    // Resume never starts fresh work: one staged chunk first, so the
    // failure lands mid-staging with a cursor.
    await stageNextChunk({
      store,
      plan,
      mappers: new Map([[asModel(TODO_MODEL), priorityMapper()]]),
      oldModels,
      desiredModels,
      chunkSize: 1,
    });
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'staging');
    const exploding: MigrationMapper = () => {
      throw new TypeError('mapper boom');
    };
    const bag = resumeBag(store, plan, new Map([[asModel(TODO_MODEL), exploding]]));
    await assert.rejects(() => resumeMigration(bag), /mapper boom/);
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'failed');
    const failure = await readFailure(store, 'mig-1');
    assert.ok(failure !== null);
    assert.equal(failure.leg, 'staging');
    assert.equal(failure.priorPhase, 'staging');
    assert.match(failure.error, /mapper boom/);
    assert.equal(failure.at, FIXED_NOW);
    // Operator fixes the mapper and retries: resume restores staging and
    // completes the leg.
    const retried = await resumeMigration({
      ...resumeBag(store, plan),
      failedDecision: { decision: 'retry' },
    });
    assert.equal(retried.progress?.phase, 'staged');
  });

  it('leaves StateError validation unrecorded for cursor retry', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: false } }]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const unlocking: MigrationMapper = (_before, row) => {
      row.set('done', true);
      row.set('priority', 'low');
    };
    const wired = new Map([[asModel(TODO_MODEL), unlocking]]);
    await stageAll(store, plan, wired);
    const error = await captureStateError(() =>
      resumeMigration({
        ...resumeBag(store, plan, wired),
        oldLocks: oldLocks([
          {
            model: TODO_MODEL,
            locks: [{ name: 'open', when: { op: 'eq', field: 'done', value: false } }],
          },
        ]),
      }),
    );
    assert.equal(error.code, 'validation');
    // Deterministic validation: phase preserved, no failure row.
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'staged');
    assert.equal(await readFailure(store, 'mig-1'), null);
  });

  it('retry without a failure record fails loud', async () => {
    const { store } = setupMigrationWorld();
    const plan = todoPlan();
    // Hand-written failed phase with no failure evidence (legacy/tests).
    const revision = await store.readRevision();
    await store.stageMigrationRows({
      expectedRevision: revision,
      migrationId: 'mig-1',
      rows: [],
      progress: {
        migrationId: 'mig-1',
        phase: 'failed',
        stagedCursor: null,
        publishCursor: null,
        updatedRevision: revision,
      },
    });
    const error = await captureStateError(() =>
      resumeMigration({ ...resumeBag(store, plan), failedDecision: { decision: 'retry' } }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /no failure record/);
  });

  it('records failures durably through the storage intake', async () => {
    const { store } = setupMigrationWorld();
    const recorded = await recordFailure(store, 'mig-9', 'activation', new Error('flip blew up'), FIXED_NOW);
    assert.equal(recorded.migrationId, 'mig-9');
    assert.equal(recorded.leg, 'activation');
    assert.match(recorded.error, /flip blew up/);
    assert.equal((await store.readMigrationProgress('mig-9'))?.phase, 'failed');
    assert.deepEqual(await readFailure(store, 'mig-9'), recorded);
  });
});

describe('recovery: abort', () => {
  it('pre-flip abort leaves zero staged rows and the prior snapshot active', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [
      { id: 'a', data: { label: 'a', done: true } },
      { id: 'b', data: { label: 'b', done: false } },
    ]);
    const plan = todoPlan();
    await installSnapshot(store, makeInstalled());
    const { oldModels, desiredModels } = todoTables();
    // One partial chunk: staged rows exist, progress is staging.
    await stageNextChunk({
      store,
      plan,
      mappers: new Map([[asModel(TODO_MODEL), priorityMapper()]]),
      oldModels,
      desiredModels,
      chunkSize: 1,
    });
    assert.equal((await store.readStagedRows('mig-1', null, 100)).length, 1);
    const aborted = await abortMigration(store, 'mig-1');
    assert.equal(aborted.aborted, true);
    assert.equal(aborted.progress, null);
    assert.deepEqual(await store.readStagedRows('mig-1', null, 100), []);
    assert.equal(await store.readMigrationProgress('mig-1'), null);
    const installed = await store.readInstalledSnapshot('acme');
    assert.equal(installed?.snapshotId, 'snap-1');
    // Live rows untouched by the aborted staging.
    const live = await store.load(asModel(TODO_MODEL), 'a' as StoredRow['id']);
    assert.deepEqual(live?.data, { label: 'a', done: true });
  });

  it('aborts a staging-leg failure and keeps the failure as audit', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [
      { id: 'a', data: { label: 'a', done: true } },
      { id: 'b', data: { label: 'b', done: false } },
    ]);
    const plan = todoPlan();
    await installSnapshot(store, makeInstalled());
    const { oldModels, desiredModels } = todoTables();
    await stageNextChunk({
      store,
      plan,
      mappers: new Map([[asModel(TODO_MODEL), priorityMapper()]]),
      oldModels,
      desiredModels,
      chunkSize: 1,
    });
    const exploding: MigrationMapper = () => {
      throw new TypeError('boom');
    };
    await assert.rejects(() =>
      resumeMigration(resumeBag(store, plan, new Map([[asModel(TODO_MODEL), exploding]]))),
    );
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'failed');
    const aborted = await abortMigration(store, 'mig-1');
    assert.equal(aborted.aborted, true);
    assert.deepEqual(await store.readStagedRows('mig-1', null, 100), []);
    // The failure record survives the abort as operator audit.
    assert.ok((await readFailure(store, 'mig-1')) !== null);
    assert.equal((await store.readInstalledSnapshot('acme'))?.snapshotId, 'snap-1');
  });

  it('refuses abort once the flip committed (no destructive rollback)', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    await installSnapshot(store, makeInstalled());
    await stageAll(store, plan);
    const { oldModels, desiredModels } = todoTables();
    await activate({
      store,
      plan,
      inventory: [],
      oldModels,
      desiredModels,
      chunkSize: 10,
      clock: fixedClock(),
    });
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'active');
    const error = await captureStateError(() => abortMigration(store, 'mig-1'));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /already active/);
  });

  it('refuses abort mid-publish (forward-only)', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    await installSnapshot(store, makeInstalled());
    await stageAll(store, plan);
    const { oldModels, desiredModels } = todoTables();
    await publishStagedAndDrops(
      store,
      plan,
      oldModels,
      desiredModels,
      10,
      FIXED_NOW,
      'migration:snap-2',
    );
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'publishing');
    const error = await captureStateError(() => abortMigration(store, 'mig-1'));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /forward-only|publishing/);
  });
});
