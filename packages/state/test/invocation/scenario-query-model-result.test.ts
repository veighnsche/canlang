/** Finite installed State components; no generated Can/Dev/native acceptance. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ClosedInputs, ModelName, Receipt, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildModelTable, buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import type { ViewerSourceReadPolicy, ViewerGenerationCallbackReadObservation } from '../../src/query/source-policy.js';
import { invoke, type ExecutionEffects } from '../../src/invocation/invoke.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptCallProducer, invokeScenarioReceiptCall,
  bindScenarioReceiptQueryProducer, executeScenarioReceiptQuery, observeScenarioReceiptQueryDependency,
  selectScenarioReceiptQueryFirstRow, observeScenarioReceiptDependency,
  bindScenarioReceiptReferenceProducer, bindScenarioReceiptModelResult, selectScenarioReceiptReturn,
  readScenarioReceiptAssociation, projectScenarioReceipt,
  type ScenarioReceiptReferenceProducer, type ScenarioReceiptMembershipSite } from '../../src/invocation/scenario-receipt.js';
import { field, modelDef } from '../mutation/fixtures.js';
import { asId, asModel, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, makeRow, uuidv7 } from './fixtures.js';

const ALLOWANCE = asModel('QueryModel.Allowance'), RUN = asModel('QueryModel.Run');
const ROOT = 'QueryModel.start', CHILD = 'QueryModel.reserve', APP = 'query-model-components', TEAM = 'query-model-team';
const CREATED = asId('created-run'), cause = { cause: 'scenario' } as const, bounds = { maxRows: 10, maxWork: 1000 };
const source = { path: 'query-model.can', sha256: 'd'.repeat(64), module: 'query-model.mjs' };
let sequence = 94_000;
function artifact(limit: number | null = null, absenceResult = false, skippedControl = false): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="QueryModel.start";', map: {
      version: 3, file: source.module, sources: [source.path], sourcesContent: [null], names: [], mappings: '',
    } }], callables: [ROOT, CHILD].map(id => ({ id, kind: 'operation' as const, module: source.module,
      export: 'identity', member: [id.split('.').at(-1)!] })),
    models: [{ name: ALLOWANCE, deleteMode: 'remove', fields: ['account', 'held', ...(skippedControl ? ['active'] : [])].map(name => ({
      name, field: { kind: 'string' as const }, required: true, serverOnly: false,
    })) }, { name: RUN, deleteMode: 'remove', fields: ['account', 'title'].map(name => ({
      name, field: { kind: 'string' as const }, required: true, serverOnly: false,
    })) }],
    operations: [ROOT, CHILD].map(name => ({ name, kind: 'scenario' as const, description: '', inputs: { fields: [] },
      result: { type: RUN as CanTypeId, disclosure: { version: 1 as const, source,
        ...(name === CHILD ? { queries: [{ id: 'allowances', source, model: ALLOWANCE,
          order: [{ field: 'id', direction: 'asc' as const }], limit, archived: 'exclude' as const,
          dependencies: [{ id: 'account-control', source, role: 'control' as const, field: 'account', type: 'text' as CanTypeId },
            ...(skippedControl ? [{ id: 'active-control', source, role: 'control' as const, field: 'active', type: 'text' as CanTypeId }] : [])],
        }] } : {}),
        returns: [{ id: name === ROOT ? 'root-return' : 'child-return', source,
          dependencies: name === CHILD && !absenceResult ? [{ id: 'held-data', source, role: 'data' as const,
            model: ALLOWANCE, field: 'held', type: 'text' as CanTypeId }] : [],
          influences: name === CHILD ? (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
            .map(kind => ({ id: kind, kind, queryId: 'allowances' })) : [],
        }],
      } } })),
  };
}
async function world(options: { domain?: 'empty' | 'false'; limit?: number; absenceResult?: boolean; skippedControl?: boolean; executionContract?: boolean; guardOnlyQuery?: boolean; scalarResult?: 'bool' | 'void'; executionBinding?: (producer: ScenarioReceiptReferenceProducer, sites: ScenarioReceiptMembershipSite[]) => void } = {}) {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const caller = await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false, roles: [] });
  const reader = await memberships.createMembership({ team_id: TEAM, user_id: 'allowance-reader', is_owner: false, roles: [] });
  const slice = artifact(options.limit, options.absenceResult, options.skippedControl);
  if (options.scalarResult) for (const operation of slice.operations!) Object.assign(operation.result!, { type: options.scalarResult });
  if (options.guardOnlyQuery) Object.assign(slice.operations![1]!.result!.disclosure!.returns[0]!, { influences: [] });
  if (options.executionContract) {
    slice.valueTypes = { contracts: [{ name: 'QueryModel.Input', fields: [
      { name: 'title', type: 'text' }, { name: 'facts', type: 'text[]' },
    ] }] };
    slice.models![0]!.fields.push({ name: 'input', field: { kind: 'nominal', name: 'QueryModel.Input' },
      valueType: 'QueryModel.Input' as CanTypeId, required: true, serverOnly: false });
  }
  const store = createMemoryStorage(), loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const root = loaded.registry.get(ROOT), child = loaded.registry.get(CHILD);
  assert.ok(root && isGeneratedOperationDef(root)); assert.ok(child && isGeneratedOperationDef(child));
  const table = options.executionContract ? buildModelTableFromCanonical(loaded.models, { refs: loaded.refs,
    ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) }) : buildModelTable([
    modelDef(ALLOWANCE, { deleteMode: 'remove', fields: { account: field({ required: true }), held: field({ required: true }),
      ...(options.skippedControl ? { active: field({ required: true }) } : {}) } }),
    modelDef(RUN, { deleteMode: 'remove', fields: { account: field({ required: true }), title: field({ required: true }) } }),
  ]);
  const rows: StoredRow[] = [];
  if (options.domain !== 'empty') for (const [id, account, held] of [
    ['allowance-c', 'caller', '20'], ['allowance-a', 'caller', '7'], ['allowance-b', 'other', '100'],
  ] as const) {
    const row = makeRow({ id, data: { account: options.domain === 'false' ? 'other' : account, held,
      ...(options.skippedControl ? { active: 'yes' } : {}),
      ...(options.executionContract ? { input: { title: 'Reviewed', facts: ['first', 'first', 'last'] } } : {}) } });
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: ALLOWANCE, row }] }));
    const stored = await store.load(ALLOWANCE, row.id); assert.ok(stored); rows.push(stored);
  }
  const access = { allowance: true, run: true, active: true, input: true };
  const policy = buildPolicyTable([
    { model: ALLOWANCE, secretFields: [], grants: [{ by: 'members', fields: ['account', 'held', ...(options.skippedControl ? ['active'] : [])] }] },
    { model: RUN, secretFields: [], grants: [{ by: 'members', fields: ['account', 'title'] }] },
  ], loaded.models);
  const readPolicies = new Map<ModelName, ViewerSourceReadPolicy>();
  for (const [model, fields] of [[ALLOWANCE, ['account', 'held']], [RUN, ['account', 'title']]] as const) {
    readPolicies.set(model, { fields: [...fields, ...(model === ALLOWANCE && options.skippedControl ? ['active'] : []),
        ...(model === ALLOWANCE && options.executionContract ? ['input'] : [])],
      secretFields: [], grants: [{ fields: ['id', ...fields], read: async ({ context }) =>
      (model === ALLOWANCE ? access.allowance : access.run) &&
      (await context.memberships.findMembership(TEAM, model === ALLOWANCE ? 'allowance-reader' : 'caller'))?.status === 'active' &&
      context.membership?.status === 'active',
    }, ...(model === ALLOWANCE && options.skippedControl ? [{ fields: ['active'], read: async () => access.active }] : []),
      ...(model === ALLOWANCE && options.executionContract ? [{ fields: ['input'], read: async ({ context }: Readonly<ViewerGenerationCallbackReadObservation>) => access.input &&
        (await context.memberships.findMembership(TEAM, 'allowance-reader'))?.status === 'active' }] : [])] });
  }
  for (const def of [root, child]) {
    if (options.scalarResult && def === root) continue;
    const producer: ScenarioReceiptReferenceProducer = { source, app: APP, policy, readPolicies,
      ...(def === child && options.executionContract ? { executionDependencies: [{ siteIndex: 0, queryId: 'allowances',
        node: { start: 12, end: 14 }, dependency: { id: 'require-input', source, role: 'control', model: ALLOWANCE,
          field: 'input', type: 'QueryModel.Input' as CanTypeId } }] } : {}) };
    if (def === child && options.executionContract) {
      const sites: ScenarioReceiptMembershipSite[] = [{ version: 1, source, owner: CHILD,
        node: { start: 10, end: 30 }, statement: { start: 9, end: 31 }, stage: 'body-require',
        position: [{ kind: 'body', index: 1 }, { kind: 'then', index: 0 }], calls: [] }];
      Object.assign(producer, { executionSites: sites });
      options.executionBinding?.(producer, sites);
    }
    bindScenarioReceiptReferenceProducer(def, producer);
  }
  bindScenarioReceiptQueryProducer(child, { source, app: APP, policy, ...(options.executionContract ? { readPolicies } : {}) });
  return { store, memberships, caller, reader, root, child, table, policy, access, readPolicies, rows,
    absenceResult: options.absenceResult === true,
    registry: loaded.registry, app: APP, source: 'component', clock: { nowMs: () => FIXED_NOW },
    identity: makeIdentity({ membership: caller }), envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {}) };
}
type World = Awaited<ReturnType<typeof world>>;
type Session = Awaited<ReturnType<typeof beginScenarioReceiptMutation>>;
type Query = Awaited<ReturnType<typeof executeScenarioReceiptQuery>>;
type QueryHook = (call: AdmittedCall, session: Pick<Session, 'stage' | 'read' | 'views'>, query: Query) => Promise<void>;
const refuses = (error: unknown) => error instanceof StateError;
function bindChild(w: World, hook?: QueryHook) {
  let executions = 0, predicates = 0, closedCall: AdmittedCall | undefined, captured: Query | undefined;
  bindScenarioReceiptCallProducer(w.root, { source, app: APP, registry: w.registry,
    sites: [{ id: 'reserve-site', source, kind: 'operation', targets: [{ operation: CHILD, interface: w.child.descriptor }],
      resultType: RUN as CanTypeId }], prepare: (_def, inputs) => inputs as ClosedInputs,
    execute: async frame => {
      executions++; closedCall = frame.call;
      const result = await executeScenarioReceiptQuery(frame.call, w.store, { queryId: 'allowances', predicate: ({ slot, record }) => {
        predicates++; const account = record.data.account;
        observeScenarioReceiptQueryDependency(frame.call, w.store, { slot, dependencyId: 'account-control' });
        return account === 'caller';
      } });
      captured = result; await hook?.(frame.call, frame.session, result);
      const allowance = await selectScenarioReceiptQueryFirstRow(frame.call, w.store, { query: result.query });
      if (allowance === null && !w.absenceResult) throw new StateError('rule_failed', 'An allowance is required.');
      if (allowance !== null) {
        assert.equal(allowance.id, 'allowance-a'); assert.equal(allowance.data.held, '7');
        await observeScenarioReceiptDependency(frame.call, w.store,
          { dependencyId: 'held-data', model: ALLOWANCE, row: allowance, field: 'held' });
        await frame.session.stage({ op: 'update', model: ALLOWANCE, id: allowance.id, data: { held: '8' } }, cause);
      }
      await frame.session.stage({ op: 'create', model: RUN, id: CREATED,
        data: { account: 'caller', title: allowance === null ? 'No allowance' : 'Reserved' } }, cause);
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
  for (const row of w.rows) assert.deepEqual(await w.store.load(ALLOWANCE, row.id), row);
  assert.deepEqual(await w.store.historyFor(RUN, CREATED), []); assert.deepEqual(await w.store.outboxPending(), []);
}

test('ordered first keeps two matches and the false candidate through new Run, parent promotion and recovery', async () => {
  const w = await world(), producer = bindChild(w); let receipt: Receipt | undefined, commits = 0;
  const commit = w.store.commit; w.store.commit = async batch => { commits++; return commit(batch); };
  const request = input(w, value => { receipt = value; });
  assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
  const association = readScenarioReceiptAssociation(receipt)!;
  const saved = association.calls![0]!.scenario!.queries![0]!;
  assert.equal(saved.candidates.length, 3); assert.equal(saved.selectedIndices.length, 2);
  assert.deepEqual(saved.selectedIndices.map(index => saved.candidates[index]!.row.id), ['allowance-a', 'allowance-c']);
  assert.equal(saved.candidates.find(candidate => candidate.row.id === 'allowance-b')!.matched, false);
  assert.ok(saved.candidates.every(candidate => candidate.dependencies.includes('account-control')));
  assert.equal(association.calls![0]!.scenario!.observations[0]!.row.id, 'allowance-a');
  assert.equal((await w.store.load(ALLOWANCE, asId('allowance-a')))!.data.held, '8');
  assert.equal((await w.store.load(ALLOWANCE, asId('allowance-c')))!.data.held, '20');
  assert.deepEqual((await w.store.load(RUN, CREATED))!.data, { account: 'caller', title: 'Started' });
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
  const retained = structuredClone(receipt), row = await w.store.load(RUN, CREATED);
  assert.equal((await invoke(request)).status, 'replayed');
  assert.equal(producer.executions, 1); assert.equal(producer.predicates, 3); assert.equal(commits, 1);
  assert.deepEqual(receipt, retained); assert.deepEqual(await w.store.load(RUN, CREATED), row);
});

test('empty and all-false queries yield null and fail the business rule without committing', async () => {
  for (const domain of ['empty', 'false'] as const) {
    const w = await world({ domain }); let selected = false;
    const producer = bindChild(w, async (call, _session, query) => {
      assert.equal(query.count, 0);
      assert.equal(await selectScenarioReceiptQueryFirstRow(call, w.store, { query: query.query }), null);
      selected = true;
      throw new StateError('rule_failed', 'An allowance is required.');
    });
    await assert.rejects(invoke(input(w)), error => error instanceof StateError && error.code === 'rule_failed');
    assert.ok(selected); assert.equal(producer.predicates, domain === 'empty' ? 0 : 3); await unchanged(w);
  }
});

test('completed empty and all-false first paths save genuine absence and replay without predicates', async () => {
  for (const domain of ['empty', 'false'] as const) {
    const w = await world({ domain, absenceResult: true }), producer = bindChild(w); let receipt: Receipt | undefined;
    const request = input(w, value => { receipt = value; });
    assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
    const saved = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!;
    assert.equal(saved.queries!.length, 1); assert.deepEqual(saved.queries![0]!.selectedIndices, []);
    assert.equal(saved.queries![0]!.candidates.length, domain === 'empty' ? 0 : 3);
    assert.ok(saved.queries![0]!.candidates.every(candidate => !candidate.matched));
    assert.deepEqual(saved.observations, []);
    assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
    assert.equal((await invoke(request)).status, 'replayed');
    assert.equal(producer.executions, 1); assert.equal(producer.predicates, domain === 'empty' ? 0 : 3);
    for (const row of w.rows) assert.deepEqual(await w.store.load(ALLOWANCE, row.id), row);
    const altered: Receipt = structuredClone(receipt); assert.ok(altered.outcome.status === 'committed');
    Object.assign(altered.outcome.scenario!.calls![0]!.scenario!, { queries: [] });
    await assert.rejects(projectScenarioReceipt({ ...w, receipt: altered }), refuses);
  }
});

test('late parent rejection rolls back the query-dependent allowance change and created Run', async () => {
  const w = await world(), producer = bindChild(w);
  await assert.rejects(invoke(input(w, undefined, async () => {
    throw new StateError('rule_failed', 'Parent rejected after promotion.');
  })), error => error instanceof StateError && error.code === 'rule_failed');
  assert.equal(producer.executions, 1); await unchanged(w);
});

test('copied, repeated, stale and foreign first handles poison the shared owner; closed child handles refuse', async () => {
  for (const mode of ['copy-query', 'copy-call', 'foreign-store', 'repeat', 'stale'] as const) {
    const w = await world();
    bindChild(w, async (call, session, result) => {
      if (mode === 'stale') await session.stage({ op: 'update', model: ALLOWANCE, id: asId('allowance-c'), data: { held: '21' } }, cause);
      if (mode === 'repeat') await selectScenarioReceiptQueryFirstRow(call, w.store, { query: result.query });
      await assert.rejects(async () => selectScenarioReceiptQueryFirstRow(mode === 'copy-call' ? { ...call } : call,
        mode === 'foreign-store' ? { ...w.store } : w.store, { query: mode === 'copy-query' ? { ...result.query } : result.query }), refuses);
    });
    await assert.rejects(invoke(input(w)), refuses); await unchanged(w);
  }
  const w = await world(), producer = bindChild(w); await invoke(input(w));
  assert.ok(producer.closedCall && producer.captured);
  await assert.rejects(async () => selectScenarioReceiptQueryFirstRow(producer.closedCall!, w.store,
    { query: producer.captured!.query }), refuses);
  const other = await world();
  bindChild(other, async (call) => {
    await assert.rejects(async () => selectScenarioReceiptQueryFirstRow(call, other.store,
      { query: producer.captured!.query }), refuses);
  });
  await assert.rejects(invoke(input(other)), refuses); await unchanged(other);
});

test('query limit remains an overflow bound before first selection', async () => {
  const w = await world({ limit: 1 }), producer = bindChild(w);
  await assert.rejects(invoke(input(w)), refuses);
  assert.equal(producer.predicates, 3); assert.equal(producer.captured, undefined); await unchanged(w);
});

test('current query source grant and tracked membership loss refuse the shared commit', async () => {
  for (const loss of ['source', 'membership'] as const) {
    const w = await world(); bindChild(w);
    await assert.rejects(invoke(input(w, undefined, async () => {
      if (loss === 'source') w.access.allowance = false;
      else await w.memberships.removeMembership(w.reader.membership_id);
    })), refuses); await unchanged(w);
  }
});

test('saved query-dependent model result and changes mask together under current source or membership denial', async () => {
  for (const loss of ['source', 'membership'] as const) {
    const w = await world(), producer = bindChild(w); let receipt: Receipt | undefined;
    const request = input(w, value => { receipt = value; }); await invoke(request); assert.ok(receipt);
    assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
    if (loss === 'source') w.access.allowance = false;
    else await w.memberships.removeMembership(w.reader.membership_id);
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
    assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.executions, 1); assert.equal(producer.predicates, 3);
  }
});

test('saved first-result recovery requires the source grant for an unexecuted potential query control', async () => {
  const w = await world({ skippedControl: true }), producer = bindChild(w); let receipt: Receipt | undefined;
  const request = input(w, value => { receipt = value; });
  assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
  const saved = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!.queries![0]!;
  assert.equal(saved.candidates.length, 3);
  assert.ok(saved.candidates.every(candidate => candidate.dependencies.includes('account-control') &&
    !candidate.dependencies.includes('active-control')));
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
  w.access.active = false;
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
  assert.equal((await invoke(request)).status, 'replayed');
  assert.equal(producer.executions, 1); assert.equal(producer.predicates, 3);
});

test('saved model query influence refuses missing, foreign, truncated and reordered observations', async () => {
  const w = await world(); bindChild(w); let receipt: Receipt | undefined;
  await invoke(input(w, value => { receipt = value; })); assert.ok(receipt);
  for (const mode of ['missing', 'foreign', 'truncated', 'reordered'] as const) {
    const altered: Receipt = structuredClone(receipt);
    assert.ok(altered.outcome.status === 'committed');
    const saved = altered.outcome.scenario!.calls![0]!.scenario!;
    const query = saved.queries![0]!;
    // Corrupt only the saved transport; genuine owner observations remain untouched.
    if (mode === 'missing') Object.assign(saved, { queries: [] });
    if (mode === 'foreign') Object.assign(query, { queryId: 'foreign-query' });
    if (mode === 'truncated') Object.assign(query, { selectedIndices: query.selectedIndices.slice(0, 1) });
    if (mode === 'reordered') Object.assign(query, { selectedIndices: [...query.selectedIndices].reverse() });
    await assert.rejects(projectScenarioReceipt({ ...w, receipt: altered }), refuses);
  }
});

/** The selected Contract is read by Require, independently of the returned Run. */
function bindExecutionContractChild(w: World, mode = 'read', after?: () => Promise<void>) {
  let reads = 0, selected: StoredRow | null = null, activeCall: AdmittedCall | undefined;
  bindScenarioReceiptCallProducer(w.root, { source, app: APP, registry: w.registry,
    sites: [{ id: 'reserve-site', source, kind: 'operation', targets: [{ operation: CHILD, interface: w.child.descriptor }],
      resultType: RUN as CanTypeId }], prepare: (_def, inputs) => inputs as ClosedInputs,
    execute: async frame => {
      activeCall = frame.call;
      const result = await executeScenarioReceiptQuery(frame.call, w.store, { queryId: 'allowances', predicate: ({ slot, record }) => {
        const account = record.data.account;
        observeScenarioReceiptQueryDependency(frame.call, w.store, { slot, dependencyId: 'account-control' });
        return account === 'caller';
      } });
      const before = mode === 'before-first' ? await frame.session.read(ALLOWANCE, w.rows[1]!.id) : null;
      if (before !== null) await observeScenarioReceiptDependency(frame.call, w.store,
        { dependencyId: 'require-input', model: ALLOWANCE, row: before, field: 'input' });
      selected = await selectScenarioReceiptQueryFirstRow(frame.call, w.store, { query: result.query });
      assert.ok(selected);
      if (mode !== 'skip') {
        const row = mode === 'copy' ? structuredClone(selected) : mode === 'other' ? await frame.session.read(ALLOWANCE, w.rows[0]!.id) : selected;
        assert.ok(row);
        const observation = { dependencyId: mode === 'missing' ? 'unbound-input' : 'require-input', model: ALLOWANCE,
          row, field: mode === 'field' ? 'held' : 'input' };
        const wire = selected.data.input; reads++;
        await observeScenarioReceiptDependency(mode === 'copy-call' ? { ...frame.call } : frame.call,
          mode === 'foreign-store' ? { ...w.store } : w.store, observation);
        assert.deepEqual(wire, { title: 'Reviewed', facts: ['first', 'first', 'last'] });
        if (mode === 'repeat') await observeScenarioReceiptDependency(frame.call, w.store, observation);
      }
      await after?.();
      await frame.session.stage({ op: 'create', model: RUN, id: CREATED, data: { account: 'caller', title: 'Independent' } }, cause);
      const run = await frame.session.read(RUN, CREATED); assert.ok(run);
      const resultWire = await bindScenarioReceiptModelResult(frame.call, w.store, { returnId: 'child-return', row: run });
      selectScenarioReceiptReturn(frame.call, w.store, 'child-return'); return resultWire;
    } });
  return { get reads() { return reads; }, get selected() { return selected; }, get call() { return activeCall; } };
}

