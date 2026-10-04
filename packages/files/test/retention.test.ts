/**
 * S5 retention: unattached objects are collected after the horizon,
 * attached bytes survive until retention, and expired bytes redact from
 * receipt projections while metadata survives.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendUploadContent,
  completeUploadContent,
  sha256Hex,
} from '../src/upload/index.ts';
import {
  finalizeUpload,
  readFinalizedBytes,
  recordAttachment,
  storedState,
} from '../src/finalize/index.ts';
import { describeForReceipt, runRetention } from '../src/retention/index.ts';
import { handleCreateIntent } from '../src/bridge.ts';
import {
  BINDING,
  INTENT_TTL_MS,
  PDF_BYTES,
  RECEIVER,
  makeHarness,
  uploadRequest,
} from './helpers.ts';

const HORIZON_MS = 60 * 60 * 1000;
const RETENTION_MS = 24 * HORIZON_MS;

function finalizedRef(h: ReturnType<typeof makeHarness>): string {
  const request = uploadRequest();
  const created = handleCreateIntent(h.bridge, h.upload, {}, request, BINDING);
  assert.equal(created.status, 'granted');
  if (created.status !== 'granted') {
    throw new Error('setup: intent grant failed');
  }
  assert.equal(
    appendUploadContent(h.upload, created.intentId, RECEIVER, PDF_BYTES).status,
    'appended',
  );
  assert.equal(
    completeUploadContent(h.upload, created.intentId, RECEIVER).status,
    'completed',
  );
  const finalized = finalizeUpload(h.finalize, {
    intentId: created.intentId,
    retryId: request.upload_id,
    bytesDigest: sha256Hex(PDF_BYTES),
    caller: RECEIVER,
  });
  assert.equal(finalized.status, 'finalized');
  if (finalized.status !== 'finalized') {
    throw new Error('setup: finalize failed');
  }
  return finalized.file.id;
}

describe('retention and garbage collection', () => {
  it('collects unattached objects after the horizon', () => {
    const h = makeHarness();
    const ref = finalizedRef(h);
    h.clock.advanceBy(HORIZON_MS + 1);
    const report = runRetention(h.retention, {
      unattachedHorizonMs: HORIZON_MS,
      retentionMs: RETENTION_MS,
    });
    assert.deepEqual(report.orphaned, [ref]);
    assert.deepEqual(report.expired, []);
    assert.equal(storedState(h.finalize, ref), 'orphaned');
    assert.equal(readFinalizedBytes(h.finalize, ref, RECEIVER), null);
    assert.deepEqual(describeForReceipt(h.retention, ref), {
      file: ref,
      status: 'redacted',
      contentType: 'application/pdf',
      sizeBytes: PDF_BYTES.length,
    });
  });

  it('attached objects survive the horizon', () => {
    const h = makeHarness();
    const ref = finalizedRef(h);
    assert.equal(
      recordAttachment(h.finalize, ref, 'Expense_1', RECEIVER).status,
      'attached',
    );
    h.clock.advanceBy(HORIZON_MS + 1);
    const report = runRetention(h.retention, {
      unattachedHorizonMs: HORIZON_MS,
      retentionMs: RETENTION_MS,
    });
    assert.deepEqual(report, { orphaned: [], expired: [], sweptIntents: [] });
    assert.equal(storedState(h.finalize, ref), 'attached');
    assert.deepEqual(readFinalizedBytes(h.finalize, ref, RECEIVER), PDF_BYTES);
  });

  it('retention expires attached bytes and redacts receipts', () => {
    const h = makeHarness();
    const ref = finalizedRef(h);
    assert.equal(
      recordAttachment(h.finalize, ref, 'Expense_1', RECEIVER).status,
      'attached',
    );
    h.clock.advanceBy(RETENTION_MS + 1);
    const report = runRetention(h.retention, {
      unattachedHorizonMs: HORIZON_MS,
      retentionMs: RETENTION_MS,
    });
    assert.deepEqual(report.expired, [ref]);
    assert.equal(storedState(h.finalize, ref), 'expired');
    assert.equal(readFinalizedBytes(h.finalize, ref, RECEIVER), null);
    const receipt = describeForReceipt(h.retention, ref);
    assert.equal(receipt?.status, 'redacted');
    assert.equal(receipt?.contentType, 'application/pdf');
    assert.equal(receipt?.sizeBytes, PDF_BYTES.length);
  });

  it('orphaned records expire once retention elapses', () => {
    const h = makeHarness();
    const ref = finalizedRef(h);
    h.clock.advanceBy(HORIZON_MS + 1);
    const first = runRetention(h.retention, {
      unattachedHorizonMs: HORIZON_MS,
      retentionMs: RETENTION_MS,
    });
    assert.deepEqual(first.orphaned, [ref]);
    h.clock.advanceBy(RETENTION_MS);
    const second = runRetention(h.retention, {
      unattachedHorizonMs: HORIZON_MS,
      retentionMs: RETENTION_MS,
    });
    assert.deepEqual(second.expired, [ref]);
    assert.equal(storedState(h.finalize, ref), 'expired');
  });

  it('sweeps expired intents and their staging bytes', () => {
    const h = makeHarness();
    const created = handleCreateIntent(h.bridge, h.upload, {}, uploadRequest(), BINDING);
    assert.equal(created.status, 'granted');
    if (created.status !== 'granted') {
      return;
    }
    h.clock.advanceBy(INTENT_TTL_MS + 1);
    const report = runRetention(h.retention, {
      unattachedHorizonMs: HORIZON_MS,
      retentionMs: RETENTION_MS,
    });
    assert.deepEqual(report.sweptIntents, [created.intentId]);
    assert.deepEqual(
      appendUploadContent(h.upload, created.intentId, RECEIVER, PDF_BYTES),
      { status: 'failed', reason: 'expired' },
    );
  });

  it('retention passes are idempotent and hide unknown refs', () => {
    const h = makeHarness();
    const ref = finalizedRef(h);
    h.clock.advanceBy(RETENTION_MS + 1);
    const config = { unattachedHorizonMs: HORIZON_MS, retentionMs: RETENTION_MS };
    const first = runRetention(h.retention, config);
    assert.deepEqual(first.expired, [ref]);
    const second = runRetention(h.retention, config);
    assert.deepEqual(second, { orphaned: [], expired: [], sweptIntents: [] });
    assert.equal(describeForReceipt(h.retention, 'file_999'), null);
  });
});
