import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationEnvelope } from '@canlang/contracts';
import { createMemoryIdentityStore } from '@canlang/identity/testing';
import { resolveIdentity } from '@canlang/identity';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { associationRowId, readAssociationRow, readReceiptRow, RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL } from '@canlang/state/receipt/tables';
import { FIXED_NOW, asId, asModel, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { decodeValue } from '@canlang/values';
import { observeSelectedReceipt } from '@canlang/work/observation/observation';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker, type MutationOutcome } from '@canlang/cloudflare/worker/assembly';

const APP = 'TypedGenerationProgress';
const MODEL = asModel(`${APP}.Job`);
const fixturePath = resolve('packages/cloudflare/test/fixtures/typed-generation-progress.json');
function committed(outcome: MutationOutcome) {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, 'committed');
  return outcome.result;
}

test('compiled generation freezes the source request and pending association in native D1', async () => {
  // Identity is explicitly memory-backed; the canonical effects use native D1.
  // This prefix does not qualify provider generation, progress or notifications.
  const identities = createMemoryIdentityStore({ clock: { nowMs: () => FIXED_NOW } });
  const user = await identities.createUser({ email: 'generation@example.test', password_hash: 'unused', email_verified: true });
  const team = await identities.createTeam({ timezone: 'UTC' });
  const membership = await identities.createMembership({ user_id: user.user_id, team_id: team.team_id, is_owner: true, roles: [] });
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
  const dir = await mkdtemp(join(tmpdir(), 'can-generation-prefix-'));
  const worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'typed-generation-progress' }, d1Persist: join(dir, 'd1') });
  try {
    const database = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(database);
    const store = createD1Storage(database);
    const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => FIXED_NOW,
      selectedReceiptObserver: { observeSelectedReceipt: (input: unknown) =>
        observeSelectedReceipt(input as Parameters<typeof observeSelectedReceipt>[0]) } });
    let sequence = 0;
    const envelope = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
      operation: `${APP}.${operation}`, operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)), inputs,
    });
    const created = committed(await invoker.invokeMutation(envelope('Job.create', {}), identity)).result as { id: string; version: number };
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
    const unassociated = await readReceipt(['result.content']);
    assert.equal(readBody(unassociated)['outcome'], 'null-association');
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
    await identities.removeMembership(membership.membership_id);
    const revokedRead = await readReceipt(['result.content']);
    assert.ok('error' in revokedRead || readBody(revokedRead)['outcome'] === 'denied', JSON.stringify(revokedRead));
    assert.ok('error' in await visible(2));
  } finally {
    await worker.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
