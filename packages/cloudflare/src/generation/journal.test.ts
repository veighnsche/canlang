/**
 * BGI-04 journal tests: full-run staging, commit, and recovery plus
 * read-gated snapshots. Mirrors the Rust `bgi04_leases` journal coverage
 * so both hosts enforce the same protocol: whole old/new groups across
 * the commit boundary, retained conflict material, idempotent recovery,
 * one previous group, and readers that refuse unresolved journals.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
import { LeaseError } from "./leases.js";

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
