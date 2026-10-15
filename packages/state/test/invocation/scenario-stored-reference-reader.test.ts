/** Finite direct State Branch.profile -> Profile.active reader controls.
 * Checked descriptors are handbound; native Dev/source execution remains separate. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ModelName, Receipt, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import type { ViewerSourceReadPolicy } from '../../src/query/source-policy.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { invoke } from '../../src/invocation/invoke.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptReferenceProducer, observeScenarioReceiptDependency,
  readScenarioReceiptStoredReferenceRow, selectScenarioReceiptReturn, readScenarioReceiptAssociation,
  projectScenarioReceipt, observeScenarioReceiptRowId, bindScenarioReceiptModelResult,
  readScenarioReceiptNullableStoredReferenceRow } from '../../src/invocation/scenario-receipt.js';
import { asId, asModel, FIXED_NOW, makeIdentity, makeEnvelope, makeBatch, makeRow, uuidv7 } from './fixtures.js';

const CONVERSATION = asModel('ReferenceReader.Conversation'), BRANCH = asModel('ReferenceReader.Branch'), PROFILE = asModel('ReferenceReader.Profile');
const OP = 'ReferenceReader.active', APP = 'stored-reference-reader', cause = { cause: 'scenario' } as const;
const source = { path: 'stored-reference-reader.can', module: 'stored-reference-reader.mjs', sha256: 'd'.repeat(64) };
let sequence = 120_000;
type Shape = 'singular' | 'nullable' | 'array';
function artifact(shape: Shape = 'singular', leafShape?: Shape): ArtifactDescriptorSlice {
  const type = `${PROFILE}${shape === 'array' ? '[]!' : shape === 'nullable' ? '?' : ''}` as CanTypeId;
  return { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: `export const identity="${OP}";`, map: { version: 3, file: source.module,
      sources: [source.path], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: source.module, export: 'identity', member: ['active'] }],
    models: [
      { name: CONVERSATION, deleteMode: 'remove', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] },
      { name: BRANCH, parent: CONVERSATION, deleteMode: 'remove', fields: [
        { name: 'title', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: true, serverOnly: false },
        { name: 'profile', field: { kind: 'ref', model: PROFILE }, valueType: type, required: shape !== 'nullable', serverOnly: false,
          ...(shape === 'array' ? { array: { required: true }, min: 1 } : {}), ...(shape === 'nullable' ? { nullable: true } : {}) },
      ] },
      { name: PROFILE, deleteMode: 'remove', fields: [
        { name: 'active', field: { kind: 'boolean' }, valueType: 'bool' as CanTypeId, required: true, serverOnly: false },
        ...(leafShape === undefined ? [] : [{ name: 'next', field: { kind: 'ref' as const, model: PROFILE },
          valueType: `${PROFILE}${leafShape === 'array' ? '[]!' : leafShape === 'nullable' ? '?' : ''}` as CanTypeId,
          required: leafShape !== 'nullable', serverOnly: false,
          ...(leafShape === 'array' ? { array: { required: true }, min: 1 } : {}),
          ...(leafShape === 'nullable' ? { nullable: true } : {}) }]),
      ] },
    ], operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [] }, result: { type: 'bool' as CanTypeId,
      disclosure: { version: 1, source, returns: [
        { id: 'active-return', source, influences: [], dependencies: [
          { id: 'branch-profile', source, role: 'control', model: BRANCH, field: 'profile', type },
          ...(leafShape === undefined ? [
            { id: 'profile-active', source, role: 'data' as const, model: PROFILE, field: 'active', type: 'bool' as CanTypeId },
          ] : [
            { id: 'profile-next', source, role: 'control' as const, model: PROFILE, field: 'next',
              type: `${PROFILE}${leafShape === 'array' ? '[]!' : leafShape === 'nullable' ? '?' : ''}` as CanTypeId },
            { id: 'next-active', source, role: 'data' as const, model: PROFILE, field: 'active', type: 'bool' as CanTypeId },
          ]),
        ] },
        { id: 'foreign-return', source, influences: [], dependencies: [
          { id: 'branch-title', source, role: 'data', model: BRANCH, field: 'title', type: 'text' as CanTypeId },
        ] },
      ] } } }],
  };
}
async function world(shape: Shape = 'singular', targetOnlyMember = false, leafShape?: Shape) {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const user = await memberships.createUser({ email: 'reference-reader@example.test', password_hash: 'test-only', email_verified: true });
  const caller = await memberships.createMembership({ team_id: team.team_id, user_id: user.user_id, roles: [], is_owner: false });
  const readerUser = await memberships.createUser({ email: 'reference-authority@example.test', password_hash: 'test-only', email_verified: true });
  const reader = await memberships.createMembership({ team_id: team.team_id, user_id: readerUser.user_id, roles: [], is_owner: false });
  let targetReader = reader;
  if (targetOnlyMember) {
    const targetUser = await memberships.createUser({ email: 'reference-target-only@example.test', password_hash: 'test-only', email_verified: true });
    targetReader = await memberships.createMembership({ team_id: team.team_id, user_id: targetUser.user_id, roles: [], is_owner: false });
  }
  const store = createMemoryStorage(), loaded = loadArtifactDescriptors(artifact(shape, leafShape), { by: 'members' });
  const def = loaded.registry.get(OP); assert.ok(def && isGeneratedOperationDef(def));
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment });
  const access = { branch: true, target: true, ancestor: true };
  const policy = buildPolicyTable([]);
  const targetControl: { duringRead?: () => Promise<void> } = {};
  const readPolicies: Map<ModelName, ViewerSourceReadPolicy> = new Map([
    [CONVERSATION, { fields: ['title'], secretFields: [], grants: [{ fields: ['id', 'title'], read: async ({ context, row }) =>
      access.ancestor && row.createdBy === context.actorUserId && context.membership?.status === 'active' }] }],
    [BRANCH, { parent: CONVERSATION, fields: ['title', 'profile'], secretFields: [], grants: [{ fields: ['id', 'title', 'profile'], read: async ({ context, row }) =>
      access.branch && row.createdBy === context.actorUserId && context.membership?.status === 'active' &&
      (await context.memberships.findMembership(team.team_id, readerUser.user_id))?.status === 'active' }] }],
    [PROFILE, { fields: leafShape === undefined ? ['active'] : ['active', 'next'], secretFields: [], grants: [{ fields: leafShape === undefined ? ['id', 'active'] : ['id', 'active', 'next'], read: async ({ context, row }) => {
      if (!(access.target && row.data.active === true && row.createdBy === context.actorUserId && context.membership?.status === 'active')) return false;
      const related = await context.memberships.findMembership(team.team_id, targetReader.user_id);
      const duringRead = targetControl.duringRead; if (duringRead !== undefined) await duringRead();
      return related?.status === 'active';
    } }] }],
  ]);
  bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  return { store, memberships, caller, reader, targetReader, table, access, policy, readPolicies, targetControl, shape, registry: loaded.registry,
    app: APP, source: 'test', identity: makeIdentity({ userId: user.user_id, team, membership: caller }),
    clock: { nowMs: () => FIXED_NOW }, envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), {}) };
}
type World = Awaited<ReturnType<typeof world>>;
type Session = Awaited<ReturnType<typeof beginScenarioReceiptMutation>>;
type Mode = 'normal' | 'unobserved' | 'copied-source' | 'stale-stage' | 'copied-call' | 'foreign-store' | 'foreign-pair' | 'copied-target' | 'missing-scalar' | 'concurrent' | 'foreign-source' | 'caught-copied-call' | 'caught-foreign-store';
const refuses = (error: unknown) => error instanceof StateError;
function input(w: World, mode: Mode = 'normal', after?: (session: Session) => Promise<void>, foreignSource?: StoredRow) {
  let receipt: Receipt | undefined, call: AdmittedCall | undefined, sourceRow: StoredRow | undefined, targetRow: StoredRow | undefined, executions = 0;
  const request = { ...w, observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (admitted: AdmittedCall) => {
    executions++; call = admitted;
    const session = await beginScenarioReceiptMutation(admitted, w.store, { table: w.table, bounds: { maxRows: 10, maxWork: 1000 } });
    await session.stage({ op: 'create', model: CONVERSATION, id: asId('conversation'), data: { title: 'Owning conversation' } }, cause);
    await session.stage({ op: 'create', model: PROFILE, id: asId('profile'), data: { active: true } }, cause);
    await session.stage({ op: 'create', model: BRANCH, id: asId('branch'), parent: { model: CONVERSATION, id: asId('conversation') },
      data: { title: 'Owning branch', profile: w.shape === 'array' ? [{ id: 'profile' }] : { id: 'profile' } } }, cause);
    const branch = await session.read(BRANCH, asId('branch')); assert.ok(branch); sourceRow = branch;
    assert.equal(await w.store.load(PROFILE, asId('profile')), null, 'target exists only in genuine owner provisional state');
    const wire = branch.data.profile; assert.deepEqual(wire, w.shape === 'array' ? [{ id: 'profile' }] : { id: 'profile' });
    if (mode !== 'unobserved') await observeScenarioReceiptDependency(admitted, w.store,
      { dependencyId: 'branch-profile', model: BRANCH, row: branch, field: 'profile' });
    if (mode === 'stale-stage') await session.stage({ op: 'update', model: BRANCH, id: branch.id, data: { title: 'Later stage' } }, cause);
    const promotion = () => readScenarioReceiptStoredReferenceRow(mode === 'copied-call' ? { ...admitted } : admitted,
      mode === 'foreign-store' ? { ...w.store } : w.store, { sourceDependencyId: 'branch-profile',
        scalarLeafDependencyId: mode === 'foreign-pair' ? 'branch-title' : 'profile-active',
        sourceRow: mode === 'copied-source' ? { ...branch } : mode === 'foreign-source' ? foreignSource! : branch });
    if (mode === 'concurrent') {
      const outcomes = await Promise.allSettled([promotion(), promotion()]);
      assert.ok(outcomes.some(outcome => outcome.status === 'rejected' && refuses(outcome.reason)));
    }
    const profile = await promotion(); targetRow = profile;
    assert.equal(profile.id, 'profile'); assert.equal(profile.data.active, true);
    const active = profile.data.active;
    if (mode !== 'missing-scalar') await observeScenarioReceiptDependency(admitted, w.store,
      { dependencyId: 'profile-active', model: PROFILE, row: mode === 'copied-target' ? { ...profile } : profile, field: 'active' });
    if (mode === 'caught-copied-call' || mode === 'caught-foreign-store') {
      // Both legitimate required observations have completed. Failure below
      // must poison the real issuer, rather than fail from a missing recipe.
      await assert.rejects(readScenarioReceiptStoredReferenceRow(mode === 'caught-copied-call' ? { ...admitted } : admitted,
        mode === 'caught-foreign-store' ? { ...w.store } : w.store,
        { sourceDependencyId: 'branch-profile', scalarLeafDependencyId: 'profile-active', sourceRow: branch }), refuses);
    }
    await after?.(session); selectScenarioReceiptReturn(admitted, w.store, 'active-return');
    return { ...await session.finalize(), result: active, outbox: [] };
  } };
  return { request, receipt: () => receipt, call: () => call, sourceRow: () => sourceRow, targetRow: () => targetRow, executions: () => executions };
}
async function unchanged(w: World) {
  for (const [model, id] of [[CONVERSATION, 'conversation'], [BRANCH, 'branch'], [PROFILE, 'profile']] as const) {
    assert.equal(await w.store.load(model, asId(id)), null); assert.deepEqual(await w.store.historyFor(model, asId(id)), []);
  }
  assert.deepEqual(await w.store.outboxPending(), []);
}

test('observed required Branch.profile promotes the genuine provisional Profile leaf and retains original scalar/ref evidence through replay', async () => {
  const w = await world(), execution = input(w);
  assert.equal((await invoke(execution.request)).status, 'committed'); const receipt = execution.receipt(); assert.ok(receipt);
  const saved = readScenarioReceiptAssociation(receipt)!;
  assert.deepEqual(saved.observations.map(value => [value.dependencyId, value.model, value.row.id]), [
    ['branch-profile', BRANCH, 'branch'], ['profile-active', PROFILE, 'profile'],
  ]);
  assert.deepEqual(saved.observations[0]!.row.data.profile, { id: 'profile' }); assert.equal(saved.observations[1]!.row.data.active, true);
  assert.equal((await projectScenarioReceipt({ ...w, receipt })).result, true);
  const revision = await w.store.readRevision(), retained = structuredClone(receipt);
  assert.equal((await invoke(execution.request)).status, 'replayed'); assert.equal(execution.executions(), 1);
  assert.equal(await w.store.readRevision(), revision); assert.deepEqual(execution.receipt(), retained);
});

test('promotion refuses unobserved/copied/foreign sources, crossed stages/calls/stores, foreign scalar pairs and overlapping readers', async () => {
  for (const mode of ['unobserved', 'copied-source', 'stale-stage', 'copied-call', 'foreign-store', 'foreign-pair', 'concurrent'] as const) {
    const w = await world(), execution = input(w, mode);
    await assert.rejects(invoke(execution.request), refuses); await unchanged(w);
  }
  const first = await world(), completed = input(first); await invoke(completed.request); assert.ok(completed.sourceRow());
  const foreign = await world(); await assert.rejects(invoke(input(foreign, 'foreign-source', undefined, completed.sourceRow()).request), refuses); await unchanged(foreign);
});

test('a copied target or omitted actual scalar observer cannot complete the saved result', async () => {
  for (const mode of ['copied-target', 'missing-scalar'] as const) {
    const w = await world(); await assert.rejects(invoke(input(w, mode).request), refuses); await unchanged(w);
  }
});

test('nullable and array source references do not acquire the required singular scalar reader profile', async () => {
  for (const shape of ['nullable', 'array'] as const) {
    const w = await world(shape); await assert.rejects(invoke(input(w).request), refuses); await unchanged(w);
  }
});

test('late source, target, ancestor and complete Identity denial roll back all original staged records', async () => {
  for (const loss of ['source', 'target', 'ancestor', 'membership', 'own-target'] as const) {
    const w = await world(), execution = input(w, 'normal', async session => {
      if (loss === 'source') w.access.branch = false;
      else if (loss === 'target') w.access.target = false;
      else if (loss === 'ancestor') w.access.ancestor = false;
      else if (loss === 'membership') await w.memberships.removeMembership(w.reader.membership_id);
      else await session.stage({ op: 'update', model: PROFILE, id: asId('profile'), data: { active: false } }, cause);
    });
    await assert.rejects(invoke(execution.request), refuses); await unchanged(w);
  }
});

test('saved scalar recovery rechecks source field, target leaf, ancestor and current related membership', async () => {
  for (const loss of ['source', 'target', 'ancestor', 'membership'] as const) {
    const w = await world(), execution = input(w); await invoke(execution.request); const receipt = execution.receipt(); assert.ok(receipt);
    if (loss === 'source') w.access.branch = false;
    else if (loss === 'target') w.access.target = false;
    else if (loss === 'ancestor') w.access.ancestor = false;
    else await w.memberships.removeMembership(w.reader.membership_id);
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
    assert.equal((await invoke(execution.request)).status, 'replayed'); assert.equal(execution.executions(), 1);
  }
});

test('closed call cannot promote a retained source row after its receipt has finalized', async () => {
  const w = await world(), execution = input(w); await invoke(execution.request); assert.ok(execution.call()); assert.ok(execution.sourceRow());
  await assert.rejects(readScenarioReceiptStoredReferenceRow(execution.call()!, w.store,
    { sourceDependencyId: 'branch-profile', scalarLeafDependencyId: 'profile-active', sourceRow: execution.sourceRow()! }), refuses);
});


test('caught invalid copied-call or foreign-store promotion poisons the genuine completed issuer before select/finalize', async () => {
  for (const mode of ['caught-copied-call', 'caught-foreign-store'] as const) {
    const w = await world(), execution = input(w, mode);
    await assert.rejects(invoke(execution.request), refuses);
    assert.ok(execution.targetRow(), 'the legitimate target and scalar observation completed before caught misuse');
    await unchanged(w);
  }
});

test('initial source/target/ancestor or related Identity denial never exposes a promoted target', async () => {
  for (const loss of ['source', 'target', 'ancestor', 'membership'] as const) {
    const w = await world();
    if (loss === 'source') w.access.branch = false;
    else if (loss === 'target') w.access.target = false;
    else if (loss === 'ancestor') w.access.ancestor = false;
    else await w.memberships.removeMembership(w.reader.membership_id);
    const execution = input(w); await assert.rejects(invoke(execution.request), refuses);
    assert.equal(execution.targetRow(), undefined); await unchanged(w);
  }
});

test('related Identity drift during a genuine target source await refuses before target exposure', async () => {
  const w = await world(); let awaited = 0;
  w.targetControl.duringRead = async () => {
    delete w.targetControl.duringRead; awaited++;
    await w.memberships.removeMembership(w.reader.membership_id);
  };
  const execution = input(w); await assert.rejects(invoke(execution.request), refuses);
  assert.equal(awaited, 1); assert.equal(execution.targetRow(), undefined); await unchanged(w);
});


test('target-only related Identity revoked during later source revalidation is checked again before the target is issued', async () => {
  const w = await world('singular', true); let targetEvaluated = false, revocations = 0;
  assert.notEqual(w.targetReader.user_id, w.reader.user_id);
  w.targetControl.duringRead = async () => { targetEvaluated = true; };
  const memberships: typeof w.memberships = { ...w.memberships, findMembershipsSnapshot: async (team, users) => {
    const snapshot = await w.memberships.findMembershipsSnapshot(team, users);
    if (targetEvaluated && revocations === 0 && users.includes(w.reader.user_id) && !users.includes(w.targetReader.user_id)) {
      // This is the later source-only coherent snapshot. Its own caller/source
      // subjects remain valid, while the previously checked target loses its
      // distinct related subject during this real SDK await boundary.
      revocations++;
      await w.memberships.removeMembership(w.targetReader.membership_id);
    }
    return snapshot;
  } };
  const execution = input(w);
  await assert.rejects(invoke({ ...execution.request, memberships }), refuses);
  assert.equal(targetEvaluated, true); assert.equal(revocations, 1);
  assert.equal(execution.targetRow(), undefined); await unchanged(w);
});

test('source-only related Identity revoked during the late target snapshot refuses before target exposure', async () => {
  const w = await world('singular', true);
  let targetEvaluated = false, laterSourceObserved = false, revocations = 0;
  assert.notEqual(w.targetReader.user_id, w.reader.user_id);
  w.targetControl.duringRead = async () => { targetEvaluated = true; };
  const memberships: typeof w.memberships = { ...w.memberships, findMembershipsSnapshot: async (team, users) => {
    const snapshot = await w.memberships.findMembershipsSnapshot(team, users);
    if (targetEvaluated && users.includes(w.reader.user_id) && !users.includes(w.targetReader.user_id)) {
      laterSourceObserved = true;
    } else if (laterSourceObserved && revocations === 0 && users.includes(w.targetReader.user_id) && !users.includes(w.reader.user_id)) {
      // Genuine target subjects remain active in this SDK snapshot; the source
      // loses its separate related member after its own last successful check.
      revocations++;
      await w.memberships.removeMembership(w.reader.membership_id);
    }
    return snapshot;
  } };
  const execution = input(w);
  await assert.rejects(invoke({ ...execution.request, memberships }), refuses);
  assert.equal(targetEvaluated, true); assert.equal(laterSourceObserved, true); assert.equal(revocations, 1);
  assert.equal(execution.targetRow(), undefined); await unchanged(w);
});


/** The existing ID dependency supplies model-result lifetime evidence. There is
 * no authored id field or id field grant, and the source is not an input slot. */
