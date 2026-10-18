/** Canonical no-effects snapshots of native-allocated local row databases. */
import { BUSINESS_ERROR_CODES, type ReportValue, type StateErrorCode } from "@canlang/contracts";

/** Structural D1 query port; Testkit never allocates a Worker or a database. */
export interface LocalSnapshotHost {
  getD1Database(binding: string): Promise<{
    prepare(sql: string): {
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    };
  }>;
}

function toReportValue(value: unknown): ReportValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value;
  }
  if (value instanceof Uint8Array) {
    // Internal snapshot encoding only (change detection); never a wire format.
    return { $bytes: Buffer.from(value).toString("hex") };
  }
  if (Array.isArray(value)) {
    return value.map(toReportValue);
  }
  if (typeof value === "object") {
    const record: Record<string, ReportValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      record[key] = toReportValue(entry);
    }
    return record;
  }
  throw new Error(`snapshot cannot encode value of type ${typeof value}`);
}

function isStateErrorCode(value: unknown): value is StateErrorCode {
  return typeof value === "string" && (BUSINESS_ERROR_CODES as readonly string[]).includes(value);
}

async function snapshotD1(dev: LocalSnapshotHost, binding: string): Promise<ReportValue> {
  const db = await dev.getD1Database(binding);
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all<{ name: string }>();
  const snapshot: Record<string, ReportValue> = {};
  for (const table of tables.results) {
    // D1's _cf_ metadata is protected from SQL reads. A canonical denial
    // may advance the engine fence; that is admission bookkeeping.
    if (table.name.startsWith("_cf_") || table.name === "fence" ||
        table.name === "fence_log") continue;
    const quoted = `"${table.name.replace(/"/g, '""')}"`;
    // WITHOUT ROWID tables fail ORDER BY rowid loudly; no silent fallback.
    const rows = await db.prepare(`SELECT * FROM ${quoted} ORDER BY rowid`).all();
    if (table.name === "receipts") {
      // Only a canonical rejection receipt is bookkeeping. A committed
      // receipt is durable evidence of business work and must fail the
      // no-effects comparison even if no model row happened to change.
      snapshot[table.name] = toReportValue(rows.results.filter((row) => {
        const outcome = (row as Record<string, unknown>)["outcome"];
        if (typeof outcome !== "string") throw new Error("snapshot: receipt outcome is unavailable");
        let parsed: unknown;
        try { parsed = JSON.parse(outcome); }
        catch { throw new Error("snapshot: receipt outcome is invalid JSON"); }
        if (typeof parsed !== "object" || parsed === null ||
            !Object.hasOwn(parsed, "status") ||
            ((parsed as { status: unknown }).status !== "committed" &&
             (parsed as { status: unknown }).status !== "rejected")) {
          throw new Error("snapshot: receipt outcome has an unknown status");
        }
        if ((parsed as { status: string }).status === "rejected") {
          const rejection = parsed as Record<string, unknown>;
          if (Object.keys(rejection).length !== 3 || !isStateErrorCode(rejection["code"]) ||
              typeof rejection["message"] !== "string") {
            throw new Error("snapshot: rejection receipt is not canonical");
          }
          return false;
        }
        return true;
      }));
    } else {
      snapshot[table.name] = toReportValue(rows.results);
    }
  }
  return snapshot;
}

/** Compare every selected effect-capable store, preserving single-store snapshots. */
export async function snapshotLocalDatabases(
  host: LocalSnapshotHost,
  bindings: readonly string[],
): Promise<ReportValue> {
  if (bindings.length === 0 || bindings.some(binding => binding.length === 0) ||
      new Set(bindings).size !== bindings.length) {
    throw new Error("row snapshot: bindings must be distinct and nonempty");
  }
  if (bindings.length === 1) return snapshotD1(host, bindings[0]!);
  const snapshots: Record<string, ReportValue> = {};
  for (const binding of bindings) snapshots[binding] = await snapshotD1(host, binding);
  return snapshots;
}
