/**
 * Artifact loader: the ONE place e2e turns a `CompileArtifact` into
 * runnable assemblies. Two sources, one canonical validation core:
 *
 * - `handbuilt`: the honestly-labeled fixture worker in
 *   `./handbuilt/`. The assembly label starts with
 *   `fixture/handbuilt/`; specs assert the label so a fixture run can
 *   never masquerade as a compiled run.
 * - `compiled` (T21): a REAL `can compile` run over a fixture `.can`
 *   source — the loader invokes the toolchain, validates stdout with the
 *   canonical runtime validator, asserts compiled identity (source path +
 *   content-hash binding against the toolchain stamps), and stages the
 *   emitted modules with the canonical assembler. The assembly label is
 *   `compiled/<sha256>`; specs assert it. No hand-built substitution
 *   exists on this path: any toolchain/validation/identity failure throws
 *   loud.
 *
 * Validation enforces artifact.ts v1 compatibility exactly: additive-only,
 * `artifact_version` 1, unknown callable kinds, malformed `member` paths,
 * or malformed `requires` entries are precise errors, never silent support.
 *
 * Producer dist bundling: the worker runs REAL producer code — @canlang/ui
 * rendering, @canlang/identity auth/session logic, and @canlang/contracts
 * constants — loaded from their built dists into the miniflare module map
 * under `vendor/`. A missing dist fails loud naming the exact build
 * command; the loader never stubs a producer.
 * Identity is bundled from its public built exports, including its testing
 * store, so installed dependencies and Worker-conditioned package imports
 * resolve into one closure rather than leaking bare imports into workerd.
 * The fixture's public UI rendering APIs are bundled the same way, including
 * their Values codecs and installed dependencies.
 *
 * MCP bundling: the `/mcp` leg additionally serves `vendor/mcp/bundle.js`,
 * a single self-contained ESM module built at load time by `bun build
 * --target=browser --format=esm` from `./handbuilt/mcp-bundle-entry.js`
 * (which re-exports ONLY the real `createMcpHandler` from interfaces dist
 * and the real `createArtifactRegistry`/`createArtifactCatalog` from
 * cloudflare dist). Bundling — not file vendoring — is required because two
 * transitive MCP SDK deps (ajv, content-type) ship CJS only and cannot load
 * as workerd ESModules; the bundle is byte-built from the real dists on
 * every load (no checked-in blob, no stub). A missing dist, unresolvable
 * SDK, missing `bun`, or build failure throws naming the exact fix.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, relative } from "node:path";
import type { LocalD1 } from "@canlang/cloudflare";
import { distribution as contractsDistribution } from "@canlang/contracts/distribution";
import type { CompileArtifact, StoragePort } from "@canlang/contracts";
import {
  assertCompiledIdentity,
  parseArtifactText,
} from "@canlang/cloudflare/runtime/artifact";
import {
  assembleModules,
  type AssembledModules,
} from "@canlang/cloudflare/runtime/modules";
import type {
  buildInvoker as BuildInvokerFn,
  CanonicalInvokerOpts,
  OperationInvoker,
} from "@canlang/cloudflare/worker/assembly";
import {
  TEAMTASKS_D1_BINDING,
  TEAMTASKS_OPERATIONS,
  TEAMTASKS_SOURCE_RELATIVE,
  TEAMTASKS_SOURCE_SHA256,
  TEAMTASKS_WORKER_NAME,
  buildTeamTasksWorkerSource,
  teamTasksArtifact,
} from "./handbuilt/teamtasks.js";
import { readVendorTree } from "./vendor-trees.js";

export const ARTIFACT_VERSION_SUPPORTED = 1;

/**
 * workerd compatibility date for e2e instances (proven in
 * tests/integration/readiness.test.ts; newest workerd: 2026-08-06).
 * Assemblies carry it so specs never invent one.
 */
export const E2E_COMPATIBILITY_DATE = "2026-07-15";

export type ArtifactSpec =
  | { readonly kind: "handbuilt"; readonly app: "teamtasks" }
  | { readonly kind: "compiled"; readonly source: string; readonly extraSources?: readonly string[] };

export type CompiledArtifactSpec = Extract<ArtifactSpec, { kind: "compiled" }>;

export interface WorkerAssembly {
  readonly artifact: CompileArtifact;
  readonly mainModule: string;
  readonly modules: Record<string, string>;
  readonly d1Databases: readonly LocalD1[];
  readonly workerName: string;
  readonly compatibilityDate: string;
  /** Always `fixture/handbuilt/<app>` — asserted by specs. */
  readonly label: string;
}

const CALLABLE_KINDS = new Set(["operation", "pure", "rule", "handler", "migration"]);

