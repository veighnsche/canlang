import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CommitBatch, CompileArtifact, MutationEnvelope, OutboxIntent, ProviderBinding, StoragePort, CanTypeId, FrameworkFilePayloadOrigin, Revision, RecordVersion } from '@canlang/contracts';
import type { InstalledMailSender } from '@canlang/services';
import { EmailV1Adapter } from '@canlang/services/mail/adapter';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { FIXED_NOW, asId, asModel, asOperationId, createMemoryIdentityStore, makeIdentity, seedMember, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker, type MutationOutcome } from '@canlang/cloudflare/worker/assembly';
import { WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { WORK_DISPATCH_MODEL } from '@canlang/work/kernel/tables';
import { attemptDispatch, attemptDispatchAsync, assertDispatchGuardExecution, registerDispatchGuardRevalidation,
  type DispatchGuardExecution } from '@canlang/work/dispatch';
import { deriveOutboxId } from '@canlang/work/intent';
import { classifyFailure } from '@canlang/work/receipt';
import { planRecoveryScan } from '@canlang/work/recovery';
import { createBoundMailAdapter } from '@canlang/cloudflare/runtime/bound-mail';
import { createBoundMailDispatcher } from '@canlang/cloudflare/runtime/bound-dispatch';
import type { FenceAttemptDispatchFn } from './invoke.js';
import { createWorkerDispatchJoinPort, createWorkerDispatchRegistry, loadDispatchSystemProducers,
  stageDispatchBatch, withDispatchJoinPort } from './invoke.js';
import { assembleDispatchCommands } from '../worker/assembly.js';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { STATE_FILE_REFERENCE_PRODUCER, prepareFrameworkFilePayloadOrigin } from '@canlang/state/storage';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work';
import { loadArtifactDescriptors } from '@canlang/state/invocation/registry';
import { createSystemRegistry, defineSystemCommand, systemCommandStageRevision } from '@canlang/state';
import { stageAuthoredDelivery } from '@canlang/state/receipt/authored-delivery';
import { RECEIPT_MODEL, RECEIPT_ASSOCIATION_MODEL, readReceiptRow, readAssociationRow,
  withReceiptRowData } from '@canlang/state/receipt/tables';
import { makeRow, makeBatch } from '@canlang/state/testing/invocation/fixtures';
import { encodeValue, makeDeliveryRef } from '@canlang/values';

const APP = 'TypedDurableSend', MODEL = asModel(`${APP}.Entry`);
const fixturePath = resolve('packages/cloudflare/test/fixtures/typed-durable-send.json');
let sequence = 0;
const operationId = () => asOperationId(uuidv7(FIXED_NOW, ++sequence));
function committed(outcome: MutationOutcome) {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, 'committed');
  return outcome.result;
}
async function openD1(persistDir: string) {
  const worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'bound-mail-durable' }, d1Persist: persistDir });
  try {
    const database = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(database);
    return { worker, store: createD1Storage(database) };
  } catch (error) { await worker.dispose(); throw error; }
}

