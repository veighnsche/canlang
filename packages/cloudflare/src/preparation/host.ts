/**
 * Prepared TS job orchestration (P02.2): the prepared route around the
 * current build/deploy helpers. Behavior-preserving move out of
 * `cli/platform.ts`: same helpers, same order, same envelopes/bytes.
 * Build/deploy stage order is frozen in `stage-contract.json`; the
 * bundle build itself routes through `./build-adapter.js`, which
 * delegates to the existing public `buildDeployBundle` boundary until
 * P05.2 splits the real MCP/catalog host phases.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACTS_VERSION } from "@canlang/contracts";
import type {
  ActivationVerdict,
  CompatibilityDescriptor,
  EnvironmentSelection,
} from "@canlang/contracts";
import { loadArtifactFile, type LoadedArtifact } from "../runtime/artifact.js";
import { activate } from "../deploy/activate.js";
import {
  checkCompatibility,
  checkCompilerVersionMatch,
  installedFromTree,
} from "../deploy/compat.js";
import { buildDeployPlan, type DeployBundleRef } from "../deploy/plan.js";
import { renderDeployPlan } from "../deploy/render.js";
import { diffPlans, formatPreview, loadPreviousPlan, requireYes } from "../deploy/review.js";
import {
  DEPLOY_DIR_SUFFIX,
  WORKER_MAIN_MISSING,
  deployBundleMain,
  writeDeployBundle,
  type DeployBundle,
} from "../deploy/bundle.js";
import { buildBundleWithHostPhases } from "./build-adapter.js";
import { manualApplyCommand, runWranglerDeploy } from "../upgrade/apply.js";
import {
  PINNED_COMPATIBILITY_DATE,
  resolveLocalDefaults,
} from "../dev/zero-config.js";
import { RELEASE_VERSION, assertLockstep, readLockstepInputs } from "../release/stamp.js";

export const PLATFORM_CLI_NAME = "can-platform";
export const PLATFORM_CLI_VERSION = "0.1.0";

export const COMMANDS = ["run", "test", "build", "deploy", "activate", "docs"] as const;
export type PlatformCommand = (typeof COMMANDS)[number];

export interface FailureEnvelope {
  ok: false;
  command: string | null;
  code: string;
  producer?: string;
  contract?: string;
  detail: string;
}

export function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function fail(
  command: string | null,
  code: string,
  detail: string,
  extra?: { producer?: string; contract?: string },
): never {
  const envelope: FailureEnvelope = { ok: false, command, code, detail };
  if (extra?.producer !== undefined) envelope.producer = extra.producer;
  if (extra?.contract !== undefined) envelope.contract = extra.contract;
  emit(envelope);
  process.exit(2);
}

export const USAGE_TEXT =
  `Usage: ${PLATFORM_CLI_NAME} <${COMMANDS.join("|")}> [--artifact <path>] [--env <name>] [--preview|--yes] [--locale <tag>]`;

export function usage(detail: string): never {
  process.stderr.write(`${USAGE_TEXT}\n`);
  fail(null, "usage", detail);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function bundleStem(artifactPath: string): { dir: string; stem: string } {
  const dir = dirname(artifactPath);
  const base = basename(artifactPath);
  const stem = base.endsWith(".artifact.json")
    ? base.slice(0, -".artifact.json".length)
    : base.replace(/\.json$/, "");
  return { dir, stem };
}

export function loadBundleJson(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    fail(
      "activate",
      "invalid-activation-bundle",
      `${what} not readable: ${path} (bundle convention: <stem>.{descriptor,<env>.environment,target}[,store].json next to --artifact)`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail(
      "activate",
      "invalid-activation-bundle",
      `${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function needRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what} must be a JSON object`);
  return value;
}

export function needString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${what} must be a non-empty string`);
  return value;
}

export function needStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${what} must be an array of strings`);
  }
  return [...value];
}

export function loadDescriptor(path: string): CompatibilityDescriptor {
  const root = needRecord(loadBundleJson(path, "descriptor"), "descriptor");
  const identity = needRecord(root["identity"], "descriptor.identity");
  for (const field of ["appName", "sourceRevision", "languageVersion", "compilerVersion"] as const) {
    needString(identity[field], `descriptor.identity.${field}`);
  }
  if (typeof identity["contractsVersion"] !== "number") {
    throw new Error("descriptor.identity.contractsVersion must be a number");
  }
  needString(identity["artifactDigest"], "descriptor.identity.artifactDigest");
  if (!Array.isArray(root["requiredCapabilities"])) {
    throw new Error("descriptor.requiredCapabilities must be an array");
  }
  if (!Array.isArray(root["resourceBindings"])) throw new Error("descriptor.resourceBindings must be an array");
  for (const [index, requirement] of (root["resourceBindings"] as unknown[]).entries()) {
    const entry = needRecord(requirement, `descriptor.resourceBindings[${index}]`);
    for (const field of ["binding", "kind", "logicalName"] as const) {
      needString(entry[field], `descriptor.resourceBindings[${index}].${field}`);
    }
  }
  if (!Array.isArray(root["secrets"])) throw new Error("descriptor.secrets must be an array");
  for (const [index, secret] of (root["secrets"] as unknown[]).entries()) {
    const entry = needRecord(secret, `descriptor.secrets[${index}]`);
    needString(entry["binding"], `descriptor.secrets[${index}].binding`);
    if (typeof entry["optional"] !== "boolean") {
      throw new Error(`descriptor.secrets[${index}].optional must be a boolean`);
    }
  }
  if (!Array.isArray(root["schedules"])) throw new Error("descriptor.schedules must be an array");
  for (const [index, schedule] of (root["schedules"] as unknown[]).entries()) {
    const entry = needRecord(schedule, `descriptor.schedules[${index}]`);
    needString(entry["handler"], `descriptor.schedules[${index}].handler`);
    needString(entry["everyMilliseconds"], `descriptor.schedules[${index}].everyMilliseconds`);
  }
  return root as unknown as CompatibilityDescriptor;
}

export function loadEnvironment(path: string, env: string): EnvironmentSelection {
  const root = needRecord(loadBundleJson(path, "environment"), "environment");
  const name = needString(root["environment"], "environment.environment");
  if (name !== env) {
    throw new Error(`environment file selects ${JSON.stringify(name)} but --env is ${JSON.stringify(env)}`);
  }
  if (!Array.isArray(root["resources"])) throw new Error("environment.resources must be an array");
  for (const [index, resource] of (root["resources"] as unknown[]).entries()) {
    const entry = needRecord(resource, `environment.resources[${index}]`);
    const requirement = needRecord(entry["requirement"], `environment.resources[${index}].requirement`);
    for (const field of ["binding", "kind", "logicalName"] as const) {
      needString(requirement[field], `environment.resources[${index}].requirement.${field}`);
    }
    needString(entry["resourceId"], `environment.resources[${index}].resourceId`);
  }
  needStringArray(root["secretsPresent"], "environment.secretsPresent");
  const vars = needRecord(root["vars"], "environment.vars");
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value !== "string") throw new Error(`environment.vars[${JSON.stringify(key)}] must be a string`);
  }
  return root as unknown as EnvironmentSelection;
}

export function loadTarget(path: string): {
  contractsVersion: number;
  runtimeVersion: string;
  knownLanguageVersions: readonly string[];
  capabilities: readonly string[];
  supportsSchedules: boolean;
} {
  const root = needRecord(loadBundleJson(path, "target"), "target");
  if (typeof root["contractsVersion"] !== "number") {
    throw new Error("target.contractsVersion must be a number (the deployment's supported contracts version)");
  }
  if (typeof root["supportsSchedules"] !== "boolean") {
    throw new Error("target.supportsSchedules must be a boolean");
  }
  return {
    contractsVersion: root["contractsVersion"],
    runtimeVersion: needString(root["runtimeVersion"], "target.runtimeVersion"),
    knownLanguageVersions: needStringArray(root["knownLanguageVersions"], "target.knownLanguageVersions"),
    capabilities: needStringArray(root["capabilities"], "target.capabilities"),
    supportsSchedules: root["supportsSchedules"],
  };
}

/**
 * Legacy entry script path (pre-bundle fallback while the P-A serving entry
 * is unbuilt; P-B plans stamp the bundle main instead — see `plan.ts`).
 */
