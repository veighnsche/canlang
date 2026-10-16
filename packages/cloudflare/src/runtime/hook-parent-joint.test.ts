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
  FIXED_NOW, asModel, asOperationId, makeIdentity, uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import { createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker } from '@canlang/cloudflare/worker/assembly';

/**
 * CAN18-v1 joint hook acceptance (C26 State/host loaders x C27 compiler
 * emission): ACTUAL compiled `scenario on=` hook source through the real
 * host/State loader.
 *
 * The fixture pair (`test/fixtures/hook-parent-joint{,-helpers}.can`)
 * compiles with the joint producer (frozen `can` binary + matching native
 * catalog via CAN_COMPILER_BIN / CAN_NATIVE_CATALOG) to exit 0 with zero
 * diagnostics. One create-hook per child model (duplicate create hooks are
 * barred) fires on DIRECT crud operations through buildInvoker; the host
 * bridge serves the emitting decision reads from the defining State
 * loadParent (staged-plus-committed snapshot, exact containment chain).
 *
 * Covered: (a) private-guard (`read=owner`) success on If-condition +
 * Require + local/imported helper-inherited decision reads; (b) public
 * body-value copy succeeds through the value-mode public projection, while
 * non-public granted/withheld copies refuse precisely (`forbidden`, thrown
 * on access, never a null-mask) with atomic void; (c) inline/local/imported
 * equivalence in both guard directions; (d) rollback on denied and
 * guard-failed writes with atomic effects (trigger plus hook-staged kin
 * absent); (e) committed-parent control across updates; (f)
 * guessed/tampered/foreign parents and stranger callers refused.
 * Scenario-cause stages skip hooks by design (T31 flat, no cascade), so
 * in-scenario creates never fire crud hooks; same-transaction staged-parent
 * visibility through COMPILED hooks stays on the loader-level suite.
 *
 * Explicitly open (not asserted here): per-caller value grants
 * (owner/members/roles stay conservatively withheld until a per-fire viewer
 * observation is plumbed) and row-typed helper parameters over the parent
 * linkage (loud E6008 by C27 seal).
 */

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const FIXTURE = 'packages/cloudflare/test/fixtures/hook-parent-joint.can';
const HELPERS = 'packages/cloudflare/test/fixtures/hook-parent-joint-helpers.can';
const APP = 'HookParentJoint';
const LOCATION = asModel(`${APP}.Location`);
let sequence = 8100;

function envelope(operation: string, inputs: MutationEnvelope['inputs'], app = APP): MutationEnvelope {
  return { operation: `${app}.${operation}`, inputs,
    operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)) };
}

async function compileFixture(extraArgs: readonly string[] = []): Promise<CompileArtifact> {
  const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
  const catalog = process.env.CAN_NATIVE_CATALOG ??
    join(root, 'packages/cloudflare/dist/native-catalog.json');
  const args = ['compile', '--format=json', '--catalog', catalog,
    ...extraArgs, FIXTURE, HELPERS];
  const env = { ...process.env };
  delete env.CAN_CATALOG;
  const { stdout } = await execFileAsync(compiler, args, { cwd: root, env, maxBuffer: 64 * 1024 * 1024 });
  const artifact = JSON.parse(stdout) as CompileArtifact;
  assert.ok(!('diagnostics' in artifact), 'joint fixture emits clean');
  return artifact;
}

async function setup(extraArgs: readonly string[] = []) {
  const artifact = await compileFixture(extraArgs);
  const dir = await mkdtemp(join(tmpdir(), 'can-hook-parent-joint-'));
  const asm = await assembleModules({ artifact, sourcePath: join(root, FIXTURE) }, {
    workDir: join(dir, 'modules'),
    stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
    uiUrl: import.meta.resolve('@canlang/ui'),
  });
  const memberships = createMemoryIdentityStore();
  const user = await memberships.createUser({ email: 'hook-joint-owner@example.test',
    email_verified: true, password_hash: 'unused' });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const membership = await memberships.createMembership({ team_id: team.team_id,
    user_id: user.user_id, is_owner: true, roles: [] });
  const identity = makeIdentity({ membership, team, email: user.email });
  const store = createTestMemoryStorage().store;
  const invoker = buildInvoker(artifact, asm, store, { memberships, now: () => FIXED_NOW });
  const invoke = (operation: string, inputs: MutationEnvelope['inputs'], id = identity) =>
    invoker.invokeMutation(envelope(operation, inputs), id);
  const committed = async (operation: string, inputs: MutationEnvelope['inputs']) => {
    const outcome = await invoke(operation, inputs);
    assert.ok('result' in outcome, JSON.stringify(outcome));
    return outcome.result;
  };
  return { artifact, asm, dir, store, memberships, invoker, identity, invoke, committed };
}

