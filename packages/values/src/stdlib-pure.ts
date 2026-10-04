/**
 * Lane 02 pure stdlib dispatchers: the `sum`/`abs`/`app_url`/`action`/`format` slice.
 *
 * Normative: DESIGN.md L147 (action bindings carry identity AND expected
 * version), L215-269 (builtin boundaries: L226 app_url, L231-242 signatures,
 * L257/L269 action, L261 money-sum currency rules, L263 abs overflow).
 *
 * Boundaries recorded here:
 * - `sum`/`abs` dispatch by static element tag / runtime kind onto the typed
 *   helpers (array/int/decimal/money/temporal); record-query evaluation of
 *   these builtins is lane 03's (see array.ts).
 * - Durations share the int runtime tag (bigint); absDuration is behaviorally
 *   identical to absInt (both int64-check the magnitude; INT64_MIN overflows
 *   in both), so `abs` routes every bigint through absInt.
 * - `app_url` takes the deployment origin as injected trusted context (fixed
 *   trusted context per DESIGN L226, never a request Host); it grants no
 *   access — route/record/recipient checks stay mandatory.
 * - `action` only packages an already-validated (target, bindings) pair;
 *   static target/canonicity validation (canonical enabled user mutation,
 *   owner, exact protected-record coverage) is lane-01's.
 * - `format` resolves its overload on the first argument: a text template
 *   routes to formatPlain, a message descriptor (via isMessageDescriptor)
 *   routes to formatMessage; any other first argument — or a second argument
 *   of the wrong shape for the detected overload — is `invalid-construction`.
 */

import type { ActionRef, DecimalValue, MoneyValue, RecordRef } from "../../contracts/src/values.js";
import { sumDecimal, sumDuration, sumInt, sumMoney } from "./array.js";
import type { Decimal } from "./decimal.js";
import { absDecimal, isDecimal } from "./decimal.js";
import { ValueError } from "./errors.js";
import { isMessageDescriptor, type MessageDescriptor } from "./icu.js";
import { absInt } from "./int.js";
import { isMoney, isRecordRef, makeActionRef } from "./kinds.js";
import { formatMessage, type FormatMessageOptions, type FormattedMessage } from "./locale.js";
import { absMoney } from "./money.js";
import { formatPlain } from "./text.js";

/** The closed static element tag selecting a `sum` typed helper. */
export type SumElement = "int" | "decimal" | "duration" | "money";

export function sum(domain: ReadonlyArray<bigint>, element: "int" | "duration"): bigint;
export function sum(domain: ReadonlyArray<DecimalValue>, element: "decimal"): DecimalValue;
export function sum(
  domain: ReadonlyArray<MoneyValue>,
  element: "money",
  currency?: string,
): MoneyValue;
export function sum(
  domain: ReadonlyArray<unknown>,
  element: string,
  currency?: string,
): bigint | DecimalValue | MoneyValue;
/**
 * `sum` builtin dispatcher (DESIGN L236-237/L261): routes to
 * sumInt/sumDecimal/sumDuration/sumMoney by the static element tag. Money
 * keeps sumMoney's currency rules (explicit currency, else nonempty-inferred);
 * element/kind mismatches are `invalid-construction`. A currency argument on
 * a non-money element is `invalid-construction` (exact arities, DESIGN L269).
 */
export function sum(
  domain: ReadonlyArray<unknown>,
  element: string,
  currency?: string,
): bigint | DecimalValue | MoneyValue {
  if (element !== "int" && element !== "decimal" && element !== "duration" && element !== "money") {
    throw new ValueError(
      "invalid-construction",
      `sum element must be "int", "decimal", "duration" or "money"`,
    );
  }
  if (!Array.isArray(domain)) {
    throw new ValueError("invalid-construction", "sum domain must be an array");
  }
  if (element !== "money" && currency !== undefined) {
    throw new ValueError("invalid-construction", "sum currency applies only to money elements");
  }
  switch (element) {
    case "int":
      return sumInt(domain as ReadonlyArray<bigint>);
    case "decimal":
      return sumDecimal(domain as ReadonlyArray<Decimal>);
    case "duration":
      return sumDuration(domain as ReadonlyArray<bigint>);
    case "money":
      return sumMoney(domain as ReadonlyArray<MoneyValue>, currency);
    default:
      throw new ValueError(
        "invalid-construction",
        `sum element must be "int", "decimal", "duration" or "money"`,
      );
  }
}

