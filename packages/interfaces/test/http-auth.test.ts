/**
 * S4 auth-endpoint tests: the register/verify/login/logout cycle, recovery,
 * team selection, rate limits, CSRF, pre-session login tokens, and interim
 * GET descriptors — all over HTTP against the real identity memory store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCsrfToken } from '@canlang/identity';
import { handleAuthRequest } from '../src/http/auth.js';
import { createTestDeps, testRequest } from '../src/testing.js';
import type { TestDeps } from '../src/testing.js';

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

/** Mint a login token through the real descriptor GET (single-use). */
async function loginToken(t: TestDeps): Promise<string> {
  const res = await handleAuthRequest(t.deps, get('/auth/login'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = (await res.json()) as { preSessionToken?: unknown };
  assert.equal(typeof body.preSessionToken, 'string');
  assert.ok((body.preSessionToken as string).length > 0, 'expected a minted pre-session token');
  return body.preSessionToken as string;
}

test('register -> verify -> login -> logout cycle over HTTP (login via pre-session token)', async () => {
  const t = await createTestDeps();
  const email = 'cycle@test.example';

  // Register/verify carry no token (they plant no session); login mints one.
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

  res = await handleAuthRequest(
    t.deps,
    post('/auth/login', { email, password: PASSWORD, _presession: await loginToken(t) }),
  );
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

test('login POST without a pre-session token is rejected even with correct credentials', async () => {
  // Login-CSRF guard: a cross-site forgery cannot read the minted token, so
  // a tokenless POST must fail closed before credentials are even checked.
  const t = await createTestDeps();
  const res = await handleAuthRequest(
    t.deps,
    post('/auth/login', { email: t.identity.email, password: PASSWORD }),
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { code: string }).code, 'forbidden');
});

test('login token is single-use: a failed attempt spends it, replay is rejected', async () => {
  const t = await createTestDeps();
  const token = await loginToken(t);
  // Wrong password: the token is consumed, credentials fail.
  const failed = await handleAuthRequest(
    t.deps,
    post('/auth/login', { email: t.identity.email, password: 'wrong-password-1', _presession: token }),
  );
  assert.equal(failed.status, 403);
  assert.equal((await failed.json() as { message: string }).message, 'Invalid email or password.');
  // Replay with correct credentials: the token is spent.
  const replay = await handleAuthRequest(
    t.deps,
    post('/auth/login', { email: t.identity.email, password: PASSWORD, _presession: token }),
  );
  assert.equal(replay.status, 403);
  assert.equal((await replay.json() as { message: string }).message, 'Invalid or expired login token.');
  // A fresh token works.
  const ok = await handleAuthRequest(
    t.deps,
    post('/auth/login', { email: t.identity.email, password: PASSWORD, _presession: await loginToken(t) }),
  );
  assert.equal(ok.status, 200);
});

test('tampered pre-session token is rejected before credentials are checked', async () => {
  const t = await createTestDeps();
  const token = `${await loginToken(t)}-tampered`;
  const res = await handleAuthRequest(
    t.deps,
    post('/auth/login', { email: t.identity.email, password: PASSWORD, _presession: token }),
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { message: string }).message, 'Invalid or expired login token.');
});

test('login descriptor mints are throttled separately from login attempts', async () => {
  const t = await createTestDeps();
  for (let i = 0; i < 10; i++) {
    const res = await handleAuthRequest(t.deps, get('/auth/login'));
    assert.equal(res.status, 200, `mint ${i + 1}`);
  }
  const limited = await handleAuthRequest(t.deps, get('/auth/login'));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json() as { code: string }).code, 'limit');
});

