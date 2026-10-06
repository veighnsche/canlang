/**
 * B2 D1 rollback/fence-conflict spec (L7 directory; this ONE file is the
 * B2 D1 case body per the join contract in
 * `tests/integration/README.md`).
 *
 * Drives the REAL L3 D1 storage port (`createD1Storage`) against a REAL
 * local D1 (workerd, via the owned `startLocalDev` seam) and observes
 * fence conflicts plus version/unique/receipt rollbacks with
 * nothing-applied proofs. Every evidence row is labelled `emulator` in
 * its detail string (workerd D1 under miniflare); no live providers.
 *
 * Producer loading follows the lane02 join precedent exactly: the L3
 * source loads through a NON-LITERAL dynamic specifier, so this file
 * typechecks with the producer absent and fails loud (every row
 * `unsupported` with the exact absent detail below) when the load
 * fails at runtime. Three rows are permanently `unsupported` and name
 * the exact unmet contracts for cross-instance races, DO-backed fence
 * and replay-through-invoke.
 *
 * DO-local behavior is specified separately in `b2-do-local.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { startLocalDev } from "@canlang/cloudflare";
import { createReport, diffReportValues } from "@canlang/testkit";
import type {
  ModelName,
  ObservationMismatch,
  OperationId,
  OperationName,
  RecordId,
  RecordVersion,
  ReportValue,
  ResolvedCaller,
  TableCaseResult,
  TableRowResult,
} from "@canlang/contracts";
import {
  b2BlankBatch,
  b2HistoryEntry,
  b2Receipt,
  b2Revision,
  b2StoredRow,
  readB2Constraint,
  readB2FenceConflict,
} from "@canlang/testkit/fixtures/b2-storage";

/** Exact absent-producer detail every producer-dependent row carries. */
const ABSENT_SENTENCE =
  "L3 D1 producer absent; run root `bun run test` from a checkout with packages/state/src/storage/d1.ts";
const ABSENT_DETAIL = `emulator | ${ABSENT_SENTENCE}`;

const LOCAL_CALLER: ResolvedCaller = {
  account: "local-b2-d1",
  team: null,
  roles: [],
  authenticated: false,
};

const MODEL = "ExpenseReport";
const ACTOR = "local-b2-d1-owner";
const OPERATION = "ExpenseReport.submit";
const AT = 1_758_000_000_000;

// ---------------------------------------------------------------------------
// Producer surface (dynamic TS-source import; absent producers route to
// unsupported). Structural mirrors only — @canlang/state has no build,
// so static imports (even type-only) would drag L3 sources into the root
// check; the non-literal specifier keeps tsc blind (lane02 precedent).
// ---------------------------------------------------------------------------

const D1_SPECIFIER = "@canlang/state/storage/d1";

interface StoredRowView {
  readonly id: string;
  readonly version: number;
  readonly data: Readonly<Record<string, unknown>>;
}

interface D1StorageView {
  readRevision(): Promise<number>;
  load(model: string, id: string): Promise<StoredRowView | null>;
  commit(batch: unknown): Promise<{ revision: number }>;
  readReceipt(identity: unknown): Promise<unknown>;
  historyFor(model: string, recordId: string): Promise<readonly unknown[]>;
}

interface D1Producer {
  ensureSchema(db: unknown): Promise<void>;
  createD1Storage(db: unknown): D1StorageView;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadProducer(): Promise<D1Producer | null> {
  let mod: unknown;
  try {
    mod = await import(D1_SPECIFIER);
  } catch {
    return null;
  }
  if (
    !isRecord(mod) ||
    typeof mod["ensureSchema"] !== "function" ||
    typeof mod["createD1Storage"] !== "function"
  ) {
    throw new Error("state D1 module loaded but lacks ensureSchema/createD1Storage (stale source?)");
  }
  return mod as unknown as D1Producer;
}

function readStoredRow(value: unknown, what: string): StoredRowView {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["version"] !== "number" ||
    !isRecord(value["data"])
  ) {
    throw new Error(`${what}: stored row is not {id, version, data, ...}`);
  }
  return { id: value["id"], version: value["version"], data: value["data"] };
}

// ---------------------------------------------------------------------------
// Row helpers (same shape as the lane02 join, emulator-labelled).
// ---------------------------------------------------------------------------

function passedRow(rowIndex: number, label: string, mismatches: ObservationMismatch[]): TableRowResult {
  if (mismatches.length > 0) {
    return {
      rowIndex,
      caller: LOCAL_CALLER,
      outcome: "failed",
      mismatches,
      detail: `emulator | ${label}: ${mismatches.length} mismatch(es)`,
    };
  }
  return { rowIndex, caller: LOCAL_CALLER, outcome: "passed", detail: `emulator | ${label}` };
}

