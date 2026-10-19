/** Work-outbox idempotency driven through the real producer: the attemptDispatch guard gate, stale-claim release and staged outbox identity. */
import { describe, expect, it } from 'vitest';
import type { DispatchClaim, OutboxItem } from '@canlang/contracts';
import { attemptDispatch } from '@canlang/work/dispatch';
import {
  commitOutboxIntent,
  deriveOutboxId,
  isCommitted,
  stageOutboxIntent,
} from '@canlang/work/intent';
import {
  TestOnlyCounterClaimIds,
  TestOnlyManualClock,
  TestOnlyMemorySupersession,
} from '@canlang/work/ports';
import { isClaimStale, releaseStaleClaims } from '@canlang/work/recovery';

function deps(evaluateGuard: (predicate: string) => boolean = () => true) {
  return {
    clock: new TestOnlyManualClock(1_000),
    claimIds: new TestOnlyCounterClaimIds(),
    supersessions: new TestOnlyMemorySupersession(),
    evaluateGuard: (predicate: string) => evaluateGuard(predicate),
  };
}

function committedIntent(operationId = '01900000-0000-7000-8000-000000000001') {
  return commitOutboxIntent(
    stageOutboxIntent({
      operationId,
      source: 'billing/charge',
      occurrenceIndex: 0,
      request: { to: 'acme' },
      originOccurrence: null,
    }),
    { revision: 1, committedAtMs: 0 },
  );
}

function item(id: string, state: OutboxItem['state']): OutboxItem {
  return {
    id,
    operationId: '01900000-0000-7000-8000-000000000001',
    source: 'billing/charge',
    occurrenceIndex: 0,
    request: {},
    originOccurrence: null,
    attempts: 0,
    state,
  };
}

function claim(outboxId: string, claimedAt: number): DispatchClaim {
  return { outboxId, claimId: `claim:${outboxId}`, claimedAt };
}

describe('attemptDispatch guard gate', () => {
  it('claims when the guard passes and skips with a verdict when it fails', () => {
    const intent = committedIntent();
    const claimed = attemptDispatch(deps(() => true), {
      intent,
      guard: { predicate: 'ok?' },
      frozenInputs: null,
      stateSnapshot: null,
    });
    expect(claimed.status).toBe('claimed');
    if (claimed.status === 'claimed') {
      expect(claimed.claim.outboxId).toBe(intent.item.id);
    }

    const skipped = attemptDispatch(deps(() => false), {
      intent,
      guard: { predicate: 'ok?' },
      frozenInputs: null,
      stateSnapshot: null,
    });
    expect(skipped).toEqual({
      status: 'skipped',
      verdict: { outboxId: intent.item.id, result: false },
    });
  });

  it('treats a null predicate as unconditional without consulting the evaluator', () => {
    let calls = 0;
    const outcome = attemptDispatch(
      deps(() => {
        calls += 1;
        return false;
      }),
      { intent: committedIntent(), guard: { predicate: null }, frozenInputs: null, stateSnapshot: null },
    );
    expect(outcome.status).toBe('claimed');
    expect(calls).toBe(0);
  });

  it('refuses staged-but-uncommitted intents before the guard runs', () => {
    const staged = stageOutboxIntent({
      operationId: '01900000-0000-7000-8000-000000000002',
      source: 'billing/charge',
      occurrenceIndex: 0,
      request: { to: 'acme' },
      originOccurrence: null,
    });
    expect(isCommitted(staged)).toBe(false);
    let calls = 0;
    const outcome = attemptDispatch(
      deps(() => {
        calls += 1;
        return true;
      }),
      { intent: staged, guard: { predicate: 'ok?' }, frozenInputs: null, stateSnapshot: null },
    );
    expect(outcome).toEqual({ status: 'refused-uncommitted', outboxId: staged.item.id });
    expect(calls).toBe(0);
  });
});

describe('releaseStaleClaims', () => {
  it('releases only claimed items whose recorded claim reached the max age', () => {
    const items = [item('a', 'claimed'), item('b', 'claimed'), item('c', 'pending')];
    const claims = [claim('a', 0), claim('b', 900)];
    const { items: next, releasedIds } = releaseStaleClaims(items, claims, 1_000, 500);
    expect(releasedIds).toEqual(['a']);
    expect(next.map((entry) => entry.state)).toEqual(['pending', 'claimed', 'pending']);
    // Boundary inclusive: claimedAt + maxAge == nowMs counts as stale.
    expect(isClaimStale(claim('x', 500), 1_000, 500)).toBe(true);
    expect(isClaimStale(claim('x', 501), 1_000, 500)).toBe(false);
  });

  it('leaves claimed items without a recorded claim alone for the live dispatcher', () => {
    const { items: next, releasedIds } = releaseStaleClaims([item('a', 'claimed')], [], 1_000, 0);
    expect(releasedIds).toEqual([]);
    expect(next[0]?.state).toBe('claimed');
  });
});

describe('staged outbox identity', () => {
  it('derives stable obx_ ids that collapse replays onto one item', () => {
    const first = deriveOutboxId('op_1', 'billing/charge', 0);
    expect(first).toBe(deriveOutboxId('op_1', 'billing/charge', 0));
    expect(first.startsWith('obx_')).toBe(true);
    expect(deriveOutboxId('op_1', 'billing/charge', 1)).not.toBe(first);
    expect(deriveOutboxId('op_2', 'billing/charge', 0)).not.toBe(first);
  });

  it('stages the same id pending and uncommitted until the fence marker lands', () => {
    const staged = stageOutboxIntent({
      operationId: 'op_1',
      source: 'billing/charge',
      occurrenceIndex: 0,
      request: { to: 'acme' },
      originOccurrence: null,
    });
    expect(staged.item.id).toBe(deriveOutboxId('op_1', 'billing/charge', 0));
    expect(staged.item.state).toBe('pending');
    expect(staged.commit).toBeNull();
    const committed = commitOutboxIntent(staged, { revision: 1, committedAtMs: 0 });
    expect(isCommitted(committed)).toBe(true);
  });
});
