/**
 * The two real host phases remain independently callable. Drivers sequence
 * them at the existing stage-contract positions; bundle.ts owns their builds.
 */
import {
  buildHttpOperationsBundle,
  buildMcpBundle,
} from "../deploy/bundle.js";

export {
  buildDeployBundle as buildBundleWithHostPhases,
  buildDerivedInputsModule as runCatalogPhase,
} from "../deploy/bundle.js";

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
