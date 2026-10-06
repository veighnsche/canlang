/**
 * Lane 03 S7 staging tests (engine worker): structural mapping,
 * backfill mappers, chunk cursors, expiry/archive handling, mapper
 * contracts, and staging failure modes. Memory StoragePort, no mocks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ModelName,
  Revision,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import { buildModelTable } from '../../src/mutation/index.js';
import {
  stageNextChunk,
  validateMappedRow,
  validateStaged,
  validateTransition,
  type MigrationMapper,
  type ValidatedMigrationPlan,
} from '../../src/migration/index.js';
import { StateError } from '../../src/errors.js';
import {
  TODO_MODEL,
  asId,
  asModel,
  asVersion,
  captureStateError,
  desiredTodoDef,
  field,
  makeInstalled,
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

/** Todo backfill mapper: priority from completion (reads seeded title). */
function priorityMapper(seen: { title?: unknown; archived?: boolean } = {}): MigrationMapper {
  return (before, row) => {
    seen.title = row.get('title');
    seen.archived = before.archived;
    row.set('priority', before.data['done'] === true ? 'low' : 'normal');
  };
}

function mappersFor(plan: ValidatedMigrationPlan, mapper: MigrationMapper) {
  void plan;
  return new Map<ModelName, MigrationMapper>([[asModel(TODO_MODEL), mapper]]);
}

describe('staging happy path', () => {
  it('stages rename/backfill/drop rows with conversion versions', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [
      { id: 'a', data: { label: 'first', done: true, legacy: 'x' } },
      { id: 'b', data: { label: 'second', done: false } },
    ]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const seen: { title?: unknown; archived?: boolean } = {};
    const result = await stageNextChunk({
      store,
      plan,
      mappers: mappersFor(plan, priorityMapper(seen)),
      oldModels,
      desiredModels,
      chunkSize: 10,
    });
    assert.equal(result.done, true);
    assert.equal(result.progress.phase, 'staging');
    assert.deepEqual(result.progress.stagedCursor, { model: TODO_MODEL, recordId: 'b' });
    assert.equal(seen.title, 'second');
    assert.equal(seen.archived, false);
    const staged = await store.readStagedRows('mig-1', null, 100);
    assert.equal(staged.length, 2);
    assert.deepEqual(staged[0]?.data, { title: 'first', done: true, priority: 'low' });
    assert.equal(staged[0]?.converted, true);
    assert.equal(staged[0]?.version as number, 2);
    assert.deepEqual(staged[1]?.data, { title: 'second', done: false, priority: 'normal' });
    assert.equal(staged[1]?.parent, null);
  });

  it('copies creation metadata and archive state onto staged rows', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [
      { id: 'a', data: { label: 'kept', done: false }, archivedAt: 999, createdBy: 'user-bea' },
    ]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const seen: { title?: unknown; archived?: boolean } = {};
    await stageNextChunk({
      store,
      plan,
      mappers: mappersFor(plan, priorityMapper(seen)),
      oldModels,
      desiredModels,
      chunkSize: 10,
    });
    assert.equal(seen.archived, true);
    const staged = await store.readStagedRows('mig-1', null, 100);
    assert.equal(staged.length, 1);
    assert.equal(staged[0]?.archivedAt, 999);
    assert.equal(staged[0]?.createdBy, 'user-bea');
    assert.ok(typeof staged[0]?.created === 'number');
  });

  it('stages name-only renames with preserved versions', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', version: 3, data: { label: 'x' } }]);
    const oldModels = buildModelTable([
      modelDef(TODO_MODEL, { fields: { label: field() } }),
    ]);
    const desiredModels = buildModelTable([modelDef(TASK, { fields: { label: field() } })]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: [{ kind: 'renameModel', from: TODO_MODEL, to: TASK }] }),
      oldModels,
      desiredModels,
    );
    const result = await stageNextChunk({
      store,
      plan,
      mappers: new Map(),
      oldModels,
      desiredModels,
      chunkSize: 10,
    });
    assert.equal(result.done, true);
    const staged = await store.readStagedRows('mig-1', null, 100);
    assert.equal(staged.length, 1);
    assert.equal(staged[0]?.targetModel as string, TASK);
    assert.equal(staged[0]?.version as number, 3);
    assert.equal(staged[0]?.converted, false);
  });

  it('treats field drops as conversions without a mapper', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'x', done: true, legacy: 'gone' } }]);
    const { oldModels } = todoTables();
    const desiredModels = buildModelTable([
      modelDef(TODO_MODEL, { fields: { label: field({ required: true }), done: field({ required: true }) } }),
    ]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: [{ kind: 'dropField', model: TODO_MODEL, field: 'legacy' }] }),
      oldModels,
      desiredModels,
    );
    await stageNextChunk({ store, plan, mappers: new Map(), oldModels, desiredModels, chunkSize: 10 });
    const staged = await store.readStagedRows('mig-1', null, 100);
    assert.equal(staged.length, 1);
    assert.deepEqual(staged[0]?.data, { label: 'x', done: true });
    assert.equal(staged[0]?.converted, true);
    assert.equal(staged[0]?.version as number, 2);
  });

  it('skips pure retains and dropped models', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'x', done: true, legacy: 'y' } }]);
    await seedLive(store, 'acme.Kept', [{ id: 'k', data: { n: 1 } }]);
    await seedLive(store, 'acme.Gone', [{ id: 'g', data: { n: 2 } }]);
    const oldModels = buildModelTable([
      oldTodoDef(),
      modelDef('acme.Kept', { fields: { n: field() } }),
      modelDef('acme.Gone', { fields: { n: field() } }),
    ]);
    const desiredModels = buildModelTable([
      desiredTodoDef(),
      modelDef('acme.Kept', { fields: { n: field() } }),
    ]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({
        directives: [...todoDirectives(), { kind: 'dropModel', model: 'acme.Gone' }],
      }),
      oldModels,
      desiredModels,
    );
    await stageNextChunk({
      store,
      plan,
      mappers: mappersFor(plan, priorityMapper()),
      oldModels,
      desiredModels,
      chunkSize: 10,
    });
    const staged = await store.readStagedRows('mig-1', null, 100);
    assert.equal(staged.length, 1);
    assert.equal(staged[0]?.targetModel as string, TODO_MODEL);
  });
});

