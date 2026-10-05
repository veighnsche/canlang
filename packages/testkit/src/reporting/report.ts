import {
  CONTRACTS_VERSION,
  EXAMPLES_CONTRACT_VERSION,
  type ExampleCaseResult,
  type ExampleReport,
  type ExampleSummary,
  type SequenceStepResult,
  type TableRowResult,
} from "@canlang/contracts";

export interface ReportBuilder {
  addCase(result: ExampleCaseResult): void;
  build(): ExampleReport;
}

/**
 * B3 I2: 1-based `.can` position a failure maps to. Mirrors the sourcemap
 * `lookup` output shape (`@canlang/cloudflare` runtime).
 */
export interface FailureLocation {
  readonly source: string;
  /** 1-based source line. */
  readonly line: number;
  /** 1-based source column. */
  readonly column: number;
}

/** Render a failure location as `source:line:column`. */
export function formatFailureLocation(location: FailureLocation): string {
  return `${location.source}:${location.line}:${location.column}`;
}

/** Row/step results eligible for a mapped failure location. */
export type FailureEntry = TableRowResult | SequenceStepResult;

/**
 * B3 I2: return a copy of a failure entry with the mapped `.can` location
 * appended to `detail`. Additive only: the contracts report types carry no
 * location field, so the location rides the human/machine `detail` string;
 * entries without a location pass through `addCase` untouched.
 */
export function withFailureLocation<T extends FailureEntry>(
  entry: T,
  location: FailureLocation,
): T {
  const suffix = ` (at ${formatFailureLocation(location)})`;
  const detail = entry.detail === undefined ? `failure${suffix}` : `${entry.detail}${suffix}`;
  return { ...entry, detail };
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
