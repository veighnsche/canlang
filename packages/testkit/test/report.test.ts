import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION, EXAMPLES_CONTRACT_VERSION } from "@canlang/contracts";
import { createReport } from "../src/reporting/report.js";

describe("createReport", () => {
  it("computes the summary from added cases", () => {
    const report = createReport({ digest: "d", sourceRevision: "s" });
    report.addCase({
      kind: "table",
      operation: "op",
      rows: [
        {
          rowIndex: 0,
          caller: { account: "a", team: "current", roles: [], authenticated: true },
          outcome: "passed",
        },
        {
          rowIndex: 1,
          caller: { account: "a", team: "current", roles: [], authenticated: true },
          outcome: "setup-failed",
          detail: "bad fixture",
        },
      ],
    });
    report.addCase({
      kind: "sequence",
      operation: "op2",
      steps: [
        { index: 0, step: "assert", outcome: "unsupported", detail: "no engine" },
      ],
    });
    const built = report.build();
    expect(built.contractsVersion).toBe(CONTRACTS_VERSION);
    expect(built.examplesVersion).toBe(EXAMPLES_CONTRACT_VERSION);
    expect(built.summary).toEqual({ total: 3, passed: 1, failed: 0, setupFailed: 1, unsupported: 1 });
    expect(JSON.parse(JSON.stringify(built))).toEqual(built);
  });
});
