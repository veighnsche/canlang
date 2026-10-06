/**
 * Host build adapter (P02.2): the seam where the prepared job invokes
 * bundle construction. P02.2 delegates to the existing public
 * `buildDeployBundle` boundary unchanged; P05.2 splits the two real
 * host phases (Bun MCP/HTTP bundling, owning catalog derivation) behind
 * this interface and submits the bundle-internal changes to
 * `C04.preparation-join`. No behavior change in this task.
 */
import {
  buildDeployBundle,
  type BuildDeployBundleOptions,
  type DeployBundle,
} from "../deploy/bundle.js";
import type { CompileArtifact } from "@canlang/contracts";

/**
 * The two real host phases, in job order. P02.2 runs both implicitly
 * inside `buildDeployBundle`; P05.2 invokes each explicitly once at
 * its current position (MCP/Bun before artifact render, catalog after).
 */
export interface HostBuildPhases {
  readonly mcpBun: "implicit-in-buildDeployBundle";
  readonly catalog: "implicit-in-buildDeployBundle";
}

export const CURRENT_HOST_PHASES: HostBuildPhases = {
  mcpBun: "implicit-in-buildDeployBundle",
  catalog: "implicit-in-buildDeployBundle",
};

/** P02.2: unchanged delegation through the public bundle boundary. */
export function buildBundleWithHostPhases(
  artifact: CompileArtifact,
  options: BuildDeployBundleOptions,
): DeployBundle {
  return buildDeployBundle(artifact, options);
}
