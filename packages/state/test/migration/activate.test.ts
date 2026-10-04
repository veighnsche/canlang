/**
 * Lane 03 S7 activation tests (engine worker + coordinator F-fixes):
 * preconditions, dropOwner removal, chunked publish, history vocabulary,
 * drops, rename-source disposal, claim moves, pointer flip, and clock
 * freezing. Memory StoragePort.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ModelName,
  Revision,
  StoragePort,
  StoredRow,
  WorkInventoryItem,
} from '../../../contracts/src/state.js';
import { buildModelTable } from '../../src/mutation/index.js';
import {
  activate,
  stageNextChunk,
  validateStaged,
  validateTransition,
  type MigrationMapper,
  type ValidatedMigrationPlan,
} from '../../src/migration/index.js';
import { StorageConstraintError } from '../../src/storage/port.js';
import {
  TODO_MODEL,
  asModel,
  captureStateError,
  desiredTodoDef,
  field,
  fixedClock,
  installSnapshot,
  makeBatch,
  makeInstalled,
  makeRow,
  makeTransition,
  modelDef,
  oldLocks,
  oldTodoDef,
  seedLive,
  setupMigrationWorld,
  todoDirectives,
  todoPlan,
  todoTables,
} from './fixtures.js';

const TASK = 'acme.Task';
const GONE = 'acme.Gone';

/** Todo backfill mapper shared by activation setups. */
function priorityMapper(): MigrationMapper {
  return (before, row) => {
    row.set('priority', before.data['done'] === true ? 'low' : 'normal');
  };
}

/** Stage every chunk, then validate (leaves progress `staged`). */
async function stageAndValidate(
  store: StoragePort,
  plan: ValidatedMigrationPlan,
  mappers: ReadonlyMap<ModelName, MigrationMapper>,
  chunkSize = 10,
): Promise<void> {
  const { oldModels, desiredModels } = todoTables();
  for (;;) {
    const result = await stageNextChunk({
      store,
      plan,
      mappers,
      oldModels,
      desiredModels,
      chunkSize,
    });
    if (result.done) {
      break;
    }
  }
  await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
}

async function todoMappers(): Promise<ReadonlyMap<ModelName, MigrationMapper>> {
  return new Map([[asModel(TODO_MODEL), priorityMapper()]]);
}

