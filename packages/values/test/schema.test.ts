import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CanValue, ContractValue, Violation } from "@canlang/contracts/values";
import { Decimal } from "../src/decimal.js";
import { SchemaError, ValueError } from "../src/errors.js";
import { makeMoney, makeRecordRef, makeUnionValue } from "../src/kinds.js";
import {
  isUpdateOmitted,
  normalizeSchema,
  normalizeValueTypes,
  ValueTypesError,
  UPDATE_OMITTED,
  validateOperationInput,
  validateValue,
  type NormalizedSchema,
  type UpdateContract,
} from "../src/schema.js";
import { decodeValue, encodeValue } from "../src/wire.js";
import { createPlanOwner, PlanError, recordFactoryProvenance, registerValidationPlan } from "../src/prepared/plan.js";
import { validatePreparedValue } from "../src/prepared/validation.js";

function assertSchemaError(fn: () => unknown): Violation[] {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SchemaError, `expected SchemaError, got ${String(err)}`);
    assert.ok(!("code" in (err as object)), "SchemaError must not carry a business `code` field");
    assert.ok(Object.isFrozen(err.violations), "violations are frozen");
    return [...err.violations];
  }
  assert.fail("expected SchemaError, but nothing was thrown");
}

function codesOf(violations: ReadonlyArray<Violation>): string[] {
  return violations.map((v) => `${JSON.stringify([...v.path])}:${JSON.stringify(v.code)}`);
}

function field(type: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return { type, ...(extra ?? {}) };
}

function contract(fields: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return { fields };
}

/** Shared fixture: contracts/enums/operations exercising every feature. */
function shopSchema(): NormalizedSchema {
  return normalizeSchema({
    contracts: {
      Address: contract({
        street: field("text", { min: 1, max: 120 }),
        city: field("text"),
        zip: field("text?"),
        note: field("text", { default: "n/a" }),
      }),
      Line: contract({
        sku: field("text"),
        qty: field("int", { min: "1", max: "999" }),
        price: field("money"),
      }),
      Order: contract({
        id: field("text"),
        customer: field("Customer"),
        shipTo: field("Address"),
        billTo: field("Address|Customer"),
        lines: field("Line[]"),
        tags: field("text[]!"),
        status: field("Status"),
        total: field("money", { min: { minor: "0", currency: "USD" } }),
        placed: field("datetime?"),
        priority: field("int", { default: "3" }),
      }),
      Bounds: contract({
        n: field("int", { min: "1", max: "10" }),
        t: field("text", { min: 2, max: 4 }),
        arr: field("int[]", { min: 1, max: 3 }),
        m: field("money", { max: { minor: "100", currency: "USD" } }),
        d: field("date", { min: "2026-01-01", max: "2026-12-31" }),
        dt: field("datetime", { min: "2026-01-01T00:00:00.000Z" }),
        dec: field("decimal", { max: "9.99" }),
        dur: field("duration", { min: "0" }),
      }),
      Req: contract({
        a: field("text"),
        b: field("text?"),
        c: field("text", { default: "d" }),
        d: field("text[]"),
        e: field("text[]!"),
        f: field("text[]?"),
        g: field("text[]", { default: ["x"] }),
      }),
      Misc: contract({
        e: field("enum(a,b)"),
        act: field("action(Op)"),
        del: field("delivery(Op)"),
      }),
    },
    enums: {
      Status: { cases: ["open", "paid", "shipped"] },
    },
    operations: {
      searchOrders: {
        inputs: {
          q: field("text?"),
          limit: field("int", { default: "25", min: "1", max: "100" }),
        },
      },
      placeOrder: {
        inputs: {
          order: field("Order"),
          customer: field("Customer"),
        },
        mutation: true,
      },
      assignWitnesses: {
        inputs: {
          witnesses: field("Customer[]"),
        },
        mutation: true,
      },
      notify: {
        inputs: {
          dest: field("Address|Customer"),
        },
        mutation: true,
      },
    },
  });
}

function validOrder(): Record<string, unknown> {
  return {
    id: "o1",
    customer: { id: "c1" },
    shipTo: { street: "Main", city: "Springfield" },
    billTo: { type: "Customer", value: { id: "c2" } },
    lines: [{ sku: "s1", qty: "2", price: { minor: "100", currency: "USD" } }],
    tags: ["new"],
    status: "open",
    total: { minor: "100", currency: "USD" },
  };
}

/** validOrder with an expected version on every nested ref (mutations require them). */
function versionedOrder(): Record<string, unknown> {
  return {
    ...validOrder(),
    customer: { id: "c1", version: "1" },
    billTo: { type: "Customer", value: { id: "c2", version: "2" } },
  };
}

describe("normalizeSchema valid", () => {
  it("normalizes the shop fixture and freezes everything", () => {
    const schema = shopSchema();
    assert.ok(Object.isFrozen(schema));
    assert.ok(Object.isFrozen(schema.contracts));
    assert.ok(Object.isFrozen(schema.enums));
    assert.ok(Object.isFrozen(schema.operations));
    const order = schema.contracts["Order"];
    assert.ok(order !== undefined && Object.isFrozen(order) && Object.isFrozen(order.fields));
    const status = schema.enums["Status"];
    assert.ok(status !== undefined && Object.isFrozen(status.cases));
    assert.deepEqual(status.cases, ["open", "paid", "shipped"]);
    const priority = order.fields["priority"];
    assert.ok(priority !== undefined);
    assert.equal(priority.hasDefault, true);
    assert.equal(priority.default, 3n);
    assert.equal(priority.typeId, "int");
  });

  it("derives required exactly from type shape and defaults", () => {
    const schema = shopSchema();
    const req = schema.contracts["Req"];
    assert.ok(req !== undefined);
    const required: Record<string, boolean> = {};
    for (const [name, f] of Object.entries(req.fields)) {
      required[name] = f.required;
    }
    assert.deepEqual(required, { a: true, b: false, c: false, d: false, e: true, f: false, g: false });
  });

  it("accepts empty sections and an empty descriptor", () => {
    const schema = normalizeSchema({ contracts: {}, enums: {}, operations: {} });
    assert.deepEqual(Object.keys(schema.contracts), []);
    const bare = normalizeSchema({});
    assert.deepEqual(Object.keys(bare.operations), []);
  });

  it("validates explicit-complete contract defaults including nullable leaves", () => {
    const schema = normalizeSchema({
      contracts: {
        C1: contract({ n: field("text?"), b: field("text") }),
        C2: contract({ c: field("C1", { default: { b: "y" } }) }),
      },
    });
    const c = schema.contracts["C2"]?.fields["c"];
    assert.ok(c !== undefined);
    assert.deepEqual(c.default, { n: null, b: "y" });
    assert.ok(Object.isFrozen(c.default));
  });

  it("keeps each field's default independent (reuse drops defaults)", () => {
    // Descriptors carry no inherited initializers: two int fields declare
    // their own defaults (or none) without cross-talk.
    const schema = shopSchema();
    const qty = schema.contracts["Line"]?.fields["qty"];
    const priority = schema.contracts["Order"]?.fields["priority"];
    assert.ok(qty !== undefined && priority !== undefined);
    assert.equal(qty.hasDefault, false);
    assert.equal(priority.hasDefault, true);
    assert.equal(priority.default, 3n);
  });

  it("accepts constructor as a declared field name end to end", () => {
    // Only __proto__ is reserved: constructor is a safe own key through
    // normalize, validate, and the wire codec.
    const schema = normalizeSchema({ contracts: { C: contract({ constructor: field("text") }) } });
    const out = validateValue(schema, "C", { constructor: "hi" }, "create") as ContractValue;
    assert.ok(Object.hasOwn(out, "constructor"));
    assert.deepEqual(out, { constructor: "hi" });
    const wire = encodeValue("C", out as CanValue);
    assert.deepEqual(wire, { constructor: "hi" });
    assert.deepEqual(decodeValue("C", wire), { constructor: "hi" });
  });
});

