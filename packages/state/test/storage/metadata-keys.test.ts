import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { QuerySpec, StoredRow } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '../../src/storage/d1.js';
import { asModel } from './conformance.js';

const model = asModel('test.MetadataKeys');
const insert = 'INSERT INTO records (model, id, version, created, updated, created_by, updated_by, archived_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
const rows = [
  ['a', 2, 20, 200, 50, JSON.stringify(JSON.parse('{"constructor":"z","toString":"z","__proto__":"z","flag":false,"id":"shadow","version":99,"created":99,"updated":99,"archived_at":99}'))],
  ['b', 1, 10, 100, null, JSON.stringify(JSON.parse('{"constructor":"a","toString":"a","__proto__":"a","flag":true,"id":"shadow","version":99,"created":99,"updated":99,"archived_at":99}'))],
] as const;

for (const backend of ['d1', 'do'] as const) {
  describe(`${backend} metadata own keys`, () => {
    let mf: Miniflare;
    let query: (spec: QuerySpec) => Promise<ReadonlyArray<StoredRow>>;

    before(async () => {
      if (backend === 'd1') {
        mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] });
        const db = await mf.getD1Database('DB');
        await ensureSchema(db);
        for (const [id, version, created, updated, archived, data] of rows) {
          await db.prepare(insert).bind(model, id, version, created, updated, 'u', 'u', archived, data).run();
        }
        const store = createD1Storage(db);
        query = (spec) => store.query(spec);
      } else {
        mf = new Miniflare({
          modules: true,
          scriptPath: fileURLToPath(new URL('../../../test/storage/do-test-worker.js', import.meta.url)),
          modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
          compatibilityDate: '2025-01-01',
          durableObjects: { TEST_DO: { className: 'TestDO', useSQLite: true, unsafePreventEviction: true } },
        });
        const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
          const response = await mf.dispatchFetch(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          const result = await response.json() as Record<string, unknown>;
          if (result['ok'] !== true) {
            throw new Error((result['error'] as { message: string }).message);
          }
          return result;
        };
        for (const [id, version, created, updated, archived, data] of rows) {
          await post('/exec', { sql: insert, params: [model, id, version, created, updated, 'u', 'u', archived, data] });
        }
        query = async (spec) => (await post('/call', { method: 'query', args: [spec] }))['value'] as StoredRow[];
      }
    });

    after(async () => { await mf?.dispose(); });

    const spec = (extra: Partial<QuerySpec>): QuerySpec => ({ model, authority: 'viewer', archived: 'include', ...extra });

    for (const field of ['constructor', 'toString', '__proto__']) {
      it(`filters valid data field ${field}`, async () => {
        const result = await query(spec({ where: { op: 'eq', field, value: 'a' } }));
        assert.deepEqual(result.map((row) => row.id), ['b']);
        assert.equal(result[0]?.data[field], 'a');
        assert.equal(Object.hasOwn(result[0]?.data ?? {}, field), true);
      });
      it(`orders valid data field ${field}`, async () => {
        assert.deepEqual((await query(spec({ order: [{ field, direction: 'asc' }] }))).map((row) => row.id), ['b', 'a']);
        assert.deepEqual((await query(spec({ order: [{ field, direction: 'desc' }] }))).map((row) => row.id), ['a', 'b']);
      });
    }

    it('keeps real metadata columns ahead of shadow data fields', async () => {
      for (const [field, value] of [['id', 'b'], ['version', 1], ['created', 10], ['updated', 100], ['archived_at', null]] as const) {
        assert.deepEqual((await query(spec({ where: { op: 'eq', field, value } }))).map((row) => row.id), ['b']);
        const ordered = await query(spec({ order: [{ field, direction: 'asc' }] }));
        assert.deepEqual(ordered.map((row) => row.id), field === 'id' ? ['a', 'b'] : ['b', 'a']);
      }
    });

    it('keeps boolean/null normalization and archived defaults', async () => {
      assert.deepEqual((await query(spec({ where: { op: 'eq', field: 'flag', value: true } }))).map((row) => row.id), ['b']);
      assert.deepEqual((await query(spec({ where: { op: 'eq', field: 'missing', value: undefined } }))).map((row) => row.id), ['b', 'a']);
      assert.deepEqual((await query({ model, authority: 'viewer' })).map((row) => row.id), ['b']);
    });

    it('refuses invalid names in filters and orders with the original error', async () => {
      for (const field of ['x.y', "x') OR 1=1 --", '', 'a-b', '1field']) {
        const message = `Invalid query field: ${JSON.stringify(field)}`;
        await assert.rejects(query(spec({ where: { op: 'eq', field, value: 'a' } })), { message });
        await assert.rejects(query(spec({ order: [{ field, direction: 'asc' }] })), { message });
      }
    });
  });
}
