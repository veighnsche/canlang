/**
 * Contained staging and publication adapter (P07.1): the only path by
 * which prepared outputs reach the filesystem.
 *
 * - Private temp roots: every session stages under a fresh `mkdtemp`
 *   root (custom roots validated: must exist, be a directory, and
 *   are used by realpath). Cleanup runs on every session exit
 *   (success or throw) via `dispose()` / `withPublicationSession`.
 * - Path validation: deployment-relative keys only — absolute forms
 *   (posix and win32 spellings), NUL bytes, backslashes, and
 *   `..`-after-normalize traversal all refuse loudly. Symlinks are
 *   never followed: any symlink in a target's parent chain, or a
 *   symlink at the target itself, refuses naming the offender.
 * - Reviewed bytes: `stage()` records exact byte lengths + sha256;
 *   `verifyReviewed()` re-checks staged bytes against the retained
 *   reviewed buffers before anything may publish.
 * - Preview policy: preview sessions may stage (private, verified,
 *   always cleaned up) but `publish()` throws — no deployment file
 *   publication, enforced in code, not convention.
 * - Honest partial writes: the confirmed writers are kept as-is
 *   (sequential, non-atomic — see below), so `publish()` reports
 *   exactly which files landed before a failure (`written` vs
 *   `pending`) instead of claiming atomicity.
 *
 * The current confirmed writers (`writeDeployBundle`, the plan/toml
 * sidecar writes) and the wrangler-apply / failed-apply /
 * manual-command policy in `host.ts` are unchanged: this adapter
 * validates, stages, verifies, and delegates the actual bytes.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";

export const PUBLICATION_TEMP_PREFIX = "can-prepare-";

/** One file to stage: deployment-relative key plus exact bytes. */
export interface StagedFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array | string;
}

/** Staged bytes with their recorded identity. */
export interface StagedRecord {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/** Reviewed buffer the staged bytes must equal, byte for byte. */
export interface ReviewedBuffer {
  readonly relativePath: string;
  readonly bytes: Uint8Array | string;
}

/** What `publish()` reports: full success or honest partial state. */
export interface PublicationResult {
  readonly written: string[];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toBytes(bytes: Uint8Array | string): Uint8Array {
  return typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
}

export class PublicationError extends Error {
  /** Files already on disk when the failure happened (may be partial). */
  readonly written: string[];
  /** Files never attempted (in publish order, after `written`). */
  readonly pending: string[];
  constructor(message: string, written: string[] = [], pending: string[] = []) {
    super(message);
    this.name = "PublicationError";
    this.written = written;
    this.pending = pending;
  }
}

/**
 * Validate a deployment-relative key. Refuses absolute forms (posix
 * `/…`, win32 `C:…`, UNC `\\…`), NUL bytes, backslashes (a posix-legal
 * name that would traverse on win32), and `..` escapes after
 * normalization. Returns the normalized posix-style key.
 */
export function validateRelativeKey(key: string): string {
  if (key.includes("\0")) {
    throw new PublicationError(`publication: refusing NUL byte in path ${JSON.stringify(key)}`);
  }
  if (key.includes("\\")) {
    throw new PublicationError(
      `publication: refusing backslash in deployment-relative path ${JSON.stringify(key)}`,
    );
  }
  if (
    key.startsWith("/") ||
    /^[A-Za-z]:/.test(key) ||
    key.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(key)
  ) {
    throw new PublicationError(
      `publication: refusing absolute path ${JSON.stringify(key)} (deployment-relative only)`,
    );
  }
  const normalized = normalize(key.split("/").join(sep));
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized === ".") {
    throw new PublicationError(
      `publication: refusing traversal outside the output root: ${JSON.stringify(key)}`,
    );
  }
  if (key === "" || normalized === "") {
    throw new PublicationError("publication: refusing empty relative path");
  }
  return normalized.split(sep).join("/");
}

/** Validate a staging root: must exist and be a directory; returns its realpath. */
export function resolveStagingRoot(root: string): string {
  let stat;
  try {
    stat = statSync(root);
  } catch {
    throw new PublicationError(`publication: staging root does not exist: ${JSON.stringify(root)}`);
  }
  if (!stat.isDirectory()) {
    throw new PublicationError(`publication: staging root is not a directory: ${JSON.stringify(root)}`);
  }
  return realpathSync(root);
}

/**
 * Refuse symlink escapes: every parent component of `absolutePath`
 * (below `containedRoot`, both realpathed) must not be a symlink,
 * and the target itself must not be a symlink. Pre-existing
 * non-symlink files/dirs are fine; missing components are fine (the
 * writer creates them).
 */
export function assertNoSymlinkEscape(
  containedRoot: string,
  absolutePath: string,
  label: string,
): void {
  const root = containedRoot.endsWith(sep) ? containedRoot : `${containedRoot}${sep}`;
  if (absolutePath !== containedRoot && !absolutePath.startsWith(root)) {
    throw new PublicationError(
      `publication: ${label} escapes the contained root: ${JSON.stringify(absolutePath)}`,
    );
  }
  // Walk from the root down to (and including) the target.
  let current = containedRoot;
  const chain = absolutePath.slice(root.length).split(sep).filter((part) => part !== "");
  for (const part of chain) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new PublicationError(
        `publication: refusing to write through symlink ${JSON.stringify(current)} (${label})`,
      );
    }
  }
}

