/** Defining State Contract-path intrinsic qualification; compiler emission and
 * native hydration are independently owned consumers. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, Receipt, ScenarioResultDisclosurePlan } from '@canlang/contracts';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { invoke, invokeRetainedReceiptOnly } from '../../src/invocation/invoke.js';
import { observeScenarioReceiptIntrinsic, readScenarioReceiptAssociation, selectScenarioReceiptReturn } from '../../src/invocation/scenario-receipt.js';
import { FIXED_NOW, asModel, createMemoryIdentityStore, makeIdentity, makeEnvelope, seedMember, seedRow, uuidv7 } from './fixtures.js';

const MODEL = asModel('ContractInput.Customer'), OP = 'ContractInput.inspect', APP = 'contract-input';
const origin = { path: 'contract-input.can', sha256: 'b'.repeat(64), module: 'contract-input.mjs' };
const type = (name: string) => name as CanTypeId;
function artifact(): ArtifactDescriptorSlice {
  const disclosure: ScenarioResultDisclosurePlan = { version: 1, source: origin, returns: [
    { id: 'selected', source: origin, influences: [], dependencies: [], intrinsics: [
      { id: 'name', source: origin, role: 'data', kind: 'admitted-input', parameter: 'input/details/name', type: 'text' },
      { id: 'accept', source: origin, role: 'control', kind: 'admitted-input', parameter: 'input/accept', type: 'bool' },
      { id: 'version', source: origin, role: 'data', kind: 'admitted-reference-version', parameter: 'input/customer', model: MODEL, type: 'int' },
    ] },
  ] };
  return { artifact_version: 1, sources: [{ path: origin.path, sha256: origin.sha256 }],
    modules: [{ path: origin.module, js: 'export const inspect="ContractInput.inspect";', map: { version: 3,
      file: origin.module, sources: [origin.path], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: origin.module, export: 'inspect', member: ['inspect'], inputStyle: 'parameters' }],
    models: [{ name: MODEL, deleteMode: 'archive', fields: [
      { name: 'title', field: { kind: 'string' }, valueType: 'text', required: true, serverOnly: false },
    ] }], valueTypes: { contracts: [
      { name: 'ContractInput.Details', fields: [{ name: 'name', type: type('ContractInput.Name') }] },
      { name: 'ContractInput.Request', fields: [
        { name: 'details', type: type('ContractInput.Details') }, { name: 'accept', type: 'bool' }, { name: 'customer', type: type(MODEL) },
      ] },
    ], aliases: [{ name: 'ContractInput.Name', type: 'text', min: 1, max: 64, format: 'name' }] },
    operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'input', field: { kind: 'nominal', name: 'ContractInput.Request' }, valueType: type('ContractInput.Request'), required: true },
    ] }, result: { type: 'text', disclosure } }],
  };
}

test('original required Contract scalar and reference-version occurrences capture and recover without execution', async () => {
  const loaded = loadArtifactDescriptors(artifact(), { by: 'members' });
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false, roles: [] });
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const row = await seedRow(store, MODEL, { id: 'customer', data: { title: 'Stored title' } });
  const inputs = { input: { details: { name: 'Original' }, accept: true, customer: { id: row.id, version: String(row.version) } } };
  const before = structuredClone(inputs), storedBefore = await store.load(MODEL, row.id);
  const common = { registry: loaded.registry, app: APP, identity, memberships, source: 'test', store,
    clock: { nowMs: () => FIXED_NOW }, envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, 9911), inputs) };
  let receipt: Receipt | undefined, executions = 0;
  const result = await invoke({ ...common, execute: async call => {
    executions++;
    assert.deepEqual(call.recordRefs.map(ref => ref.param), ['input/customer']);
    const ref = call.recordRefs[0]!;
    await observeScenarioReceiptIntrinsic(call, store, { dependencyId: 'name', kind: 'admitted-input', wire: 'Original' });
    await observeScenarioReceiptIntrinsic(call, store, { dependencyId: 'accept', kind: 'admitted-input', wire: true });
    await observeScenarioReceiptIntrinsic(call, store, { dependencyId: 'version', kind: 'admitted-reference-version', reference: ref, wire: String(row.version) });
    selectScenarioReceiptReturn(call, store, 'selected');
    return { writes: [], history: [], outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {}, result: 'Original' };
  }, observeCommittedReceipt: value => { receipt = value; } });
  assert.equal(result.status, 'committed'); assert.ok(receipt); assert.deepEqual(inputs, before);
  const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
  assert.deepEqual(association.intrinsics?.map(entry => [entry.dependencyId, entry.wire]), [['name', 'Original'], ['accept', true], ['version', String(row.version)]]);
  assert.deepEqual(association.changed, []); assert.deepEqual(await store.load(MODEL, row.id), storedBefore);
  const saved = await store.readReceipt(receipt.identity), revision = await store.readRevision();
  const replay = await invokeRetainedReceiptOnly({ ...common, execute: async () => { executions++; throw new Error('retained intrinsic cannot execute'); } });
  assert.equal(replay.status, 'replayed'); assert.equal(executions, 1);
  assert.deepEqual(await store.readReceipt(receipt.identity), saved); assert.equal(await store.readRevision(), revision);
});

test('Contract intrinsic qualification refuses optional/defaulted/array paths, model traversal and mismatched leaves', () => {
  const mutations: Array<(slice: ArtifactDescriptorSlice) => void> = [
    slice => { slice.operations![0]!.inputs.fields[0]!.required = false; },
    slice => { slice.operations![0]!.inputs.fields[0]!.default = { kind: 'literal', value: {} }; },
    slice => { Object.assign(slice.valueTypes!.contracts[1]!.fields[0]!, { type: type('ContractInput.Details?') }); },
    slice => { Object.assign(slice.valueTypes!.contracts[0]!.fields[0]!, { type: type('ContractInput.Name[]') }); },
    slice => { Object.assign(slice.valueTypes!.contracts[0]!.fields[0]!, { default: 'Fallback' }); },
    slice => { Object.assign(slice.operations![0]!.result!.disclosure!.returns[0]!.intrinsics![0]!, { parameter: 'input/customer/title' }); },
    slice => { Object.assign(slice.operations![0]!.result!.disclosure!.returns[0]!.intrinsics![0]!, { parameter: 'input/details/missing' }); },
    slice => { Object.assign(slice.operations![0]!.result!.disclosure!.returns[0]!.intrinsics![0]!, { type: 'int' }); },
    slice => { Object.assign(slice.operations![0]!.result!.disclosure!.returns[0]!.intrinsics![2]!, { parameter: 'input/details' }); },
    slice => { Object.assign(slice.operations![0]!.result!.disclosure!.returns[0]!.intrinsics![0]!, { parameter: 'input/__proto__/name' }); },
  ];
  for (const mutate of mutations) {
    const slice = artifact(); mutate(slice);
    assert.throws(() => loadArtifactDescriptors(slice, { by: 'members' }));
  }
});
