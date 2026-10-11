/**
 * S5 bridge v1: same-principal/team auth, MCP `_meta` advertisement,
 * unsupported-host fallback, and never a model-supplied endpoint.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFileValue } from '@canlang/values';
import type { FileValue, PageFilePresenter } from '@canlang/contracts';
import { TestOnlyFixedPrincipal } from '../src/ports.js';
import {
  appendUploadContent,
  completeUploadContent,
  createUploadIntent,
  sha256Hex,
} from '../src/upload/index.js';
import { finalizeUpload } from '../src/finalize/index.js';
import {
  FILE_TRANSFER_META_KEY,
  advertiseFileTransfer,
  createBridgeOrigin,
  handleCreateIntent,
  handleFinalize,
  intentsUrlFor,
  routeHost,
  createPageFilePresentation,
  type PageFileOccurrence,
} from '../src/bridge.js';
import {
  BINDING,
  OTHER_TEAM,
  PDF_BYTES,
  RECEIVER,
  makeHarness,
  uploadRequest,
} from './helpers.js';

describe('page File occurrence presentation', () => {
  it('binds original identities per page and snapshots nested positions without granting copies', async () => {
    const file = makeFileValue('file-one');
    const path: (string | number)[] = [2, 'attachments', 0];
    const occurrence = { model: 'Chat.Conversation', recordId: 'conversation-one', field: 'messages', ref: file.id, path };
    const seen: PageFileOccurrence[] = [];
    const page = createPageFilePresentation(async captured => {
      seen.push(captured);
      assert.equal(Object.isFrozen(captured), true); assert.equal(Object.isFrozen(captured.path), true);
      return { href: '/files/current-authorized-open' };
    });
    const other = createPageFilePresentation(async () => { throw new Error('foreign page must not resolve'); });
    assert.equal(Object.isFrozen(page), true);
    page.bind(file, occurrence); page.bind(file, { ...occurrence, path: [...path] });
    occurrence.recordId = 'changed'; path.splice(0, path.length, 'changed');
    assert.deepEqual(await page.presentFile(file), { href: '/files/current-authorized-open' });
    assert.deepEqual(seen[0], { model: 'Chat.Conversation', recordId: 'conversation-one', field: 'messages',
      ref: file.id, path: [2, 'attachments', 0] });
    assert.equal(await page.presentFile({ ...file }), null);
    assert.equal(await other.presentFile(file), null);
    assert.equal(seen.length, 1);
    assert.throws(() => page.bind(file, occurrence), /rebound/);
    assert.throws(() => page.bind(makeFileValue('different'), occurrence), /reference/);
  });

  it('refuses malformed own-data bindings before effects and withholds mutated File identities', async () => {
    let calls = 0, getterCalls = 0;
    const page = createPageFilePresentation(async () => { calls++; return { href: '/authorized' }; });
    const file: FileValue = { kind: 'file', id: 'file-one' };
    const occurrence: PageFileOccurrence = { model: 'Chat.Message', recordId: 'message-one',
      field: 'attachments', ref: file.id, path: ['attachments', 0] };
    const accessor = { ...occurrence, get ref() { getterCalls++; return file.id; } };
    const pathAccessor = [0];
    Object.defineProperty(pathAccessor, '0', { enumerable: true, get() { getterCalls++; return 0; } });
    for (const malformed of [accessor, Object.create(occurrence), { ...occurrence, extra: true },
      { ...occurrence, path: new Array(1) }, { ...occurrence, path: pathAccessor },
      { ...occurrence, path: [-1] }, { ...occurrence, path: [1.5] }, { ...occurrence, path: [null] }]) {
      assert.throws(() => page.bind(file, malformed as PageFileOccurrence), TypeError);
    }
    const badFile = { get kind() { getterCalls++; return 'file'; }, id: file.id };
    assert.throws(() => page.bind(badFile as FileValue, occurrence), TypeError);
    assert.equal(getterCalls, 0); assert.equal(calls, 0);
    page.bind(file, occurrence);
    Object.defineProperty(file, 'id', { value: 'changed', enumerable: true, configurable: true });
    assert.equal(await page.presentFile(file), null); assert.equal(calls, 0);
    Object.defineProperty(file, 'id', { enumerable: true, configurable: true, get() { getterCalls++; return 'file-one'; } });
    assert.equal(await page.presentFile(file), null); assert.equal(getterCalls, 0);
  });

  it('closes terminally and withholds pending results while preserving resolver errors', async () => {
    const file = makeFileValue('file-one');
    const occurrence = { model: 'Chat.Message', recordId: 'message-one', field: 'attachments', ref: file.id, path: [0] };
    let complete!: (value: Awaited<ReturnType<PageFilePresenter>>) => void;
    let calls = 0;
    const page = createPageFilePresentation(async () => { calls++; return new Promise(resolve => { complete = resolve; }); });
    page.bind(file, occurrence);
    const pending = page.presentFile(file);
    assert.equal(calls, 1);
    page.close(); page.close(); complete({ href: '/late-authorized-open' });
    assert.equal(await pending, null);
    assert.equal(await page.presentFile(file), null); assert.equal(calls, 1);
    assert.throws(() => page.bind(file, occurrence), /closed/);
    const failure = new Error('current host resolver failed');
    const failing = createPageFilePresentation(async () => { throw failure; });
    failing.bind(file, occurrence);
    await assert.rejects(failing.presentFile(file), error => error === failure);
  });
});

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
