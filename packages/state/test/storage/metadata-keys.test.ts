import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { QuerySpec, StoredRow, Revision, RecordId } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '../../src/storage/d1.js';
import { asModel } from './conformance.js';
import { StateError } from '../../src/errors.js';
import { toCohortStoredRow, toCohortStoredRows, captureCohortRow, compileCohortRowPage, compileCohortRowLoad,
  toStoredRow, type CohortRecordRow } from '../../src/storage/sqlite-codecs.js';

const model = asModel('test.MetadataKeys');
const insert = 'INSERT INTO records (model, id, version, created, updated, created_by, updated_by, archived_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
const cohortColumns = ['model', 'id', 'version', 'created', 'updated', 'created_by', 'updated_by',
  'archived_at', 'parent_model', 'parent_id', 'data'] as const;
const rows = [
  ['a', 2, 20, 200, 50, JSON.stringify(JSON.parse('{"constructor":"z","toString":"z","__proto__":"z","flag":false,"id":"shadow","version":99,"created":99,"updated":99,"archived_at":99}'))],
  ['b', 1, 10, 100, null, JSON.stringify(JSON.parse('{"constructor":"a","toString":"a","__proto__":"a","flag":true,"id":"shadow","version":99,"created":99,"updated":99,"archived_at":99}'))],
] as const;

describe('cohort raw stored-row codecs', () => {
  const rawRow = (data: string): CohortRecordRow => ({ model: 'test.Raw', id: 'raw', version: 1,
    created: 0, updated: 0, created_by: 'u', updated_by: 'u', archived_at: null,
    parent_model: null, parent_id: null, data });
  const refusedBeforeParse = (raw: string, code: 'validation' | 'limit' | 'syntax') => {
    const original = JSON.parse;
    let parses = 0;
    JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
      if (args[0] === raw) parses++;
      return original(...args);
    };
    try {
      for (const decode of [() => toCohortStoredRow(rawRow(raw)), () => toCohortStoredRows([rawRow(raw)])]) {
        assert.throws(decode, error => code === 'syntax' ? error instanceof SyntaxError :
          error instanceof StateError && error.code === code);
        assert.equal(parses, 0, 'refused raw data never reaches JSON.parse');
      }
    } finally { JSON.parse = original; }
  };
  it('admits reachable exact raw text, nodes and depth and refuses one over before parsing', () => {
    // Complete row metadata and data.text consume70 UTF16 units.
    const text = JSON.stringify({ text: '\0'.repeat(2_000_000 - 70) });
    assert.equal((toCohortStoredRow(rawRow(text)).data['text'] as string).length, 2_000_000 - 70);
    refusedBeforeParse(JSON.stringify({ text: '\0'.repeat(2_000_001 - 70) }), 'limit');
    // Row root + eight metadata values + data object + items array =11.
    const nodes = JSON.stringify({ items: Array(19_989).fill(null) });
    assert.equal((toCohortStoredRow(rawRow(nodes)).data['items'] as unknown[]).length, 19_989);
    refusedBeforeParse(JSON.stringify({ items: Array(19_990).fill(null) }), 'limit');
    let nested: unknown = null;
    for (let i = 0; i < 30; i++) nested = { v: nested };
    assert.deepEqual(toCohortStoredRow(rawRow(JSON.stringify({ nested }))).data, { nested });
    refusedBeforeParse(JSON.stringify({ nested: { v: nested } }), 'limit');
  });
  it('rejects malformed syntax before parsing and preserves ordinary own-key and scalar decoding', () => {
    for (const malformed of ['{"x":}', '{"x":01}', '{"x":"\\q"}', '{"x":1} trailing']) {
      refusedBeforeParse(malformed, 'syntax');
    }
    refusedBeforeParse('{"x":1e999}', 'validation');
    const raw = '{"__proto__":{"safe":true},"constructor":"own","escaped":"\\uD800\\u0061",' +
      '"array":[null,false,true,-0,1.25,1e2],"text":"😀"}';
    const row = rawRow(raw);
    const ordinary = toStoredRow({ ...row, data: raw });
    const actual = toCohortStoredRow(row);
    assert.deepEqual(actual, ordinary); assert.deepEqual(captureCohortRow(ordinary), ordinary);
    assert.deepEqual(toCohortStoredRows([row]), [ordinary]);
    assert.equal(Object.hasOwn(actual.data, '__proto__'), true);
    assert.ok(Object.is((actual.data['array'] as unknown[])[3], -0));
  });
});

