/**
 * S9b-2: kernel command stages transition rows correctly through
 * hand-faked readers-only contexts. These tests prove MY stage logic
 * (ordering, refusals, conditional updates, idempotency); the L3
 * registry/commit behavior stays L3-tested and is never duplicated.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ModelName,
  QuerySpec,
  RecordId,
  StoredRow,
} from '../../contracts/src/state.js';
import type {
  SystemCommandContext,
  SystemCommandDef,
  SystemStaging,
} from '../../state/src/ports/system.ts';
import {
  WORK_DISPATCH_MODEL,
  WORK_EVERY_SLOT_MODEL,
  WORK_OCCURRENCE_MODEL,
  WORK_SCHEDULE_MODEL,
  WORK_SUPERSESSION_MODEL,
  newDispatchRow,
  newEverySlotRow,
  newOccurrenceRow,
  newScheduleRow,
  newSupersessionRow,
  readDispatchRow,
} from '../src/kernel/tables.ts';
import { KernelTableError } from '../src/kernel/tables.ts';
import {
  WORK_SYSTEM_COMMANDS,
  workDispatchClaimCommand,
  workDispatchRecordAttemptCommand,
  workDispatchRequeueCommand,
  workDispatchReleaseCommand,
  workDispatchSupersedeCommand,
  workEveryAdvanceSlotCommand,
  workOccurrencePutReceiptCommand,
  workScheduleCancelCommand,
  workSchedulePutCommand,
} from '../src/kernel/commands.ts';
import { RootRecurrenceNotSupportedError } from '../src/schedule/every.ts';

const NOW = 1_758_000_000_000;
const ACTOR = 'dispatcher-test';
const MAX_AGE = 60_000;

function seed(
  entries: ReadonlyArray<{ model: ModelName; row: StoredRow }>,
): Map<string, StoredRow> {
  const map = new Map<string, StoredRow>();
  for (const entry of entries) {
    map.set(`${entry.model}\0${entry.row.id}`, entry.row);
  }
  return map;
}

function fakeCtx(store: Map<string, StoredRow>): SystemCommandContext {
  return {
    actor: ACTOR,
    now: NOW,
    operation: 'test.dispatch',
    load: async (model: ModelName, id: RecordId) =>
      store.get(`${model}\0${id}`) ?? null,
    // Deliberately unfiltered: stages must re-filter exactly, and the
    // decoy rows below prove it.
    query: async (spec: QuerySpec) =>
      [...store.entries()]
        .filter(([key]) => key.startsWith(`${spec.model}\0`))
        .map(([, row]) => row),
  };
}

/**
 * Run one stage as a genuine promise. Stages may return sync or async
 * per `SystemCommandDef`; `Promise.resolve` adopts either (and any
 * rejection), which is what `assert.rejects` needs.
 */
function runStage(
  stage: SystemCommandDef['stage'],
  args: Record<string, unknown>,
  ctx: SystemCommandContext,
): Promise<SystemStaging> {
  return Promise.resolve(stage(args, ctx));
}

function dispatchRow(
  intentId: string,
  over: Record<string, unknown> = {},
): StoredRow {
  const base = newDispatchRow(
    {
      intentId,
      operationId: 'op_1',
      source: 'std.EmailV1.send',
      occurrenceIndex: 0,
      originOccurrence: 'occ_9',
    },
    { nowMs: NOW, actor: ACTOR },
  );
  return { ...base, data: { ...readDispatchRow(base), ...over } };
}

describe('kernel commands: registry shape', () => {
  it('exports 9 uniquely named dot-namespaced commands', () => {
    assert.equal(WORK_SYSTEM_COMMANDS.length, 9);
    const names = WORK_SYSTEM_COMMANDS.map((command) => command.name);
    assert.equal(new Set(names).size, 9);
    for (const name of names) {
      assert.match(name, /^work\.[a-z-]+\.[a-z-]+$/);
    }
  });
});

