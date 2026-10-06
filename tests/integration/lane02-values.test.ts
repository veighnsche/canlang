import { createRequire } from "node:module";
/**
 * Lane-02 values join contribution (L7 directory; this ONE file is the
 * lane-02 case body per the join contract in `tests/integration/README.md`).
 *
 * Drives the values producer only through its owned surface (dynamic
 * `@canlang/values` dist import; no copied implementation), executes the
 * curated wire/operation tables from
 * `packages/values/conformance/v1/values.json`, and assembles a real
 * `@canlang/testkit` report. Every evidence row is labelled `local` in its
 * detail string. Observations of exact values are compared as wire forms
 * via `diffReportValues`, demonstrating the landed ReportValue rule
 * (`packages/contracts/src/examples.ts`).
 *
 * When the values dist is absent (root CI without a values build), every
 * producer-dependent row reports `unsupported` with the exact absent detail
 * below — never green on mocks. Two rows are permanently `unsupported` and
 * name the exact unmet producer contracts for full B1/B2 value integration.
 *
 * Fast (<30s), no processes spawned, no temp state.
 *
 * Note: fixtures load via `readFileSync` (synchronous at collection, so a
 * missing file still fails loud) because the root check config has no
 * `resolveJsonModule`, which a static JSON import would need to typecheck.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createReport, diffReportValues } from "@canlang/testkit";
import type {
  ObservationMismatch,
  ReportValue,
  ResolvedCaller,
  TableCaseResult,
  TableRowResult,
} from "@canlang/contracts";

/** Exact absent-producer detail every producer-dependent row carries. */
const ABSENT_SENTENCE =
  "@canlang/values dist absent; run root `bun run test` (pretest builds it) or `bun run build` in packages/values";
const ABSENT_DETAIL = `local | ${ABSENT_SENTENCE}`;

const LOCAL_CALLER: ResolvedCaller = {
  account: "local-lane02",
  team: null,
  roles: [],
  authenticated: false,
};

// ---------------------------------------------------------------------------
// Fixture loading (committed JSON; malformed content throws loudly).
// ---------------------------------------------------------------------------

interface FixtureViolation {
  path: Array<string | number>;
  code: string;
}

interface WireSample {
  typeId: string;
  wire: unknown;
  expected?: unknown;
  expectedViolations?: FixtureViolation[];
}

interface InputCase {
  op: string;
  args: unknown;
  expected?: unknown;
  expectedViolations?: FixtureViolation[];
}

