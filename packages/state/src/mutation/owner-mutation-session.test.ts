import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanonicalOwnerModelPolicies, RecordId } from '@canlang/contracts';
import { assertOwnerMutationHookContext, beginOwnerMutation, type OwnerMutationHookContext, type MutationWritesResult } from './pipeline.js';
import { bindOwnerModelPolicies, type OwnerModelPolicyBinding } from './model-policies.js';
import { buildModelTable } from './models.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { StateError } from '../errors.js';
import { asId, asModel, asOperation, makeBatch, seedRow } from '../../test/invocation/fixtures.js';
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

test('owner session defers invariants, preserves ordered history and nets one version/write/unique change', async () => {
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
  assert.equal(output.history.length, 2);
  assert.deepEqual(output.history[0]?.before, before?.data);
  assert.deepEqual(output.history[0]?.after, { title: 'intermediate', left: 2, right: 1 });
  assert.deepEqual(output.history[1]?.before, output.history[0]?.after);
  assert.deepEqual(output.history[1]?.after, { title: 'final', left: 2, right: 2 });
  assert.deepEqual(output.history.map(entry => entry.version), [5, 5]);
  assert.deepEqual(output.uniqueReleases, [{ model: ITEM, keyName: 'title', keyValue: 'entry' }]);
  assert.deepEqual(output.uniqueClaims, [{ model: ITEM, keyName: 'title', keyValue: 'final', recordId: 'item' }]);
  assert.deepEqual(await store.load(ITEM, asId('item')), before);
  await commit(store, output);
  assert.equal((await store.load(ITEM, asId('item')))?.version, 5);
  await assert.rejects(session.read(ITEM, asId('item')), /finalized/);
  await assert.rejects(session.stage(update('item', { title: 'late' }), options), /finalized/);
  await assert.rejects(session.finalize(), /finalized/);
});

