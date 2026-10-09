/** Defining State-issued owner-session provenance controls. The checked
 * descriptor is hand-built; this is not Compiler or native-host acceptance.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, Receipt, ScenarioResultDisclosurePlan, StoragePort, StoredRow } from '@canlang/contracts';
import type { AdmittedCall } from './admission.js';
import { StateError } from '../errors.js';
import { createMemoryStorage } from '../storage/memory.js';
import { buildModelTable } from '../mutation/models.js';
import type { MutationWritesResult, OwnerMutationSession } from '../mutation/pipeline.js';
import { transition } from '../effects/transition.js';
import { buildPolicyTable } from '../policy/grants.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from './registry.js';
import { invoke, invokeRetainedReceiptOnly, type ExecutionEffects } from './invoke.js';
import { beginScenarioReceiptMutation, observeScenarioReceiptDependency, selectScenarioReceiptReturn,
  readScenarioReceiptAssociation, projectScenarioReceipt } from './scenario-receipt.js';
import { FIXED_NOW, asId, asModel, createMemoryIdentityStore, makeBatch, makeIdentity, makeEnvelope,
  seedMember, seedRow, uuidv7 } from '../../test/invocation/fixtures.js';
import { field, modelDef } from '../../test/mutation/fixtures.js';

const MODEL = asModel('Shop.Record'), OP = 'Shop.advance', APP = 'scenario-owner-app';
const bounds = { maxWork: 1000, maxRows: 10 }, cause = { cause: 'scenario' } as const;
let sequence = 20_000;
const origin = () => ({ path: 'advance.can', sha256: 'b'.repeat(64), module: 'advance.mjs' });
const plan = (): ScenarioResultDisclosurePlan => ({ version: 1, source: origin(), returns: [{
  id: 'advance-return', source: origin(), influences: [], dependencies: [
    { id: 'queued-state', source: origin(), role: 'control', model: MODEL, field: 'state', type: 'text' as CanTypeId },
    { id: 'queued-key', source: origin(), role: 'control', model: MODEL, field: 'key', type: 'text' as CanTypeId },
  ],
}] });
function artifact(): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: 'advance.can', sha256: 'b'.repeat(64) }],
    modules: [{ path: 'advance.mjs', js: 'export const identity="Shop.advance";',
      map: { version: 3, file: 'advance.mjs', sources: ['advance.can'], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: 'advance.mjs', export: 'identity', member: ['advance'] }],
    models: [{ name: MODEL, deleteMode: 'archive', fields: [
      { name: 'state', field: { kind: 'string' }, required: true, serverOnly: false },
      { name: 'key', field: { kind: 'string' }, required: true, serverOnly: false },
      { name: 'token', field: { kind: 'secret' }, required: false, serverOnly: true },
      { name: 'private', field: { kind: 'string' }, required: false, serverOnly: false },
      { name: 'visible', field: { kind: 'string' }, required: false, serverOnly: false },
    ] }],
    operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'record', field: { kind: 'ref', model: MODEL, requireVersion: true }, required: true },
    ] }, result: { type: 'void' as CanTypeId, disclosure: plan() } }],
  };
}
const stateError = (error: unknown) => error instanceof StateError;
const validation = (error: unknown) => error instanceof StateError && error.code === 'validation';
const forbidden = (error: unknown) => error instanceof StateError && error.code === 'forbidden';
const empty = (): ExecutionEffects => ({ result: null, writes: [], history: [], outbox: [], schedules: [],
  uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {} });
const effects = (output: MutationWritesResult): ExecutionEffects => ({ ...output, result: null, outbox: [] });

async function world(privateValue?: string) {
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false, roles: [] });
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const loaded = loadArtifactDescriptors(artifact(), { by: 'members' });
  const table = buildModelTable([modelDef(MODEL, { fields: {
    state: { ...field(), default: 'draft', machine: { initial: 'draft', states: ['draft', 'queued', 'generating'],
      transitions: [{ from: 'draft', to: 'queued', operation: OP }, { from: 'queued', to: 'generating', operation: OP }] } },
    key: field({ required: true }), token: field({ serverOnly: true }), private: field(), visible: field(),
  }, uniqueKeys: ['key'] })]);
  const seeded = await seedRow(store, MODEL, { data: { state: 'draft', key: 'entry-key', token: 'private original',
    ...(privateValue === undefined ? {} : { private: privateValue, visible: 'entry visible' }) } });
  const row = await store.load(MODEL, seeded.id); assert.ok(row);
  await store.commit(makeBatch(await store.readRevision(), { uniqueClaims: [
    { model: MODEL, recordId: row.id, keyName: 'key', keyValue: 'entry-key' },
  ] }));
  const policy = buildPolicyTable([{ model: MODEL, secretFields: [],
    grants: [{ by: 'members', fields: ['state', 'key', 'token'] }] }]);
  return { store, memberships, identity, member, row, table, policy, registry: loaded.registry,
    envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), { record: { id: row.id, version: String(row.version) } }),
    app: APP, source: 'test', clock: { nowMs: () => FIXED_NOW } };
}
type World = Awaited<ReturnType<typeof world>>;
async function queued(call: AdmittedCall, w: World, store: StoragePort = w.store,
  limits = bounds): Promise<{ session: OwnerMutationSession; row: StoredRow }> {
  const session = await beginScenarioReceiptMutation(call, store, { table: w.table, bounds: limits });
  await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { key: 'queued-key' } }, cause);
  const row = await transition({ canonical: { stageWrite: async write => {
    await session.stage({ ...write, model: asModel(write.model), id: asId(write.id) }, cause);
    return session.read(MODEL, w.row.id);
  } } }, MODEL, w.row.id, 'state', 'draft', 'queued');
  assert.equal(row.data['state'], 'queued'); assert.equal(row.version, w.row.version + 1);
  return { session, row };
}
async function captureQueued(call: AdmittedCall, w: World, session: OwnerMutationSession, row: StoredRow) {
  await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'queued-state', model: MODEL, row, field: 'state' });
  const current = await session.views.final.get(MODEL, w.row.id); assert.ok(current);
  await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'queued-key', model: MODEL,
    row: current, field: 'key' });
}
async function finish(call: AdmittedCall, w: World, session: OwnerMutationSession): Promise<MutationWritesResult> {
  await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { key: 'final-key' },
    transition: { field: 'state', from: 'queued', to: 'generating' } }, cause);
  selectScenarioReceiptReturn(call, w.store, 'advance-return');
  return session.finalize();
}
async function domain(w: World) {
  return { row: await w.store.load(MODEL, w.row.id), history: await w.store.historyFor(MODEL, w.row.id),
    outbox: await w.store.outboxPending() };
}

test('admitted owner session retains intermediate control reads and final net effects through void receipt recovery', async () => {
  const w = await world(); let receipt: Receipt | undefined;
  const result = await invoke({ ...w, execute: async call => {
    const { session, row } = await queued(call, w);
    assert.ok(Object.isFrozen(row)); assert.ok(Object.isFrozen(row.data));
    assert.deepEqual(await session.views.entry.get(MODEL, w.row.id), w.row);
    await captureQueued(call, w, session, row);
    const output = await finish(call, w, session);
    assert.equal(output.writes.length, 1); assert.equal(output.history.length, 1);
    const write = output.writes[0]; assert.ok(write); assert.equal(write.kind, 'update');
    if (write.kind !== 'update') throw new Error('Expected final update');
    assert.equal(write.expectedVersion, w.row.version);
    assert.equal(write.row.version, w.row.version + 1);
    assert.deepEqual(output.history[0]!.before, w.row.data);
    assert.deepEqual(output.history[0]!.after, { ...w.row.data, state: 'generating', key: 'final-key' });
    assert.deepEqual(output.uniqueClaims, [{ model: MODEL, recordId: w.row.id, keyName: 'key', keyValue: 'final-key' }]);
    assert.deepEqual(output.uniqueReleases, [{ model: MODEL, keyName: 'key', keyValue: 'entry-key' }]);
    return effects(output);
  }, observeCommittedReceipt: value => { receipt = value; } });
  assert.equal(result.status, 'committed'); assert.equal(result.result, null); assert.ok(receipt);
  const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
  assert.equal(association.observations.length, 2);
  assert.equal(association.observations[0]!.row.data['state'], 'queued');
  assert.equal(association.observations[1]!.row.data['key'], 'queued-key');
  assert.equal(association.changed[0]!.row.data['state'], 'generating');
  assert.equal(association.changed[0]!.row.data['key'], 'final-key');
  assert.equal(association.changed[0]!.row.version, w.row.version + 1);
  assert.equal((await w.store.historyFor(MODEL, w.row.id)).length, 1);
  const before = await domain(w), revision = await w.store.readRevision();
  let executes = 0, commits = 0; let recovered: Receipt | undefined;
  const recoveryStore: StoragePort = { ...w.store, commit: async batch => { commits++; return w.store.commit(batch); } };
  assert.equal((await invokeRetainedReceiptOnly({ ...w, store: recoveryStore,
    clock: { nowMs: () => FIXED_NOW + 16 * 60_000 }, execute: async () => { executes++; return empty(); },
    observeCommittedReceipt: value => { recovered = value; } })).status, 'replayed');
  assert.deepEqual(recovered, receipt); assert.equal(executes, 0); assert.equal(commits, 0);
  const projected = await projectScenarioReceipt({ ...w, receipt });
  assert.equal(projected.result, null);
  assert.deepEqual(projected.records[0]!.data, { state: 'generating', key: 'final-key' });
  await w.memberships.removeMembership(w.member.membership.membership_id);
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
  assert.deepEqual(await domain(w), before); assert.equal(await w.store.readRevision(), revision);
});

test('admitted owner session refuses copied, manual, stale and foreign provisional carriers and poisons caught observations', async () => {
  for (const mode of ['copy', 'manual', 'stale', 'call', 'store'] as const) {
    const w = await world(), before = await domain(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      const { session, row } = await queued(call, w);
      const observed = mode === 'copy' ? { ...row } : mode === 'manual' ? {
        ...w.row, version: row.version, updated: row.updated, updatedBy: row.updatedBy,
        data: { ...row.data },
      } : row;
      if (mode === 'stale') await session.stage({ op: 'update', model: MODEL, id: w.row.id,
        data: { key: 'newer provisional' } }, cause);
      await assert.rejects(observeScenarioReceiptDependency(mode === 'call' ? { ...call } : call,
        mode === 'store' ? { ...w.store } : w.store,
        { dependencyId: 'queued-state', model: MODEL, row: observed, field: 'state' }), stateError);
      await assert.rejects(session.finalize(), stateError);
      return empty();
    } }), stateError);
    assert.deepEqual(await domain(w), before);
  }
});

test('admitted owner session refuses missing or altered finalized writes, history, uniques and defaults', async () => {
  for (const mode of ['missing-write', 'altered-write', 'missing-history', 'altered-history', 'unique', 'defaults'] as const) {
    const w = await world(), before = await domain(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      const { session, row } = await queued(call, w);
      await captureQueued(call, w, session, row);
      const output = await finish(call, w, session);
      if (mode === 'missing-write') return { ...effects(output), writes: [] };
      if (mode === 'missing-history') return { ...effects(output), history: [] };
      if (mode === 'unique') return { ...effects(output), uniqueClaims: [] };
      if (mode === 'defaults') return { ...effects(output), resolvedDefaults: { forged: 'resolution' } };
      if (mode === 'altered-history') return { ...effects(output), history: output.history.map(entry => ({ ...entry,
        after: { ...entry.after, key: 'forged history' } })) };
      return { ...effects(output), writes: output.writes.map(write => write.kind === 'remove' ? write : ({ ...write,
        row: { ...write.row, data: { ...write.row.data, key: 'forged final' } },
      })) };
    } }), validation);
    assert.deepEqual(await domain(w), before);
  }
});

test('admitted owner receipt withholds public changed writes influenced by unreadable private data or control', async () => {
  for (const role of ['data', 'control'] as const) {
    const w = await world('private choice'), slice = artifact();
    slice.operations![0]!.result = { type: (role === 'data' ? 'text' : 'void') as CanTypeId,
      disclosure: { version: 1, source: origin(), returns: [{ id: 'advance-return', source: origin(), influences: [],
        dependencies: [{ id: 'private-read', source: origin(), role, model: MODEL, field: 'private', type: 'text' as CanTypeId }],
      }] } };
    const registry = loadArtifactDescriptors(slice, { by: 'members' }).registry;
    const unsupportedSecret = structuredClone(slice);
    unsupportedSecret.models![0]!.fields.find(entry => entry.name === 'private')!.field = { kind: 'secret' };
    // v1 cannot declare a scalar dependency on an original secret tag. Its
    // checked intake refuses rather than manufacturing disclosure evidence.
    assert.throws(() => loadArtifactDescriptors(unsupportedSecret, { by: 'members' }));
    let receipt: Receipt | undefined;
    const answer = await invoke({ ...w, registry, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      const row = await session.read(MODEL, w.row.id); assert.ok(row);
      await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'private-read', model: MODEL, row, field: 'private' });
      const selected = role === 'data' ? row.data['private'] : row.data['private'] === 'private choice'
        ? 'public value selected privately' : 'other public value';
      await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { visible: selected } }, cause);
      selectScenarioReceiptReturn(call, w.store, 'advance-return');
      return { ...effects(await session.finalize()), result: role === 'data' ? selected : null };
    }, observeCommittedReceipt: value => { receipt = value; } });
    assert.equal(answer.status, 'committed'); assert.ok(receipt);
    const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
    assert.equal(association.observations[0]!.row.data['private'], 'private choice');
    assert.ok(association.changed[0]!.row.data['visible']);
    const revision = await w.store.readRevision(), before = await domain(w);
    const readable = buildPolicyTable([{ model: MODEL, secretFields: [],
      grants: [{ by: 'members', fields: ['private', 'visible'] }] }]);
    const visibleOnly = buildPolicyTable([{ model: MODEL, secretFields: [],
      grants: [{ by: 'members', fields: ['visible'] }] }]);
    const currentSecret = buildPolicyTable([{ model: MODEL, secretFields: ['private'],
      grants: [{ by: 'members', fields: ['visible'] }] }]);
    assert.deepEqual(await projectScenarioReceipt({ ...w, registry, policy: visibleOnly, receipt }),
      { result: null, records: [] });
    assert.deepEqual(await projectScenarioReceipt({ ...w, registry, policy: currentSecret, receipt }),
      { result: null, records: [] });
    const projected = await projectScenarioReceipt({ ...w, registry, policy: readable, receipt });
    assert.equal(projected.result, role === 'data' ? 'private choice' : null);
    assert.deepEqual(projected.records[0]!.data, { private: 'private choice',
      visible: association.changed[0]!.row.data['visible'] });
    const currentSlice = structuredClone(slice);
    currentSlice.models![0]!.fields.find(entry => entry.name === 'private')!.field = { kind: 'secret' };
    currentSlice.operations![0]!.result = { type: (role === 'data' ? 'text' : 'void') as CanTypeId,
      disclosure: { version: 1, source: origin(), returns: [{ id: 'current-literal', source: origin(),
        influences: [], dependencies: [] }] } };
    const currentRegistry = loadArtifactDescriptors(currentSlice, { by: 'members' }).registry;
    assert.deepEqual(await projectScenarioReceipt({ ...w, registry: currentRegistry, policy: readable, receipt }),
      { result: null, records: [] });
    assert.deepEqual(await domain(w), before); assert.equal(await w.store.readRevision(), revision);
  }
});

test('admitted owner effects reject getters without execution and isolate post-return aliases from the commit fence', async () => {
  const rejected = await world(), before = await domain(rejected);
  let getterCalls = 0;
  await assert.rejects(invoke({ ...rejected, execute: async call => {
    const { session, row } = await queued(call, rejected);
    await captureQueued(call, rejected, session, row);
    const output = await finish(call, rejected, session), raw = effects(output);
    Object.defineProperty(raw, 'history', { enumerable: true, get: () => { getterCalls++; return output.history; } });
    return raw;
  } }), validation);
  assert.equal(getterCalls, 0); assert.deepEqual(await domain(rejected), before);

  const w = await world(); let guardCalls = 0, alias: ExecutionEffects | undefined, receipt: Receipt | undefined;
  const result = await invoke({ ...w, execute: async call => {
    const { session, row } = await queued(call, w);
    await captureQueued(call, w, session, row);
    const output = await finish(call, w, session);
    const raw = structuredClone(effects(output)); alias = raw;
    raw.guards = [{ name: 'mutate returned aliases at current fence', evaluate: () => {
      guardCalls++;
      const write = raw.writes[0]!; assert.notEqual(write.kind, 'remove');
      if (write.kind === 'remove') throw new Error('Expected update');
      (write.row.data as Record<string, unknown>)['key'] = 'post-return alias';
      (raw.history[0]!.after as Record<string, unknown>)['key'] = 'post-return history alias';
      raw.resolvedDefaults['forged'] = 'post-return default alias';
      return true;
    } }];
    return raw;
  }, observeCommittedReceipt: value => { receipt = value; } });
  assert.equal(result.status, 'committed'); assert.equal(guardCalls, 1); assert.ok(alias); assert.ok(receipt);
  const aliasedWrite = alias.writes[0]!; assert.notEqual(aliasedWrite.kind, 'remove');
  if (aliasedWrite.kind === 'remove') throw new Error('Expected update');
  assert.equal(aliasedWrite.row.data['key'], 'post-return alias');
  assert.equal((await w.store.load(MODEL, w.row.id))!.data['key'], 'final-key');
  assert.equal((await w.store.historyFor(MODEL, w.row.id))[0]!.after!['key'], 'final-key');
  assert.deepEqual(receipt.resolvedDefaults, {});
  const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
  assert.equal(association.changed[0]!.row.data['key'], 'final-key');
});

test('admitted owner session requires finalization and cannot recover from caught staging or work-bound failures', async () => {
  for (const mode of ['unfinalized', 'stage', 'budget'] as const) {
    const w = await world(), before = await domain(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      if (mode === 'budget') {
        const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table,
          bounds: { maxRows: 10, maxWork: 1 } });
        await assert.rejects(session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { key: 'queued-key' } }, cause), validation);
        await assert.rejects(session.finalize(), validation);
        return empty();
      }
      const { session, row } = await queued(call, w);
      await captureQueued(call, w, session, row);
      if (mode === 'stage') {
        await assert.rejects(session.stage({ op: 'update', model: MODEL, id: w.row.id,
          transition: { field: 'state', from: 'queued', to: 'draft' } }, cause), stateError);
        await assert.rejects(session.finalize(), stateError);
      } else selectScenarioReceiptReturn(call, w.store, 'advance-return');
      return empty();
    } }), stateError);
    assert.deepEqual(await domain(w), before);
  }
});

test('admitted owner session pins physical revision and poisons concurrent operations', async () => {
  for (const mode of ['revision', 'concurrent'] as const) {
    const w = await world(), before = await domain(w);
    let release: (() => void) | undefined, entered: (() => void) | undefined, delay = false;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const loading = new Promise<void>(resolve => { entered = resolve; });
    const store: StoragePort = { ...w.store, load: async (model, id) => {
      if (delay) { delay = false; entered!(); await blocked; }
      return w.store.load(model, id);
    } };
    await assert.rejects(invoke({ ...w, store, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, store, { table: w.table, bounds });
      if (mode === 'revision') {
        await w.store.commit(makeBatch(await w.store.readRevision()));
        await assert.rejects(session.read(MODEL, w.row.id), stateError);
      } else {
        delay = true;
        const first = session.read(MODEL, w.row.id);
        await loading;
        await assert.rejects(session.read(MODEL, w.row.id), stateError);
        release!();
        await assert.rejects(first, stateError);
      }
      await assert.rejects(session.finalize(), stateError);
      return empty();
    } }));
    assert.deepEqual(await domain(w), before);
  }
});

test('admitted owner query keeps its original model provenance when the caller mutates a pending query specification', async () => {
  const w = await world(), OTHER = asModel('Shop.Other');
  // Identical physical rows make model provenance decisive; equality of row
  // data alone must not authorize a dependency on the other model.
  await seedRow(w.store, OTHER, { id: w.row.id, data: { ...w.row.data } });
  const slice = artifact();
  slice.models = [...slice.models!, { ...slice.models![0]!, name: OTHER }];
  slice.operations![0]!.result = { type: 'void' as CanTypeId, disclosure: { version: 1, source: origin(), returns: [{
    id: 'advance-return', source: origin(), influences: [], dependencies: [{
      id: 'other-state', source: origin(), role: 'control', model: OTHER, field: 'state', type: 'text' as CanTypeId,
    }],
  }] } };
  const registry = loadArtifactDescriptors(slice, { by: 'members' }).registry;
  const table = buildModelTable([...w.table.values(), modelDef(OTHER, { fields: {
    state: field({ required: true }), key: field({ required: true }), token: field({ serverOnly: true }),
  } })]);
  const before = await domain(w), otherBefore = await w.store.load(OTHER, w.row.id);
  let enter: (() => void) | undefined, release: (() => void) | undefined;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const queriedModels: string[] = [];
  const store: StoragePort = { ...w.store, query: async spec => {
    queriedModels.push(spec.model);
    enter!(); await blocked;
    return w.store.query(spec);
  } };
  await assert.rejects(invoke({ ...w, registry, store, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, store, { table, bounds });
    const spec = { model: MODEL, authority: 'owner' as const, limit: 1 };
    const pending = session.views.final.query(spec);
    await entered;
    spec.model = OTHER;
    release!();
    const rows = await pending;
    assert.deepEqual(queriedModels, [MODEL]);
    assert.equal(rows.length, 1); assert.deepEqual(rows[0], w.row);
    await assert.rejects(observeScenarioReceiptDependency(call, store, {
      dependencyId: 'other-state', model: OTHER, row: rows[0]!, field: 'state',
    }), validation);
    await assert.rejects(session.finalize(), stateError);
    return empty();
  } }), stateError);
  assert.deepEqual(await domain(w), before);
  assert.deepEqual(await w.store.load(OTHER, w.row.id), otherBefore);
  assert.deepEqual(await w.store.historyFor(OTHER, w.row.id), []);
});

test('admitted owner session rejects foreign factory scope and refuses observation, reads and stages after finalization or execution close', async () => {
  const w = await world(); let admitted: AdmittedCall | undefined, savedSession: OwnerMutationSession | undefined;
  let savedRow: StoredRow | undefined;
  await invoke({ ...w, execute: async call => {
    const { session, row } = await queued(call, w);
    admitted = call; savedSession = session; savedRow = row;
    await captureQueued(call, w, session, row);
    return effects(await finish(call, w, session));
  } });
  assert.ok(admitted); assert.ok(savedSession); assert.ok(savedRow);
  const before = await domain(w), revision = await w.store.readRevision();
  await assert.rejects(beginScenarioReceiptMutation(admitted, w.store, { table: w.table, bounds }), forbidden);
  await assert.rejects(savedSession.read(MODEL, w.row.id), stateError);
  await assert.rejects(savedSession.views.final.get(MODEL, w.row.id), stateError);
  await assert.rejects(savedSession.stage({ op: 'update', model: MODEL, id: w.row.id, data: { key: 'late' } }, cause), stateError);
  await assert.rejects(savedSession.finalize(), stateError);
  await assert.rejects(observeScenarioReceiptDependency(admitted, w.store, {
    dependencyId: 'queued-state', model: MODEL, row: savedRow, field: 'state',
  }), forbidden);
  assert.deepEqual(await domain(w), before); assert.equal(await w.store.readRevision(), revision);
  for (const scope of ['call', 'store'] as const) {
    const fresh = await world(), baseline = await domain(fresh);
    await assert.rejects(invoke({ ...fresh, execute: async call => {
      await beginScenarioReceiptMutation(scope === 'call' ? { ...call } : call,
        scope === 'store' ? { ...fresh.store } : fresh.store, { table: fresh.table, bounds });
      return empty();
    } }), forbidden);
    assert.deepEqual(await domain(fresh), baseline);
  }
});