export function assertSupportedArtifact(artifact: CompileArtifact): void {
  if (artifact.artifact_version !== ARTIFACT_VERSION_SUPPORTED) {
    throw new Error(
      `e2e loader: unsupported artifact_version ${String(artifact.artifact_version)} (want 1)`,
    );
  }
  if (artifact.modules.length === 0) {
    throw new Error("e2e loader: artifact has no modules; modules[0] must be the entrypoint");
  }
  for (const [index, callable] of artifact.callables.entries()) {
    if (!CALLABLE_KINDS.has(callable.kind)) {
      throw new Error(`e2e loader: unknown callable kind ${JSON.stringify(callable.kind)}`);
    }
    // Member-shape check mirrors the B1 runtime loader
    // (packages/cloudflare/src/runtime/artifact.ts): the registry path must
    // be present and well-formed, else the artifact predates the linkage
    // contract and must be recompiled.
    const member: unknown = callable.member;
    if (
      !Array.isArray(member) ||
      member.length === 0 ||
      !member.every((segment) => typeof segment === "string" && segment.length > 0)
    ) {
      throw new Error(
        `e2e loader: callables[${index}].member for callable ${JSON.stringify(callable.id)} must be a ` +
          `non-empty array of non-empty strings (registry path into canApp()); ` +
          "recompile with the fixed `can compile`",
      );
    }
  }
  for (const requirement of artifact.requires) {
    if (typeof requirement.capability !== "string" || requirement.capability.length === 0) {
      throw new Error("e2e loader: requires entry with empty capability");
    }
    // `>= 0`, not `>= 1`: the real producer (`can compile`, via
    // `compute_requires` in compiler/src/codegen/artifact.rs) emits
    // `{capability: "canlang.builtins", min_version: 0}`, and the contract
    // (ArtifactRequirement.min_version) types it as a plain `number` with no
    // minimum. Matches the B1 runtime loader
    // (packages/cloudflare/src/runtime/artifact.ts), which accepts 0.
    if (!Number.isInteger(requirement.min_version) || requirement.min_version < 0) {
      throw new Error(
        `e2e loader: requires entry ${JSON.stringify(requirement.capability)} has bad min_version`,
      );
    }
  }
}

function repoRoot(): string {
  return fileURLToPath(new URL("../../..", import.meta.url));
}

/** Fail loud when the hand-built fixture's source witness drifted. */
function assertSourceWitness(root: string, relativePath: string, wantSha256: string): void {
  const bytes = readFileSync(join(root, relativePath));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== wantSha256) {
    throw new Error(
      `e2e loader: ${relativePath} drifted under the hand-built fixture ` +
        `(sha ${sha256.slice(0, 12)}… vs pinned ${wantSha256.slice(0, 12)}…); ` +
        `update the fixture, never the pin alone`,
    );
  }
}

const producerRequire = createRequire(import.meta.url);

function resolveBuiltModule(specifier: string, buildCommand: string): string {
  try {
    const moduleUrl = typeof import.meta.resolve === "function"
      ? import.meta.resolve(specifier)
      : pathToFileURL(producerRequire.resolve(specifier)).href;
    if (!statSync(new URL(moduleUrl)).isFile()) throw new Error("not a file");
    return moduleUrl;
  } catch {
    throw new Error(`e2e loader: ${specifier} not built; run \`${buildCommand}\` first`);
  }
}

/**
 * Build the `vendor/mcp/bundle.js` module: the real MCP handler chain
 * (interfaces `createMcpHandler` + cloudflare registry/catalog builders)
 * bundled self-contained for workerd. Fails loud naming the fix — never a
 * stub, never a stale checked-in blob: the bundle is rebuilt from the live
 * dists on every assembly.
 */
function buildMcpBundle(root: string): string {
  resolveBuiltModule("@canlang/interfaces/mcp/server", "bun run --filter @canlang/interfaces build");
  resolveBuiltModule("@canlang/cloudflare/runtime/mcp-registry", "bun run --filter @canlang/cloudflare build");
  return buildWorkerBundle(root, "MCP", "mcp-bundle-entry.js",
    ["createMcpHandler", "createArtifactRegistry", "createArtifactCatalog"],
    "the MCP SDK must resolve (run `bun install`) and both producer dists must be built");
}

/** Bundle public Identity APIs and their installed dependency closure once. */
function buildIdentityBundle(root: string): string {
  resolveBuiltModule("@canlang/identity", "bun run --filter @canlang/identity build");
  resolveBuiltModule("@canlang/identity/testing", "bun run --filter @canlang/identity build");
  return buildWorkerBundle(root, "Identity", "identity-bundle-entry.js",
    ["IdentityError", "resolveIdentity", "verifyCsrfToken", "createMemoryIdentityStore"],
    "Identity dependencies must resolve (run `bun install`) and its producer dist must be built");
}

