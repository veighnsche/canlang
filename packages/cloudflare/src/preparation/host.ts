import { LocalCommandInterrupted, type LocalCommandLifetime } from "../cli/command-lifetime.js";
/**
 * Prepared TS job orchestration (P02.2): the prepared route around the
 * current build/deploy helpers. Behavior-preserving move out of
 * `cli/platform.ts`: same helpers, same order, same envelopes/bytes.
 * Build/deploy stage order is frozen in `stage-contract.json`; the
 * bundle build uses the existing public `buildDeployBundle` boundary.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
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
import { diffPlans, formatPreview, loadPreviousPlan, requireYes, type PlanDiff } from "../deploy/review.js";
import {
  DEPLOY_DIR_SUFFIX,
  WORKER_MAIN_MISSING,
  assertPackageOutputFiles,
  deployBundleMain,
  writeDeployBundleWithAssets,
  type PackageDeployBundle,
} from "../deploy/bundle.js";
import {
  buildBundleWithHostPhasesAndAssets,
  loadModulesResumeWithFacts,
  previousPlanResumeForPath,
} from "./build-adapter.js";
import {
  PublicationError,
  withPublicationSession,
} from "./publication.js";
import {
  buildArtifactPayload,
  buildCompanionsPayload,
  buildLoadModulesPayload,
  buildLockstepPayload,
  buildPlanOptionsPayload,
} from "./inputs.js";
import {
  launchPreparation,
  NativeLaunchError,
  packagedTriple,
  resolvePreparationBinary,
  settleLaunchedChild,
  type BinaryResolution,
} from "./executable.js";
import {
  type ExecutableManifest,
  ManifestError,
  verifyExecutableManifest,
} from "./executable-manifest.js";
import { driveSession, encodeJsonFrame, FrameDecoder, isFailed, NativeSemanticError, PROTOCOL_NAME, PROTOCOL_VERSION, ProtocolError, TAG_JSON } from "./protocol.js";
import { manualApplyCommand, runWranglerDeploy, type WranglerSpawner } from "../upgrade/apply.js";
import {
  PINNED_COMPATIBILITY_DATE,
  resolveLocalDefaults,
} from "../cli/artifact-defaults.js";
import { RELEASE_VERSION, assertLockstep, readLockstepInputs } from "../release/stamp.js";

export const PLATFORM_CLI_NAME = "can-platform";
export const PLATFORM_CLI_VERSION = "0.1.1";

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
  `Usage: ${PLATFORM_CLI_NAME} <${COMMANDS.join("|")}> [--artifact <path>] [--env <name>] [--preview|--yes] [--backend ts|native] [--locale <tag>]`;

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
export async function runPreparedBuild(artifactPath: string, lifetime?: LocalCommandLifetime): Promise<void> {
  lifetime?.checkpoint("load artifact");
  let loaded: LoadedArtifact;
  try {
    loaded = loadArtifactFile(artifactPath);
  } catch {
    missingEmission("build", "package");
  }
  lifetime?.checkpoint("build release inputs");
  const repoRoot = resolve(process.env.CAN_INSTALL_ROOT ?? process.env.CAN_TOOL_ROOT ?? dirname(distRootDir()));
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
  lifetime?.checkpoint("build completed");
  const artifact = loaded.artifact;
  process.stderr.write(
    `build: ${artifact.modules.length} modules, ${artifact.callables.length} callables, ` +
      `${artifact.pages.length} pages (release ${RELEASE_VERSION})\n`,
  );
  lifetime?.checkpoint("build success");
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
  lifetime?: LocalCommandLifetime,
): Promise<void> {
  lifetime?.checkpoint("load artifact");
  let loaded: LoadedArtifact;
  try {
    loaded = loadArtifactFile(artifactPath);
  } catch {
    missingEmission("deploy", "deploy");
  }
  lifetime?.checkpoint("deploy artifact loaded");
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
  lifetime?.checkpoint("deploy configuration loaded");
  let installed;
  try {
    installed = installedFromTree({}, target);
  } catch (error) {
    fail("deploy", "invalid-deploy-bundle", error instanceof Error ? error.message : String(error));
  }
  lifetime?.checkpoint("deploy installed inputs loaded");
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
  lifetime?.checkpoint("deploy activation start");
  const verdict = await activate({
    artifact: loaded.artifact,
    descriptor,
    environment,
    installed,
  });
  lifetime?.checkpoint("deploy activation completed");
  let bundleRef: DeployBundleRef | null = null;
  let deployBundle: PackageDeployBundle | null = null;
  try {
    const bundle = buildBundleWithHostPhasesAndAssets(loaded.artifact, { verdict, ...(lifetime === undefined ? {} : { commandLifetime: lifetime }), assets: { browser: (loaded.artifact.pages?.length ?? 0) > 0 } });
    bundleRef = {
      main: deployBundleMain(stem),
      moduleCount: bundle.moduleCount,
      sha256: bundle.sha256,
    };
    deployBundle = bundle;
  } catch (error) {
    if (error instanceof LocalCommandInterrupted) throw error;
    if (error instanceof Error && (error as { code?: unknown }).code === WORKER_MAIN_MISSING) {
      process.stderr.write(
        `warning: deploy bundle unavailable (${error.message}); ` +
          `falling back to legacy main ${DEPLOY_MAIN}\n`,
      );
    } else {
      fail("deploy", "bundle-failed", error instanceof Error ? error.message : String(error));
    }
  }
  lifetime?.checkpoint("deploy bundle completed");
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
  lifetime?.checkpoint("deploy plan inputs loaded");
  const diff = diffPlans(previous, plan);
  const rendered = renderDeployPlan(plan);
  if (preview) {
    lifetime?.checkpoint("deploy preview completed");
    process.stderr.write(formatPreview(plan, diff));
    process.stderr.write(`${formatVerdictLine(verdict)}\n`);
    if (!compiler.match) {
      process.stderr.write(`warning: ${compiler.detail} (--yes will refuse)\n`);
    }
    lifetime?.checkpoint("deploy preview success");
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
  await publishDeployAndApply({
    dir,
    stem,
    planPath,
    tomlPath,
    deployBundle,
    renderedJson: rendered.json,
    renderedToml: rendered.toml,
    plan,
    diffChanged: diff.changed,
    diffLines: diff.lines,
    verdict,
    compilerMatch: compiler.match,
    compilerDetail: compiler.match ? null : compiler.detail,
    ...(lifetime === undefined ? {} : { lifetime }),
  });
}
/**
 * Confirmed-deploy publication shared by the TS and native routes
 * (P07): compiler gate, sidecar preflight, bundle + plan + TOML
 * writes, the wrangler apply attempt and the terminal envelope.
 * Byte-identical inputs produce byte-identical outputs on both
 * routes; only the plan/render source differs (TS render vs the
 * native `prepared` outputs).
 */
