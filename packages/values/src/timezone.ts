/**
 * Lane 02 timezone resolution: IANA validation plus the `local_date` and
 * `local_instant` builtins over host ICU zone data.
 *
 * Normative: DESIGN.md L223-224 (civil date of an instant; fold-required
 * ambiguous times, nonexistent times fail), L252 (signatures), L221 (the
 * language version pins zone data and calendar semantics); REQUIREMENTS.md
 * L185 (UTC store, configured-timezone display).
 *
 * Zone data comes from the host ICU via Intl.DateTimeFormat; the pinned
 * workerd/ICU runtime (L7-owned pin) is what makes this deterministic.
 * Vectors therefore stick to long-stable transitions (United States DST
 * rules stable since 2007, Kathmandu +5:45 fixed since 1986, Auckland
 * DST rules stable since 2007) and avoid far-future or recently-changed
 * transitions.
 *
 * `local_instant` resolves wall-clock ambiguity by round-trip probing: for
 * several probe offsets around the desired local time it reconstructs a
 * candidate instant and keeps the candidates whose zone rendering round-trips
 * exactly. Zero candidates = DST gap (nonexistent-time); one = unambiguous
 * (fold accepted but immaterial); two = fold (earlier|later selects).
 */

import type { DatetimeValue, DateValue } from "../../contracts/src/values.js";
import { ValueError } from "./errors.js";
import { isDatetime, isDateValue, makeDate, makeDatetime } from "./kinds.js";
import { assertDatetimeInRange, dateToEpochDays } from "./temporal.js";

/** Fold selector for ambiguous local times. */
export type Fold = "earlier" | "later";

/** Validated `HH:MM[:SS]` time; this closed shape exists only for local_instant. */
interface WallTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Cached Intl formatters per validated zone id. Pure given pinned ICU. */
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const instantFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * IANA zone guard. Validation is membership in the host ICU zone database
 * (Intl throws RangeError otherwise). Case-insensitive per Intl
 * canonicalization; the input string itself is kept as the value.
 */
export function isTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Asserts IANA membership, failing with invalid-construction otherwise. */
export function assertTimezone(zone: string): string {
  if (!isTimezone(zone)) {
    throw new ValueError("invalid-construction", `invalid IANA timezone: ${String(zone)}`);
  }
  return zone;
}

function dateFormatter(zone: string): Intl.DateTimeFormat {
  const cached = dateFormatters.get(zone);
  if (cached !== undefined) {
    return cached;
  }
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  dateFormatters.set(zone, created);
  return created;
}

function instantFormatter(zone: string): Intl.DateTimeFormat {
  const cached = instantFormatters.get(zone);
  if (cached !== undefined) {
    return cached;
  }
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  instantFormatters.set(zone, created);
  return created;
}

function readPart(parts: ReadonlyArray<Intl.DateTimeFormatPart>, type: string): number {
  for (const part of parts) {
    if (part.type === type) {
      const parsed = Number(part.value);
      if (!Number.isInteger(parsed)) {
        throw new ValueError("invalid-construction", `unparseable ${type} from zone rendering`);
      }
      return parsed;
    }
  }
  throw new ValueError("invalid-construction", `missing ${type} in zone rendering`);
}

/**
 * `local_date(value:datetime, zone:timezone) -> date`: civil date of an
 * instant in the pinned IANA zone. Changes neither the instant nor any
 * business timezone.
 */
export function local_date(value: DatetimeValue, zone: string): DateValue {
  if (!isDatetime(value)) {
    throw new ValueError("invalid-construction", "local_date value must be a datetime");
  }
  assertTimezone(zone);
  assertDatetimeInRange(value.ms);
  const parts = dateFormatter(zone).formatToParts(new Date(Number(value.ms)));
  const year = readPart(parts, "year");
  const month = readPart(parts, "month");
  const day = readPart(parts, "day");
  if (year < 1 || year > 9999) {
    throw new ValueError("out-of-range", "civil date outside 0001-9999 in this zone");
  }
  return makeDate(year, month, day);
}

function parseWallTime(time: string): WallTime {
  if (typeof time !== "string") {
    throw new ValueError("invalid-construction", "local_instant time must be text");
  }
  const match = TIME_RE.exec(time);
  if (match === null) {
    throw new ValueError("invalid-construction", `invalid time text (want HH:MM[:SS]): ${time}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new ValueError("invalid-construction", `invalid time of day: ${time}`);
  }
  return { hour, minute, second };
}

interface ZoneWall {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function renderWall(ms: bigint, zone: string): ZoneWall {
  const parts = instantFormatter(zone).formatToParts(new Date(Number(ms)));
  return {
    year: readPart(parts, "year"),
    month: readPart(parts, "month"),
    day: readPart(parts, "day"),
    hour: readPart(parts, "hour"),
    minute: readPart(parts, "minute"),
    second: readPart(parts, "second"),
  };
}

/** Pure civil reconstruction of rendered parts as epoch seconds. */
function wallToEpochSeconds(wall: ZoneWall): bigint {
  const civil = makeDate(wall.year, wall.month, wall.day);
  return (
    BigInt(dateToEpochDays(civil)) * 86400n +
    BigInt(wall.hour * 3600 + wall.minute * 60 + wall.second)
  );
}

/**
 * Zone offset in whole seconds at the given instant: rendered wall clock
 * minus the instant itself. Second precision (covers historical LMT offsets
 * with nonzero seconds).
 */
function offsetAtSeconds(instantMs: bigint, zone: string): bigint {
  const instantSec = instantMs / 1000n;
  const wallSec = wallToEpochSeconds(renderWall(instantMs, zone));
  return wallSec - instantSec;
}

/**
 * `local_instant(date:date, time:text, zone:timezone, fold:enum) -> datetime`:
 * resolves a wall-clock time in a pinned IANA zone. `fold` is required and
 * must be `earlier` or `later`; it selects the branch for ambiguous
 * (folded) local times and is accepted-but-immaterial for unambiguous ones.
 * Nonexistent local times (DST gaps) fail with nonexistent-time.
 */
export function local_instant(date: DateValue, time: string, zone: string, fold: Fold): DatetimeValue {
  if (!isDateValue(date)) {
    throw new ValueError("invalid-construction", "local_instant date must be a date value");
  }
  const wall = parseWallTime(time);
  assertTimezone(zone);
  const selector: unknown = fold;
  if (selector === undefined || selector === null) {
    throw new ValueError("fold-required", "local_instant requires fold=earlier|later");
  }
  if (selector !== "earlier" && selector !== "later") {
    throw new ValueError("invalid-construction", `invalid fold (want earlier|later): ${String(selector)}`);
  }

  const targetSec =
    BigInt(dateToEpochDays(date)) * 86400n + BigInt(wall.hour * 3600 + wall.minute * 60 + wall.second);

  const probes = [0n, -86400n, 86400n, -172800n, 172800n];
  const candidates = new Set<bigint>();
  for (const delta of probes) {
    const offset = offsetAtSeconds((targetSec + delta) * 1000n, zone);
    const candidate = targetSec - offset;
    if (candidate + offsetAtSeconds(candidate * 1000n, zone) === targetSec) {
      candidates.add(candidate);
    }
  }

  const ordered = [...candidates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (ordered.length === 0) {
    throw new ValueError("nonexistent-time", "local time does not exist in this zone (DST gap)");
  }
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) {
    throw new ValueError("nonexistent-time", "local time does not exist in this zone (DST gap)");
  }
  const chosen = selector === "earlier" ? first : last;
  return makeDatetime(assertDatetimeInRange(chosen * 1000n));
}
