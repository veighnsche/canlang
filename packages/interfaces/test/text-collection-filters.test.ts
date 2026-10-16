/**
 * C2 text-equality host preparer tests (CAN18-v1 C2/C3 rule batch).
 *
 * A `text` filter column carries no option inventory (exactly like a
 * reference): defaults admit a bounded string or null, requests admit a
 * bounded string with empty clearing the control (DESIGN 975 scalar +
 * DESIGN 1023 empty-means-unrestricted), and every active selection
 * emits the existing `{op:eq}` condition shape the query adapter
 * evaluates with the ordinary string equality (operator table). A
 * smuggled inventory on a text column, a non-string default, malformed
 * request text (control characters, over-long), duplicate/unknown
 * selectors and the legacy `filter[field]` envelope refuse with
 * `validation` before any query.
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
  { field: 'category', label: 'Category', type: 'text', valueLabels: {} },
];

const prepare = (entries: [string, string][]) => {
  const request = testRequest(`/hello?${new URLSearchParams(entries)}`);
  return buildPresentationContext({ request, pathname: '/hello', isPartial: false, appDefaultLocale: 'en',
    csrfToken: '', principal: fakeIdentity(), query: async () => ({ rows: [], columns: [] }) }).prepareCollectionFilters!;
};

const refuses = (run: () => unknown) => assert.throws(run, (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'validation');

test('collection text filters preserve typed conditions, precedence and frozen shapes', () => {
  const plain = prepare([]);
  assert.deepEqual(plain(occurrence, fields), []);
  assert.deepEqual(plain(occurrence, fields, { category: 'ops' }),
    [{ field: 'category', op: 'eq', value: 'ops' }]);
  assert.deepEqual(plain(occurrence, fields, { category: null }), []);
  // DESIGN 1023: an empty text default means no restriction, exactly
  // like a cleared request value.
  assert.deepEqual(plain(occurrence, fields, { category: '' }), []);
  const [condition] = plain(occurrence, fields, { category: 'ops' });
  assert.equal(condition!.op, 'eq');
  assert.equal(typeof condition!.value, 'string');
  // Saved/request precedence: explicit request wins, explicit clear
  // stays cleared.
  assert.deepEqual(
    prepare([[collectionFilterName(occurrence, 'category'), 'tech']])(occurrence, fields, { category: 'ops' }),
    [{ field: 'category', op: 'eq', value: 'tech' }]);
  assert.deepEqual(
    prepare([[collectionFilterName(occurrence, 'category'), '']])(occurrence, fields, { category: 'ops' }), []);
});

test('collection text filters refuse malformed descriptors, defaults and selectors', () => {
  const plain = prepare([]);
  for (const entries of [
    [[collectionFilterName(occurrence, 'category'), 'o\x01ps']],
    [[collectionFilterName(occurrence, 'category'), 'x'.repeat(201)]],
    [[collectionFilterName(occurrence, 'category'), 'ops'], [collectionFilterName(occurrence, 'category'), 'tech']],
    [[collectionFilterName(occurrence, 'unknown'), 'ops']],
    [['filter[category]', 'ops']], [['f[category]', 'ops']],
  ] as [string, string][][]) refuses(() => prepare(entries)(occurrence, fields));
  for (const defaults of [{ unknown: 'ops' }, { category: 1 }, { category: true },
    { category: ['ops'] }] as Record<string, unknown>[]) {
    refuses(() => plain(occurrence, fields, defaults as Record<string, string | null>));
  }
  // A text column must not smuggle an option inventory; the type tag
  // is exactly `text` and the labels map stays empty.
  for (const columns of [[fields[0]!, fields[0]!], [{ ...fields[0]!, type: 'Text' }],
    [{ ...fields[0]!, type: 'textplain' }], [{ ...fields[0]!, type: 'enum:App.Item.state' }],
    [{ ...fields[0]!, valueLabels: { ops: 'Ops' } }], [{ ...fields[0]!, field: '' }]]) {
    refuses(() => plain(occurrence, columns));
  }
  refuses(() => plain('', fields));
});

test('collection text filter conditions stay frozen eq shapes', () => {
  const conditions = prepare([])(occurrence, fields, { category: 'ops' });
  assert.equal(Object.isFrozen(conditions), true);
  assert.equal(Object.isFrozen(conditions[0]), true);
  assert.deepEqual(conditions, [{ field: 'category', op: 'eq', value: 'ops' }]);
});
