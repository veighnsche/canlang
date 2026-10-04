import type { MoneyValue } from "../../contracts/src/values.js";
import { CURRENCY_MINOR_UNITS } from "./currency-data.js";
import type { Decimal } from "./decimal.js";
import { divideDecimal, isDecimal, roundRationalHalfEven } from "./decimal.js";
import { ValueError } from "./errors.js";
import { absInt, addInt, int64, negateInt, subtractInt } from "./int.js";
import { isMoney, makeMoney } from "./kinds.js";

/** 10^s for pinned currency scales (max 4: CLF, UYW). */
const MINOR_FACTORS: ReadonlyArray<bigint> = [1n, 10n, 100n, 1000n, 10000n];

/**
 * Pinned minor-unit scale for a currency code. Only members of the pinned
 * ISO 4217 table are currency values (R2b); any other string — well-formed
 * or not — is `unknown-currency` at this checking boundary. Non-strings
 * are `invalid-construction`.
 */
export function currencyScale(currency: string): number {
  if (typeof currency !== "string") {
    throw new ValueError("invalid-construction", "currency must be a string");
  }
  const scale = CURRENCY_MINOR_UNITS[currency];
  if (scale === undefined) {
    throw new ValueError("unknown-currency", `unknown currency: ${currency}`);
  }
  return scale;
}

/** Pinned-table membership probe: true exactly for admissible currencies. */
export function isKnownCurrency(currency: unknown): boolean {
  return typeof currency === "string" && CURRENCY_MINOR_UNITS[currency] !== undefined;
}

function minorFactor(scale: number): bigint {
  return MINOR_FACTORS[scale] as bigint;
}

function requireMoney(value: unknown, what: string): MoneyValue {
  if (!isMoney(value)) {
    throw new ValueError("invalid-construction", `${what} must be a money value`);
  }
  return value;
}

function requireFactor(value: Decimal | bigint, what: string): Decimal | bigint {
  if (typeof value === "bigint") return value;
  if (isDecimal(value)) return value;
  throw new ValueError("invalid-construction", `${what} factor must be int or decimal`);
}

/**
 * `money(value, currency)` checked constructor (DESIGN L255): validates
 * currency membership, converts int|decimal exactly, rounds ONCE half-even
 * to the pinned minor-unit scale, then checks `minor:int` (`overflow`).
 */
export function money(value: bigint | Decimal, currency: string): MoneyValue {
  const scale = currencyScale(currency);
  let minor: bigint;
  if (typeof value === "bigint") {
    minor = value * minorFactor(scale);
  } else if (isDecimal(value)) {
    if (value.scale <= scale) {
      minor = value.coef * minorFactor(scale - value.scale);
    } else {
      minor = roundDecimalToMinor(value.coef, value.scale - scale);
    }
  } else {
    throw new ValueError("invalid-construction", "money value must be int or decimal");
  }
  return makeMoney(int64(minor), currency);
}

/** Round-half-even of coef/10^drop to minor units (drop > 0, unbounded). */
function roundDecimalToMinor(coef: bigint, drop: number): bigint {
  let divisor = 1n;
  for (let i = 0; i < drop; i += 1) {
    divisor *= 10n;
  }
  return roundRationalHalfEven(coef, divisor);
}

/**
 * Money addition (DESIGN §13 `addMoney`): same currency only
 * (`currency-mismatch` otherwise), exact minor sum checked to int64.
 */
export function addMoney(a: MoneyValue, b: MoneyValue): MoneyValue {
  const left = requireMoney(a, "addMoney");
  const right = requireMoney(b, "addMoney");
  if (left.currency !== right.currency) {
    throw new ValueError("currency-mismatch", "money addition needs matching currencies");
  }
  return makeMoney(addInt(left.minor, right.minor), left.currency);
}

/** Money subtraction: same currency, exact minor difference, int64-checked. */
export function subtractMoney(a: MoneyValue, b: MoneyValue): MoneyValue {
  const left = requireMoney(a, "subtractMoney");
  const right = requireMoney(b, "subtractMoney");
  if (left.currency !== right.currency) {
    throw new ValueError("currency-mismatch", "money subtraction needs matching currencies");
  }
  return makeMoney(subtractInt(left.minor, right.minor), left.currency);
}