// [name, descriptor, expected path:code list]
const INVALID_DESCRIPTORS: ReadonlyArray<readonly [string, unknown, ReadonlyArray<string>]> = [
  ["non-object", 5, ['[]:"type"']],
  ["unknown section", { models: {} }, ['["models"]:"unknown-field"']],
  ["contracts non-object", { contracts: 5 }, ['["contracts"]:"type"']],
  ["contract bad name", { contracts: { "9x": contract({}) } }, ['["contracts","9x"]:"format"']],
  [
    "contract __proto__ name is reserved",
    { contracts: { ["__proto__"]: contract({}) } },
    ['["contracts","__proto__"]:"format"'],
  ],
  ["contract non-object", { contracts: { A: 5 } }, ['["contracts","A"]:"type"']],
  ["contract unknown key", { contracts: { A: { fields: {}, x: 1 } } }, ['["contracts","A","x"]:"unknown-field"']],
  ["contract missing fields", { contracts: { A: {} } }, ['["contracts","A","fields"]:"required"']],
  ["contract fields non-object", { contracts: { A: { fields: 5 } } }, ['["contracts","A","fields"]:"type"']],
  [
    "field bad name",
    { contracts: { A: contract({ "a.b": field("text") }) } },
    ['["contracts","A","fields","a.b"]:"format"'],
  ],
  [
    "field __proto__ name is reserved",
    { contracts: { A: contract({ ["__proto__"]: field("text") }) } },
    ['["contracts","A","fields","__proto__"]:"format"'],
  ],
  ["field non-object", { contracts: { A: contract({ f: 5 as never }) } }, ['["contracts","A","fields","f"]:"type"']],
  [
    "field unique key rejected (lane-03 owns uniqueness)",
    { contracts: { A: contract({ f: field("text", { unique: true }) }) } },
    ['["contracts","A","fields","f","unique"]:"unknown-field"'],
  ],
  [
    "field trim on array rejected (text leaves only)",
    { contracts: { A: contract({ f: field("text[]", { trim: true }) }) } },
    ['["contracts","A","fields","f","trim"]:"type"'],
  ],
  [
    "field trim on int rejected (text leaves only)",
    { contracts: { A: contract({ f: field("int", { trim: true }) }) } },
    ['["contracts","A","fields","f","trim"]:"type"'],
  ],
  [
    "field trim on union rejected (text leaves only)",
    { contracts: { A: contract({ f: field("X|Y", { trim: true }) }) } },
    ['["contracts","A","fields","f","trim"]:"type"'],
  ],
  [
    "field trim on nominal rejected (text leaves only)",
    { contracts: { A: contract({ f: field("Todo", { trim: true }) }) } },
    ['["contracts","A","fields","f","trim"]:"type"'],
  ],
  [
    "field trim non-boolean rejected",
    { contracts: { A: contract({ f: field("text", { trim: "yes" }) }) } },
    ['["contracts","A","fields","f","trim"]:"type"'],
  ],
  [
    "field missing type",
    { contracts: { A: { fields: { f: { min: 1 } } } } },
    ['["contracts","A","fields","f","type"]:"required"'],
  ],
  [
    "field type non-string",
    { contracts: { A: { fields: { f: { type: 5 } } } } },
    ['["contracts","A","fields","f","type"]:"type"'],
  ],
  [
    "field type bad id",
    { contracts: { A: contract({ f: field("int?[]") }) } },
    ['["contracts","A","fields","f","type"]:"format"'],
  ],
  [
    "required-array marker rejected on operation inputs",
    { operations: { op: { inputs: { xs: field("text[]!") } } } },
    ['["operations","op","inputs","xs","type"]:"format"'],
  ],
  [
    "required-array field cannot have a default",
    { contracts: { A: contract({ f: field("text[]!", { default: [] }) }) } },
    ['["contracts","A","fields","f","default"]:"format"'],
  ],
  ["bounds on bool", { contracts: { A: contract({ f: field("bool", { min: 1 }) }) } }, [
    '["contracts","A","fields","f","min"]:"type"',
  ]],
  ["bounds on enum()", { contracts: { A: contract({ f: field("enum(a,b)", { max: 2 }) }) } }, [
    '["contracts","A","fields","f","max"]:"type"',
  ]],
  ["bounds on union", { contracts: { A: contract({ f: field("X|Y", { min: 1 }) }) } }, [
    '["contracts","A","fields","f","min"]:"type"',
  ]],
  ["bounds on nominal", { contracts: { A: contract({ f: field("Todo", { min: "1" }) }) } }, [
    '["contracts","A","fields","f","min"]:"type"',
  ]],
  ["bounds on user", { contracts: { A: contract({ f: field("user", { min: 1 }) }) } }, [
    '["contracts","A","fields","f","min"]:"type"',
  ]],
  [
    "length bound non-number",
    { contracts: { A: contract({ f: field("text", { min: "2" }) }) } },
    ['["contracts","A","fields","f","min"]:"type"'],
  ],
  [
    "length bound negative",
    { contracts: { A: contract({ f: field("text", { min: -1 }) }) } },
    ['["contracts","A","fields","f","min"]:"format"'],
  ],
  [
    "length bound fractional",
    { contracts: { A: contract({ f: field("text[]", { max: 1.5 }) }) } },
    ['["contracts","A","fields","f","max"]:"format"'],
  ],
  [
    "value bound malformed wire",
    { contracts: { A: contract({ f: field("int", { min: "x" }) }) } },
    ['["contracts","A","fields","f","min"]:"format"'],
  ],
  [
    "length min above max",
    { contracts: { A: contract({ f: field("text", { min: 3, max: 2 }) }) } },
    ['["contracts","A","fields","f","max"]:"bound"'],
  ],
  [
    "value min above max",
    { contracts: { A: contract({ f: field("int", { min: "5", max: "2" }) }) } },
    ['["contracts","A","fields","f","max"]:"bound"'],
  ],
  [
    "money bounds need matching currencies",
    {
      contracts: {
        A: contract({
          f: field("money", { min: { minor: "0", currency: "USD" }, max: { minor: "9", currency: "EUR" } }),
        }),
      },
    },
    ['["contracts","A","fields","f","max"]:"bound"'],
  ],
  [
    "default with wrong type",
    { contracts: { A: contract({ f: field("int", { default: "x" }) }) } },
    ['["contracts","A","fields","f","default"]:"format"'],
  ],
  [
    "default violating bounds",
    { contracts: { A: contract({ f: field("int", { min: "1", default: "0" }) }) } },
    ['["contracts","A","fields","f","default"]:"bound"'],
  ],
  [
    "default null on nonnullable",
    { contracts: { A: contract({ f: field("int", { default: null }) }) } },
    ['["contracts","A","fields","f","default"]:"type"'],
  ],
  [
    "default missing nested defaulted field (no composition)",
    {
      contracts: {
        C1: contract({ a: field("text", { default: "x" }), b: field("text") }),
        C2: contract({ c: field("C1", { default: { b: "y" } }) }),
      },
    },
    ['["contracts","C2","fields","c","default","a"]:"required"'],
  ],
  ["enum non-object", { enums: { S: 5 } }, ['["enums","S"]:"type"']],
  ["enum unknown key", { enums: { S: { cases: ["a"], x: 1 } } }, ['["enums","S","x"]:"unknown-field"']],
  ["enum missing cases", { enums: { S: {} } }, ['["enums","S","cases"]:"required"']],
  ["enum cases non-array", { enums: { S: { cases: "a" } } }, ['["enums","S","cases"]:"type"']],
  ["enum cases empty", { enums: { S: { cases: [] } } }, ['["enums","S","cases"]:"format"']],
  ["enum case non-string", { enums: { S: { cases: [5] } } }, ['["enums","S","cases",0]:"type"']],
  ["enum case duplicate", { enums: { S: { cases: ["a", "a"] } } }, ['["enums","S","cases",1]:"format"']],
  ["enum case bad name", { enums: { S: { cases: ["a.b"] } } }, ['["enums","S","cases",0]:"format"']],
  [
    "enum __proto__ name is reserved",
    { enums: { ["__proto__"]: { cases: ["a"] } } },
    ['["enums","__proto__"]:"format"'],
  ],
  [
    "contract and enum share a name",
    { contracts: { S: contract({}) }, enums: { S: { cases: ["a"] } } },
    ['["enums","S"]:"type"'],
  ],
  ["operation non-object", { operations: { op: 5 } }, ['["operations","op"]:"type"']],
  [
    "operation unknown key",
    { operations: { op: { inputs: {}, x: 1 } } },
    ['["operations","op","x"]:"unknown-field"'],
  ],
  ["operation mutation non-boolean", { operations: { op: { inputs: {}, mutation: 1 } } }, [
    '["operations","op","mutation"]:"type"',
  ]],
  ["operation missing inputs", { operations: { op: {} } }, ['["operations","op","inputs"]:"required"']],
  ["operation inputs non-object", { operations: { op: { inputs: 5 } } }, ['["operations","op","inputs"]:"type"']],
  [
    "operation_id is reserved as an input",
    { operations: { op: { inputs: { operation_id: field("text") } } } },
    ['["operations","op","inputs","operation_id"]:"format"'],
  ],
  [
    "operation input bad name",
    { operations: { op: { inputs: { "a.b": field("text") } } } },
    ['["operations","op","inputs","a.b"]:"format"'],
  ],
  [
    "operation __proto__ name is reserved",
    { operations: { ["__proto__"]: { inputs: {} } } },
    ['["operations","__proto__"]:"format"'],
  ],
  [
    "operation input __proto__ name is reserved",
    { operations: { op: { inputs: { ["__proto__"]: field("text") } } } },
    ['["operations","op","inputs","__proto__"]:"format"'],
  ],
];

