#!/usr/bin/env node
/** Public task entry: pinned Turbo, local cache and verified host/tool identity. */
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const expectedTurbo = "2.11.7";
const expectedBun = "1.4.2";

/** Compute identities from the executing tools; caller labels cannot override them. */
export function taskEnvironment() {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Can tasks require Node 22 or newer");
  const bun = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
  if (bun !== expectedBun) throw new Error(`Can tasks require Bun ${expectedBun}; found ${bun}`);
  return {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    CAN_BUILD_HOST: `${process.platform}-${process.arch}`,
    CAN_BUILD_NODE: process.version,
    CAN_BUILD_BUN: bun,
    TURBO_TELEMETRY_DISABLED: "1",
  };
}

export function runTasks(args) {
  const version = require("turbo/package.json").version;
  if (version !== expectedTurbo) throw new Error(`Can tasks require Turbo ${expectedTurbo}; found ${version}`);
  const cli = require.resolve("turbo/bin/turbo");
  const cache = args.some((arg) => arg === "--cache" || arg.startsWith("--cache=")) ? [] : ["--cache=local:rw"];
  const child = spawnSync(process.execPath, [cli, "run", ...cache, ...args, "--env-mode=strict"], {
    cwd: root,
    env: taskEnvironment(),
    stdio: "inherit",
  });
  if (child.error) throw child.error;
  return child.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runTasks(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