async function teardown(world: Awaited<ReturnType<typeof setup>>) {
  await rm(world.dir, { recursive: true, force: true });
}

const ref = (row: { id: string; version: number | string }) =>
  ({ id: row.id, version: String(row.version) });

type Rec = { id: string; version: number };
const recOf = (result: unknown): Rec => {
  const records = (result as { records?: readonly unknown[] }).records;
  assert.ok(records !== undefined && records.length > 0, JSON.stringify(result).slice(0, 200));
  return records[0] as Rec;
};

async function stageFamily(world: Awaited<ReturnType<typeof setup>>, active: boolean) {
  const siteRow = recOf(await world.committed('Site.create', { region: 'eu' }));
  const locRow = recOf(await world.committed('Location.create',
    { parent: ref(siteRow), active, timezone: 'UTC', secret: 's3cr3t' }));
  return { siteRow, locRow };
}

async function rowsOf(world: Awaited<ReturnType<typeof setup>>, model: string) {
  return world.store.query({ model: asModel(`${APP}.${model}`), authority: 'owner' });
}

test('private guard arms on the active parent and stages kin atomically', async () => {
  const world = await setup();
  try {
    const { locRow } = await stageFamily(world, true);
    const armed = await world.committed('Reading.create',
      { parent: ref(locRow), taken: true, snapshot: 'new' });
    assert.equal(armed.status, 'committed');
    const readings = await rowsOf(world, 'Reading');
    assert.equal(readings.length, 1);
    // The private decision reads gated, then the body set applied.
    assert.equal((readings[0]!.data as Record<string, unknown>)['snapshot'], 'armed');
    // Hook-staged kin commits in the same atomic batch.
    const kin = await rowsOf(world, 'Kin');
    assert.equal(kin.length, 1);
    assert.equal((kin[0]!.data as Record<string, unknown>)['snapshot'], 'kin');
  } finally {
    await teardown(world);
  }
});

test('inactive parent commits untouched: all decision spellings agree false', async () => {
  const world = await setup();
  try {
    const { locRow } = await stageFamily(world, false);
    const outcome = await world.committed('Reading.create',
      { parent: ref(locRow), taken: true, snapshot: 'new' });
    assert.equal(outcome.status, 'committed');
    const readings = await rowsOf(world, 'Reading');
    assert.equal(readings.length, 1);
    assert.equal((readings[0]!.data as Record<string, unknown>)['snapshot'], 'new');
    // A disagreeing helper would have thrown and voided the batch instead.
    assert.deepEqual(await rowsOf(world, 'Kin'), []);
  } finally {
    await teardown(world);
  }
});

test('parent update re-arms: the hook tracks current committed authority', async () => {
  const world = await setup();
  try {
    const { locRow } = await stageFamily(world, true);
    await world.committed('Reading.create', { parent: ref(locRow), taken: true, snapshot: 'new' });
    const flipped = await world.committed('Location.update', { record: ref(locRow), active: false });
    assert.equal(flipped.status, 'committed');
    const locRow2 = recOf(flipped);
    const quiet = await world.committed('Reading.create',
      { parent: ref(locRow2), taken: true, snapshot: 'new' });
    assert.equal(quiet.status, 'committed');
    const readings = await rowsOf(world, 'Reading');
    assert.deepEqual(readings.map((row) => (row.data as Record<string, unknown>)['snapshot']),
      ['armed', 'new']);
    const restored = await world.committed('Location.update', { record: ref(locRow2), active: true });
    const locRow3 = recOf(restored);
    await world.committed('Reading.create', { parent: ref(locRow3), taken: true, snapshot: 'new' });
    const after = await rowsOf(world, 'Reading');
    assert.deepEqual(after.map((row) => (row.data as Record<string, unknown>)['snapshot']),
      ['armed', 'new', 'armed']);
  } finally {
    await teardown(world);
  }
});

test('public body-value copy succeeds through the value projection', async () => {
  const world = await setup();
  try {
    const { siteRow } = await stageFamily(world, true);
    const marked = await world.committed('Beacon.create',
      { parent: ref(siteRow), label: 'new' });
    assert.equal(marked.status, 'committed');
    const beacons = await rowsOf(world, 'Beacon');
    assert.equal(beacons.length, 1);
    assert.equal((beacons[0]!.data as Record<string, unknown>)['label'], 'eu');
  } finally {
    await teardown(world);
  }
});

