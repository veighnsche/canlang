import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSchema, validateValue, type NormalizedSchema } from "../src/schema.js";
import {
  createPlanOwner,
  PlanError,
  getValidationPlan,
  isPlanId,
  recordFactoryProvenance,
  registerValidationPlan,
  releaseValidationPlan,
  resolvePlanDefault,
  type PlanOwner,
} from "../src/prepared/plan.js";

function field(type: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return { type, ...(extra ?? {}) };
}

function contract(fields: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return { fields };
}

/** BigInt-safe structural snapshot (JSON cannot serialize BigInt canon values). */
function snapshot(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, nested: unknown) =>
      typeof nested === "bigint" ? `bigint:${nested.toString()}` : nested,
    ),
  );
}

function owner(revision = "artifact-1:test"): PlanOwner {
  return createPlanOwner({
    abiVersion: "values/v1",
    profileVersion: "validation/v1",
    backendId: "test-backend",
    ownerRevision: revision,
  });
}

/** Rich descriptor exercising defaults, bounds, trim, nullability, arrays, unions, enums, ops. */
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
  return { own, schema, id, plan: getValidationPlan(own, id) };
}

function assertPlanError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof PlanError, `expected PlanError, got ${String(err)}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected PlanError(${code}), but nothing was thrown`);
}

describe("owner-plan fixtures preserve current normalization semantics", () => {
  it("copies required/default/bounds/trim/origin per field", () => {
    const { plan, schema } = registeredPlan(shopDescriptor());
    const expected = schema.contracts["Item"]!.fields;
    const fields = plan.contracts["Item"]!.fields;
    assert.deepEqual(
      fields.map((f) => f.name),
      ["name", "qty", "note", "tags", "total"],
    );
    for (const actual of fields) {
      const want = expected[actual.name]!;
      assert.equal(actual.typeId, want.typeId);
      assert.deepEqual(actual.type, want.type);
      assert.equal(actual.required, want.required);
      assert.equal(actual.hasDefault, want.hasDefault);
      assert.equal(actual.lengthMin, want.lengthMin);
      assert.equal(actual.lengthMax, want.lengthMax);
      assert.deepEqual(actual.valueMin, want.valueMin);
      assert.deepEqual(actual.valueMax, want.valueMax);
      assert.equal(actual.trim, want.trim);
      assert.equal(actual.serverOnly, want.serverOnly);
      assert.equal(actual.defaultOrigin, want.defaultOrigin);
    }
    // Spot checks of derived semantics: defaulted int not required with
    // literal origin; trimmed text keeps length bounds; plain array optional.
    const qty = fields[1]!;
    assert.equal(qty.required, false);
    assert.equal(qty.defaultOrigin, "literal");
    assert.deepEqual(qty.valueMin, 1n);
    assert.deepEqual(qty.valueMax, 999n);
    assert.equal(fields[0]!.trim, true);
    assert.equal(fields[3]!.required, false);
    assert.equal(fields[3]!.hasDefault, false);
  });

  it("copies allowed/required lists, enum cases, and operation inputs in order", () => {
    const { plan } = registeredPlan(shopDescriptor());
    assert.deepEqual(plan.contracts["Item"]!.allowed, ["name", "qty", "note", "tags", "total"]);
    assert.deepEqual(plan.contracts["Item"]!.required, ["name", "total"]);
    assert.deepEqual(plan.contractOrder, ["Item", "Sale"]);
    assert.deepEqual(plan.enums["Status"]!.cases, ["open", "closed"]);
    const checkout = plan.operations["checkout"]!;
    assert.equal(checkout.mutation, true);
    assert.deepEqual(
      checkout.inputs.map((i) => i.name),
      ["item", "coupon"],
    );
    assert.deepEqual(checkout.required, ["item"]);
  });

  it("copies union arms and nominal/enum refs in order", () => {
    const { plan } = registeredPlan(shopDescriptor());
    const outcome = plan.contracts["Sale"]!.fields.find((f) => f.name === "outcome")!;
    assert.deepEqual(outcome.refs, ["Status", "Item"]);
    const item = plan.contracts["Sale"]!.fields.find((f) => f.name === "item")!;
    assert.deepEqual(item.refs, ["Item"]);
  });

  it("all registration behavior is synchronous", () => {
    const own = owner();
    const schema = normalizeSchema(shopDescriptor());
    recordFactoryProvenance(schema, own.scope.ownerRevision);
    const id = registerValidationPlan(own, "validation/v1", schema);
    assert.equal(typeof id, "string");
    const plan = getValidationPlan(own, id);
    assert.equal(typeof plan, "object");
    const ref = plan.contracts["Item"]!.fields[1]!.defaultRef!;
    const resolved = resolvePlanDefault(own, ref);
    assert.equal(typeof resolved, "bigint");
  });
});

