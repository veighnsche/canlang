import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { ApiGraph, CompileArtifact, MutationEnvelope, OutboxIntent, ProviderBinding, WorkflowNodeMapping } from '@canlang/contracts';
import { resolveIdentity, createD1IdentityStore, ensureIdentitySchema } from '@canlang/identity';
import { receiverFromIdentity } from '@canlang/interfaces';
import { createFileJourneyKernel } from '@canlang/interfaces/uploads/kernel';
import { createSqliteFileStore, createSqliteFileBindings } from '@canlang/files/host/sqlite';
import { sha256Hex } from '@canlang/files/upload';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { asId, asModel, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { readReceiptRow, RECEIPT_MODEL } from '@canlang/state/receipt/tables';
import { WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { WORK_DISPATCH_MODEL, WORK_SCHEDULE_MODEL, readScheduleRow, readDispatchRow,
  readDispatchImageCorrelation, readDispatchImageControlPin } from '@canlang/work/kernel/tables';
import { attemptDispatch } from '@canlang/work/dispatch';
import { classifyFailure } from '@canlang/work/receipt';
import { planRecoveryScan } from '@canlang/work/recovery';
import { ComfyUINativeAdapter } from '@canlang/services/media/comfyui';
import { digestGraph } from '@canlang/services/media/mapping';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker, type MutationOutcome } from '@canlang/cloudflare/worker/assembly';
import { createCanonicalFileBinding } from './bound-files.js';
import { createBoundImagesAdapter } from './bound-images.js';
import { createBoundImagesDispatcher, lookupRetainedImagesDispatch } from './bound-dispatch.js';
import { createCheckedDeliveryProgressProducer, invokeDueScheduleCanonical, type FenceAttemptDispatchFn } from './invoke.js';

const APP = 'TypedImagesProgress';
const MODEL = asModel(`${APP}.Job`);
const fixturePath = resolve('packages/cloudflare/test/fixtures/typed-images-progress.json');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);
const GRAPH: ApiGraph = {
  '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal',
    denoise: 1, positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0], model: ['4', 0] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'owned-local.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'Owned', images: ['8', 0] } },
};
function committed(outcome: MutationOutcome) {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, 'committed'); return outcome.result;
}

