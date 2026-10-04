/**
 * Lane 03 S6 system-command tests: unknown-command rejection, the
 * readers-only staging context (no store/commit keys), the outbox ack flow,
 * schedule cancel/replace round-trips, same-batch ack+stage, and malformed
 * staged intents failing closed with nothing persisted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OutboxIntent } from '../../../contracts/src/state.js';
import {
  createSystemRegistry,
  defineSystemCommand,
  outboxAckCommand,
  scheduleCancelCommand,
  scheduleReplaceCommand,
} from '../../src/ports/index.js';
import { asOperationId } from '../invocation/fixtures.js';
import {
  FIXED_NOW,
  asOperation,
  captureStateError,
  invokeStage,
  makeStagedIntent,
  makeStagingHandler,
  pendingIntentIds,
  setupPortsWorld,
} from './fixtures.js';

function runCtx(operationId: string) {
  return { actor: 'operator', now: FIXED_NOW, operation: 'sys', operationId };
}

function registry() {
  return createSystemRegistry([outboxAckCommand, scheduleCancelCommand, scheduleReplaceCommand]);
}

describe('createSystemRegistry', () => {
  it('rejects an unknown command name with validation', async () => {
    const world = await setupPortsWorld();
    const error = await captureStateError(() =>
      registry().run('nope.missing', {}, runCtx('sys-run-0'), { store: world.store }),
    );
    assert.equal(error.code, 'validation');
  });

  it('gives staging contexts readers only: no store or commit keys', async () => {
    const world = await setupPortsWorld();
    let seen: Record<string, unknown> | null = null;
    const inspect = defineSystemCommand({
      name: 'test.inspect',
      stage: (_args, ctx) => {
        seen = { ...ctx };
        return { result: null };
      },
    });
    const commands = createSystemRegistry([inspect]);
    await commands.run('test.inspect', {}, runCtx('sys-run-0'), { store: world.store });
    assert.ok(seen !== null);
    assert.deepEqual(Object.keys(seen).sort(), ['actor', 'load', 'now', 'operation', 'query']);
    assert.ok(!('store' in seen) && !('commit' in seen));
    assert.equal(typeof seen['load'], 'function');
    assert.equal(typeof seen['query'], 'function');
  });

  it('acks intents idempotently: unknown and repeated acks are a no-op', async () => {
    const world = await setupPortsWorld();
    const out = await invokeStage(world, {
      execute: makeStagingHandler({
        intents: [makeStagedIntent('sys-a'), makeStagedIntent('sys-b')],
      }),
    });
    assert.equal(out.status, 'committed');
    assert.deepEqual(await pendingIntentIds(world.store), ['sys-a', 'sys-b']);
    const commands = registry();
    const deps = { store: world.store };
    const acked = await commands.run('outbox.ack', { intentIds: ['sys-a'] }, runCtx('sys-run-1'), deps);
    assert.deepEqual(acked.result, { requested: 1 });
    assert.deepEqual(await pendingIntentIds(world.store), ['sys-b']);
    await commands.run('outbox.ack', { intentIds: ['sys-unknown'] }, runCtx('sys-run-2'), deps);
    assert.deepEqual(await pendingIntentIds(world.store), ['sys-b']);
    await commands.run('outbox.ack', { intentIds: ['sys-a'] }, runCtx('sys-run-3'), deps);
    assert.deepEqual(await pendingIntentIds(world.store), ['sys-b']);
  });

  it('replaces, updates, and cancels schedules via scheduleGet', async () => {
    const world = await setupPortsWorld();
    const commands = registry();
    const deps = { store: world.store };
    const replaced = await commands.run(
      'schedule.replace',
      { key: 'sys-k', at: 5_000, event: 'Acme.due', payload: { n: 1 } },
      runCtx('sys-run-1'),
      deps,
    );
    assert.deepEqual(replaced.result, { key: 'sys-k' });
    assert.deepEqual(await world.store.scheduleGet('sys-k'), {
      key: 'sys-k',
      at: 5_000,
      event: 'Acme.due',
      payload: { n: 1 },
    });
    await commands.run(
      'schedule.replace',
      { key: 'sys-k', at: 6_000, event: 'Acme.due', payload: {} },
      runCtx('sys-run-2'),
      deps,
    );
    assert.deepEqual((await world.store.scheduleGet('sys-k'))?.at, 6_000);
    await commands.run('schedule.cancel', { keys: ['sys-k'] }, runCtx('sys-run-3'), deps);
    assert.equal(await world.store.scheduleGet('sys-k'), null);
    // Canceling an absent key — or an empty list — commits a no-op batch.
    await commands.run('schedule.cancel', { keys: ['missing'] }, runCtx('sys-run-4'), deps);
    const empty = await commands.run('schedule.cancel', { keys: [] }, runCtx('sys-run-5'), deps);
    assert.deepEqual(empty.result, { requested: 0 });
  });

  it('acks an intent staged in the same run batch', async () => {
    const world = await setupPortsWorld();
    const stageack = defineSystemCommand({
      name: 'test.stageack',
      stage: (args) => {
        const intentId = args['intentId'] as string;
        const operationId = args['operationId'] as string;
        const intent: OutboxIntent = {
          intentId,
          operation: asOperation('Acme.stage'),
          operationId: asOperationId(operationId),
          target: 'mail.send',
          arguments: {},
          occurrenceIndex: 0,
        };
        return { outbox: [intent], outboxAck: [intentId], result: { intentId } };
      },
    });
    const commands = createSystemRegistry([stageack]);
    await commands.run(
      'test.stageack',
      { intentId: 'sys-both', operationId: 'sys-run-1' },
      runCtx('sys-run-1'),
      { store: world.store },
    );
    assert.deepEqual(await pendingIntentIds(world.store), []);
  });

  it('fails a run with a malformed staged intent and persists nothing', async () => {
    const world = await setupPortsWorld();
    const badstage = defineSystemCommand({
      name: 'test.badstage',
      stage: () => ({
        outbox: [
          {
            intentId: '',
            operation: asOperation('Acme.stage'),
            operationId: asOperationId('sys-run-1'),
            target: 'mail.send',
            arguments: {},
            occurrenceIndex: 0,
          },
        ],
      }),
    });
    const commands = createSystemRegistry([badstage]);
    const before = await world.store.readRevision();
    const error = await captureStateError(() =>
      commands.run('test.badstage', {}, runCtx('sys-run-1'), { store: world.store }),
    );
    assert.equal(error.code, 'validation');
    assert.equal(await world.store.readRevision(), before);
    assert.deepEqual(await pendingIntentIds(world.store), []);
  });
});
