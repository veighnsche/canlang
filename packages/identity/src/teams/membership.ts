/**
 * Membership removal (DESIGN section 4): owner-managed, last-owner guard,
 * terminal admission boundary.
 *
 * Removing the last owner is rejected. A completed removal prevents new
 * admissions (identity resolution only honors `active` memberships) while an
 * already admitted operation may finish. Removal additionally revokes the
 * member's team-bound MCP grants and pending invitations for their address
 * in that team (lane-06 authored cleanup; DESIGN pins the admission
 * boundary, not the cascade). Historic membership references stay readable
 * where record policies permit: the row keeps `status: 'removed'`, it is
 * never deleted.
 */
import { IdentityError } from '../ports.js';
import type { IdentityStore } from '../ports.js';

export async function removeMember(
  store: IdentityStore,
  input: { team_id: string; member_user_id: string },
  opts: { removed_by: string },
): Promise<{ removed: true }> {
  const remover = await store.findMembership(input.team_id, opts.removed_by);
  if (remover === null || remover.status !== 'active' || !remover.is_owner) {
    throw new IdentityError('forbidden', 'Only team owners can remove members.');
  }
  const target = await store.findMembership(input.team_id, input.member_user_id);
  if (target === null || target.status !== 'active') {
    throw new IdentityError('not_found', 'Membership not found.');
  }
  if (target.is_owner) {
    const owners = await store.listActiveOwners(input.team_id);
    if (owners.length <= 1) {
      throw new IdentityError('forbidden', 'A team must keep at least one owner.');
    }
  }
  await store.removeMembership(target.membership_id);
  await store.revokeUserTeamMcpGrants(input.member_user_id, input.team_id);
  const user = await store.findUserById(input.member_user_id);
  if (user !== null) {
    await store.revokePendingTeamInvitationsForEmail(input.team_id, user.email);
  }
  return { removed: true };
}