async function identityWorld(role: 'data' | 'control' = 'data', shape: Shape = 'singular') {
  const w = await world(shape, true), original = artifact(shape);
  const descriptors: ArtifactDescriptorSlice = { ...original, operations: original.operations!.map(operation => ({
    ...operation, result: { type: PROFILE as CanTypeId, disclosure: { version: 1, source, returns: [{
      id: 'identity-return', source, influences: [], dependencies: [
        { id: 'branch-profile', source, role: 'data', model: BRANCH, field: 'profile',
          type: `${PROFILE}${shape === 'nullable' ? '?' : shape === 'array' ? '[]!' : ''}` as CanTypeId },
        { id: 'profile-id', source, role, model: PROFILE, field: 'id', type: 'text' as CanTypeId },
        { id: 'branch-title', source, role: 'control', model: BRANCH, field: 'title', type: 'text' as CanTypeId },
      ],
    }] } },
  })) };
  // Shared observations may appear in distinct checked return paths. The
  // normalized ID inventory is declaration-based, not object-pointer-based.
  const branched: ArtifactDescriptorSlice = { ...descriptors, operations: descriptors.operations!.map(operation => ({
    ...operation, result: { ...operation.result!, disclosure: { ...operation.result!.disclosure!, returns: [
      ...operation.result!.disclosure!.returns,
      ...operation.result!.disclosure!.returns.map(returned => ({ ...returned, id: 'other-identity-return' })),
    ] } },
  })) };
  const loaded = loadArtifactDescriptors(branched, { by: 'members' });
  const def = loaded.registry.get(OP); assert.ok(def && isGeneratedOperationDef(def));
  const targetRead = w.readPolicies.get(PROFILE)!; assert.ok('grants' in targetRead);
  w.readPolicies.set(PROFILE, { ...targetRead, grants: targetRead.grants.map(grant => ({
    ...grant, fields: grant.fields.filter(field => field !== 'id'),
  })) });
  bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy: w.policy, readPolicies: w.readPolicies });
  const rows = [
    { model: CONVERSATION, row: makeRow({ id: 'conversation', createdBy: w.caller.user_id, data: { title: 'Owning conversation' } }) },
    { model: PROFILE, row: makeRow({ id: 'profile', createdBy: w.caller.user_id, data: { active: true } }) },
    { model: BRANCH, row: { ...makeRow({ id: 'branch', createdBy: w.caller.user_id,
      data: { title: 'Owning branch', profile: { id: 'profile' } } }), parent: { model: CONVERSATION, id: asId('conversation') } } },
  ];
  await w.store.commit(makeBatch(await w.store.readRevision(), { writes: rows.map(value => ({ kind: 'insert', ...value })) }));
  const stored = await Promise.all(rows.map(async ({ model, row }) => {
    const current = await w.store.load(model, row.id); assert.ok(current); return { model, row: current };
  }));
  return { ...w, registry: loaded.registry, rows: stored };
}
type IdentityWorld = Awaited<ReturnType<typeof identityWorld>>;
function identityInput(w: IdentityWorld, mode: 'normal' | 'unobserved' | 'copied-source' | 'copied-target' | 'missing-id' | 'foreign-pair' | 'stale-stage' = 'normal',
  after?: (session: Session) => Promise<void>) {
  let receipt: Receipt | undefined, executions = 0;
  return { request: { ...w, observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
    executions++;
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds: { maxRows: 10, maxWork: 1000 } });
    assert.deepEqual(call.recordRefs, [], 'promotion source is an owner-issued row, not an admitted parameter');
    const branch = await session.read(BRANCH, asId('branch')); assert.ok(branch);
    if (mode !== 'unobserved') await observeScenarioReceiptDependency(call, w.store,
      { dependencyId: 'branch-profile', model: BRANCH, row: branch, field: 'profile' });
    await observeScenarioReceiptDependency(call, w.store,
      { dependencyId: 'branch-title', model: BRANCH, row: branch, field: 'title' });
    if (mode === 'stale-stage') await session.stage({ op: 'update', model: BRANCH, id: branch.id, data: { title: 'Later stage' } }, cause);
    const read = w.shape === 'nullable' ? readScenarioReceiptNullableStoredReferenceRow : readScenarioReceiptStoredReferenceRow;
    const target = await read(call, w.store, { sourceDependencyId: 'branch-profile',
      scalarLeafDependencyId: mode === 'foreign-pair' ? 'branch-title' : 'profile-id',
      sourceRow: mode === 'copied-source' ? { ...branch } : branch }); assert.ok(target);
    assert.equal(target.id, 'profile'); assert.equal(Object.hasOwn(target.data, 'id'), false);
    if (mode !== 'missing-id') await observeScenarioReceiptRowId(call, w.store,
      { dependencyId: 'profile-id', model: PROFILE, row: mode === 'copied-target' ? { ...target } : target });
    const result = await bindScenarioReceiptModelResult(call, w.store, { returnId: 'identity-return', row: target });
    await after?.(session); selectScenarioReceiptReturn(call, w.store, 'identity-return');
    return { ...await session.finalize(), result, outbox: [] };
  } }, receipt: () => receipt, executions: () => executions };
}
async function existingRowsUnchanged(w: IdentityWorld) {
  for (const { model, row } of w.rows) {
    assert.deepEqual(await w.store.load(model, row.id), row);
    assert.deepEqual(await w.store.historyFor(model, row.id), []);
  }
  assert.deepEqual(await w.store.outboxPending(), []);
}

