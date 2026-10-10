/** Finite State defining controls using genuine Values, MemoryStorage and
 * invoke's existing owner frame. These do not qualify generated Compiler code. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ClosedInputs, Receipt, StoredRow } from '@canlang/contracts';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildModelTable } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { invoke, type ExecutionEffects } from '../../src/invocation/invoke.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptCallProducer, bindScenarioReceiptQueryProducer,
  invokeScenarioReceiptCall, executeScenarioReceiptQuery, observeScenarioReceiptQueryDependency,
  bindScenarioReceiptQueryResult, selectScenarioReceiptReturn, readScenarioReceiptAssociation,
  projectScenarioReceipt } from '../../src/invocation/scenario-receipt.js';
import { FIXED_NOW, asModel, createMemoryIdentityStore, makeEnvelope, makeIdentity, seedMember, seedRow, uuidv7 } from './fixtures.js';
import { field, modelDef } from '../mutation/fixtures.js';

const MODEL = asModel('Query.Task'), ROOT = 'Query.review', READ = 'Query.facts';
const APP = 'owner-query-app', bounds = { maxRows: 10, maxWork: 1000 }, cause = { cause: 'scenario' } as const;
let sequence = 90_000;
const source = () => ({ path: 'query.can', sha256: '9'.repeat(64), module: 'query.mjs' });
const stateError = (error: unknown) => error instanceof StateError;
const empty = (): ExecutionEffects => ({ result: null, writes: [], history: [], outbox: [], schedules: [],
  uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {} });
function disclosure() {
  return { version: 1 as const, source: source(), queries: [{ id: 'tasks', source: source(), model: MODEL,
    order: [{ field: 'key', direction: 'asc' as const }], limit: null, archived: 'exclude' as const,
    dependencies: [
      { id: 'done-control', source: source(), role: 'control' as const, field: 'done', type: 'bool' as CanTypeId },
      { id: 'key-order', source: source(), role: 'control' as const, field: 'key', type: 'text' as CanTypeId },
      { id: 'key-data', source: source(), role: 'data' as const, field: 'key', type: 'text' as CanTypeId },
    ],
  }], returns: [{ id: 'facts-return', source: source(), dependencies: [],
    influences: (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
      .map(kind => ({ id: kind, kind, queryId: 'tasks' })),
    projection: { kind: 'query-contract-array' as const, queryId: 'tasks', source: source(), fields: [
      { name: 'task', kind: 'reference' as const }, { name: 'version', kind: 'version' as const },
      { name: 'key', kind: 'field' as const, field: 'key' },
    ] },
  }] };
}
function artifact(child = false): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: 'query.can', sha256: '9'.repeat(64) }],
    modules: [{ path: 'query.mjs', js: 'export const identity="Query.review";', map: {
      version: 3, file: 'query.mjs', sources: ['query.can'], sourcesContent: [null], names: [], mappings: '',
    } }],
    callables: [ROOT, ...(child ? [READ] : [])].map(id => ({ id, kind: 'operation' as const,
      module: 'query.mjs', export: 'identity', member: [id.split('.').at(-1)!] })),
    valueTypes: { contracts: [{ name: 'Fact', fields: [
      { name: 'task', type: MODEL as CanTypeId }, { name: 'version', type: 'int' as CanTypeId },
      { name: 'key', type: 'text' as CanTypeId },
    ] }] },
    models: [{ name: MODEL, deleteMode: 'archive', fields: [
      { name: 'key', field: { kind: 'string' }, required: true, serverOnly: false },
      { name: 'done', field: { kind: 'boolean' }, required: true, serverOnly: false },
      { name: 'approved', field: { kind: 'boolean' }, required: false, serverOnly: false },
    ] }],
    operations: [{ name: ROOT, kind: 'scenario', description: '', inputs: { fields: [] },
      result: { type: (child ? 'void' : 'Fact[]') as CanTypeId, disclosure: child
        ? { version: 1, source: source(), returns: [{ id: 'root-return', source: source(), dependencies: [], influences: [] }] }
        : disclosure() } }, ...(child ? [{ name: READ, kind: 'read' as const, description: '', inputs: { fields: [] },
      result: { type: 'Fact[]' as CanTypeId, disclosure: disclosure() } }] : [])],
  };
}
async function world(options: { child?: boolean; empty?: boolean } = {}) {
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const slice = artifact(options.child), loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const parent = loaded.registry.get(ROOT); assert.ok(parent && isGeneratedOperationDef(parent));
  const read = loaded.registry.get(READ);
  if (options.child) assert.ok(read && isGeneratedOperationDef(read));
  const rows: StoredRow[] = options.empty ? [] : await Promise.all([
    seedRow(store, MODEL, { id: 'task-c', data: { key: 'c', done: true, approved: false } }),
  ]);
  if (!options.empty) {
    rows.push(await seedRow(store, MODEL, { id: 'task-a', data: { key: 'a', done: true, approved: false } }));
    rows.push(await seedRow(store, MODEL, { id: 'task-b', data: { key: 'b', done: false, approved: false } }));
  }
  const table = buildModelTable([modelDef(MODEL, { fields: { key: field({ required: true }),
    done: field({ required: true }), approved: field({ default: false }) } })]);
  const policy = buildPolicyTable([{ model: MODEL, secretFields: [], grants: [{ by: 'members', fields: ['key', 'done', 'approved'] }] }]);
  const queryDef = options.child ? read : parent;
  assert.ok(queryDef && isGeneratedOperationDef(queryDef));
  bindScenarioReceiptQueryProducer(queryDef, { source: source(), app: APP, policy });
  return { store, memberships, member, identity, parent, read, table, rows, policy, registry: loaded.registry,
    app: APP, source: 'test', clock: { nowMs: () => FIXED_NOW },
    envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {}) };
}
type World = Awaited<ReturnType<typeof world>>;
type Query = Awaited<ReturnType<typeof executeScenarioReceiptQuery>>;
function wire(rows: Query['rows']) {
  return rows.map(({ record }) => {
    const key = record.data['key']; assert.ok(typeof key === 'string');
    return { task: { id: record.id, version: String(record.version) }, version: String(record.version), key };
  });
}
async function query(call: AdmittedCall, w: World, seen: string[] = []) {
  return executeScenarioReceiptQuery(call, w.store, { queryId: 'tasks', predicate: async ({ slot, record }) => {
    seen.push(record.id);
    observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: 'done-control' });
    observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: 'key-order' });
    return record.data['done'] === true;
  } });
}
function select(call: AdmittedCall, w: World, result: Query, value = wire(result.rows), slots = result.rows.map(row => row.slot)) {
  bindScenarioReceiptQueryResult(call, w.store, { query: result.query, returnId: 'facts-return', wire: value, rows: slots });
  selectScenarioReceiptReturn(call, w.store, 'facts-return');
  return value;
}
async function domain(w: World) { return { rows: await w.store.query({ model: MODEL, authority: 'owner', limit: 10 }),
  history: await Promise.all(w.rows.map(row => w.store.historyFor(MODEL, row.id))), outbox: await w.store.outboxPending() }; }

for (const vacant of [false, true]) test(`actual ordered query retains ${vacant ? 'empty domain' : 'false predicate candidates'} and replays without predicate evaluation`, async () => {
  const w = await world({ empty: vacant }), seen: string[] = []; let receipt: Receipt | undefined, executions = 0;
  const input = { ...w, execute: async (call: AdmittedCall) => {
    executions++; const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const result = await query(call, w, seen);
    assert.equal(result.count, vacant ? 0 : 2);
    assert.deepEqual(result.rows.map(row => row.record.id), vacant ? [] : ['task-a', 'task-c']);
    const value = select(call, w, result);
    if (!vacant) await session.stage({ op: 'update', model: MODEL, id: w.rows[0]!.id, data: { approved: true } }, cause);
    const final = await session.finalize();
    return { ...final, outbox: final.outbox ?? [], result: value };
  }, observeCommittedReceipt: (value: Receipt) => { receipt = value; } };
  assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt);
  assert.equal(seen.length, vacant ? 0 : 3); assert.equal(new Set(seen).size, seen.length);
  const saved = readScenarioReceiptAssociation(receipt)!.queries!;
  assert.equal(saved.length, 1); assert.equal(saved[0]!.candidates.length, vacant ? 0 : 3);
  if (!vacant) {
    assert.equal(saved[0]!.candidates.find(item => item.row.id === 'task-b')!.matched, false);
    for (const candidate of saved[0]!.candidates) {
      assert.ok(candidate.dependencies.includes('done-control'));
      assert.ok(candidate.dependencies.includes('key-order'));
    }
  }
  const before = await domain(w), retained = receipt;
  assert.equal((await invoke(input)).status, 'replayed'); assert.equal(executions, 1);
  assert.equal(seen.length, vacant ? 0 : 3); assert.deepEqual(receipt, retained); assert.deepEqual(await domain(w), before);
  assert.ok(receipt.outcome.status === 'committed');
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, receipt.outcome.result);
  const hidden = buildPolicyTable([{ model: MODEL, secretFields: [], grants: [{ by: 'members', fields: ['key', 'approved'] }] }]);
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt, policy: hidden }), { result: null, records: [] });
});

for (const mode of ['copy-slot', 'foreign-slot', 'count', 'order', 'reference', 'reference-version', 'version', 'scalar', 'copy-query'] as const)
  test(`caught ${mode} query result fabrication poisons the complete owner transaction`, async () => {
    const w = await world(), before = await domain(w);
    let foreignSlot: object | undefined;
    if (mode === 'foreign-slot') {
      const other = await world();
      await invoke({ ...other, execute: async call => {
        const session = await beginScenarioReceiptMutation(call, other.store, { table: other.table, bounds });
        const result = await query(call, other); foreignSlot = result.rows[0]!.slot;
        const value = select(call, other, result);
        const final = await session.finalize();
        return { ...final, outbox: final.outbox ?? [], result: value };
      } });
      assert.ok(foreignSlot);
    }
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await session.stage({ op: 'update', model: MODEL, id: w.rows[0]!.id, data: { approved: true } }, cause);
      const result = await query(call, w), value = wire(result.rows), slots = result.rows.map(row => row.slot);
      if (mode === 'copy-slot') slots[0] = { ...slots[0] };
      if (mode === 'foreign-slot') slots[0] = foreignSlot!;
      if (mode === 'count') { value.pop(); slots.pop(); }
      if (mode === 'order') { value.reverse(); slots.reverse(); }
      if (mode === 'reference') value[0]!.task.id = w.rows.find(row => row.id === 'task-b')!.id;
      if (mode === 'version') value[0]!.version = '999';
      if (mode === 'reference-version') value[0]!.task.version = '999';
      if (mode === 'scalar') value[0]!.key = 'fabricated';
      assert.throws(() => bindScenarioReceiptQueryResult(call, w.store, { query: mode === 'copy-query' ? { ...result.query } : result.query,
        returnId: 'facts-return', wire: value, rows: slots }), stateError);
      await assert.rejects(session.finalize(), stateError); return empty();
    } }), stateError);
    assert.deepEqual(await domain(w), before);
  });

for (const revoke of [false, true]) test(`${revoke ? 'current membership revocation' : 'post-query require failure'} rolls back parent mutations without replaying predicates`, async () => {
  const w = await world(), before = await domain(w), seen: string[] = [];
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await session.stage({ op: 'update', model: MODEL, id: w.rows[0]!.id, data: { approved: true } }, cause);
    const value = select(call, w, await query(call, w, seen));
    if (revoke) await w.memberships.removeMembership(w.member.membership.membership_id);
    else throw new StateError('rule_failed', 'Post-query workflow requirement failed.');
    const final = await session.finalize();
    return { ...final, outbox: final.outbox ?? [], result: value };
  } }), stateError);
  assert.equal(seen.length, 3); assert.deepEqual(await domain(w), before);
});

test('query result retains actual provisional reference and version before a later own write', async () => {
  const w = await world(); let receipt: Receipt | undefined;
  await invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const row = w.rows[0]!;
    await session.stage({ op: 'update', model: MODEL, id: row.id, data: { key: 'intermediate' } }, cause);
    const result = await query(call, w), value = select(call, w, result);
    const fact = value.find(item => item.task.id === row.id)!;
    assert.equal(fact.key, 'intermediate'); assert.equal(fact.version, String(row.version + 1));
    assert.equal(fact.task.version, fact.version);
    await session.stage({ op: 'update', model: MODEL, id: row.id, data: { key: 'final', approved: true } }, cause);
    const final = await session.finalize();
    return { ...final, outbox: final.outbox ?? [], result: value };
  }, observeCommittedReceipt: value => { receipt = value; } });
  assert.ok(receipt); assert.equal((await w.store.load(MODEL, w.rows[0]!.id))!.data['key'], 'final');
  const facts = (await projectScenarioReceipt({ ...w, receipt })).result as ReturnType<typeof wire>;
  assert.equal(facts.find(item => item.task.id === w.rows[0]!.id)!.key, 'intermediate');
  await w.memberships.createMembership({ team_id: w.member.team.team_id, user_id: w.member.user.user_id, is_owner: false, roles: [] });
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
});

for (const mode of ['copy-call', 'foreign-store', 'concurrent'] as const)
  test(`caught ${mode} query execution cannot escape the owner lifetime`, async () => {
    const w = await world(), before = await domain(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await session.stage({ op: 'update', model: MODEL, id: w.rows[0]!.id, data: { approved: true } }, cause);
      if (mode === 'concurrent') {
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const first = executeScenarioReceiptQuery(call, w.store, { queryId: 'tasks', predicate: async ({ slot }) => {
          observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: 'done-control' });
          observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: 'key-order' });
          entered(); await gate; return true;
        } });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([ready, first.then(() => { throw new Error('Query closed before its predicate entered.'); }),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Query predicate did not enter.')), 5000); })]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
        try { await assert.rejects(query(call, w), stateError); }
        finally { release(); }
        await Promise.allSettled([first]);
      } else await assert.rejects(executeScenarioReceiptQuery(mode === 'copy-call' ? { ...call } : call,
        mode === 'foreign-store' ? { ...w.store } : w.store, { queryId: 'tasks', predicate: async () => true }), stateError);
      await assert.rejects(session.finalize(), stateError); return empty();
    } }), stateError);
    assert.deepEqual(await domain(w), before);
  });

test('genuine same-owner read child returns its checked query closure and refuses staging', async () => {
  for (const illegalStage of [false, true]) {
    const w = await world({ child: true }), before = await domain(w); let child: AdmittedCall | undefined,
      savedQuery: Query | undefined, receipt: Receipt | undefined, reads = 0;
    assert.ok(w.read && isGeneratedOperationDef(w.read));
    bindScenarioReceiptCallProducer(w.parent, { source: source(), app: APP, registry: w.registry,
      sites: [{ id: 'facts-site', source: source(), kind: 'operation', targets: [
        { operation: READ, interface: w.read.descriptor },
      ], resultType: 'Fact[]' as CanTypeId }], prepare: (_def, inputs) => inputs as ClosedInputs,
      execute: async frame => {
        reads++; child = frame.call;
        if (illegalStage) {
          await assert.rejects(frame.session.stage({ op: 'update', model: MODEL, id: w.rows[0]!.id,
            data: { approved: true } }, cause), stateError);
          return [];
        }
        savedQuery = await query(frame.call, w);
        return select(frame.call, w, savedQuery);
      },
    });
    const input = { ...w, execute: async (call: AdmittedCall) => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await session.stage({ op: 'update', model: MODEL, id: w.rows[0]!.id, data: { approved: true } }, cause);
      if (illegalStage) {
        await assert.rejects(invokeScenarioReceiptCall(call, w.store, { site: 'facts-site', target: READ, inputs: {} }), stateError);
        await assert.rejects(session.finalize(), stateError); return empty();
      }
      const value = await invokeScenarioReceiptCall(call, w.store, { site: 'facts-site', target: READ, inputs: {} });
      assert.deepEqual((value as ReturnType<typeof wire>).map(item => item.key), ['a', 'c']);
      selectScenarioReceiptReturn(call, w.store, 'root-return');
      const final = await session.finalize();
      return { ...final, outbox: final.outbox ?? [], result: null };
    }, observeCommittedReceipt: (value: Receipt) => { receipt = value; } };
    if (illegalStage) {
      await assert.rejects(invoke(input), stateError); assert.deepEqual(await domain(w), before);
    } else {
      assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt);
      const retained = readScenarioReceiptAssociation(receipt)!.calls![0]!;
      assert.equal(retained.target, READ); assert.equal(retained.scenario!.queries![0]!.candidates.length, 3);
      assert.equal((await invoke(input)).status, 'replayed'); assert.equal(reads, 1);
      assert.ok(child && savedQuery);
      await assert.rejects(query(child, w), stateError);
      assert.throws(() => select(child!, w, savedQuery!), stateError);
      assert.throws(() => observeScenarioReceiptQueryDependency(child!, w.store, {
        slot: savedQuery!.rows[0]!.slot, dependencyId: 'done-control',
      }), stateError);
    }
  }
});

for (const mode of ['missing-control', 'wrong-dependency', 'copied-predicate-slot'] as const)
  test(`${mode} cannot certify predicate control even if its refusal is caught`, async () => {
    const w = await world(), before = await domain(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await session.stage({ op: 'update', model: MODEL, id: w.rows[0]!.id, data: { approved: true } }, cause);
      await assert.rejects(executeScenarioReceiptQuery(call, w.store, { queryId: 'tasks', predicate: async ({ slot }) => {
        observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: 'key-order' });
        if (mode !== 'missing-control') assert.throws(() => observeScenarioReceiptQueryDependency(call, w.store, {
          slot: mode === 'copied-predicate-slot' ? { ...slot } : slot,
          dependencyId: mode === 'wrong-dependency' ? 'undeclared-control' : 'done-control',
        }), stateError);
        return true;
      } }), stateError);
      await assert.rejects(session.finalize(), stateError); return empty();
    } }), stateError);
    assert.deepEqual(await domain(w), before);
  });

test('reexecuting one checked query occurrence refuses and poisons the owner without replaying its predicate', async () => {
  const w = await world(), before = await domain(w), seen: string[] = [];
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await session.stage({ op: 'update', model: MODEL, id: w.rows[0]!.id, data: { approved: true } }, cause);
    await query(call, w, seen);
    await assert.rejects(query(call, w, seen), stateError);
    assert.equal(seen.length, 3);
    await assert.rejects(session.finalize(), stateError); return empty();
  } }), stateError);
  assert.equal(seen.length, 3); assert.deepEqual(await domain(w), before);
});
