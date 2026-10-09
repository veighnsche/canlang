import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanonicalOwnerModelPolicies, RecordId } from '@canlang/contracts';
import { assertOwnerMutationHookContext, beginOwnerMutation, type OwnerMutationHookContext, type MutationWritesResult } from './pipeline.js';
import { bindOwnerModelPolicies, type OwnerModelPolicyBinding } from './model-policies.js';
import { buildModelTable } from './models.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { StateError } from '../errors.js';
import { asId, asModel, makeBatch, seedRow } from '../../test/invocation/fixtures.js';
import { field, hook, modelDef, pipelineContext, invariant, refDef } from '../../test/mutation/fixtures.js';

const ITEM = asModel('Acme.Item');
const LINK = asModel('Acme.Link');
const options = { cause: 'scenario' } as const;
const bounds = { maxWork: 1000, maxRows: 20 };
const context = () => pipelineContext({ operation: 'Acme.Item.update' });
const update = (id: string, data: Record<string, unknown>) => ({ op: 'update' as const, model: ITEM, id: asId(id), data });
async function commit(store: ReturnType<typeof createTestMemoryStorage>['store'], output: MutationWritesResult) {
  await store.commit(makeBatch(await store.readRevision(), { writes: output.writes, history: output.history,
    uniqueClaims: output.uniqueClaims, uniqueReleases: output.uniqueReleases, schedules: output.schedules }));
}

test('owner session defers invariants, keeps entry snapshots and nets one version/history/unique change', async () => {
  const { store } = createTestMemoryStorage();
  await seedRow(store, ITEM, { id: 'item', version: 4, data: { title: 'entry', left: 1, right: 1 } });
  let checks = 0;
  const table = buildModelTable([modelDef('Acme.Item', { fields: { title: field(), left: field(), right: field() },
    uniqueKeys: ['title'], invariants: [invariant('balanced', view => {
      checks++;
      const row = view.get(ITEM, asId('item'))!;
      if (row.data.left !== row.data.right) throw new StateError('rule_failed', 'Unbalanced');
    })] })]);
  const before = await store.load(ITEM, asId('item'));
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await session.stage(update('item', { left: 2, title: 'intermediate' }), options);
  assert.equal(checks, 0);
  assert.equal((await session.read(ITEM, asId('item')))?.version, 5);
  assert.deepEqual(await session.views.entry.get(ITEM, asId('item')), before);
  await session.stage(update('item', { right: 2, title: 'final' }), options);
  assert.equal((await session.read(ITEM, asId('item')))?.version, 5);
  const output = await session.finalize();
  assert.equal(checks, 1);
  assert.equal(output.writes.length, 1);
  assert.equal(output.writes[0]?.kind, 'update');
  if (output.writes[0]?.kind !== 'update') throw Error('Expected update');
  assert.equal(output.writes[0].expectedVersion, 4);
  assert.equal(output.writes[0].row.version, 5);
  assert.equal(output.history.length, 1);
  assert.deepEqual(output.history[0]?.before, before?.data);
  assert.deepEqual(output.history[0]?.after, { title: 'final', left: 2, right: 2 });
  assert.deepEqual(output.uniqueReleases, [{ model: ITEM, keyName: 'title', keyValue: 'entry' }]);
  assert.deepEqual(output.uniqueClaims, [{ model: ITEM, keyName: 'title', keyValue: 'final', recordId: 'item' }]);
  assert.deepEqual(await store.load(ITEM, asId('item')), before);
  await commit(store, output);
  assert.equal((await store.load(ITEM, asId('item')))?.version, 5);
  await assert.rejects(session.read(ITEM, asId('item')), /finalized/);
  await assert.rejects(session.stage(update('item', { title: 'late' }), options), /finalized/);
  await assert.rejects(session.finalize(), /finalized/);
});

