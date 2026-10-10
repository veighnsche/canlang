/** Internal admission and detachment shared by the two Identity producers. */
import { MAX_MEMBERSHIP_SNAPSHOT_USERS } from '@canlang/contracts';
import type { Membership, MembershipSnapshot, TeamId, UserId } from '@canlang/contracts';

function invalid(): never {
  throw new Error('identity: invalid membership snapshot request or facts');
}

/** Read only own data properties; malformed facts cannot execute getters. */
export function snapshotData(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return invalid();
  return descriptor.value;
}

function text(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : invalid();
}

export function captureMembershipRequest(team_id: TeamId, user_ids: readonly UserId[]):
  { readonly team_id: TeamId; readonly user_ids: readonly UserId[] } {
  text(team_id);
  if (!Array.isArray(user_ids)) return invalid();
  const length = snapshotData(user_ids, 'length');
  if (typeof length !== 'number' || !Number.isInteger(length) ||
      length < 1 || length > MAX_MEMBERSHIP_SNAPSHOT_USERS) return invalid();
  const captured: UserId[] = [];
  for (let i = 0; i < length; i++) captured.push(text(snapshotData(user_ids, String(i))));
  return Object.freeze({ team_id, user_ids: Object.freeze(captured) });
}

function detachMembership(value: unknown, team_id: TeamId, user_id: UserId): Membership {
  if (snapshotData(value, 'team_id') !== team_id ||
      snapshotData(value, 'user_id') !== user_id) return invalid();
  const owner = snapshotData(value, 'is_owner');
  const status = snapshotData(value, 'status');
  if (typeof owner !== 'boolean' || (status !== 'active' && status !== 'removed')) return invalid();
  const roles = snapshotData(value, 'roles');
  if (!Array.isArray(roles)) return invalid();
  const detachedRoles: Membership['roles'][number][] = [];
  for (let i = 0; i < roles.length; i++) {
    const grant = snapshotData(roles, String(i));
    detachedRoles.push(Object.freeze({
      role: text(snapshotData(grant, 'role')),
      granted_at: text(snapshotData(grant, 'granted_at')),
      granted_by: text(snapshotData(grant, 'granted_by')),
    }));
  }
  return Object.freeze({
    membership_id: text(snapshotData(value, 'membership_id')),
    team_id, user_id, is_owner: owner, status,
    roles: Object.freeze(detachedRoles),
    created_at: text(snapshotData(value, 'created_at')),
    updated_at: text(snapshotData(value, 'updated_at')),
  });
}

export function finishMembershipSnapshot(
  request: { readonly team_id: TeamId; readonly user_ids: readonly UserId[] },
  memberships: readonly (Membership | null)[],
): MembershipSnapshot {
  if (memberships.length !== request.user_ids.length) return invalid();
  const entries = request.user_ids.map((user_id, i) => {
    const member = memberships[i];
    return Object.freeze({ user_id, membership: member === null ? null :
      detachMembership(member, request.team_id, user_id) });
  });
  return Object.freeze({ team_id: request.team_id, entries: Object.freeze(entries) });
}
