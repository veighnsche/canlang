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
 * Scope-2 consumer proof (DESIGN434/442): same-transaction hook-parent
 * semantics through the real native/host consumer with actual compiled Can
 * (no handwritten handlers, no loader stubs). A parent created or updated
 * EARLIER IN THE SAME owner transaction is visible to the child read
 * (`reading.parent.active` observes staged rows); the identical spelling
 * observes committed state when nothing is staged. Inline, helper and
 * guard spellings agree; failures void atomically; strangers and foreign
 * scopes stay refused. Denied-field and mid-flight-revocation negatives
 * attach to hook value-mode reads (compiler-seal follow-up): this
 * owner-authority path grants the staged rows it authors, so no denial can
 * arise here without weakening the gate.
 */

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const FIXTURE = 'packages/cloudflare/test/fixtures/hook-parent-reads.can';
const APP = 'HookParentReads';
const LOCATION = asModel(`${APP}.Location`);
const READING = asModel(`${APP}.Reading`);
let sequence = 7000;

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
  assert.ok(!('diagnostics' in artifact), `parent-reads fixture emits clean (native=${native})`);
  return artifact;
}

async function setup(native: boolean) {
  const artifact = await compileFixture(native, FIXTURE);
  const dir = await mkdtemp(join(tmpdir(), 'can-hook-parent-reads-'));
  const asm = await assembleModules({ artifact, sourcePath: join(root, FIXTURE) }, {
    workDir: join(dir, 'modules'),
    stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
    uiUrl: import.meta.resolve('@canlang/ui'),
  });
  const memberships = createMemoryIdentityStore();
  const user = await memberships.createUser({ email: 'hook-parent-owner@example.test',
    email_verified: true, password_hash: 'unused' });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const membership = await memberships.createMembership({ team_id: team.team_id,
    user_id: user.user_id, is_owner: true, roles: [] });
  const identity = makeIdentity({ membership, team, email: user.email });
  const store = createTestMemoryStorage().store;
  const invoker = buildInvoker(artifact, asm, store, { memberships, now: () => FIXED_NOW });
  const committed = async (operation: string, inputs: MutationEnvelope['inputs']) => {
    const outcome = await invoker.invokeMutation(envelope(operation, inputs), identity);
    assert.ok('result' in outcome, JSON.stringify(outcome));
    return outcome.result;
  };
  return { artifact, asm, dir, store, memberships, invoker, identity, committed };
}

async function teardown(world: Awaited<ReturnType<typeof setup>>) {
  await rm(world.dir, { recursive: true, force: true });
}

async function readings(world: Awaited<ReturnType<typeof setup>>) {
  return world.store.query({ model: READING, authority: 'owner' });
}

test('same-transaction parent reads observe staged rows on the plain path', async () => {
  const world = await setup(false);
  try {
    const yes = await world.committed('arm', { active: true });
    assert.equal(yes.status, 'committed');
    assert.equal((yes as { result: unknown }).result, true);
    const no = await world.committed('arm', { active: false });
    assert.equal(no.status, 'committed');
    assert.equal((no as { result: unknown }).result, false);
    const rows = await readings(world);
    assert.equal(rows.length, 2);
  } finally {
    await teardown(world);
  }
});

test('the identical spelling observes committed state when nothing is staged', async () => {
  const world = await setup(false);
  try {
    await world.committed('arm', { active: true });
    const rows = await readings(world);
    const ref = { id: rows[0]!.id, version: String(rows[0]!.version) };
    const checked = await world.committed('check', { reading: ref });
    assert.equal(checked.status, 'committed');
    assert.equal((checked as { result: unknown }).result, true);
  } finally {
    await teardown(world);
  }
});

