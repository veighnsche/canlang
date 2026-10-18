import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, constants, mkdirSync, readFileSync } from "node:fs";
import { access, lstat, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Miniflare, type DispatchFetch, type WorkerOptions } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { COMPILED_WASM_MODULE_TYPE } from "@canlang/contracts";
import { observedError, type PreviewRefusal } from "./preview-bridge.js";
import { cleanupAfterFailure, retryableDispose } from "./cleanup.js";

type DispatchInit = Parameters<DispatchFetch>[1];
type DispatchResult = ReturnType<DispatchFetch>;

const DISPATCH_HEADER = "x-can-local-dispatch";
const GATEWAY_SOURCE = `
async function limited(stream) {
  if (!stream) return "";
  const reader = stream.getReader(), chunks = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length; if (length > 8192) { void reader.cancel(); return ""; }
      chunks.push(next.value);
    }
    const out = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(out);
  } finally { reader.releaseLock(); }
}
export default {
  async fetch(request, env) {
    if (request.headers.get("x-can-local-dispatch") !== env.CAN_LOCAL_SECRET) {
      return new Response(null, { status: 403 });
    }
    const headers = new Headers(request.headers);
    headers.delete("x-can-local-dispatch");
    const originalUrl = headers.get("x-can-local-url") || request.url;
    headers.delete("x-can-local-url");
    const actual = new Request(new Request(originalUrl, request), { headers });
    const copy = actual.clone();
    const response = await env.CAN_LOCAL_APP.fetch(actual);
    if (response.status >= 400 || new URL(originalUrl).pathname === "/mcp") {
      const body = await limited(response.clone().body);
      await env.CAN_LOCAL_OBSERVE.fetch(new Request("http://local/", { method: "POST", body: JSON.stringify({
        status: response.status, headers: [...response.headers], body,
        request: { method: actual.method, pathname: new URL(originalUrl).pathname, body: await limited(copy.body) }
      }) }));
    }
    else { void copy.body?.cancel(); }
    return response;
  },
};
`;

export interface LocalD1 {
  binding: string;
  id: string;
}

export interface LocalR2 {
  binding: string;
  id: string;
}

export interface LocalKV {
  binding: string;
  id: string;
}

export interface LocalDurableObject {
  binding: string;
  className: string;
  scriptName?: string;
  useSQLite?: boolean;
}

export interface LocalQueueConsumer {
  maxBatchSize?: number;
  maxBatchTimeout?: number;
  maxRetries?: number;
  deadLetterQueue?: string;
  retryDelay?: number;
}

export interface LocalAnalyticsDataset {
  binding: string;
  dataset: string;
}

/** Binary index/blob values are retained as byte arrays in the local log. */
export interface LocalAnalyticsDataPoint {
  dataset: string;
  workerName: string;
  timestamp: string;
  point: { indexes: Array<string | number[] | null>; blobs: Array<string | number[] | null>; doubles: number[] };
}

