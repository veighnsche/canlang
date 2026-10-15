import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredRow, QuerySpec } from '@canlang/contracts';
import { queryRecords, queryRecordsObserved, queryRecordSourcePresence, type ViewerRecordsInput } from '../../src/query/engine.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { bindInstalledSourceQueryPredicate, type InstalledSourceQueryPredicate } from '../../src/receipt/read-policy-membership.js';
import { openFenceScope } from '../../src/invocation/admission.js';
import {
  asModel, asRevision, captureStateError, createMemoryIdentityStore, makeRow,
} from '../invocation/fixtures.js';
import { grant, modelPolicy, policyTable } from './fixtures.js';

const MODEL = asModel('Acme.Observed');

function setup(rows: StoredRow[]) {
  const scans: QuerySpec[] = [];
  const store = {
    ...createMemoryStorage(),
    query: async (spec: QuerySpec) => { scans.push(spec); return rows; },
  };
  const input: ViewerRecordsInput = {
    model: MODEL, authority: 'viewer', store,
    memberships: createMemoryIdentityStore(),
    context: { actorUserId: null, teamId: null },
    policy: policyTable(modelPolicy(MODEL, {
      secretFields: ['details.secret'],
      grants: [grant('public', ['title', 'details'], { op: 'eq', field: 'visible', value: true })],
    })),
  };
  return { input, scans };
}

function row(id: string, created: number, title: string, visible = true): StoredRow {
  return makeRow({ id, created, data: {
    title, visible, denied: 'private', details: { label: title, secret: 'secret' },
  } });
}

describe('internal observed query execution', () => {
  it('retains scan identities and detached projections for every visible candidate, including false results', async () => {
    const raw = [row('where-false', 1, 'skip'), row('predicate-false', 2, 'reject'),
      row('selected', 3, 'accept'), row('hidden', 4, 'accept', false)];
    const { input, scans } = setup(raw);
    const calls: StoredRow[] = [];
    let active = false;
    const result = await queryRecordsObserved({
      ...input, where: { op: 'ne', field: 'title', value: 'skip' },
    }, async (projected, original) => {
      assert.equal(active, false);
      active = true;
      calls.push(original);
      assert.deepEqual(Object.keys(projected.data).sort(), ['details', 'title']);
      assert.equal((projected.data.details as Record<string, unknown>).secret, undefined);
      const accepted = projected.data.title === 'accept';
      (projected.data.details as Record<string, unknown>).label = 'changed by callback';
      (projected.data as Record<string, unknown>).title = 'changed by callback';
      await Promise.resolve();
      active = false;
      return accepted;
    });
    assert.deepEqual(calls, [raw[1], raw[2]]);
    assert.equal(calls[0], raw[1]);
    assert.equal(calls[1], raw[2]);
    assert.equal(result.candidates.length, 3);
    result.candidates.forEach((candidate, index) => assert.equal(candidate.row, raw[index]));
    assert.deepEqual(result.candidates.map(candidate => candidate.matched), [false, false, true]);
    assert.deepEqual(result.candidates.map(candidate => candidate.record.data.title), ['skip', 'reject', 'accept']);
    assert.deepEqual(result.candidates.map(candidate => candidate.record.data.details),
      [{ label: 'skip' }, { label: 'reject' }, { label: 'accept' }]);
    assert.deepEqual(result.records.map(record => record.data.title), ['accept']);
    assert.deepEqual(result.selectedIndices, [2]);
    assert.equal(raw[2]!.data.title, 'accept');
    assert.deepEqual(raw[2]!.data.details, { label: 'accept', secret: 'secret' });
    assert.equal(scans.length, 1);
    assert.equal(scans[0]!.limit, undefined);
    assert.equal(scans[0]!.where, undefined);
    assert.equal(result.revision, await input.store.readRevision());
  });

  it('correlates authored and default order with candidate indices without re-running predicates', async () => {
    const raw = [row('z', 30, 'Beta'), row('b', 10, 'Alpha'), row('a', 10, 'Alpha')];
    const { input } = setup(raw);
    for (const order of [undefined, [{ field: 'title', direction: 'desc' as const }]]) {
      const calls: StoredRow[] = [];
      const result = await queryRecordsObserved({ ...input, ...(order === undefined ? {} : { order }) },
        (_projected, original) => { calls.push(original); return true; });
      assert.deepEqual(calls, raw);
      assert.deepEqual(result.selectedIndices, order === undefined ? [2, 1, 0] : [0, 2, 1]);
      assert.deepEqual(result.selectedIndices.map(index => result.candidates[index]!.record.id),
        result.records.map(record => record.id));
    }
  });

  it('positively reports empty scans and entirely hidden domains without predicate execution', async () => {
    for (const rows of [[], [row('hidden', 1, 'private', false)]]) {
      const { input } = setup(rows);
      let calls = 0;
      const result = await queryRecordsObserved(input, () => { calls++; return true; });
      assert.deepEqual(result.candidates, []);
      assert.deepEqual(result.records, []);
      assert.deepEqual(result.selectedIndices, []);
      assert.equal(calls, 0);
    }
  });

  it('preserves overflow refusal after one execution per candidate and scans without a storage limit', async () => {
    const { input, scans } = setup([row('a', 1, 'Alpha'), row('b', 2, 'Beta')]);
    let calls = 0;
    const error = await captureStateError(queryRecordsObserved({ ...input, limit: 1 }, () => {
      calls++; return true;
    }));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /over the limit/);
    assert.equal(calls, 2);
    assert.equal(scans[0]!.limit, undefined);
  });

  it('refuses stale checkpoints and denied where paths before scanning or calling the predicate', async () => {
    const { input, scans } = setup([row('a', 1, 'Alpha')]);
    let calls = 0;
    const predicate = () => { calls++; return true; };
    const fence = openFenceScope(asRevision(99), 'team');
    const stale = await captureStateError(queryRecordsObserved({ ...input, fence }, predicate));
    assert.equal(stale.code, 'conflict');
    assert.deepEqual(fence.snapshot().dependencies, []);
    const denied = await captureStateError(queryRecordsObserved({
      ...input, where: { op: 'eq', field: 'denied', value: 'private' },
    }, predicate));
    assert.equal(denied.code, 'validation');
    assert.equal(scans.length, 0);
    assert.equal(calls, 0);
  });
});


