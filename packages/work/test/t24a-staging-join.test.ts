/**
 * T24a staging join (engine side): generated effects plan into staged
 * dispatch intents plus recorded skips; the fenced stage/recover
 * commands join dispatch rows with outbox intents atomically; recovery
 * scans resume interrupted claims. Memory-store registry runs below are
 * MEMORY-ONLY proofs (no persist channel); the D1/DO durable proofs
 * live state-side in `t24a-dispatch-join.test.ts` /
 * `t24a-dispatch-join-durable.test.ts`. The registry section imports the
 * COMPILED `@canlang/state` dist (work sources load under node type
 * stripping, which cannot resolve state's `.js`-suffixed source
 * imports): run the state build first (the root `pretest` does).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ClaimId,
  DispatchClaim,
  OutboxId,
  OutboxItem,
  RetryPolicy,
} from '../../contracts/src/work.js';
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
import { createSystemRegistry } from '../../state/dist/state/src/ports/system.js';
import { createTestMemoryStorage } from '../../state/dist/state/src/storage/memory.js';
import { DISPATCH_JOIN_MODEL } from '../../state/dist/state/src/ports/transact.js';
import {
  WORK_DISPATCH_MODEL,
  newDispatchRow,
  readDispatchRow,
} from '../src/kernel/tables.ts';
import { KernelTableError } from '../src/kernel/tables.ts';
import {
  WORK_DISPATCH_STAGE_COMMANDS,
  WORK_SYSTEM_COMMANDS,
  workDispatchClaimCommand,
  workDispatchRecoverCommand,
  workDispatchStageCommand,
} from '../src/kernel/commands.ts';
import {
  lifecycleOf,
  isTerminalLifecycle,
  originOfIntent,
  planDispatchStaging,
  stageOutboxIntent,
} from '../src/intent/index.ts';
import type { GeneratedEffect } from '../src/intent/index.ts';
import { matchClaimIdentity } from '../src/dispatch/index.ts';
import type { GuardEvaluator } from '../src/dispatch/index.ts';
import {
  isClaimStale,
  planRecoveryScan,
  recordStagingFailure,
} from '../src/recovery/index.ts';
import type { RecoverableRow } from '../src/recovery/index.ts';
import { recordOutcome } from '../src/receipt/index.ts';
import type { FailureCause, ReconcileEvidence } from '../src/receipt/index.ts';

const NOW = 1_758_000_000_000;
const ACTOR = 't24a-test';
const MAX_AGE = 60_000;
const POLICY: RetryPolicy = { maxAttempts: 3, horizonMs: 3_600_000 };

/* -- Hand-faked readers-only stage contexts (kernel-commands pattern). -- */

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
    operation: 'test.t24a',
    load: async (model: ModelName, id: RecordId) =>
      store.get(`${model}\0${id}`) ?? null,
    // Deliberately unfiltered: stages must re-filter exactly.
    query: async (spec: QuerySpec) =>
      [...store.entries()]
        .filter(([key]) => key.startsWith(`${spec.model}\0`))
        .map(([, row]) => row),
  };
}

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
      operationId: 'op_trigger',
      source: 'std.EmailV1.send',
      occurrenceIndex: 0,
      originOccurrence: null,
    },
    { nowMs: NOW, actor: ACTOR },
  );
  return { ...base, data: { ...readDispatchRow(base), ...over } };
}

function outboxItem(
  id: string,
  over: Partial<OutboxItem> = {},
): OutboxItem {
  return {
    id,
    operationId: 'op_trigger',
    source: 'std.EmailV1.send',
    occurrenceIndex: 0,
    request: { to: 'a@example.com' },
    originOccurrence: null,
    attempts: 0,
    state: 'pending',
    ...over,
  };
}

function effect(over: Partial<GeneratedEffect> = {}): GeneratedEffect {
  return {
    operationId: 'op_trigger',
    source: 'std.EmailV1.send',
    occurrenceIndex: 0,
    request: { to: 'a@example.com' },
    originOccurrence: null,
    guard: null,
    ...over,
  };
}

const guardTrue: GuardEvaluator = () => true;
const guardFalse: GuardEvaluator = () => false;

