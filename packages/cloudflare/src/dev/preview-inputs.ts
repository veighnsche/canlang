import { browserToolsRoot } from './browser-tools.js';
/** Installed, file-level inputs for the portable local preview producer. */
import type { ChromiumProducer } from "@canlang/contracts/browser/chromium";
import { accessSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { captureInputs, type CapturedFileIdentity, type NamedInputPath, type SingleFileCaptureRequest } from "./source-capture.js";

const require = createRequire(import.meta.url);
const OWNED_EXPORTS = [
  "@canlang/cloudflare/worker/main", "@canlang/contracts/distribution",
  "@canlang/interfaces/distribution", "@canlang/identity/distribution",
  "@canlang/files/distribution",
  "@canlang/state/distribution", "@canlang/ui/distribution",
  "@canlang/stdlib/distribution", "@canlang/values/distribution",
  "@canlang/work/distribution", "@canlang/work-kernel/distribution", "@canlang/services/distribution",
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
const BROWSER_DRIVER_VERSION = "1.63.0";

export function installedRoot(): string | null {
  if (process.env.CAN_INSTALL_ROOT === undefined) return null;
  const root = realpathSync(process.env.CAN_INSTALL_ROOT);
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as { kind?: unknown };
  if (manifest.kind !== "can-install") throw new Error("preview inputs: invalid Can installation manifest");
  return root;
}

/** Soda tool archives carry references and compiler sources beside tools.json. */
function installedToolRoot(): string | null {
  if (!process.env.CAN_TOOL_ROOT) return null;
  const root = realpathSync(process.env.CAN_TOOL_ROOT);
  const manifest = JSON.parse(readFileSync(join(root, "tools.json"), "utf8")) as { schema?: unknown };
  if (manifest.schema !== "canlang.tools.v1") throw new Error("preview inputs: invalid installed tool release");
  return root;
}

/** Authoring references belong to the tool release; app identity stays in its root. */
export function installedReferenceRoot(checkoutRoot: string): string {
  return installedRoot() ?? installedToolRoot() ?? realpathSync(checkoutRoot);
}

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
  const installation = installedRoot() ?? installedToolRoot();
  const platformRoot = packageRoot(require.resolve("@canlang/cloudflare/worker/main")).root;
  const seenPackages = new Set<string>();
  const externalQueue: Array<{ specifier: string; from: string }> = [];
  const addPackage = (file: string, owned: boolean): void => {
    const pkg = packageRoot(file);
    if (seenPackages.has(pkg.root)) return;
    seenPackages.add(pkg.root);
    const outputRoot = owned ? join(pkg.root, "dist") : pkg.root;
    if (!statSync(outputRoot).isDirectory()) throw new Error(`preview inputs: ${pkg.name} has no installed outputs`);
    const add = (path: string): void => {
      const context = !owned ? `instance:${relative(installation ?? platformRoot, pkg.root).split(sep).join("/")}/` : "";
      const name = `${pkg.name}@${pkg.version}/${context}${relative(pkg.root, path).split(sep).join("/")}`;
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
        error.message.split("\n", 1)[0] === `Cannot find module '${specifier}'`) {
      try { return require.resolve(specifier); }
      catch (fallbackError) {
        if (fallbackError instanceof Error && (fallbackError as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" &&
            fallbackError.message.split("\n", 1)[0] === `Cannot find module '${specifier}'`) return null;
        throw fallbackError;
      }
    }
    throw error;
  }
}

/** Construct help fingerprints the two owning authored catalogs as data;
 * a release needs neither contributor sources nor source build timestamps. */
function recordInstalledCatalogSource(
  pkg: ReturnType<typeof packageRoot>,
  installation: string,
  paths: Map<string, string>,
): void {
  if (pkg.name !== "@canlang/values" && pkg.name !== "@canlang/ui") return;
  const path = join(installation, "packages", pkg.name.slice("@canlang/".length), "src/catalog.ts");
  if (!statSync(path).isFile()) throw new Error(`preview inputs: ${pkg.name} catalog source metadata is absent`);
  paths.set(`source:${pkg.name}@${pkg.version}/src/catalog.ts`, path);
}

function walkPackageSources(pkg: ReturnType<typeof packageRoot>, paths: Map<string, string>): void {
  // Release packages carry built outputs without the author's source tree.
  try { if (!statSync(join(pkg.root, "src")).isDirectory()) return; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
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
}

function assertOwnedSourceFresh(
  pkg: ReturnType<typeof packageRoot>,
  paths: Map<string, string>,
  installed: readonly NamedInputPath[],
): void {
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

function accumulateOwnedSource(
  specifier: string,
  applicationRoot: string,
  installation: string | null,
  installed: readonly NamedInputPath[],
  paths: Map<string, string>,
  seen: Set<string>,
): void {
  const entry = resolveOwned(specifier, applicationRoot);
  if (entry === null) return;
  const pkg = packageRoot(entry);
  if (seen.has(pkg.root)) return;
  seen.add(pkg.root);
  if (installation !== null) {
    recordInstalledCatalogSource(pkg, installation, paths);
    return;
  }
  walkPackageSources(pkg, paths);
  assertOwnedSourceFresh(pkg, paths, installed);
}

export function installedOwnedSourceInputs(
  applicationRoot = process.cwd(),
  installed: readonly NamedInputPath[] = installedPortableBundleInputs(applicationRoot),
): readonly NamedInputPath[] {
  const paths = new Map<string, string>();
  const installation = installedRoot();
  const seen = new Set<string>();
  for (const specifier of OWNED_EXPORTS) {
    accumulateOwnedSource(specifier, applicationRoot, installation, installed, paths, seen);
  }
  return [...paths].sort(([a], [b]) => a.localeCompare(b)).map(([name, path]) => ({ name, path }));
}

const browserCodePins = new Map<string, readonly CapturedFileIdentity[]>();

function browserInventory() {
  const selected = new Map<string, string>();
  let visited = 0;
  const add = (name: string, path: string): void => {
    if (selected.has(name)) throw new Error("preview inputs: duplicate browser input");
    selected.set(name, path);
    if (selected.size > MAX_FILES) throw new Error("preview inputs: browser inventory exceeds the finite limit");
  };
  const walk = (base: string, current: string, prefix: string, ancestors = new Set<string>(), depth = 0): void => {
    if (++visited > 16_000 || depth > 64) throw new Error("preview inputs: browser traversal exceeds the finite limit");
    const actual = realpathSync(current), rel = relative(base, actual);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("preview inputs: browser file escapes its installation");
    const kind = statSync(actual);
    if (kind.isFile()) { add(`${prefix}/${relative(base, current).split(sep).join("/")}`, current); return; }
    if (!kind.isDirectory()) throw new Error("preview inputs: browser input is not a regular file or directory");
    if (ancestors.has(actual)) throw new Error("preview inputs: browser directory cycle");
    ancestors.add(actual);
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name !== "node_modules" && entry.name !== ".git") walk(base, join(current, entry.name), prefix, ancestors, depth + 1);
    }
    ancestors.delete(actual);
  };
  return { add, walk, inputs: (): readonly NamedInputPath[] => [...selected].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, path]) => ({ name, path })) };
}

