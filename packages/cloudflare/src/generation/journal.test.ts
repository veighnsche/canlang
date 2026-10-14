/**
 * BGI-04 journal tests: full-run staging, commit, and recovery plus
 * read-gated snapshots. Mirrors the Rust `bgi04_leases` journal coverage
 * so both hosts enforce the same protocol: whole old/new groups across
 * the commit boundary, retained conflict material, idempotent recovery,
 * one previous group, and readers that refuse unresolved journals.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs, {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyCommitted,
  commitJournal,
  groupFiles,
  markCommitted,
  readJournal,
  recoverJournal,
  snapshotInputs,
  stageJournal,
  unresolvedJournals,
  JournalError,
  type Replacement,
} from "./journal.js";
import { acquire, release, recoverStoppedWriter, LeaseError } from "./leases.js";

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "can-bgi04-journal-"));
}

async function writeTree(root: string, files: Array<[string, string]>): Promise<void> {
  for (const [rel, text] of files) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text);
  }
}

async function readTree(root: string, rel: string): Promise<string> {
  return readFile(join(root, rel), "utf8");
}

function replacement(unit: string, path: string, text: string): Replacement {
  return { unit, path, bytes: Buffer.from(text, "utf8") };
}

async function journalErrorOf(promise: Promise<unknown>): Promise<JournalError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof JournalError);
    return error;
  }
  assert.fail("expected a JournalError");
}

/** Path/ID validation throws the shared LeaseError codes from leases.ts. */
async function validationErrorOf(promise: Promise<unknown>): Promise<{ code: string }> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof JournalError || error instanceof LeaseError);
    return error as { code: string };
  }
  assert.fail("expected a validation error");
}

async function leaseErrorOf(promise: Promise<unknown>): Promise<LeaseError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof LeaseError);
    return error;
  }
  assert.fail("expected a LeaseError");
}

test("interruption before commit restores the whole old group", async () => {
  const root = await freshRoot();
  await writeTree(root, [
    ["can.generated/u1/style.css", ".old{}"],
    ["can.generated/u1/unit.json", '{"id":"u1"}'],
    ["can.generated/u2/server.js", "old();"],
  ]);
  const journal = await stageJournal(
    root,
    "r1",
    ["u1", "u2"],
    [
      replacement("u1", "style.css", ".new{}"),
      replacement("u2", "server.js", "new();"),
      replacement("u1", "extra.css", ".added{}"),
    ],
  );
  assert.equal(journal.state, "staged");
  assert.deepEqual(journal.scope, ["u1", "u2"]);
  assert.equal(journal.entries.length, 3);
  assert.equal(await readTree(root, "can.generated/u1/style.css"), ".old{}");
  assert.equal(await readTree(root, ".can/gen/runs/r1/old/u1/unit.json"), '{"id":"u1"}');
  assert.equal(await readTree(root, ".can/gen/runs/r1/new/u1/style.css"), ".new{}");
  assert.deepEqual(await unresolvedJournals(root), ["r1"]);
  assert.deepEqual(await recoverJournal(root, "r1"), { kind: "restored-old" });
  assert.deepEqual(await unresolvedJournals(root), []);
  assert.equal(await readTree(root, "can.generated/u1/style.css"), ".old{}");
  assert.equal(await readTree(root, "can.generated/u2/server.js"), "old();");
  const snapshot = await snapshotInputs(root, "build", ["can.generated/u1/style.css"]);
  assert.equal(snapshot[0]?.bytes.toString("utf8"), ".old{}");
});

test("interruption after commit finishes the whole new group", async () => {
  const root = await freshRoot();
  await writeTree(root, [
    ["can.generated/u1/style.css", ".old{}"],
    ["can.generated/u2/server.js", "old();"],
  ]);
  await stageJournal(
    root,
    "r2",
    ["u1", "u2"],
    [replacement("u1", "style.css", ".new{}"), replacement("u2", "server.js", "new();")],
  );
  assert.equal((await readJournal(root, "r2")).state, "staged");
  await markCommitted(root, "r2");
  assert.equal((await readJournal(root, "r2")).state, "committed");
  assert.equal(await readTree(root, "can.generated/u1/style.css"), ".old{}");
  assert.deepEqual(await recoverJournal(root, "r2"), { kind: "completed-new", files: 2 });
  assert.deepEqual(await unresolvedJournals(root), []);
  assert.equal(await readTree(root, "can.generated/u1/style.css"), ".new{}");
  assert.equal(await readTree(root, "can.generated/u2/server.js"), "new();");
  assert.equal(await readTree(root, ".can/gen/previous/u1/style.css"), ".old{}");
  assert.equal(await readTree(root, ".can/gen/previous/u2/server.js"), "old();");
});

