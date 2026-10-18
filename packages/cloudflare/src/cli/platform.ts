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
 * captures source/current runtime inputs, starts isolated D1 rows, and
 * refuses zero-row artifacts. `build`
 * validates the artifact + asserts release lockstep.
 *
 * `gen` (BGI-03) is the generation dispatcher join: it reads one v1
 * JSON request via `--request FILE` or stdin and answers with the
 * versioned generation envelope (exit 0/2/3/4/5/6). Request
 * validation plus the `doctor` provider check are live; execution,
 * lifecycle, and lease handlers join through BGI-04/05/11/12.
 *
 * `deploy` runs the
 * compat gate, builds the portable worker bundle (P-B), renders the plan,
 * and writes `<stem>.deploy/` + `<stem>.deploy-plan.json` +
 * `<stem>.wrangler.toml` only under `--yes`, then attempts the live
 * wrangler apply and reports `applied` honestly; `--preview` prints and
 * writes nothing, bare deploy refuses. No path spawns wrangler without
 * `--yes`.
 */
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolveLocalDefaults } from "./artifact-defaults.js";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalCommandLifetime, LocalCommandInterrupted, type LocalCommandLifetime } from "./command-lifetime.js";
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
import { runDocs } from "./docs.js";
import { runGen } from "./gen.js";
import { runSourceWorkflow } from "./source-workflow.js";
// P02.2: envelope/output helpers, bundle loaders, dist/missing helpers and
// the prepared build/deploy route live in the preparation host module;
// this CLI keeps parsing, dispatch and the run/test/activate paths.
import {
  COMMANDS,
  PLATFORM_CLI_NAME,
  PLATFORM_CLI_VERSION,
  bundleStem,
  emit,
  fail,
  loadBundleJson,
  loadDescriptor,
  loadEnvironment,
  loadTarget,
  missingEmission,
  needRecord,
  needString,
  needStringArray,
  runNativeBuild,
  runNativeDeploy,
  runPreparedBuild,
  runPreparedDeploy,
  usage,
  type PlatformCommand,
  USAGE_TEXT,
} from "../preparation/host.js";

export { PLATFORM_CLI_NAME, PLATFORM_CLI_VERSION };

interface ParsedArgs {
  command: PlatformCommand | "gen";
  /** Null means zero-config discovery at dispatch time. */
  artifact: string | null;
  env: string | null;
  preview: boolean;
  yes: boolean;
  /**
   * Explicit preparation backend (build/deploy only). Null means the
   * default TS route; `native` runs the native driver. No silent
   * default switch: any other value is a usage refusal.
   */
  backend: "ts" | "native" | null;
  /** Requested reference locale (docs only; null means the app default). */
  locale: string | null;
  /** Versioned JSON request file (gen only; null means stdin carries it). */
  genRequest: string | null;
}

/**
 * Take a `--name value` / `--name=value` flag value at `rest[i]`,
 * advancing past a separate value word. Same missing-value refusal
 * in both spellings; the returned index already skips the value.
 */
function takeFlagValue(rest: string[], i: number, name: string): { value: string; nextI: number } {
  const flag = rest[i] as string;
  if (flag.startsWith(`${name}=`)) {
    return { value: flag.slice(name.length + 1), nextI: i };
  }
  if (i + 1 >= rest.length) usage(`missing value for ${name}`);
  return { value: rest[i + 1] as string, nextI: i + 1 };
}

/** Cross-flag validation after the flag loop: same order, same refusals. */
function validateCommandFlags(
  command: string,
  flags: { artifact: string | null; env: string | null; preview: boolean; yes: boolean; backend: "ts" | "native" | null; locale: string | null },
): void {
  const { artifact, env, preview, yes, backend, locale } = flags;
  if ((preview || yes) && command !== "deploy") {
    usage("--preview/--yes are deploy-only");
  }
  if (backend !== null && command !== "deploy" && command !== "build") {
    usage("--backend is build/deploy-only");
  }
  if (command === "docs" && (artifact !== null || env !== null || preview || yes || backend !== null)) {
    usage("docs takes only --locale; it renders the reference model piped on stdin");
  }
  if (locale !== null && command !== "docs") {
    usage("--locale is docs-only");
  }
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
  // BGI-03: `gen` joins here without touching the frozen gate
  // COMMANDS tuple (other lanes own those entries): it reads one v1
  // JSON request via --request FILE or stdin and answers with the
  // versioned generation envelope through ./gen.js.
  if (command === "gen") {
    return parseGen(rest);
  }
  if (!(COMMANDS as readonly string[]).includes(command)) {
    usage(`unknown command ${JSON.stringify(command)}`);
  }
  const flags: PlatformFlags = { artifact: null, env: null, preview: false, yes: false, locale: null, backend: null };
  for (let i = 0; i < rest.length; i += 1) {
    i = parsePlatformFlag(rest, i, flags);
  }
  const { artifact, env, preview, yes, backend, locale } = flags;
  validateCommandFlags(command, { artifact, env, preview, yes, backend, locale });
  return { command: command as PlatformCommand, artifact, env, preview, yes, backend, locale, genRequest: null };
}

