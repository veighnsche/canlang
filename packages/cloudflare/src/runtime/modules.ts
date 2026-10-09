/**
 * B1 module assembler: stage emitted artifact modules onto disk so a local
 * runtime can import them, rewriting bare producer imports to runnable URLs.
 *
 * Rewrites:
 * - `@canlang/stdlib` -> peer-provided `opts.stdlibUrl` (verbatim).
 * - `@canlang/ui` -> the installed package's exported entry (or the explicit
 *   `uiUrl` host/test injection). Missing builds fail with the producer command.
 * - Relative specifiers are left intact; modules are written in a private,
 *   content-versioned child of `workDir`, preserving artifact-relative paths.
 *
 * Validation: every import specifier in every module must be one of the two
 * bare producer specifiers or a relative path resolving to another artifact
 * module. Anything else throws naming the module and the specifier.
 *
 * Host import records preserve original literal spans; derived maps account
 * for changed import lengths without changing the compiled artifact.
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveProducerFile } from "../deploy/producer-files.js";
import type { CompileArtifact, SourceMap } from "@canlang/contracts";
import { rewriteModuleImports, validateArtifactModuleImports } from "../deploy/module-imports.js";
import { composeModuleMap } from "../deploy/module-maps.js";
import { registerAssemblerModuleCapability } from "./assembly-verification.js";
export { importVerifiedAssemblyModule } from "./assembly-verification.js";

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
  /** Actual private versioned staging directory beneath the requested workDir. */
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

interface StagedModule {
  path: string;
  file: string;
  url: string;
  bytes: Buffer;
}

interface AssemblySnapshot {
  artifactJson: string;
  dir: string;
  entryUrl: string;
  moduleUrls: Record<string, string>;
  mapUrls: Record<string, string>;
  modules: StagedModule[];
  maps: StagedModule[];
  directories: string[];
}

