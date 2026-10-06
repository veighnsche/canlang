/**
 * Host build adapter (P05.2): the two real host phases as distinct
 * callable units plus unchanged delegation through the public bundle
 * boundary.
 *
 * `runMcpBunPhase` (MCP_BUN_REQUEST) bundles the MCP handler and HTTP
 * operations chains with real `bun build` subprocesses;
 * `runCatalogPhase` (CATALOG_REQUEST) runs the owning
 * `catalogFromArtifactOperations` derivation and bakes
 * `derived-inputs.js`. Both mirror `deploy/bundle.ts` byte-for-byte
 * (differentially pinned in `preparation-protocol.test.ts`); the
 * bundle-internal copies stay the TS route's until
 * `C04.preparation-join` accepts the export proposal in
 * `bundle-join-request.json`, when P05.3 switches this module to the
 * single implementations. Activation and the catalog producer are
 * imported unchanged, never reimplemented.
 *
 * Order contract for drivers (native P05.4 job script included):
 * worker probe first (the legacy worker-missing path invokes NEITHER
 * phase), vendor outputs before Bun, verdict render before catalog,
 * loadability before links. These phases never self-order: the
 * caller sequences them at their stage-contract positions.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveProducerFile } from "../deploy/producer-files.js";
import { join, posix, sep } from "node:path";
import {
  HTTP_BUNDLE_MARKERS,
  MCP_BUNDLE_MARKERS,
  buildDeployBundle,
  type BuildDeployBundleOptions,
  type DeployBundle,
} from "../deploy/bundle.js";
import type { CompileArtifact, DerivedOperationInputs } from "@canlang/contracts";
import { catalogFromArtifactOperations } from "@canlang/interfaces";

/**
 * The two real host phases, in job order. P05.2 runs each explicitly
 * here (and implicitly inside `buildDeployBundle` for the TS route
 * until the preparation join lands the shared exports).
 */
export interface HostBuildPhases {
  readonly mcpBun: "explicit-adapter-phase";
  readonly catalog: "explicit-adapter-phase";
}

export const CURRENT_HOST_PHASES: HostBuildPhases = {
  mcpBun: "explicit-adapter-phase",
  catalog: "explicit-adapter-phase",
};

/** Real-producer dist the MCP bundle is byte-built from (never stubbed). */
const INTERFACES_MCP_SERVER_DIST = "@canlang/interfaces/mcp/server";
/** Real-producer dist the HTTP operations bundle is byte-built from (never stubbed). */
const INTERFACES_HTTP_OPERATIONS_DIST = "@canlang/interfaces/http/operations";
const MCP_REGISTRY_DIST = "@canlang/cloudflare/runtime/mcp-registry";

