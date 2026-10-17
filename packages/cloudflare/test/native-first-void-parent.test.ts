/** Void accept with invitation-sourced create parent -> real D1/Identity.
 *
 * State admits void scenarios whose returns carry data dependencies from
 * effect parent links: void carries no result value to shape (the result
 * wire demands null), execution reads still execute under caller
 * authority through the reference profiles, and recorded queries/inputs
 * are revalidated on replay. This test proves the executable half on
 * the original invitation-accept shape (actor guard + navigation-parent
 * first/conjunction, void if/create/set with parent=invitation.parent):
 * a matching verified caller commits with grant + invitation effects,
 * mismatch/unverified callers fail with exact rule_failed and no
 * writes, and revocation is forbidden with no writes.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationEnvelope } from '@canlang/contracts';
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { asModel, uuidv7 } from '@canlang/state/testing/invocation/fixtures';

// Layout-agnostic checkout root: works from source (vitest) and dist (node --test).
let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(root, 'compiler')) || !existsSync(join(root, 'packages'))) {
  const parent = dirname(root);
  assert.notEqual(parent, root, 'checkout root with compiler/ + packages/ not found');
  root = parent;
}
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
// Same installed module graph for storage and invoker: the invoker's
// FenceConflictError retry is an instanceof check, so storage loaded
// from a different graph (static test import vs installed assembly)
// would silently disable retries. Load storage from installed dist.
const stateInstalled = (path: string) => pathToFileURL(join(root, 'packages/state/dist/src', path)).href;
const APP = 'VoidParentProbe';
const P = asModel(`${APP}.P`), D = asModel(`${APP}.D`), I = asModel(`${APP}.I`);
const fixtureSourcePath = join(root, 'compiler/tests/fixtures/first-query-void-parent.can');

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'can-native-first-void-parent-'));
  const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
  const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
  const { installedLocalPreviewInputInventory } = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
  const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
  const { compileCapturedSingleFile } = await nodeImport(installed('dev/compiler-check.js')) as typeof import('../src/dev/compiler-check.js');
  const { createD1Storage, ensureSchema } = await nodeImport(stateInstalled('storage/d1.js')) as typeof import('@canlang/state/storage/d1');
  const originalSource = await readFile(fixtureSourcePath);
  const compilerPath = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
  const catalogPath = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
  const capture = await captureSingleFileSource({ checkoutRoot: root, appPath: fixtureSourcePath,
    profile: 'native-first-void-parent', compilerPath, catalogPath,
    helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
    ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
    semanticOptions: { nativeScenarioReceipts: 'true' } });
  assert.equal(await captureIsCurrent(capture), true);
  const compiled = await compileCapturedSingleFile(capture);
  assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
  if (compiled.kind !== 'artifact') throw new Error('Void parent source did not compile');
  const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
  assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
  {
    const op = artifact.operations?.find(candidate => candidate.name === `${APP}.accept`);
    assert.ok(op, 'accept admitted');
    const [query] = op.result!.disclosure!.queries ?? []; assert.ok(query);
    assert.equal(query.model, `${APP}.D`);
    // The evaluated guard reads caller facts, never a direct actor row.
    const accept = artifact.callables.find(callable => callable.id === `${APP}.accept`)!;
    const acceptJs = artifact.modules.find(module => module.path === accept.module)!.js;
    assert.match(acceptJs, /c\.actorFacts\.email_verified/);
    assert.match(acceptJs, /c\.actorFacts\.email/);
    assert.ok(!acceptJs.includes('c.actor.email'));
  }
  const asm = await assembleModules({ artifact, sourcePath: fixtureSourcePath }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
  const worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { IDENTITY: 'void-parent-identity', OWNER: 'void-parent-owner' }, d1Persist: join(directory, 'd1') });
  const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
  const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
  await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
  const baseTime = Date.now(); let now = baseTime;
  const clock = { nowMs: () => now }, identities = createD1IdentityStore(identityDb, { clock });
  const team = await identities.createTeam({ timezone: 'UTC' });
  async function actor(email: string, verified = true) {
    const user = await identities.createUser({ email, password_hash: 'unused', email_verified: verified });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = `native-void-parent-${user.user_id}`;
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
    const current = () => resolveIdentity(identities, { session_token: token }, { clock });
    return { membership, current, identity: await current() };
  }
  const member = await actor('void-parent-member@example.test');
  const stranger = await actor('void-parent-stranger@example.test');
  const unverified = await actor('void-parent-unverified@example.test', false);
  const outsider = await identities.createUser({ email: 'void-parent-outsider@example.test', password_hash: 'unused', email_verified: true });
  const outsiderToken = 'native-void-parent-outsider';
  await identities.createSession({ user_id: outsider.user_id, token_sha256: await sha256HexText(outsiderToken),
    last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
  const outsiderIdentity = await resolveIdentity(identities, { session_token: outsiderToken }, { clock });
  const underlying = createD1Storage(ownerDb);
  const store = underlying;
  const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs });
  let sequence = 4000;
  const envelope = (op: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
    operation: op, operation_id: uuidv7(baseTime, ++sequence), inputs });
  const recordRef = (outcome: unknown) =>
    ((outcome as { result?: { records?: ReadonlyArray<{ id: string; version: number }> } }).result?.records ?? [])[0]!;
  async function create(op: string, inputs: MutationEnvelope['inputs'], identity = member.identity) {
    const outcome = await invoker.invokeMutation(
      { operation: op, operation_id: uuidv7(baseTime, ++sequence), inputs }, identity);
    assert.ok('result' in outcome, JSON.stringify(outcome));
    const ref = recordRef(outcome);
    return { id: ref.id, version: String(ref.version) };
  }
  return { directory, worker, artifact, originalArtifact, originalSource, capture, captureIsCurrent,
    invoker, store, identities, member, stranger, unverified, outsiderIdentity, envelope, create, clock,
    setNow: (delta: number) => { now = baseTime + delta; } };
}

test('native actor guard admits matching verified caller and refuses mismatch/unverified/revoked with no writes',
  { timeout: 180000 }, async () => {
    const t = await setup();
    try {
      const { invoker, store, identities, member, stranger, unverified, outsiderIdentity, envelope, create, setNow } = t;
      const dRows = async () => (await store.query({ model: D, authority: 'owner' }) as unknown as Array<{ data: Record<string, unknown> }>);
      const iRows = async () => (await store.query({ model: I, authority: 'owner' }) as unknown as Array<{ id: string; version: number; data: Record<string, unknown> }>);
      setNow(10);
      const parent = await create(`${APP}.P.create`, { v: '1', active: true });
      const freshInvitation = async (email: string) =>
        create(`${APP}.I.create`, { parent: { id: parent.id }, email, active: false });
      const invitation = await freshInvitation('void-parent-member@example.test');

      // Matching verified caller commits the void accept workflow: the
      // grant row is created and the invitation flips active.
      setNow(20);
      {
        const first = envelope(`${APP}.accept`, { invitation, n: '7' });
        const outcome = await invoker.invokeMutation(first, member.identity);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        // Replaying the same envelope through the retained path exercises
        // the saved void-association profile: replayed, no duplicate
        // effects, versions untouched.
        const versionAfterCommit = (await iRows()).find(row => row.id === invitation.id)!.version;
        const replayed = await invoker.invokeRetainedMutation(first, member.identity);
        assert.ok('result' in replayed, JSON.stringify(replayed));
        assert.equal(replayed.result.status, 'replayed');
        assert.equal(await dRows().then(rows => rows.length), 1);
        assert.equal((await iRows()).find(row => row.id === invitation.id)!.version, versionAfterCommit);
        const grants = await dRows();
        assert.equal(grants.length, 1);
        assert.equal(grants[0].data.w, '7');
        // The created row hangs under the invitation's own parent: routing
        // it under any other parent must fail this assertion.
        const created = grants[0] as unknown as { parent?: { model?: unknown; id?: unknown } };
        assert.equal(created.parent?.model, `${APP}.P`);
        assert.equal(created.parent?.id, parent.id);
        const seen = (await iRows()).find(row => row.id === invitation.id)!;
        assert.equal(seen.data.active, true);
      }

      // Second accept finds the existing grant and updates it in place.
      setNow(30);
      {
        const current = (await iRows()).find(row => row.id === invitation.id)!;
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.accept`, { invitation: { id: current.id, version: String(current.version) }, n: '7' }), member.identity);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(await dRows().then(rows => rows.length), 1);
      }

      // Verified caller with a different email fails the guard: exact
      // rule_failed with no grant writes and the invitation untouched.
      setNow(40);
      {
        const probe = await freshInvitation('void-parent-member@example.test');
        const before = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.accept`, { invitation: probe, n: '8' }), stranger.identity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), before);
        const seen = (await iRows()).find(row => row.id === probe.id)!;
        assert.equal(seen.data.active, false);
      }

      // The invitation matches this caller's email, but the caller is
      // unverified: the verification conjunct fails with no writes.
      setNow(50);
      {
        const probe = await freshInvitation('void-parent-unverified@example.test');
        const before = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.accept`, { invitation: probe, n: '9' }), unverified.identity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), before);
        const seen = (await iRows()).find(row => row.id === probe.id)!;
        assert.equal(seen.data.active, false);
      }

      // A caller without membership is denied at the operation boundary.
      setNow(60);
      {
        const probe = await freshInvitation('void-parent-member@example.test');
        const before = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.accept`, { invitation: probe, n: '10' }), outsiderIdentity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'forbidden', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), before);
      }

      // Revoking membership withholds execution with no writes.
      await identities.removeMembership(member.membership.membership_id);
      setNow(70);
      {
        const probe = await create(`${APP}.I.create`,
          { parent: { id: parent.id }, email: 'void-parent-member@example.test', active: false }, stranger.identity);
        const before = await dRows().then(rows => rows.length);
        const revokedOutcome = await invoker.invokeMutation(
          envelope(`${APP}.accept`, { invitation: probe, n: '11' }), member.identity);
        assert.ok('error' in revokedOutcome, JSON.stringify(revokedOutcome));
        assert.equal(revokedOutcome.error.code, 'forbidden', JSON.stringify(revokedOutcome));
        assert.equal(await dRows().then(rows => rows.length), before);
      }

      assert.deepEqual(await readFile(fixtureSourcePath), t.originalSource);
      assert.equal(JSON.stringify(t.artifact), t.originalArtifact);
      assert.equal(await t.captureIsCurrent(t.capture), true);
      assert.equal(createHash('sha256').update(t.originalSource).digest('hex'), t.artifact.sources.find(source => resolve(source.path) === fixtureSourcePath)!.sha256);
    } finally {
      await rm(t.directory, { recursive: true, force: true });
      await t.worker.dispose();
    }
  });
