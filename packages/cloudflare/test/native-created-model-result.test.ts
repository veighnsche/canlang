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
      const operations = ['ask', 'regenerate', 'retain'].map(name => {
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
      const existing = retained[0]!, referenceInput = envelope('retain', { run: { id: existing.id, version: '1' } });
      const referenceBefore = await resources(), referenceRevision = await store.readRevision(), referenceBatches = batches.length;
      const referenceResult = committed(await invoker.invokeMutation(referenceInput, member.identity));
      assert.equal(referenceResult.id, existing.id); assert.deepEqual(referenceResult.outcome.records, []);
      assert.equal(batches.length, referenceBatches + 1);
      const referenceBatch = batches.at(-1)!;
      assert.deepEqual(referenceBatch.writes, []); assert.deepEqual(referenceBatch.history, []);
      assert.deepEqual(referenceBatch.outbox, []); assert.deepEqual(referenceBatch.schedules, []);
      const referenceReceipt = await store.readReceipt(receiptIdentity(referenceInput)); assert.ok(referenceReceipt);
      const referenceAssociation = readScenarioReceiptAssociation(referenceReceipt); assert.ok(referenceAssociation);
      assert.equal(referenceAssociation.resultType, MODEL); assert.deepEqual(referenceAssociation.changed, []);
      assert.equal(referenceAssociation.observations.length, 1);
      const witness = referenceAssociation.observations[0]!;
      assert.equal(witness.model, MODEL); assert.equal(witness.row.id, existing.id);
      assert.ok(referenceAssociation.plan.returns.some(returned => returned.dependencies.some(dependency =>
        dependency.id === witness.dependencyId && dependency.role === 'data' && dependency.model === MODEL &&
        dependency.field === 'id' && dependency.type === 'text')));
      const referenceAfter = await resources();
      assert.deepEqual(referenceAfter.identity, referenceBefore.identity); assert.deepEqual(referenceAfter.foreign, referenceBefore.foreign);
      for (const table of ['records', 'history', 'outbox', 'schedules']) {
        assert.deepEqual(referenceAfter.owner[table], referenceBefore.owner[table], table);
      }
      assert.equal(await store.readRevision(), referenceRevision + 1);
      for (const dedicated of [false, true]) {
        const replay = committed(await (dedicated ? invoker.invokeRetainedMutation(referenceInput, member.identity) :
          invoker.invokeMutation(referenceInput, member.identity)), 'replayed');
        assert.equal(replay.id, existing.id); assert.deepEqual(replay.outcome.records, []);
        assert.deepEqual(await resources(), referenceAfter); assert.equal(batches.length, referenceBatches + 1);
        assert.deepEqual(await store.readReceipt(receiptIdentity(referenceInput)), referenceReceipt);
      }
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
      const referenceWithheld = await invoker.invokeMutation(referenceInput, member.identity);
      assert.ok('result' in referenceWithheld, JSON.stringify(referenceWithheld));
      assert.equal(referenceWithheld.result.status, 'replayed');
      assert.equal(referenceWithheld.result.result, null); assert.deepEqual(referenceWithheld.result.records, []);
      const currentRead = await invoker.invokeRead({ operation: `${MODEL}.read`, inputs: {} }, member.identity);
      assert.ok('result' in currentRead, JSON.stringify(currentRead)); assert.deepEqual(object(currentRead.result).records, []);
      const refused = await invoker.invokeRetainedMutation(saved.envelope, member.identity);
      assert.ok('error' in refused, JSON.stringify(refused)); assert.equal(refused.error.code, 'forbidden');
      assert.deepEqual(await resources(), revoked); assert.deepEqual(await store.readReceipt(receiptIdentity(saved.envelope)), physical);
      await identities.reactivateMembership(member.membership.membership_id, { is_owner: false, roles: [] });
      const restored = await member.current(), restoredResources = await resources();
      assert.equal(committed(await invoker.invokeRetainedMutation(saved.envelope, restored), 'replayed').id, saved.id);
      assert.equal(committed(await invoker.invokeRetainedMutation(referenceInput, restored), 'replayed').id, existing.id);
      assert.deepEqual(await resources(), restoredResources);
      // The source exports no c/native view. Raw, copied, foreign-frame and
      // closed-frame binder attacks remain State's
      // defining controls; this native case does not fabricate those handles.
      assert.deepEqual(await readFile(sourcePath), originalSource);
      assert.equal(JSON.stringify(artifact), originalArtifact);
      assert.equal(await captureIsCurrent(capture), true);
      assert.equal(createHash('sha256').update(originalSource).digest('hex'), artifact.sources.find(source => resolve(source.path) === sourcePath)!.sha256);
    } finally {
      await worker?.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });

