/** Original Turn's Run/role constraint over actual mutation/storage claims. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CanTypeId, CanonicalModelDescriptor, StoragePort } from '@canlang/contracts';
import { normalizeSchema } from '@canlang/values';
import { StateError } from '../errors.js';
import { canonicalUniqueRowValue } from '../internal/unique-value.js';
import { createD1Storage, ensureSchema } from '../storage/d1.js';
import { StorageConstraintError, FenceConflictError } from '../storage/port.js';
import { buildModelTable, buildModelTableFromCanonical, type InterimModelDef, type ModelTable } from './models.js';
import { beginOwnerMutation, runMutationWrites, type MutationWritesResult } from './pipeline.js';
import { activate, publishStagedAndDrops } from '../migration/activate.js';
import { validateStaged } from '../migration/validate.js';
import { stageNextChunk } from '../migration/stage.js';
import { validateTransition } from '../migration/transition.js';
import { todoPlan, fixedClock, oldLocks, makeInstalled, makeTransition, seedLive, setupMigrationWorld, installSnapshot } from '../../test/migration/fixtures.js';
import { makeBatch } from '../../test/invocation/fixtures.js';
import { asId, asModel, crudCreate, crudUpdate, crudRemove, field, hook, invariant,
  modelDef, mustLoad, pipelineContext, setupMutation } from '../../test/mutation/fixtures.js';

const TURN = 'chat.Turn', RUN = 'chat.Run', BRANCH = 'chat.Branch', model = asModel(TURN);
const context = () => pipelineContext({operation: 'chat.ask'});
const bounds = {maxRows: 30, maxWork: 1000}, cause = {cause: 'scenario'} as const;
const conflict = (e: unknown) => e instanceof StateError && e.code === 'conflict' || e instanceof StorageConstraintError && e.kind === 'unique';
function definitions(deleteMode: 'archive' | 'remove' = 'remove'): InterimModelDef[] {
  return [modelDef(RUN, {deleteMode: 'remove'}), modelDef(BRANCH, {deleteMode: 'remove'}), {
    ...modelDef(TURN, {fields: {
      run: {...field({required: true}), valueType: RUN as CanTypeId},
      role: {...field({required: true}), valueType: 'enum(user,assistant)' as CanTypeId},
      position: {...field({required: true}), valueType: 'int' as CanTypeId},
    }, refs: [{field: 'run', model: asModel(RUN)}], uniqueKeys: ['position', 'run,role'], deleteMode}),
    uniqueGroups: [['run', 'role']],
  }];
}
const data = (run: string, role: string, position = '1') => ({run: {id: run}, role, position});
const create = (id: string, run: string, role: string, position = '1') => ({op: 'create' as const, model, id: asId(id), data: data(run, role, position)});
const update = (id: string, patch: Record<string, unknown>) => ({op: 'update' as const, model, id: asId(id), data: patch});
async function commit(store: StoragePort, output: MutationWritesResult) {await store.commit(makeBatch(await store.readRevision(), output));}
async function seed(store: StoragePort, table: ModelTable) {
  for (const id of ['r1', 'r2', 'r|1', 'r,1']) await commit(store, await runMutationWrites({store, table, context: context(), writes: [
    {op: 'create', model: asModel(RUN), id: asId(id), data: {}}]}));
}

test('same Run/role conflicts atomically; independent roles/runs admit, scalar position and replay stay intact', async () => {
  const w = await setupMutation(definitions()); await seed(w.store, w.table);
  const first = await crudCreate(w, TURN, {id: 'a', data: data('r1', 'user')});
  const revision = await w.store.readRevision(), history = await w.store.historyFor(model, asId('a'));
  assert.equal((await crudCreate(w, TURN, {id: 'a', data: data('r1', 'user'), operationId: first.operationId})).out.status, 'replayed');
  assert.equal(await w.store.readRevision(), revision); assert.deepEqual(await w.store.historyFor(model, asId('a')), history);
  await assert.rejects(crudCreate(w, TURN, {id: 'duplicate', data: {...data('r1', 'user', '2'), run: {id: 'r1', version: '2'}}}), conflict);
  assert.equal(await w.store.load(model, asId('duplicate')), null); assert.deepEqual(await w.store.historyFor(model, asId('duplicate')), []);
  await crudCreate(w, TURN, {id: 'other-role', data: data('r1', 'assistant', '2')});
  await crudCreate(w, TURN, {id: 'other-run', data: data('r2', 'user', '3')});
  await assert.rejects(crudCreate(w, TURN, {id: 'same-position', data: data('r2', 'assistant', '3')}), conflict);
  const separate = await setupMutation(definitions()); await seed(separate.store, separate.table);
  await crudCreate(separate, TURN, {id: 'other-owner', data: data('r1', 'user')});
});

test('tuple updates, owner final-net swaps and transient duplicate removal use one existing claim fence', async () => {
  const w = await setupMutation(definitions()); await seed(w.store, w.table);
  await crudCreate(w, TURN, {id: 'a', data: data('r1', 'user')});
  await crudCreate(w, TURN, {id: 'b', data: data('r1', 'assistant', '2')});
  await assert.rejects(crudUpdate(w, TURN, 'b', {version: 1, patch: {role: 'user'}}), conflict);
  const session = await beginOwnerMutation({store: w.store, table: w.table, context: context(), bounds});
  await session.stage(update('a', {role: 'assistant'}), cause); await session.stage(update('b', {role: 'user'}), cause);
  const output = await session.finalize();
  assert.equal(output.uniqueClaims.filter(c => c.keyName === 'run,role').length, 2);
  assert.equal(output.uniqueReleases.filter(c => c.keyName === 'run,role').length, 2); await commit(w.store, output);
  const net = await beginOwnerMutation({store: w.store, table: w.table, context: context(), bounds});
  await net.stage(create('c', 'r2', 'user', '3'), cause); await net.stage(create('d', 'r2', 'user', '4'), cause);
  await net.stage(update('d', {role: 'assistant'}), cause);
  await net.stage(create('gone', 'r2', 'user', '5'), cause); await net.stage({op: 'remove', model, id: asId('gone')}, cause);
  await commit(w.store, await net.finalize());
  await crudUpdate(w, TURN, 'a', {version: 2, patch: {run: {id: 'r,1'}}});
  await crudCreate(w, TURN, {id: 'released', data: data('r1', 'assistant', '6')});
});

test('remove releases; archive retains; final hook tuple and late failure never leak claims', async () => {
  for (const mode of ['remove', 'archive'] as const) {
    const w = await setupMutation(definitions(mode)); await seed(w.store, w.table);
    await crudCreate(w, TURN, {id: 'a', data: data('r1', 'user')}); await crudRemove(w, TURN, 'a', {version: 1});
    const retry = () => crudCreate(w, TURN, {id: 'b', data: data('r1', 'user', '2')});
    if (mode === 'remove') await retry(); else await assert.rejects(retry(), conflict);
  }
  const defs = definitions(), turn = defs[2]!;
  const w = await setupMutation([...defs.slice(0, 2), {...turn,
    hooks: [hook('final-role', ['create', 'update'], candidate => ({...candidate, role: 'assistant'}))],
    invariants: [invariant('late', view => {if (view.get(model, asId('failed')) !== null) throw new StateError('rule_failed', 'late');})],
  }]); await seed(w.store, w.table);
  await assert.rejects(crudCreate(w, TURN, {id: 'failed', data: data('r1', 'user')}), e => e instanceof StateError && e.code === 'rule_failed');
  assert.equal(await w.store.load(model, asId('failed')), null); assert.deepEqual(await w.store.historyFor(model, asId('failed')), []);
  await crudCreate(w, TURN, {id: 'recovered', data: data('r1', 'user')});
  assert.equal((await mustLoad(w.store, model, 'recovered')).data.role, 'assistant');
  await assert.rejects(crudCreate(w, TURN, {id: 'hook-duplicate', data: data('r1', 'user', '2')}), conflict);
  const stale = await runMutationWrites({store: w.store, table: w.table, context: context(), writes: [create('stale', 'r2', 'user', '3')]});
  const revision = await w.store.readRevision(); await crudCreate(w, RUN, {id: 'fence'});
  await assert.rejects(w.store.commit(makeBatch(revision, stale)), e => e instanceof FenceConflictError);
  assert.equal(await w.store.load(model, asId('stale')), null);
  await crudCreate(w, TURN, {id: 'after-stale', data: data('r2', 'user', '3')});
});

test('checked tuple preserves declared parent scope, collision-free slots and version-independent identity', () => {
  const defs = definitions(); defs[2] = {...defs[2]!, containment: {parent: asModel(BRANCH)}};
  const def = buildModelTable(defs).get(model)!, row = (id: string) => ({data: data('r|1', 'user'), parent: {model: asModel(BRANCH), id: asId(id)}});
  const key = canonicalUniqueRowValue(row('b'), 'run,role', def);
  assert.notEqual(key, canonicalUniqueRowValue(row('b|x'), 'run,role', def));
  assert.notEqual(key, canonicalUniqueRowValue({...row('b'), data: data('r,1', 'user')}, 'run,role', def));
  assert.equal(key, canonicalUniqueRowValue({...row('b'), data: {...data('r|1', 'user'), run: {id: 'r|1', version: '9'}}}, 'run,role', def));
  assert.throws(() => canonicalUniqueRowValue({...row('b'), parent: {model: asModel(RUN), id: asId('b')}}, 'run,role', def));
  assert.throws(() => canonicalUniqueRowValue({...row('b'), parent: null}, 'run,role', def));
  assert.throws(() => canonicalUniqueRowValue(row('b'), 'run,role', {...def}));
  for (const run of [null, [], {}, {id: ''}, {id: 'r1', model: RUN}, {id: 'r1', version: '01'}, {id: 'r1', version: '0'}, {id: 'r1', version: '-1'}, {id: 'r1', extra: true}]) {
    assert.throws(() => canonicalUniqueRowValue({...row('b'), data: {...data('r1', 'user'), run}}, 'run,role', def));
  }
  for (const role of [null, 'other', {}, ['user']]) assert.throws(() => canonicalUniqueRowValue({...row('b'), data: {...data('r1', 'user'), role}}, 'run,role', def));
  let reads = 0; const run = Object.defineProperty({}, 'id', {enumerable: true, get() {reads++; return 'r1';}});
  assert.throws(() => canonicalUniqueRowValue({...row('b'), data: {...data('r1', 'user'), run}}, 'run,role', def)); assert.equal(reads, 0);
});

test('canonical checked source attachment retains owning enum and refuses unsupported/malformed groups before reads', () => {
  const schema = normalizeSchema({contracts: {}, enums: {'std.TextMessage.role': {cases: ['user', 'assistant']}}});
  const models: CanonicalModelDescriptor[] = [
    {name: asModel(RUN), fields: {}, deleteMode: 'remove'},
    {name: model, fields: {run: {valueType: RUN as CanTypeId, required: true, serverOnly: false},
      role: {valueType: 'std.TextMessage.role' as CanTypeId, required: true, serverOnly: false}}, deleteMode: 'remove'},
  ];
  const groups = [['run', 'role']], opts = {valueSchema: schema, refs: new Map([[model, [{field: 'run', model: asModel(RUN)}]]]), uniqueGroups: new Map([[model, groups]])};
  const table = buildModelTableFromCanonical(models, opts); groups[0]![0] = 'missing';
  assert.deepEqual(table.get(model)!.uniqueGroups, [['run', 'role']]); assert.ok(Object.isFrozen(table.get(model)!.uniqueGroups![0]));
  assert.equal(typeof canonicalUniqueRowValue({data: data('r1', 'user'), parent: null}, 'run,role', table.get(model)!), 'string');
  assert.throws(() => buildModelTableFromCanonical(models, {...opts, uniqueGroups: new Map([[asModel('wrong.Turn'), [['run', 'role']]]])}));
  for (const group of [[['run']], [['run', 'run']], [['missing', 'role']], [['role', 'run']], [['run', 'role'], ['run', 'role']]]) {
    assert.throws(() => buildModelTableFromCanonical(models, {...opts, uniqueGroups: new Map([[model, group]])}));
  }
  for (const patch of [{required: false}, {nullable: true, valueType: `${RUN}?` as CanTypeId}, {array: {required: false}, valueType: `${RUN}[]` as CanTypeId}, {valueType: 'secret' as CanTypeId}]) {
    const defs = definitions(); defs[2] = {...defs[2]!, fields: {...defs[2]!.fields, run: {...defs[2]!.fields.run!, ...patch}}};
    assert.throws(() => buildModelTable(defs));
  }
  for (const patch of [{refs: [{field: 'run', model: asModel(BRANCH)}]}, {uniqueKeys: ['run,role', 'run,role']}, {uniqueKeys: ['position']},
    {fields: {...definitions()[2]!.fields, role: {...field({required: true}), valueType: 'text' as CanTypeId}}}]) {
    const defs = definitions(); defs[2] = {...defs[2]!, ...patch}; assert.throws(() => buildModelTable(defs));
  }
  const defs = definitions(); defs[2] = {...defs[2]!, uniqueWhen: {'run,role': {op: 'eq', field: 'position', value: '1'}}};
  assert.throws(() => buildModelTable(defs));
  let reads = 0; const malformed = Object.defineProperty([], '0', {enumerable: true, get() {reads++; return ['run', 'role'];}});
  assert.throws(() => buildModelTableFromCanonical(models, {...opts, uniqueGroups: new Map([[model, malformed]])})); assert.equal(reads, 0);
});

test('real Memory/D1 duplicate commits and swaps are atomic; migration refuses missing tuple schema identity before effects', {timeout: 30000}, async () => {
  const worker = new Miniflare({modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB']});
  try {
    const db = await worker.getD1Database('DB') as unknown as D1Database; await ensureSchema(db);
    const memory = await setupMutation(definitions());
    for (const store of [memory.store, createD1Storage(db)]) {
      const table = buildModelTable(definitions()); await seed(store, table);
      await commit(store, await runMutationWrites({store, table, context: context(), writes: [create('a', 'r1', 'user'), create('b', 'r1', 'assistant', '2')]}));
      const duplicate = await runMutationWrites({store, table, context: context(), writes: [create('duplicate', 'r1', 'user', '3')]});
      const revision = await store.readRevision(), rows = await store.query({model, authority: 'owner'});
      await assert.rejects(commit(store, duplicate), conflict);
      assert.equal(await store.readRevision(), revision); assert.deepEqual(await store.query({model, authority: 'owner'}), rows);
      assert.deepEqual(await store.historyFor(model, asId('duplicate')), []);
      const session = await beginOwnerMutation({store, table, context: context(), bounds});
      await session.stage(update('a', {role: 'assistant'}), cause); await session.stage(update('b', {role: 'user'}), cause); await commit(store, await session.finalize());
      await commit(store, await runMutationWrites({store, table, context: context(), writes: [create('other-run', 'r2', 'user', '3')]}));
      await assert.rejects(async () => commit(store, await runMutationWrites({store, table, context: context(), writes: [update('b', {run: {id: 'r2'}})]})), conflict);
      await commit(store, await runMutationWrites({store, table, context: context(), writes: [update('b', {run: {id: 'r|1'}}), {op: 'remove', model, id: asId('a')}]}));
      await commit(store, await runMutationWrites({store, table, context: context(), writes: [create('reused', 'r1', 'assistant', '1')]}));
      const net = await beginOwnerMutation({store, table, context: context(), bounds});
      await net.stage(create('net-a', 'r,1', 'user', '4'), cause); await net.stage(create('net-b', 'r,1', 'user', '5'), cause);
      await net.stage(update('net-b', {role: 'assistant'}), cause); await commit(store, await net.finalize());
      const archived = buildModelTable(definitions('archive'));
      await commit(store, await runMutationWrites({store, table: archived, context: context(), writes: [{op: 'remove', model, id: asId('reused')}]}));
      await assert.rejects(async () => commit(store, await runMutationWrites({store, table: archived, context: context(), writes: [create('retained', 'r1', 'assistant', '6')]})), conflict);
      const defs = definitions(); defs[2] = {...defs[2]!, hooks: [hook('late-role', ['create'], c => ({...c, role: 'assistant'}))],
        invariants: [invariant('late-failure', view => {if (view.get(model, asId('failed')) !== null) throw new StateError('rule_failed', 'late');})]};
      const hooked = buildModelTable(defs), late = await beginOwnerMutation({store, table: hooked, context: context(), bounds});
      await late.stage(create('failed', 'r2', 'user', '7'), {cause: 'crud', input: data('r2', 'user', '7')});
      await assert.rejects(late.finalize(), e => e instanceof StateError && e.code === 'rule_failed');
      assert.equal(await store.load(model, asId('failed')), null); assert.deepEqual(await store.historyFor(model, asId('failed')), []);
      const recovered = await beginOwnerMutation({store, table: hooked, context: context(), bounds});
      await recovered.stage(create('recovered', 'r2', 'user', '7'), {cause: 'crud', input: data('r2', 'user', '7')});
      await commit(store, await recovered.finalize()); assert.equal((await mustLoad(store, model, 'recovered')).data.role, 'assistant');
      const other = asModel('other.Turn'), otherDef = {...definitions()[2]!, model: other};
      const isolated = buildModelTable([...definitions(), otherDef]);
      await commit(store, await runMutationWrites({store, table: isolated, context: context(), writes: [{...create('other-model', 'r2', 'user', '3'), model: other}]}));
      const scopedDefs = definitions(), scoped = asModel('chat.ScopedTurn');
      const scopedDef = {...scopedDefs[2]!, model: scoped, uniqueKeys: ['run,role'], containment: {parent: asModel(BRANCH)}};
      const scopedTable = buildModelTable([...scopedDefs, scopedDef]);
      for (const id of ['branch-a', 'branch-b']) await commit(store, await runMutationWrites({store, table: scopedTable, context: context(), writes: [{op: 'create', model: asModel(BRANCH), id: asId(id), data: {}}]}));
      const scopedWrite = (id: string, parent: string) => ({...create(id, 'r1', 'user'), model: scoped, parent: {model: asModel(BRANCH), id: asId(parent)}});
      await commit(store, await runMutationWrites({store, table: scopedTable, context: context(), writes: [scopedWrite('scoped-a', 'branch-a'), scopedWrite('scoped-b', 'branch-b')]}));
      await assert.rejects(async () => commit(store, await runMutationWrites({store, table: scopedTable, context: context(), writes: [scopedWrite('scoped-duplicate', 'branch-a')]})), conflict);
      const beforeMigration = await store.readRevision(), plan = todoPlan();
      const input = {store, plan, oldModels: table, desiredModels: table};
      await assert.rejects(validateStaged({...input, oldLocks: oldLocks([])}), /checked source group census/);
      await assert.rejects(activate({...input, inventory: [], chunkSize: 10, clock: fixedClock()}), /checked source group census/);
      await assert.rejects(publishStagedAndDrops(store, plan, table, table, 10, 1, 'actor'), /checked source group census/);
      assert.equal(await store.readRevision(), beforeMigration); assert.equal(await store.readMigrationProgress(plan.migrationId), null);
      assert.equal((await mustLoad(store, model, 'b')).data.role, 'user');
    }
  } finally {await worker.dispose();}
});


test('affected migration row calls preserve conditional admission and atomic active-key transfer', async () => {
  const name = asModel('ConditionalMigration.Item');
  const def = {...modelDef(name, {fields: {qty: {...field({required: true}), valueType: 'int' as CanTypeId},
    closed: {...field({required: true}), valueType: 'bool' as CanTypeId}}, uniqueKeys: ['qty'], deleteMode: 'remove'}),
    uniqueWhen: {qty: {op: 'eq' as const, field: 'closed', value: true}}};
  for (const duplicate of [false, true]) {
    const {store} = setupMigrationWorld(), oldModels = buildModelTable([{...def, uniqueKeys: [], uniqueWhen: {}}]), desiredModels = buildModelTable([def]);
    await seedLive(store, name, [{id: 'a', data: {qty: '7', closed: duplicate}}, {id: 'b', data: {qty: '7', closed: duplicate}}]);
    const plan = validateTransition(makeInstalled(), makeTransition(), oldModels, desiredModels);
    await stageNextChunk({store, plan, oldModels, desiredModels, mappers: new Map(), chunkSize: 10});
    const input = {store, plan, oldModels, desiredModels, oldLocks: oldLocks([])};
    if (duplicate) await assert.rejects(validateStaged(input), /duplicate unique/);
    else assert.equal((await validateStaged(input)).phase, 'staged');
  }
  const {store} = setupMigrationWorld(), table = buildModelTable([def]);
  for (const [id, closed] of [['a', true], ['b', false]] as const) await commit(store, await runMutationWrites({store, table, context: context(), writes: [
    {op: 'create', model: name, id: asId(id), data: {qty: '7', closed}}]}));
  const plan = validateTransition(makeInstalled(), makeTransition({directives: [{kind: 'backfill', model: name}]}), table, table);
  await installSnapshot(store, makeInstalled());
  await stageNextChunk({store, plan, oldModels: table, desiredModels: table, chunkSize: 10, mappers: new Map([[name, (before, row) => {row.set('closed', !before.data.closed);} ]])});
  assert.equal((await validateStaged({store, plan, oldModels: table, desiredModels: table, oldLocks: oldLocks([])})).phase, 'staged');
  await activate({store, plan, oldModels: table, desiredModels: table, inventory: [], chunkSize: 10, clock: fixedClock()});
  assert.equal((await mustLoad(store, name, 'a')).data.closed, false); assert.equal((await mustLoad(store, name, 'b')).data.closed, true);
  await assert.rejects(async () => commit(store, await runMutationWrites({store, table, context: context(), writes: [{op: 'create', model: name, id: asId('duplicate'), data: {qty: '7', closed: true}}]})), conflict);
  await commit(store, await runMutationWrites({store, table, context: context(), writes: [{op: 'update', model: name, id: asId('b'), data: {closed: false}}, {op: 'create', model: name, id: asId('recovered'), data: {qty: '7', closed: true}}]}));
});
