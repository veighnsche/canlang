/**
 * P-B deploy bundler: `CompileArtifact` + built dists -> portable workerd
 * module map (the deploy `main` and everything it imports).
 *
 * Why this exists: `assembleModules` (`runtime/modules.ts`) emits node
 * file-URLs with a distRoot UI rewrite — shippable to a local node process,
 * not to workerd. This module is its deploy-time counterpart: same artifact
 * validation, but every import becomes a module-map-relative ESM specifier
 * and every byte is scanned workerd-loadable before it ships.
 *
 * Bundle layout mirrors the dist tree so the P-A sibling-join map
 * (`src/worker/main.ts`: `./entry.js`, `./assembly.js`, `./artifact.js`,
 * `./mcp-handler.js`, `../runtime/env-assembly.js`,
 * `../runtime/grant-route.js`, plus assembly's `../runtime/{context,
 * invoke,mcp-registry}.js`) resolves identically on disk (wrangler upload
 * bundling) and in workerd module maps:
 * - `worker/`: top-level `dist/worker/*.js` (the P-A serving entry
 *   `main.js` + `entry.js` + `assembly.js`), copied from the BUILT worker
 *   dist (`<repoRoot>/packages/cloudflare/dist/worker/`, produced by `bun
 *   run build`). Missing `main.js` fails loud with `WORKER_MAIN_MISSING`.
 * - `worker/artifact.js` (GENERATED): the P-B staged deployment —
 *   `export const { artifact, modules, verdict }`, where `modules` is the
 *   PORTABLE `AssembledModules` (module-map-relative URLs, never node
 *   file-URLs) and `verdict` is the deploy-time `activate()` verdict the
 *   caller computed.
 * - `worker/mcp-handler.js`: the interfaces/MCP-SDK handler chain, `bun
 *   build --target=browser --format=esm` from a generated entry that
 *   re-exports ONLY the real `createMcpHandler` (interfaces dist, also
 *   aliased as `createHandler` for the main's join contract) and the real
 *   `createArtifactRegistry`/`createArtifactCatalog` (cloudflare dist) —
 *   mirroring `tests/e2e/fixtures/artifact-loader.ts` `buildMcpBundle`
 *   INCLUDING its marker check. Bundling (not vendoring) is required
 *   because transitive MCP SDK deps (ajv, content-type) ship CJS only.
 * - `worker/http-operations.js` (C3): the real `handleOperationRequest`
 *   POST chain, `bun build --target=browser --format=esm` from a pure
 *   re-export entry (MCP-identical shape, so no entry-path comment
 *   leaks the tmpdir and the bundle stays deterministic). The main's
 *   join contract curries it (`(deps) => (req, op) => ...` — arity
 *   adaptation in stable main source, no bundle logic). Same flags,
 *   marker check, and loud errors as the MCP bundle.
 * - `runtime/<pinned>.js`: the workerd-safe dist runtime files the worker
 *   graph loads (`context`, `invoke` + `sourcemap`, `mcp-registry` for
 *   assembly; `env-assembly`, `grant-route` for main). Pinned by name —
 *   the rest of `dist/runtime` imports node: builtins and MUST NOT ship.
 * - artifact modules at their artifact-relative paths, with
 *   `@canlang/stdlib` / `@canlang/ui` rewritten to module-relative
 *   `vendor/` specifiers (computed per importing module, so nested
 *   modules resolve correctly). Pages and callables reference staged
 *   modules by name and are validated, never silently dropped.
 * - `vendor/…` trees: built producer dists (contracts, ui, identity,
 *   stdlib, state, values) plus the `contracts/src` mirror for the
 *   repo-relative specifier baked into @canlang/ui dist (same bytes,
 *   second key). Producer imports inside staged vendor trees
 *   (`@canlang/values` in stdlib today) and pinned-runtime files
 *   (`@canlang/identity`, `@canlang/contracts`, the state-D1 checkout
 *   path) are rewritten to module-relative `vendor/` keys;
 *   `assertLinksResolve` then refuses
 *   any dangling or bare import. Acknowledged gap: dynamic imports
 *   through variables (the rewritten `*_SPECIFIER` consts) are
 *   statically invisible to the check — they are covered behaviorally
 *   by the with-DB boot tests, which execute the real dynamic imports
 *   in workerd.
 *
 * `instanceof IdentityError` invariant (mirrors the fixture header in
 * `tests/e2e/fixtures/handbuilt/mcp-bundle-entry.js`): bundling duplicates
 * the identity code beside the worker's `vendor/identity` tree. That stays
 * safe ONLY because the identity store object is created once by the worker
 * and passed through (never re-thrown across the copy boundary), and every
 * `instanceof IdentityError` check runs inside the copy that threw it. The
 * bundle MUST therefore carry its own IdentityError copy — asserted by the
 * `IdentityError` marker below — and deploy consumers MUST NOT mix error
 * instances across the bundle/vendor boundary.
 *
 * Determinism: same artifact + same dists => identical bytes and sha256
 * (sorted walks, sorted keys, absolute-specifier generated entry so tmp
 * paths never leak into the bundle).
 *
 * Worker-boundary compliant: this module READS built dist files with `fs`
 * at deploy time; it never imports worker sources (see
 * `test/worker-boundary.test.ts`).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import type {
  ActivationVerdict,
  ArtifactModule,
  AssetInventory,
  CompileArtifact,
  DeploymentAsset,
  DerivedOperationInputs,
} from "@canlang/contracts";
import { ASSET_DIGEST_V2 } from "@canlang/contracts";
import { catalogFromArtifactOperations } from "@canlang/interfaces";
import { STDLIB_SPECIFIER, UI_SPECIFIER, type AssembledModules } from "../runtime/modules.js";

/** Main module key: the deployed worker entry within the module map. */
export const DEPLOY_MAIN_MODULE = "worker/main.js";
/** MCP handler key: the sibling `./mcp-handler.js` bundle convention. */
export const MCP_HANDLER_MODULE = "worker/mcp-handler.js";
/** HTTP operations key: the sibling `./http-operations.js` bundle convention (C3). */
export const HTTP_OPERATIONS_MODULE = "worker/http-operations.js";
/** Staged-deployment key: the sibling `./artifact.js` join contract. */
export const ARTIFACT_MODULE = "worker/artifact.js";
/** Derived-inputs key: the sibling `./derived-inputs.js` E1 join contract (C1 bake). */
export const DERIVED_INPUTS_MODULE = "worker/derived-inputs.js";
/** Assembly key: the base every portable module URL resolves against. */
const ASSEMBLY_MODULE_KEY = "worker/assembly.js";
/**
 * Pinned runtime files staged under `runtime/`: exactly the dist files the
 * worker graph loads (assembly's `loadSiblingFn` set + main's P-C joins).
 * Everything else under `dist/runtime` imports node: builtins and stays out.
 */
