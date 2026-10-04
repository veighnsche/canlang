/**
 * Owner-assigned team role lifecycle behind the fixed
 * `system.team.role(member, role)` tool schema (DESIGN section 10).
 *
 * The schema fixes `{member, role}` but no grant/revoke expression, so this
 * lane authors a minimal value grammar, pending L3 acknowledgment: `role`
 * grants, `-role` revokes. `owner` / `-owner` promote and demote, guarded
 * by the last-owner rule; qualified `App.Role` values add or drop one
 * package-qualified assignment idempotently. A team owner never implicitly
 * holds declared roles, and revoking a role never rewrites history: stored
 * historical references are unaffected (DESIGN section 4).
 */
import {
  IdentityError,
  systemClock,
  toInstant,
} from '../ports.js';
import type { Clock, IdentityStore } from '../ports.js';
import type { Membership, RoleGrant } from '@canlang/contracts';
import { checkRoleName } from './invitations.js';

export interface ParsedRoleValue {
  readonly action: 'grant' | 'revoke';
  readonly role: string;
}

export function parseRoleValue(value: string): ParsedRoleValue {
  const action = value.startsWith('-') ? 'revoke' : 'grant';
  const role = action === 'revoke' ? value.slice(1) : value;
  checkRoleName(role);
  return { action, role };
}

export async function setMemberRole(
  store: IdentityStore,
  input: { team_id: string; member_user_id: string; role: string },
  opts: { granted_by: string; clock?: Clock },
): Promise<Membership> {
  const clock = opts.clock ?? systemClock;
  const granter = await store.findMembership(input.team_id, opts.granted_by);
  if (granter === null || granter.status !== 'active' || !granter.is_owner) {
    throw new IdentityError('forbidden', 'Only team owners can change roles.');
  }
  const target = await store.findMembership(input.team_id, input.member_user_id);
  if (target === null || target.status !== 'active') {
    throw new IdentityError('not_found', 'Membership not found.');
  }
  const { action, role } = parseRoleValue(input.role);
  const now = toInstant(clock.nowMs());

  if (role === 'owner') {
    if (action === 'grant') {
      await store.setMembershipOwner(target.membership_id, true);
    } else {
      const owners = await store.listActiveOwners(input.team_id);
      if (owners.length <= 1 && target.is_owner) {
        throw new IdentityError('forbidden', 'A team must keep at least one owner.');
      }
      await store.setMembershipOwner(target.membership_id, false);
    }
  } else if (action === 'grant') {
    if (!target.roles.some((grant) => grant.role === role)) {
      const grant: RoleGrant = { role, granted_at: now, granted_by: opts.granted_by };
      await store.setMembershipRoles(target.membership_id, [...target.roles, grant]);
    }
  } else {
    await store.setMembershipRoles(
      target.membership_id,
      target.roles.filter((grant) => grant.role !== role),
    );
  }
  const updated = await store.findMembershipById(target.membership_id);
  if (updated === null) {
    throw new IdentityError('not_found', 'Membership not found.');
  }
  return updated;
}
