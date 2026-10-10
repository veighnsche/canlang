/** Finite State controls through genuine Invoke/MemoryStorage, owning Values
 * users and the existing Identity MembershipReader fixture. Hand-built v1
 * recipes/native frames exercise this component, not generated source or Dev. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ClosedInputs, Membership, Receipt } from '@canlang/contracts';
import { makeUserRef } from '@canlang/values';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildModelTable } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice, type GeneratedOperationDef } from '../../src/invocation/registry.js';
import { invoke, type ExecutionEffects } from '../../src/invocation/invoke.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptMembershipProducer, evaluateScenarioReceiptMembership,
  bindScenarioReceiptCallProducer, invokeScenarioReceiptCall, bindScenarioReceiptQueryProducer,
  executeScenarioReceiptQuery, observeScenarioReceiptQueryDependency, selectScenarioReceiptReturn,
  type ScenarioReceiptMembershipSite, type ScenarioReceiptMembershipProducer } from '../../src/invocation/scenario-receipt.js';
import { checkScenarioReceiptMembershipSites } from '../../src/invocation/scenario-membership-plan.js';
import { FIXED_NOW, asModel, createMemoryIdentityStore, makeEnvelope, makeIdentity, seedMember, seedRow, uuidv7 } from './fixtures.js';
import { field, modelDef } from '../mutation/fixtures.js';

const MODEL = asModel('Membership.Task'), ROOT = 'Membership.review', CHILD = 'Membership.check';
const APP = 'membership-owner-app', bounds = { maxRows: 10, maxWork: 1000 }, cause = { cause: 'scenario' } as const;
let sequence = 110000;
const source = () => ({ path: 'membership.can', sha256: 'a'.repeat(64), module: 'membership.mjs' });
const isStateError = (error: unknown) => error instanceof StateError;
const empty = (): ExecutionEffects => ({ result: null, writes: [], history: [], outbox: [], schedules: [],
  uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {} });
function recipe(owner = ROOT, stage: ScenarioReceiptMembershipSite['stage'] = 'body-require', offset = 10): ScenarioReceiptMembershipSite {
  return { version: 1, source: source(), owner, node: { start: offset, end: offset + 20 },
    statement: { start: offset - 1, end: offset + 21 }, stage, position: [{ kind: 'body', index: offset }], calls: [{
      source: source(), node: { start: offset + 1, end: offset + 19 }, target: { kind: 'builtin', id: 'active_member', overload: 0 },
      arguments: [{ node: { start: offset + 2, end: offset + 3 }, type: 'user' },
        { node: { start: offset + 4, end: offset + 5 }, type: 'team' }], slots: [0, 1], defaults: [], chain: [],
    }] };
}
function artifact(query = false): ArtifactDescriptorSlice {
  const disclosure = (id: string) => ({ version: 1 as const, source: source(), returns: [
    { id, source: source(), dependencies: [], influences: [] },
  ], ...(query ? { queries: [{ id: 'tasks', source: source(), model: MODEL, order: [], limit: null,
    archived: 'exclude' as const, dependencies: [{ id: 'person-control', source: source(), role: 'control' as const,
      field: 'person', type: 'user' as CanTypeId }] }] } : {}) });
  return { artifact_version: 1, sources: [{ path: source().path, sha256: source().sha256 }],
    modules: [{ path: source().module, js: 'export const identity="Membership.review";', map: {
      version: 3, file: source().module, sources: [source().path], sourcesContent: [null], names: [], mappings: '',
    } }], callables: [ROOT, CHILD].map(id => ({ id, kind: 'operation' as const, module: source().module,
      export: 'identity', member: [id.split('.').at(-1)!] })),
    models: [{ name: MODEL, deleteMode: 'archive', fields: [
      { name: 'approved', field: { kind: 'boolean' }, required: true, serverOnly: false },
      { name: 'person', field: { kind: 'user' }, required: true, serverOnly: false },
    ] }], operations: [ROOT, CHILD].map(name => ({ name, kind: 'scenario' as const, description: '', inputs: { fields: [] },
      result: { type: 'void' as CanTypeId, disclosure: disclosure(name === ROOT ? 'root-return' : 'child-return') } })),
  };
}
async function world(options: { active?: boolean; query?: boolean } = {}) {
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const actor = await seedMember(memberships, { isOwner: false });
  const subject = await memberships.createUser('subject@example.test');
  const member = options.active === false ? null : await memberships.createMembership({ team_id: actor.team.team_id,
    user_id: subject.user_id, is_owner: false, roles: [] });
  const identity = makeIdentity({ userId: actor.user.user_id, team: actor.team, membership: actor.membership });
  const loaded = loadArtifactDescriptors(artifact(options.query), { by: 'public' });
  const parent = loaded.registry.get(ROOT), child = loaded.registry.get(CHILD);
  assert.ok(parent && isGeneratedOperationDef(parent)); assert.ok(child && isGeneratedOperationDef(child));
  const table = buildModelTable([modelDef(MODEL, { fields: { approved: field({ required: true }), person: field({ required: true }) } })]);
  const row = await seedRow(store, MODEL, { data: { approved: false, person: subject.user_id } });
  const policy = buildPolicyTable([{ model: MODEL, secretFields: [], grants: [{ by: 'public', fields: ['approved', 'person'] }] }]);
  return { store, memberships, actor, subject, member, identity, parent, child, table, row, policy, registry: loaded.registry,
    app: APP, source: 'test', clock: { nowMs: () => FIXED_NOW },
    envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {}) };
}
type World = Awaited<ReturnType<typeof world>>;
/** Test-only analogue of Dev's private once-only evaluated argument staging.
 * The public observer input never carries this pair. No frame survives read. */
