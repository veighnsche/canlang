import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, DerivedOperationInputs, ProviderBinding } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { associationRowId, readReceiptRow, RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL } from '@canlang/state/receipt/tables';
import { FIXED_NOW, asId, asModel, asOperation, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { createD1IdentityStore, ensureIdentitySchema, issueMcpGrant } from '@canlang/identity';
import { catalogFromArtifactOperations } from '@canlang/interfaces/http/operations';
import { createMcpHandler } from '@canlang/interfaces/mcp/server';
import type { McpDeps } from '@canlang/interfaces';
import { EmailV1Adapter } from '@canlang/services/mail/adapter';
import { WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { attemptDispatch } from '@canlang/work/dispatch';
import { classifyFailure } from '@canlang/work/receipt';
import { planRecoveryScan } from '@canlang/work/recovery';
import { observeSelectedReceipt } from '@canlang/work/observation/observation';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { assembleWorker } from '@canlang/cloudflare/worker/assembly';
import { createBoundMailAdapter } from '@canlang/cloudflare/runtime/bound-mail';
import { createBoundMailDispatcher } from '@canlang/cloudflare/runtime/bound-dispatch';
import type { FenceAttemptDispatchFn } from './invoke.js';

const APP = 'TypedDeliveryObserver';
const MODEL = asModel(`${APP}.Entry`);
const fixturePath = resolve('packages/cloudflare/test/fixtures/typed-delivery-observer.json');

test('authored delivery association serves current localhost provider results through native MCP and reopened D1', async () => {
  const sends: string[] = [];
  const reconciles: string[] = [];
  let sendMode: 'accepted' | 'malformed' = 'accepted';
  const server = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/send') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { delivery_id: string };
      sends.push(body.delivery_id);
      assert.equal(request.headers['idempotency-key'], body.delivery_id);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(sendMode === 'accepted'
        ? { reference: `accepted-${body.delivery_id}` } : { unexpected: true }));
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/deliveries/')) {
      const id = decodeURIComponent(request.url.slice('/deliveries/'.length));
      reconciles.push(id);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'accepted', reference: `accepted-${id}` }));
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
  const dir = await mkdtemp(join(tmpdir(), 'can-delivery-observer-'));
  let miniflare: Miniflare | undefined;
  let now = FIXED_NOW, sequence = 0;
  const clock = { nowMs: () => now };
  const operationId = () => asOperationId(uuidv7(now, ++sequence));
  const open = async () => {
    miniflare = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'typed-delivery-observer' }, d1Persist: join(dir, 'd1') });
    const db = await miniflare.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(db); await ensureIdentitySchema(db);
    return { state: createD1Storage(db), identity: createD1IdentityStore(db, { clock }) };
  };
  try {
    const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    const definition = (await import(asm.entryUrl)).appDefinition as unknown;
    const catalog = catalogFromArtifactOperations(artifact);
    const derivedInputs: Record<string, DerivedOperationInputs> = {};
    for (const op of artifact.operations ?? []) {
      const derived = catalog.derivedFor(op.name); assert.ok(derived); derivedInputs[op.name] = derived;
    }
    let storage = await open();
    const team = await storage.identity.createTeam({ timezone: 'Europe/Brussels' });
    const user = await storage.identity.createUser({ email: 'delivery-member@example.test',
      password_hash: 'unused', email_verified: true });
    const membership = await storage.identity.createMembership({ team_id: team.team_id,
      user_id: user.user_id, is_owner: false, roles: [] });
    const grant = await issueMcpGrant(storage.identity, { user_id: user.user_id,
      team_id: team.team_id, client_id: 'delivery-observer' }, { clock });
    const observer = { observeSelectedReceipt: (input: unknown) =>
      observeSelectedReceipt(input as Parameters<typeof observeSelectedReceipt>[0]) };
    const assemble = () => assembleWorker(artifact, asm, {
      store: storage.state, identityStore: storage.identity, now: () => now,
      selectedReceiptObserver: observer,
      mcp: { derivedInputs, permissions: { canDiscover: () => true, canCall: () => true },
        createHandler: deps => createMcpHandler(deps as unknown as McpDeps) },
    }, { active: true });
    let worker = await assemble();
    const mcp = async (operation: string, inputs: Record<string, unknown>, bearer = grant.token) => {
      const response = await worker.fetch(new Request('https://test.invalid/mcp', {
        method: 'POST', headers: { 'content-type': 'application/json',
          accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call',
          params: { name: operation, arguments: inputs } }),
      }));
      const rpc = await response.json() as { [key: string]: unknown;
        result?: { content: Array<{ text: string }>; structuredContent?: Record<string, unknown> } };
      return { status: response.status, body: rpc.result === undefined ? rpc :
        rpc.result.structuredContent ?? JSON.parse(rpc.result.content[0]!.text) as Record<string, unknown> };
    };
    const mutate = async (op: string, inputs: Record<string, unknown> = {}) =>
      mcp(`${APP}.${op}`, { operation_id: operationId(), ...inputs });
    const committed = (response: Awaited<ReturnType<typeof mcp>>) => {
      assert.equal(response.status, 200, JSON.stringify(response));
      assert.equal(response.body['status'], 'committed', JSON.stringify(response));
      return response.body['result'];
    };
    const creation = await mutate('Entry.create');
    assert.equal(committed(creation), null);
    const created = (creation.body['records'] as Array<{ id: string }>)[0]!;
    const readReceipt = (selected = ['status', 'result'], id = created.id, bearer = grant.token) =>
      mcp('Receipt.read', { recordId: id, field: 'notification', selected }, bearer);
    const notify = async (accept: boolean) => {
      const current = await storage.state.load(MODEL, asId(created.id)); assert.ok(current);
      return mutate('notify', { entry: { id: current.id, version: String(current.version) },
        to: 'recipient@example.test', accept });
    };
    assert.equal((await readReceipt()).body['outcome'], 'null-association');
    const beforeRejected = await storage.state.load(MODEL, asId(created.id));
    const rejected = await notify(false);
    assert.equal(rejected.body['code'], 'rule_failed', JSON.stringify(rejected));
    assert.deepEqual(await storage.state.load(MODEL, asId(created.id)), beforeRejected);
    assert.equal((await storage.state.outboxPending()).length, 0);
    assert.equal((await readReceipt()).body['outcome'], 'null-association');
    // Fail one real protected-association read after the authored provisional
    // send/set. An infrastructure error must leave this envelope retryable.
    const nativeState = storage.state;
    const retryOwner = await nativeState.load(MODEL, asId(created.id)); assert.ok(retryOwner);
    const retryOperationId = operationId();
    const retryInputs = { operation_id: retryOperationId,
      entry: { id: retryOwner.id, version: String(retryOwner.version) },
      to: 'recipient@example.test', accept: true };
    const retryReceiptIdentity = { app: APP, owner: team.team_id, principal: user.user_id,
      operation: asOperation(`${APP}.notify`), operationId: retryOperationId };
    const beforeFaultHistory = await nativeState.historyFor(MODEL, asId(created.id));
    const beforeFaultRevision = await nativeState.readRevision();
    let faultEnabled = true;
    let faultConsumed = false;
    storage.state = { ...nativeState, load: async (model, id) => {
      if (model === RECEIPT_ASSOCIATION_MODEL && faultEnabled && !faultConsumed) {
        faultConsumed = true;
        throw new Error('Transient native protected association read failure');
      }
      return nativeState.load(model, id);
    } };
    worker = await assemble();
    const failedRead = await mcp(`${APP}.notify`, retryInputs);
    assert.equal(faultConsumed, true);
    assert.notEqual(failedRead.body['status'], 'committed', JSON.stringify(failedRead));
    assert.notEqual(failedRead.body['code'], 'validation', JSON.stringify(failedRead));
    assert.deepEqual(await nativeState.load(MODEL, asId(created.id)), retryOwner);
    assert.deepEqual(await nativeState.historyFor(MODEL, asId(created.id)), beforeFaultHistory);
    assert.equal(await nativeState.readRevision(), beforeFaultRevision);
    assert.equal((await nativeState.outboxPending()).length, 0);
    assert.equal(await nativeState.load(asModel(RECEIPT_ASSOCIATION_MODEL),
      asId(associationRowId(MODEL, created.id, 'notification'))), null);
    assert.equal((await nativeState.query({ model: asModel(RECEIPT_MODEL), authority: 'owner' })).length, 0);
    assert.equal(await nativeState.readReceipt(retryReceiptIdentity), null);
    faultEnabled = false;
    committed(await mcp(`${APP}.notify`, retryInputs));
    assert.equal((await nativeState.readReceipt(retryReceiptIdentity))?.outcome.status, 'committed');
    storage.state = nativeState;
    worker = await assemble();
    const first = (await storage.state.outboxPending())[0]!;
    assert.equal((await storage.state.outboxPending()).length, 1);
    assert.deepEqual((await readReceipt()).body['projection'], { status: 'pending', result: null });
    const priorAssociation = await readReceipt();
    const rejectedReplacement = await notify(false);
    assert.equal(rejectedReplacement.body['code'], 'rule_failed');
    const afterRejectedReplacement = await readReceipt();
    assert.deepEqual(afterRejectedReplacement.body['projection'], priorAssociation.body['projection']);
    assert.equal(afterRejectedReplacement.body['fenceRevision'], priorAssociation.body['fenceRevision']);
    assert.equal((await storage.state.outboxPending()).length, 1);
    // Replacement commits before the old provider response is recorded.
    committed(await notify(true));
    const latest = (await storage.state.outboxPending()).find(intent => intent.intentId !== first.intentId)!;
    assert.ok(latest);
    const binding: ProviderBinding = { deployment: 'deployment.mail', capability: 'std.EmailV1',
      capabilityVersion: 1, account: 'local-delivery-account' };
    const mail = new EmailV1Adapter({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 2_000,
      maxBodyBytes: 16_384, maxTransportBytes: null, clock: { now: () => now } });
    const adapter = createBoundMailAdapter({ appDefinition: definition, binding,
      resolveInstalledMailSender: deployment => {
        assert.equal(deployment, binding.deployment); return { binding, mail };
      } });
    const dispatcherFor = () => createBoundMailDispatcher({ store: storage.state, adapter,
      workCommands: WORK_SYSTEM_COMMANDS, stageCommands: WORK_DISPATCH_STAGE_COMMANDS,
      createClaimCommand: createWorkDispatchClaimCommand });
    let dispatcher = await dispatcherFor();
    const drive = (intentId: string) => dispatcher.drive({ intentId, actor: user.user_id,
      operation: 'test.delivery.drive', nowMs: () => now, nextClaimId: () => `claim-${++sequence}`,
      maxClaimAgeMs: 60_000, claimOperationId: operationId(), recordOperationId: operationId(),
      classifyFailure, evaluateGuard: () => true, readStateSnapshot: () => null,
      fence: { owner: team.team_id, attemptDispatch: attemptDispatch as FenceAttemptDispatchFn,
        revalidateAuthority: async () => (await storage.identity.findMembership(team.team_id, user.user_id))?.status === 'active' },
    });
    assert.equal((await drive(first.intentId)).status, 'recorded');
    const oldReceiptRow = await storage.state.load(asModel(RECEIPT_MODEL), asId(first.intentId));
    assert.ok(oldReceiptRow);
    const oldReceipt = readReceiptRow(oldReceiptRow).receipt;
    assert.equal(oldReceipt.deliveryId, first.intentId);
    assert.equal(oldReceipt.status, 'succeeded');
    assert.deepEqual(oldReceipt.result, { reference: `accepted-${first.intentId}` });
    assert.deepEqual((await readReceipt()).body['projection'], { status: 'pending', result: null });
    assert.equal((await drive(latest.intentId)).status, 'recorded');
    const successful = { status: 'succeeded', result: { reference: `accepted-${latest.intentId}` } };
    assert.deepEqual((await readReceipt()).body['projection'], successful);
    assert.deepEqual((await readReceipt(['status'])).body['projection'], { status: 'succeeded' });
    assert.deepEqual((await readReceipt(['result'])).body['projection'], { result: successful.result });
    assert.equal((await storage.state.outboxPending()).length, 0);
    const denied = await readReceipt(['id']);
    assert.equal(denied.body['outcome'], 'denied', JSON.stringify(denied));
    assert.deepEqual(denied.body['denied'], ['id']);
    assert.equal(JSON.stringify(denied).includes(latest.intentId), false);

    // Fault injection through the real D1 fence: change only the owning wire
    // field while retaining its actual protected association and receipt.
    const selectedOwner = await storage.state.load(MODEL, asId(created.id)); assert.ok(selectedOwner);
    const associationId = asId(associationRowId(MODEL, created.id, 'notification'));
    const selectedAssociation = await storage.state.load(asModel(RECEIPT_ASSOCIATION_MODEL), associationId);
    assert.ok(selectedAssociation);
    const writeOwnerNotification = async (notification: unknown) => {
      const current = await storage.state.load(MODEL, asId(created.id)); assert.ok(current);
      await storage.state.commit({ expectedRevision: await storage.state.readRevision(),
        writes: [{ kind: 'update', model: MODEL, id: current.id, expectedVersion: current.version,
          row: { ...current, version: (current.version + 1) as typeof current.version,
            updated: now, updatedBy: user.user_id, data: { ...current.data, notification } } }],
        history: [], receipt: null, outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [],
      });
    };
    await writeOwnerNotification(null);
    assert.deepEqual(await storage.state.load(asModel(RECEIPT_ASSOCIATION_MODEL), associationId), selectedAssociation);
    const stale = await readReceipt();
    assert.notEqual(stale.body['outcome'], 'observed', JSON.stringify(stale));
    assert.equal(JSON.stringify(stale).includes(`accepted-${latest.intentId}`), false);
    assert.equal(JSON.stringify(stale).includes(latest.intentId), false);
    const staleId = await readReceipt(['id']);
    assert.equal(staleId.body['outcome'], 'denied', JSON.stringify(staleId));
    assert.deepEqual(staleId.body['denied'], ['id']);
    assert.equal(JSON.stringify(staleId).includes(latest.intentId), false);
    await writeOwnerNotification(selectedOwner.data['notification']);
    assert.deepEqual((await readReceipt()).body['projection'], successful);

    sendMode = 'malformed';
    committed(await notify(true));
    const uncertain = (await storage.state.outboxPending())[0]!;
    const uncertainDrive = await drive(uncertain.intentId);
    assert.equal(uncertainDrive.status, 'recorded');
    const recovery = await dispatcher.recover({ actor: user.user_id, operation: 'test.delivery.recover',
      nowMs: () => now, maxClaimAgeMs: 60_000, policy: { maxAttempts: 3, horizonMs: 3_600_000 },
      limit: 10, operationIdForStep: () => operationId(), planRecoveryScan });
    assert.deepEqual(recovery.reconciled, [{ intentId: uncertain.intentId, state: 'delivered' }]);
    assert.deepEqual(reconciles, [uncertain.intentId]);
    assert.deepEqual(sends, [first.intentId, latest.intentId, uncertain.intentId]);
    const reconciled = { status: 'succeeded', result: { reference: `accepted-${uncertain.intentId}` } };
    assert.deepEqual((await readReceipt()).body['projection'], reconciled);
    assert.equal((await storage.state.outboxPending()).length, 0);

    await miniflare!.dispose(); miniflare = undefined;
    storage = await open(); worker = await assemble(); dispatcher = await dispatcherFor();
    assert.deepEqual((await readReceipt()).body['projection'], reconciled);
    assert.equal((await storage.state.outboxPending()).length, 0);
    const outsider = await storage.identity.createUser({ email: 'delivery-outsider@example.test',
      password_hash: 'unused', email_verified: true });
    const outsiderGrant = await issueMcpGrant(storage.identity, { user_id: outsider.user_id,
      team_id: null, client_id: 'delivery-outsider' }, { clock });
    const hidden = await readReceipt(['status', 'result'], created.id, outsiderGrant.token);
    const missing = await readReceipt(['status', 'result'], 'missing-owner', outsiderGrant.token);
    assert.deepEqual(hidden, missing);
    assert.equal(hidden.body['code'], 'not_found', JSON.stringify(hidden));
    await storage.identity.removeMembership(membership.membership_id);
    const revoked = await readReceipt();
    assert.equal(revoked.status, 401, JSON.stringify(revoked));
    assert.equal(JSON.stringify(revoked).includes(uncertain.intentId), false);
    assert.equal(JSON.stringify(revoked).includes('reference'), false);
  } finally {
    await miniflare?.dispose();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
