/** Dispatch fence persistence runtime proof (CAN18-v1 dispatch slice).
 *
 * Actual compiled `.can` (guarded send + post-send set persisting
 * `delivery.id` and a pending enum) through assemble + buildInvoker
 * against D1/Miniflare with a stub mail provider. Proves the staged
 * delivery id lands on the stored row on guard-true, documents the
 * guard-false skipped behavior honestly, and keeps foreign-actor
 * denial. Compiler admission alone (dispatch_fence_persistence 4/4)
 * is component evidence; this is the executable consumer.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, ModelName, MutationEnvelope, ProviderBinding } from '@canlang/contracts';
import type { InstalledMailSender } from '@canlang/services';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const APP = 'FenceProof';
const MODEL = `${APP}.M` as ModelName;
const OP = `${APP}.go`;
const SOURCE = `app FenceProof
use std {EmailV1 as Mail} from=deployment.mail
Given
 M {f:text?,state:enum(none,pending,released,failed,unknown)=none}
 policy M read=members
When
 ## BEGIN TEST-AUTHORED SETUP
 crud M by=members fields=f,state
 ## END TEST-AUTHORED SETUP
 scenario go(row:M,enabled:bool) by=members
  do
   send Mail.send {to="r@example.test",subject="S",body="B"} when=enabled as delivery
   set row {f=delivery.id,state=pending}
Then
`;

const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const nodeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}

test('guarded send persists staged delivery.id and pending enum', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(root, '.can-dispatch-fence-'));
  const startedAt = Date.now(), phase = (name: string) => console.info(`[dispatch-fence] ${name} elapsed_ms=${Date.now() - startedAt}`);
  let worker: Miniflare | undefined;
  let sequence = 0; const now = Date.now(); const clock = { nowMs: () => now };
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/send');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { const part = Buffer.from(chunk); bytes += part.length; assert.ok(bytes <= 16384); chunks.push(part); }
      const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      requests.push(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ reference: `accepted-${String(body.delivery_id)}` }));
    } catch (error) { response.writeHead(500); response.end(); server.emit('controlFailure', error); }
  });
  let providerFailure: unknown; server.on('controlFailure', error => { providerFailure = error; });
  try {
    const require = createRequire(import.meta.url);
    const { createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity } = await nodeImport(pathToFileURL(require.resolve('@canlang/identity')).href) as typeof import('@canlang/identity');
    const { createD1Storage, ensureSchema } = await nodeImport(pathToFileURL(require.resolve('@canlang/state/storage/d1')).href) as typeof import('@canlang/state/storage/d1');
    const { asId, asModel, asOperation, asOperationId, uuidv7, classifyFailure } = await nodeImport(pathToFileURL(require.resolve('@canlang/state/testing/invocation/fixtures')).href) as typeof import('@canlang/state/testing/invocation/fixtures');
    const { assembleModules, importVerifiedAssemblyModule } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
    const { createNativeFileRetirementBinding } = await nodeImport(installed('dev/file-retirement.js')) as typeof import('../src/dev/file-retirement.js');
    const { bindNativeEmailDispatchGuards } = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
    const { createBoundMailAdapter } = await nodeImport(installed('runtime/bound-mail.js')) as typeof import('../src/runtime/bound-mail.js');
    const { createBoundMailDispatcher } = await nodeImport(installed('runtime/bound-dispatch.js')) as typeof import('../src/runtime/bound-dispatch.js');
    const { EmailV1Adapter } = await nodeImport(pathToFileURL(require.resolve('@canlang/services/mail/adapter')).href) as typeof import('@canlang/services/mail/adapter');
    const { WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand } = await nodeImport(pathToFileURL(require.resolve('@canlang/work/kernel/commands')).href) as typeof import('@canlang/work/kernel/commands');
    const nextId = () => asOperationId(uuidv7(now, ++sequence));
    phase('compile:start');
    const { writeFile } = await import('node:fs/promises');
    const source = join(directory, 'fence-proof.can');
    await writeFile(source, SOURCE);
    const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
    const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
    const env = { ...process.env }; delete env.CAN_CATALOG;
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
      { cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    assert.ok(!('diagnostics' in artifact), `fixture emits clean: ${JSON.stringify(artifact).slice(0, 500)}`);
    const operation = artifact.operations?.find(op => op.name === OP);
    assert.ok(operation?.result?.disclosure, 'go earns a native receipt');
    phase('compile:ready; identity:start');
    worker = new Miniflare({
      compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: { IDENTITY: 'fence-identity', OWNER: 'fence-owner' }, d1Persist: join(directory, 'd1'),
    });
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
    const db = await worker.getD1Database('OWNER') as unknown as D1Database;
    await ensureIdentitySchema(identityDb); await ensureSchema(db);
    const identities = createD1IdentityStore(identityDb, { clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'fence@example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ user_id: user.user_id, team_id: team.team_id, is_owner: true, roles: [] });
    const outsiderTeam = await identities.createTeam({ timezone: 'UTC' });
    const outsider = await identities.createUser({ email: 'fence-outsider@example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ user_id: outsider.user_id, team_id: outsiderTeam.team_id, is_owner: true, roles: [] });
    const grant = await issueMcpGrant(identities, { user_id: user.user_id, team_id: team.team_id, client_id: 'fence' }, { clock });
    const outsiderGrant = await issueMcpGrant(identities, { user_id: outsider.user_id, team_id: outsiderTeam.team_id, client_id: 'fence-out' }, { clock });
    const current = () => resolveIdentity(identities, { mcp_grant_token: grant.token }, { clock });
    const stranger = () => resolveIdentity(identities, { mcp_grant_token: outsiderGrant.token }, { clock });
    const { createSqliteFileStore } = await nodeImport(pathToFileURL(require.resolve('@canlang/files/host/sqlite')).href) as typeof import('@canlang/files/host/sqlite');
    const physical = createSqliteFileStore(join(directory, 'files.sqlite'));
    const asm = await assembleModules({ artifact, sourcePath: source }, {
      workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js'),
      uiUrl: pathToFileURL(require.resolve('@canlang/ui')).href,
    });
    const scope = { app: APP, ownerPackage: APP, owner: team.team_id };
    const native = await createNativeFileRetirementBinding({
      artifact, asm, scope, identities, db, stateStoreId: 'dispatch-fence', physicalSqliteFileStore: physical,
      initializeFresh: true, clock, intentTtlMs: 60000, urlBase: 'https://fence.invalid',
      retention: { unattachedHorizonMs: 120000, retentionMs: 600000 }, maxRows: 100, maxReferences: 100,
    });
    const fenceFor = await bindNativeEmailDispatchGuards({
      asm, artifact, store: native.store, identities, scope,
      revalidateAuthority: async () => (await identities.findTeamById(team.team_id))?.team_id === team.team_id,
    });
    void fenceFor;
    const invoker = buildInvoker(artifact, asm, native.store, { appId: APP, memberships: identities, now: clock.nowMs, ownerStorage: native.ownerStorage });
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
    const binding: ProviderBinding = { deployment: 'deployment.mail', capability: 'std.EmailV1', capabilityVersion: 1, account: 'local-fence' };
    const sender: InstalledMailSender = {
      binding, mail: new EmailV1Adapter({
        baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 2000,
        maxBodyBytes: 16384, maxTransportBytes: null, clock: { now: clock.nowMs },
      }),
    };
    const adapter = createBoundMailAdapter({ appDefinition: object((await importVerifiedAssemblyModule(asm, artifact.callables.find(c => c.id === OP)!.module, artifact)).appDefinition), binding, resolveInstalledMailSender: () => sender });
    const dispatcher = await createBoundMailDispatcher({
      store: native.store, adapter, workCommands: WORK_SYSTEM_COMMANDS,
      stageCommands: WORK_DISPATCH_STAGE_COMMANDS, createClaimCommand: createWorkDispatchClaimCommand,
    });
    void dispatcher;
    phase('setup:create-row');
    const created = await invoker.invokeMutation({
      operation: `${MODEL}.create`, operation_id: nextId(), inputs: { state: 'none' },
    }, await current());
    assert.ok('result' in created, JSON.stringify(created).slice(0, 500));
    assert.equal(created.result.status, 'committed');
    const createdId = object(created.result.records![0]).id as string;
    const invoke = async (inputs: Record<string, unknown>, by = current()) =>
      invoker.invokeMutation({ operation: OP, operation_id: nextId(), inputs }, await by);
    phase('guard-true:start');
    const ok = await invoke({ row: { id: createdId, version: '1' }, enabled: true });
    assert.ok('result' in ok, JSON.stringify(ok).slice(0, 800));
    assert.equal(ok.result.status, 'committed');
    assert.equal(requests.length, 0, 'send stages, provider untouched until drive');
    const staged = await native.store.outboxPending();
    assert.equal(staged.length, 1, 'exactly one staged send');
    assert.equal(staged[0]!.target, 'std.EmailV1.send');
    const row = await native.store.load(asModel(MODEL), asId(createdId)); assert.ok(row);
    const stored = object(row).data as Record<string, unknown>;
    assert.equal(stored.f, staged[0]!.intentId, 'staged delivery id persists on the row');
    assert.equal(stored.state, 'pending');
    phase('provider-drive:start');
    const driven = await dispatcher.drive({ intentId: staged[0]!.intentId, actor: user.user_id,
      operation: 'fence.proof.drive', nowMs: clock.nowMs,
      nextClaimId: () => `claim-${++sequence}`, maxClaimAgeMs: 60000,
      claimOperationId: nextId(), recordOperationId: nextId(), classifyFailure,
      evaluateGuard: () => { throw new Error('No legacy postclaim guard fallback'); },
      readStateSnapshot: () => null, fence: fenceFor(staged[0]!) });
    assert.equal(providerFailure, undefined);
    assert.equal(driven.status, 'recorded');
    assert.equal(requests.length, 1, 'drive hits the provider exactly once');
    assert.equal(object(requests[0]).delivery_id, staged[0]!.intentId);
    phase('guard-false:start');
    const created2 = await invoker.invokeMutation({
      operation: `${MODEL}.create`, operation_id: nextId(), inputs: { state: 'none' },
    }, await current());
    assert.ok('result' in created2);
    const createdId2 = object(created2.result.records![0]).id as string;
    const skipped = await invoke({ row: { id: createdId2, version: '1' }, enabled: false });
    assert.ok('result' in skipped, JSON.stringify(skipped).slice(0, 800));
    assert.equal(skipped.result.status, 'committed');
    assert.equal(requests.length, 1, 'guard-false still sends nothing');
    assert.deepEqual(await native.store.outboxPending(), [], 'guard-false stages nothing');
    const row2 = await native.store.load(asModel(MODEL), asId(createdId2)); assert.ok(row2);
    const stored2 = object(row2).data as Record<string, unknown>;
    assert.equal(stored2.state, 'pending');
    assert.equal(typeof stored2.f, 'string', 'skipped fence still records its delivery marker');
    assert.ok((stored2.f as string).length > 0);
    assert.notEqual(stored2.f, stored.f, 'skipped marker is distinct from the sent delivery id');
    phase('denial:start');
    const denied = await invoker.invokeMutation(
      { operation: OP, operation_id: nextId(), inputs: { row: { id: createdId, version: '1' }, enabled: true } },
      await stranger(),
    );
    assert.ok('error' in denied, JSON.stringify(denied).slice(0, 500));
    assert.equal(providerFailure, undefined);
    phase('done');
  } finally {
    server.close();
    await worker?.dispose();
  }
});
