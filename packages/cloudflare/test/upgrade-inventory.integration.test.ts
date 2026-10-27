/** B25 inventory producer: real outbox rows become activation inventory. */
import assert from 'node:assert/strict';
import { it } from 'vitest';
import type { ModelName, UpgradePlan } from '@canlang/contracts';
import { buildWorkInventory } from '@canlang/work';
import type { MigrationMapper } from '@canlang/state/migration';
import { asModel } from '@canlang/state/testing/invocation/fixtures';
import {
  TODO_MODEL,
  fixedClock,
  installSnapshot,
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
import {
  buildUpgradeInventory,
  handlerContractForOutboxItem,
  outboxItemsFromPending,
} from '../src/upgrade/inventory.js';

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

it('maps pending outbox rows to undispatched inventory with operation contracts', async () => {
  const { store } = setupMigrationWorld();
  await seedOutbox(store, [
    { intentId: 'intent-1', operation: 'acme.worker' },
    { intentId: 'intent-2', operation: 'acme.cleanup' },
  ]);
  const items = await buildUpgradeInventory(store);
  assert.deepEqual(items, [
    { intentId: 'intent-1', handlerContract: 'acme.worker', state: 'undispatched' },
    { intentId: 'intent-2', handlerContract: 'acme.cleanup', state: 'undispatched' },
  ]);
});

it('refuses to guess a contract for an operation-less row', async () => {
  const { store } = setupMigrationWorld();
  await seedOutbox(store, [{ intentId: 'intent-1', operation: '' }]);
  assert.equal(handlerContractForOutboxItem(outboxItemsFromPending(await store.outboxPending())[0]!), null);
  await assert.rejects(() => buildUpgradeInventory(store), /no handler-contract mapping/);
});

it('produced inventory blocks the coordinator on unpinned work', async () => {
  const { store } = setupMigrationWorld();
  await installSnapshot(store, makeInstalled());
  await seedLive(store, TODO_MODEL, [{ id: 'todo-0', data: { label: 't', done: false, legacy: 'x' } }]);
  await seedOutbox(store, [{ intentId: 'intent-1', operation: 'acme.worker' }]);
  const { oldModels, desiredModels } = todoTables();
  const input: OwnerUpgradeInput = {
    transition: makeTransition({ directives: todoDirectives() }),
    mappers: new Map<ModelName, MigrationMapper>([[asModel(TODO_MODEL), todoMapper()]]),
    oldModels,
    desiredModels,
    oldLocks: oldLocks([]),
    inventory: await buildUpgradeInventory(store),
  };
  const state = await coordinateUpgrade({
    store,
    plan: PLAN,
    owners: new Map([['acme', input]]),
    chunkSize: 10,
    clock: fixedClock(),
  });
  assert.equal(state.stage, 'activation-failed');
  assert.equal((await store.readInstalledSnapshot('acme'))?.snapshotId, 'snap-1');
});

it('pinned invalidate plus produced inventory activates with recorded outcomes', async () => {
  const { store } = setupMigrationWorld();
  await installSnapshot(store, makeInstalled());
  await seedLive(store, TODO_MODEL, [{ id: 'todo-0', data: { label: 't', done: false, legacy: 'x' } }]);
  await seedOutbox(store, [{ intentId: 'intent-1', operation: 'acme.worker' }]);
  const { oldModels, desiredModels } = todoTables();
  const input: OwnerUpgradeInput = {
    transition: makeTransition({
      directives: [...todoDirectives(), { kind: 'invalidate', handlerContract: 'acme.worker' }],
    }),
    mappers: new Map<ModelName, MigrationMapper>([[asModel(TODO_MODEL), todoMapper()]]),
    oldModels,
    desiredModels,
    oldLocks: oldLocks([]),
    inventory: await buildUpgradeInventory(store),
  };
  const state = await coordinateUpgrade({
    store,
    plan: PLAN,
    owners: new Map([['acme', input]]),
    chunkSize: 10,
    clock: fixedClock(),
  });
  assert.equal(state.stage, 'active');
  const outcomes = await store.readMigrationOutcomes('mig-1');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.intentId, 'intent-1');
  assert.equal(outcomes[0]?.kind, 'invalidated');
});

it('skips settled outbox items without a mapping callback', async () => {
  // buildWorkInventory contract the producer relies on: delivered/failed/
  // dead never reach the mapping (proven here against the real builder).
  let calls = 0;
  const items = buildWorkInventory({
    outboxItems: [
      {
        id: 'live',
        operationId: 'op-1',
        source: 'acme.worker',
        occurrenceIndex: 0,
        request: {},
        originOccurrence: null,
        attempts: 0,
        state: 'pending',
      },
      {
        id: 'done',
        operationId: 'op-1',
        source: '',
        occurrenceIndex: 1,
        request: {},
        originOccurrence: null,
        attempts: 1,
        state: 'delivered',
      },
    ],
    handlerContractFor: (item) => {
      calls += 1;
      return handlerContractForOutboxItem(item);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(items, [{ intentId: 'live', handlerContract: 'acme.worker', state: 'undispatched' }]);
});
