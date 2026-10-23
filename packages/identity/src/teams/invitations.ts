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
import type { Clock, IdentityStore, MailPort, InvitationMutationInput, InvitationMailState } from '../ports.js';
import type { Membership } from '@canlang/contracts';
import { normalizeEmail } from '../accounts/registration.js';

export const INVITE_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;
// Can NAME in each segment; the end assertion also rejects a final newline.
export const ROLE_NAME_PATTERN = /^(?:owner|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)(?![\s\S])/;

export function checkRoleName(role: string): void {
  if (!ROLE_NAME_PATTERN.test(role)) {
    throw new IdentityError('validation', 'Invalid role value.', 'role');
  }
}

export interface InviteOptions {
  readonly clock?: Clock;
  /** Absolute deployment origin or invitation page URL (S4). */
  readonly inviteBaseUrl: string;
  readonly inviteExpiresMs?: number;
}

/** One original message for legacy sends and durable Identity intents. */
export function buildInvitationMail(
  invitation: { readonly invitation_id: string; readonly email: string; readonly expires_at: string },
  inviteBaseUrl: string,
): { to: string; subject: string; body_text: string } {
  const base = new URL(inviteBaseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username !== '' || base.password !== '' ||
      !Number.isFinite(Date.parse(invitation.expires_at))) {
    throw new IdentityError('validation', 'Invalid invitation mail configuration.');
  }
  const url = new URL('/auth/invite', base);
  url.searchParams.set('invitation_id', invitation.invitation_id);
  return { to: invitation.email, subject: 'You are invited to a team',
    body_text: `Sign in with this email address to accept the invitation:\n${url.href}\nThis invitation expires at ${invitation.expires_at}.` };
}

/** Original invitation publication plus at most one local mail attempt.
 * A void MailPort cannot reconcile a provider or prove non-delivery. Unknown
 * therefore remains unknown across retries; only an unclaimed pending intent
 * can be resumed. Current transport authority and app scope remain host-owned. */
export async function inviteMemberWithReceipt(
  store: IdentityStore,
  mail: MailPort,
  input: InvitationMutationInput,
  opts: { readonly inviteBaseUrl: string },
): Promise<{ invitation_id: string; mail: InvitationMailState }> {
  const create = store.createInvitationWithReceipt, claim = store.claimInvitationMail;
  const acknowledge = store.acknowledgeInvitationMail, read = store.readInvitationMailState;
  if (typeof create !== 'function' || typeof claim !== 'function' ||
      typeof acknowledge !== 'function' || typeof read !== 'function' || typeof mail?.sendMail !== 'function') {
    throw new Error('Durable invitation mail is not configured.');
  }
  const send = mail.sendMail.bind(mail);
  const receipt = await create.call(store, input, { inviteBaseUrl: opts.inviteBaseUrl });
  // Reconstruct subsequent requests from the captured original receipt, never
  // a caller object which may have changed while publication was awaited.
  const original: InvitationMutationInput = Object.freeze({ namespace: receipt.namespace, operationId: receipt.operationId,
    team_id: receipt.invitation.team_id, email: receipt.invitation.email,
    role: receipt.invitation.grants_owner ? 'owner' : receipt.invitation.grants_roles[0]!,
    invited_by: receipt.invitation.invited_by });
  const result = (state: InvitationMailState) => ({ invitation_id: receipt.invitation.invitation_id, mail: state });
  const observe = async (): Promise<InvitationMailState> => {
    try { return await read.call(store, original) ?? 'unknown'; }
    catch { return 'unknown'; }
  };
  let delivery;
  try { delivery = await claim.call(store, original); }
  catch { return result(await observe()); }
  if (delivery.attempt === undefined) return result(delivery.state);
  try {
    // A richer provider completion must be interpreted by its adapter, not
    // erased into this void port. Unexpected returned data is not an ack.
    const acknowledged = await send(delivery.attempt.to, delivery.attempt.subject, delivery.attempt.body_text);
    if (acknowledged !== undefined) return result('unknown');
  } catch { return result('unknown'); }
  try { return result(await acknowledge.call(store, original, delivery.attempt.token)); }
  catch { return result(await observe()); }
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
  const expires_at = toInstant(clock.nowMs() + (opts.inviteExpiresMs ?? INVITE_EXPIRES_MS));
  const { invitation_id } = await store.createInvitation({
    team_id: input.team_id,
    email,
    grants_owner: input.role === 'owner',
    grants_roles: input.role === 'owner' ? [] : [input.role],
    invited_by: opts.invited_by,
    expires_at,
  });
  const message = buildInvitationMail({ invitation_id, email, expires_at }, opts.inviteBaseUrl);
  await mail.sendMail(message.to, message.subject, message.body_text);
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
  if (typeof store.acceptInvitationWithMembership !== 'function') {
    throw new Error('Atomic invitation acceptance is unavailable.');
  }
  const membership = await store.acceptInvitationWithMembership({
    invitation_id: input.invitation_id, user_id: input.user_id,
  });
  if (membership === null) {
    throw new IdentityError('validation', 'This invitation is no longer valid.');
  }
  return membership;
}
