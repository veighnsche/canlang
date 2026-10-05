/**
 * T16b L6 boundary: the verified-context contract the canonical join
 * relies on. Transports resolve the credential on EVERY call
 * (`resolveIdentity`) and assert the route audience (`assertAudience`)
 * before anything invokes: forged, expired, revoked, and
 * wrong-audience credentials fail here with the established codes, and
 * resolution always rechecks live store facts (never cached).
 *
 * What this file deliberately does NOT pin (no established rule):
 * admitted_at max-age and binding re-verification from a bare
 * ResolvedIdentity (the store port has no by-id credential lookup) —
 * both are T16c gaps, not silent behavior.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityError } from '../ports.js';
import { createFrozenClock, createMemoryIdentityStore } from '../testing.js';
import { sha256HexText } from '../sessions/tokens.js';
import { resolveIdentity } from './context.js';
import { assertAudience } from './audience.js';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const NOW_ISO = '2026-10-05T12:00:00.000Z';
const LATER_ISO = '2026-11-04T12:00:00.000Z';
const PAST_ISO = '2026-10-04T12:00:00.000Z';

/** Credential validity is not an oracle: one collapsed text (context.ts). */
const CREDENTIAL_FAILED = 'Session expired or revoked.';

function setup() {
  const clock = createFrozenClock(NOW);
  const store = createMemoryIdentityStore({ clock });
  return { clock, store };
}

async function seedUserTeam(store: ReturnType<typeof createMemoryIdentityStore>) {
  const user = await store.createUser({
    email: 't16b@example.test',
    password_hash: 'not-a-real-hash',
    email_verified: true,
  });
  const team = await store.createTeam({ timezone: 'UTC' });
  const membership = await store.createMembership({
    team_id: team.team_id,
    user_id: user.user_id,
    is_owner: false,
    roles: [{ role: 'members', granted_at: NOW_ISO, granted_by: user.user_id }],
  });
  return { user, team, membership };
}

async function seedSession(
  store: ReturnType<typeof createMemoryIdentityStore>,
  userId: string,
  teamId: string | null,
  rawToken: string,
  expiresAt: string,
) {
  await store.createSession({
    user_id: userId,
    token_sha256: await sha256HexText(rawToken),
    expires_at: expiresAt,
    last_team_id: teamId,
  });
}

async function seedGrant(
  store: ReturnType<typeof createMemoryIdentityStore>,
  userId: string,
  teamId: string | null,
  rawToken: string,
  expiresAt: string,
) {
  await store.createMcpGrant({
    user_id: userId,
    team_id: teamId,
    client_id: 't16b-test-client',
    token_sha256: await sha256HexText(rawToken),
    expires_at: expiresAt,
  });
}

