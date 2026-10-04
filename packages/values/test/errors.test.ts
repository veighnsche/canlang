import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SchemaError, ValueError } from "../src/errors.js";

describe("typed errors", () => {
  it("ValueError carries kind and code and is an Error", () => {
    const error = new ValueError("overflow", "int64 overflow");
    assert.ok(error instanceof Error);
    assert.equal(error.name, "ValueError");
    assert.equal(error.kind, "value");
    assert.equal(error.code, "overflow");
  });

  it("SchemaError carries violations and stays distinct from business errors", () => {
    const error = new SchemaError(
      [{ path: ["title"], code: "required", message: "title is required" }],
    );
    assert.ok(error instanceof Error);
    assert.equal(error.name, "SchemaError");
    assert.equal(error.kind, "schema");
    assert.equal(error.violations.length, 1);
    assert.ok(!(error instanceof ValueError));
  });

  it("SchemaError copies and freezes the violation list", () => {
    const violations = [{ path: ["n"], code: "type" as const, message: "bad" }];
    const error = new SchemaError(violations);
    violations.push({ path: ["m"], code: "type", message: "late" });
    assert.equal(error.violations.length, 1);
    assert.ok(Object.isFrozen(error.violations));
  });

});
