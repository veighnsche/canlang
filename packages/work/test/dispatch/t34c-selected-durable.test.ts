/**
 * T34-C selected-kernel durable qualification: the production
 * `DurableFanoutChildStore` over the REAL memory StoragePort with an
 * EXPLICITLY selected installed kernel backend (real Wasm module), a
 * real handler guard applied to the current snapshot at claim time,
 * and caller-supplied history effects joined atomically with the child
 * transition (land-or-rollback in one fenced batch).
 *
 * This is the owner-side installed path: no synthetic direct-kernel
 * Worker, no default-backend reliance — every row read/write names its
 * kernel explicitly. Run from dist FROM THE REPO ROOT: root build, then
 * `node --test packages/work/dist/test/dispatch/t34c-selected-durable.test.js`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type {
  HistoryEntry,
  RetryPolicy,
  StoredRow,
} from '@canlang/contracts';
import { createWorkKernel, type WorkKernel } from '@canlang/work-kernel';
import { distribution } from '@canlang/work-kernel/distribution';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import {
  WORK_FANOUT_CHILD_MODEL,
  fanoutIntentRowId,
  newFanoutChildRow,
  readFanoutChildRow,
} from '../../src/kernel/tables.js';
import {
  type FanoutChildClaimInput,
  type GuardEvaluator,
} from '../../src/dispatch/index.js';
import { TestOnlyManualClock } from '../../src/ports.js';
import { DurableFanoutChildStore } from '../../src/dispatch/durable.js';

const OCC = 'occ-t34c-selected';
const HANDLER = 'Shift.review_commitment';
const PREDICATE = 'Shift.review_commitment:applies';
const ACTOR = 't34c-selected-durable';
const NOW = 1_758_000_000_000;
const META = { nowMs: NOW, actor: ACTOR };
const POLICY: RetryPolicy = { maxAttempts: 3, horizonMs: 60_000 };

const nativeModule = new WebAssembly.Module(readFileSync(distribution.recoveryWasm));
const wasmKernel = createWorkKernel({ backend: 'wasm', module: nativeModule });

// Real handler guard: the predicate must name this handler and the
// CURRENT snapshot must show it open with the retained lexical input.
const guard: GuardEvaluator = (predicate, frozenInputs, snapshot) =>
  predicate === PREDICATE &&
  frozenInputs === 'lex' &&
  (snapshot as { open: boolean }).open === true;

function claimInput(child: FanoutChildClaimInput['child'], extra?: Partial<FanoutChildClaimInput>): FanoutChildClaimInput {
  return {
    child,
    snapshotVersion: null,
    guard: { predicate: PREDICATE },
    frozenInputs: 'lex',
    readCurrentSnapshot: () => ({ open: true }),
    ...extra,
  };
}

describe('t34c selected-kernel durable fanout', () => {
  it('claims, joins history, records and reports progress under explicit Wasm selection', async () => {
    const { store, probe } = createTestMemoryStorage();
    const clock = new TestOnlyManualClock(NOW);
    const durable = new DurableFanoutChildStore({ store, clock, actor: ACTOR, kernel: wasmKernel });
    const fanoutId = fanoutIntentRowId(OCC, HANDLER, 'model', wasmKernel);
    const child = { parentOccurrence: OCC, handler: HANDLER, recordId: 'rec-1' };

    const admitted = newFanoutChildRow(
      { fanoutId, parentOccurrence: OCC, handler: HANDLER, recordId: 'rec-1' },
      META,
      wasmKernel,
    );
    await durable.insert(admitted);

    const history: HistoryEntry[] = [{
      model: WORK_FANOUT_CHILD_MODEL,
      recordId: admitted.id,
      version: 2 as never,
      operation: 'fanout.claim' as never,
      operationId: 'op-1' as never,
      actor: ACTOR,
      at: NOW,
      change: 'update',
      before: null,
      after: null,
    }];
    const claimed = await durable.claim(guard, { ...claimInput(child), join: { history } });
    assert.equal(claimed.status, 'claimed');
    assert.equal(readFanoutChildRow(claimed.row, wasmKernel).state, 'running');
    // The joined history effect landed atomically with the claim.
    assert.equal(probe.historyFor(WORK_FANOUT_CHILD_MODEL, admitted.id).length, 1);

    const recorded = await durable.record({
      child,
      result: { kind: 'completed' },
      nowMs: NOW,
      firstAttemptAtMs: NOW,
      policy: POLICY,
    });
    assert.equal(recorded.status, 'recorded');
    assert.equal(recorded.outcome?.state, 'completed');

    const progress = await durable.progress(fanoutId);
    assert.equal(progress.completed, 1);
    assert.equal(progress.terminal, true);
    assert.equal(progress.attention, false);
  });

  it('rolls back the child transition when a joined effect fails', async () => {
    const { store } = createTestMemoryStorage();
    const clock = new TestOnlyManualClock(NOW);
    const durable = new DurableFanoutChildStore({ store, clock, actor: ACTOR, kernel: wasmKernel });
    const fanoutId = fanoutIntentRowId(OCC, HANDLER, 'model', wasmKernel);
    const child = { parentOccurrence: OCC, handler: HANDLER, recordId: 'rec-2' };
    const admitted = newFanoutChildRow(
      { fanoutId, parentOccurrence: OCC, handler: HANDLER, recordId: 'rec-2' },
      META,
      wasmKernel,
    );
    await durable.insert(admitted);

    // A joined write that cannot land (version fence on a missing row).
    await assert.rejects(durable.claim(guard, {
      ...claimInput(child),
      join: {
        writes: [{
          kind: 'update',
          model: WORK_FANOUT_CHILD_MODEL,
          id: 'missing-row' as never,
          expectedVersion: 999 as never,
          row: admitted,
        }],
      },
    }));
    // Rollback: the child row is untouched (still pending, version 1).
    const current = await durable.get(child) as StoredRow;
    assert.equal(readFanoutChildRow(current, wasmKernel).state, 'pending');
    assert.equal(current.version, 1);
  });

  it('default and selected kernels drive identical outcomes', async () => {
    const run = async (kernel?: WorkKernel): Promise<string> => {
      const { store } = createTestMemoryStorage();
      const clock = new TestOnlyManualClock(NOW);
      const durable = new DurableFanoutChildStore({
        store, clock, actor: ACTOR, ...(kernel === undefined ? {} : { kernel }),
      });
      const fanoutId = fanoutIntentRowId(OCC, HANDLER, 'model');
      const child = { parentOccurrence: OCC, handler: HANDLER, recordId: 'rec-9' };
      await durable.insert(newFanoutChildRow(
        { fanoutId, parentOccurrence: OCC, handler: HANDLER, recordId: 'rec-9' }, META,
      ));
      const claimed = await durable.claim(guard, claimInput(child));
      assert.equal(claimed.status, 'claimed');
      const recorded = await durable.record({
        child, result: { kind: 'completed' }, nowMs: NOW, firstAttemptAtMs: NOW, policy: POLICY,
      });
      assert.equal(recorded.status, 'recorded');
      return `${claimed.status}/${recorded.status}/${recorded.outcome?.state}`;
    };
    assert.equal(await run(undefined), await run(wasmKernel));
  });
});
