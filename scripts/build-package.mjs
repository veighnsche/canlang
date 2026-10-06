#!/usr/bin/env node
/** A true producer execution starts from its owned outputs, including incremental state. */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { taskEnvironment } from "./run-tasks.mjs";

const directory = process.cwd();
const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
if (!manifest.name?.startsWith("@canlang/") || typeof manifest.scripts?.["build:emit"] !== "string") {
  throw new Error("build-package must run inside an owning Can package");
}
const actual = taskEnvironment();
if (process.env.TURBO_HASH) {
  for (const name of ["CAN_BUILD_HOST", "CAN_BUILD_NODE", "CAN_BUILD_BUN"]) {
    if (process.env[name] !== actual[name]) {
      throw new Error(`Task identity ${name} is missing or differs from the executing tool; use bun run build`);
    }
  }
}
const dist = join(directory, "dist");
function separatelyOwned(path) {
  return (manifest.name === "@canlang/values" && path === "catalog.json") ||
    (manifest.name === "@canlang/cloudflare" && /^preparation\/[^/]+\/(can-preparation(?:\.exe)?|manifest\.json)$/.test(path));
}
function cleanOwnedOutputs(current, prefix = "") {
  for (const entry of readdirSync(current)) {
    const path = prefix ? `${prefix}/${entry}` : entry;
    if (separatelyOwned(path)) continue;
    const full = join(current, entry);
    if (lstatSync(full).isDirectory()) {
      cleanOwnedOutputs(full, path);
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true });
    } else rmSync(full);
  }
}
if (existsSync(dist)) {
  if (lstatSync(dist).isSymbolicLink()) throw new Error("Refusing to clean a symlinked producer dist");
  cleanOwnedOutputs(dist);
}
for (const entry of readdirSync(directory)) {
  if (entry.endsWith(".tsbuildinfo")) rmSync(join(directory, entry));
}
if (!process.argv.includes("--prepare")) {
  execFileSync("bun", ["run", "build:emit"], { cwd: directory, env: actual, stdio: "inherit" });
}
