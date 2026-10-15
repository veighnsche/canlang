import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId } from '@canlang/contracts';
import { admitOwnerStageCall, validateCallInputs } from './admission.js';
import { buildContext } from './context.js';
import { loadArtifactDescriptors, type GeneratedOperationDef } from './registry.js';
import { StateError } from '../errors.js';
import { FIXED_NOW, asModel, asRevision, createMemoryIdentityStore, makeIdentity, makeRow, uuidv7 } from '../../test/invocation/fixtures.js';

const MODEL = asModel('Inputs.Customer'), OP = 'Inputs.accept';
function declarations() {
  return loadArtifactDescriptors({ artifact_version: 1,
    models: [{ name: MODEL, deleteMode: 'archive', fields: [] }],
    valueTypes: { contracts: [
      { name: 'Inputs.Business', fields: [
        { name: 'kind', type: 'text' }, { name: 'model', type: 'text' }, { name: 'id', type: 'text' },
        { name: 'version', type: 'int' }, { name: 'customer', type: MODEL },
      ] },
      { name: 'Inputs.Other', fields: [{ name: 'label', type: 'text' }] },
      { name: 'Inputs.Packet', fields: [
        { name: 'direct', type: 'Inputs.Business' }, { name: 'items', type: 'Inputs.Business[]' },
        { name: 'choice', type: 'Inputs.Business|Inputs.Other' }, { name: 'attachment', type: 'file?' },
      ] },
    ] },
    operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'packet', field: { kind: 'nominal', name: 'Inputs.Packet' }, valueType: 'Inputs.Packet' as CanTypeId, required: true },
    ] }, result: { type: 'void' as CanTypeId } }],
  }, { by: 'public' });
}
function inputs(version: string | null = '2', kind = 'ref') {
  const business = () => ({ kind, model: 'business-model', id: 'business-id', version: '19',
    customer: { id: 'customer', ...(version === null ? {} : { version }) } });
  return { packet: { direct: business(), items: [business()], choice: { type: 'Inputs.Business', value: business() }, attachment: null } };
}

test('root and owner admission discover real references inside ref-shaped Contract containers', async () => {
  const loaded = declarations(), def = loaded.registry.get(OP) as GeneratedOperationDef;
  assert.ok(loaded.valueSchema);
  const wire = inputs();
  const paths = ['packet/direct/customer', 'packet/items/0/customer', 'packet/choice/value/customer'];
  const root = validateCallInputs(def, wire);
  assert.deepEqual(root.normalized, wire);
  assert.deepEqual(root.refs.map(ref => [ref.param, ref.model, ref.expectedVersion]), paths.map(path => [path, MODEL, 2]));
  const reads: string[] = [];
  const options = { def, context: buildContext({ identity: makeIdentity(), operation: def.name,
    operationId: uuidv7(FIXED_NOW, 1), source: 'test', now: FIXED_NOW }),
    memberships: createMemoryIdentityStore(), revision: asRevision(1), owner: 'owner',
    valueSchema: loaded.valueSchema, modelNames: new Set([MODEL]),
    read: { get: async (model: string, id: string) => { reads.push(`${model}/${id}`); return makeRow({ id, version: 2 }); },
      query: async () => [] } };
  const admitted = await admitOwnerStageCall({ ...options, inputs: wire });
  assert.deepEqual(admitted.inputs, wire);
  assert.deepEqual(admitted.recordRefs.map(ref => ref.param), paths);
  assert.deepEqual(reads, paths.map(() => `${MODEL}/customer`));
  for (const kind of ['file', 'action', 'delivery', 'invocation']) {
    const business = inputs('2', kind);
    assert.deepEqual(validateCallInputs(def, business).normalized, business);
    assert.deepEqual((await admitOwnerStageCall({ ...options, inputs: business })).inputs, business);
  }
  const protectedLeaf = { packet: { ...inputs().packet, attachment: { id: 'actual-file' } } };
  assert.doesNotThrow(() => validateCallInputs(def, protectedLeaf));
  await assert.rejects(admitOwnerStageCall({ ...options, inputs: protectedLeaf }),
    error => error instanceof StateError && error.code === 'validation' && /composite protected/.test(error.message));
  await assert.rejects(admitOwnerStageCall({ ...options, inputs: inputs('1') }),
    error => error instanceof StateError && error.code === 'conflict');
  await assert.rejects(admitOwnerStageCall({ ...options, inputs: inputs(null) }),
    error => error instanceof StateError && error.code === 'validation');
  assert.throws(() => validateCallInputs(def, inputs(null)),
    error => error instanceof StateError && error.code === 'validation');
});
