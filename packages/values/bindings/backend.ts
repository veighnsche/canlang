// Private backend registry: explicit ts/wasm-required selection.
//
// Both backends expose the same synchronous op call over native Can
// values. The ts backend dispatches straight to the TS package (usable
// with no bootstrap); the wasm backend round-trips through the generated
// glue. Can failures surface as ValueError with the original code and
// message on both sides. This is the A07.3 final exact assembly: every
// selected integer, decimal, money, temporal, numeric aggregate/
// comparison and scalar-codec operation the native transport dispatches.
// `min`/`max` stay out by design (TS orchestration returning the original
// winning object; their numeric comparisons are the registered
// `compare-*` ops). Nonnumeric equality, traversal and schema policy stay
// TS-owned with the validation lane.
import type {
  CanValue,
  DatetimeValue,
  DateValue,
  MoneyValue,
  Violation,
  ViolationCode,
} from "@canlang/contracts/values";
import { sumDecimal, sumDuration, sumInt, sumMoney } from "../src/array.js";
import {
  absDecimal,
  addDecimal,
  compareDecimal,
  decimalFromInteger,
  decimalToString,
  divideDecimal,
  divideDurationMs,
  equalDecimal,
  isDecimal,
  multiplyDecimal,
  negateDecimal,
  parseDecimal,
  round,
  roundRationalHalfEven,
  subtractDecimal,
  type Decimal,
} from "../src/decimal.js";
import { SchemaError, ValueError, type ValueFailureCode } from "../src/errors.js";
import {
  absInt,
  addInt,
  compareInt,
  int64,
  INT64_MAX,
  INT64_MIN,
  modInt,
  multiplyInt,
  negateInt,
  subtractInt,
} from "../src/int.js";
import {
  isCurrencyShape,
  isDateValue,
  isDatetime,
  isMoney,
  makeDate,
  makeDatetime,
  makeMoney,
} from "../src/kinds.js";
import {
  absMoney,
  addMoney,
  compareMoney,
  currencyScale,
  divideMoney,
  equalMoney,
  isKnownCurrency,
  money,
  moneyRatio,
  multiplyMoney,
  negateMoney,
  subtractMoney,
} from "../src/money.js";
import {
  absDuration,
  add_days,
  add_months,
  addDuration,
  compareDate,
  compareDuration,
  compareInstant,
  date,
  date_year,
  dates,
  datetime,
  divideDurationByInt,
  durationBetween,
  epochDaysToDate,
  dateToEpochDays,
  multiplyDuration,
  negateDuration,
  overlaps,
  remainderDuration,
  subtractDuration,
  weekday,
} from "../src/temporal.js";
import { decodeValueTsCore, encodeValueTsCore } from "../src/internal/wire-core.js";
import {
  readSelectedExact,
  withCanonicalDispatch,
  writeSelectedExact,
} from "./exact-route.js";
import {
  reconstruct,
  tag,
  type Tagged,
} from "./carriers.js";

export type BackendName = "ts" | "wasm";

/** Transport ABI version the host side requires from the glue. */
export const REQUIRED_ABI_VERSION = 1;

export interface ExactBackend {
  readonly name: BackendName;
  /** Synchronous op call over native Can values; throws ValueError. */
  call(op: string, args: unknown[]): unknown;
}

type ExactFn = (...args: never[]) => unknown;

const asFn = (fn: (a: unknown, b: unknown) => unknown): ExactFn => fn as ExactFn;

