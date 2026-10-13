/**
 * Full-run journal staging, commit, and recovery (BGI-04), plus read-gated
 * build snapshots.
 *
 * This module shares one on-disk protocol with the Rust
 * `compiler/src/leases.rs` host: identical journal schema, run layout, and
 * recovery semantics. Either host can recover a journal the other staged.
 *
 * Layout (relative to the project root):
 * - `.can/gen/runs/<run-id>/journal.json` — the one full-run journal.
 * - `.can/gen/runs/<run-id>/old/<unit-id>/<rel>` — complete prior set.
 * - `.can/gen/runs/<run-id>/new/<unit-id>/<rel>` — staged replacements.
 * - `.can/gen/previous/<unit-id>/<rel>` — one retained previous group.
 *
 * `stageJournal` copies every scope unit's complete current group into
 * `old/`, writes every replacement into `new/`, then atomically writes
 * `journal.json` with state `staged`. `markCommitted` flips the journal to
 * `committed`; `applyCommitted` replaces files atomically per file, retains
 * the staged old set in `.can/gen/previous/`, then resolves the journal to
 * `journal.resolved.json`. Recovery of a `staged` journal verifies the
 * untouched old set; recovery of a `committed` journal finishes the new
 * set. Unexpected bytes stop with `conflict.json` evidence and everything
 * retained. Repeated recovery is idempotent, and readers refuse while any
 * `journal.json` is unresolved, so builds never serve a mixed group.
 */

import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { GENERATED_DIR } from "./records.js";
import {
  PROTOCOL_VERSION,
  acquire,
  canonicalOrder,
  release,
  validateLeaseId,
  validateRel,
  type LeaseToken,
} from "./leases.js";

/** Unresolved-journal filename inside a run directory. */
export const JOURNAL_FILE = "journal.json";

/** Resolved-journal filename (evidence retained after recovery/apply). */
export const RESOLVED_JOURNAL_FILE = "journal.resolved.json";

/** Conflict-evidence filename written beside an unresolvable journal. */
export const CONFLICT_FILE = "conflict.json";

/** Complete prior set inside a run directory. */
export const OLD_DIR = "old";

/** Staged replacements inside a run directory. */
export const NEW_DIR = "new";

export const RUNS_DIR = ".can/gen/runs";
export const PREVIOUS_DIR = ".can/gen/previous";

export class JournalError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`generation-journal: ${detail}`);
    this.name = "JournalError";
    this.code = code;
  }
}

/** One staged file replacement inside a run journal. */
export interface JournalEntry {
  unit: string;
  path: string;
  old_sha256: string | null;
  staged: string;
  new_sha256: string;
}

export type JournalState = "staged" | "committed";

/** The one full-run journal. Shared JSON schema with the Rust host. */
export interface RunJournal {
  version: number;
  run_id: string;
  scope: string[];
  state: JournalState;
  entries: JournalEntry[];
}

/** One caller-supplied replacement for `stageJournal`. */
export interface Replacement {
  unit: string;
  path: string;
  bytes: Uint8Array;
}

/** One file whose current bytes match neither the staged old nor new hash. */
export interface ByteMismatch {
  unit: string;
  path: string;
  expected_sha256: string | null;
  observed_sha256: string | null;
}

/** Conflict evidence written to `conflict.json`. Shared with Rust. */
export interface ConflictReport {
  version: number;
  run_id: string;
  phase: string;
  mismatches: ByteMismatch[];
  retained: string[];
}

export type ApplyOutcome =
  | { kind: "applied"; files: number }
  | { kind: "conflict"; mismatches: ByteMismatch[]; conflictPath: string };

export type CommitOutcome =
  | { kind: "committed"; files: number }
  | { kind: "conflict"; mismatches: ByteMismatch[]; conflictPath: string };

export type RecoveryOutcome =
  | { kind: "restored-old" }
  | { kind: "completed-new"; files: number }
  | { kind: "already-resolved" }
  | { kind: "conflict"; mismatches: ByteMismatch[]; conflictPath: string };

/** One snapshotted build input: exact bytes plus their content hash. */
export interface ConsumedInput {
  path: string;
  bytes: Buffer;
  sha256: string;
}

function runDir(root: string, runId: string): string {
  return join(root, RUNS_DIR, runId);
}

