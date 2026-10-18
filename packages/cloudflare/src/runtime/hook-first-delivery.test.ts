import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import type { CompileArtifact, MutationEnvelope, StoredRow, StoragePort } from '@canlang/contracts';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { createD1IdentityStore, ensureIdentitySchema } from '@canlang/identity';
import { WORK_SYSTEM_COMMANDS } from '@canlang/work/kernel/commands';
import {
  FIXED_NOW, asId, asModel, asOperationId, makeIdentity, makeBatch, makeRow, uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import { createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker } from '@canlang/cloudflare/worker/assembly';
import { createCheckoutScratch } from '../dev/checkout-scratch.js';
import { originalScenarioSource as originalHandlerSource } from './original-source.testing.js';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const FIXTURE = 'packages/cloudflare/test/fixtures/hook-first-delivery.can';
const APP = 'HookFirstDelivery';
const BUDGET = asModel(`${APP}.Budget`);
let sequence = 9000;

function envelope(operation: string, inputs: MutationEnvelope['inputs'], app = APP): MutationEnvelope {
  return { operation: `${app}.${operation}`, inputs,
    operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)) };
}

async function compileFixture(native: boolean, fixture: string): Promise<CompileArtifact> {
  const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
  const catalog = process.env.CAN_NATIVE_CATALOG ??
    join(root, 'packages/cloudflare/dist/native-catalog.json');
  const args = ['compile', '--format=json', '--catalog', catalog,
    ...(native ? ['--native-scenario-receipts'] : []), fixture];
  const env = { ...process.env };
  delete env.CAN_CATALOG;
  const { stdout } = await execFileAsync(compiler, args, { cwd: root, env, maxBuffer: 64 * 1024 * 1024 }).catch(async error => {
    const failed = await mkdtemp(join(tmpdir(), 'can-hook-failed-source-'));
    const captured = join(failed, 'original.can');
    await writeFile(captured, await readFile(resolve(root, fixture), 'utf8'));
    if (error instanceof Error) error.message += `\nExact failed compiler input retained at ${captured}`;
    throw error;
  });
  const artifact = JSON.parse(stdout) as CompileArtifact;
  assert.ok(!('diagnostics' in artifact), `delivery fixture emits clean (native=${native})`);
  return artifact;
}

async function setup(native: boolean, fixture = FIXTURE, app = APP) {
  const artifact = await compileFixture(native, fixture);
  const dir = await mkdtemp(join(tmpdir(), 'can-hook-first-delivery-'));
  const asm = await assembleModules({ artifact, sourcePath: join(root, fixture) }, {
    workDir: join(dir, 'modules'),
    stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
    uiUrl: import.meta.resolve('@canlang/ui'),
  });
  const memberships = createMemoryIdentityStore();
  const user = await memberships.createUser({ email: 'hook-first-owner@example.test',
    email_verified: true, password_hash: 'unused' });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const membership = await memberships.createMembership({ team_id: team.team_id,
    user_id: user.user_id, is_owner: true, roles: [] });
  const identity = makeIdentity({ membership, team, email: user.email });
  const store = createTestMemoryStorage().store;
  const invoker = buildInvoker(artifact, asm, store, { memberships, now: () => FIXED_NOW });
  const scope = { app, owner: team.team_id, ownerPackage: app };
  const at = FIXED_NOW + 60_000;
  const committed = async (operation: string, inputs: MutationEnvelope['inputs']) => {
    const outcome = await invoker.invokeMutation(envelope(operation, inputs, app), identity);
    assert.ok('result' in outcome, JSON.stringify(outcome));
    assert.equal(outcome.result.status, 'committed');
    return outcome.result;
  };
  const slot = (await committed('Slot.create', { label: 'key' })).records![0] as {
    id: string; version: number };
  return { artifact, asm, dir, store, memberships, invoker, identity, scope, at, slot, app };
}

async function armAndDeliver(world: Awaited<ReturnType<typeof setup>>, source: string) {
  const { invoker, identity, scope, at, slot, store, app } = world;
  const arm = await world.invoker.invokeMutation(
    envelope('arm', { slot: { id: slot.id, version: String(slot.version) },
      at: new Date(at).toISOString(), source }, app), identity);
  assert.ok('result' in arm && arm.result.status === 'committed', JSON.stringify(arm));
  const { invokeDueScheduleCanonical } = await import('@canlang/cloudflare/runtime/invoke');
  const { scheduleByKeyQuery } = await import('@canlang/work/kernel/tables');
  const rows = await store.query(scheduleByKeyQuery(scope, slot.id));
  const row = rows.find((entry: { data: Record<string, unknown> }) =>
    entry.data['state'] === 'pending');
  assert.ok(row, 'arm stages one pending occurrence');
  return invokeDueScheduleCanonical({ asm: world.asm, artifact: world.artifact, app,
    handler: `${app}.probe`, due: { key: slot.id, scope, occurrenceId: row.id,
      event: `${app}.Tick`, at },
    store, identities: world.memberships, now: () => at });
}

async function teardown(world: Awaited<ReturnType<typeof setup>>) {
  await rm(world.dir, { recursive: true, force: true });
}

test('plain delivery of the admitted hook shape completes on a granted row', async () => {
  const world = await setup(false);
  try {
    const created = await world.invoker.invokeMutation(
      envelope('Budget.create', { source: 'acme-renewal', approved: true }), world.identity);
    assert.ok('result' in created && created.result.status === 'committed');
    const completed = await armAndDeliver(world, 'acme-renewal');
    assert.deepEqual(completed, { status: 'completed',
      occurrenceId: (completed as { occurrenceId: string }).occurrenceId, result: null });
    const budgets = await world.store.query({ model: BUDGET, authority: 'owner' });
    assert.equal(budgets.length, 1);
  } finally {
    await teardown(world);
  }
});

test('plain delivery of the admitted hook shape fails closed on the empty domain', async () => {
  const world = await setup(false);
  try {
    const failed = await armAndDeliver(world, 'acme-renewal') as {
      status: string; occurrenceId: string };
    assert.equal(failed.status, 'failed');
    const { WORK_OCCURRENCE_MODEL } = await import('@canlang/work/kernel/tables');
    const occurrence = await world.store.load(WORK_OCCURRENCE_MODEL, asId(failed.occurrenceId));
    assert.equal(occurrence?.data['status'], 'failed');
    assert.deepEqual(await world.store.query({ model: BUDGET, authority: 'owner' }), []);
  } finally {
    await teardown(world);
  }
});

test('plain delivery of the admitted hook shape fails closed on an unapproved row', async () => {
  const world = await setup(false);
  try {
    const created = await world.invoker.invokeMutation(
      envelope('Budget.create', { source: 'acme-renewal', approved: false }), world.identity);
    assert.ok('result' in created && created.result.status === 'committed');
    const failed = await armAndDeliver(world, 'acme-renewal');
    assert.equal((failed as { status: string }).status, 'failed');
    const budgets = await world.store.query({ model: BUDGET, authority: 'owner' });
    assert.equal(budgets.length, 1);
  } finally {
    await teardown(world);
  }
});