function native(w: World, def: GeneratedOperationDef = w.parent, sites = [recipe(def.name)]) {
  const frames = new WeakMap<AdmittedCall, { person: ReturnType<typeof makeUserRef>; team: NonNullable<AdmittedCall['context']['team']> }>();
  let captures = 0;
  const handles = bindScenarioReceiptMembershipProducer(def, { source: source(), app: APP, sites,
    capture: (call, owningSite, callIndex) => {
      captures++; assert.equal(owningSite.owner, def.name); assert.ok(Object.isFrozen(owningSite));
      assert.equal(owningSite.calls[callIndex]!.target.kind, 'builtin');
      const frame = frames.get(call); frames.delete(call);
      if (frame === undefined) throw new StateError('validation', 'No actual privately staged native argument pair.');
      return frame;
    },
  });
  return { handles, frames, get captures() { return captures; },
    stage(call: AdmittedCall, person = w.subject.user_id, team = call.context.team) {
      assert.ok(team); assert.equal(frames.has(call), false);
      frames.set(call, { person: makeUserRef(person), team });
    },
    async evaluate(call: AdmittedCall, person = w.subject.user_id, site = handles[0]!) {
      this.stage(call, person); return evaluateScenarioReceiptMembership(call, w.store, { site });
    },
  };
}
async function finish(call: AdmittedCall, w: World, session: Awaited<ReturnType<typeof beginScenarioReceiptMutation>>) {
  selectScenarioReceiptReturn(call, w.store, 'root-return');
  const result = await session.finalize(); return { ...result, outbox: result.outbox ?? [], result: null };
}
async function business(w: World) { return { row: await w.store.load(MODEL, w.row.id),
  history: await w.store.historyFor(MODEL, w.row.id), outbox: await w.store.outboxPending() }; }

