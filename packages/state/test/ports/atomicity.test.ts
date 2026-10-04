/**
 * Lane 03 S6 atomicity tests: execute-staged domain writes, outbox intents,
 * and schedules commit as one fenced batch. A cross-invoke duplicate intent
 * id fails the whole second commit (the store surfaces its constraint raw —
 * pinned here as observed, see below), and malformed staged schedules take
 * the rejected-receipt path with nothing else persisted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StateError } from '../../src/errors.js';
import { captureFailure } from '../invocation/fixtures.js';
import {
  FIXED_NOW,
  asId,
  asOperation,
  captureStateError,
  freshOperationId,
  invokeStage,
  makeStagedIntent,
  makeStagingHandler,
  makeWidgetRow,
  pendingIntentIds,
  readStageReceipt,
  setupPortsWorld,
} from './fixtures.js';

describe('invoke staging atomicity', () => {
  it('commits staged domain, outbox, and schedule writes together', async () => {
    const world = await setupPortsWorld();
    const out = await invokeStage(world, {
      execute: makeStagingHandler({
        row: makeWidgetRow('at-w1', { title: 'Atomic' }),
        intents: [makeStagedIntent('at-i1')],
        schedules: [
          {
            op: 'replace',
            key: 'at-k',
            at: FIXED_NOW + 1_000,
            event: asOperation('Acme.due'),
            payload: {},
          },
        ],
      }),
    });
    assert.equal(out.status, 'committed');
    assert.deepEqual(out.deliveries, [{ id: 'at-i1', status: 'pending' }]);
    assert.deepEqual((await world.store.load(world.model, asId('at-w1')))?.data, {
      title: 'Atomic',
    });
    assert.deepEqual(await pendingIntentIds(world.store), ['at-i1']);
    assert.deepEqual(await world.store.scheduleGet('at-k'), {
      key: 'at-k',
      at: FIXED_NOW + 1_000,
      event: 'Acme.due',
      payload: {},
    });
  });

  it('rolls a duplicate intent id back: the second invoke fails wholesale', async () => {
    const world = await setupPortsWorld();
    const first = await invokeStage(world, {
      execute: makeStagingHandler({
        row: makeWidgetRow('at-dup1'),
        intents: [makeStagedIntent('at-dup')],
      }),
    });
    assert.equal(first.status, 'committed');
    assert.equal(await world.store.readRevision(), 1);
    // S6 plan behavior: the second commit's outbox PK violation is kind
    // `unique` at the store, mapped to a thrown StateError `conflict`
    // (commit-path constraint, like unique-claim violations — not receipted).
    const failed = await captureFailure(() =>
      invokeStage(world, {
        execute: makeStagingHandler({
          row: makeWidgetRow('at-dup2'),
          intents: [makeStagedIntent('at-dup')],
        }),
      }),
    );
    assert.ok(failed instanceof StateError, `expected StateError, got ${String(failed)}`);
    assert.equal(failed.code, 'conflict');
    // The failed batch persisted nothing: no row, no intent, no revision.
    assert.equal(await world.store.load(world.model, asId('at-dup2')), null);
    assert.ok((await world.store.load(world.model, asId('at-dup1'))) !== null);
    assert.deepEqual(await pendingIntentIds(world.store), ['at-dup']);
    assert.equal(await world.store.readRevision(), 1);
  });

  it('receipts a malformed staged schedule as rejected and persists nothing else', async () => {
    const world = await setupPortsWorld();
    const operationId = freshOperationId();
    const before = await world.store.readRevision();
    const error = await captureStateError(() =>
      invokeStage(world, {
        operationId,
        execute: makeStagingHandler({
          row: makeWidgetRow('at-bad'),
          schedules: [
            {
              op: 'replace',
              key: 'at-bad-k',
              at: -1,
              event: asOperation('Acme.due'),
              payload: {},
            },
          ],
        }),
      }),
    );
    assert.equal(error.code, 'validation');
    // Exactly one fence step: the rejected-receipt commit.
    assert.equal(await world.store.readRevision(), before + 1);
    assert.equal(await world.store.load(world.model, asId('at-bad')), null);
    assert.deepEqual(await pendingIntentIds(world.store), []);
    assert.equal(await world.store.scheduleGet('at-bad-k'), null);
    const receipt = await readStageReceipt(world, operationId);
    assert.ok(receipt !== null && receipt.outcome.status === 'rejected');
  });
});
