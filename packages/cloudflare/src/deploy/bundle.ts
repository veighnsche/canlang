import { LocalCommandInterrupted, type LocalCommandLifetime } from "../cli/command-lifetime.js";
/**
 * P-B deploy bundler: `CompileArtifact` + built dists -> portable workerd
 * module map (the deploy `main` and everything it imports).
 *
 * Why this exists: `assembleModules` (`runtime/modules.ts`) emits node
 * file-URLs with an installed UI rewrite — shippable to a local node process,
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
 *   dist resolved through `@canlang/cloudflare/worker/main`. Missing
 *   `main.js` fails loud with `WORKER_MAIN_MISSING`.
 * - `worker/artifact.js` (GENERATED): the P-B staged deployment —
 *   `export const { artifact, modules, verdict }`, where `modules` is the
 *   PORTABLE `AssembledModules` (module-map-relative URLs, never node
 *   file-URLs) and `verdict` is the deploy-time `activate()` verdict the
 *   caller computed.
 * - `worker/mcp-handler.js`: the interfaces/MCP-SDK handler chain, `esbuild
 *   --bundle --platform=browser --format=esm` from a generated entry that
 *   re-exports ONLY the real `createMcpHandler` (interfaces dist, also
 *   aliased as `createHandler` for the main's join contract) and the real
 *   `createArtifactRegistry`/`createArtifactCatalog` (cloudflare dist) —
 *   mirroring `tests/e2e/fixtures/artifact-loader.ts` `buildMcpBundle`
 *   INCLUDING its marker check. Bundling (not vendoring) is required
 *   because transitive MCP SDK deps (ajv, content-type) ship CJS only.
 * - `worker/http-operations.js` (C3): the real `handleOperationRequest`
 *   POST chain, `esbuild --bundle --platform=browser --format=esm` from a pure
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
 *   `@canlang/stdlib` / `@canlang/ui` rewritten to the defining runtime
 *   and vendor entries (computed per importing module, so nested
 *   modules resolve correctly). Pages and callables reference staged
 *   modules by name and are validated, never silently dropped.
 * - `vendor/…` trees: package-owned exported distributions for contracts,
 *   ui, identity, stdlib, state, values, work-kernel. Producer imports
 *   become relative vendor keys; sorted staging excludes colocated tests
 *   and metadata.
 *   Worker/MCP/HTTP entries resolve through package exports, so installed
 *   consumers use the same build artifacts as checkout consumers.
 *   Nonliteral dynamic imports remain checked behaviorally by with-DB boot
 *   tests. The optional State receipt observer is still absent; its exact
 *   absence selects the genuine public Work receipt producer in Node/dev.
 *   Its portable receipt/observation closure is staged from owning exports;
 *   actual serving tests must qualify each host's absence/failure behavior.
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

import { parse as parseJavaScript } from "acorn";
import { analyze as analyzeScopes } from "eslint-scope";
import { walk as walkJavaScript } from "estree-walker";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveProducerFile } from "./producer-files.js";
import { gatherDeploymentAssets, type PackageAssetSelection, type PackageResource } from "./package-assets.js";
import { distribution as contractsDistribution } from "@canlang/contracts/distribution";
import { distribution as uiDistribution } from "@canlang/ui/distribution";
import * as nativeUiProducer from "@canlang/ui";
import { distribution as identityDistribution } from "@canlang/identity/distribution";
import { distribution as stdlibDistribution } from "@canlang/stdlib/distribution";
import { distribution as stateDistribution } from "@canlang/state/distribution";
import { distribution as workDistribution } from "@canlang/work/distribution";
import { distribution as valuesDistribution } from "@canlang/values/distribution";
import { distribution as interfacesDistribution } from "@canlang/interfaces/distribution";
import { distribution as servicesDistribution } from "@canlang/services/distribution";
import { distribution as workKernelDistribution } from "@canlang/work-kernel/distribution";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import type {
  ActivationVerdict,
  SourceMap,
  AssetInventory,
  CompileArtifact,
  DeploymentAsset,
  DerivedOperationInputs,
} from "@canlang/contracts";
import { ASSET_DIGEST_V2 } from "@canlang/contracts";
import { catalogFromArtifactOperations } from "@canlang/interfaces";
import { assetContentType } from "@canlang/interfaces/http/assets";
import { STDLIB_SPECIFIER, UI_SPECIFIER, type AssembledModules } from "../runtime/modules.js";
import { assertSavedUnitImports, GROUP_ORDER, isRelativeImportSpecifier as isRelativeSpecifier, rewriteModuleImports, scanModuleImports, validateArtifactModuleImports } from "./module-imports.js";
import type { ModuleImport } from "./module-imports.js";
import { composeModuleMap } from "./module-maps.js";
import { nativeUiQueryFacadeSource } from "../runtime/native-ui-query.js";

/** Main module key: the deployed worker entry within the module map. */
export const DEPLOY_MAIN_MODULE = "worker/main.js";
/** MCP handler key: the sibling `./mcp-handler.js` bundle convention. */
export const MCP_HANDLER_MODULE = "worker/mcp-handler.js";
/** HTTP operations key: the sibling `./http-operations.js` bundle convention (C3). */
export const HTTP_OPERATIONS_MODULE = "worker/http-operations.js";
/** Selected finite browser resources, using the defining Interfaces owners. */
export const HTTP_ASSETS_MODULE = "worker/http-assets.js";
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
  "stdlib.js",
  "native-records.js",
  "native-membership.js",
  "native-read-boolean.js",
  "native-scenario-require.js",
  "native-value-schema.js",
  "native-ui-query.js",
  "generation-callback-origin.js",
  "scenario-receipt-frame.js",
  "assembly-verification.js",
  "invoke.js",
  "invocation-errors.js",
  "resource-dispatch.js",
  "file-inventory.js",
  "d1-file-inventory.js",
  "r2-files.js",
  "worker-files.js",
  "bound-files.js",
  "bound-mail.js",
  "resource-host.js",
  "queue-runtime.js",
  "queue-file-retention.js",
  "root-authority.js",
  "root-authority-http.js",
  "root-authority-directory.js",
  "given-unique-keys.js",
  "bound-judgment.js",
  "input-choices.js",
  "receipt-staging.js",
  "file-staging.js",
  "opaque-file-staging.js",
  "sourcemap.js",
  "mcp-registry.js",
  "prepared-validation.js",
  "env-assembly.js",
  "export-downloads.js",
  "page-preferences.js",
  "page-cursor.js",
  "auth-rate-limiter.js",
  "cohort-tick.js",
  "grant-route.js",
  "mcp-permissions.js",
];
/** Deploy dir suffix: `<stem>.deploy/` next to the artifact. */
export const DEPLOY_DIR_SUFFIX = ".deploy";
/** Stage-local termination trigger and captured-output cap; not a whole-command
 * deadline or a guarantee about descendant processes or absolute exit time. */
const LOCAL_BUNDLE_BUILD_OPTIONS = {
  stdio: "pipe", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1_048_576,
} as const;

function bundleBuildOptions(lifetime?: LocalCommandLifetime) {
  return lifetime === undefined ? LOCAL_BUNDLE_BUILD_OPTIONS : {
    ...LOCAL_BUNDLE_BUILD_OPTIONS, timeout: lifetime.remainingMs(LOCAL_BUNDLE_BUILD_OPTIONS.timeout),
  };
}

function bundleStageFailure(error: unknown, lifetime?: LocalCommandLifetime): unknown {
  if (error instanceof LocalCommandInterrupted) return error;
  // Pin the operative stage outcome before cleanup can consume its budget.
  try { lifetime?.checkpoint("deploy esbuild failed"); } catch (interruption) { return interruption; }
  return error;
}

/** Keep the bundler outside the host event loop and under the same process
 * limits as other local tools. Resolve the JS API: esbuild's bin may be a
 * native executable after installation, so it cannot always be run by Node.
 * A stable stdin sourcefile keeps generated-entry scratch paths out of bytes. */
const ESBUILD_DRIVER = `
const [esbuild, entry, outfile, minifyWhitespace] = process.argv.slice(1);
const fs = require("node:fs"), path = require("node:path");
const result = require(esbuild).buildSync({
  stdin: { contents: fs.readFileSync(entry, "utf8"), resolveDir: path.dirname(entry), sourcefile: path.basename(entry) },
  bundle: true, platform: "browser", format: "esm", target: "esnext",
  minifyWhitespace: minifyWhitespace === "true", outfile, write: false, metafile: true,
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (imported.external) throw new Error("deploy bundle: refusing external import " + JSON.stringify(imported.path));
  }
}
for (const output of result.outputFiles) fs.writeFileSync(output.path, output.contents);
fs.writeFileSync(outfile + ".meta.json", JSON.stringify({ inputs: Object.keys(result.metafile.inputs) }));
`;

function runBrowserBundle(entry: string, output: string, lifetime?: LocalCommandLifetime, minifyWhitespace = false, execution: BundleExecutionOptions = {}): { metafileInputs: string[] | null } {
  execFileSync(process.execPath, ["--eval", ESBUILD_DRIVER, createRequire(import.meta.url).resolve("esbuild"), entry, output, String(minifyWhitespace)], {
    ...bundleBuildOptions(lifetime),
    ...(execution.esbuildBinaryPath === undefined ? {} : { env: { ...process.env, ESBUILD_BINARY_PATH: execution.esbuildBinaryPath } }),
  });
  return { metafileInputs: readBundleMetafileInputs(output, entry) };
}

/**
 * Exact esbuild input closure for one producer build, or null when the
 * metafile is absent or unreadable (mocked subprocesses, older drivers).
 * Metafile keys are process-relative, so they resolve against the calling
 * process directory (the driver's inherited working directory). Generated
 * scratch beneath the build directory is excluded: its bytes are already
 * keyed verbatim as the entry source, while its fresh paths would otherwise
 * defeat reuse. A null closure never qualifies for reuse.
 */
function readBundleMetafileInputs(output: string, entry: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(`${output}.meta.json`, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { inputs?: unknown }).inputs)) return null;
  const scratch = dirname(entry);
  const inputs: string[] = [];
  for (const input of (parsed as { inputs: unknown[] }).inputs) {
    if (typeof input !== "string" || !input) return null;
    const resolved = resolve(process.cwd(), input);
    if (resolved === scratch || resolved.startsWith(`${scratch}${sep}`)) continue;
    inputs.push(resolved);
  }
  return inputs.length === 0 ? null : inputs;
}

/** Thrown error `code` when the built worker entry is missing. */
export const WORKER_MAIN_MISSING = "worker-main-missing";

/** Real-producer dists the MCP bundle is byte-built from (never stubbed). */
export const INTERFACES_MCP_SERVER_DIST = "@canlang/interfaces/mcp/server";
/** Real-producer dist the HTTP operations bundle is byte-built from (never stubbed). */
export const INTERFACES_HTTP_OPERATIONS_DIST = "@canlang/interfaces/http/operations";
export const MCP_REGISTRY_DIST = "@canlang/cloudflare/runtime/mcp-registry";

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
  "receiverFromIdentity",
  "handleOperationRequest",
  "handlePageRequest",
  "handlePagePreferencePost",
  "handleAuthRequest",
  "parseJsonBody",
  "JSON_BODY_MAX_BYTES",
  "SESSION_EXPIRES_MS",
  "createSourceFormBindings",
  "IdentityError",
];

/** Producer bundle kind covered by exact-key reuse. */
export type ProducerBundleKind = "mcp" | "http";

/**
 * Opaque reusable producer-bundle candidate from a previous completed build.
 * The owning caller stores these verbatim and offers them back; the builder
 * revalidates every byte before reuse.
 */
export interface ProducerBundleCandidate {
  key: string;
  bytes: string;
  inputs: string[];
}

/** Completed producer-bundle record for the owner cache. */
export interface ProducerBundleRecord extends ProducerBundleCandidate {
  kind: ProducerBundleKind;
  reused: boolean;
}

/**
 * Per-kind reusable candidates supplied by the calling process. The builders
 * never trust these: an exact key match plus marker revalidation is required
 * before skipping the esbuild subprocess.
 */
export interface ProducerBundleCache {
  mcp?: ProducerBundleCandidate;
  http?: ProducerBundleCandidate;
}

const PRODUCER_BUNDLE_KEY_VERSION = 1;

/**
 * Exact esbuild identity for one producer build, or null when unresolvable.
 * @internal Exact key material for owning reuse fixtures; not an app API.
 */
export function producerToolId(execution: BundleExecutionOptions): string | null {
  let version: unknown;
  try {
    version = (JSON.parse(readFileSync(
      createRequire(import.meta.url).resolve("esbuild/package.json"), "utf8",
    )) as { version?: unknown }).version;
  } catch {
    return null;
  }
  if (typeof version !== "string" || !version) return null;
  return JSON.stringify({ version, binaryPath: execution.esbuildBinaryPath ?? null });
}

/**
 * Digest over the exact consumed input bytes, or null when any input is
 * unreadable. A null digest never qualifies for reuse. Nearest package.json
 * files ride along because their exports maps steer module resolution without
 * appearing in the metafile input list.
 */
