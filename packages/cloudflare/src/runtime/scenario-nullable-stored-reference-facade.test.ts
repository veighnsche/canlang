/** Dev private-frame component controls with genuine State/Identity.
 * The getter recorder and callback9 are handbound here. This does not execute
 * invoke.ts's getter/host callback or an actual Compiler-produced native caller. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, CommitBatch, ModelName, Receipt, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '@canlang/state/errors';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { buildModelTableFromCanonical } from '@canlang/state/mutation/models';
import { buildPolicyTable } from '@canlang/state/policy/grants';
import type { ViewerSourceReadPolicy } from '@canlang/state/query';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '@canlang/state/invocation/registry';
import { invoke } from '@canlang/state/invocation/invoke';
import type { AdmittedCall } from '@canlang/state/invocation';
import { beginScenarioReceiptMutation, bindScenarioReceiptReferenceProducer, bindScenarioReceiptModelResult,
  readScenarioReceiptNullableStoredReferenceRow, readScenarioReceiptAssociation, selectScenarioReceiptReturn } from '@canlang/state/invocation';
import { asId, asModel, FIXED_NOW, makeIdentity, makeEnvelope, uuidv7, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { decodeValue, isRecordRef } from '@canlang/values';
import { createContext } from './context.js';
import { bindNativeRecord } from './native-records.js';
import { openScenarioReceiptFrame, type ScenarioReceiptFrame, readScenarioReceiptNullableStoredReference,
  observeScenarioReceiptDependency as nativeObserve } from './scenario-receipt-frame.js';

const CONVERSATION = asModel('NullableFrame.Conversation'), TEMPLATE = asModel('NullableFrame.Template');
const REVISION = asModel('NullableFrame.Revision'), RUN = asModel('NullableFrame.Run');
const OP = 'NullableFrame.generate', APP = 'nullable-frame-component', cause = { cause: 'scenario' } as const;
const source = { path: 'nullable-frame-component.can', module: 'nullable-frame-component.mjs', sha256: 'b'.repeat(64) };
const currentType = `${REVISION}?` as CanTypeId;
let sequence = 126_000;
const refuses = (error: unknown) => error instanceof StateError;
type Mode = 'normal' | 'null' | 'copied-source' | 'copied-ref' | 'missing-getter' | 'missing-marker' |
  'getter-after-marker' | 'reused-getter' | 'caught-copy' | 'pending-caught' | 'closed' |
  'missing-digest-control' | 'copied-digest-row' | 'digest-stage' | 'navigation-revoke';

function artifact(): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: `export const identity="${OP}";`, map: { version: 3, file: source.module,
      sources: [source.path], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: source.module, export: 'identity', member: ['generate'] }],
    models: [
      { name: CONVERSATION, deleteMode: 'remove', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] },
      { name: TEMPLATE, parent: CONVERSATION, deleteMode: 'remove', fields: [
        { name: 'title', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: true, serverOnly: false },
        { name: 'current', field: { kind: 'ref', model: REVISION }, valueType: currentType, nullable: true, required: false, serverOnly: false },
      ] },
      { name: REVISION, parent: TEMPLATE, deleteMode: 'remove', fields: [
        { name: 'published', field: { kind: 'boolean' }, valueType: 'bool' as CanTypeId, required: true, serverOnly: false },
        { name: 'digest', field: { kind: 'string' }, valueType: 'text?' as CanTypeId, nullable: true, required: false, serverOnly: false },
      ] },
      { name: RUN, parent: TEMPLATE, deleteMode: 'remove', fields: [{ name: 'digest', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: true, serverOnly: false }] },
    ], operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'template', field: { kind: 'ref', model: TEMPLATE, requireVersion: true }, required: true },
    ] }, result: { type: RUN as CanTypeId, disclosure: { version: 1, source, returns: [
      { id: 'created-run', source, influences: [], dependencies: [
        { id: 'current-control', source, role: 'control', model: TEMPLATE, field: 'current', type: currentType },
        { id: 'published-control', source, role: 'control', model: REVISION, field: 'published', type: 'bool' as CanTypeId },
        { id: 'current-data', source, role: 'data', model: TEMPLATE, field: 'current', type: REVISION as CanTypeId },
        { id: 'digest-control', source, role: 'control', model: REVISION, field: 'digest', type: 'text?' as CanTypeId },
        { id: 'digest-data', source, role: 'data', model: REVISION, field: 'digest', type: 'text' as CanTypeId },
      ] },
    ] } } }],
  };
}

async function world(mode: Mode = 'normal', absent = mode === 'null') {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const user = await memberships.createUser({ email: 'nullable-frame@example.test', password_hash: 'test-only', email_verified: true });
  const caller = await memberships.createMembership({ team_id: team.team_id, user_id: user.user_id, roles: [], is_owner: false });
  const relatedUser = await memberships.createUser({ email: 'nullable-frame-related@example.test', password_hash: 'test-only', email_verified: true });
  const related = await memberships.createMembership({ team_id: team.team_id, user_id: relatedUser.user_id, roles: [], is_owner: false });
  const physical = createMemoryStorage(), batches: CommitBatch[] = [];
  let targetLoads = 0, targetGrants = 0;
  const load: typeof physical.load = async (model, id) => {
    if (model === REVISION) targetLoads++;
    return physical.load(model, id);
  };
  const cohortLoad: typeof physical.cohortLoad = async input => {
    if (input.model === REVISION) targetLoads++;
    return physical.cohortLoad(input);
  };
  const store = { ...physical, load, cohortLoad, commit: async (batch: CommitBatch) => { batches.push(batch); return physical.commit(batch); } };
  const loaded = loadArtifactDescriptors(artifact(), { by: 'members' }), def = loaded.registry.get(OP);
  assert.ok(def && isGeneratedOperationDef(def));
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, nullableFields: loaded.nullableFields,
    containment: loaded.containment });
  const policy = buildPolicyTable([]);
  const readPolicies = new Map<ModelName, ViewerSourceReadPolicy>([
    [CONVERSATION, { fields: ['title'], secretFields: [], grants: [{ fields: ['id', 'title'],
      read: async ({ context }) => context.membership?.status === 'active' }] }],
    [TEMPLATE, { parent: CONVERSATION, fields: ['title', 'current'], secretFields: [], grants: [{ fields: ['id', 'title', 'current'],
      read: async ({ context }) => context.membership?.status === 'active' &&
        (await context.memberships.findMembership(team.team_id, relatedUser.user_id))?.status === 'active' }] }],
    [REVISION, { parent: TEMPLATE, fields: ['published', 'digest'], secretFields: [], grants: [{ fields: ['id', 'published', 'digest'],
      read: async ({ context, row }) => {
        targetGrants++;
        return row.data.published === true && context.membership?.status === 'active' &&
          (await context.memberships.findMembership(team.team_id, relatedUser.user_id))?.status === 'active';
      } }] }],
    [RUN, { parent: TEMPLATE, fields: ['digest'], secretFields: [], grants: [{ fields: ['id', 'digest'],
      read: async ({ context }) => context.membership?.status === 'active' }] }],
  ]);
  bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  const conversation = makeRow({ id: 'conversation', createdBy: user.user_id, data: { title: 'Original ancestor' } });
  const template = { ...makeRow({ id: 'template', createdBy: user.user_id,
    data: { title: 'Original source', current: absent ? null : { id: 'revision' } } }),
    parent: { model: CONVERSATION, id: conversation.id } };
  const revision = { ...makeRow({ id: 'revision', createdBy: user.user_id, data: { published: false, digest: null } }),
    parent: { model: TEMPLATE, id: template.id } };
  await store.commit(makeBatch(await store.readRevision(), { writes: [
    { kind: 'insert', model: CONVERSATION, row: conversation }, { kind: 'insert', model: TEMPLATE, row: template },
    { kind: 'insert', model: REVISION, row: revision },
  ] }));
  const storedConversation = await physical.load(CONVERSATION, conversation.id),
    storedTemplate = await physical.load(TEMPLATE, template.id), storedRevision = await physical.load(REVISION, revision.id);
  assert.ok(storedConversation && storedTemplate && storedRevision);
  return { mode, absent, store, physical, batches, memberships, related, table, policy, readPolicies, registry: loaded.registry,
    rows: { conversation: storedConversation, template: storedTemplate, revision: storedRevision }, app: APP, source: 'component',
    identity: makeIdentity({ userId: user.user_id, team, membership: caller }), clock: { nowMs: () => FIXED_NOW },
    envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), { template: { id: storedTemplate.id, version: String(storedTemplate.version) } }),
    targetLoads: () => targetLoads, targetGrants: () => targetGrants };
}
type World = Awaited<ReturnType<typeof world>>;

function execution(w: World, navigation?: () => Promise<void>) {
  let receipt: Receipt | undefined, calls = 0, getterCalls = 0, receiverReads = 0, navigations = 0,
    exposed = 0, failures = 0, returnedNull = false;
  let firstFrameError: unknown;
  const request = { ...w, observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
    calls++;
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds: { maxRows: 10, maxWork: 2000 } });
    await session.stage({ op: 'update', model: CONVERSATION, id: asId('conversation'), data: { title: 'Provisional ancestor' } }, cause);
    if (!w.absent) await session.stage({ op: 'update', model: REVISION, id: asId('revision'),
      data: { published: true, digest: 'original-digest' } }, cause);
    const sourceRow = await session.read(TEMPLATE, asId('template')); assert.ok(sourceRow);
    const c = createContext({ caller: { userId: w.identity.actor!.user_id, roles: [] }, store: w.store, qualified: call.context });
    let frame!: ScenarioReceiptFrame;
    const origins = new WeakMap<object, { readonly view: object; readonly wire: unknown }>();
    const sourceView: Record<string, unknown> = {};
    Object.defineProperty(sourceView, 'current', { enumerable: true, get: () => {
      getterCalls++;
      const wire = sourceRow.data.current, ref = decodeValue(currentType, wire);
      assert.ok(ref === null || isRecordRef(ref));
      if (ref !== null) origins.set(ref, { view: sourceView, wire });
      frame.bindNullableStoredReferenceGetter(sourceView, TEMPLATE, 'current', sourceRow, wire, ref);
      return ref;
    } });
    bindNativeRecord(sourceView, TEMPLATE, sourceRow.id, sourceRow.version); Object.freeze(sourceView);
    frame = openScenarioReceiptFrame(c, call, w.store, error => { failures++; firstFrameError ??= error; },
      undefined, undefined, undefined, undefined,
      async (view, ref, sourceDependencyId, scalarLeafDependencyId, healthy, captureSource) => {
        // Handauthored component callback, not invoke.ts callback9 qualification.
        healthy();
        const origin = ref !== null && typeof ref === 'object' ? origins.get(ref) : undefined;
        if (view !== sourceView || ref !== null && (origin === undefined || !isRecordRef(ref))) {
          throw new StateError('validation', 'Component bridge requires its actual getter origin');
        }
        const source = captureSource(view, TEMPLATE, 'current', ref === null ? null : origin!.wire);
        if (w.mode === 'pending-caught') {
          await assert.rejects(readScenarioReceiptNullableStoredReference(c, view, ref, sourceDependencyId, scalarLeafDependencyId), refuses);
          healthy();
        }
        receiverReads++;
        const row = await readScenarioReceiptNullableStoredReferenceRow(call, w.store,
          { sourceDependencyId, scalarLeafDependencyId, sourceRow: source });
        if (w.mode === 'closed') frame.close();
        healthy();
        if (row === null) { assert.equal(ref, null); returnedNull = true; return null; }
        assert.ok(isRecordRef(ref)); assert.equal(row.id, ref.id);
        // A real async boundary models navigation; no production navigation
        // function or runtime caller is claimed by this component fixture.
        navigations++; await navigation?.(); healthy();
        captureSource(view, TEMPLATE, 'current', origin!.wire);
        receiverReads++;
        const fresh = await readScenarioReceiptNullableStoredReferenceRow(call, w.store,
          { sourceDependencyId, scalarLeafDependencyId, sourceRow: source });
        healthy(); assert.ok(fresh);
        assert.notStrictEqual(fresh, row); assert.deepEqual(fresh, row);
        captureSource(view, TEMPLATE, 'current', origin!.wire);
        const target: Record<string, unknown> = Object.freeze({
          get published() { return decodeValue('bool', row.data.published); },
          get digest() { return decodeValue('text?', row.data.digest); },
        });
        bindNativeRecord(target, REVISION, row.id, row.version); frame.bind(target, REVISION, () => row);
        exposed++; return target;
      });
    frame.bind(sourceView, TEMPLATE, () => sourceRow); frame.bindAdmittedReference(sourceView, call.recordRefs[0]!);
    try {
      const ref = w.mode === 'missing-getter' ? decodeValue(currentType, sourceRow.data.current) : sourceView.current;
      if (w.mode !== 'missing-marker') await nativeObserve(c, TEMPLATE, sourceView, 'current', 'current-control');
      if (w.mode === 'getter-after-marker') void sourceView.current;
      const copySource = Object.freeze({ current: ref });
      const operand = w.mode === 'copied-ref' ? Object.freeze({ ...(ref as object) }) : ref;
      if (w.mode === 'caught-copy') {
        await assert.rejects(readScenarioReceiptNullableStoredReference(c, copySource, ref, 'current-control', 'published-control'), refuses);
        assert.ok(firstFrameError instanceof StateError);
        await assert.rejects(readScenarioReceiptNullableStoredReference(c, sourceView, ref, 'current-control', 'published-control'),
          error => error === firstFrameError);
        assert.throws(() => frame.assertCompleted(), error => error === firstFrameError);
        throw firstFrameError;
      }
      const target = await readScenarioReceiptNullableStoredReference(c, w.mode === 'copied-source' ? copySource : sourceView,
        operand, 'current-control', 'published-control');
      if (w.mode === 'reused-getter') {
        await readScenarioReceiptNullableStoredReference(c, sourceView, ref, 'current-control', 'published-control');
      }
      if (target === null) throw new StateError('rule_failed', 'Original require current!=null failed');
      assert.equal(target.published, true);
      await nativeObserve(c, REVISION, target, 'published', 'published-control');
      // Distinct original source DATA getter, with real prior nullable CONTROL.
      const narrowedReference = sourceView.current; assert.ok(isRecordRef(narrowedReference));
      await nativeObserve(c, TEMPLATE, sourceView, 'current', 'current-data');
      const nullableDigest = target.digest; assert.equal(nullableDigest, 'original-digest');
      if (w.mode !== 'missing-digest-control') await nativeObserve(c, REVISION, target, 'digest', 'digest-control');
      let digestView = target;
      if (w.mode === 'copied-digest-row') {
        // Same identity/version/wire never substitutes for the exact State row.
        const original = await session.read(REVISION, asId('revision')); assert.ok(original);
        const copy = Object.freeze({ ...original });
        digestView = Object.freeze({ digest: nullableDigest });
        bindNativeRecord(digestView, REVISION, copy.id, copy.version); frame.bind(digestView, REVISION, () => copy);
      }
      if (w.mode === 'digest-stage') await session.stage({ op: 'update', model: CONVERSATION,
        id: asId('conversation'), data: { title: 'Later owner stage' } }, cause);
      const digest = digestView.digest;
      await nativeObserve(c, REVISION, digestView, 'digest', 'digest-data');
      assert.equal(digest, 'original-digest');
      await session.stage({ op: 'create', model: RUN, id: asId('created-run'),
        parent: { model: TEMPLATE, id: sourceRow.id }, data: { digest } }, cause);
      const run = await session.read(RUN, asId('created-run')); assert.ok(run);
      const result = await bindScenarioReceiptModelResult(call, w.store, { returnId: 'created-run', row: run });
      selectScenarioReceiptReturn(call, w.store, 'created-run'); frame.assertCompleted();
      return { ...await session.finalize(), result, outbox: [] };
    } finally { frame.close(); }
  } };
  return { request, receipt: () => { assert.ok(receipt); return receipt; }, calls: () => calls,
    getters: () => getterCalls, receiverReads: () => receiverReads, navigations: () => navigations,
    exposed: () => exposed, failures: () => failures, firstFrameError: () => firstFrameError, returnedNull: () => returnedNull };
}

async function rejectedOnce(w: World, beforeBatches: number, beforeRevision: number) {
  for (const [model, row] of [[CONVERSATION, w.rows.conversation], [TEMPLATE, w.rows.template], [REVISION, w.rows.revision]] as const) {
    assert.deepEqual(await w.physical.load(model, row.id), row);
    assert.deepEqual(await w.physical.historyFor(model, row.id), []);
  }
  assert.equal(await w.physical.load(RUN, asId('created-run')), null);
  assert.deepEqual(await w.physical.historyFor(RUN, asId('created-run')), []);
  assert.deepEqual(await w.physical.outboxPending(), []);
  assert.equal(w.batches.length, beforeBatches + 1);
  const batch = w.batches.at(-1)!;
  for (const key of ['writes', 'history', 'outbox', 'schedules', 'uniqueClaims', 'uniqueReleases'] as const) assert.deepEqual(batch[key], []);
  assert.equal(batch.expectedRevision, beforeRevision);
  assert.equal(batch.receipt?.outcome.status, 'rejected');
  assert.equal(await w.physical.readRevision(), beforeRevision + 1);
}

test('nullable frame returns actual authorized null with zero target lookup or navigation before authored rejection', async () => {
  const w = await world('null'), run = execution(w), before = w.batches.length, revision = await w.store.readRevision();
  await assert.rejects(invoke(run.request), error => error instanceof StateError && error.code === 'rule_failed');
  assert.equal(run.returnedNull(), true); assert.equal(run.getters(), 1); assert.equal(run.receiverReads(), 1);
  assert.equal(w.targetLoads(), 0); assert.equal(w.targetGrants(), 0); assert.equal(run.navigations(), 0); assert.equal(run.exposed(), 0);
  await rejectedOnce(w, before, revision);
});

test('nonnull frame binds actual provisional State row after navigation and fresh authority, preserving native CONTROL then DATA', async () => {
  const w = await world(), run = execution(w, async () => { assert.equal(run.exposed(), 0); await Promise.resolve(); });
  assert.equal((await invoke(run.request)).status, 'committed');
  assert.equal(run.getters(), 2); assert.equal(run.receiverReads(), 2); assert.equal(run.navigations(), 1); assert.equal(run.exposed(), 1);
  const saved = readScenarioReceiptAssociation(run.receipt())!;
  assert.deepEqual(saved.observations.map(value => [value.dependencyId, value.row.id]), [
    ['current-control', 'template'], ['published-control', 'revision'], ['current-data', 'template'],
    ['digest-control', 'revision'], ['digest-data', 'revision'],
  ]);
  assert.deepEqual(saved.observations[0]!.row, saved.observations[2]!.row);
  assert.deepEqual(saved.observations[3]!.row, saved.observations[4]!.row);
  assert.equal(saved.observations[1]!.row.version, 2); assert.equal(saved.observations[1]!.row.data.published, true);
  assert.equal((await w.physical.load(RUN, asId('created-run')))!.data.digest, 'original-digest');
});

test('nullable frame refuses copied operands and missing, after-marker or reused getter events with one rejected fence', async () => {
  for (const mode of ['copied-source', 'copied-ref', 'missing-getter', 'missing-marker', 'getter-after-marker', 'reused-getter'] as const) {
    for (const absent of [false, true]) {
      const w = await world(mode, absent), run = execution(w), before = w.batches.length, revision = await w.store.readRevision();
      await assert.rejects(invoke(run.request), refuses, `${mode}, null=${absent}`);
      assert.equal(run.failures(), 1); assert.equal(run.calls(), 1);
      assert.equal(run.receiverReads(), mode === 'reused-getter' ? absent ? 1 : 2 : 0);
      if (absent) { assert.equal(w.targetLoads(), 0); assert.equal(w.targetGrants(), 0); assert.equal(run.navigations(), 0); }
      await rejectedOnce(w, before, revision);
    }
  }
});

test('caught, pending and closed nullable frame failures remain sticky before commit', async () => {
  for (const mode of ['caught-copy', 'pending-caught', 'closed'] as const) {
    const w = await world(mode), run = execution(w), before = w.batches.length, revision = await w.store.readRevision();
    await assert.rejects(invoke(run.request), error => error === run.firstFrameError(), mode);
    assert.equal(run.failures(), 1); assert.equal(run.exposed(), 0); assert.equal(run.calls(), 1);
    await rejectedOnce(w, before, revision);
  }
});

test('native view digest DATA cannot bypass original CONTROL or its exact genuine row and owner stage', async () => {
  for (const mode of ['missing-digest-control', 'copied-digest-row', 'digest-stage'] as const) {
    const w = await world(mode), run = execution(w), before = w.batches.length, revision = await w.store.readRevision();
    await assert.rejects(invoke(run.request), refuses, mode); assert.equal(run.failures(), 1);
    await rejectedOnce(w, before, revision);
  }
});

test('actual related SDK revocation during navigation await refuses before nullable view exposure and records one rejection', { timeout: 10_000 }, async () => {
  const w = await world('navigation-revoke');
  let signal!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { signal = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
  const run = execution(w, async () => { signal(); await resume; });
  const before = w.batches.length, revision = await w.store.readRevision();
  const pending = invoke(run.request);
  const rejected = assert.rejects(pending, refuses);
  try {
    await held; assert.equal(run.receiverReads(), 1); assert.equal(run.exposed(), 0);
    await w.memberships.removeMembership(w.related.membership_id);
    release(); await rejected;
    assert.equal(run.receiverReads(), 2); assert.equal(run.navigations(), 1); assert.equal(run.exposed(), 0); assert.equal(run.failures(), 1);
    await rejectedOnce(w, before, revision);
    await assert.rejects(invoke(run.request), refuses);
    assert.equal(run.calls(), 1); assert.equal(run.receiverReads(), 2); assert.equal(w.batches.length, before + 1);
    assert.equal(await w.physical.readRevision(), revision + 1);
  } finally { release(); }
});