interface PlatformFlags {
  artifact: string | null;
  env: string | null;
  preview: boolean;
  yes: boolean;
  locale: string | null;
  backend: "ts" | "native" | null;
}

function parseBackendFlag(rest: string[], i: number, flags: PlatformFlags): number | null {
  const flag = rest[i];
  if (flag === undefined || (flag !== "--backend" && !flag.startsWith("--backend="))) return null;
  if (flags.backend !== null) usage("duplicate --backend");
  const taken = takeFlagValue(rest, i, "--backend");
  if (taken.value !== "ts" && taken.value !== "native") {
    usage(`--backend must be ts or native (got ${JSON.stringify(taken.value)})`);
  }
  flags.backend = taken.value;
  return taken.nextI;
}

function parseLocaleFlag(rest: string[], i: number, flags: PlatformFlags): number | null {
  const flag = rest[i];
  if (flag === undefined || (flag !== "--locale" && !flag.startsWith("--locale="))) return null;
  if (flags.locale !== null) usage("duplicate --locale");
  const taken = takeFlagValue(rest, i, "--locale");
  if (taken.value.length === 0) usage("--locale needs a non-empty tag");
  flags.locale = taken.value;
  return taken.nextI;
}

function parsePlatformFlag(rest: string[], i: number, flags: PlatformFlags): number {
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
      if (flags.preview) usage("duplicate --preview");
      flags.preview = true;
    } else {
      if (flags.yes) usage("duplicate --yes");
      flags.yes = true;
    }
    return i;
  }
  const scalar = parseBackendFlag(rest, i, flags) ?? parseLocaleFlag(rest, i, flags);
  if (scalar !== null) return scalar;
  if (flag === "--artifact" || flag === "--env") {
    const taken = takeFlagValue(rest, i, flag);
    if (flag === "--artifact") {
      if (flags.artifact !== null) usage("duplicate --artifact");
      flags.artifact = taken.value;
    } else {
      if (flags.env !== null) usage("duplicate --env");
      flags.env = taken.value;
    }
    return taken.nextI;
  }
  usage(`unexpected argument ${JSON.stringify(flag)}`);
  return i;
}

/** Parse `gen` args: at most one `--request FILE`; stdin carries the request when bare. */
function parseGen(rest: string[]): ParsedArgs {
  const base: ParsedArgs = {
    command: "gen",
    artifact: null,
    env: null,
    preview: false,
    yes: false,
    backend: null,
    locale: null,
    genRequest: null,
  };
  let i = 0;
  while (i < rest.length) {
    const flag = rest[i] as string;
    if (flag === "--help" || flag === "-h") {
      process.stderr.write("can-platform gen --request FILE\ncan-platform gen < request.json\n");
      emit({ ok: true, name: PLATFORM_CLI_NAME, version: PLATFORM_CLI_VERSION, command: "gen" });
      process.exit(0);
    }
    if (flag === "--request" || flag.startsWith("--request=")) {
      if (base.genRequest !== null) usage("duplicate --request");
      if (flag.startsWith("--request=")) {
        base.genRequest = flag.slice("--request=".length);
      } else {
        if (i + 1 >= rest.length) usage("missing value for --request");
        base.genRequest = rest[i + 1] as string;
        i += 1;
      }
      if (base.genRequest.length === 0) usage("--request needs a non-empty PATH");
      i += 1;
      continue;
    }
    usage(`unexpected argument ${JSON.stringify(flag)} (can-platform gen takes only --request FILE)`);
  }
  return base;
}

