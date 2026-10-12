/** Actual bounded Work recovery over D1 and workerd DO SQLite; no provider work. */
import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';
import type {CommitBatch, OutboxId, QuerySpec, RecordId, StoragePort, StoredRow} from '@canlang/contracts';
import {createSystemRegistry} from '@canlang/state';
import {createTestMemoryStorage} from '@canlang/state/storage/memory';
import {createD1Storage, ensureSchema} from '@canlang/state/storage/d1';
import {workDispatchRecoverCommand} from '../src/kernel/commands.js';
import {WORK_DISPATCH_MODEL, newDispatchRow, readDispatchRow} from '../src/kernel/tables.js';

const NOW = 10000, AGE = 1000, actor = 'recovery-control';
const args = {maxClaimAgeMs: AGE, limit: 1};
const context = (id: string) => ({actor, now: NOW, operation: 'work.dispatch.recover', operationId: id});
const registry = createSystemRegistry([workDispatchRecoverCommand]);
const entryCwd = process.cwd();
const stateDir = fileURLToPath(new URL('../../', import.meta.resolve('@canlang/state/distribution')));
before(() => {process.chdir(stateDir);});
after(() => {process.chdir(entryCwd);});
const workerPath = fileURLToPath(new URL(import.meta.resolve('@canlang/state/testing/storage/do-test-worker')));
function row(id: string, state: 'pending' | 'claimed' | 'uncertain', stale = false, archived = false): StoredRow {
  const base = newDispatchRow({intentId: id as OutboxId, operationId: 'origin', source: 'std.EmailV1.send',
    occurrenceIndex: 0, originOccurrence: null}, {nowMs: NOW, actor});
  return {...base, archivedAt: archived ? NOW : null, data: {...base.data, state,
    claimId: state === 'claimed' ? 'claim' : null, claimedAtMs: state === 'claimed' ? stale ? NOW - AGE : NOW : null}};
}
function batch(revision: Awaited<ReturnType<StoragePort['readRevision']>>, rows: readonly StoredRow[]): CommitBatch {
  return {expectedRevision: revision, writes: rows.map(row => ({kind: 'insert', model: WORK_DISPATCH_MODEL, row})), history: [],
    receipt: null, outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: []};
}
interface RecoveryResult {released: string[]; resumeAfter: string | null; done: boolean; uncertain: string[]; uncertainTruncated: boolean;}
const sql = "SELECT * FROM records INDEXED BY idx_records_recovery WHERE model = ? AND archived_at IS NULL AND (json_extract(data, '$.state') = ?) ORDER BY id ASC LIMIT ?";