test("commit applies all and retains one previous group", async () => {
  const root = await freshRoot();
  await writeTree(root, [
    ["can.generated/u1/style.css", ".old{}"],
    ["can.generated/u1/unit.json", '{"id":"u1"}'],
  ]);
  await stageJournal(root, "r3", ["u1"], [replacement("u1", "style.css", ".new{}")]);
  assert.deepEqual(await commitJournal(root, "r3"), { kind: "committed", files: 1 });
  assert.equal(await readTree(root, "can.generated/u1/style.css"), ".new{}");
  assert.equal(await readTree(root, "can.generated/u1/unit.json"), '{"id":"u1"}');
  assert.equal(await readTree(root, ".can/gen/previous/u1/style.css"), ".old{}");
  assert.equal(await readTree(root, ".can/gen/previous/u1/unit.json"), '{"id":"u1"}');
  await stageJournal(root, "r4", ["u1"], [replacement("u1", "style.css", ".newer{}")]);
  await commitJournal(root, "r4");
  assert.equal(await readTree(root, "can.generated/u1/style.css"), ".newer{}");
  assert.equal(await readTree(root, ".can/gen/previous/u1/style.css"), ".new{}");
  await stageJournal(root, "r5", ["u1"], [replacement("u1", "style.css", ".x{}")]);
  const early = await journalErrorOf(applyCommitted(root, "r5"));
  assert.equal(early.code, "not-committed");
  const restage = await journalErrorOf(stageJournal(root, "r5", ["u1"], []));
  assert.equal(restage.code, "already-staged");
});

test("unexpected bytes retain conflict material", async () => {
  const root = await freshRoot();
  await writeTree(root, [
    ["can.generated/u1/a.css", ".a-old{}"],
    ["can.generated/u1/b.css", ".b-old{}"],
  ]);
  await stageJournal(
    root,
    "r6",
    ["u1"],
    [replacement("u1", "a.css", ".a-new{}"), replacement("u1", "b.css", ".b-new{}")],
  );
  await markCommitted(root, "r6");
  await writeTree(root, [["can.generated/u1/b.css", ".b-foreign{}"]]);
  const outcome = await recoverJournal(root, "r6");
  assert.equal(outcome.kind, "conflict");
  if (outcome.kind !== "conflict") {
    assert.fail("expected a conflict outcome");
  }
  assert.equal(outcome.mismatches.length, 1);
  assert.equal(outcome.mismatches[0]?.path, "b.css");
  assert.equal(await readTree(root, "can.generated/u1/a.css"), ".a-new{}");
  assert.equal(await readTree(root, "can.generated/u1/b.css"), ".b-foreign{}");
  assert.equal(await readTree(root, ".can/gen/runs/r6/new/u1/b.css"), ".b-new{}");
  assert.equal(await readTree(root, ".can/gen/runs/r6/old/u1/b.css"), ".b-old{}");
  assert.deepEqual(await unresolvedJournals(root), ["r6"]);
  const report = JSON.parse(await readFile(outcome.conflictPath, "utf8")) as {
    phase: string;
    retained: string[];
  };
  assert.equal(report.phase, "apply");
  assert.ok(report.retained.length > 0);
  await writeTree(root, [["can.generated/u1/b.css", ".b-old{}"]]);
  assert.deepEqual(await recoverJournal(root, "r6"), { kind: "completed-new", files: 2 });
  assert.equal(await readTree(root, "can.generated/u1/b.css"), ".b-new{}");
});

test("staged recovery never overwrites participating work", async () => {
  const root = await freshRoot();
  await writeTree(root, [["can.generated/u1/style.css", ".old{}"]]);
  await stageJournal(root, "r7", ["u1"], [replacement("u1", "style.css", ".new{}")]);
  await writeTree(root, [["can.generated/u1/style.css", ".participating{}"]]);
  const outcome = await recoverJournal(root, "r7");
  assert.equal(outcome.kind, "conflict");
  assert.equal(await readTree(root, "can.generated/u1/style.css"), ".participating{}");
  assert.deepEqual(await unresolvedJournals(root), ["r7"]);
});

