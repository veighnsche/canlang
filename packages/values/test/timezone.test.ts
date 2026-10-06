import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatetimeValue, DateValue } from "@canlang/contracts/values";
import type { Fold } from "../src/timezone.js";
import { assertTimezone, isTimezone, local_date, local_instant } from "../src/timezone.js";
import { date, datetime, durationBetween } from "../src/temporal.js";
import { ValueError } from "../src/errors.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ValueError);
    return error.code;
  }
  assert.fail("expected a ValueError");
}

describe("IANA zone validation", () => {
  it("accepts canonical IANA ids from host ICU", () => {
    for (const zone of ["UTC", "America/New_York", "Pacific/Auckland", "Asia/Kathmandu", "Europe/London"]) {
      assert.equal(isTimezone(zone), true, zone);
      assert.equal(assertTimezone(zone), zone);
    }
  });

  it("rejects unknown zones and non-text values", () => {
    for (const zone of ["", "Mars/Olympus_Mons", "America/New York", "UTC+05:45", "GMT+14:00", "123"]) {
      assert.equal(isTimezone(zone), false, zone);
      assert.equal(codeOf(() => assertTimezone(zone)), "invalid-construction", zone);
    }
    assert.equal(isTimezone(null), false);
    assert.equal(isTimezone(5), false);
    assert.equal(isTimezone(undefined), false);
  });
});

describe("local_date UTC store and configured-zone display", () => {
  it("renders the same instant on different civil dates per zone", () => {
    const stored = datetime("2026-01-15T18:15:00Z");
    assert.deepEqual(local_date(stored, "UTC"), date("2026-01-15"));
    assert.deepEqual(local_date(stored, "America/New_York"), date("2026-01-15"));
    assert.deepEqual(local_date(stored, "Pacific/Auckland"), date("2026-01-16"));
    assert.deepEqual(local_date(stored, "Asia/Kathmandu"), date("2026-01-16"));
  });

  it("shows the US-evening instant on the previous New York date", () => {
    const stored = datetime("2026-10-04T00:30:00Z");
    assert.deepEqual(local_date(stored, "UTC"), date("2026-10-04"));
    assert.deepEqual(local_date(stored, "America/New_York"), date("2026-10-03"));
    assert.deepEqual(local_date(stored, "Pacific/Auckland"), date("2026-10-04"));
    assert.deepEqual(local_date(stored, "Asia/Kathmandu"), date("2026-10-04"));
  });

  it("returns frozen dates and validates inputs", () => {
    const out = local_date(datetime("2026-10-04T12:00:00Z"), "UTC");
    assert.ok(Object.isFrozen(out));
    assert.equal(codeOf(() => local_date(datetime("2026-10-04T12:00:00Z"), "Mars/Olympus_Mons")), "invalid-construction");
    assert.equal(
      codeOf(() => local_date(date("2026-10-04") as unknown as DatetimeValue, "UTC")),
      "invalid-construction",
    );
  });
});

describe("local_instant unambiguous times", () => {
  it("resolves UTC wall clocks directly", () => {
    assert.deepEqual(local_instant(date("2026-10-04"), "12:00", "UTC", "earlier").ms, 1791115200000n);
    assert.deepEqual(local_instant(date("2026-10-04"), "12:00:30", "UTC", "earlier").ms, 1791115230000n);
    assert.deepEqual(local_instant(date("2026-10-04"), "00:00", "UTC", "earlier").ms, 1791072000000n);
  });

  it("resolves fixed and seasonal offsets (Kathmandu +5:45, NY EST/EDT)", () => {
    assert.deepEqual(local_instant(date("2026-01-15"), "12:00", "Asia/Kathmandu", "earlier").ms, 1768457700000n);
    assert.deepEqual(local_instant(date("2026-01-15"), "12:00", "America/New_York", "earlier").ms, 1768496400000n);
    assert.deepEqual(local_instant(date("2026-07-15"), "12:00", "America/New_York", "earlier").ms, 1784131200000n);
  });

  it("resolves southern-hemisphere seasons (Auckland NZDT/NZST)", () => {
    assert.deepEqual(local_instant(date("2026-01-15"), "12:00", "Pacific/Auckland", "earlier").ms, 1768431600000n);
    assert.deepEqual(local_instant(date("2026-07-15"), "12:00", "Pacific/Auckland", "earlier").ms, 1784073600000n);
  });

  it("treats fold as immaterial for unambiguous times", () => {
    const earlier = local_instant(date("2026-07-15"), "12:00", "America/New_York", "earlier");
    const later = local_instant(date("2026-07-15"), "12:00", "America/New_York", "later");
    assert.deepEqual(earlier.ms, later.ms);
    assert.ok(Object.isFrozen(earlier));
  });
});

