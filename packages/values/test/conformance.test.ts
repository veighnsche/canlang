/**
 * Conformance runner for `../conformance/v1/values.json` (lane-02 PR6
 * integration contribution). Executes every fixture row against the real
 * producer barrel (`../src/index.js`) plus `CATALOG`, so the versioned
 * consumer fixtures B1/B2 legs import can never drift from the code.
 *
 * Fixture spec mini-language (JSON-encodable arguments and expectations):
 * - `{"$t": typeId, "$w": wire}` decodes via `decodeValue` (exact scalars).
 * - `{"$bigint": "123"}` is an unchecked `BigInt` for inputs no decoder can
 *   produce (out-of-range `int64` probes).
 * - `{"$fn": name, "arg"?}` compiles the 4 predicate/key functions the
 *   fixtures need: `gt`/`lt`/`eq` against the decoded `arg` (bigint or
 *   string operands) and `identity`. Used by `any`/`all`/`group` only.
 * - `{"$message": {source, variants, params?}}` builds a message descriptor
 *   via `makeMessageDescriptor`; param entries are `{type, value}` with
 *   `value` a spec.
 * - `{"$omitted": true}` is the `UPDATE_OMITTED` sentinel (update-mode
 *   expectations only).
 * - Arrays recurse elementwise; plain objects recurse per key (`format`
 *   value objects, `action` bindings, nested `flatten` domains); every other
 *   JSON scalar passes through untouched (`text`/`bool` arguments, `round`
 *   scales, `sum` element tags, `equalValue` type ids, `formatMessage`
 *   options).
 * Expectations are `{"$t", "$w"}` (encode the actual result and compare
 * wire), `{"$value": spec}` (decode and compare structurally, for results
 * with no wire type), or `{"$raw": json}` (direct deep equality for
 * plain-JS results like `compare*` numbers). Errors are
 * `{class: "ValueError", code?}` / `{class: "SchemaError", codes?}`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { CanValue, Violation } from "../../contracts/src/values.js";
import type { MessageParam } from "../src/icu.js";
import { CATALOG } from "../src/catalog.js";
import * as barrel from "../src/index.js";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function needObject(value: unknown, what: string): JsonObject {
  if (!isJsonObject(value)) {
    assert.fail(`${what} must be an object`);
  }
  return value;
}

function needString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    assert.fail(`${what} must be a string`);
  }
  return value;
}

function needArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    assert.fail(`${what} must be an array`);
  }
  return value;
}

function needBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    assert.fail(`${what} must be a boolean`);
  }
  return value;
}

function loadFixtures(): JsonObject {
  // Compiled tests run from `dist/values/test/` (JSON stays in the source
  // tree); the second candidate covers source-tree runners.
  const candidates = ["../../../conformance/v1/values.json", "../conformance/v1/values.json"];
  for (const relative of candidates) {
    const url = new URL(relative, import.meta.url);
    if (existsSync(url)) {
      return needObject(JSON.parse(readFileSync(url, "utf8")) as unknown, "values.json");
    }
  }
  assert.fail("values.json not found beside the test (tried dist and source layouts)");
}

function compareFixtureScalars(left: unknown, right: unknown, what: string): number {
  if (typeof left === "bigint" && typeof right === "bigint") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  assert.fail(`${what} needs bigint or string operands`);
}

function equalFixtureScalars(left: unknown, right: unknown, what: string): boolean {
  if (typeof left !== typeof right) {
    assert.fail(`${what} needs same-typed operands`);
  }
  if (typeof left !== "bigint" && typeof left !== "string" && typeof left !== "boolean") {
    assert.fail(`${what} needs bigint, string or boolean operands`);
  }
  return left === right;
}

function compilePredicate(spec: JsonObject, label: string): (item: unknown) => unknown {
  const name = needString(spec["$fn"], `${label}.$fn`);
  if (name === "identity") {
    return (item: unknown): unknown => item;
  }
  const arg: unknown = decodeSpec(spec["arg"], `${label}.arg`);
  if (name === "gt") {
    return (item: unknown): boolean => compareFixtureScalars(item, arg, label) > 0;
  }
  if (name === "lt") {
    return (item: unknown): boolean => compareFixtureScalars(item, arg, label) < 0;
  }
  if (name === "eq") {
    return (item: unknown): boolean => equalFixtureScalars(item, arg, label);
  }
  assert.fail(`${label}: unknown $fn ${JSON.stringify(name)}`);
}

function compileMessage(spec: unknown, label: string): unknown {
  const raw = needObject(spec, label);
  const source = needString(raw["source"], `${label}.source`);
  const variantsRaw = needObject(raw["variants"], `${label}.variants`);
  const variants: Record<string, string | null> = {};
  for (const [tag, text] of Object.entries(variantsRaw)) {
    if (typeof text !== "string" && text !== null) {
      assert.fail(`${label}.variants.${tag} must be text or null`);
    }
    variants[tag] = text;
  }
  const paramsRaw: unknown = raw["params"];
  if (paramsRaw === undefined) {
    return barrel.makeMessageDescriptor(source, variants);
  }
  const params: Record<string, MessageParam> = {};
  for (const [name, entry] of Object.entries(needObject(paramsRaw, `${label}.params`))) {
    const param = needObject(entry, `${label}.params.${name}`);
    params[name] = {
      type: needString(param["type"], `${label}.params.${name}.type`) as MessageParam["type"],
      value: decodeSpec(param["value"], `${label}.params.${name}.value`) as MessageParam["value"],
    };
  }
  return barrel.makeMessageDescriptor(source, variants, params);
}

/** Decodes one argument/expectation spec into the runtime value the producer takes. */
function decodeSpec(spec: unknown, label: string): unknown {
  if (Array.isArray(spec)) {
    return spec.map((entry: unknown, index: number): unknown => decodeSpec(entry, `${label}[${index}]`));
  }
  if (isJsonObject(spec)) {
    if (Object.hasOwn(spec, "$t")) {
      return barrel.decodeValue(needString(spec["$t"], `${label}.$t`), spec["$w"]);
    }
    if (Object.hasOwn(spec, "$bigint")) {
      return BigInt(needString(spec["$bigint"], `${label}.$bigint`));
    }
    if (Object.hasOwn(spec, "$fn")) {
      return compilePredicate(spec, label);
    }
    if (Object.hasOwn(spec, "$message")) {
      return compileMessage(spec["$message"], `${label}.$message`);
    }
    if (Object.hasOwn(spec, "$omitted")) {
      needBoolean(spec["$omitted"], `${label}.$omitted`);
      return barrel.UPDATE_OMITTED;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(spec)) {
      out[key] = decodeSpec(entry, `${label}.${key}`);
    }
    return out;
  }
  return spec;
}

