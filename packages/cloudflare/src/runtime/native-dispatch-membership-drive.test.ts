/** Compiled SEND-dispatch membership through the real path. The `can` binary
 * compiles the unchanged guarded-Email fixture; the checked send-dispatch
 * source/closure crosses the producer boundary into State's deferred
 * dispatch producer at drive-fence setup (after the staging invoke) and the
 * guard re-evaluates `active_member` there. Granted delivery drives to the
 * provider; a person revoked after staging drives to the exact guard-false
 * refusal with no provider call. This is not native-catalog, File-inventory
 * or provider acceptance: those are reused neighbors.
 *
 * Run with the shared compiler slot, e.g.
 * `CAN_COMPILER_BIN=/Users/vince/Projects/canlang/compiler/target/debug/can`
 * (plus `CARGO_TARGET_DIR`, single-writer, as for all compiler work).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { CompileArtifact, MutationEnvelope, ProviderBinding } from '@canlang/contracts';
import type { InstalledMailSender } from '@canlang/services';
import { createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { WORK_DISPATCH_STAGE_COMMANDS, WORK_SYSTEM_COMMANDS, createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { classifyFailure } from '@canlang/work/receipt';
import { FIXED_NOW, asOperationId, makeIdentity, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';
import { installNativeFileInventory } from './file-inventory.js';
import { bindNativeEmailDispatchGuards } from './invoke.js';
import { createBoundMailAdapter } from './bound-mail.js';
import { createBoundMailDispatcher } from './bound-dispatch.js';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const FIXTURE = 'packages/cloudflare/test/fixtures/native-guarded-email.can';
const APP = 'NativeGuardedEmail';
let sequence = 32000;

function envelope(operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope {
  return { operation: `${APP}.${operation}`, inputs, operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)) };
}

async function compileFixture(): Promise<CompileArtifact> {
  const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
  const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
  const env = { ...process.env };
  delete env.CAN_CATALOG;
  const { stdout } = await execFileAsync(compiler,
    ['compile', '--format=json', '--catalog', catalog, '--native-scenario-receipts', join(root, FIXTURE)],
    { cwd: root, env, maxBuffer: 64 * 1024 * 1024 });
  const artifact = JSON.parse(stdout) as CompileArtifact;
  assert.ok(!('diagnostics' in artifact), 'guarded-Email fixture emits clean with checked membership closure');
  return artifact;
}

async function world() {
  const artifact = await compileFixture();
  const dir = await mkdtemp(join(tmpdir(), 'can-dispatch-membership-drive-'));
  const asm = await assembleModules({ artifact, sourcePath: join(root, FIXTURE) }, {
    workDir: join(dir, 'modules'),
    stdlibUrl: pathToFileURL(join(root, 'packages/cloudflare/dist/runtime/stdlib.js')).href,
    uiUrl: pathToFileURL(join(root, 'packages/ui/dist/src/index.js')).href,
  });
  const memberships = createMemoryIdentityStore();
  const owner = await memberships.createUser({ email: 'drive-owner@example.test', email_verified: true, password_hash: 'unused' });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const ownerMember = await memberships.createMembership({ team_id: team.team_id, user_id: owner.user_id, is_owner: true, roles: [] });
  const ownerIdentity = makeIdentity({ membership: ownerMember, team, email: owner.email });
  const subject = await memberships.createUser({ email: 'drive-subject@example.test', email_verified: true, password_hash: 'unused' });
  const subjectMember = await memberships.createMembership({ team_id: team.team_id, user_id: subject.user_id, is_owner: false, roles: [] });
  const authority = { app: APP, stateOwner: APP, stateStoreId: 'dispatch-membership-drive-state', fileStoreId: 'dispatch-membership-drive-files',
    receiver: { app: APP, team: team.team_id, owner: team.team_id } };
  const { store } = createTestMemoryStorage(authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
  await installNativeFileInventory({ artifact, asm, scope: { app: APP, owner: team.team_id, ownerPackage: APP },
    store, authority, now: () => FIXED_NOW,
    verifyOwner: async () => { assert.ok(await memberships.findTeamById(team.team_id)); } });
  const invoker = buildInvoker(artifact, asm, store, { memberships, now: () => FIXED_NOW });
  const invoke = async (operation: string, inputs: MutationEnvelope['inputs']) => {
    const outcome = await invoker.invokeMutation(envelope(operation, inputs), ownerIdentity);
    assert.ok('result' in outcome, JSON.stringify(outcome).slice(0, 400));
    return outcome.result;
  };
  const entry = async () => (await invoke('Entry.create', {})).records![0] as { id: string; version: number };
  const deliver = (row: { id: string; version: number }, personId: string) => invoke('deliver',
    { entry: { id: row.id, version: String(row.version) }, enabled: true, note: null, values: [],
      person: { id: personId }, accept: true });
  return { artifact, asm, dir, store, memberships, owner, ownerIdentity, subject, subjectMember, team, entry, deliver };
}

async function driver(w: Awaited<ReturnType<typeof world>>) {
  const appModule = (await import(w.asm.entryUrl)) as { appDefinition: unknown };
  const binding: ProviderBinding = { deployment: 'deployment.mail', capability: 'std.EmailV1', capabilityVersion: 1, account: 'drive-probe-mail' };
  const sends: unknown[] = [];
  const installed: InstalledMailSender = { binding, mail: {
    send: async (input, options) => { sends.push({ input, options }); return { delivery_id: options.deliveryId, status: 'succeeded', result: { reference: 'drive-accepted' }, error: null }; },
    reconcile: async () => { throw new Error('drive probe never reconciles'); },
  } };
  const adapter = createBoundMailAdapter({ appDefinition: appModule.appDefinition, binding,
    resolveInstalledMailSender: (deployment) => { assert.equal(deployment, binding.deployment); return installed; } });
  const dispatcher = await createBoundMailDispatcher({ store: w.store, adapter,
    workCommands: WORK_SYSTEM_COMMANDS, stageCommands: WORK_DISPATCH_STAGE_COMMANDS,
    createClaimCommand: createWorkDispatchClaimCommand });
  const fenceFor = await bindNativeEmailDispatchGuards({ asm: w.asm, artifact: w.artifact, store: w.store,
    identities: w.memberships, scope: { app: APP, owner: w.team.team_id, ownerPackage: APP },
    revalidateAuthority: async () => (await w.memberships.findTeamById(w.team.team_id)) !== null });
  return { sends, dispatcher, fenceFor };
}

async function drive(w: Awaited<ReturnType<typeof world>>, d: Awaited<ReturnType<typeof driver>>, intentId: string) {
  const intent = (await w.store.outboxPending()).find(value => value.intentId === intentId);
  assert.ok(intent, 'staged intent stays pending');
  return d.dispatcher.drive({ intentId, actor: w.owner.user_id, operation: `${APP}.drive`,
    nowMs: () => FIXED_NOW + 1000, nextClaimId: () => `claim-${intentId}`, maxClaimAgeMs: 60_000,
    claimOperationId: asOperationId(uuidv7(FIXED_NOW, ++sequence)),
    recordOperationId: asOperationId(uuidv7(FIXED_NOW, ++sequence)), classifyFailure,
    evaluateGuard: () => { throw new Error('the installed drive fence evaluates the guard'); },
    readStateSnapshot: () => null, fence: d.fenceFor(intent) });
}

test('compiled dispatch membership delivers for a granted member', async () => {
  const w = await world();
  try {
    const staged = await w.deliver(await w.entry(), w.subject.user_id);
    assert.equal(staged.status, 'committed');
    assert.equal(staged.deliveries!.length, 1);
    const d = await driver(w);
    const outcome = await drive(w, d, staged.deliveries![0]!.id);
    assert.equal(outcome.status, 'recorded');
    assert.ok('state' in outcome && outcome.state === 'delivered', JSON.stringify(outcome).slice(0, 300));
    assert.equal(d.sends.length, 1);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('compiled dispatch membership denies after revocation with the exact guard-false identity', async () => {
  const w = await world();
  try {
    const staged = await w.deliver(await w.entry(), w.subject.user_id);
    assert.equal(staged.status, 'committed');
    assert.equal(staged.deliveries!.length, 1);
    await w.memberships.removeMembership(w.subjectMember.membership_id);
    const d = await driver(w);
    const outcome = await drive(w, d, staged.deliveries![0]!.id);
    assert.deepEqual(outcome, { status: 'not-claimed', intentId: staged.deliveries![0]!.id, reason: 'guard-false' });
    assert.equal(d.sends.length, 0);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('compiled dispatch membership skips a never-member without staging', async () => {
  const w = await world();
  try {
    const outsider = await w.memberships.createUser({ email: 'drive-outsider@example.test', email_verified: true, password_hash: 'unused' });
    const skipped = await w.deliver(await w.entry(), outsider.user_id);
    assert.equal(skipped.status, 'committed');
    assert.deepEqual(skipped.deliveries, []);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});
