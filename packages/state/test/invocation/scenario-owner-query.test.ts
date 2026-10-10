/** Finite State defining controls using genuine Values, MemoryStorage and
 * invoke's existing owner frame. These do not qualify generated Compiler code. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtifactModel, CanTypeId, ClosedInputs, Receipt, StoredRow } from '@canlang/contracts';
import { normalizeValueTypes } from '@canlang/values';
import { checkQueryInventory } from '../../src/invocation/scenario-query-plan.js';
import { projectReadScenarioQueryResult } from '../../src/invocation/index.js';
import { queryRecords } from '../../src/query/engine.js';
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
async function world(options: { child?: boolean; empty?: boolean; lazy?: boolean } = {}) {
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const slice = artifact(options.child);
  if (options.lazy) {
    const operation = slice.operations!.find(item => item.name === ROOT)!;
    const plan = operation.result!.disclosure!;
    const queryPlan = plan.queries![0]!;
    operation.result = { ...operation.result!, disclosure: { ...plan, queries: [{ ...queryPlan,
      dependencies: [...queryPlan.dependencies, { id: 'approved-control', source: source(), role: 'control', field: 'approved', type: 'bool' as CanTypeId }],
    }] } };
  }
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
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
    const done = record.data['done'];
    observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: 'done-control' });
    return done === true;
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
      assert.equal(candidate.dependencies.includes('key-order'), candidate.matched);
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

for (const mode of ['and', 'or', 'empty'] as const) test(`lazy ${mode} query closes actual reads, preserves ordered data and replays under current grants`, async () => {
  const w = await world({ lazy: true, empty: mode === 'empty' }); let receipt: Receipt | undefined, reads = 0;
  const input = { ...w, execute: async (call: AdmittedCall) => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const result = await executeScenarioReceiptQuery(call, w.store, { queryId: 'tasks', predicate: ({ slot, record }) => {
      // Enumerating the native shape must not evaluate source getters.
      assert.ok(Object.isFrozen(record.data)); assert.ok(Object.keys(record.data).includes('approved'));
      const read = (field: 'done' | 'approved') => {
        reads++; const value = record.data[field];
        observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: `${field}-control` });
        return value === true;
      };
      // Repeat one genuine source site: each read needs its own marker.
      const done = read('done'); assert.equal(read('done'), done);
      return mode === 'and' ? done && read('approved') : done || read('approved');
    } });
    const value = select(call, w, result);
    assert.deepEqual(result.rows.map(row => row.record.id), mode === 'or' ? ['task-a', 'task-c'] : []);
    const final = await session.finalize(); return { ...final, outbox: final.outbox ?? [], result: value };
  }, observeCommittedReceipt: (value: Receipt) => { receipt = value; } };
  assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt);
  const observed = readScenarioReceiptAssociation(receipt)!.queries![0]!;
  assert.equal(observed.candidates.length, mode === 'empty' ? 0 : 3);
  for (const candidate of observed.candidates) {
    assert.ok(candidate.dependencies.includes('done-control'));
    assert.equal(candidate.dependencies.includes('approved-control'), mode === 'and' ? candidate.row.data['done'] === true : candidate.row.data['done'] === false);
    assert.equal(candidate.dependencies.includes('key-order'), candidate.matched);
    assert.equal(candidate.dependencies.includes('key-data'), candidate.matched);
    assert.ok(Object.getOwnPropertyDescriptor(candidate.record.data, 'done')?.value !== undefined);
  }
  assert.equal(reads, mode === 'empty' ? 0 : mode === 'and' ? 8 : 7);
  assert.equal((await invoke(input)).status, 'replayed'); assert.equal(reads, mode === 'empty' ? 0 : mode === 'and' ? 8 : 7);
  assert.ok(receipt.outcome.status === 'committed');
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, receipt.outcome.result);
  // Static potential-field authority is still required even if a branch skipped it.
  const hidden = buildPolicyTable([{ model: MODEL, secretFields: [], grants: [{ by: 'members', fields: ['key', 'done'] }] }]);
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt, policy: hidden }), { result: null, records: [] });
  await w.memberships.removeMembership(w.member.membership.membership_id);
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
});

for (const mode of ['next-slot', 'closed-predicate', 'unchecked-field', 'second-read-before-marker'] as const)
test(`${mode} predicate getter refuses and poisons the owner even when caught`, async () => {
  const w = await world(), before = await domain(w); let retained: Record<string, unknown> | undefined;
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const run = executeScenarioReceiptQuery(call, w.store, { queryId: 'tasks', predicate: ({ slot, record }) => {
      if (mode === 'next-slot' && retained) assert.throws(() => retained!['done'], stateError);
      retained ??= record.data;
      if (mode === 'unchecked-field') assert.throws(() => record.data['approved'], stateError);
      const done = record.data['done'];
      if (mode === 'second-read-before-marker') assert.throws(() => record.data['done'], stateError);
      observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: 'done-control' });
      return done === true;
    } });
    if (mode === 'closed-predicate') {
      const result = await run; select(call, w, result);
      assert.throws(() => retained!['done'], stateError);
    } else await assert.rejects(run, stateError);
    await assert.rejects(session.finalize(), stateError); return empty();
  } }), stateError);
  assert.deepEqual(await domain(w), before);
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
  assert.ok(receipt);
  const finalRow = await w.store.load(MODEL, w.rows[0]!.id); assert.ok(finalRow);
  assert.equal(finalRow.version, 2); assert.deepEqual(finalRow.data, { key: 'final', done: true, approved: true });
  const expected = {
    result: [
      { task: { id: 'task-a', version: '1' }, version: '1', key: 'a' },
      { task: { id: 'task-c', version: '2' }, version: '2', key: 'intermediate' },
    ],
    records: [{ ...finalRow, parent: finalRow.parent ?? null }],
  };
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), expected);
  await w.memberships.createMembership({ team_id: w.member.team.team_id, user_id: w.member.user.user_id, is_owner: false, roles: [] });
  // Renewed membership still grants every original query influence; projection
  // preserves the issued intermediate facts beside the final changed record.
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), expected);
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
        const first = executeScenarioReceiptQuery(call, w.store, { queryId: 'tasks', predicate: async ({ slot, record }) => {
          void record.data['done'];
          observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: 'done-control' });
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

for (const mode of ['missing-control', 'wrong-dependency', 'copied-predicate-slot', 'marker-without-read', 'repeat-missing-marker', 'field-skew', 'copied-call', 'foreign-store'] as const)
  test(`${mode} cannot certify predicate control even if its refusal is caught`, async () => {
    const w = await world(), before = await domain(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await session.stage({ op: 'update', model: MODEL, id: w.rows[0]!.id, data: { approved: true } }, cause);
      await assert.rejects(executeScenarioReceiptQuery(call, w.store, { queryId: 'tasks', predicate: async ({ slot, record }) => {
        if (mode !== 'marker-without-read') void record.data['done'];
        if (mode === 'repeat-missing-marker') {
          observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: 'done-control' });
          void record.data['done'];
        }
        if (mode !== 'missing-control' && mode !== 'repeat-missing-marker') assert.throws(() => observeScenarioReceiptQueryDependency(
          mode === 'copied-call' ? { ...call } : call, mode === 'foreign-store' ? { ...w.store } : w.store, {
          slot: mode === 'copied-predicate-slot' ? { ...slot } : slot,
          dependencyId: mode === 'wrong-dependency' ? 'undeclared-control' : mode === 'field-skew' ? 'key-order' : 'done-control',
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

/** Full original Fact field profile at State's existing native read boundary;
 * source generation and the complete original .can workflow remain separate. */
