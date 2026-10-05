/**
 * Pre-session login tokens: mint/consume lifecycle over the memory store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  consumePreSessionToken,
  mintPreSessionToken,
} from '../src/sessions/presession.js';
import { createFrozenClock, createMemoryIdentityStore } from '../src/testing.js';

test('mint then consume succeeds exactly once', async () => {
  const store = createMemoryIdentityStore();
  const { token } = await mintPreSessionToken(store);
  assert.ok(token.length > 0);
  assert.equal(await consumePreSessionToken(store, token), true);
  assert.equal(await consumePreSessionToken(store, token), false);
});

test('unknown, empty, and non-string presentations fail without side effects', async () => {
  const store = createMemoryIdentityStore();
  const { token } = await mintPreSessionToken(store);
  assert.equal(await consumePreSessionToken(store, 'never-minted'), false);
  assert.equal(await consumePreSessionToken(store, ''), false);
  assert.equal(await consumePreSessionToken(store, undefined), false);
  assert.equal(await consumePreSessionToken(store, 42), false);
  // The minted token survives the invalid attempts (verify-before-delete).
  assert.equal(await consumePreSessionToken(store, token), true);
});

test('expired tokens fail and are deleted', async () => {
  const clock = createFrozenClock(Date.parse('2026-10-04T15:00:00.000Z'));
  const store = createMemoryIdentityStore({ clock });
  const { token } = await mintPreSessionToken(store, { clock, ttlMs: 60_000 });
  clock.advance(61_000);
  assert.equal(await consumePreSessionToken(store, token, { clock }), false);
  assert.equal(await consumePreSessionToken(store, token, { clock }), false);
});

test('only the hash is stored, never the raw token', async () => {
  const store = createMemoryIdentityStore();
  const { token } = await mintPreSessionToken(store);
  const { sha256HexText } = await import('../src/sessions/tokens.js');
  const row = await store.findPreSessionTokenByHash(await sha256HexText(token));
  assert.ok(row !== null);
  assert.ok(!JSON.stringify(row).includes(token));
});