/** Bundle the worker's real UI rendering APIs and their Values closure. */
function buildUiBundle(root: string): string {
  resolveBuiltModule("@canlang/ui", "bun run --filter @canlang/ui build");
  resolveBuiltModule("@canlang/values", "bun run --filter @canlang/values build");
  return buildWorkerBundle(root, "UI", "ui-bundle-entry.js",
    ["card", "escapeHtml", "renderLogin", "text", "title"],
    "UI dependencies must resolve (run `bun install`) and UI/Values producer dists must be built");
}

function buildWorkerBundle(
  root: string,
  producer: string,
  entryName: string,
  markers: readonly string[],
  prerequisites: string,
): string {
  const entry = join(root, "tests/e2e/fixtures/handbuilt", entryName);
  const workDir = mkdtempSync(join(tmpdir(), `can-e2e-${producer.toLowerCase()}-bundle-`));
  const outFile = join(workDir, "bundle.mjs");
  let contents: string;
  try {
    try {
      execFileSync(
        "bun",
        ["build", entry, "--format=esm", "--target=browser", `--outfile=${outFile}`],
        { stdio: "pipe" },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (detail.includes("ENOENT")) {
        throw new Error(
          `e2e loader: \`bun\` is not on PATH, needed to bundle ${producer}; ` +
            "install bun (https://bun.sh) or run e2e via `bun run test:e2e`",
        );
      }
      throw new Error(
        `e2e loader: ${producer} bundle build failed (\`bun build ${entry}\`); ` +
          `${prerequisites}. ` +
          `Underlying error: ${detail}`,
      );
    }
    contents = readFileSync(outFile, "utf8");
  } catch (thrown) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Preserve the build/read failure even if cleanup also fails.
    }
    throw thrown;
  }
  rmSync(workDir, { recursive: true, force: true });
  for (const marker of markers) {
    if (!contents.includes(marker)) {
      throw new Error(
        `e2e loader: ${producer} bundle build dropped ${marker}; refusing a skewed bundle ` +
          `(rebuild the producer dists and retry)`,
      );
    }
  }
  return contents;
}

function loadHandbuiltTeamTasks(root: string): WorkerAssembly {
  assertSourceWitness(root, TEAMTASKS_SOURCE_RELATIVE, TEAMTASKS_SOURCE_SHA256);
  const artifact = teamTasksArtifact();
  assertSupportedArtifact(artifact);
  if (artifact.operations === undefined || artifact.operations.length === 0) {
    throw new Error(
      "e2e loader: fixture artifact has no operations[]; the /mcp registry would be empty " +
        "(TEAMTASKS_OPERATIONS in fixtures/handbuilt/teamtasks.ts owns the served ops)",
    );
  }
  const modules: Record<string, string> = { "worker.mjs": buildTeamTasksWorkerSource() };
  modules["vendor/mcp/bundle.js"] = buildMcpBundle(root);
  modules["vendor/identity/index.js"] = buildIdentityBundle(root);
  modules["vendor/ui/index.js"] = buildUiBundle(root);
  // Both fixture imports share the same bundled Identity module instance.
  modules["vendor/identity/testing.js"] =
    'export { createMemoryIdentityStore } from "./index.js";\n';
  // The worker's registry input, stamped from the SAME entries the artifact
  // JSON carries (one source of truth: TEAMTASKS_OPERATIONS).
  modules["vendor/mcp/fixture-ops.js"] =
    `export const FIXTURE_OPERATIONS = ${JSON.stringify(TEAMTASKS_OPERATIONS)};\n`;
  for (const tree of [
    readVendorTree(contractsDistribution.modules, "vendor/contracts", "bun run --filter @canlang/contracts build"),
  ]) {
    for (const [name, contents] of Object.entries(tree)) modules[name] = contents;
  }
  return {
    artifact,
    mainModule: "worker.mjs",
    modules,
    d1Databases: [{ binding: TEAMTASKS_D1_BINDING, id: "e2e-teamtasks" }],
    workerName: TEAMTASKS_WORKER_NAME,
    compatibilityDate: E2E_COMPATIBILITY_DATE,
    label: "fixture/handbuilt/teamtasks",
  };
}

