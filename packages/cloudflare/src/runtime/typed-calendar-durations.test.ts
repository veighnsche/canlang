import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationEnvelope } from '@canlang/contracts';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import {
  FIXED_NOW, asId, asModel, asOperation, asOperationId, createMemoryIdentityStore,
  makeIdentity, seedMember, uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker, type MutationOutcome } from '@canlang/cloudflare/worker/assembly';

const APP = 'TypedCalendarDurations';
const MODEL = asModel(`${APP}.Span`);
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
function rejected(outcome: MutationOutcome, code?: string) {
  assert.ok('error' in outcome, JSON.stringify(outcome));
  if (code !== undefined) assert.equal(outcome.error.code, code);
  return outcome.error;
}

test('compiled calendar dates and durations preserve native arithmetic, wire values and rollback', async () => {
  const path = resolve('packages/cloudflare/test/fixtures/typed-calendar-durations.json');
  const artifact = JSON.parse(await readFile(path, 'utf8')) as CompileArtifact;
  for (const [name, type] of [['advance', 'date'], ['elapsed', 'duration'], ['days', 'date[]'],
    ['durations', 'duration[]'], ['maybeDay', 'date?'], ['maybeElapsed', 'duration?'],
    ['maybeDays', 'date[]?'], ['maybeDurations', 'duration[]?']]) {
    assert.deepEqual(artifact.operations!.find((operation) => operation.name === `${APP}.${name}`)?.result, { type });
  }
  assert.equal(artifact.models!.find((model) => model.name === MODEL)!.fields.find((field) => field.name === 'day')?.valueType, 'date');
  const dir = await mkdtemp(join(tmpdir(), 'can-calendar-durations-'));
  // This profile uses canonical memory State and makes no additional persistence claim.
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ membership: member.membership, email: member.user.email });
  try {
    const asm = await assembleModules({ artifact, sourcePath: path }, {
      workDir: dir, stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    const invoker = buildInvoker(artifact, asm, store, { memberships, now: () => FIXED_NOW });
    const create = envelope('Span.create', {});
    const born = committed(await invoker.invokeMutation(create, identity));
    const row = born.result as { id: string; data: Record<string, unknown> };
    assert.deepEqual(row.data, {
      day: '2028-02-28', elapsed: '1', days: [], durations: [], seedDays: ['2028-02-28'],
      seedDurations: ['1', '1000'], maybeDay: null, maybeElapsed: null, maybeDays: null, maybeDurations: null,
    });
    const ref = (version: number) => ({ id: row.id, version: String(version) });
    const receiptIdentity = (request: MutationEnvelope) => ({ app: APP,
      owner: identity.team!.team_id, principal: identity.actor!.user_id,
      operation: asOperation(request.operation), operationId: asOperationId(request.operation_id) });
    const createReceipt = await store.readReceipt(receiptIdentity(create));
    assert.equal(createReceipt?.resolvedDefaults['day'], '2028-02-28');
    assert.equal(createReceipt?.resolvedDefaults['elapsed'], '1');
    assert.deepEqual(createReceipt?.resolvedDefaults['seedDurations'], ['1', '1000']);
    const defaults = envelope('defaults', {});
    assert.equal(committed(await invoker.invokeMutation(defaults, identity)).result, '2001');
    const defaultReceipt = await store.readReceipt(receiptIdentity(defaults));
    assert.deepEqual(defaultReceipt?.resolvedDefaults, {
      day: '2028-02-28', delta: '1000', days: ['2028-02-28'], durations: ['1', '1000'],
    });
    assert.equal(committed(await invoker.invokeMutation(defaults, identity), 'replayed').result, '2001');
    const request = envelope('advance', { span: ref(1), day: '2028-02-28', delta: '9007199254740993',
      days: ['2028-02-28', '2028-02-29'], durations: ['2', '3'], accept: true });
    assert.equal(committed(await invoker.invokeMutation(request, identity)).result, '2028-02-29');
    assert.equal(committed(await invoker.invokeMutation(request, identity), 'replayed').result, '2028-02-29');
    const advanced = await store.load(MODEL, asId(row.id));
    assert.equal(advanced?.version, 2);
    assert.equal(advanced?.data['day'], '2028-02-29');
    assert.equal(advanced?.data['elapsed'], '9007199254742000');
    assert.equal(committed(await invoker.invokeMutation(envelope('elapsed', { span: ref(2) }), identity)).result, '9007199254742000');
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('days', { span: ref(2) }), identity)).result, ['2028-02-28', '2028-02-29']);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('durations', { span: ref(2) }), identity)).result, ['5', '9007199254742000']);
    assert.equal(committed(await invoker.invokeMutation(envelope('optional', {
      span: ref(2), day: '2028-03-01', elapsed: '9', days: ['2028-03-02'], durations: ['10', '11'],
    }), identity)).result, '9');
    assert.equal(committed(await invoker.invokeMutation(envelope('maybeDay', { span: ref(3) }), identity)).result, '2028-03-01');
    assert.equal(committed(await invoker.invokeMutation(envelope('maybeElapsed', { span: ref(3) }), identity)).result, '9');
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('maybeDays', { span: ref(3) }), identity)).result, ['2028-03-02']);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('maybeDurations', { span: ref(3) }), identity)).result, ['10', '11']);
    assert.equal(committed(await invoker.invokeMutation(envelope('optional', { span: ref(3) }), identity)).result, null);
    for (const operation of ['maybeDay', 'maybeElapsed', 'maybeDays', 'maybeDurations']) {
      assert.equal(committed(await invoker.invokeMutation(envelope(operation, { span: ref(4) }), identity)).result, null);
    }
    const beforePartial = await store.load(MODEL, asId(row.id));
    committed(await invoker.invokeMutation(envelope('Span.update', { record: ref(4), elapsed: '7' }), identity));
    const stored = await store.load(MODEL, asId(row.id));
    assert.equal(stored?.version, 5);
    assert.deepEqual(stored?.data, { ...beforePartial?.data, elapsed: '7' });
    const history = await store.historyFor(MODEL, asId(row.id));
    const validInputs = { span: ref(5), day: '2028-03-01', delta: '1', days: [], durations: [], accept: true };
    for (const bad of [{ day: '2027-02-29' }, { day: '2028-2-29' }, { delta: 1 }, { delta: '1s' },
      { delta: '1.5' }, { delta: '9223372036854775808' }, { days: ['2028-02-30'] }, { durations: [1] }]) {
      rejected(await invoker.invokeMutation(envelope('advance', { ...validInputs, ...bad }), identity), 'validation');
    }
    for (const bad of [{ day: '2028-02-30' }, { elapsed: 1 }, { durations: ['1s'] }]) {
      rejected(await invoker.invokeMutation(envelope('Span.update', { record: ref(5), ...bad }), identity), 'validation');
    }
    rejected(await invoker.invokeMutation(envelope('advance', { ...validInputs, accept: false }), identity));
    assert.deepEqual(await store.load(MODEL, asId(row.id)), stored);
    assert.deepEqual(await store.historyFor(MODEL, asId(row.id)), history);
    assert.doesNotThrow(() => JSON.stringify([createReceipt, defaultReceipt, stored, history]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function openD1(dir: string) {
  const worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'typed-calendar-durations' }, d1Persist: dir });
  try {
    const database = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(database);
    return { worker, store: createD1Storage(database) };
  } catch (error) {
    try { await worker.dispose(); } catch { /* Preserve the acquisition failure. */ }
    throw error;
  }
}

