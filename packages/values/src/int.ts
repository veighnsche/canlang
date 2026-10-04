import { ValueError } from "./errors.js";

/** Minimum signed 64-bit integer. */
export const INT64_MIN: bigint = -(2n ** 63n);
/** Maximum signed 64-bit integer. */
export const INT64_MAX: bigint = 2n ** 63n - 1n;

function requireBigint(value: unknown, what: string): asserts value is bigint {
  if (typeof value !== "bigint") {
    throw new ValueError("invalid-construction", `${what} must be a bigint`);
  }
}

/**
 * Checked int64 narrowing (DESIGN §13 `int64` helper). Non-bigint inputs are
 * `invalid-construction`; out-of-range bigints are `overflow` per DESIGN
 * "overflow is an error". No Number routing: the value stays a bigint.
 */
export function int64(value: bigint): bigint {
  requireBigint(value, "int64");
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new ValueError("overflow", `int64 out of range: ${value}`);
  }
  return value;
}

/**
 * Checked int64 addition. Checked at the result boundary (DESIGN L211):
 * the exact sum must fit; `overflow` otherwise.
 */
export function addInt(a: bigint, b: bigint): bigint {
  requireBigint(a, "addInt");
  requireBigint(b, "addInt");
  return int64(a + b);
}

/** Checked int64 subtraction; `overflow` when the exact difference escapes. */
export function subtractInt(a: bigint, b: bigint): bigint {
  requireBigint(a, "subtractInt");
  requireBigint(b, "subtractInt");
  return int64(a - b);
}

/** Checked int64 multiplication; `overflow` when the exact product escapes. */
export function multiplyInt(a: bigint, b: bigint): bigint {
  requireBigint(a, "multiplyInt");
  requireBigint(b, "multiplyInt");
  return int64(a * b);
}

/**
 * Checked int64 remainder. Quotient truncates toward zero, so the remainder
 * carries the dividend's sign (native bigint `%` semantics, DESIGN L211).
 * A zero divisor fails with `division-by-zero`.
 */
export function modInt(a: bigint, b: bigint): bigint {
  requireBigint(a, "modInt");
  requireBigint(b, "modInt");
  if (b === 0n) {
    throw new ValueError("division-by-zero", "int remainder with zero divisor");
  }
  return int64(a % b);
}

/**
 * Checked int64 unary negation, including signed-minimum negation
 * (`overflow` for INT64_MIN, DESIGN L211). Shared by decimal/money negation.
 */
export function negateInt(a: bigint): bigint {
  requireBigint(a, "negateInt");
  return int64(-a);
}

/**
 * Checked int64 absolute value. Same overflow boundary as negation
 * (`overflow` for INT64_MIN, DESIGN L263).
 */
export function absInt(a: bigint): bigint {
  requireBigint(a, "absInt");
  return a < 0n ? negateInt(a) : int64(a);
}

/**
 * Total int comparison returning -1/0/1 for generated relational lowering.
 * Exact for arbitrary bigints; comparison cannot overflow, so no range check.
 */
export function compareInt(a: bigint, b: bigint): -1 | 0 | 1 {
  requireBigint(a, "compareInt");
  requireBigint(b, "compareInt");
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