test('login rate-limit trips after 10 attempts with Retry-After', async () => {
  const t = await createTestDeps();
  for (let i = 0; i < 10; i++) {
    // Fresh token per attempt: the 403s below are credential failures, and
    // the 10 descriptor mints stay inside the separate mint budget.
    const res = await handleAuthRequest(
      t.deps,
      post('/auth/login', {
        email: 'nobody@test.example',
        password: 'wrong-password-1',
        _presession: await loginToken(t),
      }),
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

  let res = await handleAuthRequest(
    t.deps,
    post('/auth/login', { email, password: PASSWORD, _presession: await loginToken(t) }),
  );
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

  res = await handleAuthRequest(
    t.deps,
    post('/auth/login', { email, password: PASSWORD, _presession: await loginToken(t) }),
  );
  assert.equal(res.status, 403);
  res = await handleAuthRequest(
    t.deps,
    post('/auth/login', { email, password: 'brand-new-password-9', _presession: await loginToken(t) }),
  );
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
      preSessionToken?: unknown;
    };
    assert.equal(d.form, form);
    assert.equal(d.postTo, postTo);
    assert.equal(d.csrfField, '_csrf');
    assert.ok(d.fields.some((f) => f.name === field), path);
    // Only the login descriptor mints a token; every mint is unique.
    if (form === 'login') {
      assert.equal(typeof d.preSessionToken, 'string');
      assert.ok((d.preSessionToken as string).length > 0);
      const again = (await (await handleAuthRequest(t.deps, get(path))).json()) as {
        preSessionToken?: unknown;
      };
      assert.ok(
        typeof again.preSessionToken === 'string' && again.preSessionToken !== d.preSessionToken,
        'each login descriptor mints a fresh token',
      );
    } else {
      assert.equal(d.preSessionToken, undefined);
    }
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

function postForm(
  path: string,
  params: Record<string, string>,
  opts: { cookie?: string } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const init: RequestInit & { cookie?: string } = {
    method: 'POST',
    headers,
    body: new URLSearchParams(params).toString(),
  };
  if (opts.cookie !== undefined) init.cookie = opts.cookie;
  return testRequest(path, init);
}

test('shell-style urlencoded logout and select-team work via the _csrf field', async () => {
  const t = await createTestDeps();
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  // select-team first (logout kills the session): form fields only, no header.
  const switched = await handleAuthRequest(
    t.deps,
    postForm('/auth/select-team', { team: t.identity.teamId, _csrf: csrf }, { cookie: t.identity.cookie }),
  );
  assert.equal(switched.status, 200);
  assert.deepEqual(await switched.json(), { ok: true, team_id: t.identity.teamId });
  const out = await handleAuthRequest(
    t.deps,
    postForm('/auth/logout', { _csrf: csrf }, { cookie: t.identity.cookie }),
  );
  assert.equal(out.status, 200);
  const cleared = out.headers.get('set-cookie') ?? '';
  assert.ok(cleared.includes('can_session=;') && cleared.includes('Max-Age=0'));
});

test('logout is idempotent for dead sessions (double-logout never 403s)', async () => {
  const t = await createTestDeps();
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const first = await handleAuthRequest(t.deps, post('/auth/logout', {}, { cookie: t.identity.cookie, csrf }));
  assert.equal(first.status, 200);
  // Same (now revoked) cookie again: still ok + clear.
  const second = await handleAuthRequest(t.deps, post('/auth/logout', {}, { cookie: t.identity.cookie, csrf }));
  assert.equal(second.status, 200);
  assert.ok((second.headers.get('set-cookie') ?? '').includes('Max-Age=0'));
});

test('wrong-value _csrf field is forbidden on select-team', async () => {
  const t = await createTestDeps();
  const res = await handleAuthRequest(
    t.deps,
    postForm('/auth/select-team', { team: t.identity.teamId, _csrf: 'wrong-value' }, { cookie: t.identity.cookie }),
  );
  assert.equal(res.status, 403);
});

test('recovery request rate policy is 5 per hour with Retry-After', async () => {
  const t = await createTestDeps();
  for (let i = 0; i < 5; i++) {
    const res = await handleAuthRequest(t.deps, post('/auth/recover', { email: `u${i}@x.test` }));
    assert.equal(res.status, 200);
  }
  const limited = await handleAuthRequest(t.deps, post('/auth/recover', { email: 'u5@x.test' }));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json() as { code: string }).code, 'limit');
  assert.ok(Number(limited.headers.get('retry-after') ?? '0') > 0);
});

test('login Set-Cookie carries HttpOnly, SameSite, Max-Age, and Secure when enabled', async () => {
  const t = await createTestDeps({ secureCookies: true });
  const email = 'flags@test.example';
  await handleAuthRequest(t.deps, post('/auth/register', { email, password: PASSWORD }));
  const msg = t.identity.mail.messages.find((m) => m.to === email);
  assert.ok(msg);
  await handleAuthRequest(t.deps, post('/auth/verify', { token: tokenFromMail(msg.body_text) }));
  const res = await handleAuthRequest(
    t.deps,
    post('/auth/login', { email, password: PASSWORD, _presession: await loginToken(t) }),
  );
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  assert.ok(setCookie.includes('HttpOnly'), setCookie);
  assert.ok(setCookie.includes('SameSite=Lax'), setCookie);
  assert.ok(setCookie.includes('Max-Age=3600'), setCookie);
  assert.ok(setCookie.includes('Secure'), setCookie);
});