test('plain delivery refuses a foreign-scope occurrence for the admitted hook shape', async () => {
  const world = await setup(false);
  try {
    const created = await world.invoker.invokeMutation(
      envelope('Budget.create', { source: 'acme-renewal', approved: true }), world.identity);
    assert.ok('result' in created && created.result.status === 'committed');
    const { invokeDueScheduleCanonical } = await import('@canlang/cloudflare/runtime/invoke');
    const { scheduleByKeyQuery } = await import('@canlang/work/kernel/tables');
    const arm = await world.invoker.invokeMutation(
      envelope('arm', { slot: { id: world.slot.id, version: String(world.slot.version) },
        at: new Date(world.at).toISOString(), source: 'acme-renewal' }), world.identity);
    assert.ok('result' in arm && arm.result.status === 'committed');
    const pending = (await world.store.query(scheduleByKeyQuery(world.scope, world.slot.id)))
      .find((entry: { data: Record<string, unknown> }) => entry.data['state'] === 'pending');
    assert.ok(pending);
    const revision = await world.store.readRevision();
    const refused = await invokeDueScheduleCanonical({ asm: world.asm, artifact: world.artifact,
      app: APP, handler: `${APP}.probe`, due: { key: world.slot.id,
        scope: { ...world.scope, owner: 'foreign-owner' }, occurrenceId: pending.id,
        event: `${APP}.Tick`, at: world.at },
      store: world.store, identities: world.memberships, now: () => world.at });
    assert.deepEqual(refused, { status: 'refused', reason: 'mismatched' });
    assert.equal(await world.store.readRevision(), revision);
  } finally {
    await teardown(world);
  }
});

test('native delivery of the admitted hook shape completes on a granted row', async () => {
  const world = await setup(true);
  try {
    const created = await world.invoker.invokeMutation(
      envelope('Budget.create', { source: 'acme-renewal', approved: true }), world.identity);
    assert.ok('result' in created && created.result.status === 'committed');
    // C24 scope-1 (REVIEW-20 successor): the admitted compiled handler runs
    // natively inside its internal trusted-handler session — private
    // invocation disclosure, verified module query inventory and the same
    // State fence — so approved/granted completes like plain delivery.
    const completed = await armAndDeliver(world, 'acme-renewal');
    assert.deepEqual(completed, { status: 'completed',
      occurrenceId: (completed as { occurrenceId: string }).occurrenceId, result: null });
    const budgets = await world.store.query({ model: BUDGET, authority: 'owner' });
    assert.equal(budgets.length, 1);
  } finally {
    await teardown(world);
  }
});

test('native delivery of the admitted hook shape fails closed on the empty domain', async () => {
  const world = await setup(true);
  try {
    const failed = await armAndDeliver(world, 'acme-renewal') as {
      status: string; occurrenceId: string };
    assert.equal(failed.status, 'failed');
    const { WORK_OCCURRENCE_MODEL } = await import('@canlang/work/kernel/tables');
    const occurrence = await world.store.load(WORK_OCCURRENCE_MODEL, asId(failed.occurrenceId));
    assert.equal(occurrence?.data['status'], 'failed');
    assert.deepEqual(await world.store.query({ model: BUDGET, authority: 'owner' }), []);
  } finally {
    await teardown(world);
  }
});

test('native delivery of the admitted hook shape fails closed on an unapproved row', async () => {
  const world = await setup(true);
  try {
    const created = await world.invoker.invokeMutation(
      envelope('Budget.create', { source: 'acme-renewal', approved: false }), world.identity);
    assert.ok('result' in created && created.result.status === 'committed');
    const failed = await armAndDeliver(world, 'acme-renewal');
    assert.equal((failed as { status: string }).status, 'failed');
    const budgets = await world.store.query({ model: BUDGET, authority: 'owner' });
    assert.equal(budgets.length, 1);
  } finally {
    await teardown(world);
  }
});

test('native delivery refuses a foreign-scope occurrence for the admitted hook shape', async () => {
  const world = await setup(true);
  try {
    const created = await world.invoker.invokeMutation(
      envelope('Budget.create', { source: 'acme-renewal', approved: true }), world.identity);
    assert.ok('result' in created && created.result.status === 'committed');
    const { invokeDueScheduleCanonical } = await import('@canlang/cloudflare/runtime/invoke');
    const { scheduleByKeyQuery } = await import('@canlang/work/kernel/tables');
    const arm = await world.invoker.invokeMutation(
      envelope('arm', { slot: { id: world.slot.id, version: String(world.slot.version) },
        at: new Date(world.at).toISOString(), source: 'acme-renewal' }), world.identity);
    assert.ok('result' in arm && arm.result.status === 'committed');
    const pending = (await world.store.query(scheduleByKeyQuery(world.scope, world.slot.id)))
      .find((entry: { data: Record<string, unknown> }) => entry.data['state'] === 'pending');
    assert.ok(pending);
    const revision = await world.store.readRevision();
    const refused = await invokeDueScheduleCanonical({ asm: world.asm, artifact: world.artifact,
      app: APP, handler: `${APP}.probe`, due: { key: world.slot.id,
        scope: { ...world.scope, owner: 'foreign-owner' }, occurrenceId: pending.id,
        event: `${APP}.Tick`, at: world.at },
      store: world.store, identities: world.memberships, now: () => world.at });
    assert.deepEqual(refused, { status: 'refused', reason: 'mismatched' });
    assert.equal(await world.store.readRevision(), revision);
  } finally {
    await teardown(world);
  }
});