export interface LocalWorkerOptions {
  /** Preserve the application's selected workerd compatibility flags. */
  compatibilityFlags?: readonly string[];
  /** Offline targets refuse outbound requests at the runtime. */
  denyOutbound?: boolean;
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
  r2Buckets?: readonly LocalR2[];
  kvNamespaces?: readonly LocalKV[];
  durableObjects?: readonly LocalDurableObject[];
  queueProducers?: Readonly<Record<string, string | { queueName: string; deliveryDelay?: number }>>;
  /** Real Worker queue handlers receive batches; Miniflare queues are memory-only. */
  queueConsumers?: Readonly<Record<string, LocalQueueConsumer>>;
  /** Targets must be this app or a supplied companion worker. */
  serviceBindings?: Readonly<Record<string, string | { name: string; entrypoint?: string }>>;
  analyticsEngineDatasets?: readonly LocalAnalyticsDataset[];
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

export interface LocalDevOptions extends LocalWorkerOptions {
  /** Private host wake-up for durable resource outbox/handler recovery. */
  resourceRecovery?: boolean;
  /** Real local dependency workers. Only the main app is HTTP-dispatched. */
  companionWorkers?: readonly LocalWorkerOptions[];
  /** Caller-owned private storage; omitted stores are isolated temporary state. */
  d1Persist?: string;
  /** Refuse unavailable retained storage before starting workerd. */
  d1PersistenceRequired?: boolean;
  r2Persist?: string;
  kvPersist?: string;
  durableObjectsPersist?: string;
  analyticsEnginePersist?: string;
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

export interface LocalRuntimeBackend {
  readonly origin: string;
  readonly header: "x-can-local-dispatch";
  readonly secret: string;
  readonly urlHeader: "x-can-local-url";
}

export interface LocalDev {
  /** Private transport for an external owner; never a browser access URL. */
  readonly backend: LocalRuntimeBackend;
  observeRefusals(handler: (event: PreviewRefusal) => void): () => void;
  dispatch: (path: string, init?: DispatchInit) => DispatchResult;
  /** Preserve the browser origin for auth redirects, cookies and Origin checks. */
  dispatchUrl: (url: string, init?: DispatchInit) => DispatchResult;
  getD1Database: (binding: string) => Promise<D1Database>;
  getR2Bucket: (binding: string) => ReturnType<Miniflare["getR2Bucket"]>;
  getKVNamespace: (binding: string) => ReturnType<Miniflare["getKVNamespace"]>;
  getDurableObjectNamespace: (binding: string) => ReturnType<Miniflare["getDurableObjectNamespace"]>;
  getQueueProducer: (binding: string) => ReturnType<Miniflare["getQueueProducer"]>;
  /** Writes are asynchronous, like the Cloudflare raw API. Disk failures reject. */
  getAnalyticsDataPoints: (dataset: string) => Promise<readonly LocalAnalyticsDataPoint[]>;
  dispose: () => Promise<void>;
}

function workerOptions(options: LocalWorkerOptions): WorkerOptions {
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

  const r2Buckets: Record<string, string> = {};
  for (const bucket of options.r2Buckets ?? []) {
    r2Buckets[bucket.binding] = bucket.id;
  }

  const kvNamespaces = Object.fromEntries((options.kvNamespaces ?? []).map(namespace => [namespace.binding, namespace.id]));
  const durableObjects = Object.fromEntries((options.durableObjects ?? []).map(({ binding, ...definition }) => [binding, definition]));
  return {
    name: options.workerName, compatibilityDate: options.compatibilityDate,
    compatibilityFlags: [...(options.compatibilityFlags ?? [])],
    ...(options.denyOutbound ? { outboundService: { network: { allow: [] } } } : {}),
    modules, bindings: { ...(options.vars ?? {}) }, d1Databases, r2Buckets, kvNamespaces, durableObjects,
    ...(options.queueProducers === undefined ? {} : { queueProducers: { ...options.queueProducers } }),
    ...(options.queueConsumers === undefined ? {} : { queueConsumers: { ...options.queueConsumers } }),
    ...(options.serviceBindings === undefined ? {} : { serviceBindings: { ...options.serviceBindings } }),
  };
}

// Wrapped bindings are internal workerd modules. Use the same pinned internal
// waitUntil primitive as cloudflare:workers to retain raw fire-and-forget writes.
const ANALYTICS_SOURCE = `
import workers from "cloudflare-internal:workers";
export default env => ({ writeDataPoint(point = {}) {
  if (point === null || typeof point !== "object" || Array.isArray(point)) throw new TypeError("analytics point must be an object");
  function values(name, limit) {
    const value = point[name] ?? [];
    if (!Array.isArray(value) || value.length > limit) throw new TypeError("invalid analytics " + name);
    return value;
  }
  function bytes(value) {
    if (value === null || typeof value === "string") return value;
    if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
    throw new TypeError("analytics index/blob must be a string, ArrayBuffer or null");
  }
  const indexes = values("indexes", 1).map(bytes), blobs = values("blobs", 20).map(bytes), doubles = values("doubles", 20);
  if (doubles.some(value => typeof value !== "number" || !Number.isFinite(value))) throw new TypeError("analytics doubles must be finite numbers");
  const size = value => value === null ? 0 : typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.length;
  if (indexes.some(value => size(value) > 96) || blobs.reduce((sum, value) => sum + size(value), 0) > 16384) throw new RangeError("analytics point exceeds byte limits");
  workers.waitUntil(env.CAN_ANALYTICS_SINK.fetch(new Request("https://can-local-analytics/", {
    method: "POST", body: JSON.stringify({ point: { indexes, blobs, doubles } }),
    headers: { "content-type": "application/json", "x-dataset": env.dataset, "x-worker": env.workerName },
  })).then(response => { if (!response.ok) throw new Error("local analytics sink refused the event"); }));
} });
`;

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
  if (options.d1PersistenceRequired) {
    await requireD1Persistence(options.d1Persist);
    if ((options.durableObjects?.length ?? 0) > 0 || options.companionWorkers?.some(worker => (worker.durableObjects?.length ?? 0) > 0)) {
      await requireD1Persistence(options.durableObjectsPersist);
    }
  }
  const localWorkers = [options, ...(options.companionWorkers ?? [])];
  const names = validateLocalWorkers(localWorkers);
  const datasets = new Set(localWorkers.flatMap(worker => (worker.analyticsEngineDatasets ?? []).map(value => value.dataset)));
  const analytics = new Map<string, LocalAnalyticsDataPoint[]>();
  let analyticsFailure: unknown;
  if (datasets.size > 0 && options.analyticsEnginePersist !== undefined) mkdirSync(options.analyticsEnginePersist, { recursive: true, mode: 0o700 });
  const analyticsPath = (dataset: string): string => join(options.analyticsEnginePersist!, `${createHash("sha256").update(dataset).digest("hex")}.jsonl`);
  const analyticsWorker = `can-local-analytics-${randomBytes(8).toString("hex")}`;
  const configuredWorkers = localWorkers.map(worker => {
    const configured = workerOptions(worker);
    if ((worker.analyticsEngineDatasets?.length ?? 0) > 0) {
      configured.wrappedBindings = Object.fromEntries(worker.analyticsEngineDatasets!.map(value => [value.binding, {
        scriptName: analyticsWorker, bindings: { dataset: value.dataset, workerName: worker.workerName },
      }]));
    }
    return configured;
  });
  const secret = randomBytes(32).toString("base64url");
  const refusals = localRefusalObservers();
  const miniflare = new Miniflare({
    // Local targets need no remote request-location metadata or .wrangler cache.
    cf: false,
    host: "127.0.0.1",
    port: 0,
    ...(options.d1Persist === undefined ? {} : { d1Persist: options.d1Persist }),
    ...(options.r2Persist === undefined ? {} : { r2Persist: options.r2Persist }),
    ...(options.kvPersist === undefined ? {} : { kvPersist: options.kvPersist }),
    ...(options.durableObjectsPersist === undefined ? {} : { durableObjectsPersist: options.durableObjectsPersist }),
    workers: [
      {
        name: `can-local-gateway-${randomBytes(8).toString("hex")}`,
        compatibilityDate: options.compatibilityDate,
        modules: true,
        script: GATEWAY_SOURCE,
        bindings: { CAN_LOCAL_SECRET: secret },
        serviceBindings: { CAN_LOCAL_APP: options.workerName, CAN_LOCAL_OBSERVE: refusals.accept },
      },
      ...configuredWorkers,
      ...(datasets.size === 0 ? [] : [{
        name: analyticsWorker,
        modules: [{ type: "ESModule" as const, path: "analytics.js", contents: ANALYTICS_SOURCE }],
        serviceBindings: { CAN_ANALYTICS_SINK: async (request: Request) => {
          try {
            const dataset = request.headers.get("x-dataset")!, workerName = request.headers.get("x-worker")!;
            if (!datasets.has(dataset) || !names.has(workerName)) return new Response(null, { status: 403 });
            const { point } = await request.json() as Pick<LocalAnalyticsDataPoint, "point">;
            const event = { dataset, workerName, timestamp: new Date().toISOString(), point };
            if (options.analyticsEnginePersist !== undefined) appendFileSync(analyticsPath(dataset), `${JSON.stringify(event)}\n`, { mode: 0o600 });
            else { const rows = analytics.get(dataset) ?? []; rows.push(event); analytics.set(dataset, rows); }
            return new Response(null, { status: 204 });
          } catch (error) {
            analyticsFailure ??= error;
            return new Response(null, { status: 500 });
          }
        } },
      }]),
    ],
  });

