/**
 * Cooperative write leases (BGI-04): canonical lock order, token-checked
 * read/write lock files, and explicit stopped-writer recovery.
 *
 * This module shares one on-disk protocol with the Rust
 * `compiler/src/leases.rs` host: identical lock-file layout, token format,
 * escaping, and JSON shapes. Either host's leases block the other's.
 *
 * Layout (relative to the project root):
 * - `.can/gen/locks/<escaped>.write.lock` — one exclusive write lease.
 * - `.can/gen/locks/<escaped>.read.<token>.lock` — one shared read lease
 *   per holder; any number may coexist while no write lease exists.
 *
 * Every acquisition sorts its paths byte-wise and takes them in ascending
 * order, releasing in reverse, so cooperative writers cannot deadlock.
 * Leases never expire and are never stolen: `recoverStoppedWriter` removes
 * one confirmed-stopped holder's locks only. This protocol is cooperative
 * file coordination, never filesystem compare-and-swap.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Protocol version written into every lock file and journal. */
export const PROTOCOL_VERSION = 1;

/** Ignored tooling root for locks, runs and retained groups. */
export const TOOL_DIR = ".can/gen";

/** Directory holding lock files. */
export const LOCKS_DIR = ".can/gen/locks";

/** Directory holding one subdirectory per promotion run. */
export const RUNS_DIR = ".can/gen/runs";

/** Directory holding one retained previous group per unit. */
export const PREVIOUS_DIR = ".can/gen/previous";

export type LeaseMode = "read" | "write";

export class LeaseError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`generation-lease: ${detail}`);
    this.name = "LeaseError";
    this.code = code;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

/**
 * Validate a root-relative path: `/`-separated, no leading slash, no
 * empty, `.` or `..` segments, no backslashes. Shared with the Rust host.
 */
export function validateRel(path: string): void {
  if (path.length === 0) {
    throw new LeaseError("invalid-path", "path must not be empty");
  }
  if (path.startsWith("/") || path.includes("\\")) {
    throw new LeaseError(
      "invalid-path",
      `path \`${path}\` must be root-relative with \`/\` separators`,
    );
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new LeaseError(
        "invalid-path",
        `path \`${path}\` must not contain empty, \`.\` or \`..\` segments`,
      );
    }
  }
}

/**
 * Validate a run or unit ID with the BGI-02 rule: non-empty, no path
 * separators or whitespace, never `.`/`..`. Shared with the Rust host.
 */
export function validateLeaseId(kind: "run id" | "unit id", id: string): void {
  if (id.length === 0) {
    throw new LeaseError("invalid-id", `${kind} must not be empty`);
  }
  if (id === "." || id === ".." || id.includes("/") || id.includes("\\")) {
    throw new LeaseError("invalid-id", `${kind} \`${id}\` must not name a path`);
  }
  if (/[\s\x00-\x1f\x7f]/.test(id)) {
    throw new LeaseError("invalid-id", `${kind} \`${id}\` must not contain whitespace`);
  }
}

/**
 * Escape a validated relative path into one lock-file stem: every byte
 * outside `[A-Za-z0-9._-]` becomes `%XX` (uppercase hex). Both hosts must
 * produce identical stems; see the cross-host vector in the tests.
 */