test('whole handler queries retain their own staged prefix and a late require rolls back', async () => {
  const scratch = await createCheckoutScratch(root, 'handler-query-prefix-');
  let world: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    const original = await readFile(join(root, FIXTURE), 'utf8');
    const source = original.replace(' Budget {source:text,approved:bool}', ' Budget {source:text,approved:bool,intervals:Interval[]}')
      .replace('crud Budget by=owner fields=source,approved', 'crud Budget by=owner fields=source,approved,intervals')
      .replace('When\n', ' derive order_key(budget:Budget):text = budget.source\n contract Interval {from:datetime,until:datetime}\n invariant Budget: all(row.intervals as interval,interval.from<interval.until)\n contract Snapshot {record:Budget,approved:bool}\n event Captured {value:Snapshot}\n event Observed {source:text}\n invariant Budget: trim(row.source)!="" and count(Budget as candidate where candidate.approved in [true,false] and now==now)>=0\nWhen\n')
      .replace(/ scenario probe on=Tick[\s\S]*?Then\n/, ` scenario probe on=Tick
  do
   let before=first(Budget as row where row.source==event.source order=row.id)
   require before!=null
   let ranked=first(Budget as candidate order=-order_key(candidate))
   require ranked!=null
   if event.source=="reject"
    require ranked.source=="reject"
   set before {approved=true}
   let after=first(Budget as row where row.source==event.source and row.approved order=row.id)
   require after!=null and after.id==before.id
   emit Captured {value=Snapshot {record=before,approved=before.approved}}
   set before {approved=false}
   require event.source!="reject"
 scenario observe on=Captured each=Budget as budget
  do
   set budget {approved=event.value.approved}
   emit Observed {source=budget.source}
Then
`);
    const path = join(scratch, 'original.can');
    await writeFile(path, source);
    world = await setup(true, relative(root, path));
    const intervals = [{ from: '2026-10-19T09:00:00.000Z', until: '2026-10-19T10:00:00.000Z' }];
    const invalid = await world.invoker.invokeMutation(envelope('Budget.create', { source: 'bad-interval', approved: false,
      intervals: [{ from: intervals[0]!.until, until: intervals[0]!.from }] }), world.identity);
    assert.partialDeepStrictEqual(invalid, { error: { code: 'rule_failed', message: 'Model invariant failed.' }, receipt: 'rejected' });
    for (const source of ['allow', 'reject']) {
      const created = await world.invoker.invokeMutation(envelope('Budget.create', { source, approved: false, intervals }), world.identity);
      assert.ok('result' in created && created.result.status === 'committed');
      const { loadDispatchSystemProducers, invokeDueScheduleCanonical } = await import('./invoke.js');
      const producers = await loadDispatchSystemProducers();
      const registry = producers.createSystemRegistry([...producers.l3Commands, ...WORK_SYSTEM_COMMANDS]);
      const key = `prefix-${source}`, occurrenceId = uuidv7(world.at, ++sequence);
      await registry.run('work.schedule.put', { key, scope: world.scope, at: world.at,
        event: `${APP}.Tick`, payload: { source }, occurrenceId },
        { actor: 'prefix-test', now: world.at, operation: 'test.stage', operationId: uuidv7(world.at, ++sequence) }, { store: world.store });
      const result = await invokeDueScheduleCanonical({ asm: world.asm, artifact: world.artifact, app: APP,
        handler: `${APP}.probe`, due: { key, scope: world.scope, at: world.at, event: `${APP}.Tick`, occurrenceId },
        store: world.store, identities: world.memberships, now: () => world!.at });
      assert.equal(result.status, source === 'allow' ? 'completed' : 'failed');
      const rows = await world.store.query({ model: BUDGET, authority: 'owner' });
      assert.equal(rows.find(row => row.data.source === source)?.data.approved, false);
      const captured = await emittedSources(world, `${APP}.Captured`);
      assert.equal(captured.length, 1, 'late authored refusal publishes no event');
      const allowed = rows.find(row => row.data.source === 'allow')!;
      assert.deepEqual(captured[0]!.source.payload, { value: { record: { id: allowed.id, version: String(allowed.version) }, approved: true } },
        'nested reference retains the reserved version while scalar payload retains its at-emit value');
    }
    const { createTeamOwnerStorageBoundary } = await import('../worker/assembly.js');
    const { createBoundCohortTick } = await import('./cohort-tick.js');
    const selected = world;
    const ownerStorage = await createTeamOwnerStorageBoundary({ artifact: world.artifact, asm: world.asm,
      app: APP, identities: world.memberships, router: { ownerScopedStoragePort: async () => selected.store } });
    const tick = await createBoundCohortTick({ artifact: world.artifact, asm: world.asm, identities: world.memberships,
      ownerStorage, scope: world.scope, now: () => selected.at });
    await tick.tick();
    const rows = await world.store.query({ model: BUDGET, authority: 'owner' });
    assert.equal(rows.find(row => row.data.source === 'allow')?.data.approved, true);
    assert.equal(rows.find(row => row.data.source === 'reject')?.data.approved, false, 'cohort membership excludes later-created rows');
    const observed = await emittedSources(world, `${APP}.Observed`);
    assert.deepEqual(observed.map(value => value.source.payload), [{ source: 'allow' }], 'real retained cohort body can emit its own later source');
    await tick.tick();
    assert.equal((await emittedSources(world, `${APP}.Observed`)).length, 1, 'retained cohort replay publishes no duplicate');
  } finally {
    if (world !== undefined) await teardown(world);
    await rm(scratch, { recursive: true, force: true });
  }
});

/** Keep declarations and handler text byte-for-byte from the draft owners.
 * Selection follows named dependencies and every selected model's existing
 * policies/invariants/locks/uniques; fixtures and unrelated derives stay out.
 */

async function originalHandlerWorld(owner = 'events', handlerName = 'venue_cleanup', app = 'OriginalVenueCleanup',
  selected?: Awaited<ReturnType<typeof originalHandlerSource>>) {
  const original = selected ?? await originalHandlerSource(owner, handlerName, app);
  const dir = await mkdtemp(join(tmpdir(), 'can-original-venue-cleanup-'));
  let worker: Miniflare | undefined;
  try {
    const sourcePath = join(dir, 'original.can');
    await writeFile(sourcePath, original.source);
    const artifact = await compileFixture(true, sourcePath);
    const asm = await assembleModules({ artifact, sourcePath }, { workDir: join(dir, 'modules'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    const callable = artifact.callables.find(value => value.id === original.handler);
    assert.ok(callable, 'whole original handler is compiled');
    const { importVerifiedAssemblyModule } = await import('./modules.js');
    const module = await importVerifiedAssemblyModule(asm, callable.module, artifact) as {
      appDefinition: { operations: Record<string, { event: string }> } };
    const event = module.appDefinition.operations[original.handler]?.event ?? '';
    assert.ok(event !== '' || callable.member[0] === 'hooks', 'the original handler or hook remains compiled');
    worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default {fetch(){return new Response("private")}}',
      d1Databases: { STATE: 'original-venue-state', IDENTITY: 'original-venue-identity' } });
    const stateDb = await worker.getD1Database('STATE') as unknown as D1Database;
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
    await ensureSchema(stateDb); await ensureIdentitySchema(identityDb);
    const { loadDispatchSystemProducers, invokeDueScheduleCanonical, createWorkerDispatchJoinPort, withDispatchJoinPort } = await import('./invoke.js');
    const underlying = createD1Storage(stateDb);
    const store = withDispatchJoinPort(underlying, await createWorkerDispatchJoinPort(underlying));
    const identities = createD1IdentityStore(identityDb, { clock: { nowMs: () => FIXED_NOW } });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const person = await identities.createUser({ email: 'original-venue@example.test', password_hash: 'unused', email_verified: true });
    const scope = { app: original.app, owner: team.team_id, ownerPackage: owner };
    const producers = await loadDispatchSystemProducers();
    const registry = producers.createSystemRegistry([...producers.l3Commands, ...WORK_SYSTEM_COMMANDS]);
    const seed = async (model: string, id: string, data: Record<string, unknown>, parent?: { model: string; id: string }) => {
      const row: StoredRow = { ...makeRow({ id, data }), parent: parent ? { model: asModel(parent.model), id: asId(parent.id) } : null };
      await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: asModel(model), row }] }));
      return row;
    };
    let index = 0;
    const deliver = (due: import('@canlang/work/kernel/schedule-staging').DueScheduleInput, selectedStore: StoragePort = store) => invokeDueScheduleCanonical({
      asm, artifact, app: original.app, handler: original.handler, due, store: selectedStore, identities, now: () => FIXED_NOW });
    const stage = async (payload: Record<string, unknown>) => {
      const key = `original-venue-${++index}`, occurrenceId = `original-venue-occurrence-${index}`;
      await registry.run('work.schedule.put', { key, scope, at: FIXED_NOW, event,
        payload, occurrenceId },
        { actor: 'original-venue-test', now: FIXED_NOW, operation: 'test.schedule-original', operationId: uuidv7(FIXED_NOW, ++sequence) }, { store });
      return { key, scope, at: FIXED_NOW, event, occurrenceId };
    };
    const arm = (eventId: string, revision = '2') => stage({ event: { id: eventId, version: '1' }, revision, reason: 'Original cancellation' });
    const continuation = async (eventId: string) => {
      const { scheduleByKeyQuery, readScheduleRow } = await import('@canlang/work/kernel/tables');
      const rows = await store.query(scheduleByKeyQuery(scope, `${eventId}:venues`));
      const pending = rows.map(readScheduleRow).filter(row => row.state === 'pending');
      assert.equal(pending.length, 1, 'one original continuation is retained');
      const row = pending[0]!;
      assert.deepEqual(row.payload, { event: { id: eventId, version: '1' }, revision: '2', reason: 'Original cancellation' });
      return { key: row.key, scope, at: row.at, event: row.event, occurrenceId: row.occurrenceId };
    };
    return { ...original, event, dir, worker, store, identities, scope, person, team, seed, arm, stage, deliver, continuation, registry, asm, artifact };
  } catch (error) {
    await worker?.dispose(); await rm(dir, { recursive: true, force: true }); throw error;
  }
}

