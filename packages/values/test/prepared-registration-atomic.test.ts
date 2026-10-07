import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Decimal } from "../src/decimal.js";
import { normalizeSchema } from "../src/schema.js";
import {
  createPlanOwner,
  getValidationPlan,
  PlanError,
  recordFactoryProvenance,
  registerValidationPlan,
  releaseValidationPlan,
  resolvePlanDefault,
  type PlanOwner,
} from "../src/prepared/plan.js";

const profile = "validation/v1";
function owner(): PlanOwner {
  return createPlanOwner({ abiVersion: "values/v1", profileVersion: profile,
    backendId: "atomic-test", ownerRevision: "atomic-revision" });
}
function id(sequence: number): string {
  return `plan:values/v1:${profile}:atomic-test:atomic-revision:g0:${sequence}`;
}
function error(fn: () => unknown, code: string, message?: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof PlanError);
    assert.equal(err.code, code);
    if (message !== undefined) assert.equal(err.message, `validation plan: ${message}`);
    return true;
  });
}
function unknownDefault(own: PlanOwner, key: string): void {
  error(() => resolvePlanDefault(own, { kind: "default-ref", key }), "unknown-default");
}
function register(own: PlanOwner, schema: object): string {
  // Integrator-private substitution only: normalizeSchema has no production
  // provenance hookup yet. This test does not establish producer authority.
  recordFactoryProvenance(schema, own.scope.ownerRevision);
  return registerValidationPlan(own, profile, schema);
}

describe("failed registration publishes neither plans nor staged defaults", () => {
  for (const path of ["contracts", "operations"] as const) {
    it(`${path}: genuine Decimal failure preserves prior identity and consumes its sequence`, () => {
      const own = owner();
      const priorSchema = normalizeSchema({ contracts: { Prior: { fields: {
        tags: { type: "text[]", default: ["kept"] },
      } } } });
      const priorId = register(own, priorSchema);
      const priorRef = getValidationPlan(own, priorId).contracts["Prior"]!.fields[0]!.defaultRef!;
      const priorDefault = resolvePlanDefault(own, priorRef);
      const fields = {
        good: { type: "text[]", default: ["staged"] },
        bad: { type: "decimal", default: "1.25" },
      };
      const schema = normalizeSchema(path === "contracts"
        ? { contracts: { C: { fields } } }
        : { operations: { op: { inputs: fields } } });
      const normalizedFields = path === "contracts"
        ? schema.contracts["C"]!.fields : schema.operations["op"]!.inputs;
      assert.ok(normalizedFields["bad"]!.default instanceof Decimal);
      recordFactoryProvenance(schema, own.scope.ownerRevision);
      // Existing carrier defect remains: genuine Decimal instances are not
      // plain metadata. Atomicity must not repair or re-code that failure.
      error(() => registerValidationPlan(own, profile, schema), "uncopyable-value",
        "plan metadata must be plain data (no class instances)");
      const prefix = path === "contracts" ? "contracts.C.fields" : "operations.op.inputs";
      unknownDefault(own, `1:${prefix}.good`);
      unknownDefault(own, `1:${prefix}.bad`);
      error(() => getValidationPlan(own, id(1)), "unknown-plan");
      assert.equal(getValidationPlan(own, priorId).id, id(0));
      assert.equal(resolvePlanDefault(own, priorRef), priorDefault);
      assert.deepEqual(priorDefault, ["kept"]);
      const nextId = register(own, priorSchema);
      assert.equal(nextId, id(2));
      const nextRef = getValidationPlan(own, nextId).contracts["Prior"]!.fields[0]!.defaultRef!;
      const nextDefault = resolvePlanDefault(own, nextRef);
      assert.equal(resolvePlanDefault(own, nextRef), nextDefault);
      assert.ok(Object.isFrozen(nextDefault));
      assert.notEqual(nextDefault, priorDefault);
      releaseValidationPlan(own, nextId);
      releaseValidationPlan(own, nextId);
      error(() => getValidationPlan(own, nextId), "unknown-plan");
      // Existing release lifetime is preserved: releasing a plan retains its defaults.
      assert.equal(resolvePlanDefault(own, nextRef), nextDefault);
      assert.equal(resolvePlanDefault(own, priorRef), priorDefault);
    });

    it(`${path}: reserved later field fails after a copied primitive default`, () => {
      const own = owner();
      const actual = normalizeSchema({ contracts: { C: { fields: {
        good: { type: "int", default: "7" },
      } } } });
      // The factory correctly rejects reserved fields. Rebuild only the field
      // map to exercise the registry's existing post-provenance defense.
      const fields = { ...actual.contracts["C"]!.fields,
        ["__proto__"]: actual.contracts["C"]!.fields["good"]! };
      const schema = path === "contracts"
        ? { ...actual, contracts: { C: { fields } } }
        : { ...actual, contracts: {}, operations: { op: { inputs: fields, mutation: false } } };
      recordFactoryProvenance(schema, own.scope.ownerRevision);
      error(() => registerValidationPlan(own, profile, schema), "malformed-schema",
        `${path === "contracts" ? "field" : "input"} name "__proto__" is reserved`);
      unknownDefault(own, path === "contracts"
        ? "0:contracts.C.fields.good" : "0:operations.op.inputs.good");
      error(() => getValidationPlan(own, id(0)), "unknown-plan");
      assert.equal(register(own, actual), id(1));
    });
  }

  it("propagates the original getter error after copying a default in the original order", () => {
    const own = owner();
    const actual = normalizeSchema({ contracts: { C: { fields: {
      good: { type: "text", default: "first" },
    } } } });
    const seen: string[] = [];
    const failure = new Error("bounds getter failure");
    const field = { ...actual.contracts["C"]!.fields["good"]!,
      get default() { seen.push("default"); return "first"; },
      get valueMin(): never { seen.push("valueMin"); throw failure; },
    };
    const schema = { ...actual, contracts: { C: { fields: { good: field } } } };
    recordFactoryProvenance(schema, own.scope.ownerRevision);
    assert.throws(() => registerValidationPlan(own, profile, schema), (err) => err === failure);
    assert.deepEqual(seen, ["default", "default", "valueMin"]);
    unknownDefault(own, "0:contracts.C.fields.good");
    error(() => getValidationPlan(own, id(0)), "unknown-plan");
    assert.equal(register(own, actual), id(1));
  });

  it("keeps original admission gates ahead of schema reads and sequence consumption", () => {
    const own = owner();
    const actual = normalizeSchema({ contracts: { C: { fields: {
      good: { type: "text", default: "ready" },
    } } } });
    error(() => registerValidationPlan({}, "", actual), "foreign-owner");
    error(() => registerValidationPlan(own, "", actual), "invalid-profile");
    error(() => registerValidationPlan(own, profile, "C"), "legacy-wrapper");
    error(() => registerValidationPlan(own, profile, actual), "missing-provenance");
    recordFactoryProvenance(actual, "stale-revision");
    error(() => registerValidationPlan(own, profile, actual), "stale-scope");
    unknownDefault(own, "0:contracts.C.fields.good");
    assert.equal(register(own, actual), id(0));
  });
});
