import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, DerivedOperationInputs } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { FIXED_NOW, asId, asModel, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { buildSessionCookie, deriveCsrfToken, issueMcpGrant, resolveIdentity, sha256HexText } from '@canlang/identity';
import { createMemoryIdentityStore } from '@canlang/identity/testing';
import { createSqliteFileBindings, createSqliteFileStore } from '@canlang/files/host/sqlite';
import { sha256Hex, stagingKeyForIntent } from '@canlang/files/upload';
import { createFileJourneyKernel } from '@canlang/interfaces/uploads/kernel';
import { catalogFromArtifactOperations, handleOperationRequest } from '@canlang/interfaces/http/operations';
import { createMcpHandler } from '@canlang/interfaces/mcp/server';
import type { HttpDeps, McpDeps, UploadDeps } from '@canlang/interfaces';
import { GeneratedSubmitError, submitGeneratedForm } from '@canlang/ui';
import type { SubmitFetch } from '@canlang/ui';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { createArtifactCatalog, createArtifactRegistry } from '@canlang/cloudflare/runtime/mcp-registry';
import { assembleWorker, buildInvoker } from '@canlang/cloudflare/worker/assembly';
import { createBoundFileHandler, createCanonicalFileBinding } from '@canlang/cloudflare/runtime/bound-files';
import { createMemberMcpPermissions } from './mcp-permissions.js';

const APP = 'TypedFileJourney';
const MODEL = asModel(`${APP}.Entry`);
const fixturePath = resolve('packages/cloudflare/test/fixtures/typed-file-journey.json');
const BYTES = new TextEncoder().encode('%PDF-1.4\nActual uploaded bytes\ntrailer\n');

test('compiled attachment workflow uses authenticated uploads, SQLite bytes and native D1 grants', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-file-journey-'));
  let miniflare: Miniflare | undefined;
  let fileStore: ReturnType<typeof createSqliteFileStore> | undefined;
  let now = FIXED_NOW, sequence = 0;
  const clock = { nowMs: () => now };
  const operationId = () => asOperationId(uuidv7(now, ++sequence));
  const openD1 = async () => {
    miniflare = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'typed-file-journey' }, d1Persist: join(dir, 'd1') });
    const db = await miniflare.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(db); return createD1Storage(db);
  };
  try {
    const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    // Identity is an explicit memory store; real credential resolution and live
    // membership checks serve native requests. Domain and bytes are persistent.
    const identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({ timezone: 'Europe/Brussels' });
    const owner = await identities.createUser({ email: 'file-owner@example.test', password_hash: 'unused', email_verified: true });
    const ownerMembership = await identities.createMembership({ team_id: team.team_id, user_id: owner.user_id,
      is_owner: true, roles: [] });
    const member = await identities.createUser({ email: 'file-member@example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: member.user_id, is_owner: false, roles: [] });
    const foreign = await identities.createUser({ email: 'other-file-owner@example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: foreign.user_id, is_owner: true, roles: [] });
    const ownerGrant = await issueMcpGrant(identities, { user_id: owner.user_id, team_id: team.team_id, client_id: 'file-owner' }, { clock });
    const memberGrant = await issueMcpGrant(identities, { user_id: member.user_id, team_id: team.team_id, client_id: 'file-member' }, { clock });
    const foreignGrant = await issueMcpGrant(identities, { user_id: foreign.user_id, team_id: team.team_id, client_id: 'file-foreign' }, { clock });
    const sessionToken = 'file-owner-session';
    await identities.createSession({ user_id: owner.user_id, token_sha256: await sha256HexText(sessionToken),
      last_team_id: team.team_id, expires_at: new Date(now + 3600_000).toISOString() });
    const cookie = buildSessionCookie(sessionToken, { maxAgeSeconds: 3600 }).split(';')[0]!;
    const csrf = await deriveCsrfToken(sessionToken);
    let state = await openD1();
    fileStore = createSqliteFileStore(join(dir, 'files.sqlite'));
    let failFinalizeWrite = false;
    let failAfterRetention = false;
    let lostRetentionResponse = false;
    let repairedRetention = false;
    const kernelFor = () => {
      const store = fileStore!;
      const nativeKernel = createFileJourneyKernel(createSqliteFileBindings({ ...store, files: { ...store.files,
        put(record) {
          store.files.put(record);
          if (failFinalizeWrite) {
            failFinalizeWrite = false;
            throw new Error('Injected SQLite finalized metadata write failure');
          }
        },
      } }, { clock, intentTtlMs: 60_000, urlBase: 'https://test.invalid' }));
      return { ...nativeKernel, async recordAttachment(ref: string, record: string,
        caller: Parameters<typeof nativeKernel.recordAttachment>[2]) {
        const result = await nativeKernel.recordAttachment(ref, record, caller);
        if (result.status === 'attached' && failAfterRetention) {
          failAfterRetention = false;
          lostRetentionResponse = true;
          throw new Error('Injected host interruption after committed file retention');
        }
        if (result.status === 'attached' && lostRetentionResponse) repairedRetention = true;
        return result;
      } };
    };
    let kernel = kernelFor();
    const uploadDeps = (): UploadDeps & { kernel: typeof kernel } => ({
      app: { appId: APP, brand: APP, appDefaultLocale: 'en', ownerLabels: new Map() },
      files: { usesFiles: () => true }, kernel, clock,
      identity: { store: identities, clock, mail: { sendMail: async () => {} },
        verifyBaseUrl: '', recoveryBaseUrl: '', inviteBaseUrl: '', sessionMaxAgeSeconds: 3600 },
      logger: { log: () => {} },
    });
    const handlerFor = () => createBoundFileHandler({ artifact, asm, store: state,
      memberships: identities, identityStore: identities, clock, upload: uploadDeps() });
    let handler = handlerFor();
    const invokerFor = () => buildInvoker(artifact, asm, state, { memberships: identities,
      now: () => now, files: createCanonicalFileBinding(kernel) });
    let invoker = invokerFor();
    const catalog = catalogFromArtifactOperations(artifact);
    const derivedInputs: Record<string, DerivedOperationInputs> = {};
    for (const operation of artifact.operations ?? []) {
      const derived = catalog.derivedFor(operation.name); assert.ok(derived);
      derivedInputs[operation.name] = derived;
    }
    const upload = uploadDeps();
    const mcpHandler = createMcpHandler({ app: upload.app,
      registry: createArtifactRegistry(artifact), catalog: createArtifactCatalog(artifact, derivedInputs),
      permissions: createMemberMcpPermissions(artifact), invoker, identity: upload.identity,
      files: { usesFiles: () => true, intentsUrl: () => 'https://test.invalid/files/intents' },
      logger: upload.logger, clock,
    } as unknown as McpDeps);
    const mcp = async (method: string, params: Record<string, unknown>) => {
      const response = await mcpHandler(new Request('https://test.invalid/mcp', {
        method: 'POST', headers: { authorization: `Bearer ${ownerGrant.token}`,
          'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
      }));
      assert.equal(response.status, 200, await response.clone().text());
      return await response.json() as { result?: { [key: string]: unknown;
        content?: Array<{ text: string }>; structuredContent?: Record<string, unknown> } };
    };
    const initialized = await mcp('initialize', { protocolVersion: '2024-11-05',
      capabilities: {}, clientInfo: { name: 'native-file-journey', version: '1' } });
    assert.ok(initialized.result);
    assert.deepEqual((initialized.result['_meta'] as Record<string, unknown>)['org.canlang/fileTransfer'], {
      version: 1, intents: 'https://test.invalid/files/intents',
    });
    const tools = await mcp('tools/list', {}); assert.ok(tools.result);
    const listed = tools.result['tools'] as Array<{ name: string; inputSchema: unknown }>;
    const attachTool = listed.find(tool => tool.name === `${APP}.attach`); assert.ok(attachTool);
    assert.ok(attachTool.inputSchema);
    const mutation = async (operation: string, inputs: Record<string, unknown>) => invoker.invokeMutation({
      operation: `${APP}.${operation}`, operation_id: operationId(), inputs,
    }, await resolveIdentity(identities, { mcp_grant_token: ownerGrant.token }, { clock }));
    const created = await mutation('Entry.create', {});
    assert.ok('result' in created, JSON.stringify(created));
    assert.equal(created.result.result, null);
    const row = created.result.records![0] as { id: string };
    const authRequest = (url: string, method: string, body?: string | Uint8Array, bearer = ownerGrant.token,
      viaSession = false) => new Request(url.startsWith('https:') ? url : `https://test.invalid${url}`, {
      method, headers: { ...(viaSession ? { cookie, 'x-csrf-token': csrf } : { authorization: `Bearer ${bearer}` }),
        ...(body instanceof Uint8Array ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body }),
    });
    const intentBody = (uploadId: string) => ({ upload_id: uploadId, operation: `${APP}.attach`, field: '/attachment',
      arguments: {}, name: 'actual.pdf', type: 'application/pdf', size: String(BYTES.length) });
    const intent = async (uploadId: string, bearer = ownerGrant.token) => {
      const response = await handler(authRequest('/files/intents', 'POST', JSON.stringify(intentBody(uploadId)), bearer));
      assert.equal(response.status, 200, await response.clone().text());
      return await response.json() as { intent_id: string; content: string; finalize: string; expires_at: string };
    };
    const finalize = (grant: Awaited<ReturnType<typeof intent>>, uploadId: string, bearer = ownerGrant.token) =>
      handler(authRequest(grant.finalize, 'POST', JSON.stringify({ upload_id: uploadId, bytes_digest: sha256Hex(BYTES) }), bearer));
    const attach = async (ref: string, accept: boolean) => {
      const current = await state.load(MODEL, asId(row.id)); assert.ok(current);
      return mutation('attach', { entry: { id: current.id, version: String(current.version) }, attachment: { id: ref }, accept });
    };
    const grant = await intent('actual-upload');
    assert.deepEqual(await intent('actual-upload'), grant);
    const partial = await handler(authRequest(grant.content, 'PUT', BYTES.slice(0, 8), ownerGrant.token, true));
    assert.equal(partial.status, 200);
    assert.deepEqual(await partial.json(), { received_bytes: 8, complete: false });
    assert.equal((await finalize(grant, 'actual-upload')).status, 422);
    const partialAttach = await attach(grant.intent_id, true);
    assert.ok('error' in partialAttach); assert.equal(partialAttach.error.code, 'validation');
    const rest = await handler(authRequest(grant.content, 'PUT', BYTES.slice(8)));
    assert.equal(rest.status, 200);
    assert.equal((await rest.json() as { complete: boolean }).complete, true);
    const beforeFaultIntent = fileStore.intents.get(grant.intent_id);
    const beforeFaultFiles = fileStore.files.listAll();
    failFinalizeWrite = true;
    // Interfaces maps unexpected kernel errors to its generic rule_failed
    // envelope. The actual storage fault still rolls back and can be retried.
    assert.equal((await finalize(grant, 'actual-upload')).status, 422);
    assert.equal(failFinalizeWrite, false);
    assert.deepEqual(fileStore.intents.get(grant.intent_id), beforeFaultIntent);
    assert.deepEqual(fileStore.files.listAll(), beforeFaultFiles);
    assert.deepEqual(fileStore.blobs.read(stagingKeyForIntent(grant.intent_id)), BYTES);
    const finalized = await finalize(grant, 'actual-upload');
    assert.equal(finalized.status, 200, await finalized.clone().text());
    const ref = (await finalized.json() as { file: string }).file;
    const repeated = await finalize(grant, 'actual-upload'); assert.equal(repeated.status, 200);
    assert.equal((await repeated.json() as { file: string }).file, ref);
    const beforeRejected = await state.load(MODEL, asId(row.id));
    const rejected = await attach(ref, false);
    assert.ok('error' in rejected); assert.equal(rejected.error.code, 'rule_failed');
    assert.deepEqual(await state.load(MODEL, asId(row.id)), beforeRejected);
    assert.equal(fileStore.files.get(ref)?.attachedRecord, null);
    const forged = await attach(uuidv7(now, ++sequence), true);
    assert.ok('error' in forged); assert.equal(forged.error.code, 'validation');
    const foreignIntent = await intent('foreign-upload', foreignGrant.token);
    assert.equal((await handler(authRequest(foreignIntent.content, 'PUT', BYTES, foreignGrant.token))).status, 200);
    const foreignFinalized = await finalize(foreignIntent, 'foreign-upload', foreignGrant.token);
    assert.equal(foreignFinalized.status, 200);
    const foreignRef = (await foreignFinalized.json() as { file: string }).file;
    const foreignAttach = await attach(foreignRef, true);
    assert.ok('error' in foreignAttach); assert.equal(foreignAttach.error.code, 'validation');
    const expired = await intent('expired-upload'); now += 60_001;
    assert.equal((await handler(authRequest(expired.content, 'PUT', BYTES))).status, 404);
    const expiredAttach = await attach(expired.intent_id, true);
    assert.ok('error' in expiredAttach); assert.equal(expiredAttach.error.code, 'validation');
    const beforeAttach = await state.load(MODEL, asId(row.id)); assert.ok(beforeAttach);
    const attachEnvelope = { name: `${APP}.attach`, arguments: { operation_id: operationId(),
      entry: { id: beforeAttach.id, version: String(beforeAttach.version) }, attachment: { id: ref }, accept: true } };
    failAfterRetention = true;
    const interruptedAttach = await mcp('tools/call', attachEnvelope);
    assert.equal(interruptedAttach.result?.structuredContent?.['code'], 'rule_failed', JSON.stringify(interruptedAttach));
    const committedOwner = await state.load(MODEL, asId(row.id)); assert.ok(committedOwner);
    assert.equal(committedOwner.version, beforeAttach.version + 1);
    const committedHistory = await state.historyFor(MODEL, asId(row.id));
    const committedRevision = await state.readRevision();
    const retainedRecord = `${MODEL}/${row.id}/attachment`;
    assert.equal(fileStore.files.get(ref)?.attachedRecord, retainedRecord);
    const retriedAttach = await mcp('tools/call', attachEnvelope);
    assert.equal(retriedAttach.result?.structuredContent?.['status'], 'replayed', JSON.stringify(retriedAttach));
    assert.equal(repairedRetention, true);
    assert.deepEqual(await state.load(MODEL, asId(row.id)), committedOwner);
    assert.deepEqual(await state.historyFor(MODEL, asId(row.id)), committedHistory);
    assert.equal(await state.readRevision(), committedRevision);
    assert.equal(fileStore.files.get(ref)?.attachedRecord, retainedRecord);

    // The public browser submit consumer uses the same real session, upload
    // handler and generated HTTP operation join as this native deployment.
    const browserWorker = await assembleWorker(artifact, asm, { store: state,
      identityStore: identities, now: () => now,
      files: { usesFiles: true, kernel, canonical: createCanonicalFileBinding(kernel), fetch: handler },
      http: { derivedInputs, createOperationHandler: deps => (request, operation) =>
        handleOperationRequest(deps as unknown as HttpDeps, request, operation) },
    }, { active: true });
    const browserFetch: SubmitFetch = (url, init) => browserWorker.fetch(new Request(
      new URL(url, 'https://test.invalid'), { method: init.method,
        headers: { ...init.headers, cookie }, ...(init.body === undefined ? {} : { body: init.body }) }));
    const browserDerived = derivedInputs[`${APP}.attach`]; assert.ok(browserDerived);
    const browserFlat = { operation_id: operationId(), _csrf: csrf,
      'inputs[entry]': committedOwner.id, 'inputs[entry__version]': String(committedOwner.version),
      'inputs[accept]': 'true' };
    const browserSubmission = { derived: browserDerived, mode: 'scenario' as const, flat: browserFlat,
      files: [{ field: 'attachment', name: 'browser.pdf', type: 'application/pdf', size: BYTES.length, bytes: BYTES }],
      action: `https://test.invalid/api/operations/${APP}.attach`, fragment: false,
      denialFormat: 'json' as const, intentsUrl: 'https://test.invalid/files/intents', fetchImpl: browserFetch };
    const beforeBrowserIntents = fileStore.intents.listAll();
    const beforeBrowserFiles = fileStore.files.listAll();
    await assert.rejects(submitGeneratedForm({ ...browserSubmission,
      flat: { ...browserFlat, _csrf: 'invalid-csrf' }, mintUploadId: () => operationId() }),
    error => error instanceof GeneratedSubmitError && error.code === 'upload_failed');
    assert.deepEqual(fileStore.intents.listAll(), beforeBrowserIntents);
    assert.deepEqual(fileStore.files.listAll(), beforeBrowserFiles);
    assert.deepEqual(await state.load(MODEL, asId(row.id)), committedOwner);
    assert.deepEqual(await state.historyFor(MODEL, asId(row.id)), committedHistory);
    assert.equal(await state.readRevision(), committedRevision);
    const browserUploadId = operationId();
    const browserSubmitted = await submitGeneratedForm({ ...browserSubmission, mintUploadId: () => browserUploadId });
    assert.equal(browserSubmitted.kind, 'committed', JSON.stringify(browserSubmitted));
    if (browserSubmitted.kind !== 'committed') throw new Error('Expected native browser attachment commit');
    assert.equal(browserSubmitted.result.status, 'committed');
    assert.equal(browserSubmitted.result.operation_id, browserFlat.operation_id);
    const browserIntent = fileStore.intents.getByRetryId(browserUploadId); assert.ok(browserIntent);
    assert.equal(browserIntent.state, 'finalized');
    const browserRef = browserIntent.finalizedRef; assert.ok(browserRef);
    assert.notEqual(browserRef, ref);
    const browserOwner = await state.load(MODEL, asId(row.id)); assert.ok(browserOwner);
    assert.equal(browserOwner.version, committedOwner.version + 1);
    assert.deepEqual(browserOwner.data['attachment'], { id: browserRef });
    assert.equal(fileStore.files.get(browserRef)?.attachedRecord, retainedRecord);
    assert.equal(fileStore.files.get(browserRef)?.file.bytesDigest, sha256Hex(BYTES));

    const downloadPath = `/files/read/${MODEL}/${row.id}/attachment`;
    const download = await handler(authRequest(downloadPath, 'GET'));
    assert.equal(download.status, 200, await download.clone().text());
    assert.equal(download.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), BYTES);
    const hidden = await handler(authRequest(downloadPath, 'GET', undefined, memberGrant.token));
    const missing = await handler(authRequest(`/files/read/${MODEL}/missing/attachment`, 'GET', undefined, memberGrant.token));
    assert.equal(hidden.status, 404); assert.equal(missing.status, 404);
    assert.equal(await hidden.text(), await missing.text());
    assert.equal((await handler(authRequest(`/files/read/${ref}`, 'GET'))).status, 404);

    fileStore.close(); fileStore = undefined;
    await miniflare!.dispose(); miniflare = undefined;
    state = await openD1(); fileStore = createSqliteFileStore(join(dir, 'files.sqlite'));
    kernel = kernelFor(); handler = handlerFor(); invoker = invokerFor();
    const reopened = await handler(authRequest(downloadPath, 'GET'));
    assert.equal(reopened.status, 200); assert.deepEqual(new Uint8Array(await reopened.arrayBuffer()), BYTES);
    assert.deepEqual((await state.load(MODEL, asId(row.id)))?.data['attachment'], { id: browserRef });
    assert.equal(fileStore.files.get(browserRef)?.attachedRecord, retainedRecord);
    assert.equal(fileStore.files.get(ref)?.attachedRecord, retainedRecord);
    await identities.revokeMcpGrant(ownerGrant.grant.grant_id);
    assert.equal((await handler(authRequest(downloadPath, 'GET'))).status, 401);
    const nativeKernel = kernel;
    let removedDuringRead = false;
    kernel = { ...nativeKernel, async readBytes(fileRef, caller) {
      assert.equal(fileRef, browserRef);
      const bytes = await nativeKernel.readBytes(fileRef, caller);
      assert.ok(bytes);
      assert.deepEqual(bytes, BYTES);
      await identities.removeMembership(ownerMembership.membership_id);
      removedDuringRead = true;
      return bytes;
    } };
    handler = handlerFor();
    const removed = await handler(authRequest(downloadPath, 'GET', undefined, ownerGrant.token, true));
    assert.equal(removedDuringRead, true);
    assert.equal(removed.status, 404);
    const refusedBody = await removed.text();
    assert.equal(refusedBody.includes(ref), false);
    assert.equal(refusedBody.includes(browserRef), false);
    assert.equal(refusedBody.includes(new TextDecoder().decode(BYTES)), false);
    assert.equal((await state.load(MODEL, asId(row.id)))?.data['label'], 'Uploaded');
  } finally {
    fileStore?.close(); await miniflare?.dispose(); await rm(dir, { recursive: true, force: true });
  }
});
