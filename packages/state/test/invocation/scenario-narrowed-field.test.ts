/** Finite declaration pairing; runtime authority and native lineage remain separate. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtifactModel, CanonicalModelDescriptor, CanTypeId, ModelName, ScenarioResultDisclosurePlan } from '@canlang/contracts';
import { StateError } from '../../src/errors.js';
import { bindScenarioNarrowedFields, scenarioNarrowedFieldControl } from '../../src/invocation/scenario-narrowed-field.js';
const model = (name: string) => name as ModelName, type = (name: string) => name as CanTypeId;
const TEMPLATE = model('creative.Template'), REVISION = model('creative.Revision');
const source = { path: 'CanCreative.can', module: 'CanCreative.mjs', sha256: 'a'.repeat(64) };
function fixture() {
  const template: ArtifactModel = { name: TEMPLATE, deleteMode: 'remove', fields: [
    { name: 'current', field: { kind: 'ref', model: REVISION }, valueType: type(`${REVISION}?`), nullable: true, required: false, serverOnly: false },
  ] };
  const revision: ArtifactModel = { name: REVISION, deleteMode: 'remove', fields: [
    { name: 'digest', field: { kind: 'string' }, valueType: type('text?'), nullable: true, required: false, serverOnly: false },
    { name: 'published', field: { kind: 'boolean' }, valueType: type('bool'), required: true, serverOnly: false },
  ] };
  const canonicalModels: CanonicalModelDescriptor[] = [template, revision].map(value => ({ name: value.name as ModelName, deleteMode: value.deleteMode,
    fields: Object.fromEntries(value.fields.map(field => [field.name, { valueType: field.valueType! as CanTypeId, required: field.required,
      serverOnly: field.serverOnly, ...(field.nullable === undefined ? {} : { nullable: field.nullable }) }])) }));
  const dependency = (id: string, owner: ModelName, field: string, value: string, role: 'data' | 'control') => ({ id, model: owner, field, type: type(value), role, source });
  const plan: ScenarioResultDisclosurePlan = { version: 1, source, returns: [{ id: 'run', source, influences: [], dependencies: [
    dependency('current-presence', TEMPLATE, 'current', `${REVISION}?`, 'control'),
    dependency('current-data', TEMPLATE, 'current', REVISION, 'data'),
    dependency('digest-presence', REVISION, 'digest', 'text?', 'control'),
    dependency('digest-data', REVISION, 'digest', 'text', 'data'),
    dependency('published-data', REVISION, 'published', 'bool', 'data'),
  ] }] };
  return { plan, artifactModels: new Map<ModelName, ArtifactModel>([[TEMPLATE, template], [REVISION, revision]]), canonicalModels };
}
const refuses = (error: unknown) => error instanceof StateError && error.code === 'validation';
function requiredControlFixture() {
  const bound = fixture();
  const returned = bound.plan.returns[0]!;
  const deps = returned.dependencies as Array<ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number]>;
  deps.splice(0, deps.length, { ...deps[1]!, id: 'current-published', role: 'control' });
  return bound;
}
test('required current reference CONTROL retains its actual occurrence and authenticates itself without a nullable predecessor', () => {
  const bound = requiredControlFixture();
  const deps = bound.plan.returns[0]!.dependencies as Array<ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number]>;
  deps.push({ ...deps[0]!, id: 'current-let' });
  const bindings = bindScenarioNarrowedFields(bound);
  assert.deepEqual([...bindings.keys()], ['current-published', 'current-let']);
  for (const id of bindings.keys()) {
    const binding = bindings.get(id)!;
    assert.equal(binding.data.id, id); assert.equal(binding.data.role, 'control');
    assert.equal(binding.data.type, REVISION); assert.equal(binding.declarationType, `${REVISION}?`);
    assert.equal(binding.kind, 'reference'); assert.equal(binding.target, REVISION);
    assert.equal(scenarioNarrowedFieldControl(binding), binding.data);
    assert.ok(Object.isFrozen(binding)); assert.ok(Object.isFrozen(binding.data));
    assert.throws(() => scenarioNarrowedFieldControl({ ...binding }), refuses);
  }
});
test('required reference CONTROL does not replace the unique nullable predecessor for DATA', () => {
  const bound = fixture();
  const deps = bound.plan.returns[0]!.dependencies as Array<ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number]>;
  deps.push({ ...deps[1]!, id: 'current-published', role: 'control' });
  const bindings = bindScenarioNarrowedFields(bound);
  assert.equal(scenarioNarrowedFieldControl(bindings.get('current-data')!).id, 'current-presence');
  deps.splice(0, 1);
  assert.throws(() => bindScenarioNarrowedFields(bound), refuses);
});
test('required CONTROL refuses text, array, query, metadata, nonowning and declaration drift', () => {
  for (const mode of ['text', 'array', 'required-array', 'query', 'metadata', 'nonowning', 'nullable', 'type', 'marker', 'target', 'field-kind'] as const) {
    const bound = requiredControlFixture();
    const deps = bound.plan.returns[0]!.dependencies as Array<ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number]>;
    const field = bound.artifactModels.get(TEMPLATE)!.fields[0]!;
    const checked = bound.canonicalModels[0]!.fields.current!;
    if (mode === 'text') deps[0] = { ...deps[0]!, model: REVISION, field: 'digest', type: type('text') };
    else if (mode === 'array') deps[0] = { ...deps[0]!, type: type(`${REVISION}[]`) };
    else if (mode === 'required-array') deps[0] = { ...deps[0]!, type: type(`${REVISION}[]!`) };
    else if (mode === 'query') deps[0] = { ...deps[0]!, queryId: 'foreign' };
    else if (mode === 'metadata') {
      field.name = 'version';
      bound.canonicalModels[0] = { ...bound.canonicalModels[0]!, fields: { version: checked } };
      deps[0] = { ...deps[0]!, field: 'version' };
    } else if (mode === 'nonowning') field.field = { kind: 'ref', model: TEMPLATE };
    else if (mode === 'nullable') field.nullable = false;
    else if (mode === 'type' || mode === 'marker') bound.canonicalModels[0] = { ...bound.canonicalModels[0]!, fields: {
      ...bound.canonicalModels[0]!.fields, current: { ...checked, ...(mode === 'type' ? { valueType: type('Other?') } : { serverOnly: true }) },
    } };
    else if (mode === 'target') bound.canonicalModels.splice(1, 1);
    else field.field = { kind: 'string' };
    assert.throws(() => bindScenarioNarrowedFields(bound), refuses, mode);
  }
});
test('required CONTROL gains no narrowing binding without an explicit nullable declaration', () => {
  const bound = requiredControlFixture();
  delete bound.artifactModels.get(TEMPLATE)!.fields[0]!.valueType;
  Reflect.deleteProperty(bound.canonicalModels[0]!.fields.current!, 'valueType');
  assert.equal(bindScenarioNarrowedFields(bound).size, 0);
});
test('original current reference and digest text pair with exact nullable CONTROL while exact fields stay untouched', () => {
  const bound = fixture(), bindings = bindScenarioNarrowedFields(bound);
  assert.deepEqual([...bindings.keys()], ['current-data', 'digest-data']);
  const current = bindings.get('current-data')!, digest = bindings.get('digest-data')!;
  assert.equal(current.kind, 'reference'); assert.equal(current.target, REVISION); assert.equal(current.declarationType, `${REVISION}?`);
  assert.equal(scenarioNarrowedFieldControl(current).id, 'current-presence');
  assert.equal(digest.kind, 'text'); assert.equal(scenarioNarrowedFieldControl(digest).id, 'digest-presence');
  assert.ok(Object.isFrozen(current)); assert.ok(Object.isFrozen(current.control));
  assert.throws(() => scenarioNarrowedFieldControl({ ...current }), refuses);
  const mutable = bound.plan.returns[0]!.dependencies as Array<ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number]>;
  mutable[0] = { ...mutable[0]!, source: { ...source, sha256: 'b'.repeat(64) } };
  assert.equal(current.control.source.sha256, 'a'.repeat(64));
});
test('wrong source/model/field/base, missing or ambiguous CONTROL and linked occurrences refuse', () => {
  for (const mode of ['source', 'model', 'field', 'base', 'missing', 'ambiguous', 'role', 'query', 'array'] as const) {
    const bound = fixture(), deps = bound.plan.returns[0]!.dependencies as Array<ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number]>;
    if (mode === 'source') deps[0] = { ...deps[0]!, source: { ...source, sha256: 'b'.repeat(64) } };
    else if (mode === 'model') deps[0] = { ...deps[0]!, model: REVISION };
    else if (mode === 'field') deps[0] = { ...deps[0]!, field: 'other' };
    else if (mode === 'base') deps[1] = { ...deps[1]!, type: type('Other') };
    else if (mode === 'missing') deps.splice(0, 1);
    else if (mode === 'ambiguous') deps.push({ ...deps[0]!, id: 'second-presence' });
    else if (mode === 'role') deps[0] = { ...deps[0]!, role: 'data' };
    else if (mode === 'query') deps[1] = { ...deps[1]!, queryId: 'foreign' };
    else deps[1] = { ...deps[1]!, type: type(`${REVISION}[]`) };
    assert.throws(() => bindScenarioNarrowedFields(bound), refuses, mode);
  }
});
test('contract targets, nullable marker/type drift and unsupported scalar narrowing refuse', () => {
  for (const mode of ['contract', 'nullable', 'type', 'marker', 'scalar'] as const) {
    const bound = fixture();
    if (mode === 'contract') bound.canonicalModels.splice(1, 1);
    else if (mode === 'nullable') bound.canonicalModels[0] = { ...bound.canonicalModels[0]!, fields: { ...bound.canonicalModels[0]!.fields, current: { ...bound.canonicalModels[0]!.fields.current!, nullable: false } } };
    else if (mode === 'type') bound.canonicalModels[0] = { ...bound.canonicalModels[0]!, fields: { ...bound.canonicalModels[0]!.fields, current: { ...bound.canonicalModels[0]!.fields.current!, valueType: type('Other?') } } };
    else if (mode === 'marker') bound.canonicalModels[0] = { ...bound.canonicalModels[0]!, fields: { ...bound.canonicalModels[0]!.fields, current: { ...bound.canonicalModels[0]!.fields.current!, serverOnly: true } } };
    else {
      const field = bound.artifactModels.get(REVISION)!.fields[0]!; field.field = { kind: 'integer' }; field.valueType = type('int?');
      bound.canonicalModels[1] = { ...bound.canonicalModels[1]!, fields: { ...bound.canonicalModels[1]!.fields, digest: { ...bound.canonicalModels[1]!.fields.digest!, valueType: type('int?') } } };
      const deps = bound.plan.returns[0]!.dependencies as Array<ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number]>;
      deps[2] = { ...deps[2]!, type: type('int?') }; deps[3] = { ...deps[3]!, type: type('int') };
    }
    assert.throws(() => bindScenarioNarrowedFields(bound), refuses, mode);
  }
});

test('reserved id/parent and an exact canonical type with derived authored scalar type remain outside narrowing', () => {
  const bound = fixture();
  delete bound.artifactModels.get(REVISION)!.fields[1]!.valueType;
  const deps = bound.plan.returns[0]!.dependencies as Array<ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number]>;
  deps.push({ id: 'revision-id', source, model: REVISION, field: 'id', type: type('text'), role: 'data' },
    { id: 'revision-parent', source, model: REVISION, field: 'parent', type: type(TEMPLATE), role: 'data' });
  const bindings = bindScenarioNarrowedFields(bound);
  assert.deepEqual([...bindings.keys()], ['current-data', 'digest-data']);
  assert.equal(bindings.has('published-data'), false);
  Reflect.deleteProperty(bound.canonicalModels[1]!.fields.published!, 'valueType');
  assert.deepEqual([...bindScenarioNarrowedFields(bound).keys()], ['current-data', 'digest-data']);
  assert.equal(bindings.has('revision-id'), false);
  assert.equal(bindings.has('revision-parent'), false);
});
