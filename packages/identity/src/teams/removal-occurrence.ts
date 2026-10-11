/** Private original removal capture shared by the owning storage implementations. */
import type { IdentityStore } from '../ports.js';
import { IdentityError } from '../ports.js';
import type { VerifiedTeamsMemberRemovedEnvelope } from '@canlang/contracts';
import { sha256HexText } from '../sessions/tokens.js';

export type RemovalInput = Parameters<NonNullable<IdentityStore['removeMemberWithOccurrence']>>[0];
const fields = ['team_id', 'member_user_id', 'removed_by', 'namespace', 'operationId'] as const;

export async function captureRemoval(input: RemovalInput): Promise<{ input: RemovalInput; digest: string }> {
  if (typeof input !== 'object' || input === null || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).length !== fields.length) throw new IdentityError('validation', 'Invalid membership removal occurrence.');
  const captured: Record<string, string> = {};
  for (const name of fields) {
    const property = Object.getOwnPropertyDescriptor(input, name);
    if (property === undefined || !('value' in property) || !property.enumerable ||
        typeof property.value !== 'string' || property.value === '') throw new IdentityError('validation', 'Invalid membership removal occurrence.');
    captured[name] = property.value;
  }
  const value = Object.freeze(captured) as unknown as RemovalInput;
  return { input: value, digest: await sha256HexText(JSON.stringify(value)) };
}

export interface RemovalRow {
  namespace: string; operation_id: string; request_digest: string; event_id: string;
  team_id: string; membership_id: string; user_id: string; removed_by: string; occurred_at: string;
}

export function removalEnvelope(row: RemovalRow, input: RemovalInput, digest: string): VerifiedTeamsMemberRemovedEnvelope {
  if (row.namespace !== input.namespace || row.operation_id !== input.operationId || row.request_digest !== digest ||
      row.team_id !== input.team_id || row.user_id !== input.member_user_id || row.removed_by !== input.removed_by) {
    throw new IdentityError('conflict', 'Membership removal occurrence differs from its original request.');
  }
  if ([row.event_id, row.membership_id, row.occurred_at].some(value => typeof value !== 'string' || value === '') ||
      !Number.isFinite(Date.parse(row.occurred_at))) throw new Error('Invalid stored membership removal occurrence.');
  return Object.freeze({ namespace: row.namespace, producerEventId: row.event_id, requestDigest: row.request_digest,
    operationKind: 'teams.member_removed', deliveryId: null,
    membershipRemoval: Object.freeze({ team_id: row.team_id, membership_id: row.membership_id,
      user: Object.freeze({ kind: 'user', id: row.user_id }) }),
    removedBy: Object.freeze({ kind: 'user', id: row.removed_by }), operationId: row.operation_id, occurredAt: row.occurred_at });
}
