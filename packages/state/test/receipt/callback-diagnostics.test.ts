/** State authority around a finite evidence port; Work owns evidence qualification. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GenerationCallbackDiagnosticRequest, GenerationCallbackDiagnosticResult,
  GenerationCallbackFailure, GenerationCallbackOrigin, ModelName, QueryPredicate, StoragePort } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { queryGenerationCallbackDiagnosticsForViewer,
  type ViewerGenerationCallbackDiagnosticInput } from '../../src/receipt/callback-diagnostics.js';
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

/** Installed Native hooks consume State's observed row and tracked Identity reader. */
type MutableDiagnosticInput = { -readonly [Key in keyof ViewerGenerationCallbackDiagnosticInput]:
  ViewerGenerationCallbackDiagnosticInput[Key] };
function installedInput(s: Awaited<ReturnType<typeof setup>>): MutableDiagnosticInput {
  const { origin: _origin, callbackPolicy: _callbackPolicy, ...input } = s.input();
  return { ...input, callbackRead: async () => true, resolveOrigin: async () => origin() };
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

test('authorized absent delivery needs no invented origin and never resolves origin or reads Work', async () => {
  for (const installResolver of [false, true]) {
    const s = await setup({ association: false }), input = installedInput(s);
    let resolutions = 0;
    const { resolveOrigin: _resolver, ...withoutResolver } = input;
    const result = await queryGenerationCallbackDiagnosticsForViewer(installResolver ? {
      ...withoutResolver, resolveOrigin: async () => { resolutions++; throw new Error('absent origin lookup'); },
    } : withoutResolver);
    assert.deepEqual(result, { outcome: 'no-association', revision: await s.store.readRevision() });
    assert.equal(resolutions, 0);
    assert.equal(s.reads, 0);
  }
});

test('empty delivery denied by installed callback predicate performs no origin, association or Work lookup', async () => {
  const s = await setup({ association: false }), load = s.store.cohortLoad.bind(s.store);
  s.store.cohortLoad = async request => {
    assert.notEqual(request.model, RECEIPT_ASSOCIATION_MODEL);
    return load(request);
  };
  let predicates = 0, resolutions = 0;
  const result = await queryGenerationCallbackDiagnosticsForViewer({ ...installedInput(s),
    callbackRead: async ({ row, context }) => {
      predicates++; assert.equal(row.data.request, null); assert.equal(context.actorUserId, 'caller'); return false;
    },
    resolveOrigin: async () => { resolutions++; throw new Error('denied origin lookup'); },
  });
  assert.deepEqual(result, { outcome: 'withheld' });
  assert.equal(predicates, 1);
  assert.equal(resolutions, 0);
  assert.equal(s.reads, 0);
});

test('installed origin resolver receives exact current association and preserves original source revision', async () => {
  const s = await setup(), revision = await s.store.readRevision();
  let resolutions = 0;
  const result = await queryGenerationCallbackDiagnosticsForViewer({ ...installedInput(s),
    callbackRead: async ({ row, context, revision: observedRevision, fence }) => {
      assert.equal(row.id, ID); assert.equal(row.data.title, 'Book');
      assert.equal(context.actorUserId, 'caller'); assert.equal(context.teamId, TEAM);
      assert.equal(observedRevision, revision); assert.equal(fence, undefined); return true;
    },
    resolveOrigin: async (request, store) => {
      resolutions++; assert.equal(store, s.store);
      assert.deepEqual(request, { model: MODEL, recordId: ID, field: 'request', deliveryId: DELIVERY,
        source: 'std.ImagesV1.submit', expectedRevision: revision });
      return origin();
    },
  });
  assert.deepEqual(result, { outcome: 'observed', revision, origin: origin(), diagnostic: diagnostic() });
  assert.equal(resolutions, 1);
  assert.equal(s.requests[0]!.origin.sourceRevision, '7');
  assert.notEqual(s.requests[0]!.origin.sourceRevision, String(revision));

  for (const mismatch of ['id', 'source'] as const) {
    const invalidAssociation = await setup({ association: false });
    await invalidAssociation.write({ op: 'update', model: MODEL, id: ID,
      data: { request: { id: DELIVERY, operation: origin().source } } });
    await invalidAssociation.associate(mismatch === 'id' ? 'different-delivery' : DELIVERY,
      mismatch === 'source' ? 'std.TextGenerationV1.generate' : origin().source);
    await assert.rejects(queryGenerationCallbackDiagnosticsForViewer({ ...installedInput(invalidAssociation),
      resolveOrigin: async () => { assert.fail('resolver must follow exact association matching'); },
    }), stateCode('validation'));
    assert.equal(invalidAssociation.reads, 0);
  }
});

test('installed relational callback predicate uses the observed parent, current account and tracked subject membership', async () => {
  for (const recovery of [false, true]) {
    for (const mode of ['allowed', 'account', 'subject', 'parent', 'subject-during-work', 'parent-during-work'] as const) {
      const s = await setup({ parent: true, archive: true });
      const subject = await s.memberships.createMembership({ team_id: TEAM, user_id: 'Book', is_owner: false,
        roles: [{ role: ROLE, granted_at: new Date(FIXED_NOW).toISOString(), granted_by: 'caller' }] });
      if (mode === 'account') await s.memberships.createMembership({ team_id: TEAM, user_id: 'other-account',
        is_owner: false, roles: [] });
      if (mode === 'subject') await s.memberships.removeMembership(subject.membership_id);
      if (mode === 'parent') await s.write({ op: 'remove', model: PARENT, id: asId('shelf') });
      const input = installedInput(s);
      if (mode === 'account') input.context = { actorUserId: 'other-account', teamId: TEAM };
      if (recovery) input.policy = policyTable(modelPolicy(MODEL, { grants: [
        grant('members', ['request.id']),
        grant('members', ['request.result'], { op: 'eq', field: 'title', value: 'Unmet result condition' }),
      ] }), modelPolicy(PARENT, { grants: [grant('members', ['title'])] }));
      let predicates = 0;
      input.callbackRead = async ({ context, row }) => {
        predicates++;
        assert.notEqual(context.memberships, s.memberships, 'predicate must use the authority observation reader');
        if (row.createdBy !== context.actorUserId || row.data.title !== 'Book' ||
            row.parent?.model !== PARENT || row.parent.id !== 'shelf' || context.teamId === null) return false;
        const currentSubject = await context.memberships.findMembership(context.teamId, row.data.title as string);
        return currentSubject?.status === 'active' && currentSubject.roles.some(role => role.role === ROLE);
      };
      input.readDiagnostics = async (request, store) => {
        await s.input().readDiagnostics(request, store);
        if (mode === 'subject-during-work') await s.memberships.removeMembership(subject.membership_id);
        if (mode === 'parent-during-work') await s.write({ op: 'remove', model: PARENT, id: asId('shelf') });
        return diagnostic();
      };
      if (mode === 'subject-during-work' || mode === 'parent-during-work') {
        await assert.rejects(queryGenerationCallbackDiagnosticsForViewer(input), mode === 'parent-during-work'
          ? (error: unknown) => error instanceof FenceConflictError : stateCode('forbidden'));
        assert.equal(s.reads, 1);
      } else {
        const result = await queryGenerationCallbackDiagnosticsForViewer(input);
        assert.equal(result.outcome, mode === 'allowed' ? 'observed' : 'withheld');
        assert.equal(s.reads, mode === 'allowed' ? 1 : 0);
      }
      if (mode === 'parent') assert.equal(predicates, 0, 'parent authority precedes callback evaluation');
      if (mode === 'allowed') assert.equal(predicates, 2, 'relational subjects require complete snapshot evaluation');
    }
  }
});

test('Identity and State movement during installed predicate and origin resolver awaits refuses disclosure', async () => {
  for (const stage of ['predicate', 'resolver'] as const) {
    for (const movement of ['identity', 'state'] as const) {
      const s = await setup(), input = installedInput(s);
      const move = async () => {
        if (movement === 'identity') await s.memberships.removeMembership(s.member.membership_id);
        else await s.write({ op: 'update', model: MODEL, id: ID, data: { title: 'Moved' } });
      };
      if (stage === 'predicate') input.callbackRead = async () => { await move(); return true; };
      else input.resolveOrigin = async () => { await move(); return origin(); };
      await assert.rejects(queryGenerationCallbackDiagnosticsForViewer(input), movement === 'state'
        ? (error: unknown) => error instanceof FenceConflictError : stateCode('forbidden'));
      assert.equal(s.reads, 0, `${stage}/${movement} must refuse before Work`);
    }
  }
});

test('installed callback authority requires a boolean and one exclusive policy implementation', async () => {
  for (const malformed of ['true', 1, null, {}]) {
    const s = await setup();
    await assert.rejects(queryGenerationCallbackDiagnosticsForViewer({ ...installedInput(s),
      callbackRead: async () => malformed as unknown as boolean,
      resolveOrigin: async () => { assert.fail('malformed callback authority cannot resolve origin'); },
    }), stateCode('validation'));
    assert.equal(s.reads, 0);
  }
  const s = await setup();
  await assert.rejects(queryGenerationCallbackDiagnosticsForViewer({ ...installedInput(s),
    callbackPolicy: s.callbackPolicy(),
  }), stateCode('validation'));
  await assert.rejects(queryGenerationCallbackDiagnosticsForViewer({ ...installedInput(s),
    origin: origin(),
  }), stateCode('validation'));
  const { callbackRead: _predicate, ...missingAuthority } = installedInput(s);
  await assert.rejects(queryGenerationCallbackDiagnosticsForViewer(missingAuthority), stateCode('validation'));
  assert.equal(s.reads, 0);
});

test('installed origin and refusal outputs reject malformed shape, wrong source, field and owner', async () => {
  for (const mode of ['shape', 'source', 'field', 'owner', 'refusal'] as const) {
    const s = await setup(), input = installedInput(s);
    input.resolveOrigin = async () => {
      if (mode === 'shape') return { ...origin(), sourceRevision: 'association-revision' };
      if (mode === 'source') return { ...origin(), source: 'std.TextGenerationV1.generate',
        event: 'Callback.Images.generate.progressed' };
      if (mode === 'owner') return { ...origin(), scope: { ...origin().scope, owner: 'other-team' } };
      return origin();
    };
    if (mode === 'field') input.field = 'otherRequest';
    if (mode === 'refusal') input.readDiagnostics = async (request, store) => {
      await s.input().readDiagnostics(request, store);
      return { outcome: 'unsupported', reason: 'private-source-failure' } as unknown as GenerationCallbackDiagnosticResult;
    };
    if (mode === 'owner') {
      assert.deepEqual(await queryGenerationCallbackDiagnosticsForViewer(input), { outcome: 'withheld' });
    } else await assert.rejects(queryGenerationCallbackDiagnosticsForViewer(input), stateCode('validation'));
    assert.equal(s.reads, mode === 'refusal' ? 1 : 0);
  }
});