test('lazy first-selected whole Contract Require keeps current authority without result dependency or replay taint', async () => {
  const w = await world({ absenceResult: true, executionContract: true, guardOnlyQuery: true });
  const producer = bindExecutionContractChild(w); let receipt: Receipt | undefined;
  const request = input(w, value => { receipt = value; });
  assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt); assert.equal(producer.reads, 1);
  const child = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!;
  assert.deepEqual(child.observations, []);
  assert.deepEqual(child.plan.returns[0]!.dependencies, []);
  assert.deepEqual(child.plan.returns[0]!.influences, []);
  assert.equal(child.queries, undefined);
  assert.equal(JSON.stringify(receipt).includes('require-input'), false);
  w.access.input = false;
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
  assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.reads, 1);
  await assert.rejects(observeScenarioReceiptDependency(producer.call!, w.store,
    { dependencyId: 'require-input', model: ALLOWANCE, row: producer.selected!, field: 'input' }), refuses);
});

test('execution Contract authority is lazy and skipped Require operands are not forced by first selection', async () => {
  const w = await world({ absenceResult: true, executionContract: true }); w.access.input = false;
  const producer = bindExecutionContractChild(w, 'skip');
  assert.equal((await invoke(input(w))).status, 'committed'); assert.equal(producer.reads, 0);
});