test('owner session validates final references and disposal, including target-first co-removal and repaired intermediate references', async () => {
  const { store } = createTestMemoryStorage();
  const table = buildModelTable([modelDef('Acme.Item', { fields: { title: field() }, deleteMode: 'remove' }),
    modelDef('Acme.Link', { fields: { target: { ...field(), nullable: true } },
      refs: [refDef('target', 'Acme.Item')], deleteMode: 'remove' })]);
  await seedRow(store, ITEM, { id: 'target', data: { title: 'Target' } });
  await seedRow(store, LINK, { id: 'link', data: { target: { id: 'target' } } });
  const doomed = await beginOwnerMutation({ table, store, context: context(), bounds });
  await doomed.stage({ op: 'remove', model: ITEM, id: asId('target') }, options);
  await assert.rejects(doomed.finalize(), /incoming references/);
  assert.ok(await store.load(ITEM, asId('target')));
  await assert.rejects(doomed.read(ITEM, asId('target')), /poisoned/);
  const removed = await beginOwnerMutation({ table, store, context: context(), bounds });
  await removed.stage([{ op: 'remove', model: ITEM, id: asId('target') },
    { op: 'remove', model: LINK, id: asId('link') }], options);
  const disposed = await removed.finalize();
  assert.equal(disposed.writes.length, 2);
  await commit(store, disposed);
  assert.equal(await store.load(ITEM, asId('target')), null);
  assert.equal(await store.load(LINK, asId('link')), null);
  const repaired = await beginOwnerMutation({ table, store, context: context(), bounds });
  await repaired.stage({ op: 'create', model: LINK, id: asId('new-link'), data: { target: { id: 'later' } } }, options);
  await repaired.stage({ op: 'create', model: ITEM, id: asId('later'), data: { title: 'Created later' } }, options);
  const created = await repaired.finalize();
  assert.ok(created.writes.every(write => write.kind === 'insert' && write.row.version === 1));
  await commit(store, created);
  const detached = await beginOwnerMutation({ table, store, context: context(), bounds });
  await detached.stage({ op: 'remove', model: ITEM, id: asId('later') }, options);
  await detached.stage({ op: 'update', model: LINK, id: asId('new-link'), data: { target: null } }, options);
  await commit(store, await detached.finalize());
  assert.equal(await store.load(ITEM, asId('later')), null);
});

