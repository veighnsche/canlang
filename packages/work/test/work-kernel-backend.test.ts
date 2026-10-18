/** Work owner facades route the selected kernel: default and Wasm agree. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorkKernel } from '@canlang/work-kernel';
import type { WorkKernel } from '@canlang/work-kernel';
import { distribution } from '@canlang/work-kernel/distribution';
import {
  classifyFailure, computeBackoff, isConsistentCompletion, listDeadLetter,
  recordOutcome, toReceiptObservation,
} from '../src/receipt/index.js';
import {
  checkFanoutIdentitySet, fanoutChildPageResult, fanoutIntentRowId,
  newFanoutIntentRow, nextFanoutCheckpointData, readFanoutIntentRow,
} from '../src/kernel/tables.js';
import { KernelTableError } from '../src/kernel/tables.js';
import {
  admitEveryTick, computeEverySlot, deriveRecurringOccurrenceId,
} from '../src/schedule/every.js';

const wasmKernel = createWorkKernel({
  backend: 'wasm',
  module: new WebAssembly.Module(readFileSync(distribution.recoveryWasm)),
});

function throwsOf(action: () => unknown): { name: unknown; message: unknown; code: unknown; factory: boolean } {
  try {
    action();
  } catch (error) {
    const err = error as { name?: unknown; message?: unknown; code?: unknown };
    return { name: err?.name, message: err?.message, code: (err as Record<string, unknown>)?.code, factory: error instanceof KernelTableError };
  }
  assert.fail('must throw');
}

describe('work facades: selected kernel parity', () => {
  it('receipt decisions agree (ok, faults, RNG order, host refs)', () => {
    const item = {
      id: 'obx-1', operationId: 'op', source: 'std.MailboxV1.reply', occurrenceIndex: 0,
      request: { to: 'a' }, originOccurrence: null, attempts: 0, state: 'pending',
    } as unknown as Record<string, unknown>;
    const outcome = { kind: 'delivered', result: { ok: 1 } } as never;
    const tsOut = recordOutcome({ item, outcome, nowMs: 1000, firstAttemptAtMs: 0 } as never);
    const wasmOut = recordOutcome({ item, outcome, nowMs: 1000, firstAttemptAtMs: 0 } as never, wasmKernel);
    assert.deepStrictEqual(wasmOut, tsOut);
    assert.strictEqual(wasmOut.result, (outcome as { result: unknown }).result);
    assert.strictEqual(wasmOut.item.request, (item as { request: unknown }).request);

    const backoff = (count: { n: number }) => ({
      attempt: 1, firstAttemptAtMs: 0, nowMs: 1000,
      random: { nextUnit: () => { count.n++; return 0.5; } },
    });
    const tsCount = { n: 0 };
    const wasmCount = { n: 0 };
    assert.deepStrictEqual(
      computeBackoff(backoff(wasmCount) as never, wasmKernel),
      computeBackoff(backoff(tsCount) as never),
    );
    assert.equal(tsCount.n, 1);
    assert.equal(wasmCount.n, tsCount.n);

    const dead = [
      { ...item, id: 'b', state: 'dead' },
      { ...item, id: 'a', state: 'dead' },
      { ...item, id: 'c', state: 'pending' },
    ] as unknown as Record<string, unknown>[];
    const tsDead = listDeadLetter(dead as never);
    const wasmDead = listDeadLetter(dead as never, wasmKernel);
    assert.deepStrictEqual(wasmDead, tsDead);
    assert.ok(wasmDead.every((row) => (dead as unknown[]).includes(row)));

    assert.equal(
      isConsistentCompletion('succeeded', { ok: 1 }, null, wasmKernel),
      isConsistentCompletion('succeeded', { ok: 1 }, null),
    );
    const recorded = { status: 'succeeded', result: { ok: 2 }, error: null } as never;
    const tsObs = toReceiptObservation('d1', 3, recorded);
    const wasmObs = toReceiptObservation('d1', 3, recorded, wasmKernel);
    assert.deepStrictEqual(wasmObs, tsObs);
    assert.strictEqual(wasmObs.result, (recorded as { result: unknown }).result);
    assert.equal(classifyFailure({ kind: 'transient', code: 'c', message: 'm' }, wasmKernel), 'transient');
  });

  it('fanout tables agree (roundtrip, ids, faults keep the owning factory)', () => {
    const meta = { nowMs: 1_700_000_000_000, actor: 'kernel-join' };
    const input = { sourceOccurrence: 'o1', handler: 'h', cohort: 'model', members: ['r1', 'r2'] };
    const tsRow = newFanoutIntentRow(input as never, meta);
    const wasmRow = newFanoutIntentRow(input as never, meta, wasmKernel);
    assert.deepStrictEqual(wasmRow, tsRow);
    assert.deepStrictEqual(readFanoutIntentRow(wasmRow, wasmKernel), readFanoutIntentRow(tsRow));
    assert.equal(
      fanoutIntentRowId('o1', 'h', 'model', wasmKernel),
      fanoutIntentRowId('o1', 'h', 'model'),
    );
    const current = { fanoutId: fanoutIntentRowId('o1', 'h', 'model'), completed: ['r1'], cursor: null };
    assert.deepStrictEqual(
      nextFanoutCheckpointData(current as never, ['r2'], null, wasmKernel),
      nextFanoutCheckpointData(current as never, ['r2'], null),
    );
    assert.deepStrictEqual(
      fanoutChildPageResult([wasmRow], 10, wasmKernel),
      fanoutChildPageResult([tsRow], 10),
    );
    const tsFault = throwsOf(() => checkFanoutIdentitySet(['a', 'a'], 'members'));
    const wasmFault = throwsOf(() => checkFanoutIdentitySet(['a', 'a'], 'members', wasmKernel));
    assert.deepStrictEqual(wasmFault, tsFault);
    assert.ok(wasmFault.factory);
  });

  it('every admission agrees (donor mint through the demand protocol)', () => {
    const input = {
      nowMs: 5000, periodMs: 1000, app: 'a', handler: 'h',
      scopes: [{ scope: 'team', owner: 't1' }],
      previousSlots: { 'team:t1': 3 },
    } as never;
    const tsOut = admitEveryTick(structuredClone(input));
    const wasmOut = admitEveryTick(structuredClone(input), deriveRecurringOccurrenceId, wasmKernel);
    assert.deepStrictEqual(wasmOut, tsOut);
    assert.deepStrictEqual(
      admitEveryTick(structuredClone(input), deriveRecurringOccurrenceId, wasmKernel),
      admitEveryTick(structuredClone(input)),
    );
    assert.deepStrictEqual(computeEverySlot(5000, 1000, wasmKernel), computeEverySlot(5000, 1000));
    const tsFault = throwsOf(() => admitEveryTick({ ...(input as object), app: '' } as never));
    const wasmFault = throwsOf(() => admitEveryTick({ ...(input as object), app: '' } as never, deriveRecurringOccurrenceId, wasmKernel));
    assert.deepStrictEqual(wasmFault, tsFault);
  });
});