test('owner-granted body-value copy refuses forbidden with atomic void', async () => {
  const world = await setup();
  try {
    const { locRow } = await stageFamily(world, true);
    const failed = await world.invoke('Copy.create',
      { parent: ref(locRow), taken: true, snapshot: 'new' });
    assert.ok('error' in failed, JSON.stringify(failed));
    assert.equal(failed.error.code, 'forbidden');
    assert.equal(failed.error.message, 'Record field is not readable.');
    // Precise refusal, never a null-masked copy: no row survives.
    assert.deepEqual(await rowsOf(world, 'Copy'), []);
  } finally {
    await teardown(world);
  }
});

test('denied body-value copy refuses forbidden; staged kin voids atomically', async () => {
  const world = await setup();
  try {
    const { locRow } = await stageFamily(world, true);
    const failed = await world.invoke('Steal.create',
      { parent: ref(locRow), taken: true, snapshot: 'new' });
    assert.ok('error' in failed, JSON.stringify(failed));
    assert.equal(failed.error.code, 'forbidden');
    assert.equal(failed.error.message, 'Record field is not readable.');
    // The denial lands after kin staged: trigger plus staged kin are gone.
    assert.deepEqual(await rowsOf(world, 'Steal'), []);
    assert.deepEqual(await rowsOf(world, 'Kin'), []);
  } finally {
    await teardown(world);
  }
});

test('guard-denied strict voids trigger plus staged kin atomically', async () => {
  const world = await setup();
  try {
    const { locRow } = await stageFamily(world, true);
    const failed = await world.invoke('Strict.create',
      { parent: ref(locRow), taken: true, snapshot: 'new' });
    assert.ok('error' in failed, JSON.stringify(failed));
    assert.equal(failed.error.code, 'rule_failed');
    assert.deepEqual(await rowsOf(world, 'Strict'), []);
    assert.deepEqual(await rowsOf(world, 'Kin'), []);
    // The family base survives: only the denied batch voided.
    assert.equal((await rowsOf(world, 'Location')).length, 1);
  } finally {
    await teardown(world);
  }
});

test('guessed, tampered and foreign parents refuse; stranger refused', async () => {
  const world = await setup();
  try {
    const { locRow } = await stageFamily(world, true);
    const guessed = await world.invoke('Reading.create',
      { parent: { id: 'loc-guessed', version: '1' }, taken: true, snapshot: 'new' });
    assert.ok('error' in guessed, JSON.stringify(guessed));
    assert.equal(guessed.error.code, 'not_found');
    const tampered = await world.invoke('Reading.create',
      { parent: { id: locRow.id, version: '999' }, taken: true, snapshot: 'new' });
    assert.ok('error' in tampered, JSON.stringify(tampered));
    assert.equal(tampered.error.code, 'conflict');
    const other = await world.committed('Other.create', { note: 'x' });
    const otherRow = recOf(other);
    const foreign = await world.invoke('Reading.create',
      { parent: ref(otherRow), taken: true, snapshot: 'new' });
    assert.ok('error' in foreign, JSON.stringify(foreign));
    assert.equal(foreign.error.code, 'not_found');
    const stranger = await world.memberships.createUser({ email: 'joint-stranger@example.test',
      email_verified: true, password_hash: 'unused' });
    const team = await world.memberships.createTeam({ timezone: 'UTC' });
    const membership = await world.memberships.createMembership({ team_id: team.team_id,
      user_id: stranger.user_id, is_owner: false, roles: [] });
    const identity = makeIdentity({ membership, team, email: stranger.email });
    const denied = await world.invoke('Reading.create',
      { parent: ref(locRow), taken: true, snapshot: 'new' }, identity);
    assert.ok('error' in denied, JSON.stringify(denied));
    assert.equal(denied.error.code, 'forbidden');
    // Nothing from the refused attempts survives.
    assert.deepEqual(await rowsOf(world, 'Reading'), []);
    assert.deepEqual(await rowsOf(world, 'Kin'), []);
  } finally {
    await teardown(world);
  }
});

test('native-receipts tuple agrees on the arm', async () => {
  const world = await setup(['--native-scenario-receipts']);
  try {
    const { locRow } = await stageFamily(world, true);
    const armed = await world.committed('Reading.create',
      { parent: ref(locRow), taken: true, snapshot: 'new' });
    assert.equal(armed.status, 'committed');
    const readings = await rowsOf(world, 'Reading');
    assert.equal((readings[0]!.data as Record<string, unknown>)['snapshot'], 'armed');
  } finally {
    await teardown(world);
  }
});
