import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CanValue } from "@canlang/contracts/values";
import { equalValue } from "../src/equality.js";
import { ValueError } from "../src/errors.js";
import { makeRecordRef, makeUnionValue } from "../src/kinds.js";
import { normalizeSchema, validateValue } from "../src/schema.js";
import { encodeValue } from "../src/wire.js";

const schema = normalizeSchema({
  aliases: { Label: { type: "text", min: 1, max: 80, format: "name" } },
  contracts: {
    Evidence: { fields: {
      kind: { type: "text" }, model: { type: "Label" }, id: { type: "text" },
      version: { type: "int" }, note: { type: "text" }, owner: { type: "Team" },
    } },
    Bundle: { fields: {
      entries: { type: "Evidence[]" }, selected: { type: "Evidence|Other" },
      optional: { type: "Evidence?" },
    } },
    Other: { fields: { label: { type: "text" } } },
  },
});
const evidence = (kind = "ref") => ({ kind, model: "Team", id: "evidence", version: 1n,
  note: "retained", owner: makeRecordRef("Team", "team", 1n) });
const eq = (type: string, a: CanValue, b: CanValue) => equalValue(type, a, b, undefined, schema);
const encode = (type: string, value: CanValue) => encodeValue(type, value, undefined, schema);
const invalid = (fn: () => unknown) => assert.throws(fn, (error: unknown) =>
  error instanceof ValueError && error.code === "invalid-construction");

describe("owning schema disambiguates Contract business runtime tags", () => {
  it("compares every field in plain and validated ref-shaped Contracts", () => {
    const plain = evidence();
    const wire = { ...plain, version: "1", owner: { id: "team", version: "1" } };
    const validated = validateValue(schema, "Evidence", wire, "create");
    assert.equal(eq("Evidence", plain, validated), true);
    for (const [key, value] of Object.entries({ kind: "user", model: "Other", id: "other", version: 2n, note: "changed" })) {
      assert.equal(eq("Evidence", plain, { ...plain, [key]: value }), false, key);
    }
    assert.equal(eq("Evidence", plain, { ...plain, owner: makeRecordRef("Team", "team", 9n) }), true);
    assert.equal(eq("Evidence", plain, { ...plain, owner: makeRecordRef("Team", "other", 1n) }), false);
    assert.deepEqual(encode("Evidence", plain), wire);
    assert.deepEqual(encode("Evidence", validated), wire);
    assert.deepEqual(encode("Label", "Team"), "Team");
  });

  it("preserves all known-tag business strings without weakening unproven malformed-tag refusals", () => {
    for (const kind of ["decimal", "money", "date", "datetime", "user", "member", "ref", "union", "action", "invocation", "delivery", "file", "secret", "message"]) {
      const plain = evidence(kind);
      assert.equal(eq("Evidence", plain, { ...plain }), true, kind);
      assert.equal((encode("Evidence", plain) as Record<string, unknown>)["kind"], kind);
    }
    for (const type of ["", "Unknown", "Team"]) {
      const malformed = { kind: "ref", id: "business" };
      invalid(() => equalValue(type, malformed, malformed, undefined, schema));
      if (type !== "") invalid(() => encode(type, malformed));
    }
    const malformed = { ...evidence(), owner: { kind: "ref", id: "broken" } };
    invalid(() => eq("Evidence", malformed, malformed));
    invalid(() => encode("Evidence", malformed));
  });

  it("recurses through nullable Contracts, arrays and selected union arms", () => {
    const item = evidence();
    const bundle = { entries: [item, { ...item, version: 2n }],
      selected: makeUnionValue("Evidence", item), optional: item };
    const wire = { entries: [encode("Evidence", item), encode("Evidence", { ...item, version: 2n })],
      selected: { type: "Evidence", value: encode("Evidence", item) }, optional: encode("Evidence", item) };
    assert.equal(eq("Bundle", bundle, validateValue(schema, "Bundle", wire, "create")), true);
    assert.deepEqual(encode("Bundle", bundle), wire);
    assert.equal(eq("Bundle", bundle, { ...bundle, entries: [...bundle.entries].reverse() }), false);
    assert.equal(eq("Bundle", bundle, { ...bundle, selected: makeUnionValue("Evidence", { ...item, version: 9n }) }), false);
    assert.equal(eq("Evidence?", null, item), false);
    assert.equal(encode("Evidence?", null), null);
    assert.equal(eq("Evidence[]!", [item], [{ ...item, version: 9n }]), false);
    assert.deepEqual(encode("Evidence[]!", [item]), [encode("Evidence", item)]);
    assert.deepEqual(encode("Evidence[]", [item]), [encode("Evidence", item)]);
  });

  it("retains resolver demand, short-circuit, array order and original failure identity", () => {
    const item = evidence();
    const calls: CanValue[] = [];
    const resolver = (value: CanValue) => { calls.push(value); return undefined; };
    assert.equal(equalValue("Evidence", item, { ...item, kind: "changed" }, resolver, schema), false);
    assert.deepEqual(calls, ["ref", "changed"]);
    calls.length = 0;
    assert.equal(equalValue("Evidence[]", [item], [], resolver, schema), false);
    assert.deepEqual(calls, []);
    const native = { ...item, owner: { token: "native" } };
    const paths: ReadonlyArray<string | number>[] = [];
    const nativeResolver = (value: CanValue, path: ReadonlyArray<string | number>) => {
      paths.push(path);
      assert.equal(value, native.owner);
      return makeRecordRef("Team", "team", 3n);
    };
    const encoded = encodeValue("Evidence[]", [native], nativeResolver, schema);
    assert.deepEqual(paths, [[0, "owner"]]);
    assert.deepEqual(encoded, [{ ...encode("Evidence", item) as object, owner: { id: "team", version: "3" } }]);
    const failure = new Error("resolver failure");
    assert.throws(() => equalValue("Evidence", item, item, () => { throw failure; }, schema), error => error === failure);
    assert.throws(() => encodeValue("Evidence", item, () => { throw failure; }, schema), error => error === failure);
  });

  it("retains existing untyped ref behavior and public function arities", () => {
    assert.equal(equalValue.length, 3);
    assert.equal(encodeValue.length, 2);
    const item = evidence();
    assert.equal(equalValue("Evidence", item, { ...item, version: 2n, note: "changed" }), true);
    assert.deepEqual(encodeValue("Team", item), { id: "evidence", version: "1" });
    assert.equal(eq("Team", makeRecordRef("Team", "team", 1n), makeRecordRef("Team", "team", 2n)), true);
    invalid(() => eq("Evidence", { ...item, unexpected: "extra" }, { ...item, unexpected: "extra" }));
    invalid(() => encode("Evidence", { ...item, unexpected: "extra" }));
  });
});