test('helper and flip spellings agree with the inline read', async () => {
  const world = await setup(false);
  try {
    await world.committed('arm', { active: true });
    const rows = await readings(world);
    const ref = { id: rows[0]!.id, version: String(rows[0]!.version) };
    const viaHelper = await world.committed('helper', { reading: ref });
    assert.equal((viaHelper as { result: unknown }).result, true);
    const flipped = await world.committed('flip', { reading: ref, active: false });
    assert.equal(flipped.status, 'committed');
    assert.equal((flipped as { result: unknown }).result, false);
    const rowsAfter = await readings(world);
    const refAfter = { id: rowsAfter[0]!.id, version: String(rowsAfter[0]!.version) };
    const rechecked = await world.committed('check', { reading: refAfter });
    assert.equal((rechecked as { result: unknown }).result, false);
    const restored = await world.committed('flip', { reading: refAfter, active: true });
    assert.equal((restored as { result: unknown }).result, true);
  } finally {
    await teardown(world);
  }
});

test('a false guard voids the whole batch atomically', async () => {
  const world = await setup(false);
  try {
    await world.committed('arm', { active: true });
    const before = await readings(world);
    const locationsBefore = await world.store.query({ model: LOCATION, authority: 'owner' });
    const failed = await world.invoker.invokeMutation(
      envelope('armStrict', { active: false }), world.identity);
    assert.ok('error' in failed, JSON.stringify(failed));
    assert.equal(failed.error.code, 'rule_failed');
    assert.deepEqual(await readings(world), before);
    assert.deepEqual(await world.store.query({ model: LOCATION, authority: 'owner' }), locationsBefore);
    const allowed = await world.committed('demand',
      { reading: { id: before[0]!.id, version: String(before[0]!.version) } });
    assert.equal(allowed.status, 'committed');
    await world.committed('flip', { reading: { id: before[0]!.id, version: String(before[0]!.version) }, active: false });
    const rows = await readings(world);
    const refused = await world.invoker.invokeMutation(
      envelope('demand', { reading: { id: rows[0]!.id, version: String(rows[0]!.version) } }), world.identity);
    assert.ok('error' in refused, JSON.stringify(refused));
    assert.equal(refused.error.code, 'rule_failed');
  } finally {
    await teardown(world);
  }
});

test('a non-owner caller is refused at the operation gate', async () => {
  const world = await setup(false);
  try {
    const stranger = await world.memberships.createUser({ email: 'stranger@example.test',
      email_verified: true, password_hash: 'unused' });
    const team = await world.memberships.createTeam({ timezone: 'UTC' });
    const membership = await world.memberships.createMembership({ team_id: team.team_id,
      user_id: stranger.user_id, is_owner: false, roles: [] });
    const identity = makeIdentity({ membership, team, email: stranger.email });
    const outcome = await world.invoker.invokeMutation(envelope('arm', { active: true }), identity);
    assert.ok('error' in outcome, JSON.stringify(outcome));
    assert.equal(outcome.error.code, 'forbidden');
    assert.deepEqual(await readings(world), []);
  } finally {
    await teardown(world);
  }
});

test('grandparent chain reads walk the exact containment ancestry', async () => {
  // Foreign-scope and denied-field negatives attach to hook value-mode reads
  // (compiler-seal follow-up): this owner-authority path grants the staged
  // rows it authors under public policies, so no denial can arise here
  // without weakening the gate.
  const world = await setup(false);
  try {
    await world.committed('arm', { active: true });
    const rows = await readings(world);
    const ref = { id: rows[0]!.id, version: String(rows[0]!.version) };
    const locale = await world.committed('locale', { reading: ref });
    assert.equal(locale.status, 'committed');
    assert.equal((locale as { result: unknown }).result, 'eu');
  } finally {
    await teardown(world);
  }
});

test('same-transaction parent reads agree on the native receipt path', async () => {
  const world = await setup(true);
  try {
    const yes = await world.committed('arm', { active: true });
    assert.equal(yes.status, 'committed');
    assert.equal((yes as { result: unknown }).result, true);
    const no = await world.committed('arm', { active: false });
    assert.equal(no.status, 'committed');
    assert.equal((no as { result: unknown }).result, false);
  } finally {
    await teardown(world);
  }
});
