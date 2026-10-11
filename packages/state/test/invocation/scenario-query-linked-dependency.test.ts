/** Finite query-linked actual candidate/admitted parent occurrence controls.
 * Native original ask75/application qualification remains separately owned. */
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
import { asId, asModel, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, makeRow, uuidv7 } from './fixtures.js';

const CONVERSATION = asModel('QueryLinkedDependency.Conversation');
const PARENT = asModel('QueryLinkedDependency.Branch');
const TURN = asModel('QueryLinkedDependency.Run'), RUN = asModel('QueryLinkedDependency.Reservation');
const ROOT = 'QueryLinkedDependency.start', CHILD = 'QueryLinkedDependency.reserve', APP = 'query-linked-dependency-components', TEAM = 'query-linked-dependency-team';
const CREATED = asId('created-run'), cause = { cause: 'scenario' } as const, bounds = { maxRows: 10, maxWork: 1000 };
const source = { path: 'query-linked-dependency.can', sha256: 'd'.repeat(64), module: 'query-linked-dependency.mjs' };
let sequence = 100_000;
function artifact(mandatory: 'field' | 'intrinsic' | undefined = undefined): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="QueryLinkedDependency.start";', map: {
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
    operations: [ROOT, CHILD].map(name => ({ name, kind: 'scenario' as const, description: '', inputs: { fields: [{ name: 'branch', field: { kind: 'ref' as const, model: PARENT, requireVersion: true }, required: true }] },
      result: { type: RUN as CanTypeId, disclosure: { version: 1 as const, source,
        ...(name === CHILD ? { queries: [{ id: 'turns', source, model: TURN,
          order: [{ field: 'id', direction: 'asc' as const }], limit: null, archived: 'exclude' as const,
          dependencies: [{ id: 'parent-control', source, role: 'control' as const, field: 'parent', type: PARENT as CanTypeId }, { id: 'account-control', source, role: 'control' as const, field: 'account', type: 'text' as CanTypeId },
          ],
        }] } : {}),
        returns: [{ id: name === ROOT ? 'root-return' : 'child-return', source,
          dependencies: name === CHILD ? [
            { id: 'branch-parent', queryId: 'turns', source, role: 'control' as const, model: PARENT, field: 'parent', type: CONVERSATION as CanTypeId },
            { id: 'supplied-branch-parent', queryId: 'turns', source, role: 'control' as const, model: PARENT, field: 'parent', type: CONVERSATION as CanTypeId },
            ...(mandatory === 'field' ? [{ id: 'mandatory-title', source, role: 'control' as const, model: PARENT, field: 'title', type: 'text' as CanTypeId }] : []),
          ] : [],
          ...(name === CHILD && mandatory === 'intrinsic' ? { intrinsics: [{ id: 'mandatory-operation', source, role: 'control' as const, kind: 'operation-id' as const, type: 'text' as CanTypeId }] } : {}),
          influences: name === CHILD ? (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
            .map(kind => ({ id: kind, kind, queryId: 'turns' })) : [],
        }],
      } } })),
  };
}
async function world(options: { domain?: 'empty' | 'false'; mandatory?: 'field' | 'intrinsic'; queryOwnedParents?: boolean } = {}) {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const caller = await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false, roles: [] });
  const reader = await memberships.createMembership({ team_id: TEAM, user_id: 'turn-reader', is_owner: false, roles: [] });
  const parentReader = await memberships.createMembership({ team_id: TEAM, user_id: 'parent-reader', is_owner: false, roles: [] });
  const store = createMemoryStorage(), loaded = loadArtifactDescriptors(
    artifact(options.mandatory), { by: 'members' });
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
  if (options.domain !== 'empty') for (const [id, account, branch] of [
    ['turn-a', 'caller', 'branch-a'], ['turn-b', 'caller', 'branch-b'],
    ['turn-c', 'caller', 'branch-c'], ['turn-d', 'other', 'branch-a'],
  ] as const) {
    const row: StoredRow = { ...makeRow({ id, data: { account: options.domain === 'false' ? 'other' : account, held: '7' } }), parent: { model: PARENT, id: asId(branch) } };
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: TURN, row }] }));
    const stored = await store.load(TURN, row.id); assert.ok(stored); rows.push(stored);
  }
  const access = { turn: true, run: true, parent: true, conversation: true, queryParent: true };
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
  const queryPolicy = new Map(policy), queryReads = new Map(readPolicies);
  if (options.queryOwnedParents) {
    queryPolicy.delete(PARENT);
    queryReads.set(PARENT, { parent: CONVERSATION, fields: ['title'], secretFields: [], grants: [{ fields: ['id', 'title'],
      read: async ({ context }) => access.queryParent && context.membership?.status === 'active' &&
        (await context.memberships.findMembership(TEAM, 'parent-reader'))?.status === 'active' }] });
  }
  bindScenarioReceiptQueryProducer(child, { source, app: APP, policy: queryPolicy,
    ...(options.queryOwnedParents ? { readPolicies: queryReads } : {}) });
  return { store, memberships, caller, reader, parentReader, root, child, table, policy, queryPolicy, queryReads, access, readPolicies, rows,
 registry: loaded.registry, app: APP, source: 'component', clock: { nowMs: () => FIXED_NOW },
    identity: makeIdentity({ membership: caller }), envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), { branch: { id: 'branch-a', version: '1' } }) };
}
type World = Awaited<ReturnType<typeof world>>;
type Session = Awaited<ReturnType<typeof beginScenarioReceiptMutation>>;
type Query = Awaited<ReturnType<typeof executeScenarioReceiptQuery>>;
type QueryHook = (call: AdmittedCall, session: Pick<Session, 'stage' | 'read' | 'views'>, query: Query) => Promise<void>;
const refuses = (error: unknown) => error instanceof StateError;
type LinkedMode = 'normal' | 'missing-next-observer' | 'duplicate-supplied' | 'copy-ref' | 'foreign-ref' | 'copy-call' | 'foreign-store' | 'unconsumed' | 'copy-query' | 'foreign-query' | 'caught-unfinished';
function bindChild(w: World, mode: LinkedMode = 'normal', hook?: QueryHook, foreign?: Query) {
  let executions = 0, predicates = 0, captured: Query | undefined;
  bindScenarioReceiptCallProducer(w.root, { source, app: APP, registry: w.registry,
    sites: [{ id: 'reserve-site', source, kind: 'operation', targets: [{ operation: CHILD, interface: w.child.descriptor }],
      resultType: RUN as CanTypeId }], prepare: (_def, inputs) => inputs as ClosedInputs,
    execute: async frame => {
      executions++;
      const supplied = frame.call.recordRefs.find(reference => reference.param === 'branch'); assert.ok(supplied);
      const execution = executeScenarioReceiptQuery(frame.call, w.store, { queryId: 'turns', predicate: async ({ slot, record }) => {
        predicates++; const account = record.data.account;
        observeScenarioReceiptQueryDependency(frame.call, w.store, { slot, dependencyId: 'account-control' });
        if (account !== 'caller') return false;
        if (mode === 'caught-unfinished') throw new StateError('rule_failed', 'Predicate failed before completion');
        const parent = record.parent;
        observeScenarioReceiptQueryDependency(frame.call, w.store, { slot, dependencyId: 'parent-control' });
        const branch = await readScenarioReceiptQueryParentRow(frame.call, w.store, { slot, dependencyId: 'branch-parent' });
        assert.equal(branch.id, parent!.id); assert.equal(Object.hasOwn(branch.data, 'parent'), false);
        if (mode !== 'missing-next-observer' || predicates === 1) await observeScenarioReceiptDependency(frame.call, w.store,
          { dependencyId: 'branch-parent', model: PARENT, row: branch, field: 'parent' });
        await observeScenarioReceiptDependency(mode === 'copy-call' ? { ...frame.call } : frame.call,
          mode === 'foreign-store' ? { ...w.store } : w.store, { dependencyId: 'supplied-branch-parent', model: PARENT,
            row: mode === 'copy-ref' ? { ...supplied.row } : mode === 'foreign-ref' ? frame.parent.recordRefs.find(reference => reference.param === 'branch')!.row : supplied.row, field: 'parent' });
        if (mode === 'duplicate-supplied') await observeScenarioReceiptDependency(frame.call, w.store,
          { dependencyId: 'supplied-branch-parent', model: PARENT, row: supplied.row, field: 'parent' });
        return branch.parent!.model === CONVERSATION && branch.parent!.id === supplied.row.parent!.id;
      } });
      if (mode === 'caught-unfinished') {
        await assert.rejects(execution, refuses);
        await frame.session.stage({ op: 'create', model: RUN, id: CREATED, data: { account: 'caller', title: 'Forged completion' } }, cause);
        throw new Error('Poisoned unfinished source unexpectedly staged a result');
      }
      const result = await execution; captured = result;
      const count = mode === 'unconsumed' ? BigInt(result.count) : await bindScenarioReceiptQueryCount(frame.call, w.store,
        { query: mode === 'copy-query' ? { ...result.query } : mode === 'foreign-query' ? foreign!.query : result.query });
      await hook?.(frame.call, frame.session, result);
      await frame.session.stage({ op: 'create', model: RUN, id: CREATED, data: { account: 'caller', title: count.toString() } }, cause);
      const row = await frame.session.read(RUN, CREATED); assert.ok(row);
      const wire = await bindScenarioReceiptModelResult(frame.call, w.store, { returnId: 'child-return', row });
      selectScenarioReceiptReturn(frame.call, w.store, 'child-return'); return wire;
    } });
  return { get executions() { return executions; }, get predicates() { return predicates; }, get captured() { return captured; } };
}
async function child(call: AdmittedCall, w: World) {
  return invokeScenarioReceiptCall(call, w.store, { site: 'reserve-site', target: CHILD, inputs: { branch: { id: 'branch-a', version: '1' } } });
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

test('query-linked candidate and supplied parents preserve complete populated, empty and short-circuited domains with once replay', async () => {
  for (const domain of [undefined, 'empty', 'false'] as const) {
    const w = await world(domain === undefined ? {} : { domain }), producer = bindChild(w); let receipt: Receipt | undefined;
    const request = input(w, value => { receipt = value; });
    assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
    const saved = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!, query = saved.queries![0]!;
    assert.equal(query.candidates.length, domain === 'empty' ? 0 : 4);
    assert.deepEqual(query.selectedIndices.map(index => query.candidates[index]!.row.id), domain === undefined ? ['turn-a', 'turn-b'] : []);
    for (const candidate of query.candidates) {
      assert.equal(candidate.dependencies.includes('account-control'), true);
      const parentsExecuted = domain === undefined && candidate.row.id !== 'turn-d';
      for (const id of ['parent-control', 'branch-parent', 'supplied-branch-parent']) assert.equal(candidate.dependencies.includes(id), parentsExecuted);
      assert.equal(Object.hasOwn(candidate.record.data, 'parent'), false);
    }
    const actualOrdinary = saved.observations.filter(observation => ['branch-parent', 'supplied-branch-parent'].includes(observation.dependencyId));
    if (domain !== undefined) assert.deepEqual(actualOrdinary, []);
    else {
      assert.ok(actualOrdinary.some(observation => observation.dependencyId === 'branch-parent' && observation.row.id === 'branch-b'));
      assert.ok(actualOrdinary.filter(observation => observation.dependencyId === 'supplied-branch-parent').every(observation => observation.row.id === 'branch-a'));
    }
    assert.equal((await w.store.load(RUN, CREATED))!.data.title, domain === undefined ? '2' : '0');
    assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
    const retained = structuredClone(receipt);
    assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.executions, 1); assert.equal(producer.predicates, domain === 'empty' ? 0 : 4);
    assert.deepEqual(receipt, retained);
  }
});