describe('staging chunks and cursors', () => {
  it('pages across chunk boundaries and resumes from the cursor', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [
      { id: 'a', data: { label: 'a', done: true } },
      { id: 'b', data: { label: 'b', done: false } },
      { id: 'c', data: { label: 'c', done: true } },
    ]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const args = {
      store,
      plan,
      mappers: mappersFor(plan, priorityMapper()),
      oldModels,
      desiredModels,
      chunkSize: 2,
    };
    const first = await stageNextChunk(args);
    assert.equal(first.done, false);
    assert.deepEqual(first.progress.stagedCursor, { model: TODO_MODEL, recordId: 'b' });
    const second = await stageNextChunk(args);
    assert.equal(second.done, true);
    assert.deepEqual(second.progress.stagedCursor, { model: TODO_MODEL, recordId: 'c' });
    const staged = await store.readStagedRows('mig-1', null, 100);
    assert.equal(staged.length, 3);
  });

  it('establishes progress on an empty scan and reports done', async () => {
    const { store } = setupMigrationWorld();
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const result = await stageNextChunk({
      store,
      plan,
      mappers: mappersFor(plan, priorityMapper()),
      oldModels,
      desiredModels,
      chunkSize: 10,
    });
    assert.equal(result.done, true);
    assert.equal(result.progress.phase, 'staging');
    assert.equal(result.progress.stagedCursor, null);
    const reread = await store.readMigrationProgress('mig-1');
    assert.deepEqual(reread, result.progress);
  });

  it('is a no-op past staging completion', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const args = {
      store,
      plan,
      mappers: mappersFor(plan, priorityMapper()),
      oldModels,
      desiredModels,
      chunkSize: 10,
    };
    await stageNextChunk(args);
    await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
    const again = await stageNextChunk(args);
    assert.equal(again.done, true);
    assert.equal(again.progress.phase, 'staged');
  });

  it('rejects staging a failed migration', async () => {
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
      stageNextChunk({
        store,
        plan,
        mappers: mappersFor(plan, priorityMapper()),
        oldModels,
        desiredModels,
        chunkSize: 10,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /operator decision/);
  });
});