test('execution Contract reads reject missing, copied, foreign, repeated and not-yet-selected occurrences', async () => {
  for (const mode of ['missing', 'copy', 'other', 'repeat', 'field', 'copy-call', 'foreign-store', 'before-first', 'denied'] as const) {
    const w = await world({ absenceResult: true, executionContract: true });
    if (mode === 'denied') w.access.input = false;
    bindExecutionContractChild(w, mode);
    await assert.rejects(invoke(input(w)), refuses, mode); await unchanged(w);
  }
});

test('execution Contract final field grants and membership are revalidated before atomic commit', async () => {
  for (const mode of ['field', 'membership'] as const) {
    const w = await world({ absenceResult: true, executionContract: true });
    const producer = bindExecutionContractChild(w, 'read', async () => {
      if (mode === 'field') w.access.input = false;
      else await w.memberships.removeMembership(w.reader.membership_id);
    });
    await assert.rejects(invoke(input(w)), refuses); assert.equal(producer.reads, 1); await unchanged(w);
  }
});

test('execution Contract binding refuses forged Require/source/query/schema and open or accessor metadata', async () => {
  for (const mode of ['site', 'stage', 'source', 'node', 'query', 'queryId', 'role', 'type', 'field', 'collision', 'missing-sites', 'owner', 'open', 'accessor'] as const) {
    let accesses = 0;
    await assert.rejects(world({ absenceResult: true, executionContract: true, executionBinding: (producer, sites) => {
      const association = producer.executionDependencies![0]!, dep = association.dependency;
      if (mode === 'site') Object.assign(association, { siteIndex: 1 });
      if (mode === 'stage') Object.assign(sites[0]!, { stage: 'body-condition' });
      if (mode === 'source') Object.assign(dep, { source: { ...source, sha256: 'e'.repeat(64) } });
      if (mode === 'node') Object.assign(association, { node: { start: 8, end: 14 } });
      if (mode === 'query') Object.assign(association, { queryId: 'unknown' });
      if (mode === 'queryId') Object.assign(dep, { queryId: 'allowances' });
      if (mode === 'role') Object.assign(dep, { role: 'data' });
      if (mode === 'type') Object.assign(dep, { type: 'QueryModel.Input[]' });
      if (mode === 'field') Object.assign(dep, { field: 'held' });
      if (mode === 'collision') Object.assign(dep, { id: 'account-control' });
      if (mode === 'missing-sites') delete (producer as { executionSites?: unknown }).executionSites;
      if (mode === 'owner') Object.assign(sites[0]!, { owner: ROOT });
      if (mode === 'open') Object.assign(association, { extra: true });
      if (mode === 'accessor') Object.defineProperty(association, 'node', { enumerable: true, get: () => { accesses++; return { start: 12, end: 14 }; } });
    } }), refuses, mode);
    assert.equal(accesses, 0);
  }
});


