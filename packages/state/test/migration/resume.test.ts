/**
 * Lane 03 S7 resume tests (engine worker): no-op/active observation,
 * interrupted staging and publish completion without history doubling,
 * idempotent flip reruns, failed-phase gating, and re-validation on the
 * staged path. Memory StoragePort.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ModelName,
  PublishMigrationChunk,
  Revision,
  StoragePort,
  StoredRow,
} from '../../../contracts/src/state.js';
import {
  activate,
  resumeMigration,
  stageNextChunk,
  validateStaged,
  type MigrationMapper,
  type ResumeMigrationInput,
  type ValidatedMigrationPlan,
} from '../../src/migration/index.js';
import { FenceConflictError } from '../../src/storage/port.js';
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
  chunkSize = 10,
): ResumeMigrationInput {
  const { oldModels, desiredModels } = todoTables();
  return {
    store,
    plan,
    mappers: new Map<ModelName, MigrationMapper>([[asModel(TODO_MODEL), priorityMapper()]]),
    oldModels,
    desiredModels,
    oldLocks: oldLocks([]),
    inventory: [],
    chunkSize,
    clock: fixedClock(),
  };
}

/** Stage every chunk, then validate (resume never starts fresh work). */
async function stageAndValidate(store: StoragePort, plan: ValidatedMigrationPlan): Promise<void> {
  const { oldModels, desiredModels } = todoTables();
  for (;;) {
    const result = await stageNextChunk({
      store,
      plan,
      mappers: new Map<ModelName, MigrationMapper>([[asModel(TODO_MODEL), priorityMapper()]]),
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

describe('resume observation', () => {
  it('returns empty when nothing was ever staged', async () => {
    const { store } = setupMigrationWorld();
    const result = await resumeMigration(resumeBag(store, todoPlan()));
    assert.equal(result.progress, null);
    assert.equal(result.flip, null);
    assert.equal(await store.readMigrationProgress('mig-1'), null);
  });

  it('observes active without reflipping', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    await installSnapshot(store, makeInstalled());
    await stageAndValidate(store, plan);
    const { oldModels, desiredModels } = todoTables();
    const flip = await activate({
      store,
      plan,
      inventory: [],
      oldModels,
      desiredModels,
      chunkSize: 10,
      clock: fixedClock(),
    });
    assert.equal(flip.flipped, true);
    const observed = await resumeMigration(resumeBag(store, plan));
    assert.equal(observed.progress?.phase, 'active');
    assert.equal(observed.flip, null);
  });

  it('reruns the flip idempotently with flipped:false', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    await installSnapshot(store, makeInstalled());
    await stageAndValidate(store, plan);
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
    const revision = await store.readRevision();
    const rerun = await store.flipInstalledSnapshot({
      expectedRevision: revision,
      migrationId: 'mig-1',
      owner: 'acme',
      snapshot: {
        owner: 'acme',
        snapshotId: 'snap-2',
        digest: 'digest-2',
        installedRevision: 0 as Revision,
        installedAt: FIXED_NOW,
      },
      renameFromOwner: null,
      invalidatedIntentIds: [],
      outcomes: [],
    });
    assert.equal(rerun.flipped, false);
    assert.equal(rerun.revision as number, revision as number);
  });

  it('demands an operator decision on failed progress', async () => {
    const { store } = setupMigrationWorld();
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
        updatedRevision: (revision as number + 1) as Revision,
      },
    });
    const error = await captureStateError(() => resumeMigration(resumeBag(store, todoPlan())));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /operator decision/);
  });
});