describe("normalizeSchema invalid", () => {
  for (const [name, descriptor, expected] of INVALID_DESCRIPTORS) {
    it(`rejects ${name}`, () => {
      assert.deepEqual(codesOf(assertSchemaError(() => normalizeSchema(descriptor))), [...expected]);
    });
  }
});

describe("validateValue create", () => {
  it("validates a full order with defaults, nullables and implicit arrays", () => {
    const schema = shopSchema();
    const out = validateValue(schema, "Order", validOrder(), "create") as ContractValue;
    assert.equal(out["id"], "o1");
    assert.deepEqual(out["customer"], makeRecordRef("Customer", "c1"));
    assert.deepEqual(out["shipTo"], { street: "Main", city: "Springfield", zip: null, note: "n/a" });
    assert.deepEqual(out["billTo"], makeUnionValue("Customer", makeRecordRef("Customer", "c2")));
    assert.equal((out["lines"] as unknown[]).length, 1);
    assert.deepEqual(out["tags"], ["new"]);
    assert.equal(out["status"], "open");
    assert.deepEqual(out["total"], makeMoney(100n, "USD"));
    assert.equal(out["placed"], null);
    assert.equal(out["priority"], 3n);
    assert.ok(Object.isFrozen(out));
    assert.ok(Object.isFrozen(out["shipTo"]));
    assert.ok(Object.isFrozen(out["lines"]));
  });

  it("fills implicit empty arrays and applies array defaults", () => {
    const schema = shopSchema();
    const wire = { ...validOrder() } as Record<string, unknown>;
    delete wire["lines"];
    const out = validateValue(schema, "Order", wire, "create") as ContractValue;
    assert.deepEqual(out["lines"], []);
    const req = validateValue(schema, "Req", { a: "x", e: ["y"] }, "create") as ContractValue;
    assert.deepEqual(req, { a: "x", b: null, c: "d", d: [], e: ["y"], f: null, g: ["x"] });
    // T[]? omitted yields null: nullability wins over the [] default.
    assert.equal(req["f"], null);
  });

  it("rejects unknown fields and never returns a partial value", () => {
    const schema = shopSchema();
    const wire = { ...validOrder(), extra: 1, shipTo: { street: "Main", city: "S", bogus: true } };
    const violations = assertSchemaError(() => validateValue(schema, "Order", wire, "create"));
    assert.deepEqual(codesOf(violations), ['["extra"]:"unknown-field"', '["shipTo","bogus"]:"unknown-field"']);
  });

  it("reports every missing required field in one error", () => {
    const schema = shopSchema();
    const violations = assertSchemaError(() => validateValue(schema, "Order", {}, "create"));
    assert.deepEqual(codesOf(violations), [
      '["id"]:"required"',
      '["customer"]:"required"',
      '["shipTo"]:"required"',
      '["billTo"]:"required"',
      '["tags"]:"required"',
      '["status"]:"required"',
      '["total"]:"required"',
    ]);
  });

  it("distinguishes explicit null from omission", () => {
    const schema = shopSchema();
    assert.deepEqual(
      codesOf(assertSchemaError(() => validateValue(schema, "Order", { ...validOrder(), id: null }, "create"))),
      ['["id"]:"type"'],
    );
    assert.deepEqual(
      codesOf(assertSchemaError(() => validateValue(schema, "Order", { ...validOrder(), tags: null }, "create"))),
      ['["tags"]:"type"'],
    );
    const out = validateValue(schema, "Order", { ...validOrder(), placed: null }, "create") as ContractValue;
    assert.equal(out["placed"], null);
  });

  it("enforces inclusive value and length bounds", () => {
    const schema = shopSchema();
    const check = (patch: Record<string, unknown>): string[] =>
      codesOf(
        assertSchemaError(() =>
          validateValue(
            schema,
            "Bounds",
            {
              n: "5",
              t: "abc",
              arr: ["1"],
              m: { minor: "50", currency: "USD" },
              d: "2026-06-01",
              dt: "2026-06-01T00:00:00.000Z",
              dec: "1.5",
              dur: "5",
              ...patch,
            },
            "create",
          ),
        ),
      );
    assert.deepEqual(check({ n: "0" }), ['["n"]:"bound"']);
    assert.deepEqual(check({ n: "11" }), ['["n"]:"bound"']);
    assert.deepEqual(check({ t: "a" }), ['["t"]:"bound"']);
    assert.deepEqual(check({ t: "abcde" }), ['["t"]:"bound"']);
    assert.deepEqual(check({ arr: [] }), ['["arr"]:"bound"']);
    assert.deepEqual(check({ arr: ["1", "2", "3", "4"] }), ['["arr"]:"bound"']);
    assert.deepEqual(check({ m: { minor: "50", currency: "EUR" } }), ['["m"]:"bound"']);
    assert.deepEqual(check({ m: { minor: "101", currency: "USD" } }), ['["m"]:"bound"']);
    assert.deepEqual(check({ d: "2025-12-31" }), ['["d"]:"bound"']);
    assert.deepEqual(check({ d: "2027-01-01" }), ['["d"]:"bound"']);
    assert.deepEqual(check({ dt: "2025-12-31T23:59:59.999Z" }), ['["dt"]:"bound"']);
    assert.deepEqual(check({ dec: "10" }), ['["dec"]:"bound"']);
    assert.deepEqual(check({ dur: "-1" }), ['["dur"]:"bound"']);
    // Edges are inclusive: all of these validate cleanly.
    validateValue(
      schema,
      "Bounds",
      {
        n: "1",
        t: "ab",
        arr: ["1", "2", "3"],
        m: { minor: "100", currency: "USD" },
        d: "2026-12-31",
        dt: "2026-01-01T00:00:00.000Z",
        dec: "9.99",
        dur: "0",
      },
      "create",
    );
  });

  it("reports money currency mismatches with single-encoded wire actual", () => {
    const schema = shopSchema();
    const violations = assertSchemaError(() =>
      validateValue(
        schema,
        "Bounds",
        {
          n: "5",
          t: "abc",
          arr: ["1"],
          m: { minor: "50", currency: "EUR" },
          d: "2026-06-01",
          dt: "2026-06-01T00:00:00.000Z",
          dec: "1.5",
          dur: "5",
        },
        "create",
      ),
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.message, "money bound needs a matching currency");
    assert.equal(violations[0]?.expected, "currency USD");
    assert.equal(violations[0]?.actual, '{"minor":"50","currency":"EUR"}');
  });

  it("validates named enums, model refs and unions at the top level", () => {
    const schema = shopSchema();
    assert.equal(validateValue(schema, "Status", "paid", "create"), "paid");
    assert.deepEqual(
      codesOf(assertSchemaError(() => validateValue(schema, "Status", "done", "create"))),
      ['[]:"format"'],
    );
    assert.deepEqual(
      codesOf(assertSchemaError(() => validateValue(schema, "Status", 5, "create"))),
      ['[]:"type"'],
    );
    assert.deepEqual(validateValue(schema, "Customer", { id: "c" }, "create"), makeRecordRef("Customer", "c"));
    assert.deepEqual(
      validateValue(schema, "Customer", { id: "c", version: "2" }, "create"),
      makeRecordRef("Customer", "c", 2n),
    );
    // Schema-level models are strict: a string is not a ref here.
    assert.deepEqual(codesOf(assertSchemaError(() => validateValue(schema, "Customer", "c", "create"))), [
      '[]:"type"',
    ]);
    assert.deepEqual(
      validateValue(schema, "Address|Customer", { type: "Customer", value: { id: "c" } }, "create"),
      makeUnionValue("Customer", makeRecordRef("Customer", "c")),
    );
    assert.deepEqual(
      codesOf(
        assertSchemaError(() =>
          validateValue(schema, "Address|Customer", { type: "Address", value: { city: "S" } }, "create"),
        ),
      ),
      ['["value","street"]:"required"'],
    );
  });

  it("delegates inline enum/action/delivery leaves to the wire codec", () => {
    const schema = shopSchema();
    const base = {
      e: "a",
      act: { target: "Op", bindings: { row: { id: "r", version: "1" } } },
      del: { id: "d", operation: "Op" },
    };
    validateValue(schema, "Misc", base, "create");
    assert.deepEqual(codesOf(assertSchemaError(() => validateValue(schema, "Misc", { ...base, e: "z" }, "create"))), [
      '["e"]:"format"',
    ]);
    assert.deepEqual(
      codesOf(
        assertSchemaError(() =>
          validateValue(schema, "Misc", { ...base, act: { target: "Op", bindings: { row: { id: "r" } } } }, "create"),
        ),
      ),
      ['["act","bindings","row","version"]:"required"'],
    );
    assert.deepEqual(
      codesOf(assertSchemaError(() => validateValue(schema, "Misc", { ...base, del: { id: "d", operation: "Q" } }, "create"))),
      ['["del","operation"]:"format"'],
    );
  });

  it("resolves contracts that declare their own id field", () => {
    // Wire-level decoding would read {id,...} as a ref; schema validation
    // knows Order is a contract, so its id field validates as text.
    const schema = shopSchema();
    const out = validateValue(schema, "Order", validOrder(), "create") as ContractValue;
    assert.equal(out["id"], "o1");
  });

  it("rejects caller errors with ValueError", () => {
    const schema = shopSchema();
    assert.throws(() => validateValue({} as never, "int", "1", "create"), ValueError);
    assert.throws(() => validateValue(schema, "int", "1", "delete" as never), ValueError);
    assert.throws(() => validateValue(schema, "int?[]", "1", "create"), ValueError);
    assert.throws(() => validateValue(schema, 5 as never, "1", "create"), ValueError);
  });

  it("shares frozen defaults across validations", () => {
    const schema = shopSchema();
    const first = validateValue(schema, "Req", { a: "x", e: [] }, "create") as ContractValue;
    const second = validateValue(schema, "Req", { a: "y", e: [] }, "create") as ContractValue;
    assert.ok(Object.isFrozen(first["g"]));
    assert.strictEqual(first["g"], second["g"]);
  });

  it("compares decimals across scales", () => {
    const schema = shopSchema();
    // "9.990" equals the "9.99" max by value: accepted.
    const out = validateValue(
      schema,
      "Bounds",
      {
        n: "5",
        t: "abc",
        arr: ["1"],
        m: { minor: "50", currency: "USD" },
        d: "2026-06-01",
        dt: "2026-06-01T00:00:00.000Z",
        dec: "9.990",
        dur: "5",
      },
      "create",
    ) as ContractValue;
    assert.ok(out["dec"] instanceof Decimal);
  });
});