describe('kernel commands: dispatch.claim', () => {
  it('claims pending rows with a fenced conditional update', async () => {
    const row = dispatchRow('op_1#0');
    const ctx = fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row }]));
    const staged = await workDispatchClaimCommand.stage(
      {
        intentId: 'op_1#0',
        claimId: 'claim_1',
        claimedAtMs: NOW,
        maxClaimAgeMs: MAX_AGE,
      },
      ctx,
    );
    assert.equal(staged.writes?.length, 1);
    const write = staged.writes?.[0];
    assert.equal(write?.kind, 'update');
    if (write?.kind === 'update') {
      assert.equal(write.model, WORK_DISPATCH_MODEL);
      assert.equal(write.id, 'op_1#0');
      assert.equal(write.expectedVersion, 1);
      assert.deepEqual(readDispatchRow(write.row), {
        ...readDispatchRow(row),
        state: 'claimed',
        claimId: 'claim_1',
        claimedAtMs: NOW,
      });
    }
    assert.deepEqual(staged.result, {
      claimed: true,
      intentId: 'op_1#0',
      claimId: 'claim_1',
    });
  });

  it('refuses superseded, guard-pinned, held and settled rows without writes', async () => {
    const held = dispatchRow('op_1#1', {
      state: 'claimed',
      claimId: 'winner',
      claimedAtMs: NOW,
    });
    const stale = dispatchRow('op_1#2', {
      state: 'claimed',
      claimId: 'old',
      claimedAtMs: NOW - MAX_AGE,
    });
    const pinned = dispatchRow('op_1#3', { guardVerdict: false });
    const settled = dispatchRow('op_1#4', { state: 'delivered' });
    const marked = dispatchRow('op_1#5');
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row: held },
        { model: WORK_DISPATCH_MODEL, row: stale },
        { model: WORK_DISPATCH_MODEL, row: pinned },
        { model: WORK_DISPATCH_MODEL, row: settled },
        { model: WORK_DISPATCH_MODEL, row: marked },
        {
          model: WORK_SUPERSESSION_MODEL,
          row: newSupersessionRow(
            { outboxId: 'op_1#5', byOccurrenceId: 'occ_1', markedAtMs: NOW },
            { nowMs: NOW, actor: ACTOR },
          ),
        },
      ]),
    );
    const drive = (intentId: string) =>
      workDispatchClaimCommand.stage(
        { intentId, claimId: 'claim_9', claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE },
        ctx,
      );
    // Superseded refuses before anything else.
    assert.deepEqual((await drive('op_1#5')).result, {
      claimed: false,
      reason: 'superseded',
      intentId: 'op_1#5',
    });
    assert.equal((await drive('op_1#5')).writes, undefined);
    // Guard-false pins undispatched.
    assert.deepEqual((await drive('op_1#3')).result, {
      claimed: false,
      reason: 'guard-false',
      intentId: 'op_1#3',
    });
    // Fresh claims lose and observe the winner.
    assert.deepEqual((await drive('op_1#1')).result, {
      claimed: false,
      reason: 'claimed',
      intentId: 'op_1#1',
      claimId: 'winner',
    });
    // Boundary-inclusive staleness reclaims (claimedAt + maxAge <= now).
    const reclaimed = await drive('op_1#2');
    assert.deepEqual(reclaimed.result, {
      claimed: true,
      reclaimed: true,
      intentId: 'op_1#2',
      claimId: 'claim_9',
    });
    assert.equal(reclaimed.writes?.length, 1);
    // Settled rows refuse with their state.
    assert.deepEqual((await drive('op_1#4')).result, {
      claimed: false,
      reason: 'settled',
      intentId: 'op_1#4',
      state: 'delivered',
    });
  });

  it('defers pending rows with a future availability', async () => {
    const row = dispatchRow('op_1#0', { availableAtMs: NOW + 5000 });
    const ctx = fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row }]));
    const staged = await workDispatchClaimCommand.stage(
      {
        intentId: 'op_1#0',
        claimId: 'claim_1',
        claimedAtMs: NOW,
        maxClaimAgeMs: MAX_AGE,
      },
      ctx,
    );
    assert.deepEqual(staged.result, {
      claimed: false,
      reason: 'deferred',
      intentId: 'op_1#0',
      availableAtMs: NOW + 5000,
    });
    assert.equal(staged.writes, undefined);
  });

  it('reports settled before guard-false on terminal rows', async () => {
    const row = dispatchRow('op_1#0', { state: 'failed', guardVerdict: false });
    const ctx = fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row }]));
    const staged = await workDispatchClaimCommand.stage(
      {
        intentId: 'op_1#0',
        claimId: 'claim_1',
        claimedAtMs: NOW,
        maxClaimAgeMs: MAX_AGE,
      },
      ctx,
    );
    assert.deepEqual(staged.result, {
      claimed: false,
      reason: 'settled',
      intentId: 'op_1#0',
      state: 'failed',
    });
    assert.equal(staged.writes, undefined);
  });

  it('throws loudly on missing rows and bad args', async () => {
    const ctx = fakeCtx(seed([]));
    await assert.rejects(
      runStage(
        workDispatchClaimCommand.stage,
        {
          intentId: 'ghost',
          claimId: 'c',
          claimedAtMs: NOW,
          maxClaimAgeMs: MAX_AGE,
        },
        ctx,
      ),
      KernelTableError,
    );
    await assert.rejects(
      runStage(workDispatchClaimCommand.stage, { intentId: '' }, ctx),
      KernelTableError,
    );
  });
});