/** Full selected-operation table: one entry per native dispatch op. */
const TS_OPS: Record<string, ExactFn> = {
  "int64": ((a: unknown) => int64(a as bigint)) as ExactFn,
  "add-int": ((a: unknown, b: unknown) => addInt(a as bigint, b as bigint)) as ExactFn,
  "subtract-int": ((a: unknown, b: unknown) =>
    subtractInt(a as bigint, b as bigint)) as ExactFn,
  "multiply-int": ((a: unknown, b: unknown) =>
    multiplyInt(a as bigint, b as bigint)) as ExactFn,
  "mod-int": ((a: unknown, b: unknown) => modInt(a as bigint, b as bigint)) as ExactFn,
  "negate-int": ((a: unknown) => negateInt(a as bigint)) as ExactFn,
  "abs-int": ((a: unknown) => absInt(a as bigint)) as ExactFn,
  "compare-int": ((a: unknown, b: unknown) => compareInt(a as bigint, b as bigint)) as ExactFn,
  "round-rational": ((a: unknown, b: unknown) =>
    roundRationalHalfEven(a as bigint, b as bigint)) as ExactFn,
  "add-decimal": ((a: unknown, b: unknown) =>
    addDecimal(a as Decimal | bigint, b as Decimal | bigint)) as ExactFn,
  "subtract-decimal": ((a: unknown, b: unknown) =>
    subtractDecimal(a as Decimal | bigint, b as Decimal | bigint)) as ExactFn,
  "multiply-decimal": ((a: unknown, b: unknown) =>
    multiplyDecimal(a as Decimal | bigint, b as Decimal | bigint)) as ExactFn,
  "divide-decimal": ((a: unknown, b: unknown) =>
    divideDecimal(a as Decimal | bigint | MoneyValue, b as Decimal | bigint | MoneyValue)) as ExactFn,
  "divide-duration-ms": ((a: unknown, b: unknown) =>
    divideDurationMs(a as bigint, b as bigint)) as ExactFn,
  "negate-decimal": ((a: unknown) => negateDecimal(a as Decimal)) as ExactFn,
  "abs-decimal": ((a: unknown) => absDecimal(a as Decimal)) as ExactFn,
  "round-decimal": ((a: unknown, b: unknown) =>
    round(a as Decimal | bigint, b as number)) as ExactFn,
  "compare-decimal": ((a: unknown, b: unknown) =>
    compareDecimal(a as Decimal | bigint, b as Decimal | bigint)) as ExactFn,
  "equal-decimal": ((a: unknown, b: unknown) =>
    equalDecimal(a as Decimal | bigint, b as Decimal | bigint)) as ExactFn,
  "parse-decimal": ((a: unknown) => parseDecimal(a as string)) as ExactFn,
  "decimal-from-integer": ((a: unknown) => decimalFromInteger(a as bigint)) as ExactFn,
  "decimal-to-string": ((a: unknown) => decimalToString(a as Decimal)) as ExactFn,
  "currency-scale": ((a: unknown) => currencyScale(a as string)) as ExactFn,
  "is-known-currency": ((a: unknown) => isKnownCurrency(a)) as ExactFn,
  "money": ((a: unknown, b: unknown) => money(a as bigint | Decimal, b as string)) as ExactFn,
  "make-money": ((a: unknown, b: unknown) => makeMoney(a as bigint, b as string)) as ExactFn,
  "add-money": ((a: unknown, b: unknown) =>
    addMoney(a as MoneyValue, b as MoneyValue)) as ExactFn,
  "subtract-money": ((a: unknown, b: unknown) =>
    subtractMoney(a as MoneyValue, b as MoneyValue)) as ExactFn,
  "multiply-money": ((a: unknown, b: unknown) =>
    multiplyMoney(a as MoneyValue, b as Decimal | bigint)) as ExactFn,
  "divide-money": ((a: unknown, b: unknown) =>
    divideMoney(a as MoneyValue, b as Decimal | bigint)) as ExactFn,
  "money-ratio": ((a: unknown, b: unknown) =>
    moneyRatio(a as MoneyValue, b as MoneyValue)) as ExactFn,
  "compare-money": ((a: unknown, b: unknown) =>
    compareMoney(a as MoneyValue, b as MoneyValue)) as ExactFn,
  "equal-money": ((a: unknown, b: unknown) =>
    equalMoney(a as MoneyValue, b as MoneyValue)) as ExactFn,
  "negate-money": ((a: unknown) => negateMoney(a as MoneyValue)) as ExactFn,
  "abs-money": ((a: unknown) => absMoney(a as MoneyValue)) as ExactFn,
  "date-to-epoch-days": ((a: unknown) => dateToEpochDays(a as DateValue)) as ExactFn,
  "epoch-days-to-date": ((a: unknown) => epochDaysToDate(a as number)) as ExactFn,
  "parse-date": ((a: unknown) => date(a as string)) as ExactFn,
  "parse-datetime": ((a: unknown) => datetime(a as string)) as ExactFn,
  "make-date": ((a: unknown, b: unknown, c: unknown) =>
    makeDate(a as number, b as number, c as number)) as ExactFn,
  "make-datetime": ((a: unknown) => makeDatetime(a as bigint)) as ExactFn,
  "add-days": ((a: unknown, b: unknown) => add_days(a as DateValue, b as bigint)) as ExactFn,
  "add-months": ((a: unknown, b: unknown) => add_months(a as DateValue, b as bigint)) as ExactFn,
  "date-year": ((a: unknown) => date_year(a as DateValue)) as ExactFn,
  "weekday": ((a: unknown) => weekday(a as DateValue)) as ExactFn,
  "dates": ((a: unknown, b: unknown, c: unknown) =>
    dates(a as DateValue, b as DateValue, c as bigint)) as ExactFn,
  "overlaps": ((a: unknown, b: unknown, c: unknown, d: unknown) =>
    (overlaps as (...args: unknown[]) => unknown)(a, b, c, d)) as ExactFn,
  "add-duration": asFn((a: unknown, b: unknown) =>
    (addDuration as (a: unknown, b: unknown) => unknown)(a, b)),
  "subtract-duration": asFn((a: unknown, b: unknown) =>
    (subtractDuration as (a: unknown, b: unknown) => unknown)(a, b)),
  "multiply-duration": ((a: unknown, b: unknown) =>
    multiplyDuration(a as bigint, b as bigint)) as ExactFn,
  "divide-duration-by-int": ((a: unknown, b: unknown) =>
    divideDurationByInt(a as bigint, b as bigint)) as ExactFn,
  "remainder-duration": ((a: unknown, b: unknown) =>
    remainderDuration(a as bigint, b as bigint)) as ExactFn,
  "compare-duration": ((a: unknown, b: unknown) =>
    compareDuration(a as bigint, b as bigint)) as ExactFn,
  "negate-duration": ((a: unknown) => negateDuration(a as bigint)) as ExactFn,
  "abs-duration": ((a: unknown) => absDuration(a as bigint)) as ExactFn,
  "duration-between": ((a: unknown, b: unknown) =>
    durationBetween(a as DatetimeValue, b as DatetimeValue)) as ExactFn,
  "compare-instant": ((a: unknown, b: unknown) =>
    compareInstant(a as DatetimeValue, b as DatetimeValue)) as ExactFn,
  "compare-date": ((a: unknown, b: unknown) =>
    compareDate(a as DateValue, b as DateValue)) as ExactFn,
  "sum-int": ((a: unknown) => sumInt(a as ReadonlyArray<bigint>)) as ExactFn,
  "sum-decimal": ((a: unknown) => sumDecimal(a as ReadonlyArray<Decimal>)) as ExactFn,
  "sum-duration": ((a: unknown) => sumDuration(a as ReadonlyArray<bigint>)) as ExactFn,
  "sum-money": ((a: unknown, b: unknown) =>
    sumMoney(a as ReadonlyArray<MoneyValue>, b as string | undefined)) as ExactFn,
  "decode-value": ((a: unknown, b: unknown) => decodeValueTsCore(a as string, b)) as ExactFn,
  "encode-value": ((a: unknown, b: unknown) =>
    encodeValueTsCore(a as string, b as CanValue)) as ExactFn,
  "is-decimal": ((a: unknown) => isDecimal(a)) as ExactFn,
  "is-money": ((a: unknown) => isMoney(a)) as ExactFn,
  "is-date": ((a: unknown) => isDateValue(a)) as ExactFn,
  "is-datetime": ((a: unknown) => isDatetime(a)) as ExactFn,
  "is-currency-shape": ((a: unknown) => isCurrencyShape(a as string)) as ExactFn,
};

