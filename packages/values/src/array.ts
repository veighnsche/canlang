/**
 * Lane 02 pure arrays: supplied-array evaluation of the sequence builtins.
 *
 * Normative: DESIGN.md L176-180 (query-fed aggregates boundary), L201
 * (concat), L217 (flatten), L231-242 (signatures), L261-263 (nonempty-literal
 * rule, empty forms, group/key rules, at), L269 and lane-02 decisions R1-R3
 * (runtime tags; money == decidable with ordering failing; decimal value
 * equality).
 *
 * Lane-03 boundary: every function here evaluates SUPPLIED arrays only.
 * Record-query evaluation (query domains feeding count/sum/min/max/any/all/
 * first, stable-ordering proofs, the static nonempty-literal rule) is lane
 * 03's; the checker owns the nonempty-literal proof and stable-ordering
 * requirements. No record-query logic exists in this module.
 *
 * Decisions recorded here (no normative text found):
 * - `sumMoney` without an explicit currency over an empty domain throws
 *   `invalid-construction` (no currency can be produced); with a currency it
 *   yields that currency's zero, and unknown currencies fail `unknown-currency`
 *   on either path (the inferred path validates the shared head currency).
 * - `min`/`max` require strictly homogeneous runtime kinds; int/decimal mixes
 *   are `invalid-construction` (the DESIGN L209 promotion rule governs the
 *   comparison operators, not aggregate domains). Money domains reject mixed
 *   currencies via `currency-mismatch`; every other mixed or unordered kind
 *   (including null elements) is `invalid-construction`.
 * - Text ordering is Unicode scalar order (DESIGN L209), implemented over code
 *   points rather than UTF-16 units so astral characters sort after the BMP.
 * - `any`/`all` predicates and the `group` key function are plain JS
 *   functions; a non-function, or a predicate returning a non-boolean, is
 *   `invalid-construction`.
 * - `group` key matching reuses `equalValue` runtime dispatch, so decimal keys
 *   group by value across scales, money keys group per currency (mixed
 *   currencies form separate groups, never an error), ref keys group by
 *   identity, and null keys form exactly one group. Mixed key kinds are
 *   `invalid-construction`, except int/decimal keys which merge by value promotion.
 * - `sumDecimal` requires decimal elements (no int promotion inside the
 *   aggregate); `at` requires a bigint index and returns null for negative or
 *   out-of-range indices, including indices beyond JS number range.
 */

import type { CanValue, MoneyValue } from "../../contracts/src/values.js";
import { compareDecimal, DECIMAL_MAX_SIGNIFICANT_DIGITS, Decimal, isDecimal } from "./decimal.js";
import { equalValue } from "./equality.js";
import { ValueError } from "./errors.js";
import { int64 } from "./int.js";
import { isDateValue, isDatetime, isMoney, makeMoney } from "./kinds.js";
import { addMoney, compareMoney, currencyScale } from "./money.js";
import { compareDate, compareDuration, compareInstant } from "./temporal.js";
import { compareScalar } from "./text.js";

function requireArray<T>(value: unknown, what: string): ReadonlyArray<T> {
  if (!Array.isArray(value)) {
    throw new ValueError("invalid-construction", `${what} must be an array`);
  }
  return value as ReadonlyArray<T>;
}

/**
 * Ordered-sequence concatenation (DESIGN L201 `+` on compatible sequences).
 * Plain concat; the checker guarantees same-element domains.
 */
export function concat<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): ReadonlyArray<T> {
  const left = requireArray<T>(a, "concat first");
  const right = requireArray<T>(b, "concat second");
  return Object.freeze([...left, ...right]);
}

/**
 * One-layer flatten (DESIGN L217): outer-then-inner order and duplicates are
 * preserved; empty input yields an empty typed array. A non-array element is
 * `invalid-construction`.
 */
export function flatten<T>(domain: ReadonlyArray<ReadonlyArray<T>>): ReadonlyArray<T> {
  const outer = requireArray<ReadonlyArray<T>>(domain, "flatten domain");
  const out: T[] = [];
  for (const inner of outer) {
    if (!Array.isArray(inner)) {
      throw new ValueError("invalid-construction", "flatten elements must be arrays");
    }
    for (const item of inner) {
      out.push(item as T);
    }
  }
  return Object.freeze(out);
}

/**
 * Nullable indexing (DESIGN L263): null for negative or out-of-range indices.
 * The index must be a bigint int. Can arrays are dense; holes read as null.
 */
export function at<T>(array: ReadonlyArray<T>, index: bigint): T | null {
  const items = requireArray<T>(array, "at array");
  if (typeof index !== "bigint") {
    throw new ValueError("invalid-construction", "at index must be an int (bigint)");
  }
  if (index < 0n || index >= BigInt(items.length)) {
    return null;
  }
  return items[Number(index)] ?? null;
}

/** Domain size as a Can int. */
export function count<T>(domain: ReadonlyArray<T>): bigint {
  return BigInt(requireArray<T>(domain, "count domain").length);
}