  const dispatchUrl = (url: string, init?: DispatchInit): DispatchResult => {
    const headers = new Headers(init?.headers);
    headers.set(DISPATCH_HEADER, secret);
    return miniflare.dispatchFetch(url, { ...init, headers: [...headers] });
  };

  let recovery: Promise<void> | undefined;
  let startupFailure: unknown;
  let stopped = false;
  let reportedRecoveryFailure = false;
  const wake = (): void => {
    if (stopped || recovery !== undefined) return;
    recovery = (async () => {
      const worker = await miniflare.getWorker(options.workerName);
      const result = await worker.scheduled({ scheduledTime: new Date(), cron: 'can-resource-recovery' });
      if (result.outcome !== 'ok') throw new Error(`Local resource recovery failed (${result.outcome}).`);
      reportedRecoveryFailure = false;
    })().catch(error => {
      if (stopped) return;
      if (!reportedRecoveryFailure) console.error('Can local resource recovery:', error);
      reportedRecoveryFailure = true;
    }).finally(() => { recovery = undefined; });
  };
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  const dispose = retryableDispose(async () => {
    stopped = true;
    if (recoveryTimer !== undefined) clearInterval(recoveryTimer);
    // Start disposal even if a scheduled recovery dispatch never settles.
    // Closing workerd aborts that dispatch; waiting first can deadlock stop.
    try { await miniflare.dispose(); }
    catch (error) {
      // Pinned Miniflare rethrows its original init rejection after its
      // disposal finally completes. A different error means cleanup failed.
      if (startupFailure === undefined || error !== startupFailure) throw error;
    }
    await recovery;
  });
  let backend: LocalRuntimeBackend;
  try { backend = await localRuntimeBackend(miniflare, secret); }
  catch (error) { startupFailure = error; return cleanupAfterFailure(error, dispose); }
  recoveryTimer = options.resourceRecovery === true ? setInterval(wake, 1_000) : undefined;
  recoveryTimer?.unref();

