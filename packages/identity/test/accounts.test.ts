/**
 * Accounts behavior: registration, verification, login, recovery.
 * Memory store + outbox + frozen clock from src/testing.ts (test-only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { IdentityError, webRandom } from '../src/ports.js';
import type { IdentityStore } from '../src/ports.js';
import {
  createFrozenClock,
  createMemoryIdentityStore,
  createTestMailOutbox,
} from '../src/testing.js';
import { base64UrlToBytes, sha256HexText } from '../src/sessions/tokens.js';
import { hashPassword, verifyPassword } from '../src/accounts/passwords.js';
import {
  DUMMY_PASSWORD_ENCODING,
  loginWithPassword,
  registerWithEmail,
  verifyEmail,
} from '../src/accounts/registration.js';
import { recoverAccount, requestRecovery } from '../src/accounts/recovery.js';

const NOW = Date.parse('2026-10-04T15:00:00.000Z');

function setup() {
  const clock = createFrozenClock(NOW);
  const store = createMemoryIdentityStore({ clock });
  const mail = createTestMailOutbox();
  return { clock, store, mail };
}

async function assertIdentityError(
  fn: () => Promise<unknown>,
  code: string,
): Promise<IdentityError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof IdentityError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail('expected IdentityError');
}

test('password hashing round-trips and rejects malformed encodings', async () => {
  const encoded = await hashPassword('correct-horse-9');
  assert.ok(encoded.startsWith('pbkdf2-sha256$600000$'));
  assert.equal(await verifyPassword('correct-horse-9', encoded), true);
  assert.equal(await verifyPassword('wrong', encoded), false);
  for (const bad of ['', 'rot13$1$xx', 'pbkdf2-sha256$0$AA$BB', 'pbkdf2-sha256$abc$AA$BB']) {
    assert.equal(await verifyPassword('correct-horse-9', bad), false);
  }
  await assertIdentityError(() => hashPassword('short'), 'validation');
  // The login-miss dummy encoding parses with exact salt/key lengths, so the
  // dummy verification reaches PBKDF2 rather than a malformed-record exit.
  const parts = DUMMY_PASSWORD_ENCODING.split('$');
  assert.equal(parts[0], 'pbkdf2-sha256');
  assert.equal(base64UrlToBytes(parts[2] ?? '')?.length, 16);
  assert.equal(base64UrlToBytes(parts[3] ?? '')?.length, 32);
  assert.equal(await verifyPassword('anything-at-all', DUMMY_PASSWORD_ENCODING), false);
});

test('password derivation failures are false while native comparison faults reject', async (t) => {
  const encoded = DUMMY_PASSWORD_ENCODING;
  const failure = new Error('synthetic derivation failure');
  const derivation = t.mock.method(globalThis.crypto.subtle, 'deriveBits', async () => {
    throw failure;
  });
  try {
    assert.equal(await verifyPassword('synthetic-password', encoded), false);
  } finally {
    derivation.mock.restore();
  }
  const comparisonFault = new Error('synthetic native comparison fault');
  const primitive = t.mock.method(crypto, 'timingSafeEqual', () => { throw comparisonFault; });
  syncBuiltinESMExports();
  try {
    const verification = verifyPassword('synthetic-password', encoded);
    assert.ok(verification instanceof Promise);
    await assert.rejects(verification, (error) => error === comparisonFault);
    assert.equal(await verifyPassword('synthetic-password', 'malformed'), false);
  } finally {
    primitive.mock.restore();
    syncBuiltinESMExports();
  }
});

test('registration creates an unverified user and mails a token link', async () => {
  const { store, mail, clock } = setup();
  const { user_id, email } = await registerWithEmail(
    store,
    mail,
    { email: 'Ada@Example.com ', password: 's3cure-password' },
    { clock, verifyBaseUrl: 'https://app.example.com/verify' },
  );
  assert.equal(email, 'ada@example.com');
  const row = await store.findUserByEmail('ada@example.com');
  assert.ok(row);
  assert.equal(row.user_id, user_id);
  assert.equal(row.email_verified, false);
  assert.ok(row.password_hash.startsWith('pbkdf2-sha256$'));
  assert.equal(mail.messages.length, 1);
  const body = mail.messages[0]?.body_text ?? '';
  const token = (body.match(/[?&]token=([A-Za-z0-9_-]+)/) ?? [])[1] ?? '';
  assert.ok(token.length >= 43);
  // Only the hash is stored; the raw token is not recoverable from the row.
  const stored = await store.findEmailTokenByHash(await sha256HexText(token));
  assert.ok(stored);
  assert.equal(stored.purpose, 'verify_email');
  assert.equal(stored.consumed_at, null);
});

test('account token links preserve base query and fragment while replacing stale tokens', async () => {
  const { store, mail, clock } = setup();
  const { user_id } = await registerWithEmail(store, mail,
    { email: 'links@example.com', password: 's3cure-password' },
    { clock, verifyBaseUrl: 'https://app.example.com/verify?lang=nl&token=stale#form' });
  const verifyUrl = new URL(mail.messages[0]!.body_text.split('\n')[1]!);
  assert.equal(verifyUrl.pathname, '/verify');
  assert.equal(verifyUrl.searchParams.get('lang'), 'nl');
  assert.equal(verifyUrl.hash, '#form');
  const verifyToken = verifyUrl.searchParams.get('token');
  assert.ok(verifyToken && verifyToken !== 'stale');
  assert.deepEqual(verifyUrl.searchParams.getAll('token'), [verifyToken]);
  const verification = await store.findEmailTokenByHash(await sha256HexText(verifyToken));
  assert.ok(verification);
  assert.equal(verification.user_id, user_id);
  assert.equal(verification.purpose, 'verify_email');
  assert.deepEqual(await verifyEmail(store, { token: verifyToken }, { clock }), { user_id });

  await requestRecovery(store, mail, { email: 'links@example.com' },
    { clock, recoveryBaseUrl: 'https://app.example.com/recover?lang=nl&token=stale#form' });
  const recoveryUrl = new URL(mail.messages[1]!.body_text.split('\n')[1]!);
  assert.equal(recoveryUrl.pathname, '/recover');
  assert.equal(recoveryUrl.searchParams.get('lang'), 'nl');
  assert.equal(recoveryUrl.hash, '#form');
  const recoveryToken = recoveryUrl.searchParams.get('token');
  assert.ok(recoveryToken && recoveryToken !== 'stale');
  assert.deepEqual(recoveryUrl.searchParams.getAll('token'), [recoveryToken]);
  const recovery = await store.findEmailTokenByHash(await sha256HexText(recoveryToken));
  assert.ok(recovery);
  assert.equal(recovery.user_id, user_id);
  assert.equal(recovery.purpose, 'recover_account');
  assert.deepEqual(await recoverAccount(store,
    { token: recoveryToken, new_password: 'br4nd-new-password' }, { clock }), { user_id });
  const user = await store.findUserById(user_id);
  assert.ok(user);
  assert.equal(await verifyPassword('br4nd-new-password', user.password_hash), true);
});

test('registration rejects duplicates and invalid input', async () => {
  const { store, mail, clock } = setup();
  const opts = { clock, verifyBaseUrl: 'https://app.example.com/verify' };
  await registerWithEmail(store, mail, { email: 'a@x.co', password: 's3cure-password' }, opts);
  await assertIdentityError(
    () => registerWithEmail(store, mail, { email: 'A@X.CO', password: 'other-password' }, opts),
    'conflict',
  );
  await assertIdentityError(
    () => registerWithEmail(store, mail, { email: 'not-an-email', password: 's3cure-password' }, opts),
    'validation',
  );
  await assertIdentityError(
    () => registerWithEmail(store, mail, { email: 'b@x.co', password: 'short' }, opts),
    'validation',
  );
  assert.equal(mail.messages.length, 1);
});

test('email verification activates the account exactly once', async () => {
  const { store, mail, clock } = setup();
  const opts = { clock, verifyBaseUrl: 'https://app.example.com/verify' };
  await registerWithEmail(store, mail, { email: 'a@x.co', password: 's3cure-password' }, opts);
  const token = (mail.messages[0]?.body_text.match(/[?&]token=([A-Za-z0-9_-]+)/) ?? [])[1] ?? '';
  const { user_id } = await verifyEmail(store, { token }, { clock });
  assert.equal((await store.findUserById(user_id))?.email_verified, true);
  await assertIdentityError(() => verifyEmail(store, { token }, { clock }), 'validation');
  await assertIdentityError(() => verifyEmail(store, { token: 'bogus' }, { clock }), 'validation');
});

test('expired verification links fail', async () => {
  const { store, mail, clock } = setup();
  const opts = { clock, verifyBaseUrl: 'https://app.example.com/verify' };
  await registerWithEmail(store, mail, { email: 'a@x.co', password: 's3cure-password' }, opts);
  const token = (mail.messages[0]?.body_text.match(/[?&]token=([A-Za-z0-9_-]+)/) ?? [])[1] ?? '';
  clock.advance(25 * 60 * 60 * 1000);
  await assertIdentityError(() => verifyEmail(store, { token }, { clock }), 'validation');
});

test('login issues a live session only to verified holders', async () => {
  const { store, mail, clock } = setup();
  const opts = { clock, verifyBaseUrl: 'https://app.example.com/verify' };
  await registerWithEmail(store, mail, { email: 'a@x.co', password: 's3cure-password' }, opts);
  await assertIdentityError(
    () => loginWithPassword(store, { email: 'a@x.co', password: 's3cure-password' }, { clock }),
    'forbidden',
  );
  const token = (mail.messages[0]?.body_text.match(/[?&]token=([A-Za-z0-9_-]+)/) ?? [])[1] ?? '';
  await verifyEmail(store, { token }, { clock });
  const { token: sessionToken } = await loginWithPassword(
    store,
    { email: 'a@x.co', password: 's3cure-password' },
    { clock },
  );
  const session = await store.findSessionByTokenHash(await sha256HexText(sessionToken));
  assert.ok(session);
  assert.equal(session.revoked_at, null);
  // Unknown email and wrong password are indistinguishable.
  const wrong = await assertIdentityError(
    () => loginWithPassword(store, { email: 'a@x.co', password: 'nope-nope-nope' }, { clock }),
    'forbidden',
  );
  const unknown = await assertIdentityError(
    () => loginWithPassword(store, { email: 'ghost@x.co', password: 'nope-nope-nope' }, { clock }),
    'forbidden',
  );
  assert.equal(wrong.message, unknown.message);
});

test('email tokens reject purpose confusion in both directions', async () => {
  const { store, mail, clock } = setup();
  const opts = { clock, verifyBaseUrl: 'https://app.example.com/verify' };
  await registerWithEmail(store, mail, { email: 'a@x.co', password: 's3cure-password' }, opts);
  const verifyToken = (mail.messages[0]?.body_text.match(/[?&]token=([A-Za-z0-9_-]+)/) ?? [])[1] ?? '';
  await requestRecovery(
    store,
    mail,
    { email: 'a@x.co' },
    { clock, recoveryBaseUrl: 'https://app.example.com/recover' },
  );
  const recoverToken =
    (mail.messages[mail.messages.length - 1]?.body_text.match(/[?&]token=([A-Za-z0-9_-]+)/) ?? [])[1] ?? '';
  await assertIdentityError(
    () => verifyEmail(store, { token: recoverToken }, { clock }),
    'validation',
  );
  await assertIdentityError(
    () => recoverAccount(store, { token: verifyToken, new_password: 'br4nd-new-password' }, { clock }),
    'validation',
  );
});

test('recovery never enumerates and rotates credentials on completion', async () => {
  const { store, mail, clock } = setup();
  const opts = { clock, verifyBaseUrl: 'https://app.example.com/verify' };
  await registerWithEmail(store, mail, { email: 'a@x.co', password: 's3cure-password' }, opts);
  const token = (mail.messages[0]?.body_text.match(/[?&]token=([A-Za-z0-9_-]+)/) ?? [])[1] ?? '';
  await verifyEmail(store, { token }, { clock });
  const before = await loginWithPassword(
    store,
    { email: 'a@x.co', password: 's3cure-password' },
    { clock },
  );
  const user = await store.findUserByEmail('a@x.co');
  assert.ok(user);
  const grant = await store.createMcpGrant({
    user_id: user.user_id,
    team_id: null,
    client_id: 'chatbot',
    token_sha256: await sha256HexText('user-grant'),
    expires_at: '2026-11-04T15:00:00.000Z',
  });

  const mailsBefore = mail.messages.length;
  assert.deepEqual(
    await requestRecovery(
      store,
      mail,
      { email: 'nobody@x.co' },
      { clock, recoveryBaseUrl: 'https://app.example.com/recover' },
    ),
    { ok: true },
  );
  assert.equal(mail.messages.length, mailsBefore);

  await requestRecovery(
    store,
    mail,
    { email: 'a@x.co' },
    { clock, recoveryBaseUrl: 'https://app.example.com/recover' },
  );
  const link = mail.messages[mail.messages.length - 1]?.body_text ?? '';
  const raw = (link.match(/[?&]token=([A-Za-z0-9_-]+)/) ?? [])[1] ?? '';
  await recoverAccount(store, { token: raw, new_password: 'br4nd-new-password' }, { clock });

  // Old password dead, old session revoked, recovery token consumed.
  await assertIdentityError(
    () => loginWithPassword(store, { email: 'a@x.co', password: 's3cure-password' }, { clock }),
    'forbidden',
  );
  const oldSession = await store.findSessionByTokenHash(await sha256HexText(before.token));
  assert.ok(oldSession?.revoked_at !== null && oldSession?.revoked_at !== undefined);
  const revokedGrant = await store.findMcpGrantByTokenHash(await sha256HexText('user-grant'));
  assert.equal(revokedGrant?.grant_id, grant.grant_id);
  assert.ok(revokedGrant?.revoked_at !== null && revokedGrant?.revoked_at !== undefined);
  await assertIdentityError(
    () => recoverAccount(store, { token: raw, new_password: 'another-password-1' }, { clock }),
    'validation',
  );
  const fresh = await loginWithPassword(
    store,
    { email: 'a@x.co', password: 'br4nd-new-password' },
    { clock },
  );
  assert.ok(fresh.token.length > 0);
});

test('expired recovery links fail', async () => {
  const { store, mail, clock } = setup();
  const opts = { clock, verifyBaseUrl: 'https://app.example.com/verify' };
  await registerWithEmail(store, mail, { email: 'a@x.co', password: 's3cure-password' }, opts);
  await requestRecovery(
    store,
    mail,
    { email: 'a@x.co' },
    { clock, recoveryBaseUrl: 'https://app.example.com/recover' },
  );
  const link = mail.messages[mail.messages.length - 1]?.body_text ?? '';
  const raw = (link.match(/[?&]token=([A-Za-z0-9_-]+)/) ?? [])[1] ?? '';
  clock.advance(2 * 60 * 60 * 1000);
  await assertIdentityError(
    () => recoverAccount(store, { token: raw, new_password: 'br4nd-new-password' }, { clock }),
    'validation',
  );
});

test('recovery admits both initial readers but only one same-clock password and revocation winner', async () => {
  const { store, clock } = setup();
  const user = await store.createUser({ email: 'race@x.co', password_hash: 'original-hash', email_verified: true });
  const expires_at = new Date(NOW + 60_000).toISOString();
  const raw = 'shared-recovery-proof';
  const token_sha256 = await sha256HexText(raw);
  await store.createEmailToken({ user_id: user.user_id, purpose: 'recover_account', token_sha256, expires_at });
  await store.createSession({ user_id: user.user_id, token_sha256: 'old-session', expires_at, last_team_id: null });
  await store.createMcpGrant({ user_id: user.user_id, team_id: null, client_id: 'client', token_sha256: 'old-grant', expires_at });
  let readers = 0, admit!: () => void, releaseLoser!: () => void;
  const bothReaders = new Promise<void>(resolve => { admit = resolve; });
  const loserGate = new Promise<void>(resolve => { releaseLoser = resolve; });
  const readProof: IdentityStore['findEmailTokenByHash'] = async hash => {
    const row = await store.findEmailTokenByHash(hash);
    assert.equal(row?.consumed_at, null, 'each public attempt observes the original live proof');
    if (++readers === 2) admit();
    await bothReaders;
    return row;
  };
  const winnerStore = { ...store, findEmailTokenByHash: readProof };
  const loserStore: IdentityStore = { ...store, findEmailTokenByHash: readProof,
    async recoverAccountWithToken(input) {
      await loserGate;
      return store.recoverAccountWithToken!(input);
    } };
  const winner = recoverAccount(winnerStore, { token: raw, new_password: 'winner-password-1' }, { clock });
  const loser = recoverAccount(loserStore, { token: raw, new_password: 'loser-password-2' }, { clock });
  // Attach the rejection observer immediately; the loser resumes only after
  // credentials issued following the winner have been captured.
  const losingResult = assertIdentityError(() => loser, 'validation');
  try {
    assert.deepEqual(await winner, { user_id: user.user_id });
    assert.equal(readers, 2);
    assert.equal((await store.findSessionByTokenHash('old-session'))?.revoked_at, new Date(NOW).toISOString());
    assert.equal((await store.findMcpGrantByTokenHash('old-grant'))?.revoked_at, new Date(NOW).toISOString());
    await store.createSession({ user_id: user.user_id, token_sha256: 'fresh-session', expires_at, last_team_id: null });
    await store.createMcpGrant({ user_id: user.user_id, team_id: null, client_id: 'client', token_sha256: 'fresh-grant', expires_at });
    await store.createEmailToken({ user_id: user.user_id, purpose: 'recover_account', token_sha256: 'fresh-recovery-proof', expires_at });
    const password = (await store.findUserById(user.user_id))!.password_hash;
    releaseLoser();
    await losingResult;
    assert.equal((await store.findUserById(user.user_id))!.password_hash, password);
    assert.equal(await verifyPassword('winner-password-1', password), true);
    assert.equal(await verifyPassword('loser-password-2', password), false);
    assert.equal((await store.findSessionByTokenHash('fresh-session'))?.revoked_at, null);
    assert.equal((await store.findMcpGrantByTokenHash('fresh-grant'))?.revoked_at, null);
    assert.equal((await store.findEmailTokenByHash('fresh-recovery-proof'))?.consumed_at, null);
    assert.equal(clock.nowMs(), NOW);
  } finally { releaseLoser(); }
});

test('recovery rechecks store expiry after genuine password salt generation without any effects', async () => {
  const { store, clock } = setup();
  const user = await store.createUser({ email: 'expiry@x.co', password_hash: 'original-hash', email_verified: true });
  const expires_at = new Date(NOW + 1_000).toISOString();
  const raw = 'expiring-recovery-proof';
  const token_sha256 = await sha256HexText(raw);
  await store.createEmailToken({ user_id: user.user_id, purpose: 'recover_account', token_sha256, expires_at });
  await store.createEmailToken({ user_id: user.user_id, purpose: 'recover_account', token_sha256: 'sibling-proof', expires_at });
  await store.createEmailToken({ user_id: user.user_id, purpose: 'verify_email', token_sha256: 'verification-proof', expires_at });
  await store.createSession({ user_id: user.user_id, token_sha256: 'expiry-session', expires_at, last_team_id: null });
  await store.createMcpGrant({ user_id: user.user_id, team_id: null, client_id: 'client', token_sha256: 'expiry-grant', expires_at });
  const facts = async () => Promise.all([
    store.findUserById(user.user_id), store.findEmailTokenByHash(token_sha256),
    store.findEmailTokenByHash('sibling-proof'), store.findEmailTokenByHash('verification-proof'),
    store.findSessionByTokenHash('expiry-session'), store.findMcpGrantByTokenHash('expiry-grant'),
  ]);
  const before = await facts();
  let salts = 0;
  await assertIdentityError(() => recoverAccount(store, { token: raw, new_password: 'expiry-password-1' }, {
    clock,
    random: { randomUUID: () => webRandom.randomUUID(), randomBytes(length) {
      salts++;
      assert.equal(clock.nowMs(), NOW, 'the initial public expiry check already admitted the proof');
      const salt = webRandom.randomBytes(length);
      clock.advance(1_000);
      return salt;
    } },
  }), 'validation');
  assert.equal(salts, 1);
  assert.deepEqual(await facts(), before);
});

test('recovery with an unsupported atomic store fails before hashing or credential mutation', async () => {
  const { store, clock } = setup();
  const user = await store.createUser({ email: 'unsupported@x.co', password_hash: 'original-hash', email_verified: true });
  const raw = 'unsupported-recovery-proof', token_sha256 = await sha256HexText(raw);
  const expires_at = new Date(NOW + 60_000).toISOString();
  await store.createEmailToken({ user_id: user.user_id, purpose: 'recover_account', token_sha256, expires_at });
  await store.createSession({ user_id: user.user_id, token_sha256: 'unsupported-session', expires_at, last_team_id: null });
  await store.createMcpGrant({ user_id: user.user_id, team_id: null, client_id: 'client', token_sha256: 'unsupported-grant', expires_at });
  const facts = async () => Promise.all([store.findUserById(user.user_id), store.findEmailTokenByHash(token_sha256),
    store.findSessionByTokenHash('unsupported-session'), store.findMcpGrantByTokenHash('unsupported-grant')]);
  const before = await facts();
  let salts = 0;
  const unsupported: IdentityStore = { ...store };
  delete unsupported.recoverAccountWithToken;
  await assert.rejects(recoverAccount(unsupported,
    { token: raw, new_password: 'unsupported-password-1' }, { clock,
      random: { randomUUID: () => webRandom.randomUUID(), randomBytes(length) { salts++; return webRandom.randomBytes(length); } },
    }), /Atomic account recovery is unavailable/);
  assert.equal(salts, 0);
  assert.deepEqual(await facts(), before);
});


test('persisted password byte aliases retain verification without changing issuance', async () => {
  // Independently frozen synthetic PBKDF2 witness, not a generated test oracle.
  const password = 'synthetic-contract-password';
  const salt = 'AAECAwQFBgcICQoLDA0ODw';
  const saltAlias = 'AAECAwQFBgcICQoLDA0OD_';
  const key = 'z10WsuKIJTF3LLwnB8LElW5c-astSCajEOQ0vI73OWQ';
  const keyAlias = 'z10WsuKIJTF3LLwnB8LElW5c-astSCajEOQ0vI73OWT';
  for (const [storedSalt, storedKey] of [[salt, key], [saltAlias, key], [salt, keyAlias], [saltAlias, keyAlias]]) {
    const encoded = `pbkdf2-sha256$600000$${storedSalt}$${storedKey}`;
    assert.equal(await verifyPassword(password, encoded), true);
    assert.equal(await verifyPassword('wrong-synthetic-password', encoded), false);
  }
  for (const [badSalt, badKey] of [[salt + '=', key], [salt, key + '='], ['!' + salt.slice(1), key], [salt, 'a'], [salt.slice(0, -2), key], [salt, key.slice(0, -2)]]) {
    assert.equal(await verifyPassword(password, `pbkdf2-sha256$600000$${badSalt}$${badKey}`), false);
  }
});
