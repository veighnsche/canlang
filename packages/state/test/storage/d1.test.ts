/**
 * D1 storage tests: full conformance against a REAL local D1 database
 * (miniflare), plus D1-specific proofs that the transactional batch — not
 * adapter logic — provides atomicity.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import {
  StorageConstraintError,
  FenceConflictError,
  asId,
  asModel,
  asOperation,
  asRevision,
  asVersion,
  captureFailure,
  expectFenceConflict,
  makeBatch,
  makeHistory,
  makeIntent,
  makeReceipt,
  makeRow,
  storageConformance,
  type ConformanceProbe,
  type ConformanceSetup,
} from './conformance.js';
// Adjustment point: worker A's actual D1 module location/signatures.
import { createD1Storage, ensureSchema } from '../../src/storage/d1.js';
import { createD1OwnerRouter, type TrustedD1OwnerBinding } from '../../src/storage/owner-router.js';

let mf: Miniflare | undefined;
let db: D1Database;

/** All data tables; fence/fence_log are reset separately below. */
const TABLES = [
  'records',
  'history',
  'receipts',
  'outbox',
  'schedules',
  'unique_claims',
  'snapshots',
  'migration_staging',
  'migration_progress',
  'migration_outcomes',
];

async function resetD1(): Promise<void> {
  await db.batch([
    ...TABLES.map((table) => db.prepare(`DELETE FROM ${table}`)),
    // fence_log must clear too: committed revisions 1..N would collide with
    // the post-reset fence assertion INSERT on the next commit.
    db.prepare('DELETE FROM fence_log'),
    db.prepare('UPDATE fence SET revision = 0 WHERE id = 1'),
  ]);
}

function d1Probe(): ConformanceProbe {
  return {
    async historyFor(model, recordId) {
      const rows = await db
        .prepare('SELECT * FROM history WHERE model = ? AND record_id = ? ORDER BY seq')
        .bind(model as string, recordId as string)
        .all();
      return (rows.results as unknown as Array<Record<string, unknown>>).map((row) => ({
        model: row['model'],
        recordId: row['record_id'],
        version: row['version'],
        operation: row['operation'],
        operationId: row['operation_id'],
        actor: row['actor'],
        at: row['at'],
        change: row['change'],
        before: row['before'] === null ? null : JSON.parse(row['before'] as string),
        after: row['after'] === null ? null : JSON.parse(row['after'] as string),
      })) as unknown as Awaited<ReturnType<ConformanceProbe['historyFor']>>;
    },
    async outboxAll() {
      const rows = await db.prepare('SELECT * FROM outbox ORDER BY intent_id').all();
      return (rows.results as unknown as Array<Record<string, unknown>>).map((row) => ({
        intentId: row['intent_id'],
        operation: row['operation'],
        operationId: row['operation_id'],
        target: row['target'],
        arguments:
          row['arguments'] === null ? {} : JSON.parse(row['arguments'] as string),
        occurrenceIndex: row['occurrence_index'],
        ...(row['dispatch_guard'] === null || row['dispatch_guard'] === undefined
          ? {}
          : { dispatchGuard: row['dispatch_guard'] }),
      })) as unknown as Awaited<ReturnType<ConformanceProbe['outboxAll']>>;
    },
    async scheduleGet(key) {
      const row = await db
        .prepare('SELECT * FROM schedules WHERE "key" = ?')
        .bind(key)
        .first();
      if (row === null || row === undefined) return null;
      const rec = row as unknown as Record<string, unknown>;
      return {
        key: rec['key'],
        at: rec['at'],
        event: rec['event'],
        payload: JSON.parse(rec['payload'] as string),
      } as unknown as Awaited<ReturnType<ConformanceProbe['scheduleGet']>>;
    },
  };
}

before(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: ['DB'],
  });
  db = await mf.getD1Database('DB');
  await ensureSchema(db);
});

after(async () => {
  if (mf !== undefined) {
    await mf.dispose();
    mf = undefined;
  }
});

async function d1Setup(): Promise<ConformanceSetup> {
  return { store: createD1Storage(db), reset: resetD1, probe: d1Probe() };
}

storageConformance('d1', d1Setup);

