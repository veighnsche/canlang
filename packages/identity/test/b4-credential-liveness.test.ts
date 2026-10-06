/**
 * B4 commit-time credential liveness: a credential revoked or expired
 * between admission and commit voids the in-flight commit. The check
 * re-reads CURRENT store facts by token hash, mirrors the admission
 * rule exactly (null / revoked / `expires_at <= now` never admit),
 * and fails with the admission-identical message so a mid-flight
 * death never oracles when the credential died. Memory store.
 *
 * Location note: this lives in `identity/test/` (not co-located under
 * `src/authentication/`) because the package gate runs only the
 * `dist/identity/test` tree — co-located tests compile but never
 * execute.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityError } from '../src/ports.js';
import { createFrozenClock, createMemoryIdentityStore } from '../src/testing.js';
import { sha256HexText } from '../src/sessions/tokens.js';
import { resolveIdentity } from '../src/authentication/context.js';
import {
  assertCredentialLive,
  isCredentialLive,
  revokeMcpGrantByToken,
  revokeSessionByToken,
} from '../src/authentication/revocation.js';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const NOW_ISO = '2026-10-05T12:00:00.000Z';
const LIVE_EXPIRY = '2026-10-11T12:00:00.000Z';

async function seed() {
  const clock = createFrozenClock(NOW);
  const store = createMemoryIdentityStore({ clock });
  const user = await store.createUser({
    email: 'b4@example.test',
    password_hash: 'not-a-real-hash',
    email_verified: true,
  });
  const team = await store.createTeam({ timezone: 'UTC' });
  await store.createMembership({
    team_id: team.team_id,
    user_id: user.user_id,
    is_owner: true,
    roles: [],
  });
  return { clock, store, user, team };
}

async function assertForbidden(fn: () => Promise<unknown>): Promise<IdentityError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof IdentityError, `want IdentityError, got ${String(error)}`);
    assert.equal(error.code, 'forbidden');
    return error;
  }
  assert.fail('expected forbidden IdentityError');
}

test('a live session passes the commit-time check', async () => {
  const { store, user } = await seed();
  const hash = await sha256HexText('live-token');
  await store.createSession({
    user_id: user.user_id,
    token_sha256: hash,
    expires_at: LIVE_EXPIRY,
    last_team_id: null,
  });
  const row = await store.findSessionByTokenHash(hash);
  assert.equal(isCredentialLive(row, NOW_ISO), true);
  await assertCredentialLive(store, { kind: 'session', tokenHash: hash, now: NOW_ISO });
});

test('a session revoked mid-flight voids the commit with the admission message', async () => {
  const { clock, store, user } = await seed();
  const hash = await sha256HexText('doomed-token');
  await store.createSession({
    user_id: user.user_id,
    token_sha256: hash,
    expires_at: LIVE_EXPIRY,
    last_team_id: null,
  });
  // Admitted fine before the revocation lands.
  await assertCredentialLive(store, { kind: 'session', tokenHash: hash, now: NOW_ISO });
  await revokeSessionByToken(store, { token: 'doomed-token' });
  const midFlight = await assertForbidden(() =>
    assertCredentialLive(store, { kind: 'session', tokenHash: hash, now: NOW_ISO }),
  );
  // The same death at admission carries the identical message: no oracle.
  const atAdmission = await assertForbidden(() =>
    resolveIdentity(store, { session_token: 'doomed-token' }, { clock }),
  );
  assert.equal(midFlight.message, atAdmission.message);
});

test('expired and unknown sessions share the one mid-flight failure', async () => {
  const { store, user } = await seed();
  const expiredHash = await sha256HexText('expired-token');
  await store.createSession({
    user_id: user.user_id,
    token_sha256: expiredHash,
    expires_at: '2026-10-04T12:00:00.000Z',
    last_team_id: null,
  });
  const messages = new Set<string>();
  for (const [kind, tokenHash] of [
    ['session', expiredHash],
    ['session', await sha256HexText('never-issued')],
  ] as const) {
    const error = await assertForbidden(() =>
      assertCredentialLive(store, { kind, tokenHash, now: NOW_ISO }),
    );
    messages.add(error.message);
  }
  assert.equal(messages.size, 1);
  assert.equal([...messages][0], 'Session expired or revoked.');
});

test('the expiry boundary is exclusive: expiring exactly at now is dead', async () => {
  const { clock, store, user } = await seed();
  const hash = await sha256HexText('edge-token');
  await store.createSession({
    user_id: user.user_id,
    token_sha256: hash,
    expires_at: NOW_ISO,
    last_team_id: null,
  });
  const row = await store.findSessionByTokenHash(hash);
  assert.equal(isCredentialLive(row, NOW_ISO), false);
  await assertForbidden(() =>
    assertCredentialLive(store, { kind: 'session', tokenHash: hash, now: NOW_ISO }),
  );
  // Admission agrees on the same boundary.
  await assertForbidden(() =>
    resolveIdentity(store, { session_token: 'edge-token' }, { clock }),
  );
});

test('mcp grants: live passes, mid-flight revoke voids with the same message', async () => {
  const { clock, store, user, team } = await seed();
  const hash = await sha256HexText('grant-token');
  await store.createMcpGrant({
    user_id: user.user_id,
    team_id: team.team_id,
    client_id: 'b4-probe',
    token_sha256: hash,
    expires_at: '2026-11-04T12:00:00.000Z',
  });
  await assertCredentialLive(store, { kind: 'mcp_grant', tokenHash: hash, now: NOW_ISO });
  await revokeMcpGrantByToken(store, { token: 'grant-token' });
  const midFlight = await assertForbidden(() =>
    assertCredentialLive(store, { kind: 'mcp_grant', tokenHash: hash, now: NOW_ISO }),
  );
  const atAdmission = await assertForbidden(() =>
    resolveIdentity(store, { mcp_grant_token: 'grant-token' }, { clock }),
  );
  assert.equal(midFlight.message, atAdmission.message);
});
