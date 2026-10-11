/** Finite State parent-metadata component using genuine owner/child/query receipts.
 * Contained-domain selector, original source and native qualification remain unfinished. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ClosedInputs, ModelName, Receipt, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildModelTable } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import type { ViewerSourceReadPolicy } from '../../src/query/source-policy.js';
import { invoke, type ExecutionEffects } from '../../src/invocation/invoke.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, IncompatibleArtifactError, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptCallProducer, invokeScenarioReceiptCall,
  bindScenarioReceiptQueryProducer, executeScenarioReceiptQuery, observeScenarioReceiptQueryDependency,
  bindScenarioReceiptQueryCount,
  bindScenarioReceiptReferenceProducer, bindScenarioReceiptModelResult, selectScenarioReceiptReturn,
  readScenarioReceiptAssociation, projectScenarioReceipt } from '../../src/invocation/scenario-receipt.js';
import { field, modelDef } from '../mutation/fixtures.js';
import { asId, asModel, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, makeRow, uuidv7 } from './fixtures.js';

const PARENT = asModel('QueryParentMetadata.Branch');
const TURN = asModel('QueryParentMetadata.Turn'), RUN = asModel('QueryParentMetadata.Run');
const ROOT = 'QueryParentMetadata.start', CHILD = 'QueryParentMetadata.reserve', APP = 'query-parent-metadata-components', TEAM = 'query-parent-metadata-team';
const CREATED = asId('created-run'), cause = { cause: 'scenario' } as const, bounds = { maxRows: 10, maxWork: 1000 };
const source = { path: 'query-parent-metadata.can', sha256: 'd'.repeat(64), module: 'query-parent-metadata.mjs' };
let sequence = 96_000;
function artifact(limit: number | null = null, skippedControl = false): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="QueryParentMetadata.start";', map: {
      version: 3, file: source.module, sources: [source.path], sourcesContent: [null], names: [], mappings: '',
    } }], callables: [ROOT, CHILD].map(id => ({ id, kind: 'operation' as const, module: source.module,
      export: 'identity', member: [id.split('.').at(-1)!] })),
    models: [{ name: PARENT, deleteMode: 'remove', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] }, { name: TURN, parent: PARENT, deleteMode: 'remove', fields: [
      ...['account', 'held', ...(skippedControl ? ['active'] : [])].map(name => ({
        name, field: { kind: 'string' as const }, required: true, serverOnly: false,
      })), { name: 'position', field: { kind: 'integer' as const }, required: false, serverOnly: false },
    ] }, { name: RUN, deleteMode: 'remove', fields: [
      ...['account', 'title'].map(name => ({ name, field: { kind: 'string' as const }, required: true, serverOnly: false })),
    ] }],
    operations: [ROOT, CHILD].map(name => ({ name, kind: 'scenario' as const, description: '', inputs: { fields: [] },
      result: { type: RUN as CanTypeId, disclosure: { version: 1 as const, source,
        ...(name === CHILD ? { queries: [{ id: 'turns', source, model: TURN,
          order: [{ field: 'id', direction: 'asc' as const }], limit, archived: 'exclude' as const,
          dependencies: [{ id: 'parent-control', source, role: 'control' as const, field: 'parent', type: PARENT as CanTypeId }, { id: 'account-control', source, role: 'control' as const, field: 'account', type: 'text' as CanTypeId },
            ...(skippedControl ? [{ id: 'active-control', source, role: 'control' as const, field: 'active', type: 'text' as CanTypeId }] : [])],
        }] } : {}),
        returns: [{ id: name === ROOT ? 'root-return' : 'child-return', source,
          dependencies: [],
          influences: name === CHILD ? (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
            .map(kind => ({ id: kind, kind, queryId: 'turns' })) : [],
        }],
      } } })),
  };
}
async function world(options: { domain?: 'empty' | 'false'; limit?: number; skippedControl?: boolean } = {}) {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const caller = await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false, roles: [] });
  const reader = await memberships.createMembership({ team_id: TEAM, user_id: 'turn-reader', is_owner: false, roles: [] });
  const parentReader = await memberships.createMembership({ team_id: TEAM, user_id: 'parent-reader', is_owner: false, roles: [] });
  const store = createMemoryStorage(), loaded = loadArtifactDescriptors(
    artifact(options.limit, options.skippedControl), { by: 'members' });
  const root = loaded.registry.get(ROOT), child = loaded.registry.get(CHILD);
  assert.ok(root && isGeneratedOperationDef(root)); assert.ok(child && isGeneratedOperationDef(child));
  const table = buildModelTable([
    modelDef(PARENT, { deleteMode: 'remove', fields: { title: field({ required: true }) } }),
    modelDef(TURN, { deleteMode: 'remove', fields: { account: field({ required: true }), held: field({ required: true }), position: field(),
      ...(options.skippedControl ? { active: field({ required: true }) } : {}) } }),
    modelDef(RUN, { deleteMode: 'remove', fields: { account: field({ required: true }), title: field({ required: true }) } }),
  ]);
  const rows: StoredRow[] = [];
  for (const id of ['branch-a', 'branch-b']) {
    const row = makeRow({ id, data: { title: id } });
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: PARENT, row }] }));
  }
  if (options.domain !== 'empty') for (const [id, account, held] of [
    ['turn-c', 'caller', '20'], ['turn-a', 'caller', '7'], ['turn-b', 'other', '100'],
  ] as const) {
    const row: StoredRow = { ...makeRow({ id, data: { account: options.domain === 'false' ? 'other' : account, held,
      ...(options.skippedControl ? { active: 'yes' } : {}) } }), parent: { model: PARENT, id: asId(id === 'turn-c' ? 'branch-b' : 'branch-a') } };
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: TURN, row }] }));
    const stored = await store.load(TURN, row.id); assert.ok(stored); rows.push(stored);
  }
  const access = { turn: true, run: true, active: true, parent: true };
  const policy = buildPolicyTable([
    { model: PARENT, secretFields: [], grants: [{ by: 'members', fields: ['title'] }] },
    { model: TURN, secretFields: [], grants: [{ by: 'members', fields: ['account', 'held', 'position', ...(options.skippedControl ? ['active'] : [])] }] },
    { model: RUN, secretFields: [], grants: [{ by: 'members', fields: ['account', 'title'] }] },
  ], loaded.models);
  const readPolicies = new Map<ModelName, ViewerSourceReadPolicy>();
  for (const [model, fields] of [[TURN, ['account', 'held', 'position']], [RUN, ['account', 'title']], [PARENT, ['title']]] as const) {
    readPolicies.set(model, { ...(model === TURN ? { parent: PARENT } : {}), fields: [...fields, ...(model === TURN && options.skippedControl ? ['active'] : [])],
      secretFields: [], grants: [{ fields: ['id', ...fields], read: async ({ context }) =>
      (model === TURN ? access.turn : model === PARENT ? access.parent : access.run) &&
      (await context.memberships.findMembership(TEAM, model === TURN ? 'turn-reader' : model === PARENT ? 'parent-reader' : 'caller'))?.status === 'active' &&
      context.membership?.status === 'active',
    }, ...(model === TURN && options.skippedControl ? [{ fields: ['active'], read: async () => access.active }] : [])] });
  }
  for (const def of [root, child]) bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  bindScenarioReceiptQueryProducer(child, { source, app: APP, policy });
  return { store, memberships, caller, reader, parentReader, root, child, table, policy, access, readPolicies, rows,
    skippedControl: options.skippedControl === true, registry: loaded.registry, app: APP, source: 'component', clock: { nowMs: () => FIXED_NOW },
    identity: makeIdentity({ membership: caller }), envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {}) };
}
type World = Awaited<ReturnType<typeof world>>;
type Session = Awaited<ReturnType<typeof beginScenarioReceiptMutation>>;
type Query = Awaited<ReturnType<typeof executeScenarioReceiptQuery>>;
type QueryHook = (call: AdmittedCall, session: Pick<Session, 'stage' | 'read' | 'views'>, query: Query) => Promise<void>;
const refuses = (error: unknown) => error instanceof StateError;
type MarkerMode = 'normal' | 'missing' | 'duplicate' | 'copied-slot' | 'wrong-slot' | 'late';
function bindChild(w: World, mode: MarkerMode = 'normal', hook?: QueryHook) {
  let previousSlot: Query['rows'][number]['slot'] | undefined;
  let executions = 0, predicates = 0, closedCall: AdmittedCall | undefined, captured: Query | undefined;
  bindScenarioReceiptCallProducer(w.root, { source, app: APP, registry: w.registry,
    sites: [{ id: 'reserve-site', source, kind: 'operation', targets: [{ operation: CHILD, interface: w.child.descriptor }],
      resultType: RUN as CanTypeId }], prepare: (_def, inputs) => inputs as ClosedInputs,
    execute: async frame => {
      executions++; closedCall = frame.call;
      const result = await executeScenarioReceiptQuery(frame.call, w.store, { queryId: 'turns', predicate: ({ slot, record }) => {
        predicates++; const account = record.data.account;
        observeScenarioReceiptQueryDependency(frame.call, w.store, { slot, dependencyId: 'account-control' });
        if (account !== 'caller') { previousSlot = slot; return false; }
        const parent = record.parent;
        if (mode !== 'missing' && mode !== 'late') observeScenarioReceiptQueryDependency(frame.call, w.store, {
          slot: mode === 'copied-slot' ? { ...slot } : mode === 'wrong-slot' && previousSlot !== undefined ? previousSlot : slot, dependencyId: 'parent-control' });
        if (mode === 'duplicate') observeScenarioReceiptQueryDependency(frame.call, w.store, { slot, dependencyId: 'parent-control' });
        if (mode === 'late') { void record.data.held; observeScenarioReceiptQueryDependency(frame.call, w.store, { slot, dependencyId: 'parent-control' }); }
        previousSlot = slot;
        // Native-style equality reads only the actual lazy top-level parent metadata.
        return parent?.model === PARENT && parent.id === 'branch-a';
      } });
      captured = result; await hook?.(frame.call, frame.session, result);
      // Actual owner count consumer feeds the created row. State does not attest this arithmetic.
      const count = await bindScenarioReceiptQueryCount(frame.call, w.store, { query: result.query });
      assert.equal(typeof count, 'bigint'); assert.equal(count, 1n);
      await frame.session.stage({ op: 'create', model: RUN, id: CREATED,
        data: { account: 'caller', title: count.toString() } }, cause);
      const row = await frame.session.read(RUN, CREATED); assert.ok(row);
      const wire = await bindScenarioReceiptModelResult(frame.call, w.store, { returnId: 'child-return', row });
      selectScenarioReceiptReturn(frame.call, w.store, 'child-return'); return wire;
    } });
  return { get executions() { return executions; }, get predicates() { return predicates; },
    get closedCall() { return closedCall; }, get captured() { return captured; } };
}
async function child(call: AdmittedCall, w: World) {
  return invokeScenarioReceiptCall(call, w.store, { site: 'reserve-site', target: CHILD, inputs: {} });
}
async function finish(call: AdmittedCall, w: World, session: Session, wire: unknown): Promise<ExecutionEffects> {
  selectScenarioReceiptReturn(call, w.store, 'root-return');
  return { ...await session.finalize(), result: wire, outbox: [] };
}
function input(w: World, observed?: (receipt: Receipt) => void, after?: (call: AdmittedCall, session: Session) => Promise<void>) {
  return { ...w, ...(observed === undefined ? {} : { observeCommittedReceipt: observed }), execute: async (call: AdmittedCall) => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    assert.deepEqual(await child(call, w), { id: CREATED });
    const row = await session.read(RUN, CREATED); assert.ok(row);
    const wire = await bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row });
    await session.stage({ op: 'update', model: RUN, id: CREATED, data: { title: 'Started' } }, cause);
    await after?.(call, session); return finish(call, w, session, wire);
  } };
}
async function unchanged(w: World) {
  assert.equal(await w.store.load(RUN, CREATED), null);
  for (const row of w.rows) assert.deepEqual(await w.store.load(TURN, row.id), row);
  assert.deepEqual(await w.store.historyFor(RUN, CREATED), []); assert.deepEqual(await w.store.outboxPending(), []);
}

test('top-level parent metadata retains true, false and short-circuited observations across two parent owners', async () => {
  const w = await world(), producer = bindChild(w); let receipt: Receipt | undefined;
  const request = input(w, value => { receipt = value; });
  assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
  const saved = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!;
  const query = saved.queries![0]!;
  assert.equal(query.candidates.length, 3);
  assert.deepEqual(query.selectedIndices.map(index => query.candidates[index]!.row.id), ['turn-a']);
  for (const candidate of query.candidates) {
    assert.equal(Object.hasOwn(candidate.record.data, 'parent'), false);
    assert.deepEqual(candidate.record.parent, candidate.row.parent);
    assert.equal(candidate.dependencies.includes('parent-control'), candidate.row.id !== 'turn-b');
    assert.equal(candidate.dependencies.includes('account-control'), true);
    assert.equal(candidate.matched, candidate.row.id === 'turn-a');
  }
  assert.deepEqual(saved.observations, []);
  assert.equal((await w.store.historyFor(RUN, CREATED))[0]!.after!.title, 'Started');
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
  const retained = structuredClone(receipt);
  assert.equal((await invoke(request)).status, 'replayed');
  assert.equal(producer.executions, 1); assert.equal(producer.predicates, 3);
  assert.deepEqual(receipt, retained);
});

test('parent metadata requires its immediate actual marker and original active slot', async () => {
  for (const mode of ['missing', 'duplicate', 'copied-slot', 'wrong-slot', 'late'] as const) {
    const w = await world(); bindChild(w, mode);
    await assert.rejects(invoke(input(w)), refuses); await unchanged(w);
  }
  const w = await world();
  bindChild(w, 'normal', async (call, _session, query) => {
    assert.ok(query.rows[0]);
    assert.throws(() => observeScenarioReceiptQueryDependency(call, w.store,
      { slot: query.rows[0]!.slot, dependencyId: 'parent-control' }), refuses);
  });
  await assert.rejects(invoke(input(w)), refuses); await unchanged(w);
});

test('complete parent source authority and tracked ancestor Identity govern commit and saved disclosure', async () => {
  for (const loss of ['source', 'ancestor', 'ancestor-membership'] as const) {
    const revoke = async (w: World) => {
      if (loss === 'source') w.access.turn = false;
      else if (loss === 'ancestor') w.access.parent = false;
      else await w.memberships.removeMembership(w.parentReader.membership_id);
    };
    const failed = await world(); bindChild(failed);
    await assert.rejects(invoke(input(failed, undefined, async () => revoke(failed))), refuses);
    await unchanged(failed);
    const w = await world(), producer = bindChild(w); let receipt: Receipt | undefined;
    const request = input(w, value => { receipt = value; });
    await invoke(request); assert.ok(receipt);
    assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
    await revoke(w);
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
    assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.executions, 1);
  }
});

test('saved parent metadata cannot replace or detach the original candidate linkage', async () => {
  const w = await world(); bindChild(w); let receipt: Receipt | undefined;
  await invoke(input(w, value => { receipt = value; })); assert.ok(receipt);
  for (const mode of ['projected-parent', 'raw-parent', 'wrong-model', 'missing-parent', 'business-field'] as const) {
    const altered: Receipt = structuredClone(receipt); assert.equal(altered.outcome.status, 'committed');
    if (altered.outcome.status !== 'committed') throw new Error('Expected committed receipt');
    const query = altered.outcome.scenario!.calls![0]!.scenario!.queries![0]!;
    const candidate = query.candidates.find(value => value.row.id === 'turn-a')!;
    if (mode === 'projected-parent') Object.assign(candidate.record, { parent: { model: PARENT, id: 'branch-b' } });
    if (mode === 'raw-parent') Object.assign(candidate.row, { parent: { model: PARENT, id: 'branch-b' } });
    if (mode === 'wrong-model') Object.assign(candidate.record, { parent: { model: RUN, id: 'branch-a' } });
    if (mode === 'missing-parent') Reflect.deleteProperty(candidate.record, 'parent');
    if (mode === 'business-field') {
      Reflect.deleteProperty(candidate.record, 'parent');
      Object.assign(candidate.record.data, { parent: { id: 'branch-a' } });
    }
    assert.throws(() => readScenarioReceiptAssociation(altered), refuses);
  }
});

test('query parent loader requires unshadowed exact singular declared containment', () => {
  for (const mode of ['absent', 'wrong', 'nullable', 'array', 'shadowed'] as const) {
    const descriptor = artifact(), model = descriptor.models!.find(model => model.name === TURN)!;
    const operation = descriptor.operations!.find(operation => operation.name === CHILD)!;
    const dependency = operation.result!.disclosure!.queries![0]!.dependencies.find(dependency => dependency.field === 'parent')!;
    if (mode === 'absent') Reflect.deleteProperty(model, 'parent');
    if (mode === 'wrong') model.parent = RUN;
    if (mode === 'nullable') Reflect.set(dependency, 'type', `${PARENT}?`);
    if (mode === 'array') Reflect.set(dependency, 'type', `${PARENT}[]`);
    if (mode === 'shadowed') model.fields.push({ name: 'parent', field: { kind: 'ref', model: PARENT },
      required: true, serverOnly: false, valueType: PARENT as CanTypeId });
    assert.throws(() => loadArtifactDescriptors(descriptor, { by: 'members' }), error => error instanceof IncompatibleArtifactError);
  }
});
