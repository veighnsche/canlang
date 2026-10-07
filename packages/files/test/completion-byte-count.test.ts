import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { handleCreateIntent } from '../src/bridge.js';
import type { IntentStorePort, UploadIntentRecord } from '../src/ports.js';
import { createFsBlobStore } from '../src/upload/fs-blob-store.js';
import { appendUploadContent, completeUploadContent, sha256Hex, stagingKeyForIntent, type UploadDeps } from '../src/upload/index.js';
import { BINDING, OTHER_PRINCIPAL, RECEIVER, makeHarness, uploadRequest } from './helpers.js';

function open(declared = 3) {
  const h = makeHarness();
  const created = handleCreateIntent(h.bridge, h.upload, {}, uploadRequest({ name: 'a.txt', type: 'text/plain', size: String(declared) }), BINDING);
  assert.equal(created.status, 'granted');
  if (created.status !== 'granted') throw new Error('fixture grant failed');
  const record = h.intents.get(created.intentId);
  assert.ok(record);
  h.intents.put({ ...record, receivedBytes: declared });
  return { h, id: created.intentId, key: stagingKeyForIntent(created.intentId) };
}

function observed(deps: UploadDeps) {
  const events: string[] = [];
  return { events, deps: {
    ...deps,
    blobs: {
      append: deps.blobs.append.bind(deps.blobs),
      sizeOf: deps.blobs.sizeOf.bind(deps.blobs),
      write: deps.blobs.write.bind(deps.blobs),
      read(key: string) { events.push('read'); return deps.blobs.read(key); },
      remove(key: string) { events.push('remove'); deps.blobs.remove(key); },
    },
    intents: {
      get: deps.intents.get.bind(deps.intents),
      getByRetryId: deps.intents.getByRetryId.bind(deps.intents),
      listAll: deps.intents.listAll.bind(deps.intents),
      put(row) { events.push('put'); deps.intents.put(row); },
    },
  } satisfies UploadDeps };
}

for (const actual of [0, 1, 2, 4, 5]) {
  test(`actual staging length ${actual} cannot complete declared/count 3`, () => {
    const { h, id, key } = open();
    const bytes = new TextEncoder().encode('A'.repeat(actual));
    h.blobs.write(key, bytes);
    const before = { ...h.intents.get(id)! };
    const o = observed(h.upload);
    assert.deepEqual(completeUploadContent(o.deps, id, RECEIVER), { status: 'failed', reason: actual < 3 ? 'partial' : 'oversized' });
    if (actual < 3) {
      assert.deepEqual(o.events, ['read']);
      assert.deepEqual(h.intents.get(id), before);
      assert.deepEqual(h.blobs.read(key), bytes);
    } else {
      assert.deepEqual(o.events, ['read', 'remove', 'put']);
      assert.equal(h.intents.get(id)?.state, 'rejected');
      assert.equal(h.intents.get(id)?.receivedBytes, 0);
      assert.equal(h.blobs.read(key), null);
    }
    assert.equal(h.intents.get(id)?.bytesDigest, null);
    assert.equal(h.files.listAll().length, 0);
  });
}

for (const first of ['foreign', 'expired', 'closed', 'count', 'policy'] as const) {
  test(`${first} branch still precedes actual staging inspection`, () => {
    const { h, id, key } = open();
    h.blobs.write(key, new TextEncoder().encode('AAAA'));
    const record = h.intents.get(id)!;
    if (first === 'expired') h.clock.setNowMs(record.expiresAtMs);
    if (first === 'closed') h.intents.put({ ...record, state: 'complete' });
    if (first === 'count') h.intents.put({ ...record, receivedBytes: 2 });
    const o = observed(first === 'policy' ? { ...h.upload, policy: { ...h.upload.policy, maxBytes: 2 } } : h.upload);
    assert.deepEqual(completeUploadContent(o.deps, id, first === 'foreign' ? OTHER_PRINCIPAL : RECEIVER), {
      status: 'failed', reason: first === 'count' ? 'partial' : first === 'policy' ? 'oversized' : first,
    });
    assert.deepEqual(o.events, first === 'expired' || first === 'policy' ? ['remove', 'put'] : []);
  });
}

test('actual policy excess uses oversized rather than a MIME rejection', () => {
  const { h, id, key } = open();
  h.blobs.write(key, new TextEncoder().encode('AAAAA'));
  const o = observed({ ...h.upload, policy: { ...h.upload.policy, maxBytes: 4 } });
  assert.deepEqual(completeUploadContent(o.deps, id, RECEIVER), { status: 'failed', reason: 'oversized' });
  assert.deepEqual(o.events, ['read', 'remove', 'put']);
});

test('missing counted staging retains malformed handling and no extra removal', () => {
  const { h, id } = open();
  const o = observed(h.upload);
  const result = completeUploadContent(o.deps, id, RECEIVER);
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') throw new Error('unexpected completion');
  assert.equal(result.reason, 'malformed');
  assert.deepEqual(o.events, ['read', 'put']);
  assert.equal(h.intents.get(id)?.state, 'rejected');
});

