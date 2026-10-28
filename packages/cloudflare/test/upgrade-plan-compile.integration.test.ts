/** B25 plan compilation: compiled transitions drive the real coordinator to active. */
import assert from 'node:assert/strict';
import { it } from 'vitest';
import type { ModelName, UpgradePlan } from '@canlang/contracts';
import { buildModelTable } from '@canlang/state';
import {
  compileMigrationTransition,
  mintModelSnapshot,
  type MigrationMapper,
} from '@canlang/state/migration';
import { asId, asModel } from '@canlang/state/testing/invocation/fixtures';
import {
  TODO_MODEL,
  fixedClock,
  installSnapshot,
  makeInstalled,
  oldLocks,
  oldTodoDef,
  seedLive,
  setupMigrationWorld,
  todoDirectives,
  todoTables,
} from '@canlang/state/testing/migration/fixtures';
import { coordinateUpgrade } from '../src/upgrade/coordinate.js';

const DIRECTIVE_SET = (directives: ReadonlyArray<unknown>): ReadonlyArray<string> =>
  [...directives].map(directive => JSON.stringify(directive)).sort();

function todoMapper(): MigrationMapper {
  return (before, row) => {
    row.set('title', before.data.label);
    row.set('done', before.data.done);
    row.set('priority', 'normal');
  };
}

function planFor(fromSnapshotId: string): UpgradePlan {
  return {
    from: [{ owner: 'acme', snapshotId: fromSnapshotId }],
    to: {
      appName: 'Tasks',
      sourceRevision: 'rev-compiled',
      languageVersion: '1.0',
      compilerVersion: '0.1.2',
      contractsVersion: 1,
      artifactDigest: 'artifact-compiled',
    },
    pendingWork: [],
  };
}

it('compiles the Todo illustration and drives it to active with migrated rows', async () => {
  const { oldModels, desiredModels } = todoTables();
  const transition = await compileMigrationTransition({
    owner: 'acme',
    oldModels,
    desiredModels,
    fieldRenames: [{ model: TODO_MODEL, field: 'label', to: 'title' }],
    fieldDrops: [{ model: TODO_MODEL, field: 'legacy' }],
  });
  // The compiled directives match the hand-maintained engine illustration
  // (order-independent: the engine validates directive sets).
  assert.deepEqual(DIRECTIVE_SET(transition.directives), DIRECTIVE_SET(todoDirectives()));
  assert.match(transition.fromSnapshotId, /^snap-v1:[0-9a-f]{64}$/);
  assert.equal(transition.fromDigest, transition.fromSnapshotId);
  assert.match(transition.toSnapshotId, /^snap-v1:[0-9a-f]{64}$/);
  assert.match(transition.bodyDigest, /^body-v1:[0-9a-f]{64}$/);

  const { store } = setupMigrationWorld();
  await installSnapshot(store, makeInstalled({
    snapshotId: transition.fromSnapshotId,
    digest: transition.fromDigest,
  }));
  await seedLive(store, TODO_MODEL, [
    { id: 'todo-0', data: { label: 'task 0', done: false, legacy: 'old-0' } },
    { id: 'todo-1', data: { label: 'task 1', done: true, legacy: 'old-1' } },
  ]);
  const state = await coordinateUpgrade({
    store,
    plan: planFor(transition.fromSnapshotId),
    owners: new Map([['acme', {
      transition,
      mappers: new Map<ModelName, MigrationMapper>([[asModel(TODO_MODEL), todoMapper()]]),
      oldModels,
      desiredModels,
      oldLocks: oldLocks([]),
      inventory: [],
    }]]),
    chunkSize: 2,
    clock: fixedClock(),
  });
  assert.equal(state.stage, 'active');
  const installed = await store.readInstalledSnapshot('acme');
  assert.equal(installed?.snapshotId, transition.toSnapshotId);
  assert.equal(installed?.digest, transition.toDigest);
  const progress = await store.readMigrationProgress(transition.migrationId);
  assert.equal(progress?.phase, 'active');
  const live = await store.query({ model: asModel(TODO_MODEL), authority: 'owner' });
  assert.equal(live.length, 2);
  for (const row of live) {
    assert.equal(row.data.title, row.id === asId('todo-0') ? 'task 0' : 'task 1');
    assert.equal(row.data.done, row.id === asId('todo-1'));
    assert.equal(row.data.priority, 'normal');
    assert.ok(!('label' in row.data) && !('legacy' in row.data));
  }
});

