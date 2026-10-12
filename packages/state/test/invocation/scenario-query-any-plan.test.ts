/** Direct plan/lazy-prefix controls only; no native or row authority claim. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtifactModel, CanonicalModelDescriptor, CanTypeId, ModelName, ScenarioReceiptQueryObservation, ScenarioResultDisclosurePlan } from '@canlang/contracts';
import { StateError } from '../../src/errors.js';
import { bindScenarioQueryAny, checkSavedScenarioQueryAny } from '../../src/invocation/scenario-query-any.js';
import { asId, asModel, asRevision, makeRow } from './fixtures.js';
const RUN = asModel('chat.Run'), BRANCH = asModel('chat.Branch');
const source = { path: 'CanChat.can', module: 'CanChat.mjs', sha256: 'a'.repeat(64) };
function fixture() {
  const run: ArtifactModel = { name: RUN, parent: BRANCH, deleteMode: 'remove', fields: [
    { name: 'unfinished', field: { kind: 'boolean' }, valueType: 'bool' as CanTypeId, required: true, serverOnly: false },
  ] };
  const branch: ArtifactModel = { name: BRANCH, deleteMode: 'remove', fields: [] };
  const canonicalModels: CanonicalModelDescriptor[] = [{ name: RUN, deleteMode: 'remove', fields: {
    unfinished: { valueType: 'bool' as CanTypeId, required: true, serverOnly: false },
  } }, { name: BRANCH, deleteMode: 'remove', fields: {} }];
  const plan: ScenarioResultDisclosurePlan = { version: 1, source, queries: [{ id: 'unfinished-runs', source, model: RUN,
    parent: { source, model: BRANCH, origin: { kind: 'admitted-reference', parameter: 'branch' } }, order: [], limit: null,
    archived: 'exclude', dependencies: [{ id: 'unfinished-control', source, field: 'unfinished', type: 'bool' as CanTypeId, role: 'control' }] }],
    returns: [{ id: 'run', source, dependencies: [], influences: [{ id: 'any-existence', kind: 'query-existence', queryId: 'unfinished-runs' }] }] };
  return { plan, artifactModels: new Map<ModelName, ArtifactModel>([[RUN, run], [BRANCH, branch]]), canonicalModels };
}
const refuses = (error: unknown) => error instanceof StateError && error.code === 'validation';
function observation(values: readonly boolean[], firstTrue = values.indexOf(true)): ScenarioReceiptQueryObservation {
  return { queryId: 'unfinished-runs', revision: asRevision(0), parent: { model: BRANCH, row: makeRow({ id: asId('branch') }), secretFields: [] },
    candidates: values.map((value, index) => {
      const visited = firstTrue < 0 || index <= firstTrue;
      const row = { ...makeRow({ id: asId(`run-${index}`), data: { unfinished: value } }), parent: { model: BRANCH, id: asId('branch') } };
      return { row, record: { ...row, data: visited ? row.data : {} }, secretFields: [], matched: visited && value,
        dependencies: visited ? ['unfinished-control'] : [] };
    }), selectedIndices: firstTrue < 0 ? [] : [firstTrue] };
}

test('original stored bool ANY accepts empty/allfalse/firsttrue and preserves genuinely skipped suffix', () => {
  const profile = bindScenarioQueryAny(fixture(), { queryId: 'unfinished-runs', dependencyId: 'unfinished-control' });
  assert.equal(profile.model, RUN); assert.equal(profile.field, 'unfinished'); assert.equal(profile.parameter, 'branch');
  assert.ok(Object.isFrozen(profile)); assert.ok(Object.isFrozen(profile.query));
  assert.equal(checkSavedScenarioQueryAny(profile, observation([])), false);
  assert.equal(checkSavedScenarioQueryAny(profile, observation([false, false])), false);
  assert.equal(checkSavedScenarioQueryAny(profile, observation([false, true, true])), true);
  assert.equal(checkSavedScenarioQueryAny(profile, observation([true, false])), true);
  assert.throws(() => checkSavedScenarioQueryAny({ ...profile }, observation([])), refuses);
});

test('wrong marker, verdict, selected singleton, visited suffix and out-of-order/foreign candidates refuse', () => {
  const profile = bindScenarioQueryAny(fixture(), { queryId: 'unfinished-runs', dependencyId: 'unfinished-control' });
  const original = observation([false, true, false]);
  for (const mode of ['marker', 'verdict', 'selected', 'suffix', 'order', 'parent', 'duplicate'] as const) {
    let saved = original;
    if (mode === 'selected') saved = { ...original, selectedIndices: [0] };
    else if (mode === 'order') saved = { ...original, candidates: [...original.candidates].reverse() };
    else if (mode === 'duplicate') saved = { ...original, candidates: [original.candidates[0]!, original.candidates[0]!] };
    else {
      const candidates = [...original.candidates], index = mode === 'suffix' ? 2 : 0, candidate = candidates[index]!;
      candidates[index] = mode === 'marker' ? { ...candidate, dependencies: [] }
        : mode === 'verdict' ? { ...candidate, matched: true }
        : mode === 'suffix' ? { ...candidate, dependencies: ['unfinished-control'] }
        : { ...candidate, row: { ...candidate.row, parent: { model: BRANCH, id: asId('foreign') } } };
      saved = { ...original, candidates };
    }
    assert.throws(() => checkSavedScenarioQueryAny(profile, saved), refuses, mode);
  }
});

test('DATA/order/limit/archive/parent/type/influence and declaration drift cannot bind ANY', () => {
  for (const mode of ['data', 'order', 'limit', 'archive', 'parent', 'type', 'influence', 'declaration'] as const) {
    const bound = fixture(), query = bound.plan.queries![0]!;
    const changed = mode === 'data' ? { ...query, dependencies: [{ ...query.dependencies[0]!, role: 'data' as const }] }
      : mode === 'order' ? { ...query, order: [{ field: 'unfinished', direction: 'asc' as const }] }
      : mode === 'limit' ? { ...query, limit: 1 }
      : mode === 'archive' ? { ...query, archived: 'include' as const }
      : mode === 'parent' ? { ...query, parent: { ...query.parent!, origin: { kind: 'stored-reference' as const, dependencyId: 'foreign' } } }
      : mode === 'type' ? { ...query, dependencies: [{ ...query.dependencies[0]!, type: 'bool?' as CanTypeId }] } : query;
    bound.plan = { ...bound.plan, queries: [changed], ...(mode === 'influence' ? { returns: [{ ...bound.plan.returns[0]!, influences: [] }] } : {}) };
    if (mode === 'declaration') bound.artifactModels.get(RUN)!.fields[0]!.nullable = true;
    assert.throws(() => bindScenarioQueryAny(bound, { queryId: 'unfinished-runs', dependencyId: 'unfinished-control' }), refuses, mode);
  }
});


test('original defaulted unfinished bool is nonnullable even when caller initialization is optional', () => {
  const bound = fixture(), field = bound.artifactModels.get(RUN)!.fields[0]!;
  field.required = false; field.default = { kind: 'literal', value: true };
  const original = bound.canonicalModels[0]!;
  bound.canonicalModels[0] = { ...original, fields: { ...original.fields, unfinished: {
    ...original.fields.unfinished!, required: false, default: { kind: 'literal', value: true },
  } } };
  const profile = bindScenarioQueryAny(bound, { queryId: 'unfinished-runs', dependencyId: 'unfinished-control' });
  assert.equal(checkSavedScenarioQueryAny(profile, observation([false, true])), true);
});
