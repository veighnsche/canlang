/** Actual native artifacts, installed producers, D1 and HTTP/MCP consumers. */
import { resolve, join } from 'node:path';
import { compileFunction, constants } from 'node:vm';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createD1IdentityStore, ensureIdentitySchema, hashPassword, deriveCsrfToken } from '@canlang/identity';
import type { D1Database } from '@cloudflare/workers-types';
import { distribution as valuesDistribution } from '@canlang/values/distribution';
import { prepareLocalPreviewCapture } from '../src/runtime/native-dev.test-support.js';
import { captureIsCurrent, captureSingleFileSource } from '../src/runtime/native-dev.test-support.js';
import { compileCapturedSingleFile } from '../src/runtime/native-dev.test-support.js';
import { openNativePreview } from '../src/runtime/native-preview.test-support.js';

const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

it('starts a source-current native model-free preview through actual global D1 activation', async () => {
  const capture = await captureSingleFileSource(prepareLocalPreviewCapture({
    checkoutRoot: repo,
    appPath: join(repo, 'tests/integration/can-dev-server/ModelFreePreview.can'),
    compilerPath: join(repo, 'compiler/target/debug/can'),
    catalogPath: fileURLToPath(valuesDistribution.catalog),
    helpIndexPath: join(repo, 'docs/specification/CONSTRUCT-HELP.md'),
  }));
  expect(await captureIsCurrent(capture)).toBe(true);
  const compiled = await compileCapturedSingleFile(capture);
  expect(compiled.kind, JSON.stringify(compiled.kind === 'artifact' ? {} : compiled)).toBe('artifact');
  if (compiled.kind !== 'artifact') throw new Error(`native compilation failed: ${compiled.kind}`);
  expect(compiled.artifact.models ?? []).toEqual([]);
  expect(compiled.artifact.operations).toHaveLength(1);
  expect(compiled.artifact.pages).toHaveLength(1);
  expect(compiled.artifact.sources).toEqual([{ path: capture.compilerOperand, sha256: capture.sourceSha256 }]);

  // This public installed producer runs real preflight and serving DB gates;
  // readiness cannot be manufactured with a supplied activation verdict.
  const preview = await openNativePreview(compiled.artifact, capture, compiled.artifactBytes);
  try {
    expect(await captureIsCurrent(capture)).toBe(true);
    const issueOpenUrl = preview.issueOpenUrl;
    if (typeof issueOpenUrl !== 'function') throw new Error('installed preview has no protected-open producer');
    const opened = await issueOpenUrl();
    const origin = new URL(opened).origin;
    expect(new URL(origin).hostname).toBe('127.0.0.1');
    const cookies = new Map<string, string>();
    const request = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (cookies.size > 0) headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
      if (init.method === 'POST') headers.set('origin', origin);
      const response = await fetch(new URL(path, origin), { ...init, headers, redirect: 'manual' });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';', 1)[0]!;
        const index = pair.indexOf('=');
        cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return response;
    };
    expect((await fetch(origin, { redirect: 'manual' })).status).toBe(401);
    const bootstrap = await request(opened);
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get('location')).toBe('/');
    expect((await request(opened)).status).toBe(403);
    const actors = preview.issueLocalActors();
    const actor = actors.find(candidate => candidate.label === 'Ava');
    expect(actor).toBeDefined();
    const descriptor = await request('/auth/login');
    expect(descriptor.status).toBe(200);
    const loginDescriptor = await descriptor.json() as { preSessionToken: string };
    const login = await request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: actor!.email, password: actor!.password, _presession: loginDescriptor.preSessionToken }) });
    expect(login.status).toBe(200);
    const session = cookies.get('can_session');
    expect(session).toBeDefined();
    const teamsResponse = await request('/auth/teams');
    expect(teamsResponse.status).toBe(200);
    const teams = await teamsResponse.json() as { teams: Array<{ team_id: string }> };
    expect(teams.teams.length).toBeGreaterThan(0);
    const csrf = await deriveCsrfToken(decodeURIComponent(session!));
    const selected = await request('/auth/select-team', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ team: teams.teams[0]!.team_id, _csrf: csrf }) });
    expect(selected.status).toBe(200);
    const page = await request('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('Model-free preview');
    expect(html).toContain('Model-free generated page');
    expect(html).toContain('/assets/browser/bootstrap.js');
    for (const path of ['/assets/browser/bootstrap.js', '/assets/browser/can-style.css', '/assets/browser/polling.js']) {
      const asset = await request(path);
      expect(asset.status, path).toBe(200);
      expect(asset.headers.get('content-type')).toContain(path.endsWith('.css') ? 'text/css' : 'application/javascript');
      expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
    expect(await captureIsCurrent(capture)).toBe(true);
  } finally { await preview.dispose(); }
  expect(() => preview.issueLocalActors()).toThrow(/disposal/);
}, 120000);


