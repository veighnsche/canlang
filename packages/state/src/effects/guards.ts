/** Read-only handler role view supplied by the canonical execution owner. */
export interface HandlerRoleContext {
  readonly memberships: readonly string[];
  readonly canonical?: {
    readonly builtinRoles?: readonly string[];
  };
}

/** Source-owned refusal from an authored guard; preserves the plain Error contract. */
export class AuthoredRequireFailure extends Error {}

/** Recognize authored guard refusals by the owning class, without matching caller data. */
export function isAuthoredRequireFailure(error: unknown): error is AuthoredRequireFailure {
  return error instanceof AuthoredRequireFailure;
}

/** Guard assertion emitted as `require as check`; preserves truthiness and error messages. */
export function require(condition: unknown, code = 'forbidden'): void {
  if (condition) return;
  throw new AuthoredRequireFailure(typeof code === 'string' && code !== '' ? code : 'forbidden');
}

/** Preserve the unsupported subject-form error without consulting caller roles. */
function unsupported(name: string, reason: string): never {
  throw new Error(`unsupported(${name}): ${reason}`);
}

/**
 * Synchronous handler snapshot test, distinct from async policy admission.
 * Canonical built-in roles come from the execution owner; declared roles
 * use its membership snapshot. Direct caller contexts supply their own
 * memberships and do not authenticate themselves through this helper.
 * Defined subject arguments remain unsupported.
 */
export function hasRole(c: HandlerRoleContext, role: string, subject?: unknown): boolean {
  if (subject !== undefined) {
    return unsupported('hasRole-subject', 'subject-scoped role tests need the L3 membership directory.');
  }
  if (c.canonical !== undefined && ['public', 'authenticated', 'members', 'owner'].includes(role)) {
    return c.canonical.builtinRoles?.includes(role) ?? false;
  }
  return c.memberships.includes(role);
}
