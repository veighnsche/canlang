/**
 * Lane 03 B3-I1 retention tests: in-flight and unpinned undispatched work
 * survives the flip through the retained set (re-validated against stored
 * outbox evidence, re-pinned to its contract) and dispatches post-migration.
 * Without a retained set the gate still blocks unpinned undispatched work,
 * and accepted/uncertain work still blocks always. Memory StoragePort.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ModelName,
  OperationId,
  OutboxIntent,
  StoragePort,
  StoredRow,
  WorkInventoryItem,
} from '@canlang/contracts';
import {
  activate,
  checkActivationInventory,
  resumeMigration,
  stageNextChunk,
  validateStaged,
  validateTransition,
  type MigrationMapper,
  type ValidatedMigrationPlan,
} from '../../src/migration/index.js';
import { computeRetainedCarryover } from '../../src/migration/retain.js';
import {
  TODO_MODEL,
  asModel,
  asOperation,
  asRevision,
  captureStateError,
  fixedClock,
  installSnapshot,
  makeBatch,
  makeInstalled,
  makeTransition,
  oldLocks,
  seedLive,
  setupMigrationWorld,
  todoDirectives,
  todoPlan,
  todoTables,
} from './fixtures.js';

const asOperationId = (s: string): OperationId => s as OperationId;

/** Ack-only commit batch (the shared makeBatch predates outboxAck). */
function ackBatch(revision: number, intentIds: ReadonlyArray<string>) {
  return { ...makeBatch(revision), outboxAck: intentIds };
}

function priorityMapper(): MigrationMapper {
  return (before, row) => {
    row.set('priority', before.data['done'] === true ? 'low' : 'normal');
  };
}

function todoMappers(): ReadonlyMap<ModelName, MigrationMapper> {
  return new Map([[asModel(TODO_MODEL), priorityMapper()]]);
}

/** Stage a pending outbox intent carrying its stored handler contract. */
async function seedContractedOutbox(
  store: StoragePort,
  intents: ReadonlyArray<{ readonly intentId: string; readonly handlerContract: string }>,
): Promise<OutboxIntent[]> {
  const staged: OutboxIntent[] = intents.map((intent, index) => ({
    intentId: intent.intentId,
    operation: asOperation('acme.worker'),
    operationId: asOperationId(`0193${String(index).padStart(28, '0')}`),
    target: 'worker',
    arguments: {},
    occurrenceIndex: index,
    handlerContract: intent.handlerContract,
  }));
  const revision = await store.readRevision();
  await store.commit(makeBatch(revision as number, { outbox: staged }));
  return staged;
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

describe('retention: carry-over through the flip', () => {
  it('in-flight intent survives the flip and dispatches post-migration', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    await installSnapshot(store, makeInstalled());
    await seedContractedOutbox(store, [{ intentId: 'w-1', handlerContract: 'acme.cleanup' }]);
    const plan = todoPlan();
    const inventory: WorkInventoryItem[] = [
      { intentId: 'w-1', handlerContract: 'acme.cleanup', state: 'inflight' },
    ];
    const carryover = computeRetainedCarryover({
      plan,
      inventory,
      pending: await store.outboxPending(),
    });
    assert.deepEqual([...carryover.retained.ids], ['w-1']);
    assert.deepEqual(carryover.invalidatedIntentIds, []);
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
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'active');
    // Retained, not skipped: still pending, dispatchable after the flip.
    assert.deepEqual(
      (await store.outboxPending()).map((intent) => intent.intentId),
      ['w-1'],
    );
    const revision = await store.readRevision();
    await store.commit(ackBatch(revision as number, ['w-1']));
    assert.deepEqual(await store.outboxPending(), []);
  });

  it('unpinned undispatched still blocks without a retained set', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    await installSnapshot(store, makeInstalled());
    await seedContractedOutbox(store, [{ intentId: 'w-2', handlerContract: 'acme.cleanup' }]);
    const plan = todoPlan();
    await stageAndValidate(store, plan);
    const { oldModels, desiredModels } = todoTables();
    const inventory: WorkInventoryItem[] = [
      { intentId: 'w-2', handlerContract: 'acme.cleanup', state: 'undispatched' },
    ];
    const error = await captureStateError(() =>
      activate({ store, plan, inventory, oldModels, desiredModels, chunkSize: 10, clock: fixedClock() }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /no pinned invalidate contract/);
    assert.equal((await store.readMigrationProgress('mig-1'))?.phase, 'staged');
  });

  it('retained set exempts unpinned undispatched and resume carries it', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    await installSnapshot(store, makeInstalled());
    await seedContractedOutbox(store, [{ intentId: 'w-3', handlerContract: 'acme.cleanup' }]);
    const plan = todoPlan();
    const inventory: WorkInventoryItem[] = [
      { intentId: 'w-3', handlerContract: 'acme.cleanup', state: 'undispatched' },
    ];
    const carryover = computeRetainedCarryover({
      plan,
      inventory,
      pending: await store.outboxPending(),
    });
    assert.deepEqual([...carryover.retained.ids], ['w-3']);
    await stageAndValidate(store, plan);
    // Flip through the publishing leg of resume (retained set carried).
    const { oldModels, desiredModels } = todoTables();
    const revision = await store.readRevision();
    await store.stageMigrationRows({
      expectedRevision: revision,
      migrationId: 'mig-1',
      rows: [],
      progress: {
        migrationId: 'mig-1',
        phase: 'publishing',
        stagedCursor: null,
        publishCursor: null,
        updatedRevision: asRevision(revision as number),
      },
    });
    const resumed = await resumeMigration({
      store,
      plan,
      mappers: todoMappers(),
      oldModels,
      desiredModels,
      oldLocks: oldLocks([]),
      inventory,
      retained: carryover.retained,
      chunkSize: 10,
      clock: fixedClock(),
    });
    assert.equal(resumed.progress?.phase, 'active');
    assert.deepEqual(
      (await store.outboxPending()).map((intent) => intent.intentId),
      ['w-3'],
    );
  });

  it('mixed invalidate + retained: pinned skips, retained stays pending', async () => {
    const { store } = setupMigrationWorld();
    await seedLive(store, TODO_MODEL, [{ id: 'a', data: { label: 'a', done: true } }]);
    await installSnapshot(store, makeInstalled());
    await seedContractedOutbox(store, [
      { intentId: 'w-drop', handlerContract: 'acme.old' },
      { intentId: 'w-keep', handlerContract: 'acme.cleanup' },
    ]);
    const { oldModels, desiredModels } = todoTables();
    const plan = validateTransition(
      makeInstalled(),
      makeTransition({
        directives: [...todoDirectives(), { kind: 'invalidate', handlerContract: 'acme.old' }],
      }),
      oldModels,
      desiredModels,
    );
    const inventory: WorkInventoryItem[] = [
      { intentId: 'w-drop', handlerContract: 'acme.old', state: 'undispatched' },
      { intentId: 'w-keep', handlerContract: 'acme.cleanup', state: 'inflight' },
    ];
    const carryover = computeRetainedCarryover({
      plan,
      inventory,
      pending: await store.outboxPending(),
    });
    assert.deepEqual([...carryover.retained.ids], ['w-keep']);
    assert.deepEqual(carryover.invalidatedIntentIds, ['w-drop']);
    await stageAndValidate(store, plan);
    await activate({
      store,
      plan,
      inventory,
      retained: carryover.retained,
      oldModels,
      desiredModels,
      chunkSize: 10,
      clock: fixedClock(),
    });
    assert.deepEqual(
      (await store.outboxPending()).map((intent) => intent.intentId),
      ['w-keep'],
    );
    const outcomes = await store.readMigrationOutcomes('mig-1');
    assert.deepEqual(
      outcomes.map((o) => o.intentId),
      ['w-drop'],
    );
  });
});

