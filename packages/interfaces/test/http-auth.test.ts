/**
 * S4 auth-endpoint tests: the register/verify/login/logout cycle, recovery,
 * team selection, rate limits, CSRF, and interim GET descriptors — all over
 * HTTP against the real identity memory store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCsrfToken } from '@canlang/identity';
import { handleAuthRequest } from '../src/http/auth.js';
import { createTestDeps, testRequest } from '../src/testing.js';

const PASSWORD = 's3cure-password';

function post(path: string, body?: unknown, opts: { cookie?: string; csrf?: string } = {}): Request {
  const headers: Record<string, string> = {};
  const init: RequestInit & { cookie?: string } = { method: 'POST', headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (opts.csrf !== undefined) headers['x-csrf-token'] = opts.csrf;
  if (opts.cookie !== undefined) init.cookie = opts.cookie;
  return testRequest(path, init);
}

function get(path: string, cookie?: string): Request {
  return testRequest(
    path,
    cookie === undefined ? { method: 'GET' } : { method: 'GET', cookie },
  );
}

function tokenFromMail(bodyText: string): string {
  const token = bodyText.match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1] ?? '';
  assert.ok(token.length > 0, 'expected a token link in test mail');
  return token;
}

function sessionTokenFromSetCookie(setCookie: string | null): string {
  assert.ok(setCookie !== null, 'expected a Set-Cookie header');
  const token = setCookie.match(/can_session=([^;]*)/)?.[1] ?? '';
  assert.ok(token.length > 0, 'expected can_session in Set-Cookie');
  return decodeURIComponent(token);
}

function cookieFor(sessionToken: string): string {
  return `can_session=${encodeURIComponent(sessionToken)}`;
}

test('register -> verify -> login -> logout cycle over HTTP (no CSRF on unauthenticated endpoints)', async () => {
  const t = await createTestDeps();
  const email = 'cycle@test.example';

  // Unauthenticated by nature: no CSRF headers anywhere below until logout.
  let res = await handleAuthRequest(t.deps, post('/auth/register', { email, password: PASSWORD }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  // Registration tells: the duplicate address is a conflict, not silence.
  res = await handleAuthRequest(t.deps, post('/auth/register', { email, password: PASSWORD }));
  assert.equal(res.status, 409);

  const verifyMsg = t.identity.mail.messages.find((m) => m.to === email);
  assert.ok(verifyMsg);
  res = await handleAuthRequest(t.deps, post('/auth/verify', { token: tokenFromMail(verifyMsg.body_text) }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  res = await handleAuthRequest(t.deps, post('/auth/login', { email, password: PASSWORD }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const sessionToken = sessionTokenFromSetCookie(res.headers.get('set-cookie'));
  const cookie = cookieFor(sessionToken);
  const csrf = await deriveCsrfToken(sessionToken);

  res = await handleAuthRequest(t.deps, post('/auth/logout', {}, { cookie, csrf }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.match(res.headers.get('set-cookie') ?? '', /Max-Age=0/);

  // The logged-out session is dead.
  res = await handleAuthRequest(t.deps, post('/auth/select-team', { team: t.identity.teamId }, { cookie, csrf }));
  assert.equal(res.status, 403);
});

test('logout without a session is idempotent; CSRF also accepted via _csrf field', async () => {
  const t = await createTestDeps();
  const anon = await handleAuthRequest(t.deps, post('/auth/logout', {}));
  assert.equal(anon.status, 200);
  assert.deepEqual(await anon.json(), { ok: true });

  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const viaField = await handleAuthRequest(
    t.deps,
    post('/auth/logout', { _csrf: csrf }, { cookie: t.identity.cookie }),
  );
  assert.equal(viaField.status, 200);
});

test('login rate-limit trips after 10 attempts with Retry-After', async () => {
  const t = await createTestDeps();
  for (let i = 0; i < 10; i++) {
    const res = await handleAuthRequest(
      t.deps,
      post('/auth/login', { email: 'nobody@test.example', password: 'wrong-password-1' }),
    );
    assert.equal(res.status, 403, `attempt ${i + 1}`);
  }
  const res = await handleAuthRequest(
    t.deps,
    post('/auth/login', { email: 'nobody@test.example', password: 'wrong-password-1' }),
  );
  assert.equal(res.status, 429);
  assert.equal((await res.json() as { code: string }).code, 'limit');
  const retryAfter = res.headers.get('retry-after');
  assert.ok(retryAfter !== null && Number(retryAfter) > 0);
});

test('recovery request always succeeds, including unknown and malformed email', async () => {
  const t = await createTestDeps();
  for (const email of ['ghost@test.example', 'not-an-email', t.identity.email]) {
    const res = await handleAuthRequest(t.deps, post('/auth/recover', { email }));
    assert.equal(res.status, 200, email);
    assert.deepEqual(await res.json(), { ok: true });
  }
  const mailed = t.identity.mail.messages.filter(
    (m) => m.to === t.identity.email && m.subject === 'Recover your account',
  );
  assert.equal(mailed.length, 1);
});

test('recovery confirm rotates credentials and kills old sessions', async () => {
  const t = await createTestDeps();
  const email = 'rotate@test.example';
  const registered = await handleAuthRequest(t.deps, post('/auth/register', { email, password: PASSWORD }));
  assert.equal(registered.status, 200);
  const verifyMsg = t.identity.mail.messages.find((m) => m.to === email);
  assert.ok(verifyMsg);
  const verified = await handleAuthRequest(
    t.deps,
    post('/auth/verify', { token: tokenFromMail(verifyMsg.body_text) }),
  );
  assert.equal(verified.status, 200);

  let res = await handleAuthRequest(t.deps, post('/auth/login', { email, password: PASSWORD }));
  assert.equal(res.status, 200);
  const sessionToken = sessionTokenFromSetCookie(res.headers.get('set-cookie'));
  const cookie = cookieFor(sessionToken);
  const csrf = await deriveCsrfToken(sessionToken);

  res = await handleAuthRequest(t.deps, post('/auth/recover', { email }));
  assert.equal(res.status, 200);
  const recoveryMsg = t.identity.mail.messages
    .filter((m) => m.to === email && m.subject === 'Recover your account')
    .at(-1);
  assert.ok(recoveryMsg);
  res = await handleAuthRequest(
    t.deps,
    post('/auth/recover/confirm', { token: tokenFromMail(recoveryMsg.body_text), new_password: 'brand-new-password-9' }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  res = await handleAuthRequest(t.deps, post('/auth/login', { email, password: PASSWORD }));
  assert.equal(res.status, 403);
  res = await handleAuthRequest(t.deps, post('/auth/login', { email, password: 'brand-new-password-9' }));
  assert.equal(res.status, 200);

  res = await handleAuthRequest(t.deps, post('/auth/select-team', { team: t.identity.teamId }, { cookie, csrf }));
  assert.equal(res.status, 403);
});

test('select-team switches context; unknown team 404s, foreign team 403s; clear resets', async () => {
  const t = await createTestDeps();
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const authed = { cookie: t.identity.cookie, csrf };

  let res = await handleAuthRequest(t.deps, post('/auth/select-team', { team: t.identity.teamId }, authed));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, team_id: t.identity.teamId });

  res = await handleAuthRequest(t.deps, post('/auth/select-team', { team: 'team-does-not-exist' }, authed));
  assert.equal(res.status, 404);

  const foreign = await t.identity.store.createTeam({});
  res = await handleAuthRequest(t.deps, post('/auth/select-team', { team: foreign.team_id }, authed));
  assert.equal(res.status, 403);

  res = await handleAuthRequest(t.deps, post('/auth/select-team/clear', {}, authed));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('logout and select-team require CSRF', async () => {
  const t = await createTestDeps();
  const cookie = t.identity.cookie;
  const attempts = [
    post('/auth/logout', {}, { cookie }),
    post('/auth/select-team', { team: t.identity.teamId }, { cookie }),
    post('/auth/select-team/clear', {}, { cookie }),
    post('/auth/logout', {}, { cookie, csrf: 'bogus' }),
  ];
  for (const req of attempts) {
    const res = await handleAuthRequest(t.deps, req);
    assert.equal(res.status, 403);
    assert.equal((await res.json() as { code: string }).code, 'forbidden');
  }
});

test('GET auth routes return interim form descriptors; verify GET never consumes', async () => {
  const t = await createTestDeps();
  const cases: ReadonlyArray<readonly [string, string, string, string]> = [
    ['/auth/login', 'login', '/auth/login', 'email'],
    ['/auth/register', 'register', '/auth/register', 'email'],
    ['/auth/verify', 'verify', '/auth/verify', 'token'],
    ['/auth/recover', 'recover', '/auth/recover', 'email'],
    ['/auth/select-team', 'select-team', '/auth/select-team', 'team'],
  ];
  for (const [path, form, postTo, field] of cases) {
    const res = await handleAuthRequest(t.deps, get(path));
    assert.equal(res.status, 200, path);
    const d = (await res.json()) as {
      form: string;
      fields: Array<{ name: string }>;
      postTo: string;
      csrfField: string;
    };
    assert.equal(d.form, form);
    assert.equal(d.postTo, postTo);
    assert.equal(d.csrfField, '_csrf');
    assert.ok(d.fields.some((f) => f.name === field), path);
  }

  // The ?token= landing page is side-effect-free: the same token still verifies after.
  const email = 'side-effect-free@test.example';
  const registered = await handleAuthRequest(t.deps, post('/auth/register', { email, password: PASSWORD }));
  assert.equal(registered.status, 200);
  const msg = t.identity.mail.messages.find((m) => m.to === email);
  assert.ok(msg);
  const token = tokenFromMail(msg.body_text);
  const landing = await handleAuthRequest(t.deps, get(`/auth/verify?token=${token}`));
  assert.equal(landing.status, 200);
  const consumed = await handleAuthRequest(t.deps, post('/auth/verify', { token }));
  assert.equal(consumed.status, 200);
});

test('unknown auth routes and wrong methods are not_found', async () => {
  const t = await createTestDeps();
  assert.equal((await handleAuthRequest(t.deps, post('/auth/nope', {}))).status, 404);
  assert.equal((await handleAuthRequest(t.deps, get('/auth/logout'))).status, 404);
  assert.equal((await handleAuthRequest(t.deps, get('/auth/recover/confirm'))).status, 404);
  assert.equal((await handleAuthRequest(t.deps, get('/auth/select-team/clear'))).status, 404);
});
