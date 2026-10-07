import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFrozenClock, createMemoryIdentityStore } from '../src/testing.js';
import { IdentityError, type IdentityStore } from '../src/ports.js';
import { exchangeCode, issueAuthCode, registerClient } from '../src/authentication/oauth.js';

const REDIRECT = 'https://app.example/callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const challengeOf = (verifier: string) => createHash('sha256').update(verifier, 'utf8').digest('base64url');

async function setup() {
  const clock = createFrozenClock(Date.parse('2026-10-04T15:00:00Z'));
  const store = createMemoryIdentityStore({ clock });
  const user = await store.createUser({ email: 'pkce@test.example', password_hash: 'fixture', email_verified: true });
  const client = await registerClient(store, { redirect_uris: [REDIRECT] }, { clock });
  const input = { user_id: user.user_id, team_id: null, client_id: client.client_id, redirect_uri: REDIRECT };
  return { clock, store, input };
}

function validation(error: unknown): boolean {
  return error instanceof IdentityError && error.code === 'validation';
}

test('17 independent SHA256 digest vectors issue and exchange with 43 unpadded symbols', async () => {
  const { clock, store, input } = await setup();
  const verifiers = [VERIFIER, ...'ABCDEFGHIJKLMNOP'.split('').map((letter, index) =>
    `${letter}-._~09`.repeat(22).slice(0, 43 + index * 5))];
  for (const verifier of verifiers) {
    const digest = createHash('sha256').update(verifier, 'ascii').digest();
    assert.equal(digest.length, 32);
    const challenge = digest.toString('base64url');
    assert.equal(challenge.length, 43);
    const issued = await issueAuthCode(store, { ...input, code_challenge: challenge }, { clock });
    const grant = await exchangeCode(store, { ...input, code: issued.code, code_verifier: verifier }, { clock });
    assert.ok(grant.token);
  }
});

for (const length of [44, 128]) {
  test(`S256 issuance refuses ${length}-character challenge before creating a code`, async () => {
    const { clock, store, input } = await setup();
    let created = 0;
    const counted: IdentityStore = {
      ...store,
      async createAuthCode(code) { created += 1; return store.createAuthCode(code); },
    };
    await assert.rejects(() => issueAuthCode(counted, {
      ...input, code_challenge: 'A'.repeat(length),
    }, { clock }), validation);
    assert.equal(created, 0);
  });
}

test('canonical challenge retains collapsed absent, empty, malformed and mismatched verifier failures', async () => {
  const { clock, store, input } = await setup();
  for (const verifier of [undefined, '', '!', 'x'.repeat(43)]) {
    const issued = await issueAuthCode(store, { ...input, code_challenge: challengeOf(VERIFIER) }, { clock });
    await assert.rejects(() => exchangeCode(store, {
      ...input, code: issued.code, code_verifier: verifier as string,
    }, { clock }), (error: unknown) => {
      assert.ok(error instanceof IdentityError && error.code === 'validation');
      assert.equal(error.message, 'Invalid or expired code.');
      return true;
    });
  }
});

test('length correction preserves existing verifier domain and 43-symbol noncanonical issuance', async () => {
  const { clock, store, input } = await setup();
  // Existing matching-digest behavior has no verifier grammar gate.
  for (const verifier of ['', '!', 'é']) {
    const issued = await issueAuthCode(store, { ...input, code_challenge: challengeOf(verifier) }, { clock });
    assert.ok((await exchangeCode(store, { ...input, code: issued.code, code_verifier: verifier }, { clock })).token);
  }
  // Last symbol B has nonzero unused bits; issuance still checks only length/alphabet.
  assert.ok((await issueAuthCode(store, { ...input, code_challenge: `${'A'.repeat(42)}B` }, { clock })).code);
});
