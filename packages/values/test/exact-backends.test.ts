// A07.3 whole-registry binding qualification: every selected operation
// through the genuine synchronous Wasm binding against the direct-TS
// backend, plus carrier/error/evaluation/identity controls and a supported
// generated-helper chain. The ts backend is the reference implementation;
// agreement here plus the pinned unit suites is the parity claim. No
// backend result is ever retried: each call crosses exactly once.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { max, min, sumMoney } from "../src/array.js";
import { Decimal, parseDecimal } from "../src/decimal.js";
import { SchemaError, ValueError } from "../src/errors.js";
import { addInt } from "../src/int.js";
import {
  isDatetime,
  isDateValue,
  isMoney,
  makeMoney,
} from "../src/kinds.js";
import { addMoney, money, multiplyMoney } from "../src/money.js";
import { abs, sum } from "../src/stdlib-pure.js";
import { compareDate } from "../src/temporal.js";
import { decodeValue, encodeValue } from "../src/wire.js";
import {
  decodeSelectedInt,
  encodeSelectedInt,
  exactOpNames,
  selectExactBackend,
  selectedExactBackendRead,
  selectSelectedIntBackend,
  tsBackend,
  wasmBackend,
  type ExactBackend,
} from "../bindings/backend.js";
import { bootstrapWasm } from "../bindings/bootstrap.js";
import { tag } from "../bindings/carriers.js";

const here = dirname(fileURLToPath(import.meta.url));
const wasmBytes = (): Uint8Array<ArrayBuffer> =>
  new Uint8Array(
    readFileSync(join(here, "..", "bindings", "generated", "values_semantics_bg.wasm")),
  );
const wasm = (): ExactBackend => bootstrapWasm(wasmBytes());

type CaseArg = { t: string; [key: string]: unknown };

/** Tagged corpus form to plain structural JS (the native parity domain). */
function toJS(value: CaseArg): unknown {
  switch (value.t) {
    case "bigint":
      return BigInt(value.v as string);
    case "num":
      return typeof value.v === "string" ? Number(value.v) : value.v;
    case "str":
      return value.v;
    case "bool":
      return value.v;
    case "null":
      return null;
    case "undef":
      return undefined;
    case "decimal":
      return { kind: "decimal", coef: BigInt(value.coef as string), scale: value.scale };
    case "money":
      return {
        kind: "money",
        minor: BigInt(value.minor as string),
        currency: value.currency,
      };
    case "date":
      return { kind: "date", year: value.year, month: value.month, day: value.day };
    case "datetime":
      return { kind: "datetime", ms: BigInt(value.ms as string) };
    case "array":
      return (value.items as CaseArg[]).map(toJS);
    case "record": {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.entries as Array<[string, CaseArg]>) {
        out[key] = toJS(item);
      }
      return out;
    }
    default:
      throw new Error(`corpus uses no tag: ${value.t}`);
  }
}

/** Comparison form preserving `-0`, BigInt magnitude and stored parts. */
function canon(value: unknown): unknown {
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "num:NaN";
    if (Object.is(value, -0)) return "num:-0";
    if (value === Infinity) return "num:Infinity";
    if (value === -Infinity) return "num:-Infinity";
    return `num:${String(value)}`;
  }
  if (typeof value === "string") return `str:${value}`;
  if (typeof value === "boolean" || value === null || value === undefined) return value;
  if (value instanceof Decimal) {
    return {
      kind: "decimal",
      coef: `bigint:${value.coef.toString()}`,
      scale: Object.is(value.scale, -0) ? "scale:-0" : `scale:${String(value.scale)}`,
    };
  }
  if (isMoney(value)) {
    return {
      kind: "money",
      minor: `bigint:${value.minor.toString()}`,
      currency: value.currency,
    };
  }
  if (isDateValue(value)) {
    return { kind: "date", year: value.year, month: value.month, day: value.day };
  }
  if (isDatetime(value)) {
    return { kind: "datetime", ms: `bigint:${value.ms.toString()}` };
  }
  if (Array.isArray(value)) return value.map(canon);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canon(record[key]);
    return out;
  }
  return `${typeof value}:${String(value)}`;
}

