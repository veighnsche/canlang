/** Finite defining-component integration for installed runtime source wiring.
 * This does not establish Compiler correspondence, native host adoption, or
 * full workflow acceptance. Sources originate only in real owner finalization.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanonicalOwnerModelPolicies, ClosedInputs, DomainWrite, InvocationContext, OccurrenceId,
  Receipt, Revision, StoragePort, StoredRow } from '@canlang/contracts';
import { beginOwnerMutation, bindOwnerModelPolicies, buildModelTable, generatedCrudExecuteOwnerSession,
  beginScenarioReceiptMutation, ownerMutationBusinessWrites, readOwnerMutationSourceStage,
  readScenarioReceiptAssociation, selectScenarioReceiptReturn, bindScenarioReceiptCallProducer,
  invokeScenarioReceiptCall, StateError, type MutationWritesResult,
  type OwnerMutationSourceStage, type OwnerMutationSourceStager } from '@canlang/state';
import { invoke, readGeneratedCrudAssociation, projectGeneratedCrudReceipt } from '@canlang/state/invocation';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '@canlang/state/invocation/registry';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { buildPolicyTable } from '@canlang/state/policy/grants';
import { admitRetainedFanoutChunk } from '@canlang/state/fanout/membership';
import { FIXED_NOW, asId, asModel, asOperation, createMemoryIdentityStore, makeBatch,
  makeEnvelope, makeIdentity, seedMember, seedRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { field, modelDef, pipelineContext, seedStoredRow } from '@canlang/state/testing/mutation/fixtures';
import { createCommittedModelSourceStager, type CommittedModelSourceBounds,
  type CommittedModelSourceRoutes } from '../src/kernel/committed-model-source.js';
import { WORK_HANDLER_OCCURRENCE_MODEL, handlerOccurrenceRowId, readHandlerOccurrenceRow,
  stageHandlerOccurrence } from '../src/kernel/handler-occurrence.js';
import { WORK_OCCURRENCE_MODEL, WORK_FANOUT_INTENT_MODEL, WORK_FANOUT_CHECKPOINT_MODEL,
  WORK_FANOUT_CHILD_MODEL, fanoutIntentRowId, fanoutCheckpointRowId, fanoutChildRowId,
  newOccurrenceRow, newFanoutIntentRow, newFanoutCheckpointRow, newFanoutChildRow,
  readOccurrenceRow, readFanoutIntentRow, readFanoutCheckpointRow, readFanoutChildRow } from '../src/kernel/tables.js';

const ITEM = asModel('Shop.Item'), ARCHIVE = asModel('Shop.Archive'), PARENT = asModel('Shop.Parent');
const EMPTY = asModel('Shop.Empty'), APP = 'acme-app', OP = 'Shop.advance';
const ownerBounds = { maxRows: 100, maxWork: 10_000 };
const sourceBounds: CommittedModelSourceBounds = { maxSources: 20, maxHandlers: 40, maxMembers: 30, chunkSize: 2 };
const cause = { cause: 'scenario' } as const;
const context = () => pipelineContext({ operation: OP });
const scope = (ctx: InvocationContext) => ({ app: ctx.app, owner: ctx.team?.teamId ?? ctx.app, ownerPackage: 'Shop' });
const ordinary = (_change: unknown, ctx: InvocationContext): CommittedModelSourceRoutes =>
  ({ scope: scope(ctx), handlers: [{ handler: 'Shop.changed' }] });
const table = () => buildModelTable([
  modelDef(ITEM, { fields: { value: field() }, deleteMode: 'remove' }),
  modelDef(ARCHIVE, { fields: { value: field() } }),
  modelDef(PARENT, { fields: { value: field() }, deleteMode: 'remove' }),
  modelDef(EMPTY, { fields: { value: field() } }),
]);
function installed(routes = ordinary, bounds = sourceBounds, supplied?: () => string) {
  const counts = { selectors: 0, ids: 0 };
  const stageSources = createCommittedModelSourceStager({ routesForChange: (change, ctx) => {
    counts.selectors++; return routes(change, ctx);
  }, occurrenceIds: { nextOccurrenceId: () => {
    counts.ids++; return (supplied?.() ?? `source/${counts.ids}`) as OccurrenceId;
  } }, bounds });
  return { counts, stageSources };
}
const update = (id: string, value: string) => ({ op: 'update' as const, model: ITEM, id: asId(id), data: { value } });
async function commit(store: StoragePort, output: MutationWritesResult, revision?: Revision) {
  await store.commit(makeBatch(revision ?? await store.readRevision(), { writes: output.writes, history: output.history,
    uniqueClaims: output.uniqueClaims, uniqueReleases: output.uniqueReleases, schedules: output.schedules }));
}
async function rows(store: StoragePort, model: string) {
  return store.query({ model: asModel(model), authority: 'owner', archived: 'include', order: [{ field: 'id', direction: 'asc' }] });
}
const frameworkModels = [WORK_OCCURRENCE_MODEL, WORK_HANDLER_OCCURRENCE_MODEL, WORK_FANOUT_INTENT_MODEL,
  WORK_FANOUT_CHECKPOINT_MODEL, WORK_FANOUT_CHILD_MODEL];
async function snapshot(store: StoragePort) {
  const records: unknown[] = [];
  for (const model of [ITEM, ARCHIVE, PARENT, EMPTY, ...frameworkModels]) records.push([model, await rows(store, model)]);
  return { records, history: await store.historyFor(ITEM, asId('a')), revision: await store.readRevision(),
    outbox: await store.outboxPending() };
}
function sourceReceipts(output: MutationWritesResult) {
  return output.writes.filter(write => write.model === WORK_OCCURRENCE_MODEL).map(write => {
    assert.equal(write.kind, 'insert'); if (write.kind !== 'insert') throw Error('Expected source receipt insert');
    return readOccurrenceRow(write.row).result as {
      kind: string; event: string; change: { model: string; recordId: string; version: number; kind: string };
      context: Record<string, unknown>; revision: number; handlers: Record<string, unknown>[];
    };
  });
}
const execution = (output: MutationWritesResult) => ({ ...output, outbox: [], result: null });

test('final same-value and A/B/A updates emit once at the reserved version and retain ordered business history', async () => {
  const store = createMemoryStorage();
  await seedRow(store, ITEM, { id: 'a', version: 4, data: { value: 'A' } });
  const wiring = installed(), root = context(), revision = await store.readRevision();
  const session = await beginOwnerMutation({ table: table(), store, context: root, bounds: ownerBounds, stageSources: wiring.stageSources });
  for (const [index, value] of ['A', 'B', 'A'].entries()) await session.stage(update('a', value), {
    ...cause, context: Object.freeze({ ...session.views.context, operation: asOperation(`Shop.child${index}`), source: `nested-${index}` }),
  });
  const output = await session.finalize(), business = ownerMutationBusinessWrites(output);
  assert.equal(business.length, 1); assert.equal(output.writes.length, 3);
  assert.deepEqual(output.history.map(entry => [entry.before, entry.after, entry.version, entry.operation]), [
    [{ value: 'A' }, { value: 'A' }, 5, 'Shop.child0'],
    [{ value: 'A' }, { value: 'B' }, 5, 'Shop.child1'],
    [{ value: 'B' }, { value: 'A' }, 5, 'Shop.child2'],
  ]);
  const receipt = sourceReceipts(output)[0]!;
  assert.deepEqual(receipt.change, { model: ITEM, recordId: 'a', version: 5, kind: 'updated' });
  assert.equal(receipt.context.operation, root.operation); assert.equal(receipt.context.source, root.source);
  assert.equal(receipt.context.operationId, root.operationId); assert.equal(receipt.revision, revision);
  assert.deepEqual(wiring.counts, { selectors: 1, ids: 1 });
  assert.deepEqual(await store.historyFor(ITEM, asId('a')), []);
  await commit(store, output, revision);
  assert.equal((await store.load(ITEM, asId('a')))!.version, 5);
  assert.deepEqual(await store.historyFor(ITEM, asId('a')), output.history);
  assert.equal((await rows(store, WORK_OCCURRENCE_MODEL)).length, 1);
});

test('surviving creation, self-cancellation, permanent removal and archive use their final net change kinds', async () => {
  const store = createMemoryStorage();
  await seedRow(store, ITEM, { id: 'a', version: 7, data: { value: 'entry' } });
  await seedRow(store, ARCHIVE, { id: 'archived', version: 3, data: { value: 'entry' } });
  const wiring = installed(), session = await beginOwnerMutation({ table: table(), store, context: context(),
    bounds: ownerBounds, stageSources: wiring.stageSources });
  await session.stage({ op: 'create', model: ITEM, id: asId('new'), data: { value: 'first' } }, cause);
  await session.stage(update('new', 'final'), cause);
  await session.stage({ op: 'create', model: ITEM, id: asId('cancelled'), data: { value: 'first' } }, cause);
  await session.stage({ op: 'remove', model: ITEM, id: asId('cancelled') }, cause);
  await session.stage(update('a', 'changed'), cause);
  await session.stage({ op: 'remove', model: ITEM, id: asId('a') }, cause);
  await session.stage({ op: 'remove', model: ARCHIVE, id: asId('archived') }, cause);
  const output = await session.finalize();
  assert.deepEqual(sourceReceipts(output).map(receipt => receipt.change), [
    { model: ARCHIVE, recordId: 'archived', version: 4, kind: 'deleted' },
    { model: ITEM, recordId: 'a', version: 8, kind: 'deleted' },
    { model: ITEM, recordId: 'new', version: 1, kind: 'created' },
  ]);
  assert.deepEqual(output.history.map(entry => [entry.recordId, entry.change, entry.version]), [
    ['new', 'create', 1], ['a', 'update', 8], ['a', 'remove', 8], ['archived', 'archive', 4],
  ]);
  assert.equal(ownerMutationBusinessWrites(output).length, 3);
  await commit(store, output);
  assert.equal(await store.load(ITEM, asId('cancelled')), null);
  assert.deepEqual(await store.historyFor(ITEM, asId('cancelled')), []);
  assert.equal(await store.load(ITEM, asId('a')), null);
  assert.equal((await store.load(ARCHIVE, asId('archived')))!.archivedAt, FIXED_NOW);
});

test('checked CRUD hook secondaries produce their own final source with the original root attribution', async () => {
  const store = createMemoryStorage(); await seedRow(store, ITEM, { id: 'a', data: { value: 'entry' } });
  const models = table(), root = pipelineContext({ operation: 'Shop.Item.update' });
  const descriptor: CanonicalOwnerModelPolicies = { abi: 'state.owner-model-policies@1', model: ITEM,
    module: 'owner.mjs', ownerPackage: 'Shop', rules: [], hooks: [
      { id: 'item.updated', op: 'update', operation: asOperation('Shop.Item.update') },
    ] };
  let hooks = 0;
  const policies = bindOwnerModelPolicies({ table: models, descriptors: [descriptor], bindings: [{
    id: 'item.updated', kind: 'hook', module: 'owner.mjs', ownerPackage: 'Shop', model: ITEM,
    run: (candidate, carrier) => { hooks++;
      carrier.stage({ op: 'create', model: ARCHIVE, id: asId('hook-side'), data: { value: 'secondary' } });
      return { ...candidate, value: 'hook-final' };
    },
  }] });
  const wiring = installed(), session = await beginOwnerMutation({ table: models, store, context: root,
    bounds: ownerBounds, policies, stageSources: wiring.stageSources });
  await session.stage(update('a', 'input'), { cause: 'crud', input: { value: 'input' } });
  const output = await session.finalize(); assert.equal(hooks, 1);
  assert.deepEqual(new Set(sourceReceipts(output).map(receipt => receipt.change.model)), new Set([ITEM, ARCHIVE]));
  for (const receipt of sourceReceipts(output)) assert.equal(receipt.context.operation, root.operation);
  await commit(store, output); assert.equal((await store.load(ITEM, asId('a')))!.data.value, 'hook-final');
  assert.equal((await store.load(ARCHIVE, asId('hook-side')))!.data.value, 'secondary');
});

const origin = { path: 'advance.can', sha256: 'a'.repeat(64), module: 'advance.mjs' };
function scenarioArtifact(): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: origin.path, sha256: origin.sha256 }],
    modules: [{ path: origin.module, js: 'export const identity="Shop.advance";',
      map: { version: 3, file: origin.module, sources: [origin.path], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: origin.module, export: 'identity', member: ['advance'] }],
    models: [ITEM, ARCHIVE, PARENT, EMPTY].map(name => ({ name, deleteMode: name === ITEM ? 'remove' : 'archive',
      fields: [{ name: 'value', field: { kind: 'string' }, required: false, serverOnly: false }] })),
    operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [] },
      result: { type: 'void', disclosure: { version: 1, source: origin,
        returns: [{ id: 'advance-return', source: origin, influences: [], dependencies: [] }] } } }],
  };
}
let sequence = 80_000;
async function invokeWorld(slice = scenarioArtifact()) {
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
  return { store, memberships, member, loaded, app: APP, source: 'test', clock: { nowMs: () => FIXED_NOW },
    identity: makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership }),
    registry: loaded.registry, envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence)) };
}

test('ordinary and complete final-state cohorts join the genuine scenario commit; continuation retains membership and replay does no work', async () => {
  const w = await invokeWorld(), store = w.store;
  await seedStoredRow(store, PARENT, { id: 'parent', data: { value: 'parent' } });
  for (const id of ['a', 'b', 'removed']) await seedStoredRow(store, ITEM,
    { id, data: { value: id }, parent: { model: PARENT, id: 'parent' } });
  await seedStoredRow(store, ITEM, { id: 'outside', data: { value: 'outside' } });
  await seedStoredRow(store, ARCHIVE, { id: 'archived', data: { value: 'archive' },
    parent: { model: PARENT, id: 'parent' } });
  const wiring = installed((change, ctx) => ({ scope: scope(ctx), handlers: change &&
    (change as { recordId: string }).recordId === 'a' ? [
      { handler: 'Shop.ordinary' },
      { handler: 'Shop.all', cohort: { kind: 'model', owner: scope(ctx).owner, model: ITEM } },
      { handler: 'Shop.children', cohort: { kind: 'anchored-collection', owner: scope(ctx).owner,
        model: ITEM, parent: { model: PARENT, id: 'parent' } } },
      { handler: 'Shop.empty', cohort: { kind: 'model', owner: scope(ctx).owner, model: EMPTY } },
      { handler: 'Shop.archives', cohort: { kind: 'model', owner: scope(ctx).owner, model: ARCHIVE } },
    ] : [] }));
  let executes = 0, commits = 0, saved: Receipt | undefined;
  const actualCommit = store.commit; store.commit = async batch => {
    commits++; assert.ok(batch.receipt); assert.equal(batch.writes.filter(write => frameworkModels.includes(write.model)).length, 14);
    assert.equal(batch.history.length, 4); return actualCommit(batch);
  };
  const args = { ...w, observeCommittedReceipt: (receipt: Receipt) => { saved = receipt; }, execute: async (call: Parameters<Parameters<typeof invoke>[0]['execute']>[0]) => {
    executes++;
    const session = await beginScenarioReceiptMutation(call, store, { table: table(), bounds: ownerBounds, stageSources: wiring.stageSources });
    await session.stage(update('a', 'changed'), cause);
    await session.stage({ op: 'create', model: ITEM, id: asId('created'), data: { value: 'created' },
      parent: { model: PARENT, id: asId('parent') } }, cause);
    await session.stage({ op: 'remove', model: ITEM, id: asId('removed') }, cause);
    await session.stage({ op: 'remove', model: ARCHIVE, id: asId('archived') }, cause);
    selectScenarioReceiptReturn(call, store, 'advance-return');
    const output = await session.finalize();
    assert.equal(output.writes.filter(write => !frameworkModels.includes(write.model)).length, 4);
    const receipt = sourceReceipts(output)[0]!; assert.equal(receipt.handlers.length, 5);
    assert.deepEqual(receipt.handlers.map(handler => [handler.handler, handler.memberCount, handler.firstChunkCount]), [
      ['Shop.ordinary', undefined, undefined], ['Shop.all', 4, 2], ['Shop.children', 3, 2],
      ['Shop.empty', 0, 0], ['Shop.archives', 0, 0],
    ]);
    return execution(output);
  } };
  const result = await invoke(args); assert.equal(result.status, 'committed'); assert.equal(commits, 1); assert.ok(saved);
  const association = readScenarioReceiptAssociation(saved); assert.ok(association);
  assert.deepEqual(new Set(association.changed.map(change => change.model)), new Set([ITEM, ARCHIVE]));
  assert.equal(association.changed.length, 3);
  assert.ok(saved.outcome.status === 'committed');
  assert.equal(saved.outcome.recordVersions.some(ref => frameworkModels.includes(ref.model)), false);
  const source = readOccurrenceRow((await store.load(WORK_OCCURRENCE_MODEL, asId('source/1')))!)!;
  assert.equal((source.result as { kind: string }).kind, 'committed-model-source');
  const ordinaryRow = (await store.load(WORK_HANDLER_OCCURRENCE_MODEL, asId(handlerOccurrenceRowId('source/1', 'Shop.ordinary'))))!;
  assert.deepEqual(readHandlerOccurrenceRow(ordinaryRow).payload, { recordId: 'a', owner: w.member.team.team_id, version: 2, occurrenceId: 'source/1' });
  const allId = fanoutIntentRowId('source/1', 'Shop.all', 'model'), anchoredId = fanoutIntentRowId('source/1', 'Shop.children', 'anchored-collection');
  const all = (await store.load(WORK_FANOUT_INTENT_MODEL, asId(allId)))!;
  assert.deepEqual(readFanoutIntentRow(all).members, ['a', 'b', 'created', 'outside']);
  assert.deepEqual(readFanoutIntentRow((await store.load(WORK_FANOUT_INTENT_MODEL, asId(anchoredId)))!).members, ['a', 'b', 'created']);
  assert.equal((await rows(store, WORK_FANOUT_CHILD_MODEL)).length, 4);
  for (const child of await rows(store, WORK_FANOUT_CHILD_MODEL)) {
    const data = readFanoutChildRow(child); assert.equal(child.id, fanoutChildRowId('source/1', data.handler, data.recordId));
  }
  const replayBefore = await snapshot(store), counts = { ...wiring.counts };
  assert.equal((await invoke(args)).status, 'replayed');
  assert.equal(executes, 1); assert.equal(commits, 1); assert.deepEqual(wiring.counts, counts);
  assert.deepEqual(await snapshot(store), replayBefore);
  store.commit = actualCommit;
  await seedStoredRow(store, ITEM, { id: 'late', data: { value: 'late' }, parent: { model: PARENT, id: 'parent' } });
  const checkpoint = (await store.load(WORK_FANOUT_CHECKPOINT_MODEL, asId(fanoutCheckpointRowId(allId))))!;
  assert.equal(readFanoutCheckpointRow(checkpoint).cursor, 'admit/v2/2');
  assert.deepEqual(await admitRetainedFanoutChunk({ store, intentRow: all, checkpointRow: checkpoint,
    chunkSize: 2, expectedRevision: await store.readRevision(), meta: { nowMs: FIXED_NOW, actor: w.identity.actor!.user_id } }),
  { ok: true, cursor: null, admitted: 2 });
  assert.deepEqual(readFanoutIntentRow((await store.load(WORK_FANOUT_INTENT_MODEL, asId(allId)))!).members, ['a', 'b', 'created', 'outside']);
  assert.equal(await store.load(WORK_FANOUT_CHILD_MODEL, asId(fanoutChildRowId('source/1', 'Shop.all', 'late'))), null);
  assert.ok(await store.load(WORK_FANOUT_CHILD_MODEL, asId(fanoutChildRowId('source/1', 'Shop.all', 'created'))));
});

test('bounded selector/source/handler/member/domain and identity failures refuse the entire real finalization', async () => {
  const modes = ['sources', 'handlers', 'members', 'domain', 'id-empty', 'id-long', 'id-repeat',
    'scope', 'duplicate', 'unknown-model', 'cross-owner', 'unknown-anchor', 'extra', 'accessor', 'sparse', 'cycle'] as const;
  for (const mode of modes) {
    const store = createMemoryStorage();
    for (const id of ['a', 'b', 'c']) await seedRow(store, ITEM, { id, data: { value: 'entry' } });
    let accessorReads = 0;
    const limits = { ...sourceBounds, ...(mode === 'sources' ? { maxSources: 1 } : {}),
      ...(mode === 'handlers' ? { maxHandlers: 1 } : {}), ...(mode === 'members' ? { maxMembers: 1 } : {}) };
    const wiring = installed((_change, ctx) => {
      const base = ordinary(_change, ctx);
      if (mode === 'scope') return { ...base, scope: { ...base.scope, app: 'foreign' } };
      if (mode === 'duplicate') return { ...base, handlers: [base.handlers[0]!, base.handlers[0]!] };
      if (['members', 'domain', 'unknown-model', 'cross-owner'].includes(mode)) return { ...base, handlers: [
        { handler: 'Shop.all', cohort: { kind: 'model', owner: mode === 'cross-owner' ? 'foreign' : base.scope.owner,
          model: mode === 'unknown-model' ? 'Shop.Unknown' : ITEM } },
      ] };
      if (mode === 'unknown-anchor') return { ...base, handlers: [{ handler: 'Shop.all', cohort: {
        kind: 'anchored-collection', owner: base.scope.owner, model: ITEM, parent: { model: PARENT, id: 'unknown' },
      } }] };
      if (mode === 'extra') return { ...base, unexpected: true } as CommittedModelSourceRoutes;
      if (mode === 'accessor') return Object.defineProperty({ ...base }, 'handlers', {
        enumerable: true, get: () => { accessorReads++; return base.handlers; },
      });
      if (mode === 'sparse') return { ...base, handlers: new Array(1) };
      if (mode === 'cycle') { const cyclic: Record<string, unknown> = { ...base }; cyclic['handlers'] = [cyclic]; return cyclic as unknown as CommittedModelSourceRoutes; }
      return base;
    }, limits, mode === 'id-empty' ? () => '' : mode === 'id-long' ? () => 'x'.repeat(201)
      : mode === 'id-repeat' ? () => 'repeat' : undefined);
    const before = await snapshot(store);
    const session = await beginOwnerMutation({ table: table(), store, context: context(),
      bounds: { ...ownerBounds, ...(mode === 'domain' ? { maxRows: 2 } : {}) }, stageSources: wiring.stageSources });
    await session.stage(update('a', 'changed'), cause);
    if (['sources', 'handlers', 'id-repeat'].includes(mode)) await session.stage(update('b', 'changed'), cause);
    await assert.rejects(session.finalize());
    await assert.rejects(session.finalize(), /poisoned/);
    assert.deepEqual(await snapshot(store), before, mode); assert.equal(accessorReads, 0);
  }
});

test('preexisting source/ordinary/fanout rows and orphan ordinary receipts cannot join a business commit', async () => {
  for (const mode of ['source', 'ordinary', 'orphan', 'intent', 'checkpoint', 'child'] as const) {
    const store = createMemoryStorage(), root = context(), meta = { nowMs: root.now, actor: root.actor!.userId };
    await seedRow(store, ITEM, { id: 'a', data: { value: 'entry' } });
    const fanoutId = fanoutIntentRowId('source/1', 'Shop.all', 'model');
    let write: DomainWrite;
    if (mode === 'source' || mode === 'orphan') write = { kind: 'insert', model: WORK_OCCURRENCE_MODEL,
      row: newOccurrenceRow({ occurrenceId: mode === 'source' ? 'source/1' : handlerOccurrenceRowId('source/1', 'Shop.changed'),
        status: 'completed', result: null, code: null, message: null, recordedAtMs: root.now }, meta) };
    else if (mode === 'ordinary') {
      const staged = await stageHandlerOccurrence({ source: { occurrenceId: 'source/1', event: `${ITEM}.updated`,
        scope: scope(root), payload: { recordId: 'a', owner: scope(root).owner, version: 2, occurrenceId: 'source/1' } },
        handler: 'Shop.changed' }, { actor: meta.actor, now: root.now, operation: root.operation,
          load: (model, id) => store.load(model, id), query: spec => store.query(spec) });
      assert.equal(staged.status, 'ready'); if (staged.status !== 'ready') throw Error('Expected actual fresh route');
      write = staged.effects.writes![0]!;
    } else if (mode === 'intent') write = { kind: 'insert', model: WORK_FANOUT_INTENT_MODEL,
      row: newFanoutIntentRow({ sourceOccurrence: 'source/1', handler: 'Shop.all', cohort: 'model', members: ['a'] }, meta) };
    else if (mode === 'checkpoint') write = { kind: 'insert', model: WORK_FANOUT_CHECKPOINT_MODEL,
      row: newFanoutCheckpointRow({ fanoutId, cursor: null }, meta) };
    else write = { kind: 'insert', model: WORK_FANOUT_CHILD_MODEL,
      row: newFanoutChildRow({ fanoutId, parentOccurrence: 'source/1', handler: 'Shop.all', recordId: 'a' }, meta) };
    await store.commit(makeBatch(await store.readRevision(), { writes: [write] }));
    const before = await snapshot(store);
    const wiring = installed(mode === 'intent' || mode === 'checkpoint' || mode === 'child'
      ? (_change, ctx) => ({ scope: scope(ctx), handlers: [{ handler: 'Shop.all',
        cohort: { kind: 'model', owner: scope(ctx).owner, model: ITEM } }] }) : ordinary);
    const session = await beginOwnerMutation({ table: table(), store, context: root, bounds: ownerBounds, stageSources: wiring.stageSources });
    await session.stage(update('a', 'changed'), cause); await assert.rejects(session.finalize());
    assert.deepEqual(await snapshot(store), before, mode);
  }
});

test('genuine source views are sequential, immutable and closed after finalization; copied tokens poison only their owner', async () => {
  assert.throws(() => readOwnerMutationSourceStage({} as OwnerMutationSourceStage), /genuine active/);
  const store = createMemoryStorage(); await seedRow(store, ITEM, { id: 'a', data: { value: 'entry' } });
  let retained: OwnerMutationSourceStage | undefined;
  let retainedView: ReturnType<typeof readOwnerMutationSourceStage> | undefined;
  const wiring = installed();
  const session = await beginOwnerMutation({ table: table(), store, context: context(), bounds: ownerBounds,
    stageSources: async token => {
      retained = token; const stage = retainedView = readOwnerMutationSourceStage(token);
      assert.ok(Object.isFrozen(stage.context)); assert.ok(Object.isFrozen(stage.changes));
      const entry = await stage.entry.get(ITEM, asId('a')), final = await stage.final.get(ITEM, asId('a'));
      assert.equal(entry!.data.value, 'entry'); assert.equal(final!.data.value, 'changed');
      assert.ok(Object.isFrozen(final)); assert.ok(Object.isFrozen(final!.data));
      assert.deepEqual((await stage.final.query({ model: ITEM, authority: 'owner', limit: 100 })).map(row => row.id), ['a']);
      assert.equal(await stage.framework.load(WORK_OCCURRENCE_MODEL, asId('source/1')), null);
      return wiring.stageSources(token);
    } });
  await session.stage(update('a', 'changed'), cause); const output = await session.finalize();
  assert.throws(() => readOwnerMutationSourceStage(retained!), /closed/);
  await assert.rejects(retainedView!.final.get(ITEM, asId('a')), /closed/);
  await commit(store, output);
  for (const mode of ['copy', 'caught-query', 'caught-unknown', 'caught-work', 'unawaited', 'concurrent'] as const) {
    const s = createMemoryStorage(); await seedRow(s, ITEM, { id: 'a', data: { value: 'entry' } });
    const before = await snapshot(s); let reader: Promise<unknown> | undefined;
    const stageSources: OwnerMutationSourceStager = async token => {
      const stage = readOwnerMutationSourceStage(token);
      if (mode === 'copy') { assert.throws(() => readOwnerMutationSourceStage({ ...token }), /genuine active/); return []; }
      if (mode === 'caught-query') { await assert.rejects(stage.framework.query({ model: WORK_OCCURRENCE_MODEL, authority: 'owner' })); return []; }
      if (mode === 'caught-unknown') { await assert.rejects(stage.framework.load(ITEM, asId('a'))); return []; }
      if (mode === 'caught-work') { assert.throws(() => stage.consumeWork(100_000)); return []; }
      reader = stage.final.get(ITEM, asId('a')); void reader.catch(() => {});
      if (mode === 'concurrent') { await assert.rejects(stage.entry.get(ITEM, asId('a')), /concurrent/); await assert.rejects(reader); }
      return [];
    };
    const owner = await beginOwnerMutation({ table: table(), store: s, context: context(), bounds: ownerBounds, stageSources });
    await owner.stage(update('a', 'changed'), cause); await assert.rejects(owner.finalize());
    if (reader !== undefined) await assert.rejects(reader);
    await assert.rejects(owner.finalize(), /poisoned/); assert.deepEqual(await snapshot(s), before, mode);
  }
});

test('actual original revision conflicts discard all staged business, history and source effects', async () => {
  for (const phase of ['reader', 'commit'] as const) {
    const store = createMemoryStorage(); await seedRow(store, ITEM, { id: 'a', data: { value: 'entry' } });
    const original = await store.load(ITEM, asId('a')), revision = await store.readRevision();
    const wiring = installed();
    const owner = await beginOwnerMutation({ table: table(), store, context: context(), bounds: ownerBounds,
      stageSources: phase === 'commit' ? wiring.stageSources : async token => {
        const view = readOwnerMutationSourceStage(token);
        await seedRow(store, EMPTY, { id: 'external', data: { value: 'other writer' } });
        await view.final.get(ITEM, asId('a')); return wiring.stageSources(token);
      } });
    await owner.stage(update('a', 'changed'), cause);
    if (phase === 'reader') await assert.rejects(owner.finalize(), error => error instanceof StateError && error.code === 'conflict');
    else {
      const output = await owner.finalize();
      await seedRow(store, EMPTY, { id: 'external', data: { value: 'other writer' } });
      await assert.rejects(commit(store, output, revision));
    }
    assert.deepEqual(await store.load(ITEM, asId('a')), original);
    assert.deepEqual(await store.historyFor(ITEM, asId('a')), []);
    for (const model of frameworkModels) assert.deepEqual(await rows(store, model), []);
    assert.equal(await store.readRevision(), revision + 1);
  }
});

test('genuine generated CRUD target association uses business identity while the source rows share the Invoke commit', async () => {
  const slice: ArtifactDescriptorSlice = { artifact_version: 1,
    models: [{ name: ITEM, deleteMode: 'remove', fields: [
      { name: 'value', field: { kind: 'string' }, required: true, serverOnly: false },
    ] }], operations: [{ name: `${ITEM}.create`, kind: 'create', description: '',
      inputs: { fields: [{ name: 'value', field: { kind: 'string' }, required: true }] } }],
  };
  const w = await invokeWorld(slice), wiring = installed(); let opens = 0, closes = 0, commits = 0;
  const saved: Receipt[] = [], actualCommit = w.store.commit;
  w.store.commit = async batch => { commits++; assert.ok(batch.receipt); assert.equal(batch.writes.length, 3);
    assert.equal(batch.history.length, 1); return actualCommit(batch); };
  const execute = generatedCrudExecuteOwnerSession({ table: buildModelTable([modelDef(ITEM, { fields: { value: field({ required: true }) }, deleteMode: 'remove' })]),
    store: w.store, ownerBounds, stageSources: wiring.stageSources,
    createOwnerFrame: async () => { opens++; return { close: () => { closes++; } }; } });
  const id = uuidv7(FIXED_NOW, ++sequence), args = { ...w, execute,
    envelope: makeEnvelope(`${ITEM}.create`, id, { value: 'created' }),
    observeCommittedReceipt: (receipt: Receipt) => { saved.push(receipt); } };
  const result = await invoke(args); assert.equal(result.status, 'committed');
  assert.equal((result.result as StoredRow).id, id);
  assert.deepEqual(readGeneratedCrudAssociation(saved[0]!.outcome), { kind: 'generated-crud/v1', model: ITEM, record: { id, version: 1 } });
  assert.equal((await rows(w.store, WORK_OCCURRENCE_MODEL)).length, 1);
  const before = await snapshot(w.store), counts = { ...wiring.counts };
  assert.equal((await invoke(args)).status, 'replayed'); assert.equal(opens, 1); assert.equal(closes, 1); assert.equal(commits, 1);
  assert.deepEqual(wiring.counts, counts); assert.deepEqual(await snapshot(w.store), before);
});

test('genuine generated CRUD removal projects and replays a null target with retained Work versions and no deleted-target loads', async () => {
  const DELETE = `${ITEM}.delete`, CREATE = `${ITEM}.create`;
  const slice: ArtifactDescriptorSlice = { artifact_version: 1,
    models: [{ name: ITEM, deleteMode: 'remove', fields: [
      { name: 'value', field: { kind: 'string' }, required: true, serverOnly: false },
    ] }], operations: [
      { name: DELETE, kind: 'delete', description: '', inputs: { fields: [
        { name: 'record', field: { kind: 'ref', model: ITEM, requireVersion: true }, required: true },
      ] } },
      { name: CREATE, kind: 'create', description: '', inputs: { fields: [
        { name: 'value', field: { kind: 'string' }, required: true },
      ] } },
    ],
  };
  const w = await invokeWorld(slice); await seedRow(w.store, ITEM, { id: 'a', version: 4, data: { value: 'deleted private value' } });
  const deleted = await w.store.load(ITEM, asId('a')); assert.ok(deleted);
  const wiring = installed(); let frames = 0, closes = 0, bodies = 0, commits = 0, receipt: Receipt | undefined;
  const actualCommit = w.store.commit;
  w.store.commit = async batch => {
    commits++; assert.ok(batch.receipt); assert.equal(batch.writes.length, 3);
    assert.equal(batch.writes[0]!.kind, 'remove'); assert.equal(batch.history.length, 1);
    return actualCommit(batch);
  };
  const ownerExecute = generatedCrudExecuteOwnerSession({ table: buildModelTable([
    modelDef(ITEM, { fields: { value: field({ required: true }) }, deleteMode: 'remove' }),
  ]), store: w.store, ownerBounds, stageSources: wiring.stageSources, secretFields: new Map([[ITEM, []]]),
    createOwnerFrame: async () => { frames++; return { close: () => { closes++; } }; } });
  const args = { ...w, envelope: makeEnvelope(DELETE, uuidv7(FIXED_NOW, ++sequence), { record: { id: 'a', version: '4' } }),
    execute: async (call: Parameters<typeof ownerExecute>[0]) => { bodies++; return ownerExecute(call); },
    observeCommittedReceipt: (value: Receipt) => { receipt = value; } };
  const removed = await invoke(args); assert.equal(removed.status, 'committed'); assert.equal(removed.result, null);
  assert.ok(receipt); assert.ok(receipt.outcome.status === 'committed');
  const retained = receipt;
  assert.ok(retained.outcome.status === 'committed');
  assert.deepEqual(readGeneratedCrudAssociation(retained.outcome), { kind: 'generated-crud/v1', model: ITEM,
    record: null, secretFields: [] });
  assert.equal(retained.outcome.recordVersions.length, 2);
  assert.deepEqual(new Set(retained.outcome.recordVersions.map(ref => ref.model)), new Set([WORK_HANDLER_OCCURRENCE_MODEL, WORK_OCCURRENCE_MODEL]));
  assert.equal(await w.store.load(ITEM, asId('a')), null);
  const source = readOccurrenceRow((await w.store.load(WORK_OCCURRENCE_MODEL, asId('source/1')))!).result as {
    change: { model: string; recordId: string; version: number; kind: string };
  };
  assert.deepEqual(source.change, { model: ITEM, recordId: 'a', version: 5, kind: 'deleted' });
  const before = await snapshot(w.store), counts = { ...wiring.counts };
  let storedRowLoads = 0, membershipReads = 0;
  w.store.load = async () => {
    storedRowLoads++;
    throw Error('Removal recovery must not load or disclose any target or framework row');
  };
  const memberships = { ...w.memberships, findMembership: async (teamId: string, userId: string) => {
    membershipReads++; return w.memberships.findMembership(teamId, userId);
  } };
  const projection = { ...w, memberships, receipt: retained,
    policy: buildPolicyTable([{ model: ITEM, secretFields: [], grants: [{ by: 'members', fields: ['value'] }] }]) };
  assert.deepEqual(await projectGeneratedCrudReceipt(projection), { result: null, records: [] });
  assert.ok(membershipReads > 0);
  const recovered = await invoke({ ...args, admissionMode: 'retained-receipt-only',
    clock: { nowMs: () => FIXED_NOW + 16 * 60 * 1000 } });
  assert.equal(recovered.status, 'replayed'); assert.equal(recovered.result, null);
  assert.deepEqual(receipt, retained);
  assert.deepEqual(await projectGeneratedCrudReceipt({ ...projection, receipt: receipt! }),
    { result: null, records: [] });
  assert.deepEqual(await snapshot(w.store), before); assert.deepEqual(wiring.counts, counts);
  assert.equal(frames, 1); assert.equal(closes, 1); assert.equal(bodies, 1); assert.equal(commits, 1);
  assert.equal(storedRowLoads, 0);
  const validation = (error: unknown) => error instanceof StateError && error.code === 'validation';
  await assert.rejects(projectGeneratedCrudReceipt({ ...projection, registry: new Map() }), validation);
  await assert.rejects(projectGeneratedCrudReceipt({ ...projection, receipt: {
    ...retained, identity: { ...retained.identity, operation: asOperation(CREATE) },
  } }), validation);
  await assert.rejects(projectGeneratedCrudReceipt({ ...projection, receipt: {
    ...retained, outcome: { ...retained.outcome, result: deleted },
  } }), validation);
  await assert.rejects(projectGeneratedCrudReceipt({ ...projection, identity: makeIdentity({
    userId: 'foreign-user', team: w.member.team, membership: w.member.membership,
  }) }), error => error instanceof StateError && error.code === 'forbidden');
  await w.memberships.removeMembership(w.member.membership.membership_id);
  const revokedBefore = membershipReads;
  assert.deepEqual(await projectGeneratedCrudReceipt({ ...projection,
    policy: buildPolicyTable([{ model: ITEM, secretFields: [], grants: [] }]) }), { result: null, records: [] });
  assert.ok(membershipReads > revokedBefore); assert.equal(storedRowLoads, 0);
  assert.equal(bodies, 1); assert.equal(commits, 1); assert.deepEqual(wiring.counts, counts);
});

test('valid long component identities retain canonical composite handler and fanout row IDs', async () => {
  const store = createMemoryStorage(); await seedRow(store, ITEM, { id: 'a', data: { value: 'entry' } });
  const occurrence = '/'.repeat(190), handler = '?'.repeat(190);
  const wiring = installed((_change, ctx) => ({ scope: scope(ctx), handlers: [
    { handler }, { handler: `${handler}b`, cohort: { kind: 'model', owner: scope(ctx).owner, model: ITEM } },
  ] }), sourceBounds, () => occurrence);
  const owner = await beginOwnerMutation({ table: table(), store, context: context(), bounds: ownerBounds, stageSources: wiring.stageSources });
  await owner.stage(update('a', 'changed'), cause); const output = await owner.finalize();
  await commit(store, output);
  const ordinaryId = handlerOccurrenceRowId(occurrence, handler);
  assert.ok(ordinaryId.length > 200); assert.ok(await store.load(WORK_HANDLER_OCCURRENCE_MODEL, asId(ordinaryId)));
  const childId = fanoutChildRowId(occurrence, `${handler}b`, 'a');
  assert.ok(childId.length > 200); assert.ok(await store.load(WORK_FANOUT_CHILD_MODEL, asId(childId)));
});

test('actual stager outputs refuse malformed framework effects and finite write-array overflow before commit', async () => {
  for (const mode of ['business', 'update', 'version', 'attribution', 'parent', 'duplicate', 'array-bound', 'not-json'] as const) {
    const store = createMemoryStorage(); await seedRow(store, ITEM, { id: 'a', data: { value: 'entry' } });
    const before = await snapshot(store);
    const stageSources: OwnerMutationSourceStager = async token => {
      const stage = readOwnerMutationSourceStage(token);
      const row = newOccurrenceRow({ occurrenceId: 'actual-finalizer-source', status: 'completed', result: null,
        code: null, message: null, recordedAtMs: stage.context.now }, { nowMs: stage.context.now, actor: stage.framework.actor });
      const write = { kind: 'insert', model: WORK_OCCURRENCE_MODEL, row } as const;
      if (mode === 'business') return [{ ...write, model: ITEM }];
      if (mode === 'update') return [{ kind: 'update', model: WORK_OCCURRENCE_MODEL, id: row.id,
        expectedVersion: row.version, row }];
      if (mode === 'version') return [{ ...write, row: { ...row, version: 2 as StoredRow['version'] } }];
      if (mode === 'attribution') return [{ ...write, row: { ...row, createdBy: 'foreign' } }];
      if (mode === 'parent') return [{ ...write, row: { ...row, parent: { model: PARENT, id: asId('unknown') } } }];
      if (mode === 'duplicate') return [write, write];
      if (mode === 'array-bound') return Array.from({ length: 101 }, (_, index) => ({ ...write,
        row: { ...row, id: asId(`source-${index}`) } }));
      return [{ ...write, row: { ...row, data: { date: new Date() } } }];
    };
    const owner = await beginOwnerMutation({ table: table(), store, context: context(), bounds: ownerBounds, stageSources });
    await owner.stage(update('a', 'changed'), cause); await assert.rejects(owner.finalize());
    assert.deepEqual(await snapshot(store), before, mode);
  }
});

test('caught genuine source-stage failures reject Invoke with no business/history/framework effects; rejected receipt replay runs zero callbacks', async () => {
  const w = await invokeWorld(); await seedRow(w.store, ITEM, { id: 'a', data: { value: 'entry' } });
  const original = await w.store.load(ITEM, asId('a')), revision = await w.store.readRevision();
  let callbacks = 0, ids = 0, executes = 0, commits = 0;
  const wiring = installed(ordinary, sourceBounds, () => { ids++; return 'unreachable'; });
  const actualCommit = w.store.commit;
  w.store.commit = async batch => { commits++; assert.equal(batch.writes.length, 0); assert.equal(batch.history.length, 0);
    assert.equal(batch.receipt!.outcome.status, 'rejected'); return actualCommit(batch); };
  const args = { ...w, execute: async (call: Parameters<Parameters<typeof invoke>[0]['execute']>[0]) => {
    executes++;
    const session = await beginScenarioReceiptMutation(call, w.store, { table: table(), bounds: ownerBounds,
      stageSources: async token => {
        callbacks++; const view = readOwnerMutationSourceStage(token);
        await assert.rejects(view.framework.load(ITEM, asId('a')));
        return wiring.stageSources(token);
      } });
    await session.stage(update('a', 'changed'), cause); selectScenarioReceiptReturn(call, w.store, 'advance-return');
    return execution(await session.finalize());
  } };
  await assert.rejects(invoke(args)); assert.equal(callbacks, 1); assert.equal(ids, 0); assert.equal(executes, 1); assert.equal(commits, 1);
  assert.deepEqual(await w.store.load(ITEM, asId('a')), original);
  assert.deepEqual(await w.store.historyFor(ITEM, asId('a')), []);
  for (const model of frameworkModels) assert.deepEqual(await rows(w.store, model), []);
  assert.equal(await w.store.readRevision(), revision + 1);
  await assert.rejects(invoke(args)); assert.equal(callbacks, 1); assert.equal(ids, 0); assert.equal(executes, 1); assert.equal(commits, 1);
});

test('a genuine nested scenario-to-generated-CRUD call and hook secondary feed the same outer source finalization and Invoke replay', async () => {
  const CHILD = 'Shop.complete', UPDATE = `${ITEM}.update`, slice = scenarioArtifact();
  slice.callables!.push({ id: CHILD, kind: 'operation', module: origin.module, export: 'identity', member: ['complete'] });
  slice.operations!.push(
    { name: CHILD, kind: 'scenario', description: '', inputs: { fields: [] }, result: { type: 'void',
      disclosure: { version: 1, source: origin, returns: [{ id: 'child-return', source: origin, influences: [], dependencies: [] }] } } },
    { name: UPDATE, kind: 'update', description: '', inputs: { fields: [
      { name: 'record', field: { kind: 'ref', model: ITEM, requireVersion: true }, required: true },
      { name: 'value', field: { kind: 'string' }, required: false },
    ] } },
  );
  const w = await invokeWorld(slice); await seedRow(w.store, ITEM, { id: 'a', data: { value: 'entry' } });
  const parent = w.registry.get(OP), child = w.registry.get(CHILD), crud = w.registry.get(UPDATE);
  assert.ok(parent && isGeneratedOperationDef(parent)); assert.ok(child && isGeneratedOperationDef(child));
  assert.ok(crud && isGeneratedOperationDef(crud));
  const models = table(); let hooks = 0, rootExecutions = 0, childExecutions = 0, prepares = 0, commits = 0;
  const policies = bindOwnerModelPolicies({ table: models, descriptors: [{ abi: 'state.owner-model-policies@1',
    model: ITEM, module: 'owner.mjs', ownerPackage: 'Shop', rules: [],
    hooks: [{ id: 'nested-update-hook', op: 'update', operation: asOperation(UPDATE) }],
  }], bindings: [{ id: 'nested-update-hook', kind: 'hook', model: ITEM, module: 'owner.mjs', ownerPackage: 'Shop',
    run: (candidate, carrier) => { hooks++;
      carrier.stage({ op: 'create', model: ARCHIVE, id: asId('nested-side'), data: { value: 'secondary' } });
      return { ...candidate, value: 'hook-final' };
    },
  }] });
  const wiring = installed(), revision = await w.store.readRevision(); let receipt: Receipt | undefined;
  let rootContext: InvocationContext | undefined;
  bindScenarioReceiptCallProducer(child, { source: origin, app: APP, registry: w.registry,
    sites: [{ id: 'nested-crud', source: origin, kind: 'operation', targets: [
      { operation: UPDATE, interface: crud.descriptor },
    ], resultType: null }], prepare: (_def, inputs, immediateParent) => {
      prepares++; assert.equal(immediateParent.def.name, CHILD); return inputs as ClosedInputs;
    }, execute: async () => { throw Error('Generated CRUD executes through the actual owning State stage'); },
  });
  bindScenarioReceiptCallProducer(parent, { source: origin, app: APP, registry: w.registry,
    sites: [{ id: 'child-scenario', source: origin, kind: 'operation', targets: [
      { operation: CHILD, interface: child.descriptor },
    ], resultType: 'void' }], prepare: (_def, inputs, immediateParent) => {
      prepares++; assert.equal(immediateParent.def.name, OP); return inputs as ClosedInputs;
    }, execute: async frame => {
      childExecutions++; assert.equal(frame.parent.context, rootContext);
      assert.equal(frame.call.context.operation, CHILD); assert.equal(frame.call.context.source, origin.path);
      const current = await frame.session.read(ITEM, asId('a')); assert.ok(current);
      const result = await invokeScenarioReceiptCall(frame.call, w.store, { site: 'nested-crud', target: UPDATE,
        inputs: { record: { id: current.id, version: String(current.version) }, value: 'authored-child' } }) as StoredRow;
      assert.equal(result.version, 2); assert.equal(result.data.value, 'hook-final');
      selectScenarioReceiptReturn(frame.call, w.store, 'child-return'); return null;
    },
  });
  const actualCommit = w.store.commit;
  w.store.commit = async batch => {
    commits++; assert.equal(batch.expectedRevision, revision); assert.ok(batch.receipt);
    assert.equal(batch.writes.length, 6); assert.equal(batch.history.length, 3); return actualCommit(batch);
  };
  const args = { ...w, observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: Parameters<Parameters<typeof invoke>[0]['execute']>[0]) => {
    rootExecutions++; rootContext = call.context;
    const session = await beginScenarioReceiptMutation(call, w.store, { table: models, bounds: ownerBounds,
      policies, stageSources: wiring.stageSources });
    await invokeScenarioReceiptCall(call, w.store, { site: 'child-scenario', target: CHILD, inputs: {} });
    await session.stage(update('a', 'root-final'), cause);
    selectScenarioReceiptReturn(call, w.store, 'advance-return');
    const output = await session.finalize();
    assert.deepEqual(output.history.map(entry => [entry.model, entry.recordId, entry.operation, entry.version,
      entry.before, entry.after]), [
      [ITEM, 'a', UPDATE, 2, { value: 'entry' }, { value: 'hook-final' }],
      [ARCHIVE, 'nested-side', UPDATE, 1, null, { value: 'secondary' }],
      [ITEM, 'a', OP, 2, { value: 'hook-final' }, { value: 'root-final' }],
    ]);
    assert.deepEqual(sourceReceipts(output).map(source => source.change), [
      { model: ARCHIVE, recordId: 'nested-side', version: 1, kind: 'created' },
      { model: ITEM, recordId: 'a', version: 2, kind: 'updated' },
    ]);
    for (const source of sourceReceipts(output)) {
      assert.equal(source.context.operation, OP); assert.equal(source.context.source, w.source);
      assert.equal(source.context.operationId, w.envelope.operation_id); assert.equal(source.revision, revision);
      assert.deepEqual(source.context.actor, rootContext.actor); assert.deepEqual(source.context.team, rootContext.team);
    }
    return execution(output);
  } };
  assert.equal((await invoke(args)).status, 'committed'); assert.ok(receipt);
  const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
  assert.deepEqual(new Set(association.calls!.map(call => call.target)), new Set([CHILD, UPDATE]));
  assert.deepEqual(new Set(association.changed.map(change => change.model)), new Set([ITEM, ARCHIVE]));
  assert.equal((await rows(w.store, WORK_OCCURRENCE_MODEL)).length, 2);
  assert.equal((await w.store.load(ITEM, asId('a')))!.data.value, 'root-final');
  assert.equal((await w.store.load(ARCHIVE, asId('nested-side')))!.data.value, 'secondary');
  const before = await snapshot(w.store), counts = { ...wiring.counts };
  assert.equal((await invoke(args)).status, 'replayed'); assert.deepEqual(await snapshot(w.store), before);
  assert.deepEqual(wiring.counts, counts); assert.equal(commits, 1); assert.equal(rootExecutions, 1);
  assert.equal(childExecutions, 1); assert.equal(hooks, 1); assert.equal(prepares, 2);
});
