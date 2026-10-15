import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { sha256Hex } from '@canlang/files/upload';
import { readFinalizedFileObservation } from '@canlang/files/finalize';
import { createR2FileBindings, resolveR2FileStoreIdentity } from './r2-files.js';

test('real R2 Files publication fences concurrent offsets/finalize, survives restart and lost replies, and cleans only orphan objects', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'can-r2-files-'));
  let mf: Miniflare | undefined;
  let now = Date.now(), lostBatchReply = false, failPut = false;
  const clock = { nowMs: () => now };
  const receiver = { app: 'Files', team: 'team', owner: 'team', principal: 'actual-user' };
  const request = { upload_id: 'actual-retry', operation: 'Files.attach', field: '/attachment', arguments: {}, name: 'actual.txt', type: 'text/plain', size: '10' };
  const binding = { adapter: 'upload', deliveryId: request.upload_id, resultPath: request.field };
  try {
    const open = async () => {
      mf = new Miniflare({ compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("private")}}',
        d1Databases: { DB: 'files-meta', OTHER_DB: 'files-other' }, r2Buckets: { FILES: 'files-bytes' }, d1Persist: join(root, 'd1'), r2Persist: join(root, 'r2') });
      const actualDb = await mf.getD1Database('DB') as unknown as D1Database, actualBucket = await mf.getR2Bucket('FILES') as unknown as R2Bucket;
      const db = new Proxy(actualDb, { get(target, key) {
        if (key === 'batch') return async (...args: Parameters<D1Database['batch']>) => {
          const result = await target.batch(...args);
          if (lostBatchReply) { lostBatchReply = false; throw new Error('lost accepted D1 response'); }
          return result;
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const bucket = new Proxy(actualBucket, { get(target, key) {
        if (key === 'put') return async (...args: Parameters<R2Bucket['put']>) => {
          const result = await target.put(...args);
          if (failPut) { failPut = false; throw new Error('interrupted after real R2 publication'); }
          return result;
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const identity = await resolveR2FileStoreIdentity({ db, bucket, namespace: 'Files/FILES' });
      const host = await createR2FileBindings({ db, bucket, namespace: 'Files/FILES', clock, intentTtlMs: 3600_000, urlBase: 'http://127.0.0.1:4500', allowInsecureLoopback: true });
      assert.equal(host.fileStoreId, identity);
      return { host, bucket, db };
    };
    let { host, bucket, db } = await open();
    const physicalId = host.fileStoreId;
    const grant = await host.createIntent({ request, receiver, binding });
    assert.equal(grant.status, 'granted');
    if (grant.status !== 'granted') throw new Error('No actual upload');
    assert.match(grant.grant.content, /^http:\/\/127\.0\.0\.1:4500\/files\/content\//);
    assert.deepEqual(await host.createIntent({ request, receiver, binding }), { ...grant, status: 'duplicate' });
    const a = new TextEncoder().encode('hello'), b = new TextEncoder().encode('other');
    const competing = await Promise.all([host.append(grant.intentId, receiver, a, 0), host.append(grant.intentId, receiver, b, 0)]);
    assert.deepEqual(competing.map(value => value.status).sort(), ['appended', 'failed']);
    const accepted = competing[0]!.status === 'appended' ? a : b;
    const tail = new TextEncoder().encode('bytes'), bytes = new Uint8Array([...accepted, ...tail]);
    assert.equal((await host.append(grant.intentId, receiver, tail, 5)).status, 'appended');
    assert.equal((await host.complete(grant.intentId, receiver)).status, 'completed');
    const input = { intentId: grant.intentId, retryId: request.upload_id, bytesDigest: sha256Hex(bytes), caller: receiver };
    failPut = true;
    await assert.rejects(host.finalize(input), /interrupted after real R2/);
    assert.equal((await db.prepare('SELECT id FROM can_files_finalized').all()).results.length, 0);
    await mf!.dispose(); mf = undefined;
    ({ host, bucket, db } = await open());
    assert.equal(host.fileStoreId, physicalId);
    const foreignDb = await mf!.getD1Database('OTHER_DB') as unknown as D1Database;
    await assert.rejects(createR2FileBindings({ db: foreignDb, bucket, namespace: 'Files/FILES', clock, intentTtlMs: 3600_000, urlBase: 'https://actual.invalid' }), /physical allocations/);
    const finalized = await Promise.all([host.finalize(input), host.finalize(input)]);
    const refs = finalized.map(result => result.status === 'finalized' || result.status === 'repeated' ? result.result.file : null);
    assert.notEqual(refs[0], null); assert.equal(refs[0], refs[1]);
    const ref = refs[0]!;
    assert.deepEqual(await host.readBytes(ref, receiver), bytes);
    const retained = { unattachedHorizonMs: 3600_000, retentionMs: 3600_000, retainAttached: true as const };
    lostBatchReply = true;
    assert.equal((await host.recordAttachment(ref, 'Files.Entry#actual', receiver)).status, 'attached');
    const saved = await host.observeFile(ref, receiver, retained); assert.ok(saved);
    now += 2 * 24 * 3600_000;
    assert.ok(await host.readCurrentSnapshot(ref, receiver, retained));
    assert.equal(await host.revalidateFile(readFinalizedFileObservation(saved), receiver, retained), true);
    assert.equal(await host.readCurrentSnapshot(ref, receiver, { unattachedHorizonMs: 3600_000, retentionMs: 3600_000 }), null);
    assert.equal(await host.readBytes(ref, { ...receiver, principal: 'foreign' }), null);
    const unclean = (await bucket.list()).objects.length;
    let cursor: string | null = null, visited = 0;
    do {
      const page = await host.cleanup({ beforeMs: now, limit: 2, cursor });
      assert.ok(page.visited <= 2); visited += page.visited; cursor = page.cursor;
    } while (cursor !== null);
    assert.ok(visited > 0);
    assert.ok((await bucket.list()).objects.length < unclean);
    assert.deepEqual(await host.readBytes(ref, receiver), bytes);
    const other = await createR2FileBindings({ db, bucket, namespace: 'Other/FILES', clock, intentTtlMs: 3600_000, urlBase: 'https://actual.invalid' });
    assert.equal(await other.readProvenance(ref, receiver), null);
    for (const origin of ['http://127.0.0.1:4500', 'http://remote.invalid', 'http://127.0.0.1:4500@remote.invalid']) {
      const strict = await createR2FileBindings({ db, bucket, namespace: `strict/${origin}`, clock, intentTtlMs: 3600_000, urlBase: origin });
      assert.deepEqual(await strict.createIntent({ request, receiver, binding }), { status: 'rejected', reason: 'invalid-request' });
    }
    const unsafe = await createR2FileBindings({ db, bucket, namespace: 'unsafe-loopback', clock, intentTtlMs: 3600_000, urlBase: 'http://remote.invalid', allowInsecureLoopback: true });
    assert.deepEqual(await unsafe.createIntent({ request, receiver, binding }), { status: 'rejected', reason: 'invalid-request' });
  } finally { await mf?.dispose(); rmSync(root, { recursive: true, force: true }); }
});