/** Add test orchestration within its actual owning package, preserving every original body. */
function originalOwnerScenarios(source: string, owner: string, scenarios: string): string {
  const start = source.indexOf(`package ${owner}\n`);
  assert.ok(start >= 0, `original owning package ${owner} exists`);
  const next = source.indexOf('\npackage ', start);
  const end = next < 0 ? source.length : next + 1;
  const marker = source.lastIndexOf(' Then\n', end - 1);
  assert.ok(marker > start, `original owning package ${owner} has its When/Then boundary`);
  return source.slice(0, marker) + scenarios + source.slice(marker);
}

test('whole original resource and location snapshot hooks retain typed candidates, staged parents and atomic calendar evidence',
  { timeout: 120_000 }, async () => {
    const app = 'OriginalSnapshotHooks';
    const original = await originalHandlerSource('rent_reservations', 'snapshot_Resource_create', app, [
      { owner: 'rent_reservations', name: 'snapshot_Resource_update' },
      { owner: 'rent_catalog', name: 'snapshot_Location_create' },
      { owner: 'rent_catalog', name: 'snapshot_Location_update' },
      { owner: 'rent_catalog', name: 'snapshot_WeeklyHours_create' },
      { owner: 'rent_catalog', name: 'snapshot_WeeklyHours_update' },
    ]);
    // Test-local CRUD triggers the genuine owner hook pipeline. All original
    // models, invariants, locks and complete hook bodies remain unchanged.
    original.source = originalOwnerScenarios(original.source, 'rent_catalog', `
  crud Location by=members fields=active create_fields=name,address,timezone,currency,hours,arrival,active delete=none
  crud WeeklyHours by=members fields=closes create_fields=weekday,opens,closes,close_after,fold delete=none
`);
    original.source = originalOwnerScenarios(original.source, 'rent_reservations', `
  crud Resource by=members fields=active,capacity create_fields=location,name,pooled,capacity,timezone,currency,hourly,terms,refund_notice,accessibility delete=none
`);
    const world = await originalHandlerWorld('rent_reservations', 'snapshot_Resource_create', app, original);
    try {
      const membership = await world.identities.createMembership({ team_id: world.team.team_id,
        user_id: world.person.user_id, is_owner: true, roles: [] });
      const identity = makeIdentity({ membership, team: world.team, email: world.person.email });
      const invoker = buildInvoker(world.artifact, world.asm, world.store,
        { memberships: world.identities, now: () => FIXED_NOW });
      const models = ['rent_catalog.Location', 'rent_catalog.WeeklyHours', 'rent_catalog.LocationPolicy',
        'rent_reservations.Resource', 'rent_reservations.ResourcePolicy'];
      const rows = (model: string) => world.store.query({ model: asModel(model), authority: 'owner' });
      const snapshot = () => Promise.all(models.map(async model => ({ model, rows: await rows(model) })));
      const invoke = (operation: string, inputs: MutationEnvelope['inputs']) => invoker.invokeMutation({
        operation, operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)), inputs }, identity);
      const committed = (outcome: Awaited<ReturnType<typeof invoke>>) =>
        assert.ok('result' in outcome && outcome.result.status === 'committed', JSON.stringify(outcome));
      committed(await invoke('rent_catalog.Location.create', {
        name: 'Original snapshot site', address: '1 Road', timezone: 'UTC', currency: 'EUR',
        hours: '09:00–18:00', arrival: 'Reception', active: true,
      }));
      const [location] = await rows('rent_catalog.Location');
      assert.ok(location);
      const parent = { id: location.id };
      const catalogOnly = await snapshot();
      const hoursInput = { parent, weekday: '1', opens: '09:00', closes: '18:00', close_after: '0', fold: 'earlier' };
      assert.ok('error' in await invoke('rent_catalog.WeeklyHours.create', { ...hoursInput, closes: '08:00' }));
      assert.deepEqual(await snapshot(), catalogOnly,
        'original opening-hours invariant rolls back its trigger and hook-staged snapshot');
      committed(await invoke('rent_catalog.WeeklyHours.create', hoursInput));
      const seededCatalog = await snapshot();
      const resourceInput = { location: { id: location.id, version: String(location.version) }, name: 'Original snapshot resource', pooled: false,
        capacity: '1', timezone: 'UTC', currency: 'EUR', hourly: { minor: '100', currency: 'EUR' },
        terms: 'Original terms', refund_notice: '86400000', accessibility: 'Step-free' };
      assert.ok('error' in await invoke('rent_reservations.Resource.create', { ...resourceInput, capacity: '2' }));
      assert.deepEqual(await snapshot(), seededCatalog,
        'original nonpooled-capacity invariant rolls back the resource and hook-staged policy');
      committed(await invoke('rent_reservations.Resource.create', resourceInput));
      const [resource] = await rows('rent_reservations.Resource'), [hours] = await rows('rent_catalog.WeeklyHours');
      assert.ok(resource && hours);
      const openingPolicies = [...await rows('rent_catalog.LocationPolicy')].sort((a, b) => Number(a.data.sequence) - Number(b.data.sequence));
      assert.equal(openingPolicies.length, 2, 'original parent and child create hooks each capture once');
      assert.deepEqual(openingPolicies.map(row => row.data.weekly), [[], [
        { weekday: '1', opens: '09:00', closes: '18:00', close_after: '0', fold: 'earlier' },
      ]], 'child snapshot includes its actual provisional WeeklyHours candidate');
      assert.ok(openingPolicies.every(row => row.data.effective === new Date(FIXED_NOW).toISOString()));
      assert.ok(openingPolicies.every(row => row.parent?.id === location.id && row.data.timezone === 'UTC'));
      const [resourcePolicy] = await rows('rent_reservations.ResourcePolicy');
      assert.ok(resourcePolicy);
      assert.deepEqual(resourcePolicy.data.value, { active: true, capacity: '1', pooled: false, timezone: 'UTC' });
      assert.equal(resourcePolicy.data.baseline, true);
      assert.deepEqual(resource.data.hourly, { minor: '100', currency: 'EUR' });
      assert.equal(resource.data.tax_rate, '0');
      assert.equal(resource.data.currency, 'EUR');
      const before = await snapshot();
      const hoursRecord = { id: hours.id, version: String(hours.version) };
      const resourceRecord = { id: resource.id, version: String(resource.version) };
      assert.ok('error' in await invoke('rent_catalog.WeeklyHours.update', { record: hoursRecord, closes: '08:00' }));
      assert.deepEqual(await snapshot(), before, 'late original calendar invariant rolls back the updated row and snapshot');
      assert.ok('error' in await invoke('rent_reservations.Resource.update', { record: resourceRecord, active: false, capacity: '2' }));
      assert.deepEqual(await snapshot(), before, 'late original resource invariant rolls back the updated row and snapshot');
      committed(await invoke('rent_catalog.Location.update', {
        record: { id: location.id, version: String(location.version) }, active: false,
      }));
      committed(await invoke('rent_reservations.Resource.update', { record: resourceRecord, active: false }));
      committed(await invoke('rent_catalog.WeeklyHours.update', { record: hoursRecord, closes: '19:00' }));
      const current = [...await rows('rent_catalog.LocationPolicy')].sort((a, b) => Number(a.data.sequence) - Number(b.data.sequence));
      assert.equal(current.length, 4);
      assert.deepEqual(current.slice(0, 2), openingPolicies, 'earlier snapshots retain the old candidate values');
      assert.equal(current[2]!.data.active, false);
      assert.deepEqual(current[3]!.data.weekly, [
        { weekday: '1', opens: '09:00', closes: '19:00', close_after: '0', fold: 'earlier' },
      ]);
      const resourcePolicies = [...await rows('rent_reservations.ResourcePolicy')].sort((a, b) => Number(a.data.sequence) - Number(b.data.sequence));
      assert.deepEqual(resourcePolicies[0], resourcePolicy);
      assert.deepEqual(resourcePolicies[1]!.data.value, { active: false, capacity: '1', pooled: false, timezone: 'UTC' });
      assert.equal(resourcePolicies[1]!.data.baseline, false);
      assert.deepEqual(await world.store.outboxPending(), []);
    } finally {
      await world.worker.dispose(); await rm(world.dir, { recursive: true, force: true });
    }
  });