const PINNED_RUNTIME_FILES: readonly string[] = [
  "context.js",
  "invoke.js",
  "sourcemap.js",
  "mcp-registry.js",
  "env-assembly.js",
  "grant-route.js",
  "mcp-permissions.js",
];
/** Deploy dir suffix: `<stem>.deploy/` next to the artifact. */
export const DEPLOY_DIR_SUFFIX = ".deploy";
/** Built worker entry this bundle stages (P-A serving entry, via build). */
export const WORKER_MAIN_DIST_RELATIVE = posix.join("packages", "cloudflare", "dist", "worker", "main.js");
/** Thrown error `code` when the built worker entry is missing. */
export const WORKER_MAIN_MISSING = "worker-main-missing";

/** Real-producer dists the MCP bundle is byte-built from (never stubbed). */
const INTERFACES_MCP_SERVER_DIST = posix.join(
  "packages",
  "interfaces",
  "dist",
  "interfaces",
  "src",
  "mcp",
  "server.js",
);
/** Real-producer dist the HTTP operations bundle is byte-built from (never stubbed). */
const INTERFACES_HTTP_OPERATIONS_DIST = posix.join(
  "packages",
  "interfaces",
  "dist",
  "interfaces",
  "src",
  "http",
  "operations.js",
);
const MCP_REGISTRY_DIST = posix.join("packages", "cloudflare", "dist", "runtime", "mcp-registry.js");

/**
 * Marker check, mirroring the e2e loader: the bundle MUST still export the
 * real handler chain after bundling, and MUST carry its own IdentityError
 * copy (see the `instanceof` invariant above) — a skewed bundle refuses.
 */
export const MCP_BUNDLE_MARKERS: readonly string[] = [
  "createMcpHandler",
  "createArtifactRegistry",
  "createArtifactCatalog",
  "IdentityError",
];

/**
 * C3 marker set for the HTTP operations bundle: the real op chain and
 * the bundle's own `IdentityError` copy (the op handler catches
 * `IdentityError` from request identity resolution, so the same
 * no-mixing invariant as MCP applies).
 */
export const HTTP_BUNDLE_MARKERS: readonly string[] = [
  "handleOperationRequest",
  "IdentityError",
];

interface VendorTree {
  distSubdir: string;
  prefix: string;
  buildCommand: string;
}

/** Producer dist trees vendored into the map (fixed order; walks sorted). */
const VENDOR_TREES: readonly VendorTree[] = [
  { distSubdir: posix.join("packages", "contracts", "dist"), prefix: "vendor/contracts", buildCommand: "bun run build" },
  { distSubdir: posix.join("packages", "contracts", "dist"), prefix: "contracts/src", buildCommand: "bun run build" },
  { distSubdir: posix.join("packages", "ui", "dist", "ui", "src"), prefix: "vendor/ui", buildCommand: "bun run --filter @canlang/ui build" },
  {
    distSubdir: posix.join("packages", "identity", "dist", "identity", "src"),
    prefix: "vendor/identity",
    buildCommand: "bun run --filter @canlang/identity build",
  },
  { distSubdir: posix.join("packages", "stdlib", "dist", "src"), prefix: "vendor/stdlib", buildCommand: "bun run build" },
  {
    distSubdir: posix.join("packages", "state", "dist", "state", "src"),
    prefix: "vendor/state",
    buildCommand: "bun run build",
  },
  {
    distSubdir: posix.join("packages", "values", "dist", "values", "src"),
    prefix: "vendor/values",
    buildCommand: "bun run build:joins",
  },
];

/**
 * Staged keys never vendored: TEST-ONLY bridges with node-only imports
 * (see the walk exclusion). Exact keys, no blast radius.
 */
const TEST_ONLY_VENDOR_KEYS: ReadonlySet<string> = new Set([
  "vendor/state/fanout/work-loader.js",
  "vendor/state/receipt/work-loader.js",
]);

/** Vendor entry keys (mirroring each package's `main`). */
const UI_VENDOR_ENTRY = "vendor/ui/index.js";
const STDLIB_VENDOR_ENTRY = "vendor/stdlib/index.js";
const IDENTITY_VENDOR_ENTRY = "vendor/identity/index.js";
/** Mirrors `@canlang/contracts` package `main` (`./dist/index.js`). */
const CONTRACTS_VENDOR_ENTRY = "vendor/contracts/index.js";
const STATE_D1_VENDOR_ENTRY = "vendor/state/storage/d1.js";
const VALUES_VENDOR_ENTRY = "vendor/values/index.js";

export interface BuildDeployBundleOptions {
  /** Workspace root used to resolve built producer dists. */
  repoRoot: string;
  /**
   * Built worker dir to stage (default
   * `<repoRoot>/packages/cloudflare/dist/worker`). Tests stage a fake.
   */
  workerDistDir?: string;
  /**
   * Built runtime dir for the pinned `runtime/` set (default
   * `<repoRoot>/packages/cloudflare/dist/runtime`).
   */
  runtimeDistDir?: string;
  /** Deploy-time `activate()` verdict, staged verbatim into `artifact.js`. */
  verdict: ActivationVerdict;
}

