import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationEnvelope, OutboxIntent, ProviderBinding } from '@canlang/contracts';
import { createMemoryIdentityStore } from '@canlang/identity/testing';
import { buildSessionCookie, resolveIdentity } from '@canlang/identity';
import { handlePageRequest } from '@canlang/interfaces';
import type { PageHttpDeps } from '@canlang/interfaces';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { associationRowId, readAssociationRow, readReceiptRow, RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL } from '@canlang/state/receipt/tables';
import { FIXED_NOW, asId, asModel, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { decodeValue } from '@canlang/values';
import { observeSelectedReceipt } from '@canlang/work/observation/observation';
import { WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { attemptDispatch } from '@canlang/work/dispatch';
import { classifyFailure } from '@canlang/work/receipt';
import { planRecoveryScan } from '@canlang/work/recovery';
import { WORK_DISPATCH_MODEL, WORK_SCHEDULE_MODEL, readDispatchImageControlPin, readScheduleRow } from '@canlang/work/kernel/tables';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { assembleWorker, buildInvoker, type MutationOutcome } from '@canlang/cloudflare/worker/assembly';
import { OllamaChatAdapter } from '@canlang/services/models/ollama';
import { createBoundTextGenerationAdapter } from './bound-text-generation.js';
import { createBoundTextGenerationDispatcher } from './bound-dispatch.js';
import type { FenceAttemptDispatchFn } from './invoke.js';
import { createCheckedDeliveryProgressProducer, invokeDueScheduleCanonical } from './invoke.js';
import { stageTextGenerationProgress } from './text-generation-progress.js';

// This owned local model has exactly 256 byte token IDs. Its chat template is
// explicit, including role markers; this is not an estimate for any Ollama model.
const LOCAL_MODEL = 'local-byte-template-v1';
function localChatTokens(messages: readonly { role: string; content: string }[]): Uint8Array {
  return new TextEncoder().encode(messages.map(message => `<|${message.role}|>\n${message.content}\n`).join(''));
}

async function localModelServer() {
  const requests: { model: string; messages: { role: string; content: string }[] }[] = [];
  const requestWaiters: (() => void)[] = [];
  let mode: 'complete' | 'incomplete' | 'malformed' | 'interrupted' | 'held' = 'complete';
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/chat');
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, LOCAL_MODEL);
      assert.equal(body.stream, true);
      assert.equal(body.options.num_predict, 128);
      assert.ok(Array.isArray(body.messages));
      requests.push({ model: body.model, messages: body.messages });
      for (const resolve of requestWaiters.splice(0)) resolve();
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const line = (content: string, done: boolean, extra = {}) => JSON.stringify({
        model: LOCAL_MODEL, message: { role: 'assistant', content, thinking: 'PRIVATE_LOCAL_THINKING' },
        done, ...extra,
      }) + '\n';
      // Split within the NDJSON record to exercise the actual incremental parser.
      const first = line('Local ', false);
      response.write(first.slice(0, 19));
      response.write(first.slice(19));
      if (mode === 'held') { response.flushHeaders(); return; }
      if (mode === 'interrupted') {
        response.flushHeaders();
        // A socket loss is uncertainty, unlike a clean incomplete NDJSON body.
        setImmediate(() => response.destroy());
        return;
      }
      if (mode === 'malformed') return void response.end('{broken-json}\n');
      if (mode === 'incomplete') return void response.end();
      response.write(line('answer.', false));
      response.end(line('', true, { done_reason: 'stop',
        prompt_eval_count: localChatTokens(body.messages).length,
        eval_count: new TextEncoder().encode('Local answer.').length }));
    } catch {
      response.writeHead(500); response.end('local model protocol refused');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { requests, baseUrl: `http://127.0.0.1:${address.port}`,
    nextRequest: () => new Promise<void>(resolve => requestWaiters.push(resolve)),
    setMode: (next: typeof mode) => { mode = next; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

const APP = 'TypedGenerationProgress';
const MODEL = asModel(`${APP}.Job`);
const fixturePath = resolve('packages/cloudflare/test/fixtures/typed-generation-progress.json');
function committed(outcome: MutationOutcome) {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, 'committed');
  return outcome.result;
}

test('compiled generation streams controlled provider bytes into granted native D1 progress and survives replay and reopen', async () => {
  // Identity is explicitly memory-backed; the canonical effects use native D1.
  // Controlled localhost protocol/tokenizer; deployed model and all-host qualification remain separate.
  const identities = createMemoryIdentityStore({ clock: { nowMs: () => FIXED_NOW } });
  const user = await identities.createUser({ email: 'generation@example.test', password_hash: 'unused', email_verified: true });
  const team = await identities.createTeam({ timezone: 'UTC' });
  const membership = await identities.createMembership({ user_id: user.user_id, team_id: team.team_id, is_owner: false, roles: [] });
  const token = 'generation-prefix-session';
  await identities.createSession({ user_id: user.user_id, token_sha256: createHash('sha256').update(token).digest('hex'),
    expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(), last_team_id: team.team_id });
  const identity = await resolveIdentity(identities, { session_token: token, team_id: team.team_id },
    { clock: { nowMs: () => FIXED_NOW } });
  const outsider = await identities.createUser({ email: 'generation-outsider@example.test', password_hash: 'unused', email_verified: true });
  const outsiderToken = 'generation-outsider-session';
  await identities.createSession({ user_id: outsider.user_id, token_sha256: createHash('sha256').update(outsiderToken).digest('hex'),
    expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(), last_team_id: team.team_id });
  const outsiderIdentity = await resolveIdentity(identities, { session_token: outsiderToken, team_id: team.team_id },
    { clock: { nowMs: () => FIXED_NOW } });
  const provider = await localModelServer();
  const dir = await mkdtemp(join(tmpdir(), 'can-generation-prefix-'));
  const openWorker = () => new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'typed-generation-progress' }, d1Persist: join(dir, 'd1') });
  let worker = openWorker();
  try {
    const database = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(database);
    let store = createD1Storage(database);
    const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    const progressed = await createCheckedDeliveryProgressProducer({ asm, artifact, app: APP });
    let dispatchNow = FIXED_NOW;
    const invokerFor = () => buildInvoker(artifact, asm, store, { memberships: identities, now: () => dispatchNow,
      selectedReceiptObserver: { observeSelectedReceipt: (input: unknown) =>
        observeSelectedReceipt(input as Parameters<typeof observeSelectedReceipt>[0]) } });
    let invoker = invokerFor();
    const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600, secure: false }).split(';')[0]!;
    const outsiderCookie = buildSessionCookie(outsiderToken, { maxAgeSeconds: 3600, secure: false }).split(';')[0]!;
    let pageHost: Awaited<ReturnType<typeof assembleWorker>> | undefined;
    let pageStore: typeof store | undefined;
    const pageResponse = async (sessionCookie = cookie) => {
      if (pageHost === undefined || pageStore !== store) {
        pageHost = await assembleWorker(artifact, asm, { store, identityStore: identities, now: () => FIXED_NOW,
          selectedReceiptObserver: { observeSelectedReceipt: (input: unknown) =>
            observeSelectedReceipt(input as Parameters<typeof observeSelectedReceipt>[0]) },
          http: { createPageHandler: deps => request => handlePageRequest(deps as unknown as PageHttpDeps, request) },
        }, { active: true });
        pageStore = store;
      }
      return pageHost.fetch(new Request('https://test.invalid/', { headers: { cookie: sessionCookie, 'hx-request': 'true' } }));
    };
    const pageHtml = async () => {
      const response = await pageResponse();
      assert.equal(response.status, 200, await response.clone().text());
      const html = await response.text();
      assert.equal(html.includes('PRIVATE_LOCAL_THINKING'), false);
      return html;
    };
    let sequence = 0;
    const envelope = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
      operation: `${APP}.${operation}`, operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)), inputs,
    });
    const created = committed(await invoker.invokeMutation(envelope('Job.create', {}), identity)).records![0] as { id: string; version: number };
    const visible = (version: number, caller = identity) => invoker.invokeMutation(envelope('visible', {
      job: { id: created.id, version: String(version) },
    }), caller);
    const readReceipt = (selected: string[], caller = identity) => invoker.invokeRead({ operation: 'Receipt.read',
      inputs: { recordId: created.id, field: 'request', selected } }, caller);
    const readBody = (response: Awaited<ReturnType<typeof readReceipt>>) => {
      assert.ok('result' in response, JSON.stringify(response));
      assert.ok(typeof response.result === 'object' && response.result !== null && !Array.isArray(response.result));
      return response.result as Record<string, unknown>;
    };
    assert.equal(committed(await visible(1)).result, null);
    assert.ok((await pageHtml()).includes('Awaiting generation'));
    const unassociated = await readReceipt(['result.content']);
    assert.equal(readBody(unassociated)['outcome'], 'null-association');
    const unstartedOwner = await store.load(MODEL, asId(created.id));
    const unstartedHistory = await store.historyFor(MODEL, asId(created.id));
    for (const operation of ['cancel', 'reconcile']) {
      assert.ok('error' in await invoker.invokeMutation(envelope(operation, {
        job: { id: created.id, version: String(created.version) },
      }), identity));
      assert.deepEqual(await store.load(MODEL, asId(created.id)), unstartedOwner);
      assert.deepEqual(await store.historyFor(MODEL, asId(created.id)), unstartedHistory);
      assert.equal((await store.outboxPending()).length, 0);
    }
    const original = envelope('generate', { job: { id: created.id, version: String(created.version) },
      prompt: 'Actual compiled request', accept: true });
    committed(await invoker.invokeMutation(original, identity));
    const pending = await store.outboxPending();
    assert.equal(pending.length, 1);
    const intent = pending[0]!;
    assert.equal(intent.operation, original.operation);
    assert.equal(intent.operationId, original.operation_id);
    assert.equal(intent.target, 'std.TextGenerationV1.generate');
    assert.deepEqual(intent.arguments, { binding: `${APP}.LLM`, from: 'deployment.llm', arguments: { value: {
      source: original.operation_id, revision: String(created.version), profile: 'local-chat', policy_revision: 'policy-1',
      messages: [{ role: 'user', content: 'Actual compiled request', attachments: [] }],
      max_input_tokens: '1024', max_output_tokens: '128', max_duration: '30000',
    } } });
    const args = intent.arguments['arguments'] as Record<string, unknown>;
    const value = args['value'] as Record<string, unknown>;
    assert.equal(decodeValue('text', value['source']), original.operation_id);
    assert.equal(decodeValue('int', value['revision']), BigInt(created.version));
    assert.equal(decodeValue('int', value['max_output_tokens']), 128n);
    assert.equal(decodeValue('duration', value['max_duration']), 30_000n);
    const job = await store.load(MODEL, asId(created.id));
    assert.equal(job?.version, 2);
    assert.deepEqual(job?.data['request'], { id: intent.intentId, operation: intent.target });
    assert.equal(job?.data['request_source'], original.operation_id);
    assert.equal(job?.data['request_revision'], String(created.version));
    const associationRow = await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),
      asId(associationRowId(MODEL, created.id, 'request')));
    assert.ok(associationRow);
    const association = readAssociationRow(associationRow);
    assert.equal(association.deliveryId, intent.intentId);
    assert.equal(association.source, intent.target);
    const receiptRow = await store.load(asModel(RECEIPT_MODEL), asId(intent.intentId));
    assert.ok(receiptRow);
    assert.deepEqual(readReceiptRow(receiptRow).receipt, { deliveryId: intent.intentId, revision: association.revision,
      status: 'pending', result: null, error: null });
    assert.equal(committed(await visible(2)).result, null);
    const observed = await readReceipt(['result.content']);
    assert.equal(readBody(observed)['outcome'], 'observed');
    assert.deepEqual(readBody(observed)['projection'], { 'result.content': null });
    for (const selected of ['result', 'status', 'id']) {
      const denied = await readReceipt([selected]);
      assert.equal(readBody(denied)['outcome'], 'denied');
    }
    const outsiderRead = await readReceipt(['result.content'], outsiderIdentity);
    assert.ok('error' in outsiderRead || readBody(outsiderRead)['outcome'] === 'denied', JSON.stringify(outsiderRead));
    assert.ok('error' in await visible(2, outsiderIdentity));

    const binding: ProviderBinding = { deployment: 'deployment.llm', capability: 'std.TextGenerationV1',
      capabilityVersion: 1, account: 'owned-local-byte-model' };
    const model = new OllamaChatAdapter({ baseUrl: provider.baseUrl, timeoutMs: 30_000,
      maxBodyBytes: 16_384, models: [LOCAL_MODEL], maxOutputTokens: 128, clock: { now: () => FIXED_NOW } });
    const installation = { binding, profile: 'local-chat', policyRevision: 'policy-1', model: LOCAL_MODEL,
      maxInputTokens: 1024 };
    const definition = (await import(asm.entryUrl)).appDefinition as unknown;
    const unsupported = model.installTextGeneration(installation);
    const unsupportedAdapter = createBoundTextGenerationAdapter({ appDefinition: definition, binding,
      resolveInstalledTextGeneration: deployment => {
        assert.equal(deployment, binding.deployment); return unsupported;
      } });
    assert.equal(unsupportedAdapter.available(intent), false);
    assert.equal(provider.requests.length, 0);
    const installed = model.installTextGeneration({ ...installation,
      countInputTokens: request => localChatTokens(request.messages).length });
    const nativeCompletions = new Map<string, { readonly status: string; readonly result: unknown }>();
    const nativeCompletionWaiters = new Map<string, () => void>();
    // Passive observation of the actual Ollama handle. done() returns its
    // shared settled promise; forwarding returns that exact handle untouched.
    const observeInstalled = (actual: typeof installed): typeof installed => ({ ...actual, text: { ...actual.text,
      generateStream(input, options) {
        const handle = actual.text.generateStream(input, options), done = handle.done();
        assert.equal(handle.done(), done);
        void done.then(completion => {
          nativeCompletions.set(options.deliveryId, completion);
          nativeCompletionWaiters.get(options.deliveryId)?.();
        });
        return handle;
      },
    } });
    let adapter = createBoundTextGenerationAdapter({ appDefinition: definition, binding,
      resolveInstalledTextGeneration: deployment => {
        assert.equal(deployment, binding.deployment); return observeInstalled(installed);
      } });
    assert.equal(adapter.available(intent), true);
    const resultContext = adapter.resultContext(intent); assert.ok(resultContext);
    const freshAdapter = () => {
      const freshModel = new OllamaChatAdapter({ baseUrl: provider.baseUrl, timeoutMs: 30_000,
        maxBodyBytes: 16_384, models: [LOCAL_MODEL], maxOutputTokens: 128, clock: { now: () => FIXED_NOW } });
      const freshInstallation = freshModel.installTextGeneration({ ...installation,
        countInputTokens: request => localChatTokens(request.messages).length });
      return createBoundTextGenerationAdapter({ appDefinition: definition, binding,
        resolveInstalledTextGeneration: deployment => {
          assert.equal(deployment, binding.deployment); return observeInstalled(freshInstallation);
        } });
    };

    // Passive observation after actual native commits. The defining dispatcher
    // alone stages progress; this wrapper neither creates nor modifies it.
    const snapshots: Record<string, unknown>[] = [];
    let checkedRunningOrder = false;
    const stageOriginalProgress = (revision: number, progress: Record<string, unknown>) =>
      stageTextGenerationProgress({ intent, context: resultContext, revision,
        progress: progress as unknown as import('./bound-text-generation.js').TextRunWire,
        progressed: { producer: progressed, owner: team.team_id } },
      { actor: user.user_id, now: FIXED_NOW, operation: 'test.generation.progress-admission',
        load: store.load.bind(store), query: store.query.bind(store) });
    const refusedProgress = (revision: number, progress: Record<string, unknown>) =>
      assert.rejects(stageOriginalProgress(revision, progress), error =>
        error instanceof Error && 'code' in error && error.code === 'validation');
    let terminalFaultIntent: OutboxIntent | null = null;
    let terminalResponseLost = false;
    let recordFaultIntent: OutboxIntent | null = null;
    let recordCommitsInterrupted = 0;
    let heldProgressIntent: OutboxIntent | null = null;
    let heldProgressResolve: (() => void) | null = null;
    let stalledProgressIntent: OutboxIntent | null = null;
    let stalledProgressResolve: (() => void) | null = null;
    let releaseStalledProgress: Promise<void> | null = null;
    const dispatcherFor = () => createBoundTextGenerationDispatcher({ store: { ...store,
      async commit(set) {
        const recordFault = recordFaultIntent;
        if (recordFault !== null && set.writes.some(write => write.model === WORK_DISPATCH_MODEL &&
            (write.kind === 'insert' || write.kind === 'update') && write.row.id === recordFault.intentId &&
            (write.row.data['state'] === 'delivered' || write.row.data['state'] === 'uncertain'))) {
          const actualReceipt = await store.load(asModel(RECEIPT_MODEL), asId(recordFault.intentId)); assert.ok(actualReceipt);
          const context = adapter.resultContext(recordFault); assert.ok(context);
          const retained = readReceiptRow(actualReceipt, context).receipt;
          assert.ok(retained.status === 'succeeded' || retained.status === 'unknown');
          assert.equal((await store.load(WORK_DISPATCH_MODEL, asId(recordFault.intentId)))?.data['state'], 'claimed');
          recordFaultIntent = null; ++recordCommitsInterrupted;
          // Simulate process death before recording Work's actual outcome.
          // Receipt snapshots already committed; this batch is never written.
          throw new Error('Process stopped before native dispatch record commit.');
        }
        const committedSet = await store.commit(set);
        if (stalledProgressIntent !== null && set.writes.some(write => write.model === RECEIPT_MODEL &&
            (write.kind === 'insert' ? write.row.id : write.id) === stalledProgressIntent!.intentId)) {
          const actual = await store.load(asModel(RECEIPT_MODEL), asId(stalledProgressIntent.intentId)); assert.ok(actual);
          const context = adapter.resultContext(stalledProgressIntent); assert.ok(context);
          const run = readReceiptRow(actual, context).receipt.result as Record<string, unknown> | null;
          if (run?.['state'] === 'running' && run['content'] === 'Local ') {
            stalledProgressIntent = null;
            stalledProgressResolve?.();
            await releaseStalledProgress;
          }
        }
        if (heldProgressIntent !== null && set.writes.some(write => write.model === RECEIPT_MODEL &&
            (write.kind === 'insert' ? write.row.id : write.id) === heldProgressIntent!.intentId)) {
          const actual = await store.load(asModel(RECEIPT_MODEL), asId(heldProgressIntent.intentId)); assert.ok(actual);
          const context = adapter.resultContext(heldProgressIntent); assert.ok(context);
          const run = readReceiptRow(actual, context).receipt.result as Record<string, unknown> | null;
          if (run?.['state'] === 'running' && run['content'] === 'Local ') heldProgressResolve?.();
        }
        if (terminalFaultIntent !== null && set.writes.some(write => write.model === RECEIPT_MODEL &&
            (write.kind === 'insert' ? write.row.id : write.id) === terminalFaultIntent!.intentId)) {
          const actual = await store.load(asModel(RECEIPT_MODEL), asId(terminalFaultIntent.intentId)); assert.ok(actual);
          const context = adapter.resultContext(terminalFaultIntent); assert.ok(context);
          const retained = readReceiptRow(actual, context).receipt;
          if (retained.status === 'succeeded' && (retained.result as Record<string, unknown>)?.['state'] === 'succeeded') {
            terminalFaultIntent = null; terminalResponseLost = true;
            throw new Error('Native terminal progress commit response lost.');
          }
        }
        if (set.writes.some(write => write.model === RECEIPT_MODEL &&
            (write.kind === 'insert' ? write.row.id : write.id) === intent.intentId)) {
          const actual = await store.load(asModel(RECEIPT_MODEL), asId(intent.intentId)); assert.ok(actual);
          const retained = readReceiptRow(actual, resultContext).receipt;
          if (retained.result !== null) {
            const run = retained.result as Record<string, unknown>;
            snapshots.push(run);
            assert.deepEqual(readBody(await readReceipt(['result.content']))['projection'], { 'result.content': run['content'] });
            const html = await pageHtml();
            assert.equal(html.includes('Awaiting generation'), false);
            const caption = { queued: 'Queued', running: 'Running', succeeded: 'Succeeded' }[String(run['state']) as 'queued' | 'running' | 'succeeded'];
            assert.ok(caption && html.includes(caption), html);
            assert.ok(html.includes(String(run['content'])), html);
            if (!checkedRunningOrder && run['state'] === 'running') {
              checkedRunningOrder = true;
              const progressRevision = await store.readRevision();
              const occurrences = await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' });
              assert.deepEqual(await stageOriginalProgress(retained.revision, run),
                { writes: [], result: { notification: null } });
              await refusedProgress(retained.revision, { ...run, content: 'Conflicting duplicate' });
              await refusedProgress(retained.revision - 1, run);
              await refusedProgress(retained.revision + 1, { ...run, sequence: String(BigInt(String(run['sequence'])) - 1n) });
              await refusedProgress(retained.revision + 1, { ...run, sequence: String(BigInt(String(run['sequence'])) + 1n),
                source: 'another-request' });
              await refusedProgress(retained.revision + 1, { ...run, sequence: String(BigInt(String(run['sequence'])) + 1n),
                revision: String(BigInt(String(run['revision'])) + 1n) });
              assert.equal(await store.readRevision(), progressRevision);
              assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(intent.intentId)), actual);
              assert.deepEqual(await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' }), occurrences);
            }
          }
        }
        return committedSet;
      },
    }, adapter, progressed, workCommands: WORK_SYSTEM_COMMANDS, stageCommands: WORK_DISPATCH_STAGE_COMMANDS,
      createClaimCommand: createWorkDispatchClaimCommand });
    let dispatcher = await dispatcherFor();
    const drive = (intentId: string) => dispatcher.drive({ intentId, actor: user.user_id,
      operation: 'test.generation.drive', nowMs: () => dispatchNow, nextClaimId: () => `claim-${++sequence}`,
      maxClaimAgeMs: 60_000, claimOperationId: asOperationId(uuidv7(FIXED_NOW, ++sequence)),
      recordOperationId: asOperationId(uuidv7(FIXED_NOW, ++sequence)),
      classifyFailure, evaluateGuard: () => true, readStateSnapshot: () => null,
      fence: { owner: team.team_id, attemptDispatch: attemptDispatch as FenceAttemptDispatchFn,
        revalidateAuthority: async () => (await identities.findMembership(team.team_id, user.user_id))?.status === 'active' },
    });
    const recover = () => dispatcher.recover({ actor: user.user_id, operation: 'test.generation.recover',
      nowMs: () => dispatchNow, maxClaimAgeMs: 60_000, policy: { maxAttempts: 3, horizonMs: 3_600_000 },
      limit: 10, operationIdForStep: () => asOperationId(uuidv7(FIXED_NOW, ++sequence)), planRecoveryScan,
      admission: { evaluateGuard: () => true, readStateSnapshot: () => null,
        fence: { owner: team.team_id, attemptDispatch: attemptDispatch as FenceAttemptDispatchFn,
          revalidateAuthority: async () => (await identities.findMembership(team.team_id, user.user_id))?.status === 'active' } } });
    const control = async (operation: 'cancel' | 'reconcile', recordId = created.id) => {
      const before = await store.load(MODEL, asId(recordId)); assert.ok(before);
      const priorHistory = await store.historyFor(MODEL, before.id);
      const mutation = envelope(operation, { job: { id: before.id, version: String(before.version) } });
      committed(await invoker.invokeMutation(mutation, identity));
      const selected = (await store.outboxPending()).find(row => row.operationId === mutation.operation_id);
      assert.ok(selected);
      assert.equal(selected.target, `std.TextGenerationV1.${operation}`);
      assert.equal(selected.operation, mutation.operation);
      assert.notEqual(selected.operationId, before.data['request_source']);
      assert.deepEqual(selected.arguments, { binding: `${APP}.LLM`, from: 'deployment.llm', arguments: {
        source: before.data['request_source'], revision: before.data['request_revision'],
      } });
      const field = operation === 'cancel' ? 'stop' : 'probe';
      const after = await store.load(MODEL, before.id); assert.ok(after);
      assert.equal(after.version, before.version + 1);
      assert.deepEqual(after.data, { ...before.data, [field]: { id: selected.intentId, operation: selected.target } });
      const history = await store.historyFor(MODEL, before.id);
      assert.equal(history.length, priorHistory.length + 1);
      assert.deepEqual(history.slice(0, priorHistory.length), priorHistory);
      const linked = await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),
        asId(associationRowId(MODEL, before.id, field))); assert.ok(linked);
      assert.equal(readAssociationRow(linked).deliveryId, selected.intentId);
      const originalLinked = await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),
        asId(associationRowId(MODEL, before.id, 'request'))); assert.ok(originalLinked);
      assert.equal(readAssociationRow(originalLinked).deliveryId,
        (before.data['request'] as { id: string }).id);
      return { mutation, intent: selected, field, before, after };
    };
    const controlProjection = async (field: 'stop' | 'probe', recordId = created.id) => {
      const body = readBody(await invoker.invokeRead({ operation: 'Receipt.read', inputs: {
        recordId, field, selected: ['result.state', 'result.content', 'result.used_tokens'],
      } }, identity));
      assert.equal(body['outcome'], 'observed');
      assert.ok(typeof body['projection'] === 'object' && body['projection'] !== null && !Array.isArray(body['projection']));
      return body['projection'] as Record<string, unknown>;
    };
    const originalHistory = await store.historyFor(MODEL, asId(created.id));
    assert.equal((await drive(intent.intentId)).status, 'recorded');
    assert.equal(provider.requests.length, 1);
    assert.deepEqual(provider.requests[0], { model: LOCAL_MODEL,
      messages: [{ role: 'user', content: 'Actual compiled request' }] });
    assert.ok(snapshots.some(run => run['state'] === 'running' && run['content'] === 'Local '));
    assert.equal(checkedRunningOrder, true, 'The reordered controls must use actual committed nonterminal provider progress.');
    for (let index = 0; index < snapshots.length; index++) {
      const run = snapshots[index]!;
      assert.equal(run['source'], original.operation_id);
      assert.equal(run['revision'], '1');
      if (index > 0) assert.ok(BigInt(String(run['sequence'])) > BigInt(String(snapshots[index - 1]!['sequence'])));
      assert.equal(JSON.stringify(run).includes('PRIVATE_LOCAL_THINKING'), false);
    }
    const final = snapshots.at(-1)!;
    assert.equal(final['state'], 'succeeded');
    assert.equal(final['content'], 'Local answer.');
    assert.equal(final['used_tokens'], String(localChatTokens(provider.requests[0]!.messages).length + new TextEncoder().encode('Local answer.').length));
    assert.equal(committed(await visible(2)).result, 'Local answer.');
    assert.ok((await pageHtml()).includes('Succeeded'));
    // Source expressions receive native integer values; transports keep wire decimals.
    const observedInteger = (operation: string) => invoker.invokeMutation(envelope(operation, {
      job: { id: created.id, version: '2' },
    }), identity);
    assert.equal(committed(await observedInteger('measured')).result, final['used_tokens']);
    assert.equal(committed(await observedInteger('sequence')).result, final['sequence']);
    assert.deepEqual(readBody(await readReceipt(['result.state', 'result.sequence', 'result.used_tokens']))['projection'], {
      'result.state': 'succeeded', 'result.sequence': final['sequence'], 'result.used_tokens': final['used_tokens'],
    });
    // A parent result grant permits a native nominal value without expanding
    // the member's exact child grants. Its integer fields stay native too.
    const owner = await identities.createUser({ email: 'generation-owner@example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ user_id: owner.user_id, team_id: team.team_id, is_owner: true, roles: [] });
    const ownerToken = 'generation-owner-session';
    await identities.createSession({ user_id: owner.user_id, token_sha256: createHash('sha256').update(ownerToken).digest('hex'),
      expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(), last_team_id: team.team_id });
    const ownerIdentity = await resolveIdentity(identities, { session_token: ownerToken, team_id: team.team_id },
      { clock: { nowMs: () => FIXED_NOW } });
    const wholeSequence = (caller = identity) => invoker.invokeMutation(envelope('wholeSequence', {
      job: { id: created.id, version: '2' },
    }), caller);
    assert.ok('error' in await wholeSequence());
    assert.equal(committed(await wholeSequence(ownerIdentity)).result, final['sequence']);
    assert.deepEqual(await store.historyFor(MODEL, asId(created.id)), originalHistory);
    assert.equal((await store.outboxPending()).length, 0);
    const receiptBeforeReplay = await store.load(asModel(RECEIPT_MODEL), asId(intent.intentId));
    const originalOccurrences = await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' });
    assert.equal(originalOccurrences.length, snapshots.length);
    assert.equal(new Set(originalOccurrences.map(row => row.data['key'])).size, snapshots.length);
    assert.ok(snapshots.some(run => run['state'] === 'succeeded' && run['used_tokens'] === null));
    assert.ok(snapshots.some(run => run['state'] === 'succeeded' && run['used_tokens'] !== null));
    for (const row of originalOccurrences) {
      const occurrence = readScheduleRow(row);
      assert.equal(occurrence.state, 'pending');
      assert.equal(occurrence.key, occurrence.occurrenceId);
      assert.equal(occurrence.event, `${APP}.LLM.generate.progressed`);
      assert.deepEqual(occurrence.payload, { delivery_id: intent.intentId });
    }
    // The defining receipt stage detects replay before invoking the UUID producer.
    assert.ok(receiptBeforeReplay);
    const duplicate = await stageTextGenerationProgress({ intent, context: resultContext,
      revision: readReceiptRow(receiptBeforeReplay, resultContext).receipt.revision,
      progress: final as unknown as import('./bound-text-generation.js').TextRunWire,
      progressed: { producer: progressed, owner: team.team_id } },
    { actor: user.user_id, now: FIXED_NOW, operation: 'test.generation.duplicate',
      load: store.load.bind(store), query: store.query.bind(store) });
    assert.deepEqual(duplicate, { writes: [], result: { notification: null } });
    const terminalRevision = readReceiptRow(receiptBeforeReplay, resultContext).receipt.revision;
    // Equal terminal checkpoints replay the saved outcome even if the sender
    // repeats different content; a newer checkpoint cannot rewrite it.
    assert.deepEqual(await stageOriginalProgress(terminalRevision, { ...final, content: 'Different replay content' }),
      { writes: [], result: { notification: null } });
    await refusedProgress(terminalRevision + 1, { ...final, sequence: String(BigInt(String(final['sequence'])) + 1n),
      content: 'Cannot overwrite terminal content' });
    await refusedProgress(terminalRevision + 1, { ...final, sequence: String(BigInt(String(final['sequence'])) + 1n),
      used_tokens: String(BigInt(String(final['used_tokens'])) + 1n) });
    const replayed = await invoker.invokeMutation(original, identity);
    assert.ok('result' in replayed, JSON.stringify(replayed));
    assert.equal(replayed.result.status, 'replayed');
    assert.equal((await drive(intent.intentId)).status, 'not-pending');
    const completedStop = await control('cancel');
    assert.equal((await drive(completedStop.intent.intentId)).status, 'recorded');
    assert.deepEqual(await controlProjection('stop'), { 'result.state': final['state'],
      'result.content': final['content'], 'result.used_tokens': final['used_tokens'] });
    assert.equal(provider.requests.length, 1);
    assert.deepEqual(await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' }), originalOccurrences);

    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(intent.intentId)), receiptBeforeReplay);

    await worker.dispose(); worker = openWorker();
    const reopenedDatabase = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(reopenedDatabase); store = createD1Storage(reopenedDatabase);
    invoker = invokerFor(); dispatcher = await dispatcherFor();
    assert.deepEqual(readBody(await readReceipt(['result.content']))['projection'], { 'result.content': 'Local answer.' });
    const reopenedOwner = await store.load(MODEL, asId(created.id)); assert.ok(reopenedOwner);
    assert.equal(committed(await visible(reopenedOwner.version)).result, 'Local answer.');
    assert.equal((await drive(intent.intentId)).status, 'not-pending');
    assert.equal(provider.requests.length, 1);

    assert.deepEqual(await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' }), originalOccurrences);
    // Native due entries and their immutable payloads survive reopening. The
    // measured terminal snapshot remains separately deliverable after terminal.
    const dueEntries = await store.schedulesDue(FIXED_NOW, 100);
    assert.equal(dueEntries.length, snapshots.length);
    const dueInputs = originalOccurrences.map(row => {
      const occurrence = readScheduleRow(row);
      assert.ok(dueEntries.some(entry => entry.key.endsWith(`/${occurrence.key}`)));
      return { key: occurrence.key,
        scope: { app: APP, owner: team.team_id, ownerPackage: APP }, occurrenceId: occurrence.occurrenceId,
        event: occurrence.event, at: occurrence.at };
    });
    const fire = async (due: typeof dueInputs[number]) => {
      const answer = await invokeDueScheduleCanonical({ asm, artifact, app: APP,
        handler: `${APP}.progressed`, due, store, identities, now: () => FIXED_NOW });
      assert.ok(typeof answer === 'object' && answer !== null && 'status' in answer);
      return answer as { status: string };
    };
    assert.deepEqual(await fire({ ...dueInputs[0]!, scope: { ...dueInputs[0]!.scope, owner: 'wrong-owner' } }),
      { status: 'refused', reason: 'mismatched' });
    await assert.rejects(fire({ ...dueInputs[0]!, event: `${APP}.Wrong.generate.progressed` }), /exact private invocation/);
    for (const due of dueInputs) assert.equal((await fire(due)).status, 'completed');
    const notices = await store.query({ model: asModel(`${APP}.ProgressNotice`), authority: 'owner' });
    assert.equal(notices.length, snapshots.length);
    assert.ok(notices.every(row => row.data['delivery'] === intent.intentId));
    assert.equal((await fire(dueInputs[0]!)).status, 'replayed');
    assert.deepEqual(await store.query({ model: asModel(`${APP}.ProgressNotice`), authority: 'owner' }), notices);
    assert.equal((await store.schedulesDue(FIXED_NOW, 100)).length, 0);

    const generate = async (prompt: string, accept = true, recordId = created.id) => {
      const current = await store.load(MODEL, asId(recordId)); assert.ok(current);
      const mutation = envelope('generate', { job: { id: current.id, version: String(current.version) }, prompt, accept });
      const answer = await invoker.invokeMutation(mutation, identity);
      if ('result' in answer && answer.result.status === 'committed') {
        const frozen = await store.load(MODEL, current.id); assert.ok(frozen);
        assert.equal(frozen.data['request_source'], mutation.operation_id);
        assert.equal(frozen.data['request_revision'], String(current.version));
      }
      return { mutation, answer };
    };
    const beforeRejected = await store.load(MODEL, asId(created.id));
    const historyBeforeRejected = await store.historyFor(MODEL, asId(created.id));
    const rejected = await generate('Rejected authored generation', false);
    assert.ok('error' in rejected.answer, JSON.stringify(rejected.answer));
    assert.deepEqual(await store.load(MODEL, asId(created.id)), beforeRejected);
    assert.deepEqual(await store.historyFor(MODEL, asId(created.id)), historyBeforeRejected);
    assert.equal((await store.outboxPending()).length, 0);
    const stale = await invoker.invokeMutation(envelope('generate', { job: { id: created.id, version: '1' },
      prompt: 'Stale source version', accept: true }), identity);
    assert.ok('error' in stale, JSON.stringify(stale));
    assert.equal((await store.outboxPending()).length, 0);

    // Compiled controls stop both untouched and genuinely claimed originals
    // before their durable queue checkpoint. Neither path sends provider bytes.
    const beforePendingRequests = provider.requests.length;
    for (const state of ['pending', 'claimed'] as const) {
      const sent = await generate(`Actual ${state} before queue`); committed(sent.answer);
      const originalIntent = (await store.outboxPending()).find(row => row.operationId === sent.mutation.operation_id);
      assert.ok(originalIntent);
      if (state === 'claimed') {
        await identities.removeMembership(membership.membership_id);
        try { assert.equal((await drive(originalIntent.intentId)).status, 'refused-revoked'); }
        finally { await identities.reactivateMembership(membership.membership_id, { is_owner: false, roles: [] }); }
        const claimed = await store.load(WORK_DISPATCH_MODEL, asId(originalIntent.intentId)); assert.ok(claimed);
        assert.equal(claimed.data['state'], 'claimed'); assert.notEqual(claimed.data['claimId'], null);
      }
      const originalRow = await store.load(asModel(RECEIPT_MODEL), asId(originalIntent.intentId)); assert.ok(originalRow);
      const context = adapter.resultContext(originalIntent); assert.ok(context);
      assert.equal(readReceiptRow(originalRow, context).receipt.status, 'pending');
      assert.equal(readReceiptRow(originalRow, context).receipt.result, null);
      const stop = await control('cancel'), answer = await drive(stop.intent.intentId);
      assert.equal(answer.status, 'recorded'); assert.ok('state' in answer); assert.equal(answer.state, 'delivered');
      const skippedRow = await store.load(asModel(RECEIPT_MODEL), asId(originalIntent.intentId)); assert.ok(skippedRow);
      const skipped = readReceiptRow(skippedRow, context).receipt;
      assert.equal(skipped.status, 'skipped'); assert.equal(skipped.result, null);
      assert.deepEqual(await controlProjection('stop'), { 'result.state': 'cancelled', 'result.content': '', 'result.used_tokens': null });
      const stopped = await store.load(WORK_DISPATCH_MODEL, asId(originalIntent.intentId)); assert.ok(stopped);
      assert.equal(stopped.data['guardVerdict'], false); assert.equal(stopped.data['claimId'], null);
      const pinned = await store.load(WORK_DISPATCH_MODEL, asId(stop.intent.intentId)); assert.ok(pinned);
      assert.deepEqual(readDispatchImageControlPin(pinned.data), { originalIntentId: originalIntent.intentId,
        observationStartedAtMs: pinned.created, observationDeadlineMs: pinned.created + installed.profile.maxDurationMs });
      assert.equal((await drive(originalIntent.intentId)).status, 'not-pending');
      assert.equal((await drive(stop.intent.intentId)).status, 'not-pending');
      assert.equal(provider.requests.length, beforePendingRequests);
    }

    // Actual parser failures preserve their failed/unknown state; neither an
    // incomplete stream nor malformed NDJSON can become a successful TextRun.
    for (const mode of ['incomplete', 'malformed'] as const) {
      provider.setMode(mode);
      const sent = await generate(`Actual ${mode} transport`); committed(sent.answer);
      const next = (await store.outboxPending()).find(row => row.operationId === sent.mutation.operation_id); assert.ok(next);
      assert.equal((await drive(next.intentId)).status, 'recorded');
      const row = await store.load(asModel(RECEIPT_MODEL), asId(next.intentId)); assert.ok(row);
      const context = adapter.resultContext(next); assert.ok(context);
      const receipt = readReceiptRow(row, context).receipt;
      if (receipt.result !== null) {
        const run = receipt.result as Record<string, unknown>;
        assert.ok(run['state'] === 'failed' || run['state'] === 'unknown', JSON.stringify(run));
        assert.notEqual(run['content'], 'Local answer.');
        assert.equal(run['source'], sent.mutation.operation_id);
      } else assert.ok(receipt.status === 'failed' || receipt.status === 'unknown', JSON.stringify(receipt));
      assert.equal(JSON.stringify(receipt).includes('PRIVATE_LOCAL_THINKING'), false);
      assert.equal(JSON.stringify(await readReceipt(['result.content'])).includes('PRIVATE_LOCAL_THINKING'), false);
      assert.ok((await pageHtml()).includes(receipt.status === 'unknown' ? 'Unknown' : 'Failed'));
    }

    // Replacement detaches the original attempt without deleting its receipt.
    // Its real provider result must not populate the new current association.
    provider.setMode('complete');
    const old = await generate('Retained original attempt'); committed(old.answer);
    const oldIntent = (await store.outboxPending()).find(row => row.operationId === old.mutation.operation_id); assert.ok(oldIntent);
    const latest = await generate('Current replacement attempt'); committed(latest.answer);
    const latestIntent = (await store.outboxPending()).find(row => row.operationId === latest.mutation.operation_id); assert.ok(latestIntent);
    assert.equal((await drive(oldIntent.intentId)).status, 'recorded');
    const oldRow = await store.load(asModel(RECEIPT_MODEL), asId(oldIntent.intentId)); assert.ok(oldRow);
    const oldContext = adapter.resultContext(oldIntent); assert.ok(oldContext);
    const oldReceipt = readReceiptRow(oldRow, oldContext).receipt;
    assert.equal((oldReceipt.result as Record<string, unknown>)['state'], 'succeeded');
    assert.equal((oldReceipt.result as Record<string, unknown>)['source'], old.mutation.operation_id);
    assert.deepEqual(readBody(await readReceipt(['result.content']))['projection'], { 'result.content': null });
    const replacementHtml = await pageHtml();
    assert.ok(replacementHtml.includes('Awaiting generation'));
    assert.equal(replacementHtml.includes('Local answer.'), false);
    assert.equal((await drive(latestIntent.intentId)).status, 'recorded');
    assert.deepEqual(readBody(await readReceipt(['result.content']))['projection'], { 'result.content': 'Local answer.' });
    const finalOwner = await store.load(MODEL, asId(created.id)); assert.ok(finalOwner);
    assert.equal(committed(await visible(finalOwner.version)).result, 'Local answer.');
    for (const selected of ['result', 'result.source', 'result.revision', 'result.detail', 'status', 'id']) {
      const denied = await readReceipt([selected]);
      assert.equal(readBody(denied)['outcome'], 'denied');
      assert.equal(JSON.stringify(denied).includes(latestIntent.intentId), false);
    }

    // Cancel the actual installed live handle while its HTTP stream is open.
    provider.setMode('held');
    const cancelled = await generate('Actual cancelled transport'); committed(cancelled.answer);
    const cancelledIntent = (await store.outboxPending()).find(row => row.operationId === cancelled.mutation.operation_id); assert.ok(cancelledIntent);
    heldProgressIntent = cancelledIntent;
    const heldProgress = new Promise<void>(resolve => { heldProgressResolve = resolve; });
    const waitingRequest = provider.nextRequest();
    const cancellingDrive = drive(cancelledIntent.intentId);
    await Promise.race([waitingRequest, cancellingDrive.then(() => {
      throw new Error('Held generation finished before the actual provider request.');
    })]);
    await Promise.race([heldProgress, cancellingDrive.then(() => {
      throw new Error('Held generation finished before its native content checkpoint.');
    })]);
    heldProgressIntent = null; heldProgressResolve = null;
    const heldOwner = await store.load(MODEL, asId(created.id)); assert.ok(heldOwner);
    const heldHistory = await store.historyFor(MODEL, heldOwner.id);
    const heldOutbox = await store.outboxPending();
    for (const [caller, version] of [[outsiderIdentity, heldOwner.version], [identity, heldOwner.version - 1]] as const) {
      assert.ok('error' in await invoker.invokeMutation(envelope('cancel', {
        job: { id: heldOwner.id, version: String(version) },
      }), caller));
      assert.deepEqual(await store.load(MODEL, heldOwner.id), heldOwner);
      assert.deepEqual(await store.historyFor(MODEL, heldOwner.id), heldHistory);
      assert.deepEqual(await store.outboxPending(), heldOutbox);
    }
    const cancellation = await control('cancel');
    assert.equal(cancellation.before.data['request_source'], cancelled.mutation.operation_id);
    const cancelRequests = provider.requests.length;
    assert.equal((await drive(cancellation.intent.intentId)).status, 'recorded');
    assert.equal((await cancellingDrive).status, 'recorded');
    const cancelledRow = await store.load(asModel(RECEIPT_MODEL), asId(cancelledIntent.intentId)); assert.ok(cancelledRow);
    const cancelledContext = adapter.resultContext(cancelledIntent); assert.ok(cancelledContext);
    const cancelledRun = readReceiptRow(cancelledRow, cancelledContext).receipt.result as Record<string, unknown>;
    assert.equal(cancelledRun['state'], 'cancelled');
    assert.equal(cancelledRun['source'], cancelled.mutation.operation_id);
    assert.equal(cancelledRun['revision'], cancellation.before.data['request_revision']);
    assert.equal(cancelledRun['content'], 'Local ');
    assert.equal(cancelledRun['used_tokens'], null);
    assert.deepEqual(await controlProjection('stop'), { 'result.state': 'cancelled',
      'result.content': cancelledRun['content'], 'result.used_tokens': cancelledRun['used_tokens'] });
    const stoppedOwner = await store.load(MODEL, asId(created.id));
    const stoppedHistory = await store.historyFor(MODEL, asId(created.id));
    const stoppedOutbox = await store.outboxPending();
    const repeatedStop = await invoker.invokeMutation(cancellation.mutation, identity);
    assert.ok('result' in repeatedStop, JSON.stringify(repeatedStop));
    assert.equal(repeatedStop.result.status, 'replayed');
    assert.equal((await drive(cancellation.intent.intentId)).status, 'not-pending');
    assert.equal(provider.requests.length, cancelRequests);
    assert.deepEqual(await store.load(MODEL, asId(created.id)), stoppedOwner);
    assert.deepEqual(await store.historyFor(MODEL, asId(created.id)), stoppedHistory);
    assert.deepEqual(await store.outboxPending(), stoppedOutbox);
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(cancelledIntent.intentId)), cancelledRow);
    const stoppedRevision = await store.readRevision();
    await assert.rejects(stageTextGenerationProgress({ intent: cancelledIntent, context: cancelledContext,
      revision: readReceiptRow(cancelledRow, cancelledContext).receipt.revision + 1,
      progress: { ...cancelledRun, state: 'succeeded', content: 'Late success cannot replace cancellation',
        sequence: String(BigInt(String(cancelledRun['sequence'])) + 1n) } as unknown as
          import('./bound-text-generation.js').TextRunWire,
      progressed: { producer: progressed, owner: team.team_id } },
    { actor: user.user_id, now: FIXED_NOW, operation: 'test.generation.cancelled-late-success',
      load: store.load.bind(store), query: store.query.bind(store) }), error =>
      error instanceof Error && 'code' in error && error.code === 'validation');
    assert.equal(await store.readRevision(), stoppedRevision);
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(cancelledIntent.intentId)), cancelledRow);
    assert.ok((await pageHtml()).includes('Cancelled'));
    provider.setMode('complete');

    // The terminal receipt commits, then its native commit response is lost.
    // Fresh recovery must acknowledge durable evidence without replaying HTTP.
    const beforeTerminalLoss = await store.load(MODEL, asId(created.id)); assert.ok(beforeTerminalLoss);
    const lost = await generate('Actual terminal commit response loss'); committed(lost.answer);
    const lostIntent = (await store.outboxPending()).find(row => row.operationId === lost.mutation.operation_id); assert.ok(lostIntent);
    terminalFaultIntent = lostIntent;
    const lostDrive = await drive(lostIntent.intentId);
    assert.equal(terminalResponseLost, true);
    assert.equal(lostDrive.status, 'recorded');
    assert.ok('state' in lostDrive, JSON.stringify(lostDrive));
    assert.equal(lostDrive.state, 'uncertain');
    const lostContext = adapter.resultContext(lostIntent); assert.ok(lostContext);
    const durableTerminalRow = await store.load(asModel(RECEIPT_MODEL), asId(lostIntent.intentId)); assert.ok(durableTerminalRow);
    const durableTerminal = readReceiptRow(durableTerminalRow, lostContext).receipt;
    assert.equal(durableTerminal.status, 'succeeded');
    const durableRun = durableTerminal.result as Record<string, unknown>;
    assert.equal(durableRun['state'], 'succeeded');
    assert.equal(durableRun['source'], lost.mutation.operation_id);
    assert.equal(durableRun['revision'], String(beforeTerminalLoss.version));
    assert.equal(durableRun['content'], 'Local answer.');
    assert.equal(durableRun['used_tokens'], null);
    assert.equal(terminalFaultIntent, null);
    const durableAssociation = await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),
      asId(associationRowId(MODEL, created.id, 'request')));
    const durableOwner = await store.load(MODEL, asId(created.id));
    assert.ok(durableAssociation); assert.ok(durableOwner);
    assert.equal(readAssociationRow(durableAssociation).deliveryId, lostIntent.intentId);
    assert.deepEqual(durableOwner.data['request'], { id: lostIntent.intentId, operation: lostIntent.target });
    const durableHistory = await store.historyFor(MODEL, asId(created.id));
    assert.deepEqual(await store.outboxPending(), [lostIntent]);
    const terminalRequests = provider.requests.length;
    assert.equal(provider.requests.length, terminalRequests);
    await worker.dispose(); worker = openWorker();
    const terminalDatabase = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(terminalDatabase); store = createD1Storage(terminalDatabase);
    invoker = invokerFor(); adapter = freshAdapter(); dispatcher = await dispatcherFor();
    const terminalRecovery = await recover();
    assert.deepEqual(terminalRecovery.reconciled, [{ intentId: lostIntent.intentId, state: 'delivered' }]);
    assert.equal(terminalRecovery.retried.length, 0);
    assert.equal(provider.requests.length, terminalRequests);
    assert.equal((await store.load(WORK_DISPATCH_MODEL, asId(lostIntent.intentId)))?.data['state'], 'delivered');
    assert.equal((await store.outboxPending()).length, 0);
    assert.deepEqual(readBody(await readReceipt(['result.state', 'result.content']))['projection'], {
      'result.state': 'succeeded', 'result.content': 'Local answer.',
    });
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(lostIntent.intentId)), durableTerminalRow);
    assert.deepEqual(await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),
      asId(associationRowId(MODEL, created.id, 'request'))), durableAssociation);
    assert.deepEqual(await store.load(MODEL, asId(created.id)), durableOwner);
    assert.deepEqual(await store.historyFor(MODEL, asId(created.id)), durableHistory);
    const deliveredDispatch = await store.load(WORK_DISPATCH_MODEL, asId(lostIntent.intentId));
    const duplicateRecovery = await recover();
    assert.equal(duplicateRecovery.reconciled.length, 0);
    assert.equal(duplicateRecovery.retried.length, 0);
    assert.deepEqual(await store.load(WORK_DISPATCH_MODEL, asId(lostIntent.intentId)), deliveredDispatch);
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(lostIntent.intentId)), durableTerminalRow);
    assert.deepEqual(await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),
      asId(associationRowId(MODEL, created.id, 'request'))), durableAssociation);
    assert.deepEqual(await store.historyFor(MODEL, asId(created.id)), durableHistory);
    assert.equal(provider.requests.length, terminalRequests);
    const terminalProbe = await control('reconcile');
    assert.equal(terminalProbe.before.data['request_source'], lost.mutation.operation_id);
    assert.equal(terminalProbe.before.data['request_revision'], String(beforeTerminalLoss.version));
    assert.equal((await drive(terminalProbe.intent.intentId)).status, 'recorded');
    assert.deepEqual(await controlProjection('probe'), { 'result.state': 'succeeded',
      'result.content': durableRun['content'], 'result.used_tokens': durableRun['used_tokens'] });
    assert.equal(provider.requests.length, terminalRequests);
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(lostIntent.intentId)), durableTerminalRow);
    assert.deepEqual(await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),
      asId(associationRowId(MODEL, created.id, 'request'))), durableAssociation);
    assert.deepEqual(await store.load(MODEL, asId(created.id)), terminalProbe.after);

    // A process can die after real receipt progress but before Work records it.
    // A fresh stale-claim drive admits the retained terminal/unknown observation.
    const claimedUnknownIntents: OutboxIntent[] = [];
    for (const mode of ['complete', 'interrupted'] as const) {
      provider.setMode(mode);
      const beforeClaimedWindow = await store.load(MODEL, asId(created.id)); assert.ok(beforeClaimedWindow);
      const sent = await generate(`Actual claimed-window ${mode}`); committed(sent.answer);
      const chosen = (await store.outboxPending()).find(row => row.operationId === sent.mutation.operation_id); assert.ok(chosen);
      const chosenContext = adapter.resultContext(chosen); assert.ok(chosenContext);
      const chosenHistory = await store.historyFor(MODEL, asId(created.id));
      recordFaultIntent = chosen;
      await assert.rejects(drive(chosen.intentId));
      assert.equal(recordFaultIntent, null);
      assert.equal(recordCommitsInterrupted, mode === 'complete' ? 1 : 2);
      const held = await store.load(WORK_DISPATCH_MODEL, asId(chosen.intentId)); assert.ok(held);
      assert.equal(held.data['state'], 'claimed');
      const chosenReceiptRow = await store.load(asModel(RECEIPT_MODEL), asId(chosen.intentId)); assert.ok(chosenReceiptRow);
      const chosenReceipt = readReceiptRow(chosenReceiptRow, chosenContext).receipt;
      const chosenRun = chosenReceipt.result as Record<string, unknown>;
      assert.equal(chosenRun['state'], mode === 'complete' ? 'succeeded' : 'unknown');
      assert.equal(chosenRun['source'], sent.mutation.operation_id);
      assert.equal(chosenRun['revision'], String(beforeClaimedWindow.version));
      const chosenAssociation = await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),
        asId(associationRowId(MODEL, created.id, 'request'))); assert.ok(chosenAssociation);
      assert.equal(readAssociationRow(chosenAssociation).deliveryId, chosen.intentId);
      const chosenOwner = await store.load(MODEL, asId(created.id)); assert.ok(chosenOwner);
      assert.deepEqual(chosenOwner.data['request'], { id: chosen.intentId, operation: chosen.target });
      assert.ok((await store.outboxPending()).some(row => row.intentId === chosen.intentId));
      const chosenRequestCount: number = provider.requests.length;

      await worker.dispose(); worker = openWorker();
      const claimedDatabase = await worker.getD1Database('DB') as unknown as D1Database;
      await ensureSchema(claimedDatabase); store = createD1Storage(claimedDatabase);
      invoker = invokerFor(); adapter = freshAdapter(); dispatcher = await dispatcherFor();
      assert.deepEqual(await store.load(WORK_DISPATCH_MODEL, asId(chosen.intentId)), held);
      dispatchNow += 60_001;
      const resumed = await drive(chosen.intentId);
      assert.equal(resumed.status, 'recorded');
      assert.ok('state' in resumed, JSON.stringify(resumed));
      assert.equal(resumed.state, mode === 'complete' ? 'delivered' : 'uncertain');
      assert.equal(provider.requests.length, chosenRequestCount);
      assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(chosen.intentId)), chosenReceiptRow);
      assert.deepEqual(await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),
        asId(associationRowId(MODEL, created.id, 'request'))), chosenAssociation);
      assert.deepEqual(await store.load(MODEL, asId(created.id)), chosenOwner);
      assert.deepEqual(await store.historyFor(MODEL, asId(created.id)), chosenHistory);
      assert.deepEqual(readBody(await readReceipt(['result.state', 'result.content']))['projection'], {
        'result.state': chosenRun['state'], 'result.content': chosenRun['content'],
      });
      assert.ok((await pageHtml()).includes(mode === 'complete' ? 'Succeeded' : 'Unknown'));
      if (mode === 'complete') assert.equal((await store.outboxPending()).some(row => row.intentId === chosen.intentId), false);
      else {
        claimedUnknownIntents.push(chosen);
        assert.ok((await store.outboxPending()).some(row => row.intentId === chosen.intentId));
      }
    }

    // Restart recovery has no Ollama run lookup or durable provider evidence.
    // An interrupted original attempt must stay unknown, without a blind send.
    provider.setMode('interrupted');
    const beforeInterruption = await store.load(MODEL, asId(created.id)); assert.ok(beforeInterruption);
    const interrupted = await generate('Actual interrupted transport'); committed(interrupted.answer);
    const interruptedIntent = (await store.outboxPending()).find(row => row.operationId === interrupted.mutation.operation_id);
    assert.ok(interruptedIntent);
    const interruptedDrive = await drive(interruptedIntent.intentId);
    assert.equal(interruptedDrive.status, 'recorded');
    assert.ok('state' in interruptedDrive, JSON.stringify(interruptedDrive));
    assert.equal(interruptedDrive.state, 'uncertain');
    const interruptedRequestCount = provider.requests.length;
    assert.deepEqual(await adapter.callProvider(interruptedIntent), { kind: 'uncertain' });
    assert.equal(provider.requests.length, interruptedRequestCount);
    const interruptedContext = adapter.resultContext(interruptedIntent); assert.ok(interruptedContext);
    const receiptBeforeRestart = await store.load(asModel(RECEIPT_MODEL), asId(interruptedIntent.intentId));
    assert.ok(receiptBeforeRestart);
    const unknownReceipt = readReceiptRow(receiptBeforeRestart, interruptedContext).receipt;
    assert.equal(unknownReceipt.status, 'unknown');
    const unknownRun = unknownReceipt.result as Record<string, unknown>;
    assert.equal(unknownRun['state'], 'unknown');
    assert.equal(unknownRun['source'], interrupted.mutation.operation_id);
    assert.equal(unknownRun['revision'], String(beforeInterruption.version));
    assert.equal(JSON.stringify(unknownRun).includes('PRIVATE_LOCAL_THINKING'), false);
    const associationBeforeRestart = await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),
      asId(associationRowId(MODEL, created.id, 'request')));
    assert.ok(associationBeforeRestart);
    assert.equal(readAssociationRow(associationBeforeRestart).deliveryId, interruptedIntent.intentId);
    assert.equal(readAssociationRow(associationBeforeRestart).source, interruptedIntent.target);
    const dispatchBeforeRestart = await store.load(WORK_DISPATCH_MODEL, asId(interruptedIntent.intentId));
    assert.equal(dispatchBeforeRestart?.data['state'], 'uncertain');
    const recoveryOwner = await store.load(MODEL, asId(created.id)); assert.ok(recoveryOwner);
    assert.deepEqual(recoveryOwner.data['request'], { id: interruptedIntent.intentId, operation: interruptedIntent.target });
    const recoveryHistory = await store.historyFor(MODEL, asId(created.id));
    const requestsBeforeRecovery = provider.requests.length;

    await worker.dispose(); worker = openWorker();
    const recoveryDatabase = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(recoveryDatabase); store = createD1Storage(recoveryDatabase);
    invoker = invokerFor();
    adapter = freshAdapter();
    dispatcher = await dispatcherFor();
    assert.deepEqual(await store.load(WORK_DISPATCH_MODEL, asId(interruptedIntent.intentId)), dispatchBeforeRestart);
    const recovered = await recover();
    assert.ok(recovered.awaiting.includes(interruptedIntent.intentId));
    assert.ok(claimedUnknownIntents.every(row => recovered.awaiting.includes(row.intentId)));
    assert.equal(recovered.reconciled.length, 0);
    assert.equal(recovered.retried.length, 0);
    assert.equal(provider.requests.length, requestsBeforeRecovery);
    assert.deepEqual(await store.load(WORK_DISPATCH_MODEL, asId(interruptedIntent.intentId)), dispatchBeforeRestart);
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(interruptedIntent.intentId)), receiptBeforeRestart);
    assert.deepEqual(await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),
      asId(associationRowId(MODEL, created.id, 'request'))), associationBeforeRestart);
    assert.deepEqual(await store.load(MODEL, asId(created.id)), recoveryOwner);
    assert.deepEqual(await store.historyFor(MODEL, asId(created.id)), recoveryHistory);
    assert.deepEqual([...(await store.outboxPending())].sort((left, right) => left.intentId.localeCompare(right.intentId)),
      [...claimedUnknownIntents, interruptedIntent].sort((left, right) => left.intentId.localeCompare(right.intentId)));
    assert.deepEqual(readBody(await readReceipt(['result.state', 'result.content']))['projection'], {
      'result.state': 'unknown', 'result.content': unknownRun['content'],
    });
    assert.ok((await pageHtml()).includes('Unknown'));
    // A fresh admitted source control after reopening uses the frozen original
    // correlation. Missing durable provider evidence cannot become success.
    const unknownProbe = await control('reconcile');
    assert.equal(unknownProbe.before.data['request_source'], interrupted.mutation.operation_id);
    assert.equal(unknownProbe.before.data['request_revision'], String(beforeInterruption.version));
    const probeHistory = await store.historyFor(MODEL, asId(created.id));
    const unknownControl = await drive(unknownProbe.intent.intentId);
    assert.equal(unknownControl.status, 'recorded');
    assert.ok('state' in unknownControl, JSON.stringify(unknownControl));
    assert.equal(unknownControl.state, 'uncertain');
    const probeProjection = await controlProjection('probe');
    assert.ok(probeProjection['result.state'] === null || probeProjection['result.state'] === 'unknown');
    if (probeProjection['result.content'] !== null) assert.equal(probeProjection['result.content'], unknownRun['content']);
    assert.equal(probeProjection['result.used_tokens'], null);
    assert.equal(provider.requests.length, requestsBeforeRecovery);
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(interruptedIntent.intentId)), receiptBeforeRestart);
    assert.deepEqual(await store.load(WORK_DISPATCH_MODEL, asId(interruptedIntent.intentId)), dispatchBeforeRestart);
    assert.deepEqual(await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),
      asId(associationRowId(MODEL, created.id, 'request'))), associationBeforeRestart);
    assert.deepEqual(await store.load(MODEL, asId(created.id)), unknownProbe.after);
    assert.deepEqual(await store.historyFor(MODEL, asId(created.id)), probeHistory);
    assert.ok((await store.outboxPending()).some(row => row.intentId === unknownProbe.intent.intentId));
    const outsiderPage = await pageResponse(outsiderCookie);
    assert.equal(outsiderPage.status, 403);
    const outsiderHtml = await outsiderPage.text();
    assert.equal(outsiderHtml.includes('Local '), false);
    assert.equal(outsiderHtml.includes(interruptedIntent.intentId), false);
    const hiddenRecovery = await readReceipt(['result.content'], outsiderIdentity);
    assert.ok('error' in hiddenRecovery || readBody(hiddenRecovery)['outcome'] === 'denied', JSON.stringify(hiddenRecovery));

    // An uncertain control retains one window from its actual native creation.
    // Reopening beyond that deadline cannot renew observation or emit progress.
    const probeDispatch = await store.load(WORK_DISPATCH_MODEL, asId(unknownProbe.intent.intentId)); assert.ok(probeDispatch);
    const probePin = readDispatchImageControlPin(probeDispatch.data); assert.ok(probePin);
    assert.deepEqual(probePin, { originalIntentId: interruptedIntent.intentId,
      observationStartedAtMs: probeDispatch.created,
      observationDeadlineMs: probeDispatch.created + installed.profile.maxDurationMs });
    assert.equal(installed.profile.maxDurationMs, 30_000);
    const probeReceipt = await store.load(asModel(RECEIPT_MODEL), asId(unknownProbe.intent.intentId)); assert.ok(probeReceipt);
    const beforeExpiredSchedules = await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' });
    const beforeExpiredNotices = await store.query({ model: asModel(`${APP}.ProgressNotice`), authority: 'owner' });
    dispatchNow = probePin.observationDeadlineMs + 1;
    await worker.dispose(); worker = openWorker();
    const expiredDatabase = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(expiredDatabase); store = createD1Storage(expiredDatabase);
    invoker = invokerFor(); adapter = freshAdapter(); dispatcher = await dispatcherFor();
    for (let attempt = 0; attempt < 2; attempt++) {
      const expiredRecovery = await recover();
      assert.ok(expiredRecovery.awaiting.includes(unknownProbe.intent.intentId));
      assert.equal(expiredRecovery.reconciled.length, 0); assert.equal(expiredRecovery.retried.length, 0);
      assert.deepEqual(await store.load(WORK_DISPATCH_MODEL, asId(unknownProbe.intent.intentId)), probeDispatch);
      assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(unknownProbe.intent.intentId)), probeReceipt);
      assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(interruptedIntent.intentId)), receiptBeforeRestart);
      assert.deepEqual(await store.load(MODEL, asId(created.id)), unknownProbe.after);
      assert.deepEqual(await store.historyFor(MODEL, asId(created.id)), probeHistory);
      assert.deepEqual(await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' }), beforeExpiredSchedules);
      assert.deepEqual(await store.query({ model: asModel(`${APP}.ProgressNotice`), authority: 'owner' }), beforeExpiredNotices);
      assert.equal(provider.requests.length, requestsBeforeRecovery);
    }

    // Provider success wins before cancellation, while its real durable
    // progress callback is stalled. Control expiry neither aborts the run nor
    // manufactures success; releasing the callback commits genuine late bytes.
    provider.setMode('complete');
    const racingJob = committed(await invoker.invokeMutation(envelope('Job.create', {}), identity)).records![0] as { id: string; version: number };
    const racing = await generate('Actual success racing control expiry', true, racingJob.id); committed(racing.answer);
    const racingIntent = (await store.outboxPending()).find(row => row.operationId === racing.mutation.operation_id);
    assert.ok(racingIntent);
    const racingContext = adapter.resultContext(racingIntent); assert.ok(racingContext);
    stalledProgressIntent = racingIntent;
    const stalled = new Promise<void>(resolve => { stalledProgressResolve = resolve; });
    let release: (() => void) | undefined;
    releaseStalledProgress = new Promise<void>(resolve => { release = resolve; });
    const completed = new Promise<void>(resolve => { nativeCompletionWaiters.set(racingIntent.intentId, resolve); });
    const racingDrive = drive(racingIntent.intentId);
    await Promise.race([stalled, racingDrive.then(() => { throw new Error('Original finished before durable callback stall.'); })]);
    await Promise.race([completed, racingDrive.then(() => { throw new Error('Original finished before real provider completion.'); })]);
    const nativeCompletion = nativeCompletions.get(racingIntent.intentId); assert.ok(nativeCompletion);
    assert.equal(nativeCompletion.status, 'succeeded');
    const partialRow = await store.load(asModel(RECEIPT_MODEL), asId(racingIntent.intentId)); assert.ok(partialRow);
    const partial = readReceiptRow(partialRow, racingContext).receipt;
    assert.equal((partial.result as Record<string, unknown>)['state'], 'running');
    assert.equal((partial.result as Record<string, unknown>)['content'], 'Local ');
    assert.equal((partial.result as Record<string, unknown>)['used_tokens'], null);
    const racingStop = await control('cancel', racingJob.id);
    const beforeRacingDispatch = await store.load(WORK_DISPATCH_MODEL, asId(racingStop.intent.intentId)); assert.ok(beforeRacingDispatch);
    const racingRequests = provider.requests.length;
    const racingSchedules = await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' });
    dispatchNow = beforeRacingDispatch.created + installed.profile.maxDurationMs - 50;
    try {
      const timedOut = await drive(racingStop.intent.intentId);
      assert.equal(timedOut.status, 'recorded'); assert.ok('state' in timedOut); assert.equal(timedOut.state, 'uncertain');
      const timedOutDispatch = await store.load(WORK_DISPATCH_MODEL, asId(racingStop.intent.intentId)); assert.ok(timedOutDispatch);
      assert.deepEqual(readDispatchImageControlPin(timedOutDispatch.data), { originalIntentId: racingIntent.intentId,
        observationStartedAtMs: beforeRacingDispatch.created,
        observationDeadlineMs: beforeRacingDispatch.created + installed.profile.maxDurationMs });
      assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(racingIntent.intentId)), partialRow);
      assert.equal((await store.load(WORK_DISPATCH_MODEL, asId(racingIntent.intentId)))?.data['state'], 'claimed');
      assert.deepEqual(await controlProjection('stop', racingJob.id), { 'result.state': null, 'result.content': null, 'result.used_tokens': null });
      assert.deepEqual(await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' }), racingSchedules);
      assert.equal(provider.requests.length, racingRequests);
    } finally { release?.(); }
    assert.equal((await racingDrive).status, 'recorded');
    releaseStalledProgress = null; stalledProgressResolve = null; nativeCompletionWaiters.delete(racingIntent.intentId);
    const racingRow = await store.load(asModel(RECEIPT_MODEL), asId(racingIntent.intentId)); assert.ok(racingRow);
    const racingRun = readReceiptRow(racingRow, racingContext).receipt.result as Record<string, unknown>;
    assert.equal(racingRun['state'], 'succeeded'); assert.equal(racingRun['content'], 'Local answer.');
    assert.equal(racingRun['used_tokens'], String(localChatTokens(provider.requests.at(-1)!.messages).length +
      new TextEncoder().encode('Local answer.').length));
    assert.equal(racingRun['source'], racing.mutation.operation_id);
    const beforeLateJoinSchedules = await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' });
    dispatchNow = beforeRacingDispatch.created + installed.profile.maxDurationMs + 1;
    const lateJoin = await recover();
    assert.ok(lateJoin.reconciled.some(row => row.intentId === racingStop.intent.intentId && row.state === 'delivered'));
    assert.deepEqual(await controlProjection('stop', racingJob.id), { 'result.state': 'succeeded',
      'result.content': racingRun['content'], 'result.used_tokens': racingRun['used_tokens'] });
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), asId(racingIntent.intentId)), racingRow);
    const lateDispatch = await store.load(WORK_DISPATCH_MODEL, asId(racingStop.intent.intentId)); assert.ok(lateDispatch);
    assert.deepEqual(readDispatchImageControlPin(lateDispatch.data), { originalIntentId: racingIntent.intentId,
      observationStartedAtMs: beforeRacingDispatch.created,
      observationDeadlineMs: beforeRacingDispatch.created + installed.profile.maxDurationMs });
    assert.deepEqual(await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner' }), beforeLateJoinSchedules);
    assert.equal(provider.requests.length, racingRequests);

    await identities.removeMembership(membership.membership_id);
    const revokedPage = await pageResponse();
    assert.equal(revokedPage.status, 403);
    assert.equal((await revokedPage.text()).includes('Local answer.'), false);
    const revokedRead = await readReceipt(['result.content']);
    assert.ok('error' in revokedRead || readBody(revokedRead)['outcome'] === 'denied', JSON.stringify(revokedRead));
    assert.ok('error' in await visible(unknownProbe.after.version));
    const revokedOwner = await store.load(MODEL, asId(created.id)); assert.ok(revokedOwner);
    assert.ok('error' in await invoker.invokeMutation(envelope('cancel', {
      job: { id: created.id, version: String(revokedOwner.version) },
    }), identity));
  } finally {
    await worker.dispose();
    await provider.close();
    await rm(dir, { recursive: true, force: true });
  }
});