/** Selected operation names the registry answers (native dispatch scope). */
export function exactOpNames(): string[] {
  return Object.keys(TS_OPS).sort();
}

/**
 * True exactly for registry operations. Reads no arguments: both backends
 * refuse unknown (including inherited) operation names before touching
 * caller values.
 */
export function hasExactOp(op: string): boolean {
  return Object.hasOwn(TS_OPS, op);
}

/**
 * VALUES-012 A admission before tagging: mirrors the canonical guard
 * read order for the poison-trigger shapes only. Bigint guards check
 * `typeof` (no value-internal reads); string/currency guards check the
 * slot before any graph scan; `money` demands the currency (arg 1)
 * before the value (arg 0) exactly like `money()` scales the currency
 * first, so an unknown currency wins without touching a poison value;
 * `decode-value` for `decimal` defers to the owning core (which reads
 * no value internals for a non-string wire) to raise the owning
 * SchemaError. Every other op falls through to tagging: their guards
 * either read value internals identically on both backends (1 read) or
 * have no poison trigger. Arbitrary-JS shells (`is-*`) stay untouched.
 */
function admitBeforeTag(op: string, args: unknown[]): void {
  switch (op) {
    case "int64": {
      if (typeof args[0] !== "bigint") {
        throw new ValueError("invalid-construction", "int64 must be a bigint");
      }
      return;
    }
    case "add-int": {
      if (typeof args[0] !== "bigint") {
        throw new ValueError("invalid-construction", "addInt must be a bigint");
      }
      if (args.length > 1 && typeof args[1] !== "bigint") {
        throw new ValueError("invalid-construction", "addInt must be a bigint");
      }
      return;
    }
    case "subtract-int": {
      if (typeof args[0] !== "bigint") {
        throw new ValueError("invalid-construction", "subtractInt must be a bigint");
      }
      if (args.length > 1 && typeof args[1] !== "bigint") {
        throw new ValueError("invalid-construction", "subtractInt must be a bigint");
      }
      return;
    }
    case "multiply-int": {
      if (typeof args[0] !== "bigint") {
        throw new ValueError("invalid-construction", "multiplyInt must be a bigint");
      }
      if (args.length > 1 && typeof args[1] !== "bigint") {
        throw new ValueError("invalid-construction", "multiplyInt must be a bigint");
      }
      return;
    }
    case "mod-int": {
      if (typeof args[0] !== "bigint") {
        throw new ValueError("invalid-construction", "modInt must be a bigint");
      }
      if (args.length > 1 && typeof args[1] !== "bigint") {
        throw new ValueError("invalid-construction", "modInt must be a bigint");
      }
      return;
    }
    case "negate-int": {
      if (typeof args[0] !== "bigint") {
        throw new ValueError("invalid-construction", "negateInt must be a bigint");
      }
      return;
    }
    case "abs-int": {
      if (typeof args[0] !== "bigint") {
        throw new ValueError("invalid-construction", "absInt must be a bigint");
      }
      return;
    }
    case "compare-int": {
      if (typeof args[0] !== "bigint") {
        throw new ValueError("invalid-construction", "compareInt must be a bigint");
      }
      if (args.length > 1 && typeof args[1] !== "bigint") {
        throw new ValueError("invalid-construction", "compareInt must be a bigint");
      }
      return;
    }
    case "round-rational": {
      if (typeof args[0] !== "bigint" || (args.length > 1 && typeof args[1] !== "bigint")) {
        throw new ValueError("invalid-construction", "roundRationalHalfEven needs bigint inputs");
      }
      return;
    }
    case "currency-scale": {
      if (typeof args[0] !== "string") {
        throw new ValueError("invalid-construction", "currency must be a string");
      }
      return;
    }
    case "money": {
      const currency = args[1];
      if (typeof currency !== "string") {
        throw new ValueError("invalid-construction", "currency must be a string");
      }
      if (!isKnownCurrency(currency)) {
        throw new ValueError("unknown-currency", `unknown currency: ${currency}`);
      }
      return;
    }
    case "make-money": {
      if (typeof args[0] !== "bigint") {
        throw new ValueError("invalid-construction", "money minor must be a bigint");
      }
      const currency = args[1];
      if (typeof currency !== "string" || !isCurrencyShape(currency)) {
        throw new ValueError("invalid-construction", `invalid currency code shape: ${currency}`);
      }
      if (!isKnownCurrency(currency)) {
        throw new ValueError("unknown-currency", `unknown currency: ${currency}`);
      }
      return;
    }
    case "decode-value": {
      if (args[0] === "decimal" && typeof args[1] !== "string") {
        decodeValueTsCore(args[0] as string, args[1]);
      }
      return;
    }
    default:
      return;
  }
}