describe("trim normalization (DESIGN L131)", () => {
  it("trims padded values, then bounds the trimmed result", () => {
    const schema = normalizeSchema({
      contracts: { C: contract({ name: field("text", { trim: true, min: 1, max: 10 }) }) },
    });
    const out = validateValue(schema, "C", { name: "  Ada  " }, "create") as ContractValue;
    assert.equal(out["name"], "Ada");
    // Untrimmed input that trims below min still fails on the trimmed length.
    assert.deepEqual(
      codesOf(assertSchemaError(() => validateValue(schema, "C", { name: "   " }, "create"))),
      ['["name"]:"bound"'],
    );
  });

  it("passes a max violated only by untrimmed length", () => {
    const schema = normalizeSchema({
      contracts: {
        C: contract({ t: field("text", { trim: true, max: 3 }), u: field("text", { max: 3 }) }),
      },
    });
    const out = validateValue(schema, "C", { t: "  ab  ", u: "ab" }, "create") as ContractValue;
    assert.equal(out["t"], "ab");
    assert.deepEqual(
      codesOf(assertSchemaError(() => validateValue(schema, "C", { t: "ab", u: "  ab  " }, "create"))),
      ['["u"]:"bound"'],
    );
  });

  it("leaves null alone and treats trim:false as absent", () => {
    const schema = normalizeSchema({
      contracts: {
        C: contract({
          n: field("text?", { trim: true }),
          f: field("text", { trim: false, max: 3 }),
        }),
      },
    });
    const out = validateValue(schema, "C", { n: null, f: "abc" }, "create") as ContractValue;
    assert.equal(out["n"], null);
    assert.deepEqual(
      codesOf(assertSchemaError(() => validateValue(schema, "C", { n: null, f: "  ab  " }, "create"))),
      ['["f"]:"bound"'],
    );
  });

  it("decodes stringlike leaves before trimming", () => {
    const schema = normalizeSchema({
      contracts: { C: contract({ e: field("email", { trim: true }) }) },
    });
    const out = validateValue(schema, "C", { e: "a@b.com" }, "create") as ContractValue;
    assert.equal(out["e"], "a@b.com");
    // Padded email never reaches trim: the wire decode rejects whitespace first.
    assert.deepEqual(
      codesOf(assertSchemaError(() => validateValue(schema, "C", { e: "  a@b.com  " }, "create"))),
      ['["e"]:"format"'],
    );
  });

  it("trims explicit defaults before their bound check", () => {
    const schema = normalizeSchema({
      contracts: { C: contract({ t: field("text", { trim: true, max: 1, default: "  x  " }) }) },
    });
    const out = validateValue(schema, "C", {}, "create") as ContractValue;
    assert.equal(out["t"], "x");
    assert.deepEqual(
      codesOf(
        assertSchemaError(() =>
          normalizeSchema({
            contracts: { C: contract({ t: field("text", { trim: true, max: 1, default: "  xy  " }) }) },
          }),
        ),
      ),
      ['["contracts","C","fields","t","default"]:"bound"'],
    );
  });

  it("rejects trim outside text leaves with a clear error", () => {
    const violations = assertSchemaError(() =>
      normalizeSchema({ contracts: { A: contract({ f: field("int", { trim: true }) }) } }),
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0]?.message ?? "", /trim is only supported on text fields/);
  });

  it("trims operation inputs before their bound check", () => {
    const schema = normalizeSchema({
      operations: { op: { inputs: { q: field("text", { trim: true, max: 2 }) } } },
    });
    assert.deepEqual(validateOperationInput(schema, "op", { q: "  ab  " }), { q: "ab" });
    assert.deepEqual(codesOf(assertSchemaError(() => validateOperationInput(schema, "op", { q: "  abc  " }))), [
      '["q"]:"bound"',
    ]);
  });
});

