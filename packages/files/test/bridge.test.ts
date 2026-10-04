/**
 * S5 bridge v1: same-principal/team auth, MCP `_meta` advertisement,
 * unsupported-host fallback, and never a model-supplied endpoint.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestOnlyFixedPrincipal } from '../src/ports.ts';
import {
  appendUploadContent,
  completeUploadContent,
  createUploadIntent,
  sha256Hex,
} from '../src/upload/index.ts';
import { finalizeUpload } from '../src/finalize/index.ts';
import {
  FILE_TRANSFER_META_KEY,
  advertiseFileTransfer,
  createBridgeOrigin,
  handleCreateIntent,
  handleFinalize,
  intentsUrlFor,
  routeHost,
} from '../src/bridge.ts';
import {
  BINDING,
  OTHER_TEAM,
  PDF_BYTES,
  RECEIVER,
  makeHarness,
  uploadRequest,
} from './helpers.ts';

describe('bridge v1', () => {
  it('rejects unauthenticated intent creation before any intent exists', () => {
    const h = makeHarness({ receiver: null });
    const created = handleCreateIntent(h.bridge, h.upload, {}, uploadRequest(), BINDING);
    assert.deepEqual(created, { status: 'rejected', reason: 'unauthorized' });
    assert.equal(h.intents.listAll().length, 0);
    const finalized = handleFinalize(h.bridge, h.finalize, {}, {
      intentId: 'intent_1',
      retryId: 'upl_1',
      bytesDigest: 'sha256:x',
    });
    assert.deepEqual(finalized, { status: 'failed', reason: 'foreign' });
  });

  it('enforces same-principal/team across create and finalize', () => {
    const h = makeHarness();
    const request = uploadRequest();
    const created = handleCreateIntent(h.bridge, h.upload, {}, request, BINDING);
    assert.equal(created.status, 'granted');
    if (created.status !== 'granted') {
      return;
    }
    assert.equal(
      appendUploadContent(h.upload, created.intentId, RECEIVER, PDF_BYTES).status,
      'appended',
    );
    assert.equal(
      completeUploadContent(h.upload, created.intentId, RECEIVER).status,
      'completed',
    );
    const otherTeamBridge = { ...h.bridge, principals: new TestOnlyFixedPrincipal(OTHER_TEAM) };
    const foreign = handleFinalize(otherTeamBridge, h.finalize, {}, {
      intentId: created.intentId,
      retryId: request.upload_id,
      bytesDigest: sha256Hex(PDF_BYTES),
    });
    assert.deepEqual(foreign, { status: 'failed', reason: 'foreign' });
    const own = handleFinalize(h.bridge, h.finalize, {}, {
      intentId: created.intentId,
      retryId: request.upload_id,
      bytesDigest: sha256Hex(PDF_BYTES),
    });
    assert.equal(own.status, 'finalized');
  });

  it('advertises the v1 file-transfer metadata shape', () => {
    const h = makeHarness();
    assert.equal(FILE_TRANSFER_META_KEY, 'org.canlang/fileTransfer');
    assert.equal(intentsUrlFor(h.bridge.origin), 'https://app.example.test/files/intents');
    assert.deepEqual(advertiseFileTransfer(h.bridge.origin), {
      version: 1,
      intents: 'https://app.example.test/files/intents',
    });
  });

  it('routes supporting hosts to bridge v1', () => {
    const h = makeHarness();
    const routed = routeHost(h.bridge.origin, {
      name: 'chat-host',
      fileTransferVersions: [1],
    });
    assert.equal(routed.action, 'bridge-v1');
    if (routed.action === 'bridge-v1') {
      assert.deepEqual(routed.meta, {
        version: 1,
        intents: 'https://app.example.test/files/intents',
      });
    }
  });

  it('falls back for unsupported hosts with no endpoint or credential', () => {
    const h = makeHarness();
    for (const host of [
      { name: 'legacy-host', fileTransferVersions: [] as number[] },
      { name: 'future-host', fileTransferVersions: [2] },
    ]) {
      const routed = routeHost(h.bridge.origin, host);
      assert.equal(routed.action, 'fallback');
      assert.deepEqual(Object.keys(routed).sort(), ['action', 'message', 'reason']);
      if (routed.action === 'fallback') {
        assert.equal(routed.reason, 'unsupported-host');
        assert.ok(!JSON.stringify(routed).includes('https://'));
      }
    }
  });

  it('falls back for malformed hosts instead of throwing', () => {
    const h = makeHarness();
    for (const host of [
      null,
      undefined,
      { name: 'no-versions' },
      { name: 'null-versions', fileTransferVersions: null },
      { name: 'string-versions', fileTransferVersions: '1' },
    ]) {
      const routed = routeHost(h.bridge.origin, host as never);
      assert.equal(routed.action, 'fallback');
      if (routed.action === 'fallback') {
        assert.equal(routed.reason, 'unsupported-host');
      }
    }
  });

  it('validates origins and rejects model-shaped endpoints', () => {
    assert.equal(createBridgeOrigin('http://app.example.test'), null);
    assert.equal(createBridgeOrigin('https://user:pass@app.example.test'), null);
    assert.equal(createBridgeOrigin('https://app.example.test/?x=1'), null);
    assert.equal(createBridgeOrigin('https://app.example.test/#f'), null);
    assert.equal(createBridgeOrigin('not a url'), null);
    assert.equal(createBridgeOrigin(''), null);
    const normalized = createBridgeOrigin('https://app.example.test///');
    assert.deepEqual(normalized, { baseUrl: 'https://app.example.test' });
  });

  it('generates every destination from the bridge origin', () => {
    const h = makeHarness();
    const poisoned = { ...h.upload, urlBase: 'https://other.test' };
    const created = handleCreateIntent(h.bridge, poisoned, {}, uploadRequest(), BINDING);
    assert.equal(created.status, 'granted');
    if (created.status !== 'granted') {
      return;
    }
    assert.ok(created.grant.content.startsWith('https://app.example.test/files/content/'));
    assert.ok(created.grant.finalize.startsWith('https://app.example.test/files/finalize/'));
    assert.ok(created.grant.content.includes(created.intentId));
  });

  it('direct intent creation fails closed on a non-HTTPS base', () => {
    const h = makeHarness();
    const hostile = createUploadIntent(
      { ...h.upload, urlBase: 'http://evil.test' },
      { request: uploadRequest(), receiver: RECEIVER, binding: BINDING },
    );
    assert.deepEqual(hostile, { status: 'rejected', reason: 'invalid-request' });
    const trailing = createUploadIntent(
      { ...h.upload, urlBase: 'https://app.example.test/' },
      { request: uploadRequest(), receiver: RECEIVER, binding: BINDING },
    );
    assert.deepEqual(trailing, { status: 'rejected', reason: 'invalid-request' });
  });

  it('finalize through the bridge matches direct finalization', () => {
    const h = makeHarness();
    const request = uploadRequest();
    const created = handleCreateIntent(h.bridge, h.upload, {}, request, BINDING);
    assert.equal(created.status, 'granted');
    if (created.status !== 'granted') {
      return;
    }
    assert.equal(
      appendUploadContent(h.upload, created.intentId, RECEIVER, PDF_BYTES).status,
      'appended',
    );
    assert.equal(
      completeUploadContent(h.upload, created.intentId, RECEIVER).status,
      'completed',
    );
    const viaBridge = handleFinalize(h.bridge, h.finalize, {}, {
      intentId: created.intentId,
      retryId: request.upload_id,
      bytesDigest: sha256Hex(PDF_BYTES),
    });
    assert.equal(viaBridge.status, 'finalized');
    const direct = finalizeUpload(h.finalize, {
      intentId: created.intentId,
      retryId: request.upload_id,
      bytesDigest: sha256Hex(PDF_BYTES),
      caller: RECEIVER,
    });
    assert.equal(direct.status, 'repeated');
    if (viaBridge.status === 'finalized' && direct.status === 'repeated') {
      assert.equal(direct.result.file, viaBridge.result.file);
    }
  });
});
