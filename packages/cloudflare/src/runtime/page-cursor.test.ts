import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64UrlToBytes, bytesToBase64Url } from '@canlang/identity';
import { createPageCursorCodec } from './page-cursor.js';

const hostKey = new Uint8Array(32).fill(77);
const binding = 'a'.repeat(64);
const now = 1_800_000_000_000;
const lifetime = 15 * 60 * 1_000;
const position = { revision: 7, after: 'visible-row-é😀' };

async function signed(text: string | Uint8Array): Promise<string> {
  const payload = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  const key = await globalThis.crypto.subtle.importKey('raw', hostKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, payload.slice());
  return `${bytesToBase64Url(payload)}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

test('page cursor transports only a bound visible position and expires at its finite lease', async () => {
  const mutableKey = hostKey.slice();
  const encoder = await createPageCursorCodec(mutableKey);
  mutableKey.fill(78);
  const decoder = await createPageCursorCodec(bytesToBase64Url(hostKey));
  const token = await encoder.encode(binding, position, now);
  const expected = { status: 'valid', bindingDigest: binding, position };
  assert.deepEqual(await decoder.decode(token, now), expected);
  assert.deepEqual(await decoder.decode(token, now + lifetime - 1), expected);
  assert.deepEqual(await decoder.decode(token, now + lifetime), { status: 'stale' });
  assert.deepEqual(await decoder.decode(token, now - 1), { status: 'stale' });
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(token.split('.')[0]!)!));
  assert.deepEqual(payload, ['can-page-cursor', 1, binding, 7, position.after, now, now + lifetime]);
  const otherContext = await encoder.encode('b'.repeat(64), position, now);
  assert.notEqual(otherContext, token);
  assert.deepEqual(await decoder.decode(otherContext, now), { ...expected, bindingDigest: 'b'.repeat(64) });
  const otherHost = await createPageCursorCodec(new Uint8Array(32).fill(78));
  assert.deepEqual(await otherHost.decode(token, now), { status: 'invalid' });
});

test('page cursor rejects tampering, alias encodings and cross-domain canonical signed payloads', async () => {
  const codec = await createPageCursorCodec(hostKey);
  const token = await codec.encode(binding, position, now);
  const [payload, signature] = token.split('.') as [string, string];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.at(-1)!) + 1];
  assert.deepEqual(base64UrlToBytes(alias), base64UrlToBytes(signature));
  assert.deepEqual(await codec.decode(`${payload}.${alias}`, now), { status: 'invalid' });
  assert.deepEqual(await codec.decode(`${payload}.${signature.slice(1)}`, now), { status: 'invalid' });
  assert.deepEqual(await codec.decode('not.a.valid.token', now), { status: 'invalid' });
  for (const tuple of [
    ['can-source-form-binding', 1, binding, 7, position.after, now, now + lifetime],
    ['can-page-cursor', 2, binding, 7, position.after, now, now + lifetime],
    ['can-page-cursor', 1, binding, 7, position.after, now, now + lifetime, 'extra'],
    ['can-page-cursor', 1, binding, -1, position.after, now, now + lifetime],
    ['can-page-cursor', 1, binding, 7, '', now, now + lifetime],
    ['can-page-cursor', 1, binding, 7, position.after, now, now + lifetime + 1],
    ['can-page-cursor', 1, binding, 7, position.after, null, now + lifetime],
  ]) assert.deepEqual(await codec.decode(await signed(JSON.stringify(tuple)), now), { status: 'invalid' });
  assert.deepEqual(await codec.decode(await signed(` ${JSON.stringify(['can-page-cursor', 1, binding, 7, position.after, now, now + lifetime])}`), now), { status: 'invalid' });
  assert.deepEqual(await codec.decode(await signed(new Uint8Array([0xc3, 0x28])), now), { status: 'invalid' });
});

test('page cursor requires canonical host keys, bounded tokens and checked scalar inputs', async () => {
  await assert.rejects(createPageCursorCodec(new Uint8Array(31)), TypeError);
  await assert.rejects(createPageCursorCodec('not-base64url!'), TypeError);
  const encoded = bytesToBase64Url(hostKey), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const keyAlias = encoded.slice(0, -1) + alphabet[alphabet.indexOf(encoded.at(-1)!) + 1];
  await assert.rejects(createPageCursorCodec(keyAlias), TypeError);
  const codec = await createPageCursorCodec(hostKey);
  assert.deepEqual(await codec.decode('x'.repeat(4_097), now), { status: 'invalid' });
  await assert.rejects(codec.encode(binding, { ...position, after: 'x'.repeat(4_096) }, now), TypeError);
  for (const bad of ['', 'a'.repeat(63), 'A'.repeat(64)]) await assert.rejects(codec.encode(bad, position, now), TypeError);
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(codec.encode(binding, { ...position, revision }, now), TypeError);
  }
  for (const clock of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(codec.encode(binding, position, clock), TypeError);
    await assert.rejects(codec.decode('invalid', clock), TypeError);
  }
});
