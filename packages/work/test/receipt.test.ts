/** S3: receipts — outcomes, retry classes, backoff, reconcile, dead letters. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OutboxItem } from '../../contracts/src/work.js';
import { TestOnlyScriptedRandom } from '../src/ports.ts';
import {
  BACKOFF_BASE_DELAY_MS,
  classifyFailure,
  computeBackoff,
  DEFAULT_RETRY_POLICY,
  listDeadLetter,
  reconcileUncertain,
  recordOutcome,
  toReceiptObservation,
} from '../src/receipt/index.ts';

const FIRST_ATTEMPT = 1_791_120_000_000;

function liveItem(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'obx_live',
    operationId: '0193f2c0-0000-7000-8000-000000000001',
    source: 'Mail.send',
    occurrenceIndex: 0,
    request: {},
    originOccurrence: null,
    attempts: 0,
    state: 'pending',
    ...overrides,
  };
}

describe('receipt: outcome recording', () => {
  it('records delivery', () => {
    const recorded = recordOutcome({
      item: liveItem({ state: 'claimed' }),
      outcome: { kind: 'delivered', result: { messageId: 'm_1' } },
      nowMs: FIRST_ATTEMPT,
      firstAttemptAtMs: FIRST_ATTEMPT,
    });
    assert.equal(recorded.item.state, 'delivered');
    assert.equal(recorded.item.attempts, 1);
    assert.equal(recorded.status, 'succeeded');
    assert.deepEqual(recorded.result, { messageId: 'm_1' });
    assert.equal(recorded.error, null);
    assert.equal(recorded.retryable, false);
  });

  it('records ambiguity as uncertain', () => {
    const recorded = recordOutcome({
      item: liveItem(),
      outcome: { kind: 'uncertain' },
      nowMs: FIRST_ATTEMPT,
      firstAttemptAtMs: FIRST_ATTEMPT,
    });
    assert.equal(recorded.item.state, 'uncertain');
    assert.equal(recorded.status, 'unknown');
    assert.equal(recorded.result, null);
    assert.equal(recorded.error, null);
    assert.equal(recorded.retryable, false);
  });

  it('rejects outcomes for non-live items', () => {
    for (const state of ['delivered', 'failed', 'uncertain', 'dead'] as const) {
      assert.throws(
        () =>
          recordOutcome({
            item: liveItem({ state }),
            outcome: { kind: 'delivered', result: null },
            nowMs: FIRST_ATTEMPT,
            firstAttemptAtMs: FIRST_ATTEMPT,
          }),
        /pending\/claimed items only/,
      );
    }
  });
});

describe('receipt: transient retry vs terminal failure', () => {
  it('retries transient failures under the SAME occurrence', () => {
    const recorded = recordOutcome({
      item: liveItem(),
      outcome: { kind: 'failed', cause: { kind: 'transient', code: 'timeout', message: 't/o' } },
      nowMs: FIRST_ATTEMPT + 1000,
      firstAttemptAtMs: FIRST_ATTEMPT,
    });
    assert.equal(recorded.item.id, 'obx_live');
    assert.equal(recorded.item.state, 'pending');
    assert.equal(recorded.item.attempts, 1);
    assert.equal(recorded.retryClass, 'transient');
    assert.equal(recorded.retryable, true);
    assert.equal(recorded.status, 'pending');
  });

  it('fails terminally on a false authored require', () => {
    const recorded = recordOutcome({
      item: liveItem(),
      outcome: {
        kind: 'failed',
        cause: { kind: 'handler-require-false', require: 'notice.open' },
      },
      nowMs: FIRST_ATTEMPT,
      firstAttemptAtMs: FIRST_ATTEMPT,
    });
    assert.equal(recorded.item.state, 'failed');
    assert.equal(recorded.retryClass, 'terminal');
    assert.equal(recorded.retryable, false);
    assert.equal(recorded.status, 'failed');
    assert.deepEqual(recorded.error, {
      code: 'require-false',
      message: 'handler requirement rejected the occurrence',
    });
  });

  it('fails terminally on permanent errors and stops retries', () => {
    const recorded = recordOutcome({
      item: liveItem(),
      outcome: {
        kind: 'failed',
        cause: { kind: 'permanent', code: 'rejected', message: 'nope' },
      },
      nowMs: FIRST_ATTEMPT,
      firstAttemptAtMs: FIRST_ATTEMPT,
    });
    assert.equal(recorded.item.state, 'failed');
    assert.equal(recorded.retryable, false);
    assert.deepEqual(recorded.error, { code: 'rejected', message: 'nope' });
  });

  it('classifies causes directly', () => {
    assert.equal(classifyFailure({ kind: 'transient', code: 'x', message: 'y' }), 'transient');
    assert.equal(
      classifyFailure({ kind: 'handler-require-false', require: 'r' }),
      'terminal',
    );
    assert.equal(classifyFailure({ kind: 'permanent', code: 'x', message: 'y' }), 'terminal');
  });

  it('dead-letters transient failures past the attempt cap', () => {
    const recorded = recordOutcome({
      item: liveItem({ attempts: 7 }),
      outcome: { kind: 'failed', cause: { kind: 'transient', code: 't', message: 'm' } },
      nowMs: FIRST_ATTEMPT + 60_000,
      firstAttemptAtMs: FIRST_ATTEMPT,
    });
    assert.equal(recorded.item.attempts, 8);
    assert.equal(recorded.item.state, 'dead');
    assert.equal(recorded.retryable, false);
    assert.equal(recorded.error?.code, 'retry-exhausted');
  });

  it('dead-letters transient failures past the horizon', () => {
    const recorded = recordOutcome({
      item: liveItem({ attempts: 2 }),
      outcome: { kind: 'failed', cause: { kind: 'transient', code: 't', message: 'm' } },
      nowMs: FIRST_ATTEMPT + DEFAULT_RETRY_POLICY.horizonMs,
      firstAttemptAtMs: FIRST_ATTEMPT,
    });
    assert.equal(recorded.item.state, 'dead');
    assert.equal(recorded.error?.code, 'retry-horizon-exceeded');
  });
});

describe('receipt: backoff schedule', () => {
  it('uses exponential delays with injected jitter inside documented bounds', () => {
    for (const unit of [0, 0.5, 0.999999]) {
      const decision = computeBackoff({
        attempt: 1,
        firstAttemptAtMs: FIRST_ATTEMPT,
        nowMs: FIRST_ATTEMPT,
        random: new TestOnlyScriptedRandom([unit]),
      });
      assert.equal(decision.exhausted, false);
      const nominal = BACKOFF_BASE_DELAY_MS;
      assert.ok(decision.delayMs >= nominal / 2);
      assert.ok(decision.delayMs <= nominal);
      assert.equal(decision.notBeforeMs, FIRST_ATTEMPT + decision.delayMs);
    }
  });

  it('hits the exact jitter bounds', () => {
    const low = computeBackoff({
      attempt: 3,
      firstAttemptAtMs: FIRST_ATTEMPT,
      nowMs: FIRST_ATTEMPT,
      random: new TestOnlyScriptedRandom([0]),
    });
    // attempt 3 -> nominal 4000; unit 0 -> nominal/2.
    assert.equal(low.delayMs, 2000);
    const high = computeBackoff({
      attempt: 3,
      firstAttemptAtMs: FIRST_ATTEMPT,
      nowMs: FIRST_ATTEMPT,
      random: new TestOnlyScriptedRandom([0.999999]),
    });
    assert.ok(high.delayMs > 3999 && high.delayMs <= 4000);
  });

  it('exhausts at the attempt cap and the 24h horizon by default', () => {
    assert.equal(DEFAULT_RETRY_POLICY.maxAttempts, 8);
    assert.equal(DEFAULT_RETRY_POLICY.horizonMs, 86_400_000);
    const capped = computeBackoff({
      attempt: 8,
      firstAttemptAtMs: FIRST_ATTEMPT,
      nowMs: FIRST_ATTEMPT + 1000,
      random: new TestOnlyScriptedRandom([0]),
    });
    assert.deepEqual(capped, { exhausted: true, delayMs: 0, notBeforeMs: FIRST_ATTEMPT + 1000 });
    const horizoned = computeBackoff({
      attempt: 2,
      firstAttemptAtMs: FIRST_ATTEMPT,
      nowMs: FIRST_ATTEMPT + 86_400_000,
      random: new TestOnlyScriptedRandom([0]),
    });
    assert.equal(horizoned.exhausted, true);
    const live = computeBackoff({
      attempt: 7,
      firstAttemptAtMs: FIRST_ATTEMPT,
      nowMs: FIRST_ATTEMPT + 1000,
      random: new TestOnlyScriptedRandom([0]),
    });
    assert.equal(live.exhausted, false);
  });

  it('rejects negative attempts and clocks', () => {
    const base = {
      attempt: 1,
      firstAttemptAtMs: FIRST_ATTEMPT,
      nowMs: FIRST_ATTEMPT,
      random: new TestOnlyScriptedRandom([0]),
    };
    assert.throws(() => computeBackoff({ ...base, attempt: -1 }), RangeError);
    assert.throws(() => computeBackoff({ ...base, attempt: 1.5 }), RangeError);
    assert.throws(() => computeBackoff({ ...base, nowMs: -1 }), RangeError);
  });

  it('honors custom policies and rejects invalid ones', () => {
    const custom = computeBackoff({
      attempt: 1,
      firstAttemptAtMs: FIRST_ATTEMPT,
      nowMs: FIRST_ATTEMPT,
      policy: { maxAttempts: 1, horizonMs: 1000 },
      random: new TestOnlyScriptedRandom([0]),
    });
    assert.equal(custom.exhausted, true);
    assert.throws(
      () =>
        computeBackoff({
          attempt: 0,
          firstAttemptAtMs: FIRST_ATTEMPT,
          nowMs: FIRST_ATTEMPT,
          policy: { maxAttempts: 0, horizonMs: 1000 },
          random: new TestOnlyScriptedRandom([0]),
        }),
      RangeError,
    );
  });
});

describe('receipt: unknown until reconciled', () => {
  const uncertain = () => liveItem({ state: 'uncertain', attempts: 2 });

  it('stays unknown without evidence', () => {
    const result = reconcileUncertain(uncertain(), null);
    assert.equal(result.changed, false);
    assert.equal(result.item.state, 'uncertain');
    assert.equal(result.status, null);
  });

  it('never touches non-uncertain items', () => {
    for (const state of ['pending', 'claimed', 'delivered', 'failed', 'dead'] as const) {
      const result = reconcileUncertain(liveItem({ state }), {
        kind: 'delivered',
        result: 1,
      });
      assert.equal(result.changed, false);
      assert.equal(result.item.state, state);
    }
  });

  it('resolves on delivered, failed and not-found evidence', () => {
    const delivered = reconcileUncertain(uncertain(), { kind: 'delivered', result: 'ok' });
    assert.equal(delivered.changed, true);
    assert.equal(delivered.item.state, 'delivered');
    assert.equal(delivered.status, 'succeeded');

    const failed = reconcileUncertain(uncertain(), {
      kind: 'failed',
      code: 'gone',
      message: 'gone',
    });
    assert.equal(failed.item.state, 'failed');
    assert.deepEqual(failed.error, { code: 'gone', message: 'gone' });

    const retry = reconcileUncertain(uncertain(), { kind: 'not-found' });
    assert.equal(retry.item.state, 'pending');
    assert.equal(retry.item.id, 'obx_live');
    assert.equal(retry.item.attempts, 2);
  });
});

describe('receipt: dead letters and observations', () => {
  it('lists dead-letter items visibly in stable order', () => {
    const items = [
      liveItem({ id: 'obx_z', state: 'dead' }),
      liveItem({ id: 'obx_a', state: 'dead' }),
      liveItem({ id: 'obx_p', state: 'pending' }),
      liveItem({ id: 'obx_f', state: 'failed' }),
    ];
    assert.deepEqual(
      listDeadLetter(items).map((item) => item.id),
      ['obx_a', 'obx_z'],
    );
  });

  it('assembles receipt observations from recorded fields', () => {
    const observation = toReceiptObservation('del_1', 42, {
      status: 'failed',
      result: null,
      error: { code: 'rejected', message: 'nope' },
    });
    assert.deepEqual(observation, {
      id: 'del_1',
      revision: 42,
      status: 'failed',
      result: null,
      error: { code: 'rejected', message: 'nope' },
    });
    assert.throws(() => toReceiptObservation('', 1, { status: 'pending', result: null, error: null }), RangeError);
    assert.throws(() => toReceiptObservation('d', -1, { status: 'pending', result: null, error: null }), RangeError);
  });
});
