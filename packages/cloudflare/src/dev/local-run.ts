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
  /** Main module name, e.g. "worker.mjs". Must exist in `modules`. */
  mainModule: string;
  /** ESM module name -> source. The main module is the worker entry. */
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
 *
 * Pinned to the miniflare v4 stable line (same pin as lane 03) with its
 * flat options API. A joint v5 migration happens only when v5 stabilizes.
 */
export async function startLocalDev(options: LocalDevOptions): Promise<LocalDev> {
  const mainContents = options.modules[options.mainModule];
  if (mainContents === undefined) {
    throw new Error(`local dev main module ${options.mainModule} is missing from modules`);
  }
  const modules = [
    { path: options.mainModule, type: "ESModule" as const, contents: mainContents },
  ];
  for (const [name, contents] of Object.entries(options.modules)) {
    if (name !== options.mainModule) {
      modules.push({ path: name, type: "ESModule" as const, contents });
    }
  }
  const d1Databases: Record<string, string> = {};
  for (const database of options.d1Databases ?? []) {
    d1Databases[database.binding] = database.id;
  }

  const miniflare = new Miniflare({
    name: options.workerName,
    compatibilityDate: options.compatibilityDate,
    modules,
    bindings: { ...(options.vars ?? {}) },
    d1Databases,
  });

  return {
    dispatch: (path, init) => miniflare.dispatchFetch(`http://localhost${path}`, init),
    getD1Database: (binding) => miniflare.getD1Database(binding),
    dispose: () => miniflare.dispose(),
  };
}