async function privateStagedPath(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if ((directory ? !info.isDirectory() : !info.isFile()) ||
      (process.getuid !== undefined && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0 || await realpath(path) !== path) {
    throw new Error("importVerifiedAssemblyModule: staged path is not a private regular owned path");
  }
}

async function stageFile(file: string, bytes: Buffer): Promise<void> {
  await privateStagedPath(dirname(file), true);
  // Exclusive creation never follows an existing symlink or overwrites a live namespace.
  try { await writeFile(file, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await privateStagedPath(file, false);
    if (!(await readFile(file)).equals(bytes)) {
      throw new Error("assembleModules: existing staged file bytes changed");
    }
  }
}

async function stageParents(dir: string, file: string, directories: Set<string>): Promise<void> {
  const components = posix.relative(dir, dirname(file)).split("/").filter(Boolean);
  let current = dir;
  for (const component of components) {
    current = join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await privateStagedPath(current, true);
    directories.add(current);
  }
}

async function verifyAssembly(asm: AssembledModules, snapshot: AssemblySnapshot, expectedArtifact?: CompileArtifact): Promise<void> {
  if (expectedArtifact !== undefined && JSON.stringify(expectedArtifact) !== snapshot.artifactJson) {
    throw new Error("importVerifiedAssemblyModule: artifact differs from assembled source");
  }
  if (asm.dir !== snapshot.dir || asm.entryUrl !== snapshot.entryUrl ||
      asm.moduleUrls !== snapshot.moduleUrls || asm.mapUrls !== snapshot.mapUrls ||
      Object.keys(asm.moduleUrls).length !== snapshot.modules.length ||
      Object.keys(snapshot.mapUrls).length !== snapshot.maps.length) {
    throw new Error("importVerifiedAssemblyModule: assembly identity or URL map changed");
  }
  for (const directory of snapshot.directories) await privateStagedPath(directory, true);
  // Sibling imports can determine exported callbacks, so qualify the entire closure.
  for (const module of [...snapshot.modules, ...snapshot.maps]) {
    const urls = snapshot.modules.includes(module) ? asm.moduleUrls : snapshot.mapUrls;
    if (!Object.hasOwn(urls, module.path) || urls[module.path] !== module.url) {
      throw new Error("importVerifiedAssemblyModule: module URL changed");
    }
    await privateStagedPath(module.file, false);
    if (!(await readFile(module.file)).equals(module.bytes)) {
      throw new Error("importVerifiedAssemblyModule: staged module bytes changed");
    }
  }
}

export interface AssembleModulesOptions {
  /** Legacy project input; producer resolution uses package exports. */
  distRoot?: string;
  /** Explicit UI artifact for test/host injection; defaults to the installed package. */
  uiUrl?: string;
  /** Parent of the private content-versioned staging directory (created if missing). */
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
  const artifactJson = JSON.stringify(loaded.artifact);
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
  const paths = new Set<string>();
  for (const mod of modules) {
    assertSafeRelativePath(mod.path);
    const path = posix.normalize(mod.path);
    if (paths.has(path)) throw new Error("assembleModules: duplicate staged module path");
    paths.add(path);
  }
  const staged = modules.map(mod => {
    // Stage the derived view beside the rewritten module. Appending its
    // comment leaves every generated position unchanged.
    const mapName = `${posix.basename(mod.path)}.map`;
    const rewritten = rewriteModuleImports(mod.js, mod.path, (specifier) =>
      specifier === STDLIB_SPECIFIER ? opts.stdlibUrl : specifier === UI_SPECIFIER ? uiUrl : specifier,
      { prefix: "assembleModules" },
    );
    const view = composeModuleMap(mod.map, rewritten.map === undefined ? [] : [rewritten.map], mod.js);
    const stagedJs = view.map === undefined ? rewritten.js : withSourceMappingURL(rewritten.js, mapName);
    const mapBytes = view.map === undefined ? undefined : Buffer.from(JSON.stringify(view.map), "utf8");
    return { mod, mapName, view, bytes: Buffer.from(stagedJs, "utf8"), mapBytes };
  });
  // Version the complete JS/map closure, including import rewrites and map provenance.
  // Relative imports inherit this directory without specifier edits or stale cache URLs.
  const hash = createHash("sha256");
  for (const module of [...staged].sort((a, b) => a.mod.path < b.mod.path ? -1 : a.mod.path > b.mod.path ? 1 : 0)) {
    hash.update(JSON.stringify([module.mod.path, module.bytes.length, module.mapBytes?.length ?? null]));
    hash.update(module.bytes);
    if (module.mapBytes !== undefined) {
      const path = posix.normalize(posix.join(posix.dirname(module.mod.path), module.mapName));
      if (paths.has(path)) throw new Error("assembleModules: duplicate staged module or map path");
      paths.add(path);
      hash.update(module.mapBytes);
    }
  }
  await mkdir(resolve(opts.workDir), { recursive: true });
  const dir = join(await realpath(resolve(opts.workDir)), `assembly-${hash.digest("hex")}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await privateStagedPath(dir, true);
  const moduleUrls: Record<string, string> = Object.create(null) as Record<string, string>;
  const mapUrls: Record<string, string> = Object.create(null) as Record<string, string>;
  const sourceMaps: Record<string, SourceMap> = Object.create(null) as Record<string, SourceMap>;
  const snapshots: StagedModule[] = [];
  const maps: StagedModule[] = [];
  const directories = new Set([dir]);
  for (const { mod, mapName, view, bytes, mapBytes } of staged) {
    const outPath = resolve(dir, mod.path);
    await stageParents(dir, outPath, directories);
    await stageFile(outPath, bytes);
    moduleUrls[mod.path] = pathToFileURL(outPath).href;
    snapshots.push({ path: mod.path, file: outPath, url: moduleUrls[mod.path]!, bytes });
    if (view.map !== undefined && mapBytes !== undefined) {
      sourceMaps[mod.path] = view.map;
      const mapPath = join(dirname(outPath), mapName);
      await stageFile(mapPath, mapBytes);
      mapUrls[mod.path] = pathToFileURL(mapPath).href;
      maps.push({ path: mod.path, file: mapPath, url: mapUrls[mod.path]!, bytes: mapBytes });
    }
  }
  const entryUrl = moduleUrls[entry.path];
  if (entryUrl === undefined) throw new Error(`assembleModules: entry module missing: ${entry.path}`);
  const asm = { dir, entryUrl, moduleUrls, mapUrls, sourceMaps };
  const snapshot = { artifactJson, dir, entryUrl, moduleUrls, mapUrls, modules: snapshots, maps, directories: [...directories] };
  await verifyAssembly(asm, snapshot, loaded.artifact);
  registerAssemblerModuleCapability(asm, artifactJson, snapshots, () => verifyAssembly(asm, snapshot));
  return asm;
}

/** Append a trailing `sourceMappingURL` comment without shifting earlier lines. */
function withSourceMappingURL(js: string, mapName: string): string {
  const comment = `//# sourceMappingURL=${mapName}\n`;
  return js.endsWith("\n") ? `${js}${comment}` : `${js}\n${comment}`;
}
