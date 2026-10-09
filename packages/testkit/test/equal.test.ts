import { describe, expect, it } from "vitest";
import { diffReportValues } from "../src/assertions/equal.js";

describe("diffReportValues", () => {
  it("reports no mismatch for deeply equal values", () => {
    expect(diffReportValues("r", { a: [1, "x", null] }, { a: [1, "x", null] })).toEqual([]);
  });

  it("paths scalar, length, and key mismatches", () => {
    expect(diffReportValues("n", 1, 2)).toEqual([{ observation: "n", expected: 1, actual: 2 }]);
    expect(diffReportValues("l", [1, 2], [1])).toEqual([
      { observation: "l.length", expected: 2, actual: 1 },
    ]);
    expect(diffReportValues("o", { a: 1 }, {})).toEqual([
      { observation: "o.a", expected: 1, actual: null },
    ]);
    expect(diffReportValues("o", {}, { b: true })).toEqual([
      { observation: "o.b", expected: null, actual: true },
    ]);
  });

  it("never equates a missing key with an explicit null", () => {
    expect(diffReportValues("o", { a: null }, {})).toEqual([
      { observation: "o.a", expected: null, actual: null },
    ]);
    expect(diffReportValues("o", {}, { a: null })).toEqual([
      { observation: "o.a", expected: null, actual: null },
    ]);
    expect(diffReportValues("o", { a: null }, { a: null })).toEqual([]);
  });

  it("flags type changes as one mismatch at the path", () => {
    expect(diffReportValues("t", "1", 1)).toEqual([{ observation: "t", expected: "1", actual: 1 }]);
    expect(diffReportValues("t", [1], { "0": 1 })).toEqual([
      { observation: "t", expected: [1], actual: { "0": 1 } },
    ]);
  });

  it("keeps bigint mismatches serializable without changing comparison", () => {
    const same = diffReportValues("quantity", 8n as never, 8n as never);
    expect(same).toEqual([]);
    const mismatch = diffReportValues("quantity", 8n as never, 9n as never);
    expect(mismatch).toEqual([{ observation: "quantity", expected: { $bigint: "8" }, actual: { $bigint: "9" } }]);
    expect(() => JSON.stringify(mismatch)).not.toThrow();
  });
});
