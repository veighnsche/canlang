import assert from "node:assert/strict";
import { test } from "node:test";
import { createServingValidation, encodeServingLiteral } from "../bindings/serving-validation.js";
import { Decimal } from "../src/decimal.js";
import { normalizeSchema } from "../src/schema.js";
import {
  createPlanOwner, getValidationPlan, PlanError, recordFactoryProvenance,
  registerFactoryValidationPlan, registerValidationPlan,
} from "../src/prepared/plan.js";

const scope = { abiVersion: "values/v1", profileVersion: "validation/v1",
  backendId: "ordinary-ts-serving", ownerRevision: "actual-checked-load" };

test("serving literal projection uses the owning codec and retains nested declared Decimal scales", () => {
  const literal = { amount: new Decimal(1230n, 3), zeros: [new Decimal(0n, 3)] };
  assert.deepEqual(encodeServingLiteral('C', literal), { amount: '1.230', zeros: ['0.000'] });
  assert.equal(encodeServingLiteral('int', 1n), '1');
  assert.throws(() => encodeServingLiteral('int', '1'));
});

test("serving factory binds exact owner, not equal revision text or schema shape", () => {
  const a = createPlanOwner(scope), b = createPlanOwner(scope);
  const { schema, id } = registerFactoryValidationPlan(a, scope.profileVersion, {});
  assert.equal(getValidationPlan(a, id).id, id);
  assert.throws(() => registerValidationPlan(b, scope.profileVersion, schema),
    (error: unknown) => error instanceof PlanError && error.code === "foreign-owner");
  assert.throws(() => recordFactoryProvenance(schema, scope.ownerRevision),
    (error: unknown) => error instanceof PlanError && error.code === "foreign-owner");
  for (const forged of [Object.freeze({ ...schema }), new Proxy(schema, {}), normalizeSchema({})]) {
    assert.throws(() => registerValidationPlan(a, scope.profileVersion, forged),
      (error: unknown) => error instanceof PlanError && error.code === "missing-provenance");
  }
  const stale = createPlanOwner({ ...scope, ownerRevision: "other-load" });
  assert.throws(() => registerValidationPlan(stale, scope.profileVersion, schema),
    (error: unknown) => error instanceof PlanError && error.code === "stale-scope");
});

test("serving defaults retain exact Decimal content, detached registry identity and release lifetime", () => {
  const descriptor = { contracts: { C: { fields: {
    amount: { type: "decimal", default: "-0.000" }, tags: { type: "text[]", default: ["kept"] },
  } } } };
  const serving = createServingValidation(scope, descriptor);
  const plan = serving.plan();
  const amountRef = plan.contracts.C!.fields[0]!.defaultRef!, tagsRef = plan.contracts.C!.fields[1]!.defaultRef!;
  const amount = serving.resolveDefault(amountRef), tags = serving.resolveDefault(tagsRef);
  assert.ok(amount instanceof Decimal); assert.equal(amount.coef, 0n); assert.equal(amount.scale, 3);
  assert.equal(serving.resolveDefault(amountRef), amount);
  assert.notEqual(tags, descriptor.contracts.C.fields.tags.default);
  descriptor.contracts.C.fields.tags.default[0] = "mutated";
  descriptor.contracts.C.fields.amount.default = "8.00";
  assert.deepEqual(tags, ["kept"]);
  const first = serving.validate("C", {}, "create") as Record<string, unknown>;
  const next = serving.validate("C", {}, "create") as Record<string, unknown>;
  assert.equal(first.amount, next.amount); assert.equal(first.tags, next.tags);
  assert.ok(first.amount instanceof Decimal); assert.equal(first.amount.scale, 3);
  serving.close(); serving.close();
  assert.throws(() => serving.plan(), PlanError);
  assert.throws(() => serving.validate("C", {}, "create"), PlanError);
  assert.equal(serving.resolveDefault(tagsRef), tags);
});

test("failed later factory fields and unsupported profile never publish a partial serving plan", () => {
  const owner = createPlanOwner(scope);
  assert.throws(() => registerFactoryValidationPlan(owner, scope.profileVersion,
    { contracts: { C: { fields: { good: { type: "decimal", default: "1.250" }, bad: { type: "int", default: "bad" } } } } }));
  assert.throws(() => getValidationPlan(owner, `plan:values/v1:validation/v1:ordinary-ts-serving:actual-checked-load:g0:0`), PlanError);
  assert.throws(() => createServingValidation(scope, { aliases: { Name: { type: "text", min: 1, max: 20, format: "name" } } }), PlanError);
  const good = registerFactoryValidationPlan(owner, scope.profileVersion, {});
  assert.match(good.id, /:g0:0$/);
});
