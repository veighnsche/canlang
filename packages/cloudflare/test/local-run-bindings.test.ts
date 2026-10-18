import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startLocalDev, type LocalDev, type LocalDevOptions } from "../src/runtime/native-preview.test-support.js";

function options(source: string, extra: Partial<LocalDevOptions> = {}): LocalDevOptions {
  return { workerName: "local-bindings", compatibilityDate: "2026-07-15", mainModule: "main.js", modules: { "main.js": source }, ...extra };
}

it("wakes the actual app's resource recovery through private scheduled dispatch", async () => {
  const dev = await startLocalDev(options(`let wakes = 0; export default {
    fetch() { return Response.json({wakes}); },
    scheduled(controller) { if (controller.cron === 'can-resource-recovery') wakes++; }
  };`, { resourceRecovery: true }));
  try {
    const deadline = Date.now() + 8_000;
    let wakes = 0;
    while (Date.now() < deadline && wakes === 0) {
      wakes = ((await (await dev.dispatch("/")).json()) as { wakes: number }).wakes;
      if (wakes === 0) await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(wakes).toBeGreaterThan(0);
  } finally { await dev.dispose(); }
}, 30_000);

it("persists real KV values/metadata and isolates namespaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "can-local-kv-"));
  let dev: LocalDev | undefined;
  const config = options(`export default { async fetch(request, env) {
    const key = new URL(request.url).pathname.slice(1);
    if (request.method === "PUT") { await env["app.CACHE"].put(key, await request.text(), { metadata: { source: "worker" } }); return new Response(null, { status: 204 }); }
    if (request.method === "DELETE") { await env["app.CACHE"].delete(key); return new Response(null, { status: 204 }); }
    return Response.json(await env["app.CACHE"].getWithMetadata(key));
  } };`, { kvNamespaces: [{ binding: "app.CACHE", id: "cache" }, { binding: "OTHER", id: "other" }], kvPersist: root });
  try {
    dev = await startLocalDev(config);
    expect((await dev.dispatch("/one", { method: "PUT", body: "retained" })).status).toBe(204);
    expect(await (await dev.dispatch("/one")).json()).toMatchObject({ value: "retained", metadata: { source: "worker" } });
    expect(await (await dev.getKVNamespace("OTHER")).get("one")).toBeNull();
    await dev.dispose(); dev = undefined;
    dev = await startLocalDev(config);
    const cache = await dev.getKVNamespace("app.CACHE");
    expect(await cache.getWithMetadata("one")).toMatchObject({ value: "retained", metadata: { source: "worker" } });
    expect((await cache.list()).keys.map(key => key.name)).toEqual(["one"]);
    expect((await dev.dispatch("/one", { method: "DELETE" })).status).toBe(204);
    expect(await cache.get("one")).toBeNull();
  } finally { await dev?.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

it("executes a real SQLite Durable Object class with isolated identities and persisted storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "can-local-do-"));
  let dev: LocalDev | undefined;
  const config = options(`export class Counter {
    constructor(state) { this.state = state; }
    async fetch() { return this.state.storage.transaction(async store => {
      const next = (await store.get("count") ?? 0) + 1; await store.put("count", next); return Response.json({ count: next });
    }); }
  }
  export default { async fetch(request, env) { return env["app.COUNTER"].get(env["app.COUNTER"].idFromName(new URL(request.url).pathname)).fetch(request); } };`,
    { durableObjects: [{ binding: "app.COUNTER", className: "Counter", useSQLite: true }], durableObjectsPersist: root });
  try {
    dev = await startLocalDev(config);
    expect(await (await dev.dispatch("/one")).json()).toEqual({ count: 1 });
    expect(await (await dev.dispatch("/two")).json()).toEqual({ count: 1 });
    const namespace = await dev.getDurableObjectNamespace("app.COUNTER");
    expect(await (await namespace.get(namespace.idFromName("/one")).fetch("https://counter.test/")).json()).toEqual({ count: 2 });
    await dev.dispose(); dev = undefined;
    dev = await startLocalDev(config);
    expect(await (await dev.dispatch("/one")).json()).toEqual({ count: 3 });
  } finally { await dev?.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

it("calls supplied local service workers and refuses missing implementations", async () => {
  const primary = options('export default { fetch(request, env) { return env["app.GREETER"].fetch(request); } };', {
    serviceBindings: { "app.GREETER": "greeter" }, companionWorkers: [{ workerName: "greeter", compatibilityDate: "2026-07-15", mainModule: "service.js",
      modules: { "service.js": 'export default { fetch(request, env) { return Response.json({ greeting: env.GREETING, path: new URL(request.url).pathname }); } };' }, vars: { GREETING: "local service" } }],
  });
  const dev = await startLocalDev(primary);
  try { expect(await (await dev.dispatch("/hello")).json()).toEqual({ greeting: "local service", path: "/hello" }); }
  finally { await dev.dispose(); }
  await expect(startLocalDev({ ...primary, companionWorkers: [] })).rejects.toThrow(/no supplied implementation/);
  await expect(startLocalDev({ ...primary, companionWorkers: [primary] })).rejects.toThrow(/duplicated/);
}, 30_000);

it("delivers queue events to a real companion consumer, retries, and acknowledges messages", async () => {
  const dev = await startLocalDev(options('export default { async fetch(request, env) { await env["app.JOBS"].send(await request.json()); return new Response(null, { status: 202 }); } };', {
    d1Databases: [{ binding: "EVENTS", id: "queue-events" }], queueProducers: { "app.JOBS": "jobs" },
    companionWorkers: [{ workerName: "consumer", compatibilityDate: "2026-07-15", mainModule: "consumer.js",
      modules: { "consumer.js": `export default { async queue(batch, env) {
        for (const message of batch.messages) {
          await env.EVENTS.prepare("INSERT INTO events VALUES (?, ?, ?)").bind(message.id, message.attempts, JSON.stringify(message.body)).run();
          if (message.attempts === 1) message.retry({ delaySeconds: 0 }); else message.ack();
        }
      } };` }, d1Databases: [{ binding: "EVENTS", id: "queue-events" }],
      queueConsumers: { jobs: { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 2, retryDelay: 0 } } }],
  }));
  try {
    const db = await dev.getD1Database("EVENTS");
    await db.exec("CREATE TABLE events (id TEXT, attempts INTEGER, body TEXT)");
    expect((await dev.dispatch("/send", { method: "POST", body: JSON.stringify({ source: "worker" }) })).status).toBe(202);
    await vi.waitFor(async () => {
      expect((await db.prepare("SELECT attempts, body FROM events ORDER BY attempts").all()).results).toEqual([
        { attempts: 1, body: '{"source":"worker"}' }, { attempts: 2, body: '{"source":"worker"}' },
      ]);
    }, { interval: 20, timeout: 5_000 });
    await (await dev.getQueueProducer("app.JOBS")).send({ source: "host" });
    await vi.waitFor(async () => {
      expect((await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>())!.n).toBe(4);
    }, { interval: 20, timeout: 5_000 });
  } finally { await dev.dispose(); }
}, 30_000);

it("retains raw analytics points after response completion, persists them, and isolates datasets", async () => {
  const root = mkdtempSync(join(tmpdir(), "can-local-analytics-"));
  let dev: LocalDev | undefined;
  const config = options(`export default { fetch(request, env) {
    const point = new URL(request.url).pathname === "/invalid" ? { doubles: [Infinity] }
      : { indexes: ["tenant"], blobs: ["note", new Uint8Array([0, 255]).buffer, null], doubles: [1.25] };
    try { env["app.events"].writeDataPoint(point); } catch { return new Response(null, { status: 400 }); }
    return new Response("queued");
  } };`, { analyticsEngineDatasets: [{ binding: "app.events", dataset: "events" }, { binding: "app.other", dataset: "other" }], analyticsEnginePersist: root });
  try {
    dev = await startLocalDev(config);
    expect(await (await dev.dispatch("/")).text()).toBe("queued");
    await vi.waitFor(async () => expect(await dev!.getAnalyticsDataPoints("events")).toHaveLength(1), { timeout: 5_000, interval: 20 });
    expect((await dev.getAnalyticsDataPoints("events"))[0]).toMatchObject({ dataset: "events", workerName: "local-bindings",
      point: { indexes: ["tenant"], blobs: ["note", [0, 255], null], doubles: [1.25] } });
    expect(await dev.getAnalyticsDataPoints("other")).toEqual([]);
    expect((await dev.dispatch("/invalid")).status).toBe(400);
    expect(await dev.getAnalyticsDataPoints("events")).toHaveLength(1);
    await expect(dev.getAnalyticsDataPoints("unknown")).rejects.toThrow(/not configured/);
    await dev.dispose(); dev = undefined;
    dev = await startLocalDev(config);
    expect(await dev.getAnalyticsDataPoints("events")).toHaveLength(1);
    await dev.dispatch("/");
    await vi.waitFor(async () => expect(await dev!.getAnalyticsDataPoints("events")).toHaveLength(2), { timeout: 5_000, interval: 20 });
    await dev.dispose(); dev = undefined;
    dev = await startLocalDev({ ...config, analyticsEnginePersist: join(root, "separate") });
    expect(await dev.getAnalyticsDataPoints("events")).toEqual([]);
  } finally { await dev?.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

it("surfaces analytics storage failure instead of accepting a discarded event", async () => {
  const root = mkdtempSync(join(tmpdir(), "can-local-analytics-failure-"));
  const persist = join(root, "events");
  const dev = await startLocalDev(options('export default { fetch(request, env) { env.METRICS.writeDataPoint({ blobs: ["event"] }); return new Response("queued"); } };', {
    analyticsEngineDatasets: [{ binding: "METRICS", dataset: "events" }], analyticsEnginePersist: persist,
  }));
  try {
    rmSync(persist, { recursive: true }); writeFileSync(persist, "storage unavailable");
    await dev.dispatch("/");
    await vi.waitFor(async () => expect(dev.getAnalyticsDataPoints("events")).rejects.toMatchObject({ code: "ENOTDIR" }), { timeout: 5_000, interval: 20 });
    await expect(dev.dispose()).rejects.toMatchObject({ code: "ENOTDIR" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
