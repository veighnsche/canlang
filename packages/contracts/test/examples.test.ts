import { describe, expect, it } from "vitest";
import {
  CONTRACTS_VERSION,
  EXAMPLES_CONTRACT_VERSION,
  type ExampleReport,
  type ReportValue,
  type SequenceStepResult,
  type TableRowResult,
} from "../src/index.js";

const report: ExampleReport = {
  contractsVersion: CONTRACTS_VERSION,
  examplesVersion: EXAMPLES_CONTRACT_VERSION,
  artifact: { digest: "test-artifact-fixture", sourceRevision: "b06d873" },
  startedAt: "2026-10-04T00:00:00.000Z",
  finishedAt: "2026-10-04T00:00:01.000Z",
  cases: [
    {
      kind: "table",
      operation: "TeamTasks.Todo.update",
      rows: [
        {
          rowIndex: 0,
          caller: { account: "self", team: "current", roles: ["members"], authenticated: true },
          outcome: "passed",
        },
        {
          rowIndex: 1,
          caller: { account: "public", team: null, roles: [], authenticated: false },
          outcome: "passed",
          rejection: { error: "forbidden", sideEffectsAbsent: true },
        },
      ],
    },
  ],
  summary: { total: 2, passed: 2, failed: 0, setupFailed: 0, unsupported: 0 },
};

describe("examples contracts", () => {
  it("pins version constants at 1", () => {
    expect(CONTRACTS_VERSION).toBe(1);
    expect(EXAMPLES_CONTRACT_VERSION).toBe(1);
  });

  it("round-trips a report through JSON with a consistent summary", () => {
    const revived = JSON.parse(JSON.stringify(report)) as ExampleReport;
    expect(revived).toEqual(report);
    const rows = revived.cases.flatMap(
      (c): readonly (TableRowResult | SequenceStepResult)[] =>
        c.kind === "table" ? c.rows : c.steps,
    );
    expect(revived.summary.total).toBe(rows.length);
    expect(revived.summary.passed).toBe(rows.filter((r) => r.outcome === "passed").length);
  });

  it("keeps report values JSON-safe", () => {
    const value: ReportValue = { n: 1, s: "1 taak", list: [true, null] };
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });

  it("records expected rejections with a no-side-effects proof", () => {
    const first = report.cases[0];
    expect(first?.kind).toBe("table");
    if (first?.kind !== "table") {
      expect.unreachable("first case must be a table");
    }
    expect(first.rows[1]?.rejection).toEqual({ error: "forbidden", sideEffectsAbsent: true });
  });
});
