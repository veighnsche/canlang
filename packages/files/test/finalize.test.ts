/**
 * S5 finalization: idempotent repeat, conflicting bytes/retry identity,
 * immutable provenance, verified-event ingest, intent expiry.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendUploadContent,
  completeUploadContent,
  sha256Hex,
  stagingKeyForIntent,
} from '../src/upload/index.ts';
import {
  finalizeUpload,
  ingestVerifiedEventBytes,
  readFinalizedBytes,
} from '../src/finalize/index.ts';
import { handleCreateIntent } from '../src/bridge.ts';
import {
  BINDING,
  INTENT_TTL_MS,
  PDF_BYTES,
  RECEIVER,
  TEXT_BYTES,
  makeHarness,
  uploadRequest,
} from './helpers.ts';

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
