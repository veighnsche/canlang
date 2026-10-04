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
 * `artifact_version` 1, unknown callable kinds or malformed `requires`
 * entries are precise errors, never silent support.
 *
 * Producer dist bundling: the worker runs REAL producer code — @canlang/ui
 * rendering, @canlang/identity auth/session logic, and @canlang/contracts
 * constants — loaded from their built dists into the miniflare module map
 * under `vendor/`. A missing dist fails loud naming the exact build
 * command; the loader never stubs a producer.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import type { LocalD1 } from "@canlang/cloudflare";
import type { CompileArtifact } from "@canlang/contracts";
import {
  TEAMTASKS_D1_BINDING,
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
  for (const callable of artifact.callables) {
    if (!CALLABLE_KINDS.has(callable.kind)) {
      throw new Error(`e2e loader: unknown callable kind ${JSON.stringify(callable.kind)}`);
    }
  }
  for (const requirement of artifact.requires) {
    if (typeof requirement.capability !== "string" || requirement.capability.length === 0) {
      throw new Error("e2e loader: requires entry with empty capability");
    }
    if (!Number.isInteger(requirement.min_version) || requirement.min_version < 1) {
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

function loadHandbuiltTeamTasks(root: string): WorkerAssembly {
  assertSourceWitness(root, TEAMTASKS_SOURCE_RELATIVE, TEAMTASKS_SOURCE_SHA256);
  const artifact = teamTasksArtifact();
  assertSupportedArtifact(artifact);
  const modules: Record<string, string> = { "worker.mjs": buildTeamTasksWorkerSource() };
  // The `contracts/src` mirror (same contents, second key) satisfies the
  // repo-relative `../../contracts/src/presentation.js` specifier baked into
  // @canlang/ui dist. No specifier is rewritten: both aliases serve the
  // identical built bytes.
  for (const tree of [
    readVendorTree(root, "packages/contracts/dist", "vendor/contracts", "npm run build"),
    readVendorTree(root, "packages/contracts/dist", "contracts/src", "npm run build"),
    readVendorTree(root, "packages/ui/dist/ui/src", "vendor/ui", "npm run build -w @canlang/ui"),
    readVendorTree(
      root,
      "packages/identity/dist/identity/src",
      "vendor/identity",
      "npm run build -w @canlang/identity",
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
