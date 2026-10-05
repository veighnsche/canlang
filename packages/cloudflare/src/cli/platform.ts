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
 */
import { readFileSync } from "node:fs";
import { access, mkdtemp } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
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

export const PLATFORM_CLI_NAME = "can-platform";
export const PLATFORM_CLI_VERSION = "0.1.0";

const COMMANDS = ["run", "test", "build", "deploy", "activate"] as const;
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
  `Usage: ${PLATFORM_CLI_NAME} <${COMMANDS.join("|")}> --artifact <path> [--env <name>]`;

function usage(detail: string): never {
  process.stderr.write(`${USAGE_TEXT}\n`);
  fail(null, "usage", detail);
}

interface ParsedArgs {
  command: PlatformCommand;
  artifact: string;
  env: string | null;
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
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--help" || flag === "-h") {
      // `can {cmd} --help` passes through verbatim (L1 thin entries), so
      // help is honored in subcommand position too — same envelope, exit 0.
      process.stderr.write(`${USAGE_TEXT}\nDelegation target for thin 'can' entries.\n`);
      emit({ ok: true, name: PLATFORM_CLI_NAME, version: PLATFORM_CLI_VERSION, usage: USAGE_TEXT });
      process.exit(0);
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
  if (artifact === null) usage("missing required --artifact <path>");
  return { command: command as PlatformCommand, artifact, env };
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

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (!(await artifactExists(args.artifact))) {
    fail(args.command, "missing-artifact", `artifact not readable: ${args.artifact}`);
  }
  // run executes via loadArtifactFile + assembleModules; test/build/deploy
  // keep their stubs (test still names lane-01).
  if (args.command === "run") {
    await runArtifact(args.artifact);
    return;
  }
  if (args.command === "activate") {
    await runActivate(args.artifact, args.env);
    return;
  }
  if (args.command === "test") {
    fail(args.command, "missing-producer", "no L1 CompileArtifact emission to execute yet", {
      producer: "lane-01",
      contract: "can compile emission + ArtifactTestModule loader (§13 exampleFixtures)",
    });
  }
  if (args.command === "build") {
    fail(args.command, "missing-producer", "no L1 CompileArtifact emission to package yet", {
      producer: "lane-01",
      contract: "can compile emission (CompileArtifact)",
    });
  }
  fail(args.command, "missing-producer", "no L1 CompileArtifact emission to deploy yet", {
    producer: "lane-01",
    contract: "can compile emission (CompileArtifact)",
  });
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  emit({ ok: false, command: null, code: "internal", detail });
  process.exit(1);
});
