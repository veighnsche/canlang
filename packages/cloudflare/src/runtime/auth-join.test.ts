import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import { CONTRACTS_VERSION, TEAM_FIELD } from '@canlang/contracts';
import type { CompileArtifact } from '@canlang/contracts';
import { createD1IdentityStore, deriveCsrfToken, hashPassword } from '@canlang/identity';
import { checkActivationInventory } from '@canlang/state/migration/activate';
import { buildWorkInventory } from '@canlang/work/recovery';
import { uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { assertLinksResolve, assertWorkerdLoadable, buildDeployBundle } from '../deploy/bundle.js';
import { activate } from '../deploy/activate.js';
import { probeInstalledRuntime } from '../deploy/installed.js';
import { buildProductionDeps, validateDeploymentBase } from '../runtime/env-assembly.js';

// The normal shipped main and production dependency loader consume trusted host vars.
test('installed bundled auth joins real local D1 sessions, teams and canonical operations', async () => {
  const fixturePath = resolve('packages/cloudflare/test/fixtures/typed-context-scopes.json');
  const bytes = await readFile(fixturePath);
  const artifact = JSON.parse(bytes.toString()) as CompileArtifact;
  const dir = await mkdtemp(join(tmpdir(), 'can-auth-join-'));
  const mf = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: { DB: 'auth-join' } });
  try {
    let db = await mf.getD1Database('DB') as unknown as D1Database;
    assert.equal(validateDeploymentBase('http://127.0.0.1:43217'), 'http://127.0.0.1:43217');
    assert.equal(validateDeploymentBase('https://DEPLOY.example/'), 'https://DEPLOY.example/');
    // Open Miniflare's own D1 bookkeeping before capturing all physical tables.
    await db.prepare('SELECT 1').first();
    const pristine = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).results;
    for (const invalid of [undefined, 42, 'not-a-url', 'ftp://deployment.example',
      'https://user:password@deployment.example', 'https://deployment.example?query=1',
      'https://deployment.example#fragment', 'https://deployment.example/mounted/']) {
      await assert.rejects(buildProductionDeps({ DB: db, CAN_DEPLOYMENT_BASE: invalid }),
        invalid === 'https://deployment.example/mounted/' ? /nonroot mount is unsupported/ : /CAN_DEPLOYMENT_BASE/);
      assert.deepEqual((await db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).results, pristine,
        'invalid explicit deployment configuration precedes schema writes');
    }
    let baseGetterReads = 0;
    await assert.rejects(buildProductionDeps({ DB: db, get CAN_DEPLOYMENT_BASE() { baseGetterReads++; return 'https://deployment.example'; } }), /own configuration data/);
    assert.equal(baseGetterReads, 0);
    let production = await buildProductionDeps({ DB: db });
    assert.equal(production.deploymentBase, undefined, 'no request or auth fallback');
    let identities = createD1IdentityStore(db);
    for (const invalid of ['not-an-origin', 'ftp://auth.example', 'http://localhost/', 'http://localhost/path',
      'http://localhost?query=1', 'http://user:password@localhost', 'http://localhost#fragment']) {
      await assert.rejects(buildProductionDeps({ DB: db, CAN_AUTH_ORIGIN: invalid }), /CAN_AUTH_ORIGIN/);
    }
    const configured = await buildProductionDeps({ DB: db, CAN_AUTH_ORIGIN: 'https://auth.example', CAN_DEPLOYMENT_BASE: 'https://DEPLOY.example/' });
    assert.equal(configured.deploymentBase, 'https://DEPLOY.example/', 'the original validated host string survives unchanged');
    assert.equal(configured.auth?.origin, 'https://auth.example');
    assert.equal(configured.auth?.secureCookies, true);
    assert.equal(configured.auth?.mail, undefined);
    const password = 'ordinary-account-password';
    const member = await identities.createUser({ email: 'member@auth.example',
      password_hash: await hashPassword(password), email_verified: true });
    const outsider = await identities.createUser({ email: 'outsider@auth.example',
      password_hash: await hashPassword(password), email_verified: true });
    const team = await identities.createTeam({});
    const otherTeam = await identities.createTeam({});
    await identities.createMembership({ team_id: team.team_id, user_id: member.user_id, is_owner: true, roles: [] });
    await identities.createMembership({ team_id: otherTeam.team_id, user_id: outsider.user_id, is_owner: true, roles: [] });
    const source = artifact.sources[0]!;
    const binding = { binding: 'DB', kind: 'd1' as const, logicalName: 'auth-local-d1' };
    const capabilities = [...new Set(['d1-batch', ...artifact.requires.map(r => r.capability)])];
    const verdict = await activate({ artifact,
      descriptor: { identity: { appName: 'TypedContextScopes', sourceRevision: source.sha256,
        languageVersion: artifact.language_version, compilerVersion: artifact.tool_version, contractsVersion: CONTRACTS_VERSION,
        artifactDigest: createHash('sha256').update(bytes).digest('hex') },
      requiredCapabilities: capabilities, resourceBindings: [binding], secrets: [], schedules: [] },
      environment: { environment: 'auth-local-d1', resources: [{ requirement: binding, resourceId: 'auth-join' }], secretsPresent: [], vars: {} },
      installed: probeInstalledRuntime({}, { contractsVersion: CONTRACTS_VERSION, runtimeVersion: artifact.tool_version,
        knownLanguageVersions: [artifact.language_version], capabilities, supportsSchedules: true }),
      store: production.store, inventory: { outboxItems: [], handlerContractFor: () => null,
        plan: { migrationId: 'auth-local-d1', invalidates: [] } },
      gates: { buildWorkInventory, checkActivationInventory: (store, plan, inventory) =>
        checkActivationInventory(store, plan as Parameters<typeof checkActivationInventory>[1], inventory) } });
    assert.equal(verdict.active, true, JSON.stringify(verdict));
    const deployment = buildDeployBundle(artifact, { verdict,
      workerDistDir: fileURLToPath(new URL('../worker', import.meta.url)),
      runtimeDistDir: fileURLToPath(new URL('./', import.meta.url)) });
    const modules = deployment.modules;
    assertLinksResolve(modules); assertWorkerdLoadable(modules);
    const update = async (origin: string | undefined, withDb = true) => { await mf.setOptions({
      compatibilityDate: '2026-07-15',
      modules: [[deployment.mainModule, modules[deployment.mainModule]!], ...Object.entries(modules).filter(([path]) => path !== deployment.mainModule)].map(([path, contents]) => ({ path, type: 'ESModule' as const, contents })),
      modulesRoot: resolve('.'),
      bindings: origin === undefined ? {} : { CAN_AUTH_ORIGIN: origin },
      ...(withDb ? { d1Databases: { DB: 'auth-join' } } : {}),
    });
      if (withDb) {
        db = await mf.getD1Database('DB') as unknown as D1Database;
        // The raw storage consumer remains valid without auth configuration.
        production = await buildProductionDeps({ DB: db });
        identities = createD1IdentityStore(db);
      }
    };
    const request = (path: string, body?: object, headers: Record<string, string> = {}) =>
      mf.dispatchFetch(`http://localhost${path}`, body === undefined ? { headers } : {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    await update(undefined);
    const missingOrigin = await request('/auth/login');
    assert.equal(missingOrigin.status, 500);
    assert.equal((await missingOrigin.json() as { code: string }).code, 'auth-configuration');
    await update('not-an-origin');
    assert.equal((await request('/auth/login')).status, 500);
    await update('http://localhost');
    assert.ok(await identities.findUserByEmail(member.email), 'Reconfiguration preserves the actual same D1 identity data.');
    const credentialRows = async () => Promise.all(['identity_presession_tokens', 'identity_sessions', 'identity_mcp_grants']
      .map(async table => (await db.prepare(`SELECT * FROM ${table}`).all()).results
        .map(value => JSON.stringify(value)).sort()));
    const login = async (email: string) => {
      const descriptor = await request('/auth/login', undefined, { origin: 'http://localhost' });
      assert.equal(descriptor.status, 200);
      const descriptorCookie = descriptor.headers.get('set-cookie')!;
      assert.match(descriptorCookie, /^can_presession=/);
      assert.match(descriptorCookie, /HttpOnly/); assert.match(descriptorCookie, /SameSite=Lax/);
      assert.match(descriptorCookie, /Max-Age=600/); assert.doesNotMatch(descriptorCookie, /(?:; Domain=|; Secure)/);
      const presessionCookie = descriptorCookie.split(';')[0]!;
      const { preSessionToken } = await descriptor.json() as { preSessionToken: string };
      const body = { email, password, _presession: preSessionToken };
      if (email === member.email) {
        for (const origin of ['https://foreign.example', 'null']) {
          const beforeOrigin = await credentialRows();
          assert.equal((await request('/auth/login', undefined, { origin })).status, 403);
          assert.equal((await request('/auth/login', body, { cookie: presessionCookie, origin })).status, 403);
          assert.deepEqual(await credentialRows(), beforeOrigin, 'Origin refusal neither issues nor consumes credentials');
        }
      }
      const loginHeaders = { cookie: presessionCookie, origin: 'http://localhost' };
      const signedIn = await request('/auth/login', body, loginHeaders);
      assert.equal(signedIn.status, 200);
      const responseCookies = signedIn.headers.getSetCookie();
      assert.equal(responseCookies.length, 2);
      const setCookie = responseCookies.find(value => value.startsWith('can_session='))!;
      const clearedPresession = responseCookies.find(value => value.startsWith('can_presession='))!;
      assert.match(clearedPresession, /^can_presession=;/);
      assert.match(clearedPresession, /Max-Age=0/);
      assert.match(clearedPresession, /HttpOnly/); assert.match(clearedPresession, /SameSite=Lax/);
      assert.doesNotMatch(clearedPresession, /; Domain=/);
      assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Lax/);
      assert.match(setCookie, /Max-Age=604800/); assert.doesNotMatch(setCookie, /; Secure/);
      assert.equal((await request('/auth/login', body, loginHeaders)).status, 403);
      const cookie = setCookie.split(';')[0]!;
      const token = decodeURIComponent(cookie.slice('can_session='.length));
      return { cookie, 'x-csrf-token': await deriveCsrfToken(token), origin: 'http://localhost' };
    };
    const headers = await login(member.email);
    for (const origin of ['https://foreign.example', 'null']) {
      const beforeOrigin = await credentialRows();
      assert.equal((await request('/auth/select-team', { [TEAM_FIELD]: team.team_id }, { ...headers, origin })).status, 403);
      assert.equal((await request('/mcp/grants', { client_id: 'auth-join' }, { ...headers, origin })).status, 403);
      assert.deepEqual(await credentialRows(), beforeOrigin, 'good CSRF does not permit foreign-Origin cookie mutation');
    }
    assert.equal((await request('/auth/select-team', { [TEAM_FIELD]: team.team_id }, { cookie: headers.cookie })).status, 403);
    assert.equal((await request('/auth/select-team', { [TEAM_FIELD]: team.team_id }, headers)).status, 200);
    const call = () => ({ operation_id: uuidv7(Date.now(), 1), inputs: {} });
    const before = await production.store.readRevision();
    assert.equal((await request('/api/operations/TypedContextScopes.capture', call())).status, 403);
    assert.equal(await production.store.readRevision(), before);
    const capture = await request('/api/operations/TypedContextScopes.capture', call(), headers);
    assert.equal(capture.status, 200, await capture.text());
    const rows = await production.store.query({ model: 'TypedContextScopes.Trace' as never, authority: 'owner' });
    assert.equal(rows.length, 1); assert.equal(rows[0]!.data['who'], member.user_id);
    assert.equal(rows[0]!.data['scope'], team.team_id);
    const granted = await request('/mcp/grants', { client_id: 'auth-join' }, headers);
    assert.equal(granted.status, 200);
    const { token: grant } = await granted.json() as { token: string };
    const rpc = await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'TypedContextScopes.capture', arguments: { operation_id: uuidv7(Date.now(), 2) } } }, {
        authorization: `Bearer ${grant}`, accept: 'application/json, text/event-stream' });
    assert.equal(rpc.status, 200);
    const rpcBody = await rpc.json() as { result?: { content: Array<{ text: string }> } };
    assert.equal(JSON.parse(rpcBody.result!.content[0]!.text).status, 'committed');
    assert.equal((await production.store.query({ model: 'TypedContextScopes.Trace' as never, authority: 'owner' })).length, 2);

    const outsiderHeaders = await login(outsider.email);
    const unchanged = await production.store.readRevision();
    assert.equal((await request('/auth/select-team', { [TEAM_FIELD]: team.team_id }, outsiderHeaders)).status, 403);
    assert.equal((await request('/api/operations/TypedContextScopes.capture', call(), outsiderHeaders)).status, 403);
    assert.equal(await production.store.readRevision(), unchanged);
    assert.equal((await request('/auth/register', { email: 'new@auth.example', password })).status, 503);
    assert.equal(await identities.findUserByEmail('new@auth.example'), null);
    const emailTokenCount = async () => db.prepare('SELECT COUNT(*) AS n FROM identity_email_tokens').first<{ n: number }>();
    const beforeMail = await emailTokenCount();
    assert.equal((await request('/auth/recover', { email: member.email })).status, 503);
    assert.deepEqual(await emailTokenCount(), beforeMail);
    assert.equal((await request('/auth/select-team/clear', {}, headers)).status, 200);
    assert.equal((await request('/api/operations/TypedContextScopes.capture', call(), headers)).status, 403);
    assert.equal((await request('/auth/logout', {}, headers)).status, 200);
    assert.equal((await request('/api/operations/TypedContextScopes.identify', call(), headers)).status, 403);
    // Two descriptor mints above used the same durable route/client window.
    for (let mint = 0; mint < 8; mint++) assert.equal((await request('/auth/login')).status, 200);
    const throttled = await request('/auth/login');
    assert.equal(throttled.status, 429);
    assert.ok(Number(throttled.headers.get('retry-after')) > 0);

    await update('http://localhost', false);
    assert.equal((await request('/auth/login')).status, 500);
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
