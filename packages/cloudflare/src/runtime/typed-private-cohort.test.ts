import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { createSystemRegistry } from '@canlang/state/ports/system';
import { asId, asModel, FIXED_NOW, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { workSchedulePutCommand } from '@canlang/work/kernel/schedule-staging';
import { WORK_SCHEDULE_MODEL, WORK_OCCURRENCE_MODEL, readScheduleRow, readOccurrenceRow } from '@canlang/work/kernel/tables';
import { assembleModules } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';
import { createCanonicalDueCohortBody, invokeDueScheduleCanonical, loadFanoutStateProducers,
  runFanoutSchedulerTurn, T34F7_FANOUT_INTENT_MODEL, T34F7_FANOUT_CHECKPOINT_MODEL,
  T34F7_FANOUT_CHILD_MODEL } from './invoke.js';
import type { CanonicalDueScheduleOpts } from './invoke.js';

const APP = 'CohortJourney';
const ENTRY = asModel(`${APP}.Entry`);
const fixturePath = resolve('packages/cloudflare/test/fixtures/typed-private-cohort.json');
function outcomeStatus(value: unknown): string {
  assert.ok(typeof value === 'object' && value !== null && 'status' in value,
    'Native due outcome must have its declared status.');
  assert.ok(typeof value.status === 'string', 'Native due status must be text.');
  return value.status;
}

test('declared private cohorts freeze sibling handlers and retain checked events across native restart', async () => {
  const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
  const dir = await mkdtemp(join(tmpdir(), 'can-private-cohort-'));
  let mf: Miniflare | undefined;
  let now = FIXED_NOW;
  let sequence = 0;
  const clock = { nowMs: () => now };
  const nextId = () => uuidv7(now, ++sequence);
  const open = async () => {
    mf = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'typed-private-cohort' }, d1Persist: join(dir, 'd1') });
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(db); await ensureIdentitySchema(db);
    return { state: createD1Storage(db), identity: createD1IdentityStore(db, { clock }) };
  };
  try {
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    let storage = await open();
    const team = await storage.identity.createTeam({ timezone: 'UTC' });
    const otherTeam = await storage.identity.createTeam({ timezone: 'UTC' });
    const user = await storage.identity.createUser({ email: 'private-cohort@example.test', email_verified: true,
      password_hash: 'unused' });
    await storage.identity.createMembership({ user_id: user.user_id, team_id: team.team_id, is_owner: true, roles: [] });
    const token = 'private-cohort-session';
    await storage.identity.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(now + 3600_000).toISOString(), last_team_id: team.team_id });
    let invoker = buildInvoker(artifact, asm, storage.state, { memberships: storage.identity, now: clock.nowMs });
    const mutate = async (suffix: string, inputs: Record<string, unknown>) => {
      const result = await invoker.invokeMutation({ operation: `${APP}.${suffix}`, operation_id: nextId(), inputs },
        await resolveIdentity(storage.identity, { session_token: token }, { clock }));
      assert.ok('result' in result, JSON.stringify(result));
      assert.equal(result.result.status, 'committed');
      return result.result.result as { id: string; version: number };
    };
    const firstParent = await mutate('Container.create', { name: 'selected' });
    const otherParent = await mutate('Container.create', { name: 'other' });
    const accepted = await mutate('Entry.create', { label: 'accepted', parent: { id: firstParent.id } });
    const refused = await mutate('Entry.create', { label: 'refused', consent: false, parent: { id: firstParent.id } });
    const foreign = await mutate('Entry.create', { label: 'foreign', parent: { id: otherParent.id } });
    const initialMembers = [accepted.id, refused.id, foreign.id].sort();
    const beforeRefusal = await storage.state.load(ENTRY, asId(refused.id));
    const beforeRefusalHistory = await storage.state.historyFor(ENTRY, asId(refused.id));
    const registry = createSystemRegistry([workSchedulePutCommand]);
    const schedule = async (event: string, payload: Record<string, unknown>) => {
      const occurrenceId = nextId();
      const scope = { app: APP, owner: team.team_id, ownerPackage: APP };
      await registry.run('work.schedule.put', { key: occurrenceId, scope, occurrenceId,
        event: `${APP}.${event}`, at: now, payload },
      { actor: user.user_id, operation: 'work.schedule.put', operationId: nextId(), now }, { store: storage.state });
      return { key: occurrenceId, scope, occurrenceId, event: `${APP}.${event}`, at: now };
    };
    const sweepDue = await schedule('Sweep', { marker: 'captured sweep marker' });
    const opts = (handler: string, due = sweepDue): CanonicalDueScheduleOpts => ({ artifact, asm,
      app: APP, handler: `${APP}.${handler}`, due, store: storage.state, identities: storage.identity, now: clock.nowMs,
      cohortBounds: { pageLimit: 2, chunkSize: 2 } });
    assert.ok(!artifact.operations!.some(operation => operation.name === `${APP}.sweep`));
    const publicAttempt = await invoker.invokeMutation({ operation: `${APP}.sweep`, operation_id: nextId(), inputs: {} },
      await resolveIdentity(storage.identity, { session_token: token }, { clock }));
    assert.ok('error' in publicAttempt);
    const revision = await storage.state.readRevision();
    const wrongOwner = await invokeDueScheduleCanonical({ ...opts('sweep'),
      due: { ...sweepDue, scope: { ...sweepDue.scope, owner: otherTeam.team_id } } });
    assert.equal(outcomeStatus(wrongOwner), 'refused');
    assert.equal(await storage.state.readRevision(), revision);
    const admitted = await invokeDueScheduleCanonical(opts('sweep'));
    assert.equal(outcomeStatus(admitted), 'completed');
    assert.equal(await storage.state.readRevision(), revision + 1);
    const intents = await storage.state.query({ model: T34F7_FANOUT_INTENT_MODEL, authority: 'owner' });
    assert.deepEqual(intents.map(row => row.data.handler).sort(), [`${APP}.sweep`, `${APP}.unbound`]);
    assert.ok(intents.every(row => JSON.stringify(row.data.members) === JSON.stringify(initialMembers)));
    for (const intent of intents) {
      const initialChildren = await storage.state.query({ model: T34F7_FANOUT_CHILD_MODEL, authority: 'owner',
        where: { op: 'eq', field: 'fanoutId', value: intent.id } });
      assert.equal(initialChildren.length, 2);
      assert.notEqual((await storage.state.load(T34F7_FANOUT_CHECKPOINT_MODEL, intent.id))?.data.cursor, null);
    }
    const sourceReceipt = readOccurrenceRow((await storage.state.load(WORK_OCCURRENCE_MODEL, asId(sweepDue.occurrenceId)))!);
    assert.equal(sourceReceipt.status, 'completed');
    assert.deepEqual((sourceReceipt.result as { bounds: unknown }).bounds, { pageLimit: 2, chunkSize: 2 });
    assert.deepEqual((sourceReceipt.result as { fanouts: Array<{ handler: string; fanoutId: string }> }).fanouts
      .map(value => value.handler).sort(), [`${APP}.sweep`, `${APP}.unbound`]);
    const late = await mutate('Entry.create', { label: 'late', parent: { id: firstParent.id } });
    const replayRevision = await storage.state.readRevision();
    assert.equal(outcomeStatus(await invokeDueScheduleCanonical(opts('unbound'))), 'replayed');
    assert.equal(await storage.state.readRevision(), replayRevision);
    await mf!.dispose(); mf = undefined;
    now += 1000; storage = await open();
    invoker = buildInvoker(artifact, asm, storage.state, { memberships: storage.identity, now: clock.nowMs });
    assert.deepEqual(readScheduleRow((await storage.state.load(WORK_SCHEDULE_MODEL, asId(sweepDue.occurrenceId)))!).payload,
      { marker: 'captured sweep marker' });
    const producers = await loadFanoutStateProducers();
    const run = async (handler: string, due = sweepDue, trustedSourceOverride?: string) => {
      const generated = await createCanonicalDueCohortBody(opts(handler, due));
      assert.deepEqual(generated.bounds, { pageLimit: 2, chunkSize: 2 });
      assert.equal(generated.identity.actor, null);
      assert.equal(generated.identity.team?.team_id, team.team_id);
      let cursor: string | null = null;
      let turns = 0;
      for (;;) {
        const result = await runFanoutSchedulerTurn({ store: storage.state, fanoutId: generated.fanoutId, cursor,
          bounds: { pageLimit: 2, maxDrives: 2 }, policy: { maxAttempts: 3, horizonMs: 60_000 },
          meta: { actor: generated.trustedSource, nowMs: now }, maxClaimAgeMs: 60_000,
          cohort: { model: generated.cohort.model, ...(generated.cohort.kind === 'anchored-collection'
            ? { anchor: generated.cohort.parent } : {}) },
          freeze: { cutoff: { sourceOccurrence: due.occurrenceId, handler: `${APP}.${handler}` },
            cohort: generated.cohort, owner: team.team_id, bounds: { ...generated.bounds, maxAttempts: 3 } },
          guard: { predicate: null, frozenInputs: null }, evaluateGuard: () => true,
          readSnapshot: (_child, row) => row,
          fenceFor: () => ({ owner: team.team_id, revalidateAuthority: async () =>
            (await storage.identity.findTeamById(team.team_id)) !== null }),
          body: generated.body, producers,
          invoke: { registry: generated.registry, memberships: storage.identity, clock, identity: generated.identity,
            app: APP, source: 'schedule', childOperation: `${APP}.${handler}`, refInput: generated.refInput,
            inputs: generated.inputs, kind: 'trusted', trustedSource: trustedSourceOverride ?? generated.trustedSource, operationIdFor: nextId },
        });
        assert.equal(result.status, 'turn');
        if (result.status !== 'turn') throw new Error('Private cohort turn refused.');
        assert.ok(result.driven.length <= 2);
        if (trustedSourceOverride !== undefined) assert.ok(result.driven.every(child => child.status === 'refused'));
        assert.ok(++turns <= 4, 'Finite original cohort did not settle.');
        if (result.done) { assert.equal(result.progress.terminal, true); break; }
        cursor = result.cursor;
      }
      return generated;
    };
    const sweep = await run('sweep');
    await run('unbound');
    assert.equal((await storage.state.load(ENTRY, asId(accepted.id)))?.data.label, 'captured sweep marker');
    assert.equal((await storage.state.load(ENTRY, asId(foreign.id)))?.data.count, '1');
    assert.deepEqual(await storage.state.load(ENTRY, asId(refused.id)), beforeRefusal);
    assert.deepEqual(await storage.state.historyFor(ENTRY, asId(refused.id)), beforeRefusalHistory);
    assert.equal((await storage.state.load(ENTRY, asId(late.id)))?.data.count, '0');
    const children = (await storage.state.query(producers.tables.fanoutChildPageQuery(sweep.fanoutId,
      { cursor: null, limit: 10 }))).map(row => producers.tables.readFanoutChildRow(row));
    assert.equal(children.length, 3);
    assert.equal(children.find(child => child.recordId === refused.id)?.causeReason, 'business-rejection');
    const settled = await storage.state.readRevision();
    await run('sweep'); await run('unbound');
    assert.equal(await storage.state.readRevision(), settled);

    const foreignBeforeScoped = await storage.state.load(ENTRY, asId(foreign.id));
    const scopedDue = await schedule('Scoped', { container: { id: firstParent.id, version: String(firstParent.version) },
      marker: 'captured scoped marker' });
    await mutate('Container.update', { record: { id: firstParent.id, version: String(firstParent.version) },
      name: 'current parent after capture' });
    assert.deepEqual(readScheduleRow((await storage.state.load(WORK_SCHEDULE_MODEL, asId(scopedDue.occurrenceId)))!).payload,
      { container: { id: firstParent.id, version: String(firstParent.version) }, marker: 'captured scoped marker' });
    assert.equal(outcomeStatus(await invokeDueScheduleCanonical(opts('scoped', scopedDue))), 'completed');
    const scoped = await run('scoped', scopedDue);
    const scopedMembers = producers.tables.readFanoutIntentRow((await storage.state.load(T34F7_FANOUT_INTENT_MODEL,
      asId(scoped.fanoutId)))!).members;
    assert.deepEqual([...scopedMembers].sort(), [accepted.id, refused.id, late.id].sort());
    for (const id of scopedMembers) assert.equal((await storage.state.load(ENTRY, asId(id)))?.data.label, 'captured scoped marker');
    assert.deepEqual(await storage.state.load(ENTRY, asId(foreign.id)), foreignBeforeScoped);
    const afterScoped = await storage.state.readRevision();
    assert.equal(outcomeStatus(await invokeDueScheduleCanonical(opts('scoped', scopedDue))), 'replayed');
    assert.equal(await storage.state.readRevision(), afterScoped);
    // A real trusted admission under another source principal cannot borrow
    // this retained event or commit any of its provisional business changes.
    const wrongPrincipalDue = await schedule('Sweep', { marker: 'wrong principal must not run' });
    assert.equal(outcomeStatus(await invokeDueScheduleCanonical(opts('sweep', wrongPrincipalDue))), 'completed');
    const currentRows = await storage.state.query({ model: ENTRY, authority: 'owner', order: [{ field: 'id', direction: 'asc' }] });
    const currentHistory = await Promise.all(currentRows.map(row => storage.state.historyFor(ENTRY, row.id)));
    await run('sweep', wrongPrincipalDue, 'schedule:another-event');
    assert.deepEqual(await storage.state.query({ model: ENTRY, authority: 'owner', order: [{ field: 'id', direction: 'asc' }] }), currentRows);
    assert.deepEqual(await Promise.all(currentRows.map(row => storage.state.historyFor(ENTRY, row.id))), currentHistory);
  } finally { await mf?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
