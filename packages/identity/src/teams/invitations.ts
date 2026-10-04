/**
 * Owner-managed team invitations (DESIGN section 4): expiring,
 * verified-email invitations whose acceptance cannot exceed the stored
 * grant ceiling.
 *
 * The invite link carries the invitation ID only — no secret token. The
 * invitee accepts through their own verified session, and acceptance
 * requires the session user's verified address to equal the addressed
 * email, which is exactly the DESIGN rule ("invitation acceptance verifies
 * the addressed email"). Role values are format-checked here
 * (`owner` or package-qualified `App.Role`); whether a declared role exists
 * in source stays with L1/L3, and equal names in different packages never
 * merge. Invitations expire after 7d (lane-06 authored).
 */
import {
  IdentityError,
  systemClock,
  toInstant,
} from '../ports.js';
import type { Clock, IdentityStore, MailPort } from '../ports.js';
import type { Membership } from '@canlang/contracts';
import { normalizeEmail } from '../accounts/registration.js';

export const INVITE_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;
export const ROLE_NAME_PATTERN = /^(owner|[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*)$/;

export function checkRoleName(role: string): void {
  if (!ROLE_NAME_PATTERN.test(role)) {
    throw new IdentityError('validation', 'Invalid role value.', 'role');
  }
}

export interface InviteOptions {
  readonly clock?: Clock;
  /** Absolute page URL under which `/teams/invites/<id>` renders (S4). */
  readonly inviteBaseUrl: string;
  readonly inviteExpiresMs?: number;
}

export async function inviteMember(
  store: IdentityStore,
  mail: MailPort,
  input: { team_id: string; email: string; role: string },
  opts: InviteOptions & { invited_by: string },
): Promise<{ invitation_id: string }> {
  const clock = opts.clock ?? systemClock;
  const team = await store.findTeamById(input.team_id);
  if (team === null) {
    throw new IdentityError('not_found', 'Team not found.');
  }
  const inviter = await store.findMembership(input.team_id, opts.invited_by);
  if (inviter === null || inviter.status !== 'active' || !inviter.is_owner) {
    throw new IdentityError('forbidden', 'Only team owners can invite members.');
  }
  const email = normalizeEmail(input.email);
  checkRoleName(input.role);
  const addressee = await store.findUserByEmail(email);
  if (addressee !== null) {
    const current = await store.findMembership(input.team_id, addressee.user_id);
    if (current !== null && current.status === 'active') {
      throw new IdentityError('conflict', 'Already a member of this team.');
    }
  }
  const { invitation_id } = await store.createInvitation({
    team_id: input.team_id,
    email,
    grants_owner: input.role === 'owner',
    grants_roles: input.role === 'owner' ? [] : [input.role],
    invited_by: opts.invited_by,
    expires_at: toInstant(clock.nowMs() + (opts.inviteExpiresMs ?? INVITE_EXPIRES_MS)),
  });
  await mail.sendMail(
    email,
    'You are invited to a team',
    `Sign in with this email address to accept the invitation:\n${opts.inviteBaseUrl}/teams/invites/${invitation_id}\nThis invitation expires in 7 days.`,
  );
  return { invitation_id };
}

export async function acceptInvitation(
  store: IdentityStore,
  input: { invitation_id: string; user_id: string },
  opts: { clock?: Clock } = {},
): Promise<Membership> {
  const clock = opts.clock ?? systemClock;
  const invitation = await store.findInvitationById(input.invitation_id);
  if (invitation === null) {
    throw new IdentityError('not_found', 'Invitation not found.');
  }
  const now = toInstant(clock.nowMs());
  if (
    invitation.revoked_at !== null ||
    invitation.accepted_at !== null ||
    invitation.expires_at <= now
  ) {
    throw new IdentityError('validation', 'This invitation is no longer valid.');
  }
  const user = await store.findUserById(input.user_id);
  if (
    user === null ||
    !user.email_verified ||
    user.email.toLowerCase() !== invitation.email.toLowerCase()
  ) {
    throw new IdentityError(
      'forbidden',
      'Sign in with the invited email address to accept.',
    );
  }
  const existing = await store.findMembership(invitation.team_id, input.user_id);
  if (existing !== null && existing.status === 'active') {
    throw new IdentityError('conflict', 'Already a member of this team.');
  }
  const grants = invitation.grants_roles.map((role) => ({
    role,
    granted_at: now,
    granted_by: invitation.invited_by,
  }));
  let membership: Membership;
  if (existing !== null) {
    // Re-admission reactivates the one (team, user) row with the fresh
    // ceiling; it never inserts a second row.
    await store.reactivateMembership(existing.membership_id, {
      is_owner: invitation.grants_owner,
      roles: grants,
    });
    const reactivated = await store.findMembershipById(existing.membership_id);
    if (reactivated === null) {
      throw new IdentityError('not_found', 'Membership not found.');
    }
    membership = reactivated;
  } else {
    membership = await store.createMembership({
      team_id: invitation.team_id,
      user_id: input.user_id,
      is_owner: invitation.grants_owner,
      roles: grants,
    });
  }
  await store.acceptInvitation(input.invitation_id);
  return membership;
}
