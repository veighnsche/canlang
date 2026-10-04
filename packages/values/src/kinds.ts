import type {
  ActionRef,
  CanValue,
  DateValue,
  DatetimeValue,
  DeliveryRef,
  FileValue,
  MemberRef,
  MoneyValue,
  RecordRef,
  UnionValue,
  UserRef,
} from "../../contracts/src/values.js";
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

/** Checked money-tag constructor. Pins no scale here; money.ts owns arithmetic. */
export function makeMoney(minor: bigint, currency: string): MoneyValue {
  if (typeof minor !== "bigint") {
    throw new ValueError("invalid-construction", "money minor must be a bigint");
  }
  if (!isCurrencyShape(currency)) {
    throw new ValueError("invalid-construction", `invalid currency code shape: ${currency}`);
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

/** Checked UTC-instant constructor. `ms` is integer milliseconds since the epoch. */
export function makeDatetime(ms: bigint): DatetimeValue {
  if (typeof ms !== "bigint") {
    throw new ValueError("invalid-construction", "datetime ms must be a bigint");
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
    if (!isRecordRef(binding)) {
      throw new ValueError("invalid-construction", `action binding ${param} must be a record ref`);
    }
    frozen[param] = freezeCopy(binding);
  }
  const value: ActionRef = { kind: "action", target, bindings: freeze(frozen) };
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
