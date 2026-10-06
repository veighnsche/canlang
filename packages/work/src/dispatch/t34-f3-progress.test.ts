/**
 * T34-F3 fanout progress + scheduling: aggregate attention when
 * terminal-with-failures (never success), data-minimized counts, and
 * bounded fair turns that progress ALL admitted children (M8, no
 * starvation). Chunk size bounds one turn only, never the cohort.
 *
 * Scope: progress/scheduling only. Claim lives in
 * `t34-f3-claim.test.ts`; record/retry lives in
 * `t34-f3-record.test.ts`. No membership enumeration (F5), no
 * recovery scanning (F4), no quota, no syntax.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FanoutChildId } from '../../../contracts/src/work.js';
import type { StoredRow } from '../../../contracts/src/state.js';
import { TestOnlyManualClock } from '../ports.ts';
import {
  fanoutChildRowId,
  fanoutIntentRowId,
  newFanoutChildRow,
  readFanoutChildRow,
} from '../kernel/tables.ts';
import {
  TestOnlyMemoryFanoutChildStore,
  planFanoutTurn,
  summarizeFanoutChildren,
} from './index.ts';

const META = { nowMs: 1_758_000_000_000, actor: 't34-f3-test' };
const OCC = 'occ_f3_progress';
const HANDLER = 'Shift.review_commitment';
const FANOUT = fanoutIntentRowId(OCC, HANDLER, 'model');
const POLICY = { maxAttempts: 3, horizonMs: 60_000 };

function child(recordId: string): FanoutChildId {
  return { parentOccurrence: OCC, handler: HANDLER, recordId };
}

function storeWith(recordIds: readonly string[]): TestOnlyMemoryFanoutChildStore {
  const store = new TestOnlyMemoryFanoutChildStore(new TestOnlyManualClock(META.nowMs));
  for (const recordId of recordIds) {
    store.insert(
      newFanoutChildRow(
        { fanoutId: FANOUT, parentOccurrence: OCC, handler: HANDLER, recordId },
        META,
      ),
    );
  }
  return store;
}

function claim(store: TestOnlyMemoryFanoutChildStore, id: FanoutChildId): void {
  const outcome = store.claim(() => true, {
    child: id,
    snapshotVersion: null,
    guard: { predicate: null },
    frozenInputs: {},
    readCurrentSnapshot: () => ({}),
  });
  assert.equal(outcome.status, 'claimed');
}

describe('t34-f3 progress: attention on terminal failure, never success', () => {
  it('reports attention when terminal with failures (never successful completion)', () => {
    const store = storeWith(['p-1', 'p-2', 'p-3']);
    claim(store, child('p-1'));
    store.record({ child: child('p-1'), result: { kind: 'completed' }, nowMs: META.nowMs, firstAttemptAtMs: META.nowMs, policy: POLICY });
    claim(store, child('p-2'));
    store.record({ child: child('p-2'), result: { kind: 'skipped', reason: 'deleted' }, nowMs: META.nowMs, firstAttemptAtMs: META.nowMs, policy: POLICY });
    claim(store, child('p-3'));
    store.record({ child: child('p-3'), result: { kind: 'failed', reason: 'business-rejection' }, nowMs: META.nowMs, firstAttemptAtMs: META.nowMs, policy: POLICY });
    const progress = summarizeFanoutChildren(FANOUT, store.listAll());
    assert.deepEqual(progress, {
      fanoutId: FANOUT,
      pending: 0,
      running: 0,
      completed: 1,
      skipped: 1,
      failed: 1,
      terminal: true,
      attention: true,
    });
  });

  it('reports clean terminal success only with zero failures', () => {
    const store = storeWith(['c-1', 'c-2']);
    claim(store, child('c-1'));
    store.record({ child: child('c-1'), result: { kind: 'completed' }, nowMs: META.nowMs, firstAttemptAtMs: META.nowMs, policy: POLICY });
    claim(store, child('c-2'));
    store.record({ child: child('c-2'), result: { kind: 'skipped', reason: 'non-applicable' }, nowMs: META.nowMs, firstAttemptAtMs: META.nowMs, policy: POLICY });
    const progress = summarizeFanoutChildren(FANOUT, store.listAll());
    assert.deepEqual([progress.terminal, progress.attention, progress.failed], [true, false, 0]);
  });

  it('stays non-terminal (no attention) while any child is pending or running', () => {
    const store = storeWith(['n-1', 'n-2', 'n-3']);
    claim(store, child('n-1'));
    store.record({ child: child('n-1'), result: { kind: 'failed', reason: 'terminal' }, nowMs: META.nowMs, firstAttemptAtMs: META.nowMs, policy: POLICY });
    claim(store, child('n-2'));
    // n-2 running, n-3 pending: failures exist but the fanout is not terminal.
    const progress = summarizeFanoutChildren(FANOUT, store.listAll());
    assert.deepEqual(
      [progress.pending, progress.running, progress.failed, progress.terminal, progress.attention],
      [1, 1, 1, false, false],
    );
  });

  it('carries data-minimized counts only (no child rows leak)', () => {
    const store = storeWith(['d-1']);
    const progress = summarizeFanoutChildren(FANOUT, store.listAll());
    assert.deepEqual(Object.keys(progress).sort(), [
      'attention',
      'completed',
      'failed',
      'fanoutId',
      'pending',
      'running',
      'skipped',
      'terminal',
    ]);
    assert.ok(!JSON.stringify(progress).includes('d-1'));
  });

  it('refuses cross-fanout rows (no leak across fanouts)', () => {
    const otherFanout = fanoutIntentRowId('occ_other', HANDLER, 'model');
    const rows: StoredRow[] = [
      newFanoutChildRow(
        { fanoutId: FANOUT, parentOccurrence: OCC, handler: HANDLER, recordId: 'x-1' },
        META,
      ),
      newFanoutChildRow(
        { fanoutId: otherFanout, parentOccurrence: 'occ_other', handler: HANDLER, recordId: 'x-1' },
        META,
      ),
    ];
    assert.throws(() => summarizeFanoutChildren(FANOUT, rows), /one fanoutId/);
  });
});

describe('t34-f3 scheduling: bounded turns progress ALL children (no starvation)', () => {
  function ids(rows: readonly StoredRow[]): string[] {
    return rows.map((row) => row.id as string);
  }

  it('pages pending children id-sorted with an honest resume signal', () => {
    const store = storeWith(['s-3', 's-1', 's-2', 's-5', 's-4']);
    const rows = store.listAll();
    const first = planFanoutTurn({ rows, cursor: null, limit: 2 });
    assert.deepEqual([first.done, first.batch.length], [false, 2]);
    assert.deepEqual(ids(first.batch), [
      fanoutChildRowId(OCC, HANDLER, 's-1'),
      fanoutChildRowId(OCC, HANDLER, 's-2'),
    ]);
    assert.ok(first.cursor !== null);
    const second = planFanoutTurn({ rows, cursor: first.cursor, limit: 2 });
    assert.deepEqual([second.done, second.batch.length], [false, 2]);
    assert.deepEqual(ids(second.batch), [
      fanoutChildRowId(OCC, HANDLER, 's-3'),
      fanoutChildRowId(OCC, HANDLER, 's-4'),
    ]);
    assert.ok(second.cursor !== null);
    const third = planFanoutTurn({ rows, cursor: second.cursor, limit: 2 });
    assert.deepEqual([third.done, third.cursor, third.batch.length], [true, null, 1]);
    assert.deepEqual(ids(third.batch), [fanoutChildRowId(OCC, HANDLER, 's-5')]);
  });

  it('schedules pending only: running and terminal rows never reschedule', () => {
    const store = storeWith(['m-1', 'm-2', 'm-3']);
    claim(store, child('m-1'));
    store.record({ child: child('m-1'), result: { kind: 'completed' }, nowMs: META.nowMs, firstAttemptAtMs: META.nowMs, policy: POLICY });
    claim(store, child('m-2'));
    // m-1 completed, m-2 running, m-3 pending: only m-3 schedules.
    const turn = planFanoutTurn({ rows: store.listAll(), cursor: null, limit: 10 });
    assert.deepEqual(turn.done, true);
    assert.deepEqual(ids(turn.batch), [fanoutChildRowId(OCC, HANDLER, 'm-3')]);
  });

  it('is fair under a stalled child: the sweep continues past the retry', () => {
    const store = storeWith(['f-1', 'f-2', 'f-3']);
    const first = planFanoutTurn({ rows: store.listAll(), cursor: null, limit: 1 });
    assert.deepEqual(ids(first.batch), [fanoutChildRowId(OCC, HANDLER, 'f-1')]);
    assert.ok(first.cursor !== null);
    // f-1 stalls: claim + transient puts it back to pending under the same id.
    claim(store, child('f-1'));
    const retried = store.record({
      child: child('f-1'),
      result: { kind: 'transient' },
      nowMs: META.nowMs,
      firstAttemptAtMs: META.nowMs,
      policy: POLICY,
    });
    assert.equal(retried.status, 'retried');
    assert.equal(readFanoutChildRow((retried as { row: StoredRow }).row).state, 'pending');
    // The sweep continues past the stalled child: f-2 next, not f-1 again.
    const second = planFanoutTurn({ rows: store.listAll(), cursor: first.cursor, limit: 1 });
    assert.deepEqual(ids(second.batch), [fanoutChildRowId(OCC, HANDLER, 'f-2')]);
    assert.ok(second.cursor !== null);
    const third = planFanoutTurn({ rows: store.listAll(), cursor: second.cursor, limit: 1 });
    assert.deepEqual(ids(third.batch), [fanoutChildRowId(OCC, HANDLER, 'f-3')]);
    // A fresh sweep revisits the stalled child: retried work is not lost.
    const fresh = planFanoutTurn({ rows: store.listAll(), cursor: null, limit: 10 });
    assert.ok(ids(fresh.batch).includes(fanoutChildRowId(OCC, HANDLER, 'f-1')));
  });

  it('chunk size is not cohort size: every limit visits the same identities', () => {
    const store = storeWith(['k-1', 'k-2', 'k-3', 'k-4', 'k-5']);
    const collect = (limit: number): string[] => {
      const rows = store.listAll();
      let cursor: string | null = null;
      const visited: string[] = [];
      for (;;) {
        const turn = planFanoutTurn({ rows, cursor, limit });
        for (const row of turn.batch) {
          visited.push(row.id as string);
        }
        if (turn.done) {
          return visited;
        }
        cursor = turn.cursor;
      }
    };
    const byOne = collect(1);
    assert.equal(byOne.length, 5);
    assert.deepEqual(collect(2), byOne);
    assert.deepEqual(collect(10), byOne);
  });

  it('fails closed on bad limits and cursors', () => {
    const store = storeWith(['z-1']);
    const rows = store.listAll();
    assert.throws(() => planFanoutTurn({ rows, cursor: null, limit: 0 }), /limit/);
    assert.throws(() => planFanoutTurn({ rows, cursor: '', limit: 1 }), /cursor/);
  });
});
