/** Finite owning contained-query State controls. Handbound producer only; original
 * Compiler/native/application qualification remains separately owned. */
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
import { loadArtifactDescriptors, isGeneratedOperationDef, IncompatibleArtifactError, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptCallProducer, invokeScenarioReceiptCall,
  bindScenarioReceiptQueryProducer, executeScenarioReceiptQuery, observeScenarioReceiptQueryDependency,
  bindScenarioReceiptQueryCount, bindScenarioReceiptQueryResult,
  bindScenarioReceiptReferenceProducer, bindScenarioReceiptModelResult, selectScenarioReceiptReturn, observeScenarioReceiptDependency,
  readScenarioReceiptAssociation, projectScenarioReceipt } from '../../src/invocation/scenario-receipt.js';
import { asId, asModel, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, makeRow, uuidv7 } from './fixtures.js';

const PARENT = asModel('QueryContainedParent.Branch');
const TURN = asModel('QueryContainedParent.Turn'), RUN = asModel('QueryContainedParent.Run');
const ROOT = 'QueryContainedParent.start', CHILD = 'QueryContainedParent.reserve', APP = 'query-contained-parent-components', TEAM = 'query-contained-parent-team';
const CREATED = asId('created-run'), cause = { cause: 'scenario' } as const, bounds = { maxRows: 10, maxWork: 1000 };
const source = { path: 'query-contained-parent.can', sha256: 'd'.repeat(64), module: 'query-contained-parent.mjs' };
let sequence = 97_000;
function artifact(stored = false): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="QueryContainedParent.start";', map: {
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
    operations: [ROOT, CHILD].map(name => ({ name, kind: 'scenario' as const, description: '', inputs: { fields: [{ name: stored ? 'anchor' : 'branch', field: { kind: 'ref' as const, model: stored ? TURN : PARENT, requireVersion: true }, required: true }] },
      result: { type: RUN as CanTypeId, disclosure: { version: 1 as const, source,
        ...(name === CHILD ? { queries: [{ id: 'turns', source, model: TURN,
          parent: { source, model: PARENT, origin: stored ? { kind: 'stored-reference' as const, dependencyId: 'anchor-parent' } : { kind: 'admitted-reference' as const, parameter: 'branch' } },
          order: [{ field: 'id', direction: 'asc' as const }], limit: null, archived: 'exclude' as const,
          dependencies: [{ id: 'account-control', source, role: 'control' as const, field: 'account', type: 'text' as CanTypeId }],
        }] } : {}),
        returns: [{ id: name === ROOT ? 'root-return' : 'child-return', source,
          dependencies: name === CHILD && stored ? [{ id: 'anchor-parent', source, role: 'data' as const, model: TURN, field: 'parent', type: PARENT as CanTypeId }] : [],
          influences: name === CHILD ? (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
            .map(kind => ({ id: kind, kind, queryId: 'turns' })) : [],
        }],
      } } })),
  };
}
async function world(options: { domain?: 'empty' | 'false' | undefined; stored?: boolean } = {}) {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const caller = await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false, roles: [] });
  const reader = await memberships.createMembership({ team_id: TEAM, user_id: 'turn-reader', is_owner: false, roles: [] });
  const parentReader = await memberships.createMembership({ team_id: TEAM, user_id: 'parent-reader', is_owner: false, roles: [] });
  const store = createMemoryStorage(), loaded = loadArtifactDescriptors(
    artifact(options.stored), { by: 'members' });
  const root = loaded.registry.get(ROOT), child = loaded.registry.get(CHILD);
  assert.ok(root && isGeneratedOperationDef(root)); assert.ok(child && isGeneratedOperationDef(child));
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment });
  const rows: StoredRow[] = [];
  for (const id of ['branch-a', 'branch-b']) {
    const row = makeRow({ id, data: { title: id } });
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: PARENT, row }] }));
  }
  for (const [id, account, held] of [
    ['turn-c', 'caller', '20'], ['turn-a', 'caller', '7'], ['turn-b', 'other', '100'],
  ] as const) {
    const row: StoredRow = { ...makeRow({ id, data: { account: options.domain === 'false' ? 'other' : account, held } }), parent: { model: PARENT, id: asId(options.domain === 'empty' || id === 'turn-c' ? 'branch-b' : 'branch-a') } };
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: TURN, row }] }));
    const stored = await store.load(TURN, row.id); assert.ok(stored); rows.push(stored);
  }
  const scans: Parameters<typeof store.query>[0][] = [];
  const query = store.query; store.query = async spec => { scans.push(spec); return query(spec); };
  const access = { turn: true, run: true, parent: true };
  const policy = buildPolicyTable([
    { model: PARENT, secretFields: [], grants: [{ by: 'members', fields: ['title'] }] },
    { model: TURN, secretFields: [], grants: [{ by: 'members', fields: ['account', 'held', 'position'] }] },
    { model: RUN, secretFields: [], grants: [{ by: 'members', fields: ['account', 'title'] }] },
  ], loaded.models);
  const readPolicies = new Map<ModelName, ViewerSourceReadPolicy>();
  for (const [model, fields] of [[TURN, ['account', 'held', 'position']], [RUN, ['account', 'title']], [PARENT, ['title']]] as const) {
    readPolicies.set(model, { ...(model === TURN ? { parent: PARENT } : {}), fields: [...fields],
      secretFields: [], grants: [{ fields: ['id', ...fields], read: async ({ context }) =>
      (model === TURN ? access.turn : model === PARENT ? access.parent : access.run) &&
      (await context.memberships.findMembership(TEAM, model === TURN ? 'turn-reader' : model === PARENT ? 'parent-reader' : 'caller'))?.status === 'active' &&
      context.membership?.status === 'active',
    }] });
  }
  for (const def of [root, child]) bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  bindScenarioReceiptQueryProducer(child, { source, app: APP, policy });
  return { store, memberships, caller, reader, parentReader, root, child, table, policy, access, readPolicies, rows, scans,
    stored: options.stored === true, registry: loaded.registry, app: APP, source: 'component', clock: { nowMs: () => FIXED_NOW },
    identity: makeIdentity({ membership: caller }), envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), options.stored ? { anchor: { id: 'turn-a', version: '1' } } : { branch: { id: 'branch-a', version: '1' } }) };
}
type World = Awaited<ReturnType<typeof world>>;
type Session = Awaited<ReturnType<typeof beginScenarioReceiptMutation>>;
type Query = Awaited<ReturnType<typeof executeScenarioReceiptQuery>>;
type QueryHook = (call: AdmittedCall, session: Pick<Session, 'stage' | 'read' | 'views'>, query: Query) => Promise<void>;
const refuses = (error: unknown) => error instanceof StateError;
type ParentMode = 'normal' | 'missing' | 'old-stage' | 'copied-call' | 'foreign-store' | 'ambiguous' | 'arbitrary-parent';
function bindChild(w: World, mode: ParentMode = 'normal', hook?: QueryHook) {
  let executions = 0, predicates = 0, captured: Query | undefined;
  bindScenarioReceiptCallProducer(w.root, { source, app: APP, registry: w.registry,
    sites: [{ id: 'reserve-site', source, kind: 'operation', targets: [{ operation: CHILD, interface: w.child.descriptor }],
      resultType: RUN as CanTypeId }], prepare: (_def, inputs) => inputs as ClosedInputs,
    execute: async frame => {
      executions++;
      if (w.stored && mode !== 'missing') {
        const anchor = await frame.session.read(TURN, asId('turn-a')); assert.ok(anchor);
        await observeScenarioReceiptDependency(frame.call, w.store, { dependencyId: 'anchor-parent', model: TURN, row: anchor, field: 'parent' });
        if (mode === 'ambiguous') await observeScenarioReceiptDependency(frame.call, w.store, { dependencyId: 'anchor-parent', model: TURN, row: anchor, field: 'parent' });
        if (mode === 'old-stage') await frame.session.stage({ op: 'update', model: TURN, id: anchor.id, data: { held: '8' } }, cause);
      }
      const queryInput = { queryId: 'turns', ...(mode === 'arbitrary-parent' ? { parent: { model: PARENT, id: 'branch-b' } } : {}), predicate: ({ slot, record }: Parameters<Parameters<typeof executeScenarioReceiptQuery>[2]['predicate']>[0]) => {
        predicates++; const account = record.data.account;
        observeScenarioReceiptQueryDependency(frame.call, w.store, { slot, dependencyId: 'account-control' });
        return account === 'caller';
      } };
      const result = await executeScenarioReceiptQuery(mode === 'copied-call' ? { ...frame.call } : frame.call,
        mode === 'foreign-store' ? { ...w.store } : w.store, queryInput);
      captured = result;
      const count = await bindScenarioReceiptQueryCount(frame.call, w.store, { query: result.query });
      await hook?.(frame.call, frame.session, result);
      await frame.session.stage({ op: 'create', model: RUN, id: CREATED,
        data: { account: 'caller', title: count.toString() } }, cause);
      const row = await frame.session.read(RUN, CREATED); assert.ok(row);
      const wire = await bindScenarioReceiptModelResult(frame.call, w.store, { returnId: 'child-return', row });
      selectScenarioReceiptReturn(frame.call, w.store, 'child-return'); return wire;
    } });
  return { get executions() { return executions; }, get predicates() { return predicates; }, get captured() { return captured; } };
}
async function child(call: AdmittedCall, w: World) {
  return invokeScenarioReceiptCall(call, w.store, { site: 'reserve-site', target: CHILD, inputs: w.stored ? { anchor: { id: 'turn-a', version: '1' } } : { branch: { id: 'branch-a', version: '1' } } });
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

test('contained admitted parent scopes the first owner scan and saves true/false/empty complete count domains', async () => {
  for (const domain of [undefined, 'false', 'empty'] as const) {
    const w = await world({ domain }), producer = bindChild(w); let receipt: Receipt | undefined;
    const request = input(w, value => { receipt = value; });
    assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
    const query = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!.queries![0]!;
    const expected = domain === 'empty' ? [] : ['turn-a', 'turn-b'];
    assert.deepEqual(query.candidates.map(candidate => candidate.row.id), expected);
    assert.deepEqual(query.selectedIndices.map(index => query.candidates[index]!.row.id), domain === undefined ? ['turn-a'] : []);
    assert.equal(producer.predicates, expected.length);
    const ownerScan = w.scans.find(scan => scan.model === TURN && scan.authority === 'owner'); assert.ok(ownerScan);
    assert.deepEqual(ownerScan.parent, { model: PARENT, id: 'branch-a' });
    assert.ok(query.parent); assert.equal(query.parent.model, PARENT);
    assert.equal(query.parent.row.id, 'branch-a'); assert.deepEqual(query.parent.row.data, { title: 'branch-a' });
    assert.deepEqual(query.parent.secretFields, []);
    assert.equal((await w.store.load(RUN, CREATED))!.data.title, domain === undefined ? '1' : '0');
    assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
    const retained = structuredClone(receipt);
    assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.executions, 1);
    assert.equal(producer.predicates, expected.length); assert.deepEqual(receipt, retained);
  }
});

