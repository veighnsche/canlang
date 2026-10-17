/**
 * C3 civil-date equality host preparer tests (CAN18-v1 C3 rule batch).
 *
 * A `date` filter column carries no option inventory (exactly like
 * text/a reference): defaults admit a civil `YYYY-MM-DD` date or null,
 * requests admit a civil date with empty clearing the control (DESIGN
 * 1015-1025 operator table + DESIGN 1023 empty-means-unrestricted),
 * and every active selection emits the existing `{op:eq}` condition
 * shape the query adapter evaluates with the exact typed equality
 * (operator table). Impossible calendar dates, non-date strings, a
 * smuggled inventory on a date column, non-string defaults,
 * duplicate/unknown selectors and the legacy `filter[field]`
 * envelope refuse with `validation` before any query.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionFilterName } from '@canlang/contracts';
import type { ColumnMeta } from '@canlang/contracts';
import { buildPresentationContext } from '../src/http/presentation.js';
import { testRequest } from '../src/testing.js';
import type { ResolvedIdentity } from '@canlang/contracts';

function fakeIdentity(): ResolvedIdentity {
  return {
    actor: null,
    team: null,
    membership: null,
    binding: { kind: 'none' },
    admitted_at: new Date(0).toISOString(),
  };
}

const occurrence = 'page:/hello/list:1';
const fields: ColumnMeta[] = [
  { field: 'due', label: 'Due', type: 'date', valueLabels: {} },
];

const prepare = (entries: [string, string][]) => {
  const request = testRequest(`/hello?${new URLSearchParams(entries)}`);
  return buildPresentationContext({ request, pathname: '/hello', isPartial: false, appDefaultLocale: 'en',
    csrfToken: '', principal: fakeIdentity(), query: async () => ({ rows: [], columns: [] }) }).prepareCollectionFilters!;
};

const refuses = (run: () => unknown) => assert.throws(run, (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'validation');

test('collection date filters preserve typed conditions, precedence and frozen shapes', () => {
  const plain = prepare([]);
  assert.deepEqual(plain(occurrence, fields), []);
  assert.deepEqual(plain(occurrence, fields, { due: '2026-10-01' }),
    [{ field: 'due', op: 'eq', value: '2026-10-01' }]);
  assert.deepEqual(plain(occurrence, fields, { due: null }), []);
  // DESIGN 1023: an empty date default means no restriction, exactly
  // like a cleared request value.
  assert.deepEqual(plain(occurrence, fields, { due: '' }), []);
  const [condition] = plain(occurrence, fields, { due: '2026-10-01' });
  assert.equal(condition!.op, 'eq');
  assert.equal(typeof condition!.value, 'string');
  // Leap days are real civil dates; month lengths are enforced.
  assert.deepEqual(plain(occurrence, fields, { due: '2024-02-29' }),
    [{ field: 'due', op: 'eq', value: '2024-02-29' }]);
  // Saved/request precedence: explicit request wins, explicit clear
  // stays cleared.
  assert.deepEqual(
    prepare([[collectionFilterName(occurrence, 'due'), '2026-09-30']])(occurrence, fields, { due: '2026-10-01' }),
    [{ field: 'due', op: 'eq', value: '2026-09-30' }]);
  assert.deepEqual(
    prepare([[collectionFilterName(occurrence, 'due'), '']])(occurrence, fields, { due: '2026-10-01' }), []);
});

test('collection date filters refuse malformed descriptors, defaults and selectors', () => {
  const plain = prepare([]);
  for (const entries of [
    [[collectionFilterName(occurrence, 'due'), '2026-13-01']],
    [[collectionFilterName(occurrence, 'due'), '2026-02-30']],
    [[collectionFilterName(occurrence, 'due'), '2023-02-29']],
    [[collectionFilterName(occurrence, 'due'), 'not-a-date']],
    [[collectionFilterName(occurrence, 'due'), '2026-10-01T00:00:00.000Z']],
    [[collectionFilterName(occurrence, 'due'), '2026-10-01 ']],
    [[collectionFilterName(occurrence, 'due'), '2026-10-01'], [collectionFilterName(occurrence, 'due'), '2026-09-30']],
    [[collectionFilterName(occurrence, 'unknown'), '2026-10-01']],
    [['filter[due]', '2026-10-01']], [['f[due]', '2026-10-01']],
  ] as [string, string][][]) refuses(() => prepare(entries)(occurrence, fields));
  for (const defaults of [{ unknown: '2026-10-01' }, { due: 1 }, { due: true },
    { due: ['2026-10-01'] }, { due: '2026-13-01' }, { due: 'nope' }] as Record<string, unknown>[]) {
    refuses(() => plain(occurrence, fields, defaults as Record<string, string | null>));
  }
  // A date column must not smuggle an option inventory; the type tag
  // is exactly `date` and the labels map stays empty.
  for (const columns of [[fields[0]!, fields[0]!], [{ ...fields[0]!, type: 'Date' }],
    [{ ...fields[0]!, type: 'datetime' }],
    [{ ...fields[0]!, type: 'enum:App.Item.state' }],
    [{ ...fields[0]!, valueLabels: { '2026-10-01': 'Oct' } }], [{ ...fields[0]!, field: '' }]]) {
    refuses(() => plain(occurrence, columns));
  }
  refuses(() => plain('', fields));
});

test('collection date filter conditions stay frozen eq shapes', () => {
  const conditions = prepare([])(occurrence, fields, { due: '2026-10-01' });
  assert.equal(Object.isFrozen(conditions), true);
  assert.equal(Object.isFrozen(conditions[0]), true);
  assert.deepEqual(conditions, [{ field: 'due', op: 'eq', value: '2026-10-01' }]);
});
