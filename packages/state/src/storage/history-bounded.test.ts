import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMemoryStorage } from './memory.js';
import { StateError } from '../errors.js';
import { toBoundedHistory, type BoundedHistoryRow } from './sqlite-codecs.js';
import { exerciseBoundedHistory } from './history-bounded-fixtures.js';

describe('bounded history retrieval', () => {
  it('bounds complete memory history, retains insertion order and fences reopened handles', async () => {
    const { store, reopen } = createTestMemoryStorage();
    await exerciseBoundedHistory(store, reopen);
  });
  it('refuses withheld SQL payloads before malformed JSON is decoded', () => {
    const row: BoundedHistoryRow = { history_refusal: 2, model: 'm', record_id: 'r', version: 1,
      operation: 'op', operation_id: 'id', actor: 'a', at: 1, change: 'update', before: '{malformed', after: null,
      audit_projection: null };
    assert.throws(() => toBoundedHistory([row], 100), error => error instanceof StateError && error.code === 'limit');
    assert.throws(() => toBoundedHistory([{ ...row, history_refusal: 0,
      before: '{"text":"' + 'x'.repeat(2_000_001) }], 100),
    error => error instanceof StateError && error.code === 'limit');
  });
});