function visitDriverPackage(
  pkg: ReturnType<typeof packageRoot>,
  inventory: ReturnType<typeof browserInventory>,
  pending: string[],
): string {
  if (!["@playwright/test", "playwright", "playwright-core"].includes(pkg.name) || pkg.version !== BROWSER_DRIVER_VERSION) {
    throw new Error("preview inputs: browser driver does not match the locked producer");
  }
  inventory.walk(pkg.root, pkg.root, `browser:driver:${pkg.name}@${pkg.version}`);
  const dependencies = pkg.manifest.dependencies;
  if (dependencies === undefined) return pkg.name;
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new Error("preview inputs: malformed browser dependencies");
  }
  for (const name of Object.keys(dependencies).sort()) {
    pending.push(createRequire(join(pkg.root, "package.json")).resolve(name));
  }
  return pkg.name;
}

function browserDriverInputs(kitRoot: string): {
  entryPath: string; coreRoot: string; inputs: readonly NamedInputPath[];
} | null {
  let entryPath: string;
  const development = browserToolsRoot();
  if ((installedRoot() ?? installedToolRoot()) !== null && development === null) return null;
  try { entryPath = realpathSync(createRequire(join(development ?? kitRoot, "package.json")).resolve("@playwright/test")); }
  catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" &&
      error.message.split("\n", 1)[0] === "Cannot find module '@playwright/test'") return null;
    throw error;
  }
  const inventory = browserInventory(), pending = [entryPath], seen = new Set<string>();
  let coreRoot: string | undefined;
  while (pending.length > 0) {
    const pkg = packageRoot(pending.shift()!);
    if (seen.has(pkg.root)) continue;
    seen.add(pkg.root);
    if (visitDriverPackage(pkg, inventory, pending) === "playwright-core") coreRoot = pkg.root;
  }
  if (!coreRoot || seen.size !== 3) throw new Error("preview inputs: incomplete browser driver closure");
  return { entryPath, coreRoot, inputs: inventory.inputs() };
}

