/**
 * R16 decision record (T11 values slice; checker behavior is a LATER slice
 * after D02b releases — this file implements the values side only).
 *
 * Decision: ACCEPT integral literals where the expected type is uniquely
 * decimal (contextual typing; literal spellings only; no variable coercion).
 *
 * Evidence: CanAffiliate:23 (`rate:decimal min=0 max=1`); T10-unmasked
 * CanMember:279/558 and CanRent:296 (`quantity=1` inside DocumentLine
 * literals); DocumentLine.quantity:decimal (CanInvoice:66);
 * Line.quantity:decimal=1 (CanInvoice:104). DESIGN L165 precedent (a string
 * literal may inhabit an expected validated string-like type after
 * validation, never coercing a variable), L215 (operator-local int/decimal
 * promotion, not a general cast), L219 (decimal literals stay checked
 * representations), L907 (canonical decimal strings on wire).
 *
 * Rationale: an integral spelling has exactly one numeric value, so the
 * narrow rule cannot misread intent; exactness is preserved end to end
 * (bigint coef at scale 0, no Number routing, no int64 limit — decimals
 * hold 38 digits); bounds/defaults/arguments/fixtures/wire all flow through
 * the same exact parse (`parseDecimal`/`decimalFromInteger` here,
 * `decodeDecimal` in wire.ts).
 *
 * Strongest opposing case: implicit numeric conversion can hide rounding,
 * change overload selection, and blur exact representations (ledger R16).
 *
 * Flip condition: a real ambiguity (an integral literal accepted where
 * int-vs-decimal changes overload choice or semantics) or an exactness
 * loss caused by the narrow rule.
 *
 * Negatives held: variable coercion (int-typed values never become
 * decimals), ambiguous overloads, and precision/range violations
 * (out-of-range, never silent rounding) stay rejected.
 */
import type { DecimalValue, MoneyValue } from "@canlang/contracts/values";
import { ValueError } from "./errors.js";
import { int64 } from "./int.js";

/** Maximum fractional digits of a Can decimal (DESIGN L107). */
export const DECIMAL_MAX_SCALE = 18;
/** Maximum significant digits of a Can decimal (DESIGN L107). */
export const DECIMAL_MAX_SIGNIFICANT_DIGITS = 38;

const POW10_CACHE: bigint[] = [1n];

/** Exact 10^n for small n >= 0. Bigint-only; never routes through Number. */
function pow10(n: number): bigint {
  let cached = POW10_CACHE[n] as bigint | undefined;
  while (cached === undefined) {
    const top = POW10_CACHE[POW10_CACHE.length - 1] as bigint;
    POW10_CACHE.push(top * 10n);
    cached = POW10_CACHE[n] as bigint | undefined;
  }
  return cached;
}

/** Decimal digits of |coef| ("0" counts 1). Exact string length, no Number math. */
function significantDigits(coef: bigint): number {
  const digits = (coef < 0n ? -coef : coef).toString();
  return digits.length;
}

/**
 * Exact decimal value: unnormalized coefficient plus scale 0..18 (R1).
 * Stored scale is retained (never silently normalized); equality is by
 * numeric value across scales. Instances are frozen. Code paths:
 * malformed inputs are `invalid-construction`, representation breaches at
 * construction (scale, significant digits) are `out-of-range`; arithmetic
 * results that breach 38 digits are `overflow` (see `makeDecimalResult`).
 */
export class Decimal implements DecimalValue {
  readonly kind: "decimal" = "decimal";
  readonly coef: bigint;
  readonly scale: number;

  constructor(coef: bigint, scale: number) {
    if (typeof coef !== "bigint") {
      throw new ValueError("invalid-construction", "decimal coef must be a bigint");
    }
    if (typeof scale !== "number" || !Number.isInteger(scale)) {
      throw new ValueError("invalid-construction", "decimal scale must be an integer");
    }
    if (scale < 0 || scale > DECIMAL_MAX_SCALE) {
      throw new ValueError("out-of-range", `decimal scale out of range 0..18: ${scale}`);
    }
    if (significantDigits(coef) > DECIMAL_MAX_SIGNIFICANT_DIGITS) {
      throw new ValueError("out-of-range", "decimal exceeds 38 significant digits");
    }
    this.coef = coef;
    this.scale = scale;
    Object.freeze(this);
  }
}