/** Captures a call's values and owned failures canonically. */
function outcomeOfFn(fn: () => unknown): unknown {
  try {
    return { ok: true, value: canon(fn()) };
  } catch (error) {
    if (error instanceof SchemaError) {
      return {
        ok: false,
        violations: JSON.parse(JSON.stringify(error.violations)) as unknown,
      };
    }
    if (error instanceof ValueError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return { ok: false, native: `${String((error as Error)?.constructor?.name)}: ${String((error as Error)?.message)}` };
  }
}

/** Runs one backend call, capturing values and owned failures canonically. */
function outcomeOf(backend: ExactBackend, op: string, args: unknown[]): unknown {
  const fresh = args.map((arg) => structuredClonePreserving(arg));
  return outcomeOfFn(() => backend.call(op, fresh));
}

/**
 * Fresh argument values per backend call. Class instances clone through
 * their (already-validated) constructors; every plain structural probe
 * clones field-wise without re-validation, so malformed-shape probes reach
 * each backend exactly as authored.
 */
function structuredClonePreserving(value: unknown): unknown {
  if (typeof value === "bigint") return BigInt(value.toString());
  if (value instanceof Decimal) return new Decimal(value.coef, value.scale);
  if (Array.isArray(value)) return value.map(structuredClonePreserving);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = structuredClonePreserving(item);
    return out;
  }
  return value;
}

interface CorpusCase {
  id: string;
  op: string;
  args: CaseArg[];
}

function loadCorpus(): CorpusCase[] {
  // Compiled hosts run beside dist/test/, so the corpus resolves through
  // the package root, exactly like the staged binding bytes do.
  return JSON.parse(
    readFileSync(
      join(here, "..", "..", "conformance", "ports", "exact", "cases.json"),
      "utf8",
    ),
  ) as CorpusCase[];
}

describe("whole selected-operation differential over the actual binding", () => {
  const ts = tsBackend();
  const native = wasm();

  it("answers every corpus case identically on both backends", () => {
    const cases = loadCorpus();
    assert.ok(cases.length > 200, `corpus too small: ${cases.length}`);
    const ops = new Set(cases.map((item) => item.op));
    assert.ok(ops.size > 60, `registry too narrow: ${ops.size} ops`);
    let values = 0;
    let failures = 0;
    for (const item of cases) {
      const args = item.args.map(toJS);
      let expected: unknown;
      let actual: unknown;
      if ((item.op === "decode-value" || item.op === "encode-value") && args[0] === "int") {
        // The owning selected-int profile entries (TS-side admission,
        // then the genuine native producer when installed) are the real
        // consumer path for int scalar codecs; the raw pipe would bypass
        // the accepted TECH-V04 admission bound.
        expected = outcomeOfFn(() =>
          item.op === "decode-value"
            ? decodeSelectedInt(args[1])
            : encodeSelectedInt(args[1]),
        );
        selectSelectedIntBackend(native);
        try {
          actual = outcomeOfFn(() =>
            item.op === "decode-value"
              ? decodeSelectedInt(args[1])
              : encodeSelectedInt(args[1]),
          );
        } finally {
          selectSelectedIntBackend(null);
        }
      } else {
        expected = outcomeOf(ts, item.op, args);
        actual = outcomeOf(native, item.op, args);
      }
      assert.deepEqual(actual, expected, `${item.id} op=${item.op}`);
      if ((expected as { ok: boolean }).ok) values += 1;
      else failures += 1;
    }
    assert.ok(values > 100, `no successful values observed: ${values}`);
    assert.ok(failures > 20, `no failure parity observed: ${failures}`);
  });

  it("covers every native dispatch op at least once", () => {
    const cases = loadCorpus();
    const seen = new Set(cases.map((item) => item.op));
    const required = [
      "int64", "add-int", "subtract-int", "multiply-int", "mod-int", "negate-int",
      "abs-int", "compare-int", "round-rational", "add-decimal", "subtract-decimal",
      "multiply-decimal", "divide-decimal", "divide-duration-ms", "negate-decimal",
      "abs-decimal", "round-decimal", "compare-decimal", "equal-decimal", "parse-decimal",
      "decimal-from-integer", "decimal-to-string", "currency-scale", "is-known-currency",
      "money", "make-money", "add-money", "subtract-money", "multiply-money",
      "divide-money", "money-ratio", "compare-money", "equal-money", "negate-money",
      "abs-money", "date-to-epoch-days", "epoch-days-to-date", "parse-date",
      "parse-datetime", "make-date", "make-datetime", "add-days", "add-months",
      "date-year", "weekday", "dates", "overlaps", "add-duration", "subtract-duration",
      "multiply-duration", "divide-duration-by-int", "remainder-duration",
      "compare-duration", "negate-duration", "abs-duration", "duration-between",
      "compare-instant", "compare-date", "sum-int", "sum-decimal", "sum-duration",
      "sum-money", "decode-value", "encode-value", "is-decimal", "is-money",
      "is-date", "is-datetime", "is-currency-shape",
    ];
    for (const op of required) {
      assert.ok(seen.has(op), `corpus never exercises dispatched op: ${op}`);
    }
    assert.deepEqual(exactOpNames(), [...required].sort());
  });
});

