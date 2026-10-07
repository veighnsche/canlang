import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { D1Database, DurableObjectStorage } from '@cloudflare/workers-types';
import type { ModelName } from '@canlang/contracts';
import { deepFreeze, getDataPath } from '../src/internal/own-data.js';
import { createD1Storage } from '../src/storage/d1.js';
import { createDOStorage } from '../src/storage/durable-object.js';
import type { RecordRow } from '../src/storage/sqlite-codecs.js';

test('own-data traversal preserves own getter timing and array opacity', () => {
  const calls: string[] = [];
  const child = { get leaf() { calls.push('leaf'); return null; } };
  const value = { get child() { calls.push('child'); return child; }, array: [child] };
  assert.equal(getDataPath(value, 'child.leaf'), null);
  assert.deepEqual(calls, ['child', 'leaf']);
  assert.equal(getDataPath(value, 'toString'), undefined);
  assert.equal(getDataPath(value, 'array.0.leaf'), undefined);
  assert.deepEqual(calls, ['child', 'leaf']);
});

test('deep freeze preserves sibling getter order, cyclic graphs, and thrown identity', () => {
  const calls: string[] = [];
  const child = { get leaf() { calls.push('leaf'); return 1; } };
  const value = {
    get first() { calls.push('first'); return child; },
    get second() { calls.push('second'); return child; },
  };
  assert.equal(deepFreeze(value), value);
  assert.deepEqual(calls, ['first', 'second', 'leaf']);
  assert.ok(Object.isFrozen(value) && Object.isFrozen(child));
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.equal(deepFreeze(cycle), cycle);
  assert.ok(Object.isFrozen(cycle));
  const sentinel = new Error('getter');
  const hostile = { get member(): unknown { throw sentinel; } };
  assert.throws(() => deepFreeze(hostile), (error) => error === sentinel);
  assert.equal(Object.isFrozen(hostile), false);
});

test('both adapter query routes reject the entire result at the first invalid JSON row', async () => {
  const raw: RecordRow = {
    model: 'items', id: 'one', version: 1, created: 0, updated: 0,
    created_by: 'actor', updated_by: 'actor', archived_at: null,
    parent_model: null, parent_id: null, data: '{"ready":true}',
  };
  let laterReads = 0;
  const rows = [raw, { ...raw, data: '{' }, {
    ...raw, get data(): string { laterReads++; throw new Error('later row'); },
  }];
  const d1 = {
    prepare() { return { bind() { return { all: async () => ({ results: rows }) }; } }; },
  } as unknown as D1Database;
  const durable = {
    sql: { exec() { return { toArray: () => rows }; } },
  } as unknown as DurableObjectStorage;
  for (const adapter of [createD1Storage(d1), createDOStorage(durable)]) {
    await assert.rejects(adapter.query({ model: 'items' as ModelName, authority: 'viewer' }), SyntaxError);
    assert.equal(laterReads, 0);
  }
});
