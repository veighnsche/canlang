import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { D1Database } from '@cloudflare/workers-types';
import { canonicalJson } from '@canlang/interfaces';
import type { ExportDownloadRecord } from '@canlang/interfaces';
import { Miniflare } from 'miniflare';
import { createD1ExportDownloadStore, ensureExportDownloadsSchema } from './export-downloads.js';
import { buildProductionDeps } from './env-assembly.js';

// Fixture metadata exercises persistence/CAS; authorization belongs to the interfaces consumer.
function signed(record: Omit<ExportDownloadRecord, 'digest'>): ExportDownloadRecord {
  return { ...record, digest: createHash('sha256').update(canonicalJson(record)).digest('hex') };
}

function pending(handle: string, expiresAt = new Date(Date.now() + 60_000).toISOString()): ExportDownloadRecord {
  return signed({ handle, appId: 'OfficeSupplies', teamId: 'team-a', principal: 'user-a',
    operation: 'Orders.list', args: { parent: { id: 'parent-a' },
      filters: { states: ['open'] }, columns: ['id', 'state'], limit: 100, cursor: 'original-cursor' },
    createdAt: new Date(Date.now()).toISOString(), expiresAt, status: 'pending' });
}

function ready(record: ExportDownloadRecord, csv = 'id,state\n1,open\n'): ExportDownloadRecord {
  const { digest: _digest, ...body } = record;
  return signed({ ...body, status: 'ready', csv, rowCount: 1 });
}

function localD1(persist?: string): Miniflare {
  return new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'export-downloads' }, ...(persist === undefined ? {} : { d1Persist: persist }) });
}

