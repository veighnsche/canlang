/** Actual original CREATED source -> captured CLI -> verified native factory -> D1.
 * This finite default-root Create/CALL result profile has no page or contained create.
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
import { asModel, asOperation, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { distribution } from '@canlang/values/distribution';
import type { MutationOutcome } from '../src/worker/assembly.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const APP = 'CreatedRun', MODEL = asModel(`${APP}.Run`), OTHER = asModel(`${APP}.Other`);
const sourcePath = join(root, 'packages/cloudflare/test/fixtures/native-created-model-result.can');
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
  assert.ok(Array.isArray(outcome.result.records));
  return { outcome: outcome.result, id: wire.id as string };
}

test('captured native default Create and direct child model returns retain one D1 owner effect and current-authority replay',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-native-created-model-result-'));
    let worker: Miniflare | undefined;
    let capture: Awaited<ReturnType<typeof import('../src/dev/source-capture.js')['captureSingleFileSource']>> | undefined;
    try {
      // Native installed modules own their genuine default-loader capability
      // and registry instances; Vitest never interprets the generated modules.
      const { assembleModules, importVerifiedAssemblyModule } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { prepareLocalPreviewCapture } = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
      const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
      const { compileCapturedSingleFile } = await nodeImport(installed('dev/compiler-check.js')) as typeof import('../src/dev/compiler-check.js');
      const originalSource = await readFile(sourcePath);
      capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root, appPath: sourcePath,
        compilerPath: join(root, 'compiler/target/debug/can'), catalogPath: fileURLToPath(distribution.catalog),
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Original CREATED source did not compile');
      const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      assert.equal(artifact.pages.length, 0);
      const run = artifact.models?.find(model => model.name === MODEL); assert.ok(run);
      assert.equal(run.parent, undefined); assert.equal(run.deleteMode, 'remove');
      assert.deepEqual(run.fields.map(field => field.name), ['count']);
      const operations = ['ask', 'regenerate'].map(name => {
        const operation = artifact.operations?.find(operation => operation.name === `${APP}.${name}`); assert.ok(operation);
        assert.equal(operation.kind, 'scenario'); assert.equal(operation.result?.type, MODEL);
        assert.ok(operation.result?.disclosure); return operation;
      });
      const asm = await assembleModules({ artifact, sourcePath }, { workDir: join(directory, 'modules'),
        stdlibUrl: installed('runtime/stdlib.js') });
      for (const operation of operations) {
        const callable = artifact.callables.find(callable => callable.id === operation.name); assert.ok(callable);
        const generated = artifact.modules.find(module => module.path === callable.module); assert.ok(generated);
        // Require the genuine emitted binder before selection; no artifact or
        // handler rewrite supplies it.
        assert.match(generated.js, /await bindScenarioReceiptModelResult\(c,/);
        const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact));
        assert.equal(namespace[callable.export], operation.name);
        const definition = object(namespace.appDefinition); assert.equal(definition.id, APP);
        assert.equal(object(object(definition.operations)[operation.name]).handler, operation.name);
        const plan = operation.result!.disclosure!;
        assert.ok(artifact.sources.some(source => source.path === plan.source.path && source.sha256 === plan.source.sha256));
      }
      const parentCallable = artifact.callables.find(callable => callable.id === `${APP}.regenerate`)!;
      const namespace = object(await importVerifiedAssemblyModule(asm, parentCallable.module, artifact));
      const declaration = object(object(object(namespace.appDefinition).operations)[`${APP}.regenerate`]);
      assert.ok(Array.isArray(declaration.callSites)); assert.equal(declaration.callSites.length, 1);
      const callSite = object(declaration.callSites[0]);
      assert.deepEqual(callSite.targets, [`${APP}.ask`]); assert.equal(callSite.resultType, MODEL);
      assert.equal(typeof callSite.id, 'string');

      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'created-run-identity', OWNER: 'created-run-owner', FOREIGN: 'created-run-foreign' },
        d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      const foreignDb = await worker.getD1Database('FOREIGN') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb); await ensureSchema(foreignDb);
      const now = Date.now(), clock = { nowMs: () => now };
      const identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const foreignTeam = await identities.createTeam({ timezone: 'UTC' });
      async function actor(email: string, selected: typeof team) {
        const user = await identities.createUser({ email, password_hash: 'unused', email_verified: true });
        const membership = await identities.createMembership({ team_id: selected.team_id, user_id: user.user_id, is_owner: false, roles: [] });
        const token = `native-created-run-${user.user_id}`;
        await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
          last_team_id: selected.team_id, expires_at: new Date(now + 3600_000).toISOString() });
        const current = () => resolveIdentity(identities, { session_token: token }, { clock });
        return { membership, current, identity: await current() };
      }
      const member = await actor('created-run-member@example.test', team);
      const colleague = await actor('created-run-colleague@example.test', team);
      const foreign = await actor('created-run-foreign@example.test', foreignTeam);
      assert.equal(member.identity.actor?.user_id, member.membership.user_id);
      assert.equal(member.identity.team?.team_id, team.team_id);
      const underlying = createD1Storage(ownerDb), foreignStore = createD1Storage(foreignDb);
      const batches: CommitBatch[] = [];
      const store: StoragePort = { ...underlying, async commit(batch) {
        const result = await underlying.commit(batch); batches.push(batch); return result;
      } };
      const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs });
      const foreignInvoker = buildInvoker(artifact, asm, foreignStore, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs });
      const resources = async () => ({ identity: await snapshot(identityDb), owner: await snapshot(ownerDb), foreign: await snapshot(foreignDb) });
      let sequence = 0;
      const envelope = (name: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
        operation: `${APP}.${name}`, operation_id: uuidv7(now, ++sequence), inputs });
      const receiptIdentity = (input: MutationEnvelope): ReceiptIdentity => ({ app: APP, owner: team.team_id,
        principal: member.membership.user_id, operation: asOperation(input.operation), operationId: asOperationId(input.operation_id) });
      const changedTables = new Set(['records', 'history', 'receipts', 'fence', 'fence_log', 'sqlite_sequence']);
      const retained: Array<{ envelope: MutationEnvelope; id: string }> = [];
      for (const input of [envelope('ask', { value: '7', note: 'root' }), envelope('regenerate', { value: '8' })]) {
        const before = await resources(), revision = await store.readRevision(), count = batches.length;
        const result = committed(await invoker.invokeMutation(input, member.identity));
        retained.push({ envelope: input, id: result.id });
        assert.equal(batches.length, count + 1); assert.equal(await store.readRevision(), revision + 1);
        const batch = batches.at(-1)!;
        assert.equal(batch.expectedRevision, revision); assert.equal(batch.writes.length, 1);
        assert.ok(batch.receipt); assert.deepEqual(batch.receipt.identity, receiptIdentity(input));
        assert.equal(batch.writes[0]!.kind, 'insert'); assert.equal(batch.writes[0]!.model, MODEL);
        assert.equal(batch.history.length, 1); assert.deepEqual(batch.outbox, []); assert.deepEqual(batch.schedules, []);
        const row = await store.load(MODEL, result.id as Parameters<StoragePort['load']>[1]); assert.ok(row);
        assert.equal(row.version, 1); assert.equal(row.parent ?? null, null); assert.deepEqual(row.data, { count: '0' });
        assert.equal(row.createdBy, member.membership.user_id); assert.equal(row.created, now);
        assert.equal(batch.history[0]!.recordId, row.id); assert.equal(batch.history[0]!.change, 'create');
        assert.deepEqual(batch.history[0]!.after, row.data); assert.equal(batch.history[0]!.before, null);
        assert.equal(batch.history[0]!.operationId, input.operation_id);
        assert.equal(batch.history[0]!.operation, `${APP}.ask`);
        assert.equal(result.outcome.records!.length, 1);
        const projected = object(result.outcome.records![0]);
        assert.equal(projected.id, row.id); assert.deepEqual(projected.data, row.data);
        const physical = await store.readReceipt(receiptIdentity(input)); assert.ok(physical);
        assert.equal(physical.inputHash, await hashInputs(input.inputs)); assert.equal(physical.committedRevision, revision + 1);
        const association = readScenarioReceiptAssociation(physical); assert.ok(association);
        assert.equal(association.resultType, MODEL);
        assert.deepEqual(association.plan, operations.find(operation => operation.name === input.operation)!.result!.disclosure);
        assert.deepEqual(association.changed.map(change => [change.model, change.row.id]), [[MODEL, row.id]]);
        assert.deepEqual(association.changed[0]!.row, row);
        if (input.operation.endsWith('.regenerate')) {
          assert.equal(association.calls?.length, 1); const child = association.calls![0]!;
          assert.equal(child.site, callSite.id); assert.equal(child.caller, input.operation); assert.equal(child.target, `${APP}.ask`);
          assert.deepEqual(child.result, { id: row.id }); assert.ok(child.scenario);
          assert.equal(child.scenario.resultType, MODEL); assert.deepEqual(child.scenario.plan, operations[0]!.result!.disclosure);
        } else assert.equal(association.calls?.length ?? 0, 0);
        const after = await resources();
        assert.deepEqual(after.identity, before.identity); assert.deepEqual(after.foreign, before.foreign);
        for (const table of Object.keys(before.owner)) if (!changedTables.has(table)) assert.deepEqual(after.owner[table], before.owner[table], table);
        assert.equal(after.owner.history!.length, before.owner.history!.length + 1);
        assert.equal(after.owner.fence_log!.length, before.owner.fence_log!.length + 1);
        assert.equal(after.owner.receipts!.length, before.owner.receipts!.length + 1);
        for (const dedicated of [false, true]) {
          const replay = committed(await (dedicated ? invoker.invokeRetainedMutation(input, member.identity) : invoker.invokeMutation(input, member.identity)), 'replayed');
          assert.equal(replay.id, row.id); assert.deepEqual(replay.outcome.records, result.outcome.records);
          assert.deepEqual(await resources(), after); assert.equal(batches.length, count + 1);
          assert.deepEqual(await store.readReceipt(receiptIdentity(input)), physical);
        }
      }
      assert.equal((await store.query({ model: MODEL, authority: 'owner' })).length, 2);
      assert.deepEqual(await store.query({ model: OTHER, authority: 'owner' }), []);
      const saved = retained[1]!, stable = await resources();
      for (const [selected, identity] of [[invoker, colleague.identity], [foreignInvoker, foreign.identity]] as const) {
        const denied = await selected.invokeRetainedMutation(saved.envelope, identity);
        assert.ok('error' in denied, JSON.stringify(denied)); assert.equal(denied.error.code, 'not_found');
        assert.deepEqual(await resources(), stable, 'foreign principal/physical owner cannot disclose or rerun this receipt');
      }
      await identities.removeMembership(member.membership.membership_id);
      const revoked = await resources(), physical = await store.readReceipt(receiptIdentity(saved.envelope));
      const withheld = await invoker.invokeMutation(saved.envelope, member.identity);
      assert.ok('result' in withheld, JSON.stringify(withheld)); assert.equal(withheld.result.status, 'replayed');
      assert.equal(withheld.result.result, null); assert.deepEqual(withheld.result.records, []);
      const currentRead = await invoker.invokeRead({ operation: `${MODEL}.read`, inputs: {} }, member.identity);
      assert.ok('result' in currentRead, JSON.stringify(currentRead)); assert.deepEqual(object(currentRead.result).records, []);
      const refused = await invoker.invokeRetainedMutation(saved.envelope, member.identity);
      assert.ok('error' in refused, JSON.stringify(refused)); assert.equal(refused.error.code, 'forbidden');
      assert.deepEqual(await resources(), revoked); assert.deepEqual(await store.readReceipt(receiptIdentity(saved.envelope)), physical);
      await identities.reactivateMembership(member.membership.membership_id, { is_owner: false, roles: [] });
      const restored = await member.current(), restoredResources = await resources();
      assert.equal(committed(await invoker.invokeRetainedMutation(saved.envelope, restored), 'replayed').id, saved.id);
      assert.deepEqual(await resources(), restoredResources);
      // The original source has no model input or exported c/native view. Raw,
      // copied, foreign-frame and closed-frame binder attacks remain State's
      // defining controls; this native case does not fabricate those handles.
      assert.deepEqual(await readFile(sourcePath), originalSource);
      assert.equal(JSON.stringify(artifact), originalArtifact);
      assert.equal(await captureIsCurrent(capture), true);
      assert.equal(createHash('sha256').update(originalSource).digest('hex'), artifact.sources.find(source => resolve(source.path) === sourcePath)!.sha256);
    } finally {
      await worker?.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });
