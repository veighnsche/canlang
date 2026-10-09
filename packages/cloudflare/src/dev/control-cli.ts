#!/usr/bin/env node
/** Standalone JSON entry for the local owner-only development session. */
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runDevControlArgv, type DevControlEnvelope } from "./control-client.js";

const MAX_STDOUT_BYTES = 128 * 1024;
const USAGE_CODES = new Set([
  "UNKNOWN_COMMAND", "INVALID_ARGUMENTS", "INVALID_CAPTURE", "REVISION_REQUIRED", "INVALID_REVISION", "FAILURE_REF_REQUIRED", "CONSTRUCT_ID_REQUIRED", "RANK_REF_REQUIRED",
]);

export interface CliOutput {
  readonly line: string;
  /** 0 means the control operation completed, even if `check` found Can errors. */
  readonly exitCode: 0 | 1 | 2;
}

function safeCommand(command: string): string {
  return command.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "help";
}

function controlFailure(command: string, code: string, detail: string): DevControlEnvelope {
  return { ok: false, command: safeCommand(command), code, detail };
}

/** One bounded line; never inspect source-check state to choose the process exit. */
export function formatDevControlOutput(envelope: DevControlEnvelope): CliOutput {
  let selected = envelope;
  let serialized: string;
  try {
    serialized = JSON.stringify(selected);
  } catch {
    selected = controlFailure(envelope.command, "CONTROL_INTERNAL", "control response cannot be encoded as JSON");
    serialized = JSON.stringify(selected);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") + 1 > MAX_STDOUT_BYTES) {
    selected = controlFailure(envelope.command, "OUTPUT_LIMIT", "control response exceeds the JSON output limit");
    serialized = JSON.stringify(selected);
  }
  return {
    line: `${serialized}\n`,
    exitCode: selected.ok ? 0 : USAGE_CODES.has(selected.code) ? 2 : 1,
  };
}

export async function runDevControlCli(
  argv: readonly string[],
  cwd = process.cwd(),
  write: (line: string) => void = line => { process.stdout.write(line); },
): Promise<number> {
  let envelope: DevControlEnvelope;
  try {
    envelope = await runDevControlArgv(argv, { cwd });
  } catch {
    envelope = controlFailure(argv[0] ?? "help", "CONTROL_INTERNAL", "development control failed before a response");
  }
  const output = formatDevControlOutput(envelope);
  write(output.line);
  return output.exitCode;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  void runDevControlCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
