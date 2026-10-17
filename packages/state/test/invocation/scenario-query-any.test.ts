/** Direct State Any receiver; original Compiler/native workflow remains separate. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ModelName, Receipt, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import type { ViewerSourceReadPolicy } from '../../src/query/source-policy.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { invoke } from '../../src/invocation/invoke.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptReferenceProducer, bindScenarioReceiptQueryProducer,
  executeScenarioReceiptAny, observeScenarioReceiptQueryDependency, bindScenarioReceiptModelResult,
  selectScenarioReceiptReturn, readScenarioReceiptAssociation, projectScenarioReceipt } from '../../src/invocation/scenario-receipt.js';
import { bindScenarioQueryAny } from '../../src/invocation/scenario-query-any.js';
import { asId, asModel, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, makeRow, uuidv7, type RowOpts } from './fixtures.js';

const CONVERSATION = asModel('AnyReader.Conversation'), BRANCH = asModel('AnyReader.Branch');
const RUN = asModel('AnyReader.Run'), RESULT = asModel('AnyReader.Reservation');
const OP = 'AnyReader.reserve', APP = 'any-reader', QUERY = 'unfinished-runs', DEP = 'unfinished-control';
const source = { path: 'any-reader.can', module: 'any-reader.mjs', sha256: 'c'.repeat(64) };
const cause = { cause: 'scenario' } as const;
const refuses = (error: unknown) => error instanceof StateError;
let sequence = 142_000;
type Mode = 'normal' | 'missing-marker' | 'wrong-verdict' | 'copied-slot' | 'wrong-slot' | 'copied-call' | 'foreign-store' | 'twice' | 'post-callback' | 'suffix-failure' | 'original-guard';
type Slot = Parameters<typeof observeScenarioReceiptQueryDependency>[2]['slot'];

async function world(domain: 'empty' | 'false' | 'first' | 'middle' = 'middle', denySuffix = false) {
  const slice: ArtifactDescriptorSlice = { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="AnyReader.reserve";', map: { version: 3, file: source.module,
      sources: [source.path], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: source.module, export: 'identity', member: ['reserve'] }],
    models: [
      { name: CONVERSATION, deleteMode: 'archive', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] },
      { name: BRANCH, parent: CONVERSATION, deleteMode: 'archive', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] },
      { name: RUN, parent: BRANCH, deleteMode: 'archive', fields: [{ name: 'unfinished', field: { kind: 'boolean' }, valueType: 'bool' as CanTypeId, required: true, serverOnly: false }] },
      { name: RESULT, parent: BRANCH, deleteMode: 'archive', fields: [{ name: 'blocked', field: { kind: 'boolean' }, valueType: 'bool' as CanTypeId, required: true, serverOnly: false }] },
    ], operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'branch', field: { kind: 'ref', model: BRANCH, requireVersion: true }, required: true },
    ] }, result: { type: RESULT as CanTypeId, disclosure: { version: 1, source,
      queries: [{ id: QUERY, source, model: RUN, parent: { source, model: BRANCH, origin: { kind: 'admitted-reference', parameter: 'branch' } },
        order: [], limit: null, archived: 'exclude', dependencies: [{ id: DEP, source, role: 'control', field: 'unfinished', type: 'bool' as CanTypeId }] }],
      returns: [{ id: 'reservation', source, dependencies: [], influences:
        (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const).map(kind => ({ id: kind, kind, queryId: QUERY })) }],
    } } }] };
  const loaded = loadArtifactDescriptors(slice, { by: 'members' }), def = loaded.registry.get(OP);
  assert.ok(def && isGeneratedOperationDef(def));
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const user = await memberships.createUser({ email: 'any-reader@example.test', password_hash: 'unused', email_verified: true });
  const other = await memberships.createUser({ email: 'any-authority@example.test', password_hash: 'unused', email_verified: true });
  const caller = await memberships.createMembership({ team_id: team.team_id, user_id: user.user_id, roles: [], is_owner: false });
  const reader = await memberships.createMembership({ team_id: team.team_id, user_id: other.user_id, roles: [], is_owner: false });
  const access = { run: true, parent: true, ancestor: true }, scanned = new Set<string>(), ancestors = new Set<ModelName>();
  const policy = buildPolicyTable([], loaded.models), readPolicies = new Map<ModelName, ViewerSourceReadPolicy>();
  for (const [model, fields, parent] of [[CONVERSATION, ['title'], undefined], [BRANCH, ['title'], CONVERSATION],
    [RUN, ['unfinished'], BRANCH], [RESULT, ['blocked'], BRANCH]] as const) readPolicies.set(model, {
    ...(parent === undefined ? {} : { parent }), fields: [...fields], secretFields: [], grants: [{ fields: ['id', ...fields],
      read: async ({ context }) => {
        if (model === CONVERSATION || model === BRANCH) ancestors.add(model);
        return (model === RUN ? access.run : model === BRANCH ? access.parent : model === CONVERSATION ? access.ancestor : true) &&
          context.membership?.status === 'active' && (await context.memberships.findMembership(team.team_id, other.user_id))?.status === 'active';
      } }],
  });
  readPolicies.set(RUN, { parent: BRANCH, fields: ['unfinished'], secretFields: [], grants: [
    { fields: ['id'], read: async ({ context, row }) => {
      scanned.add(row.id); return context.membership?.status === 'active' &&
        (await context.memberships.findMembership(team.team_id, other.user_id))?.status === 'active';
    } },
    { fields: ['unfinished'], read: async ({ context, row }) => access.run && !(denySuffix && row.id === 'c') &&
      context.membership?.status === 'active' && (await context.memberships.findMembership(team.team_id, other.user_id))?.status === 'active' },
  ] });
  bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  bindScenarioReceiptQueryProducer(def, { source, app: APP, policy, readPolicies, any: [{ queryId: QUERY, dependencyId: DEP }] });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, containment: loaded.containment, nullableFields: loaded.nullableFields });
  const seed = async (model: ModelName, opts: RowOpts & Pick<StoredRow, 'parent'>) => {
    const row = { ...makeRow(opts), ...(opts.parent === undefined ? {} : { parent: opts.parent }) };
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model, row }] })); return row;
  };
  const conversation = await seed(CONVERSATION, { id: 'conversation', data: { title: 'Conversation' } });
  const branch = await seed(BRANCH, { id: 'branch', parent: { model: CONVERSATION, id: conversation.id }, data: { title: 'Branch' } });
  const foreign = await seed(BRANCH, { id: 'other-branch', parent: { model: CONVERSATION, id: conversation.id }, data: { title: 'Other' } });
  if (domain !== 'empty') for (const id of ['c', 'b', 'a']) await seed(RUN, { id,
    created: FIXED_NOW + (id === 'c' ? 1 : 0), parent: { model: BRANCH, id: branch.id },
    data: { unfinished: domain === 'first' ? id === 'a' : domain === 'middle' ? id === 'b' : false } });
  await seed(RUN, { id: 'foreign', parent: { model: BRANCH, id: foreign.id }, data: { unfinished: true } });
  await seed(RUN, { id: 'archived', parent: { model: BRANCH, id: branch.id }, archivedAt: FIXED_NOW, data: { unfinished: true } });
  return { store, memberships, caller, reader, access, table, policy, readPolicies, registry: loaded.registry,
    app: APP, source: 'component', clock: { nowMs: () => FIXED_NOW }, identity: makeIdentity({ team, userId: user.user_id, membership: caller }),
    envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), { branch: { id: branch.id, version: '1' } }), branch, domain, scanned, ancestors };
}
type World = Awaited<ReturnType<typeof world>>;
function execution(w: World, mode: Mode = 'normal', after?: () => Promise<void> | void) {
  let receipt: Receipt | undefined, executions = 0, prior: Slot | undefined, last: Slot | undefined;
  const visited: string[] = [];
  const request = { ...w, observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
    executions++; const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds: { maxRows: 10, maxWork: 1000 } });
    const any = () => executeScenarioReceiptAny(mode === 'copied-call' ? { ...call } : call,
      mode === 'foreign-store' ? { ...w.store } : w.store, { queryId: QUERY, predicate: ({ slot, record }) => {
        assert.deepEqual([...w.scanned].sort(), ['a', 'b', 'c'], 'complete source-visible scoped domain precedes the first predicate');
        assert.ok(w.ancestors.has(CONVERSATION) && w.ancestors.has(BRANCH), 'source ancestor policies precede the first predicate');
        visited.push(record.id); last = slot;
        if (mode === 'suffix-failure' && record.id === 'c') throw new Error('Unvisited suffix must not execute');
        const unfinished = record.data.unfinished;
        if (mode !== 'missing-marker') observeScenarioReceiptQueryDependency(call, w.store, {
          slot: mode === 'copied-slot' ? { ...slot } : mode === 'wrong-slot' && prior ? prior : slot, dependencyId: DEP });
        prior = slot;
        return mode === 'wrong-verdict' ? !unfinished : unfinished as boolean;
      } });
    const blocked = await any();
    if (mode === 'original-guard' && blocked) throw new StateError('rule_failed', 'Original Require(not Any) failed');
    if (mode === 'twice') { await assert.rejects(any(), refuses); await assert.rejects(session.finalize(), refuses); throw new StateError('validation', 'Caught repeat poisoned owner'); }
    if (mode === 'post-callback') { assert.ok(last); const finishedSlot = last;
      assert.throws(() => observeScenarioReceiptQueryDependency(call, w.store, { slot: finishedSlot, dependencyId: DEP }), refuses); }
    await after?.();
    await session.stage({ op: 'create', model: RESULT, id: asId('reservation'), parent: { model: BRANCH, id: w.branch.id }, data: { blocked } }, cause);
    const row = await session.read(RESULT, asId('reservation')); assert.ok(row);
    const result = await bindScenarioReceiptModelResult(call, w.store, { returnId: 'reservation', row });
    selectScenarioReceiptReturn(call, w.store, 'reservation'); return { ...await session.finalize(), result, outbox: [] };
  } };
  return { request, visited, executions: () => executions, receipt: () => { assert.ok(receipt); return receipt; } };
}
async function unchanged(w: World) {
  assert.equal(await w.store.load(RESULT, asId('reservation')), null);
  assert.deepEqual(await w.store.historyFor(RESULT, asId('reservation')), []); assert.deepEqual(await w.store.outboxPending(), []);
}

test('Any retains complete scoped created/id domain but evaluates only through first true, including empty/all-false', async () => {
  for (const domain of ['empty', 'false', 'first', 'middle'] as const) {
    const w = await world(domain), ex = execution(w, domain === 'middle' ? 'suffix-failure' : 'normal');
    assert.equal((await invoke(ex.request)).status, 'committed');
    assert.deepEqual(ex.visited, domain === 'empty' ? [] : domain === 'first' ? ['a'] : domain === 'middle' ? ['a', 'b'] : ['a', 'b', 'c']);
    assert.equal((await w.store.load(RESULT, asId('reservation')))!.data.blocked, domain === 'first' || domain === 'middle');
    const saved = readScenarioReceiptAssociation(ex.receipt())!; assert.deepEqual(saved.observations, []);
    assert.deepEqual(saved.queries![0]!.candidates.map(candidate => candidate.row.id), domain === 'empty' ? [] : ['a', 'b', 'c']);
    assert.deepEqual((await projectScenarioReceipt({ ...w, receipt: ex.receipt() })).result, { id: 'reservation' });
    const revision = await w.store.readRevision();
    assert.equal((await invoke(ex.request)).status, 'replayed'); assert.equal(ex.executions(), 1); assert.equal(await w.store.readRevision(), revision);
  }
});

test('Any refuses missing/verdict/slot/call/store/repeated/post-callback observations and rolls back', async () => {
  for (const mode of ['missing-marker', 'wrong-verdict', 'copied-slot', 'wrong-slot', 'copied-call', 'foreign-store', 'twice', 'post-callback'] as const) {
    const w = await world('false'), ex = execution(w, mode);
    await assert.rejects(invoke(ex.request), refuses); await unchanged(w);
  }
});

test('original Require(not Any) refuses before create on first true and admits empty/all-false', async () => {
  for (const domain of ['empty', 'false', 'first'] as const) {
    const w = await world(domain), ex = execution(w, 'original-guard');
    if (domain === 'first') {
      await assert.rejects(invoke(ex.request), error => error instanceof StateError && error.code === 'rule_failed' && error.message === 'Original Require(not Any) failed');
      assert.deepEqual(ex.visited, ['a']); await unchanged(w);
    } else { assert.equal((await invoke(ex.request)).status, 'committed'); assert.equal((await w.store.load(RESULT, asId('reservation')))!.data.blocked, false); }
  }
});

test('Any skips a denied unfinished suffix field but refuses if all-false evaluation reaches it', async () => {
  const skipped = await world('middle', true), accepted = execution(skipped);
  assert.equal((await invoke(accepted.request)).status, 'committed'); assert.deepEqual(accepted.visited, ['a', 'b']);
  assert.deepEqual([...skipped.scanned].sort(), ['a', 'b', 'c']);
  assert.deepEqual((await projectScenarioReceipt({ ...skipped, receipt: accepted.receipt() })).result, { id: 'reservation' });
  const reached = await world('false', true), refused = execution(reached);
  await assert.rejects(invoke(refused.request), refuses); assert.deepEqual(refused.visited, ['a', 'b']); await unchanged(reached);
});

test('Any requires source parent/ancestor/related SDK authority before candidates and at final and saved disclosure', async () => {
  for (const loss of ['run', 'parent', 'ancestor', 'identity'] as const) {
    for (const timing of ['before', 'late', 'saved'] as const) {
      const w = await world('middle');
      const revoke = async () => { if (loss === 'identity') await w.memberships.removeMembership(w.reader.membership_id); else w.access[loss] = false; };
      if (timing === 'before') await revoke();
      const ex = execution(w, 'normal', timing === 'late' ? revoke : undefined);
      if (timing !== 'saved') { await assert.rejects(invoke(ex.request), refuses); await unchanged(w); continue; }
      await invoke(ex.request); const receipt = ex.receipt(); await revoke();
      assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] }); assert.equal(ex.executions(), 1);
    }
  }
});

test('Any saved backend corruption cannot omit a visited prefix marker or manufacture a suffix visit', async () => {
  for (const corruption of ['prefix', 'suffix'] as const) {
    const w = await world('middle'), ex = execution(w); await invoke(ex.request);
    const receipt = ex.receipt(), saved = readScenarioReceiptAssociation(receipt)!;
    assert.ok(receipt.outcome.status === 'committed');
    const queries = saved.queries!.map(query => ({ ...query, candidates: query.candidates.map(candidate =>
      candidate.row.id === (corruption === 'prefix' ? 'a' : 'c') ? { ...candidate,
        dependencies: corruption === 'prefix' ? [] : [DEP] } : candidate) }));
    const altered: Receipt = { ...receipt, outcome: { ...receipt.outcome, scenario: { ...saved, queries } } };
    assert.ok(readScenarioReceiptAssociation(altered), 'structurally valid query reaches the source-bound Any correspondence');
    let backendReads = 0;
    const store = { ...w.store, readReceipt: async (identity: Receipt['identity']) => {
      backendReads++; assert.deepEqual((await w.store.readReceipt(identity))?.identity, receipt.identity); return altered;
    } };
    const revision = await w.store.readRevision();
    assert.deepEqual(await projectScenarioReceipt({ ...w, store, receipt: altered }), { result: null, records: [] });
    assert.ok(backendReads > 0); assert.equal(await w.store.readRevision(), revision); assert.equal(ex.executions(), 1);
  }
});

test('Navigated predicate stripped of its owning call association refuses at bind', () => {
  // The legacy root-only no-sourceCall allowance must not extend to the
  // navigated predicate profile: without sourceCall (and, for direct,
  // without the checked call record) the bind refuses even when the
  // parent query, census and source all match.
  const query = { id: QUERY, source, model: RUN,
    parent: { source, model: BRANCH, origin: { kind: 'admitted-reference', parameter: 'branch' } },
    order: [], limit: null, archived: 'exclude',
    dependencies: [{ id: DEP, source, role: 'control', field: 'unfinished', type: 'bool' }] };
  const bound = { plan: { version: 1, source, queries: [query], returns: [] },
    artifactModels: new Map(), canonicalModels: [] };
  const stripped = { kind: 'predicate', queryId: QUERY, dependencyIds: [DEP] };
  assert.throws(() => bindScenarioQueryAny(bound as unknown as Parameters<typeof bindScenarioQueryAny>[0],
    stripped as Parameters<typeof bindScenarioQueryAny>[1]),
  error => error instanceof StateError &&
    /navigated predicate requires its exact owning call association/.test(error.message));
});