describe("registered plans are immutable copies", () => {
  it("descriptor mutation after registration cannot change the plan", () => {
    const descriptor = shopDescriptor();
    const { plan } = registeredPlan(descriptor);
    const qty0 = plan.contracts["Item"]!.fields[1]!;
    const before = snapshot(qty0);
    ((descriptor["contracts"] as Record<string, unknown>)["Item"] as Record<string, unknown>)["fields"] = {};
    const qty = plan.contracts["Item"]!.fields[1]!;
    assert.deepEqual(snapshot(qty), before);
    assert.deepEqual(qty.valueMax, 999n);
  });

  it("normalized-schema mutation after registration cannot change the plan", () => {
    // Mutable hand-built carrying test-only provenance (the factory seam
    // the V02.6 hook will occupy): proves registration copies, not aliases.
    const mutable = {
      kind: "normalized-schema",
      contracts: {
        Widget: {
          fields: {
            size: {
              type: { base: { kind: "scalar", name: "int" }, array: false, nullable: false, requiredArray: false },
              typeId: "int",
              required: true,
              hasDefault: true,
              valueMin: 1n,
              valueMax: 9n,
              default: 5n,
              serverOnly: false,
            },
          },
        },
      },
      enums: {},
      operations: {},
    };
    const own = owner();
    recordFactoryProvenance(mutable, own.scope.ownerRevision);
    const id = registerValidationPlan(own, "validation/v1", mutable as unknown as NormalizedSchema);
    const size = getValidationPlan(own, id).contracts["Widget"]!.fields[0]!;
    (mutable.contracts["Widget"]!.fields["size"] as Record<string, unknown>)["valueMax"] = 1n;
    (mutable.contracts["Widget"]!.fields["size"] as Record<string, unknown>)["default"] = 1n;
    assert.deepEqual(size.valueMax, 9n);
    assert.deepEqual(resolvePlanDefault(own, size.defaultRef!), 5n);
  });

  it("plans, fields, and defaults are deeply frozen", () => {
    const { plan, own } = registeredPlan(shopDescriptor());
    assert.ok(Object.isFrozen(plan));
    assert.ok(Object.isFrozen(plan.contracts));
    assert.ok(Object.isFrozen(plan.contracts["Item"]!.fields));
    const qty = plan.contracts["Item"]!.fields[1]!;
    assert.ok(Object.isFrozen(qty));
    assert.ok(Object.isFrozen(qty.valueMax));
    assert.ok(Object.isFrozen(resolvePlanDefault(own, qty.defaultRef!)));
  });
});