test("unresolved journals never serve a mixed group", async () => {
  const root = await freshRoot();
  await writeTree(root, [
    ["can.generated/u1/style.css", ".old{}"],
    ["can.generated/u2/server.js", "old();"],
  ]);
  await stageJournal(
    root,
    "r8",
    ["u1", "u2"],
    [replacement("u1", "style.css", ".new{}"), replacement("u2", "server.js", "new();")],
  );
  await markCommitted(root, "r8");
  const refused = await journalErrorOf(
    snapshotInputs(root, "build", ["can.generated/u1/style.css"]),
  );
  assert.equal(refused.code, "unresolved-journal");
  assert.ok(refused.message.includes("r8"), refused.message);
  await recoverJournal(root, "r8");
  const snapshot = await snapshotInputs(root, "build", [
    "can.generated/u1/style.css",
    "can.generated/u2/server.js",
  ]);
  assert.equal(snapshot[0]?.bytes.toString("utf8"), ".new{}");
  assert.equal(snapshot[1]?.bytes.toString("utf8"), "new();");
  // Later live edits cannot change the consumed closure.
  await writeTree(root, [["can.generated/u1/style.css", ".edited{}"]]);
  assert.equal(snapshot[0]?.bytes.toString("utf8"), ".new{}");
  assert.deepEqual(await groupFiles(root, "u1"), ["style.css"]);
});

test("repeated recovery is idempotent", async () => {
  const root = await freshRoot();
  await writeTree(root, [["can.generated/u1/style.css", ".old{}"]]);
  await stageJournal(root, "r9", ["u1"], [replacement("u1", "style.css", ".new{}")]);
  assert.deepEqual(await recoverJournal(root, "r9"), { kind: "restored-old" });
  assert.deepEqual(await recoverJournal(root, "r9"), { kind: "already-resolved" });
  await stageJournal(root, "r10", ["u1"], [replacement("u1", "style.css", ".new{}")]);
  await markCommitted(root, "r10");
  assert.deepEqual(await recoverJournal(root, "r10"), { kind: "completed-new", files: 1 });
  assert.deepEqual(await recoverJournal(root, "r10"), { kind: "already-resolved" });
  assert.equal(await readTree(root, "can.generated/u1/style.css"), ".new{}");
  assert.deepEqual(await recoverJournal(root, "r-missing"), { kind: "already-resolved" });
});

test("the read gate runs while leases cover the consumed closure", async () => {
  const root = await freshRoot();
  await writeTree(root, [["can.generated/u1/a.css", "a-old"]]);
  const writer = await acquire(root, ["can.generated/u1/a.css"], "write", "accept");
  await stageJournal(root, "rg", ["u1"], [replacement("u1", "a.css", "a-new")]);
  // Acquisition runs before the gate: the held write lease reports conflict.
  const blocked = await leaseErrorOf(
    snapshotInputs(root, "build", ["can.generated/u1/a.css"]),
  );
  assert.equal(blocked.code, "conflict");
  await release(root, writer);
  const refused = await journalErrorOf(
    snapshotInputs(root, "build", ["can.generated/u1/a.css"]),
  );
  assert.equal(refused.code, "unresolved-journal");
});

