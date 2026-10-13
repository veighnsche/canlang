/**
 * BGI-02 association tests: conservative unique matching, opaque ID
 * allocation, and explicit bind/copy reconciliation. Mirrors the Rust
 * `bgi02_association` association/bind coverage so both hosts enforce the
 * same rules: prompt-only edits retain, copies and ambiguous relocations
 * refuse, stale selectors reject.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyBind,
  associate,
  describeKey,
  keyOfDescriptor,
  nextUnitId,
  type BindRequest,
  type DescriptorInput,
} from "./association.js";
import { UNIT_ABI_VERSION, sha256HexText, type UnitRecord } from "./records.js";

function descriptor(overrides: Partial<DescriptorInput> = {}): DescriptorInput {
  return {
    owner: "Tasks",
    kind: "named-trait",
    label: "completable",
    anchor: "Tasks:trait:completable:",
    prompt: "Add done:bool=false with Open/Done labels.",
    ...overrides,
  };
}

function savedRecord(id: string, from: DescriptorInput, revision = "rev0"): UnitRecord {
  return {
    abi_version: UNIT_ABI_VERSION,
    id,
    source: {
      owner: from.owner,
      kind: from.kind,
      label: from.label,
      anchor: from.anchor,
      path: "app.can",
      revision,
      start: 10,
      end: 60,
    },
    contract: {
      target: null,
      profile: null,
      prompt_sha256: sha256HexText(from.prompt),
      signature: null,
    },
    original: {
      prompt_sha256: sha256HexText(from.prompt),
      files: { "server.js": sha256HexText("old bytes") },
    },
    provenance: { origin: "generated", runner: "codex", model: "test-model", note: null },
  };
}

test("unique anchors retain; unrelated and prompt-only edits keep IDs", () => {
  const units = [
    descriptor(),
    descriptor({
      kind: "style",
      label: "TaskSurface",
      anchor: "Tasks:style:TaskSurface:",
      prompt: "Readable task surfaces.",
    }),
  ];
  const saved = units.map((unit, index) => savedRecord(`u${index + 1}`, unit));
  const first = associate(units, saved);
  assert.deepEqual(
    first.map((entry) => entry.association),
    [
      { type: "retained", id: "u1", promptChanged: false },
      { type: "retained", id: "u2", promptChanged: false },
    ],
  );
  // Prompt-only rewrites keep every ID and report freshness.
  const rewritten = units.map((unit) => ({ ...unit, prompt: `Different words for ${unit.label}.` }));
  const second = associate(rewritten, saved);
  assert.deepEqual(
    second.map((entry) => entry.association),
    [
      { type: "retained", id: "u1", promptChanged: true },
      { type: "retained", id: "u2", promptChanged: true },
    ],
  );
  // Keys ignore everything but owner/kind/label/anchor.
  assert.equal(describeKey(keyOfDescriptor(units[0] as DescriptorInput)), "Tasks/named-trait/completable anchor `Tasks:trait:completable:`");
});

test("copies and ambiguous relocations cannot reuse ownership", () => {
  const unit = descriptor();
  const saved = [savedRecord("u1", unit)];
  // A copied definition shares its whole key: both copies refuse reuse.
  const copied = associate([unit, { ...unit }], saved);
  assert.equal(copied.length, 2);
  for (const entry of copied) {
    assert.equal(entry.association.type, "ambiguous");
    assert(entry.association.type === "ambiguous");
    assert.deepEqual(entry.association.candidates, ["u1"]);
  }
  // A relocated unit (new anchor) is new: the old ID is never silently
  // reused via a sole unmatched pair or nearest offset.
  const moved = associate([{ ...unit, anchor: "Tasks:trait:completable:moved" }], saved);
  assert.deepEqual(
    moved.map((entry) => entry.association),
    [{ type: "new" }],
  );
  // Duplicate saved records for one key refuse to pick one.
  const twin = savedRecord("u99", unit);
  const duped = associate([unit], [...saved, twin]);
  assert.equal(duped.length, 1);
  const only = duped[0]?.association;
  assert.equal(only?.type, "ambiguous");
  assert(only?.type === "ambiguous");
  assert.deepEqual(only.candidates, ["u1", "u99"]);
});

test("next unit ID fills the smallest gap", () => {
  assert.equal(nextUnitId(new Set(["u1", "u3"])), "u2");
  assert.equal(nextUnitId([]), "u1");
  assert.equal(nextUnitId(["u1", "u2"]), "u3");
});

function bindRequest(unit: DescriptorInput, revision: string, target: BindRequest["target"]): BindRequest {
  return {
    path: "app.can",
    revision,
    start: 10,
    end: 60,
    source: {
      owner: unit.owner,
      kind: unit.kind,
      label: unit.label,
      anchor: unit.anchor,
      path: "app.can",
      revision,
      start: 10,
      end: 60,
    },
    contract: {
      target: null,
      profile: null,
      prompt_sha256: sha256HexText(unit.prompt),
      signature: null,
    },
    target,
  };
}

test("stale bind rejects and leaves saved groups intact", () => {
  const unit = descriptor();
  const saved = [savedRecord("u1", unit, "rev-inspected")];
  const stale = applyBind(saved, bindRequest(unit, "rev-inspected", { kind: "existing", id: "u1" }), "rev-now");
  assert.equal(stale.ok, false);
  assert(!stale.ok);
  assert.equal(stale.error.code, "stale-selector");
  assert.match(stale.error.detail, /stale bind selector/);
  assert.equal(saved[0]?.source.revision, "rev-inspected");

  const unknown = applyBind(saved, bindRequest(unit, "rev-now", { kind: "existing", id: "u7" }), "rev-now");
  assert.equal(unknown.ok, false);
  assert(!unknown.ok);
  assert.equal(unknown.error.code, "unknown-unit");

  const style = descriptor({ kind: "style", label: "TaskSurface", anchor: "Tasks:style:TaskSurface:" });
  const cross = applyBind(saved, bindRequest(style, "rev-now", { kind: "existing", id: "u1" }), "rev-now");
  assert.equal(cross.ok, false);
  assert(!cross.ok);
  assert.equal(cross.error.code, "kind-mismatch");
});

test("bind existing refreshes evidence and bind new allocates for copies", () => {
  const unit = descriptor();
  const saved = [savedRecord("u1", unit, "rev-old")];
  const moved = bindRequest({ ...unit, anchor: "Tasks:trait:completable:" }, "rev-new", {
    kind: "existing",
    id: "u1",
  });
  moved.path = "moved.can";
  moved.source.path = "moved.can";
  const bound = applyBind(saved, moved, "rev-new");
  assert.equal(bound.ok, true);
  assert(bound.ok);
  assert.equal(bound.record.id, "u1");
  assert.equal(bound.record.source.path, "moved.can");
  assert.equal(bound.record.source.revision, "rev-new");
  assert.deepEqual(bound.record.original, saved[0]?.original);
  assert.deepEqual(bound.record.provenance, saved[0]?.provenance);

  const copy = applyBind(saved, bindRequest(unit, "rev-new", { kind: "new" }), "rev-new");
  assert.equal(copy.ok, true);
  assert(copy.ok);
  assert.equal(copy.record.id, "u2");
  assert.deepEqual(copy.record.original.files, {});
  assert.equal(copy.record.provenance.origin, "bound");
});