async function artifactExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function runArtifact(path: string, lifetime: LocalCommandLifetime): Promise<void> {
  let loaded: LoadedArtifact;
  try {
    loaded = loadArtifactFile(path);
  } catch (error) {
    fail("run", "invalid-artifact", error instanceof Error ? error.message : String(error));
  }
  lifetime.checkpoint("artifact load");
  const workDir = await mkdtemp(join(tmpdir(), "can-platform-run-"));
  // distRoot is the repo `packages/` dir, resolved from this file's
  // compiled location (dist/cli/platform.js), mirroring how the CLI itself
  // runs as tsc output rather than TS source.
  const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  // No runtime TS loader exists in this repo (no tsx/ts-node; bin points at
  // dist JS): stdlib is referenced as its COMPILED sibling, exactly how
  // this CLI file is executed after `tsc -p`.
  const stdlibUrl = new URL("../runtime/stdlib.js", import.meta.url).href;
  try {
    lifetime.checkpoint("staging acquisition");
    const asm = await assembleModules(loaded, { distRoot, workDir, stdlibUrl });
    lifetime.checkpoint("module assembly");
    const artifact = loaded.artifact;
    process.stderr.write(
      `artifact: ${artifact.modules.length} modules, ` +
        `${artifact.callables.length} callables, ${artifact.pages.length} pages\n`,
    );
    lifetime.checkpoint("run result");
    emit({
      ok: true,
      entry: asm.entryUrl,
      callables: artifact.callables.map((callable) => callable.id),
      pages: artifact.pages.map((page) => page.path),
    });
    // The returned file URL must remain usable after this process exits.
    // Its caller owns successful staging; failures own no returned resource.
  } catch (error) {
    try { await rm(workDir, { recursive: true, force: true }); } catch { /* Preserve the operative failure. */ }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* activate: bundle loading + validation + serve-gate driver.           */
/* ------------------------------------------------------------------ */

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
 * `test`: capture the exact source and installed runtime, then execute every
 * compiled row through the real D1-backed canonical invoker.
 */
type NativeExamplesExit = { code: number | null; signal: NodeJS.Signals | null; stdout: string };
function nativeExamplesDependency(error: unknown): never {
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
    fail("test", "missing-producer", "native development helper is unavailable; build or install can-dev or set CAN_DEV_BIN", {
      producer: "dev-server", contract: "native saved-artifact examples",
    });
  }
  throw error;
}
async function nativeExamplesExit(artifactPath: string, lifetime: LocalCommandLifetime): Promise<NativeExamplesExit> {
  const binary = process.env.CAN_DEV_BIN ?? "can-dev";
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }>((done, reject) => {
    const child = spawn(binary, ["examples-artifact", "--artifact", resolve(artifactPath), "--root", process.cwd()],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", bytes = 0, failure: Error | undefined;
    const abort = (): void => { child.kill("SIGTERM"); };
    lifetime.signal.addEventListener("abort", abort, { once: true });
    if (lifetime.signal.aborted) abort();
    const record = (chunk: Buffer, output: boolean): void => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) {
        failure ??= new Error("native example output exceeded its limit");
        child.kill("SIGTERM");
      } else if (output) stdout += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => record(chunk, true));
    // Runtime diagnostics can contain business values. Only its bounded JSON report is emitted.
    child.stderr.on("data", (chunk: Buffer) => record(chunk, false));
    child.once("error", error => { failure ??= error; });
    child.once("close", (code, signal) => {
      lifetime.signal.removeEventListener("abort", abort);
      if (failure !== undefined) reject(failure);
      else done({ code, signal, stdout });
    });
  }).catch(nativeExamplesDependency);
}
function nativeExamplesFailure(result: Record<string, unknown>, lifetime: LocalCommandLifetime): void {
  if (result.ok === false && typeof result.code === "string" && typeof result.detail === "string") {
    // Preserve an operative failure even if cancellation arrived during its cleanup.
    if (result.code === "command-cancelled" || result.code === "command-timeout") lifetime.checkpoint("native examples cancelled");
    fail("test", result.code, result.detail, {
      ...(typeof result.producer === "string" ? { producer: result.producer } : {}),
      ...(typeof result.contract === "string" ? { contract: result.contract } : {}),
    });
  }
}
async function runTest(artifactPath: string, lifetime: LocalCommandLifetime): Promise<void> {
  lifetime.checkpoint("native examples start");
  // The native helper verifies and executes these exact saved artifact bytes.
  // It owns capture, admission, bundle creation, row resources and their cleanup.
  const outcome = await nativeExamplesExit(artifactPath, lifetime);
  let result: Record<string, unknown>;
  try { result = JSON.parse(outcome.stdout) as Record<string, unknown>; }
  catch {
    lifetime.checkpoint("native examples cleanup joined");
    fail("test", "native-examples-failed", "native examples did not return a bounded JSON result");
  }
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    fail("test", "native-examples-failed", "native examples returned an invalid result");
  }
  nativeExamplesFailure(result, lifetime);
  lifetime.checkpoint("native examples cleanup joined");
  if (typeof result.ok !== "boolean" || !Number.isSafeInteger(result.executed) || Number(result.executed) < 1 ||
      result.report === null || typeof result.report !== "object" || Array.isArray(result.report) ||
      outcome.signal !== null || outcome.code !== (result.ok ? 0 : 1)) {
    fail("test", "native-examples-failed", "native examples returned an inconsistent result or exit status");
  }
  emit({ ok: result.ok, command: "test", executed: result.executed, report: result.report });
  if (!result.ok) process.exitCode = 1;
}