test('stored parent consumes the same-stage genuine observation before count and retains it across later own writes', async () => {
  const w = await world({ stored: true });
  const producer = bindChild(w, 'normal', async (_call, session) => {
    await session.stage({ op: 'update', model: TURN, id: asId('turn-a'), data: { held: '8' } }, cause);
    await session.stage({ op: 'update', model: PARENT, id: asId('branch-a'), data: { title: 'Changed after count' } }, cause);
  });
  let receipt: Receipt | undefined;
  assert.equal((await invoke(input(w, value => { receipt = value; }))).status, 'committed'); assert.ok(receipt);
  const saved = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!;
  assert.equal(saved.observations.filter(entry => entry.dependencyId === 'anchor-parent').length, 1);
  assert.equal(saved.queries![0]!.parent!.row.data.title, 'branch-a');
  assert.equal((await w.store.load(RUN, CREATED))!.data.title, '1'); assert.equal(producer.predicates, 2);
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
});

test('stored missing/ambiguous/old-stage observations and copied call or foreign store refuse with no writes', async () => {
  for (const mode of ['missing', 'ambiguous', 'old-stage', 'copied-call', 'foreign-store', 'arbitrary-parent'] as const) {
    const w = await world({ stored: true }); bindChild(w, mode);
    await assert.rejects(invoke(input(w)), refuses); await unchanged(w);
  }
});

