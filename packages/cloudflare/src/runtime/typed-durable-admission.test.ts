import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationEnvelope } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import {
  FIXED_NOW, asId, asModel, asOperation, asOperationId, createMemoryIdentityStore,
  makeIdentity, seedMember, uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker, type MutationOutcome } from '@canlang/cloudflare/worker/assembly';

const APP = 'TypedDurableAdmission';
const MODEL = asModel(`${APP}.Entry`);
const fixturePath = resolve('packages/cloudflare/test/fixtures/typed-durable-admission.json');
let sequence = 0;
function envelope(operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope {
  return { operation: `${APP}.${operation}`, inputs,
    operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)) };
}
function committed(outcome: MutationOutcome, status = 'committed') {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, status);
  return outcome.result;
}
function rejected(outcome: MutationOutcome, code: string) {
  assert.ok('error' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.error.code, code);
  return outcome.error;
}
async function openD1(persistDir: string) {
  const worker = new Miniflare({
    compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'typed-durable-admission' }, d1Persist: persistDir,
  });
  try {
    const database = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(database);
    return { worker, store: createD1Storage(database) };
  } catch (error) {
    try { await worker.dispose(); } catch { /* Preserve the acquisition failure. */ }
    throw error;
  }
}

test('compiled owner admission, managed defaults and positive/negative receipts survive D1 reopening', async () => {
  const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
  const model = artifact.models!.find((model) => model.name === MODEL)!;
  assert.equal(model.fields.find((field) => field.name === 'label')?.required, true);
  const stamp = model.fields.find((field) => field.name === 'stamp')!;
  assert.equal(stamp.serverOnly, true);
  assert.deepEqual(stamp.default, { kind: 'server', init: 'now' });
  assert.equal(artifact.operations!.find((operation) => operation.name === `${APP}.Entry.create`)!
    .inputs.fields.some((field) => field.name === 'stamp'), false);

  // Membership/identity are explicit memory fixtures. Owner is a live role in this
  // one State store; this case makes no cross-store or tenant-partition claim.
  const memberships = createMemoryIdentityStore();
  const owner = await seedMember(memberships, { isOwner: true });
  const member = await seedMember(memberships, { teamId: owner.team.team_id, isOwner: false });
  const identity = makeIdentity({ membership: owner.membership, email: owner.user.email });
  const staleOwnerSnapshot = makeIdentity({ membership: { ...owner.membership, is_owner: false },
    email: owner.user.email });
  const nonOwner = makeIdentity({ membership: member.membership, email: member.user.email });
  const wrongActor = makeIdentity({ userId: 'unrelated-actor', team: owner.team, membership: owner.membership });
  const anonymous = makeIdentity({ actor: null, team: owner.team, membership: null });
  const receiptIdentity = (request: MutationEnvelope) => ({ app: APP,
    owner: owner.team.team_id, principal: owner.user.user_id,
    operation: asOperation(request.operation), operationId: asOperationId(request.operation_id) });
  const dir = await mkdtemp(join(tmpdir(), 'can-durable-admission-'));
  let d1: Awaited<ReturnType<typeof openD1>> | undefined;
  try {
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    d1 = await openD1(join(dir, 'd1'));
    const invoker = buildInvoker(artifact, asm, d1.store, { memberships, now: () => FIXED_NOW });
    const emptyRevision = await d1.store.readRevision();
    // Each denied identity submits malformed/unknown data. Authorization must
    // refuse before field validation or missing-record evaluation can run.
    for (const deniedIdentity of [nonOwner, wrongActor, anonymous]) {
      rejected(await invoker.invokeMutation(envelope('Entry.create', { label: 5, unknown: true }),
        deniedIdentity), 'forbidden');
      rejected(await invoker.invokeMutation(envelope('change', { entry: null, delta: 5, accept: 'yes', unknown: true }),
        deniedIdentity), 'forbidden');
    }
    assert.equal(await d1.store.readRevision(), emptyRevision);

    // The carried owner snapshot says false; current membership is authoritative.
    const create = envelope('Entry.create', { label: 'durable' });
    const born = committed(await invoker.invokeMutation(create, staleOwnerSnapshot));
    const row = born.result as { id: string; version: number; created: number; updated: number;
      createdBy: string; updatedBy: string; archivedAt: number | null; data: Record<string, unknown> };
    assert.equal(row.id, create.operation_id);
    assert.equal(row.version, 1);
    assert.equal(row.created, FIXED_NOW);
    assert.equal(row.updated, FIXED_NOW);
    assert.equal(row.createdBy, owner.user.user_id);
    assert.equal(row.updatedBy, owner.user.user_id);
    assert.equal(row.archivedAt, null);
    assert.deepEqual(row.data, { label: 'durable', count: '1', stamp: new Date(FIXED_NOW).toISOString() });
    const createReceipt = await d1.store.readReceipt(receiptIdentity(create));
    assert.equal(createReceipt?.resolvedDefaults['count'], '1');
    assert.equal(createReceipt?.resolvedDefaults['stamp'], row.data['stamp']);
    const ref = (version: number) => ({ id: row.id, version: String(version) });

    const read = await invoker.invokeRead({ operation: `${APP}.Entry.read`, inputs: {} }, anonymous);
    assert.ok('result' in read, JSON.stringify(read));
    const visible = read.result as { records: Array<{ id: string; data: Record<string, unknown> }> };
    assert.equal(visible.records.length, 1);
    assert.deepEqual(visible.records[0]?.data, row.data);

    const beforeInvalid = await d1.store.readRevision();
    for (const field of ['stamp', 'id', 'version', 'created', 'updated', 'created_by', 'updated_by', 'archived_at', 'unknown']) {
      rejected(await invoker.invokeMutation(envelope('Entry.create', { label: 'forged', [field]: 'forged' }), identity), 'validation');
      rejected(await invoker.invokeMutation(envelope('Entry.update', { record: ref(1), [field]: 'forged' }), identity), 'validation');
    }
    rejected(await invoker.invokeMutation(envelope('Entry.create', {}), identity), 'validation');
    assert.equal(await d1.store.readRevision(), beforeInvalid);
    assert.deepEqual(await d1.store.load(MODEL, asId(row.id)), row);

    // Successful native stamp/managed created equality and count arithmetic.
    const change = envelope('change', { entry: ref(1), delta: '2', accept: true });
    const changed = committed(await invoker.invokeMutation(change, identity));
    assert.equal(changed.result, '3');
    const live = await d1.store.load(MODEL, asId(row.id));
    assert.equal(live?.version, 2);
    assert.deepEqual(live?.data, { ...row.data, count: '3' });
    const history = await d1.store.historyFor(MODEL, asId(row.id));
    assert.deepEqual(history.map((entry) => entry.version), [1, 2]);
    rejected(await invoker.invokeMutation(envelope('change', { entry: ref(1), delta: '1', accept: true }), identity), 'conflict');
    rejected(await invoker.invokeMutation({ ...change, inputs: { ...change.inputs, delta: '4' } }, identity), 'conflict');

    const rollback = envelope('change', { entry: ref(2), delta: '10', accept: false });
    const beforeRollbackRevision = await d1.store.readRevision();
    const failed = rejected(await invoker.invokeMutation(rollback, identity), 'rule_failed');
    assert.deepEqual(await d1.store.load(MODEL, asId(row.id)), live);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), history);
    assert.equal(await d1.store.readRevision(), beforeRollbackRevision + 1);
    const rollbackReceipt = await d1.store.readReceipt(receiptIdentity(rollback));
    assert.deepEqual(rollbackReceipt?.outcome, { status: 'rejected', code: failed.code, message: failed.message });
    assert.equal(rollbackReceipt?.committedRevision, beforeRollbackRevision + 1);
    assert.deepEqual(rollbackReceipt?.resolvedDefaults, {});

    const revision = await d1.store.readRevision();
    const receipts = await Promise.all([create, change, rollback].map((request) => d1!.store.readReceipt(receiptIdentity(request))));
    await d1.worker.dispose();
    d1 = undefined;
    d1 = await openD1(join(dir, 'd1'));
    const reopened = buildInvoker(artifact, asm, d1.store, { memberships, now: () => FIXED_NOW });
    assert.deepEqual(await d1.store.load(MODEL, asId(row.id)), live);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), history);
    assert.equal(await d1.store.readRevision(), revision);
    assert.deepEqual(await Promise.all([create, change, rollback].map((request) => d1!.store.readReceipt(receiptIdentity(request)))), receipts);
    assert.deepEqual(committed(await reopened.invokeMutation(create, identity), 'replayed').result, born.result);
    assert.equal(committed(await reopened.invokeMutation(change, identity), 'replayed').result, '3');
    const replayedFailure = rejected(await reopened.invokeMutation(rollback, identity), 'rule_failed');
    assert.equal(replayedFailure.message, failed.message);
    assert.deepEqual(await d1.store.load(MODEL, asId(row.id)), live);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), history);
    assert.equal(await d1.store.readRevision(), revision);
    assert.deepEqual(await Promise.all([create, change, rollback].map((request) => d1!.store.readReceipt(receiptIdentity(request)))), receipts);
  } finally {
    try { await d1?.worker.dispose(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
});
