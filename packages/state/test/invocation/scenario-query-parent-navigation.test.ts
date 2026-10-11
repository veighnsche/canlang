/** Finite actual query-candidate parent navigation controls using a genuine owner
 * session. Native ask75/source correspondence remains separately owned. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ClosedInputs, ModelName, Receipt, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import type { ViewerSourceReadPolicy } from '../../src/query/source-policy.js';
import { invoke, type ExecutionEffects } from '../../src/invocation/invoke.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptCallProducer, invokeScenarioReceiptCall,
  bindScenarioReceiptQueryProducer, executeScenarioReceiptQuery, observeScenarioReceiptQueryDependency,
  bindScenarioReceiptQueryCount,
  bindScenarioReceiptReferenceProducer, bindScenarioReceiptModelResult, selectScenarioReceiptReturn, observeScenarioReceiptDependency, readScenarioReceiptQueryParentRow,
  readScenarioReceiptAssociation, projectScenarioReceipt } from '../../src/invocation/scenario-receipt.js';
import { asId, asModel, asVersion, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, makeRow, uuidv7 } from './fixtures.js';

const CONVERSATION = asModel('QueryParentNavigation.Conversation');
const PARENT = asModel('QueryParentNavigation.Branch');
const TURN = asModel('QueryParentNavigation.Run'), RUN = asModel('QueryParentNavigation.Reservation');
const ROOT = 'QueryParentNavigation.start', CHILD = 'QueryParentNavigation.reserve', APP = 'query-parent-navigation-components', TEAM = 'query-parent-navigation-team';
const CREATED = asId('created-run'), cause = { cause: 'scenario' } as const, bounds = { maxRows: 10, maxWork: 1000 };
const source = { path: 'query-parent-navigation.can', sha256: 'd'.repeat(64), module: 'query-parent-navigation.mjs' };
let sequence = 98_000;
function artifact(): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="QueryParentNavigation.start";', map: {
      version: 3, file: source.module, sources: [source.path], sourcesContent: [null], names: [], mappings: '',
    } }], callables: [ROOT, CHILD].map(id => ({ id, kind: 'operation' as const, module: source.module,
      export: 'identity', member: [id.split('.').at(-1)!] })),
    models: [{ name: CONVERSATION, deleteMode: 'remove', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] }, { name: PARENT, parent: CONVERSATION, deleteMode: 'remove', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] }, { name: TURN, parent: PARENT, deleteMode: 'remove', fields: [
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
          dependencies: [{ id: 'parent-control', source, role: 'control' as const, field: 'parent', type: PARENT as CanTypeId }, { id: 'account-control', source, role: 'control' as const, field: 'account', type: 'text' as CanTypeId },
          ],
        }] } : {}),
        returns: [{ id: name === ROOT ? 'root-return' : 'child-return', source,
          dependencies: name === CHILD ? [{ id: 'branch-parent', source, role: 'control' as const, model: PARENT, field: 'parent', type: CONVERSATION as CanTypeId }] : [],
          influences: name === CHILD ? (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
            .map(kind => ({ id: kind, kind, queryId: 'turns' })) : [],
        }],
      } } })),
  };
}
async function world() {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const caller = await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false, roles: [] });
  const reader = await memberships.createMembership({ team_id: TEAM, user_id: 'turn-reader', is_owner: false, roles: [] });
  const parentReader = await memberships.createMembership({ team_id: TEAM, user_id: 'parent-reader', is_owner: false, roles: [] });
  const store = createMemoryStorage(), loaded = loadArtifactDescriptors(
    artifact(), { by: 'members' });
  const root = loaded.registry.get(ROOT), child = loaded.registry.get(CHILD);
  assert.ok(root && isGeneratedOperationDef(root)); assert.ok(child && isGeneratedOperationDef(child));
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment });
  const rows: StoredRow[] = [];
  for (const id of ['conversation-a', 'conversation-b']) {
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: CONVERSATION,
      row: makeRow({ id, data: { title: id } }) }] }));
  }
  for (const id of ['branch-a', 'branch-b', 'branch-c']) {
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: PARENT,
      row: { ...makeRow({ id, data: { title: id } }), parent: { model: CONVERSATION,
        id: asId(id === 'branch-c' ? 'conversation-b' : 'conversation-a') } } }] }));
  }
  for (const [id, account, branch] of [
    ['turn-a', 'caller', 'branch-a'], ['turn-b', 'caller', 'branch-b'],
    ['turn-c', 'caller', 'branch-c'], ['turn-d', 'other', 'branch-a'],
  ] as const) {
    const row: StoredRow = { ...makeRow({ id, data: { account, held: '7' } }), parent: { model: PARENT, id: asId(branch) } };
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: TURN, row }] }));
    const stored = await store.load(TURN, row.id); assert.ok(stored); rows.push(stored);
  }
  const access = { turn: true, run: true, parent: true, conversation: true };
  const policy = buildPolicyTable([
    { model: CONVERSATION, secretFields: [], grants: [{ by: 'members', fields: ['title'] }] },
    { model: PARENT, secretFields: [], grants: [{ by: 'members', fields: ['title'] }] },
    { model: TURN, secretFields: [], grants: [{ by: 'members', fields: ['account', 'held', 'position'] }] },
    { model: RUN, secretFields: [], grants: [{ by: 'members', fields: ['account', 'title'] }] },
  ], loaded.models);
  const readPolicies = new Map<ModelName, ViewerSourceReadPolicy>();
  for (const [model, fields] of [[TURN, ['account', 'held', 'position']], [RUN, ['account', 'title']], [PARENT, ['title']], [CONVERSATION, ['title']]] as const) {
    readPolicies.set(model, { ...(model === TURN ? { parent: PARENT } : model === PARENT ? { parent: CONVERSATION } : {}), fields: [...fields],
      secretFields: [], grants: [{ fields: ['id', ...fields], read: async ({ context }) =>
      (model === TURN ? access.turn : model === PARENT ? access.parent : model === CONVERSATION ? access.conversation : access.run) &&
      (await context.memberships.findMembership(TEAM, model === TURN ? 'turn-reader' : model === PARENT || model === CONVERSATION ? 'parent-reader' : 'caller'))?.status === 'active' &&
      context.membership?.status === 'active',
    }] });
  }
  for (const def of [root, child]) bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  bindScenarioReceiptQueryProducer(child, { source, app: APP, policy });
  return { store, memberships, caller, reader, parentReader, root, child, table, policy, access, readPolicies, rows,
 registry: loaded.registry, app: APP, source: 'component', clock: { nowMs: () => FIXED_NOW },
    activeRootCall: undefined as AdmittedCall | undefined, identity: makeIdentity({ membership: caller }), envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {}) };
}
type World = Awaited<ReturnType<typeof world>>;
type Session = Awaited<ReturnType<typeof beginScenarioReceiptMutation>>;
type Query = Awaited<ReturnType<typeof executeScenarioReceiptQuery>>;
type QueryHook = (call: AdmittedCall, session: Pick<Session, 'stage' | 'read' | 'views'>, query: Query) => Promise<void>;
const refuses = (error: unknown) => error instanceof StateError;
type NavigationMode = 'normal' | 'missing-marker' | 'missing-next-observer' | 'before-getter' | 'copied-slot' | 'wrong-dependency' | 'copied-call' | 'foreign-store' | 'next-slot' | 'copied-row' | 'post-query' | 'post-query-observe' | 'foreign-call' | 'wrong-second-hop' | 'next-slot-observe' | 'ordinary-row' | 'busy-read';
function bindChild(w: World, mode: NavigationMode = 'normal', hook?: QueryHook) {
  let executions = 0, predicates = 0, captured: Query | undefined;
  let priorSlot: Query['rows'][number]['slot'] | undefined, priorBranch: StoredRow | undefined;
  bindScenarioReceiptCallProducer(w.root, { source, app: APP, registry: w.registry,
    sites: [{ id: 'reserve-site', source, kind: 'operation', targets: [{ operation: CHILD, interface: w.child.descriptor }],
      resultType: RUN as CanTypeId }], prepare: (_def, inputs) => inputs as ClosedInputs,
    execute: async frame => {
      executions++;
      const result = await executeScenarioReceiptQuery(frame.call, w.store, { queryId: 'turns', predicate: async ({ slot, record }) => {
        predicates++;
        const account = record.data.account;
        observeScenarioReceiptQueryDependency(frame.call, w.store, { slot, dependencyId: 'account-control' });
        if (mode === 'before-getter') await assert.rejects(readScenarioReceiptQueryParentRow(frame.call, w.store, { slot, dependencyId: 'branch-parent' }), refuses);
        const parent = record.parent;
        if (mode !== 'missing-marker') observeScenarioReceiptQueryDependency(frame.call, w.store, { slot, dependencyId: 'parent-control' });
        if (mode === 'next-slot' && priorSlot !== undefined) {
          await assert.rejects(readScenarioReceiptQueryParentRow(frame.call, w.store, { slot: priorSlot, dependencyId: 'branch-parent' }), refuses);

        }
        if (mode === 'next-slot-observe' && priorBranch !== undefined) {
          await assert.rejects(observeScenarioReceiptDependency(frame.call, w.store, { dependencyId: 'branch-parent', model: PARENT, row: priorBranch, field: 'parent' }), refuses);
        }
        if (mode === 'busy-read') await assert.rejects(frame.session.read(PARENT, parent!.id), refuses);
        const branch = await readScenarioReceiptQueryParentRow(mode === 'copied-call' ? { ...frame.call } : mode === 'foreign-call' ? w.activeRootCall! : frame.call,
          mode === 'foreign-store' ? { ...w.store } : w.store,
          { slot: mode === 'copied-slot' ? { ...slot } : slot, dependencyId: mode === 'wrong-dependency' ? 'account-control' : 'branch-parent' });
        assert.equal(branch.id, parent!.id); assert.equal(Object.hasOwn(branch.data, 'parent'), false);
        if (mode !== 'missing-next-observer' || predicates === 1) await observeScenarioReceiptDependency(frame.call, w.store, { dependencyId: mode === 'wrong-second-hop' ? 'parent-control' : 'branch-parent', model: PARENT,
          row: mode === 'copied-row' ? { ...branch } : mode === 'ordinary-row' ? (await w.store.load(PARENT, branch.id))! : branch, field: 'parent' });
        priorSlot = slot; priorBranch = branch;
        return account === 'caller' && branch.parent!.model === CONVERSATION && branch.parent!.id === 'conversation-a';
      } });
      captured = result;
      if (mode === 'post-query') {
        assert.ok(priorSlot);
        await assert.rejects(readScenarioReceiptQueryParentRow(frame.call, w.store, { slot: priorSlot, dependencyId: 'branch-parent' }), refuses);
      }
      if (mode === 'post-query-observe') {
        assert.ok(priorBranch);
        await assert.rejects(observeScenarioReceiptDependency(frame.call, w.store, { dependencyId: 'branch-parent', model: PARENT, row: priorBranch, field: 'parent' }), refuses);
      }
      const count = await bindScenarioReceiptQueryCount(frame.call, w.store, { query: result.query });
      assert.equal(count, 2n); await hook?.(frame.call, frame.session, result);
      await frame.session.stage({ op: 'create', model: RUN, id: CREATED, data: { account: 'caller', title: count.toString() } }, cause);
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
    w.activeRootCall = call;
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

test('actual active Run slot issues its owning Branch for the second-hop Conversation control and counts across both branches once', async () => {
  const w = await world(), producer = bindChild(w); let receipt: Receipt | undefined;
  const request = input(w, value => { receipt = value; });
  assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
  const saved = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!, query = saved.queries![0]!;
  assert.deepEqual(query.candidates.map(candidate => candidate.row.id), ['turn-a', 'turn-b', 'turn-c', 'turn-d']);
  assert.deepEqual(query.selectedIndices.map(index => query.candidates[index]!.row.id), ['turn-a', 'turn-b']);
  assert.ok(query.candidates.every(candidate => candidate.dependencies.includes('parent-control') && candidate.dependencies.includes('account-control')));
  assert.ok(query.candidates.every(candidate => !Object.hasOwn(candidate.record.data, 'parent')));
  const secondHops = saved.observations.filter(observation => observation.dependencyId === 'branch-parent');
  assert.deepEqual([...new Set(secondHops.map(observation => observation.row.id))].sort(), ['branch-a', 'branch-b', 'branch-c']);
  assert.ok(secondHops.every(observation => observation.model === PARENT && !Object.hasOwn(observation.row.data, 'parent')));
  assert.deepEqual(secondHops.find(observation => observation.row.id === 'branch-b')!.row.parent, { model: CONVERSATION, id: 'conversation-a' });
  assert.equal((await w.store.load(RUN, CREATED))!.data.title, '2');
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
  const retained = structuredClone(receipt);
  assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.executions, 1); assert.equal(producer.predicates, 4);
  assert.deepEqual(receipt, retained);
});

test('parent navigation and ordinary second-hop observation require the original active slot/call/store/row and immediate marker', async () => {
  for (const mode of ['missing-marker', 'missing-next-observer', 'before-getter', 'copied-slot', 'wrong-dependency', 'copied-call', 'foreign-store',
    'foreign-call', 'wrong-second-hop', 'next-slot', 'next-slot-observe', 'copied-row', 'ordinary-row', 'busy-read', 'post-query', 'post-query-observe'] as const) {
    const w = await world(); bindChild(w, mode);
    await assert.rejects(invoke(input(w)), refuses); await unchanged(w);
  }
});

test('source, Branch/Conversation ancestor and tracked Identity loss refuse shared commit and saved two-hop disclosure', async () => {
  for (const loss of ['source', 'branch', 'conversation', 'source-member', 'ancestor-member'] as const) {
    const revoke = async (w: World) => {
      if (loss === 'source') w.access.turn = false;
      else if (loss === 'branch') w.access.parent = false;
      else if (loss === 'conversation') w.access.conversation = false;
      else await w.memberships.removeMembership(loss === 'source-member' ? w.reader.membership_id : w.parentReader.membership_id);
    };
    const failed = await world(); bindChild(failed);
    await assert.rejects(invoke(input(failed, undefined, async () => revoke(failed))), refuses); await unchanged(failed);
    const w = await world(), producer = bindChild(w); let receipt: Receipt | undefined;
    const request = input(w, value => { receipt = value; }); await invoke(request); assert.ok(receipt);
    await revoke(w);
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
    assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.executions, 1); assert.equal(producer.predicates, 4);
  }
});

test('legitimate current Branch/Conversation business-data changes preserve the original two-hop count', async () => {
  const w = await world(); bindChild(w); let receipt: Receipt | undefined;
  await invoke(input(w, value => { receipt = value; })); assert.ok(receipt);
  for (const [model, id] of [[PARENT, 'branch-b'], [CONVERSATION, 'conversation-a']] as const) {
    const row = await w.store.load(model, asId(id)); assert.ok(row);
    await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'update', model, id: row.id,
      expectedVersion: row.version, row: { ...row, version: asVersion(row.version + 1), data: { title: 'Current business title' } } }] }));
  }
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
  const saved = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!;
  assert.equal(saved.queries![0]!.selectedIndices.length, 2);
  assert.equal(saved.observations.find(observation => observation.row.id === 'branch-b')!.row.data.title, 'branch-b');
});

test('late outer failure rolls back the count-dependent child result and all parent writes', async () => {
  const w = await world(), producer = bindChild(w, 'normal', async (_call, session) => {
    await session.stage({ op: 'update', model: TURN, id: asId('turn-a'), data: { held: '8' } }, cause);
  });
  await assert.rejects(invoke(input(w, undefined, async (_call, session) => {
    await session.stage({ op: 'update', model: RUN, id: CREATED, data: { title: 'Parent update' } }, cause);
    throw new StateError('rule_failed', 'Rejected after child count promotion');
  })), error => error instanceof StateError && error.code === 'rule_failed');
  assert.equal(producer.predicates, 4); await unchanged(w);
  assert.deepEqual(await w.store.historyFor(TURN, asId('turn-a')), []);
});