function buildMcpBundle(): string {
  const serverDist = resolveProducerFile(
    INTERFACES_MCP_SERVER_DIST,
    "bun run --filter @canlang/interfaces build",
  );
  const registryDist = resolveProducerFile(
    MCP_REGISTRY_DIST,
    "bun run --filter @canlang/cloudflare build",
  );
  const workDir = mkdtempSync(join(tmpdir(), "can-deploy-mcp-"));
  const entryFile = join(workDir, "mcp-bundle-entry.js");
  const outFile = join(workDir, "mcp-bundle.mjs");
  const toPosixAbsolute = (path: string): string => path.split(sep).join(posix.sep);
  // `createHandler` is the main's join-contract name for the real
  // `createMcpHandler` (identical `McpHandlerFactory` shape: `(deps) =>
  // (request) => Response`) — one alias, same function, no wrapper.
  writeFileSync(
    entryFile,
    `export { createMcpHandler, createMcpHandler as createHandler } from ${JSON.stringify(toPosixAbsolute(serverDist))};\n` +
      `export { createArtifactCatalog, createArtifactRegistry } from ${JSON.stringify(toPosixAbsolute(registryDist))};\n`,
    "utf8",
  );
  try {
    execFileSync(
      "bun",
      ["build", entryFile, "--format=esm", "--target=browser", `--outfile=${outFile}`],
      { stdio: "pipe" },
    );
  } catch (err) {
    rmSync(workDir, { force: true, recursive: true });
    const detail = err instanceof Error ? err.message : String(err);
    if (detail.includes("ENOENT")) {
      throw new Error(
        "deploy bundle: `bun` is not on PATH, needed to bundle the MCP handler chain; " +
          "install bun (https://bun.sh) or deploy via `bun run`",
      );
    }
    throw new Error(
      "deploy bundle: MCP bundle build failed (`bun build` on the generated entry); " +
        "the MCP SDK must resolve (run `bun install`) and both producer dists must be built. " +
        `Underlying error: ${detail}`,
    );
  }
  let contents: string;
  try {
    contents = readFileSync(outFile, "utf8");
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
  for (const marker of MCP_BUNDLE_MARKERS) {
    if (!contents.includes(marker)) {
      throw new Error(
        `deploy bundle: MCP bundle build dropped ${marker}; refusing a skewed bundle ` +
          "(rebuild the producer dists and retry)",
      );
    }
  }
  return contents;
}

function buildHttpOperationsBundle(): string {
  const operationsDist = resolveProducerFile(
    INTERFACES_HTTP_OPERATIONS_DIST,
    "bun run --filter @canlang/interfaces build",
  );
  const workDir = mkdtempSync(join(tmpdir(), "can-deploy-http-"));
  const entryFile = join(workDir, "http-bundle-entry.js");
  const outFile = join(workDir, "http-bundle.mjs");
  const toPosixAbsolute = (path: string): string => path.split(sep).join(posix.sep);
  writeFileSync(
    entryFile,
    `export { handleOperationRequest } from ${JSON.stringify(toPosixAbsolute(operationsDist))};\n`,
    "utf8",
  );
  try {
    execFileSync(
      "bun",
      ["build", entryFile, "--format=esm", "--target=browser", `--outfile=${outFile}`],
      { stdio: "pipe" },
    );
  } catch (err) {
    rmSync(workDir, { force: true, recursive: true });
    const detail = err instanceof Error ? err.message : String(err);
    if (detail.includes("ENOENT")) {
      throw new Error(
        "deploy bundle: `bun` is not on PATH, needed to bundle the HTTP operations chain; " +
          "install bun (https://bun.sh) or deploy via `bun run`",
      );
    }
    throw new Error(
      "deploy bundle: HTTP bundle build failed (`bun build` on the generated entry); " +
        `the interfaces dist must be built. Underlying error: ${detail}`,
    );
  }
  let contents: string;
  try {
    contents = readFileSync(outFile, "utf8");
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
  for (const marker of HTTP_BUNDLE_MARKERS) {
    if (!contents.includes(marker)) {
      throw new Error(
        `deploy bundle: HTTP bundle build dropped ${marker}; refusing a skewed bundle ` +
          "(rebuild the producer dists and retry)",
      );
    }
  }
  return contents;
}

/**
 * MCP/Bun host phase (MCP_BUN_REQUEST): one phase producing BOTH
 * `mcp-handler.js` and `http-operations.js` (two Bun invocations).
 * Runs at its stage-contract position: after vendor outputs are
 * staged, before artifact.js render. Never runs on the legacy
 * worker-missing path (the worker probe throws first).
 */
export function runMcpBunPhase(_repoRoot?: string): {
  mcpHandlerJs: string;
  httpOperationsJs: string;
} {
  return {
    mcpHandlerJs: buildMcpBundle(),
    httpOperationsJs: buildHttpOperationsBundle(),
  };
}

/**
 * Catalog host phase (CATALOG_REQUEST): the REAL interfaces
 * derivation for the artifact's operations, baked to data. Single
 * call per job at its stage-contract position: after artifact.js
 * render. The legacy worker-missing path makes NO catalog call.
 * Catalog-producer errors propagate unchanged (never wrapped).
 */
export function runCatalogPhase(artifact: CompileArtifact): string {
  const catalog = catalogFromArtifactOperations(artifact);
  const baked: Record<string, DerivedOperationInputs> = {};
  for (const op of artifact.operations ?? []) {
    const derived = catalog.derivedFor(op.name);
    if (derived === null) {
      throw new Error(
        `deploy bundle: derived bake produced no inputs for operation ${JSON.stringify(op.name)} ` +
          "(derivation skew)",
      );
    }
    baked[op.name] = derived;
  }
  return `export const derivedInputs = ${JSON.stringify(baked)};\n`;
}

/**
 * P05.2: unchanged delegation through the public bundle boundary.
 * The explicit phases above serve the native job (P05.3/P05.4); the
 * TS route keeps one implementation until the preparation join.
 */
export function buildBundleWithHostPhases(
  artifact: CompileArtifact,
  options: BuildDeployBundleOptions,
): DeployBundle {
  return buildDeployBundle(artifact, options);
}
