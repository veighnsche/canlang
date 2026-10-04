/**
 * Worker entry assembly (`@canlang/cloudflare/worker`). Runs inside workerd:
 * NO runtime imports are allowed here (only `import type`), enforced by
 * `test/worker-boundary.test.ts`. Handler wiring lands with the lane-1
 * artifact join; until then this validates required env bindings and
 * delegates to the injected dispatch.
 */

export interface WorkerAppOptions {
  /** Binding names that must be present on `env`. */
  requiredBindings: readonly string[];
  /** Inner dispatch, supplied by the future artifact assembly. */
  fetch: (request: Request, env: Record<string, unknown>) => Response | Promise<Response>;
}

export interface WorkerApp {
  fetch: (request: Request, env: Record<string, unknown>) => Response | Promise<Response>;
}

export function createWorkerApp(options: WorkerAppOptions): WorkerApp {
  return {
    fetch: (request, env) => {
      for (const binding of options.requiredBindings) {
        if (env[binding] === undefined || env[binding] === null) {
          return Response.json(
            { code: "missing-binding", binding },
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }
      }
      return options.fetch(request, env);
    },
  };
}