test('whole original followup hooks capture the exact parent version and roll back late failures',
  { timeout: 120_000 }, async () => {
    const app = 'OriginalFollowUpHooks';
    const original = await originalHandlerSource('success', 'arm', app, [{ owner: 'success', name: 'reschedule' }]);
    original.source = originalOwnerScenarios(original.source, 'success', `
  crud Account by=members fields=notes,active create_fields=location,manager,email,notes delete=none
  crud FollowUp by=members fields=due,done create_fields=title,due,assignee,email delete=none
`);
    const world = await originalHandlerWorld('success', 'arm', app, original);
    try {
      const membership = await world.identities.createMembership({ team_id: world.team.team_id,
        user_id: world.person.user_id, is_owner: true, roles: [{ role: 'success.account_manager',
          granted_at: new Date(FIXED_NOW).toISOString(), granted_by: world.person.user_id }] });
      const identity = makeIdentity({ membership, team: world.team, email: world.person.email });
      const invoker = buildInvoker(world.artifact, world.asm, world.store,
        { memberships: world.identities, now: () => FIXED_NOW });
      const site = await world.seed('rent_catalog.Location', uuidv7(FIXED_NOW, 901), {
        name: 'Follow-up site', address: '1 Road', timezone: 'UTC', currency: 'EUR',
        hours: '09:00–18:00', arrival: 'Reception', active: true,
      });
      const customer = await world.seed('customer.Customer', uuidv7(FIXED_NOW, 902), {
        name: 'Original company', kind: 'company', locations: [{ id: site.id }], active: true,
      });
      await world.seed('employee.Employee', uuidv7(FIXED_NOW, 903), {
        user: { id: world.person.user_id }, name: 'Account manager', home: { id: site.id },
        locations: [{ id: site.id }], operator_wide: false, active: true, start: '2020-01-01',
        end: null, manager: null, role: 'Account manager', skills: [], private_notes: null, document: null,
      });
      const rows = (model: string) => world.store.query({ model: asModel(model), authority: 'owner' });
      const schedules = () => world.store.schedulesDue(Number.MAX_SAFE_INTEGER, 100);
      const snapshot = async () => ({ accounts: await rows('success.Account'),
        followups: await rows('success.FollowUp'), schedules: await schedules() });
      const invoke = (operation: string, inputs: MutationEnvelope['inputs'], operationId = asOperationId(uuidv7(FIXED_NOW, ++sequence))) =>
        invoker.invokeMutation({ operation: `success.${operation}`, operation_id: operationId, inputs }, identity);
      const committed = (outcome: Awaited<ReturnType<typeof invoke>>) =>
        assert.ok('result' in outcome && outcome.result.status === 'committed', JSON.stringify(outcome));
      committed(await invoke('Account.create', { parent: { id: customer.id }, location: { id: site.id, version: String(site.version) },
        manager: { id: world.person.user_id }, email: 'manager@example.test', notes: 'Original account' }));
      const [account] = await rows('success.Account');
      assert.ok(account);
      committed(await invoke('FollowUp.create', { parent: { id: account.id }, title: 'Original follow-up',
        due: '2099-01-01T09:00:00.000Z', assignee: { id: world.person.user_id }, email: 'manager@example.test' }));
      const [followup] = await rows('success.FollowUp');
      assert.ok(followup);
      const [initial] = await schedules();
      assert.ok(initial);
      assert.equal(initial.key, followup.id);
      assert.equal(initial.event, 'success.FollowUpDue');
      assert.deepEqual(initial.payload, { followup: { id: followup.id, version: '1' }, revision: '1', account_revision: '1' });
      committed(await invoke('Account.update', { record: { id: account.id, version: '1' }, notes: 'Updated parent' }));
      const before = await snapshot();
      assert.equal(before.accounts[0]!.version, 2);
      assert.deepEqual(before.schedules[0], initial, 'parent update retains the earlier captured timer until follow-up rescheduling');
      const updateInputs = { record: { id: followup.id, version: '1' }, due: '2099-01-02T09:00:00.000Z' };
      let failedCommit = false;
      const unavailable: StoragePort = { ...world.store, commit: async batch => {
        if (!failedCommit && batch.writes.some(write => write.model === asModel('success.FollowUp'))) {
          failedCommit = true; throw new Error('Temporary follow-up commit failure');
        }
        return world.store.commit(batch);
      } };
      const failingInvoker = buildInvoker(world.artifact, world.asm, unavailable,
        { memberships: world.identities, now: () => FIXED_NOW });
      const failure = await failingInvoker.invokeMutation({ operation: 'success.FollowUp.update',
        operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)), inputs: updateInputs }, identity)
        .catch(error => ({ error }));
      assert.ok('error' in failure && failedCommit, 'actual late persistence failure rejects the hook and timer');
      assert.deepEqual(await snapshot(), before, 'failed commit preserves old follow-up and old schedule exactly');
      const operationId = asOperationId(uuidv7(FIXED_NOW, ++sequence));
      committed(await invoke('FollowUp.update', updateInputs, operationId));
      const changed = await snapshot();
      assert.equal(changed.followups[0]!.version, 2);
      assert.equal(changed.schedules.length, 1, 'the original key is replaced once');
      assert.deepEqual(changed.schedules[0]!.payload, {
        followup: { id: followup.id, version: '2' }, revision: '2', account_revision: '2',
      }, 'reschedule reads the exact current owner parent revision, not its earlier captured revision');
      await invoke('FollowUp.update', updateInputs, operationId);
      assert.deepEqual(await snapshot(), changed, 'canonical replay does not replace or duplicate the retained timer');
      committed(await invoke('Account.update', { record: { id: account.id, version: '2' }, active: false }));
      committed(await invoke('FollowUp.update', { record: { id: followup.id, version: '2' },
        due: '2099-01-03T09:00:00.000Z' }));
      assert.deepEqual(await schedules(), [], 'original inactive-parent guard cancels without rearming');
      assert.deepEqual(await world.store.outboxPending(), []);
    } finally {
      await world.worker.dispose(); await rm(world.dir, { recursive: true, force: true });
    }
  });