describe("local_instant DST gap", () => {
  it("fails America/New_York 2026-03-08 02:30 under both folds", () => {
    assert.equal(codeOf(() => local_instant(date("2026-03-08"), "02:30", "America/New_York", "earlier")), "nonexistent-time");
    assert.equal(codeOf(() => local_instant(date("2026-03-08"), "02:30", "America/New_York", "later")), "nonexistent-time");
    assert.equal(codeOf(() => local_instant(date("2026-03-08"), "02:00", "America/New_York", "earlier")), "nonexistent-time");
    assert.equal(codeOf(() => local_instant(date("2026-03-08"), "02:59:59", "America/New_York", "later")), "nonexistent-time");
  });

  it("resolves the instants on either side of the spring gap", () => {
    assert.deepEqual(local_instant(date("2026-03-08"), "01:59:59", "America/New_York", "earlier").ms, 1772953199000n);
    assert.deepEqual(local_instant(date("2026-03-08"), "03:00", "America/New_York", "earlier").ms, 1772953200000n);
    const before = local_instant(date("2026-03-08"), "01:59", "America/New_York", "earlier");
    const after = local_instant(date("2026-03-08"), "03:00", "America/New_York", "earlier");
    assert.equal(durationBetween(after, before), 60000n);
  });

  it("fails the southern-hemisphere spring gap (Auckland 2026-09-27 02:30)", () => {
    assert.equal(codeOf(() => local_instant(date("2026-09-27"), "02:30", "Pacific/Auckland", "earlier")), "nonexistent-time");
    assert.deepEqual(local_instant(date("2026-09-27"), "01:59", "Pacific/Auckland", "earlier").ms, 1790431140000n);
    assert.deepEqual(local_instant(date("2026-09-27"), "03:00", "Pacific/Auckland", "earlier").ms, 1790431200000n);
  });
});

describe("local_instant fold", () => {
  it("constructs both branches of America/New_York 2026-11-01 01:30", () => {
    const earlier = local_instant(date("2026-11-01"), "01:30", "America/New_York", "earlier");
    const later = local_instant(date("2026-11-01"), "01:30", "America/New_York", "later");
    assert.deepEqual(earlier.ms, 1793511000000n);
    assert.deepEqual(later.ms, 1793514600000n);
    assert.equal(durationBetween(later, earlier), 3600000n);
  });

  it("constructs both branches of the Auckland autumn fold (2026-04-05 02:30)", () => {
    const earlier = local_instant(date("2026-04-05"), "02:30", "Pacific/Auckland", "earlier");
    const later = local_instant(date("2026-04-05"), "02:30", "Pacific/Auckland", "later");
    assert.deepEqual(earlier.ms, 1775309400000n);
    assert.deepEqual(later.ms, 1775313000000n);
    assert.equal(durationBetween(later, earlier), 3600000n);
  });

  it("keeps neighboring unambiguous times single-valued", () => {
    assert.deepEqual(local_instant(date("2026-11-01"), "00:30", "America/New_York", "earlier").ms, 1793507400000n);
    assert.deepEqual(
      local_instant(date("2026-11-01"), "00:30", "America/New_York", "later").ms,
      1793507400000n,
    );
  });
});

describe("local_instant input validation", () => {
  it("rejects malformed wall-clock text", () => {
    for (const time of ["2:30", "12:60", "24:00", "12:00:60", "1200", "12:00:0", "", "12:00:00:00"]) {
      assert.equal(codeOf(() => local_instant(date("2026-10-04"), time, "UTC", "earlier")), "invalid-construction", time);
    }
  });

  it("requires an explicit earlier|later fold", () => {
    assert.equal(
      codeOf(() => local_instant(date("2026-10-04"), "12:00", "UTC", undefined as unknown as Fold)),
      "fold-required",
    );
    assert.equal(
      codeOf(() => local_instant(date("2026-10-04"), "12:00", "UTC", null as unknown as Fold)),
      "fold-required",
    );
    assert.equal(
      codeOf(() => local_instant(date("2026-10-04"), "12:00", "UTC", "first" as unknown as Fold)),
      "invalid-construction",
    );
  });

  it("rejects mistyped date and zone inputs", () => {
    assert.equal(
      codeOf(() => local_instant(datetime("2026-10-04T12:00:00Z") as unknown as DateValue, "12:00", "UTC", "earlier")),
      "invalid-construction",
    );
    assert.equal(codeOf(() => local_instant(date("2026-10-04"), "12:00", "Mars/Olympus_Mons", "earlier")), "invalid-construction");
  });
});

describe("local round-trips", () => {
  it("recovers the civil date from a resolved instant in every covered zone", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["2026-01-15", "12:00", "UTC"],
      ["2026-01-15", "00:00", "America/New_York"],
      ["2026-07-15", "23:59:59", "America/New_York"],
      ["2026-01-15", "12:00", "Pacific/Auckland"],
      ["2026-07-15", "08:30", "Pacific/Auckland"],
      ["2026-01-15", "12:00", "Asia/Kathmandu"],
      ["2024-02-29", "18:45:30", "Asia/Kathmandu"],
      ["2026-11-01", "00:30", "America/New_York"],
      ["2026-03-08", "03:30", "America/New_York"],
    ];
    for (const [day, time, zone] of cases) {
      for (const fold of ["earlier", "later"] as const) {
        const resolved = local_instant(date(day), time, zone, fold);
        assert.deepEqual(local_date(resolved, zone), date(day), `${day} ${time} ${zone} ${fold}`);
      }
    }
  });

  it("round-trips fold branches back to the same wall clock date", () => {
    for (const fold of ["earlier", "later"] as const) {
      const ny = local_instant(date("2026-11-01"), "01:30", "America/New_York", fold);
      assert.deepEqual(local_date(ny, "America/New_York"), date("2026-11-01"));
      const ak = local_instant(date("2026-04-05"), "02:30", "Pacific/Auckland", fold);
      assert.deepEqual(local_date(ak, "Pacific/Auckland"), date("2026-04-05"));
    }
  });
});