test('ordinary fields and intrinsics without a query link remain mandatory in empty and skipped-parent queries', async () => {
  for (const mandatory of ['field', 'intrinsic'] as const) for (const domain of ['empty', 'false'] as const) {
    const w = await world({ mandatory, domain }); bindChild(w);
    await assert.rejects(invoke(input(w)), refuses); await unchanged(w);
  }
});

test('query-linked ordinary observation still requires every issued row and the exact admitted supplied row/call/store', async () => {
  for (const mode of ['missing-next-observer', 'duplicate-supplied', 'copy-ref', 'foreign-ref', 'copy-call', 'foreign-store',
    'unconsumed', 'copy-query', 'caught-unfinished'] as const) {
    const w = await world(); bindChild(w, mode);
    await assert.rejects(invoke(input(w)), refuses); await unchanged(w);
  }
  const first = await world(), completed = bindChild(first); await invoke(input(first)); assert.ok(completed.captured);
  const foreign = await world(); bindChild(foreign, 'foreign-query', undefined, completed.captured);
  await assert.rejects(invoke(input(foreign)), refuses); await unchanged(foreign);
});

test('query-linked saved occurrence evidence rejects missing and foreign ordinary candidate IDs', async () => {
  const w = await world(); bindChild(w); let receipt: Receipt | undefined;
  await invoke(input(w, value => { receipt = value; })); assert.ok(receipt);
  for (const mode of ['missing', 'foreign', 'skipped-forged']) {
    const altered: Receipt = structuredClone(receipt); assert.equal(altered.outcome.status, 'committed');
    if (altered.outcome.status !== 'committed') throw new Error('Expected committed receipt');
    const query = altered.outcome.scenario!.calls![0]!.scenario!.queries![0]!;
    if (mode === 'missing') Reflect.set(query.candidates[1]!, 'dependencies', query.candidates[1]!.dependencies.filter(id => id !== 'supplied-branch-parent'));
    if (mode === 'foreign') Reflect.set(query.candidates[1]!, 'dependencies', [...query.candidates[1]!.dependencies, 'another-query-parent']);
    if (mode === 'skipped-forged') Reflect.set(query.candidates[3]!, 'dependencies', [...query.candidates[3]!.dependencies, 'supplied-branch-parent']);
    assert.throws(() => readScenarioReceiptAssociation(altered), refuses);
    await assert.rejects(projectScenarioReceipt({ ...w, receipt: altered }), refuses);
  }
});