/**
 * Bundle + reviewed-sidecar staging for the confirmed publisher (021):
 * the reviewed plan/TOML bytes stage under a private root, verify
 * byte-for-byte, then publish in the existing order. Partial writes
 * keep the existing sequential accounting (no atomicity claimed); the
 * staging root is always removed.
 */
async function stageReviewedOutputs(args: {
  dir: string;
  stem: string;
  planPath: string;
  tomlPath: string;
  deployBundle: PackageDeployBundle | null;
  renderedJson: string;
  renderedToml: string;
  lifetime: LocalCommandLifetime | undefined;
}): Promise<{ bundleFiles: string[]; publishedSidecars: string[] }> {
  const { dir, stem, planPath, tomlPath, deployBundle, renderedJson, renderedToml, lifetime } = args;
  let bundleFiles: string[] = [];
  const publishedSidecars: string[] = [];
  try {
    if (deployBundle !== null) {
      const written = writeDeployBundleWithAssets(deployBundle, join(dir, `${stem}${DEPLOY_DIR_SUFFIX}`));
      bundleFiles = written.files;
      lifetime?.checkpoint("deploy bundle published");
    }
    const published = withPublicationSession("confirmed", (session) => {
      const staged = session.stage([
        { relativePath: basename(planPath), bytes: renderedJson },
        { relativePath: basename(tomlPath), bytes: renderedToml },
      ]);
      session.verifyReviewed(staged, [
        { relativePath: basename(planPath), bytes: renderedJson },
        { relativePath: basename(tomlPath), bytes: renderedToml },
      ]);
      return session.publish(staged, dir);
    });
    for (const relative of published.written) publishedSidecars.push(join(dir, relative));
    lifetime?.checkpoint("deploy plan published");
  } catch (error) {
    try {
      process.stderr.write("deploy publication failed; earlier outputs may remain; no apply was attempted\n");
    } catch { /* Preserve the operative write failure. */ }
    if (error instanceof PublicationError) {
      for (const relative of error.written) publishedSidecars.push(join(dir, relative));
    }
    if (error instanceof LocalCommandInterrupted) {
      error.failureContext = Object.freeze({ wrote: true, files: Object.freeze([...publishedSidecars, ...bundleFiles]),
        applied: false, applyStatus: null, applyDetail: "", manualApply: manualApplyCommand(resolve(tomlPath)),
        detail: `${error.message}; earlier outputs may remain; no apply was attempted` });
    }
    throw error;
  }
  return { bundleFiles, publishedSidecars };
}

export interface DeployPublishInputs {
  readonly dir: string;
  readonly stem: string;
  readonly planPath: string;
  readonly tomlPath: string;
  readonly deployBundle: PackageDeployBundle | null;
  readonly renderedJson: string;
  readonly renderedToml: string;
  readonly plan: unknown;
  readonly diffChanged: boolean;
  readonly diffLines: string[];
  readonly verdict: ActivationVerdict;
  readonly compilerMatch: boolean;
  readonly compilerDetail: string | null;
  readonly lifetime?: LocalCommandLifetime | undefined;
  /**
   * Test-only wrangler spawn injection (P07.2 positive path): production
   * omits it and `runWranglerDeploy` uses the real `execFileSync`.
   */
  readonly wranglerSpawn?: WranglerSpawner | undefined;
}