for (const kind of ['d1', 'do'] as const) test(`${kind} recovery bounds actual windows, continuation/order/uncertainty, failure and fence`, {timeout: 60000}, async () => {
  const mf = kind === 'd1' ? new Miniflare({modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB']})
    : new Miniflare({modules: true, scriptPath: workerPath, modulesRules: [{type: 'ESModule', include: ['**/*.js']}],
      compatibilityDate: '2025-01-01', durableObjects: {TEST_DO: {className: 'TestDO', useSQLite: true}}});
  try {
    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const response = await mf.dispatchFetch(`http://localhost${path}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
      const output = await response.json() as Record<string, unknown>;
      if (output.ok !== true) throw new Error(JSON.stringify(output.error)); return output;
    };
    const call = async <T>(method: string, ...args: unknown[]): Promise<T> => (await post('/call', {method, args})).value as T;
    const db = kind === 'd1' ? await mf.getD1Database('DB') : null;
    if (db !== null) await ensureSchema(db as unknown as Parameters<typeof ensureSchema>[0]);
    const store = db === null ? {cohortIdOrder: 'utf8-binary', readRevision: () => call('readRevision'),
      load: (model, id) => call('load', model, id), query: spec => call('query', spec), commit: input => call('commit', input),
    } as StoragePort : createD1Storage(db as unknown as Parameters<typeof createD1Storage>[0]);
    const queryLog: {spec: QuerySpec; count: number}[] = [];
    const observed: StoragePort = {...store, query: async spec => {
      const rows = await store.query(spec); queryLog.push({spec, count: rows.length}); return rows;
    }};
    const rows = [
      ...Array.from({length: 1000}, (_, i) => row(`a-pending-${String(i).padStart(4, '0')}`, 'pending')),
      ...Array.from({length: 500}, (_, i) => row(`a-archived-${String(i).padStart(4, '0')}`, 'claimed', true, true)),
      ...Array.from({length: 40}, (_, i) => row(`fresh-${String(i).padStart(3, '0')}`, 'claimed')),
      row('fresh-020-u', 'uncertain'), row('fresh-030-u', 'uncertain'), row('fresh-025-stale', 'claimed', true),
      row('unicode-\uE000', 'claimed'), row('unicode-\u{10000}', 'claimed'),
    ];
    await store.commit(batch(await store.readRevision(), rows));
    const queryPlan = db === null ? (await post('/exec', {sql: `EXPLAIN QUERY PLAN ${sql}`, params: [WORK_DISPATCH_MODEL, 'claimed', 2]})).rows
      : (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(WORK_DISPATCH_MODEL, 'claimed', 2).all()).results;
    assert.match(JSON.stringify(queryPlan), /idx_records_recovery/); assert.doesNotMatch(JSON.stringify(queryPlan), /TEMP B-TREE/);
    if (db !== null) {
      const physical = await db.prepare(sql).bind(WORK_DISPATCH_MODEL, 'claimed', 2).all();
      assert.equal(physical.results.length, 2); assert.ok(physical.meta.rows_read <= 18, JSON.stringify(physical.meta));
    }
    const expected = rows.filter(row => row.archivedAt === null && row.data.state !== 'pending').map(row => row.id as string).sort();
    // SQLite binary ordering puts BMP E000 before astral10000; UTF16 differs.
    expected.splice(expected.indexOf('unicode-\u{10000}'), 1); expected.push('unicode-\u{10000}');
    let cursor: string | null = null; const visited: string[] = [], released: string[] = [], uncertain: string[] = [];
    for (let index = 0; index < expected.length; index++) {
      queryLog.length = 0;
      const output = await registry.run('work.dispatch.recover', {...args, resumeAfter: cursor}, context(`page-${index}`), {store: observed});
      const result = output.result as RecoveryResult;
      assert.equal(queryLog.length, 2); assert.ok(queryLog.every(entry => entry.spec.limit === 2 && entry.count <= 2));
      assert.ok(queryLog.reduce((sum, entry) => sum + entry.count, 0) <= 4);
      released.push(...result.released); uncertain.push(...result.uncertain); visited.push(expected[index]!);
      assert.equal(result.done, index === expected.length - 1);
      assert.equal(result.resumeAfter, result.done ? null : expected[index]);
      assert.deepEqual(result.uncertain, expected[index]!.endsWith('-u') ? [expected[index]!] : []);
      assert.equal(result.uncertainTruncated, expected.slice(index + 1).some(id => id.endsWith('-u')));
      if (index === 0) assert.deepEqual(result.released, [], 'fresh claim consumes a visit even without a release');
      cursor = result.resumeAfter;
    }
    assert.deepEqual(visited, expected); assert.deepEqual(released, ['fresh-025-stale']); assert.deepEqual(uncertain, ['fresh-020-u', 'fresh-030-u']);
    assert.equal(readDispatchRow((await store.load(WORK_DISPATCH_MODEL, 'fresh-020-u' as RecordId))!).state, 'uncertain');
    const replay = await registry.run('work.dispatch.recover', {maxClaimAgeMs: AGE, limit: 100}, context('repeat'), {store: observed});
    assert.deepEqual((replay.result as RecoveryResult).released, []); assert.equal((await store.load(WORK_DISPATCH_MODEL, 'fresh-025-stale' as RecordId))!.version, 2);
    const malformed = {...row('000-malformed', 'claimed'), data: {...row('000-malformed', 'claimed').data, guardVerdict: 'invalid'}};
    await store.commit(batch(await store.readRevision(), [malformed])); const failureRevision = await store.readRevision(); let reads = 0;
    await assert.rejects(registry.run('work.dispatch.recover', args, context('first-failure'), {store: {...store, query: async spec => {
      if (++reads === 2) throw new Error('later reader failure'); return store.query(spec);
    }}}), /guardVerdict must be boolean/);
    assert.equal(reads, 1); assert.equal(await store.readRevision(), failureRevision);
    await store.commit({...batch(await store.readRevision(), []), writes: [{kind: 'remove', model: WORK_DISPATCH_MODEL, id: malformed.id, expectedVersion: malformed.version}]});
    await store.commit(batch(await store.readRevision(), [row('000-stale', 'claimed', true)]));
    const lateRevision = await store.readRevision(); reads = 0;
    await assert.rejects(registry.run('work.dispatch.recover', args, context('late-failure'), {store: {...store, query: async spec => {
      if (++reads === 2) throw new Error('late reader failure'); return store.query(spec);
    }}}), /late reader failure/);
    assert.equal(await store.readRevision(), lateRevision); assert.equal(readDispatchRow((await store.load(WORK_DISPATCH_MODEL, '000-stale' as RecordId))!).state, 'claimed');
    reads = 0;
    await assert.rejects(registry.run('work.dispatch.recover', args, context('fence-failure'), {store: {...store, query: async spec => {
      const value = await store.query(spec); if (++reads === 2) await store.commit(batch(await store.readRevision(), [row('zz-fence', 'pending')])); return value;
    }}}));
    assert.equal(readDispatchRow((await store.load(WORK_DISPATCH_MODEL, '000-stale' as RecordId))!).state, 'claimed');
    reads = 0;
    await assert.rejects(registry.run('work.dispatch.recover', args, context('state-transition-race'), {store: {...store, query: async spec => {
      if (++reads === 2) {
        const original = (await store.load(WORK_DISPATCH_MODEL, '000-stale' as RecordId))!;
        await store.commit({...batch(await store.readRevision(), []), writes: [{kind: 'update', model: WORK_DISPATCH_MODEL, id: original.id,
          expectedVersion: original.version, row: {...original, version: (original.version + 1) as StoredRow['version'],
            data: {...original.data, state: 'uncertain'}}}]});
      }
      return store.query(spec);
    }}}));
    assert.equal(readDispatchRow((await store.load(WORK_DISPATCH_MODEL, '000-stale' as RecordId))!).state, 'uncertain');
    await assert.rejects(registry.run('work.dispatch.recover', {...args, limit: Number.MAX_SAFE_INTEGER}, context('invalid-limit'), {store}), /safe bounded lookahead/);
  } finally {await mf.dispose();}
});


test('Memory recovery preserves its published UTF16 order and rejects an oversized reader without publishing progress', async () => {
  const {store} = createTestMemoryStorage();
  await store.commit(batch(await store.readRevision(), [row('u-\uE000', 'uncertain'), row('u-\u{10000}', 'claimed')]));
  const first = (await registry.run('work.dispatch.recover', args, context('utf16-first'), {store})).result as RecoveryResult;
  assert.equal(first.resumeAfter, 'u-\u{10000}'); assert.deepEqual(first.uncertain, []); assert.equal(first.uncertainTruncated, true);
  const second = (await registry.run('work.dispatch.recover', {...args, resumeAfter: first.resumeAfter}, context('utf16-second'), {store})).result as RecoveryResult;
  assert.equal(second.done, true); assert.deepEqual(second.uncertain, ['u-\uE000']);
  const revision = await store.readRevision();
  await assert.rejects(registry.run('work.dispatch.recover', args, context('oversized'), {store: {...store,
    query: async () => [row('a', 'claimed'), row('b', 'claimed'), row('c', 'claimed')],
  }}), /exceeded its bounded window/);
  assert.equal(await store.readRevision(), revision);
  await assert.rejects(registry.run('work.dispatch.recover', args, context('foreign-state'), {store: {...store,
    query: async () => [row('a', 'pending')],
  }}), /foreign lifecycle state/);
  assert.equal(await store.readRevision(), revision);
});