export interface DeployBundle {
  /** Main module key (`worker/main.js`); always present in `modules`. */
  mainModule: string;
  /** Portable ESM name -> source map (sorted keys, no file-URLs, no CJS). */
  modules: Record<string, string>;
  /** Module count (== `Object.keys(modules).length`). */
  moduleCount: number;
  /** sha256 over the canonical (sorted) module serialization. */
  sha256: string;
  /** Byte size of the MCP handler bundle (proof of a real bundle). */
  mcpBundleBytes: number;
  /** Byte size of the HTTP operations bundle (proof of a real bundle). */
  httpOperationsBytes: number;
}

export interface WrittenDeployBundle {
  dir: string;
  /** Absolute path of the written main module (the wrangler `main`). */
  mainFile: string;
  /** Absolute paths written, sorted. */
  files: string[];
}

/** Deploy-dir main as written into `wrangler.main` (relative to the toml). */
export function deployBundleMain(stem: string): string {
  return `./${stem}${DEPLOY_DIR_SUFFIX}/${DEPLOY_MAIN_MODULE}`;
}

/** Portable `AssembledModules`: URLs resolve against `worker/assembly.js`. */
function portableAssembledModules(modulePaths: readonly string[]): AssembledModules {
  const moduleUrls: Record<string, string> = {};
  for (const path of [...modulePaths].sort()) {
    moduleUrls[path] = relativeSpecifier(ASSEMBLY_MODULE_KEY, path);
  }
  const entry = modulePaths[0] as string;
  return { dir: "", entryUrl: relativeSpecifier(ASSEMBLY_MODULE_KEY, entry), moduleUrls };
}

/** Render the P-B staged deployment (`worker/artifact.js`) source. */
function renderStagedDeployment(
  artifact: CompileArtifact,
  modules: AssembledModules,
  verdict: ActivationVerdict,
): string {
  return (
    `// Generated by can-platform deploy (P-B staged deployment). Do not edit.\n` +
    `export const artifact = ${JSON.stringify(artifact)};\n` +
    `export const modules = ${JSON.stringify(modules)};\n` +
    `export const verdict = ${JSON.stringify(verdict)};\n`
  );
}

function withCode(error: Error, code: string): Error {
  (error as Error & { code?: string }).code = code;
  return error;
}

function assertFileBuilt(repoRoot: string, distRelative: string, buildCommand: string): string {
  const full = join(repoRoot, distRelative);
  try {
    if (!statSync(full).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(
      `deploy bundle: ${distRelative} not built; run \`${buildCommand}\` first`,
    );
  }
  return full;
}

/** Stage the built worker dist under `worker/`: `main.js` + top-level siblings. */
function stageWorkerDist(workerDistDir: string): Record<string, string> {
  const mainFile = join(workerDistDir, basename(WORKER_MAIN_DIST_RELATIVE));
  try {
    if (!statSync(mainFile).isFile()) throw new Error("not a file");
  } catch {
    throw withCode(
      new Error(
        `deploy bundle: worker entry not built at ${mainFile} ` +
          `(want ${WORKER_MAIN_DIST_RELATIVE} from the P-A serving entry); ` +
          `run \`bun run build\` first`,
      ),
      WORKER_MAIN_MISSING,
    );
  }
  // Top-level `.js` only (main + its relative siblings such as assembly and
  // entry): the worker dist is flat, and `./…` imports inside it resolve
  // within `worker/`. Deterministic order.
  const staged: Record<string, string> = {};
  for (const entry of readdirSync(workerDistDir).sort()) {
    if (!entry.endsWith(".js")) continue;
    const full = join(workerDistDir, entry);
    if (!statSync(full).isFile()) continue;
    staged[`worker/${entry}`] = readFileSync(full, "utf8");
  }
  return staged;
}

/**
 * Stage the pinned runtime set under `runtime/`. Every file is required:
 * assembly's `loadSiblingFn` set is load-bearing for pages/MCP/invocation
 * and main's P-C joins are load-bearing for deps/grants — a missing file
 * is build skew, never a silent degradation.
 */
function stageRuntimeDist(runtimeDistDir: string): Record<string, string> {
  const staged: Record<string, string> = {};
  for (const name of PINNED_RUNTIME_FILES) {
    const full = join(runtimeDistDir, name);
    try {
      if (!statSync(full).isFile()) throw new Error("not a file");
    } catch {
      throw new Error(
        `deploy bundle: runtime sibling ${name} not built at ${full}; ` +
          `run \`bun run build\` first`,
      );
    }
    const key = `runtime/${name}`;
    staged[key] = rewriteRuntimeImports(readFileSync(full, "utf8"), key);
  }
  return staged;
}

/** Sorted vendor-tree read, mirroring the e2e loader (never stubbed). */
function readVendorTree(repoRoot: string, tree: VendorTree): Record<string, string> {
  const base = join(repoRoot, tree.distSubdir);
  try {
    if (!statSync(base).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`deploy bundle: ${tree.distSubdir} not built; run \`${tree.buildCommand}\` first`);
  }
  const modules: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".js")) continue;
      // T16a-followup: colocated unit tests emit beside sources (node --test
      // runs them from dist) but must never vendor — workerd has no
      // node:test resolution. The deploy-bundle/cli suites pin this.
      if (entry.endsWith(".test.js")) continue;
      // C4: TEST-ONLY bridges emit beside sources under non-test names
      // (state's `work-loader.js` file-URL juggling for the T25/F5 join
      // proofs: node:url/node:path, zero non-test importers — comments
      // only). They are test code the suffix rule cannot see; never
      // vendor them, same rule as above. If lane B relocates these
      // helpers under `test/`, the entries below become no-ops (prune
      // then); a newly added node-only helper fails the link check
      // loud, as before.
      const vendorKey = `${tree.prefix}/${relative(base, full).split(sep).join("/")}`;
      if (TEST_ONLY_VENDOR_KEYS.has(vendorKey)) continue;
      const key = `${tree.prefix}/${relative(base, full).split(sep).join("/")}`;
      modules[key] = rewriteVendorImports(readFileSync(full, "utf8"), key);
    }
  };
  walk(base);
  if (Object.keys(modules).length === 0) {
    throw new Error(
      `deploy bundle: no .js modules found under ${tree.distSubdir}; run \`${tree.buildCommand}\``,
    );
  }
  return modules;
}

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