/** Pin executed Node module closures for this lifetime; changed bytes require restart. */
async function pinBrowserCode(key: string, root: string, paths: readonly NamedInputPath[]): Promise<void> {
  const current = await captureInputs(root, paths), prior = browserCodePins.get(key);
  if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(current)) {
    throw new Error("preview inputs: loaded browser code changed; restart the local session");
  }
  if (prior === undefined) {
    if (key.startsWith("driver:") && paths.some(input => require.cache?.[realpathSync(input.path)] !== undefined)) {
      throw new Error("preview inputs: browser driver was loaded outside its captured lifetime; restart the local session");
    }
    browserCodePins.set(key, current);
  }
}

/** Optional qualification-only producer; never linked into the portable Worker. */
export async function loadInstalledChromium(applicationRoot: string): Promise<{
  entryPath: string;
  producer: ChromiumProducer;
  driver: ReturnType<typeof browserDriverInputs>;
} | null> {
  const rootEntry = resolveOwned("@canlang/testkit", applicationRoot);
  if (rootEntry === null) return null;
  const kit = packageRoot(rootEntry);
  const entryPath = realpathSync(createRequire(join(kit.root, "package.json"))
    .resolve("@canlang/testkit/browser/chromium"));
  if (packageRoot(entryPath).root !== kit.root) throw new Error("preview inputs: foreign browser producer");
  const producerPaths = [{ name: "browser:producer", path: entryPath },
    { name: "browser:producer-manifest", path: join(kit.root, "package.json") }];
  await pinBrowserCode(`producer:${entryPath}`, applicationRoot, producerPaths);
  const driver = browserDriverInputs(kit.root);
  if (driver !== null) await pinBrowserCode(`driver:${driver.entryPath}`, applicationRoot, driver.inputs);
  // A content-qualified URL prevents unrelated earlier imports from supplying this leaf.
  const leaf = browserCodePins.get(`producer:${entryPath}`)!.find(input => input.name === "browser:producer")!;
  const producer = await import(`${pathToFileURL(entryPath).href}?can_browser=${leaf.sha256}`) as ChromiumProducer;
  for (const name of ["chromiumAvailability", "acquireChromium"] as const) {
    const property = Object.getOwnPropertyDescriptor(producer, name);
    if (typeof property?.value !== "function") throw new Error("preview inputs: broken installed browser producer");
  }
  await pinBrowserCode(`producer:${entryPath}`, applicationRoot, producerPaths);
  if (driver !== null) await pinBrowserCode(`driver:${driver.entryPath}`, applicationRoot, driver.inputs);
  return { entryPath, producer, driver };
}

/** All shipped driver/browser files, including native resources and internal aliases.
 * Absence withholds UI evidence; newly installed files change full capture membership. */
