/**
 * Lane 03 S6 staging tests: fail-closed validation for fenced outbox intent
 * and schedule-op staging, the deterministic intent-id builder, and the
 * combined effects entry. Every malformed input is a `validation` StateError.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OutboxIntent, ScheduleOp } from '../../../contracts/src/state.js';
import {
  STAGING_MAX_ID_LENGTH,
  outboxIntentId,
  stageEffectsStaging,
  stageOutboxIntents,
  stageScheduleOps,
} from '../../src/effects/staging.js';
import { asOperationId } from '../invocation/fixtures.js';
import { asOperation, captureStateError } from './fixtures.js';

const OP_ID = 'op-staging-1';
const CTX = { operationId: OP_ID };

function validIntent(overrides: Record<string, unknown> = {}): OutboxIntent {
  return {
    intentId: 'intent-1',
    operation: asOperation('Acme.stage'),
    operationId: asOperationId(OP_ID),
    target: 'mail.send',
    arguments: { to: 'a@example.com' },
    occurrenceIndex: 0,
    ...overrides,
  } as OutboxIntent;
}

function validReplace(overrides: Record<string, unknown> = {}): ScheduleOp {
  return {
    op: 'replace',
    key: 'sched-1',
    at: 1_700_000_010_000,
    event: asOperation('Acme.due'),
    payload: { n: 1 },
    ...overrides,
  } as ScheduleOp;
}

describe('stageOutboxIntents', () => {
  it('stages a valid intent with a cloned, engine-owned copy', () => {
    const input = validIntent({ dispatchGuard: 'weekday' });
    const [staged] = stageOutboxIntents([input], CTX);
    assert.deepEqual(staged, input);
    assert.notEqual(staged?.arguments, input.arguments);
    (input.arguments as Record<string, unknown>)['to'] = 'mutated@example.com';
    assert.deepEqual(staged?.arguments, { to: 'a@example.com' });
  });

  it('drops unknown extra keys instead of passing them through', () => {
    const [staged] = stageOutboxIntents(
      [{ ...validIntent(), extra: 'drop' } as unknown as OutboxIntent],
      CTX,
    );
    assert.ok(staged !== undefined && !('extra' in staged));
  });

  it('accepts a 128-char id and rejects empty, missing, and 129-char ids', async () => {
    const max = `i-${'x'.repeat(126)}`;
    assert.equal(max.length, STAGING_MAX_ID_LENGTH);
    assert.equal(stageOutboxIntents([validIntent({ intentId: max })], CTX)[0]?.intentId, max);
    for (const intentId of ['', 'y'.repeat(129), undefined, 42]) {
      const error = await captureStateError(() =>
        stageOutboxIntents([validIntent({ intentId })], CTX),
      );
      assert.equal(error.code, 'validation');
    }
  });

  it('rejects an empty or missing operation', async () => {
    for (const operation of ['', undefined]) {
      const error = await captureStateError(() =>
        stageOutboxIntents([validIntent({ operation })], CTX),
      );
      assert.equal(error.code, 'validation');
    }
  });

  it('rejects an intent whose operationId differs from the invoking operation', async () => {
    const error = await captureStateError(() =>
      stageOutboxIntents([validIntent({ operationId: 'op-other' })], CTX),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /invoking operation/);
  });

  it('rejects an empty or missing target', async () => {
    for (const target of ['', undefined]) {
      const error = await captureStateError(() =>
        stageOutboxIntents([validIntent({ target })], CTX),
      );
      assert.equal(error.code, 'validation');
    }
  });

  it('rejects non-object arguments', async () => {
    for (const args of [null, ['to'], 'to', 42, undefined]) {
      const error = await captureStateError(() =>
        stageOutboxIntents([validIntent({ arguments: args })], CTX),
      );
      assert.equal(error.code, 'validation');
    }
  });

  it('rejects non-JSON arguments', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    for (const args of [{ n: 10n }, { f: () => 1 }, circular]) {
      const error = await captureStateError(() =>
        stageOutboxIntents([validIntent({ arguments: args })], CTX),
      );
      assert.equal(error.code, 'validation');
    }
  });

  it('rejects a negative, fractional, or non-numeric occurrence index', async () => {
    for (const occurrenceIndex of [-1, 1.5, '0', Number.NaN, undefined]) {
      const error = await captureStateError(() =>
        stageOutboxIntents([validIntent({ occurrenceIndex })], CTX),
      );
      assert.equal(error.code, 'validation');
    }
  });

  it('rejects an empty or non-string dispatch guard', async () => {
    for (const dispatchGuard of ['', 123, null]) {
      const error = await captureStateError(() =>
        stageOutboxIntents([validIntent({ dispatchGuard })], CTX),
      );
      assert.equal(error.code, 'validation');
    }
  });

  it('rejects duplicate intent ids within one batch', async () => {
    const error = await captureStateError(() =>
      stageOutboxIntents([validIntent({ intentId: 'dup' }), validIntent({ intentId: 'dup' })], CTX),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /Duplicate outbox intent id/);
  });

  it('rejects a non-array batch, non-object items, and an empty staging identity', async () => {
    for (const bad of [
      () => stageOutboxIntents('nope' as unknown as OutboxIntent[], CTX),
      () => stageOutboxIntents([null as unknown as OutboxIntent], CTX),
      () => stageOutboxIntents(['id' as unknown as OutboxIntent], CTX),
      () => stageOutboxIntents([validIntent()], { operationId: '' }),
    ]) {
      const error = await captureStateError(bad);
      assert.equal(error.code, 'validation');
    }
  });
});

describe('stageScheduleOps', () => {
  it('stages a valid replace and cancel with cloned payloads', () => {
    const replace = validReplace();
    const cancel: ScheduleOp = { op: 'cancel', key: 'sched-2' };
    const staged = stageScheduleOps([replace, cancel]);
    assert.deepEqual(staged, [replace, cancel]);
    const first = staged[0];
    assert.ok(first !== undefined && first.op === 'replace' && replace.op === 'replace');
    assert.notEqual(first.payload, replace.payload);
  });

  it('rejects an empty, missing, or overlong replace key', async () => {
    for (const key of ['', 'k'.repeat(129), undefined]) {
      const error = await captureStateError(() => stageScheduleOps([validReplace({ key })]));
      assert.equal(error.code, 'validation');
    }
  });

  it('rejects a negative, non-finite, or non-numeric replace time', async () => {
    for (const at of [-1, Number.NaN, Number.POSITIVE_INFINITY, 'soon', undefined]) {
      const error = await captureStateError(() => stageScheduleOps([validReplace({ at })]));
      assert.equal(error.code, 'validation');
    }
  });

  it('allows past replace times: the scheduler fires overdue entries', () => {
    const staged = stageScheduleOps([validReplace({ at: 0 })]);
    assert.equal(staged.length, 1);
  });

  it('rejects an empty or missing replace event', async () => {
    for (const event of ['', undefined]) {
      const error = await captureStateError(() => stageScheduleOps([validReplace({ event })]));
      assert.equal(error.code, 'validation');
    }
  });

  it('rejects a non-object or non-JSON replace payload', async () => {
    for (const payload of [null, [1], 'p', { n: 10n }, { f: () => 1 }]) {
      const error = await captureStateError(() => stageScheduleOps([validReplace({ payload })]));
      assert.equal(error.code, 'validation');
    }
  });

  it('rejects a cancel with an empty or overlong key', async () => {
    for (const key of ['', 'k'.repeat(129)]) {
      const error = await captureStateError(() =>
        stageScheduleOps([{ op: 'cancel', key } as ScheduleOp]),
      );
      assert.equal(error.code, 'validation');
    }
  });

  it('rejects unknown op names, non-array batches, and non-object items', async () => {
    for (const bad of [
      () => stageScheduleOps([{ op: 'upsert', key: 'k' } as unknown as ScheduleOp]),
      () => stageScheduleOps({} as unknown as ScheduleOp[]),
      () => stageScheduleOps([null as unknown as ScheduleOp]),
    ]) {
      const error = await captureStateError(bad);
      assert.equal(error.code, 'validation');
    }
  });

  it('allows duplicate keys in order: last op for a key wins at the store', () => {
    const staged = stageScheduleOps([
      validReplace({ key: 'dup', at: 1_000 }),
      validReplace({ key: 'dup', at: 2_000 }),
      { op: 'cancel', key: 'gone' },
      validReplace({ key: 'gone', at: 3_000 }),
    ]);
    assert.deepEqual(
      staged.map((op) => (op.op === 'replace' ? [op.op, op.key, op.at] : [op.op, op.key])),
      [
        ['replace', 'dup', 1_000],
        ['replace', 'dup', 2_000],
        ['cancel', 'gone'],
        ['replace', 'gone', 3_000],
      ],
    );
  });
});

describe('outboxIntentId', () => {
  it('builds the deterministic operationId#index identity', () => {
    assert.equal(outboxIntentId('op-1', 2), 'op-1#2');
    assert.equal(outboxIntentId('op-1', 0), 'op-1#0');
  });
});

describe('stageEffectsStaging', () => {
  it('stages outbox and schedules together on the happy path', () => {
    const staged = stageEffectsStaging(
      { outbox: [validIntent()], schedules: [validReplace(), { op: 'cancel', key: 'k' }] },
      CTX,
    );
    assert.equal(staged.outbox.length, 1);
    assert.equal(staged.schedules.length, 2);
    assert.deepEqual(staged.outbox[0]?.intentId, 'intent-1');
  });

  it('passes empty staging arrays trivially', () => {
    assert.deepEqual(stageEffectsStaging({ outbox: [], schedules: [] }, CTX), {
      outbox: [],
      schedules: [],
    });
  });

  it('rejects non-object effects and propagates member failures', async () => {
    for (const bad of [
      () => stageEffectsStaging(null as unknown as { outbox: []; schedules: [] }, CTX),
      () =>
        stageEffectsStaging(
          { outbox: [validIntent({ intentId: '' })], schedules: [] },
          CTX,
        ),
      () => stageEffectsStaging({ outbox: [], schedules: [validReplace({ at: -1 })] }, CTX),
    ]) {
      const error = await captureStateError(bad);
      assert.equal(error.code, 'validation');
    }
  });
});
