/**
 * S5 finalization: idempotent repeat, conflicting bytes/retry identity,
 * immutable provenance, verified-event ingest, intent expiry.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteFileStore, createSqliteFileBindings } from '../src/host/sqlite.js';
import type { StoredFileRecord, UploadIntentRecord } from '../src/ports.js';
import {
  appendUploadContent,
  completeUploadContent,
  sha256Hex,
  stagingKeyForIntent,
} from '../src/upload/index.js';
import {
  finalizeUpload,
  blobKeyForFile,
  ingestVerifiedEventBytes,
  readFinalizedBytes,
} from '../src/finalize/index.js';
import { handleCreateIntent } from '../src/bridge.js';
import {
  BINDING,
  INTENT_TTL_MS,
  ORIGIN_URL,
  OTHER_PRINCIPAL,
  PDF_BYTES,
  RECEIVER,
  TEXT_BYTES,
  makeHarness,
  uploadRequest,
} from './helpers.js';

function completedIntent(h: ReturnType<typeof makeHarness>): {
  intentId: string;
  retryId: string;
  digest: string;
} {
  const request = uploadRequest();
  const created = handleCreateIntent(h.bridge, h.upload, {}, request, BINDING);
  assert.equal(created.status, 'granted');
  if (created.status !== 'granted') {
    throw new Error('setup: intent grant failed');
  }
  const appended = appendUploadContent(h.upload, created.intentId, RECEIVER, PDF_BYTES);
  assert.equal(appended.status, 'appended');
  const completed = completeUploadContent(h.upload, created.intentId, RECEIVER);
  assert.equal(completed.status, 'completed');
  return {
    intentId: created.intentId,
    retryId: request.upload_id,
    digest: sha256Hex(PDF_BYTES),
  };
}

describe('finalization', () => {
  it('repeating a finalize returns the same reference', () => {
    const h = makeHarness();
    const { intentId, retryId, digest } = completedIntent(h);
    const first = finalizeUpload(h.finalize, {
      intentId,
      retryId,
      bytesDigest: digest,
      caller: RECEIVER,
    });
    assert.equal(first.status, 'finalized');
    if (first.status !== 'finalized') {
      return;
    }
    const second = finalizeUpload(h.finalize, {
      intentId,
      retryId,
      bytesDigest: digest,
      caller: RECEIVER,
    });
    assert.equal(second.status, 'repeated');
    if (second.status !== 'repeated') {
      return;
    }
    assert.equal(second.result.file, first.result.file);
    assert.equal(second.file.id, first.file.id);
    assert.equal(h.files.listAll().length, 1);
  });

  it('conflicting bytes fail with no file', () => {
    const h = makeHarness();
    const { intentId, retryId } = completedIntent(h);
    const wrong = finalizeUpload(h.finalize, {
      intentId,
      retryId,
      bytesDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      caller: RECEIVER,
    });
    assert.deepEqual(wrong, { status: 'failed', reason: 'conflict' });
    assert.equal(h.files.listAll().length, 0);
  });

  it('replacement bytes after finalization fail instead of repeating', () => {
    const h = makeHarness();
    const { intentId, retryId, digest } = completedIntent(h);
    const first = finalizeUpload(h.finalize, {
      intentId,
      retryId,
      bytesDigest: digest,
      caller: RECEIVER,
    });
    assert.equal(first.status, 'finalized');
    const replacement = finalizeUpload(h.finalize, {
      intentId,
      retryId,
      bytesDigest: sha256Hex(TEXT_BYTES),
      caller: RECEIVER,
    });
    assert.deepEqual(replacement, { status: 'failed', reason: 'conflict' });
    assert.equal(h.files.listAll().length, 1);
  });

  it('conflicting retry identity fails', () => {
    const h = makeHarness();
    const { intentId, digest } = completedIntent(h);
    const conflicted = finalizeUpload(h.finalize, {
      intentId,
      retryId: 'upl_other',
      bytesDigest: digest,
      caller: RECEIVER,
    });
    assert.deepEqual(conflicted, { status: 'failed', reason: 'conflict' });
    assert.equal(h.files.listAll().length, 0);
  });

  it('reusing a retry identity with different context fails', () => {
    const h = makeHarness();
    const request = uploadRequest();
    const first = handleCreateIntent(h.bridge, h.upload, {}, request, BINDING);
    assert.equal(first.status, 'granted');
    const conflicted = handleCreateIntent(
      h.bridge,
      h.upload,
      {},
      { ...request, operation: 'expense.Expense.update' },
      BINDING,
    );
    assert.deepEqual(conflicted, { status: 'rejected', reason: 'conflict' });
  });

  it('drifted staging bytes fail instead of finalizing', () => {
    const h = makeHarness();
    const { intentId, retryId, digest } = completedIntent(h);
    h.blobs.write(stagingKeyForIntent(intentId), TEXT_BYTES);
    const drifted = finalizeUpload(h.finalize, {
      intentId,
      retryId,
      bytesDigest: digest,
      caller: RECEIVER,
    });
    assert.deepEqual(drifted, { status: 'failed', reason: 'conflict' });
    assert.equal(h.files.listAll().length, 0);
  });

  it('binds immutable request provenance at finalization', () => {
    const h = makeHarness();
    const { intentId, retryId, digest } = completedIntent(h);
    const finalized = finalizeUpload(h.finalize, {
      intentId,
      retryId,
      bytesDigest: digest,
      caller: RECEIVER,
    });
    assert.equal(finalized.status, 'finalized');
    if (finalized.status !== 'finalized') {
      return;
    }
    assert.deepEqual(finalized.file.provenance, {
      kind: 'request',
      app: 'CanExpense',
      team: 'team_1',
      owner: 'team_1',
      principal: 'user_1',
      adapter: 'deployment.web',
      deliveryId: 'del_1',
      resultPath: 'receipt',
    });
    assert.ok(Object.isFrozen(finalized.file));
    assert.ok(Object.isFrozen(finalized.file.provenance));
    assert.throws(() => {
      (finalized.file as unknown as Record<string, unknown>)['contentType'] = 'text/plain';
    });
    assert.throws(() => {
      (finalized.file.provenance as unknown as Record<string, unknown>)['team'] = 'team_2';
    });
  });

  it('ingests verified event bytes with event provenance', () => {
    const h = makeHarness();
    const ingested = ingestVerifiedEventBytes(h.finalize, {
      provenance: {
        kind: 'event',
        source: 'deployment.mail',
        adapter: 'deployment.mail',
        occurrenceId: 'occ_1',
        fieldPath: 'attachments',
        itemIndex: 0,
      },
      receiver: RECEIVER,
      claimedType: 'text/plain',
      bytes: TEXT_BYTES,
      policy: h.upload.policy,
    });
    assert.equal(ingested.status, 'finalized');
    if (ingested.status !== 'finalized') {
      return;
    }
    assert.equal(ingested.file.provenance.kind, 'event');
    assert.equal(ingested.file.contentType, 'text/plain');
    assert.deepEqual(readFinalizedBytes(h.finalize, ingested.file.id, RECEIVER), TEXT_BYTES);
  });

  it('rejects event ingest with invalid provenance or oversize', () => {
    const h = makeHarness();
    const badShape = ingestVerifiedEventBytes(h.finalize, {
      provenance: { kind: 'event', source: '', adapter: 'a' },
      receiver: RECEIVER,
      claimedType: 'text/plain',
      bytes: TEXT_BYTES,
      policy: h.upload.policy,
    });
    assert.deepEqual(badShape, { status: 'rejected', reason: 'invalid-provenance' });
    const oversized = ingestVerifiedEventBytes(h.finalize, {
      provenance: {
        kind: 'event',
        source: 'deployment.mail',
        adapter: 'deployment.mail',
        occurrenceId: 'occ_1',
        fieldPath: 'attachments',
        itemIndex: 0,
      },
      receiver: RECEIVER,
      claimedType: 'text/plain',
      bytes: TEXT_BYTES,
      policy: { types: ['text/plain'], maxBytes: 2 },
    });
    assert.deepEqual(oversized, { status: 'rejected', reason: 'oversized' });
    assert.equal(h.files.listAll().length, 0);
  });

  it('expired intents fail finalization and lose staging', () => {
    const h = makeHarness();
    const { intentId, retryId, digest } = completedIntent(h);
    h.clock.advanceBy(INTENT_TTL_MS + 1);
    const expired = finalizeUpload(h.finalize, {
      intentId,
      retryId,
      bytesDigest: digest,
      caller: RECEIVER,
    });
    assert.deepEqual(expired, { status: 'failed', reason: 'expired' });
    assert.equal(h.blobs.sizeOf(stagingKeyForIntent(intentId)), null);
    assert.equal(h.files.listAll().length, 0);
  });
});

// Actual Node SQLite metadata and byte ports; these controls qualify one
// database transaction, not atomicity with external FS/R2 storage.
for (const phase of ['blob-write', 'staging-remove', 'file-put', 'intent-put'] as const) {
  it(`rolls back interrupted SQLite finalization after ${phase} and repeats after reopen`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'can-files-finalize-sqlite-'));
    const path = join(dir, 'files.sqlite');
    let store: ReturnType<typeof createSqliteFileStore> | undefined;
    try {
      const clock = makeHarness().clock;
      const options = { clock, intentTtlMs: INTENT_TTL_MS, urlBase: ORIGIN_URL };
      store = createSqliteFileStore(path);
      let binding = createSqliteFileBindings(store, options);
      const request = uploadRequest();
      const created = binding.createIntent({ request, receiver: RECEIVER, binding: BINDING });
      assert.equal(created.status, 'granted');
      if (created.status !== 'granted') throw new Error('expected actual SQLite grant');
      assert.equal(binding.append(created.intentId, RECEIVER, PDF_BYTES).status, 'appended');
      assert.equal(binding.complete(created.intentId, RECEIVER).status, 'completed');
      const original = store.intents.get(created.intentId)!;
      assert.equal(original.state, 'complete');
      assert.equal(original.receivedBytes, PDF_BYTES.length);
      assert.equal(original.bytesDigest, sha256Hex(PDF_BYTES));
      const input = { intentId: created.intentId, retryId: request.upload_id,
        bytesDigest: sha256Hex(PDF_BYTES), caller: RECEIVER };
      const fault = new Error(`interrupted after ${phase}`);
      let throws = 0;
      let attemptedBlob: string | undefined;
      const failOnce = () => { if (throws++ === 0) throw fault; };
      const write = store.blobs.write;
      store.blobs.write = (key, bytes) => {
        write(key, bytes);
        if (key.startsWith('f_')) {
          attemptedBlob = key;
          if (phase === 'blob-write') failOnce();
        }
      };
      const remove = store.blobs.remove;
      store.blobs.remove = key => {
        remove(key);
        if (phase === 'staging-remove' && key === stagingKeyForIntent(created.intentId)) failOnce();
      };
      const putFile = store.files.put;
      store.files.put = record => { putFile(record); if (phase === 'file-put') failOnce(); };
      const putIntent = store.intents.put;
      store.intents.put = record => {
        putIntent(record);
        if (phase === 'intent-put' && record.state === 'finalized') failOnce();
      };
      assert.throws(() => binding.finalize(input), error => error === fault);
      assert.equal(throws, 1);
      assert.ok(attemptedBlob);
      store.close(); store = undefined;
      store = createSqliteFileStore(path);
      binding = createSqliteFileBindings(store, options);
      assert.deepEqual(store.intents.get(created.intentId), original);
      assert.deepEqual(store.blobs.read(stagingKeyForIntent(created.intentId)), PDF_BYTES);
      assert.equal(store.blobs.sizeOf(stagingKeyForIntent(created.intentId)), PDF_BYTES.length);
      assert.deepEqual(store.files.listAll(), []);
      assert.equal(store.blobs.read(attemptedBlob), null);
      // Existing identity/digest gates still precede successful publication.
      assert.deepEqual(binding.finalize({ ...input, caller: OTHER_PRINCIPAL }), { status: 'failed', reason: 'foreign' });
      assert.deepEqual(binding.finalize({ ...input, retryId: 'foreign-retry' }), { status: 'failed', reason: 'conflict' });
      assert.deepEqual(binding.finalize({ ...input, bytesDigest: sha256Hex(TEXT_BYTES) }), { status: 'failed', reason: 'conflict' });
      assert.deepEqual(store.files.listAll(), []);
      assert.deepEqual(store.blobs.read(stagingKeyForIntent(created.intentId)), PDF_BYTES);
      const finalized = binding.finalize(input);
      assert.equal(finalized.status, 'finalized');
      if (finalized.status !== 'finalized') throw new Error('expected successful retry');
      assert.equal(finalized.file.bytesDigest, input.bytesDigest);
      assert.equal(finalized.file.sizeBytes, PDF_BYTES.length);
      assert.deepEqual(finalized.file.provenance, original.provenance);
      assert.deepEqual(binding.readBytes(finalized.file.id, RECEIVER), PDF_BYTES);
      assert.equal(store.blobs.read(stagingKeyForIntent(created.intentId)), null);
      // Lost successful reply: a newly opened actual provider repeats the same reference.
      store.close(); store = undefined;
      store = createSqliteFileStore(path);
      binding = createSqliteFileBindings(store, options);
      const repeated = binding.finalize(input);
      assert.equal(repeated.status, 'repeated');
      if (repeated.status !== 'repeated') throw new Error('expected retained SQLite repeat');
      assert.deepEqual(repeated.file, finalized.file);
      assert.deepEqual(repeated.result, finalized.result);
      assert.ok(Object.isFrozen(repeated.file));
      assert.equal(store.files.listAll().length, 1);
      assert.deepEqual(store.blobs.read(blobKeyForFile(finalized.file.id)), PDF_BYTES);
      // Collection retains immutable metadata; replay must never republish its bytes.
      clock.advanceBy(1);
      binding.runRetention({ unattachedHorizonMs: 0, retentionMs: 1000 });
      assert.equal(store.files.get(finalized.file.id)?.state, 'orphaned');
      store.close(); store = undefined;
      store = createSqliteFileStore(path);
      binding = createSqliteFileBindings(store, options);
      assert.equal(store.blobs.read(blobKeyForFile(finalized.file.id)), null);
      const collected = binding.finalize(input);
      assert.equal(collected.status, 'repeated');
      if (collected.status !== 'repeated') throw new Error('expected collected tombstone repeat');
      assert.deepEqual(collected.file, finalized.file);
      assert.deepEqual(collected.result, finalized.result);
      assert.equal(store.files.listAll().length, 1);
      assert.equal(store.files.get(finalized.file.id)?.state, 'orphaned');
      assert.equal(store.blobs.read(blobKeyForFile(finalized.file.id)), null);
      assert.equal(store.blobs.read(stagingKeyForIntent(created.intentId)), null);
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

it('refuses persisted SQLite replay timestamp and publication-claim corruption without effects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'can-files-finalize-replay-'));
  const path = join(dir, 'files.sqlite');
  let store: ReturnType<typeof createSqliteFileStore> | undefined;
  try {
    const clock = makeHarness().clock;
    const options = { clock, intentTtlMs: INTENT_TTL_MS, urlBase: ORIGIN_URL };
    store = createSqliteFileStore(path);
    let binding = createSqliteFileBindings(store, options);
    const request = uploadRequest();
    const created = binding.createIntent({ request, receiver: RECEIVER, binding: BINDING });
    assert.equal(created.status, 'granted');
    if (created.status !== 'granted') throw new Error('expected SQLite grant');
    assert.equal(binding.append(created.intentId, RECEIVER, PDF_BYTES).status, 'appended');
    assert.equal(binding.complete(created.intentId, RECEIVER).status, 'completed');
    const input = { intentId: created.intentId, retryId: request.upload_id,
      bytesDigest: sha256Hex(PDF_BYTES), caller: RECEIVER };
    const finalized = binding.finalize(input);
    assert.equal(finalized.status, 'finalized');
    if (finalized.status !== 'finalized') throw new Error('expected SQLite finalization');
    const originalIntent = store.intents.get(created.intentId)!;
    const originalFile = store.files.get(finalized.file.id)!;
    const claim = originalIntent.pendingFinalization;
    assert.ok(claim);
    const corruptions: Array<{ label: string; apply: (db: ReturnType<typeof createSqliteFileStore>) => void }> = [
      { label: 'immutable file timestamp', apply: db => db.files.put({ ...originalFile,
        file: { ...originalFile.file, finalizedAt: { kind: 'datetime', ms: originalFile.file.finalizedAt.ms + 1n } } }) },
      ...[originalFile.finalizedAtMs + 1, -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(finalizedAtMs => ({
        label: `stored timestamp ${finalizedAtMs}`,
        apply: (db: ReturnType<typeof createSqliteFileStore>) => db.files.put({ ...originalFile, finalizedAtMs }),
      })),
      { label: 'claim reference', apply: db => db.intents.put({ ...originalIntent,
        pendingFinalization: { ...claim, ref: `${claim.ref}-different` } }) },
      { label: 'claim timestamp', apply: db => db.intents.put({ ...originalIntent,
        pendingFinalization: { ...claim, finalizedAtMs: claim.finalizedAtMs + 1 } }) },
    ];
    for (const corruption of corruptions) {
      store.intents.put(originalIntent);
      store.files.put(originalFile);
      corruption.apply(store);
      store.close(); store = undefined;
      store = createSqliteFileStore(path);
      binding = createSqliteFileBindings(store, options);
      const before: { intents: UploadIntentRecord[]; files: StoredFileRecord[]; final: Uint8Array | null; staging: Uint8Array | null } = {
        intents: store.intents.listAll(), files: store.files.listAll(),
        final: store.blobs.read(blobKeyForFile(finalized.file.id)), staging: store.blobs.read(stagingKeyForIntent(created.intentId)) };
      let mutations = 0;
      const write = store.blobs.write, remove = store.blobs.remove;
      const putFile = store.files.put, putIntent = store.intents.put;
      store.blobs.write = (key, bytes) => { mutations += 1; write(key, bytes); };
      store.blobs.remove = key => { mutations += 1; remove(key); };
      store.files.put = record => { mutations += 1; putFile(record); };
      store.intents.put = record => { mutations += 1; putIntent(record); };
      assert.deepEqual(binding.finalize(input), { status: 'failed', reason: 'conflict' }, corruption.label);
      assert.equal(mutations, 0, `${corruption.label}: no publication or metadata methods run`);
      assert.deepEqual({ intents: store.intents.listAll(), files: store.files.listAll(),
        final: store.blobs.read(blobKeyForFile(finalized.file.id)), staging: store.blobs.read(stagingKeyForIntent(created.intentId)) }, before,
      `${corruption.label}: rejected replay changes no bytes or metadata`);
    }
    // Legacy finalized intents need no new publication claim. Retained
    // collected/expired metadata remains replayable without byte recreation.
    const { pendingFinalization: _claim, ...legacy } = originalIntent;
    store.intents.put(legacy);
    store.files.put(originalFile);
    for (const state of ['finalized', 'orphaned', 'expired'] as const) {
      if (state !== 'finalized') {
        clock.advanceBy(state === 'orphaned' ? 1 : 1000);
        binding.runRetention({ unattachedHorizonMs: 0, retentionMs: 1000 });
      }
      store.close(); store = undefined;
      store = createSqliteFileStore(path);
      binding = createSqliteFileBindings(store, options);
      assert.equal(store.files.get(finalized.file.id)?.state, state);
      assert.equal(Object.hasOwn(store.intents.get(created.intentId)!, 'pendingFinalization'), false);
      const before: { intents: UploadIntentRecord[]; files: StoredFileRecord[]; bytes: Uint8Array | null } = {
        intents: store.intents.listAll(), files: store.files.listAll(), bytes: store.blobs.read(blobKeyForFile(finalized.file.id)),
      };
      const replay = binding.finalize(input);
      assert.equal(replay.status, 'repeated');
      if (replay.status !== 'repeated') throw new Error('expected legacy retained replay');
      assert.deepEqual(replay.file, finalized.file);
      assert.deepEqual(replay.result, finalized.result);
      assert.ok(Object.isFrozen(replay.file));
      assert.deepEqual({ intents: store.intents.listAll(), files: store.files.listAll(), bytes: store.blobs.read(blobKeyForFile(finalized.file.id)) }, before);
      if (state !== 'finalized') assert.equal(store.blobs.read(blobKeyForFile(finalized.file.id)), null);
    }
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