export const DEPLOY_MAIN = "./dist/worker/entry.js";

export function distRootDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function missingEmission(command: PlatformCommand, verb: "execute" | "package" | "deploy"): never {
  const contract =
    verb === "execute"
      ? "can compile emission + ArtifactTestModule loader (§13 exampleFixtures)"
      : "can compile emission (CompileArtifact)";
  fail(command, "missing-producer", `no L1 CompileArtifact emission to ${verb} yet`, {
    producer: "lane-01",
    contract,
  });
}

/** `build`: validate the artifact + assert release lockstep over the tree. */
export async function runPreparedBuild(artifactPath: string): Promise<void> {
  let loaded: LoadedArtifact;
  try {
    loaded = loadArtifactFile(artifactPath);
  } catch {
    missingEmission("build", "package");
  }
  const repoRoot = dirname(distRootDir());
  try {
    const tree = readLockstepInputs(repoRoot);
    assertLockstep({
      rootVersion: tree.rootVersion,
      platformVersion: PLATFORM_CLI_VERSION,
      compilerVersion: tree.compilerVersion,
      contractsVersion: CONTRACTS_VERSION,
      packageVersions: tree.packageVersions,
    });
  } catch (error) {
    fail("build", "release-drift", error instanceof Error ? error.message : String(error));
  }
  const artifact = loaded.artifact;
  process.stderr.write(
    `build: ${artifact.modules.length} modules, ${artifact.callables.length} callables, ` +
      `${artifact.pages.length} pages (release ${RELEASE_VERSION})\n`,
  );
  emit({
    ok: true,
    command: "build",
    release: RELEASE_VERSION,
    modules: artifact.modules.length,
    callables: artifact.callables.map((callable) => callable.id),
    pages: artifact.pages.map((page) => page.path),
  });
}

