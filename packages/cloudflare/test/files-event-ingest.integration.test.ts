import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { Miniflare } from 'miniflare';
import type { R2Bucket } from '@cloudflare/workers-types';
import {
  BILLING_ADAPTER,
  createBillingIngressVerifier,
  loadBillingIngressBinding,
} from '@canlang/interfaces';
import { DEFAULT_FILE_POLICY } from '@canlang/files/upload';
import type { EventIngestFileOutcome } from '@canlang/files/finalize';
import { createSqliteFileBindings, createSqliteFileStore } from '@canlang/files/host/sqlite';

const NOW_MS = Date.parse('2026-10-28T00:00:00.000Z');
const PDF_A = new TextEncoder().encode('%PDF-1.4 receiving A\n');
const PDF_B = new TextEncoder().encode('%PDF-1.4 receiving B, divergent\n');

function asFinalized(outcome: EventIngestFileOutcome): { readonly file: string } {
  assert.equal(outcome.status, 'finalized');
  if (outcome.status !== 'finalized') throw new Error('unreachable');
  return { file: outcome.result.file };
}

function asRepeated(outcome: EventIngestFileOutcome): { readonly file: string } {
  assert.equal(outcome.status, 'repeated');
  if (outcome.status !== 'repeated') throw new Error('unreachable');
  return { file: outcome.result.file };
}

function asRejected(outcome: EventIngestFileOutcome): { readonly reason: string } {
  assert.equal(outcome.status, 'rejected');
  if (outcome.status !== 'rejected') throw new Error('unreachable');
  return { reason: outcome.reason };
}

