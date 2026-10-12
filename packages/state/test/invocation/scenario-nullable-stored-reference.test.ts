/** Finite Template.current -> published/digest State receiver; no native/app claim. */
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
  readScenarioReceiptNullableStoredReferenceRow, bindScenarioReceiptModelResult, selectScenarioReceiptReturn,
  readScenarioReceiptAssociation, projectScenarioReceipt } from '../../src/invocation/scenario-receipt.js';
import { asId, asModel, FIXED_NOW, makeIdentity, makeEnvelope, seedRow, updateRow, uuidv7 } from './fixtures.js';

const CONVERSATION = asModel('NullableReader.Conversation'), TEMPLATE = asModel('NullableReader.Template');
const REVISION = asModel('NullableReader.Revision'), RUN = asModel('NullableReader.Run');
const OP = 'NullableReader.generate', APP = 'nullable-stored-reference', cause = { cause: 'scenario' } as const;
const source = { path: 'nullable-reader.can', module: 'nullable-reader.mjs', sha256: 'a'.repeat(64) };
let sequence = 121_000;
const refuses = (error: unknown) => error instanceof StateError;
type Mode = 'normal' | 'null' | 'null-data' | 'null-digest' | 'null-digest-data' | 'unobserved' | 'copied-source' | 'stale-stage'
  | 'wrong-pair' | 'copied-call-caught' | 'foreign-store-caught' | 'copied-target' | 'unobserved-digest' | 'array' | 'state-race';