/** Module-relative specifier from one map key to another (`./…` form). */
function relativeSpecifier(fromModule: string, toKey: string): string {
  const rel = posix.relative(posix.dirname(fromModule), toKey);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function validateArtifactImports(modules: readonly ArtifactModule[]): void {
  const known = new Set(modules.map((m) => m.path));
  for (const mod of modules) {
    for (const spec of collectSpecifiers(mod.js)) {
      if (spec === STDLIB_SPECIFIER || spec === UI_SPECIFIER) continue;
      if (isRelativeSpecifier(spec)) {
        const target = posix.normalize(posix.join(posix.dirname(mod.path), spec));
        if (!known.has(target)) {
          throw new Error(
            `deploy bundle: module ${JSON.stringify(mod.path)} imports ` +
              `${JSON.stringify(spec)} (resolves to ${JSON.stringify(target)}): ` +
              `no such artifact module`,
          );
        }
        continue;
      }
      throw new Error(
        `deploy bundle: module ${JSON.stringify(mod.path)} has unresolvable import ` +
          `${JSON.stringify(spec)} (only ${STDLIB_SPECIFIER}, ${UI_SPECIFIER}, ` +
          `and relative imports are supported)`,
      );
    }
  }
}

function rewriteArtifactImports(js: string, modulePath: string): string {
  const mapped = (spec: string): string => {
    if (spec === STDLIB_SPECIFIER) return relativeSpecifier(modulePath, STDLIB_VENDOR_ENTRY);
    if (spec === UI_SPECIFIER) return relativeSpecifier(modulePath, UI_VENDOR_ENTRY);
    return spec;
  };
  const swap = (_full: string, pre: string, spec: string, post: string): string =>
    `${pre}${mapped(spec)}${post}`;
  return js
    .replace(FROM_SPECIFIER_RE, swap)
    .replace(DYNAMIC_IMPORT_RE, swap)
    .replace(SIDE_EFFECT_IMPORT_RE, swap);
}

/**
 * Checkout-resolving producer specifiers the P-C joins use (they resolve
 * in vitest/node from `src/`/`dist/` but never in the worker module map).
 * Rewritten to module-relative `vendor/` specifiers when staged.
 */
const IDENTITY_SOURCE_SPECIFIER = "@canlang/identity";
const STATE_D1_SOURCE_SPECIFIER = "../../../state/dist/state/src/storage/d1.js";
const VALUES_SOURCE_SPECIFIER = "@canlang/values";
/** Contracts version constants (`loadContractVersions` in pinned `invoke.js`). */
const CONTRACTS_SOURCE_SPECIFIER = "@canlang/contracts";

/** Rewrite pinned-runtime producer imports to module-relative `vendor/` keys. */
function rewriteRuntimeImports(js: string, moduleKey: string): string {
  const mapped = (spec: string): string => {
    if (spec === IDENTITY_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, IDENTITY_VENDOR_ENTRY);
    if (spec === STATE_D1_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, STATE_D1_VENDOR_ENTRY);
    if (spec === CONTRACTS_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, CONTRACTS_VENDOR_ENTRY);
    return spec;
  };
  const swap = (_full: string, pre: string, spec: string, post: string): string =>
    `${pre}${mapped(spec)}${post}`;
  let out = js
    .replace(FROM_SPECIFIER_RE, swap)
    .replace(DYNAMIC_IMPORT_RE, swap)
    .replace(SIDE_EFFECT_IMPORT_RE, swap);
  // The P-C joins hold their specifiers in consts (`import(IDENTITY_SPECIFIER)`),
  // so the import-syntax pass above cannot see them: rewrite the exact source
  // literals too. Each literal occurs exactly once (the const initializer —
  // error messages interpolate the const, so they name the bundle path too).
  for (const [source, entry] of [
    [IDENTITY_SOURCE_SPECIFIER, IDENTITY_VENDOR_ENTRY],
    [STATE_D1_SOURCE_SPECIFIER, STATE_D1_VENDOR_ENTRY],
    [CONTRACTS_SOURCE_SPECIFIER, CONTRACTS_VENDOR_ENTRY],
  ] as const) {
    out = out.split(source).join(relativeSpecifier(moduleKey, entry));
  }
  return out;
}

/**
 * Rewrite producer imports inside staged vendor trees. Vendor dists are
 * verbatim builds: today only `vendor/stdlib` carries a bare producer
 * import (`@canlang/values`), but the full map applies so the next bare
 * import fails loudly at the link check instead of sliding through —
 * mappings with no occurrence are exact no-ops.
 */
function rewriteVendorImports(js: string, moduleKey: string): string {
  const mapped = (spec: string): string => {
    if (spec === STDLIB_SPECIFIER) return relativeSpecifier(moduleKey, STDLIB_VENDOR_ENTRY);
    if (spec === UI_SPECIFIER) return relativeSpecifier(moduleKey, UI_VENDOR_ENTRY);
    if (spec === IDENTITY_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, IDENTITY_VENDOR_ENTRY);
    if (spec === VALUES_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, VALUES_VENDOR_ENTRY);
    return spec;
  };
  const swap = (_full: string, pre: string, spec: string, post: string): string =>
    `${pre}${mapped(spec)}${post}`;
  return js
    .replace(FROM_SPECIFIER_RE, swap)
    .replace(DYNAMIC_IMPORT_RE, swap)
    .replace(SIDE_EFFECT_IMPORT_RE, swap);
}

function assertSafeRelativePath(path: string, what: string): void {
  const normalized = posix.normalize(path);
  if (path === "" || posix.isAbsolute(path) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`deploy bundle: refusing ${what} outside the module map: ${JSON.stringify(path)}`);
  }
}