it('receives one verified event occurrence field exactly once per receiver', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-event-ingest-'));
  // The billing FP.SOURCE-MAPPINGS binding verifies the envelope; the
  // invoice document bytes are a TECH-F02 local fixture (billing's
  // closed grammar carries no documents; the join takes any verified
  // envelope plus its occurrence field bytes).
  const key = randomBytes(32);
  const configured = loadBillingIngressBinding({
    CAN_INGRESS_BILLING_NAMESPACE: 'billing',
    CAN_INGRESS_BILLING_TEAM: 'team-acme',
    CAN_INGRESS_BILLING_OWNER: 'acme',
    CAN_INGRESS_BILLING_KEYS: JSON.stringify({ current: `whsec_${key.toString('base64')}` }),
  });
  const verifier = createBillingIngressVerifier({ binding: configured.binding, clock: { nowMs: () => NOW_MS },
    keys: configured.keys, isCurrent: () => true });
  const raw = JSON.stringify({ version: 1, type: 'invoice.paid', producer_event_id: 'evt-receiving-1',
    occurred_at: '2026-10-27T23:59:00.000Z', invoice: 'inv-receiving-1', amount: '120.00', currency: 'EUR' });
  const mac = createHmac('sha256', key).update(`evt-receiving-1.1793145600.${raw}`, 'utf8').digest('base64');
  const envelope = await verifier.verify(configured.binding, {
    headers: { 'webhook-id': 'evt-receiving-1', 'webhook-timestamp': '1793145600', 'webhook-signature': `v1,${mac}` },
    body: new TextEncoder().encode(raw),
  });
  assert.ok(envelope, 'the binding verifies the genuine delivery');
  assert.equal(envelope.namespace, 'billing');
  assert.equal(envelope.producerEventId, 'evt-receiving-1');
  const tampered = await verifier.verify(configured.binding, {
    headers: { 'webhook-id': 'evt-receiving-1', 'webhook-timestamp': '1793145600',
      'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    body: new TextEncoder().encode(raw),
  });
  assert.equal(tampered, null, 'a forged signature verifies nothing');

  const requireNative = createRequire(import.meta.url);
  const { createR2FileBindings } = requireNative(fileURLToPath(new URL('../dist/runtime/r2-files.js', import.meta.url))) as
    typeof import('../src/runtime/r2-files.js');
  const receiverA = { app: 'receiving-app', team: 'team-acme', owner: 'acme', principal: 'user-acme' };
  const provenance = { kind: 'event', source: envelope.namespace, adapter: BILLING_ADAPTER,
    occurrenceId: envelope.producerEventId, fieldPath: 'invoice_document', itemIndex: 0 };
  const ingest = { provenance, receiver: receiverA, claimedType: 'application/pdf',
    bytes: PDF_A, policy: DEFAULT_FILE_POLICY };

  const bootRuntime = () => new Miniflare({ modules: true, compatibilityDate: '2026-07-15',
    script: 'export default {fetch(){return new Response("ready")}}',
    d1Persist: join(directory, 'd1'), d1Databases: { DB: 'event-ingest' }, r2Buckets: { FILES: 'event-ingest' } });
  let runtime = bootRuntime();
  try {
    const db = await runtime.getD1Database('DB');
    const bucket = (await runtime.getR2Bucket('FILES')) as unknown as R2Bucket;
    const host = await createR2FileBindings({ db, bucket, namespace: 'receiving/FILES',
      clock: { nowMs: () => NOW_MS }, urlBase: 'https://files.test', intentTtlMs: 900000 });

    const first = await host.ingestEventFile(ingest);
    const refA = asFinalized(first).file;
    assert.deepEqual(first.status === 'finalized' ? first.file.provenance : null, {
      kind: 'event', source: 'billing', adapter: BILLING_ADAPTER, occurrenceId: 'evt-receiving-1',
      fieldPath: 'invoice_document', itemIndex: 0,
    });
    assert.deepEqual(await host.readBytes(refA, receiverA), PDF_A);

    // Replay with identical bytes repeats the same reference.
    assert.equal(asRepeated(await host.ingestEventFile(ingest)).file, refA);

    // Divergent bytes for the same occurrence field conflict.
    assert.equal(asRejected(await host.ingestEventFile({ ...ingest, bytes: PDF_B })).reason, 'conflict');

    // A foreign receiver gets its own isolated file, never A's bytes.
    const receiverB = { app: 'receiving-app', team: 'team-b', owner: 'b', principal: 'user-b' };
    const refB = asFinalized(await host.ingestEventFile({ ...ingest, receiver: receiverB })).file;
    assert.ok(refB !== refA);
    assert.deepEqual(await host.readBytes(refB, receiverB), PDF_A);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM can_files_event_claims WHERE ns=?')
      .bind('receiving/FILES').first<{ count: number }>())?.count, 2);

    // Refusals: unshaped provenance, oversize bytes.
    assert.equal(asRejected(await host.ingestEventFile({ ...ingest, provenance: { kind: 'event' } })).reason,
      'invalid-provenance');
    assert.equal(asRejected(await host.ingestEventFile({ ...ingest,
      policy: { types: ['application/pdf'], maxBytes: 8 },
      provenance: { ...provenance, occurrenceId: 'evt-receiving-oversize' } })).reason, 'oversized');

    // Simulated collection (bytes retired, claim tombstone answers):
    // replay conflicts instead of resurrecting or re-minting.
    await db.prepare('DELETE FROM can_files_blobs WHERE ns=? AND id=?')
      .bind('receiving/FILES', `f_${refA}.bin`).run();
    assert.equal(asRejected(await host.ingestEventFile(ingest)).reason, 'conflict');

    // Concurrent duplicates converge on one file: losers collide on
    // the claim key and retry onto the winner's repeated reference.
    const racedProvenance = { ...provenance, occurrenceId: 'evt-receiving-race' };
    const raced = await Promise.all(Array.from({ length: 10 }, () =>
      host.ingestEventFile({ ...ingest, provenance: racedProvenance })));
    const racedRefs = new Set<string>();
    for (const outcome of raced) {
      assert.ok(outcome.status === 'finalized' || outcome.status === 'repeated', outcome.status);
      if (outcome.status === 'finalized' || outcome.status === 'repeated') racedRefs.add(outcome.result.file);
    }
    assert.equal(racedRefs.size, 1);

    // Bindings reopen over the same stores: no in-memory claim
    // state, replay still repeats with bytes intact.
    const reopenedHost = await createR2FileBindings({ db, bucket, namespace: 'receiving/FILES',
      clock: { nowMs: () => NOW_MS }, urlBase: 'https://files.test', intentTtlMs: 900000 });
    assert.equal(asRepeated(await reopenedHost.ingestEventFile({ ...ingest, receiver: receiverB })).file, refB);
    assert.deepEqual(await reopenedHost.readBytes(refB, receiverB), PDF_A);

    // Genuine restart with surviving D1 but wiped R2 bytes (Miniflare
    // memory): reopening refuses loudly instead of serving metadata
    // without its bytes — the split-brain guard holds.
    await runtime.dispose();
    runtime = bootRuntime();
    await assert.rejects(
      createR2FileBindings({ db: await runtime.getD1Database('DB'),
        bucket: (await runtime.getR2Bucket('FILES')) as unknown as R2Bucket,
        namespace: 'receiving/FILES', clock: { nowMs: () => NOW_MS }, urlBase: 'https://files.test',
        intentTtlMs: 900000 }),
      /allocation marker is absent/,
    );

    // The SQLite host honors the same join over a real database file:
    // finalizes once, repeats across close and reopen with bytes
    // intact (metadata and bytes share the file transaction).
    const path = join(directory, 'event-ingest.sqlite');
    const sqliteClock = { nowMs: () => NOW_MS };
    const sqliteReceiver = { app: 'receiving-app', team: 'team-sql', owner: 'sql', principal: 'user-sql' };
    const sqliteIngest = { provenance: { ...provenance, occurrenceId: 'evt-sqlite-1' }, receiver: sqliteReceiver,
      claimedType: 'application/pdf', bytes: PDF_A, policy: DEFAULT_FILE_POLICY };
    const store = createSqliteFileStore(path);
    const sqlite = createSqliteFileBindings(store, { clock: sqliteClock, intentTtlMs: 900000, urlBase: 'https://files.test' });
    const sqliteRef = asFinalized(await sqlite.ingestEventFile(sqliteIngest)).file;
    assert.equal(asRepeated(await sqlite.ingestEventFile(sqliteIngest)).file, sqliteRef);
    store.close();
    const reopenedStore = createSqliteFileStore(path);
    const reopenedSqlite = createSqliteFileBindings(reopenedStore,
      { clock: sqliteClock, intentTtlMs: 900000, urlBase: 'https://files.test' });
    assert.equal(asRepeated(await reopenedSqlite.ingestEventFile(sqliteIngest)).file, sqliteRef);
    assert.deepEqual(await reopenedSqlite.readBytes(sqliteRef, sqliteReceiver), PDF_A);
    reopenedStore.close();
  } finally {
    await runtime.dispose();
  }
});
