#!/usr/bin/env node
/**
 * `can-platform`: lane-07 delegation target for L1's thin
 * `can run|test|build|deploy` entries (IR-03).
 *
 * Stable contract: exactly one JSON envelope on stdout, exit code signals
 * the outcome. Human-readable text goes to stderr only.
 *
 * Success:  `{ "ok": true, "command": ..., ... }`, exit 0.
 * Failure:  `{ "ok": false, "command": ..., "code": ..., "detail": ... }`,
 *           exit 2 for usage/contract errors, exit 1 for unexpected errors.
 *
 * Missing-producer failures use `code: "missing-producer"` and name the
 * exact unmet contract — never a second engine, never a silent pass.
 *
 * `docs` (D05b) is the `can docs` renderer bridge: it reads the frozen
 * reference model v1 as JSON on stdin and writes localized Markdown to
 * stdout (exit 0). Success stdout is raw Markdown by design, not an
 * envelope; failures keep the envelope on stdout (exit 2) plus a human
 * line on stderr. `missing-renderer` names the exact unmet renderer
 * contract — never a second engine, never a silent pass.
 *
 * `activate` (B3-I6) runs the activation serve-gate over an activation
 * bundle and reports the typed verdict. Bundle convention, resolved
 * next to `--artifact` (`<stem>` is the artifact basename minus
 * `.artifact.json`, else minus `.json`):
 *   `<stem>.descriptor.json` — CompatibilityDescriptor (required)
 *   `<stem>.<env>.environment.json` — EnvironmentSelection for `--env` (required)
 *   `<stem>.target.json` — InstalledRuntime declaration incl. contractsVersion (required)
 *   `<stem>.store.json` — { installedSnapshot, outbox } (optional; absent
 *     means the digest gate reports `activation-incomplete`)
 * Success envelope: `{ ok: true, command: "activate", active, reasons? }`,
 * exit 0 WHETHER OR NOT the verdict is active — a negative verdict is a
 * successful check with a fail-closed outcome, and callers (`can
 * activate`) map `active: false` to their own nonzero exit.
 *
 * Honest scope: the CLI runs gates 1-3 (compat, requires bridge,
 * installed digest) from bundle data. Gate 4 (outstanding-work
 * inventory) needs the `@canlang/state` + `@canlang/work` producer
 * runtimes, which are not importable from the plain-node dist CLI — so
 * the CLI passes no inventory/gates and the verdict carries
 * `activation-incomplete` for gate 4. The full four-gate pass (real
 * producer functions) is proven in `test/activate.test.ts`.
 *
 * B5-J3: `--artifact` is optional everywhere — absent means zero-config
 * discovery (`./dist/*.artifact.json`, exactly one or loud). `test`
 * boots the local harness via `@canlang/testkit` (dynamic import: the
 * testkit depends on this package, so no static edge) and reports zero
 * executed rows until the lane-01 test-module loader lands. `build`
 * validates the artifact + asserts release lockstep. `deploy` runs the
 * compat gate, builds the portable worker bundle (P-B), renders the plan,
 * and writes `<stem>.deploy/` + `<stem>.deploy-plan.json` +
 * `<stem>.wrangler.toml` only under `--yes`, then attempts the live
 * wrangler apply and reports `applied` honestly; `--preview` prints and
 * writes nothing, bare deploy refuses. No path spawns wrangler without
 * `--yes`.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { access, mkdtemp } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACTS_VERSION } from "@canlang/contracts";
import type {
  ActivationVerdict,
  CompatibilityDescriptor,
  EnvironmentSelection,
  InstalledSnapshot,
  OutboxIntent,
  StoragePort,
} from "@canlang/contracts";
import { loadArtifactFile, type LoadedArtifact } from "../runtime/artifact.js";
import { assembleModules } from "../runtime/modules.js";
import { activate } from "../deploy/activate.js";
import { probeInstalledRuntime } from "../deploy/installed.js";
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
  buildDeployBundle,
  deployBundleMain,
  writeDeployBundle,
  type DeployBundle,
} from "../deploy/bundle.js";
import { manualApplyCommand, runWranglerDeploy } from "../upgrade/apply.js";
import {
  PINNED_COMPATIBILITY_DATE,
  assertDistReady,
  resolveLocalDefaults,
} from "../dev/zero-config.js";
import { RELEASE_VERSION, assertLockstep, readLockstepInputs } from "../release/stamp.js";
import { runDocs } from "./docs.js";

export const PLATFORM_CLI_NAME = "can-platform";
export const PLATFORM_CLI_VERSION = "0.1.0";

const COMMANDS = ["run", "test", "build", "deploy", "activate", "docs"] as const;
type PlatformCommand = (typeof COMMANDS)[number];

interface FailureEnvelope {
  ok: false;
  command: string | null;
  code: string;
  producer?: string;
  contract?: string;
  detail: string;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(
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

const USAGE_TEXT =
  `Usage: ${PLATFORM_CLI_NAME} <${COMMANDS.join("|")}> [--artifact <path>] [--env <name>] [--preview|--yes] [--locale <tag>]`;

function usage(detail: string): never {
  process.stderr.write(`${USAGE_TEXT}\n`);
  fail(null, "usage", detail);
}

interface ParsedArgs {
  command: PlatformCommand;
  /** Null means zero-config discovery at dispatch time. */
  artifact: string | null;
  env: string | null;
  preview: boolean;
  yes: boolean;
  /** Requested reference locale (docs only; null means the app default). */
  locale: string | null;
}

