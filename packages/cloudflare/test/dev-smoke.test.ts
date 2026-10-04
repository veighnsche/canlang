import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startLocalDev } from "../src/dev/local-run.js";

const smokeSource = readFileSync(new URL("./fixtures/smoke-worker.mjs", import.meta.url), "utf8");

describe("local dev smoke", () => {
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
});
