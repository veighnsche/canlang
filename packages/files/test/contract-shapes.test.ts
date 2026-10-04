/**
 * S2 conformance: files contract shapes accept their documented fixtures.
 * Compile-time assignability plus runtime shape assertions; intake and
 * finalization behavior lands with the `@canlang/files` implementation (S5+).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ContentCheck,
  FilePolicy,
  FileProvenance,
  FileTransferMeta,
  FinalizeResult,
  FinalizedFile,
  UploadIntentGrant,
  UploadIntentRequest,
} from '../../contracts/src/files.js';
import type {
  FILE_TRANSFER_META_KEY as WireFileTransferMetaKey,
  FileTransferMeta as WireFileTransferMeta,
  UploadFinalizeResponse,
  UploadIntentRequest as WireUploadIntentRequest,
  UploadIntentResponse,
} from '../../contracts/src/wire.js';
import { FILE_TRANSFER_META_KEY } from '../src/bridge.ts';

describe('files contracts', () => {
  it('models the upload intent request and grant', () => {
    const request: UploadIntentRequest = {
      upload_id: 'upl_1',
      operation: 'expense.Expense.create',
      field: '/receipt',
      arguments: { amount: { minor: '2500', currency: 'EUR' } },
      name: 'receipt.pdf',
      type: 'application/pdf',
      size: '1048576',
    };
    const grant: UploadIntentGrant = {
      intent_id: 'intent_1',
      content: 'https://app.example.test/files/content/intent_1',
      finalize: 'https://app.example.test/files/finalize/intent_1',
      expires_at: '2026-10-04T16:00:00Z',
    };
    assert.equal(request.size, '1048576');
    assert.ok(!('receipt' in request.arguments));
    assert.ok(grant.content.startsWith('https://app.example.test/'));
  });

  it('bridge shapes converge with the lane-6 wire route contract', () => {
    // Re-exported names are the wire declarations (same symbol); if
    // either side re-declares with a divergent shape, these pins fail
    // to compile.
    type Equal<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;
    const requestIsWire: Equal<UploadIntentRequest, WireUploadIntentRequest> =
      true;
    const metaIsWire: Equal<FileTransferMeta, WireFileTransferMeta> = true;
    // Literal tripwire: both key consts must stay the same string.
    const keyIsWire: Equal<
      typeof FILE_TRANSFER_META_KEY,
      typeof WireFileTransferMetaKey
    > = true;
    assert.equal(requestIsWire, true);
    assert.equal(metaIsWire, true);
    assert.equal(keyIsWire, true);
    assert.equal(FILE_TRANSFER_META_KEY, 'org.canlang/fileTransfer');
    // Lifecycle outputs satisfy the wire route responses one way: the
    // bridge returns these over L6-owned routes.
    const grant: UploadIntentGrant = {
      intent_id: 'intent_1',
      content: 'https://app.example.test/files/content/intent_1',
      finalize: 'https://app.example.test/files/finalize/intent_1',
      expires_at: '2026-10-04T16:00:00Z',
    };
    const routeGrant: UploadIntentResponse = grant;
    const result: FinalizeResult = { file: 'file_1' };
    const routeResult: UploadFinalizeResponse = result;
    assert.equal(routeGrant.intent_id, 'intent_1');
    assert.equal(routeResult.file, 'file_1');
  });

  it('finalizes intents into opaque immutable references', () => {
    const result: FinalizeResult = { file: 'file_1' };
    assert.deepEqual(Object.keys(result), ['file']);
  });

  it('checks claimed content against validated bytes', () => {
    const check: ContentCheck = {
      claimedType: 'application/pdf',
      detectedType: 'application/pdf',
      sizeBytes: 1048576,
      verdict: 'accepted',
    };
    const policy: FilePolicy = {
      types: ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'],
      maxBytes: 10 * 1024 * 1024,
    };
    assert.equal(check.verdict, 'accepted');
    assert.equal(policy.maxBytes, 10485760);
  });

  it('binds request and event provenance at finalization', () => {
    const requestProvenance: FileProvenance = {
      kind: 'request',
      app: 'CanExpense',
      team: 'team_1',
      owner: 'team_1',
      principal: 'user_1',
      adapter: 'deployment.mail',
      deliveryId: 'del_1',
      resultPath: 'attachments[0]',
    };
    const eventProvenance: FileProvenance = {
      kind: 'event',
      source: 'deployment.mail',
      adapter: 'deployment.mail',
      occurrenceId: 'occ_1',
      fieldPath: 'attachments',
      itemIndex: 0,
    };
    const file: FinalizedFile = {
      id: 'file_1',
      provenance: requestProvenance,
      contentType: 'application/pdf',
      sizeBytes: 1048576,
      bytesDigest: 'sha256:def',
      finalizedAt: {
        kind: 'datetime',
        ms: BigInt(Date.parse('2026-10-04T15:00:00Z')),
      },
    };
    assert.equal(requestProvenance.kind, 'request');
    assert.equal(eventProvenance.itemIndex, 0);
    assert.equal(file.provenance.kind, 'request');
  });

  it('advertises the v1 file-transfer bridge metadata', () => {
    const meta: FileTransferMeta = {
      version: 1,
      intents: 'https://app.example.test/files/intents',
    };
    assert.equal(meta.version, 1);
  });
});
