/** Terminal side-effect first query -> captured CLI -> verified module -> real D1/Identity.
 *
 * Admitted compiler family (see compiler/tests/first_query_side_effect.rs):
 * a contained single-predicate id-ordered first query with a presence
 * require, one top-level create immediately followed by a plain scalar
 * return. The test proves the executable half: the emitted handler runs the
 * native first query, gates on the require, persists exactly one D per
 * successful call with scalar result 1, and leaves no writes behind on
 * require failure, denial, nonexistent-parent input or revoked membership.
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
const APP = 'SideEffectSources';
const P = asModel(`${APP}.P`), C = asModel(`${APP}.C`), D = asModel(`${APP}.D`);
const fixtureSourcePath = join(root, 'compiler/tests/fixtures/first-query-side-effect.can');
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

test('native terminal side-effect first query persists one row per success with scalar return',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-native-first-side-effect-'));
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
        profile: 'native-first-side-effect', compilerPath, catalogPath,
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
        ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
        semanticOptions: { nativeScenarioReceipts: 'true' } });
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Side-effect source did not compile');
      const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      assert.equal(artifact.pages.length, 0);
      const operation = artifact.operations?.find(operation => operation.name === `${APP}.go`); assert.ok(operation);
      assert.equal(operation.kind, 'scenario'); assert.equal(operation.result?.type, 'int');
      const plan = operation.result!.disclosure; assert.ok(plan);
      const [query] = plan.queries ?? []; assert.ok(query);
      assert.equal(query.model, `${APP}.C`);
      assert.deepEqual(query.order, [{ field: 'id', direction: 'asc' }]);
      assert.equal(plan.returns.length, 1);
      const [returned] = plan.returns; assert.ok(returned);
      assert.deepEqual(returned.influences.map(influence => influence.kind),
        ['query-existence', 'query-cardinality', 'query-membership', 'query-order']);
      assert.ok(returned.influences.every(influence => influence.queryId === query.id));
      assert.ok(artifact.sources.some(source => source.path === plan.source.path && source.sha256 === plan.source.sha256));
      const asm = await assembleModules({ artifact, sourcePath: fixtureSourcePath }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      const callable = artifact.callables.find(callable => callable.id === operation.name); assert.ok(callable);
      const generated = artifact.modules.find(module => module.path === callable.module); assert.ok(generated);
      assert.match(generated.js, /await firstQuery\(c,/);
      const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact));
      assert.equal(namespace[callable.export], operation.name);
      const definition = object(namespace.appDefinition); assert.equal(definition.id, APP);
      assert.equal(object(object(definition.operations)[operation.name]).handler, operation.name);
      const moduleBytes = await Promise.all(artifact.modules.map(async module => {
        const path = fileURLToPath(asm.moduleUrls[module.path]!); return { path, bytes: await readFile(path) };
      }));

      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'first-side-effect-identity', OWNER: 'first-side-effect-owner' }, d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const baseTime = Date.now(); let now = baseTime;
      const clock = { nowMs: () => now }, identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      async function actor(email: string) {
        const user = await identities.createUser({ email, password_hash: 'unused', email_verified: true });
        const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
        const token = `native-first-side-effect-${user.user_id}`;
        await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
          last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
        const current = () => resolveIdentity(identities, { session_token: token }, { clock });
        return { membership, current, identity: await current() };
      }
      const member = await actor('first-side-effect-member@example.test');
      const outsider = await identities.createUser({ email: 'first-side-effect-outsider@example.test', password_hash: 'unused', email_verified: true });
      const outsiderToken = 'native-first-side-effect-outsider';
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
      const envelope = (inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
        operation: `${APP}.go`, operation_id: uuidv7(baseTime, ++sequence), inputs });
      const receiptIdentity = (input: MutationEnvelope): ReceiptIdentity => ({ app: APP, owner: team.team_id,
        principal: member.membership.user_id, operation: asOperation(input.operation), operationId: asOperationId(input.operation_id) });
      const invoke = (input: MutationEnvelope) => invoker.invokeMutation(input, member.identity);
      const unchanged = async (before: Awaited<ReturnType<typeof resources>>) => assert.deepEqual(await resources(), before);
      const dRows = async () => (await store.query({ model: D, authority: 'owner' }) as unknown as Array<{ data: Record<string, unknown> }>);
      async function rejectedWithoutEffects(input: MutationEnvelope, code = 'rule_failed') {
        const before = await resources(), revision = await store.readRevision(), count = batches.length;
        const outcome = await invoke(input); assert.ok('error' in outcome, JSON.stringify(outcome)); assert.equal(outcome.error.code, code, JSON.stringify(outcome));
        const receipt = await store.readReceipt(receiptIdentity(input)); assert.ok(receipt);
        assert.equal(receipt.outcome.status, 'rejected'); assert.equal(receipt.committedRevision, revision + 1);
        const after = await resources(); assert.deepEqual(after.identity, before.identity);
        for (const table of Object.keys(before.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) {
          assert.deepEqual(after.owner[table], before.owner[table], table);
        }
        for (const batch of batches.slice(count)) {
          assert.deepEqual(batch.writes, []); assert.deepEqual(batch.history, []);
          assert.deepEqual(batch.outbox, []); assert.deepEqual(batch.schedules, []);
        }
        const replay = await invoke(input); assert.ok('error' in replay); assert.equal(replay.error.code, code);
        await unchanged(after);
      }

      // Seed one parent P and one matching child C (v = 7). Int inputs use
      // their canonical string wire form: proven by trial in this consumer
      // that a JS number fails input validation with an otherwise identical
      // envelope (n: 7 refused, n: '7' admitted), matching stored int wire
      // (stock '3'). Value coercion is a separate owner question.
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

      // Success: the require finds C, exactly one D persists, scalar result is 1.
      now = baseTime + 20;
      const input = envelope({ p: { id: parentId, version: parentVersion }, n: '7' });
      const revision = await store.readRevision(), count = batches.length;
      const outcome = await invoke(input);
      assert.ok('result' in outcome, JSON.stringify(outcome));
      assert.equal(outcome.result.status, 'committed');
      // Scalar ints use their canonical string wire form end to end
      // (stored '7', input '7', result '1').
      assert.equal(outcome.result.result, '1');
      assert.equal(batches.length, count + 1); const batch = batches.at(-1)!;
      assert.equal(batch.expectedRevision, revision); assert.equal(batch.writes.length, 1);
      assert.equal(batch.writes[0]!.kind, 'insert'); assert.equal(batch.writes[0]!.model, D);
      assert.equal(await dRows().then(rows => rows.length), 1);
      assert.deepEqual((await dRows())[0]!.data, { w: '7' });
      const physical = await store.readReceipt(receiptIdentity(input)); assert.ok(physical);
      assert.equal(physical.inputHash, await hashInputs(input.inputs));
      const association = readScenarioReceiptAssociation(physical); assert.ok(association);
      assert.deepEqual(association.plan, plan);
      assert.equal(association.changed.filter(change => change.model === D).length, 1);
      const [saved] = association.queries ?? []; assert.ok(saved);
      assert.equal(saved.queryId, query.id); assert.equal(saved.revision, revision);
      assert.deepEqual(saved.selectedIndices, [0]);

      // A second call runs its terminal create again: two D rows, same scalar.
      now = baseTime + 30;
      const second = await invoke(envelope({ p: { id: parentId, version: parentVersion }, n: '7' }));
      assert.ok('result' in second, JSON.stringify(second));
      assert.equal(second.result.status, 'committed');
      assert.equal(second.result.result, '1');
      assert.equal(await dRows().then(rows => rows.length), 2);

      // Replaying the SAME operation id replays the recorded receipt: the
      // scalar result is preserved and no third D is created.
      {
        const replayed = await invoker.invokeRetainedMutation(input, member.identity);
        assert.ok('result' in replayed, JSON.stringify(replayed));
        assert.equal(replayed.result.status, 'replayed', JSON.stringify(replayed));
        assert.equal(replayed.result.result, '1', JSON.stringify(replayed));
        assert.equal(await dRows().then(rows => rows.length), 2);
      }

      // No matching C: exact require failure with no new D and no writes.
      let dCount = await dRows().then(rows => rows.length);
      await rejectedWithoutEffects(envelope({ p: { id: parentId, version: parentVersion }, n: '999' }));
      assert.equal(await dRows().then(rows => rows.length), dCount);

      // A nonexistent parent id fails with no writes (nonexistence, not a
      // foreign-owner authority case: no such row exists to own).
      {
        const missing = envelope({ p: { id: '0197416e-0000-7000-8000-000000000000', version: '1' }, n: '7' });
        const before = await resources();
        const missingOutcome = await invoke(missing);
        assert.ok('error' in missingOutcome, JSON.stringify(missingOutcome));
        assert.equal(missingOutcome.error.code, 'not_found', JSON.stringify(missingOutcome));
        await unchanged(before);
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // A stranger without membership is denied before any observation.
      {
        const denied = envelope({ p: { id: parentId, version: parentVersion }, n: '7' });
        const before = await resources();
        const deniedOutcome = await invoker.invokeMutation(denied, outsiderIdentity);
        assert.ok('error' in deniedOutcome, JSON.stringify(deniedOutcome));
        assert.equal(deniedOutcome.error.code, 'forbidden', JSON.stringify(deniedOutcome));
        await unchanged(before);
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Storage fence contention uses the bounded admission retry, not a
      // business rule. A genuine revision-only competing commit (receipt
      // null, everything empty) arranges the conflict; nothing is
      // hand-built. One-shot contention is retried and the identical
      // envelope then commits with its D. Persistent contention on every
      // staged-D attempt exhausts the budget and surfaces the retryable
      // busy error with no landed D. (An earlier pin of rule_failed here
      // was a mixed-loader artifact: storage from the static test graph
      // threw a different FenceConflictError identity than the installed
      // invoker catches, so no retry happened. Both now load installed.)
      {
        const forwarding = store.commit.bind(store);
        const competitor = (expectedRevision: number) => underlying.commit({
          expectedRevision, writes: [], history: [], receipt: null, outbox: [], schedules: [],
          uniqueClaims: [], uniqueReleases: [],
        });
        const dBefore = await dRows().then(rows => rows.length);
        // One-shot: conflict once, then let the retry through to success.
        let fired = false;
        (store as { commit: StoragePort['commit'] }).commit = (async (batch: CommitBatch) => {
          if (!fired && batch.writes.some(write => write.model === D)) {
            fired = true;
            await competitor(batch.expectedRevision);
          }
          return forwarding(batch);
        }) as StoragePort['commit'];
        try {
          const outcome = await invoke(envelope({ p: { id: parentId, version: parentVersion }, n: '7' }));
          assert.ok('result' in outcome, JSON.stringify(outcome));
          assert.equal(outcome.result.status, 'committed');
          assert.equal(await dRows().then(rows => rows.length), dBefore + 1);
        } finally {
          (store as { commit: StoragePort['commit'] }).commit = forwarding;
        }
        // Persistent: conflict every staged-D attempt; the bounded budget
        // exhausts with retryable busy and no new D.
        const dAfterRetry = await dRows().then(rows => rows.length);
        (store as { commit: StoragePort['commit'] }).commit = (async (batch: CommitBatch) => {
          if (batch.writes.some(write => write.model === D)) {
            await competitor(batch.expectedRevision);
          }
          return forwarding(batch);
        }) as StoragePort['commit'];
        try {
          const conflicted = await invoke(envelope({ p: { id: parentId, version: parentVersion }, n: '7' }));
          assert.ok('error' in conflicted, JSON.stringify(conflicted));
          assert.equal(conflicted.error.code, 'busy', JSON.stringify(conflicted));
          assert.equal(await dRows().then(rows => rows.length), dAfterRetry);
        } finally {
          (store as { commit: StoragePort['commit'] }).commit = forwarding;
        }
        // The one-shot retry above committed an extra D; re-baseline the
        // no-new-D expectations for the phases below.
        dCount = await dRows().then(rows => rows.length);
      }

      // Revoking membership withholds execution with no writes.
      await identities.removeMembership(member.membership.membership_id);
      {
        const revoked = envelope({ p: { id: parentId, version: parentVersion }, n: '7' });
        const before = await resources();
        const revokedOutcome = await invoker.invokeMutation(revoked, member.identity);
        assert.ok('error' in revokedOutcome, JSON.stringify(revokedOutcome));
        assert.equal(revokedOutcome.error.code, 'forbidden', JSON.stringify(revokedOutcome));
        await unchanged(before);
        assert.equal(await dRows().then(rows => rows.length), dCount);
      }

      // Replaying the successful receipt after revocation withholds it
      // through the retained path with no new effects.
      {
        const before = await resources();
        const withheld = await invoker.invokeRetainedMutation(input, member.identity);
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

test('native terminal side-effect absence require creates only when no row matches',
  { timeout: 180000 }, async () => {
    const ABSENT_APP = 'AbsenceSources';
    const absentFixture = join(root, 'compiler/tests/fixtures/first-query-side-effect-absence.can');
    const absentD = asModel(`${ABSENT_APP}.D`);
    const directory = await mkdtemp(join(tmpdir(), 'can-native-first-absence-'));
    let worker: Miniflare | undefined;
    let capture: Awaited<ReturnType<typeof import('../src/runtime/native-dev.test-support.js')['captureSingleFileSource']>> | undefined;
    try {
      const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { installedLocalPreviewInputInventory } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { compileCapturedSingleFile } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { createD1Storage, ensureSchema } = await nodeImport(stateInstalled('storage/d1.js')) as typeof import('@canlang/state/storage/d1');
      const originalSource = await readFile(absentFixture);
      const compilerPath = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
      const catalogPath = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
      capture = await captureSingleFileSource({ checkoutRoot: root, appPath: absentFixture,
        profile: 'native-first-side-effect-absence', compilerPath, catalogPath,
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
        ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
        semanticOptions: { nativeScenarioReceipts: 'true' } });
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Absence source did not compile');
      const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      const operation = artifact.operations?.find(operation => operation.name === `${ABSENT_APP}.go_absent`); assert.ok(operation);
      assert.equal(operation.kind, 'scenario'); assert.equal(operation.result?.type, 'int');
      const asm = await assembleModules({ artifact, sourcePath: absentFixture }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      const callable = artifact.callables.find(callable => callable.id === operation.name); assert.ok(callable);

      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'first-absence-identity', OWNER: 'first-absence-owner' }, d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const baseTime = Date.now();
      const clock = { nowMs: () => baseTime + 10 }, identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: 'first-absence-member@example.test', password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
      const token = 'native-first-absence-member';
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
      const identity = await resolveIdentity(identities, { session_token: token }, { clock });
      const underlying = createD1Storage(ownerDb);
      const store: StoragePort = underlying;
      const invoker = buildInvoker(artifact, asm, store, { appId: ABSENT_APP, memberships: identities, source: 'http', now: clock.nowMs });
      let sequence = 0;
      const envelope = (inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
        operation: `${ABSENT_APP}.go_absent`, operation_id: uuidv7(baseTime, ++sequence), inputs });
      const dCount = async () => (await store.query({ model: absentD, authority: 'owner' }) as unknown as Array<unknown>).length;

      // Seed one parent P and no C rows.
      const parent = await invoker.invokeMutation({ operation: `${ABSENT_APP}.P.create`, operation_id: uuidv7(baseTime, ++sequence), inputs: { v: '1' } }, identity);
      assert.ok('result' in parent, JSON.stringify(parent));
      const parentRecords = ((parent.result as unknown as { records?: Array<{ id: string; version: number }> }).records ?? []);
      assert.equal(parentRecords.length, 1, `P.create wire: ${JSON.stringify(parent)}`);
      const parentId = parentRecords[0]!.id;
      const parentVersion = String(parentRecords[0]!.version);

      // Absent: no matching C, the require passes, one D persists, scalar '1'.
      const input = envelope({ p: { id: parentId, version: parentVersion }, n: '7' });
      const absent = await invoker.invokeMutation(input, identity);
      assert.ok('result' in absent, JSON.stringify(absent));
      assert.equal(absent.result.status, 'committed');
      assert.equal(absent.result.result, '1');
      assert.equal(await dCount(), 1);

      // Replaying the absent success replays without a second D.
      const replayed = await invoker.invokeRetainedMutation(input, identity);
      assert.ok('result' in replayed, JSON.stringify(replayed));
      assert.equal(replayed.result.status, 'replayed', JSON.stringify(replayed));
      assert.equal(await dCount(), 1);

      // Present: seed the matching C, the absence require now fails with
      // the exact authored-require code and no D.
      const child = await invoker.invokeMutation({ operation: `${ABSENT_APP}.C.create`, operation_id: uuidv7(baseTime, ++sequence), inputs: { parent: { id: parentId }, v: '7' } }, identity);
      assert.ok('result' in child, JSON.stringify(child));
      const present = await invoker.invokeMutation(envelope({ p: { id: parentId, version: parentVersion }, n: '7' }), identity);
      assert.ok('error' in present, JSON.stringify(present));
      assert.equal(present.error.code, 'rule_failed', JSON.stringify(present));
      assert.equal(await dCount(), 1);

      // Require-or/and conjunctions live in the companion conjunction
      // fixture with their own runtime test below (guard-consumed
      // registration + decision-authority consumer).

      assert.deepEqual(await readFile(absentFixture), originalSource);
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
    } finally {
      await worker?.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });

test('native require conjunctions over absence decide with stored control reads',
  { timeout: 180000 }, async () => {
    const CONJ_APP = 'ConjunctionSources';
    const conjFixture = join(root, 'compiler/tests/fixtures/first-query-side-effect-conjunction.can');
    const conjD = asModel(`${CONJ_APP}.D`);
    const directory = await mkdtemp(join(tmpdir(), 'can-native-first-conjunction-'));
    let worker: Miniflare | undefined;
    let capture: Awaited<ReturnType<typeof import('../src/runtime/native-dev.test-support.js')['captureSingleFileSource']>> | undefined;
    try {
      const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { installedLocalPreviewInputInventory } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { compileCapturedSingleFile } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { createD1Storage, ensureSchema } = await nodeImport(stateInstalled('storage/d1.js')) as typeof import('@canlang/state/storage/d1');
      const originalSource = await readFile(conjFixture);
      const compilerPath = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
      const catalogPath = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
      capture = await captureSingleFileSource({ checkoutRoot: root, appPath: conjFixture,
        profile: 'native-first-side-effect-conjunction', compilerPath, catalogPath,
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
        ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
        semanticOptions: { nativeScenarioReceipts: 'true' } });
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Conjunction source did not compile');
      const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      // Both conjunction operations carry the guard-consumed decision mark.
      for (const name of [`${CONJ_APP}.go_or`, `${CONJ_APP}.go_and`]) {
        const operation = artifact.operations?.find(operation => operation.name === name); assert.ok(operation, name);
        assert.equal(operation.kind, 'scenario'); assert.equal(operation.result?.type, 'int');
      }
      const asm = await assembleModules({ artifact, sourcePath: conjFixture }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      for (const name of [`${CONJ_APP}.go_or`, `${CONJ_APP}.go_and`]) {
        assert.ok(artifact.callables.some(callable => callable.id === name), name);
      }

      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'first-conjunction-identity', OWNER: 'first-conjunction-owner' }, d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const baseTime = Date.now();
      const clock = { nowMs: () => baseTime + 10 }, identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: 'first-conjunction-member@example.test', password_hash: 'unused', email_verified: true });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
      const token = 'native-first-conjunction-member';
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
      const identity = await resolveIdentity(identities, { session_token: token }, { clock });
      const underlying = createD1Storage(ownerDb);
      const store: StoragePort = underlying;
      const invoker = buildInvoker(artifact, asm, store, { appId: CONJ_APP, memberships: identities, source: 'http', now: clock.nowMs });
      let sequence = 0;
      const sized = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
        operation, operation_id: uuidv7(baseTime, ++sequence), inputs });
      const dCount = async () => (await store.query({ model: conjD, authority: 'owner' }) as unknown as Array<unknown>).length;
      const committedWithD = async (input: MutationEnvelope, count: number) => {
        const outcome = await invoker.invokeMutation(input, identity);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(outcome.result.result, '1');
        assert.equal(await dCount(), count + 1);
        return count + 1;
      };
      const refusedWithoutD = async (input: MutationEnvelope, count: number, code = 'rule_failed') => {
        const outcome = await invoker.invokeMutation(input, identity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, code, JSON.stringify(outcome));
        assert.equal(await dCount(), count);
      };

      const parent = await invoker.invokeMutation({ operation: `${CONJ_APP}.P.create`, operation_id: uuidv7(baseTime, ++sequence), inputs: { v: '1' } }, identity);
      assert.ok('result' in parent, JSON.stringify(parent));
      const parentRecords = ((parent.result as unknown as { records?: Array<{ id: string; version: number }> }).records ?? []);
      assert.equal(parentRecords.length, 1);
      const row = { p: { id: parentRecords[0]!.id, version: String(parentRecords[0]!.version) } };
      const seedC = async (v: string) => {
        const created = await invoker.invokeMutation({ operation: `${CONJ_APP}.C.create`, operation_id: uuidv7(baseTime, ++sequence), inputs: { parent: { id: parentRecords[0]!.id }, v } }, identity);
        assert.ok('result' in created, JSON.stringify(created));
      };

      let d = await dCount();
      // or/absent: no C(v=80), the null arm passes without reading c.v.
      d = await committedWithD(sized(`${CONJ_APP}.go_or`, { ...row, n: '80', m: '80' }), d);
      // or/match: C(v=81) with m=81, the stored field arm passes.
      await seedC('81');
      const orMatch = sized(`${CONJ_APP}.go_or`, { ...row, n: '81', m: '81' });
      d = await committedWithD(orMatch, d);
      // or/replay: same input replays without a new D.
      const orReplayed = await invoker.invokeRetainedMutation(orMatch, identity);
      assert.ok('result' in orReplayed, JSON.stringify(orReplayed));
      assert.equal(orReplayed.result.status, 'replayed', JSON.stringify(orReplayed));
      assert.equal(await dCount(), d);
      // or/mismatch: C(v=81) found but 81 != 82 — the stored comparison
      // really executes, the require fails exact.
      await refusedWithoutD(sized(`${CONJ_APP}.go_or`, { ...row, n: '81', m: '82' }), d);
      // and/match, and/absent, and/mismatch.
      d = await committedWithD(sized(`${CONJ_APP}.go_and`, { ...row, n: '81', m: '81' }), d);
      await refusedWithoutD(sized(`${CONJ_APP}.go_and`, { ...row, n: '80', m: '80' }), d);
      await refusedWithoutD(sized(`${CONJ_APP}.go_and`, { ...row, n: '81', m: '82' }), d);

      // Revoking membership denies the decision path by owner authority
      // (DESIGN §4: decision reads are owner-bounded, never a viewer
      // grant and gain no result grant).
      await identities.removeMembership(membership.membership_id);
      {
        const before = await dCount();
        const denied = await invoker.invokeMutation(sized(`${CONJ_APP}.go_or`, { ...row, n: '81', m: '81' }), identity);
        assert.ok('error' in denied, JSON.stringify(denied));
        assert.equal(denied.error.code, 'forbidden', JSON.stringify(denied));
        assert.equal(await dCount(), before);
      }

      assert.deepEqual(await readFile(conjFixture), originalSource);
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
    } finally {
      await worker?.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });

test('native require decision reads withheld fields under owner authority only',
  { timeout: 180000 }, async () => {
    // 0346/0411 discriminator: C.v is withheld from viewer grants
    // (C read policy fields=parent; CRUD write eligibility unchanged), so
    // the `or` field arm CANNOT pass under ordinary viewer mode. The
    // Require decision must still execute under bounded owner authority
    // via the contained decision grant (exact admitted parent, issued
    // rows, current stage), gaining no viewer/result grant. Acceptance is
    // the authorized commit plus its effects; scalar visibility follows
    // the existing result/control contract, so both private arms withhold
    // the scalar (genuine result-control/query-influence dependencies on
    // the withheld field) while disclosing no field data.
    const PRIV_APP = 'PrivateSources';
    const privFixture = join(root, 'compiler/tests/fixtures/first-query-side-effect-private.can');
    const privD = asModel(`${PRIV_APP}.D`);
    const directory = await mkdtemp(join(tmpdir(), 'can-native-first-private-'));
    let worker: Miniflare | undefined;
    let capture: Awaited<ReturnType<typeof import('../src/runtime/native-dev.test-support.js')['captureSingleFileSource']>> | undefined;
    try {
      const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { installedLocalPreviewInputInventory } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { compileCapturedSingleFile } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { createD1Storage, ensureSchema } = await nodeImport(stateInstalled('storage/d1.js')) as typeof import('@canlang/state/storage/d1');
      const originalSource = await readFile(privFixture);
      const compilerPath = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
      const catalogPath = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
      capture = await captureSingleFileSource({ checkoutRoot: root, appPath: privFixture,
        profile: 'native-first-side-effect-private', compilerPath, catalogPath,
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
        ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
        semanticOptions: { nativeScenarioReceipts: 'true' } });
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Private source did not compile');
      const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      const operation = artifact.operations?.find(operation => operation.name === `${PRIV_APP}.go_or`); assert.ok(operation);
      assert.equal(operation.kind, 'scenario'); assert.equal(operation.result?.type, 'int');
      const asm = await assembleModules({ artifact, sourcePath: privFixture }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      const callable = artifact.callables.find(callable => callable.id === operation.name); assert.ok(callable);

      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'first-private-identity', OWNER: 'first-private-owner' }, d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const baseTime = Date.now();
      const clock = { nowMs: () => baseTime + 10 }, identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: 'first-private-member@example.test', password_hash: 'unused', email_verified: true });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
      const token = 'native-first-private-member';
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
      const identity = await resolveIdentity(identities, { session_token: token }, { clock });
      const underlying = createD1Storage(ownerDb);
      const store: StoragePort = underlying;
      const invoker = buildInvoker(artifact, asm, store, { appId: PRIV_APP, memberships: identities, source: 'http', now: clock.nowMs });
      let sequence = 0;
      const sized = (inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
        operation: `${PRIV_APP}.go_or`, operation_id: uuidv7(baseTime, ++sequence), inputs });
      const dCount = async () => (await store.query({ model: privD, authority: 'owner' }) as unknown as Array<unknown>).length;

      const parent = await invoker.invokeMutation({ operation: `${PRIV_APP}.P.create`, operation_id: uuidv7(baseTime, ++sequence), inputs: { v: '1' } }, identity);
      assert.ok('result' in parent, JSON.stringify(parent));
      const parentRecords = ((parent.result as unknown as { records?: Array<{ id: string; version: number }> }).records ?? []);
      assert.equal(parentRecords.length, 1);
      const row = { p: { id: parentRecords[0]!.id, version: String(parentRecords[0]!.version) } };
      const seedC = async (v: string) => {
        const created = await invoker.invokeMutation({ operation: `${PRIV_APP}.C.create`, operation_id: uuidv7(baseTime, ++sequence), inputs: { parent: { id: parentRecords[0]!.id }, v } }, identity);
        assert.ok('result' in created, JSON.stringify(created));
      };

      let d = await dCount();
      // Absent arm commits without touching the withheld field. The scalar
      // is withheld (null): the recorded return carries genuine
      // query-influence dependencies on the withheld control field, and the
      // existing result/control contract withholds it from viewers.
      const absent = await invoker.invokeMutation(sized({ ...row, n: '80', m: '80' }), identity);
      assert.ok('result' in absent, JSON.stringify(absent));
      assert.equal(absent.result.status, 'committed');
      assert.equal(absent.result.result, null, JSON.stringify(absent.result));
      assert.equal(await dCount(), d + 1); d += 1;
      // Match arm: C.v is withheld from viewers, so only the contained
      // owner decision grant can satisfy the Require. The commit plus its D
      // effect is the acceptance; the scalar stays withheld per its genuine
      // v control dependency, disclosing no field data.
      await seedC('81');
      const matched = await invoker.invokeMutation(sized({ ...row, n: '81', m: '81' }), identity);
      assert.ok('result' in matched, JSON.stringify(matched));
      assert.equal(matched.result.status, 'committed');
      assert.equal(matched.result.result, null, JSON.stringify(matched.result));
      assert.equal(await dCount(), d + 1); d += 1;
      // Viewer proof: a real viewer read of C discloses no v anywhere,
      // even though a row carrying v exists.
      const viewed = await invoker.invokeRead({ operation: `${PRIV_APP}.C.read`, inputs: {} }, identity);
      assert.ok('result' in viewed, JSON.stringify(viewed));
      const records = (viewed.result as { records?: Array<{ data?: Record<string, unknown> }> }).records ?? [];
      assert.ok(records.length >= 1, JSON.stringify(viewed.result));
      for (const record of records) assert.ok(!Object.hasOwn(record.data ?? {}, 'v'), JSON.stringify(record));
      // Mismatch arm fails exact with no D.
      const mismatched = await invoker.invokeMutation(sized({ ...row, n: '81', m: '82' }), identity);
      assert.ok('error' in mismatched, JSON.stringify(mismatched));
      assert.equal(mismatched.error.code, 'rule_failed', JSON.stringify(mismatched));
      assert.equal(await dCount(), d);
      // Revocation denies by owner authority with no effects.
      await identities.removeMembership(membership.membership_id);
      {
        const before = await dCount();
        const denied = await invoker.invokeMutation(sized({ ...row, n: '81', m: '81' }), identity);
        assert.ok('error' in denied, JSON.stringify(denied));
        assert.equal(denied.error.code, 'forbidden', JSON.stringify(denied));
        assert.equal(await dCount(), before);
      }

      assert.deepEqual(await readFile(privFixture), originalSource);
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
    } finally {
      await worker?.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });
