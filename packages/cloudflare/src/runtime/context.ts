/**
 * B1 handler context: the `c` in emitted `async op(c, …)` handlers.
 *
 * INTERIM B1 binding — handoff to L3. This context is the minimal carrier the
 * B1 interim data-plane stdlib (`./stdlib.js`) needs: caller identity, the
 * state-engine storage port, a clock, and membership labels. L3 must
 * formalize: operation identity (name/id for receipts and history), the
 * admission/policy wiring (`InvocationContext`, `PolicyTable`,
 * `MembershipReader`), and the L1 T4 call-shape contract for handler args.
 */
import type { StoragePort } from '@canlang/contracts';

/** Authenticated caller identity: stable user id plus granted role names. */
export interface CallerInfo {
  userId: string;
  roles: string[];
}

/**
 * Handler context threaded as the first argument (`c`) of every emitted
 * operation handler and every c-first stdlib function.
 */
export interface HandlerContext {
  caller: CallerInfo;
  store: StoragePort;
  clock: () => number;
  memberships: string[];
  preferences: Record<string, Record<string, unknown>>;
}

/**
 * Dependencies for {@link createContext}. `clock`/`memberships`/
 * `preferences` default. `preferences` keys are app names; pages read
 * `c.preferences.<App>.<key>` — defaulting an app key the page reads is
 * the caller's job (authoring defaults live in the Given block; the
 * dispatcher join must supply them, B1 callers pass them explicitly).
 */
export interface CreateContextDeps {
  caller: CallerInfo;
  store: StoragePort;
  clock?: () => number;
  memberships?: string[];
  preferences?: Record<string, Record<string, unknown>>;
}

/**
 * Build a handler context. Defaults: `clock` is `Date.now`,
 * `memberships` is `[]`, `preferences` is `{}`.
 */
export function createContext(deps: CreateContextDeps): HandlerContext {
  return {
    caller: deps.caller,
    store: deps.store,
    clock: deps.clock ?? (() => Date.now()),
    memberships: deps.memberships ?? [],
    preferences: deps.preferences ?? {},
  };
}
