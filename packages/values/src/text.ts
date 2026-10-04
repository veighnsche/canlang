import type { DateValue } from "../../contracts/src/values.js";
import { ValueError } from "./errors.js";
import { isDateValue } from "./kinds.js";

/**
 * Unicode scalar text operations (DESIGN L265/L267): full default case
 * conversion, pinned White_Space trim, exact case-sensitive matching and
 * scalar-counted length. No normalization or locale tailoring is implicit.
 */

function requireText(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new ValueError("invalid-construction", `${what} must be text`);
  }
  return value;
}

/** Full default Unicode lowercase conversion (native toLowerCase). Result is text. */
export function lower(value: string): string {
  return requireText(value, "lower").toLowerCase();
}

/** Full default Unicode uppercase conversion (native toUpperCase). Result is text. */
export function upper(value: string): string {
  return requireText(value, "upper").toUpperCase();
}

const TRIM_PATTERN = /^[\p{White_Space}]+|[\p{White_Space}]+$/gu;

/** Removes the pinned Unicode White_Space property at both ends. Result is text. */
export function trim(value: string): string {
  TRIM_PATTERN.lastIndex = 0;
  return requireText(value, "trim").replace(TRIM_PATTERN, "");
}

/** Exact case-sensitive scalar substring test. */
export function contains(value: string, needle: string): boolean {
  return requireText(value, "contains").includes(requireText(needle, "contains needle"));
}

/** Exact case-sensitive scalar prefix test. */
export function starts_with(value: string, prefix: string): boolean {
  return requireText(value, "starts_with").startsWith(requireText(prefix, "starts_with prefix"));
}

/**
 * Joins strings in domain order with the separator.
 * An empty domain yields empty text.
 */
export function join(values: ReadonlyArray<string>, separator: string): string {
  requireText(separator, "join separator");
  if (!Array.isArray(values)) {
    throw new ValueError("invalid-construction", "join values must be an array");
  }
  const parts: string[] = [];
  for (const [index, item] of values.entries()) {
    parts.push(requireText(item, `join values[${index}]`));
  }
  return parts.join(separator);
}

/**
 * Counts Unicode scalars (code points, not UTF-16 units): astral characters
 * count 1. Lone surrogates each count 1, matching string iteration.
 * Returns a Can int (bigint).
 */
export function scalarLength(value: string): bigint {
  return BigInt([...requireText(value, "scalarLength")].length);
}

/** Splits text into its Unicode scalars (one string per code point). Frozen. */
export function scalarChars(value: string): ReadonlyArray<string> {
  return Object.freeze([...requireText(value, "scalarChars")]);
}

/**
 * Compares two texts by Unicode scalar order (-1/0/1). Uses code-point
 * iteration so astral planes order above the BMP; performs no normalization
 * or locale tailoring. Total order over well-formed and lone-surrogate text.
 */
export function compareScalar(a: string, b: string): -1 | 0 | 1 {
  const left = requireText(a, "compareScalar");
  const right = requireText(b, "compareScalar");
  const li = left[Symbol.iterator]();
  const ri = right[Symbol.iterator]();
  for (;;) {
    const ln = li.next();
    const rn = ri.next();
    if (ln.done === true || rn.done === true) {
      if (ln.done === rn.done) return 0;
      return ln.done === true ? -1 : 1;
    }
    const lcp = ln.value.codePointAt(0) as number;
    const rcp = rn.value.codePointAt(0) as number;
    if (lcp < rcp) return -1;
    if (lcp > rcp) return 1;
  }
}

const PLACEHOLDER_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Plain-template Display values (DESIGN L231/L267): decimal/money/datetime excluded. */
export type PlainDisplayValue = string | boolean | bigint | DateValue;

function renderPlainValue(key: string, value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString(10);
  if (isDateValue(value)) {
    const year = String(value.year).padStart(4, "0");
    const month = String(value.month).padStart(2, "0");
    const day = String(value.day).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  throw new ValueError(
    "invalid-construction",
    `format placeholder {${key}} is outside the plain Display set (text/bool/int/date/enum spelling)`,
  );
}

/**
 * Plain `format(template, values)` (DESIGN L267): named `{key}` substitutions
 * with doubled literal braces. All placeholders must exist; malformed or
 * missing placeholders fail. Extra object fields are allowed. No locale
 * conversion or executable formatting. Enum spellings arrive as strings and
 * pass through; validated string-likes likewise.
 */
export function formatPlain(template: string, values: Readonly<Record<string, unknown>>): string {
  requireText(template, "format template");
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new ValueError("invalid-construction", "format values must be an object");
  }
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i] as string;
    if (ch === "{") {
      const next = template[i + 1] as string | undefined;
      if (next === "{") {
        out += "{";
        i += 2;
        continue;
      }
      const close = template.indexOf("}", i + 1);
      if (close < 0) {
        throw new ValueError("invalid-construction", "format template has an unterminated placeholder");
      }
      const key = template.slice(i + 1, close);
      if (!PLACEHOLDER_KEY.test(key)) {
        throw new ValueError("invalid-construction", `format template has a malformed placeholder: {${key}}`);
      }
      if (!Object.hasOwn(values, key)) {
        throw new ValueError("invalid-construction", `format template is missing value for {${key}}`);
      }
      out += renderPlainValue(key, (values as Record<string, unknown>)[key]);
      i = close + 1;
      continue;
    }
    if (ch === "}") {
      const next = template[i + 1] as string | undefined;
      if (next === "}") {
        out += "}";
        i += 2;
        continue;
      }
      throw new ValueError("invalid-construction", "format template has an unmatched closing brace");
    }
    out += ch;
    i += 1;
  }
  return out;
}
