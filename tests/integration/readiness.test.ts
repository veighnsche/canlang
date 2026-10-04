import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startLocalDev } from "@canlang/cloudflare";
import { createReport } from "@canlang/testkit";

const repoRoot = new URL("../..", import.meta.url);
const path = (relative: string): URL => new URL(relative, repoRoot);

/** The 12 contract boundaries the assembly must join (PLAN tree). */
const boundaryModules = [
  "artifact",
  "deployment",
  "diagnostic",
  "examples",
  "files",
  "identity",
  "presentation",
  "services",
  "state",
  "values",
  "wire",
  "work",
];

describe("integration readiness", () => {
  it("boots local workerd and builds a machine-readable report", async () => {
    const dev = await startLocalDev({
      workerName: "readiness",
      // Within miniflare v4 workerd's supported range (newest: 2026-08-06).
      compatibilityDate: "2026-07-15",
      mainModule: "worker.mjs",
      modules: {
        "worker.mjs": `export default { async fetch() { return Response.json({ ready: true }); } }`,
      },
    });
    try {
      const response = await dev.dispatch("/ping");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ready: true });
    } finally {
      await dev.dispose();
    }

    const built = createReport({ digest: "readiness", sourceRevision: "readiness" }).build();
    expect(built.summary).toEqual({ total: 0, passed: 0, failed: 0, setupFailed: 0, unsupported: 0 });
  }, 120000);

  it("finds every contract boundary the assembly joins", () => {
    const missing = boundaryModules.filter(
      (module) => !existsSync(path(`packages/contracts/src/${module}.ts`)),
    );
    expect(missing).toEqual([]);
  });

  it("prints producer package presence (informational)", () => {
    const packages = [
      "contracts",
      "cloudflare",
      "testkit",
      "state",
      "values",
      "identity",
      "interfaces",
      "work",
      "services",
      "files",
      "ui",
    ];
    const table = packages.map((name) => ({
      package: `@canlang/${name}`,
      present: existsSync(path(`packages/${name}/package.json`)),
    }));
    console.log(`producer presence: ${JSON.stringify(table)}`);
    expect(table.length).toBe(packages.length);
  });
});
