/**
 * Identity contract conformance (S1/B0): the two-user/team and revoked-session
 * fixtures satisfy the identity.ts shapes and their documented lifecycle
 * invariants. Runtime assertions here check fixture content only; admission
 * behavior lands with the S2 implementation.
 *
 * NOTE: relative contract import is temporary until L7 join J1 assembles
 * @canlang/contracts; then this becomes a workspace package import.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  IDENTITY_CONTRACT_VERSION,
  SYSTEM_TEAM_TOOL_NAMES,
} from '../../contracts/src/identity.js';
import type {
  AuthenticatedActor,
  Membership,
  Session,
  Team,
  TeamInvitation,
} from '../../contracts/src/identity.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

interface ActorRow {
  user_id: string;
  email: string;
  email_verified: boolean;
}

test('contract version is pinned', () => {
  assert.equal(IDENTITY_CONTRACT_VERSION, 1);
});

test('system team tool names are fixed', () => {
  assert.deepEqual([...SYSTEM_TEAM_TOOL_NAMES], [
    'system.team.invite',
    'system.team.remove',
    'system.team.role',
  ]);
});

test('two-user/team fixture satisfies identity shapes', () => {
  const data = fixture('two-user-team.json') as {
    users: ActorRow[];
    team: Team;
    memberships: Membership[];
    invitations: TeamInvitation[];
    sessions: Session[];
  };

  // Compile-time conformance: annotate through the contract types.
  const actors: AuthenticatedActor[] = data.users;
  const team: Team = data.team;
  assert.equal(actors.length, 2);
  assert.equal(team.timezone, 'UTC');

  const [alice, bob] = data.memberships;
  assert.ok(alice && bob);
  // Owner holds no automatic declared roles; member holds the granted one.
  assert.equal(alice.is_owner, true);
  assert.deepEqual(alice.roles, []);
  assert.equal(bob.is_owner, false);
  assert.equal(bob.roles.length, 1);
  assert.equal(bob.roles[0]?.role, 'TeamTasks.reviewer');
  // Package qualification is preserved, not merged to a bare name.
  assert.ok((bob.roles[0]?.role ?? '').includes('.'));

  // Invitation acceptance honored the stored grant ceiling and addressed email.
  const invite = data.invitations[0];
  assert.ok(invite);
  assert.equal(invite.email, 'bob@example.com');
  assert.equal(invite.grants_owner, false);
  assert.deepEqual(invite.grants_roles, ['TeamTasks.reviewer']);
  assert.ok(invite.accepted_at !== null && invite.accepted_at < invite.expires_at);
  assert.equal(invite.revoked_at, null);

  // Both sessions are live: unexpired and unrevoked.
  for (const session of data.sessions) {
    assert.equal(session.revoked_at, null);
    assert.ok(session.created_at < session.expires_at);
    assert.equal(session.last_team_id, team.team_id);
    assert.match(session.token_sha256, /^[0-9a-f]{64}$/);
  }
});

test('revoked-session fixture marks the session terminal', () => {
  const data = fixture('revoked-session.json') as {
    sessions: Session[];
    expect: { session_id: string; admission: string; reason: string };
  };
  const session = data.sessions[0];
  assert.ok(session);
  assert.equal(session.session_id, data.expect.session_id);
  assert.equal(data.expect.admission, 'rejected');
  // Revocation precedes expiry: still-valid lifetime must not admit.
  assert.ok(session.revoked_at !== null);
  assert.ok(session.created_at < (session.revoked_at as string));
  assert.ok((session.revoked_at as string) < session.expires_at);
});
