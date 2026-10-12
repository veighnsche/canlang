/** Finite declaration pairing; runtime authority and native lineage remain separate. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtifactModel, CanonicalModelDescriptor, CanTypeId, ModelName, ScenarioResultDisclosurePlan } from '@canlang/contracts';
import { StateError } from '../../src/errors.js';
import { bindScenarioNarrowedFields, scenarioNarrowedFieldControl, scenarioNarrowedFieldControls } from '../../src/invocation/scenario-narrowed-field.js';
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
test('required reference CONTROL supplies DATA correspondence while text preserves nullable pairing', () => {
  const bound = fixture();
  const deps = bound.plan.returns[0]!.dependencies as Array<ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number]>;
  deps.push({ ...deps[1]!, id: 'current-published', role: 'control' });
  const bindings = bindScenarioNarrowedFields(bound);
  assert.equal(scenarioNarrowedFieldControl(bindings.get('current-data')!).id, 'current-published');
  assert.equal(scenarioNarrowedFieldControl(bindings.get('digest-data')!).id, 'digest-presence');
  deps.splice(0, 1);
  assert.equal(scenarioNarrowedFieldControl(bindScenarioNarrowedFields(bound).get('current-data')!).id, 'current-published');
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
const currentData = '1c327f4f4aeae7be717182a0af8c956063f757d1e3062910735de1af97ddb541';
const publishedControl = '356ea644a1ef36fed72fdbad0bd3298f6620f572effd95d36d2b71fe5cf3a417';
const letControl = 'f6d42944cd92e67cc997626ccc675e27e6e0215990eab06707b2f4e496246c28';
function commonRequiredFixture() {
  const bound = requiredControlFixture();
  const returned = bound.plan.returns[0]!;
  const originalSource = { ...source, path: 'draft/CanCreative.can', sha256: '4da5ddcc956e72ee6f8e0d5942467692c549d925dee2a01a4e01192f93e31bbf' };
  const required = { ...returned.dependencies[0]!, id: publishedControl, source: originalSource };
  const dependencies = [required, { ...required, id: letControl }, { ...required, id: currentData, role: 'data' as const }];
  const returns = bound.plan.returns as Array<ScenarioResultDisclosurePlan['returns'][number]>;
  returns.splice(0, 1, ...[
    'a514f06e72d460ed6ddefc226d9f51be7907ce1c2ee0393d5f90ad7614e366ff',
    '70af48801b2fe1f13f28c9c4b8762466e13ecaddab07ae7fa69c32dc357b4837',
    '998791f4b82d91cc8b381a940f827dfc876f5f1963f89eac9ad6b80653a7f5dd',
    '79d0c5b24994f46af0206a4d6076165d075c65e6e63272c97ce6f2f47d5d08dd',
  ].map((id, index) => ({ ...returned, id, source: originalSource,
    dependencies: [...dependencies.map(dependency => ({ ...dependency })), ...(index < 2 ? [] : [{ ...required,
      id: '0342ea60029ea5b011f43ae25d98ce2befb393e9b75e23b3df22aec8bb8d0116', type: type(`${REVISION}?`),
    }]), { id: '7563f4ad5a7ab9be1754d6d95e78f101939df57c089028108a2ee75cf083c9b3', source: originalSource,
      model: REVISION, field: 'digest', type: type('text?'), role: 'control' as const },
    { id: '6ca63b1bd123c7c1223adcf596add493893ea29c82395e59ed74385ed406c519', source: originalSource,
      model: REVISION, field: 'digest', type: type('text'), role: 'data' as const }],
  })));
  return { ...bound, plan: { ...bound.plan, source: originalSource } };
}
test('reference DATA retains the entire common required CONTROL set across every used Return', () => {
  const bound = commonRequiredFixture();
  const bindings = bindScenarioNarrowedFields(bound), binding = bindings.get(currentData)!;
  assert.deepEqual(scenarioNarrowedFieldControls(binding).map(control => control.id), [publishedControl, letControl]);
  assert.equal(binding.data.role, 'data'); assert.equal(binding.data.type, REVISION);
  assert.ok(Object.isFrozen(binding.controls));
  assert.throws(() => scenarioNarrowedFieldControl(binding), refuses);
  assert.throws(() => scenarioNarrowedFieldControls({ ...binding }), refuses);
  assert.equal(scenarioNarrowedFieldControl(bindings.get('6ca63b1bd123c7c1223adcf596add493893ea29c82395e59ed74385ed406c519')!).id,
    '7563f4ad5a7ab9be1754d6d95e78f101939df57c089028108a2ee75cf083c9b3');
});
test('one common required CONTROL remains valid at a separately declared scope', () => {
  const bound = commonRequiredFixture();
  const deps = bound.plan.returns[0]!.dependencies as Array<ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number]>;
  deps.splice(1, 1);
  const binding = bindScenarioNarrowedFields(bound).get(currentData)!;
  assert.deepEqual(scenarioNarrowedFieldControls(binding).map(control => control.id), [publishedControl]);
});
test('reference DATA refuses absent common required correspondence and drifting DATA occurrences', () => {
  for (const mode of ['field', 'source', 'type', 'foreign', 'return-drift', 'duplicate'] as const) {
    const bound = commonRequiredFixture();
    const deps = bound.plan.returns[0]!.dependencies as Array<ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number]>;
    if (mode === 'return-drift') deps[2] = { ...deps[2]!, source: { ...source, sha256: 'b'.repeat(64) } };
    else if (mode === 'duplicate') deps.push({ ...deps[2]! });
    else for (let index = 0; index < 2; index++) {
      const control = deps[index]!;
      deps[index] = mode === 'field' ? { ...control, field: 'other' }
        : mode === 'source' ? { ...control, source: { ...source, sha256: 'b'.repeat(64) } }
        : mode === 'type' ? { ...control, type: type(`${REVISION}?`) }
        : { ...control, queryId: 'foreign' };
    }
    assert.throws(() => bindScenarioNarrowedFields(bound), refuses, mode);
  }
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
