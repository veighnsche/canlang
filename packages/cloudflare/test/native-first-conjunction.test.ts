/** Conjunction first query -> captured CLI -> verified module -> real D1/Identity.
 *
 * Admitted compiler family (see compiler/tests/first_query_conjunction.rs):
 * a contained id-ordered first query whose where clause is an
 * order-preserving `and` chain of `==` conjuncts over param operands. Each
 * conjunct records its own Control dependency; the emitted plan carries
 * every ordered dependency with unique IDs. This test proves the executable
 * half for all three fixture scenarios: two-condition selection (both
 * conjuncts filter), three-condition selection, id-ordered selection through
 * the branch set arm, replay without duplicates, rollback of staged effects
 * on later business failure, and denial/revocation with no writes.
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
import type { CommitBatch, CompileArtifact, MutationEnvelope, StoragePort } from '@canlang/contracts';
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
const APP = 'ConjSources';
const P = asModel(`${APP}.P`), C = asModel(`${APP}.C`), D = asModel(`${APP}.D`);
const fixtureSourcePath = join(root, 'compiler/tests/fixtures/first-query-conjunction.can');
type Tables = Record<string, Array<Record<string, unknown>>>;
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function snapshot(database: D1Database): Promise<Tables> {
  const names = await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name")
    .all<{ name: string }>();
  assert.equal(names.success, true);
  const result: Tables = {};
  for (const { name } of names.results) {
    const rows = await database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    result[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}

test('native conjunction first query selects on every conjunct with order, rollback and replay',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-native-first-conjunction-'));
    let worker: Miniflare | undefined;
    let capture: Awaited<ReturnType<typeof import('../src/dev/source-capture.js')['captureSingleFileSource']>> | undefined;
    try {
      const { assembleModules, importVerifiedAssemblyModule } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { installedLocalPreviewInputInventory } = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
      const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
      const { compileCapturedSingleFile } = await nodeImport(installed('dev/compiler-check.js')) as typeof import('../src/dev/compiler-check.js');
      const { createD1Storage, ensureSchema } = await nodeImport(stateInstalled('storage/d1.js')) as typeof import('@canlang/state/storage/d1');
      const originalSource = await readFile(fixtureSourcePath);
      const compilerPath = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
      const catalogPath = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
      capture = await captureSingleFileSource({ checkoutRoot: root, appPath: fixtureSourcePath,
        profile: 'native-first-conjunction', compilerPath, catalogPath,
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
        ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
        semanticOptions: { nativeScenarioReceipts: 'true' } });
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Conjunction source did not compile');
      const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      assert.equal(artifact.pages.length, 0);
      const expectedDeps: Record<string, { fields: string[]; returns: number }> = {
        [`${APP}.go_conj`]: { fields: ['v', 'role'], returns: 1 },
        [`${APP}.go_conj3`]: { fields: ['v', 'role', 'tag'], returns: 1 },
        // The shared tail return is reached via both branch paths, so the
        // receipt factors one scalar return per path.
        [`${APP}.go_conj_branch`]: { fields: ['v', 'role'], returns: 2 },
      };
      for (const [name, expected] of Object.entries(expectedDeps)) {
        const operation = artifact.operations?.find(operation => operation.name === name); assert.ok(operation, name);
        assert.equal(operation.kind, 'scenario'); assert.equal(operation.result?.type, 'int');
        const plan = operation.result!.disclosure; assert.ok(plan);
        const [query] = plan.queries ?? []; assert.ok(query);
        assert.equal(query.model, `${APP}.C`);
        assert.deepEqual(query.order, [{ field: 'id', direction: 'asc' }]);
        assert.deepEqual((query.dependencies ?? []).map(dep => dep.field), expected.fields, `${name} emits every conjunct in source order`);
        assert.equal(plan.returns.length, expected.returns, name);
        for (const returned of plan.returns) {
          assert.deepEqual(returned.influences.map(influence => influence.kind),
            ['query-existence', 'query-cardinality', 'query-membership', 'query-order']);
          assert.ok(returned.influences.every(influence => influence.queryId === query.id));
        }
        assert.ok(artifact.sources.some(source => source.path === plan.source.path && source.sha256 === plan.source.sha256));
      }
      const asm = await assembleModules({ artifact, sourcePath: fixtureSourcePath }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      for (const name of Object.keys(expectedDeps)) {
        const callable = artifact.callables.find(callable => callable.id === name); assert.ok(callable, name);
        const generated = artifact.modules.find(module => module.path === callable.module); assert.ok(generated, name);
        assert.match(generated.js, /await firstQuery\(c,/);
        const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact));
        assert.equal(namespace[callable.export], name);
      }
      {
        // The real emitted predicate evaluates the v conjunct (with its
        // dependency observation) before a short-circuiting && and the
        // role conjunct after it, in source order. A row failing v never
        // executes the role read; the engine's candidate correspondence
        // would invalidate a mismatched marker set, so successful
        // execution below proves the markers held.
        const goConj = artifact.callables.find(callable => callable.id === `${APP}.go_conj`)!;
        const goConjJs = artifact.modules.find(module => module.path === goConj.module)!.js;
        const callSite = goConjJs.slice(goConjJs.indexOf('await firstQuery'));
        assert.match(callSite, /observeScenarioReceiptQueryDependency\([^)]*"v"[\s\S]*?&&[\s\S]*?observeScenarioReceiptQueryDependency\([^)]*"role"/,
          'emitted conjunction evaluates v, short-circuits, then role');
      }
      const moduleBytes = await Promise.all(artifact.modules.map(async module => {
        const path = fileURLToPath(asm.moduleUrls[module.path]!); return { path, bytes: await readFile(path) };
      }));
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'first-conjunction-identity', OWNER: 'first-conjunction-owner' }, d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const baseTime = Date.now(); let now = baseTime;
      const clock = { nowMs: () => now }, identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      async function actor(email: string) {
        const user = await identities.createUser({ email, password_hash: 'unused', email_verified: true });
        const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
        const token = `native-first-conjunction-${user.user_id}`;
        await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
          last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
        const current = () => resolveIdentity(identities, { session_token: token }, { clock });
        return { membership, current, identity: await current() };
      }
      const member = await actor('first-conjunction-member@example.test');
      const outsider = await identities.createUser({ email: 'first-conjunction-outsider@example.test', password_hash: 'unused', email_verified: true });
      const outsiderToken = 'native-first-conjunction-outsider';
      await identities.createSession({ user_id: outsider.user_id, token_sha256: await sha256HexText(outsiderToken),
        last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
      const outsiderIdentity = await resolveIdentity(identities, { session_token: outsiderToken }, { clock });
      const underlying = createD1Storage(ownerDb), batches: CommitBatch[] = [];
      const store: StoragePort = { ...underlying, async commit(batch) {
        const result = await underlying.commit(batch); batches.push(batch); return result;
      } };
      const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs });
      const resources = async () => ({ identity: await snapshot(identityDb), owner: await snapshot(ownerDb) });
      let sequence = 0;
      const envelope = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
        operation, operation_id: uuidv7(baseTime, ++sequence), inputs });
      const invoke = (input: MutationEnvelope) => invoker.invokeMutation(input, member.identity);
      const unchanged = async (before: Awaited<ReturnType<typeof resources>>) => assert.deepEqual(await resources(), before);
      const dRows = async () => (await store.query({ model: D, authority: 'owner' }) as unknown as Array<{ id: string; data: Record<string, unknown> }>);
      const cRows = async () => (await store.query({ model: C, authority: 'owner' }) as unknown as Array<{ id: string; data: Record<string, unknown> }>);
      const pRows = async () => (await store.query({ model: P, authority: 'owner' }) as unknown as Array<{ id: string; data: Record<string, unknown> }>);

      // Seed one parent P (v = 1) and three children that separate the two
      // conjuncts: only c1 matches v = 7 AND role = admin.
      now = baseTime + 10;
      const parent = await invoker.invokeMutation({ operation: `${APP}.P.create`, operation_id: uuidv7(baseTime, ++sequence), inputs: { v: '1' } }, member.identity);
      assert.ok('result' in parent, JSON.stringify(parent));
      const parentRecords = (parent.result as unknown as { records?: ReadonlyArray<{ id: string; version: number }> }).records ?? [];
      assert.equal(parentRecords.length, 1, `P.create wire: ${JSON.stringify(parent)}`);
      const parentId = parentRecords[0]!.id;
      const parentVersion = String(parentRecords[0]!.version);
      async function seedChild(v: string, role: string, tag: string) {
        const child = await invoker.invokeMutation({ operation: `${APP}.C.create`, operation_id: uuidv7(baseTime, ++sequence),
          inputs: { parent: { id: parentId }, v, role, tag } }, member.identity);
        assert.ok('result' in child, JSON.stringify(child));
        const records = (child.result as unknown as { records?: ReadonlyArray<{ id: string }> }).records ?? [];
        assert.equal(records.length, 1, `C.create wire: ${JSON.stringify(child)}`);
        return records[0]!.id;
      }
      const c1 = await seedChild('7', 'admin', 'x');
      const c2 = await seedChild('7', 'user', 'y');
      const c3 = await seedChild('8', 'admin', 'z');

      // Both conjuncts filter: n = 7 matches c1/c2 on v, role picks c1.
      now = baseTime + 20;
      {
        const outcome = await invoke(envelope(`${APP}.go_conj`, { p: { id: parentId, version: parentVersion }, n: '7', r: 'admin' }));
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(outcome.result.result, '1');
        assert.equal(await dRows().then(rows => rows.length), 1);
        assert.deepEqual((await dRows())[0]!.data, { w: '7' });
      }

      // The second conjunct alone selects c2: role = user with v = 7.
      now = baseTime + 30;
      {
        const outcome = await invoke(envelope(`${APP}.go_conj`, { p: { id: parentId, version: parentVersion }, n: '7', r: 'user' }));
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(await dRows().then(rows => rows.length), 2);
      }

      // No row satisfies both: require fails, nothing is created. A
      // rejection receipt is recorded, so only domain rows are compared.
      now = baseTime + 40;
      {
        const cBefore = await cRows(), pBefore = await pRows(), dCount = await dRows().then(rows => rows.length);
        const outcome = await invoke(envelope(`${APP}.go_conj`, { p: { id: parentId, version: parentVersion }, n: '7', r: 'nobody' }));
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
        assert.deepEqual(await cRows(), cBefore);
        assert.deepEqual(await pRows(), pBefore);
      }

      // Three conjuncts select c1 exactly.
      now = baseTime + 50;
      {
        const outcome = await invoke(envelope(`${APP}.go_conj3`, { p: { id: parentId, version: parentVersion }, n: '7', r: 'admin', t: 'x' }));
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(await dRows().then(rows => rows.length), 3);
      }

      // The third conjunct filters too: c1 would still be selected if it
      // were omitted, but a wrong tag matches nothing.
      {
        const cBefore = await cRows(), pBefore = await pRows(), dCount = await dRows().then(rows => rows.length);
        const outcome = await invoke(envelope(`${APP}.go_conj3`, { p: { id: parentId, version: parentVersion }, n: '7', r: 'admin', t: 'zzz' }));
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
        assert.deepEqual(await cRows(), cBefore);
        assert.deepEqual(await pRows(), pBefore);
      }

      // Id order through the branch set arm: two rows match v = 9 AND
      // role = admin, so the lowest id wins the set.
      const c4 = await seedChild('9', 'admin', 'q');
      const c5 = await seedChild('9', 'admin', 'q');
      now = baseTime + 60;
      const branchEnvelope = envelope(`${APP}.go_conj_branch`, { p: { id: parentId, version: parentVersion }, n: '9', r: 'admin', m: '0' });
      {
        const outcome = await invoke(branchEnvelope);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        const rows = await cRows();
        assert.equal(rows.find(row => row.id === c4)!.data.v, '0', 'first id-ordered match is set');
        assert.equal(rows.find(row => row.id === c5)!.data.v, '9', 'later match is untouched');
        assert.equal(rows.find(row => row.id === c1)!.data.v, '7');
        assert.equal(rows.find(row => row.id === c2)!.data.v, '7');
        assert.equal(rows.find(row => row.id === c3)!.data.v, '8');
      }

      // Replaying the SAME branch operation id replays without new effects.
      {
        const dCount = await dRows().then(rows => rows.length);
        const replayed = await invoker.invokeRetainedMutation(branchEnvelope, member.identity);
        assert.ok('result' in replayed, JSON.stringify(replayed));
        assert.equal(replayed.result.status, 'replayed', JSON.stringify(replayed));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Matched-arm late failure: both staged sets (branch row and
      // trailing parent) roll back when require m == 0 fails, with no D.
      {
        const cBefore = await cRows(), dCount = await dRows().then(rows => rows.length);
        const failing = envelope(`${APP}.go_conj_branch`, { p: { id: parentId, version: '2' }, n: '7', r: 'admin', m: '1' });
        const outcome = await invoke(failing);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
        assert.deepEqual(await cRows(), cBefore, 'staged matched-arm sets rolled back');
        assert.deepEqual((await pRows())[0]!.data, { v: '0' }, 'staged trailing parent set rolled back');
      }

      // A later business failure rolls back staged effects: absence stages
      // a create plus the trailing parent set, then require m == 0 fails.
      {
        const cBefore = await cRows(), dCount = await dRows().then(rows => rows.length);
        const failing = envelope(`${APP}.go_conj_branch`, { p: { id: parentId, version: '2' }, n: '998', r: 'admin', m: '1' });
        const outcome = await invoke(failing);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
        assert.deepEqual((await pRows())[0]!.data, { v: '0' }, 'staged create and trailing parent set rolled back');
        assert.deepEqual(await cRows(), cBefore, 'staged branch set rolled back');
      }

      // A stranger without membership is denied before any observation.
      {
        const before = await resources(), dCount = await dRows().then(rows => rows.length);
        const denied = envelope(`${APP}.go_conj`, { p: { id: parentId, version: '2' }, n: '7', r: 'admin' });
        const deniedOutcome = await invoker.invokeMutation(denied, outsiderIdentity);
        assert.ok('error' in deniedOutcome, JSON.stringify(deniedOutcome));
        assert.equal(deniedOutcome.error.code, 'forbidden', JSON.stringify(deniedOutcome));
        await unchanged(before);
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Revoking membership withholds execution with no writes, including
      // the retained replay path.
      await identities.removeMembership(member.membership.membership_id);
      {
        const before = await resources(), dCount = await dRows().then(rows => rows.length);
        const revoked = envelope(`${APP}.go_conj`, { p: { id: parentId, version: '2' }, n: '7', r: 'admin' });
        const revokedOutcome = await invoker.invokeMutation(revoked, member.identity);
        assert.ok('error' in revokedOutcome, JSON.stringify(revokedOutcome));
        assert.equal(revokedOutcome.error.code, 'forbidden', JSON.stringify(revokedOutcome));
        await unchanged(before);
        assert.equal(await dRows().then(rows => rows.length), dCount);
        const withheld = await invoker.invokeRetainedMutation(branchEnvelope, member.identity);
        assert.ok('error' in withheld, JSON.stringify(withheld));
        assert.equal(withheld.error.code, 'forbidden', JSON.stringify(withheld));
        await unchanged(before);
      }

      assert.deepEqual(await readFile(fixtureSourcePath), originalSource);
      for (const module of moduleBytes) assert.deepEqual(await readFile(module.path), module.bytes);
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
      assert.equal(createHash('sha256').update(originalSource).digest('hex'), artifact.sources.find(source => resolve(source.path) === fixtureSourcePath)!.sha256);
    } finally {
      await worker?.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });

test('native enum first query selects on actor plus enum param and closed case',
  { timeout: 180000 }, async () => {
    const ENUM_APP = 'ConjEnumSources';
    const ED = asModel(`${ENUM_APP}.D`);
    const enumFixture = join(root, 'compiler/tests/fixtures/first-query-conjunction-enum.can');
    const directory = await mkdtemp(join(tmpdir(), 'can-native-first-enum-'));
    let worker: Miniflare | undefined;
    let capture: Awaited<ReturnType<typeof import('../src/dev/source-capture.js')['captureSingleFileSource']>> | undefined;
    try {
      const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { installedLocalPreviewInputInventory } = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
      const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
      const { compileCapturedSingleFile } = await nodeImport(installed('dev/compiler-check.js')) as typeof import('../src/dev/compiler-check.js');
      const { createD1Storage, ensureSchema } = await nodeImport(stateInstalled('storage/d1.js')) as typeof import('@canlang/state/storage/d1');
      const originalSource = await readFile(enumFixture);
      const compilerPath = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
      const catalogPath = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
      capture = await captureSingleFileSource({ checkoutRoot: root, appPath: enumFixture,
        profile: 'native-first-enum', compilerPath, catalogPath,
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
        ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
        semanticOptions: { nativeScenarioReceipts: 'true' } });
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Enum source did not compile');
      const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      const expectedDeps: Record<string, Array<{ field: string; type: string }>> = {
        [`${ENUM_APP}.go_enum`]: [{ field: 'account', type: 'user' }, { field: 'role', type: 'enum(administrator,booker)' }],
        [`${ENUM_APP}.go_lit`]: [{ field: 'role', type: 'enum(administrator,booker)' }],
      };
      for (const [name, deps] of Object.entries(expectedDeps)) {
        const operation = artifact.operations?.find(operation => operation.name === name); assert.ok(operation, name);
        const plan = operation.result!.disclosure; assert.ok(plan);
        const [query] = plan.queries ?? []; assert.ok(query);
        assert.deepEqual((query.dependencies ?? []).map(dep => ({ field: dep.field, type: dep.type })), deps, `${name} carries the sealed enum identity`);
      }
      const asm = await assembleModules({ artifact, sourcePath: enumFixture }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'first-enum-identity', OWNER: 'first-enum-owner' }, d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const baseTime = Date.now(); let now = baseTime;
      const clock = { nowMs: () => now }, identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      async function actor(email: string) {
        const user = await identities.createUser({ email, password_hash: 'unused', email_verified: true });
        const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
        const token = `native-first-enum-${user.user_id}`;
        await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
          last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
        const current = () => resolveIdentity(identities, { session_token: token }, { clock });
        return { membership, current, identity: await current() };
      }
      const member = await actor('first-enum-member@example.test');
      const other = await actor('first-enum-other@example.test');
      const outsider = await identities.createUser({ email: 'first-enum-outsider@example.test', password_hash: 'unused', email_verified: true });
      const outsiderToken = 'native-first-enum-outsider';
      await identities.createSession({ user_id: outsider.user_id, token_sha256: await sha256HexText(outsiderToken),
        last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
      const outsiderIdentity = await resolveIdentity(identities, { session_token: outsiderToken }, { clock });
      const underlying = createD1Storage(ownerDb);
      const store: StoragePort = underlying;
      const invoker = buildInvoker(artifact, asm, store, { appId: ENUM_APP, memberships: identities, source: 'http', now: clock.nowMs });
      let sequence = 1000;
      const envelope = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
        operation, operation_id: uuidv7(baseTime, ++sequence), inputs });
      const invoke = (input: MutationEnvelope) => invoker.invokeMutation(input, member.identity);
      const dRows = async () => (await store.query({ model: ED, authority: 'owner' }) as unknown as Array<{ data: Record<string, unknown> }>);

      now = baseTime + 10;
      const parent = await invoker.invokeMutation({ operation: `${ENUM_APP}.P.create`, operation_id: uuidv7(baseTime, ++sequence), inputs: { v: '1' } }, member.identity);
      assert.ok('result' in parent, JSON.stringify(parent));
      const parentId = ((parent.result as unknown as { records?: ReadonlyArray<{ id: string; version: number }> }).records ?? [])[0]!.id;
      const parentVersion = String(((parent.result as unknown as { records?: ReadonlyArray<{ id: string; version: number }> }).records ?? [])[0]!.version);
      async function seedChild(accountId: string, role: string) {
        const child = await invoker.invokeMutation({ operation: `${ENUM_APP}.C.create`, operation_id: uuidv7(baseTime, ++sequence),
          inputs: { parent: { id: parentId }, account: { id: accountId }, role } }, member.identity);
        assert.ok('result' in child, JSON.stringify(child));
      }
      await seedChild(member.membership.user_id, 'administrator');
      await seedChild(member.membership.user_id, 'booker');
      await seedChild(other.membership.user_id, 'administrator');

      // Actor plus enum param: member's administrator row matches.
      now = baseTime + 20;
      {
        const outcome = await invoke(envelope(`${ENUM_APP}.go_enum`, { p: { id: parentId, version: parentVersion }, r: 'administrator' }));
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(await dRows().then(rows => rows.length), 1);
        assert.deepEqual((await dRows())[0]!.data, { w: '1' });
      }

      // Same actor, other case: member's booker row matches.
      now = baseTime + 30;
      {
        const outcome = await invoke(envelope(`${ENUM_APP}.go_enum`, { p: { id: parentId, version: parentVersion }, r: 'booker' }));
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(await dRows().then(rows => rows.length), 2);
      }

      // Closed case literal: first administrator row overall.
      now = baseTime + 40;
      {
        const outcome = await invoke(envelope(`${ENUM_APP}.go_lit`, { p: { id: parentId, version: parentVersion } }));
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(await dRows().then(rows => rows.length), 3);
        assert.deepEqual((await dRows())[2]!.data, { w: '2' });
      }

      // An authorized caller with no matching row fails the require with
      // no writes: other holds only an administrator row, so booker
      // matches nothing for them while the same call succeeds for member.
      now = baseTime + 50;
      {
        const dCount = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(
          envelope(`${ENUM_APP}.go_enum`, { p: { id: parentId, version: parentVersion }, r: 'booker' }), other.identity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // A caller without membership is denied at the operation boundary.
      {
        const dCount = await dRows().then(rows => rows.length);
        const outcome = await invoker.invokeMutation(
          envelope(`${ENUM_APP}.go_enum`, { p: { id: parentId, version: parentVersion }, r: 'administrator' }), outsiderIdentity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'forbidden', JSON.stringify(outcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Revoking membership withholds execution with no writes.
      await identities.removeMembership(member.membership.membership_id);
      {
        const dCount = await dRows().then(rows => rows.length);
        const revoked = envelope(`${ENUM_APP}.go_enum`, { p: { id: parentId, version: parentVersion }, r: 'administrator' });
        const revokedOutcome = await invoker.invokeMutation(revoked, member.identity);
        assert.ok('error' in revokedOutcome, JSON.stringify(revokedOutcome));
        assert.equal(revokedOutcome.error.code, 'forbidden', JSON.stringify(revokedOutcome));
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      assert.deepEqual(await readFile(enumFixture), originalSource);
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
      assert.equal(createHash('sha256').update(originalSource).digest('hex'), artifact.sources.find(source => resolve(source.path) === enumFixture)!.sha256);
    } finally {
      await worker?.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });
