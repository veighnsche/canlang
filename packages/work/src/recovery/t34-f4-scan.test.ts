/**
 * T34-F4 fanout recovery scan: pure decision-table proofs (no substrate).
 *
 * Covers the full `planFanoutRecoveryScan` table — stale-claim resume,
 * fresh-claim read-only observation, guard/lifecycle terminal pins,
 * exhaustion, terminal-row immunity, exact-cutoff membership
 * (admit/phantom/gap), enumeration finishing, fanout scoping, and
 * input validation. Real-restart resume rides `t34-f4-durable.test.ts`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  FanoutCheckpoint,
  FanoutChildState,
  FanoutFailedReason,
  RetryPolicy,
} from '@canlang/contracts';
import {
  fanoutChildRowId,
  fanoutIntentRowId,
  newFanoutCheckpointRow,
  newFanoutIntentRow,
  readFanoutCheckpointRow,
  readFanoutIntentRow,
} from '../kernel/tables.js';
import type {
  FanoutCheckpointRowData,
  FanoutChildRowData,
  FanoutIntentRowData,
} from '../kernel/tables.js';
import {
  isFanoutChildExhausted,
  isFanoutClaimStale,
  planFanoutRecoveryScan,
} from './index.js';
import type {
  FanoutChildLifecycle,
  FanoutRecoverableRow,
  FanoutRecoveryScanInput,
} from './index.js';

const META = { nowMs: 1_758_000_000_000, actor: 't34-f4-test' };
const OCC = 'occ_f4_scan';
const HANDLER = 'Shift.review_commitment';
const FANOUT = fanoutIntentRowId(OCC, HANDLER, 'model');
const NOW = META.nowMs + 10_000;
const MAX_AGE = 1000;
const STALE_CLAIM = NOW - 5000;
const FRESH_CLAIM = NOW - 500;
const POLICY: RetryPolicy = { maxAttempts: 3, horizonMs: 60_000 };

function intent(members: readonly string[]): FanoutIntentRowData {
  return readFanoutIntentRow(
    newFanoutIntentRow({ sourceOccurrence: OCC, handler: HANDLER, cohort: 'model', members }, META),
  );
}

function checkpoint(
  completed: readonly string[],
  cursor: FanoutCheckpoint['cursor'],
): FanoutCheckpointRowData {
  return readFanoutCheckpointRow(
    newFanoutCheckpointRow({ fanoutId: FANOUT, completed, cursor }, META),
  );
}

function childData(
  recordId: string,
  state: FanoutChildState,
  attempts = 0,
): FanoutChildRowData {
  return {
    fanoutId: FANOUT,
    parentOccurrence: OCC,
    handler: HANDLER,
    recordId,
    childId: fanoutChildRowId(OCC, HANDLER, recordId),
    state,
    attempts,
    causeKind: null,
    causeReason: null,
  };
}

const PRESENT: FanoutChildLifecycle = { status: 'present' };
const DELETED: FanoutChildLifecycle = { status: 'deleted' };
const MOVED: FanoutChildLifecycle = { status: 'moved' };

function view(
  recordId: string,
  state: FanoutChildState,
  overrides: Partial<FanoutRecoverableRow> = {},
  attempts = 0,
): FanoutRecoverableRow {
  const { child, ...rest } = overrides;
  return {
    child: child ?? childData(recordId, state, attempts),
    claimedAtMs: null,
    guardVerdict: null,
    firstAttemptAtMs: null,
    lifecycle: PRESENT,
    ...rest,
  };
}

function scan(
  members: readonly string[],
  rows: ReadonlyArray<FanoutRecoverableRow>,
  overrides: Partial<FanoutRecoveryScanInput> & {
    completed?: readonly string[];
    cursor?: FanoutCheckpoint['cursor'];
  } = {},
): ReturnType<typeof planFanoutRecoveryScan> {
  const { completed, cursor, ...rest } = overrides;
  return planFanoutRecoveryScan({
    fanoutId: FANOUT,
    intent: intent(members),
    checkpoint: checkpoint(completed ?? [], cursor ?? null),
    rows,
    nowMs: NOW,
    maxClaimAgeMs: MAX_AGE,
    policy: POLICY,
    ...rest,
  });
}

function childIdOf(recordId: string): string {
  return fanoutChildRowId(OCC, HANDLER, recordId);
}

describe('t34-f4 scan: stale-claim resume vs fresh-claim observation', () => {
  it('running + stale claim resumes; pending rows need no recovery action', () => {
    const plan = scan(
      ['a', 'b'],
      [
        view('a', 'running', { claimedAtMs: STALE_CLAIM, firstAttemptAtMs: STALE_CLAIM }),
        view('b', 'pending', { guardVerdict: true }),
      ],
    );
    assert.deepEqual(plan.resume, [childIdOf('a')]);
    assert.deepEqual(plan.uncertain, []);
    assert.deepEqual(plan.skipped, []);
    assert.deepEqual(plan.dead, []);
    assert.deepEqual(plan.failed, []);
  });

  it('running + fresh claim is uncertain (observed read-only, never released)', () => {
    const plan = scan(
      ['a'],
      [view('a', 'running', { claimedAtMs: FRESH_CLAIM, firstAttemptAtMs: FRESH_CLAIM })],
    );
    assert.deepEqual(plan.resume, []);
    assert.deepEqual(plan.uncertain, [childIdOf('a')]);
  });

  it('running + unknown claim age is uncertain (fail closed, never released)', () => {
    const plan = scan(['a'], [view('a', 'running', { claimedAtMs: null })]);
    assert.deepEqual(plan.resume, []);
    assert.deepEqual(plan.uncertain, [childIdOf('a')]);
  });

  it('staleness boundary is inclusive: age == max is stale, max - 1 is fresh', () => {
    assert.equal(isFanoutClaimStale(NOW - MAX_AGE, NOW, MAX_AGE), true);
    assert.equal(isFanoutClaimStale(NOW - MAX_AGE + 1, NOW, MAX_AGE), false);
    const stale = scan(['a'], [view('a', 'running', { claimedAtMs: NOW - MAX_AGE })]);
    assert.deepEqual(stale.resume, [childIdOf('a')]);
    const fresh = scan(['a'], [view('a', 'running', { claimedAtMs: NOW - MAX_AGE + 1 })]);
    assert.deepEqual(fresh.uncertain, [childIdOf('a')]);
    assert.deepEqual(fresh.resume, []);
  });

  it('pending rows ignore even stale claim instants (T24 precedent)', () => {
    const plan = scan(
      ['a'],
      [view('a', 'pending', { claimedAtMs: STALE_CLAIM, guardVerdict: true })],
    );
    assert.deepEqual([plan.resume, plan.uncertain, plan.skipped, plan.dead, plan.failed], [[], [], [], [], []]);
  });

  it('lifecycle and guard never race a live claim: fresh running + deleted stays uncertain', () => {
    const plan = scan(
      ['a'],
      [view('a', 'running', { claimedAtMs: FRESH_CLAIM, lifecycle: DELETED, guardVerdict: false })],
    );
    assert.deepEqual(plan.uncertain, [childIdOf('a')]);
    assert.deepEqual([plan.resume, plan.skipped, plan.failed, plan.dead], [[], [], [], []]);
  });
});

describe('t34-f4 scan: exhaustion pins dead (failed/exhausted)', () => {
  it('recorded attempts at the cap pin dead; one below resumes', () => {
    const deadRow = view('a', 'running', { claimedAtMs: STALE_CLAIM }, 3);
    const resumeRow = view('b', 'running', { claimedAtMs: STALE_CLAIM }, 2);
    const plan = scan(['a', 'b'], [deadRow, resumeRow]);
    assert.deepEqual(plan.dead, [childIdOf('a')]);
    assert.deepEqual(plan.resume, [childIdOf('b')]);
  });

  it('horizon boundary is inclusive: elapsed == horizon pins dead', () => {
    assert.equal(isFanoutChildExhausted(0, NOW - POLICY.horizonMs, NOW, POLICY), true);
    assert.equal(isFanoutChildExhausted(0, NOW - POLICY.horizonMs + 1, NOW, POLICY), false);
    const plan = scan(
      ['a'],
      [view('a', 'running', { claimedAtMs: STALE_CLAIM, firstAttemptAtMs: NOW - POLICY.horizonMs })],
    );
    assert.deepEqual(plan.dead, [childIdOf('a')]);
  });

  it('null first-attempt anchor checks attempts only (horizon never started)', () => {
    assert.equal(isFanoutChildExhausted(2, null, NOW, POLICY), false);
    assert.equal(isFanoutChildExhausted(3, null, NOW, POLICY), true);
  });

  it('default policy is the adopted retry default (8 attempts): 7 resumes, 8 dead', () => {
    const resumeRow = view('a', 'running', { claimedAtMs: STALE_CLAIM }, 7);
    const deadRow = view('b', 'running', { claimedAtMs: STALE_CLAIM }, 8);
    const plan = scan(['a', 'b'], [resumeRow, deadRow], { policy: undefined });
    assert.deepEqual(plan.resume, [childIdOf('a')]);
    assert.deepEqual(plan.dead, [childIdOf('b')]);
  });
});

describe('t34-f4 scan: terminal rows are never re-executed', () => {
  it('completed/skipped/failed rows appear in no action list, even when guard/lifecycle disagree', () => {
    const plan = scan(
      ['a', 'b', 'c'],
      [
        view('a', 'completed', { guardVerdict: false, lifecycle: DELETED }),
        view('b', 'skipped', {
          guardVerdict: false,
          lifecycle: { status: 'unknown', reason: 'missing-record' },
        }),
        view('c', 'failed', { guardVerdict: false, lifecycle: DELETED }),
      ],
      { completed: ['a', 'b', 'c'] },
    );
    assert.deepEqual(plan.resume, []);
    assert.deepEqual(plan.skipped, []);
    assert.deepEqual(plan.dead, []);
    assert.deepEqual(plan.failed, []);
    assert.deepEqual(plan.uncertain, []);
    assert.deepEqual(plan.checkpointGaps, []);
  });
});

describe('t34-f4 scan: lifecycle and guard pins (M4)', () => {
  it('pending + guard-false pins skipped/non-applicable (pending + stale running alike)', () => {
    const plan = scan(
      ['a', 'b'],
      [
        view('a', 'pending', { guardVerdict: false }),
        view('b', 'running', { claimedAtMs: STALE_CLAIM, guardVerdict: false }),
      ],
    );
    assert.deepEqual(plan.skipped, [
      { childId: childIdOf('a'), reason: 'non-applicable' },
      { childId: childIdOf('b'), reason: 'non-applicable' },
    ]);
  });

  it('demonstrably deleted pins skipped/deleted (pending + stale running alike)', () => {
    const plan = scan(
      ['a', 'b'],
      [
        view('a', 'pending', { lifecycle: DELETED, guardVerdict: true }),
        view('b', 'running', { claimedAtMs: STALE_CLAIM, lifecycle: DELETED }),
      ],
    );
    assert.deepEqual(plan.skipped, [
      { childId: childIdOf('a'), reason: 'deleted' },
      { childId: childIdOf('b'), reason: 'deleted' },
    ]);
  });

  it('moved records re-evaluate: guard-false skips, guard-true resumes', () => {
    const plan = scan(
      ['a', 'b'],
      [
        view('a', 'running', { claimedAtMs: STALE_CLAIM, lifecycle: MOVED, guardVerdict: false }),
        view('b', 'running', { claimedAtMs: STALE_CLAIM, lifecycle: MOVED, guardVerdict: true }),
      ],
    );
    assert.deepEqual(plan.skipped, [{ childId: childIdOf('a'), reason: 'non-applicable' }]);
    assert.deepEqual(plan.resume, [childIdOf('b')]);
  });

  it('unknown lookup pins failed with its closed reason — never deleted, never skipped', () => {
    const reasons = ['missing-record', 'inaccessible-record', 'infra-read-failure'] as const;
    const rows = reasons.map((reason, index) =>
      view(`u${index}`, index === 0 ? 'pending' : 'running', {
        claimedAtMs: index === 0 ? null : STALE_CLAIM,
        lifecycle: { status: 'unknown', reason },
      }),
    );
    const plan = scan(['u0', 'u1', 'u2'], rows);
    assert.deepEqual(plan.failed, [
      { childId: childIdOf('u0'), reason: 'missing-record' },
      { childId: childIdOf('u1'), reason: 'inaccessible-record' },
      { childId: childIdOf('u2'), reason: 'infra-read-failure' },
    ]);
    assert.deepEqual(plan.skipped, []);
  });

  it('lifecycle pins win over exhaustion: deleted + spent budget still skips deleted', () => {
    const row = view('a', 'running', { claimedAtMs: STALE_CLAIM, lifecycle: DELETED }, 99);
    const plan = scan(['a'], [row]);
    assert.deepEqual(plan.skipped, [{ childId: childIdOf('a'), reason: 'deleted' }]);
    assert.deepEqual(plan.dead, []);
  });
});

describe('t34-f4 scan: exact cutoff — admit, phantoms, gaps (M4)', () => {
  it('admits frozen members with no row and no completion — nothing else', () => {
    const plan = scan(
      ['a', 'b', 'c', 'd'],
      [view('a', 'pending'), view('b', 'completed')],
      { completed: ['b'] },
    );
    assert.deepEqual(plan.admit, ['c', 'd']);
  });

  it('completed-without-row is a gap (attention), never an admit, never auto-completed', () => {
    const plan = scan(['a', 'b'], [view('a', 'pending')], { completed: ['b'] });
    assert.deepEqual(plan.admit, []);
    assert.deepEqual(plan.checkpointGaps, ['b']);
  });

  it('completed members with only a live row are gaps too (partial checkpoint)', () => {
    const plan = scan(
      ['a'],
      [view('a', 'running', { claimedAtMs: STALE_CLAIM })],
      { completed: ['a'] },
    );
    assert.deepEqual(plan.checkpointGaps, ['a']);
    assert.deepEqual(plan.admit, []);
  });

  it('rows outside the frozen set are phantoms (attention, never driven)', () => {
    const phantom = view('zzz', 'pending', { guardVerdict: true });
    const plan = scan(['a'], [view('a', 'pending'), phantom]);
    assert.deepEqual(plan.phantoms, [childIdOf('zzz')]);
    assert.deepEqual(plan.admit, []);
  });

  it('finishEnumeration only when the cursor is stale with nothing to admit and no gaps', () => {
    const done = scan(['a'], [view('a', 'completed')], { completed: ['a'], cursor: 'c1' });
    assert.equal(done.finishEnumeration, true);
    const nullCursor = scan(['a'], [view('a', 'completed')], { completed: ['a'], cursor: null });
    assert.equal(nullCursor.finishEnumeration, false);
    const toAdmit = scan(['a', 'b'], [view('a', 'completed')], { completed: ['a'], cursor: 'c1' });
    assert.equal(toAdmit.finishEnumeration, false);
    const gapped = scan(['a'], [], { completed: ['a'], cursor: 'c1' });
    assert.equal(gapped.finishEnumeration, false);
    assert.deepEqual(gapped.checkpointGaps, ['a']);
  });
});

describe('t34-f4 scan: fanout scoping (M7 no shared checkpoint)', () => {
  it('rejects intent, checkpoint, or rows from another fanout', () => {
    const otherFanout = fanoutIntentRowId('occ_other', HANDLER, 'model');
    const otherIntent = readFanoutIntentRow(
      newFanoutIntentRow(
        { sourceOccurrence: 'occ_other', handler: HANDLER, cohort: 'model', members: ['a'] },
        META,
      ),
    );
    const otherCheckpoint = readFanoutCheckpointRow(
      newFanoutCheckpointRow({ fanoutId: otherFanout }, META),
    );
    const rows = [view('a', 'pending')];
    assert.throws(
      () =>
        planFanoutRecoveryScan({
          fanoutId: FANOUT,
          intent: otherIntent,
          checkpoint: checkpoint([], null),
          rows,
          nowMs: NOW,
          maxClaimAgeMs: MAX_AGE,
        }),
      /intent carries a different fanoutId/,
    );
    assert.throws(
      () =>
        planFanoutRecoveryScan({
          fanoutId: FANOUT,
          intent: intent(['a']),
          checkpoint: otherCheckpoint,
          rows,
          nowMs: NOW,
          maxClaimAgeMs: MAX_AGE,
        }),
      /checkpoint carries a different fanoutId/,
    );
    const foreign = view('a', 'pending');
    (foreign as { child: FanoutChildRowData }).child = { ...foreign.child, fanoutId: otherFanout };
    assert.throws(
      () =>
        planFanoutRecoveryScan({
          fanoutId: FANOUT,
          intent: intent(['a']),
          checkpoint: checkpoint([], null),
          rows: [foreign],
          nowMs: NOW,
          maxClaimAgeMs: MAX_AGE,
        }),
      /child row carries a different fanoutId/,
    );
  });

  it('two occurrences plan independently: same record, separate fanouts, separate lists', () => {
    const occ2 = 'occ_f4_scan_2';
    const fanout2 = fanoutIntentRowId(occ2, HANDLER, 'model');
    const intent2 = readFanoutIntentRow(
      newFanoutIntentRow(
        { sourceOccurrence: occ2, handler: HANDLER, cohort: 'model', members: ['shared'] },
        META,
      ),
    );
    const checkpoint2 = readFanoutCheckpointRow(
      newFanoutCheckpointRow({ fanoutId: fanout2 }, META),
    );
    const row2: FanoutRecoverableRow = {
      child: {
        fanoutId: fanout2,
        parentOccurrence: occ2,
        handler: HANDLER,
        recordId: 'shared',
        childId: fanoutChildRowId(occ2, HANDLER, 'shared'),
        state: 'running',
        attempts: 0,
        causeKind: null,
        causeReason: null,
      },
      claimedAtMs: STALE_CLAIM,
      guardVerdict: null,
      firstAttemptAtMs: STALE_CLAIM,
      lifecycle: PRESENT,
    };
    const plan1 = scan(['shared'], [view('shared', 'pending', { guardVerdict: true })]);
    const plan2 = planFanoutRecoveryScan({
      fanoutId: fanout2,
      intent: intent2,
      checkpoint: checkpoint2,
      rows: [row2],
      nowMs: NOW,
      maxClaimAgeMs: MAX_AGE,
      policy: POLICY,
    });
    assert.deepEqual(plan1.resume, []);
    assert.deepEqual(plan2.resume, [fanoutChildRowId(occ2, HANDLER, 'shared')]);
    assert.notEqual(plan2.resume[0], childIdOf('shared'));
  });
});

describe('t34-f4 scan: validation and stable evidence', () => {
  it('rejects bad clocks, ages, policies, and anchors', () => {
    const rows = [view('a', 'pending')];
    for (const nowMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      assert.throws(() => scan(['a'], rows, { nowMs }), /nowMs must be finite/);
    }
    assert.throws(() => scan(['a'], rows, { maxClaimAgeMs: -1 }), /maxClaimAgeMs must be finite/);
    assert.throws(
      () => scan(['a'], rows, { policy: { maxAttempts: 0, horizonMs: 1 } }),
      /policy\.maxAttempts/,
    );
    assert.throws(
      () => scan(['a'], rows, { policy: { maxAttempts: 1, horizonMs: 0 } }),
      /policy\.horizonMs/,
    );
    assert.throws(
      () => scan(['a'], [view('a', 'running', { claimedAtMs: Number.NaN })]),
      /claimedAtMs must be finite/,
    );
    assert.throws(
      () => scan(['a'], [view('a', 'running', { claimedAtMs: STALE_CLAIM, firstAttemptAtMs: -2 })]),
      /firstAttemptAtMs must be finite/,
    );
    assert.throws(() => isFanoutClaimStale(0, NOW, -1), /maxClaimAgeMs must be finite/);
    assert.throws(
      () => isFanoutChildExhausted(0, null, NOW, { maxAttempts: 1, horizonMs: -5 }),
      /policy\.horizonMs/,
    );
  });

  it('fails closed on unknown row states and lifecycle shapes', () => {
    const badState = view('a', 'pending');
    (badState as { child: FanoutChildRowData }).child = {
      ...badState.child,
      state: 'evaporated' as FanoutChildState,
    };
    assert.throws(() => scan(['a'], [badState]), /unknown state/);
    const badLifecycle = view('a', 'pending', {
      lifecycle: { status: 'limbo' } as unknown as FanoutChildLifecycle,
    });
    assert.throws(() => scan(['a'], [badLifecycle]), /unknown lifecycle/);
    const badReason = view('a', 'pending', {
      lifecycle: { status: 'unknown', reason: 'vaporized' } as unknown as FanoutChildLifecycle,
    });
    assert.throws(() => scan(['a'], [badReason]), /unknown lifecycle reason/);
  });

  it('sorts every list for stable evidence', () => {
    const plan = scan(
      ['m3', 'm1', 'm2'],
      [
        view('m3', 'running', { claimedAtMs: STALE_CLAIM }),
        view('m1', 'running', { claimedAtMs: STALE_CLAIM }),
        view('m2', 'running', { claimedAtMs: FRESH_CLAIM }),
      ],
    );
    assert.deepEqual(plan.resume, [childIdOf('m1'), childIdOf('m3')]);
    assert.deepEqual(plan.uncertain, [childIdOf('m2')]);
  });

  it('empty fanout plans empty (no phantom admit, no false finish)', () => {
    const plan = scan([], [], { completed: [], cursor: null });
    assert.deepEqual(
      [plan.resume, plan.skipped, plan.dead, plan.failed, plan.admit, plan.uncertain, plan.phantoms, plan.checkpointGaps],
      [[], [], [], [], [], [], [], []],
    );
    assert.equal(plan.finishEnumeration, false);
  });
});