async function seedOriginalVenue(world: Awaited<ReturnType<typeof originalHandlerWorld>>) {
  const ids = { site: uuidv7(FIXED_NOW, 201), program: uuidv7(FIXED_NOW, 202), event: uuidv7(FIXED_NOW, 203),
    otherEvent: uuidv7(FIXED_NOW, 204), resource: uuidv7(FIXED_NOW, 205),
    excluded: uuidv7(FIXED_NOW, 206), foreign: uuidv7(FIXED_NOW, 207), first: uuidv7(FIXED_NOW, 208), second: uuidv7(FIXED_NOW, 209) };
  const eur = (minor: string) => ({ minor, currency: 'EUR' });
  await world.seed('rent_catalog.Location', ids.site, { name: 'Original site', address: '1 Road', timezone: 'UTC',
    currency: 'EUR', hours: '09:00–18:00', arrival: 'Reception', active: true });
  await world.seed('events.Program', ids.program, { name: 'Original program' });
  const event = { location: { id: ids.site }, name: 'Original event', description: 'Original description', timezone: 'UTC',
    from: '2026-10-19T09:00:00.000Z', until: '2026-10-19T10:00:00.000Z', capacity: '10', price: eur('0'),
    sales_until: '2026-10-19T08:00:00.000Z', refund_before: '2026-10-18T08:00:00.000Z', terms: 'Original terms',
    venue: null, venue_name: null, pending_change: null, revision: '2', organizer: { id: world.person.user_id },
    cancellation_reason: 'Original cancellation', published: false, cancelled: true };
  for (const id of [ids.event, ids.otherEvent]) await world.seed('events.Event', id, event, { model: 'events.Program', id: ids.program });
  await world.seed('rent_reservations.Resource', ids.resource, { location: { id: ids.site }, name: 'Original venue',
    pooled: false, capacity: '1', party_limit: '20', kind: 'event_space', hold_for: '900000', active: true,
    timezone: 'UTC', currency: 'EUR', tax_rate: '0', discount_rate: '0', cancellation_fee: null,
    hourly: eur('100'), daily: null, price_unit: 'hour', increment: '3600000', minimum: '3600000',
    terms: 'Original venue terms', refund_notice: '86400000', buffer_before: '0', buffer_after: '0', amenities: [], accessibility: 'Step-free' });
  const change = { source: 'original-candidate', base_revision: '1', location: { id: ids.site }, timezone: 'UTC',
    from: event.from, until: event.until, capacity: '10', sales_until: event.sales_until, reason: 'Original proposed change',
    author: { id: world.person.user_id }, resource: null, customer: null, account: { id: world.person.user_id }, previous: null,
    state: 'holding', venue_state: 'pending', venue_revision: '0', reference: null, hold_delivery: null,
    confirm_delivery: null, release_reason: null, release_delivery: null, hold_status: null, confirm_status: null, release_status: null };
  return { ids, event, change };
}

test('whole original venue cleanup selects one contained candidate, releases or sends, continues and replays through D1 Work',
  { timeout: 120_000 }, async () => {
    const world = await originalHandlerWorld();
    try {
      const { ids, change } = await seedOriginalVenue(world);
      const owners = await Promise.all(['events.Event', 'events.Program', 'rent_catalog.Location', 'rent_reservations.Resource']
        .map(async model => ({ model, rows: await world.store.query({ model: asModel(model), authority: 'owner' }) })));
      const changes = () => world.store.query({ model: asModel('events.Change'), authority: 'owner' });
      const empty = await world.arm(ids.event);
      assert.equal((await world.deliver(empty)).status, 'completed');
      assert.deepEqual(await changes(), []);
      assert.deepEqual(await world.store.outboxPending(), []);
      await world.seed('events.Change', ids.excluded, { ...change, source: 'already-releasing', state: 'releasing' }, { model: 'events.Event', id: ids.event });
      await world.seed('events.Change', ids.foreign, { ...change, source: 'other-event' }, { model: 'events.Event', id: ids.otherEvent });
      // Insert the larger eligible ID first: authored ID ordering, not storage
      // insertion order, must select the resource-free candidate below.
      await world.seed('events.Change', ids.second, { ...change, source: 'original-venue-source', resource: { id: ids.resource }, state: 'adopted' }, { model: 'events.Event', id: ids.event });
      await world.seed('events.Change', ids.first, { ...change, source: 'resource-free-source' }, { model: 'events.Event', id: ids.event });
      const first = await world.arm(ids.event);
      assert.equal((await world.deliver(first)).status, 'completed');
      const load = (id: string) => world.store.load(asModel('events.Change'), asId(id));
      assert.equal((await load(ids.first))!.data.state, 'released');
      assert.equal((await load(ids.second))!.data.state, 'adopted');
      assert.equal((await load(ids.foreign))!.data.state, 'holding');
      assert.equal((await load(ids.excluded))!.data.state, 'releasing');
      assert.deepEqual(await world.store.outboxPending(), []);
      let next = await world.continuation(ids.event);
      let revision = await world.store.readRevision();
      assert.equal((await world.deliver(first)).status, 'replayed');
      assert.equal(await world.store.readRevision(), revision);
      assert.equal((await world.deliver(next)).status, 'completed');
      const selected = (await load(ids.second))!;
      assert.equal(selected.data.state, 'releasing');
      assert.equal(selected.data.release_reason, 'Original cancellation');
      assert.equal(selected.data.release_status, 'pending');
      const outbox = await world.store.outboxPending();
      assert.equal(outbox.length, 1);
      const send = outbox[0]!;
      assert.equal(send.target, 'rent_reservations.RoomsV1.release');
      assert.deepEqual(send.arguments, { binding: 'events.Rooms', from: 'deployment.rooms',
        arguments: { source: 'original-venue-source', resource: ids.resource, reason: 'Original cancellation' } });
      assert.equal(selected.data.release_delivery, send.intentId);
      const selectedDomain = await changes();
      revision = await world.store.readRevision();
      assert.equal((await world.deliver(next)).status, 'replayed');
      assert.equal(await world.store.readRevision(), revision);
      assert.deepEqual(await world.store.outboxPending(), outbox);
      next = await world.continuation(ids.event);
      assert.equal((await world.deliver(next)).status, 'completed');
      assert.deepEqual(await changes(), selectedDomain, 'exhausted continuation changes no domain rows');
      assert.deepEqual(await world.store.outboxPending(), outbox, 'exhausted continuation stages no duplicate send');
      for (const owner of owners) assert.deepEqual(await world.store.query({ model: asModel(owner.model), authority: 'owner' }), owner.rows,
        'cleanup preserves original event, program, location and venue resource');
      const beforeGuards = await changes();
      const stale = await world.arm(ids.event, '1');
      assert.equal((await world.deliver(stale)).status, 'failed');
      const originalEvent = (await world.store.load(asModel('events.Event'), asId(ids.event)))!;
      await world.store.commit(makeBatch(await world.store.readRevision(), { writes: [{ kind: 'update', model: asModel('events.Event'),
        id: originalEvent.id, expectedVersion: originalEvent.version,
        row: { ...originalEvent, version: (originalEvent.version + 1) as StoredRow['version'], data: { ...originalEvent.data, cancelled: false } } }] }));
      const active = await world.arm(ids.event);
      assert.equal((await world.deliver(active)).status, 'failed');
      assert.deepEqual(await changes(), beforeGuards);
      assert.deepEqual(await world.store.outboxPending(), outbox);
    } finally { await world.worker.dispose(); await rm(world.dir, { recursive: true, force: true }); }
  });

type OriginalHandlerWorld = Awaited<ReturnType<typeof originalHandlerWorld>>;
async function emittedSources(world: Pick<OriginalHandlerWorld, 'store'>, event: string) {
  const { WORK_OCCURRENCE_MODEL, readOccurrenceRow } = await import('@canlang/work/kernel/tables');
  const rows = await world.store.query({ model: WORK_OCCURRENCE_MODEL, authority: 'owner' });
  return rows.flatMap(row => {
    const receipt = readOccurrenceRow(row);
    if (receipt.result === null || typeof receipt.result !== 'object' || Array.isArray(receipt.result)) return [];
    const source = receipt.result as Record<string, unknown>;
    return source.kind === 'declared-event-source' && source.event === event ? [{ row, receipt, source }] : [];
  });
}

