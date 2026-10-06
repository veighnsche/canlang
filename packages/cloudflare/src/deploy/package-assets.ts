/** Installed producer assets; selection never builds or activates a backend. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { distribution as valuesDistribution } from "@canlang/values/distribution";
import { distribution as uiDistribution } from "@canlang/ui/distribution";

export interface PackageAssetSelection {
  valuesWasm?: boolean;
  browser?: boolean;
}

export interface PackageResource {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface GatheredDeploymentAssets {
  modules: Record<string, string>;
  binaries: Record<string, Uint8Array>;
  resources: Record<string, PackageResource>;
}

const VALUES_FILES = [
  "values_semantics.d.ts",
  "values_semantics.js",
  "values_semantics_bg.wasm",
  "values_semantics_bg.wasm.d.ts",
] as const;
const BROWSER_FILES = ["bootstrap.js", "polling.js", "can-style.css"] as const;
const VALUES_PREFIX = "vendor/values-bindings/";

function emptyAssets(): GatheredDeploymentAssets {
  return { modules: {}, binaries: {}, resources: {} };
}

function assetError(detail: string): Error {
  return new Error(`package assets: ${detail}`);
}

function directoryRoot(directory: URL): string {
  try {
    const root = realpathSync(fileURLToPath(directory));
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    return root;
  } catch (error) {
    throw assetError(`cannot read directory ${directory.href}: ${String(error)}`);
  }
}

/** Every read stays inside the selected producer directory, including symlinks. */
function containedPath(root: string, path: string): string {
  let actual: string;
  try {
    actual = realpathSync(path);
  } catch (error) {
    throw assetError(`missing asset ${path}: ${String(error)}`);
  }
  const rel = relative(root, actual);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw assetError(`asset escapes producer directory: ${path}`);
  }
  return actual;
}

function readContainedFile(root: string, path: string): Uint8Array {
  const actual = containedPath(root, path);
  if (!statSync(actual).isFile()) throw assetError(`asset is not a file: ${path}`);
  return new Uint8Array(readFileSync(actual));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Verify the entire finite manifest before exposing any of its runtime bytes. */
function verifiedFiles(
  root: string,
  manifestPath: string,
  names: readonly string[],
): Record<string, Uint8Array> {
  let inventory: unknown;
  try {
    inventory = JSON.parse(Buffer.from(readContainedFile(root, manifestPath)).toString("utf8"));
  } catch (error) {
    throw assetError(`cannot read manifest ${manifestPath}: ${String(error)}`);
  }
  const files = isRecord(inventory) ? inventory["files"] : undefined;
  if (!isRecord(files) || Object.keys(files).sort().join("\n") !== [...names].sort().join("\n")) {
    throw assetError(`manifest file set does not match expected assets: ${manifestPath}`);
  }
  const verified: Record<string, Uint8Array> = {};
  for (const name of [...names].sort()) {
    const expected = files[name];
    if (!isRecord(expected) || !Number.isSafeInteger(expected["bytes"]) ||
        (expected["bytes"] as number) < 0 || typeof expected["sha256"] !== "string" ||
        !/^[a-f0-9]{64}$/.test(expected["sha256"])) {
      throw assetError(`malformed integrity entry for ${name}: ${manifestPath}`);
    }
    const bytes = readContainedFile(root, join(manifestPath, "..", name));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== expected["bytes"] || digest !== expected["sha256"]) {
      throw assetError(`integrity mismatch for ${name}: ${manifestPath}`);
    }
    verified[name] = bytes;
  }
  return verified;
}

/** Raw binding JS plus pinned WASM; the bundler owns producer-import rewriting. */
export function gatherValuesWasmAssets(
  bindingsDirectory: URL = valuesDistribution.bindings,
): GatheredDeploymentAssets {
  const root = directoryRoot(bindingsDirectory);
  const generated = verifiedFiles(root, join(root, "generated", "BUILD.json"), VALUES_FILES);
  const result = emptyAssets();
  const ancestors = new Set<string>();
  const walk = (directory: string): void => {
    const actual = containedPath(root, directory);
    if (ancestors.has(actual)) throw assetError(`directory cycle in producer assets: ${directory}`);
    ancestors.add(actual);
    for (const name of readdirSync(actual).sort()) {
      const path = join(directory, name);
      const target = containedPath(root, path);
      if (statSync(target).isDirectory()) {
        walk(path);
      } else if (name.endsWith(".js") && !name.endsWith(".test.js") && name !== "distribution.js") {
        const key = relative(root, path).split(sep).join("/");
        const bytes = key === "generated/values_semantics.js"
          ? generated["values_semantics.js"] as Uint8Array
          : readContainedFile(root, path);
        result.modules[`${VALUES_PREFIX}${key}`] = Buffer.from(bytes).toString("utf8");
      }
    }
    ancestors.delete(actual);
  };
  walk(root);
  result.binaries[`${VALUES_PREFIX}generated/values_semantics_bg.wasm`] =
    generated["values_semantics_bg.wasm"] as Uint8Array;
  return result;
}

/** Public client/CSS resources stay outside the Worker ES-module map. */
export function gatherBrowserAssets(
  browserDirectory: URL = uiDistribution.browser,
): GatheredDeploymentAssets {
  const root = directoryRoot(browserDirectory);
  const files = verifiedFiles(root, join(root, "manifest.json"), BROWSER_FILES);
  const result = emptyAssets();
  for (const name of [...BROWSER_FILES].sort()) {
    result.resources[`browser/${name}`] = {
      bytes: files[name] as Uint8Array,
      contentType: name.endsWith(".css") ? "text/css" : "application/javascript",
    };
  }
  return result;
}

/** No assets are selected implicitly; package installation does not select WASM. */
export function gatherDeploymentAssets(
  selection: PackageAssetSelection = {},
): GatheredDeploymentAssets {
  const result = emptyAssets();
  const selected: GatheredDeploymentAssets[] = [];
  if (selection.valuesWasm === true) selected.push(gatherValuesWasmAssets());
  if (selection.browser === true) selected.push(gatherBrowserAssets());
  for (const assets of selected) {
    Object.assign(result.modules, assets.modules);
    Object.assign(result.binaries, assets.binaries);
    Object.assign(result.resources, assets.resources);
  }
  return result;
}