test('original seven-field Fact profile binds genuine child query slots, bounds and nominal enum in one owner receipt', async () => {
  const taskModel = asModel('todo.Task'), locationModel = asModel('Locations.Location');
  const factType = 'workbench.Fact[]' as CanTypeId, priorityType = 'todo.Task.priority' as CanTypeId;
  const mapped = [
    { name: 'title', type: 'text' as CanTypeId }, { name: 'description', type: 'text?' as CanTypeId },
    { name: 'due', type: 'datetime?' as CanTypeId }, { name: 'priority', type: priorityType },
    { name: 'done', type: 'bool' as CanTypeId },
  ];
  for (const mode of ['preserve', 'guard', 'title-bound', 'description-bound', 'version-bound', 'enum'] as const) {
    const slice = artifact(true);
    slice.valueTypes = { contracts: [{ name: 'workbench.Fact', fields: [
      { name: 'task', type: taskModel }, { name: 'version', type: 'int', min: '1' },
      { name: 'title', type: 'text', trim: true, min: 1, max: 2000 },
      { name: 'description', type: 'text?', max: 8000 }, { name: 'due', type: 'datetime?' },
      { name: 'priority', type: priorityType }, { name: 'done', type: 'bool' },
    ] }], enums: [{ name: priorityType, cases: ['low', 'normal', 'high'] }] };
    slice.models = [
      { name: taskModel, deleteMode: 'archive', fields: [
        { name: 'title', field: { kind: 'string' }, valueType: 'text', required: true, serverOnly: false, trim: true, min: 1, max: 2000 },
        { name: 'description', field: { kind: 'string' }, valueType: 'text?', required: false, serverOnly: false, nullable: true, max: 8000 },
        { name: 'due', field: { kind: 'datetime' }, valueType: 'datetime?', required: false, serverOnly: false, nullable: true },
        { name: 'priority', field: { kind: 'nominal', name: priorityType }, valueType: priorityType, required: true, serverOnly: false },
        { name: 'done', field: { kind: 'boolean' }, required: true, serverOnly: false },
        { name: 'location', field: { kind: 'ref', model: locationModel }, required: true, serverOnly: false },
      ] },
      { name: locationModel, deleteMode: 'archive', fields: [{ name: 'name', field: { kind: 'string' }, required: true, serverOnly: false }] },
    ];
    const plan = { version: 1 as const, source: source(), queries: [{ id: 'original-tasks', source: source(), model: taskModel,
      order: [{ field: 'title', direction: 'asc' as const }], limit: null, archived: 'exclude' as const,
      dependencies: [
        { id: 'location-control', source: source(), role: 'control' as const, field: 'location', type: locationModel as CanTypeId },
        { id: 'title-order', source: source(), role: 'control' as const, field: 'title', type: 'text' as CanTypeId },
        ...mapped.map(item => ({ id: `${item.name}-data`, source: source(), role: 'data' as const, field: item.name, type: item.type })),
      ],
    }], returns: [{ id: 'original-facts-return', source: source(), dependencies: [],
      influences: (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
        .map(kind => ({ id: kind, kind, queryId: 'original-tasks' })),
      projection: { kind: 'query-contract-array' as const, queryId: 'original-tasks', source: source(), fields: [
        { name: 'task', kind: 'reference' as const }, { name: 'version', kind: 'version' as const },
        ...mapped.map(item => ({ name: item.name, kind: 'field' as const, field: item.name })),
      ] },
    }] };
    slice.operations!.find(operation => operation.name === READ)!.result = { type: factType, disclosure: plan };
    const loaded = loadArtifactDescriptors(slice, { by: 'members' });
    const parent = loaded.registry.get(ROOT), read = loaded.registry.get(READ);
    assert.ok(parent && isGeneratedOperationDef(parent)); assert.ok(read && isGeneratedOperationDef(read));
    const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
    const member = await seedMember(memberships, { isOwner: false });
    const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
    const fields = ['title', 'description', 'due', 'priority', 'done', 'location'];
    const policy = buildPolicyTable([{ model: taskModel, secretFields: [], grants: [{ by: 'members', fields }] },
      { model: locationModel, secretFields: [], grants: [{ by: 'members', fields: ['name'] }] }]);
    bindScenarioReceiptQueryProducer(read, { source: source(), app: APP, policy });
    const table = buildModelTable([modelDef(taskModel, { fields: Object.fromEntries(fields.map(name => [name,
      name === 'description' || name === 'due' ? { ...field(), nullable: true } : field({ required: true })])) }),
      modelDef(locationModel, { fields: { name: field({ required: true }) } })]);
    await seedRow(store, locationModel, { id: 'location-selected', data: { name: 'selected' } });
    await seedRow(store, locationModel, { id: 'location-other', data: { name: 'other' } });
    const due = '2026-10-12T09:00:00.000Z';
    const first = await seedRow(store, taskModel, { id: 'original-first', data: {
      title: 'Alpha', description: null, due: null, priority: 'normal', done: false, location: { id: 'location-selected' },
    } });
    await seedRow(store, taskModel, { id: 'original-second', data: {
      title: 'Zulu', description: 'Description', due, priority: 'high', done: true, location: { id: 'location-selected' },
    } });
    await seedRow(store, taskModel, { id: 'original-false', data: {
      title: 'Other', description: null, due: null, priority: 'low', done: false, location: { id: 'location-other' },
    } });
    const before = await store.query({ model: taskModel, authority: 'owner', limit: 10 });
    let receipt: Receipt | undefined, returned: unknown, predicates = 0;
    bindScenarioReceiptCallProducer(parent, { source: source(), app: APP, registry: loaded.registry,
      sites: [{ id: 'original-facts-site', source: source(), kind: 'operation', targets: [{ operation: READ, interface: read.descriptor }], resultType: factType }],
      prepare: (_def, inputs) => inputs as ClosedInputs,
      execute: async frame => {
        const result = await executeScenarioReceiptQuery(frame.call, store, { queryId: 'original-tasks', predicate: async ({ slot, record }) => {
          predicates++;
          const location = record.data['location'];
          observeScenarioReceiptQueryDependency(frame.call, store, { slot, dependencyId: 'location-control' });
          assert.ok(location && typeof location === 'object' && 'id' in location);
          return location.id === 'location-selected';
        } });
        const value: Record<string, unknown>[] = result.rows.map(({ record }) => ({ task: { id: record.id, version: String(record.version) },
          version: String(record.version), ...Object.fromEntries(mapped.map(item => [item.name, record.data[item.name]])) }));
        if (mode === 'title-bound') value[0]!['title'] = 'x'.repeat(2001);
        if (mode === 'description-bound') value[0]!['description'] = 'x'.repeat(8001);
        if (mode === 'version-bound') value[0]!['version'] = '0';
        if (mode === 'enum') value[0]!['priority'] = 'urgent';
        if (mode === 'title-bound' || mode === 'description-bound' || mode === 'version-bound' || mode === 'enum') {
          assert.throws(() => bindScenarioReceiptQueryResult(frame.call, store, { query: result.query,
            returnId: 'original-facts-return', wire: value, rows: result.rows.map(row => row.slot) }), stateError);
          return value;
        }
        bindScenarioReceiptQueryResult(frame.call, store, { query: result.query,
          returnId: 'original-facts-return', wire: value, rows: result.rows.map(row => row.slot) });
        selectScenarioReceiptReturn(frame.call, store, 'original-facts-return'); return value;
      },
    });
    const w = { store, memberships, identity, policy, registry: loaded.registry, app: APP, source: 'test', clock: { nowMs: () => FIXED_NOW },
      envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {}) };
    const input = { ...w, execute: async (call: AdmittedCall) => {
      const session = await beginScenarioReceiptMutation(call, store, { table, bounds });
      await session.stage({ op: 'update', model: taskModel, id: first.id, data: { title: 'Beta' } }, cause);
      if (mode === 'title-bound' || mode === 'description-bound' || mode === 'version-bound' || mode === 'enum') {
        await assert.rejects(invokeScenarioReceiptCall(call, store, { site: 'original-facts-site', target: READ, inputs: {} }), stateError);
        await assert.rejects(session.finalize(), stateError); return empty();
      }
      returned = await invokeScenarioReceiptCall(call, store, { site: 'original-facts-site', target: READ, inputs: {} });
      await session.stage({ op: 'update', model: taskModel, id: first.id, data: { title: 'Final' } }, cause);
      if (mode === 'guard') throw new StateError('rule_failed', 'Original Fact post-read requirement failed.');
      selectScenarioReceiptReturn(call, store, 'root-return'); const final = await session.finalize();
      return { ...final, outbox: final.outbox ?? [], result: null };
    }, observeCommittedReceipt: (value: Receipt) => { receipt = value; } };
    const expected = [
      { task: { id: 'original-first', version: '2' }, version: '2', title: 'Beta', description: null, due: null, priority: 'normal', done: false },
      { task: { id: 'original-second', version: '1' }, version: '1', title: 'Zulu', description: 'Description', due, priority: 'high', done: true },
    ];
    if (mode !== 'preserve') {
      await assert.rejects(invoke(input), stateError);
      assert.deepEqual(await store.query({ model: taskModel, authority: 'owner', limit: 10 }), before);
      assert.deepEqual(await store.historyFor(taskModel, first.id), []);
    } else {
      assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt); assert.deepEqual(returned, expected);
      const child = readScenarioReceiptAssociation(receipt)!.calls![0]!;
      assert.deepEqual(child.result, expected); assert.equal(child.scenario!.queries![0]!.candidates.length, 3);
      for (const candidate of child.scenario!.queries![0]!.candidates) {
        assert.ok(candidate.dependencies.includes('location-control'));
        assert.equal(candidate.dependencies.includes('title-order'), candidate.matched);
      }
      assert.equal(child.scenario!.queries![0]!.candidates.find(candidate => candidate.row.id === 'original-false')!.matched, false);
      const finalRow = await store.load(taskModel, first.id); assert.ok(finalRow); assert.equal(finalRow.data['title'], 'Final');
      const projected = await projectScenarioReceipt({ ...w, receipt });
      assert.deepEqual(projected, { result: null, records: [{ ...finalRow, parent: finalRow.parent ?? null,
        data: { title: 'Final', description: null, due: null, done: false } }] });
      assert.ok(!Object.hasOwn(projected.records[0]!.data, 'priority'));
      assert.ok(!Object.hasOwn(projected.records[0]!.data, 'location'));
      assert.deepEqual(child.result, expected);
      assert.equal((await invoke(input)).status, 'replayed'); assert.deepEqual(readScenarioReceiptAssociation(receipt)!.calls![0]!.result, expected);
    }
    assert.equal(predicates, 3);
  }
});

