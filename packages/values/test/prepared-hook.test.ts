import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CanValue } from "@canlang/contracts/values";
import * as publicSchema from "../src/schema.js";
import * as publicWire from "../src/wire.js";
import * as publicValues from "../src/index.js";
import { EMPTY_ARRAY } from "../src/array.js";
import { SchemaError, ValueError } from "../src/errors.js";
import {
  hasFactorySchemaLineage, validateValueTsCore, validateOperationInputTsCore,
} from "../src/internal/schema-core.js";
import { decodeValueTsCore, encodeValueTsCore } from "../src/internal/wire-core.js";
import { decodePreparedValue, encodePreparedValue } from "../src/prepared/codec.js";
import { validatePreparedValue } from "../src/prepared/validation.js";
import {
  createPlanOwner, registerValidationPlan, recordFactoryProvenance, PlanError,
} from "../src/prepared/plan.js";
import type { NormalizedSchema, UpdateContract } from "../src/schema.js";

const { normalizeSchema, validateValue, validateOperationInput, UPDATE_OMITTED } = publicSchema;
const { decodeValue, encodeValue } = publicWire;

function preparedFixture() {
  const schema = normalizeSchema({ contracts: { Item: { fields: { name: { type: "text" } } } } });
  const owner = createPlanOwner({
    abiVersion: "values/v1", profileVersion: "validation/v1", backendId: "explicit-test-only",
    ownerRevision: "test-load",
  });
  // Existing explicit preparation seam; never an adoption or producer proof.
  recordFactoryProvenance(schema, "test-load");
  const id = registerValidationPlan(owner, "validation/v1", schema);
  return { schema, owner, id };
}

describe("private core separation keeps public TS behavior", () => {
  it("retains exact schema/wire exports and hides internal authority symbols", () => {
    assert.deepEqual(Object.keys(publicSchema).sort(), [
      "ENGINE_RESOLVED", "UPDATE_OMITTED", "ValueTypesError", "isEngineResolved", "isUpdateOmitted",
      "normalizeSchema", "normalizeValueTypes", "validateOperationInput", "validateValue",
    ].sort());
    assert.deepEqual(Object.keys(publicWire).sort(), ["decodeValue", "encodeValue"]);
    for (const name of ["hasFactorySchemaLineage", "validateValueTsCore", "validateOperationInputTsCore",
      "decodeValueTsCore", "encodeValueTsCore", "recordFactoryProvenance"]) {
      assert.equal(Object.hasOwn(publicValues, name), false, name);
    }
    assert.equal(validateValue.length, 4);
    assert.equal(validateOperationInput.length, 3);
    assert.equal(decodeValue.length, 2);
    assert.equal(encodeValue.length, 2);
  });

  it("asserts schema before mode/type/value and reads the legacy assertion fields once", () => {
    const trace: string[] = [];
    const schema = new Proxy(normalizeSchema({}), {
      get(target, key, receiver) { trace.push(String(key)); return Reflect.get(target, key, receiver); },
    });
    const wire = new Proxy({}, { get() { assert.fail("wire read before mode check"); } });
    assert.throws(() => validateValue(schema, "not-a-type(", wire, "bad" as "create"), ValueError);
    assert.deepEqual(trace, ["kind", "contracts", "enums", "operations"]);
    assert.throws(() => validateValue(null as unknown as NormalizedSchema, "bad(", wire, "bad" as "create"),
      (error: unknown) => error instanceof ValueError && error.message.includes("NormalizedSchema"));
    trace.length = 0;
    assert.throws(() => validateOperationInput(schema, "", wire), ValueError);
    assert.deepEqual(trace, ["kind", "contracts", "enums", "operations"]);
  });

  it("retains arbitrary hand-built schema success without lineage promotion", () => {
    const genuine = normalizeSchema({});
    const manual: NormalizedSchema = Object.freeze({ ...genuine });
    assert.equal(hasFactorySchemaLineage(manual), false);
    assert.equal(validateValue(manual, "int", "12", "create"), 12n);
    assert.equal(hasFactorySchemaLineage(manual), false);
  });

  it("keeps canonical Decimal/default/empty/sentinel identities and engine omissions", () => {
    const schema = normalizeSchema({ contracts: { Item: { fields: {
      amount: { type: "decimal", default: "1.230" },
      labels: { type: "text[]", default: ["seed"] },
      empty: { type: "text[]" }, generated: { type: "text", server: true },
      derived: { type: "text", derived: true },
    } } } });
    const fields = schema.contracts["Item"]!.fields;
    const a = validateValue(schema, "Item", {}, "create") as Record<string, CanValue>;
    const b = validateValueTsCore(schema, "Item", {}, "create") as Record<string, CanValue>;
    assert.equal(a["amount"], fields["amount"]!.default);
    assert.equal(b["amount"], a["amount"]);
    assert.equal(a["labels"], fields["labels"]!.default);
    assert.equal(b["labels"], a["labels"]);
    assert.equal(a["empty"], EMPTY_ARRAY);
    assert.equal(b["empty"], EMPTY_ARRAY);
    assert.ok(Object.isFrozen(a["labels"]));
    assert.equal(Object.hasOwn(a, "generated"), false);
    assert.equal(Object.hasOwn(a, "derived"), false);
    const update = validateValue(schema, "Item", {}, "update") as UpdateContract;
    assert.equal(update["amount"], UPDATE_OMITTED);
    assert.equal(update["empty"], UPDATE_OMITTED);
    assert.equal(update["generated"], UPDATE_OMITTED);
  });

  it("keeps trim-before-bounds and explicit nested completeness in factory normalization", () => {
    const schema = normalizeSchema({ contracts: { Item: { fields: {
      label: { type: "text", trim: true, min: 1, max: 1, default: " x " },
    } } } });
    assert.equal(schema.contracts["Item"]!.fields["label"]!.default, "x");
    assert.throws(() => normalizeSchema({ contracts: {
      Inner: { fields: { label: { type: "text", default: "seed" } } },
      Outer: { fields: { inner: { type: "Inner", default: {} } } },
    } }), SchemaError);
  });

  it("runs each private/public semantic body once and preserves arbitrary thrown identity", () => {
    const { schema, owner, id } = preparedFixture();
    const thrown = { exact: "arbitrary thrown value" };
    for (const evaluate of [
      (wire: unknown) => validateValue(schema, "Item", wire, "create"),
      (wire: unknown) => validateValueTsCore(schema, "Item", wire, "create"),
      (wire: unknown) => validatePreparedValue(owner, id, schema, "Item", wire, "create"),
      (wire: unknown) => validateOperationInput(normalizeSchema({ operations: {
        read: { inputs: { name: { type: "text" } } },
      } }), "read", wire),
      (wire: unknown) => validateOperationInputTsCore(normalizeSchema({ operations: {
        read: { inputs: { name: { type: "text" } } },
      } }), "read", wire),
    ]) {
      let reads = 0;
      const wire = Object.defineProperty({}, "name", { enumerable: true, get() { reads++; throw thrown; } });
      assert.throws(() => evaluate(wire), (error: unknown) => error === thrown);
      assert.equal(reads, 1);
    }
    for (const evaluate of [decodeValue, decodeValueTsCore,
      (type: string, wire: unknown) => decodePreparedValue(owner, id, type, wire)]) {
      let reads = 0;
      const wire = new Proxy(["1"], { get(target, key, receiver) {
        if (key === "length") { reads++; throw thrown; }
        return Reflect.get(target, key, receiver);
      } });
      assert.throws(() => evaluate("int[]", wire), (error: unknown) => error === thrown);
      assert.equal(reads, 1);
    }
    for (const evaluate of [encodeValue, encodeValueTsCore,
      (type: string, value: CanValue) => encodePreparedValue(owner, id, type, value)]) {
      let reads = 0;
      const value = Object.defineProperty({}, "kind", { get() { reads++; throw thrown; } });
      assert.throws(() => evaluate("Item", value as CanValue), (error: unknown) => error === thrown);
      assert.equal(reads, 1);
    }
  });
});

