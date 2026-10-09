/** Defining saved-scenario API on native D1 and SQLite DO serialization.
 * The checked artifact is hand-built. Adapter reopen is exercised; Compiler
 * emission, whole-app closure and process-restart survival are not claimed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CanTypeId, Receipt, ScenarioResultDisclosurePlan, StoragePort } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '../../src/storage/d1.js';
import { StateError } from '../../src/errors.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import { buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { runMutationWrites } from '../../src/mutation/pipeline.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { invoke, invokeRetainedReceiptOnly } from '../../src/invocation/invoke.js';
import { observeScenarioReceiptDependency, selectScenarioReceiptReturn,
  readScenarioReceiptAssociation, projectScenarioReceipt } from '../../src/invocation/scenario-receipt.js';
import { FIXED_NOW, asModel, createMemoryIdentityStore, makeBatch, makeIdentity, makeEnvelope,
  seedMember, seedRow, uuidv7 } from './fixtures.js';
import { pipelineContext } from '../mutation/fixtures.js';

const MODEL = asModel('Shop.Record'), OP = 'Shop.saved', APP = 'saved-scenario-app';
const origin = () => ({ path: 'saved.can', sha256: 'a'.repeat(64), module: 'saved.mjs' });
function artifact(): ArtifactDescriptorSlice {
  const disclosure: ScenarioResultDisclosurePlan = { version: 1, source: origin(), returns: [
    { id: 'record-result', source: origin(), influences: [], dependencies: [
      { id: 'value', source: origin(), role: 'data', model: MODEL, field: 'visible', type: 'text' as CanTypeId },
    ] },
  ] };
  return { artifact_version: 1, sources: [{ path: 'saved.can', sha256: 'a'.repeat(64) }],
    modules: [{ path: 'saved.mjs', js: 'export const identity="Shop.saved";', map: { version: 3,
      file: 'saved.mjs', sources: ['saved.can'], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: 'saved.mjs', export: 'identity', member: ['saved'] }],
    models: [{ name: MODEL, deleteMode: 'archive', fields: [
      { name: 'visible', field: { kind: 'string' }, required: true, serverOnly: false },
      { name: 'private', field: { kind: 'string' }, required: true, serverOnly: false },
      { name: 'token', field: { kind: 'secret' }, required: false, serverOnly: true,
        default: { kind: 'server', init: 'random_secret' } },
    ] }],
    operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'record', field: { kind: 'ref', model: MODEL, requireVersion: true }, required: true },
    ] }, result: { type: 'text' as CanTypeId, disclosure } }],
  };
}

/** Same owning Miniflare adapter pattern as staged-durable.test.ts. */
async function nativeStore(kind: 'd1' | 'do') {
  if (kind === 'd1') {
    const mf = new Miniflare({ modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] });
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(db);
    return { store: createD1Storage(db), reopen: async () => createD1Storage(db), dispose: () => mf.dispose() };
  }
  const mf = new Miniflare({ modules: true,
    scriptPath: fileURLToPath(new URL('../../../test/storage/do-test-worker.js', import.meta.url)),
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }], compatibilityDate: '2025-01-01',
    durableObjects: { TEST_DO: { className: 'TestDO', useSQLite: true, unsafePreventEviction: true } } });
  const post = async (path: string, body: unknown) => {
    const response = await mf.dispatchFetch(`http://localhost${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json() as { ok: boolean; value?: unknown; error?: { name: string; message: string } };
    if (!data.ok) throw Object.assign(new Error(data.error?.message ?? 'Native DO call failed'), { name: data.error?.name ?? 'Error' });
    return data.value;
  };
  const call = async <T>(method: string, ...args: unknown[]): Promise<T> => await post('/call', { method, args }) as T;
  const proxy = (): StoragePort => ({
    readRevision: () => call('readRevision'), load: (model, id) => call('load', model, id),
    query: spec => call('query', spec), commit: batch => call('commit', batch),
    readReceipt: identity => call('readReceipt', identity), outboxPending: () => call('outboxPending'),
    outboxGet: id => call('outboxGet', id), scheduleGet: key => call('scheduleGet', key),
    schedulesDue: (now, limit) => call('schedulesDue', now, limit), historyFor: (model, id) => call('historyFor', model, id),
    readInstalledSnapshot: owner => call('readInstalledSnapshot', owner),
    readMigrationProgress: id => call('readMigrationProgress', id),
    readStagedRows: (id, cursor, limit) => call('readStagedRows', id, cursor, limit),
    stageMigrationRows: input => call('stageMigrationRows', input),
    publishMigrationChunk: input => call('publishMigrationChunk', input),
    flipInstalledSnapshot: input => call('flipInstalledSnapshot', input),
    readMigrationOutcomes: id => call('readMigrationOutcomes', id),
    recordMigrationFailure: input => call('recordMigrationFailure', input),
    discardStagedRows: input => call('discardStagedRows', input), readMigrationFailure: id => call('readMigrationFailure', id),
  });
  return { store: proxy(), reopen: async () => { await post('/reopen', {}); return proxy(); }, dispose: () => mf.dispose() };
}

const stateCode = (code: string) => (error: unknown) => error instanceof StateError && error.code === code;
for (const substrate of ['d1', 'do'] as const) {
  test(`saved scenario receipt preserves protected snapshots across native ${substrate} adapter reopen`, async () => {
    const native = await nativeStore(substrate);
    try {
      let store = native.store;
      const memberships = createMemoryIdentityStore();
      const member = await seedMember(memberships, { isOwner: false, roles: ['Shop.reader'] });
      const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
      const loaded = loadArtifactDescriptors(artifact(), { by: 'members' });
      const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
      await seedRow(store, MODEL, { id: 'saved-row', data: {
        visible: 'original visible', private: 'private choice', token: 'original secret',
      } });
      const original = await store.load(MODEL, 'saved-row' as import('@canlang/contracts').RecordId); assert.ok(original);
      const envelope = makeEnvelope(OP, uuidv7(FIXED_NOW, 9701), {
        record: { id: original.id, version: String(original.version) },
      });
      const input = { registry: loaded.registry, envelope, app: APP, identity, memberships,
        source: 'test', clock: { nowMs: () => FIXED_NOW } };
      let receipt: Receipt | undefined;
      const saved = await invoke({ ...input, store, execute: async call => {
        const row = call.recordRefs[0]!.row;
        await observeScenarioReceiptDependency(call, store, { dependencyId: 'value', model: MODEL, row, field: 'visible' });
        selectScenarioReceiptReturn(call, store, 'record-result');
        const effects = await runMutationWrites({ table, store, context: call.context,
          writes: [{ op: 'update', model: MODEL, id: row.id, data: { visible: 'committed visible' } }] });
        return { ...effects, outbox: [], result: row.data.visible };
      }, observeCommittedReceipt: value => { receipt = value; } });
      assert.equal(saved.status, 'committed'); assert.ok(receipt);
      const retained = receipt;
      store = await native.reopen();
      assert.deepEqual(await store.readReceipt(retained.identity), retained);
      const association = readScenarioReceiptAssociation(retained); assert.ok(association);
      assert.deepEqual(association.plan, artifact().operations![0]!.result!.disclosure);
      assert.deepEqual(association.observations[0]!.row, original);
      assert.equal(association.changed[0]!.row.data.visible, 'committed visible');
      assert.equal(association.changed[0]!.row.version, original.version + 1);
      assert.deepEqual(await store.load(MODEL, original.id), association.changed[0]!.row);
      assert.equal((await store.historyFor(MODEL, original.id)).length, 1);

      // Later real domain state establishes current authority, while the
      // associated result and changed snapshots remain the saved values.
      const later = await runMutationWrites({ table, store,
        context: pipelineContext({ operation: 'Shop.Record.update', operationId: uuidv7(FIXED_NOW, 9702), now: FIXED_NOW + 1 }),
        writes: [{ op: 'update', model: MODEL, id: original.id, data: { visible: 'current visible' } }] });
      await store.commit(makeBatch(await store.readRevision(), later));
      const policy = buildPolicyTable([{ model: MODEL, secretFields: [], grants: [
        { by: { role: 'Shop.reader' }, fields: ['visible', 'private', 'token'],
          when: { op: 'eq', field: 'visible', value: 'current visible' } },
      ] }]);
      const snapshot = async () => ({ revision: await store.readRevision(), row: await store.load(MODEL, original.id),
        history: await store.historyFor(MODEL, original.id), outbox: await store.outboxPending(),
        receipt: await store.readReceipt(retained.identity) });
      const before = await snapshot();
      let executes = 0, commits = 0, recovered: Receipt | undefined;
      const recoveryStore: StoragePort = { ...store, commit: async batch => { commits++; return store.commit(batch); } };
      const recovery = { ...input, store: recoveryStore, clock: { nowMs: () => FIXED_NOW + 16 * 60_000 },
        execute: async () => { executes++; throw new Error('Retained recovery must not execute'); },
        observeCommittedReceipt: (value: Receipt) => { recovered = value; } };
      const replayed = await invokeRetainedReceiptOnly(recovery);
      assert.equal(replayed.status, 'replayed'); assert.equal(replayed.result, 'original visible');
      assert.deepEqual(recovered, retained);
      const projected = await projectScenarioReceipt({ ...input, store, policy, receipt: retained });
      assert.equal(projected.result, 'original visible'); assert.equal(projected.records.length, 1);
      assert.equal(projected.records[0]!.data.visible, 'committed visible');
      assert.equal(projected.records[0]!.version, original.version + 1);
      assert.equal(Object.hasOwn(projected.records[0]!.data, 'token'), false);
      assert.equal(before.row?.data.visible, 'current visible');

      await assert.rejects(invokeRetainedReceiptOnly({ ...recovery,
        envelope: { ...envelope, inputs: { record: { id: original.id, version: '999' } } } }), stateCode('conflict'));
      const foreign = await seedMember(memberships, { isOwner: false, teamId: member.team.team_id, roles: ['Shop.reader'] });
      const foreignIdentity = makeIdentity({ userId: foreign.user.user_id, team: foreign.team, membership: foreign.membership });
      await assert.rejects(invokeRetainedReceiptOnly({ ...recovery, identity: foreignIdentity }), stateCode('not_found'));
      await assert.rejects(projectScenarioReceipt({ ...input, store, policy, identity: foreignIdentity, receipt: retained }), stateCode('forbidden'));
      await assert.rejects(projectScenarioReceipt({ ...input, store, policy,
        receipt: { ...retained, inputHash: 'foreign-hash' } }), stateCode('validation'));
      const masked = await projectScenarioReceipt({ ...input, store, receipt: retained,
        policy: buildPolicyTable([{ model: MODEL, secretFields: ['visible'],
          grants: [{ by: 'members', fields: ['private', 'token'] }] }]) });
      assert.equal(masked.result, null); assert.equal(masked.records.length, 1);
      assert.deepEqual(masked.records[0]!.data, { private: 'private choice' });
      await memberships.removeMembership(member.membership.membership_id);
      assert.deepEqual(await projectScenarioReceipt({ ...input, store, policy, receipt: retained }), { result: null, records: [] });
      await assert.rejects(invokeRetainedReceiptOnly(recovery), stateCode('forbidden'));
      assert.equal(executes, 0); assert.equal(commits, 0);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await native.dispose();
    }
  });
}
