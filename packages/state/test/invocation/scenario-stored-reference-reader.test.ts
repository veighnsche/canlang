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
  projectScenarioReceipt } from '../../src/invocation/scenario-receipt.js';
import { asId, asModel, FIXED_NOW, makeIdentity, makeEnvelope, uuidv7 } from './fixtures.js';

const CONVERSATION = asModel('ReferenceReader.Conversation'), BRANCH = asModel('ReferenceReader.Branch'), PROFILE = asModel('ReferenceReader.Profile');
const OP = 'ReferenceReader.active', APP = 'stored-reference-reader', cause = { cause: 'scenario' } as const;
const source = { path: 'stored-reference-reader.can', module: 'stored-reference-reader.mjs', sha256: 'd'.repeat(64) };
let sequence = 120_000;
type Shape = 'singular' | 'nullable' | 'array';
function artifact(shape: Shape = 'singular'): ArtifactDescriptorSlice {
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
      { name: PROFILE, deleteMode: 'remove', fields: [{ name: 'active', field: { kind: 'boolean' }, valueType: 'bool' as CanTypeId, required: true, serverOnly: false }] },
    ], operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [] }, result: { type: 'bool' as CanTypeId,
      disclosure: { version: 1, source, returns: [
        { id: 'active-return', source, influences: [], dependencies: [
          { id: 'branch-profile', source, role: 'control', model: BRANCH, field: 'profile', type },
          { id: 'profile-active', source, role: 'data', model: PROFILE, field: 'active', type: 'bool' as CanTypeId },
        ] },
        { id: 'foreign-return', source, influences: [], dependencies: [
          { id: 'branch-title', source, role: 'data', model: BRANCH, field: 'title', type: 'text' as CanTypeId },
        ] },
      ] } } }],
  };
}
async function world(shape: Shape = 'singular', targetOnlyMember = false) {
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
  const store = createMemoryStorage(), loaded = loadArtifactDescriptors(artifact(shape), { by: 'members' });
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
    [PROFILE, { fields: ['active'], secretFields: [], grants: [{ fields: ['id', 'active'], read: async ({ context, row }) => {
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
