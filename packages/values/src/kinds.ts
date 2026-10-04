import type {
  ActionRef,
  CanValue,
  DateValue,
  DatetimeValue,
  DeliveryRef,
  FileValue,
  InvocationRef,
  MemberRef,
  MoneyValue,
  RecordRef,
  UnionValue,
  UserRef,
} from "../../contracts/src/values.js";
import { CURRENCY_MINOR_UNITS } from "./currency-data.js";
import { ValueError } from "./errors.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasKind(value: unknown, kind: string): value is Record<string, unknown> {
  return isObject(value) && value["kind"] === kind;
}

function requireId(id: string, what: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new ValueError("invalid-construction", `${what} id must be a non-empty string`);
  }
}

function freeze<T extends object>(value: T): T {
  return Object.freeze(value);
}

/** Freezes a copy one level deep; deeper structures arrive frozen from their makers. */
function freezeCopy<T>(value: T): T {
  if (Array.isArray(value)) return freeze([...value]) as T;
  if (isObject(value)) return freeze({ ...value }) as T;
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** ISO 4217 code shape. Table membership is checked in money.ts (PR2). */
export function isCurrencyShape(code: string): boolean {
  return /^[A-Z]{3}$/.test(code);
}

export function isMoney(value: unknown): value is MoneyValue {
  return (
    hasKind(value, "money") &&
    typeof value["minor"] === "bigint" &&
    typeof value["currency"] === "string" &&
    isCurrencyShape(value["currency"])
  );
}

/**
 * Checked money-tag constructor. Pins no scale here; money.ts owns
 * arithmetic. Makers validate (like makeDate): shape failures are
 * `invalid-construction`, pinned-ISO-table misses are `unknown-currency`
 * (matching the money() builtin). The table import is direct from
 * currency-data.js so this module stays cycle-free (money.ts imports us).
 */
export function makeMoney(minor: bigint, currency: string): MoneyValue {
  if (typeof minor !== "bigint") {
    throw new ValueError("invalid-construction", "money minor must be a bigint");
  }
  if (!isCurrencyShape(currency)) {
    throw new ValueError("invalid-construction", `invalid currency code shape: ${currency}`);
  }
  if (CURRENCY_MINOR_UNITS[currency] === undefined) {
    throw new ValueError("unknown-currency", `unknown currency: ${currency}`);
  }
  const value: MoneyValue = { kind: "money", minor, currency };
  return freeze(value);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

function isValidDateParts(year: unknown, month: unknown, day: unknown): boolean {
  return (
    typeof year === "number" &&
    typeof month === "number" &&
    typeof day === "number" &&
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

export function isDateValue(value: unknown): value is DateValue {
  if (!hasKind(value, "date")) return false;
  return isValidDateParts(value["year"], value["month"], value["day"]);
}

/** Checked civil-date constructor: proleptic Gregorian years 0001-9999. */
export function makeDate(year: number, month: number, day: number): DateValue {
  const parts: ReadonlyArray<readonly [string, number]> = [
    ["year", year],
    ["month", month],
    ["day", day],
  ];
  for (const [label, n] of parts) {
    if (!Number.isInteger(n)) {
      throw new ValueError("invalid-construction", `date ${label} must be an integer`);
    }
  }
  if (!isValidDateParts(year, month, day)) {
    throw new ValueError("invalid-construction", `invalid civil date: ${year}-${month}-${day}`);
  }
  const value: DateValue = { kind: "date", year, month, day };
  return freeze(value);
}

export function isDatetime(value: unknown): value is DatetimeValue {
  return hasKind(value, "datetime") && typeof value["ms"] === "bigint";
}

/**
 * Supported UTC range, mirrored from temporal.ts (duplicated, not imported:
 * temporal.ts imports this module, so an import would cycle). First instant
 * 0001-01-01T00:00:00.000Z through last 9999-12-31T23:59:59.999Z.
 */
const DATETIME_MIN_MS = -62135596800000n;
const DATETIME_MAX_MS = 253402300799999n;

/**
 * Checked UTC-instant constructor. `ms` is integer milliseconds since the
 * epoch, range-checked to 0001-9999 like the datetime() builtin
 * (`out-of-range` outside it; non-bigint is `invalid-construction`).
 */
export function makeDatetime(ms: bigint): DatetimeValue {
  if (typeof ms !== "bigint") {
    throw new ValueError("invalid-construction", "datetime ms must be a bigint");
  }
  if (ms < DATETIME_MIN_MS || ms > DATETIME_MAX_MS) {
    throw new ValueError("out-of-range", "datetime outside the supported 0001-9999 range");
  }
  const value: DatetimeValue = { kind: "datetime", ms };
  return freeze(value);
}

export function isUserRef(value: unknown): value is UserRef {
  return hasKind(value, "user") && isNonEmptyString(value["id"]);
}

export function makeUserRef(id: string): UserRef {
  requireId(id, "user");
  const value: UserRef = { kind: "user", id };
  return freeze(value);
}

export function isMemberRef(value: unknown): value is MemberRef {
  return (
    hasKind(value, "member") &&
    isNonEmptyString(value["id"]) &&
    isUserRef(value["user"]) &&
    isNonEmptyString(value["team"])
  );
}

export function makeMemberRef(id: string, user: UserRef, team: string): MemberRef {
  requireId(id, "member");
  if (!isUserRef(user)) {
    throw new ValueError("invalid-construction", "member user must be a user ref");
  }
  requireId(team, "member team");
  const value: MemberRef = { kind: "member", id, user: freezeCopy(user), team };
  return freeze(value);
}

export function isFileValue(value: unknown): value is FileValue {
  return hasKind(value, "file") && isNonEmptyString(value["id"]);
}

/**
 * File-shaped value: carries identity only. It is neither finalized nor
 * authorized; finalization is lane 4's and authorization lane 3's.
 */
export function makeFileValue(id: string): FileValue {
  requireId(id, "file");
  const value: FileValue = { kind: "file", id };
  return freeze(value);
}

export function isDeliveryRef(value: unknown): value is DeliveryRef {
  return (
    hasKind(value, "delivery") &&
    isNonEmptyString(value["id"]) &&
    isNonEmptyString(value["operation"])
  );
}

/** Delivery association locator. Receipt observation is a runtime read, not this value. */
export function makeDeliveryRef(id: string, operation: string): DeliveryRef {
  requireId(id, "delivery");
  if (typeof operation !== "string" || operation.length === 0) {
    throw new ValueError("invalid-construction", "delivery operation must be non-empty");
  }
  const value: DeliveryRef = { kind: "delivery", id, operation };
  return freeze(value);
}

export function isRecordRef(value: unknown): value is RecordRef {
  return (
    hasKind(value, "ref") &&
    isNonEmptyString(value["model"]) &&
    isNonEmptyString(value["id"]) &&
    (value["version"] === undefined || typeof value["version"] === "bigint")
  );
}

export function makeRecordRef(model: string, id: string, version?: bigint): RecordRef {
  if (typeof model !== "string" || model.length === 0) {
    throw new ValueError("invalid-construction", "record model must be non-empty");
  }
  requireId(id, "record");
  if (version !== undefined && typeof version !== "bigint") {
    throw new ValueError("invalid-construction", "record version must be a bigint");
  }
  const value: RecordRef =
    version === undefined ? { kind: "ref", model, id } : { kind: "ref", model, id, version };
  return freeze(value);
}

export function isActionRef(value: unknown): value is ActionRef {
  if (!hasKind(value, "action") || !isNonEmptyString(value["target"])) return false;
  if (!isObject(value["bindings"])) return false;
  return Object.values(value["bindings"]).every(isRecordRef);
}

/**
 * Action-reference packaging. Static target/canonicity validation belongs to
 * lane 1; this only shapes an already-validated (target, bindings) pair.
 */
export function makeActionRef(target: string, bindings: Record<string, RecordRef>): ActionRef {
  if (typeof target !== "string" || target.length === 0) {
    throw new ValueError("invalid-construction", "action target must be non-empty");
  }
  const frozen: Record<string, RecordRef> = {};
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
      throw new ValueError("invalid-construction", `action binding ${param} must be a record ref`);
    }
    frozen[param] = freezeCopy(binding);
  }
  const value: ActionRef = { kind: "action", target, bindings: freeze(frozen) };
  return freeze(value);
}

export function isInvocationRef(value: unknown): value is InvocationRef {
  if (!hasKind(value, "invocation") || !isNonEmptyString(value["target"])) return false;
  return isObject(value["args"]);
}

/**
 * Invocation packaging (DESIGN §2.2): shapes an already-validated (target,
 * args) pair with DECODED arg values. Static target/canonicity validation
 * is lane-01's; version/completeness enforcement is L3 admission, which
 * owns op schemas — nested record versions are preserved as-present, never
 * required here (args can carry read refs needing only IDs per DESIGN L340).
 */
export function makeInvocation(target: string, args: Record<string, CanValue>): InvocationRef {
  if (typeof target !== "string" || target.length === 0) {
    throw new ValueError("invalid-construction", "invocation target must be non-empty");
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new ValueError("invalid-construction", "invocation args must be a closed record");
  }
  const frozen: Record<string, CanValue> = {};
  for (const [name, arg] of Object.entries(args)) {
    // `__proto__` would silently set the prototype instead of an own key
    // on the accumulator below; reject it so the argument is never lost
    // (mirrors the wire decoder; other dunder names are safe own keys).
    if (name === "__proto__") {
      throw new ValueError("invalid-construction", 'invocation argument name "__proto__" is reserved');
    }
    if (typeof arg === "number") {
      throw new ValueError(
        "invalid-construction",
        `invocation argument ${name} must be a Can value, not a JS number (exact scalars never route through Number)`,
      );
    }
    frozen[name] = freezeCopy(arg);
  }
  const value: InvocationRef = { kind: "invocation", target, args: freeze(frozen) };
  return freeze(value);
}

export function isUnionValue(value: unknown): value is UnionValue {
  return (
    hasKind(value, "union") &&
    isNonEmptyString(value["type"]) &&
    "value" in value
  );
}

export function makeUnionValue(type: string, value: CanValue): UnionValue {
  if (typeof type !== "string" || type.length === 0) {
    throw new ValueError("invalid-construction", "union type must be non-empty");
  }
  const union: UnionValue = { kind: "union", type, value: freezeCopy(value) };
  return freeze(union);
}