/** Int sum; the empty sum is the typed zero. The mathematical total is int64-checked once. */
export function sumInt(domain: ReadonlyArray<bigint>): bigint {
  const items = requireArray<bigint>(domain, "sumInt domain");
  let total = 0n;
  for (const value of items) {
    if (typeof value !== "bigint") {
      throw new ValueError("invalid-construction", "sumInt needs int elements");
    }
    total += value;
  }
  return int64(total);
}

/**
 * Decimal sum; the empty sum is decimal zero. Decimal-only elements. Every
 * coef aligns exactly to the max input scale (scale-up is exact, max 18),
 * the coefs sum as one bigint, and the 38-digit check applies once — no
 * per-addition rounding or intermediate checks.
 */
export function sumDecimal(domain: ReadonlyArray<Decimal>): Decimal {
  const items = requireArray<Decimal>(domain, "sumDecimal domain");
  for (const value of items) {
    if (!isDecimal(value)) {
      throw new ValueError("invalid-construction", "sumDecimal needs decimal elements");
    }
  }
  if (items.length === 0) {
    return new Decimal(0n, 0);
  }
  let scale = 0;
  for (const value of items) {
    scale = Math.max(scale, value.scale);
  }
  let total = 0n;
  for (const value of items) {
    total += value.coef * 10n ** BigInt(scale - value.scale);
  }
  // Arithmetic-result boundary mirroring decimal.ts `makeDecimalResult`
  // (unexported): a computed coef breaching 38 digits is `overflow`.
  const magnitude = total < 0n ? -total : total;
  if (magnitude.toString(10).length > DECIMAL_MAX_SIGNIFICANT_DIGITS) {
    throw new ValueError("overflow", "decimal result exceeds 38 significant digits");
  }
  return new Decimal(total, scale);
}

/**
 * Duration sum over integer milliseconds; the empty sum is zero. The
 * mathematical total is int64-checked once (durations share the int64 range).
 */
export function sumDuration(domain: ReadonlyArray<bigint>): bigint {
  const items = requireArray<bigint>(domain, "sumDuration domain");
  let total = 0n;
  for (const value of items) {
    if (typeof value !== "bigint") {
      throw new ValueError("invalid-construction", "sumDuration needs duration elements");
    }
    total += value;
  }
  return int64(total);
}

/**
 * Money sum. With an explicit currency every amount must match it and the
 * empty sum is that currency's zero; without one the domain must be nonempty
 * and every amount must match the first element's currency. Mismatches are
 * `currency-mismatch`; minor totals are int64-checked per addition.
 */
export function sumMoney(domain: ReadonlyArray<MoneyValue>, currency?: string): MoneyValue {
  const items = requireArray<MoneyValue>(domain, "sumMoney domain");
  if (currency !== undefined) {
    currencyScale(currency);
    let total = makeMoney(0n, currency);
    for (const value of items) {
      if (!isMoney(value)) {
        throw new ValueError("invalid-construction", "sumMoney needs money elements");
      }
      if (value.currency !== currency) {
        throw new ValueError("currency-mismatch", "sumMoney amounts must match the explicit currency");
      }
      total = addMoney(total, value);
    }
    return total;
  }
  if (items.length === 0) {
    throw new ValueError("invalid-construction", "sumMoney of an empty domain needs an explicit currency");
  }
  const head = items[0];
  if (!isMoney(head)) {
    throw new ValueError("invalid-construction", "sumMoney needs money elements");
  }
  // The loop below proves every element shares the head currency, so one
  // table lookup validates every amount (DESIGN L213).
  currencyScale(head.currency);
  let total = makeMoney(0n, head.currency);
  for (const value of items) {
    if (!isMoney(value)) {
      throw new ValueError("invalid-construction", "sumMoney needs money elements");
    }
    if (value.currency !== head.currency) {
      throw new ValueError("currency-mismatch", "sumMoney amounts must share one currency");
    }
    total = addMoney(total, value);
  }
  return total;
}

type OrderedComparator = (a: unknown, b: unknown) => number;

/**
 * Selects the ordered-scalar comparator from the first element's runtime
 * kind. bigint covers int/duration/byte-quantity (one tag, R1); duration
 * comparison delegates to `compareDuration` for its narrower contract.
 */