/** Direct-TS backend: works with no bootstrap and no built glue. */
export function tsBackend(): ExactBackend {
  return {
    name: "ts",
    call(op: string, args: unknown[]): unknown {
      const fn = hasExactOp(op) ? TS_OPS[op] : undefined;
      if (!fn) {
        throw new ValueError("invalid-construction", `smoke backend has no op: ${op}`);
      }
      // Canonical dispatch: routing public functions re-enter their
      // canonical TypeScript bodies here instead of recursing outward.
      return withCanonicalDispatch(() => (fn as (...a: unknown[]) => unknown)(...args));
    },
  };
}

/** Minimal structural shape of the generated wasm-bindgen glue. */
export interface WasmGlue {
  abi_version(): number;
  exact_call(requestJson: string): string;
}

interface FailureResponse {
  ok: boolean;
  code?: string;
  message?: string;
  violations?: unknown;
  transport?: string;
}

const NATIVE_VIOLATION_CODES: ReadonlySet<string> = new Set([
  "required",
  "type",
  "format",
  "bound",
  "unknown-field",
  "unknown-argument",
  "limit",
]);

function isViolationPath(path: unknown): path is Array<string | number> {
  return (
    Array.isArray(path) &&
    path.every((seg) => typeof seg === "string" || typeof seg === "number")
  );
}

/**
 * Projects one native ordered violation list through the owning
 * SchemaError facade, preserving path/code/message and the present/absent
 * expected/actual fields in wire order. Non-violation payloads are a
 * transport-shape fault, never a semantic decode.
 */
export function nativeViolationsToSchemaError(violations: unknown): SchemaError {
  if (!Array.isArray(violations)) {
    throw new ValueError("invalid-construction", "native violations payload is not an array");
  }
  const out: Violation[] = violations.map((item) => {
    const record = item as { path?: unknown; code?: unknown; message?: unknown; expected?: unknown; actual?: unknown };
    if (
      typeof record !== "object" ||
      record === null ||
      !isViolationPath(record.path) ||
      typeof record.code !== "string" ||
      !NATIVE_VIOLATION_CODES.has(record.code) ||
      typeof record.message !== "string" ||
      (record.expected !== undefined && typeof record.expected !== "string") ||
      (record.actual !== undefined && typeof record.actual !== "string")
    ) {
      throw new ValueError("invalid-construction", "native violation has a malformed shape");
    }
    return {
      path: [...record.path],
      code: record.code as ViolationCode,
      message: record.message,
      ...(record.expected !== undefined ? { expected: record.expected } : null),
      ...(record.actual !== undefined ? { actual: record.actual } : null),
    };
  });
  return new SchemaError(out);
}

