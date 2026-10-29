import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { OutboxIntent } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { asId, asModel, makeBatch, makeRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { RECEIPT_MODEL, readReceiptRow, withReceiptRowData } from '@canlang/state/receipt/tables';
import { WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { WORK_DISPATCH_MODEL, readDispatchRow } from '@canlang/work/kernel/tables';
import { attemptDispatch } from '@canlang/work/dispatch';
import { planRecoveryScan } from '@canlang/work/recovery';
import { classifyFailure } from '@canlang/work/receipt';
import { createBoundMailDispatcher } from '../src/runtime/bound-dispatch.js';
import type { BoundMailDispatcher } from '../src/runtime/bound-dispatch.js';
import type { BoundMailAdapter } from '../src/runtime/bound-mail.js';
import type { FenceAttemptDispatchFn } from '../src/runtime/invoke.js';

const now = Date.parse('2026-10-28T00:00:00.000Z');
const INTENT_ID = 'mail-unavailable-1';
const TARGET = 'std.EmailV1.send';
const GUARD = 'test.guard.holds';

it('terminalizes deployment-unavailable mail before guard evaluation', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-mail-unavailable-'));
  let sequence = 0;
  let clock = now;
  let worker: Miniflare | undefined;
  const calls: string[] = [];
  const guardEvals: string[] = [];
  let snapshots = 0;
  // Deployment bindings declare mail unavailable; nothing downstream of
  // the fence kernel may run — no guard evaluation, no recipient
  // resolution, no provider call, no reconcile.
  const adapter: BoundMailAdapter = {
    available: () => false,
    userRecipient: () => { throw new Error('unavailable send must not resolve recipients'); },
    recipientActive: async () => { throw new Error('unavailable send must not check recipients'); },
    resolveRecipient: async () => { throw new Error('unavailable send must not resolve recipients'); },
    callProvider: async () => {
      calls.push('call');
      throw new Error('unavailable send must not call the provider');
    },
    reconcile: async () => {
      calls.push('reconcile');
      return null;
    },
  };

  const boot = async () => {
    worker = new Miniflare({
      compatibilityDate: '2026-07-15',
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Persist: join(directory, 'd1'),
      d1Databases: { DB: 'mail-unavailable' },
    });
    const db = (await worker.getD1Database('DB')) as unknown as D1Database;
    await ensureSchema(db);
    const store = createD1Storage(db);
    const dispatcher = await createBoundMailDispatcher({
      store,
      adapter,
      workCommands: WORK_SYSTEM_COMMANDS,
      stageCommands: WORK_DISPATCH_STAGE_COMMANDS,
      createClaimCommand: createWorkDispatchClaimCommand,
    });
    return { store, dispatcher };
  };

  try {
    const first = await boot();
    const intent: OutboxIntent = {
      intentId: INTENT_ID,
      operation: 'test.mail.send' as OutboxIntent['operation'],
      operationId: uuidv7(now, ++sequence) as OutboxIntent['operationId'],
      target: TARGET,
      arguments: {
        binding: 'deployment.mail',
        from: 'test.app',
        arguments: { value: { to: 'nobody@example.test', subject: 'unavailable' } },
      },
      occurrenceIndex: 0,
      dispatchGuard: GUARD,
    };
    const dispatchRow = makeRow({
      id: asId(INTENT_ID),
      data: {
        intentId: INTENT_ID,
        operationId: intent.operationId,
        source: TARGET,
        occurrenceIndex: 0,
        originOccurrence: null,
        state: 'pending',
        attempts: 0,
        claimId: null,
        claimedAtMs: null,
        guardVerdict: null,
        deliveryId: null,
        errorCode: null,
        errorMessage: null,
        availableAtMs: null,
        firstAttemptAtMs: null,
        retryClass: null,
      },
    });
    const pendingReceipt = withReceiptRowData(
      makeRow({ id: asId(INTENT_ID) }),
      {
        deliveryId: INTENT_ID,
        revision: 0,
        status: 'pending',
        result: null,
        error: null,
        contentRef: null,
        resultExpiresAtMs: null,
      },
      { nowMs: now, actor: 'test:mail-unavailable' },
    );
    await first.store.commit(makeBatch(await first.store.readRevision(), {
      outbox: [intent],
      writes: [
        { kind: 'insert', model: WORK_DISPATCH_MODEL, row: dispatchRow },
        { kind: 'insert', model: asModel(RECEIPT_MODEL), row: pendingReceipt },
      ],
    }));

    let claims = 0;
    const drive = (dispatcher: BoundMailDispatcher) =>
      dispatcher.drive({
        intentId: INTENT_ID,
        actor: 'test:mail-unavailable',
        operation: 'test.mail.send.dispatch',
        nowMs: () => clock,
        nextClaimId: () => `mail-claim-${++claims}`,
        maxClaimAgeMs: 60000,
        claimOperationId: uuidv7(now, ++sequence),
        recordOperationId: uuidv7(now, ++sequence),
        classifyFailure,
        evaluateGuard: (predicate) => {
          guardEvals.push(String(predicate));
          return true;
        },
        readStateSnapshot: () => {
          snapshots += 1;
          return {};
        },
        fence: {
          owner: 'test-owner',
          attemptDispatch: attemptDispatch as unknown as FenceAttemptDispatchFn,
          revalidateAuthority: async () => true,
        },
      });

    // Drive 1: the kernel preflights deployment availability before
    // guard evaluation; the bound drive terminalizes the refusal
    // under the held claim.
    const driven = await drive(first.dispatcher);
    assert.equal(driven.status, 'unavailable');
    assert.equal(driven.target, TARGET);
    assert.equal(calls.length, 0);
    assert.equal(snapshots, 1, 'guard pre-read ran, so the empty eval list is meaningful');
    assert.equal(guardEvals.length, 0, 'kernel refused before guard evaluation');

    const receiptRow = await first.store.load(asModel(RECEIPT_MODEL), asId(INTENT_ID));
    assert.ok(receiptRow);
    const receipt = readReceiptRow(receiptRow).receipt;
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.error?.code, 'unavailable');
    assert.ok(receipt.error?.message.includes(TARGET));

    const dispatchLoaded = await first.store.load(WORK_DISPATCH_MODEL, asId(INTENT_ID));
    assert.ok(dispatchLoaded);
    const dispatch = readDispatchRow(dispatchLoaded);
    assert.equal(dispatch.state, 'failed');
    assert.equal(dispatch.retryClass, 'terminal');
    assert.equal(dispatch.attempts, 1);
    assert.equal(dispatch.errorCode, 'unavailable');

    // Settled: acked, never re-driven.
    const replayed = await drive(first.dispatcher);
    assert.equal(replayed.status, 'not-pending');
    assert.equal(calls.length, 0);
    assert.equal(guardEvals.length, 0);

    // Recovery leaves the terminal row alone.
    const sweep = await first.dispatcher.recover({
      actor: 'test:mail-unavailable',
      operation: 'test.mail.send.recover',
      nowMs: () => clock,
      maxClaimAgeMs: 60000,
      limit: 10,
      policy: { maxAttempts: 3, horizonMs: 3600000 },
      planRecoveryScan,
      operationIdForStep: () => uuidv7(clock, ++sequence),
      admission: {
        fence: {
          owner: 'test-owner',
          attemptDispatch: attemptDispatch as unknown as FenceAttemptDispatchFn,
          revalidateAuthority: async () => true,
        },
        evaluateGuard: (predicate) => {
          guardEvals.push(String(predicate));
          return true;
        },
        readStateSnapshot: () => ({}),
      },
    });
    assert.deepEqual(sweep.reconciled, []);
    assert.deepEqual(await first.store.load(asModel(RECEIPT_MODEL), asId(INTENT_ID)), receiptRow);
    assert.equal(calls.length, 0);
    assert.equal(guardEvals.length, 0);

    // Genuine restart: still settled, still byte-identical.
    await worker!.dispose();
    worker = undefined;
    clock += 3600000;
    const second = await boot();
    const settled = await drive(second.dispatcher);
    assert.equal(settled.status, 'not-pending');
    assert.deepEqual(await second.store.load(asModel(RECEIPT_MODEL), asId(INTENT_ID)), receiptRow);
    assert.equal(calls.length, 0);
    assert.equal(guardEvals.length, 0);
  } finally {
    await worker?.dispose();
  }
});