for (const backend of ['d1', 'do'] as const) {
  describe(`${backend} metadata own keys`, () => {
    let mf: Miniflare;
    let query: (spec: QuerySpec) => Promise<ReadonlyArray<StoredRow>>;
    let execute: (sql: string, bindings: unknown[]) => Promise<Record<string, unknown>[]>;

    before(async () => {
      if (backend === 'd1') {
        mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] });
        const db = await mf.getD1Database('DB');
        await ensureSchema(db);
        execute = async (sql, bindings) => (await db.prepare(sql).bind(...bindings).all<Record<string, unknown>>()).results;
        for (const [id, version, created, updated, archived, data] of rows) {
          await db.prepare(insert).bind(model, id, version, created, updated, 'u', 'u', archived, data).run();
        }
        const store = createD1Storage(db);
        query = (spec) => store.query(spec);
      } else {
        mf = new Miniflare({
          modules: true,
          scriptPath: fileURLToPath(new URL('../../test/storage/do-test-worker.js', import.meta.url)),
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
        execute = async (sql, bindings) => (await post('/exec', { sql, params: bindings }))['rows'] as Record<string, unknown>[];
        for (const [id, version, created, updated, archived, data] of rows) {
          await post('/exec', { sql: insert, params: [model, id, version, created, updated, 'u', 'u', archived, data] });
        }
        query = async (spec) => (await post('/call', { method: 'query', args: [spec] }))['value'] as StoredRow[];
      }
    });

    after(async () => { await mf?.dispose(); });

    const spec = (extra: Partial<QuerySpec>): QuerySpec => ({ model, authority: 'viewer', archived: 'include', ...extra });

    it('gates aggregate cohort raw bytes in actual SQL before returning payload or any metadata', async () => {
      const rawModel = asModel('test.RawByteGate');
      const data = JSON.stringify({ fanoutId: 'raw', text: 'x'.repeat(1_810_000) });
      for (let index = 0; index < 7; index++) {
        await execute(insert, [rawModel, `raw-${index}`, 1, 0, 0, 'u', 'u', null, data]);
      }
      const request = { model: rawModel, fanoutId: 'raw', after: null, limit: 100, expectedRevision: 0 as Revision };
      const page = compileCohortRowPage(request);
      const gated = await execute(page.sql, page.bindings);
      assert.equal(gated.length, 7);
      for (const row of gated) {
        for (const column of cohortColumns) {
          assert.equal(row[column], null, `SQL withheld ${column}`);
        }
      }
      const single = compileCohortRowPage({ ...request, limit: 1 });
      const bounded = await execute(single.sql, single.bindings);
      assert.equal(bounded.length, 1); assert.equal(bounded[0]!['data'], data);
      assert.equal(bounded[0]!['model'], rawModel); assert.equal(bounded[0]!['id'], 'raw-0');
      assert.equal(bounded[0]!['version'], 1); assert.equal(bounded[0]!['created'], 0);
      assert.equal(bounded[0]!['updated'], 0); assert.equal(bounded[0]!['archived_at'], null);
    });

    it('withholds reachable aggregate SQL text and blobs in numeric slots and retains bounded archived point reads', async () => {
      const rawModel = asModel('test.RawNumericByteGate');
      const id = 'numeric-0' as RecordId;
      const data = JSON.stringify({ fanoutId: 'raw' });
      for (let index = 0; index < 7; index++) {
        await execute(insert, [rawModel, `numeric-${index}`, 1, 0, 0, 'u', 'u', null, data]);
      }
      const point = compileCohortRowLoad({ model: rawModel, id, expectedRevision: 0 as Revision });
      const page = compileCohortRowPage({ model: rawModel, fanoutId: 'raw', after: null, limit: 100, expectedRevision: 0 as Revision });
      const valid = await execute(point.sql, point.bindings);
      assert.equal(valid.length, 1);
      const admitted = toCohortStoredRow(valid[0] as unknown as CohortRecordRow);
      assert.equal(admitted.version, 1); assert.equal(admitted.created, 0);
      assert.equal(admitted.updated, 0); assert.equal(admitted.archivedAt, null);
      for (const column of ['version', 'created', 'updated'] as const) {
        for (const kind of ['text', 'blob'] as const) {
          // Seven reachable1.81MB values exceed the page cap. A single
          //12.64MB value is refused by these platforms' SQLITE_TOOBIG limit.
          const expression = kind === 'text' ? 'CAST(zeroblob(1810000) AS TEXT)' : 'zeroblob(1810000)';
          await execute(`UPDATE records SET ${column} = ${expression} WHERE model = ?`, [rawModel]);
          const physical = await execute(`SELECT typeof(${column}) AS kind, length(CAST(${column} AS BLOB)) AS bytes FROM records WHERE model = ? AND id = ?`, [rawModel, id]);
          assert.equal(physical[0]!['kind'], kind); assert.equal(physical[0]!['bytes'], 1_810_000);
          const withheld = await execute(page.sql, page.bindings);
          assert.equal(withheld.length, 7);
          for (const row of withheld) {
            for (const field of cohortColumns) assert.equal(row[field], null, `${kind} ${column}: ${field}`);
          }
          assert.throws(() => toCohortStoredRow(withheld[0] as unknown as CohortRecordRow), error =>
            error instanceof StateError && error.code === 'limit' && error.retryable === false);
          await execute(`UPDATE records SET ${column} = ? WHERE model = ?`, [column === 'version' ? 1 : 0, rawModel]);
        }
      }
      assert.deepEqual(toCohortStoredRow((await execute(point.sql, point.bindings))[0] as unknown as CohortRecordRow), admitted);
      // Archived rows are correctly excluded from live pages. An above-cap
      // archived point is unreachable under the actual platform value limit;
      // exercise the unchanged include-archived point with bounded text/blob.
      for (const kind of ['text', 'blob'] as const) {
        const expression = kind === 'text' ? "'bounded archive'" : 'zeroblob(16)';
        await execute(`UPDATE records SET archived_at = ${expression} WHERE model = ? AND id = ?`, [rawModel, id]);
        const bounded = await execute(`SELECT model, id, data, typeof(archived_at) AS kind, length(CAST(archived_at AS BLOB)) AS bytes FROM (${point.sql})`, point.bindings);
        assert.equal(bounded.length, 1); assert.equal(bounded[0]!['kind'], kind);
        assert.equal(bounded[0]!['bytes'], kind === 'text' ? 15 : 16);
        assert.equal(bounded[0]!['model'], rawModel); assert.equal(bounded[0]!['id'], id);
        assert.equal(bounded[0]!['data'], data);
        const live = await execute(page.sql, page.bindings);
        assert.equal(live.length, 6); assert.ok(live.every(row => row['id'] !== id));
        await execute('UPDATE records SET archived_at = NULL WHERE model = ? AND id = ?', [rawModel, id]);
      }
      assert.deepEqual(toCohortStoredRow((await execute(point.sql, point.bindings))[0] as unknown as CohortRecordRow), admitted);
    });

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
