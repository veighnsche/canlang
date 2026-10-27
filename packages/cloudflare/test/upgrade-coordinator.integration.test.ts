/** B25 upgrade coordinator: real engine runs over an isolated memory store. */
import assert from 'node:assert/strict';
import { it } from 'vitest';
import type { ModelName, UpgradePlan } from '@canlang/contracts';
import { buildModelTable, type ModelTable } from '@canlang/state';
import { stageNextChunk, validateTransition, type MigrationMapper } from '@canlang/state/migration';
import { asId, asModel } from '@canlang/state/testing/invocation/fixtures';
import { field, modelDef } from '@canlang/state/testing/mutation/fixtures';
import {
  TODO_MODEL,
  fixedClock,
  installSnapshot,
  inventoryItem,
  makeInstalled,
  makeTransition,
  oldLocks,
  seedLive,
  seedOutbox,
  setupMigrationWorld,
  todoDirectives,
  todoTables,
} from '@canlang/state/testing/migration/fixtures';
import { coordinateUpgrade, type OwnerUpgradeInput } from '../src/upgrade/coordinate.js';

const PLAN: UpgradePlan = {
  from: [{ owner: 'acme', snapshotId: 'snap-1' }],
  to: {
    appName: 'Tasks',
    sourceRevision: 'rev-2',
    languageVersion: '1.0',
    compilerVersion: '0.1.2',
    contractsVersion: 1,
    artifactDigest: 'artifact-2',
  },
  pendingWork: [],
};

function todoMapper(): MigrationMapper {
  return (before, row) => {
    row.set('title', before.data.label);
    row.set('done', before.data.done);
    row.set('priority', 'normal');
  };
}

function ownerInput(overrides: Partial<OwnerUpgradeInput> = {}): OwnerUpgradeInput {
  const { oldModels, desiredModels } = todoTables();
  return {
    transition: makeTransition({ directives: todoDirectives() }),
    mappers: new Map<ModelName, MigrationMapper>([[asModel(TODO_MODEL), todoMapper()]]),
    oldModels,
    desiredModels,
    oldLocks: oldLocks([]),
    inventory: [],
    ...overrides,
  };
}

async function seedTodoWorld(rows = 2) {
  const { store, probe } = setupMigrationWorld();
  await installSnapshot(store, makeInstalled());
  await seedLive(
    store,
    TODO_MODEL,
    Array.from({ length: rows }, (_, index) => ({
      id: `todo-${index}`,
      data: { label: `task ${index}`, done: false, legacy: `old-${index}` },
    })),
  );
  return { store, probe };
}

it('upgrades one owner predecessor to desired with staged data preserved', async () => {
  const { store } = await seedTodoWorld(3);
  const state = await coordinateUpgrade({
    store,
    plan: PLAN,
    owners: new Map([['acme', ownerInput()]]),
    chunkSize: 2,
    clock: fixedClock(),
  });
  assert.equal(state.stage, 'active');
  assert.deepEqual(state.progress, { stagedOwners: 1, totalOwners: 1 });
  const installed = await store.readInstalledSnapshot('acme');
  assert.equal(installed?.snapshotId, 'snap-2');
  assert.equal(installed?.digest, 'digest-2');
  const progress = await store.readMigrationProgress('mig-1');
  assert.equal(progress?.phase, 'active');
});

it('resumes an interrupted staging run and validates staged rows', async () => {
  const { store } = await seedTodoWorld(3);
  const input = ownerInput();
  const { oldModels, desiredModels } = todoTables();
  // Interrupt after one chunk of three rows (chunkSize 1).
  const validated = validateTransition(makeInstalled(), input.transition, oldModels, desiredModels);
  const first = await stageNextChunk({
    store,
    plan: validated,
    mappers: input.mappers,
    oldModels,
    desiredModels,
    chunkSize: 1,
  });
  assert.equal(first.done, false);
  const staged = await store.readStagedRow('mig-1', asModel(TODO_MODEL), asId('todo-0'));
  assert.equal(staged?.data.title, 'task 0');
  // Resume via the coordinator completes the same migration.
  const state = await coordinateUpgrade({
    store,
    plan: PLAN,
    owners: new Map([['acme', input]]),
    chunkSize: 1,
    clock: fixedClock(),
  });
  assert.equal(state.stage, 'active');
  const installed = await store.readInstalledSnapshot('acme');
  assert.equal(installed?.snapshotId, 'snap-2');
});

it('refuses a predecessor mismatch before any write', async () => {
  const { store } = await seedTodoWorld(1);
  // Installed digest differs from the transition predecessor.
  await installSnapshot(store, makeInstalled({ digest: 'digest-9' }));
  const state = await coordinateUpgrade({
    store,
    plan: PLAN,
    owners: new Map([['acme', ownerInput()]]),
    chunkSize: 10,
    clock: fixedClock(),
  });
  assert.equal(state.stage, 'staging-failed');
  assert.equal(state.failure?.recoverable, false);
  assert.match(state.failure?.reason ?? '', /predecessor/i);
  const installed = await store.readInstalledSnapshot('acme');
  assert.equal(installed?.digest, 'digest-9');
  assert.equal(await store.readMigrationProgress('mig-1'), null);
});