describe('d1 adapter proofs', () => {
  it('REAL BATCH ROLLBACK: a failing raw batch persists nothing', async () => {
    await resetD1();
    const batch: Array<ReturnType<D1Database['prepare']>> = [
      db.prepare(
        'INSERT INTO records (model, id, version, created, updated, created_by, updated_by, archived_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind('t.Doc', 'raw-1', 1, 1000, 1000, 'u', 'u', null, '{}'),
      db.prepare(
        'INSERT INTO history (model, record_id, version, operation, operation_id, actor, at, change, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind('t.Doc', 'raw-1', 1, 't.op', 'op-raw', 'u', 1000, 'create', null, '{}'),
      // Deliberate PK violation: same (model, id) twice in one batch.
      db.prepare(
        'INSERT INTO records (model, id, version, created, updated, created_by, updated_by, archived_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind('t.Doc', 'raw-1', 1, 1000, 1000, 'u', 'u', null, '{}'),
    ];
    const failure = await captureFailure(db.batch(batch));
    assert.ok(failure !== null && failure !== undefined);
    const probe = d1Probe();
    assert.equal(
      await db
        .prepare('SELECT COUNT(*) AS n FROM records WHERE model = ? AND id = ?')
        .bind('t.Doc', 'raw-1')
        .first('n'),
      0,
    );
    assert.deepEqual(await probe.historyFor(asModel('t.Doc'), asId('raw-1')), []);
    assert.equal(await db.prepare('SELECT revision AS r FROM fence WHERE id = 1').first('r'), 0);
  });

  it('FENCE RACE: two concurrent adapters on one DB commit exactly one winner', async () => {
    await resetD1();
    const storeA = createD1Storage(db);
    const storeB = createD1Storage(db);
    assert.equal(await storeA.readRevision(), 0);
    assert.equal(await storeB.readRevision(), 0);
    const receiptA = makeReceipt({ operationId: 'op-race-a', committedRevision: 1 });
    const batchA = makeBatch(0, {
      writes: [
        {
          kind: 'insert',
          model: asModel('t.Doc'),
          row: makeRow({ id: 'race-a', data: { side: 'a' } }),
        },
      ],
      history: [makeHistory({ model: 't.Doc', recordId: 'race-a', operationId: 'op-race-a' })],
      receipt: receiptA,
      outbox: [makeIntent({ intentId: 'intent-race-a', operationId: 'op-race-a' })],
      schedules: [
        {
          op: 'replace',
          key: 'race-key-a',
          at: 1_700_000_010_000,
          event: asOperation('t.due'),
          payload: {},
        },
      ],
    });
    const receiptB = makeReceipt({ operationId: 'op-race-b', committedRevision: 1 });
    const batchB = makeBatch(0, {
      writes: [
        {
          kind: 'insert',
          model: asModel('t.Doc'),
          row: makeRow({ id: 'race-b', data: { side: 'b' } }),
        },
      ],
      history: [makeHistory({ model: 't.Doc', recordId: 'race-b', operationId: 'op-race-b' })],
      receipt: receiptB,
      outbox: [makeIntent({ intentId: 'intent-race-b', operationId: 'op-race-b' })],
      schedules: [
        {
          op: 'replace',
          key: 'race-key-b',
          at: 1_700_000_010_000,
          event: asOperation('t.due'),
          payload: {},
        },
      ],
    });
    // Fire both commits without awaiting: both hold expected revision 0, so
    // exactly one fence INSERT can win.
    const [settledA, settledB] = await Promise.allSettled([
      storeA.commit(batchA),
      storeB.commit(batchB),
    ]);
    const fulfilled = [settledA, settledB].filter((r) => r.status === 'fulfilled');
    const rejected = [settledA, settledB].filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    expectFenceConflict((rejected[0] as PromiseRejectedResult).reason, 0, 1);
    assert.equal(await storeA.readRevision(), 1);
    assert.equal(await storeB.readRevision(), 1);
    // The winner is nondeterministic; assert winner-present/loser-absent
    // dynamically for rows, receipts, history, outbox, and schedules.
    const aWon = settledA.status === 'fulfilled';
    const winner = aWon
      ? { row: 'race-a', receipt: receiptA, intent: 'intent-race-a', key: 'race-key-a' }
      : { row: 'race-b', receipt: receiptB, intent: 'intent-race-b', key: 'race-key-b' };
    const loser = aWon
      ? { row: 'race-b', receipt: receiptB, intent: 'intent-race-b', key: 'race-key-b' }
      : { row: 'race-a', receipt: receiptA, intent: 'intent-race-a', key: 'race-key-a' };
    assert.ok((await storeA.load(asModel('t.Doc'), asId(winner.row))) !== null);
    assert.equal(await storeB.load(asModel('t.Doc'), asId(loser.row)), null);
    assert.deepEqual(await storeA.readReceipt(winner.receipt.identity), winner.receipt);
    assert.equal(await storeB.readReceipt(loser.receipt.identity), null);
    const probe = d1Probe();
    assert.deepEqual(await probe.historyFor(asModel('t.Doc'), asId(loser.row)), []);
    assert.deepEqual(
      (await probe.outboxAll()).map((intent) => intent.intentId),
      [winner.intent],
    );
    assert.equal(await probe.scheduleGet(loser.key), null);
    assert.ok((await probe.scheduleGet(winner.key)) !== null);
  });

  it('same-batch duplicate insert aborts the whole adapter batch', async () => {
    await resetD1();
    const store = createD1Storage(db);
    const receipt = makeReceipt({ operationId: 'op-samebatch-1', committedRevision: 1 });
    const failed = await captureFailure(
      store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('t.Doc'),
              row: makeRow({ id: 'sb-1', data: { n: 1 } }),
            },
            {
              kind: 'insert',
              model: asModel('t.Doc'),
              row: makeRow({ id: 'sb-1', data: { n: 2 } }),
            },
          ],
          history: [makeHistory({ model: 't.Doc', recordId: 'sb-1' })],
          receipt,
          outbox: [makeIntent({ intentId: 'intent-sb-1' })],
        }),
      ),
    );
    assert.ok(
      failed instanceof StorageConstraintError,
      `expected StorageConstraintError, got ${String(failed)}`,
    );
    assert.equal(await store.readRevision(), 0);
    assert.equal(await store.load(asModel('t.Doc'), asId('sb-1')), null);
    assert.equal(await store.readReceipt(receipt.identity), null);
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM fence_log').first('n'), 0);
    const probe = d1Probe();
    assert.deepEqual(await probe.historyFor(asModel('t.Doc'), asId('sb-1')), []);
    assert.deepEqual(await probe.outboxAll(), []);
  });
});


