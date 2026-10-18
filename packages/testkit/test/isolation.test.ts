import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { runTable } from "../src/runner/table.js";
import { snapshotLocalDatabases } from "../src/scopes/local.js";

const scopeSource = readFileSync(new URL("./fixtures/scope-worker.mjs", import.meta.url), "utf8");

const scopeOptions = {
  name: "isolation",
  // Within miniflare v4 workerd's supported range (newest: 2026-08-06).
  compatibilityDate: "2026-07-15",
  modules: true as const,
  script: scopeSource,
};

describe("row isolation over real workerd + D1", () => {
  it("keeps row 0 writes invisible to row 1", async () => {
    const result = await runTable({
      operation: "isolation.probe",
      createScope: async (rowIndex) => {
        // Test fixture allocation only; production row resources belong to Rust.
        const dev = new Miniflare({ ...scopeOptions,
          d1Databases: { DB: `isolation-row-${rowIndex}` },
        });
        return { dev, snapshot: () => snapshotLocalDatabases(dev, ["DB"]), dispose: () => dev.dispose() };
      },
      rows: [
        {
          rowIndex: 0,
          caller: { kind: "self" },
          seed: [],
          setup: async () => {},
          invoke: async (scope) => {
            const written = await scope.dev.dispatchFetch("http://fixture/write?k=marker&v=row-0");
            return written.status === 200 ? { ok: true } : { ok: false, error: "setup-write-failed" };
          },
          expected: { values: ["row-0"], observations: ["marker"] },
          observe: async (scope) => {
            const response = await scope.dev.dispatchFetch("http://fixture/read?k=marker");
            const body = (await response.json()) as { v: string | null };
            return [body.v];
          },
        },
        {
          rowIndex: 1,
          caller: { kind: "self" },
          seed: [],
          setup: async () => {},
          invoke: async () => ({ ok: true }),
          expected: { values: [null], observations: ["marker"] },
          observe: async (scope) => {
            const response = await scope.dev.dispatchFetch("http://fixture/read?k=marker");
            const body = (await response.json()) as { v: string | null };
            return [body.v];
          },
        },
      ],
    });
    expect(result.rows.map((row) => row.outcome)).toEqual(["passed", "passed"]);
  }, 120000);
});
