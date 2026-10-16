import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import type { CompileArtifact, MutationEnvelope } from '@canlang/contracts';
import {
  FIXED_NOW, asId, asModel, asOperationId, makeIdentity, uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import { createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker } from '@canlang/cloudflare/worker/assembly';

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
  const { stdout } = await execFileAsync(compiler, args, { cwd: root, env, maxBuffer: 64 * 1024 * 1024 });
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
