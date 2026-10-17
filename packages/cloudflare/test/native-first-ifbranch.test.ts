/** If-branch conditional create -> captured CLI -> verified module -> real D1/Identity.
 *
 * Admitted compiler family (see compiler/tests/first_query_ifbranch.rs):
 * a contained single-predicate id-ordered first query with an `if
 * <binding>==null` branch holding exactly one nested create, requires and
 * proven sets in the arms, and a captured tail (requires, literal returns,
 * proven sets/emits). The taken arm executes through normal per-effect
 * authorization; the receipt observes the proven statements. This test proves
 * the executable half for both fixture scenarios: the emitted handler runs
 * the native first query, takes the live branch per call (create on absence,
 * set on presence), persists the trailing set, rolls back staged effects on
 * a later business failure, and leaves no writes behind on denial, revoked
 * membership or exhausted fence contention. No duplicate rows on replay.
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
import type { CommitBatch, CompileArtifact, MutationEnvelope, ReceiptIdentity, StoragePort } from '@canlang/contracts';
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { readScenarioReceiptAssociation } from '@canlang/state/invocation';
import { hashInputs } from '@canlang/state/invocation/replay';
import { asId, asModel, asOperation, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import type { MutationOutcome } from '../src/worker/assembly.js';

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
const APP = 'IfBranchSources';
const P = asModel(`${APP}.P`), C = asModel(`${APP}.C`), D = asModel(`${APP}.D`);
const fixtureSourcePath = join(root, 'compiler/tests/fixtures/first-query-ifbranch-create.can');
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

test('native if-branch conditional create runs the live branch per call with rollback and replay',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-native-first-ifbranch-'));
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
        profile: 'native-first-ifbranch', compilerPath, catalogPath,
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
        ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
        semanticOptions: { nativeScenarioReceipts: 'true' } });
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('If-branch source did not compile');
      const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      assert.equal(artifact.pages.length, 0);
      for (const name of [`${APP}.go_branch`, `${APP}.go_trailing`]) {
        const operation = artifact.operations?.find(operation => operation.name === name); assert.ok(operation, name);
        assert.equal(operation.kind, 'scenario'); assert.equal(operation.result?.type, 'int');
        const plan = operation.result!.disclosure; assert.ok(plan);
        const [query] = plan.queries ?? []; assert.ok(query);
        assert.equal(query.model, `${APP}.C`);
        assert.deepEqual(query.order, [{ field: 'id', direction: 'asc' }]);
        // The shared tail return is reached via both branch paths.
        assert.equal(plan.returns.length, 2, name);
        for (const returned of plan.returns) {
          assert.deepEqual(returned.influences.map(influence => influence.kind),
            ['query-existence', 'query-cardinality', 'query-membership', 'query-order']);
          assert.ok(returned.influences.every(influence => influence.queryId === query.id));
        }
        assert.ok(artifact.sources.some(source => source.path === plan.source.path && source.sha256 === plan.source.sha256));
      }
      const asm = await assembleModules({ artifact, sourcePath: fixtureSourcePath }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      for (const name of [`${APP}.go_branch`, `${APP}.go_trailing`]) {
        const callable = artifact.callables.find(callable => callable.id === name); assert.ok(callable, name);
        const generated = artifact.modules.find(module => module.path === callable.module); assert.ok(generated, name);
        assert.match(generated.js, /await firstQuery\(c,/);
        const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact));
        assert.equal(namespace[callable.export], name);
      }
      const moduleBytes = await Promise.all(artifact.modules.map(async module => {
        const path = fileURLToPath(asm.moduleUrls[module.path]!); return { path, bytes: await readFile(path) };
      }));

      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'first-ifbranch-identity', OWNER: 'first-ifbranch-owner' }, d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const baseTime = Date.now(); let now = baseTime;
      const clock = { nowMs: () => now }, identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      async function actor(email: string) {
        const user = await identities.createUser({ email, password_hash: 'unused', email_verified: true });
        const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
        const token = `native-first-ifbranch-${user.user_id}`;
        await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
          last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
        const current = () => resolveIdentity(identities, { session_token: token }, { clock });
        return { membership, current, identity: await current() };
      }
      const member = await actor('first-ifbranch-member@example.test');
      const outsider = await identities.createUser({ email: 'first-ifbranch-outsider@example.test', password_hash: 'unused', email_verified: true });
      const outsiderToken = 'native-first-ifbranch-outsider';
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
      const receiptIdentity = (input: MutationEnvelope): ReceiptIdentity => ({ app: APP, owner: team.team_id,
        principal: member.membership.user_id, operation: asOperation(input.operation), operationId: asOperationId(input.operation_id) });
      const invoke = (input: MutationEnvelope) => invoker.invokeMutation(input, member.identity);
      const unchanged = async (before: Awaited<ReturnType<typeof resources>>) => assert.deepEqual(await resources(), before);
      const dRows = async () => (await store.query({ model: D, authority: 'owner' }) as unknown as Array<{ data: Record<string, unknown> }>);
      const cRows = async () => (await store.query({ model: C, authority: 'owner' }) as unknown as Array<{ data: Record<string, unknown> }>);
      const pRows = async () => (await store.query({ model: P, authority: 'owner' }) as unknown as Array<{ data: Record<string, unknown> }>);

      // Seed one parent P (v = 1) and one matching child C (v = 7). Int
      // inputs use their canonical string wire form.
      now = baseTime + 10;
      const parent = await invoker.invokeMutation({ operation: `${APP}.P.create`, operation_id: uuidv7(baseTime, ++sequence), inputs: { v: '1' } }, member.identity);
      assert.ok('result' in parent, JSON.stringify(parent));
      const parentRecords = (parent.result as unknown as { records?: ReadonlyArray<{ id: string; version: number }> }).records ?? [];
      assert.equal(parentRecords.length, 1, `P.create wire: ${JSON.stringify(parent)}`);
      const parentId = parentRecords[0]!.id;
      const parentVersion = String(parentRecords[0]!.version);
      const child = await invoker.invokeMutation({ operation: `${APP}.C.create`, operation_id: uuidv7(baseTime, ++sequence), inputs: { parent: { id: parentId }, v: '7' } }, member.identity);
      assert.ok('result' in child, JSON.stringify(child));
      const childRecords = (child.result as unknown as { records?: ReadonlyArray<{ id: string }> }).records ?? [];
      assert.equal(childRecords.length, 1, `C.create wire: ${JSON.stringify(child)}`);

      // Absence (n = 999): then-arm creates exactly one D, scalar result 1.
      now = baseTime + 20;
      const absent = envelope(`${APP}.go_branch`, { p: { id: parentId, version: parentVersion }, n: '999', m: '0' });
      {
        const revision = await store.readRevision(), count = batches.length;
        const outcome = await invoke(absent);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(outcome.result.result, '1');
        assert.equal(batches.length, count + 1); const batch = batches.at(-1)!;
        assert.equal(batch.expectedRevision, revision); assert.equal(batch.writes.length, 1);
        assert.equal(batch.writes[0]!.kind, 'insert'); assert.equal(batch.writes[0]!.model, D);
        assert.equal(await dRows().then(rows => rows.length), 1);
        assert.deepEqual((await dRows())[0]!.data, { w: '999' });
        const physical = await store.readReceipt(receiptIdentity(absent)); assert.ok(physical);
        assert.equal(physical.inputHash, await hashInputs(absent.inputs));
        const association = readScenarioReceiptAssociation(physical); assert.ok(association);
        assert.equal(association.changed.filter(change => change.model === D).length, 1);
      }

      // Replaying the SAME operation id replays the recorded receipt: the
      // scalar result is preserved and no second D is created.
      {
        const replayed = await invoker.invokeRetainedMutation(absent, member.identity);
        assert.ok('result' in replayed, JSON.stringify(replayed));
        assert.equal(replayed.result.status, 'replayed', JSON.stringify(replayed));
        assert.equal(replayed.result.result, '1', JSON.stringify(replayed));
        assert.equal(await dRows().then(rows => rows.length), 1);
      }

      // Presence (n = 7): else-arm sets the selected C row, no D is created.
      now = baseTime + 30;
      {
        const outcome = await invoke(envelope(`${APP}.go_branch`, { p: { id: parentId, version: parentVersion }, n: '7', m: '5' }));
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(outcome.result.result, '1');
        assert.equal(await dRows().then(rows => rows.length), 1);
        assert.equal((await cRows())[0]!.data.v, '5');
      }

      // The branch is live per call: C now holds v = 5, so n = 7 matches
      // nothing and the then-arm creates D on this call.
      now = baseTime + 40;
      {
        const outcome = await invoke(envelope(`${APP}.go_branch`, { p: { id: parentId, version: parentVersion }, n: '7', m: '5' }));
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(await dRows().then(rows => rows.length), 2);
        assert.deepEqual((await dRows())[1]!.data, { w: '7' });
      }

      // Trailing scenario: absence creates D and persists the trailing set
      // on P, with scalar result 1.
      let pVersion = parentVersion;
      now = baseTime + 50;
      {
        const outcome = await invoke(envelope(`${APP}.go_trailing`, { p: { id: parentId, version: parentVersion }, n: '998', m: '0' }));
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(outcome.result.result, '1');
        assert.equal(await dRows().then(rows => rows.length), 3);
        assert.deepEqual((await pRows())[0]!.data, { v: '0' });
        pVersion = '2';
      }

      // A later business failure rolls back staged effects: with m = 1 the
      // trailing require fails after the create and the set staged, so no
      // new D lands and P keeps its committed row.
      {
        const before = await resources(), dCount = await dRows().then(rows => rows.length);
        const revision = await store.readRevision(), count = batches.length;
        const failing = envelope(`${APP}.go_trailing`, { p: { id: parentId, version: '2' }, n: '997', m: '1' });
        const outcome = await invoke(failing);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        const receipt = await store.readReceipt(receiptIdentity(failing)); assert.ok(receipt);
        assert.equal(receipt.outcome.status, 'rejected');
        assert.equal(await dRows().then(rows => rows.length), dCount);
        assert.deepEqual((await pRows())[0]!.data, { v: '0' });
        for (const batch of batches.slice(count)) {
          assert.deepEqual(batch.writes, []); assert.deepEqual(batch.history, []);
          assert.deepEqual(batch.outbox, []); assert.deepEqual(batch.schedules, []);
        }
        assert.equal(receipt.committedRevision, revision + 1);
        const after = await resources(); assert.deepEqual(after.identity, before.identity);
        for (const table of Object.keys(before.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) {
          assert.deepEqual(after.owner[table], before.owner[table], table);
        }
        const replay = await invoke(failing); assert.ok('error' in replay); assert.equal(replay.error.code, 'rule_failed');
      }

      // A stranger without membership is denied before any observation.
      {
        const before = await resources(), dCount = await dRows().then(rows => rows.length);
        const denied = envelope(`${APP}.go_branch`, { p: { id: parentId, version: pVersion }, n: '996', m: '0' });
        const deniedOutcome = await invoker.invokeMutation(denied, outsiderIdentity);
        assert.ok('error' in deniedOutcome, JSON.stringify(deniedOutcome));
        assert.equal(deniedOutcome.error.code, 'forbidden', JSON.stringify(deniedOutcome));
        await unchanged(before);
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Storage fence contention uses the bounded admission retry, not a
      // business rule: persistent contention on every staged-D attempt
      // exhausts the budget with retryable busy and no new D.
      {
        const forwarding = store.commit.bind(store);
        const competitor = (expectedRevision: number) => underlying.commit({
          expectedRevision, writes: [], history: [], receipt: null, outbox: [], schedules: [],
          uniqueClaims: [], uniqueReleases: [],
        });
        const dBefore = await dRows().then(rows => rows.length);
        (store as { commit: StoragePort['commit'] }).commit = (async (batch: CommitBatch) => {
          if (batch.writes.some(write => write.model === D)) {
            await competitor(batch.expectedRevision);
          }
          return forwarding(batch);
        }) as StoragePort['commit'];
        try {
          const conflicted = await invoke(envelope(`${APP}.go_branch`, { p: { id: parentId, version: pVersion }, n: '995', m: '0' }));
          assert.ok('error' in conflicted, JSON.stringify(conflicted));
          assert.equal(conflicted.error.code, 'busy', JSON.stringify(conflicted));
          assert.equal(await dRows().then(rows => rows.length), dBefore);
        } finally {
          (store as { commit: StoragePort['commit'] }).commit = forwarding;
        }
      }

      // Revoking membership withholds execution with no writes.
      await identities.removeMembership(member.membership.membership_id);
      {
        const before = await resources(), dCount = await dRows().then(rows => rows.length);
        const revoked = envelope(`${APP}.go_branch`, { p: { id: parentId, version: pVersion }, n: '994', m: '0' });
        const revokedOutcome = await invoker.invokeMutation(revoked, member.identity);
        assert.ok('error' in revokedOutcome, JSON.stringify(revokedOutcome));
        assert.equal(revokedOutcome.error.code, 'forbidden', JSON.stringify(revokedOutcome));
        await unchanged(before);
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Replaying the successful receipt after revocation withholds it
      // through the retained path with no new effects.
      {
        const before = await resources(), dCount = await dRows().then(rows => rows.length);
        const withheld = await invoker.invokeRetainedMutation(absent, member.identity);
        assert.ok('error' in withheld, JSON.stringify(withheld));
        assert.equal(withheld.error.code, 'forbidden', JSON.stringify(withheld));
        await unchanged(before);
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      assert.deepEqual(await readFile(fixtureSourcePath), originalSource);
      for (const module of moduleBytes) assert.deepEqual(await readFile(module.path), module.bytes);
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
      assert.equal(createHash('sha256').update(originalSource).digest('hex'), artifact.sources.find(source => resolve(source.path) === fixtureSourcePath)!.sha256);
    } finally {
      await worker?.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });

