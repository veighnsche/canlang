/** Original regenerate's new Branch must have its own Turn position domain. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Miniflare} from 'miniflare';
import type {D1Database} from '@cloudflare/workers-types';
import type {CanTypeId, StoragePort} from '@canlang/contracts';
import {StateError} from '../errors.js';
import {createTestMemoryStorage} from '../storage/memory.js';
import {createD1Storage, ensureSchema} from '../storage/d1.js';
import {StorageConstraintError, FenceConflictError} from '../storage/port.js';
import {canonicalUniqueRowValue} from '../internal/unique-value.js';
import {buildModelTable, type InterimModelDef, type ModelTable} from './models.js';
import {beginOwnerMutation, runMutationWrites, type MutationWritesResult} from './pipeline.js';
import {activate, stageNextChunk, validateStaged, validateTransition} from '../migration/index.js';
import {makeInstalled, makeTransition, oldLocks, fixedClock, installSnapshot} from '../../test/migration/fixtures.js';
import {makeBatch} from '../../test/invocation/fixtures.js';
import {asId, asModel, field, hook, invariant, modelDef, mustLoad, pipelineContext} from '../../test/mutation/fixtures.js';

const BRANCH = asModel('chat.Branch'), TURN = asModel('chat.Turn');
const context = () => pipelineContext({operation: 'chat.regenerate'}), cause = {cause: 'scenario'} as const;
const bounds = {maxRows: 30, maxWork: 1000};
const conflict = (e: unknown) => e instanceof StateError && e.code === 'conflict' || e instanceof StorageConstraintError && e.kind === 'unique';
function definitions(mode: 'remove' | 'archive' = 'remove', declared = true): InterimModelDef[] {
  return [modelDef(BRANCH, {deleteMode: 'remove'}), {
    ...modelDef(TURN, {fields: {position: {...field({required: true}), valueType: 'int' as CanTypeId}}, uniqueKeys: ['position'], deleteMode: mode}),
    ...(declared ? {containment: {parent: BRANCH}} : {}),
  }];
}
const parent = (id: string) => ({model: BRANCH, id: asId(id)});
const create = (id: string, branch: string, position: string) => ({op: 'create' as const, model: TURN, id: asId(id), parent: parent(branch), data: {position}});
const update = (id: string, position: string) => ({op: 'update' as const, model: TURN, id: asId(id), data: {position}});
async function commit(store: StoragePort, output: MutationWritesResult) {await store.commit(makeBatch(await store.readRevision(), output));}
async function write(store: StoragePort, table: ModelTable, writes: Parameters<typeof runMutationWrites>[0]['writes']) {
  await commit(store, await runMutationWrites({store, table, context: context(), writes}));
}
async function branches(store: StoragePort, table: ModelTable) {
  await write(store, table, ['original', 'fork', 'probe'].map(id => ({op: 'create', model: BRANCH, id: asId(id), data: {}})));
}

test('Memory/D1 contained position admits a new branch with atomic update/net/hook/remove/archive rules', {timeout: 30000}, async () => {
  const worker = new Miniflare({modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB']});
  try {
    const db = await worker.getD1Database('DB') as unknown as D1Database; await ensureSchema(db);
    for (const store of [createTestMemoryStorage().store, createD1Storage(db)]) {
      const table = buildModelTable(definitions()); await branches(store, table);
      await write(store, table, [create('original-turn', 'original', '1'), create('fork-turn', 'fork', '1')]);
      assert.equal((await mustLoad(store, TURN, 'fork-turn')).data.position, '1');
      const before = await store.readRevision();
      await assert.rejects(write(store, table, [create('duplicate', 'original', '1')]), conflict);
      assert.equal(await store.readRevision(), before); assert.equal(await store.load(TURN, asId('duplicate')), null);
      assert.deepEqual(await store.historyFor(TURN, asId('duplicate')), []);
      await write(store, table, [create('second', 'original', '2')]);
      await assert.rejects(write(store, table, [update('original-turn', '2')]), conflict);
      await write(store, table, [update('original-turn', '3'), create('reused', 'original', '1')]);
      const session = await beginOwnerMutation({store, table, context: context(), bounds});
      await session.stage(update('original-turn', '2'), cause); await session.stage(update('second', '3'), cause);
      await session.stage(create('net-a', 'original', '4'), cause); await session.stage(create('net-b', 'original', '4'), cause);
      await session.stage(update('net-b', '5'), cause); await session.stage(create('net-removed', 'original', '4'), cause);
      await session.stage({op: 'remove', model: TURN, id: asId('net-removed')}, cause);
      await commit(store, await session.finalize());
      assert.equal((await mustLoad(store, TURN, 'original-turn')).data.position, '2');
      assert.equal((await mustLoad(store, TURN, 'second')).data.position, '3');
      assert.equal(await store.load(TURN, asId('net-removed')), null);
      await write(store, table, [{op: 'remove', model: TURN, id: asId('reused')}, create('after-remove', 'original', '1')]);
      const archived = buildModelTable(definitions('archive'));
      await write(store, archived, [{op: 'remove', model: TURN, id: asId('fork-turn')}]);
      await assert.rejects(write(store, archived, [create('after-archive', 'fork', '1')]), conflict);
      const defs = definitions(); defs[1] = {...defs[1]!,
        hooks: [hook('final-position', ['create'], c => ({...c, position: '6'}))],
        invariants: [invariant('late-failure', view => {if (view.get(TURN, asId('failed')) !== null) throw new StateError('rule_failed', 'late');})],
      };
      const hooked = buildModelTable(defs), late = await beginOwnerMutation({store, table: hooked, context: context(), bounds});
      await late.stage(create('failed', 'fork', '100'), {cause: 'crud', input: {position: '100'}});
      await assert.rejects(late.finalize(), e => e instanceof StateError && e.code === 'rule_failed');
      assert.equal(await store.load(TURN, asId('failed')), null); assert.deepEqual(await store.historyFor(TURN, asId('failed')), []);
      const recovered = await beginOwnerMutation({store, table: hooked, context: context(), bounds});
      await recovered.stage(create('recovered', 'fork', '100'), {cause: 'crud', input: {position: '100'}});
      await commit(store, await recovered.finalize()); assert.equal((await mustLoad(store, TURN, 'recovered')).data.position, '6');
      const duplicateHook = await beginOwnerMutation({store, table: hooked, context: context(), bounds});
      await duplicateHook.stage(create('hook-duplicate', 'fork', '101'), {cause: 'crud', input: {position: '101'}});
      await assert.rejects(async () => commit(store, await duplicateHook.finalize()), conflict);
      const stale = await runMutationWrites({store, table, context: context(), writes: [create('stale', 'fork', '7')]});
      const revision = await store.readRevision(); await write(store, table, [create('fence', 'original', '8')]);
      await assert.rejects(store.commit(makeBatch(revision, stale)), e => e instanceof FenceConflictError);
      assert.equal(await store.load(TURN, asId('stale')), null); await write(store, table, [create('after-stale', 'fork', '7')]);
      const def = table.get(TURN)!;
      assert.notEqual(canonicalUniqueRowValue({data: {position: '1'}, parent: parent('a|b')}, 'position', def),
        canonicalUniqueRowValue({data: {position: 'b|1'}, parent: parent('a')}, 'position', def));
      assert.throws(() => canonicalUniqueRowValue({data: {position: '1'}, parent: null}, 'position', def));
      assert.throws(() => canonicalUniqueRowValue({data: {position: '1'}, parent: {model: TURN, id: asId('original')}}, 'position', def));
      assert.equal(canonicalUniqueRowValue({data: {position: '1'}, parent: parent('original')}, 'position', buildModelTable(definitions('remove', false)).get(TURN)!), '1');
    }
  } finally {await worker.dispose();}
});

test('Memory/D1 migration uses actual staged/live parents and reindexes legacy claims atomically', {timeout: 30000}, async () => {
  const worker = new Miniflare({modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB']});
  try {
    const db = await worker.getD1Database('DB') as unknown as D1Database; await ensureSchema(db);
    for (const store of [createTestMemoryStorage().store, createD1Storage(db)]) {
      const oldModels = buildModelTable(definitions('remove', false)), desiredModels = buildModelTable(definitions());
      await branches(store, oldModels); await write(store, oldModels, [create('original-turn', 'original', '1')]);
      await assert.rejects(write(store, oldModels, [create('fork-before', 'fork', '1')]), conflict);
      const plan = validateTransition(makeInstalled(), makeTransition({directives: [{kind: 'backfill', model: TURN}]}), oldModels, desiredModels);
      await installSnapshot(store, makeInstalled());
      await stageNextChunk({store, plan, oldModels, desiredModels, chunkSize: 10, mappers: new Map([[TURN, () => {}]])});
      assert.equal((await store.readStagedRows(plan.migrationId, null, 10))[0]!.parent?.id, 'original');
      assert.equal((await validateStaged({store, plan, oldModels, desiredModels, oldLocks: oldLocks([])})).phase, 'staged');
      await activate({store, plan, oldModels, desiredModels, inventory: [], chunkSize: 10, clock: fixedClock()});
      await write(store, desiredModels, [create('fork-after', 'fork', '1')]);
      await assert.rejects(write(store, desiredModels, [create('same-parent', 'original', '1')]), conflict);
      const retainedPlan = validateTransition(makeInstalled({snapshotId: 'snap-2', digest: 'digest-2'}),
        makeTransition({migrationId: 'retain-2', fromSnapshotId: 'snap-2', fromDigest: 'digest-2', toSnapshotId: 'snap-3', toDigest: 'digest-3'}), desiredModels, desiredModels);
      await stageNextChunk({store, plan: retainedPlan, oldModels: desiredModels, desiredModels, chunkSize: 10, mappers: new Map()});
      assert.equal((await store.readStagedRows(retainedPlan.migrationId, null, 10)).length, 0);
      assert.equal((await validateStaged({store, plan: retainedPlan, oldModels: desiredModels, desiredModels, oldLocks: oldLocks([])})).phase, 'staged');
      // A real legacy-table write in a third empty parent proves the old raw
      // claim was released; this is isolated API scope, not profile adoption.
      await write(store, oldModels, [create('old-key-released', 'probe', '1')]);
      assert.equal((await mustLoad(store, TURN, 'original-turn')).parent?.id, 'original');
    }
  } finally {await worker.dispose();}
});