interface JoinFixtures {
  version: number;
  valuesRevision: string;
  wireSamples: WireSample[];
  builtinCallIds: string[];
  schema: unknown;
  inputCases: InputCase[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asViolations(value: unknown, what: string): FixtureViolation[] {
  if (!Array.isArray(value)) {
    throw new Error(`${what} must be an array`);
  }
  return value.map((entry: unknown, index: number): FixtureViolation => {
    if (!isRecord(entry) || !Array.isArray(entry["path"]) || typeof entry["code"] !== "string") {
      throw new Error(`${what}[${index}] must be {path, code}`);
    }
    const path: unknown[] = entry["path"];
    for (const segment of path) {
      if (typeof segment !== "string" && typeof segment !== "number") {
        throw new Error(`${what}[${index}].path segments must be strings or numbers`);
      }
    }
    return { path: path as Array<string | number>, code: entry["code"] };
  });
}

function asWireSample(value: unknown, index: number): WireSample {
  if (!isRecord(value) || typeof value["typeId"] !== "string" || !("wire" in value)) {
    throw new Error(`wireSamples[${index}] must be {typeId, wire, ...}`);
  }
  const sample: WireSample = { typeId: value["typeId"], wire: value["wire"] };
  if (value["expected"] !== undefined) {
    sample.expected = value["expected"];
  }
  if (value["expectedViolations"] !== undefined) {
    sample.expectedViolations = asViolations(value["expectedViolations"], `wireSamples[${index}]`);
  }
  return sample;
}

function asInputCase(value: unknown, index: number): InputCase {
  if (!isRecord(value) || typeof value["op"] !== "string" || !("args" in value)) {
    throw new Error(`inputCases[${index}] must be {op, args, ...}`);
  }
  const sample: InputCase = { op: value["op"], args: value["args"] };
  if (value["expected"] !== undefined) {
    sample.expected = value["expected"];
  }
  if (value["expectedViolations"] !== undefined) {
    sample.expectedViolations = asViolations(value["expectedViolations"], `inputCases[${index}]`);
  }
  return sample;
}

function loadFixtures(): JoinFixtures {
  const url = createRequire(import.meta.url).resolve("@canlang/values/conformance/v1/values.json");
  const raw = JSON.parse(readFileSync(url, "utf8")) as unknown;
  if (!isRecord(raw)) {
    throw new Error("values.json must be an object");
  }
  const meta = raw["meta"];
  if (!isRecord(meta) || typeof meta["version"] !== "number" || typeof meta["valuesRevision"] !== "string") {
    throw new Error("values.json meta must be {version, valuesRevision, ...}");
  }
  if (!Array.isArray(raw["wireSamples"]) || !Array.isArray(raw["builtinCalls"]) || !isRecord(raw["operationSamples"])) {
    throw new Error("values.json must carry wireSamples, builtinCalls and operationSamples");
  }
  const samples = raw["operationSamples"];
  if (!Array.isArray(samples["inputCases"]) || !("schema" in samples)) {
    throw new Error("operationSamples must carry schema and inputCases");
  }
  return {
    version: meta["version"],
    valuesRevision: meta["valuesRevision"],
    wireSamples: (raw["wireSamples"] as unknown[]).map(asWireSample),
    builtinCallIds: (raw["builtinCalls"] as unknown[]).map((entry: unknown, index: number): string => {
      if (!isRecord(entry) || typeof entry["id"] !== "string") {
        throw new Error(`builtinCalls[${index}] must be {id, ...}`);
      }
      return entry["id"];
    }),
    schema: samples["schema"],
    inputCases: (samples["inputCases"] as unknown[]).map(asInputCase),
  };
}

const fixtures = loadFixtures();

// ---------------------------------------------------------------------------
// Producer surface (dynamic dist import; absent dist routes to unsupported).
// ---------------------------------------------------------------------------

interface CatalogEntryView {
  id: string;
  js: string;
  availability: string;
}

interface ValuesProducer {
  CATALOG: { entries: readonly CatalogEntryView[] };
  decodeValue: (typeId: string, wire: unknown) => unknown;
  encodeValue: (typeId: string, value: unknown) => unknown;
  normalizeSchema: (descriptor: unknown) => unknown;
  validateOperationInput: (schema: unknown, op: string, args: unknown) => Record<string, unknown>;
  [key: string]: unknown;
}

const VALUES_SPECIFIER = "@canlang/values";

async function loadProducer(): Promise<ValuesProducer | null> {
  let mod: unknown;
  try {
    // Non-literal specifier: no static dependency on the values dist types,
    // so this file typechecks and collects with the dist absent.
    mod = await import(VALUES_SPECIFIER);
  } catch {
    return null;
  }
  if (!isRecord(mod)) {
    throw new Error("@canlang/values loaded but exported no namespace object");
  }
  const catalog = mod["CATALOG"];
  if (
    !isRecord(catalog) ||
    !Array.isArray(catalog["entries"]) ||
    typeof mod["decodeValue"] !== "function" ||
    typeof mod["encodeValue"] !== "function" ||
    typeof mod["normalizeSchema"] !== "function" ||
    typeof mod["validateOperationInput"] !== "function"
  ) {
    throw new Error("@canlang/values dist is present but lacks the join surface (stale build?)");
  }
  for (const [index, entry] of (catalog["entries"] as unknown[]).entries()) {
    if (
      !isRecord(entry) ||
      typeof entry["id"] !== "string" ||
      typeof entry["js"] !== "string" ||
      typeof entry["availability"] !== "string"
    ) {
      throw new Error(`producer CATALOG entry ${index} is malformed`);
    }
  }
  return mod as unknown as ValuesProducer;
}

// ---------------------------------------------------------------------------
// Row helpers.
// ---------------------------------------------------------------------------

function passedRow(rowIndex: number, label: string, mismatches: ObservationMismatch[]): TableRowResult {
  if (mismatches.length > 0) {
    return {
      rowIndex,
      caller: LOCAL_CALLER,
      outcome: "failed",
      mismatches,
      detail: `local | ${label}: ${mismatches.length} mismatch(es)`,
    };
  }
  return { rowIndex, caller: LOCAL_CALLER, outcome: "passed", detail: `local | ${label}` };
}

function failedRow(rowIndex: number, label: string, problem: string): TableRowResult {
  return { rowIndex, caller: LOCAL_CALLER, outcome: "failed", detail: `local | ${label}: ${problem}` };
}

function unsupportedRow(rowIndex: number, detail: string): TableRowResult {
  return { rowIndex, caller: LOCAL_CALLER, outcome: "unsupported", detail };
}

/** Runs one check body; unexpected throws become failed rows, never aborts. */
function runCheck(rowIndex: number, label: string, body: () => ObservationMismatch[]): TableRowResult {
  try {
    return passedRow(rowIndex, label, body());
  } catch (err) {
    return failedRow(rowIndex, label, err instanceof Error ? err.message : String(err));
  }
}

interface RejectionObservation {
  ok: boolean;
  violations: FixtureViolation[];
  problem: string;
}

/**
 * Observes a schema rejection the BDD way: the call must throw a SchemaError
 * (by name, with a non-empty violations array) that carries NO business
 * `code` field — a schema failure never satisfies `error(code)`.
 */
function observeSchemaRejection(call: () => unknown): RejectionObservation {
  try {
    call();
  } catch (err) {
    if (typeof err !== "object" || err === null || (err as { name?: unknown }).name !== "SchemaError") {
      const name =
        typeof err === "object" && err !== null
          ? String((err as { name?: unknown }).name ?? typeof err)
          : String(err);
      return { ok: false, violations: [], problem: `expected SchemaError, got ${name}` };
    }
    if ("code" in err) {
      return { ok: false, violations: [], problem: "SchemaError carries a business code field" };
    }
    const violations = (err as { violations?: unknown }).violations;
    if (!Array.isArray(violations) || violations.length === 0) {
      return { ok: false, violations: [], problem: "SchemaError without violations" };
    }
    const narrowed: FixtureViolation[] = [];
    for (const item of violations as unknown[]) {
      if (
        !isRecord(item) ||
        !Array.isArray(item["path"]) ||
        typeof item["code"] !== "string" ||
        !(item["path"] as unknown[]).every(
          (segment: unknown): boolean => typeof segment === "string" || typeof segment === "number",
        )
      ) {
        return { ok: false, violations: [], problem: "SchemaError violation is not {path, code}" };
      }
      narrowed.push({ path: [...(item["path"] as Array<string | number>)], code: item["code"] });
    }
    return { ok: true, violations: narrowed, problem: "" };
  }
  return { ok: false, violations: [], problem: "expected SchemaError, but nothing was thrown" };
}

/** Minimal join-case spec decoder: $t/$bigint plus structural recursion. */
function decodeJoinSpec(producer: ValuesProducer, spec: unknown, label: string): unknown {
  if (Array.isArray(spec)) {
    return spec.map((entry: unknown, index: number): unknown =>
      decodeJoinSpec(producer, entry, `${label}[${index}]`),
    );
  }
  if (isRecord(spec)) {
    if (Object.hasOwn(spec, "$t")) {
      if (typeof spec["$t"] !== "string") {
        throw new Error(`${label}.$t must be a string`);
      }
      return producer.decodeValue(spec["$t"], spec["$w"]);
    }
    if (Object.hasOwn(spec, "$bigint")) {
      if (typeof spec["$bigint"] !== "string") {
        throw new Error(`${label}.$bigint must be a string`);
      }
      return BigInt(spec["$bigint"]);
    }
    if (Object.hasOwn(spec, "$fn") || Object.hasOwn(spec, "$message") || Object.hasOwn(spec, "$omitted")) {
      throw new Error(`${label}: executable specs are lane-runner-only, not join observations`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(spec)) {
      out[key] = decodeJoinSpec(producer, entry, `${label}.${key}`);
    }
    return out;
  }
  return spec;
}

function inputTypeIds(schema: unknown, op: string): Record<string, string> {
  if (!isRecord(schema) || !isRecord(schema["operations"])) {
    throw new Error(`normalized schema has no operations table for ${op}`);
  }
  const operations = schema["operations"];
  const operation = operations[op];
  if (!isRecord(operation) || !isRecord(operation["inputs"])) {
    throw new Error(`normalized schema has no inputs for ${op}`);
  }
  const out: Record<string, string> = {};
  for (const [name, field] of Object.entries(operation["inputs"])) {
    if (!isRecord(field) || typeof field["typeId"] !== "string") {
      throw new Error(`normalized schema input ${op}.${name} has no typeId`);
    }
    out[name] = field["typeId"];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Curated wire subset (one selector per covered shape).
// ---------------------------------------------------------------------------

interface WireSelector {
  key: string;
  match: (row: WireSample) => boolean;
}

function wireField(row: WireSample, field: string): unknown {
  return isRecord(row.wire) ? row.wire[field] : undefined;
}

const WIRE_SELECTORS: WireSelector[] = [
  { key: "wire:int", match: (r) => r.typeId === "int" && r.wire === "9007199254740993" },
  { key: "wire:decimal", match: (r) => r.typeId === "decimal" && r.wire === "1.50" },
  { key: "wire:money", match: (r) => r.typeId === "money" && wireField(r, "minor") === "007" },
  { key: "wire:date", match: (r) => r.typeId === "date" && r.wire === "2026-02-28" },
  { key: "wire:datetime", match: (r) => r.typeId === "datetime" && r.wire === "2026-03-08T07:30:00.000Z" },
  { key: "wire:duration", match: (r) => r.typeId === "duration" && r.wire === "1500" },
  { key: "wire:ref", match: (r) => r.typeId === "Todo" && wireField(r, "version") === "007" },
  { key: "wire:union", match: (r) => r.typeId === "user|Todo" && r.expected !== undefined },
  { key: "wire:delivery", match: (r) => r.typeId === "delivery" && r.expected !== undefined },
  { key: "wire:file", match: (r) => r.typeId === "file" && r.expected !== undefined },
  { key: "wire:user", match: (r) => r.typeId === "user" && r.expected !== undefined },
  { key: "wire:member", match: (r) => r.typeId === "member" && r.expected !== undefined },
  { key: "wire:action", match: (r) => r.typeId === "action" && r.expected !== undefined },
  { key: "wire:secret-refusal", match: (r) => r.typeId === "secret" },
  { key: "wire:invalid-currency", match: (r) => r.typeId === "money" && r.expected === undefined },
  { key: "wire:invalid-zone", match: (r) => r.typeId === "timezone" && r.expected === undefined },
  { key: "wire:invalid-action-binding", match: (r) => r.typeId === "action" && r.expected === undefined },
];

function checkValidWire(producer: ValuesProducer, key: string, row: WireSample): ObservationMismatch[] {
  if (row.expected === undefined) {
    throw new Error(`${key}: fixture row lost its expected wire`);
  }
  const decoded = producer.decodeValue(row.typeId, row.wire);
  const actual = producer.encodeValue(row.typeId, decoded);
  return diffReportValues(key, row.expected as ReportValue, actual as ReportValue);
}

function checkInvalidWire(producer: ValuesProducer, key: string, row: WireSample): ObservationMismatch[] {
  if (row.expectedViolations === undefined) {
    throw new Error(`${key}: fixture row lost its expected violations`);
  }
  const observed = observeSchemaRejection(() => producer.decodeValue(row.typeId, row.wire));
  if (!observed.ok) {
    throw new Error(`${key}: ${observed.problem}`);
  }
  return diffReportValues(
    key,
    row.expectedViolations as unknown as ReportValue,
    observed.violations as unknown as ReportValue,
  );
}

function checkSecretWire(producer: ValuesProducer, key: string, row: WireSample): ObservationMismatch[] {
  const mismatches = checkInvalidWire(producer, key, row);
  let encodeName = "<no-throw>";
  try {
    producer.encodeValue("secret", { kind: "secret" });
  } catch (err) {
    encodeName =
      typeof err === "object" && err !== null ? String((err as { name?: unknown }).name) : String(err);
  }
  return [...mismatches, ...diffReportValues(`${key}.encode`, "ValueError", encodeName)];
}

function blockedRows(): TableRowResult[] {
  return [
    unsupportedRow(0, "local | BLOCKED (L1): `can compile` emission for compiler-literal round-trips"),
    unsupportedRow(
      1,
      "local | BLOCKED (L3): exported invocable surface + op descriptors for compiled-handler value observation",
    ),
  ];
}

// ---------------------------------------------------------------------------
// The join case.
// ---------------------------------------------------------------------------

describe("lane02 values join", () => {
  it("observes value fixtures through the real producer or reports unsupported", async () => {
    const producer = await loadProducer();
    const builder = createReport({
      digest: `values-conformance-v${fixtures.version}`,
      sourceRevision: fixtures.valuesRevision,
    });

    if (producer === null) {
      const catalogRows: TableRowResult[] = [...new Set(fixtures.builtinCallIds)].map(
        (_id: string, rowIndex: number): TableRowResult => unsupportedRow(rowIndex, ABSENT_DETAIL),
      );
      const wireRows: TableRowResult[] = WIRE_SELECTORS.map(
        (_selector: WireSelector, rowIndex: number): TableRowResult => unsupportedRow(rowIndex, ABSENT_DETAIL),
      );
      const opRows: TableRowResult[] = fixtures.inputCases.map(
        (_input: InputCase, rowIndex: number): TableRowResult => unsupportedRow(rowIndex, ABSENT_DETAIL),
      );
      const catalogCase: TableCaseResult = { kind: "table", operation: "lane02.values.catalog", rows: catalogRows };
      const wireCase: TableCaseResult = { kind: "table", operation: "lane02.values.wire", rows: wireRows };
      const opCase: TableCaseResult = { kind: "table", operation: "lane02.values.operations", rows: opRows };
      const blockedCase: TableCaseResult = {
        kind: "table",
        operation: "lane02.values.blocked",
        rows: blockedRows(),
      };
      builder.addCase(catalogCase);
      builder.addCase(wireCase);
      builder.addCase(opCase);
      builder.addCase(blockedCase);
      const report = builder.build();
      expect(report.summary.total).toBe(catalogRows.length + wireRows.length + opRows.length + 2);
      expect(report.summary.passed).toBe(0);
      expect(report.summary.failed).toBe(0);
      expect(report.summary.setupFailed).toBe(0);
      expect(report.summary.unsupported).toBe(report.summary.total);
      expect(report.summary.unsupported).toBeGreaterThan(0);
      for (const table of [catalogCase, wireCase, opCase]) {
        for (const row of table.rows) {
          expect(row.outcome).toBe("unsupported");
          expect(row.detail).toContain(ABSENT_SENTENCE);
          expect(row.detail).toContain("local");
        }
      }
      return;
    }

    // Present path: run the key tables for real.
    const implemented = producer.CATALOG.entries.filter((entry) => entry.availability === "implemented");
    expect(implemented.length).toBe(57);
    const fixtureIds = new Set(fixtures.builtinCallIds);
    const catalogRows = implemented.map((entry, rowIndex): TableRowResult => {
      if (!fixtureIds.has(entry.id)) {
        return failedRow(rowIndex, `catalog:${entry.id}`, "no builtinCalls fixture row (mock gap)");
      }
      return runCheck(rowIndex, `catalog:${entry.id} -> ${entry.js}`, () =>
        diffReportValues(`catalog:${entry.id}`, "function", typeof producer[entry.js]),
      );
    });
    builder.addCase({ kind: "table", operation: "lane02.values.catalog", rows: catalogRows });

    const wireRows = WIRE_SELECTORS.map((selector, rowIndex): TableRowResult => {
      const row = fixtures.wireSamples.find((candidate) => selector.match(candidate));
      if (row === undefined) {
        return failedRow(rowIndex, selector.key, "fixture selector missed its row");
      }
      if (selector.key === "wire:secret-refusal") {
        return runCheck(rowIndex, selector.key, () => checkSecretWire(producer, selector.key, row));
      }
      if (row.expected !== undefined) {
        return runCheck(rowIndex, selector.key, () => checkValidWire(producer, selector.key, row));
      }
      return runCheck(rowIndex, selector.key, () => checkInvalidWire(producer, selector.key, row));
    });
    builder.addCase({ kind: "table", operation: "lane02.values.wire", rows: wireRows });

    let schema: unknown = null;
    let schemaProblem = "";
    try {
      schema = producer.normalizeSchema(fixtures.schema);
    } catch (err) {
      schemaProblem = err instanceof Error ? err.message : String(err);
    }
    const opRows = fixtures.inputCases.map((input, rowIndex): TableRowResult => {
      const label = `op:${input.op}#${rowIndex}`;
      if (schemaProblem !== "") {
        return failedRow(rowIndex, label, `normalizeSchema failed: ${schemaProblem}`);
      }
      return runCheck(rowIndex, label, (): ObservationMismatch[] => {
        if (input.expectedViolations !== undefined) {
          const observed = observeSchemaRejection(() =>
            producer.validateOperationInput(schema, input.op, input.args),
          );
          if (!observed.ok) {
            throw new Error(observed.problem);
          }
          return diffReportValues(
            label,
            input.expectedViolations as unknown as ReportValue,
            observed.violations as unknown as ReportValue,
          );
        }
        if (!isRecord(input.expected) || !("$value" in input.expected)) {
          throw new Error(`${label}: valid row needs an expected $value object`);
        }
        const validated = producer.validateOperationInput(schema, input.op, input.args);
        const typeIds = inputTypeIds(schema, input.op);
        const typeOf = (name: string): string => {
          if (name === "operation_id") {
            return "text";
          }
          const typeId = typeIds[name];
          if (typeId === undefined) {
            throw new Error(`${label}: no declared type for argument ${JSON.stringify(name)}`);
          }
          return typeId;
        };
        const actualWire: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(validated)) {
          actualWire[name] = producer.encodeValue(typeOf(name), value);
        }
        const decodedExpected = decodeJoinSpec(producer, input.expected["$value"], `${label}.expected`);
        if (!isRecord(decodedExpected)) {
          throw new Error(`${label}: expected value must decode to an argument object`);
        }
        const expectedWire: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(decodedExpected)) {
          expectedWire[name] = producer.encodeValue(typeOf(name), value);
        }
        return diffReportValues(
          label,
          expectedWire as unknown as ReportValue,
          actualWire as unknown as ReportValue,
        );
      });
    });
    builder.addCase({ kind: "table", operation: "lane02.values.operations", rows: opRows });
    builder.addCase({ kind: "table", operation: "lane02.values.blocked", rows: blockedRows() });

    const report = builder.build();
    expect(report.summary.passed).toBeGreaterThan(0);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.setupFailed).toBe(0);
    expect(report.summary.unsupported).toBe(2);
    for (const table of report.cases) {
      if (table.kind !== "table") {
        continue;
      }
      for (const row of table.rows) {
        expect(row.detail).toContain("local");
      }
    }
  });
});
