/**
 * Inline-BDD boundary (lane 07): report envelopes for executing COMPILED
 * example artifacts through production admission, plus the `FixtureKind`
 * vocabulary those reports reference. Provisioning-input types arrive with
 * the lane-1 test artifact shape. Types and version constants only; the
 * runner lives in `@canlang/testkit` and consumes the lane-1 test artifact.
 *
 * A fixture/setup failure is reported as `setup-failed` and can never satisfy
 * an expected business rejection. Paths blocked on unlanded producers report
 * `unsupported`, never a pass.
 */
export const EXAMPLES_CONTRACT_VERSION = 1;

/** Test-only recipe kinds (DESIGN §5.1). */
export type FixtureKind = "model" | "user" | "file" | "delivery";

/**
 * JSON-safe report value. Exact values that are not JSON-representable
 * (BigInt, decimal, money, instants) MUST use the lane-2 wire encoding once
 * it lands; until then a row observing one reports `unsupported` rather than
 * coercing it (CONTRACTS.md: never collapse into JS Number).
 */
export type ReportValue =
  | string
  | number
  | boolean
  | null
  | readonly ReportValue[]
  | { readonly [key: string]: ReportValue };

/** Caller identity resolved for one invocation. Opaque IDs only, no grants invented. */
export interface ResolvedCaller {
  /** Deterministic test account ID, or "public" when unauthenticated. */
  account: string;
  /** Which team the call runs against; null for unauthenticated calls. */
  team: "current" | "other" | null;
  /** Canonical role identities actually held. */
  roles: readonly string[];
  authenticated: boolean;
}

export type ExampleOutcome = "passed" | "failed" | "setup-failed" | "unsupported";

export interface ObservationMismatch {
  observation: string;
  expected: ReportValue;
  actual: ReportValue;
}

/** Expected business rejection: exact code plus a no-side-effects proof. */
export interface ExpectedRejection {
  error: string;
  /** True only when domain state, attachments, events and intents are unchanged. */
  sideEffectsAbsent: boolean;
}

export interface TableRowResult {
  rowIndex: number;
  caller: ResolvedCaller;
  outcome: ExampleOutcome;
  /** Present when the row expects values and any observation mismatched. */
  mismatches?: readonly ObservationMismatch[];
  /**
   * Present when the row expects `error(code)`. The runner sets it only on
   * rows whose outcome is `passed` or `failed`; never beside `setup-failed`.
   */
  rejection?: ExpectedRejection;
  /** Human/machine detail for `setup-failed`, `unsupported`, or unexpected errors. */
  detail?: string;
}

export type SequenceStepKind = "call" | "let" | "assert";

export interface SequenceStepResult {
  index: number;
  step: SequenceStepKind;
  /** Canonical operation ID for `call` steps. */
  operation?: string;
  caller?: ResolvedCaller;
  outcome: ExampleOutcome;
  mismatches?: readonly ObservationMismatch[];
  /** Same runner-enforced rule as `TableRowResult.rejection`. */
  rejection?: ExpectedRejection;
  detail?: string;
}

export interface TableCaseResult {
  kind: "table";
  /** Canonical operation ID the table attaches to. */
  operation: string;
  rows: readonly TableRowResult[];
}

export interface SequenceCaseResult {
  kind: "sequence";
  /** Enclosing scenario ID; causes no implicit call. */
  operation: string;
  steps: readonly SequenceStepResult[];
}

export type ExampleCaseResult = TableCaseResult | SequenceCaseResult;

/** Counts computed by the runner; totals are unchecked in these types. */
export interface ExampleSummary {
  total: number;
  passed: number;
  failed: number;
  setupFailed: number;
  unsupported: number;
}

/** Machine-readable result of one example-artifact execution. */
export interface ExampleReport {
  contractsVersion: number;
  examplesVersion: number;
  /** Digest + source revision of the COMPILED test artifact executed. */
  artifact: { digest: string; sourceRevision: string };
  startedAt: string;
  finishedAt: string;
  cases: readonly ExampleCaseResult[];
  summary: ExampleSummary;
}