describe("exact binding edge corpus (wide, -0, UTF16, diagnostics)", () => {
  const ts = tsBackend();
  const native = wasm();

  function agree(op: string, args: unknown[]): void {
    assert.deepEqual(outcomeOf(native, op, args), outcomeOf(ts, op, args), `op=${op}`);
  }

  it("preserves arbitrary raw BigInt inputs with op-specific bounds", () => {
    const wide = 10n ** 1000n;
    agree("add-int", [0n, 0n]);
    agree("add-int", [9223372036854775807n, 1n]);
    agree("multiply-int", [wide, 0n]);
    agree("compare-int", [wide, -(10n ** 999n)]);
    agree("mod-int", [-9223372036854775808n, -1n]);
    agree("int64", [wide]);
    agree("sum-int", [[wide, -wide, 5n]]);
    agree("sum-int", [[9223372036854775807n, 1n]]);
  });

  it("preserves Decimal scale -0 across retaining operations", () => {
    agree("negate-decimal", [new Decimal(1n, -0)]);
    agree("abs-decimal", [new Decimal(-3n, -0)]);
    agree("add-decimal", [new Decimal(1n, -0), new Decimal(2n, -0)]);
    agree("add-decimal", [new Decimal(1n, -0), new Decimal(2n, 0)]);
    agree("multiply-decimal", [new Decimal(3n, -0), new Decimal(4n, -0)]);
    agree("round-decimal", [new Decimal(123n, 2), -0]);
    agree("sum-decimal", [[new Decimal(5n, -0)]]);
    agree("decimal-to-string", [new Decimal(5n, -0)]);
  });

  it("keeps lone-surrogate and astral diagnostics lossless", () => {
    const lone = "\ud800";
    const trail = "\udc00";
    const astral = "\ud835\udd1e";
    const literalReplacement = "\ufffdA";
    agree("parse-decimal", [lone]);
    agree("parse-decimal", [trail]);
    agree("parse-decimal", [astral]);
    agree("parse-decimal", [`12${lone}3`]);
    agree("currency-scale", [lone]);
    agree("currency-scale", [astral]);
    agree("make-money", [5n, lone]);
    agree("money", [5n, lone]);
    agree("parse-date", [lone]);
    agree("parse-datetime", [lone]);
    agree("parse-datetime", ["2024-02-29T00:00:00.000+00:00"]);
    agree("decode-value", ["int", lone]);
    agree("decode-value", ["int", astral]);
    agree("decode-value", ["decimal", lone]);
    agree("decode-value", ["money", { minor: lone, currency: "USD" }]);
    agree("decode-value", ["money", { minor: "1", currency: lone }]);
    agree("decode-value", ["money", { minor: "1", currency: astral }]);
    agree("decode-value", ["int", literalReplacement]);
    agree("decode-value", ["money", { minor: "1", currency: literalReplacement }]);
    // Money unknown keys keep unit-exact identity: one lone key, two
    // distinct lone keys, and a lone key beside a literal U+FFFD key each
    // report their own path, message and actual on both backends.
    agree("decode-value", ["money", { minor: "1", currency: "USD", [lone]: "x" }]);
    agree("decode-value", ["money", { minor: "1", currency: "USD", [lone]: "x", [trail]: "y" }]);
    agree("decode-value", [
      "money",
      { minor: "1", currency: "USD", [lone]: "x", [literalReplacement]: "y" },
    ]);
    agree("encode-value", ["int", 42n]);
    agree("is-known-currency", [lone]);
    agree("is-currency-shape", [lone]);
  });

  it("renders dynamic number diagnostics exactly", () => {
    agree("make-date", [-0, 1, 1]);
    agree("make-date", [NaN, 1, 1]);
    agree("make-date", [2024, 2, 29]);
    agree("round-decimal", [new Decimal(1n, 0), -0]);
    agree("round-decimal", [new Decimal(1n, 0), 19]);
    agree("round-decimal", [new Decimal(1n, 0), NaN]);
    agree("int64", [10n ** 100n]);
    agree("decode-value", ["int", "8.01033661867104e+241"]);
    agree("make-datetime", [10n ** 30n]);
  });

  it("holds final-only sum bounds and empty-domain rules", () => {
    agree("sum-decimal", [[]]);
    agree("sum-int", [[]]);
    agree("sum-duration", [[]]);
    agree("sum-money", [[], "USD"]);
    agree("sum-money", [[]]);
    agree("sum-money", [[makeMoney(1n, "USD"), makeMoney(2n, "EUR")]]);
    agree("sum-money", [[makeMoney(1n, "USD")], "EUR"]);
    agree("sum-decimal", [[new Decimal(BigInt("9".repeat(38)), 0), new Decimal(1n, 0)]]);
  });
});

