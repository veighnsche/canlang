import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { finalizeUpload, type FinalizeDeps } from '../src/finalize/index.js';
import { createFsBlobStore } from '../src/upload/fs-blob-store.js';
import { appendUploadContent, completeUploadContent, sha256Hex, stagingKeyForIntent } from '../src/upload/index.js';
import type { IntentStorePort, UploadIntentRecord } from '../src/ports.js';
import { handleCreateIntent } from '../src/bridge.js';
import { BINDING, OTHER_PRINCIPAL, RECEIVER, makeHarness, uploadRequest } from './helpers.js';

const BYTES = new TextEncoder().encode('A');

function completed() {
  const h = makeHarness();
  const request = uploadRequest({ name: 'a.txt', type: 'text/plain', size: '1' });
  const created = handleCreateIntent(h.bridge, h.upload, {}, request, BINDING);
  assert.equal(created.status, 'granted');
  if (created.status !== 'granted') throw new Error('fixture grant failed');
  assert.equal(appendUploadContent(h.upload, created.intentId, RECEIVER, BYTES).status, 'appended');
  assert.equal(completeUploadContent(h.upload, created.intentId, RECEIVER).status, 'completed');
  const record = h.intents.get(created.intentId);
  assert.ok(record);
  return { h, record, input: { intentId: created.intentId, retryId: request.upload_id, bytesDigest: sha256Hex(BYTES), caller: RECEIVER } };
}

function observed(deps: FinalizeDeps) {
  const writes: string[] = [];
  let reads = 0;
  return { writes, readCount: () => reads, deps: {
    ...deps,
    fileIds: { nextFileId() { writes.push('mint'); return deps.fileIds.nextFileId(); } },
    blobs: {
      ...deps.blobs,
      read(key: string) { reads++; return deps.blobs.read(key); },
      write(key: string, bytes: Uint8Array) { writes.push('blob-write'); deps.blobs.write(key, bytes); },
      remove(key: string) { writes.push('blob-remove'); deps.blobs.remove(key); },
    },
    files: { ...deps.files, get: deps.files.get.bind(deps.files), listAll: deps.files.listAll.bind(deps.files), put(row) { writes.push('file-put'); deps.files.put(row); } },
    intents: { ...deps.intents, get: deps.intents.get.bind(deps.intents), getByRetryId: deps.intents.getByRetryId.bind(deps.intents), listAll: deps.intents.listAll.bind(deps.intents), put(row) { writes.push('intent-put'); deps.intents.put(row); } },
  } satisfies FinalizeDeps };
}

for (const [actual, received, declared] of [[2, 1, 1], [1, 2, 1], [1, 1, 2], [1, 2, 2]]) {
  test(`completed sizes ${actual}/${received}/${declared} conflict before all finalization effects`, () => {
    const { h, record, input } = completed();
    const bytes = new TextEncoder().encode('A'.repeat(actual!));
    h.blobs.write(stagingKeyForIntent(record.intentId), bytes);
    h.intents.put({ ...record, receivedBytes: received!, declaredSize: declared!, bytesDigest: sha256Hex(bytes) });
    const o = observed(h.finalize);
    assert.deepEqual(finalizeUpload(o.deps, { ...input, bytesDigest: sha256Hex(bytes) }), { status: 'failed', reason: 'conflict' });
    assert.deepEqual(o.writes, []);
    assert.equal(h.files.listAll().length, 0);
    assert.equal(h.intents.get(record.intentId)?.state, 'complete');
    assert.deepEqual(h.blobs.read(stagingKeyForIntent(record.intentId)), bytes);
  });
}

for (const first of ['foreign', 'expired', 'partial', 'retry'] as const) {
  test(`${first} refusal still precedes staging and size inspection`, () => {
    const { h, record, input } = completed();
    h.intents.put({ ...record, receivedBytes: 99, state: first === 'expired' ? 'expired' : first === 'partial' ? 'open' : 'complete' });
    const o = observed(h.finalize);
    const result = finalizeUpload(o.deps, { ...input, caller: first === 'foreign' ? OTHER_PRINCIPAL : input.caller, retryId: first === 'retry' ? 'other' : input.retryId });
    assert.deepEqual(result, { status: 'failed', reason: first === 'retry' ? 'conflict' : first });
    assert.equal(o.readCount(), 0);
    assert.deepEqual(o.writes, []);
  });
}