for (const active of [true, false]) test(`actual ${active ? 'positive' : 'negative'} membership returns to its expression, commits once and exact replay skips native capture`, async () => {
  const w = await world({ active }), producer = native(w); let executions = 0, commits = 0, saved: AdmittedCall | undefined, receipt: Receipt | undefined;
  const commit = w.store.commit; w.store.commit = async batch => { commits++; return commit(batch); };
  const input = { ...w, execute: async (call: AdmittedCall) => {
    executions++; saved = call;
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    let tail = 0;
    const decision = active ? await producer.evaluate(call) && (++tail, true) : !await producer.evaluate(call) && (++tail, true);
    assert.equal(decision, true); assert.equal(tail, 1);
    await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { approved: true } }, cause);
    return finish(call, w, session);
  }, observeCommittedReceipt: (value: Receipt) => { receipt = value; } };
  assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt); assert.equal(commits, 1);
  assert.equal(producer.captures, 1); const before = await business(w);
  assert.equal((await invoke(input)).status, 'replayed'); assert.equal(executions, 1); assert.equal(commits, 1); assert.equal(producer.captures, 1);
  assert.deepEqual(await business(w), before);
  assert.ok(saved); await assert.rejects(evaluateScenarioReceiptMembership(saved, w.store, { site: producer.handles[0]! }), isStateError);
});

test('actual evaluated subject membership is independent of actor roles and other teams', async () => {
  const w = await world({ active: false }), producer = native(w);
  const other = await w.memberships.createTeam();
  await w.memberships.createMembership({ team_id: other.team_id, user_id: w.subject.user_id, is_owner: true, roles: [] });
  assert.equal((await invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    assert.equal(await producer.evaluate(call), false);
    assert.equal(await producer.evaluate(call, w.actor.user.user_id), true);
    assert.equal(producer.captures, 2); return finish(call, w, session);
  } })).status, 'committed');
});

for (const trusted of [false, true]) for (const initiallyActive of [true, false]) test(`${trusted ? 'trusted' : 'public'} outer commit refuses ${initiallyActive ? 'removed positive' : 'activated negative'} membership without source re-evaluation`, async () => {
  const w = await world({ active: initiallyActive }), producer = native(w), before = await business(w);
  await assert.rejects(invoke({ ...w, ...(trusted ? { kind: 'trusted' as const, trustedSource: 'Membership.handler' } : {}), execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    assert.equal(await producer.evaluate(call), initiallyActive);
    await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { approved: true } }, cause);
    const result = await finish(call, w, session);
    if (w.member) await w.memberships.removeMembership(w.member.membership_id);
    else await w.memberships.createMembership({ team_id: w.actor.team.team_id, user_id: w.subject.user_id, is_owner: false, roles: [] });
    return result;
  } }), isStateError);
  assert.equal(producer.captures, 1); assert.deepEqual(await business(w), before);
});

test('removed subject is a genuine negative decision', async () => {
  const w = await world(), producer = native(w); assert.ok(w.member);
  await w.memberships.removeMembership(w.member.membership_id);
  assert.equal((await invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    assert.equal(await producer.evaluate(call), false); return finish(call, w, session);
  } })).status, 'committed');
});

test('guard compares the actual bool rather than role metadata or historical membership row identity', async () => {
  const w = await world(), producer = native(w), original = w.memberships.findMembership;
  let changed = false;
  w.memberships.findMembership = async (team, user) => {
    const found = await original(team, user);
    return found !== null && user === w.subject.user_id && changed ? { ...found, is_owner: true,
      roles: [{ role: 'Membership.manager', granted_at: new Date(FIXED_NOW).toISOString(), granted_by: w.actor.user.user_id }] } : found;
  };
  assert.equal((await invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    assert.equal(await producer.evaluate(call), true);
    const effects = await finish(call, w, session); changed = true; return effects;
  } })).status, 'committed');
  assert.equal(producer.captures, 1);
});

