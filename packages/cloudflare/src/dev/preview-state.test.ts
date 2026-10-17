import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openRetainedPreviewState } from "./preview-state.js";
import type { LocalPreviewSeed } from "./preview-builder.js";

const capture = { root: "/home/test/project", appPath: "/home/test/project/App.can" };
const artifact = { models: [] };
const seed: LocalPreviewSeed = { actors: [{ label: "Ava", email: "ava@preview.can.test", password: "local-development-only", teams: ["Cedar"] }],
  probe: { email: "ava@preview.can.test", password: "local-development-only", teamId: "cedar" },
  owners: [{ owner: "cedar", binding: "STATE_CEDAR_DB" }, { owner: "oak", binding: "STATE_OAK_DB" }] };

test("retained preview reopening preserves physical assignments and credentials, separates sources and refuses schema edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "can-preview-state-"));
  try {
    const initial = await openRetainedPreviewState(root, capture, artifact, "team");
    assert.equal(initial.seed, null);
    await initial.saveSeed(seed);
    const restarted = await openRetainedPreviewState(root, capture, artifact, "team");
    assert.equal(restarted.databaseId, initial.databaseId);
    assert.deepEqual(restarted.ownerDatabaseIds, initial.ownerDatabaseIds);
    assert.deepEqual(restarted.seed, seed);
    const other = await openRetainedPreviewState(root, { ...capture, appPath: "/home/test/project/Other.can" }, artifact, "team");
    assert.notEqual(other.persistence, initial.persistence);
    assert.notEqual(other.databaseId, initial.databaseId);
    assert.equal(other.seed, null);
    await assert.rejects(openRetainedPreviewState(root, capture, { models: [{ name: "Changed" }] as never }, "team"), /models changed/);
    await assert.rejects(openRetainedPreviewState(root, capture, artifact, "global"), /models changed/);
    assert.deepEqual((await openRetainedPreviewState(root, capture, artifact, "team")).seed, seed);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preview state refuses exposed directories and metadata links without overwriting them", async () => {
  const root = await mkdtemp(join(tmpdir(), "can-preview-state-"));
  try {
    await chmod(root, 0o755);
    await assert.rejects(openRetainedPreviewState(root, capture, artifact, "team"), /owner-only/);
    await chmod(root, 0o700);
    await openRetainedPreviewState(root, capture, artifact, "team");
    const directory = join(root, (await readdir(root))[0]!);
    const path = join(directory, "preview.json");
    const before = await readFile(path, "utf8");
    await chmod(path, 0o644);
    await assert.rejects(openRetainedPreviewState(root, capture, artifact, "team"), /owner-only/);
    assert.equal(await readFile(path, "utf8"), before);
    await rm(path);
    await symlink(join(directory, "outside.json"), path);
    await assert.rejects(openRetainedPreviewState(root, capture, artifact, "team"), /regular file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