it('blocks activation on unpinned undispatched work and stays resumable', async () => {
  const { store } = await seedTodoWorld(1);
  await seedOutbox(store, [{ intentId: 'intent-1' }]);
  const input = ownerInput({ inventory: [inventoryItem('intent-1', 'acme.worker')] });
  const blocked = await coordinateUpgrade({
    store,
    plan: PLAN,
    owners: new Map([['acme', input]]),
    chunkSize: 10,
    clock: fixedClock(),
  });
  assert.equal(blocked.stage, 'activation-failed');
  assert.equal(blocked.failure?.recoverable, true);
  const installed = await store.readInstalledSnapshot('acme');
  assert.equal(installed?.snapshotId, 'snap-1');
  // Drained inventory lets the same run resume to active.
  const resumed = await coordinateUpgrade({
    store,
    plan: PLAN,
    owners: new Map([['acme', ownerInput()]]),
    chunkSize: 10,
    clock: fixedClock(),
  });
  assert.equal(resumed.stage, 'active');
});

it('skips owners already installed at the desired snapshot', async () => {
  const { store } = await seedTodoWorld(1);
  const first = await coordinateUpgrade({
    store,
    plan: PLAN,
    owners: new Map([['acme', ownerInput()]]),
    chunkSize: 10,
    clock: fixedClock(),
  });
  assert.equal(first.stage, 'active');
  const second = await coordinateUpgrade({
    store,
    plan: PLAN,
    owners: new Map([['acme', ownerInput()]]),
    chunkSize: 10,
    clock: fixedClock(),
  });
  assert.equal(second.stage, 'active');
  assert.deepEqual(second.progress, { stagedOwners: 1, totalOwners: 1 });
});

it('throws loud when the transition does not bind the planned predecessor', async () => {
  const { store } = await seedTodoWorld(1);
  const input = ownerInput({
    transition: makeTransition({ fromSnapshotId: 'snap-9', directives: todoDirectives() }),
  });
  await assert.rejects(
    () =>
      coordinateUpgrade({
        store,
        plan: PLAN,
        owners: new Map([['acme', input]]),
        chunkSize: 10,
        clock: fixedClock(),
      }),
    /does not bind predecessor/,
  );
  assert.equal(await store.readMigrationProgress('mig-1'), null);
});

it('throws loud when an owner has no compiled transition', async () => {
  const { store } = await seedTodoWorld(1);
  await assert.rejects(
    () =>
      coordinateUpgrade({ store, plan: PLAN, owners: new Map(), chunkSize: 10, clock: fixedClock() }),
    /no compiled transition/,
  );
});

it('serializes two owners in plan order', async () => {
  const first = await seedTodoWorld(1);
  const plan: UpgradePlan = {
    ...PLAN,
    from: [
      { owner: 'acme', snapshotId: 'snap-1' },
      { owner: 'globex', snapshotId: 'snap-1' },
    ],
  };
  // Second owner world: same shape under another owner/model.
  const { store } = first;
  const globexModel = 'globex.Todo';
  const oldModels = buildModelTable([
    modelDef(globexModel, { fields: { label: field({ required: true }), done: field({ required: true }) } }),
  ]);
  const desiredModels: ModelTable = buildModelTable([
    modelDef(globexModel, {
      fields: { title: field({ required: true }), done: field({ required: true }), priority: field({ required: true }) },
    }),
  ]);
  await installSnapshot(store, makeInstalled({ owner: 'globex' }));
  await seedLive(store, globexModel, [{ id: 'g-0', data: { label: 'g task', done: true } }]);
  const globexMapper: MigrationMapper = (before, row) => {
    row.set('title', before.data.label);
    row.set('done', before.data.done);
    row.set('priority', 'normal');
  };
  const state = await coordinateUpgrade({
    store,
    plan,
    owners: new Map([
      ['acme', ownerInput()],
      [
        'globex',
        {
          transition: makeTransition({
            migrationId: 'mig-2',
            owner: 'globex',
            directives: [
              { kind: 'renameField', model: globexModel, from: 'label', to: 'title' },
              { kind: 'backfill', model: globexModel },
            ],
          }),
          mappers: new Map([[asModel(globexModel), globexMapper]]),
          oldModels,
          desiredModels,
          oldLocks: oldLocks([]),
          inventory: [],
        },
      ],
    ]),
    chunkSize: 10,
    clock: fixedClock(),
  });
  assert.equal(state.stage, 'active');
  assert.deepEqual(state.progress, { stagedOwners: 2, totalOwners: 2 });
  assert.equal((await store.readInstalledSnapshot('acme'))?.snapshotId, 'snap-2');
  assert.equal((await store.readInstalledSnapshot('globex'))?.snapshotId, 'snap-2');
});
