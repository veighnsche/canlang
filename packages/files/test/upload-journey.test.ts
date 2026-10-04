/**
 * S5 journey: intent -> content append/complete -> finalize -> attach,
 * backed by the real FS blob store in a scoped temp dir.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsBlobStore } from '../src/upload/fs-blob-store.ts';
import {
  appendUploadContent,
  completeUploadContent,
  sha256Hex,
  stagingKeyForIntent,
} from '../src/upload/index.ts';
import {
  blobKeyForFile,
  finalizeUpload,
  readFinalizedBytes,
  recordAttachment,
  storedState,
} from '../src/finalize/index.ts';
import { describeForReceipt } from '../src/retention/index.ts';
import { handleCreateIntent } from '../src/bridge.ts';
import {
  BINDING,
  ORIGIN_URL,
  PDF_BYTES,
  RECEIVER,
  makeHarness,
  uploadRequest,
} from './helpers.ts';

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