test('source, ancestor, membership and parent lifetime loss close commit and saved disclosure including empty domains', async () => {
  for (const domain of [undefined, 'empty'] as const) for (const loss of (domain === 'empty'
    ? ['ancestor', 'membership', 'lifetime'] as const : ['source', 'ancestor', 'membership', 'lifetime'] as const)) {
    const revoke = async (w: World) => {
      if (loss === 'source') w.access.turn = false;
      else if (loss === 'ancestor') w.access.parent = false;
      else if (loss === 'membership') await w.memberships.removeMembership(w.parentReader.membership_id);
      else {
        const row = await w.store.load(PARENT, asId('branch-a')); assert.ok(row);
        await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'update', model: PARENT,
          id: row.id, expectedVersion: row.version, row: { ...row, archivedAt: FIXED_NOW } }] }));
      }
    };
    const failed = await world({ domain }); bindChild(failed);
    await assert.rejects(invoke(input(failed, undefined, async () => revoke(failed))), refuses); await unchanged(failed);
    const w = await world({ domain }), producer = bindChild(w); let receipt: Receipt | undefined;
    const request = input(w, value => { receipt = value; }); await invoke(request); assert.ok(receipt);
    await revoke(w);
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
    assert.equal((await invoke(request)).status, 'replayed'); assert.equal(producer.executions, 1);
  }
});

