/**
 * Team lifecycle behavior: invitations, acceptance, removal, roles, selection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityError } from '../src/ports.js';
import {
  createFrozenClock,
  createMemoryIdentityStore,
  createTestMailOutbox,
} from '../src/testing.js';
import { hashPassword } from '../src/accounts/passwords.js';
import { acceptInvitation, inviteMember } from '../src/teams/invitations.js';
import { removeMember } from '../src/teams/membership.js';
import { parseRoleValue, setMemberRole } from '../src/teams/roles.js';
import { clearTeamSelection, selectTeam } from '../src/teams/selection.js';
import { sha256HexText } from '../src/sessions/tokens.js';

const NOW = Date.parse('2026-10-04T15:00:00.000Z');

function setup() {
  const clock = createFrozenClock(NOW);
  const store = createMemoryIdentityStore({ clock });
  const mail = createTestMailOutbox();
  return { clock, store, mail };
}

async function ownerWithTeam() {
  const { clock, store, mail } = setup();
  const hash = await hashPassword('owner-password-1');
  const owner = await store.createUser({
    email: 'owner@x.co',
    password_hash: hash,
    email_verified: true,
  });
  const team = await store.createTeam({});
  await store.createMembership({
    team_id: team.team_id,
    user_id: owner.user_id,
    is_owner: true,
    roles: [],
  });
  return { clock, store, mail, owner, team };
}

async function assertIdentityError(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof IdentityError);
    assert.equal(error.code, code);
    return;
  }
  assert.fail('expected IdentityError');
}

test('owner invites and addressed member accepts with the stored ceiling', async () => {
  const { clock, store, mail, owner, team } = await ownerWithTeam();
  const bob = await store.createUser({
    email: 'bob@x.co',
    password_hash: await hashPassword('bob-password-1'),
    email_verified: true,
  });
  const { invitation_id } = await inviteMember(
    store,
    mail,
    { team_id: team.team_id, email: 'bob@x.co', role: 'TeamTasks.reviewer' },
    { invited_by: owner.user_id, clock, inviteBaseUrl: 'https://app.example.com' },
  );
  assert.equal(mail.messages.length, 1);
  assert.ok((mail.messages[0]?.body_text ?? '').includes(invitation_id));
  const membership = await acceptInvitation(store, { invitation_id, user_id: bob.user_id }, { clock });
  assert.equal(membership.is_owner, false);
  assert.deepEqual(membership.roles.map((grant) => grant.role), ['TeamTasks.reviewer']);
  assert.equal(membership.roles[0]?.granted_by, owner.user_id);
  await assertIdentityError(
    () => acceptInvitation(store, { invitation_id, user_id: bob.user_id }, { clock }),
    'validation',
  );
});

test('owner invitations grant ownership; non-owners cannot invite', async () => {
  const { clock, store, mail, owner, team } = await ownerWithTeam();
  const carol = await store.createUser({
    email: 'carol@x.co',
    password_hash: await hashPassword('carol-password-1'),
    email_verified: true,
  });
  const first = await inviteMember(
    store,
    mail,
    { team_id: team.team_id, email: 'carol@x.co', role: 'owner' },
    { invited_by: owner.user_id, clock, inviteBaseUrl: 'https://app.example.com' },
  );
  const membership = await acceptInvitation(
    store,
    { invitation_id: first.invitation_id, user_id: carol.user_id },
    { clock },
  );
  assert.equal(membership.is_owner, true);

  const dave = await store.createUser({
    email: 'dave@x.co',
    password_hash: await hashPassword('dave-password-1'),
    email_verified: true,
  });
  await store.createMembership({
    team_id: team.team_id,
    user_id: dave.user_id,
    is_owner: false,
    roles: [],
  });
  await assertIdentityError(
    () =>
      inviteMember(
        store,
        mail,
        { team_id: team.team_id, email: 'erin@x.co', role: 'owner' },
        { invited_by: dave.user_id, clock, inviteBaseUrl: 'https://app.example.com' },
      ),
    'forbidden',
  );
  await assertIdentityError(
    () =>
      inviteMember(
        store,
        mail,
        { team_id: team.team_id, email: 'erin@x.co', role: 'not a role' },
        { invited_by: owner.user_id, clock, inviteBaseUrl: 'https://app.example.com' },
      ),
    'validation',
  );
});

test('acceptance verifies the addressed email and invitation freshness', async () => {
  const { clock, store, mail, owner, team } = await ownerWithTeam();
  const bob = await store.createUser({
    email: 'bob@x.co',
    password_hash: await hashPassword('bob-password-1'),
    email_verified: false,
  });
  const mallory = await store.createUser({
    email: 'mallory@x.co',
    password_hash: await hashPassword('mallory-password-1'),
    email_verified: true,
  });
  const { invitation_id } = await inviteMember(
    store,
    mail,
    { team_id: team.team_id, email: 'bob@x.co', role: 'TeamTasks.reviewer' },
    { invited_by: owner.user_id, clock, inviteBaseUrl: 'https://app.example.com' },
  );
  // Wrong account, and unverified right account, both fail.
  await assertIdentityError(
    () => acceptInvitation(store, { invitation_id, user_id: mallory.user_id }, { clock }),
    'forbidden',
  );
  await assertIdentityError(
    () => acceptInvitation(store, { invitation_id, user_id: bob.user_id }, { clock }),
    'forbidden',
  );
  clock.advance(8 * 24 * 60 * 60 * 1000);
  await store.setUserEmailVerified(bob.user_id, true);
  await assertIdentityError(
    () => acceptInvitation(store, { invitation_id, user_id: bob.user_id }, { clock }),
    'validation',
  );
  await assertIdentityError(
    () => acceptInvitation(store, { invitation_id: 'missing', user_id: bob.user_id }, { clock }),
    'not_found',
  );
});

test('removal keeps the last owner and revokes team-bound grants', async () => {
  const { clock, store, owner, team } = await ownerWithTeam();
  const bob = await store.createUser({
    email: 'bob@x.co',
    password_hash: await hashPassword('bob-password-1'),
    email_verified: true,
  });
  await store.createMembership({
    team_id: team.team_id,
    user_id: bob.user_id,
    is_owner: false,
    roles: [],
  });
  const grant = await store.createMcpGrant({
    user_id: bob.user_id,
    team_id: team.team_id,
    client_id: 'chatbot',
    token_sha256: 'ab'.repeat(32),
    expires_at: '2026-11-04T15:00:00.000Z',
  });
  // Non-owner cannot remove; last owner cannot be removed.
  await assertIdentityError(
    () => removeMember(store, { team_id: team.team_id, member_user_id: owner.user_id }, { removed_by: bob.user_id }),
    'forbidden',
  );
  await assertIdentityError(
    () => removeMember(store, { team_id: team.team_id, member_user_id: owner.user_id }, { removed_by: owner.user_id }),
    'forbidden',
  );
  assert.deepEqual(
    await removeMember(store, { team_id: team.team_id, member_user_id: bob.user_id }, { removed_by: owner.user_id }),
    { removed: true },
  );
  const row = await store.findMembership(team.team_id, bob.user_id);
  assert.equal(row?.status, 'removed');
  const revoked = await store.findMcpGrantByTokenHash('ab'.repeat(32));
  assert.ok(revoked?.revoked_at !== null && revoked?.revoked_at !== undefined);
  assert.equal(revoked?.grant_id, grant.grant_id);
  assert.ok(clock.nowMs() > 0);
});

test('role grammar grants and revokes with the last-owner guard', async () => {
  assert.deepEqual(parseRoleValue('TeamTasks.reviewer'), { action: 'grant', role: 'TeamTasks.reviewer' });
  assert.deepEqual(parseRoleValue('-TeamTasks.reviewer'), { action: 'revoke', role: 'TeamTasks.reviewer' });
  assert.deepEqual(parseRoleValue('owner'), { action: 'grant', role: 'owner' });
  try {
    parseRoleValue('nope not a role');
    assert.fail('expected IdentityError');
  } catch (error) {
    assert.ok(error instanceof IdentityError);
    assert.equal(error.code, 'validation');
  }

  const { clock, store, owner, team } = await ownerWithTeam();
  const bob = await store.createUser({
    email: 'bob@x.co',
    password_hash: await hashPassword('bob-password-1'),
    email_verified: true,
  });
  await store.createMembership({
    team_id: team.team_id,
    user_id: bob.user_id,
    is_owner: false,
    roles: [],
  });
  const granted = await setMemberRole(
    store,
    { team_id: team.team_id, member_user_id: bob.user_id, role: 'TeamTasks.reviewer' },
    { granted_by: owner.user_id, clock },
  );
  assert.deepEqual(granted.roles.map((grant) => grant.role), ['TeamTasks.reviewer']);
  // Grant is idempotent; revoke drops the assignment.
  await setMemberRole(
    store,
    { team_id: team.team_id, member_user_id: bob.user_id, role: 'TeamTasks.reviewer' },
    { granted_by: owner.user_id, clock },
  );
  const revoked = await setMemberRole(
    store,
    { team_id: team.team_id, member_user_id: bob.user_id, role: '-TeamTasks.reviewer' },
    { granted_by: owner.user_id, clock },
  );
  assert.deepEqual(revoked.roles, []);
  // Demoting the last owner fails; promoting a second owner then demoting works.
  await assertIdentityError(
    () =>
      setMemberRole(
        store,
        { team_id: team.team_id, member_user_id: owner.user_id, role: '-owner' },
        { granted_by: owner.user_id, clock },
      ),
    'forbidden',
  );
  await setMemberRole(
    store,
    { team_id: team.team_id, member_user_id: bob.user_id, role: 'owner' },
    { granted_by: owner.user_id, clock },
  );
  const demoted = await setMemberRole(
    store,
    { team_id: team.team_id, member_user_id: owner.user_id, role: '-owner' },
    { granted_by: bob.user_id, clock },
  );
  assert.equal(demoted.is_owner, false);
});

test('team selection follows live membership', async () => {
  const { clock, store, owner, team } = await ownerWithTeam();
  const session = await store.createSession({
    user_id: owner.user_id,
    token_sha256: await sha256HexText('session-token'),
    expires_at: '2026-10-11T15:00:00.000Z',
    last_team_id: null,
  });
  assert.deepEqual(
    await selectTeam(store, { session_token_hash: session.token_sha256, team_id: team.team_id }, { clock }),
    { team_id: team.team_id },
  );
  assert.equal(
    (await store.findSessionByTokenHash(session.token_sha256))?.last_team_id,
    team.team_id,
  );
  assert.deepEqual(
    await clearTeamSelection(store, { session_token_hash: session.token_sha256 }, { clock }),
    { cleared: true },
  );
  const outsider = await store.createUser({
    email: 'outsider@x.co',
    password_hash: await hashPassword('outsider-password-1'),
    email_verified: true,
  });
  const foreign = await store.createSession({
    user_id: outsider.user_id,
    token_sha256: await sha256HexText('foreign-token'),
    expires_at: '2026-10-11T15:00:00.000Z',
    last_team_id: null,
  });
  await assertIdentityError(
    () => selectTeam(store, { session_token_hash: foreign.token_sha256, team_id: team.team_id }, { clock }),
    'forbidden',
  );
  await assertIdentityError(
    () => selectTeam(store, { session_token_hash: session.token_sha256, team_id: 'missing' }, { clock }),
    'not_found',
  );
});