/**
 * `deploy`: compat gate first (fail closed), then the portable worker
 * bundle (P-B), then render + review. Bare deploy and `--preview` write
 * nothing; `--yes` writes the bundle dir + plan files and then attempts
 * the live wrangler apply, reporting `applied` honestly (failed applies
 * name the by-hand equivalent — the written files ARE the manual path).
 * A compiler/runtime release mismatch refuses `--yes`. No path spawns
 * wrangler without `--yes`.
 */
export async function runPreparedDeploy(
  artifactPath: string,
  env: string | null,
  preview: boolean,
  yes: boolean,
): Promise<void> {
  let loaded: LoadedArtifact;
  try {
    loaded = loadArtifactFile(artifactPath);
  } catch {
    missingEmission("deploy", "deploy");
  }
  if (env === null) {
    usage("deploy requires --env <name>");
  }
  const { dir, stem } = bundleStem(artifactPath);
  let descriptor: CompatibilityDescriptor;
  let environment: EnvironmentSelection;
  let target: ReturnType<typeof loadTarget>;
  try {
    descriptor = loadDescriptor(join(dir, `${stem}.descriptor.json`));
    environment = loadEnvironment(join(dir, `${stem}.${env}.environment.json`), env);
    target = loadTarget(join(dir, `${stem}.target.json`));
  } catch (error) {
    fail("deploy", "invalid-deploy-bundle", error instanceof Error ? error.message : String(error));
  }
  let installed;
  try {
    installed = installedFromTree({}, target);
  } catch (error) {
    fail("deploy", "invalid-deploy-bundle", error instanceof Error ? error.message : String(error));
  }
  const compat = checkCompatibility(descriptor, environment, installed);
  if (!compat.compatible) {
    fail(
      "deploy",
      "incompatible",
      compat.reasons.map((reason) => `${reason.code}: ${reason.detail}`).join("; "),
    );
  }
  // Bare deploy refuses before any bundling work (same outcome as before,
  // without the wasted build); --preview and --yes proceed.
  if (!preview) {
    try {
      requireYes(yes, "deploy");
    } catch (error) {
      fail("deploy", "confirm-required", error instanceof Error ? error.message : String(error));
    }
  }
  const compiler = checkCompilerVersionMatch(descriptor, installed);
  const defaults = resolveLocalDefaults({ artifactPath });
  // P-B bundle: built in memory here (preview validates + reports the real
  // sha without writing; --yes writes below). The staged verdict is the
  // honest `activate()` verdict over deploy-time inputs: gates 1-2 run
  // for real, gates 3-4 report `activation-incomplete` (no store or
  // producer gates are importable from the dist CLI — the same honest
  // scope the `activate` command documents). An inactive verdict deploys
  // the refusal worker through the same main (by design, never a silent
  // serve), and preview/--yes report it loudly so the deployer sees it.
  // Until the P-A serving entry is built, fall back to the legacy main
  // with a loud warning.
  const repoRoot = dirname(distRootDir());
  const verdict = await activate({
    artifact: loaded.artifact,
    descriptor,
    environment,
    installed,
  });
  let bundleRef: DeployBundleRef | null = null;
  let deployBundle: DeployBundle | null = null;
  try {
    const bundle = buildBundleWithHostPhases(loaded.artifact, { repoRoot, verdict });
    bundleRef = {
      main: deployBundleMain(stem),
      moduleCount: bundle.moduleCount,
      sha256: bundle.sha256,
    };
    deployBundle = bundle;
  } catch (error) {
    if (error instanceof Error && (error as { code?: unknown }).code === WORKER_MAIN_MISSING) {
      process.stderr.write(
        `warning: deploy bundle unavailable (${error.message}); ` +
          `falling back to legacy main ${DEPLOY_MAIN}\n`,
      );
    } else {
      fail("deploy", "bundle-failed", error instanceof Error ? error.message : String(error));
    }
  }
  let plan;
  try {
    plan = buildDeployPlan(descriptor, environment, {
      workerName: defaults.workerName,
      main: DEPLOY_MAIN,
      compatibilityDate: PINNED_COMPATIBILITY_DATE,
      ...(bundleRef === null ? {} : { bundle: bundleRef }),
    });
  } catch (error) {
    fail("deploy", "unresolved-binding", error instanceof Error ? error.message : String(error));
  }
  const planPath = join(dir, `${stem}.deploy-plan.json`);
  const tomlPath = join(dir, `${stem}.wrangler.toml`);
  let previous;
  try {
    previous = loadPreviousPlan(planPath);
  } catch (error) {
    fail("deploy", "invalid-deploy-bundle", error instanceof Error ? error.message : String(error));
  }
  const diff = diffPlans(previous, plan);
  const rendered = renderDeployPlan(plan);
  if (preview) {
    process.stderr.write(formatPreview(plan, diff));
    process.stderr.write(`${formatVerdictLine(verdict)}\n`);
    if (!compiler.match) {
      process.stderr.write(`warning: ${compiler.detail} (--yes will refuse)\n`);
    }
    emit({
      ok: true,
      command: "deploy",
      preview: true,
      wrote: false,
      changed: diff.changed,
      diff: diff.lines,
      plan,
      verdict,
      compilerMatch: compiler.match,
      compilerDetail: compiler.match ? null : compiler.detail,
    });
    return;
  }
  if (!compiler.match) {
    fail(
      "deploy",
      "compiler-mismatch",
      `${compiler.detail} (release lockstep: rebuild with the pinned toolchain)`,
    );
  }
  let bundleFiles: string[] = [];
  if (deployBundle !== null) {
    const written = writeDeployBundle(deployBundle, join(dir, `${stem}${DEPLOY_DIR_SUFFIX}`));
    bundleFiles = written.files;
  }
  writeFileSync(planPath, rendered.json, "utf8");
  writeFileSync(tomlPath, rendered.toml, "utf8");
  const configPath = resolve(tomlPath);
  const manual = manualApplyCommand(configPath);
  let applied = false;
  let applyStatus: number | null = null;
  let applyDetail = "";
  try {
    const result = runWranglerDeploy({ yes: true, configPath, workingDir: dir });
    applied = result.applied;
    applyStatus = result.status;
    applyDetail = tailText(applied ? result.stdout : result.stderr, 2000);
    if (applied) {
      process.stderr.write("deploy apply: wrangler deploy exited 0 (applied)\n");
    } else {
      process.stderr.write(
        `deploy apply FAILED (wrangler exited ${String(result.status)}); ` +
          `nothing was applied — apply by hand: ${manual}\n${applyDetail}\n`,
      );
    }
  } catch (error) {
    applyDetail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`deploy apply FAILED: ${applyDetail}\n`);
  }
  process.stderr.write(
    `${formatPreview(plan, diff)}${formatVerdictLine(verdict)}\nwrote ${planPath}\nwrote ${tomlPath}\n` +
      (bundleFiles.length > 0 ? `wrote ${bundleFiles.length} bundle file(s) under ${dir}\n` : ""),
  );
  emit({
    ok: true,
    command: "deploy",
    preview: false,
    wrote: true,
    changed: diff.changed,
    diff: diff.lines,
    files: [planPath, tomlPath, ...bundleFiles],
    plan,
    verdict,
    applied,
    applyStatus,
    applyDetail,
    manualApply: manual,
  });
}

/** One loud verdict line: the deployer always sees what the worker will serve. */
export function formatVerdictLine(verdict: ActivationVerdict): string {
  if (verdict.active) return "verdict: active (worker will serve)";
  const codes = verdict.reasons.map((reason) => reason.code).join(", ");
  return (
    `verdict: INACTIVE — the deployed worker will serve the refusal worker ` +
    `until activation passes (${verdict.reasons.length} reason(s): ${codes})`
  );
}

/** Last `max` chars of `text` (wrangler output tail for the envelope). */
export function tailText(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}
