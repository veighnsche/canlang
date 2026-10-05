/**
 * D1-backed IdentityStore (MCP deploy packet P-C): full `IdentityStore`
 * conformance over REAL SQL semantics (node:sqlite, same dialect family
 * as D1), plus the production grant/session read paths through the REAL
 * `issueMcpGrant` + `resolveIdentity` constructors.
 *
 * Failing-first: written before `src/storage/d1.ts` existed. The
 * workerd-D1 proof (miniflare) lives in the cloudflare suite
 * (`test/mcpd-env-assembly.test.ts`), which drives this same store
 * through a real D1 binding; this file proves the store's SQL against a
 * real relational engine with zero new dependencies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { IdentityError } from '../src/ports.js';
import type { IdentityStore } from '../src/ports.js';
import { createFrozenClock } from '../src/testing.js';
import { resolveIdentity } from '../src/authentication/context.js';
import { issueMcpGrant } from '../src/authentication/grants.js';
import {
  createD1IdentityStore,
  ensureIdentitySchema,
  type IdentityD1Database,
} from '../src/storage/d1.js';

const NOW = Date.parse('2026-10-04T15:00:00.000Z');

/** Adapt node:sqlite to the store's minimal D1 surface (no new deps). */
function wrapSqlite(db: DatabaseSync): IdentityD1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          // The store binds string | number | null only; anything else is a
          // store bug the engine must reject, never silently coerce.
          const args = values.map((value) => {
            if (
              typeof value !== 'string' &&
              typeof value !== 'number' &&
              value !== null
            ) {
              throw new Error(`d1-test: unbindable value ${typeof value}`);
            }
            return value;
          });
          const stmt = db.prepare(sql);
          return {
            async first<T>(): Promise<T | null> {
              const row = stmt.get(...args) as T | undefined;
              return row ?? null;
            },
            async all<T>(): Promise<{ results: T[] }> {
              return { results: stmt.all(...args) as T[] };
            },
            async run(): Promise<unknown> {
              return stmt.run(...args);
            },
          };
        },
      };
    },
    async exec(sql: string): Promise<unknown> {
      db.exec(sql);
      return undefined;
    },
  };
}

async function setup() {
  const db = new DatabaseSync(':memory:');
  const d1 = wrapSqlite(db);
  await ensureIdentitySchema(d1);
  const clock = createFrozenClock(NOW);
  const store: IdentityStore = createD1IdentityStore(d1, { clock });
  return { db, d1, clock, store };
}

async function setupUserTeam(
  store: IdentityStore,
  opts: { email?: string; owner?: boolean } = {},
) {
  const user = await store.createUser({
    email: opts.email ?? 'd1@test.example',
    password_hash: 'test-hash-opaque',
    email_verified: true,
  });
  const team = await store.createTeam({});
  const membership = await store.createMembership({
    team_id: team.team_id,
    user_id: user.user_id,
    is_owner: opts.owner ?? true,
    roles: [],
  });
  return { user, team, membership };
}

test('ensureIdentitySchema is idempotent and creates every table', async () => {
  const { d1 } = await setup();
  await ensureIdentitySchema(d1);
  await ensureIdentitySchema(d1);
  const tables = await d1
    .prepare(
      "SELECT name AS name FROM sqlite_master WHERE type = 'table' AND name LIKE 'identity\\_%' ESCAPE '\\'",
    )
    .bind()
    .all<{ name: string }>();
  const names = tables.results.map((row) => row.name).sort();
  assert.deepEqual(names, [
    'identity_auth_codes',
    'identity_email_tokens',
    'identity_invitations',
    'identity_mcp_grants',
    'identity_memberships',
    'identity_oauth_clients',
    'identity_sessions',
    'identity_teams',
    'identity_users',
  ]);
});