test('observed owner-row reference promotes reserved DATA identity without an id field/grant and returns its existing lifetime with zero writes', async () => {
  const w = await identityWorld(), execution = identityInput(w);
  assert.equal((await invoke(execution.request)).status, 'committed');
  const receipt = execution.receipt(); assert.ok(receipt && receipt.outcome.status === 'committed');
  assert.deepEqual(receipt.outcome.result, { id: 'profile' }); assert.deepEqual(receipt.outcome.recordVersions, []);
  const saved = readScenarioReceiptAssociation(receipt)!; assert.deepEqual(saved.changed, []);
  assert.deepEqual(saved.observations.map(value => [value.dependencyId, value.model, value.row.id]), [
    ['branch-profile', BRANCH, 'branch'], ['branch-title', BRANCH, 'branch'], ['profile-id', PROFILE, 'profile'],
  ]);
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: { id: 'profile' }, records: [] });
  await existingRowsUnchanged(w);
  const revision = await w.store.readRevision();
  assert.equal((await invoke(execution.request)).status, 'replayed'); assert.equal(execution.executions(), 1);
  assert.equal(await w.store.readRevision(), revision); await existingRowsUnchanged(w);
});

test('identity promotion rejects unobserved, copied, crossed-stage and foreign-pair sources and requires the target DATA identity observer', async () => {
  for (const mode of ['unobserved', 'copied-source', 'stale-stage', 'foreign-pair', 'copied-target', 'missing-id'] as const) {
    const w = await identityWorld(); await assert.rejects(invoke(identityInput(w, mode).request), refuses);
    await existingRowsUnchanged(w);
  }
  for (const shape of ['singular', 'nullable', 'array'] as const) {
    const w = await identityWorld(shape === 'singular' ? 'control' : 'data', shape);
    await assert.rejects(invoke(identityInput(w).request), refuses); await existingRowsUnchanged(w);
  }
});