function groupDir(root: string, unit: string): string {
  return join(root, GENERATED_DIR, unit);
}

function joinRel(base: string, rel: string): string {
  validateRel(rel);
  return join(base, ...rel.split("/"));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

let tmpCounter = 0;

/** Write bytes atomically: temporary sibling, fsync, rename. */
async function persistFile(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(
    dirname(path),
    `.tmp-${process.pid}-${(tmpCounter += 1)}`,
  );
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  try {
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // Best-effort directory fsync; ignored where unsupported.
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function currentSha256(path: string): Promise<string | null> {
  try {
    return sha256Hex(await readFile(path));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

async function listFilesRel(dir: string): Promise<string[]> {
  if (!(await exists(dir))) {
    return [];
  }
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const name of await readdir(current)) {
      const full = join(current, name);
      const info = await stat(full);
      if (info.isDirectory()) {
        await walk(full);
      } else if (info.isFile()) {
        out.push(relative(dir, full).split(sep).join("/"));
      }
    }
  }
  await walk(dir);
  return out.sort();
}

async function writeConflict(
  root: string,
  runId: string,
  phase: string,
  mismatches: ByteMismatch[],
): Promise<string> {
  const report: ConflictReport = {
    version: PROTOCOL_VERSION,
    run_id: runId,
    phase,
    mismatches,
    retained: [
      `${RUNS_DIR}/${runId}/${JOURNAL_FILE}`,
      `${RUNS_DIR}/${runId}/${OLD_DIR}/`,
      `${RUNS_DIR}/${runId}/${NEW_DIR}/`,
      GENERATED_DIR,
    ],
  };
  const path = join(runDir(root, runId), CONFLICT_FILE);
  await persistFile(path, Buffer.from(JSON.stringify(report, null, 2), "utf8"));
  return path;
}

async function resolveJournal(root: string, runId: string): Promise<void> {
  const dir = runDir(root, runId);
  await rename(join(dir, JOURNAL_FILE), join(dir, RESOLVED_JOURNAL_FILE));
}

function orderScope(scope: readonly string[]): string[] {
  const ordered = scope.map((unit) => {
    validateLeaseId("unit id", unit);
    return unit;
  });
  const deduped = [...new Set(ordered)].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (deduped.length === 0) {
    throw new JournalError("invalid-id", "journal scope must name at least one unit");
  }
  return deduped;
}

/**
 * Stage one full-run journal: copy every scope unit's complete current
 * group into `old/`, write every replacement into `new/`, then atomically
 * write `journal.json` with state `staged`. Staging never touches current
 * files; the caller holds the capture/accept write leases.
 */
export async function stageJournal(
  root: string,
  runId: string,
  scope: readonly string[],
  replacements: readonly Replacement[],
): Promise<RunJournal> {
  validateLeaseId("run id", runId);
  const orderedScope = orderScope(scope);
  const dir = runDir(root, runId);
  await mkdir(join(root, RUNS_DIR), { recursive: true });
  try {
    await mkdir(dir);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "EEXIST"
    ) {
      throw new JournalError(
        "already-staged",
        `run \`${runId}\` is already staged; recover it or use a fresh run id`,
      );
    }
    throw error;
  }
  for (const unit of orderedScope) {
    const group = groupDir(root, unit);
    const oldUnit = join(dir, OLD_DIR, unit);
    if (await exists(group)) {
      await cp(group, oldUnit, { recursive: true });
    } else {
      await mkdir(oldUnit, { recursive: true });
    }
  }
  const entries: JournalEntry[] = [];
  const seen = new Set<string>();
  for (const replacement of replacements) {
    validateLeaseId("unit id", replacement.unit);
    if (!orderedScope.includes(replacement.unit)) {
      throw new JournalError(
        "invalid-id",
        `replacement unit \`${replacement.unit}\` is outside the run scope`,
      );
    }
    validateRel(replacement.path);
    const key = `${replacement.unit}\0${replacement.path}`;
    if (seen.has(key)) {
      throw new JournalError(
        "invalid-path",
        `duplicate replacement for \`${replacement.path}\` in unit \`${replacement.unit}\``,
      );
    }
    seen.add(key);
    const current = join(groupDir(root, replacement.unit), ...replacement.path.split("/"));
    const oldSha256 = await currentSha256(current);
    const stagedRel = `${NEW_DIR}/${replacement.unit}/${replacement.path}`;
    await persistFile(joinRel(dir, stagedRel), replacement.bytes);
    entries.push({
      unit: replacement.unit,
      path: replacement.path,
      old_sha256: oldSha256,
      staged: stagedRel,
      new_sha256: sha256Hex(replacement.bytes),
    });
  }
  entries.sort((a, b) =>
    a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const journal: RunJournal = {
    version: PROTOCOL_VERSION,
    run_id: runId,
    scope: orderedScope,
    state: "staged",
    entries,
  };
  await persistFile(
    join(dir, JOURNAL_FILE),
    Buffer.from(JSON.stringify(journal, null, 2), "utf8"),
  );
  return journal;
}

/** Read a run's unresolved journal; fails when never staged or resolved. */
export async function readJournal(root: string, runId: string): Promise<RunJournal> {
  validateLeaseId("run id", runId);
  const path = join(runDir(root, runId), JOURNAL_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "ENOENT"
    ) {
      if (await exists(join(runDir(root, runId), RESOLVED_JOURNAL_FILE))) {
        throw new JournalError("already-resolved", `run \`${runId}\` is already resolved`);
      }
      throw new JournalError("no-journal", `run \`${runId}\` was never staged`);
    }
    throw error;
  }
  const journal = JSON.parse(text) as RunJournal;
  if (journal.version !== PROTOCOL_VERSION) {
    throw new JournalError("io", `journal version ${journal.version} is not supported`);
  }
  return journal;
}

/**
 * Flip a staged journal to committed, atomically. After this point
 * recovery finishes the whole new set; before it, recovery keeps the
 * whole old set.
 */
export async function markCommitted(root: string, runId: string): Promise<RunJournal> {
  const journal = await readJournal(root, runId);
  if (journal.state !== "staged") {
    throw new JournalError(
      "not-committed",
      `run \`${runId}\` is already committed; apply or recover it`,
    );
  }
  journal.state = "committed";
  await persistFile(
    join(runDir(root, runId), JOURNAL_FILE),
    Buffer.from(JSON.stringify(journal, null, 2), "utf8"),
  );
  return journal;
}

/**
 * Apply a committed journal: replace every entry's current file with its
 * staged bytes (atomic per-file rename), copy each scope unit's staged
 * complete old set into `.can/gen/previous/` wholesale, then resolve.
 * Entries already at their new hash are skipped, so apply is idempotent.
 * Unexpected bytes stop with a retained conflict.
 */
export async function applyCommitted(root: string, runId: string): Promise<ApplyOutcome> {
  const journal = await readJournal(root, runId);
  if (journal.state !== "committed") {
    throw new JournalError(
      "not-committed",
      `run \`${runId}\` is staged, not committed; recover it or mark it committed`,
    );
  }
  const dir = runDir(root, runId);
  for (const unit of journal.scope) {
    validateLeaseId("unit id", unit);
    const previousUnit = join(root, PREVIOUS_DIR, unit);
    await rm(previousUnit, { recursive: true, force: true });
    const stagedOld = join(dir, OLD_DIR, unit);
    if (await exists(stagedOld)) {
      await cp(stagedOld, previousUnit, { recursive: true });
    } else {
      await mkdir(previousUnit, { recursive: true });
    }
  }
  let files = 0;
  for (const entry of journal.entries) {
    const target = joinRel(groupDir(root, entry.unit), entry.path);
    const observed = await currentSha256(target);
    if (observed === entry.new_sha256) {
      files += 1;
      continue;
    }
    if (observed !== entry.old_sha256) {
      const mismatches: ByteMismatch[] = [
        {
          unit: entry.unit,
          path: entry.path,
          expected_sha256: entry.old_sha256,
          observed_sha256: observed,
        },
      ];
      const conflictPath = await writeConflict(root, runId, "apply", mismatches);
      return { kind: "conflict", mismatches, conflictPath };
    }
    const stagedBytes = await readFile(joinRel(dir, entry.staged));
    if (sha256Hex(stagedBytes) !== entry.new_sha256) {
      throw new JournalError(
        "io",
        `staged payload for \`${entry.path}\` in unit \`${entry.unit}\` no longer matches the journal`,
      );
    }
    const tmp = `${target}.can-new`;
    await persistFile(tmp, stagedBytes);
    await rename(tmp, target);
    files += 1;
  }
  await resolveJournal(root, runId);
  return { kind: "applied", files };
}

/** Dispatcher hook: flip a staged journal to committed, then apply it. */
export async function commitJournal(root: string, runId: string): Promise<CommitOutcome> {
  await markCommitted(root, runId);
  const applied = await applyCommitted(root, runId);
  if (applied.kind === "applied") {
    return { kind: "committed", files: applied.files };
  }
  return applied;
}

/**
 * Dispatcher hook: recover one run's journal, idempotently. A `staged`
 * journal verifies the untouched old set and resolves without writing;
 * anything else is a participating edit or foreign write, reported as a
 * retained conflict with current files untouched. A `committed` journal
 * finishes the whole new set. Resolved or unknown runs report
 * `already-resolved`.
 */
export async function recoverJournal(root: string, runId: string): Promise<RecoveryOutcome> {
  validateLeaseId("run id", runId);
  const dir = runDir(root, runId);
  if (!(await isFile(join(dir, JOURNAL_FILE)))) {
    if ((await exists(join(dir, RESOLVED_JOURNAL_FILE))) || !(await exists(dir))) {
      return { kind: "already-resolved" };
    }
    throw new JournalError("no-journal", `run \`${runId}\` has no journal file`);
  }
  const journal = await readJournal(root, runId);
  if (journal.state === "committed") {
    const applied = await applyCommitted(root, runId);
    if (applied.kind === "applied") {
      return { kind: "completed-new", files: applied.files };
    }
    return applied;
  }
  const mismatches: ByteMismatch[] = [];
  for (const entry of journal.entries) {
    const target = joinRel(groupDir(root, entry.unit), entry.path);
    const observed = await currentSha256(target);
    if (observed !== entry.old_sha256) {
      mismatches.push({
        unit: entry.unit,
        path: entry.path,
        expected_sha256: entry.old_sha256,
        observed_sha256: observed,
      });
    }
  }
  if (mismatches.length > 0) {
    const conflictPath = await writeConflict(root, runId, "recover", mismatches);
    return { kind: "conflict", mismatches, conflictPath };
  }
  await resolveJournal(root, runId);
  return { kind: "restored-old" };
}

/**
 * Run ids with an unresolved `journal.json`, in canonical order. Readers
 * refuse to serve any group while this list is non-empty.
 */
export async function unresolvedJournals(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(root, RUNS_DIR));
  } catch {
    return [];
  }
  const runs: string[] = [];
  for (const name of names) {
    if (await isFile(join(root, RUNS_DIR, name, JOURNAL_FILE))) {
      runs.push(name);
    }
  }
  return runs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Snapshot consumed build inputs under brief read leases: refuse when any
 * journal is unresolved, then acquire read leases in canonical order, copy
 * every byte, and release. The build compiles the returned immutable
 * snapshot, not live files.
 */
export async function snapshotInputs(
  root: string,
  holder: string,
  paths: readonly string[],
): Promise<ConsumedInput[]> {
  const unresolved = await unresolvedJournals(root);
  if (unresolved.length > 0) {
    throw new JournalError(
      "unresolved-journal",
      `refusing to read while run journal(s) ${unresolved.join(", ")} are unresolved`,
    );
  }
  const ordered = canonicalOrder(paths);
  const set = await acquire(root, paths, "read", holder);
  const inputs: ConsumedInput[] = [];
  try {
    for (const rel of ordered) {
      let bytes: Buffer;
      try {
        bytes = await readFile(joinRel(root, rel));
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code: unknown }).code === "ENOENT"
        ) {
          throw new JournalError("invalid-path", `consumed input \`${rel}\` does not exist`);
        }
        throw error;
      }
      inputs.push({ path: rel, bytes, sha256: sha256Hex(bytes) });
    }
  } finally {
    await release(root, set);
  }
  return inputs;
}

/** List a scope unit's current group files (unit-relative, canonical order). */
export async function groupFiles(root: string, unit: string): Promise<string[]> {
  validateLeaseId("unit id", unit);
  return listFilesRel(groupDir(root, unit));
}

export type { LeaseToken };
