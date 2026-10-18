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
import type { ArtifactModel, CanTypeId, FileReferenceInventory, FileReferenceStoragePort,
  FileRetirementAuthority, FinalizedFileIdentity, FrameworkFileReferenceProducer, InstalledSnapshot } from '@canlang/contracts';
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
import { STATE_FILE_REFERENCE_PRODUCER } from '../../src/storage/index.js';
import { newAssociationRow, RECEIPT_ASSOCIATION_MODEL } from '../../src/receipt/tables.js';
import { stageFanoutOwnerScanWrite, FANOUT_OWNER_SCAN_MODEL } from '../../src/fanout/navigation.js';
import { loadArtifactDescriptors } from '../../src/invocation/registry.js';
import { buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { activate, validateTransition } from '../../src/migration/index.js';
import { StateError } from '../../src/errors.js';

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
  return { store: createD1Storage(db), reset: resetD1, probe: d1Probe(),
    reopen: async () => { await ensureSchema(db); return createD1Storage(db); },
  };
}

storageConformance('d1', d1Setup);

describe('d1 adapter proofs', () => {
  it('reuses only the fixed revision query while observing live changes, failures and database handles', async () => {
    await resetD1();
    const counted = () => {
      const counts = { prepare: 0, bind: 0, method: 0, execute: 0 };
      const handle = { prepare(sql: string) {
        counts.prepare++;
        assert.equal(sql, 'SELECT revision FROM fence WHERE id = ?');
        const statement = db.prepare(sql);
        return { bind(...values: unknown[]) {
          counts.bind++;
          const bound = statement.bind(...values);
          return { get first() {
            counts.method++;
            return () => { counts.execute++; return bound.first<{ revision: number }>(); };
          } };
        } };
      } } as unknown as D1Database;
      return { handle, counts };
    };
    const original = counted(), other = counted();
    const a = createD1Storage(original.handle), b = createD1Storage(original.handle);
    try {
      assert.equal(await a.readRevision(), 0);
      assert.equal(await b.readRevision(), 0);
      await db.prepare('UPDATE fence SET revision = 1 WHERE id = 1').run();
      assert.deepEqual(await Promise.all([a.readRevision(), b.readRevision()]), [1, 1]);
      assert.equal(await createD1Storage(other.handle).readRevision(), 1);
      await db.prepare('DELETE FROM fence WHERE id = 1').run();
      await assert.rejects(a.readRevision(), /fence row is missing/);
      await db.prepare('INSERT INTO fence (id, revision) VALUES (1, 2)').run();
      assert.equal(await a.readRevision(), 2, 'a failed execution does not cache its error or a stale revision');
      assert.deepEqual(original.counts, { prepare: 1, bind: 1, method: 1, execute: 6 });
      assert.deepEqual(other.counts, { prepare: 1, bind: 1, method: 1, execute: 1 });
    } finally { await resetD1(); }
  });

  it('cohort reads refuse a genuine revision race before decoding retained data', async () => {
    const model = asModel('t.CohortRace');
    const id = asId('race-row');
    const request = { model, id, expectedRevision: asRevision(1) };
    const readers = [
      (store: ReturnType<typeof createD1Storage>) => store.cohortIdentityPage({
        model, after: null, limit: 1, expectedRevision: asRevision(1),
      }),
      (store: ReturnType<typeof createD1Storage>) => store.cohortLoad(request),
      (store: ReturnType<typeof createD1Storage>) => store.cohortRowPage({
        model, fanoutId: 'race', after: null, limit: 100, expectedRevision: asRevision(1),
      }),
      (store: ReturnType<typeof createD1Storage>) => store.cohortAnchorFact(request),
    ];
    for (const read of readers) {
      await resetD1();
      const base = createD1Storage(db);
      let nested: unknown = null;
      for (let depth = 0; depth < 34; depth++) nested = { child: nested };
      const row = makeRow({ id, data: { fanoutId: 'race', nested } });
      await base.commit(makeBatch(0, { writes: [{ kind: 'insert', model, row }] }));
      let advanced = false;
      const wrap = (statement: ReturnType<D1Database['prepare']>, sql: string): ReturnType<D1Database['prepare']> =>
        new Proxy(statement, { get(target, key) {
          const value = Reflect.get(target, key);
          if (key === 'bind') return (...args: unknown[]) => wrap(Reflect.apply(value, target, args), sql);
          const selected = sql.startsWith('SELECT CASE WHEN length(CAST(id AS BLOB))') ||
            sql.startsWith('WITH selected AS') || sql.startsWith('SELECT CASE WHEN EXISTS');
          if (selected && (key === 'all' || key === 'first')) return async (...args: unknown[]) => {
            const result = await Reflect.apply(value, target, args);
            if (!advanced) {
              await base.commit(makeBatch(1));
              advanced = true;
            }
            return result;
          };
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      const raced = new Proxy(db, { get(target, key) {
        if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      await assert.rejects(read(createD1Storage(raced)), (error: unknown) =>
        error instanceof FenceConflictError && error.expected === 1 && error.actual === 2);
      assert.equal(advanced, true);
      assert.equal(await base.readRevision(), 2);
      assert.deepEqual(await base.load(model, id), { ...row, parent: null });
    }
  });

  it('legacy outbox rows remain unstamped through additive schema reopen and ack', async () => {
    await resetD1();
    await db.prepare('ALTER TABLE outbox DROP COLUMN committed_revision').run();
    assert.equal((await db.prepare('PRAGMA table_info(outbox)').all()).results.some(row => row['name'] === 'committed_revision'), false);
    const legacy = { ...makeIntent({ intentId: 'legacy-d1-outbox' }),
      dispatchGuard: 'old-allowed', handlerContract: 'shop.old-handler' };
    await db.prepare('INSERT INTO outbox (intent_id, operation, operation_id, target, arguments, occurrence_index, dispatch_guard, handler_contract, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(legacy.intentId, legacy.operation, legacy.operationId, legacy.target, JSON.stringify(legacy.arguments),
        legacy.occurrenceIndex, legacy.dispatchGuard, legacy.handlerContract, 'pending', 777).run();
    await ensureSchema(db); let store = createD1Storage(db);
    const column = (await db.prepare('PRAGMA table_info(outbox)').all()).results.find(row => row['name'] === 'committed_revision');
    assert.ok(column); assert.equal(column['notnull'], 0); assert.equal(column['dflt_value'], null);
    assert.deepEqual(await store.outboxPending(), [legacy]);
    assert.deepEqual(await store.outboxGet(legacy.intentId), { intent: legacy, status: 'pending' });
    assert.equal(await db.prepare('SELECT committed_revision FROM outbox WHERE intent_id = ?').bind(legacy.intentId).first('committed_revision'), null);
    await store.commit({ ...makeBatch(0), outboxAck: [legacy.intentId] });
    await ensureSchema(db); store = createD1Storage(db);
    assert.deepEqual(await store.outboxGet(legacy.intentId), { intent: legacy, status: 'dispatched' });
    assert.deepEqual(await store.outboxPending(), []);
    const current = makeIntent({ intentId: 'new-after-legacy-d1' });
    await store.commit(makeBatch(1, { outbox: [current], receipt: makeReceipt({ createdAt: 888, committedRevision: 2 }) }));
    await ensureSchema(db); store = createD1Storage(db);
    assert.deepEqual(await store.outboxGet(current.intentId), { intent: current, status: 'pending',
      originalCommit: { revision: asRevision(2), createdAt: 888 } });
    assert.deepEqual(await store.outboxGet(legacy.intentId), { intent: legacy, status: 'dispatched' });
    assert.equal(await db.prepare('SELECT committed_revision FROM outbox WHERE intent_id = ?').bind(legacy.intentId).first('committed_revision'), null);
  });

  it('REAL BATCH ROLLBACK: a failing raw batch persists nothing', async () => {
    await resetD1();
    const batch: Array<ReturnType<D1Database['prepare']>> = [
      db.prepare(
        'INSERT INTO records (model, id, version, created, updated, created_by, updated_by, archived_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind('t.Doc', 'raw-1', 1, 1000, 1000, 'u', 'u', null, '{}'),
      db.prepare(
        'INSERT INTO history (model, record_id, version, operation, operation_id, actor, at, change, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind('t.Doc', 'raw-1', 1, 't.op', 'op-raw', 'u', 1000, 'create', null, '{}'),
      db.prepare('INSERT INTO outbox (intent_id, operation, operation_id, target, arguments, occurrence_index, status, created_at, committed_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind('raw-rollback-outbox', 't.op', 'op-raw', 'mail.send', '{}', 0, 'pending', 1000, 1),
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
    assert.equal(await createD1Storage(db).outboxGet('raw-rollback-outbox'), null);
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


it('rechecks concurrently assigned owner pins after null or missing pin reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-owner-pin-read-race-'));
  const host = new Miniflare({ modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { NULL_SAME: 'null-same', NULL_OWNER: 'null-owner', NULL_APP: 'null-app',
      MISSING_SAME: 'missing-same', MISSING_OWNER: 'missing-owner', MISSING_APP: 'missing-app' },
    d1Persist: directory });
  try {
    const requested = { app: 'shop', owner: 'team-a' };
    for (const [name, initialPinTable, concurrentScope] of [
      ['NULL_SAME', true, requested],
      ['NULL_OWNER', true, { app: 'shop', owner: 'team-b' }],
      ['NULL_APP', true, { app: 'other-app', owner: 'team-a' }],
      ['MISSING_SAME', false, requested],
      ['MISSING_OWNER', false, { app: 'shop', owner: 'team-b' }],
      ['MISSING_APP', false, { app: 'other-app', owner: 'team-a' }],
    ] as const) {
      const database = await host.getD1Database(name);
      await ensureSchema(database);
      if (initialPinTable) await database.exec('CREATE TABLE state_owner_pin (id INTEGER PRIMARY KEY CHECK(id = 1), app TEXT NOT NULL, owner TEXT NOT NULL)');
      const concurrent = createD1OwnerRouter({ resolveBinding: scope => ({ ...scope, db: database, initializeFresh: true }) });
      let assigned = false;
      const inspected = new Proxy(database, { get(target, key) {
        if (key === 'prepare') return (sql: string) => {
          const statement = target.prepare(sql);
          const selected = initialPinTable ? sql === 'SELECT app, owner FROM state_owner_pin WHERE id = 1' :
            sql.startsWith("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name");
          if (!selected) return statement;
          return new Proxy(statement, { get(prepared, method) {
            const value = Reflect.get(prepared, method);
            if (method === (initialPinTable ? 'first' : 'all')) return async (...args: unknown[]) => {
              const result = await Reflect.apply(value, prepared, args);
              if (!assigned) {
                if (initialPinTable) assert.equal(result, null);
                assigned = true;
                const store = await concurrent.ownerScopedStoragePort(concurrentScope);
                // A newly assigned worker can already have retained State data.
                await store.commit(makeBatch(1, { writes: [{ kind: 'insert', model: asModel('shop.Doc'),
                  row: makeRow({ id: 'concurrent' }) }] }));
              }
              return result;
            };
            return typeof value === 'function' ? value.bind(prepared) : value;
          } });
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const router = createD1OwnerRouter({ resolveBinding: scope => ({ ...scope, db: inspected, initializeFresh: true }) });
      if (concurrentScope.app === requested.app && concurrentScope.owner === requested.owner) {
        const store = await router.ownerScopedStoragePort(requested);
        assert.equal(await store.readRevision(), 2);
        assert.notEqual(await store.load(asModel('shop.Doc'), asId('concurrent')), null);
      } else {
        await assert.rejects(router.ownerScopedStoragePort(requested), /persisted app\/owner pin mismatch/);
      }
      assert.equal(assigned, true);
      assert.deepEqual(await database.prepare('SELECT app, owner FROM state_owner_pin WHERE id = 1').first(), concurrentScope);
      assert.equal(await createD1Storage(database).readRevision(), 2);
    }
  } finally {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
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
      assert.equal(await store.uniqueOwner!(asModel('shop.Doc'), 'code', 'same-value'), null);
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
        uniqueClaims: [
          { model: asModel('shop.Doc'), keyName: 'code', keyValue: 'same-value', recordId: asId('same-id') },
          { model: asModel('shop.Doc'), keyName: 'owner-code', keyValue: owner, recordId: asId('same-id') },
        ],
      }));
      assert.equal(await store.uniqueOwner!(asModel('shop.Doc'), 'code', 'same-value'), asId('same-id'));
      assert.equal(await store.uniqueOwner!(asModel('shop.Doc'), 'owner-code', owner), asId('same-id'));
      assert.equal(await store.uniqueOwner!(asModel('shop.Doc'), 'owner-code', owner === 'team-a' ? 'team-b' : 'team-a'), null);
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


describe('D1 owning router File bindings', () => {
  const scope = { app: 'documents', owner: 'team-a' };
  const authority: FileRetirementAuthority = { app: scope.app, stateOwner: 'Documents',
    stateStoreId: 'routed-state', fileStoreId: 'routed-files',
    receiver: { app: scope.app, team: 'team-a', owner: scope.owner } };
  const model = asModel('Documents.Record');
  const snapshot: InstalledSnapshot = { owner: 'Documents', snapshotId: 'router-old', digest: 'router-old-digest',
    installedRevision: asRevision(0), installedAt: 100 };
  function inventory(target = false): FileReferenceInventory {
    const artifactModels: ArtifactModel[] = [{ name: model, deleteMode: 'archive', fields: [
      { name: 'attachment', field: { kind: 'file' }, valueType: 'file' as CanTypeId, required: false, serverOnly: false },
      { name: 'label', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: false, serverOnly: false },
    ] }];
    const valueTypes = { contracts: [] };
    const loaded = loadArtifactDescriptors({ artifact_version: 1, models: artifactModels, operations: [], valueTypes }, { by: 'members' });
    return { owner: snapshot.owner, snapshotId: target ? 'router-new' : snapshot.snapshotId,
      digest: target ? 'router-new-digest' : snapshot.digest, canonicalModels: loaded.models, artifactModels, valueTypes,
      frameworkModels: STATE_FILE_REFERENCE_PRODUCER.models };
  }
  function file(ref = 'router-orphan'): FinalizedFileIdentity {
    return { ref, receiver: { ...authority.receiver, principal: 'alice' },
      provenance: { kind: 'event', source: 'documents.mail', adapter: 'documents.mail',
        occurrenceId: 'router-delivery', fieldPath: 'attachments', itemIndex: 0 },
      contentType: 'text/plain', sizeBytes: 4, bytesDigest: 'sha256-router', finalizedAtMs: 1_000 };
  }
  function retirement(revision: number, declarations = inventory(), ref = 'router-orphan') {
    return { expectedRevision: asRevision(revision),
      inventory: { owner: declarations.owner, snapshotId: declarations.snapshotId, digest: declarations.digest },
      file: file(ref), disposition: 'orphaned' as const, retention: { unattachedHorizonMs: 100, retentionMs: 500 },
      atMs: 1_100, maxRows: 20, maxReferences: 100 };
  }
  async function install(store: FileReferenceStoragePort, declarations = inventory()) {
    await store.installFileReferenceInventory({ expectedRevision: await store.readRevision(), authority,
      snapshot: { ...snapshot, owner: declarations.owner, snapshotId: declarations.snapshotId, digest: declarations.digest },
      inventory: declarations });
  }
  // One coherent observation checks that refusals leave the actual D1 effects intact.
  async function checkpoint(database: D1Database) {
    return (await database.batch([
      database.prepare('SELECT revision FROM fence WHERE id = 1'),
      database.prepare('SELECT model, id, data FROM records ORDER BY model, id'),
      database.prepare('SELECT "key", payload FROM schedules ORDER BY "key"'),
      database.prepare('SELECT COUNT(*) AS count FROM fence_log'),
      database.prepare('SELECT installed FROM file_reference_inventories ORDER BY owner'),
      database.prepare('SELECT retirement FROM file_retirements ORDER BY ref'),
      database.prepare('SELECT phase, updated_revision FROM migration_progress ORDER BY migration_id'),
    ])).map(result => result.results);
  }

  it('captures trusted decisions before inspection and preserves genuine controls and retirement after physical reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-owner-file-d1-'));
    const options = { modules: true, script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { A: 'owner-file', ALIAS: 'owner-file', OTHER: 'other-file' }, d1Persist: directory };
    let host = new Miniflare(options);
    try {
      const database = await host.getD1Database('A'), other = await host.getD1Database('OTHER');
      let releaseInspection!: () => void, inspectionStarted!: () => void;
      const paused = new Promise<void>(resolve => { releaseInspection = resolve; });
      const started = new Promise<void>(resolve => { inspectionStarted = resolve; });
      let firstInspection = true;
      const delayedDatabase = new Proxy(database, { get(target, key) {
        if (key === 'prepare') return (sql: string) => {
          const statement = target.prepare(sql);
          if (firstInspection && sql.includes('sqlite_master')) {
            firstInspection = false;
            return new Proxy(statement, { get(prepared, method) {
              if (method === 'all') return async () => {
                inspectionStarted(); await paused; return prepared.all();
              };
              const member = Reflect.get(prepared, method);
              return typeof member === 'function' ? member.bind(prepared) : member;
            } });
          }
          return statement;
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const mutableAuthority = { ...authority, receiver: { ...authority.receiver } };
      const producers: FrameworkFileReferenceProducer[] = [STATE_FILE_REFERENCE_PRODUCER];
      const route = { ...scope, db: delayedDatabase, initializeFresh: true as const,
        fileRetirementAuthority: mutableAuthority, fileReferenceProducers: producers };
      const router = createD1OwnerRouter({ resolveBinding: () => route });
      const opening = router.ownerScopedStoragePort(scope);
      await started;
      mutableAuthority.app = 'foreign'; mutableAuthority.receiver.app = 'foreign';
      mutableAuthority.receiver.owner = 'foreign'; mutableAuthority.fileStoreId = 'foreign-files';
      producers.length = 0; route.db = other; delete (route as { initializeFresh?: true }).initializeFresh;
      releaseInspection();
      const store = await opening;
      assert.equal(await store.readRevision(), 1);
      assert.deepEqual(store.fileRetirementAuthority, authority);
      assert.equal(await other.prepare("SELECT name FROM sqlite_master WHERE name = 'fence'").first(), null);
      await install(store);
      const association = newAssociationRow({ recordModel: model, recordId: 'row', field: 'delivery',
        deliveryId: 'router-delivery', source: 'Documents.send', revision: 0 }, { nowMs: 100, actor: 'alice' });
      const scan = stageFanoutOwnerScanWrite({ owner: scope.owner, row: null, visitedIntentRow: null,
        meta: { nowMs: 100, actor: 'alice' } });
      assert.equal(scan.kind, 'insert');
      if (scan.kind !== 'insert') throw new Error('expected owning owner-scan insert');
      await store.commit(makeBatch(2, { writes: [
        { kind: 'insert', model, row: makeRow({ id: 'row', data: { attachment: { id: 'router-live' } } }) },
        { kind: 'insert', model: asModel(RECEIPT_ASSOCIATION_MODEL), row: association }, scan,
      ] }));
      assert.deepEqual(await store.load(asModel(RECEIPT_ASSOCIATION_MODEL), association.id), association);
      assert.deepEqual(await store.load(asModel(FANOUT_OWNER_SCAN_MODEL), scan.row.id), scan.row);
      const beforeRetirement = await checkpoint(database);
      await assert.rejects(store.retireFinalizedFile(retirement(3, inventory(), 'router-live')), StorageConstraintError);
      assert.deepEqual(await checkpoint(database), beforeRetirement);
      const fact = await store.retireFinalizedFile(retirement(3));
      assert.equal(fact.retiredRevision, 4);
      const alias = await host.getD1Database('ALIAS');
      const sameOwner = await createD1OwnerRouter({ resolveBinding: () => ({ ...scope, db: alias,
        fileRetirementAuthority: authority, fileReferenceProducers: [STATE_FILE_REFERENCE_PRODUCER] }) }).ownerScopedStoragePort(scope);
      const beforeMismatch = await checkpoint(database);
      const foreignReceipt = makeReceipt({ app: scope.app, owner: 'team-b', operationId: 'routed-foreign' });
      await assert.rejects(store.readReceipt(foreignReceipt.identity), /receipt.*mismatch/);
      await assert.rejects(store.commit(makeBatch(4, { receipt: foreignReceipt, writes: [
        { kind: 'insert', model, row: makeRow({ id: 'foreign-receipt', data: {} }) },
      ] })), /receipt.*mismatch/);
      assert.deepEqual(await checkpoint(database), beforeMismatch);
      const race = await Promise.allSettled([store.commit(makeBatch(4)), sameOwner.commit(makeBatch(4))]);
      assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
      const loser = race.find(result => result.status === 'rejected');
      assert.ok(loser?.status === 'rejected' && loser.reason instanceof FenceConflictError);
      await host.dispose(); host = new Miniflare(options);
      const reopenedDb = await host.getD1Database('A');
      const reopen = (binding: FileRetirementAuthority = authority, boundProducers: readonly FrameworkFileReferenceProducer[] = [STATE_FILE_REFERENCE_PRODUCER]) =>
        createD1OwnerRouter({ resolveBinding: () => ({ ...scope, db: reopenedDb,
          fileRetirementAuthority: binding, fileReferenceProducers: boundProducers }) }).ownerScopedStoragePort(scope);
      const restored = await reopen();
      assert.equal(await restored.readRevision(), 5);
      assert.deepEqual((await restored.readFileReferenceInventory(snapshot.owner))?.inventory, inventory());
      assert.deepEqual(await restored.load(asModel(FANOUT_OWNER_SCAN_MODEL), scan.row.id), scan.row);
      assert.deepEqual(await restored.readFinalizedFileRetirement(file().ref), fact);
      assert.deepEqual(await restored.retireFinalizedFile(retirement(3)), fact);
      const beforeRefusals = await checkpoint(reopenedDb);
      for (const denied of [() => reopen(authority, []), () => reopen({ ...authority, fileStoreId: 'other-files' })]) {
        await assert.rejects(async () => { const port = await denied(); await port.readFileReferenceInventory(snapshot.owner); }, StorageConstraintError);
        await assert.rejects(async () => { const port = await denied(); await port.commit(makeBatch(5, { writes: [
          { kind: 'insert', model, row: makeRow({ id: 'missing-binding', data: {} }) },
        ], schedules: [{ op: 'replace', key: 'missing-binding', at: 1, event: asOperation('Documents.due'), payload: {} }] })); }, StorageConstraintError);
      }
      const unbound = createD1OwnerRouter({ resolveBinding: () => ({ ...scope, db: reopenedDb }) });
      await assert.rejects(async () => { const port = await unbound.ownerScopedStoragePort(scope);
        await port.commit(makeBatch(5)); }, StorageConstraintError);
      assert.deepEqual(await checkpoint(reopenedDb), beforeRefusals);
      assert.equal(await restored.load(model, asId('missing-binding')), null);
      assert.equal(await restored.scheduleGet('missing-binding'), null);
    } finally { await host.dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  it('refuses authority app and receiver-owner mismatch before initializing a fresh route', async () => {
    const host = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: ['APP', 'OWNER'] });
    try {
      for (const [name, foreign] of [
        ['APP', { ...authority, app: 'other-app', receiver: { ...authority.receiver, app: 'other-app' } }],
        ['OWNER', { ...authority, receiver: { ...authority.receiver, owner: 'other-owner' } }],
      ] as const) {
        const database = await host.getD1Database(name);
        const router = createD1OwnerRouter({ resolveBinding: () => ({ ...scope, db: database, initializeFresh: true,
          fileRetirementAuthority: foreign, fileReferenceProducers: [STATE_FILE_REFERENCE_PRODUCER] }) });
        await assert.rejects(router.ownerScopedStoragePort(scope), /File assignment app\/owner mismatch/);
        assert.equal(await database.prepare("SELECT name FROM sqlite_master WHERE name IN ('fence', 'state_owner_pin')").first(), null);
      }
    } finally { await host.dispose(); }
  });

  it('activates a nonempty migration through the original registered routed adapter and refuses a copied port', async () => {
    const host = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] });
    try {
      const database = await host.getD1Database('DB');
      const store = await createD1OwnerRouter({ resolveBinding: () => ({ ...scope, db: database, initializeFresh: true,
        fileRetirementAuthority: authority, fileReferenceProducers: [STATE_FILE_REFERENCE_PRODUCER] }) }).ownerScopedStoragePort(scope);
      const old = inventory(), target = inventory(true);
      await install(store, old);
      const row = makeRow({ id: 'engine-row', data: { attachment: { id: 'router-migration-live' }, label: 'old' } });
      const scan = stageFanoutOwnerScanWrite({ owner: scope.owner, row: null, visitedIntentRow: null,
        meta: { nowMs: 100, actor: 'alice' } });
      await store.commit(makeBatch(2, { writes: [{ kind: 'insert', model, row }, scan] }));
      const installed = (await store.readInstalledSnapshot(old.owner))!;
      const oldModels = buildModelTableFromCanonical(old.canonicalModels);
      const desiredModels = buildModelTableFromCanonical(target.canonicalModels);
      const migrationId = 'routed-framework-activation';
      const plan = validateTransition(installed, { migrationId, owner: installed.owner,
        fromSnapshotId: installed.snapshotId, fromDigest: installed.digest,
        toSnapshotId: target.snapshotId, toDigest: target.digest, bodyDigest: 'routed-body', directives: [] }, oldModels, desiredModels);
      await store.stageMigrationRows({ expectedRevision: asRevision(3), migrationId, rows: [{ targetModel: model,
        recordId: row.id, version: asVersion(2), data: { ...row.data, label: 'new' }, parent: null, converted: true,
        created: row.created, createdBy: row.createdBy, archivedAt: row.archivedAt }],
      progress: { migrationId, phase: 'staged', stagedCursor: null, publishCursor: null, updatedRevision: asRevision(4) } });
      const input = { plan, oldModels, desiredModels, inventory: [], chunkSize: 1,
        clock: { nowMs: () => 888 }, fileReferenceInventory: target };
      const beforeCopy = await checkpoint(database);
      await assert.rejects(activate({ store: { ...store }, ...input }), error => {
        assert.ok(error instanceof StateError);
        assert.equal(error.code, 'validation');
        assert.equal(error.message, 'Invalid reference.');
        return true;
      });
      assert.deepEqual(await checkpoint(database), beforeCopy);
      const result = await activate({ store, ...input });
      assert.equal(result.flipped, true);
      assert.equal((await store.readMigrationProgress(migrationId))?.phase, 'active');
      assert.equal((await store.load(model, row.id))?.data['label'], 'new');
      assert.equal((await store.query({ model: asModel(FANOUT_OWNER_SCAN_MODEL), authority: 'owner' })).length, 1);
      const installedTarget = (await store.readFileReferenceInventory(target.owner))!;
      assert.deepEqual(installedTarget.inventory, target);
      assert.equal(installedTarget.snapshot.installedRevision, result.revision);
      assert.equal(installedTarget.snapshot.installedAt, 888);
      const fact = await store.retireFinalizedFile(retirement(result.revision, target));
      assert.deepEqual(fact.snapshot, installedTarget.snapshot);
    } finally { await host.dispose(); }
  });

  it('rederives preparation when persisted inventory drifts without a fence revision change', async () => {
    const host = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] });
    try {
      const database = await host.getD1Database('DB');
      const store = await createD1OwnerRouter({ resolveBinding: () => ({ ...scope, db: database, initializeFresh: true,
        fileRetirementAuthority: authority, fileReferenceProducers: [STATE_FILE_REFERENCE_PRODUCER] }) }).ownerScopedStoragePort(scope);
      await install(store);
      const before = await store.readFileReferenceInventory(snapshot.owner);
      assert.deepEqual(await store.readFileReferenceInventory(snapshot.owner), before);
      const revision = await store.readRevision();
      const saved = await database.prepare('SELECT installed FROM file_reference_inventories').first<{ installed: string }>();
      const tampered = JSON.parse(saved!.installed);
      tampered.inventory.digest = 'tampered-digest';
      await database.prepare('UPDATE file_reference_inventories SET installed = ?').bind(JSON.stringify(tampered)).run();
      assert.equal((await database.prepare('SELECT revision FROM fence WHERE id = 1').first<{ revision: number }>())?.revision, revision);
      await assert.rejects(store.readFileReferenceInventory(snapshot.owner),
        (error: unknown) => error instanceof StorageConstraintError);
      await database.prepare('UPDATE file_reference_inventories SET installed = ?').bind(saved!.installed).run();
      assert.deepEqual(await store.readFileReferenceInventory(snapshot.owner), before);
    } finally { await host.dispose(); }
  });

  it('keeps small-limit retirement census separate from ordinary reads at the same revision', async () => {
    const host = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] });
    try {
      const database = await host.getD1Database('DB');
      const store = await createD1OwnerRouter({ resolveBinding: () => ({ ...scope, db: database, initializeFresh: true,
        fileRetirementAuthority: authority, fileReferenceProducers: [STATE_FILE_REFERENCE_PRODUCER] }) }).ownerScopedStoragePort(scope);
      await install(store);
      await store.commit(makeBatch(2, { writes: ['a', 'b', 'c'].map(id =>
        ({ kind: 'insert' as const, model, row: makeRow({ id, data: { label: id } }) })) }));
      const revision = await store.readRevision();
      await assert.rejects(store.retireFinalizedFile({ ...retirement(revision), maxRows: 1 }),
        (error: unknown) => error instanceof StorageConstraintError);
      assert.equal((await store.query({ model, authority: 'owner' })).length, 3);
      const fact = await store.retireFinalizedFile(retirement(revision));
      assert.equal(fact.file.ref, file().ref);
      assert.equal((await store.query({ model, authority: 'owner' })).length, 3);
    } finally { await host.dispose(); }
  });

  it('returned row and inventory data cannot corrupt retained guard preparation', async () => {
    const host = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] });
    try {
      const database = await host.getD1Database('DB');
      const store = await createD1OwnerRouter({ resolveBinding: () => ({ ...scope, db: database, initializeFresh: true,
        fileRetirementAuthority: authority, fileReferenceProducers: [STATE_FILE_REFERENCE_PRODUCER] }) }).ownerScopedStoragePort(scope);
      await install(store);
      const row = makeRow({ id: 'kept', data: { label: 'original' } });
      await store.commit(makeBatch(2, { writes: [{ kind: 'insert' as const, model, row }] }));
      const loaded = (await store.load(model, asId('kept')))!;
      const installed = (await store.readFileReferenceInventory(snapshot.owner))!;
      const originalDigest = installed.inventory.digest;
      try { (loaded.data as Record<string, unknown>)['label'] = 'mutated'; } catch { /* frozen egress refuses */ }
      try { (installed.inventory as unknown as Record<string, unknown>)['digest'] = 'mutated'; } catch { /* frozen egress refuses */ }
      assert.equal((await store.load(model, asId('kept')))?.data['label'], 'original');
      assert.equal((await store.readFileReferenceInventory(snapshot.owner))?.inventory.digest, originalDigest);
    } finally { await host.dispose(); }
  });

  it('missing fence and malformed persisted rows fail without publishing an accepting preparation', async () => {
    const host = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] });
    try {
      const database = await host.getD1Database('DB');
      const store = await createD1OwnerRouter({ resolveBinding: () => ({ ...scope, db: database, initializeFresh: true,
        fileRetirementAuthority: authority, fileReferenceProducers: [STATE_FILE_REFERENCE_PRODUCER] }) }).ownerScopedStoragePort(scope);
      await install(store);
      const before = await store.readFileReferenceInventory(snapshot.owner);
      const saved = await database.prepare('SELECT revision FROM fence WHERE id = 1').first<{ revision: number }>();
      await database.prepare('DELETE FROM fence WHERE id = 1').run();
      await assert.rejects(store.readFileReferenceInventory(snapshot.owner));
      await database.prepare('INSERT INTO fence(id, revision) VALUES (1, ?)').bind(saved!.revision).run();
      assert.deepEqual(await store.readFileReferenceInventory(snapshot.owner), before);
      await database.prepare(`INSERT INTO file_reference_inventories(owner, installed) VALUES ('evil', 'not-json')`).run();
      await assert.rejects(store.readFileReferenceInventory(snapshot.owner));
      await database.prepare(`DELETE FROM file_reference_inventories WHERE owner = 'evil'`).run();
      assert.deepEqual(await store.readFileReferenceInventory(snapshot.owner), before);
    } finally { await host.dispose(); }
  });
});
