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
import { IdentityError } from '../src/ports.js';
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


test('cookie parser preserves first target, raw quotes, and once-only decoding', () => {
  const cases: readonly [string | readonly string[] | undefined, string | null][] = [
    [undefined, null], ['', null], ['can_session=x', 'x'],
    ['can_session=; can_session=ok', null], ['can_session=%ZZ; can_session=ok', null],
    [['can_session=%ZZ', 'can_session=ok'], null], ['other=%ZZ; can_session=ok', 'ok'],
    ['can_session=%252F', '%2F'], ['can_session=%3B%3D', ';='],
    ['can_session="foo"', '"foo"'], [' can_session = foo ', 'foo'],
    ['\u00a0can_session\u2028=\ufefffoo\u2029', 'foo'],
    ['\u00a0can_session=; can_session=ok', null], ['can_session=%ZZ; \u00a0can_session=ok', null],
    ['can_session; can_session=ok', 'ok'], ['bad;can_session=x', 'x'],
    ['__proto__=a;can_session=x', 'x'], ['can_session="a;b";can_session=ok', '"a'],
    ['can_session=foo=bar', 'foo=bar'], ['can_session=%ED%A0%80', null],
    ['can_session=%20x%20', ' x '],
    ['\u00a0can_session=first; can_session=second; \u00a0can_session=third', 'first'],
  ];
  for (const [header, expected] of cases) assert.equal(parseSessionCookie(header), expected);
  // The complete ECMAScript trim whitespace set, including non-ASCII names.
  for (const whitespace of '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff') {
    assert.equal(parseSessionCookie(`${whitespace}can_session${whitespace}=${whitespace}x${whitespace}; can_session=later`), 'x');
    assert.equal(parseSessionCookie(`${whitespace}can_session=; can_session=later`), null);
  }
});

