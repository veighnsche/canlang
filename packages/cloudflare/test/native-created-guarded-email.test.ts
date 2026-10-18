/** Native control for the original bounded created-model + guarded SEND fixture. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, ModelName, MutationEnvelope, ProviderBinding, ReceiptIdentity } from '@canlang/contracts';
import type { InstalledMailSender } from '@canlang/services';
import { originalScenarioSource } from '../src/runtime/original-source.testing.js';
import type { SqliteFileStore } from '@canlang/files/host/sqlite';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const APP = 'CreatedGuardedEmail', MODEL = `${APP}.Entry` as ModelName, OP = `${APP}.deliver`;
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const nodeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
async function snapshot(db: D1Database) {
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name: string}>();
  assert.equal(names.success, true);
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const {name} of names.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true); result[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}

test('original populated Create, two Sets and guarded Email retain the same model result and late rollback',
 {timeout: 120000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-native-created-guarded-email-'));
  let worker: Miniflare | undefined, physical: SqliteFileStore | undefined;
  let sequence = 0, now = Date.now(); const clock = {nowMs: () => now};
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/send');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { const part = Buffer.from(chunk); bytes += part.length; assert.ok(bytes <= 16384); chunks.push(part); }
      const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      assert.deepEqual(Object.keys(body).sort(), ['attachments', 'body', 'delivery_id', 'subject', 'to']);
      assert.equal(body.to, 'recipient@example.test'); assert.equal(body.subject, 'Created guarded Email');
      assert.equal(body.body, 'Original request'); assert.deepEqual(body.attachments, []);
      assert.equal(request.headers['idempotency-key'], body.delivery_id); requests.push(body);
      response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({reference: `accepted-${body.delivery_id}`}));
    } catch (error) { response.writeHead(500); response.end(); server.emit('controlFailure', error); }
  });
  let providerFailure: unknown; server.on('controlFailure', error => {providerFailure = error;});
  try {
    const require = createRequire(import.meta.url);
    // One installed default loader owns all private producer and consumer authority.
    const {createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity} = await nodeImport(pathToFileURL(require.resolve('@canlang/identity')).href) as typeof import('@canlang/identity');
    const {createD1Storage, ensureSchema} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/storage/d1')).href) as typeof import('@canlang/state/storage/d1');
    const {asId, asModel, asOperation, asOperationId, uuidv7} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/testing/invocation/fixtures')).href) as typeof import('@canlang/state/testing/invocation/fixtures');
    const {RECEIPT_MODEL, RECEIPT_ASSOCIATION_MODEL, readReceiptRow, readAssociationRow} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/receipt/tables')).href) as typeof import('@canlang/state/receipt/tables');
    const {readScenarioReceiptAssociation} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/invocation')).href) as typeof import('@canlang/state/invocation');
    const {hashInputs} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/invocation/replay')).href) as typeof import('@canlang/state/invocation/replay');
    const {createSqliteFileStore} = await nodeImport(pathToFileURL(require.resolve('@canlang/files/host/sqlite')).href) as typeof import('@canlang/files/host/sqlite');
    const {WORK_DISPATCH_MODEL, readDispatchRow} = await nodeImport(pathToFileURL(require.resolve('@canlang/work/kernel/tables')).href) as typeof import('@canlang/work/kernel/tables');
    const nextId = () => asOperationId(uuidv7(now, ++sequence));
    const {distribution} = await nodeImport(pathToFileURL(require.resolve('@canlang/values/distribution')).href) as typeof import('@canlang/values/distribution');
    const {assembleModules, importVerifiedAssemblyModule} = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const {buildInvoker} = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
    const {prepareLocalPreviewCapture} = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
    const {captureSingleFileSource, captureIsCurrent, verifyCompilerSources} = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
    const {createNativeFileRetirementBinding} = await nodeImport(installed('runtime/file-retirement.js')) as typeof import('../src/runtime/file-retirement.js');
    const {bindNativeEmailDispatchGuards} = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
    const {createBoundMailAdapter} = await nodeImport(installed('runtime/bound-mail.js')) as typeof import('../src/runtime/bound-mail.js');
    const {createBoundMailDispatcher} = await nodeImport(installed('runtime/bound-dispatch.js')) as typeof import('../src/runtime/bound-dispatch.js');
    const {EmailV1Adapter} = await nodeImport(pathToFileURL(require.resolve('@canlang/services/mail/adapter')).href) as typeof import('@canlang/services/mail/adapter');
    const {WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand} = await nodeImport(pathToFileURL(require.resolve('@canlang/work/kernel/commands')).href) as typeof import('@canlang/work/kernel/commands');
    const {classifyFailure} = await nodeImport(pathToFileURL(require.resolve('@canlang/work/receipt')).href) as typeof import('@canlang/work/receipt');
    // The original import is outside the can-dev first-slice profile. Capture
    // its locked inputs, then invoke the authentic CLI without that unrelated profile gate.
    const source = join(root, 'compiler/tests/fixtures/native-created-guarded-email.can');
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
    const paths = [source, compiler, catalog], originals = await Promise.all(paths.map(path => readFile(path)));
    const capture = await captureSingleFileSource(prepareLocalPreviewCapture({checkoutRoot: root, appPath: source, compilerPath: compiler,
      catalogPath: catalog, helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md')}));
    assert.equal(await captureIsCurrent(capture), true);
    const env = {...process.env}; delete env.CAN_CATALOG;
    const {stdout} = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, capture.compilerOperand],
      {cwd: capture.root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024});
    assert.equal(await captureIsCurrent(capture), true);
    const artifact = JSON.parse(stdout) as CompileArtifact, originalArtifact = JSON.stringify(artifact);
    assert.equal(verifyCompilerSources(capture, {complete: true, sources: artifact.sources}).ok, true);
    const operation = artifact.operations?.find(operation => operation.name === OP); assert.ok(operation?.result?.disclosure);
    assert.equal(operation.result.type, MODEL); assert.equal(artifact.pages.length, 0);
    assert.deepEqual(artifact.operations?.filter(operation => operation.name.startsWith(`${MODEL}.`)).map(operation => operation.name), [`${MODEL}.read`]);
    const asm = await assembleModules({artifact, sourcePath: source}, {workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js'),
      uiUrl: pathToFileURL(require.resolve('@canlang/ui')).href});
    const callable = artifact.callables.find(callable => callable.id === OP); assert.ok(callable);
    const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact)); assert.equal(namespace[callable.export], OP);
    const definition = object(namespace.appDefinition), guard = object((object(object(definition.operations)[OP]).sendGuards as unknown[])[0]);
    assert.deepEqual(guard.inputs, [{name: 'enabled', type: 'bool'}]);
    const generated = artifact.modules.find(module => module.path === callable.module); assert.ok(generated);
    assert.match(generated.js, /await bindScenarioReceiptModelResult\(c,/);
    worker = new Miniflare({compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: {IDENTITY: 'created-email-identity', OWNER: 'created-email-owner', FOREIGN: 'created-email-foreign'}, d1Persist: join(directory, 'd1')});
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
    const db = await worker.getD1Database('OWNER') as unknown as D1Database, foreignDb = await worker.getD1Database('FOREIGN') as unknown as D1Database;
    await ensureIdentitySchema(identityDb); await ensureSchema(db); await ensureSchema(foreignDb);
    const identities = createD1IdentityStore(identityDb, {clock}), team = await identities.createTeam({timezone: 'UTC'});
    const user = await identities.createUser({email: 'created-email@example.test', password_hash: 'unused', email_verified: true});
    const membership = await identities.createMembership({user_id: user.user_id, team_id: team.team_id, is_owner: true, roles: []});
    const replacementOwner = await identities.createUser({ email: 'replacement-owner@created-email.example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: replacementOwner.user_id, is_owner: true, roles: [] });
    const foreignTeam = await identities.createTeam({timezone: 'UTC'}), foreignUser = await identities.createUser({email: 'created-email-foreign@example.test', password_hash: 'unused', email_verified: true});
    await identities.createMembership({user_id: foreignUser.user_id, team_id: foreignTeam.team_id, is_owner: true, roles: []});
    const grant = await issueMcpGrant(identities, {user_id: user.user_id, team_id: team.team_id, client_id: 'created-email'}, {clock});
    const foreignGrant = await issueMcpGrant(identities, {user_id: foreignUser.user_id, team_id: foreignTeam.team_id, client_id: 'created-email-foreign'}, {clock});
    const current = () => resolveIdentity(identities, {mcp_grant_token: grant.token}, {clock});
    const foreign = () => resolveIdentity(identities, {mcp_grant_token: foreignGrant.token}, {clock});
    physical = createSqliteFileStore(join(directory, 'files.sqlite'));
    const scope = {app: APP, ownerPackage: APP, owner: team.team_id};
    const native = await createNativeFileRetirementBinding({artifact, asm, scope, identities, db, stateStoreId: 'native-created-guarded-email', physicalSqliteFileStore: physical,
      initializeFresh: true, clock, intentTtlMs: 60000, urlBase: 'https://created-email.invalid', retention: {unattachedHorizonMs: 120000, retentionMs: 600000}, maxRows: 100, maxReferences: 100});
    const fenceFor = await bindNativeEmailDispatchGuards({asm, artifact, store: native.store, identities, scope,
      revalidateAuthority: async () => (await identities.findTeamById(team.team_id))?.team_id === team.team_id});
    const invoker = buildInvoker(artifact, asm, native.store, {appId: APP, memberships: identities, now: clock.nowMs, ownerStorage: native.ownerStorage});
    const foreignInvoker = buildInvoker(artifact, asm, createD1Storage(foreignDb), {appId: APP, memberships: identities, now: clock.nowMs});
    const admittedIdentity = await current();
    const resources = async () => ({identity: await snapshot(identityDb), owner: await snapshot(db), foreign: await snapshot(foreignDb),
      files: physical!.files.listAll(), intents: physical!.intents.listAll()});
    const query = (model: string) => native.store.query({model: asModel(model), authority: 'owner', archived: 'include', order: [{field: 'id', direction: 'asc'}]});
    const envelope = (enabled: boolean, accept = true): MutationEnvelope => ({operation: OP, operation_id: nextId(), inputs: {enabled, accept}});
    const identity = (input: MutationEnvelope): ReceiptIdentity => ({app: APP, owner: team.team_id, principal: user.user_id, operation: asOperation(OP), operationId: asOperationId(input.operation_id)});
    const invoke = async (input: MutationEnvelope) => invoker.invokeMutation(input, await current());
    await new Promise<void>((done, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', done);});
    const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
    const binding: ProviderBinding = {deployment: 'deployment.mail', capability: 'std.EmailV1', capabilityVersion: 1, account: 'local-created-email'};
    const sender: InstalledMailSender = {binding, mail: new EmailV1Adapter({baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 2000,
      maxBodyBytes: 16384, maxTransportBytes: null, clock: {now: clock.nowMs}})};
    const adapter = createBoundMailAdapter({appDefinition: definition, binding, resolveInstalledMailSender: () => sender});
    const dispatcher = await createBoundMailDispatcher({store: native.store, adapter, workCommands: WORK_SYSTEM_COMMANDS,
      stageCommands: WORK_DISPATCH_STAGE_COMMANDS, createClaimCommand: createWorkDispatchClaimCommand});
    const unchanged = async (before: Awaited<ReturnType<typeof resources>>) => assert.deepEqual(await resources(), before);
    const saved: Array<{input: MutationEnvelope; id: string}> = [];
    for (const enabled of [false, true]) {
      const input = envelope(enabled), before = await resources(), revision = await native.store.readRevision();
      const result = await invoke(input); assert.ok('result' in result, JSON.stringify(result)); assert.equal(result.result.status, 'committed');
      const wire = object(result.result.result); assert.deepEqual(Object.keys(wire), ['id']); assert.equal(typeof wire.id, 'string');
      const id = wire.id as string; saved.push({input, id});
      const row = await native.store.load(MODEL, asId(id)); assert.ok(row); assert.equal(row.data.count, '1'); assert.equal(row.version, 1);
      assert.equal(row.createdBy, user.user_id); assert.equal(row.parent ?? null, null); assert.ok(row.data.attempt !== null);
      const receipt = await native.store.readReceipt(identity(input)); assert.ok(receipt); assert.equal(receipt.inputHash, await hashInputs(input.inputs));
      assert.equal(receipt.committedRevision, revision + 1); assert.equal(await native.store.readRevision(), revision + 1);
      const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
      assert.equal(association.resultType, MODEL); assert.deepEqual(association.plan, operation.result.disclosure);
      assert.deepEqual(association.changed.map(change => [change.model, change.row.id]), [[MODEL, id]]); assert.deepEqual(association.changed[0]!.row, row);
      assert.equal(association.calls?.length ?? 0, 0); assert.equal(result.result.records?.length, 1);
      const projection = object(result.result.records![0]); assert.equal(projection.id, id); assert.equal(object(projection.data).count, '1');
      const deliveries = (await query(RECEIPT_MODEL)).map(row => readReceiptRow(row));
      const delivery = deliveries.find(delivery => delivery.filePayloadOrigin?.origin.kind === 'delivery-result' && delivery.filePayloadOrigin.origin.intent.operationId === input.operation_id ||
        delivery.filePayloadOrigin?.origin.kind === 'delivery-skipped' && delivery.filePayloadOrigin.origin.send.operationId === input.operation_id);
      assert.ok(delivery); assert.equal(delivery.receipt.status, enabled ? 'pending' : 'skipped');
      assert.ok(delivery.filePayloadOrigin); const deliveryOrigin = delivery.filePayloadOrigin.origin;
      assert.ok(deliveryOrigin.kind === 'delivery-result' || deliveryOrigin.kind === 'delivery-skipped');
      assert.deepEqual(deliveryOrigin.association, {model: MODEL, recordId: id, field: 'attempt'});
      const after = await resources(); assert.deepEqual(after.identity, before.identity); assert.deepEqual(after.foreign, before.foreign);
      assert.deepEqual(after.files, before.files); assert.deepEqual(after.intents, before.intents);
      assert.equal(after.owner.history!.length, before.owner.history!.length + 1); assert.equal(after.owner.fence_log!.length, before.owner.fence_log!.length + 1);
      const history = after.owner.history!.filter(row => !before.owner.history!.some(prior => JSON.stringify(prior) === JSON.stringify(row)));
      assert.equal(history.length, 1);
      const replay = await invoke(input); assert.ok('result' in replay, JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed');
      assert.deepEqual(replay.result.result, {id}); assert.deepEqual(replay.result.records, result.result.records); await unchanged(after);
      const pending = await native.store.outboxPending(); assert.equal(pending.length, enabled ? 1 : 0);
      assert.equal((await query(WORK_DISPATCH_MODEL)).length, enabled ? 1 : 0); assert.equal(requests.length, 0);
      if (enabled) {
        const intent = pending[0]!; assert.equal(intent.operationId, input.operation_id); assert.equal(intent.target, 'std.EmailV1.send');
        const dispatch = readDispatchRow((await native.store.load(asModel(WORK_DISPATCH_MODEL), asId(intent.intentId)))!);
        assert.equal(dispatch.sourceGuard?.rule, guard.rule); assert.deepEqual(dispatch.sourceGuard?.inputs, {enabled: true});
        assert.equal(dispatch.attempts, 0);
        const driven = await dispatcher.drive({intentId: intent.intentId, actor: user.user_id, operation: 'native.created.Email.drive', nowMs: clock.nowMs,
          nextClaimId: () => `claim-${++sequence}`, maxClaimAgeMs: 60000, claimOperationId: nextId(), recordOperationId: nextId(), classifyFailure,
          evaluateGuard: () => {throw new Error('No legacy postclaim guard fallback');}, readStateSnapshot: () => null, fence: fenceFor(intent)});
        assert.equal(providerFailure, undefined); assert.equal(driven.status, 'recorded'); assert.equal(requests.length, 1);
        const terminal = readReceiptRow((await native.store.load(asModel(RECEIPT_MODEL), asId(intent.intentId)))!);
        assert.equal(terminal.receipt.status, 'succeeded'); assert.deepEqual(terminal.receipt.result, {reference: `accepted-${intent.intentId}`});
        const finalDispatch = readDispatchRow((await native.store.load(asModel(WORK_DISPATCH_MODEL), asId(intent.intentId)))!);
        assert.equal(finalDispatch.attempts, 1); assert.equal((await native.store.outboxGet(intent.intentId))!.status, 'dispatched');
        assert.deepEqual(await native.store.outboxPending(), []);
        assert.ok((await query(RECEIPT_ASSOCIATION_MODEL)).map(readAssociationRow).some(value => value.deliveryId === intent.intentId));
        const terminalResources = await resources(); await invoke(input); await unchanged(terminalResources); assert.equal(requests.length, 1);
        assert.deepEqual(await native.store.readReceipt(identity(input)), receipt);
      }
    }
    // A late failed require rolls back this invocation's actual Create, Sets,
    // SEND occurrence, delivery association and outbox before any provider drive.
    const rejectedInput = envelope(true, false), beforeReject = await resources(), rejected = await invoke(rejectedInput);
    assert.ok('error' in rejected, JSON.stringify(rejected)); assert.equal(rejected.error.code, 'rule_failed');
    const rejectedState = await resources(); assert.equal(requests.length, 1);
    for (const table of Object.keys(beforeReject.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table))
      assert.deepEqual(rejectedState.owner[table], beforeReject.owner[table], table);
    assert.deepEqual(rejectedState.identity, beforeReject.identity); assert.deepEqual(rejectedState.foreign, beforeReject.foreign);
    assert.deepEqual(rejectedState.files, beforeReject.files); assert.deepEqual(rejectedState.intents, beforeReject.intents);
    const retried = await invoke(rejectedInput); assert.ok('error' in retried); assert.equal(retried.error.code, 'rule_failed'); await unchanged(rejectedState);
    assert.equal((await query(MODEL)).length, 2); assert.equal((await query(WORK_DISPATCH_MODEL)).length, 1); assert.deepEqual(await native.store.outboxPending(), []);
    const foreignBefore = await resources();
    for (const [selected, actor, code] of [[invoker, await foreign(), 'forbidden'], [foreignInvoker, admittedIdentity, 'not_found']] as const) {
      const denied = await selected.invokeRetainedMutation(saved[1]!.input, actor);
      assert.ok('error' in denied, JSON.stringify(denied)); assert.equal(denied.error.code, code); await unchanged(foreignBefore);
    }
    await identities.removeMembership(membership.membership_id); now += 1000;
    const revoked = await resources();
    const withheld = await invoker.invokeMutation(saved[1]!.input, admittedIdentity);
    assert.ok('result' in withheld, JSON.stringify(withheld)); assert.equal(withheld.result.status, 'replayed');
    assert.equal(withheld.result.result, null); assert.deepEqual(withheld.result.records, []); await unchanged(revoked);
    const retainedDenied = await invoker.invokeRetainedMutation(saved[1]!.input, admittedIdentity);
    assert.ok('error' in retainedDenied, JSON.stringify(retainedDenied)); assert.equal(retainedDenied.error.code, 'forbidden'); await unchanged(revoked);
    const freshDenied = await invoker.invokeMutation(envelope(true), admittedIdentity);
    assert.ok('error' in freshDenied, JSON.stringify(freshDenied)); assert.equal(freshDenied.error.code, 'forbidden');
    const afterDenied = await resources();
    for (const table of Object.keys(revoked.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) assert.deepEqual(afterDenied.owner[table], revoked.owner[table], table);
    assert.deepEqual(afterDenied.identity, revoked.identity); assert.deepEqual(afterDenied.foreign, revoked.foreign);
    assert.deepEqual(afterDenied.files, revoked.files); assert.deepEqual(afterDenied.intents, revoked.intents);
    await identities.reactivateMembership(membership.membership_id, {is_owner: true, roles: []});
    const restored = await resources(), replay = await invoke(saved[1]!.input); assert.ok('result' in replay); assert.equal(replay.result.status, 'replayed');
    assert.deepEqual(replay.result.result, {id: saved[1]!.id}); await unchanged(restored); assert.equal(requests.length, 1);
    assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
    assert.deepEqual(await Promise.all(paths.map(async path => hash(await readFile(path)))), originals.map(hash));
  } finally {
    try {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    } finally {
      try { physical?.close(); } finally {
        try { await worker?.dispose(); } finally { await rm(directory, {recursive: true, force: true}); }
      }
    }
  }
 });


test('original Maintain assignment and failed-notice retry retain genuine Mail receipts and current grants',
 {timeout: 600000}, async () => {
  const selected = await originalScenarioSource('maintain', 'assign', 'OriginalMaintainMail', [{owner: 'maintain', name: 'retry_notice'}]);
  const APP = selected.app;
  await mkdir(join(root, '.can/tmp'), {recursive: true});
  const directory = await mkdtemp(join(root, '.can/tmp/maintain-mail-'));
  let worker: Miniflare | undefined, physical: SqliteFileStore | undefined;
  try {
    const require = createRequire(import.meta.url);
    const {createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity} = await nodeImport(pathToFileURL(require.resolve('@canlang/identity')).href) as typeof import('@canlang/identity');
    const {ensureSchema} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/storage/d1')).href) as typeof import('@canlang/state/storage/d1');
    const {asModel, asOperationId, uuidv7} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/testing/invocation/fixtures')).href) as typeof import('@canlang/state/testing/invocation/fixtures');
    const {RECEIPT_MODEL, readReceiptRow} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/receipt/tables')).href) as typeof import('@canlang/state/receipt/tables');
    const {createSqliteFileStore} = await nodeImport(pathToFileURL(require.resolve('@canlang/files/host/sqlite')).href) as typeof import('@canlang/files/host/sqlite');
    const {assembleModules, importVerifiedAssemblyModule} = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const {buildInvoker} = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
    const {createNativeFileRetirementBinding} = await nodeImport(installed('runtime/file-retirement.js')) as typeof import('../src/runtime/file-retirement.js');
    const {bindNativeEmailDispatchGuards, materializeCanonicalExampleSnapshots} = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
    const {createBoundMailAdapter} = await nodeImport(installed('runtime/bound-mail.js')) as typeof import('../src/runtime/bound-mail.js');
    const {createBoundMailDispatcher} = await nodeImport(installed('runtime/bound-dispatch.js')) as typeof import('../src/runtime/bound-dispatch.js');
    const {WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand} = await nodeImport(pathToFileURL(require.resolve('@canlang/work/kernel/commands')).href) as typeof import('@canlang/work/kernel/commands');
    const {classifyFailure} = await nodeImport(pathToFileURL(require.resolve('@canlang/work/receipt')).href) as typeof import('@canlang/work/receipt');
    const source = join(directory, 'maintain.can'), compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
    const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
    await writeFile(source, selected.source);
    const paths = [source, compiler, catalog], originals = await Promise.all(paths.map(path => readFile(path)));
    const {stdout} = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', `--catalog=${catalog}`, source],
      {cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024});
    const artifact = JSON.parse(stdout) as CompileArtifact;
    assert.deepEqual(artifact.operations?.filter(operation => operation.kind !== 'read').map(operation => operation.name).sort(), ['maintain.assign', 'maintain.retry_notice']);
    for (const operation of artifact.operations!.filter(operation => operation.kind !== 'read')) {
      assert.equal(operation.result?.type, 'void'); assert.ok(operation.result.disclosure);
    }
    const asm = await assembleModules({artifact, sourcePath: source}, {workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js')});
    const callable = artifact.callables.find(callable => callable.id === 'maintain.assign'); assert.ok(callable);
    const definition = object(object(await importVerifiedAssemblyModule(asm, callable.module, artifact)).appDefinition);
    worker = new Miniflare({compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: {IDENTITY: 'maintain-mail-identity', OWNER: 'maintain-mail-owner'}, d1Persist: join(directory, 'd1')});
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database, db = await worker.getD1Database('OWNER') as unknown as D1Database;
    await ensureIdentitySchema(identityDb); await ensureSchema(db);
    const now = Date.parse('2026-10-18T12:00:00Z'), clock = {nowMs: () => now}; let sequence = 1000;
    const nextId = () => asOperationId(uuidv7(now, ++sequence));
    const identities = createD1IdentityStore(identityDb, {clock}), team = await identities.createTeam({timezone: 'UTC'});
    const user = await identities.createUser({email: 'maintain-mail@example.test', password_hash: 'unused', email_verified: true});
    const membership = await identities.createMembership({user_id: user.user_id, team_id: team.team_id, is_owner: false,
      roles: ['maintain.maintenance_manager', 'supplier.buyer'].map(role => ({role, granted_at: new Date(now).toISOString(), granted_by: user.user_id}))});
    const grant = await issueMcpGrant(identities, {user_id: user.user_id, team_id: team.team_id, client_id: 'maintain-mail'}, {clock});
    const current = () => resolveIdentity(identities, {mcp_grant_token: grant.token}, {clock});
    physical = createSqliteFileStore(join(directory, 'files.sqlite'));
    const scope = {app: APP, ownerPackage: 'maintain', owner: team.team_id};
    const native = await createNativeFileRetirementBinding({artifact, asm, scope, identities, db, stateStoreId: 'native-maintain-mail',
      physicalSqliteFileStore: physical, initializeFresh: true, clock, intentTtlMs: 60000, urlBase: 'https://maintain.invalid',
      retention: {unattachedHorizonMs: 120000, retentionMs: 600000}, maxRows: 100, maxReferences: 100});
    const store = native.store, siteId = nextId(), supplierId = nextId(), assetId = nextId(), repairId = nextId();
    await materializeCanonicalExampleSnapshots({asm, artifact, store, identity: await current(), now, operationId: nextId(), snapshots: [
      {model: asModel('rent_catalog.Location'), id: siteId, data: {name: 'Main', address: '1 Example Road', timezone: 'Europe/Brussels', currency: 'EUR', hours: '09:00–18:00', arrival: 'Reception', active: true}},
      {model: asModel('employee.Employee'), id: nextId(), data: {user: {id: user.user_id}, home: {id: siteId}, locations: [{id: siteId}], operator_wide: false, active: true, start: '2026-10-01', role: 'technician', skills: []}},
      {model: asModel('supplier.Supplier'), id: supplierId, data: {name: 'Repairs', contact: 'vendor@example.test', locations: [{id: siteId}], active: true}},
      {model: asModel('maintain.Asset'), id: assetId, data: {location: {id: siteId}, identifier: 'ASSET-1', name: 'Door', category: 'Building'}},
      {model: asModel('maintain.Repair'), id: repairId, parent: {model: asModel('maintain.Asset'), id: assetId}, data: {title: 'Repair door', description: 'Replace lock', state: 'open'}},
    ]});
    const invoker = buildInvoker(artifact, asm, store, {appId: APP, memberships: identities, now: clock.nowMs, ownerStorage: native.ownerStorage});
    const query = (model: string) => store.query({model: asModel(model), authority: 'owner', archived: 'include', order: [{field: 'id', direction: 'asc'}]});
    const ref = async (model: string, id: string) => { const row = (await query(model)).find(row => row.id === id); assert.ok(row); return {id: row.id, version: String(row.version)}; };
    const invoke = async (envelope: MutationEnvelope) => invoker.invokeMutation(envelope, await current());
    const assign: MutationEnvelope = {operation: 'maintain.assign', operation_id: nextId(), inputs: {repair: await ref('maintain.Repair', repairId), supplier: await ref('supplier.Supplier', supplierId), reason: 'Original contractor assignment'}};
    const assigned = await invoke(assign); assert.ok('result' in assigned, JSON.stringify(assigned)); assert.equal(assigned.result.status, 'committed');
    const assignments = await query('maintain.Assignment'); assert.equal(assignments.length, 1);
    const repairs = await query('maintain.Repair'); assert.deepEqual(repairs[0]!.data.assignment, {id: assignments[0]!.id}); assert.equal(repairs[0]!.data.state, 'assigned');
    assert.equal((await query('maintain.Notice')).length, 1);
    const binding: ProviderBinding = {deployment: 'deployment.mail', capability: 'std.EmailV1', capabilityVersion: 1, account: 'maintain-control'};
    let sends = 0;
    const sender: InstalledMailSender = {binding, mail: {send: async (request, options) => {
      assert.equal(request.to, 'vendor@example.test'); assert.equal(request.subject, 'Repair assignment'); assert.equal(request.body, 'Replace lock'); sends++;
      return sends === 1 ? {delivery_id: options.deliveryId, status: 'failed', result: null, error: {code: 'provider_rejected', message: 'Original delivery rejected'}}
        : {delivery_id: options.deliveryId, status: 'succeeded', result: {reference: 'accepted'}, error: null};
    }, reconcile: async () => {throw new Error('No recovery transport required');}}};
    const dispatcher = await createBoundMailDispatcher({store, adapter: createBoundMailAdapter({appDefinition: definition, binding, resolveInstalledMailSender: () => sender}),
      workCommands: WORK_SYSTEM_COMMANDS, stageCommands: WORK_DISPATCH_STAGE_COMMANDS, createClaimCommand: createWorkDispatchClaimCommand});
    const fenceFor = await bindNativeEmailDispatchGuards({asm, artifact, store, identities, scope,
      revalidateAuthority: async () => (await identities.findTeamById(team.team_id))?.team_id === team.team_id});
    const drive = async () => {
      const pending = await store.outboxPending(); assert.equal(pending.length, 1);
      const retained = await store.outboxGet(pending[0]!.intentId); assert.ok(retained);
      return dispatcher.drive({intentId: retained.intent.intentId, actor: user.user_id, operation: 'native.Email.drive', nowMs: clock.nowMs,
        nextClaimId: () => `maintain-claim-${++sequence}`, maxClaimAgeMs: 60000, claimOperationId: nextId(), recordOperationId: nextId(), classifyFailure,
        evaluateGuard: () => {throw new Error('Original native guard must use installed preclaim fence');}, readStateSnapshot: () => null, fence: fenceFor(retained.intent)});
    };
    await drive(); assert.equal(sends, 1);
    assert.equal((await query(RECEIPT_MODEL)).map(row => readReceiptRow(row)).filter(row => row.receipt.status === 'failed').length, 1);
    const notice = (await query('maintain.Notice'))[0]!;
    const retry: MutationEnvelope = {operation: 'maintain.retry_notice', operation_id: nextId(), inputs: {notice: {id: notice.id, version: String(notice.version)}}};
    const retried = await invoke(retry); assert.ok('result' in retried, JSON.stringify(retried)); assert.equal(retried.result.status, 'committed');
    assert.equal((await query('maintain.Notice')).length, 2);
    const committed = await snapshot(db);
    const replayed = await invoke(retry);
    assert.ok('result' in replayed); assert.equal(replayed.result.status, 'replayed'); assert.deepEqual(await snapshot(db), committed);
    const duplicate = await invoke({...retry, operation_id: nextId()});
    assert.ok('error' in duplicate, JSON.stringify(duplicate)); assert.equal(duplicate.error.code, 'rule_failed');
    await drive();
    assert.equal(sends, 2); assert.deepEqual(await store.outboxPending(), []);
    await identities.removeMembership(membership.membership_id);
    const revoked = await invoke({...assign, operation_id: nextId()});
    assert.ok('error' in revoked, JSON.stringify(revoked)); assert.equal(revoked.error.code, 'forbidden');
    assert.equal((await query('maintain.Assignment')).length, 1); assert.equal((await query('maintain.Notice')).length, 2);
    assert.deepEqual(await Promise.all(paths.map(async path => hash(await readFile(path)))), originals.map(hash));
    assert.equal((await originalScenarioSource('maintain', 'assign', APP, [{owner: 'maintain', name: 'retry_notice'}])).source, selected.source);
  } finally {
    try {physical?.close();} finally {try {await worker?.dispose();} finally {await rm(directory, {recursive: true, force: true});}}
  }
 });