function throwFailure(op: string, response: FailureResponse): never {
  if (typeof response.transport === "string") {
    throw new ValueError("invalid-construction", `native transport fault on ${op}: ${response.transport}`);
  }
  if (response.violations !== undefined) {
    throw nativeViolationsToSchemaError(response.violations);
  }
  throw new ValueError(
    (response.code as ValueFailureCode | undefined) ?? "invalid-construction",
    response.message ?? `native failure on ${op}`,
  );
}

/**
 * Serializes a finite JS number for the request envelope, preserving `-0`
 * (`JSON.stringify(-0)` is `"0"`, which would erase the stored Decimal
 * scale sign the native core now preserves; serde parses `-0` back to
 * `-0.0` and `JSON.parse` restores `-0` on the way back).
 */
function stringifyNumber(value: number): string {
  if (Object.is(value, -0)) return "-0";
  return JSON.stringify(value) as string;
}

function stringifyUnits(units: ReadonlyArray<number>): string {
  return `[${units.join(",")}]`;
}

/** Serializes one tagged value, preserving `-0` numbers and `str16`/`k16` text. */
function stringifyTagged(value: Tagged): string {
  switch (value.t) {
    case "bigint":
      return `{"t":"bigint","v":${JSON.stringify(value.v)}}`;
    case "num":
      return typeof value.v === "string"
        ? `{"t":"num","v":${JSON.stringify(value.v)}}`
        : `{"t":"num","v":${stringifyNumber(value.v)}}`;
    case "str":
      return `{"t":"str","v":${JSON.stringify(value.v)}}`;
    case "str16":
      return `{"t":"str16","v":${stringifyUnits(value.v)}}`;
    case "bool":
      return value.v ? `{"t":"bool","v":true}` : `{"t":"bool","v":false}`;
    case "null":
      return `{"t":"null"}`;
    case "undef":
      return `{"t":"undef"}`;
    case "decimal":
      return `{"t":"decimal","coef":${JSON.stringify(value.coef)},"scale":${stringifyNumber(value.scale)}}`;
    case "money":
      return `{"t":"money","minor":${JSON.stringify(value.minor)},"currency":${JSON.stringify(value.currency)}}`;
    case "date":
      return `{"t":"date","year":${stringifyNumber(value.year)},"month":${stringifyNumber(value.month)},"day":${stringifyNumber(value.day)}}`;
    case "datetime":
      return `{"t":"datetime","ms":${JSON.stringify(value.ms)}}`;
    case "array":
      return `{"t":"array","items":[${value.items.map(stringifyTagged).join(",")}]}`;
    case "record": {
      const entries = value.entries.map(([key, item]) => {
        const renderedKey = typeof key === "string"
          ? JSON.stringify(key)
          : `{"k16":${stringifyUnits(key.k16)}}`;
        return `[${renderedKey},${stringifyTagged(item)}]`;
      });
      return `{"t":"record","entries":[${entries.join(",")}]}`;
    }
  }
}

/** Serializes one operation request, preserving `-0` number literals. */
export function stringifyRequest(op: string, args: Tagged[]): string {
  return `{"v":1,"op":${JSON.stringify(op)},"args":[${args.map(stringifyTagged).join(",")}]}`;
}

/**
 * Dynamic message prefixes the host re-renders from the caller's original
 * strings. The native core computes these failures over lossy guard text
 * (lone surrogates arrive as `str16` and decode `from_utf16_lossy`), so its
 * verdict and code are exact but an embedded ill-formed string would carry
 * replacement characters. The templates below are the frozen TypeScript
 * sources; rendering here uses the original argument, never a recompute.
 */
const HOST_RENDERED_PREFIXES: Readonly<Record<string, ReadonlyArray<readonly [prefix: string, arg: number]>>> = {
  "parse-decimal": [["invalid decimal text: ", 0]],
  "currency-scale": [["unknown currency: ", 0]],
  "money": [["unknown currency: ", 1], ["invalid currency code shape: ", 1]],
  "make-money": [["unknown currency: ", 1], ["invalid currency code shape: ", 1]],
  "parse-date": [
    ["invalid date text: ", 0],
    ["date year outside 0001-9999: ", 0],
    ["invalid civil date: ", 0],
  ],
  "parse-datetime": [
    ["invalid datetime text: ", 0],
    ["datetime year outside 0001-9999: ", 0],
    ["invalid calendar date: ", 0],
    ["invalid time of day: ", 0],
    ["invalid zone offset: ", 0],
    ["nonzero sub-millisecond fraction rejected: ", 0],
  ],
  "sum-money": [["unknown currency: ", 1]],
};

