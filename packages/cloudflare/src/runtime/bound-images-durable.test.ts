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
import { WORK_DISPATCH_MODEL, WORK_SCHEDULE_MODEL, readScheduleRow, readDispatchRow } from '@canlang/work/kernel/tables';
import { attemptDispatch } from '@canlang/work/dispatch';
import { classifyFailure } from '@canlang/work/receipt';
import { ComfyUINativeAdapter } from '@canlang/services/media/comfyui';
import { digestGraph } from '@canlang/services/media/mapping';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker, type MutationOutcome } from '@canlang/cloudflare/worker/assembly';
import { createCanonicalFileBinding } from './bound-files.js';
import { createBoundImagesAdapter } from './bound-images.js';
import { createBoundImagesDispatcher } from './bound-dispatch.js';
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

test('compiled Images requests finalize real provider bytes in receiving SQLite and retain native D1 progress on reopen', async () => {
  // Identity/session/membership and domain/Work/receipts share persistent
  // native D1; finalized metadata and bytes share real SQLite transactions.
  // The installed local HTTP protocol is controlled, not a remote Comfy deployment.
  const now = Date.now(); const clock = { nowMs: () => now };
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
  let mode: 'success' | 'invalid' | 'aggregate' = 'success';
  const prompts: string[] = [];
  let queuedBeforeSubmit = 0;
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
        assert.equal(job, prompts[prompts.length - 1]);
        const images = [{ filename: 'image.png', subfolder: '', type: 'output' },
          ...(mode === 'aggregate' ? [{ filename: 'second.png', subfolder: '', type: 'output' }] : [])];
        return json({ [job]: { status: { status_str: 'success', completed: true }, outputs: { '9': { images } } } });
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
    const created = committed(await invoker.invokeMutation(envelope('Job.create', {}), identity)).result as { id: string };
    let jobVersion = 1;
    const requests: MutationEnvelope[] = [];
    const enqueue = async () => {
      const request = envelope('generate', { job: { id: created.id, version: String(jobVersion) }, graph: { id: graphRef },
        validation: digestGraph(GRAPH), prompt: 'A native image', accept: true });
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
    const adapterFor = () => {
      const { prompt, negative, width, height } = mapping.inputs;
      assert.ok(prompt && negative && width && height);
      const installed = new ComfyUINativeAdapter({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 30_000,
        maxBodyBytes: 16_384, graph: GRAPH, mapping, clientId: 'owned-images', maxDownloadBytes: maxBytes, maxOutputs: 2 })
        .installImages({ binding, workflow: { graph: graphRef, prompt, negative, width, height }, seed: { kind: 'fixed', value: 42 } });
      return createBoundImagesAdapter({ appDefinition: definition, binding,
        resolveInstalledImages: deployment => deployment === binding.deployment ? installed : null,
        finalizeOutput: async ({ intent, output, resultPath }) => {
          // The receiver is the actual admitted principal/team, and authority is
          // checked again inside the live original dispatch fence before bytes.
          const current = await resolveIdentity(identities, { session_token: token, team_id: team.team_id }, { clock });
          assert.deepEqual(receiverFromIdentity(APP, current), receiver);
          assert.equal((await identities.findMembership(team.team_id, user.user_id))?.status, 'active');
          return bindings.finalizeProviderOutput({ receiver, binding: { adapter: binding.deployment, deliveryId: intent.intentId, resultPath },
            operation: intent.target, field: `/${resultPath}`, args: {}, name: `image-${output.position}.png`, claimedType: output.contentType, bytes: output.bytes });
        } });
    };
    let adapter = adapterFor();
    const dispatcherFor = () => createBoundImagesDispatcher({ store, adapter, progressed,
      workCommands: WORK_SYSTEM_COMMANDS, stageCommands: WORK_DISPATCH_STAGE_COMMANDS, createClaimCommand: createWorkDispatchClaimCommand });
    let dispatcher = await dispatcherFor();
    const drive = (intent: OutboxIntent) => {
      currentIntent = intent; currentContext = adapter.resultContext(intent); assert.ok(currentContext);
      return dispatcher.drive({ intentId: intent.intentId, actor: user.user_id, operation: 'test.images.drive', nowMs: () => now,
        nextClaimId: () => `images-claim-${++sequence}`, maxClaimAgeMs: 60_000, claimOperationId: nextId(), recordOperationId: nextId(),
        classifyFailure, evaluateGuard: () => true, readStateSnapshot: () => null,
        fence: { owner: team.team_id, attemptDispatch: attemptDispatch as FenceAttemptDispatchFn,
          revalidateAuthority: async () => (await identities.findMembership(team.team_id, user.user_id))?.status === 'active' } });
    };
    const first = await enqueue();
    assert.equal(adapter.available(first), true);
    assert.equal((await drive(first)).status, 'recorded'); assert.equal(prompts.length, 1); assert.equal(queuedBeforeSubmit, 1);
    const receiptRow = await store.load(asModel(RECEIPT_MODEL), asId(first.intentId)); assert.ok(receiptRow && currentContext);
    const receipt = readReceiptRow(receiptRow, currentContext).receipt;
    assert.equal(receipt.status, 'succeeded');
    const run = receipt.result as { source: string; revision: string; state: string; outputs: Array<{ image: { id: string } }> };
    assert.equal(run.source, requests[0]!.operation_id); assert.equal(run.revision, '1'); assert.equal(run.state, 'succeeded');
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
    await miniflare!.dispose(); miniflare = undefined; files!.close(); files = undefined;
    store = await open(); bindings = createSqliteFileBindings(files!, { clock, intentTtlMs: 60_000, urlBase: 'https://test.invalid' });
    identity = await resolveIdentity(identities, { session_token: token, team_id: team.team_id }, { clock });
    assert.deepEqual(receiverFromIdentity(APP, identity), receiver);
    assert.equal((await identities.findMembership(team.team_id, user.user_id))?.status, 'active');
    invoker = invokerFor(); adapter = adapterFor(); dispatcher = await dispatcherFor();
    assert.equal((await drive(first)).status, 'not-pending'); assert.equal(prompts.length, 1);
    assert.deepEqual(bindings.readBytes(image, receiver), PNG);
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(first.intentId)), receiptRow);

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
