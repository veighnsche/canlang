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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CommitBatch, CompileArtifact, MutationEnvelope, ReceiptIdentity, StoragePort } from '@canlang/contracts';
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { readScenarioReceiptAssociation } from '@canlang/state/invocation';
import { hashInputs } from '@canlang/state/invocation/replay';
import { asId, asModel, asOperation, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import type { MutationOutcome } from '../src/worker/assembly.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
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
    let capture: Awaited<ReturnType<typeof import('../src/dev/source-capture.js')['captureSingleFileSource']>> | undefined;
    try {
      const { assembleModules, importVerifiedAssemblyModule } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { installedLocalPreviewInputInventory } = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
      const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
      const { compileCapturedSingleFile } = await nodeImport(installed('dev/compiler-check.js')) as typeof import('../src/dev/compiler-check.js');
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
      const dCount = await dRows().then(rows => rows.length);
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

      // A storage revision conflict after the handler staged D rolls the
      // whole commit back. A separate genuine revision-only competing commit
      // (receipt null, everything empty) advances the store; the untouched
      // candidate then fails with the exact store conflict and lands no D,
      // history, outbox or schedule effects. Only the conflict timing is
      // arranged; the refusal and rollback are real. Legitimate rejection
      // receipt/fence bookkeeping may still advance.
      {
        const forwarding = store.commit.bind(store);
        (store as { commit: StoragePort['commit'] }).commit = (async (batch: CommitBatch) => {
          if (batch.writes.some(write => write.model === D)) {
            (store as { commit: StoragePort['commit'] }).commit = forwarding;
            await underlying.commit({
              expectedRevision: batch.expectedRevision,
              writes: [], history: [], receipt: null, outbox: [], schedules: [],
              uniqueClaims: [], uniqueReleases: [],
            });
          }
          return forwarding(batch);
        }) as StoragePort['commit'];
        try {
          const revision = await store.readRevision(), count = batches.length;
          const conflicted = await invoke(envelope({ p: { id: parentId, version: parentVersion }, n: '7' }));
          assert.ok('error' in conflicted, JSON.stringify(conflicted));
          assert.equal(conflicted.error.code, 'rule_failed', JSON.stringify(conflicted));
          assert.match(conflicted.error.message, /Fence conflict: expected revision \d+, actual \d+/, JSON.stringify(conflicted));
          for (const batch of batches.slice(count)) {
            assert.deepEqual(batch.writes, []);
            assert.deepEqual(batch.history, []);
            assert.deepEqual(batch.outbox, []);
            assert.deepEqual(batch.schedules, []);
          }
          assert.ok((await store.readRevision()) >= revision + 1);
          assert.equal(await dRows().then(rows => rows.length), dCount);
        } finally {
          (store as { commit: StoragePort['commit'] }).commit = forwarding;
        }
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
