import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, StoredRow } from '@canlang/contracts';
import { encodeValue, validateValue } from '@canlang/values';
import { validateCallInputs } from './admission.js';
import { invoke } from './invoke.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from './registry.js';
import { generatedCrudExecute } from '../mutation/crud.js';
import { buildModelTable } from '../mutation/models.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { StateError } from '../errors.js';
import { field, hook, modelDef } from '../../test/mutation/fixtures.js';
import { FIXED_NOW, asId, asModel, asOperation, asOperationId, createMemoryIdentityStore, makeEnvelope, makeIdentity, seedMember, seedRow, uuidv7 } from '../../test/invocation/fixtures.js';

const RECORD = asModel('Receiving.Record'), CUSTOMER = asModel('Receiving.Customer'), PACKET = 'Receiving.Packet' as CanTypeId;
const CREATE = `${RECORD}.create`, SCENARIO = 'Receiving.accept';
const packetField = { name: 'packet', field: { kind: 'nominal' as const, name: PACKET }, valueType: PACKET, required: true };
function artifact(): ArtifactDescriptorSlice {
  return { artifact_version: 1, models: [
    { name: RECORD, deleteMode: 'archive', fields: [
      { ...packetField, serverOnly: false },
      { name: 'repair', field: { kind: 'boolean' }, required: false, serverOnly: false, default: { kind: 'literal', value: false } },
      { name: 'marker', field: { kind: 'string' }, required: false, serverOnly: false, default: { kind: 'literal', value: 'defaulted' } },
    ] },
    { name: CUSTOMER, deleteMode: 'archive', fields: [] },
  ], valueTypes: { contracts: [{ name: PACKET, fields: [
    { name: 'kind', type: 'text' }, { name: 'model', type: 'text' }, { name: 'id', type: 'text' },
    { name: 'version', type: 'int', min: '1' }, { name: 'title', type: 'text', trim: true, min: 1 },
    { name: 'customer', type: CUSTOMER }, { name: 'selection', type: 'Receiving.Choice|Receiving.Other' },
  ] }, { name: 'Receiving.Choice', fields: [{ name: 'customer', type: CUSTOMER }] },
  { name: 'Receiving.Other', fields: [{ name: 'label', type: 'text' }] }] }, operations: [
    { name: CREATE, kind: 'create', description: '', inputs: { fields: [packetField,
      { name: 'repair', field: { kind: 'boolean' }, required: false },
      { name: 'marker', field: { kind: 'string' }, required: false },
    ] } },
    { name: SCENARIO, kind: 'scenario', description: '', inputs: { fields: [packetField] }, result: { type: 'void' as CanTypeId } },
  ] };
}
const packet = (version = 'bad', reference: Record<string, unknown> = { id: 'customer', version: '2' }) =>
  ({ kind: 'ref', model: 'business-model', id: 'business-id', version, title: '  original  ', customer: reference, selection: { type: 'Receiving.Choice', value: { customer: reference } } });

