import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, StoredRow } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { FIXED_NOW, asModel, asOperation, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { assembleModules } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';
import {
  createCanonicalFanoutBody, loadFanoutStateProducers, runFanoutSchedulerTurn,
  stageFanoutTriggerJoin,
} from './invoke.js';
import type { FanoutSchedulerBodyPort, RunFanoutSchedulerTurnOpts } from './invoke.js';

const APP = 'TypedCohortJourney';
const MODEL = asModel(`${APP}.Entry`);
const OPERATION = `${APP}.process`;
const fixturePath = resolve('packages/cloudflare/test/fixtures/typed-cohort-journey.json');

// This is the compiled ordinary-child component. Source each= trigger admission
// remains a separate compiler boundary; the cohort spec below is host-owned.
test('compiled child bodies share native D1 fanout outcomes, fresh authority and restart', async () => {
  const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
  const dir = await mkdtemp(join(tmpdir(), 'can-cohort-journey-'));
  let mf: Miniflare | undefined;
  let now = FIXED_NOW;
  let sequence = 0;
  const clock = { nowMs: () => now };
  const nextId = () => uuidv7(now, ++sequence);
  const open = async () => {
    mf = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'typed-cohort-journey' }, d1Persist: join(dir, 'd1') });
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(db);
    await ensureIdentitySchema(db);
    return { state: createD1Storage(db), identity: createD1IdentityStore(db, { clock }) };
  };
  try {
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    let storage = await open();
    const user = await storage.identity.createUser({ email: 'cohort-owner@example.test',
      password_hash: 'unused', email_verified: true });
    const team = await storage.identity.createTeam({ timezone: 'UTC' });
    const membership = await storage.identity.createMembership({ user_id: user.user_id,
      team_id: team.team_id, is_owner: true, roles: [] });
    const token = 'cohort-native-session';
    await storage.identity.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(now + 3600_000).toISOString(), last_team_id: team.team_id });
    const identity = await resolveIdentity(storage.identity, { session_token: token }, { clock });
    let invoker = buildInvoker(artifact, asm, storage.state, { memberships: storage.identity, now: clock.nowMs });
    const mutate = async (suffix: string, inputs: Record<string, unknown>) => {
      const result = await invoker.invokeMutation({ operation: `${APP}.${suffix}`,
        operation_id: nextId(), inputs }, await resolveIdentity(storage.identity, { session_token: token }, { clock }));
      assert.ok('result' in result, JSON.stringify(result));
      assert.equal(result.result.status, 'committed');
      return result.result;
    };
    for (const label of ['first', 'second', 'third']) await mutate('Entry.create', { label });
    const members = await storage.state.query({ model: MODEL, authority: 'owner', order: [{ field: 'id', direction: 'asc' }] });
    assert.equal(members.length, 3);
    const accepted = members[0]!;
    let refused = members[1]!;
    const revoked = members[2]!;
    await mutate('Entry.update', { record: { id: refused.id, version: String(refused.version) }, consent: false });
    refused = (await storage.state.load(MODEL, refused.id))!;
    const beforeRefusedHistory = await storage.state.historyFor(MODEL, refused.id);
    const producers = await loadFanoutStateProducers();
    const cohort = { kind: 'model' as const, owner: team.team_id, model: MODEL };
    const cutoff = { sourceOccurrence: nextId(), handler: OPERATION };
    const bounds = { pageLimit: 2, chunkSize: 2 };
    const stageTrigger = () => stageFanoutTriggerJoin({ store: storage.state, cutoff, cohort,
      owner: team.team_id, bounds, meta: { actor: user.user_id, nowMs: now },
      hasModel: model => model === MODEL, producers,
      stageSource: () => ({ writes: [], history: [], receipt: null, outbox: [], schedules: [],
        uniqueClaims: [], uniqueReleases: [] }),
    });
    const frozen = await stageTrigger();
    assert.equal(frozen.ok, true);
    if (!frozen.ok) throw new Error('Native cohort admission refused.');
    assert.deepEqual(frozen.members, members.map(row => row.id));
    await mutate('Entry.create', { label: 'late' });
    const late = (await storage.state.query({ model: MODEL, authority: 'owner' })).find(row => row.data.label === 'late')!;
    const attempts = new Map<string, string>();
    const bodyFactory = () => createCanonicalFanoutBody({ artifact, asm, store: storage.state,
      memberships: storage.identity, identity, operation: OPERATION, app: APP, source: 'worker' });
    let generated = await bodyFactory();
    const turn = (cursor: string | null, body: FanoutSchedulerBodyPort = generated.body,
      maxDrives = 2): RunFanoutSchedulerTurnOpts => ({ store: storage.state,
      fanoutId: frozen.fanoutId, cursor, bounds: { pageLimit: 2, maxDrives },
      policy: { maxAttempts: 3, horizonMs: 60_000 }, meta: { actor: user.user_id, nowMs: now },
      maxClaimAgeMs: 60_000, cohort: { model: MODEL },
      freeze: { cutoff, cohort, owner: team.team_id, bounds: { ...bounds, maxAttempts: 3 },
        hasModel: model => model === MODEL },
      guard: { predicate: null, frozenInputs: null }, evaluateGuard: () => true,
      readSnapshot: (_child, row) => row,
      fenceFor: () => ({ owner: team.team_id, revalidateAuthority: async () => {
        const current = await storage.identity.findMembership(team.team_id, user.user_id);
        return current?.status === 'active' && current.is_owner;
      } }),
      body, producers,
      invoke: { registry: generated.registry, memberships: storage.identity, clock, identity,
        app: APP, source: 'worker', childOperation: OPERATION, refInput: 'entry',
        operationIdFor: child => { const id = nextId(); attempts.set(child.recordId, id); return id; } },
    });
    const childRows = async () => (await storage.state.query(producers.tables.fanoutChildPageQuery(frozen.fanoutId,
      { cursor: null, limit: 10 }))).map(row => producers.tables.readFanoutChildRow(row));
    let lostResponse = false;
    const responseLossStore = { ...storage.state, commit: async (batch: Parameters<typeof storage.state.commit>[0]) => {
      const result = await storage.state.commit(batch);
      if (!lostResponse && batch.history?.some(entry => entry.operation === OPERATION && entry.operationId === attempts.get(accepted.id))) {
        lostResponse = true;
        throw new Error('Native child commit response lost.');
      }
      return result;
    } };
    const lossBody = await createCanonicalFanoutBody({ artifact, asm, store: responseLossStore,
      memberships: storage.identity, identity, operation: OPERATION, app: APP, source: 'worker' });
    const lossTurn = turn(null, lossBody.body, 1);
    await assert.rejects(runFanoutSchedulerTurn({ ...lossTurn, store: responseLossStore,
      invoke: { ...lossTurn.invoke, registry: lossBody.registry } }), /Native child commit response lost/);
    assert.equal(lostResponse, true);
    assert.equal((await storage.state.load(MODEL, accepted.id))?.data.count, '1');
    assert.equal((await childRows()).find(row => row.recordId === accepted.id)?.state, 'completed');
    await mf!.dispose(); mf = undefined;
    storage = await open();
    invoker = buildInvoker(artifact, asm, storage.state, { memberships: storage.identity, now: clock.nowMs });
    generated = await bodyFactory();
    const first = await runFanoutSchedulerTurn(turn(null));
    assert.equal(first.status, 'turn');
    if (first.status !== 'turn') throw new Error('Native child turn refused.');
    assert.equal(first.driven.length, 2);
    assert.equal(first.done, false);
    const success = (await storage.state.load(MODEL, accepted.id))!;
    assert.equal(success.data.count, '1');
    assert.deepEqual([success.data.who, success.data.scope, success.data.invocation, success.data.origin],
      [user.user_id, team.team_id, attempts.get(accepted.id), 'worker']);
    assert.equal(success.version, accepted.version + 1);
    const history = await storage.state.historyFor(MODEL, accepted.id);
    assert.equal(history.at(-1)?.operationId, attempts.get(accepted.id));
    assert.equal(history.at(-1)?.actor, user.user_id);
    const receipt = await storage.state.readReceipt({ app: APP, owner: team.team_id, principal: user.user_id,
      operation: asOperation(OPERATION), operationId: asOperationId(attempts.get(accepted.id)!) });
    assert.equal(receipt?.outcome.status, 'committed');
    if (receipt?.outcome.status !== 'committed') throw new Error('Generated result receipt missing.');
    assert.equal(receipt.outcome.result, '1');
    assert.deepEqual(await storage.state.load(MODEL, refused.id), refused);
    assert.deepEqual(await storage.state.historyFor(MODEL, refused.id), beforeRefusedHistory);
    let children = await childRows();
    assert.equal(children.find(row => row.recordId === accepted.id)?.state, 'completed');
    assert.equal(children.find(row => row.recordId === refused.id)?.causeReason, 'business-rejection');
    assert.equal(children.find(row => row.recordId === revoked.id)?.state, 'pending');
    assert.ok(children.every(row => row.recordId !== late.id));

    // Resume the actual saved cursor over reopened D1; the carried verified
    // identity cannot override a newly revoked owner role.
    await storage.identity.setMembershipOwner(membership.membership_id, false);
    await mf!.dispose(); mf = undefined;
    now += 1000;
    storage = await open();
    invoker = buildInvoker(artifact, asm, storage.state, { memberships: storage.identity, now: clock.nowMs });
    generated = await bodyFactory();
    const second = await runFanoutSchedulerTurn(turn(first.cursor));
    assert.equal(second.status, 'turn');
    if (second.status !== 'turn') throw new Error('Native resumed turn refused.');
    assert.equal(second.driven.length, 1);
    assert.equal(second.progress.terminal, true);
    assert.deepEqual(await storage.state.load(MODEL, accepted.id), success);
    assert.deepEqual(await storage.state.load(MODEL, revoked.id), revoked);
    assert.equal((await storage.state.load(MODEL, late.id))?.data.count, '0');
    children = await childRows();
    assert.equal(children.find(row => row.recordId === revoked.id)?.causeReason, 'inaccessible-record');
    assert.equal(children.length, 3);
    const settledRevision = await storage.state.readRevision();
    const replay = await runFanoutSchedulerTurn(turn(null));
    assert.equal(replay.status, 'turn');
    assert.equal(await storage.state.readRevision(), settledRevision);
    assert.deepEqual(await storage.state.historyFor(MODEL, accepted.id), history);
    assert.deepEqual(await childRows(), children);
    const duplicateTrigger = await stageTrigger();
    assert.equal(duplicateTrigger.ok, false, 'a repeated cutoff cannot replace its frozen membership');
    assert.equal(await storage.state.readRevision(), settledRevision);

    // A new frozen occurrence uses the same genuine source body. Revoke live
    // caller-role facts after that body stages its update, before canonical
    // commit. The owning by=owner gate still holds; the real caller-role guard
    // must independently void the staged effects.
    await storage.identity.setMembershipOwner(membership.membership_id, true);
    const raceCutoff = { sourceOccurrence: nextId(), handler: OPERATION };
    const race = await stageFanoutTriggerJoin({ store: storage.state, cutoff: raceCutoff, cohort,
      owner: team.team_id, bounds: { pageLimit: 2, chunkSize: 10 }, meta: { actor: user.user_id, nowMs: now },
      hasModel: model => model === MODEL, producers,
      stageSource: () => ({ writes: [], history: [], receipt: null, outbox: [], schedules: [],
        uniqueClaims: [], uniqueReleases: [] }) });
    assert.equal(race.ok, true);
    if (!race.ok) throw new Error('Race cohort admission refused.');
    let changed = false;
    const racingBody: FanoutSchedulerBodyPort = async (...args) => {
      const effects = await generated.body(...args);
      await storage.identity.setMembershipRoles(membership.membership_id, [{ role: `${APP}.observer`,
        granted_at: new Date(now).toISOString(), granted_by: user.user_id }]);
      assert.equal((await storage.identity.findMembership(team.team_id, user.user_id))?.is_owner, true);
      changed = true;
      return effects;
    };
    const beforeRace = await storage.state.load(MODEL, accepted.id);
    const raceTurn = turn(null, racingBody, 1);
    const raceOptions: RunFanoutSchedulerTurnOpts = { ...raceTurn, fanoutId: race.fanoutId,
      freeze: { cutoff: raceCutoff, cohort, owner: team.team_id,
        bounds: { pageLimit: 2, chunkSize: 10, maxAttempts: 3 }, hasModel: model => model === MODEL } };
    const raced = await runFanoutSchedulerTurn(raceOptions);
    assert.equal(changed, true);
    assert.equal(raced.status, 'turn');
    assert.deepEqual(await storage.state.load(MODEL, accepted.id), beforeRace);
    assert.deepEqual(await storage.state.historyFor(MODEL, accepted.id), history);
    const raceChildren: readonly StoredRow[] = await storage.state.query(producers.tables.fanoutChildPageQuery(race.fanoutId,
      { cursor: null, limit: 10 }));
    assert.equal(producers.tables.readFanoutChildRow(raceChildren[0]!).causeReason, 'inaccessible-record');
    if (raced.status !== 'turn') throw new Error('Native authority-race turn refused.');
    const beforeScope = await storage.state.load(MODEL, refused.id);
    const mismatched = await runFanoutSchedulerTurn({ ...raceOptions, cursor: raced.cursor, body: generated.body,
      invoke: { ...raceOptions.invoke, source: 'another-source' } });
    assert.equal(mismatched.status, 'turn');
    if (mismatched.status !== 'turn') throw new Error('Native scope-refusal turn refused.');
    assert.equal(mismatched.driven[0]?.status, 'refused', 'a body cannot borrow another admitted source scope');
    assert.deepEqual(await storage.state.load(MODEL, refused.id), beforeScope);
    assert.deepEqual(await storage.state.historyFor(MODEL, refused.id), beforeRefusedHistory);
  } finally {
    await mf?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
