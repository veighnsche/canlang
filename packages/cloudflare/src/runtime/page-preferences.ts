/** Durable page selector values, scoped by app, actor, team, owner and field. */
import type { D1Database } from '@cloudflare/workers-types';
import type { PagePreferenceStore } from '@canlang/interfaces';

const MAX_VERSION = Number.MAX_SAFE_INTEGER;

/** The production D1 binding owns this table for both deployed and local pages. */
export async function ensurePagePreferencesSchema(db: D1Database): Promise<void> {
  await db.exec('CREATE TABLE IF NOT EXISTS page_preferences (' +
    'app_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, team_id TEXT NOT NULL, ' +
    'owner TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, ' +
    'version INTEGER NOT NULL CHECK (version > 0), ' +
    'PRIMARY KEY (app_id, actor_user_id, team_id, owner, field))');
}

function checkedVersion(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error('page preferences: expected version is invalid');
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0 || version >= MAX_VERSION) {
    throw new Error('page preferences: expected version is out of range');
  }
  return version;
}

/** One SQL statement makes the version comparison and write atomic. */
export function createD1PagePreferenceStore(db: D1Database): PagePreferenceStore {
  return {
    async read(key) {
      const row = await db.prepare(`SELECT value, version FROM page_preferences
        WHERE app_id = ? AND actor_user_id = ? AND team_id = ? AND owner = ? AND field = ?`)
        .bind(key.appId, key.actorUserId, key.teamId, key.owner, key.field)
        .first<{ value: string; version: number }>();
      if (row === null) return null;
      if (typeof row.value !== 'string' || !Number.isSafeInteger(row.version) || row.version <= 0) {
        throw new Error('page preferences: stored value or version is invalid');
      }
      return { value: row.value, version: String(row.version) };
    },
    async save(input) {
      const expected = checkedVersion(input.expectedVersion);
      const result = expected === 0
        ? await db.prepare(`INSERT INTO page_preferences
            (app_id, actor_user_id, team_id, owner, field, value, version)
            VALUES (?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT (app_id, actor_user_id, team_id, owner, field) DO NOTHING`)
          .bind(input.appId, input.actorUserId, input.teamId, input.owner, input.field, input.value)
          .run()
        : await db.prepare(`UPDATE page_preferences SET value = ?, version = ?
            WHERE app_id = ? AND actor_user_id = ? AND team_id = ? AND owner = ? AND field = ? AND version = ?`)
          .bind(input.value, expected + 1, input.appId, input.actorUserId, input.teamId,
            input.owner, input.field, expected)
          .run();
      const changes: unknown = result.meta?.changes;
      if (changes !== 0 && changes !== 1) {
        throw new Error('page preferences: D1 did not report a definitive write result');
      }
      return changes === 1;
    },
  };
}
