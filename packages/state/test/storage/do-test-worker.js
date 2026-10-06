/**
 * TEST-ONLY miniflare worker for the Durable Object storage suite.
 *
 * Plain JS on purpose: miniflare loads it via `scriptPath` with no build
 * step. It imports the BUILT adapter (`dist/...`, produced by `bun run
 * build` before tests run) so the suite exercises worker A's real
 * `createDOStorage` against workerd's real DO SQLite engine
 * (`state.storage.sql` + `transactionSync`).
 *
 * Protocol (single fixed instance `test`; every test resets first):
 * - POST /call  { method, args } -> { ok, value } | { ok:false, error }
 *   where method is a StoragePort method name. Errors serialize as
 *   { name, message, kind?, detail?, expected?, actual? } and the node
 *   side rehydrates them into worker A's real error classes.
 * - POST /reset -> clears every table and the fence row (test-only).
 * - POST /exec  { sql, params? } -> { ok, rows } for probe SELECTs.
 */
import { createDOStorage, ensureSchema } from '../../dist/src/storage/durable-object.js';

const TABLES = [
  'records',
  'history',
  'receipts',
  'outbox',
  'schedules',
  'unique_claims',
  'snapshots',
  'migration_staging',
  'migration_progress',
  'migration_outcomes',
];

function serializeError(error) {
  const out = {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
  };
  for (const field of ['kind', 'detail', 'expected', 'actual']) {
    if (error?.[field] !== undefined) {
      out[field] = error[field];
    }
  }
  return out;
}

export class TestDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.store = createDOStorage(state.storage);
    this.schemaReady = ensureSchema(state.storage);
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      await this.schemaReady;
      if (request.method === 'POST' && url.pathname === '/call') {
        const { method, args } = await request.json();
        const value = await this.store[method](...(args ?? []));
        return Response.json({ ok: true, value });
      }
      if (request.method === 'POST' && url.pathname === '/reset') {
        for (const table of TABLES) {
          this.state.storage.sql.exec(`DELETE FROM ${table}`);
        }
        this.state.storage.sql.exec('DELETE FROM fence_log');
        this.state.storage.sql.exec('UPDATE fence SET revision = 0 WHERE id = 1');
        return Response.json({ ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/exec') {
        const { sql, params } = await request.json();
        const rows = this.state.storage.sql.exec(sql, ...(params ?? [])).toArray();
        return Response.json({ ok: true, rows });
      }
      return Response.json({ ok: false, error: { name: 'NotFound', message: url.pathname } }, { status: 404 });
    } catch (error) {
      return Response.json({ ok: false, error: serializeError(error) });
    }
  }
}

export default {
  async fetch(request, env) {
    const stub = env.TEST_DO.get(env.TEST_DO.idFromName('test'));
    return stub.fetch(request);
  },
};
