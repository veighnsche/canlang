/** Installed, file-level inputs for the portable local preview producer. */
import { accessSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import type { NamedInputPath, SingleFileCaptureRequest } from "./source-capture.js";

const require = createRequire(import.meta.url);
const OWNED_EXPORTS = [
  "@canlang/cloudflare/worker/main", "@canlang/contracts/distribution",
  "@canlang/interfaces/distribution", "@canlang/identity/distribution",
  "@canlang/state/distribution", "@canlang/ui/distribution",
  "@canlang/stdlib/distribution", "@canlang/values/distribution",
  "@canlang/work/distribution", "@canlang/services/distribution",
  "@canlang/testkit",
] as const;
const EXTERNAL_IMPORTS = [
  ["@modelcontextprotocol/sdk", "@canlang/interfaces/distribution"],
  ["cookie", "@canlang/identity/distribution"],
  ["@scure/base", "@canlang/identity/distribution"],
  ["csv-parse", "@canlang/ui/distribution"],
  ["@noble/hashes/sha2.js", "@canlang/services/distribution"],
  ["@jridgewell/sourcemap-codec", "@canlang/cloudflare/worker/main"],
] as const;
const RUNTIME_FILE = /\.(?:js|mjs|cjs|json|wasm|css)$/;
const SOURCE_FILE = /\.(?:ts|tsx|js|mjs|json|css|rs|wasm)$/;
const MAX_FILES = 8_000;

export interface PrepareLocalPreviewCaptureOptions {
  readonly checkoutRoot: string;
  readonly appPath: string;
  readonly compilerPath: string;
  readonly catalogPath: string;
  readonly helpIndexPath: string;
  readonly semanticOptions?: Readonly<Record<string, string>>;
}

function packageRoot(file: string): { root: string; name: string; version: string; manifest: Record<string, unknown> } {
  let dir = dirname(realpathSync(file));
  while (true) {
    const candidate = join(dir, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
      if (typeof manifest.name === "string" && typeof manifest.version === "string") {
        return { root: dir, name: manifest.name, version: manifest.version, manifest };
      }
    } catch { /* walk to the owning package manifest */ }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`preview inputs: no package owner for ${file}`);
    dir = parent;
  }
}

function resolveExternal(specifier: string, from: string): string {
  const localRequire = createRequire(join(from, "package.json"));
  try { return localRequire.resolve(`${specifier}/package.json`); }
  catch { return localRequire.resolve(specifier); }
}

function walkFiles(root: string, base: string, append: (path: string) => void, ancestors = new Set<string>()): void {
  if (ancestors.has(root)) throw new Error(`preview inputs: directory cycle at ${root}`);
  ancestors.add(root);
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(root, entry.name);
    // Bun installs self-links inside some package roots. Skip only those
    // cycles; any other alias needs an explicit producer entry.
    if (lstatSync(path).isSymbolicLink()) {
      const target = realpathSync(path);
      if (target === base || ancestors.has(target)) continue;
      throw new Error(`preview inputs: untracked installed package link ${path}`);
    }
    const actual = realpathSync(path);
    const rel = relative(base, actual);
    if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`preview inputs: package file escapes ${base}`);
    const kind = statSync(actual);
    if (kind.isDirectory()) walkFiles(actual, base, append, ancestors);
    else if (kind.isFile() && RUNTIME_FILE.test(entry.name) && !entry.name.endsWith(".test.js")) append(actual);
  }
  ancestors.delete(root);
}

/** Recompute this exact installed output closure before a bundle is accepted. */
export function installedPortableBundleInputs(applicationRoot = process.cwd()): readonly NamedInputPath[] {
  const selected = new Map<string, string>();
  const seenPackages = new Set<string>();
  const externalQueue: Array<{ specifier: string; from: string }> = [];
  const addPackage = (file: string, owned: boolean): void => {
    const pkg = packageRoot(file);
    if (seenPackages.has(pkg.root)) return;
    seenPackages.add(pkg.root);
    const outputRoot = owned ? join(pkg.root, "dist") : pkg.root;
    if (!statSync(outputRoot).isDirectory()) throw new Error(`preview inputs: ${pkg.name} has no installed outputs`);
    const add = (path: string): void => {
      const name = `${pkg.name}@${pkg.version}/${relative(pkg.root, path).split(sep).join("/")}`;
      const existing = selected.get(name);
      if (existing !== undefined && existing !== path) throw new Error(`preview inputs: duplicate installed file ${name}`);
      selected.set(name, path);
      if (selected.size > MAX_FILES) throw new Error("preview inputs: installed output inventory exceeds the finite limit");
    };
    add(join(pkg.root, "package.json"));
    walkFiles(outputRoot, pkg.root, add);
    const dependencies = pkg.manifest.dependencies;
    if (dependencies !== null && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      for (const specifier of Object.keys(dependencies).sort()) {
        if (!specifier.startsWith("@canlang/")) externalQueue.push({ specifier, from: pkg.root });
      }
    }
  };
  for (const specifier of OWNED_EXPORTS) {
    const entry = resolveOwned(specifier, applicationRoot);
    if (entry !== null) addPackage(entry, true);
  }
  for (const [specifier, owner] of EXTERNAL_IMPORTS) {
    externalQueue.push({ specifier, from: packageRoot(require.resolve(owner)).root });
  }
  while (externalQueue.length > 0) {
    const next = externalQueue.shift()!;
    addPackage(resolveExternal(next.specifier, next.from), false);
  }
  return [...selected].sort(([a], [b]) => a.localeCompare(b)).map(([name, path]) => ({ name, path }));
}