function operationIdAt(ms: number): string {
  const time = ms.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0,8)}-${time.slice(8)}-7${random.slice(0,3)}-8${random.slice(4,7)}-${random.slice(7,19)}`;
}

/** Genuine historical records/receipts, with current transport authentication. */
async function historicalTeam(db: D1Database) {
  await ensureIdentitySchema(db);
  const at = Date.now() - 8 * 24 * 3600_000;
  const store = createD1IdentityStore(db, { clock: { nowMs: () => at } });
  const password = 'Historical team integration password';
  const password_hash = await hashPassword(password);
  const [ava, ben, eve, rae, cal] = await Promise.all(['ava', 'ben', 'eve', 'rae', 'cal'].map(name =>
    store.createUser({ email: `${name}@historical.example`, password_hash, email_verified: true })));
  const cedar = await store.createTeam({ timezone: 'UTC' }), oak = await store.createTeam({ timezone: 'UTC' });
  for (const [user, team, owner] of [[ava!, cedar, true], [eve!, cedar, true], [ben!, cedar, false],
    [rae!, cedar, false], [cal!, oak, true]] as const) {
    await store.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: owner, roles: [] });
  }
  const namespace = (operation: string) => JSON.stringify(['system.team/v1', 'NativeIdentityRemoval', cedar.team_id, ava!.user_id, operation]);
  const role = { namespace: namespace('system.team.role'), operationId: operationIdAt(at),
    team_id: cedar.team_id, member_user_id: rae!.user_id, granted_by: ava!.user_id, role: 'owner' };
  const originalRole = await store.changeMemberRoleWithReceipt!(role);
  await store.changeMemberRoleWithReceipt!({ ...role, operationId: operationIdAt(at), role: '-owner' });
  const invitations = [];
  for (const state of ['pending', 'unknown'] as const) {
    const input = { namespace: namespace('system.team.invite'), operationId: operationIdAt(at), team_id: cedar.team_id,
      email: `${state}@historical.example`, role: 'owner', invited_by: ava!.user_id };
    const receipt = await store.createInvitationWithReceipt!(input, { inviteBaseUrl: 'https://historical.example/auth/invite' });
    if (state === 'unknown') await store.claimInvitationMail!(input);
    invitations.push({ input, receipt, state });
  }
  const removal = { namespace: namespace('system.team.remove'), operationId: operationIdAt(at),
    team_id: cedar.team_id, member_user_id: ben!.user_id, removed_by: ava!.user_id };
  await store.removeMemberWithOccurrence!(removal);
  return { actors: [{ label: 'Ava', email: ava!.email, password }],
    owners: [{ owner: cedar.team_id, binding: 'CEDAR' }, { owner: oak.team_id, binding: 'OAK' }],
    role, originalRole, invitations, removal, coOwner: eve!.user_id, at };
}

const teamJourneys = {
  'fresh-removal': 'recovers and executes the genuine removed-member handler once across interrupted handoff and owner D1 reopen',
  'expired-removal': 'replays genuine expired team receipts through HTTP and MCP and recovers their original removal handoff',
  'invitation-mail': 'acknowledges configured invitation mail through installed hosting and accepts only the addressed account',
} as const;
for (const mode of Object.keys(teamJourneys) as Array<keyof typeof teamJourneys>) it(teamJourneys[mode], async () => {
  const nativeImport = compileFunction('return import(url)', ['url'], {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }) as (url: string) => Promise<unknown>;
  const native = await nativeImport(new URL('../dist/runtime/native-dev.test-support.js', import.meta.url).href) as
    typeof import('../src/runtime/native-dev.test-support.js');
  const hosts = await nativeImport(new URL('../dist/runtime/native-preview.test-support.js', import.meta.url).href) as
    typeof import('../src/runtime/native-preview.test-support.js');
  const capture = await native.captureSingleFileSource(native.prepareLocalPreviewCapture({ checkoutRoot: repo,
    appPath: join(repo, 'packages/cloudflare/test/fixtures/native-identity-removal-source.can'),
    compilerPath: join(repo, 'compiler/target/debug/can'), catalogPath: fileURLToPath(valuesDistribution.catalog),
    helpIndexPath: join(repo, 'docs/specification/CONSTRUCT-HELP.md') }));
  const compiled = await native.compileCapturedSingleFile(capture);
  expect(compiled.kind, JSON.stringify(compiled.kind === 'artifact' ? {} : compiled)).toBe('artifact');
  if (compiled.kind !== 'artifact') throw new Error('Native removal source did not compile.');
  expect(compiled.artifact.callables.some(callable => callable.id === 'NativeIdentityRemoval.observed' && callable.kind === 'handler')).toBe(true);
  const evidence = await hosts.nativePreviewEvidence(compiled.artifact, capture);
  const persistence = await mkdtemp(join(tmpdir(), 'can-native-removal-'));
  const databaseId = `removal-identity-${randomUUID()}`, workerName = `native-removal-${randomUUID()}`;
  let worker: Awaited<ReturnType<typeof hosts.startLocalDev>> | undefined;
  let provision: Awaited<ReturnType<typeof hosts.startLocalDev>> | undefined;
  let gateway: Awaited<ReturnType<typeof hosts.startNativeGateway>> | undefined;
  try {
    provision = await hosts.startLocalDev({ workerName: `${workerName}-seed`, compatibilityDate: '2026-07-15',
      mainModule: 'seed.js', modules: { 'seed.js': 'export default {fetch(){return new Response(null,{status:404})}};' },
      d1Databases: [{ binding: 'DB', id: databaseId }], d1Persist: persistence });
    const historical = mode === 'expired-removal' ? await historicalTeam(await provision.getD1Database('DB')) : undefined;
    const seeded = historical ?? await hosts.seedLocalPreviewActors(await provision.getD1Database('DB'));
    await provision.dispose(); provision = undefined;
    const owners = seeded.owners.map(owner => ({ ...owner, id: `removal-owner-${randomUUID()}` }));
    gateway = await hosts.startNativeGateway();
    const origin = gateway.url;
    const vars = { ...await hosts.selectPreviewWorkerVars({ resources: {
      d1: { binding: 'DB', availability: 'real_local' }, identity: { backingBinding: 'DB', availability: 'real_local' } } }, origin),
      CAN_FORM_BINDING_KEY: randomBytes(32).toString('base64url'),
      CAN_STATE_OWNERS: { version: 1, owners: owners.map(owner => ({ owner: owner.owner, binding: owner.binding, initializeFresh: true })) } };
    const start = (resourceRecovery = false) => hosts.startLocalDev({ workerName, resourceRecovery, compatibilityDate: '2026-07-15',
      mainModule: evidence.bundle.mainModule, modules: evidence.bundle.modules, binaryModules: evidence.bundle.binaries,
      d1Databases: [{ binding: 'DB', id: databaseId }, ...owners.map(owner => ({ binding: owner.binding, id: owner.id }))],
      d1Persist: persistence, vars,
      ...(mode !== 'invitation-mail' ? {} : {
        serviceBindings: { CAN_AUTH_MAIL: { name: `${workerName}-mail`, entrypoint: 'AuthMail' } },
        companionWorkers: [{ workerName: `${workerName}-mail`, compatibilityDate: '2026-07-15', mainModule: 'mail.js',
          d1Databases: [{ binding: 'SINK', id: databaseId }], modules: { 'mail.js': `
            import { WorkerEntrypoint } from 'cloudflare:workers';
            export class AuthMail extends WorkerEntrypoint {
              async sendMail(to, subject, body) {
                await this.env.SINK.prepare('INSERT INTO account_mail_sink (recipient,subject,body) VALUES (?,?,?)').bind(to,subject,body).run();
                if (to.startsWith('lost-')) throw new Error('Mail service acknowledgement lost');
                if (to.startsWith('nonvoid-')) return { status: 'unknown' };
              }
            }
            export default { fetch() { return new Response(null, {status:404}); } };
          ` } }],
      }) });
    worker = await start();
    await gateway.setBackend(worker.backend);
    let identityDb = await worker.getD1Database('DB');
    for (const owner of owners) {
      expect((await hosts.localPreviewActivationVerdict(compiled.artifact, capture,
        await worker.getD1Database(owner.binding), owner.id, owner.owner, identityDb)).active).toBe(true);
    }
    const candidates = await identityDb.prepare("SELECT m.team_id, m.user_id, u.email FROM identity_memberships m JOIN identity_users u ON u.user_id=m.user_id WHERE m.status='active' AND m.is_owner=1 ORDER BY m.team_id").all<{ team_id: string; user_id: string; email: string }>();
    const owner = candidates.results.find(candidate => seeded.actors.some(actor => actor.label === 'Ava' && actor.email === candidate.email));
    expect(owner).toBeDefined();
    if (owner === undefined) throw new Error('Real seeded owner is unavailable.');
    const credentials = seeded.actors.find(actor => actor.email === owner.email)!;
    const target = historical === undefined
      ? await identityDb.prepare("SELECT membership_id,user_id FROM identity_memberships WHERE team_id=? AND user_id<>? AND status='active' AND is_owner=0 ORDER BY user_id LIMIT 1")
        .bind(owner.team_id, owner.user_id).first<{ membership_id: string; user_id: string }>()
      : await identityDb.prepare('SELECT membership_id,user_id FROM identity_memberships WHERE team_id=? AND user_id=?')
        .bind(owner.team_id, historical.removal.member_user_id).first<{ membership_id: string; user_id: string }>();
    expect(target).not.toBeNull();
    if (target === null) throw new Error('Real seeded team member is unavailable.');
    const selected = owners.find(item => item.owner === owner.team_id); expect(selected).toBeDefined();
    if (selected === undefined) throw new Error('Serving team owner is unavailable.');
    let ownerDb = await worker.getD1Database(selected.binding);
    const cookies = new Map<string, string>();
    const request = async (path: string, body?: unknown, csrf?: string) => {
      const response = await worker!.dispatchUrl(new URL(path, origin).href, {
        method: body === undefined ? 'GET' : 'POST', headers: {
          cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), origin,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';', 1)[0]!, at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
      return response;
    };
    const login = await request('/auth/login');
    if (login.status !== 200) {
      // Failure diagnostics deliberately exclude headers, cookies, raw bodies
      // and successful login descriptors (which contain pre-session tokens).
      let failure: unknown;
      try { failure = await login.clone().json(); } catch { failure = null; }
      const body = failure !== null && typeof failure === 'object' && !Array.isArray(failure)
        ? failure as Record<string, unknown> : {};
      const error = body.error !== null && typeof body.error === 'object' && !Array.isArray(body.error)
        ? body.error as Record<string, unknown> : body;
      expect(login.status, JSON.stringify({
        code: typeof error.code === 'string' ? error.code : 'unavailable',
        message: typeof error.message === 'string' ? error.message : 'No structured failure message.',
      })).toBe(200);
    }

    const descriptor = await login.json() as { preSessionToken: string };
    expect((await request('/auth/login', { email: credentials.email, password: credentials.password,
      _presession: descriptor.preSessionToken })).status).toBe(200);
    const session = cookies.get('can_session'); expect(session).toBeDefined();
    const csrf = await deriveCsrfToken(decodeURIComponent(session!));
    expect((await request('/auth/select-team', { team: owner.team_id, _csrf: csrf }, csrf)).status).toBe(200);
    if (mode === 'invitation-mail') {
      await identityDb.exec('CREATE TABLE account_mail_sink (id INTEGER PRIMARY KEY, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL)');
      const identities = createD1IdentityStore(identityDb);
      const invitedPassword = 'Addressed invitation integration password';
      const password_hash = await hashPassword(invitedPassword);
      const addressed = await identities.createUser({ email: 'addressed@mail.example', password_hash, email_verified: true });
      const unverified = await identities.createUser({ email: 'unverified@mail.example', password_hash, email_verified: true });
      const grantResponse = await request('/mcp/grants', { client_id: 'invitation-mail-consumer' }, csrf);
      expect(grantResponse.status).toBe(200);
      const grant = await grantResponse.json() as { token: string };
      const invite = (id: string, email: string, token = csrf) => request('/api/operations/system.team.invite',
        { operation_id: id, inputs: { email, role: 'owner' } }, token);
      const mcpInvite = async (id: string, email: string) => {
        const response = await worker!.dispatchUrl(new URL('/mcp', origin).href, { method: 'POST', headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${grant.token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call',
            params: { name: 'system.team.invite', arguments: { operation_id: id, email, role: 'owner' } } }) });
        expect(response.status).toBe(200);
        return await response.json() as { error?: unknown; result?: { isError?: boolean; structuredContent?: unknown } };
      };
      const stored = async () => ({
        offers: (await identityDb.prepare('SELECT * FROM identity_invitations ORDER BY invitation_id').all()).results,
        receipts: (await identityDb.prepare('SELECT * FROM identity_team_mutations ORDER BY operation_id').all()).results,
        mail: (await identityDb.prepare('SELECT * FROM identity_invitation_mail ORDER BY operation_id').all()).results,
        sink: (await identityDb.prepare('SELECT * FROM account_mail_sink ORDER BY id').all()).results,
      });
      const operationId = operationIdAt(Date.now());
      const untouched = await stored();
      expect((await invite(operationId, addressed.email, 'invalid-csrf')).status).toBe(403);
      expect(await stored()).toEqual(untouched);
      const created = await invite(operationId, addressed.email);
      expect(created.status, await created.clone().text()).toBe(200);
      const outcome = await created.json() as { status: string; result: { invitation_id: string; mail: string } };
      expect(outcome).toMatchObject({ status: 'committed', result: { mail: 'acknowledged' } });
      const invitationId = outcome.result.invitation_id;
      const original = await stored();
      expect(original.offers).toHaveLength(1); expect(original.receipts).toHaveLength(1);
      expect(original.mail).toHaveLength(1); expect(original.sink).toHaveLength(1);
      expect(original.sink[0]).toMatchObject({ recipient: addressed.email, subject: 'You are invited to a team' });
      const offer = await identities.findInvitationById(invitationId);
      expect(offer).not.toBeNull();
      expect(original.sink[0]!.body).toContain(new URL(`/auth/invite?invitation_id=${invitationId}`, origin).href);
      expect(original.sink[0]!.body).toContain(offer!.expires_at);
      const replay = await mcpInvite(operationId, addressed.email);
      expect(replay.error).toBeUndefined(); expect(replay.result?.isError).not.toBe(true);
      expect(replay.result?.structuredContent).toMatchObject({ status: 'replayed', result: outcome.result });
      expect((await invite(operationId, 'changed@mail.example')).status).toBe(409);
      expect(await stored()).toEqual(original);
      // The owner is authenticated, but is not the addressed account.
      expect((await request('/auth/invite', { invitation_id: invitationId }, csrf)).status).toBe(403);
      expect(await identities.findMembership(owner.team_id, addressed.user_id)).toBeNull();
      const ownerCookies = new Map(cookies);
      const loginAs = async (email: string) => {
        cookies.clear();
        const descriptor = await request('/auth/login');
        expect(descriptor.status).toBe(200);
        const input = await descriptor.json() as { preSessionToken: string };
        const loggedIn = await request('/auth/login', { email, password: invitedPassword, _presession: input.preSessionToken });
        expect(loggedIn.status).toBe(200);
        return deriveCsrfToken(decodeURIComponent(cookies.get('can_session')!));
      };
      // A matching but unverified account cannot accept its own offer.
      const unverifiedId = operationIdAt(Date.now());
      const unverifiedResponse = await invite(unverifiedId, unverified.email);
      expect(unverifiedResponse.status).toBe(200);
      const unverifiedOffer = await unverifiedResponse.json() as { result: { invitation_id: string } };
      const unverifiedCsrf = await loginAs(unverified.email);
      await identities.setUserEmailVerified(unverified.user_id, false);
      expect((await request('/auth/invite', { invitation_id: unverifiedOffer.result.invitation_id }, unverifiedCsrf)).status).toBe(403);
      const addressedCsrf = await loginAs(addressed.email);
      const descriptor = await request(`/auth/invite?invitation_id=${invitationId}`);
      expect(descriptor.status).toBe(200);
      expect(await descriptor.json()).toMatchObject({ inputs: { invitation_id: invitationId }, csrfToken: addressedCsrf });
      expect((await request('/auth/invite', { invitation_id: invitationId })).status).toBe(403);
      expect(await identities.findMembership(owner.team_id, addressed.user_id)).toBeNull();
      const accepted = await request('/auth/invite', { invitation_id: invitationId }, addressedCsrf);
      expect(accepted.status, await accepted.clone().text()).toBe(200);
      expect(await identities.findMembership(owner.team_id, addressed.user_id)).toMatchObject({ status: 'active', is_owner: true, roles: [] });
      expect((await identities.findInvitationById(invitationId))!.accepted_at).not.toBeNull();
      expect((await request('/auth/invite', { invitation_id: invitationId }, addressedCsrf)).status).toBe(400);
      cookies.clear(); for (const [key, value] of ownerCookies) cookies.set(key, value);
      const control = { namespace: 'configured-mail-fixture-control', team_id: owner.team_id,
        member_user_id: owner.user_id, granted_by: addressed.user_id };
      await identities.changeMemberRoleWithReceipt!({ ...control, operationId: operationIdAt(Date.now()), role: '-owner' });
      const denied = await stored();
      expect((await invite(operationIdAt(Date.now()), 'denied@mail.example')).status).toBe(403);
      expect((await invite(operationId, addressed.email)).status).toBe(403);
      expect((await mcpInvite(operationIdAt(Date.now()), 'denied@mail.example')).result?.isError).toBe(true);
      expect((await mcpInvite(operationId, addressed.email)).result?.isError).toBe(true);
      expect(await stored()).toEqual(denied);
      await identities.changeMemberRoleWithReceipt!({ ...control, operationId: operationIdAt(Date.now()), role: 'owner' });
      // Unknown service outcomes (including a wrongly typed non-void reply)
      // retain the original claim and never call the service a second time.
      for (const email of ['lost-ack@mail.example', 'nonvoid-ack@mail.example']) {
        const id = operationIdAt(Date.now());
        const response = await invite(id, email);
        expect(response.status).toBe(200);
        const unknown = await response.json() as { result: { invitation_id: string; mail: string } };
        expect(unknown.result.mail).toBe('unknown');
        const saved = await stored();
        expect(saved.sink.filter(row => row.recipient === email)).toHaveLength(1);
        const retry = await mcpInvite(id, email);
        expect(retry.result?.structuredContent).toMatchObject({ status: 'replayed', result: unknown.result });
        expect(await stored()).toEqual(saved);
      }
      const terminal = await stored();
      await worker.dispose(); worker = await start();
      identityDb = await worker.getD1Database('DB');
      const reopened = await invite(operationId, addressed.email);
      expect(reopened.status, await reopened.clone().text()).toBe(200);
      expect(await reopened.json()).toMatchObject({ status: 'replayed', result: outcome.result });
      expect(await stored()).toEqual(terminal);
      expect(await native.captureIsCurrent(capture)).toBe(true);
      return;
    }
    let retainedMcp: ((operation: string, id: string, inputs: Record<string, unknown>) => Promise<{
      error?: unknown; result?: { isError?: boolean; structuredContent?: unknown };
    }>) | undefined;
    if (historical !== undefined) {
      const grantResponse = await request('/mcp/grants', { client_id: 'expired-team-consumer' }, csrf);
      expect(grantResponse.status).toBe(200);
      const grant = await grantResponse.json() as { token: string };
      const http = (operation: string, id: string, inputs: Record<string, unknown>) =>
        request(`/api/operations/system.team.${operation}`, { operation_id: id, inputs }, csrf);
      const mcp = async (operation: string, id: string, inputs: Record<string, unknown>) => {
        const response = await worker!.dispatchUrl(new URL('/mcp', origin).href, { method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${grant.token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call',
            params: { name: `system.team.${operation}`, arguments: { operation_id: id, ...inputs } } }) });
        expect(response.status).toBe(200);
        return await response.json() as { error?: unknown; result?: { isError?: boolean; structuredContent?: unknown } };
      };
      retainedMcp = mcp;
      const identityTables = ['identity_users', 'identity_memberships', 'identity_invitations', 'identity_sessions',
        'identity_mcp_grants', 'identity_member_removals', 'identity_team_mutations', 'identity_invitation_mail'];
      const stateTables = ['records', 'fence', 'fence_log', 'receipts', 'history', 'outbox', 'schedules'];
      const unchanged = async () => ({
        identity: await Promise.all(identityTables.map(table => identityDb.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().then(rows => rows.results))),
        state: await Promise.all(stateTables.map(table => ownerDb.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().then(rows => rows.results))),
      });
      const before = await unchanged();
      const inputs = { member: { id: historical.role.member_user_id }, role: 'owner' };
      const replay = await http('role', historical.role.operationId, inputs);
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(await replay.json()).toMatchObject({ status: 'replayed', result: historical.originalRole.membership });
      const roleMcp = await mcp('role', historical.role.operationId, inputs);
      expect(roleMcp.error).toBeUndefined(); expect(roleMcp.result?.isError).not.toBe(true);
      expect(roleMcp.result?.structuredContent).toMatchObject({ status: 'replayed', result: historical.originalRole.membership });
      expect(await identityDb.prepare('SELECT is_owner FROM identity_memberships WHERE team_id=? AND user_id=?')
        .bind(owner.team_id, historical.role.member_user_id).first('is_owner')).toBe(0);
      for (const offer of historical.invitations) {
        const invitationInputs = { email: offer.input.email, role: 'owner' };
        const read = await http('invite', offer.input.operationId, invitationInputs);
        expect(read.status, await read.clone().text()).toBe(200);
        const expected = { status: 'replayed', result: { invitation_id: offer.receipt.invitation.invitation_id, mail: offer.state } };
        expect(await read.json()).toMatchObject(expected);
        const readMcp = await mcp('invite', offer.input.operationId, invitationInputs);
        expect(readMcp.error).toBeUndefined(); expect(readMcp.result?.isError).not.toBe(true);
        expect(readMcp.result?.structuredContent).toMatchObject(expected);
        expect((await identityDb.prepare('SELECT expires_at FROM identity_invitations WHERE invitation_id=?')
          .bind(offer.receipt.invitation.invitation_id).first<{ expires_at: string }>())!.expires_at < new Date().toISOString()).toBe(true);
      }
      for (const [operation, id, originalInputs, skew] of [
        ['role', historical.role.operationId, inputs, { ...inputs, role: '-owner' }],
        ['invite', historical.invitations[0]!.input.operationId, { email: historical.invitations[0]!.input.email, role: 'owner' },
          { email: 'changed@historical.example', role: 'owner' }],
        ['remove', historical.removal.operationId, { member: { id: target.user_id } }, { member: { id: historical.role.member_user_id } }],
      ] as const) {
        expect((await http(operation, id, skew)).status).toBe(409);
        expect((await mcp(operation, id, skew)).result?.isError).toBe(true);
        expect((await http(operation, operationIdAt(historical.at), originalInputs)).status).toBe(400);
        const absent = await mcp(operation, operationIdAt(historical.at), originalInputs);
        expect(absent.error !== undefined || absent.result?.isError === true).toBe(true);
      }
      expect(await unchanged()).toEqual(before);
      const control = createD1IdentityStore(identityDb);
      const authority = { namespace: 'historical-fixture-control', team_id: owner.team_id, member_user_id: owner.user_id,
        granted_by: historical.coOwner };
      await control.changeMemberRoleWithReceipt!({ ...authority, operationId: operationIdAt(Date.now()), role: '-owner' });
      const deniedBefore = await unchanged();
      expect((await http('role', historical.role.operationId, inputs)).status).toBe(403);
      expect((await mcp('role', historical.role.operationId, inputs)).result?.isError).toBe(true);
      expect(await unchanged()).toEqual(deniedBefore);
      await control.changeMemberRoleWithReceipt!({ ...authority, operationId: operationIdAt(Date.now()), role: 'owner' });
    }
    const operationId = historical?.removal.operationId ?? operationIdAt(Date.now());
    const envelope = { operation_id: operationId, inputs: { member: { id: target.user_id } } };
    const remove = () => request('/api/operations/system.team.remove', envelope, csrf);
    // Interrupt the real cross-owner handoff after Identity has sealed its
    // original removal. The State transaction must roll back in full.
    const beforeFence = (await ownerDb.prepare('SELECT * FROM fence_log').all()).results;
    await ownerDb.exec("CREATE TRIGGER reject_removal_handoff BEFORE INSERT ON records WHEN NEW.model='work.occurrence' BEGIN SELECT RAISE(ABORT, 'interrupted removal handoff'); END");
    const interrupted = await remove();
    const interruption = await interrupted.json() as { code?: string; message?: string };
    expect(interrupted.status, JSON.stringify(interruption)).toBe(422);
    expect(interruption.message).toContain('interrupted removal handoff');
    expect(await identityDb.prepare('SELECT COUNT(*) AS count FROM identity_member_removals WHERE operation_id=?')
      .bind(operationId).first('count')).toBe(1);
    expect((await ownerDb.prepare('SELECT * FROM records WHERE model IN (?,?)')
      .bind('work.occurrence', 'work.handler_occurrence').all()).results).toEqual([]);
    expect((await ownerDb.prepare('SELECT * FROM fence_log').all()).results).toEqual(beforeFence);
    await ownerDb.exec('DROP TRIGGER reject_removal_handoff');
    const recovered = await remove(); expect(recovered.status, await recovered.clone().text()).toBe(200);
    expect(await recovered.json()).toMatchObject({ status: 'replayed', operation_id: operationId, result: { removed: true } });
    const snapshot = async () => ({
      removal: (await identityDb.prepare('SELECT * FROM identity_member_removals WHERE operation_id=?').bind(operationId).all()).results,
      member: await identityDb.prepare('SELECT * FROM identity_memberships WHERE membership_id=?').bind(target.membership_id).first(),
      work: (await ownerDb.prepare('SELECT * FROM records WHERE model IN (?,?) ORDER BY model,id')
        .bind('work.occurrence', 'work.handler_occurrence').all<{ id: string; model: string; data: string }>()).results,
      revision: (await ownerDb.prepare('SELECT * FROM fence_log').all()).results,
    });
    const saved = await snapshot();
    expect(saved.removal).toHaveLength(1);
    expect(saved.member).toMatchObject({ status: 'removed' });
    const original = saved.removal[0] as Record<string, unknown>;
    expect(original).toMatchObject({ team_id: owner.team_id, user_id: target.user_id, removed_by: owner.user_id });
    const work = saved.work.map(row => ({ ...row, value: JSON.parse(row.data) as Record<string, unknown> }));
    const source = work.filter(row => row.model === 'work.occurrence');
    const handlers = work.filter(row => row.model === 'work.handler_occurrence');
    expect(source).toHaveLength(1); expect(handlers).toHaveLength(1);
    expect(source[0]!.id).toBe(original.event_id);
    expect(source[0]!.value).toMatchObject({ status: 'completed', result: { kind: 'identity-removal-source',
      envelope: { producerEventId: original.event_id, operationId, membershipRemoval: { user: { id: target.user_id } } } } });
    expect(handlers[0]!.value).toMatchObject({ state: 'pending', sourceOccurrence: original.event_id,
      handler: 'NativeIdentityRemoval.observed', event: 'teams.member_removed', scopeApp: 'NativeIdentityRemoval', scopeOwner: owner.team_id,
      payload: { team_id: owner.team_id, membership_id: target.membership_id, user: { id: target.user_id } } });
    const retry = await remove(); expect(retry.status, await retry.clone().text()).toBe(200);
    expect(await retry.json()).toMatchObject({ status: 'replayed' });
    expect(await snapshot()).toEqual(saved);
    if (retainedMcp !== undefined) {
      const replay = await retainedMcp('remove', operationId, { member: { id: target.user_id } });
      expect(replay.error).toBeUndefined(); expect(replay.result?.isError).not.toBe(true);
      expect(replay.result?.structuredContent).toMatchObject({ status: 'replayed', result: { removed: true } });
      expect(await snapshot()).toEqual(saved);
    }
    // Retaining the original adapter must never cache its physical-owner grant.
    const foreign = owners.find(candidate => candidate.owner !== owner.team_id)!;
    await ownerDb.prepare('UPDATE state_owner_pin SET owner=? WHERE id=1').bind(foreign.owner).run();
    const repinned = await remove(); expect(repinned.status).toBe(403);
    expect(await snapshot()).toEqual(saved);
    await ownerDb.prepare('UPDATE state_owner_pin SET owner=? WHERE id=1').bind(owner.team_id).run();
    await worker.dispose(); worker = await start(true);
    identityDb = await worker.getD1Database('DB'); ownerDb = await worker.getD1Database(selected.binding);
    // The existing installed scheduled entry must restore the genuine source
    // and execute the retained handler without a user retry installing it first.
    const deadline = Date.now() + 15_000;
    let completed: Array<{ data: string }> = [];
    while (Date.now() < deadline) {
      completed = (await ownerDb.prepare('SELECT data FROM records WHERE model=?')
        .bind('NativeIdentityRemoval.Removal').all<{ data: string }>()).results;
      if (completed.length === 1) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(completed).toHaveLength(1);
    expect(JSON.parse(completed[0]!.data)).toEqual({ subject: { id: target.user_id },
      team: owner.team_id, membership: target.membership_id });
    const terminal = await snapshot();
    expect(terminal.removal).toEqual(saved.removal); expect(terminal.member).toEqual(saved.member);
    expect(terminal.work.filter(row => row.model === 'work.occurrence' && row.id === original.event_id)).toEqual(
      saved.work.filter(row => row.model === 'work.occurrence'));
    expect(terminal.work.filter(row => row.model === 'work.handler_occurrence').map(row => JSON.parse(row.data))).toEqual([
      expect.objectContaining({ state: 'completed', sourceOccurrence: original.event_id, handler: 'NativeIdentityRemoval.observed' })]);
    const reopened = await remove(); expect(reopened.status, await reopened.clone().text()).toBe(200);
    expect(await reopened.json()).toMatchObject({ status: 'replayed' });
    expect(await snapshot()).toEqual(terminal);
    expect((await ownerDb.prepare('SELECT data FROM records WHERE model=?')
      .bind('NativeIdentityRemoval.Removal').all()).results).toEqual(completed);
    expect(await native.captureIsCurrent(capture)).toBe(true);
  } finally {
    await worker?.dispose(); await provision?.dispose(); await gateway?.close();
    await rm(persistence, { recursive: true, force: true });
  }
}, 240_000);
