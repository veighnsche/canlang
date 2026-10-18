/** Installed producer assets; selection never builds or activates a backend. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { distribution as valuesDistribution } from "@canlang/values/distribution";
import { distribution as uiDistribution } from "@canlang/ui/distribution";
import { distribution as workKernelDistribution } from "@canlang/work-kernel/distribution";

export interface PackageAssetSelection {
  valuesWasm?: boolean;
  browser?: boolean;
  workKernelRecovery?: boolean;
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

const WORK_KERNEL_NATIVE_FILES = ["recovery.wasm"] as const;
const WORK_KERNEL_PREFIX = "vendor/work-kernel/native/";

/** Pinned recovery WASM verified against its staged BUILD.json manifest; the
 *  deploy bundler owns producer-import rewriting. Missing/corrupt staged
 *  bytes refuse here, never at Worker dispatch. */
export function gatherWorkKernelRecoveryAssets(
  nativeDirectory: URL = new URL("./", workKernelDistribution.recoveryWasm),
): GatheredDeploymentAssets {
  const root = directoryRoot(nativeDirectory);
  const verified = verifiedFiles(root, join(root, "BUILD.json"), WORK_KERNEL_NATIVE_FILES);
  const result = emptyAssets();
  result.binaries[`${WORK_KERNEL_PREFIX}recovery.wasm`] =
    verified["recovery.wasm"] as Uint8Array;
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

export interface SavedUnitAssetCollection {
  /** Unit-local `.js`/`.mjs` modules as UTF-8 text (staged verbatim). */
  readonly modules: Record<string, string>;
  /** Owned CSS/images/fonts/bytes as typed resources. */
  readonly resources: Record<string, PackageResource>;
}

/** Unit-local module extensions gathered as UTF-8 text. */
const SAVED_UNIT_MODULE_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".mjs"]);

/** Owned asset extensions gathered as typed resources. */
const SAVED_UNIT_RESOURCE_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css",
  ".json": "application/json",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

/** Primaries and metadata that are never gathered as assets. */
const SAVED_UNIT_RESERVED_FILES: ReadonlySet<string> = new Set([
  "unit.json",
  "declaration.json",
  "contributions.can",
  "implementation.js",
  "style.css",
]);

function savedUnitError(detail: string): Error {
  return new Error(`saved unit assets: ${detail}`);
}

/**
 * BGI-11 owned saved-unit assets: gather exactly the manifest set
 * (unit-relative path to expected SHA-256) from one saved unit
 * directory. Same containment discipline as producer assets
 * (symlink escape refuses), fingerprint-verified, deterministic
 * sorted order; `.js`/`.mjs` gather as UTF-8 modules, owned
 * CSS/images/fonts/bytes as typed resources. Unknown extensions,
 * reserved primaries, hash mismatches, and invalid UTF-8 modules
 * refuse loudly.
 */
export function gatherSavedUnitAssets(unitDir: string, manifest: Record<string, string>): SavedUnitAssetCollection {
  if (typeof unitDir !== "string" || unitDir.length === 0) {
    throw savedUnitError("unit directory must be a non-empty path");
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw savedUnitError("manifest must be an object of unit-relative path to SHA-256");
  }
  let root: string;
  try {
    root = realpathSync(unitDir);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw savedUnitError(`cannot read unit directory ${JSON.stringify(unitDir)}: ${String(error)}`);
  }
  const rels = Object.keys(manifest).sort();
  for (const rel of rels) assertManifestEntry(manifest, rel);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const modules: Record<string, string> = {};
  const resources: Record<string, PackageResource> = {};
  for (const rel of rels) {
    gatherAsset(root, manifest[rel] as string, rel, decoder, modules, resources);
  }
  return { modules, resources };
}

function assertManifestEntry(manifest: Record<string, string>, rel: string): void {
  if (rel.length === 0 || isAbsolute(rel) || rel.split("/").some((part) => part === "" || part === "." || part === "..") || rel.includes("\\")) {
    throw savedUnitError(`manifest path ${JSON.stringify(rel)} must be a traversal-free unit-relative path`);
  }
  const expected: unknown = manifest[rel];
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
    throw savedUnitError(`manifest entry ${JSON.stringify(rel)} expects malformed SHA-256 ${JSON.stringify(expected)}`);
  }
  if (SAVED_UNIT_RESERVED_FILES.has(rel)) {
    throw savedUnitError(`manifest entry ${JSON.stringify(rel)} names a reserved primary/metadata file, not an asset`);
  }
}

function readVerifiedAsset(root: string, rel: string, expected: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = readContainedFile(root, join(root, rel));
  } catch (error) {
    throw savedUnitError(`cannot read ${JSON.stringify(rel)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw savedUnitError(`file ${JSON.stringify(rel)} changed (fingerprint mismatch): re-validate before gathering; refusing to gather changed bytes silently`);
  }
  return bytes;
}

function gatherAsset(
  root: string,
  expected: string,
  rel: string,
  decoder: TextDecoder,
  modules: Record<string, string>,
  resources: Record<string, PackageResource>,
): void {
  const bytes = readVerifiedAsset(root, rel, expected);
  const dot = rel.lastIndexOf(".");
  const extension = dot >= 0 ? rel.slice(dot).toLowerCase() : "";
  if (SAVED_UNIT_MODULE_EXTENSIONS.has(extension)) {
    try {
      modules[rel] = decoder.decode(bytes);
    } catch {
      throw savedUnitError(`module ${JSON.stringify(rel)} is not valid UTF-8`);
    }
    return;
  }
  const contentType = SAVED_UNIT_RESOURCE_TYPES[extension];
  if (contentType === undefined) {
    throw savedUnitError(`file ${JSON.stringify(rel)} has an unadmitted extension ${JSON.stringify(extension)} (only unit-local .js/.mjs, CSS, images, fonts, and bytes gather as assets)`);
  }
  resources[rel] = { bytes, contentType };
}

/** No assets are selected implicitly; package installation does not select WASM. */
export function gatherDeploymentAssets(
  selection: PackageAssetSelection = {},
): GatheredDeploymentAssets {
  const result = emptyAssets();
  const selected: GatheredDeploymentAssets[] = [];
  if (selection.valuesWasm === true) selected.push(gatherValuesWasmAssets());
  if (selection.browser === true) selected.push(gatherBrowserAssets());
  if (selection.workKernelRecovery === true) selected.push(gatherWorkKernelRecoveryAssets());
  for (const assets of selected) {
    Object.assign(result.modules, assets.modules);
    Object.assign(result.binaries, assets.binaries);
    Object.assign(result.resources, assets.resources);
  }
  return result;
}
