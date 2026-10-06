/**
 * ExampleHooks harness wiring (LG03a): pure adapters between compiled
 * example execution ({@link StepCall}) and producer dispatch / live
 * state. All producer I/O stays injected (`DispatchFn`, `LiveReadFn`)
 * so the mapping is unit-verifiable without dists, workerd, or the
 * toolchain; the live binding (real dispatch + state reads) plugs in at
 * the pilot go-ahead and lives in `tests/e2e/fixtures/example-hooks.ts`.
 *
 * - {@link stepCallToDispatchRequest} normalizes one step call to a
 *   dispatchable request (operation identity, object inputs, present
 *   caller). Malformed calls fail loud with call context.
 * - {@link populateLiveScope} builds the `Map` observation closures read:
 *   live values per fixture name with static fallback for names the
 *   reader does not know (`undefined`); reader throws propagate with
 *   fixture identity.
 * - {@link createExampleHooks} composes both into {@link ExampleHooks}.
 */
import type { CallOutcome } from "./table.js";
import type { ExampleHooks, StepCall } from "./steps.js";
import { scopeFacade } from "../fixtures/recipes.js";

/** Dispatchable operation request (producer dispatch owns execution). */
export interface DispatchRequest {
  readonly operation: string;
  readonly inputs: Record<string, unknown>;
  readonly caller: unknown;
}

/** Real operation dispatch (B/C slice; injected). */
export type DispatchFn = (request: DispatchRequest) => Promise<CallOutcome>;

/**
 * Live state read per fixture name (B/C read ports; injected). Returns
 * the live value, or `undefined` when the name has no live row (the
 * static provisioned value is used as fallback).
 */
export type LiveReadFn = (fixtureName: string) => Promise<unknown> | unknown;

/** Normalizes one step call to a dispatchable request (fails loud). */
export function stepCallToDispatchRequest(call: StepCall): DispatchRequest {
  if (typeof call.operation !== "string" || call.operation.length === 0) {
    throw new Error("dispatch call has no operation identity");
  }
  if (typeof call.inputs !== "object" || call.inputs === null || Array.isArray(call.inputs)) {
    throw new Error(`dispatch call ${JSON.stringify(call.operation)} has inputs that are not an object`);
  }
  if (call.by === null || call.by === undefined) {
    throw new Error(`dispatch call ${JSON.stringify(call.operation)} has no caller`);
  }
  return { operation: call.operation, inputs: call.inputs as Record<string, unknown>, caller: call.by };
}

/**
 * Builds the observation scope: live values per fixture name, falling
 * back to the static provisioned value when the reader returns
 * `undefined`. Reader throws propagate with fixture identity. Returned
 * as a scope facade so genuine observation closures read properties
 * (`s.task`) while Map probes keep working.
 */
export async function populateLiveScope(
  fixtureNames: readonly string[],
  readLive: LiveReadFn,
  fallback: ReadonlyMap<string, unknown>,
): Promise<ReadonlyMap<string, unknown>> {
  const scope = new Map<string, unknown>();
  for (const name of fixtureNames) {
    let live: unknown;
    try {
      live = await readLive(name);
    } catch (thrown) {
      const detail = thrown instanceof Error ? thrown.message : String(thrown);
      throw new Error(`live read of fixture ${JSON.stringify(name)} failed: ${detail}`, {
        cause: thrown,
      });
    }
    scope.set(name, live === undefined ? fallback.get(name) : live);
  }
  return scopeFacade(scope);
}

export interface HookDependencies {
  readonly dispatch: DispatchFn;
  readonly readLive: LiveReadFn;
}

/** Composes injected producer I/O into {@link ExampleHooks}. */
export function createExampleHooks(deps: HookDependencies): ExampleHooks {
  return {
    invokeCall: async (call) => deps.dispatch(stepCallToDispatchRequest(call)),
    observeScope: async (_scope, stashed) =>
      populateLiveScope([...stashed.fixtures.keys()], deps.readLive, stashed.fixtures),
  };
}