export async function publishDeployAndApply(inputs: DeployPublishInputs): Promise<void> {
  const { dir, stem, planPath, tomlPath, deployBundle, renderedJson, renderedToml } = inputs;
  const { plan, verdict, lifetime } = inputs;
  const diff: PlanDiff = { changed: inputs.diffChanged, lines: inputs.diffLines };
  if (!inputs.compilerMatch) {
    fail(
      "deploy",
      "compiler-mismatch",
      `${inputs.compilerDetail} (release lockstep: rebuild with the pinned toolchain)`,
    );
  }
  // Check both sidecars before any bundle or sidecar output. The same
  // canonical-root/entry policy already guards the bundle's own files.
  lifetime?.checkpoint("deploy publication preflight");
  assertPackageOutputFiles(dir, [basename(planPath), basename(tomlPath)]);
  lifetime?.checkpoint("deploy publication start");
  const { bundleFiles } = await stageReviewedOutputs({
    dir,
    stem,
    planPath,
    tomlPath,
    deployBundle,
    renderedJson,
    renderedToml,
    lifetime,
  });
  const configPath = resolve(tomlPath);
  const manual = manualApplyCommand(configPath);
  let applied = false;
  let applyAttempted = false;
  let applyStatus: number | null = null;
  let applyDetail = "";
  const recordApplyInterruption = (error: LocalCommandInterrupted): void => {
    error.failureContext = Object.freeze({ wrote: true, files: Object.freeze([planPath, tomlPath, ...bundleFiles]),
      applied: false, applyStatus, applyDetail, manualApply: manual,
      detail: `${error.message}; ${applyAttempted ? "remote outcome unconfirmed; inspect the deployment before any manual retry" : "written files remain; no apply was attempted"}` });
  };
  const checkApplyLifetime = (stage: string): void => {
    try { lifetime?.checkpoint(stage); } catch (error) {
      if (error instanceof LocalCommandInterrupted) recordApplyInterruption(error);
      throw error;
    }
  };
  try {
    checkApplyLifetime("deploy before apply");
    const timeoutMs = lifetime?.remainingMs(180_000);
    applyAttempted = true;
    const result = runWranglerDeploy({ yes: true, configPath, workingDir: dir,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(inputs.wranglerSpawn === undefined ? {} : { spawn: inputs.wranglerSpawn }) });
    applied = result.applied;
    applyStatus = result.status;
    applyDetail = tailText(applied ? result.stdout : result.stderr, 2000);
    checkApplyLifetime("deploy apply completed");
    if (applied) {
      process.stderr.write("deploy apply: wrangler deploy exited 0 (applied)\n");
    } else {
      process.stderr.write(
        `deploy apply FAILED (wrangler exited ${String(result.status)}); ` +
          `remote outcome unconfirmed; inspect the deployment before any manual retry: ${manual}\n${applyDetail}\n`,
      );
    }
  } catch (error) {
    if (error instanceof LocalCommandInterrupted) {
      recordApplyInterruption(error);
      throw error;
    }
    applyDetail = error instanceof Error ? error.message : String(error);
    checkApplyLifetime("deploy apply failed");
    process.stderr.write(`deploy apply FAILED: ${applyDetail}\n`);
  }
  process.stderr.write(
    `${formatPreview(plan as Parameters<typeof formatPreview>[0], diff)}${formatVerdictLine(verdict)}\nwrote ${planPath}\nwrote ${tomlPath}\n` +
      (bundleFiles.length > 0 ? `wrote ${bundleFiles.length} bundle file(s) under ${dir}\n` : ""),
  );
  checkApplyLifetime("deploy success");
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

// ---------------------------------------------------------------------------
// Native route (P03.4): backend selection, launch, drive, failure mapping.
// The CLI keeps the TS route until P07; these entries run the scaffold
// binary per mode for protocol/host coverage and readiness mapping.
// ---------------------------------------------------------------------------

export type BackendRequest = "ts" | "native" | "auto";

export interface BackendSelection {
  backend: "ts" | "native";
  resolution: BinaryResolution | null;
}

/**
 * Select before evaluation. `native` requires a launchable binary;
 * `auto` takes native when one resolves, else TS. No fallback runs
 * after a started native job fails — selection is the only switch.
 */
export async function selectBackend(request: BackendRequest): Promise<BackendSelection> {
  if (request === "ts") return { backend: "ts", resolution: null };
  try {
    const resolution = await resolvePreparationBinary();
    return { backend: "native", resolution };
  } catch (error) {
    if (request === "native") {
      throw new NativeLaunchError(
        "native-unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    return { backend: "ts", resolution: null };
  }
}

/**
 * Map a native failure to a CLI failure code. Transport failures
 * keep their core code under `native-`; spawn/lifecycle failures
 * name the stage. Never throws: always `fail()`s the CLI.
 */
export function failNative(command: string, code: string, detail: string): never {
  fail(command, `native-${code}`, detail);
}

export interface NativeJobResult {
  prepared: { scaffold: boolean; mode: string; stages: string[]; resumes: unknown[] };
  binaryPath: string;
  source: BinaryResolution["source"];
}

/**
 * Run one native job and return the terminal `Prepared`. The
 * executable verifier (readiness probe on a fresh process) gates
 * launch; callers serve real NeedHost stages through `onNeed` (the
 * default answers probes and refuses the rest loudly). Every
 * subprocess failure maps to a CLI failure via `failNative` —
 * tampered/garbage binaries fail loudly, never silently, with no TS
 * retry after a native refusal.
 */
/**
 * Integrity before any launch (P07/P09): every resolved binary —
 * packaged, dev or explicit-env — verifies against the manifest
 * beside it (triple, executable bit, sha/bytes, toolchain pin)
 * before the readiness probe may even start a process. The manifest
 * must name the EXACT executable to be launched (canonical-path
 * bound): a manifest validating another file while the resolved
 * path launches is refused as manifest-path. Missing manifests fail
 * closed with the stamping remedy; nothing launches unverified.
 */
export async function guardPackagedIntegrity(
  command: string,
  resolution: BinaryResolution,
): Promise<void> {
  // Same triple the resolver probed (no libc override at launch).
  const triple = packagedTriple({ platform: platform(), arch: arch() });
  const dir = dirname(resolution.path);
  let manifest: ExecutableManifest;
  try {
    manifest = await verifyExecutableManifest(dir, triple);
  } catch (error) {
    if (error instanceof ManifestError) {
      failNative(command, error.code, error.message);
    }
    failNative(
      command,
      "manifest-unreadable",
      error instanceof Error ? error.message : String(error),
    );
  }
  let staged: string;
  let resolved: string;
  try {
    staged = realpathSync(join(dir, manifest.binary));
    resolved = realpathSync(resolution.path);
  } catch (error) {
    failNative(
      command,
      "manifest-path",
      `cannot bind manifest binary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (staged !== resolved) {
    failNative(
      command,
      "manifest-path",
      `manifest names ${staged} but launch resolves ${resolved}: refusing path mismatch`,
    );
  }
  // Owning release skew (026): hash/path match alone does not admit
  // a stale-release binary. Compare the owning imported release
  // (no compiler/Cargo lookup at launch).
  if (manifest.release !== RELEASE_VERSION) {
    failNative(
      command,
      "manifest-release",
      `release skew: manifest pins ${manifest.release} (want ${RELEASE_VERSION}): rebuild the preparation binary`,
    );
  }
}

/**
 * Pre-launch verification (P05.4): resolve the binary, guard packaged
 * integrity, then the readiness probe (handshake + abort + exit 0) on
 * a fresh process. A refused binary never starts a real session.
 */
async function verifyNativeLaunch(
  command: string,
  options?: {
    timeoutMs?: number | undefined;
    packageRoot?: string | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<BinaryResolution> {
  let resolution: BinaryResolution;
  try {
    resolution = await resolvePreparationBinary(
      options?.packageRoot === undefined ? undefined : { packageRoot: options.packageRoot },
    );
  } catch (error) {
    failNative(
      command,
      "unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
  await guardPackagedIntegrity(command, resolution);
  if (
    !(await probeReadiness(resolution.path, {
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    }))
  ) {
    failNative(
      command,
      "unavailable",
      `verifier refused ${resolution.path} (${resolution.source}): readiness probe failed`,
    );
  }
  return resolution;
}

export async function runNativeJob(
  command: string,
  mode: string,
  onNeed?: (stage: string, request: unknown) => Promise<unknown> | unknown,
  options?: {
    timeoutMs?: number;
    /** Package root for binary resolution (packaging verify). */
    packageRoot?: string | undefined;
    /**
     * Real-execution `begin` members (P07). `artifact_path` presence
     * selects real stages on the native side; without it the session
     * stays on the scaffold probe path.
     */
    begin?: { artifact_path?: string; env?: string; preview?: boolean; yes?: boolean } | undefined;
    /** Command lifetime join (021): abort stops session waits. */
    signal?: AbortSignal | undefined;
  },
): Promise<NativeJobResult> {
  const resolution = await verifyNativeLaunch(command, options);
  const launched = launchPreparation(resolution.path);
  const { child } = launched;
  let stderr = "";
  child.stderr?.on("data", (chunk: Uint8Array) => {
    stderr += new TextDecoder().decode(chunk);
  });
  const exitCode = new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(null));
  });
  try {
    const prepared = await driveSession({
      child,
      mode,
      timeoutMs: options?.timeoutMs,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      ...(options?.begin === undefined ? {} : { beginExtra: options.begin }),
      onNeed: async (stage, request) => {
        if (onNeed !== undefined) return onNeed(stage, request);
        // Scaffold default: answer probes; real stages refuse loudly.
        if (stage === "mcp_bun_probe" || stage === "catalog_probe") return { probe: "answered" };
        throw new ProtocolError("unimplemented", `no native handler for stage ${stage} yet`);
      },
    });
    // Drain process lifetime; the Failed frame (when present) already
    // decided the verdict — a nonzero exit alone adds no new verdict.
    // Bounded in both outcomes (026): no unbounded close wait.
    await settleLaunchedChild(launched, exitCode);
    return { prepared, binaryPath: resolution.path, source: resolution.source };
  } catch (error) {
    // Bounded release BEFORE any failure emission/exit (026): the
    // guard/session path actually reaps the child+group instead of
    // abandoning the SIGKILL timer to process.exit. A send-kill alone
    // is not cleanup.
    await settleLaunchedChild(launched, exitCode);
    // The owning interruption survives the native job (021): after
    // killing/releasing the child, the original object propagates
    // for the outer command-timeout/command-cancelled
    // envelope/context. Existing partial-write/apply context stays intact.
    if (error instanceof LocalCommandInterrupted) throw error;
    if (error instanceof NativeSemanticError) {
      fail(command, error.code, error.message);
    }
    if (error instanceof ProtocolError) {
      failNative(command, error.code, error.message);
    }
    const tail = stderr.length > 0 ? ` (stderr: ${tailText(stderr, 500)})` : "";
    const detail = error instanceof Error ? error.message : String(error);
    failNative(command, "crash", `${detail}${tail}`);
  }
}

/** Read the native `prepared.outputs` record or fail loudly on skew. */
function nativeOutputs(command: string, prepared: unknown): Record<string, unknown> {
  const outputs: unknown = isRecord(prepared) ? prepared["outputs"] : undefined;
  if (!isRecord(outputs)) {
    failNative(command, "crash", "native prepared outputs must be a record");
  }
  return outputs;
}

function nativeString(command: string, outputs: Record<string, unknown>, key: string): string {
  if (typeof outputs[key] !== "string") {
    failNative(command, "crash", `native prepared.outputs.${key} must be a string`);
  }
  return outputs[key] as string;
}

/**
 * Native `build` driver (P07): host-side load + lockstep gates match
 * the TS route exactly, then the three build stages are served and
 * the native `prepared` outputs report through the same
 * envelope/bytes. No TS retry after a native refusal.
 */
export async function runNativeBuild(
  artifactPath: string,
  lifetime?: LocalCommandLifetime,
): Promise<void> {
  lifetime?.checkpoint("load artifact");
  let loaded: LoadedArtifact;
  try {
    loaded = loadArtifactFile(artifactPath);
  } catch {
    missingEmission("build", "package");
  }
  lifetime?.checkpoint("build release inputs");
  const repoRoot = resolve(process.env.CAN_INSTALL_ROOT ?? process.env.CAN_TOOL_ROOT ?? dirname(distRootDir()));
  let lockstepTree: Record<string, unknown>;
  try {
    const tree = readLockstepInputs(repoRoot);
    lockstepTree = {
      ...tree,
      platformVersion: PLATFORM_CLI_VERSION,
      contractsVersion: CONTRACTS_VERSION,
    };
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
  const { prepared } = await runNativeJob(
    "build",
    "build",
    (stage) => {
      if (stage === "LOAD_ARTIFACT") return buildArtifactPayload(loaded.artifact);
      if (stage === "LOCKSTEP_INPUTS") return buildLockstepPayload(lockstepTree);
      if (stage === "LOAD_MODULES") {
        return buildLoadModulesPayload(
          loaded.artifact.modules.map((module) => ({ key: module.path, js: module.js })),
        );
      }
      throw new ProtocolError("unimplemented", `no native handler for stage ${stage} yet`);
    },
    {
      begin: { artifact_path: artifactPath },
      ...(lifetime === undefined ? {} : { signal: lifetime.signal }),
    },
  );
  const outputs = nativeOutputs("build", prepared);
  const release = nativeString("build", outputs, "release");
  const modules = outputs["modules"];
  const callables = outputs["callables"];
  const pages = outputs["pages"];
  if (typeof modules !== "number" || !Array.isArray(callables) || !Array.isArray(pages)) {
    failNative("build", "crash", "native prepared.outputs carry malformed build counts");
  }
  lifetime?.checkpoint("build completed");
  const artifact = loaded.artifact;
  process.stderr.write(
    `build: ${artifact.modules.length} modules, ${artifact.callables.length} callables, ` +
      `${artifact.pages.length} pages (release ${release})\n`,
  );
  lifetime?.checkpoint("build success");
  emit({
    ok: true,
    command: "build",
    release,
    modules,
    callables,
    pages,
  });
}

/**
 * Native `deploy` driver (P07): host-side load gates match the TS
 * route exactly (load, `--env`, companions, installed). Compat,
 * confirm and compiler gates run natively in stage order; the host
 * serves real file/activation/bundle bytes on demand — installed is
 * recomputed via `installedFromTree`, the verdict is the verbatim
 * `activate()` result, and files are published from the native
 * `prepared` outputs through the shared publisher. No TS retry
 * after a native refusal; semantic Failed maps to bare codes via
 * `runNativeJob`.
 */
export async function runNativeDeploy(
  artifactPath: string,
  env: string | null,
  preview: boolean,
  yes: boolean,
  lifetime?: LocalCommandLifetime,
  options?: { wranglerSpawn?: WranglerSpawner | undefined },
): Promise<void> {
  lifetime?.checkpoint("load artifact");
  let loaded: LoadedArtifact;
  try {
    loaded = loadArtifactFile(artifactPath);
  } catch {
    missingEmission("deploy", "deploy");
  }
  lifetime?.checkpoint("deploy artifact loaded");
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
  lifetime?.checkpoint("deploy configuration loaded");
  let installed: ReturnType<typeof installedFromTree>;
  try {
    installed = installedFromTree({}, target);
  } catch (error) {
    fail("deploy", "invalid-deploy-bundle", error instanceof Error ? error.message : String(error));
  }
  lifetime?.checkpoint("deploy installed inputs loaded");
  const planPath = join(dir, `${stem}.deploy-plan.json`);
  const tomlPath = join(dir, `${stem}.wrangler.toml`);
  // Bundle bytes are staged on demand (LOAD_MODULES/PLAN): the same
  // owning build over the real activation verdict, the same
  // legacy-main fallback, kept for the confirmed publish below.
  // The verdict is memoized: ACTIVATION_REQUEST serves it verbatim
  // and the bundle build consumes the identical object.
  let verdictMemo: ActivationVerdict | null = null;
  // Owner demand order (021): local defaults reload the artifact
  // from disk, so they resolve at the activation stage — after the
  // native compat/confirm gates that precede it — never eagerly to
  // fill a DTO.
  let defaultsMemo: ReturnType<typeof resolveLocalDefaults> | null = null;
  const ensureVerdict = async (): Promise<ActivationVerdict> => {
    if (verdictMemo === null) {
      lifetime?.checkpoint("deploy activation start");
      verdictMemo = await activate({
        artifact: loaded.artifact,
        descriptor,
        environment,
        installed,
      });
      lifetime?.checkpoint("deploy activation completed");
    }
    return verdictMemo;
  };
  let staged: { bundle: PackageDeployBundle | null; ref: DeployBundleRef | null } | null = null;
  const ensureBundle = async (): Promise<{
    bundle: PackageDeployBundle | null;
    ref: DeployBundleRef | null;
  }> => {
    if (staged !== null) return staged;
    try {
      const bundle = buildBundleWithHostPhasesAndAssets(loaded.artifact, {
        verdict: await ensureVerdict(),
        ...(lifetime === undefined ? {} : { commandLifetime: lifetime }),
        assets: { browser: (loaded.artifact.pages?.length ?? 0) > 0 },
      });
      staged = {
        bundle,
        ref: { main: deployBundleMain(stem), moduleCount: bundle.moduleCount, sha256: bundle.sha256 },
      };
    } catch (error) {
      if (error instanceof LocalCommandInterrupted) throw error;
      if (error instanceof Error && (error as { code?: unknown }).code === WORKER_MAIN_MISSING) {
        process.stderr.write(
          `warning: deploy bundle unavailable (${error.message}); ` +
            `falling back to legacy main ${DEPLOY_MAIN}\n`,
        );
        staged = { bundle: null, ref: null };
      } else {
        // Inside the native session (042): never fail/exit here — the
        // child would outlive the delayed SIGKILL. Throw the owning
        // semantic error; runNativeJob settles the child first, then
        // maps the exact bare code/detail. The post-job caller below
        // maps the same error back to the identical envelope.
        throw new NativeSemanticError(
          "bundle-failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    lifetime?.checkpoint("deploy bundle completed");
    return staged;
  };
  const { prepared } = await runNativeJob(
    "deploy",
    "deploy",
    async (stage) => {
      if (stage === "LOAD_ARTIFACT") return buildArtifactPayload(loaded.artifact);
      if (stage === "LOAD_COMPANIONS") return buildCompanionsPayload(descriptor, environment, target);
      if (stage === "ACTIVATION_REQUEST") {
        if (defaultsMemo === null) defaultsMemo = resolveLocalDefaults({ artifactPath });
        return { verdict: await ensureVerdict() };
      }
      if (stage === "LOAD_MODULES") {
        // Ownership split (025/029): the ordinary TS builders keep
        // their checks (both backends assemble through them), and the
        // native job applies the same single-frontend verdicts to the
        // exact bytes it consumes (wire guard against tamper/skew).
        // Refusal order is unchanged from the pre-facts flow:
        // builder asserts inside ensureBundle, then the native job's
        // frontend-error/lexer/syntax, loadability groups, and links
        // (base before mixed). Serving pre-gate bytes would split the
        // builder and reorder stage-contract effects, so it is not done.
        const { bundle } = await ensureBundle();
        return loadModulesResumeWithFacts(
          bundle === null ? {} : bundle.modules,
          bundle === null ? [] : Object.keys(bundle.binaries),
        );
      }
      if (stage === "PLAN") {
        const { ref } = await ensureBundle();
        if (defaultsMemo === null) defaultsMemo = resolveLocalDefaults({ artifactPath });
        return buildPlanOptionsPayload({
          workerName: defaultsMemo.workerName,
          main: DEPLOY_MAIN,
          compatibilityDate: PINNED_COMPATIBILITY_DATE,
          ...(ref === null ? {} : { bundle: ref }),
        });
      }
      if (stage === "LOAD_PREVIOUS_PLAN") {
        // The checkpoint sits outside the read catch (040): a
        // cancellation keeps the original interruption instead of
        // becoming invalid-deploy-bundle. Read failures throw the
        // owning semantic error (042) so runNativeJob settles the
        // child before the identical envelope.
        let resume: ReturnType<typeof previousPlanResumeForPath>;
        try {
          resume = previousPlanResumeForPath(planPath);
        } catch (error) {
          throw new NativeSemanticError(
            "invalid-deploy-bundle",
            error instanceof Error ? error.message : String(error),
          );
        }
        lifetime?.checkpoint("deploy plan inputs loaded");
        return resume;
      }
      throw new ProtocolError("unimplemented", `no native handler for stage ${stage} yet`);
    },
    {
      begin: { artifact_path: artifactPath, env, preview, yes },
      ...(lifetime === undefined ? {} : { signal: lifetime.signal }),
    },
  );
  await finishNativeDeploy(prepared, {
    dir,
    stem,
    planPath,
    tomlPath,
    preview,
    lifetime,
    wranglerSpawn: options?.wranglerSpawn,
    ensureBundle,
  });
}

/**
 * Complete the native deploy from `prepared` outputs: validate the
 * review record, preview-emit or publish through the shared
 * publisher. Same checkpoints/envelope as the TS route.
 */
async function finishNativeDeploy(
  prepared: unknown,
  args: {
    dir: string;
    stem: string;
    planPath: string;
    tomlPath: string;
    preview: boolean;
    lifetime: LocalCommandLifetime | undefined;
    wranglerSpawn: WranglerSpawner | undefined;
    ensureBundle: () => Promise<{ bundle: PackageDeployBundle | null; ref: DeployBundleRef | null }>;
  },
): Promise<void> {
  const { dir, stem, planPath, tomlPath, preview, lifetime, wranglerSpawn, ensureBundle } = args;
  const outputs = nativeOutputs("deploy", prepared);
  const planJson = nativeString("deploy", outputs, "planJson");
  const renderedToml = nativeString("deploy", outputs, "wranglerToml");
  const previewText = nativeString("deploy", outputs, "previewText");
  const planDiff = outputs["planDiff"];
  const verdict = outputs["verdict"];
  const compilerMatch = outputs["compilerMatch"];
  const compilerDetail = outputs["compilerDetail"];
  if (
    !Array.isArray(planDiff) ||
    !isRecord(verdict) ||
    typeof verdict["active"] !== "boolean" ||
    typeof compilerMatch !== "boolean" ||
    !(typeof compilerDetail === "string" || compilerDetail === null)
  ) {
    failNative("deploy", "crash", "native prepared.outputs carry malformed review outputs");
  }
  let plan: unknown;
  try {
    plan = JSON.parse(planJson) as unknown;
  } catch {
    failNative("deploy", "crash", "native planJson is not JSON");
  }
  if (preview) {
    lifetime?.checkpoint("deploy preview completed");
    process.stderr.write(previewText);
    process.stderr.write(`${formatVerdictLine(verdict as ActivationVerdict)}\n`);
    if (!compilerMatch) {
      process.stderr.write(`warning: ${compilerDetail} (--yes will refuse)\n`);
    }
    lifetime?.checkpoint("deploy preview success");
    emit({
      ok: true,
      command: "deploy",
      preview: true,
      wrote: false,
      changed: outputs["planChanged"] === true,
      diff: planDiff,
      plan,
      verdict,
      compilerMatch,
      compilerDetail: compilerMatch ? null : compilerDetail,
    });
    return;
  }
  // Post-session caller (042): no child to settle here, so map the
  // same semantic error back to the identical direct envelope.
  // Interruptions still propagate untouched.
  const { bundle } = await ensureBundle().catch((error: unknown) => {
    if (error instanceof NativeSemanticError) fail("deploy", error.code, error.message);
    throw error;
  });
  await publishDeployAndApply({
    dir,
    stem,
    planPath,
    tomlPath,
    deployBundle: bundle,
    renderedJson: planJson,
    renderedToml,
    plan,
    diffChanged: outputs["planChanged"] === true,
    diffLines: planDiff as string[],
    verdict: verdict as ActivationVerdict,
    compilerMatch,
    compilerDetail: compilerMatch ? null : (compilerDetail as string | null),
    ...(lifetime === undefined ? {} : { lifetime }),
    ...(wranglerSpawn === undefined ? {} : { wranglerSpawn }),
  });
}

/**
 * Readiness probe: handshake + abort against a fresh process.
 * Returns true only on the exact `aborted` + exit-0 sequence.
 * Used by packaging verify (P09.1) and the protocol tests — not
 * per-job (selection resolves; the job handshake is the check).
 */
export async function probeReadiness(
  binaryPath: string,
  options?: { timeoutMs?: number; signal?: AbortSignal | undefined },
): Promise<boolean> {
  // One bounded existing deadline across handshake/abort/exit
  // (026/033): a manifest-valid probe that answers then stays alive
  // never holds the CLI past the bound, and cancellation propagates
  // the owning signal reason after release — never a downgrade to
  // unavailable. Strict accept/aborted validation keeps the
  // original P09 protocol-skew refusal.
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const signal = options?.signal;
  // Never launch when already cancelled (033).
  if (signal?.aborted === true) throw signal.reason;
  const started = Date.now();
  const launched = launchPreparation(binaryPath);
  const { child, kill } = launched;
  // Exit observation registers at launch, before any response wait
  // (033): a fast close is never missed.
  const closed = new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(null));
  });
  const abortCleanup: { remove: (() => void) | null } = { remove: null };
  const aborted: Promise<never> | null =
    signal === undefined
      ? null
      : new Promise<never>((_, reject) => {
          const fire = (): void => {
            kill();
            reject(signal.reason);
          };
          signal.addEventListener("abort", fire, { once: true });
          abortCleanup.remove = () => signal.removeEventListener("abort", fire);
        });
  const release = async (): Promise<void> => {
    abortCleanup.remove?.();
    abortCleanup.remove = null;
    // Bounded cleanup on EVERY launched outcome (033): terminate,
    // reap the child+group, then let the caller fail/throw. A
    // send-kill alone is not cleanup, and failNative's process.exit
    // must never bypass the delayed SIGKILL.
    await settleLaunchedChild(launched, closed, timeoutMs);
  };
  try {
    if (child.stdin === null || child.stdout === null) {
      await release();
      return false;
    }
    const stdin = child.stdin;
    const stdout = child.stdout;
    // Write guard (052): a dead child (wrong-arch ELF reports EPIPE)
    // must refuse as unavailable, never throw or crash the CLI. The
    // launch-owned stdin error listener swallows the async event;
    // this guard maps sync throws and dead streams to refusal.
    let stdinPipeFailed = false;
    stdin.on("error", () => {
      stdinPipeFailed = true;
    });
    const safeWrite = (frame: Uint8Array): boolean => {
      if (stdinPipeFailed || stdin.destroyed) return false;
      try {
        stdin.write(frame);
        return true;
      } catch {
        return false;
      }
    };
    const decoder = new FrameDecoder();
    // Strict accept/aborted validation (035.2): the comments claim P09
    // protocol-skew refusal, so a wrong-version/non-ready first frame
    // or a detail-bearing-but-wrong-code second frame refuses — never
    // a substring pass. Trailing/extra frames refuse as well.
    const isExactAccept = (frame: { tag: number; payload: Uint8Array }): boolean => {
      if (frame.tag !== TAG_JSON) return false;
      let accept: unknown;
      try {
        accept = JSON.parse(new TextDecoder().decode(frame.payload)) as unknown;
      } catch {
        return false;
      }
      if (typeof accept !== "object" || accept === null) return false;
      const { ready, protocol, version } = accept as { ready?: unknown; protocol?: unknown; version?: unknown };
      return ready === true && protocol === PROTOCOL_NAME && version === PROTOCOL_VERSION;
    };
    const isExactAborted = (frame: { tag: number; payload: Uint8Array }): boolean => {
      if (frame.tag !== TAG_JSON || decoder.trailing().length > 0) return false;
      let message: unknown;
      try {
        message = JSON.parse(new TextDecoder().decode(frame.payload)) as unknown;
      } catch {
        return false;
      }
      return isFailed(message) && message.error.code === "aborted";
    };
    let frameTimer: NodeJS.Timeout | null = null;
    const cancelFrameWait = (): void => {
      if (frameTimer !== null) {
        clearTimeout(frameTimer);
        frameTimer = null;
      }
      stdout.removeListener("data", onFrameData);
      stdout.removeListener("end", onStreamEnd);
      child.removeListener("close", onStreamEnd);
      child.removeListener("error", onFrameError);
    };
    let frameCount = 0;
    // A valid Aborted answer does NOT finish yet (040): any extra or
    // trailing frame — in the same batch or a later chunk, through EOF
    // and child close — refuses. Observation stays inside the single
    // existing deadline.
    let abortedAccepted = false;
    const onFrameDataRef: { finish: ((ok: boolean) => void) | null } = { finish: null };
    const done = new Promise<boolean>((resolve) => {
      const finish = (ok: boolean): void => {
        cancelFrameWait();
        resolve(ok);
      };
      onFrameDataRef.finish = finish;
    });
    function onFrameData(chunk: Uint8Array): void {
      const finish = onFrameDataRef.finish;
      if (finish === null) return;
      let fresh: Array<{ tag: number; payload: Uint8Array }>;
      try {
        fresh = decoder.push(chunk);
      } catch {
        finish(false);
        return;
      }
      for (const frame of fresh) {
        frameCount += 1;
        if (frameCount === 1) {
          if (!isExactAccept(frame)) {
            finish(false);
            return;
          }
          // Accept received; abort before Begin.
          if (!safeWrite(encodeJsonFrame({ abort: {} }))) {
            finish(false);
            return;
          }
        } else if (frameCount === 2) {
          if (!isExactAborted(frame)) {
            finish(false);
            return;
          }
          abortedAccepted = true;
        } else {
          finish(false);
          return;
        }
      }
    }
    function onStreamEnd(): void {
      const finish = onFrameDataRef.finish;
      if (finish === null) return;
      // EOF/close with no extra bytes after a valid Aborted: ready.
      // Anything trailing or any later frame already refused above.
      finish(abortedAccepted && decoder.trailing().length === 0);
    }
    function onFrameError(): void {
      onFrameDataRef.finish?.(false);
    }
    frameTimer = setTimeout(() => onFrameDataRef.finish?.(false), timeoutMs);
    stdout.on("data", onFrameData);
    stdout.on("end", onStreamEnd);
    child.on("close", onStreamEnd);
    child.on("error", onFrameError);
    if (!safeWrite(encodeJsonFrame({ protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION }))) {
      await release();
      return false;
    }
    let ok: boolean;
    try {
      ok = aborted === null ? await done : await Promise.race([done, aborted]);
    } catch (error) {
      // Cancellation: cancel the frame wait, release, then propagate
      // the owning reason.
      cancelFrameWait();
      await release();
      throw error;
    }
    if (!ok) {
      await release();
      return false;
    }
    // The single deadline covers the exit too: only the remainder
    // may elapse (never a second full timeout). The exit wait joins
    // the same abort (035.2): cancellation during the exit wait keeps
    // the owning reason, and its timer is cleared on every outcome —
    // a fast close never retains a live timer until the deadline.
    const remaining = timeoutMs - (Date.now() - started);
    let exitTimer: NodeJS.Timeout | null = null;
    let code: number | null;
    try {
      code =
        remaining <= 0
          ? null
          : await Promise.race([
              closed,
              new Promise<null>((resolve) => {
                exitTimer = setTimeout(() => resolve(null), remaining);
              }),
              ...(aborted === null ? [] : [aborted]),
            ]);
    } catch (error) {
      if (exitTimer !== null) clearTimeout(exitTimer);
      await release();
      throw error;
    }
    if (exitTimer !== null) clearTimeout(exitTimer);
    await release();
    if (code === null) return false;
    return code === 0;
  } finally {
    abortCleanup.remove?.();
    abortCleanup.remove = null;
    kill();
  }
}