function checkExpected(label: string, actual: unknown, expected: unknown): void {
  const spec = needObject(expected, `${label}.expected`);
  if (Object.hasOwn(spec, "$t")) {
    const wire = barrel.encodeValue(needString(spec["$t"], `${label}.expected.$t`), actual as CanValue);
    assert.deepEqual(wire, spec["$w"]);
    return;
  }
  if (Object.hasOwn(spec, "$value")) {
    assert.deepEqual(actual, decodeSpec(spec["$value"], `${label}.expected.$value`));
    return;
  }
  if (Object.hasOwn(spec, "$raw")) {
    assert.deepEqual(actual, spec["$raw"]);
    return;
  }
  assert.fail(`${label}: expected needs one of $t/$value/$raw`);
}

/**
 * Asserts a SchemaError the BDD way: structured violations, and NEVER a
 * business `code` field (a schema failure cannot satisfy `error(code)`).
 */
function needSchemaViolations(label: string, err: unknown): readonly Violation[] {
  assert.ok(err instanceof barrel.SchemaError, `${label}: expected SchemaError, got ${String(err)}`);
  assert.ok(!("code" in (err as object)), `${label}: SchemaError must not carry a business code field`);
  assert.ok(err.violations.length > 0, `${label}: SchemaError must carry violations`);
  return err.violations;
}