describe('staging failure modes', () => {
  it('rejects a non-positive chunk size as a programmer bug', async () => {
    const { store } = setupMigrationWorld();
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    await assert.rejects(
      () =>
        stageNextChunk({
          store,
          plan,
          mappers: mappersFor(plan, priorityMapper()),
          oldModels,
          desiredModels,
          chunkSize: 0,
        }),
      (error: unknown) => error instanceof Error && !(error instanceof StateError),
    );
  });

  it('blocks expired rows before staging anything', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [
      { id: 'a', data: { label: 'a', done: true } },
      { id: 'b', data: { label: 'b', done: false } },
    ]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const error = await captureStateError(() =>
      stageNextChunk({
        store,
        plan,
        mappers: mappersFor(plan, priorityMapper()),
        oldModels,
        desiredModels,
        chunkSize: 10,
        isExpiredRow: (row: StoredRow) => (row.id as string) === 'b',
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /expired/);
    assert.equal(await store.readMigrationProgress('mig-1'), null);
    assert.deepEqual(await store.readStagedRows('mig-1', null, 100), []);
  });

  it('lets mapper bugs propagate untouched and stages nothing', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const mapper: MigrationMapper = () => {
      throw new TypeError('boom');
    };
    await assert.rejects(
      () =>
        stageNextChunk({
          store,
          plan,
          mappers: mappersFor(plan, mapper),
          oldModels,
          desiredModels,
          chunkSize: 10,
        }),
      (error: unknown) => error instanceof TypeError && error.message === 'boom',
    );
    assert.equal(await store.readMigrationProgress('mig-1'), null);
  });

  it('rejects uninitialized reads with validation', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const mapper: MigrationMapper = (_before, row) => {
      row.get('priority');
    };
    const error = await captureStateError(() =>
      stageNextChunk({
        store,
        plan,
        mappers: mappersFor(plan, mapper),
        oldModels,
        desiredModels,
        chunkSize: 10,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /uninitialized/);
  });

  it('rejects writes to undeclared fields with validation', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const mapper: MigrationMapper = (_before, row) => {
      row.set('nope', 1);
    };
    const error = await captureStateError(() =>
      stageNextChunk({
        store,
        plan,
        mappers: mappersFor(plan, mapper),
        oldModels,
        desiredModels,
        chunkSize: 10,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /undeclared field/);
  });

  it('rejects rows left uninitialized with validation', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const mapper: MigrationMapper = () => {};
    const error = await captureStateError(() =>
      stageNextChunk({
        store,
        plan,
        mappers: mappersFor(plan, mapper),
        oldModels,
        desiredModels,
        chunkSize: 10,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /uninitialized/);
  });

  it('freezes the before-row against mapper mutation', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const mapper: MigrationMapper = (before) => {
      (before.data as Record<string, unknown>)['label'] = 'mutated';
    };
    await assert.rejects(
      () =>
        stageNextChunk({
          store,
          plan,
          mappers: mappersFor(plan, mapper),
          oldModels,
          desiredModels,
          chunkSize: 10,
        }),
      (error: unknown) => error instanceof TypeError,
    );
  });

  it('blocks a missing backfill mapper', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const error = await captureStateError(() =>
      stageNextChunk({ store, plan, mappers: new Map(), oldModels, desiredModels, chunkSize: 10 }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /no mapper/);
  });

  it('blocks a mapper for a non-backfill model', async () => {
    const { store } = setupMigrationWorld();
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const error = await captureStateError(() =>
      stageNextChunk({
        store,
        plan,
        mappers: new Map<ModelName, MigrationMapper>([
          [asModel(TODO_MODEL), priorityMapper()],
          [asModel(TASK), priorityMapper()],
        ]),
        oldModels,
        desiredModels,
        chunkSize: 10,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /non-backfill/);
  });
});

describe('validateMappedRow', () => {
  const def = desiredTodoDef();

  it('accepts a fully initialized row', () => {
    validateMappedRow({ title: 't', done: false, priority: 'low' }, def);
  });

  it('rejects uninitialized stored fields', async () => {
    const error = await captureStateError(() =>
      validateMappedRow({ title: 't', done: false }, def),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /uninitialized/);
  });

  it('rejects undeclared fields', async () => {
    const error = await captureStateError(() =>
      validateMappedRow({ title: 't', done: false, priority: 'low', nope: 1 }, def),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /undeclared/);
  });

  it('rejects null required fields', async () => {
    const error = await captureStateError(() =>
      validateMappedRow({ title: null, done: false, priority: 'low' }, def),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /null/);
  });

  it('fails closed on non-JSON values', async () => {
    const error = await captureStateError(() =>
      validateMappedRow({ title: 't', done: false, priority: 1n as unknown as string }, def),
    );
    assert.equal(error.code, 'validation');
  });

  it('fails closed on nested undefined', async () => {
    const error = await captureStateError(() =>
      validateMappedRow({ title: { deep: undefined }, done: false, priority: 'low' }, def),
    );
    assert.equal(error.code, 'validation');
  });
});

describe('validateStaged', () => {
  async function stageTodo(
    store: StoragePort,
    plan: ValidatedMigrationPlan,
    mapper: MigrationMapper,
    chunkSize = 10,
  ) {
    const { oldModels, desiredModels } = todoTables();
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: new Map([[asModel(TODO_MODEL), mapper]]),
        oldModels,
        desiredModels,
        chunkSize,
      });
      if (result.done) {
        break;
      }
    }
    return desiredModels;
  }

  it('records staged on success, preserving the staging cursor', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [
      { id: 'a', data: { label: 'a', done: true } },
      { id: 'b', data: { label: 'b', done: false } },
    ]);
    const plan = todoPlan();
    const { oldModels } = todoTables();
    const desiredModels = await stageTodo(store, plan, priorityMapper());
    const progress = await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) });
    assert.equal(progress.phase, 'staged');
    assert.deepEqual(progress.stagedCursor, { model: TODO_MODEL, recordId: 'b' });
    assert.equal(progress.publishCursor, null);
  });

  it('blocks with nothing staged', async () => {
    const { store } = setupMigrationWorld();
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    const error = await captureStateError(() =>
      validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /no staged state/);
  });

  it('fails incomplete staged sets and stays staging', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [
      { id: 'a', data: { label: 'a', done: true } },
      { id: 'b', data: { label: 'b', done: false } },
    ]);
    const plan = todoPlan();
    const { oldModels, desiredModels } = todoTables();
    // Exactly one chunk (no loop): the second row stays unstaged.
    await stageNextChunk({
      store,
      plan,
      mappers: new Map([[asModel(TODO_MODEL), priorityMapper()]]),
      oldModels,
      desiredModels,
      chunkSize: 1,
    });
    const error = await captureStateError(() =>
      validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /incomplete/);
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'staging');
  });

  it('fails duplicate uniques within the staged set', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [
      { id: 'a', data: { label: 'same', done: true } },
      { id: 'b', data: { label: 'same', done: false } },
    ]);
    const { oldModels } = todoTables();
    const desiredModels = buildModelTable([
      modelDef(TODO_MODEL, {
        fields: {
          title: field({ required: true }),
          done: field({ required: true }),
          priority: field({ required: true }),
        },
        uniqueKeys: ['title'],
      }),
    ]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: todoDirectives() }),
      oldModels,
      desiredModels,
    );
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: new Map([[asModel(TODO_MODEL), priorityMapper()]]),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    const error = await captureStateError(() =>
      validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /duplicate unique/);
  });

  it('fails constraint-only unique violations on retained live rows', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    await seedLive(store, 'acme.Kept', [
      { id: 'k1', data: { n: 1 } },
      { id: 'k2', data: { n: 1 } },
    ]);
    const oldWithKept = buildModelTable([
      oldTodoDef(),
      modelDef('acme.Kept', { fields: { n: field() } }),
    ]);
    const desiredModels = buildModelTable([
      desiredTodoDef(),
      modelDef('acme.Kept', { fields: { n: field() }, uniqueKeys: ['n'] }),
    ]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: todoDirectives() }),
      oldWithKept,
      desiredModels,
    );
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: new Map([[asModel(TODO_MODEL), priorityMapper()]]),
        oldModels: oldWithKept,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    const error = await captureStateError(() =>
      validateStaged({ store, plan, desiredModels, oldModels: oldWithKept, oldLocks: oldLocks([]) }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /retained live rows/);
  });

  it('fails references to new (empty) models', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const { oldModels } = todoTables();
    const desiredModels = buildModelTable([
      modelDef(TODO_MODEL, {
        fields: {
          title: field({ required: true }),
          done: field({ required: true }),
          priority: field({ required: true }),
          link: field(),
        },
        refs: [{ field: 'link', model: asModel(TASK) }],
      }),
      modelDef(TASK, { fields: { label: field() } }),
    ]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: todoDirectives() }),
      oldModels,
      desiredModels,
    );
    const mapper: MigrationMapper = (before, row) => {
      row.set('priority', 'low');
      row.set('link', { id: 't-1' });
      void before;
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
    const error = await captureStateError(() =>
      validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /not a retained or renamed model/);
  });

  it('fails invariant violations as validation', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const { oldModels } = todoTables();
    const desiredModels = buildModelTable([
      {
        ...desiredTodoDef(),
        invariants: [
          {
            name: 'nope',
            check: () => {
              throw new StateError('rule_failed', 'invariant says no');
            },
          },
        ],
      },
    ]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: todoDirectives() }),
      oldModels,
      desiredModels,
    );
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: new Map([[asModel(TODO_MODEL), priorityMapper()]]),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    const error = await captureStateError(() =>
      validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /violates invariant/);
  });

  it('lets invariant bugs propagate untouched', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const { oldModels } = todoTables();
    const desiredModels = buildModelTable([
      {
        ...desiredTodoDef(),
        invariants: [
          {
            name: 'buggy',
            check: () => {
              throw new TypeError('invariant bug');
            },
          },
        ],
      },
    ]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: todoDirectives() }),
      oldModels,
      desiredModels,
    );
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: new Map([[asModel(TODO_MODEL), priorityMapper()]]),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    await assert.rejects(
      () => validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) }),
      (error: unknown) => error instanceof TypeError && error.message === 'invariant bug',
    );
  });

  it('passes rows never protected by old locks', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    const { oldModels } = todoTables();
    const desiredModels = await stageTodo(store, plan, priorityMapper());
    const progress = await validateStaged({
      store,
      plan,
      desiredModels,
      oldModels,
      oldLocks: oldLocks([
        { model: TODO_MODEL, locks: [{ name: 'closed', when: { op: 'eq', field: 'done', value: 'never' } }] },
      ]),
    });
    assert.equal(progress.phase, 'staged');
  });

  it('fails locks over removed evidence', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true, legacy: 'x' } }]);
    const plan = todoPlan();
    const { oldModels } = todoTables();
    const desiredModels = await stageTodo(store, plan, priorityMapper());
    const error = await captureStateError(() =>
      validateStaged({
        store,
        plan,
        desiredModels,
        oldModels,
        oldLocks: oldLocks([
          { model: TODO_MODEL, locks: [{ name: 'leg', when: { op: 'eq', field: 'legacy', value: 'x' } }] },
        ]),
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /still-locked evidence/);
  });

  it('allows desired locks to establish during initialization', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const { oldModels } = todoTables();
    const desiredModels = buildModelTable([
      {
        ...desiredTodoDef(),
        locks: [{ name: 'low', when: { op: 'eq', field: 'priority', value: 'low' } }],
      },
    ]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: todoDirectives() }),
      oldModels,
      desiredModels,
    );
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: new Map([[asModel(TODO_MODEL), priorityMapper()]]),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    const progress = await validateStaged({
      store,
      plan,
      desiredModels,
      oldModels,
      oldLocks: oldLocks([]),
    });
    assert.equal(progress.phase, 'staged');
  });

  it('rejects staged rows for unmapped targets', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = todoPlan();
    const { oldModels } = todoTables();
    const desiredModels = await stageTodo(store, plan, priorityMapper());
    const revision = await store.readRevision();
    const progress = await store.readMigrationProgress('mig-1');
    assert.ok(progress !== null);
    await store.stageMigrationRows({
      expectedRevision: revision,
      migrationId: 'mig-1',
      rows: [
        {
          targetModel: asModel('acme.Nope'),
          recordId: asId('a'),
          version: asVersion(1),
          data: {},
          parent: null,
          converted: false,
        },
      ],
      progress,
    });
    const error = await captureStateError(() =>
      validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /unmapped target/);
  });

  it('blocks drops of locked rows', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const oldModels = buildModelTable([
      modelDef(TODO_MODEL, {
        fields: { label: field(), done: field() },
        locks: [{ name: 'closed', when: { op: 'eq', field: 'done', value: true } }],
      }),
    ]);
    const desiredModels = buildModelTable([]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: [{ kind: 'dropModel', model: TODO_MODEL }] }),
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
    const error = await captureStateError(() =>
      validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /cannot drop locked row/);
  });

  it('blocks drops with retained-live referrers', async () => {
    const { store } = setupMigrationWorld();
    const PARENT = 'acme.Parent';
    const CHILD = 'acme.Child';
    await seedLive(store, PARENT, [{ id: 'p', data: { name: 'p' } }]);
    await seedLive(store, CHILD, [{ id: 'c', data: { name: 'c', parentId: { id: 'p' } } }]);
    const childDef = { name: field(), parentId: field() };
    const oldModels = buildModelTable([
      modelDef(PARENT, { fields: { name: field() } }),
      modelDef(CHILD, { fields: childDef, refs: [{ field: 'parentId', model: asModel(PARENT) }] }),
    ]);
    const desiredModels = buildModelTable([
      modelDef(CHILD, { fields: childDef, refs: [{ field: 'parentId', model: asModel(PARENT) }] }),
    ]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: [{ kind: 'dropModel', model: PARENT }] }),
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
    const error = await captureStateError(() =>
      validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /retained referrer/);
  });

  it('masks referrers that are themselves dropped', async () => {
    const { store } = setupMigrationWorld();
    const PARENT = 'acme.Parent';
    const CHILD = 'acme.Child';
    await seedLive(store, PARENT, [{ id: 'p', data: { name: 'p' } }]);
    await seedLive(store, CHILD, [{ id: 'c', data: { name: 'c', parentId: { id: 'p' } } }]);
    const oldModels = buildModelTable([
      modelDef(PARENT, { fields: { name: field() } }),
      modelDef(CHILD, {
        fields: { name: field(), parentId: field() },
        refs: [{ field: 'parentId', model: asModel(PARENT) }],
      }),
    ]);
    const desiredModels = buildModelTable([]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({
        directives: [
          { kind: 'dropModel', model: PARENT },
          { kind: 'dropModel', model: CHILD },
        ],
      }),
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
    const progress = await validateStaged({
      store,
      plan,
      desiredModels,
      oldModels,
      oldLocks: oldLocks([]),
    });
    assert.equal(progress.phase, 'staged');
  });

  it('masks staged referrers that removed the ref', async () => {
    const { store } = setupMigrationWorld();
    const PARENT = 'acme.Parent';
    const CHILD = 'acme.Child';
    await seedLive(store, PARENT, [{ id: 'p', data: { name: 'p' } }]);
    await seedLive(store, CHILD, [{ id: 'c', data: { name: 'c', parentId: { id: 'p' } } }]);
    const oldModels = buildModelTable([
      modelDef(PARENT, { fields: { name: field() } }),
      modelDef(CHILD, {
        fields: { name: field(), parentId: field() },
        refs: [{ field: 'parentId', model: asModel(PARENT) }],
      }),
    ]);
    const desiredModels = buildModelTable([modelDef(CHILD, { fields: { name: field() } })]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({
        directives: [
          { kind: 'dropModel', model: PARENT },
          { kind: 'dropField', model: CHILD, field: 'parentId' },
        ],
      }),
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
    const progress = await validateStaged({
      store,
      plan,
      desiredModels,
      oldModels,
      oldLocks: oldLocks([]),
    });
    assert.equal(progress.phase, 'staged');
  });

  it('blocks staged referrers that kept the ref', async () => {
    const { store } = setupMigrationWorld();
    const PARENT = 'acme.Parent';
    const CHILD = 'acme.Child';
    await seedLive(store, PARENT, [{ id: 'p', data: { name: 'p' } }]);
    await seedLive(store, CHILD, [{ id: 'c', data: { name: 'c', parentId: { id: 'p' } } }]);
    const childFields = { name: field(), parentId: field() };
    const childRefs = [{ field: 'parentId', model: asModel(PARENT) }];
    const oldModels = buildModelTable([
      modelDef(PARENT, { fields: { name: field() } }),
      modelDef(CHILD, { fields: childFields, refs: childRefs }),
    ]);
    const desiredModels = buildModelTable([
      modelDef(CHILD, { fields: childFields, refs: childRefs }),
    ]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({
        directives: [
          { kind: 'dropModel', model: PARENT },
          { kind: 'backfill', model: CHILD },
        ],
      }),
      oldModels,
      desiredModels,
    );
    const keepMapper: MigrationMapper = (before, row) => {
      row.set('parentId', before.data['parentId']);
      void row.get('name');
    };
    for (;;) {
      const result = await stageNextChunk({
        store,
        plan,
        mappers: new Map([[asModel(CHILD), keepMapper]]),
        oldModels,
        desiredModels,
        chunkSize: 10,
      });
      if (result.done) {
        break;
      }
    }
    const error = await captureStateError(() =>
      validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /keeps the reference/);
  });

  it('blocks staged refs to missing ids', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    await seedLive(store, TASK, [{ id: 't-1', data: { label: 't' } }]);
    const { oldModels: todoOld } = todoTables();
    const oldModels = buildModelTable([
      ...todoOld.values(),
      modelDef(TASK, { fields: { label: field() } }),
    ]);
    const desiredModels = buildModelTable([
      modelDef(TODO_MODEL, {
        fields: {
          title: field({ required: true }),
          done: field({ required: true }),
          priority: field({ required: true }),
          link: field(),
        },
        refs: [{ field: 'link', model: asModel(TASK) }],
      }),
      modelDef(TASK, { fields: { label: field() } }),
    ]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: todoDirectives() }),
      oldModels,
      desiredModels,
    );
    const mapper: MigrationMapper = (before, row) => {
      row.set('priority', 'low');
      row.set('link', { id: 't-missing' });
      void before;
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
    const error = await captureStateError(() =>
      validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /points at missing/);
  });

  it('blocks refs changed onto archived rows', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    await seedLive(store, TASK, [{ id: 't-arch', archivedAt: 1_500, data: { label: 't' } }]);
    const { oldModels: todoOld } = todoTables();
    const oldModels = buildModelTable([
      ...todoOld.values(),
      modelDef(TASK, { fields: { label: field() } }),
    ]);
    const desiredModels = buildModelTable([
      modelDef(TODO_MODEL, {
        fields: {
          title: field({ required: true }),
          done: field({ required: true }),
          priority: field({ required: true }),
          link: field(),
        },
        refs: [{ field: 'link', model: asModel(TASK) }],
      }),
      modelDef(TASK, { fields: { label: field() } }),
    ]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: todoDirectives() }),
      oldModels,
      desiredModels,
    );
    const mapper: MigrationMapper = (before, row) => {
      row.set('priority', 'low');
      row.set('link', { id: 't-arch' });
      void before;
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
    const error = await captureStateError(() =>
      validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /points at archived/);
  });

  it('passes unchanged legacy refs to archived rows', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TASK, [{ id: 't-arch', archivedAt: 1_500, data: { label: 't' } }]);
    await seedLive(store, TODO_MODEL, [
      { id: 'a', data: { label: 'a', done: true, link: { id: 't-arch' } } },
    ]);
    const taskRef = { field: 'link', model: asModel(TASK) };
    const oldModels = buildModelTable([
      modelDef(TODO_MODEL, {
        fields: { label: field(), done: field(), legacy: field(), link: field() },
        refs: [taskRef],
      }),
      modelDef(TASK, { fields: { label: field() } }),
    ]);
    const desiredModels = buildModelTable([
      modelDef(TODO_MODEL, {
        fields: {
          title: field({ required: true }),
          done: field({ required: true }),
          priority: field({ required: true }),
          link: field(),
        },
        refs: [taskRef],
      }),
      modelDef(TASK, { fields: { label: field() } }),
    ]);
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({ directives: todoDirectives() }),
      oldModels,
      desiredModels,
    );
    // The mapper never touches `link`: retention seeds the legacy value.
    const mapper: MigrationMapper = (before, row) => {
      row.set('priority', 'low');
      void before;
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
    const progress = await validateStaged({
      store,
      plan,
      desiredModels,
      oldModels,
      oldLocks: oldLocks([]),
    });
    assert.equal(progress.phase, 'staged');
  });
});