test('users: create, case-insensitive lookup, password + verified updates', async () => {
  const { store } = await setup();
  const created = await store.createUser({
    email: 'Ada@Test.example',
    password_hash: 'hash-1',
    email_verified: false,
  });
  assert.equal(typeof created.user_id, 'string');
  assert.ok(created.user_id.length > 0);
  assert.equal(created.email, 'Ada@Test.example');

  const byEmail = await store.findUserByEmail('ada@test.example');
  assert.ok(byEmail !== null);
  assert.equal(byEmail.user_id, created.user_id);
  const byId = await store.findUserById(created.user_id);
  assert.ok(byId !== null);
  assert.equal(byId.email, 'Ada@Test.example');
  assert.equal(await store.findUserByEmail('nobody@test.example'), null);
  assert.equal(await store.findUserById('missing-user'), null);

  await store.setUserPassword(created.user_id, 'hash-2');
  assert.equal((await store.findUserById(created.user_id))?.password_hash, 'hash-2');
  await store.setUserEmailVerified(created.user_id, true);
  assert.equal((await store.findUserById(created.user_id))?.email_verified, true);

  // Missing rows are no-ops, never throws.
  await store.setUserPassword('missing-user', 'hash-3');
  await store.setUserEmailVerified('missing-user', true);
});

test('users: duplicate email fails loud (no silent second row)', async () => {
  const { store } = await setup();
  await store.createUser({
    email: 'dup@test.example',
    password_hash: 'hash-1',
    email_verified: false,
  });
  await assert.rejects(
    () =>
      store.createUser({
        email: 'DUP@test.example',
        password_hash: 'hash-2',
        email_verified: false,
      }),
    /UNIQUE|unique|duplicate/i,
  );
});

test('teams and memberships: full lifecycle', async () => {
  const { store } = await setup();
  const { user, team, membership } = await setupUserTeam(store);
  assert.equal((await store.findTeamById(team.team_id))?.team_id, team.team_id);
  assert.equal(await store.findTeamById('missing-team'), null);
  await store.setTeamTimezone(team.team_id, 'America/Chicago');
  assert.equal((await store.findTeamById(team.team_id))?.timezone, 'America/Chicago');

  assert.equal(
    (await store.findMembership(team.team_id, user.user_id))?.membership_id,
    membership.membership_id,
  );
  assert.equal(
    (await store.findMembershipById(membership.membership_id))?.status,
    'active',
  );
  assert.equal(await store.findMembership(team.team_id, 'missing-user'), null);

  const other = await store.createUser({
    email: 'other@test.example',
    password_hash: 'hash',
    email_verified: true,
  });
  await store.createMembership({
    team_id: team.team_id,
    user_id: other.user_id,
    is_owner: false,
    roles: [],
  });
  assert.equal((await store.listUserMemberships(other.user_id)).length, 1);
  assert.equal((await store.listActiveOwners(team.team_id)).length, 1);

  // Exactly one row per (team, user): concurrent re-admissions collide.
  await assert.rejects(
    () =>
      store.createMembership({
        team_id: team.team_id,
        user_id: user.user_id,
        is_owner: false,
        roles: [],
      }),
    /UNIQUE|unique|duplicate/i,
  );

  const otherMembership = await store.findMembership(team.team_id, other.user_id);
  assert.ok(otherMembership !== null);
  await store.setMembershipRoles(otherMembership.membership_id, [
    { role: 'TeamTasks.reviewer', granted_at: '2026-10-04T15:00:00.000Z', granted_by: user.user_id },
  ]);
  assert.deepEqual((await store.findMembershipById(otherMembership.membership_id))?.roles, [
    { role: 'TeamTasks.reviewer', granted_at: '2026-10-04T15:00:00.000Z', granted_by: user.user_id },
  ]);
  await store.setMembershipOwner(otherMembership.membership_id, true);
  assert.equal((await store.findMembershipById(otherMembership.membership_id))?.is_owner, true);

  await store.removeMembership(otherMembership.membership_id);
  assert.equal((await store.findMembershipById(otherMembership.membership_id))?.status, 'removed');
  // listUserMemberships keeps history (any status); owners list drops removed.
  assert.equal((await store.listUserMemberships(other.user_id)).length, 1);
  assert.equal((await store.listActiveOwners(team.team_id)).length, 1);

  await store.reactivateMembership(otherMembership.membership_id, {
    is_owner: false,
    roles: [],
  });
  const reactivated = await store.findMembershipById(otherMembership.membership_id);
  assert.equal(reactivated?.status, 'active');
  assert.equal(reactivated?.is_owner, false);
});

