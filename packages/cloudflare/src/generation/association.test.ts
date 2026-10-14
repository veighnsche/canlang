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
  // A relocated unit needs reconciliation, rather than allocation of a
  // replacement that would leave its existing implementation disconnected.
  const moved = associate([{ ...unit, anchor: "Tasks:trait:completable:moved" }], saved);
  assert.deepEqual(
    moved.map((entry) => entry.association),
    [{ type: "ambiguous", candidates: ["u1"] }],
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

test("independent unit allocations use random portable IDs without a counter", () => {
  const first = nextUnitId(new Set(["u1", "u3"]));
  const second = nextUnitId(["u1", "u2"]);
  assert.match(first, /^g-[0-9a-f]{32}$/);
  assert.match(second, /^g-[0-9a-f]{32}$/);
  assert.notEqual(first, second);
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

test("explicit bind is honored for its exact captured location only", () => {
  // Two inline text styles sharing one structural key: `text "one"
  // $"Readable"` and `text "two" $"Readable"` in page/UiLeaf.
  const firstLocation = { path: "app.can", revision: "rev", start: 1, end: 10 };
  const secondLocation = { path: "app.can", revision: "rev", start: 20, end: 30 };
  const first = descriptor({
    kind: "style-inline",
    label: "UiLeaf",
    anchor: "Test:style-inline:UiLeaf:UiLeaf",
    prompt: "Readable",
    location: firstLocation,
  });
  const second: DescriptorInput = { ...first, location: secondLocation };
  const seed: UnitRecord = {
    abi_version: UNIT_ABI_VERSION,
    id: "u1",
    source: {
      ...firstLocation,
      owner: first.owner,
      kind: first.kind,
      label: first.label,
      anchor: first.anchor,
    },
    contract: {
      target: "UiLeaf",
      profile: null,
      prompt_sha256: sha256HexText("Readable"),
      signature: null,
    },
    original: {
      prompt_sha256: sha256HexText("Readable"),
      files: { "style.css": sha256HexText("old css") },
    },
    provenance: { origin: "generated", runner: "fixture", model: "fixture", note: null },
  };
  const boundOriginal = applyBind(
    [seed],
    {
      path: "app.can",
      revision: "rev",
      start: 1,
      end: 10,
      source: seed.source,
      contract: seed.contract,
      target: { kind: "existing", id: "u1" },
    },
    "rev",
  );
  assert.equal(boundOriginal.ok, true);
  assert(boundOriginal.ok);
  const boundCopy = applyBind(
    [boundOriginal.record],
    {
      path: "app.can",
      revision: "rev",
      start: 20,
      end: 30,
      source: { ...seed.source, start: 20, end: 30 },
      contract: seed.contract,
      target: { kind: "new" },
    },
    "rev",
  );
  assert.equal(boundCopy.ok, true);
  assert(boundCopy.ok);
  const copiedId = boundCopy.record.id;
  assert.match(copiedId, /^g-[0-9a-f]{32}$/);
  const saved = [boundOriginal.record, boundCopy.record];

  // Without current-location evidence the shared key still refuses.
  const { location: _dropFirst, ...bareFirst } = first;
  const { location: _dropSecond, ...bareSecond } = second;
  const bare = associate([bareFirst, bareSecond], saved);
  for (const entry of bare) {
    assert.equal(entry.association.type, "ambiguous");
  }
  // With exact evidence each location retains its own bound ID.
  const honored = associate([first, second], saved);
  assert.deepEqual(
    honored.map((entry) => entry.association),
    [
      { type: "retained", id: "u1", promptChanged: false },
      { type: "retained", id: copiedId, promptChanged: false },
    ],
  );
  // Changed or stale source never guesses: a new revision refuses both.
  const stale = associate(
    [
      { ...first, location: { path: "app.can", revision: "rev-edited", start: 1, end: 10 } },
      { ...second, location: { path: "app.can", revision: "rev-edited", start: 20, end: 30 } },
    ],
    saved,
  );
  for (const entry of stale) {
    assert.equal(entry.association.type, "ambiguous");
  }
  // A moved span refuses while its untouched sibling still retains.
  const moved = associate(
    [{ ...first, location: { path: "app.can", revision: "rev", start: 2, end: 10 } }, second],
    saved,
  );
  assert.equal(moved[0]?.association.type, "ambiguous");
  assert.deepEqual(moved[1]?.association, { type: "retained", id: copiedId, promptChanged: false });
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
  assert.match(copy.record.id, /^g-[0-9a-f]{32}$/);
  assert.deepEqual(copy.record.original.files, {});
  assert.equal(copy.record.provenance.origin, "bound");
});

test("exact local certificates keep duplicate siblings across unrelated revisions and offsets", () => {
  const selector = '["app:Tasks","page:/","component:Leaf","slot:style-inline"]';
  const region = { container: '["app:Tasks","page:/"]', sha256: sha256HexText("unchanged normalized siblings"), count: 2, occurrence: 0 };
  const first = descriptor({ kind: "style-inline", selector, region, location: { path: "app.can", revision: "old", start: 10, end: 60 } });
  const second = { ...first, region: { ...region, occurrence: 1 }, location: { path: "app.can", revision: "old", start: 70, end: 120 } };
  const saved = [first, second].map((unit, index) => {
    const record = savedRecord(`u${index + 1}`, unit);
    record.source.selector = selector;
    record.source.region = unit.region!;
    return record;
  });
  const updated = [first, second].map(unit => ({ ...unit, location: { ...unit.location!, revision: "formatted-and-unrelated-edit", start: unit.location!.start + 23, end: unit.location!.end + 23 } }));
  assert.deepEqual(associate(updated, saved).map(entry => entry.association), [
    { type: "retained", id: "u1", promptChanged: false },
    { type: "retained", id: "u2", promptChanged: false },
  ]);
  const changed = updated.map(unit => ({ ...unit, region: { ...unit.region!, sha256: sha256HexText("reordered relevant content") } }));
  assert(associate(changed, saved).every(entry => entry.association.type === "ambiguous"));
  // Deleting a sibling cannot turn an invalid occurrence into a unique owner.
  assert.equal(associate([{ ...updated[0]!, region: { ...region, count: 1 } }], saved)[0]?.association.type, "ambiguous");
});

test("complete source paths and one-to-one claims prevent silent copies", () => {
  const unit = descriptor({ selector: '["app:Tasks","trait:completable"]', location: { path: "app.can", revision: "old", start: 10, end: 60 } });
  const saved = savedRecord("u1", unit);
  saved.source.selector = unit.selector!;
  const copy = { ...unit, location: { ...unit.location!, path: "copy.can" } };
  const associations = associate([unit, copy], [saved]).map(entry => entry.association);
  assert.equal(associations[0]?.type, "ambiguous");
  assert.equal(associations[1]?.type, "ambiguous");
  assert.equal(associate([copy], [saved], ["app.can", "copy.can"])[0]?.association.type, "ambiguous");
  assert(associate([unit], [saved, { ...saved, source: { ...saved.source } }]).every(entry => entry.association.type === "ambiguous"));
});

test("owner renames and relocations reconcile each displaced kind before generation", () => {
  const originals = [
    descriptor({ kind: "named-trait", selector: "old:trait" }),
    descriptor({ kind: "style", selector: "old:style" }),
    descriptor({ kind: "view", selector: "old:view" }),
  ];
  const saved = originals.map((unit, index) => {
    const record = savedRecord(`u${index}`, unit);
    record.source.selector = unit.selector!;
    return record;
  });
  const renamed = originals.map(unit => ({
    ...unit,
    owner: "Renamed",
    selector: unit.selector!.replace("old:", "new:"),
    location: { path: "moved.can", revision: "new", start: 10, end: 60 },
  }));
  assert.deepEqual(associate(renamed, saved).map(entry => entry.association), [
    { type: "ambiguous", candidates: ["u0"] },
    { type: "ambiguous", candidates: ["u1"] },
    { type: "ambiguous", candidates: ["u2"] },
  ]);
  // An orphan of another kind does not prevent a fresh definition.
  assert.equal(associate([renamed[1]!], [saved[2]!])[0]?.association.type, "new");
});
