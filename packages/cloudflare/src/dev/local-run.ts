import { randomBytes } from "node:crypto";
import { Miniflare, type DispatchFetch } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { COMPILED_WASM_MODULE_TYPE } from "@canlang/contracts";

type DispatchInit = Parameters<DispatchFetch>[1];
type DispatchResult = ReturnType<DispatchFetch>;

const DISPATCH_HEADER = "x-can-local-dispatch";
const GATEWAY_SOURCE = `
export default {
  fetch(request, env) {
    if (request.headers.get("x-can-local-dispatch") !== env.CAN_LOCAL_SECRET) {
      return new Response(null, { status: 403 });
    }
    const headers = new Headers(request.headers);
    headers.delete("x-can-local-dispatch");
    return env.CAN_LOCAL_APP.fetch(new Request(request, { headers }));
  },
};
`;

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
  /**
   * C04.asset: binary module name -> raw bytes, staged as `CompiledWasm`
   * (pinned installed mapping; verified vs miniflare@4.20260730.0 types).
   * Absent by default; text-only callers are byte-identical. A name
   * present in both maps is a loud error, never a silent shadow.
   */
  binaryModules?: Readonly<Record<string, Uint8Array>>;
  d1Databases?: readonly LocalD1[];
  /** Caller-owned private directory; permits a trusted provisioning handoff. */
  d1Persist?: string;
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
  /** Preserve the browser origin for auth redirects, cookies and Origin checks. */
  dispatchUrl: (url: string, init?: DispatchInit) => DispatchResult;
  getD1Database: (binding: string) => Promise<D1Database>;
  dispose: () => Promise<void>;
}

/**
 * Starts one local workerd instance for development and tests. Each call is
 * an independent instance; callers needing strict storage isolation (BDD
 * rows) use one instance per scope. Miniflare opens a loopback HTTP listener;
 * a private gateway refuses direct requests before they reach the app Worker.
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
  const modules: Array<{
    path: string;
    type: "ESModule" | typeof COMPILED_WASM_MODULE_TYPE;
    contents: string | Uint8Array<ArrayBuffer>;
  }> = [
    { path: options.mainModule, type: "ESModule" as const, contents: withMap(options.mainModule, mainContents) },
  ];
  for (const [name, contents] of Object.entries(options.modules)) {
    if (name !== options.mainModule) {
      modules.push({ path: name, type: "ESModule" as const, contents: withMap(name, contents) });
    }
  }
  for (const [name, bytes] of Object.entries(options.binaryModules ?? {})) {
    if (options.modules[name] !== undefined) {
      throw new Error(`local dev binary module ${name} collides with a text module`);
    }
    // The installed miniflare API takes `Uint8Array<ArrayBuffer>`; copy so
    // any caller buffer (Buffer, views) stages with exact same bytes.
    modules.push({ path: name, type: COMPILED_WASM_MODULE_TYPE, contents: new Uint8Array(bytes) });
  }
  const d1Databases: Record<string, string> = {};
  for (const database of options.d1Databases ?? []) {
    d1Databases[database.binding] = database.id;
  }

  const secret = randomBytes(32).toString("base64url");
  const miniflare = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    ...(options.d1Persist === undefined ? {} : { d1Persist: options.d1Persist }),
    workers: [
      {
        name: `can-local-gateway-${randomBytes(8).toString("hex")}`,
        compatibilityDate: options.compatibilityDate,
        modules: true,
        script: GATEWAY_SOURCE,
        bindings: { CAN_LOCAL_SECRET: secret },
        serviceBindings: { CAN_LOCAL_APP: options.workerName },
      },
      {
        name: options.workerName,
        compatibilityDate: options.compatibilityDate,
        modules,
        bindings: { ...(options.vars ?? {}) },
        d1Databases,
      },
    ],
  });

  const dispatchUrl = (url: string, init?: DispatchInit): DispatchResult => {
    const headers = new Headers(init?.headers);
    headers.set(DISPATCH_HEADER, secret);
    return miniflare.dispatchFetch(url, { ...init, headers: [...headers] });
  };

  return {
    dispatch: (path, init) => dispatchUrl(`http://localhost${path}`, init),
    dispatchUrl,
    getD1Database: (binding) => miniflare.getD1Database(binding, options.workerName),
    dispose: () => miniflare.dispose(),
  };
}