describe('t24a planDispatchStaging: origins, guards, skips', () => {
  it('stages unconditional and guard-true effects with their origins', () => {
    const plan = planDispatchStaging(
      { evaluateGuard: guardTrue },
      {
        stateSnapshot: { eligible: true },
        effects: [
          effect({ occurrenceIndex: 0 }),
          effect({ occurrenceIndex: 1, guard: 'eligible()', frozenInputs: { n: 1 } }),
        ],
      },
    );
    assert.equal(plan.staged.length, 2);
    assert.deepEqual(plan.skipped, []);
    for (const staged of plan.staged) {
      assert.equal(staged.commit, null);
      assert.equal(staged.item.state, 'pending');
      assert.equal(staged.item.attempts, 0);
    }
    assert.deepEqual(originOfIntent(plan.staged[0]!), {
      operationId: 'op_trigger',
      source: 'std.EmailV1.send',
      occurrenceIndex: 0,
      originOccurrence: null,
    });
    assert.deepEqual(originOfIntent(plan.staged[1]!), {
      operationId: 'op_trigger',
      source: 'std.EmailV1.send',
      occurrenceIndex: 1,
      originOccurrence: null,
    });
    // Distinct deterministic ids per occurrence index.
    assert.notEqual(plan.staged[0]!.item.id, plan.staged[1]!.item.id);
  });

  it('records guard-false effects as skips, never silent', () => {
    const plan = planDispatchStaging(
      { evaluateGuard: guardFalse },
      {
        stateSnapshot: { eligible: false },
        effects: [
          effect({ occurrenceIndex: 0 }),
          effect({ occurrenceIndex: 1, guard: 'eligible()' }),
          effect({ occurrenceIndex: 2, guard: 'eligible()' }),
        ],
      },
    );
    assert.equal(plan.staged.length, 1);
    assert.equal(plan.skipped.length, 2);
    for (const skip of plan.skipped) {
      assert.equal(skip.verdict, false);
      assert.equal(skip.reason, 'guard-false');
      assert.equal(skip.guard, 'eligible()');
      assert.equal(skip.fanout, null);
    }
    assert.deepEqual(plan.skipped[0]!.origin, {
      operationId: 'op_trigger',
      source: 'std.EmailV1.send',
      occurrenceIndex: 1,
      originOccurrence: null,
    });
    // Every input effect lands in exactly one list.
    const covered = plan.staged.length + plan.skipped.length;
    assert.equal(covered, 3);
  });

  it('fails the whole batch closed on duplicates, bad requests and evaluator throws', () => {
    assert.throws(
      () =>
        planDispatchStaging(
          { evaluateGuard: guardTrue },
          { stateSnapshot: null, effects: [effect(), effect()] },
        ),
      /duplicate staged outbox id/,
    );
    assert.throws(
      () =>
        planDispatchStaging(
          { evaluateGuard: guardTrue },
          { stateSnapshot: null, effects: [effect({ request: ['not-a-record'] })] },
        ),
      /plain JSON record/,
    );
    assert.throws(
      () =>
        planDispatchStaging(
          {
            evaluateGuard: () => {
              throw new Error('unknown predicate');
            },
          },
          { stateSnapshot: null, effects: [effect({ guard: 'nope()' })] },
        ),
      /unknown predicate/,
    );
    assert.throws(
      () =>
        planDispatchStaging(
          { evaluateGuard: guardTrue },
          { stateSnapshot: null, effects: [effect({ guard: '' })] },
        ),
      /non-empty string or null/,
    );
  });

  it('carries fanout lineage through staged and skipped with no fanout rule', () => {
    const fanoutA = {
      cohortId: 'cohort-1',
      parentOccurrence: 'occ_parent',
      childIndex: 0,
      checkpointId: null,
    };
    const fanoutB = { ...fanoutA, childIndex: 1 };
    const plan = planDispatchStaging(
      { evaluateGuard: (predicate) => predicate === 'keep()' },
      {
        stateSnapshot: null,
        effects: [
          effect({ occurrenceIndex: 0, guard: 'keep()', fanout: fanoutA }),
          effect({ occurrenceIndex: 1, guard: 'drop()', fanout: fanoutB }),
        ],
      },
    );
    // Same cohort, independent outcomes: no cohort rule adopted.
    assert.equal(plan.staged.length, 1);
    assert.equal(plan.skipped.length, 1);
    assert.deepEqual(plan.skipped[0]!.fanout, fanoutB);
    assert.throws(
      () =>
        planDispatchStaging(
          { evaluateGuard: guardTrue },
          {
            stateSnapshot: null,
            effects: [effect({ fanout: { ...fanoutA, cohortId: '' } })],
          },
        ),
      /fanout\.cohortId/,
    );
  });
});

