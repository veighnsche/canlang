/**
 * S5 retention: unattached objects are collected after the horizon,
 * attached bytes survive until retention, and expired bytes redact from
 * receipt projections while metadata survives.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteFileStore, createSqliteFileBindings } from '../src/host/sqlite.js';
import { createFsBlobStore } from '../src/upload/fs-blob-store.js';
import {
  appendUploadContent,
  completeUploadContent,
  sha256Hex,
  stagingKeyForIntent,
} from '../src/upload/index.js';
import {
  finalizeUpload,
  readFinalizedBytes,
  recordAttachment,
  authorizeAttach,
  blobKeyForFile,
  storedState,
} from '../src/finalize/index.js';
import { describeForReceipt, runRetention, runRetentionBatch } from '../src/retention/index.js';
import { handleCreateIntent } from '../src/bridge.js';
import {
  BINDING,
  INTENT_TTL_MS,
  PDF_BYTES,
  RECEIVER,
  makeHarness,
  uploadRequest,
} from './helpers.js';

const HORIZON_MS = 60 * 60 * 1000;
const RETENTION_MS = 24 * HORIZON_MS;

function durablePending(dir: string, phase: 'bytes' | 'row' | 'pointer', ttl = INTENT_TTL_MS) {
  let store = createSqliteFileStore(join(dir, 'metadata.sqlite'));
  let blobs = createFsBlobStore(join(dir, 'blobs'));
  const h = makeHarness();
  const upload = { ...h.upload, intents: store.intents, blobs, intentTtlMs: ttl };
  const request = uploadRequest();
  const created = handleCreateIntent(h.bridge, upload, {}, request, BINDING);
  assert.equal(created.status, 'granted');
  if (created.status !== 'granted') throw new Error('setup: intent grant failed');
  assert.equal(appendUploadContent(upload, created.intentId, RECEIVER, PDF_BYTES).status, 'appended');
  assert.equal(completeUploadContent(upload, created.intentId, RECEIVER).status, 'completed');
  const finalize = () => ({ ...h.finalize, intents: store.intents, files: store.files, blobs });
  const input = { intentId: created.intentId, retryId: request.upload_id, bytesDigest: sha256Hex(PDF_BYTES), caller: RECEIVER };
  const crash = new Error('Interrupted durable publication');
  const deps = finalize();
  assert.throws(() => finalizeUpload({ ...deps,
    blobs: { read: blobs.read.bind(blobs), sizeOf: blobs.sizeOf.bind(blobs), append: blobs.append.bind(blobs), remove: blobs.remove.bind(blobs),
      write(key, bytes) { blobs.write(key, bytes); if (phase === 'bytes') throw crash; } },
    files: { ...store.files, put(row) { store.files.put(row); if (phase === 'row') throw crash; } },
    intents: { ...store.intents, put(row) { store.intents.put(row); if (phase === 'pointer' && row.state === 'finalized') throw crash; } },
  }, input), error => error === crash);
  const intent = store.intents.get(created.intentId);
  assert.ok(intent?.pendingFinalization);
  const ref = intent.pendingFinalization.ref;
  return {
    clock: h.clock, input, ref, finalize,
    retention: () => ({ clock: h.clock, intents: store.intents, files: store.files, blobs }),
    reopen() { store.close(); store = createSqliteFileStore(join(dir, 'metadata.sqlite')); blobs = createFsBlobStore(join(dir, 'blobs')); },
    close() { store.close(); },
  };
}

const DURABLE_POLICY = { unattachedHorizonMs: HORIZON_MS, retentionMs: RETENTION_MS };

function sqliteRetentionHarness(store: ReturnType<typeof createSqliteFileStore>) {
  const h = makeHarness();
  return { ...h, intents: store.intents, files: store.files, blobs: store.blobs,
    upload: { ...h.upload, intents: store.intents, blobs: store.blobs },
    finalize: { ...h.finalize, intents: store.intents, files: store.files, blobs: store.blobs },
    retention: { clock: h.clock, intents: store.intents, files: store.files, blobs: store.blobs },
  };
}

describe('bounded retention with real SQLite pages', () => {
  it('shares the row budget across ordered collections, resumes after reopen and restarts with fresh time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'can-retention-pages-'));
    const path = join(dir, 'metadata.sqlite');
    let store = createSqliteFileStore(path);
    const h = sqliteRetentionHarness(store);
    try {
      const refs = [finalizedRef(h), finalizedRef(h), finalizedRef(h)];
      assert.equal(recordAttachment(h.finalize, refs[1]!, 'Expense_shared', RECEIVER).status, 'attached');
      h.clock.advanceBy(HORIZON_MS + 1);
      const created = handleCreateIntent(h.bridge, h.upload, {}, uploadRequest(), BINDING);
      assert.equal(created.status, 'granted');
      if (created.status !== 'granted') throw new Error('setup: intent refused');
      const expectedIntents = store.intents.listAll().map(row => row.intentId).sort();
      const visits: string[] = [];
      let clockReads = 0;
      const deps = () => ({ clock: { nowMs() { clockReads++; return h.clock.nowMs(); } }, blobs: store.blobs,
        intents: { ...store.intents, listAll() { throw new Error('unbounded intent read'); },
          listAfter(after: string | null, limit: number) { const rows = store.intents.listAfter(after, limit); visits.push(...rows.map(row => `intent:${row.intentId}`)); return rows; } },
        files: { ...store.files, listAll() { throw new Error('unbounded file read'); },
          listAfter(after: string | null, limit: number) { const rows = store.files.listAfter(after, limit); visits.push(...rows.map(row => `file:${row.file.id}`)); return rows; } },
      });
      let cursor: ReturnType<typeof runRetentionBatch>['next'] = null;
      const orphaned: string[] = [];
      const processed: number[] = [];
      do {
        const before = visits.length;
        const report = runRetentionBatch(deps(), DURABLE_POLICY, { limit: 2, cursor });
        assert.equal(report.processed, visits.length - before);
        assert.ok(report.processed <= 2);
        assert.equal(report.metadataReads, report.processed);
        assert.deepEqual(report.expired, []);
        assert.deepEqual(report.sweptIntents, []);
        orphaned.push(...report.orphaned); processed.push(report.processed); cursor = report.next;
        store.close(); store = createSqliteFileStore(path);
      } while (cursor !== null);
      assert.deepEqual(processed, [2, 2, 2, 1]);
      assert.equal(clockReads, 4);
      assert.deepEqual(visits, [...expectedIntents.map(id => `intent:${id}`), ...refs.slice().sort().map(id => `file:${id}`)]);
      assert.deepEqual(orphaned.sort(), [refs[0], refs[2]].sort());
      assert.equal(store.intents.get(created.intentId)?.state, 'open');
      assert.equal(store.files.get(refs[1]!)?.state, 'attached');
      assert.equal(store.files.get(refs[1]!)?.attachedRecord, 'Expense_shared');
      assert.deepEqual(store.blobs.read(blobKeyForFile(refs[1]!)), PDF_BYTES);
      const original = store.intents.get(created.intentId)!;
      store.intents.put({ ...original, intentId: '000-earlier', retryId: 'earlier-retry' });
      h.clock.advanceBy(RETENTION_MS);
      const restarted = runRetentionBatch(deps(), DURABLE_POLICY, { limit: 1000, cursor: null });
      assert.equal(restarted.next, null);
      assert.equal(restarted.processed, 8);
      assert.deepEqual(restarted.sweptIntents.sort(), ['000-earlier', created.intentId].sort());
      assert.deepEqual(restarted.expired.sort(), refs.slice().sort());
      assert.equal(clockReads, 5);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not decode an untouched malformed tail or look ahead past an exact full page', () => {
    const dir = mkdtempSync(join(tmpdir(), 'can-retention-tail-'));
    const path = join(dir, 'metadata.sqlite');
    const store = createSqliteFileStore(path);
    const h = sqliteRetentionHarness(store);
    try {
      const created = handleCreateIntent(h.bridge, h.upload, {}, uploadRequest(), BINDING);
      assert.equal(created.status, 'granted');
      if (created.status !== 'granted') throw new Error('setup: intent refused');
      const db = new DatabaseSync(path);
      try { db.prepare('INSERT INTO files_upload_intents (id, retry_id, json) VALUES (?, ?, ?)').run('zzzz-tail', 'tail-retry', '{'); }
      finally { db.close(); }
      const first = runRetentionBatch(h.retention, DURABLE_POLICY, { limit: 1 });
      assert.equal(first.processed, 1);
      assert.deepEqual(first.next, { phase: 'intents', after: created.intentId });
      assert.equal(store.intents.get(created.intentId)?.state, 'open');
      assert.throws(() => runRetentionBatch(h.retention, DURABLE_POLICY, { limit: 1, cursor: first.next }), SyntaxError);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('rolls back interrupted SQLite cleanup and retries the same cursor after reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'can-retention-rollback-'));
    const path = join(dir, 'metadata.sqlite');
    let store = createSqliteFileStore(path);
    const h = sqliteRetentionHarness(store);
    try {
      const ref = finalizedRef(h);
      assert.equal(recordAttachment(h.finalize, ref, 'Expense_saved', RECEIVER).status, 'attached');
      const original = store.files.get(ref);
      h.clock.advanceBy(RETENTION_MS);
      const cursor = { phase: 'files' as const, after: null };
      const fault = new Error('SQLite cleanup interrupted');
      const broken = { ...store, blobs: { ...store.blobs, remove(key: string) {
        assert.equal(store.files.get(ref)?.state, 'expired');
        store.blobs.remove(key); throw fault;
      } } };
      const options = { clock: h.clock, intentTtlMs: INTENT_TTL_MS, urlBase: 'https://app.example.test' };
      assert.throws(() => createSqliteFileBindings(broken, options).runRetentionBatch(DURABLE_POLICY, { limit: 1, cursor }), error => error === fault);
      store.close(); store = createSqliteFileStore(path);
      assert.deepEqual(store.files.get(ref), original);
      assert.deepEqual(store.blobs.read(blobKeyForFile(ref)), PDF_BYTES);
      const bindings = createSqliteFileBindings(store, options);
      const retried = bindings.runRetentionBatch(DURABLE_POLICY, { limit: 1, cursor });
      assert.deepEqual(retried.expired, [ref]);
      assert.equal(retried.processed, 1);
      assert.deepEqual(retried.next, { phase: 'files', after: ref });
      assert.equal(store.files.get(ref)?.state, 'expired');
      assert.equal(store.files.get(ref)?.attachedRecord, 'Expense_saved');
      assert.deepEqual(store.files.get(ref)?.file, original?.file);
      assert.equal(store.blobs.read(blobKeyForFile(ref)), null);
      assert.equal(bindings.runRetentionBatch(DURABLE_POLICY, { limit: 1, cursor: retried.next }).next, null);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('retries separate FS cleanup from the old cursor without repeating a terminal transition', () => {
    const dir = mkdtempSync(join(tmpdir(), 'can-retention-page-fs-'));
    const h = durablePending(dir, 'bytes');
    try {
      h.clock.advanceBy(INTENT_TTL_MS + 1);
      const deps = h.retention();
      const fault = new Error('FS batch cleanup interrupted');
      assert.throws(() => runRetentionBatch({ ...deps, blobs: { ...deps.blobs,
        read: deps.blobs.read.bind(deps.blobs), sizeOf: deps.blobs.sizeOf.bind(deps.blobs),
        write: deps.blobs.write.bind(deps.blobs), append: deps.blobs.append.bind(deps.blobs),
        remove(key: string) { assert.equal(deps.intents.get(h.input.intentId)?.state, 'expired'); deps.blobs.remove(key); throw fault; },
      } }, DURABLE_POLICY, { limit: 1 }), error => error === fault);
      h.reopen();
      const retried = runRetentionBatch(h.retention(), DURABLE_POLICY, { limit: 1 });
      assert.equal(retried.processed, 1);
      assert.deepEqual(retried.sweptIntents, []);
      assert.equal(h.retention().blobs.read(stagingKeyForIntent(h.input.intentId)), null);
      assert.equal(h.retention().blobs.read(blobKeyForFile(h.ref)), null);
      assert.equal(h.retention().intents.get(h.input.intentId)?.state, 'expired');
      assert.equal(h.retention().files.get(h.ref), null);
    } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('bounds and reports the auxiliary metadata lookup that protects a published pending file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'can-retention-page-published-'));
    const h = durablePending(dir, 'row');
    try {
      h.clock.advanceBy(INTENT_TTL_MS + 1);
      const deps = h.retention();
      const original = deps.files.get(h.ref);
      let pageRows = 0;
      let lookups = 0;
      const report = runRetentionBatch({ ...deps,
        intents: { ...deps.intents, listAfter(after, limit) {
          const rows = deps.intents.listAfter(after, limit); pageRows += rows.length; return rows;
        } },
        files: { ...deps.files, get(ref) { lookups++; return deps.files.get(ref); },
          listAfter() { throw new Error('file page read past the combined traversal budget'); } },
      }, DURABLE_POLICY, { limit: 1 });
      assert.equal(report.processed, 1);
      assert.equal(pageRows, 1);
      assert.equal(lookups, 1);
      assert.equal(report.metadataReads, pageRows + lookups);
      assert.equal(report.metadataReads, 2);
      assert.deepEqual(report.sweptIntents, [h.input.intentId]);
      assert.deepEqual(report.next, { phase: 'intents', after: h.input.intentId });
      assert.equal(deps.intents.get(h.input.intentId)?.state, 'expired');
      assert.deepEqual(deps.files.get(h.ref), original);
      assert.deepEqual(deps.blobs.read(blobKeyForFile(h.ref)), PDF_BYTES);
      assert.equal(deps.blobs.read(stagingKeyForIntent(h.input.intentId)), null);
    } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses invalid limits and cursors before paged or legacy collection reads', () => {
    const h = makeHarness();
    let reads = 0;
    const refuse = () => { reads++; throw new Error('storage read before validation'); };
    const deps = { ...h.retention,
      intents: { get: h.intents.get.bind(h.intents), getByRetryId: h.intents.getByRetryId.bind(h.intents),
        put: h.intents.put.bind(h.intents), listAll: refuse, listAfter: refuse },
      files: { get: h.files.get.bind(h.files), put: h.files.put.bind(h.files), listAll: refuse, listAfter: refuse } };
    type Options = Parameters<typeof runRetentionBatch>[2];
    for (const limit of [0, -1, 1.5, NaN, Infinity, 1001]) {
      assert.throws(() => runRetentionBatch(deps, DURABLE_POLICY, { limit }));
    }
    for (const cursor of [{ phase: 'other', after: null }, { phase: 'files' },
      { phase: 'intents', after: 3 }, 'files', []]) {
      assert.throws(() => runRetentionBatch(deps, DURABLE_POLICY, { limit: 1, cursor } as unknown as Options));
    }
    assert.equal(reads, 0);
  });
});

describe('real SQLite metadata and FS publication retention', () => {
  for (const interrupted of [false, true]) {
    it(`expires unpublished pending bytes${interrupted ? ' across interrupted cleanup and reopen' : ' exactly once'}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'can-pending-retention-'));
      const h = durablePending(dir, 'bytes');
      try {
        h.clock.advanceBy(INTENT_TTL_MS + 1);
        const deps = h.retention();
        if (interrupted) {
          assert.throws(() => runRetention({ ...deps, blobs: {
            read: deps.blobs.read.bind(deps.blobs), sizeOf: deps.blobs.sizeOf.bind(deps.blobs), write: deps.blobs.write.bind(deps.blobs), append: deps.blobs.append.bind(deps.blobs),
            remove(key) {
              assert.equal(deps.intents.get(h.input.intentId)?.state, 'expired');
              deps.blobs.remove(key);
              throw new Error('Interrupted terminal cleanup');
            },
          } }, DURABLE_POLICY), /Interrupted terminal cleanup/);
          assert.equal(deps.intents.get(h.input.intentId)?.state, 'expired');
          assert.deepEqual(deps.blobs.read(blobKeyForFile(h.ref)), PDF_BYTES);
        } else {
          assert.deepEqual(runRetention(deps, DURABLE_POLICY), { orphaned: [], expired: [], sweptIntents: [h.input.intentId] });
        }
        h.reopen();
        assert.deepEqual(runRetention(h.retention(), DURABLE_POLICY), { orphaned: [], expired: [], sweptIntents: [] });
        assert.equal(h.retention().blobs.read(stagingKeyForIntent(h.input.intentId)), null);
        assert.equal(h.retention().blobs.read(blobKeyForFile(h.ref)), null);
        assert.equal(h.retention().files.get(h.ref), null);
        assert.deepEqual(finalizeUpload(h.finalize(), h.input), { status: 'failed', reason: 'expired' });
      } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  }

  it('cleans rejected unpublished claims without reporting another expiry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'can-rejected-retention-'));
    const h = durablePending(dir, 'bytes');
    try {
      const intent = h.retention().intents.get(h.input.intentId)!;
      h.retention().intents.put({ ...intent, state: 'rejected' });
      h.reopen();
      assert.deepEqual(runRetention(h.retention(), DURABLE_POLICY), { orphaned: [], expired: [], sweptIntents: [] });
      assert.equal(h.retention().blobs.read(stagingKeyForIntent(h.input.intentId)), null);
      assert.equal(h.retention().blobs.read(blobKeyForFile(h.ref)), null);
      assert.equal(h.retention().intents.get(h.input.intentId)?.state, 'rejected');
    } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('protects a published pending row until its owning horizon', () => {
    const dir = mkdtempSync(join(tmpdir(), 'can-published-retention-'));
    const h = durablePending(dir, 'row');
    try {
      const published = h.retention().files.get(h.ref);
      h.clock.advanceBy(INTENT_TTL_MS + 1);
      assert.deepEqual(runRetention(h.retention(), DURABLE_POLICY), { orphaned: [], expired: [], sweptIntents: [h.input.intentId] });
      h.reopen();
      assert.deepEqual(h.retention().files.get(h.ref), published);
      assert.deepEqual(h.retention().blobs.read(blobKeyForFile(h.ref)), PDF_BYTES);
      assert.equal(h.retention().blobs.read(stagingKeyForIntent(h.input.intentId)), null);
      h.clock.advanceBy(HORIZON_MS);
      assert.deepEqual(runRetention(h.retention(), DURABLE_POLICY), { orphaned: [h.ref], expired: [], sweptIntents: [] });
      assert.equal(h.retention().blobs.read(blobKeyForFile(h.ref)), null);
      assert.equal(h.retention().files.get(h.ref)?.state, 'orphaned');
    } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('cleans finalized leftover staging without deleting or resurrecting final bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'can-finalized-retention-'));
    const h = durablePending(dir, 'pointer');
    try {
      assert.deepEqual(runRetention(h.retention(), DURABLE_POLICY), { orphaned: [], expired: [], sweptIntents: [] });
      assert.equal(h.retention().blobs.read(stagingKeyForIntent(h.input.intentId)), null);
      assert.deepEqual(h.retention().blobs.read(blobKeyForFile(h.ref)), PDF_BYTES);
      h.clock.advanceBy(HORIZON_MS + 1);
      assert.deepEqual(runRetention(h.retention(), DURABLE_POLICY), { orphaned: [h.ref], expired: [], sweptIntents: [] });
      h.reopen();
      const before = h.retention().files.get(h.ref);
      const intent = h.retention().intents.get(h.input.intentId);
      const repeated = finalizeUpload(h.finalize(), h.input);
      assert.equal(repeated.status, 'repeated');
      if (repeated.status !== 'repeated') throw new Error('repeat refused');
      assert.equal(repeated.file.id, h.ref);
      assert.equal(h.retention().blobs.read(blobKeyForFile(h.ref)), null);
      assert.deepEqual(h.retention().files.get(h.ref), before);
      assert.deepEqual(h.retention().intents.get(h.input.intentId), intent);
      assert.equal(h.retention().intents.get(h.input.intentId)?.finalizedRef, h.ref);
      assert.equal(h.retention().files.listAll().length, 1);
    } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  for (const state of ['orphaned', 'expired'] as const) {
    it(`refuses a complete pending claim after its published row becomes ${state}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'can-pending-tombstone-'));
      const h = durablePending(dir, 'row', RETENTION_MS * 2);
      try {
        h.clock.advanceBy(state === 'orphaned' ? HORIZON_MS + 1 : RETENTION_MS + 1);
        const report = runRetention(h.retention(), DURABLE_POLICY);
        assert.deepEqual(report, { orphaned: state === 'orphaned' ? [h.ref] : [], expired: state === 'expired' ? [h.ref] : [], sweptIntents: [] });
        h.reopen();
        const before = h.retention().intents.get(h.input.intentId);
        assert.equal(before?.state, 'complete');
        const published = h.retention().files.get(h.ref);
        assert.equal(published?.state, state);
        assert.deepEqual(finalizeUpload(h.finalize(), h.input), { status: 'failed', reason: 'expired' });
        assert.deepEqual(h.retention().intents.get(h.input.intentId), before);
        assert.deepEqual(h.retention().files.get(h.ref), published);
        assert.equal(h.retention().blobs.read(blobKeyForFile(h.ref)), null);
        assert.deepEqual(h.retention().blobs.read(stagingKeyForIntent(h.input.intentId)), PDF_BYTES);
      } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

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

  it('refuses invalid policy or clock before changing metadata or bytes', () => {
    const h = makeHarness(); const ref = finalizedRef(h);
    const metadata = h.files.get(ref);
    for (const nowMs of [NaN, Infinity, -1]) {
      assert.throws(() => runRetention({ ...h.retention, clock: { nowMs: () => nowMs } },
        { unattachedHorizonMs: HORIZON_MS, retentionMs: RETENTION_MS }), /clock/);
    }
    for (const value of [NaN, Infinity, -1]) {
      assert.throws(() => runRetention(h.retention, { unattachedHorizonMs: value, retentionMs: RETENTION_MS }), /horizons/);
      assert.throws(() => runRetention(h.retention, { unattachedHorizonMs: HORIZON_MS, retentionMs: value }), /horizons/);
    }
    assert.deepEqual(h.files.get(ref), metadata);
    assert.deepEqual(readFinalizedBytes(h.finalize, ref, RECEIVER), PDF_BYTES);
  });

  it('terminal file metadata refuses reads and attachments until interrupted byte cleanup retries', () => {
    const h = makeHarness(); const ref = finalizedRef(h);
    const original = h.files.get(ref)!;
    h.clock.advanceBy(RETENTION_MS);
    const config = { unattachedHorizonMs: HORIZON_MS, retentionMs: RETENTION_MS };
    let interrupted = false;
    assert.throws(() => runRetention({ ...h.retention, blobs: { ...h.blobs,
      write: h.blobs.write.bind(h.blobs), append: h.blobs.append.bind(h.blobs),
      read: h.blobs.read.bind(h.blobs), sizeOf: h.blobs.sizeOf.bind(h.blobs),
      remove(key) { interrupted = true; assert.equal(key, blobKeyForFile(ref)); throw new Error('Byte cleanup interrupted'); },
    } }, config), /cleanup interrupted/);
    assert.equal(interrupted, true);
    assert.equal(h.files.get(ref)?.state, 'expired');
    assert.deepEqual(h.files.get(ref)?.file, original.file);
    assert.equal(h.blobs.sizeOf(blobKeyForFile(ref)), PDF_BYTES.length);
    assert.equal(readFinalizedBytes(h.finalize, ref, RECEIVER), null);
    assert.deepEqual(authorizeAttach(h.finalize, ref, RECEIVER), { status: 'failed', reason: 'expired' });
    assert.equal(describeForReceipt(h.retention, ref)?.status, 'redacted');
    assert.deepEqual(runRetention(h.retention, config), { orphaned: [], expired: [], sweptIntents: [] });
    assert.equal(h.blobs.sizeOf(blobKeyForFile(ref)), null);
  });
});
