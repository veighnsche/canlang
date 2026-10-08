import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationEnvelope } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { createInstalledSystemOneJudgment } from '@canlang/services';
import { WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { WORK_DISPATCH_MODEL } from '@canlang/work/kernel/tables';
import { observeSelectedReceipt } from '@canlang/work/observation/observation';
import { attemptDispatch } from '@canlang/work/dispatch';
import { classifyFailure } from '@canlang/work/receipt';
import { planRecoveryScan } from '@canlang/work/recovery';
import { asId, asModel, asOperationId, FIXED_NOW, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { RECEIPT_MODEL, readReceiptRow } from '@canlang/state/receipt/tables';
import { assembleModules } from './modules.js';
import { buildInvoker, type MutationOutcome } from '../worker/assembly.js';
import { createBoundJudgmentAdapter } from './bound-judgment.js';
import { createBoundJudgmentDispatcher } from './bound-dispatch.js';
import { loadCanonicalDescriptors } from './invoke.js';
import type { FenceAttemptDispatchFn } from './invoke.js';

const APP = 'StaticJudgment', MODEL = asModel(`${APP}.Assessment`);
const fixture = 'compiler/tests/fixtures/static_judgment.can';
function committed(outcome: MutationOutcome) {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, 'committed');
  return outcome.result;
}

test('source-owned static judgment joins localhost evaluation and authorized retained receipts across native D1 reopening', async () => {
  // This selected provider is a real controlled HTTP protocol, not remote acceptance.
  const requests: Record<string, unknown>[] = [];
  let unknown = false;
  const server = createServer(async (request, response) => {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/systemone');
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    requests.push(JSON.parse(body) as Record<string, unknown>);
    response.writeHead(unknown ? 503 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(unknown ? { error: 'Unavailable local judgment result' } : {
      model: 'local-systemone-model', answers: {
        reply: { type: 'noul', noul: 0.75 },
        route: { type: 'choice', choice: 'sales', probabilities: { purchasing: 0, support: 0, sales: 1, general: 0 }, confidence: 1 },
        urgency: { type: 'score', score: 0, legend: {
          '0': 'Routine follow-up without a same-day deadline',
          '1': 'Same-day action for an explicit near-term deadline',
          '2': 'Immediate action for an ongoing operational disruption',
        }, probabilities: { '0': 1, '1': 0, '2': 0 }, confidence: 1 },
      }, usage: { input_tokens: 120, output_tokens: 30 },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'can-bound-judgment-'));
  let worker: Miniflare | undefined;
  let now = FIXED_NOW, sequence = 0;
  const clock = { nowMs: () => now };
  const operationId = () => asOperationId(uuidv7(now, ++sequence));
  const open = async () => {
    worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'bound-judgment' }, d1Persist: join(directory, 'd1') });
    const database = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(database); await ensureIdentitySchema(database);
    return { store: createD1Storage(database), identities: createD1IdentityStore(database, { clock }) };
  };
  try {
    let storage = await open();
    const team = await storage.identities.createTeam({ timezone: 'UTC' });
    const user = await storage.identities.createUser({ email: 'judgment-member@example.test', password_hash: 'unused', email_verified: true });
    await storage.identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = 'native-judgment-session';
    await storage.identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(now + 3_600_000).toISOString() });
    const identity = await resolveIdentity(storage.identities, { session_token: token }, { clock });
    const artifact = JSON.parse(execFileSync('compiler/target/debug/can', [
      'compile', '--format=json', '--catalog=packages/values/dist/catalog.json', fixture,
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: fixture }, {
      workDir: join(directory, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui') });
    const definition = (await import(asm.entryUrl)).appDefinition as unknown;
    const invokerFor = () => buildInvoker(artifact, asm, storage.store, { memberships: storage.identities, now: clock.nowMs,
      selectedReceiptObserver: { observeSelectedReceipt: (input: unknown) =>
        observeSelectedReceipt(input as Parameters<typeof observeSelectedReceipt>[0]) } });
    let invoker = invokerFor();
    const specification = await invoker.invokeRead({ operation: `${APP}.specification_snapshot`, inputs: {} }, identity);
    assert.ok('result' in specification, JSON.stringify(specification));
    const originalSpec = (specification.result as { result: Record<string, unknown> }).result;
    assert.equal(originalSpec.declaration, `${APP}.Triage`); assert.equal(originalSpec.version, '1');
    const envelope = (accept: boolean): MutationEnvelope => ({ operation: `${APP}.evaluate`, operation_id: operationId(),
      inputs: { state: 'A prospective customer asks for pricing.', accept } });
    const rollback = envelope(false);
    const denied = await invoker.invokeMutation(rollback, identity);
    assert.ok('error' in denied, JSON.stringify(denied));
    assert.equal(denied.error.code, 'rule_failed', JSON.stringify(denied));
    assert.deepEqual(await storage.store.query({ model: MODEL, authority: 'owner' }), []);
    assert.deepEqual(await storage.store.outboxPending(), []);
    const evaluate = envelope(true);
    const born = committed(await invoker.invokeMutation(evaluate, identity));
    const assessment = born.result as { id: string };
    const originalRow = await storage.store.load(MODEL, asId(assessment.id)); assert.ok(originalRow);
    assert.deepEqual(originalRow.data.specification, originalSpec);
    const original = (await storage.store.outboxPending())[0]!; assert.ok(original);
    assert.equal(original.target, `${APP}.Triage.evaluate`);
    assert.equal(original.arguments.binding, `${APP}.Judge`); assert.equal(original.arguments.from, 'deployment.judgment');
    assert.deepEqual(original.arguments.arguments, { state: evaluate.inputs.state });
    const carrier = original.arguments.judgment as { specification: unknown; order: readonly string[] };
    assert.deepEqual(carrier.specification, originalSpec); assert.deepEqual(carrier.order, ['reply', 'route', 'urgency']);
    const sourceRevision = await storage.store.readRevision();
    const replay = await invoker.invokeMutation(evaluate, identity);
    assert.ok('result' in replay); assert.equal(replay.result.status, 'replayed');
    assert.equal(await storage.store.readRevision(), sourceRevision);
    assert.deepEqual(await storage.store.outboxPending(), [original]);
    const binding = { judgment: `${APP}.Triage`, version: 1n, deployment: 'deployment.judgment', account: 'owned-local-judgment' };
    const installed = createInstalledSystemOneJudgment({ baseUrl: `http://127.0.0.1:${address.port}`,
      timeoutMs: 2000, maxBodyBytes: 100000, models: ['local-systemone-model'], minChoiceOptions: 2, maxChoiceOptions: 26,
      minScoreLevels: 2, maxScoreLevels: 10, maxRequestBytes: 65536 }, binding,
    { model: 'local-systemone-model', maxInputTokens: 4096, countInputTokens: body => Buffer.byteLength(body, 'utf8') });
    const loaded = await loadCanonicalDescriptors(asm, artifact);
    assert.ok(loaded.valueTypes);
    const adapter = createBoundJudgmentAdapter({ appDefinition: definition, binding, valueTypes: loaded.valueTypes,
      resolveInstalledJudgment: deployment => deployment === binding.deployment ? installed : null });
    assert.equal(adapter.available(original), true);
    const dispatcherFor = () => createBoundJudgmentDispatcher({ store: storage.store, adapter,
      workCommands: WORK_SYSTEM_COMMANDS, stageCommands: WORK_DISPATCH_STAGE_COMMANDS, createClaimCommand: createWorkDispatchClaimCommand });
    let dispatcher = await dispatcherFor();
    const drive = (intentId: string) => dispatcher.drive({ intentId, actor: user.user_id, operation: 'test.judgment.drive',
      nowMs: clock.nowMs, nextClaimId: () => `claim-${++sequence}`, maxClaimAgeMs: 60_000,
      claimOperationId: operationId(), recordOperationId: operationId(), classifyFailure,
      evaluateGuard: () => true, readStateSnapshot: () => null,
      fence: { owner: team.team_id, attemptDispatch: attemptDispatch as FenceAttemptDispatchFn,
        revalidateAuthority: async () => (await storage.identities.findMembership(team.team_id, user.user_id))?.status === 'active' } });
    const result = await drive(original.intentId);
    assert.equal(result.status, 'recorded'); assert.ok('state' in result); assert.equal(result.state, 'delivered');
    assert.equal(requests.length, 1); assert.equal(requests[0]!.model, installed.profile.model);
    assert.deepEqual(Object.keys(requests[0]!.questions as object), carrier.order);
    const context = adapter.resultContext(original); assert.ok(context);
    const receiptRow = await storage.store.load(asModel(RECEIPT_MODEL), asId(original.intentId)); assert.ok(receiptRow);
    const receipt = readReceiptRow(receiptRow, context).receipt;
    assert.equal(receipt.status, 'succeeded');
    const answer = receipt.result as Record<string, unknown>;
    assert.equal(answer.specification_revision, originalSpec.revision);
    assert.equal(answer.input_tokens, '120'); assert.equal(answer.output_tokens, '30');
    assert.equal((answer.route as Record<string, unknown>).choice, 'sales');
    const observed = await invoker.invokeRead({ operation: 'Receipt.read', inputs: { recordId: assessment.id,
      field: 'request', selected: ['status', 'result'] } }, identity);
    assert.ok('result' in observed, JSON.stringify(observed));
    assert.deepEqual((observed.result as unknown as { projection: unknown }).projection, { status: 'succeeded', result: answer });
    const typedRead = await invoker.invokeRead({ operation: `${APP}.snapshot`, inputs: {
      result: answer, specification: originalSpec, queue: { kind: 'sales' }, review: { urgency: 'routine' },
    } }, identity);
    assert.ok('result' in typedRead, JSON.stringify(typedRead));
    assert.equal((typedRead.result as { result: unknown }).result, 'routine');
    assert.equal((await storage.store.load(MODEL, asId(assessment.id)))?.data.result, null,
      'Provider observation alone never makes a human business approval.');
    const history = await storage.store.historyFor(MODEL, asId(assessment.id));
    await worker!.dispose(); worker = undefined; storage = await open(); invoker = invokerFor(); dispatcher = await dispatcherFor();
    assert.deepEqual(await storage.store.load(asModel(RECEIPT_MODEL), asId(original.intentId)), receiptRow);
    assert.equal((await drive(original.intentId)).status, 'not-pending'); assert.equal(requests.length, 1);
    assert.deepEqual(await storage.store.historyFor(MODEL, asId(assessment.id)), history);
    unknown = true;
    const pendingResult = committed(await invoker.invokeMutation(envelope(true), identity)); assert.ok(pendingResult);
    const uncertainIntent = (await storage.store.outboxPending())[0]!;
    const uncertain = await drive(uncertainIntent.intentId);
    assert.ok('state' in uncertain); assert.equal(uncertain.state, 'uncertain'); assert.equal(requests.length, 2);
    const held = await storage.store.load(asModel(WORK_DISPATCH_MODEL), asId(uncertainIntent.intentId));
    await worker!.dispose(); worker = undefined; storage = await open(); dispatcher = await dispatcherFor();
    now += 60_001;
    const recovered = await dispatcher.recover({ actor: user.user_id, operation: 'test.judgment.recover', nowMs: clock.nowMs,
      maxClaimAgeMs: 60_000, policy: { maxAttempts: 3, horizonMs: 3_600_000 }, limit: 10,
      operationIdForStep: operationId, planRecoveryScan });
    assert.ok(recovered.awaiting.includes(uncertainIntent.intentId));
    assert.equal(requests.length, 2); assert.equal(await adapter.reconcile(uncertainIntent), null);
    assert.deepEqual(await storage.store.load(asModel(WORK_DISPATCH_MODEL), asId(uncertainIntent.intentId)), held);
    assert.deepEqual(await storage.store.outboxPending(), [uncertainIntent]);
  } finally {
    await worker?.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