function parse(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    // Help is human-facing but still emits the envelope: thin entries can
    // JSON.parse stdout unconditionally on every path.
    process.stderr.write(`${USAGE_TEXT}\nDelegation target for thin 'can' entries.\n`);
    emit({ ok: true, name: PLATFORM_CLI_NAME, version: PLATFORM_CLI_VERSION, usage: USAGE_TEXT });
    process.exit(0);
  }
  if (command === undefined) {
    usage("missing command");
  }
  if (command === "--version" || command === "-V") {
    emit({ ok: true, name: PLATFORM_CLI_NAME, version: PLATFORM_CLI_VERSION });
    process.exit(0);
  }
  if (!(COMMANDS as readonly string[]).includes(command)) {
    usage(`unknown command ${JSON.stringify(command)}`);
  }
  let artifact: string | null = null;
  let env: string | null = null;
  let preview = false;
  let yes = false;
  let locale: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--help" || flag === "-h") {
      // `can {cmd} --help` passes through verbatim (L1 thin entries), so
      // help is honored in subcommand position too — same envelope, exit 0.
      process.stderr.write(`${USAGE_TEXT}\nDelegation target for thin 'can' entries.\n`);
      emit({ ok: true, name: PLATFORM_CLI_NAME, version: PLATFORM_CLI_VERSION, usage: USAGE_TEXT });
      process.exit(0);
    }
    if (flag === "--preview" || flag === "--yes") {
      if (flag === "--preview") {
        if (preview) usage("duplicate --preview");
        preview = true;
      } else {
        if (yes) usage("duplicate --yes");
        yes = true;
      }
      continue;
    }
    if (flag !== undefined && (flag === "--locale" || flag.startsWith("--locale="))) {
      if (locale !== null) usage("duplicate --locale");
      if (flag.startsWith("--locale=")) {
        locale = flag.slice("--locale=".length);
      } else {
        if (i + 1 >= rest.length) usage("missing value for --locale");
        locale = rest[i + 1] as string;
        i += 1;
      }
      if (locale.length === 0) usage("--locale needs a non-empty tag");
      continue;
    }
    if (flag === "--artifact" || flag === "--env") {
      if (i + 1 >= rest.length) usage(`missing value for ${flag}`);
      const value = rest[i + 1] as string;
      if (flag === "--artifact") {
        if (artifact !== null) usage("duplicate --artifact");
        artifact = value;
      } else {
        if (env !== null) usage("duplicate --env");
        env = value;
      }
      i += 1;
    } else {
      usage(`unexpected argument ${JSON.stringify(flag)}`);
    }
  }
  if ((preview || yes) && command !== "deploy") {
    usage("--preview/--yes are deploy-only");
  }
  if (locale !== null && command !== "docs") {
    usage("--locale is docs-only");
  }
  if (command === "docs" && (artifact !== null || env !== null || preview || yes)) {
    usage("docs takes only --locale; it renders the reference model piped on stdin");
  }
  return { command: command as PlatformCommand, artifact, env, preview, yes, locale };
}