/**
 * Money scaling (DESIGN §13 `multiplyMoney`, `money * int|decimal`): exact
 * rational minor result rounded ONCE half-even, then int64-checked.
 * Generated code normalizes scalar*money to this (money, factor) order.
 */
export function multiplyMoney(m: MoneyValue, factor: Decimal | bigint): MoneyValue {
  const amount = requireMoney(m, "multiplyMoney");
  const f = requireFactor(factor, "multiplyMoney");
  let minor: bigint;
  if (typeof f === "bigint") {
    minor = amount.minor * f;
  } else {
    minor = roundDecimalToMinor(amount.minor * f.coef, f.scale);
  }
  return makeMoney(int64(minor), amount.currency);
}

/**
 * Money division (`money / int|decimal -> money`): exact rational minor
 * result rounded ONCE half-even, then int64-checked. Zero factors fail
 * with `division-by-zero`.
 */
export function divideMoney(m: MoneyValue, divisor: Decimal | bigint): MoneyValue {
  const amount = requireMoney(m, "divideMoney");
  const d = requireFactor(divisor, "divideMoney");
  if (typeof d === "bigint") {
    if (d === 0n) {
      throw new ValueError("division-by-zero", "money division by zero");
    }
    return makeMoney(int64(roundRationalHalfEven(amount.minor, d)), amount.currency);
  }
  if (d.coef === 0n) {
    throw new ValueError("division-by-zero", "money division by zero");
  }
  let scaled = amount.minor;
  for (let i = 0; i < d.scale; i += 1) {
    scaled *= 10n;
  }
  return makeMoney(int64(roundRationalHalfEven(scaled, d.coef)), amount.currency);
}

/**
 * Money/money ratio (`money / money -> decimal`, same currency): exact
 * decimal division with decimal rounding (18 places, 38 digits). A zero
 * divisor fails; unlike currencies are `currency-mismatch`.
 */
export function moneyRatio(a: MoneyValue, b: MoneyValue): Decimal {
  const left = requireMoney(a, "moneyRatio");
  const right = requireMoney(b, "moneyRatio");
  if (left.currency !== right.currency) {
    throw new ValueError("currency-mismatch", "money ratio needs matching currencies");
  }
  return divideDecimal(left.minor, right.minor);
}

/**
 * Money ordering (DESIGN §13 `compareMoney`): -1/0/1 by minor units.
 * Unlike currencies FAIL (R2c); cross-currency questions use `equalMoney`.
 */
export function compareMoney(a: MoneyValue, b: MoneyValue): -1 | 0 | 1 {
  const left = requireMoney(a, "compareMoney");
  const right = requireMoney(b, "compareMoney");
  if (left.currency !== right.currency) {
    throw new ValueError("currency-mismatch", "money comparison needs matching currencies");
  }
  if (left.minor < right.minor) return -1;
  if (left.minor > right.minor) return 1;
  return 0;
}

/**
 * Money equality (DESIGN §13 `equalMoney`, R2c): decidable across
 * currencies — mismatched currencies are unequal (false), never an error.
 * Centralizes the unlike-currency rule pending any normative clarification.
 */
export function equalMoney(a: MoneyValue, b: MoneyValue): boolean {
  const left = requireMoney(a, "equalMoney");
  const right = requireMoney(b, "equalMoney");
  return left.currency === right.currency && left.minor === right.minor;
}

/** Money unary negation. Exact minor negation, int64-checked. */
export function negateMoney(m: MoneyValue): MoneyValue {
  const amount = requireMoney(m, "negateMoney");
  return makeMoney(negateInt(amount.minor), amount.currency);
}

/** Money absolute value. Same overflow boundary as negation. */
export function absMoney(m: MoneyValue): MoneyValue {
  const amount = requireMoney(m, "absMoney");
  return makeMoney(absInt(amount.minor), amount.currency);
}
