/** Original query-selected reference-chain result -> captured CLI -> verified module -> real D1/Identity. */
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
import { distribution } from '@canlang/values/distribution';
import type { MutationOutcome } from '../src/worker/assembly.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const APP = 'ReferenceChain', LOCATION = asModel(`${APP}.Location`), DEAL = asModel(`${APP}.Deal`), INTAKE = asModel(`${APP}.Intake`);
const sourcePath = join(root, 'packages/cloudflare/test/fixtures/native-reference-chain-result.can');
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
test('native reference-chain model returns retain source, intermediate and target evidence, no writes, and current-authority replay',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-native-reference-chain-result-'));
    let worker: Miniflare | undefined;
    let capture: Awaited<ReturnType<typeof import('../src/runtime/native-dev.test-support.js')['captureSingleFileSource']>> | undefined;
    try {
      const { assembleModules, importVerifiedAssemblyModule } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { prepareLocalPreviewCapture } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { compileCapturedSingleFile } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const originalSource = await readFile(sourcePath);
      capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root, appPath: sourcePath,
        compilerPath: join(root, 'compiler/target/debug/can'), catalogPath: fileURLToPath(distribution.catalog),
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Original reference-chain result source did not compile');
      const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      assert.equal(artifact.pages.length, 0);
      const operation = artifact.operations?.find(operation => operation.name === `${APP}.promote`); assert.ok(operation);
      assert.equal(operation.kind, 'scenario'); assert.equal(operation.result?.type, LOCATION);
      const plan = operation.result!.disclosure; assert.ok(plan);
      const [query] = plan.queries ?? []; assert.ok(query);
      assert.equal(query.model, INTAKE); assert.deepEqual(query.order, []); assert.equal(query.limit, null);
      assert.equal(query.archived, 'exclude');
      assert.ok(query.dependencies.some(dependency => dependency.role === 'control' && dependency.field === 'source' && dependency.type === 'text'));
      const returnedDependencies = plan.returns.flatMap(returned => returned.dependencies);
      const sourceDependency = returnedDependencies.find(dependency => dependency.role === 'data' && dependency.model === INTAKE && dependency.field === 'deal');
      const intermediateDependency = returnedDependencies.find(dependency => dependency.role === 'data' && dependency.model === DEAL && dependency.field === 'location');
      const targetDependency = returnedDependencies.find(dependency => dependency.role === 'data' && dependency.model === LOCATION && dependency.field === 'id' && dependency.type === 'text');
      assert.ok(sourceDependency); assert.ok(intermediateDependency); assert.ok(targetDependency);
      assert.ok(artifact.sources.some(source => source.path === plan.source.path && source.sha256 === plan.source.sha256));
      const asm = await assembleModules({ artifact, sourcePath }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
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
        d1Databases: { IDENTITY: 'reference-chain-identity', OWNER: 'reference-chain-owner' }, d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const now = Date.now(), clock = { nowMs: () => now }, identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: 'reference-chain-member@example.test', password_hash: 'unused', email_verified: true });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
      const token = `native-reference-chain-${user.user_id}`;
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(now + 3600_000).toISOString() });
      const current = () => resolveIdentity(identities, { session_token: token }, { clock });
      const identity = await current();
      const underlying = createD1Storage(ownerDb), batches: CommitBatch[] = [];
      let intakeQueries = 0;
      const store: StoragePort = { ...underlying, async query(request) {
        if (request.model === INTAKE) intakeQueries++;
        return underlying.query(request);
      }, async commit(batch) {
        const result = await underlying.commit(batch); batches.push(batch); return result;
      } };
      const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs });
      const resources = async () => ({ identity: await snapshot(identityDb), owner: await snapshot(ownerDb) });
      let sequence = 0;
      const envelope = (name: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
        operation: name.includes('.') ? name : `${APP}.${name}`, operation_id: uuidv7(now, ++sequence), inputs });
      const receiptIdentity = (input: MutationEnvelope): ReceiptIdentity => ({ app: APP, owner: team.team_id,
        principal: membership.user_id, operation: asOperation(input.operation), operationId: asOperationId(input.operation_id) });
      const promote = (source: string, accept = true) => envelope('promote', { source, accept });
      const invoke = (input: MutationEnvelope) => invoker.invokeMutation(input, identity);
      async function seed(model: typeof LOCATION, inputs: MutationEnvelope['inputs']) {
        const outcome = await invoke(envelope(`${model}.create`, inputs));
        assert.ok('result' in outcome, JSON.stringify(outcome)); assert.equal(outcome.result.status, 'committed');
        assert.equal(outcome.result.records?.length, 1);
        const projected = object(outcome.result.records![0]); assert.equal(typeof projected.id, 'string');
        const row = await store.load(model, asId(projected.id as string)); assert.ok(row); return row;
      }
      async function rejectedWithoutEffects(input: MutationEnvelope) {
        const before = await resources(), revision = await store.readRevision(), count = batches.length;
        const outcome = await invoke(input); assert.ok('error' in outcome, JSON.stringify(outcome)); assert.equal(outcome.error.code, 'rule_failed');
        assert.equal(batches.length, count + 1);
        const batch = batches.at(-1)!;
        assert.deepEqual(batch.writes, []); assert.deepEqual(batch.history, []);
        assert.deepEqual(batch.outbox, []); assert.deepEqual(batch.schedules, []);
        const receipt = await store.readReceipt(receiptIdentity(input)); assert.ok(receipt);
        assert.equal(receipt.outcome.status, 'rejected'); assert.equal(receipt.committedRevision, revision + 1);
        assert.equal(Object.hasOwn(receipt.outcome, 'scenario'), false);
        const after = await resources(); assert.deepEqual(after.identity, before.identity);
        for (const table of Object.keys(before.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) assert.deepEqual(after.owner[table], before.owner[table], table);
        const replay = await invoke(input); assert.ok('error' in replay); assert.equal(replay.error.code, 'rule_failed');
        assert.deepEqual(await resources(), after); assert.equal(batches.length, count + 1);
      }

      // The empty path stages a real create before the final guard fails.
      await rejectedWithoutEffects(promote('empty-rejected', false));
      assert.deepEqual(await store.query({ model: LOCATION, authority: 'owner' }), []);
      const freshInput = promote('fresh'), freshBefore = await resources(), freshCount = batches.length;
      const fresh = committed(await invoke(freshInput));
      assert.equal(batches.length, freshCount + 1);
      const freshBatch = batches.at(-1)!;
      assert.equal(freshBatch.writes.length, 1); assert.equal(freshBatch.writes[0]!.kind, 'insert');
      assert.equal(freshBatch.writes[0]!.model, LOCATION); assert.equal(freshBatch.history.length, 1);
      assert.deepEqual(freshBatch.outbox, []); assert.deepEqual(freshBatch.schedules, []);
      const freshRow = await store.load(LOCATION, asId(fresh.id)); assert.ok(freshRow);
      assert.deepEqual(freshRow.data, { title: 'fresh' }); assert.equal(freshRow.createdBy, membership.user_id);
      assert.equal(freshBatch.history[0]!.recordId, fresh.id); assert.equal(freshBatch.history[0]!.operation, operation.name);
      const freshReceipt = await store.readReceipt(receiptIdentity(freshInput)); assert.ok(freshReceipt);
      const freshAssociation = readScenarioReceiptAssociation(freshReceipt); assert.ok(freshAssociation);
      assert.deepEqual(freshAssociation.changed.map(change => [change.model, change.row.id]), [[LOCATION, fresh.id]]);
      const freshAfter = await resources(); assert.deepEqual(freshAfter.identity, freshBefore.identity);
      assert.equal(freshAfter.owner.records!.length, freshBefore.owner.records!.length + 1);
      assert.equal(freshAfter.owner.history!.length, freshBefore.owner.history!.length + 1);
      assert.equal(committed(await invoke(freshInput), 'replayed').id, fresh.id);
      assert.deepEqual(await resources(), freshAfter); assert.equal(batches.length, freshCount + 1);

      const location = await seed(LOCATION, { title: 'existing' });
      const deal = await seed(DEAL, { title: 'existing', location: { id: location.id, version: String(location.version) } });
      const intake = await seed(INTAKE, { source: 'existing', deal: { id: deal.id, version: String(deal.version) } });
      await rejectedWithoutEffects(promote('existing', false));
      const input = promote('existing'), before = await resources(), revision = await store.readRevision(), count = batches.length, queriesBefore = intakeQueries;
      const result = committed(await invoke(input));
      assert.equal(result.id, location.id); assert.deepEqual(result.outcome.records, []);
      assert.equal(intakeQueries, queriesBefore + 1, 'fresh execution evaluates the actual Intake query');
      assert.equal(batches.length, count + 1); assert.equal(await store.readRevision(), revision + 1);
      const batch = batches.at(-1)!;
      assert.equal(batch.expectedRevision, revision); assert.deepEqual(batch.writes, []); assert.deepEqual(batch.history, []);
      assert.deepEqual(batch.outbox, []); assert.deepEqual(batch.schedules, []);
      const physical = await store.readReceipt(receiptIdentity(input)); assert.ok(physical);
      assert.equal(physical.inputHash, await hashInputs(input.inputs)); assert.equal(physical.committedRevision, revision + 1);
      const association = readScenarioReceiptAssociation(physical); assert.ok(association);
      assert.equal(association.resultType, LOCATION); assert.deepEqual(association.plan, plan); assert.deepEqual(association.changed, []);
      const sourceWitness = association.observations.find(observation => observation.dependencyId === sourceDependency.id);
      const intermediateWitness = association.observations.find(observation => observation.dependencyId === intermediateDependency.id);
      const targetWitness = association.observations.find(observation => observation.dependencyId === targetDependency.id);
      assert.ok(sourceWitness); assert.ok(intermediateWitness); assert.ok(targetWitness);
      assert.equal(new Set([sourceWitness, intermediateWitness, targetWitness]).size, 3);
      assert.equal(sourceWitness.model, INTAKE); assert.deepEqual(sourceWitness.row, intake);
      assert.equal(intermediateWitness.model, DEAL); assert.deepEqual(intermediateWitness.row, deal);
      assert.equal(targetWitness.model, LOCATION); assert.deepEqual(targetWitness.row, location);
      const [saved] = association.queries ?? []; assert.ok(saved);
      assert.equal(saved.queryId, query.id); assert.equal(saved.revision, revision);
      assert.deepEqual(saved.selectedIndices.map(index => saved.candidates[index]!.row.id), [intake.id]);
      assert.deepEqual(saved.candidates.map(candidate => candidate.row), [intake]);
      const after = await resources(); assert.deepEqual(after.identity, before.identity);
      for (const table of ['records', 'history', 'outbox', 'schedules']) assert.deepEqual(after.owner[table], before.owner[table], table);
      assert.deepEqual(await store.load(DEAL, deal.id), deal);
      assert.deepEqual(await store.load(LOCATION, location.id), location);
      assert.equal((await store.historyFor(DEAL, deal.id)).length, 1);
      assert.equal((await store.historyFor(LOCATION, location.id)).length, 1);
      for (const dedicated of [false, true]) {
        const replay = committed(await (dedicated ? invoker.invokeRetainedMutation(input, identity) : invoke(input)), 'replayed');
        assert.equal(replay.id, location.id); assert.deepEqual(replay.outcome.records, []);
        assert.deepEqual(await resources(), after); assert.equal(batches.length, count + 1);
        assert.equal(intakeQueries, queriesBefore + 1, 'receipt recovery never executes the scenario query');
        assert.deepEqual(await store.readReceipt(receiptIdentity(input)), physical);
      }

      await identities.removeMembership(membership.membership_id);
      const revoked = await resources(), revokedCount = batches.length;
      const withheld = await invoke(input); assert.ok('result' in withheld); assert.equal(withheld.result.status, 'replayed');
      assert.equal(withheld.result.result, null); assert.deepEqual(withheld.result.records, []);
      const denied = await invoker.invokeRetainedMutation(input, identity);
      assert.ok('error' in denied); assert.equal(denied.error.code, 'forbidden');
      assert.deepEqual(await resources(), revoked); assert.equal(batches.length, revokedCount);
      await identities.reactivateMembership(membership.membership_id, { is_owner: false, roles: [] });
      const restored = await current(), restoredResources = await resources();
      assert.equal(committed(await invoker.invokeRetainedMutation(input, restored), 'replayed').id, location.id);
      assert.deepEqual(await resources(), restoredResources); assert.equal(batches.length, revokedCount);
      assert.deepEqual(await store.readReceipt(receiptIdentity(input)), physical);
      assert.deepEqual(await readFile(sourcePath), originalSource);
      for (const module of moduleBytes) assert.deepEqual(await readFile(module.path), module.bytes);
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
      assert.equal(createHash('sha256').update(originalSource).digest('hex'), artifact.sources.find(source => resolve(source.path) === sourcePath)!.sha256);
    } finally {
      await worker?.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });
