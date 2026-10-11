/** Canonical user unique keys through actual CRUD and owner mutation sessions.
 * These memory controls do not qualify the original native app consumer. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId } from '@canlang/contracts';
import { StateError } from '../../src/errors.js';
import { beginOwnerMutation } from '../../src/mutation/pipeline.js';
import { seedMember, makeBatch } from '../invocation/fixtures.js';
import { asId, asModel, crudCreate, crudUpdate, crudRemove, field, invariant, modelDef,
  setupMutation, mustLoad, pipelineContext, refDef } from './fixtures.js';

const MODEL = 'UniqueUser.Employee', model = asModel(MODEL), cause = { cause: 'scenario' } as const;
const userField = { ...field({ required: true }), valueType: 'user' as CanTypeId };
const refuses = (error: unknown) => error instanceof StateError;
function definition(deleteMode: 'archive' | 'remove' = 'remove') {
  return modelDef(MODEL, { fields: { user: userField, note: field() }, uniqueKeys: ['user'], deleteMode });
}

test('required canonical user unique claims distinguish real users and replay identical create without duplicate effects', async () => {
  const w = await setupMutation([definition()]), other = await seedMember(w.memberships, { teamId: w.team.team_id, isOwner: false });
  const user = { id: w.alice.user.user_id }, different = { id: other.user.user_id };
  let executions = 0;
  const counted = { ...w, execute: async (call: Parameters<typeof w.execute>[0]) => { executions++; return w.execute(call); } };
  const created = await crudCreate(counted, MODEL, { id: 'first', data: { user } }); assert.equal(created.out.status, 'committed');
  const revision = await w.store.readRevision();
  const replay = await crudCreate(counted, MODEL, { id: 'first', data: { user }, operationId: created.operationId });
  assert.equal(replay.out.status, 'replayed'); assert.equal(executions, 1); assert.equal(await w.store.readRevision(), revision);
  assert.equal((await w.store.historyFor(model, asId('first'))).length, 1);
  await assert.rejects(crudCreate(w, MODEL, { id: 'duplicate', data: { user: { ...user } } }), error => error instanceof StateError && error.code === 'conflict');
  assert.equal((await crudCreate(w, MODEL, { id: 'second', data: { user: different } })).out.status, 'committed');
  assert.equal(await w.store.load(model, asId('duplicate')), null);
  assert.deepEqual((await mustLoad(w.store, model, 'first')).data.user, user);
});

test('user update moves a unique claim, hard removal releases it and archive retains it', async () => {
  for (const deleteMode of ['remove', 'archive'] as const) {
    const w = await setupMutation([definition(deleteMode)]), other = await seedMember(w.memberships, { teamId: w.team.team_id, isOwner: false });
    const first = { id: w.alice.user.user_id }, second = { id: other.user.user_id };
    await crudCreate(w, MODEL, { id: 'a', data: { user: first } });
    await crudUpdate(w, MODEL, 'a', { version: 1, patch: { user: second } });
    await crudCreate(w, MODEL, { id: 'b', data: { user: first } });
    await assert.rejects(crudUpdate(w, MODEL, 'b', { version: 1, patch: { user: second } }), refuses);
    assert.deepEqual((await mustLoad(w.store, model, 'b')).data.user, first);
    await crudRemove(w, MODEL, 'a', { version: 2 });
    if (deleteMode === 'remove') {
      assert.equal(await w.store.load(model, asId('a')), null);
      assert.equal((await crudCreate(w, MODEL, { id: 'c', data: { user: second } })).out.status, 'committed');
    } else {
      assert.ok((await mustLoad(w.store, model, 'a')).archivedAt !== null);
      await assert.rejects(crudCreate(w, MODEL, { id: 'c', data: { user: second } }), refuses);
    }
  }
});

test('same-owner create and repeated user updates produce one final net claim and one committed row/history version', async () => {
  const w = await setupMutation([definition()]), other = await seedMember(w.memberships, { teamId: w.team.team_id, isOwner: false });
  const user = { id: w.alice.user.user_id }, alternate = { id: other.user.user_id };
  const session = await beginOwnerMutation({ table: w.table, store: w.store, context: pipelineContext({ operation: 'UniqueUser.net' }), bounds: { maxRows: 10, maxWork: 1000 } });
  await session.stage({ op: 'create', model, id: asId('net'), data: { user } }, cause);
  await session.stage({ op: 'update', model, id: asId('net'), data: { user: alternate } }, cause);
  await session.stage({ op: 'update', model, id: asId('net'), data: { user } }, cause);
  const output = await session.finalize();
  assert.equal(output.uniqueClaims.length, 1); assert.deepEqual(output.uniqueReleases, []);
  assert.equal(output.writes.length, 1); assert.equal(output.history.length, 1);
  await w.store.commit(makeBatch(await w.store.readRevision(), output));
  const row = await mustLoad(w.store, model, 'net'); assert.equal(row.version, 1); assert.deepEqual(row.data.user, user);
  await assert.rejects(crudCreate(w, MODEL, { id: 'dup', data: { user } }), refuses);
  assert.equal((await crudCreate(w, MODEL, { id: 'alternate', data: { user: alternate } })).out.status, 'committed');
});

test('late rule failure leaves canonical user claims, rows and history uncommitted', async () => {
  const def = definition(); const w = await setupMutation([{ ...def, invariants: [invariant('valid-note', view => { if (view.get(model, asId('failed'))?.data.note === 'bad') throw new StateError('rule_failed', 'Late bad note'); })] }]);
  const user = { id: w.alice.user.user_id };
  const session = await beginOwnerMutation({ table: w.table, store: w.store, context: pipelineContext({ operation: 'UniqueUser.fail' }), bounds: { maxRows: 10, maxWork: 1000 } });
  await session.stage({ op: 'create', model, id: asId('failed'), data: { user, note: 'good' } }, cause);
  await assert.rejects(async () => {
    await session.stage({ op: 'update', model, id: asId('failed'), data: { note: 'bad' } }, cause);
    await session.finalize();
  }, refuses);
  assert.equal(await w.store.load(model, asId('failed')), null); assert.deepEqual(await w.store.historyFor(model, asId('failed')), []);
  assert.equal((await crudCreate(w, MODEL, { id: 'recovered', data: { user, note: 'good' } })).out.status, 'committed');
});

test('nullable or missing user claims nothing while ordinary objects, refs, arrays and malformed user wires remain refused', async () => {
  const nullable = modelDef(MODEL, { fields: { user: { ...field(), valueType: 'user?' as CanTypeId, nullable: true } }, uniqueKeys: ['user'], deleteMode: 'remove' });
  const w = await setupMutation([nullable]);
  for (const [id, data] of [['null-a', { user: null }], ['null-b', { user: null }], ['missing-a', {}], ['missing-b', {}]] as const) {
    assert.equal((await crudCreate(w, MODEL, { id, data })).out.status, 'committed');
  }
  const user = { id: w.alice.user.user_id };
  for (const value of [{ id: '' }, { ...user, version: '1' }, { ...user, extra: true }, [user], { name: 'not-a-user' }]) {
    const fresh = await setupMutation([definition()]);
    await assert.rejects(crudCreate(fresh, MODEL, { id: 'invalid', data: { user: value } }), refuses);
    assert.equal(await fresh.store.load(model, asId('invalid')), null);
  }
  for (const candidate of [field(), { ...field(), valueType: 'text' as CanTypeId },
    { ...field(), valueType: 'user[]' as CanTypeId, array: { required: false } }]) {
    const fresh = await setupMutation([modelDef(MODEL, { fields: { user: candidate }, uniqueKeys: ['user'] })]);
    await assert.rejects(crudCreate(fresh, MODEL, { id: 'object', data: { user: candidate.valueType === 'user[]' ? [user] : user } }), refuses);
  }
});


test('an actual declared model reference is not promoted to a unique user key', async () => {
  const TARGET = 'UniqueUser.Target';
  const w = await setupMutation([
    modelDef(TARGET, { fields: { name: field() } }),
    modelDef(MODEL, { fields: { user: { ...field({ required: true }), valueType: TARGET as CanTypeId } },
      refs: [refDef('user', TARGET)], uniqueKeys: ['user'] }),
  ]);
  await crudCreate(w, TARGET, { id: 'target', data: { name: 'Actual referenced row' } });
  await assert.rejects(crudCreate(w, MODEL, { id: 'employee', data: { user: { id: 'target' } } }), refuses);
  assert.equal(await w.store.load(model, asId('employee')), null);
});

test('actual artifact user kind derives its canonical field marker without explicit valueType and executes genuine generated CRUD', async () => {
  const { loadArtifactDescriptors } = await import('../../src/invocation/registry.js');
  const { buildModelTableFromCanonical } = await import('../../src/mutation/models.js');
  const { generatedCrudExecute } = await import('../../src/mutation/crud.js');
  const { invoke } = await import('../../src/invocation/invoke.js');
  const { makeEnvelope } = await import('../invocation/fixtures.js');
  const { identityFor, freshOperationId, FIXED_NOW } = await import('./fixtures.js');
  const w = await setupMutation([definition()]);
  const loaded = loadArtifactDescriptors({ artifact_version: 1, models: [{ name: MODEL, deleteMode: 'remove', uniqueKeys: ['user'],
    fields: [{ name: 'user', field: { kind: 'user' }, required: true, serverOnly: false }] }], operations: [{ name: `${MODEL}.create`,
      kind: 'create', description: '', inputs: { fields: [{ name: 'user', field: { kind: 'user' }, required: true }] } }] }, { by: 'members' });
  assert.equal(loaded.models[0]!.fields.user!.valueType, 'user');
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment });
  assert.equal(table.get(model)!.fields.user!.valueType, 'user');
  const user = { id: w.alice.user.user_id };
  const request = { app: 'unique-user-artifact', source: 'test', store: w.store, memberships: w.memberships,
    identity: identityFor(w.alice), registry: loaded.registry, clock: { nowMs: () => FIXED_NOW },
    execute: generatedCrudExecute({ table, store: w.store }) };
  assert.equal((await invoke({ ...request, envelope: makeEnvelope(`${MODEL}.create`, freshOperationId(), { user }) })).status, 'committed');
  await assert.rejects(invoke({ ...request, envelope: makeEnvelope(`${MODEL}.create`, freshOperationId(), { user: { ...user } }) }), refuses);
});
