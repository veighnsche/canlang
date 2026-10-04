import type {
  ReportValue,
  ResolvedCaller,
  TableCaseResult,
  TableRowResult,
} from "@canlang/contracts";
import { diffReportValues } from "../assertions/equal.js";
import {
  provisionRowAccounts,
  resolveCaller,
  type CallerSelection,
  type NamedUserFixture,
  type RowAccounts,
} from "../fixtures/accounts.js";

/** One isolated row execution scope. The runner creates one per row. */
export interface RowScope {
  /** Opaque state token for rejection side-effect proofs. */
  snapshot: () => Promise<ReportValue>;
  dispose: () => Promise<void>;
}

/**
 * Outcome of one business invocation. Implementers RETURN business results
 * (success or exact business error) and THROW unexpected failures; the two
 * never interchange. `unsupported` marks paths blocked on unlanded
 * producers and can never satisfy an expected rejection.
 */
export type CallOutcome =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; unsupported: true; detail: string };

export type ExpectedRowOutcome =
  | { values: readonly ReportValue[]; observations: readonly string[] }
  | { error: string };

/**
 * One executable row. A future lane-1 artifact loader builds these from
 * emitted test modules; until then only `test/` doubles construct them.
 * `seed` names the fixtures the setup provisions (report-indexed by the
 * artifact digest + `rowIndex`, not echoed per row).
 */
export interface TableRowSpec<Scope extends RowScope> {
  rowIndex: number;
  caller: CallerSelection;
  seed: readonly string[];
  setup: (scope: Scope, accounts: RowAccounts) => Promise<void>;
  invoke: (scope: Scope, caller: ResolvedCaller) => Promise<CallOutcome>;
  expected: ExpectedRowOutcome;
  observe: (scope: Scope) => Promise<ReportValue[]>;
}

export interface TableSpec<Scope extends RowScope> {
  operation: string;
  userFixtures?: readonly NamedUserFixture[];
  createScope: (rowIndex: number) => Promise<Scope>;
  rows: readonly TableRowSpec<Scope>[];
}

/** Production invoke path before the lane-1/3 join: always unsupported. */
export async function unsupportedInvoker(): Promise<CallOutcome> {
  return { ok: false, unsupported: true, detail: "operation invocation needs the lane-1/3 join" };
}

function isErrorExpected(expected: ExpectedRowOutcome): expected is { error: string } {
  return "error" in expected;
}

function detailOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

async function runOneRow<Scope extends RowScope>(
  spec: TableRowSpec<Scope>,
  userFixtures: readonly NamedUserFixture[],
  createScope: (rowIndex: number) => Promise<Scope>,
): Promise<TableRowResult> {
  let scope: Scope | undefined;
  try {
    scope = await createScope(spec.rowIndex);
  } catch (thrown) {
    return {
      rowIndex: spec.rowIndex,
      caller: { account: "unknown", team: null, roles: [], authenticated: false },
      outcome: "setup-failed",
      detail: `scope creation failed: ${detailOf(thrown)}`,
    };
  }

  try {
    const accounts = provisionRowAccounts(spec.rowIndex, userFixtures);
    let caller: ResolvedCaller;
    try {
      caller = resolveCaller(spec.caller, accounts);
      await spec.setup(scope, accounts);
    } catch (thrown) {
      return {
        rowIndex: spec.rowIndex,
        caller: { account: "unknown", team: null, roles: [], authenticated: false },
        outcome: "setup-failed",
        detail: detailOf(thrown),
      };
    }

    let before: ReportValue;
    try {
      before = await scope.snapshot();
    } catch (thrown) {
      return { rowIndex: spec.rowIndex, caller, outcome: "setup-failed", detail: detailOf(thrown) };
    }

    let outcome: CallOutcome;
    try {
      outcome = await spec.invoke(scope, caller);
    } catch (thrown) {
      return {
        rowIndex: spec.rowIndex,
        caller,
        outcome: "failed",
        detail: `unexpected invocation failure: ${detailOf(thrown)}`,
      };
    }

    if (!outcome.ok) {
      if ("unsupported" in outcome) {
        return { rowIndex: spec.rowIndex, caller, outcome: "unsupported", detail: outcome.detail };
      }
      const rejection = outcome.error;
      if (!isErrorExpected(spec.expected)) {
        return {
          rowIndex: spec.rowIndex,
          caller,
          outcome: "failed",
          rejection: { error: rejection, sideEffectsAbsent: false },
          detail: `expected values but the operation rejected with ${rejection}`,
        };
      }
      if (rejection !== spec.expected.error) {
        return {
          rowIndex: spec.rowIndex,
          caller,
          outcome: "failed",
          rejection: { error: rejection, sideEffectsAbsent: false },
          detail: `expected error(${spec.expected.error}) but got error(${rejection})`,
        };
      }
      let after: ReportValue;
      try {
        after = await scope.snapshot();
      } catch (thrown) {
        return { rowIndex: spec.rowIndex, caller, outcome: "failed", detail: detailOf(thrown) };
      }
      const leaked = diffReportValues("state", before, after);
      if (leaked.length > 0) {
        return {
          rowIndex: spec.rowIndex,
          caller,
          outcome: "failed",
          rejection: { error: rejection, sideEffectsAbsent: false },
          detail: `expected rejection leaked state changes: ${leaked[0]?.observation ?? "state"}`,
        };
      }
      return {
        rowIndex: spec.rowIndex,
        caller,
        outcome: "passed",
        rejection: { error: rejection, sideEffectsAbsent: true },
      };
    }

    if (isErrorExpected(spec.expected)) {
      return {
        rowIndex: spec.rowIndex,
        caller,
        outcome: "failed",
        detail: `expected error(${spec.expected.error}) but the operation succeeded`,
      };
    }
    const expected = spec.expected;
    let actual: ReportValue[];
    try {
      actual = await spec.observe(scope);
    } catch (thrown) {
      return {
        rowIndex: spec.rowIndex,
        caller,
        outcome: "failed",
        detail: `observation failed: ${detailOf(thrown)}`,
      };
    }
    if (actual.length !== expected.values.length) {
      return {
        rowIndex: spec.rowIndex,
        caller,
        outcome: "failed",
        detail: `expected ${expected.values.length} observations but got ${actual.length}`,
      };
    }
    const mismatches = expected.values.flatMap((value, index) =>
      diffReportValues(
        expected.observations[index] ?? `observation[${index}]`,
        value,
        actual[index] as ReportValue,
      ),
    );
    if (mismatches.length > 0) {
      return { rowIndex: spec.rowIndex, caller, outcome: "failed", mismatches };
    }
    return { rowIndex: spec.rowIndex, caller, outcome: "passed" };
  } finally {
    try {
      await scope.dispose();
    } catch (thrown) {
      return {
        rowIndex: spec.rowIndex,
        caller: { account: "unknown", team: null, roles: [], authenticated: false },
        outcome: "failed",
        detail: `scope disposal failed, isolation unproven: ${detailOf(thrown)}`,
      };
    }
  }
}

/**
 * Executes every row of one table, each in a freshly created scope. Rows run
 * sequentially in spec order; a row never observes another row's scope.
 */
export async function runTable<Scope extends RowScope>(spec: TableSpec<Scope>): Promise<TableCaseResult> {
  const rows: TableRowResult[] = [];
  for (const row of spec.rows) {
    rows.push(await runOneRow(row, spec.userFixtures ?? [], spec.createScope));
  }
  return { kind: "table", operation: spec.operation, rows };
}