test('promoted identity keeps source/target/ancestor and both related Identity grants through commit and saved recovery', async () => {
  for (const loss of ['source', 'target', 'ancestor', 'source-member', 'target-member'] as const) {
    const lose = async (w: IdentityWorld) => {
      if (loss === 'source') w.access.branch = false;
      else if (loss === 'target') w.access.target = false;
      else if (loss === 'ancestor') w.access.ancestor = false;
      else await w.memberships.removeMembership((loss === 'source-member' ? w.reader : w.targetReader).membership_id);
    };
    const w = await identityWorld();
    await assert.rejects(invoke(identityInput(w, 'normal', () => lose(w)).request), refuses);
    await existingRowsUnchanged(w);
    const saved = await identityWorld(), execution = identityInput(saved);
    await invoke(execution.request); const receipt = execution.receipt(); assert.ok(receipt);
    await lose(saved); const revision = await saved.store.readRevision();
    assert.deepEqual(await projectScenarioReceipt({ ...saved, receipt }), { result: null, records: [] });
    assert.equal((await invoke(execution.request)).status, 'replayed'); assert.equal(execution.executions(), 1);
    assert.equal(await saved.store.readRevision(), revision); await existingRowsUnchanged(saved);
    saved.access.branch = true; saved.access.target = true; saved.access.ancestor = true;
    if (loss === 'source-member' || loss === 'target-member') await saved.memberships.reactivateMembership(
      (loss === 'source-member' ? saved.reader : saved.targetReader).membership_id, { is_owner: false, roles: [] });
    assert.deepEqual(await projectScenarioReceipt({ ...saved, receipt }), { result: { id: 'profile' }, records: [] });
  }
});