async function seedInspectionCancellation(world: OriginalHandlerWorld) {
  const ids = { site: uuidv7(FIXED_NOW, 401), asset: uuidv7(FIXED_NOW, 402), otherAsset: uuidv7(FIXED_NOW, 403),
    firstPlan: uuidv7(FIXED_NOW, 404), secondPlan: uuidv7(FIXED_NOW, 405), otherPlan: uuidv7(FIXED_NOW, 406),
    eligible: uuidv7(FIXED_NOW, 407), old: uuidv7(FIXED_NOW, 408), passed: uuidv7(FIXED_NOW, 409), cancellation: uuidv7(FIXED_NOW, 410) };
  await world.seed('rent_catalog.Location', ids.site, { name: 'Original inspection site', address: '1 Road', timezone: 'UTC',
    currency: 'EUR', hours: '09:00–18:00', arrival: 'Reception', active: true });
  const asset = { location: { id: ids.site }, identifier: 'original-asset', name: 'Original equipment', category: 'Cooling',
    supplier: null, resource: null, serial: null, warranty: null, manual: null, inspection_epoch: '2', retired: true };
  await world.seed('maintain.Asset', ids.asset, asset);
  await world.seed('maintain.Asset', ids.otherAsset, { ...asset, identifier: 'other-asset' });
  const plan = { name: 'Original inspection plan', assignee: { id: world.person.user_id }, assignee_email: 'inspector@example.test',
    cadence_days: '7', next_due: '2026-10-19', checklist: ['Cooling works'], revision: '1', asset_epoch: '1', active: true };
  // Reverse insertion order pins the authored ID ordering across emitted occurrences.
  await world.seed('maintain.Plan', ids.secondPlan, { ...plan, name: 'Second original plan' }, { model: 'maintain.Asset', id: ids.asset });
  await world.seed('maintain.Plan', ids.firstPlan, plan, { model: 'maintain.Asset', id: ids.asset });
  await world.seed('maintain.Plan', ids.otherPlan, plan, { model: 'maintain.Asset', id: ids.otherAsset });
  const inspection = { cancelled: false, cancellation: null, cancelled_by: null, cancelled_at: null,
    reminder_email: 'inspector@example.test', reminded_at: null, occurrence: 'original-inspection', due: '2026-10-19',
    checklist: ['Cooling works'], asset_epoch: '1', template_version: '1', inspector: { id: world.person.user_id },
    answers: [], result: 'pending', evidence: null, inspected_at: null, repair: null };
  await world.seed('maintain.Inspection', ids.eligible, inspection, { model: 'maintain.Plan', id: ids.firstPlan });
  await world.seed('maintain.Inspection', ids.old, { ...inspection, occurrence: 'old-inspection', due: '2018-12-31' },
    { model: 'maintain.Plan', id: ids.firstPlan });
  await world.seed('maintain.Inspection', ids.passed, { ...inspection, occurrence: 'passed-inspection', result: 'passed',
    answers: ['Cooling works'], evidence: 'Original measured evidence', inspected_at: '2026-10-01T09:00:00.000Z' },
  { model: 'maintain.Plan', id: ids.firstPlan });
  await world.seed('maintain.Cancellation', ids.cancellation, { plan: null, through: '1', cutoff: '2019-12-31', reason: 'asset_retired',
    author: { id: world.person.user_id }, at: new Date(FIXED_NOW).toISOString(), after: null, phase: 'plans' },
  { model: 'maintain.Asset', id: ids.asset });
  return ids;
}

test('whole original inspection cancellation persists emissions atomically and advances through real retained handlers once',
  { timeout: 120_000 }, async () => {
    const world = await originalHandlerWorld('maintain', 'cancel_inspection_step', 'OriginalInspectionCancellation');
    try {
      const ids = await seedInspectionCancellation(world);
      const { WORK_HANDLER_OCCURRENCE_MODEL, readHandlerOccurrenceRow } = await import('@canlang/work/kernel/handler-occurrence');
      const { invokeRetainedHandlerOccurrenceCanonical } = await import('./invoke.js');
      const model = (name: string) => asModel(`maintain.${name}`);
      const load = (name: string, id: string) => world.store.load(model(name), asId(id));
      const domain = () => Promise.all(['Asset', 'Plan', 'Inspection', 'Cancellation'].map(async name => ({ name,
        rows: await world.store.query({ model: model(name), authority: 'owner' }) })));
      const initial = await world.stage({ cancellation: { id: ids.cancellation, version: '1' } });
      const before = await domain();
      let failCommit = true;
      const unavailable: StoragePort = { ...world.store, commit: async batch => {
        if (failCommit && batch.writes.some(write => write.model === 'maintain.Plan')) {
          failCommit = false; throw new Error('transient original cancellation commit outage');
        }
        return world.store.commit(batch);
      } };
      await assert.rejects(world.deliver(initial, unavailable));
      assert.deepEqual(await domain(), before, 'failed commit retains neither business changes nor published events');
      assert.deepEqual(await emittedSources(world, world.event), []);
      assert.deepEqual(await world.store.query({ model: WORK_HANDLER_OCCURRENCE_MODEL, authority: 'owner' }), []);
      assert.equal((await world.deliver(initial)).status, 'completed');
      assert.equal((await load('Plan', ids.firstPlan))!.data.active, false);
      assert.equal((await load('Plan', ids.secondPlan))!.data.active, true);
      let revision = await world.store.readRevision();
      assert.equal((await world.deliver(initial)).status, 'replayed');
      assert.equal(await world.store.readRevision(), revision);
      const seenSources = new Set<string>();
      for (let turn = 0; turn < 4; turn++) {
        const sources = await emittedSources(world, world.event);
        assert.equal(sources.length, turn + 1, 'each original branch publishes exactly one next event');
        const fresh = sources.filter(source => !seenSources.has(source.row.id));
        assert.equal(fresh.length, 1);
        const source = fresh[0]!;
        assert.equal(source.receipt.status, 'completed');
        assert.deepEqual(source.source.scope, world.scope);
        const payload = source.source.payload as { cancellation: { id: string; version?: string } };
        assert.deepEqual(Object.keys(payload), ['cancellation']);
        assert.equal(payload.cancellation.id, ids.cancellation);
        const routes = (await world.store.query({ model: WORK_HANDLER_OCCURRENCE_MODEL, authority: 'owner' }))
          .map(readHandlerOccurrenceRow).filter(route => route.sourceOccurrence === source.row.id);
        assert.equal(routes.length, 1);
        assert.equal(routes[0]!.handler, world.handler);
        assert.equal(routes[0]!.event, world.event);
        assert.deepEqual(routes[0]!.payload, payload);
        assert.deepEqual(source.source.handlers, [{ handler: world.handler, kind: 'ordinary', occurrenceId: routes[0]!.occurrenceId }]);
        const selector = { sourceOccurrence: source.row.id, handler: world.handler, event: world.event, scope: world.scope };
        const consume = () => invokeRetainedHandlerOccurrenceCanonical({ asm: world.asm, artifact: world.artifact, app: world.app,
          selector, store: world.store, identities: world.identities, now: () => FIXED_NOW });
        if (turn === 0) {
          const other = await world.identities.createTeam({ timezone: 'UTC' });
          const beforeWrongOwner = await world.store.readRevision();
          assert.partialDeepStrictEqual(await invokeRetainedHandlerOccurrenceCanonical({ asm: world.asm, artifact: world.artifact,
            app: world.app, selector: { ...selector, scope: { ...selector.scope, owner: other.team_id } },
            store: world.store, identities: world.identities, now: () => FIXED_NOW }), { status: 'refused' });
          assert.equal(await world.store.readRevision(), beforeWrongOwner);
        }
        assert.partialDeepStrictEqual(await consume(), { status: 'completed' });
        seenSources.add(source.row.id);
        revision = await world.store.readRevision();
        assert.partialDeepStrictEqual(await consume(), { status: 'replayed' });
        assert.equal(await world.store.readRevision(), revision);
      }
      assert.equal((await load('Cancellation', ids.cancellation))!.data.phase, 'complete');
      assert.equal((await load('Plan', ids.secondPlan))!.data.active, false);
      assert.equal((await load('Plan', ids.otherPlan))!.data.active, true, 'another asset stays outside the original contained query');
      const cancelled = (await load('Inspection', ids.eligible))!;
      assert.equal(cancelled.data.cancelled, true);
      assert.equal(cancelled.data.cancellation, 'Asset retired');
      assert.deepEqual(cancelled.data.cancelled_by, { id: world.person.user_id });
      assert.equal(cancelled.data.cancelled_at, new Date(FIXED_NOW).toISOString());
      assert.equal((await load('Inspection', ids.old))!.data.cancelled, false);
      const passed = (await load('Inspection', ids.passed))!;
      assert.equal(passed.data.cancelled, false);
      assert.deepEqual(passed.data.answers, ['Cooling works']);
      assert.equal(passed.data.evidence, 'Original measured evidence');
      assert.equal((await emittedSources(world, world.event)).length, 4);
      assert.deepEqual(await world.store.outboxPending(), []);
    } finally { await world.worker.dispose(); await rm(world.dir, { recursive: true, force: true }); }
  });