describe("omitted bounded arrays fail closed (M2)", () => {
  it("fails an omitted bounded array on create, like an explicit []", () => {
    const schema = normalizeSchema({
      contracts: { C: contract({ items: field("text[]", { min: 1 }) }) },
    });
    assert.deepEqual(codesOf(assertSchemaError(() => validateValue(schema, "C", {}, "create"))), [
      '["items"]:"bound"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => validateValue(schema, "C", { items: [] }, "create"))), [
      '["items"]:"bound"',
    ]);
    const out = validateValue(schema, "C", { items: ["a"] }, "create") as ContractValue;
    assert.deepEqual(out["items"], ["a"]);
  });

  it("still yields [] for omitted unbounded arrays", () => {
    const schema = normalizeSchema({ contracts: { C: contract({ items: field("text[]") }) } });
    const out = validateValue(schema, "C", {}, "create") as ContractValue;
    assert.deepEqual(out["items"], []);
    assert.ok(Object.isFrozen(out["items"]));
  });

  it("still yields the sentinel for update-mode omission", () => {
    const schema = normalizeSchema({
      contracts: { C: contract({ items: field("text[]", { min: 1 }) }) },
    });
    const out = validateValue(schema, "C", {}, "update") as UpdateContract;
    assert.ok(isUpdateOmitted(out["items"]));
  });

  it("fails omitted bounded operation inputs the same way", () => {
    const schema = normalizeSchema({
      operations: {
        op: { inputs: { xs: field("text[]", { min: 1 }), ys: field("text[]") } },
      },
    });
    assert.deepEqual(codesOf(assertSchemaError(() => validateOperationInput(schema, "op", {}))), [
      '["xs"]:"bound"',
    ]);
    assert.deepEqual(validateOperationInput(schema, "op", { xs: ["a"] }), { xs: ["a"], ys: [] });
  });
});