export function loadArtifact(spec: ArtifactSpec): WorkerAssembly {
  if (spec.kind === "compiled") {
    throw new Error(
      "e2e loader: compiled artifacts load asynchronously (the loader runs the real " +
        "`can compile` toolchain); use `loadCompiledArtifact({ kind: \"compiled\", " +
        `source: ${JSON.stringify(spec.source)} }) instead of \`loadArtifact\``,
    );
  }
  return loadHandbuiltTeamTasks(repoRoot());
}

/* ------------------------------------------------------------------ */
/* T21 compiled path: real toolchain -> canonical validation/identity  */
/* -> canonical staging -> canonical invoker. No fixture substitution. */
/* ------------------------------------------------------------------ */

/** Label prefix for genuine compiled assemblies (`compiled/<sha256>`). */
export const COMPILED_LABEL_PREFIX = "compiled/";

/** Repo-relative `can` binary (built from HEAD; never vendored). */
export const COMPILED_CAN_BINARY = "compiler/target/debug/can";
export const COMPILED_CAN_BUILD_COMMAND = "cargo build --bin can --manifest-path compiler/Cargo.toml";
const CLOUDFLARE_DIST_BUILD_COMMAND = "bun run --filter @canlang/cloudflare build";

export interface CompiledSourceRef {
  /** Repo-relative `.can` path exactly as handed to the toolchain. */
  readonly path: string;
  /** SHA-256 of the exact bytes handed to the toolchain. */
  readonly sha256: string;
}

export interface CompiledAssembly {
  readonly artifact: CompileArtifact;
  /** Repo-relative `.can` path exactly as handed to the toolchain. */
  readonly sourcePath: string;
  /** SHA-256 of the exact bytes handed to the toolchain. */
  readonly sourceSha256: string;
  /**
   * Provider sources compiled alongside the pilot (T37 minimal closure,
   * e.g. shared Employees/Locations): hashed evidence that every input
   * was the committed bytes. Empty for single-source assemblies. The
   * pilot stays first, so `sources[0]` identity still binds the pilot.
   */
  readonly extraSources: readonly CompiledSourceRef[];
  /** Toolchain stamps the artifact was verified against. */
  readonly toolVersion: string;
  readonly languageVersion: string;
  /** Raw `can --version` line (toolchain evidence). */
  readonly toolchain: string;
  /** Canonically staged emitted modules (temp dir; see `dispose`). */
  readonly asm: AssembledModules;
  readonly workDir: string;
  /** `compiled/<sourceSha256>` — asserted by specs. */
  readonly label: string;
}

function canBinary(root: string): string {
  const bin = join(root, COMPILED_CAN_BINARY);
  try {
    if (!statSync(bin).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(
      `e2e loader: ${COMPILED_CAN_BINARY} not built; run \`${COMPILED_CAN_BUILD_COMMAND}\` first`,
    );
  }
  return bin;
}

function toolchainVersions(root: string): { toolVersion: string; languageVersion: string; line: string } {
  const bin = canBinary(root);
  const result = spawnSync(bin, ["--version"], { cwd: root, encoding: "utf8" });
  const line = typeof result.stdout === "string" ? result.stdout.trim().split("\n")[0] ?? "" : "";
  const match = /^can (\S+) \(commit ([^;]+); language (\S+); schema (\S+)\)$/.exec(line);
  if (result.status !== 0 || match === null) {
    throw new Error(
      `e2e loader: cannot read the toolchain identity (\`${COMPILED_CAN_BINARY} --version\` ` +
        `exited ${String(result.status)} with ${JSON.stringify(line)}); rebuild with ` +
        `\`${COMPILED_CAN_BUILD_COMMAND}\``,
    );
  }
  const [, toolVersion, , languageVersion] = match;
  if (toolVersion === undefined || languageVersion === undefined) {
    throw new Error(`e2e loader: unparseable toolchain identity ${JSON.stringify(line)}`);
  }
  return { toolVersion, languageVersion, line };
}

function summarizeDiagnostics(stdout: string): string {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || !("diagnostics" in parsed)) return "";
    const diagnostics = (parsed as { diagnostics: unknown }).diagnostics;
    if (!Array.isArray(diagnostics)) return "";
    return diagnostics
      .slice(0, 5)
      .map((diagnostic) => {
        if (typeof diagnostic !== "object" || diagnostic === null) return "unknown diagnostic";
        const row = diagnostic as Record<string, unknown>;
        return `${String(row["code"] ?? "?")}: ${String(row["message"] ?? "?")}`;
      })
      .join("; ");
  } catch {
    return "";
  }
}

