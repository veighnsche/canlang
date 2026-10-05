/**
 * T32b dispatch claim-time fence (colocated): transitive dispatches open
 * their own fresh scope (inheriting the trigger's checkpoint is refused),
 * live authority revalidates at claim time (revocation between trigger
 * and handler denies the effect), and the guard always evaluates over the
 * claim-time snapshot — no cached snapshot authorizes a spend.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OutboxItem } from '../../../contracts/src/work.js';
import {
  TestOnlyCounterClaimIds,
  TestOnlyManualClock,
  TestOnlyMemorySupersession,
} from '../ports.ts';
import type { AnyOutboxIntent } from '../intent/index.ts';
import { commitOutboxIntent, stageOutboxIntent } from '../intent/index.ts';
import type { DispatchDeps, GuardEvaluator } from './index.ts';
import { attemptDispatch } from './index.ts';

const OPERATION = '0193f2c0-0000-7000-8000-000000000002';

function committed(state: OutboxItem['state'] = 'pending'): AnyOutboxIntent {
  const staged = stageOutboxIntent({
    operationId: OPERATION,
    source: 'Mail.send',
    occurrenceIndex: 0,
    request: { to: 'a@test' },
    originOccurrence: null,
  });
  return commitOutboxIntent({ item: { ...staged.item, state }, commit: null }, { revision: 3, committedAtMs: 50 });
}

function deps(evaluateGuard: GuardEvaluator): DispatchDeps {
  return {
    clock: new TestOnlyManualClock(9_000_000),
    claimIds: new TestOnlyCounterClaimIds(),
    supersessions: new TestOnlyMemorySupersession(),
    evaluateGuard,
  };
}

describe('T32b dispatch claim-time fence', () => {
  it('claims when the transitive scope is fresh and authority revalidates', () => {
    const intent = committed();
    const outcome = attemptDispatch(deps(() => true), {
      intent,
      guard: { predicate: 'spend.bounded' },
      frozenInputs: {},
      stateSnapshot: { held: 1 },
      fence: {
        checkpoint: { revision: 4, owner: 'team-a' },
        triggerRevision: { revision: 3 },
        revalidateAuthority: () => true,
      },
    });
    assert.equal(outcome.status, 'claimed');
  });

  it('refuses a transitive dispatch that inherited the trigger checkpoint', () => {
    const intent = committed();
    let guardRan = false;
    const outcome = attemptDispatch(
      deps(() => { guardRan = true; return true; }),
      {
        intent,
        guard: { predicate: 'spend.bounded' },
        frozenInputs: {},
        stateSnapshot: { held: 1 },
        fence: {
          checkpoint: { revision: 3, owner: 'team-a' },
          triggerRevision: { revision: 3 },
          revalidateAuthority: () => true,
        },
      },
    );
    assert.deepEqual(outcome, { status: 'refused-inherited-scope', outboxId: intent.item.id });
    assert.equal(guardRan, false);
  });

  it('denies the effect when authority revoked between trigger and handler', () => {
    const intent = committed();
    let guardRan = false;
    // The guard PASSES on current state — revocation alone must deny.
    const outcome = attemptDispatch(
      deps(() => { guardRan = true; return true; }),
      {
        intent,
        guard: { predicate: 'spend.bounded' },
        frozenInputs: {},
        stateSnapshot: { held: 1 },
        fence: {
          checkpoint: { revision: 4, owner: 'team-a' },
          triggerRevision: { revision: 3 },
          revalidateAuthority: () => false,
        },
      },
    );
    assert.deepEqual(outcome, { status: 'refused-revoked', outboxId: intent.item.id });
    assert.equal(guardRan, true);
  });

  it('evaluates the guard over the claim-time snapshot, never a carried one', () => {
    const intent = committed();
    const snapshots: unknown[] = [];
    const d = deps((_predicate, _inputs, snapshot) => {
      snapshots.push(snapshot);
      return (snapshot as { held: number }).held < 2;
    });
    // State moved between staging and dispatch: the guard must observe
    // the claim-time value (held: 5 → skip), not any staged value.
    const outcome = attemptDispatch(d, {
      intent,
      guard: { predicate: 'spend.bounded' },
      frozenInputs: { held: 1 },
      stateSnapshot: { held: 5 },
    });
    assert.equal(outcome.status, 'skipped');
    assert.deepEqual(snapshots, [{ held: 5 }]);
  });

  it('attempts without a fence keep the exact pre-T32b behavior', () => {
    const intent = committed();
    const outcome = attemptDispatch(deps(() => true), {
      intent,
      guard: { predicate: 'spend.bounded' },
      frozenInputs: {},
      stateSnapshot: {},
    });
    assert.equal(outcome.status, 'claimed');
  });
});