describe('t24a intent lifecycle', () => {
  it('maps persisted state plus pinned verdict onto staged/claimed/done/failed/skipped', () => {
    assert.equal(lifecycleOf(outboxItem('a'), null), 'staged');
    assert.equal(lifecycleOf(outboxItem('a'), true), 'staged');
    assert.equal(lifecycleOf(outboxItem('a'), false), 'skipped');
    assert.equal(lifecycleOf(outboxItem('a', { state: 'claimed' }), null), 'claimed');
    // Uncertain is still in flight awaiting evidence, neither done nor failed.
    assert.equal(lifecycleOf(outboxItem('a', { state: 'uncertain' }), null), 'claimed');
    assert.equal(lifecycleOf(outboxItem('a', { state: 'delivered' }), null), 'done');
    assert.equal(lifecycleOf(outboxItem('a', { state: 'failed' }), null), 'failed');
    assert.equal(lifecycleOf(outboxItem('a', { state: 'dead' }), null), 'failed');
    assert.equal(isTerminalLifecycle('done'), true);
    assert.equal(isTerminalLifecycle('failed'), true);
    assert.equal(isTerminalLifecycle('skipped'), true);
    assert.equal(isTerminalLifecycle('staged'), false);
    assert.equal(isTerminalLifecycle('claimed'), false);
  });
});

describe('t24a claim identity', () => {
  const held: DispatchClaim = { outboxId: 'obx_1', claimId: 'claim_1', claimedAt: NOW };

  it('matches the winning claim id for idempotent replay, refuses others', () => {
    assert.equal(matchClaimIdentity(null, 'claim_9' as ClaimId), 'unclaimed');
    assert.equal(matchClaimIdentity(held, 'claim_1' as ClaimId), 'held-by-caller');
    assert.equal(matchClaimIdentity(held, 'claim_2' as ClaimId), 'held-elsewhere');
  });
});

describe('t24a recordStagingFailure: retryable-vs-terminal dispositions', () => {
  const transient: FailureCause = { kind: 'transient', code: 'e-conn', message: 'reset' };
  const permanent: FailureCause = { kind: 'permanent', code: 'e-400', message: 'bad' };
  const requireFalse: FailureCause = { kind: 'handler-require-false', require: 'eligible()' };

  it('retries transient failures within budget, dead-letters past it', () => {
    const retry = recordStagingFailure({
      item: outboxItem('a', { state: 'claimed', attempts: 0 }),
      cause: transient,
      nowMs: NOW,
      firstAttemptAtMs: NOW - 1000,
      policy: POLICY,
    });
    assert.deepEqual(
      [retry.disposition, retry.item.state, retry.retryClass, retry.retryable],
      ['retry', 'pending', 'transient', true],
    );
    assert.equal(retry.item.attempts, 1);
    const attemptCap = recordStagingFailure({
      item: outboxItem('a', { state: 'claimed', attempts: 2 }),
      cause: transient,
      nowMs: NOW,
      firstAttemptAtMs: NOW - 1000,
      policy: POLICY,
    });
    assert.deepEqual(
      [attemptCap.disposition, attemptCap.item.state, attemptCap.retryable],
      ['dead', 'dead', false],
    );
    const horizon = recordStagingFailure({
      item: outboxItem('a', { state: 'claimed', attempts: 0 }),
      cause: transient,
      nowMs: NOW,
      firstAttemptAtMs: NOW - POLICY.horizonMs,
      policy: POLICY,
    });
    assert.deepEqual([horizon.disposition, horizon.item.state], ['dead', 'dead']);
  });

  it('finalizes terminal failures and rejects settled items', () => {
    for (const cause of [permanent, requireFalse]) {
      const recorded = recordStagingFailure({
        item: outboxItem('a', { state: 'claimed', attempts: 0 }),
        cause,
        nowMs: NOW,
        firstAttemptAtMs: NOW,
        policy: POLICY,
      });
      assert.deepEqual(
        [recorded.disposition, recorded.item.state, recorded.retryClass, recorded.retryable],
        ['terminal', 'failed', 'terminal', false],
      );
    }
    assert.throws(
      () =>
        recordStagingFailure({
          item: outboxItem('a', { state: 'delivered' }),
          cause: transient,
          nowMs: NOW,
          firstAttemptAtMs: NOW,
        }),
      /pending\/claimed items only/,
    );
  });

  it('matches recordOutcome exactly on shared failure inputs', () => {
    const cases: Array<{ item: OutboxItem; cause: FailureCause; nowMs: number; first: number }> = [
      { item: outboxItem('a', { state: 'claimed', attempts: 1 }), cause: transient, nowMs: NOW, first: NOW - 500 },
      { item: outboxItem('a', { state: 'claimed', attempts: 7 }), cause: transient, nowMs: NOW, first: NOW - 500 },
      { item: outboxItem('a', { state: 'pending', attempts: 0 }), cause: permanent, nowMs: NOW, first: NOW },
      { item: outboxItem('a', { state: 'claimed', attempts: 0 }), cause: requireFalse, nowMs: NOW, first: NOW },
    ];
    for (const input of cases) {
      const staged = recordStagingFailure({
        item: input.item,
        cause: input.cause,
        nowMs: input.nowMs,
        firstAttemptAtMs: input.first,
      });
      const receipted = recordOutcome({
        item: input.item,
        outcome: { kind: 'failed', cause: input.cause },
        nowMs: input.nowMs,
        firstAttemptAtMs: input.first,
      });
      assert.equal(staged.item.state, receipted.item.state);
      assert.equal(staged.item.attempts, receipted.item.attempts);
      assert.equal(staged.retryClass, receipted.retryClass);
      assert.equal(staged.retryable, receipted.retryable);
    }
  });
});

