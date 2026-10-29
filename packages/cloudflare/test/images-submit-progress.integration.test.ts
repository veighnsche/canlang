/**
 * Images submit rich-progress durable journey: file-free submit through
 * the real images dispatcher over a real persisted D1 store, with a
 * scripted provider transport at the `BoundImagesAdapter` seam.
 *
 * Only provider transport is scripted (progress envelopes + terminal
 * delivery); dispatch claims, rich-progress staging, receipt retention,
 * replay, and recovery all execute for real. Mid-flight restart is a
 * genuine Miniflare dispose + reopen over the same persisted D1: the
 * terminal drive must reproduce the exact retained outcome, and
 * post-terminal replay must leave receipt bytes identical.
 *
 * The terminal `ProgressTerminalNotification` value has no durable
 * consumer anywhere yet (all relations); this journey pins the
 * retained terminal outcome + evidence reads, and that gap is recorded
 * as a cross-lane follow-up rather than asserted here.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { OutboxIntent, ReceiptResultContext } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { asId, asModel, makeBatch, makeRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL, readReceiptRow, withReceiptRowData } from '@canlang/state/receipt/tables';
import { WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { WORK_DISPATCH_MODEL } from '@canlang/work/kernel/tables';
import { attemptDispatch } from '@canlang/work/dispatch';
import { planRecoveryScan } from '@canlang/work/recovery';
import { classifyFailure } from '@canlang/work/receipt';
import { createBoundImagesDispatcher } from '../src/runtime/bound-dispatch.js';
import type { BoundMailDispatcher } from '../src/runtime/bound-dispatch.js';
import type { BoundImagesAdapter, BoundImagesCallOptions, ImageRunWire } from '../src/runtime/bound-images.js';
import type { DispatchProviderOutcome, FenceAttemptDispatchFn } from '../src/runtime/invoke.js';

const now = Date.parse('2026-10-28T00:00:00.000Z');
const INTENT_ID = 'img-submit-1';
const TARGET = 'std.ImagesV1.submit';
const SOURCE = 'run-src';
const REVISION = '1';

const DECLARED_RESULT = {
  name: 'ImageRun',
  fields: [
    { name: 'source', type: 'text' },
    { name: 'revision', type: 'int' },
    { name: 'sequence', type: 'int' },
    { name: 'state', type: 'enum(queued,running,succeeded,failed,unknown,cancelled)' },
    { name: 'outputs', type: 'GeneratedImage[]' },
    { name: 'charged_jobs', type: 'int?' },
    { name: 'detail', type: 'text?' },
  ],
} as const;

const CONTEXT: ReceiptResultContext = {
  source: TARGET,
  declaredResult: DECLARED_RESULT as unknown as ReceiptResultContext['declaredResult'],
  request: { source: SOURCE, revision: REVISION },
};

function wire(sequence: string, state: string): ImageRunWire {
  return Object.freeze({
    source: SOURCE,
    revision: REVISION,
    sequence,
    state,
    outputs: [],
    charged_jobs: null,
    detail: null,
  });
}

const QUEUED = wire('0', 'queued');
const RUNNING = wire('1', 'running');
const TERMINAL = wire('2', 'succeeded');

it('drives Images submit progress to a retained terminal across restart', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-images-submit-'));
  let sequence = 0;
  let clock = now;
  let worker: Miniflare | undefined;
  const calls: string[] = [];
  // Scripted provider transport: first drive streams progress then loses
  // the terminal; every later drive delivers it.
  const adapter: BoundImagesAdapter = {
    available: () => true,
    resultContext: () => CONTEXT,
    controlCorrelation: () => null,
    controlObservation: () => null,
    observeControl: async () => ({ kind: 'uncertain' }),
    cancel: async () => null,
    reconcile: async (intent: OutboxIntent, options: BoundImagesCallOptions) => {
      calls.push(`reconcile:${intent.intentId}`);
      // Images recovery only trusts a confirmed terminal observation of
      // the original job, matching the reconciled answer.
      await options.onProgress(TERMINAL);
      return { kind: 'delivered', result: TERMINAL };
    },
    callProvider: async (intent: OutboxIntent, options: BoundImagesCallOptions): Promise<DispatchProviderOutcome> => {
      calls.push(`call:${intent.intentId}`);
      assert.equal(intent.intentId, INTENT_ID);
      await options.onQueued(QUEUED);
      await options.onProgress(RUNNING);
      return { kind: 'uncertain' };
    },
  };

  const boot = async () => {
    worker = new Miniflare({
      compatibilityDate: '2026-07-15',
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Persist: join(directory, 'd1'),
      d1Databases: { DB: 'images-submit' },
    });
    const db = (await worker.getD1Database('DB')) as unknown as D1Database;
    await ensureSchema(db);
    const store = createD1Storage(db);
    const dispatcher = await createBoundImagesDispatcher({
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
      operation: 'test.images.submit' as OutboxIntent['operation'],
      operationId: uuidv7(now, ++sequence) as OutboxIntent['operationId'],
      target: TARGET,
      arguments: {
        binding: 'deployment.images',
        from: 'test.app',
        arguments: { value: { source: SOURCE, revision: REVISION } },
      },
      occurrenceIndex: 0,
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
      { nowMs: now, actor: 'test:images-submit' },
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
        actor: 'test:images-submit',
        operation: 'test.images.submit.dispatch',
        nowMs: () => clock,
        nextClaimId: () => `images-claim-${++claims}`,
        maxClaimAgeMs: 60000,
        claimOperationId: uuidv7(now, ++sequence),
        recordOperationId: uuidv7(now, ++sequence),
        classifyFailure,
        evaluateGuard: () => { throw new Error('Unconditional submit must not invent a guard'); },
        readStateSnapshot: () => null,
        fence: {
          owner: 'test-owner',
          attemptDispatch: attemptDispatch as unknown as FenceAttemptDispatchFn,
          revalidateAuthority: async () => true,
        },
      });

    // Drive 1: progress commits durably; the terminal is lost in transport.
    const driven = await drive(first.dispatcher);
    assert.equal(driven.status, 'recorded');
    assert.deepEqual(calls, [`call:${INTENT_ID}`]);
    const progressed = await first.store.load(asModel(RECEIPT_MODEL), asId(INTENT_ID));
    assert.ok(progressed);
    const running = readReceiptRow(progressed, CONTEXT).receipt;
    assert.equal(running.status, 'pending');
    assert.deepEqual(running.result, RUNNING);
    const retainedAssociations = await first.store.query({
      model: asModel(RECEIPT_ASSOCIATION_MODEL),
      where: { op: 'eq', field: 'deliveryId', value: INTENT_ID },
      authority: 'owner',
    });
    assert.deepEqual(retainedAssociations, [], 'retained path stages no association');

    // Genuine restart: dispose the worker and reopen over persisted D1.
    // Time advances past the held claim and any retry backoff. Uncertain
    // rows never re-drive; recovery reconciles the terminal delivery.
    await worker!.dispose();
    worker = undefined;
    clock += 3600000;
    const second = await boot();
    const sweep = await second.dispatcher.recover({
      actor: 'test:images-submit',
      operation: 'test.images.submit.recover',
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
        evaluateGuard: () => { throw new Error('Unconditional submit must not invent a guard'); },
        readStateSnapshot: () => null,
      },
    });
    assert.ok(
      sweep.reconciled.some(item => item.intentId === INTENT_ID && item.state === 'delivered'),
      JSON.stringify(sweep),
    );
    const terminalRow = await second.store.load(asModel(RECEIPT_MODEL), asId(INTENT_ID));
    assert.ok(terminalRow);
    const completed = readReceiptRow(terminalRow, CONTEXT).receipt;
    assert.equal(completed.status, 'succeeded');
    assert.deepEqual(completed.result, TERMINAL);

    // Post-terminal replay: settled, byte-identical, no further provider calls.
    const replayed = await drive(second.dispatcher);
    assert.equal(replayed.status, 'not-pending');
    assert.deepEqual(await second.store.load(asModel(RECEIPT_MODEL), asId(INTENT_ID)), terminalRow);
    assert.deepEqual(calls, [`call:${INTENT_ID}`, `reconcile:${INTENT_ID}`]);

    // Restart after terminal: still settled, still identical.
    await worker!.dispose();
    worker = undefined;
    const third = await boot();
    const settled = await drive(third.dispatcher);
    assert.equal(settled.status, 'not-pending');
    assert.deepEqual(await third.store.load(asModel(RECEIPT_MODEL), asId(INTENT_ID)), terminalRow);
    assert.deepEqual(calls, [`call:${INTENT_ID}`, `reconcile:${INTENT_ID}`]);
  } finally {
    await worker?.dispose();
  }
});