test('actual D1 serializes export creation/completion, retains tombstones and survives reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-export-downloads-'));
  let worker: Miniflare | undefined;
  try {
    worker = localD1(directory);
    const db = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureExportDownloadsSchema(db);
    await ensureExportDownloadsSchema(db);
    const first = (await buildProductionDeps({ DB: db })).exportDownloads;
    const second = createD1ExportDownloadStore(db);
    const original = pending('completion');
    assert.equal(await first.read(original.handle), null);
    assert.equal(await first.revoke('unknown'), false);
    const creates = await Promise.all([first.save(original, null), second.save(original, null)]);
    assert.equal(creates.filter(Boolean).length, 1);
    assert.deepEqual(await second.read(original.handle), original);
    const candidates = [ready(original, 'id,state\n1,open\n'), ready(original, 'id,state\n2,closed\n')];
    assert.equal(await first.save(candidates[0]!, candidates[0]!.digest), false);
    const completions = await Promise.all([
      first.save(candidates[0]!, original.digest), second.save(candidates[1]!, original.digest),
    ]);
    assert.equal(completions.filter(Boolean).length, 1);
    const winner = candidates[completions.findIndex(Boolean)]!;
    assert.deepEqual(await second.read(original.handle), winner);
    assert.equal(await first.save(ready(original, 'replacement'), winner.digest), false);
    assert.equal(await second.save(original, null), false);

    const raced = pending('revocation-race');
    assert.equal(await first.save(raced, null), true);
    const completed = ready(raced);
    const [completionWon, revoked] = await Promise.all([
      first.save(completed, raced.digest), second.revoke(raced.handle),
    ]);
    assert.equal(revoked, true);
    const tombstone = { ...raced, status: 'revoked', digest: completionWon ? completed.digest : raced.digest };
    assert.deepEqual(await first.read(raced.handle), tombstone);
    assert.equal(await second.save(completed, tombstone.digest), false);
    assert.equal(await first.save(raced, null), false);
    assert.equal(await second.revoke(original.handle), true);
    const { csv: _csv, rowCount: _rowCount, ...withoutBody } = winner;
    const readyTombstone = { ...withoutBody, status: 'revoked' };
    assert.deepEqual(await first.read(original.handle), readyTombstone);

    // A separate live body and pending digest also persist across disposing the host.
    const live = pending('live');
    const liveBody = ready(live);
    const unfinished = pending('unfinished');
    assert.equal(await first.save(live, null), true);
    assert.equal(await second.save(liveBody, live.digest), true);
    assert.equal(await first.save(unfinished, null), true);
    await worker.dispose();
    worker = undefined;
    worker = localD1(directory);
    const reopenedDb = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureExportDownloadsSchema(reopenedDb);
    const reopened = createD1ExportDownloadStore(reopenedDb);
    assert.deepEqual(await reopened.read(original.handle), readyTombstone);
    assert.deepEqual(await reopened.read(raced.handle), tombstone);
    assert.deepEqual(await reopened.read(live.handle), liveBody);
    assert.deepEqual(await reopened.read(unfinished.handle), unfinished);
    assert.equal(await reopened.save(completed, tombstone.digest), false);
    assert.equal(await reopened.save(ready(unfinished), unfinished.digest), true);
  } finally {
    try { await worker?.dispose(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('actual D1 refuses changed export identity and detaches stored request/body graphs', async () => {
  const worker = localD1();
  try {
    const db = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureExportDownloadsSchema(db);
    const first = createD1ExportDownloadStore(db);
    const second = createD1ExportDownloadStore(db);
    const original = pending('identity');
    assert.equal(await first.save(ready(original), null), false);
    assert.equal(await first.save(original, original.digest), false);
    assert.equal(await first.save(original, null), true);
    const completion = ready(original);
    const changes: Partial<ExportDownloadRecord>[] = [
      { appId: 'another-app' }, { teamId: null }, { principal: 'another-user' },
      { operation: 'Another.list' }, { args: { ...original.args, cursor: 'next-cursor' } },
      { handle: 'another-handle' }, { args: { ...original.args, parent: { id: 'another-parent' } } },
      { args: { ...original.args, filters: { states: ['closed'] } } },
      { args: { ...original.args, columns: ['state'] } }, { args: { ...original.args, limit: 101 } },
      { createdAt: new Date(Date.parse(original.createdAt) - 1).toISOString() },
      { expiresAt: new Date(Date.parse(original.expiresAt) + 1).toISOString() },
    ];
    for (const changed of changes) {
      assert.equal(await second.save({ ...completion, ...changed }, original.digest), false);
    }
    assert.deepEqual(await first.read(original.handle), original);
    // Object member order is not an identity revision.
    const reordered = { ...completion, args: { cursor: original.args.cursor, limit: original.args.limit,
      columns: original.args.columns, filters: original.args.filters, parent: original.args.parent } };
    assert.equal(await second.save(reordered, original.digest), true);

    const parent = { id: 'before' };
    const filters = { states: ['open'] };
    const columns = ['id'];
    const { digest: _pendingDigest, ...detachedSource } = pending('detached');
    const detached = signed({ ...detachedSource, args: { parent, filters, columns, limit: 10, cursor: null } });
    const snapshot = structuredClone(detached);
    const saving = first.save(detached, null);
    parent.id = 'after'; filters.states.push('closed'); columns.push('state');
    assert.equal(await saving, true);
    assert.deepEqual(await second.read(detached.handle), snapshot);
    const detachedReady = ready(snapshot);
    const readySnapshot = structuredClone(detachedReady);
    const completing = first.save(detachedReady, snapshot.digest);
    Object.assign(detachedReady, { csv: 'caller-mutated', rowCount: 999 });
    assert.equal(await completing, true);
    assert.deepEqual(await second.read(detached.handle), readySnapshot);
    const read = await second.read(detached.handle);
    assert.ok(read);
    (read.args.parent as { id: string }).id = 'read-mutated';
    (read.args.filters as { states: string[] }).states.push('read-mutated');
    (read.args.columns as string[]).push('read-mutated');
    Object.assign(read, { csv: 'read-mutated' });
    assert.deepEqual(await first.read(detached.handle), readySnapshot);
  } finally { await worker.dispose(); }
});

test('actual D1 refuses expiration at both injected-clock and physical SQL boundaries', async () => {
  const worker = localD1();
  try {
    const db = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureExportDownloadsSchema(db);
    let now = Date.now();
    const store = createD1ExportDownloadStore(db, { nowMs: () => now });
    const record = pending('clock-expiry');
    assert.equal(await store.save(record, null), true);
    now = Date.parse(record.expiresAt);
    assert.equal(await store.save(ready(record), record.digest), false);
    assert.equal(await store.save(pending('expired-create', record.expiresAt), null), false);
    assert.deepEqual(await store.read(record.handle), record);
    now = Number.NaN;
    assert.equal(await store.save(pending('invalid-clock'), null), false);

    // A stale injected clock cannot extend a lifetime past the database's actual time.
    const staleClock = Date.now() - 60_000;
    const stale = createD1ExportDownloadStore(db, { nowMs: () => staleClock });
    const expired = pending('physical-expired-create', new Date(Date.now() - 1_000).toISOString());
    assert.equal(await stale.save(expired, null), false);
    assert.equal(await stale.read(expired.handle), null);
    const short = pending('physical-expired-completion', new Date(Date.now() + 2_000).toISOString());
    assert.equal(await stale.save(short, null), true);
    await delay(Math.max(0, Date.parse(short.expiresAt) - Date.now()) + 50);
    assert.equal(await stale.save(ready(short), short.digest), false);
    assert.deepEqual(await stale.read(short.handle), short);
  } finally { await worker.dispose(); }
});

test('fault port refuses ambiguous write acknowledgements and incoherent stored metadata', async () => {
  let getters = 0;
  const acknowledgements: unknown[] = [null, {}, { meta: {} }, { meta: { changes: '1' } },
    { success: false, meta: { changes: 1 } },
    { meta: { changes: 2 } }, Object.create({ meta: { changes: 1 } }),
    { meta: Object.create({ changes: 1 }) },
    Object.defineProperty({}, 'meta', { get() { getters++; return { changes: 1 }; } }),
    { meta: Object.defineProperty({}, 'changes', { get() { getters++; return 1; } }) }];
  const record = pending('fault');
  for (const acknowledgement of acknowledgements) {
    const statement = { bind() { return this; }, async run() { return acknowledgement; } };
    const db = { prepare() { return statement; } } as unknown as D1Database;
    const store = createD1ExportDownloadStore(db);
    await assert.rejects(store.save(record, null), /write acknowledgement|definitive write result/);
    await assert.rejects(store.revoke(record.handle), /write acknowledgement|definitive write result/);
  }
  assert.equal(getters, 0);
  for (const row of [
    { data: 'null', digest: record.digest, status: record.status },
    { data: JSON.stringify(record), digest: 'different', status: record.status },
    { data: JSON.stringify(record), digest: record.digest, status: 'ready' },
    { data: JSON.stringify({ ...record, handle: 'another' }), digest: record.digest, status: record.status },
  ]) {
    const statement = { bind() { return this; }, async first() { return row; } };
    const db = { prepare() { return statement; } } as unknown as D1Database;
    await assert.rejects(createD1ExportDownloadStore(db).read(record.handle), /incoherent stored record/);
  }
});
