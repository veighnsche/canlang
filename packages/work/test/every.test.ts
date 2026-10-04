/** S3: recurring every() — UTC slots, per-scope coalescing, root rejection. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  admitEveryTick,
  computeEverySlot,
  deriveRecurringOccurrenceId,
  everyScopeKey,
  RootRecurrenceNotSupportedError,
} from '../src/schedule/every.ts';

const PERIOD_MS = 5 * 60 * 1000; // every(5m)
const SLOT_START_MS = 1_791_120_000_000; // a 5-minute boundary

describe('every: UTC-epoch slot computation', () => {
  it('aligns slots to the UTC epoch', () => {
    assert.deepEqual(computeEverySlot(SLOT_START_MS, PERIOD_MS), {
      slot: SLOT_START_MS / 1000,
      slotStartMs: SLOT_START_MS,
    });
    const mid = computeEverySlot(SLOT_START_MS + 61_000, PERIOD_MS);
    assert.equal(mid.slotStartMs, SLOT_START_MS);
    const next = computeEverySlot(SLOT_START_MS + PERIOD_MS, PERIOD_MS);
    assert.equal(next.slotStartMs, SLOT_START_MS + PERIOD_MS);
  });

  it('derives stable occurrence ids', () => {
    const a = deriveRecurringOccurrenceId('App', 'H.d', 'team', 'team_1', 42);
    const b = deriveRecurringOccurrenceId('App', 'H.d', 'team', 'team_1', 42);
    assert.equal(a, b);
    assert.match(a, /^evr_[0-9a-f]{64}$/);
    assert.notEqual(
      deriveRecurringOccurrenceId('App', 'H.d', 'team', 'team_1', 43),
      a,
    );
  });

  it('rejects invalid clocks and periods', () => {
    assert.throws(() => computeEverySlot(-1, PERIOD_MS), RangeError);
    assert.throws(() => computeEverySlot(SLOT_START_MS, 0), RangeError);
    assert.throws(() => computeEverySlot(SLOT_START_MS, -1000), RangeError);
    assert.throws(() => computeEverySlot(SLOT_START_MS, 1500), RangeError);
  });
});

describe('every: per-scope coalescing', () => {
  const base = {
    nowMs: SLOT_START_MS + 30_000,
    periodMs: PERIOD_MS,
    app: 'CanApprove',
    handler: 'Approval.digest',
  };

  it('admits one occurrence per eligible pre-existing scope at the current slot', () => {
    const slot = SLOT_START_MS / 1000;
    const result = admitEveryTick({
      ...base,
      scopes: [
        { scope: 'team', owner: 'team_2' },
        { scope: 'team', owner: 'team_1' },
        { scope: 'app', owner: 'app' },
      ],
      previousSlots: {
        [everyScopeKey('team', 'team_1')]: slot - 300,
        [everyScopeKey('team', 'team_2')]: slot - 300,
        [everyScopeKey('app', 'app')]: slot - 300,
      },
    });
    assert.equal(result.slot, slot);
    assert.equal(result.admitted.length, 3);
    // Stable (scope, owner) order.
    assert.deepEqual(
      result.admitted.map((o) => `${o.scope}:${o.owner}`),
      ['app:app', 'team:team_1', 'team:team_2'],
    );
    for (const occurrence of result.admitted) {
      assert.equal(occurrence.slot, slot);
      assert.equal(occurrence.app, 'CanApprove');
      assert.equal(occurrence.handler, 'Approval.digest');
    }
  });

  it('coalesces missed slots to one current occurrence', () => {
    const slot = SLOT_START_MS / 1000;
    const result = admitEveryTick({
      ...base,
      scopes: [{ scope: 'team', owner: 'team_1' }],
      previousSlots: { [everyScopeKey('team', 'team_1')]: slot - 10 * 300 },
    });
    assert.equal(result.admitted.length, 1);
    assert.equal(result.admitted[0]?.slot, slot);
  });

  it('admits nothing for new scopes until the next slot', () => {
    const slot = SLOT_START_MS / 1000;
    const first = admitEveryTick({
      ...base,
      scopes: [{ scope: 'team', owner: 'team_new' }],
      previousSlots: {},
    });
    assert.deepEqual(first.admitted, []);
    const next = admitEveryTick({
      ...base,
      nowMs: SLOT_START_MS + PERIOD_MS + 1,
      scopes: [{ scope: 'team', owner: 'team_new' }],
      previousSlots: {},
    });
    // Still new (no recorded previous slot): begins at the *next* slot after
    // its first sighting, i.e. once the caller records a previous slot.
    assert.deepEqual(next.admitted, []);
    const following = admitEveryTick({
      ...base,
      nowMs: SLOT_START_MS + 2 * PERIOD_MS + 1,
      scopes: [{ scope: 'team', owner: 'team_new' }],
      previousSlots: { [everyScopeKey('team', 'team_new')]: slot + 300 },
    });
    assert.equal(following.admitted.length, 1);
  });

  it('admits nothing for removed scopes and dedupes repeated scopes', () => {
    const slot = SLOT_START_MS / 1000;
    const result = admitEveryTick({
      ...base,
      scopes: [
        { scope: 'team', owner: 'team_1' },
        { scope: 'team', owner: 'team_1' },
      ],
      previousSlots: {
        [everyScopeKey('team', 'team_1')]: slot - 300,
        [everyScopeKey('team', 'team_gone')]: slot - 300,
      },
    });
    assert.deepEqual(
      result.admitted.map((o) => o.owner),
      ['team_1'],
    );
  });

  it('admits nothing when the slot was already admitted', () => {
    const slot = SLOT_START_MS / 1000;
    const result = admitEveryTick({
      ...base,
      scopes: [{ scope: 'team', owner: 'team_1' }],
      previousSlots: { [everyScopeKey('team', 'team_1')]: slot },
    });
    assert.deepEqual(result.admitted, []);
  });

  it('is deterministic across identical ticks', () => {
    const slot = SLOT_START_MS / 1000;
    const input = {
      ...base,
      scopes: [{ scope: 'team', owner: 'team_1' }],
      previousSlots: { [everyScopeKey('team', 'team_1')]: slot - 300 },
    };
    const a = admitEveryTick(input);
    const b = admitEveryTick(input);
    assert.deepEqual(a, b);
  });
});

describe('every: scope rejection', () => {
  it('rejects root scope with a typed error', () => {
    assert.throws(
      () =>
        admitEveryTick({
          nowMs: SLOT_START_MS,
          periodMs: PERIOD_MS,
          app: 'CanApprove',
          handler: 'Approval.digest',
          scopes: [{ scope: 'root', owner: 'root' }],
          previousSlots: {},
        }),
      (error: unknown) => {
        assert.ok(error instanceof RootRecurrenceNotSupportedError);
        assert.equal(error.code, 'ROOT_RECURRING_UNSUPPORTED');
        assert.equal(error.scope, 'root');
        return true;
      },
    );
  });

  it('rejects any other non-team/app scope the same way', () => {
    assert.throws(
      () =>
        admitEveryTick({
          nowMs: SLOT_START_MS,
          periodMs: PERIOD_MS,
          app: 'CanApprove',
          handler: 'Approval.digest',
          scopes: [{ scope: 'org', owner: 'o_1' }],
          previousSlots: {},
        }),
      RootRecurrenceNotSupportedError,
    );
  });
});
