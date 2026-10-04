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
 */
import { access, mkdtemp } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadArtifactFile, type LoadedArtifact } from "../runtime/artifact.js";
import { assembleModules } from "../runtime/modules.js";

export const PLATFORM_CLI_NAME = "can-platform";
export const PLATFORM_CLI_VERSION = "0.1.0";

const COMMANDS = ["run", "test", "build", "deploy"] as const;
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