describe("validateValue update", () => {
  it("marks omitted fields with UPDATE_OMITTED, never null", () => {
    const schema = shopSchema();
    const out = validateValue(schema, "Order", { status: "paid" }, "update") as UpdateContract;
    assert.equal(out["status"], "paid");
    for (const key of ["id", "customer", "shipTo", "billTo", "lines", "tags", "total", "placed", "priority"]) {
      assert.ok(isUpdateOmitted(out[key]), `expected sentinel for ${key}`);
      assert.ok(out[key] !== null, `sentinel is never null (${key})`);
    }
    assert.ok(Object.isFrozen(out));
  });

  it("validates present fields and skips defaults on update", () => {
    const schema = shopSchema();
    assert.deepEqual(codesOf(assertSchemaError(() => validateValue(schema, "Order", { status: "xx" }, "update"))), [
      '["status"]:"format"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => validateValue(schema, "Order", { id: null }, "update"))), [
      '["id"]:"type"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => validateValue(schema, "Order", { bogus: 1 }, "update"))), [
      '["bogus"]:"unknown-field"',
    ]);
    // Omitted defaulted fields stay omitted: no defaults run on update.
    const out = validateValue(schema, "Order", {}, "update") as UpdateContract;
    assert.ok(isUpdateOmitted(out["priority"]));
    assert.ok(isUpdateOmitted(out["lines"]));
  });

  it("partials nest through contracts but arrays and unions stay complete", () => {
    const schema = shopSchema();
    const nested = validateValue(schema, "Order", { shipTo: { city: "X" } }, "update") as UpdateContract;
    const shipTo = nested["shipTo"] as UpdateContract;
    assert.equal(shipTo["city"], "X");
    assert.ok(isUpdateOmitted(shipTo["street"]));
    assert.ok(isUpdateOmitted(shipTo["note"]));
    // Array elements are whole new values: omissions fail as required.
    assert.deepEqual(
      codesOf(assertSchemaError(() => validateValue(schema, "Order", { lines: [{ sku: "a" }] }, "update"))),
      ['["lines",0,"qty"]:"required"', '["lines",0,"price"]:"required"'],
    );
    // Union branches are whole new values too.
    assert.deepEqual(
      codesOf(
        assertSchemaError(() =>
          validateValue(schema, "Order", { billTo: { type: "Address", value: { city: "X" } } }, "update"),
        ),
      ),
      ['["billTo","value","street"]:"required"'],
    );
  });

  it("validates top-level scalars and nulls plainly in update mode", () => {
    const schema = shopSchema();
    assert.equal(validateValue(schema, "int", "5", "update"), 5n);
    assert.equal(validateValue(schema, "int?", null, "update"), null);
    assert.deepEqual(codesOf(assertSchemaError(() => validateValue(schema, "int", "x", "update"))), ['[]:"format"']);
  });
});

describe("validateOperationInput", () => {
  it("validates query inputs with defaults and rejects unknown arguments", () => {
    const schema = shopSchema();
    assert.deepEqual(validateOperationInput(schema, "searchOrders", {}), { q: null, limit: 25n });
    assert.deepEqual(validateOperationInput(schema, "searchOrders", { q: "shoes", limit: "10" }), {
      q: "shoes",
      limit: 10n,
    });
    assert.deepEqual(codesOf(assertSchemaError(() => validateOperationInput(schema, "searchOrders", { bogus: 1 }))), [
      '["bogus"]:"unknown-argument"',
    ]);
    assert.deepEqual(
      codesOf(assertSchemaError(() => validateOperationInput(schema, "searchOrders", { operation_id: "x" }))),
      ['["operation_id"]:"unknown-argument"'],
    );
    assert.deepEqual(codesOf(assertSchemaError(() => validateOperationInput(schema, "searchOrders", { limit: "0" }))), [
      '["limit"]:"bound"',
    ]);
    const out = validateOperationInput(schema, "searchOrders", {});
    assert.ok(Object.isFrozen(out));
  });

  it("requires operation_id for mutations", () => {
    const schema = shopSchema();
    const base = { order: versionedOrder(), customer: { id: "c", version: "1" } };
    const out = validateOperationInput(schema, "placeOrder", { ...base, operation_id: "op1" });
    assert.equal(out["operation_id"], "op1");
    assert.equal((out["order"] as ContractValue)["id"], "o1");
    assert.ok(Object.isFrozen(out));
    assert.deepEqual(codesOf(assertSchemaError(() => validateOperationInput(schema, "placeOrder", base))), [
      '["operation_id"]:"required"',
    ]);
    assert.deepEqual(
      codesOf(assertSchemaError(() => validateOperationInput(schema, "placeOrder", { ...base, operation_id: "" }))),
      ['["operation_id"]:"format"'],
    );
    assert.deepEqual(
      codesOf(assertSchemaError(() => validateOperationInput(schema, "placeOrder", { ...base, operation_id: 5 }))),
      ['["operation_id"]:"type"'],
    );
  });

  it("requires expected versions on mutation refs, however nested", () => {
    const schema = shopSchema();
    const base = { order: versionedOrder(), customer: { id: "c", version: "1" }, operation_id: "op1" };
    validateOperationInput(schema, "placeOrder", base);
    assert.deepEqual(
      codesOf(
        assertSchemaError(() => validateOperationInput(schema, "placeOrder", { ...base, customer: { id: "c" } })),
      ),
      ['["customer","version"]:"required"'],
    );
    const nested = { ...versionedOrder(), customer: { id: "c" } };
    assert.deepEqual(
      codesOf(assertSchemaError(() => validateOperationInput(schema, "placeOrder", { ...base, order: nested }))),
      ['["order","customer","version"]:"required"'],
    );
    assert.deepEqual(
      codesOf(
        assertSchemaError(() =>
          validateOperationInput(schema, "assignWitnesses", { witnesses: [{ id: "c", version: "1" }, { id: "d" }], operation_id: "op" }),
        ),
      ),
      ['["witnesses",1,"version"]:"required"'],
    );
    assert.deepEqual(
      codesOf(
        assertSchemaError(() =>
          validateOperationInput(schema, "notify", { dest: { type: "Customer", value: { id: "c" } }, operation_id: "op" }),
        ),
      ),
      ['["dest","value","version"]:"required"'],
    );
  });

  it("preserves versions on queries without requiring them", () => {
    const schema = normalizeSchema({
      operations: {
        getCustomer: { inputs: { customer: { type: "Customer" } } },
      },
    });
    assert.deepEqual(validateOperationInput(schema, "getCustomer", { customer: { id: "c" } }), {
      customer: makeRecordRef("Customer", "c"),
    });
    assert.deepEqual(validateOperationInput(schema, "getCustomer", { customer: { id: "c", version: "2" } }), {
      customer: makeRecordRef("Customer", "c", 2n),
    });
  });

  it("rejects unknown operations and non-object args", () => {
    const schema = shopSchema();
    assert.throws(() => validateOperationInput(schema, "nope", {}), ValueError);
    assert.throws(() => validateOperationInput(schema, "", {}), ValueError);
    assert.throws(() => validateOperationInput(5 as never, "searchOrders", {}), ValueError);
    assert.deepEqual(codesOf(assertSchemaError(() => validateOperationInput(schema, "searchOrders", []))), [
      '[]:"type"',
    ]);
    assert.deepEqual(
      codesOf(assertSchemaError(() => validateOperationInput(schema, "searchOrders", null))),
      ['[]:"type"'],
    );
  });

  it("treats undefined-valued arguments as omitted", () => {
    const schema = shopSchema();
    assert.deepEqual(validateOperationInput(schema, "searchOrders", { q: undefined }), { q: null, limit: 25n });
  });
});