test('query inventory admits exact compiler nominal enums and refuses absent, foreign or skewed owners', () => {
  const priority = 'todo.Task.priority' as CanTypeId, foreign = 'other.Task.priority' as CanTypeId;
  const plan = { version: 1 as const, source: source(), returns: [], queries: [{
    id: 'priorities', source: source(), model: asModel('todo.Task'), order: [], limit: null, archived: 'exclude' as const,
    dependencies: [{ id: 'priority', source: source(), role: 'data' as const, field: 'priority', type: priority }],
  }] };
  const models: ArtifactModel[] = [{ name: 'todo.Task', deleteMode: 'archive', fields: [{
    name: 'priority', field: { kind: 'nominal', name: priority }, valueType: priority, required: true, serverOnly: false,
  }] }];
  const schema = normalizeValueTypes({ contracts: [], enums: [
    { name: priority, cases: ['low', 'normal', 'high'] },
    { name: foreign, cases: ['low', 'normal', 'high'] },
  ] }, ['todo.Task']).valueSchema;
  assert.doesNotThrow(() => checkQueryInventory(plan, 'void' as CanTypeId, models, schema));
  assert.throws(() => checkQueryInventory(plan, 'void' as CanTypeId, models), /exact owning nominal enum/);
  for (const missing of [
    { contracts: [], enums: [{ name: foreign, cases: ['low', 'normal', 'high'] }] },
    { contracts: [{ name: priority, fields: [] }] },
    { contracts: [], aliases: [{ name: priority, type: 'text', min: 1, max: 64, format: 'name' }] },
  ]) assert.throws(() => checkQueryInventory(plan, 'void' as CanTypeId, models,
    normalizeValueTypes(missing, ['todo.Task']).valueSchema), /exact owning nominal enum/);
  const field = models[0]!.fields[0]!;
  field.field = { kind: 'nominal', name: foreign };
  assert.throws(() => checkQueryInventory(plan, 'void' as CanTypeId, models, schema), /exact owning nominal enum/);
  field.field = { kind: 'nominal', name: priority }; field.valueType = foreign;
  assert.throws(() => checkQueryInventory(plan, 'void' as CanTypeId, models, schema), /exact owning nominal enum/);
  field.valueType = priority; field.nullable = true;
  assert.throws(() => checkQueryInventory(plan, 'void' as CanTypeId, models, schema), /markers disagree/);
  delete field.nullable; field.field = { kind: 'enum', values: ['normal', 'low', 'high'] };
  assert.throws(() => checkQueryInventory(plan, 'void' as CanTypeId, models, schema), /exact owning nominal enum/);
});

