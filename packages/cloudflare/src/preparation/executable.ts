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
    // Exact verified target (041): normalize the explicit path to an
    // absolute cwd-resolved path BEFORE verify/spawn. A bare name or
    // relative path must not verify one file (cwd lookup) while spawn
    // resolves another (PATH search).
    const exact = resolve(explicit);
    if (await isExecutableFile(exact)) return { path: exact, source: "env" };
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
  /**
   * Clear a still-pending escalation timer after verified group
   * death (048): a completed session must not own a pending future
   * group kill. No-op when nothing is pending.
   */
  cancelPendingKill: () => void;
}

/** True when any process of the child's group remains (signal 0 probes existence). */
function launchGroupAlive(pid: number | undefined): boolean {
  if (process.platform === "win32" || pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function settleSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // Ref'd: settlement must hold the loop (an unref'd sleep with no
    // other handles would let the CLI exit mid-cleanup).
    setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * Bounded child settlement (021/026/046A): signal the group, then
 * await the exit only up to `boundMs`. The direct exit alone is not
 * enough: a same-group grandchild ignoring SIGTERM (stdio
 * redirected, so `exited` already fired) would survive the CLI's
 * process.exit before the kill closure's delayed SIGKILL. When the
 * group remains alive, escalate to SIGKILL inside the same bound and
 * await group death. Already-dead groups cost nothing extra; a
 * stalled session never holds the CLI past the bound. Callers
 * fail/throw only after this returns. Never an unbounded close wait.
 */
export async function settleLaunchedChild(
  launched: LaunchedChild,
  exited: Promise<unknown>,
  boundMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, boundMs);
  launched.kill();
  // Cancellable deadline (048): a ref'd sleep holds the loop only
  // while actually awaited; the timer is cleared in `finally` when
  // the race — and the whole settlement — ends, so a fast exit
  // retains no timer until the bound.
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      exited.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        deadlineTimer = setTimeout(() => {
          deadlineTimer = null;
          resolve();
        }, Math.max(0, deadline - Date.now()));
      }),
    ]);
    const pid = launched.child.pid;
    if (!launchGroupAlive(pid)) return;
    // Brief TERM grace while the group is alive, then SIGKILL — all
    // inside the original bound. Polling sleeps stay ref'd only
    // while actually awaited (each iteration re-checks the group).
    const graceEnd = Math.min(deadline, Date.now() + 2_000);
    while (launchGroupAlive(pid) && Date.now() < graceEnd) {
      await settleSleep(50);
    }
    if (launchGroupAlive(pid)) {
      try {
        process.kill(-(pid as number), "SIGKILL");
      } catch {
        // Raced group death; the loop below observes it.
      }
      while (launchGroupAlive(pid) && Date.now() < deadline) {
        await settleSleep(50);
      }
    }
  } finally {
    // No pending timers or future group kills survive settlement:
    // the deadline timer is cleared here, and the kill escalation
    // timer is released once the group is verified dead (it already
    // fired — nulling its own handle — when escalation actually ran).
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    if (!launchGroupAlive(launched.child.pid)) launched.cancelPendingKill();
  }
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
  let escalationTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelPendingKill = (): void => {
    if (escalationTimer !== null) {
      clearTimeout(escalationTimer);
      escalationTimer = null;
    }
  };
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
    escalationTimer = setTimeout(() => {
      escalationTimer = null;
      signal("SIGKILL");
    }, 2000);
    escalationTimer.unref?.();
  };
  child.on("error", () => {
    // Spawn-time errors surface via driveSession/exit mapping, not here.
  });
  // Owned stdin error listener for the child's whole life (052): a
  // dead child (e.g. wrong-arch ELF) surfaces EPIPE here. Without an
  // owned listener it is an uncaught stream event (exit 1, no
  // envelope). This never leaves: removal before a late EPIPE could
  // fire would reintroduce the crash after the verdict. Writers still
  // check stream health and map failures to owned codes.
  child.stdin?.on("error", () => {
    // Observed via closed/exit mapping and write guards below.
  });
  return { child, kill, cancelPendingKill };
}