test('invitations: create, accept, revoke, pending-addressed revocation', async () => {
  const { store } = await setup();
  const { user, team } = await setupUserTeam(store);
  const first = await store.createInvitation({
    team_id: team.team_id,
    email: 'guest@test.example',
    grants_owner: false,
    grants_roles: ['TeamTasks.reviewer'],
    invited_by: user.user_id,
    expires_at: '2026-11-04T15:00:00.000Z',
  });
  const row = await store.findInvitationById(first.invitation_id);
  assert.ok(row !== null);
  assert.equal(row.email, 'guest@test.example');
  assert.deepEqual([...row.grants_roles], ['TeamTasks.reviewer']);
  assert.equal(row.accepted_at, null);
  assert.equal(await store.findInvitationById('missing-invitation'), null);

  await store.acceptInvitation(first.invitation_id);
  assert.ok((await store.findInvitationById(first.invitation_id))?.accepted_at !== null);

  const second = await store.createInvitation({
    team_id: team.team_id,
    email: 'GUEST@test.example',
    grants_owner: false,
    grants_roles: [],
    invited_by: user.user_id,
    expires_at: '2026-11-04T15:00:00.000Z',
  });
  // Accepted invitations are not pending: only the second revokes.
  await store.revokePendingTeamInvitationsForEmail(team.team_id, 'guest@test.example');
  assert.equal(
    (await store.findInvitationById(first.invitation_id))?.revoked_at,
    null,
  );
  assert.ok((await store.findInvitationById(second.invitation_id))?.revoked_at !== null);

  await store.revokeInvitation(first.invitation_id);
  assert.ok((await store.findInvitationById(first.invitation_id))?.revoked_at !== null);
});

test('sessions: create, lookup, team switch, revocation', async () => {
  const { store } = await setup();
  const { user, team } = await setupUserTeam(store);
  const session = await store.createSession({
    user_id: user.user_id,
    token_sha256: 'session-hash-1',
    expires_at: '2026-11-04T15:00:00.000Z',
    last_team_id: team.team_id,
  });
  assert.equal((await store.findSessionByTokenHash('session-hash-1'))?.session_id, session.session_id);
  assert.equal(session.last_team_id, team.team_id);
  assert.equal(await store.findSessionByTokenHash('missing-hash'), null);

  await store.setSessionTeam(session.session_id, null);
  assert.equal((await store.findSessionByTokenHash('session-hash-1'))?.last_team_id, null);

  const other = await store.createSession({
    user_id: user.user_id,
    token_sha256: 'session-hash-2',
    expires_at: '2026-11-04T15:00:00.000Z',
    last_team_id: null,
  });
  await store.revokeSession(session.session_id);
  assert.ok((await store.findSessionByTokenHash('session-hash-1'))?.revoked_at !== null);
  assert.equal((await store.findSessionByTokenHash('session-hash-2'))?.revoked_at, null);
  await store.revokeUserSessions(user.user_id);
  assert.ok((await store.findSessionByTokenHash('session-hash-2'))?.revoked_at !== null);
  // Revoking twice keeps the first revoked_at (memory parity).
  const firstRevoked = (await store.findSessionByTokenHash('session-hash-1'))?.revoked_at;
  await store.revokeSession(session.session_id);
  assert.equal((await store.findSessionByTokenHash('session-hash-1'))?.revoked_at, firstRevoked);
  assert.ok(other.session_id.length > 0);
});