test('cookie serializer preserves exact order and validates Domains safely', () => {
  const prefix = 'can_session=x; Path=/; HttpOnly; SameSite=Lax; Max-Age=1';
  for (const secure of [undefined, true, false]) {
    const options = secure === undefined ? {} : { secure };
    assert.equal(buildSessionCookie('x', { maxAgeSeconds: 1, ...options }), prefix + (secure === false ? '' : '; Secure'));
    assert.equal(buildSessionClearCookie(options), 'can_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (secure === false ? '' : '; Secure'));
    for (const domain of ['example.com', '.example.com', 'EXAMPLE.com', 'localhost', 'xn--bcher-kva.example']) {
      assert.equal(buildSessionCookie('x', { maxAgeSeconds: 1, domain, ...options }), prefix + (secure === false ? '' : '; Secure') + `; Domain=${domain}`);
      assert.equal(buildSessionClearCookie({ domain, ...options }), 'can_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (secure === false ? '' : '; Secure') + `; Domain=${domain}`);
    }
  }
  assert.equal(buildSessionCookie('a;= /%é', { maxAgeSeconds: 1 }), 'can_session=a%3B%3D%20%2F%25%C3%A9; Path=/; HttpOnly; SameSite=Lax; Max-Age=1; Secure');
  assert.equal(buildSessionCookie('x', { maxAgeSeconds: 2 ** 53 }), prefix.replace('Max-Age=1', `Max-Age=${2 ** 53}`) + '; Secure');
  const fault = (message: string) => (error: unknown) => {
    assert.ok(error instanceof IdentityError);
    assert.equal(error.name, 'IdentityError');
    assert.equal(error.code, 'validation');
    assert.equal(error.message, message);
    assert.equal(error.field, undefined);
    return true;
  };
  for (const domain of ['', 'a;b', 'a\rb', 'a\nb', 'a\0b', 'a\u007fb', 'a b', 'a,b', 'a=b', 'a:b', 'a_b', '-a', 'a.', 'é.example', `${'a'.repeat(64)}.com`]) {
    assert.throws(() => buildSessionCookie('x', { maxAgeSeconds: 1, domain }), fault('Session cookie Domain is invalid.'));
    assert.throws(() => buildSessionClearCookie({ domain }), fault('Session cookie Domain is invalid.'));
  }
  assert.throws(() => buildSessionCookie('', { maxAgeSeconds: 0, domain: '' }), fault('Cannot set an empty session cookie.'));
  for (const maxAgeSeconds of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => buildSessionCookie('\ud800', { maxAgeSeconds, domain: '' }), fault('Session cookie needs a positive Max-Age.'));
  }
  assert.throws(() => buildSessionCookie('\ud800', { maxAgeSeconds: 1, domain: '' }), URIError);
});


test('base64url codec matches fixed bytes and the historical tail domain', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  assert.equal(bytesToBase64Url(new Uint8Array()), '');
  const vectors: readonly [string, readonly number[] | null][] = [
    ['', null], ['a', null], ['Zg', [102]], ['Zh', [102]], ['Zv', [102]],
    ['Zm8', [102, 111]], ['Zm9', [102, 111]], ['Zm_', [102, 111]],
    ['Zg==', null], ['Zg=', null], ['Z+', null], [' Zg', null], ['Zg\n', null],
    ['é', null], ['-_8', [251, 255]], ['__8', [255, 255]], ['___', [255, 255]],
    ['AAAA', [0, 0, 0]], ['0g', [210]], ['\ud800', null],
  ];
  for (const [text, expected] of vectors) {
    assert.deepEqual(base64UrlToBytes(text), expected === null ? null : new Uint8Array(expected));
  }
  for (let byte = 0; byte < 256; byte++) {
    const expected = Buffer.from([byte]).toString('base64url');
    assert.equal(bytesToBase64Url(new Uint8Array([byte])), expected);
    for (let tail = 0; tail < 16; tail++) {
      const alias = (expected[0] ?? '') + (alphabet[(alphabet.indexOf(expected[1] ?? '') & 0x30) | tail] ?? '');
      assert.deepEqual(base64UrlToBytes(alias), new Uint8Array([byte]));
    }
  }
  // Independent Node byte oracle: all final sextets, across both tail widths
  // and complete groups, with the released deterministic seed recipe.
  for (let length = 1; length <= 257; length++) {
    const bytes = Uint8Array.from({ length }, (_, i) => (length * 13 + i * 79) & 255);
    const canonical = Buffer.from(bytes).toString('base64url');
    assert.equal(bytesToBase64Url(bytes), canonical);
    for (const last of alphabet) {
      const text = canonical.slice(0, -1) + last;
      assert.deepEqual(base64UrlToBytes(text), new Uint8Array(Buffer.from(text, 'base64url')));
    }
  }
});

test('hex codec rejects partial prefixes, signs, whitespace, and empty text', () => {
  assert.equal(timingSafeEqualHex('FF', 'ff'), true);
  assert.equal(timingSafeEqualHex('aB', 'Ab'), true);
  for (const invalid of ['', '0', '0g', 'g0', '+1', '-1', ' 1', '1 ', '0x', '00\n0', '٠٠']) {
    assert.equal(timingSafeEqualHex(invalid, invalid), false);
    assert.equal(timingSafeEqualHex(invalid, '00'), false);
  }
  assert.equal(timingSafeEqualHex('00', '0000'), false);
});

test('issued tokens and bearer text hashes retain frozen encoding witnesses', async () => {
  assert.deepEqual(await createOpaqueToken({ randomBytes: (length) => Uint8Array.from({ length }, (_, i) => i), randomUUID: () => 'synthetic-unused' }), {
    token: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    token_sha256: 'ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0',
  });
  assert.equal(await sha256HexText('Zg'), '351eb80f0736735b2c0b31044ed404c03def09a2c9691713a327e96b0ae73d4c');
  assert.equal(await sha256HexText('Zh'), '9aff73e1b53a5b8178a770de6a1e7d20f7c178e492881c9a92ab78b211f65dc8');
  assert.notEqual(await deriveCsrfToken('Zg'), await deriveCsrfToken('Zh'));
  assert.equal(await verifyCsrfToken('Zh', await deriveCsrfToken('Zg')), false);
});