describe('t24a planRecoveryScan: resuming interrupted claims', () => {
  const stale: DispatchClaim = { outboxId: 'obx_stale', claimId: 'claim_old', claimedAt: NOW - MAX_AGE };
  const fresh: DispatchClaim = { outboxId: 'obx_fresh', claimId: 'claim_new', claimedAt: NOW };

  function view(item: OutboxItem, over: Partial<RecoverableRow> = {}): RecoverableRow {
    return { item, guardVerdict: null, firstAttemptAtMs: null, retryClass: null, ...over };
  }

  it('sorts every actionable row into exactly one list, id-sorted', () => {
    const evidence = (id: OutboxId): ReconcileEvidence | null => {
      if (id === 'obx_unf') return { kind: 'not-found' };
      if (id === 'obx_und') return { kind: 'delivered', result: { ok: true } };
      return null;
    };
    const plan = planRecoveryScan({
      rows: [
        view(outboxItem('obx_stale', { state: 'claimed' })),
        view(outboxItem('obx_fresh', { state: 'claimed' })),
        view(outboxItem('obx_held', { state: 'claimed' })),
        view(outboxItem('obx_skip', { state: 'pending' }), { guardVerdict: false }),
        view(outboxItem('obx_plain', { state: 'pending' })),
        view(outboxItem('obx_retry', { state: 'failed', attempts: 1 }), {
          retryClass: 'transient',
          firstAttemptAtMs: NOW - 1000,
        }),
        view(outboxItem('obx_dead', { state: 'failed', attempts: 3 }), {
          retryClass: 'transient',
          firstAttemptAtMs: NOW - 1000,
        }),
        view(outboxItem('obx_term', { state: 'failed', attempts: 1 }), { retryClass: 'terminal' }),
        view(outboxItem('obx_unclass', { state: 'failed', attempts: 1 })),
        view(outboxItem('obx_unf', { state: 'uncertain', attempts: 1 })),
        view(outboxItem('obx_und', { state: 'uncertain', attempts: 1 })),
        view(outboxItem('obx_unk', { state: 'uncertain', attempts: 1 })),
        view(outboxItem('obx_done', { state: 'delivered', attempts: 1 })),
        view(outboxItem('obx_gone', { state: 'dead', attempts: 3 })),
      ],
      claims: [stale, fresh],
      evidence,
      nowMs: NOW,
      maxClaimAgeMs: MAX_AGE,
      policy: POLICY,
    });
    assert.deepEqual(plan.resume, ['obx_stale']);
    assert.deepEqual(plan.retry, ['obx_retry', 'obx_unf']);
    assert.deepEqual(plan.reconcile, ['obx_und']);
    assert.deepEqual(plan.awaiting, ['obx_unk']);
    assert.deepEqual(plan.skipped, ['obx_skip']);
    assert.deepEqual(plan.terminal, ['obx_term', 'obx_unclass']);
    assert.deepEqual(plan.dead, ['obx_dead']);
    // Fresh claims, unrecorded claims, plain pending and settled rows: no action.
    const all = [...plan.resume, ...plan.retry, ...plan.reconcile, ...plan.awaiting, ...plan.skipped, ...plan.terminal, ...plan.dead];
    for (const idle of ['obx_fresh', 'obx_held', 'obx_plain', 'obx_done', 'obx_gone']) {
      assert.ok(!all.includes(idle as OutboxId), `${idle} must need no action`);
    }
    assert.equal(new Set(all).size, all.length);
  });

  it('applies the exact stale boundary and validates inputs', () => {
    assert.equal(isClaimStale(stale, NOW, MAX_AGE), true);
    assert.equal(isClaimStale(fresh, NOW, MAX_AGE), false);
    assert.throws(
      () =>
        planRecoveryScan({
          rows: [],
          claims: [],
          evidence: () => null,
          nowMs: -1,
          maxClaimAgeMs: MAX_AGE,
        }),
      /nowMs/,
    );
    assert.throws(
      () =>
        planRecoveryScan({
          rows: [],
          claims: [],
          evidence: () => null,
          nowMs: NOW,
          maxClaimAgeMs: MAX_AGE,
          policy: { maxAttempts: 0, horizonMs: 1000 },
        }),
      /maxAttempts/,
    );
  });
});

