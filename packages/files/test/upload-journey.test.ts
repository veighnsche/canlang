/**
 * S5 journey: intent -> content append/complete -> finalize -> attach,
 * backed by the real FS blob store in a scoped temp dir.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteFileStore, createSqliteFileBindings } from '../src/host/sqlite.js';
import { createFsBlobStore } from '../src/upload/fs-blob-store.js';
import {
  appendUploadContent,
  completeUploadContent,
  sha256Hex,
  stagingKeyForIntent,
} from '../src/upload/index.js';
import {
  blobKeyForFile,
  finalizeUpload,
  readFinalizedBytes,
  recordAttachment,
  storedState,
} from '../src/finalize/index.js';
import { describeForReceipt } from '../src/retention/index.js';
import { handleCreateIntent } from '../src/bridge.js';
import {
  BINDING,
  ORIGIN_URL,
  PDF_BYTES,
  RECEIVER,
  OTHER_PRINCIPAL,
  INTENT_TTL_MS,
  makeHarness,
  uploadRequest,
} from './helpers.js';

const scopeDir = mkdtempSync(join(tmpdir(), 'canlang-files-journey-'));
after(() => {
  rmSync(scopeDir, { recursive: true, force: true });
});

describe('FS-backed finalized-attachment journey', () => {
  it('finalizes an attachment and reads it back from disk', () => {
    const h = makeHarness({ blobs: createFsBlobStore(scopeDir) });
    const request = uploadRequest();
    const created = handleCreateIntent(h.bridge, h.upload, {}, request, BINDING);
    assert.equal(created.status, 'granted');
    if (created.status !== 'granted') {
      return;
    }
    assert.ok(created.grant.content.startsWith(`${ORIGIN_URL}/files/content/`));
    assert.ok(created.grant.finalize.startsWith(`${ORIGIN_URL}/files/finalize/`));
    assert.ok(!('receipt' in request.arguments));

    const head = PDF_BYTES.slice(0, 6);
    const tail = PDF_BYTES.slice(6);
    const first = appendUploadContent(h.upload, created.intentId, RECEIVER, head);
    assert.deepEqual(first, { status: 'appended', receivedBytes: head.length });
    const second = appendUploadContent(h.upload, created.intentId, RECEIVER, tail);
    assert.deepEqual(second, { status: 'appended', receivedBytes: PDF_BYTES.length });

    const completed = completeUploadContent(h.upload, created.intentId, RECEIVER);
    assert.equal(completed.status, 'completed');
    if (completed.status !== 'completed') {
      return;
    }
    assert.equal(completed.check.verdict, 'accepted');
    assert.equal(completed.check.detectedType, 'application/pdf');
    assert.equal(completed.check.sizeBytes, PDF_BYTES.length);

    const digest = sha256Hex(PDF_BYTES);
    const finalized = finalizeUpload(h.finalize, {
      intentId: created.intentId,
      retryId: request.upload_id,
      bytesDigest: digest,
      caller: RECEIVER,
    });
    assert.equal(finalized.status, 'finalized');
    if (finalized.status !== 'finalized') {
      return;
    }
    assert.equal(finalized.result.file, finalized.file.id);
    assert.equal(finalized.file.contentType, 'application/pdf');
    assert.equal(finalized.file.sizeBytes, PDF_BYTES.length);
    assert.equal(finalized.file.bytesDigest, digest);

    // Staging moved to the final blob; the bytes live on disk.
    assert.equal(h.blobs.sizeOf(stagingKeyForIntent(created.intentId)), null);
    const onDisk = new Uint8Array(
      readFileSync(join(scopeDir, blobKeyForFile(finalized.file.id))),
    );
    assert.deepEqual(onDisk, PDF_BYTES);
    assert.deepEqual(readFinalizedBytes(h.finalize, finalized.file.id, RECEIVER), PDF_BYTES);

    const attached = recordAttachment(h.finalize, finalized.file.id, 'Expense_1', RECEIVER);
    assert.deepEqual(attached, { status: 'attached', ref: finalized.file.id });
    assert.equal(storedState(h.finalize, finalized.file.id), 'attached');

    const receipt = describeForReceipt(h.retention, finalized.file.id);
    assert.deepEqual(receipt, {
      file: finalized.file.id,
      status: 'available',
      contentType: 'application/pdf',
      sizeBytes: PDF_BYTES.length,
    });
  });

  it('returns the same grant for a duplicate retry identity', () => {
    const h = makeHarness({ blobs: createFsBlobStore(join(scopeDir, 'dup')) });
    const request = uploadRequest();
    const first = handleCreateIntent(h.bridge, h.upload, {}, request, BINDING);
    assert.equal(first.status, 'granted');
    if (first.status !== 'granted') {
      return;
    }
    const retry = handleCreateIntent(h.bridge, h.upload, {}, { ...request }, BINDING);
    assert.equal(retry.status, 'duplicate');
    if (retry.status !== 'duplicate') {
      return;
    }
    assert.equal(retry.intentId, first.intentId);
    assert.deepEqual(retry.grant, first.grant);
  });

  it('resumes after a short completion instead of losing bytes', () => {
    const h = makeHarness({ blobs: createFsBlobStore(join(scopeDir, 'resume')) });
    const request = uploadRequest({ size: '10' });
    const created = handleCreateIntent(h.bridge, h.upload, {}, request, BINDING);
    assert.equal(created.status, 'granted');
    if (created.status !== 'granted') {
      return;
    }
    const part = new TextEncoder().encode('01234');
    assert.equal(
      appendUploadContent(h.upload, created.intentId, RECEIVER, part).status,
      'appended',
    );
    const short = completeUploadContent(h.upload, created.intentId, RECEIVER);
    assert.deepEqual(short, { status: 'failed', reason: 'partial' });
    const rest = new TextEncoder().encode('56789');
    assert.equal(
      appendUploadContent(h.upload, created.intentId, RECEIVER, rest).status,
      'appended',
    );
    const completed = completeUploadContent(h.upload, created.intentId, RECEIVER);
    assert.equal(completed.status, 'completed');
    if (completed.status !== 'completed') {
      return;
    }
    assert.equal(completed.check.detectedType, 'text/plain');
  });
});

it('reopens actual SQLite offset uploads across two connections without duplicating lost-reply chunks', () => {
  const dir = tempSqliteDir();
  const path = join(dir, 'files.sqlite');
  let first: ReturnType<typeof createSqliteFileStore> | undefined;
  let second: ReturnType<typeof createSqliteFileStore> | undefined;
  try {
    const clock = makeHarness().clock;
    const options = { clock, intentTtlMs: INTENT_TTL_MS, urlBase: ORIGIN_URL };
    first = createSqliteFileStore(path);
    second = createSqliteFileStore(path);
    let a = createSqliteFileBindings(first, options);
    const b = createSqliteFileBindings(second, options);
    const request = uploadRequest({ name: 'a.txt', type: 'text/plain', size: '4' });
    const created = a.createIntent({ request, receiver: RECEIVER, binding: BINDING });
    assert.equal(created.status, 'granted');
    if (created.status !== 'granted') throw new Error('expected SQLite grant');
    const duplicate = b.createIntent({ request, receiver: RECEIVER, binding: BINDING });
    assert.equal(duplicate.status, 'duplicate');
    if (duplicate.status !== 'duplicate') throw new Error('expected stable grant');
    assert.deepEqual(duplicate.grant, created.grant);
    const A = new TextEncoder().encode('A');
    assert.deepEqual(a.append(created.intentId, RECEIVER, A, 0), { status: 'appended', receivedBytes: 1 });
    first.close(); first = undefined;
    // The successful first reply was lost. The independent connection sees
    // committed bytes and count and acknowledges the original range only.
    assert.deepEqual(b.append(created.intentId, RECEIVER, A, 0), { status: 'appended', receivedBytes: 1 });
    assert.deepEqual(b.append(created.intentId, RECEIVER, A, 1), { status: 'appended', receivedBytes: 2 });
    first = createSqliteFileStore(path);
    a = createSqliteFileBindings(first, options);
    assert.deepEqual(a.append(created.intentId, RECEIVER, new TextEncoder().encode('BC'), 2), { status: 'appended', receivedBytes: 4 });
    assert.deepEqual(b.append(created.intentId, RECEIVER, new TextEncoder().encode('BC'), 2), { status: 'appended', receivedBytes: 4 });
    const bytes = new TextEncoder().encode('AABC');
    const key = stagingKeyForIntent(created.intentId);
    assert.deepEqual(first.blobs.read(key), bytes);
    assert.equal(first.intents.get(created.intentId)?.receivedBytes, 4);
    const completed = a.complete(created.intentId, RECEIVER);
    assert.deepEqual(completed, { status: 'completed', check: { claimedType: 'text/plain', detectedType: 'text/plain', sizeBytes: 4, verdict: 'accepted' } });
    const before = second.intents.get(created.intentId);
    assert.deepEqual(b.append(created.intentId, RECEIVER, A, 0), { status: 'appended', receivedBytes: 1 });
    second.close(); second = createSqliteFileStore(path);
    const reopened = createSqliteFileBindings(second, options);
    assert.deepEqual(reopened.complete(created.intentId, RECEIVER), completed);
    assert.deepEqual(second.intents.get(created.intentId), before);
    assert.deepEqual(second.blobs.read(key), bytes);
    const input = { intentId: created.intentId, retryId: request.upload_id, caller: RECEIVER, bytesDigest: sha256Hex(bytes) };
    const finalized = reopened.finalize(input);
    assert.equal(finalized.status, 'finalized');
    if (finalized.status !== 'finalized') throw new Error('expected actual finalization');
    assert.equal(finalized.file.sizeBytes, 4);
    assert.equal(finalized.file.bytesDigest, sha256Hex(bytes));
    assert.deepEqual(finalized.file.provenance, before?.provenance);
    assert.equal(first.blobs.read(key), null);
    assert.deepEqual(a.readBytes(finalized.file.id, RECEIVER), bytes);
    first.close(); first = createSqliteFileStore(path);
    a = createSqliteFileBindings(first, options);
    const repeated = a.finalize(input);
    assert.equal(repeated.status, 'repeated');
    if (repeated.status !== 'repeated') throw new Error('expected stable final reference');
    assert.deepEqual(repeated.file, finalized.file);
    assert.deepEqual(a.append(created.intentId, RECEIVER, A, 0), { status: 'failed', reason: 'closed' });
    assert.equal(first.files.listAll().length, 1);
    const finalizedIntent = first.intents.get(created.intentId);
    const finalizedFile = first.files.get(finalized.file.id);
    clock.setNowMs(finalizedIntent!.expiresAtMs + 1);
    let effects = 0;
    const append = first.blobs.append, write = first.blobs.write, remove = first.blobs.remove, put = first.intents.put;
    first.blobs.append = (key, chunk) => { effects++; append(key, chunk); };
    first.blobs.write = (key, chunk) => { effects++; write(key, chunk); };
    first.blobs.remove = key => { effects++; remove(key); };
    first.intents.put = row => { effects++; put(row); };
    assert.deepEqual(a.append(created.intentId, RECEIVER, A, NaN), { status: 'failed', reason: 'closed' });
    assert.deepEqual(a.complete(created.intentId, RECEIVER), { status: 'failed', reason: 'closed' });
    assert.equal(effects, 0);
    assert.deepEqual(first.intents.get(created.intentId), finalizedIntent);
    assert.deepEqual(first.files.get(finalized.file.id), finalizedFile);
    assert.deepEqual(a.readBytes(finalized.file.id, RECEIVER), bytes);
    const afterTtl = a.finalize(input);
    assert.equal(afterTtl.status, 'repeated');
    if (afterTtl.status !== 'repeated') throw new Error('expected finalized retry after TTL');
    assert.deepEqual(afterTtl.file, finalized.file);
    a.runRetention({ unattachedHorizonMs: 0, retentionMs: 2 * INTENT_TTL_MS });
    assert.equal(first.files.get(finalized.file.id)?.state, 'orphaned');
    assert.equal(first.blobs.read(blobKeyForFile(finalized.file.id)), null);
    first.close(); first = createSqliteFileStore(path);
    a = createSqliteFileBindings(first, options);
    const collected = { intent: first.intents.get(created.intentId), file: first.files.get(finalized.file.id) };
    let recreations = 0;
    const collectedWrite = first.blobs.write, collectedAppend = first.blobs.append;
    first.blobs.write = (key, chunk) => { recreations++; collectedWrite(key, chunk); };
    first.blobs.append = (key, chunk) => { recreations++; collectedAppend(key, chunk); };
    assert.deepEqual(a.append(created.intentId, RECEIVER, A, 0), { status: 'failed', reason: 'closed' });
    assert.deepEqual(a.complete(created.intentId, RECEIVER), { status: 'failed', reason: 'closed' });
    const collectedRetry = a.finalize(input);
    assert.equal(collectedRetry.status, 'repeated');
    if (collectedRetry.status !== 'repeated') throw new Error('expected retained finalized reference');
    assert.deepEqual(collectedRetry.file, finalized.file);
    assert.equal(recreations, 0);
    assert.deepEqual({ intent: first.intents.get(created.intentId), file: first.files.get(finalized.file.id) }, collected);
    assert.equal(first.blobs.read(blobKeyForFile(finalized.file.id)), null);
  } finally {
    first?.close(); second?.close(); rmSync(dir, { recursive: true, force: true });
  }
});

function tempSqliteDir(): string {
  return mkdtempSync(join(tmpdir(), 'can-files-upload-sqlite-'));
}

it('refuses SQLite offset gaps, overlaps and invalid ranges without effects', () => {
  const dir = tempSqliteDir();
  const store = createSqliteFileStore(join(dir, 'files.sqlite'));
  try {
    const clock = makeHarness().clock;
    const binding = createSqliteFileBindings(store, { clock, intentTtlMs: INTENT_TTL_MS, urlBase: ORIGIN_URL });
    const request = uploadRequest({ name: 'a.txt', type: 'text/plain', size: '3' });
    const created = binding.createIntent({ request, receiver: RECEIVER, binding: BINDING });
    assert.equal(created.status, 'granted');
    if (created.status !== 'granted') throw new Error('expected SQLite grant');
    const A = new TextEncoder().encode('A');
    assert.deepEqual(binding.append(created.intentId, RECEIVER, A, 0), { status: 'appended', receivedBytes: 1 });
    const before = { intents: store.intents.listAll(), files: store.files.listAll(), bytes: store.blobs.read(stagingKeyForIntent(created.intentId)) };
    let mutations = 0, inspections = 0;
    const append = store.blobs.append, write = store.blobs.write, remove = store.blobs.remove, put = store.intents.put;
    const read = store.blobs.read, size = store.blobs.sizeOf;
    store.blobs.append = (key, bytes) => { mutations++; append(key, bytes); };
    store.blobs.write = (key, bytes) => { mutations++; write(key, bytes); };
    store.blobs.remove = key => { mutations++; remove(key); };
    store.intents.put = row => { mutations++; put(row); };
    store.blobs.read = key => { inspections++; return read(key); };
    store.blobs.sizeOf = key => { inspections++; return size(key); };
    const ranges: Array<{ bytes: Uint8Array; offset: unknown }> = [
      { bytes: A, offset: 2 }, { bytes: new TextEncoder().encode('AA'), offset: 0 },
      { bytes: new TextEncoder().encode('B'), offset: 0 },
      ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, null, '0', 0n, Symbol('offset'), {}].map(offset => ({ bytes: A, offset })),
      { bytes: new TextEncoder().encode('AA'), offset: Number.MAX_SAFE_INTEGER },
    ];
    for (const { bytes, offset } of ranges) {
      assert.deepEqual(binding.append(created.intentId, RECEIVER, bytes, offset as number), { status: 'failed', reason: 'conflict' });
      assert.equal(mutations, 0);
      assert.deepEqual({ intents: store.intents.listAll(), files: store.files.listAll(), bytes: read(stagingKeyForIntent(created.intentId)) }, before);
    }
    inspections = 0;
    assert.deepEqual(binding.append(created.intentId, OTHER_PRINCIPAL, A, NaN), { status: 'failed', reason: 'foreign' });
    assert.equal(inspections, 0); assert.equal(mutations, 0);
    assert.deepEqual(binding.append(created.intentId, RECEIVER, A, 1), { status: 'appended', receivedBytes: 2 });
    assert.deepEqual(read(stagingKeyForIntent(created.intentId)), new TextEncoder().encode('AA'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});


it('SQLite expiry and rejected gates precede invalid offset and content inspection', () => {
  const dir = tempSqliteDir();
  const store = createSqliteFileStore(join(dir, 'files.sqlite'));
  try {
    const clock = makeHarness().clock;
    const binding = createSqliteFileBindings(store, { clock, intentTtlMs: INTENT_TTL_MS, urlBase: ORIGIN_URL });
    const create = () => {
      const result = binding.createIntent({ request: uploadRequest({ name: 'a.txt', type: 'text/plain', size: '1' }), receiver: RECEIVER, binding: BINDING });
      assert.equal(result.status, 'granted');
      if (result.status !== 'granted') throw new Error('expected SQLite grant');
      return result.intentId;
    };
    const rejected = create(), expired = create();
    const A = new TextEncoder().encode('A');
    assert.deepEqual(binding.append(rejected, RECEIVER, new TextEncoder().encode('AA'), 0), { status: 'failed', reason: 'oversized' });
    assert.equal(binding.append(expired, RECEIVER, A, 0).status, 'appended');
    clock.setNowMs(store.intents.get(expired)!.expiresAtMs);
    let inspections = 0;
    const read = store.blobs.read, sizeOf = store.blobs.sizeOf;
    store.blobs.read = key => { inspections++; return read(key); };
    store.blobs.sizeOf = key => { inspections++; return sizeOf(key); };
    const rejectedBefore = store.intents.get(rejected);
    assert.deepEqual(binding.append(rejected, RECEIVER, A, NaN), { status: 'failed', reason: 'closed' });
    assert.deepEqual(binding.complete(rejected, RECEIVER), { status: 'failed', reason: 'closed' });
    assert.deepEqual(store.intents.get(rejected), rejectedBefore);
    assert.deepEqual(binding.append(expired, RECEIVER, A, NaN), { status: 'failed', reason: 'expired' });
    assert.equal(store.intents.get(expired)?.state, 'expired');
    assert.equal(read(stagingKeyForIntent(expired)), null);
    const expiredBefore = store.intents.get(expired);
    assert.deepEqual(binding.append(expired, RECEIVER, A, NaN), { status: 'failed', reason: 'expired' });
    assert.deepEqual(binding.complete(expired, RECEIVER), { status: 'failed', reason: 'expired' });
    assert.deepEqual(store.intents.get(expired), expiredBefore);
    assert.equal(inspections, 0);
    assert.deepEqual(store.files.listAll(), []);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