function failedRow(rowIndex: number, label: string, problem: string): TableRowResult {
  return { rowIndex, caller: LOCAL_CALLER, outcome: "failed", detail: `emulator | ${label}: ${problem}` };
}

function unsupportedRow(rowIndex: number, detail: string): TableRowResult {
  return { rowIndex, caller: LOCAL_CALLER, outcome: "unsupported", detail };
}

function blockedRows(): TableRowResult[] {
  return [
    unsupportedRow(
      0,
      "emulator | BLOCKED (L7 local-run fixture): fence race across two workerd instances sharing one D1 — in-memory D1 namespaces are per-instance, so no shared-D1 race is observable here",
    ),
    unsupportedRow(
      1,
      "emulator | BLOCKED (L7 local-run DO seam): DO-backed fence/rollback — see b2-do-local.test.ts",
    ),
    unsupportedRow(
      2,
      "emulator | BLOCKED (L3 invocation engine): mutation replay through invoke (receipt dedup above the port) — admit/invoke stay unexported",
    ),
  ];
}

// ---------------------------------------------------------------------------
// Journey batches.
// ---------------------------------------------------------------------------

function insertBatch(revision: number, id: string, data: Readonly<Record<string, unknown>>): unknown {
  const row = b2StoredRow({ id, version: 1, actor: ACTOR, at: AT, data });
  return {
    ...b2BlankBatch(b2Revision(revision)),
    writes: [{ kind: "insert", model: MODEL as ModelName, row }],
    history: [
      b2HistoryEntry({
        model: MODEL,
        recordId: id,
        version: 1,
        operation: OPERATION,
        operationId: `op-${id}`,
        actor: ACTOR,
        at: AT,
        change: "create",
        before: null,
        after: { ...data },
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// The join case.
// ---------------------------------------------------------------------------

describe("b2 D1 rollback and fence conflict", () => {
  it("observes fence/rollback over real D1", async () => {
    const producer = await loadProducer();
    const builder = createReport({ digest: "b2-d1-fence", sourceRevision: "b2-d1-fence" });

    if (producer === null) {
      // Strict: producers live in-repo, so absence is a broken checkout,
      // not a skippable state. The gate must never green on unsupported rows.
      throw new Error("b2-d1-fence: producer modules failed to load (partial checkout?)");
    }

    const dev = await startLocalDev({
      workerName: "b2-d1-fence",
      compatibilityDate: "2026-07-15",
      mainModule: "worker.mjs",
      modules: {
        "worker.mjs": `export default { async fetch() { return Response.json({ ready: true }); } }`,
      },
      d1Databases: [{ binding: "DB", id: "b2-d1-fence" }],
    });
    try {
      const db = await dev.getD1Database("DB");
      await producer.ensureSchema(db);
      const store = producer.createD1Storage(db);
      const rows: TableRowResult[] = [];

      // Row 0: the fence loser rolls back — nothing applied, revision advances once.
      try {
        const rev0 = await store.readRevision();
        const first = await store.commit(insertBatch(rev0, "row-0-a", { total: "10.00" }));
        let conflict: { expected: number; actual: number | null } | null = null;
        try {
          await store.commit(insertBatch(rev0, "row-0-b", { total: "20.00" }));
        } catch (err) {
          conflict = readB2FenceConflict(err, "row-0.fence");
        }
        if (conflict === null) {
          rows.push(failedRow(0, "journey:fence-conflict", "stale batch committed without a fence conflict"));
        } else {
          const loser = await store.load(MODEL, "row-0-b");
          const winner = await store.load(MODEL, "row-0-a");
          const revision = await store.readRevision();
          const mismatches: ObservationMismatch[] = [
            ...diffReportValues("row-0.expected", rev0 as ReportValue, conflict.expected as ReportValue),
            ...diffReportValues("row-0.actual", (rev0 + 1) as ReportValue, conflict.actual as ReportValue),
            ...diffReportValues("row-0.loser", null, (loser === null ? null : "present") as ReportValue),
            ...diffReportValues(
              "row-0.winner",
              "present" as ReportValue,
              (winner === null ? null : "present") as ReportValue,
            ),
            ...diffReportValues("row-0.revision", (rev0 + 1) as ReportValue, revision as ReportValue),
            ...diffReportValues("row-0.commit", (rev0 + 1) as ReportValue, first.revision as ReportValue),
          ];
          rows.push(passedRow(0, "journey:fence-conflict", mismatches));
        }
      } catch (err) {
        rows.push(failedRow(0, "journey:fence-conflict", err instanceof Error ? err.message : String(err)));
      }

      // Row 1: a stale-version write poisons its whole batch — the sibling insert rolls back too.
      try {
        const rev = await store.readRevision();
        const current = await store.load(MODEL, "row-0-a");
        if (current === null) {
          throw new Error("row-0-a vanished between rows (isolation breach)");
        }
        const bumped = b2StoredRow({ id: "row-0-a", version: 2, actor: ACTOR, at: AT + 1, data: { total: "11.00" } });
        await store.commit({
          ...b2BlankBatch(b2Revision(rev)),
          writes: [
            {
              kind: "update",
              model: MODEL as ModelName,
              id: "row-0-a" as RecordId,
              expectedVersion: 1 as RecordVersion,
              row: bumped,
            },
          ],
          history: [
            b2HistoryEntry({
              model: MODEL,
              recordId: "row-0-a",
              version: 2,
              operation: OPERATION,
              operationId: "op-row-0-a-v2",
              actor: ACTOR,
              at: AT + 1,
              change: "update",
              before: { total: "10.00" },
              after: { total: "11.00" },
            }),
          ],
        });
        const rev2 = await store.readRevision();
        const siblingBatch = insertBatch(rev2, "row-1-sibling", { total: "1.00" }) as {
          writes: readonly unknown[];
          history: readonly unknown[];
        };
        let constraint: { kind: string } | null = null;
        try {
          await store.commit({
            ...b2BlankBatch(b2Revision(rev2)),
            writes: [
              ...siblingBatch.writes,
              {
                kind: "update",
                model: MODEL,
                id: "row-0-a",
                expectedVersion: 1,
                row: b2StoredRow({ id: "row-0-a", version: 3, actor: ACTOR, at: AT + 2, data: { total: "12.00" } }),
              },
            ],
            history: siblingBatch.history,
          });
        } catch (err) {
          constraint = readB2Constraint(err, "row-1.version");
        }
        if (constraint === null) {
          rows.push(failedRow(1, "journey:stale-version", "stale-version batch committed without a constraint error"));
        } else {
          const sibling = await store.load(MODEL, "row-1-sibling");
          const survivor = await store.load(MODEL, "row-0-a");
          const mismatches: ObservationMismatch[] = [
            ...diffReportValues("row-1.kind", "version", constraint.kind as ReportValue),
            ...diffReportValues("row-1.sibling", null, (sibling === null ? null : "present") as ReportValue),
            ...diffReportValues(
              "row-1.survivor",
              2 as ReportValue,
              (survivor === null ? null : readStoredRow(survivor, "row-1.survivor").version) as ReportValue,
            ),
            ...diffReportValues("row-1.revision", rev2 as ReportValue, (await store.readRevision()) as ReportValue),
          ];
          rows.push(passedRow(1, "journey:stale-version", mismatches));
        }
      } catch (err) {
        rows.push(failedRow(1, "journey:stale-version", err instanceof Error ? err.message : String(err)));
      }

      // Row 2: receipt reuse rolls back — the second batch lands nothing.
      try {
        const rev = await store.readRevision();
        const receipt = b2Receipt({
          app: "b2",
          owner: "team-current",
          principal: ACTOR,
          operation: OPERATION,
          operationId: "op-receipt-1",
          inputHash: "hash-1",
          revision: rev + 1,
          at: AT,
        });
        await store.commit({ ...(insertBatch(rev, "row-2-first", { total: "3.00" }) as object), receipt });
        const revAfterFirst = await store.readRevision();
        let constraint: { kind: string } | null = null;
        try {
          await store.commit({
            ...(insertBatch(revAfterFirst, "row-2-second", { total: "4.00" }) as object),
            receipt,
          });
        } catch (err) {
          constraint = readB2Constraint(err, "row-2.receipt");
        }
        if (constraint === null) {
          rows.push(failedRow(2, "journey:receipt-reuse", "receipt-reuse batch committed without a constraint error"));
        } else {
          const second = await store.load(MODEL, "row-2-second");
          const stored = await store.readReceipt(receipt.identity);
          const mismatches: ObservationMismatch[] = [
            ...diffReportValues("row-2.kind", "receipt_reuse", constraint.kind as ReportValue),
            ...diffReportValues("row-2.second", null, (second === null ? null : "present") as ReportValue),
            ...diffReportValues(
              "row-2.first-receipt",
              "present" as ReportValue,
              (stored === null ? null : "present") as ReportValue,
            ),
            ...diffReportValues(
              "row-2.revision",
              revAfterFirst as ReportValue,
              (await store.readRevision()) as ReportValue,
            ),
          ];
          rows.push(passedRow(2, "journey:receipt-reuse", mismatches));
        }
      } catch (err) {
        rows.push(failedRow(2, "journey:receipt-reuse", err instanceof Error ? err.message : String(err)));
      }

      // Row 3: a unique-claim collision rolls back — the claimant insert lands nothing.
      try {
        const rev = await store.readRevision();
        await store.commit({
          ...b2BlankBatch(b2Revision(rev)),
          uniqueClaims: [
            { model: MODEL as ModelName, keyName: "reference", keyValue: "EXP-1", recordId: "row-0-a" as RecordId },
          ],
        });
        const revAfterClaim = await store.readRevision();
        let constraint: { kind: string } | null = null;
        try {
          await store.commit({
            ...(insertBatch(revAfterClaim, "row-3-claimant", { total: "5.00" }) as object),
            uniqueClaims: [
              {
                model: MODEL as ModelName,
                keyName: "reference",
                keyValue: "EXP-1",
                recordId: "row-3-claimant" as RecordId,
              },
            ],
          });
        } catch (err) {
          constraint = readB2Constraint(err, "row-3.unique");
        }
        if (constraint === null) {
          rows.push(failedRow(3, "journey:unique-claim", "unique-collision batch committed without a constraint error"));
        } else {
          const claimant = await store.load(MODEL, "row-3-claimant");
          const mismatches: ObservationMismatch[] = [
            ...diffReportValues("row-3.kind", "unique", constraint.kind as ReportValue),
            ...diffReportValues("row-3.claimant", null, (claimant === null ? null : "present") as ReportValue),
            ...diffReportValues(
              "row-3.revision",
              revAfterClaim as ReportValue,
              (await store.readRevision()) as ReportValue,
            ),
          ];
          rows.push(passedRow(3, "journey:unique-claim", mismatches));
        }
      } catch (err) {
        rows.push(failedRow(3, "journey:unique-claim", err instanceof Error ? err.message : String(err)));
      }

      // Row 4: history is append-only evidence — create then update, ordered, snapshot-isolated reads.
      try {
        const entries = await store.historyFor(MODEL, "row-0-a");
        const shape = entries.map((entry: unknown, index: number): string => {
          if (
            !isRecord(entry) ||
            typeof entry["version"] !== "number" ||
            typeof entry["change"] !== "string" ||
            typeof entry["actor"] !== "string" ||
            typeof entry["operation"] !== "string"
          ) {
            throw new Error(`row-4.history[${index}] is not a history entry`);
          }
          return `${String(entry["version"])}:${String(entry["change"])}:${String(entry["actor"])}:${String(entry["operation"])}`;
        });
        // Mutate the returned snapshot, then re-read: stored evidence must be pristine.
        const first = entries[0];
        if (isRecord(first) && isRecord(first["after"])) {
          (first["after"] as Record<string, unknown>)["total"] = "MUTATED";
        }
        const reread = await store.historyFor(MODEL, "row-0-a");
        const rereadFirst = reread[0];
        const pristine =
          isRecord(rereadFirst) && isRecord(rereadFirst["after"])
            ? (rereadFirst["after"] as Record<string, unknown>)["total"]
            : "MISSING";
        const mismatches: ObservationMismatch[] = [
          ...diffReportValues(
            "row-4.entries",
            [`1:create:${ACTOR}:${OPERATION}`, `2:update:${ACTOR}:${OPERATION}`] as unknown as ReportValue,
            shape as unknown as ReportValue,
          ),
          ...diffReportValues("row-4.pristine", "10.00" as ReportValue, pristine as ReportValue),
        ];
        rows.push(passedRow(4, "journey:history-evidence", mismatches));
      } catch (err) {
        rows.push(failedRow(4, "journey:history-evidence", err instanceof Error ? err.message : String(err)));
      }

      builder.addCase({ kind: "table", operation: "b2.d1.fence", rows });
      builder.addCase({ kind: "table", operation: "b2.d1.blocked", rows: blockedRows() });

      const report = builder.build();
      expect(report.summary.passed).toBe(5);
      expect(report.summary.failed).toBe(0);
      expect(report.summary.setupFailed).toBe(0);
      expect(report.summary.unsupported).toBe(3);
      for (const table of report.cases) {
        if (table.kind !== "table") {
          continue;
        }
        for (const row of table.rows) {
          expect(row.detail).toContain("emulator");
        }
      }
    } finally {
      await dev.dispose();
    }
  }, 120000);
});
