/** B25 upgrade coordinator: real engine runs over isolated memory and D1 stores. */
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { it } from 'vitest';
import type { ModelName, StoragePort, UpgradePlan } from '@canlang/contracts';
import { buildModelTable, type ModelTable } from '@canlang/state';
import { stageNextChunk, validateTransition, type MigrationMapper } from '@canlang/state/migration';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
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
import { liveApplyUpgrade, type WranglerSpawner } from '../src/upgrade/apply.js';

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

async function seedD1TodoWorld(rows = 2) {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ready")}}',
    d1Databases: { DB: 'upgrade-coordinator-proof' },
  });
  const db = (await runtime.getD1Database('DB')) as unknown as Parameters<typeof createD1Storage>[0];
  await ensureSchema(db);
  const store = createD1Storage(db);
  await installSnapshot(store, makeInstalled());
  await seedLive(
    store,
    TODO_MODEL,
    Array.from({ length: rows }, (_, index) => ({
      id: `todo-${index}`,
      data: { label: `task ${index}`, done: false, legacy: `old-${index}` },
    })),
  );
  return { store, cleanup: () => runtime.dispose() };
}

async function expectHappyPath(store: StoragePort) {
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
}

async function expectInterruptedResume(store: StoragePort) {
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
}

it('upgrades one owner predecessor to desired with staged data preserved', async () => {
  const { store } = await seedTodoWorld(3);
  await expectHappyPath(store);
});

it('resumes an interrupted staging run and validates staged rows', async () => {
  const { store } = await seedTodoWorld(3);
  await expectInterruptedResume(store);
});

it('upgrades over a real D1 adapter', async () => {
  const { store, cleanup } = await seedD1TodoWorld(3);
  try {
    await expectHappyPath(store);
  } finally {
    await cleanup();
  }
});

it('resumes an interrupted staging run over a real D1 adapter', async () => {
  const { store, cleanup } = await seedD1TodoWorld(3);
  try {
    await expectInterruptedResume(store);
  } finally {
    await cleanup();
  }
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

it('stops before activation on request and resumes to active', async () => {
  const { store } = await seedTodoWorld(2);
  const owners = new Map([['acme', ownerInput()]]);
  const stopped = await coordinateUpgrade({
    store,
    plan: PLAN,
    owners,
    chunkSize: 10,
    clock: fixedClock(),
    stopBeforeActivate: true,
  });
  assert.equal(stopped.stage, 'staged');
  assert.deepEqual(stopped.progress, { stagedOwners: 1, totalOwners: 1 });
  assert.equal((await store.readInstalledSnapshot('acme'))?.snapshotId, 'snap-1');
  assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'staged');
  const resumed = await coordinateUpgrade({ store, plan: PLAN, owners, chunkSize: 10, clock: fixedClock() });
  assert.equal(resumed.stage, 'active');
  assert.equal((await store.readInstalledSnapshot('acme'))?.snapshotId, 'snap-2');
});

it('live apply stages, deploys, then flips with the worker leg between', async () => {
  const { store } = await seedTodoWorld(2);
  const spawns: Array<{ command: string; args: readonly string[] }> = [];
  const spawn: WranglerSpawner = (command, args) => {
    spawns.push({ command, args: [...args] });
    return { status: 0, stdout: 'deployed', stderr: '' };
  };
  const result = await liveApplyUpgrade({
    plan: PLAN,
    owners: new Map([['acme', ownerInput()]]),
    store,
    chunkSize: 10,
    clock: fixedClock(),
    yes: true,
    configPath: '/tmp/can-test/wrangler.toml',
    spawn,
  });
  assert.equal(result.state.stage, 'active');
  assert.equal(result.wrangler?.applied, true);
  assert.deepEqual(result.wrangler?.command, ['wrangler', 'deploy', '--config', '/tmp/can-test/wrangler.toml']);
  assert.equal(spawns.length, 1);
  assert.equal((await store.readInstalledSnapshot('acme'))?.snapshotId, 'snap-2');
});

it('live apply spawns nothing when staging fails', async () => {
  const { store } = await seedTodoWorld(1);
  await installSnapshot(store, makeInstalled({ digest: 'digest-9' }));
  let spawns = 0;
  const spawn: WranglerSpawner = () => {
    spawns += 1;
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = await liveApplyUpgrade({
    plan: PLAN,
    owners: new Map([['acme', ownerInput()]]),
    store,
    chunkSize: 10,
    clock: fixedClock(),
    yes: true,
    configPath: '/tmp/can-test/wrangler.toml',
    spawn,
  });
  assert.equal(result.state.stage, 'staging-failed');
  assert.equal(result.wrangler, undefined);
  assert.equal(spawns, 0);
});

it('live apply reports a failed deploy as retryable and resumes clean', async () => {
  const { store } = await seedTodoWorld(1);
  const owners = new Map([['acme', ownerInput()]]);
  const failing: WranglerSpawner = () => ({ status: 1, stdout: '', stderr: 'boom' });
  const failed = await liveApplyUpgrade({
    plan: PLAN,
    owners,
    store,
    chunkSize: 10,
    clock: fixedClock(),
    yes: true,
    configPath: '/tmp/can-test/wrangler.toml',
    spawn: failing,
  });
  assert.equal(failed.state.stage, 'activation-failed');
  assert.equal(failed.state.failure?.recoverable, true);
  assert.equal(failed.wrangler?.applied, false);
  // Data stayed staged; old code still serves old data.
  assert.equal((await store.readInstalledSnapshot('acme'))?.snapshotId, 'snap-1');
  assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'staged');
  const passing: WranglerSpawner = () => ({ status: 0, stdout: 'deployed', stderr: '' });
  const retried = await liveApplyUpgrade({
    plan: PLAN,
    owners,
    store,
    chunkSize: 10,
    clock: fixedClock(),
    yes: true,
    configPath: '/tmp/can-test/wrangler.toml',
    spawn: passing,
  });
  assert.equal(retried.state.stage, 'active');
  assert.equal((await store.readInstalledSnapshot('acme'))?.snapshotId, 'snap-2');
});

it('live apply without yes stages and spawns nothing', async () => {
  const { store } = await seedTodoWorld(1);
  let spawns = 0;
  const spawn: WranglerSpawner = () => {
    spawns += 1;
    return { status: 0, stdout: '', stderr: '' };
  };
  await assert.rejects(
    () =>
      liveApplyUpgrade({
        plan: PLAN,
        owners: new Map([['acme', ownerInput()]]),
        store,
        chunkSize: 10,
        clock: fixedClock(),
        yes: false,
        configPath: '/tmp/can-test/wrangler.toml',
        spawn,
      }),
    /without explicit --yes/,
  );
  assert.equal(spawns, 0);
  assert.equal(await store.readMigrationProgress('mig-1'), null);
});