test('promoted model identity cannot survive target removal/recreation and late failure rolls back owner mutations', async () => {
  for (const mode of ['remove', 'recreate', 'reject'] as const) {
    const w = await identityWorld();
    const rejection = new StateError('rule_failed', 'Late business rejection after target identity');
    await assert.rejects(invoke(identityInput(w, 'normal', async session => {
      if (mode === 'reject') {
        await session.stage({ op: 'update', model: BRANCH, id: asId('branch'), data: { title: 'Must roll back' } }, cause);
        throw rejection;
      }
      await session.stage({ op: 'remove', model: PROFILE, id: asId('profile') }, cause);
      if (mode === 'recreate') await session.stage({ op: 'create', model: PROFILE, id: asId('profile'), data: { active: true } }, cause);
    }).request), mode === 'reject' ? error => error === rejection : refuses);
    await existingRowsUnchanged(w);
  }
});

/** Reuse the original owner/source/authority fixture. The self-reference uses
 * distinct source and target occurrences and each actual getter has its own
 * observation; promotion itself does not manufacture leaf evidence. */
async function referenceLeafWorld(existing = false, leafShape: Shape = 'singular') {
  const w = await world('singular', true, leafShape);
  const rows = [
    { model: CONVERSATION, row: makeRow({ id: 'conversation', createdBy: w.caller.user_id, data: { title: 'Conversation' } }) },
    { model: PROFILE, row: makeRow({ id: 'profile', createdBy: w.caller.user_id,
      data: { active: true, next: leafShape === 'array' ? [{ id: 'next' }] : { id: 'next' } } }) },
    { model: PROFILE, row: makeRow({ id: 'next', createdBy: w.caller.user_id,
      data: { active: true, next: leafShape === 'array' ? [{ id: 'next' }] : { id: 'next' } } }) },
    { model: BRANCH, row: { ...makeRow({ id: 'branch', createdBy: w.caller.user_id,
      data: { title: 'Branch', profile: { id: 'profile' } } }), parent: { model: CONVERSATION, id: asId('conversation') } } },
  ];
  if (existing) await w.store.commit(makeBatch(await w.store.readRevision(), {
    writes: rows.map(value => ({ kind: 'insert', ...value })),
  }));
  const stored = existing ? await Promise.all(rows.map(async ({ model, row }) => {
    const current = await w.store.load(model, row.id); assert.ok(current); return { model, row: current };
  })) : rows;
  return { ...w, rows: stored, existing };
}
type ReferenceLeafWorld = Awaited<ReturnType<typeof referenceLeafWorld>>;
type LeafMode = 'normal' | 'unobserved' | 'copied-source' | 'wrong-source' | 'wrong-leaf' | 'same-occurrence' |
  'stale-stage' | 'missing-leaf' | 'copied-target' | 'pending';
