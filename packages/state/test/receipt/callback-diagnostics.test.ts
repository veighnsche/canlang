/** State authority around a finite evidence port; Work owns evidence qualification. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GenerationCallbackDiagnosticRequest, GenerationCallbackDiagnosticResult,
  GenerationCallbackFailure, GenerationCallbackOrigin, ModelName, QueryPredicate, StoragePort } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { queryGenerationCallbackDiagnosticsForViewer } from '../../src/receipt/callback-diagnostics.js';
import { newAssociationRow, RECEIPT_ASSOCIATION_MODEL } from '../../src/receipt/tables.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { FenceConflictError } from '../../src/storage/port.js';
import { StateError } from '../../src/errors.js';
import { runMutationWrites, type MutationWrite } from '../../src/mutation/pipeline.js';
import { buildModelTable } from '../../src/mutation/models.js';
import type { ByPredicate } from '../../src/policy/roles.js';
import { grant, modelPolicy, policyTable } from '../query/fixtures.js';
import { field, modelDef, pipelineContext } from '../mutation/fixtures.js';
import { asId, asModel, FIXED_NOW, makeBatch } from '../invocation/fixtures.js';

const MODEL = asModel('Callback.Book'), PARENT = asModel('Callback.Shelf'), ID = asId('book');
const TEAM = 'callback-team', ROLE = 'Callback.inspect', DELIVERY = 'delivery-original';
const origin = (): GenerationCallbackOrigin => ({ source: 'std.ImagesV1.submit', sourceRevision: '7',
  binding: 'Callback.Images', from: 'request', scope: { app: 'callback-app', ownerPackage: 'Callback', owner: TEAM },
  event: 'Callback.Images.submit.progressed', handlers: ['Callback.Book.onProgress'] });
const failure = (): GenerationCallbackFailure => ({ deliveryId: DELIVERY, sourceOccurrence: 'source-occurrence',
  occurrenceId: 'handler/v1/source-occurrence/Callback.Book.onProgress', handler: origin().handlers[0]!, event: origin().event,
  recordedAtMs: FIXED_NOW, code: 'require-false', message: 'handler requirement rejected the occurrence' });
const diagnostic = (): GenerationCallbackDiagnosticResult => Object.freeze({ outcome: 'complete',
  snapshotAttribution: 'unsupported', failures: Object.freeze([Object.freeze(failure())]) });
const stateCode = (code: StateError['code']) => (error: unknown) => error instanceof StateError && error.code === code;

async function setup(options: { parent?: boolean; archive?: boolean; association?: boolean } = {}) {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const member = await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false,
    roles: [{ role: ROLE, granted_at: new Date(FIXED_NOW).toISOString(), granted_by: 'caller' }] });
  const store = createMemoryStorage();
  const table = buildModelTable([
    modelDef(MODEL, { fields: { request: field(), title: field() }, deleteMode: options.archive ? 'archive' : 'remove' }),
    modelDef(PARENT, { fields: { title: field() }, deleteMode: options.archive ? 'archive' : 'remove' }),
  ]);
  async function write(write: MutationWrite) {
    const revision = await store.readRevision();
    const effects = await runMutationWrites({ table, store, context: pipelineContext({ operation: 'Callback.change',
      actor: 'caller', teamId: TEAM }), writes: [write] });
    await store.commit(makeBatch(revision, { ...effects }));
  }
  if (options.parent) await write({ op: 'create', model: PARENT, id: asId('shelf'), data: { title: 'Shelf' } });
  await write({ op: 'create', model: MODEL, id: ID, data: { title: 'Book',
    request: options.association === false ? null : { id: DELIVERY, operation: origin().source } },
    ...(options.parent ? { parent: { model: PARENT, id: asId('shelf') } } : {}) });
  async function associate(deliveryId = DELIVERY, source: string = origin().source) {
    const row = newAssociationRow({ recordModel: MODEL, recordId: ID, field: 'request', deliveryId, source,
      revision: await store.readRevision() }, { nowMs: FIXED_NOW, actor: 'caller' });
    await store.commit(makeBatch(await store.readRevision(), { writes: [
      { kind: 'insert', model: RECEIPT_ASSOCIATION_MODEL as ModelName, row },
    ] }));
  }
  if (options.association !== false) await associate();
  const loaded = loadArtifactDescriptors({ artifact_version: 1, operations: [], models: [{ name: MODEL,
    deleteMode: 'remove', fields: [{ name: 'request', required: false, serverOnly: false,
      field: { kind: 'delivery', capability: 'std.ImagesV1', operation: 'submit', version: 1,
        result: { name: 'ImagesSubmit', fields: [] } } }] }] } as ArtifactDescriptorSlice, { by: 'members' });
  const policy = (fields: readonly string[] = ['request.id'], by: ByPredicate = 'members', parentBy: ByPredicate = 'members') =>
    policyTable(modelPolicy(MODEL, { grants: [grant(by, fields)] }),
      modelPolicy(PARENT, { grants: [grant(parentBy, ['title'])] }));
  const callbackPolicy = (by: ByPredicate = 'members', when?: QueryPredicate) =>
    policyTable(modelPolicy(MODEL, { grants: [grant(by, [], when)] })).get(MODEL)!;
  let reads = 0;
  const requests: GenerationCallbackDiagnosticRequest[] = [];
  const readDiagnostics = async (request: GenerationCallbackDiagnosticRequest, actual: StoragePort) => {
    reads++; requests.push(request); assert.equal(actual, store); return diagnostic();
  };
  const input = () => ({ model: MODEL, recordId: ID, field: 'request', store, memberships,
    context: { actorUserId: 'caller', teamId: TEAM }, schema: loaded.deliveryFields, policy: policy(),
    callbackPolicy: callbackPolicy(), origin: origin(), readDiagnostics,
    readPolicies: new Map<ModelName, { by: ByPredicate; parent?: ModelName }>([
      [MODEL, { by: 'members', ...(options.parent ? { parent: PARENT } : {}) }], [PARENT, { by: 'members' }],
    ]) });
  return { memberships, member, store, table, write, associate, policy, callbackPolicy, input, requests,
    get reads() { return reads; } };
}

test('current delivery identity plus explicit callback grant exposes only safe immutable diagnostics without effects', async () => {
  for (const fields of [['request'], ['request.id']]) {
    const s = await setup(), revision = await s.store.readRevision();
    const before = await s.store.load(MODEL, ID);
    const result = await queryGenerationCallbackDiagnosticsForViewer({ ...s.input(), policy: s.policy(fields) });
    assert.deepEqual(result, { outcome: 'observed', revision, origin: origin(), diagnostic: diagnostic() });
    assert.equal(s.reads, 1);
    assert.deepEqual(s.requests[0], { origin: origin(), deliveryId: DELIVERY, expectedRevision: revision });
    assert.equal(await s.store.readRevision(), revision);
    assert.deepEqual(await s.store.load(MODEL, ID), before);
    assert.ok(Object.isFrozen(result));
    if (result.outcome === 'observed') {
      assert.ok(Object.isFrozen(result.origin.scope)); assert.ok(Object.isFrozen(result.diagnostic));
      if (result.diagnostic.outcome === 'complete') assert.ok(Object.isFrozen(result.diagnostic.failures[0]));
    }
  }
});

test('provider error permission and absent/false callback permissions deny before association or evidence reads', async () => {
  for (const mode of ['error-only', 'null-error-only', 'empty', 'by', 'when', 'read-by'] as const) {
    const s = await setup({ association: mode !== 'null-error-only' });
    const load = s.store.cohortLoad.bind(s.store);
    s.store.cohortLoad = async request => {
      assert.notEqual(request.model, RECEIPT_ASSOCIATION_MODEL, `${mode} must authorize before association access`);
      return load(request);
    };
    const input = s.input();
    if (mode === 'error-only' || mode === 'null-error-only') input.policy = s.policy(['request.error']);
    if (mode === 'empty') input.callbackPolicy = policyTable(modelPolicy(MODEL, { grants: [] })).get(MODEL)!;
    if (mode === 'by') input.callbackPolicy = s.callbackPolicy('owner');
    if (mode === 'when') input.callbackPolicy = s.callbackPolicy('members', { op: 'eq', field: 'title', value: 'Other' });
    if (mode === 'read-by') input.readPolicies = new Map([[MODEL, { by: 'owner' as const }]]);
    assert.deepEqual(await queryGenerationCallbackDiagnosticsForViewer(input), { outcome: 'withheld' }, mode);
    assert.equal(s.reads, 0, mode);
  }
});

test('a safe current delivery identity grant permits historical callback recovery when current result permission is false', async () => {
  const s = await setup({ parent: true });
  const policy = policyTable(modelPolicy(MODEL, { grants: [
    grant('members', ['request.id']),
    grant('members', ['request.result', 'request.error'], { op: 'eq', field: 'title', value: 'Private result permission' }),
  ] }), modelPolicy(PARENT, { grants: [grant('members', ['title'])] }));
  const result = await queryGenerationCallbackDiagnosticsForViewer({ ...s.input(), policy });
  assert.deepEqual(result, { outcome: 'observed', revision: await s.store.readRevision(),
    origin: origin(), diagnostic: diagnostic() });
  assert.equal(s.reads, 1);
  assert.ok(!JSON.stringify(result).includes('Private result permission'));
});

test('removed/archived rows, foreign scope, replaced delivery and mismatched source cannot disclose callback evidence', async () => {
  for (const mode of ['removed', 'archived', 'foreign', 'replacement', 'source'] as const) {
    const s = await setup({ archive: mode === 'archived', association: mode !== 'source' });
    if (mode === 'removed' || mode === 'archived') await s.write({ op: 'remove', model: MODEL, id: ID });
    if (mode === 'replacement') await s.write({ op: 'update', model: MODEL, id: ID,
      data: { request: { id: 'new-delivery', operation: origin().source } } });
    if (mode === 'source') {
      await s.write({ op: 'update', model: MODEL, id: ID,
        data: { request: { id: DELIVERY, operation: origin().source } } });
      await s.associate(DELIVERY, 'std.TextGenerationV1.generate');
    }
    const input = s.input();
    if (mode === 'foreign') input.origin = { ...input.origin, scope: { ...input.origin.scope, owner: 'other-team' } };
    if (mode === 'replacement' || mode === 'source') {
      await assert.rejects(queryGenerationCallbackDiagnosticsForViewer(input), stateCode('validation'));
    } else {
      const result = await queryGenerationCallbackDiagnosticsForViewer(input);
      assert.deepEqual(result, { outcome: 'withheld' }, mode);
      assert.ok(!JSON.stringify(result).includes(DELIVERY));
    }
    assert.equal(s.reads, 0, mode);
  }
  const missing = await setup({ association: false });
  assert.deepEqual(await queryGenerationCallbackDiagnosticsForViewer(missing.input()),
    { outcome: 'no-association', revision: await missing.store.readRevision() });
  assert.equal(missing.reads, 0);
});

test('current parents must remain present, live and readable before evidence access', async () => {
  for (const mode of ['missing', 'archived', 'denied', 'read-denied'] as const) {
    const s = await setup({ parent: true, archive: true });
    if (mode === 'archived') await s.write({ op: 'remove', model: PARENT, id: asId('shelf') });
    if (mode === 'missing') {
      const row = await s.store.load(PARENT, asId('shelf')); assert.ok(row);
      await s.store.commit(makeBatch(await s.store.readRevision(), { writes: [
        { kind: 'remove', model: PARENT, id: row.id, expectedVersion: row.version },
      ] }));
    }
    const input = s.input();
    if (mode === 'denied') input.policy = s.policy(['request.id'], 'members', 'owner');
    if (mode === 'read-denied') input.readPolicies.set(PARENT, { by: 'owner' });
    assert.deepEqual(await queryGenerationCallbackDiagnosticsForViewer(input), { outcome: 'withheld' }, mode);
    assert.equal(s.reads, 0, mode);
  }
});

test('actual Identity revocation/role change and State movement during the evidence await refuse disclosure', async () => {
  for (const mode of ['revoked', 'role', 'state'] as const) {
    const s = await setup(), input = s.input();
    if (mode === 'role') input.callbackPolicy = s.callbackPolicy({ role: ROLE });
    input.readDiagnostics = async (request, store) => {
      await s.input().readDiagnostics(request, store);
      if (mode === 'revoked') await s.memberships.removeMembership(s.member.membership_id);
      if (mode === 'role') await s.memberships.setMembershipRoles(s.member.membership_id, []);
      if (mode === 'state') await s.write({ op: 'update', model: MODEL, id: ID, data: { title: 'Moved' } });
      return diagnostic();
    };
    await assert.rejects(queryGenerationCallbackDiagnosticsForViewer(input), mode === 'state'
      ? (error: unknown) => error instanceof FenceConflictError : stateCode('forbidden'));
    assert.equal(s.reads, 1, mode);
  }
});

test('authorized unsupported evidence exposes only its closed profile reason; injected raw details refuse', async () => {
  const s = await setup();
  const unsupported = await queryGenerationCallbackDiagnosticsForViewer({ ...s.input(), readDiagnostics: async () =>
    Object.freeze({ outcome: 'unsupported', reason: 'occurrence-correspondence' }) });
  assert.deepEqual(unsupported, { outcome: 'observed', revision: await s.store.readRevision(), origin: origin(),
    diagnostic: { outcome: 'unsupported', reason: 'occurrence-correspondence' } });
  await assert.rejects(queryGenerationCallbackDiagnosticsForViewer({ ...s.input(), readDiagnostics: async () => ({
    outcome: 'complete', snapshotAttribution: 'unsupported', failures: [{ ...failure(), details: 'private raw handler state' }],
  } as unknown as GenerationCallbackDiagnosticResult) }), stateCode('validation'));
});

test('port failures must correspond to the authorized delivery and checked ordinary callback identity', async () => {
  for (const changed of [{ deliveryId: 'other-delivery' }, { handler: 'Other.handler' },
    { event: 'LLM.generate.progressed' }, { occurrenceId: 'unrelated-occurrence' },
    { sourceOccurrence: 'unrelated-source' }] as const) {
    const s = await setup();
    await assert.rejects(queryGenerationCallbackDiagnosticsForViewer({ ...s.input(), readDiagnostics: async () => ({
      outcome: 'complete', snapshotAttribution: 'unsupported', failures: [{ ...failure(), ...changed }],
    } as GenerationCallbackDiagnosticResult) }), stateCode('validation'));
  }
});

test('origin and caller input are captured before the evidence await; output detaches port data', async () => {
  const s = await setup(), input = s.input(), retainedOrigin = structuredClone(input.origin);
  const mutable = { outcome: 'complete' as const, snapshotAttribution: 'unsupported' as const, failures: [failure()] };
  input.readDiagnostics = async (request, store) => {
    await s.input().readDiagnostics(request, store);
    (input.origin.scope as { owner: string }).owner = 'tampered-owner';
    (input.origin.handlers as string[]).push('tampered-handler');
    input.context.teamId = 'tampered-team';
    return mutable;
  };
  const result = await queryGenerationCallbackDiagnosticsForViewer(input);
  assert.equal(result.outcome, 'observed');
  if (result.outcome !== 'observed') return;
  assert.deepEqual(result.origin, retainedOrigin);
  mutable.failures[0] = { ...failure(), handler: 'changed-after-return' };
  assert.deepEqual(result.diagnostic, diagnostic());
  assert.ok(Object.isFrozen(result.origin.handlers));
});
