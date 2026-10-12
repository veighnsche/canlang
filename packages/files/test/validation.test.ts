/**
 * S5 content validation: partial, rejected, oversized and malformed
 * transfers yield no file; detection follows actual bytes, never labels.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendUploadContent,
  completeUploadContent,
  stagingKeyForIntent,
  sha256Hex,
} from '../src/upload/index.js';
import { finalizeUpload } from '../src/finalize/index.js';
import { handleCreateIntent } from '../src/bridge.js';
import {
  BINDING,
  GARBAGE_BYTES,
  JPEG_BYTES,
  PDF_BYTES,
  PNG_BYTES,
  RECEIVER,
  makeHarness,
  uploadRequest,
} from './helpers.js';

function grantedIntentId(h: ReturnType<typeof makeHarness>, size: number): string {
  const created = handleCreateIntent(
    h.bridge,
    h.upload,
    {},
    uploadRequest({ size: String(size) }),
    BINDING,
  );
  assert.equal(created.status, 'granted');
  if (created.status !== 'granted') {
    throw new Error('setup: intent grant failed');
  }
  return created.intentId;
}

describe('content validation', () => {
  it('portable SHA-256 matches native crypto for exact bytes and sliced views', () => {
    const backing = new Uint8Array([0x99, 0x00, 0xff, 0x80, 0x01, 0x77]);
    const sliced = backing.subarray(1, 5);
    assert.ok(sliced.byteOffset > 0);
    for (const bytes of [new Uint8Array(0), PDF_BYTES, new Uint8Array([0x00, 0xff, 0x80, 0x01]), sliced]) {
      const before = new Uint8Array(bytes);
      assert.equal(sha256Hex(bytes), `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
      assert.deepEqual(bytes, before);
    }
    assert.notEqual(sha256Hex(sliced), sha256Hex(backing));
  });

  it('finalizing a partial transfer fails with no file', () => {
    const h = makeHarness();
    const intentId = grantedIntentId(h, PDF_BYTES.length);
    const half = PDF_BYTES.slice(0, 4);
    assert.equal(
      appendUploadContent(h.upload, intentId, RECEIVER, half).status,
      'appended',
    );
    const finalized = finalizeUpload(h.finalize, {
      intentId,
      retryId: 'upl_x',
      bytesDigest: 'sha256:dead',
      caller: RECEIVER,
    });
    assert.deepEqual(finalized, { status: 'failed', reason: 'partial' });
    assert.equal(h.files.listAll().length, 0);
  });

  it('policy-rejected bytes yield no file', () => {
    const h = makeHarness({
      policy: { types: ['application/pdf'], maxBytes: 1024 },
    });
    const intentId = grantedIntentId(h, PNG_BYTES.length);
    assert.equal(
      appendUploadContent(h.upload, intentId, RECEIVER, PNG_BYTES).status,
      'appended',
    );
    const completed = completeUploadContent(h.upload, intentId, RECEIVER);
    assert.equal(completed.status, 'failed');
    if (completed.status !== 'failed' || !('check' in completed)) {
      throw new Error('setup: expected a malformed/rejected failure with evidence');
    }
    assert.equal(completed.reason, 'rejected');
    assert.equal(completed.check.detectedType, 'image/png');
    assert.equal(completed.check.verdict, 'rejected');
    assert.equal(h.blobs.sizeOf(stagingKeyForIntent(intentId)), null);
    assert.equal(h.files.listAll().length, 0);
  });

  it('oversized appends reject the intent and delete partial bytes', () => {
    const h = makeHarness({ policy: { types: ['text/plain'], maxBytes: 8 } });
    const intentId = grantedIntentId(h, 8);
    const chunk = new TextEncoder().encode('012345678');
    const appended = appendUploadContent(h.upload, intentId, RECEIVER, chunk);
    assert.deepEqual(appended, { status: 'failed', reason: 'oversized' });
    assert.equal(h.blobs.sizeOf(stagingKeyForIntent(intentId)), null);
    const retry = appendUploadContent(
      h.upload,
      intentId,
      RECEIVER,
      new TextEncoder().encode('x'),
    );
    assert.deepEqual(retry, { status: 'failed', reason: 'closed' });
    assert.equal(h.files.listAll().length, 0);
  });

  it('sends beyond the declared size fail fast instead of stalling partial', () => {
    const h = makeHarness({ policy: { types: ['text/plain'], maxBytes: 1024 } });
    const intentId = grantedIntentId(h, 4);
    const over = appendUploadContent(
      h.upload,
      intentId,
      RECEIVER,
      new TextEncoder().encode('01234'),
    );
    assert.deepEqual(over, { status: 'failed', reason: 'oversized' });
    assert.equal(h.blobs.sizeOf(stagingKeyForIntent(intentId)), null);
    assert.deepEqual(
      appendUploadContent(h.upload, intentId, RECEIVER, new TextEncoder().encode('x')),
      { status: 'failed', reason: 'closed' },
    );
    assert.equal(h.files.listAll().length, 0);
  });

  it('oversized declarations fail at intent creation', () => {
    const h = makeHarness({ policy: { types: ['text/plain'], maxBytes: 8 } });
    const created = handleCreateIntent(
      h.bridge,
      h.upload,
      {},
      uploadRequest({ size: '9' }),
      BINDING,
    );
    assert.deepEqual(created, { status: 'rejected', reason: 'oversized' });
    assert.equal(h.intents.listAll().length, 0);
  });

  it('malformed bytes yield no file', () => {
    const h = makeHarness();
    const intentId = grantedIntentId(h, GARBAGE_BYTES.length);
    assert.equal(
      appendUploadContent(h.upload, intentId, RECEIVER, GARBAGE_BYTES).status,
      'appended',
    );
    const completed = completeUploadContent(h.upload, intentId, RECEIVER);
    assert.equal(completed.status, 'failed');
    if (completed.status !== 'failed' || !('check' in completed)) {
      throw new Error('setup: expected a malformed failure with evidence');
    }
    assert.equal(completed.reason, 'malformed');
    assert.equal(completed.check.detectedType, null);
    assert.equal(h.blobs.sizeOf(stagingKeyForIntent(intentId)), null);
    assert.equal(h.files.listAll().length, 0);
  });

  it('truncated magic bytes are malformed', () => {
    const h = makeHarness();
    const truncated = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const intentId = grantedIntentId(h, truncated.length);
    assert.equal(
      appendUploadContent(h.upload, intentId, RECEIVER, truncated).status,
      'appended',
    );
    const completed = completeUploadContent(h.upload, intentId, RECEIVER);
    assert.equal(completed.status, 'failed');
    if (completed.status !== 'failed' || !('check' in completed)) {
      throw new Error('setup: expected a malformed failure with evidence');
    }
    assert.equal(completed.reason, 'malformed');
    assert.equal(h.files.listAll().length, 0);
  });

  it('detects JPEG bytes under a JPEG claim', () => {
    const h = makeHarness();
    const created = handleCreateIntent(
      h.bridge,
      h.upload,
      {},
      uploadRequest({ size: String(JPEG_BYTES.length), type: 'image/jpeg', name: 'p.jpg' }),
      BINDING,
    );
    assert.equal(created.status, 'granted');
    if (created.status !== 'granted') {
      return;
    }
    assert.equal(
      appendUploadContent(h.upload, created.intentId, RECEIVER, JPEG_BYTES).status,
      'appended',
    );
    const completed = completeUploadContent(h.upload, created.intentId, RECEIVER);
    assert.equal(completed.status, 'completed');
    if (completed.status === 'completed') {
      assert.equal(completed.check.detectedType, 'image/jpeg');
    }
  });

  it('validates actual bytes, never the claimed label', () => {
    const h = makeHarness();
    const created = handleCreateIntent(
      h.bridge,
      h.upload,
      {},
      uploadRequest({
        size: String(PDF_BYTES.length),
        type: 'image/png',
        name: 'fake.png',
      }),
      BINDING,
    );
    assert.equal(created.status, 'granted');
    if (created.status !== 'granted') {
      return;
    }
    assert.equal(
      appendUploadContent(h.upload, created.intentId, RECEIVER, PDF_BYTES).status,
      'appended',
    );
    const completed = completeUploadContent(h.upload, created.intentId, RECEIVER);
    assert.equal(completed.status, 'completed');
    if (completed.status === 'completed') {
      assert.equal(completed.check.claimedType, 'image/png');
      assert.equal(completed.check.detectedType, 'application/pdf');
    }
  });

  it('rejects requests whose file slot is already present', () => {
    const h = makeHarness();
    const direct = handleCreateIntent(
      h.bridge,
      h.upload,
      {},
      uploadRequest({ arguments: { receipt: 'file_0' } }),
      BINDING,
    );
    assert.deepEqual(direct, { status: 'rejected', reason: 'invalid-request' });
    const nested = handleCreateIntent(
      h.bridge,
      h.upload,
      {},
      uploadRequest({
        field: '/changes/attachment',
        arguments: { changes: { attachment: 'file_0' } },
      }),
      BINDING,
    );
    assert.deepEqual(nested, { status: 'rejected', reason: 'invalid-request' });
    const absent = handleCreateIntent(
      h.bridge,
      h.upload,
      {},
      uploadRequest({
        field: '/changes/attachment',
        arguments: { changes: { title: 't' } },
      }),
      BINDING,
    );
    assert.equal(absent.status, 'granted');
    for (const [field, key] of [['/changes/a~1b~0c', 'a/b~c'], ['/changes/a~01b', 'a~1b']] as const) {
      const present = handleCreateIntent(h.bridge, h.upload, {},
        uploadRequest({ field, arguments: { changes: { [key]: 'file_0' } } }), BINDING);
      assert.deepEqual(present, { status: 'rejected', reason: 'invalid-request' });
      const escaped = handleCreateIntent(h.bridge, h.upload, {},
        uploadRequest({ field, arguments: { changes: { title: 't' } } }), BINDING);
      assert.equal(escaped.status, 'granted');
      if (escaped.status !== 'granted') throw new Error('setup: expected escaped file slot grant');
      assert.equal(h.intents.get(escaped.intentId)?.field, field);
    }
  });

  it('rejects non-serializable arguments instead of throwing', () => {
    const h = makeHarness();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const created = handleCreateIntent(
      h.bridge,
      h.upload,
      {},
      uploadRequest({ arguments: cyclic }),
      BINDING,
    );
    assert.deepEqual(created, { status: 'rejected', reason: 'invalid-request' });
    const big = handleCreateIntent(
      h.bridge,
      h.upload,
      {},
      uploadRequest({ arguments: { n: 7n } }),
      BINDING,
    );
    assert.deepEqual(big, { status: 'rejected', reason: 'invalid-request' });
    assert.equal(h.intents.listAll().length, 0);
  });

  it('rejects non-canonical sizes and malformed pointers', () => {
    const h = makeHarness();
    for (const size of ['007', '-1', '1.5', '', ' 12']) {
      const created = handleCreateIntent(
        h.bridge,
        h.upload,
        {},
        uploadRequest({ size }),
        BINDING,
      );
      assert.deepEqual(created, { status: 'rejected', reason: 'invalid-request' });
    }
    for (const field of ['', 'receipt', '/', '/a//b', '/a~', '/a~2', '/a~x/b', '/a/~9b']) {
      const created = handleCreateIntent(
        h.bridge,
        h.upload,
        {},
        uploadRequest({ field }),
        BINDING,
      );
      assert.deepEqual(created, { status: 'rejected', reason: 'invalid-request' });
    }
    assert.equal(h.intents.listAll().length, 0);
  });
});