for (const kind of ['valid', 'malformed', 'excluded'] as const) {
  test(`equal length retains ${kind} MIME/digest outcome and effects`, () => {
    const bytes = kind === 'excluded' ? new TextEncoder().encode('%PDF-') : kind === 'malformed' ? new Uint8Array([0, 0, 0]) : new TextEncoder().encode('ABC');
    const { h, id, key } = open(bytes.length);
    h.blobs.write(key, bytes);
    const deps = kind === 'excluded' ? { ...h.upload, policy: { ...h.upload.policy, types: ['text/plain'] } } : h.upload;
    const o = observed(deps);
    const result = completeUploadContent(o.deps, id, RECEIVER);
    if (kind === 'valid') {
      assert.equal(result.status, 'completed');
      assert.equal(h.intents.get(id)?.bytesDigest, sha256Hex(bytes));
      assert.equal(h.intents.get(id)?.detectedType, 'text/plain');
      assert.deepEqual(o.events, ['read', 'put']);
      assert.deepEqual(h.blobs.read(key), bytes);
    } else {
      assert.equal(result.status, 'failed');
      if (result.status !== 'failed') throw new Error('unexpected completion');
      assert.equal(result.reason, kind === 'excluded' ? 'rejected' : 'malformed');
      assert.deepEqual(o.events, ['read', 'remove', 'put']);
    }
  });
}

for (const actual of [1, 4]) {
  test(`actual length ${actual} refusal precedes malformed MIME`, () => {
    const { h, id, key } = open();
    h.blobs.write(key, new Uint8Array(actual));
    assert.deepEqual(completeUploadContent(h.upload, id, RECEIVER), { status: 'failed', reason: actual < 3 ? 'partial' : 'oversized' });
  });
}

for (const stage of ['read', 'remove', 'put'] as const) {
  test(`${stage} failure propagates unchanged and stops later effects`, () => {
    const { h, id, key } = open();
    h.blobs.write(key, new TextEncoder().encode('AAAA'));
    const o = observed(h.upload);
    const original = new Error(stage);
    if (stage === 'read') o.deps.blobs.read = () => { o.events.push('read'); throw original; };
    if (stage === 'remove') o.deps.blobs.remove = () => { o.events.push('remove'); throw original; };
    if (stage === 'put') o.deps.intents.put = () => { o.events.push('put'); throw original; };
    assert.throws(() => completeUploadContent(o.deps, id, RECEIVER), error => error === original);
    assert.deepEqual(o.events, stage === 'read' ? ['read'] : stage === 'remove' ? ['read', 'remove'] : ['read', 'remove', 'put']);
  });
}

/** Independent persisted copy-returning metadata fixture, not a production adapter. */
function persistedIntents(path: string): IntentStorePort {
  const rows = (): UploadIntentRecord[] => existsSync(path) ? deserialize(readFileSync(path)) as UploadIntentRecord[] : [];
  return {
    get: id => rows().find(row => row.intentId === id) ?? null,
    getByRetryId: id => rows().find(row => row.retryId === id) ?? null,
    listAll: rows,
    put(row) { writeFileSync(path, serialize([...rows().filter(old => old.intentId !== row.intentId), row])); },
  };
}

test('FS append crash, reopen and retry refuses completion before digest publication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'can-completion-size-'));
  try {
    const h = makeHarness({ blobs: createFsBlobStore(join(dir, 'blobs')) });
    const intentsPath = join(dir, 'intents.fixture');
    const upload = { ...h.upload, intents: persistedIntents(intentsPath) };
    const created = handleCreateIntent(h.bridge, upload, {}, uploadRequest({ name: 'a.txt', type: 'text/plain', size: '1' }), BINDING);
    assert.equal(created.status, 'granted');
    if (created.status !== 'granted') throw new Error('fixture grant failed');
    const bytes = new TextEncoder().encode('A');
    const crash = new Error('after append before counted metadata');
    const broken = { ...upload, blobs: { ...upload.blobs, append(key: string, chunk: Uint8Array) { upload.blobs.append(key, chunk); throw crash; } } };
    assert.throws(() => appendUploadContent(broken, created.intentId, RECEIVER, bytes), error => error === crash);
    assert.equal(upload.intents.get(created.intentId)?.receivedBytes, 0);
    const reopened = { ...upload, blobs: createFsBlobStore(join(dir, 'blobs')), intents: persistedIntents(intentsPath) };
    assert.equal(appendUploadContent(reopened, created.intentId, RECEIVER, bytes).status, 'appended');
    const o = observed(reopened);
    assert.deepEqual(completeUploadContent(o.deps, created.intentId, RECEIVER), { status: 'failed', reason: 'oversized' });
    assert.deepEqual(o.events, ['read', 'remove', 'put']);
    const record = reopened.intents.get(created.intentId)!;
    assert.equal(record.state, 'rejected');
    assert.equal(record.receivedBytes, 0);
    assert.equal(record.bytesDigest, null);
    assert.equal(record.detectedType, null);
    assert.deepEqual(readdirSync(join(dir, 'blobs')), []);
    assert.equal(h.files.listAll().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