test('existing-row A/B/A effects keep source-order history and per-stage operation attribution at one reserved version', async () => {
  const { store } = createTestMemoryStorage();
  await seedRow(store, ITEM, { id: 'a', data: { value: 0 } });
  await seedRow(store, ITEM, { id: 'b', data: { value: 0 } });
  const table = buildModelTable([modelDef('Acme.Item', { fields: { value: field() } })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  const root = session.views.context;
  const stages = [
    { id: 'a', value: 1, operation: 'Acme.first' },
    { id: 'b', value: 1, operation: 'Acme.second' },
    { id: 'a', value: 2, operation: 'Acme.third' },
  ];
  for (const stage of stages) {
    await session.stage(update(stage.id, { value: stage.value }), {
      ...options, context: Object.freeze({ ...root, operation: asOperation(stage.operation) }),
    });
  }
  const output = await session.finalize();
  assert.deepEqual(output.history.map(entry => ({ id: entry.recordId, before: entry.before,
    after: entry.after, version: entry.version, operation: entry.operation, operationId: entry.operationId })), [
    { id: 'a', before: { value: 0 }, after: { value: 1 }, version: 2, operation: 'Acme.first', operationId: root.operationId },
    { id: 'b', before: { value: 0 }, after: { value: 1 }, version: 2, operation: 'Acme.second', operationId: root.operationId },
    { id: 'a', before: { value: 1 }, after: { value: 2 }, version: 2, operation: 'Acme.third', operationId: root.operationId },
  ]);
  assert.equal(output.writes.length, 2);
  for (const write of output.writes) {
    assert.equal(write.kind, 'update');
    if (write.kind !== 'update') throw Error('Expected existing-row update');
    assert.equal(write.expectedVersion, 1); assert.equal(write.row.version, 2);
    assert.equal(write.row.data.value, write.id === 'a' ? 2 : 1);
  }
  assert.deepEqual(await store.historyFor(ITEM, asId('a')), []);
  assert.deepEqual(await store.historyFor(ITEM, asId('b')), []);
  let commits = 0;
  const actualCommit = store.commit;
  store.commit = async batch => { commits++; return actualCommit(batch); };
  await commit(store, output); assert.equal(commits, 1);
  assert.equal((await store.load(ITEM, asId('a')))?.data.value, 2);
  assert.equal((await store.load(ITEM, asId('b')))?.data.value, 1);
  assert.deepEqual(await store.historyFor(ITEM, asId('a')), output.history.filter(entry => entry.recordId === 'a'));
  assert.deepEqual(await store.historyFor(ITEM, asId('b')), output.history.filter(entry => entry.recordId === 'b'));
});

test('a later owner-stage failure leaves earlier effects and ordered history uncommitted', async () => {
  const { store } = createTestMemoryStorage();
  await seedRow(store, ITEM, { id: 'a', data: { value: 0 } });
  const before = await store.load(ITEM, asId('a')), revision = await store.readRevision();
  const table = buildModelTable([modelDef('Acme.Item', { fields: { value: field() } })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  let commits = 0;
  const actualCommit = store.commit;
  store.commit = async batch => { commits++; return actualCommit(batch); };
  await session.stage(update('a', { value: 1 }), options);
  await session.stage(update('a', { value: 2 }), options);
  await assert.rejects(session.stage(update('missing', { value: 3 }), options));
  await assert.rejects(session.finalize(), /poisoned/);
  assert.equal(commits, 0); assert.equal(await store.readRevision(), revision);
  assert.deepEqual(await store.load(ITEM, asId('a')), before);
  assert.deepEqual(await store.historyFor(ITEM, asId('a')), []);
});

test('mixed existing effects retain source order while new rows net creation and self-cancellation', async () => {
  const { store } = createTestMemoryStorage();
  await seedRow(store, ITEM, { id: 'a', data: { title: 'a', value: 0 } });
  await seedRow(store, ITEM, { id: 'b', data: { title: 'b', value: 0 } });
  const table = buildModelTable([modelDef('Acme.Item', { fields: { title: field(), value: field() },
    uniqueKeys: ['title'], deleteMode: 'remove' })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await session.stage(update('a', { value: 1 }), options);
  await session.stage({ op: 'create', model: ITEM, id: asId('new'), data: { title: 'first', value: 0 } }, options);
  await session.stage(update('b', { value: 1 }), options);
  await session.stage(update('new', { title: 'final', value: 1 }), options);
  await session.stage(update('a', { value: 2 }), options);
  await session.stage({ op: 'create', model: ITEM, id: asId('cancelled'), data: { title: 'cancelled', value: 0 } }, options);
  await session.stage({ op: 'remove', model: ITEM, id: asId('cancelled') }, options);
  const output = await session.finalize();
  assert.deepEqual(output.history.map(entry => ({ id: entry.recordId, change: entry.change,
    version: entry.version, before: entry.before, after: entry.after })), [
    { id: 'a', change: 'update', version: 2, before: { title: 'a', value: 0 }, after: { title: 'a', value: 1 } },
    { id: 'b', change: 'update', version: 2, before: { title: 'b', value: 0 }, after: { title: 'b', value: 1 } },
    { id: 'new', change: 'create', version: 1, before: null, after: { title: 'final', value: 1 } },
    { id: 'a', change: 'update', version: 2, before: { title: 'a', value: 1 }, after: { title: 'a', value: 2 } },
  ]);
  assert.equal(output.writes.length, 3);
  const created = output.writes.find(write => write.kind === 'insert');
  assert.ok(created?.kind === 'insert'); assert.equal(created.row.id, 'new'); assert.equal(created.row.version, 1);
  assert.deepEqual(output.uniqueClaims, [{ model: ITEM, recordId: 'new', keyName: 'title', keyValue: 'final' }]);
  assert.deepEqual(output.uniqueReleases, []);
  await commit(store, output);
  assert.equal(await store.load(ITEM, asId('cancelled')), null);
  assert.deepEqual(await store.historyFor(ITEM, asId('cancelled')), []);
  assert.deepEqual(await store.historyFor(ITEM, asId('new')), output.history.filter(entry => entry.recordId === 'new'));
});

test('existing-row update then permanent removal keeps both ordered effects at the reserved removal version', async () => {
  const { store } = createTestMemoryStorage();
  await seedRow(store, ITEM, { id: 'a', version: 4, data: { value: 0 } });
  const table = buildModelTable([modelDef('Acme.Item', { fields: { value: field() }, deleteMode: 'remove' })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await session.stage(update('a', { value: 1 }), options);
  await session.stage({ op: 'remove', model: ITEM, id: asId('a') }, options);
  const output = await session.finalize();
  assert.deepEqual(output.writes, [{ kind: 'remove', model: ITEM, id: 'a', expectedVersion: 4 }]);
  assert.deepEqual(output.history.map(entry => ({ change: entry.change, version: entry.version,
    before: entry.before, after: entry.after })), [
    { change: 'update', version: 5, before: { value: 0 }, after: { value: 1 } },
    { change: 'remove', version: 5, before: { value: 1 }, after: null },
  ]);
  await commit(store, output); assert.equal(await store.load(ITEM, asId('a')), null);
  assert.deepEqual(await store.historyFor(ITEM, asId('a')), output.history);
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
  assert.deepEqual(disposed.history.map(entry => [entry.model, entry.change, entry.version]), [
    [ITEM, 'remove', 2], [LINK, 'remove', 2],
  ]);
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
  const retryContext = pipelineContext({ operation: 'Acme.Item.create' });
  const execute = async () => {
    const session = await beginOwnerMutation({ table, store, context: retryContext, bounds });
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

test('installed CRUD admission sees normalized candidates and pre-write views once, including existing delete rows', async () => {
  const { store } = createTestMemoryStorage();
  let removeHooks = 0, calls = 0;
  const table = buildModelTable([
    modelDef('Acme.Item', { fields: { title: { ...field({ default: '  omitted  ' }), valueType: 'text', trim: true } },
      deleteMode: 'remove', hooks: [
        hook('adjust', ['create'], (candidate, ctx) => {
          assert.equal(candidate.title, 'omitted');
          ctx.stage({ op: 'create', model: LINK, id: asId('secondary'), data: { title: 'secondary' } });
          return { ...candidate, title: 'hooked' };
        }),
        hook('remove', ['remove'], candidate => { removeHooks++; return candidate; }),
      ] }),
    modelDef('Acme.Link', { fields: { title: field() } }),
  ]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await session.stage({ op: 'create', model: ITEM, id: asId('earlier'), data: { title: 'earlier' } }, options);
  await session.stage({ op: 'create', model: ITEM, id: asId('item') }, {
    cause: 'crud', input: {}, admitCandidate: async (candidate, views) => {
      calls++;
      assert.ok(Object.isFrozen(candidate) && Object.isFrozen(candidate.data));
      assert.equal(candidate.data.title, 'hooked');
      assert.equal(await views.final.get(ITEM, asId('item')), null);
      assert.deepEqual((await views.final.query({ model: ITEM, authority: 'owner', limit: 10 })).map(row => row.id), ['earlier']);
      assert.deepEqual(await views.final.query({ model: LINK, authority: 'owner', limit: 10 }), []);
      return true;
    },
  });
  assert.equal(calls, 1, 'hook secondary does not inherit the CRUD callback');
  await session.stage(update('item', { title: '  next  ' }), {
    cause: 'crud', input: { title: '  next  ' }, admitCandidate: async (candidate, views) => {
      calls++;
      assert.equal(candidate.data.title, 'next');
      assert.equal((await views.final.get(ITEM, asId('item')))?.data.title, 'hooked');
      return true;
    },
  });
  await session.stage({ op: 'remove', model: ITEM, id: asId('item') }, {
    cause: 'crud', input: {}, admitCandidate: async (candidate, views) => {
      calls++;
      assert.equal(removeHooks, 0, 'delete admission precedes hooks');
      assert.equal(candidate.data.title, 'next');
      assert.equal(candidate.archivedAt, null);
      assert.equal((await views.final.get(ITEM, asId('item')))?.data.title, 'next');
      return true;
    },
  });
  assert.equal(calls, 3); assert.equal(removeHooks, 1);
  const effects = await session.finalize();
  assert.equal(effects.writes.some(write => write.model === ITEM &&
    (write.kind === 'insert' ? write.row.id : write.id) === 'item'), false);
  assert.equal(await store.load(ITEM, asId('earlier')), null, 'candidate admission stages nothing in storage');
});

test('installed CRUD admission rejects false/nonbool and preserves thrown identity before staging', async () => {
  const { store } = createTestMemoryStorage();
  const table = buildModelTable([modelDef('Acme.Item', { fields: { title: { ...field(), valueType: 'text', trim: true } } })]);
  await seedRow(store, ITEM, { id: 'item', data: { title: 'before' } });
  const sentinel = new StateError('conflict', 'original candidate failure');
  for (const kind of ['false', 'nonbool', 'throw'] as const) {
    const session = await beginOwnerMutation({ table, store, context: context(), bounds });
    let calls = 0;
    await assert.rejects(session.stage(update('item', { title: 'after' }), {
      cause: 'crud', input: {}, admitCandidate: () => {
        calls++; if (kind === 'throw') throw sentinel;
        return kind === 'false' ? false : 'true' as never;
      },
    }), error => kind === 'throw' ? error === sentinel : error instanceof StateError &&
      error.code === (kind === 'false' ? 'rule_failed' : 'validation'));
    assert.equal(calls, 1);
    await assert.rejects(session.finalize(), /poisoned/);
    assert.equal((await store.load(ITEM, asId('item')))?.data.title, 'before');
    assert.deepEqual(await store.historyFor(ITEM, asId('item')), []);
  }
  const invalid = await beginOwnerMutation({ table, store, context: context(), bounds });
  let calls = 0;
  await assert.rejects(invalid.stage(update('item', { title: 123 }), {
    cause: 'crud', input: {}, admitCandidate: () => { calls++; return true; },
  }), error => error instanceof StateError && error.code === 'validation');
  assert.equal(calls, 0, 'field validation precedes candidate admission');
});

test('candidate callbacks cannot swallow the first bounded owner read/work failure', async () => {
  const { store } = createTestMemoryStorage();
  const table = buildModelTable([modelDef('Acme.Item', { fields: { title: field() } })]);
  await seedRow(store, ITEM, { id: 'one', data: { title: 'one' } });
  await seedRow(store, ITEM, { id: 'two', data: { title: 'two' } });
  for (const kind of ['query', 'work'] as const) {
    const session = await beginOwnerMutation({ table, store, context: context(), bounds: { maxRows: 1, maxWork: 1000 } });
    let first: unknown;
    await assert.rejects(session.stage(update('one', { title: 'after' }), {
      cause: 'crud', input: {}, admitCandidate: async (_candidate, views) => {
        try {
          if (kind === 'query') await views.final.query({ model: ITEM, authority: 'owner', limit: 1 });
          else views.consumeWork(1001);
        } catch (error) { first = error; }
        if (kind === 'work') throw new Error('later callback failure must not replace budget failure');
        return true;
      },
    }), error => error === first && error instanceof StateError && error.code === 'validation');
    assert.ok(first instanceof StateError);
    await assert.rejects(session.finalize(), /poisoned/);
    assert.equal((await store.load(ITEM, asId('one')))?.data.title, 'one');
  }
});

test('candidate admission is an own installed CRUD-only option', async () => {
  const { store } = createTestMemoryStorage();
  const table = buildModelTable([modelDef('Acme.Item', { fields: { title: field() } })]);
  let reads = 0;
  for (const invalid of [
    { cause: 'scenario', admitCandidate: () => true },
    { cause: 'crud', input: {}, admitCandidate: undefined },
    Object.assign(Object.create({ admitCandidate: () => true }), { cause: 'crud', input: {} }),
    Object.defineProperty({ cause: 'crud', input: {} }, 'admitCandidate', { enumerable: true, get: () => { reads++; return () => true; } }),
  ]) {
    const session = await beginOwnerMutation({ table, store, context: context(), bounds });
    await assert.rejects(session.stage({ op: 'create', model: ITEM, id: asId('item'), data: {} }, invalid as never), /own installed CRUD callback/);
    await assert.rejects(session.finalize(), /poisoned/);
  }
  assert.equal(reads, 0);
});

test('fixture snapshots retain normalized historical domain state, final invariants and version one without CRUD effects', async () => {
  const { store } = createTestMemoryStorage();
  let hooks = 0, sources = 0, locks = 0, invariants = 0;
  const table = buildModelTable([
    modelDef('Acme.Item', { fields: {
      title: { ...field({ default: '  default  ' }), valueType: 'text', trim: true, max: 10 },
      author: { ...field({ serverOnly: true }), server: 'actor' },
    }, uniqueKeys: ['title'], hooks: [hook('create', ['create', 'update'], candidate => { hooks++; return candidate; })] }),
    { ...modelDef('Acme.Link', { fields: { title: field() } }), containment: { parent: ITEM } },
  ]);
  const descriptor: CanonicalOwnerModelPolicies = { abi: 'state.owner-model-policies@1', model: ITEM,
    module: 'owner.mjs', ownerPackage: 'Acme', hooks: [], rules: [
      { id: 'locked', kind: 'lock', fields: ['title'] },
      { id: 'valid', kind: 'invariant', dependencies: [] },
    ] };
  const policies = bindOwnerModelPolicies({ table, descriptors: [descriptor], bindings: [
    { id: 'locked', kind: 'lock', module: 'owner.mjs', ownerPackage: 'Acme', model: ITEM,
      evaluate: () => { locks++; return true; } },
    { id: 'valid', kind: 'invariant', module: 'owner.mjs', ownerPackage: 'Acme', model: ITEM,
      evaluate: (_ctx, row) => { invariants++; return row.data.title !== 'invalid'; } },
  ] });
  const fixtureContext = pipelineContext({ operation: 'Acme.fixture', kind: 'test' });
  const open = (now = fixtureContext.now) => beginOwnerMutation({ table, store, context: { ...fixtureContext, now }, bounds,
    policies, stageSources: async () => { sources++; return []; } });
  const baseline = await open();
  await baseline.stage([
    { op: 'create', model: LINK, id: asId('link'), parent: { model: ITEM, id: asId('item') }, data: { title: 'child' } },
    { op: 'create', model: ITEM, id: asId('item') },
    { op: 'create', model: ITEM, id: asId('other'), data: { title: 'other', author: { id: 'other-user' } } },
  ], { cause: 'fixture' });
  const initial = await baseline.finalize();
  assert.deepEqual(initial.history, []);
  assert.deepEqual(initial.schedules, []);
  await commit(store, initial);
  const before = (await store.load(ITEM, asId('item')))!;
  assert.equal(before.data.title, 'default');
  assert.deepEqual(before.data.author, { id: 'user-alice' });
  assert.deepEqual((await store.load(ITEM, asId('other')))?.data.author, { id: 'other-user' });
  const overrides = await open(fixtureContext.now + 1000);
  // Intermediate duplicate keys are not committed: both independent overrides form one final snapshot.
  await overrides.stage([
    update('item', { title: '  other  ', author: { id: 'historical-user' } }),
    update('other', { title: 'changed' }),
  ], { cause: 'fixture' });
  const final = await overrides.finalize();
  assert.deepEqual(final.history, []);
  assert.deepEqual(final.schedules, []);
  const after = final.writes.find(write => write.kind === 'update' && write.id === 'item');
  assert.ok(after?.kind === 'update');
  assert.deepEqual({ ...after.row, data: before.data }, before, 'snapshot override preserves all stored metadata');
  assert.equal(after.row.version, 1);
  assert.equal(after.row.data.title, 'other');
  assert.deepEqual(after.row.data.author, { id: 'historical-user' });
  await commit(store, final);
  assert.equal(hooks, 0); assert.equal(sources, 0); assert.equal(locks, 0);
  assert.equal(invariants, 4, 'both baseline and combined overrides validate final rows');
});

test('fixture snapshots reject invalid stored data, references, uniqueness and final invariants before invocation', async () => {
  const { store } = createTestMemoryStorage();
  const table = buildModelTable([
    modelDef('Acme.Item', { fields: { title: { ...field({ required: true }), valueType: 'text', trim: true, max: 10 } },
      uniqueKeys: ['title'], invariants: [invariant('valid', view => {
        if (view.get(ITEM, asId('item'))?.data.title === 'invalid') throw new StateError('rule_failed', 'Invalid snapshot');
      })] }),
    { ...modelDef('Acme.Link', { fields: { title: field() } }), containment: { parent: ITEM } },
  ]);
  const open = () => beginOwnerMutation({ table, store, context: pipelineContext({ operation: 'Acme.fixture', kind: 'test' }), bounds });
  for (const data of [{ title: 123 }, { title: 'too long for bounds' }, { title: null }, { title: 'ok', id: 'reserved' }]) {
    const session = await open();
    await assert.rejects(session.stage({ op: 'create', model: ITEM, id: asId('item'), data }, { cause: 'fixture' }),
      error => error instanceof StateError && error.code === 'validation');
    await assert.rejects(session.finalize(), /poisoned/);
  }
  const missingParent = await open();
  await missingParent.stage({ op: 'create', model: LINK, id: asId('link'), parent: { model: ITEM, id: asId('missing') } }, { cause: 'fixture' });
  await assert.rejects(missingParent.finalize(), /parent record is missing/);
  const invalidInvariant = await open();
  await invalidInvariant.stage({ op: 'create', model: ITEM, id: asId('item'), data: { title: 'invalid' } }, { cause: 'fixture' });
  await assert.rejects(invalidInvariant.finalize(), /Invalid snapshot/);
  const duplicate = await open();
  await duplicate.stage(['item', 'other'].map(id => ({ op: 'create' as const, model: ITEM, id: asId(id), data: { title: 'same' } })), { cause: 'fixture' });
  await assert.rejects(commit(store, await duplicate.finalize()), error => error instanceof Error && /unique/i.test(error.message));
  assert.equal(await store.load(ITEM, asId('item')), null);
  assert.equal(await store.load(LINK, asId('link')), null);
});

test('fixture snapshots require the isolated test cause and refuse production stages or reserved write controls', async () => {
  const { store } = createTestMemoryStorage();
  const table = buildModelTable([modelDef('Acme.Item', { fields: { title: field() } })]);
  const write = { op: 'create' as const, model: ITEM, id: asId('item'), data: { title: 'initial' } };
  const ordinary = await beginOwnerMutation({ table, store, context: context(), bounds });
  await assert.rejects(ordinary.stage(write, { cause: 'fixture' }), /isolated test owner/);
  for (const extra of [{ version: 2 }, { created: 0 }, { when: { op: 'true' } }, { transition: {} }, { op: 'remove' }]) {
    const session = await beginOwnerMutation({ table, store, context: pipelineContext({ operation: 'Acme.fixture', kind: 'test' }), bounds });
    await assert.rejects(session.stage({ ...write, ...extra } as never, { cause: 'fixture' }), /only declared create\/update/);
    await assert.rejects(session.finalize(), /poisoned/);
  }
  for (const cause of ['crud', 'scenario'] as const) {
    const session = await beginOwnerMutation({ table, store, context: pipelineContext({ operation: 'Acme.fixture', kind: 'test' }), bounds });
    await session.stage(write, { cause: 'fixture' });
    await assert.rejects(session.stage(update('item', { title: 'changed' }), { cause, input: {} }), /cannot mix/);
  }
  const callback = await beginOwnerMutation({ table, store, context: pipelineContext({ operation: 'Acme.fixture', kind: 'test' }), bounds });
  await assert.rejects(callback.stage(write, { cause: 'fixture', admitCandidate: () => true }), /only the fixture cause/);
});
