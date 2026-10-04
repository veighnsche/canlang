/**
 * Durable Object storage tests: full conformance against the REAL adapter
 * running inside workerd with REAL DO SQLite (`state.storage.sql` +
 * `transactionSync`), reached through a thin fetch protocol (see
 * do-test-worker.js). node:test holds a StoragePort proxy: each method is
 * one roundtrip, and worker-side errors rehydrate into worker A's real
 * error classes, so instanceof assertions still verify real behavior.
 *
 * Why the proxy: a DurableObjectStorage handle exists only inside the DO,
 * and miniflare 4 exposes no constructible SQLite storage outside workerd
 * (`unsafeGetDurableObjectStorage` is exec-only, without transactions).
 * Fence enforcement, SQL, and rollback all happen inside workerd; the
 * proxy only transports calls and results.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type {
  ModelName,
  RecordId,
  Revision,
  StoragePort,
} from '../../../contracts/src/state.js';
import {
  FenceConflictError,
  StorageConstraintError,
  asId,
  asModel,
  asOperation,
  captureFailure,
  makeBatch,
  makeHistory,
  makeIntent,
  makeReceipt,
  makeRow,
  storageConformance,
  type ConformanceProbe,
  type ConformanceSetup,
} from './conformance.js';

/**
 * Compiled tests run from dist/...; this resolves back to the worker *source*
 * in test/storage (tsc never copies it to dist since allowJs is off). The
 * worker in turn imports the built adapter from dist (see do-test-worker.js).
 */
const workerPath = fileURLToPath(
  new URL('../../../../test/storage/do-test-worker.js', import.meta.url),
);

let mf: Miniflare | undefined;

interface WorkerErrorJson {
  readonly name: string;
  readonly message: string;
  readonly kind?: string;
  readonly detail?: string;
  readonly expected?: number;
  readonly actual?: number | null;
}

function rehydrate(error: WorkerErrorJson): Error {
  if (error.name === 'FenceConflictError') {
    return new FenceConflictError(
      error.expected as unknown as Revision,
      (error.actual ?? null) as unknown as Revision | null,
    );
  }
  if (error.name === 'StorageConstraintError') {
    return new StorageConstraintError(
      (error.kind ?? 'unknown') as StorageConstraintError['kind'],
      error.detail ?? error.message,
    );
  }
  const rebuilt = new Error(error.message);
  rebuilt.name = error.name;
  return rebuilt;
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  if (mf === undefined) {
    throw new Error('miniflare is not started');
  }
  const response = await mf.dispatchFetch(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

async function call<T>(method: string, ...args: ReadonlyArray<unknown>): Promise<T> {
  const data = await post('/call', { method, args });
  if (data['ok'] !== true) {
    throw rehydrate(data['error'] as unknown as WorkerErrorJson);
  }
  return data['value'] as T;
}

async function exec(sql: string, params: ReadonlyArray<unknown> = []): Promise<Array<Record<string, unknown>>> {
  const data = await post('/exec', { sql, params });
  if (data['ok'] !== true) {
    throw rehydrate(data['error'] as unknown as WorkerErrorJson);
  }
  return data['rows'] as Array<Record<string, unknown>>;
}

function doProxy(): StoragePort {
  return {
    readRevision: () => call('readRevision'),
    load: (model: ModelName, id: RecordId) => call('load', model, id),
    query: (spec) => call('query', spec),
    commit: (batch) => call('commit', batch),
    readReceipt: (identity) => call('readReceipt', identity),
    outboxPending: () => call('outboxPending'),
    scheduleGet: (key) => call('scheduleGet', key),
    schedulesDue: (now, limit) => call('schedulesDue', now, limit),
    historyFor: (model, recordId) => call('historyFor', model, recordId),
  };
}

async function resetDO(): Promise<void> {
  const data = await post('/reset', {});
  if (data['ok'] !== true) {
    throw rehydrate(data['error'] as unknown as WorkerErrorJson);
  }
}

function doProbe(): ConformanceProbe {
  return {
    async historyFor(model, recordId) {
      const rows = await exec(
        'SELECT * FROM history WHERE model = ? AND record_id = ? ORDER BY seq',
        [model as string, recordId as string],
      );
      return rows.map((row) => ({
        model: row['model'],
        recordId: row['record_id'],
        version: row['version'],
        operation: row['operation'],
        operationId: row['operation_id'],
        actor: row['actor'],
        at: row['at'],
        change: row['change'],
        before: row['before'] === null ? null : JSON.parse(row['before'] as string),
        after: row['after'] === null ? null : JSON.parse(row['after'] as string),
      })) as unknown as Awaited<ReturnType<ConformanceProbe['historyFor']>>;
    },
    async outboxAll() {
      const rows = await exec('SELECT * FROM outbox ORDER BY intent_id');
      return rows.map((row) => ({
        intentId: row['intent_id'],
        operation: row['operation'],
        operationId: row['operation_id'],
        target: row['target'],
        arguments: row['arguments'] === null ? {} : JSON.parse(row['arguments'] as string),
        occurrenceIndex: row['occurrence_index'],
        ...(row['dispatch_guard'] === null || row['dispatch_guard'] === undefined
          ? {}
          : { dispatchGuard: row['dispatch_guard'] }),
      })) as unknown as Awaited<ReturnType<ConformanceProbe['outboxAll']>>;
    },
    async scheduleGet(key) {
      const rows = await exec('SELECT * FROM "schedules" WHERE "key" = ?', [key]);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        key: row['key'],
        at: row['at'],
        event: row['event'],
        payload: JSON.parse(row['payload'] as string),
      } as unknown as Awaited<ReturnType<ConformanceProbe['scheduleGet']>>;
    },
  };
}

before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: workerPath,
    // The entry is ESM via `modules: true`, but imported `.js` files follow
    // modulesRules (default CommonJS): force ESM so the built adapter graph
    // (pure relative ESM, no bare imports) parses as modules.
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2025-01-01',
    durableObjects: {
      TEST_DO: { className: 'TestDO', useSQLite: true, unsafePreventEviction: true },
    },
  });
  await resetDO();
});