describe("carrier, error, evaluation and identity controls", () => {
  const native = wasm();

  it("reconstructs carriers with public provenance, frozen", () => {
    const sum = native.call("add-decimal", [new Decimal(15n, 1), 2n]);
    assert.ok(sum instanceof Decimal);
    assert.equal((sum as Decimal).coef, 35n);
    assert.equal((sum as Decimal).scale, 1);
    assert.ok(Object.isFrozen(sum));
    const money = native.call("add-money", [makeMoney(100n, "USD"), makeMoney(25n, "USD")]);
    assert.ok(isMoney(money));
    assert.ok(Object.isFrozen(money));
    const day = native.call("parse-date", ["2024-02-29"]);
    assert.ok(isDateValue(day));
    assert.ok(Object.isFrozen(day));
    const instant = native.call("make-datetime", [1709164800000n]);
    assert.ok(isDatetime(instant));
    assert.equal((instant as unknown as { ms: bigint }).ms, 1709164800000n);
    const text = native.call("decimal-to-string", [new Decimal(1999n, 2)]);
    assert.equal(text, "19.99");
  });

  it("keeps min/max winning-object identity over native comparisons", () => {
    const low = new Decimal(199n, 2);
    const high = new Decimal(205n, 2);
    assert.equal(native.call("compare-decimal", [low, high]), -1);
    assert.equal(native.call("compare-decimal", [high, low]), 1);
    assert.equal(min([high, low]), low);
    assert.equal(max([low, high]), high);
    const first = makeMoney(1n, "USD");
    const second = makeMoney(2n, "USD");
    assert.equal(native.call("compare-money", [first, second]), -1);
    assert.equal(max([first, second]), second);
  });

  it("propagates exotic guard failures identically without crossing", () => {
    const ts = tsBackend();
    let reads = 0;
    const poisoned = {
      get kind(): string {
        reads += 1;
        throw new Error("carrier read exploded");
      },
    };
    for (const backend of [ts, native]) {
      reads = 0;
      assert.throws(() => backend.call("negate-decimal", [poisoned]), (error: unknown) => {
        assert.ok(!(error instanceof ValueError));
        assert.equal((error as Error).message, "carrier read exploded");
        return true;
      });
      assert.equal(reads, 1);
    }
  });

  it("refuses unknown and inherited ops before reading arguments", () => {
    const ts = tsBackend();
    for (const backend of [ts, native]) {
      for (const op of ["toString", "constructor", "__proto__", "nope"]) {
        let reads = 0;
        const args: unknown[] = [];
        Object.defineProperty(args, 0, {
          get() {
            reads += 1;
            throw new Error("unknown operation read an argument");
          },
        });
        assert.throws(() => backend.call(op, args), ValueError);
        assert.equal(reads, 0, op);
      }
    }
  });

  it("surfaces each native failure exactly once with no retry", () => {
    let calls = 0;
    const counting = wasmBackend({
      abi_version: () => 1,
      exact_call: (request: string) => {
        calls += 1;
        assert.ok(request.includes("divide-decimal"));
        return JSON.stringify({ ok: false, code: "division-by-zero", message: "decimal division by zero" });
      },
    });
    assert.throws(() => counting.call("divide-decimal", [1n, 0n]), (error: unknown) => {
      assert.ok(error instanceof ValueError);
      assert.equal((error as ValueError).code, "division-by-zero");
      return true;
    });
    assert.equal(calls, 1);
  });

  it("tags every registry value without loss", () => {
    assert.deepEqual(tag(-0), { t: "num", v: -0 });
    assert.ok(Object.is((tag(-0) as { v: number }).v, -0));
    assert.deepEqual(tag(NaN), { t: "num", v: "NaN" });
  });
});

