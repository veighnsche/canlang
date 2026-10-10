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
  DEFAULT_FILE_POLICY,
} from '../src/upload/index.js';
import {
  finalizeUpload,
  blobKeyForFile,
  ingestVerifiedEventBytes,
  readFinalizedBytes,
  observeFinalizedFile,
  readFinalizedFileObservation,
  revalidateRetainedFinalizedFile,
  recordAttachment,
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

const OBSERVATION_RETENTION = { unattachedHorizonMs: 60_000, retentionMs: 120_000 };
const OBSERVATION_OPTIONS = { policy: DEFAULT_FILE_POLICY, retention: OBSERVATION_RETENTION };

function finalizedObservationFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'can-file-observation-'));
  const path = join(dir, 'metadata.sqlite');
  let store = createSqliteFileStore(path);
  const h = makeHarness();
  const upload = { ...h.upload, intents: store.intents, blobs: store.blobs };
  const finalize = { ...h.finalize, intents: store.intents, files: store.files, blobs: store.blobs };
  const completed = completedIntent({ ...h, upload });
  const outcome = finalizeUpload(finalize, { ...completed, bytesDigest: completed.digest, caller: RECEIVER });
  assert.equal(outcome.status, 'finalized');
  if (outcome.status !== 'finalized') throw new Error('setup: finalization refused');
  const ref = outcome.file.id;
  return {
    ref, clock: h.clock,
    deps: () => ({ clock: h.clock, files: store.files, blobs: store.blobs }),
    store: () => store,
    binding: () => createSqliteFileBindings(store, { clock: h.clock, intentTtlMs: INTENT_TTL_MS, urlBase: ORIGIN_URL }),
    reopen() { store.close(); store = createSqliteFileStore(path); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe('admitted finalized file facts from real SQLite storage', () => {
  it('observes genuine finalized event item provenance across JSON snapshot and SQLite reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'can-event-observation-'));
    const path = join(dir, 'metadata.sqlite');
    let store = createSqliteFileStore(path);
    const h = makeHarness();
    const deps = () => ({ clock: h.clock, files: store.files, blobs: store.blobs });
    try {
      const saved = [0, 1].map(itemIndex => {
        const provenance = { kind: 'event' as const, source: 'deployment.mail', adapter: 'deployment.mail',
          occurrenceId: 'occ_observed', fieldPath: 'attachments', itemIndex };
        const result = ingestVerifiedEventBytes({ ...h.finalize, intents: store.intents, files: store.files, blobs: store.blobs }, {
          provenance, receiver: RECEIVER, claimedType: 'text/plain', bytes: TEXT_BYTES, policy: DEFAULT_FILE_POLICY,
        });
        assert.equal(result.status, 'finalized');
        if (result.status !== 'finalized') throw new Error('setup: event rejected');
        const observation = readFinalizedFileObservation(observeFinalizedFile(deps(), result.file.id, RECEIVER, OBSERVATION_OPTIONS));
        assert.ok(observation);
        assert.deepEqual(observation.provenance, provenance);
        assert.deepEqual(observation.receiver, RECEIVER);
        assert.equal(observation.bytesDigest, sha256Hex(TEXT_BYTES));
        return JSON.parse(JSON.stringify(observation));
      });
      assert.notEqual(saved[0].ref, saved[1].ref);
      store.close(); store = createSqliteFileStore(path);
      for (const retained of saved) {
        assert.equal(revalidateRetainedFinalizedFile(deps(), retained, RECEIVER, OBSERVATION_OPTIONS), true);
        assert.equal(revalidateRetainedFinalizedFile(deps(), retained, OTHER_PRINCIPAL, OBSERVATION_OPTIONS), false);
        let getters = 0;
        const provenance = Object.defineProperty({ ...retained.provenance }, 'itemIndex', {
          enumerable: true, get() { getters++; return retained.provenance.itemIndex; },
        });
        assert.equal(revalidateRetainedFinalizedFile(deps(), { ...retained, provenance }, RECEIVER, OBSERVATION_OPTIONS), false);
        assert.equal(getters, 0);
        for (const itemIndex of [-1, 0.5, retained.provenance.itemIndex + 1]) {
          assert.equal(revalidateRetainedFinalizedFile(deps(), {
            ...retained, provenance: { ...retained.provenance, itemIndex },
          }, RECEIVER, OBSERVATION_OPTIONS), false);
        }
        const current = store.files.get(retained.ref);
        for (const nowMs of [retained.finalizedAtMs - 1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
          const clocked = { ...deps(), clock: { nowMs: () => nowMs } };
          assert.equal(observeFinalizedFile(clocked, retained.ref, RECEIVER, OBSERVATION_OPTIONS), null);
          assert.equal(revalidateRetainedFinalizedFile(clocked, retained, RECEIVER, OBSERVATION_OPTIONS), false);
        }
        assert.deepEqual(store.files.get(retained.ref), current);
        assert.deepEqual(store.blobs.read(blobKeyForFile(retained.ref)), TEXT_BYTES);
      }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('admits detached frozen JSON-safe facts without writes, rejects copied handles and revalidates after reopen', () => {
    const h = finalizedObservationFixture();
    try {
      const original = h.store().files.get(h.ref)!;
      const beforeIntents = h.store().intents.listAll();
      const handle = observeFinalizedFile(h.deps(), h.ref, RECEIVER, OBSERVATION_OPTIONS);
      assert.ok(handle);
      const saved = readFinalizedFileObservation(handle);
      assert.ok(saved);
      assert.deepEqual(saved, { ref: h.ref, receiver: RECEIVER, provenance: original.file.provenance,
        contentType: original.file.contentType, sizeBytes: PDF_BYTES.length, bytesDigest: sha256Hex(PDF_BYTES),
        finalizedAtMs: original.finalizedAtMs, retention: OBSERVATION_RETENTION });
      assert.notEqual(saved.receiver, RECEIVER);
      assert.notEqual(saved.provenance, original.file.provenance);
      assert.notEqual(saved.retention, OBSERVATION_RETENTION);
      for (const value of [saved, saved.receiver, saved.provenance, saved.retention]) assert.ok(Object.isFrozen(value));
      assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved);
      let shapeReads = 0;
      const accessor = Object.defineProperty({}, 'ref', { enumerable: true, get() { shapeReads++; return h.ref; } });
      const proxy = new Proxy(handle, { get() { shapeReads++; throw new Error('shape read'); },
        ownKeys() { shapeReads++; throw new Error('shape keys'); } });
      for (const forged of [saved, { ...handle }, Object.create(handle), accessor, proxy, null]) {
        assert.equal(readFinalizedFileObservation(forged), null);
      }
      assert.equal(shapeReads, 0);
      assert.deepEqual(h.store().files.get(h.ref), original);
      assert.deepEqual(h.store().intents.listAll(), beforeIntents);
      assert.deepEqual(h.store().blobs.read(blobKeyForFile(h.ref)), PDF_BYTES);
      h.reopen();
      const wire = JSON.parse(JSON.stringify(saved));
      assert.equal(revalidateRetainedFinalizedFile(h.deps(), wire, RECEIVER, OBSERVATION_OPTIONS), true);
      assert.equal(h.binding().revalidateFile(wire, RECEIVER, OBSERVATION_RETENTION), true);
      const installedHandle = h.binding().observeFile(h.ref, RECEIVER, OBSERVATION_RETENTION);
      assert.ok(readFinalizedFileObservation(installedHandle));
      assert.equal(revalidateRetainedFinalizedFile(h.deps(), wire, OTHER_PRINCIPAL, OBSERVATION_OPTIONS), false);
      assert.equal(observeFinalizedFile(h.deps(), h.ref, OTHER_PRINCIPAL, OBSERVATION_OPTIONS), null);
    } finally { h.close(); }
  });

  it('refuses changed owners, missing or same-length changed bytes and altered immutable metadata', () => {
    const h = finalizedObservationFixture();
    try {
      const original = h.store().files.get(h.ref)!;
      const saved = readFinalizedFileObservation(observeFinalizedFile(h.deps(), h.ref, RECEIVER, OBSERVATION_OPTIONS));
      assert.ok(saved);
      const changedBytes = new Uint8Array(PDF_BYTES);
      changedBytes[changedBytes.length - 1] = changedBytes[changedBytes.length - 1]! ^ 1;
      for (const bytes of [null, changedBytes]) {
        if (bytes === null) h.store().blobs.remove(blobKeyForFile(h.ref));
        else h.store().blobs.write(blobKeyForFile(h.ref), bytes);
        assert.equal(revalidateRetainedFinalizedFile(h.deps(), saved, RECEIVER, OBSERVATION_OPTIONS), false);
        assert.equal(observeFinalizedFile(h.deps(), h.ref, RECEIVER, OBSERVATION_OPTIONS), null);
      }
      h.store().blobs.write(blobKeyForFile(h.ref), PDF_BYTES);
      const altered: StoredFileRecord[] = [
        { ...original, owner: OTHER_PRINCIPAL },
        { ...original, file: { ...original.file, bytesDigest: sha256Hex(TEXT_BYTES) } },
        { ...original, file: { ...original.file, contentType: 'text/plain' } },
        { ...original, file: { ...original.file, sizeBytes: PDF_BYTES.length + 1 } },
        { ...original, file: { ...original.file, provenance: { ...BINDING, kind: 'request', ...RECEIVER, deliveryId: 'changed-delivery' } } },
        { ...original, finalizedAtMs: original.finalizedAtMs + 1 },
        { ...original, file: { ...original.file, finalizedAt: { kind: 'datetime', ms: original.file.finalizedAt.ms + 1n } } },
      ];
      for (const row of altered) {
        h.store().files.put(row);
        assert.equal(revalidateRetainedFinalizedFile(h.deps(), saved, RECEIVER, OBSERVATION_OPTIONS), false);
        assert.deepEqual(h.store().files.get(h.ref), row);
      }
      h.store().files.put(original);
      assert.equal(revalidateRetainedFinalizedFile(h.deps(), saved, RECEIVER, OBSERVATION_OPTIONS), true);
      let getterCalls = 0;
      const unsafe = Object.defineProperty({ ...saved }, 'receiver', { enumerable: true, get() { getterCalls++; return RECEIVER; } });
      assert.equal(revalidateRetainedFinalizedFile(h.deps(), unsafe, RECEIVER, OBSERVATION_OPTIONS), false);
      assert.equal(getterCalls, 0);
      assert.equal(revalidateRetainedFinalizedFile(h.deps(), saved, RECEIVER,
        { ...OBSERVATION_OPTIONS, policy: { ...DEFAULT_FILE_POLICY, maxBytes: PDF_BYTES.length - 1 } }), false);
      assert.equal(revalidateRetainedFinalizedFile(h.deps(), saved, RECEIVER,
        { ...OBSERVATION_OPTIONS, policy: { ...DEFAULT_FILE_POLICY, types: ['image/png'] } }), false);
    } finally { h.close(); }
  });

  it('enforces unswept horizons, attachment retention and original policy despite a longer current horizon', () => {
    const h = finalizedObservationFixture();
    try {
      const original = h.store().files.get(h.ref)!;
      const saved = readFinalizedFileObservation(observeFinalizedFile(h.deps(), h.ref, RECEIVER, OBSERVATION_OPTIONS));
      assert.ok(saved);
      const longer = { policy: DEFAULT_FILE_POLICY, retention: { unattachedHorizonMs: 600_000, retentionMs: 1_200_000 } };
      h.clock.setNowMs(original.finalizedAtMs + OBSERVATION_RETENTION.unattachedHorizonMs - 1);
      assert.equal(revalidateRetainedFinalizedFile(h.deps(), saved, RECEIVER, OBSERVATION_OPTIONS), true);
      assert.equal(revalidateRetainedFinalizedFile(h.deps(), saved, RECEIVER,
        { ...OBSERVATION_OPTIONS, retention: { ...OBSERVATION_RETENTION, unattachedHorizonMs: 1 } }), false);
      h.clock.advanceBy(1);
      assert.equal(observeFinalizedFile(h.deps(), h.ref, RECEIVER, OBSERVATION_OPTIONS), null);
      assert.equal(revalidateRetainedFinalizedFile(h.deps(), saved, RECEIVER, longer), false);
      assert.equal(h.store().files.get(h.ref)?.state, 'finalized');
      h.clock.setNowMs(original.finalizedAtMs);
      assert.equal(recordAttachment({ files: h.store().files, clock: h.clock }, h.ref, 'Expense_1/receipt', RECEIVER).status, 'attached');
      const attached = h.store().files.get(h.ref)!;
      const attachedSaved = readFinalizedFileObservation(observeFinalizedFile(h.deps(), h.ref, RECEIVER, OBSERVATION_OPTIONS));
      assert.ok(attachedSaved);
      h.clock.setNowMs(original.finalizedAtMs + OBSERVATION_RETENTION.retentionMs - 1);
      assert.equal(revalidateRetainedFinalizedFile(h.deps(), attachedSaved, RECEIVER, OBSERVATION_OPTIONS), true);
      h.clock.advanceBy(1);
      assert.equal(revalidateRetainedFinalizedFile(h.deps(), attachedSaved, RECEIVER, longer), false);
      assert.equal(observeFinalizedFile(h.deps(), h.ref, RECEIVER, OBSERVATION_OPTIONS), null);
      h.clock.setNowMs(original.finalizedAtMs);
      for (const state of ['orphaned', 'expired'] as const) {
        const terminal = { ...attached, state };
        h.store().files.put(terminal);
        assert.equal(observeFinalizedFile(h.deps(), h.ref, RECEIVER, OBSERVATION_OPTIONS), null);
        assert.equal(revalidateRetainedFinalizedFile(h.deps(), attachedSaved, RECEIVER, longer), false);
        assert.deepEqual(h.store().files.get(h.ref), terminal);
        assert.deepEqual(h.store().blobs.read(blobKeyForFile(h.ref)), PDF_BYTES);
      }
    } finally { h.close(); }
  });

  it('requires a timely persisted first attachment beyond the unattached deadline and never renews it', () => {
    const h = finalizedObservationFixture();
    try {
      const original = h.store().files.get(h.ref)!;
      const saved = readFinalizedFileObservation(observeFinalizedFile(h.deps(), h.ref, RECEIVER, OBSERVATION_OPTIONS));
      assert.ok(saved);
      const deadline = original.finalizedAtMs + OBSERVATION_RETENTION.unattachedHorizonMs;
      h.clock.setNowMs(deadline);
      assert.equal(recordAttachment({ files: h.store().files, clock: h.clock }, h.ref, 'Expense_late', RECEIVER).status, 'attached');
      assert.equal(h.store().files.get(h.ref)?.attachedAtMs, deadline);
      assert.equal(observeFinalizedFile(h.deps(), h.ref, RECEIVER, OBSERVATION_OPTIONS), null);
      assert.equal(revalidateRetainedFinalizedFile(h.deps(), saved, RECEIVER, OBSERVATION_OPTIONS), false);

      h.store().files.put(original);
      h.clock.setNowMs(original.finalizedAtMs);
      assert.equal(recordAttachment({ files: h.store().files }, h.ref, 'Expense_legacy', RECEIVER).status, 'attached');
      assert.equal(h.store().files.get(h.ref)?.attachedAtMs, undefined);
      assert.ok(observeFinalizedFile(h.deps(), h.ref, RECEIVER, OBSERVATION_OPTIONS));
      h.clock.setNowMs(deadline);
      assert.equal(observeFinalizedFile(h.deps(), h.ref, RECEIVER, OBSERVATION_OPTIONS), null);
      assert.equal(revalidateRetainedFinalizedFile(h.deps(), saved, RECEIVER, OBSERVATION_OPTIONS), false);

      h.store().files.put(original);
      const firstAttachment = original.finalizedAtMs + 1;
      h.clock.setNowMs(firstAttachment);
      assert.equal(recordAttachment({ files: h.store().files, clock: h.clock }, h.ref, 'Expense_first', RECEIVER).status, 'attached');
      const timely = readFinalizedFileObservation(observeFinalizedFile(h.deps(), h.ref, RECEIVER, OBSERVATION_OPTIONS));
      assert.ok(timely);
      h.clock.setNowMs(deadline + 1);
      assert.equal(recordAttachment({ files: h.store().files, clock: h.clock }, h.ref, 'Expense_remarked', RECEIVER).status, 'attached');
      assert.equal(h.store().files.get(h.ref)?.attachedAtMs, firstAttachment);
      assert.equal(h.store().files.get(h.ref)?.attachedRecord, 'Expense_remarked');
      h.reopen();
      assert.equal(h.store().files.get(h.ref)?.attachedAtMs, firstAttachment);
      assert.equal(revalidateRetainedFinalizedFile(h.deps(), timely, RECEIVER, OBSERVATION_OPTIONS), true);
      assert.equal(revalidateRetainedFinalizedFile(h.deps(), timely, RECEIVER, {
        ...OBSERVATION_OPTIONS, retention: { ...OBSERVATION_RETENTION, unattachedHorizonMs: 1 },
      }), false);
    } finally { h.close(); }
  });
});

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
      assert.equal(binding.append(created.intentId, RECEIVER, PDF_BYTES, 0).status, 'appended');
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
    assert.equal(binding.append(created.intentId, RECEIVER, PDF_BYTES, 0).status, 'appended');
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
