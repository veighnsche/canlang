/** Closed ordinary actor defaults retain the canonical creation phases. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtifactModelField, CanTypeId, CanonicalModelDescriptor, InvocationContext } from '@canlang/contracts';
import { decodeValue, encodeValue } from '@canlang/values';
import { loadArtifactDescriptors, artifactToDescriptorSet, loadExecutionDescriptorSet, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { buildContext } from '../../src/invocation/context.js';
import { invoke } from '../../src/invocation/invoke.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { buildModelTable, buildModelTableFromCanonical, hasContextActorDefault } from '../../src/mutation/models.js';
import { beginOwnerMutation, runMutationWrites } from '../../src/mutation/pipeline.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { StateError } from '../../src/errors.js';
import { FIXED_NOW, asId, asModel, asOperation, createMemoryIdentityStore, makeIdentity, makeEnvelope, seedMember, uuidv7 } from '../invocation/fixtures.js';

const MODEL = asModel('ContextDefault.Deal'), OP = `${MODEL}.create`;
function artifact(nullable = false): ArtifactDescriptorSlice {
  const type = (nullable ? 'user?' : 'user') as CanTypeId;
  return { artifact_version: 1, models: [{ name: MODEL, deleteMode: 'archive', fields: [
    { name: 'title', field: { kind: 'string' }, valueType: 'text', required: true, serverOnly: false },
    { name: 'owner', field: { kind: 'user' }, valueType: type, required: false, serverOnly: false,
      ...(nullable ? { nullable: true } : {}), default: { kind: 'context', value: 'actor' } },
  ] }], operations: [{ name: OP, kind: 'create', description: '', inputs: { fields: [
    { name: 'title', field: { kind: 'string' }, valueType: 'text', required: true },
    { name: 'owner', field: { kind: 'user' }, valueType: type, required: false,
      ...(nullable ? { nullable: true } : {}), default: { kind: 'context', value: 'actor' } },
  ] } }] };
}
function table(nullable = false) {
  const loaded = loadArtifactDescriptors(artifact(nullable), { by: 'members' });
  return { ...loaded, table: buildModelTableFromCanonical(loaded.models, { nullableFields: loaded.nullableFields }) };
}
function context(actor: string | null = 'actual-user'): InvocationContext {
  return buildContext({ identity: makeIdentity({ actor: actor === null ? null : { user_id: actor, email: 'actor@example.test', email_verified: true },
    teamId: 'context-team', membership: null }), app: 'context-default', operation: asOperation(OP),
    operationId: uuidv7(FIXED_NOW, 99201), source: 'test', now: FIXED_NOW, kind: 'user' });
}
const refuses = (error: unknown) => error instanceof StateError && error.code === 'validation';
const codec = (type: CanTypeId, value: unknown) => {
  try { return encodeValue(type, decodeValue(type, value)); }
  catch { throw new StateError('validation', 'Receiving native User codec refused the value.'); }
};

test('both intakes retain the exact ordinary actor recipe and reject other tokens, wrong types, arrays and server ownership', () => {
  for (const nullable of [false, true]) {
    const raw = artifact(nullable), converted = artifactToDescriptorSet(raw);
    for (const loaded of [loadArtifactDescriptors(raw, { by: 'members' }), loadExecutionDescriptorSet(converted.set, { by: 'members' })]) {
      const field = loaded.models[0]!.fields.owner!;
      assert.deepEqual(field.default, { kind: 'context', value: 'actor' }); assert.equal(field.serverOnly, false);
      const built = buildModelTableFromCanonical(loaded.models), bound = built.get(MODEL)!.fields.owner!;
      assert.equal(hasContextActorDefault(bound), true); assert.equal(hasContextActorDefault({ ...bound }), false);
    }
  }
  const mutations: Array<(field: ArtifactModelField) => void> = [
    field => { Object.assign(field.default!, { value: 'now' }); },
    field => { Object.assign(field.default!, { extra: true }); },
    field => { Object.assign(field, { valueType: 'text', field: { kind: 'string' } }); },
    field => { Object.assign(field, { valueType: 'user[]', array: { required: false } }); },
    field => { field.serverOnly = true; }, field => { field.required = true; },
  ];
  for (const mutate of mutations) {
    const raw = artifact(); mutate(raw.models![0]!.fields[1]!);
    assert.throws(() => loadArtifactDescriptors(raw, { by: 'members' }));
    const canonical = artifactToDescriptorSet(artifact()).set;
    const wrong = { ...canonical, models: structuredClone(canonical.models) };
    const owner = wrong.models[0]!.fields.owner!;
    const source = raw.models![0]!.fields[1]!;
    Object.assign(owner, { valueType: source.valueType, required: source.required, serverOnly: source.serverOnly,
      default: source.default, ...(source.array === undefined ? {} : { array: source.array }) });
    assert.throws(() => loadExecutionDescriptorSet(wrong, { by: 'members' }));
  }
  const loaded = table();
  assert.throws(() => buildModelTableFromCanonical(loaded.models, { serverInits: new Map([[MODEL, new Map([['owner', 'actor' as const]])]]) }));
  const literal = structuredClone(loaded.models) as CanonicalModelDescriptor[];
  Object.assign(literal[0]!.fields.owner!, { default: { kind: 'literal', value: { kind: 'context', value: 'actor' } } });
  assert.equal(hasContextActorDefault(buildModelTableFromCanonical(literal).get(MODEL)!.fields.owner!), false);
});

test('omission records the actual actor while supplied overrides win, nullable absence stays null and nonnullable absence fails without attribution fallback', async () => {
  for (const encodeField of [undefined, codec]) {
    const { table: models } = table(), store = createMemoryStorage();
    const omitted = await runMutationWrites({ table: models, store, context: context(), ...(encodeField === undefined ? {} : { encodeField }),
      writes: [{ op: 'create', model: MODEL, id: asId('omitted'), data: { title: 'Original' } }] });
    assert.deepEqual(omitted.writes[0]!.kind === 'insert' ? omitted.writes[0]!.row.data.owner : undefined, { id: 'actual-user' });
    assert.deepEqual(omitted.resolvedDefaults.owner, { id: 'actual-user' });
    const supplied = await runMutationWrites({ table: models, store, context: context(null), ...(encodeField === undefined ? {} : { encodeField }),
      writes: [{ op: 'create', model: MODEL, id: asId('supplied'), data: { title: 'Override', owner: { id: 'other-user' } } }] });
    assert.equal(Object.hasOwn(supplied.resolvedDefaults, 'owner'), false);
    assert.deepEqual(supplied.writes[0]!.kind === 'insert' ? supplied.writes[0]!.row.data.owner : undefined, { id: 'other-user' });
    for (const ctx of [context(null), { ...context(null), kind: 'trusted' as const, trustedSource: 'trusted-attribution' }]) {
      await assert.rejects(runMutationWrites({ table: models, store, context: ctx, ...(encodeField === undefined ? {} : { encodeField }),
        writes: [{ op: 'create', model: MODEL, id: asId('absent'), data: { title: 'Must fail' } }] }), refuses);
      assert.equal(await store.load(MODEL, asId('absent')), null);
    }
    await assert.rejects(runMutationWrites({ table: models, store, context: context(), ...(encodeField === undefined ? {} : { encodeField }),
      writes: [{ op: 'create', model: MODEL, id: asId('explicit-null'), data: { title: 'Null', owner: null } }] }), refuses);
    const nullable = await runMutationWrites({ table: table(true).table, store, context: context(null), ...(encodeField === undefined ? {} : { encodeField }),
      writes: [{ op: 'create', model: MODEL, id: asId('nullable'), data: { title: 'Nullable' } }] });
    assert.equal(nullable.writes[0]!.kind === 'insert' ? nullable.writes[0]!.row.data.owner : 'missing', null);
    assert.equal(nullable.resolvedDefaults.owner, null);
  }
});

test('hooks observe the resolved default, final invariants see hook changes, and receipts retain the original resolution', async () => {
  const original = table().table.get(MODEL)!, order: string[] = [];
  const models = buildModelTable([{ ...original, hooks: [{ name: 'observes-owner', ops: ['create'], run: async candidate => {
    order.push('hook'); assert.deepEqual(candidate.owner, { id: 'actual-user' });
    return { ...candidate, owner: { id: 'hook-user' } };
  } }], invariants: [{ name: 'final-owner', check: async view => {
    order.push('invariant'); assert.deepEqual(view.get(MODEL, asId('hooked'))!.data.owner, { id: 'hook-user' });
  } }] }]);
  const result = await runMutationWrites({ table: models, context: context(), store: createMemoryStorage(), encodeField: codec,
    writes: [{ op: 'create', model: MODEL, id: asId('hooked'), data: { title: 'Hooked' } }] });
  assert.deepEqual(order, ['hook', 'invariant']); assert.deepEqual(result.resolvedDefaults.owner, { id: 'actual-user' });
});

test('owner stages default only on creation and retain their original default across later updates', async () => {
  const { table: models } = table(), store = createMemoryStorage();
  const session = await beginOwnerMutation({ table: models, store, context: context(), bounds: { maxRows: 10, maxWork: 1000 } });
  await session.stage({ op: 'create', model: MODEL, id: asId('staged'), data: { title: 'Initial' } }, { cause: 'scenario' });
  assert.deepEqual((await session.views.final.get(MODEL, asId('staged')))!.data.owner, { id: 'actual-user' });
  await session.stage({ op: 'update', model: MODEL, id: asId('staged'), data: { title: 'Later', owner: { id: 'other-user' } } }, { cause: 'scenario' });
  await session.stage({ op: 'update', model: MODEL, id: asId('staged'), data: { title: 'Latest' } }, { cause: 'scenario' });
  const finalized = await session.finalize();
  assert.deepEqual(finalized.resolvedDefaults[`0:${MODEL}.owner`], { id: 'actual-user' });
  assert.equal(Object.keys(finalized.resolvedDefaults).filter(key => key.endsWith('.owner')).length, 1);
  assert.deepEqual(finalized.writes[0]!.kind === 'insert' ? finalized.writes[0]!.row.data.owner : undefined, { id: 'other-user' });
  assert.equal(await store.load(MODEL, asId('staged')), null, 'owner finalization does not commit');
});

test('canonical invoke saves the ordinary default once and receipt replay never executes creation again', async () => {
  const loaded = table(), store = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false }), identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  let executions = 0;
  let receipt: import('@canlang/contracts').Receipt | undefined;
  const request = { registry: loaded.registry, store, memberships, identity, app: 'context-default', source: 'test', clock: { nowMs: () => FIXED_NOW },
    envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, 99202), { title: 'Replay' }),
    observeCommittedReceipt: (value: import('@canlang/contracts').Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
      executions++; return { ...await runMutationWrites({ table: loaded.table, store, context: call.context,
        writes: [{ op: 'create', model: MODEL, id: asId('replayed'), data: call.inputs }] }), outbox: [], result: null };
    } };
  assert.equal((await invoke(request)).status, 'committed');
  assert.ok(receipt); assert.deepEqual(receipt.resolvedDefaults.owner, { id: member.user.user_id });
  const row = await store.load(MODEL, asId('replayed')); assert.ok(row); assert.deepEqual(row.data.owner, { id: member.user.user_id });
  const revision = await store.readRevision();
  assert.equal((await invoke(request)).status, 'replayed'); assert.equal(executions, 1); assert.equal(await store.readRevision(), revision);
  assert.deepEqual(await store.load(MODEL, asId('replayed')), row);
});
