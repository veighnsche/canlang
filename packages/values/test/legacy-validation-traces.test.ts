import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isUpdateOmitted,
  normalizeSchema,
  validateValue,
  type NormalizedSchema,
  type ValidationMode,
} from "../src/schema.js";
import { decodeValue, encodeValue } from "../src/wire.js";
import { ValueError } from "../src/errors.js";
import {
  createPlanOwner,
  recordFactoryProvenance,
  registerValidationPlan,
  releaseValidationPlan,
  type PlanOwner,
} from "../src/prepared/plan.js";
import { decodePreparedValue, encodePreparedValue } from "../src/prepared/codec.js";
import {
  compareCodecCall,
  compareValidationCall,
  digestThrown,
  snapshotTrace,
  traceEqual,
  validatePreparedValue,
  type CallComparison,
} from "../src/prepared/validation.js";

function field(type: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return { type, ...(extra ?? {}) };
}

function contract(fields: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return { fields };
}

function owner(revision = "artifact-1:test"): PlanOwner {
  return createPlanOwner({
    abiVersion: "values/v1",
    profileVersion: "validation/v1",
    backendId: "test-backend",
    ownerRevision: revision,
  });
}

/** Same shop shape as the V02.1 plan tests: contracts, enum, union, operation. */
function shopDescriptor(): Record<string, unknown> {
  return {
    contracts: {
      Item: contract({
        name: field("text", { min: 1, max: 120, trim: true }),
        qty: field("int", { min: "1", max: "999", default: "3" }),
        note: field("text?", { default: "n/a" }),
        tags: field("text[]"),
        total: field("money", { min: { minor: "0", currency: "USD" } }),
      }),
      Sale: contract({
        item: field("Item"),
        outcome: field("Status|Item"),
        ref: field("text[]!"),
      }),
    },
    enums: { Status: { cases: ["open", "closed"] } },
    operations: {
      checkout: {
        inputs: {
          item: field("Item"),
          coupon: field("text", { default: "NONE" }),
        },
        mutation: true,
      },
    },
  };
}

/** normalize -> provenance (standing in for the V02.6 factory hook) -> register. */
function registeredPlan(descriptor: Record<string, unknown>, planOwner?: PlanOwner) {
  const own = planOwner ?? owner();
  const schema = normalizeSchema(descriptor);
  recordFactoryProvenance(schema, own.scope.ownerRevision);
  const id = registerValidationPlan(own, "validation/v1", schema);
  return { own, schema, id };
}

function itemWire(): Record<string, unknown> {
  return {
    name: "  sprocket  ",
    qty: "5",
    note: "hi",
    tags: ["a", "b"],
    total: { minor: "100", currency: "USD" },
  };
}

function assertAgree(cmp: CallComparison): void {
  assert.equal(cmp.preparedAbstained, false);
  assert.equal(cmp.agree, true);
}

// ---------------------------------------------------------------------------
// Validate agreement over the values matrix.
// ---------------------------------------------------------------------------

