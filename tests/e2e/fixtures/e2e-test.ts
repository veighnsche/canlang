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
import type { StoragePort } from "@canlang/contracts";
import { startBridge, type HttpBridge } from "../bridges/http-bridge.js";
import {
  disposeCompiledAssembly,
  E2E_COMPATIBILITY_DATE,
  loadArtifact,
  loadCompiledArtifact,
  type CompiledAssembly,
  type WorkerAssembly,
} from "./artifact-loader.js";
import { ensureTodoSchema } from "./seed.js";

export interface E2EWorkerFixtures {
  /** Loaded once per worker; label asserted by every spec file. */
  readonly assembly: WorkerAssembly;
  /** L7 workerd instance with D1 schema applied. */
  readonly dev: LocalDev;
  /** Localhost bridge over `dev`. */
  readonly bridge: HttpBridge;
}

function d1Binding(assembly: WorkerAssembly): string {
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

/* ------------------------------------------------------------------ */
/* T21 compiled fixtures: one real toolchain compile + one real D1     */
/* island per Playwright worker. Journeys invoke emitted callables     */
/* through the canonical invoker against REAL miniflare D1 — memory   */
/* doubles never satisfy these fixtures.                               */
/*                                                                     */
/* Isolation model: same as above — the island D1 is per Playwright    */
/* *worker* process, shared across spec files using `compiledTest`.    */
/* Journey rows use unique ids per test; assert presence of own rows,  */
/* never exact table counts across files.                              */
/* ------------------------------------------------------------------ */

/** Fixture `.can` compiled by the T21 journeys (repo-relative). */
export const COMPILED_JOURNEY_SOURCE = "tests/e2e/fixtures/compiled-shop.can";

const STATE_DIST_BUILD_COMMAND = "bun run build";

async function stateD1(): Promise<typeof import("../../../packages/state/dist/state/src/storage/d1.js")> {
  try {
    return await import("../../../packages/state/dist/state/src/storage/d1.js");
  } catch {
    throw new Error(
      `e2e fixtures: packages/state/dist is not built; run \`${STATE_DIST_BUILD_COMMAND}\` first`,
    );
  }
}

export interface CompiledD1Island {
  /**
   * `startLocalDev` vehicle that owns the island's REAL miniflare D1.
   * The stub worker only boots the instance (`dispatch` is unused);
   * journeys reach storage through `store`.
   */
  readonly dev: LocalDev;
  /** Canonical D1-backed `StoragePort` over the island D1. */
  readonly store: StoragePort;
  /**
   * A FRESH storage handle over the same D1 (never the writer's
   * handle): cross-handle read-back is the persist-channel proof.
   */
  readonly freshStore: () => StoragePort;
  readonly binding: string;
}

export interface CompiledWorkerFixtures {
  /** Compiled once per worker; label asserted by every compiled spec. */
  readonly compiled: CompiledAssembly;
  /** Real-D1 island with the canonical schema applied. */
  readonly island: CompiledD1Island;
}

const COMPILED_ISLAND_BINDING = "DB";

export const compiledTest = base.extend<object, CompiledWorkerFixtures>({
  compiled: [
    async ({}, use) => {
      const compiled = await loadCompiledArtifact({
        kind: "compiled",
        source: COMPILED_JOURNEY_SOURCE,
      });
      try {
        await use(compiled);
      } finally {
        disposeCompiledAssembly(compiled);
      }
    },
    { scope: "worker" },
  ],
  island: [
    async ({}, use) => {
      const { createD1Storage, ensureSchema } = await stateD1();
      const dev = await startLocalDev({
        workerName: "t21-compiled-island",
        compatibilityDate: E2E_COMPATIBILITY_DATE,
        mainModule: "vehicle.mjs",
        modules: {
          "vehicle.mjs": "export default { fetch() { return new Response(\"t21-d1-vehicle\"); } };\n",
        },
        d1Databases: [{ binding: COMPILED_ISLAND_BINDING, id: "t21-compiled-island" }],
      });
      try {
        const db = await dev.getD1Database(COMPILED_ISLAND_BINDING);
        await ensureSchema(db);
        const freshStore = (): StoragePort => createD1Storage(db);
        await use({
          dev,
          store: createD1Storage(db),
          freshStore,
          binding: COMPILED_ISLAND_BINDING,
        });
      } finally {
        await dev.dispose();
      }
    },
    { scope: "worker" },
  ],
});
