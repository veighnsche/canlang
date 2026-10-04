import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runTable } from "../src/runner/table.js";
import { createLocalRowScope } from "../src/scopes/local.js";

const scopeSource = readFileSync(new URL("./fixtures/scope-worker.mjs", import.meta.url), "utf8");

const scopeOptions = {
  workerName: "isolation",
  // Within miniflare v4 workerd's supported range (newest: 2026-08-06).
  compatibilityDate: "2026-07-15",
  mainModule: "worker.mjs",
  modules: { "worker.mjs": scopeSource },
  d1Binding: "DB",
};

describe("row isolation over real workerd + D1", () => {
  it("keeps row 0 writes invisible to row 1", async () => {
    const result = await runTable({
      operation: "isolation.probe",
      createScope: async (rowIndex) => createLocalRowScope(`isolation-row-${rowIndex}`, scopeOptions),
      rows: [
        {
          rowIndex: 0,
          caller: { kind: "self" },
          seed: [],
          setup: async () => {},
          invoke: async (scope) => {
            const written = await scope.dev.dispatch("/write?k=marker&v=row-0");
            return written.status === 200 ? { ok: true } : { ok: false, error: "setup-write-failed" };
          },
          expected: { values: ["row-0"], observations: ["marker"] },
          observe: async (scope) => {
            const response = await scope.dev.dispatch("/read?k=marker");
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
            const response = await scope.dev.dispatch("/read?k=marker");
            const body = (await response.json()) as { v: string | null };
            return [body.v];
          },
        },
      ],
    });
    expect(result.rows.map((row) => row.outcome)).toEqual(["passed", "passed"]);
  }, 120000);
});