/** Source membership is captured too, so a checkout edit invalidates old dist evidence. */
function resolveOwned(specifier: string, applicationRoot: string): string | null {
  if (specifier !== "@canlang/testkit") return require.resolve(specifier);
  try { return createRequire(resolve(applicationRoot, "package.json")).resolve(specifier); }
  catch (error) {
    // Only absence of the optional package is admitted. Broken exports or an
    // installed package's missing entry remain actionable producer errors.
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" &&
        error.message.split("\n", 1)[0] === `Cannot find module '${specifier}'`) return null;
    throw error;
  }
}

export function installedOwnedSourceInputs(applicationRoot = process.cwd()): readonly NamedInputPath[] {
  const paths = new Map<string, string>();
  const seen = new Set<string>();
  const installed = installedPortableBundleInputs(applicationRoot);
  for (const specifier of OWNED_EXPORTS) {
    const entry = resolveOwned(specifier, applicationRoot);
    if (entry === null) continue;
    const pkg = packageRoot(entry);
    if (seen.has(pkg.root)) continue;
    seen.add(pkg.root);
    const sourceDirectories = pkg.name === "@canlang/values"
      ? ["src", "scripts", "semantics/src", "bindings/src", "bindings/generated", "conformance/v1"]
      : ["src", "scripts"];
    for (const directory of sourceDirectories) {
      const root = join(pkg.root, directory);
      try { if (!statSync(root).isDirectory()) continue; } catch { continue; }
      const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const path = join(current, entry.name);
          if (lstatSync(path).isSymbolicLink()) throw new Error(`preview inputs: source link ${path} is unsupported`);
          if (entry.isDirectory()) walk(path);
          else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
            paths.set(`source:${pkg.name}@${pkg.version}/${relative(pkg.root, path).split(sep).join("/")}`, path);
          }
        }
      };
      walk(root);
    }
    for (const name of pkg.name === "@canlang/values" ? ["Cargo.toml", "Cargo.lock"] :
      pkg.name === "@canlang/ui" ? ["themes.css"] : []) {
      const path = join(pkg.root, name);
      paths.set(`source:${pkg.name}@${pkg.version}/${name}`, path);
    }
    if (pkg.name === "@canlang/values") {
      const rust = [...paths].filter(([name]) => name.startsWith(`source:${pkg.name}@${pkg.version}/semantics/src/`));
      const glue = join(pkg.root, "bindings", "generated", "BUILD.json");
      if (rust.length === 0 || rust.some(([, path]) => statSync(path).mtimeMs > statSync(glue).mtimeMs)) {
        throw new Error("preview inputs: Values WASM binding is older than Rust semantics; rebuild the binding");
      }
    }
    const sourceTimes = [...paths].filter(([name]) => name.startsWith(`source:${pkg.name}@${pkg.version}/`))
      .map(([, path]) => statSync(path).mtimeMs);
    const distFiles = installed.filter(item => item.name.startsWith(`${pkg.name}@${pkg.version}/dist/`) && item.path.endsWith(".js"));
    if (distFiles.length === 0 || (sourceTimes.length > 0 && Math.max(...sourceTimes) > Math.min(...distFiles.map(item => statSync(item.path).mtimeMs)))) {
      throw new Error(`preview inputs: ${pkg.name} installed dist is older than its source; rebuild the package`);
    }
  }
  return [...paths].sort(([a], [b]) => a.localeCompare(b)).map(([name, path]) => ({ name, path }));
}