function referenceLeafInput(w: ReferenceLeafWorld, mode: LeafMode = 'normal', after?: (session: Session) => Promise<void>) {
  let receipt: Receipt | undefined, executions = 0, promoted = false;
  return { request: { ...w, observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
    executions++;
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds: { maxRows: 10, maxWork: 1000 } });
    if (!w.existing) for (const { model, row } of w.rows) await session.stage({ op: 'create', model, id: row.id,
      data: row.data, ...(row.parent === null ? {} : { parent: row.parent }) }, cause);
    const branch = await session.read(BRANCH, asId('branch')); assert.ok(branch);
    const sourceWire = branch.data.profile; assert.deepEqual(sourceWire, { id: 'profile' });
    if (mode !== 'unobserved') await observeScenarioReceiptDependency(call, w.store,
      { dependencyId: 'branch-profile', model: BRANCH, row: branch, field: 'profile' });
    if (mode === 'stale-stage') await session.stage({ op: 'update', model: BRANCH, id: branch.id, data: { title: 'Later' } }, cause);
    const promote = () => readScenarioReceiptStoredReferenceRow(call, w.store, {
      sourceDependencyId: mode === 'wrong-source' ? 'profile-next' : 'branch-profile',
      scalarLeafDependencyId: mode === 'wrong-leaf' ? 'branch-title' : mode === 'same-occurrence' ? 'branch-profile' : 'profile-next',
      sourceRow: mode === 'copied-source' ? { ...branch } : branch,
    });
    if (mode === 'pending') {
      const results = await Promise.allSettled([promote(), promote()]);
      assert.ok(results.some(result => result.status === 'rejected' && refuses(result.reason)));
    }
    const profile = await promote(); promoted = true;
    assert.equal(profile.id, 'profile');
    const leafWire = profile.data.next; assert.deepEqual(leafWire, { id: 'next' });
    if (mode !== 'missing-leaf') await observeScenarioReceiptDependency(call, w.store,
      { dependencyId: 'profile-next', model: PROFILE, row: mode === 'copied-target' ? { ...profile } : profile, field: 'next' });
    // The required reference leaf is itself the observed source of the next
    // original read. Its genuine receiver is issued by the existing bridge.
    const next = await readScenarioReceiptStoredReferenceRow(call, w.store,
      { sourceDependencyId: 'profile-next', scalarLeafDependencyId: 'next-active', sourceRow: profile });
    assert.equal(next.id, 'next'); const active = next.data.active;
    await observeScenarioReceiptDependency(call, w.store,
      { dependencyId: 'next-active', model: PROFILE, row: next, field: 'active' });
    await after?.(session); selectScenarioReceiptReturn(call, w.store, 'active-return');
    return { ...await session.finalize(), result: active, outbox: [] };
  } }, receipt: () => receipt, executions: () => executions, promoted: () => promoted };
}
async function referenceLeafUnchanged(w: ReferenceLeafWorld) {
  for (const { model, row } of w.rows) {
    assert.deepEqual(await w.store.load(model, row.id), w.existing ? row : null);
    assert.deepEqual(await w.store.historyFor(model, row.id), []);
  }
  assert.deepEqual(await w.store.outboxPending(), []);
}