describe('kernel commands: dispatch.record-attempt', () => {
  it('records terminal attempts with attempts+1, cleared claim and ack', async () => {
    const row = dispatchRow('op_1#0', {
      state: 'claimed',
      claimId: 'claim_1',
      claimedAtMs: NOW,
      attempts: 2,
    });
    const ctx = fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row }]));
    const staged = await workDispatchRecordAttemptCommand.stage(
      {
        intentId: 'op_1#0',
        claimId: 'claim_1',
        outcome: {
          state: 'uncertain',
          errorCode: 'provider_transient',
          errorMessage: 'boom',
          availableAtMs: NOW + 1000,
        },
        ack: false,
      },
      ctx,
    );
    assert.equal(staged.writes?.length, 1);
    const write = staged.writes?.[0];
    assert.equal(write?.kind, 'update');
    if (write?.kind === 'update') {
      assert.equal(write.expectedVersion, 1);
      assert.deepEqual(readDispatchRow(write.row), {
        ...readDispatchRow(row),
        state: 'uncertain',
        attempts: 3,
        firstAttemptAtMs: NOW,
        claimId: null,
        claimedAtMs: null,
        deliveryId: null,
        errorCode: 'provider_transient',
        errorMessage: 'boom',
        availableAtMs: NOW + 1000,
      });
    }
    assert.deepEqual(staged.result, {
      recorded: true,
      intentId: 'op_1#0',
      state: 'uncertain',
      attempts: 3,
    });
    assert.equal(staged.outboxAck, undefined);
  });

  it('acks terminally settled intents and records skips without attempts', async () => {
    const done = dispatchRow('op_1#0', {
      state: 'claimed',
      claimId: 'claim_1',
      claimedAtMs: NOW,
    });
    const skip = dispatchRow('op_1#1', {
      state: 'claimed',
      claimId: 'claim_2',
      claimedAtMs: NOW,
      attempts: 1,
    });
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row: done },
        { model: WORK_DISPATCH_MODEL, row: skip },
      ]),
    );
    const delivered = await workDispatchRecordAttemptCommand.stage(
      {
        intentId: 'op_1#0',
        claimId: 'claim_1',
        outcome: { state: 'delivered', deliveryId: 'mail_1' },
        ack: true,
      },
      ctx,
    );
    assert.deepEqual(delivered.outboxAck, ['op_1#0']);
    assert.deepEqual(delivered.result, {
      recorded: true,
      intentId: 'op_1#0',
      state: 'delivered',
      attempts: 1,
    });
    const skipped = await workDispatchRecordAttemptCommand.stage(
      {
        intentId: 'op_1#1',
        claimId: 'claim_2',
        outcome: { state: 'pending', guardVerdict: false },
        ack: true,
      },
      ctx,
    );
    const write = skipped.writes?.[0];
    assert.equal(write?.kind, 'update');
    if (write?.kind === 'update') {
      const data = readDispatchRow(write.row);
      assert.equal(data.state, 'pending');
      assert.equal(data.guardVerdict, false);
      assert.equal(data.attempts, 1);
      assert.equal(data.claimId, null);
    }
    assert.deepEqual(skipped.outboxAck, ['op_1#1']);
  });

  it('requires a retry class on failed outcomes and stores it', async () => {
    const row = dispatchRow('op_1#0', {
      state: 'claimed',
      claimId: 'claim_1',
      claimedAtMs: NOW,
    });
    const ctx = fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row }]));
    await assert.rejects(
      runStage(
        workDispatchRecordAttemptCommand.stage,
        {
          intentId: 'op_1#0',
          claimId: 'claim_1',
          outcome: { state: 'failed', errorCode: 'boom' },
          ack: false,
        },
        ctx,
      ),
      /retryClass must be transient or terminal/,
    );
    const staged = await workDispatchRecordAttemptCommand.stage(
      {
        intentId: 'op_1#0',
        claimId: 'claim_1',
        outcome: { state: 'failed', retryClass: 'transient', errorCode: 'boom' },
        ack: false,
      },
      ctx,
    );
    const write = staged.writes?.[0];
    assert.equal(write?.kind, 'update');
    if (write?.kind === 'update') {
      assert.equal(readDispatchRow(write.row).retryClass, 'transient');
    }
  });

  it('rejects rival claims, unclaimed rows and malformed outcomes', async () => {
    const row = dispatchRow('op_1#0', {
      state: 'claimed',
      claimId: 'claim_1',
      claimedAtMs: NOW,
    });
    const pending = dispatchRow('op_1#1');
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row },
        { model: WORK_DISPATCH_MODEL, row: pending },
      ]),
    );
    // Rival claim id.
    await assert.rejects(
      runStage(
        workDispatchRecordAttemptCommand.stage,
        {
          intentId: 'op_1#0',
          claimId: 'rival',
          outcome: { state: 'delivered' },
          ack: true,
        },
        ctx,
      ),
      /does not hold/,
    );
    // Unclaimed row.
    await assert.rejects(
      runStage(
        workDispatchRecordAttemptCommand.stage,
        {
          intentId: 'op_1#1',
          claimId: 'claim_9',
          outcome: { state: 'delivered' },
          ack: true,
        },
        ctx,
      ),
      /does not hold/,
    );
    // Pending without a false verdict is not a skip.
    await assert.rejects(
      runStage(
        workDispatchRecordAttemptCommand.stage,
        {
          intentId: 'op_1#0',
          claimId: 'claim_1',
          outcome: { state: 'pending' },
          ack: false,
        },
        ctx,
      ),
      /require guardVerdict false/,
    );
    // Unknown outcome state.
    await assert.rejects(
      runStage(
        workDispatchRecordAttemptCommand.stage,
        {
          intentId: 'op_1#0',
          claimId: 'claim_1',
          outcome: { state: 'flying' },
          ack: false,
        },
        ctx,
      ),
      /must be pending, delivered/,
    );
  });
});