describe('private projected query source presence', () => {
  it('retains only frozen same-snapshot names on exact viewer rows and predicate projections', async () => {
    const original = makeRow({ id: 'presence', data: { enabled: true, rank: 2, optionalNull: null } });
    const { input } = setup([original]);
    const query: ViewerRecordsInput = { ...input,
      policy: policyTable(modelPolicy(MODEL, {
        grants: [grant('public', ['enabled', 'optionalNull', 'optionalAbsent'])],
      })),
    };
    const revision = await query.store.readRevision();
    let predicateRow: unknown;
    const result = await queryRecords({ ...query, predicate: async record => {
      predicateRow = record;
      assert.deepEqual(queryRecordSourcePresence(record, MODEL, revision), ['enabled', 'rank', 'optionalNull']);
      assert.equal(Object.hasOwn(record.data, 'rank'), false);
      assert.equal(Object.hasOwn(record.data, 'optionalAbsent'), false);
      return true;
    } });
    const record = result.records[0]!;
    const fields = queryRecordSourcePresence(record, MODEL, result.revision)!;
    assert.deepEqual(fields, ['enabled', 'rank', 'optionalNull']);
    assert.equal(record.data.optionalNull, null);
    assert.equal(Object.hasOwn(record.data, 'rank'), false);
    assert.equal(Object.hasOwn(record.data, 'optionalAbsent'), false);
    assert.equal(Object.isFrozen(fields), true);
    assert.throws(() => (fields as string[]).push('invented'), TypeError);
    assert.equal(queryRecordSourcePresence(record, asModel('Acme.Other'), result.revision), undefined);
    assert.equal(queryRecordSourcePresence(record, MODEL, asRevision(Number(result.revision) + 1)), undefined);
    assert.equal(queryRecordSourcePresence({ ...record }, MODEL, result.revision), undefined);
    assert.equal(queryRecordSourcePresence(structuredClone(record), MODEL, result.revision), undefined);
    assert.equal(queryRecordSourcePresence(original, MODEL, result.revision), undefined);
    const editable = record as unknown as { id: string; version: number };
    const id = editable.id, version = editable.version;
    editable.id = 'other';
    assert.equal(queryRecordSourcePresence(record, MODEL, result.revision), undefined);
    editable.id = id;
    editable.version = version + 1;
    assert.equal(queryRecordSourcePresence(record, MODEL, result.revision), undefined);
    editable.version = version;
    Object.defineProperty(record, 'version', { configurable: true, get: () => { throw new Error('must not execute'); } });
    assert.equal(queryRecordSourcePresence(record, MODEL, result.revision), undefined);
    Object.defineProperty(record, 'version', { configurable: true, writable: true, value: version });
    assert.deepEqual(queryRecordSourcePresence(predicateRow, MODEL, result.revision), fields);
    const observed = await queryRecordsObserved(query, projected => {
      assert.deepEqual(queryRecordSourcePresence(projected, MODEL, revision), fields);
      return true;
    });
    assert.deepEqual(queryRecordSourcePresence(observed.candidates[0]!.record, MODEL, revision), fields);
    let coherentCalls = 0;
    const coherent: InstalledSourceQueryPredicate = async projected => {
      coherentCalls++;
      assert.deepEqual(queryRecordSourcePresence(projected, MODEL, revision), fields);
      return true;
    };
    bindInstalledSourceQueryPredicate(coherent, { source: { path: 'presence.can', sha256: 'a'.repeat(64), module: 'Acme' },
      rule: 'Acme.Presence' });
    await queryRecords({ ...query, predicate: coherent });
    assert.ok(coherentCalls > 0);
    const owner = await queryRecords({ ...input, authority: 'owner' });
    assert.equal(queryRecordSourcePresence(owner.rows[0], MODEL, owner.revision), undefined);
    (original.data as Record<string, unknown>).later = true;
    assert.deepEqual(queryRecordSourcePresence(record, MODEL, revision), fields);
    assert.equal(fields.includes('later'), false);
  });
});