test('compiled calendar date and duration D1 lifecycle persists values, rollback and reopened replay', async () => {
  const path = resolve('packages/cloudflare/test/fixtures/typed-calendar-durations.json');
  const artifact = JSON.parse(await readFile(path, 'utf8')) as CompileArtifact;
  const dir = await mkdtemp(join(tmpdir(), 'can-calendar-durations-d1-'));
  let d1: Awaited<ReturnType<typeof openD1>> | undefined;
  // Membership/identity are fixtures; persisted rows, history and receipts use actual D1 State.
  const memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ membership: member.membership, email: member.user.email });
  const options = { memberships, now: () => FIXED_NOW };
  const receiptIdentity = (request: MutationEnvelope) => ({ app: APP,
    owner: identity.team!.team_id, principal: identity.actor!.user_id,
    operation: asOperation(request.operation), operationId: asOperationId(request.operation_id) });
  try {
    const asm = await assembleModules({ artifact, sourcePath: path }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    d1 = await openD1(join(dir, 'd1'));
    const invoker = buildInvoker(artifact, asm, d1.store, options);
    const create = envelope('Span.create', {});
    const born = committed(await invoker.invokeMutation(create, identity));
    const row = born.result as { id: string; data: Record<string, unknown> };
    const initialData = {
      day: '2028-02-28', elapsed: '1', days: [], durations: [], seedDays: ['2028-02-28'],
      seedDurations: ['1', '1000'], maybeDay: null, maybeElapsed: null, maybeDays: null, maybeDurations: null,
    };
    assert.deepEqual(row.data, initialData);
    assert.deepEqual((await d1.store.load(MODEL, asId(row.id)))?.data, initialData);
    const createReceipt = await d1.store.readReceipt(receiptIdentity(create));
    assert.ok(createReceipt !== null);
    for (const field of ['day', 'elapsed', 'seedDays', 'seedDurations',
      'maybeDay', 'maybeElapsed', 'maybeDays', 'maybeDurations'] as const) {
      assert.deepEqual(createReceipt.resolvedDefaults[field], initialData[field]);
    }
    const defaults = envelope('defaults', {});
    assert.equal(committed(await invoker.invokeMutation(defaults, identity)).result, '2001');
    const defaultReceipt = await d1.store.readReceipt(receiptIdentity(defaults));
    assert.deepEqual(defaultReceipt?.resolvedDefaults, {
      day: '2028-02-28', delta: '1000', days: ['2028-02-28'], durations: ['1', '1000'],
    });
    const ref = (version: number) => ({ id: row.id, version: String(version) });
    const advance = envelope('advance', { span: ref(1), day: '2028-02-28', delta: '9007199254740993',
      days: ['2028-02-28', '2028-02-29'], durations: ['2', '3'], accept: true });
    assert.equal(committed(await invoker.invokeMutation(advance, identity)).result, '2028-02-29');
    const advanced = await d1.store.load(MODEL, asId(row.id));
    assert.equal(advanced?.version, 2);
    assert.deepEqual(advanced?.data, { ...initialData, day: '2028-02-29', elapsed: '9007199254742000',
      days: ['2028-02-28', '2028-02-29'], durations: ['2', '3'] });
    const firstHistory = await d1.store.historyFor(MODEL, asId(row.id));
    const firstRevision = await d1.store.readRevision();
    assert.equal(committed(await invoker.invokeMutation(advance, identity), 'replayed').result, '2028-02-29');
    assert.equal(await d1.store.readRevision(), firstRevision);
    assert.deepEqual(await d1.store.load(MODEL, asId(row.id)), advanced);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), firstHistory);
    const optional = envelope('optional', { span: ref(2), day: '2028-03-01', elapsed: '9007199254740993',
      days: ['2028-03-02'], durations: ['9007199254740993', '11'] });
    assert.equal(committed(await invoker.invokeMutation(optional, identity)).result, '9007199254740993');
    const populated = await d1.store.load(MODEL, asId(row.id));
    assert.deepEqual(populated?.data, { ...advanced?.data, maybeDay: '2028-03-01', maybeElapsed: '9007199254740993',
      maybeDays: ['2028-03-02'], maybeDurations: ['9007199254740993', '11'] });
    const partial = envelope('Span.update', { record: ref(3), elapsed: '9007199254742001' });
    committed(await invoker.invokeMutation(partial, identity));
    assert.deepEqual((await d1.store.load(MODEL, asId(row.id)))?.data, {
      ...populated?.data, elapsed: '9007199254742001',
    });
    const clear = envelope('optional', { span: ref(4) });
    assert.equal(committed(await invoker.invokeMutation(clear, identity)).result, null);
    const clearReceipt = await d1.store.readReceipt(receiptIdentity(clear));
    assert.deepEqual(clearReceipt?.resolvedDefaults, { day: null, elapsed: null, days: null, durations: null });
    const stored = await d1.store.load(MODEL, asId(row.id));
    assert.equal(stored?.version, 5);
    assert.deepEqual(stored?.data, { ...advanced?.data, elapsed: '9007199254742001' });
    const history = await d1.store.historyFor(MODEL, asId(row.id));
    const rows = await d1.store.query({ model: MODEL, authority: 'owner' });
    const rollback = envelope('advance', { span: ref(5), day: '2028-03-01', delta: '1',
      days: ['2028-03-01'], durations: ['8'], accept: false });
    const rollbackError = rejected(await invoker.invokeMutation(rollback, identity));
    const rollbackReceipt = await d1.store.readReceipt(receiptIdentity(rollback));
    assert.equal(rollbackReceipt?.outcome.status, 'rejected');
    assert.deepEqual(await d1.store.load(MODEL, asId(row.id)), stored);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), history);
    for (const bad of [{ day: '2027-02-29' }, { day: '2028-2-29' }, { elapsed: 1 }, { elapsed: '1s' },
      { elapsed: '1.5' }, { elapsed: '9223372036854775808' }, { days: ['2028-02-30'] }, { durations: [1] },
      { maybeDay: '2028-02-30' }, { maybeElapsed: '1s' }, { maybeDays: ['not-a-date'] }, { maybeDurations: ['1.5'] }]) {
      rejected(await invoker.invokeMutation(envelope('Span.create', bad), identity), 'validation');
      rejected(await invoker.invokeMutation(envelope('Span.update', { record: ref(5), ...bad }), identity), 'validation');
    }
    assert.deepEqual(await d1.store.query({ model: MODEL, authority: 'owner' }), rows);
    assert.deepEqual(await d1.store.load(MODEL, asId(row.id)), stored);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), history);

    await d1.worker.dispose();
    d1 = undefined;
    d1 = await openD1(join(dir, 'd1'));
    const reopened = buildInvoker(artifact, asm, d1.store, options);
    assert.deepEqual(await d1.store.load(MODEL, asId(row.id)), stored);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), history);
    assert.deepEqual(await d1.store.readReceipt(receiptIdentity(create)), createReceipt);
    assert.deepEqual(await d1.store.readReceipt(receiptIdentity(defaults)), defaultReceipt);
    assert.deepEqual(await d1.store.readReceipt(receiptIdentity(clear)), clearReceipt);
    assert.deepEqual(await d1.store.readReceipt(receiptIdentity(rollback)), rollbackReceipt);
    assert.equal(committed(await reopened.invokeMutation(envelope('elapsed', { span: ref(5) }), identity)).result,
      '9007199254742001');
    assert.deepEqual(committed(await reopened.invokeMutation(envelope('days', { span: ref(5) }), identity)).result,
      ['2028-02-28', '2028-02-29']);
    assert.deepEqual(committed(await reopened.invokeMutation(envelope('durations', { span: ref(5) }), identity)).result,
      ['5', '9007199254742001']);
    for (const operation of ['maybeDay', 'maybeElapsed', 'maybeDays', 'maybeDurations']) {
      assert.equal(committed(await reopened.invokeMutation(envelope(operation, { span: ref(5) }), identity)).result, null);
    }
    const revision = await d1.store.readRevision();
    assert.deepEqual(committed(await reopened.invokeMutation(create, identity), 'replayed').result, born.result);
    assert.equal(committed(await reopened.invokeMutation(advance, identity), 'replayed').result, '2028-02-29');
    assert.equal(committed(await reopened.invokeMutation(optional, identity), 'replayed').result, '9007199254740993');
    committed(await reopened.invokeMutation(partial, identity), 'replayed');
    assert.equal(committed(await reopened.invokeMutation(clear, identity), 'replayed').result, null);
    assert.equal(committed(await reopened.invokeMutation(defaults, identity), 'replayed').result, '2001');
    assert.deepEqual(rejected(await reopened.invokeMutation(rollback, identity)), rollbackError);
    assert.equal(await d1.store.readRevision(), revision);
    assert.deepEqual(await d1.store.query({ model: MODEL, authority: 'owner' }), rows);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), history);
  } finally {
    try { await d1?.worker.dispose(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
});
