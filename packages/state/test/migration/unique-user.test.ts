/** Canonical user uniqueness through actual staged and retained migration rows.
 * Validation scope only; native application/migration activation remains separate. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId } from '@canlang/contracts';
import { StorageConstraintError } from '../../src/storage/port.js';
import { StateError } from '../../src/errors.js';
import { buildModelTable } from '../../src/mutation/models.js';
import { stageNextChunk, validateStaged, validateTransition, canonicalUniqueValue, activate, type MigrationMapper } from '../../src/migration/index.js';
import { createMemoryIdentityStore, seedMember } from '../invocation/fixtures.js';
import { field, modelDef, makeInstalled, makeTransition, oldLocks, seedLive, setupMigrationWorld, asId, asModel, makeRow, makeBatch, fixedClock, installSnapshot } from './fixtures.js';

const MODEL = 'UniqueUserMigration.Employee';
const userField = { ...field({ required: true }), valueType: 'user' as CanTypeId };
const refuses = (error: unknown) => error instanceof StateError;
async function validationWorld(staged: boolean, values: readonly unknown[], typed = true, nullable = false) {
  const { store } = setupMigrationWorld(), sourceField = staged ? 'login' : 'user';
  const desiredField = typed ? nullable ? { ...field(), valueType: 'user?' as CanTypeId, nullable: true } : userField : field();
  const oldModels = buildModelTable([modelDef(MODEL, { fields: { [sourceField]: field() } })]);
  const desiredModels = buildModelTable([modelDef(MODEL, { fields: { user: desiredField }, uniqueKeys: ['user'] })]);
  const plan = validateTransition(makeInstalled(), makeTransition({ directives: staged
    ? [{ kind: 'renameField', model: MODEL, from: 'login', to: 'user' }] : [] }), oldModels, desiredModels);
  await seedLive(store, MODEL, values.map((value, index) => ({ id: `employee-${index}`,
    data: value === undefined ? {} : { [sourceField]: value } })));
  const stagedResult = await stageNextChunk({ store, plan, mappers: new Map(), oldModels, desiredModels, chunkSize: 10 });
  assert.equal(stagedResult.done, true);
  assert.equal((await store.readStagedRows(plan.migrationId, null, 100)).length, staged ? values.length : 0);
  return { store, plan, oldModels, desiredModels, oldLocks: oldLocks([]) };
}
async function users() {
  const identities = createMemoryIdentityStore(), first = await seedMember(identities, { isOwner: false });
  const second = await seedMember(identities, { teamId: first.team.team_id, isOwner: false });
  return [{ id: first.user.user_id }, { id: second.user.user_id }] as const;
}

test('desired canonical user uniques reject same actual user in both staged conversion and retained source rows', async () => {
  const [user] = await users();
  for (const staged of [false, true]) {
    const w = await validationWorld(staged, [user, { ...user }]);
    await assert.rejects(validateStaged(w), error => error instanceof StateError && error.code === 'validation' && /duplicate unique/.test(error.message));
    assert.notEqual((await w.store.readMigrationProgress(w.plan.migrationId))?.phase, 'staged');
  }
});

test('different real users validate in complete staged and retained sets without treating user wires as arbitrary objects', async () => {
  const [first, second] = await users();
  for (const staged of [false, true]) {
    const w = await validationWorld(staged, [first, second]);
    assert.equal((await validateStaged(w)).phase, 'staged');
    if (staged) assert.deepEqual((await w.store.readStagedRows(w.plan.migrationId, null, 100)).map(row => row.data.user), [first, second]);
  }
  assert.notEqual(canonicalUniqueValue(first, 'user', MODEL, userField), canonicalUniqueValue(second, 'user', MODEL, userField));
});

test('nullable and retained missing user keys claim none while incomplete staged fields and untyped objects refuse', async () => {
  const [user] = await users();
  for (const staged of [false, true]) {
    const nullable = await validationWorld(staged, [null, null], true, true);
    assert.equal((await validateStaged(nullable)).phase, 'staged');
    if (staged) await assert.rejects(validationWorld(true, [undefined], true, true),
      error => error instanceof StateError && /uninitialized/.test(error.message));
    else {
      const missing = await validationWorld(false, [undefined], true, true);
      assert.equal((await validateStaged(missing)).phase, 'staged');
    }
    const untyped = await validationWorld(staged, [user], false);
    await assert.rejects(validateStaged(untyped), refuses);
  }
  assert.equal(canonicalUniqueValue(null, 'user', MODEL, userField), null);
  assert.equal(canonicalUniqueValue(undefined, 'user', MODEL, userField), null);
});

test('legacy scalar keys remain accepted and object/ref/array or type-wrong user keys remain closed', () => {
  assert.equal(canonicalUniqueValue('legacy', 'user', MODEL), 'legacy');
  assert.equal(canonicalUniqueValue(7, 'user', MODEL), '7');
  assert.equal(canonicalUniqueValue(true, 'user', MODEL), 'true');
  for (const value of [{ id: '' }, { id: 'someone', version: '1' }, { id: 'someone', extra: true }, [{ id: 'someone' }]]) {
    assert.throws(() => canonicalUniqueValue(value, 'user', MODEL, userField), refuses);
  }
  for (const candidate of [undefined, field(), { ...field(), valueType: 'text' as CanTypeId }, { ...field(), valueType: MODEL as CanTypeId },
    { ...field(), valueType: 'user[]' as CanTypeId, array: { required: false } }]) {
    assert.throws(() => canonicalUniqueValue({ id: 'someone' }, 'user', MODEL, candidate), refuses);
  }
});


test('real Memory migration activation moves typed user claims and releases the old and dropped model keys', async () => {
  const [first, second] = await users(), GONE = 'UniqueUserMigration.Gone';
  const { store } = setupMigrationWorld();
  const oldModels = buildModelTable([
    modelDef(MODEL, { fields: { user: userField }, uniqueKeys: ['user'] }),
    modelDef(GONE, { fields: { user: userField }, uniqueKeys: ['user'] }),
  ]);
  const desiredModels = buildModelTable([modelDef(MODEL, { fields: { user: userField }, uniqueKeys: ['user'] })]);
  const firstKey = canonicalUniqueValue(first, 'user', MODEL, userField), secondKey = canonicalUniqueValue(second, 'user', MODEL, userField);
  assert.ok(firstKey !== null && secondKey !== null);
  for (const [name, id] of [[MODEL, 'employee'], [GONE, 'gone']] as const) {
    const row = makeRow({ id, data: { user: first } });
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: asModel(name), row }],
      uniqueClaims: [{ model: asModel(name), keyName: 'user', keyValue: firstKey, recordId: row.id }] }));
  }
  const plan = validateTransition(makeInstalled(), makeTransition({ directives: [
    { kind: 'backfill', model: MODEL }, { kind: 'dropModel', model: GONE },
  ] }), oldModels, desiredModels);
  await installSnapshot(store, makeInstalled());
  const mapper: MigrationMapper = (_before, row) => { row.set('user', second); };
  const staged = await stageNextChunk({ store, plan, oldModels, desiredModels, chunkSize: 10,
    mappers: new Map([[asModel(MODEL), mapper]]) });
  assert.equal(staged.done, true);
  assert.equal((await validateStaged({ store, plan, oldModels, desiredModels, oldLocks: oldLocks([]) })).phase, 'staged');
  await activate({ store, plan, inventory: [], oldModels, desiredModels, chunkSize: 10, clock: fixedClock() });
  assert.deepEqual((await store.load(asModel(MODEL), asId('employee')))!.data.user, second);
  assert.equal(await store.load(asModel(GONE), asId('gone')), null);
  assert.equal((await store.readMigrationProgress(plan.migrationId))!.phase, 'active');
  await assert.rejects(store.commit(makeBatch(await store.readRevision(), { uniqueClaims: [
    { model: asModel(MODEL), keyName: 'user', keyValue: secondKey, recordId: asId('blocked') },
  ] })), error => error instanceof StorageConstraintError && error.kind === 'unique');
  await store.commit(makeBatch(await store.readRevision(), { uniqueClaims: [
    { model: asModel(MODEL), keyName: 'user', keyValue: firstKey, recordId: asId('reused-old') },
    { model: asModel(GONE), keyName: 'user', keyValue: firstKey, recordId: asId('reused-drop') },
  ] }));
});