describe('t24a work.dispatch.stage command', () => {
  function stageArgs(intents: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
    return { operationId: 'run_stage_1', intents: [...intents] };
  }

  function stageIntent(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      intentId: 'obx_stage_1',
      operation: 'Acme.send',
      originOperationId: 'op_trigger',
      source: 'std.EmailV1.send',
      occurrenceIndex: 0,
      request: { to: 'a@example.com' },
      originOccurrence: null,
      guard: null,
      guardVerdict: null,
      ...over,
    };
  }

  it('stages dispatch rows plus outbox intents in one staging with pinned verdicts', async () => {
    const ctx = fakeCtx(seed([]));
    const staged = await runStage(
      workDispatchStageCommand.stage,
      stageArgs([
        stageIntent({ intentId: 'obx_a' }),
        stageIntent({
          intentId: 'obx_b',
          occurrenceIndex: 1,
          guard: 'eligible()',
          guardVerdict: true,
          fanout: { cohortId: 'c1', parentOccurrence: 'occ_p', childIndex: 0, checkpointId: null },
        }),
        stageIntent({
          intentId: 'obx_c',
          occurrenceIndex: 2,
          guard: 'eligible()',
          guardVerdict: false,
        }),
      ]),
      ctx,
    );
    assert.equal(staged.writes?.length, 3);
    // Guard-false stages row-only: nothing dispatchable, skip recorded.
    assert.equal(staged.outbox?.length, 2);
    assert.deepEqual(
      staged.outbox?.map((intent) => intent.intentId),
      ['obx_a', 'obx_b'],
    );
    for (const intent of staged.outbox ?? []) {
      assert.equal(intent.operationId, 'run_stage_1');
      assert.equal(intent.operation, 'Acme.send');
      assert.equal(intent.target, 'std.EmailV1.send');
    }
    assert.deepEqual(staged.outbox?.[0]?.dispatchGuard, undefined);
    assert.equal(staged.outbox?.[1]?.dispatchGuard, 'eligible()');
    const rows = (staged.writes ?? []).map((write) => {
      assert.equal(write.kind, 'insert');
      assert.equal(write.model, WORK_DISPATCH_MODEL);
      return write.kind === 'insert' ? readDispatchRow(write.row) : null!;
    });
    assert.deepEqual(rows.map((row) => [row.intentId, row.guardVerdict, row.state]), [
      ['obx_a', null, 'pending'],
      ['obx_b', true, 'pending'],
      ['obx_c', false, 'pending'],
    ]);
    assert.equal(rows[0]?.operationId, 'op_trigger');
    const result = staged.result as {
      staged: unknown[];
      skipped: unknown[];
      replayed: unknown[];
    };
    assert.equal(result.staged.length, 2);
    assert.equal(result.replayed.length, 0);
    assert.deepEqual(result.skipped, [
      {
        intentId: 'obx_c',
        guard: 'eligible()',
        verdict: false,
        reason: 'guard-false',
        fanout: null,
      },
    ]);
    assert.deepEqual(
      (result.staged[1] as { fanout: unknown }).fanout,
      { cohortId: 'c1', parentOccurrence: 'occ_p', childIndex: 0, checkpointId: null },
    );
  });

  it('fails closed on empty, duplicate and incoherent batches', async () => {
    const ctx = fakeCtx(seed([]));
    await assert.rejects(
      runStage(workDispatchStageCommand.stage, stageArgs([]), ctx),
      /non-empty array/,
    );
    await assert.rejects(
      runStage(
        workDispatchStageCommand.stage,
        stageArgs([stageIntent({ intentId: 'obx_dup' }), stageIntent({ intentId: 'obx_dup' })]),
        ctx,
      ),
      /duplicate intent id/,
    );
    await assert.rejects(
      runStage(
        workDispatchStageCommand.stage,
        stageArgs([stageIntent({ guard: 'eligible()', guardVerdict: null })]),
        ctx,
      ),
      /must be a boolean/,
    );
    await assert.rejects(
      runStage(
        workDispatchStageCommand.stage,
        stageArgs([stageIntent({ guard: null, guardVerdict: true })]),
        ctx,
      ),
      /incoherent/,
    );
    await assert.rejects(
      runStage(
        workDispatchStageCommand.stage,
        stageArgs([stageIntent({ fanout: { cohortId: '', parentOccurrence: 'p', childIndex: 0 } })]),
        ctx,
      ),
      /cohortId/,
    );
    await assert.rejects(
      runStage(
        workDispatchStageCommand.stage,
        stageArgs([stageIntent({ intentId: `obx_${'x'.repeat(128)}` })]),
        ctx,
      ),
      /exceeds 128/,
    );
  });

  it('replays matching rows without writes and refuses mismatched origins', async () => {
    const existing = dispatchRow('obx_re', { guardVerdict: true });
    const ctx = fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row: existing }]));
    const replayed = await runStage(
      workDispatchStageCommand.stage,
      stageArgs([
        stageIntent({
          intentId: 'obx_re',
          originOperationId: 'op_trigger',
          source: 'std.EmailV1.send',
          occurrenceIndex: 0,
          originOccurrence: null,
          guard: 'eligible()',
          guardVerdict: true,
        }),
      ]),
      ctx,
    );
    assert.deepEqual(replayed.writes, []);
    assert.deepEqual(replayed.outbox, []);
    assert.deepEqual(
      (replayed.result as { replayed: unknown }).replayed,
      ['obx_re'],
    );
    await assert.rejects(
      runStage(
        workDispatchStageCommand.stage,
        stageArgs([
          stageIntent({
            intentId: 'obx_re',
            originOperationId: 'op_other',
            guard: 'eligible()',
            guardVerdict: true,
          }),
        ]),
        ctx,
      ),
      /different origin or verdict/,
    );
  });
});