/** Stage artifact modules (production only: `tests[]` are erased). */
function stageArtifactModules(artifact: CompileArtifact): Record<string, string> {
  const modules = artifact.modules;
  if (modules.length === 0) {
    throw new Error("deploy bundle: artifact has no modules; modules[0] must be the entrypoint");
  }
  validateArtifactImports(modules);
  const known = new Set(modules.map((m) => m.path));
  for (const page of artifact.pages) {
    if (!known.has(page.module)) {
      throw new Error(
        `deploy bundle: page ${page.path} references unknown module ` +
          `${JSON.stringify(page.module)} (recompile with the fixed \`can compile\`)`,
      );
    }
  }
  for (const callable of artifact.callables) {
    if (!known.has(callable.module)) {
      throw new Error(
        `deploy bundle: callable ${callable.id} references unknown module ` +
          `${JSON.stringify(callable.module)} (recompile with the fixed \`can compile\`)`,
      );
    }
  }
  const staged: Record<string, string> = {};
  for (const mod of modules) {
    assertSafeRelativePath(mod.path, "to stage module");
    staged[mod.path] = rewriteArtifactImports(mod.js, mod.path);
  }
  return staged;
}

/**
 * Build the `derived-inputs.js` module (C1): the REAL interfaces
 * derivation (`catalogFromArtifactOperations`) for the staged
 * artifact's operations, baked to data at deploy time. The worker
 * serves it verbatim through the catalog's E1 `derivedFor` channel
 * — no parallel derivation rule exists anywhere. Malformed
 * operations or version skew throw here (the derivation's own
 * loud errors); the bake covers every staged operation exactly.
 */
function buildDerivedInputsModule(artifact: CompileArtifact): string {
  const catalog = catalogFromArtifactOperations(artifact);
  const baked: Record<string, DerivedOperationInputs> = {};
  for (const op of artifact.operations ?? []) {
    const derived = catalog.derivedFor(op.name);
    if (derived === null) {
      throw new Error(
        `deploy bundle: derived bake produced no inputs for operation ${JSON.stringify(op.name)} ` +
          `(derivation skew)`,
      );
    }
    baked[op.name] = derived;
  }
  return `export const derivedInputs = ${JSON.stringify(baked)};\n`;
}

/**
 * Build the `mcp-handler.js` module: the real MCP handler chain bundled
 * self-contained for workerd. Mirrors the e2e loader's `buildMcpBundle`
 * (same flags, same marker check, same loud errors) with a generated entry
 * using absolute dist paths so tmp paths never leak into bundle bytes.
 */
function buildMcpBundle(repoRoot: string): string {
  const serverDist = assertFileBuilt(
    repoRoot,
    INTERFACES_MCP_SERVER_DIST,
    "bun run --filter @canlang/interfaces build",
  );
  const registryDist = assertFileBuilt(
    repoRoot,
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
      `deploy bundle: MCP bundle build failed (\`bun build\` on the generated entry); ` +
        `the MCP SDK must resolve (run \`bun install\`) and both producer dists must be built. ` +
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
          `(rebuild the producer dists and retry)`,
      );
    }
  }
  return contents;
}

/**
 * Build the `http-operations.js` module (C3): the real HTTP op-POST
 * chain bundled self-contained for workerd. Mirrors `buildMcpBundle`
 * (same flags, same marker check, same loud errors) with a pure
 * re-export entry: any entry-local code makes bun emit an
 * entry-path comment that leaks the random tmpdir and breaks bundle
 * determinism, so the main's join-contract currying lives in stable
 * main source instead (see `defaultLoadHttpOperationsFactory`).
 */
function buildHttpOperationsBundle(repoRoot: string): string {
  const operationsDist = assertFileBuilt(
    repoRoot,
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
      `deploy bundle: HTTP bundle build failed (\`bun build\` on the generated entry); ` +
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
          `(rebuild the producer dists and retry)`,
      );
    }
  }
  return contents;
}

/* ------------------------------------------------------------------ */
/* workerd-loadability scan: no node file-URLs, no real CJS.            */
/*                                                                     */
/* Two subtleties keep this scan honest on REAL bundler output:        */
/* - String literals and comments are blanked before scanning (the MCP  */
/*   SDK embeds `require("ajv/dist/…")` codegen strings and a           */
/*   `startsWith("file://")` zod check — none of it executable CJS).   */
/* - `__commonJS(…)` regions are blanked: bun's CJS-interop wrapper     */
/*   binds `exports`/`module` as parameters, so wrapped CJS deps load   */
/*   as self-contained ESM in workerd. Only UNWRAPPED CJS refuses.      */
/* ------------------------------------------------------------------ */

function blankStringsAndComments(source: string, keepStrings = false): string {
  const out = source.split("");
  const length = source.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  let i = 0;
  while (i < length) {
    const c = source[i];
    const d = source[i + 1];
    if (c === "/" && d === "/") {
      let j = i + 2;
      while (j < length && source[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && d === "*") {
      const j = source.indexOf("*/", i + 2);
      const end = j === -1 ? length : j + 2;
      blank(i, end);
      i = end;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < length) {
        if (source[j] === "\\") j += 2;
        else if (source[j] === c) {
          j++;
          break;
        } else j++;
      }
      // keepStrings (link check): string contents stay live so import
      // specifiers survive; comments are still blanked above.
      if (!keepStrings) blank(i, j);
      i = j;
    } else if (c === "`") {
      // Template literal: blank text spans, keep `${…}` code live.
      // keepStrings keeps plain strings but still blanks template text
      // (error-message prose must never read as an import).
      let j = i + 1;
      let segment = i;
      while (j < length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "`") {
          blank(segment, j + 1);
          j++;
          break;
        }
        if (source[j] === "$" && source[j + 1] === "{") {
          blank(segment, j);
          let depth = 1;
          j += 2;
          while (j < length && depth > 0) {
            if (source[j] === "{") depth++;
            else if (source[j] === "}") depth--;
            j++;
          }
          segment = j;
          continue;
        }
        j++;
      }
      if (j >= length) blank(segment, length);
      i = j;
    } else {
      i++;
    }
  }
  return out.join("");
}

