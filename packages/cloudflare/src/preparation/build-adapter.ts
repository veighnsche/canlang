/**
 * The two real host phases remain independently callable. Drivers sequence
 * them at the existing stage-contract positions; bundle.ts owns their builds.
 */
import {
  buildHttpOperationsBundle,
  buildMcpBundle,
  describeAuthoredMaps,
  type AuthoredMapDescription,
} from "../deploy/bundle.js";

export {
  buildDeployBundle as buildBundleWithHostPhases,
  buildDerivedInputsModule as runCatalogPhase,
  describeAuthoredMaps,
  scanModuleFacts,
  type AuthoredMapDescription,
  type ModuleImportFact,
  type ModuleSyntaxFacts,
  type ModuleUnresolvedFact,
} from "../deploy/bundle.js";
import { scanModuleFacts } from "../deploy/bundle.js";
import { readFileSync } from "node:fs";
import {
  buildBinariesPayload,
  buildLoadModulesPayload,
  buildPreviousPlanPayload,
  encodeAdmittedTree,
  type StagedModuleBuffer,
  type TaggedNode,
} from "./inputs.js";

/**
 * Asset-carrying bundle build sequenced by the preparation host deploy
 * path. It runs the same two phases exactly once, in stage-contract
 * order, inside the owning bundle boundary (worker-main resolution
 * refuses before either esbuild phase; catalog derivation follows the
 * verdict-bearing artifact render; workerd-loadability precedes link
 * resolution).
 */
export { buildDeployBundleWithAssets as buildBundleWithHostPhasesAndAssets } from "../deploy/bundle.js";

/**
 * Serve actual staged bundle buffers to the native LOAD_MODULES
 * stage: the owning bundle's module map (`key -> js`) becomes the
 * `{modules: [{key, js}]}` admitted-tree resume via the shared
 * encoder. Bundle insertion order is preserved; the native
 * import/graph gates (not the host) refuse unloadable bundles.
 */
export function loadModulesResumeForModules(modules: Readonly<Record<string, string>>): {
  readonly modules: ReturnType<typeof buildLoadModulesPayload>["modules"];
} {
  const buffers: StagedModuleBuffer[] = Object.keys(modules).map((key) => ({
    key,
    js: modules[key] as string,
  }));
  return buildLoadModulesPayload(buffers);
}

/**
 * Serve staged bundle buffers WITH owner syntax facts to the native
 * LOAD_MODULES stage (025): each module carries its key, exact JS
 * bytes, and the single host frontend's `scanModuleFacts` over those
 * bytes (import lexer records, Acorn 2025 scope facts, parser-error
 * offsets). The native side validates shape, unit-coordinate bounds
 * and per-module correspondence, then applies stage/module
 * key/graph/link and diagnostic policy itself. Bundle insertion
 * order is preserved. No wrapper exemptions: the owner frontend
 * already resolves bound interop through real scope analysis.
 */
export function loadModulesResumeWithFacts(
  modules: Readonly<Record<string, string>>,
  binaryKeys: readonly string[] = [],
): {
  readonly modules: ReturnType<typeof buildLoadModulesPayload>["modules"];
  readonly binaries: ReturnType<typeof buildBinariesPayload>["binaries"];
} {
  return {
    ...buildLoadModulesPayload(
      Object.keys(modules).map((key) => {
        const js = modules[key] as string;
        return { key, js, facts: scanModuleFacts(js, key) };
      }),
    ),
    ...buildBinariesPayload(binaryKeys),
  };
}

/**
 * Serve the host-composed authored maps for native construction
 * (RUST-PREPARATION-010): `{authoredMaps: [{path, mapJson, stages}]}`
 * as one admitted tree, the exact shape the native `authored_maps`
 * gate decodes. Served only when the real bundle built (legacy-main
 * fallback keeps the finished-map gates with no digest).
 */
export function buildAuthoredMapsPayload(
  descriptions: ReadonlyArray<AuthoredMapDescription>,
): {
  readonly authoredMaps: TaggedNode;
} {
  return {
    authoredMaps: encodeAdmittedTree(
      descriptions.map((entry) => ({
        path: entry.path,
        mapJson: entry.mapJson,
        stages: entry.stages,
      })),
    ),
  };
}

/**
 * Serve the actual previous-plan sidecar to the native
 * LOAD_PREVIOUS_PLAN stage, mirroring `loadPreviousPlan`
 * classification exactly: absent file rides literal null (first
 * deploy); a present sidecar rides its parsed JSON (present null
 * rides the tagged null tree, refused natively as not-a-DeployPlan).
 * Unparsable JSON and unreadable (non-ENOENT) files throw in the
 * oracle voice; the P07 onNeed maps them to the
 * invalid-deploy-bundle CLI failure. Nothing is read before the
 * native PLAN stage succeeds — the caller serves this only on the
 * LOAD_PREVIOUS_PLAN need.
 */
export function previousPlanResumeForPath(planPath: string): {
  readonly previous: TaggedNode | null;
} {
  let text: string;
  try {
    text = readFileSync(planPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return { previous: null };
    }
    throw new Error(
      `deploy review: cannot read previous plan ${planPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `deploy review: previous plan ${planPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return buildPreviousPlanPayload(parsed);
}

/** The two real host phases, in job order. */
export interface HostBuildPhases {
  readonly mcpBun: "explicit-adapter-phase";
  readonly catalog: "explicit-adapter-phase";
}

export const CURRENT_HOST_PHASES: HostBuildPhases = {
  mcpBun: "explicit-adapter-phase",
  catalog: "explicit-adapter-phase",
};

/** MCP/Bun phase: MCP first, then HTTP; drivers control stage ordering. */
export function runMcpBunPhase(_repoRoot?: string): {
  mcpHandlerJs: string;
  httpOperationsJs: string;
} {
  return {
    mcpHandlerJs: buildMcpBundle(),
    httpOperationsJs: buildHttpOperationsBundle(),
  };
}
