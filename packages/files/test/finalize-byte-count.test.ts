import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { blobKeyForFile, finalizeUpload, type FinalizeDeps } from '../src/finalize/index.js';
import { createSqliteFileStore } from '../src/host/sqlite.js';
import { createFsBlobStore } from '../src/upload/fs-blob-store.js';
import { appendUploadContent, completeUploadContent, sha256Hex, stagingKeyForIntent } from '../src/upload/index.js';
import type { IntentStorePort, UploadIntentRecord } from '../src/ports.js';
import { handleCreateIntent } from '../src/bridge.js';
import { BINDING, OTHER_PRINCIPAL, RECEIVER, makeHarness, uploadRequest } from './helpers.js';

const BYTES = new TextEncoder().encode('A');

function durableCompleted(dir: string) {
  let metadata = createSqliteFileStore(join(dir, 'metadata.sqlite'));
  let blobs = createFsBlobStore(join(dir, 'blobs'));
  const h = makeHarness();
  const upload = { ...h.upload, intents: metadata.intents, blobs };
  const request = uploadRequest({ name: 'a.txt', type: 'text/plain', size: '1' });
  const created = handleCreateIntent(h.bridge, upload, {}, request, BINDING);
  assert.equal(created.status, 'granted');
  if (created.status !== 'granted') throw new Error('fixture grant failed');
  assert.equal(appendUploadContent(upload, created.intentId, RECEIVER, BYTES).status, 'appended');
  assert.equal(completeUploadContent(upload, created.intentId, RECEIVER).status, 'completed');
  const deps = (): FinalizeDeps => ({ ...h.finalize, intents: metadata.intents, files: metadata.files, blobs });
  return {
    deps,
    input: { intentId: created.intentId, retryId: request.upload_id, bytesDigest: sha256Hex(BYTES), caller: RECEIVER },
    reopen() {
      metadata.close();
      metadata = createSqliteFileStore(join(dir, 'metadata.sqlite'));
      blobs = createFsBlobStore(join(dir, 'blobs'));
    },
    close() { metadata.close(); },
  };
}

type FinalizationPhase = 'claim' | 'final-bytes' | 'file-row' | 'final-intent' | 'staging-remove';

function interruptedFinalization(deps: FinalizeDeps, phase: FinalizationPhase, crash: Error): FinalizeDeps {
  return {
    ...deps,
    intents: { ...deps.intents, put(row) {
      deps.intents.put(row);
      if ((phase === 'claim' && row.state === 'complete' && row.pendingFinalization !== undefined) ||
          (phase === 'final-intent' && row.state === 'finalized')) throw crash;
    } },
    files: { ...deps.files, put(row) { deps.files.put(row); if (phase === 'file-row') throw crash; } },
    blobs: {
      read: deps.blobs.read.bind(deps.blobs), sizeOf: deps.blobs.sizeOf.bind(deps.blobs),
      append: deps.blobs.append.bind(deps.blobs),
      write(key, bytes) { deps.blobs.write(key, bytes); if (phase === 'final-bytes') throw crash; },
      remove(key) { deps.blobs.remove(key); if (phase === 'staging-remove') throw crash; },
    },
  };
}