/** Guard for valid decimal values: shape, scale range and 38-digit bound. */
export function isDecimal(value: unknown): value is Decimal {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record["kind"] !== "decimal") return false;
  if (typeof record["coef"] !== "bigint") return false;
  if (typeof record["scale"] !== "number" || !Number.isInteger(record["scale"])) return false;
  const scale = record["scale"];
  if (scale < 0 || scale > DECIMAL_MAX_SCALE) return false;
  return significantDigits(record["coef"]) <= DECIMAL_MAX_SIGNIFICANT_DIGITS;
}

/** Arithmetic-result boundary: a computed coef breaching 38 digits is `overflow`. */
function makeDecimalResult(coef: bigint, scale: number): Decimal {
  if (significantDigits(coef) > DECIMAL_MAX_SIGNIFICANT_DIGITS) {
    throw new ValueError("overflow", "decimal result exceeds 38 significant digits");
  }
  return new Decimal(coef, scale);
}

interface DecimalParts {
  readonly coef: bigint;
  readonly scale: number;
}

/**
 * Exact int promotion inside the operator (DESIGN L209): a bigint operand
 * is the decimal (coef, scale 0). Arbitrary bigints are accepted — decimals
 * hold up to 38 digits, so no int64 narrowing applies here.
 */
function toDecimalParts(value: Decimal | bigint, what: string): DecimalParts {
  if (typeof value === "bigint") {
    return { coef: value, scale: 0 };
  }
  if (isDecimal(value)) {
    return { coef: value.coef, scale: value.scale };
  }
  throw new ValueError("invalid-construction", `${what} must be a decimal or bigint`);
}

/**
 * Round-half-even core shared by decimal and money boundaries: rounds the
 * exact rational num/den (den != 0) to an integer, ties to even, symmetric
 * for negatives. Zero denominator is `division-by-zero`.
 */
export function roundRationalHalfEven(num: bigint, den: bigint): bigint {
  if (typeof num !== "bigint" || typeof den !== "bigint") {
    throw new ValueError("invalid-construction", "roundRationalHalfEven needs bigint inputs");
  }
  if (den === 0n) {
    throw new ValueError("division-by-zero", "rounding with zero denominator");
  }
  const positive = den > 0n ? num : -num;
  const divisor = den > 0n ? den : -den;
  const negative = positive < 0n;
  const mag = negative ? -positive : positive;
  const kept = mag / divisor;
  const rest = mag % divisor;
  const twice = rest * 2n;
  let rounded = kept;
  if (twice > divisor || (twice === divisor && kept % 2n !== 0n)) {
    rounded = kept + 1n;
  }
  return negative ? -rounded : rounded;
}

/** Round-half-even of coef/10^drop to an integer (drop >= 0). */
function roundScaledHalfEven(coef: bigint, drop: number): bigint {
  return roundRationalHalfEven(coef, pow10(drop));
}

/**
 * Decimal addition. Exact sum at max operand scale (<= 18, never needs
 * rounding), then the 38-digit check. Value-exact: no rounding occurs.
 */
export function addDecimal(a: Decimal | bigint, b: Decimal | bigint): Decimal {
  const left = toDecimalParts(a, "addDecimal");
  const right = toDecimalParts(b, "addDecimal");
  const scale = Math.max(left.scale, right.scale);
  const sum = left.coef * pow10(scale - left.scale) + right.coef * pow10(scale - right.scale);
  return makeDecimalResult(sum, scale);
}

/** Decimal subtraction. Exact difference, then the 38-digit check. */
export function subtractDecimal(a: Decimal | bigint, b: Decimal | bigint): Decimal {
  const left = toDecimalParts(a, "subtractDecimal");
  const right = toDecimalParts(b, "subtractDecimal");
  const scale = Math.max(left.scale, right.scale);
  const diff = left.coef * pow10(scale - left.scale) - right.coef * pow10(scale - right.scale);
  return makeDecimalResult(diff, scale);
}

/**
 * Decimal multiplication. Exact product at summed scale when that fits in
 * 18 fractional places, else half-even to 18 places, then the 38-digit check.
 */
export function multiplyDecimal(a: Decimal | bigint, b: Decimal | bigint): Decimal {
  const left = toDecimalParts(a, "multiplyDecimal");
  const right = toDecimalParts(b, "multiplyDecimal");
  const exactScale = left.scale + right.scale;
  const exactCoef = left.coef * right.coef;
  if (exactScale <= DECIMAL_MAX_SCALE) {
    return makeDecimalResult(exactCoef, exactScale);
  }
  return makeDecimalResult(roundScaledHalfEven(exactCoef, exactScale - DECIMAL_MAX_SCALE), DECIMAL_MAX_SCALE);
}

/**
 * Exact integer-ratio division N/D (D != 0) to a decimal: terminating
 * results keep their minimal scale ("retained", DESIGN L213); repeating
 * results round half-even to 18 places; then the 38-digit check.
 */
