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
import type { HandlerContext } from './context.js';
import { send } from '@canlang/cloudflare/runtime/stdlib';
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

test('bound send refuses an unsupported dispatch guard without evaluating it', async () => {
  let evaluations = 0;
  // Refusal must precede any context/transaction access: this is a direct
  // helper refusal witness, not qualification of a dispatched predicate.
  const context = new Proxy({} as HandlerContext, {
    get() { throw new Error('unsupported guard accessed the execution context'); },
  });
  await assert.rejects(send(context, 'std.EmailV1.send', {}, {
    binding: 'TypedDurableSend.Mail',
    when: () => { evaluations++; return false; },
  }), /unsupported\(send\): dispatch guards require current-state dispatch qualification/);
  assert.equal(evaluations, 0);
});

test('compiled bound send joins D1 mutation rollback and replays one durable request after reopening', async () => {
  const app = 'TypedDurableSend';
  const model = asModel(`${app}.Entry`);
  const path = resolve('packages/cloudflare/test/fixtures/typed-durable-send.json');
  const artifact = JSON.parse(await readFile(path, 'utf8')) as CompileArtifact;
  const { WORK_DISPATCH_MODEL, dispatchByStateQuery } = await import('@canlang/work/kernel/tables');
  // These identities reuse the explicit memory membership seam; effects and
  // positive/negative receipts below use the actual canonical D1 store.
  const memberships = createMemoryIdentityStore();
  const owner = await seedMember(memberships, { isOwner: true });
  const identity = makeIdentity({ membership: owner.membership, email: owner.user.email });
  const request = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
    operation: `${app}.${operation}`, inputs,
    operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)),
  });
  const receiptIdentity = (input: MutationEnvelope) => ({ app,
    owner: owner.team.team_id, principal: owner.user.user_id,
    operation: asOperation(input.operation), operationId: asOperationId(input.operation_id),
  });
  const dir = await mkdtemp(join(tmpdir(), 'can-durable-send-'));
  let d1: Awaited<ReturnType<typeof openD1>> | undefined;
  try {
    const asm = await assembleModules({ artifact, sourcePath: path }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    d1 = await openD1(join(dir, 'd1'));
    const invoker = buildInvoker(artifact, asm, d1.store, { memberships, now: () => FIXED_NOW });
    const create = request('Entry.create', {});
    const born = committed(await invoker.invokeMutation(create, identity));
    const row = born.result as { id: string; version: number; data: Record<string, unknown> };
    assert.deepEqual(row.data, { count: '0' });
    const inputs = { entry: { id: row.id, version: '1' }, to: 'recipient@example.com' };
    const rollback = request('deliver', { ...inputs, accept: false });
    const original = await d1.store.load(model, asId(row.id));
    const originalHistory = await d1.store.historyFor(model, asId(row.id));
    const rollbackOutcome = await invoker.invokeMutation(rollback, identity);
    assert.ok('error' in rollbackOutcome && rollbackOutcome.error.code === 'rule_failed', JSON.stringify(rollbackOutcome));
    const failure = rejected(rollbackOutcome, 'rule_failed');
    assert.deepEqual(await d1.store.load(model, asId(row.id)), original);
    assert.deepEqual(await d1.store.historyFor(model, asId(row.id)), originalHistory);
    assert.deepEqual(await d1.store.outboxPending(), []);
    assert.deepEqual(await d1.store.query(dispatchByStateQuery('pending')), []);
    assert.equal((await d1.store.readReceipt(receiptIdentity(rollback)))?.outcome.status, 'rejected');

    const deliver = request('deliver', { ...inputs, accept: true });
    assert.equal(committed(await invoker.invokeMutation(deliver, identity)).result, '1');
    const pending = await d1.store.outboxPending();
    assert.equal(pending.length, 1);
    const intent = pending[0]!;
    assert.equal(intent.operation, deliver.operation);
    assert.equal(intent.operationId, deliver.operation_id);
    assert.equal(intent.target, 'std.EmailV1.send');
    assert.equal(intent.occurrenceIndex, 0);
    assert.deepEqual(intent.arguments, {
      binding: 'TypedDurableSend.Mail', from: 'deployment.mail',
      arguments: { to: 'recipient@example.com', subject: 'Actual send', body: 'Durable request', attachments: [] },
    });
    const dispatch = await d1.store.load(WORK_DISPATCH_MODEL, asId(intent.intentId));
    assert.ok(dispatch);
    assert.equal(dispatch.data['operationId'], deliver.operation_id);
    assert.equal(dispatch.data['source'], 'std.EmailV1.send');
    assert.equal(dispatch.data['occurrenceIndex'], 0);
    assert.deepEqual(await d1.store.query(dispatchByStateQuery('pending')), [dispatch]);
    const live = await d1.store.load(model, asId(row.id));
    assert.equal(live?.version, 2);
    assert.deepEqual(live?.data, { count: '1' });
    const history = await d1.store.historyFor(model, asId(row.id));
    const revision = await d1.store.readRevision();
    const receipts = await Promise.all([deliver, rollback].map((input) => d1!.store.readReceipt(receiptIdentity(input))));
    assert.equal(committed(await invoker.invokeMutation(deliver, identity), 'replayed').result, '1');
    assert.deepEqual(await d1.store.outboxPending(), pending);
    assert.equal(await d1.store.readRevision(), revision);

    await d1.worker.dispose();
    d1 = undefined;
    d1 = await openD1(join(dir, 'd1'));
    const reopened = buildInvoker(artifact, asm, d1.store, { memberships, now: () => FIXED_NOW });
    assert.equal(committed(await reopened.invokeMutation(deliver, identity), 'replayed').result, '1');
    assert.equal(rejected(await reopened.invokeMutation(rollback, identity), 'rule_failed').message, failure.message);
    assert.deepEqual(await d1.store.load(model, asId(row.id)), live);
    assert.deepEqual(await d1.store.historyFor(model, asId(row.id)), history);
    assert.deepEqual(await d1.store.outboxPending(), pending);
    assert.deepEqual(await d1.store.load(WORK_DISPATCH_MODEL, asId(intent.intentId)), dispatch);
    assert.deepEqual(await Promise.all([deliver, rollback].map((input) => d1!.store.readReceipt(receiptIdentity(input)))), receipts);
    assert.equal(await d1.store.readRevision(), revision);
  } finally {
    await d1?.worker.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('compiled record-key schedules replace and cancel atomically and survive D1 replay and reopening', async () => {
  const app = 'TypedKeyedSchedule';
  const model = asModel(`${app}.Entry`);
  const path = resolve('packages/cloudflare/test/fixtures/typed-keyed-schedule.json');
  const artifact = JSON.parse(await readFile(path, 'utf8')) as CompileArtifact;
  const { scheduleByKeyQuery } = await import('@canlang/work/kernel/tables');
  const memberships = createMemoryIdentityStore();
  const owner = await seedMember(memberships, { isOwner: true });
  const identity = makeIdentity({ membership: owner.membership, email: owner.user.email });
  const scope = { app, owner: owner.team.team_id, ownerPackage: app };
  const request = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
    operation: `${app}.${operation}`, inputs,
    operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)),
  });
  const receiptIdentity = (input: MutationEnvelope) => ({ app,
    owner: owner.team.team_id, principal: owner.user.user_id,
    operation: asOperation(input.operation), operationId: asOperationId(input.operation_id),
  });
  const dir = await mkdtemp(join(tmpdir(), 'can-keyed-schedule-'));
  let d1: Awaited<ReturnType<typeof openD1>> | undefined;
  try {
    const asm = await assembleModules({ artifact, sourcePath: path }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    d1 = await openD1(join(dir, 'd1'));
    const invoker = buildInvoker(artifact, asm, d1.store, { memberships, now: () => FIXED_NOW });
    const born = committed(await invoker.invokeMutation(request('Entry.create', { label: 'timer' }), identity));
    const row = born.result as { id: string; version: number; data: Record<string, unknown> };
    const ref = (version: number) => ({ id: row.id, version: String(version) });
    const firstAt = FIXED_NOW + 60_000;
    const secondAt = firstAt + 60_000;
    const arm = request('arm', { entry: ref(1), at: new Date(firstAt).toISOString(), accept: true });
    assert.equal(committed(await invoker.invokeMutation(arm, identity)).result, '1');
    const firstRows = await d1.store.query(scheduleByKeyQuery(scope, row.id));
    assert.equal(firstRows.length, 1);
    const first = firstRows[0]!;
    assert.equal(first.data['state'], 'pending');
    assert.equal(first.data['event'], `${app}.Due`);
    assert.equal(first.data['at'], firstAt);
    assert.deepEqual(first.data['payload'], { entry: { id: row.id, version: '2' } });
    assert.equal(first.data['scopeApp'], app);
    assert.equal(first.data['scopeOwner'], owner.team.team_id);
    assert.equal(first.data['scopeOwnerPackage'], app);
    const firstDue = await d1.store.schedulesDue(firstAt, 10);
    assert.equal(firstDue.length, 1);
    assert.equal(firstDue[0]!.event, `${app}.Due`);
    assert.equal(firstDue[0]!.at, firstAt);
    assert.deepEqual(firstDue[0]!.payload, first.data['payload']);
    const storedKey = firstDue[0]!.key;
    const firstLive = await d1.store.load(model, asId(row.id));
    assert.equal(firstLive?.version, 2);

    const failedArm = request('arm', { entry: ref(2), at: new Date(secondAt).toISOString(), accept: false });
    const armFailure = rejected(await invoker.invokeMutation(failedArm, identity), 'rule_failed');
    assert.deepEqual(await d1.store.query(scheduleByKeyQuery(scope, row.id)), firstRows);
    assert.deepEqual(await d1.store.schedulesDue(firstAt, 10), firstDue);
    assert.deepEqual(await d1.store.load(model, asId(row.id)), firstLive);

    const replace = request('arm', { entry: ref(2), at: new Date(secondAt).toISOString(), accept: true });
    assert.equal(committed(await invoker.invokeMutation(replace, identity)).result, '2');
    const replacedRows = await d1.store.query(scheduleByKeyQuery(scope, row.id));
    assert.equal(replacedRows.length, 2);
    const old = replacedRows.find((entry) => entry.id === first.id)!;
    const pending = replacedRows.find((entry) => entry.id !== first.id)!;
    assert.equal(old.data['state'], 'superseded');
    assert.equal(pending.data['state'], 'pending');
    assert.equal(pending.data['replaces'], first.id);
    assert.notEqual(pending.id, first.id);
    assert.equal(pending.data['at'], secondAt);
    assert.deepEqual(pending.data['payload'], { entry: { id: row.id, version: '3' } });
    assert.deepEqual(await d1.store.schedulesDue(firstAt, 10), []);
    const secondDue = await d1.store.schedulesDue(secondAt, 10);
    assert.equal(secondDue.length, 1);
    assert.equal(secondDue[0]!.key, storedKey);
    const replacementRevision = await d1.store.readRevision();
    assert.equal(committed(await invoker.invokeMutation(replace, identity), 'replayed').result, '2');
    assert.equal(await d1.store.readRevision(), replacementRevision);
    assert.deepEqual(await d1.store.query(scheduleByKeyQuery(scope, row.id)), replacedRows);

    const failedStop = request('stop', { entry: ref(3), accept: false });
    const stopFailure = rejected(await invoker.invokeMutation(failedStop, identity), 'rule_failed');
    assert.deepEqual(await d1.store.query(scheduleByKeyQuery(scope, row.id)), replacedRows);
    assert.deepEqual(await d1.store.schedulesDue(secondAt, 10), secondDue);
    const stop = request('stop', { entry: ref(3), accept: true });
    assert.equal(committed(await invoker.invokeMutation(stop, identity)).result, '3');
    assert.equal(await d1.store.scheduleGet(storedKey), null);
    assert.deepEqual(await d1.store.schedulesDue(secondAt, 10), []);
    const cancelledRows = await d1.store.query(scheduleByKeyQuery(scope, row.id));
    assert.equal(cancelledRows.find((entry) => entry.id === pending.id)?.data['state'], 'cancelled');
    assert.equal(cancelledRows.find((entry) => entry.id === first.id)?.data['state'], 'superseded');
    const live = await d1.store.load(model, asId(row.id));
    assert.equal(live?.version, 4);
    assert.deepEqual(live?.data, { label: 'timer', eligible: false, fired: '0', observedVersion: '0' });
    const history = await d1.store.historyFor(model, asId(row.id));
    assert.deepEqual(history.map((entry) => entry.version), [1, 2, 3, 4]);
    const revision = await d1.store.readRevision();
    const requests = [arm, replace, stop, failedArm, failedStop];
    const receipts = await Promise.all(requests.map((input) => d1!.store.readReceipt(receiptIdentity(input))));
    await d1.worker.dispose();
    d1 = undefined;
    d1 = await openD1(join(dir, 'd1'));
    const reopened = buildInvoker(artifact, asm, d1.store, { memberships, now: () => FIXED_NOW });
    assert.equal(committed(await reopened.invokeMutation(arm, identity), 'replayed').result, '1');
    assert.equal(committed(await reopened.invokeMutation(replace, identity), 'replayed').result, '2');
    assert.equal(committed(await reopened.invokeMutation(stop, identity), 'replayed').result, '3');
    assert.equal(rejected(await reopened.invokeMutation(failedArm, identity), 'rule_failed').message, armFailure.message);
    assert.equal(rejected(await reopened.invokeMutation(failedStop, identity), 'rule_failed').message, stopFailure.message);
    assert.deepEqual(await d1.store.load(model, asId(row.id)), live);
    assert.deepEqual(await d1.store.historyFor(model, asId(row.id)), history);
    assert.deepEqual(await d1.store.query(scheduleByKeyQuery(scope, row.id)), cancelledRows);
    assert.equal(await d1.store.scheduleGet(storedKey), null);
    assert.deepEqual(await d1.store.outboxPending(), []);
    assert.deepEqual(await Promise.all(requests.map((input) => d1!.store.readReceipt(receiptIdentity(input)))), receipts);
    assert.equal(await d1.store.readRevision(), revision);
    // This case qualifies keyed staging only. The authored fire handler is
    // not invoked without an owning verified due-head admission/consume port.
  } finally {
    await d1?.worker.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
