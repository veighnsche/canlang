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
import { access } from "node:fs/promises";
import { constants } from "node:fs";

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

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (!(await artifactExists(args.artifact))) {
    fail(args.command, "missing-artifact", `artifact not readable: ${args.artifact}`);
  }
  // Producer gates, checked in dependency order: every command needs a real
  // L1 CompileArtifact first; run/test additionally need the L3 invocation
  // engine once emission exists. Until those land, report the exact unmet
  // contract (PLAN: thin entries exec or print a precise missing-producer
  // error). The first unmet gate wins, so run/test name lane-01 today.
  if (args.command === "run" || args.command === "test") {
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
