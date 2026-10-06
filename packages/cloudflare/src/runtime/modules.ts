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
 * Specifier scanning is a deliberate regex pass (static `from`, side-effect
 * `import`, dynamic `import()`), not a full parse: emitted modules are
 * machine-generated compiler output, not hand-written edge cases.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveProducerFile } from "../deploy/producer-files.js";
import type { ArtifactModule, CompileArtifact } from "@canlang/contracts";

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

const FROM_SPECIFIER_RE = /(\bfrom\s*['"])([^'"]+)(['"])/g;
const DYNAMIC_IMPORT_RE = /(\bimport\s*\(\s*['"])([^'"]+)(['"]\s*\))/g;
const SIDE_EFFECT_IMPORT_RE = /(\bimport\s*['"])([^'"]+)(['"])/g;

function isRelativeSpecifier(spec: string): boolean {
  return spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");
}

function collectSpecifiers(js: string): string[] {
  const specs: string[] = [];
  for (const re of [FROM_SPECIFIER_RE, DYNAMIC_IMPORT_RE, SIDE_EFFECT_IMPORT_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(js)) !== null) {
      const spec = match[2];
      if (spec !== undefined) specs.push(spec);
    }
  }
  return specs;
}

function rewriteImports(js: string, stdlibUrl: string, uiUrl: string): string {
  const mapped = (spec: string): string => {
    if (spec === STDLIB_SPECIFIER) return stdlibUrl;
    if (spec === UI_SPECIFIER) return uiUrl;
    return spec;
  };
  const swap = (_full: string, pre: string, spec: string, post: string): string =>
    `${pre}${mapped(spec)}${post}`;
  // Dynamic before side-effect: after `import("...")` is rewritten the
  // paren still blocks the side-effect pattern from double-matching.
  return js
    .replace(FROM_SPECIFIER_RE, swap)
    .replace(DYNAMIC_IMPORT_RE, swap)
    .replace(SIDE_EFFECT_IMPORT_RE, swap);
}

function validateImports(modules: readonly ArtifactModule[]): void {
  const known = new Set(modules.map((m) => m.path));
  for (const mod of modules) {
    for (const spec of collectSpecifiers(mod.js)) {
      if (spec === STDLIB_SPECIFIER || spec === UI_SPECIFIER) continue;
      if (isRelativeSpecifier(spec)) {
        const target = posix.normalize(posix.join(posix.dirname(mod.path), spec));
        if (!known.has(target)) {
          throw new Error(
            `assembleModules: module ${JSON.stringify(mod.path)} imports ` +
              `${JSON.stringify(spec)} (resolves to ${JSON.stringify(target)}): ` +
              `no such artifact module`,
          );
        }
        continue;
      }
      throw new Error(
        `assembleModules: module ${JSON.stringify(mod.path)} has unresolvable import ` +
          `${JSON.stringify(spec)} (only ${STDLIB_SPECIFIER}, ${UI_SPECIFIER}, ` +
          `and relative imports are supported)`,
      );
    }
  }
}

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
  validateImports(modules);
  for (const mod of modules) assertSafeRelativePath(mod.path);

  const dir = resolve(opts.workDir);
  await mkdir(dir, { recursive: true });
  const moduleUrls: Record<string, string> = {};
  const mapUrls: Record<string, string> = {};
  for (const mod of modules) {
    const outPath = join(dir, mod.path);
    await mkdir(dirname(outPath), { recursive: true });
    // B3 I2: stage the artifact map beside the module and point at it, so
    // plain Node can resolve staged frames. The comment is appended AFTER
    // the last emitted line, so generated line numbers (and the map) stay
    // valid.
    const mapName = `${posix.basename(mod.path)}.map`;
    const stagedJs = withSourceMappingURL(rewriteImports(mod.js, opts.stdlibUrl, uiUrl), mapName);
    await writeFile(outPath, stagedJs, "utf8");
    const mapPath = join(dirname(outPath), mapName);
    await writeFile(mapPath, JSON.stringify(mod.map), "utf8");
    moduleUrls[mod.path] = pathToFileURL(outPath).href;
    mapUrls[mod.path] = pathToFileURL(mapPath).href;
  }
  const entryUrl = moduleUrls[entry.path];
  if (entryUrl === undefined) throw new Error(`assembleModules: entry module missing: ${entry.path}`);
  return { dir, entryUrl, moduleUrls, mapUrls };
}

/** Append a trailing `sourceMappingURL` comment without shifting earlier lines. */
function withSourceMappingURL(js: string, mapName: string): string {
  const comment = `//# sourceMappingURL=${mapName}\n`;
  return js.endsWith("\n") ? `${js}${comment}` : `${js}\n${comment}`;
}