function compileSource(
  root: string,
  source: string,
  extraSources: readonly string[],
): {
  stdout: string;
  sourceSha256: string;
  extras: CompiledSourceRef[];
  toolVersion: string;
  languageVersion: string;
  line: string;
} {
  const hashSource = (path: string): string => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(root, path));
    } catch {
      throw new Error(`e2e loader: compiled source not readable: ${path}`);
    }
    return createHash("sha256").update(bytes).digest("hex");
  };
  const sourceSha256 = hashSource(source);
  const extras = extraSources.map((path) => ({ path, sha256: hashSource(path) }));
  const { toolVersion, languageVersion, line } = toolchainVersions(root);
  const bin = canBinary(root);
  // Pilot first: `can compile FILE...` binds artifact sources in argv
  // order, so `sources[0]` identity keeps binding the pilot.
  const result = spawnSync(bin, ["compile", "--format=json", source, ...extraSources], {
    cwd: root,
    encoding: "utf8",
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (result.status !== 0) {
    const diagnostics = summarizeDiagnostics(stdout);
    throw new Error(
      `e2e loader: \`can compile\` failed for ${[source, ...extraSources].join(", ")} ` +
        `(exit ${String(result.status)}): ` +
        (diagnostics !== "" ? diagnostics : stderr.trim().split("\n")[0] ?? "no output"),
    );
  }
  return { stdout, sourceSha256, extras, toolVersion, languageVersion, line };
}

async function distBuildInvoker(): Promise<typeof BuildInvokerFn> {
  try {
    const mod = await import("@canlang/cloudflare/worker/assembly");
    return mod.buildInvoker as typeof BuildInvokerFn;
  } catch {
    throw new Error(
      `e2e loader: @canlang/cloudflare/worker/assembly not built; ` +
        `run \`${CLOUDFLARE_DIST_BUILD_COMMAND}\` first`,
    );
  }
}

/**
 * Compile `spec.source` with the REAL `can compile` toolchain and load it
 * through the canonical chain: `parseArtifactText` (the exact
 * `loadArtifactFile` rules), `assertCompiledIdentity` (source path +
 * content-hash binding against the toolchain stamps), `assembleModules`
 * (canonical staging with the dist stdlib seam). No hand-built artifact
 * substitution exists anywhere on this path — every failure throws loud.
 */
export async function loadCompiledArtifact(spec: CompiledArtifactSpec): Promise<CompiledAssembly> {
  const root = repoRoot();
  const source = spec.source;
  const extraSources = spec.extraSources ?? [];
  const { stdout, sourceSha256, extras, toolVersion, languageVersion, line } = compileSource(
    root,
    source,
    extraSources,
  );
  let artifact: CompileArtifact;
  try {
    artifact = parseArtifactText(stdout, `compiled:${source}`).artifact;
  } catch (error) {
    const diagnostics = summarizeDiagnostics(stdout);
    throw new Error(
      `e2e loader: \`can compile\` output for ${source} is not a valid artifact` +
        (diagnostics !== "" ? ` (diagnostics: ${diagnostics})` : "") +
        `: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertCompiledIdentity(artifact, {
    sourcePath: source,
    sourceSha256,
    toolVersion,
    languageVersion,
  });
  const stdlibUrl = resolveBuiltModule("@canlang/cloudflare/runtime/stdlib", CLOUDFLARE_DIST_BUILD_COMMAND);
  const workDir = mkdtempSync(join(tmpdir(), "can-e2e-compiled-"));
  let asm: AssembledModules;
  try {
    asm = await assembleModules(
      { artifact, sourcePath: `compiled:${source}` },
      {
        workDir,
        stdlibUrl,
      },
    );
  } catch (thrown) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Preserve the assembly failure even if cleanup also fails.
    }
    throw thrown;
  }
  return {
    artifact,
    sourcePath: source,
    sourceSha256,
    extraSources: extras,
    toolVersion,
    languageVersion,
    toolchain: line,
    asm,
    workDir,
    label: `${COMPILED_LABEL_PREFIX}${sourceSha256}`,
  };
}

/** Remove the staged temp dir for a compiled assembly (best-effort). */
export function disposeCompiledAssembly(compiled: CompiledAssembly): void {
  rmSync(compiled.workDir, { recursive: true, force: true });
}

/**
 * Build the canonical `OperationInvoker` for a compiled assembly — the
 * REAL T16/T17 descriptor path (verified-context admission through the
 * real registry, canonical transaction/history/replay/projection). Thin
 * delegation to the built worker assembly; the dist seam fails loud.
 */
export async function createCompiledInvoker(
  compiled: CompiledAssembly,
  store: StoragePort,
  opts: CanonicalInvokerOpts = {},
): Promise<OperationInvoker> {
  const build = await distBuildInvoker();
  return build(compiled.artifact, compiled.asm, store, opts);
}
