/**
 * B5-J3 zero-config local defaults: `can run` / `can test` with zero
 * flags on a compiled artifact.
 *
 * `resolveLocalDefaults` fills the inputs `startLocalDev` requires but
 * the user should not have to repeat: artifact discovery
 * (`./dist/*.artifact.json`, exactly one or loud), the pinned
 * compatibility date, and the worker name derived from the artifact
 * file stem. An explicit `--artifact` path always wins over discovery.
 *
 * `assertDistReady` is the on-demand dist check: the assembler needs the
 * prebuilt UI entry, so the CLI runs this BEFORE staging modules and
 * fails loud naming the exact build command (reusing the assembler's
 * own constants — one vocabulary, no drift).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { loadArtifactFile } from "../runtime/artifact.js";
import { UI_BUILD_COMMAND, UI_DIST_ENTRY_RELATIVE } from "../runtime/modules.js";

/**
 * Pinned wrangler `compatibility_date` for zero-config local runs.
 * Newest date the vendored workerd binary accepts (verified by boot;
 * newer dates fail with "requires compatibility date ... but the newest
 * date supported by this server binary is ...").
 */
export const PINNED_COMPATIBILITY_DATE = "2026-07-15";

/** Discovery pattern, relative to the caller's cwd. */
export const ARTIFACT_DISCOVERY_PATTERN = "./dist/*.artifact.json";

export interface LocalDefaults {
  artifactPath: string;
  workerName: string;
  compatibilityDate: string;
}

export interface ResolveLocalDefaultsOptions {
  /** Explicit `--artifact` path; wins over discovery. */
  artifactPath?: string;
  /** Directory discovery scans (`dist/` beneath it). Defaults to `process.cwd()`. */
  cwd?: string;
}

function sanitizeWorkerName(stem: string): string {
  const cleaned = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    throw new Error(
      `zero-config: artifact stem ${JSON.stringify(stem)} yields an empty worker name`,
    );
  }
  return cleaned;
}

/**
 * Find the one `./dist/*.artifact.json` under `cwd`. Zero candidates
 * names the pattern + the compile step; several list every candidate +
 * `--artifact`. Never guesses.
 */
export function discoverArtifact(cwd: string): string {
  const dist = join(cwd, "dist");
  let names: string[] = [];
  try {
    names = readdirSync(dist).filter((name) => name.endsWith(".artifact.json")).sort();
  } catch {
    names = [];
  }
  if (names.length === 0) {
    throw new Error(
      `zero-config: no compiled artifact matches ${ARTIFACT_DISCOVERY_PATTERN} ` +
        `(run \`can compile\` first, or pass --artifact <path>)`,
    );
  }
  if (names.length > 1) {
    throw new Error(
      `zero-config: ${names.length} artifacts match ${ARTIFACT_DISCOVERY_PATTERN}:\n` +
        names.map((name) => `- ${join(dist, name)}`).join("\n") +
        `\npass --artifact <path> to pick one`,
    );
  }
  return join(dist, names[0] as string);
}

/**
 * Resolve local-run defaults: explicit path or discovery, artifact
 * validity (loud on malformed), worker name from the artifact stem,
 * pinned compatibility date.
 */
export function resolveLocalDefaults(options: ResolveLocalDefaultsOptions = {}): LocalDefaults {
  const cwd = options.cwd ?? process.cwd();
  const artifactPath = options.artifactPath ?? discoverArtifact(cwd);
  // Validity first: a default that points at garbage is worse than none.
  loadArtifactFile(artifactPath);
  const base = basename(artifactPath);
  const stem = base.endsWith(".artifact.json")
    ? base.slice(0, -".artifact.json".length)
    : base.replace(/\.json$/, "");
  return {
    artifactPath,
    workerName: sanitizeWorkerName(stem),
    compatibilityDate: PINNED_COMPATIBILITY_DATE,
  };
}

/**
 * On-demand dist check: the UI entry the assembler rewrites
 * `@canlang/ui` imports to must exist under `distRoot` (the repo
 * `packages/` dir). Throws loud naming the exact build command.
 */
export async function assertDistReady(distRoot: string): Promise<void> {
  const entry = join(distRoot, UI_DIST_ENTRY_RELATIVE);
  let isFile = false;
  try {
    isFile = existsSync(entry) && statSync(entry).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    throw new Error(
      `zero-config: UI dist entry missing at ${entry}; run \`${UI_BUILD_COMMAND}\` first`,
    );
  }
}
