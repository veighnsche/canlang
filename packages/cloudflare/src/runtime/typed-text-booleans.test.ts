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

const APP = 'TypedTextBooleans';
const MODEL = asModel(`${APP}.Profile`);
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

test('compiled text and boolean profiles validate native inputs, fields, results and staged omission', async () => {
  const path = resolve('packages/cloudflare/test/fixtures/typed-text-booleans.json');
  const artifact = JSON.parse(await readFile(path, 'utf8')) as CompileArtifact;
  const fields = artifact.models!.find((model) => model.name === MODEL)!.fields;
  assert.equal(fields.find((field) => field.name === 'name')?.valueType, 'text');
  assert.equal(fields.find((field) => field.name === 'names')?.valueType, 'text[]');
  assert.deepEqual(artifact.operations!.find((operation) => operation.name === `${APP}.active`)?.result, { type: 'bool' });
  assert.deepEqual(artifact.operations!.find((operation) => operation.name === `${APP}.maybeNames`)?.result, { type: 'text[]?' });
  const dir = await mkdtemp(join(tmpdir(), 'can-text-booleans-'));
  // This bounded profile uses canonical memory State and makes no D1 persistence claim.
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ membership: member.membership, email: member.user.email });
  const options = { memberships, now: () => FIXED_NOW };
  try {
    const assemblerOptions = { stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui') };
    const asm = await assembleModules({ artifact, sourcePath: path }, {
      ...assemblerOptions, workDir: join(dir, 'modules'),
    });
    const invoker = buildInvoker(artifact, asm, store, options);
    const born = committed(await invoker.invokeMutation(envelope('Profile.create', {}), identity));
    const row = born.result as { id: string; version: number; data: Record<string, unknown> };
    assert.deepEqual(row.data, {
      name: 'initial', enabled: false, names: [], flags: [], seedNames: ['a', 'b'],
      seedFlags: [true, false], maybeNames: null, maybeFlags: null, maybeName: null, maybeEnabled: null,
    });
    const ref = (version: number) => ({ id: row.id, version: String(version) });
    const defaults = envelope('defaults', {});
    assert.equal(committed(await invoker.invokeMutation(defaults, identity)).result, 'hello:a/b');
    assert.equal(committed(await invoker.invokeMutation(defaults, identity), 'replayed').result, 'hello:a/b');
    const receipt = await store.readReceipt({ app: APP, owner: identity.team!.team_id,
      principal: identity.actor!.user_id, operation: asOperation(defaults.operation),
      operationId: asOperationId(defaults.operation_id) });
    assert.deepEqual(receipt?.resolvedDefaults, {
      name: 'hello', enabled: true, names: ['a', 'b'], flags: [true, true],
    });
    const request = envelope('change', {
      profile: ref(1), name: 'unused', enabled: true, names: ['Ada', 'Bo'], flags: [true, true], accept: true,
    });
    assert.equal(committed(await invoker.invokeMutation(request, identity)).result, 'Ada/Bo');
    assert.equal(committed(await invoker.invokeMutation(request, identity), 'replayed').result, 'Ada/Bo');
    assert.equal(committed(await invoker.invokeMutation(envelope('active', { profile: ref(2) }), identity)).result, true);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('names', { profile: ref(2) }), identity)).result, ['Ada', 'Bo']);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('flags', { profile: ref(2) }), identity)).result, [true, true]);
    assert.equal(committed(await invoker.invokeMutation(envelope('maybeNames', { profile: ref(2) }), identity)).result, null);
    assert.equal(committed(await invoker.invokeMutation(envelope('maybeFlags', { profile: ref(2) }), identity)).result, null);
    const beforePartial = await store.load(MODEL, asId(row.id));
    committed(await invoker.invokeMutation(envelope('Profile.update', {
      record: ref(2), name: 'partial',
    }), identity));
    assert.deepEqual((await store.load(MODEL, asId(row.id)))?.data, { ...beforePartial?.data, name: 'partial' });
    assert.equal(committed(await invoker.invokeMutation(envelope('change', {
      profile: ref(3), name: 'kept', enabled: false, names: ['Ignored'], flags: [false], accept: true,
    }), identity)).result, 'kept');
    const stored = await store.load(MODEL, asId(row.id));
    const history = await store.historyFor(MODEL, asId(row.id));
    const validInputs = { profile: ref(4), name: 'rollback', enabled: false,
      names: ['valid'], flags: [false], accept: true };
    for (const bad of [{ name: 3 }, { enabled: 'false' }, { names: [true] }, { flags: ['false'] }]) {
      rejected(await invoker.invokeMutation(envelope('change', { ...validInputs, ...bad }), identity), 'validation');
    }
    rejected(await invoker.invokeMutation(envelope('Profile.update', {
      record: ref(4), name: false,
    }), identity), 'validation');
    rejected(await invoker.invokeMutation(envelope('Profile.update', {
      record: ref(4), flags: [1],
    }), identity), 'validation');
    rejected(await invoker.invokeMutation(envelope('change', {
      ...validInputs, accept: false,
    }), identity));
    assert.deepEqual(await store.load(MODEL, asId(row.id)), stored);
    assert.deepEqual(await store.historyFor(MODEL, asId(row.id)), history);

    // Synthetic handler-only violation exercises the actual declared bool result codec.
    const invalidResult = structuredClone(artifact);
    invalidResult.modules[0]!.js += `
const originalCanApp = canApp;
canApp = function() {
  const registry = originalCanApp();
  registry["${APP}.active"] = async function() { return "true"; };
  return registry;
};
`;
    const invalidAsm = await assembleModules({ artifact: invalidResult, sourcePath: path }, {
      ...assemblerOptions, workDir: join(dir, 'invalid-result'),
    });
    rejected(await buildInvoker(invalidResult, invalidAsm, store, options).invokeMutation(
      envelope('active', { profile: ref(4) }), identity,
    ), 'validation');
    assert.deepEqual(await store.load(MODEL, asId(row.id)), stored);
    assert.deepEqual(await store.historyFor(MODEL, asId(row.id)), history);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function openD1(dir: string) {
  const worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'typed-text-booleans' }, d1Persist: dir });
  try {
    const database = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(database);
    return { worker, store: createD1Storage(database) };
  } catch (error) {
    try { await worker.dispose(); } catch { /* Preserve the acquisition failure. */ }
    throw error;
  }
}