test('saved count keeps its original domain after legitimate parent data update and new children', async () => {
  const w = await world(); bindChild(w); let receipt: Receipt | undefined;
  await invoke(input(w, value => { receipt = value; })); assert.ok(receipt);
  const row = await w.store.load(PARENT, asId('branch-a')); assert.ok(row);
  await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'update', model: PARENT,
    id: row.id, expectedVersion: row.version, row: { ...row, data: { title: 'Current title' } } }] }));
  await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'insert', model: TURN,
    row: { ...makeRow({ id: 'new-child', data: { account: 'caller', held: '50' } }), parent: { model: PARENT, id: row.id } } }] }));
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
  const saved = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!.queries![0]!;
  assert.equal(saved.parent!.row.data.title, 'branch-a'); assert.equal(saved.selectedIndices.length, 1);
});

test('saved query rejects missing/foreign/unscoped parent witness and candidate-parent mismatch', async () => {
  for (const domain of [undefined, 'empty'] as const) {
    const w = await world({ domain }); bindChild(w); let receipt: Receipt | undefined;
    await invoke(input(w, value => { receipt = value; })); assert.ok(receipt);
    for (const mode of ['missing', 'foreign', 'wrong-model', 'unscoped', ...(domain === undefined ? ['candidate'] : [])]) {
      const altered: Receipt = structuredClone(receipt); assert.equal(altered.outcome.status, 'committed');
      if (altered.outcome.status !== 'committed') throw new Error('Expected committed receipt');
      const saved = altered.outcome.scenario!.calls![0]!.scenario!, query = saved.queries![0]!;
      if (mode === 'missing') Reflect.deleteProperty(query, 'parent');
      if (mode === 'foreign') Reflect.set(query.parent!.row, 'id', 'branch-b');
      if (mode === 'wrong-model') Reflect.set(query.parent!, 'model', RUN);
      if (mode === 'unscoped') Reflect.deleteProperty(saved.plan.queries![0]!, 'parent');
      if (mode === 'candidate') {
        Reflect.set(query.candidates[0]!.row, 'parent', { model: PARENT, id: 'branch-b' });
        Reflect.set(query.candidates[0]!.record, 'parent', { model: PARENT, id: 'branch-b' });
      }
      if (mode === 'foreign' && domain === 'empty') {
        // A structurally valid admitted empty witness needs the exact durable
        // retained association, which the transport reader cannot authenticate.
        await assert.rejects(projectScenarioReceipt({ ...w, receipt: altered }), refuses);
      } else assert.throws(() => readScenarioReceiptAssociation(altered), refuses);
    }
  }
});

