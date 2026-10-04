/**
 * Lane 02 temporal values: date/datetime checked constructors, calendar
 * builtins (add_days, add_months, date_year, weekday, dates), half-open
 * overlaps, pure-bigint duration arithmetic, datetime/duration operators,
 * and the DESIGN §13 temporal lowering helpers.
 *
 * Normative: DESIGN.md L111 (representations), L194-200 (operator matrix),
 * L211 (checked integral arithmetic, sub-ms rejection, supported range),
 * L219-224 (calendar builtins, month-end clamp, half-open dates, fold/gap),
 * L228 (checked ctors, duration suffixes), L250-254/L261/L269 (signatures);
 * REQUIREMENTS.md L185-186 (UTC instants, half-open reservations, helpers).
 *
 * Representation (lane-02 decision R1): date = frozen {kind,year,month,day};
 * datetime = frozen {kind, ms:bigint} UTC; duration = bigint ms. Can ints are
 * bigint, so int-typed params/results (days, months, year, weekday, limit)
 * are bigint at this boundary.
 *
 * Decided here (no normative bound stated): datetime range = every ms whose
 * UTC civil date falls in 0001-9999, i.e. [DATETIME_MIN_MS, DATETIME_MAX_MS];
 * duration arithmetic is int64-checked (DESIGN L211 "checked at the result
 * boundary, including signed-minimum negation" applies to integral duration
 * arithmetic; duration literals "overflow fails" per L228). Duration/duration
 * and decimal-duration mixed ops are NOT here (sibling slice owns them).
 *
 * Calendar logic is pure proleptic-Gregorian (Hinnant algorithms); no Date
 * math is used for calendar computation. Zone resolution lives in
 * timezone.ts; that module imports the shared civil helpers below.
 */

import type { DateValue, DatetimeValue } from "../../contracts/src/values.js";
import { ValueError } from "./errors.js";
import { isDatetime, isDateValue, makeDate, makeDatetime } from "./kinds.js";

/** Milliseconds per civil day. A Can day is exactly 24h (DESIGN L228). */
const MS_PER_DAY = 86400000n;

/** Signed 64-bit bounds. Durations are int64-checked (see header). */
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

/**
 * First representable instant: 0001-01-01T00:00:00.000Z.
 * daysFromCivil(1,1,1) = -719162, so -719162 * 86400000.
 */
export const DATETIME_MIN_MS: bigint = -62135596800000n;

/**
 * Last representable instant: 9999-12-31T23:59:59.999Z.
 * (daysFromCivil(9999,12,31) + 1) * 86400000 - 1; verified in tests against
 * the civil algorithms rather than hardcoded derivation.
 */
export const DATETIME_MAX_MS: bigint = 253402300799999n;

// ---------------------------------------------------------------------------
// Pure proleptic-Gregorian civil algorithms (Hinnant). No Date math.
// ---------------------------------------------------------------------------

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