test("a reader stalled before acquiring never serves a mixed snapshot", async () => {
  // The reader stalls inside acquisition; the writer commits the first entry
  // and stops with its leases recovered. The resumed read must refuse the
  // unresolved journal instead of returning [a-new, b-old].
  const root = await freshRoot();
  const paths = ["can.generated/u1/a.css", "can.generated/u2/b.css"];
  await writeTree(root, [
    [paths[0] as string, "a-old"],
    [paths[1] as string, "b-old"],
  ]);
  const mutable = fs as unknown as { mkdir: typeof mkdir; rename: typeof rename };
  const realMkdir = fs.mkdir;
  const realRename = fs.rename;
  let entered!: () => void;
  const enteredP = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const resumeP = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let pause = true;
  mutable.mkdir = (async (path: Parameters<typeof mkdir>[0], ...args: unknown[]) => {
    if (pause && String(path) === join(root, ".can/gen/locks")) {
      pause = false;
      entered();
      await resumeP;
    }
    return Reflect.apply(realMkdir, fs, [path, ...args]) as ReturnType<typeof mkdir>;
  }) as typeof mkdir;
  syncBuiltinESMExports();
  try {
    const reading = snapshotInputs(root, "build", paths);
    await enteredP;
    const writer = await acquire(root, paths, "write", "accept");
    await stageJournal(root, "r", ["u1", "u2"], [
      replacement("u1", "a.css", "a-new"),
      replacement("u2", "b.css", "b-new"),
    ]);
    await markCommitted(root, "r");
    let crashed = false;
    mutable.rename = (async (...args: unknown[]) => {
      await Reflect.apply(realRename, fs, args);
      if (String(args[1]) === join(root, paths[0] as string) && !crashed) {
        crashed = true;
        throw new Error("simulated stop immediately after first target rename");
      }
    }) as typeof rename;
    syncBuiltinESMExports();
    let interruption = "";
    try {
      await applyCommitted(root, "r");
    } catch (error) {
      interruption = (error as Error).message;
    }
    assert.match(interruption, /simulated stop/);
    mutable.rename = realRename;
    syncBuiltinESMExports();
    await recoverStoppedWriter(root, writer.holder, writer.token, true);
    resume();
    const refused = await journalErrorOf(reading);
    assert.equal(refused.code, "unresolved-journal");
    assert.deepEqual(await unresolvedJournals(root), ["r"]);
    // Whole-set recovery finishes the new group; then reads serve all-new.
    assert.deepEqual(await recoverJournal(root, "r"), { kind: "completed-new", files: 2 });
    const snapshot = await snapshotInputs(root, "build", paths);
    assert.deepEqual(
      snapshot.map((input) => input.bytes.toString()),
      ["a-new", "b-new"],
    );
  } finally {
    mutable.mkdir = realMkdir;
    mutable.rename = realRename;
    syncBuiltinESMExports();
  }
});

test("replacement temp never touches an unrequested sibling", async () => {
  const root = await freshRoot();
  await writeTree(root, [
    ["can.generated/u1/a.css", "a-old"],
    ["can.generated/u1/a.css.can-new", "saved-helper"],
  ]);
  const held = await acquire(
    root,
    ["can.generated/u1/a.css", "can.generated/u1/a.css.can-new"],
    "write",
    "accept",
  );
  await stageJournal(root, "r", ["u1"], [replacement("u1", "a.css", "a-new")]);
  assert.deepEqual(await commitJournal(root, "r"), { kind: "committed", files: 1 });
  assert.equal(await readTree(root, "can.generated/u1/a.css"), "a-new");
  assert.equal(await readTree(root, "can.generated/u1/a.css.can-new"), "saved-helper");
  assert.deepEqual(await groupFiles(root, "u1"), ["a.css", "a.css.can-new"]);
  assert.equal(await readTree(root, ".can/gen/previous/u1/a.css.can-new"), "saved-helper");
  await release(root, held);
});

test("journal scope and replacements are validated", async () => {
  const root = await freshRoot();
  await writeTree(root, [["can.generated/u1/style.css", ".old{}"]]);
  await validationErrorOf(stageJournal(root, "rv", [], []));
  await validationErrorOf(stageJournal(root, "rv", ["u1"], [replacement("u2", "x", "y")]));
  await validationErrorOf(
    stageJournal(root, "rv", ["u1"], [
      replacement("u1", "style.css", "a"),
      replacement("u1", "style.css", "b"),
    ]),
  );
  await validationErrorOf(
    stageJournal(root, "rv", ["u1"], [replacement("u1", "../escape", "y")]),
  );
  await validationErrorOf(stageJournal(root, "bad/run", ["u1"], []));
  assert.deepEqual(await unresolvedJournals(root), []);
  const missing = await journalErrorOf(commitJournal(root, "rv"));
  assert.equal(missing.code, "no-journal");
  const snapshot = await snapshotInputs(root, "build", ["can.generated/u1/style.css"]);
  assert.equal(snapshot.length, 1);
});