async function seedOriginalInvoiceSettlement(world: OriginalHandlerWorld) {
  const ids = { site: uuidv7(FIXED_NOW, 501), customer: uuidv7(FIXED_NOW, 502), invoice: uuidv7(FIXED_NOW, 503),
    draft: uuidv7(FIXED_NOW, 504), collection: uuidv7(FIXED_NOW, 505), refund: uuidv7(FIXED_NOW, 506),
    pending: uuidv7(FIXED_NOW, 507), external: uuidv7(FIXED_NOW, 508), externalRefund: uuidv7(FIXED_NOW, 509) };
  const eur = (minor: string) => ({ minor, currency: 'EUR' });
  await world.seed('rent_catalog.Location', ids.site, { name: 'Original invoice location', address: '1 Road', timezone: 'UTC',
    currency: 'EUR', hours: '09:00–18:00', arrival: 'Reception', active: true });
  await world.seed('customer.Customer', ids.customer, { name: 'Original customer', kind: 'company', locations: [{ id: ids.site }], active: true });
  const invoice = { first_paid_at: null, attempt_limit: '3', retry_delay: '172800000', retry_until: null,
    next_collection: null, ledger_revision: '7', location: { id: ids.site }, source: 'original-invoice-source',
    issuer: 'Original operator', recipient: 'Original customer', recipient_email: 'customer@example.test',
    address: '1 Road', tax_reference: null, currency: 'EUR', description: 'Original invoice', terms: null,
    source_items: null, due: '2026-10-18', number: 'ORIGINAL-SELECTED', state: 'issued', total: eur('1000'),
    issued_at: '2026-10-01T00:00:00.000Z', consent: null, needs_review: false };
  const parent = { model: 'customer.Customer', id: ids.customer };
  await world.seed('invoice.Invoice', ids.invoice, invoice, parent);
  await world.seed('invoice.Invoice', ids.draft, { ...invoice, source: 'original-draft-source', state: 'draft', number: null, issued_at: null }, parent);
  const attempt = { mode: 'interactive', requested: '2026-10-01T00:00:00.000Z', outcome_at: null,
    provider_revision: '0', failure: null, disabled: false, reference: 'collection-receipt', amount: eur('400'),
    kind: 'collection', payment: null, status: 'succeeded', provider_reference: null, checkout: null,
    received: '2026-10-02T00:00:00.000Z', delivery: null, reason: null };
  const invoiceParent = { model: 'invoice.Invoice', id: ids.invoice };
  await world.seed('invoice.Attempt', ids.collection, attempt, invoiceParent);
  await world.seed('invoice.Attempt', ids.refund, { ...attempt, reference: 'refund-receipt', amount: eur('50'),
    kind: 'refund', payment: 'collection-receipt', reason: 'Original refund' }, invoiceParent);
  await world.seed('invoice.Attempt', ids.pending, { ...attempt, reference: 'pending-receipt', amount: eur('200'), status: 'pending', received: null }, invoiceParent);
  await world.seed('invoice.ExternalPayment', ids.external, { reference: 'bank-receipt', amount: eur('100'),
    received: '2026-10-03T00:00:00.000Z', evidence: 'Bank statement', author: { id: world.person.user_id } }, invoiceParent);
  await world.seed('invoice.ExternalRefund', ids.externalRefund, { payment: { id: ids.external }, reference: 'bank-refund', amount: eur('25'),
    received: '2026-10-04T00:00:00.000Z', evidence: 'Bank statement', reason: 'Original correction', author: { id: world.person.user_id } }, invoiceParent);
  return { ids, expected: { source: invoice.source, value: { source: invoice.source, invoice: ids.invoice, revision: '7',
    amount: eur('1000'), collected: eur('500'), refunded: eur('75'), collection_pending: true, refund_pending: false,
    state: 'issued', recorded_at: new Date(FIXED_NOW).toISOString() } } };
}

test('whole original invoice reconciliation emits its exact settlement or absence and refuses a draft without publishing',
  { timeout: 120_000 }, async () => {
    const world = await originalHandlerWorld('invoice', 'source_reconcile', 'OriginalInvoiceReconcile');
    try {
      const { expected } = await seedOriginalInvoiceSettlement(world);
      const snapshot = () => Promise.all(['invoice.Invoice', 'invoice.Attempt', 'invoice.Credit', 'invoice.ExternalPayment', 'invoice.ExternalRefund']
        .map(async name => ({ name, rows: await world.store.query({ model: asModel(name), authority: 'owner' }) })));
      const originalDomain = await snapshot();
      const event = 'invoice.ReconcileOutcome';
      for (const [source, payload] of [['missing-original-source', { source: 'missing-original-source', value: null }],
        ['original-invoice-source', expected]] as const) {
        const due = await world.stage({ source });
        const previous = (await emittedSources(world, event)).length;
        assert.equal((await world.deliver(due)).status, 'completed');
        const sources = await emittedSources(world, event);
        assert.equal(sources.length, previous + 1);
        const emitted = sources.find(entry => (entry.source.payload as { source: string }).source === source)!;
        assert.ok(emitted);
        assert.equal(emitted.receipt.status, 'completed');
        assert.deepEqual(emitted.source.payload, payload);
        assert.deepEqual(emitted.source.scope, world.scope);
        assert.deepEqual(emitted.source.handlers, [], 'no invented subscriber is attached to the original outcome');
        const revision = await world.store.readRevision();
        assert.equal((await world.deliver(due)).status, 'replayed');
        assert.equal(await world.store.readRevision(), revision);
      }
      const beforeRefusal = await emittedSources(world, event);
      const draft = await world.stage({ source: 'original-draft-source' });
      assert.equal((await world.deliver(draft)).status, 'failed');
      assert.deepEqual(await emittedSources(world, event), beforeRefusal);
      const rejectedRevision = await world.store.readRevision();
      assert.equal((await world.deliver(draft)).status, 'replayed');
      assert.equal(await world.store.readRevision(), rejectedRevision);
      assert.deepEqual(await snapshot(), originalDomain, 'all original settlement paths leave business rows unchanged');
      assert.deepEqual(await world.store.outboxPending(), []);
    } finally { await world.worker.dispose(); await rm(world.dir, { recursive: true, force: true }); }
  });