test('required Model-reference leaf issues genuine provisional and existing receivers and preserves separate chained observations', async () => {
  for (const existing of [false, true]) {
    const w = await referenceLeafWorld(existing), execution = referenceLeafInput(w);
    assert.equal((await invoke(execution.request)).status, 'committed');
    const receipt = execution.receipt(); assert.ok(receipt);
    assert.deepEqual(readScenarioReceiptAssociation(receipt)!.observations.map(value =>
      [value.dependencyId, value.model, value.row.id]), [
      ['branch-profile', BRANCH, 'branch'], ['profile-next', PROFILE, 'profile'], ['next-active', PROFILE, 'next'],
    ]);
    assert.equal((await projectScenarioReceipt({ ...w, receipt })).result, true);
    const revision = await w.store.readRevision();
    assert.equal((await invoke(execution.request)).status, 'replayed'); assert.equal(execution.executions(), 1);
    assert.equal(await w.store.readRevision(), revision);
    if (existing) await referenceLeafUnchanged(w);
  }
});

test('reference leaf refuses substituted source/leaf/model occurrences, missing observations, stage or pending misuse and nullable/array leaves', async () => {
  for (const mode of ['unobserved', 'copied-source', 'wrong-source', 'wrong-leaf', 'same-occurrence',
    'stale-stage', 'missing-leaf', 'copied-target', 'pending'] as const) {
    const w = await referenceLeafWorld(true);
    await assert.rejects(invoke(referenceLeafInput(w, mode).request), refuses); await referenceLeafUnchanged(w);
  }
  for (const shape of ['nullable', 'array'] as const) {
    const w = await referenceLeafWorld(true, shape), execution = referenceLeafInput(w);
    await assert.rejects(invoke(execution.request), refuses); assert.equal(execution.promoted(), false);
    await referenceLeafUnchanged(w);
  }
});