test('source order retains distinct observations before and after actual owner writes', async () => {
  const w = await world(), producer = native(w, w.parent, [recipe(ROOT, 'leading-require', 10), recipe(ROOT, 'body-require', 50)]);
  const order: string[] = [];
  assert.equal((await invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    assert.equal(await producer.evaluate(call, w.subject.user_id, producer.handles[0]!), true); order.push('leading');
    await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { approved: true } }, cause); order.push('write');
    assert.equal((await session.read(MODEL, w.row.id))!.data['approved'], true);
    assert.equal(await producer.evaluate(call, w.subject.user_id, producer.handles[1]!), true); order.push('body');
    // Lazy source branches issue no native frame or observation.
    const skipped = false && await producer.evaluate(call); assert.equal(skipped, false);
    return finish(call, w, session);
  } })).status, 'committed');
  assert.deepEqual(order, ['leading', 'write', 'body']); assert.equal(producer.captures, 2);
});

for (const mode of ['copy-call', 'copy-handle', 'fabricated', 'foreign-handle', 'store', 'team-copy', 'team-other', 'missing-native', 'leading-stage', 'dispatch'] as const) test(`${mode} refuses and caught observer failure poisons its owner`, async () => {
  const w = await world(), producer = native(w, w.parent, [recipe(ROOT, mode === 'dispatch' ? 'send-dispatch' : mode === 'leading-stage' ? 'leading-require' : 'body-require')]);
  const foreign = mode === 'foreign-handle' ? native(w, w.child) : null;
  const before = await business(w);
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { approved: true } }, cause);
    if (mode !== 'missing-native') producer.stage(call, w.subject.user_id,
      mode === 'team-copy' ? { ...call.context.team! } : mode === 'team-other' ? { ...call.context.team!, teamId: 'other-team' } : call.context.team);
    const site = mode === 'copy-handle' ? { ...producer.handles[0] } : mode === 'fabricated' ? Object.freeze({}) : foreign?.handles[0] ?? producer.handles[0]!;
    await assert.rejects(evaluateScenarioReceiptMembership(mode === 'copy-call' ? { ...call } : call,
      mode === 'store' ? { ...w.store } : w.store, { site }), isStateError);
    await assert.rejects(session.finalize(), isStateError); return empty();
  } }), isStateError);
  assert.deepEqual(await business(w), before);
});

for (const mode of ['wrong-team', 'wrong-user', 'unknown-status', 'undefined', 'failure'] as const) test(`Identity ${mode} refuses rather than returning false`, async () => {
  const w = await world(), producer = native(w), original = w.memberships.findMembership, before = await business(w);
  w.memberships.findMembership = async (team, user) => {
    const row = await original(team, user);
    if (user !== w.subject.user_id) return row;
    if (mode === 'failure') throw new Error('Identity unavailable');
    if (mode === 'undefined') return undefined as unknown as Membership;
    assert.ok(row);
    return { ...row, ...(mode === 'wrong-team' ? { team_id: 'foreign-team' } : mode === 'wrong-user'
      ? { user_id: 'foreign-user' } : { status: 'pending' }) } as Membership;
  };
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await assert.rejects(producer.evaluate(call)); await assert.rejects(session.finalize(), isStateError); return empty();
  } }));
  assert.deepEqual(await business(w), before);
});

for (const mode of ['bare-user', 'wrong-app'] as const) test(`${mode} cannot supply native membership provenance`, async () => {
  const w = await world(), before = await business(w);
  const handles = bindScenarioReceiptMembershipProducer(w.parent, { source: source(), app: mode === 'wrong-app' ? 'foreign-app' : APP,
    sites: [recipe()], capture: call => ({ person: Object.freeze({ id: w.subject.user_id }) as ReturnType<typeof makeUserRef>, team: call.context.team! }) });
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await assert.rejects(evaluateScenarioReceiptMembership(call, w.store, { site: handles[0]! }), isStateError);
    await assert.rejects(session.finalize(), isStateError); return empty();
  } }), isStateError);
  assert.deepEqual(await business(w), before);
});