test('email tokens: create, lookup, idempotent consume, purpose-scoped revocation', async () => {
  const { store } = await setup();
  const { user } = await setupUserTeam(store);
  const { token_id } = await store.createEmailToken({
    user_id: user.user_id,
    purpose: 'verify_email',
    token_sha256: 'email-hash-1',
    expires_at: '2026-10-05T15:00:00.000Z',
  });
  assert.equal((await store.findEmailTokenByHash('email-hash-1'))?.token_id, token_id);
  assert.equal(await store.findEmailTokenByHash('missing-hash'), null);

  await store.consumeEmailToken(token_id);
  const consumed = (await store.findEmailTokenByHash('email-hash-1'))?.consumed_at;
  assert.ok(consumed !== null);
  await store.consumeEmailToken(token_id);
  assert.equal((await store.findEmailTokenByHash('email-hash-1'))?.consumed_at, consumed);

  const recovery = await store.createEmailToken({
    user_id: user.user_id,
    purpose: 'recover_account',
    token_sha256: 'email-hash-2',
    expires_at: '2026-10-05T15:00:00.000Z',
  });
  await store.revokeUserEmailTokens(user.user_id, 'recover_account');
  assert.ok(
    (await store.findEmailTokenByHash('email-hash-2'))?.consumed_at !== null,
  );
  assert.ok(recovery.token_id.length > 0);
});

test('mcp grants: create, lookup, revoke, user/team revocation', async () => {
  const { store } = await setup();
  const { user, team } = await setupUserTeam(store);
  const grant = await store.createMcpGrant({
    user_id: user.user_id,
    team_id: team.team_id,
    client_id: 'test-client',
    token_sha256: 'grant-hash-1',
    expires_at: '2026-11-04T15:00:00.000Z',
  });
  assert.equal(grant.client_id, 'test-client');
  assert.equal(grant.revoked_at, null);
  assert.equal((await store.findMcpGrantByTokenHash('grant-hash-1'))?.grant_id, grant.grant_id);
  assert.equal(await store.findMcpGrantByTokenHash('missing-hash'), null);

  await store.revokeMcpGrant(grant.grant_id);
  const revoked = (await store.findMcpGrantByTokenHash('grant-hash-1'))?.revoked_at;
  assert.ok(revoked !== null);
  await store.revokeMcpGrant(grant.grant_id);
  assert.equal((await store.findMcpGrantByTokenHash('grant-hash-1'))?.revoked_at, revoked);

  const team2 = await store.createTeam({});
  const grant2 = await store.createMcpGrant({
    user_id: user.user_id,
    team_id: team2.team_id,
    client_id: 'test-client',
    token_sha256: 'grant-hash-2',
    expires_at: '2026-11-04T15:00:00.000Z',
  });
  await store.revokeUserTeamMcpGrants(user.user_id, team.team_id);
  assert.equal((await store.findMcpGrantByTokenHash('grant-hash-2'))?.revoked_at, null);
  await store.revokeUserMcpGrants(user.user_id);
  assert.ok((await store.findMcpGrantByTokenHash('grant-hash-2'))?.revoked_at !== null);
  assert.ok(grant2.grant_id.length > 0);
});

test('oauth clients and auth codes: register, lookup, idempotent consume', async () => {
  const { store } = await setup();
  const { user, team } = await setupUserTeam(store);
  const client = await store.createOAuthClient({
    client_name: 'test-mcp-host',
    redirect_uris: ['https://host.invalid/callback'],
  });
  assert.ok(client.client_id.startsWith('client_'));
  const found = await store.findOAuthClient(client.client_id);
  assert.ok(found !== null);
  assert.deepEqual([...found.redirect_uris], ['https://host.invalid/callback']);
  assert.equal(await store.findOAuthClient('client_missing'), null);

  const code = await store.createAuthCode({
    client_id: client.client_id,
    user_id: user.user_id,
    team_id: team.team_id,
    redirect_uri: 'https://host.invalid/callback',
    code_challenge: 'challenge-opaque',
    code_sha256: 'code-hash-1',
    expires_at: '2026-10-04T15:10:00.000Z',
  });
  assert.equal((await store.findAuthCodeByHash('code-hash-1'))?.code_challenge, code.code_challenge);
  assert.equal(await store.findAuthCodeByHash('missing-hash'), null);
  await store.consumeAuthCode('code-hash-1');
  const consumed = (await store.findAuthCodeByHash('code-hash-1'))?.consumed_at;
  assert.ok(consumed !== null);
  await store.consumeAuthCode('code-hash-1');
  assert.equal((await store.findAuthCodeByHash('code-hash-1'))?.consumed_at, consumed);
});

