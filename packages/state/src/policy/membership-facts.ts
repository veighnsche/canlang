/** Complete detached Identity observations for row-selected grant evaluation. */
import { MAX_MEMBERSHIP_SNAPSHOT_USERS, type Membership, type MembershipSnapshot } from '@canlang/contracts';
import { StateError } from '../errors.js';
import type { ByContext } from './grants.js';

const refuse = (message: string): never => { throw new StateError('validation', message); };
const key = (team: string, user: string) => JSON.stringify([team, user]);
interface CopyBudget { nodes: number; readonly seen: Set<object>; }

function copyOwnEntry(
  part: object,
  name: string | symbol,
  out: Record<string, unknown> | unknown[],
  budget: CopyBudget,
  depth: number,
): void {
  if (Array.isArray(part) && name === 'length') return;
  const member = Object.getOwnPropertyDescriptor(part, name);
  if (typeof name !== 'string' || member === undefined || !('value' in member) || !member.enumerable ||
      Array.isArray(part) && !/^(0|[1-9]\d*)$/.test(name)) return refuse('Identity facts require own enumerable data.');
  Object.defineProperty(out, name, { value: visitCopy(member.value, depth + 1, budget), enumerable: true });
}

function visitCopy(part: unknown, depth: number, budget: CopyBudget): unknown {
  if (++budget.nodes > 20_000 || depth > 32) return refuse('Identity facts exceed their finite budget.');
  if (part === null || typeof part === 'string' || typeof part === 'boolean' || typeof part === 'number' && Number.isFinite(part)) return part;
  if (typeof part !== 'object' || part === null || budget.seen.has(part) ||
      ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(part))) return refuse('Identity facts require own JSON data.');
  budget.seen.add(part);
  const out: Record<string, unknown> | unknown[] = Array.isArray(part) ? [] : {};
  for (const name of Reflect.ownKeys(part)) {
    copyOwnEntry(part, name, out, budget, depth);
  }
  if (Array.isArray(part) && Object.keys(out).length !== part.length) return refuse('Identity arrays must preserve every position.');
  budget.seen.delete(part);
  return Object.freeze(out);
}

function copy(value: unknown): unknown {
  return visitCopy(value, 0, { nodes: 0, seen: new Set<object>() });
}
function object(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== names.length ||
      names.some(name => { const member = Object.getOwnPropertyDescriptor(value, name); return member === undefined || !('value' in member) || !member.enumerable; })) return refuse('Identity facts require a closed own data shape.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string { return typeof value === 'string' && value !== '' ? value : refuse('Identity fact requires a nonempty identity.'); }
export function checkedMembershipFact(value: unknown, team: string, person: string): Membership | null {
  if (value === null) return null;
  const row = object(copy(value), ['membership_id', 'team_id', 'user_id', 'is_owner', 'roles', 'status', 'created_at', 'updated_at']);
  text(row.membership_id); text(row.created_at); text(row.updated_at);
  if (row.team_id !== team || row.user_id !== person || typeof row.is_owner !== 'boolean' ||
      row.status !== 'active' && row.status !== 'removed') return refuse('Identity reader returned a foreign pair or unknown membership state.');
  if (!Array.isArray(row.roles)) return refuse('Identity roles must be an array.');
  const roles = row.roles.map(value => {
    const role = object(value, ['role', 'granted_at', 'granted_by']);
    return Object.freeze({ role: text(role.role), granted_at: text(role.granted_at), granted_by: text(role.granted_by) });
  });
  return Object.freeze({ membership_id: row.membership_id, team_id: team, user_id: person, is_owner: row.is_owner,
    roles: Object.freeze(roles), status: row.status, created_at: row.created_at, updated_at: row.updated_at }) as Membership;
}
export function checkedAuthoritySnapshot(value: MembershipSnapshot, team: string,
  users: readonly string[]): ReadonlyMap<string, Membership | null> {
  const snapshot = object(value, ['team_id', 'entries']);
  if (snapshot.team_id !== team) return refuse('Identity snapshot crossed its requested Team.');
  const entries = snapshot.entries;
  if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype || entries.length !== users.length ||
      Reflect.ownKeys(entries).length !== users.length + 1) return refuse('Identity snapshot must preserve every requested position.');
  const facts = new Map<string, Membership | null>();
  for (let index = 0; index < users.length; index++) {
    const member = Object.getOwnPropertyDescriptor(entries, String(index));
    if (member === undefined || !('value' in member) || !member.enumerable) return refuse('Identity snapshot entries require own data.');
    const entry = object(member.value, ['user_id', 'membership']);
    if (entry.user_id !== users[index]) return refuse('Identity snapshot user order or identity changed.');
    facts.set(key(team, users[index]!), checkedMembershipFact(entry.membership, team, users[index]!));
  }
  return facts;
}