function blankCommonJsWrappers(source: string): string {
  const out = source.split("");
  const length = source.length;
  const tag = "__commonJS(";
  let i = 0;
  while ((i = source.indexOf(tag, i)) !== -1) {
    let j = i + tag.length;
    let depth = 1;
    let inString: string | null = null;
    while (j < length && depth > 0) {
      const c = source[j] as string;
      if (inString !== null) {
        if (c === "\\") j += 2;
        else if (c === inString) {
          inString = null;
          j++;
        } else j++;
      } else if (c === "'" || c === '"' || c === "`") {
        inString = c;
        j++;
      } else if (c === "(") {
        depth++;
        j++;
      } else if (c === ")") {
        depth--;
        j++;
      } else j++;
    }
    for (let k = i; k < j; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
    i = j;
  }
  return out.join("");
}

const FILE_URL_IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']file:\/\//g;
const BARE_REQUIRE_RE = /(?<![\w$.])require\s*\(/g;
const MODULE_EXPORTS_RE = /(?<![\w$.])module\.exports/g;
const FREE_EXPORTS_RE = /(?<![\w$.])exports(?![\w$])(?!\s*:)/g;

function scanModuleIssues(source: string): string[] {
  const issues: string[] = [];
  for (const re of [FILE_URL_IMPORT_RE, BARE_REQUIRE_RE, MODULE_EXPORTS_RE, FREE_EXPORTS_RE]) {
    re.lastIndex = 0;
  }
  let match: RegExpExecArray | null;
  while ((match = FILE_URL_IMPORT_RE.exec(source)) !== null) {
    issues.push(`node file-URL import at offset ${match.index}`);
  }
  const stripped = blankCommonJsWrappers(blankStringsAndComments(source));
  while ((match = BARE_REQUIRE_RE.exec(stripped)) !== null) {
    // `export function require(…)` is @canlang/stdlib's guard helper, not CJS.
    if (/function\s+$/.test(stripped.slice(Math.max(0, match.index - 9), match.index))) continue;
    issues.push(`bare require( call at offset ${match.index}`);
  }
  while ((match = MODULE_EXPORTS_RE.exec(stripped)) !== null) {
    issues.push(`CommonJS module.exports at offset ${match.index}`);
  }
  while ((match = FREE_EXPORTS_RE.exec(stripped)) !== null) {
    issues.push(`CommonJS free exports at offset ${match.index}`);
  }
  return issues;
}

/**
 * Refuse any module that workerd cannot load as ESM: node file-URL imports
 * or real (unwrapped) CommonJS. Bundler `__commonJS` interop, quoted
 * tokens, and the stdlib `require` guard pass (proven by tests).
 */
export function assertWorkerdLoadable(modules: Readonly<Record<string, string>>): void {
  for (const [name, contents] of Object.entries(modules)) {
    const issues = scanModuleIssues(contents);
    if (issues.length > 0) {
      const extra = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
      throw new Error(
        `deploy bundle: module ${JSON.stringify(name)} is not workerd-loadable: ` +
          `${issues[0]}${extra}`,
      );
    }
  }
}

/**
 * Refuse dangling imports: every relative specifier in every staged module
 * must resolve to a staged key, and no bare specifier may survive (workerd
 * has no package resolution). Same blanking honesty as the loadability
 * scan. This is the check that fails the build when a staged module
 * imports a checkout-only path (the P-C/P-B skew class: real files,
 * unresolvable-in-worker specifiers).
 */
/**
 * Whether a static-import match sits at a statement start: only whitespace
 * may precede it back to the string start, a newline, or `;`/`{`/`}`.
 * Data files contain `"import", "` prose (ui catalog) that the loose
 * `import "…"` form misreads; real static imports in tsc/bun output
 * always sit at statement starts. (Deliberately NOT a regex anchor:
 * `(?:^|[;{}])…/m` backtracks catastrophically on minified bundles —
 * measured 6s; this check is O(1) per match instead.)
 */
function isStatementStart(js: string, matchIndex: number): boolean {
  let i = matchIndex - 1;
  while (i >= 0 && (js[i] === " " || js[i] === "\t" || js[i] === "\r")) i--;
  if (i < 0) return true;
  const c = js[i];
  return c === "\n" || c === ";" || c === "{" || c === "}";
}

function collectLinkSpecifiers(js: string): string[] {
  const specs: string[] = [];
  for (const re of [FROM_SPECIFIER_RE, DYNAMIC_IMPORT_RE, SIDE_EFFECT_IMPORT_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(js)) !== null) {
      // Static forms must belong to a real import statement (see above);
      // dynamic import() appears mid-expression and keeps the loose form.
      if (re === SIDE_EFFECT_IMPORT_RE && !isStatementStart(js, match.index)) continue;
      if (re === FROM_SPECIFIER_RE) {
        // Stop only at statement boundaries: brace imports (`import {..}
        // from`, minified `import{x}from`) and every re-export form
        // (`export {..} from`, `export * from`) carry braces by construction.
        let i = match.index - 1;
        while (i >= 0 && js[i] !== "\n" && js[i] !== ";") i--;
        if (!/\b(import|export)\b/.test(js.slice(i + 1, match.index))) continue;
      }
      // All three patterns capture the spec in group 2.
      const spec = match[2];
      if (spec !== undefined) specs.push(spec);
    }
  }
  return specs;
}

export function assertLinksResolve(modules: Readonly<Record<string, string>>): void {
  const keys = new Set(Object.keys(modules));
  for (const [name, contents] of Object.entries(modules)) {
    const stripped = blankCommonJsWrappers(blankStringsAndComments(contents, true));
    for (const spec of collectLinkSpecifiers(stripped)) {
      if (!isRelativeSpecifier(spec)) {
        throw new Error(
          `deploy bundle: module ${JSON.stringify(name)} has bare import ` +
            `${JSON.stringify(spec)} (no package resolution in workerd)`,
        );
      }
      const target = posix.normalize(posix.join(posix.dirname(name), spec));
      if (!keys.has(target)) {
        throw new Error(
          `deploy bundle: module ${JSON.stringify(name)} imports ${JSON.stringify(spec)} ` +
            `(resolves to ${JSON.stringify(target)}): no such staged module`,
        );
      }
    }
  }
}

function bundleSha256(mainModule: string, modules: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(modules).sort()) {
    sorted[key] = modules[key] as string;
  }
  return createHash("sha256").update(JSON.stringify({ mainModule, modules: sorted })).digest("hex");
}