describe("schema sentinel", () => {
  it("exports a single UPDATE_OMITTED identity", () => {
    assert.equal(typeof UPDATE_OMITTED, "symbol");
    assert.ok(isUpdateOmitted(UPDATE_OMITTED));
    assert.ok(!isUpdateOmitted(null));
    assert.ok(!isUpdateOmitted(undefined));
    assert.ok(!isUpdateOmitted({} as CanValue));
    const out = validateValue(shopSchema(), "Req", { a: "x", e: [] }, "update") as UpdateContract;
    assert.strictEqual(out["b"], UPDATE_OMITTED);
  });
});

describe("B1 L3 creation agreement", () => {
  // The L2 omission table must agree with the L3 pipeline creation order
  // (caller wins, then literal, required-array rejection, nullable null,
  // array [], server init, hooks): literal/nullable/array/required pins
  // live in the suites above — this block pins the remaining rows.
  // Parent-path defaults are not expressible in FieldDescriptor (no L2
  // bridge yet; no production consumer feeds L2 output into L3), so L3
  // alone resolves them — no live divergence by construction.

  it("drops omitted server/derived fields on create (L3 resolves or absents)", () => {
    const schema = normalizeSchema({
      contracts: {
        M: contract({
          name: field("text"),
          made: field("datetime", { server: true }),
          vessel: field("text", { derived: true }),
        }),
      },
    });
    const out = validateValue(schema, "M", { name: "n" }, "create") as ContractValue;
    // Complementary by design: L2 drops the keys; L3 resolves server
    // inits at creation and leaves derived fields absent from rows.
    assert.deepEqual(out, { name: "n" });
    assert.ok(!Object.hasOwn(out, "made"));
    assert.ok(!Object.hasOwn(out, "vessel"));
  });

  it("fills omitted required-with-default (matches L3 fill-then-pass)", () => {
    const schema = normalizeSchema({
      contracts: { M: contract({ x: field("text", { default: "d" }) }) },
    });
    const out = validateValue(schema, "M", {}, "create") as ContractValue;
    assert.deepEqual(out, { x: "d" });
  });

  it("fails omitted required arrays (matches L3 required-array rejection)", () => {
    const schema = normalizeSchema({
      contracts: { M: contract({ f: field("text[]!") }) },
    });
    const violations = assertSchemaError(() => validateValue(schema, "M", {}, "create"));
    assert.deepEqual(codesOf(violations), ['["f"]:"required"']);
  });
});


function candidateInventory() {
  const choice = "Review.pick.choice";
  const candidate = "Review.pick.option";
  const array = { type: `${candidate}[]!`, min: 0, max: 24, distinctBy: "id" as const,
    excludedIds: ["none", "need_more_info"] };
  return {
    aliases: [{ name: choice, type: "text" as const, min: 1, max: 80, format: "name" as const }],
    contracts: [
      { name: candidate, fields: [{ name: "id", type: choice }, { name: "description", type: "text", min: 1, max: 2000 }] },
      { name: "Review.options", fields: [{ name: "pick", ...array }] },
      // Compiler-lowered field reuse preserves value constraints and refines max.
      { name: "Synthesis", fields: [{ name: "choices", ...array, max: 8 }] },
      { name: "Review.probability", fields: [{ name: "option", type: choice }] },
      { name: "Review.result", fields: [{ name: "choice", type: choice }, { name: "options", type: "Review.probability[]!" }] },
    ],
  };
}

const candidateValue = (id: string, description = "An alternative") => ({ id, description });