test('execution-only first Contract Require accepts independent scalar and void results without Model-result authority', async () => {
  for (const type of ['bool', 'void'] as const) {
    const w = await world({ absenceResult: true, executionContract: true, guardOnlyQuery: true, scalarResult: type });
    let receipt: Receipt | undefined, reads = 0;
    const request = { ...w, envelope: makeEnvelope(CHILD, uuidv7(FIXED_NOW, ++sequence), {}),
      observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
        const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
        const query = await executeScenarioReceiptQuery(call, w.store, { queryId: 'allowances', predicate: ({ slot, record }) => {
          const account = record.data.account;
          observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: 'account-control' });
          return account === 'caller';
        } });
        const row = await selectScenarioReceiptQueryFirstRow(call, w.store, { query: query.query }); assert.ok(row);
        const input = row.data.input; reads++;
        await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'require-input', model: ALLOWANCE, row, field: 'input' });
        assert.deepEqual(input, { title: 'Reviewed', facts: ['first', 'first', 'last'] });
        selectScenarioReceiptReturn(call, w.store, 'child-return');
        return { ...await session.finalize(), result: type === 'bool' ? true : null, outbox: [] };
      } };
    const outcome = await invoke(request); assert.equal(outcome.status, 'committed'); assert.ok(receipt);
    assert.equal(outcome.result, type === 'bool' ? true : null);
    const saved = readScenarioReceiptAssociation(receipt)!;
    assert.deepEqual(saved.observations, []); assert.equal(saved.queries, undefined);
    w.access.input = false;
    assert.equal((await projectScenarioReceipt({ ...w, receipt })).result, type === 'bool' ? true : null);
    assert.equal((await invoke(request)).status, 'replayed'); assert.equal(reads, 1);
  }
});
