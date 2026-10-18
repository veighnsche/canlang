// Host side of the structural scaffold binding (V03.5).
//
// Wraps caller-supplied generated glue (init owned by bootstrap):
// versioned scaffold requests in, parsed values out. Scaffold
// failures surface as StructuralError carrying the envelope's stage,
// code and optional check — never silent, never retried.
export const REQUIRED_STRUCTURAL_ABI = 1;

export type StructuralStage = "transport" | "plan";

/** Minimal structural shape of the generated scaffold glue. */
export interface ValidationGlue {
  structural_abi_version(): number;
  validation_call(requestJson: string): string;
}

export class StructuralError extends Error {
  readonly stage: StructuralStage;
  readonly code: string;
  readonly check?: string;

  constructor(stage: StructuralStage, code: string, check?: string) {
    super(`structural ${stage} failure: ${code}${check === undefined ? "" : ` (${check})`}`);
    this.name = "StructuralError";
    this.stage = stage;
    this.code = code;
    if (check !== undefined) {
      this.check = check;
    }
  }
}

export interface ValidationBackend {
  /** Synchronous scaffold call; throws StructuralError on envelope failure. */
  call(op: string, args: Record<string, unknown>): unknown;
}

/** One ordered violation record from native execution. */
export interface OwnedViolation {
  readonly path: ReadonlyArray<{ k: readonly number[] } | { i: number }>;
  readonly code: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
}

/** Whole-profile execution outcome (never a partial value on failure). */
export type OwnedOutcome =
  | { readonly outcome: "valid"; readonly value: unknown }
  | { readonly outcome: "invalid"; readonly violations: readonly OwnedViolation[] }
  | { readonly outcome: "deferred"; readonly reason: string; readonly detail: string }
  | { readonly outcome: "limit"; readonly code: string; readonly check: string };

/** Execution target: a contract value in a mode, or an operation call. */
export type OwnedTarget =
  | { readonly kind: "contract"; readonly name: string; readonly mode: "create" | "update" }
  | { readonly kind: "operation"; readonly name: string };

export interface OwnedExecution {
  readonly owner: number;
  readonly plan: string;
  /** Frame JSON built from parser-owned data (see owned-input frame join). */
  readonly frame: unknown;
  readonly budgets: { readonly nodes: number; readonly depth: number; readonly text: number; readonly entries: number };
  readonly profile: "values/v1";
  readonly target: OwnedTarget;
}

/**
 * Begins one owned request: gates handles, builds the checked arena
 * and retains it server-side. The returned id is closed over by
 * `withOwnedRequest`, which always disposes it.
 */
export function beginOwnedRequest(backend: ValidationBackend, args: {
  readonly owner: number;
  readonly plan: string;
  readonly frame: unknown;
  readonly budgets: OwnedExecution["budgets"];
}): number {
  const value = backend.call("request.begin", {
    owner: args.owner,
    plan: args.plan,
    frame: args.frame,
    budgets: args.budgets,
  }) as { readonly request: number };
  return value.request;
}

/** Executes one whole profile action against a live request. */
export function executeOwnedRequest(
  backend: ValidationBackend,
  request: number,
  profile: "values/v1",
  target: OwnedTarget,
): OwnedOutcome {
  return backend.call("values.execute", { request, profile, target }) as OwnedOutcome;
}

/** Disposes one request. Idempotent: unknown ids are silent no-ops. */
export function disposeOwnedRequest(backend: ValidationBackend, request: number): void {
  backend.call("request.dispose", { request });
}

/** Owner plan load: one owner scope plus one normalized schema with
 * factory provenance, registered in order. The owner scope carries the
 * family profile (`values`); the plan carries the execution profile
 * (`values/v1`) that `values.execute` must match. Threading all three
 * through both calls is the loader's only job; every gate (provenance,
 * stale scope, carried shape duties, registry bound) stays native. */
export interface OwnerPlanLoad {
  readonly abi: string;
  readonly profile: string;
  readonly planProfile: string;
  readonly backend: string;
  readonly owner_rev: string;
  readonly bound: number;
  readonly schema: Record<string, unknown>;
  readonly provenance: { readonly factory: string; readonly owner_rev: string };
}

export function loadOwnerPlan(
  via: ValidationBackend,
  load: OwnerPlanLoad,
): { owner: number; id: string } {
  const created = via.call("owner.create", {
    abi: load.abi,
    profile: load.profile,
    backend: load.backend,
    owner_rev: load.owner_rev,
    bound: load.bound,
  }) as { owner: number };
  const registered = via.call("plan.register", {
    owner: created.owner,
    profile: load.planProfile,
    schema: load.schema,
    provenance: load.provenance,
  }) as { id: string };
  return { owner: created.owner, id: registered.id };
}

/**
 * Runs one whole profile action with request-scoped cleanup. The
 * request is disposed in `finally`, covering success, error and
 * cancellation. No semantic operation is retried after a failure.
 */
export function withOwnedRequest<T>(
  backend: ValidationBackend,
  execution: OwnedExecution,
  run: (outcome: OwnedOutcome) => T,
): T {
  const request = beginOwnedRequest(backend, execution);
  try {
    return run(executeOwnedRequest(backend, request, execution.profile, execution.target));
  } finally {
    disposeOwnedRequest(backend, request);
  }
}

/**
 * Scaffold backend over caller-supplied glue. The ABI version is
 * checked at construction: a mismatched module fails here, never
 * mid-request.
 */
export function validationBackend(glue: ValidationGlue): ValidationBackend {
  const abi = glue.structural_abi_version();
  if (abi !== REQUIRED_STRUCTURAL_ABI) {
    throw new StructuralError("transport", "version/unsupported");
  }
  return {
    call(op: string, args: Record<string, unknown>): unknown {
      const request = JSON.stringify({ v: REQUIRED_STRUCTURAL_ABI, op, args });
      const response = JSON.parse(glue.validation_call(request)) as {
        ok: boolean;
        value?: unknown;
        stage?: StructuralStage;
        code?: string;
        check?: string;
      };
      if (!response.ok) {
        throw new StructuralError(
          response.stage ?? "transport",
          response.code ?? "args/malformed",
          response.check,
        );
      }
      return response.value;
    },
  };
}
