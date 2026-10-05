/**
 * B2 revocation-journey fixtures (L7): role vocabulary and structural
 * guards for the role/session revocation spec. Pure data helpers; the
 * spec drives the REAL L6 entry points (`setMemberRole`, `removeMember`,
 * `revokeSessionByToken`, `signOutEverywhere`) over L6's own memory
 * store, and every row detail names that double plus the unlanded
 * production binding (J2 fenced D1).
 *
 * Role grammar restated from the L6 authority
 * (`packages/identity/src/teams/invitations.ts` `ROLE_NAME_PATTERN`):
 * `owner`, or one package-qualified `App.Role` value. Anything else is
 * rejected with `validation` — the spec pins one such rejection.
 */

/** Declared roles on the B2 journey team (ExpenseFlow-flavored). */
export const B2_REVIEWER_ROLE = "Expense.Reviewer";
export const B2_APPROVER_ROLE = "Expense.Approver";

/** All declared roles the journey grants (owner is a flag, not a role). */
export const B2_JOURNEY_ROLES: readonly string[] = [B2_REVIEWER_ROLE, B2_APPROVER_ROLE];

/** Deterministic bearer tokens (raw values; only hashes are stored). */
export function b2BearerToken(rowIndex: number, slot: string): string {
  return `b2-revocation-row-${rowIndex}-${slot}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads an `IdentityError` structurally (L6 `ports.ts`): name + wire
 * business code. Throws otherwise, so a wrong failure mode can never
 * satisfy an expected rejection.
 */
export function readB2IdentityError(error: unknown, what: string): { code: string } {
  if (!isRecord(error) || error["name"] !== "IdentityError") {
    const name = isRecord(error) ? String(error["name"] ?? typeof error) : String(error);
    throw new Error(`${what}: expected IdentityError, got ${name}`);
  }
  if (typeof error["code"] !== "string" || error["code"] === "") {
    throw new Error(`${what}: IdentityError carries no wire code`);
  }
  return { code: error["code"] };
}

/**
 * Reads the revoked marker off a session/grant row: `revoked_at` is
 * null while active and an instant string once revoked. Throws when
 * the row shape drifts.
 */
export function readB2RevokedAt(row: unknown, what: string): string | null {
  if (!isRecord(row) || (typeof row["revoked_at"] !== "string" && row["revoked_at"] !== null)) {
    throw new Error(`${what}: session/grant row carries no revoked_at marker`);
  }
  return row["revoked_at"];
}

/** Role names held by one membership row (structural `RoleGrant[]` read). */
export function readB2MemberRoles(membership: unknown, what: string): readonly string[] {
  if (!isRecord(membership) || !Array.isArray(membership["roles"])) {
    throw new Error(`${what}: membership row carries no roles array`);
  }
  return (membership["roles"] as unknown[]).map((grant: unknown, index: number): string => {
    if (!isRecord(grant) || typeof grant["role"] !== "string") {
      throw new Error(`${what}: membership roles[${index}] is not a {role, ...} grant`);
    }
    return grant["role"];
  });
}