it('refuses ambiguous entries, no-change plans, and dangling declarations', async () => {
  const { oldModels, desiredModels } = todoTables();
  await assert.rejects(
    compileMigrationTransition({ owner: 'acme', oldModels, desiredModels }),
    /refuses ambiguous entries/,
  );
  await assert.rejects(
    compileMigrationTransition({ owner: 'acme', oldModels, desiredModels: oldModels }),
    /changes nothing/,
  );
  await assert.rejects(
    compileMigrationTransition({ owner: 'acme', oldModels, desiredModels,
      fieldRenames: [{ model: TODO_MODEL, field: 'missing', to: 'title' }],
      fieldDrops: [{ model: TODO_MODEL, field: 'legacy' }] }),
    /unknown old field/,
  );
  // A definition-only change (required flip, no name movement) still
  // compiles: empty directives that move the digest pointer.
  const relabeled = buildModelTable([oldTodoDef()]);
  const flipped = buildModelTable([{ ...oldTodoDef(),
    fields: { ...oldTodoDef().fields, label: { ...oldTodoDef().fields.label!, required: false } } }]);
  const meta = await compileMigrationTransition({ owner: 'acme', oldModels: relabeled, desiredModels: flipped });
  assert.deepEqual(meta.directives, []);
  assert.notEqual(meta.fromSnapshotId, meta.toSnapshotId);
});

it('refuses a drifted store: tampered digests never migrate', async () => {
  const { oldModels, desiredModels } = todoTables();
  const transition = await compileMigrationTransition({
    owner: 'acme',
    oldModels,
    desiredModels,
    fieldRenames: [{ model: TODO_MODEL, field: 'label', to: 'title' }],
    fieldDrops: [{ model: TODO_MODEL, field: 'legacy' }],
  });
  const { store } = setupMigrationWorld();
  await installSnapshot(store, makeInstalled({
    snapshotId: transition.fromSnapshotId,
    digest: 'snap-v1:tampered-digest-that-matches-nothing-0000000000000000000000000000',
  }));
  await seedLive(store, TODO_MODEL, [{ id: 'todo-0', data: { label: 'task 0', done: false } }]);
  const state = await coordinateUpgrade({
    store,
    plan: planFor(transition.fromSnapshotId),
    owners: new Map([['acme', {
      transition,
      mappers: new Map<ModelName, MigrationMapper>([[asModel(TODO_MODEL), todoMapper()]]),
      oldModels,
      desiredModels,
      oldLocks: oldLocks([]),
      inventory: [],
    }]]),
    chunkSize: 2,
    clock: fixedClock(),
  });
  assert.equal(state.stage, 'staging-failed');
  assert.equal(state.failure?.recoverable, false);
  assert.match(state.failure?.reason ?? '', /predecessor mismatch|binding refused/);
  // The tampered pointer is untouched: no partial migration wrote.
  const installed = await store.readInstalledSnapshot('acme');
  assert.equal(installed?.snapshotId, transition.fromSnapshotId);
  assert.ok(installed?.digest.startsWith('snap-v1:tampered'));
});

it('compiles owner removal onto an empty desired table', async () => {
  const { oldModels } = todoTables();
  const empty = buildModelTable([]);
  const transition = await compileMigrationTransition({
    owner: 'acme',
    oldModels,
    desiredModels: empty,
    dropOwner: true,
  });
  assert.deepEqual(transition.directives, [{ kind: 'dropOwner' }]);
  assert.deepEqual(await mintModelSnapshot(empty), {
    snapshotId: transition.toSnapshotId,
    digest: transition.toDigest,
  });
});
