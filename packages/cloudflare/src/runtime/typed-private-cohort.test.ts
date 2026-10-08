import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, ReceiptIdentity, StoragePort, StoredRow } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { createSystemRegistry } from '@canlang/state/ports/system';
import { asId, asModel, FIXED_NOW, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { FANOUT_NAVIGATION_MODEL, FANOUT_OWNER_SCAN_MODEL, fanoutNavigationRowId, fanoutOwnerScanRowId,
  readFanoutNavigationRow, readFanoutOwnerScanRow } from '@canlang/state/fanout/navigation';
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { workSchedulePutCommand } from '@canlang/work/kernel/schedule-staging';
import { WORK_HANDLER_OCCURRENCE_MODEL, readHandlerOccurrenceRow } from '@canlang/work/kernel/handler-occurrence';
import { WORK_SCHEDULE_MODEL, WORK_OCCURRENCE_MODEL, readScheduleRow, readOccurrenceRow } from '@canlang/work/kernel/tables';
import { assembleModules } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';
import { createCanonicalDueCohortBody, invokeDueScheduleCanonical, invokeDueSourceRoutingCanonical,
  invokeRetainedHandlerOccurrenceCanonical, loadFanoutStateProducers,
  runFanoutSchedulerTurn, T34F7_FANOUT_INTENT_MODEL, T34F7_FANOUT_CHECKPOINT_MODEL,
  T34F7_FANOUT_CHILD_MODEL, releaseStaleFanoutClaims, claimFanoutChild, runRetainedFanoutSchedulerTurn } from './invoke.js';
import type { CanonicalDueScheduleOpts, FanoutSchedulerBodyPort, FanoutSchedulerTurnResult } from './invoke.js';

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
    for (const [event, handlers] of [
      ['Mixed', ['mixedOrdinary', 'mixedCohort']],
      ['OrdinaryPair', ['ordinaryFirst', 'ordinarySecond']],
    ] as const) {
      const due = await schedule(event, { entry: { id: accepted.id, version: String(accepted.version) },
        marker: 'must remain unapplied' });
      const pendingSource = await storage.state.load(WORK_SCHEDULE_MODEL, asId(due.occurrenceId));
      assert.ok(pendingSource);
      assert.equal(readScheduleRow(pendingSource).state, 'pending');
      const beforeRevision = await storage.state.readRevision();
      const beforeRows = await storage.state.query({ model: ENTRY, authority: 'owner' });
      const beforeHistories = await Promise.all(beforeRows.map(row => storage.state.historyFor(ENTRY, row.id)));
      for (const handler of handlers) {
        assert.equal(outcomeStatus(await invokeDueScheduleCanonical(opts(handler, due))), 'refused');
        assert.deepEqual(await storage.state.load(WORK_SCHEDULE_MODEL, asId(due.occurrenceId)), pendingSource);
        assert.equal(await storage.state.load(WORK_OCCURRENCE_MODEL, asId(due.occurrenceId)), null);
        assert.equal(await storage.state.readRevision(), beforeRevision);
        assert.deepEqual(await storage.state.query({ model: ENTRY, authority: 'owner' }), beforeRows);
        assert.deepEqual(await Promise.all(beforeRows.map(row => storage.state.historyFor(ENTRY, row.id))), beforeHistories);
      }
    }
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
    const run = async (handler: string, due = sweepDue, trustedSourceOverride?: string, control?: {
      store?: StoragePort;
      body?: (body: FanoutSchedulerBodyPort) => FanoutSchedulerBodyPort;
      oneTurn?: boolean;
      maxClaimAgeMs?: number;
      observe?: (result: FanoutSchedulerTurnResult) => void;
    }) => {
      const generated = await createCanonicalDueCohortBody(opts(handler, due));
      assert.deepEqual(generated.bounds, { pageLimit: 2, chunkSize: 2 });
      assert.equal(generated.identity.actor, null);
      assert.equal(generated.identity.team?.team_id, team.team_id);
      let cursor: string | null = null;
      let turns = 0;
      for (;;) {
        const result = await runFanoutSchedulerTurn({ store: control?.store ?? storage.state, fanoutId: generated.fanoutId, cursor,
          bounds: { pageLimit: 2, maxDrives: control?.oneTurn ? 1 : 2 }, policy: { maxAttempts: 3, horizonMs: 60_000 },
          meta: { actor: generated.trustedSource, nowMs: now }, maxClaimAgeMs: control?.maxClaimAgeMs ?? 60_000,
          cohort: { model: generated.cohort.model, ...(generated.cohort.kind === 'anchored-collection'
            ? { anchor: generated.cohort.parent } : {}) },
          freeze: { cutoff: { sourceOccurrence: due.occurrenceId, handler: `${APP}.${handler}` },
            cohort: generated.cohort, owner: team.team_id, bounds: { ...generated.bounds, maxAttempts: 3 } },
          guard: { predicate: null, frozenInputs: null }, evaluateGuard: () => true,
          readSnapshot: (_child, row) => row,
          fenceFor: () => ({ owner: team.team_id, revalidateAuthority: async () =>
            (await storage.identity.findTeamById(team.team_id)) !== null }),
          body: control?.body === undefined ? generated.body : control.body(generated.body), producers,
          invoke: { registry: generated.registry, memberships: storage.identity, clock, identity: generated.identity,
            app: APP, source: 'schedule', childOperation: `${APP}.${handler}`, refInput: generated.refInput,
            inputs: generated.inputs, kind: 'trusted', trustedSource: trustedSourceOverride ?? generated.trustedSource, operationIdFor: nextId },
        });
        control?.observe?.(result);
        assert.equal(result.status, 'turn');
        if (result.status !== 'turn') throw new Error('Private cohort turn refused.');
        assert.ok(result.driven.length <= 2);
        if (trustedSourceOverride !== undefined) assert.ok(result.driven.every(child => child.status === 'refused'));
        if (control?.oneTurn) break;
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

    // A retained child slice resumes its committed navigation after process
    // loss, and a live held child cannot starve the later frozen identities.
    const retainedDue = await schedule('Scoped', { container: { id: firstParent.id, version: '2' },
      marker: 'durable bounded visit' });
    const retainedOpts = () => ({ ...opts('scoped', retainedDue), cohortBounds: { pageLimit: 2, chunkSize: 10 } });
    assert.equal(outcomeStatus(await invokeDueScheduleCanonical(retainedOpts())), 'completed');
    let retained = await createCanonicalDueCohortBody(retainedOpts());
    assert.deepEqual(retained.bounds, { pageLimit: 2, chunkSize: 10 });
    const retainedIntent = await storage.state.load(T34F7_FANOUT_INTENT_MODEL, asId(retained.fanoutId));
    assert.ok(retainedIntent);
    const retainedChildren = await storage.state.query(producers.tables.fanoutChildPageQuery(retained.fanoutId,
      { cursor: null, limit: 10 }));
    assert.equal(retainedChildren.length, 3);
    assert.equal((await storage.state.load(T34F7_FANOUT_CHECKPOINT_MODEL, asId(retained.fanoutId)))?.data.cursor, null);
    const firstChild = retainedChildren[0]!;
    const heldChild = retainedChildren[1]!;
    const laterChild = retainedChildren[2]!;
    const retainedBefore = await Promise.all(retainedChildren.map(row => {
      const data = producers.tables.readFanoutChildRow(row);
      return storage.state.load(ENTRY, asId(data.recordId));
    }));
    const retainedHistoryBefore = await Promise.all(retainedBefore.map(row => {
      assert.ok(row); return storage.state.historyFor(ENTRY, row.id);
    }));
    const heldData = producers.tables.readFanoutChildRow(heldChild);
    const retainedFence = () => ({ owner: team.team_id,
      revalidateAuthority: async () => (await storage.identity.findTeamById(team.team_id)) !== null });
    const heldClaim = await claimFanoutChild({ store: storage.state,
      child: { parentOccurrence: retainedDue.occurrenceId, handler: `${APP}.scoped`, recordId: heldData.recordId },
      snapshotVersion: heldChild.version, guard: { predicate: null }, frozenInputs: null,
      readCurrentSnapshot: () => storage.state.load(ENTRY, asId(heldData.recordId)), evaluateGuard: () => true,
      fence: retainedFence(), policy: { maxAttempts: 3, horizonMs: 60_000 },
      meta: { actor: retained.trustedSource, nowMs: now }, producers });
    assert.equal(heldClaim.status, 'claimed');
    const responseLoss = new Error('actual terminal commit response lost');
    let lossFired = false;
    let retainedReceipt: ReceiptIdentity | undefined;
    const retainedSlice = async (loseResponse = false, advanceOwnerScan = false) => {
      const actualStore = storage.state;
      let childQueries = 0;
      const measured: StoragePort = { ...actualStore, query: async query => {
        if (query.model === T34F7_FANOUT_CHILD_MODEL) {
          childQueries += 1;
          assert.ok(query.limit !== undefined && query.limit <= 2);
        }
        return actualStore.query(query);
      }, commit: async batch => {
        const committed = await actualStore.commit(batch);
        if (loseResponse && !lossFired && batch.receipt !== null &&
            batch.writes.some(write => write.model === asModel(FANOUT_NAVIGATION_MODEL)) &&
            batch.writes.some(write => write.model === T34F7_FANOUT_CHILD_MODEL && write.kind !== 'remove' &&
              write.row.id === firstChild.id && producers.tables.readFanoutChildRow(write.row).state === 'completed')) {
          retainedReceipt = batch.receipt.identity;
          lossFired = true;
          throw responseLoss;
        }
        return committed;
      } };
      try {
        const result = await runRetainedFanoutSchedulerTurn({ store: measured, owner: team.team_id,
          retainedIntent, fanoutId: retained.fanoutId, advanceOwnerScan,
          bounds: { pageLimit: 2, maxDrives: 1 }, policy: { maxAttempts: 3, horizonMs: 60_000 },
          meta: { actor: retained.trustedSource, nowMs: now }, maxClaimAgeMs: 1000,
          cohort: { model: retained.cohort.model, ...(retained.cohort.kind === 'anchored-collection'
            ? { anchor: retained.cohort.parent } : {}) },
          guard: { predicate: null, frozenInputs: null }, evaluateGuard: () => true,
          readSnapshot: (_child, row) => row, fenceFor: retainedFence, body: retained.body, producers,
          invoke: { registry: retained.registry, memberships: storage.identity, clock, identity: retained.identity,
            app: APP, source: 'schedule', childOperation: `${APP}.scoped`, refInput: retained.refInput,
            inputs: retained.inputs, kind: 'trusted', trustedSource: retained.trustedSource, operationIdFor: nextId } });
        assert.ok(result.driven.length <= 1);
        return result;
      } finally { assert.equal(childQueries, 2, 'Hot retained turn performs only its two bounded child-page queries.'); }
    };
    await assert.rejects(() => retainedSlice(true, true), responseLoss);
    assert.equal(lossFired, true); assert.ok(retainedReceipt);
    const navigationId = asId(fanoutNavigationRowId(team.team_id, retained.fanoutId));
    const navigationAfterLoss = await storage.state.load(asModel(FANOUT_NAVIGATION_MODEL), navigationId);
    assert.ok(navigationAfterLoss);
    assert.deepEqual(readFanoutNavigationRow(navigationAfterLoss, { owner: team.team_id, intentRow: retainedIntent }), {
      owner: team.team_id, fanoutId: retained.fanoutId, sourceOccurrence: retainedDue.occurrenceId,
      handler: `${APP}.scoped`, cohort: 'anchored-collection', intentVersion: retainedIntent.version,
      lastVisitedChildId: firstChild.id,
    });
    const scanAfterLoss = await storage.state.load(asModel(FANOUT_OWNER_SCAN_MODEL), asId(fanoutOwnerScanRowId(team.team_id)));
    assert.ok(scanAfterLoss);
    assert.deepEqual(readFanoutOwnerScanRow(scanAfterLoss, team.team_id),
      { owner: team.team_id, lastVisitedIntentId: retained.fanoutId });
    assert.equal(producers.tables.readFanoutChildRow((await storage.state.load(T34F7_FANOUT_CHILD_MODEL, firstChild.id))!).state,
      'completed');
    const savedChildReceipt = await storage.state.readReceipt(retainedReceipt); assert.ok(savedChildReceipt);
    assert.equal(savedChildReceipt.outcome.status, 'committed');
    const firstData = producers.tables.readFanoutChildRow(firstChild);
    const firstAfterLoss = await storage.state.load(ENTRY, asId(firstData.recordId)); assert.ok(firstAfterLoss);
    assert.equal(firstAfterLoss.data.label, 'durable bounded visit');
    const firstHistoryAfterLoss = await storage.state.historyFor(ENTRY, firstAfterLoss.id);
    await mf!.dispose(); mf = undefined;
    storage = await open();
    invoker = buildInvoker(artifact, asm, storage.state, { memberships: storage.identity, now: clock.nowMs });
    retained = await createCanonicalDueCohortBody(retainedOpts());
    assert.deepEqual(await storage.state.load(asModel(FANOUT_NAVIGATION_MODEL), navigationId), navigationAfterLoss);
    assert.deepEqual(await storage.state.readReceipt(retainedReceipt), savedChildReceipt);
    const heldVisit = await retainedSlice();
    assert.deepEqual(heldVisit.driven.map(child => [child.childId, child.status]), [[heldChild.id, 'held']]);
    assert.equal(heldVisit.cursor, heldChild.id);
    const laterVisit = await retainedSlice();
    assert.deepEqual(laterVisit.driven.map(child => [child.childId, child.status]), [[laterChild.id, 'recorded']]);
    assert.equal((await retainedSlice()).wrapped, true);
    now += 1000;
    const releasedVisit = await retainedSlice();
    assert.ok(releasedVisit.released.includes(heldChild.id));
    assert.deepEqual(releasedVisit.driven.map(child => [child.childId, child.status]), [[firstChild.id, 'replayed']]);
    assert.deepEqual((await retainedSlice()).driven.map(child => [child.childId, child.status]), [[heldChild.id, 'recorded']]);
    assert.deepEqual((await retainedSlice()).driven.map(child => [child.childId, child.status]), [[laterChild.id, 'replayed']]);
    assert.equal((await retainedSlice()).wrapped, true);
    for (const [index, before] of retainedBefore.entries()) {
      assert.ok(before);
      const after = await storage.state.load(ENTRY, before.id); assert.ok(after);
      assert.equal(after.version, before.version + 1);
      assert.equal(after.data.label, 'durable bounded visit');
      assert.equal((await storage.state.historyFor(ENTRY, before.id)).length, retainedHistoryBefore[index]!.length + 1);
    }
    assert.deepEqual(await storage.state.load(ENTRY, firstAfterLoss.id), firstAfterLoss);
    assert.deepEqual(await storage.state.historyFor(ENTRY, firstAfterLoss.id), firstHistoryAfterLoss);
    assert.deepEqual(await storage.state.load(asModel(FANOUT_OWNER_SCAN_MODEL), scanAfterLoss.id), scanAfterLoss);

    // Intake fixes every route before independently executing any ordinary
    // body. Retained references hydrate CURRENT rows without recapturing input.
    for (const [event, handlerNames] of [
      ['Mixed', ['mixedOrdinary']], ['OrdinaryPair', ['ordinaryFirst', 'ordinarySecond']],
    ] as const) {
      const target = await storage.state.load(ENTRY, asId(foreign.id)); assert.ok(target);
      assert.equal(target.data.consent, true);
      const payload = { entry: { id: target.id, version: String(target.version) }, marker: `${event} independent body` };
      const due = await schedule(event, payload);
      const beforeRows = await storage.state.query({ model: ENTRY, authority: 'owner' });
      const beforeHistory = await storage.state.historyFor(ENTRY, target.id);
      const beforeCut = await storage.state.readRevision();
      let cutCommits = 0;
      const actualStore = storage.state;
      const intakeStore: StoragePort = { ...actualStore, commit: async batch => {
        cutCommits += 1;
        assert.ok(batch.writes.some(write => write.model === WORK_HANDLER_OCCURRENCE_MODEL));
        assert.ok(batch.writes.some(write => write.model === WORK_SCHEDULE_MODEL));
        assert.ok(batch.writes.some(write => write.model === WORK_OCCURRENCE_MODEL));
        assert.ok(batch.writes.every(write => write.model !== ENTRY));
        assert.equal(batch.history.length, 0);
        if (event === 'Mixed') assert.ok(batch.writes.some(write => write.model === T34F7_FANOUT_INTENT_MODEL));
        return actualStore.commit(batch);
      } };
      assert.equal(outcomeStatus(await invokeDueSourceRoutingCanonical({ ...opts(handlerNames[0], due), store: intakeStore })),
        'completed');
      assert.equal(cutCommits, 1);
      assert.equal(await storage.state.readRevision(), beforeCut + 1);
      assert.deepEqual(await storage.state.query({ model: ENTRY, authority: 'owner' }), beforeRows);
      assert.deepEqual(await storage.state.historyFor(ENTRY, target.id), beforeHistory);
      const parentReceipt = readOccurrenceRow((await storage.state.load(WORK_OCCURRENCE_MODEL, asId(due.occurrenceId)))!);
      assert.equal(parentReceipt.status, 'completed');
      const routeRows = await storage.state.query({ model: WORK_HANDLER_OCCURRENCE_MODEL, authority: 'owner',
        where: { op: 'eq', field: 'sourceOccurrence', value: due.occurrenceId }, order: [{ field: 'id', direction: 'asc' }], limit: 10 });
      assert.deepEqual(routeRows.map(row => readHandlerOccurrenceRow(row).handler).sort(),
        handlerNames.map(name => `${APP}.${name}`).sort());
      const routedCohorts = await storage.state.query({ model: T34F7_FANOUT_INTENT_MODEL, authority: 'owner',
        where: { op: 'eq', field: 'sourceOccurrence', value: due.occurrenceId }, limit: 10 });
      assert.equal(routedCohorts.length, event === 'Mixed' ? 1 : 0);
      assert.ok(typeof parentReceipt.result === 'object' && parentReceipt.result !== null &&
        'handlers' in parentReceipt.result && 'fanouts' in parentReceipt.result);
      assert.deepEqual(parentReceipt.result.handlers, routeRows.map(row => {
        const data = readHandlerOccurrenceRow(row); return { handler: data.handler, occurrenceId: data.occurrenceId };
      }));
      assert.deepEqual(parentReceipt.result.fanouts, routedCohorts.map(row => ({
        handler: producers.tables.readFanoutIntentRow(row).handler, fanoutId: row.id,
      })));
      // Reopening discards source/call caches; only Work's captured routes remain.
      await mf!.dispose(); mf = undefined;
      storage = await open();
      invoker = buildInvoker(artifact, asm, storage.state, { memberships: storage.identity, now: clock.nowMs });
      for (const row of routeRows) {
        const route = readHandlerOccurrenceRow(row);
        assert.equal(route.state, 'pending'); assert.deepEqual(route.payload, payload);
        const selector = { sourceOccurrence: route.sourceOccurrence, handler: route.handler, event: route.event,
          scope: { app: route.scopeApp, owner: route.scopeOwner, ownerPackage: route.scopeOwnerPackage } };
        const invocation = { artifact, asm, app: APP, selector, store: storage.state, identities: storage.identity, now: clock.nowMs };
        const beforeWrongOwner = await storage.state.readRevision();
        assert.equal(outcomeStatus(await invokeRetainedHandlerOccurrenceCanonical({ ...invocation,
          selector: { ...selector, scope: { ...selector.scope, owner: otherTeam.team_id } } })), 'refused');
        assert.equal(await storage.state.readRevision(), beforeWrongOwner);
        assert.equal(outcomeStatus(await invokeRetainedHandlerOccurrenceCanonical(invocation)), 'completed');
        const terminalRow = await storage.state.load(WORK_HANDLER_OCCURRENCE_MODEL, row.id); assert.ok(terminalRow);
        assert.equal(readHandlerOccurrenceRow(terminalRow).state, 'completed');
        assert.deepEqual(readHandlerOccurrenceRow(terminalRow).payload, payload);
        assert.equal(readOccurrenceRow((await storage.state.load(WORK_OCCURRENCE_MODEL, row.id))!).status, 'completed');
        const afterBody = await storage.state.readRevision();
        assert.equal(outcomeStatus(await invokeRetainedHandlerOccurrenceCanonical(invocation)), 'replayed');
        assert.equal(await storage.state.readRevision(), afterBody);
        assert.deepEqual(readOccurrenceRow((await storage.state.load(WORK_OCCURRENCE_MODEL, asId(due.occurrenceId)))!), parentReceipt);
      }
      const afterBodies = await storage.state.load(ENTRY, target.id); assert.ok(afterBodies);
      assert.equal(afterBodies.data.label, payload.marker);
      assert.equal(afterBodies.version, target.version + handlerNames.length);
      assert.equal(afterBodies.data.count, String(BigInt(String(target.data.count)) + (event === 'OrdinaryPair' ? 1n : 0n)));
      assert.equal((await storage.state.historyFor(ENTRY, target.id)).length, beforeHistory.length + handlerNames.length);
      const afterRoutes = await storage.state.readRevision();
      assert.equal(outcomeStatus(await invokeDueSourceRoutingCanonical(opts(handlerNames[0], due))), 'replayed');
      assert.equal(await storage.state.readRevision(), afterRoutes);
    }

    const rejectedTarget = await storage.state.load(ENTRY, asId(refused.id)); assert.ok(rejectedTarget);
    assert.equal(rejectedTarget.data.consent, false);
    const rejectedHistory = await storage.state.historyFor(ENTRY, rejectedTarget.id);
    const rejectedDue = await schedule('Mixed', { entry: { id: rejectedTarget.id, version: String(rejectedTarget.version) },
      marker: 'provisional ordinary change must roll back' });
    assert.equal(outcomeStatus(await invokeDueSourceRoutingCanonical(opts('mixedOrdinary', rejectedDue))), 'completed');
    const rejectedRoutes = await storage.state.query({ model: WORK_HANDLER_OCCURRENCE_MODEL, authority: 'owner',
      where: { op: 'eq', field: 'sourceOccurrence', value: rejectedDue.occurrenceId }, limit: 2 });
    assert.equal(rejectedRoutes.length, 1);
    const rejectedRoute = readHandlerOccurrenceRow(rejectedRoutes[0]!);
    const rejectedSelector = { sourceOccurrence: rejectedRoute.sourceOccurrence, handler: rejectedRoute.handler,
      event: rejectedRoute.event, scope: rejectedDue.scope };
    const rejectedInvocation = { artifact, asm, app: APP, selector: rejectedSelector,
      store: storage.state, identities: storage.identity, now: clock.nowMs };
    assert.equal(outcomeStatus(await invokeRetainedHandlerOccurrenceCanonical(rejectedInvocation)), 'failed');
    assert.deepEqual(await storage.state.load(ENTRY, rejectedTarget.id), rejectedTarget);
    assert.deepEqual(await storage.state.historyFor(ENTRY, rejectedTarget.id), rejectedHistory);
    const rejectedTerminal = readOccurrenceRow((await storage.state.load(WORK_OCCURRENCE_MODEL, asId(rejectedRoute.occurrenceId)))!);
    assert.equal(rejectedTerminal.status, 'failed');
    assert.equal(readHandlerOccurrenceRow((await storage.state.load(WORK_HANDLER_OCCURRENCE_MODEL,
      asId(rejectedRoute.occurrenceId)))!).state, 'failed');
    assert.equal(readOccurrenceRow((await storage.state.load(WORK_OCCURRENCE_MODEL, asId(rejectedDue.occurrenceId)))!).status, 'completed');
    const survivingCohorts = await storage.state.query({ model: T34F7_FANOUT_INTENT_MODEL, authority: 'owner',
      where: { op: 'eq', field: 'sourceOccurrence', value: rejectedDue.occurrenceId }, limit: 2 });
    assert.equal(survivingCohorts.length, 1);
    assert.equal(survivingCohorts[0]!.data.handler, `${APP}.mixedCohort`);
    const rejectedSettled = await storage.state.readRevision();
    assert.equal(outcomeStatus(await invokeRetainedHandlerOccurrenceCanonical(rejectedInvocation)), 'replayed');
    assert.equal(await storage.state.readRevision(), rejectedSettled);

    // A real trusted admission under another source principal cannot borrow
    // this retained event or commit any of its provisional business changes.
    const wrongPrincipalDue = await schedule('Sweep', { marker: 'wrong principal must not run' });
    assert.equal(outcomeStatus(await invokeDueScheduleCanonical(opts('sweep', wrongPrincipalDue))), 'completed');
    const currentRows = await storage.state.query({ model: ENTRY, authority: 'owner', order: [{ field: 'id', direction: 'asc' }] });
    const currentHistory = await Promise.all(currentRows.map(row => storage.state.historyFor(ENTRY, row.id)));
    await run('sweep', wrongPrincipalDue, 'schedule:another-event');
    assert.deepEqual(await storage.state.query({ model: ENTRY, authority: 'owner', order: [{ field: 'id', direction: 'asc' }] }), currentRows);
    assert.deepEqual(await Promise.all(currentRows.map(row => storage.state.historyFor(ENTRY, row.id))), currentHistory);

    // A stale winner must not acknowledge the generation acquired by another
    // worker before this old winner opens its next fresh unit checkpoint.
    const racedDue = await schedule('Scoped', { container: { id: firstParent.id, version: '2' }, marker: 'raced claim' });
    assert.equal(outcomeStatus(await invokeDueScheduleCanonical(opts('scoped', racedDue))), 'completed');
    let racedReceipt: ReceiptIdentity | undefined;
    let rival: StoredRow | undefined;
    let racedDomain: StoredRow | undefined;
    let racedHistory: Awaited<ReturnType<StoragePort['historyFor']>> | undefined;
    const raceIntents = await storage.state.query({ model: T34F7_FANOUT_INTENT_MODEL, authority: 'owner',
      where: { op: 'eq', field: 'sourceOccurrence', value: racedDue.occurrenceId }, limit: 2 });
    assert.equal(raceIntents.length, 1);
    const racePage = await storage.state.query(producers.tables.fanoutChildPageQuery(raceIntents[0]!.id,
      { cursor: null, limit: 1 }));
    assert.equal(racePage.length, 1);
    const racingStore: StoragePort = { ...storage.state, readReceipt: async identity => {
      racedReceipt = identity;
      return storage.state.readReceipt(identity);
    }, readRevision: async () => {
      const original = await storage.state.load(T34F7_FANOUT_CHILD_MODEL, racePage[0]!.id); assert.ok(original);
      if (rival === undefined && producers.tables.readFanoutChildRow(original).state === 'running') {
        const originalClaim = producers.tables.readFanoutChildRow(original);
        racedDomain = (await storage.state.load(ENTRY, asId(originalClaim.recordId)))!;
        racedHistory = await storage.state.historyFor(ENTRY, racedDomain.id);
        const later = now + 1000;
        const released = await releaseStaleFanoutClaims({ store: storage.state, fanoutId: originalClaim.fanoutId,
          cursor: null, limit: 2, nowMs: later, maxClaimAgeMs: 1000,
          meta: { actor: `schedule:${racedDue.event}`, nowMs: later }, producers });
        assert.ok(released.released.includes(originalClaim.childId));
        const pending = await storage.state.load(T34F7_FANOUT_CHILD_MODEL, original.id); assert.ok(pending);
        const reclaimed = await claimFanoutChild({ store: storage.state,
          child: { parentOccurrence: racedDue.occurrenceId, handler: `${APP}.scoped`, recordId: originalClaim.recordId },
          snapshotVersion: pending.version, guard: { predicate: null }, frozenInputs: null,
          readCurrentSnapshot: () => storage.state.load(ENTRY, asId(originalClaim.recordId)), evaluateGuard: () => true,
          fence: { owner: team.team_id, revalidateAuthority: async () => (await storage.identity.findTeamById(team.team_id)) !== null },
          policy: { maxAttempts: 3, horizonMs: 60_000 }, meta: { actor: `schedule:${racedDue.event}`, nowMs: later }, producers });
        assert.equal(reclaimed.status, 'claimed');
        assert.ok('row' in reclaimed); rival = reclaimed.row;
      }
      return storage.state.readRevision();
    } };
    await run('scoped', racedDue, undefined, { store: racingStore, oneTurn: true, maxClaimAgeMs: 1000, observe: result => {
      assert.equal(result.status, 'turn');
      if (result.status === 'turn') assert.deepEqual(result.driven.map(child => [child.status, child.detail]), [['retry', 'claim-changed']]);
    } });
    assert.ok(rival); assert.ok(racedDomain); assert.ok(racedReceipt);
    assert.deepEqual(await storage.state.load(T34F7_FANOUT_CHILD_MODEL, rival.id), rival);
    assert.deepEqual(await storage.state.load(ENTRY, racedDomain.id), racedDomain);
    assert.deepEqual(await storage.state.historyFor(ENTRY, racedDomain.id), racedHistory);
    assert.equal(await storage.state.readReceipt(racedReceipt), null);

    // The owning host's offered guard uses actual current Identity state,
    // whose revocation does not advance the State revision fence.
    const guardedDue = await schedule('Scoped', { container: { id: firstParent.id, version: '2' }, marker: 'guard must refuse' });
    assert.equal(outcomeStatus(await invokeDueScheduleCanonical(opts('scoped', guardedDue))), 'completed');
    const currentMember = await storage.identity.findMembership(team.team_id, user.user_id); assert.ok(currentMember);
    let guardedDomain: StoredRow | undefined;
    let guardedHistory: Awaited<ReturnType<StoragePort['historyFor']>> | undefined;
    await run('scoped', guardedDue, undefined, { oneTurn: true,
      body: body => async (child, row, attempt) => {
        guardedDomain = row; guardedHistory = await storage.state.historyFor(ENTRY, row.id);
        const effects = await body(child, row, attempt);
        const revisionBeforeRevocation = await storage.state.readRevision();
        await storage.identity.removeMembership(currentMember.membership_id);
        assert.equal(await storage.state.readRevision(), revisionBeforeRevocation);
        return { ...effects, guards: [...effects.guards ?? [], { name: 'current.host.membership',
          evaluate: async () => (await storage.identity.findMembership(team.team_id, user.user_id))?.status === 'active' }] };
      }, observe: result => {
        assert.equal(result.status, 'turn');
        if (result.status === 'turn') assert.deepEqual(result.driven.map(child => [child.status, child.detail]),
          [['refused', 'failed/inaccessible-record']]);
      } });
    assert.ok(guardedDomain);
    assert.deepEqual(await storage.state.load(ENTRY, guardedDomain.id), guardedDomain);
    assert.deepEqual(await storage.state.historyFor(ENTRY, guardedDomain.id), guardedHistory);
  } finally { await mf?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
