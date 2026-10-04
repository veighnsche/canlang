import { startLocalDev, type LocalDev } from "@canlang/cloudflare";
import type { ReportValue } from "@canlang/contracts";
import type { RowScope } from "../runner/table.js";

export interface LocalRowScopeOptions {
  workerName: string;
  compatibilityDate: string;
  mainModule: string;
  modules: Readonly<Record<string, string>>;
  /** D1 binding the snapshotter reads. */
  d1Binding: string;
}

export interface LocalRowScope extends RowScope {
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

async function snapshotD1(dev: LocalDev, binding: string): Promise<ReportValue> {
  const db = await dev.getD1Database(binding);
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all<{ name: string }>();
  const snapshot: Record<string, ReportValue> = {};
  for (const table of tables.results) {
    const quoted = `"${table.name.replace(/"/g, '""')}"`;
    // WITHOUT ROWID tables fail ORDER BY rowid loudly; no silent fallback.
    const rows = await db.prepare(`SELECT * FROM ${quoted} ORDER BY rowid`).all();
    snapshot[table.name] = toReportValue(rows.results);
  }
  return snapshot;
}

/**
 * Default row scope: one fresh local workerd instance (own D1 namespace via
 * `d1Id`) per row. Snapshots dump every D1 table's full contents ordered by
 * `rowid`, so any leaked D1-table write fails an expected rejection. Other
 * bindings (R2/queues/DO) are isolated by the fresh instance but not
 * snapshotted; leak detection for those joins with their fixtures.
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
    d1Databases: [{ binding: options.d1Binding, id: d1Id }],
  });
  return {
    dev,
    snapshot: () => snapshotD1(dev, options.d1Binding),
    dispose: () => dev.dispose(),
  };
}