/**
 * Build the portable deploy module map. Loud on: missing worker entry
 * (`WORKER_MAIN_MISSING`), missing pinned runtime siblings or producer
 * dists (naming the build command), unresolvable artifact imports,
 * dangling page/callable refs, MCP bundle build failure, dropped markers,
 * or a failing loadability scan. Deterministic: same inputs (including
 * the verdict) => identical modules + sha256.
 */
export function buildDeployBundle(
  artifact: CompileArtifact,
  options: BuildDeployBundleOptions,
): DeployBundle {
  const workerDistDir =
    options.workerDistDir ?? join(options.repoRoot, "packages", "cloudflare", "dist", "worker");
  const runtimeDistDir =
    options.runtimeDistDir ?? join(options.repoRoot, "packages", "cloudflare", "dist", "runtime");
  const stagedArtifact = stageArtifactModules(artifact);
  const modules: Record<string, string> = {
    ...stageWorkerDist(workerDistDir),
    ...stageRuntimeDist(runtimeDistDir),
    ...stagedArtifact,
  };
  for (const tree of VENDOR_TREES) {
    Object.assign(modules, readVendorTree(options.repoRoot, tree));
  }
  modules[MCP_HANDLER_MODULE] = buildMcpBundle(options.repoRoot);
  modules[HTTP_OPERATIONS_MODULE] = buildHttpOperationsBundle(options.repoRoot);
  modules[ARTIFACT_MODULE] = renderStagedDeployment(
    artifact,
    portableAssembledModules(artifact.modules.map((mod) => mod.path)),
    options.verdict,
  );
  modules[DERIVED_INPUTS_MODULE] = buildDerivedInputsModule(artifact);
  assertWorkerdLoadable(modules);
  assertLinksResolve(modules);
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(modules).sort()) {
    sorted[key] = modules[key] as string;
  }
  return {
    mainModule: DEPLOY_MAIN_MODULE,
    modules: sorted,
    moduleCount: Object.keys(sorted).length,
    sha256: bundleSha256(DEPLOY_MAIN_MODULE, sorted),
    mcpBundleBytes: (sorted[MCP_HANDLER_MODULE] as string).length,
    httpOperationsBytes: (sorted[HTTP_OPERATIONS_MODULE] as string).length,
  };
}

/**
 * Write the bundle to `outDir` (created), preserving module-map-relative
 * paths, plus a `bundle.json` manifest (main, sha, keys, byte sizes) for
 * reviewability. Deterministic bytes for the same bundle.
 */
export function writeDeployBundle(bundle: DeployBundle, outDir: string): WrittenDeployBundle {
  const dir = outDir;
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const key of Object.keys(bundle.modules).sort()) {
    assertSafeRelativePath(key, "to write module");
    const full = join(dir, key);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bundle.modules[key] as string, "utf8");
    files.push(full);
  }
  const manifest = {
    mainModule: bundle.mainModule,
    sha256: bundle.sha256,
    moduleCount: bundle.moduleCount,
    mcpBundleBytes: bundle.mcpBundleBytes,
    httpOperationsBytes: bundle.httpOperationsBytes,
    modules: Object.keys(bundle.modules)
      .sort()
      .map((key) => ({ key, bytes: (bundle.modules[key] as string).length })),
  };
  const manifestFile = join(dir, "bundle.json");
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  files.push(manifestFile);
  files.sort();
  return { dir, mainFile: join(dir, bundle.mainModule), files };
}

/* ------------------------------------------------------------------ */
/* C04.asset: typed text/binary inventory + versioned mixed digests.     */
/* The v1 text-only path above is untouched: same inputs still yield    */
/* identical modules, sha256, manifest bytes, and file layout. Binary  */
/* assets travel alongside (never through) the text rewriting/linking  */
/* stages, which stay text-only.                                        */
/* ------------------------------------------------------------------ */

/** A text-only bundle plus staged binary modules and their v2 digest. */
export interface MixedDeployBundle extends DeployBundle {
  /** Binary module key -> raw bytes (never empty-keyed, never colliding with text keys). */
  binaries: Record<string, Uint8Array>;
  /** `ASSET_DIGEST_V2` over the full typed inventory (text + binary). */
  mixedSha256: string;
}

/**
 * Build the typed inventory for one bundle: text modules become text
 * assets, binaries become binary assets. A key present in both maps is
 * a loud error (no silent shadowing in either direction), as is an
 * empty key (unwritable by definition).
 */
export function inventorizeAssets(
  modules: Record<string, string>,
  binaries: Record<string, Uint8Array> = {},
): AssetInventory {
  const inventory: Record<string, DeploymentAsset> = {};
  for (const [key, text] of Object.entries(modules)) {
    if (key === "") {
      throw new Error("deploy bundle: text module key must not be empty");
    }
    inventory[key] = { kind: "text", text };
  }
  for (const [key, bytes] of Object.entries(binaries)) {
    if (key === "") {
      throw new Error("deploy bundle: binary module key must not be empty");
    }
    if (inventory[key] !== undefined) {
      throw new Error(`deploy bundle: binary key ${JSON.stringify(key)} collides with a text module`);
    }
    inventory[key] = { kind: "binary", bytes };
  }
  return inventory;
}

/**
 * Writer-generated manifest paths, reserved across the whole mixed
 * inventory. No text or binary module may normalize to one of these:
 * the writer owns them and would otherwise silently overwrite module
 * bytes (or module bytes would overwrite the manifest).
 */
const RESERVED_MIXED_OUTPUTS: ReadonlySet<string> = new Set(["bundle.json", "bundle.mixed.json"]);

