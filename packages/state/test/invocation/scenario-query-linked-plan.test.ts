/** Structural query-linked ordinary dependency controls, without lexical/native claims. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtifactModel, CanTypeId, ScenarioResultDisclosurePlan, ScenarioReceiptQueryObservation } from '@canlang/contracts';
import { checkQueryInventory, checkQueryProjection, checkSavedQueries, queryLinkedReturnDependencies } from '../../src/invocation/scenario-query-plan.js';
import { asModel, asRevision, makeRow } from './fixtures.js';

const TASK = asModel('LinkedQuery.Task'), PARENT = asModel('LinkedQuery.Parent');
const source = { path: 'linked-query.can', sha256: 'f'.repeat(64), module: 'linked-query.mjs' };
const foreignSource = { ...source, sha256: 'a'.repeat(64) };
const models: ArtifactModel[] = [
  { name: TASK, parent: PARENT, deleteMode: 'remove', fields: [{ name: 'done', field: { kind: 'boolean' }, required: true, serverOnly: false }] },
  { name: PARENT, deleteMode: 'remove', fields: [{ name: 'active', field: { kind: 'boolean' }, required: true, serverOnly: false }] },
];
function plan(): ScenarioResultDisclosurePlan {
  return { version: 1, source, queries: [{ id: 'tasks', source, model: TASK, order: [{ field: 'id', direction: 'asc' }],
    limit: null, archived: 'exclude', dependencies: [{ id: 'done-control', source, role: 'control', field: 'done', type: 'bool' as CanTypeId }] }],
    returns: [{ id: 'returned', source, influences: (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
      .map(kind => ({ id: kind, kind, queryId: 'tasks' })), dependencies: [{ id: 'parent-active', source, role: 'control',
        model: PARENT, field: 'active', type: 'bool' as CanTypeId, queryId: 'tasks' }] }],
  };
}
function saved(): ScenarioReceiptQueryObservation[] {
  return [{ queryId: 'tasks', revision: asRevision(0), candidates: ['a', 'b'].map((id, index) => {
    const row = makeRow({ id, data: { done: index === 0 } });
    return { row, record: { ...row, parent: null }, matched: index === 0, secretFields: [],
      dependencies: index === 0 ? ['done-control', 'parent-active'] : ['done-control'] };
  }), selectedIndices: [0] }];
}

test('query-linked ordinary IDs retain executed lazy reads without requiring them on false or empty candidates', () => {
  const checked = plan(), returned = checked.returns[0]!, query = checked.queries![0]!;
  assert.doesNotThrow(() => checkQueryInventory(checked, 'bool' as CanTypeId, models));
  assert.deepEqual(queryLinkedReturnDependencies(returned, query).map(dep => dep.id), ['parent-active']);
  assert.doesNotThrow(() => checkSavedQueries(checked, returned, saved(), true));
  const skipped = saved().map(query => ({ ...query, candidates: query.candidates.map(candidate => ({ ...candidate, dependencies: ['done-control'] })) }));
  assert.doesNotThrow(() => checkSavedQueries(checked, returned, skipped, true));
  assert.doesNotThrow(() => checkSavedQueries(checked, returned, [{ queryId: 'tasks', revision: asRevision(0), candidates: [], selectedIndices: [] }], false));
  assert.throws(() => checkSavedQueries(checked, returned, undefined, false), /own JSON data|bounded array/);
  assert.throws(() => checkSavedQueries(checked, returned, [], false), /exact selected query associations/);
});

test('ordinary query links refuse foreign, unconsumed and source-mismatched declarations', () => {
  for (const mode of ['foreign', 'unconsumed', 'source'] as const) {
    const original = plan(), returned = original.returns[0]!;
    const changed = { ...returned,
      ...(mode === 'unconsumed' ? { influences: [] } : {}),
      dependencies: returned.dependencies.map(dep => ({ ...dep,
        ...(mode === 'foreign' ? { queryId: 'foreign-query' } : {}),
        ...(mode === 'source' ? { source: foreignSource } : {}),
      })),
    };
    assert.throws(() => checkQueryProjection(changed, original.queries!), /exact consumed query and source/);
    assert.throws(() => checkQueryInventory({ ...original, returns: [changed] }, 'bool' as CanTypeId, models), /exact consumed query and source/);
  }
  const checked = plan(), query = checked.queries![0]!;
  const collision = { ...checked.returns[0]!, dependencies: checked.returns[0]!.dependencies.map(dep => ({ ...dep, id: 'done-control' })) };
  assert.throws(() => checkQueryProjection(collision, [query]), /conflicts with a query field/);
});

test('saved candidate IDs belong to the selected Return exact query, and cross-return link drift refuses', () => {
  const checked = plan(), returned = checked.returns[0]!;
  const unknown = saved().map(query => ({ ...query, candidates: query.candidates.map((candidate, index) =>
    index === 1 ? { ...candidate, dependencies: ['foreign-read'] } : candidate) }));
  assert.throws(() => checkSavedQueries(checked, returned, unknown, true), /foreign observed query dependency/);
  const withoutLink = { ...returned, dependencies: [] };
  assert.throws(() => checkSavedQueries({ ...checked, returns: [withoutLink] }, withoutLink, saved(), true), /foreign observed query dependency/);
  const otherQuery = { ...checked.queries![0]!, id: 'other-query' };
  const otherReturn = { ...returned, id: 'other-return',
    influences: returned.influences.map(influence => ({ ...influence, queryId: 'other-query' })),
    dependencies: returned.dependencies.map(dep => ({ ...dep, queryId: 'other-query' })),
  };
  assert.throws(() => checkQueryInventory({ ...checked, queries: [...checked.queries!, otherQuery], returns: [returned, otherReturn] },
    'bool' as CanTypeId, models), /drifts across returns/);
  assert.throws(() => checkSavedQueries({ ...checked, queries: [...checked.queries!, otherQuery], returns: [otherReturn] },
    otherReturn, saved(), true), /saved query identity differs/);
});

test('query-linked ordinary read cannot supply the earlier stored parent selector', () => {
  const checked = plan(), dependency = { id: 'parent-selector', source, role: 'control' as const,
    model: TASK, field: 'parent', type: PARENT as CanTypeId, queryId: 'tasks' };
  const scoped = { ...checked, queries: [{ ...checked.queries![0]!, parent: { source, model: PARENT,
    origin: { kind: 'stored-reference' as const, dependencyId: dependency.id } } }],
    returns: [{ ...checked.returns[0]!, dependencies: [dependency] }] };
  assert.throws(() => checkQueryInventory(scoped, 'bool' as CanTypeId, models), /must be observed before its query/);
});
