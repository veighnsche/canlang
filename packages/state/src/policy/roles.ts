/**
 * Lane 03 S3: caller/team role predicates for operation admission.
 *
 * Evaluates `by` actor predicates against current admission authorization
 * state (DESIGN §4). A team owner never implicitly holds declared roles;
 * subject-form checks require an active membership with the explicit
 * package-qualified grant. Resolver failures propagate to the caller and are
 * never coerced to false.
 */

import type { Membership } from '@canlang/contracts';

/**
 * Structural subset of the L6 IdentityStore consumed by admission. The L6
 * store satisfies this interface structurally; this package never imports
 * the L6 implementation.
 */
export interface MembershipReader {
  findMembership(teamId: string, userId: string): Promise<Membership | null>;
}

/** Actor predicate AST: built-ins, declared roles, subject form, combinators. */
export type ByPredicate =
  | 'members'
  | 'owner'
  | 'authenticated'
  | 'public'
  | { role: string }
  | { roleSubject: { role: string; person: string } }
  | { and: ByPredicate[] }
  | { or: ByPredicate[] }
  | { not: ByPredicate };

/**
 * Test one role for the caller (no `person`) or for an explicit subject.
 * `role` is a package-qualified declared role or the `owner`/`members`
 * built-ins. Declared roles always require an explicit grant, even for
 * owners. No team, unauthenticated caller, or missing/inactive membership
 * yields false.
 */
export async function hasRole(
  ctx: { actorUserId: string | null; teamId: string | null; memberships: MembershipReader },
  role: string,
  person?: string,
): Promise<boolean> {
  if (ctx.teamId === null) return false;
  const userId = person ?? ctx.actorUserId;
  if (userId === null) return false;
  const membership = await ctx.memberships.findMembership(ctx.teamId, userId);
  if (membership === null || membership.status !== 'active') return false;
  if (role === 'owner') return membership.is_owner;
  if (role === 'members') return true;
  return membership.roles.some((grant) => grant.role === role);
}

/**
 * Evaluate a `by` predicate. `membership` is the caller's membership in the
 * resolved team (null when there is no actor, no team, or no membership);
 * declared-role checks re-resolve through `memberships` so subject and
 * caller forms observe the same current admission state.
 */
export async function evaluateBy(
  by: ByPredicate,
  ctx: {
    actorUserId: string | null;
    teamId: string | null;
    membership: Membership | null;
    memberships: MembershipReader;
  },
): Promise<boolean> {
  if (by === 'public') return true;
  if (by === 'authenticated') return ctx.actorUserId !== null;
  if (by === 'members' || by === 'owner') {
    if (ctx.actorUserId === null || ctx.teamId === null || ctx.membership === null) return false;
    if (ctx.membership.team_id !== ctx.teamId || ctx.membership.status !== 'active') return false;
    return by === 'members' || ctx.membership.is_owner;
  }
  if ('and' in by) {
    for (const term of by.and) {
      if (!(await evaluateBy(term, ctx))) return false;
    }
    return true;
  }
  if ('or' in by) {
    for (const term of by.or) {
      if (await evaluateBy(term, ctx)) return true;
    }
    return false;
  }
  if ('not' in by) return !(await evaluateBy(by.not, ctx));
  if ('role' in by) {
    return hasRole(
      { actorUserId: ctx.actorUserId, teamId: ctx.teamId, memberships: ctx.memberships },
      by.role,
    );
  }
  return hasRole(
    { actorUserId: ctx.actorUserId, teamId: ctx.teamId, memberships: ctx.memberships },
    by.roleSubject.role,
    by.roleSubject.person,
  );
}

/**
 * B4-authority: whether a `by` predicate can authorize ONLY through the
 * caller's own live membership row. The commit-time explicit revocation
 * check ("actor+team present but no live active membership → void") is
 * valid solely for such gates; every other gate admits callers whose
 * authority never flowed from their membership row, so a missing or
 * removed caller row must not void the commit — the live `evaluateBy`
 * re-check still guards genuinely lost permission for every gate.
 *
 * Necessity ("every satisfying assignment needs an active caller
 * membership"): `members`/`owner`/`{role}` need the caller's row;
 * `public`/`authenticated` need nobody's row (`authenticated` needs the
 * actor alone); `{roleSubject}` needs the SUBJECT's row, never the
 * caller's; `{and}` needs it when ANY term does; `{or}` only when EVERY
 * term does; `{not}` never (a negation is satisfiable without caller
 * membership — `not: 'members'` admits exactly the membership-less).
 */
export function byRequiresCallerMembership(by: ByPredicate): boolean {
  if (by === 'members' || by === 'owner') return true;
  if (by === 'public' || by === 'authenticated') return false;
  if ('and' in by) return by.and.some(byRequiresCallerMembership);
  if ('or' in by) return by.or.every(byRequiresCallerMembership);
  if ('not' in by) return false;
  if ('role' in by) return true;
  return false; // `{ roleSubject }`: the subject's row, not the caller's.
}

/** Built-in `by` predicate names. */
const BY_BUILTINS: ReadonlySet<string> = new Set([
  'members',
  'owner',
  'authenticated',
  'public',
]);

/**
 * Validate a `by` predicate shape, failing fast on programmer-built policies.
 * Throws plain `Error`: callers never supply `by` predicates directly.
 */
export function validateByPredicate(by: ByPredicate, what: string): void {
  if (typeof by === 'string') {
    if (!BY_BUILTINS.has(by)) {
      throw new Error(`Invalid ${what}: unknown by predicate ${JSON.stringify(by)}.`);
    }
    return;
  }
  if (typeof by !== 'object' || by === null || Array.isArray(by)) {
    throw new Error(`Invalid ${what}: by predicate must be a name or an object.`);
  }
  const keys = Object.keys(by);
  if (keys.length !== 1) {
    throw new Error(`Invalid ${what}: by predicate needs exactly one combinator.`);
  }
  const key = keys[0];
  if (key === 'role') {
    const role = (by as { role: unknown }).role;
    if (typeof role !== 'string' || role === '') {
      throw new Error(`Invalid ${what}: role needs a non-empty role name.`);
    }
    return;
  }
  if (key === 'roleSubject') {
    const subject = (by as { roleSubject: unknown }).roleSubject;
    if (typeof subject !== 'object' || subject === null || Array.isArray(subject)) {
      throw new Error(`Invalid ${what}: roleSubject needs { role, person }.`);
    }
    const { role, person } = subject as { role: unknown; person: unknown };
    if (typeof role !== 'string' || role === '' || typeof person !== 'string' || person === '') {
      throw new Error(`Invalid ${what}: roleSubject needs non-empty role and person.`);
    }
    return;
  }
  if (key === 'and' || key === 'or') {
    const terms = (by as { and?: unknown; or?: unknown })[key];
    if (!Array.isArray(terms) || terms.length === 0) {
      // Empty arrays are rejected (never vacuous): `and: []` would evaluate
      // to true and silently widen the grant to all callers (fail-open).
      throw new Error(`Invalid ${what}: ${key} needs a non-empty array of predicates.`);
    }
    for (const term of terms) {
      validateByPredicate(term as ByPredicate, what);
    }
    return;
  }
  if (key === 'not') {
    validateByPredicate((by as { not: ByPredicate }).not, what);
    return;
  }
  throw new Error(`Invalid ${what}: unknown by combinator ${JSON.stringify(key)}.`);
}