describe('retention: gate backstops', () => {
  it('accepted and uncertain work still block carry-over', async () => {
    const { store } = setupMigrationWorld();
    await seedContractedOutbox(store, [
      { intentId: 'w-a', handlerContract: 'acme.cleanup' },
      { intentId: 'w-u', handlerContract: 'acme.cleanup' },
    ]);
    const plan = todoPlan();
    const inventory: WorkInventoryItem[] = [
      { intentId: 'w-a', handlerContract: 'acme.cleanup', state: 'accepted' },
      { intentId: 'w-u', handlerContract: 'acme.cleanup', state: 'uncertain' },
    ];
    let error: unknown = null;
    try {
      computeRetainedCarryover({ plan, inventory, pending: await store.outboxPending() });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.match(error.message, /drain\/reconcile first/);
  });

  it('attestation mismatch against the stored contract blocks', async () => {
    const { store } = setupMigrationWorld();
    await seedContractedOutbox(store, [{ intentId: 'w-x', handlerContract: 'acme.real' }]);
    const plan = todoPlan();
    const inventory: WorkInventoryItem[] = [
      { intentId: 'w-x', handlerContract: 'acme.forged', state: 'inflight' },
    ];
    let error: unknown = null;
    try {
      computeRetainedCarryover({ plan, inventory, pending: await store.outboxPending() });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.match(error.message, /contract mismatch/);
  });

  it('retained evidence that vanishes still blocks the gate', async () => {
    const { store } = setupMigrationWorld();
    await seedContractedOutbox(store, [{ intentId: 'w-gone', handlerContract: 'acme.cleanup' }]);
    const plan = todoPlan();
    const inventory: WorkInventoryItem[] = [
      { intentId: 'w-gone', handlerContract: 'acme.cleanup', state: 'undispatched' },
    ];
    const carryover = computeRetainedCarryover({
      plan,
      inventory,
      pending: await store.outboxPending(),
    });
    // Dispatch (ack) the intent after carry-over computed: evidence changed.
    const revision = await store.readRevision();
    await store.commit(ackBatch(revision as number, ['w-gone']));
    const error = await captureStateError(() =>
      checkActivationInventory(store, plan, inventory, carryover.retained),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /evidence changed/);
  });

  it('missing stored contract falls back to attestation loudly', async () => {
    const { store } = setupMigrationWorld();
    // Legacy intent with no stored contract field (pre-B3 row).
    const legacy: OutboxIntent = {
      intentId: 'w-legacy',
      operation: asOperation('acme.worker'),
      operationId: 'op-legacy' as OperationId,
      target: 'worker',
      arguments: {},
      occurrenceIndex: 0,
    };
    assert.ok(!('handlerContract' in legacy));
    const revision = await store.readRevision();
    await store.commit(makeBatch(revision as number, { outbox: [legacy] }));
    const plan = todoPlan();
    const inventory: WorkInventoryItem[] = [
      { intentId: 'w-legacy', handlerContract: 'acme.cleanup', state: 'inflight' },
    ];
    const carryover = computeRetainedCarryover({
      plan,
      inventory,
      pending: await store.outboxPending(),
    });
    assert.deepEqual([...carryover.retained.ids], ['w-legacy']);
    assert.equal(carryover.retained.intents[0]?.handlerContract, 'acme.cleanup');
  });
});
