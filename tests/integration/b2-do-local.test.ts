/**
 * B2 DO-local behavior spec (L7 directory; this ONE file is the B2
 * DO-local case body per the join contract in
 * `tests/integration/README.md`).
 *
 * Separate from `b2-d1-fence.test.ts` by B2 definition (PLAN.md:111:
 * "Test D1 rollback/fence conflict and DO-local behavior separately").
 * The L3 DO storage port (`createDOStorage`) is constructible only
 * inside a Durable Object worker — it takes a live
 * `DurableObjectStorage` — and the owned local seam (`startLocalDev`,
 * `packages/cloudflare/src/dev/local-run.ts`) exposes no durable
 * object namespace. No mock storage is substituted: behavior rows
 * report `unsupported` with the exact missing seam, and one real row
 * pins the producer module surface present.
 *
 * Producer loading follows the lane02 join precedent exactly: the L3
 * source loads through a NON-LITERAL dynamic specifier, so this file
 * typechecks with the producer absent and fails loud (every row
 * `unsupported` with the exact absent detail below) when the load
 * fails at runtime.
 */
import { describe, expect, it } from "vitest";
import { createReport } from "@canlang/testkit";
import type { ResolvedCaller, TableCaseResult, TableRowResult } from "@canlang/contracts";

/** Exact absent-producer detail every producer-dependent row carries. */
const ABSENT_SENTENCE =
  "L3 DO producer absent; run root `bun run test` from a checkout with packages/state/src/storage/durable-object.ts";
const ABSENT_DETAIL = `local | ${ABSENT_SENTENCE}`;

const LOCAL_CALLER: ResolvedCaller = {
  account: "local-b2-do",
  team: null,
  roles: [],
  authenticated: false,
};

/** The exact missing seam every blocked row names. */
const SEAM =
  "startLocalDev exposes no durable object namespace (packages/cloudflare/src/dev/local-run.ts); " +
  "L3 createDOStorage needs a live DurableObjectStorage, obtainable only inside a DO worker — " +
  "cf. the producer-internal packages/state/test/storage/do.test.ts, which drives its own Miniflare DO";

const DO_SPECIFIER = "@canlang/state/storage/durable-object";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadProducer(): Promise<{ createDOStorage: unknown; ensureSchema: unknown } | null> {
  let mod: unknown;
  try {
    mod = await import(DO_SPECIFIER);
  } catch {
    return null;
  }
  if (!isRecord(mod)) {
    throw new Error("state DO module loaded but exported no namespace object");
  }
  // Direct-module names (the storage barrel aliases ensureSchema to
  // ensureDOSchema; the join probes the module it will drive).
  return { createDOStorage: mod["createDOStorage"], ensureSchema: mod["ensureSchema"] };
}

function unsupportedRow(rowIndex: number, detail: string): TableRowResult {
  return { rowIndex, caller: LOCAL_CALLER, outcome: "unsupported", detail };
}

function blockedRows(): TableRowResult[] {
  return [
    unsupportedRow(0, `local | BLOCKED (L7 local-run DO seam): DO fence conflict over real DurableObjectStorage — ${SEAM}`),
    unsupportedRow(1, `local | BLOCKED (L7 local-run DO seam): DO rollback atomicity over real DurableObjectStorage — ${SEAM}`),
    unsupportedRow(2, `local | BLOCKED (L7 local-run DO seam): DO-local history evidence over real DurableObjectStorage — ${SEAM}`),
    unsupportedRow(
      3,
      "local | BLOCKED (L7 local-run DO seam): DO-local vs D1 fence parity at the join — L3 conformance.ts is producer-internal (node:test), not join evidence",
    ),
  ];
}

describe("b2 DO-local behavior", () => {
  it("pins the DO producer surface over the real producer", async () => {
    const producer = await loadProducer();
    const builder = createReport({ digest: "b2-do-local", sourceRevision: "b2-do-local" });

    if (producer === null) {
      // Strict: producers live in-repo, so absence is a broken checkout,
      // not a skippable state. The gate must never green on unsupported rows.
      throw new Error("b2-do-local: producer modules failed to load (partial checkout?)");
    }

    // Real surface row: the producer module loads with the exact factory
    // surface the join will drive once the local-run DO seam lands.
    // Anything else (renamed exports, stale source) fails loud here.
    const surfaceRows: TableRowResult[] =
      typeof producer.createDOStorage === "function" && typeof producer.ensureSchema === "function"
        ? [
            {
              rowIndex: 0,
              caller: LOCAL_CALLER,
              outcome: "passed",
              detail: "local | surface: durable-object.ts exports createDOStorage + ensureSchema; behavior blocked on the seam below",
            },
          ]
        : [
            {
              rowIndex: 0,
              caller: LOCAL_CALLER,
              outcome: "failed",
              detail: `local | surface: durable-object.ts lacks the factory surface (createDOStorage: ${typeof producer.createDOStorage}, ensureSchema: ${typeof producer.ensureSchema})`,
            },
          ];
    const surfaceCase: TableCaseResult = { kind: "table", operation: "b2.do.surface", rows: surfaceRows };
    const blockedCase: TableCaseResult = { kind: "table", operation: "b2.do.blocked", rows: blockedRows() };
    builder.addCase(surfaceCase);
    builder.addCase(blockedCase);

    const report = builder.build();
    expect(report.summary.passed).toBe(1);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.setupFailed).toBe(0);
    expect(report.summary.unsupported).toBe(4);
    for (const table of report.cases) {
      if (table.kind !== "table") {
        continue;
      }
      for (const row of table.rows) {
        expect(row.detail).toContain("local");
      }
    }
  }, 30000);
});