test('bound Mail guarded async component selects physical preclaim for false ACK and true provider delivery', async () => {
  // The binding comes from the unchanged compiled fixture. Guard/operator and
  // installed MailSender ports are component fixtures, not native source proof.
  const dir = await mkdtemp(join(tmpdir(), 'can-bound-mail-preclaim-'));
  let d1: Awaited<ReturnType<typeof openD1>> | undefined;
  try {
    const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui'),
    });
    const definition = (await import(asm.entryUrl)).appDefinition as unknown;
    const memberships = createMemoryIdentityStore(), owner = await seedMember(memberships, { isOwner: true });
    d1 = await openD1(join(dir, 'd1'));
    const physical = d1.store, batches: CommitBatch[] = [];
    const observed: StoragePort = { ...physical, commit: async batch => {
      batches.push(structuredClone(batch)); return physical.commit(batch);
    } };
    const binding: ProviderBinding = { deployment: 'deployment.mail', capability: 'std.EmailV1', capabilityVersion: 1, account: 'component-local-mail' };
    const events: string[] = []; let activeExecution: DispatchGuardExecution | undefined;
    let providerCalls = 0, mints = 0, authorityReads = 0;
    const expectedRequest = { to: 'component@example.test', subject: 'Preclaim component', body: 'Actual retained request', attachments: [] };
    const installed: InstalledMailSender = { binding, mail: {
      send: async (input, options) => {
        events.push('provider'); providerCalls++; assert.deepEqual({ ...input }, expectedRequest);
        assert.ok(activeExecution);
        const retained = await physical.outboxGet(options.deliveryId); assert.ok(retained);
        assert.equal(retained.intent.intentId, options.deliveryId);
        const row = await physical.load(asModel(WORK_DISPATCH_MODEL), asId(options.deliveryId)); assert.ok(row);
        assert.equal(row.data['state'], 'claimed'); assert.equal(row.data['attempts'], 0);
        return { delivery_id: options.deliveryId, status: 'succeeded', result: { reference: 'component-accepted' }, error: null };
      },
      reconcile: async () => { throw new Error('fresh preclaim component cannot reconcile'); },
    } };
    const adapter = createBoundMailAdapter({ appDefinition: definition, binding,
      resolveInstalledMailSender: deployment => { assert.equal(deployment, binding.deployment); return installed; } });
    const dispatcher = await createBoundMailDispatcher({ store: observed, adapter, workCommands: WORK_SYSTEM_COMMANDS,
      stageCommands: WORK_DISPATCH_STAGE_COMMANDS, createClaimCommand: createWorkDispatchClaimCommand });
    const producers = await loadDispatchSystemProducers();
    const registry = await createWorkerDispatchRegistry(assembleDispatchCommands({ l3Commands: producers.l3Commands,
      workCommands: WORK_SYSTEM_COMMANDS, stageCommands: WORK_DISPATCH_STAGE_COMMANDS }));
    const joined = withDispatchJoinPort(physical, await createWorkerDispatchJoinPort(physical));
    for (const allowed of [false, true]) {
      const id = `bound-mail-preclaim-${allowed}`;
      await stageDispatchBatch({ registry, store: joined, actor: owner.user.user_id, operation: 'component.stage', now: FIXED_NOW,
        runKey: operationId(), intents: [{ intentId: id, operation: `${APP}.deliver`, originOperationId: operationId(),
          source: 'std.EmailV1.send', occurrenceIndex: 0, originOccurrence: null, guard: 'allowed', guardVerdict: true,
          request: { binding: `${APP}.Mail`, from: binding.deployment, arguments: expectedRequest } }] });
      const beforeRevision = await physical.readRevision();
      const original = await physical.outboxGet(id); assert.ok(original?.originalCommit);
      const beforeRow = await physical.load(asModel(WORK_DISPATCH_MODEL), asId(id)); assert.ok(beforeRow);
      const beforeHistory = await physical.historyFor(asModel(WORK_DISPATCH_MODEL), asId(id));
      batches.length = 0; events.length = 0;
      const beforeProviders = providerCalls, beforeMints = mints, beforeAuthority = authorityReads;
      const outcome = await dispatcher.drive({ intentId: id, actor: owner.user.user_id, operation: 'component.drive',
        nowMs: () => FIXED_NOW + 1000, nextClaimId: () => { events.push('mint'); mints++; return `claim-${id}`; },
        maxClaimAgeMs: 60_000, claimOperationId: operationId(), recordOperationId: operationId(), classifyFailure,
        evaluateGuard: () => { throw new Error('bound async input cannot select legacy postclaim evaluation'); },
        readStateSnapshot: () => ({ current: allowed }),
        fence: { owner: owner.team.team_id, revalidateAuthority: async () => {
          events.push('authority'); authorityReads++; assert.ok(activeExecution);
          const current = await memberships.findMembership(owner.team.team_id, owner.user.user_id);
          return current?.status === 'active' && current.is_owner;
        }, asyncGuard: { attemptDispatch: attemptDispatchAsync, frozenInputs: { allowed },
          evaluateGuard: async (predicate, lexical, snapshot, handle) => {
            events.push('guard'); activeExecution = handle; assertDispatchGuardExecution(handle);
            assert.equal(predicate, 'allowed'); assert.deepEqual(lexical, { allowed }); assert.deepEqual(snapshot, { current: allowed });
            registerDispatchGuardRevalidation(handle, () => {
              events.push('evidence'); return true;
            });
            await Promise.resolve(); assertDispatchGuardExecution(handle); return allowed;
          } } },
      });
      assert.ok(activeExecution);
      assert.throws(() => assertDispatchGuardExecution(activeExecution));
      assert.equal(providerCalls - beforeProviders, allowed ? 1 : 0);
      assert.equal(mints - beforeMints, allowed ? 1 : 0); assert.equal(authorityReads - beforeAuthority, 1);
      assert.deepEqual(events, allowed ? ['guard','mint','evidence','authority','provider'] : ['guard','evidence','authority']);
      assert.equal(batches.length, allowed ? 2 : 1);
      assert.equal(await physical.readRevision(), beforeRevision + batches.length);
      assert.deepEqual(await physical.historyFor(asModel(WORK_DISPATCH_MODEL), asId(id)), beforeHistory);
      const after = await physical.load(asModel(WORK_DISPATCH_MODEL), asId(id)); assert.ok(after);
      assert.equal(after.data['attempts'], allowed ? 1 : 0); assert.equal(after.data['state'], allowed ? 'delivered' : 'pending');
      assert.deepEqual((await physical.outboxGet(id))?.originalCommit, original.originalCommit);
      assert.deepEqual((await physical.outboxGet(id))?.intent, original.intent);
      assert.deepEqual(await physical.outboxPending(), []);
      for (const batch of batches) {
        assert.equal(batch.receipt, null); assert.deepEqual(batch.history, []); assert.deepEqual(batch.outbox, []);
        assert.deepEqual(batch.schedules, []); assert.deepEqual(batch.uniqueClaims, []); assert.deepEqual(batch.uniqueReleases, []);
        assert.equal(batch.writes.length, 1); assert.equal(batch.writes[0]!.model, WORK_DISPATCH_MODEL);
      }
      if (allowed) { assert.equal(outcome.status, 'recorded'); assert.equal(batches[0]!.outboxAck?.length, 0);
        assert.deepEqual(batches[1]!.outboxAck, [id]); }
      else { assert.equal(outcome.status, 'not-claimed'); assert.deepEqual(batches[0]!.outboxAck, [id]);
        assert.equal(after.data['claimId'], null); assert.equal(after.data['claimedAtMs'], null);
        assert.deepEqual(after.data, { ...beforeRow.data, guardVerdict: false }); }
    }
  } finally {
    if (d1 !== undefined) await d1.worker.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('bound false preclaim atomically skips the genuine pending receipt and retains queued provenance', async () => {
  // Component declarations supply a delivery slot and a parameterless caller beside the existing Mail fixture.
  // State issues the origin against its installed inventory; Work and State run
  // their real commands. This is not original compiled guarded-source acceptance.
  const dir = await mkdtemp(join(tmpdir(), 'can-bound-mail-skip-receipt-'));
  try {
    const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui'),
    });
    const definition = (await import(asm.entryUrl)).appDefinition as unknown;
    const target = 'std.EmailV1.send', operation = `${APP}.deliver`;
    const result = { name: 'EmailAccepted', fields: [{ name: 'reference', type: 'text' as CanTypeId }] };
    const delivery = { kind: 'delivery' as const, capability: 'std.EmailV1', operation: 'send', version: 1, result };
    const models = artifact.models!.map(model => ({ ...model, fields: [...model.fields,
      { name: 'request', field: delivery, required: false, nullable: true, serverOnly: false }] }));
    const original = { ...artifact, models, valueTypes: { contracts: [result] }, operations: artifact.operations!.map(item =>
      item.name === operation ? { ...item, inputs: { fields: [] } } : item) };
    const loaded = loadArtifactDescriptors(original, { by: 'owner' });
    const model = models.find(model => model.name === MODEL)!;
    const source = { ...artifact.sources[0]!, module: artifact.callables[0]!.module };
    const callable = artifact.callables.find(callable => callable.id === operation)!;
    const authored = original.operations.find(item => item.name === operation)!;
    const def = loaded.registry.get(operation)!;
    const descriptor = (def as { descriptor: import('@canlang/contracts').CanonicalOperationDescriptor }).descriptor;
    const canonicalDelivery = loaded.models.find(model => model.name === MODEL)!.fields.request!.delivery!;
    assert.ok(!('judgment' in canonicalDelivery));
    if ('judgment' in canonicalDelivery) throw new Error('Actual Mail delivery required.');
    const declaration = { kind: 'capability' as const, canonical: canonicalDelivery, artifact: delivery };
    const binding: ProviderBinding = { deployment: 'deployment.mail', capability: 'std.EmailV1', capabilityVersion: 1, account: 'skip-component-mail' };
    for (const mode of ['skip', 'attempted', 'owner-field', 'terminal', 'authority'] as const) {
      const memberships = createMemoryIdentityStore(), owner = await seedMember(memberships, { isOwner: true });
      const authority = { app: APP, stateOwner: APP, stateStoreId: `skip-state-${mode}`, fileStoreId: `skip-files-${mode}`,
        receiver: { app: APP, team: owner.team.team_id, owner: owner.team.team_id } };
      const producers = [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER];
      const { store: physical } = createTestMemoryStorage(authority, producers);
      const identity = { owner: APP, snapshotId: `skip-original-${mode}`, digest: `skip-digest-${mode}` };
      const snapshot = { ...identity, installedRevision: 1 as Revision, installedAt: FIXED_NOW };
      const callerResult = 'skip/caller/result', providerResult = 'skip/provider/result';
      await physical.installFileReferenceInventory({ expectedRevision: await physical.readRevision(), authority, snapshot,
        inventory: { ...identity, canonicalModels: loaded.models, artifactModels: models, valueTypes: loaded.valueTypes!,
          frameworkModels: producers.flatMap(producer => producer.models), opaqueDeclarationSets: [{
            id: 'skip/original', inventory: identity, snapshot, sources: artifact.sources, canonicalModels: loaded.models,
            artifactModels: models, valueTypes: loaded.valueTypes!, originalContracts: { EmailAccepted: { fields: { reference: { type: 'text' } } } },
            valueDefaults: [], declarations: [
              { id: 'skip/caller/inputs', source: { kind: 'callable', source, callable },
                profile: { kind: 'inputs', canonical: descriptor.inputs, artifact: authored.inputs.fields } },
              { id: callerResult, source: { kind: 'callable', source, callable },
                profile: { kind: 'result', canonical: descriptor.result!, artifact: authored.result! } },
              { id: providerResult, source: { kind: 'delivery', source, context: declaration },
                profile: { kind: 'provider-result', canonical: result, artifact: result } },
            ],
          }] } });
      const batches: CommitBatch[] = [];
      const observed: StoragePort = { ...physical, commit: async batch => {
        const outcome = await physical.commit(batch); batches.push(structuredClone(batch)); return outcome;
      } };
      let providerCalls = 0, mints = 0;
      const installed: InstalledMailSender = { binding, mail: {
        send: async () => { providerCalls++; assert.fail('False guarded receipt must not reach provider'); },
        reconcile: async () => assert.fail('Fresh false guarded receipt cannot reconcile'),
      } };
      const adapter = createBoundMailAdapter({ appDefinition: definition, binding, resolveInstalledMailSender: () => installed });
      const dispatcher = await createBoundMailDispatcher({ store: observed, adapter, workCommands: WORK_SYSTEM_COMMANDS,
        stageCommands: WORK_DISPATCH_STAGE_COMMANDS, createClaimCommand: createWorkDispatchClaimCommand });
      const system = await loadDispatchSystemProducers();
      const registry = await createWorkerDispatchRegistry(assembleDispatchCommands({ l3Commands: system.l3Commands,
        workCommands: WORK_SYSTEM_COMMANDS, stageCommands: WORK_DISPATCH_STAGE_COMMANDS }));
      const joined = withDispatchJoinPort(physical, await createWorkerDispatchJoinPort(physical));
      const id = `receipt-preclaim-${mode}`;
      await stageDispatchBatch({ registry, store: joined, actor: owner.user.user_id, operation: 'component.stage', now: FIXED_NOW,
        runKey: operationId(), intents: [{ intentId: id, operation, originOperationId: operationId(), source: target,
          occurrenceIndex: 0, originOccurrence: null, guard: 'allowed', guardVerdict: true,
          request: { binding: `${APP}.Mail`, from: binding.deployment,
            arguments: { to: 'component@example.test', subject: 'Skip', body: 'Original request', attachments: [] } } }] });
      const retained = await physical.outboxGet(id); assert.ok(retained);
      const intent = retained.intent;
      const ownerRow = makeRow({ id: `owner-${mode}`, createdBy: owner.user.user_id,
        data: { count: '0', request: encodeValue(`delivery(${target})`, makeDeliveryRef(id, target)) } });
      let header: FrameworkFilePayloadOrigin | undefined;
      const authoredInput = { model, recordId: ownerRow.id, field: 'request', value: makeDeliveryRef(id, target),
        operationId: intent.operationId, queued: new Map([[id, intent]]), valueTypes: loaded.valueTypes!, ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) };
      const receiptRegistry = createSystemRegistry([defineSystemCommand({ name: 'component.receipt', stage: async (_args, ctx) => {
        const revision = systemCommandStageRevision(ctx) + 1;
        const provisional = await stageAuthoredDelivery({ ...authoredInput, revision }, ctx);
        const write = provisional.writes!.find(write => write.kind === 'insert' && write.model === RECEIPT_MODEL)!;
        assert.ok(write.kind === 'insert');
        header = await prepareFrameworkFilePayloadOrigin(physical, { expectedRevision: systemCommandStageRevision(ctx), inventoryOwner: APP,
          declarationSetId: 'skip/original', model: asModel(RECEIPT_MODEL), row: write.row, field: 'result', files: [],
          scope: { app: APP, owner: owner.team.team_id, ownerPackage: APP }, origin: { kind: 'delivery-result', deliveryId: id,
            caller: { source, callable, canonical: descriptor, artifact: authored, resultDeclarationId: callerResult },
            association: { model: MODEL, recordId: ownerRow.id, field: 'request' }, declaration, resultDeclarationId: providerResult,
            request: { binding: `${APP}.Mail`, from: binding.deployment }, intent: { intentId: id, operation: intent.operation,
              operationId: intent.operationId, target, occurrenceIndex: intent.occurrenceIndex } } });
        const receipt = await stageAuthoredDelivery({ ...authoredInput, revision, filePayloadOrigin: header }, ctx);
        return { ...receipt, writes: [{ kind: 'insert', model: MODEL, row: ownerRow }, ...receipt.writes!] };
      } } )]);
      await receiptRegistry.run('component.receipt', {}, { actor: owner.user.user_id, now: FIXED_NOW, operation, operationId: operationId() }, { store: physical });
      assert.equal(header?.origin.kind, 'delivery-result');
      if (mode !== 'skip' && mode !== 'authority') {
        const dispatch = await physical.load(asModel(WORK_DISPATCH_MODEL), asId(id)); assert.ok(dispatch);
        const receipt = await physical.load(asModel(RECEIPT_MODEL), asId(id)); assert.ok(receipt);
        const ownerCurrent = await physical.load(MODEL, ownerRow.id); assert.ok(ownerCurrent);
        const changed = mode === 'attempted' ? { ...dispatch, version: (dispatch.version + 1) as RecordVersion, data: { ...dispatch.data, attempts: 1 } }
          : mode === 'owner-field' ? { ...ownerCurrent, version: (ownerCurrent.version + 1) as RecordVersion, data: { ...ownerCurrent.data,
            request: encodeValue(`delivery(${target})`, makeDeliveryRef('superseded', target)) } }
          : withReceiptRowData(receipt, { ...readReceiptRow(receipt).receipt, status: 'failed', result: null,
            error: { code: 'terminal', message: 'Original terminal outcome' }, contentRef: null, resultExpiresAtMs: null },
            { actor: owner.user.user_id, nowMs: FIXED_NOW });
        const changedModel = mode === 'attempted' ? asModel(WORK_DISPATCH_MODEL) : mode === 'owner-field' ? MODEL : asModel(RECEIPT_MODEL);
        await physical.commit(makeBatch(await physical.readRevision(), { writes: [{ kind: 'update', model: changedModel,
          id: changed.id, expectedVersion: (changed.version - 1) as RecordVersion, row: changed }] }));
      }
      const before = { revision: await physical.readRevision(), dispatch: await physical.load(asModel(WORK_DISPATCH_MODEL), asId(id)),
        receipt: await physical.load(asModel(RECEIPT_MODEL), asId(id)), associations: await physical.query({ model: asModel(RECEIPT_ASSOCIATION_MODEL), authority: 'owner' }),
        outbox: await physical.outboxGet(id) };
      batches.length = 0;
      const drive = () => dispatcher.drive({ intentId: id, actor: owner.user.user_id, operation: 'component.drive', nowMs: () => FIXED_NOW + 1000,
        nextClaimId: () => { mints++; return `claim-${id}`; }, maxClaimAgeMs: 60_000, claimOperationId: operationId(), recordOperationId: operationId(),
        classifyFailure, evaluateGuard: () => assert.fail('Original async path must run'), readStateSnapshot: () => null,
        fence: { owner: owner.team.team_id, revalidateAuthority: async () => mode !== 'authority', asyncGuard: {
          attemptDispatch: attemptDispatchAsync, frozenInputs: {}, evaluateGuard: async (_rule, _inputs, _snapshot, execution) => {
            assertDispatchGuardExecution(execution); registerDispatchGuardRevalidation(execution, () => true); return false;
          } } } });
      if (mode === 'skip') {
        assert.equal((await drive()).status, 'not-claimed');
        assert.equal(batches.length, 1); assert.deepEqual(batches[0]!.outboxAck, [id]); assert.equal(batches[0]!.writes.length, 3);
        assert.equal(await physical.readRevision(), before.revision + 1);
        const receipt = await physical.load(asModel(RECEIPT_MODEL), asId(id)); assert.ok(receipt);
        const saved = readReceiptRow(receipt);
        assert.deepEqual(saved.receipt, { deliveryId: id, revision: before.revision + 1, status: 'skipped', result: null, error: null });
        assert.deepEqual(saved.filePayloadOrigin, header); assert.equal(saved.contentRef, null); assert.equal(saved.resultExpiresAtMs, null);
        const association = readAssociationRow((await physical.query({ model: asModel(RECEIPT_ASSOCIATION_MODEL), authority: 'owner' }))[0]!);
        assert.equal(association.deliveryId, id); assert.equal(association.revision, saved.receipt.revision);
        assert.deepEqual((await physical.outboxGet(id))?.intent, before.outbox!.intent);
        assert.deepEqual((await physical.outboxGet(id))?.originalCommit, before.outbox!.originalCommit);
        await assert.rejects(stageAuthoredDelivery({ ...authoredInput, revision: before.revision + 1 },
          { actor: owner.user.user_id, now: FIXED_NOW, operation, load: physical.load, query: physical.query }));
        assert.deepEqual(await physical.load(asModel(RECEIPT_MODEL), asId(id)), receipt);
        assert.equal((await drive()).status, 'not-pending'); assert.equal(batches.length, 1);
      } else {
        await assert.rejects(drive()); assert.equal(batches.length, 0); assert.equal(await physical.readRevision(), before.revision);
        assert.deepEqual(await physical.load(asModel(WORK_DISPATCH_MODEL), asId(id)), before.dispatch);
        assert.deepEqual(await physical.load(asModel(RECEIPT_MODEL), asId(id)), before.receipt);
        assert.deepEqual(await physical.query({ model: asModel(RECEIPT_ASSOCIATION_MODEL), authority: 'owner' }), before.associations);
        assert.deepEqual(await physical.outboxGet(id), before.outbox);
      }
      assert.equal(providerCalls, 0); assert.equal(mints, 0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('actual installed Email dispatch preserves durable identity and reconciles uncertainty through localhost', async () => {
  // This server is the only provider endpoint: no external email or paid calls.
  const sends: Array<{ id: string; idempotency: string | undefined; body: Record<string, unknown> }> = [];
  const reconciledIds: string[] = [];
  let sendMode: 'accepted' | 'malformed' = 'accepted';
  let reconcileMode: 'missing' | 'accepted' = 'missing';
  const server = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/send') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      sends.push({ id: body['delivery_id'] as string,
        idempotency: request.headers['idempotency-key'] as string | undefined, body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(sendMode === 'accepted' ? { reference: `accepted-${body['delivery_id']}` } : { unexpected: true }));
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/deliveries/')) {
      const id = decodeURIComponent(request.url.slice('/deliveries/'.length));
      reconciledIds.push(id);
      response.writeHead(reconcileMode === 'missing' ? 404 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reconcileMode === 'missing' ? {} : { status: 'accepted', reference: `accepted-${id}` }));
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
  const dir = await mkdtemp(join(tmpdir(), 'can-bound-mail-'));
  let d1: Awaited<ReturnType<typeof openD1>> | undefined;
  try {
    const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui'),
    });
    const definition = (await import(asm.entryUrl)).appDefinition as unknown;
    // Actor/team authority remains explicit memory fixtures; effects use real D1.
    const memberships = createMemoryIdentityStore();
    const owner = await seedMember(memberships, { isOwner: true });
    const identity = makeIdentity({ membership: owner.membership, email: owner.user.email });
    d1 = await openD1(join(dir, 'd1'));
    const invoker = buildInvoker(artifact, asm, d1.store, { memberships, now: () => FIXED_NOW });
    const mutate = (operation: string, inputs: MutationEnvelope['inputs']) =>
      invoker.invokeMutation({ operation: `${APP}.${operation}`, operation_id: operationId(), inputs }, identity);
    const row = committed(await mutate('Entry.create', {})).records![0] as { id: string; version: number };
    const firstSend = committed(await mutate('deliver', { entry: { id: row.id, version: '1' }, to: 'recipient@example.test', accept: true }));
    assert.equal(firstSend.result, '1');
    const pending = await d1.store.outboxPending(); assert.equal(pending.length, 1);
    const first = pending[0]!;
    assert.equal(first.target, 'std.EmailV1.send');
    assert.deepEqual(first.arguments, { binding: `${APP}.Mail`, from: 'deployment.mail',
      arguments: { to: 'recipient@example.test', subject: 'Actual send', body: 'Durable request', attachments: [] } });
    const binding: ProviderBinding = { deployment: 'deployment.mail', capability: 'std.EmailV1', capabilityVersion: 1, account: 'local-mail-account' };
    const mail = new EmailV1Adapter({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 2_000,
      maxBodyBytes: 16_384, maxTransportBytes: null, clock: { now: () => FIXED_NOW } });
    let installed: InstalledMailSender | null = null;
    const adapter = createBoundMailAdapter({ appDefinition: definition, binding, resolveInstalledMailSender: deployment => {
      assert.equal(deployment, binding.deployment); return installed;
    } });
    const dispatcherFor = () => createBoundMailDispatcher({ store: d1!.store, adapter,
      workCommands: WORK_SYSTEM_COMMANDS, stageCommands: WORK_DISPATCH_STAGE_COMMANDS, createClaimCommand: createWorkDispatchClaimCommand });
    let dispatcher = await dispatcherFor();
    const called: string[] = [];
    let now = FIXED_NOW, crashAfterClaim = false;
    const drive = (intentId: string) => dispatcher.drive({ intentId, actor: owner.user.user_id, operation: 'test.mail.drive',
      nowMs: () => now, nextClaimId: () => `claim-${++sequence}`, maxClaimAgeMs: 60_000,
      claimOperationId: operationId(), recordOperationId: operationId(), classifyFailure,
      evaluateGuard: () => { called.push('guard'); return true; },
      readStateSnapshot: () => { called.push('snapshot'); return null; },
      fence: { owner: owner.team.team_id, attemptDispatch: attemptDispatch as FenceAttemptDispatchFn,
        revalidateAuthority: async () => { called.push('authority');
          if (crashAfterClaim) throw new Error('Actual authority interruption after claim');
          const member = await memberships.findMembership(owner.team.team_id, owner.user.user_id);
          return member?.status === 'active' && member.is_owner; } },
    });
    const recover = (limit = 10) => dispatcher.recover({ actor: owner.user.user_id, operation: 'test.mail.recover', nowMs: () => now,
      maxClaimAgeMs: 60_000, policy: { maxAttempts: 3, horizonMs: 3_600_000 }, limit,
      operationIdForStep: () => operationId(), planRecoveryScan });
    const initialRevision = await d1.store.readRevision();
    const initialDispatch = await d1.store.load(asModel(WORK_DISPATCH_MODEL), asId(first.intentId));
    let refusedRuns = 0;
    for (const unavailable of [null, { binding: { ...binding, account: 'different-account' }, mail }]) {
      installed = unavailable;
      assert.equal((await drive(first.intentId)).status, 'unavailable');
      assert.deepEqual(called, []); assert.equal(sends.length, 0);
      // Existing State system commands fence even an empty staging result.
      // Availability leaves all domain, claim, attempt and outbox data intact.
      assert.equal(await d1.store.readRevision(), initialRevision + ++refusedRuns);
      assert.deepEqual(await d1.store.load(asModel(WORK_DISPATCH_MODEL), asId(first.intentId)), initialDispatch);
      assert.deepEqual(await d1.store.outboxPending(), pending);
    }
    installed = { binding, mail };
    const delivered = await drive(first.intentId);
    assert.equal(delivered.status, 'recorded');
    assert.ok('state' in delivered); assert.equal(delivered.state, 'delivered');
    assert.equal(delivered.attempts, 1);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]!.id, first.intentId); assert.equal(sends[0]!.idempotency, first.intentId);
    assert.deepEqual(sends[0]!.body, { delivery_id: first.intentId, to: 'recipient@example.test', subject: 'Actual send', body: 'Durable request', attachments: [] });
    assert.equal((await d1.store.outboxPending()).length, 0);

    sendMode = 'malformed';
    committed(await mutate('deliver', { entry: { id: row.id, version: '2' }, to: 'recipient@example.test', accept: true }));
    const second = (await d1.store.outboxPending())[0]!;
    // A real authority interruption after the actual Work claim leaves a
    // durable claimed row. No provider call has occurred before this crash.
    crashAfterClaim = true;
    await assert.rejects(drive(second.intentId), /Actual authority interruption after claim/);
    assert.equal(sends.length, 1);
    const heldClaim = await d1.store.load(asModel(WORK_DISPATCH_MODEL), asId(second.intentId));
    assert.equal(heldClaim?.data['state'], 'claimed'); assert.equal(heldClaim?.data['attempts'], 0);
    await d1.worker.dispose(); d1 = undefined;
    d1 = await openD1(join(dir, 'd1')); dispatcher = await dispatcherFor();
    assert.deepEqual(await d1.store.load(asModel(WORK_DISPATCH_MODEL), asId(second.intentId)), heldClaim);
    crashAfterClaim = false; now += 60_001;
    const resumed = await recover();
    assert.ok(resumed.released.includes(second.intentId));
    assert.equal((await d1.store.load(asModel(WORK_DISPATCH_MODEL), asId(second.intentId)))?.data['state'], 'pending');
    assert.equal(sends.length, 1);
    const uncertain = await drive(second.intentId);
    assert.equal(uncertain.status, 'recorded'); assert.ok('state' in uncertain);
    assert.equal(uncertain.state, 'uncertain'); assert.equal(uncertain.attempts, 1);
    assert.equal(sends.length, 2); assert.equal(sends[1]!.id, second.intentId);
    const uncertainRow = await d1.store.load(asModel(WORK_DISPATCH_MODEL), asId(second.intentId));
    const missing = await recover();
    assert.equal(missing.reconciled.length, 0); assert.equal(missing.retried.length, 0);
    assert.ok(missing.awaiting.includes(second.intentId)); assert.equal(sends.length, 2);
    assert.deepEqual(await d1.store.load(asModel(WORK_DISPATCH_MODEL), asId(second.intentId)), uncertainRow);
    assert.deepEqual(reconciledIds, [second.intentId]);
    assert.equal((await d1.store.outboxPending())[0]!.intentId, second.intentId);

    // Reopen the actual D1 directory with the same installation and original id.
    await d1.worker.dispose(); d1 = undefined;
    d1 = await openD1(join(dir, 'd1')); dispatcher = await dispatcherFor();
    assert.deepEqual(await d1.store.load(asModel(WORK_DISPATCH_MODEL), asId(second.intentId)), uncertainRow);
    reconcileMode = 'accepted';
    const confirmed = await recover();
    assert.deepEqual(confirmed.reconciled, [{ intentId: second.intentId, state: 'delivered' }]);
    assert.deepEqual(reconciledIds, [second.intentId, second.intentId]); assert.equal(sends.length, 2);
    assert.equal((await d1.store.outboxPending()).length, 0);
    const final = await d1.store.load(asModel(WORK_DISPATCH_MODEL), asId(second.intentId));
    assert.equal(final?.data['state'], 'delivered'); assert.equal(final?.data['attempts'], 1);

    // Bounded recovery must prefetch the same lexical-id page as Work's
    // planner, even when genuine creation time puts that page in reverse order.
    const candidates = [operationId(), operationId()].map(id => ({
      operationId: id, intentId: deriveOutboxId(id, 'std.EmailV1.send', 0),
    }));
    candidates.sort((left, right) => left.intentId < right.intentId ? 1 : -1);
    const older = candidates[0]!, newer = candidates[1]!;
    assert.ok(newer.intentId < older.intentId);
    let stagedNow = now + 1;
    const pairInvoker = buildInvoker(artifact, asm, d1.store, { memberships, now: () => stagedNow });
    for (const candidate of [older, newer]) {
      const current = await d1.store.load(MODEL, asId(row.id)); assert.ok(current !== null);
      committed(await pairInvoker.invokeMutation({ operation: `${APP}.deliver`, operation_id: candidate.operationId,
        inputs: { entry: { id: row.id, version: String(current.version) }, to: 'recipient@example.test', accept: true } }, identity));
      const staged: OutboxIntent | undefined = (await d1.store.outboxPending()).find(intent => intent.operationId === candidate.operationId);
      assert.ok(staged !== undefined); assert.equal(staged.intentId, candidate.intentId);
      stagedNow += 1_000;
    }
    const olderRow = await d1.store.load(asModel(WORK_DISPATCH_MODEL), asId(older.intentId));
    const newerRow = await d1.store.load(asModel(WORK_DISPATCH_MODEL), asId(newer.intentId));
    assert.ok(olderRow !== null && newerRow !== null); assert.ok(olderRow.created < newerRow.created);
    now = stagedNow; sendMode = 'malformed';
    for (const candidate of [older, newer]) {
      const ambiguous = await drive(candidate.intentId);
      assert.equal(ambiguous.status, 'recorded'); assert.ok('state' in ambiguous);
      assert.equal(ambiguous.state, 'uncertain'); assert.equal(ambiguous.attempts, 1);
    }
    const sentBeforeSweep = sends.length;
    assert.equal(sentBeforeSweep, 4);
    const firstPage = await recover(1);
    assert.deepEqual(firstPage.reconciled, [{ intentId: newer.intentId, state: 'delivered' }]);
    assert.equal(sends.length, sentBeforeSweep);
    assert.equal((await d1.store.load(asModel(WORK_DISPATCH_MODEL), asId(older.intentId)))?.data['state'], 'uncertain');
    assert.deepEqual((await d1.store.outboxPending()).map(intent => intent.intentId), [older.intentId]);
    const secondPage = await recover(1);
    assert.deepEqual(secondPage.reconciled, [{ intentId: older.intentId, state: 'delivered' }]);
    assert.deepEqual(reconciledIds.slice(-2), [newer.intentId, older.intentId]);
    assert.equal(sends.length, sentBeforeSweep); assert.equal((await d1.store.outboxPending()).length, 0);
    for (const candidate of [older, newer]) {
      const terminal = await d1.store.load(asModel(WORK_DISPATCH_MODEL), asId(candidate.intentId));
      assert.equal(terminal?.data['state'], 'delivered'); assert.equal(terminal?.data['attempts'], 1);
    }
  } finally {
    if (d1 !== undefined) await d1.worker.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
