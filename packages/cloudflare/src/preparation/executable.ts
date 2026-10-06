/**
 * Native executable resolution + launch (P03.4): locate the
 * `can-preparation` binary for this host, spawn it with a piped
 * empty argv (never a shell string), and map lifecycle outcomes.
 *
 * Resolution order: `CAN_PREPARATION_BIN` explicit path, then the
 * packaged `dist/preparation/<triple>/` binary (P09.1 layout), then
 * the dev `preparation/target/debug/` binary. The packaged triple
 * is `<platform>-<arch>[-<libc>]` with `.exe` on Windows.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PREPARATION_BINARY = "can-preparation";
export const PREPARATION_BIN_ENV = "CAN_PREPARATION_BIN";

export class NativeLaunchError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`native-launch: ${detail}`);
    this.name = "NativeLaunchError";
    this.code = code;
  }
}

/** Package root from this module (`src/` in tests, `dist/` built). */
export function packageRootDir(): string {
  // src/preparation/executable.ts -> package root; dist layout mirrors src.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Packaged triple for the current host. Linux distinguishes glibc
 * vs musl (read from `ldd --version` at verify time, not here: this
 * pure mapping takes libc as an input so tests pin every triple).
 */
export function packagedTriple(host: {
  platform: string;
  arch: string;
  libc?: string | undefined;
}): string {
  const plat = host.platform === "win32" ? "windows" : host.platform;
  if (plat === "linux") return `${plat}-${host.arch}-${host.libc ?? "gnu"}`;
  return `${plat}-${host.arch}`;
}

/** Packaged binary path for an explicit triple (P09.1 layout). */
export function packagedBinaryPath(packageRoot: string, triple: string): string {
  const exe = triple.startsWith("windows-") ? `${PREPARATION_BINARY}.exe` : PREPARATION_BINARY;
  return join(packageRoot, "dist", "preparation", triple, exe);
}

/** Dev binary path (local `cargo build` output, never packaged). */
export function devBinaryPath(packageRoot: string): string {
  return join(packageRoot, "preparation", "target", "debug", PREPARATION_BINARY);
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface BinaryResolution {
  path: string;
  source: "env" | "packaged" | "dev";
}

/**
 * Resolve the binary: explicit env path first, then the packaged
 * triple for this host, then the dev build. Throws
 * `native-unavailable` (with every location probed) when nothing
 * launches — never a silent TS fallback here; selection owns that.
 */
export async function resolvePreparationBinary(options?: {
  packageRoot?: string;
  libc?: string;
}): Promise<BinaryResolution> {
  const root = options?.packageRoot ?? packageRootDir();
  const probed: string[] = [];
  const explicit = process.env[PREPARATION_BIN_ENV];
  if (explicit !== undefined && explicit !== "") {
    if (await isExecutableFile(explicit)) return { path: explicit, source: "env" };
    probed.push(`${explicit} (${PREPARATION_BIN_ENV}, not executable)`);
  }
  const triple = packagedTriple({ platform: platform(), arch: arch(), libc: options?.libc });
  const packaged = packagedBinaryPath(root, triple);
  if (await isExecutableFile(packaged)) return { path: packaged, source: "packaged" };
  probed.push(`${packaged} (packaged ${triple})`);
  const dev = devBinaryPath(root);
  if (await isExecutableFile(dev)) return { path: dev, source: "dev" };
  probed.push(`${dev} (dev build)`);
  throw new NativeLaunchError(
    "native-unavailable",
    `no launchable ${PREPARATION_BINARY}; probed: ${probed.join("; ")}. ` +
      `Build the dev binary (cargo build --locked in packages/cloudflare/preparation) ` +
      `or install a packaged release (P09.1).`,
  );
}

export interface LaunchedChild {
  child: ChildProcess;
  /** Kill the whole session (SIGKILL after a SIGTERM grace). */
  kill: () => void;
}

/**
 * Spawn the binary with piped stdio and an empty argv. Never a shell
 * string. ENOENT/spawn failure maps to `native-unavailable`.
 */
export function launchPreparation(binaryPath: string): LaunchedChild {
  let child: ChildProcess;
  try {
    // Detached on POSIX so kill() reaches the whole process group:
    // a tampered binary may orphan grandchildren holding stdio open.
    child = spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  } catch (error) {
    throw new NativeLaunchError(
      "native-unavailable",
      `spawn failed for ${binaryPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let killed = false;
  const kill = (): void => {
    if (killed) return;
    killed = true;
    const signal = (sig: "SIGTERM" | "SIGKILL"): void => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) {
          process.kill(-child.pid, sig);
        } else {
          child.kill(sig);
        }
      } catch {
        // Already gone; fall back to the direct handle once.
        try {
          child.kill(sig);
        } catch {
          // Gone.
        }
      }
    };
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), 2000).unref?.();
  };
  child.on("error", () => {
    // Spawn-time errors surface via driveSession/exit mapping, not here.
  });
  return { child, kill };
}
