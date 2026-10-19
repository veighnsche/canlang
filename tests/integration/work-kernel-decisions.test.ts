/** Work-kernel decision gates driven through the real producer: recurrence admission, transport validation and dead-letter listing. */
import { describe, expect, it } from 'vitest';
import {
  admitEveryTick,
  computeEverySlot,
  everyScopeKey,
  type EveryTickInput,
} from '@canlang/work-kernel/every';
import {
  validateCount,
  validatePayloadRef,
  validateVersions,
} from '@canlang/work-kernel';
import { listDeadLetter } from '@canlang/work-kernel/receipt';
import type { OutboxItem } from '@canlang/contracts';

const deriveId = (app: string, handler: string, scope: string, owner: string, slot: number) =>
  `${app}/${handler}/${scope}/${owner}/${slot}`;

function tick(scopes: EveryTickInput['scopes'], previousSlots: Record<string, number>): EveryTickInput {
  return { nowMs: 3_660_000, periodMs: 60_000, app: 'shop', handler: 'nightly', scopes, previousSlots };
}

function outbox(id: string, state: OutboxItem['state']): OutboxItem {
  return {
    id,
    operationId: '01900000-0000-7000-8000-000000000000',
    source: 'work.dispatch',
    occurrenceIndex: 0,
    request: {},
    originOccurrence: null,
    attempts: 0,
    state,
  };
}

describe('work-kernel recurrence admission', () => {
  it('keys scopes stably and aligns slots to whole periods', () => {
    expect(everyScopeKey('team', 't1')).toBe('team:t1');
    expect(computeEverySlot(60_000, 60_000)).toEqual({ slot: 60, slotStartMs: 60_000 });
    expect(computeEverySlot(61_999, 60_000)).toEqual({ slot: 60, slotStartMs: 60_000 });
    expect(() => computeEverySlot(60_000, 500)).toThrow(RangeError);
    expect(() => computeEverySlot(-1, 60_000)).toThrow(RangeError);
  });

  it('admits only known scopes at a new slot, coalescing duplicates', () => {
    const key = everyScopeKey('team', 't1');
    const result = admitEveryTick(
      tick(
        [{ scope: 'team', owner: 't1' }, { scope: 'team', owner: 't1' }, { scope: 'app', owner: 'a1' }],
        { [key]: 3659, 'app:a1': 3659 },
      ),
      deriveId,
    );
    expect(result.slot).toBe(3660);
    expect(result.admitted.map((entry) => entry.occurrenceId)).toEqual([
      'shop/nightly/app/a1/3660',
      'shop/nightly/team/t1/3660',
    ]);
  });

  it('admits nothing for new scopes and rejects bad scope shapes', () => {
    const fresh = admitEveryTick(tick([{ scope: 'team', owner: 't9' }], {}), deriveId);
    expect(fresh.admitted).toEqual([]);
    expect(() => admitEveryTick(tick([{ scope: 'org', owner: 'o1' }], {}), deriveId)).toThrow();
  });
});

describe('work-kernel transport validation', () => {
  it('accepts the frozen transport and profiles, refusing anything else', () => {
    expect(validateVersions({ transport: 'v0', profile: 'wt.rows/v0' })).toBeNull();
    expect(validateVersions({ transport: 'v9', profile: 'wt.rows/v0' })?.code).toBe('unknown-transport-version');
    expect(validateVersions({ transport: 'v0', profile: 'nope' })?.code).toBe('unknown-profile');
  });

  it('rejects non-integer and out-of-range counts before conversion', () => {
    expect(validateCount({ value: 5, range: { min: 0, max: 10 } })).toBeNull();
    expect(validateCount({ value: 11, range: { min: 0, max: 10 } })?.code).toBe('count-overflow');
    expect(validateCount({ value: 1.5, range: { min: 0, max: 10 } })?.code).toBe('count-overflow');
  });

  it('rejects cross-call and stale payload refs', () => {
    const live = new Set([0, 2]);
    expect(validatePayloadRef({ callToken: 'c1', index: 0 }, 'c1', live)).toBeNull();
    expect(validatePayloadRef({ callToken: 'c2', index: 0 }, 'c1', live)?.code).toBe('cross-call-ref');
    expect(validatePayloadRef({ callToken: 'c1', index: 1 }, 'c1', live)?.code).toBe('stale-ref');
  });
});

describe('work-kernel dead-letter listing', () => {
  it('returns only dead items in stable id order', () => {
    const items = [outbox('b', 'dead'), outbox('a', 'dead'), outbox('c', 'pending'), outbox('d', 'claimed')];
    expect(listDeadLetter(items).map((item) => item.id)).toEqual(['a', 'b']);
    expect(listDeadLetter([])).toEqual([]);
  });
});