test("complete replacement journals obsolete files and exact binary bytes", async () => {
  const root = await freshRoot();
  const oldBinary = Buffer.from([0, 255, 128, 13, 10]);
  const newBinary = Buffer.from([255, 0, 129, 10]);
  await writeTree(root, [["can.generated/u1/style.css", "old"], ["can.generated/u1/obsolete.js", "helper"]]);
  await writeFile(join(root, "can.generated/u1/image.bin"), oldBinary);
  const changes: Replacement[] = [replacement("u1", "style.css", "new"), { unit: "u1", path: "image.bin", bytes: newBinary }];
  const journal = await stageJournal(root, "complete", ["u1"], changes, "replace");
  assert.equal(journal.version, 2);
  assert.deepEqual(journal.entries.find((e) => e.path === "obsolete.js"), {
    unit: "u1", path: "obsolete.js", old_sha256: journal.entries.find((e) => e.path === "obsolete.js")?.old_sha256,
    staged: null, new_sha256: null,
  });
  await markCommitted(root, "complete");
  // Simulate interruption after the deletion but before any replacement.
  await fs.rm(join(root, "can.generated/u1/obsolete.js"));
  assert.deepEqual(await recoverJournal(root, "complete"), { kind: "completed-new", files: 3 });
  assert.deepEqual(await groupFiles(root, "u1"), ["image.bin", "style.css"]);
  assert.deepEqual(await readFile(join(root, "can.generated/u1/image.bin")), newBinary);
  assert.deepEqual(await readFile(join(root, ".can/gen/previous/u1/image.bin")), oldBinary);
  assert.equal(await readTree(root, ".can/gen/previous/u1/obsolete.js"), "helper");
  assert.deepEqual(await recoverJournal(root, "complete"), { kind: "already-resolved" });
});

test("precommit deletion recovery preserves old bytes and missing new files", async () => {
  const root = await freshRoot();
  await writeTree(root, [["can.generated/u1/old.bin", "old"]]);
  await stageJournal(root, "before-delete", ["u1"], [replacement("u1", "new.bin", "new")], "replace");
  assert.deepEqual(await recoverJournal(root, "before-delete"), { kind: "restored-old" });
  assert.deepEqual(await groupFiles(root, "u1"), ["old.bin"]);
  assert.equal(await readTree(root, "can.generated/u1/old.bin"), "old");
});

test("explicit patch deletion preserves untouched files and rejects changed deleted bytes", async () => {
  const root = await freshRoot();
  await writeTree(root, [["can.generated/u1/keep.bin", "keep"], ["can.generated/u1/remove.bin", "old"]]);
  await stageJournal(root, "patch-delete", ["u1"], [{ unit: "u1", path: "remove.bin", bytes: null }]);
  await markCommitted(root, "patch-delete");
  await writeTree(root, [["can.generated/u1/remove.bin", "foreign"]]);
  assert.equal((await recoverJournal(root, "patch-delete")).kind, "conflict");
  assert.equal(await readTree(root, "can.generated/u1/remove.bin"), "foreign");
  await writeTree(root, [["can.generated/u1/remove.bin", "old"]]);
  assert.deepEqual(await recoverJournal(root, "patch-delete"), { kind: "completed-new", files: 1 });
  assert.deepEqual(await groupFiles(root, "u1"), ["keep.bin"]);
});

test("complete replacement refuses extra files rather than claiming exact membership", async () => {
  const root = await freshRoot();
  await writeTree(root, [["can.generated/u1/style.css", "old"]]);
  await stageJournal(root, "extra-file", ["u1"], [replacement("u1", "style.css", "new")], "replace");
  await markCommitted(root, "extra-file");
  await writeTree(root, [["can.generated/u1/foreign.bin", "foreign"]]);
  assert.equal((await recoverJournal(root, "extra-file")).kind, "conflict");
  assert.equal(await readTree(root, "can.generated/u1/style.css"), "old");
  assert.equal(await readTree(root, "can.generated/u1/foreign.bin"), "foreign");
});

test("complete replacement supports file-directory transitions and version 1 recovery", async () => {
  const root = await freshRoot();
  await writeTree(root, [["can.generated/u1/asset", "old"]]);
  await stageJournal(root, "to-dir", ["u1"], [replacement("u1", "asset/part.bin", "nested")], "replace");
  await commitJournal(root, "to-dir");
  assert.deepEqual(await groupFiles(root, "u1"), ["asset/part.bin"]);
  await stageJournal(root, "to-file", ["u1"], [replacement("u1", "asset", "flat")], "replace");
  await commitJournal(root, "to-file");
  assert.deepEqual(await groupFiles(root, "u1"), ["asset"]);
  await stageJournal(root, "legacy", ["u1"], [replacement("u1", "asset", "legacy")]);
  const legacy = await readJournal(root, "legacy");
  legacy.version = 1;
  delete legacy.mode;
  await writeFile(join(root, ".can/gen/runs/legacy/journal.json"), JSON.stringify(legacy));
  await markCommitted(root, "legacy");
  assert.deepEqual(await recoverJournal(root, "legacy"), { kind: "completed-new", files: 1 });
});
