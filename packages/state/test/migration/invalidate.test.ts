/**
 * Lane 03 S7 invalidate tests (engine worker): eligible-only disposal,
 * inventory gating (in-flight/accepted/uncertain/unpinned blocks), the
 * still-pending outbox cross-check, and outcome records. Memory store.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelName, StoragePort, WorkInventoryItem } from '../../../contracts/src/state.js';
import {
  activate,
  stageNextChunk,
  validateStaged,
  validateTransition,
  type MigrationMapper,
  type ValidatedMigrationPlan,
} from '../../src/migration/index.js';
import {
  TODO_MODEL,
  asModel,
  captureStateError,
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
} from './fixtures.js';

const CONTRACT = 'acme.oldWorker@1';

function priorityMapper(): MigrationMapper {
  return (before, row) => {
    row.set('priority', before.data['done'] === true ? 'low' : 'normal');
  };
}

/** Todo plan pinning CONTRACT for invalidation. */
function invalidatePlan(): ValidatedMigrationPlan {
  const { oldModels, desiredModels } = todoTables();
  return validateTransition(
    makeInstalled(),
    makeTransition({ directives: [...todoDirectives(), { kind: 'invalidate', handlerContract: CONTRACT }] }),
    oldModels,
    desiredModels,
  );
}

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

async function activateWith(store: StoragePort, plan: ValidatedMigrationPlan, inventory: ReadonlyArray<WorkInventoryItem>) {
  const { oldModels, desiredModels } = todoTables();
  return activate({
    store,
    plan,
    inventory,
    oldModels,
    desiredModels,
    chunkSize: 10,
    clock: fixedClock(),
  });
}

describe('invalidate disposition', () => {
  it('skips eligible intents and records outcomes', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    await seedOutbox(store, [{ intentId: 'i-1' }, { intentId: 'i-2' }]);
    const plan = invalidatePlan();
    await installSnapshot(store, makeInstalled());
    await stageAndValidate(store, plan);
    const flip = await activateWith(store, plan, [
      inventoryItem('i-1', CONTRACT),
      inventoryItem('i-2', CONTRACT),
    ]);
    assert.equal(flip.flipped, true);
    const outcomes = await store.readMigrationOutcomes('mig-1');
    assert.deepEqual(outcomes, [
      { migrationId: 'mig-1', kind: 'invalidated', intentId: 'i-1', handlerContract: CONTRACT },
      { migrationId: 'mig-1', kind: 'invalidated', intentId: 'i-2', handlerContract: CONTRACT },
    ]);
    const pending = await store.outboxPending();
    assert.deepEqual(pending.map((intent) => intent.intentId), []);
  });

  it('leaves uninventoried pending intents untouched', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    await seedOutbox(store, [{ intentId: 'i-1' }, { intentId: 'i-keep' }]);
    const plan = invalidatePlan();
    await installSnapshot(store, makeInstalled());
    await stageAndValidate(store, plan);
    await activateWith(store, plan, [inventoryItem('i-1', CONTRACT)]);
    const pending = await store.outboxPending();
    assert.deepEqual(pending.map((intent) => intent.intentId), ['i-keep']);
    const outcomes = await store.readMigrationOutcomes('mig-1');
    assert.equal(outcomes.length, 1);
  });

  it('dedupes repeated inventory entries', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    await seedOutbox(store, [{ intentId: 'i-1' }]);
    const plan = invalidatePlan();
    await installSnapshot(store, makeInstalled());
    await stageAndValidate(store, plan);
    await activateWith(store, plan, [inventoryItem('i-1', CONTRACT), inventoryItem('i-1', CONTRACT)]);
    const outcomes = await store.readMigrationOutcomes('mig-1');
    assert.equal(outcomes.length, 1);
  });
});

describe('invalidate gating', () => {
  it('blocks in-flight, accepted, and uncertain work listing intent ids', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = invalidatePlan();
    await stageAndValidate(store, plan);
    const error = await captureStateError(() =>
      activateWith(store, plan, [
        inventoryItem('i-flying', CONTRACT, 'inflight'),
        inventoryItem('i-taken', CONTRACT, 'accepted'),
        inventoryItem('i-maybe', CONTRACT, 'uncertain'),
      ]),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /drain\/reconcile/);
    assert.ok(error.message.includes('i-flying'));
    assert.ok(error.message.includes('i-taken'));
    assert.ok(error.message.includes('i-maybe'));
  });

  it('blocks inventoried undispatched work with no pinned contract', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    await seedOutbox(store, [{ intentId: 'i-1' }]);
    const plan = invalidatePlan();
    await stageAndValidate(store, plan);
    const error = await captureStateError(() =>
      activateWith(store, plan, [inventoryItem('i-1', 'acme.other@9')]),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /no disposition/);
    assert.ok(error.message.includes('i-1'));
  });

  it('blocks eligible-only runs when any item lacks disposition', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    await seedOutbox(store, [{ intentId: 'i-ok' }, { intentId: 'i-bad' }]);
    const plan = invalidatePlan();
    await stageAndValidate(store, plan);
    const error = await captureStateError(() =>
      activateWith(store, plan, [
        inventoryItem('i-ok', CONTRACT),
        inventoryItem('i-bad', 'acme.other@9'),
      ]),
    );
    assert.equal(error.code, 'validation');
    assert.ok(error.message.includes('i-bad'));
    assert.ok(!error.message.includes('i-ok'));
    // Nothing disposed, nothing flipped.
    assert.deepEqual(await store.readMigrationOutcomes('mig-1'), []);
    assert.equal((await store.outboxPending()).length, 2);
  });

  it('blocks pinned ids that are no longer pending', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    await seedOutbox(store, [{ intentId: 'i-1' }]);
    const plan = invalidatePlan();
    await stageAndValidate(store, plan);
    const error = await captureStateError(() =>
      activateWith(store, plan, [inventoryItem('i-ghost', CONTRACT)]),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /not pending/);
    assert.ok(error.message.includes('i-ghost'));
  });

  it('blocks unknown inventory states', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    const plan = invalidatePlan();
    await stageAndValidate(store, plan);
    const error = await captureStateError(() =>
      activateWith(store, plan, [
        { intentId: 'i-1', handlerContract: CONTRACT, state: 'parked' } as unknown as WorkInventoryItem,
      ]),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /unknown state/);
  });
});