/** Discovery cannot authorize a conjunction. Re-evaluate only the policy AST
 * against one complete snapshot before any caller predicate or disclosure. */
export async function observeRowGrantAuthority<T>(context: ByContext,
  evaluate: (context: ByContext) => Promise<T>, options: { readonly observeCaller?: boolean } = {}): Promise<{ readonly value: T; readonly revalidate: () => Promise<void> }> {
  const facts = new Map<string, { team: string; user: string; fact: Membership | null }>(); let drift = false;
  const record = (team: string, user: string, value: unknown) => {
    if (team !== context.teamId) return refuse('Row grant authority crossed its actual Team.');
    const fact = checkedMembershipFact(value, team, user), identity = key(team, user), previous = facts.get(identity);
    if (previous !== undefined && JSON.stringify(previous.fact) !== JSON.stringify(fact)) drift = true;
    if (previous === undefined) {
      if (facts.size >= MAX_MEMBERSHIP_SNAPSHOT_USERS) return refuse('Row grant authority exceeds its coherent subject budget.');
      facts.set(identity, { team, user, fact });
    }
    return fact;
  };
  const observeCaller = options.observeCaller !== false;
  const membership = observeCaller && context.actorUserId !== null && context.teamId !== null
    ? record(context.teamId, context.actorUserId, context.membership) : null;
  // Owner decisions carry the actual actor/team but no implicit caller grant.
  // Observe only subjects whose original active_member calls are reached.
  const discovery = await evaluate({ ...context, ...(observeCaller ? { membership } : {}), memberships: {
    findMembership: async (team, user) => record(team, user, await context.memberships.findMembership(team, user)),
  } });
  const changed = (): never => { throw new StateError('forbidden', 'Row grant authority changed during its complete observation.'); };
  if (drift) return changed();
  if (facts.size <= 1) return { value: discovery, revalidate: async () => {
    for (const { team, user, fact } of facts.values()) {
      if (JSON.stringify(checkedMembershipFact(await context.memberships.findMembership(team, user), team, user)) !== JSON.stringify(fact)) changed();
    }
  } };
  const method = Object.getOwnPropertyDescriptor(context.memberships, 'findMembershipsSnapshot');
  if (context.teamId === null || method === undefined || !('value' in method) || typeof method.value !== 'function') return changed();
  const users = Object.freeze([...facts.values()].map(fact => fact.user));
  const snapshot = async () => checkedAuthoritySnapshot(await method.value.call(context.memberships, context.teamId, users), context.teamId!, users);
  const observed = await snapshot();
  if ([...facts].some(([identity, fact]) => JSON.stringify(observed.get(identity)) !== JSON.stringify(fact.fact))) return changed();
  const value = await evaluate({ ...context,
    ...(observeCaller ? { membership: context.actorUserId === null ? null : observed.get(key(context.teamId, context.actorUserId))! } : {}),
    memberships: { findMembership: async (team, user) => {
      const identity = key(team, user); if (!observed.has(identity)) return changed(); return observed.get(identity)!;
    } },
  });
  if (JSON.stringify(value) !== JSON.stringify(discovery)) return changed();
  return { value, revalidate: async () => {
    const final = await snapshot();
    if (users.some(user => JSON.stringify(final.get(key(context.teamId!, user))) !== JSON.stringify(observed.get(key(context.teamId!, user))))) changed();
  } };
}