function divideIntegers(num: bigint, den: bigint): Decimal {
  if (den === 0n) {
    throw new ValueError("division-by-zero", "decimal division by zero");
  }
  const negative = (num < 0n) !== (den < 0n);
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const intPart = n / d;
  let rest = n % d;
  if (rest === 0n) {
    return makeDecimalResult(negative ? -intPart : intPart, 0);
  }
  let frac = 0n;
  for (let places = 1; places <= DECIMAL_MAX_SCALE; places += 1) {
    rest *= 10n;
    frac = frac * 10n + (rest / d);
    rest %= d;
    if (rest === 0n) {
      const coef = intPart * pow10(places) + frac;
      return makeDecimalResult(negative ? -coef : coef, places);
    }
  }
  // Non-terminating within 18 places: guard digit plus sticky remainder
  // decide half-even at place 18.
  rest *= 10n;
  const guard = rest / d;
  const sticky = rest % d;
  let coef = intPart * pow10(DECIMAL_MAX_SCALE) + frac;
  if (guard > 5n || (guard === 5n && sticky > 0n) || (guard === 5n && sticky === 0n && coef % 2n !== 0n)) {
    coef += 1n;
  }
  return makeDecimalResult(negative ? -coef : coef, DECIMAL_MAX_SCALE);
}

function asMoneyParts(value: unknown): { readonly minor: bigint; readonly currency: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["kind"] !== "money") return null;
  if (typeof record["minor"] !== "bigint" || typeof record["currency"] !== "string") return null;
  return { minor: record["minor"], currency: record["currency"] };
}

/**
 * Decimal division (DESIGN §13 `divideDecimal` helper):
 * int|decimal / int|decimal and the money/money ratio (same currency) all
 * yield decimals with decimal rounding. Mixed money/scalar division is a
 * checker-level type error surfaced here as `invalid-construction`
 * (money/scalar is `divideMoney`; scalar/money is unlisted in the matrix).
 * Unlike-currency ratios are `currency-mismatch`; zero divisors fail.
 */
export function divideDecimal(a: Decimal | bigint | MoneyValue, b: Decimal | bigint | MoneyValue): Decimal {
  const leftMoney = asMoneyParts(a);
  const rightMoney = asMoneyParts(b);
  if (leftMoney !== null || rightMoney !== null) {
    if (leftMoney === null || rightMoney === null) {
      throw new ValueError(
        "invalid-construction",
        "divideDecimal takes int|decimal operands or a money/money ratio, never a mix",
      );
    }
    if (leftMoney.currency !== rightMoney.currency) {
      throw new ValueError("currency-mismatch", "money ratio needs matching currencies");
    }
    return divideIntegers(leftMoney.minor, rightMoney.minor);
  }
  const left = toDecimalParts(a as Decimal | bigint, "divideDecimal");
  const right = toDecimalParts(b as Decimal | bigint, "divideDecimal");
  // (ca/10^sa) / (cb/10^sb) = (ca*10^sb) / (cb*10^sa), exact integers.
  return divideIntegers(left.coef * pow10(right.scale), right.coef * pow10(left.scale));
}

/**
 * Duration/duration division (DESIGN matrix: duration, duration / decimal).
 * Integer-millisecond bigints in, exact decimal out. Durations are int64 ms
 * by representation, so both inputs are int64-narrowed at entry like every
 * other duration op; out-of-range inputs are `overflow`.
 */
export function divideDurationMs(aMs: bigint, bMs: bigint): Decimal {
  if (typeof aMs !== "bigint" || typeof bMs !== "bigint") {
    throw new ValueError("invalid-construction", "divideDurationMs needs bigint millisecond inputs");
  }
  return divideIntegers(int64(aMs), int64(bMs));
}

/** Decimal unary negation. Exact; scale preserved. */
export function negateDecimal(value: Decimal): Decimal {
  if (!isDecimal(value)) {
    throw new ValueError("invalid-construction", "negateDecimal needs a decimal");
  }
  return new Decimal(-value.coef, value.scale);
}

/** Decimal absolute value. Exact; scale preserved. */
export function absDecimal(value: Decimal): Decimal {
  if (!isDecimal(value)) {
    throw new ValueError("invalid-construction", "absDecimal needs a decimal");
  }
  return new Decimal(value.coef < 0n ? -value.coef : value.coef, value.scale);
}