test('stored query parent witness remains tied to its canonical prior dependency even when candidate links are swapped', async () => {
  const w = await world({ stored: true }); bindChild(w); let receipt: Receipt | undefined;
  await invoke(input(w, value => { receipt = value; })); assert.ok(receipt);
  const altered: Receipt = structuredClone(receipt); assert.equal(altered.outcome.status, 'committed');
  if (altered.outcome.status !== 'committed') throw new Error('Expected committed receipt');
  const query = altered.outcome.scenario!.calls![0]!.scenario!.queries![0]!;
  Reflect.set(query.parent!.row, 'id', 'branch-b');
  for (const candidate of query.candidates) {
    Reflect.set(candidate.row, 'parent', { model: PARENT, id: 'branch-b' });
    Reflect.set(candidate.record, 'parent', { model: PARENT, id: 'branch-b' });
  }
  assert.throws(() => readScenarioReceiptAssociation(altered), refuses);
});

test('loader rejects wrong parent source/model/parameter/dependency and shadowed scope declarations', () => {
  for (const stored of [false, true]) for (const mode of ['source', 'model', 'origin', 'nullable', 'unversioned', 'wrong-input-model', 'shadowed']) {
    const slice = artifact(stored), child = slice.operations!.find(operation => operation.name === CHILD)!;
    const parent = child.result!.disclosure!.queries![0]!.parent!;
    if (mode === 'source') Reflect.set(parent, 'source', { ...source, sha256: 'e'.repeat(64) });
    if (mode === 'model') Reflect.set(parent, 'model', RUN);
    if (mode === 'origin') Reflect.set(parent.origin, stored ? 'dependencyId' : 'parameter', 'absent');
    if (mode === 'nullable') {
      if (stored) Reflect.set(child.result!.disclosure!.returns[0]!.dependencies[0]!, 'type', `${PARENT}?`);
      else Reflect.set(child.inputs.fields[0]!, 'required', false);
    }
    if (mode === 'unversioned') {
      if (stored) Reflect.set(child.result!.disclosure!.returns[0]!.dependencies[0]!, 'type', `${PARENT}[]`);
      else Reflect.set(child.inputs.fields[0]!.field, 'requireVersion', false);
    }
    if (mode === 'wrong-input-model') {
      if (stored) Reflect.set(child.result!.disclosure!.returns[0]!.dependencies[0]!, 'model', RUN);
      else Reflect.set(child.inputs.fields[0]!.field, 'model', RUN);
    }
    if (mode === 'shadowed') slice.models!.find(model => model.name === TURN)!.fields.push({ name: 'parent',
      field: { kind: 'ref', model: PARENT }, required: true, serverOnly: false, valueType: PARENT as CanTypeId });
    assert.throws(() => loadArtifactDescriptors(slice, { by: 'members' }), error => error instanceof IncompatibleArtifactError);
  }
});

test('late outer rejection rolls back scoped count-dependent child and root effects', async () => {
  const w = await world({ stored: true }); bindChild(w, 'normal', async (_call, session) => {
    await session.stage({ op: 'update', model: TURN, id: asId('turn-a'), data: { held: '8' } }, cause);
  });
  await assert.rejects(invoke(input(w, undefined, async () => { throw new StateError('rule_failed', 'Late parent refusal'); })),
    error => error instanceof StateError && error.code === 'rule_failed');
  await unchanged(w); assert.deepEqual(await w.store.historyFor(TURN, asId('turn-a')), []);
});