test('a source handle can repeat only through fresh private native evaluated pairs', async () => {
  const w = await world(), producer = native(w), before = await business(w);
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    assert.equal(await producer.evaluate(call), true);
    await assert.rejects(evaluateScenarioReceiptMembership(call, w.store, { site: producer.handles[0]! }), isStateError);
    await assert.rejects(session.finalize(), isStateError); return empty();
  } }), isStateError);
  assert.equal(producer.captures, 2); assert.deepEqual(await business(w), before);
});

test('concurrent observer reads and owner stages cannot finalize after caught failure', async () => {
  const w = await world(), producer = native(w), original = w.memberships.findMembership;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  w.memberships.findMembership = async (team, user) => {
    if (user === w.subject.user_id) { entered(); await gate; } return original(team, user);
  };
  const before = await business(w);
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const first = producer.evaluate(call); await ready;
    try { await assert.rejects(session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { approved: true } }, cause), isStateError); }
    finally { release(); }
    await assert.rejects(first, isStateError); await assert.rejects(session.finalize(), isStateError); return empty();
  } }), isStateError);
  assert.deepEqual(await business(w), before);
});

test('same-owner child uses the immediate admitted child Team and retains the membership guard in the root commit', async () => {
  const w = await world(), child = native(w, w.child), root = native(w); let saved: AdmittedCall | undefined;
  bindScenarioReceiptCallProducer(w.parent, { source: source(), app: APP, registry: w.registry,
    sites: [{ id: 'child', source: source(), kind: 'operation', targets: [{ operation: CHILD, interface: w.child.descriptor }], resultType: 'void' as CanTypeId }],
    prepare: (_def, inputs) => inputs as ClosedInputs, execute: async frame => {
      saved = frame.call;
      assert.equal(await child.evaluate(frame.call), true);
      selectScenarioReceiptReturn(frame.call, w.store, 'child-return'); return null;
    },
  });
  const before = await business(w);
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    assert.equal(await root.evaluate(call), true);
    await invokeScenarioReceiptCall(call, w.store, { site: 'child', target: CHILD, inputs: {} });
    assert.ok(saved);
    await assert.rejects(evaluateScenarioReceiptMembership(saved, w.store, { site: child.handles[0]! }), isStateError);
    await assert.rejects(session.finalize(), isStateError); return empty();
  } }), isStateError);
  assert.deepEqual(await business(w), before); assert.equal(child.captures, 1);
});

for (const revoke of [false, true]) test(`child membership ${revoke ? 'revocation reaches mandatory outer guard' : 'and source captures share one successful root commit'}`, async () => {
  const w = await world(), child = native(w, w.child); let commits = 0;
  const commit = w.store.commit; w.store.commit = async batch => { commits++; return commit(batch); };
  bindScenarioReceiptCallProducer(w.parent, { source: source(), app: APP, registry: w.registry,
    sites: [{ id: 'child', source: source(), kind: 'operation', targets: [{ operation: CHILD, interface: w.child.descriptor }], resultType: 'void' as CanTypeId }],
    prepare: (_def, inputs) => inputs as ClosedInputs, execute: async frame => {
      assert.equal(await child.evaluate(frame.call), true);
      await frame.session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { approved: true } }, cause);
      selectScenarioReceiptReturn(frame.call, w.store, 'child-return'); return null;
    },
  });
  const before = await business(w), execution = invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await invokeScenarioReceiptCall(call, w.store, { site: 'child', target: CHILD, inputs: {} });
    const result = await finish(call, w, session);
    if (revoke) { assert.ok(w.member); await w.memberships.removeMembership(w.member.membership_id); }
    return result;
  } });
  if (revoke) { await assert.rejects(execution, isStateError); assert.deepEqual(await business(w), before); assert.equal(commits, 0); }
  else { assert.equal((await execution).status, 'committed'); assert.equal(commits, 1);
    assert.equal((await business(w)).row!.data['approved'], true); }
  assert.equal(child.captures, 1);
});

