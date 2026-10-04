/**
 * Session transport behavior: opaque tokens, cookies, CSRF derivation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  createOpaqueToken,
  sha256HexText,
  timingSafeEqualHex,
} from '../src/sessions/tokens.js';
import {
  SESSION_COOKIE_NAME,
  buildSessionClearCookie,
  buildSessionCookie,
  parseSessionCookie,
} from '../src/sessions/cookies.js';
import { deriveCsrfToken, verifyCsrfToken } from '../src/sessions/csrf.js';

test('opaque tokens are unique and hash-verifiable', async () => {
  const first = await createOpaqueToken();
  const second = await createOpaqueToken();
  assert.ok(first.token.length >= 43);
  assert.notEqual(first.token, second.token);
  assert.match(first.token_sha256, /^[0-9a-f]{64}$/);
  assert.equal(await sha256HexText(first.token), first.token_sha256);
});

test('base64url codec round-trips and rejects garbage', () => {
  for (const bytes of [
    new Uint8Array([1]),
    new Uint8Array([1, 2]),
    new Uint8Array([1, 2, 3]),
    new Uint8Array([255, 0, 128, 64, 33]),
  ]) {
    const text = bytesToBase64Url(bytes);
    assert.ok(!text.includes('=') && !text.includes('+') && !text.includes('/'));
    assert.deepEqual(base64UrlToBytes(text), bytes);
  }
  assert.equal(base64UrlToBytes(''), null);
  assert.equal(base64UrlToBytes('a'), null);
  assert.equal(base64UrlToBytes('****'), null);
});

test('hex comparison is exact and total', () => {
  const digest = 'a'.repeat(64);
  assert.equal(timingSafeEqualHex(digest, digest), true);
  assert.equal(timingSafeEqualHex(digest, 'b'.repeat(64)), false);
  assert.equal(timingSafeEqualHex(digest, 'a'.repeat(63)), false);
  assert.equal(timingSafeEqualHex(digest, 'zz'), false);
});

test('session cookie builds, parses, and clears', () => {
  const built = buildSessionCookie('tok_abc', { maxAgeSeconds: 3600 });
  assert.equal(built, `${SESSION_COOKIE_NAME}=tok_abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure`);
  const local = buildSessionCookie('tok_abc', { maxAgeSeconds: 60, secure: false });
  assert.ok(!local.includes('Secure'));
  assert.equal(parseSessionCookie(`other=1; ${SESSION_COOKIE_NAME}=tok_abc; x=2`), 'tok_abc');
  assert.equal(parseSessionCookie(undefined), null);
  assert.equal(parseSessionCookie('other=1'), null);
  assert.equal(parseSessionCookie(`${SESSION_COOKIE_NAME}=`), null);
  assert.equal(
    buildSessionClearCookie(),
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
  );
  assert.equal(
    buildSessionClearCookie({ secure: false }),
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
});

test('CSRF tokens bind to the session token', async () => {
  const csrf = await deriveCsrfToken('session-token-a');
  assert.equal(await deriveCsrfToken('session-token-a'), csrf);
  assert.notEqual(await deriveCsrfToken('session-token-b'), csrf);
  assert.equal(await verifyCsrfToken('session-token-a', csrf), true);
  assert.equal(await verifyCsrfToken('session-token-b', csrf), false);
  assert.equal(await verifyCsrfToken('session-token-a', `${csrf}x`), false);
  assert.equal(await verifyCsrfToken('', csrf), false);
  assert.equal(await verifyCsrfToken('session-token-a', ''), false);
});