describe('t24a work.dispatch.recover command', () => {
  function recoverArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { maxClaimAgeMs: MAX_AGE, limit: 10, ...over };
  }

  it('releases stale claims in id order, observes uncertain, touches nothing else', async () => {
    const ctx = fakeCtx(
      seed([
        {
          model: WORK_DISPATCH_MODEL,
          row: dispatchRow('obx_b', { state: 'claimed', claimId: 'c_b', claimedAtMs: NOW - MAX_AGE }),
        },
        {
          model: WORK_DISPATCH_MODEL,
          row: dispatchRow('obx_a', { state: 'claimed', claimId: 'c_a', claimedAtMs: NOW - MAX_AGE - 1 }),
        },
        {
          model: WORK_DISPATCH_MODEL,
          row: dispatchRow('obx_fresh', { state: 'claimed', claimId: 'c_f', claimedAtMs: NOW }),
        },
        {
          model: WORK_DISPATCH_MODEL,
          row: dispatchRow('obx_naked', { state: 'claimed', claimId: null, claimedAtMs: null }),
        },
        { model: WORK_DISPATCH_MODEL, row: dispatchRow('obx_pending') },
        {
          model: WORK_DISPATCH_MODEL,
          row: dispatchRow('obx_unc', { state: 'uncertain', claimId: null, claimedAtMs: null }),
        },
      ]),
    );
    const recovered = await runStage(workDispatchRecoverCommand.stage, recoverArgs(), ctx);
    assert.equal(recovered.writes?.length, 2);
    for (const write of recovered.writes ?? []) {
      assert.equal(write.kind, 'update');
      if (write.kind === 'update') {
        const data = readDispatchRow(write.row);
        assert.equal(data.state, 'pending');
        assert.equal(data.claimId, null);
        assert.equal(data.claimedAtMs, null);
        assert.equal(write.expectedVersion, 1);
      }
    }
    assert.deepEqual(recovered.result, {
      released: ['obx_a', 'obx_b'],
      resumeAfter: null,
      done: true,
      uncertain: ['obx_unc'],
      uncertainTruncated: false,
    });
  });

  it('pages bounded batches with an exact resume cursor and never truncates silently', async () => {
    const ctx = fakeCtx(
      seed([
        {
          model: WORK_DISPATCH_MODEL,
          row: dispatchRow('obx_1', { state: 'claimed', claimId: 'c1', claimedAtMs: 0 }),
        },
        {
          model: WORK_DISPATCH_MODEL,
          row: dispatchRow('obx_2', { state: 'claimed', claimId: 'c2', claimedAtMs: 0 }),
        },
        {
          model: WORK_DISPATCH_MODEL,
          row: dispatchRow('obx_3', { state: 'claimed', claimId: 'c3', claimedAtMs: 0 }),
        },
      ]),
    );
    const first = await runStage(
      workDispatchRecoverCommand.stage,
      recoverArgs({ limit: 2 }),
      ctx,
    );
    assert.deepEqual(first.result, {
      released: ['obx_1', 'obx_2'],
      resumeAfter: 'obx_2',
      done: false,
      uncertain: [],
      uncertainTruncated: false,
    });
    const second = await runStage(
      workDispatchRecoverCommand.stage,
      recoverArgs({ limit: 2, resumeAfter: 'obx_2' }),
      ctx,
    );
    assert.deepEqual(
      (second.result as { released: unknown; done: boolean }).released,
      ['obx_3'],
    );
    assert.equal((second.result as { done: boolean }).done, true);
    await assert.rejects(
      runStage(workDispatchRecoverCommand.stage, recoverArgs({ limit: 0 }), ctx),
      /limit must be an integer >= 1/,
    );
  });
});