test('owner session nets repeated creates and self-cancellation without chained versions or dangling unique claims', async () => {
  const { store } = createTestMemoryStorage();
  const table = buildModelTable([modelDef('Acme.Item', { fields: { title: field() }, uniqueKeys: ['title'], deleteMode: 'remove' })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await session.stage({ op: 'create', model: ITEM, id: asId('created'), data: { title: 'first' } }, options);
  await session.stage(update('created', { title: 'second' }), options);
  assert.equal((await session.read(ITEM, asId('created')))?.version, 1);
  await session.stage({ op: 'create', model: ITEM, id: asId('cancelled'), data: { title: 'cancelled' } }, options);
  await session.stage({ op: 'remove', model: ITEM, id: asId('cancelled') }, options);
  const output = await session.finalize();
  assert.equal(output.writes.length, 1);
  assert.equal(output.history.length, 1);
  assert.equal(output.history[0]?.change, 'create');
  assert.equal(output.history[0]?.before, null);
  assert.deepEqual(output.uniqueClaims, [{ model: ITEM, recordId: 'created', keyName: 'title', keyValue: 'second' }]);
  assert.deepEqual(output.uniqueReleases, []);
  await commit(store, output);
});

test('checked CRUD hooks run once with immutable inputs/context and reserved after while scenario and secondary writes skip hooks', async () => {
  const { store } = createTestMemoryStorage();
  await seedRow(store, ITEM, { id: 'item', version: 7, data: { title: 'entry' } });
  let sideHooks = 0;
  const table = buildModelTable([modelDef('Acme.Item', { fields: { title: field() }, deleteMode: 'remove' }),
    modelDef('Acme.Link', { fields: { title: field() }, hooks: [hook('side', ['create'], candidate => { sideHooks++; return candidate; })] })]);
  const seen: OwnerMutationHookContext[] = [];
  const descriptor: CanonicalOwnerModelPolicies = { abi: 'state.owner-model-policies@1', model: ITEM,
    module: 'owner.mjs', ownerPackage: 'Acme', rules: [], hooks: [
      { id: 'item.updated', op: 'update', operation: 'Acme.Item.update' as CanonicalOwnerModelPolicies['hooks'][number]['operation'] },
      { id: 'item.removed', op: 'remove', operation: 'Acme.Item.delete' as CanonicalOwnerModelPolicies['hooks'][number]['operation'] },
    ] };
  const bindings: OwnerModelPolicyBinding[] = descriptor.hooks.map(metadata => ({ id: metadata.id, kind: 'hook',
    module: descriptor.module, ownerPackage: descriptor.ownerPackage, model: ITEM,
    run: (candidate, carrier) => {
      assertOwnerMutationHookContext(carrier);
      const ctx = carrier;
      seen.push(ctx);
      assert.ok(Object.isFrozen(ctx.context));
      assert.ok(Object.isFrozen(ctx.input));
      assert.ok(Object.isFrozen(ctx.before));
      if (ctx.op === 'update') {
        assert.equal(ctx.before?.version, 7);
        assert.equal(ctx.before?.data.title, 'intermediate');
        assert.equal(ctx.after?.version, 8);
        assert.equal(ctx.after?.data.title, 'crud');
        assert.equal(ctx.input.title, 'crud');
        assert.equal(ctx.context.operation, 'Acme.Item.update');
        assert.throws(() => { (ctx.input as Record<string, unknown>).title = 'forged'; }, TypeError);
        ctx.stage({ op: 'create', model: LINK, id: asId('side'), data: { title: 'side' } });
        return { ...candidate, title: 'adjusted' };
      }
      assert.equal(ctx.after, null);
      return candidate;
    } }));
  const policies = bindOwnerModelPolicies({ table, descriptors: [descriptor], bindings });
  const session = await beginOwnerMutation({ table, store, context: context(), bounds, policies });
  await session.stage(update('item', { title: 'intermediate' }), options);
  await session.stage(update('item', { title: 'crud' }), { cause: 'crud', input: { title: 'crud' } });
  await session.stage(update('item', { title: 'final' }), options);
  const output = await session.finalize();
  assert.equal(seen.length, 1);
  assert.throws(() => assertOwnerMutationHookContext(seen[0]!), /closed/);
  assert.equal(sideHooks, 0);
  assert.equal(output.writes.length, 2);
  await commit(store, output);
  const remove = await beginOwnerMutation({ table, store, context: pipelineContext({ operation: 'Acme.Item.delete' }), bounds, policies });
  await remove.stage({ op: 'remove', model: ITEM, id: asId('item') }, { cause: 'crud', input: { record: { id: 'item', version: '8' } } });
  await remove.finalize();
  assert.equal(seen.length, 2);
});

test('owner session refuses missing CRUD inputs, caught hook adjustment, concurrency, budget overflow and changed revision permanently', async () => {
  const { store } = createTestMemoryStorage();
  await seedRow(store, ITEM, { id: 'item', data: { title: 'entry' } });
  const table = buildModelTable([modelDef('Acme.Item', { fields: { title: field() }, deleteMode: 'remove' })]);
  const missing = await beginOwnerMutation({ table, store, context: context(), bounds });
  await assert.rejects(missing.stage(update('item', { title: 'x' }), { cause: 'crud' }), /admitted CRUD inputs/);
  await assert.rejects(missing.finalize(), /poisoned/);
  const over = await beginOwnerMutation({ table, store, context: context(), bounds: { maxRows: 1, maxWork: 1 } });
  await assert.rejects(over.stage(update('item', { title: 'x' }), options), /work budget/);
  await assert.rejects(over.read(ITEM, asId('item')), /poisoned/);
  await seedRow(store, ITEM, { id: 'second', data: { title: 'second' } });
  const query = await beginOwnerMutation({ table, store, context: context(), bounds: { maxRows: 1, maxWork: 100 } });
  await assert.rejects(query.views.final.query({ model: ITEM, authority: 'owner', limit: 1 }), /row bound/);
  await assert.rejects(query.finalize(), /poisoned/);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const delayed = { ...store, load: async (model: typeof ITEM, id: RecordId) => { enter(); await held; return store.load(model, id); } };
  const concurrent = await beginOwnerMutation({ table, store: delayed, context: context(), bounds });
  const read = concurrent.read(ITEM, asId('item'));
  await entered;
  await assert.rejects(concurrent.stage(update('item', { title: 'x' }), options), /Concurrent/);
  release();
  await assert.rejects(read, /poisoned/);
  const stale = await beginOwnerMutation({ table, store, context: context(), bounds });
  await seedRow(store, ITEM, { id: 'third', data: { title: 'third' } });
  await assert.rejects(stale.read(ITEM, asId('item')), /State changed/);
  await assert.rejects(stale.finalize(), /poisoned/);
  const caughtTable = buildModelTable([modelDef('Acme.Item', { fields: { title: field() },
    hooks: [hook('caught-invalid-staging', ['update'], (candidate, ctx) => {
      assert.throws(() => ctx.stage({ op: 'create', model: ITEM, id: asId('illegal') }), /same-model/);
      return candidate;
    })] })]);
  const caught = await beginOwnerMutation({ table: caughtTable, store, context: context(), bounds });
  await assert.rejects(caught.stage(update('item', { title: 'x' }), { cause: 'crud', input: {} }), /poisoned/);
  await assert.rejects(caught.finalize(), /poisoned/);
  const adjustedTable = buildModelTable([modelDef('Acme.Item', { fields: { title: field() }, deleteMode: 'archive',
    hooks: [hook('remove-adjustment', ['remove'], candidate => ({ ...candidate, title: 'illegal' }))] })]);
  const adjustment = await beginOwnerMutation({ table: adjustedTable, store, context: context(), bounds });
  await assert.rejects(adjustment.stage({ op: 'remove', model: ITEM, id: asId('item') }, { cause: 'crud', input: {} }), /cannot adjust/);
  await assert.rejects(adjustment.finalize(), /poisoned/);
  assert.equal((await store.load(ITEM, asId('item')))?.data.title, 'entry');
});

test('owner entry/final queries preserve provisional membership and the defining numeric ordering under explicit completeness bounds', async () => {
  const { store } = createTestMemoryStorage();
  const table = buildModelTable([modelDef('Acme.Item', { fields: { title: field(),
    rank: { ...field(), valueType: 'int' }, included: field() } })]);
  await seedRow(store, ITEM, { id: 'ten', data: { title: 'ten', rank: '10', included: true } });
  await seedRow(store, ITEM, { id: 'two', data: { title: 'two', rank: '2', included: true } });
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  const selection = { model: ITEM, authority: 'owner' as const, limit: 2,
    order: [{ field: 'rank', direction: 'asc' as const }], where: { op: 'eq' as const, field: 'included', value: true } };
  assert.deepEqual((await session.views.entry.query(selection)).map(row => row.id), ['two', 'ten']);
  await session.stage(update('ten', { included: false }), options);
  await session.stage({ op: 'create', model: ITEM, id: asId('one'), data: { title: 'one', rank: '1', included: true } }, options);
  assert.deepEqual((await session.views.final.query(selection)).map(row => row.id), ['one', 'two']);
  assert.deepEqual((await session.views.entry.query(selection)).map(row => row.id), ['two', 'ten']);
  await session.finalize();
});

test('owner receipt defaults reuse stable ordered write attribution across direct and hook-secondary creations', async () => {
  const { store } = createTestMemoryStorage();
  const table = buildModelTable([modelDef('Acme.Item', { fields: { title: field({ default: 'item' }) },
    hooks: [hook('create-link', ['create'], (candidate, ctx) => {
      assertOwnerMutationHookContext(ctx);
      assert.equal(ctx.before, null);
      assert.equal(ctx.after?.version, 1);
      assert.equal(ctx.after?.data.title, 'item');
      assert.ok(Object.isFrozen(ctx.input));
      assert.ok(Object.isFrozen(ctx.after));
      ctx.stage({ op: 'create', model: LINK, id: asId(`${ctx.triggerId}-link`) });
      return candidate;
    })] }), modelDef('Acme.Link', { fields: { title: field({ default: 'link' }) } })]);
  const execute = async () => {
    const session = await beginOwnerMutation({ table, store, context: pipelineContext({ operation: 'Acme.Item.create' }), bounds });
    await session.stage({ op: 'create', model: ITEM, id: asId('first') }, { cause: 'crud', input: {} });
    await session.stage({ op: 'create', model: ITEM, id: asId('second') }, { cause: 'crud', input: {} });
    return session.finalize();
  };
  const first = await execute();
  assert.deepEqual(first.resolvedDefaults, { '0:Acme.Item.title': 'item', '1:Acme.Link.title': 'link',
    '2:Acme.Item.title': 'item', '3:Acme.Link.title': 'link' });
  const retry = await execute();
  assert.deepEqual(retry.resolvedDefaults, first.resolvedDefaults);
  assert.deepEqual(retry.writes, first.writes);
  assert.deepEqual(retry.history, first.history);
  assert.equal((await store.query({ model: ITEM, authority: 'owner' })).length, 0);
});
