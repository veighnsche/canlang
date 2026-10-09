/** Defining State port controls using checked descriptor inventory and real
 * admit/invoke/Values/receipt projection. These are not Compiler/native-host
 * source closure or binding-capture acceptance.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CanTypeId, Receipt, ScenarioResultDisclosurePlan, StoragePort } from '@canlang/contracts';
import { createMemoryStorage } from '../storage/memory.js';
import { StateError } from '../errors.js';
import { buildPolicyTable } from '../policy/grants.js';
import { loadArtifactDescriptors, loadExecutionDescriptorSet, type ArtifactDescriptorSlice } from './registry.js';
import { invoke, invokeRetainedReceiptOnly, type ExecutionEffects } from './invoke.js';
import { observeScenarioReceiptDependency, selectScenarioReceiptReturn,
  readScenarioReceiptAssociation, projectScenarioReceipt, snapshotScenarioReceiptEffects } from './scenario-receipt.js';
import { FIXED_NOW, asModel, asVersion, createMemoryIdentityStore, makeIdentity, makeEnvelope,
  seedMember, seedRow, updateRow, uuidv7 } from '../../test/invocation/fixtures.js';

const MODEL = asModel('Shop.Record'); const OP = 'Shop.saved'; const APP = 'saved-scenario-app';
let sequence = 0;
const origin = () => ({ path: 'saved.can', sha256: 'a'.repeat(64), module: 'saved.mjs' });
const plan = (): ScenarioResultDisclosurePlan => ({ version: 1,
  source: origin(),
  returns: [
    { id: 'record-result', source: origin(), influences: [], dependencies: [{ id: 'value', source: origin(), role: 'data', model: MODEL, field: 'visible', type: 'text' as CanTypeId }] },
    { id: 'literal-result', source: origin(), influences: [], dependencies: [] },
    { id: 'private-control', source: origin(), influences: [], dependencies: [{ id: 'choice', source: origin(), role: 'control', model: MODEL, field: 'private', type: 'text' as CanTypeId }] },
  ],
});
function artifact(): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: 'saved.can', sha256: 'a'.repeat(64) }],
    modules: [{ path: 'saved.mjs', js: 'export const identity="Shop.saved";',
      map: { version: 3, file: 'saved.mjs', sources: ['saved.can'], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: 'saved.mjs', export: 'identity', member: ['saved'] }],
    models: [{ name: MODEL, deleteMode: 'archive', fields: [
      { name: 'visible', field: { kind: 'string' }, required: true, serverOnly: false },
      { name: 'private', field: { kind: 'string' }, required: true, serverOnly: false },
      { name: 'token', field: { kind: 'secret' }, required: false, serverOnly: true,
        default: { kind: 'server', init: 'random_secret' } },
    ] }],
    operations: [{ name: OP, kind: 'scenario', description: '',
      inputs: { fields: [{ name: 'record', field: { kind: 'ref', model: MODEL, requireVersion: true }, required: true }] },
      result: { type: 'text' as CanTypeId, disclosure: plan() } }],
  };
}
const validation = (error: unknown) => error instanceof StateError && error.code === 'validation';
const forbidden = (error: unknown) => error instanceof StateError && error.code === 'forbidden';
const emptyEffects = (result: unknown): ExecutionEffects => ({ result, writes: [], history: [], outbox: [],
  schedules: [], uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {} });

async function world(slice: ArtifactDescriptorSlice = artifact()) {
  const store = createMemoryStorage(); const memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false, roles: ['Shop.reader'] });
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const row = await seedRow(store, MODEL, { data: { visible: 'original visible', private: 'private choice', token: 'original secret' } });
  const envelope = makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), { record: { id: row.id, version: String(row.version) } });
  const policy = buildPolicyTable([{ model: MODEL, secretFields: [],
    grants: [{ by: { role: 'Shop.reader' }, fields: ['visible', 'private', 'token'] }] }]);
  const input = { registry: loaded.registry, envelope, app: APP, identity, store, memberships,
    source: 'test', clock: { nowMs: () => FIXED_NOW } };
  return { ...input, row, member, loaded, policy };
}
async function save(w: Awaited<ReturnType<typeof world>>, changed = true): Promise<Receipt> {
  let receipt: Receipt | undefined;
  await invoke({ ...w, execute: async call => {
    const original = call.recordRefs[0]!.row;
    const result = original.data['visible'];
    await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'value', model: MODEL, row: original, field: 'visible' });
    selectScenarioReceiptReturn(call, w.store, 'record-result');
    return { ...emptyEffects(result), writes: changed ? [{ kind: 'update', model: MODEL, id: original.id,
      expectedVersion: original.version, row: { ...original, version: asVersion(original.version + 1),
        data: { ...original.data, visible: 'committed visible' } } }] : [] };
  }, observeCommittedReceipt: value => { receipt = value; } });
  assert.ok(receipt); return receipt;
}

describe('execution-associated saved scenario disclosure', () => {
  it('preserves an own empty file assignment carrier through scalar receipt snapshot, replay and projection', async () => {
    const w = await world(); let receipt: Receipt | undefined; let executes = 0;
    const assignments: unknown[] = [];
    const input = { ...w, execute: async (call: Parameters<typeof observeScenarioReceiptDependency>[0]) => {
      executes++;
      const original = call.recordRefs[0]!.row;
      await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'value', model: MODEL,
        row: original, field: 'visible' });
      selectScenarioReceiptReturn(call, w.store, 'record-result');
      const raw: ExecutionEffects = { ...emptyEffects(original.data['visible']), fileAssignments: assignments,
        writes: [{ kind: 'update', model: MODEL, id: original.id, expectedVersion: original.version,
          row: { ...original, version: asVersion(original.version + 1),
            data: { ...original.data, visible: 'committed visible' } } }] };
      const snapshot = snapshotScenarioReceiptEffects(call, raw);
      assert.ok(Object.hasOwn(snapshot, 'fileAssignments'));
      assert.deepEqual(snapshot.fileAssignments, []);
      assert.notEqual(snapshot.fileAssignments, assignments);
      assert.ok(Object.isFrozen(snapshot.fileAssignments));
      return raw;
    }, observeCommittedReceipt: (value: Receipt) => { receipt = value; } };
    assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt);
    const originalReceipt = receipt;
    const projected = await projectScenarioReceipt({ ...w, receipt });
    assert.equal(projected.result, 'original visible');
    assert.equal(projected.records[0]!.data['visible'], 'committed visible');
    assert.equal(Object.hasOwn(projected.records[0]!.data, 'token'), false);
    const revision = await w.store.readRevision(), row = await w.store.load(MODEL, w.row.id);
    const history = await w.store.historyFor(MODEL, w.row.id);
    assert.equal((await invoke(input)).status, 'replayed'); assert.equal(executes, 1);
    assert.deepEqual(receipt, originalReceipt);
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), projected);
    assert.equal(await w.store.readRevision(), revision);
    assert.deepEqual(await w.store.load(MODEL, w.row.id), row);
    assert.deepEqual(await w.store.historyFor(MODEL, w.row.id), history);
    assert.deepEqual(await w.store.outboxPending(), []);
  });

  it('refuses unsupported or accessor-bearing file assignment carriers without evaluating getters or committing domain effects', async () => {
    for (const mode of ['nonempty', 'malformed', 'member-getter', 'member-hidden', 'array-extra',
      'array-hidden', 'array-getter', 'array-index-getter'] as const) {
      const w = await world(), row = await w.store.load(MODEL, w.row.id);
      const history = await w.store.historyFor(MODEL, w.row.id);
      let getterCalls = 0;
      await assert.rejects(invoke({ ...w, execute: async call => {
        selectScenarioReceiptReturn(call, w.store, 'literal-result');
        const raw: ExecutionEffects = { ...emptyEffects('literal'), fileAssignments: [],
          writes: [{ kind: 'update', model: MODEL, id: w.row.id, expectedVersion: w.row.version,
            row: { ...w.row, version: asVersion(w.row.version + 1), data: { ...w.row.data, visible: 'must not commit' } } }] };
        const getter = () => { getterCalls++; return []; };
        if (mode === 'nonempty') raw.fileAssignments = [{ model: MODEL, recordId: w.row.id, field: 'attachment' }];
        else if (mode === 'malformed') Object.defineProperty(raw, 'fileAssignments', { enumerable: true, value: {} });
        else if (mode === 'member-getter') Object.defineProperty(raw, 'fileAssignments', { enumerable: true, get: getter });
        else if (mode === 'member-hidden') Object.defineProperty(raw, 'fileAssignments', { enumerable: false, value: [] });
        else Object.defineProperty(raw.fileAssignments!, mode === 'array-index-getter' ? '0' : 'extra',
          mode === 'array-getter' || mode === 'array-index-getter' ? { enumerable: true, get: getter }
            : { enumerable: mode !== 'array-hidden', value: 'unsupported property' });
        return raw;
      } }), validation);
      assert.equal(getterCalls, 0);
      assert.deepEqual(await w.store.load(MODEL, w.row.id), row);
      assert.deepEqual(await w.store.historyFor(MODEL, w.row.id), history);
      assert.deepEqual(await w.store.outboxPending(), []);
      assert.deepEqual(await w.store.schedulesDue(FIXED_NOW, 10), []);
    }
  });

  it('retains original dependencies and final changed snapshots, recovers at 16 minutes without execution and projects saved values', async () => {
    const w = await world(); const receipt = await save(w);
    const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
    assert.equal(association.observations[0]!.row.data['visible'], 'original visible');
    assert.equal(association.changed[0]!.row.data['visible'], 'committed visible');
    const current = await w.store.load(MODEL, w.row.id); assert.ok(current);
    await updateRow(w.store, MODEL, current, { data: { ...current.data, visible: 'current visible' } });
    const revision = await w.store.readRevision(); let executes = 0; let commits = 0; let recovered: Receipt | undefined;
    const store: StoragePort = { ...w.store, commit: async batch => { commits += 1; return w.store.commit(batch); } };
    assert.equal((await invokeRetainedReceiptOnly({ ...w, store,
      clock: { nowMs: () => FIXED_NOW + 16 * 60_000 }, execute: async () => { executes += 1; throw new Error('must not run'); },
      observeCommittedReceipt: value => { recovered = value; } })).status, 'replayed');
    assert.deepEqual(recovered, receipt); assert.equal(executes, 0); assert.equal(commits, 0);
    const projected = await projectScenarioReceipt({ ...w, receipt });
    assert.equal(projected.result, 'original visible'); assert.equal(projected.records.length, 1);
    assert.equal(projected.records[0]!.data['visible'], 'committed visible');
    assert.equal(Object.hasOwn(projected.records[0]!.data, 'token'), false);
    assert.equal(await w.store.readRevision(), revision);
    (projected.records[0]!.data as Record<string, unknown>)['visible'] = 'external alias';
    assert.equal((await projectScenarioReceipt({ ...w, receipt })).records[0]!.data['visible'], 'committed visible');
  });

  it('withholds private data/control results and influenced changes, and leaves literal results free of decision-only reads', async () => {
    const w = await world(); const receipt = await save(w);
    const restricted = buildPolicyTable([{ model: MODEL, secretFields: ['visible'], grants: [{ by: 'members', fields: ['private'] }] }]);
    const hidden = await projectScenarioReceipt({ ...w, policy: restricted, receipt });
    assert.deepEqual(hidden, { result: null, records: [] });
    for (const returnId of ['literal-result', 'private-control']) {
      const fresh = await world(); let saved: Receipt | undefined;
      await invoke({ ...fresh, execute: async call => {
        await observeScenarioReceiptDependency(call, fresh.store, { dependencyId: 'choice', model: MODEL,
          row: call.recordRefs[0]!.row, field: 'private' });
        selectScenarioReceiptReturn(call, fresh.store, returnId);
        return emptyEffects(returnId === 'literal-result' ? 'literal/input value' : 'selected private branch');
      }, observeCommittedReceipt: value => { saved = value; } });
      assert.ok(saved);
      const policy = buildPolicyTable([{ model: MODEL, secretFields: [], grants: [{ by: 'members', fields: ['visible'] }] }]);
      const projected = await projectScenarioReceipt({ ...fresh, policy, receipt: saved });
      assert.equal(projected.result, returnId === 'literal-result' ? 'literal/input value' : null);
      assert.deepEqual(projected.records, []);
    }
  });

  it('checks current by, membership, row grant, lifetime, source scope, and revision/membership races over the actual retained receipt', async () => {
    const w = await world(); const receipt = await save(w);
    const denied = buildPolicyTable([{ model: MODEL, secretFields: [], grants: [{ by: 'members', fields: ['visible'],
      when: { op: 'eq', field: 'visible', value: 'no current grant' } }] }]);
    assert.deepEqual(await projectScenarioReceipt({ ...w, policy: denied, receipt }), { result: null, records: [] });
    await assert.rejects(projectScenarioReceipt({ ...w, app: 'foreign', receipt }), forbidden);
    await assert.rejects(projectScenarioReceipt({ ...w, receipt: { ...receipt, inputHash: 'foreign hash' } }), validation);
    const noBy = loadArtifactDescriptors(artifact(), { by: { role: 'Shop.denied' } }).registry;
    assert.deepEqual(await projectScenarioReceipt({ ...w, registry: noBy, receipt }), { result: null, records: [] });
    let reads = 0;
    const racing: StoragePort = { ...w.store, readRevision: async () => {
      const value = await w.store.readRevision(); return (++reads >= 2 ? value + 1 : value) as typeof value;
    } };
    assert.deepEqual(await projectScenarioReceipt({ ...w, store: racing, receipt }), { result: null, records: [] });
    let membershipReads = 0;
    const racedMembership = { ...w.memberships, findMembership: async (team: string, user: string) =>
      ++membershipReads === 1 ? w.memberships.findMembership(team, user) : null };
    assert.deepEqual(await projectScenarioReceipt({ ...w, memberships: racedMembership, receipt }), { result: null, records: [] });
    const live = await w.store.load(MODEL, w.row.id); assert.ok(live);
    await updateRow(w.store, MODEL, live, { archivedAt: FIXED_NOW + 1 });
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
    await w.memberships.removeMembership(w.member.membership.membership_id);
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
  });

  it('withholds saved values when live membership is revoked during the second projection load without a State revision change', async () => {
    const w = await world(); const receipt = await save(w);
    // Built-in members grants use the sampled caller membership, so both
    // projections remain equal when Identity changes during the second pass.
    const policy = buildPolicyTable([{ model: MODEL, secretFields: [],
      grants: [{ by: 'members', fields: ['visible', 'private', 'token'] }] }]);
    const authorized = await projectScenarioReceipt({ ...w, policy, receipt });
    assert.equal(authorized.result, 'original visible');
    assert.equal(authorized.records[0]!.data['visible'], 'committed visible');
    const revision = await w.store.readRevision();
    const row = await w.store.load(MODEL, w.row.id);
    const sampledStatuses: (string | null)[] = [];
    const memberships = { ...w.memberships, findMembership: async (team: string, user: string) => {
      const member = await w.memberships.findMembership(team, user);
      sampledStatuses.push(member?.status ?? null);
      return member;
    } };
    let loads = 0;
    const store: StoragePort = { ...w.store, load: async (model, id) => {
      const current = await w.store.load(model, id);
      // Each pass loads the original dependency and committed changed row.
      if (++loads === 3) {
        assert.deepEqual(sampledStatuses, ['active', 'active']);
        await w.memberships.removeMembership(w.member.membership.membership_id);
      }
      return current;
    } };
    assert.deepEqual(await projectScenarioReceipt({ ...w, policy, store, memberships, receipt }),
      { result: null, records: [] });
    assert.equal(loads, 4);
    assert.deepEqual(sampledStatuses, ['active', 'active', 'removed']);
    assert.equal(await w.store.readRevision(), revision);
    assert.deepEqual(await w.store.load(MODEL, w.row.id), row);
    assert.deepEqual(await w.store.readReceipt(receipt.identity), receipt);
  });

  it('withholds stable and oscillating multi-member authority profiles pending a coherent Identity snapshot', async () => {
    for (const mode of ['stable', 'oscillating'] as const) {
      const w = await world(); const receipt = await save(w);
      const seededSubject = await seedMember(w.memberships, { teamId: w.member.team.team_id,
        isOwner: false, roles: ['Shop.review'] });
      const caller = w.member.membership, subject = seededSubject.membership;
      const registry = loadArtifactDescriptors(artifact(), { by: { and: ['members',
        { roleSubject: { role: 'Shop.review', person: subject.user_id } }] } }).registry;
      const policy = buildPolicyTable([{ model: MODEL, secretFields: [],
        grants: [{ by: 'members', fields: ['visible', 'private', 'token'] }] }]);
      const snapshot = async () => ({ revision: await w.store.readRevision(),
        row: await w.store.load(MODEL, w.row.id), history: await w.store.historyFor(MODEL, w.row.id),
        outbox: await w.store.outboxPending(), receipt: await w.store.readReceipt(receipt.identity) });
      const before = await snapshot();
      // Port concurrency control, not Identity/native mutation proof. The
      // owning Identity remove/reactivate/setRoles operations preserve IDs
      // and can repeat updated_at under a fixed clock; model that interleave.
      let liveCaller = caller, liveSubject = subject;
      const memberships = { findMembership: async (team: string, user: string) => {
        if (mode === 'oscillating') {
          assert.equal(team, caller.team_id);
          if (user === caller.user_id) {
            liveSubject = { ...subject, status: 'removed', roles: [] };
            liveCaller = { ...caller, status: 'active' };
          } else {
            assert.equal(user, subject.user_id);
            liveCaller = { ...caller, status: 'removed' };
            liveSubject = { ...subject, status: 'active' };
          }
          assert.equal(liveCaller.status === 'active' && liveSubject.status === 'active' &&
            liveSubject.roles.some(role => role.role === 'Shop.review'), false);
          return user === caller.user_id ? liveCaller : liveSubject;
        }
        const current = await w.memberships.findMembership(team, user);
        assert.equal(current?.status, 'active');
        return current;
      } };
      // Per-person values repeat in both variants; only the stable variant
      // has a jointly authorized point in the underlying current profile.
      const sampledCaller = await memberships.findMembership(caller.team_id, caller.user_id);
      const sampledSubject = await memberships.findMembership(subject.team_id, subject.user_id);
      assert.equal(sampledCaller?.status, 'active'); assert.equal(sampledSubject?.status, 'active');
      assert.ok(sampledSubject?.roles.some(role => role.role === 'Shop.review'));
      assert.deepEqual(await memberships.findMembership(caller.team_id, caller.user_id), sampledCaller);
      assert.deepEqual(await memberships.findMembership(subject.team_id, subject.user_id), sampledSubject);
      assert.deepEqual(await projectScenarioReceipt({ ...w, registry, policy, memberships, receipt }),
        { result: null, records: [] });
      assert.deepEqual(await snapshot(), before);
    }
  });

  it('accepts final provisional own-row reads and refuses intermediate or uncaptured reads before domain commit', async () => {
    for (const mode of ['final', 'intermediate', 'missing'] as const) {
      const w = await world();
      const baseline = await w.store.load(MODEL, w.row.id); assert.ok(baseline);
      const next = { ...baseline, version: asVersion(baseline.version + 1), data: { ...baseline.data, visible: 'final staged' } };
      const execution = invoke({ ...w, execute: async call => {
        if (mode !== 'missing') await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'value', model: MODEL,
          row: mode === 'final' ? next : { ...next, data: { ...next.data, visible: 'intermediate staged' } }, field: 'visible' });
        selectScenarioReceiptReturn(call, w.store, 'record-result');
        return { ...emptyEffects(mode === 'final' ? 'final staged' : 'intermediate staged'), writes: [{ kind: 'update' as const,
          model: MODEL, id: next.id, expectedVersion: w.row.version, row: next }] };
      } });
      if (mode === 'final') {
        assert.equal((await execution).status, 'committed');
        const receipt = await w.store.readReceipt({ app: APP, owner: w.member.team.team_id,
          principal: w.member.user.user_id, operation: OP as Receipt['identity']['operation'],
          operationId: w.envelope.operation_id as Receipt['identity']['operationId'] }); assert.ok(receipt);
        assert.equal((await projectScenarioReceipt({ ...w, receipt })).result, 'final staged');
      } else {
        await assert.rejects(execution, validation);
        assert.deepEqual(await w.store.load(MODEL, w.row.id), baseline);
      }
    }
  });

  it('refuses copied/outside-lifetime calls, unbound descriptors, forged associations, and capture drift without trusting object shape', async () => {
    const w = await world(); let admitted: Parameters<typeof selectScenarioReceiptReturn>[0] | undefined;
    await assert.rejects(invoke({ ...w, execute: async call => {
      admitted = call;
      assert.throws(() => selectScenarioReceiptReturn({ ...call }, w.store, 'literal-result'), forbidden);
      assert.throws(() => selectScenarioReceiptReturn(call, { ...w.store }, 'literal-result'), forbidden);
      const def = Object.getOwnPropertyDescriptor(call, 'def')!;
      let getterCalls = 0;
      Object.defineProperty(call, 'def', { configurable: true, enumerable: true,
        get: () => { getterCalls += 1; return def.value; } });
      assert.throws(() => selectScenarioReceiptReturn(call, w.store, 'literal-result'), forbidden);
      assert.equal(getterCalls, 0); Object.defineProperty(call, 'def', def);
      const observation = { dependencyId: 'value', model: MODEL, row: call.recordRefs[0]!.row, field: 'visible' };
      Object.defineProperty(observation, 'field', { enumerable: true, get: () => { getterCalls += 1; return 'visible'; } });
      await assert.rejects(observeScenarioReceiptDependency(call, w.store, observation), validation);
      assert.equal(getterCalls, 0);
      const originalApp = call.context.app; (call.context as { app: string }).app = 'forged-app';
      assert.throws(() => selectScenarioReceiptReturn(call, w.store, 'literal-result'), forbidden);
      (call.context as { app: string }).app = originalApp;
      assert.ok(call.checkpoint);
      const originalOwner = call.checkpoint.owner;
      (call.checkpoint as { owner: string }).owner = 'forged-owner';
      assert.throws(() => selectScenarioReceiptReturn(call, w.store, 'literal-result'), forbidden);
      (call.checkpoint as { owner: string }).owner = originalOwner;
      await assert.rejects(observeScenarioReceiptDependency(call, w.store, { dependencyId: 'value', model: MODEL,
        row: call.recordRefs[0]!.row, field: 'private' }), validation);
      assert.throws(() => selectScenarioReceiptReturn(call, w.store, 'literal-result'), validation);
      return emptyEffects('literal');
    } }), validation);
    assert.ok(admitted); assert.throws(() => selectScenarioReceiptReturn(admitted!, w.store, 'literal-result'), forbidden);
    await assert.rejects(observeScenarioReceiptDependency(admitted!, w.store, {
      dependencyId: 'value', model: MODEL, row: w.row, field: 'visible',
    }), forbidden);
    const fresh = await world();
    await assert.rejects(invoke({ ...fresh, execute: async call => {
      selectScenarioReceiptReturn(call, fresh.store, 'literal-result');
      return { ...emptyEffects('literal'), scenario: {} } as ExecutionEffects;
    } }), validation);
    const unboundWorld = await world();
    const unbound = new Map(unboundWorld.registry); const def = unbound.get(OP)!; unbound.set(OP, { ...def });
    await assert.rejects(invoke({ ...unboundWorld, registry: unbound, execute: async call => {
      selectScenarioReceiptReturn(call, unboundWorld.store, 'literal-result'); return emptyEffects('literal');
    } }), validation);
  });

  it('saves an implicit checked void result and projects its changed snapshots without an invented business return', async () => {
    const w = await world(); const slice = artifact();
    slice.operations![0]!.result = { type: 'void' as CanTypeId,
      disclosure: { ...plan(), returns: [{ id: 'implicit-return', source: origin(), influences: [], dependencies: [] }] } };
    const registry = loadArtifactDescriptors(slice, { by: 'members' }).registry;
    let receipt: Receipt | undefined;
    await invoke({ ...w, registry, execute: async call => {
      const original = call.recordRefs[0]!.row;
      return { ...emptyEffects(null), writes: [{ kind: 'update', model: MODEL, id: original.id,
        expectedVersion: original.version, row: { ...original, version: asVersion(original.version + 1),
          data: { ...original.data, visible: 'void changed snapshot' } } }] };
    }, observeCommittedReceipt: value => { receipt = value; } });
    assert.ok(receipt);
    const projected = await projectScenarioReceipt({ ...w, registry, receipt });
    assert.equal(projected.result, null); assert.equal(projected.records[0]!.data['visible'], 'void changed snapshot');
    assert.equal(readScenarioReceiptAssociation(receipt)?.returnId, 'implicit-return');
  });

  it('withholds influenced changes when a required scalar becomes a file, model reference, or another scalar type', async () => {
    const w = await world(); const receipt = await save(w);
    for (const tag of [{ kind: 'file' as const }, { kind: 'ref' as const, model: MODEL }, { kind: 'integer' as const }]) {
      const slice = artifact(); const changed = slice.models![0]!.fields.find(field => field.name === 'visible')!;
      changed.field = tag;
      slice.operations![0]!.result = { type: 'text' as CanTypeId,
        disclosure: { ...plan(), returns: [{ id: 'literal-result', source: origin(), influences: [], dependencies: [] }] } };
      const registry = loadArtifactDescriptors(slice, { by: 'members' }).registry;
      const projected = await projectScenarioReceipt({ ...w, registry, receipt });
      assert.equal(projected.result, null);
      assert.deepEqual(projected.records, []);
    }
  });

  it('rejects source/callable/schema drift, open or unsupported plans and intake-only claims; original and current secrecy are both applied', async () => {
    for (const mutate of [
      (slice: ArtifactDescriptorSlice) => { slice.sources = [{ path: 'other.can', sha256: 'b'.repeat(64) }]; },
      (slice: ArtifactDescriptorSlice) => { slice.callables![0]!.module = 'foreign.mjs'; },
      (slice: ArtifactDescriptorSlice) => { slice.operations![0]!.result = { type: 'file' as CanTypeId, disclosure: plan() }; },
      (slice: ArtifactDescriptorSlice) => { (slice.operations![0]!.result!.disclosure!.returns[0]!.dependencies[0]! as { field: string }).field = 'unknown'; },
      (slice: ArtifactDescriptorSlice) => { (slice.operations![0]!.result!.disclosure as unknown as { version: number }).version = 2; },
      (slice: ArtifactDescriptorSlice) => { (slice.operations![0]!.result!.disclosure as unknown as Record<string, unknown>)['extra'] = true; },
      (slice: ArtifactDescriptorSlice) => { (slice.operations![0]!.result!.disclosure!.returns[0]!.dependencies[0]!.source as { path: string }).path = 'unverified-callee.can'; },
    ]) { const slice = artifact(); mutate(slice); assert.throws(() => loadArtifactDescriptors(slice, { by: 'members' })); }
    const loaded = loadArtifactDescriptors(artifact(), { by: 'members' });
    assert.throws(() => loadExecutionDescriptorSet({ contractVersion: 1, models: loaded.models,
      operations: [...loaded.registry.values()].map(def => 'descriptor' in def ? def.descriptor : (() => { throw new Error('generated'); })()) }, { by: 'members' }));
    const w = await world(); const receipt = await save(w);
    const changed = artifact();
    changed.models![0]!.fields.find(field => field.name === 'private')!.field = { kind: 'secret' };
    const field = changed.models![0]!.fields.find(field => field.name === 'private')!;
    field.serverOnly = true; field.required = false; field.default = { kind: 'server', init: 'random_secret' };
    changed.operations![0]!.result = { type: 'text' as CanTypeId, disclosure: { ...plan(), returns: plan().returns.slice(0, 2) } };
    const declassified = changed.models![0]!.fields.find(field => field.name === 'token')!;
    declassified.field = { kind: 'string' }; declassified.serverOnly = false; delete declassified.default;
    const current = loadArtifactDescriptors(changed, { by: 'members' }).registry;
    const projected = await projectScenarioReceipt({ ...w, registry: current, receipt });
    assert.equal(projected.result, 'original visible');
    assert.equal(Object.hasOwn(projected.records[0]!.data, 'private'), false);
    assert.equal(Object.hasOwn(projected.records[0]!.data, 'token'), false);
    let getterCalls = 0;
    const malformed = structuredClone(receipt);
    Object.defineProperty(malformed.outcome, 'scenario', { enumerable: true, get: () => { getterCalls += 1; return {}; } });
    await assert.rejects(projectScenarioReceipt({ ...w, receipt: malformed }), validation);
    assert.equal(getterCalls, 0);
  });

  it('refuses inherited disclosure claims in both loaders without evaluating prototype accessors and preserves unclaimed legacy results', () => {
    const legacy = artifact();
    legacy.operations![0]!.result = { type: 'text' as CanTypeId };
    const loaded = loadArtifactDescriptors(legacy, { by: 'members' });
    const def = [...loaded.registry.values()][0]!;
    assert.ok('descriptor' in def);
    assert.deepEqual(def.descriptor.result, { type: 'text' });
    assert.doesNotThrow(() => loadExecutionDescriptorSet({ contractVersion: 1, models: loaded.models,
      operations: [def.descriptor] }, { by: 'members' }));
    let getterCalls = 0;
    const getterPrototype = Object.defineProperty({}, 'disclosure', {
      get: () => { getterCalls++; throw new Error('Inherited disclosure getter must not execute'); },
    });
    for (const prototype of [{ disclosure: plan() }, getterPrototype]) {
      const result = Object.assign(Object.create(prototype) as { type: CanTypeId }, { type: 'text' as CanTypeId });
      const slice = artifact(); slice.operations![0]!.result = result;
      assert.throws(() => loadArtifactDescriptors(slice, { by: 'members' }), /disclosure requires own data/);
      assert.throws(() => loadExecutionDescriptorSet({ contractVersion: 1, models: loaded.models,
        operations: [{ ...def.descriptor, result }] }, { by: 'members' }), /disclosure requires own data/);
    }
    assert.equal(getterCalls, 0);
  });

  it('checks every imported site origin and refuses query/absent-reference influence instead of treating empty observations as proof', async () => {
    const slice = artifact();
    slice.sources!.push({ path: 'callee.can', sha256: 'b'.repeat(64) });
    slice.modules!.push({ path: 'callee.mjs', js: 'export const pureIdentity="Shop.derive";',
      map: { version: 3, file: 'callee.mjs', sources: ['callee.can'], sourcesContent: [null], names: [], mappings: '' } });
    const disclosure = slice.operations![0]!.result!.disclosure!;
    const dependency = disclosure.returns[0]!.dependencies[0]!;
    slice.operations![0]!.result = { type: 'text' as CanTypeId, disclosure: { ...disclosure,
      returns: [{ ...disclosure.returns[0]!, dependencies: [{ ...dependency,
        source: { path: 'callee.can', sha256: 'b'.repeat(64), module: 'callee.mjs' } }] }] } };
    const w = await world(slice); const receipt = await save(w, false);
    assert.equal((await projectScenarioReceipt({ ...w, receipt })).result, 'original visible');
    assert.equal(readScenarioReceiptAssociation(receipt)!.observations[0]!.dependencyId, 'value');
    for (const kind of ['query-existence', 'query-cardinality', 'query-membership', 'query-order', 'absent-reference'] as const) {
      const unsupported = artifact();
      unsupported.operations![0]!.result = { type: 'text' as CanTypeId, disclosure: { ...plan(),
        returns: [{ id: 'influenced-result', source: origin(), dependencies: [], influences: [{ id: 'fact', kind }] }] } };
      assert.throws(() => loadArtifactDescriptors(unsupported, { by: 'members' }), /query\/absence return influence is unsupported/);
    }
  });
});
