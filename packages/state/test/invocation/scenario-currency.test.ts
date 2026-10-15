/** State inventory/receipt support for the existing Values Currency primitive. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, Receipt, ScenarioResultDisclosurePlan } from '@canlang/contracts';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import { StateError } from '../../src/errors.js';
import { loadArtifactDescriptors, artifactToDescriptorSet, loadExecutionDescriptorSet, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { checkQueryInventory } from '../../src/invocation/scenario-query-plan.js';
import { invoke } from '../../src/invocation/invoke.js';
import { observeScenarioReceiptDependency, observeScenarioReceiptIntrinsic, projectScenarioReceipt,
  readScenarioReceiptAssociation, selectScenarioReceiptReturn } from '../../src/invocation/scenario-receipt.js';
import { FIXED_NOW, asModel, createMemoryIdentityStore, makeIdentity, makeEnvelope, seedMember, seedRow, uuidv7 } from './fixtures.js';

const MODEL = asModel('Currency.Location'), OP = 'Currency.inspect', APP = 'currency-state';
const origin = { path: 'currency.can', module: 'currency.mjs', sha256: 'c'.repeat(64) };
const currency = 'currency' as CanTypeId;
function artifact(): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: origin.path, sha256: origin.sha256 }],
    modules: [{ path: origin.module, js: `export const inspect="${OP}";`, map: { version: 3,
      file: origin.module, sources: [origin.path], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: origin.module, export: 'inspect', member: ['inspect'], inputStyle: 'parameters' }],
    models: [{ name: MODEL, deleteMode: 'archive', fields: [
      { name: 'currency', field: { kind: 'string' }, valueType: currency, required: true, serverOnly: false },
    ] }], valueTypes: { contracts: [{ name: 'Currency.Input', fields: [{ name: 'currency', type: currency }] }] },
    operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'expected', field: { kind: 'string' }, valueType: currency, required: true },
      { name: 'input', field: { kind: 'nominal', name: 'Currency.Input' }, valueType: 'Currency.Input' as CanTypeId, required: true },
    ] }, result: { type: currency, disclosure: { version: 1, source: origin, returns: [{
      id: 'selected', source: origin, influences: [], dependencies: [
        { id: 'location-currency', source: origin, role: 'control', model: MODEL, field: 'currency', type: currency },
      ], intrinsics: [
        { id: 'direct-currency', source: origin, role: 'data', kind: 'admitted-input', parameter: 'expected', type: currency },
        { id: 'contract-currency', source: origin, role: 'control', kind: 'admitted-input', parameter: 'input/currency', type: currency },
      ],
    }] } } }],
  };
}
const refuses = (error: unknown) => error instanceof StateError;

async function world() {
  const loaded = loadArtifactDescriptors(artifact(), { by: 'members' });
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore(), member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const row = await seedRow(store, MODEL, { id: 'location', data: { currency: 'EUR' } });
  const before = await store.load(MODEL, row.id);
  const policy = buildPolicyTable([{ model: MODEL, secretFields: [], grants: [{ by: 'members', fields: ['currency'] }] }], loaded.models);
  return { registry: loaded.registry, store, memberships, identity, member, row, before, policy,
    app: APP, source: 'test', clock: { nowMs: () => FIXED_NOW } };
}
function request(w: Awaited<ReturnType<typeof world>>, direct: unknown = 'EUR', nested: unknown = 'EUR', stored?: unknown, result?: unknown) {
  let receipt: Receipt | undefined, executions = 0;
  const inputs = { expected: direct, input: { currency: nested } };
  return { inputs, receipt: () => receipt, executions: () => executions, input: { ...w,
    envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, 8801), inputs), observeCommittedReceipt: (value: Receipt) => { receipt = value; },
    execute: async (call: Parameters<typeof observeScenarioReceiptIntrinsic>[0]) => {
      executions++;
      await observeScenarioReceiptIntrinsic(call, w.store, { dependencyId: 'direct-currency', kind: 'admitted-input', wire: direct });
      await observeScenarioReceiptIntrinsic(call, w.store, { dependencyId: 'contract-currency', kind: 'admitted-input', wire: nested });
      const row = await w.store.load(MODEL, w.row.id); assert.ok(row);
      await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'location-currency', model: MODEL,
        row: stored === undefined ? row : { ...row, data: { currency: stored } }, field: 'currency' });
      selectScenarioReceiptReturn(call, w.store, 'selected');
      return { writes: [], history: [], outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {}, result: result ?? direct };
    },
  } };
}

test('Currency intake retains exact collapsed string declarations, scalar result and nullable/array profiles through both loaders', () => {
  const raw = artifact(), converted = artifactToDescriptorSet(raw);
  // Intake-direct sets cannot attest artifact disclosure provenance. Exercise
  // their standalone Currency descriptor without claiming that authority.
  const standalone = { ...converted.set, operations: converted.set.operations.map(operation => ({ ...operation, result: { type: currency } })) };
  const loaded = loadExecutionDescriptorSet(standalone, { by: 'members', inputArrays: converted.inputArrays });
  assert.equal(loaded.models[0]!.fields.currency!.valueType, currency);
  assert.throws(() => loadExecutionDescriptorSet({ ...standalone, operations: standalone.operations.map(operation => ({
    ...operation, inputs: operation.inputs.map(input => input.name === 'expected' ? { ...input, kind: 'integer' as const } : input),
  })) }, { by: 'members' }));
  const queryPlan: ScenarioResultDisclosurePlan = { ...raw.operations![0]!.result!.disclosure!, queries: [{
    id: 'locations', source: origin, model: MODEL, order: [], limit: null, archived: 'exclude', dependencies: [
      { id: 'queried-currency', source: origin, role: 'control', field: 'currency', type: currency },
    ],
  }] };
  assert.doesNotThrow(() => checkQueryInventory(queryPlan, currency, raw.models!));
  for (const mismatch of ['text', 'int']) {
    const wrong = structuredClone(raw.models!);
    Object.assign(wrong[0]!.fields[0]!, { valueType: mismatch,
      field: { kind: mismatch === 'int' ? 'integer' : 'string' } });
    assert.throws(() => checkQueryInventory(queryPlan, currency, wrong));
  }
  for (const suffix of ['?', '[]', '[]?']) {
    const slice = artifact(), field = slice.models![0]!.fields[0]!;
    Object.assign(field, { valueType: `currency${suffix}`, nullable: suffix.endsWith('?'),
      ...(suffix.includes('[]') ? { array: { required: false } } : {}) });
    // This standalone operation has no claim that the changed field is still
    // a required singular occurrence.
    slice.operations![0]!.result = { type: `currency${suffix}` as CanTypeId };
    assert.doesNotThrow(() => loadArtifactDescriptors(slice, { by: 'members' }));
  }
  for (const mutate of [
    (slice: ArtifactDescriptorSlice) => { slice.models![0]!.fields[0]!.field = { kind: 'integer' }; },
    (slice: ArtifactDescriptorSlice) => { slice.operations![0]!.inputs.fields[0]!.field = { kind: 'integer' }; },
    (slice: ArtifactDescriptorSlice) => { slice.models![0]!.fields[0]!.valueType = 'text'; },
    (slice: ArtifactDescriptorSlice) => { Object.assign(slice.models![0]!.fields[0]!, { nullable: true }); },
    (slice: ArtifactDescriptorSlice) => { Object.assign(slice.operations![0]!.result!, { type: 'email' as CanTypeId }); },
  ]) { const slice = artifact(); mutate(slice); assert.throws(() => loadArtifactDescriptors(slice, { by: 'members' })); }
});

test('original stored Currency CONTROL and direct/Contract Currency intrinsics commit, recover and replay without writes or permission widening', async () => {
  const w = await world(), execution = request(w), original = structuredClone(execution.inputs);
  assert.equal((await invoke(execution.input)).status, 'committed'); const receipt = execution.receipt(); assert.ok(receipt);
  const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
  assert.deepEqual(association.changed, []); assert.equal(association.observations[0]!.row.data.currency, 'EUR');
  assert.deepEqual(association.intrinsics?.map(item => item.wire), ['EUR', 'EUR']);
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: 'EUR', records: [] });
  const revision = await w.store.readRevision();
  assert.equal((await invoke(execution.input)).status, 'replayed'); assert.equal(execution.executions(), 1);
  assert.equal(await w.store.readRevision(), revision); assert.deepEqual(execution.inputs, original);
  assert.deepEqual(await w.store.load(MODEL, w.row.id), w.before); assert.deepEqual(await w.store.historyFor(MODEL, w.row.id), []);
  assert.deepEqual(await w.store.outboxPending(), []);
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt, policy: buildPolicyTable([]) }), { result: null, records: [] });
  assert.equal((await projectScenarioReceipt({ ...w, receipt })).result, 'EUR');
});

test('Currency wires reject unknown, lowercase and nonstring values at direct, Contract, stored observation and result boundaries', async () => {
  for (const invalid of ['NOT', 'eur', 123]) for (const boundary of ['direct', 'contract', 'stored', 'result']) {
    const w = await world(), execution = request(w, boundary === 'direct' ? invalid : 'EUR', boundary === 'contract' ? invalid : 'EUR',
      boundary === 'stored' ? invalid : undefined, boundary === 'result' ? invalid : undefined);
    await assert.rejects(invoke(execution.input), refuses);
    assert.equal(execution.receipt(), undefined);
    assert.deepEqual(await w.store.load(MODEL, w.row.id), w.before); assert.deepEqual(await w.store.historyFor(MODEL, w.row.id), []);
    assert.deepEqual(await w.store.outboxPending(), []);
  }
});