function checkViolations(label: string, err: unknown, expectedViolations: unknown): void {
  const wanted = needArray(expectedViolations, `${label}.expectedViolations`);
  const actual = needSchemaViolations(label, err);
  assert.equal(actual.length, wanted.length, `${label}: violation count`);
  wanted.forEach((entry: unknown, index: number): void => {
    const item = needObject(entry, `${label}.expectedViolations[${index}]`);
    const path = needArray(item["path"], `${label}.expectedViolations[${index}].path`);
    for (const segment of path) {
      if (typeof segment !== "string" && typeof segment !== "number") {
        assert.fail(`${label}.expectedViolations[${index}].path segments must be strings or numbers`);
      }
    }
    const violation = actual[index];
    assert.ok(violation !== undefined, `${label}: missing violation ${index}`);
    assert.deepEqual([...violation.path], path);
    assert.equal(violation.code, needString(item["code"], `${label}.expectedViolations[${index}].code`));
  });
}

function checkExpectedError(label: string, call: () => unknown, expectedError: unknown): void {
  const spec = needObject(expectedError, `${label}.expectedError`);
  const cls = needString(spec["class"], `${label}.expectedError.class`);
  try {
    call();
  } catch (err) {
    if (cls === "ValueError") {
      assert.ok(err instanceof barrel.ValueError, `${label}: expected ValueError, got ${String(err)}`);
      if (spec["code"] !== undefined) {
        assert.equal(err.code, needString(spec["code"], `${label}.expectedError.code`));
      }
      return;
    }
    if (cls === "SchemaError") {
      const actual = needSchemaViolations(label, err);
      if (spec["codes"] !== undefined) {
        assert.deepEqual(
          actual.map((violation) => violation.code),
          needArray(spec["codes"], `${label}.expectedError.codes`),
        );
      }
      return;
    }
    assert.fail(`${label}: unknown error class ${JSON.stringify(cls)}`);
  }
  assert.fail(`${label}: expected ${cls}, but nothing was thrown`);
}

const fixtures = loadFixtures();
const wireSamples = needArray(fixtures["wireSamples"], "wireSamples");
const builtinCalls = needArray(fixtures["builtinCalls"], "builtinCalls");
const operationSamples = needObject(fixtures["operationSamples"], "operationSamples");

