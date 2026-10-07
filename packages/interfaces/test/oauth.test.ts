/**
 * S7 OAuth HTTP tests: metadata, registration, two-step authorize, the
 * token endpoint, and top-level mount — all against the real identity
 * memory store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCsrfToken, resolveIdentity } from '@canlang/identity';
import { handleOAuthRequest } from '../src/oauth/routes.js';
import { createHttpHandler } from '../src/http/routes.js';
import {
  createTestDeps,
  createTestOAuthDeps,
  testRequest,
} from '../src/testing.js';
import type { TestOAuthDeps } from '../src/testing.js';

const REDIRECT = 'https://app.example/callback';
// RFC 7636 Appendix B test vector.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function postJson(path: string, body: unknown, opts: { cookie?: string; csrf?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.csrf !== undefined) headers['x-csrf-token'] = opts.csrf;
  return testRequest(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    ...(opts.cookie === undefined ? {} : { cookie: opts.cookie }),
  });
}

function postForm(path: string, params: Record<string, string>): Request {
  return testRequest(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

function get(path: string, cookie?: string): Request {
  return testRequest(
    path,
    cookie === undefined ? { method: 'GET' } : { method: 'GET', cookie },
  );
}

async function register(t: TestOAuthDeps, redirect_uris: string[] = [REDIRECT]): Promise<string> {
  const res = await handleOAuthRequest(t.deps, postJson('/oauth/register', { redirect_uris }));
  assert.equal(res.status, 201);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

async function authorizeCode(
  t: TestOAuthDeps,
  input: { client_id: string; redirect_uri?: string; code_verifier?: string; state?: string },
): Promise<string> {
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const res = await handleOAuthRequest(
    t.deps,
    postJson(
      '/oauth/authorize',
      {
        client_id: input.client_id,
        redirect_uri: input.redirect_uri ?? REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        ...(input.state === undefined ? {} : { state: input.state }),
      },
      { cookie: t.identity.cookie, csrf },
    ),
  );
  assert.equal(res.status, 302);
  const location = res.headers.get('location') ?? '';
  const code = new URL(location).searchParams.get('code') ?? '';
  assert.ok(code.length > 0);
  return code;
}

test('well-known metadata serves both documents for the request origin', async () => {
  const t = await createTestOAuthDeps();
  const origin = 'https://test.invalid';
  const resource = await handleOAuthRequest(t.deps, get('/.well-known/oauth-protected-resource'));
  assert.equal(resource.status, 200);
  assert.deepEqual(await resource.json(), {
    resource: origin,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
  });
  const server = await handleOAuthRequest(t.deps, get('/.well-known/oauth-authorization-server'));
  assert.equal(server.status, 200);
  const doc = (await server.json()) as Record<string, unknown>;
  assert.equal(doc['issuer'], origin);
  assert.equal(doc['authorization_endpoint'], `${origin}/oauth/authorize`);
  assert.equal(doc['token_endpoint'], `${origin}/oauth/token`);
  assert.equal(doc['registration_endpoint'], `${origin}/oauth/register`);
  assert.deepEqual(doc['code_challenge_methods_supported'], ['S256']);
});

test('register ok: 201 public-client response, logged without secrets', async () => {
  const t = await createTestOAuthDeps();
  const res = await handleOAuthRequest(
    t.deps,
    postJson('/oauth/register', { redirect_uris: [REDIRECT], client_name: 'Desk' }),
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as Record<string, unknown>;
  assert.match(String(body['client_id']), /^client_[0-9a-f]{16}$/);
  assert.deepEqual(body['redirect_uris'], [REDIRECT]);
  assert.equal(body['client_name'], 'Desk');
  assert.equal(body['token_endpoint_auth_method'], 'none');
  const logged = t.logger.calls.find((c) => c.message === 'oauth client registered');
  assert.ok(logged);
  assert.equal(logged.fields?.['client_id'], body['client_id']);
});

test('register validation: bad URIs and names are plain 400 envelopes', async () => {
  const t = await createTestOAuthDeps();
  for (const payload of [
    { redirect_uris: ['http://plain.example/cb'] },
    { redirect_uris: ['not-a-url'] },
    { redirect_uris: [] },
    { redirect_uris: [REDIRECT], client_name: '' },
    { redirect_uris: 'https://app.example/cb' },
    { nope: true },
  ]) {
    const res = await handleOAuthRequest(t.deps, postJson('/oauth/register', payload));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'validation');
  }
});

test('register rate-limit trips after 10 attempts with Retry-After', async () => {
  const t = await createTestOAuthDeps();
  for (let i = 0; i < 10; i++) {
    const res = await handleOAuthRequest(t.deps, postJson('/oauth/register', { redirect_uris: [REDIRECT] }));
    assert.equal(res.status, 201);
  }
  const limited = await handleOAuthRequest(t.deps, postJson('/oauth/register', { redirect_uris: [REDIRECT] }));
  assert.equal(limited.status, 429);
  assert.equal(((await limited.json()) as { code: string }).code, 'limit');
  assert.ok(Number(limited.headers.get('retry-after') ?? '0') > 0);
});

test('authorize GET returns a consent descriptor and issues nothing', async () => {
  const t = await createTestOAuthDeps();
  const client_id = await register(t);
  const query = new URLSearchParams({
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'xyz',
    team: t.identity.teamId,
  }).toString();
  const res = await handleOAuthRequest(t.deps, get(`/oauth/authorize?${query}`, t.identity.cookie));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body['client_id'], client_id);
  assert.equal(body['client_name'], 'MCP client');
  assert.equal(body['redirect_uri'], REDIRECT);
  assert.equal(body['team_id'], t.identity.teamId);
  assert.equal(body['postTo'], '/oauth/authorize');
});

test('authorize GET without a session is 401 Login required', async () => {
  const t = await createTestOAuthDeps();
  const client_id = await register(t);
  const query = new URLSearchParams({
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  }).toString();
  const res = await handleOAuthRequest(t.deps, get(`/oauth/authorize?${query}`));
  assert.equal(res.status, 401);
  const body = (await res.json()) as { code: string; message: string };
  assert.equal(body.code, 'forbidden');
  assert.equal(body.message, 'Login required.');
});

test('authorize GET rejects unverified clients plainly (never a redirect)', async () => {
  const t = await createTestOAuthDeps();
  const client_id = await register(t);
  const base = { client_id, redirect_uri: REDIRECT, code_challenge: CHALLENGE };
  const cases: Array<Record<string, string>> = [
    { ...base, code_challenge_method: 'plain' },
    { ...base },
    { ...base, client_id: 'client_missing', code_challenge_method: 'S256' },
    { ...base, redirect_uri: 'https://evil.example/cb', code_challenge_method: 'S256' },
    { ...base, code_challenge: 'short', code_challenge_method: 'S256' },
  ];
  for (const params of cases) {
    const res = await handleOAuthRequest(
      t.deps,
      get(`/oauth/authorize?${new URLSearchParams(params).toString()}`, t.identity.cookie),
    );
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('location'), null);
    assert.equal(((await res.json()) as { code: string }).code, 'validation');
  }
});

test('authorize GET rejects unknown and non-member teams with 400', async () => {
  const t = await createTestOAuthDeps();
  const client_id = await register(t);
  const strangerTeam = await t.identity.store.createTeam({});
  const base = {
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  };
  for (const team of ['team-missing', strangerTeam.team_id]) {
    const res = await handleOAuthRequest(
      t.deps,
      get(`/oauth/authorize?${new URLSearchParams({ ...base, team }).toString()}`, t.identity.cookie),
    );
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'validation');
  }
});

test('authorize POST issues a code via 302 with code+state, and it exchanges', async () => {
  const t = await createTestOAuthDeps();
  const client_id = await register(t);
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const res = await handleOAuthRequest(
    t.deps,
    postJson(
      '/oauth/authorize',
      {
        client_id,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        state: 'opaque-state',
        team: t.identity.teamId,
      },
      { cookie: t.identity.cookie, csrf },
    ),
  );
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location') ?? '');
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
  const code = location.searchParams.get('code') ?? '';
  assert.ok(code.length > 0);
  assert.equal(location.searchParams.get('state'), 'opaque-state');

  const token = await handleOAuthRequest(
    t.deps,
    postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: VERIFIER,
    }),
  );
  assert.equal(token.status, 200);
  const body = (await token.json()) as Record<string, unknown>;
  assert.equal(body['token_type'], 'Bearer');
  assert.equal(body['expires_in'], 2592000);
  assert.ok(typeof body['access_token'] === 'string' && body['access_token'].length > 0);
  // The access token resolves as an mcp_grant for the consenting user+team.
  const identity = await resolveIdentity(t.identity.store, {
    mcp_grant_token: body['access_token'] as string,
  });
  assert.equal(identity.binding.kind, 'mcp_grant');
  assert.equal(identity.actor?.user_id, t.identity.userId);
  assert.equal(identity.team?.team_id, t.identity.teamId);
});

test('authorize POST failures: CSRF 403, bad params 400, oversized state', async () => {
  const t = await createTestOAuthDeps();
  const client_id = await register(t);
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const valid = {
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  };

  // No session at all.
  const anon = await handleOAuthRequest(t.deps, postJson('/oauth/authorize', valid));
  assert.equal(anon.status, 401);

  // Bad CSRF (wrong token) and missing CSRF.
  for (const bad of [
    postJson('/oauth/authorize', valid, { cookie: t.identity.cookie, csrf: 'wrong' }),
    postJson('/oauth/authorize', valid, { cookie: t.identity.cookie }),
  ]) {
    const res = await handleOAuthRequest(t.deps, bad);
    assert.equal(res.status, 403);
  }

  // Unknown client, redirect mismatch, non-S256, oversized state.
  const badBodies: unknown[] = [
    { ...valid, client_id: 'client_missing' },
    { ...valid, redirect_uri: 'https://evil.example/cb' },
    { ...valid, code_challenge_method: 'plain' },
    { ...valid, code_challenge: 'short' },
    { ...valid, state: 's'.repeat(1025) },
    { ...valid, team: 'team-missing' },
  ];
  for (const payload of badBodies) {
    const res = await handleOAuthRequest(
      t.deps,
      postJson('/oauth/authorize', payload, { cookie: t.identity.cookie, csrf }),
    );
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('location'), null);
  }
});

test('token endpoint accepts JSON and collapses failures to invalid_grant', async () => {
  const t = await createTestOAuthDeps();
  const client_id = await register(t);
  const other_id = await register(t, ['https://other.example/cb']);

  // JSON-encoded exchange works.
  const first = await authorizeCode(t, { client_id });
  const viaJson = await handleOAuthRequest(
    t.deps,
    postJson('/oauth/token', {
      grant_type: 'authorization_code',
      code: first,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: VERIFIER,
    }),
  );
  assert.equal(viaJson.status, 200);

  // Replay of the consumed code.
  const replay = await handleOAuthRequest(
    t.deps,
    postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code: first,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: VERIFIER,
    }),
  );
  assert.equal(replay.status, 400);
  assert.deepEqual(await replay.json(), { error: 'invalid_grant', error_description: 'Invalid or expired code.' });

  // Wrong verifier / redirect / client each collapse the same way.
  const second = await authorizeCode(t, { client_id });
  const variants: Record<string, string>[] = [
    { code: second, redirect_uri: REDIRECT, client_id, code_verifier: 'x'.repeat(43) },
    { code: second, redirect_uri: 'https://other.example/cb', client_id, code_verifier: VERIFIER },
    { code: second, redirect_uri: REDIRECT, client_id: other_id, code_verifier: VERIFIER },
    { code: 'missing', redirect_uri: REDIRECT, client_id, code_verifier: VERIFIER },
  ];
  for (const params of variants) {
    const res = await handleOAuthRequest(
      t.deps,
      postForm('/oauth/token', { grant_type: 'authorization_code', ...params }),
    );
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'invalid_grant');
  }
});

test('token endpoint rejects other grant types with unsupported_grant_type', async () => {
  const t = await createTestOAuthDeps();
  const res = await handleOAuthRequest(
    t.deps,
    postForm('/oauth/token', { grant_type: 'refresh_token', code: 'x' }),
  );
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, 'unsupported_grant_type');
  const missing = await handleOAuthRequest(t.deps, postForm('/oauth/token', { code: 'x' }));
  assert.equal(missing.status, 400);
  assert.equal(((await missing.json()) as { error: string }).error, 'invalid_request');
});

test('token rate-limit answers 429 with Retry-After in RFC shape', async () => {
  const t = await createTestOAuthDeps();
  for (let i = 0; i < 10; i++) {
    await handleOAuthRequest(t.deps, postForm('/oauth/token', { grant_type: 'refresh_token' }));
  }
  const limited = await handleOAuthRequest(t.deps, postForm('/oauth/token', { grant_type: 'refresh_token' }));
  assert.equal(limited.status, 429);
  assert.equal(((await limited.json()) as { error: string }).error, 'temporarily_unavailable');
  assert.ok(Number(limited.headers.get('retry-after') ?? '0') > 0);
});

test('unknown OAuth paths and wrong methods are 404', async () => {
  const t = await createTestOAuthDeps();
  const cases: Request[] = [
    get('/oauth/nope'),
    get('/oauth/register'),
    get('/oauth/token'),
    testRequest('/oauth/authorize', { method: 'DELETE' }),
    testRequest('/oauth/token', { method: 'PUT' }),
    get('/.well-known/unknown'),
    testRequest('/.well-known/oauth-protected-resource', { method: 'POST' }),
  ];
  for (const req of cases) {
    const res = await handleOAuthRequest(t.deps, req);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, 'not_found');
  }
});

test('top-level handler mounts the OAuth sub-handler for well-known + /oauth/*', async () => {
  const t = await createTestDeps();
  const handler = createHttpHandler(t.deps, {
    operations: async () => new Response('unexpected', { status: 500 }),
    auth: async () => new Response('unexpected', { status: 500 }),
    uploads: async () => new Response('unexpected', { status: 500 }),
    ingress: async () => new Response('unexpected', { status: 500 }),
    oauth: (req) =>
      handleOAuthRequest(
        { identity: t.deps.identity, limiter: t.deps.limiter, logger: t.deps.logger, clock: t.deps.clock },
        req,
      ),
  });
  const meta = await handler(get('/.well-known/oauth-protected-resource'));
  assert.equal(meta.status, 200);
  assert.equal(((await meta.json()) as { resource: string }).resource, 'https://test.invalid');
  // An unauthenticated authorize GET reaches OAuth (401), not pages (200) or top-level 404.
  const authorize = await handler(get('/oauth/authorize?client_id=x'));
  assert.equal(authorize.status, 401);
});

test('token endpoint rejects wrong and missing content types', async () => {
  const t = await createTestOAuthDeps();
  const wrong = await handleOAuthRequest(
    t.deps,
    testRequest('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'grant_type=authorization_code',
    }),
  );
  assert.equal(wrong.status, 400);
  assert.equal(((await wrong.json()) as { error: string }).error, 'invalid_request');
  const missing = await handleOAuthRequest(
    t.deps,
    testRequest('/oauth/token', { method: 'POST', body: 'grant_type=authorization_code' }),
  );
  assert.equal(missing.status, 400);
  assert.equal(((await missing.json()) as { error: string }).error, 'invalid_request');
});

test('empty team matches absent team on both authorize steps', async () => {
  const t = await createTestOAuthDeps();
  const client_id = await register(t);
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const query = `client_id=${client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${CHALLENGE}&code_challenge_method=S256`;
  const emptyGet = await handleOAuthRequest(t.deps, get(`/oauth/authorize?${query}&team=`, t.identity.cookie));
  assert.equal(emptyGet.status, 200);
  const post = await handleOAuthRequest(
    t.deps,
    postJson(
      '/oauth/authorize',
      { client_id, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256', team: '' },
      { cookie: t.identity.cookie, csrf },
    ),
  );
  assert.equal(post.status, 302);
});

test('registration accepts boundary values: five URIs, 100-char name', async () => {
  const t = await createTestOAuthDeps();
  const uris = ['a', 'b', 'c', 'd', 'e'].map((h) => `https://${h}.example/cb`);
  const res = await handleOAuthRequest(
    t.deps,
    postJson('/oauth/register', { redirect_uris: uris, client_name: 'n'.repeat(100) }),
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as { redirect_uris: string[]; client_name: string };
  assert.deepEqual(body.redirect_uris, uris);
  assert.equal(body.client_name, 'n'.repeat(100));
});

test('authorize GET rejects oversized state', async () => {
  const t = await createTestOAuthDeps();
  const client_id = await register(t);
  const res = await handleOAuthRequest(
    t.deps,
    get(
      `/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=${'s'.repeat(1025)}`,
      t.identity.cookie,
    ),
  );
  assert.equal(res.status, 400);
});

test('exchange after team removal mints, but MCP admission rejects', async () => {
  const t = await createTestOAuthDeps();
  const client_id = await register(t);
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const authRes = await handleOAuthRequest(
    t.deps,
    postJson(
      '/oauth/authorize',
      {
        client_id,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        team: t.identity.teamId,
      },
      { cookie: t.identity.cookie, csrf },
    ),
  );
  assert.equal(authRes.status, 302);
  const code = new URL(authRes.headers.get('location') ?? '').searchParams.get('code') ?? '';
  assert.ok(code.length > 0);
  const membership = await t.deps.identity.store.findMembership(t.identity.teamId, t.identity.userId);
  assert.ok(membership);
  await t.deps.identity.store.removeMembership(membership.membership_id);
  const tokenRes = await handleOAuthRequest(
    t.deps,
    postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: VERIFIER,
    }),
  );
  assert.equal(tokenRes.status, 200);
  const access = ((await tokenRes.json()) as { access_token: string }).access_token;
  await assert.rejects(() =>
    resolveIdentity(t.deps.identity.store, { mcp_grant_token: access }),
  );
});

for (const length of [44, 128]) {
  test(`mounted S256 authorize refuses ${length}-character challenges on GET and POST`, async () => {
    const t = await createTestDeps();
    const handler = createHttpHandler(t.deps, {
      operations: async () => new Response('unexpected', { status: 500 }),
      auth: async () => new Response('unexpected', { status: 500 }),
      uploads: async () => new Response('unexpected', { status: 500 }),
      ingress: async () => new Response('unexpected', { status: 500 }),
      oauth: (request) => handleOAuthRequest(t.deps, request),
    });
    const registration = await handler(postJson('/oauth/register', { redirect_uris: [REDIRECT] }));
    assert.equal(registration.status, 201);
    const { client_id } = await registration.json() as { client_id: string };
    const params = { client_id, redirect_uri: REDIRECT, code_challenge: 'A'.repeat(length), code_challenge_method: 'S256' };
    const csrf = await deriveCsrfToken(t.identity.sessionToken);
    for (const request of [
      get(`/oauth/authorize?${new URLSearchParams(params)}`, t.identity.cookie),
      postJson('/oauth/authorize', params, { cookie: t.identity.cookie, csrf }),
    ]) {
      const response = await handler(request);
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('location'), null);
      assert.equal((await response.json() as { code: string }).code, 'validation');
    }
  });
}

test('mounted register, authorize and token retain valid S256 and collapsed verifier failures', async () => {
  const t = await createTestDeps();
  const handler = createHttpHandler(t.deps, {
      operations: async () => new Response('unexpected', { status: 500 }),
      auth: async () => new Response('unexpected', { status: 500 }),
      uploads: async () => new Response('unexpected', { status: 500 }),
      ingress: async () => new Response('unexpected', { status: 500 }),
      oauth: (request) => handleOAuthRequest(t.deps, request),
    });
  const registration = await handler(postJson('/oauth/register', { redirect_uris: [REDIRECT] }));
  assert.equal(registration.status, 201);
  const { client_id } = await registration.json() as { client_id: string };
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  for (const verifier of [VERIFIER, undefined, '', '!', 'x'.repeat(43)]) {
    const authorization = await handler(postJson('/oauth/authorize', {
      client_id, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256',
    }, { cookie: t.identity.cookie, csrf }));
    assert.equal(authorization.status, 302);
    const code = new URL(authorization.headers.get('location') ?? '').searchParams.get('code');
    assert.ok(code);
    const token = await handler(postJson('/oauth/token', {
      grant_type: 'authorization_code', client_id, redirect_uri: REDIRECT, code,
      ...(verifier === undefined ? {} : { code_verifier: verifier }),
    }));
    assert.equal(token.status, verifier === VERIFIER ? 200 : 400);
    const body = await token.json() as Record<string, unknown>;
    if (verifier === VERIFIER) assert.ok(body['access_token']);
    else assert.equal(body['error'], 'invalid_grant');
  }
});