test('compiled text and boolean D1 lifecycle persists defaults, CRUD refusals and reopened replay', async () => {
  const path = resolve('packages/cloudflare/test/fixtures/typed-text-booleans.json');
  const artifact = JSON.parse(await readFile(path, 'utf8')) as CompileArtifact;
  const dir = await mkdtemp(join(tmpdir(), 'can-text-booleans-d1-'));
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
    const create = envelope('Profile.create', {});
    const born = committed(await invoker.invokeMutation(create, identity));
    const row = born.result as { id: string; version: number; data: Record<string, unknown> };
    const initialData = {
      name: 'initial', enabled: false, names: [], flags: [], seedNames: ['a', 'b'],
      seedFlags: [true, false], maybeNames: null, maybeFlags: null, maybeName: null, maybeEnabled: null,
    };
    assert.deepEqual(row.data, initialData);
    assert.deepEqual((await d1.store.load(MODEL, asId(row.id)))?.data, initialData);
    const createReceipt = await d1.store.readReceipt(receiptIdentity(create));
    for (const field of ['name', 'enabled', 'seedNames', 'seedFlags',
      'maybeNames', 'maybeFlags', 'maybeName', 'maybeEnabled'] as const) {
      assert.deepEqual(createReceipt?.resolvedDefaults[field], initialData[field]);
    }
    const defaults = envelope('defaults', {});
    assert.equal(committed(await invoker.invokeMutation(defaults, identity)).result, 'hello:a/b');
    const defaultsReceipt = await d1.store.readReceipt(receiptIdentity(defaults));
    assert.deepEqual(defaultsReceipt?.resolvedDefaults, {
      name: 'hello', enabled: true, names: ['a', 'b'], flags: [true, true],
    });
    const ref = (version: number) => ({ id: row.id, version: String(version) });
    const change = envelope('change', {
      profile: ref(1), name: 'unused', enabled: true,
      names: ['Ada', 'Bo'], flags: [true, true], accept: true,
    });
    assert.equal(committed(await invoker.invokeMutation(change, identity)).result, 'Ada/Bo');
    const beforePartial = await d1.store.load(MODEL, asId(row.id));
    const partial = envelope('Profile.update', { record: ref(2), name: 'partial',
      maybeNames: ['optional'], maybeFlags: [false], maybeName: 'present', maybeEnabled: false });
    committed(await invoker.invokeMutation(partial, identity));
    assert.deepEqual((await d1.store.load(MODEL, asId(row.id)))?.data, {
      ...beforePartial?.data, name: 'partial', maybeNames: ['optional'], maybeFlags: [false],
      maybeName: 'present', maybeEnabled: false,
    });
    const clear = envelope('Profile.update', { record: ref(3),
      maybeNames: null, maybeFlags: null, maybeName: null, maybeEnabled: null });
    committed(await invoker.invokeMutation(clear, identity));
    const stored = await d1.store.load(MODEL, asId(row.id));
    assert.equal(stored?.version, 4);
    assert.deepEqual(stored?.data, { ...initialData, name: 'partial', enabled: true,
      names: ['Ada', 'Bo'], flags: [true, true] });
    const history = await d1.store.historyFor(MODEL, asId(row.id));
    const rows = await d1.store.query({ model: MODEL, authority: 'owner' });
    // Exercise generated CRUD admission for scalar, array and nullable typed fields.
    for (const bad of [{ name: 3 }, { enabled: 'false' }, { names: [true] }, { flags: ['false'] },
      { maybeName: false }, { maybeEnabled: 1 }, { maybeNames: [false] }, { maybeFlags: ['true'] }]) {
      rejected(await invoker.invokeMutation(envelope('Profile.create', bad), identity), 'validation');
      rejected(await invoker.invokeMutation(envelope('Profile.update', {
        record: ref(4), ...bad,
      }), identity), 'validation');
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
    assert.deepEqual(await d1.store.readReceipt(receiptIdentity(defaults)), defaultsReceipt);
    assert.equal(committed(await reopened.invokeMutation(envelope('active', { profile: ref(4) }), identity)).result, true);
    assert.deepEqual(committed(await reopened.invokeMutation(envelope('names', { profile: ref(4) }), identity)).result, ['Ada', 'Bo']);
    assert.deepEqual(committed(await reopened.invokeMutation(envelope('flags', { profile: ref(4) }), identity)).result, [true, true]);
    assert.equal(committed(await reopened.invokeMutation(envelope('maybeNames', { profile: ref(4) }), identity)).result, null);
    assert.equal(committed(await reopened.invokeMutation(envelope('maybeFlags', { profile: ref(4) }), identity)).result, null);
    const revision = await d1.store.readRevision();
    assert.deepEqual(committed(await reopened.invokeMutation(create, identity), 'replayed').result, born.result);
    assert.equal(committed(await reopened.invokeMutation(change, identity), 'replayed').result, 'Ada/Bo');
    committed(await reopened.invokeMutation(partial, identity), 'replayed');
    committed(await reopened.invokeMutation(clear, identity), 'replayed');
    assert.equal(committed(await reopened.invokeMutation(defaults, identity), 'replayed').result, 'hello:a/b');
    assert.equal(await d1.store.readRevision(), revision);
    assert.deepEqual(await d1.store.query({ model: MODEL, authority: 'owner' }), rows);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), history);
  } finally {
    try { await d1?.worker.dispose(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
});