/** Days from 1970-01-01 (Unix epoch) to the given civil date. */
function daysFromCivil(year: number, month: number, day: number): number {
  const yAdj = month <= 2 ? year - 1 : year;
  const era = Math.floor(yAdj / 400);
  const yoe = yAdj - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of daysFromCivil. Caller must keep the result in 0001-9999. */
function civilFromDays(z: number): { year: number; month: number; day: number } {
  const z2 = z + 719468;
  const era = Math.floor(z2 / 146097);
  const doe = z2 - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { year: y + (m <= 2 ? 1 : 0), month: m, day: d };
}

/**
 * Epoch days of a validated date. Shared with timezone.ts (wall-clock
 * reconstruction); pure civil math, no Date use.
 */
export function dateToEpochDays(value: DateValue): number {
  if (!isDateValue(value)) {
    throw new ValueError("invalid-construction", "expected a date value");
  }
  return daysFromCivil(value.year, value.month, value.day);
}

/** Civil date of epoch days. Range-checked to 0001-9999. */
export function epochDaysToDate(days: number): DateValue {
  if (!Number.isInteger(days)) {
    throw new ValueError("invalid-construction", "epoch days must be an integer");
  }
  const parts = civilFromDays(days);
  if (parts.year < 1 || parts.year > 9999) {
    throw new ValueError("out-of-range", "civil date outside 0001-9999");
  }
  return makeDate(parts.year, parts.month, parts.day);
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function requireDate(value: unknown, what: string): DateValue {
  if (!isDateValue(value)) {
    throw new ValueError("invalid-construction", `${what} must be a date value`);
  }
  return value;
}

function requireDatetime(value: unknown, what: string): DatetimeValue {
  if (!isDatetime(value)) {
    throw new ValueError("invalid-construction", `${what} must be a datetime value`);
  }
  return value;
}

function requireDuration(value: unknown, what: string): bigint {
  if (typeof value !== "bigint") {
    throw new ValueError("invalid-construction", `${what} must be a duration (bigint ms)`);
  }
  return value;
}

function requireInt(value: unknown, what: string): bigint {
  if (typeof value !== "bigint") {
    throw new ValueError("invalid-construction", `${what} must be an int (bigint)`);
  }
  return value;
}

function checkInt64(value: bigint, what: string): bigint {
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new ValueError("overflow", `${what} overflows int64`);
  }
  return value;
}

/** Range-checks ms against the decided 0001-9999 UTC range. */
export function assertDatetimeInRange(ms: bigint): bigint {
  if (ms < DATETIME_MIN_MS || ms > DATETIME_MAX_MS) {
    throw new ValueError("out-of-range", "datetime outside the supported 0001-9999 range");
  }
  return ms;
}

// ---------------------------------------------------------------------------
// Checked constructors: date(text), datetime(text)
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Checked `date(text)` constructor: strict YYYY-MM-DD, proleptic Gregorian
 * years 0001-9999. Malformed text fails; year 0000 fails as out-of-range.
 */
export function date(value: string): DateValue {
  if (typeof value !== "string") {
    throw new ValueError("invalid-construction", "date() requires text");
  }
  const match = DATE_RE.exec(value);
  if (match === null) {
    throw new ValueError("invalid-construction", `invalid date text: ${value}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999) {
    throw new ValueError("out-of-range", `date year outside 0001-9999: ${value}`);
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new ValueError("invalid-construction", `invalid civil date: ${value}`);
  }
  return makeDate(year, month, day);
}

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|([+-])(\d{2}):(\d{2}))$/;

/**
 * Checked `datetime(text)` constructor: RFC 3339 instant with an explicit
 * numeric or Zulu offset (offset colon required). Fractional seconds are
 * accepted at any precision but nonzero sub-millisecond digits are rejected
 * rather than truncated (DESIGN L211). Leap second 60 is rejected. Years are
 * 0001-9999 and the resulting instant must lie in the supported range.
 */
export function datetime(value: string): DatetimeValue {
  if (typeof value !== "string") {
    throw new ValueError("invalid-construction", "datetime() requires text");
  }
  const match = DATETIME_RE.exec(value);
  if (match === null) {
    throw new ValueError("invalid-construction", `invalid datetime text: ${value}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7];
  const zone = match[8] ?? "";
  const sign = match[9];
  const offHour = match[10] === undefined ? 0 : Number(match[10]);
  const offMinute = match[11] === undefined ? 0 : Number(match[11]);

  if (year < 1 || year > 9999) {
    throw new ValueError("out-of-range", `datetime year outside 0001-9999: ${value}`);
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new ValueError("invalid-construction", `invalid calendar date: ${value}`);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new ValueError("invalid-construction", `invalid time of day: ${value}`);
  }
  if (zone === "") {
    throw new ValueError("invalid-construction", `missing zone offset: ${value}`);
  }
  if (sign !== undefined && (offHour > 23 || offMinute > 59)) {
    throw new ValueError("invalid-construction", `invalid zone offset: ${value}`);
  }

  let ms = 0;
  if (fraction !== undefined) {
    const milliDigits = fraction.slice(0, 3).padEnd(3, "0");
    ms = Number(milliDigits);
    const subMs = fraction.slice(3);
    if (!/^[0]*$/.test(subMs)) {
      throw new ValueError("invalid-construction", `nonzero sub-millisecond fraction rejected: ${value}`);
    }
  }

  const days = BigInt(daysFromCivil(year, month, day));
  let instant = days * MS_PER_DAY + BigInt(hour * 3600000 + minute * 60000 + second * 1000 + ms);
  if (sign !== undefined) {
    const offsetMs = BigInt((offHour * 60 + offMinute) * 60000);
    instant = sign === "+" ? instant - offsetMs : instant + offsetMs;
  }
  assertDatetimeInRange(instant);
  return makeDatetime(instant);
}

// ---------------------------------------------------------------------------
// Calendar builtins: add_days, add_months, date_year, weekday, dates
// ---------------------------------------------------------------------------

const EPOCH_DAYS_MIN = -719162;
const EPOCH_DAYS_MAX = 2932896;

/**
 * `add_days(value:date, days:int) -> date`: calendar-day arithmetic.
 * Overflow past 0001-9999 fails.
 */
export function add_days(value: DateValue, days: bigint): DateValue {
  const start = requireDate(value, "add_days value");
  const delta = requireInt(days, "add_days days");
  const target = BigInt(daysFromCivil(start.year, start.month, start.day)) + delta;
  if (target < BigInt(EPOCH_DAYS_MIN) || target > BigInt(EPOCH_DAYS_MAX)) {
    throw new ValueError("out-of-range", "add_days result outside 0001-9999");
  }
  return epochDaysToDate(Number(target));
}

function floorDivMod(index: bigint): { year: number; monthIndex: number } {
  let yearBase = index / 12n;
  let monthIndex = index % 12n;
  if (monthIndex < 0n) {
    monthIndex += 12n;
    yearBase -= 1n;
  }
  return { year: Number(yearBase + 1n), monthIndex: Number(monthIndex) };
}

/**
 * `add_months(value:date, months:int) -> date`: signed Gregorian calendar
 * months with stateless target-month clamping of the original day. Recurrence
 * callers keep the original anchor and add the absolute cycle offset
 * (Jan 31 +1 = Feb 28/29; the same anchor +2 = Mar 31). Overflow fails.
 */
export function add_months(value: DateValue, months: bigint): DateValue {
  const start = requireDate(value, "add_months value");
  const delta = requireInt(months, "add_months months");
  const startIndex = BigInt((start.year - 1) * 12 + (start.month - 1));
  const target = startIndex + delta;
  const minIndex = 0n;
  const maxIndex = BigInt(9999 * 12 - 1);
  if (target < minIndex || target > maxIndex) {
    throw new ValueError("out-of-range", "add_months result outside 0001-9999");
  }
  const { year, monthIndex } = floorDivMod(target);
  const month = monthIndex + 1;
  const day = Math.min(start.day, daysInMonth(year, month));
  return makeDate(year, month, day);
}

/** `date_year(value:date) -> int`: Gregorian year. */
export function date_year(value: DateValue): bigint {
  return BigInt(requireDate(value, "date_year value").year);
}

/** `weekday(value:date) -> int`: ISO Monday=1 through Sunday=7. */
export function weekday(value: DateValue): bigint {
  const current = requireDate(value, "weekday value");
  const days = daysFromCivil(current.year, current.month, current.day);
  const normalized = ((days + 3) % 7 + 7) % 7;
  return BigInt(normalized + 1);
}

/**
 * `dates(from:date, until:date, limit:int) -> date[]`: consecutive dates in
 * ascending half-open [from,until) order. Equal endpoints give []; reversed
 * endpoints or a nonpositive limit fail; more than `limit` dates fails with
 * limit-exceeded (the limit is a work bound, never truncation). Inclusive
 * business intervals pass add_days(until,1) explicitly.
 */
export function dates(from: DateValue, until: DateValue, limit: bigint): ReadonlyArray<DateValue> {
  const start = requireDate(from, "dates from");
  const end = requireDate(until, "dates until");
  const bound = requireInt(limit, "dates limit");
  const fromDays = daysFromCivil(start.year, start.month, start.day);
  const untilDays = daysFromCivil(end.year, end.month, end.day);
  const count = untilDays - fromDays;
  if (count < 0) {
    throw new ValueError("invalid-construction", "dates from must not be after until");
  }
  if (count === 0) {
    return Object.freeze([]);
  }
  if (bound <= 0n) {
    throw new ValueError("invalid-construction", "dates limit must be positive");
  }
  if (BigInt(count) > bound) {
    throw new ValueError("limit-exceeded", `dates range of ${count} exceeds limit ${bound}`);
  }
  const out: DateValue[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(epochDaysToDate(fromDays + index));
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// overlaps: half-open range intersection, all-date or all-datetime
// ---------------------------------------------------------------------------

function isAllDates(values: ReadonlyArray<unknown>): values is readonly [DateValue, DateValue, DateValue, DateValue] {
  return values.length === 4 && values.every(isDateValue);
}

function isAllDatetimes(
  values: ReadonlyArray<unknown>,
): values is readonly [DatetimeValue, DatetimeValue, DatetimeValue, DatetimeValue] {
  return values.length === 4 && values.every(isDatetime);
}

/**
 * `overlaps(aStart,aEnd,bStart,bEnd) -> bool`: nonempty half-open range
 * intersection. Accepts either four dates or four datetimes; empty or
 * reversed ranges return false, mixed or mistyped inputs fail.
 */
export function overlaps(
  aStart: DateValue,
  aEnd: DateValue,
  bStart: DateValue,
  bEnd: DateValue,
): boolean;
export function overlaps(
  aStart: DatetimeValue,
  aEnd: DatetimeValue,
  bStart: DatetimeValue,
  bEnd: DatetimeValue,
): boolean;
export function overlaps(aStart: unknown, aEnd: unknown, bStart: unknown, bEnd: unknown): boolean {
  const args = [aStart, aEnd, bStart, bEnd];
  if (isAllDates(args)) {
    const [as, ae, bs, be] = args;
    if (compareDate(as, ae) >= 0 || compareDate(bs, be) >= 0) {
      return false;
    }
    const latestStart = compareDate(as, bs) >= 0 ? as : bs;
    const earliestEnd = compareDate(ae, be) <= 0 ? ae : be;
    return compareDate(latestStart, earliestEnd) < 0;
  }
  if (isAllDatetimes(args)) {
    const [as, ae, bs, be] = args;
    if (as.ms >= ae.ms || bs.ms >= be.ms) {
      return false;
    }
    const latestStart = as.ms >= bs.ms ? as.ms : bs.ms;
    const earliestEnd = ae.ms <= be.ms ? ae.ms : be.ms;
    return latestStart < earliestEnd;
  }
  throw new ValueError("invalid-construction", "overlaps requires four dates or four datetimes");
}

// ---------------------------------------------------------------------------
// Pure-bigint duration arithmetic (int64-checked; see header)
// ---------------------------------------------------------------------------

/**
 * Duration + duration. Also the duration/duration arm of the §13 addDuration
 * helper; the duration/datetime arms are overloads below.
 */
export function addDuration(a: bigint, b: bigint): bigint;
export function addDuration(a: bigint, b: DatetimeValue): DatetimeValue;
export function addDuration(a: DatetimeValue, b: bigint): DatetimeValue;
export function addDuration(a: unknown, b: unknown): bigint | DatetimeValue {
  if (typeof a === "bigint" && typeof b === "bigint") {
    return checkInt64(a + b, "duration addition");
  }
  if (typeof a === "bigint" && isDatetime(b)) {
    return makeDatetime(assertDatetimeInRange(a + b.ms));
  }
  if (isDatetime(a) && typeof b === "bigint") {
    return makeDatetime(assertDatetimeInRange(a.ms + b));
  }
  throw new ValueError(
    "invalid-construction",
    "addDuration requires (duration,duration), (duration,datetime) or (datetime,duration)",
  );
}

/** Duration - duration, and datetime - duration. */
export function subtractDuration(a: bigint, b: bigint): bigint;
export function subtractDuration(a: DatetimeValue, b: bigint): DatetimeValue;
export function subtractDuration(a: unknown, b: unknown): bigint | DatetimeValue {
  if (typeof a === "bigint" && typeof b === "bigint") {
    return checkInt64(a - b, "duration subtraction");
  }
  if (isDatetime(a) && typeof b === "bigint") {
    return makeDatetime(assertDatetimeInRange(a.ms - b));
  }
  throw new ValueError("invalid-construction", "subtractDuration requires (duration,duration) or (datetime,duration)");
}

/** Duration * int (either order at the Can level; commutative here). */
export function multiplyDuration(a: bigint, b: bigint): bigint {
  const left = requireDuration(a, "duration factor");
  const right = requireInt(b, "duration factor");
  return checkInt64(left * right, "duration multiplication");
}

/**
 * Duration / int: must be an exact millisecond count or fail with inexact;
 * a zero divisor fails with division-by-zero.
 */
export function divideDurationByInt(a: bigint, b: bigint): bigint {
  const left = requireDuration(a, "duration dividend");
  const right = requireInt(b, "duration divisor");
  if (right === 0n) {
    throw new ValueError("division-by-zero", "duration division by zero");
  }
  if (left % right !== 0n) {
    throw new ValueError("inexact", "duration division must be exact milliseconds");
  }
  return checkInt64(left / right, "duration division");
}

/**
 * Duration % duration: remainder with trunc-toward-zero semantics (dividend's
 * sign); a zero divisor fails.
 */
export function remainderDuration(a: bigint, b: bigint): bigint {
  const left = requireDuration(a, "duration dividend");
  const right = requireDuration(b, "duration divisor");
  if (right === 0n) {
    throw new ValueError("division-by-zero", "duration remainder by zero");
  }
  return checkInt64(left % right, "duration remainder");
}

/** Duration comparator: -1, 0, or 1. */
export function compareDuration(a: bigint, b: bigint): number {
  const left = requireDuration(a, "duration comparison");
  const right = requireDuration(b, "duration comparison");
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Unary duration negation; signed-minimum negation overflows. */
export function negateDuration(value: bigint): bigint {
  const current = requireDuration(value, "duration negation");
  return checkInt64(-current, "duration negation");
}

/** Duration absolute value; signed-minimum abs overflows. */
export function absDuration(value: bigint): bigint {
  const current = requireDuration(value, "duration abs");
  return checkInt64(current < 0n ? -current : current, "duration abs");
}

// ---------------------------------------------------------------------------
// Datetime operators and §13 helpers
// ---------------------------------------------------------------------------

/**
 * §13 durationBetween(a,b): datetime - datetime as `a - b`, matching the
 * binary `-` operator the helper lowers.
 */
export function durationBetween(a: DatetimeValue, b: DatetimeValue): bigint {
  const left = requireDatetime(a, "durationBetween");
  const right = requireDatetime(b, "durationBetween");
  return checkInt64(left.ms - right.ms, "datetime subtraction");
}

/** §13 compareInstant(a,b): -1, 0, or 1 by UTC instant. */
export function compareInstant(a: DatetimeValue, b: DatetimeValue): number {
  const left = requireDatetime(a, "compareInstant");
  const right = requireDatetime(b, "compareInstant");
  if (left.ms < right.ms) return -1;
  if (left.ms > right.ms) return 1;
  return 0;
}

/** §13 compareDate(a,b): -1, 0, or 1 by civil date. */
export function compareDate(a: DateValue, b: DateValue): number {
  const left = requireDate(a, "compareDate");
  const right = requireDate(b, "compareDate");
  if (left.year !== right.year) return left.year < right.year ? -1 : 1;
  if (left.month !== right.month) return left.month < right.month ? -1 : 1;
  if (left.day !== right.day) return left.day < right.day ? -1 : 1;
  return 0;
}
