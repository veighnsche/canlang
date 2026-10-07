/**
 * B1 module assembler: stage emitted artifact modules onto disk so a local
 * runtime can import them, rewriting bare producer imports to runnable URLs.
 *
 * Rewrites:
 * - `@canlang/stdlib` -> peer-provided `opts.stdlibUrl` (verbatim).
 * - `@canlang/ui` -> the installed package's exported entry (or the explicit
 *   `uiUrl` host/test injection). Missing builds fail with the producer command.
 * - Relative specifiers are left intact; modules are written to `workDir`
 *   preserving artifact-relative paths, so they resolve on disk naturally.
 *
 * Validation: every import specifier in every module must be one of the two
 * bare producer specifiers or a relative path resolving to another artifact
 * module. Anything else throws naming the module and the specifier.
 *
 * Host import records preserve original literal spans; derived maps account
 * for changed import lengths without changing the compiled artifact.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveProducerFile } from "../deploy/producer-files.js";
import type { CompileArtifact, SourceMap } from "@canlang/contracts";
import { rewriteModuleImports, validateArtifactModuleImports } from "../deploy/module-imports.js";
import { composeModuleMap } from "../deploy/module-maps.js";

/**
 * Structural mirror of the sibling packet's `LoadedArtifact`
 * (`./artifact.ts`, returned by `loadArtifactFile`):
 * `{ artifact: CompileArtifact; sourcePath: string }`.
 * Kept structural so this module stands alone before the sibling lands;
 * at integration the sibling type is directly assignable to this shape.
 */
export interface LoadedArtifactInput {
  readonly artifact: CompileArtifact;
  readonly sourcePath: string;
}

export interface AssembledModules {
  dir: string;
  entryUrl: string;
  moduleUrls: Record<string, string>;
  /**
   * B3 I2: staged source-map file URLs keyed by artifact module path
   * (sibling `<mod>.map` next to each staged `<mod>.js`). Optional so
   * hand-built assemblies (tests, worker paths without staged maps) stay
   * valid; `assembleModules` always populates it.
   */
  mapUrls?: Record<string, string>;
  /** Derived maps for staged coordinates; original artifact maps remain unchanged. */
  sourceMaps?: Record<string, SourceMap>;
}

export interface AssembleModulesOptions {
  /** Legacy project input; producer resolution uses package exports. */
  distRoot?: string;
  /** Explicit UI artifact for test/host injection; defaults to the installed package. */
  uiUrl?: string;
  /** Directory to stage rewritten modules under (created if missing). */
  workDir: string;
  /** Peer-provided runnable module URL for `@canlang/stdlib`. */
  stdlibUrl: string;
}

export const STDLIB_SPECIFIER = "@canlang/stdlib";
export const UI_SPECIFIER = "@canlang/ui";
export const UI_BUILD_COMMAND = "bun run --filter @canlang/ui build";
/** UI dist entry relative to `distRoot`, mirroring that package's `main`. */
export const UI_DIST_ENTRY_RELATIVE = join("ui", "dist", "src", "index.js");

function assertSafeRelativePath(path: string): void {
  const normalized = posix.normalize(path);
  if (path === "" || posix.isAbsolute(path) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`assembleModules: refusing to write module outside workDir: ${JSON.stringify(path)}`);
  }
}

export async function uiModuleUrl(uiUrl?: string): Promise<string> {
  const entry = new URL(uiUrl ?? pathToFileURL(resolveProducerFile(UI_SPECIFIER, UI_BUILD_COMMAND)).href);
  try {
    if (!(await stat(entry)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(
      `assembleModules: ${UI_SPECIFIER} dist entry missing at ${entry}; ` +
        `run \`${UI_BUILD_COMMAND}\` first`,
    );
  }
  return entry.href;
}

export async function assembleModules(
  loaded: LoadedArtifactInput,
  opts: AssembleModulesOptions,
): Promise<AssembledModules> {
  const modules = loaded.artifact.modules;
  if (modules.length === 0) {
    throw new Error(
      `assembleModules: artifact ${JSON.stringify(loaded.sourcePath)} has no modules; ` +
        `modules[0] must be the entrypoint`,
    );
  }
  const entry = modules[0]!;
  // Fail loud before writing anything: no partial workDir on bad input.
  const uiUrl = await uiModuleUrl(opts.uiUrl);
  validateArtifactModuleImports(modules, "assembleModules");
  for (const mod of modules) assertSafeRelativePath(mod.path);

  const dir = resolve(opts.workDir);
  await mkdir(dir, { recursive: true });
  const moduleUrls: Record<string, string> = {};
  const mapUrls: Record<string, string> = {};
  const sourceMaps: Record<string, SourceMap> = {};
  for (const mod of modules) {
    const outPath = join(dir, mod.path);
    await mkdir(dirname(outPath), { recursive: true });
    // Stage the derived view beside the rewritten module. Appending its
    // comment leaves every generated position unchanged.
    const mapName = `${posix.basename(mod.path)}.map`;
    const rewritten = rewriteModuleImports(mod.js, mod.path, (specifier) =>
      specifier === STDLIB_SPECIFIER ? opts.stdlibUrl : specifier === UI_SPECIFIER ? uiUrl : specifier,
      { prefix: "assembleModules" },
    );
    const view = composeModuleMap(mod.map, rewritten.map === undefined ? [] : [rewritten.map], mod.js);
    const stagedJs = view.map === undefined ? rewritten.js : withSourceMappingURL(rewritten.js, mapName);
    await writeFile(outPath, stagedJs, "utf8");
    moduleUrls[mod.path] = pathToFileURL(outPath).href;
    if (view.map !== undefined) {
      sourceMaps[mod.path] = view.map;
      const mapPath = join(dirname(outPath), mapName);
      await writeFile(mapPath, JSON.stringify(view.map), "utf8");
      mapUrls[mod.path] = pathToFileURL(mapPath).href;
    }
  }
  const entryUrl = moduleUrls[entry.path];
  if (entryUrl === undefined) throw new Error(`assembleModules: entry module missing: ${entry.path}`);
  return { dir, entryUrl, moduleUrls, mapUrls, sourceMaps };
}

/** Append a trailing `sourceMappingURL` comment without shifting earlier lines. */
function withSourceMappingURL(js: string, mapName: string): string {
  const comment = `//# sourceMappingURL=${mapName}\n`;
  return js.endsWith("\n") ? `${js}${comment}` : `${js}\n${comment}`;
}