test('owning loader refuses a metadata-named direct query dependency before empty-domain authority can be claimed', () => {
  const slice = artifact();
  slice.models![0]!.fields.push({ name: 'version', field: { kind: 'integer' }, valueType: 'int', required: true, serverOnly: false });
  const operation = slice.operations!.find(item => item.name === ROOT); assert.ok(operation?.result?.disclosure);
  const plan = operation.result.disclosure, queryPlan = plan.queries![0]!;
  operation.result = { ...operation.result, disclosure: { ...plan, queries: [{ ...queryPlan,
    dependencies: [...queryPlan.dependencies, { id: 'version-control', source: source(), role: 'control',
      field: 'version', type: 'int' as CanTypeId }],
  }] } };
  assert.throws(() => loadArtifactDescriptors(slice, { by: 'members' }), /metadata-named/);
});


test('fresh viewer projection preserves selected versions and fields without a receipt frame', async () => {
  const w = await world();
  const { records } = await queryRecords({ store: w.store, memberships: w.memberships, policy: w.policy,
    model: MODEL, authority: 'viewer', context: { actorUserId: w.member.user.user_id, teamId: w.member.team.team_id },
    order: [{ field: 'key', direction: 'asc' }], limit: 10 });
  const plan = disclosure(), query = plan.queries[0]!, projection = plan.returns[0]!.projection;
  const before = await domain(w);
  const selected = records.filter(record => record.data['done'] === true);
  const projected = projectReadScenarioQueryResult(projection, query, selected);
  assert.deepEqual(projected, selected.map(record => ({ task: { id: record.id, version: String(record.version) },
    version: String(record.version), key: record.data['key'] })));
  assert.deepEqual(projectReadScenarioQueryResult(projection, query, []), []);
  assert.deepEqual(await domain(w), before);
  assert.throws(() => projectReadScenarioQueryResult({ ...projection, queryId: 'foreign' }, query, selected), stateError);
  assert.throws(() => projectReadScenarioQueryResult({ ...projection, fields: [...projection.fields,
    { name: 'missing', kind: 'field', field: 'missing' }] }, query, selected), stateError);
  assert.throws(() => projectReadScenarioQueryResult(projection, { ...query, limit: 1 }, selected), stateError);
  assert.throws(() => projectReadScenarioQueryResult(projection, { ...query, limit: 201 }, []), stateError);
  assert.throws(() => projectReadScenarioQueryResult(projection, query, [selected[0]!, selected[0]!]), stateError);
  for (const version of [0, -1, 1.5, '1']) {
    assert.throws(() => projectReadScenarioQueryResult(projection, query,
      [{ ...selected[0]!, version } as unknown as typeof selected[number]]), stateError);
  }
  for (const data of [{ done: true }, { key: 7 }]) {
    assert.throws(() => projectReadScenarioQueryResult(projection, query, [{ ...selected[0]!, data }]), stateError);
  }
  let reads = 0;
  const data = Object.defineProperty({}, 'key', { enumerable: true, get() { reads++; return 'a'; } });
  assert.throws(() => projectReadScenarioQueryResult(projection, query, [{ ...selected[0]!, data }]), stateError);
  assert.equal(reads, 0);
  const output = projected as Array<{ key: string }>;
  output[0]!.key = 'changed output';
  assert.equal(selected[0]!.data['key'], 'a');
  assert.deepEqual(await domain(w), before);
});