describe('kernel commands: dispatch.requeue', () => {
  it('returns ready uncertain/failed rows to pending with cleared outcome', async () => {
    const uncertain = dispatchRow('op_1#0', {
      state: 'uncertain',
      attempts: 1,
      firstAttemptAtMs: NOW - 500,
      errorCode: 'provider_transient',
      errorMessage: 'boom',
      availableAtMs: NOW - 1,
    });
    const failed = dispatchRow('op_1#1', {
      state: 'failed',
      attempts: 2,
      firstAttemptAtMs: NOW - 500,
      retryClass: 'transient',
      deliveryId: null,
      errorCode: 'provider_rejected',
      errorMessage: 'no',
      availableAtMs: null,
    });
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row: uncertain },
        { model: WORK_DISPATCH_MODEL, row: failed },
      ]),
    );
    for (const intentId of ['op_1#0', 'op_1#1']) {
      const staged = await workDispatchRequeueCommand.stage(
        { intentId, maxAttempts: 8, horizonMs: 3_600_000, notFound: true },
        ctx,
      );
      assert.deepEqual(staged.result, {
        requeued: true,
        dead: false,
        intentId,
        attempts: intentId === 'op_1#0' ? 1 : 2,
      });
      const write = staged.writes?.[0];
      assert.equal(write?.kind, 'update');
      if (write?.kind === 'update') {
        const data = readDispatchRow(write.row);
        assert.equal(data.state, 'pending');
        assert.equal(data.deliveryId, null);
        assert.equal(data.errorCode, null);
        assert.equal(data.errorMessage, null);
        assert.equal(data.availableAtMs, null);
        assert.equal(data.retryClass, null);
        // Horizon anchor survives across attempts.
        assert.equal(data.firstAttemptAtMs, NOW - 500);
      }
    }
  });

  it('refuses terminal failures and evidence-less uncertain rows', async () => {
    const terminal = dispatchRow('op_1#0', {
      state: 'failed',
      attempts: 1,
      firstAttemptAtMs: NOW - 500,
      retryClass: 'terminal',
      errorCode: 'require-false',
      availableAtMs: null,
    });
    const unclassified = dispatchRow('op_1#1', {
      state: 'failed',
      attempts: 1,
      firstAttemptAtMs: NOW - 500,
      errorCode: 'boom',
      availableAtMs: null,
    });
    const unknown = dispatchRow('op_1#2', {
      state: 'uncertain',
      attempts: 1,
      firstAttemptAtMs: NOW - 500,
      availableAtMs: null,
    });
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row: terminal },
        { model: WORK_DISPATCH_MODEL, row: unclassified },
        { model: WORK_DISPATCH_MODEL, row: unknown },
      ]),
    );
    for (const intentId of ['op_1#0', 'op_1#1']) {
      const refused = await workDispatchRequeueCommand.stage(
        { intentId, maxAttempts: 8, horizonMs: 3_600_000 },
        ctx,
      );
      assert.deepEqual(refused.result, {
        requeued: false,
        dead: false,
        intentId,
        reason: 'terminal',
        state: 'failed',
      });
      assert.equal(refused.writes, undefined);
    }
    const needsEvidence = await workDispatchRequeueCommand.stage(
      { intentId: 'op_1#2', maxAttempts: 8, horizonMs: 3_600_000 },
      ctx,
    );
    assert.deepEqual(needsEvidence.result, {
      requeued: false,
      dead: false,
      intentId: 'op_1#2',
      reason: 'needs-evidence',
    });
    assert.equal(needsEvidence.writes, undefined);
  });

  it('holds deferred rows and dead-letters exhausted ones', async () => {
    const deferred = dispatchRow('op_1#0', {
      state: 'uncertain',
      attempts: 1,
      firstAttemptAtMs: NOW - 500,
      availableAtMs: NOW + 60_000,
    });
    const capped = dispatchRow('op_1#1', {
      state: 'failed',
      attempts: 8,
      firstAttemptAtMs: NOW - 500,
      retryClass: 'transient',
    });
    const timedOut = dispatchRow('op_1#2', {
      state: 'uncertain',
      attempts: 2,
      firstAttemptAtMs: NOW - 3_600_000,
    });
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row: deferred },
        { model: WORK_DISPATCH_MODEL, row: capped },
        { model: WORK_DISPATCH_MODEL, row: timedOut },
      ]),
    );
    const held = await workDispatchRequeueCommand.stage(
      { intentId: 'op_1#0', maxAttempts: 8, horizonMs: 3_600_000, notFound: true },
      ctx,
    );
    assert.deepEqual(held.result, {
      requeued: false,
      dead: false,
      intentId: 'op_1#0',
      reason: 'deferred',
      availableAtMs: NOW + 60_000,
    });
    assert.equal(held.writes, undefined);
    for (const intentId of ['op_1#1', 'op_1#2']) {
      const dead = await workDispatchRequeueCommand.stage(
        { intentId, maxAttempts: 8, horizonMs: 3_600_000, notFound: true },
        ctx,
      );
      assert.deepEqual(dead.result, {
        requeued: false,
        dead: true,
        intentId,
        attempts: intentId === 'op_1#1' ? 8 : 2,
      });
      const write = dead.writes?.[0];
      assert.equal(write?.kind, 'update');
      if (write?.kind === 'update') {
        const data = readDispatchRow(write.row);
        assert.equal(data.state, 'dead');
        // Dead-lettering keeps the last classification as provenance.
        assert.equal(data.retryClass, intentId === 'op_1#1' ? 'transient' : null);
      }
    }
  });

  it('refuses non-retryable rows and validates the budget', async () => {
    const pending = dispatchRow('op_1#0');
    const ctx = fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row: pending }]));
    const refused = await workDispatchRequeueCommand.stage(
      { intentId: 'op_1#0', maxAttempts: 8, horizonMs: 3_600_000 },
      ctx,
    );
    assert.deepEqual(refused.result, {
      requeued: false,
      dead: false,
      intentId: 'op_1#0',
      reason: 'not-retryable',
      state: 'pending',
    });
    await assert.rejects(
      runStage(
        workDispatchRequeueCommand.stage,
        { intentId: 'op_1#0', maxAttempts: 0, horizonMs: 1000 },
        ctx,
      ),
      /maxAttempts must be an integer >= 1/,
    );
    await assert.rejects(
      runStage(
        workDispatchRequeueCommand.stage,
        { intentId: 'ghost', maxAttempts: 8, horizonMs: 1000 },
        ctx,
      ),
      KernelTableError,
    );
  });
});

