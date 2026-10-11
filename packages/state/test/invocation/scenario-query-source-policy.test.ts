/** Finite owning query receiver with installed ordinary source grants and no
 * static Budget grant. Native source/app qualification remains separately owned. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ClosedInputs, ModelName, Receipt, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import { projectCurrentRecordForViewerSourcePolicies, type ViewerSourceReadPolicy, type ViewerGenerationCallbackReadObservation } from '../../src/query/source-policy.js';
import { invoke, type ExecutionEffects } from '../../src/invocation/invoke.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptCallProducer, invokeScenarioReceiptCall,
  bindScenarioReceiptQueryProducer, executeScenarioReceiptQuery, observeScenarioReceiptQueryDependency,
  selectScenarioReceiptQueryFirstRow, bindScenarioReceiptQueryCount,
  bindScenarioReceiptReferenceProducer, bindScenarioReceiptModelResult, selectScenarioReceiptReturn, observeScenarioReceiptDependency,
  readScenarioReceiptAssociation, projectScenarioReceipt } from '../../src/invocation/scenario-receipt.js';
import { asId, asModel, asVersion, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, makeRow, uuidv7 } from './fixtures.js';

const PARENT = asModel('QuerySourcePolicy.Workspace');
const TURN = asModel('QuerySourcePolicy.Budget'), RUN = asModel('QuerySourcePolicy.Reservation');
const ROOT = 'QuerySourcePolicy.start', CHILD = 'QuerySourcePolicy.reserve', APP = 'query-source-policy-components', TEAM = 'query-source-policy-team';
const CREATED = asId('created-run'), cause = { cause: 'scenario' } as const, bounds = { maxRows: 10, maxWork: 1000 };
const source = { path: 'query-source-policy.can', sha256: 'd'.repeat(64), module: 'query-source-policy.mjs' };
let sequence = 99_000;
function artifact(first = false): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="QuerySourcePolicy.start";', map: {
      version: 3, file: source.module, sources: [source.path], sourcesContent: [null], names: [], mappings: '',
    } }], callables: [ROOT, CHILD].map(id => ({ id, kind: 'operation' as const, module: source.module,
      export: 'identity', member: [id.split('.').at(-1)!] })),
    models: [{ name: PARENT, deleteMode: 'remove', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] }, { name: TURN, parent: PARENT, deleteMode: 'remove', fields: [
      ...['account', 'held'].map(name => ({
        name, field: { kind: 'string' as const }, required: true, serverOnly: false,
      })), { name: 'position', field: { kind: 'integer' as const }, required: false, serverOnly: false },
    ] }, { name: RUN, deleteMode: 'remove', fields: [
      ...['account', 'title'].map(name => ({ name, field: { kind: 'string' as const }, required: true, serverOnly: false })),
    ] }],
    operations: [ROOT, CHILD].map(name => ({ name, kind: 'scenario' as const, description: '', inputs: { fields: [] },
      result: { type: RUN as CanTypeId, disclosure: { version: 1 as const, source,
        ...(name === CHILD ? { queries: [{ id: 'turns', source, model: TURN,
          order: [{ field: 'id', direction: 'asc' as const }], limit: null, archived: 'exclude' as const,
          dependencies: [{ id: 'account-control', source, role: 'control' as const, field: 'account', type: 'text' as CanTypeId },
],
        }] } : {}),
        returns: [{ id: name === ROOT ? 'root-return' : 'child-return', source,
          dependencies: name === CHILD && first ? [{ id: 'held-data', source, role: 'data' as const, model: TURN, field: 'held', type: 'text' as CanTypeId }] : [],
          influences: name === CHILD ? (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
            .map(kind => ({ id: kind, kind, queryId: 'turns' })) : [],
        }],
      } } })),
  };
}
async function world(options: { first?: boolean; noVisible?: boolean; bind?: boolean; decoyRoot?: boolean; nestedParent?: boolean } = {}) {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const caller = await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false, roles: [] });
  const reader = await memberships.createMembership({ team_id: TEAM, user_id: 'turn-reader', is_owner: false, roles: [] });
  const store = createMemoryStorage(), loaded = loadArtifactDescriptors(
    artifact(options.first), { by: 'members' });
  const root = loaded.registry.get(ROOT), child = loaded.registry.get(CHILD);
  assert.ok(root && isGeneratedOperationDef(root)); assert.ok(child && isGeneratedOperationDef(child));
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment });
  const rows: StoredRow[] = [];
  await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: PARENT, row: makeRow({ id: 'workspace', data: { title: 'Workspace' } }) }] }));
  for (const [id, account, held] of [
    ['turn-c', 'caller', '20'], ['turn-a', 'caller', '7'], ['turn-b', 'other', '100'],
  ] as const) {
    const row: StoredRow = { ...makeRow({ id, data: { account, held } }), parent: { model: PARENT, id: asId('workspace') } };
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: TURN, row }] }));
    const stored = await store.load(TURN, row.id); assert.ok(stored); rows.push(stored);
  }
  const access = { budget: !options.noVisible, parent: true, run: true };
  let grants = 0, decoyGrants = 0; const nestedTitles: string[] = [];
  const policy = buildPolicyTable([
    { model: PARENT, secretFields: [], grants: [{ by: 'members', fields: ['title'] }] },
    { model: RUN, secretFields: [], grants: [{ by: 'members', fields: ['account', 'title'] }] },
  ], loaded.models);
  const readPolicies: Map<ModelName, ViewerSourceReadPolicy> = new Map<ModelName, ViewerSourceReadPolicy>([
    [TURN, { parent: PARENT, fields: ['account', 'held', 'position'], secretFields: [], grants: [{
      fields: ['id', 'account', 'held', 'position'], read: async (observation: Readonly<ViewerGenerationCallbackReadObservation>): Promise<boolean> => {
        const { context, row } = observation; grants++;
        if (!(access.budget && row.data.account === context.actorUserId &&
          (await context.memberships.findMembership(TEAM, 'turn-reader'))?.status === 'active' && context.membership?.status === 'active')) return false;
        if (!options.nestedParent) return true;
        assert.ok(row.parent);
        const parent = await projectCurrentRecordForViewerSourcePolicies({ model: PARENT, id: row.parent.id,
          context: { actorUserId: context.actorUserId, teamId: context.teamId }, memberships: context.memberships,
          policy, readPolicies, store, observation });
        if (parent.record === null) return false;
        const title = parent.record.data.title; assert.equal(typeof title, 'string'); nestedTitles.push(title as string);
        return title === 'Enabled';
      },
    }] }],
    [PARENT, { fields: ['title'], secretFields: [], grants: [{ fields: ['id', 'title'], read: async ({ context }) =>
      access.parent && context.membership?.status === 'active' }] }],
    [RUN, { fields: ['account', 'title'], secretFields: [], grants: [{ fields: ['id', 'account', 'title'], read: async ({ context }) =>
      access.run && context.membership?.status === 'active' }] }],
  ]);
  const rootReads: Map<ModelName, ViewerSourceReadPolicy> = new Map(readPolicies);
  if (options.decoyRoot) rootReads.set(TURN, { parent: PARENT, fields: ['account', 'held', 'position'], secretFields: [],
    grants: [{ fields: ['id', 'account', 'held', 'position'], read: async () => { decoyGrants++; return false; } }] });
  bindScenarioReceiptReferenceProducer(root, { source, app: APP, policy, readPolicies: rootReads });
  bindScenarioReceiptReferenceProducer(child, { source, app: APP, policy, readPolicies });
  if (options.bind !== false) bindScenarioReceiptQueryProducer(child, { source, app: APP, policy, readPolicies });
  return { store, memberships, caller, reader, root, child, table, policy, access, readPolicies, rows,
    first: options.first === true, grants: () => grants, decoyGrants: () => decoyGrants, nestedTitles, registry: loaded.registry, app: APP, source: 'component', clock: { nowMs: () => FIXED_NOW },
    identity: makeIdentity({ membership: caller }), envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {}) };
}
type World = Awaited<ReturnType<typeof world>>;
type Session = Awaited<ReturnType<typeof beginScenarioReceiptMutation>>;
type Query = Awaited<ReturnType<typeof executeScenarioReceiptQuery>>;
type QueryHook = (call: AdmittedCall, session: Pick<Session, 'stage' | 'read' | 'views'>, query: Query) => Promise<void>;
const refuses = (error: unknown) => error instanceof StateError;
function bindChild(w: World, hook?: QueryHook, requireVisible = false, before?: (session: Pick<Session, 'stage' | 'read' | 'views'>) => Promise<void>) {
  let executions = 0, predicates = 0, captured: Query | undefined;
  bindScenarioReceiptCallProducer(w.root, { source, app: APP, registry: w.registry,
    sites: [{ id: 'reserve-site', source, kind: 'operation', targets: [{ operation: CHILD, interface: w.child.descriptor }],
      resultType: RUN as CanTypeId }], prepare: (_def, inputs) => inputs as ClosedInputs,
    execute: async frame => {
      executions++;
      if (requireVisible) await frame.session.stage({ op: 'create', model: RUN, id: CREATED,
        data: { account: 'caller', title: 'Provisional' } }, cause);
      await before?.(frame.session);
      const result = await executeScenarioReceiptQuery(frame.call, w.store, { queryId: 'turns', predicate: ({ slot, record }) => {
        predicates++; assert.notEqual(record.id, 'turn-b', 'foreign source row must be filtered before predicate');
        const account = record.data.account;
        observeScenarioReceiptQueryDependency(frame.call, w.store, { slot, dependencyId: 'account-control' });
        return account === 'caller';
      } });
      captured = result;
      let title: string;
      if (w.first) {
        const budget = await selectScenarioReceiptQueryFirstRow(frame.call, w.store, { query: result.query });
        if (budget === null) throw new StateError('rule_failed', 'An owning budget is required');
        assert.equal(budget.id, 'turn-a');
        await observeScenarioReceiptDependency(frame.call, w.store, { dependencyId: 'held-data', model: TURN, row: budget, field: 'held' });
        title = budget.data.held as string;
      } else {
        const count = await bindScenarioReceiptQueryCount(frame.call, w.store, { query: result.query });
        if (requireVisible && count === 0n) throw new StateError('rule_failed', 'An owning budget is required');
        title = count.toString();
      }
      await hook?.(frame.call, frame.session, result);
      await frame.session.stage(requireVisible ? { op: 'update', model: RUN, id: CREATED, data: { title } }
        : { op: 'create', model: RUN, id: CREATED, data: { account: 'caller', title } }, cause);
      const row = await frame.session.read(RUN, CREATED); assert.ok(row);
      const wire = await bindScenarioReceiptModelResult(frame.call, w.store, { returnId: 'child-return', row });
      selectScenarioReceiptReturn(frame.call, w.store, 'child-return'); return wire;
    } });
  return { get executions() { return executions; }, get predicates() { return predicates; }, get captured() { return captured; } };
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
    await after?.(call, session); return finish(call, w, session, wire);
  } };
}
async function unchanged(w: World) {
  assert.equal(await w.store.load(RUN, CREATED), null);
  for (const row of w.rows) assert.deepEqual(await w.store.load(TURN, row.id), row);
  assert.deepEqual(await w.store.historyFor(RUN, CREATED), []); assert.deepEqual(await w.store.outboxPending(), []);
}


test('genuine installed Budget source grant filters foreign rows before first/count and preserves original model result with no predicate replay', async () => {
  for (const first of [false, true]) {
    const w = await world({ first }), producer = bindChild(w); let receipt: Receipt | undefined;
    assert.equal(w.policy.has(TURN), false, 'ruled Budget has no fabricated static policy');
    const request = input(w, value => { receipt = value; });
    assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
    const saved = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!, query = saved.queries![0]!;
    assert.deepEqual(query.candidates.map(candidate => candidate.row.id), ['turn-a', 'turn-c']);
    assert.deepEqual(query.selectedIndices, [0, 1]);
    assert.ok(query.candidates.every(candidate => candidate.dependencies.includes('account-control')));
    assert.equal((await w.store.load(RUN, CREATED))!.data.title, first ? '7' : '2');
    if (first) assert.equal(saved.observations.find(observation => observation.dependencyId === 'held-data')!.row.id, 'turn-a');
    else assert.deepEqual(saved.observations, []);
    assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
    const retained = structuredClone(receipt);
    assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.executions, 1); assert.equal(producer.predicates, 2);
    assert.deepEqual(receipt, retained);
  }
});

test('no source-visible Budget plus actual require rolls back the provisional result without evaluating foreign predicates', async () => {
  const w = await world({ noVisible: true }), producer = bindChild(w, undefined, true);
  await assert.rejects(invoke(input(w)), error => error instanceof StateError && error.code === 'rule_failed');
  assert.equal(producer.predicates, 0); await unchanged(w);
});

test('current source grant, ancestor, tracked Identity and parent lifetime drift refuse commit and mask retained first/count', async () => {
  for (const first of [false, true]) for (const loss of ['source', 'ancestor', 'membership', 'lifetime', 'account'] as const) {
    const revoke = async (w: World) => {
      if (loss === 'source') w.access.budget = false;
      else if (loss === 'ancestor') w.access.parent = false;
      else if (loss === 'membership') await w.memberships.removeMembership(w.reader.membership_id);
      else {
        const model = loss === 'account' ? TURN : PARENT, id = asId(loss === 'account' ? 'turn-a' : 'workspace');
        const row = await w.store.load(model, id); assert.ok(row);
        await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'update', model, id,
          expectedVersion: row.version, row: { ...row, version: asVersion(row.version + 1),
            ...(loss === 'account' ? { data: { ...row.data, account: 'other' } } : { archivedAt: FIXED_NOW }) } }] }));
      }
    };
    if (loss !== 'account') {
      const failed = await world({ first }); bindChild(failed);
      await assert.rejects(invoke(input(failed, undefined, async () => revoke(failed))), refuses); await unchanged(failed);
    }
    const w = await world({ first }), producer = bindChild(w); let receipt: Receipt | undefined;
    const request = input(w, value => { receipt = value; }); await invoke(request); assert.ok(receipt);
    await revoke(w);
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
    assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.executions, 1); assert.equal(producer.predicates, 2);
  }
});

test('late own account change cannot retain an old source admission through shared commit', async () => {
  for (const first of [false, true]) {
    const w = await world({ first }); bindChild(w, async (_call, session) => {
      await session.stage({ op: 'update', model: TURN, id: asId('turn-a'), data: { account: 'other' } }, cause);
    });
    await assert.rejects(invoke(input(w)), refuses); await unchanged(w);
  }
});

test('source-policy binding captures map and selector data while current callbacks remain live', async () => {
  const w = await world(), producer = bindChild(w); let receipt: Receipt | undefined;
  w.readPolicies.clear();
  w.readPolicies.set(TURN, { fields: [], secretFields: [], grants: [] });
  const request = input(w, value => { receipt = value; });
  assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
  w.access.budget = false;
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
  assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.predicates, 2);
});

test('query source binding refuses wrong source, missing owning model/ancestor and getter/exotic map without running grant callbacks', async () => {
  for (const mode of ['source', 'model', 'ancestor', 'getter', 'exotic-map'] as const) {
    const w = await world({ bind: false }), reads: Map<ModelName, ViewerSourceReadPolicy> = new Map(w.readPolicies); let getters = 0;
    if (mode === 'model') reads.delete(TURN);
    if (mode === 'ancestor') reads.delete(PARENT);
    if (mode === 'getter') {
      const original = reads.get(TURN)!;
      const invalid = { ...original };
      Object.defineProperty(invalid, 'fields', { enumerable: true, get: () => { getters++; throw new Error('Getter evaluated'); } });
      reads.set(TURN, invalid);
    }
    const exotic = new (class extends Map<ModelName, ViewerSourceReadPolicy> {})(reads);
    assert.throws(() => bindScenarioReceiptQueryProducer(w.child, { source: mode === 'source' ? { ...source, sha256: 'e'.repeat(64) } : source,
      app: APP, policy: w.policy, readPolicies: mode === 'exotic-map' ? exotic : reads }), refuses);
    assert.equal(getters, 0); assert.equal(w.grants(), 0); await unchanged(w);
  }
  const w = await world({ bind: false });
  bindScenarioReceiptQueryProducer(w.child, { source, app: 'wrong-app', policy: w.policy, readPolicies: w.readPolicies });
  bindChild(w);
  await assert.rejects(invoke(input(w)), refuses); assert.equal(w.grants(), 0); await unchanged(w);
});


test('exact child query and selected scalar policies win over a denying root Budget decoy', async () => {
  const w = await world({ first: true, decoyRoot: true }), producer = bindChild(w); let receipt: Receipt | undefined;
  const request = input(w, value => { receipt = value; });
  assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
  assert.equal((await w.store.load(RUN, CREATED))!.data.title, '7');
  const saved = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!;
  assert.equal(saved.observations.find(entry => entry.dependencyId === 'held-data')!.row.data.held, '7');
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
  assert.equal(w.decoyGrants(), 0, 'root Budget callback is unrelated to child query/scalar authority');
  w.access.budget = false;
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
  assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.executions, 1); assert.equal(producer.predicates, 2);
});

test('installed Budget callback borrows its genuine observation and physical store to read the Workspace staged before the scan', async () => {
  const w = await world({ first: true, nestedParent: true });
  const committed = await projectCurrentRecordForViewerSourcePolicies({ model: TURN, id: asId('turn-a'),
    context: { actorUserId: 'caller', teamId: TEAM }, memberships: w.memberships, policy: w.policy, readPolicies: w.readPolicies, store: w.store });
  assert.equal(committed.record, null, 'committed Workspace business value denies Budget');
  assert.ok(w.nestedTitles.includes('Workspace')); w.nestedTitles.length = 0;
  const producer = bindChild(w, undefined, false, async session => {
    await session.stage({ op: 'update', model: PARENT, id: asId('workspace'), data: { title: 'Enabled' } }, cause);
    assert.equal((await w.store.load(PARENT, asId('workspace')))!.data.title, 'Workspace', 'physical row stays pre-stage');
  });
  let receipt: Receipt | undefined;
  const request = input(w, value => { receipt = value; });
  assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
  assert.equal((await w.store.load(RUN, CREATED))!.data.title, '7');
  assert.equal((await w.store.load(PARENT, asId('workspace')))!.data.title, 'Enabled');
  assert.ok(w.nestedTitles.length > 0); assert.ok(w.nestedTitles.every(title => title === 'Enabled'), 'scan and nested leases consume genuine stage rows');
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
  const row = await w.store.load(PARENT, asId('workspace')); assert.ok(row);
  await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'update', model: PARENT, id: row.id,
    expectedVersion: row.version, row: { ...row, version: asVersion(row.version + 1), data: { title: 'Disabled' } } }] }));
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
  assert.ok((w.nestedTitles as readonly string[]).includes('Disabled'), 'saved recovery consults current genuine ancestor');
  assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.executions, 1); assert.equal(producer.predicates, 2);
});
