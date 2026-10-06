#!/usr/bin/env node
/**
 * Build the release `can-preparation` binary (P09.1).
 *
 * Pinned-toolchain reproducible build (`cargo build --locked --release`)
 * staged to `dist/preparation/<triple>/` with a `manifest.json` sidecar
 * (binary sha/bytes, toolchain versions, lockfile hash, source head).
 * Fails loud on toolchain drift or cross-triple requests.
 *
 * Usage: node packages/cloudflare/scripts/build-preparation.mjs [--triple T]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const CRATE_DIR = join(PACKAGE_ROOT, "preparation");
const EXPECTED_RUSTC = "1.99.0";

export function hostTriple() {
  const plat = platform() === "win32" ? "windows" : platform();
  if (plat === "linux") return `${plat}-${arch()}-gnu`;
  return `${plat}-${arch()}`;
}

export function binaryName(triple) {
  return triple.startsWith("windows-") ? "can-preparation.exe" : "can-preparation";
}

function toolVersion(tool, pattern) {
  const out = execFileSync(tool, ["--version"], { encoding: "utf8", cwd: CRATE_DIR });
  const match = out.match(pattern);
  if (!match) throw new Error(`cannot parse ${tool} version from: ${out}`);
  return match[1];
}

function sourceHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: PACKAGE_ROOT }).trim();
  } catch {
    return "unknown (not a git checkout)";
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function buildRelease({ triple = hostTriple(), outDir = join(PACKAGE_ROOT, "dist") } = {}) {
  const rustc = toolVersion("rustc", /rustc (\S+)/);
  const cargo = toolVersion("cargo", /cargo (\S+)/);
  if (!rustc.startsWith(EXPECTED_RUSTC)) {
    throw new Error(
      `toolchain drift: rust-toolchain pins ${EXPECTED_RUSTC}, active rustc is ${rustc}. ` +
        `Run: rustup toolchain install ${EXPECTED_RUSTC} --profile minimal`,
    );
  }
  if (triple !== hostTriple()) {
    throw new Error(
      `cross triple ${triple} requested on ${hostTriple()}: install the rust target + linker for ${triple}, then re-run.`,
    );
  }
  console.error(`build-preparation: cargo build --locked --release (${triple})`);
  execFileSync("cargo", ["build", "--locked", "--release"], { cwd: CRATE_DIR, stdio: "inherit" });
  const built = join(CRATE_DIR, "target", "release", binaryName(triple));
  if (!existsSync(built)) throw new Error(`release binary missing at ${built}`);
  const stageDir = join(outDir, "preparation", triple);
  mkdirSync(stageDir, { recursive: true });
  const staged = join(stageDir, binaryName(triple));
  copyFileSync(built, staged);
  chmodSync(staged, 0o755);
  const sidecar = {
    triple,
    binary: binaryName(triple),
    sha256: sha256File(staged),
    bytes: readFileSync(staged).length,
    toolchain: { rustc, cargo, pinned: EXPECTED_RUSTC },
    lockfileSha256: sha256File(join(CRATE_DIR, "Cargo.lock")),
    sourceHead: sourceHead(),
    release: "0.1.0",
  };
  writeFileSync(join(stageDir, "manifest.json"), JSON.stringify(sidecar, null, 2) + "\n");
  return { staged, sidecar };
}

function main() {
  const argv = process.argv.slice(2);
  const tripleFlag = argv.indexOf("--triple");
  try {
    const { staged, sidecar } = buildRelease(
      tripleFlag >= 0 ? { triple: argv[tripleFlag + 1] } : {},
    );
    console.log(JSON.stringify({ ok: true, staged, sha256: sidecar.sha256 }));
  } catch (error) {
    console.error(`build-preparation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
