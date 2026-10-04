/**
 * S5 foreign containment: foreign IDs and URLs can never attach, read,
 * finalize or be disclosed; cross-principal/team callers fail closed.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeBlobKey } from '../src/ports.ts';
import {
  appendUploadContent,
  completeUploadContent,
  sha256Hex,
} from '../src/upload/index.ts';
import { createFsBlobStore } from '../src/upload/fs-blob-store.ts';
import {
  authorizeAttach,
  finalizeUpload,
  readFinalizedBytes,
  recordAttachment,
} from '../src/finalize/index.ts';
import { describeForReceipt } from '../src/retention/index.ts';
import { handleCreateIntent } from '../src/bridge.ts';
import {
  BINDING,
  OTHER_PRINCIPAL,
  OTHER_TEAM,
  PDF_BYTES,
  RECEIVER,
  makeHarness,
  uploadRequest,
} from './helpers.ts';

const scopeDir = mkdtempSync(join(tmpdir(), 'canlang-files-foreign-'));
after(() => {
  rmSync(scopeDir, { recursive: true, force: true });
});

const EVIL_URL = 'https://attacker.test/evil.pdf?token=secret';

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

describe('foreign containment', () => {
  it('foreign URLs never attach and are never disclosed', () => {
    const h = makeHarness();
    finalizedRef(h);
    const authorized = authorizeAttach(h.finalize, EVIL_URL, RECEIVER);
    assert.deepEqual(authorized, { status: 'failed', reason: 'foreign' });
    const recorded = recordAttachment(h.finalize, EVIL_URL, 'Expense_1', RECEIVER);
    assert.deepEqual(recorded, { status: 'failed', reason: 'foreign' });
    assert.equal(readFinalizedBytes(h.finalize, EVIL_URL, RECEIVER), null);
    assert.equal(describeForReceipt(h.retention, EVIL_URL), null);
    assert.ok(!JSON.stringify(authorized).includes('attacker'));
    assert.ok(!JSON.stringify(recorded).includes('attacker'));
  });

  it('unknown well-formed references fail exactly like foreign ones', () => {
    const h = makeHarness();
    const own = finalizedRef(h);
    const unknown = authorizeAttach(h.finalize, 'file_999', RECEIVER);
    const crossTeam = authorizeAttach(h.finalize, own, OTHER_TEAM);
    assert.deepEqual(unknown, { status: 'failed', reason: 'foreign' });
    assert.deepEqual(crossTeam, { status: 'failed', reason: 'foreign' });
    assert.deepEqual(unknown, crossTeam);
  });

  it('cross-principal callers cannot read or attach', () => {
    const h = makeHarness();
    const ref = finalizedRef(h);
    assert.deepEqual(authorizeAttach(h.finalize, ref, OTHER_PRINCIPAL), {
      status: 'failed',
      reason: 'foreign',
    });
    assert.deepEqual(
      recordAttachment(h.finalize, ref, 'Expense_1', OTHER_PRINCIPAL),
      { status: 'failed', reason: 'foreign' },
    );
    assert.equal(readFinalizedBytes(h.finalize, ref, OTHER_PRINCIPAL), null);
  });

  it('cross-team callers cannot append, complete or finalize', () => {
    const h = makeHarness();
    const request = uploadRequest();
    const created = handleCreateIntent(h.bridge, h.upload, {}, request, BINDING);
    assert.equal(created.status, 'granted');
    if (created.status !== 'granted') {
      return;
    }
    assert.deepEqual(
      appendUploadContent(h.upload, created.intentId, OTHER_TEAM, PDF_BYTES),
      { status: 'failed', reason: 'foreign' },
    );
    assert.deepEqual(completeUploadContent(h.upload, created.intentId, OTHER_TEAM), {
      status: 'failed',
      reason: 'foreign',
    });
    assert.equal(
      appendUploadContent(h.upload, created.intentId, RECEIVER, PDF_BYTES).status,
      'appended',
    );
    assert.equal(
      completeUploadContent(h.upload, created.intentId, RECEIVER).status,
      'completed',
    );
    assert.deepEqual(
      finalizeUpload(h.finalize, {
        intentId: created.intentId,
        retryId: request.upload_id,
        bytesDigest: sha256Hex(PDF_BYTES),
        caller: OTHER_TEAM,
      }),
      { status: 'failed', reason: 'foreign' },
    );
    assert.equal(h.files.listAll().length, 0);
  });

  it('unknown intent ids fail closed without an existence oracle', () => {
    const h = makeHarness();
    assert.deepEqual(
      appendUploadContent(h.upload, 'intent_999', RECEIVER, PDF_BYTES),
      { status: 'failed', reason: 'foreign' },
    );
    assert.deepEqual(completeUploadContent(h.upload, 'intent_999', RECEIVER), {
      status: 'failed',
      reason: 'foreign',
    });
    assert.deepEqual(
      finalizeUpload(h.finalize, {
        intentId: 'intent_999',
        retryId: 'upl_999',
        bytesDigest: sha256Hex(PDF_BYTES),
        caller: RECEIVER,
      }),
      { status: 'failed', reason: 'foreign' },
    );
  });

  it('path-shaped references never reach the filesystem', () => {
    const h = makeHarness({ blobs: createFsBlobStore(scopeDir) });
    finalizedRef(h);
    for (const hostile of ['../../etc/passwd', '..\\x', 'a/b', '', 'f_x.bin\u0000']) {
      assert.deepEqual(authorizeAttach(h.finalize, hostile, RECEIVER), {
        status: 'failed',
        reason: 'foreign',
      });
      assert.equal(readFinalizedBytes(h.finalize, hostile, RECEIVER), null);
    }
    assert.throws(() => assertSafeBlobKey('../../etc/passwd'));
    assert.throws(() => assertSafeBlobKey('a/b'));
    assert.throws(() => assertSafeBlobKey(''));
  });

  it('hostile metadata cannot steer grant destinations', () => {
    const h = makeHarness();
    const created = handleCreateIntent(
      h.bridge,
      h.upload,
      {},
      uploadRequest({
        name: EVIL_URL,
        arguments: { note: EVIL_URL },
      }),
      BINDING,
    );
    assert.equal(created.status, 'granted');
    if (created.status !== 'granted') {
      return;
    }
    assert.ok(created.grant.content.startsWith('https://app.example.test/files/content/'));
    assert.ok(created.grant.finalize.startsWith('https://app.example.test/files/finalize/'));
    assert.ok(!created.grant.content.includes('attacker'));
    assert.ok(!created.grant.finalize.includes('attacker'));
  });
});
