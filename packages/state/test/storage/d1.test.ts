/**
 * D1 storage tests: full conformance against a REAL local D1 database
 * (miniflare), plus D1-specific proofs that the transactional batch — not
 * adapter logic — provides atomicity.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import {
  StorageConstraintError,
  asId,
  asModel,
  asOperation,
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
