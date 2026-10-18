/** Member-operand first query -> captured CLI -> verified module -> real D1/Identity.
 *
 * Admitted compiler family (see compiler/tests/first_query_conjunction.rs
 * `conj_member_read_admits` plus the `member_operand_*` correspondence
 * units): a contained id-ordered first query whose `and` chain compares a
 * candidate field against a stored-record param field (`c.role==i.role`)
 * over the same enum domain. The sealed `base.field` path pins the exact
 * param, field and enum; sibling-field, scalar-base and constant-variant
 * substitutions refuse at the defining matcher.
 *
 * This test proves the executable half: the emitted predicate reads the
 * admitted param row's field at evaluation time (in source order after the
 * actor conjunct), matching roles select, mismatching roles fail the
 * require with no writes, caller scoping holds, replay is duplicate-free,
 * and denial/revocation is forbidden with no writes. A second fixture
 * withholds the param field from viewer reads and pins the exact
 * param-row hydration boundary.
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
const APP = 'ConjMemberSources';
const P = asModel(`${APP}.P`), C = asModel(`${APP}.C`), D = asModel(`${APP}.D`), I = asModel(`${APP}.I`);
const fixtureSourcePath = join(root, 'compiler/tests/fixtures/first-query-member.can');
type Tables = Record<string, Array<Record<string, unknown>>>;

test('native member-operand first query selects on the param row field with order and revocation',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-native-first-member-'));
    let worker: Miniflare | undefined;
    let capture: Awaited<ReturnType<typeof import('../src/runtime/native-dev.test-support.js')['captureSingleFileSource']>> | undefined;
    try {
      const { assembleModules, importVerifiedAssemblyModule } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { installedLocalPreviewInputInventory } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { compileCapturedSingleFile } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { createD1Storage, ensureSchema } = await nodeImport(stateInstalled('storage/d1.js')) as typeof import('@canlang/state/storage/d1');
      const originalSource = await readFile(fixtureSourcePath);
      const compilerPath = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
      const catalogPath = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
      capture = await captureSingleFileSource({ checkoutRoot: root, appPath: fixtureSourcePath,
        profile: 'native-first-member', compilerPath, catalogPath,
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
        ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
        semanticOptions: { nativeScenarioReceipts: 'true' } });
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Member source did not compile');
      const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      const operation = artifact.operations?.find(candidate => candidate.name === `${APP}.go_mem`);
      assert.ok(operation, 'go_mem admitted');
      assert.equal(operation.kind, 'scenario');
      const plan = operation.result!.disclosure; assert.ok(plan);
      const [query] = plan.queries ?? []; assert.ok(query);
      assert.equal(query.model, `${APP}.C`);
      assert.deepEqual(query.order, [{ field: 'id', direction: 'asc' }]);
      assert.deepEqual((query.dependencies ?? []).map(dep => ({ field: dep.field, type: dep.type })),
        [{ field: 'account', type: 'user' }, { field: 'role', type: 'enum(administrator,booker)' }],
        'member-read conjunct emits both conjuncts in source order');
      {
        // The real emitted predicate evaluates the actor conjunct (with
        // its dependency observation) before a short-circuiting && and
        // the member-operand conjunct after it: the param row field is
        // read at predicate evaluation time, not transported eagerly.
        const goMem = artifact.callables.find(callable => callable.id === `${APP}.go_mem`)!;
        const goMemJs = artifact.modules.find(module => module.path === goMem.module)!.js;
        const callSite = goMemJs.slice(goMemJs.indexOf('await firstQuery'));
        assert.match(callSite, /observeScenarioReceiptQueryDependency\([^)]*"account"[\s\S]*?&&[\s\S]*?\.role\b/,
          'emitted predicate evaluates actor, short-circuits, then reads the param row field');
      }
      const asm = await assembleModules({ artifact, sourcePath: fixtureSourcePath }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'first-member-identity', OWNER: 'first-member-owner' }, d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const baseTime = Date.now(); let now = baseTime;
      const clock = { nowMs: () => now }, identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      async function actor(email: string) {
        const user = await identities.createUser({ email, password_hash: 'unused', email_verified: true });
        const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
        const token = `native-first-member-${user.user_id}`;
        await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
          last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
        const current = () => resolveIdentity(identities, { session_token: token }, { clock });
        return { membership, current, identity: await current() };
      }
      const member = await actor('first-member-member@example.test');
      const other = await actor('first-member-other@example.test');
      const outsider = await identities.createUser({ email: 'first-member-outsider@example.test', password_hash: 'unused', email_verified: true });
      const outsiderToken = 'native-first-member-outsider';
      await identities.createSession({ user_id: outsider.user_id, token_sha256: await sha256HexText(outsiderToken),
        last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
      const outsiderIdentity = await resolveIdentity(identities, { session_token: outsiderToken }, { clock });
      const underlying = createD1Storage(ownerDb);
      const store: StoragePort = underlying;
      const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs });
      let sequence = 2000;
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
      // booker row. The member-operand conjunct (not the actor conjunct
      // alone) decides each outcome below.
      await seedChild(member.membership.user_id, 'administrator');
      await seedChild(other.membership.user_id, 'booker');
      const adminI = await seedInvitation('administrator');
      const bookerI = await seedInvitation('booker');

      // Matching param field selects the member's administrator row.
      now = baseTime + 20;
      const firstEnvelope = envelope(`${APP}.go_mem`, { p: { id: parentId, version: parentVersion }, i: adminI });
      {
        const outcome = await invoke(firstEnvelope);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(outcome.result.result, '1');
        assert.equal(await dRows().then(rows => rows.length), 1);
        assert.deepEqual((await dRows())[0]!.data, { w: '1' });
      }

      // Mismatching param field matches nothing for this caller: the
      // member has no booker row and the other member's booker row has
      // a different account. The require fails with no writes.
      now = baseTime + 30;
      {
        const dCount = await dRows().then(rows => rows.length);
        const outcome = await invoke(envelope(`${APP}.go_mem`, { p: { id: parentId, version: parentVersion }, i: bookerI }));
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Same booker invitation selects for its own holder: the
      // member-operand comparison is caller-scoped through the actor
      // conjunct, not a global role match.
      now = baseTime + 40;
      {
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.go_mem`, { p: { id: parentId, version: parentVersion }, i: bookerI }), other.identity);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(await dRows().then(rows => rows.length), 2);
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
          envelope(`${APP}.go_mem`, { p: { id: parentId, version: parentVersion }, i: adminI }), outsiderIdentity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'forbidden', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Revoking membership withholds execution with no writes,
      // including the retained replay path.
      await identities.removeMembership(member.membership.membership_id);
      {
        const dCount = await dRows().then(rows => rows.length);
        const revoked = envelope(`${APP}.go_mem`, { p: { id: parentId, version: parentVersion }, i: adminI });
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

test('native member-operand first query reads the admitted param row field',
  { timeout: 180000 }, async () => {
    const WITHHELD_APP = 'ConjMemberWithheld';
    const WD = asModel(`${WITHHELD_APP}.D`);
    const withheldFixture = join(root, 'compiler/tests/fixtures/first-query-member-withheld.can');
    const directory = await mkdtemp(join(tmpdir(), 'can-native-first-member-withheld-'));
    let worker: Miniflare | undefined;
    let capture: Awaited<ReturnType<typeof import('../src/runtime/native-dev.test-support.js')['captureSingleFileSource']>> | undefined;
    try {
      const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { installedLocalPreviewInputInventory } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { compileCapturedSingleFile } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { createD1Storage, ensureSchema } = await nodeImport(stateInstalled('storage/d1.js')) as typeof import('@canlang/state/storage/d1');
      const originalSource = await readFile(withheldFixture);
      const compilerPath = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
      const catalogPath = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
      capture = await captureSingleFileSource({ checkoutRoot: root, appPath: withheldFixture,
        profile: 'native-first-member-withheld', compilerPath, catalogPath,
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
        ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
        semanticOptions: { nativeScenarioReceipts: 'true' } });
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Withheld member source did not compile');
      const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      // The static plan still records the role control dependency: the
      // seal is unchanged, only the viewer read policy withholds it.
      const operation = artifact.operations?.find(candidate => candidate.name === `${WITHHELD_APP}.go_mem`);
      assert.ok(operation, 'go_mem admitted under withheld viewer policy');
      const plan = operation.result!.disclosure; assert.ok(plan);
      const [query] = plan.queries ?? []; assert.ok(query);
      assert.deepEqual((query.dependencies ?? []).map(dep => dep.field), ['account', 'role']);
      const asm = await assembleModules({ artifact, sourcePath: withheldFixture }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'first-member-withheld-identity', OWNER: 'first-member-withheld-owner' }, d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const baseTime = Date.now(); let now = baseTime;
      const clock = { nowMs: () => now }, identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      async function actor(email: string) {
        const user = await identities.createUser({ email, password_hash: 'unused', email_verified: true });
        const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
        const token = `native-first-member-withheld-${user.user_id}`;
        await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
          last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
        const current = () => resolveIdentity(identities, { session_token: token }, { clock });
        return { membership, current, identity: await current() };
      }
      const member = await actor('first-member-withheld-member@example.test');
      const underlying = createD1Storage(ownerDb);
      const store: StoragePort = underlying;
      const invoker = buildInvoker(artifact, asm, store, { appId: WITHHELD_APP, memberships: identities, source: 'http', now: clock.nowMs });
      let sequence = 3000;
      const envelope = (op: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
        operation: op, operation_id: uuidv7(baseTime, ++sequence), inputs });
      const dRows = async () => (await store.query({ model: WD, authority: 'owner' }) as unknown as Array<{ data: Record<string, unknown> }>);
      const recordRef = (outcome: unknown) =>
        ((outcome as { result?: { records?: ReadonlyArray<{ id: string; version: number }> } }).result?.records ?? [])[0]!;

      now = baseTime + 10;
      const parent = await invoker.invokeMutation({ operation: `${WITHHELD_APP}.P.create`, operation_id: uuidv7(baseTime, ++sequence), inputs: { v: '1' } }, member.identity);
      assert.ok('result' in parent, JSON.stringify(parent));
      const parentId = recordRef(parent).id, parentVersion = String(recordRef(parent).version);
      const child = await invoker.invokeMutation({ operation: `${WITHHELD_APP}.C.create`, operation_id: uuidv7(baseTime, ++sequence),
        inputs: { parent: { id: parentId }, account: { id: member.membership.user_id }, role: 'administrator' } }, member.identity);
      assert.ok('result' in child, JSON.stringify(child));
      const invitation = await invoker.invokeMutation({ operation: `${WITHHELD_APP}.I.create`, operation_id: uuidv7(baseTime, ++sequence),
        inputs: { parent: { id: parentId }, role: 'administrator' } }, member.identity);
      assert.ok('result' in invitation, JSON.stringify(invitation));
      const invitationRef = { id: recordRef(invitation).id, version: String(recordRef(invitation).version) };

      // The viewer read policy withholds the invitation role, but the
      // admitted param row travels with the invocation: the predicate
      // reads the stored field at evaluation time exactly as `require`
      // reads admitted param fields. Withholding is enforced on query
      // projection, not on the caller-supplied admitted reference.
      now = baseTime + 20;
      {
        const outcome = await invoker.invokeMutation(
          envelope(`${WITHHELD_APP}.go_mem`, { p: { id: parentId, version: parentVersion }, i: invitationRef }), member.identity);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(await dRows().then(rows => rows.length), 1);
      }

      // Revocation still withholds execution with no writes.
      await identities.removeMembership(member.membership.membership_id);
      {
        const dCount = await dRows().then(rows => rows.length);
        const revokedOutcome = await invoker.invokeMutation(
          envelope(`${WITHHELD_APP}.go_mem`, { p: { id: parentId, version: parentVersion }, i: invitationRef }), member.identity);
        assert.ok('error' in revokedOutcome, JSON.stringify(revokedOutcome));
        assert.equal(revokedOutcome.error.code, 'forbidden', JSON.stringify(revokedOutcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      assert.deepEqual(await readFile(withheldFixture), originalSource);
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
      assert.equal(createHash('sha256').update(originalSource).digest('hex'), artifact.sources.find(source => resolve(source.path) === withheldFixture)!.sha256);
    } finally {
      await worker?.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });
