/** Enum-typed member read as a create input -> captured CLI -> real D1/Identity.
 *
 * Admitted compiler family (see compiler/tests/enum_member_create_input.rs):
 * a first query comparing against a param-row enum field (`c.role==i.role`)
 * plus a create storing that same read (`role=i.role`). The read rides the
 * receipt as a return DATA dependency with the sealed `enum(a,b)` transport.
 *
 * This test proves the executable half: the created row persists the
 * transported enum value (administrator for one caller, booker for another),
 * mismatch fails the require with no writes, replay is duplicate-free, and
 * denial/revocation is forbidden with no writes. Fixture source, artifact
 * and capture stay untouched throughout.
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
import type { CompileArtifact, MutationEnvelope, StoragePort } from '@canlang/contracts';
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
const APP = 'EnumCreateInput';
const P = asModel(`${APP}.P`), C = asModel(`${APP}.C`), D = asModel(`${APP}.D`), I = asModel(`${APP}.I`);
const fixtureSourcePath = join(root, 'compiler/tests/fixtures/native-enum-create-input.can');

test('native enum member create input persists the transported role with order and revocation',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-native-enum-create-input-'));
    let worker: Miniflare | undefined;
    let capture: Awaited<ReturnType<typeof import('../src/dev/source-capture.js')['captureSingleFileSource']>> | undefined;
    try {
      const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { installedLocalPreviewInputInventory } = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
      const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
      const { compileCapturedSingleFile } = await nodeImport(installed('dev/compiler-check.js')) as typeof import('../src/dev/compiler-check.js');
      const { createD1Storage, ensureSchema } = await nodeImport(stateInstalled('storage/d1.js')) as typeof import('@canlang/state/storage/d1');
      const originalSource = await readFile(fixtureSourcePath);
      const compilerPath = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
      const catalogPath = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
      capture = await captureSingleFileSource({ checkoutRoot: root, appPath: fixtureSourcePath,
        profile: 'native-enum-create-input', compilerPath, catalogPath,
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
        ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
        semanticOptions: { nativeScenarioReceipts: 'true' } });
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Enum create-input source did not compile');
      const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      const operation = artifact.operations?.find(candidate => candidate.name === `${APP}.go`);
      assert.ok(operation, 'go admitted');
      assert.equal(operation.kind, 'scenario');
      const plan = operation.result!.disclosure; assert.ok(plan);
      const returns = plan.returns ?? [];
      assert.equal(returns.length, 1);
      const roleDep = (returns[0]!.dependencies ?? []).find(dep => dep.field === 'role');
      assert.ok(roleDep, 'return carries the enum create-input read');
      assert.equal(roleDep.role, 'data');
      assert.equal(roleDep.type, 'enum(administrator,booker)');
      const asm = await assembleModules({ artifact, sourcePath: fixtureSourcePath }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'enum-create-input-identity', OWNER: 'enum-create-input-owner' }, d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const baseTime = Date.now(); let now = baseTime;
      const clock = { nowMs: () => now }, identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      async function actor(email: string) {
        const user = await identities.createUser({ email, password_hash: 'unused', email_verified: true });
        const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
        const token = `native-enum-create-input-${user.user_id}`;
        await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
          last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
        const current = () => resolveIdentity(identities, { session_token: token }, { clock });
        return { membership, current, identity: await current() };
      }
      const member = await actor('enum-create-input-member@example.test');
      const other = await actor('enum-create-input-other@example.test');
      const outsider = await identities.createUser({ email: 'enum-create-input-outsider@example.test', password_hash: 'unused', email_verified: true });
      const outsiderToken = 'native-enum-create-input-outsider';
      await identities.createSession({ user_id: outsider.user_id, token_sha256: await sha256HexText(outsiderToken),
        last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
      const outsiderIdentity = await resolveIdentity(identities, { session_token: outsiderToken }, { clock });
      const underlying = createD1Storage(ownerDb);
      const store: StoragePort = underlying;
      const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs });
      let sequence = 3000;
      const envelope = (op: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
        operation: op, operation_id: uuidv7(baseTime, ++sequence), inputs });
      const invoke = (input: MutationEnvelope) => invoker.invokeMutation(input, member.identity);
      const dRows = async () => (await store.query({ model: D, authority: 'owner' }) as unknown as Array<{ data: Record<string, unknown> }>);
      const recordRef = (outcome: unknown) =>
        ((outcome as { result?: { records?: ReadonlyArray<{ id: string; version: number }> } }).result?.records ?? [])[0]!;

      now = baseTime + 10;
      const parent = await invoker.invokeMutation({ operation: `${APP}.P.create`, operation_id: uuidv7(baseTime, ++sequence), inputs: { v: '1' } }, member.identity);
      assert.ok('result' in parent, JSON.stringify(parent));
      const parentId = recordRef(parent).id, parentVersion = String(recordRef(parent).version);
      async function seedChild(accountId: string, role: string) {
        const child = await invoker.invokeMutation({ operation: `${APP}.C.create`, operation_id: uuidv7(baseTime, ++sequence),
          inputs: { parent: { id: parentId }, account: { id: accountId }, role } }, member.identity);
        assert.ok('result' in child, JSON.stringify(child));
      }
      async function seedInvitation(role: string) {
        const invitation = await invoker.invokeMutation({ operation: `${APP}.I.create`, operation_id: uuidv7(baseTime, ++sequence),
          inputs: { parent: { id: parentId }, role } }, member.identity);
        assert.ok('result' in invitation, JSON.stringify(invitation));
        return { id: recordRef(invitation).id, version: String(recordRef(invitation).version) };
      }
      // Member holds only an administrator row; other holds only a
      // booker row.
      await seedChild(member.membership.user_id, 'administrator');
      await seedChild(other.membership.user_id, 'booker');
      const adminI = await seedInvitation('administrator');
      const bookerI = await seedInvitation('booker');

      // Matching param field selects and persists the transported role.
      now = baseTime + 20;
      const firstEnvelope = envelope(`${APP}.go`, { p: { id: parentId, version: parentVersion }, i: adminI });
      {
        const outcome = await invoke(firstEnvelope);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        const rows = await dRows();
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.data.role, 'administrator');
        assert.equal(rows[0]!.data.w, '1');
      }

      // Mismatching param field matches nothing for this caller: the
      // require fails with no writes.
      now = baseTime + 30;
      {
        const dCount = await dRows().then(rows => rows.length);
        const outcome = await invoke(envelope(`${APP}.go`, { p: { id: parentId, version: parentVersion }, i: bookerI }));
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Same booker invitation selects for its own holder and persists
      // booker: the stored value follows the transported read, not a
      // constant.
      now = baseTime + 40;
      {
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.go`, { p: { id: parentId, version: parentVersion }, i: bookerI }), other.identity);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        const rows = await dRows();
        assert.equal(rows.length, 2);
        assert.equal(rows[1]!.data.role, 'booker');
      }

      // Replaying the first committed operation replays without effects.
      {
        const dCount = await dRows().then(rows => rows.length);
        const replayed = await invoker.invokeRetainedMutation(firstEnvelope, member.identity);
        assert.ok('result' in replayed, JSON.stringify(replayed));
        assert.equal(replayed.result.status, 'replayed', JSON.stringify(replayed));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // A caller without membership is denied at the operation boundary.
      {
        const dCount = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.go`, { p: { id: parentId, version: parentVersion }, i: adminI }), outsiderIdentity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'forbidden', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Revoking membership withholds execution with no writes,
      // including the retained replay path.
      await identities.removeMembership(member.membership.membership_id);
      {
        const dCount = await dRows().then(rows => rows.length);
        const revoked = envelope(`${APP}.go`, { p: { id: parentId, version: parentVersion }, i: adminI });
        const revokedOutcome = await invoker.invokeMutation(revoked, member.identity);
        assert.ok('error' in revokedOutcome, JSON.stringify(revokedOutcome));
        assert.equal(revokedOutcome.error.code, 'forbidden', JSON.stringify(revokedOutcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
        const withheld = await invoker.invokeRetainedMutation(firstEnvelope, member.identity);
        assert.ok('error' in withheld, JSON.stringify(withheld));
        assert.equal(withheld.error.code, 'forbidden', JSON.stringify(withheld));
      }

      assert.deepEqual(await readFile(fixtureSourcePath), originalSource);
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
      assert.equal(createHash('sha256').update(originalSource).digest('hex'), artifact.sources.find(source => resolve(source.path) === fixtureSourcePath)!.sha256);
    } finally {
      await worker?.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });
