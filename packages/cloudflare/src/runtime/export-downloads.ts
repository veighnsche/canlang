/** Host-private export records; canonical current reads still authorize every disclosure. */
import type { D1Database } from '@cloudflare/workers-types';
import type { ExportDownloadRecord, ExportDownloadStore, InterfacesClock } from '@canlang/interfaces';
import { canonicalJson } from '@canlang/interfaces';

const SQL_NOW_MS = "((julianday('now') - 2440587.5) * 86400000)";

export async function ensureExportDownloadsSchema(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS export_downloads (
    handle TEXT PRIMARY KEY, identity TEXT NOT NULL, digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'revoked')),
    expires_at_ms REAL NOT NULL, data TEXT NOT NULL)`).run();
}

/** Stable request/scope/lifetime data, rather than serialization member order. */
function identity(record: ExportDownloadRecord): string {
  return canonicalJson({ handle: record.handle, appId: record.appId, teamId: record.teamId,
    principal: record.principal, operation: record.operation, args: record.args,
    createdAt: record.createdAt, expiresAt: record.expiresAt });
}

function changes(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) throw new Error('export downloads: missing write acknowledgement');
  const success = Object.getOwnPropertyDescriptor(result, 'success');
  if (success !== undefined && (!('value' in success) || success.value !== true)) {
    throw new Error('export downloads: failed write acknowledgement');
  }
  const meta = Object.getOwnPropertyDescriptor(result, 'meta');
  if (meta === undefined || !('value' in meta) || typeof meta.value !== 'object' || meta.value === null) {
    throw new Error('export downloads: missing write acknowledgement');
  }
  const changed = Object.getOwnPropertyDescriptor(meta.value, 'changes');
  if (changed === undefined || !('value' in changed) || (changed.value !== 0 && changed.value !== 1)) {
    throw new Error('export downloads: D1 did not report a definitive write result');
  }
  return changed.value === 1;
}

/** Conditional SQL writes are the linearization boundary across isolates and reopen. */
export function createD1ExportDownloadStore(
  db: D1Database, clock: InterfacesClock = { nowMs: Date.now },
): ExportDownloadStore {
  return {
    async read(handle) {
      const row = await db.prepare('SELECT data, digest, status FROM export_downloads WHERE handle = ?')
        .bind(handle).first<{ data: string; digest: string; status: string }>();
      if (row === null) return null;
      if (typeof row.data !== 'string') throw new Error('export downloads: malformed stored record');
      const record: ExportDownloadRecord = JSON.parse(row.data);
      if (typeof record !== 'object' || record === null || Array.isArray(record) ||
          record.handle !== handle || record.digest !== row.digest || record.status !== row.status) {
        throw new Error('export downloads: incoherent stored record');
      }
      return record;
    },
    async save(record, expectedDigest) {
      const expires = Date.parse(record.expiresAt);
      const now = clock.nowMs();
      if (!Number.isFinite(expires) || !Number.isFinite(now) || expires <= now) return false;
      // Serialize before the first await; caller aliases cannot mutate the pending write.
      const data = JSON.stringify(record);
      const key = identity(record);
      if (expectedDigest === null) {
        if (record.status !== 'pending') return false;
        return changes(await db.prepare(`INSERT INTO export_downloads
          (handle, identity, digest, status, expires_at_ms, data)
          SELECT ?, ?, ?, 'pending', ?, ? WHERE ? > ? AND ? > ${SQL_NOW_MS}
          ON CONFLICT (handle) DO NOTHING`)
          .bind(record.handle, key, record.digest, expires, data, expires, now, expires).run());
      }
      if (record.status !== 'ready') return false;
      return changes(await db.prepare(`UPDATE export_downloads SET data = ?, digest = ?, status = 'ready'
        WHERE handle = ? AND identity = ? AND digest = ? AND status = 'pending'
        AND expires_at_ms > ? AND expires_at_ms > ${SQL_NOW_MS}`)
        .bind(data, record.digest, record.handle, key, expectedDigest, now).run());
    },
    async revoke(handle) {
      // Tombstones keep the original digest, never recomputed asynchronously.
      // Status is checked before body integrity, and every later completion refuses it.
      return changes(await db.prepare(`UPDATE export_downloads SET status = 'revoked',
        data = json_set(json_remove(data, '$.csv', '$.rowCount'), '$.status', 'revoked')
        WHERE handle = ?`).bind(handle).run());
    },
  };
}
