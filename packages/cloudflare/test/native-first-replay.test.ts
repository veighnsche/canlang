/** Whole-row idempotent replay -> same model record without duplicate effects.
 *
 * Admitted slice D shape (see compiler/tests/native_first_replay.rs): an
 * unscoped single-Text-equality id-ordered same-model first() with
 * `if previous!=null ... return previous` alongside a same-model create.
 * The replay branch returns State's own first-selected owner row, so the
 * defining lifetime comes from the completed first selection (genuine row,
 * checked source authority, installed commit guard) rather than a separate
 * data-ID observation the admitted plan deliberately omits. Denied,
 * foreign, malformed and current-authority failures stay exact, and the
 * verified module, artifact and sources remain untouched throughout.
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
const APP = 'WholeSources', RECEIPT = asModel(`${APP}.Receipt`);
const fixtureSourcePath = join(root, 'compiler/tests/fixtures/native-first-replay.can');
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
function committed(outcome: MutationOutcome, status: 'committed' | 'replayed' = 'committed') {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, status);
  const wire = object(outcome.result.result);
  assert.deepEqual(Object.keys(wire), ['id']); assert.equal(typeof wire.id, 'string');
  return { outcome: outcome.result, id: wire.id as string };
}

test('native replay first returns the same whole row without duplicate effects',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-native-first-replay-'));
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
        profile: 'native-first-replay', compilerPath, catalogPath,
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
        ...installedLocalPreviewInputInventory(root, compilerPath), inputInventory: 'installed-local-preview',
        semanticOptions: { nativeScenarioReceipts: 'true' } });
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Original replay source did not compile');
      const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      assert.equal(artifact.pages.length, 0);
      const operation = artifact.operations?.find(operation => operation.name === `${APP}.receive`); assert.ok(operation);
      assert.equal(operation.kind, 'scenario'); assert.equal(operation.result?.type, RECEIPT);
      const plan = operation.result!.disclosure; assert.ok(plan);
      const [query] = plan.queries ?? []; assert.ok(query);
      assert.equal(query.model, RECEIPT); assert.deepEqual(query.order, [{ field: 'id', direction: 'asc' }]);
      assert.equal(query.limit, null); assert.equal(query.archived, 'exclude');
      assert.equal(query.dependencies.length, 1);
      assert.equal(query.dependencies[0]!.role, 'control'); assert.equal(query.dependencies[0]!.field, 'source');
      assert.equal(query.dependencies[0]!.type, 'text');
      assert.equal(plan.returns.length, 2);
      for (const returned of plan.returns) {
        assert.deepEqual(returned.dependencies, []);
        assert.deepEqual(returned.influences.map(influence => influence.kind),
          ['query-existence', 'query-cardinality', 'query-membership', 'query-order']);
        assert.ok(returned.influences.every(influence => influence.queryId === query.id));
      }
      assert.ok(artifact.sources.some(source => source.path === plan.source.path && source.sha256 === plan.source.sha256));
      const asm = await assembleModules({ artifact, sourcePath: fixtureSourcePath }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      const callable = artifact.callables.find(callable => callable.id === operation.name); assert.ok(callable);
      const generated = artifact.modules.find(module => module.path === callable.module); assert.ok(generated);
      assert.match(generated.js, /await firstQuery\(c,/);
      assert.match(generated.js, /await executeScenarioReceiptQuery\(c,/);
      assert.match(generated.js, /await bindScenarioReceiptModelResult\(c,/);
      const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact));
      assert.equal(namespace[callable.export], operation.name);
      const definition = object(namespace.appDefinition); assert.equal(definition.id, APP);
      assert.equal(object(object(definition.operations)[operation.name]).handler, operation.name);
      const moduleBytes = await Promise.all(artifact.modules.map(async module => {
        const path = fileURLToPath(asm.moduleUrls[module.path]!); return { path, bytes: await readFile(path) };
      }));

      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'first-replay-identity', OWNER: 'first-replay-owner' }, d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const baseTime = Date.now(); let now = baseTime;
      const clock = { nowMs: () => now }, identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      async function actor(email: string) {
        const user = await identities.createUser({ email, password_hash: 'unused', email_verified: true });
        const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
        const token = `native-first-replay-${user.user_id}`;
        await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
          last_team_id: team.team_id, expires_at: new Date(baseTime + 3600_000).toISOString() });
        const current = () => resolveIdentity(identities, { session_token: token }, { clock });
        return { membership, current, identity: await current() };
      }
      const member = await actor('first-replay-member@example.test'), colleague = await actor('first-replay-other@example.test');
      const outsider = await identities.createUser({ email: 'first-replay-outsider@example.test', password_hash: 'unused', email_verified: true });
      const outsiderToken = 'native-first-replay-outsider';
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
        operation: `${APP}.receive`, operation_id: uuidv7(baseTime, ++sequence), inputs });
      const receiptIdentity = (input: MutationEnvelope): ReceiptIdentity => ({ app: APP, owner: team.team_id,
        principal: member.membership.user_id, operation: asOperation(input.operation), operationId: asOperationId(input.operation_id) });
      const invoke = (input: MutationEnvelope) => invoker.invokeMutation(input, member.identity);
      const unchanged = async (before: Awaited<ReturnType<typeof resources>>) => assert.deepEqual(await resources(), before);
      async function rejectedWithoutEffects(input: MutationEnvelope) {
        const before = await resources(), revision = await store.readRevision(), count = batches.length;
        const outcome = await invoke(input); assert.ok('error' in outcome, JSON.stringify(outcome)); assert.equal(outcome.error.code, 'rule_failed', JSON.stringify(outcome));
        const receipt = await store.readReceipt(receiptIdentity(input)); assert.ok(receipt);
        assert.equal(receipt.outcome.status, 'rejected'); assert.equal(receipt.committedRevision, revision + 1);
        assert.equal(Object.hasOwn(receipt.outcome, 'scenario'), false, 'failed branches never retain a successful model/query result');
        const after = await resources(); assert.deepEqual(after.identity, before.identity);
        for (const table of Object.keys(before.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) {
          assert.deepEqual(after.owner[table], before.owner[table], table);
        }
        for (const batch of batches.slice(count)) {
          assert.deepEqual(batch.writes, []); assert.deepEqual(batch.history, []);
          assert.deepEqual(batch.outbox, []); assert.deepEqual(batch.schedules, []);
        }
        const replay = await invoke(input); assert.ok('error' in replay); assert.equal(replay.error.code, 'rule_failed');
        await unchanged(after);
      }

      now = baseTime + 10;
      const input = envelope({ source: 'delivery-A', accepted: '2' });
      const revision = await store.readRevision(), count = batches.length;
      const result = committed(await invoke(input));
      assert.equal(batches.length, count + 1); const batch = batches.at(-1)!;
      assert.equal(batch.expectedRevision, revision); assert.equal(batch.writes.length, 1);
      assert.equal(batch.writes[0]!.kind, 'insert'); assert.equal(batch.writes[0]!.model, RECEIPT);
      assert.equal(batch.history.length, 1); assert.deepEqual(batch.outbox, []); assert.deepEqual(batch.schedules, []);
      const row = await store.load(RECEIPT, asId(result.id)); assert.ok(row);
      assert.deepEqual(row.data, { source: 'delivery-A', accepted: '2' });
      assert.equal(row.created, baseTime + 10); assert.equal(row.createdBy, member.membership.user_id);
      assert.equal(batch.history[0]!.recordId, row.id); assert.equal(batch.history[0]!.operation, `${APP}.receive`);
      const physical = await store.readReceipt(receiptIdentity(input)); assert.ok(physical);
      assert.equal(physical.inputHash, await hashInputs(input.inputs));
      const association = readScenarioReceiptAssociation(physical); assert.ok(association);
      assert.deepEqual(association.plan, plan);
      assert.deepEqual(association.changed.map(change => [change.model, change.row.id]), [[RECEIPT, row.id]]);
      const [saved] = association.queries ?? []; assert.ok(saved);
      assert.equal(saved.queryId, query.id); assert.equal(saved.revision, revision);
      assert.deepEqual(saved.candidates, [], 'create runs its query against the empty domain');
      assert.deepEqual(saved.selectedIndices, []);
      const after = await resources(); assert.deepEqual(after.identity, (await resources()).identity);
      for (const dedicated of [false, true]) {
        const replay = committed(await (dedicated ? invoker.invokeRetainedMutation(input, member.identity) : invoke(input)), 'replayed');
        assert.equal(replay.id, row.id); assert.deepEqual(replay.outcome.records, result.outcome.records);
        await unchanged(after); assert.equal(batches.length, count + 1);
        assert.deepEqual(await store.readReceipt(receiptIdentity(input)), physical);
      }

      // The true idempotent replay branch: a fresh operation with the same
      // business key executes, finds the row first by id order, and returns
      // the SAME record with no duplicate writes, history or disclosures.
      now = baseTime + 20;
      const again = envelope({ source: 'delivery-A', accepted: '2' });
      const beforeAgain = await resources(), againCount = batches.length, againRevision = await store.readRevision();
      const outcomeAgain = await invoke(again);
      assert.ok('result' in outcomeAgain, JSON.stringify(outcomeAgain));
      assert.equal(outcomeAgain.result.status, 'committed');
      assert.equal(object(outcomeAgain.result.result).id, row.id);
      assert.deepEqual(outcomeAgain.result.records, []);
      for (const effect of batches.slice(againCount)) {
        assert.deepEqual(effect.writes, []); assert.deepEqual(effect.history, []);
        assert.deepEqual(effect.outbox, []); assert.deepEqual(effect.schedules, []);
      }
      const rowAgain = await store.load(RECEIPT, asId(row.id)); assert.ok(rowAgain);
      assert.equal(rowAgain.version, 1);
      assert.deepEqual(rowAgain.data, { source: 'delivery-A', accepted: '2' });
      const physicalAgain = await store.readReceipt({ app: APP, owner: team.team_id,
        principal: member.membership.user_id, operation: asOperation(again.operation), operationId: asOperationId(again.operation_id) });
      assert.ok(physicalAgain);
      assert.equal(physicalAgain.inputHash, await hashInputs(again.inputs));
      assert.equal(physicalAgain.committedRevision, againRevision + 1);
      const associationAgain = readScenarioReceiptAssociation(physicalAgain); assert.ok(associationAgain);
      assert.deepEqual(associationAgain.plan, plan);
      assert.deepEqual(associationAgain.changed, []);
      const [savedAgain] = associationAgain.queries ?? []; assert.ok(savedAgain);
      assert.equal(savedAgain.queryId, query.id);
      assert.equal(savedAgain.candidates.length, 1);
      assert.equal(savedAgain.candidates[0]!.row.id, row.id);
      assert.equal(savedAgain.candidates[0]!.matched, true);
      assert.deepEqual(savedAgain.candidates[0]!.dependencies, [query.dependencies[0]!.id]);
      assert.deepEqual(savedAgain.selectedIndices, [0]);
      const afterAgain = await resources(); assert.deepEqual(afterAgain.identity, beforeAgain.identity);
      for (const table of Object.keys(beforeAgain.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) {
        assert.deepEqual(afterAgain.owner[table], beforeAgain.owner[table], table);
      }
      const retainedAgain = committed(await invoker.invokeRetainedMutation(again, member.identity), 'replayed');
      assert.equal(retainedAgain.id, row.id);
      await unchanged(afterAgain);

      // A conflicting replay (same source, different evidence) fails its
      // authored require without effects, and stays failed on retry.
      await rejectedWithoutEffects(envelope({ source: 'delivery-A', accepted: '3' }));
      // A stranger without membership is denied before any observation.
      {
        const denied = envelope({ source: 'delivery-A', accepted: '2' });
        const before = await resources();
        const outcome = await invoker.invokeMutation(denied, outsiderIdentity);
        assert.ok('error' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.error.code, 'forbidden', JSON.stringify(outcome));
        await unchanged(before);
      }
      // A fellow member sees the same row through the same replay branch.
      {
        const seen = envelope({ source: 'delivery-A', accepted: '2' });
        const outcome = await invoker.invokeMutation(seen, colleague.identity);
        assert.ok('result' in outcome, JSON.stringify(outcome));
        assert.equal(outcome.result.status, 'committed');
        assert.equal(object(outcome.result.result).id, row.id);
        const rerow = await store.load(RECEIPT, asId(row.id)); assert.ok(rerow);
        assert.equal(rerow.version, 1);
      }

      const independentDefinition = object(object(definition.operations)[`${APP}.receive`]);
      const firstMetadata = (independentDefinition.queryFirst as Array<Record<string, unknown>>)[0]!;
      for (const key of ['queryId', 'query', 'node', 'statement'] as const) {
        const previous = firstMetadata[key];
        firstMetadata[key] = key === 'queryId' ? 'foreign-query' : { ...object(previous), start: Number(object(previous).start) + 1 };
        const before = await resources(), batchCount = batches.length;
        const malformed = envelope({ source: 'delivery-A', accepted: '2' });
        let refused: unknown;
        try {
          const fresh = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs });
          const outcome = await fresh.invokeMutation(malformed, member.identity);
          if ('error' in outcome) refused = outcome.error;
        } catch (error) { refused = error; }
        finally { firstMetadata[key] = previous; }
        assert.ok(refused, `substituted ${key} must refuse`);
        assert.match(String(object(refused).message), /[Ff]irst|checked Let/);
        if (key === 'node' || key === 'statement') {
          const rejected = await store.readReceipt({ app: APP, owner: team.team_id,
            principal: member.membership.user_id, operation: asOperation(malformed.operation), operationId: asOperationId(malformed.operation_id) });
          assert.ok(rejected);
          assert.equal(rejected.outcome.status, 'rejected');
          assert.equal(object(rejected.outcome).code, 'validation');
          assert.match(String(object(rejected.outcome).message), /first consumer differs/);
          const afterTamper = await resources(); assert.deepEqual(afterTamper.identity, before.identity);
          for (const table of Object.keys(before.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) {
            assert.deepEqual(afterTamper.owner[table], before.owner[table], table);
          }
          for (const effect of batches.slice(batchCount)) {
            assert.deepEqual(effect.writes, []); assert.deepEqual(effect.history, []);
            assert.deepEqual(effect.outbox, []); assert.deepEqual(effect.schedules, []);
          }
        } else await unchanged(before);
      }

      // Revoking membership withholds the saved model result on fresh reads
      // while the stored receipt stays intact; restoring replays it again.
      await identities.removeMembership(member.membership.membership_id);
      const membershipRevoked = await resources(), membershipCount = batches.length;
      const withheld = await invoke(input); assert.ok('result' in withheld); assert.equal(withheld.result.status, 'replayed');
      assert.equal(withheld.result.result, null); assert.deepEqual(withheld.result.records, []);
      const retainedDenied = await invoker.invokeRetainedMutation(input, member.identity);
      assert.ok('error' in retainedDenied); assert.equal(retainedDenied.error.code, 'forbidden');
      await unchanged(membershipRevoked); assert.equal(batches.length, membershipCount);
      await identities.reactivateMembership(member.membership.membership_id, { is_owner: false, roles: [] });
      const restored = await member.current(), restoredResources = await resources();
      assert.equal(committed(await invoker.invokeRetainedMutation(input, restored), 'replayed').id, row.id);
      await unchanged(restoredResources); assert.deepEqual(await store.readReceipt(receiptIdentity(input)), physical);

      assert.deepEqual(await readFile(fixtureSourcePath), originalSource);
      for (const module of moduleBytes) assert.deepEqual(await readFile(module.path), module.bytes);
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
      assert.equal(createHash('sha256').update(originalSource).digest('hex'), artifact.sources.find(source => resolve(source.path) === fixtureSourcePath)!.sha256);
    } finally {
      await worker?.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });
