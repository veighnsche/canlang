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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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

/**
 * Actual Cargo target directory (026/030): Cargo resolves a relative
 * CARGO_TARGET_DIR against the manifest directory, so resolve the
 * inherited override against CRATE_DIR (never the process cwd).
 * Otherwise consume `cargo metadata`'s target_directory from the
 * same CRATE_DIR/environment the build runs in, and fail loud when
 * it cannot be established — never stamp a possibly stale default
 * copy. Both profiles consume the binary this command's build
 * actually emitted.
 */
function targetDir() {
  const override = process.env.CARGO_TARGET_DIR;
  if (typeof override === "string" && override.length > 0) {
    return resolve(CRATE_DIR, override);
  }
  let meta;
  try {
    meta = JSON.parse(
      execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
        encoding: "utf8",
        cwd: CRATE_DIR,
      }),
    );
  } catch (error) {
    throw new Error(
      `build-preparation: cannot establish the Cargo target directory via metadata: ${error}`,
    );
  }
  if (typeof meta?.target_directory !== "string" || meta.target_directory.length === 0) {
    throw new Error("build-preparation: cargo metadata reported no target_directory: refusing a stale default");
  }
  return meta.target_directory;
}

function crateVersion() {
  const text = readFileSync(join(CRATE_DIR, "Cargo.toml"), "utf8");
  const match = text.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("cannot read [package] version from preparation/Cargo.toml");
  return match[1];
}

function stampSidecar(stageDir, binary, { release } = {}) {
  const staged = join(stageDir, binary);
  const rustc = toolVersion("rustc", /rustc (\S+)/);
  const cargo = toolVersion("cargo", /cargo (\S+)/);
  if (!rustc.startsWith(EXPECTED_RUSTC)) {
    throw new Error(
      `toolchain drift: rust-toolchain pins ${EXPECTED_RUSTC}, active rustc is ${rustc}. ` +
        `Run: rustup toolchain install ${EXPECTED_RUSTC} --profile minimal`,
    );
  }
  const sidecar = {
    triple: hostTriple(),
    binary,
    sha256: sha256File(staged),
    bytes: readFileSync(staged).length,
    toolchain: { rustc, cargo, pinned: EXPECTED_RUSTC },
    lockfileSha256: sha256File(join(CRATE_DIR, "Cargo.lock")),
    sourceHead: sourceHead(),
    release: release ?? crateVersion(),
  };
  writeFileSync(join(stageDir, "manifest.json"), JSON.stringify(sidecar, null, 2) + "\n");
  return { staged, sidecar };
}

/**
 * Refuse an inherited build-target override (045/030): with
 * CARGO_BUILD_TARGET or a crate-local `build.target` set, Cargo
 * emits under `target/<triple>/{release,debug}` while this script
 * consumes `target/{release,debug}/` — stamping a stale host file as
 * current output. The assigned host profile builds the default
 * target only.
 */
export function assertNoBuildTargetOverride() {
  const envTarget = process.env.CARGO_BUILD_TARGET;
  if (typeof envTarget === "string" && envTarget.length > 0) {
    throw new Error(
      `build-preparation: CARGO_BUILD_TARGET=${JSON.stringify(envTarget)} relocates build output under target/<triple>/; unset it — the host profile builds the default target only`,
    );
  }
  for (const name of ["config.toml", "config"]) {
    const file = join(CRATE_DIR, ".cargo", name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (/^\s*target\s*=/m.test(text)) {
      throw new Error(
        `build-preparation: ${file} sets a build target; remove it — the host profile builds the default target only`,
      );
    }
  }
}

/**
 * Run this command's Cargo build and return the ACTUAL compiler-artifact
 * executable for the can-preparation bin (046B): fresh or recompiled,
 * the reported path is consumed — never a guessed
 * `target/{release,debug}/` copy that a build-target override (or any
 * other layout change) could leave stale. Refuses loud when Cargo
 * reports no executable for this profile.
 */
export function cargoBuiltExecutable(args) {
  const output = execFileSync("cargo", [...args, "--message-format=json-render-diagnostics"], {
    cwd: CRATE_DIR,
    encoding: "utf8",
  });
  let built = null;
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      message?.reason === "compiler-artifact" &&
      message?.target?.name === "can-preparation" &&
      typeof message?.executable === "string"
    ) {
      built = message.executable;
    }
  }
  if (built === null) {
    throw new Error(
      "build-preparation: cargo reported no compiler-artifact executable for the can-preparation bin; refusing to guess the output path",
    );
  }
  if (!existsSync(built)) throw new Error(`built binary missing at reported path ${built}`);
  return built;
}

/** Host triple of the active pinned toolchain (`rustc -vV`). */
export function rustcHost() {
  let out;
  try {
    out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  } catch (error) {
    throw new Error(`build-preparation: cannot determine the rustc host triple: ${error}`);
  }
  const match = /^host:\s*(\S+)\s*$/m.exec(out);
  if (!match) throw new Error("build-preparation: `rustc -vV` reported no host triple");
  return match[1];
}

/**
 * Stage the ACTUAL reported bytes and refuse a non-host profile
 * before stamping (047/049): returns the real stage dir + binary
 * name for the stamp. The reported path is interpreted relative to
 * the actual target-dir root (never by assuming the directory is
 * literally named `target`): `<root>/<profile>` is the default
 * host layout; `<root>/<triple>/<profile>` must carry the active
 * rustc host triple or it is a cross build and is refused — never
 * silently labeled host. Anything else is refused as unknown.
 */
export function hostProfileStage(built, targetRoot) {
  const dir = dirname(built);
  const profile = basename(dir);
  if (profile !== "release" && profile !== "debug") {
    throw new Error(`build-preparation: unrecognized build output layout at ${built}`);
  }
  const rel = relative(targetRoot, dir);
  const parts = rel.split(sep).filter((part) => part !== "" && part !== ".");
  if (parts.length === 1) {
    // <root>/<profile>: default-target layout (host; overrides that
    // could relocate it are refused separately).
  } else if (parts.length === 2 && parts[1] === profile) {
    // <root>/<triple>/<profile>: only the active rustc host triple
    // is a host build.
    if (parts[0] !== rustcHost()) {
      throw new Error(
        `build-preparation: non-host build target ${JSON.stringify(parts[0])} reported; refusing to stamp it as a host binary`,
      );
    }
  } else {
    throw new Error(`build-preparation: build output ${built} is outside the target root ${targetRoot}: refusing to stamp`);
  }
  return { stageDir: dir, binary: basename(built) };
}

export function buildRelease({ triple = hostTriple(), outDir = join(PACKAGE_ROOT, "dist") } = {}) {
  if (triple !== hostTriple()) {
    throw new Error(
      `cross triple ${triple} requested on ${hostTriple()}: install the rust target + linker for ${triple}, then re-run.`,
    );
  }
  assertNoBuildTargetOverride();
  console.error(`build-preparation: cargo build --locked --release (${triple})`);
  const built = cargoBuiltExecutable(["build", "--locked", "--release"]);
  hostProfileStage(built, targetDir());
  const stageDir = join(outDir, "preparation", triple);
  mkdirSync(stageDir, { recursive: true });
  const staged = join(stageDir, binaryName(triple));
  copyFileSync(built, staged);
  chmodSync(staged, 0o755);
  return stampSidecar(stageDir, binaryName(triple));
}

/**
 * Genuine local dev build + stamp (P09 local): `cargo build --locked`
 * (dev profile, caller resource flags via env) then a manifest
 * sidecar beside the dev binary, same shape/verification as release.
 * Re-run after every rebuild: the guard refuses stale bytes.
 */
export function buildDev() {
  assertNoBuildTargetOverride();
  console.error("build-preparation: cargo build --locked (dev, local stamp)");
  const built = cargoBuiltExecutable(["build", "--locked", "--bin", "can-preparation"]);
  // Stage the actual reported bytes (047), never a guessed dev path.
  const { stageDir, binary } = hostProfileStage(built, targetDir());
  return stampSidecar(stageDir, binary);
}

function main() {
  const argv = process.argv.slice(2);
  const tripleFlag = argv.indexOf("--triple");
  try {
    if (argv.includes("--dev")) {
      const { staged, sidecar } = buildDev();
      console.log(JSON.stringify({ ok: true, staged, sha256: sidecar.sha256 }));
      return;
    }
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
