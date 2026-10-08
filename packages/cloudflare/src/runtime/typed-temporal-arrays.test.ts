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

const APP = 'TypedTemporalArrays';
const MODEL = asModel(`${APP}.Slot`);
const BASE = '2030-01-01T00:00:00.000Z';
const LATER = '2030-01-02T00:00:01.000Z';
const TIMES = ['2030-01-02T01:00:00.000Z', '2030-01-03T00:00:00.000Z'];
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
function rejected(outcome: MutationOutcome) {
  assert.ok('error' in outcome, JSON.stringify(outcome));
  return outcome.error;
}
async function openD1(dir: string) {
  const worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'typed-temporal-arrays' }, d1Persist: dir });
  const database = await worker.getD1Database('DB') as unknown as D1Database;
  await ensureSchema(database);
  return { worker, store: createD1Storage(database) };
}

test('compiled native datetime and integer arrays stage wire rows, results and persisted replay', async () => {
  const path = resolve('packages/cloudflare/test/fixtures/typed-temporal-arrays.json');
  const artifact = JSON.parse(await readFile(path, 'utf8')) as CompileArtifact;
  const results = Object.fromEntries(artifact.operations!.map((operation) => [operation.name, operation.result]));
  assert.deepEqual(results[`${APP}.advance`], { type: 'datetime' });
  assert.deepEqual(results[`${APP}.numbers`], { type: 'int[]' });
  assert.deepEqual(results[`${APP}.times`], { type: 'datetime[]' });
  assert.deepEqual(results[`${APP}.maybeNumbers`], { type: 'int[]?' });
  assert.deepEqual(results[`${APP}.maybeTimes`], { type: 'datetime[]?' });
  const dir = await mkdtemp(join(tmpdir(), 'can-temporal-arrays-'));
  let d1: Awaited<ReturnType<typeof openD1>> | undefined;
  // Membership/identity are memory fixtures; durable claims concern canonical D1 State.
  const memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ membership: member.membership, email: member.user.email });
  try {
    const asm = await assembleModules({ artifact, sourcePath: path }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    d1 = await openD1(join(dir, 'd1'));
    const invoker = buildInvoker(artifact, asm, d1.store, { memberships, now: () => FIXED_NOW });
    const missing = rejected(await invoker.invokeMutation(envelope('Slot.create', {}), identity));
    assert.equal(missing.code, 'validation', JSON.stringify(missing));
    assert.deepEqual(await d1.store.query({ model: MODEL, authority: 'owner' }), []);
    const create = envelope('Slot.create', { requiredCounts: [] });
    const born = committed(await invoker.invokeMutation(create, identity));
    const row = born.result as { id: string; version: number; data: Record<string, unknown> };
    assert.deepEqual(row.data, {
      count: '1', at: BASE, counts: [], instants: [], seedCounts: ['1', '2'],
      seedInstants: [BASE], maybeCounts: null, maybeInstants: null, requiredCounts: [],
    });
    const ref = (version: number) => ({ id: row.id, version: String(version) });
    const receiptIdentity = (request: MutationEnvelope) => ({ app: APP,
      owner: identity.team!.team_id, principal: identity.actor!.user_id,
      operation: asOperation(request.operation), operationId: asOperationId(request.operation_id) });
    const receipt = await d1.store.readReceipt(receiptIdentity(create));
    assert.equal(receipt?.resolvedDefaults['at'], BASE);
    assert.deepEqual(receipt?.resolvedDefaults['seedCounts'], ['1', '2']);
    assert.deepEqual(receipt?.resolvedDefaults['seedInstants'], [BASE]);
    assert.equal(receipt?.resolvedDefaults['maybeCounts'], null);
    assert.equal(receipt?.resolvedDefaults['maybeInstants'], null);
    const partial = committed(await invoker.invokeMutation(envelope('Slot.create', {
      requiredCounts: ['4'], counts: ['7'], instants: TIMES,
    }), identity)).result as { id: string; data: Record<string, unknown> };
    committed(await invoker.invokeMutation(envelope('Slot.update', {
      record: { id: partial.id, version: '1' }, count: '9',
    }), identity));
    const partialRow = await d1.store.load(MODEL, asId(partial.id));
    assert.equal(partialRow?.version, 2);
    assert.deepEqual(partialRow?.data, { ...partial.data, count: '9' });
    assert.equal(committed(await invoker.invokeMutation(envelope('created', { slot: ref(1) }), identity)).result,
      new Date(FIXED_NOW).toISOString());
    const defaults = envelope('defaults', {});
    assert.equal(committed(await invoker.invokeMutation(defaults, identity)).result, '2030-01-01T00:00:01.000Z');
    assert.equal((await d1.store.readReceipt(receiptIdentity(defaults)))?.resolvedDefaults['value'], '2');
    assert.deepEqual((await d1.store.readReceipt(receiptIdentity(defaults)))?.resolvedDefaults['counts'], ['1', '2']);
    assert.equal((await d1.store.readReceipt(receiptIdentity(defaults)))?.resolvedDefaults['at'], BASE);
    assert.deepEqual((await d1.store.readReceipt(receiptIdentity(defaults)))?.resolvedDefaults['instants'], [BASE]);
    const namedDefault = envelope('namedDefault', {});
    assert.equal(committed(await invoker.invokeMutation(namedDefault, identity)).result, BASE);
    const namedReceipt = await d1.store.readReceipt(receiptIdentity(namedDefault));
    assert.ok(namedReceipt !== null && Object.hasOwn(namedReceipt.resolvedDefaults, '__proto__'));
    assert.equal(namedReceipt.resolvedDefaults['__proto__'], BASE);
    const bornRequest = envelope('born', {});
    assert.equal(committed(await invoker.invokeMutation(bornRequest, identity)).result, BASE);
    assert.equal((await d1.store.readReceipt(receiptIdentity(bornRequest)))?.resolvedDefaults[`0:${MODEL}.at`], BASE);
    assert.deepEqual((await d1.store.readReceipt(receiptIdentity(bornRequest)))?.resolvedDefaults[`0:${MODEL}.seedInstants`], [BASE]);
    assert.equal(committed(await invoker.invokeMutation(envelope('total', {}), identity)).result, '0');
    assert.equal(committed(await invoker.invokeMutation(envelope('echoMaybeTime', { value: null }), identity)).result, null);
    const omittedNullable = envelope('echoMaybeTime', {});
    assert.equal(committed(await invoker.invokeMutation(omittedNullable, identity)).result, null);
    assert.equal((await d1.store.readReceipt(receiptIdentity(omittedNullable)))?.resolvedDefaults['value'], null);
    assert.equal(committed(await invoker.invokeMutation(envelope('echoMaybeTime', { value: BASE }), identity)).result, BASE);
    assert.equal(committed(await invoker.invokeMutation(envelope('echoMaybeNumbers', { value: null }), identity)).result, null);
    assert.equal(committed(await invoker.invokeMutation(envelope('echoMaybeNumbers', {}), identity)).result, null);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('echoMaybeNumbers', {
      value: ['9007199254740993'],
    }), identity)).result, ['9007199254740993']);

    const request = envelope('advance', {
      slot: ref(1), delta: '9007199254740993', at: '2030-01-02T00:00:00.000Z',
      counts: ['2', '3'], instants: TIMES, accept: true,
    });
    const advanced = committed(await invoker.invokeMutation(request, identity));
    assert.equal(advanced.result, LATER);
    assert.equal(committed(await invoker.invokeMutation(request, identity), 'replayed').result, LATER);
    const stored = await d1.store.load(MODEL, asId(row.id));
    assert.equal(stored?.version, 2);
    assert.equal(stored?.data['count'], '9007199254741002');
    assert.equal(stored?.data['at'], LATER);
    assert.deepEqual(stored?.data['counts'], ['2', '3']);
    assert.deepEqual(stored?.data['instants'], TIMES);
    const numbers = envelope('numbers', { slot: ref(2) });
    assert.deepEqual(committed(await invoker.invokeMutation(numbers, identity)).result, ['5', '9007199254741002']);
    const times = envelope('times', { slot: ref(2) });
    assert.deepEqual(committed(await invoker.invokeMutation(times, identity)).result, TIMES);
    assert.equal(committed(await invoker.invokeMutation(envelope('maybeNumbers', { slot: ref(2) }), identity)).result, null);
    assert.equal(committed(await invoker.invokeMutation(envelope('maybeTimes', { slot: ref(2) }), identity)).result, null);
    const history = await d1.store.historyFor(MODEL, asId(row.id));
    const rollback = envelope('advance', {
      slot: ref(2), delta: '1', at: '2030-01-04T00:00:00.000Z', counts: ['8'],
      instants: ['2030-01-05T00:00:00.000Z'], accept: false,
    });
    rejected(await invoker.invokeMutation(rollback, identity));
    const invalidWire = rejected(await invoker.invokeMutation(envelope('advance', {
      slot: ref(2), delta: '1', at: '2030-01-04T01:00:00+01:00', counts: ['8'],
      instants: ['2030-01-05T00:00:00.000Z'], accept: true,
    }), identity));
    assert.equal(invalidWire.code, 'validation');
    assert.deepEqual(await d1.store.load(MODEL, asId(row.id)), stored);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), history);
    assert.doesNotThrow(() => JSON.stringify([receipt, stored, history, advanced]));

    await d1.worker.dispose();
    d1 = undefined;
    d1 = await openD1(join(dir, 'd1'));
    const reopened = buildInvoker(artifact, asm, d1.store, { memberships, now: () => FIXED_NOW });
    assert.deepEqual(await d1.store.load(MODEL, asId(row.id)), stored);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), history);
    const revision = await d1.store.readRevision();
    assert.equal(committed(await reopened.invokeMutation(request, identity), 'replayed').result, LATER);
    assert.deepEqual(committed(await reopened.invokeMutation(numbers, identity), 'replayed').result, ['5', '9007199254741002']);
    assert.deepEqual(committed(await reopened.invokeMutation(times, identity), 'replayed').result, TIMES);
    assert.equal(committed(await reopened.invokeMutation(defaults, identity), 'replayed').result, '2030-01-01T00:00:01.000Z');
    assert.equal(committed(await reopened.invokeMutation(namedDefault, identity), 'replayed').result, BASE);
    assert.equal(await d1.store.readRevision(), revision);
  } finally {
    await d1?.worker.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