async function world(mode: Mode = 'normal') {
  const array = mode === 'array', currentType = `${REVISION}${array ? '[]' : '?'}` as CanTypeId;
  const dependencies = [
    { id: 'current-control', source, role: 'control' as const, model: TEMPLATE, field: 'current', type: currentType },
    ...(!array ? [{ id: 'current-data', source, role: 'data' as const, model: TEMPLATE, field: 'current', type: REVISION as CanTypeId }] : []),
    { id: 'published-control', source, role: 'control' as const, model: REVISION, field: 'published', type: 'bool' as CanTypeId },
    { id: 'digest-control', source, role: 'control' as const, model: REVISION, field: 'digest', type: 'text?' as CanTypeId },
    { id: 'digest-data', source, role: 'data' as const, model: REVISION, field: 'digest', type: 'text' as CanTypeId },
  ];
  const slice: ArtifactDescriptorSlice = { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: `export const identity="${OP}";`, map: { version: 3, file: source.module,
      sources: [source.path], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: source.module, export: 'identity', member: ['generate'] }], models: [
      { name: CONVERSATION, deleteMode: 'remove', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] },
      { name: TEMPLATE, parent: CONVERSATION, deleteMode: 'remove', fields: [
        { name: 'title', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: true, serverOnly: false },
        { name: 'current', field: { kind: 'ref', model: REVISION }, valueType: currentType, required: false, serverOnly: false,
          ...(array ? { array: { required: false } } : { nullable: true }) },
      ] },
      { name: REVISION, parent: TEMPLATE, deleteMode: 'remove', fields: [
        { name: 'published', field: { kind: 'boolean' }, valueType: 'bool' as CanTypeId, required: true, serverOnly: false },
        { name: 'digest', field: { kind: 'string' }, valueType: 'text?' as CanTypeId, nullable: true, required: false, serverOnly: false },
      ] },
      { name: RUN, parent: TEMPLATE, deleteMode: 'remove', fields: [{ name: 'digest', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: true, serverOnly: false }] },
    ], operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [] }, result: { type: RUN as CanTypeId,
      disclosure: { version: 1, source, returns: [{ id: 'created-run', source, influences: [], dependencies }] } } }],
  };
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const user = await memberships.createUser({ email: 'nullable-reader@example.test', password_hash: 'test-only', email_verified: true });
  const caller = await memberships.createMembership({ team_id: team.team_id, user_id: user.user_id, roles: [], is_owner: false });
  const readerUser = await memberships.createUser({ email: 'nullable-authority@example.test', password_hash: 'test-only', email_verified: true });
  const reader = await memberships.createMembership({ team_id: team.team_id, user_id: readerUser.user_id, roles: [], is_owner: false });
  const store = createMemoryStorage(), loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const def = loaded.registry.get(OP); assert.ok(def && isGeneratedOperationDef(def));
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, nullableFields: loaded.nullableFields, containment: loaded.containment });
  const policy = buildPolicyTable([]), access = { source: true, target: true, ancestor: true };
  let targetReads = 0, beforeTargetRead: (() => Promise<void> | void) | undefined;
  const readPolicies = new Map<ModelName, ViewerSourceReadPolicy>([
    [CONVERSATION, { fields: ['title'], secretFields: [], grants: [{ fields: ['id', 'title'], read: async ({ context }) =>
      access.ancestor && context.membership?.status === 'active' }] }],
    [TEMPLATE, { parent: CONVERSATION, fields: ['title', 'current'], secretFields: [], grants: [{ fields: ['id', 'title', 'current'], read: async ({ context }) =>
      access.source && context.membership?.status === 'active' &&
      (await context.memberships.findMembership(team.team_id, readerUser.user_id))?.status === 'active' }] }],
    [REVISION, { parent: TEMPLATE, fields: ['published', 'digest'], secretFields: [], grants: [{ fields: ['id', 'published', 'digest'], read: async ({ context }) => {
      targetReads++; const related = await context.memberships.findMembership(team.team_id, readerUser.user_id);
      await beforeTargetRead?.(); return access.target && context.membership?.status === 'active' && related?.status === 'active';
    } }] }],
    [RUN, { parent: TEMPLATE, fields: ['digest'], secretFields: [], grants: [{ fields: ['id', 'digest'], read: async ({ context }) => context.membership?.status === 'active' }] }],
  ]);
  bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  return { mode, store, memberships, caller, reader, table, access, policy, readPolicies, registry: loaded.registry,
    app: APP, source: 'component', identity: makeIdentity({ userId: user.user_id, team, membership: caller }),
    clock: { nowMs: () => FIXED_NOW }, envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), {}),
    targetReads: () => targetReads, beforeTargetRead: (hook?: () => Promise<void> | void) => { beforeTargetRead = hook; } };
}
type World = Awaited<ReturnType<typeof world>>;
type Session = Awaited<ReturnType<typeof beginScenarioReceiptMutation>>;
function execution(w: World, beforePromotion?: () => Promise<void> | void, after?: (session: Session) => Promise<void> | void) {
  let receipt: Receipt | undefined, runs = 0, exposed = false, promoting = false, firstPromotionError: unknown,
    promoted: StoredRow | null | undefined;
  const request = { ...w, observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
    runs++;
    if (w.mode === 'state-race' && runs > 1) throw new StateError('rule_failed', 'Test stops after first nullable promotion attempt');
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds: { maxRows: 10, maxWork: 2000 } });
    await session.stage({ op: 'create', model: CONVERSATION, id: asId('conversation'), data: { title: 'Conversation' } }, cause);
    await session.stage({ op: 'create', model: TEMPLATE, id: asId('template'), parent: { model: CONVERSATION, id: asId('conversation') },
      data: { title: 'Template', current: w.mode === 'array' ? [] : null } }, cause);
    await session.stage({ op: 'create', model: REVISION, id: asId('revision'), parent: { model: TEMPLATE, id: asId('template') },
      data: { published: true, digest: w.mode === 'null-digest' || w.mode === 'null-digest-data' ? null : 'original-digest' } }, cause);
    if (w.mode !== 'null' && w.mode !== 'null-data') await session.stage({ op: 'update', model: TEMPLATE, id: asId('template'),
      data: { current: w.mode === 'array' ? [{ id: 'revision' }] : { id: 'revision' } } }, cause);
    const template = await session.read(TEMPLATE, asId('template')); assert.ok(template);
    if (w.mode !== 'unobserved') await observeScenarioReceiptDependency(call, w.store,
      { dependencyId: 'current-control', model: TEMPLATE, row: template, field: 'current' });
    if (w.mode === 'stale-stage') await session.stage({ op: 'update', model: TEMPLATE, id: template.id, data: { title: 'Later stage' } }, cause);
    await beforePromotion?.();
    const promote = async () => {
      promoting = true;
      try {
        return await readScenarioReceiptNullableStoredReferenceRow(w.mode === 'copied-call-caught' ? { ...call } : call,
          w.mode === 'foreign-store-caught' ? { ...w.store } : w.store, { sourceDependencyId: 'current-control',
            scalarLeafDependencyId: w.mode === 'wrong-pair' ? 'digest-data' : 'published-control',
            sourceRow: w.mode === 'copied-source' ? { ...template } : template });
      } catch (error) { firstPromotionError ??= error; throw error; }
      finally { promoting = false; }
    };
    if (w.mode === 'copied-call-caught' || w.mode === 'foreign-store-caught') {
      await assert.rejects(promote(), refuses); await assert.rejects(session.finalize(), refuses);
      throw new StateError('validation', 'Caught nullable promotion poisoned its genuine issuer');
    }
    promoted = await promote();
    if (promoted === null) {
      if (w.mode === 'null-data') await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'current-data', model: TEMPLATE, row: template, field: 'current' });
      throw new StateError('rule_failed', 'Original require current!=null failed');
    }
    exposed = true; assert.equal(promoted.id, 'revision');
    assert.equal(await w.store.load(REVISION, promoted.id), null, 'target is genuine provisional owner state');
    const published = promoted.data.published;
    await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'published-control', model: REVISION,
      row: w.mode === 'copied-target' ? { ...promoted } : promoted, field: 'published' });
    assert.equal(published, true);
    await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'current-data', model: TEMPLATE, row: template, field: 'current' });
    const digest = promoted.data.digest;
    if (w.mode !== 'unobserved-digest') await observeScenarioReceiptDependency(call, w.store,
      { dependencyId: 'digest-control', model: REVISION, row: promoted, field: 'digest' });
    if (digest === null && w.mode !== 'null-digest-data') throw new StateError('rule_failed', 'Original require digest!=null failed');
    await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'digest-data', model: REVISION, row: promoted, field: 'digest' });
    await session.stage({ op: 'create', model: RUN, id: asId('created-run'), parent: { model: TEMPLATE, id: template.id }, data: { digest } }, cause);
    await after?.(session);
    const run = await session.read(RUN, asId('created-run')); assert.ok(run);
    const result = await bindScenarioReceiptModelResult(call, w.store, { returnId: 'created-run', row: run });
    selectScenarioReceiptReturn(call, w.store, 'created-run'); return { ...await session.finalize(), result, outbox: [] };
  } };
  return { request, receipt: () => { assert.ok(receipt); return receipt; }, runs: () => runs, exposed: () => exposed,
    promoted: () => promoted, promoting: () => promoting, firstPromotionError: () => firstPromotionError };
}
async function unchanged(w: World) {
  for (const [model, id] of [[CONVERSATION, 'conversation'], [TEMPLATE, 'template'], [REVISION, 'revision'], [RUN, 'created-run']] as const) {
    assert.equal(await w.store.load(model, asId(id)), null); assert.deepEqual(await w.store.historyFor(model, asId(id)), []);
  }
  assert.deepEqual(await w.store.outboxPending(), []);
}