describe("supported generated-helper chain through the binding", () => {
  // Every helper below is one the JS codegen actually emits
  // (`parseDecimal`, `multiplyMoney`, `int64`, `encodeValue`,
  // `compareInstant`, `compareDate`, `negateMoney`, `negateDecimal`,
  // `multiplyDuration`, `money`, `equalMoney`); the chain exercises them
  // in codegen order through the genuine binding.
  const native = wasm();

  it("prices, scales and compares through native ops only", () => {
    const unit = native.call("parse-decimal", ["19.99"]);
    assert.ok(unit instanceof Decimal);
    const line = native.call("money", [1000n, "USD"]);
    assert.ok(isMoney(line));
    // money(1000n, USD) holds minor 100000 ($1,000.00 at scale 2); times
    // 19.99 the exact minor product rounds once to 1999000.
    const total = native.call("multiply-money", [line, unit]);
    assert.deepEqual(total, { kind: "money", minor: 1999000n, currency: "USD" });
    const ratio = native.call("money-ratio", [total, line]);
    assert.ok(ratio instanceof Decimal);
    assert.equal(native.call("decimal-to-string", [ratio]), "19.99");
    assert.equal(native.call("int64", [3n]), 3n);
    assert.deepEqual(
      native.call("encode-value", ["money", total]),
      { minor: "1999000", currency: "USD" },
    );
    assert.deepEqual(native.call("negate-money", [line]), { kind: "money", minor: -100000n, currency: "USD" });
    assert.equal(
      native.call("compare-date", [
        native.call("parse-date", ["2024-01-01"]),
        native.call("parse-date", ["2024-02-29"]),
      ]),
      -1,
    );
    assert.equal(
      native.call("compare-instant", [
        native.call("parse-datetime", ["2024-01-01T00:00:00.000Z"]),
        native.call("parse-datetime", ["2024-02-29T00:00:00.000Z"]),
      ]),
      -1,
    );
    assert.equal(native.call("multiply-duration", [60000n, 2n]), 120000n);
    assert.deepEqual(
      native.call("negate-decimal", [native.call("parse-decimal", ["1.5"])]),
      new Decimal(-15n, 1),
    );
  });
});

