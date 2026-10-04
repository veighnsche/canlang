import { Miniflare, type DispatchFetch } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";

type DispatchInit = Parameters<DispatchFetch>[1];
type DispatchResult = ReturnType<DispatchFetch>;

export interface LocalD1 {
  binding: string;
  id: string;
}

export interface LocalDevOptions {
  workerName: string;
  compatibilityDate: string;
  /** Main module name, e.g. "worker.mjs". */
  mainModule: string;
  /** ESM module name -> source. */
  modules: Readonly<Record<string, string>>;
  d1Databases?: readonly LocalD1[];
  /** Plain (non-secret) vars exposed as JSON bindings. */
  vars?: Readonly<Record<string, unknown>>;
}

export interface LocalDev {
  dispatch: (path: string, init?: DispatchInit) => DispatchResult;
  getD1Database: (binding: string) => Promise<D1Database>;
  dispose: () => Promise<void>;
}

/**
 * Starts one local workerd instance for development and tests. Each call is
 * an independent instance; callers needing strict storage isolation (BDD
 * rows) use one instance per scope. No network listeners are opened;
 * requests go through `dispatch`.
 */
export async function startLocalDev(options: LocalDevOptions): Promise<LocalDev> {
  const modules: Record<string, { type: "esm"; contents: string }> = {};
  for (const [name, contents] of Object.entries(options.modules)) {
    modules[name] = { type: "esm", contents };
  }
  const env: Record<string, unknown> = {};
  for (const database of options.d1Databases ?? []) {
    env[database.binding] = { type: "d1", id: database.id };
  }
  for (const [name, value] of Object.entries(options.vars ?? {})) {
    env[name] = { type: "json", value };
  }

  const miniflare = new Miniflare({
    workers: [
      {
        config: {
          name: options.workerName,
          compatibilityDate: options.compatibilityDate,
          manifest: { mainModule: options.mainModule, modules },
          env,
        },
      },
    ],
  });

  return {
    dispatch: (path, init) => miniflare.dispatchFetch(`http://localhost${path}`, init),
    getD1Database: (binding) => miniflare.getD1Database(binding),
    dispose: () => miniflare.dispose(),
  };
}
