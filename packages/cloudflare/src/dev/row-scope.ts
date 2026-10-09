import { startLocalDev, type LocalDev } from "./local-run.js";
import { BUSINESS_ERROR_CODES, type ReportValue, type StateErrorCode } from "@canlang/contracts";

export interface LocalRowScopeOptions {
  workerName: string;
  compatibilityDate: string;
  mainModule: string;
  modules: Readonly<Record<string, string>>;
  /**
   * C04.asset: binary module name -> raw bytes, threaded to
   * `startLocalDev` (`CompiledWasm` staging). Absent by default.
   */
  binaryModules?: Readonly<Record<string, Uint8Array>>;
  /** D1 binding the snapshotter reads. */
  d1Binding: string;
}

export interface LocalRowScope {
  snapshot(): Promise<ReportValue>;
  dispose(): Promise<void>;
  dev: LocalDev;
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

async function snapshotD1(dev: LocalDev, binding: string): Promise<ReportValue> {
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

/**
 * Default row scope: one fresh local workerd instance (own D1 namespace via
 * `d1Id`) per row. Snapshots dump every effect-capable D1 table's full
 * contents ordered by `rowid`, so any leaked domain/effect write fails an
 * expected rejection. Cloudflare metadata, engine fence rows, and canonical
 * rejected receipts remain in D1 but do not count as business effects.
 * This first profile admits only the local D1 binding; a resource requiring
 * R2, queues, or Durable Objects must be refused before using this scope.
 */
export async function createLocalRowScope(
  d1Id: string,
  options: LocalRowScopeOptions,
): Promise<LocalRowScope> {
  const dev = await startLocalDev({
    workerName: options.workerName,
    compatibilityDate: options.compatibilityDate,
    mainModule: options.mainModule,
    modules: options.modules,
    ...(options.binaryModules !== undefined ? { binaryModules: options.binaryModules } : {}),
    d1Databases: [{ binding: options.d1Binding, id: d1Id }],
  });
  return {
    dev,
    snapshot: () => snapshotD1(dev, options.d1Binding),
    dispose: () => dev.dispose(),
  };
}