test('nullable current null returns null without target exposure and original Require rolls back provisional records', async () => {
  const w = await world('null'), ex = execution(w);
  await assert.rejects(invoke(ex.request), error => error instanceof StateError && error.code === 'rule_failed');
  assert.equal(ex.promoted(), null); assert.equal(ex.exposed(), false); assert.equal(w.targetReads(), 0); await unchanged(w);
});

test('actual nonnull provisional current and digest narrow only after corresponding genuine nullable controls', async () => {
  const w = await world(), ex = execution(w); assert.equal((await invoke(ex.request)).status, 'committed');
  const saved = readScenarioReceiptAssociation(ex.receipt())!;
  assert.deepEqual(saved.observations.map(value => [value.dependencyId, value.row.id]), [
    ['current-control', 'template'], ['published-control', 'revision'], ['current-data', 'template'],
    ['digest-control', 'revision'], ['digest-data', 'revision'],
  ]);
  assert.deepEqual(saved.observations[2]!.row.data.current, { id: 'revision' }); assert.equal(saved.observations[4]!.row.data.digest, 'original-digest');
  assert.equal((await w.store.load(RUN, asId('created-run')))!.data.digest, 'original-digest');
  for (const [model, id] of [[CONVERSATION, 'conversation'], [TEMPLATE, 'template'], [REVISION, 'revision'], [RUN, 'created-run']] as const)
    assert.equal((await w.store.historyFor(model, asId(id))).length, 1);
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt: ex.receipt() })).result, { id: 'created-run' });
});

test('nullable promotion refuses copied/unobserved/stale/wrong pairs and array source profiles', async () => {
  for (const mode of ['copied-source', 'unobserved', 'stale-stage', 'wrong-pair', 'array', 'copied-target'] as const) {
    const w = await world(mode), ex = execution(w); await assert.rejects(invoke(ex.request), refuses); await unchanged(w);
  }
});

test('null DATA and unobserved digest narrowing refuse while legitimate null digest fails its authored Require', async () => {
  for (const mode of ['null-data', 'null-digest-data', 'unobserved-digest', 'null-digest'] as const) {
    const w = await world(mode), ex = execution(w); await assert.rejects(invoke(ex.request), error => error instanceof StateError &&
      (mode === 'null-digest' ? error.code === 'rule_failed' : error.code === 'validation' || error.code === 'forbidden'));
    await unchanged(w);
  }
});

test('caught copied call/store nullable promotion poisons the actual source owner', async () => {
  for (const mode of ['copied-call-caught', 'foreign-store-caught'] as const) {
    const w = await world(mode), ex = execution(w); await assert.rejects(invoke(ex.request), refuses); await unchanged(w);
  }
});