describe("checked runtime candidate value constraints", () => {
  it("reuses candidate-array constraints and one bounded TEXT alias for every result key", () => {
    const { valueSchema } = normalizeValueTypes(candidateInventory());
    const choices = [candidateValue("change_b"), candidateValue("change_a")];
    assert.deepEqual(validateValue(valueSchema, "Synthesis", { choices }, "create"), { choices });
    assert.deepEqual(validateValue(valueSchema, "Review.options", { pick: choices }, "create"), { pick: choices });
    assert.deepEqual(validateValue(valueSchema, "Review.result", {
      choice: "none", options: [{ option: "change_a" }, { option: "none" }],
    }, "create"), { choice: "none", options: [{ option: "change_a" }, { option: "none" }] });
    assert.equal(validateValue(valueSchema, "Review.pick.choice", "change_a", "create"), "change_a");
    assertSchemaError(() => validateValue(valueSchema, "Review.pick.choice", { id: "change_a" }, "create"));
    assertSchemaError(() => validateValue(valueSchema, "Review.probability", { option: "not-a-NAME" }, "create"));
    assert.equal(encodeValue("Review.pick.choice", "change_a"), "change_a");
    assert.equal(decodeValue("Review.pick.choice", "change_a"), "change_a");
  });

  it("rejects duplicate and authored ids without deduplicating or changing order", () => {
    const { valueSchema } = normalizeValueTypes(candidateInventory());
    for (const choices of [
      [candidateValue("change_a"), candidateValue("change_a", "Different wording")],
      [candidateValue("none")], [candidateValue("need_more_info")],
    ]) {
      const violations = assertSchemaError(() => validateValue(valueSchema, "Synthesis", { choices }, "create"));
      assert.ok(violations.some(violation => violation.code === "format" && violation.path.at(-1) === "id"));
    }
    // Distinctness does not impose NAME/length policy on an unrelated text id.
    const textIds = normalizeSchema({ contracts: {
      Item: { fields: { id: { type: "text" } } },
      Items: { fields: { items: { type: "Item[]!", distinctBy: "id" } } },
    } });
    assert.deepEqual(validateValue(textIds, "Items", { items: [{ id: "not-a-NAME" }] }, "create"),
      { items: [{ id: "not-a-NAME" }] });
    // These are request-local constraints: the same id may appear in another validated value.
    assert.deepEqual(validateValue(valueSchema, "Synthesis", { choices: [candidateValue("change_a")] }, "create"),
      validateValue(valueSchema, "Synthesis", { choices: [candidateValue("change_a")] }, "create"));
  });

  it("enforces both combined-count bounds and the receiving max refinement", () => {
    const raw = candidateInventory();
    const { valueSchema } = normalizeValueTypes(raw);
    assert.deepEqual(validateValue(valueSchema, "Synthesis", { choices: [] }, "create"), { choices: [] });
    assertSchemaError(() => validateValue(valueSchema, "Synthesis", {}, "create"));
    assertSchemaError(() => validateValue(valueSchema, "Synthesis", {
      choices: Array.from({ length: 9 }, (_, index) => candidateValue(`change_${index}`)),
    }, "create"));
    assertSchemaError(() => validateValue(valueSchema, "Review.options", {
      pick: Array.from({ length: 25 }, (_, index) => candidateValue(`change_${index}`)),
    }, "create"));
    // A runtime question with no authored choices requires at least two candidates.
    Object.assign(raw.contracts[1]!.fields[0]!, { min: 2, max: 26, excludedIds: [] });
    const dynamic = normalizeValueTypes(raw).valueSchema;
    assertSchemaError(() => validateValue(dynamic, "Review.options", { pick: [candidateValue("change_a")] }, "create"));
    assert.deepEqual(validateValue(dynamic, "Review.options", { pick: [candidateValue("a"), candidateValue("b")] }, "create"),
      { pick: [candidateValue("a"), candidateValue("b")] });
  });

  it("validates NAME, 80-scalar ids and 2000-scalar descriptions through the same schema", () => {
    const { valueSchema } = normalizeValueTypes(candidateInventory());
    const accepted = candidateValue("a".repeat(80), "💡".repeat(2000));
    assert.deepEqual(validateValue(valueSchema, "Synthesis", { choices: [accepted] }, "create"), { choices: [accepted] });
    for (const candidate of [candidateValue("a".repeat(81)), candidateValue(""), candidateValue("bad-id"),
      candidateValue("é"), candidateValue("good", ""), candidateValue("good", "💡".repeat(2001))]) {
      assertSchemaError(() => validateValue(valueSchema, "Synthesis", { choices: [candidate] }, "create"));
    }
  });

  it("detaches and freezes constraints and closes duplicate or dangling alias claims", () => {
    const raw = candidateInventory();
    const checked = normalizeValueTypes(raw);
    raw.aliases[0]!.max = 1;
    const array = raw.contracts[1]!.fields[0] as { excludedIds: string[] };
    array.excludedIds[0] = "changed";
    assert.equal(checked.valueTypes.aliases![0]!.max, 80);
    assert.deepEqual(checked.valueTypes.contracts[1]!.fields[0]!.excludedIds, ["none", "need_more_info"]);
    assert.ok(Object.isFrozen(checked.valueTypes.contracts[1]!.fields[0]!.excludedIds));
    assert.ok(Object.isFrozen(checked.valueSchema.aliases!["Review.pick.choice"]));
    assertSchemaError(() => validateValue(checked.valueSchema, "Review.options", { pick: [candidateValue("none")] }, "create"));
    const duplicate = candidateInventory();
    duplicate.aliases[0]!.name = "Review.options";
    assert.throws(() => normalizeValueTypes(duplicate), (error: unknown) => error instanceof ValueTypesError && error.code === "duplicate");
    const missing = candidateInventory();
    missing.aliases = [];
    assert.throws(() => normalizeValueTypes(missing), (error: unknown) => error instanceof ValueTypesError && error.code === "dangling");
  });

  it("rejects incompatible metadata and impossible receiving alias bounds", () => {
    for (const descriptor of [
      { contracts: { X: { fields: { value: { type: "int", format: "name" } } } } },
      { contracts: { X: { fields: { value: { type: "text[]", distinctBy: "id" } } } } },
      { contracts: { X: { fields: { value: { type: "text[]", excludedIds: ["none"] } } } } },
      { contracts: { X: { fields: { id: { type: "int" } } }, Y: { fields: { xs: { type: "X[]", distinctBy: "id" } } } } },
    ]) assertSchemaError(() => normalizeSchema(descriptor));
    for (const excludedIds of [["bad-id"], ["x".repeat(81)], ["none", "none"]]) {
      const raw = candidateInventory();
      (raw.contracts[1]!.fields[0] as { excludedIds: string[] }).excludedIds = excludedIds;
      assert.throws(() => normalizeValueTypes(raw), ValueTypesError);
    }
    const aliases = { Choice: { type: "text", min: 1, max: 80, format: "name" } };
    assertSchemaError(() => normalizeSchema({ aliases, contracts: { Result: { fields: { option: { type: "Choice", min: 81 } } } } }));
    const schema = normalizeSchema({ aliases, contracts: { Result: { fields: { option: { type: "Choice", min: 2, max: 3 } } } } });
    assert.deepEqual(validateValue(schema, "Result", { option: "abc" }, "create"), { option: "abc" });
    assertSchemaError(() => validateValue(schema, "Result", { option: "abcd" }, "create"));
  });

  it("preserves static defaults and explicitly refuses unsupported prepared profiles", () => {
    const legacy = normalizeSchema({ contracts: { Legacy: { fields: {
      count: { type: "int", default: "1" }, items: { type: "text[]" },
    } } } });
    assert.equal(Object.hasOwn(legacy, "aliases"), false);
    assert.deepEqual(validateValue(legacy, "Legacy", {}, "create"), { count: 1n, items: [] });
    const owner = createPlanOwner({ abiVersion: "v1", profileVersion: "validation/v1", backendId: "ts", ownerRevision: "candidate-test" });
    recordFactoryProvenance(legacy, "candidate-test");
    const plan = registerValidationPlan(owner, "validation/v1", legacy);
    const constrained = normalizeValueTypes(candidateInventory()).valueSchema;
    recordFactoryProvenance(constrained, "candidate-test");
    assert.throws(() => registerValidationPlan(owner, "validation/v1", constrained),
      (error: unknown) => error instanceof PlanError && error.code === "malformed-schema");
    assert.throws(() => validatePreparedValue(owner, plan, constrained, "Legacy", {}, "create"),
      (error: unknown) => error instanceof PlanError && error.code === "unknown-plan");
    const formatOnly = normalizeSchema({ contracts: { Legacy: { fields: { id: { type: "text", format: "name" } } } } });
    recordFactoryProvenance(formatOnly, "candidate-test");
    assert.throws(() => registerValidationPlan(owner, "validation/v1", formatOnly),
      (error: unknown) => error instanceof PlanError && error.code === "malformed-schema");
  });
});