test('created model with absent nullable contract field stores null, omits it from projection and replays without duplicates',
  { timeout: 120000 }, async () => {
    const MEMO = asModel(`${APP}.Memo`);
    const directory = await mkdtemp(join(tmpdir(), 'can-native-created-contract-field-'));
    let worker: Miniflare | undefined;
    let capture: Awaited<ReturnType<typeof import('../src/dev/source-capture.js')['captureSingleFileSource']>> | undefined;
    try {
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
      if (compiled.kind !== 'artifact') throw new Error('Contract-field CREATED source did not compile');
      const artifact: CompileArtifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      const operation = artifact.operations?.find(candidate => candidate.name === `${APP}.jot`); assert.ok(operation);
      assert.equal(operation.kind, 'scenario'); assert.equal(operation.result?.type, MEMO);
      assert.ok(operation.result?.disclosure);
      const callable = artifact.callables.find(callable => callable.id === operation.name); assert.ok(callable);
      const generated = artifact.modules.find(module => module.path === callable.module); assert.ok(generated);
      assert.match(generated.js, /await bindScenarioReceiptModelResult\(c,/);
      const asm = await assembleModules({ artifact, sourcePath }, { workDir: join(directory, 'modules'),
        stdlibUrl: installed('runtime/stdlib.js') });
      const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact));
      assert.equal(namespace[callable.export], operation.name);
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'created-memo-identity', OWNER: 'created-memo-owner' },
        d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const now = Date.now(), clock = { nowMs: () => now };
      const identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      async function actor(email: string) {
        const user = await identities.createUser({ email, password_hash: 'unused', email_verified: true });
        const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
        const token = `native-created-memo-${user.user_id}`;
        await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
          last_team_id: team.team_id, expires_at: new Date(now + 3600_000).toISOString() });
        const current = () => resolveIdentity(identities, { session_token: token }, { clock });
        return { membership, identity: await current() };
      }
      const member = await actor('created-memo-member@example.test');
      const outsiderUser = await identities.createUser({ email: 'created-memo-outsider@example.test', password_hash: 'unused', email_verified: true });
      const outsiderToken = 'native-created-memo-outsider';
      await identities.createSession({ user_id: outsiderUser.user_id, token_sha256: await sha256HexText(outsiderToken),
        last_team_id: team.team_id, expires_at: new Date(now + 3600_000).toISOString() });
      const outsiderIdentity = await resolveIdentity(identities, { session_token: outsiderToken }, { clock });
      const underlying = createD1Storage(ownerDb);
      const batches: CommitBatch[] = [];
      const store: StoragePort = { ...underlying, async commit(batch) {
        const result = await underlying.commit(batch); batches.push(batch); return result; } };
      const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs });
      let sequence = 0;
      const input: MutationEnvelope = { operation: `${APP}.jot`, operation_id: uuidv7(now, ++sequence), inputs: { n: '3' } };
      const before = await store.query({ model: MEMO, authority: 'owner' });
      assert.equal(before.length, 0);
      const result = committed(await invoker.invokeMutation(input, member.identity));
      assert.equal(batches.length, 1);
      const batch = batches[0]!;
      assert.equal(batch.writes.length, 1);
      assert.equal(batch.writes[0]!.kind, 'insert'); assert.equal(batch.writes[0]!.model, MEMO);
      const row = await store.load(MEMO, result.id as Parameters<StoragePort['load']>[1]); assert.ok(row);
      const storedData = object(row.data);
      assert.equal(storedData.count, '3');
      // Storage persists the absent nullable contract field as explicit
      // null; the emitted projection omits it. Both views agree the field
      // has no value; unifying the two encodings is a separate runtime
      // representation question, not this admission batch.
      assert.strictEqual(storedData.held, null, `storage null held, got ${JSON.stringify(row.data)}`);
      assert.deepEqual(batch.history[0]!.after, row.data);
      const projected = object(result.outcome.records![0]);
      const projectedData = object(projected.data);
      assert.equal(projected.id, row.id);
      assert.equal(projectedData.count, '3');
      assert.ok(!('held' in projectedData), `projection omits null held, got ${JSON.stringify(projected.data)}`);
      const association = readScenarioReceiptAssociation(await store.readReceipt(
        { app: APP, owner: team.team_id, principal: member.membership.user_id,
          operation: asOperation(input.operation), operationId: asOperationId(input.operation_id) }));
      assert.ok(association);
      assert.equal(association.resultType, MEMO);
      const replayed = committed(await invoker.invokeRetainedMutation(input, member.identity), 'replayed');
      assert.equal(replayed.id, result.id);
      assert.equal((await store.query({ model: MEMO, authority: 'owner' })).length, 1);
      assert.equal(batches.length, 1);
      const denied = await invoker.invokeMutation(input, outsiderIdentity);
      assert.ok('error' in denied, JSON.stringify(denied));
      assert.equal(denied.error.code, 'forbidden');
      assert.equal((await store.query({ model: MEMO, authority: 'owner' })).length, 1);
      await identities.removeMembership(member.membership.membership_id);
      const revoked = await invoker.invokeMutation(
        { operation: `${APP}.jot`, operation_id: uuidv7(now, ++sequence), inputs: { n: '4' } }, member.identity);
      assert.ok('error' in revoked, JSON.stringify(revoked));
      assert.equal(revoked.error.code, 'forbidden');
      assert.equal((await store.query({ model: MEMO, authority: 'owner' })).length, 1);
      assert.deepEqual(await readFile(sourcePath), originalSource);
      assert.equal(JSON.stringify(artifact), originalArtifact);
      assert.equal(await captureIsCurrent(capture), true);
    } finally {
      await worker?.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });
