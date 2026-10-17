/** Node SQLite leaf. The shared Files core owns schema and authority rules. */
import { DatabaseSync } from 'node:sqlite';
import { createSqliteFileStoreFromDatabase } from './sqlite-core.js';
import type { FileSqliteDatabase, SqliteFileStore } from './sqlite-core.js';
export { createSqliteFileBindings } from './sqlite-core.js';
export type { SqliteFileBindingOptions, SqliteFileStore } from './sqlite-core.js';

export function createSqliteFileStore(path: string): SqliteFileStore {
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA busy_timeout = 5000'); }
  catch (error) { db.close(); throw error; }
  const adapter: FileSqliteDatabase = {
    exec: sql => db.exec(sql),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...parameters) => { statement.run(...parameters); },
        get: (...parameters) => statement.get(...parameters),
        all: (...parameters) => statement.all(...parameters),
      };
    },
    transaction<T>(body: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try { const result = body(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close: () => db.close(),
  };
  return createSqliteFileStoreFromDatabase(adapter);
}