describe("success-only factory lineage is not adoption", () => {
  it("records exact completed output and rejects descriptor/clone/frozen/manual/proxy identity", () => {
    const descriptor = {};
    const schema = normalizeSchema(descriptor);
    assert.equal(hasFactorySchemaLineage(schema), true);
    assert.equal(hasFactorySchemaLineage(descriptor), false);
    assert.equal(hasFactorySchemaLineage(Object.freeze({ ...schema })), false);
    assert.equal(hasFactorySchemaLineage(new Proxy(schema, {})), false);
    assert.equal(hasFactorySchemaLineage(null), false);
    assert.equal(hasFactorySchemaLineage("normalized-schema"), false);
    assert.throws(() => normalizeSchema(schema), SchemaError); // normalized output is not a descriptor
  });

  it("adds no candidate reads, grants nothing on failed normalization and never auto-registers", () => {
    const proxy = new Proxy({}, {
      get() { assert.fail("identity query read candidate"); },
      ownKeys() { assert.fail("identity query enumerated candidate"); },
      getOwnPropertyDescriptor() { assert.fail("identity query inspected candidate"); },
      getPrototypeOf() { assert.fail("identity query read prototype"); },
    });
    assert.equal(hasFactorySchemaLineage(proxy), false);
    const descriptor = { contracts: { Item: { fields: { amount: { type: "int", default: "broken" } } } } };
    assert.throws(() => normalizeSchema(descriptor), SchemaError);
    assert.equal(hasFactorySchemaLineage(descriptor), false);
    const schema = normalizeSchema({});
    const owner = createPlanOwner({ abiVersion: "values/v1", profileVersion: "validation/v1",
      backendId: "test", ownerRevision: "artifact-1" });
    assert.throws(() => registerValidationPlan(owner, "validation/v1", schema),
      (error: unknown) => error instanceof PlanError && error.code === "missing-provenance");
  });
});