describe("wasm failure messages without argument-graph rescans", () => {
  const native = wasm();

  it("re-renders from only the matching template argument, in demand order", () => {
    let currencyReads = 0;
    const args: unknown[] = [5n];
    Object.defineProperty(args, 1, {
      get() {
        currencyReads += 1;
        return String.fromCharCode(0xd800);
      },
      enumerable: true,
      configurable: true,
    });
    // VALUES-012 A: admission demands the currency before any tagging,
    // so it reads the slot exactly once and throws the canonical
    // unknown-currency without tagging or message re-render. A
    // whole-graph eager scan would read it again.
    assert.throws(() => native.call("money", args), (error: unknown) => {
      assert.ok(error instanceof ValueError);
      assert.equal((error as ValueError).code, "unknown-currency");
      assert.equal((error as ValueError).message, `unknown currency: ${String.fromCharCode(0xd800)}`);
      return true;
    });
    assert.equal(currencyReads, 1);
  });

  it("never lets an unrelated throwing getter mask a native failure", () => {
    let reads = 0;
    const carrier: Record<string, unknown> = {};
    // Lone-surrogate key: losslessly tagged as k16, lossy in the guard.
    Object.defineProperty(carrier, String.fromCharCode(0xd800), {
      get() {
        reads += 1;
        if (reads > 1) throw new Error("second read exploded");
        return "USD";
      },
      enumerable: true,
      configurable: true,
    });
    // VALUES-012 A: admission refuses the non-string before any tagging,
    // so the throwing getter is never read (0 reads). No native call, no
    // message rescan, no masking.
    assert.throws(() => native.call("currency-scale", [carrier]), (error: unknown) => {
      assert.ok(error instanceof ValueError);
      assert.equal((error as ValueError).code, "invalid-construction");
      return true;
    });
    assert.equal(reads, 0);
  });
});

describe("selected exact backend routing through real consumers", () => {
  const native = wasm();

  function countingOver(backend: ExactBackend): {
    calls: Array<{ op: string; arity: number }>;
    backend: ExactBackend;
  } {
    const calls: Array<{ op: string; arity: number }> = [];
    return {
      calls,
      backend: {
        name: backend.name,
        call(op: string, args: unknown[]): unknown {
          calls.push({ op, arity: args.length });
          return backend.call(op, args);
        },
      },
    };
  }

  function probeBattery(): unknown {
    const m1 = makeMoney(100n, "USD");
    const m2 = makeMoney(25n, "USD");
    const d1 = decodeValue("date", "2024-01-01");
    const d2 = decodeValue("date", "2024-02-29");
    return {
      publicDecodeMoney: decodeValue("money", { minor: "1", currency: "USD" }),
      publicDecodeDecimal: decodeValue("decimal", "1.5"),
      publicDecodeInt: decodeValue("int", "42"),
      publicEncodeMoney: encodeValue("money", m1),
      publicEncodeInt: encodeValue("int", 42n),
      numericMoney: money(1000n, "USD"),
      numericAddMoney: addMoney(m1, m2),
      numericParse: parseDecimal("19.99"),
      numericAddInt: addInt(1n, 2n),
      numericCompareDate: compareDate(d1 as never, d2 as never),
      numericSumMoney: sumMoney([m1], "USD"),
      stdlibSumInt: sum([1n, 2n], "int"),
      stdlibSumMoney: sum([m1, m2], "money", "USD"),
      stdlibAbsInt: abs(-5n),
      stdlibAbsMoney: abs(m1),
      generatedMultiply: multiplyMoney(m1, parseDecimal("2")),
    };
  }

  it("keeps the TypeScript default with no backend installed", () => {
    assert.equal(selectedExactBackendRead(), null);
    assert.deepEqual(money(1000n, "USD"), { kind: "money", minor: 100000n, currency: "USD" });
  });

  it("serves public, numeric, stdlib and generated routes through one genuine backend", () => {
    const expected = probeBattery();
    const seen = countingOver(native);
    selectExactBackend(seen.backend);
    let actual: unknown;
    try {
      actual = probeBattery();
    } finally {
      selectExactBackend(null);
    }
    assert.deepEqual(actual, expected);
    for (const op of [
      "decode-value",
      "encode-value",
      "money",
      "add-money",
      "parse-decimal",
      "add-int",
      "compare-date",
      "sum-money",
      "sum-int",
      "abs-int",
      "abs-money",
      "multiply-money",
    ]) {
      assert.ok(seen.calls.some((call) => call.op === op), `no genuine backend call for ${op}`);
    }
    // Synchronicity is by construction (`routeExact` returns `T`, never a
    // promise); reaching here with deep-equal values proves the sync path.
    assert.equal(typeof actual, "object");
  });

  it("propagates backend failures once with no TypeScript retry", () => {
    let calls = 0;
    selectExactBackend({
      name: "wasm",
      call(): unknown {
        calls += 1;
        throw new ValueError("overflow", "boom");
      },
    });
    try {
      assert.throws(() => addInt(1n, 2n), (error: unknown) => {
        assert.ok(error instanceof ValueError);
        assert.equal((error as ValueError).message, "boom");
        return true;
      });
      assert.equal(calls, 1);
      assert.throws(() => decodeValue("decimal", "1.5"), /boom/);
      assert.equal(calls, 2);
      assert.throws(() => sum([1n], "int"), /boom/);
      assert.equal(calls, 3);
    } finally {
      selectExactBackend(null);
    }
  });

  it("runs the canonical TypeScript path without recursion when selected", () => {
    const expected = probeBattery();
    selectExactBackend(tsBackend());
    let actual: unknown;
    try {
      actual = probeBattery();
    } finally {
      selectExactBackend(null);
    }
    assert.deepEqual(actual, expected);
  });
});