/** @internal Exact key material for owning reuse fixtures; not an app API. */
export function hashProducerInputs(inputs: readonly string[]): string | null {
  const rows: string[] = [];
  for (const file of [...inputs].sort()) {
    let digest: string;
    try {
      digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    } catch {
      return null;
    }
    rows.push(`${digest}  ${file}`);
  }
  const manifestDigests = new Map<string, string>();
  for (const file of inputs) {
    let dir = dirname(file);
    for (let depth = 0; depth < 25; depth++) {
      const manifest = join(dir, "package.json");
      let digest = manifestDigests.get(manifest);
      if (digest === undefined) {
        try {
          digest = createHash("sha256").update(readFileSync(manifest)).digest("hex");
        } catch {
          digest = "";
        }
        manifestDigests.set(manifest, digest);
      }
      if (digest !== "") {
        rows.push(`manifest ${digest}  ${manifest}`);
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return createHash("sha256")
    .update(JSON.stringify({ version: PRODUCER_BUNDLE_KEY_VERSION, rows }))
    .digest("hex");
}

/** @internal Exact key material for owning reuse fixtures; not an app API. */
export function producerBundleKey(kind: ProducerBundleKind, entrySource: string, inputsDigest: string,
  toolId: string, minifyWhitespace: boolean): string {
  return createHash("sha256").update(JSON.stringify({
    version: PRODUCER_BUNDLE_KEY_VERSION,
    kind,
    entry: entrySource,
    inputs: inputsDigest,
    tool: toolId,
    minify: minifyWhitespace,
    // Fixed driver constants (platform/format/target) ride along verbatim:
    // any driver template edit changes this digest and invalidates reuse.
    driver: createHash("sha256").update(ESBUILD_DRIVER).digest("hex"),
  })).digest("hex");
}

function producerBundleMarkers(kind: ProducerBundleKind): readonly string[] {
  return kind === "mcp" ? MCP_BUNDLE_MARKERS : HTTP_BUNDLE_MARKERS;
}

function producerBundleFailure(kind: ProducerBundleKind, detail: string): Error {
  if (kind === "mcp") {
    return new Error(
      `deploy bundle: MCP bundle build failed (\`esbuild\` on the generated entry); ` +
      `the MCP SDK and esbuild must resolve and both producer dists must be built. ` +
      `Underlying error: ${detail}`,
    );
  }
  return new Error(
    `deploy bundle: HTTP bundle build failed (\`esbuild\` on the generated entry); ` +
    `the interfaces dist must be built. Underlying error: ${detail}`,
  );
}

function producerBundleDropped(kind: ProducerBundleKind, marker: string): Error {
  if (kind === "mcp") {
    return new Error(
      `deploy bundle: MCP bundle build dropped ${marker}; refusing a skewed bundle ` +
      `(rebuild the producer dists and retry)`,
    );
  }
  return new Error(
    `deploy bundle: HTTP bundle build dropped ${marker}; refusing a skewed bundle ` +
    `(rebuild the producer dists and retry)`,
  );
}

/**
 * Build one invariant producer bundle, reusing a validated candidate when its
 * exact identity matches. Returns the bytes plus the completed record (null
 * key when the build is uncacheable). The fresh-build path below mirrors the
 * defining builders' failure mapping, scratch lifecycle and messages
 * exactly; only completed, marker-checked output is ever admitted, and a
 * corrupt candidate falls back to a fresh build.
 */
function buildProducerBundle(kind: ProducerBundleKind, entryFileName: string, entrySource: string,
  lifetime: LocalCommandLifetime | undefined,
  execution: BundleExecutionOptions, candidate: ProducerBundleCandidate | undefined,
): { bytes: string; key: string | null; inputs: string[] | null; reused: boolean } {
  const toolId = producerToolId(execution);
  if (toolId !== null && candidate !== undefined) {
    const digest = hashProducerInputs(candidate.inputs);
    if (digest !== null &&
        candidate.key === producerBundleKey(kind, entrySource, digest, toolId, false)) {
      let markersOk = true;
      for (const marker of producerBundleMarkers(kind)) {
        if (!candidate.bytes.includes(marker)) {
          markersOk = false;
          break;
        }
      }
      if (markersOk) {
        lifetime?.checkpoint("deploy producer bundle verified");
        return { bytes: candidate.bytes, key: candidate.key, inputs: candidate.inputs, reused: true };
      }
    }
  }
  const workDir = mkdtempSync(join(execution.temporaryRoot ?? tmpdir(), `can-deploy-${kind}-`));
  const entryFile = join(workDir, entryFileName);
  const outFile = join(workDir, `${kind}-bundle.mjs`);
  let entryWritten = false;
  let metafileInputs: string[] | null = null;
  try {
    writeFileSync(entryFile, entrySource, "utf8");
    entryWritten = true;
    lifetime?.checkpoint("deploy esbuild start");
    metafileInputs = runBrowserBundle(entryFile, outFile, lifetime, false, execution).metafileInputs;
    lifetime?.checkpoint("deploy esbuild completed");
  } catch (err) {
    if (!entryWritten) {
      try {
        rmSync(workDir, { force: true, recursive: true });
      } finally {
        throw err;
      }
    }
    const failure = bundleStageFailure(err, lifetime);
    try {
      rmSync(workDir, { force: true, recursive: true });
    } finally {
      if (failure instanceof LocalCommandInterrupted) throw failure;
      const detail = err instanceof Error ? err.message : String(err);
      throw producerBundleFailure(kind, detail);
    }
  }
  let contents: string;
  try {
    contents = readFileSync(outFile, "utf8");
  } catch (err) {
    try {
      rmSync(workDir, { force: true, recursive: true });
    } finally {
      throw err;
    }
  }
  rmSync(workDir, { force: true, recursive: true });
  for (const marker of producerBundleMarkers(kind)) {
    if (!contents.includes(marker)) {
      throw producerBundleDropped(kind, marker);
    }
  }
  lifetime?.checkpoint("deploy producer bundle verified");
  if (toolId === null || metafileInputs === null) return { bytes: contents, key: null, inputs: null, reused: false };
  const digest = hashProducerInputs(metafileInputs);
  if (digest === null) return { bytes: contents, key: null, inputs: null, reused: false };
  return {
    bytes: contents,
    key: producerBundleKey(kind, entrySource, digest, toolId, false),
    inputs: metafileInputs,
    reused: false,
  };
}

interface VendorTree {
  directory: URL;
  prefix: string;
  buildCommand: string;
}

/** Producer-owned distributions; package resolution works in a checkout or installation. */
const VENDOR_TREES: readonly VendorTree[] = [
  { directory: contractsDistribution.modules, prefix: "vendor/contracts", buildCommand: "bun run --filter @canlang/contracts build" },
  { directory: uiDistribution.modules, prefix: "vendor/ui", buildCommand: "bun run --filter @canlang/ui build" },
  { directory: identityDistribution.modules, prefix: "vendor/identity", buildCommand: "bun run --filter @canlang/identity build" },
  { directory: stdlibDistribution.modules, prefix: "vendor/stdlib", buildCommand: "bun run --filter @canlang/stdlib build" },
  { directory: stateDistribution.modules, prefix: "vendor/state", buildCommand: "bun run --filter @canlang/state build" },
  { directory: valuesDistribution.modules, prefix: "vendor/values", buildCommand: "bun run --filter @canlang/values build" },
  // Values publishes its owned-input bindings beside (not beneath) the
  // module root; stage them for the bare and relative bindings imports in
  // the state/interfaces producers. This stages JavaScript only — the
  // optional WASM binary stays behind its explicit valuesWasm selection.
  { directory: valuesDistribution.bindings, prefix: "vendor/values/bindings", buildCommand: "bun run --filter @canlang/values build" },
  { directory: workKernelDistribution.modules, prefix: "vendor/work-kernel", buildCommand: "bun run --filter @canlang/work-kernel build" },
];

/**
 * Staged keys never vendored: TEST-ONLY fixtures and bridges with node-only imports
 * (see the walk exclusion). Exact keys, no blast radius.
 */
const TEST_ONLY_VENDOR_KEYS: ReadonlySet<string> = new Set([
  "vendor/state/fanout/work-loader.js",
  "vendor/state/receipt/work-loader.js",
  // Emitted work-kernel conformance modules: node:test-only, and their
  // `.wasm-test.js` names slip the shared `.test.js` suffix filter.
  "vendor/work-kernel/conformance/native-recovery.wasm-test.js",
  "vendor/work-kernel/conformance/work-kernel.wasm-test.js",
  // Shared Memory/D1/DO assertions have only maintained test importers.
  "vendor/state/storage/history-bounded-fixtures.js",
  // D3b Q3: the receipt join + worker-safe observer producers are
  // production-vendored — intentionally ABSENT here (present in the
  // vendor walk, resolved by the rewrite map above).
]);

/** Wasm bootstrap and glue enter only through the explicit Values asset selection. */
const OPT_IN_VALUES_VENDOR_KEYS: ReadonlySet<string> = new Set([
  "vendor/values/bindings/bootstrap.js",
  "vendor/values/bindings/generated/values_semantics.js",
]);

/** Native Node comparison is a production host leaf, never a Worker module. */
const NODE_HOST_VENDOR_KEYS: ReadonlySet<string> = new Set([
  "vendor/identity/sessions/comparison-node.js",
]);

/** Exact pinned browser entries resolved from the packages that own them. */
const BROWSER_DEPENDENCIES = [
  // Resolve the public import condition via its exported manifest; require's
  // root entry selects CJS, and source test transforms lack import.meta.resolve.
  { owner: import.meta.url, specifier: "acorn", manifestSpecifier: "acorn/package.json", name: "acorn", version: "8.18.0",
    entry: "dist/acorn.mjs", key: "vendor/acorn/acorn.js" },
  { owner: identityDistribution.modules, specifier: "cookie", name: "cookie", version: "2.0.1", entry: "dist/index.js", key: "vendor/cookie/index.js" },
  { owner: identityDistribution.modules, specifier: "@scure/base", name: "@scure/base", version: "2.4.0", entry: "index.js", key: "vendor/scure-base/index.js" },
  { owner: uiDistribution.modules, specifier: "csv-parse/browser/esm/sync", name: "csv-parse", version: "7.0.3", entry: "dist/esm/sync.js", key: "vendor/csv-parse/sync.js" },
  // Shared portable judgment/File digest closure; never stage a provider tree.
  { owner: servicesDistribution.modules, specifier: "@noble/hashes/sha2.js", name: "@noble/hashes", version: "2.4.0",
    entry: "sha2.js", key: "vendor/noble-hashes/sha2.js", siblings: ["_md.js", "_u64.js", "utils.js"] },
] as const;

function stageBrowserDependencies(): Record<string, string> {
  const modules: Record<string, string> = {};
  for (const dependency of BROWSER_DEPENDENCIES) {
    const owner = createRequire(dependency.owner);
    const entry = "manifestSpecifier" in dependency
      ? join(dirname(owner.resolve(dependency.manifestSpecifier)), dependency.entry)
      : owner.resolve(dependency.specifier);
    const packageRoot = resolve(entry, ...dependency.entry.split("/").map(() => ".."));
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      name?: string; version?: string; module?: string; exports?: { "."?: readonly { import?: string }[] };
    };
    if (manifest.name !== dependency.name || manifest.version !== dependency.version ||
        relative(packageRoot, entry).split(sep).join("/") !== dependency.entry ||
        ("manifestSpecifier" in dependency && (manifest.module !== dependency.entry ||
          manifest.exports?.["."]?.[0]?.import !== `./${dependency.entry}`))) {
      throw new Error(`deploy bundle: unexpected pinned browser entry for ${dependency.name}`);
    }
    modules[dependency.key] = readFileSync(entry, "utf8");
    if ("siblings" in dependency) {
      for (const sibling of dependency.siblings) {
        modules[`vendor/noble-hashes/${sibling}`] = readFileSync(join(packageRoot, sibling), "utf8");
      }
    }
  }
  return modules;
}

/** Vendor entry keys (mirroring each package's `main`). */
const UI_VENDOR_ENTRY = "vendor/ui/index.js";
const NATIVE_UI_RUNTIME_ENTRY = "runtime/native-ui.js";
const STDLIB_VENDOR_ENTRY = "vendor/stdlib/index.js";
/** Generated handlers use the same canonical data-plane owner as the CLI. */
const GENERATED_STDLIB_RUNTIME_ENTRY = "runtime/stdlib.js";
const IDENTITY_VENDOR_ENTRY = "vendor/identity/index.js";
/** Mirrors `@canlang/contracts` package `main` (`./dist/index.js`). */
const CONTRACTS_VENDOR_ENTRY = "vendor/contracts/index.js";
const STATE_D1_VENDOR_ENTRY = "vendor/state/storage/d1.js";
const STATE_VENDOR_ENTRY = "vendor/state/index.js";
/** D3b receipt producers (C's Q2 contract vendor keys). */
const STATE_RECEIPT_JOIN_VENDOR_ENTRY = "vendor/state/receipt/join.js";
const STATE_RECEIPT_OBSERVER_VENDOR_ENTRY = "vendor/state/receipt/index.js";
const VALUES_VENDOR_ENTRY = "vendor/values/index.js";
const WORK_DISPATCH_SOURCE_SPECIFIER = "@canlang/work/kernel/dispatch-staging";
const WORK_DISPATCH_EXECUTION_SOURCE_SPECIFIER = "@canlang/work/dispatch";
const WORK_DISPATCH_EXECUTION_VENDOR_ENTRY = "vendor/work/dispatch/index.js";
const WORK_SOURCE_SPECIFIER = "@canlang/work";
/** Package-exported leaf rows + recovery planners backing the work/state wrappers. */
const WORK_KERNEL_SOURCE_SPECIFIER = "@canlang/work-kernel";
const WORK_KERNEL_ROWS_SOURCE_SPECIFIER = "@canlang/work-kernel/rows";
const WORK_KERNEL_ROWS_VENDOR_ENTRY = "vendor/work-kernel/src/rows.js";
const WORK_INTENT_STAGING_SOURCE_SPECIFIER = "@canlang/work/intent/staging";
const WORK_INTENT_STAGING_VENDOR_ENTRY = "vendor/work/intent/staging.js";
/** Selected root export; the public barrel also exposes Node-only producers. */
const WORK_VENDOR_ENTRY = "vendor/work/kernel/committed-model-source.js";
const WORK_COMPLETION_VENDOR_ENTRY = "vendor/work/kernel/standard-completion-source.js";
const WORK_FILE_REFERENCE_VENDOR_ENTRY = "vendor/work/kernel/file-reference-inventory.js";
const WORK_DISPATCH_VENDOR_ENTRY = "vendor/work/kernel/dispatch-staging.js";
const WORK_SCHEDULE_SOURCE_SPECIFIER = "@canlang/work/kernel/schedule-staging";
const WORK_SCHEDULE_VENDOR_ENTRY = "vendor/work/kernel/schedule-staging.js";
const WORK_OCCURRENCE_SOURCE_SPECIFIER = "@canlang/work/kernel/occurrence-staging";
const WORK_OCCURRENCE_VENDOR_ENTRY = "vendor/work/kernel/occurrence-staging.js";
const WORK_RECEIPT_SOURCE_SPECIFIER = "@canlang/work/receipt";
const WORK_RECEIPT_VENDOR_ENTRY = "vendor/work/receipt/index.js";
const WORK_ASSOCIATION_SOURCE_SPECIFIER = "@canlang/work/observation/association";
const WORK_ASSOCIATION_VENDOR_ENTRY = "vendor/work/observation/association.js";
/** One defining module preserves Files' private observation identity. */
const FILES_FINALIZE_SOURCE_SPECIFIER = "@canlang/files/finalize";
const FILES_FINALIZE_VENDOR_ENTRY = "vendor/files/finalize/index.js";
const FILES_DURABLE_SQLITE_SOURCE_SPECIFIER = "@canlang/files/host/durable-sqlite";
const FILES_DURABLE_SQLITE_VENDOR_ENTRY = "vendor/files/host/durable-sqlite.js";
const FILES_PORTS_SOURCE_SPECIFIER = "@canlang/files/ports";
const FILES_PORTS_VENDOR_ENTRY = "vendor/files/ports.js";
const FILES_BRIDGE_SOURCE_SPECIFIER = "@canlang/files/bridge";
const FILES_BRIDGE_VENDOR_ENTRY = "vendor/files/bridge.js";
const ACORN_SOURCE_SPECIFIER = "acorn";
const ACORN_VENDOR_ENTRY = "vendor/acorn/acorn.js";
/** The runtime mapper's only external dependency; host import tooling stays out. */
const SOURCEMAP_CODEC_SPECIFIER = "@jridgewell/sourcemap-codec";
const SOURCEMAP_CODEC_VENDOR_ENTRY = "vendor/sourcemap-codec/sourcemap-codec.js";

/** Host-owned build inputs, scoped to this job and its subprocesses. */
export interface BundleExecutionOptions {
  esbuildBinaryPath?: string;
  /** All scratch directories belong beneath this root when a host owns the job. */
  temporaryRoot?: string;
}

export interface BuildDeployBundleOptions extends BundleExecutionOptions {
  commandLifetime?: LocalCommandLifetime;
  /**
   * Optional reusable producer-bundle candidates from the calling process.
   * Data-only (plain key/bytes/inputs); the builders revalidate every byte
   * before reuse. Never carries functions or lifetimes.
   */
  producerCache?: ProducerBundleCache;
  /** @deprecated Ignored. Producer files resolve through installed package exports. */
  repoRoot?: string;
  /**
   * Explicit host/test override; defaults to the exported Worker main's directory.
   */
  workerDistDir?: string;
  /**
   * Explicit host/test override; defaults to the exported MCP registry's directory.
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
function portableAssembledModules(modulePaths: readonly string[], sourceMaps: Record<string, SourceMap>): AssembledModules {
  const moduleUrls: Record<string, string> = {};
  for (const path of [...modulePaths].sort()) {
    moduleUrls[path] = relativeSpecifier(ASSEMBLY_MODULE_KEY, path);
  }
  const entry = modulePaths[0] as string;
  return { dir: "", entryUrl: relativeSpecifier(ASSEMBLY_MODULE_KEY, entry), moduleUrls, sourceMaps };
}

/** Render the P-B staged deployment and its owning installed-module closure. */
function renderStagedDeployment(
  artifact: CompileArtifact,
  modules: AssembledModules,
  verdict: ActivationVerdict,
): string {
  const artifactJson = JSON.stringify(artifact);
  const assemblyJson = JSON.stringify(modules);
  const entries = artifact.modules.map((module) => ({ path: module.path, url: modules.moduleUrls[module.path] }));
  if (entries.some((entry) => typeof entry.url !== "string" || entry.url.length === 0) ||
      new Set(entries.map((entry) => entry.path)).size !== entries.length ||
      Object.keys(modules.moduleUrls).length !== entries.length) {
    throw new Error("deploy bundle: portable assembly disagrees with staged production modules");
  }
  const imports = entries.map((entry) =>
    `    case ${JSON.stringify(entry.path)}: return import(${JSON.stringify(relativeSpecifier(ARTIFACT_MODULE, entry.path))});`,
  ).join("\n");
  return (
    `// Generated by can-platform deploy (P-B staged deployment). Do not edit.\n` +
    `import { registerAssemblerModuleCapability } from "../runtime/assembly-verification.js";\n` +
    // Keep these exact export spellings: preview admission compares the artifact and verdict bytes.
    `export const artifact = ${artifactJson};\n` +
    `export const modules = ${assemblyJson};\n` +
    `export const verdict = ${JSON.stringify(verdict)};\n` +
    `const assembledArtifactJson = ${JSON.stringify(artifactJson)};\n` +
    `const assembledMetadataJson = ${JSON.stringify(assemblyJson)};\n` +
    `function freezeAssemblyData(value) {\n` +
    `  if (value === null || typeof value !== "object") return value;\n` +
    `  const prototype = Object.getPrototypeOf(value);\n` +
    `  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("portable assembly: invalid metadata prototype");\n` +
    `  for (const key of Reflect.ownKeys(value)) {\n` +
    `    const member = Object.getOwnPropertyDescriptor(value, key);\n` +
    `    if (typeof key !== "string" || !Object.hasOwn(member, "value")) throw new Error("portable assembly: metadata must be own data");\n` +
    `    freezeAssemblyData(member.value);\n` +
    `  }\n` +
    `  return Object.freeze(value);\n` +
    `}\n` +
    `freezeAssemblyData(artifact);\n` +
    `freezeAssemblyData(modules);\n` +
    `async function verifyInstalledAssembly() {\n` +
    `  if (!Object.isFrozen(artifact) || !Object.isFrozen(modules) || !Object.isFrozen(modules.moduleUrls) || JSON.stringify(artifact) !== assembledArtifactJson || JSON.stringify(modules) !== assembledMetadataJson) throw new Error("portable assembly: installed artifact or module graph changed");\n` +
    `}\n` +
    // The host's checked bundle installs these literal targets together; no request or URL map selects code.
    `async function importInstalledModule(path) {\n` +
    `  switch (path) {\n${imports}\n` +
    `    default: throw new Error("portable assembly: unknown production module");\n` +
    `  }\n` +
    `}\n` +
    `registerAssemblerModuleCapability(modules, assembledArtifactJson, ${JSON.stringify(entries)}, verifyInstalledAssembly, importInstalledModule);\n`
  );
}

function withCode(error: Error, code: string): Error {
  (error as Error & { code?: string }).code = code;
  return error;
}

/** Stage the built worker dist under `worker/`: `main.js` + top-level siblings. */
function stageWorkerDist(workerDistDir: string): Record<string, string> {
  const mainFile = join(workerDistDir, "main.js");
  try {
    if (!statSync(mainFile).isFile()) throw new Error("not a file");
  } catch {
    throw withCode(
      new Error(
        `deploy bundle: worker entry not built at ${mainFile} ` +
          `(want @canlang/cloudflare/worker/main); ` +
          `run \`bun run --filter @canlang/cloudflare build\` first`,
      ),
      WORKER_MAIN_MISSING,
    );
  }
  // Top-level `.js` only (main + its relative siblings such as assembly and
  // entry): the worker dist is flat, and `./…` imports inside it resolve
  // within `worker/`. Deterministic order.
  const staged: Record<string, string> = {};
  for (const entry of readdirSync(workerDistDir).sort()) {
    // Colocated tests are emitted to dist but are not Worker
    // modules; they may import Node-only test producers.
    if (!entry.endsWith(".js") || entry.endsWith(".test.js")) continue;
    const full = join(workerDistDir, entry);
    if (!statSync(full).isFile()) continue;
    const key = `worker/${entry}`;
    staged[key] = rewriteRuntimeImports(readFileSync(full, "utf8"), key);
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

/** Read the pinned package's published ESM export, including in installed hosts. */
function stageSourceMapCodec(): Record<string, string> {
  const installCommand = "bun install --frozen-lockfile";
  const manifestFile = resolveProducerFile(`${SOURCEMAP_CODEC_SPECIFIER}/package.json`, installCommand);
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
      version?: string;
      exports?: { "."?: readonly { import?: { default?: string } }[] };
    };
    const entry = manifest.exports?.["."]?.[0]?.import?.default;
    if (manifest.version !== "1.6.0" || entry !== "./dist/sourcemap-codec.mjs") {
      throw new Error("unexpected codec version or ESM export");
    }
    return { [SOURCEMAP_CODEC_VENDOR_ENTRY]: readFileSync(join(dirname(manifestFile), entry), "utf8") };
  } catch (cause) {
    throw new Error(
      `deploy bundle: ${SOURCEMAP_CODEC_SPECIFIER} 1.6.0 ESM export missing or invalid; run \`${installCommand}\` first`,
      { cause },
    );
  }
}

/** Sorted vendor-tree read, mirroring the e2e loader (never stubbed). */
function readVendorTree(tree: VendorTree): Record<string, string> {
  const base = fileURLToPath(tree.directory);
  try {
    if (!statSync(base).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`deploy bundle: ${tree.directory.href} not built; run \`${tree.buildCommand}\` first`);
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
      // T16a-followup: colocated tests emit beside sources (node --test
      // runs them from dist) but must never vendor — workerd has no
      // node:test resolution.
      if (entry.endsWith(".test.js") || entry === "distribution.js") continue;
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
      if (NODE_HOST_VENDOR_KEYS.has(vendorKey)) continue;
      if (OPT_IN_VALUES_VENDOR_KEYS.has(vendorKey)) continue;
      const key = `${tree.prefix}/${relative(base, full).split(sep).join("/")}`;
      modules[key] = rewriteVendorImports(readFileSync(full, "utf8"), key);
    }
  };
  walk(base);
  if (Object.keys(modules).length === 0) {
    throw new Error(
      `deploy bundle: no .js modules found under ${tree.directory.href}; run \`${tree.buildCommand}\``,
    );
  }
  return modules;
}

/** Module-relative specifier from one map key to another (`./…` form). */
function relativeSpecifier(fromModule: string, toKey: string): string {
  const rel = posix.relative(posix.dirname(fromModule), toKey);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function rewriteArtifactImports(js: string, modulePath: string) {
  return rewriteModuleImports(js, modulePath, (specifier) => {
    if (specifier === STDLIB_SPECIFIER) return relativeSpecifier(modulePath, GENERATED_STDLIB_RUNTIME_ENTRY);
    if (specifier === UI_SPECIFIER) return relativeSpecifier(modulePath, NATIVE_UI_RUNTIME_ENTRY);
    return specifier;
  });
}

/**
 * Exported producer specifiers the P-C joins use in Node/Bun but cannot
 * resolve in the deployed Worker module map.
 * Rewritten to module-relative `vendor/` specifiers when staged.
 */
const IDENTITY_SOURCE_SPECIFIER = "@canlang/identity";
const STATE_SOURCE_SPECIFIER = "@canlang/state";
const STATE_D1_SOURCE_SPECIFIER = "@canlang/state/storage/d1";
const STATE_STORAGE_SOURCE_SPECIFIER = "@canlang/state/storage";
const STATE_MUTATION_SOURCE_SPECIFIER = "@canlang/state/mutation";
const STATE_MUTATION_VENDOR_ENTRY = "vendor/state/mutation/index.js";
const STATE_INVOCATION_SOURCE_SPECIFIER = "@canlang/state/invocation";
const STATE_INVOCATION_VENDOR_ENTRY = "vendor/state/invocation/index.js";
const STATE_QUERY_SOURCE_SPECIFIER = "@canlang/state/query";
const STATE_QUERY_VENDOR_ENTRY = "vendor/state/query/index.js";
/** D3b receipt producers (C's Q2 seam consts in pinned `invoke.js`). */
const STATE_RECEIPT_JOIN_SOURCE_SPECIFIER = "@canlang/state/receipt/join";
const STATE_RECEIPT_OBSERVER_SOURCE_SPECIFIER = "@canlang/state/receipt";
const VALUES_SOURCE_SPECIFIER = "@canlang/values";
/** Contracts version constants (`loadContractVersions` in pinned `invoke.js`). */
const CONTRACTS_SOURCE_SPECIFIER = "@canlang/contracts";
const JUDGMENT_SPECIFICATION_SOURCE_SPECIFIER = "@canlang/services/judgments/specification";
const JUDGMENT_SPECIFICATION_VENDOR_ENTRY = "vendor/services/judgments/specification.js";

/** Split selected public named exports without loading a broad producer barrel. */
function rewriteNamedProducerImports(js: string, moduleKey: string, source: string, leaves: ReadonlyMap<string, string>): string {
  let ast: Parameters<typeof walkJavaScript>[0];
  try {
    ast = parseJavaScript(js, { ecmaVersion: 2025, sourceType: "module", ranges: true }) as unknown as Parameters<typeof walkJavaScript>[0];
  } catch (error) {
    const offset = (error as { pos?: unknown } | null)?.pos;
    if (typeof offset !== "number" || !Number.isInteger(offset)) throw error;
    throw new Error(`deploy bundle: module ${JSON.stringify(moduleKey)} has invalid JavaScript syntax at offset ${offset}`);
  }
  const acceptedSources = new Set<object>();
  const replacements: { start: number; end: number; text: string }[] = [];
  const refuse = (): never => {
    throw new Error(`deploy bundle: module ${JSON.stringify(moduleKey)} uses unsupported ${source} root access; only static named ${[...leaves.keys()].join(', ')} imports are staged`);
  };
  type WalkEnter = NonNullable<Parameters<typeof walkJavaScript>[1]['enter']>;
  type WalkNode = Parameters<WalkEnter>[0];
  type WalkParent = Parameters<WalkEnter>[1];
  const rewriteImportDeclaration = (node: WalkNode & { type: "ImportDeclaration" }) => {
    if (node.specifiers.length === 0 || (node as unknown as { attributes?: readonly unknown[] }).attributes?.length || node.specifiers.some(specifier =>
      specifier.type !== "ImportSpecifier" ||
      !leaves.has(String(specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value)),
    )) refuse();
    acceptedSources.add(node.source);
    const groups = new Map<string, string[]>();
    for (const specifier of node.specifiers) {
      const named = specifier.type === 'ImportSpecifier' ? specifier : refuse();
      const name = String(named.imported.type === 'Identifier' ? named.imported.name : named.imported.value);
      const leaf = leaves.get(name)!;
      const members = groups.get(leaf) ?? [];
      const range = specifier as unknown as { start: number; end: number };
      members.push(js.slice(range.start, range.end));
      groups.set(leaf, members);
    }
    const range = node as unknown as { start: number; end: number };
    replacements.push({ start: range.start, end: range.end, text: [...groups].map(([leaf, members]) =>
      `import { ${members.join(', ')} } from ${JSON.stringify(relativeSpecifier(moduleKey, leaf))};`).join('\n') });
  };
  const isInventoryPackage = (parent: WalkParent, node: WalkNode): boolean =>
    source === WORK_SOURCE_SPECIFIER && moduleKey === WORK_FILE_REFERENCE_VENDOR_ENTRY &&
    parent?.type === 'Property' && parent.value === node && !parent.computed && !parent.method && parent.kind === 'init' &&
    (parent.key.type === 'Identifier' ? parent.key.name === 'package' : parent.key.type === 'Literal' && parent.key.value === 'package');
  walkJavaScript(ast, {
    enter(node, parent) {
      if (node.type === "ImportDeclaration" && node.source.value === source) rewriteImportDeclaration(node);
      // Reject re-exports, dynamic imports, constant loaders and other exact
      // root values. Decoded AST values also catch escaped literals/templates.
      // The genuine Work inventory's declaration provenance is inert data,
      // preserved byte-for-byte. This exception grants no root import access.
      const inventoryPackage = isInventoryPackage(parent, node);
      if (node.type === "Literal" && node.value === source && !acceptedSources.has(node) && !inventoryPackage) refuse();
      if (node.type === "TemplateElement" && node.value.cooked === source) refuse();
    },
  });
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    js = js.slice(0, replacement.start) + replacement.text + js.slice(replacement.end);
  }
  return js;
}

function rewriteSelectedProducerImports(js: string, moduleKey: string): string {
  js = rewriteNamedProducerImports(js, moduleKey, WORK_SOURCE_SPECIFIER, new Map([
    ['createCommittedModelSourceStager', WORK_VENDOR_ENTRY],
    ['stageDeclaredEventSources', WORK_VENDOR_ENTRY],
    ['createStandardCompletionSourceCommand', WORK_COMPLETION_VENDOR_ENTRY],
    ['WORK_FILE_REFERENCE_PRODUCER', WORK_FILE_REFERENCE_VENDOR_ENTRY],
  ]));
  return rewriteNamedProducerImports(js, moduleKey, STATE_STORAGE_SOURCE_SPECIFIER, new Map([
    ['bindOpaqueFileDeclarations', 'vendor/state/storage/opaque-file-declarations.js'],
    ['STATE_FILE_REFERENCE_PRODUCER', 'vendor/state/storage/file-reference-inventory.js'],
    ['prepareFrameworkFilePayloadOrigin', 'vendor/state/storage/file-retirement.js'],
    ['resolveOpaqueFileProjection', 'vendor/state/storage/opaque-file-declarations.js'],
    ['validateOpaqueFileOrigin', 'vendor/state/storage/opaque-file-declarations.js'],
  ]));
}

function mapRuntimeCoreImport(spec: string, moduleKey: string): string | null {
  if (spec === SOURCEMAP_CODEC_SPECIFIER) return relativeSpecifier(moduleKey, SOURCEMAP_CODEC_VENDOR_ENTRY);
  if (spec === IDENTITY_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, IDENTITY_VENDOR_ENTRY);
  if (spec === STATE_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, STATE_VENDOR_ENTRY);
  if (spec === "@canlang/state/storage") return relativeSpecifier(moduleKey, "vendor/state/storage/index.js");
  if (spec === STATE_D1_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, STATE_D1_VENDOR_ENTRY);
  if (spec === STATE_MUTATION_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, STATE_MUTATION_VENDOR_ENTRY);
  if (spec === STATE_INVOCATION_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, STATE_INVOCATION_VENDOR_ENTRY);
  if (spec === STATE_QUERY_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, STATE_QUERY_VENDOR_ENTRY);
  if (spec === STATE_RECEIPT_JOIN_SOURCE_SPECIFIER) {
    return relativeSpecifier(moduleKey, STATE_RECEIPT_JOIN_VENDOR_ENTRY);
  }
  if (spec === STATE_RECEIPT_OBSERVER_SOURCE_SPECIFIER) {
    return relativeSpecifier(moduleKey, STATE_RECEIPT_OBSERVER_VENDOR_ENTRY);
  }
  if (spec === CONTRACTS_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, CONTRACTS_VENDOR_ENTRY);
  if (spec === JUDGMENT_SPECIFICATION_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, JUDGMENT_SPECIFICATION_VENDOR_ENTRY);
  if (spec === VALUES_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, VALUES_VENDOR_ENTRY);
  if (spec === WORK_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, WORK_VENDOR_ENTRY);
  if (spec === WORK_DISPATCH_EXECUTION_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, WORK_DISPATCH_EXECUTION_VENDOR_ENTRY);
  if (spec === "@canlang/work/recovery") return relativeSpecifier(moduleKey, "vendor/work/recovery/index.js");
  if (spec === WORK_INTENT_STAGING_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, WORK_INTENT_STAGING_VENDOR_ENTRY);
  return null;
}

function mapRuntimeExtendedImport(spec: string, moduleKey: string): string | null {
  if (spec.startsWith("@canlang/work/kernel/")) return relativeSpecifier(moduleKey, `vendor/work/kernel/${spec.slice("@canlang/work/kernel/".length)}.js`);
  if (spec === WORK_RECEIPT_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, WORK_RECEIPT_VENDOR_ENTRY);
  if (spec === WORK_ASSOCIATION_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, WORK_ASSOCIATION_VENDOR_ENTRY);
  if (spec === FILES_FINALIZE_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, FILES_FINALIZE_VENDOR_ENTRY);
  if (spec === FILES_DURABLE_SQLITE_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, FILES_DURABLE_SQLITE_VENDOR_ENTRY);
  if (spec === "@canlang/files/upload") return relativeSpecifier(moduleKey, "vendor/files/upload/index.js");
  if (spec === "@canlang/files/provenance") return relativeSpecifier(moduleKey, "vendor/files/provenance/index.js");
  if (spec.startsWith("@canlang/files/")) return relativeSpecifier(moduleKey, `vendor/files/${spec.slice("@canlang/files/".length)}.js`);
  if (spec === FILES_PORTS_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, FILES_PORTS_VENDOR_ENTRY);
  if (spec === FILES_BRIDGE_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, FILES_BRIDGE_VENDOR_ENTRY);
  if (spec === ACORN_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, ACORN_VENDOR_ENTRY);
  if (spec === "@canlang/interfaces" || spec === "@canlang/interfaces/http/operations" || spec === "@canlang/interfaces/uploads/kernel") {
    return relativeSpecifier(moduleKey, HTTP_OPERATIONS_MODULE);
  }
  if (spec.startsWith("@canlang/state/")) return relativeSpecifier(moduleKey, `vendor/state/${spec.slice("@canlang/state/".length)}.js`);
  if (spec === WORK_KERNEL_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, "vendor/work-kernel/src/index.js");
  if (spec === WORK_KERNEL_ROWS_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, WORK_KERNEL_ROWS_VENDOR_ENTRY);
  if (spec.startsWith("@canlang/work-kernel/")) return relativeSpecifier(moduleKey, `vendor/work-kernel/src/${spec.slice("@canlang/work-kernel/".length)}.js`);
  return null;
}

/** Rewrite worker/runtime producer imports to module-relative `vendor/` keys. */
function rewriteRuntimeImports(js: string, moduleKey: string): string {
  js = rewriteSelectedProducerImports(js, moduleKey);
  const mapped = (spec: string): string =>
    mapRuntimeCoreImport(spec, moduleKey) ?? mapRuntimeExtendedImport(spec, moduleKey) ?? spec;
  let out = rewriteModuleImports(js, moduleKey, mapped, { profile: "trusted-producer" }).js;
  // The P-C joins hold their specifiers in consts (`import(IDENTITY_SPECIFIER)`),
  // so the import-syntax pass above cannot see them: rewrite the exact source
  // literals too. Each literal occurs exactly once (the const initializer —
  // error messages interpolate the const, so they name the bundle path too).
  for (const [source, entry] of [
    [IDENTITY_SOURCE_SPECIFIER, IDENTITY_VENDOR_ENTRY],
    [STATE_SOURCE_SPECIFIER, STATE_VENDOR_ENTRY],
    [STATE_D1_SOURCE_SPECIFIER, STATE_D1_VENDOR_ENTRY],
    [STATE_MUTATION_SOURCE_SPECIFIER, STATE_MUTATION_VENDOR_ENTRY],
    [STATE_INVOCATION_SOURCE_SPECIFIER, STATE_INVOCATION_VENDOR_ENTRY],
    [STATE_QUERY_SOURCE_SPECIFIER, STATE_QUERY_VENDOR_ENTRY],
    [STATE_RECEIPT_JOIN_SOURCE_SPECIFIER, STATE_RECEIPT_JOIN_VENDOR_ENTRY],
    [STATE_RECEIPT_OBSERVER_SOURCE_SPECIFIER, STATE_RECEIPT_OBSERVER_VENDOR_ENTRY],
    [CONTRACTS_SOURCE_SPECIFIER, CONTRACTS_VENDOR_ENTRY],
    [WORK_DISPATCH_SOURCE_SPECIFIER, WORK_DISPATCH_VENDOR_ENTRY],
    [WORK_DISPATCH_EXECUTION_SOURCE_SPECIFIER, WORK_DISPATCH_EXECUTION_VENDOR_ENTRY],
    [WORK_SCHEDULE_SOURCE_SPECIFIER, WORK_SCHEDULE_VENDOR_ENTRY],
    [WORK_OCCURRENCE_SOURCE_SPECIFIER, WORK_OCCURRENCE_VENDOR_ENTRY],
    [WORK_INTENT_STAGING_SOURCE_SPECIFIER, WORK_INTENT_STAGING_VENDOR_ENTRY],
    [WORK_RECEIPT_SOURCE_SPECIFIER, WORK_RECEIPT_VENDOR_ENTRY],
    [WORK_ASSOCIATION_SOURCE_SPECIFIER, WORK_ASSOCIATION_VENDOR_ENTRY],
    [FILES_FINALIZE_SOURCE_SPECIFIER, FILES_FINALIZE_VENDOR_ENTRY],
    [FILES_DURABLE_SQLITE_SOURCE_SPECIFIER, FILES_DURABLE_SQLITE_VENDOR_ENTRY],
    [FILES_PORTS_SOURCE_SPECIFIER, FILES_PORTS_VENDOR_ENTRY],
    [FILES_BRIDGE_SOURCE_SPECIFIER, FILES_BRIDGE_VENDOR_ENTRY],
    [ACORN_SOURCE_SPECIFIER, ACORN_VENDOR_ENTRY],
    ["@canlang/ui", UI_VENDOR_ENTRY],
  ] as const) {
    // Match a complete literal: mutation/crud and other exported subpaths
    // must not inherit the mutation entry's index.js suffix.
    const literal = new RegExp(`(["'])${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`, "g");
    out = out.replace(literal, (_match, quote: string) => `${quote}${relativeSpecifier(moduleKey, entry)}${quote}`);
  }
  out = out.replace(/[\'"](@canlang\/state\/([^\'"]+))[\'"]/g, (_full, _spec, sub) => JSON.stringify(relativeSpecifier(moduleKey, `vendor/state/${sub}.js`)));
  out = out.replace(/[\'"](@canlang\/work\/kernel\/([^\'"]+))[\'"]/g, (_full, _spec, sub) => JSON.stringify(relativeSpecifier(moduleKey, `vendor/work/kernel/${sub}.js`)));
  return out;
}

/** Stage the public portable Work producers and deduplicate their relative closures. */
function stageWorkStagingProducers(): Record<string, string> {
  const entries = [WORK_DISPATCH_SOURCE_SPECIFIER, WORK_SCHEDULE_SOURCE_SPECIFIER, WORK_OCCURRENCE_SOURCE_SPECIFIER,
    WORK_DISPATCH_EXECUTION_SOURCE_SPECIFIER,
    WORK_INTENT_STAGING_SOURCE_SPECIFIER,
    WORK_RECEIPT_SOURCE_SPECIFIER, WORK_ASSOCIATION_SOURCE_SPECIFIER,
    "@canlang/work/kernel/tables", "@canlang/work/kernel/handler-occurrence", "@canlang/work/kernel/commands", "@canlang/work/recovery"]
    .map(specifier => resolveProducerFile(specifier, "bun run --filter @canlang/work build"));
  entries.push(join(fileURLToPath(workDistribution.modules), "kernel", "committed-model-source.js"));
  entries.push(join(fileURLToPath(workDistribution.modules), "kernel", "standard-completion-source.js"));
  entries.push(join(fileURLToPath(workDistribution.modules), "kernel", "file-reference-inventory.js"));
  const base = dirname(dirname(entries[0]!));
  const modules: Record<string, string> = {};
  const visit = (file: string): void => {
    const path = relative(base, file).split(sep).join("/");
    assertSafeRelativePath(path, "Work staging producer dependency");
    const key = `vendor/work/${path}`;
    if (Object.hasOwn(modules, key)) return;
    const js = readFileSync(file, "utf8");
    modules[key] = rewriteVendorImports(js, key);
    for (const imported of scanModuleImports(js, key)) {
      if (imported.specifier !== undefined && isRelativeSpecifier(imported.specifier)) {
        visit(resolve(dirname(file), imported.specifier));
      }
    }
  };
  for (const entry of entries) visit(entry);
  return modules;
}

/** Stage the public Files finalizer and page bridge's shared relative closure. */
function stageFilesFinalizeProducer(extraEntries: readonly string[] = []): Record<string, string> {
  const entry = resolveProducerFile(FILES_FINALIZE_SOURCE_SPECIFIER, "bun run --filter @canlang/files build");
  const bridge = resolveProducerFile(FILES_BRIDGE_SOURCE_SPECIFIER, "bun run --filter @canlang/files build");
  const base = dirname(dirname(entry));
  const modules: Record<string, string> = {};
  const visit = (file: string): void => {
    const path = relative(base, file).split(sep).join("/");
    assertSafeRelativePath(path, "Files finalizer dependency");
    const key = `vendor/files/${path}`;
    if (Object.hasOwn(modules, key)) return;
    const js = readFileSync(file, "utf8");
    modules[key] = rewriteVendorImports(js, key);
    for (const imported of scanModuleImports(js, key)) {
      if (imported.specifier !== undefined && isRelativeSpecifier(imported.specifier)) {
        visit(resolve(dirname(file), imported.specifier));
      }
    }
  };
  visit(entry);
  visit(bridge);
  for (const specifier of extraEntries) visit(resolveProducerFile(specifier, "bun run --filter @canlang/files build"));
  return modules;
}

/**
 * Add the native application actor through the same portable producer graph.
 * Canonical vendor keys preserve the defining Files issuer; there is no second
 * bundled finalizer or serialized observation authority at this boundary.
 */
export function stageSodaRuntimeModules(existing: Readonly<Record<string, string>>): Record<string, string> {
  const modules: Record<string, string> = {};
  const add = (key: string, js: string): void => {
    const previous = existing[key] ?? modules[key];
    if (previous !== undefined && previous !== js) throw new Error(`deploy bundle: conflicting native producer ${key}`);
    if (existing[key] === undefined) modules[key] = js;
  };
  for (const closure of [stageWorkStagingProducers(),
    stageFilesFinalizeProducer([FILES_DURABLE_SQLITE_SOURCE_SPECIFIER])]) {
    for (const [key, js] of Object.entries(closure)) add(key, js);
  }
  const base = dirname(dirname(resolveProducerFile('@canlang/cloudflare/worker/main', 'bun run --filter @canlang/cloudflare build')));
  const visit = (file: string): void => {
    const key = relative(base, file).split(sep).join('/');
    assertSafeRelativePath(key, 'native runtime producer');
    if (Object.hasOwn(existing, key) || Object.hasOwn(modules, key)) return;
    const js = readFileSync(file, 'utf8');
    add(key, rewriteRuntimeImports(js, key));
    for (const imported of scanModuleImports(js, key)) {
      if (imported.specifier !== undefined && isRelativeSpecifier(imported.specifier)) {
        visit(resolve(dirname(file), imported.specifier));
      }
    }
  };
  visit(join(base, 'runtime/soda-application.js'));
  return modules;
}

function mapVendorScopedImport(moduleKey: string, spec: string): string | null {
  if (moduleKey.startsWith("vendor/identity/")) {
    if (spec === "#identity-byte-compare") return relativeSpecifier(moduleKey, "vendor/identity/sessions/comparison-worker.js");
    if (spec === "cookie") return relativeSpecifier(moduleKey, "vendor/cookie/index.js");
    if (spec === "@scure/base") return relativeSpecifier(moduleKey, "vendor/scure-base/index.js");
  }
  if (moduleKey.startsWith("vendor/ui/") && spec === "csv-parse/browser/esm/sync") {
    return relativeSpecifier(moduleKey, "vendor/csv-parse/sync.js");
  }
  if (moduleKey.startsWith("vendor/values-bindings/") && isRelativeSpecifier(spec)) {
    const target = posix.normalize(posix.join(posix.dirname(moduleKey), spec));
    if (target.startsWith("vendor/src/")) {
      return relativeSpecifier(moduleKey, `vendor/values/${target.slice("vendor/src/".length)}`);
    }
  }
  if (moduleKey.startsWith("vendor/values/") && isRelativeSpecifier(spec)) {
    const target = posix.normalize(posix.join(posix.dirname(moduleKey), spec));
    if (target.startsWith("vendor/bindings/")) {
      return relativeSpecifier(moduleKey, `vendor/values/bindings/${target.slice("vendor/bindings/".length)}`);
    }
  }
  if (moduleKey.startsWith("vendor/values/bindings/") && isRelativeSpecifier(spec)) {
    const target = posix.normalize(posix.join(posix.dirname(moduleKey), spec));
    if (target.startsWith("vendor/values/src/")) {
      return relativeSpecifier(moduleKey, `vendor/values/${target.slice("vendor/values/src/".length)}`);
    }
  }
  return null;
}

function mapVendorCoreImport(spec: string, moduleKey: string): string | null {
  if (spec === STDLIB_SPECIFIER) return relativeSpecifier(moduleKey, STDLIB_VENDOR_ENTRY);
  if (spec === UI_SPECIFIER) return relativeSpecifier(moduleKey, UI_VENDOR_ENTRY);
  if (spec === IDENTITY_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, IDENTITY_VENDOR_ENTRY);
  if (spec === STATE_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, STATE_VENDOR_ENTRY);
  if (spec === "@canlang/state/storage") return relativeSpecifier(moduleKey, "vendor/state/storage/index.js");
  if (spec === STATE_QUERY_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, STATE_QUERY_VENDOR_ENTRY);
  if (spec === "@canlang/state/storage/port") return relativeSpecifier(moduleKey, "vendor/state/storage/port.js");
  if (spec === WORK_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, WORK_VENDOR_ENTRY);
  if (spec === WORK_DISPATCH_EXECUTION_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, WORK_DISPATCH_EXECUTION_VENDOR_ENTRY);
  if (spec === "@canlang/work/recovery") return relativeSpecifier(moduleKey, "vendor/work/recovery/index.js");
  if (spec === WORK_INTENT_STAGING_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, WORK_INTENT_STAGING_VENDOR_ENTRY);
  if (spec === VALUES_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, VALUES_VENDOR_ENTRY);
  if (spec === CONTRACTS_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, CONTRACTS_VENDOR_ENTRY);
  if (spec === FILES_FINALIZE_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, FILES_FINALIZE_VENDOR_ENTRY);
  if (spec === FILES_DURABLE_SQLITE_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, FILES_DURABLE_SQLITE_VENDOR_ENTRY);
  if (spec === "@canlang/files/upload") return relativeSpecifier(moduleKey, "vendor/files/upload/index.js");
  if (spec === "@canlang/files/provenance") return relativeSpecifier(moduleKey, "vendor/files/provenance/index.js");
  return null;
}

function mapVendorExtendedImport(spec: string, moduleKey: string): string | null {
  if (spec.startsWith("@canlang/files/")) return relativeSpecifier(moduleKey, `vendor/files/${spec.slice("@canlang/files/".length)}.js`);
  if (spec === FILES_PORTS_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, FILES_PORTS_VENDOR_ENTRY);
  if (spec === FILES_BRIDGE_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, FILES_BRIDGE_VENDOR_ENTRY);
  if (spec === ACORN_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, ACORN_VENDOR_ENTRY);
  if (spec === "@noble/hashes/sha2.js" || spec === "@noble/hashes/utils.js") {
    return relativeSpecifier(moduleKey, `vendor/noble-hashes/${spec.slice("@noble/hashes/".length)}`);
  }
  if (spec === WORK_KERNEL_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, "vendor/work-kernel/src/index.js");
  if (spec === WORK_KERNEL_ROWS_SOURCE_SPECIFIER) return relativeSpecifier(moduleKey, WORK_KERNEL_ROWS_VENDOR_ENTRY);
  if (spec.startsWith("@canlang/work-kernel/")) return relativeSpecifier(moduleKey, `vendor/work-kernel/src/${spec.slice("@canlang/work-kernel/".length)}.js`);
  if (spec === "@canlang/contracts/values") return relativeSpecifier(moduleKey, "vendor/contracts/values.js");
  if (spec.startsWith("@canlang/values/bindings/")) return relativeSpecifier(moduleKey, `vendor/values/${spec.slice("@canlang/values/".length)}.js`);
  if (spec === "@canlang/state/effects/transition") return relativeSpecifier(moduleKey, "vendor/state/effects/transition.js");
  if (spec === "@canlang/state/effects/guards") return relativeSpecifier(moduleKey, "vendor/state/effects/guards.js");
  if (spec === "@canlang/state/effects/delivery") return relativeSpecifier(moduleKey, "vendor/state/effects/delivery.js");
  if (spec === "@canlang/state/receipt/tables") return relativeSpecifier(moduleKey, "vendor/state/receipt/tables.js");
  return null;
}

/**
 * Rewrite producer imports inside staged vendor trees. Vendor dists are
 * verbatim builds: today only `vendor/stdlib` carries a bare producer
 * import (`@canlang/values`), but the full map applies so the next bare
 * import fails loudly at the link check instead of sliding through —
 * mappings with no occurrence are exact no-ops.
 */
function rewriteVendorImports(js: string, moduleKey: string): string {
  js = rewriteSelectedProducerImports(js, moduleKey);
  const mapped = (spec: string): string =>
    mapVendorScopedImport(moduleKey, spec) ?? mapVendorCoreImport(spec, moduleKey) ?? mapVendorExtendedImport(spec, moduleKey) ?? spec;
  return rewriteModuleImports(js, moduleKey, mapped, { profile: "trusted-producer" }).js;
}

function assertSafeRelativePath(path: string, what: string): void {
  const normalized = posix.normalize(path);
  if (path === "" || posix.isAbsolute(path) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`deploy bundle: refusing ${what} outside the module map: ${JSON.stringify(path)}`);
  }
}

/** Stage artifact modules (production only: `tests[]` are erased). */
function stageArtifactModules(artifact: CompileArtifact): { modules: Record<string, string>; sourceMaps: Record<string, SourceMap> } {
  const modules = artifact.modules;
  if (modules.length === 0) {
    throw new Error("deploy bundle: artifact has no modules; modules[0] must be the entrypoint");
  }
  validateArtifactModuleImports(modules);
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
  // Artifact modules share the output tree with platform modules and writer
  // manifests. Check ownership before staging any bytes, including aliases.
  const platformDirectories = new Set(["worker", "runtime", "vendor"]);
  const writerManifests = new Set([...RESERVED_MIXED_OUTPUTS, "bundle.resources.json"]);
  const seen = new Map<string, string>();
  for (const mod of modules) {
    assertSafeRelativePath(mod.path, "to stage module");
    const normalized = posix.normalize(mod.path);
    const root = normalized.split("/")[0]!;
    if (platformDirectories.has(root)) {
      throw new Error(`deploy bundle: artifact module ${JSON.stringify(mod.path)} reserves platform directory ${JSON.stringify(root)}`);
    }
    if (writerManifests.has(root)) {
      throw new Error(`deploy bundle: artifact module ${JSON.stringify(mod.path)} reserves writer manifest path ${JSON.stringify(root)}`);
    }
    const prior = seen.get(normalized);
    if (prior !== undefined) {
      throw new Error(`deploy bundle: artifact module ${JSON.stringify(mod.path)} aliases ${JSON.stringify(prior)} after normalization`);
    }
    seen.set(normalized, mod.path);
  }
  const staged: Record<string, string> = {};
  const sourceMaps: Record<string, SourceMap> = {};
  for (const mod of modules) {
    const rewritten = rewriteArtifactImports(mod.js, mod.path);
    const view = composeModuleMap(mod.map, rewritten.map === undefined ? [] : [rewritten.map], mod.js);
    if (view.map !== undefined) sourceMaps[mod.path] = view.map;
    const inline = view.map === undefined ? "" : `\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(view.map), "utf8").toString("base64")}\n`;
    staged[mod.path] = rewritten.js + inline;
  }
  staged[NATIVE_UI_RUNTIME_ENTRY] = nativeUiQueryFacadeSource(nativeUiProducer,
    relativeSpecifier(NATIVE_UI_RUNTIME_ENTRY, UI_VENDOR_ENTRY),
    relativeSpecifier(NATIVE_UI_RUNTIME_ENTRY, 'runtime/native-ui-query.js'));
  return { modules: staged, sourceMaps };
}

/** One authored module's host-observed map facts for native construction. */
export interface AuthoredMapDescription {
  /** Artifact module path (matches the staged key). */
  readonly path: string;
  /** Canonical JSON of the composed map, or null when no original map exists. */
  readonly mapJson: string | null;
  /** Import-edit stage count observed by the host rewrite (0 or 1). */
  readonly stages: number;
}

/**
 * Describe the authored layer for the native constructor
 * (RUST-PREPARATION-010): per artifact module, the composed map JSON
 * and rewrite stage count from the exact same rewrite/compose calls
 * `stageArtifactModules` uses — no bundle assembly, no ownership
 * re-checks (the real build inside `ensureBundle` already enforces
 * those before LOAD_MODULES is served). Deterministic and pure, so a
 * second evaluation agrees with the bundle build byte-for-byte. Raw
 * JS, pages and callables ride the artifact payload the native job
 * already holds; only these host-composed bytes are served.
 */
export function describeAuthoredMaps(artifact: CompileArtifact): AuthoredMapDescription[] {
  return artifact.modules.map((mod) => {
    const rewritten = rewriteArtifactImports(mod.js, mod.path);
    const view = composeModuleMap(mod.map, rewritten.map === undefined ? [] : [rewritten.map], mod.js);
    return {
      path: mod.path,
      mapJson: view.map === undefined ? null : JSON.stringify(view.map),
      stages: rewritten.map === undefined ? 0 : 1,
    };
  });
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
export function buildDerivedInputsModule(artifact: CompileArtifact): string {
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
export function buildMcpBundle(_repoRoot?: string, lifetime?: LocalCommandLifetime, execution: BundleExecutionOptions = {}): string {
  return buildProducerBundle("mcp", "mcp-bundle-entry.js", mcpBundleEntrySource(lifetime), lifetime, execution, undefined).bytes;
}

function mcpBundleEntrySource(lifetime?: LocalCommandLifetime): string {
  lifetime?.checkpoint("deploy MCP inputs");
  const serverDist = resolveProducerFile(
    INTERFACES_MCP_SERVER_DIST,
    "bun run --filter @canlang/interfaces build",
  );
  const registryDist = resolveProducerFile(
    MCP_REGISTRY_DIST,
    "bun run --filter @canlang/cloudflare build",
  );
  const toPosixAbsolute = (path: string): string => path.split(sep).join(posix.sep);
  // `createHandler` is the main's join-contract name for the real
  // `createMcpHandler` (identical `McpHandlerFactory` shape: `(deps) =>
  // (request) => Response`) — one alias, same function, no wrapper.
  return `export { createMcpHandler, createMcpHandler as createHandler } from ${JSON.stringify(toPosixAbsolute(serverDist))};\n` +
    `export { createArtifactCatalog, createArtifactRegistry } from ${JSON.stringify(toPosixAbsolute(registryDist))};\n`;
}

/**
 * Build the `http-operations.js` module (C3): the real HTTP op-POST
 * chain bundled self-contained for workerd. Mirrors `buildMcpBundle`
 * (same flags, same marker check, same loud errors) with a pure
 * re-export entry. The stable stdin sourcefile keeps scratch paths out of
 * bytes; the main's join-contract currying lives in stable main source
 * instead (see `defaultLoadHttpOperationsFactory`).
 */
export function buildHttpOperationsBundle(_repoRoot?: string, lifetime?: LocalCommandLifetime, execution: BundleExecutionOptions = {}): string {
  return buildProducerBundle("http", "http-bundle-entry.js", httpBundleEntrySource(lifetime), lifetime, execution, undefined).bytes;
}

function httpBundleEntrySource(lifetime?: LocalCommandLifetime): string {
  lifetime?.checkpoint("deploy HTTP inputs");
  const operationsDist = resolveProducerFile(
    INTERFACES_HTTP_OPERATIONS_DIST,
    "bun run --filter @canlang/interfaces build",
  );
  const toPosixAbsolute = (path: string): string => path.split(sep).join(posix.sep);
  return `export { handleOperationRequest, createSourceFormBindings, catalogFromArtifactOperations, createSourceValidationCatalog, encodeServingLiteral, INPUT_CHOICES_VERSION } from ${JSON.stringify(toPosixAbsolute(operationsDist))};\n` +
    `export { handleCsvRequest } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(interfacesDistribution.modules), "http", "csv.js")))};\n` +
    `export { handleExportRequest } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(interfacesDistribution.modules), "http", "export.js")))};\n` +
    `export { canonicalJson } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(interfacesDistribution.modules), "http", "canonical-json.js")))};\n` +
    `export { handleAuthRequest } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(interfacesDistribution.modules), "http", "auth.js")))};\n` +
    `export { parseJsonBody, JSON_BODY_MAX_BYTES } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(interfacesDistribution.modules), "http", "limits.js")))};\n` +
    `export { receiverFromIdentity } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(interfacesDistribution.modules), "uploads", "principals.js")))};\n` +
    `export { handleUploadRequest } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(interfacesDistribution.modules), "uploads", "routes.js")))};\n` +
    `export { createFileJourneyKernel } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(interfacesDistribution.modules), "uploads", "kernel.js")))};\n` +
    `export { buildBusinessError, fromUnknown, toHttpResponse } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(interfacesDistribution.modules), "errors", "envelope.js")))};\n` +
    `export { resolveRequestIdentity } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(interfacesDistribution.modules), "http", "context.js")))};\n` +
    `export { SESSION_EXPIRES_MS } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(identityDistribution.modules), "accounts", "registration.js")))};\n` +
    `export { handlePageRequest, handlePagePreferencePost } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(interfacesDistribution.modules), "http", "pages.js")))};\n` +
    `export { assertTrustedAuthOrigin, caughtToBusinessError, isBusinessThrow, jsonErrorResponse } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(interfacesDistribution.modules), "http", "context.js")))};\n` +
    `export { httpStatusFor } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(interfacesDistribution.modules), "errors", "envelope.js")))};\n` +
    `export { logInternalError } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(interfacesDistribution.modules), "errors", "logging.js")))};\n` +
    `export { checkArtifactOperation, checkArtifactOperations, checkBoundArgument, checkBoundArguments, checkedToMcpInputSchema } from ${JSON.stringify(toPosixAbsolute(join(fileURLToPath(interfacesDistribution.modules), "mcp", "schemas.js")))};\n`;
}

/* ------------------------------------------------------------------ */
/* Host CommonJS preflight: library syntax and lexical bindings. */

/** Structured module facts for the native LOAD_MODULES stage (025):
 * the single host frontend over the owner import lexer (Acorn 2025
 * scope analysis runs here). The native side validates shape,
 * unit-coordinate bounds and per-module correspondence, then applies
 * stage/module key/graph/link and diagnostic policy itself. */
export interface ModuleImportFact {
  readonly groupRank: number;
  readonly statementStart: number;
  readonly statementEnd: number;
  readonly argumentStart: number;
  readonly argumentEnd: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  /** Raw literal slice (028: escapes keep raw distinct from decoded). */
  readonly raw: string | null;
  /** Owner-decoded specifier (028: trusted at the decoder boundary). */
  readonly specifier: string | null;
}
export interface ModuleUnresolvedFact {
  readonly group: 0 | 1 | 2;
  /** Original UTF-16 start (028: escaped idents keep owner coordinates). */
  readonly start: number;
  /** Original UTF-16 end. */
  readonly end: number;
  /** Acorn-decoded identifier name (028: binds escaped spellings). */
  readonly name: string;
}
export interface ModuleSyntaxFacts {
  readonly imports: readonly ModuleImportFact[];
  /** Import-lexer refusal offset (owner import-syntax error). */
  readonly lexerError: number | null;
  /** Non-offset import-frontend refusal: exact owner message, opaque. */
  readonly frontendError: string | null;
  /** Acorn refusal offset (owner JS-syntax error). */
  readonly syntaxError: number | null;
  /** `file://` import statement starts, in import-record order. */
  readonly fileUrl: readonly number[];
  /** Unresolved gates: 0 bare require(, 1 module.exports, 2 free exports. */
  readonly unresolved: readonly ModuleUnresolvedFact[];
}
const EMPTY_FACTS: ModuleSyntaxFacts = {
  imports: [],
  lexerError: null,
  frontendError: null,
  syntaxError: null,
  fileUrl: [],
  unresolved: [],
};
export function scanModuleFacts(source: string, modulePath: string): ModuleSyntaxFacts {
  let records: readonly ModuleImport[];
  try {
    records = scanModuleImports(source, modulePath);
  } catch (error) {
    // Offset-carrying throws (wrapped import-syntax included) ride
    // as structured lexer facts so eager all-module collection keeps
    // per-module first-error order; anything else rides the exact
    // owner message opaquely at the same precedence. Never parsed.
    const offset = (error as { idx?: unknown } | null)?.idx;
    if (typeof offset === "number" && Number.isInteger(offset)) {
      return { ...EMPTY_FACTS, lexerError: offset };
    }
    return {
      ...EMPTY_FACTS,
      frontendError: error instanceof Error ? error.message : String(error),
    };
  }
  const fileUrl: number[] = [];
  for (const record of records) {
    if (record.specifier?.startsWith("file://")) fileUrl.push(record.statement.start);
  }
  let ast: Parameters<typeof walkJavaScript>[0];
  try {
    // Acorn's ESTree nodes retain original UTF-16 ranges for scope diagnostics.
    ast = parseJavaScript(source, { ecmaVersion: 2025, sourceType: "module", ranges: true }) as unknown as Parameters<typeof walkJavaScript>[0];
  } catch (error) {
    const offset = (error as { pos?: unknown } | null)?.pos;
    if (typeof offset !== "number" || !Number.isInteger(offset)) throw error;
    return {
      imports: records.map(toImportFact),
      lexerError: null,
      frontendError: null,
      syntaxError: offset,
      fileUrl,
      unresolved: [],
    };
  }
  // Resolve lexical module bindings. Dynamic eval contents are outside this
  // preflight; no implicit Node/CommonJS bindings or wrapper exemptions apply.
  const scope = analyzeScopes(ast, { ecmaVersion: 2025, sourceType: "module", ignoreEval: true, nodejsScope: false });
  const unresolved = new Set(scope.globalScope!.through.map((reference) => reference.identifier));
  const offsets: [ModuleUnresolvedFact[], ModuleUnresolvedFact[], ModuleUnresolvedFact[]] = [[], [], []];
  walkJavaScript(ast, {
    enter(node, parent) {
      if (node.type !== "Identifier" || !unresolved.has(node)) return;
      const [start, end] = node.range!;
      const directCall = parent?.type === "NewExpression" || (parent?.type === "CallExpression" && !parent.optional);
      if (node.name === "require" && directCall && parent.callee === node) {
        offsets[0].push({ group: 0, start, end, name: node.name });
      }
      if (node.name === "module" && parent?.type === "MemberExpression" && parent.object === node && !parent.computed && !parent.optional && parent.property.type === "Identifier" && parent.property.name === "exports") {
        offsets[1].push({ group: 1, start, end, name: node.name });
      }
      if (node.name === "exports") offsets[2].push({ group: 2, start, end, name: node.name });
    },
  });
  const flat: ModuleUnresolvedFact[] = [];
  for (const positions of offsets) {
    for (const item of positions.sort((a, b) => a.start - b.start)) flat.push(item);
  }
  return {
    imports: records.map(toImportFact),
    lexerError: null,
    frontendError: null,
    syntaxError: null,
    fileUrl,
    unresolved: flat,
  };
}
function toImportFact(record: ModuleImport): ModuleImportFact {
  return {
    groupRank: GROUP_ORDER[record.group],
    statementStart: record.statement.start,
    statementEnd: record.statement.end,
    argumentStart: record.argument.start,
    argumentEnd: record.argument.end,
    contentStart: record.content?.start ?? -1,
    contentEnd: record.content?.end ?? -1,
    raw: record.rawSpecifier ?? null,
    specifier: record.specifier ?? null,
  };
}
/**
 * Refuse frontend facts at the original import-scan precedence (037): a
 * non-offset import-frontend refusal rides the exact owner message (the
 * old direct `scanModuleImports` path threw it); offset/syntax refusals
 * keep their messages; free-reference issues follow. Pure over facts so
 * the precedence contract is directly checkable.
 */
export function refuseModuleFrontendIssues(facts: ModuleSyntaxFacts, modulePath: string): string[] {
  if (facts.frontendError !== null) {
    throw new Error(facts.frontendError);
  }
  if (facts.lexerError !== null) {
    throw new Error(`deploy bundle: module ${JSON.stringify(modulePath)} has invalid import syntax at offset ${facts.lexerError}`);
  }
  if (facts.syntaxError !== null) {
    throw new Error(`deploy bundle: module ${JSON.stringify(modulePath)} has invalid JavaScript syntax at offset ${facts.syntaxError}`);
  }
  const issues: string[] = [];
  for (const offset of facts.fileUrl) issues.push(`node file-URL import at offset ${offset}`);
  const labels = ["bare require( call", "CommonJS module.exports", "CommonJS free exports"] as const;
  for (const group of [0, 1, 2] as const) {
    for (const item of facts.unresolved) {
      if (item.group === group) issues.push(`${labels[group]} at offset ${item.start}`);
    }
  }
  return issues;
}

function scanModuleIssues(source: string, modulePath: string): string[] {
  return refuseModuleFrontendIssues(scanModuleFacts(source, modulePath), modulePath);
}

/**
 * Refuse any module that workerd cannot load as ESM: node file-URL imports
 * or free CommonJS references. Bound bundler `__commonJS` interop, quoted
 * tokens, and the stdlib `require` guard pass (proven by tests).
 */
export function assertWorkerdLoadable(modules: Readonly<Record<string, string>>): void {
  for (const [name, contents] of Object.entries(modules)) {
    const issues = scanModuleIssues(contents, name);
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
function collectLinkSpecifiers(js: string, modulePath: string): string[] {
  return scanModuleImports(js, modulePath).flatMap((record) => record.specifier === undefined ? [] : [record.specifier]);
}

export function assertLinksResolve(
  modules: Readonly<Record<string, string>>,
  binaryKeys: readonly string[] = [],
): void {
  const keys = new Set([...Object.keys(modules), ...binaryKeys]);
  for (const [name, contents] of Object.entries(modules)) {
    for (const spec of collectLinkSpecifiers(contents, name)) {
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

/** BGI-11 saved-unit kinds that pack JavaScript modules: Given keywords
 * (`server.js`, per the BGI-08 join) and views (`view.js`). Styles travel
 * through the CSS pipeline and traits through checked contracts. */
export type SavedUnitPackKind = "keyword" | "view";

export interface SavedUnitPackInput {
  /** Opaque saved unit id (`can.generated/<id>/`). */
  readonly unitId: string;
  readonly kind: SavedUnitPackKind;
  /** Validated saved JavaScript bytes. */
  readonly js: string;
  /** Lowercase hex SHA-256 the bytes must match exactly. */
  readonly sha256: string;
}

/** Staged module key for one packed saved unit. */
export function savedUnitStagedPath(unitId: string, kind: SavedUnitPackKind): string {
  return `can.generated/${unitId}/${kind === "keyword" ? "server.js" : "view.js"}`;
}

function assertPackUnitId(unitId: string): void {
  if (typeof unitId !== "string" || unitId.length === 0 || unitId === "." || unitId === ".." ||
      unitId.includes("/") || unitId.includes("\\") || /[\s\x00-\x1f\x7f]/.test(unitId)) {
    throw new Error(`deploy bundle: saved unit id ${JSON.stringify(unitId)} must not be empty, name a path, or contain whitespace`);
  }
}

/**
 * BGI-11 checked closure packing: stage validated saved-unit bytes at
 * their staged keys. Fingerprint-verified (expected SHA-256 must match
 * exactly), non-empty, sorted keys, duplicates refuse; changed code
 * stays loud, never packed silently. Deterministic: same inputs =>
 * identical map. Link resolution stays with `assertLinksResolve`.
 */
export function packSavedUnitModules(units: readonly SavedUnitPackInput[]): Record<string, string> {
  const staged: Record<string, string> = {};
  for (const unit of units) {
    if (unit.kind !== "keyword" && unit.kind !== "view") {
      throw new Error(`deploy bundle: saved unit ${JSON.stringify((unit as SavedUnitPackInput).unitId)} has non-packable kind ${JSON.stringify((unit as { kind?: unknown }).kind)} (only keyword and view units pack JavaScript modules)`);
    }
    assertPackUnitId(unit.unitId);
    if (typeof unit.js !== "string" || unit.js.length === 0) {
      throw new Error(`deploy bundle: saved unit ${JSON.stringify(unit.unitId)} packs empty implementation bytes; refusing an empty module`);
    }
    if (!/^[a-f0-9]{64}$/.test(unit.sha256)) {
      throw new Error(`deploy bundle: saved unit ${JSON.stringify(unit.unitId)} expects malformed SHA-256 ${JSON.stringify(unit.sha256)}`);
    }
    const actual = createHash("sha256").update(unit.js, "utf8").digest("hex");
    if (actual !== unit.sha256) {
      throw new Error(`deploy bundle: saved unit ${JSON.stringify(unit.unitId)} implementation changed (fingerprint mismatch): re-validate before packing; refusing to pack changed code silently`);
    }
    const path = savedUnitStagedPath(unit.unitId, unit.kind);
    if (Object.hasOwn(staged, path)) {
      throw new Error(`deploy bundle: saved unit ${JSON.stringify(unit.unitId)} stages duplicate path ${JSON.stringify(path)}`);
    }
    staged[path] = unit.js;
  }
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(staged).sort()) {
    sorted[key] = staged[key] as string;
  }
  return sorted;
}

/**
 * BGI-11 workerd/browser separation: every `can.generated/**` staged
 * module passes the saved-unit import policy (unit-local relative
 * imports only — no `node:`/Node builtins, no bare specifiers, no
 * file URLs). Non-generated modules are untouched; bundles without
 * packed units no-op.
 */
export function assertSavedUnitSeparation(modules: Readonly<Record<string, string>>): void {
  for (const [name, contents] of Object.entries(modules)) {
    if (!name.startsWith("can.generated/")) continue;
    assertSavedUnitImports(contents, name);
  }
}

/** @internal Exact text snapshot digest for owning writer fixtures; not an app API. */
export function bundleSha256(mainModule: string, modules: Record<string, string>): string {
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
 * a failing loadability scan, or a saved-unit module violating
 * workerd/browser separation. Deterministic: same inputs (including
 * the verdict) => identical modules + sha256.
 */
/**
 * Completed producer-bundle records for the calling process's owner cache.
 * Only keyed (exactly identified) records are reported; uncacheable builds
 * report no record for that kind.
 */
export interface ProducerBundleRecords {
  mcp?: ProducerBundleCandidate;
  http?: ProducerBundleCandidate;
}

export function buildDeployBundle(
  artifact: CompileArtifact,
  options: BuildDeployBundleOptions,
  producerCollector?: (records: ProducerBundleRecords) => void,
): DeployBundle {
  options.commandLifetime?.checkpoint("deploy bundle inputs");
  let workerDistDir = options.workerDistDir;
  if (workerDistDir === undefined) {
    try {
      workerDistDir = dirname(resolveProducerFile("@canlang/cloudflare/worker/main", "bun run --filter @canlang/cloudflare build"));
    } catch (error) {
      throw withCode(error instanceof Error ? error : new Error(String(error)), WORKER_MAIN_MISSING);
    }
  }
  const runtimeDistDir =
    options.runtimeDistDir ?? dirname(resolveProducerFile("@canlang/cloudflare/runtime/mcp-registry", "bun run --filter @canlang/cloudflare build"));
  const stagedArtifact = stageArtifactModules(artifact);
  const modules: Record<string, string> = {
    ...stageWorkerDist(workerDistDir),
    ...stageRuntimeDist(runtimeDistDir),
    ...stagedArtifact.modules,
  };
  if (Object.hasOwn(modules, HTTP_ASSETS_MODULE)) {
    throw new Error("deploy bundle: worker/http-assets.js is reserved for selected browser resources");
  }
  for (const tree of VENDOR_TREES) {
    Object.assign(modules, readVendorTree(tree));
  }
  Object.assign(modules, stageWorkStagingProducers());
  Object.assign(modules, stageFilesFinalizeProducer());
  Object.assign(modules, stageSourceMapCodec());
  Object.assign(modules, stageBrowserDependencies());
  modules[JUDGMENT_SPECIFICATION_VENDOR_ENTRY] = rewriteVendorImports(readFileSync(
    resolveProducerFile(JUDGMENT_SPECIFICATION_SOURCE_SPECIFIER, "bun run --filter @canlang/services build"), "utf8",
  ), JUDGMENT_SPECIFICATION_VENDOR_ENTRY);
  const mcpProducer = buildProducerBundle("mcp", "mcp-bundle-entry.js",
    mcpBundleEntrySource(options.commandLifetime), options.commandLifetime, options, options.producerCache?.mcp);
  const httpProducer = buildProducerBundle("http", "http-bundle-entry.js",
    httpBundleEntrySource(options.commandLifetime), options.commandLifetime, options, options.producerCache?.http);
  modules[MCP_HANDLER_MODULE] = mcpProducer.bytes;
  modules[HTTP_OPERATIONS_MODULE] = httpProducer.bytes;
  if (producerCollector !== undefined) {
    const records: ProducerBundleRecords = {};
    if (mcpProducer.key !== null && mcpProducer.inputs !== null) {
      records.mcp = { key: mcpProducer.key, bytes: mcpProducer.bytes, inputs: mcpProducer.inputs };
    }
    if (httpProducer.key !== null && httpProducer.inputs !== null) {
      records.http = { key: httpProducer.key, bytes: httpProducer.bytes, inputs: httpProducer.inputs };
    }
    producerCollector(records);
  }
  modules[ARTIFACT_MODULE] = renderStagedDeployment(
    artifact,
    portableAssembledModules(artifact.modules.map((mod) => mod.path), stagedArtifact.sourceMaps),
    options.verdict,
  );
  modules[DERIVED_INPUTS_MODULE] = buildDerivedInputsModule(artifact);
  assertSavedUnitSeparation(modules);
  assertWorkerdLoadable(modules);
  assertLinksResolve(modules);
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(modules).sort()) {
    sorted[key] = modules[key] as string;
  }
  options.commandLifetime?.checkpoint("deploy bundle verified");
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
function snapshotTextModules(modules: Record<string, string>): Record<string, string> {
  const snapshot: Record<string, string> = Object.create(null);
  for (const [key, text] of Object.entries(modules)) {
    if (typeof text !== "string") throw new Error("deploy bundle: text module must be a string");
    snapshot[key] = text;
  }
  return snapshot;
}

/** Validate the exact publication snapshot, including its text-only manifest claims. */
function assertTextBundleIntegrity(bundle: DeployBundle): void {
  const keys = Object.keys(bundle.modules);
  if (typeof bundle.mainModule !== "string" || !Object.hasOwn(bundle.modules, bundle.mainModule)) {
    throw new Error("deploy bundle: main module is absent from the publication snapshot");
  }
  if (bundle.moduleCount !== keys.length || !Number.isSafeInteger(bundle.moduleCount)) {
    throw new Error("deploy bundle: text module count mismatch — refusing to write");
  }
  if (bundleSha256(bundle.mainModule, bundle.modules) !== bundle.sha256) {
    throw new Error("deploy bundle: text digest mismatch — the bundle changed after build; refusing to write");
  }
  if (bundle.mcpBundleBytes !== (bundle.modules[MCP_HANDLER_MODULE]?.length ?? 0) ||
      bundle.httpOperationsBytes !== (bundle.modules[HTTP_OPERATIONS_MODULE]?.length ?? 0)) {
    throw new Error("deploy bundle: handler byte size mismatch — refusing to write");
  }
}

export function writeDeployBundle(bundle: DeployBundle, outDir: string): WrittenDeployBundle {
  const snapshot = { ...bundle, modules: snapshotTextModules(bundle.modules) };
  assertTextBundleIntegrity(snapshot);
  return writeCheckedDeployBundle(snapshot, outDir);
}

/** Only snapshot-owning public writers call this, after their integrity gates. */
function writeCheckedDeployBundle(bundle: DeployBundle, outDir: string): WrittenDeployBundle {
  const dir = outDir;
  const keys = Object.keys(bundle.modules).sort();
  for (const key of keys) assertSafeRelativePath(key, "to write module");
  // Reuse package-output containment before publication; canonical parents only.
  assertPackageOutputFiles(dir, [...keys, "bundle.json"]);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const key of keys) {
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
 * empty key (unwritable by definition) or the reserved `__proto__` key
 * (unrepresentable on a plain object map without silent loss).
 */
export function inventorizeAssets(
  modules: Record<string, string>,
  binaries: Record<string, Uint8Array> = {},
): AssetInventory {
  // Null-prototype map: the collision check below must be exact (inherited
  // names such as "toString" are legitimate keys, not collisions), and no
  // entry may vanish through the inherited `__proto__` setter.
  const inventory: Record<string, DeploymentAsset> = Object.create(null);
  for (const [key, text] of Object.entries(modules)) {
    if (key === "") {
      throw new Error("deploy bundle: text module key must not be empty");
    }
    if (key === "__proto__") {
      throw new Error('deploy bundle: text module key must not be "__proto__"');
    }
    inventory[key] = { kind: "text", text };
  }
  for (const [key, bytes] of Object.entries(binaries)) {
    if (key === "") {
      throw new Error("deploy bundle: binary module key must not be empty");
    }
    if (key === "__proto__") {
      throw new Error('deploy bundle: binary module key must not be "__proto__"');
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
  // Null-prototype accumulator: an own `__proto__` entry must never vanish
  // through the inherited setter (plain `{}` + assignment would silently
  // drop it before inventory/digest/write). `__proto__` keys refuse loudly
  // below instead, matching the inventory contract.
  const snapshot: Record<string, Uint8Array> = Object.create(null);
  for (const [key, bytes] of Object.entries(binaries)) {
    if (key === "__proto__") {
      throw new Error('deploy bundle: binary module key must not be "__proto__"');
    }
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
  const snapshot = { ...bundle, modules: snapshotTextModules(bundle.modules), binaries: snapshotBinaries(bundle.binaries) };
  return writeCheckedDeployBundleMixed(snapshot, outDir);
}

/** The assets entrypoint also supplies its already-owned module/binary snapshots. */
function writeCheckedDeployBundleMixed(bundle: MixedDeployBundle, outDir: string): WrittenDeployBundle {
  const { modules, binaries } = bundle;
  assertMixedOutputLayout(modules, binaries);
  const recomputed = bundleMixedSha256(bundle.mainModule, inventorizeAssets(modules, binaries));
  if (recomputed !== bundle.mixedSha256) {
    throw new Error(
      "deploy bundle: mixed digest mismatch — the bundle changed after attach; refusing to write",
    );
  }
  assertTextBundleIntegrity(bundle);
  const outputKeys = [...Object.keys(modules), ...Object.keys(binaries), ...RESERVED_MIXED_OUTPUTS];
  assertPlannedOutputFiles(new Set(outputKeys.map((key) => posix.normalize(key))));
  // Inspect complete mixed output before the text half publishes anything.
  assertPackageOutputFiles(outDir, [...Object.keys(modules).sort(), ...Object.keys(binaries).sort(), ...RESERVED_MIXED_OUTPUTS]);
  const written = writeCheckedDeployBundle(bundle, outDir);
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

/** Optional package assets do not select or initialize a runtime backend. */
export interface BuildPackageDeployBundleOptions extends BuildDeployBundleOptions {
  assets?: PackageAssetSelection;
}

/** Worker modules/WASM and separately served browser resources. */
export interface PackageDeployBundle extends MixedDeployBundle {
  resources: Record<string, PackageResource>;
  /** Digest of sorted resource keys, content types, byte lengths and hashes. */
  resourcesSha256: string;
}

function snapshotResources(resources: Record<string, PackageResource>): Record<string, PackageResource> {
  const snapshot: Record<string, PackageResource> = Object.create(null);
  for (const [key, resource] of Object.entries(resources)) {
    if (key === "__proto__") throw new Error('deploy bundle: resource key must not be "__proto__"');
    snapshot[key] = { bytes: new Uint8Array(resource.bytes), contentType: resource.contentType };
  }
  return snapshot;
}

function resourceEntries(resources: Record<string, PackageResource>): Array<{
  key: string; contentType: string; bytes: number; sha256: string;
}> {
  return Object.keys(resources).sort().map((key) => {
    const resource = resources[key] as PackageResource;
    return { key, contentType: resource.contentType, bytes: resource.bytes.length, sha256: sha256Bytes(resource.bytes) };
  });
}

function resourcesSha256(resources: Record<string, PackageResource>): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, resources: resourceEntries(resources) }))
    .digest("hex");
}

/** Build one selected, byte-pinned static handler; no alternate serving algorithm. */
function buildBrowserAssetsModule(
  resources: Record<string, PackageResource>,
  manifest: { version: 1; module: "./http-assets.js"; resourcesSha256: string; resources: ReturnType<typeof resourceEntries> },
  lifetime?: LocalCommandLifetime,
  execution: BundleExecutionOptions = {},
): string {
  lifetime?.checkpoint("deploy browser assets inputs");
  const root = fileURLToPath(interfacesDistribution.modules);
  const assets = join(root, "http", "assets.js");
  const pages = join(root, "http", "pages.js");
  for (const file of [assets, pages]) {
    if (!statSync(file).isFile()) throw new Error(`deploy bundle: missing defining browser assets producer ${file}`);
  }
  const workDir = mkdtempSync(join(execution.temporaryRoot ?? tmpdir(), "can-deploy-assets-"));
  const entry = join(workDir, "http-assets-entry.js");
  const output = join(workDir, "http-assets.mjs");
  const encoded = manifest.resources.map((row) => Buffer.from((resources[row.key] as PackageResource).bytes).toString("base64"));
  const source =
    `import { createAssetTable, handleAssetsRequest } from ${JSON.stringify(assets.split(sep).join("/"))};\n` +
    `import { matchDescriptor } from ${JSON.stringify(pages.split(sep).join("/"))};\n` +
    `const manifest = ${JSON.stringify(manifest)};\n` +
    `const encoded = ${JSON.stringify(encoded)};\n` +
    `async function sha256(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join(""); }\n` +
    `export async function createHandler(pages, expected) {\n` +
    `  if (JSON.stringify(expected) !== JSON.stringify(manifest)) throw new Error("browser assets: staged manifest mismatch");\n` +
    `  if (await sha256(new TextEncoder().encode(JSON.stringify({ version: 1, resources: manifest.resources }))) !== manifest.resourcesSha256) throw new Error("browser assets: resource manifest digest mismatch");\n` +
    `  const paths = manifest.resources.map(row => "/assets/" + row.key.split("/").map(part => encodeURIComponent(part).replace(/[!\'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase())).join("/"));\n` +
    `  for (const path of paths) if (matchDescriptor(pages, path) !== null) throw new Error("browser assets: selected page collides with " + path);\n` +
    `  const rows = [];\n` +
    `  for (const [index, row] of manifest.resources.entries()) {\n` +
    `    const bytes = Uint8Array.from(atob(encoded[index]), value => value.charCodeAt(0));\n` +
    `    if (bytes.length !== row.bytes || await sha256(bytes) !== row.sha256) throw new Error("browser assets: selected resource integrity mismatch " + row.key);\n` +
    `    rows.push({ key: row.key, bytes, mime: row.contentType, cache: { maxAgeSeconds: 0, immutable: false } });\n` +
    `  }\n` +
    `  const table = createAssetTable(rows);\n` +
    `  return Object.freeze({ paths: Object.freeze(paths), fetch: request => handleAssetsRequest(table, request) });\n` +
    `}\n`;
  try {
    writeFileSync(entry, source, "utf8");
    lifetime?.checkpoint("deploy browser assets esbuild start");
    runBrowserBundle(entry, output, lifetime, true, execution);
    lifetime?.checkpoint("deploy browser assets esbuild completed");
    const contents = readFileSync(output, "utf8");
    for (const marker of ["createHandler", "browser assets: selected page collides", "browser assets: selected resource integrity mismatch"]) {
      if (!contents.includes(marker)) throw new Error(`deploy bundle: selected browser assets bundle dropped ${marker}`);
    }
    return contents;
  } catch (error) {
    if (error instanceof LocalCommandInterrupted) throw error;
    lifetime?.checkpoint("deploy browser assets esbuild failed");
    throw new Error(`deploy bundle: selected browser assets producer bundle failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Exact compiler-owned CSS asset bytes, checked before deployment or preview. */
export function generatedStyleResources(artifact: CompileArtifact): Record<string, PackageResource> {
  const resources: Record<string, PackageResource> = Object.create(null);
  for (const sheet of artifact.stylesheets ?? []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(sheet.owner.unitId)) throw new Error("deploy bundle: invalid owning stylesheet identity");
    for (const asset of sheet.assets ?? []) {
      const prefix = `can.generated/${sheet.owner.unitId}/`;
      const relative = asset.path.slice(prefix.length);
      if (!asset.path.startsWith(prefix) || !relative || relative.includes("\\") ||
          relative.split("/").some(part => !part || part === "." || part === "..") ||
          Object.hasOwn(resources, asset.path)) throw new Error("deploy bundle: invalid owning stylesheet asset path");
      const bytes = new Uint8Array(Buffer.from(asset.contentBase64, "base64"));
      if (Buffer.from(bytes).toString("base64") !== asset.contentBase64 || sha256Bytes(bytes) !== asset.sha256 ||
          assetContentType(asset.path, bytes) !== asset.contentType) {
        throw new Error(`deploy bundle: invalid owning stylesheet asset bytes ${JSON.stringify(asset.path)}`);
      }
      resources[asset.path] = { bytes, contentType: asset.contentType };
    }
  }
  return resources;
}

/** Bundle saved mounts with the defining browser registry, preserving one client. */
function buildGeneratedBrowserClient(artifact: CompileArtifact, lifetime?: LocalCommandLifetime, execution: BundleExecutionOptions = {}): Uint8Array | null {
  const views = (artifact.generatedViews ?? []).filter(view => view.mountExport !== undefined);
  if (views.length === 0) return null;
  const workDir = mkdtempSync(join(execution.temporaryRoot ?? tmpdir(), "can-generated-browser-"));
  try {
    for (const module of artifact.modules.filter(module => module.path.startsWith("can.generated/"))) {
      const path = join(workDir, module.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, module.js, "utf8");
    }
    const bootstrap = join(fileURLToPath(uiDistribution.modules), "browser", "bootstrap.js");
    const entry = join(workDir, "entry.js"), output = join(workDir, "bootstrap.js");
    const lines = [`import { registerGeneratedViewMount, startNativeBrowserClient } from ${JSON.stringify(bootstrap)};`];
    for (const [index, view] of views.entries()) {
      if (!/^can\.generated\/[^/]+\/view\.js$/.test(view.module) ||
          view.mountExport !== "mount" || !artifact.modules.some(module => module.path === view.module)) {
        throw new Error("deploy bundle: invalid checked generated browser mount");
      }
      lines.push(`import { mount as mount${index} } from ${JSON.stringify(`./${view.module}`)};`);
      lines.push(`registerGeneratedViewMount(${JSON.stringify(view.view)}, mount${index});`);
    }
    // The defining bootstrap may have started on an already parsed document.
    // Mount newly registered views without disposing live forms or panels.
    lines.push('if (typeof window !== "undefined" && window.document.readyState !== "loading") { startNativeBrowserClient(window).rescan(); }');
    writeFileSync(entry, lines.join("\n"), "utf8");
    lifetime?.checkpoint("deploy generated browser esbuild start");
    runBrowserBundle(entry, output, lifetime, true, execution);
    lifetime?.checkpoint("deploy generated browser esbuild completed");
    return new Uint8Array(readFileSync(output));
  } finally { rmSync(workDir, { recursive: true, force: true }); }
}

/**
 * Resolve explicit assets from the installed owning packages. Binding JS uses
 * the same vendor rewrite/link checks as ordinary producers. Browser resources
 * remain outside the Worker module inventory, including browser JavaScript.
 */
function mergeGeneratedStyles(artifact: CompileArtifact, resources: ReturnType<typeof snapshotResources>): void {
  Object.assign(resources, generatedStyleResources(artifact));
  if ((artifact.stylesheets?.length ?? 0) === 0) return;
  const baseCss = resources["browser/can-style.css"];
  if (baseCss === undefined) throw new Error("deploy bundle: generated styles need the canonical browser stylesheet");
  const paths = new Set<string>();
  const css: string[] = [];
  for (const sheet of artifact.stylesheets ?? []) {
    if (paths.has(sheet.path) || sheet.path !== `can.generated/${sheet.owner.unitId}/style.css` ||
        sha256Bytes(new TextEncoder().encode(sheet.css)) !== sheet.sha256) {
      throw new Error(`deploy bundle: invalid generated stylesheet ${JSON.stringify(sheet.path)}`);
    }
    paths.add(sheet.path);
    css.push(sheet.css);
  }
  resources["browser/can-style.css"] = { ...baseCss,
    bytes: new TextEncoder().encode(`${new TextDecoder().decode(baseCss.bytes)}\n${css.join("\n")}\n`) };
}

function installBrowserAssets(artifact: CompileArtifact, resources: ReturnType<typeof snapshotResources>,
  modules: ReturnType<typeof buildDeployBundle>['modules'], options: BuildPackageDeployBundleOptions): string {
  const generatedClient = buildGeneratedBrowserClient(artifact, options.commandLifetime, options);
  if (generatedClient !== null) resources["browser/bootstrap.js"] = { bytes: generatedClient, contentType: "application/javascript" };
  const resourceDigest = resourcesSha256(resources);
  const entries = resourceEntries(resources);
  if (!["browser/bootstrap.js", "browser/can-style.css", "browser/polling.js"].every(key => Object.hasOwn(resources,key))) {
    throw new Error("deploy bundle: selected browser resource inventory lacks the canonical shared producer");
  }
  const manifest = { version: 1 as const, module: "./http-assets.js" as const, resourcesSha256: resourceDigest, resources: entries };
  modules[HTTP_ASSETS_MODULE] = buildBrowserAssetsModule(resources, manifest, options.commandLifetime, options);
  modules[ARTIFACT_MODULE] += `export const browserAssets = ${JSON.stringify(manifest)};\n`;
  return resourceDigest;
}

export function buildDeployBundleWithAssets(
  artifact: CompileArtifact,
  options: BuildPackageDeployBundleOptions,
  producerCollector?: (records: ProducerBundleRecords) => void,
): PackageDeployBundle {
  options.commandLifetime?.checkpoint("deploy package assets inputs");
  const assets = gatherDeploymentAssets(options.assets);
  const base = buildDeployBundle(artifact, options, producerCollector);
  const modules = { ...base.modules };
  const resources = snapshotResources(assets.resources);
  let resourceDigest = resourcesSha256(resources);
  if (options.assets?.browser === true) {
    mergeGeneratedStyles(artifact, resources);
    resourceDigest = installBrowserAssets(artifact, resources, modules, options);
  }
  for (const [key, js] of Object.entries(assets.modules)) {
    if (Object.hasOwn(modules, key)) {
      throw new Error(`deploy bundle: package asset ${JSON.stringify(key)} collides with a text module`);
    }
    modules[key] = rewriteVendorImports(js, key);
  }
  assertWorkerdLoadable(modules);
  assertLinksResolve(modules, Object.keys(assets.binaries));
  const sorted = Object.fromEntries(Object.entries(modules).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const mixed = attachBinaries({
    ...base,
    modules: sorted,
    moduleCount: Object.keys(sorted).length,
    sha256: bundleSha256(base.mainModule, sorted),
  }, assets.binaries);
  assertPackageOutputLayout(mixed.modules, mixed.binaries, resources);
  options.commandLifetime?.checkpoint("deploy package bundle verified");
  return { ...mixed, resources, resourcesSha256: resourceDigest };
}

/** Validate the complete resource/module layout before creating the output. */
function assertPackageOutputLayout(
  modules: Record<string, string>,
  binaries: Record<string, Uint8Array>,
  resources: Record<string, PackageResource>,
): void {
  assertMixedOutputLayout(modules, binaries);
  const seen = new Map<string, string>();
  for (const [what, keys] of [
    ["text module", Object.keys(modules)],
    ["binary module", Object.keys(binaries)],
    ["resource", Object.keys(resources)],
  ] as const) {
    for (const key of keys) {
      assertSafeRelativePath(key, `to write ${what}`);
      const normalized = posix.normalize(key);
      if (normalized === "." || key.includes("\\")) {
        throw new Error(`deploy bundle: invalid output path ${JSON.stringify(key)}`);
      }
      if (RESERVED_MIXED_OUTPUTS.has(normalized) || normalized === "bundle.resources.json") {
        throw new Error(`deploy bundle: ${what} ${JSON.stringify(key)} reserves writer manifest path`);
      }
      const prior = seen.get(normalized);
      if (prior !== undefined) {
        throw new Error(`deploy bundle: ${what} ${JSON.stringify(key)} aliases ${JSON.stringify(prior)} after normalization`);
      }
      seen.set(normalized, key);
    }
  }
  // A file cannot also be an ancestor directory of a second output.
  // Include manifests so paths beneath writer-owned files also refuse.
  const outputs = new Set([...seen.keys(), ...RESERVED_MIXED_OUTPUTS, "bundle.resources.json"]);
  assertPlannedOutputFiles(outputs);
}

function assertPlannedOutputFiles(outputs: ReadonlySet<string>): void {
  // A trailing slash does not distinguish a file from a directory ancestor.
  const files = new Set([...outputs].map((key) => key.endsWith("/") ? key.slice(0, -1) : key));
  for (const key of files) {
    let parent = posix.dirname(key);
    while (parent !== ".") {
      if (files.has(parent)) {
        throw new Error(`deploy bundle: output ${JSON.stringify(key)} has file/directory collision with ${JSON.stringify(parent)}`);
      }
      parent = posix.dirname(parent);
    }
  }
}

/** Existing output entries must not redirect any file write through symlinks.
 * The confirmed host also uses this preflight for its fixed sidecar names.
 */
export function assertPackageOutputFiles(
  outDir: string,
  keys: readonly string[],
): void {
  const inspect = (path: string, directory: boolean): boolean => {
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`deploy bundle: refusing output symlink ${JSON.stringify(path)}`);
    }
    if (directory ? !info.isDirectory() : !info.isFile()) {
      throw new Error(`deploy bundle: existing output has file/directory collision at ${JSON.stringify(path)}`);
    }
    return true;
  };
  const root = resolve(outDir);
  const rootExists = inspect(root, true);
  // A canonical existing ancestor proves that the requested root is not
  // reached through an alias. Inspect only the nearest existing parent so
  // permission-scoped consumers need no filesystem access above their root.
  let existing = root;
  if (!rootExists) {
    do {
      existing = dirname(existing);
    } while (!inspect(existing, true));
  }
  if (realpathSync(existing) !== existing) {
    throw new Error(`deploy bundle: refusing output symlink in ancestors of ${JSON.stringify(root)}`);
  }
  if (!rootExists) return;
  for (const key of keys) {
    const parts = posix.normalize(key).split("/");
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index] as string);
      if (!inspect(current, index < parts.length - 1)) break;
    }
  }
}

/**
 * Write explicit package assets with exact bytes and a resource manifest.
 * Output paths and their parents must be free of symlinks; use a canonical
 * parent directory when the host supplies an alias such as macOS `/var`.
 */
export function writeDeployBundleWithAssets(bundle: PackageDeployBundle, outDir: string): WrittenDeployBundle {
  bundle = { ...bundle, modules: snapshotTextModules(bundle.modules),
    binaries: snapshotBinaries(bundle.binaries), resources: snapshotResources(bundle.resources) };
  const { modules, binaries, resources } = bundle;
  assertPackageOutputLayout(modules, binaries, resources);
  assertPackageOutputFiles(outDir, [
    ...Object.keys(modules), ...Object.keys(binaries), ...Object.keys(resources),
    ...RESERVED_MIXED_OUTPUTS, "bundle.resources.json",
  ]);
  if (resourcesSha256(resources) !== bundle.resourcesSha256) {
    throw new Error("deploy bundle: resource digest mismatch — the bundle changed after build; refusing to write");
  }
  const written = writeCheckedDeployBundleMixed(bundle, resolve(outDir));
  const entries = resourceEntries(resources);
  for (const { key } of entries) {
    const full = join(written.dir, key);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, (resources[key] as PackageResource).bytes);
  }
  const manifestFile = join(written.dir, "bundle.resources.json");
  writeFileSync(manifestFile, `${JSON.stringify({
    version: 1, resourcesSha256: bundle.resourcesSha256, resources: entries,
  }, null, 2)}\n`, "utf8");
  return {
    ...written,
    files: [...written.files, ...entries.map(({ key }) => join(written.dir, key)), manifestFile].sort(),
  };
}
