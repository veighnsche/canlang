// Private exact-route selection cell: the single knob `selectExactBackend`
// consults, shared by the backend registry and the real values/src +
// stdlib consumers without a runtime import cycle.
//
// This module has no runtime imports (`ExactBackend` is type-only), so
// `values/src` numeric/stdlib/facade modules can route through it while
// `bindings/backend.ts` keeps owning the public selection API and the
// canonical TypeScript dispatch table. Routing rules, kept in one place:
// - `null` (the default) keeps the full-domain TypeScript route.
// - A selected backend serves genuine synchronous `backend.call` requests;
//   failures propagate with no post-failure TypeScript retry.
// - While the canonical TypeScript backend dispatches, routing re-enters
//   the canonical implementation directly (never recurses), even when the
//   dispatch table references the same routing public functions.
import type { ExactBackend } from "./backend.js";

let selected: ExactBackend | null = null;

/** True while the canonical TypeScript backend dispatches one call. */
let canonicalDispatching = false;

/** Installs or clears the selected exact backend. */
export function writeSelectedExact(backend: ExactBackend | null): void {
  selected = backend;
}

/** Reads the selected exact backend (`null` keeps the TypeScript route). */
export function readSelectedExact(): ExactBackend | null {
  return selected;
}

/** Runs `fn` with canonical-TypeScript dispatch marked. */
export function withCanonicalDispatch<T>(fn: () => T): T {
  const previous = canonicalDispatching;
  canonicalDispatching = true;
  try {
    return fn();
  } finally {
    canonicalDispatching = previous;
  }
}

/**
 * Sentinel for "no backend served this call; run the canonical
 * implementation". Returned when selection is `null` (the TypeScript
 * default) or while the canonical TypeScript backend dispatches.
 */
export const NOT_ROUTED: unique symbol = Symbol("canlang.exact-route.not-routed");

/**
 * Routes one registry operation to the selected backend. Returns
 * `NOT_ROUTED` when the caller must run its canonical TypeScript body;
 * otherwise returns the backend's synchronous result (or throws its
 * failure, never retried in TypeScript).
 */
export function routeExact<T>(op: string, args: unknown[]): T | typeof NOT_ROUTED {
  const backend = selected;
  if (backend === null || canonicalDispatching) return NOT_ROUTED;
  return backend.call(op, args) as T;
}
