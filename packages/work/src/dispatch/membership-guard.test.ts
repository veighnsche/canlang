/** Finite fixture/native-port checks through actual Work executions and State
 * MemoryStorage. The MembershipReader and private native staging are fixtures;
 * this does not qualify Identity/Dev admission, compilation or source activation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, Membership, ResolvedIdentity, Team } from '@canlang/contracts';
import { makeUserRef } from '@canlang/values';
import { bindScenarioDispatchMembershipProducer, type MembershipReader,
  type ScenarioDispatchMembershipExecution, type ScenarioDispatchMembershipHandle,
  type ScenarioDispatchMembershipPorts, type ScenarioReceiptMembershipSite } from '@canlang/state';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { loadArtifactDescriptors, isGeneratedOperationDef,
  type ArtifactDescriptorSlice } from '@canlang/state/invocation/registry';
import { stageOutboxIntent, commitOutboxIntent } from '../intent/index.js';
import { attemptDispatchAsync, readDispatchGuardExecution, registerDispatchGuardRevalidation,
  type AsyncDispatchAttempt, type AsyncDispatchDeps, type DispatchGuardExecution } from './index.js';

const ROOT = 'Membership.review', PREDICATE = 'Membership.current', APP = 'membership-owner-app';
const NOW = '2026-10-10T00:00:00.000Z';
const source = () => ({ path: 'membership.can', sha256: 'a'.repeat(64), module: 'membership.mjs' });
function recipe(offset = 10): ScenarioReceiptMembershipSite {
  return { version: 1, source: source(), owner: ROOT, node: { start: offset, end: offset + 20 },
    statement: { start: offset - 1, end: offset + 21 }, stage: 'send-dispatch', position: [{ kind: 'body', index: offset }], calls: [{
      source: source(), node: { start: offset + 1, end: offset + 19 }, target: { kind: 'builtin', id: 'active_member', overload: 0 },
      arguments: [{ node: { start: offset + 2, end: offset + 3 }, type: 'user' }, { node: { start: offset + 4, end: offset + 5 }, type: 'Team' }],
      slots: [0, 1], defaults: [], chain: [],
    }] };
}
function artifact(): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: source().path, sha256: source().sha256 }],
    modules: [{ path: source().module, js: 'export const identity="Membership.review";', map: {
      version: 3, file: source().module, sources: [source().path], sourcesContent: [null], names: [], mappings: '',
    } }], callables: [{ id: ROOT, kind: 'operation', module: source().module, export: 'identity', member: ['review'] }],
    models: [], operations: [{ name: ROOT, kind: 'scenario', description: '', inputs: { fields: [] }, result: {
      type: 'void' as CanTypeId, disclosure: { version: 1, source: source(), returns: [
        { id: 'root-return', source: source(), dependencies: [], influences: [] },
      ] },
    } }],
  };
}
function member(user = 'subject', team = 'team-a'): Membership {
  return { membership_id: `member-${user}`, team_id: team, user_id: user, is_owner: false,
    roles: [], status: 'active', created_at: NOW, updated_at: NOW };
}
async function world(active = true, predicate = PREDICATE) {
  const store = createMemoryStorage();
  await store.commit({ expectedRevision: await store.readRevision(), writes: [], history: [], receipt: null,
    outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [] });
  const def = loadArtifactDescriptors(artifact(), { by: 'public' }).registry.get(ROOT);
  assert.ok(def && isGeneratedOperationDef(def));
  const team: Team = { team_id: 'team-a', timezone: 'UTC', created_at: NOW };
  const rows = new Map<string, Membership>(active ? [['subject', member()]] : []);
  let reads = 0, captures = 0, admissions = 0;
  const memberships: MembershipReader = { async findMembership(teamId, userId) {
    reads++; const row = rows.get(userId); return row?.team_id === teamId ? row : null;
  } };
  type Pair = { person: ReturnType<typeof makeUserRef>; team: Team };
  const frames = new WeakMap<DispatchGuardExecution, Pair>();
  const ports: ScenarioDispatchMembershipPorts<DispatchGuardExecution> = { source: source(), app: APP, predicate,
    sites: [recipe()], store, memberships, readExecution: readDispatchGuardExecution,
    registerRevalidation: registerDispatchGuardRevalidation,
    admit: () => {
      admissions++;
      // Fresh service-owner fixture, deliberately no business actor/membership.
      const identity: ResolvedIdentity = { actor: null, team, membership: null, binding: { kind: 'none' }, admitted_at: NOW };
      return identity;
    },
    capture: (execution, site, callIndex) => {
      captures++; assert.equal(site.owner, ROOT); assert.ok(Object.isFrozen(site)); assert.equal(callIndex, 0);
      const pair = frames.get(execution); frames.delete(execution);
      if (pair === undefined) throw new Error('missing actual private native pair');
      return pair;
    },
  };
  const producer = bindScenarioDispatchMembershipProducer(def, ports);
  return { store, team, rows, memberships, producer, frames, def, ports,
    get reads() { return reads; }, get captures() { return captures; }, get admissions() { return admissions; },
    stage(execution: DispatchGuardExecution, person = 'subject', actualTeam = team) {
      assert.equal(frames.has(execution), false);
      frames.set(execution, { person: makeUserRef(person), team: actualTeam });
    },
    async evaluate(observer: ScenarioDispatchMembershipExecution, execution: DispatchGuardExecution,
      person = 'subject', site = producer.sites[0]!) {
      this.stage(execution, person); return observer.evaluate({ site });
    },
  };
}
type World = Awaited<ReturnType<typeof world>>;
function attempt(w: World, guard: (execution: DispatchGuardExecution) => boolean | Promise<boolean>) {
  let guards = 0, authorities = 0, claims = 0;
  const deps: AsyncDispatchDeps = { supersessions: { markSuperseded() {}, isSuperseded: () => false },
    availability: { isTargetAvailable: () => true }, clock: { nowMs: () => 100 },
    claimIds: { nextClaimId: () => { claims++; return 'claim-1'; } },
    evaluateGuard: (_predicate, _inputs, _state, execution) => { guards++; return guard(execution); },
  };
  const input: AsyncDispatchAttempt = { intent: commitOutboxIntent(stageOutboxIntent({
    operationId: '0193f2c0-0000-7000-8000-000000000002', source: 'Mail.send', occurrenceIndex: 0,
    request: { to: 'a@test' }, originOccurrence: null,
  }), { revision: 1, committedAtMs: 50 }), guard: { predicate: PREDICATE }, frozenInputs: {}, stateSnapshot: {},
    fence: { checkpoint: { revision: 1, owner: w.team.team_id }, revalidateAuthority: () => { authorities++; return true; } },
  };
  return { input, run: () => attemptDispatchAsync(deps, input),
    get guards() { return guards; }, get authorities() { return authorities; }, get claims() { return claims; } };
}
function noSpend(a: ReturnType<typeof attempt>) { assert.equal(a.authorities, 0); assert.equal(a.claims, 0); }
function gate() {
  let release!: () => void, enter!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  return { pending, entered, release, enter };
}

for (const active of [true, false]) test(`actual ${active} reaches expression and lazy shortcut before dispatch decision`, async () => {
  const w = await world(active); let tail = 0;
  const a = attempt(w, async execution => {
    const observer = w.producer.open(execution);
    const result = await w.evaluate(observer, execution);
    assert.equal(typeof result, 'boolean'); assert.equal(result, active);
    const expression = result && (++tail, true); assert.equal(expression, active);
    assert.equal(false && await w.evaluate(observer, execution), false);
    return result;
  });
  assert.equal((await a.run()).status, active ? 'claimed' : 'skipped');
  assert.equal(tail, active ? 1 : 0); assert.equal(w.captures, 1); assert.equal(w.reads, 2);
  assert.equal(w.admissions, 1); assert.equal(a.guards, 1); assert.equal(a.claims, active ? 1 : 0);
});

test('one source handle repeats with fresh evaluated persons/rows and no global consumption', async () => {
  const w = await world();
  const a = attempt(w, async execution => {
    const observer = w.producer.open(execution);
    for (const [person, expected] of [['subject', true], ['outsider', false], ['subject', true]] as const)
      assert.equal(await w.evaluate(observer, execution, person), expected);
    return true;
  });
  assert.equal((await a.run()).status, 'claimed'); assert.equal(w.captures, 3); assert.equal(w.reads, 6);
});

test('a SEND source occurrence cannot acquire a second predicate, including with changed position metadata', async () => {
  const w = await world(), predicate = 'Membership.anotherSend', sameSite = recipe();
  const original = structuredClone(sameSite);
  assert.throws(() => bindScenarioDispatchMembershipProducer(w.def, { ...w.ports, predicate, sites: [sameSite] }),
    /source occurrence already bound/);
  const movedPosition: ScenarioReceiptMembershipSite = { ...sameSite, position: [{ kind: 'body', index: 99 }] };
  const changed = structuredClone(movedPosition);
  assert.throws(() => bindScenarioDispatchMembershipProducer(w.def, { ...w.ports, predicate, sites: [movedPosition] }),
    /source occurrence already bound/);
  assert.deepEqual(sameSite, original); assert.deepEqual(movedPosition, changed);
  // Failed overlap checks must not reserve the attempted predicate. A real
  // different node under that same new predicate still binds and evaluates.
  const sibling = bindScenarioDispatchMembershipProducer(w.def, { ...w.ports, predicate, sites: [recipe(50)] });
  const a = attempt(w, execution => w.evaluate(sibling.open(execution), execution, 'subject', sibling.sites[0]!));
  a.input.guard = { predicate };
  assert.equal((await a.run()).status, 'claimed'); assert.equal(a.claims, 1);
  assert.equal(w.captures, 1); assert.equal(w.reads, 2);
});

test('two guarded SEND predicates in one genuine owner keep their own current execution and capture ports', async () => {
  const w = await world(), siblingPredicate = 'Membership.secondSend';
  const frames = new WeakMap<DispatchGuardExecution, { person: ReturnType<typeof makeUserRef>; team: Team }>();
  let siblingCaptures = 0, siblingAdmissions = 0, siblingReads = 0;
  // Distinct source anchors are finite fixture recipes. Native correspondence
  // between predicate and source occurrence remains the trusted loader's gate.
  const siblingPorts: ScenarioDispatchMembershipPorts<DispatchGuardExecution> = { ...w.ports,
    predicate: siblingPredicate, sites: [recipe(50)],
    memberships: { async findMembership(team, person) {
      siblingReads++; return team === w.team.team_id && person === 'sibling' ? member('sibling') : null;
    } },
    admit: execution => {
      assert.equal(readDispatchGuardExecution(execution).predicate, siblingPredicate);
      siblingAdmissions++; return { actor: null, team: w.team, membership: null,
        binding: { kind: 'none' }, admitted_at: NOW };
    },
    capture: (execution, site, index) => {
      siblingCaptures++; assert.equal(readDispatchGuardExecution(execution).predicate, siblingPredicate);
      assert.equal(site.node.start, 50); assert.equal(index, 0);
      const pair = frames.get(execution); frames.delete(execution);
      assert.ok(pair, 'actual privately staged sibling arguments required'); return pair;
    },
  };
  const sibling = bindScenarioDispatchMembershipProducer(w.def, siblingPorts);
  assert.throws(() => bindScenarioDispatchMembershipProducer(w.def, w.ports), /predicate/);
  assert.throws(() => bindScenarioDispatchMembershipProducer(w.def, siblingPorts), /predicate/);
  const first = attempt(w, execution => w.evaluate(w.producer.open(execution), execution));
  const second = attempt(w, execution => {
    const observer = sibling.open(execution);
    frames.set(execution, { person: makeUserRef('sibling'), team: w.team });
    return observer.evaluate({ site: sibling.sites[0]! });
  });
  second.input.guard = { predicate: siblingPredicate };
  // Separate actual SEND intents, both under the same genuine scenario owner.
  second.input.intent = commitOutboxIntent(stageOutboxIntent({
    operationId: '0193f2c0-0000-7000-8000-000000000002', source: 'Mail.send', occurrenceIndex: 1,
    request: { to: 'sibling@test' }, originOccurrence: null,
  }), { revision: 1, committedAtMs: 50 });
  assert.equal((await first.run()).status, 'claimed'); assert.equal((await second.run()).status, 'claimed');
  assert.equal(first.claims, 1); assert.equal(second.claims, 1);
  assert.equal(w.captures, 1); assert.equal(w.admissions, 1); assert.equal(w.reads, 2);
  assert.equal(siblingCaptures, 1); assert.equal(siblingAdmissions, 1); assert.equal(siblingReads, 2);
  // A sibling source handle fails on its first use, even if authored code
  // catches the error and returns false; no capture/read port is replayed.
  const misuse = attempt(w, async execution => {
    const observer = w.producer.open(execution);
    await assert.rejects(observer.evaluate({ site: sibling.sites[0]! }), /foreign source/);
    return false;
  });
  assert.equal((await misuse.run()).status, 'refused-revoked'); noSpend(misuse);
  assert.equal(w.captures, 1); assert.equal(siblingCaptures, 1);
});

for (const active of [true, false]) test(`${active ? 'positive removal' : 'negative activation'} refuses before claim or skip without guard/capture replay`, async () => {
  const w = await world(active);
  const a = attempt(w, async execution => {
    const observer = w.producer.open(execution);
    const result = await w.evaluate(observer, execution); assert.equal(result, active);
    if (active) w.rows.delete('subject'); else w.rows.set('subject', member());
    return result;
  });
  assert.equal((await a.run()).status, 'refused-revoked'); noSpend(a);
  assert.equal(a.guards, 1); assert.equal(w.captures, 1); assert.equal(w.reads, 2);
});

test('role-only change preserving actual bool passes with actor-null service owner', async () => {
  const w = await world();
  const a = attempt(w, async execution => {
    const result = await w.evaluate(w.producer.open(execution), execution);
    w.rows.set('subject', { ...member(), is_owner: true,
      roles: [{ role: 'Membership.manager', granted_at: NOW, granted_by: 'grantor' }] });
    return result;
  });
  assert.equal((await a.run()).status, 'claimed'); assert.equal(w.captures, 1); assert.equal(w.admissions, 1);
});

for (const misuse of ['copied-site', 'foreign-site', 'missing-native', 'team-copy', 'wrong-team', 'bare-person'] as const)
test(`caught first ${misuse} poisons guard before skip/claim`, async () => {
  const w = await world(), foreign = misuse === 'foreign-site' ? await world() : null;
  const a = attempt(w, async execution => {
    const observer = w.producer.open(execution);
    if (misuse !== 'missing-native') w.stage(execution, 'subject', misuse === 'team-copy' ? { ...w.team }
      : misuse === 'wrong-team' ? { ...w.team, team_id: 'other-team' } : w.team);
    if (misuse === 'bare-person') w.frames.set(execution, { person: Object.freeze({ id: 'subject' }) as ReturnType<typeof makeUserRef>, team: w.team });
    const site: ScenarioDispatchMembershipHandle = misuse === 'copied-site' ? { ...w.producer.sites[0] }
      : foreign?.producer.sites[0] ?? w.producer.sites[0]!;
    await assert.rejects(observer.evaluate({ site })); return false;
  });
  assert.equal((await a.run()).status, 'refused-revoked'); noSpend(a);
});

for (const bad of ['foreign-team', 'foreign-person', 'unknown-status', 'malformed', 'rejected'] as const)
test(`reader ${bad} refuses and caught failure cannot authorize dispatch`, async () => {
  const w = await world();
  w.memberships.findMembership = async () => {
    if (bad === 'rejected') throw new Error('reader unavailable');
    if (bad === 'malformed') return undefined as unknown as Membership;
    return { ...member(), ...(bad === 'foreign-team' ? { team_id: 'other-team' }
      : bad === 'foreign-person' ? { user_id: 'other-person' } : { status: 'pending' }) } as Membership;
  };
  const a = attempt(w, async execution => {
    await assert.rejects(w.evaluate(w.producer.open(execution), execution)); return true;
  });
  assert.equal((await a.run()).status, 'refused-revoked'); noSpend(a);
});

for (const bad of ['wrong-predicate', 'missing-checkpoint'] as const) test(`${bad} open refusal enrolls mandatory poisoning`, async () => {
  const w = await world(true, bad === 'wrong-predicate' ? 'Membership.other' : PREDICATE);
  const a = attempt(w, execution => { assert.throws(() => w.producer.open(execution)); return false; });
  if (bad === 'missing-checkpoint') a.input.fence = undefined as unknown as NonNullable<AsyncDispatchAttempt['fence']>;
  assert.equal((await a.run()).status, 'refused-revoked'); noSpend(a); assert.equal(w.captures, 0);
});

test('actual Work handle authenticates open; copied handle never admits or captures', async () => {
  const w = await world();
  const a = attempt(w, execution => { assert.throws(() => w.producer.open({ ...execution })); return false; });
  assert.equal((await a.run()).status, 'skipped'); noSpend(a); assert.equal(w.admissions, 0); assert.equal(w.captures, 0);
});

test('closed observer cannot reuse a completed Work guard or its private native frame', async () => {
  const w = await world(); let saved!: ScenarioDispatchMembershipExecution, execution!: DispatchGuardExecution;
  const a = attempt(w, async actual => { execution = actual; saved = w.producer.open(actual); return w.evaluate(saved, actual); });
  assert.equal((await a.run()).status, 'claimed');
  w.stage(execution); await assert.rejects(saved.evaluate({ site: w.producer.sites[0]! }));
  assert.throws(() => w.producer.open(execution)); assert.equal(w.captures, 1);
});

for (const mode of ['unawaited', 'concurrent', 'mutated-team'] as const) test(`${mode} pending reader refuses before authority/claim`, async () => {
  const w = await world(), g = gate(), original = w.memberships.findMembership;
  w.memberships.findMembership = async (team, person) => { g.enter(); await g.pending; return original(team, person); };
  let pending!: Promise<boolean>;
  const a = attempt(w, async execution => {
    const observer = w.producer.open(execution); pending = w.evaluate(observer, execution);
    // Attach immediately so the intentional unawaited rejection is owned.
    void pending.catch(() => {}); await g.entered;
    if (mode === 'unawaited') return true;
    if (mode === 'concurrent') await assert.rejects(observer.evaluate({ site: w.producer.sites[0]! }));
    else (w.team as { timezone: string }).timezone = 'Europe/Brussels';
    g.release(); await assert.rejects(pending); return true;
  });
  assert.equal((await a.run()).status, 'refused-revoked'); noSpend(a);
  if (mode === 'unawaited') { g.release(); await assert.rejects(pending); }
  assert.equal(w.captures, 1);
});

test('moved real MemoryStorage checkpoint refuses without authority/claim', async () => {
  const w = await world();
  const a = attempt(w, async execution => {
    const result = await w.evaluate(w.producer.open(execution), execution);
    await w.store.commit({ expectedRevision: await w.store.readRevision(), writes: [], history: [], receipt: null,
      outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [] });
    return result;
  });
  await assert.rejects(a.run(), /checkpoint moved/); noSpend(a); assert.equal(w.captures, 1);
});
