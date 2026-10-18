/** Leading `require not any(...)` + `first` composition -> real D1/Identity.
 *
 * Scope is the admitted narrow profile: `by=members`, navigated parent,
 * multi-conjunct predicate, void effect tail. The original CanCustomer
 * accept (`by=authenticated`) and recover (reference-array helper
 * closure) remain separate recorded work.
 *
 * The compiler admits the direct any/first shape with a sealed native
 * receipt; State binds the navigated predicate ANY (including the enum
 * CONTROL) after verifying the exact checked LeadingRequire call record
 * against the installed owner/source, and the void workflow commits.
 * This test proves the executable half: with a matching inactive grant
 * row the accept commits and creates D under the invitation parent; an
 * active grant row refuses with exact rule_failed and no writes; role
 * mismatch, outsider and revoked callers are refused with no writes;
 * retained replay is replayed without duplicate effects. The companion
 * tamper test proves each mutated call-record field refuses.
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
const APP = 'AnyFirstProbe';
const P = asModel(`${APP}.P`), C = asModel(`${APP}.C`), D = asModel(`${APP}.D`), I = asModel(`${APP}.I`);
const fixtureSourcePath = join(root, 'compiler/tests/fixtures/any-first-composition.can');

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'can-native-any-first-'));
  const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
  const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
  const { installedLocalPreviewInputInventory } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
  const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
  const { compileCapturedSingleFile } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
  const { createD1Storage, ensureSchema } = await nodeImport(stateInstalled('storage/d1.js')) as typeof import('@canlang/state/storage/d1');
  const originalSource = await readFile(fixtureSourcePath);
  const compilerPath = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
  const catalogPath = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
  const capture = await captureSingleFileSource({ checkoutRoot: root, appPath: fixtureSourcePath,
    profile: 'native-any-first-composition', compilerPath, catalogPath,
    helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
    ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
    semanticOptions: { nativeScenarioReceipts: 'true' } });
  assert.equal(await captureIsCurrent(capture), true);
  const compiled = await compileCapturedSingleFile(capture);
  assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
  if (compiled.kind !== 'artifact') throw new Error('Any/first source did not compile');
  const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
  assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
  {
    const op = artifact.operations?.find(candidate => candidate.name === `${APP}.accept`);
    assert.ok(op, 'accept admitted');
    assert.equal(op.result!.disclosure!.queries.length, 2);
    const accept = artifact.callables.find(callable => callable.id === `${APP}.accept`)!;
    const acceptJs = artifact.modules.find(module => module.path === accept.module)!.js;
    assert.match(acceptJs, /executeScenarioReceiptAny/);
  }
  const asm = await assembleModules({ artifact, sourcePath: fixtureSourcePath }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
  const worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { IDENTITY: 'any-first-identity', OWNER: 'any-first-owner' }, d1Persist: join(directory, 'd1') });
  const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
  const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
  await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
  const baseTime = Date.now(); let now = baseTime;
  const clock = { nowMs: () => now }, identities = createD1IdentityStore(identityDb, { clock });
  const team = await identities.createTeam({ timezone: 'UTC' });
  async function actor(email: string) {
    const user = await identities.createUser({ email, password_hash: 'unused', email_verified: true });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = `native-any-first-${user.user_id}`;
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
    const current = () => resolveIdentity(identities, { session_token: token }, { clock });
    return { membership, current, identity: await current() };
  }
  const member = await actor('any-first-member@example.test');
  const stranger = await actor('any-first-stranger@example.test');
  const outsider = await identities.createUser({ email: 'any-first-outsider@example.test', password_hash: 'unused', email_verified: true });
  const outsiderToken = 'native-any-first-outsider';
  await identities.createSession({ user_id: outsider.user_id, token_sha256: await sha256HexText(outsiderToken),
    last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
  const outsiderIdentity = await resolveIdentity(identities, { session_token: outsiderToken }, { clock });
  const underlying = createD1Storage(ownerDb);
  const store = underlying;
  const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs });
  let sequence = 5000;
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
    invoker, store, identities, member, stranger, outsiderIdentity, envelope, create, clock,
    setNow: (delta: number) => { now = baseTime + delta; } };
}

test('native any/first composition commits on inactive grant and refuses active/role-mismatch/outsider/revoked with no writes',
  { timeout: 180000 }, async () => {
    const t = await setup();
    try {
      const { invoker, store, identities, member, stranger, outsiderIdentity, envelope, create, setNow } = t;
      const dRows = async () => (await store.query({ model: D, authority: 'owner' }) as unknown as Array<{ data: Record<string, unknown>; parent?: { model?: unknown; id?: unknown } }>);
      setNow(10);
      const parent = await create(`${APP}.P.create`, { v: '1' });
      const invitation = await create(`${APP}.I.create`,
        { parent: { id: parent.id }, role: 'administrator' });

      // A matching but inactive grant row lets the leading `not any`
      // pass while `first` still selects it: accept commits and creates
      // D under the invitation parent with the transported enum role.
      const grant = await create(`${APP}.C.create`,
        { parent: { id: parent.id }, account: { id: member.membership.user_id }, role: 'administrator', active: false });
      void grant;
      setNow(20);
      {
        const first = envelope(`${APP}.accept`, { invitation });
        const outcome = await invoker.invokeMutation(first, member.identity);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        const replayed = await invoker.invokeRetainedMutation(first, member.identity);
        assert.ok('result' in replayed, JSON.stringify(replayed));
        assert.equal(replayed.result.status, 'replayed');
        const rows = await dRows();
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0].data.account, { id: member.membership.user_id });
        assert.equal(rows[0].data.role, 'administrator');
        assert.equal(rows[0].parent?.model, `${APP}.P`);
        assert.equal(rows[0].parent?.id, parent.id);
      }

      // Flipping the grant active makes `any` true: the leading require
      // refuses with exact rule_failed and no new D row.
      setNow(30);
      {
        const fetched = (await store.query({ model: C, authority: 'owner' }) as unknown as Array<{ id: string; version: number }>);
        const row = fetched[0]!;
        const updated = await invoker.invokeMutation(
          envelope(`${APP}.C.update`, { record: { id: row.id, version: String(row.version) }, active: true }), member.identity);
        assert.ok('result' in updated, JSON.stringify(updated));
        const before = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.accept`, { invitation }), member.identity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), before);
      }

      // A stranger has no grant row at all: `first` selects nothing and
      // the null require refuses with no writes.
      setNow(40);
      {
        const probe = await create(`${APP}.I.create`,
          { parent: { id: parent.id }, role: 'administrator' }, stranger.identity);
        const before = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.accept`, { invitation: probe }), stranger.identity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), before);
      }

      // An invitation whose role matches no grant row: `first` selects
      // nothing and the null require refuses with no writes.
      setNow(45);
      {
        const probe = await create(`${APP}.I.create`,
          { parent: { id: parent.id }, role: 'booker' });
        const before = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.accept`, { invitation: probe }), member.identity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), before);
      }

      // A caller without membership is denied at the operation boundary.
      setNow(50);
      {
        const before = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(
          envelope(`${APP}.accept`, { invitation }), outsiderIdentity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'forbidden', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), before);
      }

      // Revoking membership withholds execution with no writes.
      await identities.removeMembership(member.membership.membership_id);
      setNow(60);
      {
        const before = await dRows().then(rows => rows.length);
        const revokedOutcome = await invoker.invokeMutation(
          envelope(`${APP}.accept`, { invitation }), member.identity);
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

test('native any/first tampered call records refuse with no writes', { timeout: 180000 }, async () => {
  // Each mutation alters only the emitted direct-call metadata while the
  // callback, plan, sources and rows stay unchanged: owner, stage,
  // target, chain, argument types, either index side, or a dropped
  // record/selector must each refuse at the installed bind.
  const t = await setup();
  try {
    const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
    const extract = (js: string) => {
      const marker = 'queryAny:[';
      const start = js.indexOf(marker);
      assert.ok(start >= 0, 'emitted direct predicate metadata present');
      let depth = 0, end = -1;
      for (let i = start + marker.length - 1; i < js.length; i++) {
        if (js[i] === '[') depth++;
        else if (js[i] === ']') {
          depth--;
          if (depth === 0) { end = i + 1; break; }
        }
      }
      assert.ok(end > 0, 'balanced queryAny array');
      return { start: start + marker.length - 1, end, value: JSON.parse(js.slice(start + marker.length - 1, end)) as Array<Record<string, any>> };
    };
    const cases: Array<{ name: string; mutate: (entry: Record<string, any>) => void; message: RegExp }> = [
      { name: 'owner', mutate: entry => { entry.call.owner = `${APP}.other`; }, message: /Direct predicate ANY lacks/ },
      { name: 'stage', mutate: entry => { entry.call.stage = 'body-require'; }, message: /Direct predicate ANY lacks/ },
      { name: 'target', mutate: entry => { entry.call.target.id = 'every'; }, message: /Direct predicate ANY lacks/ },
      { name: 'chain', mutate: entry => { entry.call.chain = [{}]; }, message: /Direct predicate ANY lacks/ },
      { name: 'predicate-type', mutate: entry => { entry.call.arguments[1].type = 'int'; }, message: /Direct predicate ANY lacks/ },
      { name: 'domain-type', mutate: entry => { entry.call.arguments[0].type = `${APP}.D[]`; }, message: /Direct predicate ANY lacks/ },
      { name: 'selector-indices', mutate: entry => { entry.sourceCall.siteIndex = 7; entry.sourceCall.callIndex = 7; }, message: /Direct predicate ANY lacks|Predicate ANY differs/ },
      { name: 'record-indices', mutate: entry => { entry.call.siteIndex = 7; entry.call.callIndex = 7; }, message: /Direct predicate ANY lacks/ },
      { name: 'dropped-call', mutate: entry => { delete entry.call; }, message: /Predicate ANY lacks its exact checked query/ },
      { name: 'dropped-selector', mutate: entry => { delete entry.sourceCall; }, message: /Predicate ANY lacks its exact checked query|Predicate ANY requires/ },
    ];
    const dRows = async () => t.store.query({ model: D, authority: 'owner' }) as unknown as Array<unknown>;
    for (const { name, mutate, message } of cases) {
      const before = (await dRows()).length;
      const mutant = structuredClone(t.artifact) as CompileArtifact;
      const module = mutant.modules.find(entry => entry.js.includes('queryAny:['))!;
      assert.ok(module, 'predicate module present');
      const { start, end, value } = extract(module.js);
      assert.equal(value.length, 1, 'one direct predicate entry');
      mutate(value[0]!);
      module.js = module.js.slice(0, start) + JSON.stringify(value) + module.js.slice(end);
      const dir = await mkdtemp(join(t.directory, `mutant-${name}-`));
      const asm = await assembleModules({ artifact: mutant, sourcePath: fixtureSourcePath },
        { workDir: join(dir, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      const invoker = buildInvoker(mutant, asm, t.store,
        { appId: APP, memberships: t.identities, source: 'http', now: t.clock.nowMs });
      let error: { code?: unknown; message?: unknown } | undefined;
      try {
        const outcome = await invoker.invokeMutation(
          t.envelope(`${APP}.accept`, { invitation: { id: uuidv7(Date.now(), 999001) } }), t.member.identity);
        if ('error' in outcome) error = outcome.error as { code?: unknown; message?: unknown };
      } catch (thrown) {
        error = thrown as { code?: unknown; message?: unknown };
      }
      assert.ok(error, `${name}: tampered call record must refuse`);
      assert.equal(error!.code ?? 'validation', 'validation', `${name}: ${JSON.stringify(error)}`);
      assert.match(String(error!.message ?? ''), message, `${name} refusal layer`);
      assert.equal((await dRows()).length, before, `${name}: refusal writes nothing`);
    }
  } finally {
    await rm(t.directory, { recursive: true, force: true });
    await t.worker.dispose();
  }
});
