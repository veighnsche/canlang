/** The selected-message inventory adds File DATA only; authority stays in the actual binder. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtifactModel, CanTypeId, ScenarioReceiptQueryObservation, ScenarioResultDisclosurePlan } from '@canlang/contracts';
import { normalizeValueTypes } from '@canlang/values';
import { StateError } from '../../src/errors.js';
import { checkQueries, checkQueryInventory, checkSavedQueries } from '../../src/invocation/scenario-query-plan.js';
import { asModel, makeRow } from './fixtures.js';

const TURN = asModel('chat.Turn'), BRANCH = asModel('chat.Branch');
const source = { path: 'transcript.can', module: 'transcript.mjs', sha256: 'a'.repeat(64) };
const type = (value: string) => value as CanTypeId;
function fixture() {
  const schema = normalizeValueTypes({ contracts: [{ name: 'TextMessage', fields: [
    { name: 'role', type: 'enum(system,user,assistant)' }, { name: 'content', type: 'text' }, { name: 'attachments', type: 'file[]' },
  ] }] }, [TURN, BRANCH]).valueSchema;
  const plan: ScenarioResultDisclosurePlan = { version: 1, source, queries: [{ id: 'messages', source, model: TURN,
    parent: { source, model: BRANCH, origin: { kind: 'admitted-reference', parameter: 'branch' } },
    order: [{ field: 'position', direction: 'asc' }], limit: null, archived: 'exclude', dependencies: [
      { id: 'role', source, role: 'data', field: 'role', type: type('enum(system,user,assistant)') },
      { id: 'content', source, role: 'data', field: 'content', type: type('text') },
      { id: 'attachments', source, role: 'data', field: 'attachments', type: type('file[]') },
      { id: 'position', source, role: 'control', field: 'position', type: type('int') },
    ] }], returns: [{ id: 'run', source, dependencies: [], influences:
      (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
        .map(kind => ({ id: kind, kind, queryId: 'messages' })) }] };
  const models: ArtifactModel[] = [{ name: BRANCH, deleteMode: 'remove', fields: [] },
    { name: TURN, parent: BRANCH, deleteMode: 'remove', fields: [
      { name: 'role', field: { kind: 'enum', values: ['system', 'user', 'assistant'] }, valueType: type('enum(system,user,assistant)'), required: true, serverOnly: false },
      { name: 'content', field: { kind: 'string' }, valueType: type('text'), required: true, serverOnly: false },
      { name: 'attachments', field: { kind: 'file' }, valueType: type('file[]'), array: { required: false }, max: 8, required: true, serverOnly: false },
      { name: 'position', field: { kind: 'integer' }, valueType: type('int'), required: true, serverOnly: false },
    ] }];
  const parent = makeRow({ id: 'branch' });
  const candidates = [2, 1].map(position => {
    const row = { ...makeRow({ id: `turn-${position}`, data: { role: 'user', content: `message-${position}`,
      attachments: [{ id: 'file-a' }, { id: 'file-a' }], position: String(position) } }), parent: { model: BRANCH, id: parent.id } };
    return { row, record: row, matched: true, secretFields: [], dependencies: ['role', 'content', 'attachments', 'position'] };
  });
  const saved: ScenarioReceiptQueryObservation[] = [{ queryId: 'messages', revision: 1 as import('@canlang/contracts').Revision,
    parent: { model: BRANCH, row: parent, secretFields: [] }, candidates, selectedIndices: [1, 0] }];
  return { schema, plan, models, saved };
}
const refuses = (error: unknown) => error instanceof StateError && error.code === 'validation';

test('contained TextMessage field inventory retains ordered selected File DATA and exact empty parent witness', () => {
  const { schema, plan, models, saved } = fixture();
  assert.equal(checkQueries(plan.queries)[0]!.dependencies[2]!.type, 'file[]');
  checkQueryInventory(plan, type('chat.Run'), models, schema);
  checkSavedQueries(plan, plan.returns[0]!, saved, { id: 'run' }, schema);
  const empty = [{ ...saved[0]!, candidates: [], selectedIndices: [] }];
  checkSavedQueries(plan, plan.returns[0]!, empty, { id: 'run' }, schema);
  const withoutScope = [{ ...empty[0] }]; Reflect.deleteProperty(withoutScope[0]!, 'parent');
  assert.throws(() => checkSavedQueries(plan, plan.returns[0]!, withoutScope, { id: 'run' }, schema), refuses);
});

test('query Files refuse control/order, nullable/singular/required arrays and nonowning tags or containment', () => {
  for (const mode of ['control', 'order', 'nullable', 'singular', 'required-array', 'unknown', 'wrong-tag',
    'wrong-value-type', 'missing-marker', 'required-marker', 'wrong-parent', 'scope'] as const) {
    const { schema, plan, models } = fixture(), query = plan.queries![0]!, dependency = query.dependencies[2]!, field = models[1]!.fields[2]!;
    if (mode === 'control') Reflect.set(dependency, 'role', 'control');
    if (mode === 'order') Reflect.set(query, 'order', [{ field: 'attachments', direction: 'asc' }]);
    if (mode === 'nullable') Reflect.set(dependency, 'type', 'file[]?');
    if (mode === 'singular') Reflect.set(dependency, 'type', 'file');
    if (mode === 'required-array') Reflect.set(dependency, 'type', 'file[]!');
    if (mode === 'unknown') Reflect.set(dependency, 'type', 'UnknownFiles[]');
    if (mode === 'wrong-tag') Reflect.set(field, 'field', { kind: 'string' });
    if (mode === 'wrong-value-type') Reflect.set(field, 'valueType', 'file');
    if (mode === 'missing-marker') Reflect.deleteProperty(field, 'array');
    if (mode === 'required-marker') Reflect.set(field, 'array', { required: true });
    if (mode === 'wrong-parent') Reflect.set(models[1]!, 'parent', 'other.Branch');
    if (mode === 'scope') Reflect.set(models[1]!, 'scope', 'team');
    assert.throws(() => checkQueryInventory(plan, type('chat.Run'), models, schema), refuses, mode);
  }
});

test('saved selected File DATA requires canonical identity wire, full DATA observations and selected order/scope', () => {
  for (const mode of ['raw-url', 'extra-key', 'string', 'missing-data', 'missing-field', 'wrong-order', 'foreign-parent'] as const) {
    const { schema, plan, saved } = fixture(), candidate = saved[0]!.candidates[0]!;
    if (mode === 'raw-url') Reflect.set(candidate.row.data, 'attachments', [{ id: 'https://example.test/file' }]);
    if (mode === 'extra-key') Reflect.set(candidate.row.data, 'attachments', [{ id: 'file-a', version: '1' }]);
    if (mode === 'string') Reflect.set(candidate.row.data, 'attachments', ['file-a']);
    if (mode === 'missing-data') Reflect.set(candidate, 'dependencies', candidate.dependencies.filter(id => id !== 'attachments'));
    if (mode === 'missing-field') Reflect.deleteProperty(candidate.record.data, 'attachments');
    if (mode === 'wrong-order') Reflect.set(saved[0]!, 'selectedIndices', [0, 1]);
    if (mode === 'foreign-parent') Reflect.set(candidate.row, 'parent', { model: BRANCH, id: 'other' });
    assert.throws(() => checkSavedQueries(plan, plan.returns[0]!, saved, { id: 'run' }, schema), refuses, mode);
  }
});

test('legacy final contract projection still requires reference and version mappings', () => {
  const { plan, models } = fixture();
  const schema = normalizeValueTypes({ contracts: [{ name: 'LegacyFact', fields: [
    { name: 'turn', type: TURN }, { name: 'version', type: 'int' },
  ] }] }, [TURN, BRANCH]).valueSchema;
  Reflect.set(plan.returns[0]!, 'projection', { kind: 'query-contract-array', queryId: 'messages', source,
    fields: [{ name: 'turn', kind: 'reference' }, { name: 'version', kind: 'version' }] });
  checkQueryInventory(plan, type('LegacyFact[]'), models, schema);
  Reflect.set(plan.returns[0]!.projection!, 'fields', [{ name: 'turn', kind: 'field', field: 'content' }]);
  assert.throws(() => checkQueryInventory(plan, type('LegacyFact[]'), models, schema), refuses);
});
