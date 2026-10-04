/**
 * Lane 03 S5 rejected-receipt tests (test worker): execute-thrown business
 * rejections commit fenced rejected receipts and replay without re-executing
 * (code/message only — fields are not restored), while bugs and
 * admission-time rejections never receipt.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { invoke } from '../../src/invocation/invoke.js';
import type { ExecuteHandler } from '../../src/invocation/invoke.js';
import { StateError } from '../../src/errors.js';
import { captureFailure, makeDef, makeEnvelope } from '../invocation/fixtures.js';
import {
  APP,
  FIXED_NOW,
  captureStateError,
  freshOperationId,
  identityFor,
  modelDef,
  readCrudReceipt,
  setupMutation,
} from './fixtures.js';

const OPERATION = 'Acme.approve';

describe('mutation rejected receipts', () => {
  it('receipts execute-thrown rejections and rethrows the original error', async () => {
    const world = await setupMutation([modelDef('Acme.Doc')]);
    const def = makeDef();
    const registry = new Map([[def.name as string, def]]);
    const fields = [{ path: '/amount', code: 'too_big', message: 'Too big.' }];
    const execute: ExecuteHandler = async () => {
      throw new StateError('rule_failed', 'Nope.', null, { retryable: true, fields });
    };
    const operationId = freshOperationId();
    const error = await captureStateError(
      invoke({
        registry,
        envelope: makeEnvelope(OPERATION, operationId),
        identity: identityFor(world.alice),
        app: APP,
        source: 'test',
        store: world.store,
        memberships: world.memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute,
      }),
    );
    // This caller sees the original error, fields/retryable preserved.
    assert.equal(error.code, 'rule_failed');
    assert.equal(error.message, 'Nope.');
    assert.equal(error.retryable, true);
    assert.deepEqual(error.fields, fields);
    // The fenced rejected receipt carries code/message only.
    const receipt = await readCrudReceipt(world, { operation: OPERATION, operationId });
    assert.ok(receipt !== null);
    assert.deepEqual(receipt.outcome, { status: 'rejected', code: 'rule_failed', message: 'Nope.' });
    assert.deepEqual(receipt.resolvedDefaults, {});
  });

  it('replays rejections without re-executing and without restoring fields', async () => {
    const world = await setupMutation([modelDef('Acme.Doc')]);
    const def = makeDef();
    const registry = new Map([[def.name as string, def]]);
    let calls = 0;
    const execute: ExecuteHandler = async () => {
      calls += 1;
      throw new StateError('rule_failed', 'Nope.', null, {
        retryable: true,
        fields: [{ path: '/amount', code: 'too_big', message: 'Too big.' }],
      });
    };
    const operationId = freshOperationId();
    const call = () =>
      invoke({
        registry,
        envelope: makeEnvelope(OPERATION, operationId),
        identity: identityFor(world.alice),
        app: APP,
        source: 'test',
        store: world.store,
        memberships: world.memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute,
      });
    await captureStateError(call());
    assert.equal(calls, 1);
    const replayed = await captureStateError(call());
    assert.equal(calls, 1);
    assert.equal(replayed.code, 'rule_failed');
    assert.equal(replayed.message, 'Nope.');
    // Documented gap: the receipt shape carries no fields/retryable.
    assert.equal(replayed.fields, undefined);
    assert.equal(replayed.retryable, undefined);
  });

  it('propagates non-StateError bugs without committing a receipt', async () => {
    const world = await setupMutation([modelDef('Acme.Doc')]);
    const def = makeDef();
    const registry = new Map([[def.name as string, def]]);
    const execute: ExecuteHandler = async () => {
      throw new Error('boom');
    };
    const operationId = freshOperationId();
    const failure = await captureFailure(
      invoke({
        registry,
        envelope: makeEnvelope(OPERATION, operationId),
        identity: identityFor(world.alice),
        app: APP,
        source: 'test',
        store: world.store,
        memberships: world.memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute,
      }),
    );
    assert.ok(failure instanceof Error && !(failure instanceof StateError));
    assert.equal((failure as Error).message, 'boom');
    assert.equal(await readCrudReceipt(world, { operation: OPERATION, operationId }), null);
  });

  it('commits no receipt for admission-time rejections', async () => {
    const world = await setupMutation([modelDef('Acme.Doc')]);
    const def = makeDef({ by: 'owner' });
    const registry = new Map([[def.name as string, def]]);
    let calls = 0;
    const execute: ExecuteHandler = async () => {
      calls += 1;
      throw new Error('unreachable: forbidden admits never execute');
    };
    const operationId = freshOperationId();
    // Alice is a plain member, so the owner-gated def rejects at admission.
    const error = await captureStateError(
      invoke({
        registry,
        envelope: makeEnvelope(OPERATION, operationId),
        identity: identityFor(world.alice),
        app: APP,
        source: 'test',
        store: world.store,
        memberships: world.memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute,
      }),
    );
    assert.equal(error.code, 'forbidden');
    assert.equal(calls, 0);
    assert.equal(await readCrudReceipt(world, { operation: OPERATION, operationId }), null);
  });

  it('rejects input-hash mismatch on a rejected receipt with conflict', async () => {
    const world = await setupMutation([modelDef('Acme.Doc')]);
    const def = makeDef();
    const registry = new Map([[def.name as string, def]]);
    const execute: ExecuteHandler = async () => {
      throw new StateError('rule_failed', 'Nope.');
    };
    const operationId = freshOperationId();
    const call = (inputs: Record<string, unknown>) =>
      invoke({
        registry,
        envelope: makeEnvelope(OPERATION, operationId, inputs),
        identity: identityFor(world.alice),
        app: APP,
        source: 'test',
        store: world.store,
        memberships: world.memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute,
      });
    await captureStateError(call({}));
    // Same identity, different inputs: the receipt check fires first.
    const error = await captureStateError(call({ extra: 1 }));
    assert.equal(error.code, 'conflict');
  });
});