/** `build`: prepared route; thin CLI delegation (P02.2). `--backend native` runs the native driver. */
async function runBuild(
  artifactPath: string,
  lifetime: LocalCommandLifetime,
  backend: "ts" | "native" | null,
): Promise<void> {
  if (backend === "native") {
    await runNativeBuild(artifactPath, lifetime);
    return;
  }
  await runPreparedBuild(artifactPath, lifetime);
}

/** `deploy`: prepared route; thin CLI delegation (P02.2). `--backend native` runs the native driver. */
async function runDeploy(
  artifactPath: string,
  env: string | null,
  preview: boolean,
  yes: boolean,
  lifetime: LocalCommandLifetime,
  backend: "ts" | "native" | null,
): Promise<void> {
  if (backend === "native") {
    await runNativeDeploy(artifactPath, env, preview, yes, lifetime);
    return;
  }
  await runPreparedDeploy(artifactPath, env, preview, yes, lifetime);
}

async function main(): Promise<void> {
  const [sourceCommand, ...sourceArgs] = process.argv.slice(2);
  if (sourceCommand === "generate" || sourceCommand === "validate") {
    await runSourceWorkflow(sourceCommand, sourceArgs);
    return;
  }
  const args = parse(process.argv.slice(2));
  if (args.command === "docs") {
    // Renderer pipe: no artifact discovery (stdin carries the model).
    await runDocs(args.locale);
    return;
  }
  if (args.command === "gen") {
    // Generation pipe: no artifact discovery (the request carries the root).
    await runGen(args.genRequest);
    return;
  }
  const lifetime = args.command === "activate" ? undefined : createLocalCommandLifetime(
    args.command,
    args.command === "test" ? 300_000 : args.command === "deploy" ? (args.yes ? 360_000 : 120_000) : 60_000,
  );
  try {
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
    lifetime?.checkpoint("artifact discovery");
    const readable = await artifactExists(artifactPath);
    lifetime?.checkpoint("artifact access");
    if (!readable) {
      fail(args.command, "missing-artifact", `artifact not readable: ${artifactPath}`);
    }
    if (args.command === "run") {
      await runArtifact(artifactPath, lifetime!);
      return;
    }
    if (args.command === "activate") {
      await runActivate(artifactPath, args.env);
      return;
    }
    if (args.command === "test") {
      await runTest(artifactPath, lifetime!);
      return;
    }
    if (args.command === "build") {
      await runBuild(artifactPath, lifetime!, args.backend);
      return;
    }
    await runDeploy(artifactPath, args.env, args.preview, args.yes, lifetime!, args.backend);
  } finally {
    lifetime?.dispose();
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  const interrupted = error instanceof LocalCommandInterrupted;
  emit({ ...(interrupted ? error.failureContext : undefined), ok: false,
    command: interrupted ? error.command : null,
    code: interrupted ? error.code : "internal", detail: interrupted ? error.failureContext?.detail ?? detail : detail });
  process.exit(1);
});
