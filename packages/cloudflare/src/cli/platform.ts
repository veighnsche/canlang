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
 * validates the artifact + asserts release lockstep. `deploy` runs the
 * compat gate, builds the portable worker bundle (P-B), renders the plan,
 * and writes `<stem>.deploy/` + `<stem>.deploy-plan.json` +
 * `<stem>.wrangler.toml` only under `--yes`, then attempts the live
 * wrangler apply and reports `applied` honestly; `--preview` prints and
 * writes nothing, bare deploy refuses. No path spawns wrangler without
 * `--yes`.
 */
import { access, mkdtemp, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { resolveLocalDefaults } from "../dev/zero-config.js";
import { prepareLocalPreviewCapture } from "../dev/preview-inputs.js";
import { captureSingleFileSource, verifyCompilerSources } from "../dev/source-capture.js";
import { preflightLocalPreviewActivation, produceInstalledPortableBundle } from "../dev/preview-host.js";
import { loadInstalledExampleTestkit, MissingExampleTestkitError, runCompiledExamples } from "../dev/example-runner.js";
import { runDocs } from "./docs.js";
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
  runPreparedBuild,
  runPreparedDeploy,
  usage,
  type PlatformCommand,
  USAGE_TEXT,
} from "../preparation/host.js";

export { PLATFORM_CLI_NAME, PLATFORM_CLI_VERSION };

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
async function runTest(artifactPath: string): Promise<void> {
  let loaded: LoadedArtifact;
  try {
    loaded = loadArtifactFile(artifactPath);
  } catch {
    missingEmission("test", "execute");
  }
  if (loaded.artifact.tests.length === 0) {
    fail("test", "missing-producer", "compiled artifact has zero example rows; zero-row results cannot pass",
      { producer: "@canlang/testkit", contract: "compiled ArtifactTestModule rows" });
  }
  if (loaded.artifact.sources.length !== 1) {
    fail("test", "profile-unsupported", "local examples require exactly one captured .can source");
  }
  const checkoutRoot = process.cwd();
  const source = loaded.artifact.sources[0]!;
  const compilerPath = process.env["CAN_COMPILER_BIN"] ?? join(checkoutRoot, "compiler/target/debug/can");
  const request = prepareLocalPreviewCapture({
    checkoutRoot, appPath: source.path, compilerPath,
    catalogPath: join(checkoutRoot, "packages/values/dist/catalog.json"),
    helpIndexPath: join(checkoutRoot, "docs/specification/CONSTRUCT-HELP.md"),
  });
  const capture = await captureSingleFileSource(request);
  const sourceVerdict = verifyCompilerSources(capture, { complete: true, sources: loaded.artifact.sources });
  if (!sourceVerdict.ok) fail("test", "source-stale", `compiled artifact source ${sourceVerdict.reason}`);
  const activation = await preflightLocalPreviewActivation(loaded.artifact, capture);
  if (!activation.active) fail("test", "activation-refused", activation.reasons.map(reason => reason.detail).join("; "));
  const evidence = await produceInstalledPortableBundle({
    artifact: loaded.artifact, capture, verdict: activation,
    assets: { browser: true, valuesWasm: true },
  });
  let testkit;
  try {
    testkit = await loadInstalledExampleTestkit();
  } catch (error) {
    if (error instanceof MissingExampleTestkitError) {
      fail("test", "missing-producer", error.message,
        { producer: "@canlang/testkit", contract: "compiled example row executor" });
    }
    throw error;
  }
  const defaults = resolveLocalDefaults({ artifactPath });
  const result = await runCompiledExamples({
    artifactBytes: await readFile(artifactPath), artifactLabel: artifactPath,
    sourceRevision: capture.sourceRevision,
    worker: {
      mainModule: evidence.bundle.mainModule,
      modules: evidence.bundle.modules,
      binaryModules: evidence.bundle.binaries,
    },
    workerName: defaults.workerName,
    compatibilityDate: defaults.compatibilityDate,
    d1Binding: "DB", testkit,
  });
  emit({ ok: result.ok, command: "test", executed: result.executed, report: result.report });
  if (!result.ok) process.exitCode = 1;
}

/** `build`: prepared route; thin CLI delegation (P02.2). */
async function runBuild(artifactPath: string): Promise<void> {
  await runPreparedBuild(artifactPath);
}

/** `deploy`: prepared route; thin CLI delegation (P02.2). */
async function runDeploy(
  artifactPath: string,
  env: string | null,
  preview: boolean,
  yes: boolean,
): Promise<void> {
  await runPreparedDeploy(artifactPath, env, preview, yes);
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