  return {
    observeRefusals: refusals.observe,
    backend,
    dispatch: (path, init) => dispatchUrl(`http://localhost${path}`, init),
    dispatchUrl,
    getD1Database: (binding) => miniflare.getD1Database(binding, options.workerName),
    getR2Bucket: (binding) => miniflare.getR2Bucket(binding, options.workerName),
    getKVNamespace: (binding) => miniflare.getKVNamespace(binding, options.workerName),
    getDurableObjectNamespace: (binding) => miniflare.getDurableObjectNamespace(binding, options.workerName),
    getQueueProducer: (binding) => miniflare.getQueueProducer(binding, options.workerName),
    getAnalyticsDataPoints: async dataset => {
      if (analyticsFailure !== undefined) throw analyticsFailure;
      if (!datasets.has(dataset)) throw new Error(`local dev analytics dataset ${dataset} is not configured`);
      if (options.analyticsEnginePersist === undefined) return structuredClone(analytics.get(dataset) ?? []);
      let text: string;
      try { text = readFileSync(analyticsPath(dataset), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
      return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as LocalAnalyticsDataPoint);
    },
    dispose: async () => {
      await dispose();
      const failure = analyticsFailure;
      analyticsFailure = undefined;
      if (failure !== undefined) throw failure;
    },
  };
}

/** Check the caller's existing mount; never create an ephemeral replacement. */
async function requireD1Persistence(path: string | undefined): Promise<void> {
  if (path === undefined || !isAbsolute(path)) {
    throw new Error("required D1 storage must be an existing absolute directory");
  }
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a directory");
    await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
    const probe = join(path, `.can-storage-probe-${randomBytes(16).toString("hex")}`);
    const file = await open(probe, "wx", 0o600);
    try { await file.writeFile("storage preflight\n"); await file.sync(); }
    finally { await file.close(); await unlink(probe); }
  } catch {
    throw new Error("required D1 storage is unavailable or unwritable");
  }
}

/** The private backend emits only the existing safe business-error projection. */
function localRefusalObservers() {
  const handlers = new Set<(event: PreviewRefusal) => void>();
  return {
    observe(handler: (event: PreviewRefusal) => void): () => void {
      handlers.add(handler); return () => { handlers.delete(handler); };
    },
    async accept(request: Request): Promise<Response> {
      const value = await request.json() as { status: number; headers: [string, string][]; body: string;
        request: { method: string; pathname: string; body: string } };
      const projected = observedError(new Response(null, { status: value.status, headers: value.headers }),
        Buffer.from(value.body), { ...value.request, body: Buffer.from(value.request.body) });
      if (projected !== null) {
        const event = { requestId: randomBytes(16).toString("hex"), status: value.status, ...projected };
        for (const handler of handlers) handler(event);
      }
      return new Response(null, { status: 204 });
    },
  };
}

async function localRuntimeBackend(miniflare: Miniflare, secret: string): Promise<LocalRuntimeBackend> {
  return { origin: (await miniflare.ready).origin, header: DISPATCH_HEADER, secret, urlHeader: "x-can-local-url" };
}

function validateLocalWorkers(localWorkers: readonly LocalWorkerOptions[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const worker of localWorkers) {
    if (names.has(worker.workerName)) throw new Error(`local dev worker ${worker.workerName} is duplicated`);
    names.add(worker.workerName);
  }
  for (const worker of localWorkers) {
    for (const target of Object.values(worker.serviceBindings ?? {})) {
      const name = typeof target === "string" ? target : target.name;
      if (!names.has(name)) throw new Error(`local dev service worker ${name} has no supplied implementation`);
    }
    for (const object of worker.durableObjects ?? []) {
      if (object.scriptName !== undefined && !names.has(object.scriptName)) {
        throw new Error(`local dev Durable Object worker ${object.scriptName} has no supplied implementation`);
      }
    }
  }
  return names;
}