/**
 * `abs` builtin dispatcher (DESIGN L243/L263): routes by runtime kind —
 * bigint (int/duration share the tag) through absInt, decimal through
 * absDecimal, money through absMoney. Same overflow boundaries as negation.
 * Anything else is `invalid-construction`.
 */
export function abs(value: bigint | DecimalValue | MoneyValue): bigint | DecimalValue | MoneyValue {
  if (typeof value === "bigint") {
    return absInt(value);
  }
  if (isDecimal(value)) {
    return absDecimal(value);
  }
  if (isMoney(value)) {
    return absMoney(value);
  }
  throw new ValueError(
    "invalid-construction",
    "abs needs an int, decimal, duration or money value",
  );
}

const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;
/** Raw ASCII that must be percent-encoded, never literal, in any URL part. */
const RAW_FORBIDDEN = /[\x5c\u0000-\u0020\u007f]/;

function requireWellFormedEncoding(part: string, what: string): void {
  for (let index = 0; index < part.length; index += 1) {
    if (part[index] === "%") {
      const hex = part.slice(index + 1, index + 3);
      if (!HEX_PAIR.test(hex)) {
        throw new ValueError(
          "invalid-construction",
          `app_url ${what} has malformed percent-encoding`,
        );
      }
      index += 2;
    }
  }
}

/**
 * Single-pass %XX decode for ASCII-danger inspection. Multi-byte UTF-8
 * decodes to mojibake, which is fine: only ASCII dangers (separators,
 * controls, dot segments) are inspected, and one pass cannot
 * double-decode ("%252F" yields the literal text "%2F", not "/").
 */