test('source/target/ancestor/related Identity loss refuses before exposing the promoted Revision', async () => {
  for (const mode of ['source', 'target', 'ancestor', 'identity', 'identity-await'] as const) {
    const w = await world();
    if (mode === 'identity-await') {
      let changed = false;
      w.beforeTargetRead(async () => { if (!changed) { changed = true; await w.memberships.removeMembership(w.reader.membership_id); } });
    }
    const ex = execution(w, async () => {
      if (mode === 'source') w.access.source = false;
      if (mode === 'target') w.access.target = false;
      if (mode === 'ancestor') w.access.ancestor = false;
      if (mode === 'identity') await w.memberships.removeMembership(w.reader.membership_id);
    });
    await assert.rejects(invoke(ex.request), refuses); assert.equal(ex.exposed(), false); await unchanged(w);
  }
});

test('late nullable-source/target/ancestor/Identity authority loss rolls back the original Run', async () => {
  for (const mode of ['source', 'target', 'ancestor', 'identity'] as const) {
    const w = await world(), ex = execution(w, undefined, async () => {
      if (mode === 'source') w.access.source = false;
      if (mode === 'target') w.access.target = false;
      if (mode === 'ancestor') w.access.ancestor = false;
      if (mode === 'identity') await w.memberships.removeMembership(w.reader.membership_id);
    });
    await assert.rejects(invoke(ex.request), refuses); await unchanged(w);
  }
});

test('saved nullable narrowing rechecks exact current authority without replacing original values or executing the body', async () => {
  for (const mode of ['source', 'target', 'ancestor', 'identity'] as const) {
    const w = await world(), ex = execution(w); await invoke(ex.request); const receipt = ex.receipt();
    if (mode === 'source') w.access.source = false;
    if (mode === 'target') w.access.target = false;
    if (mode === 'ancestor') w.access.ancestor = false;
    if (mode === 'identity') await w.memberships.removeMembership(w.reader.membership_id);
    const revision = await w.store.readRevision();
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
    assert.equal(await w.store.readRevision(), revision); assert.equal((await invoke(ex.request)).status, 'replayed'); assert.equal(ex.runs(), 1);
  }
});

test('a later valid digest preserves original saved evidence and replay remains effect-free', async () => {
  const w = await world(), ex = execution(w); await invoke(ex.request); const receipt = ex.receipt();
  const current = await w.store.load(REVISION, asId('revision')); assert.ok(current);
  await updateRow(w.store, REVISION, current, { data: { ...current.data, digest: 'later-valid-digest' } });
  assert.equal(readScenarioReceiptAssociation(receipt)!.observations.find(value => value.dependencyId === 'digest-data')!.row.data.digest, 'original-digest');
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: 'created-run' });
  const revision = await w.store.readRevision(), history = await w.store.historyFor(RUN, asId('created-run'));
  assert.equal((await invoke(ex.request)).status, 'replayed'); assert.equal(ex.runs(), 1);
  assert.equal(await w.store.readRevision(), revision); assert.deepEqual(await w.store.historyFor(RUN, asId('created-run')), history);
});

test('nullable target never escapes State movement during its final genuine SDK snapshot', { timeout: 10_000 }, async () => {
  const w = await world('state-race');
  const unrelated = await seedRow(w.store, CONVERSATION, { id: 'unrelated-conversation', data: { title: 'Unrelated' } });
  const ex = execution(w), sdkSnapshot = w.memberships.findMembershipsSnapshot!.bind(w.memberships);
  let heldOnce = false, held!: () => void, release!: () => void;
  const snapshotHeld = new Promise<void>(resolve => { held = resolve; });
  const snapshotRelease = new Promise<void>(resolve => { release = resolve; });
  w.memberships.findMembershipsSnapshot = async (team, users) => {
    const actual = await sdkSnapshot(team, users);
    if (!heldOnce && ex.promoting() && w.targetReads() >= 4) {
      assert.equal(w.targetReads(), 4); heldOnce = true; held(); await snapshotRelease;
    }
    return actual;
  };
  const pending = invoke(ex.request);
  const rejected = assert.rejects(pending, error => error instanceof StateError && error.code === 'rule_failed' &&
    error.message === 'Test stops after first nullable promotion attempt');
  try {
    await snapshotHeld;
    assert.equal(w.targetReads(), 4); assert.equal(ex.promoting(), true); assert.equal(ex.exposed(), false);
    const revision = await w.store.readRevision();
    await updateRow(w.store, CONVERSATION, unrelated, { data: { title: 'State moved during final Identity await' } });
    assert.ok(await w.store.readRevision() > revision);
    release(); await rejected;
    const first = ex.firstPromotionError(); assert.ok(first instanceof StateError);
    assert.equal(first.code, 'conflict'); assert.equal(first.message, 'Stored scalar final authority moved beyond its checkpoint.');
    assert.equal(ex.exposed(), false); assert.equal(ex.promoted(), undefined); assert.equal(heldOnce, true);
    await unchanged(w);
  } finally { release(); }
});
