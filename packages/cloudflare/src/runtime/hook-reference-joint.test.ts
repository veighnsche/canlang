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
 * CAN18-v1 joint reference acceptance (file 14 `Account.location` first
 * shape): ACTUAL compiled `scenario on=` hook source reading
 * `event.after.location.timezone` through the real host/State reference
 * loader (`transitive.loadReference` → `loadReference`).
 *
 * Covered: granted owner sees the timezone through inline + local +
 * imported helper spellings agreeing (decision If/Require plus value copy);
 * withheld member/stranger get precise `forbidden` with atomic void;
 * revocation loses the grant on the next fire; guessed/foreign reference
 * targets refuse (`not_found`); denied secret and guard-denied strict void
 * atomically. The ancestor fence stays intact — reference identities never
 * go through `loadParent`.
 */

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const FIXTURE = 'packages/cloudflare/test/fixtures/hook-reference-joint.can';
const HELPERS = 'packages/cloudflare/test/fixtures/hook-reference-joint-helpers.can';
const APP = 'HookReferenceJoint';
const LOCATION = asModel(`${APP}.Location`);
let sequence = 9100;

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
  const dir = await mkdtemp(join(tmpdir(), 'can-hook-ref-joint-'));
  const asm = await assembleModules({ artifact, sourcePath: join(root, FIXTURE) }, {
    workDir: join(dir, 'modules'),
    stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
    uiUrl: import.meta.resolve('@canlang/ui'),
  });
  const memberships = createMemoryIdentityStore();
  const user = await memberships.createUser({ email: 'hook-ref-joint-owner@example.test',
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
  return { artifact, asm, dir, store, memberships, team, membership, invoker, identity, invoke, committed };
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

async function stageFamily(world: Awaited<ReturnType<typeof setup>>, timezone: string) {
  const custRow = recOf(await world.committed('Customer.create', { name: 'c' }));
  const locRow = recOf(await world.committed('Location.create',
    { timezone, secret: 's3cr3t' }));
  return { custRow, locRow };
}

async function rowsOf(world: Awaited<ReturnType<typeof setup>>, model: string) {
  return world.store.query({ model: asModel(`${APP}.${model}`), authority: 'owner' });
}

test('private guard arms on the referenced UTC timezone and stages kin atomically', async () => {
  const world = await setup();
  try {
    const { custRow, locRow } = await stageFamily(world, 'UTC');
    const armed = await world.committed('Probe.create',
      { parent: ref(custRow), location: ref(locRow), note: 'new' });
    assert.equal(armed.status, 'committed');
    const probes = await rowsOf(world, 'Probe');
    assert.equal(probes.length, 1);
    assert.equal((probes[0]!.data as Record<string, unknown>)['note'], 'armed');
    const kin = await rowsOf(world, 'Kin');
    assert.equal(kin.length, 1);
  } finally {
    await teardown(world);
  }
});

test('non-UTC referenced timezone commits untouched: all decision spellings agree false', async () => {
  const world = await setup();
  try {
    const { custRow, locRow } = await stageFamily(world, 'Europe/Brussels');
    const outcome = await world.committed('Probe.create',
      { parent: ref(custRow), location: ref(locRow), note: 'new' });
    assert.equal(outcome.status, 'committed');
    // The If-condition short-circuits false: no Require runs, no kin stages,
    // no set applies. A disagreeing helper would have thrown instead.
    const probes = await rowsOf(world, 'Probe');
    assert.equal((probes[0]!.data as Record<string, unknown>)['note'], 'new');
    assert.deepEqual(await rowsOf(world, 'Kin'), []);
  } finally {
    await teardown(world);
  }
});

test('owner-granted body-value copy commits through local and imported helpers', async () => {
  const world = await setup();
  try {
    const { custRow, locRow } = await stageFamily(world, 'UTC');
    const copied = await world.committed('Copy.create',
      { parent: ref(custRow), location: ref(locRow), note: 'UTC' });
    assert.equal(copied.status, 'committed');
    const copies = await rowsOf(world, 'Copy');
    assert.equal(copies.length, 1);
    assert.equal((copies[0]!.data as Record<string, unknown>)['note'], 'UTC');
  } finally {
    await teardown(world);
  }
});

test('withheld member copy refuses forbidden with atomic void', async () => {
  const world = await setup();
  try {
    const { custRow, locRow } = await stageFamily(world, 'UTC');
    const memberUser = await world.memberships.createUser({ email: 'ref-joint-member@example.test',
      email_verified: true, password_hash: 'unused' });
    const memberMembership = await world.memberships.createMembership({ team_id: world.team.team_id,
      user_id: memberUser.user_id, is_owner: false, roles: [] });
    const memberIdentity = makeIdentity({ membership: memberMembership, team: world.team, email: memberUser.email });
    const failed = await world.invoke('Copy.create',
      { parent: ref(custRow), location: ref(locRow), note: 'UTC' }, memberIdentity);
    assert.ok('error' in failed, JSON.stringify(failed));
    assert.equal(failed.error.code, 'forbidden');
    assert.equal(failed.error.message, 'Record field is not readable.');
    assert.deepEqual(await rowsOf(world, 'Copy'), []);
  } finally {
    await teardown(world);
  }
});

test('stranger copy refuses forbidden with atomic void', async () => {
  const world = await setup();
  try {
    const { custRow, locRow } = await stageFamily(world, 'UTC');
    const stranger = await world.memberships.createUser({ email: 'ref-joint-stranger@example.test',
      email_verified: true, password_hash: 'unused' });
    const team = await world.memberships.createTeam({ timezone: 'UTC' });
    const membership = await world.memberships.createMembership({ team_id: team.team_id,
      user_id: stranger.user_id, is_owner: false, roles: [] });
    const identity = makeIdentity({ membership, team, email: stranger.email });
    const failed = await world.invoke('Copy.create',
      { parent: ref(custRow), location: ref(locRow), note: 'UTC' }, identity);
    assert.ok('error' in failed, JSON.stringify(failed));
    assert.equal(failed.error.code, 'forbidden');
    assert.equal(failed.error.message, 'Record field is not readable.');
    assert.deepEqual(await rowsOf(world, 'Copy'), []);
  } finally {
    await teardown(world);
  }
});

test('revoked caller loses the granted copy on the next fire', async () => {
  const world = await setup();
  try {
    const { custRow, locRow } = await stageFamily(world, 'UTC');
    const first = await world.committed('Copy.create',
      { parent: ref(custRow), location: ref(locRow), note: 'UTC' });
    assert.equal(first.status, 'committed');
    await world.memberships.removeMembership(world.membership.membership_id);
    const failed = await world.invoke('Copy.create',
      { parent: ref(custRow), location: ref(locRow), note: 'UTC' });
    assert.ok('error' in failed, JSON.stringify(failed));
    assert.equal(failed.error.code, 'forbidden');
    assert.equal(failed.error.message, 'Record field is not readable.');
    const copies = await rowsOf(world, 'Copy');
    assert.equal(copies.length, 1);
  } finally {
    await teardown(world);
  }
});

test('denied secret copy refuses forbidden; staged kin voids atomically', async () => {
  const world = await setup();
  try {
    const { custRow, locRow } = await stageFamily(world, 'UTC');
    const failed = await world.invoke('Steal.create',
      { parent: ref(custRow), location: ref(locRow), note: 'new' });
    assert.ok('error' in failed, JSON.stringify(failed));
    assert.equal(failed.error.code, 'forbidden');
    assert.equal(failed.error.message, 'Record field is not readable.');
    assert.deepEqual(await rowsOf(world, 'Steal'), []);
    assert.deepEqual(await rowsOf(world, 'Kin'), []);
  } finally {
    await teardown(world);
  }
});

test('guard-denied strict voids trigger plus staged kin atomically', async () => {
  const world = await setup();
  try {
    const { custRow, locRow } = await stageFamily(world, 'UTC');
    const failed = await world.invoke('Strict.create',
      { parent: ref(custRow), location: ref(locRow), note: 'new' });
    assert.ok('error' in failed, JSON.stringify(failed));
    assert.equal(failed.error.code, 'rule_failed');
    assert.deepEqual(await rowsOf(world, 'Strict'), []);
    assert.deepEqual(await rowsOf(world, 'Kin'), []);
    assert.equal((await rowsOf(world, 'Location')).length, 1);
  } finally {
    await teardown(world);
  }
});

test('guessed and foreign references refuse; stranger probe refused', async () => {
  const world = await setup();
  try {
    const { custRow, locRow } = await stageFamily(world, 'UTC');
    const guessed = await world.invoke('Probe.create',
      { parent: ref(custRow), location: { id: 'loc-guessed', version: '1' }, note: 'new' });
    assert.ok('error' in guessed, JSON.stringify(guessed));
    assert.equal(guessed.error.code, 'not_found');
    const other = await world.committed('Other.create', { note: 'x' });
    const otherRow = recOf(other);
    const foreign = await world.invoke('Probe.create',
      { parent: ref(custRow), location: { id: otherRow.id, version: String(otherRow.version) }, note: 'new' });
    assert.ok('error' in foreign, JSON.stringify(foreign));
    // Foreign id on the genuine target model is a missing row (the edge
    // matches, then the load finds nothing) — never a granted row.
    assert.equal(foreign.error.code, 'not_found');
    const stranger = await world.memberships.createUser({ email: 'ref-probe-stranger@example.test',
      email_verified: true, password_hash: 'unused' });
    const team = await world.memberships.createTeam({ timezone: 'UTC' });
    const membership = await world.memberships.createMembership({ team_id: team.team_id,
      user_id: stranger.user_id, is_owner: false, roles: [] });
    const identity = makeIdentity({ membership, team, email: stranger.email });
    const denied = await world.invoke('Probe.create',
      { parent: ref(custRow), location: ref(locRow), note: 'new' }, identity);
    assert.ok('error' in denied, JSON.stringify(denied));
    // Probe CRUD is owner-gated, so the stranger fails admission before hooks.
    assert.equal(denied.error.code, 'forbidden');
    assert.deepEqual(await rowsOf(world, 'Probe'), []);
    assert.deepEqual(await rowsOf(world, 'Kin'), []);
  } finally {
    await teardown(world);
  }
});

test('native-receipts tuple agrees on the arm', async () => {
  const world = await setup(['--native-scenario-receipts']);
  try {
    const { custRow, locRow } = await stageFamily(world, 'UTC');
    const armed = await world.committed('Probe.create',
      { parent: ref(custRow), location: ref(locRow), note: 'new' });
    assert.equal(armed.status, 'committed');
    const probes = await rowsOf(world, 'Probe');
    assert.equal((probes[0]!.data as Record<string, unknown>)['note'], 'armed');
  } finally {
    await teardown(world);
  }
});
