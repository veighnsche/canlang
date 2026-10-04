/**
 * Shared Playwright fixtures: one L7 workerd instance + http bridge per
 * Playwright worker, D1 schema applied once per worker.
 *
 * Isolation model: the worker (and its D1) is per Playwright *worker*
 * process, NOT per spec file — spec files sharing a worker share D1 rows.
 * Each spec file seeds exactly the rows it asserts (see `seed.ts`) and must
 * tolerate rows seeded by other files in the same worker (assert presence
 * of own rows, never exact table counts across files). Per-file isolation
 * (one worker per app) is a Phase 3 decision; the scaffold has one file.
 *
 * All fixtures drive producers only through owned surfaces: `startLocalDev`
 * (L7), the e2e bridge, and the artifact loader. Missing producer dists
 * fail loud from the loader — never skipped, never stubbed.
 */
import { test as base } from "@playwright/test";
import { startLocalDev, type LocalDev } from "@canlang/cloudflare";
import { startBridge, type HttpBridge } from "../bridges/http-bridge.js";
import { loadArtifact, type WorkerAssembly } from "./artifact-loader.js";
import { ensureTodoSchema } from "./seed.js";

export interface E2EWorkerFixtures {
  /** Loaded once per worker; label asserted by every spec file. */
  readonly assembly: WorkerAssembly;
  /** L7 workerd instance with D1 schema applied. */
  readonly dev: LocalDev;
  /** Localhost bridge over `dev`. */
  readonly bridge: HttpBridge;
}

export function d1Binding(assembly: WorkerAssembly): string {
  const first = assembly.d1Databases[0];
  if (first === undefined) throw new Error("e2e fixtures: assembly has no D1 database");
  return first.binding;
}

export const test = base.extend<object, E2EWorkerFixtures>({
  assembly: [
    async ({}, use) => {
      await use(loadArtifact({ kind: "handbuilt", app: "teamtasks" }));
    },
    { scope: "worker" },
  ],
  dev: [
    async ({ assembly }, use) => {
      const dev = await startLocalDev({
        workerName: assembly.workerName,
        compatibilityDate: assembly.compatibilityDate,
        mainModule: assembly.mainModule,
        modules: assembly.modules,
        d1Databases: [...assembly.d1Databases],
      });
      try {
        await ensureTodoSchema(dev, d1Binding(assembly));
        await use(dev);
      } finally {
        await dev.dispose();
      }
    },
    { scope: "worker" },
  ],
  bridge: [
    async ({ dev }, use) => {
      const bridge = await startBridge(dev);
      try {
        await use(bridge);
      } finally {
        await bridge.close();
      }
    },
    { scope: "worker" },
  ],
});
