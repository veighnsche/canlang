/** Conditional unique State component; original Compiler/native adoption is separate. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CanTypeId, CanonicalModelDescriptor, QueryPredicate, StoragePort } from '@canlang/contracts';
import { StateError } from '../errors.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { createD1Storage, ensureSchema } from '../storage/d1.js';
import { FenceConflictError, StorageConstraintError } from '../storage/port.js';
import { buildModelTable, buildModelTableFromCanonical, type InterimModelDef } from './models.js';
import { beginOwnerMutation, runMutationWrites, type MutationWritesResult } from './pipeline.js';
import { makeBatch } from '../../test/invocation/fixtures.js';
import { asId, asModel, crudCreate, crudUpdate, crudRemove, field, hook, invariant,
  modelDef, mustLoad, pipelineContext, setupMutation } from '../../test/mutation/fixtures.js';

const MODEL = 'Office.Item', model = asModel(MODEL), warehouse = asModel('Warehouse.Item');
const condition: QueryPredicate = {op: 'eq', field: 'closed', value: true};
const cause = {cause: 'scenario'} as const, bounds = {maxRows: 20, maxWork: 1000};
const context = () => pipelineContext({operation: 'Office.conditionalUnique'});
const conflict = (error: unknown) => error instanceof StateError && error.code === 'conflict' ||
  error instanceof StorageConstraintError && error.kind === 'unique';
function definition(deleteMode: 'archive' | 'remove' = 'remove', name = MODEL): InterimModelDef {
  return {...modelDef(name, {fields: {qty: {...field({required: true}), valueType: 'int' as CanTypeId},
    closed: {...field({required: true}), valueType: 'bool' as CanTypeId}}, uniqueKeys: ['qty'], deleteMode}), uniqueWhen: {qty: condition}};
}
function canonical(uniqueKeys: readonly string[] = []): CanonicalModelDescriptor {
  return {name: model, deleteMode: 'remove', fields: {
    qty: {valueType: 'int' as CanTypeId, required: true, serverOnly: false},
    closed: {valueType: 'bool' as CanTypeId, required: true, serverOnly: false},
  }, uniqueKeys};
}
async function commit(store: StoragePort, output: MutationWritesResult) {
  await store.commit(makeBatch(await store.readRevision(), output));
}
const create = (id: string, qty: string, closed: boolean) => ({op: 'create' as const, model, id: asId(id), data: {qty, closed}});
const update = (id: string, data: Record<string, unknown>) => ({op: 'update' as const, model, id: asId(id), data});

test('original wire qty7 permits inactive duplicates, claims active rows and replays without duplicate effects', async () => {
  const w = await setupMutation([definition()]);
  await crudCreate(w, MODEL, {id: 'inactive-a', data: {qty: '7', closed: false}});
  await crudCreate(w, MODEL, {id: 'inactive-b', data: {qty: '7', closed: false}});
  let executions = 0;
  const counted = {...w, execute: async (call: Parameters<typeof w.execute>[0]) => {executions++; return w.execute(call);}};
  const first = await crudCreate(counted, MODEL, {id: 'active', data: {qty: '7', closed: true}});
  const revision = await w.store.readRevision(), history = await w.store.historyFor(model, asId('active'));
  assert.equal((await crudCreate(counted, MODEL, {id: 'active', data: {qty: '7', closed: true}, operationId: first.operationId})).out.status, 'replayed');
  assert.equal(executions, 1); assert.equal(await w.store.readRevision(), revision);
  assert.deepEqual(await w.store.historyFor(model, asId('active')), history);
  await assert.rejects(crudCreate(w, MODEL, {id: 'duplicate', data: {qty: '7', closed: true}}), conflict);
  assert.equal(await w.store.load(model, asId('duplicate')), null); assert.deepEqual(await w.store.historyFor(model, asId('duplicate')), []);
  assert.deepEqual((await mustLoad(w.store, model, 'inactive-a')).data, {qty: '7', closed: false});
});

test('enter/leave and active key changes acquire and release the actual conditional claim', async () => {
  const w = await setupMutation([definition()]);
  await crudCreate(w, MODEL, {id: 'a', data: {qty: '7', closed: false}});
  await crudCreate(w, MODEL, {id: 'b', data: {qty: '7', closed: false}});
  await crudUpdate(w, MODEL, 'a', {version: 1, patch: {closed: true}});
  await assert.rejects(crudUpdate(w, MODEL, 'b', {version: 1, patch: {closed: true}}), conflict);
  assert.equal((await mustLoad(w.store, model, 'b')).data.closed, false);
  await crudUpdate(w, MODEL, 'a', {version: 2, patch: {qty: '8'}});
  await crudUpdate(w, MODEL, 'b', {version: 1, patch: {closed: true}});
  await crudUpdate(w, MODEL, 'a', {version: 3, patch: {closed: false}});
  await crudCreate(w, MODEL, {id: 'c', data: {qty: '8', closed: true}});
  await assert.rejects(crudUpdate(w, MODEL, 'b', {version: 2, patch: {qty: '8'}}), conflict);
  assert.deepEqual((await mustLoad(w.store, model, 'b')).data, {qty: '7', closed: true});
});

test('owner final state admits swaps and transient duplicates, while net condition transitions leave no stale claims', async () => {
  const w = await setupMutation([definition()]);
  await crudCreate(w, MODEL, {id: 'a', data: {qty: '7', closed: true}});
  await crudCreate(w, MODEL, {id: 'b', data: {qty: '8', closed: true}});
  const session = await beginOwnerMutation({table: w.table, store: w.store, context: context(), bounds});
  await session.stage(update('a', {qty: '8'}), cause); await session.stage(update('b', {qty: '7'}), cause);
  const swapped = await session.finalize(); assert.equal(swapped.uniqueClaims.length, 2); assert.equal(swapped.uniqueReleases.length, 2);
  await commit(w.store, swapped);
  assert.equal((await mustLoad(w.store, model, 'a')).data.qty, '8'); assert.equal((await mustLoad(w.store, model, 'b')).data.qty, '7');
  const transient = await beginOwnerMutation({table: w.table, store: w.store, context: context(), bounds});
  await transient.stage(create('c', '9', true), cause); await transient.stage(create('d', '9', true), cause);
  await transient.stage(update('d', {qty: '10'}), cause); await transient.stage(create('net', '11', false), cause);
  await transient.stage(update('net', {closed: true}), cause); await transient.stage(update('net', {closed: false}), cause);
  const output = await transient.finalize(); assert.equal(output.uniqueClaims.length, 2);
  assert.equal(output.uniqueClaims.some(claim => claim.recordId === asId('net')), false); assert.deepEqual(output.uniqueReleases, []);
  await commit(w.store, output);
  await crudCreate(w, MODEL, {id: 'net-key-reused', data: {qty: '11', closed: true}});
});

test('late owner failure and stale commit leave rows/history/claims unchanged', async () => {
  const def = definition(), w = await setupMutation([{...def, invariants: [invariant('late', view => {
    if (view.get(model, asId('failed'))?.data.qty === '-1') throw new StateError('rule_failed', 'late failure');
  })]}]);
  const session = await beginOwnerMutation({table: w.table, store: w.store, context: context(), bounds});
  await session.stage(create('failed', '7', true), cause); await session.stage(update('failed', {qty: '-1'}), cause);
  await assert.rejects(session.finalize(), error => error instanceof StateError && error.code === 'rule_failed');
  assert.equal(await w.store.load(model, asId('failed')), null); assert.deepEqual(await w.store.historyFor(model, asId('failed')), []);
  assert.deepEqual(w.probe.outboxAll(), []);
  await crudCreate(w, MODEL, {id: 'recovered', data: {qty: '7', closed: true}});
  const stale = await runMutationWrites({table: w.table, store: w.store, context: context(), writes: [create('stale', '8', true)]});
  const expected = await w.store.readRevision();
  await crudCreate(w, MODEL, {id: 'fence', data: {qty: '9', closed: false}});
  await assert.rejects(w.store.commit(makeBatch(expected, stale)), error => error instanceof FenceConflictError);
  assert.equal(await w.store.load(model, asId('stale')), null); assert.deepEqual(await w.store.historyFor(model, asId('stale')), []);
  await crudCreate(w, MODEL, {id: 'unclaimed', data: {qty: '8', closed: true}});
});

test('remove frees claims, archive retains active claims, and owning model/store isolation stays intact', async () => {
  for (const deleteMode of ['remove', 'archive'] as const) {
    const w = await setupMutation([definition(deleteMode), definition('remove', 'Warehouse.Item')]);
    await crudCreate(w, MODEL, {id: 'a', data: {qty: '7', closed: true}});
    await crudCreate(w, 'Warehouse.Item', {id: 'other-model', data: {qty: '7', closed: true}});
    assert.ok(await w.store.load(warehouse, asId('other-model')));
    const separate = await setupMutation([definition()]); await crudCreate(separate, MODEL, {id: 'other-owner', data: {qty: '7', closed: true}});
    await crudRemove(w, MODEL, 'a', {version: 1});
    if (deleteMode === 'remove') await crudCreate(w, MODEL, {id: 'released', data: {qty: '7', closed: true}});
    else {
      assert.ok((await mustLoad(w.store, model, 'a')).archivedAt !== null);
      await assert.rejects(crudCreate(w, MODEL, {id: 'retained', data: {qty: '7', closed: true}}), conflict);
    }
  }
});

test('hook-adjusted final conditions control claims and mix with one unchanged unconditional key', async () => {
  const def = definition(), w = await setupMutation([{...def,
    fields: {...def.fields, title: {...field({required: true}), valueType: 'text' as CanTypeId}}, uniqueKeys: ['qty', 'title'],
    hooks: [hook('final-condition', ['create', 'update'], candidate => ({...candidate, closed: candidate.qty === '8'}))]}]);
  await crudCreate(w, MODEL, {id: 'a', data: {qty: '7', closed: true, title: 'a'}});
  await crudCreate(w, MODEL, {id: 'b', data: {qty: '7', closed: true, title: 'b'}});
  assert.equal((await mustLoad(w.store, model, 'a')).data.closed, false);
  await assert.rejects(crudCreate(w, MODEL, {id: 'title-duplicate', data: {qty: '7', closed: false, title: 'a'}}), conflict);
  await crudUpdate(w, MODEL, 'a', {version: 1, patch: {qty: '8'}});
  await assert.rejects(crudUpdate(w, MODEL, 'b', {version: 1, patch: {qty: '8'}}), conflict);
  const fresh = await setupMutation([w.table.get(model)!]);
  const session = await beginOwnerMutation({table: fresh.table, store: fresh.store, context: context(), bounds});
  await session.stage({...create('hook-net', '7', true), data: {qty: '7', closed: true, title: 'net'}},
    {cause: 'crud', input: {qty: '7', closed: true, title: 'net'}});
  await session.stage(update('hook-net', {qty: '8'}), {cause: 'crud', input: {qty: '8'}});
  await session.stage(update('hook-net', {qty: '7'}), {cause: 'crud', input: {qty: '7'}});
  const output = await session.finalize();
  assert.equal(output.uniqueClaims.some(claim => claim.keyName === 'qty'), false);
  assert.deepEqual(output.uniqueReleases, []); await commit(fresh.store, output);
  assert.equal((await mustLoad(fresh.store, model, 'hook-net')).data.closed, false);
  await crudCreate(fresh, MODEL, {id: 'active-after-net', data: {qty: '8', closed: false, title: 'active'}});
});

test('canonical conditional input detaches/freezes and rejects unknown, malformed, array/ref paths and unconditional overlap', () => {
  const mutable = {op: 'eq', field: 'closed', value: true} as QueryPredicate;
  const input = new Map([[model, {qty: mutable}]]), table = buildModelTableFromCanonical([canonical()], {uniqueWhen: input});
  assert.deepEqual(table.get(model)!.uniqueKeys, ['qty']); assert.ok(Object.isFrozen(table.get(model)!.uniqueWhen));
  assert.ok(Object.isFrozen(table.get(model)!.uniqueWhen!.qty));
  Object.assign(mutable, {value: false}); input.clear();
  assert.deepEqual(table.get(model)!.uniqueWhen!.qty, condition);
  for (const mode of ['model', 'key', 'field', 'shape', 'type', 'array-path', 'ref-path', 'overlap'] as const) {
    const predicate = mode === 'field' ? {op: 'eq', field: 'missing', value: true}
      : mode === 'shape' ? {op: 'unknown', field: 'closed', value: true}
      : mode === 'type' ? {op: 'eq', field: 'closed', value: 'true'}
      : mode === 'array-path' ? {op: 'eq', field: 'closed.0', value: true}
      : mode === 'ref-path' ? {op: 'eq', field: 'owner.closed', value: true} : condition;
    const map = new Map([[mode === 'model' ? asModel('Missing.Item') : model, {[mode === 'key' ? 'missing' : 'qty']: predicate as QueryPredicate}]]);
    assert.throws(() => buildModelTableFromCanonical([canonical(mode === 'overlap' ? ['qty'] : [])], {uniqueWhen: map}), mode);
  }
  assert.throws(() => buildModelTable([{...definition(), uniqueWhen: {missing: condition}}]));
  let getterCalls = 0;
  const accessorPredicate: QueryPredicate = {op: 'and', args: [{op: 'eq', field: 'closed', value: true}]};
  const nested = accessorPredicate.args[0]!;
  Object.defineProperty(nested, 'value', {enumerable: true, get() {getterCalls++; return true;}});
  assert.throws(() => buildModelTableFromCanonical([canonical()], {uniqueWhen: new Map([[model, {qty: accessorPredicate}]])}));
  assert.equal(getterCalls, 0, 'nested predicate accessor must be refused before evaluation');
  const declaredMetadataKey = {...definition(), fields: {...definition().fields,
    id: {...field({required: true}), valueType: 'text' as CanTypeId}}, uniqueKeys: ['id'], uniqueWhen: {id: condition}};
  assert.throws(() => buildModelTable([declaredMetadataKey]));
});

test('real D1 commits conditional entry/exit atomically and releases before same-batch swap claims', {timeout: 30000}, async () => {
  const worker = new Miniflare({modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB']});
  try {
    const db = await worker.getD1Database('DB') as unknown as D1Database; await ensureSchema(db);
    const store = createD1Storage(db), table = buildModelTableFromCanonical([canonical()], {uniqueWhen: new Map([[model, {qty: condition}]])});
    for (const write of [create('inactive-a', '7', false), create('inactive-b', '7', false), create('a', '7', true), create('b', '8', true)]) {
      await commit(store, await runMutationWrites({store, table, context: context(), writes: [write]}));
    }
    const revision = await store.readRevision(), before = await store.query({model, authority: 'owner'});
    await assert.rejects(async () => commit(store, await runMutationWrites({store, table, context: context(), writes: [create('duplicate', '7', true)]})), conflict);
    assert.equal(await store.readRevision(), revision); assert.deepEqual(await store.query({model, authority: 'owner'}), before);
    assert.deepEqual(await store.historyFor(model, asId('duplicate')), []);
    const session = await beginOwnerMutation({store, table, context: context(), bounds});
    await session.stage(update('a', {qty: '8'}), cause); await session.stage(update('b', {qty: '7'}), cause);
    await commit(store, await session.finalize());
    await commit(store, await runMutationWrites({store, table, context: context(), writes: [update('b', {closed: false})]}));
    await commit(store, await runMutationWrites({store, table, context: context(), writes: [create('new-active', '7', true)]}));
  } finally {await worker.dispose();}
});
