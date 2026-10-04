import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatetimeValue, DateValue } from "../../contracts/src/values.js";
import {
  DATETIME_MAX_MS,
  DATETIME_MIN_MS,
  absDuration,
  add_days,
  add_months,
  addDuration,
  compareDate,
  compareDuration,
  compareInstant,
  date,
  date_year,
  datetime,
  dates,
  divideDurationByInt,
  durationBetween,
  multiplyDuration,
  negateDuration,
  overlaps,
  remainderDuration,
  subtractDuration,
  weekday,
} from "../src/temporal.js";
import { makeDate, makeDatetime } from "../src/kinds.js";
import { ValueError } from "../src/errors.js";

/** Runs fn, returning the ValueError code or failing when nothing throws. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ValueError);
    return error.code;
  }
  assert.fail("expected a ValueError");
}

describe("date(text) checked constructor", () => {
  it("accepts strict YYYY-MM-DD including range edges and leap days", () => {
    assert.deepEqual(date("2026-10-04"), { kind: "date", year: 2026, month: 10, day: 4 });
    assert.deepEqual(date("2024-02-29"), { kind: "date", year: 2024, month: 2, day: 29 });
    assert.deepEqual(date("2000-02-29"), { kind: "date", year: 2000, month: 2, day: 29 });
    assert.deepEqual(date("0001-01-01"), { kind: "date", year: 1, month: 1, day: 1 });
    assert.deepEqual(date("9999-12-31"), { kind: "date", year: 9999, month: 12, day: 31 });
    assert.ok(Object.isFrozen(date("2026-10-04")));
  });

  it("rejects impossible or misshapen civil dates", () => {
    const bad = [
      "2023-02-29",
      "1900-02-29",
      "2026-13-01",
      "2026-00-10",
      "2026-01-00",
      "2026-01-32",
      "2026-04-31",
      "2026-1-1",
      "2026/10/04",
      "2026-10-04T00:00:00Z",
      "2026-10-04 ",
      " 2026-10-04",
      "",
      "not-a-date",
    ];
    for (const text of bad) {
      assert.equal(codeOf(() => date(text)), "invalid-construction", text);
    }
  });

  it("reports year 0000 as out-of-range", () => {
    assert.equal(codeOf(() => date("0000-01-01")), "out-of-range");
  });
});

describe("datetime(text) checked constructor", () => {
  it("parses epoch-anchored instants to exact ms", () => {
    assert.deepEqual(datetime("1970-01-01T00:00:00Z"), { kind: "datetime", ms: 0n });
    assert.deepEqual(datetime("1970-01-01T00:00:01Z"), { kind: "datetime", ms: 1000n });
    assert.deepEqual(datetime("1969-12-31T23:59:59Z"), { kind: "datetime", ms: -1000n });
    assert.deepEqual(datetime("1969-12-31T23:59:59.999Z"), { kind: "datetime", ms: -1n });
    assert.deepEqual(datetime("2000-01-01T00:00:00Z"), { kind: "datetime", ms: 946684800000n });
    assert.deepEqual(datetime("2026-10-04T00:00:00Z"), { kind: "datetime", ms: 1791072000000n });
    assert.deepEqual(datetime("2026-10-04T12:34:56.789Z"), { kind: "datetime", ms: 1791117296789n });
    assert.ok(Object.isFrozen(datetime("1970-01-01T00:00:00Z")));
  });

  it("applies numeric offsets and accepts lowercase markers", () => {
    assert.deepEqual(datetime("1970-01-01T01:00:00+01:00").ms, 0n);
    assert.deepEqual(datetime("1969-12-31T19:00:00-05:00").ms, 0n);
    assert.deepEqual(datetime("1970-01-01T05:45:00+05:45").ms, 0n);
    assert.deepEqual(datetime("1970-01-01t00:00:00z").ms, 0n);
    assert.deepEqual(datetime("2000-01-01T05:30:00+05:30").ms, 946684800000n);
  });

  it("accepts fractions only when sub-ms digits are zero", () => {
    assert.deepEqual(datetime("1970-01-01T00:00:00.5Z").ms, 500n);
    assert.deepEqual(datetime("1970-01-01T00:00:00.000000Z").ms, 0n);
    assert.deepEqual(datetime("1970-01-01T00:00:00.123000Z").ms, 123n);
    assert.deepEqual(datetime("1970-01-01T00:00:01.000Z").ms, 1000n);
    assert.deepEqual(datetime("1970-01-01T00:00:00.1+00:00").ms, 100n);
    for (const text of [
      "1970-01-01T00:00:00.0001Z",
      "1970-01-01T00:00:00.123456Z",
      "1970-01-01T00:00:00.999999999Z",
      "1970-01-01T00:00:00.Z",
    ]) {
      assert.equal(codeOf(() => datetime(text)), "invalid-construction", text);
    }
  });

  it("rejects malformed instants", () => {
    const bad = [
      "2026-10-04T12:00:00",
      "2026-10-04 12:00:00Z",
      "2026-10-04T12:00:00+0100",
      "2026-10-04T24:00:00Z",
      "2026-10-04T12:60:00Z",
      "2026-10-04T12:00:60Z",
      "2026-13-01T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-10-04T12:00:00+24:00",
      "2026-10-04T12:00:00+00:60",
      "",
    ];
    for (const text of bad) {
      assert.equal(codeOf(() => datetime(text)), "invalid-construction", text);
    }
  });

  it("enforces the decided 0001-9999 ms range", () => {
    assert.deepEqual(datetime("0001-01-01T00:00:00Z").ms, DATETIME_MIN_MS);
    assert.deepEqual(datetime("0001-01-01T00:00:00Z").ms, -62135596800000n);
    assert.deepEqual(datetime("9999-12-31T23:59:59.999Z").ms, DATETIME_MAX_MS);
    assert.deepEqual(datetime("9999-12-31T23:59:59.999Z").ms, 253402300799999n);
    assert.equal(codeOf(() => datetime("0000-06-01T00:00:00Z")), "out-of-range");
    assert.equal(codeOf(() => datetime("0001-01-01T00:00:00+00:01")), "out-of-range");
    assert.equal(codeOf(() => datetime("9999-12-31T23:59:59.999-00:01")), "out-of-range");
  });
});

describe("add_days", () => {
  it("adds calendar days across month, year and leap boundaries", () => {
    assert.deepEqual(add_days(date("2026-01-31"), 1n), date("2026-02-01"));
    assert.deepEqual(add_days(date("2026-12-31"), 1n), date("2027-01-01"));
    assert.deepEqual(add_days(date("2026-01-01"), -1n), date("2025-12-31"));
    assert.deepEqual(add_days(date("2024-02-28"), 1n), date("2024-02-29"));
    assert.deepEqual(add_days(date("2024-02-28"), 2n), date("2024-03-01"));
    assert.deepEqual(add_days(date("2023-02-28"), 1n), date("2023-03-01"));
    assert.deepEqual(add_days(date("2026-10-04"), 0n), date("2026-10-04"));
    assert.deepEqual(add_days(date("1970-01-01"), 1791072000000n / 86400000n), date("2026-10-04"));
  });

  it("inverts: add then subtract returns the anchor", () => {
    const cases: ReadonlyArray<readonly [string, bigint]> = [
      ["0001-01-01", 10000n],
      ["1970-01-01", -719162n],
      ["1970-01-01", 2932896n],
      ["2024-02-29", 1000n],
      ["2026-10-04", -5000n],
      ["9999-12-31", -10000n],
    ];
    for (const [anchor, delta] of cases) {
      const moved = add_days(date(anchor), delta);
      assert.deepEqual(add_days(moved, -delta), date(anchor), `${anchor} +/- ${delta}`);
    }
    assert.deepEqual(add_days(add_days(date("2026-03-15"), 45n), -45n), date("2026-03-15"));
    assert.deepEqual(add_days(add_days(date("1970-01-01"), -719162n), 719162n), date("1970-01-01"));
  });

  it("fails past the range edges and on mistyped inputs", () => {
    assert.equal(codeOf(() => add_days(date("9999-12-31"), 1n)), "out-of-range");
    assert.equal(codeOf(() => add_days(date("0001-01-01"), -1n)), "out-of-range");
    assert.equal(codeOf(() => add_days(date("2026-01-01"), 10n ** 18n)), "out-of-range");
    assert.equal(codeOf(() => add_days(date("2026-01-01"), -(10n ** 18n))), "out-of-range");
    assert.equal(
      codeOf(() => add_days(date("2026-01-01"), 5 as unknown as bigint)),
      "invalid-construction",
    );
    assert.equal(
      codeOf(() => add_days({ kind: "date", year: 2026, month: 2, day: 30 }, 1n)),
      "invalid-construction",
    );
  });
});

describe("add_months original-anchor clamping", () => {
  it("clamps Jan 31 to Feb 28/29 and restores Mar 31 from the anchor", () => {
    assert.deepEqual(add_months(date("2026-01-31"), 1n), date("2026-02-28"));
    assert.deepEqual(add_months(date("2024-01-31"), 1n), date("2024-02-29"));
    assert.deepEqual(add_months(date("2026-01-31"), 2n), date("2026-03-31"));
    assert.deepEqual(add_months(date("2024-01-31"), 2n), date("2024-03-31"));
  });

  it("is stateless: chaining from a clamped date does not restore", () => {
    assert.deepEqual(add_months(add_months(date("2026-01-31"), 1n), 1n), date("2026-03-28"));
  });

  it("handles year crossing, negatives, leap days and identity", () => {
    assert.deepEqual(add_months(date("2026-12-15"), 1n), date("2027-01-15"));
    assert.deepEqual(add_months(date("2026-01-15"), -1n), date("2025-12-15"));
    assert.deepEqual(add_months(date("2026-03-31"), -1n), date("2026-02-28"));
    assert.deepEqual(add_months(date("2024-03-31"), -1n), date("2024-02-29"));
    assert.deepEqual(add_months(date("2024-02-29"), 12n), date("2025-02-28"));
    assert.deepEqual(add_months(date("2024-02-29"), 48n), date("2028-02-29"));
    assert.deepEqual(add_months(date("2026-10-04"), 0n), date("2026-10-04"));
    assert.deepEqual(add_months(date("2026-10-04"), 120n), date("2036-10-04"));
  });

  it("fails past the range edges", () => {
    assert.equal(codeOf(() => add_months(date("9999-12-01"), 1n)), "out-of-range");
    assert.equal(codeOf(() => add_months(date("0001-01-01"), -1n)), "out-of-range");
    assert.equal(codeOf(() => add_months(date("2026-01-01"), 10n ** 18n)), "out-of-range");
    assert.equal(
      codeOf(() => add_months(date("2026-01-31"), 1 as unknown as bigint)),
      "invalid-construction",
    );
  });
});

describe("date_year and weekday", () => {
  it("returns the Gregorian year", () => {
    assert.equal(date_year(date("2026-10-04")), 2026n);
    assert.equal(date_year(date("0001-12-31")), 1n);
    assert.equal(date_year(date("9999-01-01")), 9999n);
  });

  it("returns ISO weekday Monday=1 through Sunday=7", () => {
    assert.equal(weekday(date("1970-01-01")), 4n);
    assert.equal(weekday(date("2026-10-04")), 7n);
    assert.equal(weekday(date("2000-01-01")), 6n);
    assert.equal(weekday(date("2024-02-29")), 4n);
    assert.equal(weekday(date("0001-01-01")), 1n);
    assert.equal(weekday(date("9999-12-31")), 5n);
  });
});

describe("dates() half-open enumeration", () => {
  it("enumerates [from,until) ascending as frozen values", () => {
    const out = dates(date("2026-10-01"), date("2026-10-04"), 10n);
    assert.deepEqual(out, [date("2026-10-01"), date("2026-10-02"), date("2026-10-03")]);
    assert.ok(Object.isFrozen(out));
    assert.deepEqual(dates(date("2026-10-01"), date("2026-10-02"), 1n), [date("2026-10-01")]);
    assert.deepEqual(dates(date("2024-02-28"), date("2024-03-02"), 5n), [
      date("2024-02-28"),
      date("2024-02-29"),
      date("2024-03-01"),
    ]);
  });

  it("treats the limit as a failing work bound, never truncation", () => {
    assert.deepEqual(dates(date("2026-10-04"), date("2026-10-04"), 10n), []);
    assert.deepEqual(dates(date("2026-10-01"), date("2026-10-04"), 3n).length, 3);
    assert.equal(codeOf(() => dates(date("2026-10-01"), date("2026-10-04"), 2n)), "limit-exceeded");
    assert.equal(codeOf(() => dates(date("2026-10-01"), date("2026-10-04"), 0n)), "invalid-construction");
    assert.equal(codeOf(() => dates(date("2026-10-01"), date("2026-10-04"), -1n)), "invalid-construction");
    assert.equal(
      codeOf(() => dates(date("2026-10-04"), date("2026-10-01"), 10n)),
      "invalid-construction",
    );
  });
});

describe("overlaps half-open ranges", () => {
  it("tests date ranges with touching-but-disjoint edges", () => {
    const d = (text: string) => date(text);
    assert.equal(overlaps(d("2026-10-01"), d("2026-10-05"), d("2026-10-03"), d("2026-10-07")), true);
    assert.equal(overlaps(d("2026-10-01"), d("2026-10-10"), d("2026-10-03"), d("2026-10-05")), true);
    assert.equal(overlaps(d("2026-10-01"), d("2026-10-05"), d("2026-10-05"), d("2026-10-07")), false);
    assert.equal(overlaps(d("2026-10-05"), d("2026-10-07"), d("2026-10-01"), d("2026-10-05")), false);
    assert.equal(overlaps(d("2026-10-01"), d("2026-10-02"), d("2026-10-03"), d("2026-10-04")), false);
    assert.equal(overlaps(d("2026-10-01"), d("2026-10-01"), d("2026-10-01"), d("2026-10-02")), false);
    assert.equal(overlaps(d("2026-10-05"), d("2026-10-01"), d("2026-10-01"), d("2026-10-02")), false);
    assert.equal(overlaps(d("2026-10-01"), d("2026-10-02"), d("2026-10-02"), d("2026-10-01")), false);
  });

  it("tests datetime reservation ranges at ms precision", () => {
    const t = (text: string) => datetime(text);
    assert.equal(
      overlaps(
        t("2026-10-04T10:00:00Z"),
        t("2026-10-04T11:00:00Z"),
        t("2026-10-04T10:30:00Z"),
        t("2026-10-04T12:00:00Z"),
      ),
      true,
    );
    assert.equal(
      overlaps(
        t("2026-10-04T10:00:00Z"),
        t("2026-10-04T11:00:00Z"),
        t("2026-10-04T11:00:00Z"),
        t("2026-10-04T12:00:00Z"),
      ),
      false,
    );
    assert.equal(
      overlaps(
        t("2026-10-04T10:00:00Z"),
        t("2026-10-04T11:00:00.001Z"),
        t("2026-10-04T11:00:00Z"),
        t("2026-10-04T12:00:00Z"),
      ),
      true,
    );
    assert.equal(
      overlaps(
        t("2026-10-04T10:00:00Z"),
        t("2026-10-04T10:00:00Z"),
        t("2026-10-04T09:00:00Z"),
        t("2026-10-04T11:00:00Z"),
      ),
      false,
    );
    assert.equal(
      overlaps(
        t("2026-10-04T12:00:00Z"),
        t("2026-10-04T10:00:00Z"),
        t("2026-10-04T09:00:00Z"),
        t("2026-10-04T13:00:00Z"),
      ),
      false,
    );
  });

  it("rejects mixed date/datetime ranges", () => {
    assert.equal(
      codeOf(() =>
        overlaps(
          date("2026-10-01"),
          date("2026-10-02"),
          datetime("2026-10-01T00:00:00Z") as unknown as DateValue,
          date("2026-10-02"),
        ),
      ),
      "invalid-construction",
    );
    assert.equal(
      codeOf(() =>
        overlaps(
          "2026-10-01" as unknown as never,
          date("2026-10-02"),
          date("2026-10-01"),
          date("2026-10-02"),
        ),
      ),
      "invalid-construction",
    );
  });
});

describe("pure-bigint duration arithmetic", () => {
  const MAX = 2n ** 63n - 1n;
  const MIN = -(2n ** 63n);

  it("adds and subtracts with int64 boundary checks", () => {
    assert.equal(addDuration(5n, 7n), 12n);
    assert.equal(addDuration(-5n, 7n), 2n);
    assert.equal(subtractDuration(5n, 7n), -2n);
    assert.equal(addDuration(MAX, 0n), MAX);
    assert.equal(codeOf(() => addDuration(MAX, 1n)), "overflow");
    assert.equal(codeOf(() => subtractDuration(MIN, 1n)), "overflow");
    assert.equal(codeOf(() => addDuration(MAX, MAX)), "overflow");
  });

  it("multiplies by int with overflow checks", () => {
    assert.equal(multiplyDuration(5000n, 3n), 15000n);
    assert.equal(multiplyDuration(-5000n, 3n), -15000n);
    assert.equal(multiplyDuration(5000n, 0n), 0n);
    assert.equal(codeOf(() => multiplyDuration(MAX, 2n)), "overflow");
    assert.equal(codeOf(() => multiplyDuration(MIN, -1n)), "overflow");
  });

  it("divides by int only when exact", () => {
    assert.equal(divideDurationByInt(6000n, 3n), 2000n);
    assert.equal(divideDurationByInt(-6000n, 3n), -2000n);
    assert.equal(divideDurationByInt(6000n, -3n), -2000n);
    assert.equal(divideDurationByInt(0n, 7n), 0n);
    assert.equal(codeOf(() => divideDurationByInt(5000n, 3n)), "inexact");
    assert.equal(codeOf(() => divideDurationByInt(-5000n, 3n)), "inexact");
    assert.equal(codeOf(() => divideDurationByInt(5000n, 0n)), "division-by-zero");
    assert.equal(codeOf(() => divideDurationByInt(MIN, -1n)), "overflow");
  });

  it("takes remainders with the dividend's sign", () => {
    assert.equal(remainderDuration(7000n, 3000n), 1000n);
    assert.equal(remainderDuration(-7000n, 3000n), -1000n);
    assert.equal(remainderDuration(7000n, -3000n), 1000n);
    assert.equal(remainderDuration(-7000n, -3000n), -1000n);
    assert.equal(codeOf(() => remainderDuration(7000n, 0n)), "division-by-zero");
  });

  it("compares, negates and takes abs with signed-minimum checks", () => {
    assert.equal(compareDuration(1n, 2n), -1);
    assert.equal(compareDuration(2n, 2n), 0);
    assert.equal(compareDuration(3n, 2n), 1);
    assert.equal(negateDuration(5000n), -5000n);
    assert.equal(negateDuration(-5000n), 5000n);
    assert.equal(absDuration(-5000n), 5000n);
    assert.equal(absDuration(5000n), 5000n);
    assert.equal(codeOf(() => negateDuration(MIN)), "overflow");
    assert.equal(codeOf(() => absDuration(MIN)), "overflow");
  });

  it("rejects non-bigint duration operands", () => {
    assert.equal(codeOf(() => addDuration(5 as unknown as bigint, 7n)), "invalid-construction");
    assert.equal(codeOf(() => negateDuration("5" as unknown as bigint)), "invalid-construction");
  });
});

describe("datetime/duration operators and helpers", () => {
  it("adds and subtracts durations in both orders", () => {
    const base = datetime("2026-10-04T12:00:00Z");
    assert.deepEqual(addDuration(base, 3600000n).ms, datetime("2026-10-04T13:00:00Z").ms);
    assert.deepEqual(addDuration(3600000n, base).ms, datetime("2026-10-04T13:00:00Z").ms);
    assert.deepEqual(subtractDuration(base, 3600000n).ms, datetime("2026-10-04T11:00:00Z").ms);
    assert.deepEqual(addDuration(base, -1000n).ms, datetime("2026-10-04T11:59:59Z").ms);
    assert.equal(codeOf(() => addDuration(base, 5 as unknown as bigint)), "invalid-construction");
  });

  it("subtracts datetimes as durationBetween(a,b) = a - b", () => {
    const start = datetime("2026-10-04T10:00:00Z");
    const end = datetime("2026-10-04T12:30:00Z");
    assert.equal(durationBetween(end, start), 9000000n);
    assert.equal(durationBetween(start, end), -9000000n);
    assert.equal(durationBetween(start, start), 0n);
  });

  it("range-checks datetime results", () => {
    assert.equal(codeOf(() => addDuration(makeDatetime(DATETIME_MAX_MS), 1n)), "out-of-range");
    assert.equal(codeOf(() => subtractDuration(makeDatetime(DATETIME_MIN_MS), 1n)), "out-of-range");
    assert.deepEqual(addDuration(makeDatetime(DATETIME_MIN_MS), 1n).ms, DATETIME_MIN_MS + 1n);
  });

  it("compares instants and dates with -1/0/1", () => {
    const a = datetime("2026-10-04T10:00:00Z");
    const b = datetime("2026-10-04T10:00:00.001Z");
    assert.equal(compareInstant(a, b), -1);
    assert.equal(compareInstant(b, a), 1);
    assert.equal(compareInstant(a, datetime("2026-10-04T12:00:00+02:00")), 0);
    assert.equal(compareDate(date("2026-10-01"), date("2026-10-02")), -1);
    assert.equal(compareDate(date("2026-10-02"), date("2026-10-02")), 0);
    assert.equal(compareDate(date("2027-01-01"), date("2026-12-31")), 1);
    assert.equal(
      codeOf(() => compareInstant(a, date("2026-10-04") as unknown as DatetimeValue)),
      "invalid-construction",
    );
    assert.equal(
      codeOf(() => compareDate(date("2026-10-04"), a as unknown as DateValue)),
      "invalid-construction",
    );
  });

  it("satisfies inverse laws between durationBetween and add/subtract", () => {
    const a = datetime("2024-02-29T08:15:30.250Z");
    const b = datetime("2026-10-04T18:45:00Z");
    const forward = durationBetween(b, a);
    assert.deepEqual(addDuration(a, forward).ms, b.ms);
    assert.deepEqual(subtractDuration(b, forward).ms, a.ms);
    const back = durationBetween(a, b);
    assert.equal(back, -forward);
    assert.equal(addDuration(forward, back), 0n);
    assert.equal(compareInstant(a, b), -compareInstant(b, a));
    assert.equal(compareDate(makeDate(2026, 1, 1), makeDate(2026, 1, 2)), -1);
  });
});

describe("calendar cross-checks", () => {
  it("agrees with known epoch-day anchors", () => {
    assert.deepEqual(add_days(date("1970-01-01"), 0n), date("1970-01-01"));
    assert.deepEqual(add_days(date("1970-01-01"), -719162n), date("0001-01-01"));
    assert.deepEqual(add_days(date("1970-01-01"), 2932896n), date("9999-12-31"));
    assert.deepEqual(dates(date("1970-01-01"), date("1970-01-01"), 1n), []);
    assert.equal(weekday(add_days(date("2026-10-04"), 1n)), 1n);
  });

  it("keeps dates() ordering consistent with compareDate", () => {
    const out = dates(date("2026-02-27"), date("2026-03-02"), 10n);
    for (let index = 1; index < out.length; index += 1) {
      const prev = out[index - 1];
      const current = out[index];
      assert.ok(prev !== undefined && current !== undefined);
      assert.equal(compareDate(prev, current), -1);
      assert.deepEqual(add_days(prev, 1n), current);
    }
  });
});