test('query predicate observes every actual positive/negative candidate through its active private slot', async () => {
  const w = await world({ query: true }), producer = native(w);
  const outsider = await w.memberships.createUser('outsider@example.test');
  await seedRow(w.store, MODEL, { id: 'outsider-task', data: { approved: false, person: outsider.user_id } });
  bindScenarioReceiptQueryProducer(w.parent, { source: source(), app: APP, policy: w.policy });
  const decisions: boolean[] = [];
  assert.equal((await invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const result = await executeScenarioReceiptQuery(call, w.store, { queryId: 'tasks', predicate: async ({ slot, record }) => {
      observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: 'person-control' });
      assert.equal(typeof record.data['person'], 'string');
      const decision = await producer.evaluate(call, record.data['person'] as string); decisions.push(decision); return decision;
    } });
    assert.equal(result.count, 1); assert.deepEqual(decisions.sort(), [false, true]);
    return finish(call, w, session);
  } })).status, 'committed');
  assert.equal(producer.captures, 2);
});

test('recipe checker preserves exact transitive source/default/type vocabulary, rejects open or incomplete shapes', () => {
  const site = recipe();
  const helperSource = { path: 'helper.can', sha256: 'b'.repeat(64), module: 'helper.mjs' };
  const transitive: ScenarioReceiptMembershipSite = { ...site, calls: [{ source: source(), node: { start: 10, end: 12 },
    target: { kind: 'derive', name: 'Membership.helper' }, arguments: [{ node: { start: 10, end: 11 }, type: 'user' }], slots: [0, null],
    defaults: [{ parameter: 'Membership.helper.team', source: helperSource, node: { start: 100, end: 104 }, type: 'team' }], chain: [],
  }, { ...site.calls[0]!, source: helperSource, node: { start: 110, end: 120 },
    chain: [{ source: source(), node: { start: 10, end: 12 }, derive: 'Membership.helper' }] }] };
  const checked = checkScenarioReceiptMembershipSites([transitive]);
  assert.deepEqual(checked, [transitive]); assert.ok(Object.isFrozen(checked[0]!.calls[0]!.defaults));
  for (const malformed of [ { ...site, extra: true }, { ...site, version: 2 }, { ...site, owner: '' },
    { ...site, calls: [{ ...site.calls[0], slots: [0, 0] }] },
    { ...site, calls: [{ ...site.calls[0], arguments: [{ node: { start: 11, end: 12 }, type: 'user?' }, site.calls[0]!.arguments[1]] }] },
    { ...site, calls: [{ ...site.calls[0], defaults: [{ parameter: 'x', source: source(), node: { start: 1, end: 2 }, type: 'team' }] }] },
    { ...site, calls: [{ ...site.calls[0], chain: Array.from({ length: 17 }, (_, index) => ({ source: source(), node: { start: index, end: index + 1 }, derive: `Helper.${index}` })) }] },
  ]) assert.throws(() => checkScenarioReceiptMembershipSites([malformed]), isStateError);
});

test('metadata cannot activate and loader producer binds only once before observed execution', async () => {
  const w = await world();
  const producer: ScenarioReceiptMembershipProducer = { source: source(), app: APP, sites: [recipe()], capture: () => { throw new Error('not active'); } };
  assert.throws(() => bindScenarioReceiptMembershipProducer({ ...w.parent }, producer), isStateError);
  assert.throws(() => bindScenarioReceiptMembershipProducer(w.parent, { ...producer, source: { ...source(), sha256: 'f'.repeat(64) } }), isStateError);
  const handles = bindScenarioReceiptMembershipProducer(w.parent, producer); assert.equal(handles.length, 1);
  assert.throws(() => bindScenarioReceiptMembershipProducer(w.parent, producer), isStateError);
  const late = await world();
  assert.equal((await invoke({ ...late, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, late.store, { table: late.table, bounds });
    assert.throws(() => bindScenarioReceiptMembershipProducer(late.parent, producer), isStateError);
    return finish(call, late, session);
  } })).status, 'committed');
});