describe('resume staging', () => {
  it('completes interrupted staging and validates', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [
      { id: 'a', data: { label: 'a', done: true } },
      { id: 'b', data: { label: 'b', done: false } },
      { id: 'c', data: { label: 'c', done: true } },
    ]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    // Interrupt after the first chunk (cursor at `a`).
    await stageNextChunk({
      store,
      plan,
      mappers: resumeBag(store, plan, 1).mappers,
      oldModels,
      desiredModels,
      chunkSize: 1,
    });
    let progress = await store.readMigrationProgress('mig-1');
    assert.equal(progress?.phase, 'staging');
    // Resume one chunk per call; the exhausting call also validates.
    const first = await resumeMigration(resumeBag(store, plan, 1));
    assert.equal(first.progress?.phase, 'staging');
    const second = await resumeMigration(resumeBag(store, plan, 1));
    assert.equal(second.progress?.phase, 'staged');
    assert.equal(second.flip, null);
    const staged = await store.readStagedRows('mig-1', null, 100);
    assert.equal(staged.length, 3);
    progress = await store.readMigrationProgress('mig-1');
    assert.deepEqual(progress?.stagedCursor, { model: TODO_MODEL, recordId: 'c' });
  });

  it('re-validates an already-staged set idempotently', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    await stageAndValidate(store, plan);
    const first = await resumeMigration(resumeBag(store, plan));
    assert.equal(first.progress?.phase, 'staged');
    const second = await resumeMigration(resumeBag(store, plan));
    assert.equal(second.progress?.phase, 'staged');
    assert.equal(second.flip, null);
    const staged = await store.readStagedRows('mig-1', null, 100);
    assert.equal(staged.length, 1);
  });

  it('fails validation from resume without advancing phase', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: false } }]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    // Mapper unlocks a protected row: lock `done == false` matches live,
    // but the staged row flips done to true.
    const unlocking: MigrationMapper = (_before, row) => {
      row.set('done', true);
      row.set('priority', 'low');
    };
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: new Map([[asModel(TODO_MODEL), unlocking]]),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    const bag = resumeBag(store, plan);
    const error = await captureStateError(() =>
      resumeMigration({
        ...bag,
        mappers: new Map([[asModel(TODO_MODEL), unlocking]]),
        oldLocks: oldLocks([
          {
            model: TODO_MODEL,
            locks: [{ name: 'open', when: { op: 'eq', field: 'done', value: false } }],
          },
        ]),
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /unlocks protected row/);
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'staging');
  });
});

describe('resume publishing', () => {
  it('completes an interrupted publish without doubling history', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [
      { id: 'a', data: { label: 'a', done: true } },
      { id: 'b', data: { label: 'b', done: false } },
      { id: 'c', data: { label: 'c', done: true } },
    ]);
    const plan = todoPlan();
    await installSnapshot(store, makeInstalled());
    const { oldModels, desiredModels } = todoTables();
    const mappers = new Map<ModelName, MigrationMapper>([[asModel(TODO_MODEL), priorityMapper()]]);
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers,
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
    // Fault injection around the REAL adapter: the second publish chunk
    // loses the fence, aborting activation mid-publish.
    let publishes = 0;
    const flaky: StoragePort = {
      ...store,
      publishMigrationChunk(input: PublishMigrationChunk) {
        publishes += 1;
        if (publishes === 2) {
          throw new FenceConflictError(input.expectedRevision, input.expectedRevision);
        }
        return store.publishMigrationChunk(input);
      },
    };
    const busy = await captureStateError(() =>
      activate({
        store: flaky,
        plan,
        inventory: [],
        oldModels,
        desiredModels,
        chunkSize: 1,
        clock: fixedClock(),
      }),
    );
    assert.equal(busy.code, 'busy');
    const interrupted = await store.readMigrationProgress('mig-1');
    assert.equal(interrupted?.phase, 'publishing');
    assert.deepEqual(interrupted?.publishCursor, { model: TODO_MODEL, recordId: 'a' });
    // Resume on the plain store completes publish plus the flip.
    const resumed = await resumeMigration(resumeBag(store, plan, 1));
    assert.equal(resumed.flip?.flipped, true);
    assert.equal(resumed.progress?.phase, 'active');
    for (const id of ['a', 'b', 'c']) {
      const live = await store.load(asModel(TODO_MODEL), id as StoredRow['id']);
      assert.equal(live?.version as number, 2);
      const history = await store.historyFor(asModel(TODO_MODEL), id as StoredRow['id']);
      assert.equal(history.length, 1);
      assert.equal(history[0]?.change, 'update');
    }
  });

  it('fails loud when a resumed flip commits nothing', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    await installSnapshot(store, makeInstalled());
    await stageAndValidate(store, plan);
    // Force publishing (as an interrupted run would leave it).
    const staged = await store.readMigrationProgress('mig-1');
    const revision = await store.readRevision();
    await store.stageMigrationRows({
      expectedRevision: revision,
      migrationId: 'mig-1',
      rows: [],
      progress: {
        migrationId: 'mig-1',
        phase: 'publishing',
        stagedCursor: staged?.stagedCursor ?? null,
        publishCursor: null,
        updatedRevision: (revision as number + 1) as Revision,
      },
    });
    // Fault injection around the REAL adapter: the flip reports a no-op
    // (only out-of-band surgery reaches this past the evidence gate).
    const lying: StoragePort = {
      ...store,
      async flipInstalledSnapshot() {
        return { revision: await store.readRevision(), flipped: false };
      },
    };
    const error = await captureStateError(() => resumeMigration(resumeBag(lying, plan, 1)));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /committed nothing/);
    // Still publishing, skips/outcomes unrecorded: no silent success.
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'publishing');
    assert.deepEqual(await store.readMigrationOutcomes('mig-1'), []);
  });
});