describe('activation preconditions', () => {
  it('blocks activation with no staged state', async () => {
    const { store } = setupMigrationWorld();
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const error = await captureStateError(() =>
      activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 10, clock: fixedClock() }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /no staged state/);
  });

  it('blocks activation from a staging set', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    await stageNextChunk({
      store,
      plan,
      mappers: await todoMappers(),
      oldModels,
      desiredModels,
      chunkSize: 10,
    });
    const error = await captureStateError(() =>
      activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 10, clock: fixedClock() }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /needs a staged set/);
  });

  it('blocks re-entering activation from a publishing set', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    await stageAndValidate(store, plan, await todoMappers());
    // One honest publish chunk moves progress to `publishing`.
    const staged = await store.readStagedRows('mig-1', null, 10);
    const revision = await store.readRevision();
    await store.publishMigrationChunk({
      expectedRevision: revision,
      migrationId: 'mig-1',
      rows: staged,
      history: [],
      drops: [],
      progress: {
        migrationId: 'mig-1',
        phase: 'publishing',
        stagedCursor: { model: TODO_MODEL, recordId: 'a' },
        publishCursor: { model: TODO_MODEL, recordId: 'a' },
        updatedRevision: (revision as number + 1) as Revision,
      },
    });
    const error = await captureStateError(() =>
      activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 10, clock: fixedClock() }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /needs a staged set/);
  });

  it('blocks re-entering activation once active', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    await installSnapshot(store, makeInstalled());
    const { oldModels, desiredModels } = todoTables();
    await stageAndValidate(store, plan, await todoMappers());
    const first = await activate({
      store,
      plan,
      inventory: [],
      oldModels,
      desiredModels,
      chunkSize: 10,
      clock: fixedClock(),
    });
    assert.equal(first.flipped, true);
    const error = await captureStateError(() =>
      activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 10, clock: fixedClock() }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /needs a staged set/);
  });

  it('blocks activation of a failed migration', async () => {
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
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const error = await captureStateError(() =>
      activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 10, clock: fixedClock() }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /operator decision/);
  });

  it('removes the owner pointer and disposes rows on dropOwner', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    // Installed predecessor evidence (dropOwner removes a REAL install).
    const installedAt = await store.readRevision();
    await store.flipInstalledSnapshot({
      expectedRevision: installedAt,
      migrationId: 'mig-0',
      owner: 'acme',
      snapshot: {
        owner: 'acme',
        snapshotId: 'snap-1',
        digest: 'digest-1',
        installedRevision: 0 as Revision,
        installedAt: fixedClock().nowMs(),
      },
      renameFromOwner: null,
      invalidatedIntentIds: [],
      outcomes: [],
    });
    const { oldModels } = todoTables();
    const desiredModels = buildModelTable([]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: [{ kind: 'dropOwner' }] }),
      oldModels,
      desiredModels,
    );
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: new Map(),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
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
    // Rows disposed with remove-history, pointer removed (removal flip).
    assert.equal(await store.load(asModel(TODO_MODEL), 'a' as StoredRow['id']), null);
    const dropHistory = await store.historyFor(asModel(TODO_MODEL), 'a' as StoredRow['id']);
    assert.equal(dropHistory.length, 1);
    assert.equal(dropHistory[0]?.change, 'remove');
    assert.equal(dropHistory[0]?.actor, 'migration:snap-2');
    assert.equal(await store.readInstalledSnapshot('acme'), null);
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'active');
  });

  it('blocks dropOwner removal with no installed pointer evidence', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    // NOTE: no pointer installed — the stored predecessor is missing even
    // though validation (caller-supplied snapshot) passes.
    const { oldModels } = todoTables();
    const desiredModels = buildModelTable([]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: [{ kind: 'dropOwner' }] }),
      oldModels,
      desiredModels,
    );
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: new Map(),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
    const error = await captureStateError(() =>
      activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 10, clock: fixedClock() }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /missing predecessor evidence/);
    // Nothing published, nothing flipped: rows live, no active mark.
    assert.ok((await store.load(asModel(TODO_MODEL), 'a' as StoredRow['id'])) !== null);
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'staged');
  });

  it('blocks mismatched model tables', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    await stageAndValidate(store, plan, await todoMappers());
    const error = await captureStateError(() =>
      activate({
        store,
        plan,
        inventory: [],
        oldModels,
        desiredModels: buildModelTable([]),
        chunkSize: 10,
        clock: fixedClock(),
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /disagree/);
    void desiredModels;
  });

  it('blocks malformed inventory', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    await stageAndValidate(store, plan, await todoMappers());
    const error = await captureStateError(() =>
      activate({
        store,
        plan,
        inventory: [{ intentId: '', handlerContract: 'c', state: 'undispatched' }],
        oldModels,
        desiredModels,
        chunkSize: 10,
        clock: fixedClock(),
      }),
    );
    assert.equal(error.code, 'validation');
  });

  it('blocks activation when another migration installed our target', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    // Deployer mis-schedule: another migration installs OUR target first.
    await installSnapshot(store, makeInstalled({ snapshotId: 'snap-2', digest: 'digest-2' }), 'mig-other');
    const { oldModels, desiredModels } = todoTables();
    await stageAndValidate(store, plan, await todoMappers());
    const error = await captureStateError(() =>
      activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 10, clock: fixedClock() }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /predecessor changed under us/);
    // The evidence gate runs before any row moves: old shape and version.
    const live = await store.load(asModel(TODO_MODEL), 'a' as StoredRow['id']);
    assert.deepEqual(live?.data, { label: 'a', done: true });
    assert.equal(live?.version as number, 1);
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'staged');
  });

  it('blocks activation when the predecessor pointer vanishes', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    await installSnapshot(store, makeInstalled());
    const { oldModels, desiredModels } = todoTables();
    await stageAndValidate(store, plan, await todoMappers());
    // Out-of-band removal between validation and activation.
    const revision = await store.readRevision();
    const removed = await store.flipInstalledSnapshot({
      expectedRevision: revision,
      migrationId: 'mig-other',
      owner: 'acme',
      snapshot: null,
      renameFromOwner: null,
      invalidatedIntentIds: [],
      outcomes: [],
    });
    assert.equal(removed.flipped, true);
    const error = await captureStateError(() =>
      activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 10, clock: fixedClock() }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /missing predecessor evidence/);
    assert.ok((await store.load(asModel(TODO_MODEL), 'a' as StoredRow['id'])) !== null);
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'staged');
  });

  it('blocks an owner rename onto an installed owner name', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const { oldModels, desiredModels } = todoTables();
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({
        owner: 'acme2',
        directives: [...todoDirectives(), { kind: 'renameOwner', from: 'acme' }],
      }),
      oldModels,
      desiredModels,
    );
    await installSnapshot(store, makeInstalled());
    await installSnapshot(
      store,
      makeInstalled({ owner: 'acme2', snapshotId: 'snap-9', digest: 'digest-9' }),
      'mig-seed-2',
    );
    await stageAndValidate(store, plan, await todoMappers());
    const error = await captureStateError(() =>
      activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 10, clock: fixedClock() }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /already installed/);
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'staged');
  });

  it('fails loud when the flip commits nothing', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    await installSnapshot(store, makeInstalled());
    const { oldModels, desiredModels } = todoTables();
    await stageAndValidate(store, plan, await todoMappers());
    // Fault injection around the REAL adapter: the flip reports a no-op
    // (only out-of-band surgery reaches this past the evidence gate).
    const lying: StoragePort = {
      ...store,
      async flipInstalledSnapshot() {
        return { revision: await store.readRevision(), flipped: false };
      },
    };
    const error = await captureStateError(() =>
      activate({ store: lying, plan, inventory: [], oldModels, desiredModels, chunkSize: 10, clock: fixedClock() }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /committed nothing/);
    // Publish ran (conversion applied), the flip refused: resume territory.
    const live = await store.load(asModel(TODO_MODEL), 'a' as StoredRow['id']);
    assert.equal(live?.version as number, 2);
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'publishing');
  });

  it('blocks a removal flip when the pointer vanishes mid-activation', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const { oldModels } = todoTables();
    const desiredModels = buildModelTable([]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: [{ kind: 'dropOwner' }] }),
      oldModels,
      desiredModels,
    );
    await installSnapshot(store, makeInstalled());
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: new Map(),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
    // Fault injection around the REAL adapter: the pointer reads present
    // for the publish-start evidence gate, then vanishes before the flip.
    let reads = 0;
    const racing: StoragePort = {
      ...store,
      async readInstalledSnapshot(owner: string) {
        reads += 1;
        if (reads === 1) {
          return store.readInstalledSnapshot(owner);
        }
        return null;
      },
    };
    const error = await captureStateError(() =>
      activate({ store: racing, plan, inventory: [], oldModels, desiredModels, chunkSize: 10, clock: fixedClock() }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /missing predecessor evidence/);
    assert.equal(reads, 2);
    // Publish disposed the rows, the removal flip refused: no silent
    // skip/outcome loss, and resume retries from publishing.
    assert.equal(await store.load(asModel(TODO_MODEL), 'a' as StoredRow['id']), null);
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'publishing');
  });
});