test('CRUD receiving fields retain rejected receipts and post-default hooks while scenario parameters validate early', async () => {
  const { store } = createTestMemoryStorage(), memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const loaded = loadArtifactDescriptors(artifact(), { by: 'members' });
  assert.ok(loaded.valueSchema);
  const schema = loaded.valueSchema, observed: Array<Record<string, unknown>> = [];
  const table = buildModelTable([
    modelDef(RECORD, { fields: { packet: { ...field({ required: true }), valueType: PACKET },
      repair: { ...field(), default: false }, marker: { ...field(), default: 'defaulted' } }, hooks: [
      hook('repair receiving field', ['create'], candidate => {
        observed.push(structuredClone(candidate));
        if (candidate.repair === true) {
          const original = candidate.packet as ReturnType<typeof packet>;
          return { ...candidate, packet: { ...original, version: '3',
            selection: { type: original.selection.type, value: original.selection.value } } };
        }
        return candidate;
      }),
    ] }),
    modelDef(CUSTOMER, { fields: {} }),
  ], { valueSchema: schema });
  await seedRow(store, CUSTOMER, { id: 'customer', version: 2, data: {} });
  const execute = generatedCrudExecute({ table, store, encodeField: (type, value) => {
    try { return encodeValue(type, validateValue(schema, type, value, 'create'), undefined, schema); }
    catch (error) { throw new StateError('validation', String(error)); }
  } });
  let sequence = 0;
  const args = { app: 'receiving-test', source: 'test', store, memberships, identity,
    registry: loaded.registry, clock: { nowMs: () => FIXED_NOW }, execute };
  const envelope = (operation: string, inputs: Record<string, unknown>) => makeEnvelope(operation, uuidv7(FIXED_NOW, ++sequence), inputs);
  const receipt = (request: ReturnType<typeof envelope>) => store.readReceipt({ app: args.app, owner: member.team.team_id,
    principal: member.user.user_id, operation: asOperation(request.operation), operationId: asOperationId(request.operation_id) });
  const invalid = envelope(CREATE, { packet: packet() });
  await assert.rejects(invoke({ ...args, envelope: invalid }), error => error instanceof StateError && error.code === 'validation');
  assert.equal((await receipt(invalid))?.outcome.status, 'rejected');
  assert.equal(observed.length, 1);
  assert.equal(observed[0]!.marker, 'defaulted');
  assert.deepEqual(observed[0]!.packet, packet());
  assert.deepEqual(await store.query({ model: RECORD, authority: 'owner' }), []);
  assert.deepEqual(await store.historyFor(RECORD, asId(invalid.operation_id)), []);
  const repaired = envelope(CREATE, { packet: packet(), repair: true });
  const result = await invoke({ ...args, envelope: repaired });
  assert.equal(result.status, 'committed');
  assert.deepEqual((result.result as StoredRow).data.packet, { ...packet(), version: '3', title: 'original' });
  assert.deepEqual(observed[1]!.packet, packet());
  const createDef = loaded.registry.get(CREATE)!;
  for (const kind of ['ref', 'file']) {
    const malformedUnion = { ...packet('3'), selection: { kind, model: CUSTOMER, id: 'unproven-container',
      ...packet('3').selection } };
    const validated = validateCallInputs(createDef, { packet: malformedUnion, repair: true });
    const expectedPaths = ['packet/customer', 'packet/selection/value/customer'];
    assert.deepEqual(validated.refs.map(ref => ref.param), expectedPaths);
    const repairedUnion = await invoke({ ...args, envelope: envelope(CREATE, { packet: malformedUnion, repair: true }),
      execute: async call => {
        assert.deepEqual(call.recordRefs.map(ref => ref.param), expectedPaths);
        return execute(call);
      } });
    assert.equal(repairedUnion.status, 'committed');
    assert.deepEqual((repairedUnion.result as StoredRow).data.packet, { ...packet('3'), title: 'original' });
  }
  const staleUnion = envelope(CREATE, { packet: { ...packet('3'), selection: { kind: 'file', id: 'unproven-container',
    type: 'Receiving.Choice', value: { customer: { id: 'customer', version: '1' } } } }, repair: true });
  const beforeStaleUnion = observed.length;
  await assert.rejects(invoke({ ...args, envelope: staleUnion }), error => error instanceof StateError && error.code === 'conflict');
  assert.equal(await receipt(staleUnion), null);
  assert.equal(observed.length, beforeStaleUnion);
  const beforeScenario = observed.length;
  const scenario = envelope(SCENARIO, { packet: packet() });
  await assert.rejects(invoke({ ...args, envelope: scenario }), error => error instanceof StateError && error.code === 'validation');
  assert.equal(await receipt(scenario), null);
  assert.equal(observed.length, beforeScenario);
  for (const [reference, code] of [
    [{ id: 'customer', version: '1' }, 'conflict'],
    [{ id: 'customer' }, 'validation'],
    [{ id: 'missing', version: '2' }, 'not_found'],
    [{ id: 'customer', version: '02' }, 'validation'],
    [{ id: 'customer', version: '2', model: 'forged' }, 'validation'],
  ] as const) {
    const request = envelope(CREATE, { packet: packet('3', reference), repair: true });
    await assert.rejects(invoke({ ...args, envelope: request }), error => error instanceof StateError && error.code === code);
    assert.equal(await receipt(request), null);
  }
  assert.equal(observed.length, beforeScenario);
  const outsider = makeIdentity({ userId: 'outsider', team: member.team, membership: null });
  const denied = envelope(CREATE, { packet: packet('3') });
  await assert.rejects(invoke({ ...args, identity: outsider, envelope: denied }), error => error instanceof StateError && error.code === 'forbidden');
  assert.equal(observed.length, beforeScenario);
});
