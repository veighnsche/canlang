/** Generated CRUD through the public HTTP route, current read and saved replay. */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, ModelName, StoragePort } from '@canlang/contracts';
import type { HttpDeps } from '@canlang/interfaces';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const producer = (name: string) => pathToFileURL(require.resolve(name)).href;
const APP = 'SourcePolicyProjection', MODEL = `${APP}.Entry` as ModelName;
const OPERATION = `${MODEL}.create`;
const sourcePath = join(root, 'packages/cloudflare/test/fixtures/native-source-policy-projection.can');
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
async function snapshot(db: D1Database) {
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name")
    .all<{ name: string }>(); assert.equal(names.success, true);
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const { name } of names.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    tables[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return tables;
}

test('current generated HTTP CRUD, public read and replay never disclose secret or hidden ordinary fields',
  { timeout: 120000 }, async () => {
    const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
    const { prepareLocalPreviewCapture } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
    const { captureSingleFileSource, captureIsCurrent, verifyCompilerSources } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
    const { createD1Storage, ensureSchema } = await nodeImport(producer('@canlang/state/storage/d1')) as typeof import('@canlang/state/storage/d1');
    const { uuidv7 } = await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
    const { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText, deriveCsrfToken } =
      await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
    const { createHttpHandler, handleOperationRequest, catalogFromArtifactOperations } =
      await nodeImport(producer('@canlang/interfaces')) as typeof import('@canlang/interfaces');
    const original = await readFile(sourcePath);
    const directory = await mkdtemp(join(tmpdir(), 'can-native-source-policy-http-'));
    let worker: Miniflare | undefined, server: ReturnType<typeof createServer> | undefined;
    try {
      // The owning compiler refuses an attempted secret grant before any host
      // accepts it. The valid source below still has a hidden ordinary field.
      const refusedSource = join(directory, 'explicit-secret-grant.can');
      await writeFile(refusedSource, original.toString('utf8').replace('fields=label', 'fields=label,token'));
      const negative = spawnSync(join(root, 'compiler/target/debug/can'),
        ['compile', '--format=json', '--catalog', join(root, 'packages/values/dist/catalog.json'), refusedSource],
        { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      assert.equal(negative.status, 10); assert.ok(negative.stdout.includes('E4010'));
      assert.match(negative.stdout, /grants never include secrets/);
      const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root, appPath: sourcePath,
        compilerPath: join(root, 'compiler/target/debug/can'), catalogPath: join(root, 'packages/values/dist/catalog.json'),
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
      const env = { ...process.env }; delete env.CAN_CATALOG;
      const { stdout } = await promisify(execFile)(join(root, 'compiler/target/debug/can'),
        ['compile', '--format=json', '--catalog', join(root, 'packages/values/dist/catalog.json'), capture.compilerOperand],
        { cwd: capture.root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      assert.equal(artifact.operations?.find(value => value.name === OPERATION)?.kind, 'create');
      const model = artifact.models?.find(value => value.name === MODEL); assert.ok(model);
      assert.deepEqual(model.fields.map(value => value.name), ['label', 'hidden', 'token']);
      assert.equal(model.fields[2]!.serverOnly, true);
      const assembly = await assembleModules({ artifact, sourcePath }, { workDir: join(directory, 'modules'),
        stdlibUrl: producer('@canlang/cloudflare/runtime/stdlib') });
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default {fetch(){return new Response("ok")}}', d1Databases: { DB: 'source-policy-http' },
        d1Persist: join(directory, 'd1') });
      const db = await worker.getD1Database('DB') as unknown as D1Database;
      await ensureSchema(db); await ensureIdentitySchema(db);
      const storage = createD1Storage(db), now = Date.now(), clock = { nowMs: () => now };
      const identities = createD1IdentityStore(db, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const owner = await identities.createUser({ email: 'policy-owner@example.test', password_hash: 'unused', email_verified: true });
      await identities.createMembership({ user_id: owner.user_id, team_id: team.team_id, is_owner: true, roles: [] });
      const user = await identities.createUser({ email: 'policy-member@example.test', password_hash: 'unused', email_verified: true });
      const member = await identities.createMembership({ user_id: user.user_id, team_id: team.team_id, is_owner: false, roles: [] });
      const token = randomBytes(32).toString('hex');
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        expires_at: new Date(now + 3600000).toISOString(), last_team_id: team.team_id });
      const csrf = await deriveCsrfToken(token);
      let commits = 0, invocations = 0;
      const store: StoragePort = { ...storage, async commit(batch) { commits++; return storage.commit(batch); } };
      const canonical = buildInvoker(artifact, assembly, store, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs });
      const invoker: HttpDeps['invoker'] = { ...canonical, async invokeMutation(envelope, identity) {
        invocations++; return canonical.invokeMutation(envelope, identity);
      } };
      const unavailable = (): never => { throw new Error('Outside the exact source-policy HTTP profile'); };
      const deps: HttpDeps = { app: { appId: APP, brand: APP, appDefaultLocale: 'en', ownerLabels: new Map() },
        pages: { descriptors: () => [] }, invoker, catalog: catalogFromArtifactOperations(artifact), clock,
        logger: { log: () => {} }, limiter: { check: async () => unavailable() },
        identity: { store: identities, clock, mail: { sendMail: async () => unavailable() },
          verifyBaseUrl: '', recoveryBaseUrl: '', inviteBaseUrl: '', sessionMaxAgeSeconds: 3600 }, secureCookies: false,
        uploads: { files: { usesFiles: () => false }, kernel: { maxBytes: unavailable, createIntent: async () => unavailable(),
          append: async () => unavailable(), complete: async () => unavailable(), finalize: async () => unavailable() } },
        ingress: { bindings: { bindingFor: () => null }, verifier: { verify: async () => null },
          sink: { accept: async () => ({ accepted: false }) } } };
      const unavailableRoute = async () => new Response('Not mounted', { status: 404 });
      let http = createHttpHandler(deps, { operations: (request, operation) => handleOperationRequest(deps, request, operation),
        auth: unavailableRoute, uploads: unavailableRoute, ingress: unavailableRoute, oauth: unavailableRoute });
      let origin = ''; const hostFailures: unknown[] = [];
      server = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (Array.isArray(value)) value.forEach(entry => headers.append(name, entry));
            else if (value !== undefined) headers.set(name, value);
          }
          const body = Buffer.concat(chunks);
          const reply = await http(new Request(new URL(request.url ?? '/', origin), {
            method: request.method ?? 'GET', headers, ...(['GET', 'HEAD'].includes(request.method ?? 'GET') ? {} : { body }),
          }));
          response.writeHead(reply.status, Object.fromEntries(reply.headers)); response.end(Buffer.from(await reply.arrayBuffer()));
        })().catch(error => { hostFailures.push(error); if (!response.headersSent) response.writeHead(500); response.end(); });
      });
      await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', done); });
      const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
      origin = `http://127.0.0.1:${address.port}`;
      const input = { operation: OPERATION, operation_id: uuidv7(now, 1),
        inputs: { label: 'visible-label', hidden: 'HIDDEN_ORDINARY_MARKER' } };
      const post = async (payload = input) => fetch(`${origin}/api/operations/${OPERATION}`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie: `can_session=${token}`, origin },
        body: JSON.stringify(payload) });
      const before = await snapshot(db), revision = await storage.readRevision();
      const firstReply = await post(); assert.equal(firstReply.status, 200);
      const firstText = await firstReply.text(), first = object(JSON.parse(firstText));
      assert.equal(first.status, 'committed'); assert.equal(first.result, null);
      const firstRecords = first.records as unknown[]; assert.equal(firstRecords.length, 1);
      const firstRecord = object(firstRecords[0]); assert.deepEqual(firstRecord.data, { label: 'visible-label' });
      const rawRows = await storage.query({ model: MODEL, authority: 'owner' }); assert.equal(rawRows.length, 1);
      const stored = rawRows[0]!; assert.equal(stored.id, firstRecord.id);
      assert.equal(stored.data.hidden, 'HIDDEN_ORDINARY_MARKER');
      assert.equal(typeof stored.data.token, 'string');
      assert.ok((stored.data.token as string).length >= 32);
      const privateWire = stored.data.token as string;
      assert.equal(firstText.includes(privateWire), false); assert.equal(firstText.includes('HIDDEN_ORDINARY_MARKER'), false);
      assert.equal(await storage.readRevision(), revision + 1);
      assert.equal(commits, 1); assert.equal(invocations, 1);
      const identity = await resolveIdentity(identities, { session_token: token }, { clock });
      const read = await canonical.invokeRead({ operation: `${MODEL}.read`, inputs: {} }, identity);
      assert.ok('result' in read, JSON.stringify(read));
      const readRecords = object(read.result).records as unknown[]; assert.equal(readRecords.length, 1);
      assert.deepEqual(object(readRecords[0]).data, { label: 'visible-label' });
      assert.equal(JSON.stringify(read.result).includes(privateWire), false);
      assert.equal(JSON.stringify(read.result).includes('HIDDEN_ORDINARY_MARKER'), false);
      const committedSnapshot = await snapshot(db);
      const replayReply = await post(); assert.equal(replayReply.status, 200);
      const replayText = await replayReply.text(), replay = object(JSON.parse(replayText));
      assert.equal(replay.status, 'replayed'); assert.deepEqual(replay.records, first.records);
      assert.equal(replayText.includes(privateWire), false); assert.equal(replayText.includes('HIDDEN_ORDINARY_MARKER'), false);
      assert.equal(commits, 1); assert.equal(invocations, 2); assert.deepEqual(await snapshot(db), committedSnapshot);
      await identities.removeMembership(member.membership_id);
      const revokedSnapshot = await snapshot(db), denied = await post();
      const deniedText = await denied.text(); assert.equal(denied.status, 200, deniedText);
      const withheld = object(JSON.parse(deniedText)); assert.equal(withheld.status, 'replayed');
      assert.equal(withheld.result, null); assert.deepEqual(withheld.records, []);
      assert.equal(deniedText.includes(privateWire), false); assert.equal(deniedText.includes('HIDDEN_ORDINARY_MARKER'), false);
      assert.deepEqual(await snapshot(db), revokedSnapshot); assert.equal(commits, 1);
      const afterRevocation = await resolveIdentity(identities, { session_token: token }, { clock });
      const deniedRead = await canonical.invokeRead({ operation: `${MODEL}.read`, inputs: {} }, afterRevocation);
      assert.ok('result' in deniedRead, JSON.stringify(deniedRead)); assert.deepEqual(object(deniedRead.result).records, []);
      await identities.reactivateMembership(member.membership_id, { is_owner: false, roles: [] });
      const restoredSnapshot = await snapshot(db), restoredReply = await post(); assert.equal(restoredReply.status, 200);
      const restoredText = await restoredReply.text(), restored = object(JSON.parse(restoredText));
      assert.equal(restored.status, 'replayed'); assert.deepEqual(restored.records, first.records);
      assert.equal(restoredText.includes(privateWire), false); assert.equal(restoredText.includes('HIDDEN_ORDINARY_MARKER'), false);
      assert.equal(commits, 1); assert.deepEqual(await snapshot(db), restoredSnapshot);

      // The same installed public route must not turn a mutation receipt into
      // a field grant when the owning source declares no read policy at all.
      const noReadSource = original.toString('utf8').replace(' policy Entry read=members fields=label\n', '');
      assert.equal(noReadSource.includes(' policy Entry read='), false);
      const noReadPath = join(directory, 'no-read-policy.can'); await writeFile(noReadPath, noReadSource);
      const compiledNoRead = await promisify(execFile)(join(root, 'compiler/target/debug/can'),
        ['compile', '--format=json', '--catalog', join(root, 'packages/values/dist/catalog.json'), noReadPath],
        { cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const noReadArtifact = JSON.parse(compiledNoRead.stdout) as CompileArtifact;
      assert.equal(noReadArtifact.sources.find(value => value.path === noReadPath)?.sha256,
        await sha256HexText(noReadSource));
      assert.equal(noReadArtifact.operations?.some(value => value.name === `${MODEL}.read`), false);
      const noReadAssembly = await assembleModules({ artifact: noReadArtifact, sourcePath: noReadPath },
        { workDir: join(directory, 'no-read-modules'), stdlibUrl: producer('@canlang/cloudflare/runtime/stdlib') });
      const noReadInvoker = buildInvoker(noReadArtifact, noReadAssembly, store,
        { appId: APP, memberships: identities, source: 'http', now: clock.nowMs });
      const noReadDeps: HttpDeps = { ...deps, invoker: noReadInvoker, catalog: catalogFromArtifactOperations(noReadArtifact) };
      http = createHttpHandler(noReadDeps, { operations: (request, operation) => handleOperationRequest(noReadDeps, request, operation),
        auth: unavailableRoute, uploads: unavailableRoute, ingress: unavailableRoute, oauth: unavailableRoute });
      const noReadInput = { operation: OPERATION, operation_id: uuidv7(now, 2),
        inputs: { label: 'no-read-label', hidden: 'NO_READ_HIDDEN_MARKER' } };
      const noReadBefore = await snapshot(db), noReadRevision = await storage.readRevision();
      const noReadReply = await post(noReadInput);
      const noReadText = await noReadReply.text(); assert.equal(noReadReply.status, 200, noReadText);
      const noReadOutcome = object(JSON.parse(noReadText));
      assert.equal(noReadOutcome.status, 'committed'); assert.equal(noReadOutcome.result, null);
      assert.deepEqual(noReadOutcome.records, []);
      const noReadRows = (await storage.query({ model: MODEL, authority: 'owner' }))
        .filter(row => row.data.label === 'no-read-label');
      assert.equal(noReadRows.length, 1); assert.equal(noReadRows[0]!.data.hidden, 'NO_READ_HIDDEN_MARKER');
      assert.equal(typeof noReadRows[0]!.data.token, 'string');
      const noReadSecret = noReadRows[0]!.data.token as string;
      assert.equal(noReadText.includes(noReadSecret), false); assert.equal(noReadText.includes('NO_READ_HIDDEN_MARKER'), false);
      assert.equal(await storage.readRevision(), noReadRevision + 1); assert.equal(commits, 2);
      const noReadSaved = await snapshot(db);
      const noReadReplayReply = await post(noReadInput); assert.equal(noReadReplayReply.status, 200);
      const noReadReplayText = await noReadReplayReply.text(), noReadReplay = object(JSON.parse(noReadReplayText));
      assert.equal(noReadReplay.status, 'replayed'); assert.equal(noReadReplay.result, null);
      assert.deepEqual(noReadReplay.records, []);
      assert.equal(noReadReplayText.includes(noReadSecret), false);
      assert.equal(noReadReplayText.includes('NO_READ_HIDDEN_MARKER'), false);
      assert.deepEqual(await snapshot(db), noReadSaved); assert.equal(commits, 2);
      assert.equal(noReadSaved.records!.length, noReadBefore.records!.length + 1);
      assert.deepEqual(hostFailures, []); assert.equal(await captureIsCurrent(capture), true);
      assert.deepEqual(await readFile(sourcePath), original);
    } finally {
      try { if (server) { server.closeAllConnections(); if (server.listening) await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done())); } }
      finally { try { await worker?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } }
      assert.deepEqual(await readFile(sourcePath), original);
    }
  });