export function escapeRel(path: string): string {
  let out = "";
  for (const byte of Buffer.from(path, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9._-]/.test(ch)) {
      out += ch;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * Canonical lock order: validated paths sorted byte-wise ascending.
 * Acquire in this order; release in reverse.
 */
export function canonicalOrder(paths: readonly string[]): string[] {
  for (const path of paths) {
    validateRel(path);
  }
  return [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A lease token: `v1-` plus 16 lowercase hex digits. */
export type LeaseToken = string;

/** Parse and strictly validate a token spelling. */
export function parseToken(text: string): LeaseToken {
  if (!/^v1-[0-9a-f]{16}$/.test(text)) {
    throw new LeaseError(
      "invalid-token",
      `token \`${text}\` must be \`v1-\` plus 16 lowercase hex digits`,
    );
  }
  return text;
}

/** Mint a fresh token from random bytes; the spelling carries no meaning. */
export function newToken(): LeaseToken {
  return `v1-${randomBytes(8).toString("hex")}`;
}

/** One lock acquisition over canonical-order paths, held under one token. */
export interface LeaseSet {
  holder: string;
  token: LeaseToken;
  mode: LeaseMode;
  paths: string[];
}

interface LockFile {
  version: number;
  holder: string;
  token: string;
  mode: string;
  path: string;
}

function locksDir(root: string): string {
  return join(root, LOCKS_DIR);
}

function writeLockPath(root: string, rel: string): string {
  return join(locksDir(root), `${escapeRel(rel)}.write.lock`);
}

function readLockPath(root: string, rel: string, token: LeaseToken): string {
  return join(locksDir(root), `${escapeRel(rel)}.read.${token}.lock`);
}

async function presentReadLocks(root: string, rel: string): Promise<string[]> {
  const prefix = `${escapeRel(rel)}.read.`;
  let names: string[];
  try {
    names = await readdir(locksDir(root));
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".lock"))
    .sort()
    .map((name) => join(locksDir(root), name));
}

async function lockExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function releasePaths(
  root: string,
  held: readonly string[],
  mode: LeaseMode,
  token: LeaseToken,
): Promise<void> {
  for (const rel of [...held].reverse()) {
    const lockPath =
      mode === "write" ? writeLockPath(root, rel) : readLockPath(root, rel, token);
    await rm(lockPath, { force: true });
  }
}

/**
 * Acquire `mode` over `paths` for `holder`, in canonical lock order.
 *
 * A write acquisition conflicts with any present write or read lock on the
 * same path; a read acquisition conflicts only with a present write lock.
 * On conflict this releases any prefix already taken and reports the
 * conflicting path.
 *
 * Admission is one shared atomic step per path: our mode lock is created
 * exclusively, then re-checked for a conflicting lock before the path
 * counts as held. A racing incompatible lease created its own
 * different-named file; whoever observes the other backs off by removing
 * its just-created lock, so incompatible exact-path leases can never both
 * be admitted. Exact simultaneity reports `conflict` on both sides and
 * cooperative callers retry. Read-sharing, exact ownership/tokens, and
 * stopped-writer recovery are unchanged: this arbitrates cooperative
 * writers only, never filesystem CAS.
 */
export async function acquire(
  root: string,
  paths: readonly string[],
  mode: LeaseMode,
  holder: string,
): Promise<LeaseSet> {
  const ordered = canonicalOrder(paths);
  if (holder.length === 0) {
    throw new LeaseError("invalid-id", "holder must not be empty");
  }
  await mkdir(locksDir(root), { recursive: true });
  const token = newToken();
  const held: string[] = [];
  for (const rel of ordered) {
    if (await lockExists(writeLockPath(root, rel))) {
      await releasePaths(root, held, mode, token);
      throw new LeaseError(
        "conflict",
        `${mode} lease on \`${rel}\` conflicts with a held write lease`,
      );
    }
    if (mode === "write" && (await presentReadLocks(root, rel)).length > 0) {
      await releasePaths(root, held, mode, token);
      throw new LeaseError(
        "conflict",
        `write lease on \`${rel}\` conflicts with a held read lease`,
      );
    }
    const body: LockFile = {
      version: PROTOCOL_VERSION,
      holder,
      token,
      mode,
      path: rel,
    };
    const lockPath =
      mode === "write" ? writeLockPath(root, rel) : readLockPath(root, rel, token);
    try {
      await writeFile(lockPath, JSON.stringify(body), { flag: "wx" });
    } catch (error) {
      await releasePaths(root, held, mode, token);
      if (isErrno(error, "EEXIST")) {
        throw new LeaseError(
          "conflict",
          `${mode} lease on \`${rel}\` lost a racing acquisition`,
        );
      }
      throw error;
    }
    // Admission arbitration: a racing incompatible lease passed its own
    // pre-check and created a different-named file. Whoever observes the
    // other removes its just-created lock and reports conflict.
    const raced =
      mode === "read"
        ? await lockExists(writeLockPath(root, rel))
        : (await presentReadLocks(root, rel)).length > 0;
    if (raced) {
      await rm(lockPath, { force: true });
      await releasePaths(root, held, mode, token);
      throw new LeaseError(
        "conflict",
        `${mode} lease on \`${rel}\` lost a racing acquisition`,
      );
    }
    held.push(rel);
  }
  return { holder, token, mode, paths: ordered };
}

/**
 * Release every path in `set`, in reverse canonical order. Each lock file
 * must still carry the set's token; a mismatch reports `stale-token` and
 * leaves the foreign lock untouched. Vanished locks count as released.
 */
export async function release(root: string, set: LeaseSet): Promise<void> {
  for (const rel of [...set.paths].reverse()) {
    const lockPath =
      set.mode === "write"
        ? writeLockPath(root, rel)
        : readLockPath(root, rel, set.token);
    let text: string;
    try {
      text = await readFile(lockPath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    const body = JSON.parse(text) as LockFile;
    if (body.token !== set.token) {
      throw new LeaseError(
        "stale-token",
        `lock on \`${rel}\` now belongs to token \`${body.token}\`; refusing to steal it`,
      );
    }
    await rm(lockPath, { force: true });
  }
}

/**
 * Explicit stopped-writer lease recovery: remove the lock files belonging
 * to (`holder`, `token`) and return their paths in canonical order.
 * Requires explicit confirmation; only that holder's locks are removed.
 */
export async function recoverStoppedWriter(
  root: string,
  holder: string,
  token: LeaseToken,
  confirmedStopped: boolean,
): Promise<string[]> {
  if (!confirmedStopped) {
    throw new LeaseError(
      "not-confirmed",
      "lease recovery requires confirmation that the writer has stopped; leases never expire",
    );
  }
  parseToken(token);
  let names: string[];
  try {
    names = await readdir(locksDir(root));
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  const recovered: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".lock")) {
      continue;
    }
    const lockPath = join(locksDir(root), name);
    let body: LockFile;
    try {
      body = JSON.parse(await readFile(lockPath, "utf8")) as LockFile;
    } catch {
      continue;
    }
    if (body.holder === holder && body.token === token) {
      validateRel(body.path);
      await rm(lockPath, { force: true });
      recovered.push(body.path);
    }
  }
  return [...new Set(recovered)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Qualified durability statement; mirrors the Rust host. Never claims CAS. */
export function platformDurability(): string {
  if (process.platform === "linux" || process.platform === "darwin") {
    return "POSIX atomic rename with file fsync before rename and best-effort directory fsync (qualified on Linux/macOS); cooperative replacement only, not filesystem CAS";
  }
  return "rename-based replacement is best-effort on this platform and failures diagnose; cooperative replacement only, not filesystem CAS";
}
