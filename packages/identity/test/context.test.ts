/**
 * Identity resolution behavior: public, session, and MCP-grant callers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityError } from '../src/ports.js';
import {
  createFrozenClock,
  createMemoryIdentityStore,
} from '../src/testing.js';
import { hashPassword } from '../src/accounts/passwords.js';
import { sha256HexText } from '../src/sessions/tokens.js';
import { resolveIdentity } from '../src/authentication/context.js';
import {
  revokeMcpGrantByToken,
  revokeSessionByToken,
  signOutEverywhere,
} from '../src/authentication/revocation.js';
import { assertAudience, bindingAudience } from '../src/authentication/audience.js';

const NOW = Date.parse('2026-10-04T15:00:00.000Z');
const NOW_ISO = '2026-10-04T15:00:00.000Z';

function setup() {
  const clock = createFrozenClock(NOW);
  const store = createMemoryIdentityStore({ clock });
  return { clock, store };
}

async function userWithTeam() {
  const { clock, store } = setup();
  const user = await store.createUser({
    email: 'a@x.co',
    password_hash: await hashPassword('s3cure-password'),
    email_verified: true,
  });
  const team = await store.createTeam({ timezone: 'Europe/Amsterdam' });
  const membership = await store.createMembership({
    team_id: team.team_id,
    user_id: user.user_id,
    is_owner: true,
    roles: [],
  });
  return { clock, store, user, team, membership };
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

test('public callers resolve with null actor and optional team', async () => {
  const { clock, store, team } = await userWithTeam();
  const bare = await resolveIdentity(store, {}, { clock });
  assert.equal(bare.actor, null);
  assert.equal(bare.team, null);
  assert.equal(bare.membership, null);
  assert.deepEqual(bare.binding, { kind: 'none' });
  assert.equal(bare.admitted_at, NOW_ISO);

  const scoped = await resolveIdentity(store, { team_id: team.team_id }, { clock });
  assert.equal(scoped.actor, null);
  assert.equal(scoped.team?.team_id, team.team_id);
  assert.equal(scoped.team?.timezone, 'Europe/Amsterdam');
  assert.equal(scoped.membership, null);
  await assertIdentityError(() => resolveIdentity(store, { team_id: 'missing' }), 'not_found');
});

test('session callers resolve actor, team hint, and active membership', async () => {
  const { clock, store, user, team } = await userWithTeam();
  const session = await store.createSession({
    user_id: user.user_id,
    token_sha256: await sha256HexText('good-token'),
    expires_at: '2026-10-11T15:00:00.000Z',
    last_team_id: team.team_id,
  });
  const identity = await resolveIdentity(store, { session_token: 'good-token' }, { clock });
  assert.deepEqual(identity.actor, {
    user_id: user.user_id,
    email: 'a@x.co',
    email_verified: true,
  });
  assert.equal(identity.team?.team_id, team.team_id);
  assert.equal(identity.membership?.membership_id !== undefined, true);
  assert.deepEqual(identity.binding, { kind: 'session', session_id: session.session_id });

  // Explicit team scope overrides the recorded hint.
  const other = await store.createTeam({});
  await store.createMembership({
    team_id: other.team_id,
    user_id: user.user_id,
    is_owner: false,
    roles: [],
  });
  const switched = await resolveIdentity(
    store,
    { session_token: 'good-token', team_id: other.team_id },
    { clock },
  );
  assert.equal(switched.team?.team_id, other.team_id);
  assert.equal(switched.membership?.is_owner, false);
  // Unknown explicit team fails; unknown hint degrades to app-only.
  await assertIdentityError(
    () => resolveIdentity(store, { session_token: 'good-token', team_id: 'missing' }, { clock }),
    'not_found',
  );
});

test('revoked, expired, and unknown sessions share one failure', async () => {
  const { clock, store, user } = await userWithTeam();
  await store.createSession({
    user_id: user.user_id,
    token_sha256: await sha256HexText('live-token'),
    expires_at: '2026-10-11T15:00:00.000Z',
    last_team_id: null,
  });
  const expired = await store.createSession({
    user_id: user.user_id,
    token_sha256: await sha256HexText('old-token'),
    expires_at: '2026-10-04T14:00:00.000Z',
    last_team_id: null,
  });
  await store.revokeSession(expired.session_id);
  const messages = new Set<string>();
  for (const token of ['live-token-missing', 'old-token', 'never-issued']) {
    const error = await assertIdentityError(
      () => resolveIdentity(store, { session_token: token }, { clock }),
      'forbidden',
    );
    messages.add(error.message);
  }
  assert.equal(messages.size, 1);
  // Revocation takes effect immediately, before expiry.
  await revokeSessionByToken(store, { token: 'live-token' });
  await assertIdentityError(
    () => resolveIdentity(store, { session_token: 'live-token' }, { clock }),
    'forbidden',
  );
  // Unknown-token revocation is idempotent success.
  assert.deepEqual(await revokeSessionByToken(store, { token: 'ghost' }), { revoked: true });
});

test('MCP grants bind one user and one team', async () => {
  const { clock, store, user, team } = await userWithTeam();
  await store.createMcpGrant({
    user_id: user.user_id,
    team_id: team.team_id,
    client_id: 'chatbot',
    token_sha256: await sha256HexText('grant-token'),
    expires_at: '2026-11-04T15:00:00.000Z',
  });
  const identity = await resolveIdentity(store, { mcp_grant_token: 'grant-token' }, { clock });
  assert.equal(identity.actor?.user_id, user.user_id);
  assert.equal(identity.team?.team_id, team.team_id);
  assert.equal(identity.membership?.is_owner, true);
  assert.equal(identity.binding.kind, 'mcp_grant');

  const other = await store.createTeam({});
  await assertIdentityError(
    () =>
      resolveIdentity(store, { mcp_grant_token: 'grant-token', team_id: other.team_id }, { clock }),
    'forbidden',
  );
  // Removed membership ends grant admission; audience helpers agree.
  const membership = await store.findMembership(team.team_id, user.user_id);
  assert.ok(membership);
  await store.removeMembership(membership.membership_id);
  await assertIdentityError(
    () => resolveIdentity(store, { mcp_grant_token: 'grant-token' }, { clock }),
    'forbidden',
  );
  assert.equal(bindingAudience(identity.binding), 'mcp-grant');
  await assertIdentityError(
    () => resolveIdentity(store, { session_token: 'x', mcp_grant_token: 'y' }, { clock }),
    'validation',
  );
  await revokeMcpGrantByToken(store, { token: 'grant-token' });
  await signOutEverywhere(store, { user_id: user.user_id });
  await assertIdentityError(
    () => resolveIdentity(store, { mcp_grant_token: 'grant-token' }, { clock }),
    'forbidden',
  );
});

test('audience assertions separate transport credentials', () => {
  assert.equal(bindingAudience({ kind: 'session', session_id: 's' }), 'browser-session');
  assert.equal(bindingAudience({ kind: 'mcp_grant', grant_id: 'g' }), 'mcp-grant');
  assert.equal(bindingAudience({ kind: 'none' }), 'public');
  assertAudience({ kind: 'session', session_id: 's' }, 'browser-session');
  try {
    assertAudience({ kind: 'session', session_id: 's' }, 'mcp-grant');
    assert.fail('expected IdentityError');
  } catch (error) {
    assert.ok(error instanceof IdentityError);
    assert.equal(error.code, 'forbidden');
  }
});
