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
const CHILD_MODEL = asModel(`${APP}.Child`);
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
    const observerRoles = ['viewer', 'delivery_reader'].map(role => ({ role: `${APP}.${role}`,
      granted_at: new Date(now).toISOString(), granted_by: user.user_id }));
    const membership = await storage.identity.createMembership({ team_id: team.team_id,
      user_id: user.user_id, is_owner: false, roles: observerRoles });
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
    const childCreation = await mutate('Child.create', { parent: { id: created.id } });
    committed(childCreation);
    const child = (childCreation.body['records'] as Array<{ id: string }>)[0]!;
    const parentStatus = (bearer = grant.token) =>
      mcp(`${APP}.parentStatus`, { child: { id: child.id } }, bearer);
    const parentInputs = async (inputs: Record<string, unknown> = {}, id = child.id) => {
      const current = await storage.state.load(CHILD_MODEL, asId(id)); assert.ok(current);
      return { operation_id: operationId(), child: { id, version: String(current.version) }, ...inputs };
    };
    const recordParentStatus = async (bearer = grant.token, op = 'recordParentStatus') => {
      return mcp(`${APP}.${op}`, await parentInputs(), bearer);
    };
    const assertParentStatus = async (succeeded: boolean) => {
      const read = await parentStatus();
      assert.equal(read.status, 200, JSON.stringify(read));
      assert.equal(read.body['result'], succeeded, JSON.stringify(read));
      assert.equal(committed(await recordParentStatus()), succeeded);
      assert.equal((await storage.state.load(CHILD_MODEL, asId(child.id)))?.data['label'], 'Observed');
    };
    const readReceipt = (selected = ['status', 'result'], id = created.id, bearer = grant.token) =>
      mcp('Receipt.read', { recordId: id, field: 'notification', selected }, bearer);
    const notify = async (accept: boolean) => {
      const current = await storage.state.load(MODEL, asId(created.id)); assert.ok(current);
      return mutate('notify', { entry: { id: current.id, version: String(current.version) },
        to: 'recipient@example.test', accept });
    };
    assert.equal((await readReceipt()).body['outcome'], 'null-association');
    await assertParentStatus(false);
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
    await assertParentStatus(false);
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
    await assertParentStatus(true);
    assert.equal(committed(await recordParentStatus(grant.token, 'recordQueriedParentStatus')), 'Observed');
    // Actual generated parent writes preserve the private link, read staged
    // values in source order, and reserve only the written parent's version.
    for (const op of ['renameParent', 'renameQueriedParent']) {
      const before = await storage.state.load(MODEL, asId(created.id)); assert.ok(before);
      const childBefore = await storage.state.load(CHILD_MODEL, asId(child.id)); assert.ok(childBefore);
      const label = `Edited by ${op}`;
      const inputs = await parentInputs({ label, accept: true });
      assert.equal(committed(await mcp(`${APP}.${op}`, inputs)), label);
      const after = await storage.state.load(MODEL, asId(created.id)); assert.ok(after);
      assert.equal(after.version, before.version + 1);
      assert.equal(after.data['label'], label);
      assert.deepEqual(after.data['notification'], before.data['notification']);
      assert.deepEqual(await storage.state.load(CHILD_MODEL, asId(child.id)), childBefore);
      const read = await mcp(`${APP}.parentLabel`, { child: { id: child.id } });
      assert.equal(read.body['result'], label, JSON.stringify(read));
      const history = await storage.state.historyFor(MODEL, asId(created.id));
      const replay = await mcp(`${APP}.${op}`, inputs);
      assert.equal(replay.body['status'], 'replayed', JSON.stringify(replay));
      assert.equal(replay.body['result'], label);
      assert.deepEqual(await storage.state.load(MODEL, asId(created.id)), after);
      assert.deepEqual(await storage.state.historyFor(MODEL, asId(created.id)), history);
      const rejected = await mcp(`${APP}.${op}`, await parentInputs({ label: 'Rejected parent', accept: false }));
      assert.equal(rejected.body['code'], 'rule_failed', JSON.stringify(rejected));
      assert.deepEqual(await storage.state.load(MODEL, asId(created.id)), after);
      assert.deepEqual(await storage.state.load(CHILD_MODEL, asId(child.id)), childBefore);
      assert.deepEqual(await storage.state.historyFor(MODEL, asId(created.id)), history);
    }
    // Archive isolated parents so all original delivery cases retain their
    // live owner. Their stored children retain the same protected parent link.
    for (const op of ['archiveParent', 'archiveQueriedParent']) {
      const parentCreation = await mutate('Entry.create'); committed(parentCreation);
      const parent = (parentCreation.body['records'] as Array<{ id: string }>)[0]!;
      const nestedCreation = await mutate('Child.create', { parent: { id: parent.id } }); committed(nestedCreation);
      const nested = (nestedCreation.body['records'] as Array<{ id: string }>)[0]!;
      const before = await storage.state.load(MODEL, asId(parent.id)); assert.ok(before);
      const nestedBefore = await storage.state.load(CHILD_MODEL, asId(nested.id)); assert.ok(nestedBefore);
      const rejected = await mcp(`${APP}.${op}`, await parentInputs({ accept: false }, nested.id));
      assert.equal(rejected.body['code'], 'rule_failed', JSON.stringify(rejected));
      assert.deepEqual(await storage.state.load(MODEL, asId(parent.id)), before);
      const inputs = await parentInputs({ accept: true }, nested.id);
      committed(await mcp(`${APP}.${op}`, inputs));
      const archived = await storage.state.load(MODEL, asId(parent.id)); assert.ok(archived);
      assert.equal(archived.archivedAt, now);
      assert.equal(archived.version, before.version + 1);
      assert.deepEqual(archived.data, before.data);
      assert.deepEqual(await storage.state.load(CHILD_MODEL, asId(nested.id)), nestedBefore);
      const replay = await mcp(`${APP}.${op}`, inputs);
      assert.equal(replay.body['status'], 'replayed', JSON.stringify(replay));
      assert.deepEqual(await storage.state.load(MODEL, asId(parent.id)), archived);
      const missing = await mcp(`${APP}.parentLabel`, { child: { id: nested.id } });
      assert.equal(missing.body['code'], 'not_found', JSON.stringify(missing));
    }
    assert.deepEqual((await readReceipt(['status'])).body['projection'], { status: 'succeeded' });
    assert.deepEqual((await readReceipt(['result'])).body['projection'], { result: successful.result });
    assert.equal((await storage.state.outboxPending()).length, 0);
    const denied = await readReceipt(['id']);
    assert.equal(denied.body['outcome'], 'denied', JSON.stringify(denied));
    assert.deepEqual(denied.body['denied'], ['id']);
    assert.equal(JSON.stringify(denied).includes(latest.intentId), false);
    const childBeforeDeniedId = await storage.state.load(CHILD_MODEL, asId(child.id));
    for (const response of [await mcp(`${APP}.parentId`, { child: { id: child.id } }),
      await recordParentStatus(grant.token, 'recordParentId')]) {
      assert.equal(response.body['code'], 'forbidden', JSON.stringify(response));
      assert.equal(JSON.stringify(response).includes(latest.intentId), false);
      assert.equal(Object.hasOwn(response.body, 'result'), false);
    }
    assert.deepEqual(await storage.state.load(CHILD_MODEL, asId(child.id)), childBeforeDeniedId);

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
    const childBeforeStale = await storage.state.load(CHILD_MODEL, asId(child.id));
    for (const response of [await parentStatus(), await recordParentStatus()]) {
      assert.notEqual(response.body['status'], 'committed', JSON.stringify(response));
      assert.equal(Object.hasOwn(response.body, 'result'), false, JSON.stringify(response));
      assert.equal(JSON.stringify(response).includes(`accepted-${latest.intentId}`), false);
    }
    assert.deepEqual(await storage.state.load(CHILD_MODEL, asId(child.id)), childBeforeStale);
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
    await assertParentStatus(true);
    // Removing only receipt grants leaves a readable parent label. Its omitted
    // delivery wire field must refuse, rather than turning into optional null.
    await storage.identity.setMembershipRoles(membership.membership_id, observerRoles.slice(0, 1));
    const childBeforeWithheld = await storage.state.load(CHILD_MODEL, asId(child.id));
    for (const response of [await parentStatus(), await recordParentStatus(),
      await recordParentStatus(grant.token, 'recordQueriedParentStatus')]) {
      assert.equal(response.body['code'], 'forbidden', JSON.stringify(response));
      assert.equal(JSON.stringify(response).includes(uncertain.intentId), false);
      assert.equal(Object.hasOwn(response.body, 'result'), false);
    }
    assert.deepEqual(await storage.state.load(CHILD_MODEL, asId(child.id)), childBeforeWithheld);
    await storage.identity.setMembershipRoles(membership.membership_id, observerRoles);
    await assertParentStatus(true);
    // Revoke a receipt grant after its initial resolution but before the real
    // receipt is loaded. Final read grants and mutation guards must refuse.
    for (const op of ['parentStatus', 'recordParentStatus', 'renameQueriedParent']) {
      const currentState = storage.state;
      const parentBeforeRevocation = await currentState.load(MODEL, asId(created.id));
      const parentHistoryBeforeRevocation = await currentState.historyFor(MODEL, asId(created.id));
      const childBeforeRevocation = await currentState.load(CHILD_MODEL, asId(child.id));
      const historyBeforeRevocation = await currentState.historyFor(CHILD_MODEL, asId(child.id));
      let revokeAtReceipt = true;
      storage.state = { ...currentState, load: async (model, id) => {
        if (model === RECEIPT_MODEL && revokeAtReceipt) {
          revokeAtReceipt = false;
          await storage.identity.setMembershipRoles(membership.membership_id, observerRoles.slice(0, 1));
        }
        return currentState.load(model, id);
      } };
      worker = await assemble();
      const response = op === 'parentStatus' ? await parentStatus() : op === 'renameQueriedParent'
        ? await mcp(`${APP}.${op}`, await parentInputs({ label: 'Revoked parent edit', accept: true }))
        : await recordParentStatus();
      assert.equal(revokeAtReceipt, false);
      assert.equal(response.body['code'], 'forbidden', JSON.stringify(response));
      assert.equal(JSON.stringify(response).includes(uncertain.intentId), false);
      assert.equal(Object.hasOwn(response.body, 'result'), false);
      assert.deepEqual(await currentState.load(CHILD_MODEL, asId(child.id)), childBeforeRevocation);
      assert.deepEqual(await currentState.historyFor(CHILD_MODEL, asId(child.id)), historyBeforeRevocation);
      assert.deepEqual(await currentState.load(MODEL, asId(created.id)), parentBeforeRevocation);
      assert.deepEqual(await currentState.historyFor(MODEL, asId(created.id)), parentHistoryBeforeRevocation);
      storage.state = currentState;
      await storage.identity.setMembershipRoles(membership.membership_id, observerRoles);
      worker = await assemble();
    }
    // A granted Child link can outlive its target. Exercise the stored current
    // link through D1, keeping the protected association and receipt untouched.
    const changeChildParent = async (parentId: string) => {
      const current = await storage.state.load(CHILD_MODEL, asId(child.id)); assert.ok(current);
      await storage.state.commit({ expectedRevision: await storage.state.readRevision(),
        writes: [{ kind: 'update', model: CHILD_MODEL, id: current.id, expectedVersion: current.version,
          row: { ...current, version: (current.version + 1) as typeof current.version,
            parent: { model: MODEL, id: asId(parentId) } } }],
        history: [], receipt: null, outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [],
      });
    };
    await changeChildParent('missing-parent');
    const childBeforeMissing = await storage.state.load(CHILD_MODEL, asId(child.id));
    const missingParent = await parentStatus();
    assert.equal(missingParent.body['code'], 'not_found', JSON.stringify(missingParent));
    const missingMutation = await recordParentStatus();
    assert.equal(missingMutation.body['code'], 'not_found', JSON.stringify(missingMutation));
    for (const op of ['renameParent', 'renameQueriedParent', 'archiveParent', 'archiveQueriedParent']) {
      const response = await mcp(`${APP}.${op}`, await parentInputs({ accept: true,
        ...(op.startsWith('rename') ? { label: 'Missing parent edit' } : {}) }));
      assert.equal(response.body['code'], 'not_found', JSON.stringify(response));
    }
    assert.deepEqual(await storage.state.load(CHILD_MODEL, asId(child.id)), childBeforeMissing);
    await changeChildParent(created.id);
    await storage.identity.setMembershipRoles(membership.membership_id, []);
    const hiddenParent = await parentStatus();
    assert.deepEqual(hiddenParent, missingParent);
    const childBeforeHidden = await storage.state.load(CHILD_MODEL, asId(child.id));
    const historyBeforeHidden = await storage.state.historyFor(CHILD_MODEL, asId(child.id));
    const hiddenMutation = await recordParentStatus();
    assert.equal(hiddenMutation.body['code'], 'not_found', JSON.stringify(hiddenMutation));
    assert.equal(JSON.stringify(hiddenMutation).includes(uncertain.intentId), false);
    assert.equal(Object.hasOwn(hiddenMutation.body, 'result'), false);
    assert.deepEqual(await storage.state.load(CHILD_MODEL, asId(child.id)), childBeforeHidden);
    assert.deepEqual(await storage.state.historyFor(CHILD_MODEL, asId(child.id)), historyBeforeHidden);
    const parentBeforeHidden = await storage.state.load(MODEL, asId(created.id));
    const parentHistoryBeforeHidden = await storage.state.historyFor(MODEL, asId(created.id));
    for (const op of ['renameQueriedParent', 'archiveQueriedParent']) {
      const response = await mcp(`${APP}.${op}`, await parentInputs({ accept: true,
        ...(op.startsWith('rename') ? { label: 'Hidden parent edit' } : {}) }));
      assert.equal(response.body['code'], 'not_found', JSON.stringify(response));
      assert.equal(Object.hasOwn(response.body, 'result'), false);
    }
    assert.deepEqual(await storage.state.load(MODEL, asId(created.id)), parentBeforeHidden);
    assert.deepEqual(await storage.state.historyFor(MODEL, asId(created.id)), parentHistoryBeforeHidden);
    await storage.identity.setMembershipRoles(membership.membership_id, observerRoles);
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
    for (const response of [await parentStatus(), await recordParentStatus()]) {
      assert.equal(response.status, 401, JSON.stringify(response));
      assert.equal(JSON.stringify(response).includes(uncertain.intentId), false);
      assert.equal(Object.hasOwn(response.body, 'result'), false);
    }
    for (const op of ['renameParent', 'renameQueriedParent', 'archiveParent', 'archiveQueriedParent']) {
      const response = await mcp(`${APP}.${op}`, await parentInputs({ accept: true,
        ...(op.startsWith('rename') ? { label: 'Revoked parent edit' } : {}) }));
      assert.equal(response.status, 401, JSON.stringify(response));
      assert.equal(Object.hasOwn(response.body, 'result'), false);
    }
  } finally {
    await miniflare?.dispose();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
