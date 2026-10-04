/**
 * Lane 03 S6 transaction-port tests: single-shot fenced commit passthrough
 * (domain + outbox + schedule land atomically), fence conflicts surfacing
 * as retryable `busy`, and the bound invoker running CRUD end to end with
 * exact replay.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInvoker, createTransactionPort } from '../../src/ports/index.js';
import { field, modelDef, setupMutation } from '../mutation/fixtures.js';
import { asOperationId, makeBatch, makeEnvelope } from '../invocation/fixtures.js';
import {
  APP,
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  captureStateError,
  freshOperationId,
  identityFor,
  makeWidgetRow,
  pendingIntentIds,
  setupPortsWorld,
} from './fixtures.js';

describe('createTransactionPort', () => {
  it('commits domain, outbox, and schedule writes atomically', async () => {
    const world = await setupPortsWorld();
    const port = createTransactionPort({ store: world.store });
    const row = makeWidgetRow('tx-w1', { title: 'Tx' });
    const committed = await port.commit(
      makeBatch(0, {
        writes: [{ kind: 'insert', model: world.model, row }],
        outbox: [
          {
            intentId: 'tx-i1',
            operation: asOperation('Acme.stage'),
            operationId: asOperationId('op-tx-1'),
            target: 'mail.send',
            arguments: { to: 'a@example.com' },
            occurrenceIndex: 0,
          },
        ],
        schedules: [
          {
            op: 'replace',
            key: 'tx-sched',
            at: 1_700_000_010_000,
            event: asOperation('Acme.due'),
            payload: {},
          },
        ],
      }),
    );
    assert.equal(committed.revision, 1);
    assert.equal(await port.readRevision(), 1);
    assert.deepEqual((await world.store.load(world.model, row.id))?.data, { title: 'Tx' });
    assert.deepEqual(await pendingIntentIds(world.store), ['tx-i1']);
    assert.deepEqual(await world.store.scheduleGet('tx-sched'), {
      key: 'tx-sched',
      at: 1_700_000_010_000,
      event: 'Acme.due',
      payload: {},
    });
  });

  it('maps a lost fence to retryable busy without persisting anything', async () => {
    const world = await setupPortsWorld();
    const port = createTransactionPort({ store: world.store });
    await port.commit(
      makeBatch(0, {
        writes: [{ kind: 'insert', model: world.model, row: makeWidgetRow('tx-winner') }],
      }),
    );
    const error = await captureStateError(() =>
      port.commit(
        makeBatch(0, {
          writes: [{ kind: 'insert', model: world.model, row: makeWidgetRow('tx-loser') }],
        }),
      ),
    );
    assert.equal(error.code, 'busy');
    assert.equal(error.retryable, true);
    assert.equal(await port.readRevision(), 1);
    assert.equal(await world.store.load(world.model, asId('tx-loser')), null);
  });
});

describe('createInvoker', () => {
  it('runs CRUD end to end and replays the identical envelope', async () => {
    const world = await setupMutation([modelDef('Acme.Widget', { fields: { title: field() } })]);
    const invoker = createInvoker({
      registry: world.registry,
      store: world.store,
      memberships: world.memberships,
      clock: { nowMs: () => FIXED_NOW },
    });
    const operationId = freshOperationId();
    const args = {
      envelope: makeEnvelope('Acme.Widget.create', operationId, {
        id: 'inv-w1',
        data: { title: 'Invoked' },
      }),
      identity: identityFor(world.alice),
      app: APP,
      source: 'test',
      execute: world.execute,
    };
    const first = await invoker(args);
    assert.equal(first.status, 'committed');
    assert.equal(first.operation_id, operationId);
    assert.deepEqual(
      (await world.store.load(asModel('Acme.Widget'), asId('inv-w1')))?.data,
      { title: 'Invoked' },
    );
    const second = await invoker(args);
    assert.equal(second.status, 'replayed');
    assert.equal(second.operation_id, operationId);
    assert.deepEqual(second.result, first.result);
  });
});
