/**
 * D3 dispatch unavailable verdict: sends to deployment-unavailable
 * targets refuse explicitly at claim time instead of claiming or
 * silently skipping.
 *
 * Decision (this kernel): where the runtime injects target
 * availability, `attemptDispatch` matches the intent item's source
 * path and returns `{status:'unavailable', outboxId, target}` after
 * lifecycle checks (committed/scoped/live) and before guard
 * evaluation — unavailable targets never evaluate guards, never
 * revalidate authority, and never mint claims. Absent availability
 * means unknown: existing behavior, no check.
 *
 * Transport (runtime-owned): the verdict shape pinned here
 * (`{status,outboxId,target}` exact keys) is the contract C maps to
 * a terminal BusinessError. Proposed (C confirms): code
 * `rule_failed` (well-formed but semantically rejected), message
 * naming the target, `retryable: false` — repeating the identical
 * send fails identically until the deployment changes. Never
 * re-driven like refused-*.
 */
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
import type { GuardEvaluator, TargetAvailabilityPort } from '../src/dispatch/index.js';
import { attemptDispatch } from '../src/dispatch/index.js';

const OPERATION = '0193f2c0-0000-7000-8000-000000000001';

function staged(
  source = 'Mail.send',
  state: OutboxItem['state'] = 'pending',
): AnyOutboxIntent {
  const intent = stageOutboxIntent({
    operationId: OPERATION,
    source,
    occurrenceIndex: 0,
    request: { to: 'a@test' },
    originOccurrence: null,
  });
  return { item: { ...intent.item, state }, commit: null };
}

function committed(
  source = 'Mail.send',
  state: OutboxItem['state'] = 'pending',
): AnyOutboxIntent {
  const intent = staged(source, state);
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
  availability: TargetAvailabilityPort;
  availabilityCalls: string[];
}

function harness(
  evaluateGuard: GuardEvaluator,
  available: ReadonlySet<string>,
): Harness {
  const guardCalls: Harness['guardCalls'] = [];
  const availabilityCalls: string[] = [];
  return {
    clock: new TestOnlyManualClock(9_000_000),
    claimIds: new TestOnlyCounterClaimIds(),
    supersessions: new TestOnlyMemorySupersession(),
    guardCalls,
    availabilityCalls,
    evaluateGuard: (predicate, inputs, snapshot) => {
      guardCalls.push({ predicate, inputs, snapshot });
      return evaluateGuard(predicate, inputs, snapshot);
    },
    availability: {
      isTargetAvailable: (target) => {
        availabilityCalls.push(target);
        return available.has(target);
      },
    },
  };
}

describe('dispatch: unavailable targets refuse explicitly', () => {
  it('returns the explicit verdict without touching guard or claims', () => {
    const deps = harness(() => true, new Set(['Mail.send']));
    const intent = committed('Handbook.answer');
    const outcome = attemptDispatch(deps, {
      intent,
      guard: { predicate: 'notice.kind == decision' },
      frozenInputs: {},
      stateSnapshot: {},
    });
    assert.deepEqual(outcome, {
      status: 'unavailable',
      outboxId: intent.item.id,
      target: 'Handbook.answer',
    });
    assert.deepEqual(deps.guardCalls, []);
    assert.deepEqual(deps.availabilityCalls, ['Handbook.answer']);
    assert.equal(deps.claimIds.nextClaimId(), 'claim_1');
  });

  it('claims available targets on the existing path', () => {
    const deps = harness(() => true, new Set(['Mail.send']));
    const intent = committed('Mail.send');
    const outcome = attemptDispatch(deps, {
      intent,
      guard: { predicate: null },
      frozenInputs: {},
      stateSnapshot: {},
    });
    assert.equal(outcome.status, 'claimed');
    assert.ok(outcome.status === 'claimed');
    assert.equal(outcome.claim.outboxId, intent.item.id);
  });

  it('skips the check when availability is unknown (backward compatible)', () => {
    const full = harness(() => true, new Set(['Mail.send']));
    const { availability: _unknown, ...deps } = full;
    void _unknown;
    const outcome = attemptDispatch(deps, {
      intent: committed('Handbook.answer'),
      guard: { predicate: null },
      frozenInputs: {},
      stateSnapshot: {},
    });
    assert.equal(outcome.status, 'claimed');
    assert.deepEqual(full.availabilityCalls, []);
  });

  it('pins the exact transport-contract shape', () => {
    const deps = harness(() => true, new Set());
    const outcome = attemptDispatch(deps, {
      intent: committed('Mail.send'),
      guard: { predicate: null },
      frozenInputs: {},
      stateSnapshot: {},
    });
    assert.equal(outcome.status, 'unavailable');
    assert.deepEqual(Object.keys(outcome).sort(), ['outboxId', 'status', 'target']);
  });
});

