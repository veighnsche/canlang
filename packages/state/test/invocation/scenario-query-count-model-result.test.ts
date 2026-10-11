/** Finite State count-consumer profile using the existing account predicate.
 * Native count(branch.Turn) query generation and arithmetic remain Compiler/Dev-owned. */
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
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptCallProducer, invokeScenarioReceiptCall,
  bindScenarioReceiptQueryProducer, executeScenarioReceiptQuery, observeScenarioReceiptQueryDependency,
  selectScenarioReceiptQueryFirstRow, bindScenarioReceiptQueryCount,
  bindScenarioReceiptReferenceProducer, bindScenarioReceiptModelResult, selectScenarioReceiptReturn,
  readScenarioReceiptAssociation, projectScenarioReceipt } from '../../src/invocation/scenario-receipt.js';
import { field, modelDef } from '../mutation/fixtures.js';
import { asId, asModel, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, makeRow, uuidv7 } from './fixtures.js';

const TURN = asModel('QueryCountModel.Turn'), RUN = asModel('QueryCountModel.Run');
const ROOT = 'QueryCountModel.start', CHILD = 'QueryCountModel.reserve', APP = 'query-count-model-components', TEAM = 'query-count-model-team';
const CREATED = asId('created-run'), CREATED_TURN = asId('created-turn'), cause = { cause: 'scenario' } as const, bounds = { maxRows: 10, maxWork: 1000 };
const source = { path: 'query-count-model.can', sha256: 'd'.repeat(64), module: 'query-count-model.mjs' };
let sequence = 95_000;
function artifact(limit: number | null = null, skippedControl = false): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="QueryCountModel.start";', map: {
      version: 3, file: source.module, sources: [source.path], sourcesContent: [null], names: [], mappings: '',
    } }], callables: [ROOT, CHILD].map(id => ({ id, kind: 'operation' as const, module: source.module,
      export: 'identity', member: [id.split('.').at(-1)!] })),
    models: [{ name: TURN, deleteMode: 'remove', fields: [
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
          dependencies: [{ id: 'account-control', source, role: 'control' as const, field: 'account', type: 'text' as CanTypeId },
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
  const store = createMemoryStorage(), loaded = loadArtifactDescriptors(
    artifact(options.limit, options.skippedControl), { by: 'members' });
  const root = loaded.registry.get(ROOT), child = loaded.registry.get(CHILD);
  assert.ok(root && isGeneratedOperationDef(root)); assert.ok(child && isGeneratedOperationDef(child));
  const table = buildModelTable([
    modelDef(TURN, { deleteMode: 'remove', fields: { account: field({ required: true }), held: field({ required: true }), position: field(),
      ...(options.skippedControl ? { active: field({ required: true }) } : {}) } }),
    modelDef(RUN, { deleteMode: 'remove', fields: { account: field({ required: true }), title: field({ required: true }) } }),
  ]);
  const rows: StoredRow[] = [];
  if (options.domain !== 'empty') for (const [id, account, held] of [
    ['turn-c', 'caller', '20'], ['turn-a', 'caller', '7'], ['turn-b', 'other', '100'],
  ] as const) {
    const row = makeRow({ id, data: { account: options.domain === 'false' ? 'other' : account, held,
      ...(options.skippedControl ? { active: 'yes' } : {}) } });
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: TURN, row }] }));
    const stored = await store.load(TURN, row.id); assert.ok(stored); rows.push(stored);
  }
  const access = { turn: true, run: true, active: true };
  const policy = buildPolicyTable([
    { model: TURN, secretFields: [], grants: [{ by: 'members', fields: ['account', 'held', 'position', ...(options.skippedControl ? ['active'] : [])] }] },
    { model: RUN, secretFields: [], grants: [{ by: 'members', fields: ['account', 'title'] }] },
  ], loaded.models);
  const readPolicies = new Map<ModelName, ViewerSourceReadPolicy>();
  for (const [model, fields] of [[TURN, ['account', 'held', 'position']], [RUN, ['account', 'title']]] as const) {
    readPolicies.set(model, { fields: [...fields, ...(model === TURN && options.skippedControl ? ['active'] : [])],
      secretFields: [], grants: [{ fields: ['id', ...fields], read: async ({ context }) =>
      (model === TURN ? access.turn : access.run) &&
      (await context.memberships.findMembership(TEAM, model === TURN ? 'turn-reader' : 'caller'))?.status === 'active' &&
      context.membership?.status === 'active',
    }, ...(model === TURN && options.skippedControl ? [{ fields: ['active'], read: async () => access.active }] : [])] });
  }
  for (const def of [root, child]) bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  bindScenarioReceiptQueryProducer(child, { source, app: APP, policy });
  return { store, memberships, caller, reader, root, child, table, policy, access, readPolicies, rows,
    skippedControl: options.skippedControl === true, registry: loaded.registry, app: APP, source: 'component', clock: { nowMs: () => FIXED_NOW },
    identity: makeIdentity({ membership: caller }), envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {}) };
}
type World = Awaited<ReturnType<typeof world>>;
type Session = Awaited<ReturnType<typeof beginScenarioReceiptMutation>>;
type Query = Awaited<ReturnType<typeof executeScenarioReceiptQuery>>;
type QueryHook = (call: AdmittedCall, session: Pick<Session, 'stage' | 'read' | 'views'>, query: Query) => Promise<void>;
const refuses = (error: unknown) => error instanceof StateError;
function bindChild(w: World, hook?: QueryHook, skipCount = false) {
  let executions = 0, predicates = 0, closedCall: AdmittedCall | undefined, captured: Query | undefined;
  bindScenarioReceiptCallProducer(w.root, { source, app: APP, registry: w.registry,
    sites: [{ id: 'reserve-site', source, kind: 'operation', targets: [{ operation: CHILD, interface: w.child.descriptor }],
      resultType: RUN as CanTypeId }], prepare: (_def, inputs) => inputs as ClosedInputs,
    execute: async frame => {
      executions++; closedCall = frame.call;
      const result = await executeScenarioReceiptQuery(frame.call, w.store, { queryId: 'turns', predicate: ({ slot, record }) => {
        predicates++; const account = record.data.account;
        observeScenarioReceiptQueryDependency(frame.call, w.store, { slot, dependencyId: 'account-control' });
        return account === 'caller';
      } });
      captured = result; await hook?.(frame.call, frame.session, result);
      // Actual owner count consumer feeds the created row. State does not attest this arithmetic.
      const count = skipCount ? BigInt(result.count) : await bindScenarioReceiptQueryCount(frame.call, w.store, { query: result.query });
      assert.equal(typeof count, 'bigint');
      await frame.session.stage({ op: 'create', model: TURN, id: CREATED_TURN,
        data: { account: 'caller', held: '0', position: (count + 1n).toString(),
          ...(w.skippedControl ? { active: 'yes' } : {}) } }, cause);
      await frame.session.stage({ op: 'create', model: RUN, id: CREATED,
        data: { account: 'caller', title: 'Counted' } }, cause);
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
  assert.equal(await w.store.load(TURN, CREATED_TURN), null);
  assert.deepEqual(await w.store.historyFor(TURN, CREATED_TURN), []);
  for (const row of w.rows) assert.deepEqual(await w.store.load(TURN, row.id), row);
  assert.deepEqual(await w.store.historyFor(RUN, CREATED), []); assert.deepEqual(await w.store.outboxPending(), []);
}

test('genuine count 0/2 feeds Turn.position and returns new Run, retaining the entire ordered domain and replaying once', async () => {
  for (const domain of [undefined, 'empty', 'false'] as const) {
    const w = await world(domain === undefined ? {} : { domain }), producer = bindChild(w);
    let receipt: Receipt | undefined, commits = 0;
    const commit = w.store.commit; w.store.commit = async batch => { commits++; return commit(batch); };
    const request = input(w, value => { receipt = value; });
    assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
    const saved = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!;
    const query = saved.queries![0]!;
    assert.equal(query.candidates.length, domain === 'empty' ? 0 : 3);
    assert.deepEqual(query.selectedIndices.map(index => query.candidates[index]!.row.id),
      domain === undefined ? ['turn-a', 'turn-c'] : []);
    assert.equal(query.candidates.find(candidate => candidate.row.id === 'turn-b')?.matched,
      domain === 'empty' ? undefined : false);
    assert.ok(query.candidates.every(candidate => candidate.dependencies.includes('account-control')));
    // Count grants no first-row observation, including when every candidate is false.
    assert.deepEqual(saved.observations, []);
    assert.equal((await w.store.load(TURN, CREATED_TURN))!.data.position, domain === undefined ? '3' : '1');
    assert.deepEqual((await w.store.load(RUN, CREATED))!.data, { account: 'caller', title: 'Started' });
    for (const row of w.rows) assert.deepEqual(await w.store.load(TURN, row.id), row);
    assert.equal((await w.store.historyFor(TURN, CREATED_TURN)).length, 1);
    assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
    const retained = structuredClone(receipt);
    assert.equal((await invoke(request)).status, 'replayed');
    assert.equal(producer.executions, 1); assert.equal(producer.predicates, domain === 'empty' ? 0 : 3); assert.equal(commits, 1);
    assert.deepEqual(receipt, retained);
  }
});

test('a completed query count number cannot replace actual count consumption when binding the returned Run', async () => {
  const w = await world(); bindChild(w, undefined, true);
  await assert.rejects(invoke(input(w)), refuses); await unchanged(w);
});

test('count consumes once at its genuine stage and first/count are mutually exclusive; caught misuse poisons the owner', async () => {
  for (const mode of ['copy-query', 'copy-call', 'foreign-store', 'repeat', 'first-count', 'count-first', 'stale', 'concurrent'] as const) {
    const w = await world();
    bindChild(w, async (call, session, result) => {
      if (mode === 'stale') await session.stage({ op: 'update', model: TURN, id: asId('turn-c'), data: { held: '21' } }, cause);
      if (mode === 'repeat' || mode === 'count-first') await bindScenarioReceiptQueryCount(call, w.store, { query: result.query });
      if (mode === 'first-count') await selectScenarioReceiptQueryFirstRow(call, w.store, { query: result.query });
      if (mode === 'count-first') {
        await assert.rejects(selectScenarioReceiptQueryFirstRow(call, w.store, { query: result.query }), refuses);
      } else if (mode === 'concurrent') {
        const results = await Promise.allSettled([
          bindScenarioReceiptQueryCount(call, w.store, { query: result.query }),
          bindScenarioReceiptQueryCount(call, w.store, { query: result.query }),
        ]);
        assert.ok(results.some(value => value.status === 'rejected' && refuses(value.reason)));
      } else await assert.rejects(bindScenarioReceiptQueryCount(mode === 'copy-call' ? { ...call } : call,
        mode === 'foreign-store' ? { ...w.store } : w.store, { query: mode === 'copy-query' ? { ...result.query } : result.query }), refuses);
    });
    await assert.rejects(invoke(input(w)), refuses); await unchanged(w);
  }
  const w = await world(), producer = bindChild(w); await invoke(input(w));
  assert.ok(producer.closedCall && producer.captured);
  await assert.rejects(bindScenarioReceiptQueryCount(producer.closedCall, w.store, { query: producer.captured.query }), refuses);
  const foreign = await world(); bindChild(foreign, async call => {
    await assert.rejects(bindScenarioReceiptQueryCount(call, foreign.store, { query: producer.captured!.query }), refuses);
  });
  await assert.rejects(invoke(input(foreign)), refuses); await unchanged(foreign);
});

test('query count retains overflow refusal before any count-dependent writes', async () => {
  const w = await world({ limit: 1 }), producer = bindChild(w);
  await assert.rejects(invoke(input(w)), refuses);
  assert.equal(producer.predicates, 3); assert.equal(producer.captured, undefined); await unchanged(w);
});

test('late parent failure rolls back count-dependent Turn, child Run and parent Run update together', async () => {
  const w = await world(), producer = bindChild(w);
  await assert.rejects(invoke(input(w, undefined, async () => {
    throw new StateError('rule_failed', 'Parent rejected after promotion.');
  })), error => error instanceof StateError && error.code === 'rule_failed');
  assert.equal(producer.executions, 1); await unchanged(w);
});

test('current source grant or tracked Identity loss refuses count-dependent shared commit and withholds saved result/effects', async () => {
  for (const loss of ['source', 'membership'] as const) {
    const revoke = async (w: World) => {
      if (loss === 'source') w.access.turn = false;
      else await w.memberships.removeMembership(w.reader.membership_id);
    };
    const failed = await world(); bindChild(failed);
    await assert.rejects(invoke(input(failed, undefined, async () => revoke(failed))), refuses); await unchanged(failed);
    const w = await world(), producer = bindChild(w); let receipt: Receipt | undefined;
    const request = input(w, value => { receipt = value; }); await invoke(request); assert.ok(receipt);
    assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
    await revoke(w);
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
    assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.executions, 1); assert.equal(producer.predicates, 3);
  }
});

test('count recovery requires complete potential source-control policies even for an unexecuted control', async () => {
  const w = await world({ skippedControl: true }), producer = bindChild(w); let receipt: Receipt | undefined;
  const request = input(w, value => { receipt = value; }); await invoke(request); assert.ok(receipt);
  const query = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!.queries![0]!;
  assert.ok(query.candidates.every(candidate => candidate.dependencies.includes('account-control') &&
    !candidate.dependencies.includes('active-control')));
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
  w.access.active = false;
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
  assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.executions, 1); assert.equal(producer.predicates, 3);
});

test('saved count cannot forge missing/truncated/wrong-count/reordered selected indices or false membership', async () => {
  const w = await world(); bindChild(w); let receipt: Receipt | undefined;
  await invoke(input(w, value => { receipt = value; })); assert.ok(receipt);
  for (const mode of ['missing', 'missing-indices', 'truncated', 'wrong-count', 'reordered', 'false-member'] as const) {
    const altered: Receipt = structuredClone(receipt); assert.ok(altered.outcome.status === 'committed');
    const saved = altered.outcome.scenario!.calls![0]!.scenario!, query = saved.queries![0]!;
    if (mode === 'missing') Object.assign(saved, { queries: [] });
    if (mode === 'missing-indices') Reflect.deleteProperty(query, 'selectedIndices');
    if (mode === 'truncated') Object.assign(query, { selectedIndices: query.selectedIndices.slice(0, 1) });
    if (mode === 'wrong-count') Object.assign(query, { selectedIndices: [] });
    if (mode === 'reordered') Object.assign(query, { selectedIndices: [...query.selectedIndices].reverse() });
    if (mode === 'false-member') Object.assign(query, { selectedIndices: [
      ...query.selectedIndices, query.candidates.findIndex(candidate => !candidate.matched),
    ] });
    await assert.rejects(projectScenarioReceipt({ ...w, receipt: altered }), refuses);
  }
});