for (const phase of ['claim', 'final-bytes', 'file-row', 'final-intent', 'staging-remove'] as const) {
  test(`real SQLite metadata and FS bytes recover after durable ${phase}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'can-finalization-reopen-'));
    const journey = durableCompleted(dir);
    try {
      const crash = new Error(`after durable ${phase}`);
      assert.throws(() => finalizeUpload(interruptedFinalization(journey.deps(), phase, crash), journey.input), error => error === crash);
      const interrupted = journey.deps().intents.get(journey.input.intentId);
      assert.ok(interrupted);
      assert.equal(interrupted.state, phase === 'final-intent' || phase === 'staging-remove' ? 'finalized' : 'complete');
      assert.deepEqual(journey.deps().blobs.read(stagingKeyForIntent(journey.input.intentId)), phase === 'staging-remove' ? null : BYTES);
      const ref = interrupted.finalizedRef ?? interrupted.pendingFinalization?.ref;
      assert.ok(ref);
      const claimedTime = interrupted.pendingFinalization?.finalizedAtMs ?? journey.deps().files.get(ref)?.finalizedAtMs;
      assert.ok(claimedTime !== undefined);
      journey.reopen();
      const recovered = finalizeUpload({ ...journey.deps(), fileIds: { nextFileId() { throw new Error('Recovery must reuse the durable claim'); } } }, journey.input);
      assert.equal(recovered.status, phase === 'final-intent' || phase === 'staging-remove' ? 'repeated' : 'finalized');
      if (recovered.status !== 'finalized' && recovered.status !== 'repeated') throw new Error('recovery refused');
      assert.equal(recovered.file.id, ref);
      assert.equal(recovered.file.sizeBytes, BYTES.length);
      assert.equal(recovered.file.bytesDigest, sha256Hex(BYTES));
      assert.deepEqual(recovered.file.provenance, interrupted.provenance);
      assert.equal(recovered.file.finalizedAt.ms, BigInt(claimedTime));
      assert.ok(Object.isFrozen(recovered.file));
      assert.ok(Object.isFrozen(recovered.file.provenance));
      assert.ok(Object.isFrozen(recovered.file.finalizedAt));
      const persisted = journey.deps().files.listAll();
      assert.equal(persisted.length, 1);
      assert.deepEqual(persisted[0]?.file, recovered.file);
      assert.equal(persisted[0]?.state, 'finalized');
      assert.equal(persisted[0]?.finalizedAtMs, claimedTime);
      assert.equal(journey.deps().intents.get(journey.input.intentId)?.finalizedRef, ref);
      assert.deepEqual(journey.deps().blobs.read(blobKeyForFile(ref)), BYTES);
      assert.equal(journey.deps().blobs.read(stagingKeyForIntent(journey.input.intentId)), null);
      assert.deepEqual(readdirSync(join(dir, 'blobs')), [blobKeyForFile(ref)]);
      const before = journey.deps().intents.get(journey.input.intentId);
      const repeated = finalizeUpload(journey.deps(), journey.input);
      assert.equal(repeated.status, 'repeated');
      assert.deepEqual(journey.deps().intents.get(journey.input.intentId), before);
      assert.equal(journey.deps().files.listAll().length, 1);
    } finally { journey.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const altered of ['staging', 'pending-final'] as const) {
  test(`reopened pending finalization refuses altered ${altered} bytes without overwrite`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'can-finalization-conflict-'));
    const journey = durableCompleted(dir);
    try {
      const crash = new Error('after durable claim');
      assert.throws(() => finalizeUpload(interruptedFinalization(journey.deps(), 'claim', crash), journey.input), error => error === crash);
      journey.reopen();
      const before = journey.deps().intents.get(journey.input.intentId);
      assert.ok(before?.pendingFinalization);
      const key = altered === 'staging' ? stagingKeyForIntent(journey.input.intentId) : blobKeyForFile(before.pendingFinalization.ref);
      const conflicting = new TextEncoder().encode('B');
      journey.deps().blobs.write(key, conflicting);
      journey.reopen();
      const o = observed(journey.deps());
      assert.deepEqual(finalizeUpload(o.deps, journey.input), { status: 'failed', reason: 'conflict' });
      assert.deepEqual(o.writes, []);
      assert.deepEqual(journey.deps().intents.get(journey.input.intentId), before);
      assert.equal(journey.deps().files.listAll().length, 0);
      assert.deepEqual(journey.deps().blobs.read(key), conflicting);
    } finally { journey.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

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
  assert.deepEqual(o.writes, ['mint', 'intent-put', 'blob-write', 'file-put', 'intent-put', 'blob-remove']);
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
  assert.deepEqual(o.writes, ['blob-remove']);
});

test('equal sizes retain digest conflict before effects', () => {
  const { h, input } = completed();
  const o = observed(h.finalize);
  assert.deepEqual(finalizeUpload(o.deps, { ...input, bytesDigest: sha256Hex(new TextEncoder().encode('B')) }), { status: 'failed', reason: 'conflict' });
  assert.deepEqual(o.writes, []);
});

for (const time of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid new finalization time ${time} conflicts before mint or publication`, () => {
    const { h, record, input } = completed();
    let reads = 0;
    const o = observed({ ...h.finalize, clock: { nowMs() {
      // Keep expiry's observation valid; independently exercise claim time.
      return reads++ === 0 ? h.clock.nowMs() : time;
    } } });
    const before = h.intents.get(record.intentId);
    assert.deepEqual(finalizeUpload(o.deps, input), { status: 'failed', reason: 'conflict' });
    assert.equal(reads, 2);
    assert.deepEqual(o.writes, []);
    assert.deepEqual(h.intents.get(record.intentId), before);
    assert.deepEqual(h.blobs.read(stagingKeyForIntent(record.intentId)), BYTES);
    assert.deepEqual(h.files.listAll(), []);
  });

  test(`invalid persisted finalization time ${time} conflicts without publication`, () => {
    const { h, record, input } = completed();
    h.intents.put({ ...record, pendingFinalization: { ref: 'invalid-time-file', finalizedAtMs: time } });
    const before = h.intents.get(record.intentId);
    const o = observed(h.finalize);
    assert.deepEqual(finalizeUpload(o.deps, input), { status: 'failed', reason: 'conflict' });
    assert.deepEqual(o.writes, []);
    assert.deepEqual(h.intents.get(record.intentId), before);
    assert.deepEqual(h.blobs.read(stagingKeyForIntent(record.intentId)), BYTES);
    assert.deepEqual(h.files.listAll(), []);
    assert.equal(h.blobs.read(blobKeyForFile('invalid-time-file')), null);
  });
}

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

test('actual FS append crash, reopen and retry rejects completion before finalization', () => {
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
    assert.deepEqual(appendUploadContent(reopened, created.intentId, RECEIVER, BYTES), { status: 'failed', reason: 'closed' });
    assert.deepEqual(completeUploadContent(reopened, created.intentId, RECEIVER), { status: 'failed', reason: 'closed' });
    const record = reopened.intents.get(created.intentId);
    assert.ok(record);
    assert.equal(record.state, 'rejected');
    assert.equal(record.receivedBytes, 0);
    assert.equal(record.declaredSize, 1);
    assert.equal(record.bytesDigest, null);
    assert.equal(record.detectedType, null);
    assert.equal(reopened.blobs.read(stagingKeyForIntent(created.intentId)), null);
    const o = observed({ ...h.finalize, blobs: reopened.blobs, intents: reopened.intents });
    assert.deepEqual(finalizeUpload(o.deps, { intentId: created.intentId, retryId: request.upload_id, bytesDigest: sha256Hex(new TextEncoder().encode('AA')), caller: RECEIVER }), { status: 'failed', reason: 'partial' });
    assert.deepEqual(o.writes, []);
    assert.equal(o.readCount(), 0);
    assert.equal(h.files.listAll().length, 0);
    assert.equal(reopened.intents.get(created.intentId)?.state, 'rejected');
    assert.equal(readdirSync(join(dir, 'blobs')).filter(name => name.startsWith('f_')).length, 0);
    assert.equal(reopened.blobs.read(stagingKeyForIntent(created.intentId)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
