/** Durable Object SQLite leaf; every Files kernel call remains in this isolate. */
import { createSqliteFileStoreFromDatabase } from './sqlite-core.js';
import type { FileSqliteDatabase, FileSqlValue, SqliteFileStore } from './sqlite-core.js';
export { createSqliteFileBindings } from './sqlite-core.js';
export type { SqliteFileBindingOptions, SqliteFileStore } from './sqlite-core.js';

/** Structural owning API of DurableObjectStorage, without a Node/runtime import. */
export interface DurableFileSqliteStorage {
  readonly sql: {
    exec(query: string, ...parameters: (string | number | null | ArrayBuffer)[]): {
      toArray(): Record<string, unknown>[];
    };
  };
  transactionSync<T>(body: () => T): T;
}

export function createDurableSqliteFileStore(storage: DurableFileSqliteStorage): SqliteFileStore {
  let closed = false;
  const assertOpen = (): void => { if (closed) throw new Error('Files store is closed.'); };
  const parameters = (values: FileSqlValue[]) => values.map(value => value instanceof Uint8Array
    ? new Uint8Array(value).buffer : value);
  const rows = (sql: string, values: FileSqlValue[]) => {
    assertOpen();
    return storage.sql.exec(sql, ...parameters(values)).toArray().map(row => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : value]),
    ));
  };
  const adapter: FileSqliteDatabase = {
    exec(sql) { assertOpen(); storage.sql.exec(sql); },
    prepare(sql) {
      return {
        run(...values) { rows(sql, values); },
        get(...values) { return rows(sql, values)[0]; },
        all(...values) { return rows(sql, values); },
      };
    },
    transaction<T>(body: () => T): T { assertOpen(); return storage.transactionSync(body); },
    // DurableObjectStorage has no close operation. Stop this binding's access;
    // the owning Durable Object lifetime retains the underlying durable store.
    close() { closed = true; },
  };
  return createSqliteFileStoreFromDatabase(adapter);
}