/**
 * `round(value, scale)` builtin (DESIGN L244/L263): integer scale 0..18
 * (other scales fail with `out-of-range`), half-even, returns decimal.
 * Rounding down drops digits half-even; rounding up rescales exactly.
 * Int inputs promote exactly; a breaching rescale is `overflow`.
 */
export function round(value: Decimal | bigint, scale: number): Decimal {
  if (typeof scale !== "number" || !Number.isInteger(scale)) {
    throw new ValueError("invalid-construction", "round scale must be an integer");
  }
  if (scale < 0 || scale > DECIMAL_MAX_SCALE) {
    throw new ValueError("out-of-range", `round scale out of range 0..18: ${scale}`);
  }
  const parts = toDecimalParts(value, "round");
  if (scale >= parts.scale) {
    return makeDecimalResult(parts.coef * pow10(scale - parts.scale), scale);
  }
  return makeDecimalResult(roundScaledHalfEven(parts.coef, parts.scale - scale), scale);
}

/**
 * Total decimal comparison returning -1/0/1 (DESIGN §13 `compareDecimal`).
 * Exact promotion makes int/decimal mixes comparable; scale-insensitive.
 */
export function compareDecimal(a: Decimal | bigint, b: Decimal | bigint): -1 | 0 | 1 {
  const left = toDecimalParts(a, "compareDecimal");
  const right = toDecimalParts(b, "compareDecimal");
  const scale = Math.max(left.scale, right.scale);
  const x = left.coef * pow10(scale - left.scale);
  const y = right.coef * pow10(scale - right.scale);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

/** Decimal value equality across scales (R3): 1.0 == 1.00. */
export function equalDecimal(a: Decimal | bigint, b: Decimal | bigint): boolean {
  return compareDecimal(a, b) === 0;
}

const DECIMAL_TEXT = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Exact string-only decimal parse (checked constructor input): optional
 * leading `-`, digit runs on both sides of an optional point (GRAMMAR
 * DECIMAL plus wire-integral forms; no exponent, separators or `+`).
 * Inputs breaching 18 places or 38 digits fail `out-of-range` — checked
 * representations, never silently rounded. Authored scale is retained.
 */
export function parseDecimal(text: string): Decimal {
  if (typeof text !== "string") {
    throw new ValueError("invalid-construction", "parseDecimal needs a string");
  }
  const match = DECIMAL_TEXT.exec(text);
  if (match === null) {
    throw new ValueError("invalid-construction", `invalid decimal text: ${text}`);
  }
  const sign = match[1] as string | undefined;
  const intDigits = match[2] as string;
  const fracDigits = (match[3] as string | undefined) ?? "";
  if (fracDigits.length > DECIMAL_MAX_SCALE) {
    throw new ValueError("out-of-range", "decimal text exceeds 18 fractional digits");
  }
  const coef = BigInt((sign ?? "") + intDigits + fracDigits);
  if (significantDigits(coef) > DECIMAL_MAX_SIGNIFICANT_DIGITS) {
    throw new ValueError("out-of-range", "decimal text exceeds 38 significant digits");
  }
  return new Decimal(coef, fracDigits.length);
}

/**
 * R16/T11 canonical construction for integral spellings in decimal
 * positions: the bigint is the exact coef at scale 0. Representation
 * breaches are `out-of-range` via the Decimal constructor (never silent);
 * no Number routing and no int64 narrowing (decimals hold 38 digits).
 * Literal spellings only — this never coerces int-typed variables, which
 * stay a checker-side rejection (later slice).
 */
export function decimalFromInteger(coef: bigint): Decimal {
  if (typeof coef !== "bigint") {
    throw new ValueError("invalid-construction", "decimalFromInteger needs a bigint");
  }
  return new Decimal(coef, 0);
}

/**
 * Canonical normalized decimal text (R2a wire form): strip fractional
 * zeros, no point when integral, `0` for zero, plain base-10, no exponent.
 */
export function decimalToString(value: Decimal): string {
  if (!isDecimal(value)) {
    throw new ValueError("invalid-construction", "decimalToString needs a decimal");
  }
  if (value.coef === 0n) {
    return "0";
  }
  const negative = value.coef < 0n;
  const digits = (negative ? -value.coef : value.coef).toString();
  const prefix = negative ? "-" : "";
  if (value.scale === 0) {
    return prefix + digits;
  }
  const padded = digits.length > value.scale ? digits : digits.padStart(value.scale + 1, "0");
  const intPart = padded.slice(0, padded.length - value.scale);
  const fracPart = padded.slice(padded.length - value.scale).replace(/0+$/, "");
  if (fracPart === "") {
    return prefix + intPart;
  }
  return `${prefix}${intPart}.${fracPart}`;
}