describe('dispatch: unavailable ordering (lifecycle first, guard/authority never)', () => {
  it('earlier lifecycle refusals win without consulting availability', () => {
    // Fresh harness per case: staged intent ids are deterministic, so
    // supersession marks would leak across cases otherwise.
    const uncommittedDeps = harness(() => true, new Set());
    assert.deepEqual(
      attemptDispatch(uncommittedDeps, {
        intent: staged('Mail.send'),
        guard: { predicate: null },
        frozenInputs: {},
        stateSnapshot: {},
      }).status,
      'refused-uncommitted',
    );
    assert.deepEqual(uncommittedDeps.availabilityCalls, []);

    const supersededDeps = harness(() => true, new Set());
    const superseded = committed('Mail.send');
    supersededDeps.supersessions.markSuperseded([superseded.item.id]);
    assert.deepEqual(
      attemptDispatch(supersededDeps, {
        intent: superseded,
        guard: { predicate: null },
        frozenInputs: {},
        stateSnapshot: {},
      }).status,
      'superseded',
    );
    assert.deepEqual(supersededDeps.availabilityCalls, []);

    const settledDeps = harness(() => true, new Set());
    assert.deepEqual(
      attemptDispatch(settledDeps, {
        intent: committed('Mail.send', 'claimed'),
        guard: { predicate: null },
        frozenInputs: {},
        stateSnapshot: {},
      }).status,
      'refused-state',
    );
    assert.deepEqual(settledDeps.availabilityCalls, []);

    const inheritedDeps = harness(() => true, new Set());
    assert.deepEqual(
      attemptDispatch(inheritedDeps, {
        intent: committed('Mail.send'),
        guard: { predicate: null },
        frozenInputs: {},
        stateSnapshot: {},
        fence: {
          checkpoint: { revision: 5, owner: 'owner-1' },
          triggerRevision: { revision: 5 },
        },
      }).status,
      'refused-inherited-scope',
    );
    assert.deepEqual(inheritedDeps.availabilityCalls, []);
  });

  it('unavailable beats guard-false and revoked without consulting either', () => {
    const deps = harness(() => false, new Set());
    let revalidations = 0;
    const outcome = attemptDispatch(deps, {
      intent: committed('Mail.send'),
      guard: { predicate: 'notice.kind == decision' },
      frozenInputs: {},
      stateSnapshot: {},
      fence: {
        checkpoint: { revision: 6, owner: 'owner-1' },
        revalidateAuthority: () => {
          revalidations += 1;
          return false;
        },
      },
    });
    assert.deepEqual(outcome.status, 'unavailable');
    assert.deepEqual(deps.guardCalls, []);
    assert.equal(revalidations, 0);
    assert.equal(deps.claimIds.nextClaimId(), 'claim_1');
  });

  it('executes admitted bound-checked sends end to end (E1-grounded inputs)', () => {
    // E1 admits submissions and keeps delivery bindings on the derived
    // channel (never submitted); the work record carries submitted
    // inputs only. This pins the work-side execution half with E1's
    // VALID_CREATE fixture values verbatim; C3's runtime proves the
    // drive half.
    const deps = harness(() => true, new Set(['Shop.Gadget.create']));
    const intent = stageOutboxIntent({
      operationId: OPERATION,
      source: 'Shop.Gadget.create',
      occurrenceIndex: 0,
      request: { title: 'w', price: '1.50', ids: ['a'], code: 'c' },
      originOccurrence: null,
    });
    const committedIntent = commitOutboxIntent(
      { item: intent.item, commit: null },
      { revision: 3, committedAtMs: 50 },
    );
    const outcome = attemptDispatch(deps, {
      intent: committedIntent,
      guard: { predicate: null },
      frozenInputs: {},
      stateSnapshot: {},
    });
    assert.equal(outcome.status, 'claimed');
    assert.ok(outcome.status === 'claimed');
    assert.equal(outcome.claim.outboxId, committedIntent.item.id);
    assert.deepEqual(committedIntent.item.request, {
      title: 'w',
      price: '1.50',
      ids: ['a'],
      code: 'c',
    });
  });

  it('repeats identically: unavailable is stable, never a claim race', () => {
    const deps = harness(() => true, new Set());
    const intent = committed('Mail.send');
    const attempt = {
      intent,
      guard: { predicate: null },
      frozenInputs: {},
      stateSnapshot: {},
    };
    assert.deepEqual(attemptDispatch(deps, attempt), attemptDispatch(deps, attempt));
    assert.equal(deps.claimIds.nextClaimId(), 'claim_1');
  });
});