describe("forgery and legacy controls", () => {
  it("forged schema tags without provenance are rejected, legacy untouched", () => {
    const forged = {
      kind: "normalized-schema",
      contracts: {},
      enums: {},
      operations: {},
    };
    assertPlanError(
      () => registerValidationPlan(owner(), "validation/v1", forged),
      "missing-provenance",
    );
    // Structural acceptance stays legacy: validateValue still takes it past
    // the tag gate (a content SchemaError proves the legacy path is intact).
    try {
      validateValue(forged as unknown as NormalizedSchema, "int", "nope", "create");
    } catch (err) {
      assert.equal((err as { name?: string }).name, "SchemaError");
      return;
    }
    assert.fail("expected legacy validateValue to run on the forged tag");
  });

  it("frozen hand-builts without provenance are rejected: freeze is not provenance", () => {
    const handBuilt = Object.freeze({
      kind: "normalized-schema",
      contracts: Object.freeze({}),
      enums: Object.freeze({}),
      operations: Object.freeze({}),
    });
    assertPlanError(
      () => registerValidationPlan(owner(), "validation/v1", handBuilt),
      "missing-provenance",
    );
  });

  it("genuine factory output without recorded provenance is rejected", () => {
    const schema = normalizeSchema(shopDescriptor());
    assertPlanError(() => registerValidationPlan(owner(), "validation/v1", schema), "missing-provenance");
  });

  it("unknown string wrappers stay outside the cache", () => {
    assertPlanError(() => registerValidationPlan(owner(), "validation/v1", "Item"), "legacy-wrapper");
  });

  it("foreign owner objects cannot register", () => {
    const { schema } = registeredPlan(shopDescriptor());
    const fake = {
      scope: {
        abiVersion: "values/v1",
        profileVersion: "validation/v1",
        backendId: "test-backend",
        ownerRevision: "artifact-1:test",
      },
    };
    assertPlanError(() => registerValidationPlan(fake, "validation/v1", schema), "foreign-owner");
  });

  it("provenance from another scope cannot register (stale scope)", () => {
    const schema = normalizeSchema(shopDescriptor());
    recordFactoryProvenance(schema, "artifact-1:other");
    assertPlanError(() => registerValidationPlan(owner(), "validation/v1", schema), "stale-scope");
  });

  it("reserved __proto__ names cannot smuggle into plan maps", () => {
    const sneaky = {
      kind: "normalized-schema",
      contracts: {},
      enums: {},
      operations: {},
    } as unknown as Record<string, Record<string, unknown>>;
    Object.defineProperty(sneaky["contracts"]!, "__proto__", {
      value: { fields: {} },
      enumerable: true,
    });
    const own = owner();
    recordFactoryProvenance(sneaky, own.scope.ownerRevision);
    assertPlanError(
      () => registerValidationPlan(own, "validation/v1", sneaky as unknown as NormalizedSchema),
      "malformed-schema",
    );
  });
});

describe("default registry identity", () => {
  it("repeated resolution returns the identical frozen object", () => {
    const { plan, own } = registeredPlan(shopDescriptor());
    const ref = plan.contracts["Item"]!.fields[1]!.defaultRef!;
    const first = resolvePlanDefault(own, ref);
    const second = resolvePlanDefault(own, ref);
    assert.equal(first, second);
    assert.deepEqual(first, 3n);
  });

  it("forged or unknown default refs are rejected", () => {
    const { own } = registeredPlan(shopDescriptor());
    assertPlanError(() => resolvePlanDefault(own, { kind: "default-ref", key: "0:missing" }), "unknown-default");
    assertPlanError(() => resolvePlanDefault(own, "coupon"), "unknown-default");
  });
});

describe("plan handles", () => {
  it("ids carry scope parts, generation, and issuer sequence", () => {
    const own = owner();
    const first = registeredPlan(shopDescriptor(), own).id;
    const second = registeredPlan(shopDescriptor(), own).id;
    assert.ok(isPlanId(first));
    assert.equal(first, "plan:values/v1:validation/v1:test-backend:artifact-1:test:g0:0");
    assert.equal(second, "plan:values/v1:validation/v1:test-backend:artifact-1:test:g0:1");
    assert.ok(!isPlanId("Item"));
  });

  it("owners are isolated; unknown handles fail closed; release is idempotent", () => {
    const first = registeredPlan(shopDescriptor());
    const other = owner();
    assertPlanError(() => getValidationPlan(other, first.id), "unknown-plan");
    assertPlanError(() => getValidationPlan(first.own, "plan:nope"), "unknown-plan");
    releaseValidationPlan(first.own, first.id);
    releaseValidationPlan(first.own, first.id);
    releaseValidationPlan(first.own, "plan:nope");
    assertPlanError(() => getValidationPlan(first.own, first.id), "unknown-plan");
  });
});