test('reference leaf retains source/target/ancestor and both related Identity grants at final effects and saved replay, with restoration', async () => {
  for (const loss of ['source', 'target', 'ancestor', 'source-member', 'target-member'] as const) {
    const lose = async (w: ReferenceLeafWorld) => {
      if (loss === 'source') w.access.branch = false;
      else if (loss === 'target') w.access.target = false;
      else if (loss === 'ancestor') w.access.ancestor = false;
      else await w.memberships.removeMembership((loss === 'source-member' ? w.reader : w.targetReader).membership_id);
    };
    const w = await referenceLeafWorld(true);
    await assert.rejects(invoke(referenceLeafInput(w, 'normal', () => lose(w)).request), refuses);
    await referenceLeafUnchanged(w);
    const saved = await referenceLeafWorld(true), execution = referenceLeafInput(saved);
    await invoke(execution.request); const receipt = execution.receipt(); assert.ok(receipt);
    await lose(saved); const revision = await saved.store.readRevision();
    assert.deepEqual(await projectScenarioReceipt({ ...saved, receipt }), { result: null, records: [] });
    assert.equal((await invoke(execution.request)).status, 'replayed'); assert.equal(execution.executions(), 1);
    assert.equal(await saved.store.readRevision(), revision); await referenceLeafUnchanged(saved);
    saved.access.branch = true; saved.access.target = true; saved.access.ancestor = true;
    if (loss === 'source-member' || loss === 'target-member') await saved.memberships.reactivateMembership(
      (loss === 'source-member' ? saved.reader : saved.targetReader).membership_id, { is_owner: false, roles: [] });
    assert.equal((await projectScenarioReceipt({ ...saved, receipt })).result, true);
  }
});

test('required reference leaf lifetime drift and original late business errors preserve rollback and error identity', async () => {
  for (const mode of ['remove', 'recreate', 'reject'] as const) {
    const w = await referenceLeafWorld(true), rejection = new StateError('rule_failed', 'Original business rejection after reference leaf');
    await assert.rejects(invoke(referenceLeafInput(w, 'normal', async session => {
      if (mode === 'reject') {
        await session.stage({ op: 'update', model: BRANCH, id: asId('branch'), data: { title: 'Rollback' } }, cause);
        throw rejection;
      }
      await session.stage({ op: 'remove', model: PROFILE, id: asId('profile') }, cause);
      if (mode === 'recreate') await session.stage({ op: 'create', model: PROFILE, id: asId('profile'),
        data: { active: true, next: { id: 'next' } } }, cause);
    }).request), mode === 'reject' ? error => error === rejection : refuses);
    await referenceLeafUnchanged(w);
  }
});

test('reference leaf refuses its original revision drift before receiver exposure and succeeds only after fresh admission', async () => {
  const w = await referenceLeafWorld(true); let moved = false;
  w.targetControl.duringRead = async () => {
    delete w.targetControl.duringRead; moved = true;
    await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'insert', model: CONVERSATION,
      row: makeRow({ id: 'foreign-revision', createdBy: w.caller.user_id, data: { title: 'Concurrent write' } }) }] }));
  };
  const execution = referenceLeafInput(w); let originalConflict: StateError | undefined;
  const outcome = await invoke({ ...execution.request, execute: async call => {
    try { return await execution.request.execute(call); }
    catch (error) {
      assert.ok(error instanceof StateError); assert.equal(error.code, 'conflict');
      assert.equal(execution.executions(), 1); assert.equal(execution.promoted(), false,
        'the original admitted attempt must refuse before exposing its receiver');
      originalConflict = error; throw error;
    }
  } });
  assert.ok(originalConflict); assert.equal(moved, true);
  assert.equal(outcome.status, 'committed'); assert.equal(execution.executions(), 2,
    'Invoke retries the failed fence with fresh admission after the one concurrent write');
  await referenceLeafUnchanged(w);
});
