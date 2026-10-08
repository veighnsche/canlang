import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CompileArtifact, MutationEnvelope } from '@canlang/contracts';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
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