function decodeAsciiEscapes(segment: string): string {
  return segment.replace(/%([0-9A-Fa-f]{2})/g, (_match: string, hex: string): string =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function requireSafePathPart(pathPart: string): void {
  if (!pathPart.startsWith("/") || pathPart.startsWith("//")) {
    throw new ValueError(
      "invalid-construction",
      "app_url path must be app-relative and slash-prefixed",
    );
  }
  if (RAW_FORBIDDEN.test(pathPart)) {
    throw new ValueError(
      "invalid-construction",
      "app_url path must not contain raw backslashes, whitespace or controls",
    );
  }
  requireWellFormedEncoding(pathPart, "path");
  // `@` inside a segment stays path data through WHATWG URL parsing: the
  // enforced leading-`/` plus `//`-rejection above means no segment can
  // ever become authority, so userinfo smuggling is impossible here (the
  // ORIGIN userinfo rejection below is the real one).
  for (const segment of pathPart.split("/")) {
    const decoded = decodeAsciiEscapes(segment);
    if (decoded.includes("/") || decoded.includes("\\")) {
      throw new ValueError("invalid-construction", "app_url path must not carry decoded separators");
    }
    if (/[\u0000-\u001f\u007f]/.test(decoded)) {
      throw new ValueError(
        "invalid-construction",
        "app_url path must not carry decoded controls",
      );
    }
    if (decoded === "." || decoded === "..") {
      throw new ValueError("invalid-construction", "app_url path must not contain dot segments");
    }
  }
}

interface TrustedOrigin {
  readonly base: string;
  readonly prefix: string;
}

/**
 * Validates the injected trusted deployment context: absolute http(s) URL,
 * no userinfo, origin + mount prefix only (no query/fragment). Returns the
 * canonical origin base and the mount prefix ("" at root, else no trailing
 * slash), both in native-URL canonical encoding.
 */
function parseTrustedOrigin(origin: string): TrustedOrigin {
  if (typeof origin !== "string") {
    throw new ValueError("invalid-construction", "app_url origin must be a string");
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ValueError("invalid-construction", "app_url origin must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValueError("invalid-construction", "app_url origin must be http(s)");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ValueError("invalid-construction", "app_url origin must not carry userinfo");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ValueError(
      "invalid-construction",
      "app_url origin must be origin plus mount prefix only",
    );
  }
  const prefix = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return { base: url.origin, prefix };
}

/**
 * `app_url` pure link construction (DESIGN L226/L248) with the native URL
 * class only. Joins one app-relative slash-prefixed path to the injected
 * trusted origin + mount prefix and returns the canonical URL string.
 * Rejects absolute/protocol-relative paths, backslashes, malformed
 * percent-encoding, decoded dot segments/separators/controls, and
 * anything canonicalizing outside the prefix; query/fragment suffixes must
 * be properly encoded. Grants no access.
 */
export function app_url(path: string, origin: string): string {
  if (typeof path !== "string") {
    throw new ValueError("invalid-construction", "app_url path must be a string");
  }
  if (path.includes("\\")) {
    throw new ValueError("invalid-construction", "app_url path must not contain backslashes");
  }
  let pathPart = path;
  let search = "";
  let hash = "";
  const hashIndex = pathPart.indexOf("#");
  if (hashIndex !== -1) {
    hash = pathPart.slice(hashIndex);
    pathPart = pathPart.slice(0, hashIndex);
  }
  const queryIndex = pathPart.indexOf("?");
  if (queryIndex !== -1) {
    search = pathPart.slice(queryIndex);
    pathPart = pathPart.slice(0, queryIndex);
  }
  requireSafePathPart(pathPart);
  for (const [part, what] of [
    [search, "query"],
    [hash, "fragment"],
  ] as const) {
    if (RAW_FORBIDDEN.test(part)) {
      throw new ValueError(
        "invalid-construction",
        `app_url ${what} must be properly encoded`,
      );
    }
    requireWellFormedEncoding(part, what);
  }
  const trusted = parseTrustedOrigin(origin);
  const result = new URL(`${trusted.prefix}${pathPart}${search}${hash}`, `${trusted.base}/`);
  if (result.origin !== trusted.base) {
    throw new ValueError("invalid-construction", "app_url result escaped its origin");
  }
  const pathname = result.pathname;
  if (
    trusted.prefix !== "" &&
    pathname !== trusted.prefix &&
    !pathname.startsWith(`${trusted.prefix}/`)
  ) {
    throw new ValueError("invalid-construction", "app_url result escaped its mount prefix");
  }
  return result.href;
}

/**
 * `action` packaging (DESIGN L147/L257/L269): shapes an already-validated
 * (target, bindings) pair via makeActionRef. The target is non-empty
 * canonical text; every binding is a RecordRef WITH its expected version
 * (DESIGN L147 binds identity AND expected version). Static
 * target/canonicity validation is lane-01's (see header). Returns a frozen
 * ActionRef.
 */
export function action(
  target: string,
  bindings: Readonly<Record<string, RecordRef>>,
): ActionRef {
  if (typeof target !== "string" || target.length === 0) {
    throw new ValueError(
      "invalid-construction",
      "action target must be non-empty canonical text",
    );
  }
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) {
    throw new ValueError("invalid-construction", "action bindings must be a closed record");
  }
  const closed: Record<string, RecordRef> = {};
  for (const [param, binding] of Object.entries(bindings)) {
    // `__proto__` would silently set the prototype instead of an own key
    // on the accumulator below; reject it so the binding is never lost
    // (mirrors the wire decoder; other dunder names are safe own keys).
    if (param === "__proto__") {
      throw new ValueError(
        "invalid-construction",
        'action binding name "__proto__" is reserved',
      );
    }
    if (!isRecordRef(binding)) {
      throw new ValueError(
        "invalid-construction",
        `action binding ${param} must be a record ref`,
      );
    }
    if (binding.version === undefined || typeof binding.version !== "bigint") {
      throw new ValueError(
        "invalid-construction",
        `action binding ${param} must carry its expected version`,
      );
    }
    closed[param] = binding;
  }
  return makeActionRef(target, closed);
}

export function format(
  template: string,
  values: Readonly<Record<string, unknown>>,
): string;
export function format(
  descriptor: MessageDescriptor,
  options: FormatMessageOptions,
): FormattedMessage;
export function format(first: unknown, second: unknown): string | FormattedMessage;
/**
 * `format` builtin dispatcher (DESIGN L231-242/L267/L854): overloads resolve
 * on the first argument — a text template routes to formatPlain, a message
 * descriptor (via isMessageDescriptor) routes to formatMessage. Any other
 * first argument, or a second argument of the wrong shape for the detected
 * overload, is `invalid-construction`.
 */
export function format(first: unknown, second: unknown): string | FormattedMessage {
  if (typeof first === "string") {
    if (typeof second !== "object" || second === null || Array.isArray(second)) {
      throw new ValueError("invalid-construction", "format values must be an object");
    }
    return formatPlain(first, second as Readonly<Record<string, unknown>>);
  }
  if (isMessageDescriptor(first)) {
    if (typeof second !== "object" || second === null || Array.isArray(second)) {
      throw new ValueError("invalid-construction", "formatMessage needs an options object");
    }
    if (!Object.hasOwn(second, "locale")) {
      throw new ValueError("invalid-construction", "formatMessage requires an explicit locale=");
    }
    return formatMessage(first, second as FormatMessageOptions);
  }
  throw new ValueError(
    "invalid-construction",
    "format needs a text template or a message descriptor",
  );
}