describe("values conformance fixtures", () => {
  it("pins the producer revision the fixtures were authored against", () => {
    const meta = needObject(fixtures["meta"], "meta");
    assert.equal(meta["version"], 1);
    assert.equal(meta["contractVersion"], barrel.VALUES_CONTRACT_VERSION);
    const revision = meta["valuesRevision"];
    assert.equal(typeof revision, "string");
    assert.ok((revision as string).length > 0);
  });

  it("covers every implemented catalog builtin and helper (no missing ids, no orphans)", () => {
    const implemented = CATALOG.entries.filter((entry) => entry.availability === "implemented");
    assert.ok(implemented.length > 0);
    const covered = new Set<string>();
    builtinCalls.forEach((row: unknown, index: number): void => {
      covered.add(needString(needObject(row, `builtinCalls[${index}]`)["id"], `builtinCalls[${index}].id`));
    });
    for (const entry of implemented) {
      assert.ok(covered.has(entry.id), `builtinCalls is missing catalog id ${JSON.stringify(entry.id)}`);
    }
    const known = new Set(CATALOG.entries.map((entry) => entry.id));
    for (const id of covered) {
      assert.ok(known.has(id), `builtinCalls has an orphan id ${JSON.stringify(id)}`);
    }
  });

  it("round-trips every wire sample through decode and canonical encode", () => {
    wireSamples.forEach((row: unknown, index: number): void => {
      const sample = needObject(row, `wireSamples[${index}]`);
      const typeId = needString(sample["typeId"], `wireSamples[${index}].typeId`);
      const label = `wireSamples[${index}] ${typeId}`;
      if (sample["expected"] !== undefined) {
        const decoded = barrel.decodeValue(typeId, sample["wire"]);
        assert.deepEqual(barrel.encodeValue(typeId, decoded), sample["expected"]);
        // The pinned expectation is itself canonical: re-decoding it is stable.
        assert.deepEqual(
          barrel.encodeValue(typeId, barrel.decodeValue(typeId, sample["expected"])),
          sample["expected"],
        );
        return;
      }
      assert.ok(
        sample["expectedViolations"] !== undefined,
        `${label}: needs expected or expectedViolations`,
      );
      try {
        barrel.decodeValue(typeId, sample["wire"]);
      } catch (err) {
        checkViolations(label, err, sample["expectedViolations"]);
        if (sample["encodeRefused"] === true) {
          const encodeError = needObject(sample["encodeError"], `${label}.encodeError`);
          checkExpectedError(
            `${label} encode`,
            () => barrel.encodeValue(typeId, { kind: "secret" }),
            {
              class: needString(encodeError["class"], `${label}.encodeError.class`),
              code: needString(encodeError["code"], `${label}.encodeError.code`),
            },
          );
        }
        return;
      }
      assert.fail(`${label}: expected SchemaError, but nothing was thrown`);
    });
  });

  it("executes every builtin call against the barrel", () => {
    const surface = barrel as unknown as Record<string, unknown>;
    const jsById = new Map(CATALOG.entries.map((entry) => [entry.id, entry.js] as const));
    builtinCalls.forEach((row: unknown, index: number): void => {
      const call = needObject(row, `builtinCalls[${index}]`);
      const id = needString(call["id"], `builtinCalls[${index}].id`);
      const label = `builtinCalls[${index}] ${id}`;
      const js = jsById.get(id);
      assert.ok(js !== undefined, `${label}: unknown catalog id`);
      const fn = surface[js];
      assert.equal(typeof fn, "function", `${label}: barrel has no function export ${JSON.stringify(js)}`);
      const target = fn as (...args: unknown[]) => unknown;
      const args = needArray(call["args"], `${label}.args`).map((entry: unknown, position: number): unknown =>
        decodeSpec(entry, `${label}.args[${position}]`),
      );
      if (call["expected"] !== undefined) {
        checkExpected(label, target(...args), call["expected"]);
        return;
      }
      assert.ok(call["expectedError"] !== undefined, `${label}: needs expected or expectedError`);
      checkExpectedError(label, () => target(...args), call["expectedError"]);
    });
  });

  it("validates operation samples with the SchemaError-never-error(code) rule", () => {
    const schema = barrel.normalizeSchema(operationSamples["schema"]);
    const valueCases = needArray(operationSamples["valueCases"], "operationSamples.valueCases");
    valueCases.forEach((row: unknown, index: number): void => {
      const sample = needObject(row, `valueCases[${index}]`);
      const typeId = needString(sample["typeId"], `valueCases[${index}].typeId`);
      const mode = needString(sample["mode"], `valueCases[${index}].mode`);
      assert.ok(mode === "create" || mode === "update", `valueCases[${index}]: mode must be create or update`);
      const label = `valueCases[${index}] ${typeId} ${mode}`;
      const validate = (): unknown =>
        mode === "create"
          ? barrel.validateValue(schema, typeId, sample["wire"], "create")
          : barrel.validateValue(schema, typeId, sample["wire"], "update");
      if (sample["expected"] !== undefined) {
        checkExpected(label, validate(), sample["expected"]);
        return;
      }
      assert.ok(
        sample["expectedViolations"] !== undefined,
        `${label}: needs expected or expectedViolations`,
      );
      try {
        validate();
      } catch (err) {
        checkViolations(label, err, sample["expectedViolations"]);
        return;
      }
      assert.fail(`${label}: expected SchemaError, but nothing was thrown`);
    });
    const inputCases = needArray(operationSamples["inputCases"], "operationSamples.inputCases");
    inputCases.forEach((row: unknown, index: number): void => {
      const sample = needObject(row, `inputCases[${index}]`);
      const op = needString(sample["op"], `inputCases[${index}].op`);
      const label = `inputCases[${index}] ${op}`;
      if (sample["expected"] !== undefined) {
        checkExpected(label, barrel.validateOperationInput(schema, op, sample["args"]), sample["expected"]);
        return;
      }
      assert.ok(
        sample["expectedViolations"] !== undefined,
        `${label}: needs expected or expectedViolations`,
      );
      try {
        barrel.validateOperationInput(schema, op, sample["args"]);
      } catch (err) {
        checkViolations(label, err, sample["expectedViolations"]);
        return;
      }
      assert.fail(`${label}: expected SchemaError, but nothing was thrown`);
    });
  });
});