describe('kernel commands: dispatch.release', () => {
  it('releases stale claims and keeps fresh or absent ones', async () => {
    const stale = dispatchRow('op_1#0', {
      state: 'claimed',
      claimId: 'old',
      claimedAtMs: NOW - MAX_AGE - 1,
    });
    const fresh = dispatchRow('op_1#1', {
      state: 'claimed',
      claimId: 'live',
      claimedAtMs: NOW,
    });
    const bare = dispatchRow('op_1#2', { state: 'claimed' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row: stale },
        { model: WORK_DISPATCH_MODEL, row: fresh },
        { model: WORK_DISPATCH_MODEL, row: bare },
      ]),
    );
    const released = await workDispatchReleaseCommand.stage(
      { intentId: 'op_1#0', maxClaimAgeMs: MAX_AGE },
      ctx,
    );
    assert.deepEqual(released.result, { released: true, intentId: 'op_1#0' });
    assert.equal(released.writes?.length, 1);
    const kept = await workDispatchReleaseCommand.stage(
      { intentId: 'op_1#1', maxClaimAgeMs: MAX_AGE },
      ctx,
    );
    assert.deepEqual(kept.result, {
      released: false,
      intentId: 'op_1#1',
      reason: 'claim-fresh',
    });
    assert.equal(kept.writes, undefined);
    // No recorded claim: a live dispatcher may hold it.
    const unclaimed = await workDispatchReleaseCommand.stage(
      { intentId: 'op_1#2', maxClaimAgeMs: MAX_AGE },
      ctx,
    );
    assert.deepEqual(unclaimed.result, {
      released: false,
      intentId: 'op_1#2',
      reason: 'claim-fresh',
    });
  });
});

describe('kernel commands: dispatch.supersede', () => {
  it('marks pending origin intents, skipping others and existing marks', async () => {
    const pendingA = dispatchRow('op_1#a', { originOccurrence: 'occ_9' });
    const pendingB = dispatchRow('op_1#b', { originOccurrence: 'occ_9' });
    const claimed = dispatchRow('op_1#c', {
      originOccurrence: 'occ_9',
      state: 'claimed',
      claimId: 'live',
      claimedAtMs: NOW,
    });
    const foreign = dispatchRow('op_2#a', { originOccurrence: 'occ_other' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row: pendingA },
        { model: WORK_DISPATCH_MODEL, row: pendingB },
        { model: WORK_DISPATCH_MODEL, row: claimed },
        { model: WORK_DISPATCH_MODEL, row: foreign },
        {
          model: WORK_SUPERSESSION_MODEL,
          row: newSupersessionRow(
            { outboxId: 'op_1#b', byOccurrenceId: 'occ_8', markedAtMs: NOW - 1 },
            { nowMs: NOW, actor: ACTOR },
          ),
        },
      ]),
    );
    const staged = await workDispatchSupersedeCommand.stage(
      { originOccurrence: 'occ_9', byOccurrenceId: 'occ_10' },
      ctx,
    );
    // Only op_1#a: op_1#b already marked, op_1#c claimed, op_2#a foreign.
    assert.deepEqual(staged.result, { superseded: ['op_1#a'] });
    assert.equal(staged.writes?.length, 1);
    const write = staged.writes?.[0];
    assert.equal(write?.kind, 'insert');
    if (write?.kind === 'insert') {
      assert.equal(write.model, WORK_SUPERSESSION_MODEL);
      assert.deepEqual(write.row.data, {
        outboxId: 'op_1#a',
        byOccurrenceId: 'occ_10',
        markedAtMs: NOW,
      });
    }
  });
});