/** Re-renders one native failure message from the original string argument. */
function renderHostMessage(op: string, message: string, args: ReadonlyArray<unknown>): string {
  const prefixes = HOST_RENDERED_PREFIXES[op];
  if (prefixes === undefined) return message;
  for (const [prefix, index] of prefixes) {
    // Demand order: the caller's argument is read only when its template
    // matches, exactly once per matching template.
    if (message.startsWith(prefix)) {
      const original = args[index];
      if (typeof original === "string") return `${prefix}${original}`;
    }
  }
  return message;
}

function truncateTs(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Mirrors the native `actualWire` over the caller's original wire value. */
function actualWireTs(wire: unknown): string {
  if (wire === null) return "null";
  switch (typeof wire) {
    case "string":
      return truncateTs(JSON.stringify(wire) as string, 64);
    case "number":
      return `number ${String(wire)}`;
    case "boolean":
      return wire ? "true" : "false";
    case "bigint":
      return `bigint ${wire.toString()}`;
    case "undefined":
      return "undefined";
    default:
      break;
  }
  if (Array.isArray(wire)) return `array of length ${wire.length}`;
  if (typeof wire === "object" && wire !== null) {
    return `object with keys [${Object.keys(wire).slice(0, 5).join(", ")}]`;
  }
  return typeof wire;
}

/** Lossy UTF-16 decode mirroring the native guard text. */
function lossyTs(value: string): string {
  return value.replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    "�",
  );
}

/** True for identical lossy violation paths (segments compared as-is). */
function sameLossyPath(left: unknown, right: ReadonlyArray<string | number>): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return right.every((segment, index) => left[index] === segment);
}

/**
 * Resolves the nth original key (caller enumeration order) whose lossy
 * form equals the native lossy segment. Distinct ill-formed keys decoding
 * to the same guard text resolve per occurrence, so lone-surrogate keys
 * never collide and literal U+FFFD keys keep their own identity. Well-formed
 * segments match only their own key, exactly like a direct lookup.
 */
function resolveLossyKey(
  record: Record<string, unknown>,
  segment: string,
  occurrence: number,
): string | undefined {
  let seen = 0;
  for (const key of Object.keys(record)) {
    if (lossyTs(key) !== segment) continue;
    // Suppressed (undefined-valued) keys are absent like `presentKeys`
    // and the native `check_shape` filter: they never emitted a
    // violation, so occurrence identity skips them in enumeration order.
    if (record[key] === undefined) continue;
    if (seen === occurrence) return key;
    seen += 1;
  }
  return undefined;
}

