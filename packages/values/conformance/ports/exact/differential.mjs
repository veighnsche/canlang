/**
 * Native differential: current TypeScript vs the Rust semantics core.
 *
 * Runs the hand-authored `cases.json` corpus plus a seeded fuzz corpus
 * through both implementations and requires zero unexplained differences
 * in values, stored parts, error codes/messages, and violation metadata.
 *
 * Prerequisites: `bun run --cwd packages/values build` and a built runner:
 * `cargo build --locked --manifest-path packages/values/semantics/Cargo.toml
 * --example conformance` (heavy: run under a capacity grant).
 *
 * Usage: node packages/values/conformance/ports/exact/differential.mjs
 *   [--runner <path>] [--fuzz N] [--cases-only] [--fuzz-only] [--ts-smoke]
 *
 * `--ts-smoke` runs the TypeScript side of every case (plus a fuzz sample)
 * without the native runner, failing on native (non-ValueError/SchemaError)
 * throws: the parity domain must never depend on engine-native errors.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "..", "..");
const dist = join(pkg, "dist", "src");

const intOps = await import(join(dist, "int.js"));
const decimalOps = await import(join(dist, "decimal.js"));
const moneyOps = await import(join(dist, "money.js"));
const kindsOps = await import(join(dist, "kinds.js"));
const temporalOps = await import(join(dist, "temporal.js"));
const arrayOps = await import(join(dist, "array.js"));
const wireOps = await import(join(dist, "wire.js"));
const currencyData = await import(join(dist, "currency-data.js"));
const { ValueError } = await import(join(dist, "errors.js"));
const { SchemaError } = await import(join(dist, "errors.js"));

// ---------------------------------------------------------------------------
// Tagged conversion (shared with the transport envelope).
// ---------------------------------------------------------------------------

function toJS(tagged) {
  switch (tagged.t) {
    case "bigint":
      return BigInt(tagged.v);
    case "num":
      return typeof tagged.v === "string" ? Number(tagged.v) : tagged.v;
    case "str":
      return tagged.v;
    case "bool":
      return tagged.v;
    case "null":
      return null;
    case "undef":
      return undefined;
    case "decimal":
      // Plain structural object: the ported guards observe shape only, so
      // this is observationally identical to a `new Decimal` instance, and
      // malformed shapes stay expressible (a real constructor would throw
      // before the op runs).
      return { kind: "decimal", coef: BigInt(tagged.coef), scale: tagged.scale };
    case "money":
      return { kind: "money", minor: BigInt(tagged.minor), currency: tagged.currency };
    case "date":
      return { kind: "date", year: tagged.year, month: tagged.month, day: tagged.day };
    case "datetime":
      return { kind: "datetime", ms: BigInt(tagged.ms) };
    case "array":
      return tagged.items.map(toJS);
    case "record": {
      const out = {};
      for (const [key, value] of tagged.entries) out[key] = toJS(value);
      return out;
    }
    case "other":
      if (tagged.tag === "symbol") return Symbol("probe");
      if (tagged.tag === "function") return () => {};
      throw new Error(`unknown other tag: ${tagged.tag}`);
    default:
      throw new Error(`unknown tag: ${tagged.t}`);
  }
}

function toTagged(value) {
  if (typeof value === "bigint") return { t: "bigint", v: value.toString() };
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { t: "num", v: "NaN" };
    if (value === Infinity) return { t: "num", v: "Infinity" };
    if (value === -Infinity) return { t: "num", v: "-Infinity" };
    return { t: "num", v: value };
  }
  if (typeof value === "string") return { t: "str", v: value };
  if (typeof value === "boolean") return { t: "bool", v: value };
  if (value === null) return { t: "null" };
  if (value === undefined) return { t: "undef" };
  if (typeof value === "symbol") return { t: "other", tag: "symbol" };
  if (typeof value === "function") return { t: "other", tag: "function" };
  if (Array.isArray(value)) return { t: "array", items: value.map(toTagged) };
  const kind = value.kind;
  if (kind === "decimal") return { t: "decimal", coef: value.coef.toString(), scale: value.scale };
  if (kind === "money") return { t: "money", minor: value.minor.toString(), currency: value.currency };
  if (kind === "date") return { t: "date", year: value.year, month: value.month, day: value.day };
  if (kind === "datetime") return { t: "datetime", ms: value.ms.toString() };
  // Wire objects ({minor, currency}) and any other plain records.
  return { t: "record", entries: Object.entries(value).map(([k, v]) => [k, toTagged(v)]) };
}

function canon(value) {
  return JSON.stringify(value, (key, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const sorted = {};
      for (const k of Object.keys(v).sort()) sorted[k] = v[k];
      return sorted;
    }
    return v;
  });
}

// ---------------------------------------------------------------------------
// TypeScript dispatch table.
// ---------------------------------------------------------------------------

const TS_OPS = {
  "int64": (a) => intOps.int64(a),
  "add-int": (a, b) => intOps.addInt(a, b),
  "subtract-int": (a, b) => intOps.subtractInt(a, b),
  "multiply-int": (a, b) => intOps.multiplyInt(a, b),
  "mod-int": (a, b) => intOps.modInt(a, b),
  "negate-int": (a) => intOps.negateInt(a),
  "abs-int": (a) => intOps.absInt(a),
  "compare-int": (a, b) => intOps.compareInt(a, b),
  "round-rational": (a, b) => decimalOps.roundRationalHalfEven(a, b),
  "add-decimal": (a, b) => decimalOps.addDecimal(a, b),
  "subtract-decimal": (a, b) => decimalOps.subtractDecimal(a, b),
  "multiply-decimal": (a, b) => decimalOps.multiplyDecimal(a, b),
  "divide-decimal": (a, b) => decimalOps.divideDecimal(a, b),
  "divide-duration-ms": (a, b) => decimalOps.divideDurationMs(a, b),
  "negate-decimal": (a) => decimalOps.negateDecimal(a),
  "abs-decimal": (a) => decimalOps.absDecimal(a),
  "round-decimal": (a, b) => decimalOps.round(a, b),
  "compare-decimal": (a, b) => decimalOps.compareDecimal(a, b),
  "equal-decimal": (a, b) => decimalOps.equalDecimal(a, b),
  "parse-decimal": (a) => decimalOps.parseDecimal(a),
  "decimal-from-integer": (a) => decimalOps.decimalFromInteger(a),
  "decimal-to-string": (a) => decimalOps.decimalToString(a),
  "currency-scale": (a) => moneyOps.currencyScale(a),
  "is-known-currency": (a) => moneyOps.isKnownCurrency(a),
  "money": (a, b) => moneyOps.money(a, b),
  "make-money": (a, b) => kindsOps.makeMoney(a, b),
  "add-money": (a, b) => moneyOps.addMoney(a, b),
  "subtract-money": (a, b) => moneyOps.subtractMoney(a, b),
  "multiply-money": (a, b) => moneyOps.multiplyMoney(a, b),
  "divide-money": (a, b) => moneyOps.divideMoney(a, b),
  "money-ratio": (a, b) => moneyOps.moneyRatio(a, b),
  "compare-money": (a, b) => moneyOps.compareMoney(a, b),
  "equal-money": (a, b) => moneyOps.equalMoney(a, b),
  "negate-money": (a) => moneyOps.negateMoney(a),
  "abs-money": (a) => moneyOps.absMoney(a),
  "date-to-epoch-days": (a) => temporalOps.dateToEpochDays(a),
  "epoch-days-to-date": (a) => temporalOps.epochDaysToDate(a),
  "parse-date": (a) => temporalOps.date(a),
  "parse-datetime": (a) => temporalOps.datetime(a),
  "make-date": (a, b, c) => kindsOps.makeDate(a, b, c),
  "make-datetime": (a) => kindsOps.makeDatetime(a),
  "add-days": (a, b) => temporalOps.add_days(a, b),
  "add-months": (a, b) => temporalOps.add_months(a, b),
  "date-year": (a) => temporalOps.date_year(a),
  "weekday": (a) => temporalOps.weekday(a),
  "dates": (a, b, c) => temporalOps.dates(a, b, c),
  "overlaps": (a, b, c, d) => temporalOps.overlaps(a, b, c, d),
  "add-duration": (a, b) => temporalOps.addDuration(a, b),
  "subtract-duration": (a, b) => temporalOps.subtractDuration(a, b),
  "multiply-duration": (a, b) => temporalOps.multiplyDuration(a, b),
  "divide-duration-by-int": (a, b) => temporalOps.divideDurationByInt(a, b),
  "remainder-duration": (a, b) => temporalOps.remainderDuration(a, b),
  "compare-duration": (a, b) => temporalOps.compareDuration(a, b),
  "negate-duration": (a) => temporalOps.negateDuration(a),
  "abs-duration": (a) => temporalOps.absDuration(a),
  "duration-between": (a, b) => temporalOps.durationBetween(a, b),
  "compare-instant": (a, b) => temporalOps.compareInstant(a, b),
  "compare-date": (a, b) => temporalOps.compareDate(a, b),
  "sum-int": (a) => arrayOps.sumInt(a),
  "sum-decimal": (a) => arrayOps.sumDecimal(a),
  "sum-duration": (a) => arrayOps.sumDuration(a),
  "sum-money": (a, b) => (b === undefined ? arrayOps.sumMoney(a) : arrayOps.sumMoney(a, b)),
  "decode-value": (a, b) => wireOps.decodeValue(a, b),
  "encode-value": (a, b) => wireOps.encodeValue(a, b),
  "is-decimal": (a) => decimalOps.isDecimal(a),
  "is-money": (a) => kindsOps.isMoney(a),
  "is-date": (a) => kindsOps.isDateValue(a),
  "is-datetime": (a) => kindsOps.isDatetime(a),
  "is-currency-shape": (a) => kindsOps.isCurrencyShape(a),
};

function runTS(op, args) {
  const fn = TS_OPS[op];
  if (!fn) throw new Error(`no TS op: ${op}`);
  const jsArgs = args.map(toJS);
  try {
    return { ok: true, value: toTagged(fn(...jsArgs)) };
  } catch (err) {
    if (err instanceof ValueError) {
      return { ok: false, code: err.code, message: err.message };
    }
    if (err instanceof SchemaError) {
      return {
        ok: false,
        violations: err.violations.map((v) => ({ ...v })),
        message: err.message,
      };
    }
    return { ok: false, native: `${err?.constructor?.name ?? "?"}: ${err?.message ?? String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Native runner client (one persistent process, NDJSON over stdio).
// ---------------------------------------------------------------------------

function startRunner(path) {
  const child = spawn(path, [], { stdio: ["pipe", "pipe", "inherit"] });
  child.on("error", (err) => {
    console.error(`runner failed to start at ${path}: ${err.message}`);
    console.error("Build it first: cargo build --locked --manifest-path packages/values/semantics/Cargo.toml --example conformance");
    process.exit(2);
  });
  let buffer = "";
  const pending = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const next = pending.shift();
      if (next) next(line);
      index = buffer.indexOf("\n");
    }
  });
  return {
    child,
    call(request) {
      return new Promise((resolve) => {
        pending.push((line) => resolve(JSON.parse(line)));
        child.stdin.write(`${JSON.stringify(request)}\n`);
      });
    },
    stop() {
      child.stdin.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Comparison.
// ---------------------------------------------------------------------------

function normalizeRS(response) {
  if (response.transport) return { transport: response.transport };
  if (response.ok) return { ok: true, value: response.value };
  if (response.violations) {
    return {
      ok: false,
      violations: response.violations,
      message: `schema validation failed with ${response.violations.length} violation(s)`,
    };
  }
  return { ok: false, code: response.code, message: response.message };
}

function compare(id, op, args, ts, rs) {
  const left = canon(ts);
  const right = canon(normalizeRS(rs));
  if (left === right) return null;
  return { id, op, args, ts, rs: normalizeRS(rs) };
}

// ---------------------------------------------------------------------------
// Seeded fuzz.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const EDGE_BIGINTS = [
  "0", "1", "-1", "2", "-2", "7", "-7", "100", "-100",
  "9223372036854775807", "-9223372036854775808",
  "9223372036854775808", "-9223372036854775809",
  "18446744073709551615", "-18446744073709551616",
  `1${"0".repeat(38)}`, `-${"1"}${"0".repeat(38)}`,
  "9".repeat(38), "9".repeat(39), `1${"0".repeat(100)}`,
];
const EDGE_SCALES = [0, 1, 2, 3, 9, 17, 18, 19, -1, 0.5, NaN];
const CURRENCIES = ["USD", "EUR", "JPY", "BHD", "CLF", "GBP", "XXX", "ZZZ", "AAA", "eur", "EURO", "", "US"];

function randBig(rand, wide = true) {
  const roll = rand();
  if (roll < 0.45) return { t: "bigint", v: EDGE_BIGINTS[Math.floor(rand() * EDGE_BIGINTS.length)] };
  if (roll < 0.7 || !wide) {
    const hi = BigInt(Math.floor(rand() * 4294967296));
    const lo = BigInt(Math.floor(rand() * 4294967296));
    const unsigned = hi * 4294967296n + lo;
    const v = unsigned >= 2n ** 63n ? unsigned - 2n ** 64n : unsigned;
    return { t: "bigint", v: v.toString() };
  }
  const digits = 1 + Math.floor(rand() * 120);
  let v = "";
  for (let i = 0; i < digits; i++) v += Math.floor(rand() * 10).toString();
  v = v.replace(/^0+(?=\d)/, "") || "0";
  return { t: "bigint", v: (rand() < 0.5 ? "-" : "") + v };
}

function randDecimal(rand) {
  const roll = rand();
  if (roll < 0.15) {
    // Malformed shapes: wrong coef kind, bad scale, missing kind.
    const pick = rand();
    if (pick < 0.3) return { t: "record", entries: [["kind", { t: "str", v: "decimal" }], ["coef", { t: "num", v: 5 }], ["scale", { t: "num", v: 0 }]] };
    if (pick < 0.5) return { t: "decimal", coef: "5", scale: 19 };
    if (pick < 0.7) return { t: "decimal", coef: "9".repeat(39), scale: 0 };
    return { t: "record", entries: [["coef", { t: "bigint", v: "5" }], ["scale", { t: "num", v: 0 }]] };
  }
  const digits = 1 + Math.floor(rand() * 38);
  let coef = "";
  for (let i = 0; i < digits; i++) coef += Math.floor(rand() * 10).toString();
  coef = coef.replace(/^0+(?=\d)/, "") || "0";
  if (rand() < 0.4) coef = `-${coef}`;
  const scale = [0, 0, 1, 2, 3, 9, 17, 18][Math.floor(rand() * 8)];
  return { t: "decimal", coef, scale };
}

function randMoney(rand) {
  const roll = rand();
  if (roll < 0.12) {
    const pick = rand();
    if (pick < 0.4) return { t: "record", entries: [["kind", { t: "str", v: "money" }], ["minor", { t: "num", v: 5 }], ["currency", { t: "str", v: "USD" }]] };
    if (pick < 0.7) return { t: "money", minor: "5", currency: "usd" };
    return { t: "record", entries: [["kind", { t: "str", v: "money" }], ["minor", { t: "bigint", v: "5" }]] };
  }
  return { t: "money", minor: randBig(rand).v, currency: CURRENCIES[Math.floor(rand() * 6)] };
}

function randDate(rand) {
  if (rand() < 0.15) {
    const pick = rand();
    if (pick < 0.3) return { t: "date", year: 2024, month: 2, day: 30 };
    if (pick < 0.5) return { t: "date", year: 0, month: 1, day: 1 };
    if (pick < 0.7) return { t: "date", year: 2024.5, month: 1, day: 1 };
    return { t: "record", entries: [["kind", { t: "str", v: "date" }], ["year", { t: "num", v: 2024 }]] };
  }
  const year = 1 + Math.floor(rand() * 9999);
  const month = 1 + Math.floor(rand() * 12);
  const day = 1 + Math.floor(rand() * 28);
  return { t: "date", year, month, day };
}

function randDatetime(rand) {
  if (rand() < 0.15) {
    const pick = rand();
    if (pick < 0.4) return { t: "datetime", ms: "253402300800000" };
    if (pick < 0.7) return { t: "datetime", ms: `1${"0".repeat(30)}` };
    return { t: "record", entries: [["kind", { t: "str", v: "datetime" }], ["ms", { t: "num", v: 5 }]] };
  }
  const lo = -62135596800000n;
  const hi = 253402300799999n;
  const span = hi - lo;
  const pick = lo + ((BigInt(Math.floor(rand() * 4294967296)) * BigInt(Math.floor(rand() * 4294967296))) % span);
  return { t: "datetime", ms: pick.toString() };
}

function randScalar(rand) {
  const roll = rand();
  if (roll < 0.3) return randBig(rand);
  if (roll < 0.45) return { t: "num", v: Math.floor(rand() * 41) - 20 };
  if (roll < 0.55) return { t: "str", v: ["", "x", "5", "USD"][Math.floor(rand() * 4)] };
  if (roll < 0.62) return { t: "bool", v: rand() < 0.5 };
  if (roll < 0.66) return { t: "null" };
  if (roll < 0.7) return { t: "undef" };
  if (roll < 0.8) return randDecimal(rand);
  if (roll < 0.88) return randMoney(rand);
  if (roll < 0.94) return randDate(rand);
  return randDatetime(rand);
}

function randWire(rand) {
  const roll = rand();
  if (roll < 0.3) return { t: "str", v: randWireText(rand) };
  if (roll < 0.4) return randBig(rand);
  if (roll < 0.48) return { t: "num", v: Math.floor(rand() * 21) - 10 };
  if (roll < 0.54) return { t: "bool", v: rand() < 0.5 };
  if (roll < 0.58) return { t: "null" };
  if (roll < 0.62) return { t: "undef" };
  if (roll < 0.72) return { t: "array", items: [randScalar(rand), randScalar(rand)] };
  return {
    t: "record",
    entries: [
      ["minor", { t: "str", v: randWireText(rand) }],
      ["currency", { t: "str", v: CURRENCIES[Math.floor(rand() * CURRENCIES.length)] }],
      ...(rand() < 0.3 ? [["extra", { t: "num", v: 1 }]] : []),
    ],
  };
}

function randDatetimeText(rand) {
  const pool = [
    "1970-01-01T00:00:00.000Z", "1970-01-01t01:00:00z", "2024-02-29T12:34:56.789Z",
    "1970-01-01T01:00:00+01:00", "1970-01-01T00:00:00-05:30", "0001-01-01T00:00:00Z",
    "9999-12-31T23:59:59.999Z", "1970-01-01T00:00:00.5Z", "1970-01-01T00:00:00.000000Z",
    "1970-01-01T00:00:00.000001Z", "2016-12-31T23:59:60Z", "1970-01-01T00:00:00+24:00",
    "1970-01-01T00:00:00+00:60", "1970-01-01T00:00:00", "1970-01-01 00:00:00Z",
    "0000-01-01T00:00:00Z", "2024-02-30T00:00:00Z", "2024-01-01T24:00:00Z",
    "2024-01-01T00:00:00.Z", "2024-01-01T00:00:00.+00:00", "not-a-datetime", "",
  ];
  return pool[Math.floor(rand() * pool.length)];
}

function randDateText(rand) {
  const pool = ["2024-02-29", "2023-02-29", "0000-01-01", "0001-01-01", "9999-12-31",
    "2024-13-01", "2024-00-10", "24-01-01", "2024-1-1", "", "2024-01-01T00:00:00Z", "abcd-ef-gh"];
  return pool[Math.floor(rand() * pool.length)];
}

function randWireText(rand) {
  const pool = ["0", "5", "-3", "007", "-0", "1.5", "-0.005", "2024-02-29", "2024-13-01",
    "1970-01-01T00:00:00.000Z", "1970-01-01t00:00:00z", "1e3", "+1", "1.", "", " 5", "9".repeat(40)];
  return pool[Math.floor(rand() * pool.length)];
}

const FUZZ_OPS = [
  ["int64", 1, (r) => [r() < 0.7 ? randBig(r) : randScalar(r)]],
  ["add-int", 2, (r) => [randBig(r), randBig(r)]],
  ["subtract-int", 2, (r) => [randBig(r), randBig(r)]],
  ["multiply-int", 2, (r) => [randBig(r), randBig(r)]],
  ["mod-int", 2, (r) => [randBig(r), r() < 0.2 ? { t: "bigint", v: "0" } : randBig(r)]],
  ["negate-int", 1, (r) => [randBig(r)]],
  ["abs-int", 1, (r) => [r() < 0.8 ? randBig(r) : { t: "num", v: Math.floor(r() * 21) - 10 }]],
  ["compare-int", 2, (r) => [randBig(r), randBig(r)]],
  ["round-rational", 2, (r) => [randBig(r, false), r() < 0.15 ? { t: "bigint", v: "0" } : randBig(r, false)]],
  ["add-decimal", 2, (r) => [r() < 0.7 ? randDecimal(r) : randBig(r), r() < 0.7 ? randDecimal(r) : randBig(r)]],
  ["subtract-decimal", 2, (r) => [r() < 0.7 ? randDecimal(r) : randBig(r), r() < 0.7 ? randDecimal(r) : randBig(r)]],
  ["multiply-decimal", 2, (r) => [r() < 0.7 ? randDecimal(r) : randBig(r), r() < 0.7 ? randDecimal(r) : randBig(r)]],
  ["divide-decimal", 2, (r) => {
    if (r() < 0.2) return [randMoney(r), randMoney(r)];
    const a = r() < 0.7 ? randDecimal(r) : randBig(r);
    const b = r() < 0.1 ? { t: "bigint", v: "0" } : r() < 0.7 ? randDecimal(r) : randBig(r);
    return [a, b];
  }],
  ["divide-duration-ms", 2, (r) => [randBig(r), randBig(r)]],
  ["negate-decimal", 1, (r) => [r() < 0.8 ? randDecimal(r) : randScalar(r)]],
  ["abs-decimal", 1, (r) => [r() < 0.8 ? randDecimal(r) : randScalar(r)]],
  ["round-decimal", 2, (r) => [
    r() < 0.7 ? randDecimal(r) : randBig(r),
    // NaN must travel as the "NaN" string: JSON.stringify(NaN) is null.
    { t: "num", v: ((s) => (Number.isNaN(s) ? "NaN" : s))(EDGE_SCALES[Math.floor(r() * EDGE_SCALES.length)]) },
  ]],
  ["compare-decimal", 2, (r) => [r() < 0.7 ? randDecimal(r) : randBig(r), r() < 0.7 ? randDecimal(r) : randBig(r)]],
  ["equal-decimal", 2, (r) => [r() < 0.7 ? randDecimal(r) : randBig(r), r() < 0.7 ? randDecimal(r) : randBig(r)]],
  ["parse-decimal", 1, (r) => [r() < 0.8 ? { t: "str", v: randWireText(r) } : randScalar(r)]],
  ["decimal-from-integer", 1, (r) => [r() < 0.8 ? randBig(r) : randScalar(r)]],
  ["decimal-to-string", 1, (r) => [r() < 0.8 ? randDecimal(r) : randScalar(r)]],
  ["currency-scale", 1, (r) => [r() < 0.8 ? { t: "str", v: CURRENCIES[Math.floor(r() * CURRENCIES.length)] } : randScalar(r)]],
  ["is-known-currency", 1, (r) => [randScalar(r)]],
  ["money", 2, (r) => [
    r() < 0.5 ? randBig(r) : randDecimal(r),
    { t: "str", v: CURRENCIES[Math.floor(r() * CURRENCIES.length)] },
  ]],
  ["make-money", 2, (r) => [randBig(r), { t: "str", v: CURRENCIES[Math.floor(r() * CURRENCIES.length)] }]],
  ["add-money", 2, (r) => [randMoney(r), randMoney(r)]],
  ["subtract-money", 2, (r) => [randMoney(r), randMoney(r)]],
  ["multiply-money", 2, (r) => [randMoney(r), r() < 0.5 ? randBig(r) : randDecimal(r)]],
  ["divide-money", 2, (r) => [randMoney(r), r() < 0.15 ? { t: "bigint", v: "0" } : (r() < 0.5 ? randBig(r) : randDecimal(r))]],
  ["money-ratio", 2, (r) => [randMoney(r), randMoney(r)]],
  ["compare-money", 2, (r) => [randMoney(r), randMoney(r)]],
  ["equal-money", 2, (r) => [randMoney(r), randMoney(r)]],
  ["negate-money", 1, (r) => [randMoney(r)]],
  ["abs-money", 1, (r) => [randMoney(r)]],
  ["date-to-epoch-days", 1, (r) => [randDate(r)]],
  ["epoch-days-to-date", 1, (r) => {
    if (r() < 0.7) return [{ t: "num", v: Math.floor(r() * 6000000) - 3000000 }];
    if (r() < 0.5) {
      const edges = [4000000, -4000000, 4000001, -4000001, 1e21, -1e21, 2 ** 53];
      return [{ t: "num", v: edges[Math.floor(r() * edges.length)] }];
    }
    return [randScalar(r)];
  }],
  ["parse-date", 1, (r) => [r() < 0.85 ? { t: "str", v: randDateText(r) } : randScalar(r)]],
  ["parse-datetime", 1, (r) => [r() < 0.85 ? { t: "str", v: randDatetimeText(r) } : randScalar(r)]],
  ["make-date", 3, (r) => [
    { t: "num", v: Math.floor(r() * 10200) - 100 },
    { t: "num", v: Math.floor(r() * 15) - 1 },
    { t: "num", v: Math.floor(r() * 34) - 1 },
  ]],
  ["make-datetime", 1, (r) => [r() < 0.8 ? randBig(r) : randScalar(r)]],
  ["add-days", 2, (r) => [randDate(r), randBig(r)]],
  ["add-months", 2, (r) => [randDate(r), randBig(r)]],
  ["date-year", 1, (r) => [randDate(r)]],
  ["weekday", 1, (r) => [randDate(r)]],
  ["dates", 3, (r) => [randDate(r), randDate(r), r() < 0.7 ? { t: "bigint", v: String(Math.floor(r() * 40)) } : randBig(r)]],
  ["overlaps", 4, (r) => (r() < 0.5 ? [randDate(r), randDate(r), randDate(r), randDate(r)] : [randDatetime(r), randDatetime(r), randDatetime(r), randDatetime(r)])],
  ["add-duration", 2, (r) => {
    const pick = r();
    if (pick < 0.5) return [randBig(r), randBig(r)];
    if (pick < 0.75) return [randBig(r), randDatetime(r)];
    return [randDatetime(r), randBig(r)];
  }],
  ["subtract-duration", 2, (r) => (r() < 0.6 ? [randBig(r), randBig(r)] : [randDatetime(r), randBig(r)])],
  ["multiply-duration", 2, (r) => [randBig(r), randBig(r)]],
  ["divide-duration-by-int", 2, (r) => [randBig(r), r() < 0.15 ? { t: "bigint", v: "0" } : randBig(r)]],
  ["remainder-duration", 2, (r) => [randBig(r), r() < 0.15 ? { t: "bigint", v: "0" } : randBig(r)]],
  ["compare-duration", 2, (r) => [randBig(r), randBig(r)]],
  ["negate-duration", 1, (r) => [randBig(r)]],
  ["abs-duration", 1, (r) => [randBig(r)]],
  ["duration-between", 2, (r) => [randDatetime(r), randDatetime(r)]],
  ["compare-instant", 2, (r) => [randDatetime(r), randDatetime(r)]],
  ["compare-date", 2, (r) => [randDate(r), randDate(r)]],
  ["sum-int", 1, (r) => [{ t: "array", items: Array.from({ length: Math.floor(r() * 6) }, () => (r() < 0.9 ? randBig(r) : randScalar(r))) }]],
  ["sum-decimal", 1, (r) => [{ t: "array", items: Array.from({ length: Math.floor(r() * 6) }, () => (r() < 0.9 ? randDecimal(r) : randScalar(r))) }]],
  ["sum-duration", 1, (r) => [{ t: "array", items: Array.from({ length: Math.floor(r() * 6) }, () => (r() < 0.9 ? randBig(r) : randScalar(r))) }]],
  ["sum-money", 2, (r) => [
    { t: "array", items: Array.from({ length: Math.floor(r() * 5) }, () => randMoney(r)) },
    ...(r() < 0.5 ? [{ t: "str", v: CURRENCIES[Math.floor(r() * CURRENCIES.length)] }] : []),
  ]],
  ["decode-value", 2, (r) => [
    { t: "str", v: ["int", "decimal", "money", "date", "datetime", "duration"][Math.floor(r() * 6)] },
    randWire(r),
  ]],
  ["encode-value", 2, (r) => {
    const names = ["int", "decimal", "money", "date", "datetime", "duration"];
    const name = names[Math.floor(r() * names.length)];
    const pools = { int: () => randBig(r), decimal: () => randDecimal(r), money: () => randMoney(r), date: () => randDate(r), datetime: () => randDatetime(r), duration: () => randBig(r) };
    return [{ t: "str", v: name }, r() < 0.85 ? pools[name]() : randScalar(r)];
  }],
  ["is-decimal", 1, (r) => [randScalar(r)]],
  ["is-money", 1, (r) => [randScalar(r)]],
  ["is-date", 1, (r) => [randScalar(r)]],
  ["is-datetime", 1, (r) => [randScalar(r)]],
  ["is-currency-shape", 1, (r) => [r() < 0.8 ? { t: "str", v: CURRENCIES[Math.floor(r() * CURRENCIES.length)] } : randScalar(r)]],
];

function fuzzCases(seed, count) {
  const rand = mulberry32(seed);
  const cases = [];
  for (let i = 0; i < count; i++) {
    const [op, , gen] = FUZZ_OPS[Math.floor(rand() * FUZZ_OPS.length)];
    cases.push({ id: `fuzz-${seed}-${i}`, op, args: gen(rand) });
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Currency drift check (A03.4).
// ---------------------------------------------------------------------------

function checkCurrencyDrift() {
  const manifest = JSON.parse(readFileSync(join(pkg, "semantics", "currency-facts.json"), "utf8"));
  const live = currencyData.CURRENCY_MINOR_UNITS;
  const problems = [];
  const liveKeys = Object.keys(live).sort();
  const genKeys = Object.keys(manifest.currencies).sort();
  if (canon(liveKeys) !== canon(genKeys)) problems.push(`admitted set drift: live ${liveKeys.length}, generated ${genKeys.length}`);
  for (const code of liveKeys) {
    if (live[code] !== manifest.currencies[code]) problems.push(`scale drift for ${code}: live ${live[code]}, generated ${manifest.currencies[code]}`);
  }
  for (const code of manifest.excluded) {
    if (live[code] !== undefined) problems.push(`excluded code ${code} now admitted live`);
    if (manifest.currencies[code] !== undefined) problems.push(`excluded code ${code} present in generated facts`);
  }
  const counts = {};
  for (const code of liveKeys) counts[live[code]] = (counts[live[code]] ?? 0) + 1;
  if (liveKeys.length !== 165) problems.push(`expected 165 admitted currencies, found ${liveKeys.length}`);
  return problems;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const runnerIndex = argv.indexOf("--runner");
const fuzzIndex = argv.indexOf("--fuzz");
const runnerPath = runnerIndex === -1 ? join(pkg, "target", "debug", "examples", "conformance") : argv[runnerIndex + 1];
const fuzzCount = fuzzIndex === -1 ? 3000 : Number(argv[fuzzIndex + 1]);
const casesOnly = argv.includes("--cases-only");
const fuzzOnly = argv.includes("--fuzz-only");
const tsSmoke = argv.includes("--ts-smoke");

const drift = checkCurrencyDrift();
if (drift.length > 0) {
  console.error("currency drift detected:");
  for (const problem of drift) console.error(`  - ${problem}`);
  process.exit(2);
}

let cases = [];
if (!fuzzOnly) {
  cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
}
if (!casesOnly) {
  cases = cases.concat(fuzzCases(20261006, fuzzCount));
}

if (tsSmoke) {
  let native = 0;
  for (const { id, op, args } of cases) {
    const ts = runTS(op, args);
    if (!ts.ok && ts.native) {
      native++;
      if (native <= 20) {
        console.error(`NATIVE-THROW ${id} op=${op}: ${ts.native}`);
        console.error(`  args: ${canon(args)}`);
      }
    }
  }
  console.log(`ts-smoke: ${cases.length - native}/${cases.length} clean, ${native} native throws`);
  process.exit(native > 0 ? 1 : 0);
}

const runner = startRunner(runnerPath);
await new Promise((resolve) => setTimeout(resolve, 300));
if (runner.child.exitCode !== null) {
  console.error(`runner failed to start at ${runnerPath} (exit ${runner.child.exitCode}).`);
  console.error("Build it first: cargo build --locked --manifest-path packages/values/semantics/Cargo.toml --example conformance");
  process.exit(2);
}

let pass = 0;
const failures = [];
for (const { id, op, args } of cases) {
  const ts = runTS(op, args);
  const rs = await runner.call({ v: 1, op, args });
  if (rs.transport) {
    console.error(`transport error on ${id} (${op}): ${rs.transport}`);
    console.error(`  args: ${canon(args)}`);
    process.exit(2);
  }
  const mismatch = compare(id, op, args, ts, rs);
  if (mismatch) {
    failures.push(mismatch);
    if (failures.length <= 20) {
      console.error(`MISMATCH ${id} op=${op}`);
      console.error(`  args: ${canon(args)}`);
      console.error(`  ts:   ${canon(ts)}`);
      console.error(`  rs:   ${canon(normalizeRS(rs))}`);
    }
  } else {
    pass++;
  }
}
runner.stop();

console.log(`differential: ${pass}/${cases.length} match, ${failures.length} mismatch, currency drift: none`);
process.exit(failures.length > 0 ? 1 : 0);
