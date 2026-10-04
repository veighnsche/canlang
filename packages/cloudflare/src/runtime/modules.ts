/**
 * B1 module assembler: stage emitted artifact modules onto disk so a local
 * runtime can import them, rewriting bare producer imports to runnable URLs.
 *
 * Rewrites:
 * - `@canlang/stdlib` -> peer-provided `opts.stdlibUrl` (verbatim).
 * - `@canlang/ui` -> file URL of the built UI dist entry under `distRoot`
 *   (`<distRoot>/ui/dist/ui/src/index.js`, mirroring that package's
 *   `main`). A missing dist fails loud naming the build command, mirroring
 *   `tests/e2e/fixtures/artifact-loader.ts` readVendorTree — never stubbed.
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
}

export interface AssembleModulesOptions {
  /** Directory containing per-producer trees (`<distRoot>/ui/dist/...`). */
  distRoot: string;
  /** Directory to stage rewritten modules under (created if missing). */
  workDir: string;
  /** Peer-provided runnable module URL for `@canlang/stdlib`. */
  stdlibUrl: string;
}

export const STDLIB_SPECIFIER = "@canlang/stdlib";
export const UI_SPECIFIER = "@canlang/ui";
export const UI_BUILD_COMMAND = "bun run --filter @canlang/ui build";
/** UI dist entry relative to `distRoot`, mirroring that package's `main`. */
export const UI_DIST_ENTRY_RELATIVE = join("ui", "dist", "ui", "src", "index.js");

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

async function uiModuleUrl(distRoot: string): Promise<string> {
  const entry = join(distRoot, UI_DIST_ENTRY_RELATIVE);
  try {
    if (!(await stat(entry)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(
      `assembleModules: ${UI_SPECIFIER} dist entry missing at ${entry}; ` +
        `run \`${UI_BUILD_COMMAND}\` first`,
    );
  }
  return pathToFileURL(entry).href;
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
  const uiUrl = await uiModuleUrl(opts.distRoot);
  validateImports(modules);
  for (const mod of modules) assertSafeRelativePath(mod.path);

  const dir = resolve(opts.workDir);
  await mkdir(dir, { recursive: true });
  const moduleUrls: Record<string, string> = {};
  for (const mod of modules) {
    const outPath = join(dir, mod.path);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, rewriteImports(mod.js, opts.stdlibUrl, uiUrl), "utf8");
    moduleUrls[mod.path] = pathToFileURL(outPath).href;
  }
  const entryUrl = moduleUrls[entry.path];
  if (entryUrl === undefined) throw new Error(`assembleModules: entry module missing: ${entry.path}`);
  return { dir, entryUrl, moduleUrls };
}