test('compiled Images requests finalize real provider bytes in receiving SQLite and retain native D1 progress on reopen', async t => {
  // Identity/session/membership and domain/Work/receipts share persistent
  // native D1; finalized metadata and bytes share real SQLite transactions.
  // The installed local HTTP protocol is controlled, not a remote Comfy deployment.
  let now = Date.now(); const clock = { nowMs: () => now };
  let sequence = 0;
  const nextId = () => asOperationId(uuidv7(now, ++sequence));
  let identities!: ReturnType<typeof createD1IdentityStore>;
  let user: Awaited<ReturnType<ReturnType<typeof createD1IdentityStore>['createUser']>>;
  let team: Awaited<ReturnType<ReturnType<typeof createD1IdentityStore>['createTeam']>>;
  let member: Awaited<ReturnType<ReturnType<typeof createD1IdentityStore>['createMembership']>>;
  let identity: Awaited<ReturnType<typeof resolveIdentity>>;
  let receiver: ReturnType<typeof receiverFromIdentity>;
  const token = 'images-native-session';
  const dir = await mkdtemp(join(tmpdir(), 'can-images-durable-'));
  let miniflare: Miniflare | undefined;
  let files: ReturnType<typeof createSqliteFileStore> | undefined;
  const open = async () => {
    miniflare = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'images-durable' }, d1Persist: join(dir, 'd1') });
    const db = await miniflare.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(db); await ensureIdentitySchema(db);
    identities = createD1IdentityStore(db, { clock });
    files = createSqliteFileStore(join(dir, 'files.sqlite'));
    return createD1Storage(db);
  };
  let currentIntent: OutboxIntent | undefined;
  let currentContext: ReturnType<ReturnType<typeof createBoundImagesAdapter>['resultContext']> = null;
  let store: Awaited<ReturnType<typeof open>>;
  let mode: 'success' | 'unknown' | 'running' | 'invalid' | 'aggregate' = 'success';
  const prompts: string[] = [];
  let observations = 0;
  let queuedBeforeSubmit = 0;
  const cancellations: string[] = [];
  const provider = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, 'http://local');
      const json = (body: unknown) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
      if (request.method === 'POST' && url.pathname === '/prompt') {
        const chunks: Uint8Array[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.ok(currentIntent && currentContext);
        const row = await store.load(asModel(RECEIPT_MODEL), asId(currentIntent.intentId)); assert.ok(row);
        const receipt = readReceiptRow(row, currentContext).receipt;
        assert.equal((receipt.result as { state: string }).state, 'queued');
        assert.equal(receipt.status, 'pending'); queuedBeforeSubmit++;
        assert.equal(body.prompt['6'].inputs.text, 'A native image');
        assert.equal(body.prompt['5'].inputs.width, 512);
        assert.equal(body.prompt['3'].inputs.seed, 42);
        prompts.push(body.prompt_id); return json({ prompt_id: body.prompt_id, node_errors: {} });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/history/')) {
        const job = decodeURIComponent(url.pathname.slice('/history/'.length));
        assert.ok(prompts.includes(job));
        observations++;
        if (mode === 'unknown') return json({});
        if (mode === 'running') return json({ [job]: { status: { status_str: 'executing', completed: false }, outputs: {} } });
        const images = [{ filename: 'image.png', subfolder: '', type: 'output' },
          ...(mode === 'aggregate' ? [{ filename: 'second.png', subfolder: '', type: 'output' }] : [])];
        return json({ [job]: { status: { status_str: 'success', completed: true }, outputs: { '9': { images } } } });
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/jobs/') && url.pathname.endsWith('/cancel')) {
        const job = decodeURIComponent(url.pathname.slice('/api/jobs/'.length, -'/cancel'.length));
        assert.ok(prompts.includes(job)); cancellations.push(job);
        response.writeHead(404); return void response.end();
      }
      if (request.method === 'GET' && url.pathname === '/view') {
        response.writeHead(200, { 'content-type': 'image/png' });
        return void response.end(mode === 'invalid' ? new Uint8Array([0, 1, 2, 3]) : PNG);
      }
      response.writeHead(404); response.end();
    } catch { response.writeHead(500); response.end('Controlled native image protocol refused.'); }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert.ok(address && typeof address !== 'string');
  try {
    store = await open();
  user = await identities.createUser({ email: 'images@example.test', password_hash: 'unused', email_verified: true });
  team = await identities.createTeam({ timezone: 'UTC' });
  member = await identities.createMembership({ user_id: user.user_id, team_id: team.team_id, is_owner: false, roles: [] });
  await identities.createSession({ user_id: user.user_id, token_sha256: createHash('sha256').update(token).digest('hex'),
    expires_at: new Date(now + 3_600_000).toISOString(), last_team_id: team.team_id });
  identity = await resolveIdentity(identities, { session_token: token, team_id: team.team_id }, { clock });
  receiver = receiverFromIdentity(APP, identity);
    let bindings = createSqliteFileBindings(files!, { clock, intentTtlMs: 60_000, urlBase: 'https://test.invalid' });
    const graphBytes = new TextEncoder().encode(JSON.stringify(GRAPH));
    const uploadId = nextId();
    const uploaded = bindings.createIntent({ receiver, binding: { adapter: 'native-upload', deliveryId: uploadId, resultPath: 'graph' },
      request: { upload_id: uploadId, operation: `${APP}.generate`, field: '/graph', arguments: {},
        name: 'workflow.txt', type: 'text/plain', size: String(graphBytes.length) } });
    assert.ok(uploaded.status === 'granted' || uploaded.status === 'duplicate');
    assert.equal(bindings.append(uploaded.intentId, receiver, graphBytes).status, 'appended');
    assert.equal(bindings.complete(uploaded.intentId, receiver).status, 'completed');
    const finalized = bindings.finalize({ intentId: uploaded.intentId, retryId: uploadId, bytesDigest: sha256Hex(graphBytes), caller: receiver });
    assert.equal(finalized.status, 'finalized'); assert.ok('result' in finalized);
    const graphRef = finalized.result.file;
    const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    const definition = (await import(asm.entryUrl)).appDefinition as unknown;
    const progressed = await createCheckedDeliveryProgressProducer({ asm, artifact, app: APP });
    const invokerFor = () => buildInvoker(artifact, asm, store, { memberships: identities, now: () => now,
      files: createCanonicalFileBinding(createFileJourneyKernel(bindings)) });
    let invoker = invokerFor();
    const envelope = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({ operation: `${APP}.${operation}`, operation_id: nextId(), inputs });
    const created = committed(await invoker.invokeMutation(envelope('Job.create', {}), identity)).records![0] as { id: string };
    let jobVersion = 1;
    const requests: MutationEnvelope[] = [];
    const enqueue = async (revision = jobVersion) => {
      const request = envelope('generate', { job: { id: created.id, version: String(jobVersion) }, graph: { id: graphRef },
        validation: digestGraph(GRAPH), prompt: 'A native image', revision: String(revision), accept: true });
      committed(await invoker.invokeMutation(request, identity)); jobVersion++; requests.push(request);
      const intents = await store.outboxPending();
      const intent = intents.find(value => value.operationId === request.operation_id); assert.ok(intent); currentIntent = intent;
      return intent;
    };
    const binding: ProviderBinding = { capability: 'std.ImagesV1', capabilityVersion: 1, deployment: 'deployment.comfyui', account: 'owned-local' };
    const mapping: WorkflowNodeMapping = { workflow: graphRef, graphDigest: digestGraph(GRAPH),
      inputs: { prompt: { node: '6', key: 'text' }, negative: { node: '7', key: 'text' }, width: { node: '5', key: 'width' },
        height: { node: '5', key: 'height' }, seed: { node: '3', key: 'seed' } }, outputs: ['9'] };
    let maxBytes = 128;
    let maxObservationDurationMs = 20_000;
    let revokeAfterFinalize: string | null = null;
    const adapterFor = () => {
      const { prompt, negative, width, height } = mapping.inputs;
      assert.ok(prompt && negative && width && height);
      const installed = new ComfyUINativeAdapter({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 30_000,
        maxBodyBytes: 16_384, graph: GRAPH, mapping, clientId: 'owned-images', maxDownloadBytes: maxBytes, maxOutputs: 2 })
        .installImages({ binding, workflow: { graph: graphRef, prompt, negative, width, height }, seed: { kind: 'fixed', value: 42 }, maxObservationDurationMs });
      return createBoundImagesAdapter({ appDefinition: definition, binding,
        resolveInstalledImages: deployment => deployment === binding.deployment ? installed : null,
        finalizeOutput: async ({ intent, output, resultPath, originalScope }) => {
          // The receiver is the actual admitted principal/team, and authority is
          // checked again inside the live original dispatch fence before bytes.
          const current = await resolveIdentity(identities, { session_token: token, team_id: team.team_id }, { clock });
          assert.deepEqual(receiverFromIdentity(APP, current), receiver);
          if (originalScope !== undefined) assert.deepEqual(originalScope,
            { app: receiver.app, owner: receiver.owner, principal: receiver.principal });
          assert.equal((await identities.findMembership(team.team_id, user.user_id))?.status, 'active');
          const finalizedOutput = bindings.finalizeProviderOutput({ receiver, binding: { adapter: binding.deployment, deliveryId: intent.intentId, resultPath },
            operation: intent.target, field: `/${resultPath}`, args: {}, name: `image-${output.position}.png`, claimedType: output.contentType, bytes: output.bytes });
          if (revokeAfterFinalize === intent.intentId) {
            revokeAfterFinalize = null;
            await identities.removeMembership(member.membership_id);
          }
          return finalizedOutput;
        } });
    };
    let adapter = adapterFor();
    let terminalFaultIntent: OutboxIntent | null = null;
    let terminalResponseLost = false;
    let afterControlPin: (() => Promise<void>) | undefined;
    const dispatcherFor = () => createBoundImagesDispatcher({ store: { ...store,
      async commit(batch) {
        const result = await store.commit(batch);
        if (afterControlPin !== undefined && batch.writes.some(write => write.model === WORK_DISPATCH_MODEL &&
            write.kind !== 'remove' && write.row.data['originalIntentId'] !== undefined)) {
          const race = afterControlPin; afterControlPin = undefined; await race();
        }
        if (terminalFaultIntent !== null && batch.writes.some(write => write.model === RECEIPT_MODEL &&
            (write.kind === 'insert' ? write.row.id : write.id) === terminalFaultIntent!.intentId)) {
          const row = await store.load(asModel(RECEIPT_MODEL), asId(terminalFaultIntent.intentId)); assert.ok(row);
          const context = adapter.resultContext(terminalFaultIntent); assert.ok(context);
          if (readReceiptRow(row, context).receipt.status === 'succeeded') {
            terminalFaultIntent = null; terminalResponseLost = true;
            throw new Error('Native Images terminal progress commit response lost.');
          }
        }
        return result;
      },
    }, adapter, progressed,
      workCommands: WORK_SYSTEM_COMMANDS, stageCommands: WORK_DISPATCH_STAGE_COMMANDS, createClaimCommand: createWorkDispatchClaimCommand });
    let dispatcher = await dispatcherFor();
    const admission = () => ({ evaluateGuard: () => true, readStateSnapshot: () => null,
      fence: { owner: team.team_id, attemptDispatch: attemptDispatch as FenceAttemptDispatchFn,
        revalidateAuthority: async () => {
          const current = await resolveIdentity(identities, { session_token: token, team_id: team.team_id }, { clock });
          return current.actor?.user_id === user.user_id && current.team?.team_id === team.team_id &&
            (await identities.findMembership(team.team_id, user.user_id))?.status === 'active';
        } } });
    const recoveryOptions = () => ({ actor: user.user_id, operation: 'test.images.recover', nowMs: () => now,
      maxClaimAgeMs: 60_000, policy: { maxAttempts: 3, horizonMs: 3_600_000 }, limit: 10,
      operationIdForStep: () => nextId(), planRecoveryScan });
    const recover = () => dispatcher.recover({ ...recoveryOptions(), admission: admission() });
    const reopen = async () => {
      await miniflare!.dispose(); miniflare = undefined; files!.close(); files = undefined;
      store = await open(); bindings = createSqliteFileBindings(files!, { clock, intentTtlMs: 60_000, urlBase: 'https://test.invalid' });
      identity = await resolveIdentity(identities, { session_token: token, team_id: team.team_id }, { clock });
      assert.deepEqual(receiverFromIdentity(APP, identity), receiver);
      assert.equal((await identities.findMembership(team.team_id, user.user_id))?.status, 'active');
      invoker = invokerFor(); adapter = adapterFor(); dispatcher = await dispatcherFor();
    };
    const drive = (intent: OutboxIntent, actor = user.user_id) => {
      currentIntent = intent; currentContext = adapter.resultContext(intent); assert.ok(currentContext);
      return dispatcher.drive({ intentId: intent.intentId, actor, operation: 'test.images.drive', nowMs: () => now,
        nextClaimId: () => `images-claim-${++sequence}`, maxClaimAgeMs: 60_000, claimOperationId: nextId(), recordOperationId: nextId(),
        classifyFailure, evaluateGuard: () => true, readStateSnapshot: () => null,
        fence: { owner: team.team_id, attemptDispatch: attemptDispatch as FenceAttemptDispatchFn,
          revalidateAuthority: async () => (await identities.findMembership(team.team_id, user.user_id))?.status === 'active' } });
    };
    const first = await enqueue();
    const firstDispatch = await store.load(WORK_DISPATCH_MODEL, asId(first.intentId)); assert.ok(firstDispatch);
    const originalCorrelation = readDispatchImageCorrelation(firstDispatch.data); assert.ok(originalCorrelation);
    assert.deepEqual(originalCorrelation, { requestSource: created.id, requestRevision: '1',
      requestBinding: `${APP}.Images`, requestFrom: binding.deployment, requestApp: APP, requestOwner: team.team_id });
    assert.notEqual(originalCorrelation.requestSource, first.operationId);
    const lookup = await lookupRetainedImagesDispatch({ store, correlation: originalCorrelation });
    assert.equal(lookup.status, 'resolved'); assert.ok(lookup.status === 'resolved');
    assert.deepEqual(lookup.retained.intent, first); assert.equal(lookup.retained.status, 'pending');
    assert.equal(lookup.principal, user.user_id); assert.deepEqual(lookup.row, firstDispatch);
    assert.deepEqual(await lookupRetainedImagesDispatch({ store,
      correlation: { ...originalCorrelation, requestSource: first.operationId } }), { status: 'absent' });
    assert.equal(first.dispatchGuard ?? null, null);
    assert.equal(adapter.available(first), true);
    terminalFaultIntent = first;
    const lostDrive = await drive(first);
    assert.equal(lostDrive.status, 'recorded'); assert.ok('state' in lostDrive);
    assert.equal(lostDrive.state, 'uncertain'); assert.equal(terminalResponseLost, true);
    assert.equal(prompts.length, 1); assert.equal(queuedBeforeSubmit, 1);
    const retainedTerminal = await store.load(asModel(RECEIPT_MODEL), asId(first.intentId)); assert.ok(retainedTerminal);
    const retainedSchedules = await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' });
    const retainedHistory = await store.historyFor(MODEL, asId(created.id));
    await reopen();
    assert.deepEqual((await recover()).reconciled, [{ intentId: first.intentId, state: 'delivered' }]);
    const firstRecoveredDispatch = await store.load(WORK_DISPATCH_MODEL, asId(first.intentId)); assert.ok(firstRecoveredDispatch);
    assert.deepEqual(readDispatchImageCorrelation(firstRecoveredDispatch.data), originalCorrelation);
    assert.equal(prompts.length, 1);
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(first.intentId)), retainedTerminal);
    assert.deepEqual(await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' }), retainedSchedules);
    assert.deepEqual(await store.historyFor(MODEL, asId(created.id)), retainedHistory);
    assert.equal((await store.outboxPending()).length, 0);
    currentContext = adapter.resultContext(first);
    const receiptRow = await store.load(asModel(RECEIPT_MODEL), asId(first.intentId)); assert.ok(receiptRow && currentContext);
    const receipt = readReceiptRow(receiptRow, currentContext).receipt;
    assert.equal(receipt.status, 'succeeded');
    const run = receipt.result as { source: string; revision: string; state: string; outputs: Array<{ image: { id: string } }> };
    assert.equal(run.source, created.id); assert.equal(run.revision, '1'); assert.equal(run.state, 'succeeded');
    const image = run.outputs[0]!.image.id;
    assert.deepEqual(bindings.readBytes(image, receiver), PNG);
    assert.deepEqual(bindings.readProvenance(image, receiver)?.provenance, { kind: 'request', ...receiver,
      adapter: binding.deployment, deliveryId: first.intentId, resultPath: 'outputs/9/0' });
    assert.equal((await store.load(WORK_DISPATCH_MODEL, asId(first.intentId)))?.created, now);
    const dueEntries = await store.schedulesDue(now, 100);
    const occurrences = await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' });
    assert.equal(occurrences.length, 2);
    for (const row of occurrences) {
      const occurrence = readScheduleRow(row);
      assert.ok(dueEntries.some(entry => entry.key.endsWith(`/${occurrence.key}`)));
      const outcome = await invokeDueScheduleCanonical({ asm, artifact, app: APP,
        handler: `${APP}.progressed`, store, identities, now: () => now,
        due: { key: occurrence.key, scope: { app: APP, owner: team.team_id, ownerPackage: APP },
          occurrenceId: occurrence.occurrenceId, event: occurrence.event, at: occurrence.at } });
      assert.ok(typeof outcome === 'object' && outcome !== null && 'status' in outcome);
      assert.equal(outcome.status, 'completed');
    }
    const notices = await store.query({ model: asModel(`${APP}.ProgressNotice`), authority: 'owner' });
    assert.equal(notices.length, 2);
    assert.ok(notices.every(row => row.data['delivery'] === first.intentId));
    assert.equal(files!.files.listAll().length, 2);
    const revision = await store.readRevision();
    assert.equal((await drive(first)).status, 'not-pending'); assert.equal(prompts.length, 1);
    assert.equal(await store.readRevision(), revision);
    await reopen();
    assert.equal((await drive(first)).status, 'not-pending'); assert.equal(prompts.length, 1);
    const acknowledged = await lookupRetainedImagesDispatch({ store, correlation: originalCorrelation });
    assert.equal(acknowledged.status, 'resolved'); assert.ok(acknowledged.status === 'resolved');
    assert.deepEqual(acknowledged.retained.intent, first); assert.equal(acknowledged.retained.status, 'dispatched');
    assert.equal(acknowledged.row.created, firstDispatch.created); assert.equal(acknowledged.principal, user.user_id);
    assert.deepEqual(bindings.readBytes(image, receiver), PNG);
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(first.intentId)), receiptRow);

    // The same authored request survives an honest unknown provider outcome.
    // Recovery observes its original job, then atomically joins new progress,
    // the checked occurrence and schedule, Work's outcome, and acknowledgement.
    mode = 'unknown'; const pending = await enqueue();
    const pendingDrive = await drive(pending);
    assert.equal(pendingDrive.status, 'recorded'); assert.ok('state' in pendingDrive);
    assert.equal(pendingDrive.state, 'uncertain');
    const pendingContext = adapter.resultContext(pending); assert.ok(pendingContext);
    const unknownRow = await store.load(asModel(RECEIPT_MODEL), asId(pending.intentId)); assert.ok(unknownRow);
    const unknown = readReceiptRow(unknownRow, pendingContext).receipt;
    assert.equal(unknown.status, 'unknown');
    const unknownRun = unknown.result as { source: string; revision: string; sequence: string; state: string };
    assert.equal(unknownRun.state, 'unknown');
    const originalJob = await store.load(MODEL, asId(created.id));
    const originalHistory = await store.historyFor(MODEL, asId(created.id));
    const originalOccurrences = await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' });
    const submittedPending = prompts.length; const pendingFiles = files!.files.listAll().length;
    await reopen();
    const beforeRefusal = await store.readRevision(); const beforeObservation = observations;
    await assert.rejects(dispatcher.recover(recoveryOptions()), /actual current host owner admission/);
    await assert.rejects(dispatcher.recover({ ...recoveryOptions(), admission: {
      ...admission(), fence: { ...admission().fence, triggerRevision: { revision: beforeRefusal } },
    } }), /triggering checkpoint/);
    await identities.removeMembership(member.membership_id);
    await assert.rejects(recover());
    assert.equal(observations, beforeObservation); assert.equal(await store.readRevision(), beforeRefusal);
    assert.equal(files!.files.listAll().length, pendingFiles);
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(pending.intentId)), unknownRow);
    assert.deepEqual((await store.outboxPending()).find(intent => intent.intentId === pending.intentId), pending);
    await identities.reactivateMembership(member.membership_id, { is_owner: false, roles: [] });
    mode = 'running'; assert.equal((await recover()).reconciled.length, 0);
    assert.equal(prompts.length, submittedPending); assert.equal(files!.files.listAll().length, pendingFiles);
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(pending.intentId)), unknownRow);
    assert.deepEqual(await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' }), originalOccurrences);
    mode = 'success';
    revokeAfterFinalize = pending.intentId;
    await assert.rejects(recover());
    assert.equal(revokeAfterFinalize, null);
    assert.equal(prompts.length, submittedPending); assert.equal(files!.files.listAll().length, pendingFiles + 1);
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(pending.intentId)), unknownRow);
    assert.deepEqual(await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' }), originalOccurrences);
    assert.deepEqual((await store.outboxPending()).find(intent => intent.intentId === pending.intentId), pending);
    assert.equal((await store.load(WORK_DISPATCH_MODEL, asId(pending.intentId)))?.data['state'], 'uncertain');
    await identities.reactivateMembership(member.membership_id, { is_owner: false, roles: [] });
    assert.deepEqual((await recover()).reconciled, [{ intentId: pending.intentId, state: 'delivered' }]);
    assert.equal(prompts.length, submittedPending); assert.equal(files!.files.listAll().length, pendingFiles + 1);
    assert.equal((await store.outboxPending()).length, 0);
    assert.equal((await store.load(WORK_DISPATCH_MODEL, asId(pending.intentId)))?.data['state'], 'delivered');
    const pendingRecoveredDispatch = await store.load(WORK_DISPATCH_MODEL, asId(pending.intentId)); assert.ok(pendingRecoveredDispatch);
    assert.deepEqual(readDispatchImageCorrelation(pendingRecoveredDispatch.data), {
      ...originalCorrelation, requestSource: unknownRun.source, requestRevision: unknownRun.revision,
    });
    const recoveredRow = await store.load(asModel(RECEIPT_MODEL), asId(pending.intentId)); assert.ok(recoveredRow);
    const recovered = readReceiptRow(recoveredRow, pendingContext).receipt;
    assert.equal(recovered.status, 'succeeded');
    const recoveredRun = recovered.result as typeof unknownRun & { outputs: Array<{ image: { id: string } }> };
    assert.equal(recoveredRun.source, unknownRun.source); assert.equal(recoveredRun.revision, unknownRun.revision);
    assert.equal(recoveredRun.sequence, String(BigInt(unknownRun.sequence) + 1n)); assert.equal(recoveredRun.state, 'succeeded');
    const recoveredImage = recoveredRun.outputs[0]!.image.id;
    assert.deepEqual(bindings.readBytes(recoveredImage, receiver), PNG);
    assert.deepEqual(bindings.readProvenance(recoveredImage, receiver)?.provenance, { kind: 'request', ...receiver,
      adapter: binding.deployment, deliveryId: pending.intentId, resultPath: 'outputs/9/0' });
    assert.deepEqual(await store.load(MODEL, asId(created.id)), originalJob);
    assert.deepEqual(await store.historyFor(MODEL, asId(created.id)), originalHistory);
    const recoveredOccurrences = await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' });
    const added = recoveredOccurrences.filter(row => !originalOccurrences.some(original => original.id === row.id));
    assert.equal(added.length, 1);
    const terminalOccurrence = readScheduleRow(added[0]!);
    assert.ok((await store.schedulesDue(now, 100)).some(entry => entry.key.endsWith(`/${terminalOccurrence.key}`)));
    const invokeTerminal = async () => {
      const answer = await invokeDueScheduleCanonical({ asm, artifact, app: APP,
        handler: `${APP}.progressed`, store, identities, now: () => now,
        due: { key: terminalOccurrence.key, scope: { app: APP, owner: team.team_id, ownerPackage: APP },
          occurrenceId: terminalOccurrence.occurrenceId, event: terminalOccurrence.event, at: terminalOccurrence.at } });
      assert.ok(typeof answer === 'object' && answer !== null && 'status' in answer);
      return answer;
    };
    assert.equal((await invokeTerminal()).status, 'completed');
    const terminalNotices = await store.query({ model: asModel(`${APP}.ProgressNotice`), authority: 'owner' });
    assert.equal(terminalNotices.filter(row => row.data['delivery'] === pending.intentId).length, 1);
    const completedRevision = await store.readRevision();
    assert.equal((await invokeTerminal()).status, 'replayed');
    assert.equal(await store.readRevision(), completedRevision);
    const completedDispatch = await store.load(WORK_DISPATCH_MODEL, asId(pending.intentId));
    const completedOccurrences = await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' });
    await reopen();
    assert.equal((await recover()).reconciled.length, 0);
    assert.equal((await drive(pending)).status, 'not-pending');
    assert.equal(prompts.length, submittedPending); assert.equal(files!.files.listAll().length, pendingFiles + 1);
    assert.deepEqual(await store.load(WORK_DISPATCH_MODEL, asId(pending.intentId)), completedDispatch);
    assert.deepEqual(await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' }), completedOccurrences);
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(pending.intentId)), recoveredRow);
    assert.deepEqual(await store.query({ model: asModel(`${APP}.ProgressNotice`), authority: 'owner' }), terminalNotices);
    assert.deepEqual(await store.historyFor(MODEL, asId(created.id)), originalHistory);
    assert.deepEqual(bindings.readBytes(recoveredImage, receiver), PNG);

    const enqueueControl = async (operation: 'stop' | 'reconcile') => {
      const row = await store.load(MODEL, asId(created.id)); assert.ok(row);
      const request = envelope(operation, { job: { id: created.id, version: String(row.version) } });
      committed(await invoker.invokeMutation(request, identity)); jobVersion = Number(row.version) + 1;
      const intent = (await store.outboxPending()).find(value => value.operationId === request.operation_id); assert.ok(intent);
      assert.deepEqual(intent.arguments['arguments'], { source: created.id, revision: row.data['revision'] });
      const staged = await store.load(WORK_DISPATCH_MODEL, asId(intent.intentId)); assert.ok(staged);
      assert.deepEqual(readDispatchImageCorrelation(staged.data), { ...originalCorrelation, requestRevision: row.data['revision'] });
      return intent;
    };
    const checkedReceipt = async (intent: OutboxIntent) => {
      const row = await store.load(asModel(RECEIPT_MODEL), asId(intent.intentId)); assert.ok(row);
      const context = adapter.resultContext(intent); assert.ok(context);
      return readReceiptRow(row, context).receipt;
    };

    // A real compiled control stops the still-null pending original, in one
    // join with its control receipt. No provider claim or transport is invented.
    const beforePendingPrompts = prompts.length; const beforePendingCancels = cancellations.length;
    const notSubmitted = await enqueue(); const pendingStop = await enqueueControl('stop');
    assert.equal(adapter.available(pendingStop), true);
    const stopped = await drive(pendingStop); assert.equal(stopped.status, 'recorded');
    assert.ok('state' in stopped); assert.equal(stopped.state, 'delivered');
    assert.equal((await checkedReceipt(notSubmitted)).status, 'skipped');
    assert.equal((await checkedReceipt(notSubmitted)).result, null);
    assert.equal((await checkedReceipt(pendingStop)).status, 'succeeded');
    assert.equal((await checkedReceipt(pendingStop)).result && ((await checkedReceipt(pendingStop)).result as { state: string }).state, 'cancelled');
    assert.equal(prompts.length, beforePendingPrompts); assert.equal(cancellations.length, beforePendingCancels);
    const stoppedRow = await store.load(WORK_DISPATCH_MODEL, asId(notSubmitted.intentId)); assert.ok(stoppedRow);
    assert.equal(readDispatchRow(stoppedRow).guardVerdict, false);
    const pendingPinRow = await store.load(WORK_DISPATCH_MODEL, asId(pendingStop.intentId)); assert.ok(pendingPinRow);
    assert.equal(readDispatchImageControlPin(pendingPinRow.data)?.originalIntentId, notSubmitted.intentId);
    await reopen(); assert.equal((await drive(notSubmitted)).status, 'not-pending');
    assert.equal((await drive(pendingStop)).status, 'not-pending');
    assert.equal(prompts.length, beforePendingPrompts);

    // The original may hold a genuine claim but still have no queued receipt.
    // Cleanup revokes that claim; its later provider path cannot start a job.
    const claimedOriginal = await enqueue();
    await identities.removeMembership(member.membership_id);
    assert.equal((await drive(claimedOriginal)).status, 'refused-revoked');
    await identities.reactivateMembership(member.membership_id, { is_owner: false, roles: [] });
    assert.equal((await store.load(WORK_DISPATCH_MODEL, asId(claimedOriginal.intentId)))?.data['state'], 'claimed');
    const heldStop = await enqueueControl('stop'); await drive(heldStop);
    assert.equal((await checkedReceipt(claimedOriginal)).status, 'skipped');
    assert.equal((await store.load(WORK_DISPATCH_MODEL, asId(claimedOriginal.intentId)))?.data['claimId'], null);
    assert.equal(prompts.length, beforePendingPrompts);

    // Queue admission is not proof that cancellation prevented acceptance.
    // An unsupported targeted cancel reports the actual running observation.
    mode = 'unknown'; const acceptedOriginal = await enqueue(); await drive(acceptedOriginal);
    const acceptedPrompts = prompts.length; const acceptedFiles = files!.files.listAll().length;
    const acceptedStop = await enqueueControl('stop'); mode = 'running';
    await drive(acceptedStop);
    assert.equal(cancellations.length, beforePendingCancels + 1);
    const originalRunning = await checkedReceipt(acceptedOriginal);
    const controlRunning = await checkedReceipt(acceptedStop);
    assert.equal(originalRunning.status, 'pending'); assert.equal(controlRunning.status, 'pending');
    assert.equal((originalRunning.result as { state: string }).state, 'running');
    assert.equal((controlRunning.result as { charged_jobs: string | null }).charged_jobs, null);
    assert.match((controlRunning.result as { detail: string }).detail, /unsupported/);
    const controlRow = await store.load(WORK_DISPATCH_MODEL, asId(acceptedStop.intentId)); assert.ok(controlRow);
    const controlPin = readDispatchImageControlPin(controlRow.data); assert.ok(controlPin);
    assert.equal(controlPin.originalIntentId, acceptedOriginal.intentId);
    assert.equal(controlPin.observationStartedAtMs, controlRow.created);
    assert.equal(controlPin.observationDeadlineMs - controlPin.observationStartedAtMs, 20_000);
    maxObservationDurationMs = 30_000; await reopen();
    assert.deepEqual(readDispatchImageControlPin((await store.load(WORK_DISPATCH_MODEL, asId(acceptedStop.intentId)))!.data), controlPin);
    mode = 'success';
    const controlsRecovered = await recover();
    assert.ok(controlsRecovered.reconciled.some(item => item.intentId === acceptedStop.intentId));
    assert.equal(prompts.length, acceptedPrompts); assert.equal(cancellations.length, beforePendingCancels + 1);
    assert.equal(files!.files.listAll().length, acceptedFiles + 1);
    const observedOriginal = await checkedReceipt(acceptedOriginal);
    const observedControl = await checkedReceipt(acceptedStop);
    assert.equal(observedOriginal.status, 'succeeded'); assert.deepEqual(observedControl.result, observedOriginal.result);
    const controlImage = (observedOriginal.result as { outputs: Array<{ image: { id: string } }> }).outputs[0]!.image.id;
    const controlProvenance = bindings.readProvenance(controlImage, receiver)?.provenance;
    assert.ok(controlProvenance?.kind === 'request');
    assert.equal(controlProvenance.deliveryId, acceptedOriginal.intentId);
    const afterControlSchedules = await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' });
    await recover(); await reopen(); await recover();
    assert.deepEqual(await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' }), afterControlSchedules);
    assert.equal(prompts.length, acceptedPrompts); assert.equal(cancellations.length, beforePendingCancels + 1);
    assert.equal(files!.files.listAll().length, acceptedFiles + 1);

    // Reconciliation of an acknowledged current terminal original reuses its
    // exact retained evidence; it does not finalize or announce another image.
    const terminalReconcile = await enqueueControl('reconcile');
    const beforeTerminalObservation = observations; await drive(terminalReconcile);
    assert.equal(observations, beforeTerminalObservation);
    assert.deepEqual((await checkedReceipt(terminalReconcile)).result, observedOriginal.result);
    assert.deepEqual(await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' }), afterControlSchedules);
    assert.equal(files!.files.listAll().length, acceptedFiles + 1);

    // The original can cross its queued admission boundary after the control
    // pin commits. A fresh checked read selects targeted observation instead
    // of applying the earlier null-receipt pending-stop premise.
    const racingOriginal = await enqueue(); const racingControl = await enqueueControl('stop');
    const beforeRacePrompts = prompts.length; const beforeRaceCancels = cancellations.length;
    afterControlPin = async () => { mode = 'unknown'; await drive(racingOriginal); };
    await drive(racingControl);
    assert.equal(afterControlPin, undefined);
    assert.equal(prompts.length, beforeRacePrompts + 1); assert.equal(cancellations.length, beforeRaceCancels + 1);
    assert.equal((await checkedReceipt(racingOriginal)).status, 'unknown');
    assert.equal((await checkedReceipt(racingControl)).status, 'unknown');
    assert.equal((await checkedReceipt(racingControl)).result && ((await checkedReceipt(racingControl)).result as { charged_jobs: string | null }).charged_jobs, null);
    mode = 'success'; await recover(); await recover();
    assert.equal(prompts.length, beforeRacePrompts + 1); assert.equal(cancellations.length, beforeRaceCancels + 1);

    // A control issued after the original generation deadline can observe late
    // success under its own new finite window, preserving the accepted job.
    const liveNow = Date.now;
    now = liveNow(); t.mock.method(Date, 'now', () => now);
    mode = 'unknown'; const lateOriginal = await enqueue(); await drive(lateOriginal);
    const lateOriginalRow = await store.load(WORK_DISPATCH_MODEL, asId(lateOriginal.intentId)); assert.ok(lateOriginalRow);
    const beforeLateFiles = files!.files.listAll().length; const beforeLatePrompts = prompts.length;
    now += 31_000;
    const lateControl = await enqueueControl('reconcile'); mode = 'success'; await drive(lateControl);
    const latePin = readDispatchImageControlPin((await store.load(WORK_DISPATCH_MODEL, asId(lateControl.intentId)))!.data); assert.ok(latePin);
    assert.equal(latePin.observationStartedAtMs, now);
    assert.ok(latePin.observationStartedAtMs > lateOriginalRow.created + 30_000);
    assert.equal((await checkedReceipt(lateOriginal)).status, 'succeeded');
    assert.deepEqual((await checkedReceipt(lateControl)).result, (await checkedReceipt(lateOriginal)).result);
    assert.equal((await store.load(WORK_DISPATCH_MODEL, asId(lateOriginal.intentId)))?.created, lateOriginalRow.created);
    assert.equal(prompts.length, beforeLatePrompts); assert.equal(files!.files.listAll().length, beforeLateFiles + 1);
    await recover(); t.mock.restoreAll(); now = liveNow();

    // The installed compiled private progress handler has a null user actor
    // and an explicit owner read grant. Its real control still cleans up the
    // original member's attempt, without requiring actor==original principal.
    const rename = await store.load(MODEL, asId(created.id)); assert.ok(rename);
    committed(await invoker.invokeMutation(envelope('Job.update', { record: { id: created.id, version: String(rename.version) }, label: 'Cleanup' }), identity));
    jobVersion = Number(rename.version) + 1;
    mode = 'unknown'; const cleanupOriginal = await enqueue(); await drive(cleanupOriginal);
    // Schedule payload is retained on its original occurrence row.
    const cleanupRows = await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' });
    const occurrenceRow = cleanupRows.find(row =>
      (row.data['payload'] as { delivery_id?: string } | undefined)?.delivery_id === cleanupOriginal.intentId);
    assert.ok(occurrenceRow); const cleanupOccurrence = readScheduleRow(occurrenceRow);
    const cleanupInvoked = await invokeDueScheduleCanonical({ asm, artifact, app: APP,
      handler: `${APP}.progressed`, store, identities, now: () => now,
      due: { key: cleanupOccurrence.key, scope: { app: APP, owner: team.team_id, ownerPackage: APP },
        occurrenceId: cleanupOccurrence.occurrenceId, event: cleanupOccurrence.event, at: cleanupOccurrence.at } });
    assert.ok(typeof cleanupInvoked === 'object' && cleanupInvoked !== null && 'status' in cleanupInvoked);
    assert.equal(cleanupInvoked.status, 'completed');
    const cleanupDispatchRows = await store.query({ model: WORK_DISPATCH_MODEL, authority: 'owner' });
    const cleanupControlRow = cleanupDispatchRows.find(row => row.data['originOccurrence'] === cleanupOccurrence.occurrenceId && row.data['source'] === 'std.ImagesV1.cancel');
    assert.ok(cleanupControlRow); assert.notEqual(cleanupControlRow.createdBy, user.user_id);
    const cleanupRetained = await store.outboxGet(String(cleanupControlRow.id)); assert.ok(cleanupRetained);
    const beforeCleanupCancel = cancellations.length; const beforeCleanupPrompts = prompts.length;
    mode = 'success'; await drive(cleanupRetained.intent, cleanupControlRow.createdBy!);
    assert.equal(cancellations.length, beforeCleanupCancel + 1); assert.equal(prompts.length, beforeCleanupPrompts);
    assert.equal((await checkedReceipt(cleanupOriginal)).status, 'succeeded');
    assert.deepEqual((await checkedReceipt(cleanupRetained.intent)).result, (await checkedReceipt(cleanupOriginal)).result);
    const cleanupFile = ((await checkedReceipt(cleanupOriginal)).result as { outputs: Array<{ image: { id: string } }> }).outputs[0]!.image.id;
    const cleanupProvenance = bindings.readProvenance(cleanupFile, receiver)?.provenance;
    assert.ok(cleanupProvenance?.kind === 'request');
    assert.equal(cleanupProvenance.deliveryId, cleanupOriginal.intentId);
    await recover();
    const restoreLabel = await store.load(MODEL, asId(created.id)); assert.ok(restoreLabel);
    committed(await invoker.invokeMutation(envelope('Job.update', { record: { id: created.id, version: String(restoreLabel.version) }, label: 'Images' }), identity));
    jobVersion = Number(restoreLabel.version) + 1;

    // A retained window is never renewed after expiry, even if installation
    // policy grew on reopen. The original generation deadline remains intact.
    mode = 'unknown'; const expiredOriginal = await enqueue(); await drive(expiredOriginal);
    const expiredControl = await enqueueControl('reconcile'); await drive(expiredControl);
    const expiryPin = readDispatchImageControlPin((await store.load(WORK_DISPATCH_MODEL, asId(expiredControl.intentId)))!.data); assert.ok(expiryPin);
    const expiryReceipts = [await checkedReceipt(expiredOriginal), await checkedReceipt(expiredControl)];
    const beforeExpiredObservation = observations; const expiredPrompts = prompts.length;
    const actualNow = Date.now;
    t.mock.method(Date, 'now', () => expiryPin.observationDeadlineMs + 1);
    now = expiryPin.observationDeadlineMs + 1;
    await reopen(); mode = 'success'; await recover();
    assert.equal(observations, beforeExpiredObservation); assert.equal(prompts.length, expiredPrompts);
    assert.deepEqual([await checkedReceipt(expiredOriginal), await checkedReceipt(expiredControl)], expiryReceipts);
    assert.deepEqual(readDispatchImageControlPin((await store.load(WORK_DISPATCH_MODEL, asId(expiredControl.intentId)))!.data), expiryPin);
    t.mock.restoreAll(); now = actualNow();

    // A compiled control cannot follow an obsolete locator after a new attempt
    // takes over the business field, nor can revoked current authority run it.
    mode = 'unknown'; const obsoleteOriginal = await enqueue(); await drive(obsoleteOriginal);
    const staleControl = await enqueueControl('stop');
    const replacement = await enqueue();
    const beforeStaleCancel = cancellations.length; const beforeStaleObservation = observations;
    const staleReceipt = await checkedReceipt(obsoleteOriginal);
    await drive(staleControl);
    assert.equal(cancellations.length, beforeStaleCancel); assert.equal(observations, beforeStaleObservation);
    assert.deepEqual(await checkedReceipt(obsoleteOriginal), staleReceipt);
    assert.equal(readDispatchImageControlPin((await store.load(WORK_DISPATCH_MODEL, asId(staleControl.intentId)))!.data), null);
    const revokedControl = await enqueueControl('stop');
    await identities.removeMembership(member.membership_id);
    assert.equal((await drive(revokedControl)).status, 'refused-revoked');
    assert.equal(cancellations.length, beforeStaleCancel); assert.equal(observations, beforeStaleObservation);
    assert.equal((await checkedReceipt(replacement)).result, null);
    const heldCleanup = await store.load(WORK_DISPATCH_MODEL, asId(revokedControl.intentId)); assert.ok(heldCleanup);
    const heldCleanupData = readDispatchRow(heldCleanup);
    assert.equal(heldCleanupData.state, 'claimed'); assert.equal(heldCleanupData.attempts, 0);
    assert.ok(heldCleanupData.claimId); assert.equal(heldCleanupData.claimedAtMs, now);
    assert.equal(readDispatchImageControlPin(heldCleanup.data), null);
    await identities.reactivateMembership(member.membership_id, { is_owner: false, roles: [] });
    // Restored authority does not replace a current claim. The test clock has
    // not advanced through Work's 60-second stale-claim horizon.
    const stillHeldCleanup = await drive(revokedControl);
    assert.equal(stillHeldCleanup.status, 'not-claimed');
    assert.ok(stillHeldCleanup.status === 'not-claimed'); assert.equal(stillHeldCleanup.reason, 'claimed');
    assert.deepEqual(await store.load(WORK_DISPATCH_MODEL, asId(revokedControl.intentId)), heldCleanup);
    assert.equal((await checkedReceipt(replacement)).status, 'pending');
    assert.equal(cancellations.length, beforeStaleCancel); assert.equal(observations, beforeStaleObservation);
    // A new, genuinely admitted source control can stop the same null-receipt
    // original while leaving the refused control's held claim untouched.
    const restoredControl = await enqueueControl('stop');
    assert.notEqual(restoredControl.intentId, revokedControl.intentId);
    assert.deepEqual(restoredControl.arguments, revokedControl.arguments);
    const restoredCleanup = await drive(restoredControl);
    assert.equal(restoredCleanup.status, 'recorded'); assert.ok('state' in restoredCleanup);
    assert.equal(restoredCleanup.state, 'delivered');
    assert.equal((await checkedReceipt(replacement)).status, 'skipped');
    assert.deepEqual(await store.load(WORK_DISPATCH_MODEL, asId(revokedControl.intentId)), heldCleanup);
    assert.equal(cancellations.length, beforeStaleCancel); assert.equal(observations, beforeStaleObservation);

    // Two genuine generated submits may share a business key. Resolving the
    // first row would guess an attempt; the finite lookup must refuse both.
    const duplicateA = await enqueue(99); const duplicateB = await enqueue(99);
    assert.notEqual(duplicateA.intentId, duplicateB.intentId);
    const duplicateRow = await store.load(WORK_DISPATCH_MODEL, asId(duplicateA.intentId)); assert.ok(duplicateRow);
    const duplicateCorrelation = readDispatchImageCorrelation(duplicateRow.data); assert.ok(duplicateCorrelation);
    assert.deepEqual(await lookupRetainedImagesDispatch({ store, correlation: duplicateCorrelation }), { status: 'ambiguous' });
    assert.deepEqual(await lookupRetainedImagesDispatch({ store,
      correlation: { ...duplicateCorrelation, requestOwner: 'another-owner' } }), { status: 'absent' });
    const ambiguousControl = await enqueueControl('stop');
    const beforeAmbiguousTransport = [prompts.length, cancellations.length, observations];
    await drive(ambiguousControl);
    assert.deepEqual([prompts.length, cancellations.length, observations], beforeAmbiguousTransport);
    assert.equal(readDispatchImageControlPin((await store.load(WORK_DISPATCH_MODEL, asId(ambiguousControl.intentId)))!.data), null);
    const exactDuplicate = await lookupRetainedImagesDispatch({ store, correlation: duplicateCorrelation,
      originalIntentId: duplicateA.intentId });
    assert.equal(exactDuplicate.status, 'resolved');
    if (exactDuplicate.status === 'resolved') assert.deepEqual(exactDuplicate.retained.intent, duplicateA);
    assert.deepEqual(await lookupRetainedImagesDispatch({ store, correlation: originalCorrelation,
      originalIntentId: duplicateA.intentId }), { status: 'invalid' });

    mode = 'invalid'; const invalid = await enqueue(); const beforeInvalid = files!.files.listAll().length;
    await drive(invalid); assert.equal(files!.files.listAll().length, beforeInvalid);
    mode = 'aggregate'; maxBytes = 15; adapter = adapterFor(); dispatcher = await dispatcherFor();
    const aggregate = await enqueue(); const beforeAggregate = files!.files.listAll().length;
    await drive(aggregate); assert.equal(files!.files.listAll().length, beforeAggregate);
    mode = 'success'; maxBytes = 128; adapter = adapterFor(); dispatcher = await dispatcherFor();
    const revoked = await enqueue(); const beforeRevoked = files!.files.listAll().length; const submitted = prompts.length;
    const beforeDeniedRow = await store.load(WORK_DISPATCH_MODEL, asId(revoked.intentId));
    assert.ok(beforeDeniedRow);
    const beforeDeniedJob = await store.load(MODEL, asId(created.id));
    const beforeDeniedReceipt = await store.load(asModel(RECEIPT_MODEL), asId(revoked.intentId));
    await identities.removeMembership(member.membership_id);
    assert.equal((await drive(revoked)).status, 'refused-revoked');
    assert.equal(prompts.length, submitted); assert.equal(files!.files.listAll().length, beforeRevoked);
    // The existing coordination claim commits before the live authority gate.
    // No provider attempt, receipt record or outbox acknowledgement follows it.
    const heldRow = await store.load(WORK_DISPATCH_MODEL, asId(revoked.intentId)); assert.ok(heldRow);
    const held = readDispatchRow(heldRow);
    const original = readDispatchRow(beforeDeniedRow);
    assert.equal(held.state, 'claimed'); assert.equal(held.attempts, 0);
    assert.ok(held.claimId); assert.equal(held.claimedAtMs, now);
    assert.equal(held.source, original.source); assert.equal(held.operationId, original.operationId);
    assert.equal(held.intentId, original.intentId); assert.equal(held.occurrenceIndex, original.occurrenceIndex);
    assert.deepEqual((await store.outboxPending()).find(intent => intent.intentId === revoked.intentId), revoked);
    assert.deepEqual(await store.load(MODEL, asId(created.id)), beforeDeniedJob);
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(revoked.intentId)), beforeDeniedReceipt);
  } finally {
    files?.close(); await miniflare?.dispose();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
