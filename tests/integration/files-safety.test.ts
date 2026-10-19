/** Files safety join driven through the real producer: finalizeUpload dedupe, runRetention horizons and recordAttachment authorization. */
import { describe, expect, it } from 'vitest';
import {
  finalizeUpload,
  recordAttachment,
  blobKeyForFile,
  type FinalizeDeps,
} from '@canlang/files/finalize';
import { runRetention, type RetentionDeps, type RetentionConfig } from '@canlang/files/retention';
import {
  appendUploadContentAtOffset,
  completeUploadContent,
  createUploadIntent,
  sha256Hex,
  DEFAULT_FILE_POLICY,
  type UploadDeps,
} from '@canlang/files/upload';
import {
  TestOnlyCounterFileIds,
  TestOnlyCounterIntentIds,
  TestOnlyManualClock,
  TestOnlyMemoryBlobStore,
  TestOnlyMemoryFinalizedStore,
  TestOnlyMemoryIntentStore,
} from '@canlang/files/ports';
import type { ReceivingContext, RequestProvenanceBinding } from '@canlang/files/provenance';

const T0 = Date.parse('2026-10-04T15:00:00Z');
const INTENT_TTL_MS = 15 * 60 * 1000;
const ORIGIN_URL = 'https://app.example.test';
const CONFIG: RetentionConfig = { unattachedHorizonMs: 1000, retentionMs: 5000 };

const RECEIVER: ReceivingContext = {
  app: 'CanExpense',
  team: 'team_1',
  owner: 'team_1',
  principal: 'user_1',
};

const OTHER_TEAM: ReceivingContext = {
  app: 'CanExpense',
  team: 'team_2',
  owner: 'team_2',
  principal: 'user_9',
};

const BINDING: RequestProvenanceBinding = {
  adapter: 'deployment.web',
  deliveryId: 'del_1',
  resultPath: 'receipt',
};

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\ntrailer\n');

interface Harness {
  readonly upload: UploadDeps;
  readonly finalize: FinalizeDeps;
  readonly retention: RetentionDeps;
  readonly clock: TestOnlyManualClock;
}

function makeHarness(): Harness {
  const clock = new TestOnlyManualClock(T0);
  const intents = new TestOnlyMemoryIntentStore();
  const files = new TestOnlyMemoryFinalizedStore();
  const blobs = new TestOnlyMemoryBlobStore();
  const upload: UploadDeps = {
    clock,
    intentIds: new TestOnlyCounterIntentIds(),
    intents,
    blobs,
    policy: DEFAULT_FILE_POLICY,
    intentTtlMs: INTENT_TTL_MS,
    urlBase: ORIGIN_URL,
  };
  const finalize: FinalizeDeps = {
    clock,
    fileIds: new TestOnlyCounterFileIds(),
    intents,
    blobs,
    files,
  };
  const retention: RetentionDeps = { clock, blobs, files, intents };
  return { upload, finalize, retention, clock };
}

let uploadCounter = 0;

function completeTransfer(h: Harness, bytes: Uint8Array, caller: ReceivingContext = RECEIVER) {
  uploadCounter += 1;
  const retryId = `upl_${uploadCounter}`;
  const created = createUploadIntent(h.upload, {
    request: {
      upload_id: retryId,
      operation: 'expense.Expense.create',
      field: '/receipt',
      arguments: {},
      name: 'receipt.pdf',
      type: 'application/pdf',
      size: String(bytes.length),
    },
    receiver: RECEIVER,
    binding: BINDING,
  });
  if (created.status !== 'granted') throw new Error(`intent not granted: ${created.status}`);
  const appended = appendUploadContentAtOffset(h.upload, created.intentId, caller, bytes, 0);
  expect(appended.status).toBe('appended');
  const completed = completeUploadContent(h.upload, created.intentId, caller);
  expect(completed.status).toBe('completed');
  return { intentId: created.intentId, retryId, digest: sha256Hex(bytes) };
}

function finalizeBytes(h: Harness, bytes: Uint8Array = PDF_BYTES) {
  const transfer = completeTransfer(h, bytes);
  const outcome = finalizeUpload(h.finalize, {
    intentId: transfer.intentId,
    retryId: transfer.retryId,
    bytesDigest: transfer.digest,
    caller: RECEIVER,
  });
  if (outcome.status !== 'finalized') throw new Error(`finalize failed: ${outcome.status}`);
  return { ...transfer, ref: outcome.file.id };
}