/** Walks a violation path into the caller's original wire value. */
function lookupPath(
  wire: unknown,
  path: ReadonlyArray<string | number>,
  lastOccurrence = 0,
): unknown {
  let current = wire;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment];
    } else if (typeof current === "object" && current !== null && typeof segment === "string") {
      const record = current as Record<string, unknown>;
      // The native path holds lossy key text; only the final segment
      // varies per occurrence, intermediate segments keep first-match
      // order as before.
      const original = resolveLossyKey(
        record,
        segment,
        index === path.length - 1 ? lastOccurrence : 0,
      );
      if (original === undefined) return undefined;
      current = record[original];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Repairs native violation diagnostics that embed ill-formed text. Only
 * fields holding replacement characters are re-rendered, from the
 * caller's original wire value; every other field keeps native bytes.
 * Paths resolve to the exact original key per occurrence, so distinct
 * lone-surrogate keys (and literal U+FFFD keys beside them) report their
 * own path, message and actual in entry order.
 */
function repairViolations(violations: unknown, wire: unknown): unknown {
  if (!Array.isArray(violations)) return violations;
  return violations.map((item, index) => {
    const record = item as { path?: unknown; message?: unknown; actual?: unknown };
    if (typeof record !== "object" || record === null) return item;
    const { path, message } = record;
    if (!Array.isArray(path) || typeof message !== "string") return item;
    const typedPath = path as Array<string | number>;
    // Occurrence of this exact lossy path among earlier violations:
    // native unknown-key diagnostics preserve entry order, so the nth
    // identical lossy path belongs to the nth matching original key.
    let occurrence = 0;
    for (let prior = 0; prior < index; prior += 1) {
      const priorPath = (violations[prior] as { path?: unknown } | null | undefined)?.path;
      if (sameLossyPath(priorPath, typedPath)) occurrence += 1;
    }
    let nextMessage = message;
    let nextActual = record.actual;
    let nextPath: Array<string | number> | undefined;
    const last = typedPath.at(-1);
    const parent = lookupPath(wire, typedPath.slice(0, -1));
    const original = typeof last === "string" && typeof parent === "object" && parent !== null
      ? resolveLossyKey(parent as Record<string, unknown>, last, occurrence)
      : undefined;
    if (typeof nextActual === "string" && (nextActual.includes("�") || occurrence > 0)) {
      // Repair only from the caller's original wire value; when the path
      // resolves nowhere, the native bytes stand.
      const resolved = lookupPath(wire, typedPath, occurrence);
      if (resolved !== undefined) nextActual = actualWireTs(resolved);
    } else if (typeof nextActual === "string" && nextActual.endsWith("...")) {
      // Surrogate-split truncation parity (VALUES-012 C): only string
      // leaves carry truncated `actual` diagnostics, and the native cut
      // trims a split surrogate pair that the TypeScript slice retains.
      // Recompute from the resolved original string under the same
      // source/UTF-16 contract; JSON.stringify of a primitive string
      // invokes no user code, and the walk follows the violation path
      // only (never a whole-graph scan), so throwing getters keep their
      // original order with zero extra reads. When the recomputation
      // matches, the native bytes stand untouched.
      const resolved = lookupPath(wire, typedPath, occurrence);
      if (typeof resolved === "string") {
        const rendered = actualWireTs(resolved);
        if (rendered !== nextActual) nextActual = rendered;
      }
    }
    if (nextMessage.includes("�") && original !== undefined) {
      const rustTail = JSON.stringify(lossyTs(original));
      if (nextMessage.endsWith(rustTail)) {
        nextMessage = nextMessage.slice(0, nextMessage.length - rustTail.length) +
          (JSON.stringify(original) as string);
      }
    }
    if (original !== undefined && typeof last === "string" && original !== last) {
      nextPath = [...typedPath.slice(0, -1), original];
    }
    if (nextMessage === message && nextActual === record.actual && nextPath === undefined) {
      return item;
    }
    return {
      ...(item as Record<string, unknown>),
      ...(nextPath === undefined ? null : { path: nextPath }),
      message: nextMessage,
      actual: nextActual,
    };
  });
}

/**
 * Wasm backend over caller-supplied glue. The ABI version is checked at
 * construction: a mismatched module fails here, never mid-request. Each
 * call crosses exactly once; a native semantic failure throws once with
 * its original code and message and never retries in TS.
 */
export function wasmBackend(glue: WasmGlue): ExactBackend {
  const abi = glue.abi_version();
  if (abi !== REQUIRED_ABI_VERSION) {
    throw new ValueError(
      "invalid-construction",
      `wasm glue ABI is ${abi}, host requires ${REQUIRED_ABI_VERSION}`,
    );
  }
  return {
    name: "wasm",
    call(op: string, args: unknown[]): unknown {
      // Refuse unknown operations before reading any argument, exactly
      // like the ts backend: inherited names never reach tagging, glue,
      // or the native dispatch.
      if (!hasExactOp(op)) {
        throw new ValueError("invalid-construction", `smoke backend has no op: ${op}`);
      }
      // VALUES-012 A: demand-ordered admission before any tagging. Each
      // check reads its own argument slot once, in the canonical guard
      // order, and throws the canonical error without touching later
      // arguments or scanning value graphs. Success falls through to
      // tagging and the single genuine native call; native semantic
      // failures never retry in TS.
      admitBeforeTag(op, args);
      const tagged = args.map(tag);
      const request = stringifyRequest(op, tagged);
      const raw = glue.exact_call(request);
      const response = JSON.parse(raw) as {
        ok: boolean;
        value?: Tagged;
        code?: string;
        message?: string;
        violations?: unknown;
        transport?: string;
      };
      if (!response.ok) {
        if (response.violations !== undefined && args.length > 1) {
          response.violations = repairViolations(response.violations, args[1]);
        }
        if (typeof response.message === "string" && response.message.includes("�")) {
          // Demand-ordered re-render only: the message itself carries a
          // replacement character, so at most one known primitive template
          // matches. No whole-graph argument rescan runs here, so throwing
          // getters surface in call order, identically on both backends.
          response.message = renderHostMessage(op, response.message, args);
        }
        throwFailure(op, response);
      }
      return reconstruct(response.value as Tagged);
    },
  };
}

/**
 * General exact-backend profile selection. `null` (the default) keeps the
 * full-domain TypeScript route; installing a backend selects the genuine
 * native producer for profile-owned entries. Reads are ordered before any
 * native evaluation: selection never changes guard, freezing, or error
 * ownership, which stay with the TypeScript surface.
 */
export function selectExactBackend(backend: ExactBackend | null): void {
  writeSelectedExact(backend);
}

export function selectedExactBackendRead(): ExactBackend | null {
  return readSelectedExact();
}

/**
 * Selected int/ASCII admission: the released named CSV raw/text bound in
 * bytes. ASCII text is one byte per unit, so length is the byte count.
 */
export const SELECTED_INT_TEXT_MAX_BYTES = 1_048_576;

const SELECTED_INT64_MIN = "-9223372036854775808";
const SELECTED_INT64_MAX = "9223372036854775807";

function isAsciiText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 127) return false;
  }
  return true;
}

