/** Narrow checked singular-ref null controls; hand-built pipeline cases are labeled. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredRow } from '@canlang/contracts';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '../invocation/registry.js';
import { buildModelTable, buildModelTableFromCanonical, type InterimFieldDef } from './models.js';
import { generatedCrudExecute } from './crud.js';
import { runMutationWrites } from './pipeline.js';
import { invoke } from '../invocation/invoke.js';
import { buildContext } from '../invocation/context.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { FIXED_NOW, asId, asModel, asOperation, captureStateError, createMemoryIdentityStore,
  makeEnvelope, makeIdentity, seedMember, uuidv7 } from '../../test/invocation/fixtures.js';
import { modelDef } from '../../test/mutation/fixtures.js';

const ACCOUNT = 'Null.Account', JOB = 'Null.Job';
let sequence = 9000;
const nextId = () => uuidv7(FIXED_NOW, ++sequence);
function slice(): ArtifactDescriptorSlice {
  const account = { name: 'account', field: { kind: 'ref' as const, model: ACCOUNT, requireVersion: true }, required: false, nullable: true };
  return { artifact_version: 1, models: [
    { name: ACCOUNT, fields: [], deleteMode: 'archive' },
    { name: JOB, fields: [{ name: 'account', field: { kind: 'ref', model: ACCOUNT }, required: false, serverOnly: false, nullable: true }], deleteMode: 'archive' },
  ], operations: [
    { name: `${ACCOUNT}.create`, kind: 'create', description: '', inputs: { fields: [] } },
    { name: `${JOB}.create`, kind: 'create', description: '', inputs: { fields: [account] } },
    { name: `${JOB}.update`, kind: 'update', description: '', inputs: { fields: [
      { name: 'record', field: { kind: 'ref', model: JOB, requireVersion: true }, required: true }, account,
    ] } },
  ] };
}
async function setup() {
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ membership: member.membership });
  const loaded = loadArtifactDescriptors(slice(), { by: 'members' });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, nullableFields: loaded.nullableFields });
  const args = { app: 'nullable-test', source: 'test', store, memberships, identity,
    clock: { nowMs: () => FIXED_NOW }, registry: loaded.registry, execute: generatedCrudExecute({ table, store }) };
  const call = (operation: string, inputs: Record<string, unknown>, id = nextId()) =>
    invoke({ ...args, envelope: makeEnvelope(operation, id, inputs) });
  return { store, identity, call };
}
const ref = (row: StoredRow) => ({ id: row.id, version: String(row.version) });

describe('nullable singular refs through loaded generated CRUD', () => {
  it('fills omitted null, accepts explicit null and replays creation without another commit', async () => {
    const world = await setup();
    for (const inputs of [{}, { account: null }]) {
      const id = nextId();
      const result = await world.call(`${JOB}.create`, inputs, id);
      assert.equal(result.status, 'committed');
      const row = result.result as StoredRow;
      assert.deepEqual(row.data, { account: null });
      assert.equal(row.version, 1);
      assert.deepEqual((await world.store.load(asModel(JOB), row.id))?.data, { account: null });
      const revision = await world.store.readRevision();
      const replay = await world.call(`${JOB}.create`, inputs, id);
      assert.equal(replay.status, 'replayed');
      assert.deepEqual(replay.result, result.result);
      assert.equal(await world.store.readRevision(), revision);
    }
  });
  it('clears a current ref with one version bump; preserves update omission and stale refusal', async () => {
    const world = await setup();
    const account = (await world.call(`${ACCOUNT}.create`, {})).result as StoredRow;
    const job = (await world.call(`${JOB}.create`, { account: ref(account) })).result as StoredRow;
    const omitted = (await world.call(`${JOB}.update`, { record: ref(job) })).result as StoredRow;
    assert.deepEqual(omitted.data.account, ref(account));
    const cleared = (await world.call(`${JOB}.update`, { record: ref(omitted), account: null })).result as StoredRow;
    assert.equal(cleared.data.account, null);
    assert.equal(cleared.version, omitted.version + 1);
    const stale = await captureStateError(world.call(`${JOB}.update`, { record: ref(omitted), account: null }));
    assert.equal(stale.code, 'conflict');
    assert.deepEqual(await world.store.load(asModel(JOB), job.id), cleared);
    const restored = (await world.call(`${JOB}.update`, { record: ref(cleared), account: ref(account) })).result as StoredRow;
    assert.deepEqual(restored.data.account, ref(account));
    assert.equal(restored.version, cleared.version + 1);
    const missing = await captureStateError(world.call(`${JOB}.create`, { account: { id: 'absent', version: '1' } }));
    assert.equal(missing.code, 'not_found');
  });
});

describe('direct pipeline null boundaries (hand-built controls)', () => {
  it('requires an own top-level nullable singular field; leaves other refusals unchanged', async () => {
    const { store } = createTestMemoryStorage();
    const context = buildContext({ identity: makeIdentity(), operation: asOperation(`${JOB}.create`),
      operationId: nextId(), app: 'nullable-test', source: 'test', now: FIXED_NOW });
    const run = (field: InterimFieldDef | undefined, path = 'account', fields?: Record<string, InterimFieldDef>) => {
      const table = buildModelTable([
        modelDef(ACCOUNT),
        modelDef(JOB, { fields: fields ?? (field === undefined ? {} : { account: field }), refs: [{ field: path, model: asModel(ACCOUNT) }] }),
      ]);
      const data = path.includes('.') ? { account: { nested: null } } : { account: null };
      return runMutationWrites({ table, store, context, writes: [{ op: 'create', model: asModel(JOB), id: asId(nextId()), data }] });
    };
    const optional = { required: false, serverOnly: false };
    const accepted = await run({ ...optional, nullable: true });
    assert.equal(accepted.writes.length, 1);
    for (const field of [optional, Object.assign(Object.create({ nullable: true }) as InterimFieldDef, optional), { ...optional, nullable: false }, { ...optional, nullable: true, array: { required: false } }]) {
      const error = await captureStateError(run(field));
      assert.equal(error.code, 'validation');
      assert.match(error.message, /Invalid reference/);
    }
    const unknown = await captureStateError(run(undefined));
    assert.match(unknown.message, /Unknown field/);
    const nested = await captureStateError(run({ ...optional, nullable: true }, 'account.nested'));
    assert.match(nested.message, /Invalid reference/);
    const required = await captureStateError(run({ ...optional, nullable: true, required: true }));
    assert.equal(required.code, 'validation');
    assert.doesNotMatch(required.message, /Invalid reference/);
    const protectedField = await captureStateError(run({ ...optional, nullable: true, serverOnly: true }));
    assert.match(protectedField.message, /server-only/);
    assert.equal(await store.readRevision(), 0);
  });
});