describe('kernel commands: occurrence.put-receipt', () => {
  it('inserts receipts once and replays duplicates', async () => {
    const ctx = fakeCtx(seed([]));
    const first = await workOccurrencePutReceiptCommand.stage(
      {
        occurrenceId: 'occ_1',
        status: 'completed',
        result: { ok: true },
        code: null,
        message: null,
      },
      ctx,
    );
    assert.deepEqual(first.result, { duplicate: false, occurrenceId: 'occ_1' });
    assert.equal(first.writes?.length, 1);
    const write = first.writes?.[0];
    assert.equal(write?.kind, 'insert');
    if (write?.kind !== 'insert') throw new Error('unreachable');
    // Second run sees the winner's receipt.
    const replay = fakeCtx(
      seed([{ model: WORK_OCCURRENCE_MODEL, row: write.row }]),
    );
    const second = await workOccurrencePutReceiptCommand.stage(
      {
        occurrenceId: 'occ_1',
        status: 'failed',
        result: null,
        code: 'x',
        message: 'late',
      },
      replay,
    );
    assert.equal(second.writes, undefined);
    assert.deepEqual(second.result, {
      duplicate: true,
      receipt: {
        occurrenceId: 'occ_1',
        status: 'completed',
        result: { ok: true },
        code: null,
        message: null,
        recordedAtMs: NOW,
      },
    });
  });

  it('rejects bad statuses', async () => {
    const ctx = fakeCtx(seed([]));
    await assert.rejects(
      runStage(
        workOccurrencePutReceiptCommand.stage,
        { occurrenceId: 'occ_1', status: 'maybe' },
        ctx,
      ),
      /must be completed or failed/,
    );
  });
});

const SCOPE = { app: 'CanExpense', owner: 'team_1', ownerPackage: 'expense' };

function scheduleRow(
  occurrenceId: string,
  over: Record<string, unknown> = {},
): StoredRow {
  return newScheduleRow(
    {
      occurrenceId,
      key: 'reminder',
      scopeApp: SCOPE.app,
      scopeOwner: SCOPE.owner,
      scopeOwnerPackage: SCOPE.ownerPackage,
      at: NOW + 1000,
      event: 'expense.remind',
      payload: {},
      replaces: null,
      state: 'pending',
      ...over,
    },
    { nowMs: NOW, actor: ACTOR },
  );
}