describe('activation publish and flip', () => {
  it('publishes conversions in chunks with migration history', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [
      { id: 'a', data: { label: 'a', done: true, legacy: 'x' } },
      { id: 'b', data: { label: 'b', done: false } },
      { id: 'c', data: { label: 'c', done: true } },
    ]);
    const plan = todoPlan();
    await installSnapshot(store, makeInstalled());
    const { oldModels, desiredModels } = todoTables();
    await stageAndValidate(store, plan, await todoMappers());
    const flip = await activate({
      store,
      plan,
      inventory: [],
      oldModels,
      desiredModels,
      chunkSize: 1,
      clock: fixedClock(),
    });
    assert.equal(flip.flipped, true);
    for (const id of ['a', 'b', 'c']) {
      const live = await store.load(asModel(TODO_MODEL), id as StoredRow['id']);
      assert.ok(live !== null);
      assert.equal(live?.version as number, 2);
    }
    const history = await store.historyFor(asModel(TODO_MODEL), 'a' as StoredRow['id']);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.change, 'update');
    assert.equal(history[0]?.version as number, 2);
    assert.equal(history[0]?.actor, 'migration:snap-2');
    assert.equal(history[0]?.operation as string, 'mig-1');
    assert.equal(history[0]?.operationId as string, 'mig-1');
    assert.deepEqual(history[0]?.before, { label: 'a', done: true, legacy: 'x' });
    assert.deepEqual(history[0]?.after, { title: 'a', done: true, priority: 'low' });
    const progress = await store.readMigrationProgress('mig-1');
    assert.equal(progress?.phase, 'active');
  });

  it('installs the snapshot pointer with the actual flip revision', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    await installSnapshot(store, makeInstalled());
    const { oldModels, desiredModels } = todoTables();
    await stageAndValidate(store, plan, await todoMappers());
    const flip = await activate({
      store,
      plan,
      inventory: [],
      oldModels,
      desiredModels,
      chunkSize: 10,
      clock: fixedClock(),
    });
    const installed = await store.readInstalledSnapshot('acme');
    assert.ok(installed !== null);
    assert.equal(installed?.owner, 'acme');
    assert.equal(installed?.snapshotId, 'snap-2');
    assert.equal(installed?.digest, 'digest-2');
    // The adapter overwrites the engine's 0 placeholder with the commit.
    assert.equal(installed?.installedRevision as number, flip.revision as number);
    assert.notEqual(installed?.installedRevision as number, 0);
  });

  it('freezes one engine clock across history and installedAt', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    await installSnapshot(store, makeInstalled());
    const { oldModels, desiredModels } = todoTables();
    await stageAndValidate(store, plan, await todoMappers());
    await activate({
      store,
      plan,
      inventory: [],
      oldModels,
      desiredModels,
      chunkSize: 10,
      clock: { nowMs: () => 12345 },
    });
    const history = await store.historyFor(asModel(TODO_MODEL), 'a' as StoredRow['id']);
    assert.equal(history[0]?.at, 12345);
    const installed = await store.readInstalledSnapshot('acme');
    assert.equal(installed?.installedAt, 12345);
  });

  it('removes drops with remove-history and preserves the archive flag', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    await seedLive(store, GONE, [
      { id: 'g', data: { n: 1 }, archivedAt: 777, version: 4 },
    ]);
    const oldModels = buildModelTable([
      oldTodoDef(),
      modelDef(GONE, { fields: { n: field() } }),
    ]);
    const desiredModels = buildModelTable([desiredTodoDef()]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: [...todoDirectives(), { kind: 'dropModel', model: GONE }] }),
      oldModels,
      desiredModels,
    );
    await installSnapshot(store, makeInstalled());
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: await todoMappers(),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
    await activate({
      store,
      plan,
      inventory: [],
      oldModels,
      desiredModels,
      chunkSize: 10,
      clock: fixedClock(),
    });
    assert.equal(await store.load(asModel(GONE), 'g' as StoredRow['id']), null);
    const dropHistory = await store.historyFor(asModel(GONE), 'g' as StoredRow['id']);
    assert.equal(dropHistory.length, 1);
    assert.equal(dropHistory[0]?.change, 'remove');
    assert.equal(dropHistory[0]?.actor, 'migration:snap-2');
    assert.deepEqual(dropHistory[0]?.before, { n: 1 });
    assert.equal(dropHistory[0]?.after, null);
    // Conversions preserve archive state through publish.
    const live = await store.load(asModel(TODO_MODEL), 'a' as StoredRow['id']);
    assert.deepEqual(live?.data, { title: 'a', done: true, priority: 'low' });
  });

  it('blocks drops when the expiry backlog is unfinished', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    await seedLive(store, GONE, [{ id: 'g', data: { n: 1 } }]);
    const oldModels = buildModelTable([
      oldTodoDef(),
      modelDef(GONE, { fields: { n: field() } }),
    ]);
    const desiredModels = buildModelTable([desiredTodoDef()]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: [...todoDirectives(), { kind: 'dropModel', model: GONE }] }),
      oldModels,
      desiredModels,
    );
    await installSnapshot(store, makeInstalled());
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: await todoMappers(),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
    const error = await captureStateError(() =>
      activate({
        store,
        plan,
        inventory: [],
        oldModels,
        desiredModels,
        chunkSize: 10,
        clock: fixedClock(),
        isExpiredRow: (row) => (row.id as string) === 'g',
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /Cannot drop expired row/);
    // Fail fast: the pre-scan runs before anything publishes.
    assert.ok((await store.load(asModel(GONE), 'g' as StoredRow['id'])) !== null);
    const live = await store.load(asModel(TODO_MODEL), 'a' as StoredRow['id']);
    assert.equal(live?.version as number, 1);
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'staged');
  });

  it('publishes name-only renames with no history', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', version: 3, data: { label: 'x' } }]);
    const oldModels = buildModelTable([modelDef(TODO_MODEL, { fields: { label: field() } })]);
    const desiredModels = buildModelTable([modelDef(TASK, { fields: { label: field() } })]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: [{ kind: 'renameModel', from: TODO_MODEL, to: TASK }] }),
      oldModels,
      desiredModels,
    );
    await installSnapshot(store, makeInstalled());
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: new Map(),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
    await activate({
      store,
      plan,
      inventory: [],
      oldModels,
      desiredModels,
      chunkSize: 10,
      clock: fixedClock(),
    });
    const live = await store.load(asModel(TASK), 'a' as StoredRow['id']);
    assert.ok(live !== null);
    assert.equal(live?.version as number, 3);
    assert.deepEqual(await store.historyFor(asModel(TASK), 'a' as StoredRow['id']), []);
    // A rename is a move, not a copy: the source row is disposed in the
    // same chunk with a `remove` entry chaining the audit trail, while
    // pre-rename history stays queryable under the source model name.
    assert.equal(await store.load(asModel(TODO_MODEL), 'a' as StoredRow['id']), null);
    const sourceHistory = await store.historyFor(asModel(TODO_MODEL), 'a' as StoredRow['id']);
    assert.equal(sourceHistory.length, 1);
    assert.equal(sourceHistory[0]?.change, 'remove');
    assert.equal(sourceHistory[0]?.actor, 'migration:snap-2');
    assert.deepEqual(sourceHistory[0]?.before, { label: 'x' });
    assert.equal(sourceHistory[0]?.after, null);
  });

  it('moves unique claims atomically with a model rename', async () => {
    const { store } = setupMigrationWorld();
    const oldModels = buildModelTable([
      modelDef(TODO_MODEL, { fields: { slug: field({ required: true }) }, uniqueKeys: ['slug'] }),
    ]);
    const desiredModels = buildModelTable([
      modelDef(TASK, { fields: { slug: field({ required: true }) }, uniqueKeys: ['slug'] }),
    ]);
    // Live rows WITH their old-model claims, as a real deployment holds.
    for (const slug of ['a', 'b']) {
      const row = makeRow({ id: `r-${slug}`, data: { slug } });
      const revision = await store.readRevision();
      await store.commit(
        makeBatch(revision as number, {
          writes: [{ kind: 'insert', model: asModel(TODO_MODEL), row }],
          uniqueClaims: [
            {
              model: asModel(TODO_MODEL),
              keyName: 'slug',
              keyValue: slug,
              recordId: row.id,
            },
          ],
        }),
      );
    }
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: [{ kind: 'renameModel', from: TODO_MODEL, to: TASK }] }),
      oldModels,
      desiredModels,
    );
    await installSnapshot(store, makeInstalled());
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: new Map(),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
    await activate({
      store,
      plan,
      inventory: [],
      oldModels,
      desiredModels,
      chunkSize: 10,
      clock: fixedClock(),
    });
    // New-model claims hold: reclaiming one conflicts.
    const revision = await store.readRevision();
    await assert.rejects(
      () =>
        store.commit(
          makeBatch(revision as number, {
            writes: [
              {
                kind: 'insert',
                model: asModel(TASK),
                row: makeRow({ id: 'r-new', data: { slug: 'a' } }),
              },
            ],
            uniqueClaims: [
              {
                model: asModel(TASK),
                keyName: 'slug',
                keyValue: 'a',
                recordId: 'r-new' as StoredRow['id'],
              },
            ],
          }),
        ),
      (error: unknown) => error instanceof StorageConstraintError && error.kind === 'unique',
    );
    // Rename sources disposed with `remove` history (move, not copy).
    for (const slug of ['a', 'b']) {
      assert.equal(await store.load(asModel(TODO_MODEL), `r-${slug}` as StoredRow['id']), null);
      const moved = await store.historyFor(asModel(TODO_MODEL), `r-${slug}` as StoredRow['id']);
      assert.equal(moved.length, 1);
      assert.equal(moved[0]?.change, 'remove');
      assert.equal(moved[0]?.actor, 'migration:snap-2');
    }
    // Old-model claims released: the old key reclaims cleanly.
    const revision2 = await store.readRevision();
    await store.commit(
      makeBatch(revision2 as number, {
        writes: [
          { kind: 'insert', model: asModel(TODO_MODEL), row: makeRow({ id: 'r-old', data: {} }) },
        ],
        uniqueClaims: [
          {
            model: asModel(TODO_MODEL),
            keyName: 'slug',
            keyValue: 'a',
            recordId: 'r-old' as StoredRow['id'],
          },
        ],
      }),
    );
  });

  it('moves claims on same-model value changes and releases drop claims', async () => {
    const { store } = setupMigrationWorld();
    const oldModels = buildModelTable([
      modelDef(TODO_MODEL, { fields: { slug: field({ required: true }) }, uniqueKeys: ['slug'] }),
      modelDef(GONE, { fields: { code: field({ required: true }) }, uniqueKeys: ['code'] }),
    ]);
    const desiredModels = buildModelTable([
      modelDef(TODO_MODEL, { fields: { slug: field({ required: true }) }, uniqueKeys: ['slug'] }),
    ]);
    const seedClaimed = async (
      model: string,
      id: string,
      keyName: string,
      keyValue: string,
    ): Promise<void> => {
      const row = makeRow({ id, data: { [keyName]: keyValue } });
      const revision = await store.readRevision();
      await store.commit(
        makeBatch(revision as number, {
          writes: [{ kind: 'insert', model: asModel(model), row }],
          uniqueClaims: [
            { model: asModel(model), keyName, keyValue, recordId: row.id },
          ],
        }),
      );
    };
    await seedClaimed(TODO_MODEL, 'r-1', 'slug', 'a');
    await seedClaimed(GONE, 'g-1', 'code', 'z');
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({
        directives: [
          { kind: 'backfill', model: TODO_MODEL },
          { kind: 'dropModel', model: GONE },
        ],
      }),
      oldModels,
      desiredModels,
    );
    await installSnapshot(store, makeInstalled());
    const mapper: MigrationMapper = (_before, row) => {
      row.set('slug', 'b');
    };
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: new Map([[asModel(TODO_MODEL), mapper]]),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
    await activate({
      store,
      plan,
      inventory: [],
      oldModels,
      desiredModels,
      chunkSize: 10,
      clock: fixedClock(),
    });
    // New value claimed, old value freed, drop claim freed.
    const revision = await store.readRevision();
    await assert.rejects(
      () =>
        store.commit(
          makeBatch(revision as number, {
            uniqueClaims: [
              {
                model: asModel(TODO_MODEL),
                keyName: 'slug',
                keyValue: 'b',
                recordId: 'r-x' as StoredRow['id'],
              },
            ],
          }),
        ),
      (error: unknown) => error instanceof StorageConstraintError && error.kind === 'unique',
    );
    const revision2 = await store.readRevision();
    await store.commit(
      makeBatch(revision2 as number, {
        uniqueClaims: [
          {
            model: asModel(TODO_MODEL),
            keyName: 'slug',
            keyValue: 'a',
            recordId: 'r-y' as StoredRow['id'],
          },
          {
            model: asModel(GONE),
            keyName: 'code',
            keyValue: 'z',
            recordId: 'g-y' as StoredRow['id'],
          },
        ],
      }),
    );
  });

  it('conflicts deterministically on cross-chunk unique swaps', async () => {
    const { store } = setupMigrationWorld();
    const oldModels = buildModelTable([
      modelDef(TODO_MODEL, { fields: { slug: field({ required: true }) }, uniqueKeys: ['slug'] }),
    ]);
    const desiredModels = buildModelTable([
      modelDef(TODO_MODEL, { fields: { slug: field({ required: true }) }, uniqueKeys: ['slug'] }),
    ]);
    const seedClaimed = async (id: string, slug: string): Promise<void> => {
      const row = makeRow({ id, data: { slug } });
      const revision = await store.readRevision();
      await store.commit(
        makeBatch(revision as number, {
          writes: [{ kind: 'insert', model: asModel(TODO_MODEL), row }],
          uniqueClaims: [{ model: asModel(TODO_MODEL), keyName: 'slug', keyValue: slug, recordId: row.id }],
        }),
      );
    };
    await seedClaimed('r-1', 'a');
    await seedClaimed('r-2', 'b');
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: [{ kind: 'backfill', model: TODO_MODEL }] }),
      oldModels,
      desiredModels,
    );
    await installSnapshot(store, makeInstalled());
    // Each mapper swaps its OWN slug (before-only, no cross-row reads);
    // the staged set stays unique, so validation passes.
    const mapper: MigrationMapper = (before, row) => {
      row.set('slug', before.data['slug'] === 'a' ? 'b' : 'a');
    };
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: new Map([[asModel(TODO_MODEL), mapper]]),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
    // Chunk 1 (r-1: a→b) claims 'b' while r-2 still holds it: the storage
    // unique constraint rejects the chunk — loudly, deterministically.
    const error = await captureStateError(() =>
      activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 1, clock: fixedClock() }),
    );
    assert.equal(error.code, 'conflict');
    // The failed chunk applied nothing: live rows and progress untouched.
    const first = await store.load(asModel(TODO_MODEL), 'r-1' as StoredRow['id']);
    assert.deepEqual(first?.data, { slug: 'a' });
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'staged');
  });

  it('removes the renamed-away owner pointer on owner rename', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const { oldModels, desiredModels } = todoTables();
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({
        owner: 'acme2',
        directives: [...todoDirectives(), { kind: 'renameOwner', from: 'acme' }],
      }),
      oldModels,
      desiredModels,
    );
    await installSnapshot(store, makeInstalled());
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: await todoMappers(),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
    await activate({
      store,
      plan,
      inventory: [],
      oldModels,
      desiredModels,
      chunkSize: 10,
      clock: fixedClock(),
    });
    const installed = await store.readInstalledSnapshot('acme2');
    assert.ok(installed !== null);
    assert.equal(installed?.snapshotId, 'snap-2');
    assert.equal(await store.readInstalledSnapshot('acme'), null);
  });

  it('accepts an empty inventory with no invalidates', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    await installSnapshot(store, makeInstalled());
    const { oldModels, desiredModels } = todoTables();
    await stageAndValidate(store, plan, await todoMappers());
    const flip = await activate({
      store,
      plan,
      inventory: [] as WorkInventoryItem[],
      oldModels,
      desiredModels,
      chunkSize: 10,
      clock: fixedClock(),
    });
    assert.equal(flip.flipped, true);
    assert.deepEqual(await store.readMigrationOutcomes('mig-1'), []);
  });
});