it('routes fresh pinned owner D1 stores and refuses aliases and unassigned legacy state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-owner-d1-'));
  const options = {
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { A: 'owner-a', ALIAS: 'owner-a', B: 'owner-b',
      LEGACY: 'legacy', HISTORY: 'history', WORK: 'work', MIGRATION: 'migration', EMPTY: 'empty', PIN_RACE: 'pin-race', UNKNOWN: 'unknown' },
    d1Persist: directory,
  };
  let host = new Miniflare(options);
  try {
    const a = await host.getD1Database('A');
    const alias = await host.getD1Database('ALIAS');
    const b = await host.getD1Database('B');
    assert.notEqual(a, alias); // Separate JS bindings, one physical database.
    const routes = new Map<string, TrustedD1OwnerBinding>([
      ['team-a', { app: 'shop', owner: 'team-a', db: a, initializeFresh: true }],
      ['team-b', { app: 'shop', owner: 'team-b', db: b, initializeFresh: true }],
    ]);
    const router = createD1OwnerRouter({ resolveBinding: scope => routes.get(scope.owner) ?? null });
    await assert.rejects(router.ownerScopedStoragePort({ app: 'shop', owner: 'missing' }), /no trusted binding/);
    await assert.rejects(router.ownerScopedStoragePort({ app: 'other-app', owner: 'team-a' }), /trusted route.*mismatch/);
    const mutableScope = { app: 'shop', owner: 'team-a' };
    const delayed = createD1OwnerRouter({ resolveBinding: async scope => {
      await Promise.resolve();
      return routes.get(scope.owner) ?? null;
    } });
    const captured = delayed.ownerScopedStoragePort(mutableScope);
    mutableScope.app = 'other-app';
    mutableScope.owner = 'team-b';
    assert.equal(await (await captured).readRevision(), 1);
    const storeA = await router.ownerScopedStoragePort({ app: 'shop', owner: 'team-a' });
    const storeB = await router.ownerScopedStoragePort({ app: 'shop', owner: 'team-b' });
    assert.equal(await storeA.readRevision(), 1);
    routes.set('alias', { app: 'shop', owner: 'alias', db: alias, initializeFresh: true });
    await assert.rejects(router.ownerScopedStoragePort({ app: 'shop', owner: 'alias' }), /persisted.*mismatch/);
    const wrongApp = createD1OwnerRouter({ resolveBinding: scope => ({ ...scope, db: alias, initializeFresh: true }) });
    await assert.rejects(wrongApp.ownerScopedStoragePort({ app: 'other-app', owner: 'team-a' }), /persisted.*mismatch/);
    const aliasRouter = createD1OwnerRouter({ resolveBinding: scope => ({ ...scope, db: alias }) });
    const secondA = await aliasRouter.ownerScopedStoragePort({ app: 'shop', owner: 'team-a' });
    for (const [owner, store] of [['team-a', storeA], ['team-b', storeB]] as const) {
      const receipt = makeReceipt({ app: 'shop', owner, operationId: 'same-op', committedRevision: 2 });
      await store.commit(makeBatch(1, {
        writes: [
          { kind: 'insert', model: asModel('shop.Doc'), row: makeRow({ id: 'parent', data: { owner } }) },
          { kind: 'insert', model: asModel('shop.Doc'), row: {
            ...makeRow({ id: 'same-id', data: { owner } }), parent: { model: asModel('shop.Doc'), id: asId('parent') },
          } },
        ],
        history: [makeHistory({ model: 'shop.Doc', recordId: 'same-id', after: { owner } })],
        receipt,
        outbox: [makeIntent({ intentId: 'same-intent', operationId: 'same-op' })],
        schedules: [{ op: 'replace', key: 'same-key', at: 10, event: asOperation('shop.due'), payload: { owner } }],
        uniqueClaims: [{ model: asModel('shop.Doc'), keyName: 'code', keyValue: 'same-value', recordId: asId('same-id') }],
      }));
      assert.equal((await store.load(asModel('shop.Doc'), asId('same-id')))?.data['owner'], owner);
      assert.deepEqual((await store.query({ model: asModel('shop.Doc'), parent: { model: asModel('shop.Doc'), id: asId('parent') }, authority: 'owner', limit: 1 })).map(row => row.id), ['same-id']);
      assert.deepEqual(await store.readReceipt(receipt.identity), receipt);
      assert.deepEqual((await store.historyFor(asModel('shop.Doc'), asId('same-id')))[0]?.after, { owner });
      assert.deepEqual((await store.schedulesDue(10, 1))[0]?.payload, { owner });
      await store.stageMigrationRows({ expectedRevision: asRevision(2), migrationId: 'same-migration',
        rows: [{ targetModel: asModel('shop.Next'), recordId: asId('same-id'), version: asVersion(1), data: { owner }, parent: null, converted: true }],
        progress: { migrationId: 'same-migration', phase: 'staging', stagedCursor: null, publishCursor: null, updatedRevision: asRevision(3) },
      });
      assert.deepEqual((await store.readStagedRows('same-migration', null, 1))[0]?.data, { owner });
    }
    await storeA.commit({ ...makeBatch(3), outboxAck: ['same-intent'] });
    assert.deepEqual(await storeA.outboxPending(), []);
    assert.equal((await storeB.outboxPending())[0]?.intentId, 'same-intent');
    await storeA.discardStagedRows({ expectedRevision: asRevision(4), migrationId: 'same-migration' });
    assert.equal(await storeA.readMigrationProgress('same-migration'), null);
    assert.notEqual(await storeB.readMigrationProgress('same-migration'), null);
    const revision = await storeA.readRevision();
    const foreignReceipt = makeReceipt({ app: 'shop', owner: 'team-b', operationId: 'foreign' });
    await assert.rejects(storeA.readReceipt(foreignReceipt.identity), /receipt.*mismatch/);
    await assert.rejects(storeA.commit(makeBatch(revision as number, { receipt: foreignReceipt,
      writes: [{ kind: 'insert', model: asModel('shop.Doc'), row: makeRow({ id: 'foreign' }) }],
    })), /receipt.*mismatch/);
    const foreignApp = makeReceipt({ app: 'other-app', owner: 'team-a', operationId: 'foreign-app' });
    await assert.rejects(storeA.readReceipt(foreignApp.identity), /receipt.*mismatch/);
    await assert.rejects(storeA.commit(makeBatch(revision as number, { receipt: foreignApp })), /receipt.*mismatch/);
    assert.equal(await storeA.readRevision(), revision);
    assert.equal(await storeA.load(asModel('shop.Doc'), asId('foreign')), null);
    await assert.rejects(storeA.commit(makeBatch(revision as number, { writes: [
      { kind: 'insert', model: asModel('shop.Doc'), row: makeRow({ id: 'rollback' }) },
      { kind: 'insert', model: asModel('shop.Doc'), row: makeRow({ id: 'same-id' }) },
    ] })), StorageConstraintError);
    assert.equal(await storeA.load(asModel('shop.Doc'), asId('rollback')), null);
    assert.equal(await storeA.readRevision(), revision);
    await assert.rejects(storeA.commit(makeBatch(revision as number, { writes: [{
      kind: 'update', model: asModel('shop.Doc'), id: asId('same-id'), expectedVersion: asVersion(999),
      row: makeRow({ id: 'same-id' }),
    }] })), /version mismatch/);
    const race = await Promise.allSettled([storeA.commit(makeBatch(revision as number)), secondA.commit(makeBatch(revision as number))]);
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
    const loser = race.find(result => result.status === 'rejected');
    assert.ok(loser?.status === 'rejected' && loser.reason instanceof FenceConflictError);
    for (const [name, sql] of [
      ['LEGACY', "INSERT INTO records(model,id,version,created,updated,created_by,updated_by,data) VALUES ('shop.Doc','old',1,1,1,'u','u','{}')"],
      ['HISTORY', "INSERT INTO history(model,record_id,version,operation,operation_id,actor,at,change) VALUES ('shop.Doc','old',1,'shop.op','old-op','u',1,'remove')"],
      ['WORK', "INSERT INTO schedules(\"key\",at,event,payload) VALUES ('old',1,'shop.due','{}')"],
      ['MIGRATION', "INSERT INTO migration_progress(migration_id,phase,updated_revision) VALUES ('old','staging',0)"],
    ] as const) {
      const legacy = await host.getD1Database(name);
      await ensureSchema(legacy);
      await legacy.exec(sql);
      const denied = createD1OwnerRouter({ resolveBinding: scope => ({ ...scope, db: legacy, initializeFresh: true }) });
      await assert.rejects(denied.ownerScopedStoragePort({ app: 'shop', owner: 'team-a' }), /legacy/);
      assert.equal(await createD1Storage(legacy).readRevision(), 0);
      assert.equal(await legacy.prepare("SELECT name FROM sqlite_master WHERE name = 'state_owner_pin'").first(), null);
    }
    const racedDb = await host.getD1Database('PIN_RACE');
    const racedBinding = new Proxy(racedDb, { get(target, key) {
      if (key === 'batch') return async (statements: Parameters<D1Database['batch']>[0]) => {
        await target.exec("INSERT INTO schedules(\"key\",at,event,payload) VALUES ('late',1,'shop.due','{}')");
        return target.batch(statements);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const raceRouter = createD1OwnerRouter({ resolveBinding: scope => ({ ...scope, db: racedBinding, initializeFresh: true }) });
    await assert.rejects(raceRouter.ownerScopedStoragePort({ app: 'shop', owner: 'team-a' }), /fresh assignment failed/);
    assert.equal(await createD1Storage(racedDb).readRevision(), 0);
    assert.equal(await racedDb.prepare('SELECT 1 FROM state_owner_pin').first(), null);
    assert.equal(await racedDb.prepare('SELECT 1 FROM fence_log').first(), null);
    assert.notEqual(await createD1Storage(racedDb).scheduleGet('late'), null);
    const unknown = await host.getD1Database('UNKNOWN');
    await unknown.exec('CREATE TABLE legacy_unknown (value TEXT)');
    const unknownRouter = createD1OwnerRouter({ resolveBinding: scope => ({ ...scope, db: unknown, initializeFresh: true }) });
    await assert.rejects(unknownRouter.ownerScopedStoragePort({ app: 'shop', owner: 'team-a' }), /unknown legacy schema/);
    assert.equal(await unknown.prepare("SELECT name FROM sqlite_master WHERE name = 'fence'").first(), null);
    const empty = await host.getD1Database('EMPTY');
    const unassigned = createD1OwnerRouter({ resolveBinding: scope => ({ ...scope, db: empty }) });
    await assert.rejects(unassigned.ownerScopedStoragePort({ app: 'shop', owner: 'team-a' }), /explicit verified fresh/);
    assert.equal(await empty.prepare("SELECT name FROM sqlite_master WHERE name = 'fence'").first(), null);
    const beforeReopen = await storeA.readRevision();
    await host.dispose();
    host = new Miniflare(options);
    const reopenedBinding = await host.getD1Database('A');
    const reopened = createD1OwnerRouter({ resolveBinding: scope => ({ ...scope, db: reopenedBinding }) });
    const restored = await reopened.ownerScopedStoragePort({ app: 'shop', owner: 'team-a' });
    assert.equal(await restored.readRevision(), beforeReopen);
    assert.equal((await restored.load(asModel('shop.Doc'), asId('same-id')))?.data['owner'], 'team-a');
    assert.equal((await restored.readReceipt(makeReceipt({ app: 'shop', owner: 'team-a', operationId: 'same-op' }).identity))?.committedRevision, 2);
    await assert.rejects(reopened.ownerScopedStoragePort({ app: 'shop', owner: 'team-b' }), /persisted.*mismatch/);
  } finally {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
