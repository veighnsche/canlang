/**
 * Artifact loader: the ONE place e2e turns a `CompileArtifact` into
 * `startLocalDev` modules. Two sources, one assembly path:
 *
 * - `handbuilt`: the honestly-labeled fixture worker in
 *   `./handbuilt/` (used until L1 PR6 emission lands). The assembly label
 *   starts with `fixture/handbuilt/`; specs assert the label so a fixture
 *   run can never masquerade as a compiled run.
 * - `compiled`: a real `can compile` artifact file. Until L1 PR6 emission
 *   lands this fails LOUD naming the unmet producer contract; afterwards it
 *   reads + validates the file and the same specs run unmodified.
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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import type { LocalD1 } from "@canlang/cloudflare";
import type { CompileArtifact } from "@canlang/contracts";
import {
  TEAMTASKS_D1_BINDING,
  TEAMTASKS_OPERATIONS,
  TEAMTASKS_SOURCE_RELATIVE,
  TEAMTASKS_SOURCE_SHA256,
  TEAMTASKS_WORKER_NAME,
  buildTeamTasksWorkerSource,
  teamTasksArtifact,
} from "./handbuilt/teamtasks.js";

export const ARTIFACT_VERSION_SUPPORTED = 1;

/**
 * workerd compatibility date for e2e instances (proven in
 * tests/integration/readiness.test.ts; newest workerd: 2026-08-06).
 * Assemblies carry it so specs never invent one.
 */
export const E2E_COMPATIBILITY_DATE = "2026-07-15";

export type ArtifactSpec =
  | { readonly kind: "handbuilt"; readonly app: "teamtasks" }
  | { readonly kind: "compiled"; readonly path: string };

export interface WorkerAssembly {
  readonly artifact: CompileArtifact;
  readonly mainModule: string;
  readonly modules: Record<string, string>;
  readonly d1Databases: readonly LocalD1[];
  readonly workerName: string;
  readonly compatibilityDate: string;
  /** `fixture/handbuilt/<app>` or `compiled/<sha256>` — asserted by specs. */
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

function readVendorTree(root: string, distSubdir: string, prefix: string, buildCommand: string): Record<string, string> {
  const base = join(root, distSubdir);
  try {
    if (!statSync(base).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`e2e loader: ${distSubdir} not built; run \`${buildCommand}\` first`);
  }
  const modules: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".js")) continue;
      const key = `${prefix}/${relative(base, full).split(sep).join("/")}`;
      modules[key] = readFileSync(full, "utf8");
    }
  };
  walk(base);
  if (Object.keys(modules).length === 0) {
    throw new Error(`e2e loader: no .js modules found under ${distSubdir}; run \`${buildCommand}\``);
  }
  return modules;
}

function assertFileBuilt(root: string, distRelative: string, buildCommand: string): void {
  try {
    if (!statSync(join(root, distRelative)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`e2e loader: ${distRelative} not built; run \`${buildCommand}\` first`);
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
  assertFileBuilt(
    root,
    "packages/interfaces/dist/interfaces/src/mcp/server.js",
    "bun run --filter @canlang/interfaces build",
  );
  assertFileBuilt(
    root,
    "packages/cloudflare/dist/runtime/mcp-registry.js",
    "bun run --filter @canlang/cloudflare build",
  );
  const entry = join(root, "tests/e2e/fixtures/handbuilt/mcp-bundle-entry.js");
  const outFile = join(tmpdir(), `can-e2e-mcp-bundle-${process.pid}.mjs`);
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
        "e2e loader: `bun` is not on PATH, needed to bundle the MCP handler chain; " +
          "install bun (https://bun.sh) or run e2e via `bun run test:e2e`",
      );
    }
    throw new Error(
      `e2e loader: MCP bundle build failed (\`bun build ${entry}\`); ` +
        `the MCP SDK must resolve (run \`bun install\`) and both producer dists must be built. ` +
        `Underlying error: ${detail}`,
    );
  }
  let contents: string;
  try {
    contents = readFileSync(outFile, "utf8");
  } finally {
    rmSync(outFile, { force: true });
  }
  for (const marker of ["createMcpHandler", "createArtifactRegistry", "createArtifactCatalog"]) {
    if (!contents.includes(marker)) {
      throw new Error(
        `e2e loader: MCP bundle build dropped ${marker}; refusing a skewed bundle ` +
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
  // The worker's registry input, stamped from the SAME entries the artifact
  // JSON carries (one source of truth: TEAMTASKS_OPERATIONS).
  modules["vendor/mcp/fixture-ops.js"] =
    `export const FIXTURE_OPERATIONS = ${JSON.stringify(TEAMTASKS_OPERATIONS)};\n`;
  // The `contracts/src` mirror (same contents, second key) satisfies the
  // repo-relative `../../contracts/src/presentation.js` specifier baked into
  // @canlang/ui dist. No specifier is rewritten: both aliases serve the
  // identical built bytes.
  for (const tree of [
    readVendorTree(root, "packages/contracts/dist", "vendor/contracts", "bun run build"),
    readVendorTree(root, "packages/contracts/dist", "contracts/src", "bun run build"),
    readVendorTree(root, "packages/ui/dist/ui/src", "vendor/ui", "bun run --filter @canlang/ui build"),
    readVendorTree(
      root,
      "packages/identity/dist/identity/src",
      "vendor/identity",
      "bun run --filter @canlang/identity build",
    ),
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
      "missing-producer: e2e compiled-artifact loading needs L1 `can compile` emission " +
        `(PR6) for ${spec.path}; contract: CompileArtifact v1 + exampleFixtures loader`,
    );
  }
  return loadHandbuiltTeamTasks(repoRoot());
}