export async function installedBrowserQualificationInputs(applicationRoot: string): Promise<readonly NamedInputPath[]> {
  const loaded = await loadInstalledChromium(applicationRoot);
  if (loaded === null) return [];
  const availability = await loaded.producer.chromiumAvailability();
  const inventory = browserInventory();
  inventory.add("browser:producer", loaded.entryPath);
  if (!availability.available && availability.reason === "driver-not-installed") {
    if (loaded.driver !== null) throw new Error("preview inputs: installed browser driver was incorrectly withheld");
    return inventory.inputs();
  }
  const driver = loaded.driver;
  if (driver === null || driver.entryPath !== realpathSync(availability.identity.driverEntryPath)) {
    throw new Error("preview inputs: browser driver identity mismatch");
  }
  await pinBrowserCode(`driver:${driver.entryPath}`, applicationRoot, driver.inputs);
  for (const input of driver.inputs) inventory.add(input.name, input.path);
  if (availability.available) {
    const executable = realpathSync(availability.identity.executablePath);
    let installation = dirname(executable);
    while (!/^(?:chromium|chromium_headless_shell)-[0-9]+$/.test(installation.split(sep).at(-1) ?? "")) {
      const parent = dirname(installation);
      if (parent === installation) throw new Error("preview inputs: browser executable has no installed Chromium owner");
      installation = parent;
    }
    const browsers = JSON.parse(readFileSync(join(driver.coreRoot, "browsers.json"), "utf8")) as { browsers?: Array<{ name?: string; revision?: string }> };
    const folder = installation.split(sep).at(-1)!;
    const name = folder.startsWith("chromium_headless_shell-") ? "chromium-headless-shell" : "chromium";
    const browser = browsers.browsers?.find(value => value.name === name);
    if (!browser || folder.slice(folder.lastIndexOf("-") + 1) !== browser.revision || !statSync(join(installation, "INSTALLATION_COMPLETE")).isFile()) {
      throw new Error("preview inputs: browser installation does not match the locked driver");
    }
    inventory.add("browser:executable", availability.identity.executablePath);
    inventory.walk(installation, installation, `browser:installation:${folder}`);
  }
  return inventory.inputs();
}

/** Capture the host and native producer that the preview bundler will run.
 * The preview host pins this exact native path through ESBUILD_BINARY_PATH. */
export function bundlerExecutableInputs(): readonly NamedInputPath[] {
  let binary = process.env.ESBUILD_BINARY_PATH;
  if (!binary) {
    const api = require.resolve("esbuild");
    const owner = createRequire(api);
    const pkg = `@esbuild/${process.platform}-${process.arch}`;
    const subpath = process.platform === "win32" ? "esbuild.exe" : "bin/esbuild";
    try { binary = owner.resolve(`${pkg}/${subpath}`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
      // esbuild's installer uses this native fallback when optional packages
      // cannot be installed. Pin it explicitly instead of reselecting in child.
      binary = join(dirname(api), `downloaded-${pkg.replace("/", "-")}-${basename(subpath)}`);
    }
  }
  const executable = realpathSync(binary);
  if (executable === "/usr/bin/esbuild") throw new Error("preview inputs: esbuild refuses the reserved /usr/bin/esbuild override");
  accessSync(executable, constants.X_OK);
  return [{ name: "node", path: realpathSync(process.execPath) }, { name: "esbuild", path: executable }];
}

export function compilerSourceInputs(checkoutRoot: string, compilerPath: string): readonly NamedInputPath[] {
  const root = installedReferenceRoot(checkoutRoot);
  const executable = realpathSync(resolve(checkoutRoot, compilerPath));
  const installation = installedRoot();
  if (installation !== null && executable === realpathSync(join(installation, "libexec", "can"))) return [];
  let target: string;
  try { target = realpathSync(join(root, "compiler", "target")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error("preview inputs: first profile requires the checkout compiler target");
  }
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
  const root = installedReferenceRoot(checkoutRoot);
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
  const native = join(packageRoot(require.resolve("@canlang/cloudflare/worker/main")).root, "dist", "native-catalog.json");
  let nativeSelected = false;
  try { nativeSelected = selected === realpathSync(native); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (selected !== realpathSync(expected) && !nativeSelected) {
    throw new Error("preview inputs: first profile requires an installed Canlang producer catalog");
  }
  // Extraction/copy order is not source freshness in a prebuilt installation.
  try { statSync(join(values.root, "src", "catalog.ts")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
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
  const installation = installedRoot();
  const toolRoot = installedToolRoot();
  const grammar = join(installedReferenceRoot(checkoutRoot), "docs", "specification", "GRAMMAR.md");
  if (!statSync(grammar).isFile()) throw new Error("preview inputs: installed grammar reference is unavailable");
  const packageInputPaths = installedPortableBundleInputs(checkoutRoot);
  return {
    packageInputPaths,
    extraInputPaths: [
      ...bundlerExecutableInputs(),
      { name: "grammar", path: grammar },
      ...(installation === null ? [] : [{ name: "installation-manifest", path: join(installation, "manifest.json") }]),
      ...(toolRoot === null ? [] : [{ name: "tool-release-manifest", path: join(toolRoot, "tools.json") }]),
      ...installedOwnedSourceInputs(checkoutRoot, packageInputPaths),
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
