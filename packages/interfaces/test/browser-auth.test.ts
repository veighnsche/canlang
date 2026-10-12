import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCsrfToken, revokeSessionByToken, sha256HexText } from '@canlang/identity';
import { handleAuthRequest } from '../src/http/auth.js';
import { createTestDeps, testRequest } from '../src/testing.js';

async function browserDeps() {
  const t = await createTestDeps();
  return { ...t, deps: { ...t.deps, authOrigin: 'https://test.invalid' } };
}

function browser(path: string, cookie?: string, body?: Record<string, string>, origin = 'https://test.invalid'): Request {
  return testRequest(path, { ...(cookie === undefined ? {} : { cookie }), headers: {
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded', origin }),
  }, ...(body === undefined ? {} : { method: 'POST', body: new URLSearchParams(body) }) });
}
function jar(response: Response, name: string): string {
  const cookie = response.headers.getSetCookie().find(value => value.startsWith(`${name}=`));
  assert.ok(cookie); return cookie.split(';', 1)[0]!;
}
function token(html: string): string {
  const found = html.match(/name="_presession" value="([^"]+)"/); assert.ok(found); return found[1]!;
}

test('native browser login, team selection and logout reuse Identity protections', async () => {
  const t = await browserDeps();
  const descriptor = await handleAuthRequest(t.deps, browser('/auth/login'));
  const html = await descriptor.text();
  assert.equal(descriptor.status, 200); assert.match(html, /name="email" type="email"/);
  assert.equal(descriptor.headers.get('cache-control'), 'no-store');
  const pre = token(html), preCookie = jar(descriptor, 'can_presession');
  const credentials = { email: t.identity.email, password: 's3cure-password', _presession: pre, next: 'https://evil.invalid' };
  const logged = await handleAuthRequest(t.deps, browser('/auth/login', preCookie, credentials));
  assert.equal(logged.status, 303); assert.equal(logged.headers.get('location'), '/auth/select-team');
  const session = jar(logged, 'can_session');
  assert.ok(logged.headers.getSetCookie().some(cookie => cookie.startsWith('can_presession=;')));
  const reused = await handleAuthRequest(t.deps, browser('/auth/login', preCookie, credentials));
  assert.equal(reused.status, 403); assert.equal(reused.headers.get('location'), null);
  const picker = await handleAuthRequest(t.deps, browser('/auth/select-team', session));
  const pickerHtml = await picker.text(); assert.match(pickerHtml, new RegExp(t.identity.teamId));
  const csrf = await deriveCsrfToken(decodeURIComponent(session.slice('can_session='.length)));
  const missing = await handleAuthRequest(t.deps, browser('/auth/select-team', session, { team: t.identity.teamId }));
  assert.equal(missing.status, 403);
  const foreign = await t.identity.store.createTeam({});
  const refused = await handleAuthRequest(t.deps, browser('/auth/select-team', session, { team: foreign.team_id, _csrf: csrf }));
  assert.equal(refused.status, 403);
  const selected = await handleAuthRequest(t.deps, browser('/auth/select-team', session, { team: t.identity.teamId, _csrf: csrf }));
  assert.equal(selected.status, 303); assert.equal(selected.headers.get('location'), '/');
  const crossOrigin = await handleAuthRequest(t.deps, browser('/auth/logout', session, { _csrf: csrf }, 'https://evil.invalid'));
  assert.equal(crossOrigin.status, 403);
  const logout = await handleAuthRequest(t.deps, browser('/auth/logout', session, { _csrf: csrf }));
  assert.equal(logout.status, 303); assert.equal(logout.headers.get('location'), '/auth/login');
  assert.ok(jar(logout, 'can_session').endsWith('='));
});

test('wrong browser password gets fresh throttled token without reflecting credentials', async () => {
  const t = await browserDeps();
  const descriptor = await handleAuthRequest(t.deps, browser('/auth/login'));
  const pre = token(await descriptor.text());
  const rejected = await handleAuthRequest(t.deps, browser('/auth/login', jar(descriptor, 'can_presession'), {
    email: t.identity.email, password: 'wrong-private-password', _presession: pre,
  }));
  const html = await rejected.text(); assert.equal(rejected.status, 403);
  assert.notEqual(token(html), pre); assert.ok(jar(rejected, 'can_presession'));
  assert.ok(!html.includes('wrong-private-password')); assert.ok(!html.includes(t.identity.email));
});

test('default JSON and explicit HTML q=0 remain descriptors', async () => {
  const t = await browserDeps();
  for (const accept of ['', '*/*', 'application/json', 'text/html;q=0', 'text/html;q=0.2,application/json']) {
    const result = await handleAuthRequest(t.deps, testRequest('/auth/login', { headers: { accept } }));
    assert.match(result.headers.get('content-type')!, /^application\/json/);
    const body: unknown = await result.json();
    assert.ok(body !== null && typeof body === 'object' && 'form' in body);
    assert.equal(body.form, 'login');
  }
});

test('browser team discovery stays active-only and bounded with paging', async () => {
  const t = await browserDeps();
  const foreign = await t.identity.store.createTeam({});
  for (let index = 0; index < 100; index++) {
    const team = await t.identity.store.createTeam({});
    await t.identity.store.createMembership({ team_id: team.team_id, user_id: t.identity.userId, is_owner: false, roles: [] });
  }
  const picker = await handleAuthRequest(t.deps, browser('/auth/select-team', t.identity.cookie));
  const html = await picker.text(); assert.equal((html.match(/<option /g) ?? []).length, 100);
  assert.ok(!html.includes(foreign.team_id));
  const next = html.match(/href="(\/auth\/select-team\?after=[^"]+)"/); assert.ok(next);
  const last = await handleAuthRequest(t.deps, browser(next[1]!, t.identity.cookie));
  assert.equal(((await last.text()).match(/<option /g) ?? []).length, 1);
});

test('browser mint throttle preserves 429 and Retry-After without another token', async () => {
  const t = await browserDeps();
  for (let index = 0; index < 10; index++) {
    assert.equal((await handleAuthRequest(t.deps, browser('/auth/login'))).status, 200);
  }
  const limited = await handleAuthRequest(t.deps, browser('/auth/login'));
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(limited.headers.getSetCookie().length, 0);
  assert.ok(!(await limited.text()).includes('name="_presession"'));
});


test('public HTML login recovers unknown, revoked and expired cookies; protected picker still denies', async () => {
  const t = await browserDeps();
  await revokeSessionByToken(t.identity.store, { token: t.identity.sessionToken });
  const expiredToken = 'expired-test-session';
  await t.identity.store.createSession({ user_id: t.identity.userId, token_sha256: await sha256HexText(expiredToken),
    expires_at: '2000-01-01T00:00:00.000Z', last_team_id: null });
  for (const cookie of ['can_session=unknown-test-session', t.identity.cookie, `can_session=${expiredToken}`]) {
    const login = await handleAuthRequest(t.deps, browser('/auth/login', cookie));
    assert.equal(login.status, 200); assert.ok(token(await login.text()));
    assert.ok(jar(login, 'can_presession'));
    const protectedPicker = await handleAuthRequest(t.deps, browser('/auth/select-team', cookie));
    assert.equal(protectedPicker.status, 403); assert.equal(protectedPicker.headers.get('location'), null);
  }
});
