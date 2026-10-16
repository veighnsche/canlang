/** REVIEW23 regression: a confined hook first-query consumed only by its
 * `Require` evaluates as a recorded owner decision under a private
 * (`read=owner`) policy. Stored-field guards and bare-presence guards
 * complete on a present granted row; unapproved/absent rows fail closed.
 * Ordinary viewer behavior is unchanged (see hook-first-delivery.test.ts).
 */
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
  FIXED_NOW, asOperationId, makeIdentity, uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import { createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker } from '@canlang/cloudflare/worker/assembly';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
let sequence = 9300;

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
  assert.ok(!('diagnostics' in artifact), `private fixture emits clean: ${fixture}`);
  return artifact;
}

async function buildWorld(fixture: string, app: string, approved: boolean | null) {
  const artifact = await compileFixture(true, fixture);
  const dir = await mkdtemp(join(tmpdir(), 'can-hook-first-private-'));
  const asm = await assembleModules({ artifact, sourcePath: join(root, fixture) }, {
    workDir: join(dir, 'modules'),
    stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
    uiUrl: import.meta.resolve('@canlang/ui'),
  });
  const memberships = createMemoryIdentityStore();
  const user = await memberships.createUser({ email: 'hook-first-private-owner@example.test',
    email_verified: true, password_hash: 'unused' });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const membership = await memberships.createMembership({ team_id: team.team_id,
    user_id: user.user_id, is_owner: true, roles: [] });
  const identity = makeIdentity({ membership, team, email: user.email });
  const store = createTestMemoryStorage().store;
  const invoker = buildInvoker(artifact, asm, store, { memberships, now: () => FIXED_NOW });
  const scope = { app, owner: team.team_id, ownerPackage: app };
  const at = FIXED_NOW + 60_000;
  const envelope = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
    operation: `${app}.${operation}`, inputs,
    operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)) });
  const slot = (await invoker.invokeMutation(
    envelope('Slot.create', { label: 'key' }), identity));
  assert.ok('result' in slot && slot.result.status === 'committed');
  const slotRow = slot.result.records![0] as { id: string; version: number };
  if (approved !== null) {
    const created = await invoker.invokeMutation(
      envelope('Budget.create', { source: 'acme-renewal', approved }), identity);
    assert.ok('result' in created && created.result.status === 'committed');
  }
  const arm = await invoker.invokeMutation(
    envelope('arm', { slot: { id: slotRow.id, version: String(slotRow.version) },
      at: new Date(at).toISOString(), source: 'acme-renewal' }), identity);
  assert.ok('result' in arm && arm.result.status === 'committed');
  return { artifact, asm, dir, store, memberships, invoker, identity, scope, at, slotRow, app, envelope };
}

async function deliver(world: Awaited<ReturnType<typeof buildWorld>>,
  scopeOverride?: Record<string, string>) {
  const { invokeDueScheduleCanonical } = await import('@canlang/cloudflare/runtime/invoke');
  const { scheduleByKeyQuery } = await import('@canlang/work/kernel/tables');
  const scope = scopeOverride === undefined
    ? world.scope : { ...world.scope, ...scopeOverride };
  const rows = await world.store.query(scheduleByKeyQuery(world.scope, world.slotRow.id));
  const row = rows.find((entry: { data: Record<string, unknown> }) =>
    entry.data['state'] === 'pending');
  assert.ok(row, 'arm stages one pending occurrence');
  return invokeDueScheduleCanonical({ asm: world.asm, artifact: world.artifact, app: world.app,
    handler: `${world.app}.probe`, due: { key: world.slotRow.id, scope, occurrenceId: row.id,
      event: `${world.app}.Tick`, at: world.at },
    store: world.store, identities: world.memberships, now: () => world.at });
}

async function setup(fixture: string, app: string, approved: boolean | null) {
  const world = await buildWorld(fixture, app, approved);
  try {
    return await deliver(world);
  } finally {
    await rm(world.dir, { recursive: true, force: true });
  }
}

test('native private stored-field guard completes on a granted row', async () => {
  const outcome = await setup(
    'packages/cloudflare/test/fixtures/hook-first-delivery-private.can',
    'HookFirstPrivateGuard', true);
  assert.equal((outcome as { status: string }).status, 'completed');
});

test('native private stored-field guard fails closed on an unapproved row', async () => {
  const outcome = await setup(
    'packages/cloudflare/test/fixtures/hook-first-delivery-private.can',
    'HookFirstPrivateGuard', false);
  assert.equal((outcome as { status: string }).status, 'failed');
});

test('native private presence guard completes on a present row', async () => {
  const outcome = await setup(
    'packages/cloudflare/test/fixtures/hook-first-delivery-private-presence.can',
    'HookFirstPrivatePresence', false);
  assert.equal((outcome as { status: string }).status, 'completed');
});

test('native private presence guard fails closed on the empty domain', async () => {
  const outcome = await setup(
    'packages/cloudflare/test/fixtures/hook-first-delivery-private-presence.can',
    'HookFirstPrivatePresence', null);
  assert.equal((outcome as { status: string }).status, 'failed');
});

test('native private guard refuses a foreign-scope occurrence without effects', async () => {
  const world = await buildWorld(
    'packages/cloudflare/test/fixtures/hook-first-delivery-private.can',
    'HookFirstPrivateGuard', true);
  try {
    const revision = await world.store.readRevision();
    const refused = await deliver(world, { owner: 'foreign-owner' });
    assert.deepEqual(refused, { status: 'refused', reason: 'mismatched' });
    assert.equal(await world.store.readRevision(), revision);
  } finally {
    await rm(world.dir, { recursive: true, force: true });
  }
});

test('native unused private first with require true gains no decision', async () => {
  const outcome = await setup(
    'packages/cloudflare/test/fixtures/hook-first-delivery-private-unused.can',
    'HookFirstPrivateUnused', true);
  // Unmarked occurrence keeps viewer behavior: first() sees no private
  // rows, but the vacuous guard passes and nothing is disclosed.
  assert.equal((outcome as { status: string }).status, 'completed');
});
