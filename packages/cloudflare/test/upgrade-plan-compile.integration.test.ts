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

const ARTIFACT_OLD = 'artifact-old-release-digest';
const ARTIFACT_NEW = 'artifact-new-release-digest';

it('compiles the Todo illustration and drives it to active with migrated rows', async () => {
  const { oldModels, desiredModels } = todoTables();
  const transition = await compileMigrationTransition({
    owner: 'acme',
    oldModels,
    desiredModels,
    fromArtifactDigest: ARTIFACT_OLD,
    toArtifactDigest: ARTIFACT_NEW,
    fieldRenames: [{ model: TODO_MODEL, field: 'label', to: 'title' }],
    fieldDrops: [{ model: TODO_MODEL, field: 'legacy' }],
  });
  // The compiled directives match the hand-maintained engine illustration
  // (order-independent: the engine validates directive sets).
  assert.deepEqual(DIRECTIVE_SET(transition.directives), DIRECTIVE_SET(todoDirectives()));
  // Split binding: schema mint ids, artifact digests.
  assert.match(transition.fromSnapshotId, /^snap-v1:[0-9a-f]{64}$/);
  assert.equal(transition.fromDigest, ARTIFACT_OLD);
  assert.match(transition.toSnapshotId, /^snap-v1:[0-9a-f]{64}$/);
  assert.equal(transition.toDigest, ARTIFACT_NEW);
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
  // Gate-3 predicate: the installed digest is the served artifact digest.
  assert.equal(installed?.digest, ARTIFACT_NEW);
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
  const digests = { fromArtifactDigest: ARTIFACT_OLD, toArtifactDigest: ARTIFACT_NEW };
  await assert.rejects(
    compileMigrationTransition({ owner: 'acme', oldModels, desiredModels, ...digests }),
    /refuses ambiguous entries/,
  );
  await assert.rejects(
    compileMigrationTransition({ owner: 'acme', oldModels, desiredModels: oldModels,
      fromArtifactDigest: ARTIFACT_OLD, toArtifactDigest: ARTIFACT_OLD }),
    /changes nothing/,
  );
  await assert.rejects(
    compileMigrationTransition({ owner: 'acme', oldModels, desiredModels, ...digests,
      fieldRenames: [{ model: TODO_MODEL, field: 'missing', to: 'title' }],
      fieldDrops: [{ model: TODO_MODEL, field: 'legacy' }] }),
    /unknown old field/,
  );
  // A definition-only change (required flip, no name movement) still
  // compiles: empty directives that move the snapshot pointer.
  const relabeled = buildModelTable([oldTodoDef()]);
  const flipped = buildModelTable([{ ...oldTodoDef(),
    fields: { ...oldTodoDef().fields, label: { ...oldTodoDef().fields.label!, required: false } } }]);
  const meta = await compileMigrationTransition({ owner: 'acme', oldModels: relabeled, desiredModels: flipped, ...digests });
  assert.deepEqual(meta.directives, []);
  assert.notEqual(meta.fromSnapshotId, meta.toSnapshotId);
  // A code-only release (same schema, new artifact) compiles to a
  // digest-pointer move with empty directives.
  const codeOnly = await compileMigrationTransition({ owner: 'acme', oldModels, desiredModels: oldModels, ...digests });
  assert.deepEqual(codeOnly.directives, []);
  assert.equal(codeOnly.fromSnapshotId, codeOnly.toSnapshotId);
  assert.equal(codeOnly.toDigest, ARTIFACT_NEW);
});

it('refuses a drifted store: tampered digests never migrate', async () => {
  const { oldModels, desiredModels } = todoTables();
  const transition = await compileMigrationTransition({
    owner: 'acme',
    oldModels,
    desiredModels,
    fromArtifactDigest: ARTIFACT_OLD,
    toArtifactDigest: ARTIFACT_NEW,
    fieldRenames: [{ model: TODO_MODEL, field: 'label', to: 'title' }],
    fieldDrops: [{ model: TODO_MODEL, field: 'legacy' }],
  });
  const { store } = setupMigrationWorld();
  await installSnapshot(store, makeInstalled({
    snapshotId: transition.fromSnapshotId,
    digest: 'tampered-artifact-digest-that-matches-nothing',
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
  assert.ok(installed?.digest.startsWith('tampered-artifact'));
});

it('compiles owner removal onto an empty desired table', async () => {
  const { oldModels } = todoTables();
  const empty = buildModelTable([]);
  const transition = await compileMigrationTransition({
    owner: 'acme',
    oldModels,
    desiredModels: empty,
    fromArtifactDigest: ARTIFACT_OLD,
    toArtifactDigest: ARTIFACT_NEW,
    dropOwner: true,
  });
  assert.deepEqual(transition.directives, [{ kind: 'dropOwner' }]);
  assert.deepEqual(await mintModelSnapshot(empty), { snapshotId: transition.toSnapshotId });
  assert.equal(transition.toDigest, ARTIFACT_NEW);
});
