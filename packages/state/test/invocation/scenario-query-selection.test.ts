/** Finite recipe/wire checks only; query, native and File authority stay with their owners. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtifactModel, CanTypeId, CanonicalModelDescriptor, ModelName, ProjectedRecord,
  ScenarioResultDisclosurePlan } from '@canlang/contracts';
import { normalizeValueTypes } from '@canlang/values';
import { StateError } from '../../src/errors.js';
import { bindScenarioQuerySelection, scenarioQuerySelectionWire,
  type ScenarioQuerySelectionMetadata } from '../../src/invocation/scenario-query-selection.js';
import { makeRow } from './fixtures.js';

const MODEL = 'chat.Turn' as ModelName, type = (value: string) => value as CanTypeId;
const source = { path: 'transcript.can', module: 'transcript.mjs', sha256: 'a'.repeat(64) };
const roles = ['system', 'user', 'assistant'];
function fixture() {
  const schema = normalizeValueTypes({ contracts: [{ name: 'TextMessage', fields: [
    { name: 'role', type: 'enum(system,user,assistant)' }, { name: 'content', type: 'text' },
    { name: 'attachments', type: 'file[]' },
  ] }] }).valueSchema;
  const declarations = [
    { name: 'role', field: { kind: 'enum', values: roles }, valueType: type('enum(system,user,assistant)'), required: true, serverOnly: false },
    { name: 'content', field: { kind: 'string' }, valueType: type('text'), required: true, serverOnly: false, max: 8 },
    { name: 'attachments', field: { kind: 'file' }, valueType: type('file[]'), required: true, serverOnly: false, array: { required: false }, max: 8 },
  ] as ArtifactModel['fields'];
  const model: ArtifactModel = { name: MODEL, deleteMode: 'remove', fields: declarations };
  const canonical: CanonicalModelDescriptor = { name: MODEL, deleteMode: 'remove', fields: Object.fromEntries(declarations.map(field =>
    [field.name, { valueType: field.valueType!, required: field.required, serverOnly: field.serverOnly,
      ...(field.array === undefined ? {} : { array: field.array }), ...(field.max === undefined ? {} : { max: field.max }) }])) };
  const dependencies = declarations.map(field => ({ id: `ordinary-${field.name}`, queryId: 'transcript', source,
    model: MODEL, field: field.name, type: field.valueType!, role: 'data' as const }));
  const plan: ScenarioResultDisclosurePlan = { version: 1, source, queries: [{ id: 'transcript', source, model: MODEL,
    order: [{ field: 'position', direction: 'asc' }], archived: 'exclude', limit: null,
    dependencies: dependencies.map(dependency => ({ id: `query-${dependency.field}`, source, role: 'data',
      field: dependency.field, type: dependency.type })) }], returns: [{ id: 'created-run', source, dependencies,
      influences: (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
        .map(kind => ({ id: kind, kind, queryId: 'transcript' })) }] };
  const metadata: ScenarioQuerySelectionMetadata = { queryId: 'transcript', type: type('TextMessage[]'),
    fields: declarations.map(field => ({ name: field.name, dependencyId: `ordinary-${field.name}` })) };
  return { bound: { plan, artifactModels: new Map([[MODEL, model]]), canonicalModels: [canonical], valueSchema: schema }, metadata };
}
function record(id: string, content: string, attachments: { id: string }[] = []): ProjectedRecord {
  return { ...makeRow({ id, data: { role: 'user', content, attachments } }), parent: null };
}
const refuses = (error: unknown) => error instanceof StateError && error.code === 'validation';

test('TextMessage selection preserves supplied order, duplicate File positions and empty selection as immutable wire', () => {
  const { bound, metadata } = fixture(), profile = bindScenarioQuerySelection(bound, metadata);
  const input = [record('second', 'second', [{ id: 'file-a' }, { id: 'file-a' }]), record('first', 'first')];
  const wire = scenarioQuerySelectionWire(profile, input);
  assert.deepEqual(wire, [{ role: 'user', content: 'second', attachments: [{ id: 'file-a' }, { id: 'file-a' }] },
    { role: 'user', content: 'first', attachments: [] }]);
  assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.fields) && Object.isFrozen(profile.fields[2]!.fileProfile));
  assert.ok(Object.isFrozen(wire) && Object.isFrozen(wire[0]) && Object.isFrozen((wire[0] as { attachments: unknown[] }).attachments));
  assert.deepEqual(scenarioQuerySelectionWire(profile, []), []);
  Reflect.set(input[0]!.data, 'content', 'changed');
  assert.equal((wire[0] as { content: string }).content, 'second');
  assert.throws(() => scenarioQuerySelectionWire({ ...profile }, input), refuses);
});

test('selection binds exact owning standard schema and complete unique ordinary/query field correspondence', () => {
  for (const mode of ['foreign-query', 'local-contract', 'required-array', 'extra-field', 'duplicate-id',
    'wrong-source', 'unlinked', 'wrong-model', 'missing-query-data', 'shadow-model', 'file-marker', 'role-cases'] as const) {
    const { bound, metadata } = fixture();
    if (mode === 'foreign-query') Reflect.set(metadata, 'queryId', 'other');
    if (mode === 'local-contract') Reflect.set(metadata, 'type', 'LocalMessages[]');
    if (mode === 'required-array') Reflect.set(metadata, 'type', 'TextMessage[]!');
    if (mode === 'extra-field') Reflect.set(metadata, 'fields', [...metadata.fields, { name: 'version', dependencyId: 'version' }]);
    if (mode === 'duplicate-id') Reflect.set(metadata.fields[1]!, 'dependencyId', metadata.fields[0]!.dependencyId);
    const dependency = bound.plan.returns[0]!.dependencies[0]!;
    if (mode === 'wrong-source') Reflect.set(dependency, 'source', { ...source, sha256: 'b'.repeat(64) });
    if (mode === 'unlinked') Reflect.deleteProperty(dependency, 'queryId');
    if (mode === 'wrong-model') Reflect.set(dependency, 'model', 'chat.Branch');
    if (mode === 'missing-query-data') Reflect.set(bound.plan.queries![0]!, 'dependencies', []);
    if (mode === 'shadow-model') bound.artifactModels.set('TextMessage' as ModelName, { name: 'TextMessage', deleteMode: 'remove', fields: [] });
    if (mode === 'file-marker') Reflect.set(bound.artifactModels.get(MODEL)!.fields[2]!, 'nullable', true);
    if (mode === 'role-cases') Reflect.set(bound.artifactModels.get(MODEL)!.fields[0]!.field, 'values', ['user', 'assistant']);
    assert.throws(() => bindScenarioQuerySelection(bound, metadata), refuses, mode);
  }
});

test('selected wire refuses unavailable, malformed or over-bound fields without invoking accessors', () => {
  const { bound, metadata } = fixture(), profile = bindScenarioQuerySelection(bound, metadata);
  for (const mode of ['missing', 'role', 'content', 'attachments', 'file-ref', 'file-max', 'content-max', 'accessor', 'sparse'] as const) {
    const row = record('row', 'valid');
    if (mode === 'missing') Reflect.deleteProperty(row.data, 'content');
    if (mode === 'role') Reflect.set(row.data, 'role', 'tool');
    if (mode === 'content') Reflect.set(row.data, 'content', 1);
    if (mode === 'attachments') Reflect.set(row.data, 'attachments', null);
    if (mode === 'file-ref') Reflect.set(row.data, 'attachments', [{ id: 'file-a', version: '1' }]);
    if (mode === 'file-max') Reflect.set(row.data, 'attachments', Array.from({ length: 9 }, () => ({ id: 'file-a' })));
    if (mode === 'content-max') Reflect.set(row.data, 'content', 'too long content');
    let getters = 0;
    if (mode === 'accessor') Object.defineProperty(row.data, 'content', { enumerable: true, get: () => { getters++; return 'valid'; } });
    const rows = mode === 'sparse' ? new Array<ProjectedRecord>(1) : [row];
    assert.throws(() => scenarioQuerySelectionWire(profile, rows), refuses, mode);
    assert.equal(getters, 0);
  }
});
