import {
  CONTRACTS_VERSION,
  EXAMPLES_CONTRACT_VERSION,
  type ExampleCaseResult,
  type ExampleReport,
  type ExampleSummary,
} from "@canlang/contracts";

export interface ReportBuilder {
  addCase(result: ExampleCaseResult): void;
  build(): ExampleReport;
}

/**
 * Assembles one machine-readable report. The summary is always computed from
 * the added cases (never trusted from input); `startedAt` is captured at
 * creation and `finishedAt` at build.
 */
export function createReport(artifact: { digest: string; sourceRevision: string }): ReportBuilder {
  const startedAt = new Date().toISOString();
  const cases: ExampleCaseResult[] = [];
  return {
    addCase(result: ExampleCaseResult): void {
      cases.push(result);
    },
    build(): ExampleReport {
      const summary: ExampleSummary = {
        total: 0,
        passed: 0,
        failed: 0,
        setupFailed: 0,
        unsupported: 0,
      };
      for (const result of cases) {
        const units = result.kind === "table" ? result.rows : result.steps;
        for (const unit of units) {
          summary.total += 1;
          switch (unit.outcome) {
            case "passed":
              summary.passed += 1;
              break;
            case "failed":
              summary.failed += 1;
              break;
            case "setup-failed":
              summary.setupFailed += 1;
              break;
            case "unsupported":
              summary.unsupported += 1;
              break;
          }
        }
      }
      return {
        contractsVersion: CONTRACTS_VERSION,
        examplesVersion: EXAMPLES_CONTRACT_VERSION,
        artifact: { ...artifact },
        startedAt,
        finishedAt: new Date().toISOString(),
        cases: [...cases],
        summary,
      };
    },
  };
}
