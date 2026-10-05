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
  /**
   * B3 I2: optional V3 source maps keyed by module name. Each provided map
   * is appended to its module as an inline `sourceMappingURL` data-URL
   * comment (after the last source line, so generated line numbers stay
   * valid). Absent by default; modules without an entry are untouched.
   */
  sourceMaps?: Readonly<Record<string, unknown>>;
}

/**
 * B3 I2: inline `sourceMappingURL` comment for one module, or `""` when
 * the module has no map. Node-side only (`Buffer`); never shipped to
 * workerd.
 */
function inlineMapComment(map: unknown): string {
  if (map === undefined) return "";
  const b64 = Buffer.from(JSON.stringify(map), "utf8").toString("base64");
  return `\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${b64}\n`;
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
  const withMap = (name: string, contents: string): string =>
    contents + inlineMapComment(options.sourceMaps?.[name]);
  const modules = [
    { path: options.mainModule, type: "ESModule" as const, contents: withMap(options.mainModule, mainContents) },
  ];
  for (const [name, contents] of Object.entries(options.modules)) {
    if (name !== options.mainModule) {
      modules.push({ path: name, type: "ESModule" as const, contents: withMap(name, contents) });
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