describe("validate agreement over the values matrix", () => {
  const leafRows: Array<[string, unknown]> = [
    ["int", "3"],
    ["bool", true],
    ["text", "hi"],
    ["decimal", "1.50"],
    ["money", { minor: "100", currency: "USD" }],
    ["date", "2026-01-02"],
    ["datetime", "2026-01-02T12:34:56.789Z"],
    ["duration", "1500"],
    ["email", "a@b.co"],
    ["url", "https://x.co"],
    ["enum(open,closed)", "open"],
    ["text?", null],
    ["text[]", ["a", "b"]],
  ];
  for (const [typeId, wire] of leafRows) {
    it(`create ${typeId} agrees`, () => {
      const { own, schema, id } = registeredPlan(shopDescriptor());
      assertAgree(compareValidationCall({ owner: own, planId: id, schema, typeId, wire, mode: "create" }));
    });
  }

  it("contract Item create agrees", () => {
    const { own, schema, id } = registeredPlan(shopDescriptor());
    assertAgree(
      compareValidationCall({ owner: own, planId: id, schema, typeId: "Item", wire: itemWire(), mode: "create" }),
    );
  });

  it("nested contract Sale create agrees", () => {
    const { own, schema, id } = registeredPlan(shopDescriptor());
    const wire = {
      item: itemWire(),
      outcome: { type: "Status", value: "open" },
      ref: ["r1"],
    };
    assertAgree(
      compareValidationCall({ owner: own, planId: id, schema, typeId: "Sale", wire, mode: "create" }),
    );
  });

  it("defaults applied agree", () => {
    const { own, schema, id } = registeredPlan(shopDescriptor());
    assertAgree(
      compareValidationCall({
        owner: own,
        planId: id,
        schema,
        typeId: "Item",
        wire: { name: "x", tags: [], total: { minor: "0", currency: "USD" } },
        mode: "create",
      }),
    );
  });

  it("update-mode partial agrees", () => {
    const { own, schema, id } = registeredPlan(shopDescriptor());
    assertAgree(
      compareValidationCall({
        owner: own,
        planId: id,
        schema,
        typeId: "Item",
        wire: { qty: "5" },
        mode: "update",
      }),
    );
  });

  const errorRows: Array<[string, string, unknown, ValidationMode]> = [
    ["required-missing", "Item", { qty: "5", tags: [], total: { minor: "0", currency: "USD" } }, "create"],
    ["bounds", "Item", { ...itemWire(), qty: "1000" }, "create"],
    ["unknown-member", "Item", { ...itemWire(), bogus: 1 }, "create"],
    ["bad-union", "Sale", { item: itemWire(), outcome: { type: "Nope", value: {} }, ref: ["r"] }, "create"],
    ["bad-decimal", "decimal", "1.5x", "create"],
    ["bad-currency", "money", { minor: "1", currency: "XX" }, "create"],
    ["bad-type-id", "int[", "3", "create"],
  ];
  for (const [label, typeId, wire, mode] of errorRows) {
    it(`error ${label} agrees`, () => {
      const { own, schema, id } = registeredPlan(shopDescriptor());
      const cmp = compareValidationCall({ owner: own, planId: id, schema, typeId, wire, mode });
      if (label === "bad-type-id") {
        // Uncovered type: prepared abstains, legacy reports the canonical error.
        assert.equal(cmp.preparedAbstained, true);
        assert.equal(cmp.legacy.ok, false);
      } else {
        assertAgree(cmp);
        assert.equal(cmp.legacy.ok, false);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Codec agreement.
// ---------------------------------------------------------------------------

describe("codec agreement", () => {
  const decodeRows: Array<[string, unknown]> = [
    ["int", "007"],
    ["bool", false],
    ["text", "hi"],
    ["decimal", "1.50"],
    ["money", { minor: "100", currency: "USD" }],
    ["date", "2026-01-02"],
    ["datetime", "2026-01-02T12:34:56.789Z"],
    ["duration", "1500"],
    ["enum(open,closed)", "closed"],
    ["Status", "open"],
    ["Item", itemWire()],
  ];
  for (const [typeId, wire] of decodeRows) {
    it(`decode ${typeId} agrees`, () => {
      const { own, id } = registeredPlan(shopDescriptor());
      assertAgree(compareCodecCall({ owner: own, planId: id, direction: "decode", typeId, value: wire }));
    });
  }

  it("encode round-trips agree", () => {
    const { own, id } = registeredPlan(shopDescriptor());
    const rows: Array<[string, unknown]> = [
      ["int", "007"],
      ["decimal", "1.50"],
      ["money", { minor: "100", currency: "USD" }],
      ["date", "2026-01-02"],
      ["datetime", "2026-01-02T12:34:56.789Z"],
      ["enum(open,closed)", "closed"],
    ];
    for (const [typeId, wire] of rows) {
      const canon = decodeValue(typeId, wire);
      const cmp = compareCodecCall({ owner: own, planId: id, direction: "encode", typeId, value: canon });
      assertAgree(cmp);
    }
  });

  it("secret encode throws identically on both paths", () => {
    const { own, id } = registeredPlan(shopDescriptor());
    const cmp = compareCodecCall({
      owner: own,
      planId: id,
      direction: "encode",
      typeId: "secret",
      value: "nope",
    });
    assertAgree(cmp);
    assert.equal(cmp.legacy.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Legacy trace pins (dual-path: legacy pin AND prepared pin).
// ---------------------------------------------------------------------------

describe("legacy trace pins", () => {
  it("int decode pins 7n on both paths", () => {
    const { own, id } = registeredPlan(shopDescriptor());
    assert.equal(decodeValue("int", "007"), 7n);
    assert.equal(decodePreparedValue(own, id, "int", "007"), 7n);
    assert.equal(encodeValue("int", 7n), "7");
    assert.equal(encodePreparedValue(own, id, "int", 7n), "7");
  });

  it("Item create pins canon output on both paths", () => {
    const { own, schema, id } = registeredPlan(shopDescriptor());
    const expected = {
      name: "sprocket",
      qty: 5n,
      note: "hi",
      tags: ["a", "b"],
      total: { kind: "money", minor: 100n, currency: "USD" },
    };
    assert.deepEqual(validateValue(schema, "Item", itemWire(), "create"), expected);
    assert.deepEqual(validatePreparedValue(own, id, schema, "Item", itemWire(), "create"), expected);
  });

  it("defaults pin qty 3n + note n/a on both paths", () => {
    const { own, schema, id } = registeredPlan(shopDescriptor());
    const wire = { name: "x", tags: [], total: { minor: "0", currency: "USD" } };
    for (const out of [
      validateValue(schema, "Item", wire, "create"),
      validatePreparedValue(own, id, schema, "Item", wire, "create"),
    ]) {
      const item = out as Record<string, unknown>;
      assert.equal(item["qty"], 3n);
      assert.equal(item["note"], "n/a");
    }
  });

  it("required-missing pins the violation on both paths", () => {
    const { own, schema, id } = registeredPlan(shopDescriptor());
    const wire = { qty: "5", tags: [], total: { minor: "0", currency: "USD" } };
    const digests = [];
    try {
      validateValue(schema, "Item", wire, "create");
      assert.fail("legacy must throw");
    } catch (thrown) {
      digests.push(digestThrown(thrown));
    }
    try {
      validatePreparedValue(own, id, schema, "Item", wire, "create");
      assert.fail("prepared must throw");
    } catch (thrown) {
      digests.push(digestThrown(thrown));
    }
    assert.equal(digests.length, 2);
    for (const digest of digests) {
      assert.equal(digest.name, "SchemaError");
      assert.equal(digest.kind, "schema");
      const violations = digest.violations as Array<Record<string, unknown>>;
      assert.equal(violations.length, 1);
      assert.deepEqual(violations[0]!["path"], ["name"]);
      assert.equal(violations[0]!["code"], "required");
    }
    assert.ok(traceEqual(digests[0], digests[1]));
  });

  it("update omission pins UPDATE_OMITTED on both paths", () => {
    const { own, schema, id } = registeredPlan(shopDescriptor());
    for (const out of [
      validateValue(schema, "Item", { qty: "5" }, "update"),
      validatePreparedValue(own, id, schema, "Item", { qty: "5" }, "update"),
    ]) {
      const item = out as Record<string, unknown>;
      assert.equal(item["qty"], 5n);
      assert.ok(isUpdateOmitted(item["name"]));
      assert.ok(isUpdateOmitted(item["tags"]));
    }
  });

  it("money round-trip pins stable wire on both paths", () => {
    const { own, id } = registeredPlan(shopDescriptor());
    const wire = { minor: "100", currency: "USD" };
    assert.deepEqual(decodeValue("money", wire), { kind: "money", minor: 100n, currency: "USD" });
    assert.deepEqual(decodePreparedValue(own, id, "money", wire), {
      kind: "money",
      minor: 100n,
      currency: "USD",
    });
    const canon = decodeValue("money", wire);
    assert.deepEqual(encodeValue("money", canon), wire);
    assert.deepEqual(encodePreparedValue(own, id, "money", canon), wire);
  });
});

// ---------------------------------------------------------------------------
// Getter discipline.
// ---------------------------------------------------------------------------

describe("getter discipline", () => {
  it("snapshotTrace never invokes accessors", () => {
    let calls = 0;
    const probe = {
      get boom(): unknown {
        calls++;
        throw new Error("must not run");
      },
      get counted(): unknown {
        calls++;
        return 1;
      },
      plain: [1, 2n, "x"],
    };
    const snap = snapshotTrace(probe) as Record<string, unknown>;
    assert.equal(calls, 0);
    assert.deepEqual(snap["boom"], { $getter: true, setter: false });
    assert.deepEqual(snap["counted"], { $getter: true, setter: false });
    assert.deepEqual(snap["plain"], [1, { $bigint: "2" }, "x"]);
    assert.equal(calls, 0);
  });

  it("comparator adds zero getter invocations beyond the two legacy runs", () => {
    const { own, schema, id } = registeredPlan(shopDescriptor());
    const makeWire = (counter: { calls: number }): Record<string, unknown> => {
      const wire = itemWire();
      Object.defineProperty(wire, "qty", {
        enumerable: true,
        configurable: true,
        get() {
          counter.calls++;
          return "5";
        },
      });
      return wire;
    };
    const single = { calls: 0 };
    validateValue(schema, "Item", makeWire(single), "create");
    assert.ok(single.calls >= 1, "getter must be reachable by legacy");
    const compared = { calls: 0 };
    const cmp = compareValidationCall({
      owner: own,
      planId: id,
      schema,
      typeId: "Item",
      wire: makeWire(compared),
      mode: "create",
    });
    assertAgree(cmp);
    assert.equal(compared.calls, single.calls * 2);
    const input = cmp.input as Record<string, unknown>;
    assert.deepEqual(input["qty"], { $getter: true, setter: false });
  });

  it("traceEqual compares accessors by identity, never by value", () => {
    const get = (): unknown => 1;
    assert.ok(traceEqual({ get x(): unknown { return 1; } }, { get x(): unknown { return 2; } }) === false);
    assert.ok(traceEqual(Object.defineProperty({}, "v", { get, enumerable: true }), Object.defineProperty({}, "v", { get, enumerable: true })));
    assert.ok(!traceEqual(Object.defineProperty({}, "v", { get, enumerable: true }), { v: 1 }));
  });

  it("digestThrown pins fields and excludes the stack", () => {
    const digest = digestThrown(new ValueError("invalid-construction", "demo message"));
    assert.equal(digest.name, "ValueError");
    assert.equal(digest.kind, "value");
    assert.equal(digest.code, "invalid-construction");
    assert.equal(digest.message, "demo message");
    assert.ok(!("stack" in (digest as unknown as Record<string, unknown>)));
    assert.deepEqual(digestThrown(42), { name: "number", message: "non-object thrown" });
  });
});

// ---------------------------------------------------------------------------
// Abstention keeps full legacy scope.
// ---------------------------------------------------------------------------

describe("abstention keeps full legacy scope", () => {
  it("hand-built frozen schema abstains; legacy still validates", () => {
    const { own, id } = registeredPlan(shopDescriptor());
    const handBuilt = Object.freeze({
      kind: "normalized-schema",
      contracts: Object.freeze({}),
      enums: Object.freeze({}),
      operations: Object.freeze({}),
    }) as unknown as NormalizedSchema;
    const cmp = compareValidationCall({
      owner: own,
      planId: id,
      schema: handBuilt,
      typeId: "int",
      wire: "3",
      mode: "create",
    });
    assert.equal(cmp.preparedAbstained, true);
    assert.equal(cmp.agree, false);
    assert.deepEqual(cmp.legacy, { ok: true, snapshot: { $bigint: "3" } });
  });

  it("unknown nominal type abstains the codec; legacy runs full scope", () => {
    const { own, id } = registeredPlan(shopDescriptor());
    const cmp = compareCodecCall({
      owner: own,
      planId: id,
      direction: "decode",
      typeId: "Nope",
      value: "x",
    });
    assert.equal(cmp.preparedAbstained, true);
    let expected: unknown;
    try {
      expected = { ok: true, snapshot: snapshotTrace(decodeValue("Nope", "x")) };
    } catch (thrown) {
      expected = { ok: false, error: digestThrown(thrown) };
    }
    assert.ok(traceEqual(cmp.legacy, expected));
  });

  it("released plan abstains; legacy unaffected", () => {
    const { own, schema, id } = registeredPlan(shopDescriptor());
    releaseValidationPlan(own, id);
    const cmp = compareValidationCall({
      owner: own,
      planId: id,
      schema,
      typeId: "int",
      wire: "3",
      mode: "create",
    });
    assert.equal(cmp.preparedAbstained, true);
    assert.deepEqual(cmp.legacy, { ok: true, snapshot: { $bigint: "3" } });
  });

  it("foreign owner abstains with the foreign-owner code", () => {
    const { schema, id } = registeredPlan(shopDescriptor());
    const cmp = compareValidationCall({
      owner: {},
      planId: id,
      schema,
      typeId: "int",
      wire: "3",
      mode: "create",
    });
    assert.equal(cmp.preparedAbstained, true);
    const prepared = cmp.prepared as { abstained: true; error: { code: string } };
    assert.equal(prepared.error.code, "foreign-owner");
    assert.deepEqual(cmp.legacy, { ok: true, snapshot: { $bigint: "3" } });
  });

  it("different schema abstains on mismatch; legacy validates it fully", () => {
    const { own, id } = registeredPlan(shopDescriptor());
    const other = normalizeSchema({
      ...shopDescriptor(),
      contracts: {
        ...(shopDescriptor()["contracts"] as Record<string, unknown>),
        Extra: contract({ f: field("int") }),
      },
    });
    const cmp = compareValidationCall({
      owner: own,
      planId: id,
      schema: other,
      typeId: "Extra",
      wire: { f: "1" },
      mode: "create",
    });
    assert.equal(cmp.preparedAbstained, true);
    assert.deepEqual(cmp.legacy, {
      ok: true,
      snapshot: { f: { $bigint: "1" } },
    });
  });

  it("coverage abstention pins the unknown-plan code", () => {
    const { own, id } = registeredPlan(shopDescriptor());
    const cmp = compareCodecCall({
      owner: own,
      planId: id,
      direction: "encode",
      typeId: "Missing",
      value: {},
    });
    assert.equal(cmp.preparedAbstained, true);
    const prepared = cmp.prepared as { abstained: true; error: { code: string; name: string } };
    assert.equal(prepared.error.name, "PlanError");
    assert.equal(prepared.error.code, "unknown-plan");
  });
});

// ---------------------------------------------------------------------------
// Independent adoptability.
// ---------------------------------------------------------------------------

describe("independent adoptability", () => {
  it("frozen wire inputs agree (neither path mutates inputs)", () => {
    const { own, schema, id } = registeredPlan(shopDescriptor());
    const wire = Object.freeze({
      name: "x",
      qty: "5",
      note: null,
      tags: Object.freeze(["a"]),
      total: Object.freeze({ minor: "1", currency: "USD" }),
    });
    assertAgree(
      compareValidationCall({ owner: own, planId: id, schema, typeId: "Item", wire, mode: "create" }),
    );
    assertAgree(
      compareCodecCall({ owner: own, planId: id, direction: "decode", typeId: "Item", value: wire }),
    );
  });

  it("prepared results are fresh values with no shared-state leak", () => {
    const { own, schema, id } = registeredPlan(shopDescriptor());
    const wire = itemWire();
    const first = validatePreparedValue(own, id, schema, "Item", wire, "create") as Record<string, unknown>;
    assert.ok(first !== (wire as unknown));
    const second = validatePreparedValue(own, id, schema, "Item", wire, "create") as Record<string, unknown>;
    assert.deepEqual(second["tags"], ["a", "b"]);
    // Distinct objects, structurally identical: no shared-state leak.
    assert.ok(first !== (second as unknown));
    assert.ok(first["tags"] !== second["tags"]);
    assert.ok(first["total"] !== second["total"]);
    assert.ok(traceEqual(first, second));
  });

  it("legacy entry points keep full scope with prepared present but uninvolved", () => {
    const schema = normalizeSchema(shopDescriptor());
    assert.equal(decodeValue("int", "007"), 7n);
    assert.equal(encodeValue("int", 7n), "7");
    const out = validateValue(schema, "Item", itemWire(), "create") as Record<string, unknown>;
    assert.equal(out["qty"], 5n);
    assert.equal(out["name"], "sprocket");
  });
});
