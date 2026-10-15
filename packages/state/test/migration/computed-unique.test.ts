/** Computed-key migration join: pre-flip collision validation plus old/new claim moves at publish.
 * BGI-08 repair: desired `givenUniqueKeys` rules evaluate over staged data and retained-live
 * rows exactly like builtin keys, and activation installs/releases their State-owned claims. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, StoragePort } from '@canlang/contracts';
import { StorageConstraintError } from '../../src/storage/port.js';
import { StateError } from '../../src/errors.js';
import { buildModelTable, type ModelTable } from '../../src/mutation/models.js';
import { givenUniqueKeyName } from '../../src/effects/staging.js';
import { stageNextChunk, validateStaged, validateTransition, activate, type ValidatedMigrationPlan } from '../../src/migration/index.js';
import { field, modelDef, makeInstalled, makeTransition, oldLocks, seedLive, setupMigrationWorld, asId, asModel, makeRow, makeBatch, fixedClock, installSnapshot } from './fixtures.js';

const MODEL = 'acme.Account';
const RULE = 'acme.Account.handle#canonical_identity';
const KEY = givenUniqueKeyName(RULE);
const canonical = (value: string): string => value.normalize('NFKC').replace(/[A-Z]/g, (c) => c.toLowerCase());
const handleField = () => ({ ...field({ required: true }), valueType: 'text' as CanTypeId });
const refusesValidation = (error: unknown): boolean => error instanceof StateError && error.code === 'validation';

async function stageAll(store: StoragePort, plan: ValidatedMigrationPlan, oldModels: ModelTable, desiredModels: ModelTable): Promise<void> {
  for (;;) {
    const staged = await stageNextChunk({ store, plan, mappers: new Map(), oldModels, desiredModels, chunkSize: 10 });
    if (staged.done) return;
  }
}

test('desired field checks refuse invalid staged and retained rows before activation', async () => {
  for (const renamed of [false, true]) {
    const { store } = setupMigrationWorld();
    const oldField = renamed ? 'login' : 'handle';
    const oldModels = buildModelTable([modelDef(MODEL, { fields: { [oldField]: handleField() } })]);
    const desiredModels = buildModelTable([{ ...modelDef(MODEL, { fields: { handle: handleField() } }),
      givenFieldValidations: [{ rule: 'budget', field: 'handle', evaluate: (value: string) => new TextEncoder().encode(value).byteLength <= 128 }],
    }]);
    const installed = makeInstalled();
    await installSnapshot(store, installed);
    await seedLive(store, MODEL, [{ id: 'a', data: { [oldField]: 'é'.repeat(65) } }]);
    const plan = validateTransition(installed, makeTransition({ directives: renamed ? [{ kind: 'renameField', model: MODEL, from: 'login', to: 'handle' }] : [] }), oldModels, desiredModels);
    await stageAll(store, plan, oldModels, desiredModels);
    const before = await store.load(asModel(MODEL), asId('a'));
    await assert.rejects(validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) }), refusesValidation);
    assert.equal((await store.readMigrationProgress(plan.migrationId))?.phase, 'staging');
    assert.deepEqual(await store.load(asModel(MODEL), asId('a')), before);
    assert.equal((await store.readInstalledSnapshot('acme'))?.snapshotId, installed.snapshotId);
  }
});

test('field checks admit a valid desired schema and recheck before any publish chunk', async () => {
  const { store } = setupMigrationWorld();
  const oldModels = buildModelTable([modelDef(MODEL, { fields: { handle: handleField() } })]);
  let allow = true;
  const desiredModels = buildModelTable([{ ...modelDef(MODEL, { fields: { handle: handleField() } }),
    givenFieldValidations: [{ rule: 'budget', field: 'handle', evaluate: () => allow }],
  }]);
  const installed = makeInstalled();
  await installSnapshot(store, installed);
  await seedLive(store, MODEL, [{ id: 'a', data: { handle: 'Valid' } }]);
  const plan = validateTransition(installed, makeTransition(), oldModels, desiredModels);
  await stageAll(store, plan, oldModels, desiredModels);
  assert.equal((await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) })).phase, 'staged');
  allow = false;
  await assert.rejects(activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 1, clock: fixedClock() }), refusesValidation);
  assert.equal((await store.readInstalledSnapshot('acme'))?.snapshotId, installed.snapshotId);
  allow = true;
  assert.equal((await activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 1, clock: fixedClock() })).flipped, true);
});

test('colliding computed keys refuse before activation without changing claims or snapshot', async () => {
  const { store } = setupMigrationWorld();
  const oldModels = buildModelTable([modelDef(MODEL, { fields: { handle: handleField() } })]);
  let evaluations = 0;
  const desiredModels = buildModelTable([{
    ...modelDef(MODEL, { fields: { handle: handleField() } }),
    givenUniqueKeys: [{ rule: RULE, field: 'handle', evaluate: (value: string) => { evaluations += 1; return canonical(value); } }],
  }]);
  const installed = makeInstalled();
  await installSnapshot(store, installed);
  await seedLive(store, MODEL, [{ id: 'a', data: { handle: 'Ａlice' } }, { id: 'b', data: { handle: 'Alice' } }]);
  const plan = validateTransition(installed, makeTransition(), oldModels, desiredModels);
  await stageAll(store, plan, oldModels, desiredModels);
  await assert.rejects(
    validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) }),
    (error: unknown) => refusesValidation(error) && /duplicate computed-key value/.test((error as StateError).message),
  );
  assert.ok(evaluations > 0);
  assert.equal((await store.readMigrationProgress(plan.migrationId))?.phase, 'staging');
  await assert.rejects(
    activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 10, clock: fixedClock() }),
    (error: unknown) => refusesValidation(error) && /needs a staged set/.test((error as StateError).message),
  );
  const kept = await store.readInstalledSnapshot('acme');
  assert.equal(kept?.snapshotId, installed.snapshotId);
  assert.equal(kept?.digest, installed.digest);
  await store.commit(makeBatch(await store.readRevision(), { uniqueClaims: [
    { model: asModel(MODEL), keyName: KEY, keyValue: 'alice', recordId: asId('probe') },
  ] }));
});

test('noncolliding changed-code activation installs new computed claims and releases old ones', async () => {
  const { store } = setupMigrationWorld();
  let oldEvaluations = 0;
  let newEvaluations = 0;
  const fields = { handle: handleField() };
  const oldModels = buildModelTable([{
    ...modelDef(MODEL, { fields }),
    givenUniqueKeys: [{ rule: RULE, field: 'handle', evaluate: (value: string) => { oldEvaluations += 1; return value.normalize('NFKC'); } }],
  }]);
  const desiredModels = buildModelTable([{
    ...modelDef(MODEL, { fields }),
    givenUniqueKeys: [{ rule: RULE, field: 'handle', evaluate: (value: string) => { newEvaluations += 1; return canonical(value); } }],
  }]);
  const installed = makeInstalled();
  await installSnapshot(store, installed);
  for (const [id, handle] of [['a', 'Alice'], ['b', 'Bob']] as const) {
    const row = makeRow({ id, data: { handle } });
    await store.commit(makeBatch(await store.readRevision(), {
      writes: [{ kind: 'insert', model: asModel(MODEL), row }],
      uniqueClaims: [{ model: asModel(MODEL), keyName: KEY, keyValue: handle.normalize('NFKC'), recordId: row.id }],
    }));
  }
  const plan = validateTransition(installed, makeTransition(), oldModels, desiredModels);
  await stageAll(store, plan, oldModels, desiredModels);
  assert.equal((await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) })).phase, 'staged');
  const result = await activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 10, clock: fixedClock() });
  assert.equal(result.flipped, true);
  assert.ok(oldEvaluations > 0 && newEvaluations > 0);
  assert.equal((await store.readMigrationProgress(plan.migrationId))?.phase, 'active');
  assert.equal((await store.readInstalledSnapshot('acme'))?.snapshotId, 'snap-2');
  assert.equal((await store.load(asModel(MODEL), asId('a')))?.data['handle'], 'Alice');
  assert.equal((await store.load(asModel(MODEL), asId('b')))?.data['handle'], 'Bob');
  for (const keyValue of ['alice', 'bob']) {
    await assert.rejects(
      store.commit(makeBatch(await store.readRevision(), { uniqueClaims: [
        { model: asModel(MODEL), keyName: KEY, keyValue, recordId: asId('blocked') },
      ] })),
      (error: unknown) => error instanceof StorageConstraintError && error.kind === 'unique',
    );
  }
  await store.commit(makeBatch(await store.readRevision(), { uniqueClaims: [
    { model: asModel(MODEL), keyName: KEY, keyValue: 'Alice', recordId: asId('reused-old-a') },
    { model: asModel(MODEL), keyName: KEY, keyValue: 'Bob', recordId: asId('reused-old-b') },
  ] }));
});

test('staged conversions install computed claims and drops release them', async () => {
  const GONE = 'acme.Gone';
  const GONE_RULE = 'acme.Gone.handle#canonical_identity';
  const GONE_KEY = givenUniqueKeyName(GONE_RULE);
  const { store } = setupMigrationWorld();
  let evaluations = 0;
  const evaluate = (value: string): string => { evaluations += 1; return canonical(value); };
  const oldModels = buildModelTable([
    modelDef(MODEL, { fields: { login: handleField() } }),
    {
      ...modelDef(GONE, { fields: { handle: handleField() } }),
      givenUniqueKeys: [{ rule: GONE_RULE, field: 'handle', evaluate }],
    },
  ]);
  const desiredModels = buildModelTable([
    {
      ...modelDef(MODEL, { fields: { handle: handleField() } }),
      givenUniqueKeys: [{ rule: RULE, field: 'handle', evaluate }],
    },
  ]);
  const installed = makeInstalled();
  await installSnapshot(store, installed);
  await seedLive(store, MODEL, [{ id: 'a', data: { login: 'Alice' } }, { id: 'b', data: { login: 'Bob' } }]);
  const gone = makeRow({ id: 'gone', data: { handle: 'Zed' } });
  await store.commit(makeBatch(await store.readRevision(), {
    writes: [{ kind: 'insert', model: asModel(GONE), row: gone }],
    uniqueClaims: [{ model: asModel(GONE), keyName: GONE_KEY, keyValue: 'zed', recordId: gone.id }],
  }));
  const plan = validateTransition(installed, makeTransition({ directives: [
    { kind: 'renameField', model: MODEL, from: 'login', to: 'handle' },
    { kind: 'dropModel', model: GONE },
  ] }), oldModels, desiredModels);
  await stageAll(store, plan, oldModels, desiredModels);
  assert.equal((await validateStaged({ store, plan, desiredModels, oldModels, oldLocks: oldLocks([]) })).phase, 'staged');
  await activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 10, clock: fixedClock() });
  assert.ok(evaluations > 0);
  for (const keyValue of ['alice', 'bob']) {
    await assert.rejects(
      store.commit(makeBatch(await store.readRevision(), { uniqueClaims: [
        { model: asModel(MODEL), keyName: KEY, keyValue, recordId: asId('blocked') },
      ] })),
      (error: unknown) => error instanceof StorageConstraintError && error.kind === 'unique',
    );
  }
  await store.commit(makeBatch(await store.readRevision(), { uniqueClaims: [
    { model: asModel(GONE), keyName: GONE_KEY, keyValue: 'zed', recordId: asId('reused-drop') },
  ] }));
});