describe('kernel commands: schedule.put', () => {
  it('inserts with the L3 replace op when the key is fresh', async () => {
    const ctx = fakeCtx(seed([]));
    const staged = await workSchedulePutCommand.stage(
      {
        key: 'reminder',
        scope: SCOPE,
        at: NOW + 1000,
        event: 'expense.remind',
        payload: { n: 1 },
        occurrenceId: 'occ_1',
      },
      ctx,
    );
    assert.deepEqual(staged.result, {
      admitted: 'occ_1',
      supersededId: null,
      supersededIds: [],
      affectedOutboxIds: [],
    });
    assert.equal(staged.writes?.length, 1);
    assert.deepEqual(staged.schedules, [
      {
        op: 'replace',
        key: 'reminder',
        at: NOW + 1000,
        event: 'expense.remind',
        payload: { n: 1 },
      },
    ]);
  });

  it('replaces pending predecessors with lineage and intent marks', async () => {
    const previous = scheduleRow('occ_1');
    const intent = dispatchRow('op_1#0', { originOccurrence: 'occ_1' });
    const decoy = scheduleRow('occ_9', { key: 'other-key' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_SCHEDULE_MODEL, row: previous },
        { model: WORK_SCHEDULE_MODEL, row: decoy },
        { model: WORK_DISPATCH_MODEL, row: intent },
      ]),
    );
    const staged = await workSchedulePutCommand.stage(
      {
        key: 'reminder',
        scope: SCOPE,
        at: NOW + 2000,
        event: 'expense.remind',
        payload: {},
        occurrenceId: 'occ_2',
      },
      ctx,
    );
    assert.deepEqual(staged.result, {
      admitted: 'occ_2',
      supersededId: 'occ_1',
      supersededIds: ['occ_1'],
      affectedOutboxIds: ['op_1#0'],
    });
    // Supersede update + lineage insert + supersession mark.
    assert.equal(staged.writes?.length, 3);
    const kinds = staged.writes?.map((write) => write.kind);
    assert.deepEqual(kinds, ['update', 'insert', 'insert']);
  });

  it('follows replaces linkage past lexicographic order', async () => {
    const old = scheduleRow('occ_9', { state: 'superseded' });
    const head = scheduleRow('occ_10', { replaces: 'occ_9' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_SCHEDULE_MODEL, row: old },
        { model: WORK_SCHEDULE_MODEL, row: head },
      ]),
    );
    const staged = await workSchedulePutCommand.stage(
      {
        key: 'reminder',
        scope: SCOPE,
        at: NOW + 2000,
        event: 'expense.remind',
        payload: {},
        occurrenceId: 'occ_11',
      },
      ctx,
    );
    assert.deepEqual(staged.result, {
      admitted: 'occ_11',
      supersededId: 'occ_10',
      supersededIds: ['occ_10'],
      affectedOutboxIds: [],
    });
  });

  it('converges racing twin heads on the next put', async () => {
    const old = scheduleRow('occ_9', { state: 'superseded' });
    const twinA = scheduleRow('occ_10', { replaces: 'occ_9' });
    const twinB = scheduleRow('occ_11', { replaces: 'occ_9' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_SCHEDULE_MODEL, row: old },
        { model: WORK_SCHEDULE_MODEL, row: twinA },
        { model: WORK_SCHEDULE_MODEL, row: twinB },
      ]),
    );
    const staged = await workSchedulePutCommand.stage(
      {
        key: 'reminder',
        scope: SCOPE,
        at: NOW + 2000,
        event: 'expense.remind',
        payload: {},
        occurrenceId: 'occ_12',
      },
      ctx,
    );
    assert.deepEqual(staged.result, {
      admitted: 'occ_12',
      supersededId: 'occ_11',
      supersededIds: ['occ_11', 'occ_10'],
      affectedOutboxIds: [],
    });
    // Two supersede updates + the lineage insert.
    assert.equal(staged.writes?.length, 3);
  });

  it('leaves non-pending predecessors to complete and rejects bad payloads', async () => {
    const admitted = scheduleRow('occ_1', { state: 'admitted' });
    const ctx = fakeCtx(seed([{ model: WORK_SCHEDULE_MODEL, row: admitted }]));
    const staged = await workSchedulePutCommand.stage(
      {
        key: 'reminder',
        scope: SCOPE,
        at: NOW + 2000,
        event: 'expense.remind',
        payload: {},
        occurrenceId: 'occ_2',
      },
      ctx,
    );
    assert.deepEqual(staged.result, {
      admitted: 'occ_2',
      supersededId: null,
      supersededIds: [],
      affectedOutboxIds: [],
    });
    assert.equal(staged.writes?.length, 1);
    await assert.rejects(
      runStage(
        workSchedulePutCommand.stage,
        {
          key: 'reminder',
          scope: SCOPE,
          at: NOW,
          event: 'e',
          payload: [1],
          occurrenceId: 'occ_9',
        },
        ctx,
      ),
      /payload must be an object/,
    );
  });
});