test('equal sizes finalize once and repeat the same reference without reading staging', () => {
  const { h, input } = completed();
  const o = observed(h.finalize);
  const first = finalizeUpload(o.deps, input);
  assert.equal(first.status, 'finalized');
  assert.deepEqual(o.writes, ['mint', 'blob-write', 'blob-remove', 'file-put', 'intent-put']);
  if (first.status !== 'finalized') throw new Error('finalization failed');
  assert.equal(first.file.sizeBytes, BYTES.byteLength);
  assert.ok(Object.isFrozen(first.file));
  o.writes.length = 0;
  const reads = o.readCount();
  const repeated = finalizeUpload(o.deps, input);
  assert.equal(repeated.status, 'repeated');
  if (repeated.status !== 'repeated') throw new Error('repeat failed');
  assert.equal(repeated.file, first.file);
  assert.equal(o.readCount(), reads);
  assert.deepEqual(o.writes, []);
});

test('equal sizes retain digest conflict before effects', () => {
  const { h, input } = completed();
  const o = observed(h.finalize);
  assert.deepEqual(finalizeUpload(o.deps, { ...input, bytesDigest: sha256Hex(new TextEncoder().encode('B')) }), { status: 'failed', reason: 'conflict' });
  assert.deepEqual(o.writes, []);
});

/** Copy-returning persisted metadata fixture; actual byte storage is the defining FS store. */
function persistedIntents(path: string): IntentStorePort {
  const rows = (): UploadIntentRecord[] => existsSync(path) ? deserialize(readFileSync(path)) as UploadIntentRecord[] : [];
  return {
    get: id => rows().find(row => row.intentId === id) ?? null,
    getByRetryId: id => rows().find(row => row.retryId === id) ?? null,
    listAll: rows,
    put(row) { writeFileSync(path, serialize([...rows().filter(old => old.intentId !== row.intentId), row])); },
  };
}

test('actual FS append crash, reopen and retry cannot finalize accepted count/byte disagreement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'can-file-size-'));
  try {
    const blobs = createFsBlobStore(join(dir, 'blobs'));
    const intentsPath = join(dir, 'intents.fixture');
    const h = makeHarness({ blobs });
    const intents = persistedIntents(intentsPath);
    const upload = { ...h.upload, intents };
    const request = uploadRequest({ name: 'a.txt', type: 'text/plain', size: '1' });
    const created = handleCreateIntent(h.bridge, upload, {}, request, BINDING);
    assert.equal(created.status, 'granted');
    if (created.status !== 'granted') throw new Error('fixture grant failed');
    const crash = new Error('after real FS append before metadata put');
    const broken = { ...upload, blobs: { ...blobs, read: blobs.read.bind(blobs), sizeOf: blobs.sizeOf.bind(blobs), write: blobs.write.bind(blobs), remove: blobs.remove.bind(blobs), append(key: string, bytes: Uint8Array) { blobs.append(key, bytes); throw crash; } } };
    assert.throws(() => appendUploadContent(broken, created.intentId, RECEIVER, BYTES), error => error === crash);
    assert.equal(intents.get(created.intentId)?.receivedBytes, 0);
    const reopened = { ...upload, blobs: createFsBlobStore(join(dir, 'blobs')), intents: persistedIntents(intentsPath) };
    assert.equal(appendUploadContent(reopened, created.intentId, RECEIVER, BYTES).status, 'appended');
    assert.equal(completeUploadContent(reopened, created.intentId, RECEIVER).status, 'completed');
    const record = reopened.intents.get(created.intentId);
    assert.ok(record);
    assert.equal(record.receivedBytes, 1);
    assert.equal(record.declaredSize, 1);
    assert.equal(reopened.blobs.read(stagingKeyForIntent(created.intentId))?.byteLength, 2);
    const o = observed({ ...h.finalize, blobs: reopened.blobs, intents: reopened.intents });
    assert.deepEqual(finalizeUpload(o.deps, { intentId: created.intentId, retryId: request.upload_id, bytesDigest: record.bytesDigest!, caller: RECEIVER }), { status: 'failed', reason: 'conflict' });
    assert.deepEqual(o.writes, []);
    assert.equal(h.files.listAll().length, 0);
    assert.equal(reopened.intents.get(created.intentId)?.state, 'complete');
    assert.equal(readdirSync(join(dir, 'blobs')).filter(name => name.startsWith('f_')).length, 0);
    assert.equal(reopened.blobs.read(stagingKeyForIntent(created.intentId))?.byteLength, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