describe('t24a registry join on the memory store (MEMORY-ONLY)', () => {
  function composedRegistry() {
    const commands = [...WORK_SYSTEM_COMMANDS, ...WORK_DISPATCH_STAGE_COMMANDS];
    const names = commands.map((command) => command.name);
    assert.equal(names.length, 11);
    assert.equal(new Set(names).size, 11);
    for (const name of names) {
      assert.match(name, /^work\.[a-z-]+\.[a-z-]+$/);
    }
    return createSystemRegistry(commands);
  }

  function intentArg(intentId: string, occurrenceIndex: number): Record<string, unknown> {
    return {
      intentId,
      operation: 'Acme.send',
      originOperationId: 'op_trigger',
      source: 'std.EmailV1.send',
      occurrenceIndex,
      request: { to: 'a@example.com' },
      originOccurrence: null,
      guard: null,
      guardVerdict: null,
    };
  }

  it('commits dispatch rows plus outbox intents in one fence revision', async () => {
    const { store } = createTestMemoryStorage();
    const registry = composedRegistry();
    const run = await registry.run(
      'work.dispatch.stage',
      { operationId: 'run_join_1', intents: [intentArg('obx_j1', 0), intentArg('obx_j2', 1)] },
      { actor: ACTOR, now: NOW, operation: 'test.join', operationId: 'run_join_1' },
      { store },
    );
    assert.equal(run.revision, 1);
    assert.equal(await store.readRevision(), 1);
    assert.deepEqual(
      (await store.outboxPending()).map((intent) => intent.intentId).sort(),
      ['obx_j1', 'obx_j2'],
    );
    for (const id of ['obx_j1', 'obx_j2']) {
      const row = await store.load(WORK_DISPATCH_MODEL, id as RecordId);
      assert.ok(row !== null);
      assert.equal(readDispatchRow(row!).state, 'pending');
    }
  });

  it('voids the whole join when the run key mismatches (trigger rollback)', async () => {
    const { store } = createTestMemoryStorage();
    const registry = composedRegistry();
    // args.operationId differs from the run operationId: the registry's
    // staging check rejects, and NOTHING commits — no rows, no intents.
    await assert.rejects(
      registry.run(
        'work.dispatch.stage',
        { operationId: 'run_wrong', intents: [intentArg('obx_void', 0)] },
        { actor: ACTOR, now: NOW, operation: 'test.join', operationId: 'run_join_2' },
        { store },
      ),
      /belong to the invoking operation/,
    );
    assert.equal(await store.readRevision(), 0);
    assert.equal(await store.load(WORK_DISPATCH_MODEL, 'obx_void' as RecordId), null);
    assert.deepEqual(await store.outboxPending(), []);
  });

  it('grants exactly one winner under concurrent delivery (MEMORY-ONLY)', async () => {
    const { store } = createTestMemoryStorage();
    const registry = composedRegistry();
    await registry.run(
      'work.dispatch.stage',
      { operationId: 'run_race_0', intents: [intentArg('obx_race', 0)] },
      { actor: ACTOR, now: NOW, operation: 'test.join', operationId: 'run_race_0' },
      { store },
    );
    const raced = await Promise.allSettled([
      registry.run(
        'work.dispatch.claim',
        { intentId: 'obx_race', claimId: 'claim_A', claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE },
        { actor: ACTOR, now: NOW, operation: 'test.race', operationId: 'run_race_A' },
        { store },
      ),
      registry.run(
        'work.dispatch.claim',
        { intentId: 'obx_race', claimId: 'claim_B', claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE },
        { actor: ACTOR, now: NOW, operation: 'test.race', operationId: 'run_race_B' },
        { store },
      ),
    ]);
    const winners = raced.filter((outcome) => outcome.status === 'fulfilled');
    const losers = raced.filter((outcome) => outcome.status === 'rejected');
    // Exactly one winner; the loser loses the fence (busy), never half-claims.
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    const winner = winners[0]! as PromiseFulfilledResult<{ result: unknown }>;
    assert.equal((winner.value.result as { claimed: boolean }).claimed, true);
    const winnerClaimId = (winner.value.result as { claimId: string }).claimId;
    assert.ok(winnerClaimId === 'claim_A' || winnerClaimId === 'claim_B');
    const loser = losers[0]! as PromiseRejectedResult;
    assert.match(String((loser.reason as Error)?.message ?? loser.reason), /contention|busy/i);
    const row = await store.load(WORK_DISPATCH_MODEL, 'obx_race' as RecordId);
    assert.ok(row !== null);
    const data = readDispatchRow(row!);
    assert.equal(data.state, 'claimed');
    assert.equal(data.claimId, winnerClaimId);
  });

  it('resumes an interrupted claim through recover plus reclaim (MEMORY-ONLY)', async () => {
    const { store } = createTestMemoryStorage();
    const registry = composedRegistry();
    await registry.run(
      'work.dispatch.stage',
      { operationId: 'run_rec_0', intents: [intentArg('obx_rec', 0)] },
      { actor: ACTOR, now: NOW, operation: 'test.join', operationId: 'run_rec_0' },
      { store },
    );
    await registry.run(
      'work.dispatch.claim',
      { intentId: 'obx_rec', claimId: 'claim_old', claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE },
      { actor: ACTOR, now: NOW, operation: 'test.claim', operationId: 'run_rec_1' },
      { store },
    );
    // The worker dies holding claim_old; recovery past the stale boundary
    // releases the row, and a fresh claim takes over the same intent.
    const recovered = await registry.run(
      'work.dispatch.recover',
      { maxClaimAgeMs: MAX_AGE, limit: 10 },
      { actor: ACTOR, now: NOW + MAX_AGE + 1, operation: 'test.recover', operationId: 'run_rec_2' },
      { store },
    );
    assert.deepEqual(
      (recovered.result as { released: unknown }).released,
      ['obx_rec'],
    );
    const reclaimed = await registry.run(
      'work.dispatch.claim',
      {
        intentId: 'obx_rec',
        claimId: 'claim_new',
        claimedAtMs: NOW + MAX_AGE + 1,
        maxClaimAgeMs: MAX_AGE,
      },
      { actor: ACTOR, now: NOW + MAX_AGE + 1, operation: 'test.claim', operationId: 'run_rec_3' },
      { store },
    );
    assert.equal((reclaimed.result as { claimed: boolean }).claimed, true);
    const row = await store.load(WORK_DISPATCH_MODEL, 'obx_rec' as RecordId);
    assert.equal(readDispatchRow(row!).claimId, 'claim_new');
  });

  it('pins the L3 join literal against the L4 dispatch table', () => {
    // The transact join matches rows structurally (L3 must not import L4);
    // this pin fails loudly if either side renames the table.
    assert.equal(DISPATCH_JOIN_MODEL, WORK_DISPATCH_MODEL);
    assert.equal(DISPATCH_JOIN_MODEL, 'work.dispatch');
  });
});