export function bunExecutable(): string {
  for (const part of (process.env.PATH ?? "").split(delimiter)) {
    const path = resolve(part || ".", "bun");
    try { accessSync(path, constants.X_OK); return realpathSync(path); }
    catch { /* next PATH entry */ }
  }
  throw new Error("preview inputs: bun executable is unavailable");
}

export function compilerSourceInputs(checkoutRoot: string, compilerPath: string): readonly NamedInputPath[] {
  const root = realpathSync(checkoutRoot);
  const executable = realpathSync(resolve(root, compilerPath));
  const target = join(root, "compiler", "target");
  const rel = relative(target, executable);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("preview inputs: first profile requires the checkout compiler target");
  }
  const source = join(root, "compiler");
  const paths: NamedInputPath[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (lstatSync(path).isSymbolicLink()) throw new Error(`preview inputs: compiler source link ${path} is unsupported`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".rs")) {
        paths.push({ name: `compiler-source:${relative(source, path).split(sep).join("/")}`, path });
      }
    }
  };
  walk(join(source, "src"));
  for (const name of ["Cargo.toml", "Cargo.lock"]) {
    const path = join(source, name);
    try { if (statSync(path).isFile()) paths.push({ name: `compiler-source:${name}`, path }); } catch { /* not present */ }
  }
  if (paths.length === 0 || paths.some(item => statSync(item.path).mtimeMs > statSync(executable).mtimeMs)) {
    throw new Error("preview inputs: checkout compiler is older than its source; rebuild the compiler");
  }
  return paths.sort((a, b) => a.name.localeCompare(b.name));
}

/** Optional owning qualification recipes; absence never blocks ordinary preview. */
export function firstProfileQualificationInputs(checkoutRoot: string): readonly NamedInputPath[] {
  const root = realpathSync(checkoutRoot);
  return [
    { name: "construct-profile:compiler-test", path: join(root,"compiler/tests/construct_help.rs") },
    { name: "construct-profile:fixture", path: join(root,"compiler/tests/fixtures/construct-help-first-profile.can") },
  ].filter(input => {
    try { return statSync(input.path).isFile(); } catch { return false; }
  });
}

/** The compiler catalog must be the current installed Values catalog. */
export function assertInstalledCatalog(checkoutRoot: string, selectedPath: string): void {
  const values = packageRoot(require.resolve("@canlang/values/distribution"));
  const expected = join(values.root, "dist", "catalog.json");
  const selected = realpathSync(resolve(checkoutRoot, selectedPath));
  if (selected !== realpathSync(expected)) {
    throw new Error("preview inputs: first profile requires the installed Values catalog");
  }
  const catalogTime = statSync(selected).mtimeMs;
  for (const input of [join(values.root, "src", "catalog.ts"), join(values.root, "dist", "src", "catalog.js")]) {
    if (statSync(input).mtimeMs > catalogTime) {
      throw new Error("preview inputs: installed Values catalog is older than its producer; regenerate the catalog");
    }
  }
}

/** Re-discover the same finite inventory used by preparation and currency checks. */
export function installedLocalPreviewInputInventory(checkoutRoot: string, compilerPath: string): {
  packageInputPaths: readonly NamedInputPath[];
  extraInputPaths: readonly NamedInputPath[];
} {
  const grammar = join(realpathSync(checkoutRoot), "docs", "specification", "GRAMMAR.md");
  if (!statSync(grammar).isFile()) throw new Error("preview inputs: installed grammar reference is unavailable");
  return {
    packageInputPaths: installedPortableBundleInputs(checkoutRoot),
    extraInputPaths: [
      { name: "bun", path: bunExecutable() },
      { name: "grammar", path: grammar },
      ...installedOwnedSourceInputs(checkoutRoot),
      ...compilerSourceInputs(checkoutRoot, compilerPath),
      ...firstProfileQualificationInputs(checkoutRoot),
    ],
  };
}

/** Derive the capture manifest from installed producers; callers select only source/tool paths. */
export function prepareLocalPreviewCapture(options: PrepareLocalPreviewCaptureOptions): SingleFileCaptureRequest {
  assertInstalledCatalog(options.checkoutRoot, options.catalogPath);
  const inventory = installedLocalPreviewInputInventory(options.checkoutRoot, options.compilerPath);
  return {
    checkoutRoot: options.checkoutRoot,
    appPath: options.appPath,
    profile: "local-d1-identity",
    compilerPath: options.compilerPath,
    catalogPath: options.catalogPath,
    helpIndexPath: options.helpIndexPath,
    ...inventory,
    inputInventory: "installed-local-preview",
    ...(options.semanticOptions === undefined ? {} : { semanticOptions: options.semanticOptions }),
  };
}