test('contained contract-array projection attributes business data only to selected rows and rechecks its current grant without predicate replay', async () => {
  const w = await world(), slice = artifact();
  const root = slice.operations!.find(operation => operation.name === ROOT)!;
  const checkedQuery = slice.operations!.find(operation => operation.name === CHILD)!.result!.disclosure!.queries![0]!;
  slice.operations = [root];
  slice.valueTypes = { contracts: [{ name: 'ContainedFact', fields: [
    { name: 'turn', type: TURN as CanTypeId }, { name: 'version', type: 'int' as CanTypeId },
    { name: 'held', type: 'text' as CanTypeId },
  ] }] };
  root.result = { type: 'ContainedFact[]' as CanTypeId, disclosure: { version: 1, source,
    queries: [{ ...checkedQuery, dependencies: [...checkedQuery.dependencies,
      { id: 'held-data', source, role: 'data', field: 'held', type: 'text' as CanTypeId }] }],
    returns: [{ id: 'facts-return', source, dependencies: [],
      influences: (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
        .map(kind => ({ id: kind, kind, queryId: 'turns' })),
      projection: { kind: 'query-contract-array', queryId: 'turns', source, fields: [
        { name: 'turn', kind: 'reference' }, { name: 'version', kind: 'version' },
        { name: 'held', kind: 'field', field: 'held' },
      ] },
    }],
  } };
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const def = loaded.registry.get(ROOT); assert.ok(def && isGeneratedOperationDef(def));
  const policy = buildPolicyTable([
    { model: PARENT, secretFields: [], grants: [{ by: 'members', fields: ['title'] }] },
    { model: TURN, secretFields: [], grants: [
      { by: 'members', fields: ['account', 'position'] },
      { by: 'members', fields: ['held'], when: { op: 'eq', field: 'id', value: 'turn-a' } },
    ] },
    { model: RUN, secretFields: [], grants: [{ by: 'members', fields: ['account', 'title'] }] },
  ], loaded.models);
  let heldVisible = true, executions = 0, predicates = 0;
  const readPolicies = new Map(w.readPolicies);
  readPolicies.set(TURN, { parent: PARENT, fields: ['account', 'held', 'position'], secretFields: [], grants: [
    { fields: ['id', 'account', 'position'], read: async ({ context }) => w.access.turn &&
      (await context.memberships.findMembership(TEAM, 'turn-reader'))?.status === 'active' && context.membership?.status === 'active' },
    { fields: ['held'], read: async ({ row }) => heldVisible && row.id === 'turn-a' },
  ] });
  bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  bindScenarioReceiptQueryProducer(def, { source, app: APP, policy });
  let receipt: Receipt | undefined;
  const request = { ...w, registry: loaded.registry, policy, readPolicies,
    observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
      executions++;
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      const query = await executeScenarioReceiptQuery(call, w.store, { queryId: 'turns', predicate: ({ slot, record }) => {
        predicates++; const account = record.data.account;
        observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: 'account-control' });
        return account === 'caller';
      } });
      assert.deepEqual(query.rows.map(entry => entry.record.id), ['turn-a']);
      const wire = query.rows.map(({ record }) => ({ turn: { id: record.id, version: String(record.version) },
        version: String(record.version), held: record.data.held }));
      bindScenarioReceiptQueryResult(call, w.store, { query: query.query, returnId: 'facts-return', wire,
        rows: query.rows.map(entry => entry.slot) });
      selectScenarioReceiptReturn(call, w.store, 'facts-return');
      return { ...await session.finalize(), result: wire, outbox: [] };
    } };
  const expected = [{ turn: { id: 'turn-a', version: '1' }, version: '1', held: '7' }];
  const result = await invoke(request); assert.equal(result.status, 'committed'); assert.deepEqual(result.result, expected); assert.ok(receipt);
  const saved = readScenarioReceiptAssociation(receipt)!.queries![0]!;
  assert.deepEqual(saved.candidates.map(candidate => candidate.row.id), ['turn-a', 'turn-b']);
  const rejected = saved.candidates.find(candidate => candidate.row.id === 'turn-b')!;
  assert.equal(rejected.matched, false); assert.equal(Object.hasOwn(rejected.record.data, 'held'), false);
  assert.deepEqual(rejected.dependencies, ['account-control']);
  assert.ok(saved.candidates.find(candidate => candidate.row.id === 'turn-a')!.dependencies.includes('held-data'));
  assert.deepEqual((await projectScenarioReceipt({ ...request, receipt })).result, expected);
  heldVisible = false;
  assert.deepEqual(await projectScenarioReceipt({ ...request, receipt }), { result: null, records: [] });
  assert.equal((await invoke(request)).status, 'replayed'); assert.equal(executions, 1); assert.equal(predicates, 2);
});
