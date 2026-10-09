import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { describe, expect, it, vi } from "vitest";
import { startLocalDev } from "../src/dev/local-run.js";

const smokeSource = readFileSync(new URL("./fixtures/smoke-worker.mjs", import.meta.url), "utf8");

describe("local dev smoke", () => {
  it("refuses direct access to Miniflare while preserving dispatched URLs", async () => {
    const getReady = Object.getOwnPropertyDescriptor(Miniflare.prototype, "ready")?.get;
    if (getReady === undefined) throw new Error("Miniflare.ready getter is unavailable");
    let rawReady: Promise<URL> | undefined;
    const readySpy = vi.spyOn(Miniflare.prototype, "ready", "get").mockImplementation(function (this: Miniflare) {
      const ready = getReady.call(this) as Promise<URL>;
      rawReady = ready;
      return ready;
    });
    try {
      const dev = await startLocalDev({
        workerName: "guarded-smoke",
        compatibilityDate: "2026-07-15",
        mainModule: "worker.mjs",
        modules: {
          "worker.mjs": `export default { async fetch(request) {
            return Response.json({ url: request.url, gate: request.headers.get("x-can-local-dispatch") });
          } }`,
        },
      });
      try {
        const dispatched = await dev.dispatchUrl("http://preview.example.test/ping");
        expect(dispatched.status).toBe(200);
        expect(await dispatched.json()).toEqual({ url: "http://preview.example.test/ping", gate: null });
        if (rawReady === undefined) throw new Error("Miniflare raw origin was not observed");
        const direct = await fetch(new URL("/ping", await rawReady));
        expect(direct.status).toBe(403);
      } finally {
        await dev.dispose();
      }
    } finally {
      readySpy.mockRestore();
    }
  }, 120000);

  it("serves HTTP and round-trips D1 through the Worker binding", async () => {
    const dev = await startLocalDev({
      workerName: "smoke",
      // Within miniflare v4 workerd's supported range (newest: 2026-08-06).
      compatibilityDate: "2026-07-15",
      mainModule: "worker.mjs",
      modules: { "worker.mjs": smokeSource },
      d1Databases: [{ binding: "DB", id: "smoke-db" }],
    });
    try {
      const ping = await dev.dispatch("/ping");
      expect(ping.status).toBe(200);
      expect(await ping.json()).toEqual({ ok: true });

      const roundtrip = await dev.dispatch("/d1-roundtrip");
      expect(roundtrip.status).toBe(200);
      expect(await roundtrip.json()).toEqual({ v: "smoke-value" });

      const direct = await dev.getD1Database("DB");
      const row = await direct.prepare("SELECT COUNT(*) AS n FROM smoke").first<{ n: number }>();
      expect(row?.n).toBe(1);

      const missing = await dev.dispatch("/nope");
      expect(missing.status).toBe(404);
    } finally {
      await dev.dispose();
    }
  }, 120000);

  it("treats the main module as the entry for multi-module workers", async () => {
    const dev = await startLocalDev({
      workerName: "multi",
      // Within miniflare v4 workerd's supported range (newest: 2026-08-06).
      compatibilityDate: "2026-07-15",
      mainModule: "main.mjs",
      modules: {
        "helper.mjs": `export function greeting() { return "from-helper"; }`,
        "main.mjs": `import { greeting } from "./helper.mjs";
export default { async fetch() { return Response.json({ greeting: greeting() }); } }`,
      },
    });
    try {
      const response = await dev.dispatch("/");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ greeting: "from-helper" });
    } finally {
      await dev.dispose();
    }
  }, 120000);
});