describe("wire facade admission before payload eval", () => {
  const native = wasm();

  it("keeps non-string and bogus type ids on the original contract", () => {
    const expectedNonString = outcomeOfFn(() => decodeValue(123 as unknown as string, "1"));
    const expectedBogus = outcomeOfFn(() => decodeValue("bogus!!", "1"));
    const expectedEncodeBogus = outcomeOfFn(() => encodeValue("bogus!!", 1n));
    selectExactBackend(native);
    try {
      assert.deepEqual(outcomeOfFn(() => decodeValue(123 as unknown as string, "1")), expectedNonString);
      assert.deepEqual(outcomeOfFn(() => decodeValue("bogus!!", "1")), expectedBogus);
      assert.deepEqual(outcomeOfFn(() => encodeValue("bogus!!", 1n)), expectedEncodeBogus);
    } finally {
      selectExactBackend(null);
    }
  });

  it("keeps unadmitted facade ops on TypeScript dispatch with identical results", () => {
    const m = money(100n, "USD");
    const expectedText = decodeValue("text", "hi");
    const expectedArray = decodeValue("int[]", ["1", "2"]);
    const expectedAssisted = encodeValue("money", m, () => undefined);
    const ops: string[] = [];
    selectExactBackend({
      name: "wasm",
      call(op: string, args: unknown[]): unknown {
        ops.push(op);
        return native.call(op, args);
      },
    });
    try {
      assert.deepEqual(decodeValue("text", "hi"), expectedText);
      assert.deepEqual(decodeValue("int[]", ["1", "2"]), expectedArray);
      assert.deepEqual(encodeValue("money", m, () => undefined), expectedAssisted);
      // The facade never dispatches decode-value/encode-value itself for
      // these; inner numeric primitives may still serve natively with
      // identical results through the general selection.
      assert.ok(!ops.includes("decode-value") && !ops.includes("encode-value"));
    } finally {
      selectExactBackend(null);
    }
  });

  it("refuses bad type ids before touching the payload", () => {
    const poisoned = new Proxy({}, { get() { throw new Error("payload evaluated"); } });
    selectExactBackend(native);
    try {
      assert.throws(() => decodeValue(123 as unknown as string, poisoned), (error: unknown) => {
        assert.ok(error instanceof ValueError);
        assert.equal((error as ValueError).message, "type id must be a string");
        return true;
      });
      assert.throws(() => decodeValue("bogus!!", poisoned), (error: unknown) => {
        assert.ok(error instanceof ValueError);
        assert.notEqual((error as ValueError).message, "payload evaluated");
        return true;
      });
    } finally {
      selectExactBackend(null);
    }
  });
});