describe('kernel commands: schedule.cancel', () => {
  it('cancels pending entries with marks and the L3 cancel op', async () => {
    const previous = scheduleRow('occ_1');
    const intent = dispatchRow('op_1#0', { originOccurrence: 'occ_1' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_SCHEDULE_MODEL, row: previous },
        { model: WORK_DISPATCH_MODEL, row: intent },
      ]),
    );
    const staged = await workScheduleCancelCommand.stage(
      { key: 'reminder', scope: SCOPE },
      ctx,
    );
    assert.deepEqual(staged.result, {
      cancelled: 'occ_1',
      cancelledIds: ['occ_1'],
      affectedOutboxIds: ['op_1#0'],
    });
    assert.equal(staged.writes?.length, 2);
    assert.deepEqual(staged.schedules, [{ op: 'cancel', key: 'reminder' }]);
  });

  it('cancels the linked head past lexicographic order', async () => {
    const old = scheduleRow('occ_9', { state: 'superseded' });
    const head = scheduleRow('occ_10', { replaces: 'occ_9' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_SCHEDULE_MODEL, row: old },
        { model: WORK_SCHEDULE_MODEL, row: head },
      ]),
    );
    const staged = await workScheduleCancelCommand.stage(
      { key: 'reminder', scope: SCOPE },
      ctx,
    );
    assert.deepEqual(staged.result, {
      cancelled: 'occ_10',
      cancelledIds: ['occ_10'],
      affectedOutboxIds: [],
    });
  });

  it('cancels every live head on a raced key', async () => {
    const old = scheduleRow('occ_9', { state: 'superseded' });
    const twinA = scheduleRow('occ_10', { replaces: 'occ_9' });
    const twinB = scheduleRow('occ_11', { replaces: 'occ_9' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_SCHEDULE_MODEL, row: old },
        { model: WORK_SCHEDULE_MODEL, row: twinA },
        { model: WORK_SCHEDULE_MODEL, row: twinB },
      ]),
    );
    const staged = await workScheduleCancelCommand.stage(
      { key: 'reminder', scope: SCOPE },
      ctx,
    );
    assert.deepEqual(staged.result, {
      cancelled: 'occ_11',
      cancelledIds: ['occ_11', 'occ_10'],
      affectedOutboxIds: [],
    });
    assert.equal(staged.writes?.length, 2);
  });

  it('no-ops on missing and terminal keys', async () => {
    const missing = fakeCtx(seed([]));
    assert.deepEqual(
      (
        await workScheduleCancelCommand.stage(
          { key: 'ghost', scope: SCOPE },
          missing,
        )
      ).result,
      { cancelled: null, cancelledIds: [], affectedOutboxIds: [] },
    );
    const terminal = fakeCtx(
      seed([
        {
          model: WORK_SCHEDULE_MODEL,
          row: scheduleRow('occ_1', { state: 'cancelled' }),
        },
      ]),
    );
    const staged = await workScheduleCancelCommand.stage(
      { key: 'reminder', scope: SCOPE },
      terminal,
    );
    assert.deepEqual(staged.result, {
      cancelled: 'occ_1',
      cancelledIds: [],
      affectedOutboxIds: [],
    });
    assert.equal(staged.writes, undefined);
    assert.equal(staged.schedules, undefined);
  });
});

describe('kernel commands: every.advance-slot', () => {
  it('initializes, advances and holds slots', async () => {
    const empty = fakeCtx(seed([]));
    const first = await workEveryAdvanceSlotCommand.stage(
      {
        app: 'CanTasks',
        handler: 'TeamTasks.tick',
        scope: 'team',
        owner: 'team_1',
        slot: 42,
      },
      empty,
    );
    assert.deepEqual(first.result, {
      advanced: true,
      previous: null,
      slot: 42,
    });
    assert.equal(first.writes?.length, 1);
    const tracker = newEverySlotRow(
      {
        scopeKey: 'team:team_1',
        app: 'CanTasks',
        handler: 'TeamTasks.tick',
        scope: 'team',
        owner: 'team_1',
        slot: 42,
      },
      { nowMs: NOW, actor: ACTOR },
    );
    const ctx = fakeCtx(seed([{ model: WORK_EVERY_SLOT_MODEL, row: tracker }]));
    const held = await workEveryAdvanceSlotCommand.stage(
      {
        app: 'CanTasks',
        handler: 'TeamTasks.tick',
        scope: 'team',
        owner: 'team_1',
        slot: 42,
      },
      ctx,
    );
    assert.deepEqual(held.result, {
      advanced: false,
      previous: 42,
      slot: 42,
    });
    assert.equal(held.writes, undefined);
    const advanced = await workEveryAdvanceSlotCommand.stage(
      {
        app: 'CanTasks',
        handler: 'TeamTasks.tick',
        scope: 'team',
        owner: 'team_1',
        slot: 43,
      },
      ctx,
    );
    assert.deepEqual(advanced.result, {
      advanced: true,
      previous: 42,
      slot: 43,
    });
    assert.equal(advanced.writes?.length, 1);
  });

  it('tracks slots independently per app and handler', async () => {
    const empty = fakeCtx(seed([]));
    const first = await workEveryAdvanceSlotCommand.stage(
      {
        app: 'CanTasks',
        handler: 'A.tick',
        scope: 'team',
        owner: 'team_1',
        slot: 42,
      },
      empty,
    );
    const write = first.writes?.[0];
    assert.equal(write?.kind, 'insert');
    if (write?.kind !== 'insert') {
      assert.fail('expected the initializing advance to stage an insert');
    }
    const ctx = fakeCtx(seed([{ model: WORK_EVERY_SLOT_MODEL, row: write.row }]));
    const second = await workEveryAdvanceSlotCommand.stage(
      {
        app: 'CanTasks',
        handler: 'B.tick',
        scope: 'team',
        owner: 'team_1',
        slot: 42,
      },
      ctx,
    );
    assert.deepEqual(second.result, {
      advanced: true,
      previous: null,
      slot: 42,
    });
  });

  it('rejects root scopes exactly like admission', async () => {
    const ctx = fakeCtx(seed([]));
    await assert.rejects(
      runStage(
        workEveryAdvanceSlotCommand.stage,
        {
          app: 'CanTasks',
          handler: 'TeamTasks.tick',
          scope: 'root',
          owner: 'app',
          slot: 1,
        },
        ctx,
      ),
      RootRecurrenceNotSupportedError,
    );
  });
});
