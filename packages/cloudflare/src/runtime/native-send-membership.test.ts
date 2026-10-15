/** Direct native-facade controls with genuine State/Work executions. Admission
 * and source metadata are fixtures; no compiled application qualification. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, Membership, ResolvedIdentity, Team } from '@canlang/contracts';
import type { MembershipReader, ScenarioReceiptMembershipSite } from '@canlang/state';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '@canlang/state/invocation/registry';
import { stageOutboxIntent, commitOutboxIntent } from '@canlang/work/intent';
import { runDispatchGuardPhase, type DispatchGuardExecution } from '@canlang/work/dispatch';
import { makeUserRef } from '@canlang/values';
import { createContext } from './context.js';
import { active_member, bindNativeDispatchMembership, openNativeDispatchMembershipFrame,
  nativeReadSubjectRole } from './native-membership.js';

const ROOT = 'Membership.review', PREDICATE = 'Membership.current', APP = 'native-membership-app';
const NOW = '2026-10-10T00:00:00.000Z';
const source = { path: 'membership.can', sha256: 'a'.repeat(64), module: 'membership.mjs' };
const site: ScenarioReceiptMembershipSite = { version: 1, source, owner: ROOT, node: { start: 10, end: 30 },
  statement: { start: 9, end: 31 }, stage: 'send-dispatch', position: [], calls: [{ source,
    node: { start: 11, end: 29 }, target: { kind: 'builtin', id: 'active_member', overload: 0 },
    arguments: [{ node: { start: 12, end: 13 }, type: 'user' }, { node: { start: 14, end: 15 }, type: 'Team' }],
    slots: [0, 1], defaults: [], chain: [] }] };
const marker = { source, node: site.calls[0]!.node };
const artifact: ArtifactDescriptorSlice = { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
  modules: [{ path: source.module, js: 'export const identity="Membership.review";', map: {
    version: 3, file: source.module, sources: [source.path], sourcesContent: [null], names: [], mappings: '' } }],
  callables: [{ id: ROOT, kind: 'operation', module: source.module, export: 'identity', member: ['review'] }], models: [],
  operations: [{ name: ROOT, kind: 'scenario', description: '', inputs: { fields: [] }, result: {
    type: 'void' as CanTypeId, disclosure: { version: 1, source, returns: [{ id: 'done', source, dependencies: [], influences: [] }] } } }] };
async function world(active = true, membership = true, sites: readonly ScenarioReceiptMembershipSite[] = [site]) {
  const store = createMemoryStorage();
  await store.commit({ expectedRevision: await store.readRevision(), writes: [], history: [], receipt: null, outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [] });
  const def = loadArtifactDescriptors(artifact, { by: 'public' }).registry.get(ROOT);
  assert.ok(def && isGeneratedOperationDef(def));
  const team: Team = { team_id: 'team-a', timezone: 'UTC', created_at: NOW };
  let current = active, reads = 0, admissions = 0, duringRead: (() => Promise<void>) | undefined;
  const memberships: MembershipReader = { async findMembership(teamId, userId) {
    reads++; await duringRead?.();
    return current && teamId === team.team_id && userId === 'subject' ? {
      membership_id: 'membership', team_id: teamId, user_id: userId, is_owner: false, roles: [],
      status: 'active', created_at: NOW, updated_at: NOW } as Membership : null;
  } };
  const input = { source, app: APP, predicate: PREDICATE, sites: membership ? sites : [], store, memberships,
    admit: (): ResolvedIdentity => { admissions++; return { actor: null, team, membership: null, binding: { kind: 'none' }, admitted_at: NOW }; } };
  bindNativeDispatchMembership(def, input);
  const context = () => createContext({ caller: { userId: '', roles: [] }, store,
    qualified: { actor: null, team: { teamId: team.team_id, timezone: team.timezone }, now: 100, source: ROOT } });
  const phase = (evaluate: (execution: DispatchGuardExecution) => Promise<boolean> | boolean) => runDispatchGuardPhase({
    predicate: PREDICATE, frozenInputs: {}, stateSnapshot: {}, checkpoint: { revision: 1, owner: team.team_id },
    intent: commitOutboxIntent(stageOutboxIntent({ operationId: '0193f2c0-0000-7000-8000-000000000002',
      source: 'Mail.send', occurrenceIndex: 0, request: {}, originOccurrence: null }), { revision: 1, committedAtMs: 50 }),
    evaluateGuard: (_predicate, _inputs, _state, execution) => evaluate(execution) });
  return { def, team, input, context, phase, set current(value: boolean) { current = value; },
    set duringRead(value: (() => Promise<void>) | undefined) { duringRead = value; },
    get reads() { return reads; }, get admissions() { return admissions; } };
}
for (const active of [true, false]) test(`native dispatch ${active} captures real Team and revalidates without source replay`, async () => {
  const w = await world(active); let evaluations = 0;
  const phase = await w.phase(async execution => {
    evaluations++; const c = w.context();
    const frame = openNativeDispatchMembershipFrame(c, w.def, PREDICATE, execution, w.team, () => {});
    try { const result = await active_member(c, makeUserRef('subject'), c.team, marker); frame.assertCompleted(); return result; }
    finally { frame.close(); }
  });
  assert.equal(phase.result, active); assert.equal(await phase.revalidate(), true);
  assert.equal(evaluations, 1); assert.equal(w.admissions, 1); assert.equal(w.reads, 2);
});
for (const active of [true, false]) test(`native dispatch changed ${active} observation refuses without replay`, async () => {
  const w = await world(active); let evaluations = 0;
  const phase = await w.phase(async execution => {
    evaluations++; const c = w.context(), frame = openNativeDispatchMembershipFrame(c, w.def, PREDICATE, execution, w.team, () => {});
    try { const result = await active_member(c, makeUserRef('subject'), c.team, marker); frame.assertCompleted(); return result; }
    finally { frame.close(); }
  });
  w.current = !active;
  assert.equal(await phase.revalidate(), false); assert.equal(evaluations, 1); assert.equal(w.reads, 2);
});
test('copied Team, copied Work handle and foreign physical marker refuse', async () => {
  for (const misuse of ['team', 'execution', 'marker'] as const) {
    const w = await world();
    await assert.rejects(w.phase(async execution => {
      const c = w.context();
      const frame = openNativeDispatchMembershipFrame(c, w.def, PREDICATE,
        misuse === 'execution' ? { ...execution } : execution, misuse === 'team' ? { ...w.team } : w.team, () => {});
      try { return await active_member(c, makeUserRef('subject'), c.team,
        misuse === 'marker' ? { source, node: { start: 100, end: 120 } } : marker); }
      finally { frame.close(); }
    }));
    assert.equal(w.reads, 0);
  }
});
test('caught native misuse poisons the actual guard fence', async () => {
  const w = await world();
  const phase = await w.phase(async execution => {
    const c = w.context(), frame = openNativeDispatchMembershipFrame(c, w.def, PREDICATE, execution, w.team, () => {});
    try {
      await assert.rejects(active_member(c, makeUserRef('subject'), { ...c.team }, marker));
      assert.throws(() => frame.assertCompleted()); return false;
    } finally { frame.close(); }
  });
  assert.equal(await phase.revalidate(), false); assert.equal(w.reads, 0);
});
for (const misuse of ['concurrent', 'pending-close'] as const) test(`${misuse} membership misuse refuses the fence`, async () => {
  const w = await world(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  w.duringRead = async () => { entered(); await gate; };
  const phase = await w.phase(async execution => {
    const c = w.context(), frame = openNativeDispatchMembershipFrame(c, w.def, PREDICATE, execution, w.team, () => {});
    const pending = active_member(c, makeUserRef('subject'), c.team, marker);
    const refusal = assert.rejects(pending);
    await started;
    if (misuse === 'concurrent') {
      await assert.rejects(active_member(c, makeUserRef('subject'), c.team, marker)); frame.close();
    } else assert.throws(() => frame.close());
    release(); await refusal; return false;
  });
  assert.equal(await phase.revalidate(), false);
});
test('closed native context and duplicate opening poison the original execution', async () => {
  for (const misuse of ['closed', 'duplicate'] as const) {
    const w = await world();
    const phase = await w.phase(async execution => {
      const c = w.context(), frame = openNativeDispatchMembershipFrame(c, w.def, PREDICATE, execution, w.team, () => {});
      frame.assertCompleted(); frame.close();
      if (misuse === 'closed') await assert.rejects(active_member(c, makeUserRef('subject'), c.team, marker));
      else assert.throws(() => openNativeDispatchMembershipFrame(w.context(), w.def, PREDICATE, execution, w.team, () => {}));
      return false;
    });
    assert.equal(await phase.revalidate(), false); assert.equal(w.reads, 0);
  }
});
test('role-only dispatch still requires a real Work lifetime and preserves subject-role refusal', async () => {
  const w = await world(true, false);
  assert.throws(() => bindNativeDispatchMembership(w.def, w.input));
  const phase = await w.phase(execution => {
    const c = w.context(), frame = openNativeDispatchMembershipFrame(c, w.def, PREDICATE, execution, w.team, () => {});
    frame.assertCompleted(); frame.close(); return true;
  });
  assert.equal(await phase.revalidate(), true); assert.equal(w.admissions, 0); assert.equal(w.reads, 0);
  await assert.rejects(w.phase(async execution => {
    const c = w.context(), frame = openNativeDispatchMembershipFrame(c, w.def, PREDICATE, execution, w.team, () => {});
    try { return await nativeReadSubjectRole(c, 'staff', makeUserRef('subject')); } finally { frame.close(); }
  }), /coherent State source-read/);
});


// One helper's physical active_member call is retained under two different
// original outer decisions. Indices address the checked site/call census,
// including a preceding derive call rather than the filtered handle ordinal.
const sharedHelperSites: readonly ScenarioReceiptMembershipSite[] = [
  { ...site, calls: [{ ...site.calls[0]!, chain: [{ source, node: site.node, derive: 'Membership.helper' }] }] },
  { ...site, node: { start: 40, end: 60 }, statement: { start: 39, end: 61 }, calls: [
    { ...site.calls[0]!, node: { start: 41, end: 59 }, target: { kind: 'derive', name: 'Membership.helper' } },
    { ...site.calls[0]!, chain: [{ source, node: { start: 41, end: 59 }, derive: 'Membership.helper' }] },
  ] },
];
test('native sourceCall selects both exact outer chains of one physical helper occurrence', async () => {
  const w = await world(true, true, sharedHelperSites);
  const phase = await w.phase(async execution => {
    const c = w.context(), frame = openNativeDispatchMembershipFrame(c, w.def, PREDICATE, execution, w.team, () => {});
    try {
      for (const sourceCall of [{ siteIndex: 0, callIndex: 0 }, { siteIndex: 1, callIndex: 1 }]) {
        assert.equal(await active_member(c, makeUserRef('subject'), c.team, { ...marker, sourceCall }), true);
      }
      frame.assertCompleted(); return true;
    } finally { frame.close(); }
  });
  assert.equal(phase.result, true); assert.equal(await phase.revalidate(), true);
  assert.equal(w.admissions, 1); assert.equal(w.reads, 4);
});
test('legacy physical marker remains ambiguous without an exact sourceCall', async () => {
  const w = await world(true, true, sharedHelperSites);
  await assert.rejects(w.phase(async execution => {
    const c = w.context(), frame = openNativeDispatchMembershipFrame(c, w.def, PREDICATE, execution, w.team, () => {});
    try { return await active_member(c, makeUserRef('subject'), c.team, marker); }
    finally { frame.close(); }
  }), /ambiguous original occurrence/);
  assert.equal(w.reads, 0);
});
test('sourceCall refuses absent, nonbuiltin, malformed and foreign source selectors before Identity reads', async () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({ siteIndex: 0 }, 'callIndex', { enumerable: true, get() { getterCalls++; return 0; } });
  const inherited = Object.assign(Object.create({ callIndex: 0 }), { siteIndex: 0 });
  const cases: unknown[] = [
    { ...marker, sourceCall: { siteIndex: 2, callIndex: 0 } },
    { ...marker, sourceCall: { siteIndex: 1, callIndex: 0 } },
    { ...marker, sourceCall: { siteIndex: 0, callIndex: 1 } },
    { ...marker, sourceCall: { siteIndex: -1, callIndex: 0 } },
    { ...marker, sourceCall: { siteIndex: 0, callIndex: 0.5 } },
    { ...marker, sourceCall: { siteIndex: Number.MAX_SAFE_INTEGER + 1, callIndex: 0 } },
    { ...marker, sourceCall: { siteIndex: 0 } },
    { ...marker, sourceCall: { siteIndex: 0, callIndex: 0, extra: true } },
    { ...marker, sourceCall: undefined },
    { ...marker, sourceCall: accessor },
    { ...marker, sourceCall: inherited },
    { ...marker, source: { ...source, sha256: 'b'.repeat(64) }, sourceCall: { siteIndex: 0, callIndex: 0 } },
    { ...marker, node: { start: 100, end: 120 }, sourceCall: { siteIndex: 0, callIndex: 0 } },
    Object.defineProperty({ ...marker }, 'sourceCall', { enumerable: true, get() { getterCalls++; return { siteIndex: 0, callIndex: 0 }; } }),
  ];
  for (const invalid of cases) {
    const w = await world(true, true, sharedHelperSites);
    await assert.rejects(w.phase(async execution => {
      const c = w.context(), frame = openNativeDispatchMembershipFrame(c, w.def, PREDICATE, execution, w.team, () => {});
      try { return await active_member(c, makeUserRef('subject'), c.team, invalid as Parameters<typeof active_member>[3]); }
      finally { frame.close(); }
    }));
    assert.equal(w.reads, 0);
  }
  assert.equal(getterCalls, 0);
});
test('sourceCall data cannot authorize a copied native execution context', async () => {
  const w = await world(true, true, sharedHelperSites);
  await assert.rejects(w.phase(async execution => {
    const c = w.context(), frame = openNativeDispatchMembershipFrame(c, w.def, PREDICATE, execution, w.team, () => {});
    try { return await active_member({ ...c }, makeUserRef('subject'), c.team, { ...marker, sourceCall: { siteIndex: 1, callIndex: 1 } }); }
    finally { frame.close(); }
  }), /actual installed framework context/);
  assert.equal(w.reads, 0);
});