/**
 * Escaped UTF-16 unit length of one ASCII code unit under
 * `JSON.stringify`, mirroring its exact escape table (`\"`, `\\`,
 * `\b \t \n \f \r`, `\u00xx` lowercase, everything else raw).
 */
function jsonEscapeLength(code: number): number {
  if (code === 0x22 || code === 0x5c) return 2;
  if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) return 2;
  if (code < 0x20) return 6;
  return 1;
}

function jsonEscapeAscii(code: number): string {
  switch (code) {
    case 0x22: return '\\"';
    case 0x5c: return '\\\\';
    case 0x08: return '\\b';
    case 0x09: return '\\t';
    case 0x0a: return '\\n';
    case 0x0c: return '\\f';
    case 0x0d: return '\\r';
    default:
      if (code < 0x20) return `\\u00${code.toString(16).padStart(2, "0")}`;
      return String.fromCharCode(code);
  }
}

/**
 * `actual` rendering identical to `JSON.stringify(wire)` truncated at 64
 * UTF-16 units plus `...`, computed with bounded work: an O(n) unit
 * scan with O(64) allocation, never a whole-string stringify of an
 * over-budget payload. ASCII-only (the only domain that reaches this
 * pre-entry refusal; every unit is one char).
 */
function boundedStringifiedActual(wire: string): string {
  let total = 2;
  for (let index = 0; index < wire.length; index += 1) {
    total += jsonEscapeLength(wire.charCodeAt(index));
  }
  if (total <= 64) return JSON.stringify(wire);
  let out = '"';
  let units = 1;
  for (let index = 0; index < wire.length && units < 64; index += 1) {
    let esc = jsonEscapeAscii(wire.charCodeAt(index));
    if (units + esc.length > 64) esc = esc.slice(0, 64 - units);
    out += esc;
    units += esc.length;
  }
  return `${out}...`;
}

/**
 * Explicit opt-in selection for the selected int producer. Null (the
 * default) keeps the full-domain TypeScript route; installing a backend
 * selects the genuine native producer for admitted ASCII text only.
 */
let selectedIntBackend: ExactBackend | null = null;

export function selectSelectedIntBackend(backend: ExactBackend | null): void {
  selectedIntBackend = backend;
}

/**
 * Selected int decode at the owning codec entry. Non-ASCII or non-string
 * wire stays on the full-domain TypeScript route before any native
 * evaluation. Admitted ASCII text is byte-checked before tag/JSON
 * allocation; over-bound text refuses as a SchemaError with no accepted
 * value, effect, or retry.
 */
export function decodeSelectedInt(wire: unknown): bigint {
  // The int-specific backend overrides; otherwise the general exact
  // selection serves admitted ASCII text through the same genuine call.
  const backend = selectedIntBackend ?? readSelectedExact();
  if (backend === null || !isAsciiText(wire)) {
    return decodeValueTsCore("int", wire) as bigint;
  }
  if (wire.length > SELECTED_INT_TEXT_MAX_BYTES) {
    throw new SchemaError([{
      path: [],
      code: "bound",
      message: "int is out of range",
      expected: `int in [${SELECTED_INT64_MIN}, ${SELECTED_INT64_MAX}]`,
      actual: boundedStringifiedActual(wire),
    }]);
  }
  return backend.call("decode-value", ["int", wire]) as bigint;
}

/**
 * Selected int encode at the owning codec entry: the normalized decimal
 * string for the actual in-range bigint yielded by selected decode.
 * Non-bigint values stay on the TypeScript route; native failures throw
 * with their original code and message and never retry.
 */
/**
 * Magnitude class bound for the encode diagnostic: values within it
 * render full digits (exact native parity); beyond it the message stays
 * bounded instead of materializing millions of digits.
 */
const ENCODE_DIAGNOSTIC_LIMIT = 10n ** 26n;

export function encodeSelectedInt(value: unknown): string {
  // The int-specific backend overrides; otherwise the general exact
  // selection serves admitted bigints through the same genuine call.
  const backend = selectedIntBackend ?? readSelectedExact();
  if (backend === null || typeof value !== "bigint") {
    return encodeValueTsCore("int", value as CanValue) as string;
  }
  // Signed64 admission before any tag/JSON/native bigint work: bigint
  // magnitude comparison allocates nothing. The failure keeps the
  // native invalid-construction code and message shape with no retry.
  if (value < INT64_MIN || value > INT64_MAX) {
    const huge = value < -ENCODE_DIAGNOSTIC_LIMIT || value > ENCODE_DIAGNOSTIC_LIMIT;
    throw new ValueError(
      "invalid-construction",
      huge ? "int out of 64-bit range: bigint exceeds 26 digits at $"
        : `int out of 64-bit range: ${value} at $`,
    );
  }
  const out = backend.call("encode-value", ["int", value]);
  if (typeof out !== "string") {
    throw new ValueError("invalid-construction", "native int encode did not return text");
  }
  return out;
}
