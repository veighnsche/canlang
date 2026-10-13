/**
 * BGI-02 records tests: `unit.json` parsing/validation and saved-group
 * intake. Mirrors the Rust `bgi02_association` record/intake coverage so
 * both hosts enforce the same frozen v1 shape.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENERATED_DIR,
  UNIT_ABI_VERSION,
  UNIT_FILE,
  RecordError,
  parseUnitRecord,
  readSavedGroup,
  sha256HexText,
  validateUnitId,
  type UnitRecord,
} from "./records.js";

function styleRecord(id: string): UnitRecord {
  return {
    abi_version: UNIT_ABI_VERSION,
    id,
    source: {
      owner: "Tasks",
      kind: "style",
      label: "TaskSurface",
      anchor: "Tasks:style:TaskSurface:",
      path: "app.can",
      revision: "rev0",
      start: 10,
      end: 60,
    },
    contract: {
      target: null,
      profile: null,
      prompt_sha256: sha256HexText("Readable task surfaces."),
      signature: null,
    },
    original: {
      prompt_sha256: sha256HexText("Readable task surfaces."),
      files: { "style.css": sha256HexText(".TaskSurface{color:old}") },
    },
    provenance: { origin: "generated", runner: "codex", model: "test-model", note: null },
  };
}

test("unit.json round trip pins ABI and directory ID", () => {
  const json = JSON.stringify(styleRecord("u1"));
  assert.match(json, /"abi_version":1/);
  const back = parseUnitRecord(json, "u1");
  assert.deepEqual(back, styleRecord("u1"));
  const badAbi = json.replace('"abi_version":1', '"abi_version":2');
  assert.throws(() => parseUnitRecord(badAbi, "u1"), /abi_version 2, want 1/);
  assert.throws(() => parseUnitRecord(json, "u2"), /does not match its directory/);
  assert.throws(() => parseUnitRecord("{nope", "u1"), /not valid JSON/);
  assert.throws(() => parseUnitRecord(JSON.stringify({ ...styleRecord("u1"), id: 7 }), "u1"), /must be a string/);
});

test("unit IDs reject paths and blank", () => {
  validateUnitId("u1");
  for (const bad of ["", "..", ".", "a/b", "a\\b", "u 1", "u\t1"]) {
    assert.throws(() => validateUnitId(bad), RecordError, `${bad} must refuse`);
  }
});

test("intake reads current files and keeps original fingerprints", async () => {
  const root = await mkdtemp(join(tmpdir(), "can-bgi02-records-"));
  try {
    const record = styleRecord("u1");
    const unitDir = join(root, GENERATED_DIR, "u1");
    await mkdir(join(unitDir, "assets"), { recursive: true });
    await writeFile(join(unitDir, UNIT_FILE), JSON.stringify(record));
    // A direct edit is the current build input.
    await writeFile(join(unitDir, "style.css"), ".TaskSurface{color:new}");
    await writeFile(join(unitDir, "assets", "logo.bin"), new Uint8Array([0, 1, 2, 3]));

    const result = await readSavedGroup(root, "u1");
    assert.equal(result.ok, true);
    assert(result.ok);
    assert.deepEqual(result.group.record, record);
    const css = result.group.files.find((file) => file.relPath === "style.css");
    assert.ok(css);
    assert.equal(Buffer.from(css.bytes).toString("utf8"), ".TaskSurface{color:new}");
    assert.equal(css.sha256, sha256HexText(".TaskSurface{color:new}"));
    assert.notEqual(
      css.sha256,
      result.group.record.original.files["style.css"],
      "current bytes and original fingerprints are distinct facts",
    );
    const asset = result.group.files.find((file) => file.relPath === "assets/logo.bin");
    assert.ok(asset);
    assert.deepEqual(Array.from(asset.bytes), [0, 1, 2, 3]);
    assert.ok(!result.group.files.some((file) => file.relPath === UNIT_FILE));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing and incompatible groups identify exact unit and action", async () => {
  const root = await mkdtemp(join(tmpdir(), "can-bgi02-records-"));
  try {
    const missing = await readSavedGroup(root, "u3");
    assert.equal(missing.ok, false);
    assert(!missing.ok);
    assert.equal(missing.issue.unit, "u3");
    assert.equal(missing.issue.action, "generate");
    assert.match(missing.issue.detail, /no saved group/);

    const unitDir = join(root, GENERATED_DIR, "u4");
    await mkdir(unitDir, { recursive: true });
    await writeFile(join(unitDir, UNIT_FILE), JSON.stringify({ ...styleRecord("u4"), abi_version: 2 }));
    const incompatible = await readSavedGroup(root, "u4");
    assert.equal(incompatible.ok, false);
    assert(!incompatible.ok);
    assert.equal(incompatible.issue.unit, "u4");
    assert.equal(incompatible.issue.action, "bind");
    assert.match(incompatible.issue.detail, /incompatible/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing primary output refuses while edits and optional assets pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "can-bgi02-records-"));
  try {
    const record = styleRecord("u1");
    record.original.files["assets/old-logo.bin"] = sha256HexText("old logo bytes");
    const unitDir = join(root, GENERATED_DIR, "u1");
    await mkdir(unitDir, { recursive: true });
    await writeFile(join(unitDir, UNIT_FILE), JSON.stringify(record));
    // Current style.css missing: exact unit plus its generation action.
    const missing = await readSavedGroup(root, "u1");
    assert.equal(missing.ok, false);
    assert(!missing.ok);
    assert.equal(missing.issue.unit, "u1");
    assert.equal(missing.issue.action, "generate");
    assert.match(missing.issue.detail, /style\.css/);
    // A direct edit (bytes differ from the historical hash) is usable,
    // and the missing historical optional asset is not required.
    await writeFile(join(unitDir, "style.css"), ".TaskSurface{color:new}");
    const edited = await readSavedGroup(root, "u1");
    assert.equal(edited.ok, true);
    assert(edited.ok);
    assert.equal(edited.group.files.length, 1);
    assert.notEqual(
      edited.group.files[0]?.sha256,
      edited.group.record.original.files["style.css"],
      "edited bytes are current inputs, not hash failures",
    );
    // A fresh preparation group (bound, no recorded outputs) may still be
    // allocated without outputs.
    const fresh: UnitRecord = {
      ...record,
      id: "u2",
      original: { prompt_sha256: record.original.prompt_sha256, files: {} },
      provenance: { origin: "bound", runner: null, model: null, note: "explicit bind" },
    };
    const freshDir = join(root, GENERATED_DIR, "u2");
    await mkdir(freshDir, { recursive: true });
    await writeFile(join(freshDir, UNIT_FILE), JSON.stringify(fresh));
    const prepared = await readSavedGroup(root, "u2");
    assert.equal(prepared.ok, true);
    assert(prepared.ok);
    assert.deepEqual(prepared.group.files, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlink entries refuse with the exact affected unit", async () => {
  const root = await mkdtemp(join(tmpdir(), "can-bgi02-records-"));
  try {
    const unitDir = join(root, GENERATED_DIR, "u1");
    await mkdir(unitDir, { recursive: true });
    await writeFile(join(unitDir, UNIT_FILE), JSON.stringify(styleRecord("u1")));
    const outside = join(root, "outside.css");
    await writeFile(outside, "external bytes");
    // A current file symlinking outside refuses; external bytes never
    // serve as the unit's own output.
    await symlink(outside, join(unitDir, "style.css"));
    const linked = await readSavedGroup(root, "u1");
    assert.equal(linked.ok, false);
    assert(!linked.ok);
    assert.equal(linked.issue.unit, "u1");
    assert.equal(linked.issue.action, "bind");
    assert.match(linked.issue.detail, /style\.css/);
    assert.match(linked.issue.detail, /symlink/);
    await rm(join(unitDir, "style.css"));
    await writeFile(join(unitDir, "style.css"), ".TaskSurface{}");
    assert((await readSavedGroup(root, "u1")).ok);

    // A symlinked unit record refuses with the affected unit.
    const unit2 = join(root, GENERATED_DIR, "u2");
    await mkdir(unit2, { recursive: true });
    const externalRecord = join(root, "external-unit.json");
    await writeFile(externalRecord, JSON.stringify(styleRecord("u2")));
    await symlink(externalRecord, join(unit2, UNIT_FILE));
    const recordLink = await readSavedGroup(root, "u2");
    assert.equal(recordLink.ok, false);
    assert(!recordLink.ok);
    assert.equal(recordLink.issue.unit, "u2");
    assert.equal(recordLink.issue.action, "bind");
    assert.match(recordLink.issue.detail, /symlink/);

    // A symlinked unit directory refuses with the affected unit.
    const real = join(root, "real-u3");
    await mkdir(real, { recursive: true });
    await writeFile(join(real, UNIT_FILE), JSON.stringify(styleRecord("u3")));
    await writeFile(join(real, "style.css"), ".TaskSurface{}");
    await symlink(real, join(root, GENERATED_DIR, "u3"));
    const dirLink = await readSavedGroup(root, "u3");
    assert.equal(dirLink.ok, false);
    assert(!dirLink.ok);
    assert.equal(dirLink.issue.unit, "u3");
    assert.equal(dirLink.issue.action, "bind");
    assert.match(dirLink.issue.detail, /symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saved intake consults no provider config or login", async () => {
  const root = await mkdtemp(join(tmpdir(), "can-bgi02-records-"));
  const priorCatalog = process.env["CAN_CATALOG"];
  const priorRunner = process.env["CAN_GEN_RUNNER"];
  process.env["CAN_CATALOG"] = "/nonexistent/catalog.json";
  process.env["CAN_GEN_RUNNER"] = "nonexistent-runner";
  try {
    // No can.gen.toml anywhere under the root, no network, no login.
    const unitDir = join(root, GENERATED_DIR, "u1");
    await mkdir(unitDir, { recursive: true });
    await writeFile(join(unitDir, UNIT_FILE), JSON.stringify(styleRecord("u1")));
    await writeFile(join(unitDir, "style.css"), ".TaskSurface{}");
    const result = await readSavedGroup(root, "u1");
    assert.equal(result.ok, true);
    assert(result.ok);
    assert.equal(result.group.record.id, "u1");
  } finally {
    if (priorCatalog === undefined) {
      delete process.env["CAN_CATALOG"];
    } else {
      process.env["CAN_CATALOG"] = priorCatalog;
    }
    if (priorRunner === undefined) {
      delete process.env["CAN_GEN_RUNNER"];
    } else {
      process.env["CAN_GEN_RUNNER"] = priorRunner;
    }
    await rm(root, { recursive: true, force: true });
  }
});