describe('finalizeUpload dedupe', () => {
  it('repeats identical evidence with the same reference and rejects conflicts', () => {
    const h = makeHarness();
    const first = finalizeBytes(h);
    const repeat = finalizeUpload(h.finalize, {
      intentId: first.intentId,
      retryId: first.retryId,
      bytesDigest: first.digest,
      caller: RECEIVER,
    });
    expect(repeat.status).toBe('repeated');
    if (repeat.status !== 'repeated') throw new Error('unreachable');
    expect(repeat.file.id).toBe(first.ref);
  });

  it('fails a mismatched retry identity without touching the published file', () => {
    const h = makeHarness();
    const first = finalizeBytes(h);
    const outcome = finalizeUpload(h.finalize, {
      intentId: first.intentId,
      retryId: 'upl_someone-else',
      bytesDigest: first.digest,
      caller: RECEIVER,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'conflict' });
    expect(h.finalize.files.get(first.ref)?.state).toBe('finalized');
  });

  it('fails replacement bytes claimed under the same intent', () => {
    const h = makeHarness();
    const first = finalizeBytes(h);
    const otherDigest = sha256Hex(new TextEncoder().encode('%PDF-1.4\nother\n'));
    const outcome = finalizeUpload(h.finalize, {
      intentId: first.intentId,
      retryId: first.retryId,
      bytesDigest: otherDigest,
      caller: RECEIVER,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'conflict' });
  });

  it('hides intent existence from a foreign caller', () => {
    const h = makeHarness();
    const transfer = completeTransfer(h, PDF_BYTES);
    const outcome = finalizeUpload(h.finalize, {
      intentId: transfer.intentId,
      retryId: transfer.retryId,
      bytesDigest: transfer.digest,
      caller: OTHER_TEAM,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'foreign' });
  });
});

describe('runRetention', () => {
  it('orphans unattached bytes past the horizon and expires them past retention', () => {
    const h = makeHarness();
    const { ref } = finalizeBytes(h);
    h.clock.advanceBy(CONFIG.unattachedHorizonMs + 500);
    const orphaned = runRetention(h.retention, CONFIG);
    expect(orphaned.orphaned).toEqual([ref]);
    expect(orphaned.expired).toEqual([]);
    expect(h.finalize.blobs.read(blobKeyForFile(ref))).toBeNull();
    h.clock.advanceBy(CONFIG.retentionMs);
    const expired = runRetention(h.retention, CONFIG);
    expect(expired.expired).toEqual([ref]);
    expect(h.finalize.files.get(ref)?.state).toBe('expired');
  });

  it('keeps attached bytes past the horizon until retention elapses', () => {
    const h = makeHarness();
    const { ref } = finalizeBytes(h);
    expect(recordAttachment(h.finalize, ref, 'rec_1', RECEIVER).status).toBe('attached');
    h.clock.advanceBy(CONFIG.unattachedHorizonMs + 500);
    const report = runRetention(h.retention, CONFIG);
    expect(report.orphaned).toEqual([]);
    expect(report.expired).toEqual([]);
    expect(h.finalize.files.get(ref)?.state).toBe('attached');
    expect(h.finalize.blobs.read(blobKeyForFile(ref))).not.toBeNull();
  });

  it('sweeps expired intents and reports them once', () => {
    const h = makeHarness();
    const transfer = completeTransfer(h, PDF_BYTES);
    h.clock.advanceBy(INTENT_TTL_MS + 1);
    const report = runRetention(h.retention, CONFIG);
    expect(report.sweptIntents).toEqual([transfer.intentId]);
  });
});

describe('recordAttachment authz', () => {
  it('attaches for the owning receiver and moves the marker last-write-wins', () => {
    const h = makeHarness();
    const { ref } = finalizeBytes(h);
    expect(recordAttachment(h.finalize, ref, 'rec_1', RECEIVER)).toEqual({
      status: 'attached',
      ref,
    });
    expect(recordAttachment(h.finalize, ref, 'rec_2', RECEIVER).status).toBe('attached');
    expect(h.finalize.files.get(ref)?.attachedRecord).toBe('rec_2');
  });

  it('refuses a foreign caller without echoing or mutating the file', () => {
    const h = makeHarness();
    const { ref } = finalizeBytes(h);
    expect(recordAttachment(h.finalize, ref, 'rec_1', OTHER_TEAM)).toEqual({
      status: 'failed',
      reason: 'foreign',
    });
    expect(h.finalize.files.get(ref)?.state).toBe('finalized');
  });

  it('reports unknown references as foreign and rejects empty record refs', () => {
    const h = makeHarness();
    expect(recordAttachment(h.finalize, 'file_nope', 'rec_1', RECEIVER)).toEqual({
      status: 'failed',
      reason: 'foreign',
    });
    const { ref } = finalizeBytes(h);
    expect(() => recordAttachment(h.finalize, ref, '', RECEIVER)).toThrow(RangeError);
  });

  it('reports collected bytes as expired instead of attaching', () => {
    const h = makeHarness();
    const { ref } = finalizeBytes(h);
    h.clock.advanceBy(CONFIG.unattachedHorizonMs + 500);
    expect(runRetention(h.retention, CONFIG).orphaned).toEqual([ref]);
    expect(recordAttachment(h.finalize, ref, 'rec_1', RECEIVER)).toEqual({
      status: 'failed',
      reason: 'expired',
    });
  });
});