after(async () => {
  if (mf !== undefined) {
    await mf.dispose();
    mf = undefined;
  }
});

async function doSetup(): Promise<ConformanceSetup> {
  return { store: doProxy(), reset: resetDO, probe: doProbe() };
}

storageConformance('do', doSetup);

describe('do adapter proofs', () => {
  it('DO ATOMICITY: a mid-commit PK violation leaves no partial state', async () => {
    await resetDO();
    const store = doProxy();
    const receipt = makeReceipt({ operationId: 'op-do-atomic-1', committedRevision: 1 });
    const failed = await captureFailure(
      store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('t.Doc'),
              row: makeRow({ id: 'dox-1', data: { n: 1 } }),
            },
            // Mid-commit PRIMARY KEY violation: same (model, id) twice.
            {
              kind: 'insert',
              model: asModel('t.Doc'),
              row: makeRow({ id: 'dox-1', data: { n: 2 } }),
            },
          ],
          history: [makeHistory({ model: 't.Doc', recordId: 'dox-1' })],
          receipt,
          outbox: [makeIntent({ intentId: 'intent-do-atomic-1' })],
          schedules: [
            {
              op: 'replace',
              key: 'do-atomic-key',
              at: 1_700_000_010_000,
              event: asOperation('t.due'),
              payload: {},
            },
          ],
        }),
      ),
    );
    assert.ok(
      failed instanceof StorageConstraintError,
      `expected StorageConstraintError, got ${String(failed)}`,
    );
    assert.equal(await store.readRevision(), 0);
    assert.equal(await store.load(asModel('t.Doc'), asId('dox-1')), null);
    assert.equal(await store.readReceipt(receipt.identity), null);
    for (const table of [
      'records',
      'history',
      'receipts',
      'outbox',
      'schedules',
      'unique_claims',
      'fence_log',
    ]) {
      const rows = await exec(`SELECT COUNT(*) AS n FROM ${table}`);
      assert.equal(rows[0]?.['n'], 0, `expected ${table} to be empty after rollback`);
    }
    const fence = await exec('SELECT revision AS r FROM fence WHERE id = 1');
    assert.equal(fence[0]?.['r'], 0);
  });
});
