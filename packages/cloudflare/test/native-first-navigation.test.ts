/** Navigation-parent first query -> captured CLI -> verified module -> real D1/Identity.
 *
 * Admitted compiler family (see compiler/tests/first_query_conjunction.rs
 * `conj_navigation_*`): a contained id-ordered first query whose domain is
 * the one-hop containment navigation off a default-free stored-record
 * parameter (`i.parent.C`). The plan carries the exact admitted-reference
 * hop (parent model P, parameter i); the State owner resolves it to the
 * admitted row's immutable parent linkage after version-pinning the row
 * itself. Same-model inputs keep their direct resolution.
 *
 * This test proves the executable half: the emitted predicate reads row
 * fields at evaluation time in source order, matching selections commit,
 * mismatches fail the require with no writes, the domain is exactly the
 * navigated parent's children (a full match under a sibling parent does
 * not leak across), caller scoping holds through the actor conjunct,
 * replay is duplicate-free, and denial/revocation is forbidden with no
 * writes. The second scenario covers the original invitation shape with a
 * member-operand conjunct over the navigated parent.
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
const APP = 'NavProbe';
const P = asModel(`${APP}.P`), C = asModel(`${APP}.C`), D = asModel(`${APP}.D`), I = asModel(`${APP}.I`);
const fixtureSourcePath = join(root, 'compiler/tests/fixtures/first-query-navigation.can');

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'can-native-first-navigation-'));
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
    profile: 'native-first-navigation', compilerPath, catalogPath,
    helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
    ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
    semanticOptions: { nativeScenarioReceipts: 'true' } });
  assert.equal(await captureIsCurrent(capture), true);
  const compiled = await compileCapturedSingleFile(capture);
  assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
  if (compiled.kind !== 'artifact') throw new Error('Navigation source did not compile');
  const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
  assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
  for (const name of [`${APP}.go_nav`, `${APP}.go_nav_role`]) {
    const op = artifact.operations?.find(candidate => candidate.name === name);
    assert.ok(op, `${name} admitted`);
    const [query] = op.result!.disclosure!.queries ?? []; assert.ok(query);
    assert.equal(query.model, `${APP}.C`);
    assert.deepEqual(query.order, [{ field: 'id', direction: 'asc' }]);
    // The plan carries the exact one-hop navigation, never a relabeled
    // same-model parameter.
    assert.deepEqual(query.parent, {
      model: `${APP}.P`,
      origin: { kind: 'admitted-reference', parameter: 'i' },
      source: query.source,
    });
  }
  assert.deepEqual(
    (artifact.operations?.find(candidate => candidate.name === `${APP}.go_nav`)!.result!.disclosure!.queries ?? [])[0]!.dependencies?.map(dep => dep.field),
    ['account', 'v']);
  assert.deepEqual(
    (artifact.operations?.find(candidate => candidate.name === `${APP}.go_nav_role`)!.result!.disclosure!.queries ?? [])[0]!.dependencies?.map(dep => dep.field),
    ['account', 'role']);
  {
    // Both emitted predicates evaluate the actor conjunct (with its
    // dependency observation) before a short-circuiting && and the
    // second conjunct after it.
    const goNav = artifact.callables.find(callable => callable.id === `${APP}.go_nav`)!;
    const goNavJs = artifact.modules.find(module => module.path === goNav.module)!.js;
    const callSite = goNavJs.slice(goNavJs.indexOf('await firstQuery'));
    assert.match(callSite, /observeScenarioReceiptQueryDependency\([^)]*"account"[\s\S]*?&&/,
      'emitted nav predicate evaluates actor, then short-circuits');
  }
  const asm = await assembleModules({ artifact, sourcePath: fixtureSourcePath }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
  const worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { IDENTITY: 'first-navigation-identity', OWNER: 'first-navigation-owner' }, d1Persist: join(directory, 'd1') });
  const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
  const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
  await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
  const baseTime = Date.now(); let now = baseTime;
  const clock = { nowMs: () => now }, identities = createD1IdentityStore(identityDb, { clock });
  const team = await identities.createTeam({ timezone: 'UTC' });
  async function actor(email: string, roles: string[] = []) {
    const user = await identities.createUser({ email, password_hash: 'unused', email_verified: true });
    const grants = roles.map(role => ({ role: `${APP}.${role}`, granted_at: new Date(baseTime).toISOString(), granted_by: user.user_id }));
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: grants });
    const token = `native-first-navigation-${user.user_id}`;
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
    const current = () => resolveIdentity(identities, { session_token: token }, { clock });
    return { membership, current, identity: await current() };
  }
  const member = await actor('first-navigation-member@example.test', ['auditor']);
  const other = await actor('first-navigation-other@example.test', ['auditor']);
  const norows = await actor('first-navigation-norows@example.test', ['auditor']);
  // Member without the parent read role: keeps operation membership
  // but cannot read the navigated parent row.
  const unaudited = await actor('first-navigation-unaudited@example.test');
  const outsider = await identities.createUser({ email: 'first-navigation-outsider@example.test', password_hash: 'unused', email_verified: true });
  const outsiderToken = 'native-first-navigation-outsider';
  await identities.createSession({ user_id: outsider.user_id, token_sha256: await sha256HexText(outsiderToken),
    last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
  const outsiderIdentity = await resolveIdentity(identities, { session_token: outsiderToken }, { clock });
  const underlying = createD1Storage(ownerDb);
  const store: StoragePort = underlying;
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
    invoker, store, identities, member, other, norows, unaudited, outsiderIdentity, envelope, create, clock,
    setNow: (delta: number) => { now = baseTime + delta; } };
}

test('native navigation-parent first query selects within the navigated parent with order and revocation',
  { timeout: 180000 }, async () => {
    const t = await setup();
    try {
      const { invoker, store, identities, member, other, norows, unaudited, outsiderIdentity, envelope, create, setNow } = t;
      const dRows = async () => (await store.query({ model: D, authority: 'owner' }) as unknown as Array<{ data: Record<string, unknown> }>);
      setNow(10);
      const p1 = await create(`${APP}.P.create`, { v: '1' });
      const p2 = await create(`${APP}.P.create`, { v: '2' });
      async function seedChild(parent: { id: string }, accountId: string, v: string, role: string) {
        await create(`${APP}.C.create`, { parent: { id: parent.id }, account: { id: accountId }, v, role });
      }
      async function seedInvitation(parent: { id: string }, v: string, role: string) {
        return create(`${APP}.I.create`, { parent: { id: parent.id }, v, role });
      }
      // P1 children: member holds v=8, and the unaudited caller holds a
      // v=8 row whose predicate fully matches (used by the denial case
      // to prove the parent gate alone refuses).
      await seedChild(p1, member.membership.user_id, '8', 'administrator');
      await seedChild(p1, unaudited.membership.user_id, '8', 'administrator');
      const i7 = await seedInvitation(p1, '7', 'administrator');
      const i8 = await seedInvitation(p1, '8', 'administrator');
      // P2 children: other holds v=7, and member holds a v=7 row that
      // must NOT leak across the navigation boundary.
      await seedChild(p2, other.membership.user_id, '7', 'booker');
      await seedChild(p2, member.membership.user_id, '7', 'administrator');
      const iOther = await create(`${APP}.I.create`, { parent: { id: p2.id }, v: '7', role: 'booker' }, other.identity);

      // Matching row under the navigated parent selects.
      setNow(20);
      const firstEnvelope = envelope(`${APP}.go_nav`, { p: p1, i: i8, n: '8' });
      {
        const outcome = await invoker.invokeMutation(firstEnvelope, member.identity);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(outcome.result.result, '1');
        assert.equal(await dRows().then(rows => rows.length), 1);
      }

      // The member fully matches under P2 for n=7, but the invitation
      // lives under P1, whose children hold no (member,7) row: the
      // domain is exactly the navigated parent's children, not global C.
      setNow(30);
      {
        const dCount = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(envelope(`${APP}.go_nav`, { p: p1, i: i7, n: '7' }), member.identity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // No v=9 row anywhere: the require fails with no writes.
      setNow(35);
      {
        const dCount = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(envelope(`${APP}.go_nav`, { p: p1, i: i7, n: '9' }), member.identity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Caller scoping through the actor conjunct: other selects its
      // own v=7 row under its own parent P2.
      setNow(50);
      {
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.go_nav`, { p: p2, i: iOther, n: '7' }), other.identity);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
      }

      // A member with no rows matches nothing.
      {
        const dCount = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(envelope(`${APP}.go_nav`, { p: p1, i: i8, n: '8' }), norows.identity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // The navigated parent row is withheld from this caller: without
      // the auditor role the query parent lifetime is unavailable, even
      // though the caller's own v=8 row fully matches the predicate,
      // the invitation input is valid, and operation membership (plain
      // members) is retained.
      {
        const dCount = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.go_nav`, { p: p1, i: i8, n: '8' }), unaudited.identity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'forbidden', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Replaying the first committed operation replays without effects.
      {
        const dCount = await dRows().then(rows => rows.length);
        const replayed = await invoker.invokeRetainedMutation(firstEnvelope, member.identity);
        assert.ok('result' in replayed, JSON.stringify(replayed));
        assert.equal(replayed.result.status, 'replayed', JSON.stringify(replayed));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // A tampered invitation version is rejected with no writes.
      {
        const dCount = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.go_nav`, { p: p1, i: { id: i7.id, version: '999' }, n: '8' }), member.identity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'conflict', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // A caller without membership is denied at the operation boundary.
      {
        const dCount = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.go_nav`, { p: p1, i: i7, n: '7' }), outsiderIdentity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'forbidden', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Revoking membership withholds execution with no writes,
      // including the retained replay path.
      await identities.removeMembership(member.membership.membership_id);
      {
        const dCount = await dRows().then(rows => rows.length);
        const revokedOutcome = await invoker.invokeMutation(
          envelope(`${APP}.go_nav`, { p: p1, i: i7, n: '7' }), member.identity);
        assert.ok('error' in revokedOutcome, JSON.stringify(revokedOutcome));
        assert.equal(revokedOutcome.error.code, 'forbidden', JSON.stringify(revokedOutcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
        const withheld = await invoker.invokeRetainedMutation(firstEnvelope, member.identity);
        assert.ok('error' in withheld, JSON.stringify(withheld));
        assert.equal(withheld.error.code, 'forbidden', JSON.stringify(withheld));
      }

      assert.deepEqual(await readFile(fixtureSourcePath), t.originalSource);
      assert.equal(JSON.stringify(t.artifact), t.originalArtifact);
      assert.equal(await t.captureIsCurrent(t.capture), true);
      assert.equal(createHash('sha256').update(t.originalSource).digest('hex'), t.artifact.sources.find(source => resolve(source.path) === fixtureSourcePath)!.sha256);
    } finally {
      await t.worker?.dispose(); await rm(t.directory, { recursive: true, force: true });
    }
  });

test('native navigation-parent member-operand query reads the invitation field over the navigated parent',
  { timeout: 180000 }, async () => {
    const t = await setup();
    try {
      const { invoker, store, identities, member, other, outsiderIdentity, envelope, create, setNow } = t;
      const dRows = async () => (await store.query({ model: D, authority: 'owner' }) as unknown as Array<{ data: Record<string, unknown> }>);
      setNow(10);
      const p1 = await create(`${APP}.P.create`, { v: '1' });
      const p2 = await create(`${APP}.P.create`, { v: '2' });
      await create(`${APP}.C.create`, { parent: { id: p1.id }, account: { id: member.membership.user_id }, v: '7', role: 'administrator' });
      await create(`${APP}.C.create`, { parent: { id: p2.id }, account: { id: other.membership.user_id }, v: '7', role: 'booker' });
      const iAdmin = await create(`${APP}.I.create`, { parent: { id: p1.id }, v: '1', role: 'administrator' });
      const iBooker = await create(`${APP}.I.create`, { parent: { id: p1.id }, v: '1', role: 'booker' });
      const iBooker2 = await create(`${APP}.I.create`, { parent: { id: p2.id }, v: '1', role: 'booker' }, other.identity);

      // Matching invitation field selects the member's administrator row.
      setNow(20);
      {
        const outcome = await invoker.invokeMutation(envelope(`${APP}.go_nav_role`, { p: p1, i: iAdmin }), member.identity);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(await dRows().then(rows => rows.length), 1);
      }

      // Mismatching invitation field matches nothing for this caller.
      setNow(30);
      {
        const dCount = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(envelope(`${APP}.go_nav_role`, { p: p1, i: iBooker }), member.identity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Same booker invitation selects for its own holder under its
      // own parent.
      setNow(40);
      {
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.go_nav_role`, { p: p2, i: iBooker2 }), other.identity);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
      }

      // A caller without membership is denied at the operation boundary.
      {
        const dCount = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.go_nav_role`, { p: p1, i: iAdmin }), outsiderIdentity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'forbidden', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Revoking membership withholds execution with no writes.
      await identities.removeMembership(member.membership.membership_id);
      {
        const dCount = await dRows().then(rows => rows.length);
        const revokedOutcome = await invoker.invokeMutation(
          envelope(`${APP}.go_nav_role`, { p: p1, i: iAdmin }), member.identity);
        assert.ok('error' in revokedOutcome, JSON.stringify(revokedOutcome));
        assert.equal(revokedOutcome.error.code, 'forbidden', JSON.stringify(revokedOutcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      assert.deepEqual(await readFile(fixtureSourcePath), t.originalSource);
      assert.equal(JSON.stringify(t.artifact), t.originalArtifact);
      assert.equal(await t.captureIsCurrent(t.capture), true);
    } finally {
      await t.worker?.dispose(); await rm(t.directory, { recursive: true, force: true });
    }
  });
