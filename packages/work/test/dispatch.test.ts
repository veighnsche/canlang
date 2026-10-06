/** S3: dispatch — commit gate, supersession-first order, guard matrix, claims. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OutboxItem } from '@canlang/contracts';
import {
  TestOnlyCounterClaimIds,
  TestOnlyManualClock,
  TestOnlyMemorySupersession,
} from '../src/ports.js';
import type { AnyOutboxIntent } from '../src/intent/index.js';
import { commitOutboxIntent, stageOutboxIntent } from '../src/intent/index.js';
import type { GuardEvaluator } from '../src/dispatch/index.js';
import { attemptDispatch } from '../src/dispatch/index.js';

const OPERATION = '0193f2c0-0000-7000-8000-000000000001';

function staged(state: OutboxItem['state'] = 'pending'): AnyOutboxIntent {
  const intent = stageOutboxIntent({
    operationId: OPERATION,
    source: 'Mail.send',
    occurrenceIndex: 0,
    request: { to: 'a@test' },
    originOccurrence: null,
  });
  return { item: { ...intent.item, state }, commit: null };
}

function committed(state: OutboxItem['state'] = 'pending'): AnyOutboxIntent {
  const intent = staged(state);
  if (intent.commit !== null) {
    return intent;
  }
  return commitOutboxIntent({ item: intent.item, commit: null }, { revision: 3, committedAtMs: 50 });
}

interface Harness {
  clock: TestOnlyManualClock;
  claimIds: TestOnlyCounterClaimIds;
  supersessions: TestOnlyMemorySupersession;
  evaluateGuard: GuardEvaluator;
  guardCalls: { predicate: string; inputs: unknown; snapshot: unknown }[];
}


function harness(evaluateGuard: GuardEvaluator): Harness {
  const guardCalls: Harness['guardCalls'] = [];
  return {
    clock: new TestOnlyManualClock(9_000_000),
    claimIds: new TestOnlyCounterClaimIds(),
    supersessions: new TestOnlyMemorySupersession(),
    guardCalls,
    evaluateGuard: (predicate, inputs, snapshot) => {
      guardCalls.push({ predicate, inputs, snapshot });
      return evaluateGuard(predicate, inputs, snapshot);
    },
  };
}

describe('dispatch: commit failure causes no send', () => {
  it('refuses staged intents without touching guard, supersession or claims', () => {
    const deps = harness(() => true);
    const superseded: string[] = [];
    const original = deps.supersessions.isSuperseded.bind(deps.supersessions);
    deps.supersessions.isSuperseded = (id) => {
      superseded.push(id);
      return original(id);
    };
    const outcome = attemptDispatch(deps, {
      intent: staged(),
      guard: { predicate: 'notice.kind == decision' },
      frozenInputs: {},
      stateSnapshot: {},
    });
    assert.deepEqual(outcome, {
      status: 'refused-uncommitted',
      outboxId: staged().item.id,
    });
    assert.deepEqual(deps.guardCalls, []);
    assert.deepEqual(superseded, []);
    // No claim id was minted.
    assert.equal(deps.claimIds.nextClaimId(), 'claim_1');
  });
});

describe('dispatch: atomic check order', () => {
  it('checks supersession before the guard', () => {
    const deps = harness(() => false);
    const intent = committed();
    deps.supersessions.markSuperseded([intent.item.id]);
    const outcome = attemptDispatch(deps, {
      intent,
      guard: { predicate: 'false-guard' },
      frozenInputs: {},
      stateSnapshot: {},
    });
    assert.deepEqual(outcome, { status: 'superseded', outboxId: intent.item.id });
    assert.deepEqual(deps.guardCalls, []);
    assert.equal(deps.claimIds.nextClaimId(), 'claim_1');
  });

  it('checks the guard before claiming', () => {
    const deps = harness(() => true);
    const intent = committed('pending');
    const outcome = attemptDispatch(deps, {
      intent,
      guard: { predicate: 'p' },
      frozenInputs: { a: 1 },
      stateSnapshot: { b: 2 },
    });
    assert.equal(deps.guardCalls.length, 1);
    assert.deepEqual(deps.guardCalls[0], {
      predicate: 'p',
      inputs: { a: 1 },
      snapshot: { b: 2 },
    });
    assert.equal(outcome.status, 'claimed');
  });
});

describe('dispatch: guard matrix', () => {
  it('delivers unconditionally when the predicate is absent', () => {
    const deps = harness(() => {
      throw new Error('must not evaluate');
    });
    const outcome = attemptDispatch(deps, {
      intent: committed(),
      guard: { predicate: null },
      frozenInputs: {},
      stateSnapshot: {},
    });
    assert.equal(outcome.status, 'claimed');
    assert.deepEqual(deps.guardCalls, []);
  });

  it('claims when the guard evaluates true', () => {
    const deps = harness(() => true);
    const intent = committed();
    const outcome = attemptDispatch(deps, {
      intent,
      guard: { predicate: 'notice.kind == decision' },
      frozenInputs: { kind: 'decision' },
      stateSnapshot: { open: true },
    });
    assert.equal(outcome.status, 'claimed');
    assert.equal(deps.guardCalls.length, 1);
  });

  it('skips with a verdict when the guard evaluates false', () => {
    const deps = harness(() => false);
    const intent = committed();
    const outcome = attemptDispatch(deps, {
      intent,
      guard: { predicate: 'notice.kind == decision' },
      frozenInputs: { kind: 'note' },
      stateSnapshot: { open: true },
    });
    assert.deepEqual(outcome, {
      status: 'skipped',
      verdict: { outboxId: intent.item.id, result: false },
    });
    assert.equal(deps.claimIds.nextClaimId(), 'claim_1');
  });
});

describe('dispatch: claim issuance', () => {
  it('issues claims with injected ids and timestamps', () => {
    const deps = harness(() => true);
    const first = attemptDispatch(deps, {
      intent: committed(),
      guard: { predicate: null },
      frozenInputs: {},
      stateSnapshot: {},
    });
    assert.deepEqual(first, {
      status: 'claimed',
      claim: {
        outboxId: committed().item.id,
        claimId: 'claim_1',
        claimedAt: 9_000_000,
      },
    });
    deps.clock.setNowMs(9_000_001);
    const second = attemptDispatch(deps, {
      intent: committed(),
      guard: { predicate: null },
      frozenInputs: {},
      stateSnapshot: {},
    });
    assert.equal(second.status, 'claimed');
    if (second.status === 'claimed') {
      assert.equal(second.claim.claimId, 'claim_2');
      assert.equal(second.claim.claimedAt, 9_000_001);
    }
  });

  it('refuses settled items without claiming', () => {
    for (const state of ['delivered', 'failed', 'uncertain', 'dead'] as const) {
      let evaluations = 0;
      const deps = harness(() => {
        evaluations += 1;
        return false;
      });
      const intent = committed(state);
      const outcome = attemptDispatch(deps, {
        intent,
        guard: { predicate: 'never-evaluated' },
        frozenInputs: {},
        stateSnapshot: {},
      });
      assert.equal(evaluations, 0);
      assert.deepEqual(outcome, {
        status: 'refused-state',
        outboxId: intent.item.id,
        state,
      });
      assert.equal(deps.claimIds.nextClaimId(), 'claim_1');
    }
  });
});