async function artifactExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function runArtifact(path: string): Promise<void> {
  let loaded: LoadedArtifact;
  try {
    loaded = loadArtifactFile(path);
  } catch (error) {
    fail("run", "invalid-artifact", error instanceof Error ? error.message : String(error));
  }
  const workDir = await mkdtemp(join(tmpdir(), "can-platform-run-"));
  // distRoot is the repo `packages/` dir, resolved from this file's
  // compiled location (dist/cli/platform.js), mirroring how the CLI itself
  // runs as tsc output rather than TS source.
  const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  // No runtime TS loader exists in this repo (no tsx/ts-node; bin points at
  // dist JS): stdlib is referenced as its COMPILED sibling, exactly how
  // this CLI file is executed after `tsc -p`.
  const stdlibUrl = new URL("../runtime/stdlib.js", import.meta.url).href;
  const asm = await assembleModules(loaded, { distRoot, workDir, stdlibUrl });
  const artifact = loaded.artifact;
  process.stderr.write(
    `artifact: ${artifact.modules.length} modules, ` +
      `${artifact.callables.length} callables, ${artifact.pages.length} pages\n`,
  );
  emit({
    ok: true,
    entry: asm.entryUrl,
    callables: artifact.callables.map((callable) => callable.id),
    pages: artifact.pages.map((page) => page.path),
  });
}

/* ------------------------------------------------------------------ */
/* activate: bundle loading + validation + serve-gate driver.           */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bundleStem(artifactPath: string): { dir: string; stem: string } {
  const dir = dirname(artifactPath);
  const base = basename(artifactPath);
  const stem = base.endsWith(".artifact.json")
    ? base.slice(0, -".artifact.json".length)
    : base.replace(/\.json$/, "");
  return { dir, stem };
}

function loadBundleJson(path: string, what: string): unknown {
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

function needRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what} must be a JSON object`);
  return value;
}

function needString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${what} must be a non-empty string`);
  return value;
}

function needStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${what} must be an array of strings`);
  }
  return [...value];
}

function loadDescriptor(path: string): CompatibilityDescriptor {
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

function loadEnvironment(path: string, env: string): EnvironmentSelection {
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

function loadTarget(path: string): {
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

interface BundleStore {
  installedSnapshot: InstalledSnapshot | null;
  outbox: readonly OutboxIntent[];
}

/** Absent file -> null (the digest gate reports incomplete); invalid file -> loud failure. */
async function loadStore(path: string): Promise<BundleStore | null> {
  if (!(await artifactExists(path))) return null;
  const root = needRecord(loadBundleJson(path, "store"), "store");
  const snapshot = root["installedSnapshot"];
  if (snapshot !== null) {
    const entry = needRecord(snapshot, "store.installedSnapshot");
    needString(entry["owner"], "store.installedSnapshot.owner");
    needString(entry["snapshotId"], "store.installedSnapshot.snapshotId");
    needString(entry["digest"], "store.installedSnapshot.digest");
    if (typeof entry["installedRevision"] !== "number" || typeof entry["installedAt"] !== "number") {
      throw new Error("store.installedSnapshot.installedRevision/installedAt must be numbers");
    }
  }
  if (!Array.isArray(root["outbox"])) throw new Error("store.outbox must be an array");
  for (const [index, intent] of (root["outbox"] as unknown[]).entries()) {
    const entry = needRecord(intent, `store.outbox[${index}]`);
    needString(entry["intentId"], `store.outbox[${index}].intentId`);
  }
  return root as unknown as BundleStore;
}

async function runActivate(artifactPath: string, env: string | null): Promise<void> {
  if (env === null) {
    usage("activate requires --env <name>");
  }
  let loaded: LoadedArtifact;
  try {
    loaded = loadArtifactFile(artifactPath);
  } catch (error) {
    fail("activate", "invalid-artifact", error instanceof Error ? error.message : String(error));
  }
  const { dir, stem } = bundleStem(artifactPath);
  let descriptor: CompatibilityDescriptor;
  let environment: EnvironmentSelection;
  let target: ReturnType<typeof loadTarget>;
  let bundleStore: BundleStore | null;
  try {
    descriptor = loadDescriptor(join(dir, `${stem}.descriptor.json`));
    environment = loadEnvironment(join(dir, `${stem}.${env}.environment.json`), env);
    target = loadTarget(join(dir, `${stem}.target.json`));
    bundleStore = await loadStore(join(dir, `${stem}.store.json`));
  } catch (error) {
    fail("activate", "invalid-activation-bundle", error instanceof Error ? error.message : String(error));
  }
  let installed;
  try {
    installed = probeInstalledRuntime({}, target);
  } catch (error) {
    fail("activate", "invalid-activation-bundle", error instanceof Error ? error.message : String(error));
  }
  const snapshot = bundleStore?.installedSnapshot ?? null;
  const outbox = bundleStore?.outbox ?? [];
  const store: StoragePort | undefined =
    bundleStore === null
      ? undefined
      : ({
          readInstalledSnapshot: async (owner: string) => (snapshot !== null && snapshot.owner === owner ? snapshot : null),
          outboxPending: async () => [...outbox],
        } as unknown as StoragePort);
  const verdict = await activate({
    artifact: loaded.artifact,
    descriptor,
    environment,
    installed,
    ...(store === undefined ? {} : { store }),
  });
  process.stderr.write(
    verdict.active ? "activation: active\n" : `activation: refused (${verdict.reasons.length} reason(s))\n`,
  );
  emit(
    verdict.active
      ? { ok: true, command: "activate", active: true }
      : { ok: true, command: "activate", active: false, reasons: verdict.reasons },
  );
}

/* ------------------------------------------------------------------ */
/* B5-J3: test/build/deploy local paths.                             */
/* ------------------------------------------------------------------ */

/**
 * Legacy entry script path (pre-bundle fallback while the P-A serving entry
 * is unbuilt; P-B plans stamp the bundle main instead — see `plan.ts`).
 */
const DEPLOY_MAIN = "./dist/worker/entry.js";

function distRootDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function missingEmission(command: PlatformCommand, verb: "execute" | "package" | "deploy"): never {
  const contract =
    verb === "execute"
      ? "can compile emission + ArtifactTestModule loader (§13 exampleFixtures)"
      : "can compile emission (CompileArtifact)";
  fail(command, "missing-producer", `no L1 CompileArtifact emission to ${verb} yet`, {
    producer: "lane-01",
    contract,
  });
}

/**
 * `test`: boot the local harness via `@canlang/testkit` (dynamic import
 * — the testkit statically depends on this package, so a static edge
 * would cycle) and report. Zero rows execute until the lane-01
 * test-module loader lands; the harness boot itself is the verified
 * local path.
 */
async function runTest(artifactPath: string): Promise<void> {
  let loaded: LoadedArtifact;
  try {
    loaded = loadArtifactFile(artifactPath);
  } catch {
    missingEmission("test", "execute");
  }
  const defaults = resolveLocalDefaults({ artifactPath });
  const distRoot = distRootDir();
  try {
    await assertDistReady(distRoot);
  } catch (error) {
    fail("test", "missing-dist", error instanceof Error ? error.message : String(error));
  }
  const workDir = await mkdtemp(join(tmpdir(), "can-platform-test-"));
  const stdlibUrl = new URL("../runtime/stdlib.js", import.meta.url).href;
  const asm = await assembleModules(loaded, { distRoot, workDir, stdlibUrl });
  const entry = loaded.artifact.modules[0];
  if (entry === undefined) {
    fail("test", "invalid-artifact", `artifact ${artifactPath} has no modules`);
  }
  // Non-literal specifier on purpose: a literal `import("@canlang/testkit")`
  // would pull the testkit's .d.ts (which re-exports this package's own
  // dist types) into this program's inputs and break `tsc -b` (TS5055).
  // The structural seam below is the whole contract this CLI needs.
  const testkitSpecifier: string = "@canlang/testkit";
  let testkit: {
    createLocalRowScope: (
      d1Id: string,
      options: {
        workerName: string;
        compatibilityDate: string;
        mainModule: string;
        modules: Readonly<Record<string, string>>;
        d1Binding: string;
      },
    ) => Promise<{ snapshot: () => Promise<unknown>; dispose: () => Promise<void> }>;
  };
  try {
    testkit = (await import(testkitSpecifier)) as typeof testkit;
  } catch {
    fail("test", "missing-producer", "no testkit harness: @canlang/testkit is not importable", {
      producer: "lane-07",
      contract: "@canlang/testkit dist (run the testkit build first)",
    });
  }
  const modules: Record<string, string> = {};
  for (const [name, url] of Object.entries(asm.moduleUrls)) {
    modules[name] = readFileSync(new URL(url), "utf8");
  }
  const scope = await testkit.createLocalRowScope(randomUUID(), {
    workerName: defaults.workerName,
    compatibilityDate: defaults.compatibilityDate,
    mainModule: entry.path,
    modules,
    d1Binding: "DB",
  });
  try {
    await scope.snapshot();
  } finally {
    await scope.dispose();
  }
  const artifact = loaded.artifact;
  process.stderr.write(
    `test harness: worker ${defaults.workerName} booted, ` +
      `${artifact.tests.length} test module(s), 0 rows executed\n`,
  );
  emit({
    ok: true,
    command: "test",
    workerName: defaults.workerName,
    modules: artifact.modules.length,
    testModules: artifact.tests.length,
    executed: 0,
    note:
      "harness boot verified via @canlang/testkit local scope; row execution needs the " +
      "lane-01 ArtifactTestModule loader (contract: can compile emission + " +
      "ArtifactTestModule loader (§13 exampleFixtures))",
  });
}

/** `build`: validate the artifact + assert release lockstep over the tree. */
async function runBuild(artifactPath: string): Promise<void> {
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
async function runDeploy(
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
    const bundle = buildDeployBundle(loaded.artifact, { repoRoot, verdict });
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
function formatVerdictLine(verdict: ActivationVerdict): string {
  if (verdict.active) return "verdict: active (worker will serve)";
  const codes = verdict.reasons.map((reason) => reason.code).join(", ");
  return (
    `verdict: INACTIVE — the deployed worker will serve the refusal worker ` +
    `until activation passes (${verdict.reasons.length} reason(s): ${codes})`
  );
}

/** Last `max` chars of `text` (wrangler output tail for the envelope). */
function tailText(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (args.command === "docs") {
    // Renderer pipe: no artifact discovery (stdin carries the model).
    await runDocs(args.locale);
    return;
  }
  let artifactPath = args.artifact;
  if (artifactPath === null) {
    // B5-J3 zero-config: absent --artifact discovers ./dist/*.artifact.json.
    // Discovery failures are usage errors (same envelope as the old
    // missing --artifact path, now with the pattern + the fix).
    try {
      artifactPath = resolveLocalDefaults({ cwd: process.cwd() }).artifactPath;
    } catch (error) {
      usage(error instanceof Error ? error.message : String(error));
    }
  }
  if (!(await artifactExists(artifactPath))) {
    fail(args.command, "missing-artifact", `artifact not readable: ${artifactPath}`);
  }
  if (args.command === "run") {
    await runArtifact(artifactPath);
    return;
  }
  if (args.command === "activate") {
    await runActivate(artifactPath, args.env);
    return;
  }
  if (args.command === "test") {
    await runTest(artifactPath);
    return;
  }
  if (args.command === "build") {
    await runBuild(artifactPath);
    return;
  }
  await runDeploy(artifactPath, args.env, args.preview, args.yes);
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  emit({ ok: false, command: null, code: "internal", detail });
  process.exit(1);
});