test('current source/ancestor/Identity loss closes linked occurrence commit and saved recovery without resampling predicates', async () => {
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

test('late owner rejection rolls back count-dependent child and outer writes', async () => {
  const w = await world(), producer = bindChild(w, 'normal', async (_call, session) => {
    await session.stage({ op: 'update', model: TURN, id: asId('turn-a'), data: { held: '8' } }, cause);
  });
  await assert.rejects(invoke(input(w, undefined, async (_call, session) => {
    await session.stage({ op: 'update', model: RUN, id: CREATED, data: { title: 'Outer update' } }, cause);
    throw new StateError('rule_failed', 'Late outer refusal');
  })), error => error instanceof StateError && error.code === 'rule_failed');
  assert.equal(producer.predicates, 4); await unchanged(w); assert.deepEqual(await w.store.historyFor(TURN, asId('turn-a')), []);
});


test('linked Branch occurrences use the query-owned source map even when Branch is absent from its static policy', async () => {
  const w = await world({ queryOwnedParents: true }), producer = bindChild(w); let receipt: Receipt | undefined;
  assert.equal(w.queryPolicy.has(PARENT), false); assert.equal(w.policy.has(PARENT), true, 'reference/result producer remains separately bound');
  const request = input(w, value => { receipt = value; });
  assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
  assert.equal((await w.store.load(RUN, CREATED))!.data.title, '2');
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
  w.access.queryParent = false;
  assert.equal(w.access.parent, true, 'unrelated reference source remains allowed');
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
  assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.executions, 1); assert.equal(producer.predicates, 4);
  const failed = await world({ queryOwnedParents: true }); bindChild(failed);
  await assert.rejects(invoke(input(failed, undefined, async () => { failed.access.queryParent = false; })), refuses); await unchanged(failed);
});

test('direct external CHILD empty query keeps its finalized root lifetime for retained projection and once replay', async () => {
  const w = await world({ domain: 'empty' }); let receipt: Receipt | undefined, executions = 0, predicates = 0;
  const request = { ...w, envelope: makeEnvelope(CHILD, uuidv7(FIXED_NOW, ++sequence), { branch: { id: 'branch-a', version: '1' } }),
    observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
      executions++;
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      const query = await executeScenarioReceiptQuery(call, w.store, { queryId: 'turns', predicate: () => {
        predicates++; throw new Error('Genuine empty query must not execute source predicate');
      } });
      const count = await bindScenarioReceiptQueryCount(call, w.store, { query: query.query }); assert.equal(count, 0n);
      await session.stage({ op: 'create', model: RUN, id: CREATED, data: { account: 'caller', title: count.toString() } }, cause);
      const row = await session.read(RUN, CREATED); assert.ok(row);
      const wire = await bindScenarioReceiptModelResult(call, w.store, { returnId: 'child-return', row });
      selectScenarioReceiptReturn(call, w.store, 'child-return');
      return { ...await session.finalize(), result: wire, outbox: [] };
    } };
  assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
  const saved = readScenarioReceiptAssociation(receipt)!;
  assert.deepEqual(saved.queries![0]!.candidates, []); assert.deepEqual(saved.observations, []);
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
  assert.equal((await invoke(request)).status, 'replayed'); assert.equal(executions, 1); assert.equal(predicates, 0);
  assert.equal((await w.store.load(RUN, CREATED))!.data.title, '0');
});