test('grant round-trip: real issue + mcp-grant resolve, revoke and expiry deny', async () => {
  const { store, clock } = await setup();
  const { user, team, membership } = await setupUserTeam(store);
  const issued = await issueMcpGrant(
    store,
    { user_id: user.user_id, team_id: team.team_id, client_id: 'prod-client' },
    { clock },
  );
  assert.ok(issued.token.length > 0);

  const resolved = await resolveIdentity(store, { mcp_grant_token: issued.token }, { clock });
  assert.equal(resolved.actor?.user_id, user.user_id);
  assert.equal(resolved.team?.team_id, team.team_id);
  assert.equal(resolved.membership?.membership_id, membership.membership_id);
  assert.equal(resolved.binding.kind, 'mcp_grant');

  // Unknown token: collapsed credential failure (never a distinct oracle).
  await assert.rejects(
    resolveIdentity(store, { mcp_grant_token: 'bogus-not-a-grant' }, { clock }),
    (err: unknown) => err instanceof IdentityError && err.code === 'forbidden',
  );

  await store.revokeMcpGrant(issued.grant.grant_id);
  await assert.rejects(
    resolveIdentity(store, { mcp_grant_token: issued.token }, { clock }),
    (err: unknown) => err instanceof IdentityError && err.code === 'forbidden',
  );

  const fresh = await issueMcpGrant(
    store,
    { user_id: user.user_id, team_id: team.team_id, client_id: 'prod-client' },
    { clock, ttlMs: 1000 },
  );
  clock.advance(2000);
  await assert.rejects(
    resolveIdentity(store, { mcp_grant_token: fresh.token }, { clock }),
    (err: unknown) => err instanceof IdentityError && err.code === 'forbidden',
  );

  // Removed membership ends grant admission immediately (collapsed, not an oracle).
  clock.advance(-2000);
  const member = await issueMcpGrant(
    store,
    { user_id: user.user_id, team_id: team.team_id, client_id: 'prod-client' },
    { clock },
  );
  await store.removeMembership(membership.membership_id);
  await assert.rejects(
    resolveIdentity(store, { mcp_grant_token: member.token }, { clock }),
    (err: unknown) => err instanceof IdentityError && err.code === 'forbidden',
  );
});

test('session round-trip: the grant route resolves cookie sessions from D1', async () => {
  const { store, clock } = await setup();
  const { user, team } = await setupUserTeam(store);
  const session = await store.createSession({
    user_id: user.user_id,
    token_sha256: 'route-session-hash',
    expires_at: '2026-11-04T15:00:00.000Z',
    last_team_id: team.team_id,
  });
  // resolveIdentity hashes the presented token; store the hash of the token
  // the route will present by round-tripping through the real hasher.
  const { sha256HexText } = await import('../src/sessions/tokens.js');
  const presented = 'route-session-token-opaque';
  await store.revokeSession(session.session_id);
  const live = await store.createSession({
    user_id: user.user_id,
    token_sha256: await sha256HexText(presented),
    expires_at: '2026-11-04T15:00:00.000Z',
    last_team_id: team.team_id,
  });
  const resolved = await resolveIdentity(store, { session_token: presented }, { clock });
  assert.equal(resolved.binding.kind, 'session');
  if (resolved.binding.kind === 'session') {
    assert.equal(resolved.binding.session_id, live.session_id);
  }
  assert.equal(resolved.actor?.user_id, user.user_id);
  assert.equal(resolved.team?.team_id, team.team_id);
  assert.equal(resolved.membership?.status, 'active');
});