/**
 * Pre-write output-layout validation for mixed bundles. Runs BEFORE
 * any output write: containment for every key, normalized-alias
 * rejection across text+binary maps (`worker/./main.js` aliases
 * `worker/main.js`), and reserved-manifest reservation. Loud errors
 * only; the v1 text-only writer is untouched by this check.
 */
function assertMixedOutputLayout(
  modules: Record<string, string>,
  binaries: Record<string, Uint8Array>,
): void {
  const seen = new Map<string, string>();
  const consider = (key: string, what: string): void => {
    assertSafeRelativePath(key, what);
    const normalized = posix.normalize(key);
    if (RESERVED_MIXED_OUTPUTS.has(normalized)) {
      throw new Error(
        `deploy bundle: ${what} ${JSON.stringify(key)} reserves writer manifest path ${JSON.stringify(normalized)}`,
      );
    }
    const prior = seen.get(normalized);
    if (prior !== undefined) {
      throw new Error(
        `deploy bundle: ${what} ${JSON.stringify(key)} aliases ${JSON.stringify(prior)} after normalization`,
      );
    }
    seen.set(normalized, key);
  };
  for (const key of Object.keys(modules)) consider(key, "to write text module");
  for (const key of Object.keys(binaries)) consider(key, "to write binary module");
}

/** Byte-copy every binary map entry: the snapshot owns its bytes. */
function snapshotBinaries(binaries: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const snapshot: Record<string, Uint8Array> = {};
  for (const [key, bytes] of Object.entries(binaries)) {
    snapshot[key] = new Uint8Array(bytes);
  }
  return snapshot;
}

/** sha256 of raw bytes, hex. Binary lengths/hashes are exact: no text normalization. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `ASSET_DIGEST_V2`: sha256 over length-prefixed mixed frames in
 * key-sorted order: u32be(keyUtf8) + key + u8(kind: 1=text, 2=binary)
 * + u64be(byteLength) + rawBytes. Deterministic for the same inventory.
 */
export function bundleMixedSha256(mainModule: string, inventory: AssetInventory): string {
  const hash = createHash("sha256");
  const encoder = new TextEncoder();
  const mainBytes = encoder.encode(mainModule);
  const mainLen = Buffer.alloc(4);
  mainLen.writeUInt32BE(mainBytes.length, 0);
  hash.update(mainLen);
  hash.update(mainBytes);
  for (const key of Object.keys(inventory).sort()) {
    const asset = inventory[key] as DeploymentAsset;
    const keyBytes = encoder.encode(key);
    const keyLen = Buffer.alloc(4);
    keyLen.writeUInt32BE(keyBytes.length, 0);
    hash.update(keyLen);
    hash.update(keyBytes);
    const raw = asset.kind === "binary" ? asset.bytes : encoder.encode(asset.text);
    hash.update(Buffer.from([asset.kind === "binary" ? 2 : 1]));
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(raw.length), 0);
    hash.update(len);
    hash.update(raw);
  }
  return hash.digest("hex");
}

/**
 * Attach binary modules to a built text-only bundle. The text bundle
 * (modules, sha256, counts) passes through untouched; the text map is
 * copied and every binary is byte-copied, so later caller mutation of
 * the input maps or buffers cannot change the returned bundle. The v2
 * digest covers exactly the attached snapshot.
 */
export function attachBinaries(
  bundle: DeployBundle,
  binaries: Record<string, Uint8Array>,
): MixedDeployBundle {
  const modules = { ...bundle.modules };
  const snapshot = snapshotBinaries(binaries);
  const inventory = inventorizeAssets(modules, snapshot);
  return {
    ...bundle,
    modules,
    binaries: snapshot,
    mixedSha256: bundleMixedSha256(bundle.mainModule, inventory),
  };
}

/**
 * Write a mixed bundle: text modules exactly as `writeDeployBundle`
 * (same paths, bytes, v1 manifest shape for the text half), binaries as
 * raw bytes, plus a versioned `bundle.mixed.json` manifest carrying the
 * digest version, both digests, and per-entry kind/bytes/sha256.
 *
 * Coherence (corrective): the writer snapshots the binaries, validates
 * the output layout (containment, normalized aliases, reserved
 * manifests) BEFORE any output write, then recomputes the v2 digest
 * over the exact output snapshot and rejects when it differs from the
 * bundle's cached aggregate. Caller or buffer mutation after attach
 * therefore fails loudly instead of shipping a lying manifest.
 */
export function writeDeployBundleMixed(bundle: MixedDeployBundle, outDir: string): WrittenDeployBundle {
  const modules = { ...bundle.modules };
  const binaries = snapshotBinaries(bundle.binaries);
  assertMixedOutputLayout(modules, binaries);
  const recomputed = bundleMixedSha256(bundle.mainModule, inventorizeAssets(modules, binaries));
  if (recomputed !== bundle.mixedSha256) {
    throw new Error(
      "deploy bundle: mixed digest mismatch — the bundle changed after attach; refusing to write",
    );
  }
  const written = writeDeployBundle({ ...bundle, modules }, outDir);
  const dir = written.dir;
  const binaryEntries: Array<{ key: string; kind: "binary"; bytes: number; sha256: string }> = [];
  for (const key of Object.keys(binaries).sort()) {
    assertSafeRelativePath(key, "to write binary module");
    const bytes = binaries[key] as Uint8Array;
    const full = join(dir, key);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
    binaryEntries.push({ key, kind: "binary", bytes: bytes.length, sha256: sha256Bytes(bytes) });
  }
  const manifest = {
    digestVersion: ASSET_DIGEST_V2,
    mainModule: bundle.mainModule,
    sha256: bundle.sha256,
    mixedSha256: bundle.mixedSha256,
    moduleCount: bundle.moduleCount,
    binaryCount: binaryEntries.length,
    binaries: binaryEntries,
  };
  const manifestFile = join(dir, "bundle.mixed.json");
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const files = [...written.files, ...binaryEntries.map((entry) => join(dir, entry.key)), manifestFile].sort();
  return { dir, mainFile: written.mainFile, files };
}
