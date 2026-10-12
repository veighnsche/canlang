/** Actual State receiver + Dev private frame controls over handbound source metadata.
 * Exercises genuine current/ancestor/Identity/final authority; no Compiler native qualification. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ModelName, Receipt, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '@canlang/state/errors';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { buildModelTableFromCanonical } from '@canlang/state/mutation/models';
import { buildPolicyTable } from '@canlang/state/policy/grants';
import type { ViewerSourceReadPolicy } from '@canlang/state/query';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '@canlang/state/invocation/registry';
import { invoke } from '@canlang/state/invocation/invoke';
import type { AdmittedCall } from '@canlang/state/invocation';
import { beginScenarioReceiptMutation, bindScenarioReceiptReferenceProducer,   readScenarioReceiptStoredReferenceRow, selectScenarioReceiptReturn, readScenarioReceiptAssociation,
  projectScenarioReceipt } from '@canlang/state/invocation';
import { asId, asModel, FIXED_NOW, makeIdentity, makeEnvelope, uuidv7, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';

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
    ], operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [{name: 'branch', field: {kind: 'ref', model: BRANCH, requireVersion: true}, required: true}] }, result: { type: 'bool' as CanTypeId,
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
async function world(shape: Shape = 'singular') {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const user = await memberships.createUser({ email: 'reference-reader@example.test', password_hash: 'test-only', email_verified: true });
  const caller = await memberships.createMembership({ team_id: team.team_id, user_id: user.user_id, roles: [], is_owner: false });
  const readerUser = await memberships.createUser({ email: 'reference-authority@example.test', password_hash: 'test-only', email_verified: true });
  const reader = await memberships.createMembership({ team_id: team.team_id, user_id: readerUser.user_id, roles: [], is_owner: false });
  const physical = createMemoryStorage(), batches: import('@canlang/contracts').CommitBatch[] = [];
  const store = {...physical, commit: async (batch: import('@canlang/contracts').CommitBatch) => {batches.push(batch); return physical.commit(batch);}}, loaded = loadArtifactDescriptors(artifact(shape), { by: 'members' });
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
      const related = await context.memberships.findMembership(team.team_id, readerUser.user_id);
      const duringRead = targetControl.duringRead; if (duringRead !== undefined) await duringRead();
      return related?.status === 'active';
    } }] }],
  ]);
  bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  return { store, batches, memberships, caller, reader, table, access, policy, readPolicies, targetControl, shape, registry: loaded.registry,
    app: APP, source: 'test', identity: makeIdentity({ userId: user.user_id, team, membership: caller }),
    clock: { nowMs: () => FIXED_NOW }, envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), {}) };
}

import {createContext} from './context.js';
import {bindNativeRecord} from './native-records.js';
import {decodeValue, isRecordRef} from '@canlang/values';
import {openScenarioReceiptFrame, type ScenarioReceiptFrame, readScenarioReceiptStoredReference,
  observeScenarioReceiptDependency as nativeObserve} from './scenario-receipt-frame.js';

type World = Awaited<ReturnType<typeof world>>;
type Mode = 'normal' | 'public-ref' | 'copy' | 'unobserved' | 'wrong-pair' | 'stale-stage' | 'closed' |
  'version' | 'archived' | 'copied-target' | 'missing-leaf' | 'pending' | 'navigation-revoke';
const refuses = (error: unknown) => error instanceof StateError;
async function setup(w: World, mode: Mode) {
  const creator = w.identity.actor!.user_id;
  const conversation = makeRow({id: 'conversation', createdBy: creator, data: {title: 'Actual ancestor'}});
  const profile = {...makeRow({id: 'profile', createdBy: creator, data: {active: false}}),
    ...(mode === 'archived' ? {archivedAt: FIXED_NOW} : {})};
  const branch = {...makeRow({id: 'branch', createdBy: creator, data: {title: 'Original source',
    profile: {id: 'profile', ...(mode === 'version' ? {version: '1'} : {})}}}), parent: {model: CONVERSATION, id: conversation.id}};
  await w.store.commit(makeBatch(await w.store.readRevision(), {writes: [
    {kind: 'insert', model: CONVERSATION, row: conversation}, {kind: 'insert', model: PROFILE, row: profile},
    {kind: 'insert', model: BRANCH, row: branch},
  ]}));
  const storedConversation = await w.store.load(CONVERSATION, conversation.id),
    storedProfile = await w.store.load(PROFILE, profile.id), storedBranch = await w.store.load(BRANCH, branch.id);
  assert.ok(storedConversation && storedProfile && storedBranch);
  return {conversation: storedConversation, profile: storedProfile, branch: storedBranch};
}
function execution(w: World, mode: Mode) {
  let receipt: Receipt | undefined, exposed = 0, calls = 0, receiverReads = 0;
  const request = {...w, observeCommittedReceipt: (value: Receipt) => {receipt = value;}, execute: async (call: AdmittedCall) => {
    calls++;
    const session = await beginScenarioReceiptMutation(call, w.store, {table: w.table, bounds: {maxRows: 10, maxWork: 1000}});
    // Real own write makes the target readable. Physical Profile remains false;
    // the actual State receiver must authorize the current owner-stage row.
    if (mode !== 'archived') await session.stage({op: 'update', model: PROFILE, id: asId('profile'), data: {active: true}}, cause);
    const sourceRow = await session.read(BRANCH, asId('branch')); assert.ok(sourceRow);
    const c = createContext({caller: {userId: w.identity.actor!.user_id, roles: []}, store: w.store, qualified: call.context});
    let frame!: ScenarioReceiptFrame;
    const origins = new WeakMap<object, {view: object; wire: unknown}>();
    const sourceView: Record<string, unknown> = {};
    Object.defineProperty(sourceView, 'profile', {get: () => {
      const wire = sourceRow.data.profile, ref = decodeValue(PROFILE, wire);
      assert.ok(isRecordRef(ref)); origins.set(ref, {view: sourceView, wire}); return ref;
    }});
    bindNativeRecord(sourceView, BRANCH, sourceRow.id, sourceRow.version); Object.freeze(sourceView);
    frame = openScenarioReceiptFrame(c, call, w.store, () => {}, undefined, undefined, undefined,
      async (ref, sourceDependencyId, scalarLeafDependencyId, healthy, captureSource) => {
        const origin = typeof ref === 'object' && ref !== null ? origins.get(ref) : undefined;
        if (origin === undefined || !isRecordRef(ref)) throw new StateError('validation', 'Reference is not its original private getter binding.');
        const source = captureSource(origin.view, BRANCH, 'profile', origin.wire);
        if (mode === 'stale-stage') await session.stage({op: 'update', model: BRANCH, id: source.id, data: {title: 'Later stage'}}, cause);
        if (mode === 'pending') await readScenarioReceiptStoredReference(c, ref, sourceDependencyId, scalarLeafDependencyId);
        receiverReads++;
        const row = await readScenarioReceiptStoredReferenceRow(call, w.store, {sourceDependencyId, scalarLeafDependencyId, sourceRow: source});
        healthy();
        if (mode === 'navigation-revoke') {
          // Model only the invoke host's post-issuer navigation await. The
          // actual SDK revocation precedes a second installed State check;
          // no scalar view or native/runtime qualification is supplied here.
          await w.memberships.removeMembership(w.reader.membership_id);
        }
        if (mode === 'closed') frame.close();
        if (ref.version !== undefined && ref.version !== BigInt(row.version)) throw new StateError('conflict', 'Original evaluated reference version changed');
        healthy(); captureSource(origin.view, BRANCH, 'profile', origin.wire);
        receiverReads++;
        const current = await readScenarioReceiptStoredReferenceRow(call, w.store,
          {sourceDependencyId, scalarLeafDependencyId, sourceRow: source});
        healthy();
        assert.notStrictEqual(current, row, 'unchanged-stage receiver issues a fresh genuine pointer');
        assert.deepEqual(current, row, 'the prepared genuine row must retain every current target fact');
        captureSource(origin.view, BRANCH, 'profile', origin.wire);
        const bound = mode === 'copied-target' ? {...row} : row;
        const view: Record<string, unknown> = Object.freeze({active: decodeValue('bool', bound.data.active)});
        bindNativeRecord(view, PROFILE, row.id, row.version); frame.bind(view, PROFILE, () => bound); exposed++; return view;
      });
    frame.bind(sourceView, BRANCH, () => sourceRow); frame.bindAdmittedReference(sourceView, call.recordRefs[0]!);
    try {
      const ref = sourceView.profile;
      if (mode !== 'unobserved') await nativeObserve(c, BRANCH, sourceView, 'profile', 'branch-profile');
      const operand = mode === 'copy' ? {...(ref as object)} : mode === 'public-ref' ? decodeValue(PROFILE, sourceRow.data.profile) : ref;
      const profile = await readScenarioReceiptStoredReference(c, operand, 'branch-profile',
        mode === 'wrong-pair' ? 'branch-title' : 'profile-active');
      const active = profile.active;
      if (mode !== 'missing-leaf') await nativeObserve(c, PROFILE, profile, 'active', 'profile-active');
      selectScenarioReceiptReturn(call, w.store, 'active-return'); frame.assertCompleted();
      return {...await session.finalize(), result: active, outbox: []};
    } finally {frame.close();}
  }};
  return {request, receipt: () => receipt, exposed: () => exposed, calls: () => calls, receiverReads: () => receiverReads};
}
async function requestWorld(mode: Mode) {
  const w = await world(), rows = await setup(w, mode);
  w.envelope = makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), {branch: {id: rows.branch.id, version: String(rows.branch.version)}});
  return {w, rows};
}
async function noEffects(w: World, rows: Awaited<ReturnType<typeof setup>>, before: number) {
  for (const [model, row] of [[CONVERSATION, rows.conversation], [BRANCH, rows.branch], [PROFILE, rows.profile]] as const) {
    assert.deepEqual(await w.store.load(model, row.id), row); assert.deepEqual(await w.store.historyFor(model, row.id), []);
  }
  assert.equal(w.batches.length, before + 1); const rejected = w.batches.at(-1)!;
  assert.deepEqual(rejected.writes, []); assert.deepEqual(rejected.history, []); assert.deepEqual(rejected.outbox, []);
  assert.deepEqual(rejected.schedules, []); assert.deepEqual(rejected.uniqueClaims, []); assert.deepEqual(rejected.uniqueReleases, []);
  assert.equal(rejected.receipt?.outcome.status, 'rejected');
}
test('actual receiver bridges original native source to genuine provisional scalar, separate marker and replay', async () => {
  const {w} = await requestWorld('normal'), run = execution(w, 'normal');
  assert.equal((await invoke(run.request)).status, 'committed'); assert.equal(run.exposed(), 1);
  assert.equal(run.receiverReads(), 2);
  const receipt = run.receipt(); assert.ok(receipt); const saved = readScenarioReceiptAssociation(receipt)!;
  assert.deepEqual(saved.observations.map(item => [item.dependencyId, item.model, item.row.id]),
    [['branch-profile', BRANCH, 'branch'], ['profile-active', PROFILE, 'profile']]);
  assert.equal(saved.observations[1]!.row.data.active, true); assert.equal(saved.observations[1]!.row.version, 2);
  assert.equal((await projectScenarioReceipt({...w, receipt})).result, true);
  const revision = await w.store.readRevision(); assert.equal((await invoke(run.request)).status, 'replayed');
  assert.equal(run.calls(), 1); assert.equal(run.exposed(), 1); assert.equal(await w.store.readRevision(), revision);
});
test('private bridge refuses substitutions, missing original markers and crossed stage/lifetime without domain effects', async () => {
  for (const mode of ['public-ref', 'copy', 'unobserved', 'wrong-pair', 'stale-stage', 'closed', 'version', 'archived', 'copied-target', 'missing-leaf', 'pending'] as const) {
    const {w, rows} = await requestWorld(mode), run = execution(w, mode), before = w.batches.length;
    await assert.rejects(invoke(run.request), refuses, mode); await noEffects(w, rows, before);
    await assert.rejects(invoke(run.request), refuses); assert.equal(w.batches.length, before + 1);
  }
});

test('private host navigation await rechecks actual related Identity before scalar exposure', async () => {
  const {w, rows} = await requestWorld('navigation-revoke'), run = execution(w, 'navigation-revoke'), before = w.batches.length;
  await assert.rejects(invoke(run.request), refuses);
  assert.equal(run.receiverReads(), 2, 'genuine first issuance followed by strict post-navigation receiver refusal');
  assert.equal(run.exposed(), 0); assert.equal(run.calls(), 1);
  await noEffects(w, rows, before);
  await assert.rejects(invoke(run.request), refuses);
  assert.equal(run.receiverReads(), 2); assert.equal(run.exposed(), 0); assert.equal(run.calls(), 1);
  assert.equal(w.batches.length, before + 1);
});