function comparatorFor(first: unknown, what: string): OrderedComparator {
  if (typeof first === "bigint") {
    return (a: unknown, b: unknown): number => {
      if (typeof a !== "bigint" || typeof b !== "bigint") {
        throw new ValueError("invalid-construction", `${what} needs a homogeneous int domain`);
      }
      return compareDuration(a, b);
    };
  }
  if (typeof first === "string") {
    return (a: unknown, b: unknown): number => {
      if (typeof a !== "string" || typeof b !== "string") {
        throw new ValueError("invalid-construction", `${what} needs a homogeneous text domain`);
      }
      return compareScalar(a, b);
    };
  }
  if (isDecimal(first)) {
    return (a: unknown, b: unknown): number => {
      if (!isDecimal(a) || !isDecimal(b)) {
        throw new ValueError("invalid-construction", `${what} needs a homogeneous decimal domain`);
      }
      return compareDecimal(a, b);
    };
  }
  if (isMoney(first)) {
    return (a: unknown, b: unknown): number => {
      if (!isMoney(a) || !isMoney(b)) {
        throw new ValueError("invalid-construction", `${what} needs a homogeneous money domain`);
      }
      return compareMoney(a, b);
    };
  }
  if (isDateValue(first)) {
    return (a: unknown, b: unknown): number => {
      if (!isDateValue(a) || !isDateValue(b)) {
        throw new ValueError("invalid-construction", `${what} needs a homogeneous date domain`);
      }
      return compareDate(a, b);
    };
  }
  if (isDatetime(first)) {
    return (a: unknown, b: unknown): number => {
      if (!isDatetime(a) || !isDatetime(b)) {
        throw new ValueError("invalid-construction", `${what} needs a homogeneous datetime domain`);
      }
      return compareInstant(a, b);
    };
  }
  throw new ValueError("invalid-construction", `${what} needs an ordered scalar domain`);
}

function extreme<T extends CanValue>(
  domain: ReadonlyArray<T>,
  what: "min" | "max",
  better: (cmp: number) => boolean,
): T | null {
  const items = requireArray<T>(domain, `${what} domain`);
  if (items.length === 0) {
    return null;
  }
  const head: unknown = items[0];
  const compare = comparatorFor(head, what);
  let best = items[0] as T;
  for (const value of items) {
    if (better(compare(value, best))) {
      best = value;
    }
  }
  return best;
}

/** Least element, or null over an empty domain. */
export function min<T extends CanValue>(domain: ReadonlyArray<T>): T | null {
  return extreme(domain, "min", (cmp: number): boolean => cmp < 0);
}

/** Greatest element, or null over an empty domain. */
export function max<T extends CanValue>(domain: ReadonlyArray<T>): T | null {
  return extreme(domain, "max", (cmp: number): boolean => cmp > 0);
}

/**
 * Existential test over a supplied domain with a plain JS predicate.
 * Empty is false; evaluation short-circuits on the first true.
 */
export function any<T>(domain: ReadonlyArray<T>, pred: (item: T) => boolean): boolean {
  const items = requireArray<T>(domain, "any domain");
  if (typeof pred !== "function") {
    throw new ValueError("invalid-construction", "any predicate must be a function");
  }
  for (const value of items) {
    const verdict = pred(value);
    if (typeof verdict !== "boolean") {
      throw new ValueError("invalid-construction", "any predicate must return a boolean");
    }
    if (verdict) {
      return true;
    }
  }
  return false;
}

/**
 * Universal test over a supplied domain with a plain JS predicate.
 * Empty is true; evaluation short-circuits on the first false.
 */
export function all<T>(domain: ReadonlyArray<T>, pred: (item: T) => boolean): boolean {
  const items = requireArray<T>(domain, "all domain");
  if (typeof pred !== "function") {
    throw new ValueError("invalid-construction", "all predicate must be a function");
  }
  for (const value of items) {
    const verdict = pred(value);
    if (typeof verdict !== "boolean") {
      throw new ValueError("invalid-construction", "all predicate must return a boolean");
    }
    if (!verdict) {
      return false;
    }
  }
  return true;
}

/**
 * First element, or null over an empty domain. Stable ordering of the
 * supplied domain is the checker's requirement, not evaluated here.
 */
export function first<T>(domain: ReadonlyArray<T>): T | null {
  return requireArray<T>(domain, "first domain")[0] ?? null;
}

/**
 * Typed grouping (DESIGN L263): one `{key,items}` group per distinct key
 * under typed equality, groups in first-encounter order, items in encounter
 * order. Null keys form exactly one group. Groups, item lists, and the outer
 * list are frozen.
 */
export function group<T extends CanValue, K extends CanValue>(
  domain: ReadonlyArray<T>,
  keyFn: (item: T) => K,
): ReadonlyArray<{ readonly key: K; readonly items: ReadonlyArray<T> }> {
  const items = requireArray<T>(domain, "group domain");
  if (typeof keyFn !== "function") {
    throw new ValueError("invalid-construction", "group key function must be a function");
  }
  const groups: Array<{ key: K; items: T[] }> = [];
  for (const item of items) {
    const key = keyFn(item);
    let found: { key: K; items: T[] } | undefined;
    for (const candidate of groups) {
      if (equalValue("", candidate.key, key)) {
        found = candidate;
        break;
      }
    }
    if (found === undefined) {
      groups.push({ key, items: [item] });
    } else {
      found.items.push(item);
    }
  }
  return Object.freeze(
    groups.map((entry) => Object.freeze({ key: entry.key, items: Object.freeze([...entry.items]) })),
  );
}