/** Default confirmed writer: the current sequence (mkdir + write), unchanged. */
export function writeStagedFile(absolutePath: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes);
}

export type SessionMode = "preview" | "confirmed";

/**
 * One contained session: stage under a private root, verify against
 * reviewed bytes, publish (confirmed only), always clean up.
 */
export class PublicationSession {
  readonly mode: SessionMode;
  readonly root: string;
  private disposed = false;
  private ownsRoot: boolean;

  private constructor(mode: SessionMode, root: string, ownsRoot: boolean) {
    this.mode = mode;
    this.root = root;
    this.ownsRoot = ownsRoot;
  }

  /** Fresh private root under the OS temp dir. */
  static create(mode: SessionMode): PublicationSession {
    const root = realpathSync(mkdtempSync(join(tmpdir(), PUBLICATION_TEMP_PREFIX)));
    return new PublicationSession(mode, root, true);
  }

  /** Session over a caller-provided root (validated; caller-owned: never removed). */
  static overRoot(mode: SessionMode, root: string): PublicationSession {
    return new PublicationSession(mode, resolveStagingRoot(root), false);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new PublicationError("publication: session is disposed");
    }
  }

  /**
   * Stage files under the private root: validate keys, refuse
   * symlink escapes, write bytes, record exact lengths + hashes.
   */
  stage(files: StagedFile[]): StagedRecord[] {
    this.assertLive();
    const records: StagedRecord[] = [];
    for (const file of files) {
      const key = validateRelativeKey(file.relativePath);
      const absolutePath = join(this.root, key);
      assertNoSymlinkEscape(this.root, absolutePath, `stage ${JSON.stringify(key)}`);
      const bytes = toBytes(file.bytes);
      writeStagedFile(absolutePath, bytes);
      records.push({
        relativePath: key,
        absolutePath,
        byteLength: bytes.length,
        sha256: sha256Hex(bytes),
      });
    }
    return records;
  }

  /**
   * Re-check staged bytes against the retained reviewed buffers:
   * same keys, same byte lengths, same sha256. Any drift (caller
   * mutation, disk aliasing, partial staging) refuses loudly.
   */
  verifyReviewed(staged: StagedRecord[], reviewed: ReviewedBuffer[]): void {
    this.assertLive();
    const want = new Map(reviewed.map((entry) => [entry.relativePath, toBytes(entry.bytes)]));
    for (const record of staged) {
      const expected = want.get(record.relativePath);
      if (expected === undefined) {
        throw new PublicationError(
          `publication: staged file has no reviewed buffer: ${JSON.stringify(record.relativePath)}`,
        );
      }
      if (expected.length !== record.byteLength || sha256Hex(expected) !== record.sha256) {
        throw new PublicationError(
          `publication: staged bytes drifted from reviewed bytes: ${JSON.stringify(record.relativePath)} ` +
            `(staged ${record.byteLength} bytes sha256 ${record.sha256})`,
        );
      }
    }
  }

  /**
   * Publish staged records to `destDir` (confirmed sessions only).
   * Files land in order via `writer` (default: the current
   * mkdir+write sequence over re-read staged bytes); a failure
   * throws with honest `written` vs `pending` lists — partial
   * publication is reported, never hidden, and never claimed atomic.
   */
  publish(
    staged: StagedRecord[],
    destDir: string,
    writer: (absolutePath: string, bytes: Uint8Array) => void = writeStagedFile,
  ): PublicationResult {
    this.assertLive();
    if (this.mode === "preview") {
      throw new PublicationError(
        "publication: preview sessions never publish deployment files (stage + verify only)",
      );
    }
    mkdirSync(destDir, { recursive: true });
    const root = realpathSync(destDir);
    const written: string[] = [];
    const pending: string[] = staged.map((record) => record.relativePath);
    for (const record of staged) {
      const absolutePath = join(root, record.relativePath);
      try {
        assertNoSymlinkEscape(root, absolutePath, `publish ${JSON.stringify(record.relativePath)}`);
        writer(absolutePath, readStagedBytes(record.absolutePath));
      } catch (error) {
        throw new PublicationError(
          `publication: publish failed at ${JSON.stringify(record.relativePath)}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          written,
          pending.slice(written.length),
        );
      }
      written.push(record.relativePath);
    }
    return { written };
  }

  /** Remove an owned root (idempotent; caller-owned roots are never removed). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ownsRoot && existsSync(this.root)) {
      rmSync(this.root, { force: true, recursive: true });
    }
  }
}

function readStagedBytes(absolutePath: string): Uint8Array {
  // Staged bytes are re-read (not cached) so disk drift fails loudly
  // at publish time rather than shipping stale records.
  return readFileSync(absolutePath);
}

/**
 * Run `fn` with a fresh session, disposing on every exit (return or
 * throw). The honest cleanup primitive: callers never manage roots.
 */
export function withPublicationSession<T>(mode: SessionMode, fn: (session: PublicationSession) => T): T {
  const session = PublicationSession.create(mode);
  try {
    return fn(session);
  } finally {
    session.dispose();
  }
}
