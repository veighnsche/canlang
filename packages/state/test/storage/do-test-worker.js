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
import { STATE_FILE_REFERENCE_PRODUCER } from '../../dist/src/storage/file-reference-inventory.js';
import { prepareFrameworkFilePayloadOrigin } from '../../dist/src/storage/file-retirement.js';
import { finalizeProviderOutput, observeFinalizedFile, readFinalizedFileObservation, recordAttachment } from '@canlang/files/finalize';
import { DEFAULT_FILE_POLICY } from '@canlang/files/upload';
import { TestOnlyCounterFileIds, TestOnlyCounterIntentIds, TestOnlyMemoryBlobStore,
  TestOnlyMemoryFinalizedStore, TestOnlyMemoryIntentStore } from '@canlang/files/ports';

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
  'migration_failures',
  'file_reference_authority', 'file_reference_inventories', 'file_reference_migrations',
  'file_reference_publications', 'file_retirements',
];

function serializeError(error) {
  const out = {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
  };
  for (const field of ['kind', 'detail', 'expected', 'actual', 'code', 'retryable']) {
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
    this.observations = new Map();
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
        this.observations.clear();
        for (const table of TABLES) {
          this.state.storage.sql.exec(`DELETE FROM ${table}`);
        }
        this.state.storage.sql.exec('DELETE FROM fence_log');
        this.state.storage.sql.exec('UPDATE fence SET revision = 0 WHERE id = 1');
        return Response.json({ ok: true });
      }
      // Genuine Files observations stay in this worker's own module instance.
      // JSON transport carries refs and saved facts, never an observation issuer.
      // Files uses test-only byte/metadata ports here; State persists in actual
      // DO SQLite. This endpoint does not qualify native loader or File reuse.
      if (request.method === 'POST' && url.pathname === '/finalize-provider') {
        const { origin, receiver, retention, atMs } = await request.json();
        const clock = { nowMs: () => atMs }, intents = new TestOnlyMemoryIntentStore();
        const blobs = new TestOnlyMemoryBlobStore(), files = new TestOnlyMemoryFinalizedStore();
        const upload = { clock, intents, blobs, intentIds: new TestOnlyCounterIntentIds(),
          policy: DEFAULT_FILE_POLICY, intentTtlMs: 60_000, urlBase: 'https://documents.example.test' };
        const finalize = { clock, intents, blobs, files, fileIds: new TestOnlyCounterFileIds() };
        const result = finalizeProviderOutput(upload, finalize, { receiver,
          binding: { adapter: origin.request.from, deliveryId: origin.deliveryId, resultPath: 'outputs/0/image' },
          operation: origin.intent.target, field: '/outputs/0/image', args: {}, name: 'generated.png',
          claimedType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]) });
        if (result.status !== 'finalized') throw new Error('Actual Files provider finalization failed');
        const ref = result.file.id;
        if (recordAttachment(finalize, ref, 'Documents.Job/bound-job', receiver).status !== 'attached') {
          throw new Error('Actual Files attachment failed');
        }
        const observation = observeFinalizedFile(finalize, ref, receiver, { policy: DEFAULT_FILE_POLICY, retention });
        const facts = readFinalizedFileObservation(observation);
        if (facts === null) throw new Error('Actual Files observation required');
        this.observations.set(ref, observation);
        return Response.json({ ok: true, value: facts });
      }
      if (request.method === 'POST' && url.pathname === '/prepare-origin') {
        const { input, files } = await request.json();
        const value = await prepareFrameworkFilePayloadOrigin(this.store, { ...input,
          files: files.map(({ path, ref }) => ({ path, observation: this.observations.get(ref) })) });
        return Response.json({ ok: true, value });
      }
      if (request.method === 'POST' && url.pathname === '/reopen') {
        const body = await request.json();
        await ensureSchema(this.state.storage);
        const producers = body.framework === 'state' ? [STATE_FILE_REFERENCE_PRODUCER] : [];
        this.store = body.authority === undefined ? createDOStorage(this.state.storage, undefined, producers) : createDOStorage(this.state.storage, body.authority, producers);
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