async function captureIdentityError(fn: () => Promise<unknown>): Promise<IdentityError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof IdentityError, `want IdentityError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected an IdentityError');
}

describe('T16b verified-context boundary (L6)', () => {
  it('admits a live session with the admission checkpoint marked', async () => {
    const { clock, store } = setup();
    const { user, team } = await seedUserTeam(store);
    await seedSession(store, user.user_id, team.team_id, 'live-session-token', LATER_ISO);
    const identity = await resolveIdentity(store, { session_token: 'live-session-token' }, { clock });
    assert.equal(identity.actor?.user_id, user.user_id);
    assert.equal(identity.team?.team_id, team.team_id);
    assert.equal(identity.membership?.status, 'active');
    assert.equal(identity.binding.kind, 'session');
    assert.equal(identity.admitted_at, NOW_ISO);
    assertAudience(identity.binding, 'browser-session');
  });

  it('admits a live MCP grant on its route audience', async () => {
    const { clock, store } = setup();
    const { user, team } = await seedUserTeam(store);
    await seedGrant(store, user.user_id, team.team_id, 'live-grant-token', LATER_ISO);
    const identity = await resolveIdentity(store, { mcp_grant_token: 'live-grant-token' }, { clock });
    assert.equal(identity.actor?.user_id, user.user_id);
    assert.equal(identity.team?.team_id, team.team_id);
    assert.equal(identity.binding.kind, 'mcp_grant');
    assert.equal(identity.admitted_at, NOW_ISO);
    assertAudience(identity.binding, 'mcp-grant');
  });

  it('rejects forged session and grant tokens with the collapsed credential text', async () => {
    const { clock, store } = setup();
    await seedUserTeam(store);
    const forgedSession = await captureIdentityError(() =>
      resolveIdentity(store, { session_token: 'never-issued-token' }, { clock }),
    );
    assert.equal(forgedSession.code, 'forbidden');
    assert.equal(forgedSession.message, CREDENTIAL_FAILED);
    const forgedGrant = await captureIdentityError(() =>
      resolveIdentity(store, { mcp_grant_token: 'never-issued-grant' }, { clock }),
    );
    assert.equal(forgedGrant.code, 'forbidden');
    assert.equal(forgedGrant.message, CREDENTIAL_FAILED);
  });

  it('rejects expired sessions and grants exactly like forged ones', async () => {
    const { clock, store } = setup();
    const { user, team } = await seedUserTeam(store);
    await seedSession(store, user.user_id, team.team_id, 'stale-session', PAST_ISO);
    await seedGrant(store, user.user_id, team.team_id, 'stale-grant', PAST_ISO);
    const expiredSession = await captureIdentityError(() =>
      resolveIdentity(store, { session_token: 'stale-session' }, { clock }),
    );
    assert.equal(expiredSession.code, 'forbidden');
    assert.equal(expiredSession.message, CREDENTIAL_FAILED);
    const expiredGrant = await captureIdentityError(() =>
      resolveIdentity(store, { mcp_grant_token: 'stale-grant' }, { clock }),
    );
    assert.equal(expiredGrant.code, 'forbidden');
    assert.equal(expiredGrant.message, CREDENTIAL_FAILED);
  });

  it('rejects revoked sessions and grants exactly like forged ones', async () => {
    const { clock, store } = setup();
    const { user, team } = await seedUserTeam(store);
    const session = await store.createSession({
      user_id: user.user_id,
      token_sha256: await sha256HexText('doomed-session'),
      expires_at: LATER_ISO,
      last_team_id: team.team_id,
    });
    const grant = await store.createMcpGrant({
      user_id: user.user_id,
      team_id: team.team_id,
      client_id: 't16b-test-client',
      token_sha256: await sha256HexText('doomed-grant'),
      expires_at: LATER_ISO,
    });
    await store.revokeSession(session.session_id);
    await store.revokeMcpGrant(grant.grant_id);
    const revokedSession = await captureIdentityError(() =>
      resolveIdentity(store, { session_token: 'doomed-session' }, { clock }),
    );
    assert.equal(revokedSession.code, 'forbidden');
    assert.equal(revokedSession.message, CREDENTIAL_FAILED);
    const revokedGrant = await captureIdentityError(() =>
      resolveIdentity(store, { mcp_grant_token: 'doomed-grant' }, { clock }),
    );
    assert.equal(revokedGrant.code, 'forbidden');
    assert.equal(revokedGrant.message, CREDENTIAL_FAILED);
  });

  it('rejects wrong-audience credentials on both routes', async () => {
    const { clock, store } = setup();
    const { user, team } = await seedUserTeam(store);
    await seedSession(store, user.user_id, team.team_id, 'session-for-mcp-route', LATER_ISO);
    await seedGrant(store, user.user_id, team.team_id, 'grant-for-session-route', LATER_ISO);
    const sessionIdentity = await resolveIdentity(
      store,
      { session_token: 'session-for-mcp-route' },
      { clock },
    );
    const sessionOnMcp = await captureIdentityError(async () => {
      assertAudience(sessionIdentity.binding, 'mcp-grant');
    });
    assert.equal(sessionOnMcp.code, 'forbidden');
    assert.equal(sessionOnMcp.message, 'Credential audience mismatch.');
    const grantIdentity = await resolveIdentity(
      store,
      { mcp_grant_token: 'grant-for-session-route' },
      { clock },
    );
    const grantOnSession = await captureIdentityError(async () => {
      assertAudience(grantIdentity.binding, 'browser-session');
    });
    assert.equal(grantOnSession.code, 'forbidden');
    assert.equal(grantOnSession.message, 'Credential audience mismatch.');
  });

  it('rejects missing claims: unknown team, dual credentials, removed membership', async () => {
    const { clock, store } = setup();
    const { user, team, membership } = await seedUserTeam(store);
    await seedSession(store, user.user_id, team.team_id, 'claim-session', LATER_ISO);
    await seedGrant(store, user.user_id, team.team_id, 'claim-grant', LATER_ISO);
    const unknownTeam = await captureIdentityError(() =>
      resolveIdentity(store, { team_id: 'team-that-does-not-exist' }, { clock }),
    );
    assert.equal(unknownTeam.code, 'not_found');
    const dual = await captureIdentityError(() =>
      resolveIdentity(
        store,
        { session_token: 'claim-session', mcp_grant_token: 'claim-grant' },
        { clock },
      ),
    );
    assert.equal(dual.code, 'validation');
    // Live-store-wins: removing the membership ends grant admission at
    // once (collapsed text — a stolen grant reveals nothing).
    await store.removeMembership(membership.membership_id);
    const removed = await captureIdentityError(() =>
      resolveIdentity(store, { mcp_grant_token: 'claim-grant' }, { clock }),
    );
    assert.equal(removed.code, 'forbidden');
    assert.equal(removed.message, CREDENTIAL_FAILED);
  });

  it('rechecks live facts on every call: revoke-after-resolve fails', async () => {
    const { clock, store } = setup();
    const { user, team } = await seedUserTeam(store);
    const session = await store.createSession({
      user_id: user.user_id,
      token_sha256: await sha256HexText('revoke-after-resolve'),
      expires_at: LATER_ISO,
      last_team_id: team.team_id,
    });
    const first = await resolveIdentity(store, { session_token: 'revoke-after-resolve' }, { clock });
    assert.equal(first.actor?.user_id, user.user_id);
    await store.revokeSession(session.session_id);
    const second = await captureIdentityError(() =>
      resolveIdentity(store, { session_token: 'revoke-after-resolve' }, { clock }),
    );
    assert.equal(second.code, 'forbidden');
    assert.equal(second.message, CREDENTIAL_FAILED);
  });
});
